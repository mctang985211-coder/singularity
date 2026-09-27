import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { ROOT_PROPOSAL_TASK_ID, TASK_CONTRACT_VERSION, admissionContextDigest, answerIdOf, batchIdFor, blockingQuestionsOf, canonicalize, capabilityManifestDigest, contractDigest, decompositionDigest, openQuestionsOf, questionIdOf, questionOf, questionsAwaitingAnswerOf, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, runMemberTaskIds, sha256Hex, taskProposalId } from "@dangosys/dsh-singularity-task";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { answerMessageText, findSkillFileIn, parseSkillFile, questionMessageText, skillRootsFor, toolCallRefIn } from "@dangosys/dsh-singularity-agent-runtime";
import { homedir } from "node:os";

//#region src/mcp-servers.ts
/**
* The servers a capability may name. `bbdev` is the buckyball checkout's own
* FastMCP server (45 tools, submit/poll-shaped to stay under the per-call
* timeout). It binds `{repoRoot:buckyball}`: the worker's env must contain a
* buckyball checkout, and a capability that names it on an env without one
* fails the spawn loudly.
*/
const MCP_SERVER_REGISTRY = { bbdev: {
	serverName: "bbdev",
	description: "buckyball bbdev MCP server (build/simulate/validate; submit + task_status poll) from the env checkout",
	command: "{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh",
	args: [],
	cwd: "{repoRoot:buckyball}"
} };
/** Every MCP server name one resolved manifest grants, first-declaration order, duplicates dropped. */
function manifestMcpServers(manifest) {
	const names = [];
	for (const entry of Object.values(manifest.capabilities)) for (const name of entry.mcpServers ?? []) if (!names.includes(name)) names.push(name);
	return names;
}
const PLACEHOLDER = /\{(envRoot|repoRoot:[^{}]+)\}/g;
const ANY_PLACEHOLDER_LIKE = /\{[^{}]*\}/;
/**
* Substitute the placeholders of one template field. `{envRoot}` is the env
* root; `{repoRoot:<repo>}` is that env's checkout of `<repo>`. An env-free
* field passes through untouched; an env-needing field with no binding, a repo
* the env does not contain, or a placeholder outside the vocabulary all throw
* — a miswired server must never mount partially.
*/
function substitute(template, binding, serverName) {
	if (!ANY_PLACEHOLDER_LIKE.test(template)) return template;
	const leftover = template.replace(PLACEHOLDER, "");
	if (ANY_PLACEHOLDER_LIKE.test(leftover)) throw new Error(`task-runtime: MCP server "${serverName}" template "${template}" carries a placeholder outside {envRoot}/{repoRoot:<repo>}`);
	if (binding === void 0) throw new Error(`task-runtime: MCP server "${serverName}" needs an env binding ({envRoot}/{repoRoot} template) but this run's session has none`);
	return template.replace(PLACEHOLDER, (whole, key) => {
		if (key === "envRoot") return binding.envRoot;
		const repo = key.slice(9);
		const checkout = binding.checkout(repo);
		if (checkout === void 0) throw new Error(`task-runtime: MCP server "${serverName}" binds {repoRoot:${repo}} but this run's env (${binding.envRoot}) has no "${repo}" checkout`);
		return checkout;
	});
}
/**
* Materialize one manifest's MCP grants into mount-ready specs.
* @param manifest - the resolved capability manifest (server names already validated at admission).
* @param binding - the run's env binding, or undefined when the session has none.
* @param registry - the template table; a parameter so tests can exercise bad
*   templates (unknown placeholders) that the shipped registry must never hold.
* @returns one spec per distinct granted server, in first-declaration order.
* @throws when a granted name is outside the registry, when an
*   env-needing server has no binding, or when its repo is absent from the env.
*/
function resolveMcpServerSpecs(manifest, binding, registry = MCP_SERVER_REGISTRY) {
	const names = manifestMcpServers(manifest);
	const specs = [];
	for (const name of names) {
		const template = registry[name];
		if (template === void 0) throw new Error(`task-runtime: capability manifest grants unknown MCP server "${name}"; known servers: ${Object.keys(registry).sort().join(", ")}`);
		specs.push({
			serverName: template.serverName,
			command: substitute(template.command, binding, name),
			args: (template.args ?? []).map((arg) => substitute(arg, binding, name)),
			env: Object.fromEntries(Object.entries(template.env ?? {}).map(([key, value]) => [key, substitute(value, binding, name)])),
			cwd: template.cwd === void 0 ? binding?.envRoot ?? "" : substitute(template.cwd, binding, name),
			...template.toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs: template.toolCallTimeoutMs }
		});
	}
	return specs;
}

//#endregion
//#region src/capability.ts
/**
* Reject MCP server names outside the registry, the same discipline
* {@link resolveToolLabels} applies to labels: named vocabulary in the error,
* whole resolution rejected before anything is persisted or spawned.
*/
function assertKnownMcpServers(capability, names) {
	for (const name of names) if (MCP_SERVER_REGISTRY[name] === void 0) throw new Error(`task-runtime: capability "${capability}" declares unknown MCP server "${name}"; known servers: ${Object.keys(MCP_SERVER_REGISTRY).sort().join(", ")}`);
}
/**
* Capability tool labels → the real DSH tool names each label grants.
*
* A capability table is authored against what the WORK needs, not against
* whichever names a given harness release registers: `filesystem` stays
* `filesystem` while DSH's file tools are `read`/`write`/`edit`. This table is
* the whole vocabulary — a label outside it is rejected at admission — and its
* values are the names that reach the worker's tool filter. Each value is the
* `name` the registering tool plugin declares:
*
* | label             | registers in                                                        |
* | ----------------- | ------------------------------------------------------------------- |
* | filesystem        | `fs/tool-fs` (`read.ts:78`, `write.ts:73`, `edit.ts:85`)             |
* | search            | `fs/tool-fs-search` (`glob.ts:313`, `grep.ts:285`)                  |
* | bash              | `shell/tool-bash` (`index.ts:242`)                                  |
* | jobs              | `jobs/tool-jobs` (`index.ts:302,342,362`)                           |
* | skill             | `skill/tool-skill` (`index.ts:82`)                                  |
* | ask-user          | `interaction/tool-ask-user` (`index.ts:21`)                         |
* | web               | `web/tool-web` (`fetch.ts:459`, `search.ts:326`)                    |
* | todo              | `todo/tool-todo` (`index.ts:147`)                                   |
* | goal              | `goal/tool-goal` (`index.ts:195,207,234`)                           |
* | subagent          | `subagent/tool-subagent` (`index.ts:380`), `.../tool-subagent-control` (`index.ts:29,77`, `list-agents.ts:93`) |
*
* Paths are relative to `thirdparty/deepseek-harness/packages/`. The raw
* cross-session readers (`session_event_read` and its siblings) are deliberately
* NOT a label: A2 sealed them off every Singularity role's surface — history is
* read through `context_read`, whose caller-side authorization is the graph
* domain, not a cwd.
*
* A label only carries names a composition can be expected to mount; a
* capability-declared name the worker's own composition does not offer fails
* that spawn loudly (`agent-runtime/src/grants.ts`), which is the point — the
* capability asked for a tool the composition cannot give. `read_image` is
* deliberately NOT in `filesystem`: `tool-fs` registers it only while
* `attachments` is mounted (`fs/tool-fs/src/index.ts:70-73`), so granting it
* would make every filesystem capability depend on a plane it never names.
* `bash` is likewise absent on a Windows deployment, where the standard preset
* disables `tool-bash`.
*/
const TOOL_LABELS = {
	filesystem: [
		"read",
		"write",
		"edit"
	],
	search: ["glob", "grep"],
	bash: ["bash"],
	jobs: [
		"job_output",
		"job_list",
		"job_kill"
	],
	skill: ["skill"],
	"ask-user": ["ask_user_question"],
	web: ["web_fetch", "web_search"],
	todo: ["todo_write"],
	goal: [
		"get_goal",
		"create_goal",
		"update_goal"
	],
	subagent: [
		"subagent",
		"subagent_fork",
		"send_message",
		"interrupt_agent",
		"list_agents"
	]
};
/**
* Expand one capability's tool labels into real DSH tool names.
* @param capability - capability name, named in the rejection.
* @param labels - the labels the capability declares.
* @returns every real tool name the labels grant, in declaration order.
* @throws when a label is not in {@link TOOL_LABELS}; the error lists the vocabulary.
*/
function resolveToolLabels(capability, labels) {
	return labels.flatMap((label) => {
		const expanded = TOOL_LABELS[label];
		if (expanded === void 0) throw new Error(`task-runtime: capability "${capability}" declares unknown tool label "${label}"; known labels: ${Object.keys(TOOL_LABELS).sort().join(", ")}`);
		return [...expanded];
	});
}
/**
* The capability-worker baseline: what every worker needs whatever its
* capabilities are, because its own prompt tells it to use these. Every entry
* cites the prompt line that needs it (the worker policy section,
* `agent-runtime/src/prompts/worker.prompts.ts`, plus the shell tool's own
* guidance for `jobs`):
*
* - `filesystem` — "Do the work" / "Keep changes scoped to this task".
* - `bash` — "Where a criterion lists a command, make that command exit 0 in the checkout".
* - `jobs` — that same command is often long-running, and `bash`'s own description
*   tells the model to collect background output with `job_output`/`job_kill`.
* - `search` — locate the code the work touches.
* - `skill` — without the loader the granted skills are unreachable, and
*   `tool-skill` only injects the catalog when its tool is visible.
* - `ask-user` — "Need a human decision? Ask with `ask_user_question`".
*
* A composition that offers none of them (the `bb-verify` node mounts no shell)
* simply keeps what it has: see `agent-runtime/src/grants.ts`.
*/
const WORKER_BASELINE_LABELS = [
	"filesystem",
	"bash",
	"jobs",
	"search",
	"skill",
	"ask-user"
];
/**
* Baseline tool names that are not a capability label: the task machinery the
* worker prompt calls. They are exactly the Layer-0 universal control tools the
* frozen material fixes for every agent (`细化想法4.md:724-738`: `task_read`,
* `task_decompose`, `task_status`, and the verifier tool this deployment names
* `task_verify`) — L0 is the "every node, whatever it works on" layer, so a
* worker keeps it whatever its capabilities declare — plus the two A3
* coordination tools (`task_submit_result`, `task_cancel`) and
* `capability_list`, which have no label that could expand to them either.
*
* They are listed here individually, unlike the labels above, because these tools
* are registered on the GLOBAL layer rather than a capability or preset plane
* (`agent-singularity/src/index.ts`): the grant filter only keeps an inherited
* tool the allow-list names (`agent-runtime/src/grants.ts:99`), and there is no
* label that could expand to them.
*
* Every entry cites the prompt or tool contract that needs it:
* - `capability_list`: `task_decompose` asks callers to discover valid capability
*   names before proposing children, including recursively spawned workers.
* - `task_decompose` — a worker admitted as decomposable is told to call it with
*   a `reason` and the child task list, and for a `leaf` worker whose deployment
*   runs with `Config.allowRuntimeDecomposition` on, the runtime-split rule the
*   context projection carries opens the same tool to it.
* - `task_submit_result` — "When the work is done, hand it in with `task_submit_result`"
*   (the worker policy section): the submission is the only completion a worker
*   can claim, so a worker without the tool could never finish a run.
* - `task_read` — the caller's own contract and run (A2 §D).
* - `task_status` — the same policy line: the project state with `task_status`.
* - `context_read` — the one reference reader (A2 §D): the worker's handoff and
*   its task records point at artifacts, evidence, reviews, diagnoses and
*   sessions by id, and this is the only door that reads them inside the
*   caller's own graph domain — the raw cross-session readers it replaced are
*   sealed off every runtime-owned agent (`agent-runtime`'s execution guard).
* - `task_verify` — "`task_verify` is only a self-check" (the worker policy section).
* - `task_cancel` — no prompt line asks for it: a run that decomposed holds a
*   batch of its own, and the protocol's only way to end that batch early is
*   this call (A3 §3.6). It is also the one write the execution gate keeps for
*   a run in `waiting_children` or `submitted` (`gate.ts:COORDINATION_ALLOWED`),
*   so the tool has to be on the surface of every run that can hold a batch.
* - `task_proposal_read`, `task_proposal_continue`, `task_proposal_cancel`
*   (T2/T3) — a decomposition proposal is not always admitted on the spot: a
*   reviewed deployment answers `task_decompose` with a proposal id and nothing
*   admitted, and the tool's own answer points the caller at
*   `task_proposal_read` for the batch as it was recorded. The other two are
*   the coordination actions on that record — continuing it after a decision
*   (which can admit the batch, so the gate classifies it with
*   `task_decompose`) and withdrawing it before admission (classified with
*   `task_cancel`). They are task-domain actions of a node that proposed work,
*   not platform management: the human decision itself never happens in a
*   worker's tool plane — the review channel is wired at the service assembly
*   and a worker has no tool that could decide a proposal.
* - `task_ask_parent`, `task_answer` (A4 §F.1) — the two halves of the direct
*   parent/child question protocol, and the only effects a run keeps while it is
*   blocked on an unanswered question (`gate.ts:COORDINATION_ALLOWED`). **A4
*   sub-goal ③a note**: the names are listed here so a worker's own surface can
*   reach the runtime entries the write gate and the blocking tests drive; the
*   shipped tool definitions, their schemas and the root's own policy line are
*   ③c's, and nothing here decides what a call is allowed to say — the gate and
*   the Task store do.
*
* `graph_spawn` is deliberately NOT here, even though the deployment registers
* it for the root: it reaches the graph without Task Admission and returns the
* child's last assistant text as its result, which breaks frozen invariants #2
* ("Task 可以自由生成，但必须通过 Task Admission") and #6 ("Parent 必须消费
* evidence，而不是直接相信 child natural-language result")
* (`细化想法4.md:2075`, `:2079`); such a node has no task record, so no evidence,
* no review, and nothing `task_status` or the parent's composite criterion can
* see. Nodes grow by their worker calling `task_decompose`, which admits the
* batch and has the orchestrator spawn each child. Every worker holds that tool
* whatever its `decompositionStatus`; whether a `leaf` task's own call is
* admitted is the runtime's decision, not the tool plane's
* (`Config.allowRuntimeDecomposition`, `index.ts:DEFAULT_ALLOW_RUNTIME_DECOMPOSITION`).
*/
const WORKER_BASELINE_TOOLS = [
	"task_read",
	"task_status",
	"context_read",
	"task_decompose",
	"task_submit_result",
	"task_cancel",
	"task_verify",
	"capability_list",
	"task_proposal_read",
	"task_proposal_continue",
	"task_proposal_cancel",
	"task_ask_parent",
	"task_answer"
];
/**
* Every real tool name a capability worker keeps on top of what its
* capabilities declare.
* @returns the expanded baseline, de-duplicated.
*/
function workerBaseline() {
	return [...new Set([...resolveToolLabels("worker baseline", WORKER_BASELINE_LABELS), ...WORKER_BASELINE_TOOLS])];
}
/**
* Resolve required capability names against the configured registry.
* A required name that has an entry contributes its skills/tools/preset to the
* manifest; a name without an entry lands in `missing`. Closure is `closed`
* when nothing is missing, otherwise `gap`.
*
* Tool labels are expanded here, so the manifest carries the real DSH tool names
* a worker is granted — and an unknown label rejects the whole resolution with
* the vocabulary named, before anything is persisted or spawned. MCP server
* names are validated against `MCP_SERVER_REGISTRY` the same way and copied
* onto the manifest entry; the spawn seam binds them to the run's env.
* @param required - capability names the caller requires.
* @param registry - the configured capability table.
* @returns the resolved manifest.
* @throws when a matched capability declares a tool label outside {@link TOOL_LABELS}
*   or an MCP server outside `MCP_SERVER_REGISTRY`.
*/
function resolveCapabilities(required, registry) {
	const capabilities = {};
	const missing = [];
	for (const name of required) {
		const entry = registry[name];
		if (entry === void 0) {
			missing.push(name);
			continue;
		}
		assertKnownMcpServers(name, entry.mcpServers ?? []);
		capabilities[name] = {
			skills: [...entry.skills ?? []],
			tools: resolveToolLabels(name, entry.tools ?? []),
			...entry.preset !== void 0 ? { preset: entry.preset } : {},
			...entry.permission !== void 0 ? { permission: entry.permission } : {},
			...entry.mcpServers !== void 0 && entry.mcpServers.length > 0 ? { mcpServers: [...entry.mcpServers] } : {}
		};
	}
	const manifest = {
		capabilities,
		missing,
		closure: missing.length > 0 ? "gap" : "closed"
	};
	resolvePreset(manifest);
	return manifest;
}
/**
* Flatten a manifest's granted skills and tools into a run's capability
* snapshot; each granted MCP server rides along as an `mcp:<serverName>`
* marker, so the recorded grant shows the server plane too (the server's tools
* themselves appear on the worker as `mcp__<serverName>__<tool>`).
*/
function capabilitySnapshot(manifest) {
	const granted = /* @__PURE__ */ new Set();
	for (const entry of Object.values(manifest.capabilities)) {
		for (const skill of entry.skills) granted.add(skill);
		for (const tool of entry.tools) granted.add(tool);
		for (const server of entry.mcpServers ?? []) granted.add(`mcp:${server}`);
	}
	return [...granted].sort();
}
/** One worker mounts one preset. Conflicting declarations are a configuration error. */
function resolvePreset(manifest, defaultPreset) {
	const declared = Object.entries(manifest.capabilities).filter(([, entry]) => entry.preset !== void 0);
	if (new Set(declared.map(([, entry]) => entry.preset)).size > 1) {
		const detail = declared.map(([name, entry]) => `${name} -> ${entry.preset}`).sort().join(", ");
		throw new Error(`task-runtime: conflicting capability presets: ${detail}; one worker requires one preset`);
	}
	return declared[0]?.[1].preset ?? defaultPreset;
}
/**
* Strictness order for conflicting capability permissions (strictest wins):
* sandbox decides first (`read-only` > `workspace-write` > `danger-full-access`),
* approval breaks ties (`ask` > `never`), declaration order breaks what remains.
*/
const SANDBOX_STRICTNESS = {
	"read-only": 2,
	"workspace-write": 1,
	"danger-full-access": 0
};
const APPROVAL_STRICTNESS = {
	ask: 1,
	never: 0
};
/**
* The permission preset a spawned worker runs under: the strictest preset any
* matched capability declares, or `undefined` when none declares one (the
* caller then keeps the default posture). `resolveSpec` (the permissionPresets
* registry's `resolve`) doubles as existence validation — an unknown preset
* name fails loudly here, before the spawn.
*/
function resolvePermission(manifest, resolveSpec) {
	const declared = [...new Set(Object.values(manifest.capabilities).flatMap((entry) => entry.permission === void 0 ? [] : [entry.permission]))];
	if (declared.length === 0) return void 0;
	const rank = (name) => {
		const spec = resolveSpec(name);
		const sandbox = SANDBOX_STRICTNESS[spec.sandbox];
		const approval = APPROVAL_STRICTNESS[spec.approval];
		if (sandbox === void 0 || approval === void 0) throw new Error(`permission preset "${name}" has an unrankable knob bundle (sandbox: ${spec.sandbox}, approval: ${spec.approval})`);
		return [sandbox, approval];
	};
	return declared.map((name) => ({
		name,
		rank: rank(name)
	})).reduce((strictest, item) => item.rank[0] > strictest.rank[0] || item.rank[0] === strictest.rank[0] && item.rank[1] > strictest.rank[1] ? item : strictest).name;
}

//#endregion
//#region src/protected-inputs.ts
function message$7(error) {
	return error instanceof Error ? error.message : String(error);
}
function isPlainObject$2(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** Non-blank text: the one check every string field shares. */
function nonBlank$2(value) {
	return typeof value === "string" && value.trim().length > 0;
}
/**
* The authoring form of one criterion's declaration: a non-empty array of
* non-blank strings, in the order the caller wrote them.
*
* Everything else is *not* this generator's business. An absent declaration
* says nothing was declared; the already-fixed form, a bare string, a mixed or
* otherwise malformed array are left exactly as declared so
* {@link protectedInputDefects} — through `admission.contractDefects` — refuses
* them with a reason of their own. Fixing a malformed declaration instead of
* refusing it would accept a shape nobody promised to read.
*/
function declaredPaths(value) {
	if (!Array.isArray(value) || value.length === 0) return [];
	return value.every((item) => nonBlank$2(item)) ? [...value] : [];
}
/**
* The label one criterion is reported under: the declared id when it has one,
* its position otherwise — the vocabulary `normalize.ts` names criteria with,
* so a caller reading a refusal sees one numbering, not two.
*/
function criterionLabel(childLabel$1, criterion, index) {
	return `${childLabel$1} criterion ${nonBlank$2(criterion.criterionId) ? JSON.stringify(criterion.criterionId) : index + 1}`;
}
/**
* Fix the byte identity of every declared protected input, against the
* checkout directory the criterion's judge will run in.
*
* `paths` are the paths **as declared** (the caller's spellings, verbatim):
* each is resolved against `cwd` for the read — an absolute path stays
* absolute — while the returned ref keeps the declared spelling, so the
* identity names what the caller wrote and not a tidied version of it. An
* identical declaration repeated is read once and produces one entry, in
* first-declaration order; two spellings of the same file stay two
* declarations.
*
* Refusals are values, never throws: a path that cannot be read (missing,
* unreadable, a directory) yields a reason naming the label and the path, and a
* session whose checkout directory cannot be resolved (`cwd === undefined`)
* yields one reason instead of fixing the declaration against the wrong base.
* That refusal is whole-batch and absolute paths are not exempt: the checkout
* names the directory the criterion's judge runs in, so a batch that cannot
* name it cannot promise that what it fixed is what the re-check will compare —
* and the refs of a batch refused for one path are never trustworthy either.
* Nothing is ever written: the files are read and left byte-identical.
*/
async function fixProtectedInputs(paths, cwd, label) {
	if (paths.length === 0) return {
		refs: [],
		reasons: []
	};
	if (cwd === void 0) return {
		refs: [],
		reasons: [`${label} protectedInputs cannot be fixed: the session's checkout directory cannot be resolved (the session has no readable graph env binding), so the declared paths are refused rather than fixed against the wrong base`]
	};
	const refs = [];
	const reasons = [];
	const seen = /* @__PURE__ */ new Set();
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		try {
			refs.push({
				path,
				sha256: sha256Hex(await readFile(resolve(cwd, path)))
			});
		} catch (error) {
			reasons.push(`${label} protectedInputs path ${JSON.stringify(path)} cannot be read: ${message$7(error)}`);
		}
	}
	return {
		refs,
		reasons
	};
}
/**
* Fix the declarations of one criterion list, rebuilding only the criteria that
* declared one: every untouched criterion is carried by reference, and the
* caller's input is never mutated — which is also why the returned list is
* typed read-only.
*
* `label` is the position prefix a criterion is reported under (`child 0` on a
* decomposition, `replay of "t-1"` on a replay); {@link criterionLabel} appends
* the criterion's own id or position. A criterion whose fixing was refused is
* carried unchanged — it never reaches the store, because the caller refuses
* the whole batch on any reason — so no half-fixed identity can be read as a
* fixed one.
*/
async function fixCriteriaProtectedInputs(criteria, cwd, label) {
	const reasons = [];
	if (!Array.isArray(criteria)) return {
		criteria,
		reasons
	};
	const fixed = [];
	for (const [index, criterion] of criteria.entries()) {
		const paths = declaredPaths(criterion.protectedInputs);
		if (paths.length === 0) {
			fixed.push(criterion);
			continue;
		}
		const outcome = await fixProtectedInputs(paths, cwd, criterionLabel(label, criterion, index));
		reasons.push(...outcome.reasons);
		fixed.push(outcome.reasons.length === 0 ? {
			...criterion,
			protectedInputs: outcome.refs
		} : criterion);
	}
	return {
		criteria: fixed,
		reasons
	};
}
/**
* Fix the declared protected inputs of a whole decomposition proposal before
* anything else reads it: the runtime calls this ahead of the single
* normalization entry, so the contract the store receives — and both content
* identities computed over it — describe the fixed byte identity rather than
* the caller's paths.
*
* Absent declarations and every malformed shape are carried exactly as
* declared, and a child nothing was fixed in is returned by reference: this
* function converts the authoring form, it does not validate, so the reasons it
* returns are only the ones fixing itself could produce.
*/
async function fixSpecProtectedInputs(spec, cwd) {
	const reasons = [];
	if (!Array.isArray(spec?.children)) return {
		spec,
		reasons
	};
	const children = [];
	for (const [index, child] of spec.children.entries()) {
		if (child === null || typeof child !== "object" || !Array.isArray(child.acceptanceCriteria)) {
			children.push(child);
			continue;
		}
		const outcome = await fixCriteriaProtectedInputs(child.acceptanceCriteria, cwd, `child ${index}`);
		reasons.push(...outcome.reasons);
		const touched = outcome.criteria.some((criterion, position) => criterion !== child.acceptanceCriteria[position]);
		children.push(touched ? {
			...child,
			acceptanceCriteria: outcome.criteria
		} : child);
	}
	return {
		spec: children.some((child, index) => child !== spec.children[index]) ? {
			...spec,
			children
		} : spec,
		reasons
	};
}
/**
* Structural defects of the **fixed** form of every criterion's protected
* inputs: each declaration must be an array of plain objects carrying exactly
* `path` (non-blank string) and `sha256` (lowercase 64-character hex). Shape
* only — whether the file still hashes to that digest is the pre-judgement
* re-check's question, and it needs the checkout, not this function.
*
* The ordinary decomposition path and the replay path share this function (via
* `admission.contractDefects`) so one rule can never hold on one and not on the
* other, and the declared string form is refused here as well: reaching
* admission with paths instead of digests means the runtime's fixing step was
* bypassed, which is exactly the state that must not be persisted. Every reason
* is prefixed with `<label> criterion "<id>"`, the label the other contract
* rules use.
*/
function protectedInputDefects(criteria, label) {
	const reasons = [];
	for (const criterion of criteria) {
		const where = `${label} criterion ${JSON.stringify(criterion.criterionId)}`;
		const declared = criterion.protectedInputs;
		if (declared === void 0) continue;
		if (!Array.isArray(declared)) {
			reasons.push(`${where} protectedInputs must be an array of { path, sha256 } entries (declared paths are fixed by admission, never stored as strings)`);
			continue;
		}
		declared.forEach((entry, index) => {
			const at = `${where} protectedInputs entry ${index}`;
			if (!isPlainObject$2(entry)) {
				reasons.push(`${at} must be an object with only path and sha256`);
				return;
			}
			for (const key of Object.keys(entry)) if (key !== "path" && key !== "sha256") reasons.push(`${at} declares unknown field ${JSON.stringify(key)}`);
			if (!nonBlank$2(entry.path)) reasons.push(`${at} path must be a non-empty string`);
			if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) reasons.push(`${at} sha256 must be a lowercase 64-character hex digest`);
		});
	}
	return reasons;
}

//#endregion
//#region src/admission.ts
/** Modes whose criterion is executed by the command verifier and therefore needs `command`. */
const EXECUTABLE_MODES = [
	"deterministic",
	"simulation",
	"measurement"
];
/** Every mode a criterion may declare, in declaration order (`VerificationMode`); the list the mode rule names. */
const VERIFICATION_MODES = [
	"deterministic",
	"simulation",
	"formal",
	"measurement",
	"review",
	"composite"
];
/**
* Structural reasons one task's parent-acceptance declarations are malformed
* (P4, KISS §6 C2). Shape only: whether a mapping target exists is judged at
* acceptance time, never here. The ordinary decomposition path and the replay
* path share this function so both judge the same declarations the same way.
*
* `label` names the task under validation (`task "t-1"`, `child 0 ("c1")`,
* `replay of "t-1"`); every reason is prefixed with it.
*/
function independentAcceptanceDefects(criteria, requiresIndependentAcceptance, label) {
	const reasons = [];
	for (const criterion of criteria) {
		const where = `${label} criterion "${criterion.criterionId}"`;
		if (criterion.acceptsArtifact !== void 0 && (!Array.isArray(criterion.acceptsArtifact) || criterion.acceptsArtifact.some((ref) => typeof ref !== "string" || ref.trim().length === 0))) reasons.push(`${where} acceptsArtifact must be an array of non-empty strings`);
		if (criterion.heuristic !== void 0 && typeof criterion.heuristic !== "boolean") reasons.push(`${where} heuristic must be a boolean`);
		const map = criterion.childEvidence;
		if (map !== void 0) if (!Array.isArray(map)) reasons.push(`${where} childEvidence must be an array of entries`);
		else {
			map.forEach((entry, index) => {
				const at = `${where} childEvidence entry ${index}`;
				if (typeof entry !== "object" || entry === null) {
					reasons.push(`${at} must be an object`);
					return;
				}
				if (!Number.isInteger(entry.childIndex) || entry.childIndex < 0) reasons.push(`${at} childIndex must be a non-negative integer`);
				if (entry.criterionId !== void 0 && (typeof entry.criterionId !== "string" || entry.criterionId.trim().length === 0)) reasons.push(`${at} criterionId must be a non-empty string`);
				if (entry.evidenceRef !== void 0 && (typeof entry.evidenceRef !== "string" || entry.evidenceRef.trim().length === 0)) reasons.push(`${at} evidenceRef must be a non-empty string`);
			});
			if (map.length > 0 && criterion.verificationMode !== "composite") reasons.push(`${where} childEvidence requires verificationMode "composite" (the composite verifier is its only judge)`);
			if (map.length > 0 && criterion.heuristic === true) reasons.push(`${where} cannot be both heuristic and carry a childEvidence map: a heuristic judgement is never a mechanical check`);
		}
	}
	if (requiresIndependentAcceptance === true && !criteria.some((criterion) => (criterion.childEvidence?.length ?? 0) > 0)) reasons.push(`${label} requires independent parent acceptance but no acceptance criterion carries a childEvidence map (the composite conjunction alone cannot stand in for the root goal)`);
	return reasons;
}
/**
* The one structural rule a **root contract** owes on top of
* {@link contractDefects} (A0 §1.2): at least one mandatory criterion whose
* judge is something other than the composite conjunction.
*
* Why it is a rule of its own and not folded into {@link contractDefects}: a
* decomposition child may legitimately be judged by "my children verified" —
* its parent owns the goal it was delegated — while a *root* has nobody above
* it, so a root whose only mandatory criterion is the composite conjunction is
* satisfied by its own decomposition and by nothing else. That is the shape the
* graph entry used to mint from its fixed spec, and it is exactly the shape
* this rule refuses to call a root goal. Applying it to every contract would
* break the delegated-children case; applying it to nothing would let a root
* re-enter through the old shape.
*
* Structural, and only structural: it says which *kind* of judge the contract
* names, never whether that judge is any good. A `command` that is a constant
* truth, a model's self-report, or a `heuristic` criterion are all outside what
* a shape rule can decide — §1.2 says so in as many words ("不能用恒真命令、
* 模型自述或 heuristic 冒充确定性根通过"), and P4 already labels a heuristic
* verdict as never a deterministic pass. What this rule does buy is that the
* root's acceptance cannot be *only* the conjunction of what it delegated.
*
* `label` names the contract under validation (`root contract`, `root
* contract of session "s-…"`); the reason is prefixed with it, like every other
* contract rule's.
*/
function rootIndependenceDefects(criteria, label) {
	if (criteria.some((criterion) => criterion.mandatory === true && criterion.verificationMode !== "composite")) return [];
	return [`${label} requires at least one mandatory acceptance criterion judged by something other than the composite conjunction (verificationMode !== "composite"): a root whose only mandatory criterion is "all children verified" is satisfied by its own decomposition and has no independent check of the goal it was given`];
}
/**
* Whether a criterion declares a command a verifier could actually run. A
* declared command that is blank — or not text at all — is as missing as an
* absent one: nothing executable was handed to the judge.
*/
function hasCommand(command) {
	return typeof command === "string" && command.trim().length > 0;
}
/**
* Structural defects of one task's acceptance contract (T1, construction guide
* §4): what has to hold before a contract can be admitted at all, whichever
* entry wrote it — an ordinary decomposition child, a replay candidate, or
* (later) a template instance. Texts, ids, modes, and the fixed form of a
* criterion's protected acceptance inputs only; nothing here judges whether a
* criterion is any good, and nothing here needs the store.
*
* The ordinary decomposition path and the replay path share this function so
* that a rule can never hold on one and not on the other. The *parent* task's
* own criteria are deliberately not put through it: a parent that already
* exists was admitted when it was created, and T1 does not re-open contracts
* that predate the normalized one — `checkDecomposition` still applies
* {@link independentAcceptanceDefects} to the parent, which is its own P4
* promise about a declaration the parent itself carries.
*
* `label` names the task under validation (`child 0 ("t-1")`, `replay of
* "t-1"`); every reason is prefixed with it.
*/
function contractDefects(criteria, label) {
	const reasons = [];
	if (criteria.length === 0) {
		reasons.push(`${label} requires at least one acceptance criterion`);
		return reasons;
	}
	const seen = /* @__PURE__ */ new Set();
	const reportedDuplicate = /* @__PURE__ */ new Set();
	for (const criterion of criteria) {
		const where = `${label} criterion "${criterion.criterionId}"`;
		const description = criterion.description;
		if (typeof description !== "string" || description.trim().length === 0) reasons.push(`${where} requires a non-empty description`);
		if (!VERIFICATION_MODES.includes(criterion.verificationMode)) reasons.push(`${where} verificationMode "${String(criterion.verificationMode)}" is not one of ${VERIFICATION_MODES.join(", ")}`);
		else if (EXECUTABLE_MODES.includes(criterion.verificationMode) && !hasCommand(criterion.command)) reasons.push(`${where} (${criterion.verificationMode}) requires a command`);
		if (seen.has(criterion.criterionId) && !reportedDuplicate.has(criterion.criterionId)) {
			reasons.push(`${label} declares criterion id "${criterion.criterionId}" more than once`);
			reportedDuplicate.add(criterion.criterionId);
		}
		seen.add(criterion.criterionId);
		reasons.push(...protectedInputDefects([criterion], label));
	}
	if (!criteria.some((criterion) => criterion.mandatory === true)) reasons.push(`${label} requires at least one mandatory acceptance criterion`);
	return reasons;
}
/**
* How one planned child is named in a refusal: its position always, its id when
* the batch has one yet ({@link AdmissionChild.taskId}). A batch is judged
* before its ids are minted (`TaskRuntime.deriveBatch` / `checkDerivedBatch`
* deliberately mint nothing), so a refusal names the child's position — and the
* same verdict comes out either way, because only the id in the message differs.
*/
function childLabel(child, index) {
	return child.taskId === void 0 ? `child ${index}` : `child ${index} ("${child.taskId}")`;
}
/**
* How one planned child is named inside a dependency message: its id when it
* has one, its batch position otherwise (`#0` is the first child). The two
* forms appear in `dependency "…" → "…"` messages only — the edges this
* function builds are the plan's own, checked for duplicates and cycles before
* any id exists.
*/
function childRef(child, index) {
	return child?.taskId ?? `#${index}`;
}
/**
* Structural admission checks for one decomposition batch (RFC §36). Pure:
* every rule is validated up front and the caller persists only when the
* verdict is `ok`, so admission is atomic for the whole batch.
*/
function checkDecomposition(parent, children, existingEdges) {
	const reasons = [];
	const policy = parent.decompositionPolicy;
	if (!policy.allowed) reasons.push(policy.leaf === true ? `task "${parent.taskId}" decomposition is not allowed: it is admitted as leaf and runtime decomposition is off (allowRuntimeDecomposition: false), so only a task admitted decomposable may split` : `task "${parent.taskId}" decomposition is not allowed`);
	if (policy.maxDepth !== void 0 && parent.depth + 1 > policy.maxDepth) reasons.push(`task "${parent.taskId}" children would exceed maxDepth ${policy.maxDepth} (depth ${parent.depth + 1})`);
	if (policy.maxChildren !== void 0 && children.length > policy.maxChildren) reasons.push(`task "${parent.taskId}" would have ${children.length} children, above maxChildren ${policy.maxChildren}`);
	if (children.length === 0) reasons.push(`task "${parent.taskId}" decomposition requires at least one child`);
	reasons.push(...independentAcceptanceDefects(parent.acceptanceCriteria, parent.requiresIndependentAcceptance, `task "${parent.taskId}"`));
	const plannedEdges = [];
	children.forEach((child, index) => {
		const label = childLabel(child, index);
		if (child.objective.trim().length === 0) reasons.push(`${label} objective must be non-empty`);
		reasons.push(...contractDefects(child.acceptanceCriteria, label));
		reasons.push(...independentAcceptanceDefects(child.acceptanceCriteria, child.requiresIndependentAcceptance, label));
		for (const criterion of child.acceptanceCriteria) {
			if (criterion.requiresArtifact !== void 0 && (!Array.isArray(criterion.requiresArtifact) || criterion.requiresArtifact.some((ref) => typeof ref !== "string" || ref.trim().length === 0))) reasons.push(`${label} criterion "${criterion.criterionId}" requiresArtifact must be an array of non-empty strings`);
			if (criterion.verifierRef !== void 0 && (typeof criterion.verifierRef !== "string" || criterion.verifierRef.trim().length === 0)) reasons.push(`${label} criterion "${criterion.criterionId}" verifierRef must be a non-empty string`);
		}
		for (const dependency of child.dependsOn ?? []) {
			if (!Number.isInteger(dependency) || dependency < 0 || dependency >= children.length) {
				reasons.push(`${label} dependsOn index ${dependency} is out of range`);
				continue;
			}
			if (dependency === index) {
				reasons.push(`${label} cannot depend on itself`);
				continue;
			}
			plannedEdges.push({
				from: childRef(children[dependency], dependency),
				to: childRef(child, index)
			});
		}
	});
	const edges = [...existingEdges, ...plannedEdges];
	const seen = /* @__PURE__ */ new Set();
	for (const edge of edges) {
		const key = `${edge.from}→${edge.to}`;
		if (seen.has(key)) reasons.push(`dependency "${key}" is declared more than once`);
		seen.add(key);
	}
	for (const edge of plannedEdges) if (reaches(edges, edge.to, edge.from)) reasons.push(`dependency "${edge.from}" → "${edge.to}" creates a cycle`);
	return reasons.length === 0 ? { ok: true } : {
		ok: false,
		reasons
	};
}

//#endregion
//#region src/gate.ts
/**
* What a session bound to a run may still call once its run is no longer
* `active`. Read-only inspection, diagnosis, the human-question tools, and the
* controlled cancellation of this batch: the work of *looking at* a run or
* ending it, never of making it produce more. `context_read` is the one
* history/reference reader here: the raw cross-session tools it replaced
* (`session_event_read` and its siblings) are sealed off every runtime-owned
* agent by the execution guard, so they have no phase to be allowed in.
*
* `task_cancel` is in the list because cancelling is the one write a waiting or
* submitted run is allowed: the run has stopped deciding, and the owner may
* still stop the tree.
*
* The proposal tools follow the same categories (T2/T3). `task_proposal_read`
* reads a saved proposal and `task_proposal_cancel` withdraws the batch its own
* session proposed: they are the looking-at and the ending of what this run
* already asked for, exactly the work `task_read` and `task_cancel` do.
* `task_proposal_continue` is deliberately **not** here: it can admit a batch,
* which is the same effect `task_decompose` has, so it is a write in every
* non-active phase — a run that has stopped deciding its own work does not get
* to turn a proposal into tasks.
*
* The two question tools (A4 §F.1) are coordination in the plainest sense: a
* child asking its direct parent is the one effect still admitted while its own
* run is blocked on a question, and a parent answering a child is the one effect
* a `waiting_children` parent may still produce. Neither makes anything else
* writable — answering is not a phase change, and a blocked run keeps its block
* until the answer that resolves it.
*/
const COORDINATION_ALLOWED = new Set([
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"skill",
	"task_review_pack",
	"task_diagnose",
	"read",
	"read_image",
	"glob",
	"grep",
	"web_fetch",
	"ask_user_question",
	"hitl_ask",
	"hitl_approve",
	"task_cancel",
	"task_proposal_read",
	"task_proposal_cancel",
	"task_ask_parent",
	"task_answer"
]);
/** The job statuses that mean the work is over — the only statuses the drain accepts as confirmed. */
const TERMINAL_JOB_STATUSES = new Set([
	"killed",
	"completed",
	"failed"
]);
/** The reason a drain kill carries, so a producer's log says who asked and why. */
const DRAIN_KILL_REASON = "task-runtime: write drain before admission closes";
/** How often the drain re-reads the in-flight set. Short: the calls it waits for usually settle in milliseconds. */
const DRAIN_POLL_MS = 5;
function message$6(error) {
	return error instanceof Error ? error.message : String(error);
}
function sleep$1(ms) {
	return new Promise((resolve$1) => {
		setTimeout(resolve$1, ms);
	});
}
/**
* The phase each session is in, what it has in flight, and whether it is waiting
* on an answer. One instance per runtime; nothing here touches the store or a
* service, so the rules can be tested as the pure state machine they are.
*/
var ExecutionGate = class {
	phases = /* @__PURE__ */ new Map();
	/** Registering by call id (not by session) because `tools/result` carries only the call id. */
	calls = /* @__PURE__ */ new Map();
	/**
	* How many times this process wrote one session's phase by its own authority
	* ({@link setPhase}, {@link setTerminal}): the applicability token a
	* store-derived phase is checked against.
	*/
	decisions = /* @__PURE__ */ new Map();
	/**
	* The sessions whose runs are waiting on an unresolved blocking question
	* (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
	* are the same fact, and a cleared session must not leave a stale value to be
	* read back. Nothing here is persisted or projected — the store's question
	* facts are the durable state, and this is the live process's handle on them.
	*/
	questionBlocked = /* @__PURE__ */ new Set();
	/**
	* Move a session's phase: the runtime calls this when **it** is the authority
	* for the transition — a committed admission or submission, a settled run, an
	* unload, the binding of a session to its own run. This is one of the two
	* writers that count as a decision ({@link decisionToken}); a phase that only
	* the *store* implies goes through {@link applyStorePhase} instead, and does
	* not count as one.
	*/
	setPhase(sessionId, phase) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		this.phases.set(sessionId, phase);
	}
	/**
	* Mark a session's run terminal: only the allow-list runs from here, and its
	* reason says the call is late. A decision, like {@link setPhase} — it moves
	* the phase because this process knows the run is over, not because a read of
	* the store implied it.
	*
	* The question block goes with it: an open question requires *both* runs to be
	* running, so a run this process just made terminal is blocked by nothing —
	* leaving the flag set would make the refusal name a wait that no longer
	* exists.
	*/
	setTerminal(sessionId) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		this.phases.set(sessionId, "terminal");
		this.questionBlocked.delete(sessionId);
	}
	/**
	* How many times this process has written this session's phase by its own
	* authority; `0` for a session it has never written one for. This is the
	* applicability token for a phase read out of the store: take it *before* the
	* read, hand it back with the value ({@link applyStorePhase}).
	*
	* What it answers is not "is this value current" — a second read would race
	* the first exactly as it did — but "did anything of ours decide this session
	* while the read was in flight". That is the only thing that can make a value
	* the store returned older than the gate: the read happened, the store
	* recorded a decision of ours, and the value the read handed back predates it.
	*/
	decisionToken(sessionId) {
		return this.decisions.get(sessionId) ?? 0;
	}
	/**
	* Apply a phase the store implies — never one this process decided — and only
	* when it is newer than everything decided here: `token` is the
	* {@link decisionToken} taken before the read that produced `phase`, and a
	* count that no longer matches means a decision landed while that read was in
	* flight. The value is then older than the gate's, and it is dropped; the
	* return says which of the two happened.
	*
	* Two trajectories reach a store-derived phase that is too old, and only one
	* of them is this token's:
	*
	* - a read that **straddled** a decision — the store returned the old record,
	*   and the decision landed before the value could be applied — is what this
	*   token refuses: the decision is on the record by then, so the count moved
	*   and the value is dropped. Applying it would re-open a gate a settled run
	*   had closed, and no other guard can see it, because the wait was inside the
	*   read and the store is already up to date when the value arrives.
	* - a read taken **inside a window whose decision is in effect but not yet
	*   persisted** (a cancellation raising its barrier before the store records
	*   it) cannot be refused by this token: the read starts *after* the decision,
	*   so the count it took is current, and the value is old only because the
	*   store's write has not happened yet. That window belongs to the caller,
	*   which refuses it before calling this — the token covers a read that
	*   straddled a decision, never one that raced a write.
	*/
	applyStorePhase(sessionId, phase, token) {
		if (this.decisionToken(sessionId) !== token) return false;
		this.phases.set(sessionId, phase);
		if (phase === "terminal") this.questionBlocked.delete(sessionId);
		return true;
	}
	/**
	* Record that a session's run is — or is no longer — waiting on an unresolved
	* blocking question (A4 §F.1). A decision of this process about a fact this
	* process just wrote (the ask it committed, the answer that released one, the
	* addressee's own settlement that ended every question addressed to it), so it
	* counts as one exactly as {@link setPhase} does; a value the *store* implies
	* goes through {@link applyStoreQuestionsBlocked}.
	*
	* `false` is not "probably unblocked": the caller is stating the derivation it
	* just took from the store's question facts (`blockingQuestionsOf`), which is
	* what makes a second blocking question keep the session blocked after the
	* first is answered.
	*/
	setQuestionsBlocked(sessionId, blocked) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		if (blocked) this.questionBlocked.add(sessionId);
		else this.questionBlocked.delete(sessionId);
	}
	/**
	* Apply a blocking state the store implies — never one this process decided —
	* under the same token rule as {@link applyStorePhase}: `token` is the
	* {@link decisionToken} taken before the read that produced it, and a value
	* the gate has moved past is dropped rather than applied. The return says
	* which of the two happened.
	*/
	applyStoreQuestionsBlocked(sessionId, blocked, token) {
		if (this.decisionToken(sessionId) !== token) return false;
		if (blocked) this.questionBlocked.add(sessionId);
		else this.questionBlocked.delete(sessionId);
		return true;
	}
	/** Whether the run bound to this session is waiting on an unresolved blocking question (A4 §7.2's derived wait). */
	questionsBlocked(sessionId) {
		return this.questionBlocked.has(sessionId);
	}
	/** The phase a session is under, or `undefined` when no run is bound to it (nothing is gated). */
	phaseOf(sessionId) {
		return this.phases.get(sessionId);
	}
	/**
	* Register a call that was let through. Called for every allowed call whatever
	* its phase, because the phase can change while it runs — that in-flight write
	* is what `drainSession` waits for.
	*/
	trackAllowed(sessionId, callId, toolName) {
		this.calls.set(callId, {
			sessionId,
			name: toolName
		});
	}
	/** The result event for a call arrived: it is no longer in flight. Unknown ids are the denied calls, and are ignored. */
	settled(callId) {
		this.calls.delete(callId);
	}
	/**
	* The session's in-flight calls that count as writes: everything whose name is
	* not in {@link COORDINATION_ALLOWED}. The definition is the allow-list, not a
	* second list of write tools — a tool this deployment adds is a write until the
	* coordination protocol says otherwise, and the two answers cannot drift.
	*/
	inFlightWrites(sessionId) {
		const writes = [];
		for (const [callId, call] of this.calls) {
			if (call.sessionId !== sessionId) continue;
			if (COORDINATION_ALLOWED.has(call.name)) continue;
			writes.push({
				callId,
				name: call.name
			});
		}
		return writes;
	}
	/**
	* Decide one call. A session with no phase is not bound to a run and is not
	* gated; an `active` run with no blocking question is still deciding its own
	* work. Every other state allows the coordination list and denies everything
	* else, naming what holds the session — the phase, or the question it waits on
	* — the refused tool, and what is still allowed.
	*
	* The two refusals are one decision with two names because a caller has to be
	* able to tell them apart: `active` plus a blocking question is *not* "the
	* phase closed writes", it is "this run is waiting for an answer", and an
	* answer (not a phase change) is what ends it. Both are computed after the
	* allow-list, so the question tools and the reads answer in either state.
	*/
	decide(sessionId, toolName) {
		const phase = this.phases.get(sessionId);
		if (phase === void 0) return { allow: true };
		if (COORDINATION_ALLOWED.has(toolName)) return { allow: true };
		const blocked = this.questionBlocked.has(sessionId);
		if (phase === "active" && !blocked) return { allow: true };
		const late = phase === "terminal" ? " This is a late call: the run is terminal, so only read-only coordination remains." : "";
		return {
			allow: false,
			reason: `the run bound to this session ${blocked ? `is waiting on an unresolved blocking question (its phase is "${phase}", unchanged: an answer releases the question, never the write gate)` : `is in phase "${phase}", where tools that write, spawn, or produce effects are closed`}, so "${toolName}" is denied.${late} Allowed in this phase: the coordination and read-only tools (${[...COORDINATION_ALLOWED].join(", ")}).`
		};
	}
	/**
	* Wait — bounded — until this session has no in-flight write and no live
	* managed job, and say exactly what is left when the window closes. Never
	* assumes a stop: `confirmed: false` with named `pending` entries is the
	* honest answer for a call that did not settle or a job that is still not
	* terminal, and the caller must refuse verification on it (§3.3).
	*
	* Order matters: the in-flight calls first (they are the writes this process
	* can see finish), then the jobs this session started (kill, then wait for a
	* terminal status within whatever window is left). The jobs step is skipped
	* entirely when the deployment gave no service or no agent — there is nothing
	* to reconcile, which is not the same as "nothing running".
	*/
	async drainSession(sessionId, opts) {
		const deadline = Date.now() + opts.timeoutMs;
		const pending = [];
		for (;;) {
			const writes = this.inFlightWrites(sessionId).filter((call) => call.callId !== opts.excludeCallId);
			if (writes.length === 0) break;
			if (Date.now() >= deadline) {
				pending.push(...writes.map((call) => `in-flight call "${call.name}" (${call.callId}) had not settled when the drain window closed`));
				break;
			}
			await sleep$1(DRAIN_POLL_MS);
		}
		const { jobs, agent } = opts;
		if (jobs !== void 0 && agent !== void 0) pending.push(...await reconcileJobs(jobs, agent, deadline));
		return pending.length === 0 ? { confirmed: true } : {
			confirmed: false,
			pending
		};
	}
};
/**
* One write drain, wired the way every caller means it: the caller's own window,
* the coordination call that must not be waited for, and the managed jobs — which
* are reconciled only when both the service and the agent authorizing the kills
* are there. The rule lives in one place so the three call sites cannot drift.
*/
async function drainSession(gate, sessionId, options) {
	const { jobs, agent } = options;
	return await gate.drainSession(sessionId, {
		timeoutMs: options.timeoutMs,
		...options.excludeCallId === void 0 ? {} : { excludeCallId: options.excludeCallId },
		...jobs === void 0 || agent === void 0 ? {} : {
			jobs,
			agent
		}
	});
}
/**
* Kill and confirm every non-terminal job the agent owns, within what is left of
* the drain window. Every failure mode is a *named* entry in the returned list:
* a jobs call that threw, a job that could not be waited for, a job whose status
* is still not terminal. None of them is read as "stopped".
*/
async function reconcileJobs(jobs, agent, deadline) {
	const pending = [];
	let listed;
	try {
		listed = jobs.list(agent);
	} catch (error) {
		return [`the jobs service could not be listed (${message$6(error)}), so its managed work could not be reconciled`];
	}
	for (const entry of listed) {
		const id = entry.id;
		if (typeof id !== "string" || id.length === 0) {
			pending.push(`a listed job with status "${entry.status}" names no id, so it could not be killed or waited for`);
			continue;
		}
		if (TERMINAL_JOB_STATUSES.has(entry.status)) continue;
		try {
			jobs.kill(id, agent, DRAIN_KILL_REASON);
		} catch (error) {
			pending.push(`job "${id}" (${entry.status}) could not be killed: ${message$6(error)}`);
			continue;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			pending.push(`job "${id}" (${entry.status}) was asked to stop but the drain window closed before it could be confirmed terminal`);
			continue;
		}
		try {
			const settled = await jobs.wait(id, remaining, agent);
			if (!TERMINAL_JOB_STATUSES.has(settled.status)) pending.push(`job "${id}" is "${settled.status}"${settled.detail === void 0 ? "" : ` (${settled.detail})`} after being asked to stop, which is not a terminal status`);
		} catch (error) {
			pending.push(`job "${id}" (${entry.status}) could not be waited for: ${message$6(error)}`);
		}
	}
	return pending;
}

//#endregion
//#region src/skill-contract.ts
/**
* The sidecar file, read as JSON, named exactly here so every producer and
* reader of a skill directory agrees on one spelling.
*/
const SKILL_SIDECAR_FILE = "SKILL.contract.json";
/**
* The sidecar contract version this build writes and reads. Like the task
* contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
* skill: a sidecar declaring a version this build does not know is refused
* rather than read with the wrong field semantics.
*/
const SKILL_CONTRACT_VERSION = 1;
/**
* The directories a skill may hold supporting files in. The supported shape is
* deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
* be described by the identity without inventing rules for directories, and an
* unsupported shape has to be refused by name rather than skipped.
*/
const SUPPORTED_SKILL_RESOURCE_DIRS = ["references", "scripts"];
/**
* Whether one declared resource path is a path this contract can identify:
* exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
* POSIX separators, no `.`/`..` segment, nothing absolute. Anything else —
* nested trees, a second segment, backslashes, a bare directory — is outside
* the supported shape and is refused by name.
*/
function isSupportedSkillResourcePath(path) {
	const segments = path.split("/");
	if (segments.length !== 2) return false;
	const [directory, file] = segments;
	if (!SUPPORTED_SKILL_RESOURCE_DIRS.includes(directory)) return false;
	return file.length > 0 && file !== "." && file !== ".." && !file.includes("\\");
}
const EXECUTION_FIELDS = [
	"contractVersion",
	"type",
	"capabilities",
	"precondition",
	"inputs",
	"outputs",
	"requiredTools",
	"verifier",
	"content"
];
const KNOWLEDGE_FIELDS = [
	"contractVersion",
	"type",
	"source",
	"scope",
	"content",
	"contentCheck"
];
const PORT_FIELDS = [
	"name",
	"description",
	"required"
];
const RESOURCE_FIELDS = ["path", "sha256"];
const VERIFIER_FIELDS = ["ref"];
const CONTENT_CHECK_FIELDS = ["kind", "command"];
const CONTENT_FIELDS = ["skillMdSha256", "resources"];
function isPlainObject$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** Non-blank text: the one check every string field shares, with no rewriting of the value. */
function nonBlank$1(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isSha256Hex(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
/** How an unexpected value reads in a refusal: JSON for scalars, a noun for containers. */
function described(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object") return "an object";
	return String(value);
}
/** What a value *is*, for the one refusal that cannot name a field (the whole sidecar). */
function kindOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}
function shape(reason) {
	return {
		code: "sidecar-shape",
		reason
	};
}
function unknownFields$1(value, allowed, where, carries) {
	return Object.keys(value).filter((key) => !allowed.includes(key)).sort().map((key) => ({
		code: "sidecar-unknown-field",
		reason: `${where} declares unknown field ${JSON.stringify(key)}; ${carries}`
	}));
}
/** One string list: an array of non-blank names, each once, `[]` allowed unless `minItems` says otherwise. */
function nameListDefects(value, where, missing, duplicate, minItems = 0) {
	if (!Array.isArray(value) || minItems > 0 && value.length < minItems) return [shape(missing)];
	const defects = [];
	const seen = /* @__PURE__ */ new Set();
	value.forEach((item, index) => {
		if (!nonBlank$1(item)) {
			defects.push(shape(`${where}[${index}] must be a non-blank string`));
			return;
		}
		if (seen.has(item)) {
			defects.push(shape(duplicate(item, index)));
			return;
		}
		seen.add(item);
	});
	return defects;
}
/** Ports: closed objects, each list naming a port once. */
function portDefects(value, where) {
	if (!Array.isArray(value)) return [shape(`${where} must be an array of ports`)];
	const defects = [];
	const seen = /* @__PURE__ */ new Set();
	value.forEach((port, index) => {
		const at = `${where}[${index}]`;
		if (!isPlainObject$1(port)) {
			defects.push(shape(`${at} must be an object carrying name, description, required`));
			return;
		}
		defects.push(...unknownFields$1(port, PORT_FIELDS, at, "a port carries name, description, required"));
		if (!nonBlank$1(port.name)) defects.push(shape(`${at}.name must be a non-blank string`));
		if (!nonBlank$1(port.description)) defects.push(shape(`${at}.description must be a non-blank string`));
		if (typeof port.required !== "boolean") defects.push(shape(`${at}.required must be a boolean`));
		if (nonBlank$1(port.name)) {
			if (seen.has(port.name)) defects.push(shape(`${at} duplicates port ${JSON.stringify(port.name)}`));
			seen.add(port.name);
		}
	});
	return defects;
}
/** The content identity: exact digests, a supported path vocabulary, and one sorted list. */
function contentDefects$1(value) {
	if (!isPlainObject$1(value)) return [shape("sidecar.content must be an object carrying skillMdSha256 and resources")];
	const defects = unknownFields$1(value, CONTENT_FIELDS, "sidecar.content", "a content identity carries skillMdSha256, resources");
	if (!isSha256Hex(value.skillMdSha256)) defects.push(shape("sidecar.content.skillMdSha256 must be a lowercase 64-character hex digest"));
	const resources = value.resources;
	if (!Array.isArray(resources)) {
		defects.push(shape("sidecar.content.resources must be an array of resource identities"));
		return defects;
	}
	const seen = /* @__PURE__ */ new Set();
	let previous;
	resources.forEach((resource, index) => {
		const at = `sidecar.content.resources[${index}]`;
		if (!isPlainObject$1(resource)) {
			defects.push(shape(`${at} must be an object carrying path, sha256`));
			return;
		}
		defects.push(...unknownFields$1(resource, RESOURCE_FIELDS, at, "a resource identity carries path, sha256"));
		if (!nonBlank$1(resource.path) || !isSupportedSkillResourcePath(resource.path)) defects.push(shape(`${at}.path ${described(resource.path)} is not a supported resource path (references/<file> or scripts/<file>)`));
		else if (seen.has(resource.path)) defects.push(shape(`${at} duplicates ${JSON.stringify(resource.path)}`));
		else {
			if (previous !== void 0 && resource.path < previous) defects.push(shape(`${at} path ${JSON.stringify(resource.path)} precedes ${JSON.stringify(previous)}; the list must be sorted by path`));
			seen.add(resource.path);
			previous = resource.path;
		}
		if (!isSha256Hex(resource.sha256)) defects.push(shape(`${at}.sha256 must be a lowercase 64-character hex digest`));
	});
	return defects;
}
function verifierDefects(value) {
	if (!isPlainObject$1(value)) return [shape("sidecar.verifier must be an object carrying a ref")];
	const defects = unknownFields$1(value, VERIFIER_FIELDS, "sidecar.verifier", "a verifier reference carries ref");
	if (!nonBlank$1(value.ref)) defects.push(shape("sidecar.verifier.ref must be a non-blank string"));
	return defects;
}
function contentCheckDefects(value) {
	if (!isPlainObject$1(value)) return [shape("sidecar.contentCheck must be an object carrying kind and command")];
	const defects = unknownFields$1(value, CONTENT_CHECK_FIELDS, "sidecar.contentCheck", "a content check carries kind, command");
	if (value.kind !== "command") defects.push(shape(`sidecar.contentCheck.kind ${described(value.kind)} is not one of command`));
	if (!nonBlank$1(value.command)) defects.push(shape("sidecar.contentCheck.command must be a non-blank string"));
	return defects;
}
/**
* Every reason one declared sidecar is not acceptable, in field order — never
* just the first, so one refusal names everything wrong with the declaration.
*
* Purely declaration-level: the version, the closed field set of the declared
* type, the shape of every field, and the internal consistency of the content
* identity. It reads no files, so it cannot tell whether the digests are true —
* that comparison needs the skill directory and lives in the loader. The
* returned defects are values, not throws: a caller refusing a sidecar reports
* all of them and writes nothing.
*/
function skillContractDefects(value) {
	if (!isPlainObject$1(value)) return [shape(`the sidecar must be a JSON object, got ${kindOf(value)}`)];
	const defects = [];
	if (value.contractVersion === void 0) defects.push({
		code: "sidecar-unknown-version",
		reason: `sidecar.contractVersion is missing; this build reads and writes version ${SKILL_CONTRACT_VERSION}`
	});
	else if (value.contractVersion !== SKILL_CONTRACT_VERSION) defects.push({
		code: "sidecar-unknown-version",
		reason: `sidecar.contractVersion ${described(value.contractVersion)} is not a version this build reads (${SKILL_CONTRACT_VERSION})`
	});
	const type = value.type;
	if (type !== "execution" && type !== "knowledge") {
		defects.push(shape(`sidecar.type ${described(type)} is not one of execution, knowledge`));
		return defects;
	}
	if (type === "execution") {
		defects.push(...unknownFields$1(value, EXECUTION_FIELDS, "sidecar", `an execution sidecar carries ${EXECUTION_FIELDS.join(", ")}`));
		defects.push(...nameListDefects(value.capabilities, "sidecar.capabilities", "sidecar.capabilities must be a non-empty array of capability names", (name, index) => `sidecar.capabilities[${index}] duplicates ${JSON.stringify(name)}`, 1));
		if (!nonBlank$1(value.precondition)) defects.push(shape("sidecar.precondition must be a non-blank string"));
		defects.push(...portDefects(value.inputs, "sidecar.inputs"));
		defects.push(...portDefects(value.outputs, "sidecar.outputs"));
		defects.push(...nameListDefects(value.requiredTools, "sidecar.requiredTools", "sidecar.requiredTools must be an array of tool names", (name, index) => `sidecar.requiredTools[${index}] duplicates ${JSON.stringify(name)}`));
		defects.push(...verifierDefects(value.verifier));
		defects.push(...contentDefects$1(value.content));
		return defects;
	}
	defects.push(...unknownFields$1(value, KNOWLEDGE_FIELDS, "sidecar", `a knowledge sidecar carries ${KNOWLEDGE_FIELDS.join(", ")}`));
	if (!nonBlank$1(value.source)) defects.push(shape("sidecar.source must be a non-blank string"));
	if (!nonBlank$1(value.scope)) defects.push(shape("sidecar.scope must be a non-blank string"));
	defects.push(...contentDefects$1(value.content));
	defects.push(...contentCheckDefects(value.contentCheck));
	return defects;
}
/**
* The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
* declared data, so key order and `undefined`-valued keys do not move it while
* any declared field does. Call it on a sidecar that passed
* {@link skillContractDefects}: an unvalidated object can carry fields this
* identity would then cover without a rule saying what they mean.
*/
function skillContractDigest(sidecar) {
	return sha256Hex(canonicalize(sidecar));
}
/**
* The identity of one content identity: SHA-256 over {@link canonicalize} of the
* `SKILL.md` digest and the resource list. Separate from
* {@link skillContractDigest} so a caller can name the bytes (a run recording
* what it read) without claiming a sidecar it did not read.
*/
function skillContentDigest(content) {
	return sha256Hex(canonicalize(content));
}
/**
* The same declaration with one field replaced: `content.skillMdSha256`.
*
* A same-name improvement of an execution skill changes the `SKILL.md` and
* nothing else about the object (K3): the capabilities, precondition, ports,
* required tools, verifier and resources are the ones the production sidecar
* declared, so the candidate's sidecar is *derived* from the production one
* rather than authored — a content update that could also move a declaration
* would be an undeclared privilege change. Every other field is carried over
* item by item; the digest is checked first, because a value that is not a
* lowercase 64-character hex SHA-256 would produce a declaration no reader could
* verify and no writer should persist.
*/
function sidecarWithSkillMd(sidecar, skillMdSha256) {
	if (!/^[0-9a-f]{64}$/.test(skillMdSha256)) throw new Error(`skill-contract: cannot replace sidecar content.skillMdSha256 with ${JSON.stringify(skillMdSha256)} — a content identity is a lowercase 64-character hex SHA-256, and a rewritten sidecar is a declaration a loader will have to verify against real bytes`);
	return {
		...sidecar,
		content: {
			...sidecar.content,
			skillMdSha256
		}
	};
}
/**
* The deterministic byte sequence of one declaration — what a file holds when
* this build writes a sidecar.
*
* Determinism is the point: {@link skillContractDigest} hashes the canonical
* key order, so the bytes on disk must be a function of the declaration alone,
* not of the order a caller happened to build its object in. Two calls with the
* same declaration produce the same string, and a reader can verify a file by
* parsing it and re-serializing: identical bytes mean the declaration did not
* move — which is exactly how the K3 derivation check compares a candidate's
* sidecar with the one re-derived from the champion's bytes. The shape is
* canonical keys, two-space indentation, one trailing newline.
*/
function serializeSkillSidecar(sidecar) {
	return `${JSON.stringify(JSON.parse(canonicalize(sidecar)), null, 2)}\n`;
}

//#endregion
//#region src/verified-read.ts
/** Resolve `rel` under `base`, refusing anything that would land outside. */
function resolveWithin(base, rel) {
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(`${base}${sep}`)) throw new Error(`verified-read: path ${JSON.stringify(rel)} escapes ${base}`);
	return abs;
}
/**
* Walk `rel` under `root` one component at a time, refusing anything but real
* entries: a symbolic link anywhere on the path, a non-regular entry where the
* target should be, or a non-directory where a directory should be all fail
* loudly, so a read can never land outside the root through a redirected path
* even though the lexical path stays inside. A component that is simply absent
* (ENOENT / ENOTDIR anywhere along the walk) is reported as `missing`, never
* thrown — the caller decides whether absence is an error or an answer.
*/
async function walkVerified(root, rel) {
	const abs = resolveWithin(root, rel);
	const steps = relative(root, abs).split(sep);
	let current = root;
	for (const step of steps) {
		current = join(current, step);
		let stat$1;
		try {
			stat$1 = await lstat(current);
		} catch (error) {
			const code = error.code;
			if (code === "ENOENT" || code === "ENOTDIR") return {
				missing: true,
				reason: code === "ENOTDIR" ? "a path component is not a directory" : "no such file or directory"
			};
			throw error;
		}
		if (stat$1.isSymbolicLink()) throw new Error(`verified-read: "${current}" is a symbolic link; a path and its ancestors must be real entries inside ${root}`);
		if (current === abs ? !stat$1.isFile() : !stat$1.isDirectory()) throw new Error(`verified-read: "${current}" is not a regular ${current === abs ? "file" : "directory"}`);
	}
	return {
		missing: false,
		abs
	};
}
/**
* Read the file at `rel` under `root` as raw bytes, refusing anything but a
* real regular file: the entry itself and every ancestor between `root` and it
* must not be a symbolic link. A missing file, a directory in the file's place,
* or any other non-regular entry fails loudly. The bytes are returned exactly
* as stored — no decoding, no newline conversion.
*/
async function readVerifiedFile(root, rel) {
	const walked = await walkVerified(root, rel);
	if (walked.missing) throw new Error(`verified-read: ${JSON.stringify(rel)} is missing under ${root} (${walked.reason})`);
	return readFile(walked.abs);
}

//#endregion
//#region src/sidecar.ts
/**
* A capability table as a query, going through `resolveCapabilities` — the same
* resolution admission performs — so the pre-check sees exactly the grant a
* spawn would build and a broken row is refused with the resolution's own
* reason instead of being silently treated as granting nothing.
*/
function capabilityToolQuery(capabilities) {
	return (capability) => {
		let manifest;
		try {
			manifest = resolveCapabilities([capability], capabilities);
		} catch (error) {
			return {
				known: false,
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		const entry = manifest.capabilities[capability];
		if (entry === void 0) return {
			known: false,
			reason: `capability "${capability}" is not in the capability table`
		};
		return {
			known: true,
			tools: entry.tools,
			mcpServers: entry.mcpServers ?? []
		};
	};
}
/** Build the pre-check context from a capability table and the registered verifier ids. */
function skillValidationContext(capabilities, verifierRefs) {
	return {
		verifierRefs: [...verifierRefs].sort(),
		capabilityTools: capabilityToolQuery(capabilities)
	};
}
/**
* The verdicts that may close an execution gap — and the only place a caller
* needs to ask. A knowledge or guidance verdict is not in the result, so the
* closure semantics cannot be relaxed by accident at a call site.
*/
function executionProviders(verdicts) {
	return verdicts.filter((verdict) => verdict.valid && verdict.role === "execution-provider");
}
function message$5(error) {
	return error instanceof Error ? error.message : String(error);
}
function defect$1(code, detail) {
	return {
		code,
		detail
	};
}
/** The sidecar contract's own defect codes are already named the same way, so they carry over unchanged. */
function contractDefects$1(defects) {
	return defects.map((item) => defect$1(item.code, item.reason));
}
/** Whether the bytes are text a worker can read: valid UTF-8 with no NUL byte. */
function isText(bytes) {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}
/**
* Read the compiled bytes of one file under the skill directory, turning a
* refusal into a named defect rather than a throw, so one broken entry does not
* hide the rest of the scan.
*/
async function readBytes(directory, relativePath, relative$1, defects) {
	try {
		const walked = await walkVerified(directory, relativePath);
		if (walked.missing) {
			defects.push(defect$1("content-mismatch", `${relative$1} is declared but missing from the skill directory`));
			return;
		}
		return await readFile(walked.abs);
	} catch (error) {
		defects.push(defect$1("content-unsupported", `${relative$1} cannot be read as a real file: ${message$5(error)}`));
		return;
	}
}
/**
* Walk one skill directory and describe it: which files sit at supported
* positions with their real digests, which direct entries the supported
* vocabulary does not cover, and every entry that is not a shape this contract
* supports. Nothing is skipped silently — a link, a nested tree or a non-text
* file is named.
*/
async function scanSkillDirectory(directory) {
	const scanned = {
		skillMdPresent: false,
		resources: [],
		uncovered: [],
		unsupported: [],
		defects: []
	};
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		scanned.defects.push(defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message$5(error)}`));
		return scanned;
	}
	for (const entry of entries) {
		const name = entry.name;
		const at = join(directory, name);
		let info;
		try {
			info = await lstat(at);
		} catch (error) {
			scanned.defects.push(defect$1("content-unsupported", `${name} cannot be read: ${message$5(error)}`));
			continue;
		}
		if (name === "SKILL.md") {
			scanned.skillMdPresent = true;
			if (info.isSymbolicLink()) {
				scanned.defects.push(defect$1("content-unsupported", "SKILL.md is a symbolic link; a skill's SKILL.md must be a real file"));
				continue;
			}
			if (!info.isFile()) {
				scanned.defects.push(defect$1("content-unsupported", "SKILL.md is not a regular file"));
				continue;
			}
			const bytes = await readBytes(directory, "SKILL.md", "SKILL.md", scanned.defects);
			if (bytes !== void 0) {
				scanned.skillMdSha256 = sha256Hex(bytes);
				try {
					const parsed = parseSkillFile(bytes.toString("utf8"), join(directory, "SKILL.md"));
					scanned.frontmatter = {
						name: parsed.name,
						description: parsed.description
					};
				} catch (error) {
					scanned.defects.push(defect$1("skill-file-invalid", message$5(error)));
				}
			}
			continue;
		}
		if (name === SKILL_SIDECAR_FILE) continue;
		if (SUPPORTED_SKILL_RESOURCE_DIRS.includes(name)) {
			if (info.isSymbolicLink()) {
				scanned.unsupported.push(`${name}/`);
				scanned.defects.push(defect$1("content-unsupported", `${name}/ is a symbolic link; a skill directory\'s entries must be real`));
				continue;
			}
			if (!info.isDirectory()) {
				scanned.unsupported.push(`${name}/`);
				scanned.defects.push(defect$1("content-unsupported", `${name} is not a directory`));
				continue;
			}
			let children;
			try {
				children = await readdir(at, { withFileTypes: true });
			} catch (error) {
				scanned.unsupported.push(`${name}/`);
				scanned.defects.push(defect$1("content-unsupported", `${name}/ cannot be read: ${message$5(error)}`));
				continue;
			}
			for (const child of children) {
				const relative$1 = `${name}/${child.name}`;
				let childInfo;
				try {
					childInfo = await lstat(join(at, child.name));
				} catch (error) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} cannot be read: ${message$5(error)}`));
					continue;
				}
				if (childInfo.isSymbolicLink()) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} is a symbolic link; a resource must be a real file`));
					continue;
				}
				if (childInfo.isDirectory()) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} is a directory nested deeper than the supported one-level shape (${name}/<file>)`));
					continue;
				}
				if (!childInfo.isFile()) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} is not a regular file`));
					continue;
				}
				const bytes = await readBytes(directory, relative$1, relative$1, scanned.defects);
				if (bytes === void 0) {
					scanned.unsupported.push(relative$1);
					continue;
				}
				if (!isText(bytes)) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} is not UTF-8 text; a supported resource is a text file a worker can read`));
					continue;
				}
				scanned.resources.push({
					path: relative$1,
					sha256: sha256Hex(bytes)
				});
			}
			continue;
		}
		if (info.isSymbolicLink()) {
			scanned.defects.push(defect$1("content-unsupported", `${name} is a symbolic link; a skill directory holds real entries only`));
			continue;
		}
		scanned.uncovered.push(info.isDirectory() ? `${name}/` : name);
	}
	scanned.resources.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	scanned.uncovered.sort();
	return scanned;
}
/**
* Load and check one skill directory: the directory itself, `SKILL.md`, the
* sidecar when there is one, the identity of the bytes on disk, and the shape
* of everything else in it.
*
* The returned `content` is the identity computed from the bytes just read —
* the same value a clean sidecar declares, and the honest answer for a skill
* that declares nothing. `defects` empty means the directory is fully described
* by its identity: every file is `SKILL.md`, the sidecar itself, or a supported
* resource the declaration names. Absence of a sidecar is not a defect: the
* skill is then guidance, not a provider.
*/
async function loadSkillSidecar(directory) {
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		return {
			directory,
			uncovered: [],
			defects: [defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message$5(error)}`)]
		};
	}
	if (info.isSymbolicLink()) return {
		directory,
		uncovered: [],
		defects: [defect$1("content-unsupported", `${directory} is a symbolic link; a skill directory must be a real directory`)]
	};
	if (!info.isDirectory()) return {
		directory,
		uncovered: [],
		defects: [defect$1("skill-missing", `${directory} is not a directory`)]
	};
	const scanned = await scanSkillDirectory(directory);
	const defects = [...scanned.defects];
	if (!scanned.skillMdPresent) defects.push(defect$1("skill-missing", `${join(directory, "SKILL.md")} does not exist; a skill directory carries a SKILL.md`));
	const content = scanned.skillMdSha256 === void 0 ? void 0 : {
		skillMdSha256: scanned.skillMdSha256,
		resources: scanned.resources
	};
	let sidecar;
	let sidecarBytes;
	try {
		const walked = await walkVerified(directory, SKILL_SIDECAR_FILE);
		if (!walked.missing) sidecarBytes = await readFile(walked.abs);
	} catch (error) {
		defects.push(defect$1("content-unsupported", `${SKILL_SIDECAR_FILE} cannot be read as a real file: ${message$5(error)}`));
	}
	if (sidecarBytes !== void 0) if (!isText(sidecarBytes)) defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not UTF-8 text`));
	else {
		let declared;
		try {
			declared = JSON.parse(sidecarBytes.toString("utf8"));
		} catch (error) {
			defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not readable JSON: ${message$5(error)}`));
		}
		if (declared !== void 0) {
			const declaredDefects = skillContractDefects(declared);
			defects.push(...contractDefects$1(declaredDefects));
			if (declaredDefects.length === 0) {
				const sidecarValue = declared;
				sidecar = sidecarValue;
				if (content !== void 0) defects.push(...contentDefects(sidecarValue.content, content, scanned.uncovered, scanned.unsupported));
			}
		}
	}
	return {
		directory,
		...sidecar === void 0 ? {} : { sidecar },
		...content === void 0 ? {} : { content },
		...scanned.frontmatter === void 0 ? {} : { frontmatter: scanned.frontmatter },
		uncovered: scanned.uncovered,
		defects
	};
}
/**
* Compare a declared identity with the bytes on disk: the declared `SKILL.md`
* digest, every declared resource, and — the other direction — every file the
* declaration does not name. A missing declared file or a changed byte is a
* `content-mismatch`; a file nobody declared is `content-unsupported`, because
* an identity that covers most of a directory is not an identity of it. A path
* the scan already refused for its shape is not counted again here.
*/
function contentDefects(declared, actual, uncovered, unsupported) {
	const defects = [];
	if (declared.skillMdSha256 !== actual.skillMdSha256) defects.push(defect$1("content-mismatch", `SKILL.md is not the declared content: declared ${declared.skillMdSha256}, read ${actual.skillMdSha256}`));
	const refused = (path) => unsupported.some((entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry);
	const actualResources = new Map(actual.resources.map((resource) => [resource.path, resource.sha256]));
	for (const declaredResource of declared.resources) {
		const read = actualResources.get(declaredResource.path);
		if (read === void 0) {
			if (refused(declaredResource.path)) continue;
			defects.push(defect$1("content-mismatch", `${declaredResource.path} is declared but missing from the skill directory`));
			continue;
		}
		if (read !== declaredResource.sha256) defects.push(defect$1("content-mismatch", `${declaredResource.path} is not the declared content: declared ${declaredResource.sha256}, read ${read}`));
	}
	const declaredPaths$1 = new Set(declared.resources.map((resource) => resource.path));
	for (const resource of actual.resources) if (!declaredPaths$1.has(resource.path)) defects.push(defect$1("content-unsupported", `${resource.path} is not covered by the declared identity; the identity must name every file in the skill directory`));
	for (const entry of uncovered) defects.push(defect$1("content-unsupported", `${entry} is not covered by the declared identity; a sidecar declares SKILL.md plus resources under ${SUPPORTED_SKILL_RESOURCE_DIRS.join("/, ")}/ only`));
	return defects;
}
/**
* The unified pre-check: one candidate provider against the deployment's
* verifier vocabulary and capability table (guide §2.3, S1-C item 3). Every
* entry — config load, provider replacement, candidate promotion — calls this,
* so `evolution_apply` is not the only defence and no entry can be the one that
* skipped it.
*
* Rules, in the order they are checked:
*
* 1. The directory exists, is a real directory, and is named after the skill.
* 2. The loader reads it: `SKILL.md`, the sidecar when present, the supported
*    resources, and every entry whose shape the contract does not support. The
*    declared content identity must equal the bytes read, and the `SKILL.md`
*    frontmatter must parse and declare the granted name — the same rule, and
*    the same words, the spawn's `readSkillFile` applies when it registers the
*    body.
* 3. A sidecar the caller supplied must be the one the directory carries.
* 4. An execution sidecar's `verifier.ref` must be a registered verifier, and
*    its `requiredTools` must be granted by the capabilities it declares it
*    serves (`mcp__<server>__<tool>` counts when the capability mounts that
*    server; the worker baseline is deliberately not counted — a capability
*    must grant what the provider it carries needs).
* 5. A knowledge sidecar is checked for content and carried as knowledge: it
*    never becomes an execution provider.
*
* The verdict is a value: all defects are collected, nothing is written, and a
* caller that only wants execution providers filters with
* {@link executionProviders}.
*/
async function validateSkillProvider(candidate, context) {
	const defects = [];
	const refuse = (directory$1) => ({
		valid: false,
		name: candidate.name,
		...directory$1 === void 0 ? {} : { directory: directory$1 },
		defects
	});
	if (candidate.directory === void 0) {
		defects.push(defect$1("skill-missing", `no directory was discovered for skill "${candidate.name}"; a provider without a SKILL.md on disk cannot be an execution provider`));
		return refuse(void 0);
	}
	const directory = candidate.directory;
	if (basename(directory) !== candidate.name) defects.push(defect$1("skill-name-mismatch", `skill "${candidate.name}" resolves to directory ${directory}, whose name is "${basename(directory)}"; a skill directory is named after the skill it holds`));
	const loaded = await loadSkillSidecar(directory);
	defects.push(...loaded.defects);
	const content = loaded.content;
	const frontmatter = loaded.frontmatter;
	if (frontmatter !== void 0 && frontmatter.name !== candidate.name) defects.push(defect$1("skill-name-mismatch", `skill file ${join(directory, "SKILL.md")} declares name "${frontmatter.name}" but the capability grants "${candidate.name}"`));
	if (candidate.sidecar !== void 0) {
		const suppliedDefects = skillContractDefects(candidate.sidecar);
		defects.push(...contractDefects$1(suppliedDefects));
		if (loaded.sidecar === void 0) defects.push(defect$1("sidecar-mismatch", `skill "${candidate.name}" was checked against a supplied sidecar, but ${join(directory, SKILL_SIDECAR_FILE)} holds none; a declaration must describe the directory it is validated against`));
		else if (suppliedDefects.length === 0 && skillContractDigest(loaded.sidecar) !== skillContractDigest(candidate.sidecar)) defects.push(defect$1("sidecar-mismatch", `the supplied sidecar for skill "${candidate.name}" is not the declaration in ${join(directory, SKILL_SIDECAR_FILE)}`));
	}
	const sidecar = loaded.sidecar ?? candidate.sidecar;
	if (sidecar === void 0) {
		if (defects.length > 0 || content === void 0 || frontmatter === void 0) return refuse(directory);
		return {
			valid: true,
			role: "guidance",
			name: candidate.name,
			directory,
			description: frontmatter.description,
			content,
			contentDigest: skillContentDigest(content),
			uncovered: loaded.uncovered
		};
	}
	if (sidecar.type === "execution") {
		if (!context.verifierRefs.includes(sidecar.verifier.ref)) {
			const registered = [...context.verifierRefs].sort();
			defects.push(defect$1("verifier-unknown", `skill "${candidate.name}" declares execution verifier ${JSON.stringify(sidecar.verifier.ref)}, which is not registered; registered verifiers: ${registered.length === 0 ? "none" : registered.join(", ")}`));
		}
		const tools = /* @__PURE__ */ new Set();
		const servers = /* @__PURE__ */ new Set();
		let grantComplete = true;
		for (const capability of sidecar.capabilities) {
			const answer = context.capabilityTools(capability);
			if (!answer.known) {
				grantComplete = false;
				defects.push(defect$1("capability-unknown", `skill "${candidate.name}" declares capability ${JSON.stringify(capability)}: ${answer.reason}`));
				continue;
			}
			for (const tool of answer.tools) tools.add(tool);
			for (const server of answer.mcpServers) servers.add(server);
		}
		if (grantComplete) {
			const uncoveredTools = sidecar.requiredTools.filter((tool) => !tools.has(tool) && ![...servers].some((server) => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length));
			if (uncoveredTools.length > 0) {
				const granted = [...tools].sort().join(", ");
				defects.push(defect$1("tool-not-covered", `skill "${candidate.name}" requires tools its declared capabilities do not grant: ${[...uncoveredTools].sort().map((tool) => JSON.stringify(tool)).join(", ")}; declared capabilities ${sidecar.capabilities.join(", ")} grant: ${granted}${servers.size === 0 ? "" : ` · mounted servers: ${[...servers].sort().join(", ")}`}`));
			}
		}
		if (defects.length > 0 || content === void 0 || frontmatter === void 0) return refuse(directory);
		return {
			valid: true,
			role: "execution-provider",
			name: candidate.name,
			directory,
			capabilities: [...sidecar.capabilities],
			precondition: sidecar.precondition,
			description: frontmatter.description,
			inputs: sidecar.inputs.map((port) => ({
				name: port.name,
				description: port.description,
				required: port.required
			})),
			outputs: sidecar.outputs.map((port) => ({
				name: port.name,
				description: port.description,
				required: port.required
			})),
			requiredTools: [...sidecar.requiredTools],
			verifierRef: sidecar.verifier.ref,
			contractDigest: skillContractDigest(sidecar),
			content,
			contentDigest: skillContentDigest(content)
		};
	}
	if (defects.length > 0 || content === void 0 || frontmatter === void 0) return refuse(directory);
	return {
		valid: true,
		role: "knowledge",
		name: candidate.name,
		directory,
		source: sidecar.source,
		scope: sidecar.scope,
		contentCheck: {
			kind: sidecar.contentCheck.kind,
			command: sidecar.contentCheck.command
		},
		description: frontmatter.description,
		contractDigest: skillContractDigest(sidecar),
		content,
		contentDigest: skillContentDigest(content)
	};
}
/**
* The registry revision: SHA-256 over {@link canonicalize} of the capability
* table (each row sorted by name, carrying its skills, the tool labels it
* declares, the DSH tool names those labels expand to, its preset, permission
* and MCP servers — defaults and declaration order normalized away) plus every
* provider's sidecar identity.
*
* What it covers, and what it deliberately does not: a run can cite this
* revision to say which table and which declared provider content it resolved
* against. Two runs with the same revision resolved the same rows over the same
* declared sidecar content. It does **not** cover the bytes of a skill that
* declares nothing (its identity is `null` here), the verifier registry's own
* revisions, or the deployment's environment — a caller that needs those records
* them separately rather than reading them into this digest.
*/
function registryRevision(capabilities, providers) {
	return sha256Hex(canonicalize({
		capabilities: Object.keys(capabilities).sort().map((name) => {
			const entry = capabilities[name];
			const answers = capabilityToolQuery(capabilities)(name);
			return {
				name,
				skills: [...new Set(entry.skills ?? [])].sort(),
				declaredTools: [...new Set(entry.tools ?? [])].sort(),
				tools: answers.known ? [...new Set(answers.tools)].sort() : [],
				mcpServers: answers.known ? [...new Set(answers.mcpServers)].sort() : [],
				...entry.preset === void 0 ? {} : { preset: entry.preset },
				...entry.permission === void 0 ? {} : { permission: entry.permission }
			};
		}),
		providers: providers.map((provider) => ({
			name: provider.name,
			contractDigest: provider.contractDigest
		})).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
	}));
}

//#endregion
//#region src/provider-precheck.ts
/**
* Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
* the soft pattern this repo uses for services a deployment may or may not
* mount (`verifier`, `sessionQuery`, `agents`): absent in test contexts and in
* smaller bundles, not an error.
*
* Both lookups are inside the `try` because cordis refuses a property read of a
* service the asking context does not have (`cannot get property "verifier"
* without inject`, `reflect.ts` — it throws instead of returning `undefined`).
* An optional service that is absent is exactly the case this function exists
* for, so the refusal is the answer: `undefined`.
*/
function optionalService(host, name) {
	if (host === null || typeof host !== "object") return void 0;
	const holder = host;
	try {
		const viaContext = typeof holder.get === "function" ? holder.get(name) : void 0;
		if (viaContext !== void 0) return viaContext;
		return holder[name];
	} catch {
		return;
	}
}
/**
* The registered verifier vocabulary a provider check judges execution sidecars
* against, or `undefined` when the deployment cannot list it — no verifier
* service, a service that never became ready, or a registry whose own read
* throws.
*
* `ready()` first, and only here: a verifier service that has been constructed
* but not readied reports an empty `verifierIds()`, and reading that as "no
* verifier is registered" would refuse every execution provider on a deployment
* whose registry is merely still loading. The distinction between "the registry
* could not answer" and "the registry answered: empty" is exactly what the
* returned `undefined` preserves: a caller refuses an execution sidecar in the
* first case (fail-closed, {@link unlistableVerifierRefusal}) and names the
* registry's own answer in the second.
*
* One implementation for every consumer — the admission pre-check, the
* load-time scan and the promotion checks all ask it (guide §2.4, S1-C item 3).
*/
async function registeredVerifierIds(host) {
	const verifier = optionalService(host, "verifier");
	if (verifier === void 0) return void 0;
	try {
		await verifier.ready?.();
		return verifier.verifierIds?.();
	} catch {
		return;
	}
}
/**
* The registered verifier vocabulary *and the version each instance declares*,
* or `undefined` under exactly the conditions {@link registeredVerifierIds}
* answers `undefined`. The two are read together by a caller that has to recall
* a verdict against the instance that produced it (the evolution promotion
* gate): an id list cannot tell a re-registered judge from the one that judged,
* and a version list read without the ids could name a judge that is gone.
*
* Registration is awaited once, then both halves are read from the same
* instance. A registry that implements `verifierIds()` but no
* `verifierVersions()` answers an empty map — "no version was declared", which
* is the truth for it, not a refusal.
*/
async function registeredVerifierVocabulary(host) {
	const verifier = optionalService(host, "verifier");
	if (verifier === void 0) return void 0;
	try {
		await verifier.ready?.();
		const ids = verifier.verifierIds?.();
		if (ids === void 0) return void 0;
		return {
			ids,
			versions: verifier.verifierVersions?.() ?? {}
		};
	} catch {
		return;
	}
}
/**
* The refusal of an execution sidecar the deployment cannot judge because its
* verifier vocabulary could not be listed: the declared ref is refused rather
* than assumed registered (fail-closed). The admission pre-check and the
* evolution promotion checks share this function, so one situation reads the
* same way in every entry instead of each inventing its own explanation.
*/
function unlistableVerifierRefusal(name, directory, ref) {
	return {
		valid: false,
		name,
		...directory === void 0 ? {} : { directory },
		defects: [defect("verifier-unknown", `skill "${name}" declares execution verifier ${JSON.stringify(ref)} but the verifier registry cannot be listed (verifierIds() is unavailable, so the registry was never readied); the ref is refused rather than assumed registered`)]
	};
}
/**
* Read the ledger's open commit intents, once per pre-check. `undefined` means
* this deployment offers no evolution service at all — no commit can be in
* flight, so no gate is applied. A ledger that cannot be read answers a gate
* that refuses by name instead.
*
* Every target is kept as the directory that holds it, never as the file path:
* the gate matches providers by directory ({@link commitRefusalFor}), so a
* ledger naming the sidecar of a two-file commit lands on the same entry as one
* naming its `SKILL.md`.
*/
async function readCommitGate(ledger) {
	if (ledger === void 0) return void 0;
	if (ledger.openIntentTargets === void 0) return {
		openTargets: /* @__PURE__ */ new Set(),
		unreadable: "the evolution service offers no openIntentTargets() read"
	};
	try {
		const targets = await ledger.openIntentTargets();
		return { openTargets: new Set(targets.map((target) => dirname(resolve(target)))) };
	} catch (error) {
		return {
			openTargets: /* @__PURE__ */ new Set(),
			unreadable: `reading it failed (${error instanceof Error ? error.message : String(error)})`
		};
	}
}
/**
* The refusal of a provider whose directory a commit left open (K2-3, matched by
* directory since K3): the intent is the record that a production write is
* underway and its completion has not been recorded, so production may not be
* what the ledger says it is. One intent covers a skill directory's fixed file
* set together, so a target naming any one of those files refuses the directory
* as a whole — the version standing beside it may be the other half of a mixed
* pair, which is not admissible either. The provider stays refused until a
* reconciliation settles that commit, and every other provider in the same
* pre-check is judged exactly as before.
*/
function openCommitRefusal(name, directory) {
	return {
		valid: false,
		name,
		directory,
		defects: [defect("commit-intent-open", `skill "${name}" is the target of an open evolution commit intent: a file of ${directory} was named by an apply or rollback, its intent was persisted and its completion was never recorded, so production may not hold the version the ledger describes. One intent covers the fixed file set of that directory together (\`SKILL.md\`, plus the \`SKILL.contract.json\` beside it when the skill has one), so a directory holding any file under an open intent is refused whole rather than admitted as a mixed version: the provider stays refused until a reconciliation settles that commit (the deployment reconciles at startup, or an apply/rollback retry settles it)`)]
	};
}
/**
* The refusal of every skill candidate on a deployment whose evolution ledger
* cannot be read: whether a commit intent is open against this provider cannot
* be established, so it is refused rather than assumed clear (fail-closed). The
* absence of an evolution service is a different situation and is not refused —
* a deployment with no ledger has no commit in flight.
*/
function unreadableCommitLedgerRefusal(name, directory, target, why) {
	return {
		valid: false,
		name,
		directory,
		defects: [defect("commit-ledger-unreadable", `skill "${name}" cannot be admitted against ${target}: the deployment's evolution commit ledger is unreadable (${why}), so whether a commit intent is open against this provider cannot be established — the provider is refused rather than assumed clear (fail-closed)`)]
	};
}
/**
* Every root one discovery view covers, in search order — the single root list
* the pre-check searches and the one a refusal names, so "searched the roots"
* in an error message is never a hand-written approximation of the search.
*/
async function skillSearchRoots(view = {}) {
	return [...view.extraRoots ?? [], ...await skillRootsFor(view.cwd)];
}
function defect(code, detail) {
	return {
		code,
		detail
	};
}
/**
* The refusal one skill candidate gets from the commit gate, or `undefined` when
* the gate has nothing to say about it: only a provider whose discovered
* directory holds a file an open commit names is refused, and every other
* candidate in the same pre-check is judged exactly as it would be without the
* gate.
*
* The comparison is by directory, not by file (K3): one commit intent covers the
* fixed file set of a skill directory together (`SKILL.md`, and the
* `SKILL.contract.json` beside it when the skill has one), so a ledger naming
* either file marks the same directory as owned by an unsettled commit. Matching
* file paths would admit a directory whenever the ledger reported the one file
* this check did not look at.
*/
function commitRefusalFor(gate, name, directory) {
	if (gate === void 0) return void 0;
	const skillFile = resolve(join(directory, "SKILL.md"));
	if (gate.unreadable !== void 0) return unreadableCommitLedgerRefusal(name, directory, skillFile, gate.unreadable);
	if (!gate.openTargets.has(resolve(directory))) return void 0;
	return openCommitRefusal(name, directory);
}
/** The search-failure refusal: the skill name and the roots, which no phase-1 validator can know. */
function undiscovered(name, roots) {
	return {
		valid: false,
		name,
		defects: [defect("skill-missing", `no SKILL.md for skill "${name}" is reachable from the worker's discovery roots; searched ${roots.join(", ")}`)]
	};
}
/**
* The one provider identity a revision can cite: a validated sidecar, or
* `null` for a skill that declares none. Guidance skills declare no execution
* contract, so they are cited as the name alone rather than given a digest
* that does not exist.
*/
function providerIdentity(verdict) {
	if (!verdict.valid) return void 0;
	return verdict.role === "guidance" ? {
		name: verdict.name,
		contractDigest: null
	} : {
		name: verdict.name,
		contractDigest: verdict.contractDigest
	};
}
/**
* Every provider content identity one pre-check resolved, deduplicated by name
* and sorted by it: the list a caller folds into whatever it records about the
* resolution (the registry revision here, the review context in
* `./proposal.ts`). One function so those two cannot disagree about what
* "resolved" means: refused verdicts contribute nothing (a refused provider is
* never something a run resolved against), and a name that appears in two rows
* is one identity.
*/
function providerContentIdentities(capabilities) {
	return capabilities.flatMap((row) => row.skills).flatMap((verdict) => providerIdentity(verdict) ?? []).filter((identity, index, all) => all.findIndex((entry) => entry.name === identity.name) === index).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
/**
* Check every skill every listed capability declares, from one discovery
* viewpoint.
*
* The rules, in the order they are applied per skill: it must be discoverable
* from the view's roots; no file of the directory it resolves into may be a
* target an evolution commit left open (K2, matched by directory since K3); the
* directory must pass {@link validateSkillProvider} against the table and the
* verifier vocabulary. An execution sidecar is refused when the vocabulary is
* unknown (`verifierRefs` absent) — the one case the phase-1 validator cannot
* judge, because it would read an empty list as "nothing is registered".
*
* Nothing is written and nothing is thrown: every refusal is a verdict, and
* {@link providerRefusals} turns the refusals into the lines a caller reports
* before it refuses the whole batch. The commit gate is read once per call and
* only refusals — nothing here reconciles, so asking an admission question
* never settles a commit as a side effect.
*/
async function precheckProviders(request) {
	const roots = await skillSearchRoots(request.view);
	const verifierRefs = request.verifierRefs;
	const context = skillValidationContext(request.table, verifierRefs ?? []);
	const commitGate = await readCommitGate(request.commitLedger);
	const capabilities = [];
	for (const capability of request.capabilities) {
		const declared = request.table[capability]?.skills ?? [];
		const skills = [];
		for (const name of [...new Set(declared)]) {
			const file = await findSkillFileIn(roots, name);
			if (file === void 0) {
				skills.push(undiscovered(name, roots));
				continue;
			}
			const directory = dirname(file);
			const commitRefusal = commitRefusalFor(commitGate, name, directory);
			if (commitRefusal !== void 0) {
				skills.push(commitRefusal);
				continue;
			}
			if (verifierRefs === void 0) {
				const loaded = await loadSkillSidecar(directory);
				if (loaded.sidecar?.type === "execution") {
					skills.push(unlistableVerifierRefusal(name, directory, loaded.sidecar.verifier.ref));
					continue;
				}
			}
			skills.push(await validateSkillProvider({
				name,
				directory
			}, context));
		}
		capabilities.push({
			capability,
			skills
		});
	}
	const providers = providerContentIdentities(capabilities);
	return {
		capabilities,
		roots,
		...verifierRefs === void 0 ? {} : { verifierRefs: [...verifierRefs] },
		revision: registryRevision(request.table, providers)
	};
}
/**
* One capability row as it would read after a replacement, checked by the same
* pre-check a batch is admitted under: `entry` is folded into `table` — the row
* as `config.yml` will hold it once written — and every skill the new row grants
* is discovered from `view` and judged by {@link validateSkillProvider}, with
* the row's own tool labels expanding through `resolveCapabilities` as the
* covering set for a skill that declares this row.
*
* The two entries that write a row share this function, so the run-time registry
* mirror (`TaskRuntime.applyCapabilityRow`) asks exactly the question the
* promotion gate (`EvolutionService.checkPromotion`) asked before the row
* reached `config.yml`: one composition, one vocabulary of refusals, no entry
* that can be replaced without being judged. `refusals` is empty for a row that
* grants no skill or only loadable providers.
*/
async function precheckReplacedCapabilityRow(request) {
	const precheck = await precheckProviders({
		capabilities: [request.name],
		table: {
			...request.table,
			[request.name]: request.entry
		},
		view: request.view,
		...request.verifierRefs === void 0 ? {} : { verifierRefs: request.verifierRefs },
		...request.commitLedger === void 0 ? {} : { commitLedger: request.commitLedger }
	});
	return {
		precheck,
		refusals: providerRefusals(precheck)
	};
}
/**
* The head every refusal line shares: the capability that declares the skill,
* the skill itself, and the directory discovery found (when it found one).
* One function, so the two renderings below can never describe the same refusal
* differently.
*/
function refusalHead(capability, verdict) {
	const where = verdict.directory === void 0 ? "" : ` (found at ${verdict.directory})`;
	return `capability ${JSON.stringify(capability)} skill ${JSON.stringify(verdict.name)}${where}`;
}
/**
* Every refused provider of one pre-check, one line each, naming the capability
* that declares it, the skill, the directory when one was found, and every
* defect with its code. Empty means the batch may proceed — which is a
* statement about *loadable* providers only: this pre-check never adds a
* capability to the closure, and knowledge/guidance verdicts are loadable
* without being execution providers.
*/
function providerRefusals(precheck) {
	return precheck.capabilities.flatMap((row) => row.skills.filter((verdict) => !verdict.valid).map((verdict) => `${refusalHead(row.capability, verdict)}: ${verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")}`));
}
/**
* The same refusals, one line per defect: the shape a loud report wants, since
* a caller reading a log needs the capability, the skill, the defect code and
* the detail of each problem rather than a summary line per provider. The
* load-time scan (`TaskRuntime.providerLoadReport`) prints these; admission
* refuses a batch on {@link providerRefusals}.
*/
function providerDefectLines(precheck) {
	return precheck.capabilities.flatMap((row) => row.skills.filter((verdict) => !verdict.valid).flatMap((verdict) => verdict.defects.map((item) => `${refusalHead(row.capability, verdict)}: ${item.code}: ${item.detail}`)));
}

//#endregion
//#region src/root-budget.ts
/**
* Whether a root budget enforces anything at all. The configuration's schema
* materializes an absent `rootBudget` as an empty object, so the presence of an
* object is not the question a refusal may ask: a budget with no member in force
* is no budget, and an entry that refuses work over an unmeasurable tree would
* otherwise refuse it for a limit this deployment never set. Every refusal that
* is "a configured limit cannot be measured" asks this first.
*/
function hasRootLimits(config) {
	return config !== void 0 && (config.wallTimeMs !== void 0 || config.maxRuns !== void 0 || config.maxConcurrentWrites !== void 0);
}
function instant(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* The root budget a snapshot is under, or the reason none can be measured.
*
* The owner is the store's own root: among the parentless tasks, the one whose
* run is bound to the root session the store id derives from
* (`rootTaskStoreId`) — the same durable rule the recovery path uses to tell a
* store's own root run apart from a replay's. A replay's task is parentless by
* design and carries no such binding (its session is minted for the replay), so
* it shares the root's total instead of claiming a budget of its own (§3.5, the
* funding-root reference); inventing one for it would hand every experiment a
* fresh allowance. No run naming a root session of this store means no owner,
* and the store keeps the honest recovery diagnostic rather than a guess.
*
* `reason` texts are recovery diagnostics: they say what is missing (no root,
* no run bound to this store as its root, several such tasks, a root run with
* no readable start) so an operator reading `task_status` knows why the tree
* cannot be started under a budget instead of being handed a fabricated one.
*/
function resolveRootBudget(snapshot, config) {
	const roots = snapshot.tasks.filter((task) => task.parentTaskId === void 0);
	if (roots.length === 0) return {
		ok: false,
		reason: `store ${snapshot.id} holds no root task (no task without a parentTaskId), so no budget owner exists; a budget is rooted in the store's own tree`
	};
	const owners = roots.filter((task) => boundRunOf(snapshot, task) !== void 0);
	if (owners.length === 0) {
		if (roots.length === 1 && snapshot.runs.every((run) => run.taskId !== roots[0].taskId)) return {
			ok: false,
			reason: `root task ${roots[0].taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it`
		};
		const named = roots.map((task) => {
			const sessions = snapshot.runs.filter((run) => run.taskId === task.taskId).map((run) => run.sessionId);
			return `${task.taskId}${sessions.length === 0 ? "" : ` (session ${sessions.join(", ")})`}`;
		});
		return {
			ok: false,
			reason: `store ${snapshot.id} holds ${roots.length === 1 ? "a parentless task" : `${roots.length} parentless tasks`} ${named.join(", ")}, and none of their runs names this store's root session (a root run is bound to the session the store id ${snapshot.id} derives from, rootTaskStoreId), so no budget owner exists; a replay's parentless task shares the root's total and never claims one of its own`
		};
	}
	if (owners.length > 1) return {
		ok: false,
		reason: `store ${snapshot.id} holds ${owners.length} tasks bound to this store as its root (${owners.map((task) => task.taskId).join(", ")}), so no single budget owner exists; one store carries one tree, and a budget cannot be split over several`
	};
	const root = owners[0];
	const first = firstRun(snapshot, root, snapshot.id);
	if (first === void 0) return {
		ok: false,
		reason: `root task ${root.taskId} has no run recorded, so its budget has no start instant; a restart time is not a substitute for the run that accepted it`
	};
	const acceptedAtMs = instant(first.startedAt);
	if (acceptedAtMs === void 0) return {
		ok: false,
		reason: `root task ${root.taskId}'s first run ${first.runId} records no readable startedAt (${JSON.stringify(first.startedAt)}), so the tree has no honest start instant and is not given a fresh one`
	};
	return {
		ok: true,
		rootTaskId: root.taskId,
		acceptedAt: first.startedAt,
		...config.wallTimeMs === void 0 ? {} : { deadlineAt: new Date(acceptedAtMs + config.wallTimeMs).toISOString() },
		...config.maxRuns === void 0 ? {} : { maxRuns: config.maxRuns }
	};
}
/** The run of `task` that is bound to `storeId` as a root run, or `undefined` when the task holds none. */
function boundRunOf(snapshot, task) {
	return snapshot.runs.find((run) => run.taskId === task.taskId && rootTaskStoreId(run.sessionId) === snapshot.id);
}
/** The root's first run: the run its own `runIds` names first, among the runs bound to this store as its root. */
function firstRun(snapshot, task, storeId) {
	const bound = snapshot.runs.filter((run$1) => run$1.taskId === task.taskId && rootTaskStoreId(run$1.sessionId) === storeId);
	const run = (task.runIds.length > 0 ? bound.find((run$1) => run$1.runId === task.runIds[0]) : void 0) ?? bound[0];
	return run === void 0 ? void 0 : {
		runId: run.runId,
		startedAt: run.startedAt
	};
}
/**
* Whether a run may start under the budget. Two refusals, in this order: the run
* count has reached `maxRuns` (the limit is a count of what the store already
* holds, so a restart cannot refund it), or the root deadline has arrived.
*/
function checkRunStart(snapshot, budget, nowMs = Date.now()) {
	if (budget.maxRuns !== void 0 && snapshot.runs.length >= budget.maxRuns) return {
		allowed: false,
		reason: `the root budget allows ${budget.maxRuns} run(s) for root ${budget.rootTaskId} and the store already holds ${snapshot.runs.length}; the limit counts recorded runs so it cannot be reset by a restart`
	};
	const deadline = instant(budget.deadlineAt);
	if (deadline !== void 0 && nowMs >= deadline) return {
		allowed: false,
		reason: `root ${budget.rootTaskId}'s deadline ${budget.deadlineAt} has passed (accepted at ${budget.acceptedAt}), so no new run starts under this budget`
	};
	return { allowed: true };
}
/**
* Whether a decomposition batch of `childCount` children may be admitted. The
* check is a reservation, not a forecast: the children will each start a run, so
* a batch that would push the tree past `maxRuns` is refused whole — before a
* task, a child or an event exists — rather than admitted and then started until
* the budget runs out mid-batch.
*/
function checkBatchAdmission(snapshot, budget, childCount) {
	if (budget.maxRuns === void 0) return { allowed: true };
	const total = snapshot.runs.length + childCount;
	if (total > budget.maxRuns) return {
		allowed: false,
		reason: `a batch of ${childCount} child task(s) would need ${childCount} run slot(s) and the root budget allows ${budget.maxRuns} run(s) in total, of which ${snapshot.runs.length} are already recorded (${total} > ${budget.maxRuns}); the batch is refused whole, with no side effects`
	};
	return { allowed: true };
}
/**
* What is left of the tightest deadline that applies to a run, in milliseconds.
*
* `min` semantics over the bounds that can be in force: the run's own wall time
* measured from its persisted `startedAt` (so a resumed run keeps the clock it
* started with) and what is left of the root's deadline. A bound that has passed
* returns 0 rather than a negative number, and `Infinity` means no bound at all
* is configured.
*
* A bound whose instant cannot be read is treated as *reached* (`0`): a start
* time nobody can parse is not a licence to run without a deadline, which is the
* same discipline `resolveRootBudget` applies to a missing root start.
*/
function runDeadlineMs(runStartedAt, perRunWallTimeMs, rootDeadlineAt, nowMs) {
	const parts = [];
	if (perRunWallTimeMs !== void 0) {
		const started = instant(runStartedAt);
		parts.push(started === void 0 ? 0 : Math.max(0, started + perRunWallTimeMs - nowMs));
	}
	if (rootDeadlineAt !== void 0) {
		const deadline = instant(rootDeadlineAt);
		parts.push(deadline === void 0 ? 0 : Math.max(0, deadline - nowMs));
	}
	return parts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...parts);
}
/**
* How many entries one task's subtree holds — the progress measure the
* no-progress rule counts. The subtree is the task itself plus everything
* reachable through `childTaskIds` (a cycle is walked once), and each collection
* is filtered by the side of the relation that names a task in it: runs by their
* `taskId`, edges by either end, evidence/reviews/diagnoses by `taskId`,
* handoffs by either `parentTaskId` or `childTaskId`, obligations by
* `sourceTaskId`. The count is of *entries*: an id in the subtree with no task
* record contributes no task entry, while its runs, edges and evidence still
* count, because those entries exist and name it.
*
* Pure: the same snapshot always yields the same count, so a reviewer can
* recompute it without replaying anything.
*/
function countSubtreeFacts(snapshot, taskId) {
	const subtree = new Set([taskId]);
	const pending = [taskId];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const child of snapshot.tasks.find((task) => task.taskId === current)?.childTaskIds ?? []) {
			if (subtree.has(child)) continue;
			subtree.add(child);
			pending.push(child);
		}
	}
	const inSubtree = (id) => subtree.has(id);
	return snapshot.tasks.filter((task) => inSubtree(task.taskId)).length + snapshot.runs.filter((run) => inSubtree(run.taskId)).length + snapshot.edges.filter((edge) => inSubtree(edge.from) || inSubtree(edge.to)).length + snapshot.evidence.filter((bundle) => inSubtree(bundle.taskId)).length + snapshot.handoffs.filter((handoff) => inSubtree(handoff.parentTaskId) || inSubtree(handoff.childTaskId)).length + snapshot.reviews.filter((review) => inSubtree(review.taskId)).length + snapshot.diagnoses.filter((diagnosis) => inSubtree(diagnosis.taskId)).length + snapshot.obligations.filter((obligation) => inSubtree(obligation.sourceTaskId)).length;
}
/**
* Refuse a root budget this deployment cannot execute. The one such limit is
* `maxConcurrentWrites`: the workspace registry enforces exactly one writer, so
* a configuration asking for any other number is a hard limit nobody can honor —
* and §3.5's rule is that asking for an unenforceable hard limit refuses to
* start rather than starting under a limit that is not real. Everything else
* about the shape (unknown members, negative values) is the Config schema's
* business, checked where the configuration is loaded.
*/
function assertRootBudgetConfig(config) {
	if (config.maxConcurrentWrites !== void 0 && config.maxConcurrentWrites !== 1) throw new Error(`rootBudget.maxConcurrentWrites is ${config.maxConcurrentWrites}: this deployment enforces exactly 1 concurrent writer per workspace, so it cannot honor another number and refuses to start rather than run under a limit it cannot execute`);
}

//#endregion
//#region src/run-binding.ts
/** The directory under one run's own directory that holds its `<name>/SKILL.md` entries — a skill root as `WorkerGrant.skillRoots` expects. */
const RUN_BINDING_SKILLS_DIR = "skills";
/**
* Where run bindings are materialized unless the deployment says otherwise:
* `<DSH_HOME or ~/.dsh>/singularity/run-bindings`, resolved per call so a test
* (or a deployment) that moves `DSH_HOME` moves the snapshots with it.
*
* Outside the worker's checkout on purpose: the run's cwd is where a worker
* writes, and content it can rewrite under itself would make "the worker loaded
* the bound bytes" unverifiable. A snapshot is re-checked against its digest on
* every read, so even a writer that reaches it cannot make it pass for
* something else — but the ordinary case should not depend on that.
*/
function defaultRunBindingRoot() {
	return join(process.env.DSH_HOME !== void 0 && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"), "singularity", "run-bindings");
}
function message$4(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The identity one accepted verdict contributes to a run's record. */
function skillBinding(provider) {
	const { verdict, capabilities } = provider;
	return {
		name: verdict.name,
		role: verdict.role,
		capabilities: [...capabilities],
		description: verdict.description,
		contractDigest: verdict.role === "guidance" ? null : verdict.contractDigest,
		contentDigest: verdict.contentDigest,
		uncovered: verdict.role === "guidance" ? [...verdict.uncovered] : []
	};
}
/**
* The providers one run selects: every accepted verdict of the run's own rows,
* one entry per skill name, carrying the rows that grant it.
*
* A row whose declared skill has no accepted verdict is a refusal, not a
* partial selection: such a skill would be resolved by discovery at spawn —
* exactly the mutable production path this module exists to close — so the run
* fails rather than loading bytes nothing judged. (Admission already refuses
* such a batch; this is the same rule where the run is created, so a caller
* that hands the cascade its own pre-check cannot slip past it.)
*/
function selectedProviders(providers, rows, declaredBy) {
	if (providers === void 0) return [];
	const accepted = /* @__PURE__ */ new Map();
	const refused = /* @__PURE__ */ new Map();
	for (const row of providers.capabilities) {
		if (!rows.includes(row.capability)) continue;
		for (const verdict of row.skills) {
			if (!verdict.valid) {
				refused.set(verdict.name, [...refused.get(verdict.name) ?? [], ...verdict.defects]);
				continue;
			}
			const existing = accepted.get(verdict.name);
			if (existing === void 0) accepted.set(verdict.name, {
				verdict,
				capabilities: new Set([row.capability])
			});
			else existing.capabilities.add(row.capability);
		}
	}
	const missing = [...new Set(rows.flatMap((row) => declaredBy(row)))].filter((name) => !accepted.has(name));
	if (missing.length > 0) {
		const why = missing.map((name) => refused.has(name) ? `"${name}" (${refused.get(name).map((defect$2) => `${defect$2.code}: ${defect$2.detail}`).join("; ")})` : `"${name}" (no verdict was taken for it)`);
		throw new Error(`the pre-check this run was admitted with holds no accepted provider for skill${missing.length > 1 ? "s" : ""} ${why.join(", ")}; a run loads only content its admission judged, so it cannot be started against an unjudged skill`);
	}
	return [...accepted.entries()].map(([, entry]) => ({
		verdict: entry.verdict,
		capabilities: [...entry.capabilities].sort()
	})).sort((left, right) => left.verdict.name < right.verdict.name ? -1 : left.verdict.name > right.verdict.name ? 1 : 0);
}
/** The granted MCP servers' identity: the registry key and the template it resolved to, or `null` when the registry holds no such key. */
function mcpServerBindings(manifest, registry) {
	const names = [];
	for (const entry of Object.values(manifest.capabilities)) for (const name of entry.mcpServers ?? []) if (!names.includes(name)) names.push(name);
	return names.map((serverName) => {
		const template = registry[serverName];
		return {
			serverName,
			templateDigest: template === void 0 ? null : sha256Hex(canonicalize(template))
		};
	});
}
/**
* Copy one selected provider's admitted bytes into the run's snapshot.
*
* Every file is read through the verified walk (a link or a wrong type anywhere
* on the path is refused, never followed) and hashed against the identity the
* pre-check recorded before it is written, and the sidecar is carried verbatim
* after its own digest and shape are checked — the declaration a reader sees in
* the snapshot is the declaration the provider was validated against, not a
* fresh parse that could differ.
*/
async function materializeProvider(provider, snapshotRoot, runId) {
	const { verdict } = provider;
	const target = join(snapshotRoot, verdict.name);
	await mkdir(target, { recursive: true });
	const files = [{
		rel: "SKILL.md",
		sha256: verdict.content.skillMdSha256
	}, ...verdict.content.resources.map((resource) => ({
		rel: resource.path,
		sha256: resource.sha256
	}))];
	for (const file of files) {
		let bytes;
		try {
			bytes = await readVerifiedFile(verdict.directory, file.rel);
		} catch (error) {
			throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message$4(error)}`);
		}
		const read = sha256Hex(bytes);
		if (read !== file.sha256) throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${file.rel} at ${verdict.directory} is not the admitted content (admitted ${file.sha256}, read ${read}); the provider changed after it was judged`);
		const at = join(target, file.rel);
		await mkdir(dirname(at), { recursive: true });
		await writeFile(at, bytes);
	}
	if (verdict.role === "guidance") return;
	let sidecarBytes;
	try {
		sidecarBytes = await readVerifiedFile(verdict.directory, SKILL_SIDECAR_FILE);
	} catch (error) {
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message$4(error)}`);
	}
	let declared;
	try {
		declared = JSON.parse(sidecarBytes.toString("utf8"));
	} catch (error) {
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${SKILL_SIDECAR_FILE} is not readable JSON: ${message$4(error)}`);
	}
	const defects = skillContractDefects(declared);
	if (defects.length > 0) throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": the declaration in ${verdict.directory} is not a valid sidecar (${defects.map((item) => `${item.code}: ${item.reason}`).join("; ")})`);
	const digest = skillContractDigest(declared);
	if (digest !== verdict.contractDigest) throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": the declaration in ${verdict.directory} is not the one it was judged against (judged ${verdict.contractDigest}, read ${digest})`);
	await writeFile(join(target, SKILL_SIDECAR_FILE), sidecarBytes);
}
/**
* Bind one run's content: identify the providers its admission judged,
* materialize their admitted bytes, and verify the snapshot against the record
* before it is handed back to be stored.
*
* Returns `undefined` for a run that has capability rows but no pre-check — a
* caller that assembled its plan itself. Such a run's grant resolves its skills
* at spawn through the deployment's own discovery, which is exactly the mutable
* path this module exists to close, so **nothing is claimed**: the run records no
* binding at all rather than a record that looks authoritative and describes
* bytes nobody judged. Every production entry runs the pre-check, so this is the
* hand-built-caller case only.
*
* Throws — with the skill or the path named — when the admitted bytes are no
* longer there, when the deployment cannot materialize at all, or when the
* snapshot does not read back as the record describes it. A throw means the run
* records no binding and loads no content: there is no state in which a run
* claims content it did not load.
*/
async function bindRunProviders(request) {
	const rows = Object.keys(request.manifest.capabilities);
	if (request.providers === void 0 && rows.length > 0) return void 0;
	const selected = selectedProviders(request.providers, rows, (row) => request.manifest.capabilities[row]?.skills ?? []);
	const base = {
		registryRevision: request.providers?.revision ?? registryRevision(request.table ?? {}, []),
		capabilities: [...rows].sort(),
		skills: selected.map(skillBinding),
		mcpServers: mcpServerBindings(request.manifest, request.mcpRegistry ?? MCP_SERVER_REGISTRY)
	};
	if (selected.length === 0) return base;
	const root = request.root;
	if (root === void 0) throw new Error(`run "${request.runId}" selects skills [${selected.map((provider) => provider.verdict.name).join(", ")}] but this deployment configures no run binding root (\`Config.runBindingRoot\`); without one the run cannot load content it was admitted against`);
	const runDirectory = join(root, request.storeId, request.runId);
	const snapshotRoot = join(runDirectory, RUN_BINDING_SKILLS_DIR);
	await mkdir(dirname(runDirectory), { recursive: true });
	try {
		await mkdir(runDirectory);
	} catch (error) {
		throw new Error(`run "${request.runId}" cannot bind content: ${runDirectory} already exists (${message$4(error)}); a run materializes once`);
	}
	try {
		for (const provider of selected) await materializeProvider(provider, snapshotRoot, request.runId);
	} catch (error) {
		await rm(runDirectory, {
			recursive: true,
			force: true
		});
		throw error;
	}
	const binding = {
		...base,
		snapshotRoot
	};
	const read = await readRunBinding(binding);
	if (read !== void 0 && read.defects.length > 0) {
		await rm(runDirectory, {
			recursive: true,
			force: true
		});
		throw new Error(`run "${request.runId}" cannot bind content: the snapshot it just wrote does not read back as the record describes it:\n- ${read.defects.join("\n- ")}`);
	}
	return binding;
}
/**
* Re-check one run's binding against the bytes its snapshot holds now — the read
* a later reader (an old run's summary, a re-entry, a recovery path) performs
* before trusting the record.
*
* The check is the loader the pre-check uses, so "the snapshot is the admitted
* content" is judged by the same rules that admitted it: the `SKILL.md` and the
* declared resources must hash to the recorded content identity, the sidecar to
* the recorded contract identity, the frontmatter must declare the skill's own
* name, and the snapshot root must hold exactly the recorded skills — an extra
* directory would be registered into a worker's layer, so it is reported rather
* than ignored.
*
* One more thing is re-read for a guidance skill: the loader names the entries
* of its directory that the content identity does not cover (the same list
* admission recorded as `uncovered`), and a snapshot must hold its bound content
* only. An entry that appeared there since admission is therefore reported with
* its name — the record described a directory that does not match these bytes —
* while an entry the record lists as uncovered and absent from the snapshot is
* simply a correct snapshot: materialization copies the identity's files, so a
* source directory's uncovered entries never reach a run.
*
* Returns `undefined` for a record that names no snapshot: a run that loaded no
* content (a deterministic criteria replay, a run with no provider) has nothing
* to re-read, which is not the same as content that failed to re-read.
*/
async function readRunBinding(binding) {
	const root = binding.snapshotRoot;
	if (root === void 0) return void 0;
	const skills = [];
	const rootDefects = [];
	const recorded = new Set(binding.skills.map((skill) => skill.name));
	let entries;
	try {
		entries = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name);
	} catch (error) {
		entries = [];
		rootDefects.push(`${root} cannot be read: ${message$4(error)}; the content this run was bound to is not available`);
	}
	for (const name of entries) if (!recorded.has(name)) rootDefects.push(`${join(root, name)} is not a skill this run's record names; a worker's skill layer would register it, so it is reported rather than ignored`);
	for (const skill of binding.skills) {
		const loaded = await loadSkillSidecar(join(root, skill.name));
		const defects = loaded.defects.map((defect$2) => `${defect$2.code}: ${defect$2.detail}`);
		if (loaded.content === void 0) {
			if (defects.length === 0) defects.push(`skill-missing: ${join(root, skill.name)} holds no readable SKILL.md`);
		} else {
			const digest = skillContentDigest(loaded.content);
			if (digest !== skill.contentDigest) defects.push(`content-mismatch: ${join(root, skill.name, "SKILL.md")} and its resources are not the bound content: bound ${skill.contentDigest}, read ${digest}`);
			if (loaded.frontmatter === void 0 && defects.length === 0) defects.push(`skill-file-invalid: ${join(root, skill.name, "SKILL.md")} declares no frontmatter a worker could load`);
			else if (loaded.frontmatter !== void 0 && loaded.frontmatter.name !== skill.name) defects.push(`skill-name-mismatch: skill file ${join(root, skill.name, "SKILL.md")} declares name "${loaded.frontmatter.name}" but the record binds "${skill.name}"`);
			const declared = loaded.sidecar === void 0 ? null : skillContractDigest(loaded.sidecar);
			if (declared !== skill.contractDigest) defects.push(`sidecar-mismatch: the declaration in ${join(root, skill.name)} is not the one the run was bound to: bound ${skill.contractDigest ?? "none"}, read ${declared ?? "none"}`);
			if (skill.role === "guidance" && loaded.sidecar === void 0) for (const entry of [...loaded.uncovered].sort()) {
				const noted = skill.uncovered.includes(entry) ? "; this run's record lists it as uncovered in the source skill, and a snapshot carries bound content only" : "";
				defects.push(`content-mismatch: ${join(root, skill.name)} holds ${JSON.stringify(entry)}, which the content identity this run is bound to does not cover${noted}`);
			}
		}
		skills.push({
			name: skill.name,
			role: skill.role,
			readable: defects.length === 0,
			defects
		});
	}
	return {
		snapshotRoot: root,
		skills,
		defects: [...rootDefects, ...skills.flatMap((skill) => skill.defects.map((defect$2) => `skill "${skill.name}": ${defect$2}`))]
	};
}

//#endregion
//#region src/normalize.ts
/**
* The identity one batch is digested over (§4): where it came from, which
* contract language it is written in, the caller's reason, and the complete
* ordered children — each child reduced to its contract digest and the batch
* facts the identity covers.
*
* One construction, shared by {@link normalizeDecomposition} (which digs the
* batch) and by any writer that has to *name* the batch rather than digest it
* (the runtime's proposal record, whose `proposalDigest` has to be the same
* number the admission recorded). Two constructions of one identity would
* eventually disagree, and a proposal whose digest is not the batch's would
* make every approval binding meaningless.
*/
function decompositionIdentity(context, reason, children) {
	return {
		contractVersion: TASK_CONTRACT_VERSION,
		storeId: context.storeId,
		parentTaskId: context.parentTaskId,
		parentRunId: context.parentRunId,
		callerSessionId: context.callerSessionId,
		reason,
		children: children.map((child) => ({
			contractDigest: contractDigest(child.contract),
			dependsOn: child.dependsOn,
			decomposable: child.decomposable,
			requiresIndependentAcceptance: child.requiresIndependentAcceptance
		}))
	};
}
/** The batch fields, and nothing else: a key outside this set is refused. */
const BATCH_FIELDS = new Set([
	"contractVersion",
	"reason",
	"children"
]);
/** The child fields, and nothing else. */
const CHILD_FIELDS = new Set([
	"objective",
	"acceptanceCriteria",
	"requiredCapabilities",
	"dependsOn",
	"assumptions",
	"constraints",
	"decomposable",
	"requiresIndependentAcceptance"
]);
/** The criterion fields, and nothing else. */
const CRITERION_FIELDS = new Set([
	"criterionId",
	"description",
	"command",
	"mode",
	"mandatory",
	"requiredEvidence",
	"requiresArtifact",
	"acceptsArtifact",
	"verifierRef",
	"childEvidence",
	"heuristic",
	"protectedInputs"
]);
function message$3(error) {
	return error instanceof Error ? error.message : String(error);
}
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** Non-blank text: the one check every string field shares. */
function nonBlank(value) {
	return typeof value === "string" && value.trim().length > 0;
}
/** A declared version value, rendered so a non-number cannot read like a number (`"1"` is not `1`). */
function declaredText(value) {
	return typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);
}
/**
* A deep copy of declared contract data: primitives are immutable, arrays and
* plain objects are rebuilt, so a caller mutating its input afterwards cannot
* reach the normalized contract. Anything else is passed through unchanged — a
* value no canonical form can carry is refused by the digest below, never
* silently rewritten.
*/
function copyValue(value) {
	if (Array.isArray(value)) return value.map((item) => copyValue(item));
	if (isPlainObject(value)) {
		const copy = {};
		for (const [key, item] of Object.entries(value)) copy[key] = copyValue(item);
		return copy;
	}
	return value;
}
/** Report every key a level does not declare. */
function unknownFields(source, allowed, label, reasons) {
	for (const key of Object.keys(source)) if (!allowed.has(key)) reasons.push(`${label} declares unknown field ${JSON.stringify(key)}`);
}
/** A required text field; a blank or non-string value is refused with the field named. */
function text(value, label, reasons) {
	if (!nonBlank(value)) {
		reasons.push(`${label} must be a non-empty string`);
		return "";
	}
	return value;
}
/**
* A declared string collection: copied verbatim when it holds nothing but
* non-blank strings, refused as one defect otherwise — a blank entry is
* refused, not trimmed, and an omitted collection is the caller's `[]`.
*/
function stringList(value, label, reasons) {
	if (!Array.isArray(value) || value.some((item) => !nonBlank(item))) {
		reasons.push(`${label} must be an array of non-empty strings`);
		return [];
	}
	return value.map((item) => item);
}
/**
* A `dependsOn` list: integers only, copied verbatim. Whether an index is in
* range, points at itself, or closes a cycle is admission's judgement — it
* needs the whole batch, which this entry never sees as a graph.
*/
function integerList(value, label, reasons) {
	if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
		reasons.push(`${label} must be an array of integers`);
		return [];
	}
	return value.map((item) => item);
}
/** A boolean declaration: absent keeps the designed default, anything else is refused. */
function booleanField(value, fallback, label, reasons) {
	if (value === void 0) return fallback;
	if (typeof value !== "boolean") {
		reasons.push(`${label} must be a boolean`);
		return fallback;
	}
	return value;
}
/**
* A value carried as declared. `command` and the P4 declarations are judged by
* admission, so this entry only copies them: a shape those rules refuse never
* reaches the store, and the cast is the boundary that says so.
*/
function carried(value) {
	return copyValue(value);
}
/**
* One criterion list. Ids are fixed here — a declared id verbatim, an absent
* one from `idOf` — because the digest must not depend on spellings and because
* a parent-level `childEvidence.criterionId` can only point at an id that was
* fixed before its parent's criteria were accepted.
*
* A criterion that carried a defect is left out of the returned list: the batch
* is refused as a whole, and the contract must describe only what a well-formed
* declaration asked for.
*/
function normalizeCriteria(raw, label, idOf, reasons) {
	const criteria = [];
	const seen = /* @__PURE__ */ new Set();
	const reportedDuplicate = /* @__PURE__ */ new Set();
	raw.forEach((value, index) => {
		const before = reasons.length;
		const position = `${label} criterion ${index + 1}`;
		if (!isPlainObject(value)) {
			reasons.push(`${position} must be an object`);
			return;
		}
		const declaredId = value.criterionId;
		if (declaredId !== void 0 && !nonBlank(declaredId)) reasons.push(`${position} criterionId must be a non-empty string`);
		const criterionId = nonBlank(declaredId) ? declaredId : idOf(index);
		const criterionLabel$1 = `${label} criterion ${JSON.stringify(criterionId)}`;
		unknownFields(value, CRITERION_FIELDS, criterionLabel$1, reasons);
		if (seen.has(criterionId) && !reportedDuplicate.has(criterionId)) {
			reasons.push(`${label} declares criterion id ${JSON.stringify(criterionId)} more than once`);
			reportedDuplicate.add(criterionId);
		}
		seen.add(criterionId);
		const description = text(value.description, `${criterionLabel$1} description`, reasons);
		const mandatory = booleanField(value.mandatory, true, `${criterionLabel$1} mandatory`, reasons);
		const requiredEvidence = value.requiredEvidence === void 0 ? [] : stringList(value.requiredEvidence, `${criterionLabel$1} requiredEvidence`, reasons);
		const command = value.command;
		const criterion = {
			criterionId,
			description,
			verificationMode: carried(value.mode === void 0 ? command !== void 0 ? "deterministic" : "review" : value.mode),
			requiredEvidence,
			mandatory,
			...command === void 0 ? {} : { command: carried(command) },
			...value.requiresArtifact === void 0 ? {} : { requiresArtifact: carried(value.requiresArtifact) },
			...value.acceptsArtifact === void 0 ? {} : { acceptsArtifact: carried(value.acceptsArtifact) },
			...value.verifierRef === void 0 ? {} : { verifierRef: carried(value.verifierRef) },
			...value.childEvidence === void 0 ? {} : { childEvidence: carried(value.childEvidence) },
			...value.heuristic === void 0 ? {} : { heuristic: carried(value.heuristic) },
			...value.protectedInputs === void 0 ? {} : { protectedInputs: carried(value.protectedInputs) }
		};
		if (reasons.length > before) return;
		criteria.push(criterion);
	});
	return criteria;
}
/** One batch child, normalized; `undefined` exactly when it contributed a reason. */
function normalizeChild(raw, index, reasons) {
	const before = reasons.length;
	const label = `child ${index}`;
	if (!isPlainObject(raw)) {
		reasons.push(`${label} must be an object`);
		return;
	}
	unknownFields(raw, CHILD_FIELDS, label, reasons);
	const objective = text(raw.objective, `${label} objective`, reasons);
	const rawCriteria = raw.acceptanceCriteria;
	let criteria = [];
	if (!Array.isArray(rawCriteria)) reasons.push(`${label} acceptanceCriteria must be an array`);
	else criteria = normalizeCriteria(rawCriteria, label, (criterionIndex) => `ac${index + 1}-${criterionIndex + 1}`, reasons);
	const requiredCapabilities = raw.requiredCapabilities === void 0 ? [] : stringList(raw.requiredCapabilities, `${label} requiredCapabilities`, reasons);
	const assumptions = raw.assumptions === void 0 ? [] : stringList(raw.assumptions, `${label} assumptions`, reasons);
	const constraints = raw.constraints === void 0 ? [] : stringList(raw.constraints, `${label} constraints`, reasons);
	const dependsOn = raw.dependsOn === void 0 ? [] : integerList(raw.dependsOn, `${label} dependsOn`, reasons);
	const decomposable = booleanField(raw.decomposable, false, `${label} decomposable`, reasons);
	const requiresIndependentAcceptance = booleanField(raw.requiresIndependentAcceptance, false, `${label} requiresIndependentAcceptance`, reasons);
	if (reasons.length > before) return void 0;
	return {
		contract: {
			contractVersion: TASK_CONTRACT_VERSION,
			objective,
			acceptanceCriteria: criteria,
			assumptions,
			constraints,
			requiredCapabilities
		},
		dependsOn,
		decomposable,
		requiresIndependentAcceptance
	};
}
/**
* Normalize one decomposition proposal.
*
* Returns every defect it found, never the first: a caller revising a proposal
* needs the whole list, and a batch that returns at all is one the digest could
* describe. A refusal is a value, never a throw.
*/
function normalizeDecomposition(spec, context) {
	const reasons = [];
	if (!isPlainObject(spec)) return {
		ok: false,
		reasons: ["decomposition must be an object with a reason and a children array"]
	};
	unknownFields(spec, BATCH_FIELDS, "decomposition", reasons);
	const declaredVersion = spec.contractVersion;
	if (declaredVersion !== void 0 && declaredVersion !== TASK_CONTRACT_VERSION) reasons.push(`unknown contract version ${declaredText(declaredVersion)}: this runtime writes version ${TASK_CONTRACT_VERSION}`);
	let reason = "";
	if (nonBlank(spec.reason)) reason = spec.reason;
	else reasons.push("decomposition requires a non-blank reason");
	const children = [];
	const rawChildren = spec.children;
	if (rawChildren === void 0 || Array.isArray(rawChildren) && rawChildren.length === 0) reasons.push("decomposition requires at least one child");
	else if (!Array.isArray(rawChildren)) reasons.push("decomposition children must be an array");
	else rawChildren.forEach((raw, index) => {
		const child = normalizeChild(raw, index, reasons);
		if (child !== void 0) children.push(child);
	});
	if (reasons.length > 0) return {
		ok: false,
		reasons
	};
	const contractVersion = TASK_CONTRACT_VERSION;
	try {
		return {
			ok: true,
			batch: {
				contractVersion,
				reason,
				children,
				admission: {
					proposalDigest: decompositionDigest(decompositionIdentity(context, reason, children)),
					context: copyValue(context.admissionContext)
				}
			}
		};
	} catch (error) {
		return {
			ok: false,
			reasons: [`decomposition content cannot be canonicalized: ${message$3(error)}`]
		};
	}
}
/** The root contract's fields, and nothing else: a key outside this set is refused (A0 §2). */
const ROOT_CONTRACT_FIELDS = new Set([
	"contractVersion",
	"objective",
	"acceptanceCriteria",
	"assumptions",
	"constraints",
	"requiredCapabilities"
]);
/**
* The criterion id a root contract's criterion gets when it declares none:
* `ac-<j>`, one flat list.
*
* Why not the batch scheme (`ac<child>-<j>`): a root contract has no batch
* position to be numbered by, so the child half of that name would have to be
* invented — and an invented `ac1-2` on a root would read as "the second
* criterion of the first child", which is a decomposition this contract is not.
* The form is fixed here rather than left to the caller because an absent id
* must be deterministic: the digest covers it, and two writers of the same root
* contract must not produce two identities.
*/
function rootCriterionId(index) {
	return `ac-${index + 1}`;
}
/**
* Normalize one root contract (A0 §2–§3): the caller's single contract —
* objective, criteria, assumptions, constraints, declared capabilities — in,
* its canonical {@link TaskContract} out, or every reason it was refused.
*
* It shares the contract-level rules with {@link normalizeDecomposition} rather
* than restating them: the same closed field set per criterion (an undeclared
* key is refused by name, never dropped), the same verbatim text rule (blankness
* is refused, bytes are not rewritten), the same defaults (an omitted list is
* `[]`, an omitted `mandatory` is `true`, an absent mode follows the command),
* and the same criterion-id fixing — with the root's own id scheme
* ({@link rootCriterionId}).
*
* What it does *not* do: structural admission. `contractDefects`, the root's
* own independent-criterion rule (`admission.ts:rootIndependenceDefects`), the
* protected-input shape rule and every capability/provider/verifier question are
* asked by the intake entry over the value this returns, exactly as the
* decomposition path asks them over a normalized batch. And it writes nothing:
* the caller has the whole contract or a list of reasons, and a refused root
* contract leaves no id, no event and no file read behind it.
*
* The `contractVersion` gate is the batch's: absent is this build's version (the
* caller that does not version its input means the current language), and a
* declared version whose field semantics this build does not know is refused
* rather than read with today's reader.
*/
function normalizeRootContract(spec) {
	const reasons = [];
	if (!isPlainObject(spec)) return {
		ok: false,
		reasons: ["root contract must be an object with an objective and an acceptanceCriteria array"]
	};
	unknownFields(spec, ROOT_CONTRACT_FIELDS, "root contract", reasons);
	const declaredVersion = spec.contractVersion;
	if (declaredVersion !== void 0 && declaredVersion !== TASK_CONTRACT_VERSION) reasons.push(`unknown contract version ${declaredText(declaredVersion)}: this runtime writes version ${TASK_CONTRACT_VERSION}`);
	const label = "root contract";
	const objective = text(spec.objective, `${label} objective`, reasons);
	const rawCriteria = spec.acceptanceCriteria;
	let criteria = [];
	if (!Array.isArray(rawCriteria)) reasons.push(`${label} acceptanceCriteria must be an array`);
	else criteria = normalizeCriteria(rawCriteria, label, rootCriterionId, reasons);
	const assumptions = spec.assumptions === void 0 ? [] : stringList(spec.assumptions, `${label} assumptions`, reasons);
	const constraints = spec.constraints === void 0 ? [] : stringList(spec.constraints, `${label} constraints`, reasons);
	const requiredCapabilities = spec.requiredCapabilities === void 0 ? [] : stringList(spec.requiredCapabilities, `${label} requiredCapabilities`, reasons);
	if (reasons.length > 0) return {
		ok: false,
		reasons
	};
	return {
		ok: true,
		contract: {
			contractVersion: TASK_CONTRACT_VERSION,
			objective,
			acceptanceCriteria: criteria,
			assumptions,
			constraints,
			requiredCapabilities
		}
	};
}

//#endregion
//#region src/proposal.ts
/** The prefix every derived request key carries, so a key is recognizable as one wherever it is printed. */
const PROPOSAL_REQUEST_KEY_PREFIX = "rk-";
/**
* The request key one call derives when its caller named none: `rk-` plus the
* SHA-256 of {@link canonicalize} over
* {@link ProposalRequestKeyContext} (key order is irrelevant; the same request
* addresses the same key however it was written).
*
* A caller with its own stable identifier (a message id, a task row) may pass
* it instead — the store refuses one key bound to two proposals either way,
* so an explicit key is a promise the caller keeps, not a way around the rule.
* The derived form is what makes a retry of the *same* batch idempotent
* without any caller bookkeeping: a revision has different content, hence a
* different digest, hence a new key.
*/
function proposalRequestKey(context) {
	return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize({
		parentTaskId: context.parentTaskId,
		parentRunId: context.parentRunId,
		callerSessionId: context.callerSessionId,
		proposalDigest: context.proposalDigest
	}))}`;
}
/**
* The request key one root intake derives when its caller named none: `rk-` plus
* the SHA-256 of {@link canonicalize} over {@link RootRequestKeyContext}.
*
* What the derivation buys, in the order it matters: the same contract asked for
* again — in this process or after a restart — addresses the same proposal and is
* answered from the record instead of being written twice; a revision is
* different content, hence a different digest, hence a different key, which is
* exactly what §6 wants a revision to be; and no caller has to keep a key of its
* own to get that. A caller that *has* a stable identifier may pass it instead,
* and the store then holds it to the same rule — one key names one proposal, and
* a key already bound to other content is refused by name.
*/
function rootProposalRequestKey(context) {
	return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize({
		storeId: context.storeId,
		rootSessionId: context.rootSessionId,
		contractDigest: context.contractDigest
	}))}`;
}
/**
* The statuses in which a proposal is still "in flight" for the task that made
* it — submitted and not yet admitted, not yet decided, or decided and not yet
* re-checked. `admitted` and the four terminal statuses are excluded: a task
* with one of those has either a batch (the run is coordinated by A3 from
* there) or nothing waiting.
*/
const OPEN_PROPOSAL_STATUSES = [
	"ready",
	"pending_review",
	"approved"
];
/**
* Whether one proposal is still in flight for the task that made it —
* submitted and not yet admitted, not yet decided, or decided and not yet
* re-checked (§6). `admitted` and the four terminal statuses are not open: a
* task with one of those has either a batch (the run is coordinated by A3 from
* there) or nothing waiting.
*/
function isOpenProposal(proposal) {
	return OPEN_PROPOSAL_STATUSES.includes(proposal.status);
}
/**
* The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
* own batch is waiting for a review (or for the admission its approval
* authorizes) is idle on purpose, and an idle that is a known wait must not
* count as stagnation.
*
* Both the task and the run are matched, not just the task: a proposal names
* the run it was submitted from, and a *later* run of the same task is not
* waiting on a batch its predecessor proposed.
*
* A snapshot with no proposal index (a hand-built one, or a store written
* before proposals existed) answers `undefined` — the honest reading of "this
* reader cannot see proposals", which is a run to be judged by the rules that
* were in force when it was created rather than one this build's proposals
* hold up.
*/
function openProposalOf(snapshot, taskId, runId) {
	const proposals = (snapshot.proposals?.byParentTask[taskId] ?? []).filter((proposal) => proposal.kind !== "root" && proposal.identity.parentRunId === runId && OPEN_PROPOSAL_STATUSES.includes(proposal.status));
	return proposals[proposals.length - 1];
}
/**
* What a batch was reviewed against (§6), as this runtime can compute it.
*
* Two parts, and each has a stated boundary:
*
* - **The manifests**, through {@link capabilityManifestDigest}, folded with
*   the provider content identity the admission-time pre-check resolved for
*   the same rows. The manifest itself names skills, tools, presets,
*   permissions and MCP servers — *names*, not bytes — so the fold adds what
*   only discovery can answer: the `contractDigest` of every accepted
*   provider (`null` for a skill that declares no sidecar, which is a skill
*   whose content this deployment cannot pin). The fold covers the rows *this*
*   batch matched and nothing else, which is what keeps §6's "an unrelated
*   registry edit does not invalidate a reviewed proposal" true: a changed row
*   the batch never resolved is not in this digest.
* - **The judging verifiers**, as the ids the batch's criteria pin by
*   `verifierRef`. Those are the only instances this runtime can name: the
*   registered registry exposes its id vocabulary (`verifierIds()`), not the
*   version or the configuration each id currently stands for, so
*   `version`/`configurationDigest` are left off rather than invented (§6:
*   "没有可信内容版本的资源必须标明身份保障有限"). A criterion with no
*   `verifierRef` is dispatched by mode inside the verifier service and this
*   runtime cannot see which instance that is; its mode is part of the batch
*   content (the proposal digest covers the whole contract), so a *mode*
*   change is a different proposal, while a re-registration that keeps an id
*   and changes the behaviour behind it is **not** visible here and does not
*   invalidate a reviewed proposal.
*/
function reviewContextOf(input) {
	return {
		capabilityManifestDigest: sha256Hex(canonicalize({
			manifest: capabilityManifestDigest(input.manifests),
			providers: input.providers.map((provider) => ({
				name: provider.name,
				contractDigest: provider.contractDigest
			}))
		})),
		verifiers: verifierIdentitiesOf(input.criteria)
	};
}
/**
* The judging instances a batch's criteria pin by id, in first-appearance
* order. See {@link reviewContextOf} for why this is an id list and not a
* version binding; the digest over it is order-insensitive
* (`task/src/proposal.ts:reviewContextDigest` sorts), the stored list keeps
* the writer's order so a reader can see which criterion came first.
*/
function verifierIdentitiesOf(criteria) {
	const identities = [];
	const seen = /* @__PURE__ */ new Set();
	for (const criterion of criteria) {
		const verifierId = criterion.verifierRef;
		if (verifierId === void 0 || seen.has(verifierId)) continue;
		seen.add(verifierId);
		identities.push({ verifierId });
	}
	return identities;
}
/**
* Why two review contexts differ, as one line a refusal can carry: which part
* of the resolution moved (the manifests and provider content, or the judging
* verifiers). §6 requires the stale marking to name what changed — an
* invalidation a reader cannot explain is a record that cannot be trusted —
* and "the context changed" alone would be exactly that. The limits in force
* are the other half of the re-check and have their own fingerprint
* (`admissionContextDigest`), so a caller that has two of those reports the
* difference itself.
*/
function reviewContextDelta(before, after) {
	const parts = [];
	if (before.capabilityManifestDigest !== after.capabilityManifestDigest) parts.push(`the capability resolution moved (manifest digest ${before.capabilityManifestDigest} → ${after.capabilityManifestDigest})`);
	const beforeIds = before.verifiers.map((verifier) => verifier.verifierId).sort().join(", ");
	const afterIds = after.verifiers.map((verifier) => verifier.verifierId).sort().join(", ");
	if (beforeIds !== afterIds) parts.push(`the judging verifiers moved ([${beforeIds}] → [${afterIds}])`);
	return parts.length === 0 ? "the review context moved" : parts.join("; ");
}

//#endregion
//#region src/question.ts
function message$2(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The `m-` identity one question's message carries: derived from the question id,
* never minted. A retry — in this process or after a restart — states the same
* identity, which is what lets a target's own fold answer "this one is already
* here" instead of the framework keeping a ledger of what it sent.
*/
function questionMessageIdOf(questionId) {
	return `m-${questionId}`;
}
/** The `m-` identity one answer's message carries, derived from the answer id for the same reason ({@link questionMessageIdOf}). */
function answerMessageIdOf(answerId) {
	return `m-${answerId}`;
}
/**
* The arguments object one cited `tool/call` must hold: a JSON object, refused by
* name when it is not. Exported for the same reason this module's other pure
* steps are: the refusal rules are part of the contract, and a unit test should
* be able to drive them without a store.
*/
function parseCallArguments(body) {
	let parsed;
	try {
		parsed = JSON.parse(body.arguments);
	} catch (error) {
		throw new Error(`task-runtime: the arguments of the cited "${body.name}" call are not JSON (${message$2(error)}); a body that cannot be parsed is not a citation`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`task-runtime: the arguments of the cited "${body.name}" call are not a JSON object`);
	return parsed;
}
/** One non-empty string field of a cited call's arguments, refused by name when it is absent or blank. */
function requiredString(args, field, where) {
	const value = args[field];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`task-runtime: ${where} requires a non-empty "${field}" in its own arguments; the call carries ${JSON.stringify(value)}`);
	return value;
}
/** One non-empty string the *caller* claims; a caller that cannot state its own identity is refused before anything is read. */
function claimedString(value, field, toolName) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`task-runtime: ${toolName} needs a non-empty "${field}" from its caller; it received ${JSON.stringify(value)}`);
	return value;
}
/** How one boolean argument reads: absent takes `absent`, a non-boolean is refused (never coerced). */
function booleanArgument(args, field, absent, where) {
	const value = args[field];
	if (value === void 0) return absent;
	if (typeof value !== "boolean") throw new Error(`task-runtime: ${where} carries "${field}": ${JSON.stringify(value)}, which is not a boolean`);
	return value;
}
/**
* Locate and read back the caller's *own* `tool/call`, by registration id.
*
* The Session comes from the caller's identity (its run binding), never from the
* request: an id can only ever name an event of the calling session. The read
* goes through agent-runtime's `readToolCallBody`, which flushes the live
* Session first — the citation must be durable before a store may record it —
* and refuses by name when the event is missing, unreadable, or not a tool call.
*/
async function readOwnCall(deps, callerSessionId, callId, toolName) {
	if (callId.length === 0) throw new Error(`task-runtime: ${toolName} needs the registration id of its own call to cite its body`);
	let log;
	try {
		log = await deps.sessionQuery.readSession(SessionId(callerSessionId));
	} catch (error) {
		throw new Error(`task-runtime: ${toolName} cannot read session "${callerSessionId}" to locate its own call "${callId}": ${message$2(error)}`, { cause: error });
	}
	const ref = toolCallRefIn(log, callId);
	if (ref === void 0) throw new Error(`task-runtime: session "${callerSessionId}" holds no tool/call "${callId}"; ${toolName} cites the call it is answering for, and a caller cannot cite somebody else's call or a call that was never made`);
	let body;
	try {
		body = await deps.messages.readToolCallBody(ref);
	} catch (error) {
		throw new Error(`task-runtime: ${toolName} could not read back the body of its own call "${callId}" (${message$2(error)})`, { cause: error });
	}
	if (body.name !== toolName) throw new Error(`task-runtime: call "${callId}" in session "${callerSessionId}" is "${body.name}", not "${toolName}"; the cited body is the one that was sent`);
	return {
		...body,
		ref
	};
}
/** The body one ask cites, read back from the caller's own Session and checked against the claim the call makes. */
async function checkAskBody(deps, caller, request) {
	const body = await readOwnCall(deps, caller.sessionId, request.callId, "task_ask_parent");
	const args = parseCallArguments(body);
	const claimedKey = claimedString(request.requestKey, "requestKey", "task_ask_parent");
	const actualKey = requiredString(args, "requestKey", "task_ask_parent");
	if (actualKey !== claimedKey) throw new Error(`task-runtime: task_ask_parent claims request key "${claimedKey}", but the cited call "${request.callId}" asked under "${actualKey}"; the arguments the sender wrote are the only request key the store may record`);
	const blocking = booleanArgument(args, "blocking", true, "task_ask_parent");
	if (request.blocking !== void 0 && request.blocking !== blocking) throw new Error(`task-runtime: task_ask_parent claims blocking=${String(request.blocking)}, but the cited call "${request.callId}" declared ${String(blocking)}; a caller cannot record a blocking declaration its own message does not carry`);
	return {
		ref: body.ref,
		digest: sha256Hex(body.arguments),
		requestKey: actualKey,
		question: requiredString(args, "question", "task_ask_parent"),
		blocking
	};
}
/** The body one answer cites, read back from the answering Session and checked against the claim the call makes. */
async function checkAnswerBody(deps, caller, request) {
	const body = await readOwnCall(deps, caller.sessionId, request.callId, "task_answer");
	const args = parseCallArguments(body);
	const claimedQuestion = claimedString(request.questionId, "questionId", "task_answer");
	const actualQuestion = requiredString(args, "questionId", "task_answer");
	if (actualQuestion !== claimedQuestion) throw new Error(`task-runtime: task_answer claims question "${claimedQuestion}", but the cited call "${request.callId}" answers "${actualQuestion}"; a call answers the question its own message names`);
	const claimedKey = claimedString(request.requestKey, "requestKey", "task_answer");
	const actualKey = requiredString(args, "requestKey", "task_answer");
	if (actualKey !== claimedKey) throw new Error(`task-runtime: task_answer claims request key "${claimedKey}", but the cited call "${request.callId}" answered under "${actualKey}"`);
	if (args.resolves === void 0) throw new Error(`task-runtime: task_answer requires a boolean "resolves" in its own arguments; the cited call "${request.callId}" carries none`);
	const resolves = booleanArgument(args, "resolves", false, "task_answer");
	if (request.resolves !== resolves) throw new Error(`task-runtime: task_answer claims resolves=${String(request.resolves)}, but the cited call "${request.callId}" declared ${String(resolves)}; an answer releases exactly what its own message declares`);
	return {
		ref: body.ref,
		digest: sha256Hex(body.arguments),
		questionId: actualQuestion,
		requestKey: actualKey,
		answer: requiredString(args, "answer", "task_answer"),
		resolves
	};
}
/**
* Read one *recorded* citation back for the text a message carries. This is the
* record's own `(session, seq)` — not the call in hand — so a retry delivers
* exactly the bytes the store's record points at, and a record whose Session can
* no longer be read is a refusal rather than a made-up body.
*/
async function recordedText(deps, ref, field, where) {
	let body;
	try {
		body = await deps.messages.readToolCallBody({
			sessionId: SessionId(ref.sessionId),
			seq: ref.seq
		});
	} catch (error) {
		throw new Error(`task-runtime: the recorded body of ${where} could not be read from session "${ref.sessionId}" seq ${ref.seq}: ${message$2(error)}`, { cause: error });
	}
	return requiredString(parseCallArguments(body), field, `the recorded ${where}`);
}
/**
* Compose and deliver one recorded message, reporting rather than throwing: by
* this point the store's record is durable, so a delivery that cannot be decided
* is information for the caller and a retry for the recovery pass — never a
* reason to fail the call that already recorded the fact.
*/
async function deliverRecorded(deps, record) {
	try {
		const intent = {
			targetSessionId: SessionId(record.targetSessionId),
			senderSessionId: SessionId(record.senderSessionId),
			messageId: record.messageId,
			text: record.render(await recordedText(deps, record.ref, record.field, record.where))
		};
		const delivery = await deps.messages.ensureAgentMessageDelivered(intent);
		return {
			messageId: delivery.messageId,
			status: delivery.status
		};
	} catch (error) {
		return {
			messageId: record.messageId,
			status: "refused",
			reason: message$2(error)
		};
	}
}
/**
* The run one id names, or a refusal: every caller here reads a fact whose run
* the store has already checked, so a missing one is a defect of the snapshot,
* not a state to carry on from.
*/
function runOf(snapshot, runId, where) {
	const run = snapshot.runs.find((candidate) => candidate.runId === runId);
	if (run === void 0) throw new Error(`task-runtime: ${where} names run "${runId}", which the store's snapshot does not hold`);
	return run;
}
/**
* Ask one's direct parent (A4 §F.1): the `task_ask_parent` entry's whole effect.
*
* Read the body → commit the intent → recompute the block → deliver under the
* recorded identity. The parent is never named by the caller: the store resolves
* the asking task's direct parent and *its* current run, and the delivery goes to
* that run's Session. A repeated request (same run, same key, same arguments
* text) returns the record the store already holds, changes no gate state and
* delivers the same `messageId` — which is `already-present` when the target
* still holds it.
*/
async function askParentQuestion(deps, caller, request) {
	const checked = await checkAskBody(deps, caller, request);
	const ask = {
		childRunId: caller.runId,
		requestKey: checked.requestKey,
		questionDigest: checked.digest,
		questionRef: {
			sessionId: caller.sessionId,
			seq: checked.ref.seq
		},
		messageId: questionMessageIdOf(questionIdOf({
			childRunId: caller.runId,
			requestKey: checked.requestKey
		})),
		blocking: checked.blocking
	};
	const stored = await deps.task.askParentQuestionIn(caller.storeId, ask, caller.actor);
	const snapshot = await deps.task.snapshotIn(caller.storeId);
	deps.gate.setQuestionsBlocked(caller.sessionId, blockingQuestionsOf(snapshot, stored.question.childRunId).length > 0);
	const parentRun = runOf(snapshot, stored.question.parentRunId, `question "${stored.question.questionId}"`);
	const delivery = await deliverRecorded(deps, {
		messageId: stored.question.messageId,
		targetSessionId: parentRun.sessionId,
		senderSessionId: caller.sessionId,
		ref: stored.question.questionRef,
		field: "question",
		where: "the question",
		render: (written) => questionMessageText(stored.question.questionId, written)
	});
	return {
		question: stored.question,
		created: stored.created,
		delivery
	};
}
/**
* Answer one child's question (A4 §F.1): the `task_answer` entry's whole effect.
*
* The answering run is the caller's own — the store refuses an answer from any
* other run, including the new run of a restarted task — and the body citation
* must sit in the answering Session. The message goes to the *asking* run's
* Session, so `resolves: true` both releases that run's write gate (recomputed
* from the facts, so a second open question keeps it blocked) and puts the
* parent's words in front of the model that asked.
*/
async function answerParentQuestion(deps, caller, request) {
	const checked = await checkAnswerBody(deps, caller, request);
	const answer = {
		questionId: checked.questionId,
		parentRunId: caller.runId,
		requestKey: checked.requestKey,
		answerDigest: checked.digest,
		resolves: checked.resolves,
		answerRef: {
			sessionId: caller.sessionId,
			seq: checked.ref.seq
		},
		messageId: answerMessageIdOf(answerIdOf({
			questionId: checked.questionId,
			requestKey: checked.requestKey
		}))
	};
	const stored = await deps.task.answerParentQuestionIn(caller.storeId, answer, caller.actor);
	const snapshot = await deps.task.snapshotIn(caller.storeId);
	const question = questionOf(snapshot, stored.answer.questionId);
	if (question === void 0) throw new Error(`task-runtime: answer "${stored.answer.answerId}" was recorded, but its question is not in the store's snapshot; the block and the delivery cannot be decided from a fact the snapshot does not hold`);
	const childRun = runOf(snapshot, question.childRunId, `question "${question.questionId}"`);
	if (stored.answer.resolves) deps.gate.setQuestionsBlocked(childRun.sessionId, blockingQuestionsOf(snapshot, question.childRunId).length > 0);
	const delivery = await deliverRecorded(deps, {
		messageId: stored.answer.messageId,
		targetSessionId: childRun.sessionId,
		senderSessionId: caller.sessionId,
		ref: stored.answer.answerRef,
		field: "answer",
		where: "the answer",
		render: (written) => answerMessageText(stored.answer.answerId, stored.answer.questionId, written)
	});
	return {
		answer: stored.answer,
		created: stored.created,
		delivery
	};
}
/**
* What one store's question facts still owe a message, derived from its own
* snapshot and nothing else.
*
* Two rules, and both are about what the *facts* can prove rather than about
* what a process remembers:
*
* - every **open** question owes its ask: both runs are running and no answer
*   has resolved it, so the parent still has to be able to answer it;
* - every **answer** whose asking run is still running owes its delivery: the
*   framework has no consumption proof (§F.1 keeps the reference until a real
*   model step shows it), so even a resolved question's answer is owed to a run
*   that may never have read it.
*
* Nothing else is owed. A question whose asking run settled is audit — its ask
* and its answers are moot, and re-delivering them would be a message to a run
* that cannot act on it.
*/
function pendingQuestionMessages(snapshot) {
	const index = snapshot.questions;
	if (index === void 0) throw new Error("task-runtime: this store's snapshot carries no question index, so its pending question messages cannot be read");
	const open = /* @__PURE__ */ new Set();
	for (const run of snapshot.runs) for (const question of openQuestionsOf(snapshot, run.runId)) open.add(question.questionId);
	const messages = [];
	const refused = [];
	for (const question of index.all) {
		const subject = `question "${question.questionId}"`;
		const childRun = snapshot.runs.find((run) => run.runId === question.childRunId);
		const parentRun = snapshot.runs.find((run) => run.runId === question.parentRunId);
		if (childRun === void 0 || parentRun === void 0) {
			refused.push({
				subject,
				messageId: question.messageId,
				status: "refused",
				reason: "the store holds the question without both of its runs, so neither the ask nor its answers can be addressed"
			});
			continue;
		}
		if (open.has(question.questionId)) messages.push({
			subject,
			kind: "question",
			questionId: question.questionId,
			messageId: question.messageId,
			ref: question.questionRef,
			senderSessionId: childRun.sessionId,
			targetSessionId: parentRun.sessionId
		});
		if (childRun.status !== "running") continue;
		for (const answer of question.answers ?? []) messages.push({
			subject: `answer "${answer.answerId}" for question "${question.questionId}"`,
			kind: "answer",
			questionId: question.questionId,
			answerId: answer.answerId,
			messageId: answer.messageId,
			ref: answer.answerRef,
			senderSessionId: parentRun.sessionId,
			targetSessionId: childRun.sessionId
		});
	}
	return {
		messages,
		refused
	};
}
/**
* The question messages one store still owes **one Session** — the same
* derivation as {@link pendingQuestionMessages}, narrowed to a target.
*
* It exists for the recovery pass's own question (A4 §F.1): an unsubmitted run
* whose Session is owed a delivery is *not* an abandoned run. The clearest case
* is an answered question whose answer has not been read — the asking run's
* block is already gone (the answer resolved it), so the blocking derivation
* cannot see the wait, while the store still owes that run the answer it waited
* for. Cancelling it there would throw away exactly what the exchange produced.
*/
function owedQuestionMessagesTo(snapshot, sessionId) {
	return pendingQuestionMessages(snapshot).messages.filter((message$8) => message$8.targetSessionId === sessionId);
}
/**
* Reconcile the deliveries one store's question facts still owe (§F.1's crash
* recovery): read each pending body from its *recorded* citation, then hand the
* composed intents to agent-runtime's reconcile — which delivers only what the
* target Session's own fold says is missing, so a second pass over the same
* record adds nothing.
*
* A recorded body that can no longer be read is reported per record rather than
* failing the pass: the facts are still the facts, the next activation is the
* retry, and one unreadable Session must not hide the deliveries that could be
* made. A target that is not live comes back `unavailable` — zero side effects,
* no substitute parent, and the same retry rule.
*/
async function reconcileQuestionDeliveries(deps, storeId) {
	const pending = pendingQuestionMessages(await deps.task.snapshotIn(storeId));
	const composed = [];
	const subjects = [];
	const unreadable = /* @__PURE__ */ new Map();
	for (const pendingMessage of pending.messages) {
		const subject = pendingMessage.subject;
		try {
			subjects.push(subject);
			composed.push({
				targetSessionId: SessionId(pendingMessage.targetSessionId),
				senderSessionId: SessionId(pendingMessage.senderSessionId),
				messageId: pendingMessage.messageId,
				text: pendingMessage.kind === "question" ? questionMessageText(pendingMessage.questionId, await recordedText(deps, pendingMessage.ref, "question", "the question")) : answerMessageText(pendingMessage.answerId, pendingMessage.questionId, await recordedText(deps, pendingMessage.ref, "answer", "the answer"))
			});
		} catch (error) {
			subjects.pop();
			unreadable.set(pendingMessage.messageId, {
				subject,
				messageId: pendingMessage.messageId,
				status: "refused",
				reason: message$2(error)
			});
		}
	}
	const settled = composed.length === 0 ? [] : await deps.messages.reconcileAgentMessageDeliveries(composed);
	const reported = /* @__PURE__ */ new Map();
	settled.forEach((report, index) => {
		reported.set(report.messageId, {
			subject: subjects[index],
			messageId: report.messageId,
			status: report.status,
			...report.reason === void 0 ? {} : { reason: report.reason }
		});
	});
	return [...pending.refused, ...pending.messages.flatMap((pendingMessage) => {
		const record = reported.get(pendingMessage.messageId) ?? unreadable.get(pendingMessage.messageId);
		return record === void 0 ? [] : [record];
	})];
}
/**
* Recompute the question block of every run that asked the run just settled —
* the *fourth* moment the facts behind a block can move, and the one that has no
* event of its own.
*
* An open question requires both runs to still be running ({@link
* blockingQuestionsOf}), so the moment the *addressee* settles, every question
* addressed to it stops being open: the asking run is no longer waiting on
* anything, and nothing about it may be refused for a wait that no longer
* exists. No `QuestionAnswered` was written and no phase moved, so the three
* push sites that recompute a block (the ask, the resolving answer, recovery)
* never run — without this step a run whose parent settled first would keep a
* refusal that only its own wall time could end.
*
* Everything pushed here is derived from the snapshot the caller read *after*
* the settlement, and the asking sessions are found from the store's own
* questions (an answer carries no session; the citation does) rather than from
* anything this process remembers. The asking run's own session is not the
* subject — a run that settled closes its own gate — and a question whose asking
* run is no longer running has nothing left to release.
*/
function releaseAskingSessions(gate, snapshot, settledRunId) {
	const index = snapshot.questions;
	if (index === void 0) return;
	const asking = /* @__PURE__ */ new Map();
	for (const question of index.all) {
		if (question.parentRunId !== settledRunId) continue;
		const childRun = snapshot.runs.find((run) => run.runId === question.childRunId);
		if (childRun === void 0 || childRun.status !== "running") continue;
		asking.set(childRun.sessionId, childRun.runId);
	}
	for (const [sessionId, childRunId] of asking) {
		const blocked = blockingQuestionsOf(snapshot, childRunId).length > 0;
		if (gate.questionsBlocked(sessionId) !== blocked) gate.setQuestionsBlocked(sessionId, blocked);
	}
}
/**
* Push the question block every run in one snapshot implies onto the gate, under
* the gate's own token rule — the recovery pass's half of §F.1's "restart from
* the durable facts". The token is the one taken before the snapshot read, so a
* value that straddled a decision of this process is dropped exactly as a
* store-derived phase is.
*/
function applyStoreQuestionBlocking(gate, snapshot, tokenOf) {
	for (const run of snapshot.runs) gate.applyStoreQuestionsBlocked(run.sessionId, blockingQuestionsOf(snapshot, run.runId).length > 0, tokenOf(run.sessionId));
}
/**
* Whether one run still owes or waits for coordination: no unresolved blocking
* question of its own, and no question of a child's it has not answered. The
* runtime reads this where a run's own next step would otherwise be automatic —
* the parent's submission once its children are terminal — and the answer is
* deliberately *derived* from the facts rather than stored: an answered question
* and an unanswered one are the same list, one answer apart.
*/
function pendingCoordinationOf(snapshot, runId) {
	return [...openQuestionsOf(snapshot, runId), ...questionsAwaitingAnswerOf(snapshot, runId)];
}

//#endregion
//#region src/workspace.ts
/** The directory under a deployment's run-binding root that holds ownership markers (§3.4). */
const WORKSPACE_OWNERS_DIR = "workspace-owners";
/**
* A workspace that cannot be claimed because something already holds it — or
* because a marker exists that cannot be read as a holder. Carries the three
* things a caller needs to report it: which workspace, who holds it, and since
* when. `owner`/`since` are absent only in the unreadable-marker case, where
* nothing on disk names a holder; the message says so instead of inventing one.
*/
var WorkspaceBusyError = class extends Error {
	workspace;
	owner;
	since;
	constructor(workspace, owner, since, detail) {
		const held = owner === void 0 ? `a marker exists but names no holder: ${detail}` : `held by ${describeOwner(owner)} since ${since ?? owner.since} — ${detail}`;
		super(`workspace ${workspace} is busy: ${held}`);
		this.name = "WorkspaceBusyError";
		this.workspace = workspace;
		this.owner = owner;
		this.since = since;
	}
};
/** One line naming an owner the way every diagnostic in this module names it. */
function describeOwner(owner) {
	const parts = [`kind ${owner.kind}`, `store ${owner.storeId}`];
	if (owner.taskId !== void 0) parts.push(`task ${owner.taskId}`);
	if (owner.runId !== void 0) parts.push(`run ${owner.runId}`);
	if (owner.batchId !== void 0) parts.push(`batch ${owner.batchId}`);
	return parts.join(" ");
}
/**
* The identity of an owner as a stack compares it: every declared field, `since`
* included. Strict on purpose — two claims by the same run at different instants
* are two different holders, and a handover that names the run but not the
* instant it was taken is not the holder this stack is looking at.
*/
function ownerKey(owner) {
	return JSON.stringify([
		owner.kind,
		owner.storeId,
		owner.taskId ?? null,
		owner.runId ?? null,
		owner.batchId ?? null,
		owner.since
	]);
}
function message$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Resolve a checkout path the way ownership keys it: absolute, with symbolic
* links resolved, so the two spellings of one directory cannot become two
* markers. Throws when the path cannot be resolved (absent, a broken link, no
* permission) — a workspace whose identity is unknown is not a workspace this
* module will record an owner for.
*/
async function normalizeWorkspacePath(path) {
	try {
		return await realpath(resolve(path));
	} catch (error) {
		throw new Error(`workspace ${path} cannot be resolved to a real path: ${message$1(error)}`);
	}
}
/**
* The kernel's start-time token for `pid`, or `undefined` when it cannot be read
* (a non-Linux platform, a pid that is gone, a process this user may not stat).
* Exported because it is the one honest pid-reuse check available here: compare
* it with the value a marker recorded.
*/
async function readProcessStartTime(pid) {
	let stat$1;
	try {
		stat$1 = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return;
	}
	const close = stat$1.lastIndexOf(")");
	if (close < 0) return void 0;
	const starttime = stat$1.slice(close + 1).trim().split(/\s+/)[19];
	return starttime === void 0 || starttime.length === 0 ? void 0 : starttime;
}
/** True when `pid` is a live process this user can signal; EPERM means another user's live process, which counts as alive. */
function pidIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* How many marker writes this process has started; it names each write's
* temporary file. Two chains mutate one workspace's marker at the same time in a
* real deployment — a child's submission chain takes the verifier layer in and
* out while the batch driver releases the child it has seen settle — and with one
* shared temporary path the first `rename` takes the file away from the second,
* whose release then fails with ENOENT. A counter per process rather than per
* registry, because two registries in one process (a second graph's) write the
* same marker path for the same workspace.
*/
let markerWriteSeq = 0;
/** Parse a marker file's bytes; anything that is not a well-formed marker is reported, never repaired. */
function parseMarker(raw, file) {
	let declared;
	try {
		declared = JSON.parse(raw);
	} catch (error) {
		return {
			kind: "unreadable",
			reason: `${file} is not readable JSON (${message$1(error)}); an unreadable marker is not evidence that a workspace is free`
		};
	}
	if (declared === null || typeof declared !== "object") return {
		kind: "unreadable",
		reason: `${file} does not hold a marker object`
	};
	const candidate = declared;
	if (typeof candidate.pid !== "number" || candidate.owner === null || typeof candidate.owner !== "object" || typeof candidate.path !== "string") return {
		kind: "unreadable",
		reason: `${file} does not name a pid and an owner; only a human should decide what to do with it`
	};
	const owner = candidate.owner;
	return {
		kind: "held",
		marker: {
			path: candidate.path,
			pid: candidate.pid,
			...typeof candidate.processStartedAt === "string" ? { processStartedAt: candidate.processStartedAt } : {},
			owner,
			since: typeof candidate.since === "string" ? candidate.since : owner.since
		}
	};
}
/**
* The in-process and on-disk ownership of a deployment's workspaces. One
* instance per runtime; `close()` releases what this process still holds.
*/
/**
* Release the layer on top of one workspace's stack, when `holds` says it is the
* caller's. The comparison is the caller's own identity rule — a caller that
* rebuilds its owner description from scratch cannot reproduce the instant a
* layer was taken, so the registry's full-key check is not what decides here —
* and the layer actually on top is what the registry is asked to pop, so the pop
* can never take a stranger's.
*
* Returns `released: false` with the offending holder when the top is not the
* caller's layer, and `released: false` alone when this process holds nothing:
* the two cases mean different things, and each caller's policy decides which of
* them is worth a diagnostic.
*/
async function releaseLayer(registry, workspace, holds) {
	const top = registry.ownerOf(workspace);
	if (top === void 0) return { released: false };
	if (!holds(top)) return {
		released: false,
		conflict: top
	};
	await registry.release(workspace, top);
	return { released: true };
}
var WorkspaceRegistry = class {
	markerRoot;
	pid;
	stacks = /* @__PURE__ */ new Map();
	/**
	* One marker-mutation chain per workspace: every write and delete joins the
	* tail of its workspace's chain, so overlapping mutations of one marker land
	* in the order they were called — the same order the stack was mutated in.
	* A rejected mutation is carried past, never stored: a write that failed
	* (a permission, a full disk) must not wedge the mutations behind it, and its
	* caller still sees the rejection it has to report.
	*/
	markerWrites = /* @__PURE__ */ new Map();
	constructor(options) {
		this.markerRoot = options.markerRoot;
		this.pid = options.pid ?? process.pid;
	}
	/** Queue one marker mutation after the ones this workspace already has in flight, in call order. */
	queueMarkerMutation(workspace, mutate) {
		const run = (this.markerWrites.get(workspace) ?? Promise.resolve()).catch(() => void 0).then(mutate);
		const stored = run.catch(() => void 0);
		this.markerWrites.set(workspace, stored);
		stored.then(() => {
			if (this.markerWrites.get(workspace) === stored) this.markerWrites.delete(workspace);
		});
		return run;
	}
	/** Where one workspace's marker lives — derived from the path as given, so it is the same key the stack uses. */
	markerPath(workspace) {
		return join(this.markerRoot, `${sha256Hex(workspace)}.json`);
	}
	/** The owner on top of the stack, or `undefined` when this process holds nothing for the workspace. */
	ownerOf(workspace) {
		const held = this.stacks.get(workspace);
		return held === void 0 || held.length === 0 ? void 0 : held[held.length - 1];
	}
	/**
	* Take a workspace for `owner`. Refuses — before anything is written, so a
	* refused claim leaves the marker exactly as it was — when this process
	* already holds it, or when any marker is already there.
	*/
	async claim(workspace, owner) {
		const top = this.ownerOf(workspace);
		if (top !== void 0) throw new WorkspaceBusyError(workspace, top, top.since, "this process already holds the workspace; release the holder before claiming it again");
		const read = await this.readMarker(workspace);
		if (read.kind !== "absent") throw await this.busyFromMarker(workspace, read);
		await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, owner));
		this.stacks.set(workspace, [owner]);
	}
	/**
	* Hand the workspace from `from` (which must be the current holder) to `to`,
	* pushing `to` on the stack and rewriting the marker to name it. The stack is
	* the ownership history: the run at the bottom keeps its claim while its batch
	* and current child are on top of it.
	*/
	async push(workspace, from, to) {
		const held = this.stacks.get(workspace);
		if (held === void 0 || held.length === 0) throw new Error(`workspace ${workspace} cannot be handed from ${describeOwner(from)} to ${describeOwner(to)}: this process holds no claim on it`);
		const top = held[held.length - 1];
		if (ownerKey(top) !== ownerKey(from)) throw new Error(`workspace ${workspace} cannot be handed over: its current holder is ${describeOwner(top)} (since ${top.since}), not ${describeOwner(from)} (since ${from.since}); a handover names the holder that is actually there`);
		held.push(to);
		await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, to));
	}
	/**
	* Release `owner`, which must be the current holder. A mismatch throws with
	* both owners named — popping a lower holder would hand the checkout to
	* someone while a writer still believes it holds the workspace. The last
	* release deletes the marker; an earlier one rewrites it to the new top.
	*/
	async release(workspace, owner) {
		const held = this.stacks.get(workspace);
		if (held === void 0 || held.length === 0) throw new Error(`workspace ${workspace} cannot be released by ${describeOwner(owner)} (since ${owner.since}): this process holds no claim on it`);
		const top = held[held.length - 1];
		if (ownerKey(top) !== ownerKey(owner)) throw new Error(`workspace ${workspace} cannot be released by ${describeOwner(owner)} (since ${owner.since}): its current holder is ${describeOwner(top)} (since ${top.since}); only the holder on top of the stack releases it`);
		held.pop();
		if (held.length === 0) {
			this.stacks.delete(workspace);
			await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace));
		} else {
			const remaining = held[held.length - 1];
			await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, remaining));
		}
	}
	/**
	* Take over a marker whose owning process is gone — the recovery path only,
	* and the only way a stale marker is ever cleared. An absent marker is a
	* success that changes nothing; a marker whose pid is alive, or whose bytes
	* cannot be read as a marker, is a refusal that leaves
	* everything in place, because adopting it would hand the checkout to a caller
	* while a writer that may still be running has no idea.
	*/
	async reconcileAdopt(workspace) {
		const read = await this.readMarker(workspace);
		if (read.kind === "absent") return { adopted: true };
		if (read.kind === "unreadable") return {
			adopted: false,
			reason: read.reason
		};
		const { marker } = read;
		if (pidIsAlive(marker.pid)) return {
			adopted: false,
			reason: `workspace ${workspace} still has a holder: ${marker.pid === this.pid ? `the marker names this process's own pid ${marker.pid}, so no liveness probe can tell its holder apart from this process — settle this process's own claims instead` : `the marker names pid ${marker.pid}, which is alive${marker.processStartedAt === void 0 ? "" : ` (start time ${marker.processStartedAt})`}; a live owner is never taken over, however the recovery path explains it`}`
		};
		this.stacks.delete(workspace);
		await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace));
		return { adopted: true };
	}
	/**
	* Release everything this process still holds, as an unload path does. Only
	* markers that name this process's pid are deleted: a marker written by
	* another process describes a writer this unload knows nothing about, and
	* removing it could hand a checkout to the next caller while that writer runs.
	*/
	async close() {
		const workspaces = [...this.stacks.keys()];
		this.stacks.clear();
		for (const workspace of workspaces) {
			const read = await this.readMarker(workspace);
			if (read.kind !== "held") continue;
			if (read.marker.pid !== this.pid) continue;
			await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace));
		}
	}
	/** The busy error a marker earns: whose, why, and — when the recorded start time disagrees — that the pid was reused. */
	async busyFromMarker(workspace, read) {
		if (read.kind === "unreadable") return new WorkspaceBusyError(workspace, void 0, void 0, read.reason);
		const { marker } = read;
		if (marker.pid === this.pid) return new WorkspaceBusyError(workspace, marker.owner, marker.since, `the marker at ${this.markerPath(workspace)} names this process's own pid ${marker.pid}, but this process holds no claim on the workspace; the in-process stack is the truth, so the marker and this process disagree and the workspace is reported busy rather than taken`);
		if (!pidIsAlive(marker.pid)) return new WorkspaceBusyError(workspace, marker.owner, marker.since, `the marker's pid ${marker.pid} is not alive, so the marker is stale; only the recovery path (reconcileAdopt) may take a stale marker over, because the process that wrote it may have died mid-write`);
		const recorded = marker.processStartedAt;
		const live = recorded === void 0 ? void 0 : await readProcessStartTime(marker.pid);
		const reused = recorded !== void 0 && live !== void 0 && live !== recorded ? `; its recorded start time ${recorded} differs from the live ${live}, so the pid was reused and the marker's writer is gone (still reported busy: only reconcileAdopt clears a marker)` : "";
		return new WorkspaceBusyError(workspace, marker.owner, marker.since, `the marker names pid ${marker.pid}, which is alive${reused}`);
	}
	async readMarker(workspace) {
		const file = this.markerPath(workspace);
		let raw;
		try {
			raw = await readFile(file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return { kind: "absent" };
			return {
				kind: "unreadable",
				reason: `${file} cannot be read (${message$1(error)}); an unreadable marker is not evidence that a workspace is free`
			};
		}
		const read = parseMarker(raw, file);
		if (read.kind === "held" && read.marker.path !== workspace) return {
			kind: "unreadable",
			reason: `${file} describes workspace ${read.marker.path}, not ${workspace}; the marker and this path disagree, which only a human should resolve`
		};
		return read;
	}
	async writeMarker(workspace, owner) {
		const file = this.markerPath(workspace);
		const marker = {
			path: workspace,
			pid: this.pid,
			owner,
			since: owner.since
		};
		const startedAt = await readProcessStartTime(this.pid);
		if (startedAt !== void 0) marker.processStartedAt = startedAt;
		await mkdir(dirname(file), { recursive: true });
		markerWriteSeq += 1;
		const tmp = `${file}.${markerWriteSeq}.tmp`;
		await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
		await rename(tmp, file);
	}
	async removeMarker(workspace) {
		await rm(this.markerPath(workspace), { force: true });
	}
};

//#endregion
//#region src/handoff.ts
/**
* The envelope passed from a parent run to the child it delegates to (RFC §18).
*
* This module builds and persists the DATA of a handoff and nothing else: what
* a worker is shown from it is the context package's projection
* (`context/src/projections.ts`, `render.ts:handoffLines`), and the stable
* behaviour rules that used to ride the same spawn prompt are the agent
* runtime's worker policy section — neither is rendered here, because the
* runtime must not grow a second rendering of what it owns as facts.
*/
function buildHandoff(init) {
	return {
		handoffId: `h-${randomUUID()}`,
		parentTaskId: init.parentTask.taskId,
		parentRunId: init.parentRun.runId,
		childTaskId: init.childTask.taskId,
		parentObjective: init.parentTask.objective,
		reasonForDelegation: init.reason,
		constraints: [...init.constraints ?? []],
		decisions: [...init.decisions ?? []],
		relevantArtifacts: (init.relevantArtifacts ?? init.parentRun.artifacts).map((artifact) => ({ ...artifact })),
		relevantEvidence: [...init.relevantEvidence ?? []],
		assumptions: [...init.assumptions ?? []],
		openQuestions: [...init.openQuestions ?? []],
		parentSessionRef: init.callerSessionId,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}

//#endregion
//#region src/orchestrate.ts
/** Raised when the verifier service (ticket C2) is not loaded in the context. */
var VerifierUnavailableError = class extends Error {
	name = "VerifierUnavailableError";
};
/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
const VERIFY_SAFETY_MARGIN_MS = 15e3;
/** Block reason for a child the batch never started because the caller cancelled it. */
const CANCELLED_BEFORE_START = "cancelled by the caller before this child started";
/**
* Rebuild the authorization a recovery pass has to state for one run, from the
* store's own records, and hand it to the deployment's resume door.
*
* **Why it is rebuilt here and not remembered:** the spawn's grant is a
* function of durable facts — the task's manifest in the store, and the run's
* own provider binding — so the same helpers that resolved it at spawn
* (`authorizedGrant`, `permissionFor`, `skillRootsForRun`) resolve it again.
* A grant recorded somewhere and handed back would be a second source of
* authorization that could drift from the manifest it came from; and a resume
* states the plane it *would* install so the Session's own durable record can
* refuse a grant it never ran under.
*
* The one thing this cannot rebuild is an overlay the spawn took from the
* caller rather than from the store — a replay's candidate skill roots
* (`ReplayOverlay.extraSkillRoots`, A6/S2-R's own subject). What is rebuilt is
* the run's own binding snapshot, which is what a resumed worker loads its
* content from; the candidate overlay of an interrupted experiment is not part
* of the run's record and is not invented here.
* @param env - the deployment's seam, for the store, the permission registry and the resume door.
* @param storeId - the store the run belongs to.
* @param run - the run as the store records it.
* @returns what the attempt settled as, never a throw for a named refusal.
*/
async function resumeAdoptedWorker(env, storeId, run) {
	const resume = env.resumeWorkerSession;
	if (resume === void 0) return {
		status: "refused",
		reason: "this deployment wires no worker resume, so the Session of an adopted run cannot be brought back"
	};
	let manifest;
	try {
		manifest = (await env.task.snapshotIn(storeId)).capabilities[run.taskId];
	} catch (error) {
		return {
			status: "refused",
			reason: `the store could not be read for its manifest: ${message(error)}`
		};
	}
	if (manifest === void 0) return {
		status: "refused",
		reason: `the store holds no capability manifest for task "${run.taskId}", so the composition run "${run.runId}" was spawned in cannot be rebuilt`
	};
	let grant;
	let permissionPreset;
	try {
		grant = await authorizedGrant(env, manifest, skillRootsForRun([], run.providerBinding));
		permissionPreset = permissionFor(env, manifest);
	} catch (error) {
		return {
			status: "refused",
			reason: `the run's authorization could not be rebuilt: ${message(error)}`
		};
	}
	return await resume({
		storeId,
		run,
		grant,
		...permissionPreset === void 0 ? {} : { permissionPreset },
		taskWorker: true
	});
}
/** Raised when the deployment cannot observe a run's terminal state, so no honest settlement is possible. */
var RunWatcherUnavailableError = class extends Error {
	name = "RunWatcherUnavailableError";
};
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal) {
	return signal?.aborted === true;
}
/**
* The KISS §4.3 UNKNOWN split, rendered into the orchestrator's feedback so a
* reader never mistakes "the criterion was never tested" for "the judge is
* broken" — confusing the two makes the system re-test the same thing
* forever. Only an inconclusive verdict carries a kind; pass/fail need none.
*/
function unknownTag(result) {
	if (result.status !== "inconclusive" || result.unknownKind === void 0) return "";
	return result.unknownKind === "task" ? " [unknown: task — the criterion was never tested]" : ` [unknown: verifier — the verifier could not judge] ${escalationHint(`the verifier "${result.verifierId}" could not judge criterion "${result.criterionId}"`, "the criterion was run and the judge itself failed", "fix or replace the verifier, then re-verify the criterion")}`;
}
function unmetMandatory(criteria, results) {
	return criteria.filter((criterion) => criterion.mandatory).flatMap((criterion) => {
		const result = results.find((item) => item.criterionId === criterion.criterionId);
		if (criterion.heuristic === true) return [{
			criterionId: criterion.criterionId,
			detail: `heuristic judgement${result === void 0 ? "" : ` (verdict ${result.status})`} — explicitly labeled heuristic, not counted as a deterministic pass`
		}];
		if (result?.status === "pass") return [];
		return [{
			criterionId: criterion.criterionId,
			detail: result === void 0 ? "no result" : `${result.status}${unknownTag(result)}${result.details === void 0 ? "" : ` (${result.details})`}`
		}];
	});
}
function failureReason(unmet) {
	return `mandatory criteria not satisfied: ${unmet.map((item) => `${item.criterionId} ${item.detail}`).join(", ")}`;
}
/**
* The artifact references (per criterion) that no store evidence satisfies yet.
* A reference matches an evidence id, an artifact kind, or an artifact id — the
* three spellings a contract can name a product by. Judged at spawn time, never
* at admission: existence needs the store snapshot.
*
* The two declarations differ in what "satisfied" means (P4, KISS §5.1):
* `requiresArtifact` names a **verified reference product** — the producing run
* must sit in the verified terminal state and its bundle must carry a passing
* verdict, so a failed or still-running run's same-named product never closes
* the gap — while `acceptsArtifact` names a **raw input** whose mere existence
* in the store is the requirement.
*/
function missingRequiredArtifacts(criteria, snapshot) {
	const present = /* @__PURE__ */ new Set();
	const verified = /* @__PURE__ */ new Set();
	for (const item of snapshot.evidence) {
		const run = snapshot.runs.find((candidate) => candidate.runId === item.taskRunId);
		const refs = [item.evidenceId, ...item.artifacts.flatMap((artifact) => [artifact.kind, artifact.artifactId])];
		for (const ref of refs) present.add(ref);
		if (run?.status === "verified" && item.verifierResults.some((result) => result.status === "pass")) for (const ref of refs) verified.add(ref);
	}
	return criteria.flatMap((criterion) => [...(criterion.requiresArtifact ?? []).filter((ref) => !verified.has(ref)).map((ref) => ({
		criterionId: criterion.criterionId,
		ref,
		requirement: "requires"
	})), ...(criterion.acceptsArtifact ?? []).filter((ref) => !present.has(ref)).map((ref) => ({
		criterionId: criterion.criterionId,
		ref,
		requirement: "accepts"
	}))]);
}
function missingArtifactReason(missing) {
	return `missing required artifacts: ${missing.map((item) => `${item.ref} (criterion ${item.criterionId}${item.requirement === "accepts" ? "; raw input, any run state" : ""})`).join(", ")}`;
}
/**
* The authorization one admitted child runs under, built from its manifest:
* the tools and skills its matched capabilities declared (labels already
* expanded at admission), the baseline its worker prompt needs, and whether the
* mounted preset's own tool plane stays — which it does exactly when a matched
* capability named its own preset, because a foreign composition's tool names
* are not ours to enumerate. The MCP plane joins separately:
* {@link authorizedGrant} binds the manifest's server names to the run's env.
*/
function workerGrant(manifest) {
	return {
		capabilities: Object.entries(manifest.capabilities).map(([capability, entry]) => ({
			capability,
			tools: [...entry.tools],
			skills: [...entry.skills]
		})),
		baseline: workerBaseline(),
		keepPresetTools: Object.values(manifest.capabilities).some((entry) => entry.preset !== void 0)
	};
}
/**
* The full grant for one spawn: {@link workerGrant} plus the manifest's MCP
* servers materialized against the run's env binding, plus the skill roots the
* worker's own skill layer registers before anything else (S1-C: the run's
* snapshot; a replay's candidate overlay stays in front of it). Throws when a
* declared server has no binding or its repo is absent from the env — inside the
* spawn `try`, so the failure walks the run to `failed` with the cause named,
* the same discipline as a dangling preset.
*/
async function authorizedGrant(env, manifest, skillRoots = []) {
	const grant = {
		...workerGrant(manifest),
		...skillRoots.length === 0 ? {} : { skillRoots: [...skillRoots] }
	};
	if (manifestMcpServers(manifest).length === 0) return grant;
	const binding = env.resolveMcpEnv === void 0 ? void 0 : await env.resolveMcpEnv();
	return {
		...grant,
		mcpServers: resolveMcpServerSpecs(manifest, binding)
	};
}
/**
* The skill roots one worker's layer registers, in order: whatever the caller
* passes first (a replay's candidate overlay, which must win a same-name
* collision — P2's semantics) and then the run's own snapshot. The snapshot is
* never conditional on the overlay: a run that bound content loads that content.
*/
function skillRootsForRun(overlayRoots, binding) {
	return [...overlayRoots, ...binding?.snapshotRoot === void 0 ? [] : [binding.snapshotRoot]];
}
/**
* Copy the verifier's per-criterion results onto a review record, filling the
* command from the criterion itself when the result omits it — the record
* must show what was checked without a trip back into the evidence bundle.
*
* The deciding judge travels with the verdict (S1-V slice 2): the registered
* verifier id and the version of the instance that produced the verdict, so a
* reader can tell which judge decided, and a later recall can index the
* verdict by `(verifierRef, version)` (KISS §8.2) without reopening the bundle.
* Both are optional on the record and omitted when the result carries neither —
* a verdict written before the fields existed stays readable exactly as before,
* and nothing is invented for it.
*/
function reviewCriteria(criteria, results) {
	return results.map((result) => {
		const command = result.command ?? criteria.find((item) => item.criterionId === result.criterionId)?.command;
		return {
			criterionId: result.criterionId,
			verdict: result.status,
			...result.verifierId === void 0 ? {} : { verifierId: result.verifierId },
			...result.verifierVersion === void 0 ? {} : { verifierVersion: result.verifierVersion },
			...command === void 0 ? {} : { command },
			...result.exitCode === void 0 ? {} : { exitCode: result.exitCode },
			...result.logRef === void 0 ? {} : { logRef: result.logRef },
			...result.unknownKind === void 0 ? {} : { unknownKind: result.unknownKind }
		};
	});
}
/**
* The review dimensions and the effort counters for one terminal record,
* assembled from what the store already holds plus one optional session read.
*
* Everything here is a mechanically observed fact: counts, declared modes,
* names, and raw token buckets. No field is a score, and no derivation applies a
* threshold or an opinion — §2.7.3 keeps the "why" in Diagnosis. A dimension or
* counter whose source is missing is left out entirely rather than defaulted to
* zero, so an absent field always means "not observed" and never "observed as
* nothing".
*
* Best-effort by contract: this runs inside the terminal transition, so any read
* that fails degrades to an omitted field instead of costing the record.
*/
async function reviewEnrichment(env, storeId, taskId, outcome, run, criteria) {
	try {
		const task = await env.task.taskIn(storeId, taskId);
		const snapshot = await env.task.snapshotIn(storeId);
		const manifest = snapshot.capabilities[taskId];
		const observation = run === void 0 || env.observeSession === void 0 ? void 0 : await env.observeSession(run.sessionId).catch(() => void 0);
		const grantedSkills = manifest === void 0 ? void 0 : [...new Set(Object.values(manifest.capabilities).flatMap((entry) => entry.skills))].sort();
		const grantedTools = manifest === void 0 ? void 0 : [...new Set(Object.values(manifest.capabilities).flatMap((entry) => entry.tools))].sort();
		/** Granted MCP servers' tool prefix (`mcp__<server>__`): their calls ride the spawn-mounted plane, outside the label/baseline vocabulary. */
		const mcpPrefixes = manifest === void 0 ? [] : [...new Set(Object.values(manifest.capabilities).flatMap((entry) => entry.mcpServers ?? []))].map((name) => `mcp__${name}__`);
		const baseline = workerBaseline();
		const recorded = criteria ?? [];
		/** Loaded skill names, deduplicated, and the ones no granted capability covers. */
		const loadedSkills = observation?.skillCalls === void 0 ? void 0 : [...new Set(observation.skillCalls)].sort();
		const contextEfficiency = observation === void 0 || observation.tokens === void 0 && observation.compactions === void 0 ? void 0 : {
			...observation.tokens === void 0 ? {} : { tokens: { ...observation.tokens } },
			...observation.compactions === void 0 ? {} : { compactions: observation.compactions }
		};
		const dimensions = {
			outcomeCorrectness: {
				outcome,
				criteriaCount: recorded.length,
				unmetCriterionIds: recorded.filter((item) => item.verdict !== "pass").map((item) => item.criterionId)
			},
			taskSpecification: {
				objectivePresent: task.objective.trim().length > 0,
				criteriaCount: task.acceptanceCriteria.length,
				criteriaWithCommand: task.acceptanceCriteria.filter((item) => item.command !== void 0).length
			},
			acceptance: { criteria: task.acceptanceCriteria.map((item) => ({
				criterionId: item.criterionId,
				mode: item.verificationMode,
				hasCommand: item.command !== void 0,
				mandatory: item.mandatory
			})) },
			decomposition: {
				depth: task.depth,
				decompositionStatus: task.decompositionStatus,
				childCount: task.childTaskIds.length,
				incomingEdges: snapshot.edges.filter((edge) => edge.to === taskId).length,
				outgoingEdges: snapshot.edges.filter((edge) => edge.from === taskId).length
			},
			...manifest === void 0 ? {} : { capabilityCoverage: {
				closure: manifest.closure,
				granted: capabilitySnapshot(manifest),
				missing: [...manifest.missing]
			} },
			...grantedSkills === void 0 ? {} : { skillFit: {
				granted: grantedSkills,
				...loadedSkills === void 0 ? {} : {
					loaded: loadedSkills,
					loadedOutsideGrant: loadedSkills.filter((name) => !grantedSkills.includes(name))
				}
			} },
			...grantedTools === void 0 ? {} : { toolFit: {
				granted: grantedTools,
				...observation?.tools === void 0 ? {} : {
					called: observation.tools.calls.map((call) => ({ ...call })),
					calledOutsideGrant: observation.tools.calls.map((call) => call.name).filter((name) => !grantedTools.includes(name) && !baseline.includes(name) && !mcpPrefixes.some((prefix) => name.startsWith(prefix))).sort()
				}
			} },
			...contextEfficiency === void 0 ? {} : { contextEfficiency }
		};
		const calls = observation?.tools === void 0 ? void 0 : observation.tools.calls.reduce((sum, call) => sum + call.count, 0);
		const metrics = {
			...observation?.tokens === void 0 ? {} : { tokens: { ...observation.tokens } },
			...calls === void 0 || observation?.tools === void 0 ? {} : { toolCalls: {
				calls,
				failures: observation.tools.failures
			} },
			...observation?.humanInterventions === void 0 ? {} : { humanInterventions: observation.humanInterventions },
			...run === void 0 || task.runIds.length === 0 ? {} : { retries: task.runIds.length - 1 },
			...criteria === void 0 ? {} : { evidenceLogs: criteria.filter((item) => item.logRef !== void 0).length }
		};
		return {
			dimensions,
			...Object.keys(metrics).length === 0 ? {} : { metrics }
		};
	} catch {
		return {};
	}
}
/**
* Safety net around one verifier call. The verifier holds its own deadline
* (`timeoutMs` goes down with every call) and kills whatever it started, so
* this only fires when a verifier ignores its deadline entirely: it gets
* `timeoutMs + VERIFY_SAFETY_MARGIN_MS` before the cascade gives up on it,
* marks the run failed, and walks on. The abandoned promise keeps a handler
* attached — it may still settle (and reject) long after the race is lost, and
* that must never surface as an unhandled rejection.
*/
async function withTimeout(work, timeoutMs, runId) {
	work.catch(() => {});
	const budgetMs = timeoutMs + VERIFY_SAFETY_MARGIN_MS;
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`task-runtime: verification of run "${runId}" timed out after ${budgetMs}ms (verifier deadline ${timeoutMs}ms + ${VERIFY_SAFETY_MARGIN_MS}ms safety margin)`)), budgetMs);
		if (typeof timer.unref === "function") timer.unref();
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
/** Hand the verifier its own deadline and keep the safety net one margin behind it. */
function verifyWithDeadline(env, storeId, runId) {
	return withTimeout(env.verifyRun(storeId, runId, { timeoutMs: env.verifyTimeoutMs }), env.verifyTimeoutMs, runId);
}
/**
* The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
* a root agent reads at each of the three trigger sites. The escalation ledger
* and its tool live on the root plane (agent-singularity): a card carries a
* human-approval gate that belongs on the root's tool surface, so the
* orchestrator only points at the exit — it never calls across planes and never
* blocks a cascade on a human answer.
*/
function escalationHint(what, tried, suggested) {
	return `L4 exit (KISS §7): report this to a human with the escalate tool — what: ${what}; tried: ${tried}; suggested: ${suggested}`;
}
/** The forced-exit reason for an in-flight budget exhaustion (KISS §5: named as a budget exhaustion, never as a criteria failure). */
function budgetExhaustedReason(which, detail) {
	return `budget exhausted: ${which} (${detail}; this is a budget exhaustion, not a criteria failure) — ${escalationHint("the run cannot finish inside its wall-clock budget", "the run was cancelled at the deadline", "raise the budget, split the task, or accept the partial result")}`;
}
/**
* The post-hoc half of the budget (see {@link BudgetConfig}): the members the
* orchestrator cannot observe in flight are checked once, at terminal time,
* against the run's session observation, and a breach is recorded as an
* anomaly — never presented as enforcement, never flipping a verdict.
* Best-effort like the enrichment read: no budget, no reader, or no
* observation means no annotation.
*/
async function budgetBreaches(env, run) {
	const budget = env.budget;
	if (budget === void 0 || env.observeSession === void 0) return [];
	if (budget.maxToolCalls === void 0 && budget.tokens === void 0) return [];
	const observation = await env.observeSession(run.sessionId).catch(() => void 0);
	if (observation === void 0) return [];
	const breaches = [];
	if (budget.maxToolCalls !== void 0 && observation.tools !== void 0) {
		const calls = observation.tools.calls.reduce((sum, call) => sum + call.count, 0);
		if (calls > budget.maxToolCalls) breaches.push(`budget exceeded: maxToolCalls (observed ${calls} tool calls over the limit ${budget.maxToolCalls}; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint("the run already spent more tool calls than its budget allows", "the run finished before the breach was observable", "raise the budget, split the task, or accept the overspend")}`);
	}
	if (budget.tokens !== void 0 && observation.tokens !== void 0) {
		const tokens = observation.tokens;
		const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
		if (total > budget.tokens) breaches.push(`budget exceeded: tokens (observed ${total} whole-session tokens over the limit ${budget.tokens}; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint("the run already spent more tokens than its budget allows", "the run finished before the breach was observable", "raise the budget, split the task, or accept the overspend")}`);
	}
	return breaches;
}
/**
* Await a spawned worker's idle under the caller's abort signal and the run's
* wall-clock budget. The budget is the one member the orchestrator can enforce
* in flight: on exhaustion it cancels the agent and reports
* `budget-exhausted`, and the caller settles the run failed with a budget
* reason — never a criteria failure (KISS §5: no silent degradation). The
* losing branch of the race keeps its handlers attached, so a worker that
* settles after its budget already fired never surfaces an unhandled
* rejection.
*/
async function awaitWorker(handle, signal, wallTimeMs) {
	const cancel = () => handle.agent.cancel({ kind: "parent" });
	signal?.addEventListener("abort", cancel, { once: true });
	let timer;
	try {
		const branches = [handle.agent.whenIdle().then(() => ({ kind: "idle" })).catch((error) => isAborted(signal) ? { kind: "aborted" } : {
			kind: "failed",
			reason: message(error)
		})];
		if (wallTimeMs !== void 0) branches.push(new Promise((resolve$1) => {
			timer = setTimeout(() => resolve$1({ kind: "budget-exhausted" }), wallTimeMs);
			if (typeof timer.unref === "function") timer.unref();
		}));
		const settled = await Promise.race(branches);
		if (settled.kind === "budget-exhausted") cancel();
		if (settled.kind === "idle" && isAborted(signal)) return { kind: "aborted" };
		return settled;
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
async function evidenceRefsFor(env, storeId, runId) {
	return (await env.task.snapshotIn(storeId)).evidence.filter((item) => item.taskRunId === runId).map((item) => item.evidenceId);
}
/** Run start → terminal transition in ms; the terminal mark just landed, so finishedAt is in the store. */
async function runDurationMs(env, storeId, run) {
	const finishedAt = (await env.task.runIn(storeId, run.runId)).finishedAt;
	const end = finishedAt === void 0 ? Date.now() : Date.parse(finishedAt);
	return Math.max(0, end - Date.parse(run.startedAt));
}
/** Tail of the first unmet criterion that has a log; a missing reader or log keeps the field off the record. */
async function failedLogTail(env, unmet, results) {
	if (env.readLogTail === void 0) return void 0;
	const logRef = unmet.map((item) => results.find((result) => result.criterionId === item.criterionId)).find((result) => result?.logRef !== void 0)?.logRef;
	if (logRef === void 0) return void 0;
	try {
		return await env.readLogTail(logRef);
	} catch {
		return;
	}
}
/**
* Every run walked to a terminal state gets exactly one review record, written
* in the same moment right after the terminal status event — the discipline
* the run cascade and the replay runner share. The dimensions and effort
* metrics are derived alongside (§2.7.3) on a best-effort basis — see
* {@link reviewEnrichment} — and never gate the record itself.
*/
async function recordTerminalReview(env, storeId, taskId, outcome, options = {}) {
	const enrichment = await reviewEnrichment(env, storeId, taskId, outcome, options.run, options.criteria);
	const breaches = options.run === void 0 ? [] : await budgetBreaches(env, options.run);
	await env.task.recordReviewIn(storeId, {
		taskId,
		...options.run === void 0 ? {} : {
			runId: options.run.runId,
			sessionId: options.run.sessionId
		},
		outcome,
		evidenceRefs: options.run === void 0 ? [] : await evidenceRefsFor(env, storeId, options.run.runId),
		anomalies: [...options.anomalies ?? [], ...breaches],
		...options.localizedCause === void 0 ? {} : { localizedCause: options.localizedCause },
		...options.relatedTaskIds === void 0 || options.relatedTaskIds.length === 0 ? {} : { relatedTaskIds: [...options.relatedTaskIds] },
		...options.run === void 0 ? {} : { durationMs: await runDurationMs(env, storeId, options.run) },
		...options.criteria === void 0 ? {} : { criteria: options.criteria.map((item) => ({ ...item })) },
		...options.logTail === void 0 ? {} : { logTail: options.logTail },
		...options.blockedBy === void 0 ? {} : { blockedBy: options.blockedBy.map((item) => ({ ...item })) },
		...enrichment.dimensions === void 0 ? {} : { dimensions: enrichment.dimensions },
		...enrichment.metrics === void 0 ? {} : { metrics: enrichment.metrics }
	}, env.actor);
}
/**
* Refuse a dangling preset before the spawn attempt: when the deployment
* cannot mount the resolved preset, throw an error naming the preset and the
* capabilities that granted it — the spawn catch walks the run to `failed`
* with that cause, so a bad capability table entry can never leave a ghost
* task.
*/
async function assertPresetUsable(env, manifest, preset) {
	if (preset === void 0 || env.assertPreset === void 0) return;
	try {
		await env.assertPreset(preset);
	} catch (error) {
		const grantedBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => entry.preset === preset ? [name] : []);
		throw new Error(`task-runtime: preset "${preset}"${grantedBy.length === 0 ? "" : ` granted by capabilities [${grantedBy.join(", ")}]`} is not mountable: ${message(error)}`);
	}
}
/**
* The strictest permission preset a manifest's capabilities declare. Unknown
* names throw here (through the registry's resolve) so the spawn catch walks
* the run to `failed` with the cause named — same discipline as
* assertPresetUsable. Without a spec resolver (test contexts) the first
* declared name passes through and the spawn's own set() validates it.
*/
function permissionFor(env, manifest) {
	if (Object.values(manifest.capabilities).every((entry) => entry.permission === void 0)) return void 0;
	if (env.resolvePermissionSpec === void 0) return Object.values(manifest.capabilities).find((entry) => entry.permission !== void 0)?.permission;
	try {
		return resolvePermission(manifest, env.resolvePermissionSpec);
	} catch (error) {
		const declaredBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => entry.permission === void 0 ? [] : [name]);
		throw new Error(`task-runtime: permission declared by capabilities [${declaredBy.join(", ")}] is not usable: ${message(error)}`);
	}
}
/** Run statuses that end a run: the states a batch adopts instead of driving further. */
const TERMINAL_RUN_STATUSES = new Set([
	"verified",
	"failed",
	"cancelled",
	"blocked"
]);
function isTerminalRun(status) {
	return TERMINAL_RUN_STATUSES.has(status);
}
/** Task statuses that end a child — a child in one of these is adopted, never started again. */
const TERMINAL_TASK_STATUSES = new Set([
	"verified",
	"failed",
	"blocked",
	"cancelled"
]);
/**
* One batch's children in the batch's own order, with each child's dependencies
* mapped from task ids back to batch positions: the store is the only source of
* the batch's shape, so a driver that re-reads it every round (a resumed batch
* included) reads the same list the admission wrote.
*
* The members are the batch's own ({@link batchMembers}), never the parent
* task's children: a task's children are every batch it ever admitted, and a
* second batch must be driven as its own batch — positions it names are its own
* (§4's batch-local index).
*/
function batchItems(memberTaskIds, edges) {
	const position = new Map(memberTaskIds.map((taskId, index) => [taskId, index]));
	return memberTaskIds.map((taskId, index) => ({
		index,
		taskId,
		dependsOn: edges.filter((edge) => edge.to === taskId).map((edge) => position.get(edge.from)).filter((from) => from !== void 0).sort((left, right) => left - right)
	}));
}
/** The latest run the store records for a task, or `undefined` when it has none (never started). */
function latestRun(snapshot, taskId) {
	return [...snapshot.runs].reverse().find((run) => run.taskId === taskId);
}
function taskOf(snapshot, taskId) {
	return snapshot.tasks.find((task) => task.taskId === taskId);
}
/**
* One child's outcome as the store records it. A child that never reached a
* terminal state in a settled batch has no outcome to report and is named
* `failed` — the batch is over, so a still-running child is a defect of the
* settlement, never evidence of work in progress.
*
* `memberTaskIds` names the batch whose outcomes are asked for, and is the only
* thing that decides whose outcomes are read. A run admits more than one batch
* (K1) and the task's children are *every* batch's, so there is no default here:
* a caller either holds the batch's recorded members or it cannot ask this
* question.
*/
async function deriveChildOutcomes(task, storeId, parentTaskId, memberTaskIds) {
	const snapshot = await task.snapshotIn(storeId);
	if (taskOf(snapshot, parentTaskId) === void 0) return [];
	return memberTaskIds.map((taskId) => {
		const instance = taskOf(snapshot, taskId);
		const run = latestRun(snapshot, taskId);
		const status = instance?.status;
		const evidenceId = run === void 0 ? void 0 : snapshot.evidence.find((item) => item.taskRunId === run.runId)?.evidenceId;
		const outcome = status === "verified" || status === "failed" || status === "blocked" || status === "cancelled" ? status : "failed";
		return {
			taskId,
			...run === void 0 ? {} : { runId: run.runId },
			status: outcome,
			...evidenceId === void 0 ? {} : { evidenceId }
		};
	});
}
/** Best-effort owner notification; a deployment without the seam, or a throwing one, changes nothing. */
function notifyOwner(env, sessionId, text$1) {
	if (sessionId === void 0 || env.notify === void 0) return;
	try {
		env.notify(sessionId, text$1);
	} catch {}
}
/** The workspace this orchestration may own, when the deployment names one. */
function workspaceOf(env) {
	if (env.workspaces === void 0 || env.workspacePath === void 0) return void 0;
	return {
		registry: env.workspaces,
		workspace: env.workspacePath
	};
}
function runOwner(storeId, taskId, runId) {
	return {
		kind: "run",
		storeId,
		taskId,
		runId,
		since: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function batchOwner(storeId, taskId, batchId) {
	return {
		kind: "batch",
		storeId,
		taskId,
		batchId,
		since: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/**
* Hand the workspace from the holder that has it to `next`, checking that the
* holder is the one the caller believes it is.
*
* The check is on identity, not on `since`: a handover names the holder that is
* actually on top, and the registry's stack key includes the instant it was
* taken — an instant no caller can re-derive later. So the caller states who it
* expects (`expected`), this reads the actual top, and only an identity match
* proceeds; a mismatch is a named diagnostic instead of a silent pop, because
* popping the wrong layer hands the checkout to a writer while another writer
* still believes it holds it. `undefined` means "no expectation" (a fresh hold).
*/
async function handOverWorkspace(env, next, expected, sessionId, what) {
	const held = workspaceOf(env);
	if (held === void 0) return { ok: true };
	const top = held.registry.ownerOf(held.workspace);
	if (!expected(top)) {
		const reason = `workspace ${held.workspace} is not held by the writer ${what} expected: ${top === void 0 ? "this process holds no claim on it" : `its holder is ${describeOwner(top)}`}`;
		notifyOwner(env, sessionId, `task-runtime: ${reason}`);
		return {
			ok: false,
			reason
		};
	}
	await held.registry.push(held.workspace, top, next);
	return { ok: true };
}
/** Release one layer the caller knows is on top, reporting — never hiding — a mismatch. */
async function releaseWorkspaceLayer(env, owner, sessionId) {
	const held = workspaceOf(env);
	if (held === void 0) return;
	const { conflict } = await releaseLayer(held.registry, held.workspace, (top) => top.kind === owner.kind && top.storeId === owner.storeId && top.taskId === owner.taskId && top.runId === owner.runId && top.batchId === owner.batchId);
	if (conflict === void 0) return;
	if (conflict.storeId === owner.storeId) return;
	notifyOwner(env, sessionId, `task-runtime: workspace ${held.workspace} was expected to be released by ${describeOwner(owner)}, but its holder is ${describeOwner(conflict)}; the layer is left in place`);
}
/**
* Hold the workspace for one verifier call: the verification reads the result
* exclusively, so the run's own hold is handed to a `verifier` layer and
* released when the call returns (§3.4's stack: run → batch → child run →
* verifier).
*
* A workspace held by *another store*, or by nobody at all while this
* deployment claims a path, refuses the verification by name: a verifier's
* commands would otherwise run in a checkout another writer holds, and that is
* the one thing this rule exists to prevent (§3.4's "the verifier's execution
* is exclusive too"). The checkout's own store is a different case and is
* accepted: one store is one tree the runtime serializes, and a *recovery* that
* rebuilt the stack holds the root's layer while a resumed verification runs.
*
* The refusal throws, so the submission's settlement fails the run with the
* reason on its review record — the same shape every other unverifiable run
* gets, never a verdict about bytes nothing can vouch for.
*/
async function withVerifierWorkspace(env, storeId, taskId, runId, sessionId, work) {
	const held = workspaceOf(env);
	if (held === void 0 || env.workspaces === void 0) return await work();
	const top = held.registry.ownerOf(held.workspace);
	if (top === void 0 || top.storeId !== storeId) throw new Error(`task-runtime: run "${runId}" cannot be verified: its workspace ${held.workspace} is ${top === void 0 ? "held by nobody in this process" : `held by ${describeOwner(top)}`}, not by store ${storeId}; a verifier runs only while the run's own store holds the workspace it judges`);
	const verifier = {
		kind: "verifier",
		storeId,
		taskId,
		runId,
		since: (/* @__PURE__ */ new Date()).toISOString()
	};
	await held.registry.push(held.workspace, top, verifier);
	try {
		return await work();
	} finally {
		await releaseWorkspaceLayer(env, verifier, sessionId);
	}
}
/**
* Wait for one run's terminal status. The subscription is taken first (through
* {@link OrchestrateEnv.watchRun}, which subscribes and then reads the current
* state), so a run that settled between the caller's read and this call is
* reported rather than missed. A deployment without the watcher cannot promise
* a settlement, and says so by name instead of waiting forever.
*/
async function waitRunTerminal(env, storeId, runId) {
	const current = await env.task.runIn(storeId, runId);
	if (isTerminalRun(current.status)) return current.status;
	if (env.watchRun === void 0) throw new RunWatcherUnavailableError(`task-runtime: cannot observe run "${runId}" reaching a terminal state: this deployment wires no run watcher, so no honest settlement is possible`);
	return await new Promise((resolve$1) => {
		let settled = false;
		const unsubscribe = env.watchRun;
		const off = unsubscribe(storeId, runId, (status) => {
			if (settled || !isTerminalRun(status)) return;
			settled = true;
			off?.();
			resolve$1(status);
		});
		if (settled) off?.();
	});
}
/** True when the agent behind a handle is mid-turn: idle then means "waiting for the model", not "done". */
function agentIsRunning(handle) {
	return handle.agent.status === "running";
}
function sleep(ms) {
	return new Promise((resolve$1) => {
		setTimeout(resolve$1, ms);
	});
}
/** How long a batch waits for a settled run's own settlement to finish before adopting the state as it stands. */
const SETTLEMENT_TAIL_WINDOW_MS = 2e3;
/** How often that wait re-reads the gate's phase. Short: the tail it waits for is a store write away. */
const SETTLEMENT_POLL_MS = 5;
/**
* Wait for one run to be terminal *and* settled: the status event, and then the
* in-process settlement that wrote it — whose last act is closing the gate for
* the run's session.
*
* The two are not the same instant, and the gap matters. The terminal status is
* written before the settlement's review record and before the workspace layer
* it held comes off the stack, so a batch that adopted the status alone could
* start its next child into a checkout the previous one has not released yet, or
* report a batch as settled while a child's record is still being written. The
* gate is the completion signal because this runtime closes it after the record
* is in the store (`onRunSettled`); a session the gate knows nothing about is a
* run this process is not settling (a recovery adoption, a foreign writer) and
* has nothing to wait for.
*
* Bounded: a settlement that never closes the gate is reported and the terminal
* state adopted as it stands, rather than hanging the batch on it.
*/
async function waitRunSettled(env, storeId, runId, sessionId) {
	const status = await waitRunTerminal(env, storeId, runId);
	const deadline = Date.now() + SETTLEMENT_TAIL_WINDOW_MS;
	for (;;) {
		const phase = env.gate.phaseOf(sessionId);
		if (phase === void 0 || phase === "terminal") return status;
		if (Date.now() >= deadline) {
			notifyOwner(env, sessionId, `task-runtime: run "${runId}" is ${status} but its settlement has not closed the gate for session ${sessionId} after ${SETTLEMENT_TAIL_WINDOW_MS}ms; the batch adopts the terminal state as it stands`);
			return status;
		}
		await sleep(SETTLEMENT_POLL_MS);
	}
}
/** The reminder a worker that went idle without submitting gets, once per no-progress streak. */
function idleReminderText(run, rounds, limit) {
	return `task-runtime: session ${run.sessionId} went idle without submitting its result. If the work is done, call task_submit_result with a summary and the evidence you produced — an idle session is not a completion, and the runtime is counting no-progress rounds (${rounds} of ${limit} before this run is stopped).`;
}
/** The stop reason for a worker that never submitted: a budget stop on the no-progress rule, never a criteria verdict. */
function noProgressReason(rounds, factCount, limit) {
	return `no progress: the worker went idle without submitting ${rounds} time(s) in a row and its subtree gained no new facts (last count ${factCount}); stopped at the no-progress limit of ${limit} round(s) — this is a budget stop on the no-progress rule, not a criteria failure — ` + escalationHint("the run stopped producing facts and never called task_submit_result", `${rounds} idle round(s) with an unchanged subtree fact count`, "split the task further, make the acceptance criteria explicit, or accept the partial result");
}
/**
* Watch one spawned worker until its run settles, its budget runs out, or its
* batch is cancelled — the one wait every worker path shares (`runReplayTask`
* and the batch driver).
*
* The three inputs are raced, not sequenced: the store's own terminal state
* (the submission path, a nested batch, a cancellation written elsewhere), the
* worker's idle, and the deadline. Idle is *not* completion (A3's core
* correction): the loop reads the run's phase before deciding what idle means.
* `waiting_children` and `submitted` mean the run is legitimately waiting, so
* the idle observation stops and only the terminal state is awaited — marking
* progress there would count a wait as stagnation. `active` means a submission
* was due: if the agent is mid-turn the runtime waits (a reminded worker needs a
* turn to react), otherwise the round is marked and, at the limit, the run is
* stopped with the no-progress reason.
*
* The deadline comes from the run's own persisted `startedAt` through
* {@link remainingRunMs}: a run resumed in a new process keeps the clock it
* started with (§3.5, §7.4).
*/
async function observeWorkerRun(env, storeId, task, run, handle, signal) {
	const recorded = waitRunSettled(env, storeId, run.runId, run.sessionId);
	recorded.catch(() => {});
	const terminal = recorded.then((status) => ({
		kind: "terminal",
		status
	}));
	const rootDeadline = await rootDeadlineOf(env, storeId);
	for (;;) {
		const remaining = remainingRunMs(env, run, rootDeadline, Date.now());
		if (remaining <= 0) {
			handle.agent.cancel({ kind: "parent" });
			return { kind: "budget-exhausted" };
		}
		const settled = await Promise.race([terminal, awaitWorker(handle, signal, remaining)]);
		if (settled.kind !== "idle") return settled;
		const current = await env.task.runIn(storeId, run.runId);
		if (isTerminalRun(current.status)) return {
			kind: "terminal",
			status: current.status
		};
		const phase = current.executionPhase;
		if (phase === "waiting_children" || phase === "submitted") return await awaitWaitingTerminal(env, run, () => handle.agent.cancel({ kind: "parent" }), signal, rootDeadline, terminal);
		if (agentIsRunning(handle)) continue;
		const snapshot = await env.task.snapshotIn(storeId);
		if (openProposalOf(snapshot, task.taskId, run.runId) !== void 0 || blockingQuestionsOf(snapshot, run.runId).length > 0) return await awaitWaitingTerminal(env, run, () => handle.agent.cancel({ kind: "parent" }), signal, rootDeadline, terminal);
		const factCount = countSubtreeFacts(snapshot, task.taskId);
		const previous = current.noProgress;
		const rounds = (previous?.factCount === factCount ? previous.rounds : 0) + 1;
		const note = `the worker session went idle without submitting; the subtree holds ${factCount} fact(s), ${previous?.factCount === factCount ? `unchanged since round ${previous?.rounds}` : "a change since the last marking"} (round ${rounds} of ${env.noProgressRounds})`;
		await env.task.markRunProgressIn(storeId, task.taskId, run.runId, env.actor, {
			kind: "unsubmitted-idle",
			rounds,
			factCount,
			note
		});
		if (rounds >= env.noProgressRounds) return {
			kind: "no-progress",
			rounds,
			reason: noProgressReason(rounds, factCount, env.noProgressRounds)
		};
		if (rounds === 1) notifyOwner(env, run.sessionId, idleReminderText(run, rounds, env.noProgressRounds));
	}
}
/**
* Wait for one run that is *waiting* — its own batch is running, or its
* submission is inside verification — under the two bounds the active case also
* runs under: the run's own deadline (`min` of its wall time, what is left of the
* root's, and the instant a caller placed on it — all measured from its persisted
* `startedAt`, {@link remainingRunMs}) and the batch's abort. Idle is the one
* input that stops here, because an idle worker in these phases is expected
* rather than progress: waiting on the store's terminal state is the only honest
* observation left, and marking a round would count a legitimate wait as
* stagnation.
*
* The abort is what a batch cancellation rides: a driver parked here without it
* would leave `cancelBatch` waiting for a settlement nobody produces — the
* children it never started stay unblocked and the workspace layer stays held —
* and the unload path would hang behind the same promise.
*
* The cancellation is handed in as a callback rather than an `AgentHandle`
* because the two callers hold different things: the round that started a
* worker has its handle, while the batch driver adopting a question-waiting
* child out of a store has only the session id and asks the deployment to
* resolve the agent (A4 §F.1 — the deadline ends a recovered wait exactly as it
* ends a live one, so this is one implementation, not two).
*/
async function awaitWaitingTerminal(env, run, cancel, signal, rootDeadline, terminal) {
	const stop = () => {
		cancel?.();
	};
	if (isAborted(signal)) {
		stop();
		return { kind: "aborted" };
	}
	const remaining = remainingRunMs(env, run, rootDeadline, Date.now());
	if (remaining <= 0) {
		stop();
		return { kind: "budget-exhausted" };
	}
	signal?.addEventListener("abort", stop, { once: true });
	let timer;
	try {
		const branches = [terminal];
		if (signal !== void 0) branches.push(new Promise((resolve$1) => {
			signal.addEventListener("abort", () => resolve$1({ kind: "aborted" }), { once: true });
		}));
		branches.push(new Promise((resolve$1) => {
			timer = setTimeout(() => {
				stop();
				resolve$1({ kind: "budget-exhausted" });
			}, remaining);
			if (typeof timer.unref === "function") timer.unref();
		}));
		return await Promise.race(branches);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}
/**
* The cancellation one session's own agent exposes, when this deployment can
* resolve it — what the driver needs to end a wait it did not start (A4 §F.1).
* A deployment that cannot name the agent has no cancellation to hand over, and
* the wait is still bounded by the deadline that settles the run.
*/
function cancelAgentOf(env, sessionId) {
	const agent = env.agentFor?.(sessionId);
	if (agent === void 0) return void 0;
	const cancel = agent.cancel;
	if (typeof cancel !== "function") return void 0;
	return () => {
		cancel.call(agent, { kind: "parent" });
	};
}
/** The root's own deadline for the store, when the budget resolves; a missing root start is a refusal to invent one. */
async function rootDeadlineOf(env, storeId) {
	const resolved = resolveRootBudget(await env.task.snapshotIn(storeId), env.rootBudget ?? {});
	return resolved.ok ? resolved.deadlineAt : void 0;
}
/**
* What is left of the tightest deadline that applies to one run of this
* orchestration — the one call site of `runDeadlineMs` inside the orchestration,
* so the rule reads the same everywhere a worker is awaited: the run's own
* per-run wall time and what is left of the root's deadline. Either reaching
* zero is the budget stop {@link observeWorkerRun} acts on.
*/
function remainingRunMs(env, run, rootDeadline, nowMs) {
	return runDeadlineMs(run.startedAt, env.budget?.wallTimeMs, rootDeadline, nowMs);
}
/**
* The wall-clock bound(s) this orchestration's runs are under, as a terminal
* record names them: what the deployment's per-run budget allows and — when the
* caller could resolve it, which only the batch settlement can, `resolveRootBudget`
* being a store read — the tree's own deadline. Naming every bound in force is
* deliberate: the record says which limits applied, so a reader knows what to
* change, while the tightest of them is the one that ended the run
* (`runDeadlineMs`).
*/
function wallClockBoundsText(env, rootDeadlineAt) {
	const perRun = env.budget?.wallTimeMs;
	const bounds = [...perRun === void 0 ? [] : [`${perRun}ms from its own startedAt`], ...rootDeadlineAt === void 0 ? [] : [`the root tree's deadline ${rootDeadlineAt}`]];
	return bounds.length === 0 ? "the root tree’s own deadline" : bounds.join(", or ");
}
/**
* The wall-clock exhaustion a worker observation is recorded as: the reason
* shape every budget stop carries (KISS §5 — a budget stop is never reported as
* a criteria failure), naming the bound(s) this orchestration's runs are under so
* a reader knows which number to change. A deployment with only its own per-run
* wall time configured gets exactly the text it always had; one whose run was
* placed under a caller's deadline sees that instant named, which is the value
* that actually ended the run.
*/
function wallClockExhaustedReason(env) {
	return budgetExhaustedReason("wallTimeMs", `worker run exceeded its wall-clock budget (${wallClockBoundsText(env)})`);
}
/**
* The reason a batch's parent is cancelled instead of accepted: its run's own
* deadline had already been reached when every child had settled, and an
* acceptance after the deadline is one the budget never allowed (§3.5) — the run
* would be reported `verified` for work the clock had already stopped.
*
* The bound is the run's own (`remainingRunMs`: its per-run wall time, what is left
* of the root's, and any instant its caller placed on it). Every child settling is
* exactly the moment such a deadline can arrive unnoticed by the parent's own
* driver — a replayed worker's sub-execution inherits the parent's instant, so the
* child failing on it is what brings the batch here with the parent's clock already
* run out — and reading it here is the last moment before the acceptance that would
* judge the run. Named as a budget stop, never as a criteria failure.
*/
function parentDeadlinePassedReason(env, rootDeadlineAt) {
	return budgetExhaustedReason("wallTimeMs", `${wallClockBoundsText(env, rootDeadlineAt)} passed before this batch could be accepted, so the parent is cancelled without verification`);
}
/**
* The evidence one child's own submission, verification, or failure left in the
* store. Read back rather than carried: the store is the truth about a run, and
* a resumed batch has no memory of a handle it never held.
*/
function childEvidenceId(snapshot, runId) {
	return snapshot.evidence.find((item) => item.taskRunId === runId)?.evidenceId;
}
/** One child's outcome as the store holds it: the status the run reached and the evidence it left, if any. */
function adoptedOutcome(taskId, runId, status, snapshot) {
	const evidenceId = childEvidenceId(snapshot, runId);
	return {
		taskId,
		runId,
		status,
		...evidenceId === void 0 ? {} : { evidenceId }
	};
}
/**
* Settle one child run from its own state: mark the terminal transition it does
* not have yet, or adopt the one it already has.
*
* The adoption branch is the one that keeps the batch honest about nested
* work: a child whose own worker decomposed is settled by that nested batch —
* by the time this runs, its run is already terminal and carries its own review
* record, so marking it again would be an illegal transition and writing a
* second review would be a bug the store refuses.
*/
async function settleChildRun(env, storeId, child, verdict) {
	const { item, run, dependencyTaskIds } = child;
	const snapshot = await env.task.snapshotIn(storeId);
	const status = snapshot.runs.find((candidate) => candidate.runId === run.runId)?.status ?? run.status;
	if (isTerminalRun(status)) return adoptedOutcome(item.taskId, run.runId, status, snapshot);
	try {
		await env.task.markRunStatusIn(storeId, item.taskId, run.runId, verdict.status, env.actor, { ...verdict.localizedCause === void 0 ? {} : { reason: verdict.localizedCause } });
	} catch (error) {
		const settled = await env.task.runIn(storeId, run.runId).catch(() => void 0);
		if (settled === void 0 || !isTerminalRun(settled.status)) throw error;
		return adoptedOutcome(item.taskId, run.runId, settled.status, await env.task.snapshotIn(storeId));
	}
	await recordTerminalReview(env, storeId, item.taskId, verdict.status, {
		run,
		...verdict.localizedCause === void 0 ? {} : { localizedCause: verdict.localizedCause },
		...verdict.anomalies === void 0 ? {} : { anomalies: verdict.anomalies },
		...verdict.criteria === void 0 ? {} : { criteria: verdict.criteria },
		...verdict.logTail === void 0 ? {} : { logTail: verdict.logTail },
		relatedTaskIds: dependencyTaskIds
	});
	env.onRunSettled?.(storeId, item.taskId, run.runId, verdict.status);
	await releaseWorkspaceLayer(env, runOwner(storeId, item.taskId, run.runId), run.sessionId);
	const evidenceId = childEvidenceId(await env.task.snapshotIn(storeId), run.runId);
	return {
		taskId: item.taskId,
		runId: run.runId,
		status: verdict.status,
		...evidenceId === void 0 ? {} : { evidenceId }
	};
}
/**
* Drive one started child run to its terminal state and adopt it: the batch's
* per-child half of {@link driveBatch}.
*
* Every ending here is named as what it is — a batch abort cancels the child,
* a deadline is a budget stop, an unsubmitted idle is a no-progress stop, a
* worker error is a failure. The submission path does not appear as a branch:
* a run that submitted is settled by {@link settleSubmittedRun} (via the worker
* whose tool call it was), and this only waits for the terminal state that
* settlement writes.
*/
async function driveChildRound(env, batch, child) {
	const { item, task, run, handle, dependencyTaskIds } = child;
	const observation = await observeWorkerRun(env, batch.storeId, task, run, handle, batch.signal);
	switch (observation.kind) {
		case "terminal": {
			const snapshot = await env.task.snapshotIn(batch.storeId);
			const status = snapshot.runs.find((candidate) => candidate.runId === run.runId)?.status ?? observation.status;
			env.onRunSettled?.(batch.storeId, item.taskId, run.runId, status);
			await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), run.sessionId);
			const evidenceId = childEvidenceId(snapshot, run.runId);
			return {
				taskId: item.taskId,
				runId: run.runId,
				status,
				...evidenceId === void 0 ? {} : { evidenceId }
			};
		}
		case "aborted": return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "cancelled",
			anomalies: [`the batch was cancelled while this child ran: ${batch.reason}`]
		});
		case "budget-exhausted": return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "failed",
			localizedCause: wallClockExhaustedReason(env)
		});
		case "no-progress":
			handle.agent.cancel({ kind: "parent" });
			return await settleChildRun(env, batch.storeId, {
				item,
				run,
				dependencyTaskIds
			}, {
				status: "failed",
				localizedCause: observation.reason,
				anomalies: [`no-progress round ${observation.rounds} of ${env.noProgressRounds}`]
			});
		case "failed": return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "failed",
			localizedCause: observation.reason
		});
	}
}
/** Mark one child that never started, and record why — the runless blocked shape the store accepts. */
async function blockChild(env, storeId, item, block, dependencyTaskIds) {
	await env.task.markRunStatusIn(storeId, item.taskId, void 0, "blocked", env.actor, { reason: block.reason });
	await recordTerminalReview(env, storeId, item.taskId, "blocked", {
		anomalies: [block.reason],
		relatedTaskIds: dependencyTaskIds,
		blockedBy: block.blockers.map((blocker) => ({
			taskId: blocker.taskId,
			outcome: blocker.outcome
		}))
	});
	return {
		taskId: item.taskId,
		status: "blocked"
	};
}
/** Every child that never started, settled with the same reason — the batch never leaves an admitted ghost behind. */
async function blockUnstarted(env, storeId, snapshot, items, why) {
	const blocked = [];
	for (const item of items) {
		const task = taskOf(snapshot, item.taskId);
		if (task === void 0 || task.status === "verified" || task.status === "failed" || task.status === "blocked" || task.status === "cancelled") continue;
		if (latestRun(snapshot, item.taskId) !== void 0) continue;
		const dependencyTaskIds = item.dependsOn.map((dependency) => items[dependency].taskId);
		blocked.push(await blockChild(env, storeId, item, why(item), dependencyTaskIds));
	}
	return blocked;
}
/**
* Block every child of one batch that never started, naming one reason — the
* runtime-level entry for the paths that settle a batch without a driver
* (`failBatch`, and the fallback for a driver that rejected before it settled
* anything).
*
* It is {@link blockUnstarted} over the members the caller read from the batch's
* own record rather than over a `BatchContext` the caller no longer holds, so the
* *rule* — a child with no run and no terminal state is blocked, one that already
* ran is left to its own settlement — stays in one place and the runtime's failure
* seams share it with the driver. The batch's members are passed in, never
* re-derived from the parent task: a parent task's children are every batch it
* ever admitted, and this call ends one batch.
*/
async function blockUnstartedChildren(env, storeId, memberTaskIds, reason) {
	const snapshot = await env.task.snapshotIn(storeId);
	return await blockUnstarted(env, storeId, snapshot, batchItems(memberTaskIds, snapshot.edges), () => ({
		reason,
		blockers: []
	}));
}
/**
* Start one child of an admitted batch: every check the batch's admission could
* not make (the evidence a criterion needs, the run budget that was reserved
* but not yet charged) plus the run's own record, its content binding, the
* workspace handover and the spawn.
*
* The run is recorded *before* the spawn attempt — the discipline the cascade
* always had — so a refusal at any of those steps settles a run that exists
* rather than leaving a child admitted with no way to reach a terminal state.
* The binding is written before the run is recorded (S1-C), and a batch resumed
* in a new process rebuilds its provider verdicts here (there is nothing to
* carry over, and the pre-check is the one honest replacement).
*/
async function startChildRound(env, batch, parentTask, parentRun, items, item, snapshot) {
	const task = taskOf(snapshot, item.taskId);
	if (task === void 0) throw new Error(`task-runtime: batch ${batch.batchId} names child "${item.taskId}", which the store does not hold`);
	const dependencyTaskIds = item.dependsOn.map((dependency) => items[dependency].taskId);
	const manifest = snapshot.capabilities[item.taskId];
	const budget = resolveRootBudget(snapshot, env.rootBudget ?? {});
	if (!budget.ok) {
		if (hasRootLimits(env.rootBudget)) return {
			kind: "adopted",
			outcome: await blockChild(env, batch.storeId, item, {
				reason: `the root budget cannot be resolved: ${budget.reason}`,
				blockers: []
			}, dependencyTaskIds)
		};
	} else {
		const verdict = checkRunStart(snapshot, budget);
		if (!verdict.allowed) return {
			kind: "adopted",
			outcome: await blockChild(env, batch.storeId, item, {
				reason: verdict.reason,
				blockers: []
			}, dependencyTaskIds)
		};
	}
	const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, snapshot);
	if (missingArtifacts.length > 0) {
		const reason = missingArtifactReason(missingArtifacts);
		const blocked = await blockChild(env, batch.storeId, item, {
			reason,
			blockers: []
		}, dependencyTaskIds);
		for (const missing of missingArtifacts) {
			const verified = missing.requirement === "requires";
			await env.task.recordObligationIn(batch.storeId, {
				obligationId: `o-${randomUUID()}`,
				goal: `artifact/evidence "${missing.ref}" required by task "${item.taskId}" criterion ${missing.criterionId} does not exist in the task store${verified ? " as a verified reference product" : ""}`,
				criterion: verified ? `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict` : `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id)`,
				sourceTaskId: item.taskId
			}, env.actor);
		}
		return {
			kind: "adopted",
			outcome: blocked
		};
	}
	if (manifest === void 0) {
		const reason = `capability manifest for child "${item.taskId}" is missing from the store; the run cannot be started without one`;
		return {
			kind: "adopted",
			outcome: await blockChild(env, batch.storeId, item, {
				reason,
				blockers: []
			}, dependencyTaskIds)
		};
	}
	const runId = `r-${randomUUID()}`;
	const sessionId = `s-${randomUUID()}`;
	const dependencyEvidence = snapshot.evidence.filter((evidence) => dependencyTaskIds.includes(evidence.taskId)).map((evidence) => evidence.evidenceId);
	const handoff = {
		...buildHandoff({
			parentTask,
			parentRun,
			childTask: task,
			reason: batch.reason,
			callerSessionId: batch.callerSessionId,
			assumptions: [...task.contract?.assumptions ?? [], ...dependencyEvidence.map((evidenceId) => `dependency evidence "${evidenceId}" is verified and available as a reference`)],
			constraints: task.contract?.constraints ?? [],
			relevantEvidence: dependencyEvidence
		}),
		handoffId: `h-${runId}`
	};
	if (!snapshot.handoffs.some((existing) => existing.handoffId === handoff.handoffId)) await env.task.recordHandoffIn(batch.storeId, handoff, env.actor);
	const agentPreset = resolvePreset(manifest, env.defaultPreset);
	const name = task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `child-${item.index + 1}`;
	const run = {
		runId,
		taskId: item.taskId,
		sessionId,
		parentRunId: parentRun.runId,
		capabilitySnapshot: capabilitySnapshot(manifest),
		...agentPreset === void 0 ? {} : { agentPreset },
		executionPhase: "active",
		artifacts: [],
		verifierResults: [],
		status: "running",
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	let binding;
	try {
		let providers = batch.providers;
		if (providers === void 0 && env.precheck !== void 0) {
			const fresh = await env.precheck(Object.keys(manifest.capabilities), env.workspacePath);
			const refusals = providerRefusals(fresh);
			if (refusals.length > 0) throw new Error(`the provider pre-check refused this run on resume:\n- ${refusals.join("\n- ")}`);
			providers = fresh;
		}
		binding = await bindRunProviders({
			storeId: batch.storeId,
			runId: run.runId,
			manifest,
			...providers === void 0 ? {} : { providers },
			...env.runBindingRoot === void 0 ? {} : { root: env.runBindingRoot }
		});
	} catch (error) {
		const reason = `content binding failed: ${message(error)}`;
		await env.task.startRunIn(batch.storeId, run, env.actor);
		return {
			kind: "adopted",
			outcome: await settleChildRun(env, batch.storeId, {
				item,
				run,
				dependencyTaskIds
			}, {
				status: "failed",
				localizedCause: reason
			})
		};
	}
	const bound = binding === void 0 ? run : {
		...run,
		providerBinding: binding
	};
	await env.task.startRunIn(batch.storeId, bound, env.actor);
	try {
		await assertPresetUsable(env, manifest, agentPreset);
	} catch (error) {
		return {
			kind: "adopted",
			outcome: await settleChildRun(env, batch.storeId, {
				item,
				run,
				dependencyTaskIds
			}, {
				status: "failed",
				localizedCause: `spawn failed: ${message(error)}`
			})
		};
	}
	const handover = await handOverWorkspace(env, runOwner(batch.storeId, item.taskId, run.runId), (top) => top !== void 0 && top.batchId === batch.batchId, sessionId, `batch ${batch.batchId}`);
	if (!handover.ok) return {
		kind: "adopted",
		outcome: await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "failed",
			localizedCause: `workspace handover refused: ${handover.reason}`
		})
	};
	let handle;
	try {
		const permissionPreset = permissionFor(env, manifest);
		handle = await env.spawn({
			sessionId,
			name,
			taskWorker: true,
			grant: await authorizedGrant(env, manifest, skillRootsForRun([], binding)),
			...agentPreset === void 0 ? {} : { agentPreset },
			...permissionPreset === void 0 ? {} : { permissionPreset },
			...env.workerCwd === void 0 ? {} : { cwd: env.workerCwd },
			...env.agentOptions === void 0 ? {} : { agentOptions: env.agentOptions },
			signal: batch.signal
		});
	} catch (error) {
		await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), sessionId);
		return {
			kind: "adopted",
			outcome: await settleChildRun(env, batch.storeId, {
				item,
				run,
				dependencyTaskIds
			}, {
				status: "failed",
				localizedCause: `spawn failed: ${message(error)}`
			})
		};
	}
	env.gate.setPhase(sessionId, "active");
	env.onRunBound(sessionId, {
		storeId: batch.storeId,
		taskId: item.taskId,
		runId: run.runId
	});
	return {
		kind: "started",
		child: {
			item,
			task,
			run,
			handle,
			dependencyTaskIds
		}
	};
}
/** What the driver does between rounds: everything the store says, and nothing it holds in memory. */
async function driveRounds(env, batch) {
	for (;;) {
		const snapshot = await env.task.snapshotIn(batch.storeId);
		const parentTask = await env.task.taskIn(batch.storeId, batch.parentTaskId);
		const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId);
		const members = batchMembers(parentRun, batch.batchId);
		if (parentRun.status !== "running") {
			const items$1 = batchItems(members, snapshot.edges);
			await blockUnstarted(env, batch.storeId, snapshot, items$1, () => ({
				reason: CANCELLED_BEFORE_START,
				blockers: startedBlocker(snapshot, items$1)
			}));
			return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members);
		}
		const items = batchItems(members, snapshot.edges);
		const pending = items.filter((item$1) => {
			const task = taskOf(snapshot, item$1.taskId);
			return task !== void 0 && !TERMINAL_TASK_STATUSES.has(task.status);
		});
		if (pending.length === 0) return await finishBatch(env, batch);
		if (batch.signal.aborted) {
			await blockUnstarted(env, batch.storeId, snapshot, items, () => ({
				reason: CANCELLED_BEFORE_START,
				blockers: startedBlocker(snapshot, items)
			}));
			return await finishBatch(env, batch);
		}
		const verified = new Set(items.filter((item$1) => taskOf(snapshot, item$1.taskId)?.status === "verified").map((item$1) => item$1.index));
		const ready = pending.filter((item$1) => item$1.dependsOn.every((dependency) => verified.has(dependency))).sort((left, right) => left.index - right.index);
		if (ready.length === 0) {
			await blockUnstarted(env, batch.storeId, snapshot, items, (item$1) => ({
				reason: `dependencies [${item$1.dependsOn.map((dependency) => items[dependency].taskId).join(", ")}] did not verify`,
				blockers: item$1.dependsOn.filter((dependency) => !verified.has(dependency)).map((dependency) => {
					const taskId = items[dependency].taskId;
					return {
						taskId,
						outcome: taskOf(snapshot, taskId)?.status ?? "blocked"
					};
				})
			}));
			return await finishBatch(env, batch);
		}
		const item = ready[0];
		const started = latestRun(snapshot, item.taskId);
		if (started !== void 0) {
			const questionWait = started.executionPhase === "active" && (blockingQuestionsOf(snapshot, started.runId).length > 0 || owedQuestionMessagesTo(snapshot, started.sessionId).length > 0);
			const returnedParent = started.executionPhase === "active" && (started.batches?.length ?? 0) > 0;
			if (questionWait || returnedParent) {
				await awaitAdoptedWorkerWait(env, batch, item, started, item.dependsOn.map((dependency) => items[dependency].taskId));
				continue;
			}
			if (started.executionPhase === "active") {
				const reason = `recovery: run "${started.runId}" was in flight when batch ${batch.batchId} resumed and never submitted; the writes it may already have made cannot be confirmed, so it is settled cancelled rather than resumed`;
				const dependencyTaskIds = item.dependsOn.map((dependency) => items[dependency].taskId);
				await env.task.markRunStatusIn(batch.storeId, item.taskId, started.runId, "cancelled", env.actor, { reason });
				await recordTerminalReview(env, batch.storeId, item.taskId, "cancelled", {
					run: started,
					anomalies: [reason],
					relatedTaskIds: dependencyTaskIds
				});
				env.onRunSettled?.(batch.storeId, item.taskId, started.runId, "cancelled");
				await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, started.runId), started.sessionId);
				continue;
			}
			const status = await waitRunSettled(env, batch.storeId, started.runId, started.sessionId);
			env.onRunSettled?.(batch.storeId, item.taskId, started.runId, status);
			await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, started.runId), started.sessionId);
			continue;
		}
		const attempt = await startChildRound(env, batch, parentTask, parentRun, items, item, snapshot);
		if (attempt.kind === "adopted") continue;
		await driveChildRound(env, batch, attempt.child);
	}
}
/**
* Bring one adopted worker back and wait for its settlement — the batch driver's
* half of the worker recovery (A4 §F.1, K1 §5).
*
* The child this runs for is a run the driver did **not** start, and one of two
* durable facts makes it a *wait* rather than an abandoned worker:
*
* - it has an unresolved blocking question of its own (or an answer it is still
*   owed), which is where the protocol parked it (A4 §F.1);
* - it is a delegated parent whose own batches all ended — `active` with an
*   accumulated `batches` — so the decision the batch handed back is what it is
*   waiting on, and the recovery pass is telling it so (K1 §2, §5).
*
* Its Run identity is untouched; what the dead process could not leave behind is
* its Session, so the runtime's resume door ({@link OrchestrateEnv.resumeWorkerSession})
* is asked to bring it back under that same identity. Three answers are
* possible, and each has a different consequence:
*
* - `live` — the Session is reachable again, so what the child waits for (its
*   parent's answer, or the news that its batch ended) can be delivered to it and
*   the wait can be observed;
* - `retry` — another owner holds the Session. Nothing is taken over and the run
*   keeps its identity; the wait continues (bounded by the deadline) and the
*   next activation retries;
* - `refused` — the identity cannot be established. The child is settled
*   `failed` with the refusal named, because a run in flight that nobody can
*   bring back is a wait with no end, and leaving it `running` would be a lie
*   the store keeps telling.
*
* The wait itself is {@link awaitWaitingTerminal}: the same deadline (the run's
* own `wallTime` and what is left of the root's, both measured from the run's
* persisted `startedAt`) and the same batch abort that every other worker wait
* runs under — the gap this closes is "a recovered wait with no deadline", not a
* new rule about deadlines. The deadline ending here is a budget stop, exactly
* as it is for a run whose worker this process started, and it takes the
* question's derived effects with it: a settled asking run owes no delivery, so
* a late answer is audit rather than a revival.
*/
async function awaitAdoptedWorkerWait(env, batch, item, run, dependencyTaskIds) {
	const resumed = await resumeAdoptedWorker(env, batch.storeId, run);
	if (resumed.status === "refused") {
		const reason = `recovery refused to continue this run: the Session "${run.sessionId}" could not be brought back (${resumed.reason})`;
		return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "failed",
			localizedCause: reason,
			anomalies: [reason]
		});
	}
	if (resumed.status === "retry") notifyOwner(env, run.sessionId, `task-runtime: run "${run.runId}" is waiting on coordination this process cannot hand to it, and its Session "${run.sessionId}" is held by another owner (${resumed.reason}); nothing is taken over, and the wait stays bounded by the run's own deadline`);
	env.gate.setQuestionsBlocked(run.sessionId, blockingQuestionsOf(await env.task.snapshotIn(batch.storeId), run.runId).length > 0);
	if (resumed.status === "live" && env.gate.phaseOf(run.sessionId) === void 0) env.gate.setPhase(run.sessionId, "active");
	const terminal = waitRunSettled(env, batch.storeId, run.runId, run.sessionId).then((status) => ({
		kind: "terminal",
		status
	}));
	const rootDeadline = await rootDeadlineOf(env, batch.storeId);
	const observation = await awaitWaitingTerminal(env, run, cancelAgentOf(env, run.sessionId), batch.signal, rootDeadline, terminal);
	switch (observation.kind) {
		case "terminal": {
			const snapshot = await env.task.snapshotIn(batch.storeId);
			const status = snapshot.runs.find((candidate) => candidate.runId === run.runId)?.status ?? observation.status;
			env.onRunSettled?.(batch.storeId, item.taskId, run.runId, status);
			await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), run.sessionId);
			const evidenceId = childEvidenceId(snapshot, run.runId);
			return {
				taskId: item.taskId,
				runId: run.runId,
				status,
				...evidenceId === void 0 ? {} : { evidenceId }
			};
		}
		case "budget-exhausted": return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "failed",
			localizedCause: wallClockExhaustedReason(env)
		});
		case "aborted": return await settleChildRun(env, batch.storeId, {
			item,
			run,
			dependencyTaskIds
		}, {
			status: "cancelled",
			anomalies: [`the batch was cancelled while this recovered child waited: ${batch.reason}`]
		});
	}
}
/**
* The blockers a cancelled batch names: the siblings that were in flight when it was cancelled.
*/
function startedBlocker(snapshot, items) {
	return items.flatMap((item) => {
		const run = latestRun(snapshot, item.taskId);
		const task = taskOf(snapshot, item.taskId);
		if (run === void 0 || task === void 0 || task.status === "verified") return [];
		return [{
			taskId: item.taskId,
			outcome: task.status
		}];
	});
}
/** The store's own account of how a batch's children ended, one `2 verified` per status. */
function outcomeTally(outcomes) {
	const counts = /* @__PURE__ */ new Map();
	for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
	return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${count} ${status}`).join(", ");
}
/** {@link outcomeTally} named by the batch it belongs to — what a batch end reports. */
function batchSummary(batchId, outcomes) {
	return `batch ${batchId} ended: ${outcomes.length === 0 ? "no children" : outcomeTally(outcomes)}`;
}
/**
* The `m-` identity one ended batch's result message carries: derived from the
* batch id, never minted — the same derivation `questionMessageIdOf` makes for a
* question, and for the same reason. A retry in this process or after a restart
* states the same identity, so the target's own fold answers "this one is
* already here" instead of the runtime keeping a ledger of what it sent.
*/
function batchEndMessageId(batchId) {
	return `m-batchend-${batchId}`;
}
/**
* The body one batch-end message carries, rendered from the store's own account
* of the batch: every member's terminal state and the evidence it left, and what
* the parent may do now. It is reprojected from the facts on every call (never
* remembered, never edited between attempts), so the live delivery and a
* recovery re-delivery carry the same words about the same batch.
*
* What it deliberately does not say is that anything was submitted: the runtime
* submits nothing on the parent's behalf (K1 §2), and only the parent's own
* `task_submit_result` starts its acceptance.
*/
function batchEndMessageText(batchId, outcomes) {
	const children = outcomes.length === 0 ? "It admitted no children." : `Its children settled: ${outcomeTally(outcomes)}.`;
	const lines = outcomes.map((outcome) => `- ${outcome.taskId} (run ${outcome.runId ?? "none"}): ${outcome.status}${outcome.evidenceId === void 0 ? "" : `, evidence ${outcome.evidenceId}`}`);
	return [
		`[task-batch-end ${batchId}] the child batch has ended and the workspace is handed back to you; nothing was submitted on your behalf.`,
		children,
		...lines,
		"You are active again: read the children's results, continue your own work, delegate another batch (task_decompose), or hand in your own result (task_submit_result) — only that submission starts your acceptance."
	].join("\n");
}
/**
* The member task ids of one batch, as the run's own accumulated batches record
* them. A run that records no such batch cannot be asked about it: the members of
* a batch nobody names are not another batch's and not the task's children, so
* the read fails by name instead of answering for a batch it cannot identify.
*/
function batchMembers(run, batchId) {
	const batch = run.batches?.find((candidate) => candidate.batchId === batchId);
	if (batch === void 0) throw new Error(`task-runtime: run "${run.runId}" records no batch "${batchId}", so the store does not name its members; a batch is read from the run that admitted it, never derived from the task's children`);
	return [...batch.memberTaskIds];
}
/**
* The end-of-batch results one store's own facts still owe (K1 §2, §5).
*
* A run that is `active` has no unfinished batch — `waiting_children → active`
* clears `batchId` — so every entry of its accumulated `batches` names a batch
* that ended, and each ended batch owes its Session the one message under
* `m-batchend-<batchId>` ({@link batchEndMessageId}), whether the process that
* ended it delivered it or died before it could. The store's own accumulation is
* the whole derivation: nothing is guessed from a task's children, a batch no run
* records is not a candidate, and a run that is still `waiting_children`,
* `submitted` or terminal owes nothing here (its batch end is not durable yet, its
* acceptance is what is in flight, or it is past being told).
*
* Being owed is a candidate, not a verdict: the target's own fold decides whether
* the message is still missing when the delivery is attempted, so a second pass
* over the same store re-derives the same list and delivers nothing twice.
*/
function owedBatchResults(snapshot) {
	const owed = [];
	for (const run of snapshot.runs) {
		if (run.status !== "running" || run.executionPhase !== "active") continue;
		for (const batch of run.batches ?? []) owed.push({
			taskId: run.taskId,
			runId: run.runId,
			batchId: batch.batchId,
			sessionId: run.sessionId,
			memberTaskIds: [...batch.memberTaskIds]
		});
	}
	return owed;
}
/**
* Deliver one batch's end-of-batch message and report what the attempt settled
* as. A deployment without the seam, or one whose relay refuses, changes nothing
* about the batch: the store's facts are the result, and the message is the wake
* that points at them.
*/
async function deliverBatchResult(env, result) {
	if (env.deliverBatchResult === void 0) return "unavailable";
	try {
		return await env.deliverBatchResult(result);
	} catch (error) {
		return `refused: ${message(error)}`;
	}
}
/**
* End one batch and hand the parent back its own decision (K1 §2) — the
* settlement a driver performs once every child has a terminal state.
*
* The order is the promise the parent is given:
*
* 1. **every child's write convergence is confirmed** — the one thing a batch end
*    must not assume. A child that submitted has been drained by its own
*    settlement, but a child that settled `blocked` or was settled by a
*    cancellation may still hold writers or managed jobs, so each member run's
*    Session is drained with the same primitive the admission and submission
*    paths use. A convergence that cannot be confirmed is a parent failed by
*    name: the workspace is not handed back, the phase is not persisted, the gate
*    is not opened, and no parent is told it may write into a checkout somebody
*    else may still be writing to;
* 2. the parent's own writes are drained, by the same rule and the same refusal
*    (§3.3);
* 3. the batch's workspace layer comes off, so the parent's own hold is on top
*    again (§3.4) — confirmed stops first, the handback after them: the batch
*    holds the checkout until every writer inside it is confirmed stopped (§2);
* 4. `waiting_children → active` is persisted with the batch it closes, and the
*    Session's gate follows into `active` — the *question* block is recomputed
*    from the store in the same step, because an unresolved blocking question
*    keeps refusing the parent's writes and a batch ending answers nothing
*    (A4 §7.2);
* 5. the batch's result is delivered to the parent's Session under the identity
*    the batch derives, so the parent is *told* it may continue instead of a
*    model having to notice a phase change.
*
* What the runtime no longer does is submit on the parent's behalf. A batch
* ending is a fact about the children — several of which may have failed — not a
* verdict about the parent, and only the parent's own `task_submit_result`
* starts its verification (`settleSubmittedRun`, the one verification entry).
*
* Two gates can still end the batch without judging it, both budget stops rather
* than verdicts: a cancellation (§3.6) and the parent's own deadline (§3.5).
* Their release is the terminal cleanup it always was, taken before the run is
* settled: a stopped run is not revived by its children's drains, and its own
* checkout is still handed back. A parent whose run already settled was settled
* by somebody else, and its batch end is the store's record alone.
*/
async function finishBatch(env, batch) {
	const snapshot = await env.task.snapshotIn(batch.storeId);
	const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId);
	const members = batchMembers(parentRun, batch.batchId);
	const outcomes = await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members);
	if (parentRun.status !== "running") {
		await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
		return outcomes;
	}
	const childTaskIds = [...members];
	if (batch.signal.aborted) {
		await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
		const reason = `cancelled by the caller while the batch settled: ${batch.reason}`;
		await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, "cancelled", env.actor, { reason });
		await recordTerminalReview(env, batch.storeId, batch.parentTaskId, "cancelled", {
			run: parentRun,
			anomalies: [reason],
			relatedTaskIds: childTaskIds
		});
		env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, "cancelled");
		notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}. Children: ${batchSummary(batch.batchId, outcomes)}`);
		return outcomes;
	}
	const rootBudget = resolveRootBudget(snapshot, env.rootBudget ?? {});
	const rootDeadline = rootBudget.ok ? rootBudget.deadlineAt : void 0;
	if (remainingRunMs(env, parentRun, rootDeadline, Date.now()) <= 0) {
		await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
		const reason = parentDeadlinePassedReason(env, rootDeadline);
		await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, "cancelled", env.actor, { reason });
		await recordTerminalReview(env, batch.storeId, batch.parentTaskId, "cancelled", {
			run: parentRun,
			anomalies: [reason],
			relatedTaskIds: childTaskIds
		});
		env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, "cancelled");
		notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}`);
		return outcomes;
	}
	const blocked = blockingQuestionsOf(snapshot, batch.parentRunId).length > 0;
	const childPending = [];
	for (const childTaskId of childTaskIds) {
		const childRun = latestRun(snapshot, childTaskId);
		if (childRun === void 0) continue;
		const childDrained = await drainSession(env.gate, childRun.sessionId, {
			timeoutMs: env.writeDrainTimeoutMs,
			jobs: env.jobs,
			agent: env.agentFor?.(childRun.sessionId)
		});
		if (!childDrained.confirmed) childPending.push(`run "${childRun.runId}": ${childDrained.pending.join("; ")}`);
	}
	if (childPending.length > 0) {
		const reason = `write convergence of the batch's children could not be confirmed: ${childPending.join("; ")}`;
		await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed", env.actor, { reason });
		await recordTerminalReview(env, batch.storeId, batch.parentTaskId, "failed", {
			run: parentRun,
			localizedCause: reason,
			relatedTaskIds: childTaskIds
		});
		env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed");
		notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}; the parent run is failed and its batch is not handed back.`);
		return outcomes;
	}
	const drained = await drainSession(env.gate, parentRun.sessionId, {
		timeoutMs: env.writeDrainTimeoutMs,
		jobs: env.jobs,
		agent: env.agentFor?.(parentRun.sessionId)
	});
	if (!drained.confirmed) {
		const reason = `write convergence could not be confirmed: ${drained.pending.join("; ")}`;
		await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed", env.actor, { reason });
		await recordTerminalReview(env, batch.storeId, batch.parentTaskId, "failed", {
			run: parentRun,
			localizedCause: reason,
			relatedTaskIds: childTaskIds
		});
		env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed");
		notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}; the parent run is failed and is not verifiable.`);
		return outcomes;
	}
	await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
	await env.task.changeRunPhaseIn(batch.storeId, batch.parentTaskId, batch.parentRunId, env.actor, {
		phase: "active",
		batchId: batch.batchId
	});
	env.gate.setPhase(parentRun.sessionId, "active");
	env.gate.setQuestionsBlocked(parentRun.sessionId, blocked);
	const message$8 = batchEndMessageText(batch.batchId, outcomes);
	const delivery = await deliverBatchResult(env, {
		storeId: batch.storeId,
		runId: batch.parentRunId,
		batchId: batch.batchId,
		sessionId: parentRun.sessionId,
		messageId: batchEndMessageId(batch.batchId),
		text: message$8
	});
	if (delivery !== "delivered" && delivery !== "already-present" && delivery !== "skipped") notifyOwner(env, batch.callerSessionId, `task-runtime: ${batchSummary(batch.batchId, outcomes)}; ${message$8} (delivery: ${delivery})`);
	return outcomes;
}
/**
* Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
* and owned by the runtime rather than by the tool call that admitted it.
*
* The first step is the parent's own drain — admission closed at the atomic
* commit, so whatever the parent still had in flight has to stop before the
* first child starts writing (§3.3); an unconfirmable drain blocks the children
* that never started and fails the parent by name instead of assuming a stop.
*
* Then every round re-reads the store: children already terminal are adopted,
* exactly one ready child is started (the batch is serial by dependency order,
* not parallel — §5's declared boundary), and the round waits for that child's
* terminal state. A nested decomposition is not a recursive call: the child's
* own `task_decompose` registers its own driver, and this loop only waits for
* the child's run to settle.
*
* A driver failure is a parent failed with the cause named, recorded and notified
* (§3.1's "no fire-and-forget") — but never a batch reported as ended on facts the
* store did not give: when the batch's members cannot be read (the parent run is
* unreadable, or its record does not hold this batch), this promise rejects by
* name instead of resolving with an outcome list derived from another batch's
* members or from the task's whole child history. The runtime's own belt settles
* the batch such a rejection names (`registerDriver` → `failBatchFromRuntime`).
*/
async function driveBatch(env, batch) {
	const members = async () => batchMembers(await env.task.runIn(batch.storeId, batch.parentRunId), batch.batchId);
	try {
		if (!await convergeAdmission(env, batch)) return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members());
		return await driveRounds(env, batch);
	} catch (error) {
		await failParentRun(env, batch, `the batch driver failed: ${message(error)}`);
		return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members());
	}
}
/** The parent's own write convergence, before the batch's first child starts. */
async function convergeAdmission(env, batch) {
	const drained = await drainSession(env.gate, batch.callerSessionId, {
		timeoutMs: env.writeDrainTimeoutMs,
		...batch.excludeCallId === void 0 ? {} : { excludeCallId: batch.excludeCallId },
		jobs: env.jobs,
		agent: env.agentFor?.(batch.callerSessionId)
	});
	if (drained.confirmed) return true;
	const reason = `write convergence could not be confirmed: ${drained.pending.join("; ")}`;
	const snapshot = await env.task.snapshotIn(batch.storeId);
	const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId);
	await blockUnstarted(env, batch.storeId, snapshot, batchItems(batchMembers(parentRun, batch.batchId), snapshot.edges), () => ({
		reason: `the batch never started: ${reason}`,
		blockers: []
	}));
	await failParentRun(env, batch, reason);
	return false;
}
/** Fail the batch's parent run by name, with the one review record its terminal transition owes. */
async function failParentRun(env, batch, reason) {
	try {
		const snapshot = await env.task.snapshotIn(batch.storeId);
		const parentTask = taskOf(snapshot, batch.parentTaskId);
		const parentRun = snapshot.runs.find((run) => run.runId === batch.parentRunId);
		if (parentTask === void 0 || parentRun === void 0) return;
		if (parentRun.status !== "running") return;
		await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed", env.actor, { reason });
		await recordTerminalReview(env, batch.storeId, batch.parentTaskId, "failed", {
			run: parentRun,
			localizedCause: reason,
			relatedTaskIds: batchMembers(parentRun, batch.batchId)
		});
		env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, "failed");
		notifyOwner(env, batch.callerSessionId, `task-runtime: batch ${batch.batchId} failed: ${reason}`);
	} catch (error) {
		notifyOwner(env, batch.callerSessionId, `task-runtime: batch ${batch.batchId} failed and its parent run could not be settled: ${reason} (${message(error)})`);
	}
}
/**
* The one verification entry: a run whose phase change into `submitted` is
* already committed is drained, judged, and settled.
*
* Everything that verifies a run goes through here — the worker's own
* `task_submit_result` (a parent's included: a batch ending hands the run back
* `active` and only the parent's own submission starts its acceptance), and the
* recovery path's continuation of a run that submitted before a restart. That is
* what makes the paths share the budget, the drain, the verifier deadline and
* the review discipline instead of separate implementations that drift (§3.1
* "验证权唯一").
*
* A drain that cannot be confirmed fails the run with the pending work named:
* judging a run whose writers may still be running would produce a verdict
* about bytes nothing can vouch for (§3.3).
*/
async function settleSubmittedRun(env, storeId, taskId, runId, opts = {}) {
	const run = await env.task.runIn(storeId, runId);
	if (isTerminalRun(run.status)) return run.status;
	const task = await env.task.taskIn(storeId, taskId);
	const snapshot = await env.task.snapshotIn(storeId);
	const relatedTaskIds = opts.relatedTaskIds ?? snapshot.edges.filter((edge) => edge.to === taskId).map((edge) => edge.from);
	const anomalies = opts.anomalies ?? [];
	const drained = await drainSession(env.gate, run.sessionId, {
		timeoutMs: env.writeDrainTimeoutMs,
		...opts.excludeCallId === void 0 ? {} : { excludeCallId: opts.excludeCallId },
		jobs: env.jobs,
		agent: env.agentFor?.(run.sessionId)
	});
	if (!drained.confirmed) return await failSubmittedRun(env, storeId, task, run, relatedTaskIds, `write convergence could not be confirmed: ${drained.pending.join("; ")}`, anomalies);
	if ((await env.task.taskIn(storeId, taskId)).status !== "verifying") await env.task.markRunStatusIn(storeId, taskId, runId, "verifying", env.actor);
	let bundle;
	try {
		bundle = await withVerifierWorkspace(env, storeId, taskId, runId, run.sessionId, () => verifyWithDeadline(env, storeId, runId));
	} catch (error) {
		const reason$1 = message(error);
		const status = await failSubmittedRun(env, storeId, task, run, relatedTaskIds, reason$1, anomalies);
		if (error instanceof VerifierUnavailableError) {
			const batchId = await parentBatchOf(env, storeId, task, run);
			if (batchId !== void 0) await env.failBatch?.(storeId, batchId, `verification is unavailable: ${reason$1}`);
		}
		return status;
	}
	const settled = await settledStatusOf(env, storeId, runId);
	if (settled !== void 0) return settled;
	const criteria = reviewCriteria(task.acceptanceCriteria, bundle.verifierResults);
	const unmet = unmetMandatory(task.acceptanceCriteria, bundle.verifierResults);
	if (unmet.length === 0) {
		await env.task.markRunStatusIn(storeId, taskId, runId, "verified", env.actor);
		await recordTerminalReview(env, storeId, taskId, "verified", {
			run,
			relatedTaskIds,
			criteria,
			anomalies
		});
		env.onRunSettled?.(storeId, taskId, runId, "verified");
		await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId);
		return "verified";
	}
	const reason = failureReason(unmet);
	await env.task.markRunStatusIn(storeId, taskId, runId, "failed", env.actor, { reason });
	await recordTerminalReview(env, storeId, taskId, "failed", {
		run,
		localizedCause: reason,
		relatedTaskIds,
		criteria,
		anomalies,
		logTail: await failedLogTail(env, unmet, bundle.verifierResults)
	});
	env.onRunSettled?.(storeId, taskId, runId, "failed");
	await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId);
	return "failed";
}
/**
* The status of a run another actor has already settled, or `undefined` while it is
* still in flight. The verdict path reads this before writing a verdict: a
* cancellation that lands during a verifier call owns the settlement, and the store
* refuses both a move out of a terminal state and evidence for a settled run.
*/
async function settledStatusOf(env, storeId, runId) {
	const current = await env.task.runIn(storeId, runId);
	return isTerminalRun(current.status) ? current.status : void 0;
}
/** Fail a run that could not be judged, with the reason recorded and its owner told. */
async function failSubmittedRun(env, storeId, task, run, relatedTaskIds, reason, anomalies = []) {
	const current = await env.task.runIn(storeId, run.runId);
	if (isTerminalRun(current.status)) return current.status;
	await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
	await recordTerminalReview(env, storeId, task.taskId, "failed", {
		run,
		localizedCause: reason,
		relatedTaskIds,
		anomalies
	});
	env.onRunSettled?.(storeId, task.taskId, run.runId, "failed");
	await releaseWorkspaceLayer(env, runOwner(storeId, task.taskId, run.runId), run.sessionId);
	notifyOwner(env, run.sessionId, `task-runtime: run "${run.runId}" failed: ${reason}`);
	return "failed";
}
/**
* The batch a child run belongs to: the batch of its parent run that admitted
* this child. `parentRunId` names the parent run and the membership is a fact of
* that run's accumulated batches — never an id parsed back into a task, which is
* exactly what could not survive a parent that admits more than one batch (K1).
* The run is a batch member of at most one batch, so the answer is unique.
*
* The parent-run guard is what keeps a replay's lineage (`parentRunId` naming
* the champion) from being read as a batch membership: the run named must be the
* parent *task*'s own run. A run whose parent has no batch entry answers
* `undefined` — a membership this build cannot name is not guessed at.
*/
async function parentBatchOf(env, storeId, task, run) {
	if (run.parentRunId === void 0 || task.parentTaskId === void 0) return void 0;
	const parentRun = (await env.task.snapshotIn(storeId)).runs.find((candidate) => candidate.runId === run.parentRunId);
	if (parentRun === void 0 || parentRun.taskId !== task.parentTaskId) return void 0;
	return parentRun.batches?.find((batch) => batch.memberTaskIds.includes(task.taskId))?.batchId;
}
/**
* Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
* the store, run it once through the real spawn + verify chain — or straight
* through the verifier alone for a deterministic criteria replay — and settle
* it with the same terminal-record discipline every other run gets
* ({@link recordTerminalReview}), the lineage tag on the record's anomalies.
* The replayed task is parentless and the historical task it mirrors is never
* touched: a replay is a comparison experiment, not a tree edit. Nothing asks a
* replay to decompose — its projection carries no decomposition guidance and no
* spawn prompt invites one — but nothing refuses it either: `task_decompose` is
* on every worker's surface, and a replayed worker that splits is settled by its
* batch through the ordinary parent acceptance.
*
* A spawning replay is a worker like any other and follows the same rules: it
* is born `active` and it *submits* — an idle worker is not a completion, the
* no-progress counter runs, and the verification comes from the one entry every
* run shares ({@link settleSubmittedRun}). A workerless replay is born
* `submitted` (origin `runtime`) because there is nobody to submit: its
* criteria are judged by the verifier and the run settles on the verdict.
*
* What the run is *placed under* travels with the init (S4-E §Q3): the caller's
* frozen model selection ({@link ReplayRunInit.agentOptions}). It is carried on
* the spawn request, so the deployment remembers it for the session and the
* sub-execution a replayed worker decomposes into inherits exactly the same
* binding; it is absent for an ordinary replay, whose run and spawn are what they
* always were. The run's clock is not this entry's: its time is bounded by the
* runtime's own per-run budget and the root tree's deadline alone.
*/
async function runReplayTask(env, storeId, init, signals = {}) {
	const task = init.task;
	const admission = signals.admission;
	const advance = signals.advance;
	if (isAborted(admission)) throw new Error(`task-runtime: replay of "${task.taskId}" was cancelled before anything was persisted`);
	const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, await env.task.snapshotIn(storeId));
	if (missingArtifacts.length > 0) throw new Error(`task-runtime: replay rejected: ${missingArtifactReason(missingArtifacts)}`);
	const anomalies = [init.lineage];
	await env.task.createTaskIn(storeId, task, env.actor);
	await env.task.admitTaskIn(storeId, task.taskId, env.actor, {
		decompositionStatus: "leaf",
		manifest: init.manifest
	});
	const sessionId = `s-${randomUUID()}`;
	const runId = `r-${randomUUID()}`;
	const birthSubmission = init.spawn ? void 0 : {
		summary: "criteria replay (no worker spawned)",
		evidenceRefs: [],
		submittedAt: (/* @__PURE__ */ new Date()).toISOString(),
		origin: "runtime"
	};
	const startedAt = /* @__PURE__ */ new Date();
	const run = {
		runId,
		taskId: task.taskId,
		sessionId,
		...init.championRunId === void 0 ? {} : { parentRunId: init.championRunId },
		capabilitySnapshot: capabilitySnapshot(init.manifest),
		...init.agentPreset === void 0 ? {} : { agentPreset: init.agentPreset },
		executionPhase: init.spawn ? "active" : "submitted",
		...birthSubmission === void 0 ? {} : { submission: birthSubmission },
		artifacts: [],
		verifierResults: [],
		status: "running",
		startedAt: startedAt.toISOString()
	};
	const bound = {
		...env,
		...init.agentOptions === void 0 ? {} : { agentOptions: init.agentOptions }
	};
	let contentBinding;
	try {
		contentBinding = await bindRunProviders({
			storeId,
			runId: run.runId,
			manifest: init.manifest,
			...init.providers === void 0 ? {} : { providers: init.providers },
			...env.runBindingRoot === void 0 ? {} : { root: env.runBindingRoot }
		});
	} catch (error) {
		const reason = `content binding failed: ${message(error)}`;
		await env.task.startRunIn(storeId, run, env.actor);
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: reason,
			anomalies
		});
		return await finishReplay(env, storeId, run, "failed");
	}
	await env.task.startRunIn(storeId, contentBinding === void 0 ? run : {
		...run,
		providerBinding: contentBinding
	}, env.actor);
	if (!init.spawn) return await finishReplay(env, storeId, run, await settleSubmittedRun(env, storeId, task.taskId, run.runId, { anomalies }) === "verified" ? "verified" : "failed");
	let handle;
	try {
		await assertPresetUsable(env, init.manifest, init.agentPreset);
		const permissionPreset = permissionFor(env, init.manifest);
		const roots = skillRootsForRun(init.skillRoots ?? [], contentBinding);
		handle = await bound.spawn({
			sessionId,
			name: task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `replay-${task.taskId}`,
			taskWorker: true,
			grant: await authorizedGrant(env, init.manifest, roots),
			...init.agentPreset === void 0 ? {} : { agentPreset: init.agentPreset },
			...permissionPreset === void 0 ? {} : { permissionPreset },
			...bound.workerCwd === void 0 ? {} : { cwd: bound.workerCwd },
			...bound.agentOptions === void 0 ? {} : { agentOptions: bound.agentOptions },
			...advance === void 0 ? {} : { signal: advance }
		});
	} catch (error) {
		const reason = `spawn failed: ${message(error)}`;
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: reason,
			anomalies
		});
		return await finishReplay(env, storeId, run, "failed");
	}
	env.gate.setPhase(sessionId, "active");
	env.onRunBound(sessionId, {
		storeId,
		taskId: task.taskId,
		runId: run.runId
	});
	const observation = await observeWorkerRun(bound, storeId, task, run, handle, advance);
	switch (observation.kind) {
		case "terminal": return await finishReplay(env, storeId, run, statusOutcome(observation.status));
		case "aborted": return await settleReplayRun(env, storeId, task, run, {
			status: "cancelled",
			reason: "cancelled while the replayed worker ran",
			anomalies
		});
		case "budget-exhausted": {
			const reason = wallClockExhaustedReason(bound);
			return await settleReplayRun(env, storeId, task, run, {
				status: "failed",
				reason,
				localizedCause: reason,
				anomalies
			});
		}
		case "no-progress":
			handle.agent.cancel({ kind: "parent" });
			return await settleReplayRun(env, storeId, task, run, {
				status: "failed",
				reason: observation.reason,
				localizedCause: observation.reason,
				anomalies: [...anomalies, `no-progress round ${observation.rounds} of ${env.noProgressRounds}`]
			});
		case "failed": return await settleReplayRun(env, storeId, task, run, {
			status: "failed",
			reason: observation.reason,
			localizedCause: observation.reason,
			anomalies
		});
	}
}
/**
* Settle one replay run the replay's own observation decided — a cancellation, a
* deadline, an unsubmitted idle, a worker error — and report what the run settled
* as.
*
* Two settlement paths can reach one run at once, and this is not hypothetical for
* a replay: a replayed worker that decomposed is settled by its own batch (the
* ordinary parent acceptance submits and verifies the parent run) while this path
* is deciding, and a run whose own deadline expires is exactly when both are in
* flight. The arbitration is the one the batch's per-child settlement already
* applies ({@link settleChildRun}, `settleRunFromRuntime` beside it): the store is
* the arbiter — a run it now holds terminal stands, this settlement adds nothing,
* and the outcome reports the state the store holds rather than the one this wait
* was about to write. The two writes are otherwise exactly what they were: the
* status event with its reason, one terminal review carrying the localized cause
* and the lineage anomaly, and the settlement bookkeeping.
*/
async function settleReplayRun(env, storeId, task, run, settlement) {
	const current = await env.task.runIn(storeId, run.runId);
	if (isTerminalRun(current.status)) return await finishReplay(env, storeId, run, statusOutcome(current.status));
	try {
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, settlement.status, env.actor, { ...settlement.reason === void 0 ? {} : { reason: settlement.reason } });
	} catch (error) {
		const settled = await env.task.runIn(storeId, run.runId).catch(() => void 0);
		if (settled === void 0 || !isTerminalRun(settled.status)) throw error;
		return await finishReplay(env, storeId, run, statusOutcome(settled.status));
	}
	await recordTerminalReview(env, storeId, task.taskId, settlement.status, {
		run,
		...settlement.localizedCause === void 0 ? {} : { localizedCause: settlement.localizedCause },
		...settlement.anomalies === void 0 ? {} : { anomalies: settlement.anomalies }
	});
	env.onRunSettled?.(storeId, task.taskId, run.runId, settlement.status);
	return await finishReplay(env, storeId, run, settlement.status);
}
/** A settled run status as a replay outcome; a `blocked` run is reported as failed — a replay cannot be blocked by a sibling. */
function statusOutcome(status) {
	return status === "verified" || status === "cancelled" ? status : "failed";
}
/**
* The replay result read back from the store: the review record the settlement
* wrote carries the duration and the verdict per criterion, and the evidence
* bundle the verifier produced is what the comparison report names.
*/
async function finishReplay(env, storeId, run, status) {
	const snapshot = await env.task.snapshotIn(storeId);
	const record = snapshot.reviews.find((item) => item.runId === run.runId);
	const evidenceId = snapshot.evidence.find((item) => item.taskRunId === run.runId)?.evidenceId;
	return {
		taskId: run.taskId,
		runId: run.runId,
		status,
		...record?.durationMs === void 0 ? { durationMs: await runDurationMs(env, storeId, run) } : { durationMs: record.durationMs },
		...record?.criteria === void 0 ? {} : { criteria: record.criteria.map((item) => ({ ...item })) },
		...evidenceId === void 0 ? {} : { evidenceId }
	};
}
/**
* Settle one run terminal from outside the orchestration — a graph removal, or
* a recovery pass that refuses to continue a run — with the same terminal-record
* discipline every other settlement uses: the status event, its one review
* record (idempotent: a run whose review already exists is not given a second),
* the gate closed for its session, and the workspace layer it held released.
*
* A run that is already terminal is left exactly as it is: this is a settlement
* entry, not an overwrite.
*/
async function settleRunFromRuntime(env, storeId, run, status, reason) {
	const current = await env.task.runIn(storeId, run.runId);
	if (current.status !== "running") return;
	const snapshot = await env.task.snapshotIn(storeId);
	const relatedTaskIds = snapshot.tasks.find((candidate) => candidate.taskId === current.taskId)?.childTaskIds ?? [];
	try {
		await env.task.markRunStatusIn(storeId, current.taskId, current.runId, status, env.actor, { reason });
	} catch (error) {
		const settled = await env.task.runIn(storeId, current.runId).catch(() => void 0);
		if (settled === void 0 || settled.status === "running") throw error;
		return;
	}
	if (!snapshot.reviews.some((review) => review.runId === current.runId)) await recordTerminalReview(env, storeId, current.taskId, status, {
		run: current,
		...status === "failed" ? { localizedCause: reason } : {},
		anomalies: [reason],
		relatedTaskIds
	});
	env.onRunSettled?.(storeId, current.taskId, current.runId, status);
	if (env.gate !== void 0) try {
		releaseAskingSessions(env.gate, await env.task.snapshotIn(storeId), current.runId);
	} catch (error) {
		notifyOwner(env, current.sessionId, `task-runtime: the question blocks of the runs that asked run "${current.runId}" could not be recomputed after it settled (${message(error)}); the store's own derivation is unchanged and the next recovery recomputes them`);
	}
	await releaseWorkspaceLayer(env, runOwner(storeId, current.taskId, current.runId), current.sessionId);
	notifyOwner(env, current.sessionId, `task-runtime: run "${current.runId}" was settled ${status}: ${reason}`);
}

//#endregion
//#region src/obligation.ts
function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0;
}
/**
* Parse one obligations.yml text (JSON-compatible YAML) into templates,
* refusing malformed entries loudly — a template that cannot be read is a
* defect in the domain pack, not an empty template set.
*/
function parseObligationTemplates(text$1, source) {
	let raw;
	try {
		raw = JSON.parse(text$1);
	} catch (error) {
		throw new Error(`obligation: ${source} is not JSON-compatible YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(raw)) throw new Error(`obligation: ${source} must be an array of templates`);
	return raw.map((entry, index) => {
		const label = `${source} entry ${index}`;
		if (typeof entry !== "object" || entry === null) throw new Error(`obligation: ${label} must be an object`);
		const candidate = entry;
		if (!nonEmpty(candidate.id)) throw new Error(`obligation: ${label} requires a non-empty "id"`);
		if (!nonEmpty(candidate.question)) throw new Error(`obligation: ${label} requires a non-empty "question"`);
		if (!nonEmpty(candidate.evidenceForm)) throw new Error(`obligation: ${label} requires a non-empty "evidenceForm"`);
		const capabilities = candidate.typicalCapabilities ?? [];
		if (!Array.isArray(capabilities) || capabilities.some((item) => !nonEmpty(item))) throw new Error(`obligation: ${label} "typicalCapabilities" must be an array of non-empty strings`);
		return {
			id: candidate.id,
			question: candidate.question,
			evidenceForm: candidate.evidenceForm,
			typicalCapabilities: capabilities
		};
	});
}
/**
* Walk up from `start` to the directory holding `.git` (the same semantics as
* skill-filesystem's findProjectRoot, here with an 8-level cap so a detached
* env root cannot walk to the filesystem root and pick up an unrelated repo).
* `undefined` when no repo root is found within the cap.
*/
async function findRepoRoot(start, maxLevels = 8) {
	let current = start;
	for (let level = 0; level <= maxLevels; level += 1) {
		try {
			await stat(join(current, ".git"));
			return current;
		} catch {}
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
/**
* Load every `<repoRoot>/.agents/skills/<name>/obligations.yml`, in directory
* order. A pack without the file contributes nothing; an absent skills root
* yields an empty list. A malformed file throws — see parseObligationTemplates.
*/
async function loadObligationTemplates(repoRoot) {
	const skillsRoot = join(repoRoot, ".agents", "skills");
	let entries;
	try {
		entries = await readdir(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		const file = join(skillsRoot, entry.name, "obligations.yml");
		let text$1;
		try {
			text$1 = await readFile(file, "utf8");
		} catch {
			continue;
		}
		files.push({
			file,
			templates: parseObligationTemplates(text$1, file)
		});
	}
	return files;
}
/** The text a recorded obligation carries, for mention matching. */
function obligationText(obligation) {
	return `${obligation.goal}\n${obligation.criterion}`;
}
/**
* Compare one template set against the current task graph. An entry is covered
* when a task requested one of its typical capabilities (`via capability
* <name>`) or a recorded obligation mentions its id or question (`via
* obligation <id>`). Everything else is uncovered — reported, never blocked.
*/
function checkObligationCoverage(templates, snapshot) {
	const requested = new Set(snapshot.tasks.flatMap((task) => task.requestedCapabilities));
	const obligations = snapshot.obligations;
	const covered = [];
	const uncovered = [];
	for (const template of templates) {
		const capability = template.typicalCapabilities.find((name) => requested.has(name));
		if (capability !== void 0) {
			covered.push({
				template,
				via: `capability ${capability}`
			});
			continue;
		}
		const obligation = obligations.find((item) => obligationText(item).includes(template.id) || obligationText(item).includes(template.question));
		if (obligation !== void 0) {
			covered.push({
				template,
				via: `obligation ${obligation.obligationId}`
			});
			continue;
		}
		uncovered.push(template);
	}
	return {
		covered,
		uncovered
	};
}

//#endregion
//#region src/index.ts
/**
* Tools that put a question or an approval in front of a human. `hitl_ask` and
* `hitl_approve` are this deployment's root tools
* (`agent-singularity/src/tools/ask.ts:11`, `approve.ts:9`); `ask_user_question`
* is the worker baseline's (`capability.ts:55`).
*/
const HUMAN_TOOLS = new Set([
	"hitl_ask",
	"hitl_approve",
	"ask_user_question"
]);
/**
* Whether one `tool/result` payload reports a failure: the optional error
* identity (appended only alongside `isError`) or any error-marked content block.
*/
function toolResultFailed(data) {
	if (data.error !== void 0) return true;
	return (data.message?.content ?? []).some((block) => block.isError === true);
}
/** The skill name one `skill` tool call asked for, parsed from its raw arguments JSON. */
function skillNameFrom(rawArguments) {
	try {
		const parsed = JSON.parse(rawArguments);
		return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : void 0;
	} catch {
		return;
	}
}
/** The `tokenUsage` projection's wire view, or `undefined` when the value is not that shape. */
function tokenUsageOf(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const buckets = value;
	if ([
		buckets.uncachedInputTokens,
		buckets.outputTokens,
		buckets.cacheReadTokens,
		buckets.cacheWriteTokens
	].some((item) => typeof item !== "number")) return void 0;
	return {
		uncachedInputTokens: buckets.uncachedInputTokens,
		outputTokens: buckets.outputTokens,
		cacheReadTokens: buckets.cacheReadTokens,
		cacheWriteTokens: buckets.cacheWriteTokens
	};
}
const DEFAULT_VERIFY_TIMEOUT_MS = 600 * 1e3;
/**
* The shipped per-run budget (KISS §8.6: granularity knobs live in config, not
* in definitions). `wallTimeMs` is a backstop far above the longest legitimate
* worker run this deployment has measured (a workload build takes 18–20 min,
* so two hours kills only a genuinely stuck worker); `maxToolCalls` sits an
* order above KISS's max_tool_calls 15 reference because this deployment's
* submit/poll workers legitimately make dozens of calls — and it is a
* post-hoc annotation, so a tight value would be noise, not a guardrail.
* `attempts` matches the current reality: one run per task, no retry branch.
* `tokens` carries no default on purpose — see {@link BudgetConfig}.
*/
const DEFAULT_BUDGET = {
	maxToolCalls: 150,
	wallTimeMs: 7200 * 1e3,
	attempts: 1
};
/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); enforced since A3 — see {@link Config.noProgressRounds}. */
const DEFAULT_NO_PROGRESS_ROUNDS = 3;
/**
* The proposal statuses that hold a run (K1 §1: at most one proposal in flight
* per run): a batch that is waiting for its review, ready to be admitted, or
* approved and not yet continued. `admitted` is a consumption rather than a
* hold, and rejected/cancelled/stale/expired are terminal — neither keeps the
* run from proposing the next batch.
*/
const IN_FLIGHT_PROPOSAL_STATUSES = new Set([
	"pending_review",
	"ready",
	"approved"
]);
/**
* The shipped review policy (T2/T3 §5): `off`. Every decomposition this
* deployment has ever run was admitted on the machine rules alone, and the
* guide's decision is that a human review is something a deployment *turns on*
* (§5: no risk-based classifier, no "only when no template matched") rather
* than something it turns off. `off` is not a silent state: the proposal
* record carries the policy it was born under, which is what lets a reader
* tell "this batch ran without a human review" from "a person approved it".
*/
const DEFAULT_GENERATED_TASK_REVIEW = "off";
/**
* The shipped write-drain window (A3 §3.3). Thirty seconds is far above the
* settle time of a tool call this process can see finish — the drain waits on
* in-flight registrations and the session's managed jobs, both of which either
* stop promptly or are the thing the caller must be told about — and far below
* a verifier call's own deadline, so a drain that cannot be confirmed fails the
* run long before the verification budget it would otherwise waste.
*/
const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 3e4;
/**
* Growth guardrails handed to admission as `decompositionPolicy`
* ({@link Config.maxDepth}, {@link Config.maxChildren}, checked at
* `admission.ts:47-58`).
*
* `4` is one level of headroom above the deepest tree actually exercised: the
* §4.1 run recorded "根 → 子 → 孙" three levels (`docs/singularity-harness-guide.md:258`),
* so a shallower cap would forbid a shape known to work while a deeper one would
* let a runaway self-decomposer spend its whole budget before admission ever
* refuses. `8` is several times the batches real runs send (2–4 children):
* a single batch above it is a parent enumerating work it should
* have delegated a level down, not a decomposition the orchestrator should run.
*/
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_CHILDREN = 8;
/**
* Whether a task admitted `leaf` may still decompose itself
* ({@link Config.allowRuntimeDecomposition}) — the door this deployment leaves
* open on every node's own judgement, and the reason `leaf` is a hint rather
* than a lock.
*
* A parent that admits a child `leaf` predicted the work fits one worker. That
* prediction is one guess made before the work started, while `细化想法4.md:415-427`
* puts `DECOMPOSE` at the Task Worker's own discretion and §36 (`:1459-1483`)
* asks for criteria the node can apply, not for a verdict frozen at delegation
* time: with the switch off, a node that discovers it is not atomic has no legal
* path, which is the only thing that made the recursion unreachable. Nothing
* else moves: `task_decompose` is already in every worker's grant whatever its
* `decompositionStatus` (`capability.ts:145`), so a switch-off deployment hands a
* worker a tool the same runtime then refuses.
*
* The switch relaxes no guardrail, so `true` is the shipped default. A batch
* still clears every admission rule — structure, acyclic dependencies,
* executable criteria carrying a command, the capability-gap rule,
* {@link Config.maxDepth}, {@link Config.maxChildren} — and a run still holds at
* most one unfinished batch and one proposal in flight (K1 §1; an *active* run
* is the whole of that rule, and a batch that ended hands the run back active).
* A deployment that wants every split pre-declared by the parent sets `false`
* and keeps the pre-switch refusal, named message included.
*/
const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true;
/**
* The shipped capability table, kept verbatim in step with `config.yml`
* (document 1, the `task-runtime` row). `tools` holds LABELS from
* {@link TOOL_LABELS}, expanded to real DSH tool names when a manifest is
* resolved, and every worker also keeps {@link workerBaseline} whatever its
* capabilities declare. `mcpServers` holds names from {@link MCP_SERVER_REGISTRY},
* mounted per worker at spawn with the run's env binding (`./mcp-servers.ts`).
*
* No entry declares `permission`: flipping a worker to an approval-gated preset
* (`workspace-write` asks) is blocked until approvals reliably reach the canvas
* on a real deployment — the known issue recorded as #17 in
* `docs/singularity-harness-guide.md:365` (fix landed 2026-09-17, real-topology
* re-run still outstanding). An unattended worker on `ask` simply hangs.
*
* The four BB execution families read: the three `verify`/`run-*-regression`
* entries ride the `bb-verify` composition (persona + fs + skill + a compaction
* ratio tuned for long poll loops) plus the env's own bbdev MCP server;
* `run-verilator-regression` adds the `waveform` skill because RTL failures are
* settled cycle-level. `build-*` entries need no preset — one submit/poll MCP
* round fits the default composition; `build-chip-config`'s install step itself
* is bash-driven (the bbdev API's `/config/install` has no MCP wrapper), the
* server covers the follow-up `validate`. Verification never rides the CI
* dispatch channel: per the 2026-09-18 human ruling, dispatch/CI scripts are
* reference material for writing MCP servers only — verification runs locally
* (verify node + bbdev MCP + the local toolchain).
*/
const DEFAULT_CAPABILITIES = {
	"design-chip": { skills: ["chip-designer"] },
	"design-ball": {
		skills: ["ball-align"],
		tools: ["filesystem", "bash"]
	},
	"check-ball-registration": {
		skills: ["check"],
		mcpServers: ["bbdev"]
	},
	"verify-ball-functional": {
		skills: ["verify"],
		preset: "bb-verify",
		mcpServers: ["bbdev"]
	},
	"run-bemu-regression": {
		skills: ["verify"],
		preset: "bb-verify",
		mcpServers: ["bbdev"]
	},
	"run-verilator-regression": {
		skills: ["verify", "waveform"],
		preset: "bb-verify",
		mcpServers: ["bbdev"]
	},
	"build-chip-config": { mcpServers: ["bbdev"] },
	"build-compiler": { mcpServers: ["bbdev"] },
	"build-workload": { mcpServers: ["bbdev"] },
	"build-kernel": { mcpServers: ["bbdev"] },
	"integrate-model": { skills: ["workload-tests"] },
	"analyze-waveform": { skills: ["waveform"] },
	"research": { preset: "standard" }
};
const Capability = z.object({
	skills: z.array(z.string()),
	tools: z.array(z.string()),
	preset: z.string(),
	permission: z.string(),
	mcpServers: z.array(z.string())
});
const RootBudget = z.object({
	wallTimeMs: z.number(),
	maxRuns: z.number(),
	maxConcurrentWrites: z.number()
});
const ConfigSchema = z.object({
	capabilities: z.dict(Capability).default({ ...DEFAULT_CAPABILITIES }),
	defaultPreset: z.string(),
	verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS),
	maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
	maxChildren: z.number().default(DEFAULT_MAX_CHILDREN),
	budget: z.object({
		maxToolCalls: z.number(),
		tokens: z.number(),
		wallTimeMs: z.number(),
		attempts: z.number()
	}).default({ ...DEFAULT_BUDGET }),
	noProgressRounds: z.number().default(DEFAULT_NO_PROGRESS_ROUNDS),
	allowRuntimeDecomposition: z.boolean().default(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION),
	generatedTaskReview: z.union([z.const("off"), z.const("all")]).default(DEFAULT_GENERATED_TASK_REVIEW),
	rootBudget: RootBudget,
	writeDrainTimeoutMs: z.number().default(DEFAULT_WRITE_DRAIN_TIMEOUT_MS)
});
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
var TaskRuntime = class TaskRuntime extends Service {
	static inject = [
		"task",
		"agentRuntime",
		"graphs"
	];
	static Config = ConfigSchema;
	config;
	/** sessionId → run binding, rebuilt whenever a store is (re)opened. */
	sessions = /* @__PURE__ */ new Map();
	/**
	* The sessions this process actually started (a spawned worker, a root run
	* created here, a replay). Deliberately *not* populated by {@link reindex}:
	* the recovery path needs to tell "this process is running that run right
	* now" from "the store holds a run from a process that is gone", and a
	* binding rebuilt from a snapshot cannot answer that.
	*/
	startedSessions = /* @__PURE__ */ new Set();
	/**
	* The batches and replays this process owns, keyed `<storeId>/<batchId>`
	* (`replay/<runId>` for a replay). The map is the registration the recovery
	* path consults, and the controller in each entry is what a cancellation,
	* the root deadline or the unload path aborts.
	*/
	drivers = /* @__PURE__ */ new Map();
	/**
	* The lineage tag of each replay task this process started, keyed by task id.
	* A spawning replay's worker submits like any other worker, so its terminal
	* review is written by the shared settlement entry — which is where the tag has
	* to be known. In-process only, and honest about it: a replay resumed in a new
	* process records no lineage on the run it continues.
	*/
	replayLineage = /* @__PURE__ */ new Map();
	/**
	* The directory each session this process spawned into a *named* workspace
	* works in, keyed by session: a replay may be placed in a directory of its own
	* (S4-E), and that directory — not the session's graph env — is then the
	* checkout every one of its runs resolves against, its own decomposition and its
	* children's spawns included.
	*
	* In-process only, like the ownership registry it feeds and the session index
	* beside it: a session the process never spawned has no entry, and a restart
	* resolves the store's own sessions from the graph again. An entry lives while
	* the run bound to its session is non-terminal ({@link runSettledFromRuntime}
	* forgets it), which is exactly as long as anything can resolve through it.
	*/
	sessionWorkspaces = /* @__PURE__ */ new Map();
	/**
	* What each session this process spawned *runs under*, keyed by session: the
	* model selection its agent was created with (`agentOptions`). A replay carries
	* an experiment's frozen binding (S4-E §Q3), and the sub-execution its worker
	* decomposes into is the same run of the same experiment — so the orchestration
	* that session's own decomposition builds resolves the binding from here, exactly
	* as it resolves the workspace it works in from {@link sessionWorkspaces} beside
	* it.
	*
	* In-process only, for the same reason and with the same honesty: a session this
	* process never spawned has no entry, and the binding is not part of any record
	* (a replay resumed in a new process continues under the deployment's own
	* selection, as it always continued without a lineage tag). An entry lives while
	* the run bound to its session is non-terminal ({@link runSettledFromRuntime}
	* forgets it), which is exactly as long as anything resolves through it.
	*/
	sessionExecutionBindings = /* @__PURE__ */ new Map();
	/** The tool-execution gate and the write drain (A3 §3.3); this runtime owns every phase it writes. */
	executionGate;
	/**
	* The stores a cancellation is closing right now ({@link cancelGraph}), from
	* the instant its gate was closed to the instant the operation is done with
	* the store.
	*
	* A cancellation is the one transition that puts a barrier in effect *before*
	* the store records it, so during that window the record still says `running`
	* and phase `active` — older than the barrier already in effect here. A read
	* path that rebinds a session in the window would re-apply that older phase
	* and lift the barrier, so {@link gatePhaseFromStore} refuses to move a phase
	* a session already holds while its store is in this set. The store is the
	* truth again the moment the entry goes.
	*/
	closingStores = /* @__PURE__ */ new Set();
	/**
	* One recovery barrier per store (A2 §E): what an explicit activation
	* awaits, what every business execution entry checks before its first side
	* effect, and what a cancellation or the unload invalidates. The persistent
	* record stays the source of truth; this map only says what this process has
	* recovered — it is never persisted and never a second state machine.
	*/
	storeRecovery = /* @__PURE__ */ new Map();
	/** The one-writer-per-workspace ownership registry (A3 §3.4). */
	workspaces;
	/** The load-time provider scan, taken once ({@link providerLoadReport}). */
	providerLoad;
	/**
	* One tail per store and parent task: the serialization §6 asks for, so two
	* approved proposals competing for the same parent cannot interleave their
	* re-checks and their commits. See {@link serializeParent}.
	*/
	parentChains = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, "taskRuntime");
		const rootBudget = config?.rootBudget === void 0 ? void 0 : { ...config.rootBudget };
		this.assertClosedRootBudget(rootBudget);
		assertRootBudgetConfig(rootBudget ?? {});
		this.assertGeneratedTaskReview(config?.generatedTaskReview);
		this.config = {
			capabilities: structuredClone(config?.capabilities ?? DEFAULT_CAPABILITIES),
			...config?.defaultPreset !== void 0 ? { defaultPreset: config.defaultPreset } : {},
			verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
			maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
			maxChildren: config?.maxChildren ?? DEFAULT_MAX_CHILDREN,
			budget: {
				...DEFAULT_BUDGET,
				...config?.budget ?? {}
			},
			noProgressRounds: config?.noProgressRounds ?? DEFAULT_NO_PROGRESS_ROUNDS,
			allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
			generatedTaskReview: config?.generatedTaskReview ?? DEFAULT_GENERATED_TASK_REVIEW,
			runBindingRoot: config?.runBindingRoot ?? defaultRunBindingRoot(),
			...rootBudget === void 0 ? {} : { rootBudget },
			writeDrainTimeoutMs: config?.writeDrainTimeoutMs ?? DEFAULT_WRITE_DRAIN_TIMEOUT_MS
		};
		this.executionGate = new ExecutionGate();
		this.workspaces = new WorkspaceRegistry({ markerRoot: join(this.config.runBindingRoot ?? defaultRunBindingRoot(), WORKSPACE_OWNERS_DIR) });
		ctx.effect(() => () => this.unload());
	}
	/**
	* Refuse a root budget carrying a member this build does not execute. The
	* schema keeps unknown keys, so this is where a caller's typo or a limit from
	* a newer version is caught: a `maxTokens` or `maxWallClock` nobody enforces
	* would read as a promise the deployment breaks silently.
	*/
	assertClosedRootBudget(budget) {
		if (budget === void 0) return;
		const known = new Set([
			"wallTimeMs",
			"maxRuns",
			"maxConcurrentWrites"
		]);
		const unknown = Object.keys(budget).filter((key) => !known.has(key));
		if (unknown.length === 0) return;
		throw new Error(`task-runtime: rootBudget names [${unknown.join(", ")}], which this deployment does not enforce; a hard limit that cannot be executed refuses to start rather than running under a promise nobody keeps`);
	}
	/**
	* Refuse a review policy this build does not implement. The configuration
	* schema types the member, but a deployment that constructs the runtime
	* directly (a test, an embedding process) bypasses the schema, and a policy
	* nobody implements is worse than a refusal to start: a value like `"risk"`
	* would read as "somebody decides which batches are reviewed" while this
	* build quietly admits everything. `off` and `all` are the two modes §5
	* defines; nothing is inferred from a near miss.
	*/
	assertGeneratedTaskReview(policy) {
		if (policy === void 0 || policy === "off" || policy === "all") return;
		throw new Error(`task-runtime: generatedTaskReview is ${JSON.stringify(policy)}; the review policy is "off" or "all" (§5 defines no other mode, and a policy this build cannot execute refuses to start rather than admitting unreviewed batches)`);
	}
	/**
	* The unload path: abort every driver, await their settlements, close the gate
	* for every session this runtime tracks, and release the workspace markers
	* this process wrote. Warnings, never throws — an unload that raised would
	* leave the rest of the process's disposal half-done.
	*/
	async unload() {
		for (const storeId of [...this.storeRecovery.keys()]) this.invalidateStoreRecovery(storeId);
		this.storeRecovery.clear();
		const entries = [...this.drivers.values()];
		for (const entry of entries) entry.controller.abort();
		await Promise.all(entries.map((entry) => entry.promise.catch((error) => {
			this.warn(`unload: a driver did not settle cleanly (${error instanceof Error ? error.message : String(error)})`);
			return [];
		})));
		this.drivers.clear();
		for (const sessionId of this.startedSessions) this.executionGate.setTerminal(sessionId);
		try {
			await this.workspaces.close();
		} catch (error) {
			this.warn(`unload: workspace markers could not be released (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	/**
	* Cordis runs this after construction, once the injected services are there:
	* the load-time provider scan (S1-C item 3) is taken here, so the first thing
	* a deployment learns about its own capability table is what its own discovery
	* roots make of it.
	*
	* This hook never throws: see {@link providerLoadReport} for why the scan
	* reports instead of refusing to start.
	*/
	async [Service.init]() {
		await this.providerLoadReport();
		this.ctx.effect(() => {
			const offPre = this.ctx.on("tools/pre-execute", async (exec, next) => {
				const sessionId = exec.agent?.id;
				if (sessionId === void 0) return await next();
				const decision = this.executionGate.decide(String(sessionId), exec.name);
				if (!decision.allow) return {
					kind: "deny",
					reason: decision.reason
				};
				this.executionGate.trackAllowed(String(sessionId), String(exec.callId), exec.name);
				return await next();
			}, { prepend: true });
			const offResult = this.ctx.on("tools/result", (exec) => {
				this.executionGate.settled(String(exec.callId));
			});
			return () => {
				if (typeof offPre === "function") offPre();
				if (typeof offResult === "function") offResult();
			};
		});
	}
	/**
	* The load-time provider scan over the capability table this process is
	* running (guide §2.4, S1-C item 3): every skill the effective table names,
	* discovered from the harness process's own skill roots (`process.cwd()`'s
	* project roots, `$DSH_HOME/skills`, the user root) and judged by
	* {@link validateSkillProvider} — the same validator admission, capability
	* replacement and candidate promotion use.
	*
	* Why this reports instead of refusing the deployment: the harness process's
	* own viewpoint is **not** the worker's. A deployment-level process loads
	* `config.yml` long before any graph env exists, so it cannot see the checkout
	* a worker will run in (`/…/env/<name>`, whose own `.agents/skills` a worker's
	* discovery walks first) — a skill that resolves fine at admission is
	* therefore legitimately *missing* from the load-time viewpoint. Failing the
	* load on that would refuse configurations that work, and it would fail for a
	* reason the operator cannot fix by editing the table. So every defect is
	* printed, nothing is enforced here, and the hard gate stays where the
	* viewpoint is the worker's own: the admission pre-check, which refuses the
	* whole batch before it persists anything.
	*
	* The result is kept as a value ({@link ProviderLoadReport}): the effective
	* provider set and the defect summary stay queryable after the log line has
	* scrolled away, without re-running the validation. It is the *load-time* fact
	* — a row replaced later in this process (an evolution apply, a rollback) was
	* judged by its own entry before it landed, and is not folded back into this
	* report.
	*/
	async providerLoadReport() {
		this.providerLoad ??= this.scanConfiguredProviders();
		return this.providerLoad;
	}
	/**
	* One load-time scan, never thrown: a scan that cannot run (a discovery or a
	* read that fails outright) is reported as {@link ProviderLoadReport.failed}
	* and printed just as loudly as a refused provider.
	*/
	async scanConfiguredProviders() {
		let report;
		try {
			const precheck = await this.providerPrecheck(Object.keys(this.config.capabilities), { cwd: process.cwd() });
			report = {
				precheck,
				defects: providerDefectLines(precheck)
			};
		} catch (error) {
			report = {
				defects: [],
				failed: error instanceof Error ? error.message : String(error)
			};
		}
		this.reportProviderLoad(report);
		return report;
	}
	/**
	* The load report, printed through the cordis logger when one is mounted: one
	* line per defect (capability, skill, defect code, detail) plus a header that
	* says what was scanned and that the deployment is starting anyway.
	*/
	reportProviderLoad(report) {
		const roots = report.precheck?.roots ?? [];
		if (report.failed !== void 0) {
			this.warn(`config load: the capability provider scan could not run (${report.failed}); the deployment starts, and admission still refuses a batch whose provider cannot be judged`);
			return;
		}
		if (report.defects.length === 0) return;
		this.warn(`config load: ${report.defects.length} provider defect${report.defects.length === 1 ? "" : "s"} in the effective capability table (roots: ${roots.join(", ")}); reported, not enforced — this process's own roots are not the worker's, so a skill reachable from a run's checkout may legitimately be missing here. Admission refuses a batch that names one of these.`);
		for (const line of report.defects) this.warn(`config load: ${line}`);
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message$8) {
		const logger = this.ctx.logger;
		logger?.("task-runtime").warn(message$8);
	}
	/**
	* The wall-clock deadline one `verifier.verifyRun` call runs under
	* ({@link Config.verifyTimeoutMs}). Exposed because the same deadline has to
	* reach the model-facing `task_verify` self-check: its tool call would
	* otherwise run the verifier with no timer at all.
	*/
	get verifyTimeoutMs() {
		return this.config.verifyTimeoutMs;
	}
	/** The resolved per-run budget ({@link Config.budget}); which member is enforced, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
	get budget() {
		return { ...this.config.budget };
	}
	/** The resolved no-progress round count ({@link Config.noProgressRounds}); the batch driver's stop limit. */
	get noProgressRounds() {
		return this.config.noProgressRounds;
	}
	/**
	* The review policy in force for batches that have not been admitted yet
	* ({@link Config.generatedTaskReview}), exposed read-only: a deployment's own
	* policy is not a secret, and a caller that has to say what happens next
	* (`decomposeAndRun`'s pending answer, a tool's status line) should read it
	* from the runtime rather than infer it from a proposal's birth policy — the
	* two differ exactly when the deployment tightened it after that batch was
	* proposed.
	*/
	get generatedTaskReview() {
		return this.config.generatedTaskReview;
	}
	/**
	* The tool-execution gate this runtime maintains (A3 §3.3), exposed read-only:
	* what a phase admits and refuses is part of what this service promises, and
	* the runtime is its only writer. Diagnostics and tests read it; nothing
	* outside moves a phase through it.
	*/
	get gate() {
		return this.executionGate;
	}
	/** Resolve required capability names against the configured registry. */
	resolveCapabilities(required) {
		return resolveCapabilities(required, this.config.capabilities);
	}
	/** The effective capability registry, cloned so callers cannot mutate runtime state. */
	listCapabilities() {
		return structuredClone(this.config.capabilities);
	}
	/**
	* Evolution apply/rollback seam (guide §2.7.7, W16): replace one capability
	* row in the effective registry at runtime — whole-row semantics, the same
	* row the evolution_apply tool edited in `config.yml` just before calling
	* this, so a restart reloads the identical table. `null` removes the row
	* (rollback of a newly-added capability). Later admissions resolve against
	* the replaced row; in-flight runs are untouched.
	*
	* **A replacement is validated before it lands; a removal is not.** This is
	* the entry that makes a row effective in this process, so it runs the same
	* check the promotion gate ran before the row was written to `config.yml`:
	* every skill the new row grants is discovered from the harness process's own
	* roots and judged by `validateSkillProvider`
	* ({@link precheckReplacedCapabilityRow}), against the live registry's verifier
	* vocabulary — fail-closed when that vocabulary cannot be listed. An unusable
	* provider rejects with its named defects and the table is left exactly as it
	* was, so no path into the effective registry skips the one validator
	* (guide §2.4, S1-C item 3). A removal needs no such check: it grants
	* nothing, and refusing a rollback would strand a deployment on a row it is
	* trying to undo.
	*/
	async applyCapabilityRow(name, entry) {
		if (entry === null) {
			const rest = { ...this.config.capabilities };
			delete rest[name];
			this.config.capabilities = rest;
			return;
		}
		await this.assertReplacementRow(name, entry);
		this.config.capabilities = {
			...this.config.capabilities,
			[name]: structuredClone(entry)
		};
	}
	/**
	* The replacement check behind {@link applyCapabilityRow}: the row as it will
	* read after this write, judged by the admission pre-check itself. Throws with
	* every refusal named (capability, skill, defect code, detail) — and writes
	* nothing, which is what makes the caller's table unchanged.
	*/
	async assertReplacementRow(name, entry) {
		const verifierRefs = await this.registeredVerifierIds();
		const commitLedger = this.softService("evolution");
		const { refusals } = await precheckReplacedCapabilityRow({
			name,
			entry,
			table: this.config.capabilities,
			view: { cwd: process.cwd() },
			...verifierRefs === void 0 ? {} : { verifierRefs },
			...commitLedger === void 0 ? {} : { commitLedger }
		});
		if (refusals.length === 0) return;
		throw new Error(`task-runtime: capability "${name}" was not replaced — the row grants providers that are not usable:\n` + refusals.map((line) => `- ${line}`).join("\n"));
	}
	/**
	* Open one root session's store and adopt the root it already holds, or say
	* that it holds none (A0 §3, the recovery half of the old `createRootTask`).
	*
	* **It creates nothing.** A root task comes into existence exactly one way —
	* a root contract that passed the review gate and was activated
	* ({@link intakeRootContract}) — and this entry refuses to be a second door:
	* there is no parameter, flag or entry that mints a root without a proposal,
	* which is what keeps §1.3's "批准前零根任务" a property of the system rather
	* than of one call path.
	*
	* What it does, in order: create-or-open the store (`rootTaskStoreId`), index
	* every run the store holds, and then —
	*
	* - **no root task**: run the store's own recovery pass (`reconcileStore`:
	*   settle or restart what a dead process left in flight, then the proposals)
	*   and answer from what that pass left. Adoption is the entry graphs and
	*   recovery use (§3 stage B), so the pass runs *here*: a contract whose
	*   approval is on the record and whose process died is carried into the root
	*   it was about by exactly this pass, and a waiting contract's review is
	*   re-asked from the stored facts by it — answering "nothing to adopt" before
	*   that pass would leave a recorded decision uncontinued. A root the pass
	*   activates is then bound the way the bullet below binds one; a store the
	*   pass leaves without a root still answers `{ adopted: false }`, with the
	*   proposals still open on it named by id and status and the fact that
	*   nothing was created stated. A store with no task is a normal state since
	*   §1.1 (a graph's store is opened by its creation and filled when a contract
	*   is accepted), not a failure to report;
	* - **a root task, with a run bound to this root session**: re-check the run's
	*   content binding (S1-C: a snapshot that is no longer readable refuses the
	*   re-entry by name rather than resuming against whatever stands at that path
	*   now), bind the session in this process, derive the session's gate phase
	*   from the store's own run record, settle or restart whatever the store left
	*   in flight (`reconcileStore`) and rebuild this process's workspace
	*   ownership — the same recovery a reopen performs;
	* - **a root task without a run for this session**: refuse by name. That state
	*   is a store whose root was created for a different session or whose run
	*   record is gone, and neither is something to guess a binding for.
	*
	* The gate phase is *derived*, never remembered: a root run that is no longer
	* running — terminal, cancelled, failed, verified — leaves the session
	* `terminal`, so a late intake or a late write on a finished root is refused by
	* the gate as well as by the state (§1.8). Reading it back from the store is
	* what makes that true after a restart, when no process holds the phase the
	* dead one set.
	*
	* **The recovery barrier (A2 §E).** This entry is what an explicit graph
	* activation awaits, and the whole pass above is one barrier: the
	* reconciliation of any open production commit intent (K2, before the store is
	* touched at all — {@link reconcileEvolutionCommits}), reconciliation of the
	* facts, the gate initialization for *every* session the store knows, and the
	* registration of the drivers the pass restarts. The barrier waits for exactly
	* those — never for a batch's execution or a model's output — because a driver
	* it registers is parked (registered, so a cancellation finds it, but not
	* started) until the barrier completes. A store-read failure, a workspace
	* conflict or an exception in the pass fails the barrier rather than surfacing
	* as a warning over an unrecovered store, and a cancellation or the unload
	* invalidates the handle it leaves. Nothing here is a second persisted state
	* machine: the store remains the only source of truth, the next explicit
	* activation is the retry, and business execution checks the handle through
	* {@link recoveryStatus} instead of re-running the pass.
	*/
	async adoptRoot(storeId, rootSessionId) {
		const inflight = this.storeRecovery.get(storeId);
		if (inflight !== void 0 && inflight.status === "recovering") {
			await inflight.promise;
			const settledStatus = (state$1) => state$1.status;
			if (this.storeRecovery.get(storeId) === inflight && settledStatus(inflight) === "failed") throw inflight.failure;
		}
		const barrier = this.adoptRootThroughBarrier(storeId, rootSessionId);
		let release;
		const released = new Promise((resolve$1) => {
			release = resolve$1;
		});
		const state = {
			status: "recovering",
			promise: barrier.then(() => void 0, () => void 0),
			release,
			released,
			pendingDrivers: [],
			pendingNotices: [],
			pendingBatchResults: []
		};
		this.storeRecovery.set(storeId, state);
		try {
			const adoption = await barrier;
			await this.initializeStoreGates(storeId);
			if (state.cancelled) this.storeRecovery.delete(storeId);
			else {
				state.status = "ready";
				state.pendingDrivers.length = 0;
			}
			const deferred = state.pendingQuestionDelivery;
			state.pendingQuestionDelivery = void 0;
			if (!state.cancelled) {
				for (const notice of state.pendingNotices.splice(0)) this.notify(notice.sessionId, notice.text);
				for (const result of state.pendingBatchResults.splice(0)) await this.deliverBatchResultNow(result);
				if (deferred !== void 0) await deferred();
			}
			release(!state.cancelled);
			return adoption;
		} catch (error) {
			state.status = "failed";
			state.reason = error instanceof Error ? error.message : String(error);
			state.failure = error;
			state.pendingQuestionDelivery = void 0;
			state.pendingNotices.length = 0;
			state.pendingBatchResults.length = 0;
			this.standDownPendingDrivers(state);
			release(false);
			try {
				await this.releaseStoreWorkspace(storeId);
			} catch (cleanup) {
				this.warn(`store ${storeId}: its workspace could not be released after a failed recovery (${cleanup instanceof Error ? cleanup.message : String(cleanup)})`);
			}
			throw error;
		}
	}
	/**
	* Settle every open evolution commit intent before this process takes a store
	* over (K2): production is never reconciled lazily, and the deployment's tool
	* switch does not exempt it — a deployment that registers no evolution tool
	* still has to know whether production holds what its ledger says. Both
	* recovery entries reach this through {@link adoptRootThroughBarrier}: an
	* explicit graph activation (activate → adoptRoot) and a restarted root
	* session adopting its run.
	*
	* Read softly (`optionalService(this.ctx, 'evolution')`): a deployment that
	* mounts no evolution plane has no commit to settle and is not refused. A
	* `blocked` outcome is reported by name and does not fail the barrier — the
	* intent stays open, admission refuses the provider whose target it names, and
	* settling it (a retry of the apply/rollback, a later activation) remains the
	* way forward. A real failure of the reconciliation itself does fail the
	* barrier: it is the one result that cannot be read as "nothing was underway".
	*/
	async reconcileEvolutionCommits() {
		const evolution = this.softService("evolution");
		if (evolution?.reconcile === void 0) return;
		let outcomes;
		try {
			outcomes = await evolution.reconcile();
		} catch (error) {
			throw new Error(`task-runtime: the evolution ledger could not be reconciled before this store was recovered (${error instanceof Error ? error.message : String(error)}); the recovery barrier fails rather than taking a store over while an unsettled production commit may stand behind it`);
		}
		for (const outcome of outcomes) {
			if (outcome.result !== "blocked") continue;
			this.warn(`evolution: the commit intent "${outcome.intentId}" (${outcome.direction} of proposal "${outcome.proposalId}") targeting ${outcome.targets.join(", ")} could not be settled — ${outcome.detail ?? "no reason reported"}`);
		}
	}
	/** {@link adoptRoot}'s own pass, as one barrier body: the adoption in the order it always ran. */
	async adoptRootThroughBarrier(storeId, rootSessionId) {
		await this.reconcileEvolutionCommits();
		await this.openOrCreateStore(storeId);
		let snapshot = await this.ctx.task.snapshotIn(storeId);
		this.reindex(storeId, snapshot);
		let root = snapshot.tasks.find((task) => task.parentTaskId === void 0);
		if (root === void 0) {
			await this.reconcileStore(storeId);
			snapshot = await this.ctx.task.snapshotIn(storeId);
			root = snapshot.tasks.find((task) => task.parentTaskId === void 0);
			if (root === void 0) return {
				adopted: false,
				detail: this.nothingAdoptedDetail(storeId, rootSessionId, snapshot)
			};
		}
		const run = [...snapshot.runs].reverse().find((item) => item.taskId === root.taskId && item.sessionId === rootSessionId);
		if (run === void 0) throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${rootSessionId}"`);
		if (run.providerBinding !== void 0) {
			const read = await readRunBinding(run.providerBinding);
			if (read !== void 0 && read.defects.length > 0) throw new Error(`task-runtime: run "${run.runId}" cannot be re-entered: the content it is bound to is not readable:\n- ${read.defects.join("\n- ")}`);
		}
		const phase = this.runGatePhase(run);
		this.sessions.set(rootSessionId, {
			storeId,
			taskId: root.taskId,
			runId: run.runId
		});
		this.startedSessions.add(rootSessionId);
		if (phase === "terminal") this.executionGate.setTerminal(rootSessionId);
		else if (phase !== void 0) this.executionGate.setPhase(rootSessionId, phase);
		await this.reconcileStore(storeId);
		await this.rebuildWorkspaceOwnership(storeId);
		return {
			adopted: true,
			taskId: root.taskId,
			runId: run.runId,
			phase: phase ?? "terminal",
			detail: `store "${storeId}" holds root task "${root.taskId}" with run "${run.runId}" for session "${rootSessionId}"; the session is bound and its gate is "${phase ?? "ungated"}"`
		};
	}
	/**
	* The gate initialization the recovery barrier owes every session the store
	* knows (A2 §E): one snapshot read taken *after* the pass, each run's phase
	* derived and applied under the gate's own token rule — the token is taken
	* before the read, so a decision that lands while it is in flight drops the
	* value it was about to apply. A run that predates phases leaves its session
	* ungated (A3's boundary: reading and cancelling are its only continuations),
	* and {@link gatePhaseFromStore}'s closing-store guard keeps a cancellation's
	* barrier ahead of this pass.
	*
	* This is the one place a restart's sessions get their phases back: the read
	* door (`lookupRun`) no longer writes the gate, so a query cannot be the
	* thing that recovers a store or re-gates a session. A store that cannot be
	* read here fails the barrier — half-gated is not recovered.
	*/
	async initializeStoreGates(storeId) {
		const tokens = /* @__PURE__ */ new Map();
		for (const [sessionId, binding] of this.sessions) if (binding.storeId === storeId) tokens.set(sessionId, this.executionGate.decisionToken(sessionId));
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			throw new Error(`store ${storeId} could not be read to initialize its sessions' gates after recovery (${error instanceof Error ? error.message : String(error)}); the recovery barrier fails rather than leaving the store half-gated`);
		}
		for (const run of snapshot.runs) this.gatePhaseFromStore(run.sessionId, run, storeId, tokens.get(run.sessionId) ?? 0);
		applyStoreQuestionBlocking(this.executionGate, snapshot, (sessionId) => tokens.get(sessionId) ?? 0);
	}
	/**
	* What {@link adoptRoot} answers when the store still holds no root *after* its
	* recovery pass ran (A0 §3 stage B): the proposals that pass left open, by id and
	* status, and the fact that nothing was created.
	*
	* `adopted: false` is a normal answer (§1.1), and this detail is what keeps it an
	* honest one. Recovery never advances a waiting contract and never mints a root
	* without an accepted contract, so what a caller gets back is the state of the
	* intake rather than a verdict: the pass ran, a named proposal is still waiting
	* for a decision or a continuation, and adopting created no task, no run and no
	* proposal of its own.
	*/
	nothingAdoptedDetail(storeId, rootSessionId, snapshot) {
		const open = (snapshot.proposals?.all ?? []).filter(isOpenProposal);
		return `store "${storeId}" holds no root task for session "${rootSessionId}" after its recovery pass, which created no task, no run and no proposal; ${open.length === 0 ? "no proposal is open on it" : `${open.length === 1 ? "1 proposal is" : `${open.length} proposals are`} still open: ` + open.map((proposal) => `"${proposal.proposalId}" (${proposal.status})`).join(", ")}; a root task is created by a root contract intake, never by adoption`;
	}
	/**
	* The gate phase one stored run implies: its coordination phase while it is
	* running, `terminal` once it is not, and `undefined` for a record that
	* predates coordination phases (A3's own boundary — such a run is not gated,
	* and its only legal continuation is cancellation).
	*
	* The derivation every rebinding door performs ({@link adoptRoot} for a root
	* session, {@link gatePhaseFromStore} for any other): the gate is a handle on
	* the run's phase, and the phase is the store's fact, so a session this
	* process never held — or one whose phase moved under an in-flight call — is
	* gated as what its run is, never as what this process happens to remember.
	*/
	runGatePhase(run) {
		if (run.status !== "running") return "terminal";
		return run.executionPhase;
	}
	/** Create the store, or open the one that already exists — the two ways a store can be there (A0 §1.1). */
	async openOrCreateStore(storeId) {
		try {
			await this.ctx.task.createStore(storeId);
		} catch (error) {
			if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error;
			await this.ctx.task.openStore(storeId);
		}
	}
	/**
	* One root contract intake, all the way through (A0 §1.3–§1.4): the proposal
	* is submitted, and — when it may run — activated in the same call. This is
	* the entry the root agent's `task_intake` tool and a direct service call
	* share, and there is no third one: an intake that stops at "the proposal was
	* recorded" is {@link submitRootContractProposal}, and the only thing that
	* turns a proposal into a root task is {@link continueProposal}.
	*
	* Under `off` the submission is born `ready` and the continuation runs
	* immediately, so the *same* call both records `policy-off` and activates — the
	* caller never has to ask twice for a contract that needs no review. Under
	* `all` the proposal is born `pending_review` and this call returns with no
	* task, no run, no spawn and no notification: nothing exists until a recorded
	* decision approves it. A contract that fails the machine rules is refused
	* with field-level reasons before a proposal exists at all.
	*/
	async intakeRootContract(storeId, rootSessionId, spec, options = {}) {
		if (options.exec?.signal?.aborted === true) throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`);
		await this.assertRecoveryReady(storeId, "the intake of a root contract");
		const submission = await this.submitRootContractProposal(storeId, rootSessionId, spec, options);
		const continued = await this.continueProposal(storeId, submission.proposalId, rootSessionId);
		if (continued.status === "activated") return {
			status: "activated",
			proposalId: continued.proposalId,
			taskId: continued.taskId,
			runId: continued.runId,
			detail: continued.detail
		};
		if (continued.status === "pending_review") return {
			status: "pending_review",
			proposalId: continued.proposalId,
			detail: continued.detail
		};
		throw new Error(`task-runtime: root contract of session "${rootSessionId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`);
	}
	/**
	* One root contract proposal is submitted (A0 §1.2–§1.3): the pure pre-check,
	* the immutable record with the policy it was born under, and — under `all` —
	* the review request. Nothing is activated here, whatever the policy: no root
	* task, no run, no spawn, and no id minted except the proposal's own
	* content-derived one.
	*
	* The order is the same contract the batch path follows (§5: 坏提案不弹审批):
	* the presented contract is fixed and normalized, then judged — structural
	* rules, the root's independent-criterion rule, capability resolution and the
	* gap rule, the provider pre-check, the verifier ids — and a contract that
	* fails any of them is refused with field-level reasons *before* a proposal
	* exists, so nothing is shown to a person about a contract that could never
	* run. A contract that passes is recorded once behind its content-derived id,
	* carrying the contract itself, and a retry of the same request (same key,
	* same content) is answered from the record (`existing: true`) instead of
	* building a second proposal.
	*/
	async submitRootContractProposal(storeId, rootSessionId, spec, options = {}) {
		await this.assertRecoveryReady(storeId, "a root contract proposal");
		return await this.serializeRootIntake(storeId, () => this.submitRootProposalOnce(storeId, rootSessionId, spec, options));
	}
	/**
	* Admission and progress are two phases with two owners (A3 §3.1), and this
	* entry is the boundary between them — now with the review gate of §5–§6 in
	* front of it.
	*
	* **Submission**: the batch is pre-checked (protected-input fixing,
	* normalization, structural admission, capability admission, the provider
	* pre-check, verifierRef validation — all before any write) and recorded as
	* an immutable proposal carrying the policy it was born under, the limits in
	* force and the resolution it was reviewed against
	* ({@link submitDecompositionProposal}).
	*
	* **Continuation** (governed by `exec.signal` and the stored decision): the
	* batch is re-checked against what it was proposed under — the parent's state,
	* the limits, the capability resolution, the judging verifiers — and only then
	* admitted ({@link continueProposal}). Under policy `all` that re-check has an
	* approval behind it, or the batch waits; under `off` it runs immediately,
	* exactly as it did before T2.
	*
	* **Admission and the atomic commit**: one `admitBatchIn` records the
	* children, their admission, the dependency edges, the batch identity, the
	* parent's `active → waiting_children` phase change (§1.3) *and* the proposal
	* it consumed, in one commit — so "this proposal became these tasks" is one
	* durable fact a crash can be recovered from. The root budget must be able to
	* reserve one run per child (§3.5), and the caller's checkout must already be
	* held by this run or an ancestor of it (§3.4). Every refusal here is a
	* refusal whole: no id minted, no event written, no worker started.
	*
	* **Progress** (governed by the runtime): the batch is handed to a driver
	* registered under the runtime's own controller, and this call returns
	* `{ batchId, childTaskIds }` immediately. The caller's signal dies with the
	* commit; a tool call that returns, or a caller that aborts its own call,
	* cannot stop a batch the store already admitted (§3.7). {@link awaitBatch}
	* and the owner notification are how a caller learns how it went.
	*
	* This entry keeps its pre-T2 signature and its `off`-path behaviour (it
	* returns the batch), and it is the gate, not the tool layer, that answers a
	* batch under `all`: a direct call gets `{ status: 'pending_review' }` and no
	* batch, exactly as the `task_decompose` tool does. A batch that was decided
	* against between the two calls (rejected, cancelled, stale, expired) is
	* refused by name — the caller has to revise and propose again, which is what
	* the diagnostic says.
	*/
	async decomposeAndRun(storeId, parentTaskId, parentRunId, callerSessionId, spec, exec = {}) {
		await this.assertRecoveryReady(storeId, "a decomposition");
		const submission = await this.submitDecompositionProposal(storeId, parentTaskId, parentRunId, callerSessionId, spec, { ...exec.signal === void 0 && exec.callId === void 0 ? {} : { exec } });
		const continued = await this.continueProposal(storeId, submission.proposalId, callerSessionId, { ...exec.callId === void 0 ? {} : { exec: { callId: exec.callId } } });
		if (continued.status === "admitted") return {
			status: "admitted",
			proposalId: continued.proposalId,
			batchId: continued.batchId,
			childTaskIds: continued.childTaskIds
		};
		if (continued.status === "pending_review") return {
			status: "pending_review",
			proposalId: continued.proposalId,
			detail: continued.detail,
			batchId: void 0,
			childTaskIds: void 0
		};
		throw new Error(`task-runtime: decomposition of "${parentTaskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`);
	}
	/**
	* One decomposition proposal is submitted (T2/T3 §5–§6): the pure pre-check,
	* the immutable record with the policy it was born under, and — under `all` —
	* the review request. Nothing is admitted here and no child id is minted,
	* whatever the policy: submission is the record of what was asked for, and
	* {@link continueProposal} is the only path that turns it into tasks.
	*
	* The order is the contract (§5: 坏提案不弹审批): an illegal batch is refused
	* — with field-level reasons, and with the capability gaps the existing
	* mechanism records as obligations — before a proposal exists and therefore
	* before anything can be shown to a person. A batch that passes is recorded
	* once: the id is derived from its content and the request key from its
	* calling context, so a retry of the same request answers with the stored
	* proposal (`existing: true`) instead of building a second one, a different
	* content under the same explicit key is refused by name, and a revision is
	* new content and a new key.
	*
	* The proposal carries the batch's content, not only its digest (§6), so what
	* a reviewer reads, what a decision binds and what a continuation admits are
	* one record — and an approval taken in one process is continuable in another
	* with nothing but the store.
	*/
	async submitDecompositionProposal(storeId, parentTaskId, parentRunId, callerSessionId, spec, options = {}) {
		await this.assertRecoveryReady(storeId, "a decomposition proposal");
		return await this.serializeParent(storeId, parentTaskId, () => this.submitProposalOnce(storeId, parentTaskId, parentRunId, callerSessionId, spec, options));
	}
	/**
	* One continuation (§6): the post-approval (and post-restart) re-check, and
	* the only place a proposal becomes what it asked for — a batch of tasks, or
	* (A0 §1.4) a root task with its run.
	*
	* The re-check is the whole point of an approval being a *record* rather than
	* a switch. Before anything is admitted, the subject's own state, the limits in
	* force, the capability resolution, the judging verifiers and the content are
	* recomputed and compared with the fingerprints the approval bound — content
	* whose context moved is marked `stale` with the difference named (§6: 不把旧批准
	* 转移给新上下文), and a parent run that ended — or a store that already holds a
	* root, for a root contract — takes the approval down with it (`expired`, never
	* a dispatch). Only a proposal that still is what was reviewed is admitted,
	* from `ready`, with its consumption in the same commit.
	*
	* Idempotent from the outside: an already-admitted proposal answers with what
	* its consumption recorded (no second batch, no second root, no second commit),
	* a waiting one answers `pending_review` without writing anything, and a
	* terminal one answers with the status the store holds.
	*
	* `options.spec` re-presents the batch a caller believes this proposal means.
	* It is only ever a *confirmation*: the re-presented batch is derived and
	* compared with the stored identity, and a different batch — or one whose
	* protected acceptance inputs no longer reproduce the fixed identity — is
	* refused by name. The batch that is admitted is always the stored one, which
	* is what the approval was made against. A root contract needs no such
	* re-presentation: its subject is the store and the session, not a parent whose
	* batch a caller could have confused.
	*/
	async continueProposal(storeId, proposalId, caller, options = {}) {
		await this.assertRecoveryReady(storeId, "the continuation of a proposal");
		const proposal = await this.requireProposal(storeId, proposalId);
		if (proposal.kind === "root") return await this.serializeRootIntake(storeId, () => this.continueProposalIn(storeId, proposalId, caller, options));
		return await this.serializeParent(storeId, proposal.identity.parentTaskId, () => this.continueProposalIn(storeId, proposalId, caller, options));
	}
	/**
	* One review decision is recorded (T2/T3 §6) — the trusted entry the approval
	* channel (stage C) and tests call, never a model tool with a decision
	* argument. Everything it writes is read from the stored proposal: the
	* dossier digest and both context fingerprints come from the record, so a
	* decision cannot name a different batch than the one it is about, and the
	* reducer refuses a claim that disagrees with what is stored.
	*
	* An approval whose parent run has ended is **not** recorded as an approval:
	* §6's rule is that a late approval may only invalidate the proposal, so the
	* entry records `expired` with the reason that made it late and dispatches
	* nothing. An approval that lands is continued immediately
	* ({@link continueProposal}) — and a continuation that could not be performed
	* is reported in the result rather than thrown away: the approval is on the
	* record either way, and the caller learns why the batch did not run.
	*/
	async decideProposal(storeId, proposalId, decision, decidedBy, exec = {}) {
		await this.assertRecoveryReady(storeId, "a proposal decision");
		const proposal = await this.requireProposal(storeId, proposalId);
		const serialize = async (work) => proposal.kind === "root" ? await this.serializeRootIntake(storeId, work) : await this.serializeParent(storeId, proposal.identity.parentTaskId, work);
		return await serialize(async () => {
			const current = await this.requireProposal(storeId, proposalId);
			if (decidedBy.trim().length === 0) throw new Error(`task-runtime: a decision on proposal "${proposalId}" requires a decider`);
			if (decision.reason !== void 0 && decision.reason.trim().length === 0) throw new Error(`task-runtime: a decision reason on proposal "${proposalId}" must be non-empty when given`);
			const decidedAt = decision.decidedAt ?? now();
			let outcome = decision.outcome;
			let reason = decision.reason;
			if (outcome === "approved") {
				const ended = await this.approvalLatenessReason(storeId, current);
				if (ended !== void 0) {
					outcome = "expired";
					reason = `the approval arrived after ${current.kind === "root" ? "the root contract" : "the batch"} could be dispatched: ${ended}`;
				}
			}
			if (outcome === "expired" && reason === void 0) throw new Error(`task-runtime: an expiry of proposal "${proposalId}" must state what ended the batch`);
			await this.ctx.task.decideProposalIn(storeId, {
				proposalId,
				outcome,
				proposalDigest: current.proposalDigest,
				admissionContextDigest: current.admissionContextDigest,
				...outcome === "approved" ? { reviewContextDigest: current.reviewContextDigest } : {},
				decidedBy,
				decidedAt,
				...reason === void 0 ? {} : { reason }
			}, decidedBy);
			if (outcome !== "approved") return {
				proposalId,
				outcome,
				status: outcome,
				detail: `proposal "${proposalId}" is ${outcome}${reason === void 0 ? "" : `: ${reason}`}`,
				...reason === void 0 ? {} : { reason }
			};
			try {
				const continuation = await this.continueProposalIn(storeId, proposalId, this.proposalCallerOf(current), { exec });
				return {
					proposalId,
					outcome,
					status: continuation.status,
					continuation,
					detail: `proposal "${proposalId}" is approved; ${continuation.detail}`
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				this.warn(`proposal ${proposalId}: the approval is recorded but the continuation failed (${detail})`);
				const stored = await this.readProposal(storeId, proposalId).catch(() => void 0);
				return {
					proposalId,
					outcome,
					status: stored?.status ?? outcome,
					detail: `the approval of proposal "${proposalId}" is recorded; ${current.kind === "root" ? "the root was not activated" : "the batch was not admitted"}: ${detail}`
				};
			}
		});
	}
	/**
	* Why an approval arriving now is too late to be honoured, or `undefined` when
	* it is not. Two subjects, two questions: a decomposition batch is late when
	* its parent run has left the deciding phase ({@link parentRunEndedReason}),
	* and a root contract is late when the store already holds a root task — the
	* intake could no longer become that store's root, whatever the contract says.
	*/
	async approvalLatenessReason(storeId, proposal) {
		if (proposal.kind !== "root") return await this.parentRunEndedReason(storeId, proposal);
		const existing = await this.existingRootTask(storeId);
		if (existing === void 0) return void 0;
		return `store "${storeId}" already holds root task "${existing.taskId}"`;
	}
	/**
	* One explicit withdrawal of a proposal (T2/T3 §6; root contracts A0 §1.3): a
	* `cancelled` decision, by the session the proposal belongs to — the run that
	* proposed a batch, or the root session a contract is the goal of. A withdrawal
	* from anywhere else — a deployment retiring a proposal, a reviewer refusing
	* one — goes through {@link decideProposal} with `cancelled` or `rejected`,
	* which records *who* decided instead of hiding it behind the caller's
	* identity.
	*/
	async cancelProposal(storeId, proposalId, caller) {
		const proposal = await this.requireProposal(storeId, proposalId);
		const owner = this.proposalCallerOf(proposal);
		if (caller !== owner) throw new Error(`task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot withdraw it (a withdrawal by anybody else is a decision, and is recorded as one — decideProposal with "cancelled")`);
		return await this.decideProposal(storeId, proposalId, { outcome: "cancelled" }, caller);
	}
	/**
	* The session a proposal belongs to: the caller whose run proposed a batch, or
	* the root session a root contract is the goal of. One reader for the two
	* owners, so "who may continue, decide or withdraw this" is answered once
	* rather than re-derived — with the wrong field — at each entry.
	*/
	proposalCallerOf(proposal) {
		return proposal.kind === "root" ? proposal.identity.rootSessionId : proposal.identity.callerSessionId;
	}
	/**
	* The proposal one id names, as the store holds it (§6) — the read side a
	* tool renders. A proposal is addressed by `proposalId` and by nothing else:
	* there is no "is it approved?" question a caller can assert, and no approval
	* credential this entry would accept, because the answer is the stored record
	* or a refusal naming the id.
	*/
	async proposalIn(storeId, proposalId) {
		return await this.requireProposal(storeId, proposalId);
	}
	/** Every proposal one parent task holds, in submission order — what a task's own view of its batches reads. */
	async proposalsForParent(storeId, parentTaskId) {
		return [...(await this.ctx.task.snapshotIn(storeId)).proposals?.byParentTask[parentTaskId] ?? []];
	}
	/**
	* The first half of the pure pre-check (T2/T3 §2): the caller's declared
	* batch becomes a normalized one — protected acceptance inputs fixed against
	* the caller's own checkout (S1-V slice 2), the one normalization entry over
	* them, and the content identity out.
	*
	* It writes nothing: no event, no obligation, no child id, no proposal. The
	* derivation is separate from {@link checkDerivedBatch} because the *request*
	* a caller presents is decided by this value alone — the digest is what a
	* request key is derived from and what the store is searched by — while the
	* batch's admission rules are asked only once it is clear that this is not
	* simply a request the store already answers (T3 §6 idempotency).
	*
	* Protected inputs are fixed here, not in normalization: by the time the
	* single entry reads the batch there is one form and one form only, and a
	* refused fixing joins the normalization refusal — same error, same no-op.
	*/
	async deriveBatch(identity, spec) {
		const envPath = await this.envPathForSession(identity.callerSessionId);
		const fixed = await fixSpecProtectedInputs(spec, envPath);
		const normalized = normalizeDecomposition(fixed.spec, {
			...identity,
			admissionContext: this.admissionContext()
		});
		const reasons = [...fixed.reasons, ...normalized.ok ? [] : normalized.reasons];
		if (!normalized.ok || reasons.length > 0) return {
			ok: false,
			refusal: {
				error: this.contractRefusal(identity.parentTaskId, reasons),
				reasons,
				gaps: []
			}
		};
		return {
			ok: true,
			batch: normalized.batch,
			...envPath === void 0 ? {} : { envPath }
		};
	}
	/** The manifests one normalized batch resolves to, in batch order — the same list the admission records per child. */
	manifestsOf(batch) {
		return batch.children.map((child) => this.resolveCapabilities(child.contract.requiredCapabilities));
	}
	/**
	* The batch one stored proposal holds, in the shape admission consumes (§6):
	* the contracts and declarations a reviewer read, the caller's reason from the
	* identity, and the limits and digest the proposal recorded. The store is the
	* source of truth — a proposal carries its content, not only its digest — so a
	* continuation, a review request and a recovery in a process that never
	* submitted the batch all render and re-check the same batch from the saved
	* facts.
	*
	* Rebuilding cannot smuggle other content in: the record's own reducer refused
	* a submission whose {@link TaskProposalChild} entries disagree with the
	* identity (same order, same contract digests, same declarations), and the
	* continuation re-derives the identity from this batch and compares the digest
	* with the stored one before anything is admitted.
	*/
	storedBatchOf(proposal) {
		if (proposal.kind === "root") throw new Error(`task-runtime: proposal "${proposal.proposalId}" is a root contract; it holds one contract and no batch`);
		return {
			contractVersion: proposal.identity.contractVersion,
			reason: proposal.identity.reason,
			children: proposal.batch.map((child) => ({
				contract: structuredClone(child.contract),
				dependsOn: [...child.dependsOn],
				decomposable: child.decomposable,
				requiresIndependentAcceptance: child.requiresIndependentAcceptance
			})),
			admission: {
				proposalDigest: proposal.proposalDigest,
				context: structuredClone(proposal.admissionContext)
			}
		};
	}
	/**
	* The run protocol one decomposition has to satisfy before anything is
	* proposed: the run belongs to this task, it is bound to this caller, it is
	* `active`, it is not waiting on an unresolved blocking question, and the call
	* was not already cancelled. Unknown and non-`active` phases are refusals
	* rather than guesses, and a phase-less run is an old record whose only legal
	* continuation is cancellation.
	*
	* **`active` is the batch gate (K1 §1).** A run holds at most one unfinished
	* batch, and an admitted batch moves it `active → waiting_children` in the same
	* commit that creates the children, so "this run is `active`" is the whole of
	* "this run has no unfinished batch" — no second count of batches is kept, and
	* a second batch may be proposed exactly when the first one has ended and the
	* run is active again.
	*
	* **A blocking question is the run's own wait (K1 §1).** A run that asked its
	* parent something unresolved is parked where the protocol put it, and
	* delegating from there would start writers beside a wait that has not ended.
	* The fact is read from the store's question records rather than from the
	* gate's in-memory flag, because admission has to answer the same way in a
	* process that never delivered the question.
	*
	* These checks are asked *after* a request the store already answers has been
	* answered from the record: a retry of a request the run has already proposed
	* is that proposal, whatever state the run is in now (T3 §6 — the same request
	* never builds a second batch), while a genuinely new batch may only be
	* proposed by a run that is still deciding its own work.
	*/
	async assertDecomposableRun(storeId, parentTask, parentRun, callerSessionId, signal) {
		const parentTaskId = parentTask.taskId;
		if (parentRun.taskId !== parentTaskId) throw new Error(`task-runtime: run "${parentRun.runId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`);
		if (parentRun.sessionId !== callerSessionId) throw new Error(`task-runtime: run "${parentRun.runId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`);
		if (parentRun.executionPhase === void 0) throw new Error(`task-runtime: run "${parentRun.runId}" predates coordination phases; it needs recovery (cancel this task tree and re-create it) before it can decompose`);
		if (parentRun.executionPhase !== "active") throw new Error(`task-runtime: run "${parentRun.runId}" is in phase "${parentRun.executionPhase}"; only an active run may decompose (a run with an unfinished batch is handed back \`active\` when the batch ends; only then may it decompose again)`);
		const openQuestions = blockingQuestionsOf(await this.ctx.task.snapshotIn(storeId), parentRun.runId);
		if (openQuestions.length > 0) throw new Error(`task-runtime: run "${parentRun.runId}" is waiting on ${openQuestions.length === 1 ? "an unresolved blocking question" : `${openQuestions.length} unresolved blocking questions`} (${openQuestions.map((question) => question.questionId).join(", ")}); an answer releases the wait, and only then may the run delegate`);
		if (signal?.aborted === true) throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`);
	}
	/**
	* The tasks this run has already asked a person about — its `pending_review`
	* and `approved`/`ready` decomposition proposals that are neither consumed nor
	* terminal (K1 §1: at most one proposal in flight per run).
	*
	* The question is asked of the run, not the task: a parent that ended one batch
	* and proposed another is a different run state from the run that proposed the
	* first, and the store's proposal records are where "in flight" is defined —
	* `admitted` is a consumption, and rejected/cancelled/stale/expired are
	* terminal, so neither holds the run.
	*/
	async inFlightProposalsOf(storeId, parentRunId) {
		const index = (await this.ctx.task.snapshotIn(storeId)).proposals;
		if (index === void 0) return [];
		return index.all.filter((proposal) => proposal.kind !== "root" && proposal.identity.parentRunId === parentRunId && IN_FLIGHT_PROPOSAL_STATUSES.has(proposal.status));
	}
	/**
	* The second half of the pure pre-check (§2): the batch's own admission rules
	* over a derived batch — structural admission (`contractDefects`,
	* `independentAcceptanceDefects`, the growth guardrails, dependency
	* acyclicity), capability resolution and the gap rule, the provider
	* pre-check, and verifierRef validation.
	*
	* Pure and reusable: this is exactly what the post-approval re-check asks
	* again (§6), and it answers with a value ({@link DecompositionRefusal}) so
	* the caller decides whether a refusal is a refusal or an invalidation.
	*/
	async checkDerivedBatch(request) {
		const { identity, parentTask, batch } = request;
		const parentTaskId = identity.parentTaskId;
		const snapshot = await this.ctx.task.snapshotIn(identity.storeId);
		const leaf = parentTask.decompositionStatus === "leaf";
		const verdict = checkDecomposition({
			...parentTask,
			decompositionPolicy: {
				allowed: !leaf || this.config.allowRuntimeDecomposition,
				leaf,
				maxDepth: this.config.maxDepth,
				maxChildren: this.config.maxChildren
			}
		}, batch.children.map((child) => ({
			objective: child.contract.objective,
			acceptanceCriteria: child.contract.acceptanceCriteria,
			dependsOn: child.dependsOn,
			requiresIndependentAcceptance: child.requiresIndependentAcceptance
		})), snapshot.edges);
		if (!verdict.ok) return {
			ok: false,
			refusal: {
				error: /* @__PURE__ */ new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join("\n- ")}`),
				reasons: verdict.reasons,
				gaps: []
			}
		};
		const manifests = this.manifestsOf(batch);
		const rejected = batch.children.map((child, index) => ({
			child,
			index,
			manifest: manifests[index]
		})).filter(({ child, manifest }) => manifest.missing.length > 0 && !child.decomposable);
		if (rejected.length > 0) {
			const detail = rejected.map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(", ")}] and may not decompose`).join("; ");
			const gaps = rejected.map(({ index, manifest }) => ({
				childIndex: index,
				objective: batch.children[index].contract.objective,
				missing: [...manifest.missing]
			}));
			const gapNames = [...new Set(rejected.flatMap(({ manifest }) => manifest.missing))];
			return {
				ok: false,
				refusal: {
					error: /* @__PURE__ */ new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}; ` + escalationHint(`capabilities [${gapNames.join(", ")}] are not granted by the capability registry`, "capability_list and the children's declared capabilities", "grant the capability in the registry, or mark the child decomposable")),
					reasons: [detail],
					gaps
				}
			};
		}
		const precheck = await this.providerPrecheck([...new Set(manifests.flatMap((manifest) => Object.keys(manifest.capabilities)))], { ...request.envPath === void 0 ? {} : { cwd: request.envPath } });
		const refusals = providerRefusals(precheck);
		if (refusals.length > 0) return {
			ok: false,
			refusal: {
				error: /* @__PURE__ */ new Error(`task-runtime: provider pre-check rejected decomposition of "${parentTaskId}":\n- ${refusals.join("\n- ")}`),
				reasons: refusals,
				gaps: []
			}
		};
		try {
			await this.assertKnownVerifierRefs(batch.children.flatMap((child, childIndex) => child.contract.acceptanceCriteria.map((criterion) => ({
				childIndex,
				criterion
			}))), `decomposition of "${parentTaskId}"`);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			return {
				ok: false,
				refusal: {
					error: failure,
					reasons: [failure.message],
					gaps: []
				}
			};
		}
		return {
			ok: true,
			batch,
			manifests,
			providers: precheck
		};
	}
	/**
	* The admission half of one batch that passed the pre-check (T2/T3 §6): the
	* protocol's own commitments, made only now — the root budget reserves one run
	* per child (§3.5), the caller's checkout must be this run's or an ancestor's
	* (§3.4), the child ids are minted, and one `admitBatchIn` commit records the
	* children, their admission, the dependency edges, the batch identity, the
	* parent's `active → waiting_children` phase change and the proposal
	* consumption together (§1.3). The driver is started last, so progress belongs
	* to the runtime before the caller hears anything.
	*
	* The proposal is what makes this half addressable: its consumption names the
	* very children this commit creates, so "the proposal was consumed and these
	* are its tasks" is one durable fact — the record a recovery reads instead of
	* admitting a second batch.
	*
	* A refusal here is a refusal whole (nothing is minted or committed), and it
	* leaves the proposal where it was: `ready` under policy `off`, or `approved`
	* for a batch that was approved and could not be started yet. Nothing is spent
	* by a budget that says no, and a later continuation retries the same batch.
	*/
	async admitPrecheckedBatch(request) {
		const { proposal, parentTask, parentRun, batch, manifests, exec = {} } = request;
		const providers = request.providers;
		const storeId = proposal.identity.storeId;
		const parentTaskId = parentTask.taskId;
		const callerSessionId = proposal.identity.callerSessionId;
		const actor = callerSessionId;
		if (exec.signal?.aborted === true) throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`);
		const childTaskIds = batch.children.map(() => `t-${randomUUID()}`);
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const budget = resolveRootBudget(snapshot, this.config.rootBudget ?? {});
		if (!budget.ok) {
			if (hasRootLimits(this.config.rootBudget)) throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: the root budget cannot be resolved: ${budget.reason}`);
		} else {
			const reserved = checkBatchAdmission(snapshot, budget, batch.children.length);
			if (!reserved.allowed) throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: ${reserved.reason}`);
		}
		const workspacePath = await this.workspacePathForSession(callerSessionId);
		if (workspacePath !== void 0) await this.assertWorkspaceHeldBy(workspacePath, storeId, parentTask, parentRun.runId);
		const children = batch.children.map((child, index) => ({
			taskId: childTaskIds[index],
			definitionRef: {
				taskType: "subtask",
				version: 1
			},
			parentTaskId,
			objective: child.contract.objective,
			depth: parentTask.depth + 1,
			acceptanceCriteria: child.contract.acceptanceCriteria,
			requestedCapabilities: [...child.contract.requiredCapabilities],
			decompositionStatus: child.decomposable || manifests[index].missing.length > 0 ? "decomposable" : "leaf",
			status: "created",
			runIds: [],
			childTaskIds: [],
			contract: child.contract,
			...child.requiresIndependentAcceptance ? { requiresIndependentAcceptance: true } : {}
		}));
		const edges = batch.children.flatMap((child, to) => child.dependsOn.map((from) => ({
			from: childTaskIds[from],
			to: childTaskIds[to]
		})));
		const consumption = {
			proposalId: proposal.proposalId,
			proposalDigest: proposal.proposalDigest,
			reviewContextDigest: proposal.reviewContextDigest,
			parentRunId: parentRun.runId,
			batchId: batchIdFor(parentRun.runId, proposal.proposalId),
			childTaskIds,
			admittedAt: now()
		};
		const { batchId } = consumption;
		await this.ctx.task.admitBatchIn(storeId, parentTaskId, parentRun.runId, children, actor, edges, batch.admission, manifests, consumption);
		this.executionGate.setPhase(callerSessionId, "waiting_children");
		if (workspacePath !== void 0 && this.workspaces !== void 0) {
			const held = this.workspaces.ownerOf(workspacePath);
			if (held !== void 0) await this.workspaces.push(workspacePath, held, {
				kind: "batch",
				storeId,
				taskId: parentTaskId,
				batchId,
				since: now()
			});
		}
		this.startBatchDriver({
			storeId,
			parentTaskId,
			parentRunId: parentRun.runId,
			batchId,
			callerSessionId,
			reason: batch.reason,
			providers,
			...exec.callId === void 0 ? {} : { excludeCallId: exec.callId }
		});
		return {
			batchId,
			childTaskIds
		};
	}
	/**
	* The request key one root intake is addressed by: the caller's own when it has
	* one, otherwise derived from the store, the root session and the contract's
	* digest (`proposal.ts:rootProposalRequestKey`). The same derivation in both
	* the submission and the re-check, so "the request the store already answers"
	* is one question with one answer.
	*/
	rootRequestKey(storeId, rootSessionId, contract, requested) {
		return requested ?? rootProposalRequestKey({
			storeId,
			rootSessionId,
			contractDigest: contractDigest(contract)
		});
	}
	/** The root proposal one request key already names, or `undefined` when the key is free; other content under the key is refused by name (§6). */
	async rootProposalForRequest(storeId, requestKey, contract) {
		const stored = (await this.ctx.task.snapshotIn(storeId)).proposals?.byRequestKey[requestKey];
		if (stored === void 0) return void 0;
		if (stored.kind !== "root") throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a decomposition batch; a request key names one proposal, and a root intake cannot take over a batch's key`);
		if (stored.identity.contractDigest !== contractDigest(contract)) throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose root contract is a different one (digest ${stored.identity.contractDigest} ≠ ${contractDigest(contract)}); a revision is new content under a new key (§6)`);
		return stored;
	}
	/**
	* One root contract's origin, established before anything is read or written on
	* its behalf (A0 §1.10): the store must be the root session's own
	* (`rootTaskStoreId`), that session must be a top-level one — a delegated child
	* is a worker, and its task was admitted by its parent — and its own durable log
	* must hold the person's request: a `user/message` event whose
	* `source.kind === 'user'`, the kind DSH reserves for host-attested human input
	* (`tool-goal/src/authority.ts:hasDirectHumanInput`).
	*
	* **Why the check is fail-closed.** The rules are mechanical and each is
	* answered by a refusal rather than by a default: the store↔session mapping is
	* arithmetic, the delegation facts are the header the spawn stamped, and the
	* request half is *existence* — at least one message whose source is the person.
	* Everything else that reaches a session's log is attributed to its **producer**:
	* this deployment writes its own prompts under `runtime-prompt` (the graph setup
	* text and a spawn's delegated task, `agent-runtime`'s own source) and its notices
	* under `plugin` (`notify`), and neither counts — a session that only ever heard
	* from the deployment has no request to attribute a contract to, and treating the
	* model's summary of a conversation as the request is exactly the "model
	* self-reported confirmation" §1.10 forbids. A log this deployment cannot read is
	* refused for the same reason — "the source could not be checked" is not "the
	* source is the person". Deliberately absent: any natural-language entailment.
	* Whether the contract *states* the request well is the model's reasoning and the
	* §1.2 rules judge the contract itself; this rule only tests that a request of
	* the person's own is there.
	*
	* **Where each half belongs.** Which session may call `task_intake` — graph and
	* root-session membership — is the tool's own rule, because the `graphs` record
	* is the thing that knows it. What this check owns is the quadruple a caller can
	* hand in wrongly: the store, the session, the session's kind and its origin
	* (store ↔ session ↔ top-level ↔ origin), so both doors into a root — the tool's
	* call and a direct service call — meet the same rule wherever a caller reaches
	* the service from. A *top-level* session that no graph owns is deliberately not
	* distinguished here: that is membership, the model-facing door and its tool rule
	* own it, and a direct service caller is this deployment's own trusted code.
	*
	* **Zero side effects.** This is two reads (an id derivation and a log opened
	* `read` and closed), so a refusal here leaves no store opened, no proposal, no
	* task, no run, no worker and no notice — which is why both entries that could
	* create a root call it before their first write.
	*/
	async assertRootContractOrigin(storeId, rootSessionId) {
		const own = rootTaskStoreId(rootSessionId);
		if (storeId !== own) throw this.originRefusal(rootSessionId, `store "${storeId}" is not this session's own store ("${own}"), and a root contract is intaken into the store of the session that asked (A0 §1.10) — never into another session's, whatever the contract says`);
		const { header, events } = await this.rootSessionLog(rootSessionId);
		if (header?.origin === "subagent") throw this.originRefusal(rootSessionId, "this session is a delegated child (its header records origin \"subagent\"), and a root contract belongs to the top-level session a graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)");
		const depth = header?.delegationDepth ?? 0;
		if (depth > 0) throw this.originRefusal(rootSessionId, `this session is a delegated child (its header records delegation depth ${depth}), and a root contract belongs to the top-level session a graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)`);
		if (events.some((event) => event.type === "user/message" && event.data.source.kind === "user")) return;
		throw this.originRefusal(rootSessionId, "this session's own log holds no message from the person (no `user/message` event with source.kind \"user\", the marker DSH reserves for host-attested human input), so the request the contract stands on cannot be established here; the messages this deployment writes to a session of its own are attributed to their producers — its prompts carry source.kind \"runtime-prompt\" (the graph setup text and a spawn's delegated task) and its notices carry \"plugin\" — and neither is a request of the person's (A0 §1.10)");
	}
	/**
	* One root session's own durable log and header, read through
	* `sessionPersistence` in one open/read/close — the surface a session's requests
	* are recorded on, and the record of what kind of session it is — or a named
	* refusal when this deployment cannot read it: no persistence service is
	* mounted, the session is missing, or the open/read throws. The refusal is the
	* answer rather than an empty log, because the rule it feeds is fail-closed
	* ({@link assertRootContractOrigin}): an unreadable log is "the origin is not
	* established", never "assume there is one". The header is handed back as the
	* handle exposes it — a backend that models only the log answers `undefined`,
	* which is read as "no delegation facts recorded" rather than as delegation.
	*/
	async rootSessionLog(rootSessionId) {
		const persistence = this.softService("sessionPersistence");
		if (persistence === void 0 || typeof persistence.open !== "function") throw this.originRefusal(rootSessionId, "this deployment mounts no session-persistence service, so its own log cannot be read (A0 §1.10)");
		let handle;
		try {
			handle = await persistence.open(SessionId(rootSessionId), "read");
			const { events } = await handle.read(0);
			return {
				header: handle.header,
				events
			};
		} catch (error) {
			throw this.originRefusal(rootSessionId, `its own log could not be read (${error instanceof Error ? error.message : String(error)})`);
		} finally {
			if (handle !== void 0) await handle.close().catch(() => void 0);
		}
	}
	/**
	* The one refusal text a root contract whose origin could not be established is
	* refused with, whichever rule (or which unreadable log) said so. It is a
	* family of its own rather than {@link rootRefusal}'s: "the contract was judged
	* and found wanting" and "the request behind it is not established" are
	* different facts about a call, and a caller that revises a contract must not
	* confuse the second for the first.
	*/
	originRefusal(rootSessionId, reason) {
		return /* @__PURE__ */ new Error(`task-runtime: the root contract of session "${rootSessionId}" was refused: ${reason}`);
	}
	/**
	* One root submission, inside the store's root-intake serialization: the
	* contract is fixed and normalized, a request the store already answers is
	* answered from the record, everything else is judged, and the record is
	* written once.
	*
	* The order is the batch path's, for the same reasons: §5's 坏提案不弹审批
	* needs the judgement *before* the record, and T3 §6's idempotency needs the
	* record lookup *before* the judgement — a retry of a request the store
	* already answers is that proposal whatever state the store has moved to since.
	*
	* Ahead of all of it is one rule that is not about the contract at all: the
	* origin of the request it states (§1.10), checked before the store is even
	* opened ({@link assertRootContractOrigin}).
	*/
	async submitRootProposalOnce(storeId, rootSessionId, spec, options) {
		if (options.exec?.signal?.aborted === true) throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`);
		await this.assertRootContractOrigin(storeId, rootSessionId);
		await this.openOrCreateStore(storeId);
		const envPath = await this.envPathForSession(rootSessionId);
		const derived = await this.deriveRootContract(spec, envPath);
		if (!derived.ok) throw derived.refusal;
		const { contract } = derived;
		const requestKey = this.rootRequestKey(storeId, rootSessionId, contract, options.requestKey);
		const stored = await this.rootProposalForRequest(storeId, requestKey, contract);
		if (stored !== void 0) {
			const review$1 = stored.status === "pending_review" ? await this.requestProposalReview({
				kind: "root",
				storeId,
				trigger: "submitted",
				proposal: stored,
				rootSessionId,
				contract: structuredClone(stored.contract),
				manifests: this.rootManifests(stored.contract)
			}) : void 0;
			return {
				proposalId: stored.proposalId,
				status: stored.status,
				policy: stored.policy,
				existing: true,
				detail: this.rootSubmissionDetail(stored, true),
				...review$1 === void 0 ? {} : { review: review$1 }
			};
		}
		const root = await this.existingRootTask(storeId);
		if (root !== void 0) throw new Error(`task-runtime: store "${storeId}" already holds root task "${root.taskId}", so a root contract cannot be intaken here (§1.6: an old graph's root is history and is not re-intaken; a new goal is a new graph)`);
		const checked = await this.checkRootContract({
			rootSessionId,
			contract,
			...envPath === void 0 ? {} : { envPath }
		});
		if (!checked.ok) throw checked.refusal.error;
		const { manifests, providers } = checked;
		const reviewContext = reviewContextOf({
			manifests,
			criteria: contract.acceptanceCriteria,
			providers: providerContentIdentities(providers.capabilities)
		});
		const policy = this.config.generatedTaskReview;
		const identity = {
			contractVersion: TASK_CONTRACT_VERSION,
			storeId,
			rootSessionId,
			requestKey,
			contractDigest: contractDigest(contract)
		};
		const proposal = {
			kind: "root",
			proposalId: rootProposalId(identity),
			requestKey,
			...options.supersedes === void 0 ? {} : { supersedes: options.supersedes },
			status: policy === "all" ? "pending_review" : "ready",
			policy,
			identity,
			contract: structuredClone(contract),
			proposalDigest: rootProposalDigest(identity),
			admissionContext: this.admissionContext(),
			admissionContextDigest: admissionContextDigest(this.admissionContext()),
			reviewContext,
			reviewContextDigest: reviewContextDigest(reviewContext),
			createdAt: now()
		};
		try {
			await this.ctx.task.submitProposalIn(storeId, proposal, rootSessionId);
		} catch (error) {
			const raced = await this.readProposal(storeId, proposal.proposalId).catch(() => void 0);
			if (raced === void 0 || raced.kind !== "root" || raced.proposalDigest !== proposal.proposalDigest) throw error;
			return {
				proposalId: raced.proposalId,
				status: raced.status,
				policy: raced.policy,
				existing: true,
				detail: this.rootSubmissionDetail(raced, true)
			};
		}
		if (proposal.status !== "pending_review") return {
			proposalId: proposal.proposalId,
			status: proposal.status,
			policy: proposal.policy,
			existing: false,
			detail: this.rootSubmissionDetail(proposal, false)
		};
		const review = await this.requestProposalReview({
			kind: "root",
			storeId,
			trigger: "submitted",
			proposal,
			rootSessionId,
			contract: structuredClone(contract),
			manifests
		});
		return {
			proposalId: proposal.proposalId,
			status: proposal.status,
			policy: proposal.policy,
			existing: false,
			detail: this.rootSubmissionDetail(proposal, false),
			review
		};
	}
	/**
	* The first half of the root pre-check: the declared contract's protected
	* acceptance inputs are fixed against the root session's checkout (S1-V slice
	* 2 — a path that cannot be read, or a session whose checkout cannot be
	* resolved, refuses the whole contract), and the single root normalization
	* entry reads the result. Writes nothing.
	*/
	async deriveRootContract(spec, envPath) {
		const fixed = await fixCriteriaProtectedInputs(Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : [], envPath, "root contract");
		const normalized = normalizeRootContract(fixed.reasons.length === 0 ? {
			...spec,
			acceptanceCriteria: fixed.criteria
		} : spec);
		const reasons = [...fixed.reasons, ...normalized.ok ? [] : normalized.reasons];
		if (!normalized.ok || reasons.length > 0) return {
			ok: false,
			refusal: this.rootRefusal(reasons)
		};
		return {
			ok: true,
			contract: normalized.contract
		};
	}
	/** The one refusal text a root contract is rejected at the contract stage with, whichever step produced the reasons. */
	rootRefusal(reasons) {
		return /* @__PURE__ */ new Error(`task-runtime: root contract rejected:\n- ${reasons.join("\n- ")}`);
	}
	/** The manifests one root contract resolves to, from its declared capabilities — the list the activation records. */
	rootManifests(contract) {
		return [this.resolveCapabilities(contract.requiredCapabilities)];
	}
	/** The store's root task, if it has one, read from the store rather than remembered. */
	async existingRootTask(storeId) {
		return (await this.ctx.task.snapshotIn(storeId)).tasks.find((task) => task.parentTaskId === void 0);
	}
	/**
	* The second half of the root pre-check (A0 §3): every rule a root contract
	* has to clear before it can be proposed — structural (`contractDefects`), the
	* independent-criterion rule that makes it a *goal* rather than a restatement
	* of its own decomposition ({@link rootIndependenceDefects}), the capability
	* resolution with the gap rule, the provider pre-check from the root session's
	* own viewpoint, and the verifier ids its criteria pin.
	*
	* The gap rule differs from a batch child's by design: a child that is missing
	* a capability and may decompose is admitted with the gap recorded as an
	* obligation (its parent delegated the gap down), while a root intake has
	* nobody above it to delegate to and nothing to record the gap *on* — the task
	* does not exist yet — so a declared capability this deployment cannot grant is
	* a named refusal. Zero side effects: no obligation, no task, no run, and no
	* file written (the protected inputs were read, never rewritten).
	*
	* Pure and reusable: this is what the post-approval re-check asks again, so a
	* contract whose resolution moved is judged by the same rules that judged it at
	* submission.
	*/
	async checkRootContract(request) {
		const { rootSessionId, contract } = request;
		const label = `root contract of session "${rootSessionId}"`;
		const defects = [...contractDefects(contract.acceptanceCriteria, label), ...rootIndependenceDefects(contract.acceptanceCriteria, label)];
		if (defects.length > 0) return {
			ok: false,
			refusal: {
				error: this.rootRefusal(defects),
				reasons: defects
			}
		};
		const manifests = this.rootManifests(contract);
		const manifest = manifests[0];
		if (manifest.missing.length > 0) {
			const detail = `${label} is missing [${manifest.missing.join(", ")}] and a root has no parent to delegate them to`;
			return {
				ok: false,
				refusal: {
					error: this.rootRefusal([detail]),
					reasons: [detail]
				}
			};
		}
		const precheck = await this.providerPrecheck(Object.keys(manifest.capabilities), { ...request.envPath === void 0 ? {} : { cwd: request.envPath } });
		const refusals = providerRefusals(precheck);
		if (refusals.length > 0) return {
			ok: false,
			refusal: {
				error: this.rootRefusal([`the provider pre-check rejected ${label}:`, ...refusals]),
				reasons: refusals
			}
		};
		try {
			await this.assertKnownVerifierRefs(contract.acceptanceCriteria.map((criterion) => ({
				childIndex: 0,
				criterion
			})), label);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			return {
				ok: false,
				refusal: {
					error: failure,
					reasons: [failure.message]
				}
			};
		}
		return {
			ok: true,
			manifests,
			providers: precheck
		};
	}
	/**
	* One root continuation: the re-check ladder, and — if it passes — the
	* activation. §1.4's rule is that a root contract becomes a task *only* here
	* and only after the approval's own context is re-confirmed.
	*
	* The ladder, in the order the facts become decisive:
	*
	* 1. the origin of the request the contract states (§1.10,
	*    {@link assertRootContractOrigin}) — a store that is not the session's own, a
	*    session that is a delegated child, or a session whose own log holds no
	*    request of the person's, cannot carry a root at all, and this is decided
	*    before the ladder's first write;
	* 2. the store's root task — a store that already holds one refuses every
	*    further root intake. If the root on record is the one *this* proposal
	*    consumed, the proposal is already admitted and the status ladder above has
	*    answered; anything else is another root (a goal change is a new graph),
	*    and this proposal can never become one, so it is `expired` by name;
	* 3. the limits in force, against the fingerprint the approval bound — a
	*    deployment that moved them after the review invalidates it (§6);
	* 4. the resolution this contract was reviewed against — its declared
	*    capabilities, the providers behind them and the verifiers its criteria
	*    pin — recomputed and compared, with the difference named.
	*
	* Only then does it activate, and the activation is one atomic commit
	* ({@link activateRootContract}) followed by this process's own binding, so a
	* crash between the two is recovered by re-running this ladder: the consumption
	* on record is what makes the second run an answer rather than a second root.
	*/
	async continueRootProposalIn(storeId, proposal) {
		const rootSessionId = proposal.identity.rootSessionId;
		await this.assertRootContractOrigin(storeId, rootSessionId);
		const existing = await this.existingRootTask(storeId);
		if (existing !== void 0) return await this.expireProposal(storeId, proposal, `store "${storeId}" already holds root task "${existing.taskId}"; a root contract is one per store and a changed goal is a new graph (§1.6), so this proposal can no longer become the store's root`);
		const envPath = await this.envPathForSession(rootSessionId);
		const contract = structuredClone(proposal.contract);
		if (proposal.status === "ready" && proposal.policy === "off" && this.config.generatedTaskReview === "all") {
			await this.ctx.task.changeProposalPhaseIn(storeId, {
				proposalId: proposal.proposalId,
				to: "pending_review",
				reason: "the deployment tightened the review policy to \"all\" while this contract had not been activated yet (§5: only tightening is allowed, and it reaches whatever has not run)"
			}, rootSessionId);
			let detail = "it is now waiting for a review";
			const reviewed = await this.checkRootContract({
				rootSessionId,
				contract,
				...envPath === void 0 ? {} : { envPath }
			});
			const tightened = await this.requireProposal(storeId, proposal.proposalId);
			if (reviewed.ok) {
				const review = await this.requestProposalReview({
					kind: "root",
					storeId,
					trigger: "tightened",
					proposal: tightened,
					rootSessionId,
					contract,
					manifests: reviewed.manifests
				});
				detail += `; ${review.detail}`;
			} else detail += `, and its contract no longer passes admission (${reviewed.refusal.reasons.join("; ")})`;
			return {
				proposalId: proposal.proposalId,
				status: "pending_review",
				detail: `proposal "${proposal.proposalId}" was sent for review: ${detail}`
			};
		}
		const contextDigest = admissionContextDigest(this.admissionContext());
		if (contextDigest !== proposal.admissionContextDigest) return await this.staleProposal(storeId, proposal, `the limits in force moved since the contract was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`);
		const checked = await this.checkRootContract({
			rootSessionId,
			contract,
			...envPath === void 0 ? {} : { envPath }
		});
		if (!checked.ok) {
			if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error;
			return await this.staleProposal(storeId, proposal, `the contract no longer passes admission: ${checked.refusal.reasons.join("; ")}`);
		}
		const { manifests, providers } = checked;
		const reviewContext = reviewContextOf({
			manifests,
			criteria: contract.acceptanceCriteria,
			providers: providerContentIdentities(providers.capabilities)
		});
		if (reviewContextDigest(reviewContext) !== proposal.reviewContextDigest) return await this.staleProposal(storeId, proposal, `the resolution this contract was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`);
		if (proposal.status === "approved") await this.ctx.task.changeProposalPhaseIn(storeId, {
			proposalId: proposal.proposalId,
			to: "ready",
			reason: "the post-approval re-check passed: the store holds no root, the limits are the ones reviewed, and the capability resolution and the judging verifiers are the ones reviewed"
		}, rootSessionId);
		return await this.activateRootContract({
			storeId,
			rootSessionId,
			proposal,
			contract,
			manifests
		});
	}
	/**
	* The activation (A0 §1.4): one atomic commit creates the root task (parentless,
	* depth 0, carrying the approved contract), its run (born `active`, in the
	* proposal's root session) and the proposal's consumption — and then this
	* process binds what only a process can hold.
	*
	* The order, and why each step is where it is:
	*
	* 1. **the checkout is claimed before anything is written.** A workspace another
	*    live owner holds fails the activation with nothing persisted
	*    ({@link WorkspaceBusyError}, §3.4), which is the same claim-before-write
	*    order every run creation follows; a claim this call made and then lost the
	*    commit for is released, so a refused activation leaves no ownership of a
	*    root that does not exist;
	* 2. **the run's content binding is materialized** (S1-C) — the same builder
	*    every run uses, so a root that grants nothing still gets the honest empty
	*    record rather than no record at all;
	* 3. **the commit** (`admitRootProposalIn`) writes the task, the admission, the
	*    capability manifest, the run and the consumption together. The reducer
	*    refuses a store that already has a root, a consumption naming other
	*    content, and a run that is not born active in this session — so a racing
	*    second activation writes nothing;
	* 4. **the in-process binding**: the session map, the started-session set and
	*    the gate, which is what makes the root session's own tools — decompose,
	*    submit, cancel — legal from here on;
	* 5. **the notification** (best-effort, through the existing owner notice): a
	*    root session that was waiting for its intake hears that its contract is
	*    live. It is a notice, never a wake-up obligation: a session with no live
	*    agent is skipped, and nothing about the activation depends on it.
	*
	* Idempotent from the outside by construction: the ladder in
	* {@link continueRootProposalIn} answers an admitted proposal from its own
	* consumption, and the reducer refuses a second activation even if two callers
	* raced past that read. One accepted fact, one root.
	*/
	async activateRootContract(request) {
		const { storeId, rootSessionId, proposal, contract } = request;
		const manifest = request.manifests[0];
		const taskId = `t-${randomUUID()}`;
		const runId = `r-${randomUUID()}`;
		const workspacePath = await this.workspacePathForSession(rootSessionId);
		let claimed;
		if (workspacePath !== void 0 && this.workspaces !== void 0) {
			await this.workspaces.claim(workspacePath, {
				kind: "run",
				storeId,
				taskId,
				runId,
				since: now()
			});
			claimed = this.workspaces.ownerOf(workspacePath);
		}
		try {
			const providerBinding = await bindRunProviders({
				storeId,
				runId,
				manifest,
				table: this.config.capabilities,
				root: this.config.runBindingRoot
			});
			const task = {
				taskId,
				definitionRef: {
					taskType: "root",
					version: 1
				},
				objective: contract.objective,
				depth: 0,
				acceptanceCriteria: contract.acceptanceCriteria,
				requestedCapabilities: [...contract.requiredCapabilities],
				decompositionStatus: "decomposable",
				status: "created",
				runIds: [],
				childTaskIds: [],
				contract: structuredClone(contract)
			};
			const run = {
				runId,
				taskId,
				sessionId: rootSessionId,
				capabilitySnapshot: capabilitySnapshot(manifest),
				providerBinding,
				executionPhase: "active",
				artifacts: [],
				verifierResults: [],
				status: "running",
				startedAt: now()
			};
			const consumption = {
				kind: "root",
				proposalId: proposal.proposalId,
				proposalDigest: proposal.proposalDigest,
				reviewContextDigest: proposal.reviewContextDigest,
				rootTaskId: taskId,
				rootRunId: runId,
				admittedAt: now()
			};
			await this.ctx.task.admitRootProposalIn(storeId, task, run, rootSessionId, {
				consumption,
				manifest
			});
		} catch (error) {
			if (workspacePath !== void 0 && claimed !== void 0) await this.workspaces?.release(workspacePath, claimed).catch((cause) => {
				this.warn(`workspace ${workspacePath} could not be released after a refused activation (${cause instanceof Error ? cause.message : String(cause)})`);
			});
			throw error;
		}
		this.sessions.set(rootSessionId, {
			storeId,
			taskId,
			runId
		});
		this.startedSessions.add(rootSessionId);
		this.executionGate.setPhase(rootSessionId, "active");
		this.notifyWhenReady(rootSessionId, `the root contract of this session was activated: task ${taskId}, run ${runId} (proposal ${proposal.proposalId}, policy ${proposal.policy}). This session may now decompose, submit its own result, or cancel.`);
		return {
			proposalId: proposal.proposalId,
			status: "activated",
			taskId,
			runId,
			detail: `proposal "${proposal.proposalId}" is activated as root task ${taskId} with run ${runId}`
		};
	}
	/** One root submission's answer, in one sentence: the policy it was born under, the status it holds, and what the caller owes next. */
	rootSubmissionDetail(proposal, existing) {
		const head = existing ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})` : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`;
		switch (proposal.status) {
			case "ready": return `${head}; continue it to activate the root (policy off activates without a review, and the record says policy-off)`;
			case "pending_review": return `${head}; it needs a recorded decision before the root may exist, and nothing is created, spawned or notified until then`;
			case "approved": return `${head}; the approval is on record and the root is not activated yet — continue it to run the post-approval re-check`;
			case "admitted": return `${head}; its root is activated already and will not be activated again`;
			default: return `${head}; a ${proposal.status} proposal is not activated, and a revision is new content under a new key`;
		}
	}
	/**
	* One store's root intakes, one at a time. The batch path serializes per
	* parent (§6's "单进程同一父分解…应串行"); a root contract has no parent, so the
	* subject that has to be serialized is the store itself — two intakes racing
	* into one store must not both read "no root task yet" and both commit. The
	* store's own reducer is the second line of defence (a store that already
	* holds a root refuses the second activation), and a second *process* is
	* covered by it alone, never by this map.
	*/
	async serializeRootIntake(storeId, work) {
		return await this.serializeParent(storeId, ROOT_PROPOSAL_TASK_ID, work);
	}
	/**
	* One submission, inside the parent's serialization: derivation, idempotency,
	* the run protocol, the batch's admission rules, the record, and — under
	* `all` — the review request. The order is the contract:
	*
	* 1. the presented batch is derived (protected inputs fixed, one
	*    normalization), and an illegal batch is refused here, field by field,
	*    *before* a proposal exists — §5's 坏提案不弹审批, and the capability gaps
	*    of such a refusal are recorded as obligations by the same mechanism the
	*    admission chain always used, because the derivation and the batch
	*    judgement write nothing;
	* 2. a request the store already answers (the same key and the same content)
	*    is answered from the record — `existing: true`, the stored status, and,
	*    for a proposal that is still waiting, the review requested again, because
	*    a caller asking again is evidence that somebody is still waiting. This
	*    comes *before* the run protocol, so a retry of a request the run has
	*    already proposed is that proposal whatever state the run is in now;
	* 3. a genuinely new batch takes the run protocol (only a run that may still
	*    decide its own work may propose one) and every admission rule, then the
	*    record is written once behind a content-derived id — carrying the batch
	*    content itself, so the review, the decision and a later continuation all
	*    rest on the same stored facts.
	*/
	async submitProposalOnce(storeId, parentTaskId, parentRunId, callerSessionId, spec, options) {
		const actor = callerSessionId;
		const identity = {
			storeId,
			parentTaskId,
			parentRunId,
			callerSessionId
		};
		const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId);
		const parentRun = await this.ctx.task.runIn(storeId, parentRunId);
		const derived = await this.deriveBatch(identity, spec);
		if (!derived.ok) return await this.refusePrecheck(storeId, parentTaskId, actor, derived.refusal);
		const { batch } = derived;
		const requestKey = options.requestKey ?? proposalRequestKey({
			...identity,
			proposalDigest: batch.admission.proposalDigest
		});
		const stored = await this.proposalForRequest(storeId, requestKey, batch.admission.proposalDigest);
		if (stored !== void 0) {
			const storedBatch = this.storedBatchOf(stored);
			const review$1 = stored.status === "pending_review" ? await this.requestProposalReview({
				storeId,
				trigger: "submitted",
				proposal: stored,
				parentTask,
				batch: storedBatch,
				manifests: this.manifestsOf(storedBatch)
			}) : void 0;
			return {
				proposalId: stored.proposalId,
				status: stored.status,
				policy: stored.policy,
				existing: true,
				detail: this.submissionDetail(stored, true),
				...review$1 === void 0 ? {} : { review: review$1 }
			};
		}
		await this.assertDecomposableRun(storeId, parentTask, parentRun, callerSessionId, options.exec?.signal);
		const inFlight = await this.inFlightProposalsOf(storeId, parentRunId);
		if (inFlight.length > 0) {
			const held = inFlight[0];
			throw new Error(`task-runtime: run "${parentRunId}" already has a proposal in flight — "${held.proposalId}" is ${held.status}; a run has at most one batch proposal at a time, so continue that one (or withdraw it with task_proposal_cancel) rather than proposing a second, and nothing was recorded`);
		}
		const checked = await this.checkDerivedBatch({
			identity,
			parentTask,
			batch,
			...derived.envPath === void 0 ? {} : { envPath: derived.envPath }
		});
		if (!checked.ok) return await this.refusePrecheck(storeId, parentTaskId, actor, checked.refusal);
		const { manifests, providers } = checked;
		const reviewContext = reviewContextOf({
			manifests,
			criteria: batch.children.flatMap((child) => child.contract.acceptanceCriteria),
			providers: providerContentIdentities(providers.capabilities)
		});
		const policy = this.config.generatedTaskReview;
		const proposalIdentity = decompositionIdentity(identity, batch.reason, batch.children);
		const proposal = {
			proposalId: taskProposalId(proposalIdentity),
			requestKey,
			...options.supersedes === void 0 ? {} : { supersedes: options.supersedes },
			status: policy === "all" ? "pending_review" : "ready",
			policy,
			identity: proposalIdentity,
			batch: batch.children,
			proposalDigest: batch.admission.proposalDigest,
			admissionContext: batch.admission.context,
			admissionContextDigest: admissionContextDigest(batch.admission.context),
			reviewContext,
			reviewContextDigest: reviewContextDigest(reviewContext),
			createdAt: now()
		};
		try {
			await this.ctx.task.submitProposalIn(storeId, proposal, actor);
		} catch (error) {
			const raced = await this.readProposal(storeId, proposal.proposalId).catch(() => void 0);
			if (raced === void 0 || raced.proposalDigest !== proposal.proposalDigest) throw error;
			return {
				proposalId: raced.proposalId,
				status: raced.status,
				policy: raced.policy,
				existing: true,
				detail: this.submissionDetail(raced, true)
			};
		}
		if (proposal.status !== "pending_review") return {
			proposalId: proposal.proposalId,
			status: proposal.status,
			policy: proposal.policy,
			existing: false,
			detail: this.submissionDetail(proposal, false)
		};
		const review = await this.requestProposalReview({
			storeId,
			trigger: "submitted",
			proposal,
			parentTask,
			batch,
			manifests
		});
		return {
			proposalId: proposal.proposalId,
			status: proposal.status,
			policy: proposal.policy,
			existing: false,
			detail: this.submissionDetail(proposal, false),
			review
		};
	}
	/**
	* One continuation, inside the subject's serialization (§6's "单进程串行"): the
	* state ladder first, then the re-check, then — only if the proposal still is
	* what was reviewed — admission (a batch) or activation (a root contract).
	*
	* The ladder answers without writing wherever the answer is already on the
	* record: a consumed proposal answers with its own consumption (so a duplicate
	* continuation cannot build a second batch or a second root), a waiting one
	* answers `pending_review`, and a terminal one answers with the status the
	* store holds. The re-check then resolves the four ways §6 describes — the
	* subject already has what this proposal wanted (`stale` for a decomposed
	* parent, `expired` for a store that holds another root), the parent run ended
	* or the store's root appeared (`expired`), the context moved (`stale`, with
	* the difference named), or the proposal still is what was reviewed
	* (`approved → ready` and admit/activate).
	*/
	async continueProposalIn(storeId, proposalId, caller, options) {
		const proposal = await this.requireProposal(storeId, proposalId);
		const owner = this.proposalCallerOf(proposal);
		if (caller !== owner) throw new Error(`task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot continue it (a proposal belongs to the session that made it, and an approval is continued on that session's behalf)`);
		switch (proposal.status) {
			case "admitted": {
				const consumption = proposal.consumption;
				if (consumption === void 0) throw new Error(`task-runtime: proposal "${proposalId}" is admitted without a consumption record; the store is inconsistent and nothing is dispatched`);
				if (consumption.kind === "root") return {
					proposalId,
					status: "activated",
					taskId: consumption.rootTaskId,
					runId: consumption.rootRunId,
					detail: `proposal "${proposalId}" is activated as root task ${consumption.rootTaskId} with run ${consumption.rootRunId}; that root is not activated again`
				};
				return {
					proposalId,
					status: "admitted",
					batchId: consumption.batchId,
					childTaskIds: [...consumption.childTaskIds],
					detail: `proposal "${proposalId}" is admitted as batch ${consumption.batchId}; the runtime owns that batch and it is not admitted again`
				};
			}
			case "pending_review": return {
				proposalId,
				status: "pending_review",
				detail: `proposal "${proposalId}" is waiting for a review; only a decision on the record advances it (§6)`
			};
			case "rejected":
			case "cancelled":
			case "stale":
			case "expired": return {
				proposalId,
				status: proposal.status,
				detail: `proposal "${proposalId}" is ${proposal.status}; nothing was admitted and nothing is dispatched`,
				...proposal.decision?.reason === void 0 ? {} : { reason: proposal.decision.reason }
			};
			default: break;
		}
		if (proposal.kind === "root") return await this.continueRootProposalIn(storeId, proposal);
		const parentTaskId = proposal.identity.parentTaskId;
		const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId);
		const parentRun = await this.ctx.task.runIn(storeId, proposal.identity.parentRunId).catch(() => void 0);
		if (parentRun === void 0) throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${proposal.identity.parentRunId}" is not in store "${storeId}", and a batch is never admitted against a run the store does not hold`);
		if (parentRun.batchId !== void 0) return await this.staleProposal(storeId, proposal, `run "${parentRun.runId}" is already waiting on batch "${parentRun.batchId}", so this proposal's batch cannot become it (a run holds at most one unfinished batch); the approval is not transferred to another batch`);
		if (parentRun.status !== "running" || parentRun.executionPhase !== "active") throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is ${parentRun.status === "running" ? `in phase "${parentRun.executionPhase ?? "none"}"` : parentRun.status}; only an active run may admit a batch, nothing was admitted, and the approval stays on the record`);
		const blocking = blockingQuestionsOf(await this.ctx.task.snapshotIn(storeId), parentRun.runId);
		if (blocking.length > 0) throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is waiting on ${blocking.length === 1 ? "an unresolved blocking question" : `${blocking.length} unresolved blocking questions`} (${blocking.map((question) => question.questionId).join(", ")}); an answer releases the wait, and nothing was admitted`);
		const envPath = await this.envPathForSession(owner);
		if (proposal.status === "ready" && proposal.policy === "off" && this.config.generatedTaskReview === "all") {
			await this.ctx.task.changeProposalPhaseIn(storeId, {
				proposalId,
				to: "pending_review",
				reason: "the deployment tightened the review policy to \"all\" while this batch had not been admitted yet (§5: only tightening is allowed, and it reaches whatever has not run)"
			}, owner);
			const tightened = await this.requireProposal(storeId, proposalId);
			const tightenedBatch = this.storedBatchOf(tightened);
			let detail = "it is now waiting for a review";
			const reviewed = await this.checkDerivedBatch({
				identity: {
					storeId,
					parentTaskId: proposal.identity.parentTaskId,
					parentRunId: proposal.identity.parentRunId,
					callerSessionId: proposal.identity.callerSessionId
				},
				parentTask,
				batch: tightenedBatch,
				...envPath === void 0 ? {} : { envPath }
			});
			if (reviewed.ok) {
				const review = await this.requestProposalReview({
					storeId,
					trigger: "tightened",
					proposal: tightened,
					parentTask,
					batch: tightenedBatch,
					manifests: reviewed.manifests
				});
				detail += `; ${review.detail}`;
			} else detail += `, and its batch no longer passes admission (${reviewed.refusal.reasons.join("; ")})`;
			return {
				proposalId,
				status: "pending_review",
				detail: `proposal "${proposalId}" was sent for review: ${detail}`
			};
		}
		const identity = {
			storeId,
			parentTaskId: proposal.identity.parentTaskId,
			parentRunId: proposal.identity.parentRunId,
			callerSessionId: proposal.identity.callerSessionId
		};
		if (options.spec !== void 0) {
			const presented = await this.deriveBatch(identity, options.spec);
			if (!presented.ok) throw new Error(`task-runtime: the batch presented for proposal "${proposalId}" is not a usable one: ${presented.refusal.reasons.join("; ")}`);
			if (presented.batch.admission.proposalDigest !== proposal.proposalDigest) throw new Error(`task-runtime: the batch presented for proposal "${proposalId}" is a different one (digest ${presented.batch.admission.proposalDigest} ≠ the stored ${proposal.proposalDigest}); an approval never travels to other content, and nothing was admitted`);
		}
		const batch = this.storedBatchOf(proposal);
		const checked = await this.checkDerivedBatch({
			identity,
			parentTask,
			batch,
			...envPath === void 0 ? {} : { envPath }
		});
		if (!checked.ok) {
			if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error;
			return await this.staleProposal(storeId, proposal, `the batch no longer passes admission: ${checked.refusal.reasons.join("; ")}`);
		}
		const { manifests, providers } = checked;
		const contextDigest = admissionContextDigest(this.admissionContext());
		if (contextDigest !== proposal.admissionContextDigest) return await this.staleProposal(storeId, proposal, `the limits in force moved since the batch was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`);
		const reviewContext = reviewContextOf({
			manifests,
			criteria: batch.children.flatMap((child) => child.contract.acceptanceCriteria),
			providers: providerContentIdentities(providers.capabilities)
		});
		if (reviewContextDigest(reviewContext) !== proposal.reviewContextDigest) return await this.staleProposal(storeId, proposal, `the resolution this batch was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`);
		if (proposal.status === "approved") await this.ctx.task.changeProposalPhaseIn(storeId, {
			proposalId,
			to: "ready",
			reason: "the post-approval re-check passed: the parent, the limits, the capability resolution, the judging verifiers and the batch content are the ones that were reviewed"
		}, proposal.identity.callerSessionId);
		const admitted = await this.admitPrecheckedBatch({
			proposal,
			parentTask,
			parentRun,
			batch,
			manifests,
			providers,
			...options.exec === void 0 ? {} : { exec: options.exec }
		});
		return {
			proposalId,
			status: "admitted",
			batchId: admitted.batchId,
			childTaskIds: admitted.childTaskIds,
			detail: `proposal "${proposalId}" is admitted as batch ${admitted.batchId} with ${admitted.childTaskIds.length} child task(s)`
		};
	}
	/**
	* Invalidate one proposal whose context moved (§6), and remember that on the
	* record: `stale` is terminal, it needs its reason, and it is a statement
	* about the proposal rather than a deletion of it — the record and its approval
	* stay readable, and a revision is new content under a new key.
	*/
	async staleProposal(storeId, proposal, reason) {
		await this.ctx.task.changeProposalPhaseIn(storeId, {
			proposalId: proposal.proposalId,
			to: "stale",
			reason
		}, this.proposalCallerOf(proposal));
		return {
			proposalId: proposal.proposalId,
			status: "stale",
			detail: `proposal "${proposal.proposalId}" is stale: ${reason}`,
			reason
		};
	}
	/**
	* Invalidate one proposal the subject can no longer dispatch (§6: a late
	* approval may only invalidate) — a batch whose parent run ended, a root
	* contract whose store already holds a root. The write is a *decision* —
	* `expired` is one of the four outcomes the store records with a decider and a
	* reason — and the decider is named `task-runtime`, because this invalidation
	* is the runtime's own reading of the store's state rather than a person's
	* decision.
	*/
	async expireProposal(storeId, proposal, reason) {
		await this.ctx.task.decideProposalIn(storeId, {
			proposalId: proposal.proposalId,
			outcome: "expired",
			proposalDigest: proposal.proposalDigest,
			admissionContextDigest: proposal.admissionContextDigest,
			decidedBy: "task-runtime",
			decidedAt: now(),
			reason
		}, "task-runtime");
		return {
			proposalId: proposal.proposalId,
			status: "expired",
			detail: `proposal "${proposal.proposalId}" is expired: ${reason}`,
			reason
		};
	}
	/**
	* Why the parent run can no longer host a batch, or `undefined` when it can —
	* the question {@link approvalLatenessReason} asks (a late approval
	* may only invalidate, §6). Three states, each named by what it means rather
	* than by the field: the run is no longer running (cancelled, failed,
	* verified), it predates the coordination phases (an old record whose only
	* legal continuation is cancellation), or it has left the deciding phase by
	* submitting its own result. A run that *is* waiting on an unfinished batch is
	* not answered here either: that is a run which may hold another batch later
	* (K1 §1), and {@link continueProposalIn}'s own re-check is where the batch a
	* proposal competes with is judged.
	*/
	async parentRunEndedReason(storeId, proposal) {
		if (proposal.kind === "root") return void 0;
		const run = await this.ctx.task.runIn(storeId, proposal.identity.parentRunId);
		if (run.status !== "running") return `the parent run "${run.runId}" is ${run.status}`;
		if (run.executionPhase === void 0) return `the parent run "${run.runId}" predates coordination phases`;
		if (run.executionPhase !== "active") return `the parent run "${run.runId}" is in phase "${run.executionPhase}"`;
	}
	/** The proposal a request key already names, or `undefined` when the key is free; a key bound to other content is a refusal by name (§6). */
	async proposalForRequest(storeId, requestKey, proposalDigest) {
		const stored = (await this.ctx.task.snapshotIn(storeId)).proposals?.byRequestKey[requestKey];
		if (stored === void 0) return void 0;
		if (stored.kind === "root") throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a root contract; a request key names one proposal, and a batch cannot take over a root intake's key`);
		if (stored.proposalDigest !== proposalDigest) throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose batch is a different one (digest ${stored.proposalDigest} ≠ ${proposalDigest}); a revision is new content under a new key (§6)`);
		return stored;
	}
	/** The proposal one id names, or a refusal naming the id — the read every public entry starts from. */
	async requireProposal(storeId, proposalId) {
		const proposal = await this.readProposal(storeId, proposalId);
		if (proposal === void 0) throw new Error(`task-runtime: store "${storeId}" holds no proposal "${proposalId}"`);
		return proposal;
	}
	/**
	* The proposal one id names, or `undefined`. The index is optional at the type
	* level (snapshots built by hand predate proposals), and an index this reader
	* cannot see is answered as "not this store's proposal" rather than guessed
	* at.
	*/
	async readProposal(storeId, proposalId) {
		return (await this.ctx.task.snapshotIn(storeId)).proposals?.byId[proposalId];
	}
	/**
	* One submission's answer, in one sentence: the policy it was born under, the
	* status it holds, and what the caller owes next. A re-answer says so, because
	* "the proposal you sent before is still the one this request means" is a
	* different fact from "a new proposal was written".
	*/
	submissionDetail(proposal, existing) {
		const head = existing ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})` : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`;
		switch (proposal.status) {
			case "ready": return `${head}; continue it to admit the batch (policy off admits without a review, and the record says policy-off)`;
			case "pending_review": return `${head}; it needs a recorded decision before its batch can run, and its batch is not admitted, not spawned and its parent is not decomposed`;
			case "approved": return `${head}; the approval is on record and the batch has not been admitted yet — continue it to run the post-approval re-check`;
			case "admitted": return `${head}; its batch is admitted already and will not be admitted again`;
			default: return `${head}; a ${proposal.status} proposal is not dispatched, and a revision is new content under a new key`;
		}
	}
	/**
	* Ask the deployment's review channel about one waiting proposal (§5–§6).
	* A channel is optional and its answer is only ever a notice: absent, it
	* answers "nobody was asked" and the proposal stays `pending_review`; present,
	* it may ask a person and report what it did; a channel that throws is warned
	* about and reported, never swallowed — and none of those outcomes can turn
	* into an approval, because the only thing that advances a waiting proposal is
	* a persisted decision.
	*
	* What the request carries is the subject as the store holds it: for a batch the
	* parent task, the children and the obligations raised on that parent; for a
	* root contract the contract itself and no parent — the task it would become
	* does not exist while it waits, so there is nothing to read obligations off
	* and nothing to pretend. Every arm is built here from stored facts, so a
	* review requested after a restart shows what the record holds.
	*/
	async requestProposalReview(request) {
		const channel = this.softService("proposalReviewChannel");
		if (channel === void 0 || typeof channel.requestReview !== "function") return {
			requested: false,
			detail: "no review channel is mounted (ctx.proposalReviewChannel), so nobody was asked; the proposal stays pending_review and only a recorded decision moves it"
		};
		const registeredVerifiers = await this.registeredVerifierIds();
		const obligations = request.kind === "root" ? [] : await this.ctx.task.snapshotIn(request.storeId).then((snapshot) => snapshot.obligations.filter((obligation) => obligation.sourceTaskId === request.parentTask.taskId)).catch(() => []);
		try {
			const subject = request.kind === "root" ? {
				kind: "root",
				storeId: request.storeId,
				trigger: request.trigger,
				proposal: request.proposal,
				rootSessionId: request.rootSessionId,
				contract: structuredClone(request.contract),
				manifests: request.manifests,
				...registeredVerifiers === void 0 ? {} : { registeredVerifiers },
				obligations
			} : {
				storeId: request.storeId,
				trigger: request.trigger,
				proposal: request.proposal,
				parentTask: request.parentTask,
				batch: request.batch,
				manifests: request.manifests,
				...registeredVerifiers === void 0 ? {} : { registeredVerifiers },
				obligations
			};
			const notice = await channel.requestReview(subject);
			return {
				requested: notice.requested,
				detail: notice.detail ?? (notice.requested ? "the review was requested" : "the review channel did not request a review")
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.warn(`proposal ${request.proposal.proposalId}: the review channel failed (${detail}); the proposal stays pending_review`);
			return {
				requested: false,
				detail: `the review channel failed: ${detail}`
			};
		}
	}
	/**
	* Raise the obligations a capability-gap refusal owes, then raise the refusal
	* itself: one obligation per missing capability, on the parent, with the
	* wording the admission chain has always used (KISS §7 — a gap is a normal
	* state with a record, not a silence). The pre-check wrote nothing, so this is
	* the only place the *fact* of the gap is recorded, and it happens before the
	* batch is refused — never twice, because a refused batch has no proposal to
	* re-refuse.
	*/
	async refusePrecheck(storeId, parentTaskId, actor, refusal) {
		for (const gap of refusal.gaps) for (const missing of gap.missing) await this.ctx.task.recordObligationIn(storeId, {
			obligationId: `o-${randomUUID()}`,
			goal: `capability "${missing}" required by child ${gap.childIndex} ("${gap.objective}") of "${parentTaskId}" is not granted by the registry`,
			criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
			sourceTaskId: parentTaskId
		}, actor);
		throw refusal.error;
	}
	/**
	* One parent's proposal operations, one at a time (§6: "单进程同一父分解的
	* 重检、提案消费及子任务绑定应串行"). What this buys: two approved proposals
	* competing for the same parent can only ever admit one batch — the loser's
	* continuation reads the parent's state *after* the winner's commit, sees it
	* decomposed, and is marked stale by name. The chain is this process's own, per
	* store and parent; a second process is covered by the store's own refusals
	* (a decomposed parent, a duplicate proposal id, a consumed proposal), never
	* by this map.
	*/
	async serializeParent(storeId, parentTaskId, work) {
		const key = `${storeId}/${parentTaskId}`;
		const run = (this.parentChains.get(key) ?? Promise.resolve()).then(work, work);
		const settled = run.then(() => void 0, () => void 0);
		this.parentChains.set(key, settled);
		settled.then(() => {
			if (this.parentChains.get(key) === settled) this.parentChains.delete(key);
		});
		return await run;
	}
	/**
	* The proposal pass of recovery (T3 §5), run at the end of
	* {@link reconcileStore} — after the runs, so a batch this pass admits is
	* either picked up by the run pass or driven by the driver this pass starts,
	* and after the workspace adoption, so an admission is not attempted into a
	* checkout somebody else holds.
	*
	* Per proposal, and in one sentence each: a proposal waiting for a review is
	* *never* advanced by recovery — only a persisted decision moves it (§6) —
	* and its review is requested again when this process can show the batch; a
	* proposal that is `ready` or `approved` is continued (which is where §5's
	* tightening reaches a batch that was born under `off` and the post-approval
	* re-check decides whether the approval still covers the batch); everything
	* terminal is left alone, including `admitted`, whose batch the run pass has
	* already dealt with.
	*
	* Anything this pass could not finish is returned and warned about — never
	* guessed at. An approval that survives a restart is continued from the store
	* alone, because a proposal carries the batch it is about; a review request is
	* re-sent with the same saved facts (the parent, the children's contracts, the
	* resolution), so what a person is asked to review after a crash is what the
	* record holds rather than whatever a live process happened to remember.
	*/
	async reconcileProposals(storeId) {
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: the proposals could not be read for recovery (${error instanceof Error ? error.message : String(error)})`);
			return [];
		}
		const unresolved = [];
		const report = async (proposal, status, reason) => {
			this.warn(`store ${storeId}: proposal ${proposal.proposalId}: ${reason}`);
			unresolved.push({
				proposalId: proposal.proposalId,
				status,
				reason
			});
		};
		for (const proposal of snapshot.proposals?.all ?? []) {
			if (!isOpenProposal(proposal)) continue;
			const proposalId = proposal.proposalId;
			try {
				if (proposal.kind === "root") {
					await this.reconcileRootProposal(storeId, proposal, report);
					continue;
				}
				if (proposal.status === "pending_review") {
					const ended = await this.parentRunEndedReason(storeId, proposal);
					if (ended !== void 0) {
						await report(proposal, proposal.status, `it waits for a review it can no longer be dispatched from (${ended}); only a recorded decision moves it (§6)`);
						continue;
					}
					const parentTask = await this.ctx.task.taskIn(storeId, proposal.identity.parentTaskId);
					const identity = {
						storeId,
						parentTaskId: proposal.identity.parentTaskId,
						parentRunId: proposal.identity.parentRunId,
						callerSessionId: proposal.identity.callerSessionId
					};
					const batch = this.storedBatchOf(proposal);
					const envPath = await this.envPathForSession(proposal.identity.callerSessionId);
					const checked = await this.checkDerivedBatch({
						identity,
						parentTask,
						batch,
						...envPath === void 0 ? {} : { envPath }
					});
					if (!checked.ok) {
						await report(proposal, proposal.status, `it waits for a review and its batch no longer passes admission (${checked.refusal.reasons.join("; ")}); the proposal stays pending_review`);
						continue;
					}
					await this.requestProposalReview({
						storeId,
						trigger: "recovered",
						proposal,
						parentTask,
						batch,
						manifests: checked.manifests
					});
					continue;
				}
				const continuation = await this.serializeParent(storeId, proposal.identity.parentTaskId, () => this.continueProposalIn(storeId, proposalId, proposal.identity.callerSessionId, {}));
				if (continuation.status !== "admitted" && continuation.status !== "activated") await report(proposal, continuation.status, continuation.detail);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.warn(`store ${storeId}: proposal ${proposalId} could not be continued during recovery (${reason}); it stays ${proposal.status}`);
				unresolved.push({
					proposalId,
					status: proposal.status,
					reason
				});
			}
		}
		return unresolved;
	}
	/**
	* One root contract's turn in the proposal pass (A0 §5): the same discipline as
	* a batch's, with the subjects a root contract has instead of a parent task.
	*
	* A `pending_review` root contract is never advanced by recovery — only a
	* persisted decision moves it — and its review is requested again from the
	* stored contract when this process can still show it; a contract whose
	* resolution no longer passes admission is reported and left waiting, exactly
	* as a batch is. A `ready`/`approved` one is continued, which is where §5's
	* tightening reaches a contract born under `off` and where the post-approval
	* re-check decides whether an approval still covers it.
	*
	* The crash points this covers, both of them one call away from a root that
	* exists:
	*
	* - **the decision is on the record and the activation never ran** — the
	*   continuation re-checks and activates, and the store's own reducer is what
	*   keeps it to one root;
	* - **the activation commit landed and this process died before it bound the
	*   session** — the status ladder answers `activated` from the consumption
	*   itself, so recovery re-binds rather than minting a second task and run
	*   ({@link adoptRoot} is that re-binding's other door, for a process that
	*   starts from a graph entry instead).
	*
	* Ahead of both arms is the origin rule (§1.10,
	* {@link assertRootContractOrigin}): a record whose request cannot be
	* established is not something to ask a person about — a decision on it could
	* never activate anything, because the ladder refuses the same fact at
	* activation — and it is not something to continue either. The refusal travels
	* out of this call so the proposal pass reports it unresolved by name.
	*
	* **The boundary this check does not cross.** {@link decideProposal} is left
	* exactly as it was: a person's decision on a record that exists is a
	* record-level fact, and it is written whether or not the contract could ever
	* activate — the activation it would cause is the thing that is refused, here
	* and at every other door into a root. Recovery's pass is not a decision, so it
	* is the one place where "do not ask" can be honoured.
	*/
	async reconcileRootProposal(storeId, proposal, report) {
		const proposalId = proposal.proposalId;
		await this.assertRootContractOrigin(storeId, proposal.identity.rootSessionId);
		if (proposal.status === "pending_review") {
			const existing = await this.existingRootTask(storeId);
			if (existing !== void 0) {
				await report(proposal, "expired", (await this.expireProposal(storeId, proposal, `store "${storeId}" already holds root task "${existing.taskId}", so this contract can no longer become its root`)).detail);
				return;
			}
			const rootSessionId = proposal.identity.rootSessionId;
			const contract = structuredClone(proposal.contract);
			const envPath = await this.envPathForSession(rootSessionId);
			const checked = await this.checkRootContract({
				rootSessionId,
				contract,
				...envPath === void 0 ? {} : { envPath }
			});
			if (!checked.ok) {
				await report(proposal, proposal.status, `it waits for a review and its contract no longer passes admission (${checked.refusal.reasons.join("; ")}); the proposal stays pending_review`);
				return;
			}
			await this.requestProposalReview({
				kind: "root",
				storeId,
				trigger: "recovered",
				proposal,
				rootSessionId,
				contract,
				manifests: checked.manifests
			});
			return;
		}
		const continuation = await this.serializeRootIntake(storeId, () => this.continueProposalIn(storeId, proposalId, proposal.identity.rootSessionId, {}));
		if (continuation.status === "activated") {
			await this.rebindActivatedRoot(storeId, proposal.identity.rootSessionId, continuation.taskId, continuation.runId);
			return;
		}
		await report(proposal, continuation.status, continuation.detail);
	}
	/**
	* Bind a root this process just learned is activated — the crash case where the
	* commit is durable and the session of the process that wrote it is gone. The
	* store is the source of truth for the ids *and* for the phase: a root run that
	* already reached a terminal state leaves the session `terminal` rather than
	* open, so a late intake is refused by the gate as well as by the one-root rule
	* (§1.8), and only a still-running root is bound `active`.
	*/
	async rebindActivatedRoot(storeId, rootSessionId, taskId, runId) {
		this.sessions.set(rootSessionId, {
			storeId,
			taskId,
			runId
		});
		this.startedSessions.add(rootSessionId);
		let phase;
		try {
			phase = this.runGatePhase(await this.ctx.task.runIn(storeId, runId));
		} catch {
			phase = void 0;
		}
		if (phase === "terminal") this.executionGate.setTerminal(rootSessionId);
		else if (phase !== void 0) this.executionGate.setPhase(rootSessionId, phase);
		this.notifyWhenReady(rootSessionId, `recovery bound this session to its activated root contract: task ${taskId}, run ${runId}${phase === "terminal" ? " (that run is terminal, so this session is closed to new work)" : ""}. A late intake for a different contract is refused because the store already holds this root.`);
	}
	/**
	* Replay one historical terminal task under a candidate overlay (guide
	* §2.7.6, W15; the only consumer is `evolution_replay`). The replayed task is
	* created parentless — the historical tree is never edited by a comparison
	* experiment — with the lineage tag on its objective, and settles through the
	* real spawn + verify chain (or the verifier alone when `spawn: false`).
	*
	* The champion's contract (objective / criteria / capabilities) is mirrored
	* unless `options.contract` replaces it (the task_definition deterministic
	* criteria replay). Capability resolution runs against the configured table
	* with `overlay.capabilityOverrides` applied as whole-row replacements; a gap
	* under the overlay refuses the replay before anything is persisted.
	*
	* The replayed task carries a normalized contract like every other creation
	* (T1), and its criteria are judged by the same structural rules an ordinary
	* decomposition child faces (`contractDefects` plus the P4 declarations).
	* Protected acceptance inputs are fixed here too (S1-V slice 2), against the
	* checkout the replay runs in — the caller's own, or the workspace the caller
	* named (`options.workspace`, S4-E): a candidate contract declaring paths has
	* their identity fixed before anything else reads it, while a champion's stored
	* `{ path, sha256 }` refs are carried verbatim — the historical identity is
	* what the pre-judgement re-check compares against, so it is never re-read
	* from disk and never invented. A replay has no batch, so it records no
	* admission context: nothing was proposed to a parent, there is no sibling
	* set to bound, and the limits that do apply to its run are the run's own
	* budget, not a batch's.
	*
	* A caller that names a workspace gets one isolated replay in a directory of
	* its own: the path is resolved and claimed before anything persists, so an
	* unusable or already-held directory refuses the replay with nothing written,
	* and every directory the run resolves against — the pre-check, the protected
	* inputs, the worker and its children, the verifier — is that one.
	*
	* The execution the comparison rests on is the caller's to freeze (S4-E §Q3):
	* `options.agentOptions` is the model selection this run's worker and its
	* sub-execution are created under, forwarded verbatim to the orchestration —
	* this entry does not resolve the model, because what a run really ran under is
	* the caller's frozen fact, and the runtime's job is to make it true. The run's
	* clock is this runtime's own (the per-run `Config.budget.wallTimeMs` and the
	* root tree's deadline); a replay places no separate one. The options are a
	* closed set: a key this build does not read — the deleted experiment clock
	* above all — refuses the replay by name here, before anything else runs.
	*/
	async replayTask(storeId, championTaskId, options, callerSessionId) {
		const known = new Set([
			"lineage",
			"overlay",
			"contract",
			"spawn",
			"workspace",
			"agentOptions",
			"signal"
		]);
		const unknown = Object.keys(options).filter((key) => !known.has(key));
		if (unknown.length > 0) throw new Error(`task-runtime: replayTask does not accept options [${unknown.join(", ")}]`);
		await this.assertRecoveryReady(storeId, "a replay");
		const champion = await this.ctx.task.taskIn(storeId, championTaskId);
		if (champion.status !== "verified" && champion.status !== "failed") throw new Error(`task-runtime: champion task "${championTaskId}" is ${champion.status}; only a terminal (verified or failed) task can be replayed`);
		const championRunId = champion.runIds[champion.runIds.length - 1];
		const effective = options.contract ?? {
			objective: champion.objective,
			acceptanceCriteria: champion.acceptanceCriteria,
			requiredCapabilities: champion.requestedCapabilities
		};
		const table = {
			...this.config.capabilities,
			...options.overlay?.capabilityOverrides ?? {}
		};
		const manifest = resolveCapabilities(effective.requiredCapabilities, table);
		if (manifest.missing.length > 0) throw new Error(`task-runtime: replay of "${championTaskId}" cannot run: capability gap [${manifest.missing.join(", ")}] under the overlay`);
		const named = options.workspace === void 0 ? void 0 : await normalizeWorkspacePath(options.workspace.path);
		const envPath = named ?? await this.envPathForSession(callerSessionId);
		const precheck = await this.providerPrecheck(Object.keys(manifest.capabilities), {
			...envPath === void 0 ? {} : { cwd: envPath },
			...options.overlay?.extraSkillRoots === void 0 ? {} : { extraRoots: [...options.overlay.extraSkillRoots] }
		}, table);
		const refusals = providerRefusals(precheck);
		if (refusals.length > 0) throw new Error(`task-runtime: provider pre-check rejected replay of "${championTaskId}":\n- ${refusals.join("\n- ")}`);
		const label = `replay of "${championTaskId}"`;
		const fixed = await fixCriteriaProtectedInputs(effective.acceptanceCriteria, envPath, label);
		const acceptanceDefects = [
			...fixed.reasons,
			...contractDefects(fixed.criteria, label),
			...independentAcceptanceDefects(fixed.criteria, champion.requiresIndependentAcceptance, label)
		];
		if (acceptanceDefects.length > 0) throw new Error(`task-runtime: replay of "${championTaskId}" rejected:\n- ${acceptanceDefects.join("\n- ")}`);
		await this.assertKnownVerifierRefs(fixed.criteria.map((criterion) => ({
			childIndex: 0,
			criterion
		})), `replay of "${championTaskId}"`);
		const contract = {
			contractVersion: TASK_CONTRACT_VERSION,
			objective: `[${options.lineage}] ${effective.objective}`,
			acceptanceCriteria: structuredClone([...fixed.criteria]),
			assumptions: [...champion.contract?.assumptions ?? []],
			constraints: [...champion.contract?.constraints ?? []],
			requiredCapabilities: [...effective.requiredCapabilities]
		};
		const task = {
			taskId: `t-${randomUUID()}`,
			definitionRef: { ...champion.definitionRef },
			objective: contract.objective,
			depth: 0,
			acceptanceCriteria: contract.acceptanceCriteria,
			requestedCapabilities: [...contract.requiredCapabilities],
			decompositionStatus: "leaf",
			status: "created",
			runIds: [],
			childTaskIds: [],
			contract,
			...champion.requiresIndependentAcceptance === true ? { requiresIndependentAcceptance: true } : {}
		};
		const spawn = options.spawn !== false;
		const replaySnapshot = await this.ctx.task.snapshotIn(storeId);
		const replayBudget = resolveRootBudget(replaySnapshot, this.config.rootBudget ?? {});
		if (!replayBudget.ok) {
			if (hasRootLimits(this.config.rootBudget)) throw new Error(`task-runtime: replay of "${championTaskId}" refused: the root budget cannot be resolved: ${replayBudget.reason}`);
		} else {
			const startVerdict = checkRunStart(replaySnapshot, replayBudget);
			if (!startVerdict.allowed) throw new Error(`task-runtime: replay of "${championTaskId}" refused: ${startVerdict.reason}`);
		}
		const workspacePath = named ?? await this.workspacePathForSession(callerSessionId);
		const workspaceOwner = workspacePath === void 0 ? void 0 : await this.claimReplayWorkspace(workspacePath, storeId, callerSessionId, championTaskId, task.taskId);
		this.replayLineage.set(task.taskId, options.lineage);
		const controller = new AbortController();
		const run = async () => {
			try {
				const outcome = await runReplayTask(await this.orchestrateEnv(callerSessionId, callerSessionId, named), storeId, {
					task,
					manifest,
					providers: precheck,
					lineage: options.lineage,
					agentPreset: options.overlay?.presetOverride ?? resolvePreset(manifest, this.config.defaultPreset),
					...options.overlay?.extraSkillRoots === void 0 ? {} : { skillRoots: [...options.overlay.extraSkillRoots] },
					...options.agentOptions === void 0 ? {} : { agentOptions: { ...options.agentOptions } },
					spawn,
					championRunId
				}, {
					...options.signal === void 0 ? {} : { admission: options.signal },
					advance: controller.signal
				});
				return named === void 0 ? outcome : {
					...outcome,
					workspace: named
				};
			} finally {
				if (workspacePath !== void 0 && workspaceOwner !== void 0) await this.releaseReplayWorkspace(workspacePath, workspaceOwner);
			}
		};
		const promise = run();
		const driverKey = `replay/${storeId}/${championTaskId}`;
		this.registerDriver(driverKey, storeId, controller, promise.then(() => [], () => []));
		try {
			return await promise;
		} finally {
			this.drivers.delete(driverKey);
		}
	}
	/**
	* Register one runtime-owned driver (a batch, or a replay) and return at
	* once: the caller's tool call is over, and the work is the runtime's (§3.7).
	*
	* The registered promise is meant never to reject — a driver settles its own
	* failures by failing the run it reports on — so a rejection here is the one
	* failure it could not settle from where it stood: the view of the deployment
	* it was about to build (`orchestrateEnv`). That is still not fire-and-forget
	* (§3.1): the batch's parent run is failed with the cause, the children that
	* never started are blocked, and the owner is told. The belt below stays for a
	* rejection for a key that names no batch (a replay, whose own caller already
	* receives the error), so nothing surfaces as an unhandled rejection.
	*/
	registerDriver(key, storeId, controller, promise, parentTaskId) {
		this.drivers.set(key, {
			controller,
			promise,
			storeId,
			...parentTaskId === void 0 ? {} : { parentTaskId }
		});
		const forget = () => {
			if (this.drivers.get(key)?.controller === controller) this.drivers.delete(key);
		};
		promise.then(forget, async (error) => {
			forget();
			const reason = `driver ${key} failed outside its own settlement: ${error instanceof Error ? error.message : String(error)}`;
			this.warn(reason);
			await this.failBatchFromRuntime(storeId, key, reason);
		});
	}
	/**
	* Abort and remove the drivers a barrier registered but never released to
	* start (A2 §E). Not-started is not executed: no body runs, nothing is
	* written on the batch's behalf, and the persistent record — which still
	* says the parent waits on its children — is what the next explicit
	* activation re-registers from.
	*/
	standDownPendingDrivers(state) {
		for (const pending of state.pendingDrivers.splice(0)) {
			if (this.drivers.get(pending.key)?.controller === pending.controller) this.drivers.delete(pending.key);
			pending.controller.abort();
		}
	}
	/**
	* A cancellation or the unload invalidates a store's recovery handle (A2
	* §E): a barrier still in flight finishes its own pass but leaves no ready
	* handle and stands its not-yet-started drivers down; a settled handle is
	* dropped. The store's persistent record is untouched — the next explicit
	* activation (`adoptRoot`, through `graphs`' activate) is the retry.
	*/
	invalidateStoreRecovery(storeId) {
		const state = this.storeRecovery.get(storeId);
		if (state === void 0) return;
		if (state.status === "recovering") {
			state.cancelled = true;
			this.standDownPendingDrivers(state);
			state.release(false);
		} else this.storeRecovery.delete(storeId);
	}
	/**
	* Fail one batch's parent run without an `OrchestrateEnv`: the children that
	* never started are blocked, the parent run is failed with the cause, and the
	* owner is told. Store-level on purpose — the caller is here because the env
	* could not be built, so this path holds the settlement's own narrow
	* capabilities ({@link TaskRuntime.settlementParts}) instead of building one —
	* and it never throws, so a driver's failure cannot become an unhandled
	* rejection of its own. `outcome` is `'cancelled'` only for a batch whose
	* driver never started (a recovery barrier stood it down when the cancellation
	* aborted it): the same writes a started driver's abort branch makes, from the
	* one place that can still make them.
	*
	* The two writes are the orchestration's own (A4-5): `blockUnstartedChildren`
	* and `settleRunFromRuntime`, the same pair every other batch failure uses —
	* there is no second terminal-record writer here.
	*/
	async failBatchFromRuntime(storeId, key, reason, outcome = "failed") {
		const prefix = `${storeId}/`;
		if (!key.startsWith(prefix)) return;
		const batchId = key.slice(prefix.length);
		const parts = this.settlementParts(`fail-batch:${storeId}`);
		try {
			const found = await this.batchRecordIn(storeId, batchId);
			if (found === void 0) return;
			await blockUnstartedChildren(parts, storeId, found.memberTaskIds, reason);
			const parentRun = await this.ctx.task.runIn(storeId, found.run.runId).catch(() => void 0);
			if (parentRun === void 0 || parentRun.status !== "running") return;
			await settleRunFromRuntime(parts, storeId, parentRun, outcome, `batch ${batchId} ${outcome}: ${reason}`);
		} catch (error) {
			this.warn(`store ${storeId}: the failed driver ${key} could not be settled (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	/**
	* The batch one id names, as the store itself records it: the run whose
	* **accumulated batches** hold it, together with the parent task that run works
	* on and the members that entry records. `undefined` when no run of the store
	* records the id that way.
	*
	* The accumulation is the record, not the run's current `batchId`: a batch a
	* build before K1 admitted wrote only `b-<parentTaskId>` onto the run, with no
	* proposal and no members, so a run that *waits* on an id its accumulation does
	* not hold is exactly the stopped old state the persistence decision names. This
	* read answers `undefined` for it rather than handing a caller the task's
	* children — the members of a batch nobody can name are not the batch's members —
	* and a settlement path that cannot name a batch reports instead of guessing.
	*
	* The members are returned with the entry because this read is the only place
	* that knows the batch exists: the callers that ask for them would otherwise
	* re-find the entry and be able to pass an absent member list down. A store read
	* that *failed* is not a batch that is not recorded, so it is not caught here:
	* the failure is reported as itself.
	*/
	async batchRecordIn(storeId, batchId) {
		const found = [...(await this.ctx.task.snapshotIn(storeId)).runs].reverse().flatMap((run) => (run.batches ?? []).map((batch) => ({
			run,
			batch
		}))).find((entry) => entry.batch.batchId === batchId);
		return found === void 0 ? void 0 : {
			taskId: found.run.taskId,
			run: found.run,
			memberTaskIds: [...found.batch.memberTaskIds]
		};
	}
	/**
	* Whether one run's own accumulation holds the batch it waits on — the binding a
	* restart needs before it drives a batch (K1 §5).
	*
	* A batch is identified by the pair (parent run, proposal), and the run that
	* admitted it is the only record that can say which members belong to it. A
	* `waiting_children` run whose `batches` holds no such entry carries a batch from
	* before batches were identified that way: nothing in the store says which run,
	* which proposal, or which members a second batch of that parent would have.
	*/
	batchHeldByRun(run, batchId) {
		return run.batches?.some((batch) => batch.batchId === batchId) === true;
	}
	/**
	* Stop a `waiting_children` run whose batch this build cannot name (K1 §5, and
	* the persistence decision that fixes it: an in-flight batch admitted before
	* `(parentRunId, proposalId)` identified one is a **stopped old state**).
	*
	* The stop is by name and by nothing else: the run is settled `cancelled` with
	* the fact recorded — no driver is registered, no child is started, and no batch
	* is attributed to a run or a proposal the store does not name. The children the
	* old admission created are left exactly as they are: which of them belonged to
	* that batch is the very thing this build cannot read, so blocking them would be
	* the guess this stop exists to avoid. The run's Session is reconciled like any
	* other settlement's, and the warn is the operator's half of the refusal.
	*/
	async stopUnidentifiedBatch(env, storeId, run) {
		const reason = run.batchId === void 0 ? `recovery: run "${run.runId}" waits on its children but records no batch id, and a batch this build cannot name is not restarted` : `recovery: run "${run.runId}" waits on batch "${run.batchId}", which the run's own accumulation does not hold. A batch admitted before batches were identified by (parent run, proposal) is a stopped old state: this build cannot tell which run or which proposal admitted it, so it is not restarted and its ownership is not guessed at — the run is settled cancelled`;
		this.warn(`store ${storeId}: ${reason}`);
		await settleRunFromRuntime(env, storeId, run, "cancelled", reason);
		await this.reconcileSessionJobs(run.sessionId);
	}
	/**
	* The narrow capabilities one runtime-level settlement holds — the store, the
	* actor, the notification seam and the gate/workspace bookkeeping — for the one
	* path that writes a terminal state without an orchestration env
	* ({@link failBatchFromRuntime}): the caller is there precisely because this
	* deployment's own view could not be built, so this holds the services that
	* cannot fail for that reason and nothing else. The checkout registry is
	* deliberately not among them: resolving a workspace path here would guess at
	* the very environment whose construction failed, and a marker left for the
	* explicit activation to reconcile is honest where a guessed release is not.
	* Every other batch failure goes through the driver's own env, which carries
	* the registry and releases the layer.
	*/
	settlementParts(actor) {
		return {
			task: this.ctx.task,
			actor,
			notify: (sessionId, text$1) => {
				this.notify(sessionId, text$1);
			},
			observeSession: async (sessionId) => this.observeSession(sessionId),
			budget: { ...this.config.budget },
			onRunSettled: (storeId, taskId, runId, status) => {
				this.runSettledFromRuntime(storeId, taskId, runId, status);
			},
			gate: this.executionGate
		};
	}
	/**
	* What the runtime does when *any* run reaches a terminal state (A3 §3.3): the
	* gate closes for the session that held it, the questions addressed to it stop
	* blocking the runs that asked ({@link recomputeAskingSessions}), and the
	* workspace layer the run claimed comes off the stack. One implementation for
	* the orchestration's settlements and the runtime's own, so a run settled from
	* either side leaves the process in the same state.
	*
	* A run whose session this process never bound is settled like any other: its
	* own gate has nothing to close here, but the runs that asked it are recomputed
	* all the same, because the wait that ended is theirs.
	*/
	runSettledFromRuntime(storeId, taskId, runId, status) {
		this.recomputeAskingSessions(storeId, runId);
		const sessionId = this.sessionBoundInProcess(storeId, runId);
		if (sessionId === void 0) return;
		this.executionGate.setTerminal(sessionId);
		this.releaseRunWorkspaceLayer(storeId, runId, sessionId).catch((error) => {
			this.warn(`run ${runId}: the workspace layer it held could not be released (${error instanceof Error ? error.message : String(error)})`);
		}).finally(() => {
			if (this.sessionWorkspaces.size > 0) this.sessionWorkspaces.delete(sessionId);
			if (this.sessionExecutionBindings.size > 0) this.sessionExecutionBindings.delete(sessionId);
		});
	}
	/**
	* Recompute the question block of every run that asked the run just settled
	* (A4 §F.1), from the store, here.
	*
	* This is the orchestration side of the same step `settleRunFromRuntime` takes
	* where its caller awaits it: the two settlements — the driver's own
	* (`settleChildRun`, `finishBatch`, `settleSubmittedRun`) and the
	* runtime-level entry — must not differ in what the gate shows afterwards, and
	* both derive the value the same way. The read is reported rather than
	* propagated: the run is settled and its record written by now, and a store
	* this process cannot read back is a failure of the *release*, not of the
	* settlement — the next recovery recomputes the same blocks.
	*/
	async recomputeAskingSessions(storeId, runId) {
		try {
			releaseAskingSessions(this.executionGate, await this.ctx.task.snapshotIn(storeId), runId);
		} catch (error) {
			this.warn(`store ${storeId}: the question blocks of the runs that asked run "${runId}" could not be recomputed after it settled (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	/**
	* Report the question deliveries one recovery pass could not settle (A4 §F.1)
	* — `refused` (the body could not be read back from its own citation, or the
	* relay refused) and `unavailable` (the target Session is not live in this
	* process) — as one warning, because the pass's own report is not enough: the
	* explicit adoption drops it, and an undelivered question nobody is told about
	* is a wait whose only remaining ends are a restart and a wall time.
	*
	* Nothing here changes the control flow: the intents stay on the Task record,
	* the next activation retries them, and a delivery that settled is not reported
	* at all. The line names the store, how many of how many intents are still
	* owed, the count per status, and each affected fact with its own refusal.
	*/
	reportUnsettledQuestionDeliveries(storeId, deliveries) {
		const unsettled = deliveries.filter((delivery) => delivery.status === "refused" || delivery.status === "unavailable");
		if (unsettled.length === 0) return;
		const counts = /* @__PURE__ */ new Map();
		for (const delivery of unsettled) counts.set(delivery.status, (counts.get(delivery.status) ?? 0) + 1);
		const byStatus = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${count} ${status}`).join(", ");
		this.warn(`store ${storeId}: ${unsettled.length} of ${deliveries.length} owed question message${deliveries.length === 1 ? "" : "s"} could not be settled (${byStatus}): ${unsettled.map((delivery) => `${delivery.subject} [${delivery.status}${delivery.reason === void 0 ? "" : `: ${delivery.reason}`}]`).join("; ")}. The Task records still hold these intents, no substitute parent is invented, and the next activation retries them`);
	}
	/**
	* Start the driver for one admitted batch. The controller is registered
	* before the driver runs, so a cancellation arriving immediately after
	* admission finds something to abort.
	*
	* When the registration happens *inside* a recovery barrier (A2 §E) the
	* driver is parked after registering: the barrier waits for the
	* registration — reconciliation, gates and drivers are what an activation
	* owes — never for the body, so a `waiting_children` parent recovered inside
	* a graph activation cannot lock that activation on its own batch. The
	* barrier's completion releases the body; its failure or a cancellation
	* stands it down unstarted, and an abort that lands while it is parked
	* resolves it without a spawn.
	*/
	startBatchDriver(options) {
		const key = `${options.storeId}/${options.batchId}`;
		if (this.drivers.has(key)) return;
		const controller = new AbortController();
		const batch = {
			storeId: options.storeId,
			parentTaskId: options.parentTaskId,
			parentRunId: options.parentRunId,
			batchId: options.batchId,
			callerSessionId: options.callerSessionId,
			reason: options.reason,
			...options.excludeCallId === void 0 ? {} : { excludeCallId: options.excludeCallId },
			...options.providers === void 0 ? {} : { providers: options.providers }
		};
		const barrier = this.storeRecovery.get(options.storeId);
		const gate = barrier !== void 0 && barrier.status === "recovering" ? barrier : void 0;
		const promise = (async () => {
			if (gate !== void 0) {
				gate.pendingDrivers.push({
					key,
					controller
				});
				if (!await Promise.race([gate.released, new Promise((resolve$1) => {
					controller.signal.addEventListener("abort", () => resolve$1(false), { once: true });
				})]) || controller.signal.aborted) return [];
			}
			return await driveBatch(await this.orchestrateEnv(options.callerSessionId, options.callerSessionId), {
				...batch,
				signal: controller.signal
			});
		})();
		this.registerDriver(key, options.storeId, controller, promise, options.parentTaskId);
	}
	/**
	* The explicit submission (A3 §3.2, `task_submit_result`): the worker's own
	* account of what it delivered, recorded as the phase change that closes
	* admission, and then the one settlement path every verified run takes.
	*
	* A submission that arrives twice is answered from the record rather than
	* applied again — the phase event is unique by construction, so the second
	* caller reads the first one's result. A run waiting on its children may not
	* submit at all: its batch has to end first (K1 §2), and the batch end hands
	* the run back `active` — only then, with the workspace back and the children's
	* outcomes in the store, may the parent hand in the result that starts its own
	* acceptance.
	*/
	async submitResult(callerSessionId, spec, exec = {}) {
		if (spec.summary.trim().length === 0) throw new Error("task-runtime: a submission requires a non-empty summary of what was delivered");
		const { storeId, task, run } = await this.runForSession(callerSessionId);
		await this.assertRecoveryReady(storeId, "a result submission");
		if (run.status !== "running") return {
			status: run.status,
			detail: `run "${run.runId}" is already settled as "${run.status}"; the recorded submission stands and nothing was changed`
		};
		const phase = run.executionPhase;
		if (phase === "submitted") return {
			status: "submitted",
			detail: `run "${run.runId}" already submitted: ${run.submission?.summary ?? "a submission is recorded"}${run.submission?.submittedAt === void 0 ? "" : ` at ${run.submission.submittedAt}`}. Verification is under way (or already recorded); a second submission changes nothing.`
		};
		if (phase === "waiting_children") throw new Error(`task-runtime: run "${run.runId}" is waiting on its child batch (${run.batchId ?? "unrecorded"}); a parent cannot submit while its children are still running — the batch has to end and hand the run back before the parent may hand in its own result`);
		if (phase === void 0) throw new Error(`task-runtime: run "${run.runId}" predates coordination phases; it cannot submit (needs recovery: cancel this task tree and re-create it)`);
		const submission = {
			summary: spec.summary,
			evidenceRefs: [...spec.evidenceRefs ?? []],
			...spec.notes === void 0 ? {} : { notes: spec.notes },
			submittedAt: now(),
			origin: "worker"
		};
		await this.ctx.task.changeRunPhaseIn(storeId, task.taskId, run.runId, callerSessionId, {
			phase: "submitted",
			submission
		});
		this.executionGate.setPhase(callerSessionId, "submitted");
		const env = await this.orchestrateEnv(callerSessionId, callerSessionId);
		const lineage = this.replayLineage.get(task.taskId);
		const members = runMemberTaskIds(run);
		const status = await settleSubmittedRun(env, storeId, task.taskId, run.runId, {
			...exec.callId === void 0 ? {} : { excludeCallId: exec.callId },
			...lineage === void 0 ? {} : { anomalies: [lineage] },
			...members.length === 0 ? {} : { relatedTaskIds: members }
		});
		return {
			status,
			detail: status === "verified" ? `run "${run.runId}" submitted and verified.` : `run "${run.runId}" submitted and settled ${status}; the terminal review record names why.`
		};
	}
	/**
	* Ask one's direct parent (A4 §F.1, `task_ask_parent`): the runtime entry the
	* tool layer adapts.
	*
	* The identity is the caller's own — a live session, its run binding, and the
	* parent the store derives from that run's task — and the body is read back
	* from the caller's own Session before the store records anything, so a forged
	* call id, another session's citation or a claim the message does not support
	* is refused by name with no task event and no delivery. Everything after the
	* commit (the write-gate block, the message under the *recorded* id) is owned
	* by `./question.ts`; `unavailable` there is not a failure — the intent is
	* durable, the record is returned, and recovery re-delivers.
	*/
	async askParentQuestion(callerSessionId, request) {
		const caller = await this.questionCaller(callerSessionId, "task_ask_parent");
		return await askParentQuestion(this.questionCoordination(), caller, request);
	}
	/**
	* Answer one child's still-open question (A4 §F.1, `task_answer`): the same
	* shape as {@link askParentQuestion}, with the answering run taken from the
	* caller's binding and the delivery addressed to the run that asked. A
	* resolving answer recomputes the *asking* run's block from the store, so a
	* second open question keeps it blocked.
	*/
	async answerParentQuestion(callerSessionId, request) {
		const caller = await this.questionCaller(callerSessionId, "task_answer");
		return await answerParentQuestion(this.questionCoordination(), caller, request);
	}
	/**
	* The identity every question call starts from: the live caller session, its
	* run binding, and the store that binding names. A session with no run (a root
	* before activation, a reviewer, a helper) has nobody to ask and nothing to
	* answer, and is refused here before any other step.
	*/
	async questionCaller(callerSessionId, entry) {
		if (this.agentOrUndefined(callerSessionId) === void 0) throw new Error(`task-runtime: ${entry} needs a live caller session; "${callerSessionId}" has no live agent in this process, and the question identity comes from the live caller's own run`);
		let binding;
		try {
			binding = await this.runForSession(callerSessionId);
		} catch (error) {
			throw new Error(`task-runtime: ${entry} refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		await this.assertRecoveryReady(binding.storeId, entry);
		return {
			sessionId: callerSessionId,
			storeId: binding.storeId,
			runId: binding.run.runId,
			actor: callerSessionId
		};
	}
	/** The services question coordination reaches: the store's entries, the session read path, agent-runtime's handle, and the gate. */
	questionCoordination() {
		return {
			task: this.ctx.task,
			sessionQuery: this.ctx.sessionQuery,
			messages: this.ctx.agentRuntime,
			gate: this.executionGate
		};
	}
	/**
	* Cancel one batch (`task_cancel`, §3.6): abort its driver, which settles the
	* children — the one in flight is cancelled, the ones that never started are
	* blocked before start, and the parent run is cancelled — and return that
	* settlement.
	*
	* The batch is located by the **caller's own run**, never by parsing the id: a
	* batch id names a pair (`b-<parentRunId>-<proposalId>`, {@link batchIdFor}),
	* and a parent that admitted more than one batch has one id per batch. The
	* caller's run is the fact this entry is authorized by, and its *current*
	* unfinished batch (`run.batchId`) is the only batch that can be cancelled —
	* a batch this run already ended is not in flight any more.
	*
	* Only the batch's own parent session may cancel it, and only while the batch
	* is in flight. A batch this process is not driving (already settled, or
	* waiting for recovery after a restart) is refused by name: silently
	* synthesising a settlement would write terminal states the store's own
	* records do not support, and the graph-level cancellation is the entry that
	* covers that case.
	*/
	async cancelBatch(storeId, batchId, callerSessionId) {
		if (!batchId.startsWith("b-")) throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`);
		const parentRun = [...(await this.ctx.task.snapshotIn(storeId)).runs].reverse().find((run) => run.sessionId === callerSessionId);
		if (parentRun === void 0) throw new Error(`task-runtime: batch "${batchId}" cannot be cancelled by session "${callerSessionId}": no run of store "${storeId}" is bound to it`);
		if (parentRun.batchId !== batchId) throw new Error(`task-runtime: batch "${batchId}" is not the batch run "${parentRun.runId}" is waiting on (${parentRun.batchId === void 0 ? "it holds no unfinished batch" : `it waits on "${parentRun.batchId}"`}); a batch is cancelled by the run that admitted it, while it is in flight`);
		const parentTaskId = parentRun.taskId;
		if (parentRun.status !== "running" || parentRun.executionPhase !== "waiting_children") throw new Error(`task-runtime: batch "${batchId}" is not in flight (its parent run is ${parentRun.status}${parentRun.executionPhase === void 0 ? "" : ` in phase "${parentRun.executionPhase}"`}); there is nothing to cancel`);
		const entry = this.drivers.get(`${storeId}/${batchId}`);
		if (entry === void 0) throw new Error(`task-runtime: batch "${batchId}" is not being driven by this process (it may have settled, or it is waiting for recovery); cancel the graph instead`);
		entry.controller.abort();
		await this.abortDescendantBatches(storeId, parentTaskId);
		await this.settleCancelledDescendants(storeId, parentTaskId, batchId, callerSessionId);
		const outcomes = await entry.promise;
		const parentNow = await this.ctx.task.runIn(storeId, parentRun.runId).catch(() => void 0);
		if (parentNow !== void 0 && parentNow.status === "running") await this.failBatchFromRuntime(storeId, `${storeId}/${batchId}`, `the batch was cancelled by its caller before its driver started: ${batchId}`, "cancelled");
		return outcomes;
	}
	/**
	* Settle every run below `taskId` that is still in flight as cancelled — the
	* runs this cancellation owns. The batch's own parent run is not settled here:
	* its driver's abort branch does that, with the batch's terminal review and the
	* owner notification.
	*/
	async settleCancelledDescendants(storeId, taskId, batchId, callerSessionId) {
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const parentOf = new Map(snapshot.tasks.map((task) => [task.taskId, task.parentTaskId]));
		const under = (candidate) => {
			for (let current = parentOf.get(candidate); current !== void 0; current = parentOf.get(current)) if (current === taskId) return true;
			return false;
		};
		const runs = snapshot.runs.filter((run) => run.status === "running" && run.taskId !== taskId && under(run.taskId));
		if (runs.length === 0) return;
		const env = await this.orchestrateEnv(callerSessionId, `cancel-batch:${batchId}`);
		for (const run of runs) await settleRunFromRuntime(env, storeId, run, "cancelled", `the batch was cancelled while this child ran: ${batchId}`);
	}
	/**
	* Abort every batch driver of `storeId` whose parent task is a strict
	* descendant of `taskId`, and wait for their settlements. Each registration
	* names the parent task it drives, so the subtree is read from the store's own
	* task list plus the registrations — never from the batch id, which names the
	* pair (parent run, proposal) and cannot be parsed back into a task.
	*/
	async abortDescendantBatches(storeId, taskId) {
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: the batches under "${taskId}" could not be listed (${error instanceof Error ? error.message : String(error)}); only the batch itself was aborted`);
			return;
		}
		const parentOf = new Map(snapshot.tasks.map((task) => [task.taskId, task.parentTaskId]));
		const under = (candidate) => {
			for (let current = parentOf.get(candidate); current !== void 0; current = parentOf.get(current)) if (current === taskId) return true;
			return false;
		};
		const entries = [...this.drivers.entries()].filter(([, driver]) => {
			if (driver.storeId !== storeId || driver.parentTaskId === void 0) return false;
			return driver.parentTaskId !== taskId && under(driver.parentTaskId);
		});
		for (const [, driver] of entries) driver.controller.abort();
		await Promise.all(entries.map(([, driver]) => driver.promise.catch(() => [])));
	}
	/**
	* Cancel everything one store has in flight (§3.6), called by
	* `graphs.remove` before the graph is stopped and exposed as a service API.
	*
	* The order is the promise: the gate closes for every session of the store
	* first (so no further tool call writes anything), then every driver is
	* aborted and awaited (so the children and parents settle through the same
	* rules as a batch cancellation), then the runs that are still non-terminal —
	* a root run with no batch in flight, a replay — are cancelled with the
	* reason recorded, and finally the workspace claim this store held is released
	* and its sessions' managed jobs are reconciled.
	*
	* Idempotent: every step tolerates having already happened, so a second call
	* is a no-op rather than an error.
	*/
	async cancelGraph(storeId, reason) {
		try {
			this.reindex(storeId, await this.ctx.task.snapshotIn(storeId));
		} catch (error) {
			this.warn(`store ${storeId}: it could not be read for the cancellation "${reason}" (${error instanceof Error ? error.message : String(error)}), so nothing was cancelled`);
			return;
		}
		this.closingStores.add(storeId);
		this.invalidateStoreRecovery(storeId);
		try {
			for (const [sessionId, binding] of this.sessions) if (binding.storeId === storeId) this.executionGate.setTerminal(sessionId);
			const entries = [...this.drivers.values()].filter((entry) => entry.storeId === storeId);
			for (const entry of entries) entry.controller.abort();
			await Promise.all(entries.map((entry) => entry.promise.catch(() => [])));
			const snapshot = await this.ctx.task.snapshotIn(storeId);
			const env = await this.orchestrateEnv(this.recoverySessionFor(snapshot, storeId), `cancel-graph:${storeId}`);
			const stillRunning = snapshot.runs.filter((run) => run.status === "running");
			for (const run of stillRunning) await settleRunFromRuntime(env, storeId, run, "cancelled", `cancelled with the graph: ${reason}`);
			for (const run of stillRunning) await this.reconcileSessionJobs(run.sessionId);
			await this.releaseStoreWorkspace(storeId);
		} finally {
			this.closingStores.delete(storeId);
		}
	}
	/**
	* The settlement of one batch, from the outside: the registered driver's own
	* promise when this process is driving it, or the outcomes the store already
	* records when the batch settled earlier (or in another process). §3.8's
	* `awaitBatch` — the entry a test or a service uses to wait for a batch a tool
	* call no longer waits for.
	*
	* The batch is resolved through the store's own accumulation — the run whose
	* record holds this batch id, and that batch's members — never by parsing the
	* id: an id names a pair, and a parent that admitted several batches holds one
	* entry per batch. A batch no run records is refused by name rather than
	* answered with another batch's children.
	*/
	async awaitBatch(storeId, batchId) {
		if (!batchId.startsWith("b-")) throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`);
		const entry = this.drivers.get(`${storeId}/${batchId}`);
		if (entry !== void 0) return await entry.promise;
		const found = await this.batchRecordIn(storeId, batchId);
		if (found === void 0) throw new Error(`task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; a batch is read from the run that admitted it, never derived from its id`);
		return await deriveChildOutcomes(this.ctx.task, storeId, found.taskId, found.memberTaskIds);
	}
	/**
	* The recovery entry (A3 §3.6): settle or restart what a store left in flight.
	* Idempotent, and safe to call on a store this process is already driving —
	* the registered batches are skipped, and runs this process started are left
	* to their own drivers.
	*
	* The order is depth-descending (a child before its parent), so a restarted
	* parent batch reads its children already settled:
	*
	* - a run with no phase is an old record: it is left exactly as it is, and the
	*   read side derives `needs-recovery` from the missing phase — inventing a
	*   phase here would admit a run nobody knows the state of;
	* - a run whose content binding no longer re-reads is failed by name (S1-C's
	*   refusal, never a silent fallback);
	* - `submitted` runs are verified (the phase is the whole recovery evidence);
	* - `active` runs that are not a root are in-flight workers: nothing can
	*   confirm the writes they may have made, so they are cancelled with the
	*   diagnostic — a root run is left alone, because a root legitimately sits
	*   `active` between its own decisions;
	* - `waiting_children` runs are restarted, unless the workspace is held by
	*   another live process, in which case they fail by name rather than writing
	*   into a checkout somebody else owns.
	*
	* The run pass is followed by the proposal pass (T2/T3 §5–§6,
	* {@link reconcileProposals}): a proposal that is `ready` or `approved` is
	* continued — the re-check decides whether its approval still covers the batch,
	* and §5's tightening catches a batch that was born under `off` — while a
	* proposal waiting for a review is only re-offered to the review channel, never
	* advanced, because only a persisted decision moves it. The order is the
	* point: the run pass settles and restarts what a previous process left in
	* flight, the workspace question ("is this checkout ours?") is answered before
	* anything is admitted into it, and a batch the proposal pass admits is driven
	* by the driver *it* starts — there is nothing left for the run pass to see.
	* The report says what could not be finished and why, so a caller (the boot
	* path, an adoption) can see the proposals recovery left for a person instead
	* of reading a silent void.
	*/
	async reconcileStore(storeId) {
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: recovery could not read the store (${error instanceof Error ? error.message : String(error)}), so nothing was reconciled`);
			return {
				unresolvedProposals: [],
				questionDeliveries: [],
				questionResumes: []
			};
		}
		this.reindex(storeId, snapshot);
		const depthOf = (taskId) => snapshot.tasks.find((task) => task.taskId === taskId)?.depth ?? 0;
		const ordered = snapshot.runs.filter((run) => run.status === "running").sort((left, right) => depthOf(right.taskId) - depthOf(left.taskId));
		const env = await this.orchestrateEnv(this.recoverySessionFor(snapshot, storeId), `recovery:${storeId}`);
		const waiting = [];
		/** The delegated parents whose batches ended before the crash (K1 §2, §5): `active` non-root runs holding accumulated batches. */
		const returnedParents = [];
		const questionResumes = [];
		for (const run of ordered) {
			if (rootTaskStoreId(run.sessionId) !== storeId && this.startedSessions.has(run.sessionId)) continue;
			if (run.batchId !== void 0 && this.drivers.has(`${storeId}/${run.batchId}`)) continue;
			if (run.executionPhase === void 0) continue;
			if (run.providerBinding !== void 0) {
				const read = await this.readRunBinding(run.providerBinding);
				if (read !== void 0 && read.defects.length > 0) {
					await settleRunFromRuntime(env, storeId, run, "failed", `recovery re-check rejected this run's content binding:\n- ${read.defects.join("\n- ")}`);
					continue;
				}
			}
			if (run.executionPhase === "submitted") {
				const lineage = this.replayLineage.get(run.taskId);
				await settleSubmittedRun(env, storeId, run.taskId, run.runId, lineage === void 0 ? {} : { anomalies: [lineage] });
				continue;
			}
			if (run.executionPhase === "waiting_children") {
				if (run.batchId !== void 0 && this.batchHeldByRun(run, run.batchId)) {
					waiting.push(run);
					continue;
				}
				await this.stopUnidentifiedBatch(env, storeId, run);
				continue;
			}
			if (rootTaskStoreId(run.sessionId) === storeId) continue;
			if ((run.batches?.length ?? 0) > 0) {
				returnedParents.push(run);
				continue;
			}
			const pendingQuestions = blockingQuestionsOf(snapshot, run.runId);
			const owed = owedQuestionMessagesTo(snapshot, run.sessionId);
			if (pendingQuestions.length > 0 || owed.length > 0) {
				const attempt = await resumeAdoptedWorker(env, storeId, run);
				this.recordWorkerResume(storeId, run, attempt, questionResumes, "an unresolved blocking question");
				if (attempt.status === "refused") {
					await settleRunFromRuntime(env, storeId, run, "failed", `recovery refused to continue run "${run.runId}": it was waiting on ${pendingQuestions.length === 1 ? "an unresolved blocking question" : `${pendingQuestions.length} unresolved blocking questions`} (${pendingQuestions.map((question) => question.questionId).join(", ")})${owed.length === 0 ? "" : ` and is owed ${owed.length} question message${owed.length === 1 ? "" : "s"} it has not been given`}, but its Session "${run.sessionId}" could not be brought back under its own identity: ${attempt.reason}`);
					await this.reconcileSessionJobs(run.sessionId);
				}
				continue;
			}
			await settleRunFromRuntime(env, storeId, run, "cancelled", `recovery: run "${run.runId}" was in flight when this store was reopened and never submitted; the writes it may already have made cannot be confirmed, so it is settled cancelled and its managed jobs are reconciled`);
			await this.reconcileSessionJobs(run.sessionId);
		}
		if (waiting.length > 0 || returnedParents.length > 0) {
			const sessionId = this.recoverySessionFor(snapshot, storeId);
			const workspace = await this.workspacePathForSession(sessionId);
			let adoptable = true;
			if (workspace !== void 0 && this.workspaces !== void 0) {
				const adoption = await this.workspaces.ownerOf(workspace) === void 0 ? await this.workspaces.reconcileAdopt(workspace) : { adopted: true };
				if (!adoption.adopted) {
					for (const run of waiting) await settleRunFromRuntime(env, storeId, run, "failed", `the workspace cannot be taken over for recovery: ${adoption.reason}`);
					for (const run of returnedParents) {
						await settleRunFromRuntime(env, storeId, run, "failed", `recovery refused to bring run "${run.runId}" back into its checkout: its child batches ended and it has to be told so, but the workspace cannot be taken over for recovery: ${adoption.reason}`);
						await this.reconcileSessionJobs(run.sessionId);
					}
					adoptable = false;
				} else await this.rebuildWorkspaceOwnership(storeId);
			}
			if (adoptable) {
				for (const run of returnedParents) {
					const attempt = await resumeAdoptedWorker(env, storeId, run);
					const batches = (run.batches ?? []).map((batch) => batch.batchId).join(", ");
					this.recordWorkerResume(storeId, run, attempt, questionResumes, `ended child batches it has not been told about (${batches})`);
					if (attempt.status === "refused") {
						await settleRunFromRuntime(env, storeId, run, "failed", `recovery refused to continue run "${run.runId}": its child batches ended (${batches}) and its Session "${run.sessionId}" could not be brought back under its own identity: ${attempt.reason}`);
						await this.reconcileSessionJobs(run.sessionId);
					}
				}
				const settled = /* @__PURE__ */ new Set();
				for (const run of waiting) {
					if (rootTaskStoreId(run.sessionId) === storeId) continue;
					if (!(pendingCoordinationOf(snapshot, run.runId).length > 0 || owedQuestionMessagesTo(snapshot, run.sessionId).length > 0)) continue;
					const attempt = await resumeAdoptedWorker(env, storeId, run);
					this.recordWorkerResume(storeId, run, attempt, questionResumes, "coordination its own batch is waiting on");
					if (attempt.status === "refused") {
						await settleRunFromRuntime(env, storeId, run, "failed", `recovery refused to continue run "${run.runId}": it is a waiting parent with open coordination, but its Session "${run.sessionId}" could not be brought back under its own identity: ${attempt.reason}`);
						await this.reconcileSessionJobs(run.sessionId);
						settled.add(run.runId);
					}
				}
				for (const run of waiting) {
					if (run.batchId === void 0) continue;
					if (settled.has(run.runId)) continue;
					this.startBatchDriver({
						storeId,
						parentTaskId: run.taskId,
						parentRunId: run.runId,
						batchId: run.batchId,
						callerSessionId: run.sessionId,
						reason: `recovered batch ${run.batchId} after a restart`
					});
				}
			}
		}
		const deliverQuestions = async () => {
			try {
				const deliveries = await reconcileQuestionDeliveries(this.questionCoordination(), storeId);
				this.reportUnsettledQuestionDeliveries(storeId, deliveries);
				await this.wakeUnclaimedQuestionMessages(storeId, deliveries);
				return deliveries;
			} catch (error) {
				this.warn(`store ${storeId}: its pending question deliveries could not be reconciled (${error instanceof Error ? error.message : String(error)}); the Task records still hold the intents, and the next activation retries`);
				return [];
			}
		};
		const deliverBatches = async () => {
			let current;
			try {
				current = await this.ctx.task.snapshotIn(storeId);
			} catch (error) {
				this.warn(`store ${storeId}: the batches it may still owe its Sessions could not be read back (${error instanceof Error ? error.message : String(error)}); the runs' own records hold the fact, and the next activation retries`);
				return;
			}
			const owed = owedBatchResults(current);
			if (owed.length === 0) return;
			const unread = [];
			for (const entry of owed) try {
				if (await this.redeliverBatchResult(storeId, entry.batchId) === "already-present") unread.push({
					sessionId: entry.sessionId,
					messageId: batchEndMessageId(entry.batchId)
				});
			} catch (error) {
				this.warn(`store ${storeId}: the end-of-batch message for "${entry.batchId}" could not be re-derived (${error instanceof Error ? error.message : String(error)}); the batch's facts stand and the next activation retries`);
			}
			this.wakeUnclaimedBatchResults(unread);
		};
		const barrier = this.storeRecovery.get(storeId);
		let questionDeliveries = [];
		if (barrier === void 0 || barrier.status !== "recovering") {
			questionDeliveries = await deliverQuestions();
			await deliverBatches();
		} else if (barrier.cancelled !== true) barrier.pendingQuestionDelivery = async () => {
			await deliverQuestions();
			await deliverBatches();
		};
		return {
			unresolvedProposals: await this.reconcileProposals(storeId),
			questionDeliveries,
			questionResumes
		};
	}
	/**
	* The refusal code one resume failure names — read structurally (the stable
	* class name and its `code`) rather than by `instanceof`, because the runtime
	* that raises it and this package can be two modules of one contract in a
	* source-built deployment, and a duplicate class object must not turn a named
	* refusal into an unnamed failure.
	*/
	static resumeRefusalCodeOf(error) {
		if (!(error instanceof Error) || error.name !== "WorkerResumeRefusal") return void 0;
		const code = error.code;
		return typeof code === "string" ? code : void 0;
	}
	/**
	* Record one worker-recovery attempt in the pass's report *and* on the
	* deployment's log (A4 §F.1): a `live` resume is the pass's own success and
	* needs no warn, while a `retry` and a `refused` are exactly what an operator
	* has to see — the first because the run keeps waiting on an owner that is not
	* this process, the second because the run is about to be settled terminal for
	* it. The report is the machine-readable half; this is the one adoption drops.
	*
	* `fact` names what makes the Session one the pass has to reach — an unresolved
	* blocking question (A4 §F.1), or a batch that ended and whose result the run has
	* not been told about (K1 §2, §5) — so a warn says which wait it is about.
	*/
	recordWorkerResume(storeId, run, attempt, into, fact) {
		const subject = `run "${run.runId}" (session "${run.sessionId}")`;
		into.push(attempt.status === "live" ? {
			subject,
			status: "live"
		} : {
			subject,
			status: attempt.status,
			reason: attempt.reason
		});
		if (attempt.status === "retry") this.warn(`store ${storeId}: ${subject} has to be reachable for ${fact}, but its Session is held by another owner (${attempt.reason}); nothing is taken over and the next activation retries`);
		if (attempt.status === "refused") this.warn(`store ${storeId}: ${subject} has to be reachable for ${fact} and its Session could not be brought back under its own identity (${attempt.reason}); the run is settled failed rather than left running with that fact unreported`);
	}
	/**
	* Wake a Session that was brought back with coordination input its own inbox
	* still holds unread (A4 §F.1's wake contract).
	*
	* Why this exists: a delivery is a `steer`, and a retry whose target's fold
	* already holds the identity is answered `already-present` **without steering**
	* — right, because a second copy would be a duplicate, but it also means a
	* message that was durable *before* the crash (spliced and flushed, never
	* claimed) wakes nothing after the restart. The resumed driver stays idle with
	* the question or the answer sitting in its restored inbox, and the wait would
	* only end at the deadline. So the pass looks at the deliveries that came back
	* `already-present`, checks the *live* inbox of the session each one addressed
	* (the public `inbox.nextTurn`/`nextStep` read), and — only when that identity
	* is still pending there — wakes the session with the runtime's own voice: a
	* `plugin`-sourced `notice` (the shape {@link notify} always sends), never a
	* person's message and never the question's or the answer's words.
	*
	* Nothing else is sent: a delivery that was steered in this pass needs no
	* second wake, a session with no pending identity is left alone, and a session
	* that is not live here cannot be woken (that is the `unavailable` case the
	* report already names). A failure inside this step is reported, never
	* propagated: the deliveries themselves were decided.
	*/
	async wakeUnclaimedQuestionMessages(storeId, deliveries) {
		const unread = new Set(deliveries.filter((delivery) => delivery.status === "already-present").map((delivery) => delivery.messageId));
		if (unread.size === 0) return;
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: the sessions holding already-present question messages could not be read back (${error instanceof Error ? error.message : String(error)}); the next activation retries`);
			return;
		}
		const targets = /* @__PURE__ */ new Map();
		for (const message$8 of pendingQuestionMessages(snapshot).messages) if (unread.has(message$8.messageId)) targets.set(message$8.targetSessionId, message$8.messageId);
		for (const [sessionId, messageId] of targets) {
			if (!this.sessionHoldsPendingMessage(sessionId, messageId)) continue;
			this.notify(sessionId, `task-runtime: this session was brought back after a restart with coordination input it has not read (message "${messageId}" is still pending in its inbox); read it and act on it — the framework will not send a second copy`);
		}
	}
	/**
	* Wake a Session that was brought back with an end-of-batch result its own inbox
	* still holds unread — {@link wakeUnclaimedQuestionMessages}' rule applied to the
	* batch messages (K1 §2, §5), and for the same reason.
	*
	* A batch end delivered before a crash is durable in the target's log but may
	* never have been claimed (spliced and flushed, then the process died), so the
	* pass's re-delivery answers `already-present` **without steering** — right,
	* because a second copy would be a duplicate — and a resumed parent with the
	* message sitting in its restored inbox would otherwise stay idle until its
	* deadline. The check is the same live-inbox read, and the wake is the same
	* runtime-voice notice: never a second copy of the message.
	*/
	wakeUnclaimedBatchResults(unread) {
		for (const { sessionId, messageId } of unread) {
			if (!this.sessionHoldsPendingMessage(sessionId, messageId)) continue;
			this.notify(sessionId, `task-runtime: this session was brought back after a restart with the result of a child batch it has not read (message "${messageId}" is still pending in its inbox); read it and act on it — the framework will not send a second copy`);
		}
	}
	/**
	* Whether one live session's own inbox still holds a message identity — the
	* public pending read of a DSH Agent (`inbox.nextTurn` / `inbox.nextStep`),
	* used only to decide whether a session needs waking (A4 §F.1's wake
	* contract). A session this process does not hold is not "pending": it is a
	* target the delivery report already names `unavailable`.
	*/
	sessionHoldsPendingMessage(sessionId, messageId) {
		const inbox = this.agentOrUndefined(sessionId)?.inbox;
		if (inbox === void 0) return false;
		return [...inbox.nextTurn ?? [], ...inbox.nextStep ?? []].some((message$8) => String(message$8.id) === messageId);
	}
	/**
	* The deployment half of the recovery pass's worker resume (A4 §F.1): resolve
	* the Session's graph scope, take the Session over through
	* `AgentRuntime.resumeWorkerAgent` under the run's own identity, and put the
	* live result where every other live session of this process lives.
	*
	* The order after the resume is the promise the contract makes:
	*
	* 1. **The binding.** The Session is bound to its run in this process's one
	*    binding table (`sessions`) and marked as work this process drives
	*    (`startedSessions`), exactly as a spawn's product is — so the run's own
	*    tools (`task_submit_result`, `task_answer`) resolve, and the next recovery
	*    pass reads it as live work rather than as a stranger's.
	* 2. **The gate, before anything can be delivered.** The run's phase and its
	*    question block are applied from the store under the gate's own token rule
	*    ({@link applyResumedSessionGate}) — the same derivation
	*    `initializeStoreGates` performs for every session, moved ahead of the
	*    delivery pass so the first request an answer wakes is already decided
	*    under the facts the store holds.
	* 3. **The managed work the dead process left.** The drain (the same
	*    `drainSession` the settlement paths use, with the now-live agent and the
	*    deployment's jobs service) kills and waits for this session's managed work
	*    within the configured window. An unconfirmed drain refuses the takeover by
	*    name: a resumed worker whose predecessor's jobs nobody could confirm
	*    stopped must not be allowed to run as if nothing of the sort happened.
	*
	* A refusal of the resume itself is named and never worked around: an
	* `ownership-conflict` is the retryable one (another owner holds the Session;
	* this process must not take it over) and everything else means the identity
	* cannot be established, which the caller settles as a terminal state.
	*/
	async resumeAdoptedWorkerSession(request) {
		const sessionId = request.run.sessionId;
		const live = this.agentOrUndefined(sessionId) !== void 0;
		if (!live) {
			let scope;
			try {
				const graph = await this.ctx.graphs.graphForSession(SessionId(sessionId));
				scope = {
					graphStoreId: graph.graphStoreId,
					layoutStoreId: graph.layoutStoreId
				};
			} catch (error) {
				return {
					status: "refused",
					reason: `the graph of session "${sessionId}" could not be resolved (${error instanceof Error ? error.message : String(error)})`
				};
			}
			try {
				await this.ctx.agentRuntime.resumeWorkerAgent({
					sessionId: SessionId(sessionId),
					scope,
					run: {
						storeId: request.storeId,
						taskId: request.run.taskId,
						runId: request.run.runId,
						sessionId: SessionId(sessionId),
						...request.run.agentPreset === void 0 ? {} : { agentPreset: request.run.agentPreset },
						capabilitySnapshot: request.run.capabilitySnapshot
					},
					grant: request.grant,
					...request.permissionPreset === void 0 ? {} : { permissionPreset: request.permissionPreset },
					taskWorker: request.taskWorker
				});
			} catch (error) {
				const code = TaskRuntime.resumeRefusalCodeOf(error);
				if (code === "ownership-conflict") return {
					status: "retry",
					reason: error instanceof Error ? error.message : String(error)
				};
				if (code !== void 0) return {
					status: "refused",
					reason: `${code}: ${error instanceof Error ? error.message : String(error)}`
				};
				return {
					status: "refused",
					reason: error instanceof Error ? error.message : String(error)
				};
			}
		}
		this.sessions.set(sessionId, {
			storeId: request.storeId,
			taskId: request.run.taskId,
			runId: request.run.runId
		});
		this.startedSessions.add(sessionId);
		await this.applyResumedSessionGate(request.storeId, sessionId, request.run.runId);
		if (!live) {
			const drained = await this.drainAdoptedSession(sessionId);
			if (!drained.confirmed) {
				await this.stopAdoptedSession(sessionId);
				return {
					status: "refused",
					reason: `the managed work of session "${sessionId}" could not be confirmed stopped: ${drained.pending.join("; ")}`
				};
			}
		}
		return { status: "live" };
	}
	/**
	* Apply the phase and the question block one resumed session's run implies,
	* from the store, under the gate's own token rule — the token taken *before*
	* the read, so a decision this process made while the read was in flight drops
	* the value instead of being overwritten by it. Same derivation as
	* `initializeStoreGates`, applied per session because a delivered answer can
	* wake this session before that pass runs.
	*/
	async applyResumedSessionGate(storeId, sessionId, runId) {
		const token = this.executionGate.decisionToken(sessionId);
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: the facts of session "${sessionId}" could not be read back after its resume (${error instanceof Error ? error.message : String(error)}); its gate is left as the store-derived pass finds it`);
			return;
		}
		const run = snapshot.runs.find((candidate) => candidate.runId === runId);
		if (run === void 0) return;
		this.gatePhaseFromStore(sessionId, run, storeId, token);
		this.executionGate.applyStoreQuestionsBlocked(sessionId, blockingQuestionsOf(snapshot, runId).length > 0, token);
	}
	/** The drain a resumed Session owes: the session's managed work, with the agent that now owns it. */
	async drainAdoptedSession(sessionId) {
		return await drainSession(this.executionGate, sessionId, {
			timeoutMs: this.config.writeDrainTimeoutMs,
			jobs: this.softService("jobs"),
			agent: this.agentOrUndefined(sessionId)
		});
	}
	/** Let one resumed Session go again — the runtime's own stop path, never a private dispose. */
	async stopAdoptedSession(sessionId) {
		try {
			await this.ctx.agentRuntime.stopAgents([SessionId(sessionId)]);
		} catch (error) {
			this.warn(`session ${sessionId}: the resumed worker could not be stopped again (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	/**
	* Rebuild this process's workspace ownership for one store from the store's
	* own state: the root run's own hold, and — when that run is waiting on
	* children — the batch layer its driver hands to each child in turn. A tree
	* whose runs all reached terminal states releases the claim instead, which is
	* what makes a finished tree leave no marker behind.
	*/
	async rebuildWorkspaceOwnership(storeId) {
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.warn(`store ${storeId}: its snapshot could not be read (${error instanceof Error ? error.message : String(error)}), so its workspace ownership was left as it is`);
			return;
		}
		const rootTask = snapshot.tasks.find((task) => task.parentTaskId === void 0);
		if (rootTask === void 0) return;
		const rootRun = [...snapshot.runs].reverse().find((run) => run.taskId === rootTask.taskId && run.status === "running");
		const workspace = rootRun === void 0 ? void 0 : await this.workspacePathForSession(rootRun.sessionId);
		if (workspace === void 0 || this.workspaces === void 0) return;
		if (rootRun === void 0) {
			await this.releaseStoreWorkspace(storeId);
			return;
		}
		let held = this.workspaces.ownerOf(workspace);
		if (held === void 0) {
			const adoption = await this.workspaces.reconcileAdopt(workspace);
			if (!adoption.adopted) {
				this.warn(`store ${storeId}: the workspace cannot be taken over (${adoption.reason})`);
				return;
			}
			await this.workspaces.claim(workspace, {
				kind: "run",
				storeId,
				taskId: rootTask.taskId,
				runId: rootRun.runId,
				since: now()
			});
			held = this.workspaces.ownerOf(workspace);
		}
		if (held === void 0 || held.kind !== "run" || held.storeId !== storeId || held.runId !== rootRun.runId) {
			this.warn(`store ${storeId}: the workspace ${workspace} is held by ${held === void 0 ? "nobody in this process" : `${held.kind} ${held.storeId}/${held.runId ?? held.batchId ?? ""}`}, not by its root run ${rootRun.runId}; ownership is left as it is`);
			return;
		}
		if (rootRun.executionPhase !== "waiting_children" || rootRun.batchId === void 0) return;
		await this.workspaces.push(workspace, held, {
			kind: "batch",
			storeId,
			taskId: rootTask.taskId,
			batchId: rootRun.batchId,
			since: now()
		});
	}
	/** Release every layer this process holds for one store's workspace, naming any layer that is not the store's. */
	async releaseStoreWorkspace(storeId) {
		if (this.workspaces === void 0) return;
		const sessionId = this.recoverySessionFor(void 0, storeId);
		const workspace = await this.workspacePathForSession(sessionId);
		if (workspace === void 0) return;
		for (;;) {
			const top = this.workspaces.ownerOf(workspace);
			if (top === void 0) return;
			if (top.storeId !== storeId) {
				this.warn(`workspace ${workspace} holds a layer of store ${top.storeId} (${top.kind}) while store ${storeId} is being cancelled; only this process's own layers are released here`);
				return;
			}
			await this.workspaces.release(workspace, top);
		}
	}
	/**
	* The fallback batch-failure seam the orchestration calls when a run's own
	* settlement cannot finish the batch (verification unavailable in a nested
	* submission): every child that never started is blocked, the parent run is
	* failed with the reason, and the batch's driver is aborted so its own loop
	* stops seeing work that no longer exists.
	*
	* Both writes are the orchestration's own (A4-5): {@link blockUnstartedChildren}
	* and {@link settleRunFromRuntime} — the same pair `failBatchFromRuntime` uses —
	* so this file holds no second copy of either record shape. The batch is
	* resolved through the store's accumulation ({@link batchRecordIn}): the id
	* names a pair, not a task.
	*/
	async failBatch(storeId, batchId, reason) {
		const found = await this.batchRecordIn(storeId, batchId);
		if (found === void 0) return;
		this.drivers.get(`${storeId}/${batchId}`)?.controller.abort();
		const env = await this.orchestrateEnv(await this.sessionForStore(storeId), `fail-batch:${storeId}`);
		await blockUnstartedChildren(env, storeId, found.memberTaskIds, reason);
		const parentRun = (await this.ctx.task.snapshotIn(storeId)).runs.find((run) => run.runId === found.run.runId);
		if (parentRun === void 0 || parentRun.status !== "running") return;
		await settleRunFromRuntime(env, storeId, parentRun, "failed", reason);
	}
	/** The session whose viewpoint a store-wide operation (recovery, cancellation) resolves its checkout from. */
	recoverySessionFor(snapshot, storeId) {
		const rootRun = snapshot?.runs.find((run) => run.taskId === snapshot.tasks.find((task) => task.parentTaskId === void 0)?.taskId);
		if (rootRun !== void 0) return rootRun.sessionId;
		for (const [sessionId, binding] of this.sessions) if (binding.storeId === storeId) return sessionId;
		return storeId;
	}
	/** Any session bound to this store, for the seams that only need a viewpoint (never `storeId` if one exists). */
	async sessionForStore(storeId) {
		try {
			return this.recoverySessionFor(await this.ctx.task.snapshotIn(storeId), storeId);
		} catch {
			return storeId;
		}
	}
	/** Reverse lookup: the task run a (worker) session is bound to. */
	async runForSession(sessionId) {
		const found = await this.lookupRun(sessionId);
		if (found === void 0) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`);
		return found;
	}
	/**
	* Whether this deployment admits a run's own `task_decompose`
	* (`Config.allowRuntimeDecomposition`), read-only. The context package's
	* worker projection carries the rule that follows from it; nothing here
	* grants or denies a call — admission still decides every one.
	*/
	allowsRuntimeDecomposition() {
		return this.config.allowRuntimeDecomposition;
	}
	/**
	* The gate phase one bound session's run implies, applied on every rebinding.
	* The gate is a handle on the run's phase and the phase is the store's fact,
	* so a session this process rebound — from its index, from a reopened store,
	* or with a phase that moved under an in-flight call — is gated as what its
	* run is. `undefined` (a record that predates phases) leaves the session
	* ungated, which is the gate's own contract for an unbindable phase, and a
	* session with no run is never gated at all.
	*
	* Two ways a read of that record can be too old to apply, and each has its own
	* guard: the closing set checked below (a decision of this process that the
	* store's write has not caught up with yet), and the `token` its caller took
	* before the read ({@link ExecutionGate.applyStorePhase}, for a read that
	* straddled a decision).
	*
	* - **A read taken inside a window whose decision is in effect but not yet
	*   persisted** — a store this process is closing ({@link cancelGraph}, whose
	*   barrier is raised before it is written): there the record read back is
	*   older than a phase this process already closed, so a rebinding may not
	*   move a phase that session holds. Whether it holds one is the whole
	*   distinction — a session the cancellation never reached has none, and the
	*   store decides for it exactly as it does everywhere else, which is what
	*   keeps the restore path (`waiting_children`, terminal records) working.
	* - **A read that straddled a decision** — the query read the record, a
	*   decision landed, and the value is applied afterwards: `token` is the
	*   gate's decision count taken before that read ({@link initializeStoreGates}
	*   is the caller now — the read door no longer writes the gate), and
	*   {@link ExecutionGate.applyStorePhase} drops the value when it has moved
	*   since. The closing set above cannot see this one — by then the store is
	*   up to date and the store is not being closed any more.
	*/
	gatePhaseFromStore(sessionId, run, storeId, token) {
		if (this.closingStores.has(storeId) && this.executionGate.phaseOf(sessionId) !== void 0) return;
		const phase = this.runGatePhase(run);
		if (phase === void 0) return;
		this.executionGate.applyStorePhase(sessionId, phase, token);
	}
	/**
	* The read door a session's first lookup takes (A2 §E): a read, and only a
	* read. A binding this process holds is resolved against the store; a
	* session this process never held resolves its store from its graph, opens
	* it, and indexes the snapshot so the binding the record implies answers.
	* Nothing else happens here — no recovery pass, no gate write, no spawn —
	* because a query cannot be the thing that recovers a store: recovery runs
	* behind the explicit activation barrier ({@link adoptRoot}), which is also
	* where every session the store knows gets its gate phase
	* ({@link initializeStoreGates}).
	*/
	async lookupRun(sessionId) {
		const binding = this.sessions.get(sessionId);
		if (binding !== void 0) {
			const resolved = await this.resolveBinding(binding);
			if (resolved !== void 0) return resolved;
			this.sessions.delete(sessionId);
		}
		let rootSessionId;
		try {
			rootSessionId = (await this.ctx.graphs.graphForSession(SessionId(sessionId))).rootSessionId;
		} catch {
			return;
		}
		const storeId = rootTaskStoreId(rootSessionId);
		let snapshot;
		try {
			snapshot = await this.ctx.task.openStore(storeId);
			this.reindex(storeId, snapshot);
		} catch {
			return;
		}
		const rebinding = this.sessions.get(sessionId);
		if (rebinding === void 0) return void 0;
		return await this.resolveBinding(rebinding);
	}
	/**
	* The recovery state of one store, as a read sees it (A2 §E): the barrier
	* handle first, and — when no barrier has run for this store in this process
	* — the store's own record, read-only. Work this process drives (a root it
	* activated here, a worker it spawned, a batch whose driver is registered)
	* is live, not recovery's; a still-running run nobody here drives is what
	* `recovery-required` names, unless it predates coordination phases, which
	* is the `needs-recovery` that allows only reading and cancelling. The
	* store's own root run is its session's, not recovery's — the same rule the
	* recovery pass applies — so a root legitimately sitting `active` between
	* its own decisions is not a recovery verdict, and the gate plus the state
	* rules are what refuse a write on it.
	*
	* Never a trigger: this opens no gate, starts no driver and settles no run,
	* so a context query, a diagnostic or the DSH first-request check can show
	* where a store stands without executing anything.
	*/
	async recoveryStatus(storeId) {
		const state = this.storeRecovery.get(storeId);
		if (state !== void 0) {
			if (state.status === "recovering") return { status: "recovering" };
			if (state.status === "failed") return {
				status: "recovery-failed",
				reason: state.reason ?? "the recovery barrier failed"
			};
			return { status: "ready" };
		}
		let snapshot;
		try {
			snapshot = await this.ctx.task.openStore(storeId);
		} catch (error) {
			return {
				status: "not-activated",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		for (const run of snapshot.runs) {
			if (run.status !== "running") continue;
			if (this.startedSessions.has(run.sessionId)) continue;
			if (this.agentOrUndefined(run.sessionId) !== void 0) continue;
			if (run.batchId !== void 0 && this.drivers.has(`${storeId}/${run.batchId}`)) continue;
			if (rootTaskStoreId(run.sessionId) === storeId) continue;
			if (run.executionPhase === void 0) return {
				status: "needs-recovery",
				reason: `run "${run.runId}" predates coordination phases and is not treated as active`
			};
			return {
				status: "recovery-required",
				reason: `run "${run.runId}" (phase "${run.executionPhase}") is in flight from a process that is gone`
			};
		}
		return { status: "ready" };
	}
	/**
	* The recovery door every business execution entry passes before its first
	* side effect (A2 §E): the same condition the barrier establishes, refused
	* by name — `recovering` while the barrier runs, `recovery-failed` with the
	* original reason after one failed, `recovery-required` for work a dead
	* process left, `needs-recovery` for a record that predates phases. The
	* store-nothing refusals never trigger recovery themselves; cancellation,
	* close and the read-only doors are not gated here.
	*
	* The `not-activated` answer proceeds: the legal root entry (an intake)
	* creates the store, and every other caller is refused by the store's own
	* unknown-store error rather than by a recovery verdict.
	*/
	async assertRecoveryReady(storeId, entry) {
		const readiness = await this.recoveryStatus(storeId);
		if (readiness.status === "ready" || readiness.status === "not-activated") return;
		const because = readiness.status === "recovering" ? "its recovery barrier is still running; retry once the graph's activation completes" : readiness.status === "recovery-failed" ? `the last recovery failed: ${readiness.reason}; an explicit activation (adoptRoot) retries it` : readiness.status === "needs-recovery" ? `${readiness.reason}; only reading and cancelling are allowed` : `${readiness.reason}; await the graph's activation or adoptRoot before executing against this store`;
		throw new Error(`task-runtime: ${entry} on store "${storeId}" is refused: the store is ${readiness.status} — ${because}`);
	}
	async resolveBinding(binding) {
		try {
			const [task, run] = await Promise.all([this.ctx.task.taskIn(binding.storeId, binding.taskId), this.ctx.task.runIn(binding.storeId, binding.runId)]);
			return {
				storeId: binding.storeId,
				task,
				run
			};
		} catch {
			return;
		}
	}
	reindex(storeId, snapshot) {
		for (const run of snapshot.runs) this.sessions.set(run.sessionId, {
			storeId,
			taskId: run.taskId,
			runId: run.runId
		});
	}
	/**
	* The checkout one session's runs work in, in the form ownership keys it:
	* the graph env's path, resolved to its real path so two spellings of one
	* directory cannot become two markers ({@link normalizeWorkspacePath}).
	*
	* `undefined` means this deployment cannot name a checkout — no env-builder,
	* no graph, or a path that does not resolve — and ownership is skipped rather
	* than guessed, which is the honest reading of §3.4's `unbound`.
	*/
	async workspacePathForSession(sessionId) {
		const path = await this.envPathForSession(sessionId);
		if (path === void 0) return void 0;
		try {
			return await normalizeWorkspacePath(path);
		} catch (error) {
			this.warn(`workspace ownership is skipped for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
	/**
	* The directory one session's runs work in, for a caller that has to *name* it
	* — the one evaluation that freezes a workspace as its input snapshot has to
	* know which directory to freeze (S4-E §F.2). The answer is
	* {@link envPathForSession}'s: the workspace this process placed the session
	* in, else the session's graph env checkout, and `undefined` when the
	* deployment cannot name either.
	*
	* Read-only on purpose. This door resolves a path; it does not claim the
	* workspace, does not take its ownership, and grants no write — a caller that
	* runs something in the directory still goes through the ordinary entries,
	* which check ownership themselves.
	*/
	async workspacePathFor(sessionId) {
		return this.envPathForSession(sessionId);
	}
	/**
	* Refuse a decomposition whose caller does not hold its own checkout. The
	* holder may be the parent run itself (the ordinary case: a run works in its
	* checkout and hands it down), a batch the runtime holds between children, or
	* an ancestor run of this one — the chain a nested child sits on. Anything
	* else is another writer, and the batch is refused *before* anything is
	* written ({@link WorkspaceBusyError} carries the holder and since when).
	*/
	async assertWorkspaceHeldBy(workspace, storeId, parentTask, parentRunId) {
		if (this.workspaces === void 0) return;
		const top = this.workspaces.ownerOf(workspace);
		if (top === void 0) throw new WorkspaceBusyError(workspace, void 0, void 0, `store ${storeId} does not hold this workspace in this process; the run ${parentRunId} would be writing into a checkout nobody claimed (claim it through the graph entry, or resolve the ownership marker first)`);
		if (top.storeId !== storeId) throw new WorkspaceBusyError(workspace, top, top.since, `it is held by another store (${top.storeId}), not by ${storeId}`);
		if (top.taskId === parentTask.taskId) return;
		let ancestor = parentTask.parentTaskId;
		while (ancestor !== void 0) {
			if (top.taskId === ancestor) return;
			ancestor = await this.ancestorTaskIdFor(storeId, ancestor);
		}
		throw new WorkspaceBusyError(workspace, top, top.since, `it is held by ${top.kind} ${top.taskId ?? top.batchId ?? ""}, which is not run ${parentRunId}'s own run, its batch, or one of its ancestors`);
	}
	/** The parent task id of one task, read from the store; `undefined` when the store cannot answer. */
	async ancestorTaskIdFor(storeId, taskId) {
		try {
			return (await this.ctx.task.taskIn(storeId, taskId)).parentTaskId;
		} catch {
			return;
		}
	}
	/**
	* Take the checkout for one replay run: an unheld workspace is claimed, and a
	* workspace the *caller's own* tree already holds is handed over (a replay
	* without a named workspace writes where its caller writes). Any other holder
	* is a conflict, and the replay refuses before its task is created — which is
	* also how a workspace another side of a comparison still holds refuses the
	* second side (`options.workspace`), by the same rule and the same error.
	*
	* The layer names the replayed task ({@link WorkspaceOwner.taskId}), because
	* the hold is the replay run's own: the §3.4 admission compares a holder by
	* task (`assertWorkspaceHeldBy`), so without it the replay's worker would be
	* refused the decomposition it is entitled to — its own checkout would read as
	* a stranger's. The `runId` stays the lineage label
	* (`replay-of-<championTaskId>`): experiment lineage is not a store run id, and
	* nothing addresses this layer by it.
	*/
	async claimReplayWorkspace(workspace, storeId, callerSessionId, championTaskId, replayTaskId) {
		const registry = this.workspaces;
		if (registry === void 0) throw new Error("task-runtime: the workspace registry is not initialized");
		const owner = {
			kind: "run",
			storeId,
			taskId: replayTaskId,
			runId: `replay-of-${championTaskId}`,
			since: now()
		};
		const top = registry.ownerOf(workspace);
		if (top === void 0) {
			await registry.claim(workspace, owner);
			return registry.ownerOf(workspace) ?? owner;
		}
		const callerRunId = this.sessions.get(callerSessionId)?.runId;
		if (!(callerRunId !== void 0 && top.storeId === storeId && top.runId === callerRunId)) throw new WorkspaceBusyError(workspace, top, top.since, `a replay from session ${callerSessionId} cannot write into a checkout held by ${top.kind} ${top.taskId ?? top.batchId ?? ""}`);
		await registry.push(workspace, top, owner);
		return owner;
	}
	/** Release the replay's own layer, leaving whatever the caller held in place. */
	async releaseReplayWorkspace(workspace, owner) {
		const registry = this.workspaces;
		if (registry === void 0) return;
		const { conflict } = await releaseLayer(registry, workspace, (top) => top.kind === owner.kind && top.runId === owner.runId && top.storeId === owner.storeId);
		if (conflict !== void 0) this.warn(`workspace ${workspace} was expected to hold the replay layer ${owner.runId ?? ""}, but holds ${describeOwner(conflict)}`);
	}
	/**
	* Best-effort owner notification through the live agent (A3 §3.1, DSH's
	* tool-jobs precedent: a `plugin`-sourced `notice`). A session with no live
	* agent — a worker that already left, a headless test context — is skipped,
	* and a failing follow-up never fails the settlement that reports it.
	*/
	notify(sessionId, text$1) {
		const agent = this.agentOrUndefined(sessionId);
		if (agent === void 0 || typeof agent.followup !== "function") return;
		try {
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: text$1
				}],
				source: {
					kind: "plugin",
					plugin: "task-runtime",
					form: "notice",
					summary: boundContextSummary(text$1)
				}
			}));
		} catch (error) {
			this.warn(`could not notify session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/**
	* Send one owner notice through the live Session when its store is ready, and
	* park it on the recovery barrier when one is in flight (A4 §F.1's wake order).
	*
	* A notice is a wake: `followup` opens a turn in an idle Session, and a turn
	* whose first request meets a store that is still `recovering` is refused by
	* the recovery door with nothing to wake the Session again. The notices the
	* barrier's own pass raises are therefore raised here rather than sent: the
	* ready handle sends them in the order they were raised, and a failed or
	* invalidated barrier drops them — a notice is best-effort by contract, and
	* the next explicit activation raises the same one from the record again. With
	* no barrier in flight this is {@link notify}, unchanged.
	*/
	notifyWhenReady(sessionId, text$1) {
		const storeId = this.sessions.get(sessionId)?.storeId;
		const barrier = storeId === void 0 ? void 0 : this.storeRecovery.get(storeId);
		if (barrier !== void 0 && barrier.status === "recovering" && barrier.cancelled !== true) {
			barrier.pendingNotices.push({
				sessionId,
				text: text$1
			});
			return;
		}
		this.notify(sessionId, text$1);
	}
	/**
	* Deliver one ended batch's result to the Session that waited for it (K1 §2),
	* through the same relay A4's question messages use
	* ({@link AgentRuntimeHandle.ensureAgentMessageDelivered}) and under the order
	* {@link notifyWhenReady} established for every wake.
	*
	* The message is *identified* (`m-batchend-<batchId>`), which is what makes
	* this call idempotent and re-entrant: a second call — a retry in this process,
	* or the recovery pass re-deriving the same message from the run's accumulated
	* batches — states the same identity, and the target's own fold decides that it
	* is already present instead of the runtime keeping a ledger. The body is the
	* one the driver handed over, rendered from the store's own facts.
	*
	* The barrier rule is the wake rule: while a store is `recovering`, a turn in
	* one of its Sessions is refused by the recovery door with nothing left to wake
	* it, so the delivery is registered on the barrier and the ready handle makes
	* it once the gates are in place. A failed or invalidated barrier drops the
	* registration, which loses nothing: the facts are the store's, and the next
	* activation (or the recovery slice's pass) derives the same message again.
	*/
	async deliverBatchResult(message$8) {
		const barrier = this.storeRecovery.get(message$8.storeId);
		if (barrier !== void 0 && barrier.status === "recovering" && barrier.cancelled !== true) {
			barrier.pendingBatchResults.push(message$8);
			return "unavailable";
		}
		return await this.deliverBatchResultNow(message$8);
	}
	/**
	* One delivery attempt, reporting rather than throwing: the batch's facts are
	* the store's and the message is the wake that points at them, so a relay that
	* is absent, refuses or has no live Session changes nothing about the batch —
	* it is named once for the operator, and the next activation retries.
	*
	* The run the message addresses is re-read here, and it is the one guard every
	* path shares — the live batch end, a delivery a barrier deferred, the recovery
	* pass and a re-delivery a caller asked for. The message's whole content is "you
	* are active again"; a run that settled while the delivery was on its way (a
	* cancellation or a deadline that arrived first, a verdict somebody else made)
	* must not be woken by it, so a run that is no longer `running` is answered
	* `skipped` with zero side effects (K1 §2: 绝不唤活终态).
	*/
	async deliverBatchResultNow(message$8) {
		let run;
		try {
			run = await this.ctx.task.runIn(message$8.storeId, message$8.runId);
		} catch (error) {
			this.warn(`store ${message$8.storeId}: whether run "${message$8.runId}" is still running could not be read before the end-of-batch message for "${message$8.batchId}" was delivered (${error instanceof Error ? error.message : String(error)}); nothing was delivered and the next activation retries`);
			return "unavailable";
		}
		if (run.status !== "running") return "skipped";
		const relay = this.ctx.agentRuntime;
		if (typeof relay?.ensureAgentMessageDelivered !== "function") {
			this.warn(`store ${message$8.storeId}: batch "${message$8.batchId}" ended with no message relay in this deployment; run "${message$8.runId}" was handed back active and its Session was not told`);
			return "unavailable";
		}
		try {
			const delivery = await relay.ensureAgentMessageDelivered({
				targetSessionId: SessionId(message$8.sessionId),
				senderSessionId: SessionId(message$8.sessionId),
				messageId: message$8.messageId,
				text: message$8.text
			});
			if (delivery.status === "delivered" || delivery.status === "already-present") return delivery.status;
			this.warn(`store ${message$8.storeId}: the end-of-batch message for "${message$8.batchId}" was not delivered to session ${message$8.sessionId} (${delivery.status}); the batch's facts stand and the next activation retries the delivery`);
			return delivery.status === "unavailable" ? "unavailable" : "refused";
		} catch (error) {
			this.warn(`store ${message$8.storeId}: the end-of-batch message for "${message$8.batchId}" could not be delivered (${error instanceof Error ? error.message : String(error)})`);
			return "refused";
		}
	}
	/**
	* Re-deliver one ended batch's result from the store's own facts (K1 §2's
	* message, re-derived): the entry a recovery pass uses for a batch whose end is
	* durable and whose Session was never told — or was told and never recorded it
	* (§F.1's "恢复只补缺失投递", applied to batches). It is also what a recovery
	* pass reconciles with, one owed batch at a time.
	*
	* Idempotent and re-entrant by construction, not by a ledger: the identity is
	* derived from the batch (`batchEndMessageId`), the body from its members'
	* terminal states and evidence, and the target's own fold decides whether the
	* message is already there (`already-present`, nothing delivered twice). A
	* batch no run of the store records is refused by name — a batch id names a
	* pair, and one nothing records cannot be guessed at. A batch whose parent run
	* already settled is `skipped`: the message's content is moot for a run that
	* cannot act on it, and a terminal run is not woken.
	*/
	async redeliverBatchResult(storeId, batchId) {
		const found = await this.batchRecordIn(storeId, batchId);
		if (found === void 0) throw new Error(`task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; there is nothing to re-deliver`);
		const outcomes = await deriveChildOutcomes(this.ctx.task, storeId, found.taskId, found.memberTaskIds);
		return await this.deliverBatchResult({
			storeId,
			runId: found.run.runId,
			batchId,
			sessionId: found.run.sessionId,
			messageId: batchEndMessageId(batchId),
			text: batchEndMessageText(batchId, outcomes)
		});
	}
	/**
	* Kill and confirm one session's managed jobs — the half of the write
	* convergence a cancellation owes its checkout. A deployment with no jobs
	* service, or a session whose agent is gone, has nothing to reconcile, and
	* the drain's own report is what a caller reads as "not confirmed".
	*/
	async reconcileSessionJobs(sessionId) {
		const jobs = this.softService("jobs");
		const agent = this.agentOrUndefined(sessionId);
		if (jobs === void 0 || agent === void 0) return;
		const drained = await drainSession(this.executionGate, sessionId, {
			timeoutMs: this.config.writeDrainTimeoutMs,
			jobs,
			agent
		});
		if (!drained.confirmed) this.warn(`session ${sessionId}: managed work was not confirmed stopped: ${drained.pending.join("; ")}`);
	}
	/**
	* The limits one batch is admitted under (T1, construction guide §4),
	* recorded with the decomposition and never derived from the contract: the
	* contract's own text has no field that can raise a limit, and every value
	* here is resolved from this runtime's configuration at admission time.
	*
	* Only the keys the deployment actually defined are included. `wallTimeMs`
	* and the `auditOnly` trio are one record apart on purpose — a reader has to
	* be able to tell which ceiling would have stopped the run — and an absent
	* `tokens` (this deployment ships no default for it, see {@link BudgetConfig})
	* means there is no token ceiling to record at all.
	*/
	admissionContext() {
		const budget = this.config.budget;
		return {
			maxDepth: this.config.maxDepth,
			maxChildren: this.config.maxChildren,
			...budget.wallTimeMs === void 0 ? {} : { wallTimeMs: budget.wallTimeMs },
			auditOnly: {
				...budget.maxToolCalls === void 0 ? {} : { maxToolCalls: budget.maxToolCalls },
				...budget.tokens === void 0 ? {} : { tokens: budget.tokens },
				...budget.attempts === void 0 ? {} : { attempts: budget.attempts }
			}
		};
	}
	/**
	* The env binding the session's graph runs in, or `undefined` when the
	* deployment mounts no env-builder or the graph cannot be read. Best-effort
	* by contract: every caller decides what an unresolved env means — a
	* verification command without `cwd`, a refused composition of MCP servers, a
	* refused batch when a protected input has to be fixed — and none of them may
	* guess one.
	*/
	async sessionEnv(sessionId) {
		try {
			const envBuilder = this.ctx.get?.("envBuilder") ?? this.ctx.envBuilder;
			if (envBuilder === void 0) return void 0;
			const graph = await this.ctx.graphs.graphForSession(SessionId(sessionId));
			return envBuilder.store.get(graph.envId);
		} catch {
			return;
		}
	}
	/**
	* The session's checkout directory: the one directory a run's commands, a
	* verifier's `cwd`, and a protected acceptance input's bytes are all resolved
	* against. `undefined` means the deployment cannot name it — the caller
	* refuses rather than fixing an identity against a base it does not know
	* ({@link fixProtectedInputs}).
	*
	* A session this process spawned into a named workspace (S4-E) answers with
	* that workspace: the graph env names where the caller's own tree works, which
	* is not where a replay the caller placed elsewhere works. This is the one
	* resolution point, so every path that asks for a session's checkout — the
	* protected inputs of a nested batch, the pre-check a review re-runs, the
	* capability report a worker reads — follows the same directory.
	*/
	async envPathForSession(sessionId) {
		const named = this.sessionWorkspaces.get(sessionId);
		if (named !== void 0) return named;
		return (await this.sessionEnv(sessionId))?.path;
	}
	/**
	* The single refusal text a decomposition batch is rejected at the contract
	* stage with, whichever step produced the reasons (the protected-input fixing
	* or the normalization entry): a caller reads one message shape and one
	* reason-per-bullet list, and the label names the parent the batch was
	* refused for.
	*/
	contractRefusal(parentTaskId, reasons) {
		return /* @__PURE__ */ new Error(`task-runtime: contract rejected decomposition of "${parentTaskId}":\n- ${reasons.join("\n- ")}`);
	}
	/**
	* The service-supplied seam the orchestration runs against (A3 §3.1). Every
	* piece of the protocol that needs the process — the gate, the workspace
	* registry, the notifications, the run watcher, the jobs service, the root
	* budget — enters through here, which is what keeps `orchestrate.ts` free of
	* cordis types and testable as the state machine it is.
	*
	* The checkout is resolved once per construction ({@link workspacePathForSession}):
	* the caller's session is the viewpoint every path in this env shares — the
	* verifier's `cwd`, the protected inputs' base, the skills' discovery root and
	* the workspace ownership key are one directory.
	*
	* @param workspace - the already-normalized workspace this orchestration runs
	* in, when it is not the caller session's own checkout: a replay placed in a
	* directory the caller supplied (§S4-E). It replaces the checkout for the
	* verifier's `cwd`, the MCP env the grant binds against, and the cwd every
	* worker this env spawns starts in; absent, the session's own checkout is used
	* exactly as before.
	*/
	async orchestrateEnv(callerSessionId, actor, workspace) {
		const named = workspace ?? this.sessionWorkspaces.get(callerSessionId);
		const workspacePath = named ?? await this.workspacePathForSession(callerSessionId);
		const binding = this.sessionExecutionBindings.get(callerSessionId);
		return {
			task: this.ctx.task,
			actor,
			...this.config.defaultPreset !== void 0 ? { defaultPreset: this.config.defaultPreset } : {},
			...this.config.runBindingRoot === void 0 ? {} : { runBindingRoot: this.config.runBindingRoot },
			verifyTimeoutMs: this.config.verifyTimeoutMs,
			budget: { ...this.config.budget },
			allowRuntimeDecomposition: this.config.allowRuntimeDecomposition,
			gate: this.executionGate,
			workspaces: this.workspaces,
			...workspacePath === void 0 ? {} : { workspacePath },
			...named === void 0 ? {} : { workerCwd: named },
			...binding?.agentOptions === void 0 ? {} : { agentOptions: binding.agentOptions },
			noProgressRounds: this.config.noProgressRounds,
			writeDrainTimeoutMs: this.config.writeDrainTimeoutMs,
			...this.config.rootBudget === void 0 ? {} : { rootBudget: { ...this.config.rootBudget } },
			precheck: (capabilities, cwd) => this.providerPrecheck(capabilities, { ...cwd === void 0 ? {} : { cwd } }),
			notify: (sessionId, text$1) => {
				this.notify(sessionId, text$1);
			},
			watchRun: (storeId, runId, callback) => this.watchRun(storeId, runId, callback),
			agentFor: (sessionId) => this.agentOrUndefined(sessionId),
			jobs: this.softService("jobs"),
			onRunSettled: (storeId, taskId, runId, status) => {
				this.runSettledFromRuntime(storeId, taskId, runId, status);
			},
			failBatch: (storeId, batchId, reason) => this.failBatch(storeId, batchId, reason),
			deliverBatchResult: (message$8) => this.deliverBatchResult(message$8),
			assertPreset: async (preset) => {
				const presets = this.ctx.get?.("agentPresets") ?? this.ctx.agentPresets;
				if (presets === void 0) return;
				await presets.resolve(preset);
			},
			resolvePermissionSpec: (name) => {
				const presets = this.ctx.get?.("permissionPresets") ?? this.ctx.permissionPresets;
				if (presets === void 0) throw new Error("task-runtime: permissionPresets service is not loaded; cannot rank declared permissions");
				return presets.resolve(name);
			},
			resolveMcpEnv: async () => {
				const env = await this.sessionEnv(callerSessionId);
				if (env === void 0) return void 0;
				const root = named ?? env.path;
				return {
					envRoot: root,
					checkout: (repo) => {
						const component = (env.components ?? []).find((item) => item.repo === repo);
						return component === void 0 ? void 0 : join(root, component.dir);
					}
				};
			},
			spawn: (request) => {
				const parent = this.liveAgent(callerSessionId);
				const sessionWorkspace = request.cwd ?? named;
				if (sessionWorkspace !== void 0) this.sessionWorkspaces.set(request.sessionId, sessionWorkspace);
				if (request.agentOptions !== void 0) this.sessionExecutionBindings.set(request.sessionId, { agentOptions: request.agentOptions });
				return this.ctx.agentRuntime.spawn(parent, {
					sessionId: SessionId(request.sessionId),
					name: request.name,
					...request.taskWorker === void 0 ? {} : { taskWorker: request.taskWorker },
					...request.agentPreset !== void 0 ? { agentPreset: request.agentPreset } : {},
					...request.permissionPreset !== void 0 ? { permissionPreset: request.permissionPreset } : {},
					...request.cwd !== void 0 ? { cwd: request.cwd } : {},
					...request.agentOptions !== void 0 ? { agentOptions: request.agentOptions } : {},
					...request.grant !== void 0 ? { grant: request.grant } : {},
					...request.signal !== void 0 ? { signal: request.signal } : {}
				});
			},
			resumeWorkerSession: (request) => this.resumeAdoptedWorkerSession(request),
			verifyRun: async (storeId, runId, options = {}) => {
				const verifier = this.runVerifier();
				if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new VerifierUnavailableError(`task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`);
				const cwd = named ?? await this.envPathForSession(callerSessionId);
				return verifier.verifyRun(storeId, runId, {
					...cwd === void 0 ? {} : { cwd },
					...options
				});
			},
			readLogTail: async (logRef) => this.runVerifier()?.logTail?.(logRef),
			observeSession: async (sessionId) => this.observeSession(sessionId),
			onRunBound: (sessionId, binding$1) => {
				this.sessions.set(sessionId, binding$1);
				this.startedSessions.add(sessionId);
			}
		};
	}
	/**
	* Observe one run's terminal transition (A3 §3.1) over the task service's own
	* `task/change` event: subscribe first, then read the current status, so a run
	* that settled between the caller's read and this subscription is reported
	* rather than missed. The returned function unsubscribes.
	*
	* A deployment with no event bus (a minimal context) cannot promise the
	* observer anything, and the returned no-op says so by leaving the caller's
	* own timeout in charge.
	*/
	watchRun(storeId, runId, callback) {
		const listeners = [];
		const notifyFrom = async (snapshot) => {
			const run = snapshot.runs.find((candidate) => candidate.runId === runId);
			if (run === void 0 || run.status === "running") return;
			callback(run.status);
		};
		try {
			const off = this.ctx.on("task/change", (snapshot) => {
				if (snapshot.id !== storeId) return;
				notifyFrom(snapshot);
			});
			if (typeof off === "function") listeners.push(off);
		} catch (error) {
			this.warn(`cannot subscribe to task/change for store ${storeId}: ${error instanceof Error ? error.message : String(error)}`);
		}
		(async () => {
			try {
				await notifyFrom(await this.ctx.task.snapshotIn(storeId));
			} catch {}
		})();
		return () => {
			for (const off of listeners) off();
		};
	}
	/** The session this process binds to one run, or `undefined` when the run was never bound here. */
	sessionBoundInProcess(storeId, runId) {
		for (const [sessionId, binding] of this.sessions) if (binding.storeId === storeId && binding.runId === runId) return sessionId;
	}
	/** Release the workspace layer one settled run held, never popping a stranger's layer. */
	async releaseRunWorkspaceLayer(storeId, runId, sessionId) {
		const workspace = await this.workspacePathForSession(sessionId);
		if (workspace === void 0 || this.workspaces === void 0) return;
		await releaseLayer(this.workspaces, workspace, (top) => top.kind === "run" && top.storeId === storeId && top.runId === runId);
	}
	/**
	* One best-effort read of a run's session for the review record's dimensions
	* and effort metrics (§2.7.3): the session's token projection plus one scan of
	* its log. Every source is optional — a deployment that mounts no
	* `sessionProjections`/`sessionQuery`, or a session that is no longer live,
	* yields `undefined` and the record omits those fields rather than filling
	* them with zeros.
	*
	* The log comes from `sessionQuery.readSession`, not `listEvents`: the
	* lightweight records carry only the event type, while tool names, failure
	* flags, `approval/asked` call ids and skill arguments all live in the event
	* data. One read feeds every counter below.
	*
	* Human interventions count once per interaction: `approval/asked` events,
	* plus human-tool calls whose call id no approval event already covers —
	* `hitl_approve` asks through `ctx.approval`, so counting its tool call too
	* would double that interaction. `hitl_ask` and `ask_user_question` ask
	* through `ctx.userQuestions`, which writes no session event, so their tool
	* call is the only trace.
	*/
	async observeSession(sessionId) {
		const tokens = this.sessionTokens(sessionId);
		const events = await this.sessionEvents(sessionId);
		if (tokens === void 0 && events === void 0) return void 0;
		const calls = /* @__PURE__ */ new Map();
		const humanCallIds = [];
		const approvalCallIds = /* @__PURE__ */ new Set();
		const skillCalls = [];
		let failures = 0;
		let approvals = 0;
		let compactions = 0;
		for (const event of events ?? []) if (event.type === "tool/call") {
			const name = event.data.name;
			if (typeof name !== "string") continue;
			calls.set(name, (calls.get(name) ?? 0) + 1);
			if (HUMAN_TOOLS.has(name)) humanCallIds.push(String(event.data.callId));
			if (name === "skill") {
				const skill = skillNameFrom(event.data.arguments);
				if (skill !== void 0) skillCalls.push(skill);
			}
		} else if (event.type === "tool/result") {
			if (toolResultFailed(event.data)) failures += 1;
		} else if (event.type === "approval/asked") {
			approvals += 1;
			if (typeof event.data.callId === "string") approvalCallIds.add(event.data.callId);
		} else if (event.type === "compaction/start") compactions += 1;
		const tools = events === void 0 ? void 0 : {
			calls: [...calls].map(([name, count]) => ({
				name,
				count
			})).sort((left, right) => left.name.localeCompare(right.name)),
			failures
		};
		return {
			...tokens === void 0 ? {} : { tokens },
			...tools === void 0 ? {} : { tools },
			...events === void 0 ? {} : { skillCalls },
			...events === void 0 ? {} : { humanInterventions: approvals + humanCallIds.filter((id) => !approvalCallIds.has(id)).length },
			...events === void 0 ? {} : { compactions }
		};
	}
	/** The session's folded `tokenUsage` buckets, when both the session and the projection registry are reachable. */
	sessionTokens(sessionId) {
		const sessions = this.softService("sessions");
		const projections = this.softService("sessionProjections");
		if (sessions === void 0 || projections === void 0) return void 0;
		try {
			const session = sessions.get(SessionId(sessionId));
			if (session === void 0) return void 0;
			return tokenUsageOf(projections.snapshot(session, ["tokenUsage"]).values.tokenUsage);
		} catch {
			return;
		}
	}
	/** One replay-validated raw log read; an absent reader or a load failure yields `undefined`. */
	async sessionEvents(sessionId) {
		const query = this.softService("sessionQuery");
		if (query === void 0 || typeof query.readSession !== "function") return void 0;
		try {
			return (await query.readSession(SessionId(sessionId))).events;
		} catch {
			return;
		}
	}
	/**
	* Resolve an optional service by name, the same soft pattern this module
	* already uses for the verifier and the agent registry: the service may be
	* absent in test contexts and in deployments that mount a smaller bundle.
	*/
	softService(name) {
		return optionalService(this.ctx, name);
	}
	/** The verifier service is an optional plugin; resolve it softly, never import the package. */
	runVerifier() {
		return this.ctx.get?.("verifier") ?? this.ctx.verifier;
	}
	/**
	* The registered verifier vocabulary one provider pre-check judges execution
	* sidecars against — `registeredVerifierIds` in `./provider-precheck.ts`, the
	* one implementation every provider check shares, with the reasoning for
	* `ready()`-first and for the fail-closed `undefined` documented there.
	*/
	async registeredVerifierIds() {
		return registeredVerifierIds(this.ctx);
	}
	/**
	* The provider pre-check (S1-C item 1) over the given capability rows, run
	* against the effective table unless `table` replaces it (the replay overlay).
	* Read-only: it discovers skill directories and reads them, writes nothing,
	* and returns every refusal as a verdict rather than throwing.
	*/
	async providerPrecheck(capabilities, view, table = this.config.capabilities) {
		const verifierRefs = await this.registeredVerifierIds();
		const commitLedger = this.softService("evolution");
		return precheckProviders({
			capabilities,
			table,
			view,
			...verifierRefs === void 0 ? {} : { verifierRefs },
			...commitLedger === void 0 ? {} : { commitLedger }
		});
	}
	/**
	* The provider verdicts for the capability rows in play, discovered from one
	* session's own viewpoint — the read-only entry `capability_list` renders
	* (guide §2.3 item 1: the model sees the pre-check's conclusion before it
	* dispatches, not only after admission refused its batch). Nothing is thrown
	* for an unusable provider: the verdict says what is wrong with it, and the
	* caller renders that.
	*
	* `capabilities` names the rows to check; omitting it checks every row of the
	* effective table. A caller that wants the verdicts a *batch* resolved
	* against should pass its matched rows — the revision then describes exactly
	* what admission judged. Two things this recompute cannot reproduce, which is
	* why admission carries its own result with the batch (S1-C item 4): the
	* replay overlay's replaced table, and the bytes as they were at admission.
	*/
	async capabilityProviderReport(sessionId, capabilities) {
		const envPath = await this.envPathForSession(sessionId);
		return this.providerPrecheck(capabilities ?? Object.keys(this.config.capabilities), { ...envPath === void 0 ? {} : { cwd: envPath } });
	}
	/**
	* Re-check the content a run's binding recorded against the bytes its snapshot
	* holds now (S1-C item 4) — the read a historical view (`task_read`) and a
	* re-entry (`adoptRoot` adopting an existing root run) both perform before
	* trusting the record.
	*
	* `undefined` means the record names no snapshot: a run that loaded no content
	* has nothing to re-read, which is not the same as content that failed to
	* re-read. A caller that gets a report must look at its `defects`: content
	* that is not readable as bound is reported by name and is never substituted
	* with whatever the production path holds now.
	*/
	async readRunBinding(binding) {
		return readRunBinding(binding);
	}
	/**
	* verifierRef validation at creation/decomposition time, never spawn time
	* (KISS §4.1 `verifier_ref`): every declared ref must name a registered
	* verifier, or the whole batch is rejected before anything is persisted and
	* the error lists the registered ids. The listing is read through the one
	* helper every provider check shares (`registeredVerifierIds`), which readies
	* the registry first — a service that has been constructed but not readied
	* reports an empty list, and reading that as "nothing is registered" would
	* refuse a healthy deployment's batches. A deployment whose verifier service is
	* absent or cannot list its registry cannot make that promise either, so a
	* declared ref fails loudly there instead of passing through unchecked.
	*/
	async assertKnownVerifierRefs(declared, what) {
		const refs = declared.filter((item) => item.criterion.verifierRef !== void 0);
		if (refs.length === 0) return;
		const registered = await this.registeredVerifierIds();
		if (registered === void 0) throw new VerifierUnavailableError(`task-runtime: cannot validate verifierRef on ${what}: the verifier service is not loaded or cannot list its registry`);
		const unknown = refs.filter((item) => !registered.includes(item.criterion.verifierRef));
		if (unknown.length === 0) return;
		const detail = unknown.map((item) => `child ${item.childIndex} criterion "${item.criterion.criterionId}" references unknown verifier "${item.criterion.verifierRef}"`).join("; ");
		throw new Error(`task-runtime: admission rejected ${what}: ${detail}; registered verifiers: ${registered.join(", ")}`);
	}
	/** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
	liveAgent(sessionId) {
		const agent = this.agentOrUndefined(sessionId);
		if (agent === void 0) throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`);
		return agent;
	}
	/**
	* The live agent behind one session, or `undefined` — the non-throwing half of
	* {@link liveAgent}, for the seams where an absent agent is a legitimate state
	* (a notification nobody can receive, a jobs call with no owner) rather than a
	* refusal.
	*/
	agentOrUndefined(sessionId) {
		const registry = this.ctx.get?.("agents") ?? this.ctx.agents;
		if (registry === void 0) return void 0;
		try {
			return registry.get(sessionId);
		} catch {
			return;
		}
	}
};
var src_default = TaskRuntime;

//#endregion
export { COORDINATION_ALLOWED, DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_GENERATED_TASK_REVIEW, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, DEFAULT_WRITE_DRAIN_TIMEOUT_MS, ExecutionGate, MCP_SERVER_REGISTRY, PROPOSAL_REQUEST_KEY_PREFIX, RUN_BINDING_SKILLS_DIR, RunWatcherUnavailableError, SKILL_SIDECAR_FILE, TOOL_LABELS, TaskRuntime, VerifierUnavailableError, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKSPACE_OWNERS_DIR, WorkspaceBusyError, WorkspaceRegistry, answerMessageIdOf, answerParentQuestion, applyStoreQuestionBlocking, askParentQuestion, assertRootBudgetConfig, batchEndMessageId, batchEndMessageText, bindRunProviders, blockUnstartedChildren, buildHandoff, capabilityToolQuery, checkBatchAdmission, checkDecomposition, checkObligationCoverage, checkRunStart, contractDefects, countSubtreeFacts, decompositionIdentity, src_default as default, defaultRunBindingRoot, deriveChildOutcomes, driveBatch, escalationHint, executionProviders, findRepoRoot, fixCriteriaProtectedInputs, fixProtectedInputs, fixSpecProtectedInputs, hasRootLimits, independentAcceptanceDefects, isOpenProposal, loadObligationTemplates, loadSkillSidecar, manifestMcpServers, normalizeDecomposition, normalizeRootContract, normalizeWorkspacePath, openProposalOf, optionalService, owedBatchResults, parseCallArguments, parseObligationTemplates, pendingCoordinationOf, pendingQuestionMessages, precheckProviders, precheckReplacedCapabilityRow, proposalRequestKey, protectedInputDefects, providerContentIdentities, providerDefectLines, providerRefusals, questionMessageIdOf, readProcessStartTime, readRunBinding, readVerifiedFile, reconcileQuestionDeliveries, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveRootBudget, resolveToolLabels, resumeAdoptedWorker, reviewContextDelta, reviewContextOf, rootIndependenceDefects, rootProposalRequestKey, runDeadlineMs, runReplayTask, serializeSkillSidecar, settleRunFromRuntime, settleSubmittedRun, sidecarWithSkillMd, skillContentDigest, skillContractDigest, skillSearchRoots, skillValidationContext, unlistableVerifierRefusal, validateSkillProvider, verifierIdentitiesOf, walkVerified, workerBaseline };