import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { RootTaskSpec, SKILL_SIDECAR_FILE, SUPPORTED_SKILL_RESOURCE_DIRS, TASK_CONTRACT_VERSION, canonicalize, contractDigest, decompositionDigest, reaches, rootTaskStoreId, sha256Hex, skillContentDigest, skillContractDefects, skillContractDigest } from "@dangosys/dsh-singularity-task";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { findSkillFileIn, parseSkillFile, skillRootsFor } from "@dangosys/dsh-singularity-agent-runtime";
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
* | session-history   | `session-query/tool-session-query` (`index.ts:109,96,86`)           |
* | ask-user          | `interaction/tool-ask-user` (`index.ts:21`)                         |
* | web               | `web/tool-web` (`fetch.ts:459`, `search.ts:326`)                    |
* | todo              | `todo/tool-todo` (`index.ts:147`)                                   |
* | goal              | `goal/tool-goal` (`index.ts:195,207,234`)                           |
* | subagent          | `subagent/tool-subagent` (`index.ts:380`), `.../tool-subagent-control` (`index.ts:29,77`, `list-agents.ts:93`) |
*
* Paths are relative to `thirdparty/deepseek-harness/packages/`.
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
	"session-history": [
		"session_event_read",
		"session_event_trace",
		"session_trace"
	],
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
* cites the prompt line that needs it (`handoff.ts:renderWorkerPrompt`, plus
* the shell tool's own guidance for `jobs`):
*
* - `filesystem` — "Do the work" / "Keep changes scoped to this task" (`:135-137`).
* - `bash` — "Where a criterion lists a command, make that command exit 0 in the checkout" (`:136`).
* - `jobs` — that same command is often long-running, and `bash`'s own description
*   tells the model to collect background output with `job_output`/`job_kill`.
* - `search` — locate the code the work touches.
* - `skill` — without the loader the granted skills are unreachable, and
*   `tool-skill` only injects the catalog when its tool is visible.
* - `session-history` — "Read it exactly with `session_event_read` … or `session_trace`" (`:119`).
* - `ask-user` — "Need a human decision? Ask with `ask_user_question`" (`:137`).
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
	"session-history",
	"ask-user"
];
/**
* Baseline tool names that are not a capability label: the task machinery the
* worker prompt calls. They are exactly the Layer-0 universal control tools the
* frozen material fixes for every agent (`细化想法4.md:724-738`: `task_read`,
* `task_decompose`, `task_status`, and the verifier tool this deployment names
* `task_verify`) — L0 is the "every node, whatever it works on" layer, so a
* worker keeps it whatever its capabilities declare.
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
* - `task_decompose` — "Call `task_decompose` instead, with a `reason` and the child task list" (`handoff.ts:87`),
*   and for a `leaf` worker whose deployment runs with `Config.allowRuntimeDecomposition` on,
*   the runtime-split rule (`handoff.ts:127`) that opens the same tool to it.
* - `task_read` — "re-read your own contract and run with `task_read`" (`handoff.ts:140`).
* - `task_status` — the same line: the whole tree with `task_status` (`handoff.ts:140`).
* - `task_verify` — "Before you finish, `task_verify` re-runs the verifier as a self-check" (`handoff.ts:141`).
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
	"task_decompose",
	"task_verify",
	"capability_list"
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
function message$4(error) {
	return error instanceof Error ? error.message : String(error);
}
function isPlainObject$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** Non-blank text: the one check every string field shares. */
function nonBlank$1(value) {
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
	return value.every((item) => nonBlank$1(item)) ? [...value] : [];
}
/**
* The label one criterion is reported under: the declared id when it has one,
* its position otherwise — the vocabulary `normalize.ts` names criteria with,
* so a caller reading a refusal sees one numbering, not two.
*/
function criterionLabel(childLabel, criterion, index) {
	return `${childLabel} criterion ${nonBlank$1(criterion.criterionId) ? JSON.stringify(criterion.criterionId) : index + 1}`;
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
			reasons.push(`${label} protectedInputs path ${JSON.stringify(path)} cannot be read: ${message$4(error)}`);
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
			if (!isPlainObject$1(entry)) {
				reasons.push(`${at} must be an object with only path and sha256`);
				return;
			}
			for (const key of Object.keys(entry)) if (key !== "path" && key !== "sha256") reasons.push(`${at} declares unknown field ${JSON.stringify(key)}`);
			if (!nonBlank$1(entry.path)) reasons.push(`${at} path must be a non-empty string`);
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
		const label = `child ${index} ("${child.taskId}")`;
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
				from: children[dependency].taskId,
				to: child.taskId
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
function message$3(error) {
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
		defects.push(defect$1("content-unsupported", `${relative$1} cannot be read as a real file: ${message$3(error)}`));
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
		scanned.defects.push(defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message$3(error)}`));
		return scanned;
	}
	for (const entry of entries) {
		const name = entry.name;
		const at = join(directory, name);
		let info;
		try {
			info = await lstat(at);
		} catch (error) {
			scanned.defects.push(defect$1("content-unsupported", `${name} cannot be read: ${message$3(error)}`));
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
					scanned.defects.push(defect$1("skill-file-invalid", message$3(error)));
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
				scanned.defects.push(defect$1("content-unsupported", `${name}/ cannot be read: ${message$3(error)}`));
				continue;
			}
			for (const child of children) {
				const relative$1 = `${name}/${child.name}`;
				let childInfo;
				try {
					childInfo = await lstat(join(at, child.name));
				} catch (error) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} cannot be read: ${message$3(error)}`));
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
			defects: [defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message$3(error)}`)]
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
		defects.push(defect$1("content-unsupported", `${SKILL_SIDECAR_FILE} cannot be read as a real file: ${message$3(error)}`));
	}
	if (sidecarBytes !== void 0) if (!isText(sidecarBytes)) defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not UTF-8 text`));
	else {
		let declared;
		try {
			declared = JSON.parse(sidecarBytes.toString("utf8"));
		} catch (error) {
			defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not readable JSON: ${message$3(error)}`));
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
/** The search-failure refusal: the skill name and the roots, which no phase-1 validator can know. */
function undiscovered(name, roots) {
	return {
		valid: false,
		name,
		defects: [defect("skill-missing", `no SKILL.md for skill "${name}" is reachable from the worker's discovery roots; searched ${roots.join(", ")}`)]
	};
}
/** The one provider identity a revision can cite: a validated sidecar, or `null` for a skill that declares none. */
function providerIdentity(verdict) {
	return {
		name: verdict.name,
		contractDigest: verdict.contractDigest
	};
}
/**
* Check every skill every listed capability declares, from one discovery
* viewpoint.
*
* The rules, in the order they are applied per skill: it must be discoverable
* from the view's roots; the directory it resolves to must pass
* {@link validateSkillProvider} against the table and the verifier vocabulary.
* An execution sidecar is refused when the vocabulary is unknown
* (`verifierRefs` absent) — the one case the phase-1 validator cannot judge,
* because it would read an empty list as "nothing is registered".
*
* Nothing is written and nothing is thrown: every refusal is a verdict, and
* {@link providerRefusals} turns the refusals into the lines a caller reports
* before it refuses the whole batch.
*/
async function precheckProviders(request) {
	const roots = await skillSearchRoots(request.view);
	const verifierRefs = request.verifierRefs;
	const context = skillValidationContext(request.table, verifierRefs ?? []);
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
	const providers = capabilities.flatMap((row) => row.skills).flatMap((verdict) => {
		if (!verdict.valid) return [];
		return [verdict.role === "guidance" ? {
			name: verdict.name,
			contractDigest: null
		} : providerIdentity(verdict)];
	}).filter((identity, index, all) => all.findIndex((entry) => entry.name === identity.name) === index).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
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
		...request.verifierRefs === void 0 ? {} : { verifierRefs: request.verifierRefs }
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
function message$2(error) {
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
			throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message$2(error)}`);
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
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message$2(error)}`);
	}
	let declared;
	try {
		declared = JSON.parse(sidecarBytes.toString("utf8"));
	} catch (error) {
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${SKILL_SIDECAR_FILE} is not readable JSON: ${message$2(error)}`);
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
		throw new Error(`run "${request.runId}" cannot bind content: ${runDirectory} already exists (${message$2(error)}); a run materializes once`);
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
		rootDefects.push(`${root} cannot be read: ${message$2(error)}; the content this run was bound to is not available`);
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
/** The first 12 hex of a digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest) {
	return digest.slice(0, 12);
}
/**
* The "chosen implementation" summary of one run — the section a worker's
* contract block, its spawn prompt and `task_read` all render, from this one
* function and one record, so the three views cannot describe different runs.
*
* What it carries: every capability the run matched, the skill selected for it
* (name, role, purpose, short content digest and — where the skill declares one
* — the contract digest), the granted MCP servers, the snapshot the run is bound
* to, and what the binding does *not* cover. What it deliberately leaves out: the
* skill text. A worker reads the body on demand with the `skill` tool; a summary
* is identity and purpose.
*
* `read` is the re-check result when the caller re-read the snapshot. A caller
* that has not read it (the spawn's own render, before the worker exists) omits
* it, and then no readability claim is made in either direction. When it is
* given and reports defects, they are rendered under a named refusal so a reader
* is never told to trust content that is not there.
*/
function renderRunBinding(binding, read) {
	if (binding === void 0) return "";
	const lines = [];
	for (const capability of binding.capabilities) {
		const selected = binding.skills.filter((skill) => skill.capabilities.includes(capability));
		if (selected.length === 0) {
			lines.push(`- capability \`${capability}\`: no provider skill — the capability's tools are granted without one`);
			continue;
		}
		for (const skill of selected) {
			const contract = skill.contractDigest === null ? "" : `, contract ${shortDigest(skill.contractDigest)}`;
			const gaps = skill.uncovered.length === 0 ? "" : ` · not covered by this binding: ${skill.uncovered.join(", ")}`;
			lines.push(`- capability \`${capability}\` → skill \`${skill.name}\` [${skill.role}] — ${skill.description} (content ${shortDigest(skill.contentDigest)}${contract})${gaps}`);
		}
	}
	if (binding.mcpServers.length > 0) lines.push(`- MCP servers mounted for this run: ${binding.mcpServers.map((server) => `\`${server.serverName}\`${server.templateDigest === null ? "" : ` (template ${shortDigest(server.templateDigest)})`}`).join(", ")}`);
	if (lines.length === 0) return "";
	const header = [
		"## Implementation chosen for this run",
		"",
		`- registry revision: ${shortDigest(binding.registryRevision)}`,
		...lines,
		...binding.snapshotRoot === void 0 ? ["- a skill named here is read with the `skill` tool when you need its body; this run bound no content snapshot, so the revision and digests above are what it resolved against"] : [`- bound content snapshot: ${binding.snapshotRoot}`, "- a skill named here is read with the `skill` tool when you need its body; the revision, digests and snapshot path above are what this run is bound to"]
	];
	if (read !== void 0 && read.defects.length > 0) header.push("", "Bound content is not readable: the snapshot no longer matches this run's record, and the production skill path is not a substitute for it.", ...read.defects.map((defect$2) => `- ${defect$2}`));
	return header.join("\n");
}

//#endregion
//#region src/contract.ts
/**
* Opening marker of the block. Stable on purpose: it is what tells a reader —
* human or test — that this text is the contract, and it lets a future
* re-render find the copy already on the surface.
*/
const WORKER_CONTRACT_OPEN = "<worker-contract";
/** Closing marker, and the URL-safe suffix a search for the block's end uses. */
const WORKER_CONTRACT_CLOSE = "</worker-contract>";
/**
* The protected acceptance inputs cell of one criterion row — the paths the
* worker must not modify, or `—` when the criterion declares none.
*
* One helper for both tables (`criteriaTable` here and the spawn prompt's own
* copy in `./handoff.ts`) because the two render the same contract and must
* agree byte-for-byte: a criterion that declares nothing is marked as such
* rather than left blank, and the paths are joined in declaration order, never
* sorted or deduplicated — what the caller declared is what the worker reads.
* Only paths are rendered: the fixed digest is the verifier's business, and a
* hex string in a prompt would be noise the worker cannot act on.
*/
function protectedInputsCell(criterion) {
	const refs = criterion.protectedInputs ?? [];
	return refs.length === 0 ? "—" : refs.map((ref) => ref.path).join(", ");
}
/** The criteria table, in the same shape the spawn prompt renders: what, how judged, the command, and what must not change. */
function criteriaTable(criteria) {
	return [
		"| criterion | mode | mandatory | description | command | protected inputs |",
		"| --- | --- | --- | --- | --- | --- |",
		...criteria.map((criterion) => `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? "yes" : "no"} | ${criterion.description} | ${criterion.command ?? "—"} | ${protectedInputsCell(criterion)} |`)
	];
}
/** One handoff list: `(none)` for an empty one, the items as a nested list otherwise. */
function field(title, items) {
	if (items.length === 0) return [`- ${title}: (none)`];
	return [`- ${title}:`, ...items.map((item) => `  - ${item}`)];
}
/**
* Render one task's contract block.
* @param task - the child task as the store holds it at delegation.
* @param handoff - the envelope the parent passed to this child.
* @param binding - what this run was bound to and loaded (S1-C item 4): the
*   providers chosen for it, rendered as the "chosen implementation" section
*   from the same function and record `task_read` renders, so the two views
*   cannot describe different runs. Absent on a run that recorded no binding,
*   and then nothing is added to the block.
* @returns the marked block, ending in the one line that says where the
*   authority lives, so a model reading it never has to guess whether a
*   compacted spawn prompt or this block is the current contract.
*/
function renderWorkerContract(task, handoff, binding) {
	const summary = renderRunBinding(binding);
	return [
		`${WORKER_CONTRACT_OPEN} task="${task.taskId}" decomposition="${task.decompositionStatus}">`,
		"",
		`# Delegated task ${task.taskId}`,
		"",
		task.objective,
		"",
		"## Acceptance criteria",
		"",
		...criteriaTable(task.acceptanceCriteria),
		...summary.length === 0 ? [] : ["", summary],
		"",
		"## Handoff",
		"",
		`- Parent objective: ${handoff.parentObjective}`,
		`- Reason for delegation: ${handoff.reasonForDelegation}`,
		...field("Constraints", handoff.constraints),
		...field("Decisions already made", handoff.decisions),
		...field("Assumptions", handoff.assumptions),
		...field("Open questions", handoff.openQuestions),
		"",
		WORKER_CONTRACT_CLOSE,
		"",
		"This block is the authoritative copy of your contract and is re-sent with every request; `task_read` reads the same store."
	].join("\n");
}

//#endregion
//#region src/handoff.ts
/** Envelope passed from a parent run to the child it delegates to (RFC §18). */
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
function listSection(title, items, empty) {
	if (items.length === 0) return `## ${title}\n\n${empty}`;
	return `## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`;
}
/**
* Render the worker prompt for a delegated child task. Compact on purpose:
* objective, the acceptance criteria table (with verifier commands and the
* protected input paths the worker must not modify), the implementation chosen
* for this run ({@link WorkerPromptOptions.binding}), the handoff envelope, the
* pointer to the delegating session, the decomposable reminder when the parent
* asked for a further split, the runtime-split rule when the deployment admits
* one ({@link WorkerPromptOptions}), and the rules — a few thousand tokens at
* most.
*/
function renderWorkerPrompt(handoff, childTask, options) {
	const header = [
		`# Delegated task ${childTask.taskId}`,
		"",
		childTask.objective,
		"",
		"## Acceptance criteria",
		"",
		"| criterion | mode | mandatory | description | command | protected inputs |",
		"| --- | --- | --- | --- | --- | --- |",
		...childTask.acceptanceCriteria.map((criterion) => `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? "yes" : "no"} | ${criterion.description} | ${criterion.command ?? "—"} | ${protectedInputsCell(criterion)} |`)
	].join("\n");
	const decomposition = [
		"## This task is decomposable",
		"",
		"- Do not carry the work to completion yourself: this task was admitted as decomposable.",
		"- Call `task_decompose` instead, with a `reason` and the child task list; every child needs an acceptance criterion a verifier can judge on its own.",
		"- Decompose only when RFC §36 atomicity holds — independently verifiable acceptance dimensions, clear artifact boundaries, capabilities that match or gaps you can handle; otherwise do the work here.",
		"- Once you decompose, the nested verification settles this task; you still never declare completion yourself."
	].join("\n");
	const envelope = [
		"## Handoff",
		"",
		`- Parent objective: ${handoff.parentObjective}`,
		`- Reason for delegation: ${handoff.reasonForDelegation}`,
		"",
		listSection("Constraints", handoff.constraints, "(none)"),
		"",
		listSection("Decisions already made", handoff.decisions, "(none)"),
		"",
		listSection("Relevant artifacts", handoff.relevantArtifacts.map((artifact) => `${artifact.kind} ${artifact.uri}`), "(none)"),
		"",
		listSection("Relevant evidence", handoff.relevantEvidence, "(none)"),
		"",
		listSection("Assumptions", handoff.assumptions, "(none)"),
		"",
		listSection("Open questions", handoff.openQuestions, "(none)")
	].join("\n");
	const parentSession = [
		"## Parent session",
		"",
		`- The session that delegated this task is \`${handoff.parentSessionRef}\`.`,
		"- Need more of that context? Read it exactly with `session_event_read` (one `seq`) or `session_trace` (lineage and neighborhood).",
		"- Full-text search is disabled in this deployment, so read parent events by sequence."
	].join("\n");
	const summary = renderRunBinding(options.binding);
	const rules = [
		"## Rules",
		"",
		"- Do the work; never declare completion yourself — an external verifier checks every mandatory criterion.",
		"- Where a criterion lists a command, make that command exit 0 in the checkout.",
		"- A criterion's declared protected inputs must not be modified: the verifier re-checks their identity before judging, and a changed or missing input fails the criterion, naming the path.",
		"- Keep changes scoped to this task. Need a human decision? Ask with `ask_user_question`.",
		"- Cannot continue? Fail with a clear reason — the orchestrator blocks dependent tasks and reports to the parent task.",
		...options.allowRuntimeDecomposition ? ["- If the work turns out not to be atomic after all, call `task_decompose` yourself: this deployment admits a task's own decomposition, so your parent did not have to predict it. The call still has to clear admission — structure, acyclic dependencies, a command on every executable criterion, capability coverage, depth and batch-size limits — and a task may split only once; a refusal names the rule that blocked it, and that reason is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here."] : [],
		"- This prompt is where you start, not the whole truth: re-read your own contract and run with `task_read`, and the whole tree with `task_status`, whenever you need them.",
		"- Before you finish, `task_verify` re-runs the verifier as a self-check and records the evidence it produces; it never changes task status, and the final verdict stays with the verifier."
	].join("\n");
	const blocks = [
		header,
		...summary.length === 0 ? [] : [summary],
		envelope,
		parentSession,
		rules
	];
	if (childTask.decompositionStatus === "decomposable") blocks.push(decomposition);
	return `${blocks.join("\n\n")}\n`;
}

//#endregion
//#region src/normalize.ts
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
function message$1(error) {
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
* One child's criteria list. Ids are fixed here — a declared id verbatim, an
* absent one as `ac<childIndex + 1>-<criterionIndex + 1>`, the scheme the
* runtime has always used — because the digest must not depend on spellings and
* because a parent-level `childEvidence.criterionId` can only point at an id
* that was fixed before its parent's criteria were accepted.
*
* A criterion that carried a defect is left out of the returned list: the batch
* is refused as a whole, and the contract must describe only what a well-formed
* declaration asked for.
*/
function normalizeCriteria(raw, childIndex, childLabel, reasons) {
	const criteria = [];
	const seen = /* @__PURE__ */ new Set();
	const reportedDuplicate = /* @__PURE__ */ new Set();
	raw.forEach((value, index) => {
		const before = reasons.length;
		const position = `${childLabel} criterion ${index + 1}`;
		if (!isPlainObject(value)) {
			reasons.push(`${position} must be an object`);
			return;
		}
		const declaredId = value.criterionId;
		if (declaredId !== void 0 && !nonBlank(declaredId)) reasons.push(`${position} criterionId must be a non-empty string`);
		const criterionId = nonBlank(declaredId) ? declaredId : `ac${childIndex + 1}-${index + 1}`;
		const label = `${childLabel} criterion ${JSON.stringify(criterionId)}`;
		unknownFields(value, CRITERION_FIELDS, label, reasons);
		if (seen.has(criterionId) && !reportedDuplicate.has(criterionId)) {
			reasons.push(`${childLabel} declares criterion id ${JSON.stringify(criterionId)} more than once`);
			reportedDuplicate.add(criterionId);
		}
		seen.add(criterionId);
		const description = text(value.description, `${label} description`, reasons);
		const mandatory = booleanField(value.mandatory, true, `${label} mandatory`, reasons);
		const requiredEvidence = value.requiredEvidence === void 0 ? [] : stringList(value.requiredEvidence, `${label} requiredEvidence`, reasons);
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
	else criteria = normalizeCriteria(rawCriteria, index, label, reasons);
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
				children,
				admission: {
					proposalDigest: decompositionDigest({
						contractVersion,
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
					}),
					context: copyValue(context.admissionContext)
				}
			}
		};
	} catch (error) {
		return {
			ok: false,
			reasons: [`decomposition content cannot be canonicalized: ${message$1(error)}`]
		};
	}
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
/**
* Sequential run cascade over one admitted batch of children (RFC §47 MVP):
* the first child whose dependencies are all `verified` is handed off and
* spawned; its run is verified, then readiness is re-evaluated. A child whose
* dependency failed, was cancelled, or never ran becomes `blocked`; an abort
* cancels the in-flight child agent and marks its run `cancelled`. Once the
* batch settles the parent run takes the verifier's verdict on its own
* criteria — the composite acceptance that closes the loop.
*/
async function runChildrenCascade(env, storeId, parentTask, parentRun, plans, reason, callerSessionId, signal) {
	const outcomes = plans.map(() => void 0);
	const remaining = new Set(plans.map((_plan, index) => index));
	const verified = /* @__PURE__ */ new Set();
	const childTaskIds = plans.map((plan) => plan.task.taskId);
	const verify = (runId) => verifyWithDeadline(env, storeId, runId);
	/**
	* The cascade's recordReview shares the one terminal-record discipline with
	* the replay runner ({@link recordTerminalReview}). A run settled by a nested
	* decomposition is reviewed by that nested cascade (as its parent run),
	* never here.
	*/
	const recordReview = (taskId, outcome, options = {}) => recordTerminalReview(env, storeId, taskId, outcome, options);
	/**
	* Converge every child the batch never started into its terminal state: a
	* runless `TaskBlocked` plus the one review record that declares it. A task
	* that never ran has no run to settle — `TaskCancelled` accepts only a
	* `running` task — so an aborted batch records its remaining children here
	* too, with `why` naming the cancellation instead of a dependency. Either way
	* no child is left `admitted`, and the parent's composite cause never names a
	* ghost.
	*/
	const blockRemaining = async (why) => {
		const snapshot = await env.task.snapshotIn(storeId);
		for (const index of remaining) {
			const taskId = plans[index].task.taskId;
			const reason$1 = why(index);
			await env.task.markRunStatusIn(storeId, taskId, void 0, "blocked", env.actor, { reason: reason$1 });
			await recordReview(taskId, "blocked", {
				anomalies: [reason$1],
				relatedTaskIds: plans[index].dependsOn.map((dependency) => plans[dependency].task.taskId),
				blockedBy: plans[index].dependsOn.filter((dependency) => !verified.has(dependency)).map((dependency) => {
					const blockerTaskId = plans[dependency].task.taskId;
					return {
						taskId: blockerTaskId,
						outcome: snapshot.tasks.find((item) => item.taskId === blockerTaskId)?.status ?? "blocked"
					};
				})
			});
			outcomes[index] = {
				taskId,
				status: "blocked"
			};
		}
		remaining.clear();
	};
	while (remaining.size > 0) {
		if (isAborted(signal)) {
			await blockRemaining(() => CANCELLED_BEFORE_START);
			break;
		}
		const ready = [...remaining].filter((index$1) => plans[index$1].dependsOn.every((dependency) => verified.has(dependency))).sort((a, b) => a - b);
		if (ready.length === 0) {
			await blockRemaining((index$1) => {
				return `dependencies [${plans[index$1].dependsOn.filter((dependency) => !verified.has(dependency)).map((dependency) => plans[dependency].task.taskId).join(", ")}] did not verify`;
			});
			break;
		}
		const index = ready[0];
		const plan = plans[index];
		const childTaskId = plan.task.taskId;
		const snapshot = await env.task.snapshotIn(storeId);
		const dependencyTaskIds = plan.dependsOn.map((dependency) => plans[dependency].task.taskId);
		const missingArtifacts = missingRequiredArtifacts(plan.task.acceptanceCriteria, snapshot);
		if (missingArtifacts.length > 0) {
			const reason$1 = missingArtifactReason(missingArtifacts);
			await env.task.markRunStatusIn(storeId, childTaskId, void 0, "blocked", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "blocked", {
				anomalies: [reason$1],
				relatedTaskIds: dependencyTaskIds
			});
			for (const item of missingArtifacts) {
				const verified$1 = item.requirement === "requires";
				await env.task.recordObligationIn(storeId, {
					obligationId: `o-${randomUUID()}`,
					goal: `artifact/evidence "${item.ref}" required by task "${childTaskId}" criterion ${item.criterionId} does not exist in the task store${verified$1 ? " as a verified reference product" : ""}`,
					criterion: verified$1 ? `the task store holds evidence or an artifact named "${item.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict` : `the task store holds evidence or an artifact named "${item.ref}" (evidence id, artifact kind, or artifact id)`,
					sourceTaskId: childTaskId
				}, env.actor);
			}
			outcomes[index] = {
				taskId: childTaskId,
				status: "blocked"
			};
			remaining.delete(index);
			continue;
		}
		const dependencyEvidence = snapshot.evidence.filter((item) => dependencyTaskIds.includes(item.taskId)).map((item) => item.evidenceId);
		const handoff = buildHandoff({
			parentTask,
			parentRun,
			childTask: plan.task,
			reason,
			callerSessionId,
			assumptions: [...plan.assumptions ?? [], ...dependencyEvidence.map((evidenceId) => `dependency evidence "${evidenceId}" is verified and available as a reference`)],
			constraints: plan.constraints ?? [],
			relevantEvidence: dependencyEvidence
		});
		await env.task.recordHandoffIn(storeId, handoff, env.actor);
		const sessionId = `s-${randomUUID()}`;
		const name = plan.task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `child-${index + 1}`;
		const agentPreset = resolvePreset(plan.manifest, env.defaultPreset);
		const run = {
			runId: `r-${randomUUID()}`,
			taskId: childTaskId,
			sessionId,
			parentRunId: parentRun.runId,
			capabilitySnapshot: capabilitySnapshot(plan.manifest),
			...agentPreset !== void 0 ? { agentPreset } : {},
			artifacts: [],
			verifierResults: [],
			status: "running",
			startedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		let binding;
		try {
			binding = await bindRunProviders({
				storeId,
				runId: run.runId,
				manifest: plan.manifest,
				...plan.providers === void 0 ? {} : { providers: plan.providers },
				...env.runBindingRoot === void 0 ? {} : { root: env.runBindingRoot }
			});
		} catch (error) {
			const reason$1 = `content binding failed: ${message(error)}`;
			await env.task.startRunIn(storeId, run, env.actor);
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: reason$1,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			continue;
		}
		const bound = binding === void 0 ? run : {
			...run,
			providerBinding: binding
		};
		await env.task.startRunIn(storeId, bound, env.actor);
		let handle;
		try {
			await assertPresetUsable(env, plan.manifest, agentPreset);
			const permissionPreset = permissionFor(env, plan.manifest);
			handle = await env.spawn({
				sessionId,
				name,
				prompt: renderWorkerPrompt(handoff, plan.task, {
					allowRuntimeDecomposition: env.allowRuntimeDecomposition,
					...binding === void 0 ? {} : { binding }
				}),
				contract: renderWorkerContract(plan.task, handoff, binding),
				grant: await authorizedGrant(env, plan.manifest, skillRootsForRun([], binding)),
				...agentPreset !== void 0 ? { agentPreset } : {},
				...permissionPreset !== void 0 ? { permissionPreset } : {},
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			const reason$1 = `spawn failed: ${message(error)}`;
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: reason$1,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			continue;
		}
		env.onRunBound(sessionId, {
			storeId,
			taskId: childTaskId,
			runId: run.runId
		});
		const settled$1 = await awaitWorker(handle, signal, env.budget?.wallTimeMs);
		if (settled$1.kind === "aborted") {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "cancelled", env.actor, { reason: "aborted by caller" });
			await recordReview(childTaskId, "cancelled", {
				run,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "cancelled"
			};
			remaining.delete(index);
			await blockRemaining(() => CANCELLED_BEFORE_START);
			break;
		}
		if (settled$1.kind === "budget-exhausted") {
			const reason$1 = budgetExhaustedReason("wallTimeMs", `worker run exceeded its wall-clock limit of ${env.budget?.wallTimeMs}ms`);
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: reason$1,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			continue;
		}
		if (settled$1.kind === "failed") {
			const failed = settled$1.reason;
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: failed });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: failed,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			continue;
		}
		const current = await env.task.runIn(storeId, run.runId);
		if (current.status === "verified" || current.status === "failed" || current.status === "cancelled") {
			const evidenceId = current.status === "verified" ? (await env.task.snapshotIn(storeId)).evidence.find((item) => item.taskRunId === run.runId)?.evidenceId : void 0;
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: current.status,
				...evidenceId === void 0 ? {} : { evidenceId }
			};
			if (current.status === "verified") verified.add(index);
			remaining.delete(index);
			continue;
		}
		await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "verifying", env.actor);
		let bundle;
		try {
			bundle = await verify(run.runId);
		} catch (error) {
			const reason$1 = message(error);
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: reason$1,
				relatedTaskIds: dependencyTaskIds
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			if (error instanceof VerifierUnavailableError) {
				await blockRemaining(() => `verification is unavailable: ${reason$1}`);
				throw error;
			}
			continue;
		}
		const unmet = unmetMandatory(plan.task.acceptanceCriteria, bundle.verifierResults);
		if (unmet.length === 0) {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "verified", env.actor);
			await recordReview(childTaskId, "verified", {
				run,
				relatedTaskIds: dependencyTaskIds,
				criteria: reviewCriteria(plan.task.acceptanceCriteria, bundle.verifierResults)
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "verified",
				evidenceId: bundle.evidenceId
			};
			verified.add(index);
		} else {
			const reason$1 = failureReason(unmet);
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(childTaskId, "failed", {
				run,
				localizedCause: reason$1,
				relatedTaskIds: dependencyTaskIds,
				criteria: reviewCriteria(plan.task.acceptanceCriteria, bundle.verifierResults),
				logTail: await failedLogTail(env, unmet, bundle.verifierResults)
			});
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed",
				evidenceId: bundle.evidenceId
			};
		}
		remaining.delete(index);
	}
	const settled = outcomes.map((outcome, index) => outcome ?? {
		taskId: plans[index].task.taskId,
		status: "failed"
	});
	if (isAborted(signal)) {
		await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "cancelled", env.actor, { reason: "aborted by caller" });
		await recordReview(parentTask.taskId, "cancelled", {
			run: parentRun,
			relatedTaskIds: childTaskIds
		});
		return settled;
	}
	await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "verifying", env.actor);
	try {
		const parentBundle = await verify(parentRun.runId);
		const parentUnmet = unmetMandatory(parentTask.acceptanceCriteria, parentBundle.verifierResults);
		if (parentUnmet.length === 0) {
			await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "verified", env.actor);
			await recordReview(parentTask.taskId, "verified", {
				run: parentRun,
				relatedTaskIds: childTaskIds,
				criteria: reviewCriteria(parentTask.acceptanceCriteria, parentBundle.verifierResults)
			});
		} else {
			const reason$1 = failureReason(parentUnmet);
			await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "failed", env.actor, { reason: reason$1 });
			await recordReview(parentTask.taskId, "failed", {
				run: parentRun,
				localizedCause: reason$1,
				relatedTaskIds: childTaskIds,
				criteria: reviewCriteria(parentTask.acceptanceCriteria, parentBundle.verifierResults),
				logTail: await failedLogTail(env, parentUnmet, parentBundle.verifierResults)
			});
		}
	} catch (error) {
		const reason$1 = message(error);
		await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "failed", env.actor, { reason: reason$1 });
		await recordReview(parentTask.taskId, "failed", {
			run: parentRun,
			localizedCause: reason$1,
			relatedTaskIds: childTaskIds
		});
		if (error instanceof VerifierUnavailableError) throw error;
	}
	return settled;
}
/**
* Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
* the store, run it once through the real spawn + verify chain — or straight
* through the verifier alone for a deterministic criteria replay — and settle
* it with the cascade's own terminal-record discipline ({@link recordTerminalReview}),
* the lineage tag on the record's anomalies. The replayed task is parentless
* and the historical task it mirrors is never touched: a replay is a
* comparison experiment, not a tree edit. A replay never decomposes (its
* prompt says the door is closed), so there is no parent acceptance to settle.
*/
async function runReplayTask(env, storeId, init, signal) {
	const task = init.task;
	const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, await env.task.snapshotIn(storeId));
	if (missingArtifacts.length > 0) throw new Error(`task-runtime: replay rejected: ${missingArtifactReason(missingArtifacts)}`);
	const anomalies = [init.lineage];
	await env.task.createTaskIn(storeId, task, env.actor);
	await env.task.admitTaskIn(storeId, task.taskId, env.actor, {
		decompositionStatus: "leaf",
		manifest: init.manifest
	});
	const sessionId = `s-${randomUUID()}`;
	const run = {
		runId: `r-${randomUUID()}`,
		taskId: task.taskId,
		sessionId,
		...init.championRunId === void 0 ? {} : { parentRunId: init.championRunId },
		capabilitySnapshot: capabilitySnapshot(init.manifest),
		...init.agentPreset === void 0 ? {} : { agentPreset: init.agentPreset },
		artifacts: [],
		verifierResults: [],
		status: "running",
		startedAt: (/* @__PURE__ */ new Date()).toISOString()
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
		return {
			taskId: task.taskId,
			runId: run.runId,
			status: "failed",
			durationMs: await runDurationMs(env, storeId, run)
		};
	}
	await env.task.startRunIn(storeId, contentBinding === void 0 ? run : {
		...run,
		providerBinding: contentBinding
	}, env.actor);
	const finish = async (status, criteria, evidenceId) => ({
		taskId: task.taskId,
		runId: run.runId,
		status,
		durationMs: await runDurationMs(env, storeId, run),
		...criteria === void 0 ? {} : { criteria },
		...evidenceId === void 0 ? {} : { evidenceId }
	});
	/** Hand the run to the verifier and settle it on the verdict — the cascade's own ending, minus the parent. */
	const verifyAndSettle = async () => {
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "verifying", env.actor);
		let bundle;
		try {
			bundle = await verifyWithDeadline(env, storeId, run.runId);
		} catch (error) {
			const reason$1 = message(error);
			await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason: reason$1 });
			await recordTerminalReview(env, storeId, task.taskId, "failed", {
				run,
				localizedCause: reason$1,
				anomalies
			});
			if (error instanceof VerifierUnavailableError) throw error;
			return finish("failed");
		}
		const criteria = reviewCriteria(task.acceptanceCriteria, bundle.verifierResults);
		const unmet = unmetMandatory(task.acceptanceCriteria, bundle.verifierResults);
		if (unmet.length === 0) {
			await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "verified", env.actor);
			await recordTerminalReview(env, storeId, task.taskId, "verified", {
				run,
				criteria,
				anomalies
			});
			return finish("verified", criteria, bundle.evidenceId);
		}
		const reason = failureReason(unmet);
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: reason,
			criteria,
			logTail: await failedLogTail(env, unmet, bundle.verifierResults),
			anomalies
		});
		return finish("failed", criteria, bundle.evidenceId);
	};
	if (!init.spawn) return verifyAndSettle();
	let handle;
	try {
		await assertPresetUsable(env, init.manifest, init.agentPreset);
		const permissionPreset = permissionFor(env, init.manifest);
		const roots = skillRootsForRun(init.skillRoots ?? [], contentBinding);
		handle = await env.spawn({
			sessionId,
			name: task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `replay-${task.taskId}`,
			prompt: init.prompt ?? "",
			...init.contract === void 0 ? {} : { contract: init.contract },
			grant: await authorizedGrant(env, init.manifest, roots),
			...init.agentPreset === void 0 ? {} : { agentPreset: init.agentPreset },
			...permissionPreset === void 0 ? {} : { permissionPreset },
			...signal === void 0 ? {} : { signal }
		});
	} catch (error) {
		const reason = `spawn failed: ${message(error)}`;
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: reason,
			anomalies
		});
		return finish("failed");
	}
	env.onRunBound(sessionId, {
		storeId,
		taskId: task.taskId,
		runId: run.runId
	});
	const settled = await awaitWorker(handle, signal, env.budget?.wallTimeMs);
	if (settled.kind === "aborted") {
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "cancelled", env.actor, { reason: "aborted by caller" });
		await recordTerminalReview(env, storeId, task.taskId, "cancelled", {
			run,
			anomalies
		});
		return finish("cancelled");
	}
	if (settled.kind === "budget-exhausted") {
		const reason = budgetExhaustedReason("wallTimeMs", `worker run exceeded its wall-clock limit of ${env.budget?.wallTimeMs}ms`);
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: reason,
			anomalies
		});
		return finish("failed");
	}
	if (settled.kind === "failed") {
		const failed = settled.reason;
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, "failed", env.actor, { reason: failed });
		await recordTerminalReview(env, storeId, task.taskId, "failed", {
			run,
			localizedCause: failed,
			anomalies
		});
		return finish("failed");
	}
	const current = await env.task.runIn(storeId, run.runId);
	if (current.status === "verified" || current.status === "failed" || current.status === "cancelled") {
		const snapshot = await env.task.snapshotIn(storeId);
		const record = snapshot.reviews.find((item) => item.runId === run.runId);
		const evidenceId = current.status === "verified" ? snapshot.evidence.find((item) => item.taskRunId === run.runId)?.evidenceId : void 0;
		return {
			taskId: task.taskId,
			runId: run.runId,
			status: current.status,
			...record?.durationMs === void 0 ? {} : { durationMs: record.durationMs },
			...record?.criteria === void 0 ? {} : { criteria: record.criteria.map((item) => ({ ...item })) },
			...evidenceId === void 0 ? {} : { evidenceId }
		};
	}
	return verifyAndSettle();
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
/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); declared, not enforced — see {@link Config.noProgressRounds}. */
const DEFAULT_NO_PROGRESS_ROUNDS = 3;
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
* {@link Config.maxDepth}, {@link Config.maxChildren} — and a task chain still
* splits at most once (`already decomposed`, `task/src/service/state.ts`).
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
	allowRuntimeDecomposition: z.boolean().default(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION)
});
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
var TaskRuntime = class extends Service {
	static inject = [
		"task",
		"agentRuntime",
		"graphs"
	];
	static Config = ConfigSchema;
	config;
	/** sessionId → run binding, rebuilt whenever a store is (re)opened. */
	sessions = /* @__PURE__ */ new Map();
	/** The load-time provider scan, taken once ({@link providerLoadReport}). */
	providerLoad;
	constructor(ctx, config) {
		super(ctx, "taskRuntime");
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
			runBindingRoot: config?.runBindingRoot ?? defaultRunBindingRoot()
		};
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
	warn(message$5) {
		const logger = this.ctx.logger;
		logger?.("task-runtime").warn(message$5);
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
	/** The resolved no-progress round count ({@link Config.noProgressRounds}); declared, not enforced. */
	get noProgressRounds() {
		return this.config.noProgressRounds;
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
		const { refusals } = await precheckReplacedCapabilityRow({
			name,
			entry,
			table: this.config.capabilities,
			view: { cwd: process.cwd() },
			...verifierRefs === void 0 ? {} : { verifierRefs }
		});
		if (refusals.length === 0) return;
		throw new Error(`task-runtime: capability "${name}" was not replaced — the row grants providers that are not usable:\n` + refusals.map((line) => `- ${line}`).join("\n"));
	}
	/** Create (or reopen) the store, expand RootTaskSpec into the root task, and bind a run to the root session. */
	async createRootTask(storeId, options, actor) {
		try {
			await this.ctx.task.createStore(storeId);
		} catch (error) {
			if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error;
			await this.ctx.task.openStore(storeId);
		}
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		this.reindex(storeId, snapshot);
		const root = snapshot.tasks.find((task$1) => task$1.parentTaskId === void 0);
		if (root !== void 0) {
			const run$1 = [...snapshot.runs].reverse().find((item) => item.taskId === root.taskId && item.sessionId === options.rootSessionId);
			if (run$1 === void 0) throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${options.rootSessionId}"`);
			if (run$1.providerBinding !== void 0) {
				const read = await readRunBinding(run$1.providerBinding);
				if (read !== void 0 && read.defects.length > 0) throw new Error(`task-runtime: run "${run$1.runId}" cannot be re-entered: the content it is bound to is not readable:\n- ${read.defects.join("\n- ")}`);
			}
			return {
				taskId: root.taskId,
				runId: run$1.runId
			};
		}
		const manifest = this.resolveCapabilities(RootTaskSpec.requiredCapabilities);
		const contract = {
			contractVersion: TASK_CONTRACT_VERSION,
			objective: options.objective,
			acceptanceCriteria: structuredClone(RootTaskSpec.acceptanceCriteria),
			assumptions: [],
			constraints: [],
			requiredCapabilities: [...RootTaskSpec.requiredCapabilities]
		};
		const task = {
			taskId: `t-${randomUUID()}`,
			definitionRef: {
				taskType: RootTaskSpec.taskType,
				version: RootTaskSpec.version
			},
			objective: contract.objective,
			depth: 0,
			acceptanceCriteria: contract.acceptanceCriteria,
			requestedCapabilities: [...contract.requiredCapabilities],
			decompositionStatus: "decomposable",
			status: "created",
			runIds: [],
			childTaskIds: [],
			contract
		};
		await this.ctx.task.createTaskIn(storeId, task, actor);
		await this.ctx.task.admitTaskIn(storeId, task.taskId, actor, {
			decompositionStatus: "decomposable",
			manifest
		});
		const runId = `r-${randomUUID()}`;
		const providerBinding = await bindRunProviders({
			storeId,
			runId,
			manifest,
			table: this.config.capabilities,
			root: this.config.runBindingRoot
		});
		const run = {
			runId,
			taskId: task.taskId,
			sessionId: options.rootSessionId,
			capabilitySnapshot: capabilitySnapshot(manifest),
			providerBinding,
			artifacts: [],
			verifierResults: [],
			status: "running",
			startedAt: now()
		};
		await this.ctx.task.startRunIn(storeId, run, actor);
		this.sessions.set(options.rootSessionId, {
			storeId,
			taskId: task.taskId,
			runId: run.runId
		});
		return {
			taskId: task.taskId,
			runId: run.runId
		};
	}
	/**
	* Atomic decomposition plus the sequential run cascade: protected-input
	* identity fixing, normalization, structural admission and capability
	* admission must all pass for the whole batch before anything is persisted;
	* children then run one at a time in dependency order.
	*
	* Protected acceptance inputs are fixed first (`protected-inputs.ts`): every
	* criterion's declared paths are read against the session's checkout and
	* recorded as the SHA-256 of their bytes, so the contract — and both content
	* identities computed over it — describe the fixed identity, never a path
	* that could be re-pointed or re-read later.
	*
	* The batch is then normalized ({@link normalizeDecomposition}): raw caller
	* input becomes the contract of every child with its defaults filled and its
	* criterion ids fixed, and the batch identity plus the limits in force become
	* ready to be recorded with the decomposition. A refused batch — by the
	* fixing or by normalization, in one message — is refused whole: no id is
	* minted into the store, no capability is resolved into an event, and no
	* obligation is recorded.
	*
	* The structural policy is `allowed` — a `leaf` task may decompose only while
	* {@link Config.allowRuntimeDecomposition} is on — plus the configured growth
	* guardrails ({@link DEFAULT_MAX_DEPTH}, {@link DEFAULT_MAX_CHILDREN}); a
	* rejected batch names the rule it hit and persists and spawns nothing.
	*/
	async decomposeAndRun(storeId, parentTaskId, parentRunId, callerSessionId, spec, exec = {}) {
		const actor = callerSessionId;
		const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId);
		const parentRun = await this.ctx.task.runIn(storeId, parentRunId);
		if (parentRun.taskId !== parentTaskId) throw new Error(`task-runtime: run "${parentRunId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`);
		if (parentRun.sessionId !== callerSessionId) throw new Error(`task-runtime: run "${parentRunId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`);
		const envPath = await this.envPathForSession(callerSessionId);
		const fixed = await fixSpecProtectedInputs(spec, envPath);
		const normalized = normalizeDecomposition(fixed.spec, {
			storeId,
			parentTaskId,
			parentRunId,
			callerSessionId,
			admissionContext: this.admissionContext()
		});
		const reasons = [...fixed.reasons, ...normalized.ok ? [] : normalized.reasons];
		if (!normalized.ok || reasons.length > 0) throw this.contractRefusal(parentTaskId, reasons);
		const batch = normalized.batch;
		const childTaskIds = batch.children.map(() => `t-${randomUUID()}`);
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const leaf = parentTask.decompositionStatus === "leaf";
		const verdict = checkDecomposition({
			...parentTask,
			decompositionPolicy: {
				allowed: !leaf || this.config.allowRuntimeDecomposition,
				leaf,
				maxDepth: this.config.maxDepth,
				maxChildren: this.config.maxChildren
			}
		}, batch.children.map((child, index) => ({
			taskId: childTaskIds[index],
			objective: child.contract.objective,
			acceptanceCriteria: child.contract.acceptanceCriteria,
			dependsOn: child.dependsOn,
			requiresIndependentAcceptance: child.requiresIndependentAcceptance
		})), snapshot.edges);
		if (!verdict.ok) throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join("\n- ")}`);
		const manifests = batch.children.map((child) => this.resolveCapabilities(child.contract.requiredCapabilities));
		const rejected = batch.children.map((child, index) => ({
			child,
			index,
			manifest: manifests[index]
		})).filter(({ child, manifest }) => manifest.missing.length > 0 && !child.decomposable);
		if (rejected.length > 0) {
			const detail = rejected.map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(", ")}] and may not decompose`).join("; ");
			for (const { index, manifest } of rejected) for (const missing of manifest.missing) await this.ctx.task.recordObligationIn(storeId, {
				obligationId: `o-${randomUUID()}`,
				goal: `capability "${missing}" required by child ${index} ("${batch.children[index].contract.objective}") of "${parentTaskId}" is not granted by the registry`,
				criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
				sourceTaskId: parentTaskId
			}, actor);
			const gapNames = [...new Set(rejected.flatMap(({ manifest }) => manifest.missing))];
			throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}; ` + escalationHint(`capabilities [${gapNames.join(", ")}] are not granted by the capability registry`, "capability_list and the children's declared capabilities", "grant the capability in the registry, or mark the child decomposable"));
		}
		const precheck = await this.providerPrecheck([...new Set(manifests.flatMap((manifest) => Object.keys(manifest.capabilities)))], { ...envPath === void 0 ? {} : { cwd: envPath } });
		const refusals = providerRefusals(precheck);
		if (refusals.length > 0) throw new Error(`task-runtime: provider pre-check rejected decomposition of "${parentTaskId}":\n- ${refusals.join("\n- ")}`);
		this.assertKnownVerifierRefs(batch.children.flatMap((child, childIndex) => child.contract.acceptanceCriteria.map((criterion) => ({
			childIndex,
			criterion
		}))), `decomposition of "${parentTaskId}"`);
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
		await this.ctx.task.decomposeIn(storeId, parentTaskId, children, actor, edges, batch.admission);
		const manifestEvents = manifests.flatMap((manifest, index) => {
			const envelope = {
				taskId: childTaskIds[index],
				parentTaskId,
				timestamp: now(),
				actor,
				schemaVersion: 1
			};
			const events = [{
				...envelope,
				kind: "CapabilityResolved",
				payload: { manifest }
			}];
			if (manifest.missing.length > 0) events.push({
				...envelope,
				kind: "CapabilityGapDetected",
				payload: { missing: [...manifest.missing] }
			});
			return events;
		});
		await this.ctx.task.commitIn(storeId, manifestEvents);
		const plans = children.map((task, index) => {
			const child = batch.children[index];
			return {
				task,
				manifest: manifests[index],
				dependsOn: child.dependsOn,
				providers: precheck,
				assumptions: [...child.contract.assumptions],
				constraints: [...child.contract.constraints]
			};
		});
		return runChildrenCascade(this.orchestrateEnv(callerSessionId, actor), storeId, parentTask, parentRun, plans, spec.reason, callerSessionId, exec.signal);
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
	* replay caller's checkout: a candidate contract declaring paths has their
	* identity fixed before anything else reads it, while a champion's stored
	* `{ path, sha256 }` refs are carried verbatim — the historical identity is
	* what the pre-judgement re-check compares against, so it is never re-read
	* from disk and never invented. A replay has no batch, so it records no
	* admission context: nothing was proposed to a parent, there is no sibling
	* set to bound, and the limits that do apply to its run are the run's own
	* budget, not a batch's.
	*/
	async replayTask(storeId, championTaskId, options, callerSessionId) {
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
		const envPath = await this.envPathForSession(callerSessionId);
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
		this.assertKnownVerifierRefs(fixed.criteria.map((criterion) => ({
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
		let prompt;
		let contractBlock;
		if (spawn) {
			const handoff = buildHandoff({
				parentTask: champion,
				parentRun: await this.ctx.task.runIn(storeId, championRunId),
				childTask: task,
				reason: `${options.lineage}: replay of ${championTaskId} under the candidate's overlay`,
				callerSessionId,
				assumptions: [...contract.assumptions],
				constraints: [...contract.constraints],
				relevantEvidence: []
			});
			prompt = renderWorkerPrompt(handoff, task, { allowRuntimeDecomposition: false });
			contractBlock = renderWorkerContract(task, handoff);
		}
		return runReplayTask(this.orchestrateEnv(callerSessionId, callerSessionId), storeId, {
			task,
			manifest,
			providers: precheck,
			lineage: options.lineage,
			agentPreset: options.overlay?.presetOverride ?? resolvePreset(manifest, this.config.defaultPreset),
			...prompt === void 0 ? {} : {
				prompt,
				contract: contractBlock
			},
			...options.overlay?.extraSkillRoots === void 0 ? {} : { skillRoots: [...options.overlay.extraSkillRoots] },
			spawn,
			championRunId
		}, options.signal);
	}
	/** Reverse lookup: the task run a (worker) session is bound to. */
	async runForSession(sessionId) {
		const found = await this.lookupRun(sessionId);
		if (found === void 0) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`);
		return found;
	}
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
		try {
			const snapshot = await this.ctx.task.openStore(storeId);
			this.reindex(storeId, snapshot);
		} catch {
			return;
		}
		const rebinding = this.sessions.get(sessionId);
		if (rebinding === void 0) return void 0;
		return this.resolveBinding(rebinding);
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
	*/
	async envPathForSession(sessionId) {
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
	orchestrateEnv(callerSessionId, actor) {
		return {
			task: this.ctx.task,
			actor,
			...this.config.defaultPreset !== void 0 ? { defaultPreset: this.config.defaultPreset } : {},
			...this.config.runBindingRoot === void 0 ? {} : { runBindingRoot: this.config.runBindingRoot },
			verifyTimeoutMs: this.config.verifyTimeoutMs,
			budget: { ...this.config.budget },
			allowRuntimeDecomposition: this.config.allowRuntimeDecomposition,
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
				return {
					envRoot: env.path,
					checkout: (repo) => {
						const component = (env.components ?? []).find((item) => item.repo === repo);
						return component === void 0 ? void 0 : join(env.path, component.dir);
					}
				};
			},
			spawn: (request) => {
				const parent = this.liveAgent(callerSessionId);
				return this.ctx.agentRuntime.spawn(parent, {
					sessionId: SessionId(request.sessionId),
					name: request.name,
					prompt: [{
						type: "text",
						text: request.prompt
					}],
					...request.contract !== void 0 ? { contract: request.contract } : {},
					...request.agentPreset !== void 0 ? { agentPreset: request.agentPreset } : {},
					...request.permissionPreset !== void 0 ? { permissionPreset: request.permissionPreset } : {},
					...request.grant !== void 0 ? { grant: request.grant } : {},
					...request.signal !== void 0 ? { signal: request.signal } : {}
				});
			},
			verifyRun: async (storeId, runId, options = {}) => {
				const verifier = this.runVerifier();
				if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new VerifierUnavailableError(`task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`);
				const cwd = await this.envPathForSession(callerSessionId);
				return verifier.verifyRun(storeId, runId, {
					...cwd === void 0 ? {} : { cwd },
					...options
				});
			},
			readLogTail: async (logRef) => this.runVerifier()?.logTail?.(logRef),
			observeSession: async (sessionId) => this.observeSession(sessionId),
			onRunBound: (sessionId, binding) => {
				this.sessions.set(sessionId, binding);
			}
		};
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
		return precheckProviders({
			capabilities,
			table,
			view,
			...verifierRefs === void 0 ? {} : { verifierRefs }
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
	* re-entry (`createRootTask` adopting an existing run) both perform before
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
	* the error lists the registered ids. A deployment whose verifier service is
	* absent or cannot list its registry cannot make that promise, so a declared
	* ref fails loudly there instead of passing through unchecked.
	*/
	assertKnownVerifierRefs(declared, what) {
		const refs = declared.filter((item) => item.criterion.verifierRef !== void 0);
		if (refs.length === 0) return;
		const registered = this.runVerifier()?.verifierIds?.();
		if (registered === void 0) throw new VerifierUnavailableError(`task-runtime: cannot validate verifierRef on ${what}: the verifier service is not loaded or cannot list its registry`);
		const unknown = refs.filter((item) => !registered.includes(item.criterion.verifierRef));
		if (unknown.length === 0) return;
		const detail = unknown.map((item) => `child ${item.childIndex} criterion "${item.criterion.criterionId}" references unknown verifier "${item.criterion.verifierRef}"`).join("; ");
		throw new Error(`task-runtime: admission rejected ${what}: ${detail}; registered verifiers: ${registered.join(", ")}`);
	}
	/** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
	liveAgent(sessionId) {
		const agent = (this.ctx.get?.("agents") ?? this.ctx.agents)?.get(sessionId);
		if (agent === void 0) throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`);
		return agent;
	}
};
var src_default = TaskRuntime;

//#endregion
export { DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, MCP_SERVER_REGISTRY, RUN_BINDING_SKILLS_DIR, TOOL_LABELS, TaskRuntime, VerifierUnavailableError, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN, bindRunProviders, buildHandoff, capabilityToolQuery, checkDecomposition, checkObligationCoverage, contractDefects, src_default as default, defaultRunBindingRoot, escalationHint, executionProviders, findRepoRoot, fixCriteriaProtectedInputs, fixProtectedInputs, fixSpecProtectedInputs, independentAcceptanceDefects, loadObligationTemplates, loadSkillSidecar, manifestMcpServers, normalizeDecomposition, optionalService, parseObligationTemplates, precheckProviders, precheckReplacedCapabilityRow, protectedInputDefects, providerDefectLines, providerRefusals, readRunBinding, readVerifiedFile, registeredVerifierIds, registryRevision, renderRunBinding, renderWorkerContract, renderWorkerPrompt, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveToolLabels, runChildrenCascade, runReplayTask, skillSearchRoots, skillValidationContext, unlistableVerifierRefusal, validateSkillProvider, walkVerified, workerBaseline };