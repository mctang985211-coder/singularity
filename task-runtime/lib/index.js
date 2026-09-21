import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { RootTaskSpec, TASK_CONTRACT_VERSION, contractDigest, decompositionDigest, reaches, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { readFile, readdir, stat } from "node:fs/promises";

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
* (later) a template instance. Texts, ids and modes only; nothing here judges
* whether a criterion is any good, and nothing here needs the store.
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
* objective, the acceptance criteria table (with verifier commands), the
* handoff envelope, the pointer to the delegating session, the decomposable
* reminder when the parent asked for a further split, the runtime-split rule
* when the deployment admits one ({@link WorkerPromptOptions}), and the rules —
* a few thousand tokens at most.
*/
function renderWorkerPrompt(handoff, childTask, options) {
	const header = [
		`# Delegated task ${childTask.taskId}`,
		"",
		childTask.objective,
		"",
		"## Acceptance criteria",
		"",
		"| criterion | mode | mandatory | description | command |",
		"| --- | --- | --- | --- | --- |",
		...childTask.acceptanceCriteria.map((criterion) => `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? "yes" : "no"} | ${criterion.description} | ${criterion.command ?? "—"} |`)
	].join("\n");
	const decomposition = [
		"## This task is decomposable",
		"",
		"- Do not carry the work to completion yourself: this task was admitted as decomposable.",
		"- Call `task_decompose` instead, with a `reason` and the child task list; every child needs an acceptance criterion a verifier can judge on its own.",
		"- Decompose only when RFC §36 atomicity holds — independently verifiable acceptance dimensions, clear artifact boundaries, capabilities that match or gaps you can handle; otherwise do the work here.",
		"- Once you decompose, the nested verification settles this task; you still never declare completion yourself."
	].join("\n");
	const blocks = [
		header,
		[
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
		].join("\n"),
		[
			"## Parent session",
			"",
			`- The session that delegated this task is \`${handoff.parentSessionRef}\`.`,
			"- Need more of that context? Read it exactly with `session_event_read` (one `seq`) or `session_trace` (lineage and neighborhood).",
			"- Full-text search is disabled in this deployment, so read parent events by sequence."
		].join("\n"),
		[
			"## Rules",
			"",
			"- Do the work; never declare completion yourself — an external verifier checks every mandatory criterion.",
			"- Where a criterion lists a command, make that command exit 0 in the checkout.",
			"- Keep changes scoped to this task. Need a human decision? Ask with `ask_user_question`.",
			"- Cannot continue? Fail with a clear reason — the orchestrator blocks dependent tasks and reports to the parent task.",
			...options.allowRuntimeDecomposition ? ["- If the work turns out not to be atomic after all, call `task_decompose` yourself: this deployment admits a task's own decomposition, so your parent did not have to predict it. The call still has to clear admission — structure, acyclic dependencies, a command on every executable criterion, capability coverage, depth and batch-size limits — and a task may split only once; a refusal names the rule that blocked it, and that reason is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here."] : [],
			"- This prompt is where you start, not the whole truth: re-read your own contract and run with `task_read`, and the whole tree with `task_status`, whenever you need them.",
			"- Before you finish, `task_verify` re-runs the verifier as a self-check and records the evidence it produces; it never changes task status, and the final verdict stays with the verifier."
		].join("\n")
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
	"heuristic"
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
			...value.heuristic === void 0 ? {} : { heuristic: carried(value.heuristic) }
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
//#region src/contract.ts
/**
* Opening marker of the block. Stable on purpose: it is what tells a reader —
* human or test — that this text is the contract, and it lets a future
* re-render find the copy already on the surface.
*/
const WORKER_CONTRACT_OPEN = "<worker-contract";
/** Closing marker, and the URL-safe suffix a search for the block's end uses. */
const WORKER_CONTRACT_CLOSE = "</worker-contract>";
/** The criteria table, in the same shape the spawn prompt renders: what, how judged, and the command. */
function criteriaTable(criteria) {
	return [
		"| criterion | mode | mandatory | description | command |",
		"| --- | --- | --- | --- | --- |",
		...criteria.map((criterion) => `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? "yes" : "no"} | ${criterion.description} | ${criterion.command ?? "—"} |`)
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
* @returns the marked block, ending in the one line that says where the
*   authority lives, so a model reading it never has to guess whether a
*   compacted spawn prompt or this block is the current contract.
*/
function renderWorkerContract(task, handoff) {
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
* servers materialized against the run's env binding. Throws when a declared
* server has no binding or its repo is absent from the env — inside the spawn
* `try`, so the failure walks the run to `failed` with the cause named, the
* same discipline as a dangling preset.
*/
async function authorizedGrant(env, manifest) {
	const grant = workerGrant(manifest);
	if (manifestMcpServers(manifest).length === 0) return grant;
	const binding = env.resolveMcpEnv === void 0 ? void 0 : await env.resolveMcpEnv();
	return {
		...grant,
		mcpServers: resolveMcpServerSpecs(manifest, binding)
	};
}
/**
* Copy the verifier's per-criterion results onto a review record, filling the
* command from the criterion itself when the result omits it — the record
* must show what was checked without a trip back into the evidence bundle.
*/
function reviewCriteria(criteria, results) {
	return results.map((result) => {
		const command = result.command ?? criteria.find((item) => item.criterionId === result.criterionId)?.command;
		return {
			criterionId: result.criterionId,
			verdict: result.status,
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
		if (wallTimeMs !== void 0) branches.push(new Promise((resolve) => {
			timer = setTimeout(() => resolve({ kind: "budget-exhausted" }), wallTimeMs);
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
		await env.task.startRunIn(storeId, run, env.actor);
		let handle;
		try {
			await assertPresetUsable(env, plan.manifest, agentPreset);
			const permissionPreset = permissionFor(env, plan.manifest);
			handle = await env.spawn({
				sessionId,
				name,
				prompt: renderWorkerPrompt(handoff, plan.task, { allowRuntimeDecomposition: env.allowRuntimeDecomposition }),
				contract: renderWorkerContract(plan.task, handoff),
				grant: await authorizedGrant(env, plan.manifest),
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
	await env.task.startRunIn(storeId, run, env.actor);
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
		handle = await env.spawn({
			sessionId,
			name: task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `replay-${task.taskId}`,
			prompt: init.prompt ?? "",
			...init.contract === void 0 ? {} : { contract: init.contract },
			grant: {
				...await authorizedGrant(env, init.manifest),
				...init.skillRoots === void 0 ? {} : { skillRoots: [...init.skillRoots] }
			},
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
			allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION
		};
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
	*/
	applyCapabilityRow(name, entry) {
		if (entry === null) {
			const rest = { ...this.config.capabilities };
			delete rest[name];
			this.config.capabilities = rest;
			return;
		}
		this.config.capabilities = {
			...this.config.capabilities,
			[name]: structuredClone(entry)
		};
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
		const run = {
			runId: `r-${randomUUID()}`,
			taskId: task.taskId,
			sessionId: options.rootSessionId,
			capabilitySnapshot: capabilitySnapshot(manifest),
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
	* Atomic decomposition plus the sequential run cascade: normalization,
	* structural admission and capability admission must all pass for the whole
	* batch before anything is persisted; children then run one at a time in
	* dependency order.
	*
	* The batch is normalized first ({@link normalizeDecomposition}): raw caller
	* input becomes the contract of every child with its defaults filled and its
	* criterion ids fixed, and the batch identity plus the limits in force become
	* ready to be recorded with the decomposition. A refused batch is refused
	* whole — the error names every reason, no id is minted into the store, no
	* capability is resolved into an event, and no obligation is recorded.
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
		const normalized = normalizeDecomposition(spec, {
			storeId,
			parentTaskId,
			parentRunId,
			callerSessionId,
			admissionContext: this.admissionContext()
		});
		if (!normalized.ok) throw new Error(`task-runtime: contract rejected decomposition of "${parentTaskId}":\n- ${normalized.reasons.join("\n- ")}`);
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
	* A replay has no batch, so it records no admission context: nothing was
	* proposed to a parent, there is no sibling set to bound, and the limits that
	* do apply to its run are the run's own budget, not a batch's.
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
		const label = `replay of "${championTaskId}"`;
		const acceptanceDefects = [...contractDefects(effective.acceptanceCriteria, label), ...independentAcceptanceDefects(effective.acceptanceCriteria, champion.requiresIndependentAcceptance, label)];
		if (acceptanceDefects.length > 0) throw new Error(`task-runtime: replay of "${championTaskId}" rejected:\n- ${acceptanceDefects.join("\n- ")}`);
		this.assertKnownVerifierRefs(effective.acceptanceCriteria.map((criterion) => ({
			childIndex: 0,
			criterion
		})), `replay of "${championTaskId}"`);
		const contract = {
			contractVersion: TASK_CONTRACT_VERSION,
			objective: `[${options.lineage}] ${effective.objective}`,
			acceptanceCriteria: structuredClone(effective.acceptanceCriteria),
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
	orchestrateEnv(callerSessionId, actor) {
		return {
			task: this.ctx.task,
			actor,
			...this.config.defaultPreset !== void 0 ? { defaultPreset: this.config.defaultPreset } : {},
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
				const envBuilder = this.ctx.get?.("envBuilder") ?? this.ctx.envBuilder;
				if (envBuilder === void 0) return void 0;
				try {
					const graph = await this.ctx.graphs.graphForSession(SessionId(callerSessionId));
					const env = envBuilder.store.get(graph.envId);
					return {
						envRoot: env.path,
						checkout: (repo) => {
							const component = (env.components ?? []).find((item) => item.repo === repo);
							return component === void 0 ? void 0 : join(env.path, component.dir);
						}
					};
				} catch {
					return;
				}
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
				let cwd;
				try {
					const graph = await this.ctx.graphs.graphForSession(SessionId(callerSessionId));
					cwd = (this.ctx.get?.("envBuilder") ?? this.ctx.envBuilder)?.store.get(graph.envId).path;
				} catch {
					cwd = void 0;
				}
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
		const viaContext = this.ctx.get?.(name);
		if (viaContext !== void 0) return viaContext;
		return this.ctx[name];
	}
	/** The verifier service is an optional plugin; resolve it softly, never import the package. */
	runVerifier() {
		return this.ctx.get?.("verifier") ?? this.ctx.verifier;
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
export { DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_CAPABILITIES, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_NO_PROGRESS_ROUNDS, DEFAULT_VERIFY_TIMEOUT_MS, MCP_SERVER_REGISTRY, TOOL_LABELS, TaskRuntime, VerifierUnavailableError, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN, buildHandoff, checkDecomposition, checkObligationCoverage, contractDefects, src_default as default, escalationHint, findRepoRoot, independentAcceptanceDefects, loadObligationTemplates, manifestMcpServers, normalizeDecomposition, parseObligationTemplates, renderWorkerContract, renderWorkerPrompt, resolveCapabilities, resolveMcpServerSpecs, resolvePermission, resolveToolLabels, runChildrenCascade, runReplayTask, workerBaseline };