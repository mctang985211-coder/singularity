import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ROOT_PROPOSAL_TASK_ID, TASK_CONTRACT_VERSION, TERMINAL_RUN_STATUSES, admissionContextDigest, answerIdOf, approvedBudgetCeilings, batchIdFor, blockingQuestionsOf, budgetExtensionRequestDigest, canonicalize, capabilityManifestDigest, contractDigest, decompositionDigest, describeBudgetExtension, openQuestionsOf, questionIdOf, questionOf, questionsAwaitingAnswerOf, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, runMemberSlots, runMemberTaskIds, sha256Hex, taskProposalId } from "@dangosys/dsh-singularity-task";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { answerMessageText, findSkillFileIn, parseSkillFile, questionMessageText, skillRootsFor, toolCallRefIn } from "@dangosys/dsh-singularity-agent-runtime";
import { SessionId } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";

//#region src/mcp-servers.ts
/**
* The servers a capability may name. `bbdev` is the buckyball checkout's own
* FastMCP server (45 tools, submit/poll-shaped to stay under the per-call
*/
const MCP_SERVER_REGISTRY = {
	bbdev: {
		serverName: "bbdev",
		description: "buckyball bbdev MCP server (build/simulate/validate; submit + task_status poll) from the env checkout",
		command: "{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh",
		args: [],
		cwd: "{repoRoot:buckyball}"
	},
	waveform: {
		serverName: "waveform",
		description: "buckyball waveform-mcp server (VCD/FST open/read, signal hierarchy, event search) from the env checkout",
		command: "{repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp",
		args: [],
		cwd: "{repoRoot:buckyball}"
	}
};
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
*/
/** Reject a name outside a closed vocabulary, naming the vocabulary in the refusal. */
function assertKnownName(capability, kind, knownLabel, knownNames, name) {
	if (knownNames.includes(name)) return;
	throw new Error(`task-runtime: capability "${capability}" declares unknown ${kind} "${name}"; ${knownLabel}: ${[...knownNames].sort().join(", ")}`);
}
/**
* Capability tool labels → the real DSH tool names each label grants.
* A capability table is authored against what the WORK needs, not against
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
*/
function resolveToolLabels(capability, labels) {
	return labels.flatMap((label) => {
		assertKnownName(capability, "tool label", "known labels", Object.keys(TOOL_LABELS), label);
		return [...TOOL_LABELS[label]];
	});
}
/**
* The capability-worker baseline: what every worker needs whatever its
* capabilities are, because its own prompt tells it to use these. Every entry
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
*/
function workerBaseline() {
	return [...new Set([...resolveToolLabels("worker baseline", WORKER_BASELINE_LABELS), ...WORKER_BASELINE_TOOLS])];
}
/**
* Resolve required capability names against the configured registry.
* A required name that has an entry contributes its skills/tools/preset to the
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
		for (const server of entry.mcpServers ?? []) assertKnownName(name, "MCP server", "known servers", Object.keys(MCP_SERVER_REGISTRY), server);
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
//#region src/helpers.ts
/** The small primitives every module here shares: error text, waiting, and shape checks. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
function sleep(ms) {
	return new Promise((resolve$1) => {
		setTimeout(resolve$1, ms);
	});
}
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/** Non-blank text: the one check every string field shares, with no rewriting of the value. */
function nonBlank(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** The keys a value carries that a closed field set does not declare, in declaration order. */
function unknownFieldKeys(value, allowed) {
	const declared = new Set(allowed);
	return Object.keys(value).filter((key) => !declared.has(key));
}
/** Run `work` after the work already queued under `key`, in call order; the drained entry goes. */
function enqueueByKey(chains, key, work) {
	const run = (chains.get(key) ?? Promise.resolve()).then(work, work);
	const settled = run.then(() => void 0, () => void 0);
	chains.set(key, settled);
	settled.then(() => {
		if (chains.get(key) === settled) chains.delete(key);
	});
	return run;
}

//#endregion
//#region src/gate.ts
/**
* What a session bound to a run may still call once its run is no longer
* `active`. Read-only inspection, diagnosis, the human-question tools, and the
*/
const COORDINATION_ALLOWED = new Set([
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"skill",
	"task_review_pack",
	"task_review_agent",
	"task_diagnose",
	"task_budget_extend",
	"task_recover",
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
/**
* The phase each session is in, what it has in flight, and whether it is waiting
* on an answer. One instance per runtime; nothing here touches the store or a
*/
var ExecutionGate = class {
	phases = /* @__PURE__ */ new Map();
	/** Registering by call id (not by session) because `tools/result` carries only the call id. */
	calls = /* @__PURE__ */ new Map();
	/**
	* How many times this process wrote one session's phase by its own authority
	* ({@link setPhase}, {@link setTerminal}): the applicability token a
	*/
	decisions = /* @__PURE__ */ new Map();
	/**
	* The sessions whose runs are waiting on an unresolved blocking question
	* (A4 §F.1). A set rather than a map of booleans: "no entry" and "not blocked"
	*/
	questionBlocked = /* @__PURE__ */ new Set();
	/**
	* Move a session's phase: the runtime calls this when **it** is the authority
	* for the transition — a committed admission or submission, a settled run, an
	*/
	setPhase(sessionId, phase) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		this.phases.set(sessionId, phase);
	}
	/**
	* Mark a session's run terminal: only the allow-list runs from here, and its
	* reason says the call is late. A decision, like {@link setPhase} — it moves
	*/
	setTerminal(sessionId) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		this.phases.set(sessionId, "terminal");
		this.questionBlocked.delete(sessionId);
	}
	/**
	* How many times this process has written this session's phase by its own
	* authority; `0` for a session it has never written one for. This is the
	*/
	decisionToken(sessionId) {
		return this.decisions.get(sessionId) ?? 0;
	}
	/**
	* Apply a phase the store implies — never one this process decided — and only
	* when it is newer than everything decided here: `token` is the
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
	*/
	setQuestionsBlocked(sessionId, blocked) {
		this.decisions.set(sessionId, this.decisionToken(sessionId) + 1);
		if (blocked) this.questionBlocked.add(sessionId);
		else this.questionBlocked.delete(sessionId);
	}
	/**
	* Apply a blocking state the store implies — never one this process decided —
	* under the same token rule as {@link applyStorePhase}: `token` is the
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
			await sleep(DRAIN_POLL_MS);
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
*/
async function drainSession(gate$1, sessionId, options) {
	const { jobs, agent } = options;
	return await gate$1.drainSession(sessionId, {
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
*/
async function reconcileJobs(jobs, agent, deadline) {
	const pending = [];
	let listed;
	try {
		listed = jobs.list(agent);
	} catch (error) {
		return [`the jobs service could not be listed (${message(error)}), so its managed work could not be reconciled`];
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
			pending.push(`job "${id}" (${entry.status}) could not be killed: ${message(error)}`);
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
			pending.push(`job "${id}" (${entry.status}) could not be waited for: ${message(error)}`);
		}
	}
	return pending;
}

//#endregion
//#region src/root-budget.ts
/**
* Whether a root budget enforces anything at all. The configuration's schema
* materializes an absent `rootBudget` as an empty object, so the presence of an
*/
function hasRootLimits(config) {
	return config !== void 0 && (config.maxRuns !== void 0 || config.maxConcurrentWrites !== void 0);
}
function instant(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* The root budget a snapshot is under, or the reason none can be measured.
* The owner is the store's own root: among the parentless tasks, the one whose
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
	if (instant(first.startedAt) === void 0) return {
		ok: false,
		reason: `root task ${root.taskId}'s first run ${first.runId} records no readable startedAt (${JSON.stringify(first.startedAt)}), so the tree has no honest start instant and is not given a fresh one`
	};
	const configured = { ...config.maxRuns === void 0 ? {} : { maxRuns: config.maxRuns } };
	const maxRuns = approvedBudgetCeilings(snapshot.budgetExtensions?.all ?? []).maxRuns ?? configured.maxRuns;
	return {
		ok: true,
		rootTaskId: root.taskId,
		acceptedAt: first.startedAt,
		...maxRuns === void 0 ? {} : { maxRuns },
		configured
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
* Whether the persisted run count leaves room for another run.
*/
function checkRunStart(snapshot, budget$1) {
	if (budget$1.maxRuns !== void 0 && snapshot.runs.length >= budget$1.maxRuns) return {
		allowed: false,
		reason: `the root budget allows ${budget$1.maxRuns} run(s) for root ${budget$1.rootTaskId} and the store already holds ${snapshot.runs.length}; the limit counts recorded runs so it cannot be reset by a restart`
	};
	return { allowed: true };
}
/**
* Whether a decomposition batch of `childCount` children may be admitted. The
* check is a reservation, not a forecast: the children will each start a run, so
*/
function checkBatchAdmission(snapshot, budget$1, childCount) {
	if (budget$1.maxRuns === void 0) return { allowed: true };
	const total = snapshot.runs.length + childCount;
	if (total > budget$1.maxRuns) return {
		allowed: false,
		reason: `a batch of ${childCount} child task(s) would need ${childCount} run slot(s) and the root budget allows ${budget$1.maxRuns} run(s) in total, of which ${snapshot.runs.length} are already recorded (${total} > ${budget$1.maxRuns}); the batch is refused whole, with no side effects`
	};
	return { allowed: true };
}
/**
* Refuse a root budget this deployment cannot execute. The one such limit is
* `maxConcurrentWrites`: the workspace registry enforces exactly one writer, so
*/
function assertRootBudgetConfig(config) {
	if (config.maxConcurrentWrites !== void 0 && config.maxConcurrentWrites !== 1) throw new Error(`rootBudget.maxConcurrentWrites is ${config.maxConcurrentWrites}: this deployment enforces exactly 1 concurrent writer per workspace, so it cannot honor another number and refuses to start rather than run under a limit it cannot execute`);
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
*/
const SKILL_CONTRACT_VERSION = 1;
/**
* The directories a skill may hold supporting files in. The supported shape is
* deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
*/
const SUPPORTED_SKILL_RESOURCE_DIRS = ["references", "scripts"];
/**
* Whether one declared resource path is a path this contract can identify:
* exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
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
	return unknownFieldKeys(value, allowed).sort().map((key) => ({
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
		if (!nonBlank(item)) {
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
		if (!isPlainObject(port)) {
			defects.push(shape(`${at} must be an object carrying name, description, required`));
			return;
		}
		defects.push(...unknownFields$1(port, PORT_FIELDS, at, "a port carries name, description, required"));
		if (!nonBlank(port.name)) defects.push(shape(`${at}.name must be a non-blank string`));
		if (!nonBlank(port.description)) defects.push(shape(`${at}.description must be a non-blank string`));
		if (typeof port.required !== "boolean") defects.push(shape(`${at}.required must be a boolean`));
		if (nonBlank(port.name)) {
			if (seen.has(port.name)) defects.push(shape(`${at} duplicates port ${JSON.stringify(port.name)}`));
			seen.add(port.name);
		}
	});
	return defects;
}
/** The content identity: exact digests, a supported path vocabulary, and one sorted list. */
function contentDefects$1(value) {
	if (!isPlainObject(value)) return [shape("sidecar.content must be an object carrying skillMdSha256 and resources")];
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
		if (!isPlainObject(resource)) {
			defects.push(shape(`${at} must be an object carrying path, sha256`));
			return;
		}
		defects.push(...unknownFields$1(resource, RESOURCE_FIELDS, at, "a resource identity carries path, sha256"));
		if (!nonBlank(resource.path) || !isSupportedSkillResourcePath(resource.path)) defects.push(shape(`${at}.path ${described(resource.path)} is not a supported resource path (references/<file> or scripts/<file>)`));
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
	if (!isPlainObject(value)) return [shape("sidecar.verifier must be an object carrying a ref")];
	const defects = unknownFields$1(value, VERIFIER_FIELDS, "sidecar.verifier", "a verifier reference carries ref");
	if (!nonBlank(value.ref)) defects.push(shape("sidecar.verifier.ref must be a non-blank string"));
	return defects;
}
function contentCheckDefects(value) {
	if (!isPlainObject(value)) return [shape("sidecar.contentCheck must be an object carrying kind and command")];
	const defects = unknownFields$1(value, CONTENT_CHECK_FIELDS, "sidecar.contentCheck", "a content check carries kind, command");
	if (value.kind !== "command") defects.push(shape(`sidecar.contentCheck.kind ${described(value.kind)} is not one of command`));
	if (!nonBlank(value.command)) defects.push(shape("sidecar.contentCheck.command must be a non-blank string"));
	return defects;
}
/**
* Every reason one declared sidecar is not acceptable, in field order — never
* just the first, so one refusal names everything wrong with the declaration.
*/
function skillContractDefects(value) {
	if (!isPlainObject(value)) return [shape(`the sidecar must be a JSON object, got ${kindOf(value)}`)];
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
		if (!nonBlank(value.precondition)) defects.push(shape("sidecar.precondition must be a non-blank string"));
		defects.push(...portDefects(value.inputs, "sidecar.inputs"));
		defects.push(...portDefects(value.outputs, "sidecar.outputs"));
		defects.push(...nameListDefects(value.requiredTools, "sidecar.requiredTools", "sidecar.requiredTools must be an array of tool names", (name, index) => `sidecar.requiredTools[${index}] duplicates ${JSON.stringify(name)}`));
		defects.push(...verifierDefects(value.verifier));
		defects.push(...contentDefects$1(value.content));
		return defects;
	}
	defects.push(...unknownFields$1(value, KNOWLEDGE_FIELDS, "sidecar", `a knowledge sidecar carries ${KNOWLEDGE_FIELDS.join(", ")}`));
	if (!nonBlank(value.source)) defects.push(shape("sidecar.source must be a non-blank string"));
	if (!nonBlank(value.scope)) defects.push(shape("sidecar.scope must be a non-blank string"));
	defects.push(...contentDefects$1(value.content));
	defects.push(...contentCheckDefects(value.contentCheck));
	return defects;
}
/**
* The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
* declared data, so key order and `undefined`-valued keys do not move it while
*/
function skillContractDigest(sidecar) {
	return sha256Hex(canonicalize(sidecar));
}
/**
* The identity of one content identity: SHA-256 over {@link canonicalize} of the
* `SKILL.md` digest and the resource list. Separate from
*/
function skillContentDigest(content) {
	return sha256Hex(canonicalize(content));
}
/**
* The same declaration with one field replaced: `content.skillMdSha256`.
* A same-name improvement of an execution skill changes the `SKILL.md` and
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
*/
function capabilityToolQuery(capabilities) {
	return (capability) => {
		let manifest;
		try {
			manifest = resolveCapabilities([capability], capabilities);
		} catch (error) {
			return {
				known: false,
				reason: message(error)
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
*/
function executionProviders(verdicts) {
	return verdicts.filter((verdict) => verdict.valid && verdict.role === "execution-provider");
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
		defects.push(defect$1("content-unsupported", `${relative$1} cannot be read as a real file: ${message(error)}`));
		return;
	}
}
/**
* Walk one skill directory and describe it: which files sit at supported
* positions with their real digests, which direct entries the supported
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
		scanned.defects.push(defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message(error)}`));
		return scanned;
	}
	for (const entry of entries) {
		const name = entry.name;
		const at = join(directory, name);
		let info;
		try {
			info = await lstat(at);
		} catch (error) {
			scanned.defects.push(defect$1("content-unsupported", `${name} cannot be read: ${message(error)}`));
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
				/**
				* The name this file loads under, parsed by the same reader the spawn
				* uses (`readSkillFile`): a file declaring another name, or whose
				*/
				try {
					const parsed = parseSkillFile(bytes.toString("utf8"), join(directory, "SKILL.md"));
					scanned.frontmatter = {
						name: parsed.name,
						description: parsed.description
					};
				} catch (error) {
					scanned.defects.push(defect$1("skill-file-invalid", message(error)));
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
				scanned.defects.push(defect$1("content-unsupported", `${name}/ cannot be read: ${message(error)}`));
				continue;
			}
			for (const child of children) {
				const relative$1 = `${name}/${child.name}`;
				let childInfo;
				try {
					childInfo = await lstat(join(at, child.name));
				} catch (error) {
					scanned.unsupported.push(relative$1);
					scanned.defects.push(defect$1("content-unsupported", `${relative$1} cannot be read: ${message(error)}`));
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
*/
async function loadSkillSidecar(directory) {
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		return {
			directory,
			uncovered: [],
			defects: [defect$1("skill-missing", `skill directory ${directory} cannot be read: ${message(error)}`)]
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
		defects.push(defect$1("content-unsupported", `${SKILL_SIDECAR_FILE} cannot be read as a real file: ${message(error)}`));
	}
	if (sidecarBytes !== void 0) if (!isText(sidecarBytes)) defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not UTF-8 text`));
	else {
		let declared;
		try {
			declared = JSON.parse(sidecarBytes.toString("utf8"));
		} catch (error) {
			defects.push(defect$1("sidecar-unreadable", `${SKILL_SIDECAR_FILE} is not readable JSON: ${message(error)}`));
		}
		if (declared !== void 0) {
			const declaredDefects = skillContractDefects(declared);
			defects.push(...contractDefects$1(declaredDefects));
			if (declaredDefects.length === 0) {
				const sidecarValue = declared;
				sidecar = sidecarValue;
				/**
				* The declared identity against the bytes just read. A declaration is
				* only worth the directory it describes, so an undeclared file at a
				*/
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
	/**
	* The name the file declares, checked against the name the capability grants
	* with the spawn's own sentence. Directory naming and declared naming are two
	*/
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
			/**
			* The worker baseline is deliberately not part of the covering set: a
			* capability must grant what the provider it carries needs, and a run
			*/
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
//#region src/run-binding.ts
/** The directory under one run's own directory that holds its `<name>/SKILL.md` entries — a skill root as `WorkerGrant.skillRoots` expects. */
const RUN_BINDING_SKILLS_DIR = "skills";
/**
* Where run bindings are materialized unless the deployment says otherwise:
* `<DSH_HOME or ~/.dsh>/singularity/run-bindings`, resolved per call so a test
*/
function defaultRunBindingRoot() {
	return join(process.env.DSH_HOME !== void 0 && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"), "singularity", "run-bindings");
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
*/
function selectedProviders(providers, rows, declaredBy) {
	if (providers === void 0) return [];
	const accepted = /* @__PURE__ */ new Map();
	const refused = /* @__PURE__ */ new Map();
	for (const row of providers.capabilities) {
		if (!rows.includes(row.capability)) continue;
		/**
		* A row an open evolution commit intent moves was refused before it was
		* resolved (A6): its declared skills are refused with the row's own reason,
		*/
		if ((row.refusals ?? []).length > 0) {
			for (const name of declaredBy(row.capability)) refused.set(name, [...refused.get(name) ?? [], ...row.refusals]);
			continue;
		}
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
	return manifestMcpServers(manifest).map((serverName) => {
		const template = registry[serverName];
		/**
		* Canonical JSON, the same identity rule the registry revision and the task
		* contract use: a template edited in any way moves the digest, and a mere
		*/
		return {
			serverName,
			templateDigest: template === void 0 ? null : sha256Hex(canonicalize(template))
		};
	});
}
/**
* Copy one selected provider's admitted bytes into the run's snapshot.
* Every file is read through the verified walk (a link or a wrong type anywhere
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
			throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message(error)}`);
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
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message(error)}`);
	}
	let declared;
	try {
		declared = JSON.parse(sidecarBytes.toString("utf8"));
	} catch (error) {
		throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${SKILL_SIDECAR_FILE} is not readable JSON: ${message(error)}`);
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
		/**
		* The run's own directory is created exclusively: an existing one belongs to
		* a run that already bound (and is re-checked, never overwritten), or to
		*/
		await mkdir(runDirectory);
	} catch (error) {
		throw new Error(`run "${request.runId}" cannot bind content: ${runDirectory} already exists (${message(error)}); a run materializes once`);
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
		rootDefects.push(`${root} cannot be read: ${message(error)}; the content this run was bound to is not available`);
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
			/**
			* What a guidance skill's identity does *not* cover, re-read against the
			* snapshot: the loader names the directory's root entries outside its
			*/
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
//#region src/question.ts
/**
* The `m-` identity one question's message carries: derived from the question id,
* never minted. A retry — in this process or after a restart — states the same
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
*/
function parseCallArguments(body) {
	let parsed;
	try {
		parsed = JSON.parse(body.arguments);
	} catch (error) {
		throw new Error(`task-runtime: the arguments of the cited "${body.name}" call are not JSON (${message(error)}); a body that cannot be parsed is not a citation`);
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
* The Session comes from the caller's identity (its run binding), never from the
*/
async function readOwnCall(deps, callerSessionId, callId, toolName) {
	if (callId.length === 0) throw new Error(`task-runtime: ${toolName} needs the registration id of its own call to cite its body`);
	let log;
	try {
		log = await deps.sessionQuery.readSession(SessionId(callerSessionId));
	} catch (error) {
		throw new Error(`task-runtime: ${toolName} cannot read session "${callerSessionId}" to locate its own call "${callId}": ${message(error)}`, { cause: error });
	}
	const ref = toolCallRefIn(log, callId);
	if (ref === void 0) throw new Error(`task-runtime: session "${callerSessionId}" holds no tool/call "${callId}"; ${toolName} cites the call it is answering for, and a caller cannot cite somebody else's call or a call that was never made`);
	let body;
	try {
		body = await deps.messages.readToolCallBody(ref);
	} catch (error) {
		throw new Error(`task-runtime: ${toolName} could not read back the body of its own call "${callId}" (${message(error)})`, { cause: error });
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
*/
async function recordedText(deps, ref, field, where) {
	let body;
	try {
		body = await deps.messages.readToolCallBody({
			sessionId: SessionId(ref.sessionId),
			seq: ref.seq
		});
	} catch (error) {
		throw new Error(`task-runtime: the recorded body of ${where} could not be read from session "${ref.sessionId}" seq ${ref.seq}: ${message(error)}`, { cause: error });
	}
	return requiredString(parseCallArguments(body), field, `the recorded ${where}`);
}
/**
* Compose and deliver one recorded message, reporting rather than throwing: by
* this point the store's record is durable, so a delivery that cannot be decided
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
			reason: message(error)
		};
	}
}
/**
* The run one id names, or a refusal: every caller here reads a fact whose run
* the store has already checked, so a missing one is a defect of the snapshot,
*/
function runOf(snapshot, runId, where) {
	const run = snapshot.runs.find((candidate) => candidate.runId === runId);
	if (run === void 0) throw new Error(`task-runtime: ${where} names run "${runId}", which the store's snapshot does not hold`);
	return run;
}
/**
* Ask one's direct parent (A4 §F.1): the `task_ask_parent` entry's whole effect.
* Read the body → commit the intent → recompute the block → deliver under the
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
* The answering run is the caller's own — the store refuses an answer from any
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
* Reconcile the deliveries one store's question facts still owe (§F.1's crash
* recovery): read each pending body from its *recorded* citation, then hand the
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
				reason: message(error)
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
*/
function releaseAskingSessions(gate$1, snapshot, settledRunId) {
	const index = snapshot.questions;
	/**
	* A snapshot without a question index cannot answer "what asked this run", and
	* a settlement must not fail on that: the store's own facts are unchanged, and
	*/
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
		/**
		* Only a changed value is worth a decision: the gate's token is what drops a
		* store-derived value read concurrently, and re-pushing the state a session
		*/
		if (gate$1.questionsBlocked(sessionId) !== blocked) gate$1.setQuestionsBlocked(sessionId, blocked);
	}
}
/**
* Push the question block every run in one snapshot implies onto the gate, under
* the gate's own token rule — the recovery pass's half of §F.1's "restart from
*/
function applyStoreQuestionBlocking(gate$1, snapshot, tokenOf) {
	for (const run of snapshot.runs) gate$1.applyStoreQuestionsBlocked(run.sessionId, blockingQuestionsOf(snapshot, run.runId).length > 0, tokenOf(run.sessionId));
}
/**
* Whether one run still owes or waits for coordination: no unresolved blocking
* question of its own, and no question of a child's it has not answered. The
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
/**
* Resolve a checkout path the way ownership keys it: absolute, with symbolic
* links resolved, so the two spellings of one directory cannot become two
*/
async function normalizeWorkspacePath(path) {
	try {
		return await realpath(resolve(path));
	} catch (error) {
		throw new Error(`workspace ${path} cannot be resolved to a real path: ${message(error)}`);
	}
}
/**
* The kernel's start-time token for `pid`, or `undefined` when it cannot be read
* (a non-Linux platform, a pid that is gone, a process this user may not stat).
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
			reason: `${file} is not readable JSON (${message(error)}); an unreadable marker is not evidence that a workspace is free`
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
	*/
	markerWrites = /* @__PURE__ */ new Map();
	constructor(options) {
		this.markerRoot = options.markerRoot;
		this.pid = options.pid ?? process.pid;
	}
	/** Queue one marker mutation after the ones this workspace already has in flight, in call order. */
	queueMarkerMutation(workspace, mutate) {
		return enqueueByKey(this.markerWrites, workspace, mutate);
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
			/**
			* The owner this release leaves behind is captured here, where the stack
			* has just said it — a mutation that ran later would read whatever holder
			*/
			const remaining = held[held.length - 1];
			await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, remaining));
		}
	}
	/**
	* Take over a marker whose owning process is gone — the recovery path only,
	* and the only way a stale marker is ever cleared. An absent marker is a
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
				reason: `${file} cannot be read (${message(error)}); an unreadable marker is not evidence that a workspace is free`
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
		/**
		* The token describes the pid the marker names — this process, unless a test
		* injected another pid — so a reader can compare it with the live process at
		*/
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
//#region src/config.ts
const DEFAULT_VERIFY_TIMEOUT_MS = 600 * 1e3;
const DEFAULT_BUDGET = {
	maxToolCalls: 150,
	attempts: 1
};
const DEFAULT_GENERATED_TASK_REVIEW = "off";
const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 3e4;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_CHILDREN = 8;
const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true;
/** The shipped supervision policy (A7 §1): every terminal review diagnosed, three recovery rounds, two improvement rounds, eight coordination runs. */
const DEFAULT_SUPERVISION = {
	autoReview: "all",
	maxRecoveryRounds: 3,
	maxImprovementRounds: 2,
	coordinationBudget: 8
};
const Capability = z.object({
	skills: z.array(z.string()),
	tools: z.array(z.string()),
	preset: z.string(),
	permission: z.string(),
	mcpServers: z.array(z.string())
});
const RootBudget = z.object({
	maxRuns: z.number(),
	maxConcurrentWrites: z.number()
});
const Supervision = z.object({
	autoReview: z.union([
		z.const("all"),
		z.const("failed"),
		z.const("off")
	]).default(DEFAULT_SUPERVISION.autoReview),
	maxRecoveryRounds: z.number().default(DEFAULT_SUPERVISION.maxRecoveryRounds),
	maxImprovementRounds: z.number().default(DEFAULT_SUPERVISION.maxImprovementRounds),
	coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget)
});
const ConfigSchema = z.object({
	capabilities: z.dict(Capability).default({}),
	defaultPreset: z.string(),
	verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS),
	maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
	maxChildren: z.number().default(DEFAULT_MAX_CHILDREN),
	budget: z.object({
		maxToolCalls: z.number(),
		tokens: z.number(),
		attempts: z.number()
	}).default({ ...DEFAULT_BUDGET }),
	allowRuntimeDecomposition: z.boolean().default(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION),
	generatedTaskReview: z.union([z.const("off"), z.const("all")]).default(DEFAULT_GENERATED_TASK_REVIEW),
	supervision: Supervision.default({ ...DEFAULT_SUPERVISION }),
	rootBudget: RootBudget,
	writeDrainTimeoutMs: z.number().default(DEFAULT_WRITE_DRAIN_TIMEOUT_MS)
});

//#endregion
//#region src/provider-precheck.ts
/**
* Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
* the soft pattern this repo uses for services a deployment may or may not
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
*/
async function registeredVerifierIds(host) {
	return (await registeredVerifierVocabulary(host))?.ids;
}
/**
* The registered verifier vocabulary *and the version each instance declares*,
* or `undefined` under exactly the conditions {@link registeredVerifierIds}
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
*/
async function readCommitGate(ledger) {
	if (ledger === void 0) return void 0;
	if (ledger.openIntentTargets === void 0) return {
		openTargets: /* @__PURE__ */ new Set(),
		openCapabilities: /* @__PURE__ */ new Set(),
		unreadable: "the evolution service offers no openIntentTargets() read"
	};
	if (ledger.openIntentCapabilities === void 0) return {
		openTargets: /* @__PURE__ */ new Set(),
		openCapabilities: /* @__PURE__ */ new Set(),
		unreadable: "the evolution service offers no openIntentCapabilities() read"
	};
	try {
		const [targets, capabilities] = await Promise.all([ledger.openIntentTargets(), ledger.openIntentCapabilities()]);
		return {
			openTargets: new Set(targets.map((target) => dirname(resolve(target)))),
			openCapabilities: new Set(capabilities)
		};
	} catch (error) {
		return {
			openTargets: /* @__PURE__ */ new Set(),
			openCapabilities: /* @__PURE__ */ new Set(),
			unreadable: `reading it failed (${message(error)})`
		};
	}
}
/**
* The refusal of a provider whose directory a commit left open (K2-3, matched by
* directory since K3): the intent is the record that a production write is
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
* The refusal of one capability **row** an open evolution commit intent moves
* (A6): row-keyed, not directory-keyed, because a row-only capability commit has
*/
function openCapabilityRowRefusal(name) {
	return defect("commit-intent-open", `capability "${name}" is the target of an open evolution commit intent: an apply or rollback persisted that intent and never recorded its completion, so the row the deployment's table reads now may not be the row it keeps — a capability commit installs the row in the process before it writes the deployment's own table file, and the completion is what claims both halves landed. The row is refused whole rather than admitted as a half-product: it stays refused until a reconciliation settles that commit (the deployment reconciles at startup, or an apply/rollback retry settles it)`);
}
/**
* The refusal of every skill candidate on a deployment whose evolution ledger
* cannot be read: whether a commit intent is open against this provider cannot
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
*/
function commitRefusalFor(gate$1, name, directory) {
	if (gate$1 === void 0) return void 0;
	const skillFile = resolve(join(directory, "SKILL.md"));
	if (gate$1.unreadable !== void 0) return unreadableCommitLedgerRefusal(name, directory, skillFile, gate$1.unreadable);
	if (!gate$1.openTargets.has(resolve(directory))) return void 0;
	return openCommitRefusal(name, directory);
}
/**
* The row-keyed half of that same gate (A6): the defects one capability row owes
* because an open commit intent moves it, or `[]` when none does. It is asked
*/
function capabilityRowRefusals(gate$1, capability) {
	if (gate$1 === void 0) return [];
	if (!gate$1.openCapabilities.has(capability)) return [];
	return [openCapabilityRowRefusal(capability)];
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
*/
function providerContentIdentities(capabilities) {
	return capabilities.flatMap((row) => row.skills).flatMap((verdict) => providerIdentity(verdict) ?? []).filter((identity, index, all) => all.findIndex((entry) => entry.name === identity.name) === index).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
/**
* Check every skill every listed capability declares, from one discovery
* viewpoint.
*/
async function precheckProviders(request) {
	const roots = await skillSearchRoots(request.view);
	const verifierRefs = request.verifierRefs;
	const context = skillValidationContext(request.table, verifierRefs ?? []);
	const commitGate = await readCommitGate(request.commitLedger);
	const capabilities = [];
	for (const capability of request.capabilities) {
		/**
		* A6, and first: a row an open commit intent moves is refused whole. It is
		* not resolved — no skill verdict is taken, no revision absorbs it — because
		*/
		const rowRefusals = capabilityRowRefusals(commitGate, capability);
		if (rowRefusals.length > 0) {
			capabilities.push({
				capability,
				skills: [],
				refusals: rowRefusals
			});
			continue;
		}
		const declared = request.table[capability]?.skills ?? [];
		const skills = [];
		for (const name of [...new Set(declared)]) {
			const file = await findSkillFileIn(roots, name);
			if (file === void 0) {
				skills.push(undiscovered(name, roots));
				continue;
			}
			const directory = dirname(file);
			/**
			* K2-3: a commit that left its intent behind owns this directory — the
			* whole fixed file set of the skill — until a reconciliation settles it.
			*/
			const commitRefusal = commitRefusalFor(commitGate, name, directory);
			if (commitRefusal !== void 0) {
				skills.push(commitRefusal);
				continue;
			}
			if (verifierRefs === void 0) {
				/**
				* The registry cannot be listed, so `ref` cannot be proved registered.
				* Only an execution sidecar loses anything by that: a knowledge or
				*/
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
*/
function refusalHead(capability, verdict) {
	const where = verdict.directory === void 0 ? "" : ` (found at ${verdict.directory})`;
	return `capability ${JSON.stringify(capability)} skill ${JSON.stringify(verdict.name)}${where}`;
}
/** Every refusal of one pre-check: row-level refusals first, then one entry per refused provider. */
function precheckRefusals(precheck) {
	return precheck.capabilities.flatMap((row) => [...(row.refusals ?? []).map((item) => ({
		head: `capability ${JSON.stringify(row.capability)}`,
		defects: [item]
	})), ...row.skills.filter((verdict) => !verdict.valid).map((verdict) => ({
		head: refusalHead(row.capability, verdict),
		defects: verdict.defects
	}))]);
}
/**
* Every refused provider of one pre-check, one line each, naming the capability
* that declares it, the skill, the directory when one was found, and every
*/
function providerRefusals(precheck) {
	return precheckRefusals(precheck).map((entry) => `${entry.head}: ${entry.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")}`);
}
/**
* The same refusals, one line per defect: the shape a loud report wants, since
* a caller reading a log needs the capability, the skill, the defect code and
*/
function providerDefectLines(precheck) {
	return precheckRefusals(precheck).flatMap((entry) => entry.defects.map((item) => `${entry.head}: ${item.code}: ${item.detail}`));
}

//#endregion
//#region src/service/lifecycle.ts
function assertClosedRootBudget(budget$1) {
	if (budget$1 === void 0) return;
	const known = new Set(["maxRuns", "maxConcurrentWrites"]);
	const unknown = Object.keys(budget$1).filter((key) => !known.has(key));
	if (unknown.length === 0) return;
	throw new Error(`task-runtime: rootBudget names [${unknown.join(", ")}], which this deployment does not enforce; a hard limit that cannot be executed refuses to start rather than running under a promise nobody keeps`);
}
function assertGeneratedTaskReview(policy) {
	if (policy === void 0 || policy === "off" || policy === "all") return;
	throw new Error(`task-runtime: generatedTaskReview is ${JSON.stringify(policy)}; the review policy is "off" or "all" (§5 defines no other mode, and a policy this build cannot execute refuses to start rather than admitting unreviewed batches)`);
}
/** Refuse a supervision policy this build cannot read: an unread member is a typo, and a cap is a whole count at or above zero. */
function assertSupervisionConfig(policy) {
	if (policy === void 0) return;
	if (policy === null || typeof policy !== "object" || Array.isArray(policy)) throw new Error("task-runtime: supervision must be an object with the review policy's members");
	const known = new Set([
		"autoReview",
		"maxRecoveryRounds",
		"maxImprovementRounds",
		"coordinationBudget"
	]);
	const unknown = Object.keys(policy).filter((key) => !known.has(key));
	if (unknown.length > 0) throw new Error(`task-runtime: supervision names [${unknown.join(", ")}], which this policy does not declare; a member nobody reads refuses to start rather than being silently ignored`);
	const record = policy;
	if (record.autoReview !== void 0 && ![
		"all",
		"failed",
		"off"
	].includes(record.autoReview)) throw new Error(`task-runtime: supervision.autoReview is ${JSON.stringify(record.autoReview)}; it is "all", "failed" or "off"`);
	for (const name of [
		"maxRecoveryRounds",
		"maxImprovementRounds",
		"coordinationBudget"
	]) {
		const value = record[name];
		if (value === void 0) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value < (name === "coordinationBudget" ? 1 : 0)) throw new Error(`task-runtime: supervision.${name} is ${JSON.stringify(value)}; it must be a whole ${name === "coordinationBudget" ? "count of at least 1" : "count of at least 0"}`);
	}
}
/**
* The policy in force: the `singularitySupervision` service a deployment exposes (the way `singularityEvolution` carries
* the chain switch) over this plugin's own config, per member; a value that is not a usable count reads as its default.
*/
function supervisionSettings(self) {
	const provided = self.softService("singularitySupervision");
	const configured = self.config.supervision;
	const whole = (value, fallback, floor) => typeof value === "number" && Number.isFinite(value) && value >= floor ? Math.floor(value) : fallback;
	const autoReview = (value) => value === "all" || value === "failed" || value === "off" ? value : void 0;
	return {
		autoReview: autoReview(provided?.autoReview) ?? autoReview(configured?.autoReview) ?? DEFAULT_SUPERVISION.autoReview,
		maxRecoveryRounds: whole(provided?.maxRecoveryRounds, whole(configured?.maxRecoveryRounds, DEFAULT_SUPERVISION.maxRecoveryRounds, 0), 0),
		maxImprovementRounds: whole(provided?.maxImprovementRounds, whole(configured?.maxImprovementRounds, DEFAULT_SUPERVISION.maxImprovementRounds, 0), 0),
		coordinationBudget: whole(provided?.coordinationBudget, whole(configured?.coordinationBudget, DEFAULT_SUPERVISION.coordinationBudget, 1), 1)
	};
}
async function unload(self) {
	/**
	* The unload invalidates every recovery handle first (A2 §E): a driver
	* parked behind a barrier would otherwise hold the await below on a
	*/
	for (const storeId of [...self.storeRecovery.keys()]) self.invalidateStoreRecovery(storeId);
	self.storeRecovery.clear();
	const entries = [...self.drivers.values()];
	for (const entry of entries) entry.controller.abort();
	await Promise.all(entries.map((entry) => entry.promise.catch((error) => {
		warn(self, `unload: a driver did not settle cleanly (${message(error)})`);
		return [];
	})));
	self.drivers.clear();
	for (const sessionId of self.startedSessions) self.executionGate.setTerminal(sessionId);
	try {
		await self.workspaces.close();
	} catch (error) {
		warn(self, `unload: workspace markers could not be released (${message(error)})`);
	}
}
async function serviceInit(self) {
	await providerLoadReport(self);
	/**
	* The tool-execution gate's wiring (A3 §3.3): one decision per call before
	* anything runs, one settle per call when its result arrives. Both are
	*/
	self.context.effect(() => {
		const offPre = self.context.on("tools/pre-execute", async (exec, next) => {
			const sessionId = exec.agent?.id;
			if (sessionId === void 0) return await next();
			const decision = self.executionGate.decide(String(sessionId), exec.name);
			if (!decision.allow) return {
				kind: "deny",
				reason: decision.reason
			};
			self.executionGate.trackAllowed(String(sessionId), String(exec.callId), exec.name);
			return await next();
		}, { prepend: true });
		const offResult = self.context.on("tools/result", (exec) => {
			self.executionGate.settled(String(exec.callId));
		});
		return () => {
			if (typeof offPre === "function") offPre();
			if (typeof offResult === "function") offResult();
		};
	});
}
async function providerLoadReport(self) {
	self.providerLoad ??= scanConfiguredProviders(self);
	return self.providerLoad;
}
async function scanConfiguredProviders(self) {
	let report;
	try {
		const precheck = await self.providerPrecheck(Object.keys(self.config.capabilities), { cwd: process.cwd() });
		report = {
			precheck,
			defects: providerDefectLines(precheck)
		};
	} catch (error) {
		report = {
			defects: [],
			failed: message(error)
		};
	}
	reportProviderLoad(self, report);
	return report;
}
function reportProviderLoad(self, report) {
	const roots = report.precheck?.roots ?? [];
	if (report.failed !== void 0) {
		warn(self, `config load: the capability provider scan could not run (${report.failed}); the deployment starts, and admission still refuses a batch whose provider cannot be judged`);
		return;
	}
	if (report.defects.length === 0) return;
	warn(self, `config load: ${report.defects.length} provider defect${report.defects.length === 1 ? "" : "s"} in the effective capability table (roots: ${roots.join(", ")}); reported, not enforced — this process's own roots are not the worker's, so a skill reachable from a run's checkout may legitimately be missing here. Admission refuses a batch that names one of these.`);
	for (const line of report.defects) warn(self, `config load: ${line}`);
}
function warn(self, message$1) {
	const logger = self.context.logger;
	logger?.("task-runtime").warn(message$1);
}
function verifyTimeoutMs(self) {
	return self.config.verifyTimeoutMs;
}
function budget(self) {
	return { ...self.config.budget };
}
function generatedTaskReview(self) {
	return self.config.generatedTaskReview;
}
function gate(self) {
	return self.executionGate;
}
function resolveCapabilitiesImpl(self, required) {
	return resolveCapabilities(required, self.config.capabilities);
}
function listCapabilities(self) {
	return structuredClone(self.config.capabilities);
}
async function applyCapabilityRow(self, name, entry, options = {}) {
	if (entry === null) {
		const rest = { ...self.config.capabilities };
		delete rest[name];
		self.config.capabilities = rest;
		return;
	}
	await assertReplacementRow(self, name, entry, options);
	self.config.capabilities = {
		...self.config.capabilities,
		[name]: structuredClone(entry)
	};
}
async function assertReplacementRow(self, name, entry, options = {}) {
	const verifierRefs = await self.registeredVerifierIds();
	const ledger = self.softService("evolution");
	const owned = new Set((options.commitTargets ?? []).map((target) => dirname(resolve(target))));
	const exemptRow = options.commitRow;
	const commitLedger = ledger === void 0 || owned.size === 0 && exemptRow === void 0 ? ledger : {
		...ledger.openIntentTargets === void 0 ? {} : { openIntentTargets: async () => (await ledger.openIntentTargets()).filter((target) => !owned.has(dirname(resolve(target)))) },
		...ledger.openIntentCapabilities === void 0 ? {} : { openIntentCapabilities: async () => (await ledger.openIntentCapabilities()).filter((row) => row !== exemptRow) }
	};
	const { refusals } = await precheckReplacedCapabilityRow({
		name,
		entry,
		table: self.config.capabilities,
		view: { cwd: process.cwd() },
		...verifierRefs === void 0 ? {} : { verifierRefs },
		...commitLedger === void 0 ? {} : { commitLedger }
	});
	if (refusals.length === 0) return;
	throw new Error(`task-runtime: capability "${name}" was not replaced — the row grants providers that are not usable:\n` + refusals.map((line) => `- ${line}`).join("\n"));
}

//#endregion
//#region src/protected-inputs.ts
/**
* The authoring form of one criterion's declaration: a non-empty array of
* non-blank strings, in the order the caller wrote them.
*/
function declaredPaths(value) {
	if (!Array.isArray(value) || value.length === 0) return [];
	return value.every((item) => nonBlank(item)) ? [...value] : [];
}
/**
* The label one criterion is reported under: the declared id when it has one,
* its position otherwise — the vocabulary `normalize.ts` names criteria with,
*/
function criterionLabel(childLabel$1, criterion, index) {
	return `${childLabel$1} criterion ${nonBlank(criterion.criterionId) ? JSON.stringify(criterion.criterionId) : index + 1}`;
}
/**
* Fix the byte identity of every declared protected input, against the
* checkout directory the criterion's judge will run in.
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
			reasons.push(`${label} protectedInputs path ${JSON.stringify(path)} cannot be read: ${message(error)}`);
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
*/
async function fixCriteriaProtectedInputs(criteria, cwd, label) {
	const reasons = [];
	/**
	* A criterion list that is not an array is a shape defect whichever entry
	* wrote it (`contractDefects` names it); carrying it here keeps the refusal
	*/
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
		/**
		* The fixed form is the runtime's own normalized shape, which the declared
		* type cannot express (`CriterionSpec` declares paths): the cast is the
		*/
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
*/
async function fixSpecProtectedInputs(spec, cwd) {
	const reasons = [];
	/**
	* The spec's own shape is normalization's rule, not this walk's: a proposal
	* whose `children` (or a child's `acceptanceCriteria`) is not an array is
	*/
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
			if (!isPlainObject(entry)) {
				reasons.push(`${at} must be an object with only path and sha256`);
				return;
			}
			for (const key of unknownFieldKeys(entry, ["path", "sha256"])) reasons.push(`${at} declares unknown field ${JSON.stringify(key)}`);
			if (!nonBlank(entry.path)) reasons.push(`${at} path must be a non-empty string`);
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
			/**
			* Only the composite verifier reads the map, and a heuristic judgement
			* is never a mechanical check: a map on any other judge, or beside a
			*/
			if (map.length > 0 && criterion.verificationMode !== "composite") reasons.push(`${where} childEvidence requires verificationMode "composite" (the composite verifier is its only judge)`);
			if (map.length > 0 && criterion.heuristic === true) reasons.push(`${where} cannot be both heuristic and carry a childEvidence map: a heuristic judgement is never a mechanical check`);
		}
	}
	/**
	* The contract-level marker is a promise that acceptance rests on the task's
	* own evidence map. A missing, empty, or deleted map must refuse loudly —
	*/
	if (requiresIndependentAcceptance === true && !criteria.some((criterion) => (criterion.childEvidence?.length ?? 0) > 0)) reasons.push(`${label} requires independent parent acceptance but no acceptance criterion carries a childEvidence map (the composite conjunction alone cannot stand in for the root goal)`);
	return reasons;
}
/**
* The one structural rule a **root contract** owes on top of
* {@link contractDefects} (A0 §1.2): at least one mandatory criterion whose
*/
function rootIndependenceDefects(criteria, label) {
	if (criteria.some((criterion) => criterion.mandatory === true && criterion.verificationMode !== "composite")) return [];
	return [`${label} requires at least one mandatory acceptance criterion judged by something other than the composite conjunction (verificationMode !== "composite"): a root whose only mandatory criterion is "all children verified" is satisfied by its own decomposition and has no independent check of the goal it was given`];
}
/**
* Whether a criterion declares a command a verifier could actually run. A
* declared command that is blank — or not text at all — is as missing as an
*/
function hasCommand(command) {
	return typeof command === "string" && command.trim().length > 0;
}
/**
* Structural defects of one task's acceptance contract (T1, construction guide
* §4): what has to hold before a contract can be admitted at all, whichever
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
		/**
		* Duplicates are refused before the batch is persisted, not at acceptance:
		* a verdict names its criterion by id, so two criteria sharing one id make
		*/
		if (seen.has(criterion.criterionId) && !reportedDuplicate.has(criterion.criterionId)) {
			reasons.push(`${label} declares criterion id "${criterion.criterionId}" more than once`);
			reportedDuplicate.add(criterion.criterionId);
		}
		seen.add(criterion.criterionId);
		/**
		* The fixed form of a criterion's protected acceptance inputs (S1-V slice
		* 2): the same rule for an ordinary decomposition child and for a replay
		*/
		reasons.push(...protectedInputDefects([criterion], label));
	}
	if (!criteria.some((criterion) => criterion.mandatory === true)) reasons.push(`${label} requires at least one mandatory acceptance criterion`);
	return reasons;
}
/**
* How one planned child is named in a refusal: its position always, its id when
* the batch has one yet ({@link AdmissionChild.taskId}). A batch is judged
*/
function childLabel(child, index) {
	return child.taskId === void 0 ? `child ${index}` : `child ${index} ("${child.taskId}")`;
}
/**
* How one planned child is named inside a dependency message: its id when it
* has one, its batch position otherwise (`#0` is the first child). The two
*/
function childRef(child, index) {
	return child?.taskId ?? `#${index}`;
}
/**
* Structural admission checks for one decomposition batch (RFC §36). Pure:
* every rule is validated up front and the caller persists only when the
*/
function checkDecomposition(parent, children, existingEdges) {
	const reasons = [];
	const policy = parent.decompositionPolicy;
	if (!policy.allowed) reasons.push(policy.leaf === true ? `task "${parent.taskId}" decomposition is not allowed: it is admitted as leaf and runtime decomposition is off (allowRuntimeDecomposition: false), so only a task admitted decomposable may split` : `task "${parent.taskId}" decomposition is not allowed`);
	if (policy.maxDepth !== void 0 && parent.depth + 1 > policy.maxDepth) reasons.push(`task "${parent.taskId}" children would exceed maxDepth ${policy.maxDepth} (depth ${parent.depth + 1})`);
	if (policy.maxChildren !== void 0 && children.length > policy.maxChildren) reasons.push(`task "${parent.taskId}" would have ${children.length} children, above maxChildren ${policy.maxChildren}`);
	if (children.length === 0) reasons.push(`task "${parent.taskId}" decomposition requires at least one child`);
	/**
	* The parent's own parent-acceptance declarations (P4): a stored task's
	* criteria are immutable, so the marker-plus-map rule is re-checked here on
	*/
	reasons.push(...independentAcceptanceDefects(parent.acceptanceCriteria, parent.requiresIndependentAcceptance, `task "${parent.taskId}"`));
	const plannedEdges = [];
	children.forEach((child, index) => {
		const label = childLabel(child, index);
		if (child.objective.trim().length === 0) reasons.push(`${label} objective must be non-empty`);
		/**
		* Two separate judgements, both required: the contract's own structure
		* ({@link contractDefects}, shared with the replay path) and the P4
		*/
		reasons.push(...contractDefects(child.acceptanceCriteria, label));
		reasons.push(...independentAcceptanceDefects(child.acceptanceCriteria, child.requiresIndependentAcceptance, label));
		for (const criterion of child.acceptanceCriteria) {
			/**
			* `requiresArtifact` gets a shape check here and nothing more: whether the
			* named artifact exists is a spawn-time question (it needs the store
			*/
			if (criterion.requiresArtifact !== void 0 && (!Array.isArray(criterion.requiresArtifact) || criterion.requiresArtifact.some((ref) => typeof ref !== "string" || ref.trim().length === 0))) reasons.push(`${label} criterion "${criterion.criterionId}" requiresArtifact must be an array of non-empty strings`);
			/**
			* `verifierRef` gets a shape check here and nothing more: whether the id
			* is registered is a batch-level question (it needs the verifier
			*/
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
//#region src/normalize.ts
/**
* The identity one batch is digested over (§4): where it came from, which
* contract language it is written in, the caller's reason, and the complete
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
/** A declared version value, rendered so a non-number cannot read like a number (`"1"` is not `1`). */
function declaredText(value) {
	return typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);
}
/**
* A deep copy of declared contract data: primitives are immutable, arrays and
* plain objects are rebuilt, so a caller mutating its input afterwards cannot
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
	for (const key of unknownFieldKeys(source, allowed)) reasons.push(`${label} declares unknown field ${JSON.stringify(key)}`);
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
*/
function carried(value) {
	return copyValue(value);
}
/**
* One criterion list. Ids are fixed here — a declared id verbatim, an absent
* one from `idOf` — because the digest must not depend on spellings and because
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
	/**
	* The objective is stored byte-for-byte: a blank one is refused (nothing can
	* be verified against it) and a padded one keeps its padding — the contract
	*/
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
* Returns every defect it found, never the first: a caller revising a proposal
*/
function normalizeDecomposition(spec, context) {
	const reasons = [];
	if (!isPlainObject(spec)) return {
		ok: false,
		reasons: ["decomposition must be an object with a reason and a children array"]
	};
	unknownFields(spec, BATCH_FIELDS, "decomposition", reasons);
	/**
	* The version gate: absent is the legacy adapter (this build's version is the
	* one the runtime writes), declared must be a version whose field semantics
	*/
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
		/**
		* `canonicalize` refuses values JSON cannot round-trip (functions, symbols,
		* `NaN`, class instances): no digest of such a proposal could be compared
		*/
		return {
			ok: false,
			reasons: [`decomposition content cannot be canonicalized: ${message(error)}`]
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
*/
function rootCriterionId(index) {
	return `ac-${index + 1}`;
}
/**
* Normalize one root contract (A0 §2–§3): the caller's single contract —
* objective, criteria, assumptions, constraints, declared capabilities — in,
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
*/
function requestKeyOf(payload) {
	return `${PROPOSAL_REQUEST_KEY_PREFIX}${sha256Hex(canonicalize(payload))}`;
}
function proposalRequestKey(context) {
	return requestKeyOf({
		parentTaskId: context.parentTaskId,
		parentRunId: context.parentRunId,
		callerSessionId: context.callerSessionId,
		proposalDigest: context.proposalDigest
	});
}
/**
* The request key one root intake derives when its caller named none: `rk-` plus
* the SHA-256 of {@link canonicalize} over {@link RootRequestKeyContext}.
*/
function rootProposalRequestKey(context) {
	return requestKeyOf({
		storeId: context.storeId,
		rootSessionId: context.rootSessionId,
		contractDigest: context.contractDigest
	});
}
/**
* The statuses in which a proposal is still "in flight" for the task that made
* it — submitted and not yet admitted, not yet decided, or decided and not yet
*/
const OPEN_PROPOSAL_STATUSES = [
	"ready",
	"pending_review",
	"approved"
];
/**
* Whether one proposal is still in flight for the task that made it —
* submitted and not yet admitted, not yet decided, or decided and not yet
*/
function isOpenProposal(proposal) {
	return OPEN_PROPOSAL_STATUSES.includes(proposal.status);
}
/**
* The open proposal of one run, or `undefined` — §7.4's "已知等待": a run whose
* own batch is waiting for a review (or for the admission its approval
*/
function openProposalOf(snapshot, taskId, runId) {
	const proposals = (snapshot.proposals?.byParentTask[taskId] ?? []).filter((proposal) => proposal.kind !== "root" && proposal.identity.parentRunId === runId && OPEN_PROPOSAL_STATUSES.includes(proposal.status));
	return proposals[proposals.length - 1];
}
/**
* What a batch was reviewed against (§6), as this runtime can compute it.
* Two parts, and each has a stated boundary:
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
//#region src/orchestration/types.ts
/** Raised when the verifier service (ticket C2) is not loaded in the context. */
var VerifierUnavailableError = class extends Error {
	name = "VerifierUnavailableError";
};
/** Raised when the deployment cannot observe a run's terminal state, so no honest settlement is possible. */
var RunWatcherUnavailableError = class extends Error {
	name = "RunWatcherUnavailableError";
};

//#endregion
//#region src/service/root-intake.ts
async function adoptRoot(self, storeId, rootSessionId) {
	/**
	* The barrier already in flight for this store is the one to wait for: the
	* join is the dedupe, so two explicit entries cannot run two recovery
	*/
	const inflight = self.storeRecovery.get(storeId);
	if (inflight !== void 0 && (inflight.status === "recovering" || inflight.status === "ready")) {
		await inflight.promise;
		const settledStatus = (state$1) => state$1.status;
		if (self.storeRecovery.get(storeId) === inflight && settledStatus(inflight) === "failed") throw inflight.failure;
		return inflight.adoption;
	}
	let complete;
	const completed = new Promise((resolve$1) => {
		complete = resolve$1;
	});
	let release;
	const released = new Promise((resolve$1) => {
		release = resolve$1;
	});
	const state = {
		status: "recovering",
		promise: completed,
		release,
		released,
		pendingDrivers: [],
		pendingNotices: [],
		wokenSessions: /* @__PURE__ */ new Set(),
		pendingBatchResults: []
	};
	self.storeRecovery.set(storeId, state);
	try {
		const adoption = await adoptRootThroughBarrier(self, storeId, rootSessionId);
		state.adoption = adoption;
		await self.initializeStoreGates(storeId);
		if (state.cancelled)
 /**
		* A cancellation or the unload invalidated this barrier: it finished
		* its pass into a store that cancellation owns, so it leaves no ready
		*/
		self.storeRecovery.delete(storeId);
		else state.status = "ready";
		/**
		* The wakes this barrier deferred run now and only now: the gates are in
		* place and the store is `ready`, so the first request each one starts is
		*/
		const deferred = state.pendingQuestionDelivery;
		state.pendingQuestionDelivery = void 0;
		if (!state.cancelled) {
			if (deferred !== void 0) await deferred();
			for (const result of state.pendingBatchResults.splice(0)) await self.deliverBatchResultNow(result);
			while (state.pendingNotices.length > 0) {
				const notice = state.pendingNotices[0];
				if (state.wokenSessions.has(notice.sessionId)) {
					state.pendingNotices.shift();
					continue;
				}
				self.notify(notice.sessionId, notice.text);
				state.pendingNotices.shift();
			}
		}
		/**
		* The drivers start only now — after the facts, the gates and the
		* registrations are settled. The barrier never waits for what they do;
		*/
		state.pendingDrivers.length = 0;
		release(!state.cancelled);
		return adoption;
	} catch (error) {
		state.status = "failed";
		state.reason = message(error);
		state.failure = error;
		/**
		* The failed barrier's deferred wake is dropped with it: a store that never
		* reached `ready` wakes no model, and the record keeps the intents for the
		*/
		state.pendingQuestionDelivery = void 0;
		for (const notice of state.pendingNotices) self.startedSessions.delete(notice.sessionId);
		state.pendingNotices.length = 0;
		state.wokenSessions.clear();
		state.pendingBatchResults.length = 0;
		/**
		* Not-started is not executed (A2 §E): the drivers this barrier
		* registered are aborted and removed, nothing is written on their behalf,
		*/
		self.standDownPendingDrivers(state);
		release(false);
		try {
			await self.releaseStoreWorkspace(storeId);
		} catch (cleanup) {
			self.warn(`store ${storeId}: its workspace could not be released after a failed recovery (${message(cleanup)})`);
		}
		throw error;
	} finally {
		complete();
	}
}
async function reconcileEvolutionCommits(self) {
	const evolution = self.softService("evolution");
	if (evolution?.reconcile === void 0) return;
	let outcomes;
	try {
		outcomes = await evolution.reconcile();
	} catch (error) {
		throw new Error(`task-runtime: the evolution ledger could not be reconciled before this store was recovered (${message(error)}); the recovery barrier fails rather than taking a store over while an unsettled production commit may stand behind it`);
	}
	for (const outcome of outcomes) {
		if (outcome.result !== "blocked") continue;
		self.warn(`evolution: the commit intent "${outcome.intentId}" (${outcome.direction} of proposal "${outcome.proposalId}") targeting ${outcome.targets.join(", ")} could not be settled — ${outcome.detail ?? "no reason reported"}`);
	}
}
async function adoptRootThroughBarrier(self, storeId, rootSessionId) {
	/**
	* K2-3/§E: production is reconciled before this barrier takes anything over.
	* A graph activation arrives here (activate → adoptRoot), so an interrupted
	*/
	await reconcileEvolutionCommits(self);
	await openOrCreateStore(self, storeId);
	let snapshot = await self.context.task.snapshotIn(storeId);
	self.reindex(storeId, snapshot);
	let root = snapshot.tasks.find((task) => task.parentTaskId === void 0);
	if (root === void 0) {
		/**
		* No root on the record is not the end of the question: the recovery pass
		* is what continues an approval that was recorded before the process died
		*/
		await self.reconcileStore(storeId);
		snapshot = await self.context.task.snapshotIn(storeId);
		root = snapshot.tasks.find((task) => task.parentTaskId === void 0);
		if (root === void 0) return {
			adopted: false,
			detail: nothingAdoptedDetail(storeId, rootSessionId, snapshot)
		};
	}
	const run = [...snapshot.runs].reverse().find((item) => item.taskId === root.taskId && item.sessionId === rootSessionId);
	if (run === void 0) throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${rootSessionId}"`);
	/**
	* Re-entering a run (a restarted root session adopts the run bound to it):
	* the record's own content identity is re-checked before the run is handed
	*/
	if (run.providerBinding !== void 0) {
		const read = await readRunBinding(run.providerBinding);
		if (read !== void 0 && read.defects.length > 0) throw new Error(`task-runtime: run "${run.runId}" cannot be re-entered: the content it is bound to is not readable:\n- ${read.defects.join("\n- ")}`);
	}
	const phase = runGatePhase(run);
	const rootWasStarted = self.startedSessions.has(rootSessionId);
	self.sessions.set(rootSessionId, {
		storeId,
		taskId: root.taskId,
		runId: run.runId
	});
	self.startedSessions.add(rootSessionId);
	if (!rootWasStarted && (phase === "active" || phase === "waiting_children" && pendingCoordinationOf(snapshot, run.runId).length > 0)) self.notifyWhenReady(rootSessionId, "task-runtime: continue this same Run from the persisted conversation. Check any interrupted tool action without a receipt before repeating it; handle any unresolved Task questions from the conversation, then continue work allowed in your current execution phase and submit when ready.");
	if (phase === "terminal") self.executionGate.setTerminal(rootSessionId);
	else if (phase !== void 0) self.executionGate.setPhase(rootSessionId, phase);
	/**
	* A submitted run left by a dead process is independently verified by the
	* recovery pass. Take over this tree's checkout first so that verification
	*/
	if (snapshot.runs.some((item) => item.status === "running" && item.executionPhase === "submitted")) await self.rebuildWorkspaceOwnership(storeId);
	/**
	* Adoption is the recovery entry (§3.6): runs this process is not driving
	* are settled or restarted, then the workspace layers are rebuilt from the
	*/
	await self.reconcileStore(storeId);
	await self.rebuildWorkspaceOwnership(storeId);
	return {
		adopted: true,
		taskId: root.taskId,
		runId: run.runId,
		phase: phase ?? "terminal",
		detail: `store "${storeId}" holds root task "${root.taskId}" with run "${run.runId}" for session "${rootSessionId}"; the session is bound and its gate is "${phase ?? "ungated"}"`
	};
}
async function initializeStoreGates(self, storeId) {
	const tokens = /* @__PURE__ */ new Map();
	for (const [sessionId, binding] of self.sessions) if (binding.storeId === storeId) tokens.set(sessionId, self.executionGate.decisionToken(sessionId));
	let snapshot;
	try {
		snapshot = await self.context.task.snapshotIn(storeId);
	} catch (error) {
		throw new Error(`store ${storeId} could not be read to initialize its sessions' gates after recovery (${message(error)}); the recovery barrier fails rather than leaving the store half-gated`);
	}
	for (const run of snapshot.runs) self.gatePhaseFromStore(run.sessionId, run, storeId, tokens.get(run.sessionId) ?? 0);
	/**
	* The question blocks come from the same read and the same tokens (A4 §F.1):
	* a restarted session whose run is waiting on an unresolved blocking question
	*/
	applyStoreQuestionBlocking(self.executionGate, snapshot, (sessionId) => tokens.get(sessionId) ?? 0);
}
function nothingAdoptedDetail(storeId, rootSessionId, snapshot) {
	const open = (snapshot.proposals?.all ?? []).filter(isOpenProposal);
	return `store "${storeId}" holds no root task for session "${rootSessionId}" after its recovery pass, which created no task, no run and no proposal; ${open.length === 0 ? "no proposal is open on it" : `${open.length === 1 ? "1 proposal is" : `${open.length} proposals are`} still open: ` + open.map((proposal) => `"${proposal.proposalId}" (${proposal.status})`).join(", ")}; a root task is created by a root contract intake, never by adoption`;
}
function runGatePhase(run) {
	if (run.status !== "running") return "terminal";
	return run.executionPhase;
}
async function openOrCreateStore(self, storeId) {
	try {
		await self.context.task.createStore(storeId);
	} catch (error) {
		if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error;
		await self.context.task.openStore(storeId);
	}
}
async function intakeRootContract(self, storeId, rootSessionId, spec, options = {}) {
	if (options.exec?.signal?.aborted === true) throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`);
	await self.assertRecoveryReady(storeId, "the intake of a root contract");
	const submission = await submitRootContractProposal(self, storeId, rootSessionId, spec, options);
	const continued = await self.continueProposal(storeId, submission.proposalId, rootSessionId);
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
async function submitRootContractProposal(self, storeId, rootSessionId, spec, options = {}) {
	await self.assertRecoveryReady(storeId, "a root contract proposal");
	return await serializeRootIntake(self, storeId, () => submitRootProposalOnce(self, storeId, rootSessionId, spec, options));
}
function rootRequestKey(storeId, rootSessionId, contract, requested) {
	return requested ?? rootProposalRequestKey({
		storeId,
		rootSessionId,
		contractDigest: contractDigest(contract)
	});
}
async function rootProposalForRequest(self, storeId, requestKey, contract) {
	const stored = (await self.context.task.snapshotIn(storeId)).proposals?.byRequestKey[requestKey];
	if (stored === void 0) return void 0;
	if (stored.kind !== "root") throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a decomposition batch; a request key names one proposal, and a root intake cannot take over a batch's key`);
	if (stored.identity.contractDigest !== contractDigest(contract)) throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose root contract is a different one (digest ${stored.identity.contractDigest} ≠ ${contractDigest(contract)}); a revision is new content under a new key (§6)`);
	return stored;
}
async function assertRootContractOrigin(self, storeId, rootSessionId) {
	const own = rootTaskStoreId(rootSessionId);
	if (storeId !== own) throw originRefusal(rootSessionId, `store "${storeId}" is not this session's own store ("${own}"), and a root contract is intaken into the store of the session that asked (A0 §1.10) — never into another session's, whatever the contract says`);
	const { header, events } = await rootSessionLog(self, rootSessionId);
	/**
	* The session's kind, before its log: a spawned session works on a task its
	* parent already admitted, and no message on its log can make it the
	*/
	if (header?.origin === "subagent") throw originRefusal(rootSessionId, "this session is a delegated child (its header records origin \"subagent\"), and a root contract belongs to the top-level session a graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)");
	const depth = header?.delegationDepth ?? 0;
	if (depth > 0) throw originRefusal(rootSessionId, `this session is a delegated child (its header records delegation depth ${depth}), and a root contract belongs to the top-level session a graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)`);
	if (events.some((event) => event.type === "user/message" && event.data.source.kind === "user")) return;
	throw originRefusal(rootSessionId, "this session's own log holds no message from the person (no `user/message` event with source.kind \"user\", the marker DSH reserves for host-attested human input), so the request the contract stands on cannot be established here; the messages this deployment writes to a session of its own are attributed to their producers — its prompts carry source.kind \"runtime-prompt\" (the graph setup text and a spawn's delegated task) and its notices carry \"plugin\" — and neither is a request of the person's (A0 §1.10)");
}
async function rootSessionLog(self, rootSessionId) {
	const persistence = self.softService("sessionPersistence");
	if (persistence === void 0 || typeof persistence.open !== "function") throw originRefusal(rootSessionId, "this deployment mounts no session-persistence service, so its own log cannot be read (A0 §1.10)");
	let handle;
	try {
		handle = await persistence.open(SessionId(rootSessionId), "read");
		const { events } = await handle.read(0);
		return {
			header: handle.header,
			events
		};
	} catch (error) {
		throw originRefusal(rootSessionId, `its own log could not be read (${message(error)})`);
	} finally {
		/**
		* A close that fails is not this call's answer: the log was already read —
		* or already refused by name — and the handle's teardown is best-effort
		*/
		if (handle !== void 0) await handle.close().catch(() => void 0);
	}
}
function originRefusal(rootSessionId, reason) {
	return /* @__PURE__ */ new Error(`task-runtime: the root contract of session "${rootSessionId}" was refused: ${reason}`);
}
async function submitRootProposalOnce(self, storeId, rootSessionId, spec, options) {
	if (options.exec?.signal?.aborted === true) throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`);
	/**
	* Where the request came from, before anything is opened or written: a store
	* that is not the session's own, a session that is a delegated child, or one
	*/
	await assertRootContractOrigin(self, storeId, rootSessionId);
	/**
	* The root session's store exists before its contract does (A0 §1.1): a graph
	* creates the session, and the intake is what fills the store — so this is the
	*/
	await openOrCreateStore(self, storeId);
	/**
	* The session's checkout is resolved once: the directory the contract's
	* protected acceptance inputs are read against, the provider pre-check
	*/
	const envPath = await self.envPathForSession(rootSessionId);
	const derived = await deriveRootContract(self, spec, envPath);
	if (!derived.ok) throw derived.refusal;
	const { contract } = derived;
	const requestKey = rootRequestKey(storeId, rootSessionId, contract, options.requestKey);
	const stored = await rootProposalForRequest(self, storeId, requestKey, contract);
	if (stored !== void 0) {
		/**
		* The caller asked again for the contract this request names: the record
		* already carries it, so the answer is the record — and a proposal still
		*/
		const review$1 = stored.status === "pending_review" ? await self.requestProposalReview({
			kind: "root",
			storeId,
			trigger: "submitted",
			proposal: stored,
			rootSessionId,
			contract: structuredClone(stored.contract),
			manifests: rootManifests(self, stored.contract)
		}) : void 0;
		return {
			proposalId: stored.proposalId,
			status: stored.status,
			policy: stored.policy,
			existing: true,
			detail: rootSubmissionDetail(self, stored, true),
			...review$1 === void 0 ? {} : { review: review$1 }
		};
	}
	/**
	* A genuinely new root contract: the store must not already hold a root (the
	* same gate the reducer enforces inside the commit, asked here so the caller
	*/
	const root = await existingRootTask(self, storeId);
	if (root !== void 0) throw new Error(`task-runtime: store "${storeId}" already holds root task "${root.taskId}", so a root contract cannot be intaken here (§1.6: an old graph's root is history and is not re-intaken; a new goal is a new graph)`);
	const checked = await checkRootContract(self, {
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
	const policy = self.config.generatedTaskReview;
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
		admissionContext: self.admissionContext(),
		admissionContextDigest: admissionContextDigest(self.admissionContext()),
		reviewContext,
		reviewContextDigest: reviewContextDigest(reviewContext),
		createdAt: now()
	};
	try {
		await self.context.task.submitProposalIn(storeId, proposal, rootSessionId);
	} catch (error) {
		/**
		* A store that already holds *this* contract is a race, not a failure: the
		* request is answered from the record exactly as a retry is. Anything else
		*/
		const raced = await self.readProposal(storeId, proposal.proposalId).catch(() => void 0);
		if (raced === void 0 || raced.kind !== "root" || raced.proposalDigest !== proposal.proposalDigest) throw error;
		return {
			proposalId: raced.proposalId,
			status: raced.status,
			policy: raced.policy,
			existing: true,
			detail: rootSubmissionDetail(self, raced, true)
		};
	}
	if (proposal.status !== "pending_review") return {
		proposalId: proposal.proposalId,
		status: proposal.status,
		policy: proposal.policy,
		existing: false,
		detail: rootSubmissionDetail(self, proposal, false)
	};
	const review = await self.requestProposalReview({
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
		detail: rootSubmissionDetail(self, proposal, false),
		review
	};
}
async function deriveRootContract(self, spec, envPath) {
	const fixed = await fixCriteriaProtectedInputs(Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : [], envPath, "root contract");
	const normalized = normalizeRootContract(fixed.reasons.length === 0 ? {
		...spec,
		acceptanceCriteria: fixed.criteria
	} : spec);
	const reasons = [...fixed.reasons, ...normalized.ok ? [] : normalized.reasons];
	if (!normalized.ok || reasons.length > 0) return {
		ok: false,
		refusal: rootRefusal(reasons)
	};
	return {
		ok: true,
		contract: normalized.contract
	};
}
function rootRefusal(reasons) {
	return /* @__PURE__ */ new Error(`task-runtime: root contract rejected:\n- ${reasons.join("\n- ")}`);
}
function rootManifests(self, contract) {
	return [self.resolveCapabilities(contract.requiredCapabilities)];
}
async function existingRootTask(self, storeId) {
	return (await self.context.task.snapshotIn(storeId)).tasks.find((task) => task.parentTaskId === void 0);
}
async function checkRootContract(self, request) {
	const { rootSessionId, contract } = request;
	const label = `root contract of session "${rootSessionId}"`;
	const defects = [...contractDefects(contract.acceptanceCriteria, label), ...rootIndependenceDefects(contract.acceptanceCriteria, label)];
	if (defects.length > 0) return {
		ok: false,
		refusal: {
			error: rootRefusal(defects),
			reasons: defects
		}
	};
	const manifests = rootManifests(self, contract);
	const manifest = manifests[0];
	if (manifest.missing.length > 0) {
		const detail = `${label} is missing [${manifest.missing.join(", ")}] and a root has no parent to delegate them to`;
		return {
			ok: false,
			refusal: {
				error: rootRefusal([detail]),
				reasons: [detail]
			}
		};
	}
	const precheck = await self.providerPrecheck(Object.keys(manifest.capabilities), { ...request.envPath === void 0 ? {} : { cwd: request.envPath } });
	const refusals = providerRefusals(precheck);
	if (refusals.length > 0) return {
		ok: false,
		refusal: {
			error: rootRefusal([`the provider pre-check rejected ${label}:`, ...refusals]),
			reasons: refusals
		}
	};
	try {
		await self.assertKnownVerifierRefs(contract.acceptanceCriteria.map((criterion) => ({
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
async function continueRootProposalIn(self, storeId, proposal) {
	const rootSessionId = proposal.identity.rootSessionId;
	/**
	* The origin rule again, before the ladder's first write (§1.10): a proposal
	* recorded before this rule existed, or written into the store by any other
	*/
	await assertRootContractOrigin(self, storeId, rootSessionId);
	const existing = await existingRootTask(self, storeId);
	if (existing !== void 0) return await self.expireProposal(storeId, proposal, `store "${storeId}" already holds root task "${existing.taskId}"; a root contract is one per store and a changed goal is a new graph (§1.6), so this proposal can no longer become the store's root`);
	/**
	* The policy gate (§5), the same rule the batch path follows: a contract born
	* under `off` that has not been activated is subject to the deployment's
	*/
	const envPath = await self.envPathForSession(rootSessionId);
	const contract = structuredClone(proposal.contract);
	if (proposal.status === "ready" && proposal.policy === "off" && self.config.generatedTaskReview === "all") {
		await self.context.task.changeProposalPhaseIn(storeId, {
			proposalId: proposal.proposalId,
			to: "pending_review",
			reason: "the deployment tightened the review policy to \"all\" while this contract had not been activated yet (§5: only tightening is allowed, and it reaches whatever has not run)"
		}, rootSessionId);
		let detail = "it is now waiting for a review";
		const reviewed = await checkRootContract(self, {
			rootSessionId,
			contract,
			...envPath === void 0 ? {} : { envPath }
		});
		const tightened = await self.requireProposal(storeId, proposal.proposalId);
		if (reviewed.ok) {
			const review = await self.requestProposalReview({
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
	const contextDigest = admissionContextDigest(self.admissionContext());
	if (contextDigest !== proposal.admissionContextDigest) return await self.staleProposal(storeId, proposal, `the limits in force moved since the contract was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`);
	const checked = await checkRootContract(self, {
		rootSessionId,
		contract,
		...envPath === void 0 ? {} : { envPath }
	});
	if (!checked.ok) {
		if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error;
		return await self.staleProposal(storeId, proposal, `the contract no longer passes admission: ${checked.refusal.reasons.join("; ")}`);
	}
	const { manifests, providers } = checked;
	const reviewContext = reviewContextOf({
		manifests,
		criteria: contract.acceptanceCriteria,
		providers: providerContentIdentities(providers.capabilities)
	});
	if (reviewContextDigest(reviewContext) !== proposal.reviewContextDigest) return await self.staleProposal(storeId, proposal, `the resolution this contract was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`);
	if (proposal.status === "approved") await self.context.task.changeProposalPhaseIn(storeId, {
		proposalId: proposal.proposalId,
		to: "ready",
		reason: "the post-approval re-check passed: the store holds no root, the limits are the ones reviewed, and the capability resolution and the judging verifiers are the ones reviewed"
	}, rootSessionId);
	return await activateRootContract(self, {
		storeId,
		rootSessionId,
		proposal,
		contract,
		manifests
	});
}
async function activateRootContract(self, request) {
	const { storeId, rootSessionId, proposal, contract } = request;
	const manifest = request.manifests[0];
	const taskId = `t-${randomUUID()}`;
	const runId = `r-${randomUUID()}`;
	const workspacePath = await self.workspacePathForSession(rootSessionId);
	let claimed;
	if (workspacePath !== void 0 && self.workspaces !== void 0) {
		await self.workspaces.claim(workspacePath, {
			kind: "run",
			storeId,
			taskId,
			runId,
			since: now()
		});
		claimed = self.workspaces.ownerOf(workspacePath);
	}
	try {
		const providerBinding = await bindRunProviders({
			storeId,
			runId,
			manifest,
			table: self.config.capabilities,
			root: self.config.runBindingRoot
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
		await self.context.task.admitRootProposalIn(storeId, task, run, rootSessionId, {
			consumption,
			manifest
		});
	} catch (error) {
		/**
		* Nothing was committed (the commit is all-or-nothing), so the claim this
		* call made is the only thing to undo: leaving it would hold a checkout for
		*/
		if (workspacePath !== void 0 && claimed !== void 0) await self.workspaces?.release(workspacePath, claimed).catch((cause) => {
			self.warn(`workspace ${workspacePath} could not be released after a refused activation (${message(cause)})`);
		});
		throw error;
	}
	self.sessions.set(rootSessionId, {
		storeId,
		taskId,
		runId
	});
	self.startedSessions.add(rootSessionId);
	self.executionGate.setPhase(rootSessionId, "active");
	self.notifyWhenReady(rootSessionId, `the root contract of this session was activated: task ${taskId}, run ${runId} (proposal ${proposal.proposalId}, policy ${proposal.policy}). This session may now decompose, submit its own result, or cancel.`);
	return {
		proposalId: proposal.proposalId,
		status: "activated",
		taskId,
		runId,
		detail: `proposal "${proposal.proposalId}" is activated as root task ${taskId} with run ${runId}`
	};
}
function rootSubmissionDetail(self, proposal, existing) {
	const head = existing ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})` : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`;
	switch (proposal.status) {
		case "ready": return `${head}; continue it to activate the root (policy off activates without a review, and the record says policy-off)`;
		case "pending_review": return `${head}; it needs a recorded decision before the root may exist, and nothing is created, spawned or notified until then`;
		case "approved": return `${head}; the approval is on record and the root is not activated yet — continue it to run the post-approval re-check`;
		case "admitted": return `${head}; its root is activated already and will not be activated again`;
		default: return `${head}; a ${proposal.status} proposal is not activated, and a revision is new content under a new key`;
	}
}
async function serializeRootIntake(self, storeId, work) {
	return await self.serializeParent(storeId, ROOT_PROPOSAL_TASK_ID, work);
}
async function reconcileRootProposal(self, storeId, proposal, report) {
	const proposalId = proposal.proposalId;
	await assertRootContractOrigin(self, storeId, proposal.identity.rootSessionId);
	if (proposal.status === "pending_review") {
		const existing = await existingRootTask(self, storeId);
		if (existing !== void 0) {
			await report(proposal, "expired", (await self.expireProposal(storeId, proposal, `store "${storeId}" already holds root task "${existing.taskId}", so this contract can no longer become its root`)).detail);
			return;
		}
		const rootSessionId = proposal.identity.rootSessionId;
		const contract = structuredClone(proposal.contract);
		const envPath = await self.envPathForSession(rootSessionId);
		const checked = await checkRootContract(self, {
			rootSessionId,
			contract,
			...envPath === void 0 ? {} : { envPath }
		});
		if (!checked.ok) {
			await report(proposal, proposal.status, `it waits for a review and its contract no longer passes admission (${checked.refusal.reasons.join("; ")}); the proposal stays pending_review`);
			return;
		}
		await self.requestProposalReview({
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
	/**
	* `ready` or `approved`: the tightening rule and the post-approval re-check
	* both live in the continuation, which is also what re-binds an activation
	*/
	const continuation = await serializeRootIntake(self, storeId, () => self.continueProposalIn(storeId, proposalId, proposal.identity.rootSessionId, {}));
	if (continuation.status === "activated") {
		await rebindActivatedRoot(self, storeId, proposal.identity.rootSessionId, continuation.taskId, continuation.runId);
		return;
	}
	await report(proposal, continuation.status, continuation.detail);
}
async function rebindActivatedRoot(self, storeId, rootSessionId, taskId, runId) {
	self.sessions.set(rootSessionId, {
		storeId,
		taskId,
		runId
	});
	self.startedSessions.add(rootSessionId);
	let phase;
	try {
		phase = runGatePhase(await self.context.task.runIn(storeId, runId));
	} catch {
		phase = void 0;
	}
	if (phase === "terminal") self.executionGate.setTerminal(rootSessionId);
	else if (phase !== void 0) self.executionGate.setPhase(rootSessionId, phase);
	self.notifyWhenReady(rootSessionId, `recovery bound this session to its activated root contract: task ${taskId}, run ${runId}${phase === "terminal" ? " (that run is terminal, so this session is closed to new work)" : ""}. A late intake for a different contract is refused because the store already holds this root.`);
}

//#endregion
//#region src/service/proposals.ts
async function decomposeAndRun(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, exec = {}) {
	await self.assertRecoveryReady(storeId, "a decomposition");
	const continued = await continueProposal(self, storeId, (await submitDecompositionProposal(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, { ...exec.signal === void 0 && exec.callId === void 0 ? {} : { exec } })).proposalId, callerSessionId, { ...exec.callId === void 0 ? {} : { exec: { callId: exec.callId } } });
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
async function submitDecompositionProposal(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, options = {}) {
	await self.assertRecoveryReady(storeId, "a decomposition proposal");
	return await serializeParent(self, storeId, parentTaskId, () => submitProposalOnce(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, options));
}
async function continueProposal(self, storeId, proposalId, caller, options = {}) {
	await self.assertRecoveryReady(storeId, "the continuation of a proposal");
	const proposal = await requireProposal(self, storeId, proposalId);
	if (proposal.kind === "root") return await self.serializeRootIntake(storeId, () => continueProposalIn(self, storeId, proposalId, caller, options));
	return await serializeParent(self, storeId, proposal.identity.parentTaskId, () => continueProposalIn(self, storeId, proposalId, caller, options));
}
async function decideProposal(self, storeId, proposalId, decision, decidedBy, exec = {}) {
	await self.assertRecoveryReady(storeId, "a proposal decision");
	const proposal = await requireProposal(self, storeId, proposalId);
	const serialize = async (work) => proposal.kind === "root" ? await self.serializeRootIntake(storeId, work) : await serializeParent(self, storeId, proposal.identity.parentTaskId, work);
	return await serialize(async () => {
		const current = await requireProposal(self, storeId, proposalId);
		if (decidedBy.trim().length === 0) throw new Error(`task-runtime: a decision on proposal "${proposalId}" requires a decider`);
		if (decision.reason !== void 0 && decision.reason.trim().length === 0) throw new Error(`task-runtime: a decision reason on proposal "${proposalId}" must be non-empty when given`);
		const decidedAt = decision.decidedAt ?? now();
		let outcome = decision.outcome;
		let reason = decision.reason;
		if (outcome === "approved") {
			/**
			* A late approval may only invalidate (§6), and what makes it late is the
			* subject's own state: a parent run that ended, or — for a root contract —
			*/
			const ended = await approvalLatenessReason(self, storeId, current);
			if (ended !== void 0) {
				outcome = "expired";
				reason = `the approval arrived after ${current.kind === "root" ? "the root contract" : "the batch"} could be dispatched: ${ended}`;
			}
		}
		if (outcome === "expired" && reason === void 0) throw new Error(`task-runtime: an expiry of proposal "${proposalId}" must state what ended the batch`);
		await self.context.task.decideProposalIn(storeId, {
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
			const continuation = await continueProposalIn(self, storeId, proposalId, proposalCallerOf(current), { exec });
			return {
				proposalId,
				outcome,
				status: continuation.status,
				continuation,
				detail: `proposal "${proposalId}" is approved; ${continuation.detail}`
			};
		} catch (error) {
			/**
			* The decision is on the record and what the proposal asked for was not
			* created. Both facts are reported: the proposal stays where the
			*/
			const detail = message(error);
			self.warn(`proposal ${proposalId}: the approval is recorded but the continuation failed (${detail})`);
			const stored = await readProposal(self, storeId, proposalId).catch(() => void 0);
			return {
				proposalId,
				outcome,
				status: stored?.status ?? outcome,
				detail: `the approval of proposal "${proposalId}" is recorded; ${current.kind === "root" ? "the root was not activated" : "the batch was not admitted"}: ${detail}`
			};
		}
	});
}
async function approvalLatenessReason(self, storeId, proposal) {
	if (proposal.kind !== "root") return await parentRunEndedReason(self, storeId, proposal);
	const existing = await self.existingRootTask(storeId);
	if (existing === void 0) return void 0;
	return `store "${storeId}" already holds root task "${existing.taskId}"`;
}
async function cancelProposal(self, storeId, proposalId, caller) {
	const owner = proposalCallerOf(await requireProposal(self, storeId, proposalId));
	if (caller !== owner) throw new Error(`task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot withdraw it (a withdrawal by anybody else is a decision, and is recorded as one — decideProposal with "cancelled")`);
	return await decideProposal(self, storeId, proposalId, { outcome: "cancelled" }, caller);
}
function proposalCallerOf(proposal) {
	return proposal.kind === "root" ? proposal.identity.rootSessionId : proposal.identity.callerSessionId;
}
async function proposalIn(self, storeId, proposalId) {
	return await requireProposal(self, storeId, proposalId);
}
async function proposalsForParent(self, storeId, parentTaskId) {
	return [...(await self.context.task.snapshotIn(storeId)).proposals?.byParentTask[parentTaskId] ?? []];
}
async function submitProposalOnce(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, options) {
	const actor = callerSessionId;
	const identity = {
		storeId,
		parentTaskId,
		parentRunId,
		callerSessionId
	};
	const parentTask = await self.context.task.taskIn(storeId, parentTaskId);
	const parentRun = await self.context.task.runIn(storeId, parentRunId);
	const derived = await self.deriveBatch(identity, spec);
	if (!derived.ok) return await refusePrecheck(self, storeId, parentTaskId, actor, derived.refusal);
	const { batch } = derived;
	/**
	* (2) §6's request key: the caller's own when it has one, otherwise derived
	*     from the calling context and the batch's own digest — stable across a
	*/
	const requestKey = options.requestKey ?? proposalRequestKey({
		...identity,
		proposalDigest: batch.admission.proposalDigest
	});
	const stored = await proposalForRequest(self, storeId, requestKey, batch.admission.proposalDigest);
	if (stored !== void 0) {
		/**
		* The caller presented the batch again and the digest says it is the one
		* this request names: the stored proposal already carries the content, so
		*/
		const storedBatch = self.storedBatchOf(stored);
		const review$1 = stored.status === "pending_review" ? await requestProposalReview(self, {
			storeId,
			trigger: "submitted",
			proposal: stored,
			parentTask,
			batch: storedBatch,
			manifests: self.manifestsOf(storedBatch)
		}) : void 0;
		return {
			proposalId: stored.proposalId,
			status: stored.status,
			policy: stored.policy,
			existing: true,
			detail: submissionDetail(stored, true),
			...review$1 === void 0 ? {} : { review: review$1 }
		};
	}
	/**
	* (3) A genuinely new batch: only a run that may still decide its own work
	*     may propose one, and the batch has to clear every admission rule. Two
	*/
	await self.assertDecomposableRun(storeId, parentTask, parentRun, callerSessionId, options.exec?.signal);
	const inFlight = await self.inFlightProposalsOf(storeId, parentRunId);
	if (inFlight.length > 0) {
		const held = inFlight[0];
		throw new Error(`task-runtime: run "${parentRunId}" already has a proposal in flight — "${held.proposalId}" is ${held.status}; a run has at most one batch proposal at a time, so continue that one (or withdraw it with task_proposal_cancel) rather than proposing a second, and nothing was recorded`);
	}
	const checked = await self.checkDerivedBatch({
		identity,
		parentTask,
		batch,
		...derived.envPath === void 0 ? {} : { envPath: derived.envPath }
	});
	if (!checked.ok) return await refusePrecheck(self, storeId, parentTaskId, actor, checked.refusal);
	const { manifests, providers } = checked;
	const reviewContext = reviewContextOf({
		manifests,
		criteria: batch.children.flatMap((child) => child.contract.acceptanceCriteria),
		providers: providerContentIdentities(providers.capabilities)
	});
	const policy = self.config.generatedTaskReview;
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
		await self.context.task.submitProposalIn(storeId, proposal, actor);
	} catch (error) {
		/**
		* A store that already holds *this* batch is a race, not a failure: the
		* request is answered from the record exactly as a retry is. A refusal
		*/
		const raced = await readProposal(self, storeId, proposal.proposalId).catch(() => void 0);
		if (raced === void 0 || raced.proposalDigest !== proposal.proposalDigest) throw error;
		return {
			proposalId: raced.proposalId,
			status: raced.status,
			policy: raced.policy,
			existing: true,
			detail: submissionDetail(raced, true)
		};
	}
	if (proposal.status !== "pending_review") return {
		proposalId: proposal.proposalId,
		status: proposal.status,
		policy: proposal.policy,
		existing: false,
		detail: submissionDetail(proposal, false)
	};
	const review = await requestProposalReview(self, {
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
		detail: submissionDetail(proposal, false),
		review
	};
}
async function continueProposalIn(self, storeId, proposalId, caller, options) {
	const proposal = await requireProposal(self, storeId, proposalId);
	const owner = proposalCallerOf(proposal);
	if (caller !== owner) throw new Error(`task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot continue it (a proposal belongs to the session that made it, and an approval is continued on that session's behalf)`);
	switch (proposal.status) {
		case "admitted": {
			const consumption = proposal.consumption;
			if (consumption === void 0) throw new Error(`task-runtime: proposal "${proposalId}" is admitted without a consumption record; the store is inconsistent and nothing is dispatched`);
			/**
			* What the proposal became is read off the consumption, by kind: a batch
			* names its children, a root contract names the task and run it became.
			*/
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
	/**
	* A root contract's continuation is a different ladder from a batch's — one
	* store-level gate and two fingerprints, with no parent task and no parent
	*/
	if (proposal.kind === "root") return await self.continueRootProposalIn(storeId, proposal);
	const parentTaskId = proposal.identity.parentTaskId;
	const parentTask = await self.context.task.taskIn(storeId, parentTaskId);
	/**
	* (1) The run's own state, re-read here (K1 §3): an approval is a record, and
	* what it may still become is a question about the run *now*, never about the
	*/
	const parentRun = await self.context.task.runIn(storeId, proposal.identity.parentRunId).catch(() => void 0);
	if (parentRun === void 0) throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${proposal.identity.parentRunId}" is not in store "${storeId}", and a batch is never admitted against a run the store does not hold`);
	if (parentRun.batchId !== void 0) return await staleProposal(self, storeId, proposal, `run "${parentRun.runId}" is already waiting on batch "${parentRun.batchId}", so this proposal's batch cannot become it (a run holds at most one unfinished batch); the approval is not transferred to another batch`);
	if (parentRun.status !== "running" || parentRun.executionPhase !== "active") throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is ${parentRun.status === "running" ? `in phase "${parentRun.executionPhase ?? "none"}"` : parentRun.status}; only an active run may admit a batch, nothing was admitted, and the approval stays on the record`);
	const blocking = blockingQuestionsOf(await self.context.task.snapshotIn(storeId), parentRun.runId);
	if (blocking.length > 0) throw new Error(`task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is waiting on ${blocking.length === 1 ? "an unresolved blocking question" : `${blocking.length} unresolved blocking questions`} (${blocking.map((question) => question.questionId).join(", ")}); an answer releases the wait, and nothing was admitted`);
	/**
	* (2) The policy gate (§5). A batch born under `off` that has not been
	* admitted is subject to the deployment's *current* policy: tightened to
	*/
	const envPath = await self.envPathForSession(owner);
	if (proposal.status === "ready" && proposal.policy === "off" && self.config.generatedTaskReview === "all") {
		await self.context.task.changeProposalPhaseIn(storeId, {
			proposalId,
			to: "pending_review",
			reason: "the deployment tightened the review policy to \"all\" while this batch had not been admitted yet (§5: only tightening is allowed, and it reaches whatever has not run)"
		}, owner);
		const tightened = await requireProposal(self, storeId, proposalId);
		const tightenedBatch = self.storedBatchOf(tightened);
		let detail = "it is now waiting for a review";
		const reviewed = await self.checkDerivedBatch({
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
			const review = await requestProposalReview(self, {
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
	/**
	* (3) The batch's content comes from the store (§6): a proposal carries what
	* was asked for, so a continuation never depends on what this process still
	*/
	const identity = {
		storeId,
		parentTaskId: proposal.identity.parentTaskId,
		parentRunId: proposal.identity.parentRunId,
		callerSessionId: proposal.identity.callerSessionId
	};
	if (options.spec !== void 0) {
		const presented = await self.deriveBatch(identity, options.spec);
		if (!presented.ok) throw new Error(`task-runtime: the batch presented for proposal "${proposalId}" is not a usable one: ${presented.refusal.reasons.join("; ")}`);
		if (presented.batch.admission.proposalDigest !== proposal.proposalDigest) throw new Error(`task-runtime: the batch presented for proposal "${proposalId}" is a different one (digest ${presented.batch.admission.proposalDigest} ≠ the stored ${proposal.proposalDigest}); an approval never travels to other content, and nothing was admitted`);
	}
	const batch = self.storedBatchOf(proposal);
	/**
	* (4) The re-check (§6): the stored batch is judged again exactly as it was
	* judged at submission — structure, capabilities, providers, verifierRefs —
	*/
	const checked = await self.checkDerivedBatch({
		identity,
		parentTask,
		batch,
		...envPath === void 0 ? {} : { envPath }
	});
	if (!checked.ok) {
		/**
		* A verifier service this deployment cannot read is not a changed batch:
		* it is a deployment that cannot judge the batch at all, so the approval is
		*/
		if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error;
		return await staleProposal(self, storeId, proposal, `the batch no longer passes admission: ${checked.refusal.reasons.join("; ")}`);
	}
	const { manifests, providers } = checked;
	/**
	* The limits are recomputed from *this* process's configuration and compared
	* with the fingerprint the approval bound: the stored batch carries the
	*/
	const contextDigest = admissionContextDigest(self.admissionContext());
	if (contextDigest !== proposal.admissionContextDigest) return await staleProposal(self, storeId, proposal, `the limits in force moved since the batch was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`);
	const reviewContext = reviewContextOf({
		manifests,
		criteria: batch.children.flatMap((child) => child.contract.acceptanceCriteria),
		providers: providerContentIdentities(providers.capabilities)
	});
	if (reviewContextDigest(reviewContext) !== proposal.reviewContextDigest) return await staleProposal(self, storeId, proposal, `the resolution this batch was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`);
	/**
	* (5) The re-check passed: record it (`approved → ready`) and admit. A
	* proposal that is already `ready` wrote that same fact earlier — the
	*/
	if (proposal.status === "approved") await self.context.task.changeProposalPhaseIn(storeId, {
		proposalId,
		to: "ready",
		reason: "the post-approval re-check passed: the parent, the limits, the capability resolution, the judging verifiers and the batch content are the ones that were reviewed"
	}, proposal.identity.callerSessionId);
	const admitted = await self.admitPrecheckedBatch({
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
async function staleProposal(self, storeId, proposal, reason) {
	await self.context.task.changeProposalPhaseIn(storeId, {
		proposalId: proposal.proposalId,
		to: "stale",
		reason
	}, proposalCallerOf(proposal));
	return {
		proposalId: proposal.proposalId,
		status: "stale",
		detail: `proposal "${proposal.proposalId}" is stale: ${reason}`,
		reason
	};
}
async function expireProposal(self, storeId, proposal, reason) {
	await self.context.task.decideProposalIn(storeId, {
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
async function parentRunEndedReason(self, storeId, proposal) {
	/**
	* Only a decomposition batch has a parent run to ask about: a root contract's
	* dispatchability is the store's one-root gate, which `approvalLatenessReason`
	*/
	if (proposal.kind === "root") return void 0;
	const run = await self.context.task.runIn(storeId, proposal.identity.parentRunId);
	if (run.status !== "running") return `the parent run "${run.runId}" is ${run.status}`;
	if (run.executionPhase === void 0) return `the parent run "${run.runId}" predates coordination phases`;
	if (run.executionPhase !== "active") return `the parent run "${run.runId}" is in phase "${run.executionPhase}"`;
}
async function proposalForRequest(self, storeId, requestKey, proposalDigest) {
	const stored = (await self.context.task.snapshotIn(storeId)).proposals?.byRequestKey[requestKey];
	if (stored === void 0) return void 0;
	if (stored.kind === "root")
 /**
	* A batch request cannot be answered by a root contract, even under the same
	* key: the two address different subjects, and treating one as the other
	*/
	throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a root contract; a request key names one proposal, and a batch cannot take over a root intake's key`);
	if (stored.proposalDigest !== proposalDigest) throw new Error(`task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose batch is a different one (digest ${stored.proposalDigest} ≠ ${proposalDigest}); a revision is new content under a new key (§6)`);
	return stored;
}
async function requireProposal(self, storeId, proposalId) {
	const proposal = await readProposal(self, storeId, proposalId);
	if (proposal === void 0) throw new Error(`task-runtime: store "${storeId}" holds no proposal "${proposalId}"`);
	return proposal;
}
async function readProposal(self, storeId, proposalId) {
	return (await self.context.task.snapshotIn(storeId)).proposals?.byId[proposalId];
}
function submissionDetail(proposal, existing) {
	const head = existing ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})` : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`;
	switch (proposal.status) {
		case "ready": return `${head}; continue it to admit the batch (policy off admits without a review, and the record says policy-off)`;
		case "pending_review": return `${head}; it needs a recorded decision before its batch can run, and its batch is not admitted, not spawned and its parent is not decomposed`;
		case "approved": return `${head}; the approval is on record and the batch has not been admitted yet — continue it to run the post-approval re-check`;
		case "admitted": return `${head}; its batch is admitted already and will not be admitted again`;
		default: return `${head}; a ${proposal.status} proposal is not dispatched, and a revision is new content under a new key`;
	}
}
async function requestProposalReview(self, request) {
	const channel = self.softService("proposalReviewChannel");
	if (channel === void 0 || typeof channel.requestReview !== "function") return {
		requested: false,
		detail: "no review channel is mounted (ctx.proposalReviewChannel), so nobody was asked; the proposal stays pending_review and only a recorded decision moves it"
	};
	const registeredVerifiers = await self.registeredVerifierIds();
	const obligations = request.kind === "root" ? [] : await self.context.task.snapshotIn(request.storeId).then((snapshot) => snapshot.obligations.filter((obligation) => obligation.sourceTaskId === request.parentTask.taskId)).catch(() => []);
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
		const detail = message(error);
		self.warn(`proposal ${request.proposal.proposalId}: the review channel failed (${detail}); the proposal stays pending_review`);
		return {
			requested: false,
			detail: `the review channel failed: ${detail}`
		};
	}
}
async function refusePrecheck(self, storeId, parentTaskId, actor, refusal) {
	for (const gap of refusal.gaps) for (const missing of gap.missing) await self.context.task.recordObligationIn(storeId, {
		obligationId: `o-${randomUUID()}`,
		goal: `capability "${missing}" required by child ${gap.childIndex} ("${gap.objective}") of "${parentTaskId}" is not granted by the registry`,
		criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
		sourceTaskId: parentTaskId
	}, actor);
	throw refusal.error;
}
async function serializeParent(self, storeId, parentTaskId, work) {
	return await enqueueByKey(self.parentChains, `${storeId}/${parentTaskId}`, work);
}
async function reconcileProposals(self, storeId) {
	let snapshot;
	try {
		snapshot = await self.context.task.snapshotIn(storeId);
	} catch (error) {
		self.warn(`store ${storeId}: the proposals could not be read for recovery (${message(error)})`);
		return [];
	}
	const unresolved = [];
	const report = async (proposal, status, reason) => {
		self.warn(`store ${storeId}: proposal ${proposal.proposalId}: ${reason}`);
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
				await self.reconcileRootProposal(storeId, proposal, report);
				continue;
			}
			if (proposal.status === "pending_review") {
				const ended = await parentRunEndedReason(self, storeId, proposal);
				if (ended !== void 0) {
					await report(proposal, proposal.status, `it waits for a review it can no longer be dispatched from (${ended}); only a recorded decision moves it (§6)`);
					continue;
				}
				const parentTask = await self.context.task.taskIn(storeId, proposal.identity.parentTaskId);
				const identity = {
					storeId,
					parentTaskId: proposal.identity.parentTaskId,
					parentRunId: proposal.identity.parentRunId,
					callerSessionId: proposal.identity.callerSessionId
				};
				const batch = self.storedBatchOf(proposal);
				const envPath = await self.envPathForSession(proposal.identity.callerSessionId);
				const checked = await self.checkDerivedBatch({
					identity,
					parentTask,
					batch,
					...envPath === void 0 ? {} : { envPath }
				});
				if (!checked.ok) {
					await report(proposal, proposal.status, `it waits for a review and its batch no longer passes admission (${checked.refusal.reasons.join("; ")}); the proposal stays pending_review`);
					continue;
				}
				await requestProposalReview(self, {
					storeId,
					trigger: "recovered",
					proposal,
					parentTask,
					batch,
					manifests: checked.manifests
				});
				continue;
			}
			const continuation = await serializeParent(self, storeId, proposal.identity.parentTaskId, () => continueProposalIn(self, storeId, proposalId, proposal.identity.callerSessionId, {}));
			if (continuation.status !== "admitted" && continuation.status !== "activated") await report(proposal, continuation.status, continuation.detail);
		} catch (error) {
			const reason = message(error);
			self.warn(`store ${storeId}: proposal ${proposalId} could not be continued during recovery (${reason}); it stays ${proposal.status}`);
			unresolved.push({
				proposalId,
				status: proposal.status,
				reason
			});
		}
	}
	return unresolved;
}

//#endregion
//#region src/orchestration/verify.ts
/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
const VERIFY_SAFETY_MARGIN_MS = 15e3;
/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal) {
	return signal?.aborted === true;
}
/**
* The KISS §4.3 UNKNOWN split, rendered into the orchestrator's feedback so a
* reader never mistakes "the criterion was never tested" for "the judge is
*/
function unknownTag(result) {
	if (result.status !== "inconclusive" || result.unknownKind === void 0) return "";
	return result.unknownKind === "task" ? " [unknown: task — the criterion was never tested]" : ` [unknown: verifier — the verifier could not judge] ${escalationHint(`the verifier "${result.verifierId}" could not judge criterion "${result.criterionId}"`, "the criterion was run and the judge itself failed", "fix or replace the verifier, then re-verify the criterion")}`;
}
function unmetMandatory(criteria, results) {
	return criteria.filter((criterion) => criterion.mandatory).flatMap((criterion) => {
		const result = results.find((item) => item.criterionId === criterion.criterionId);
		/**
		* KISS §5.1: a criterion explicitly labeled heuristic is judged and labeled,
		* never counted as a deterministic pass — a natural-language coverage signal
		*/
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
/** The one-line reason a set of missing references carries, shared by the spawn gate and the submission gate. */
function missingArtifactReason(missing) {
	return `missing required artifacts: ${missing.map((item) => `${item.ref} (criterion ${item.criterionId}${item.requirement === "accepts" ? "; raw input, any run state" : ""})`).join(", ")}`;
}
/**
* Copy the verifier's per-criterion results onto a review record, filling the
* command from the criterion itself when the result omits it — the record
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
* Safety net around one verifier call. The verifier holds its own deadline
* (`timeoutMs` goes down with every call) and kills whatever it started, so
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
*/
function escalationHint(what, tried, suggested) {
	return `L4 exit (KISS §7): report this to a human with the escalate tool — what: ${what}; tried: ${tried}; suggested: ${suggested}`;
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
* ------------------------------------------------------------------------- *
* Batch driving (A3 §3.1/§3.2/§3.6/§3.7)
*/
/** Run statuses that end a run: the states a batch adopts instead of driving further (the task package's own set). */
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

//#endregion
//#region src/service/admission.ts
async function deriveBatch(self, identity, spec) {
	/**
	* The session's checkout, resolved once: the same directory the caller's
	* protected acceptance inputs are read against, the children's MCP servers
	*/
	const envPath = await self.envPathForSession(identity.callerSessionId);
	const fixed = await fixSpecProtectedInputs(spec, envPath);
	const normalized = normalizeDecomposition(fixed.spec, {
		...identity,
		admissionContext: self.admissionContext()
	});
	const reasons = [...fixed.reasons, ...normalized.ok ? [] : normalized.reasons];
	if (!normalized.ok || reasons.length > 0) return {
		ok: false,
		refusal: {
			error: self.contractRefusal(identity.parentTaskId, reasons),
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
function manifestsOf(self, batch) {
	return batch.children.map((child) => self.resolveCapabilities(child.contract.requiredCapabilities));
}
function storedBatchOf(proposal) {
	if (proposal.kind === "root")
 /**
	* An internal invariant rather than a caller's mistake: every call site knows
	* it is holding a decomposition proposal, and one that does not is a bug the
	*/
	throw new Error(`task-runtime: proposal "${proposal.proposalId}" is a root contract; it holds one contract and no batch`);
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
async function assertDecomposableRun(self, storeId, parentTask, parentRun, callerSessionId, signal) {
	const parentTaskId = parentTask.taskId;
	if (parentRun.taskId !== parentTaskId) throw new Error(`task-runtime: run "${parentRun.runId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`);
	if (parentRun.sessionId !== callerSessionId) throw new Error(`task-runtime: run "${parentRun.runId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`);
	if (parentRun.executionPhase === void 0) throw new Error(`task-runtime: run "${parentRun.runId}" predates coordination phases; it needs recovery (cancel this task tree and re-create it) before it can decompose`);
	if (parentRun.executionPhase !== "active") throw new Error(`task-runtime: run "${parentRun.runId}" is in phase "${parentRun.executionPhase}"; only an active run may decompose (a run with an unfinished batch is handed back \`active\` when the batch ends; only then may it decompose again)`);
	const openQuestions = blockingQuestionsOf(await self.context.task.snapshotIn(storeId), parentRun.runId);
	if (openQuestions.length > 0) throw new Error(`task-runtime: run "${parentRun.runId}" is waiting on ${openQuestions.length === 1 ? "an unresolved blocking question" : `${openQuestions.length} unresolved blocking questions`} (${openQuestions.map((question) => question.questionId).join(", ")}); an answer releases the wait, and only then may the run delegate`);
	if (signal?.aborted === true) throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`);
}
async function inFlightProposalsOf(self, storeId, parentRunId) {
	const index = (await self.context.task.snapshotIn(storeId)).proposals;
	/**
	* An index this snapshot does not carry (a hand-built one) is not "no
	* proposal exists": the check is skipped rather than answered wrongly, and the
	*/
	if (index === void 0) return [];
	return index.all.filter((proposal) => proposal.kind !== "root" && proposal.identity.parentRunId === parentRunId && isOpenProposal(proposal));
}
async function checkDerivedBatch(self, request) {
	const { identity, parentTask, batch } = request;
	const parentTaskId = identity.parentTaskId;
	const snapshot = await self.context.task.snapshotIn(identity.storeId);
	/**
	* A `leaf` child is the parent's prediction that the work fits one worker.
	* With the runtime-decomposition switch on, the node's own admission call
	*/
	const leaf = parentTask.decompositionStatus === "leaf";
	const verdict = checkDecomposition({
		...parentTask,
		decompositionPolicy: {
			allowed: !leaf || self.config.allowRuntimeDecomposition,
			leaf,
			maxDepth: self.config.maxDepth,
			maxChildren: self.config.maxChildren
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
	const manifests = manifestsOf(self, batch);
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
		/**
		* The gap is a fact the submission path records before it refuses: one
		* obligation per missing capability, raised on the parent (KISS §7 — a
		*/
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
	/**
	* Provider pre-check (S1-C item 1): every skill the matched capabilities
	* grant must be discoverable from the viewpoint of the workers about to be
	*/
	const precheck = await self.providerPrecheck([...new Set(manifests.flatMap((manifest) => Object.keys(manifest.capabilities)))], { ...request.envPath === void 0 ? {} : { cwd: request.envPath } });
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
		await self.assertKnownVerifierRefs(batch.children.flatMap((child, childIndex) => child.contract.acceptanceCriteria.map((criterion) => ({
			childIndex,
			criterion
		}))), `decomposition of "${parentTaskId}"`);
	} catch (error) {
		/**
		* A batch naming a judge this deployment cannot list is a *batch* defect,
		* so it travels as a refusal the caller may invalidate a proposal for. A
		*/
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
async function admitPrecheckedBatch(self, request) {
	const { proposal, parentTask, parentRun, batch, manifests, exec = {} } = request;
	const providers = request.providers;
	const storeId = proposal.identity.storeId;
	const parentTaskId = parentTask.taskId;
	const callerSessionId = proposal.identity.callerSessionId;
	const actor = callerSessionId;
	if (exec.signal?.aborted === true) throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`);
	const childTaskIds = batch.children.map(() => `t-${randomUUID()}`);
	const snapshot = await self.context.task.snapshotIn(storeId);
	/**
	* The root budget's batch reservation (§3.5): every child of this batch will
	* start a run, so a batch that would push the tree past `maxRuns` is refused
	*/
	const budget$1 = resolveRootBudget(snapshot, self.config.rootBudget ?? {});
	if (!budget$1.ok) {
		if (hasRootLimits(self.config.rootBudget)) throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: the root budget cannot be resolved: ${budget$1.reason}`);
	} else {
		const reserved = checkBatchAdmission(snapshot, budget$1, batch.children.length);
		if (!reserved.allowed) throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: ${reserved.reason}`);
	}
	/**
	* Workspace ownership (§3.4): the parent run must be the writer that holds
	* the checkout, or an ancestor of it must be. Anything else is another live
	*/
	const workspacePath = await self.workspacePathForSession(callerSessionId);
	if (workspacePath !== void 0) await self.assertWorkspaceHeldBy(workspacePath, storeId, parentTask, parentRun.runId);
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
	/**
	* One commit (§1.3): the children, their admission, the dependency edges,
	* the parent's decomposition record, every child's capability manifest, the
	*/
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
	await self.context.task.admitBatchIn(storeId, parentTaskId, parentRun.runId, children, actor, edges, batch.admission, manifests, consumption);
	self.executionGate.setPhase(callerSessionId, "waiting_children");
	if (workspacePath !== void 0 && self.workspaces !== void 0) {
		const held = self.workspaces.ownerOf(workspacePath);
		if (held !== void 0) await self.workspaces.push(workspacePath, held, {
			kind: "batch",
			storeId,
			taskId: parentTaskId,
			batchId,
			since: now()
		});
	}
	/**
	* Progress belongs to the runtime from here on (§3.7): the caller's signal
	* governed admission only, and this batch's own controller is what a
	*/
	self.startBatchDriver({
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

//#endregion
//#region src/types.ts
const BUDGET_EXTENSION_REQUEST_FIELDS = ["requestKey", "maxRuns"];

//#endregion
//#region src/service/budget.ts
function ceilingsOf(budget$1) {
	return { ...budget$1.maxRuns === void 0 ? {} : { maxRuns: budget$1.maxRuns } };
}
function registerRootBudgetApproval(self, approval) {
	self.rootBudgetApproval = approval;
	return () => {
		if (self.rootBudgetApproval === approval) self.rootBudgetApproval = void 0;
	};
}
async function extendRootBudget(self, sessionId, host, request) {
	if ((typeof host === "object" && host !== null && typeof host.callId === "string" ? host.callId : "").length === 0) throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: the host execution names no call (a non-empty \`callId\`, the host's own identity for the call this request's question is asked under); the question is asked under the host’s call, and nothing else can address an answer to this request`);
	/**
	* The request is the request and nothing else. A caller that carries a field
	* of the old relay is carrying what only a person's answer may supply — the
	*/
	if (typeof request === "object" && request !== null) for (const key in request) {
		if (BUDGET_EXTENSION_REQUEST_FIELDS.includes(key)) continue;
		throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: the request carries "${key}", which is not part of a budget-extension request (only ${BUDGET_EXTENSION_REQUEST_FIELDS.join(", ")} are read); a reading, a tool-call identity and an outcome are not a caller's to supply — this entry freezes the reading itself and asks the approval channel its deployment installed, so nothing a caller carries can go past the person`);
	}
	const { storeId, snapshot, budget: budget$1 } = await budgetExtensionContext(self, sessionId);
	const requestKey = typeof request?.requestKey === "string" ? request.requestKey : "";
	const judgement = judgeBudgetExtension(request, budget$1, requestKey.length === 0 ? void 0 : budgetExtensionIndex(snapshot).byRequestKey[requestKey]);
	if (judgement.kind === "refused") throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: ${judgement.reason}`);
	if (judgement.kind === "recorded") return {
		storeId,
		rootTaskId: budget$1.rootTaskId,
		answeredFromRecord: true,
		record: judgement.record
	};
	/**
	* The one reading in force right now: frozen here, shown to the person, and
	* re-checked by the store's serial region when the claim arrives. It is what
	*/
	const effective = ceilingsOf(budget$1);
	const runsUsed = snapshot.runs.length;
	const approval = self.rootBudgetApproval;
	if (approval === void 0) throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: this deployment has no approval channel installed (no root budget approval was registered), and this entry never answers for a person (不能默许); install the approval that asks the person, or the ceiling stays where it is`);
	const decision = await approval({
		storeId,
		rootTaskId: budget$1.rootTaskId,
		rootSessionId: sessionId,
		configured: budget$1.configured,
		effective,
		runsUsed,
		proposal: judgement.proposal,
		host
	});
	if (decision.kind === "refused") {
		const recorded = budgetExtensionIndex(await self.context.task.snapshotIn(storeId)).byRequestKey[judgement.proposal.requestKey];
		if (recorded !== void 0) {
			if (recorded.requestDigest === judgement.proposal.requestDigest) return {
				storeId,
				rootTaskId: budget$1.rootTaskId,
				answeredFromRecord: true,
				record: recorded
			};
			throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: request key "${judgement.proposal.requestKey}" is already bound to ${describeBudgetExtension(recorded)} (identity ${recorded.requestDigest}); one key names one request, and different totals under it are a new request under a new key`);
		}
		throw new Error(`task-runtime: the budget of session "${sessionId}" was not extended: the request was not approved (${decision.reason}); the ceilings are unchanged and no run started`);
	}
	const claim = {
		...judgement.proposal,
		baseline: { ...effective },
		approvalRef: decision.reference,
		requestedBy: sessionId
	};
	await self.context.task.recordBudgetExtensionIn(storeId, budget$1.rootTaskId, claim, sessionId);
	const stored = budgetExtensionIndex(await self.context.task.snapshotIn(storeId)).byRequestKey[claim.requestKey];
	if (stored === void 0) throw new Error(`task-runtime: budget extension "${claim.requestKey}" was committed to store "${storeId}" but the store does not hold it; a committed extension is a durable fact, and this is not one`);
	return {
		storeId,
		rootTaskId: budget$1.rootTaskId,
		answeredFromRecord: false,
		record: stored
	};
}
async function budgetExtensionContext(self, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("task-runtime: a budget extension needs the root session that asks: pass a non-empty session id");
	let rootSessionId;
	try {
		rootSessionId = (await self.context.graphs.graphForSession(SessionId(sessionId))).rootSessionId;
	} catch (error) {
		throw new Error(`task-runtime: the budget of session "${sessionId}" cannot be extended: its graph could not be resolved (${message(error)}), so whether it is a graph's root coordination session cannot be established`);
	}
	if (rootSessionId !== sessionId) throw new Error(`task-runtime: session "${sessionId}" is not a root coordination session (its graph's root session is "${rootSessionId}"), so it cannot extend a tree's budget: a raise is a decision about the tree the root session accepted, and it is refused by name for a delegated worker, for a session of another graph, and for any session that is not the one its graph created`);
	const storeId = rootTaskStoreId(sessionId);
	let snapshot;
	try {
		snapshot = await self.context.task.openStore(storeId);
	} catch (error) {
		throw new Error(`task-runtime: the budget of session "${sessionId}" cannot be read: store "${storeId}" is unavailable (${message(error)})`);
	}
	const resolution = resolveRootBudget(snapshot, self.config.rootBudget ?? {});
	if (!resolution.ok) throw new Error(`task-runtime: the budget of session "${sessionId}" cannot be extended: ${resolution.reason}`);
	return {
		storeId,
		snapshot,
		budget: resolution
	};
}
function budgetExtensionIndex(snapshot) {
	const index = snapshot.budgetExtensions;
	if (index === void 0) throw new Error(`task-runtime: store "${snapshot.id}" carries no budget-extension index, so its approved ceilings cannot be read`);
	return index;
}
function judgeBudgetExtension(request, budget$1, existing) {
	if (typeof request !== "object" || request === null) return {
		kind: "refused",
		reason: "the request is not an object with a request key and maxRuns"
	};
	const requestKey = request.requestKey;
	if (typeof requestKey !== "string" || requestKey.length === 0) return {
		kind: "refused",
		reason: "the request needs a non-empty request key: it is how a retry after a restart is recognised as the same request"
	};
	if (request.maxRuns === void 0) return {
		kind: "refused",
		reason: "the request names no maxRuns ceiling to raise"
	};
	if (!Number.isInteger(request.maxRuns) || request.maxRuns <= 0) return {
		kind: "refused",
		reason: `maxRuns ${JSON.stringify(request.maxRuns)} is not a positive whole number of runs; the approved value is the tree\u2019s whole run count, never an increment`
	};
	const proposalDigest = budgetExtensionRequestDigest({
		requestKey,
		maxRuns: request.maxRuns
	});
	if (existing !== void 0) {
		if (existing.requestDigest === proposalDigest) return {
			kind: "recorded",
			record: existing
		};
		return {
			kind: "refused",
			reason: `request key "${requestKey}" is already bound to ${describeBudgetExtension(existing)} (identity ${existing.requestDigest}); one key names one request, and different totals under it are a new request under a new key`
		};
	}
	if (budget$1.maxRuns === void 0) return {
		kind: "refused",
		reason: "this tree sets no maxRuns ceiling, so there is nothing to raise"
	};
	if (request.maxRuns <= budget$1.maxRuns) return {
		kind: "refused",
		reason: `maxRuns ${request.maxRuns} does not raise the ${budget$1.maxRuns} in force`
	};
	return {
		kind: "proposed",
		proposal: {
			requestKey,
			requestDigest: proposalDigest,
			maxRuns: {
				previous: budget$1.maxRuns,
				next: request.maxRuns
			}
		}
	};
}

//#endregion
//#region src/orchestration/settlement.ts
/**
* The review dimensions and the effort counters for one terminal record,
* assembled from what the store already holds plus one optional session read.
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
* The post-hoc half of the budget (see {@link BudgetConfig}): the members the
* orchestrator cannot observe in flight are checked once, at terminal time,
*/
async function budgetBreaches(env, run) {
	const budget$1 = env.budget;
	if (budget$1 === void 0 || env.observeSession === void 0) return [];
	if (budget$1.maxToolCalls === void 0 && budget$1.tokens === void 0) return [];
	const observation = await env.observeSession(run.sessionId).catch(() => void 0);
	if (observation === void 0) return [];
	const breaches = [];
	if (budget$1.maxToolCalls !== void 0 && observation.tools !== void 0) {
		const calls = observation.tools.calls.reduce((sum, call) => sum + call.count, 0);
		if (calls > budget$1.maxToolCalls) breaches.push(`budget exceeded: maxToolCalls (observed ${calls} tool calls over the limit ${budget$1.maxToolCalls}; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint("the run already spent more tool calls than its budget allows", "the run finished before the breach was observable", "raise the budget, split the task, or accept the overspend")}`);
	}
	if (budget$1.tokens !== void 0 && observation.tokens !== void 0) {
		const tokens = observation.tokens;
		const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
		if (total > budget$1.tokens) breaches.push(`budget exceeded: tokens (observed ${total} whole-session tokens over the limit ${budget$1.tokens}; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint("the run already spent more tokens than its budget allows", "the run finished before the breach was observable", "raise the budget, split the task, or accept the overspend")}`);
	}
	return breaches;
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
/**
* Every run walked to a terminal state gets exactly one review record, written
* in the same moment right after the terminal status event — the discipline
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
	/**
	* The record is durable: the deployment may now be told about it. Handing the
	* fact over is not waiting for what it does with it (A5) — a listener runs the
	*/
	env.onTerminalReview?.({
		storeId,
		taskId,
		runId: options.run?.runId ?? null,
		outcome
	});
}
/** Best-effort owner notification; a deployment without the seam, or a throwing one, changes nothing. */
function notifyOwner(env, sessionId, text$1) {
	if (sessionId === void 0 || env.notify === void 0) return;
	try {
		env.notify(sessionId, text$1);
	} catch {}
}
/**
* ------------------------------------------------------------------------- *
* Settlements the runtime drives from the outside (§3.6)
*/
/**
* Settle one run terminal from outside the orchestration — a graph removal, or
* a recovery pass that refuses to continue a run — with the same terminal-record
*/
async function settleRunFromRuntime(env, storeId, run, status, reason) {
	const current = await env.task.runIn(storeId, run.runId);
	if (current.status !== "running") return;
	const snapshot = await env.task.snapshotIn(storeId);
	const relatedTaskIds = snapshot.tasks.find((candidate) => candidate.taskId === current.taskId)?.childTaskIds ?? [];
	try {
		await env.task.markRunStatusIn(storeId, current.taskId, current.runId, status, env.actor, { reason });
	} catch (error) {
		/**
		* Another settlement path can win this race: a driver's own abort branch, or
		* this same cancellation arriving through the batch. The store is the arbiter
		*/
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
	/**
	* The questions addressed to this run stop being open the moment it settles
	* (A4 §F.1: an open question needs *both* runs running), so the runs that asked
	*/
	if (env.gate !== void 0) try {
		releaseAskingSessions(env.gate, await env.task.snapshotIn(storeId), current.runId);
	} catch (error) {
		notifyOwner(env, current.sessionId, `task-runtime: the question blocks of the runs that asked run "${current.runId}" could not be recomputed after it settled (${message(error)}); the store's own derivation is unchanged and the next recovery recomputes them`);
	}
	await releaseWorkspaceLayer(env, runOwner(storeId, current.taskId, current.runId), current.sessionId);
	notifyOwner(env, current.sessionId, `task-runtime: run "${current.runId}" was settled ${status}: ${reason}`);
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
	/**
	* A layer that is no longer on top because this store's ownership moved on is
	* not a disagreement: the settlement and the batch driver can both release the
	*/
	if (conflict.storeId === owner.storeId) return;
	notifyOwner(env, sessionId, `task-runtime: workspace ${held.workspace} was expected to be released by ${describeOwner(owner)}, but its holder is ${describeOwner(conflict)}; the layer is left in place`);
}
/**
* Hold the workspace for one verifier call: the verification reads the result
* exclusively, so the run's own hold is handed to a `verifier` layer and
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

//#endregion
//#region src/orchestration/spawn.ts
/**
* Rebuild the authorization a recovery pass has to state for one run, from the
* store's own records, and hand it to the deployment's resume door.
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
/**
* The authorization one admitted child runs under, built from its manifest:
* the tools and skills its matched capabilities declared (labels already
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
*/
function skillRootsForRun(overlayRoots, binding) {
	return [...overlayRoots, ...binding?.snapshotRoot === void 0 ? [] : [binding.snapshotRoot]];
}
/**
* Spawn one task worker (A2 §1.2, A6 §F.4): the composition every spawn builds
* — the deployment's preset, the capability grant the manifest authorizes, the
*/
async function spawnTaskWorker(env, request) {
	await assertPresetUsable(env, request.manifest, request.agentPreset);
	const permissionPreset = permissionFor(env, request.manifest);
	const grant = await authorizedGrant(env, request.manifest, skillRootsForRun([], request.providerBinding));
	return await env.spawn({
		sessionId: request.sessionId,
		name: request.name,
		taskWorker: true,
		grant,
		...request.agentPreset === void 0 ? {} : { agentPreset: request.agentPreset },
		...permissionPreset === void 0 ? {} : { permissionPreset },
		...request.cwd === void 0 ? {} : { cwd: request.cwd },
		...request.signal === void 0 ? {} : { signal: request.signal }
	});
}
/**
* Refuse a dangling preset before the spawn attempt: when the deployment
* cannot mount the resolved preset, throw an error naming the preset and the
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

//#endregion
//#region src/recovery.ts
/** The stored kind one mode writes into {@link RunRecovery.kind}. */
function recoveryKindOf(mode) {
	return mode === "improve" ? "improvement" : "recovery";
}
/** The mode one stored kind was asked under; a record written before the field existed reads as a recovery. */
function recoveryModeOf(kind) {
	return kind === "improvement" ? "improve" : "recovery";
}
/** The fields one request may carry: anything else is refused by name rather than ignored. */
const REQUEST_FIELDS = [
	"sourceTaskId",
	"sourceRunId",
	"sourceDiagnosisId",
	"requestKey",
	"mode",
	"reuses"
];
/** The fields one reuse declaration may carry. */
const REUSE_FIELDS = [
	"childIndex",
	"taskId",
	"sourceRunId",
	"evidenceId",
	"criterionId",
	"artifactRefs",
	"inputRefs"
];
/**
* Every reason one request cannot be a recovery request at all: an unknown
* field (a caller may not smuggle a decision in), a missing or empty identity,
*/
function recoveryRequestDefects(request) {
	if (!isPlainObject(request)) return ["the request must be an object"];
	const defects = [];
	for (const key of unknownFieldKeys(request, REQUEST_FIELDS)) defects.push(`unknown field "${key}": a recovery request carries ${REQUEST_FIELDS.join(", ")} and nothing else`);
	if (!nonBlank(request.sourceTaskId)) defects.push("sourceTaskId must be a non-empty task id");
	if (request.sourceRunId !== null && !nonBlank(request.sourceRunId)) defects.push("sourceRunId must be a non-empty run id or null (a failure that had no run)");
	if (!nonBlank(request.sourceDiagnosisId)) defects.push("sourceDiagnosisId must be a non-empty diagnosis id");
	if (!nonBlank(request.requestKey)) defects.push("requestKey must be a non-empty string");
	if (request.mode !== void 0 && request.mode !== "recovery" && request.mode !== "improve") defects.push("mode must be \"recovery\" (the default) or \"improve\"");
	if (request.reuses !== void 0) if (!Array.isArray(request.reuses)) defects.push("reuses must be an array of declarations");
	else {
		const claimed = /* @__PURE__ */ new Set();
		request.reuses.forEach((entry, position) => {
			if (!isPlainObject(entry)) {
				defects.push(`reuses[${position}] must be an object`);
				return;
			}
			for (const key of unknownFieldKeys(entry, REUSE_FIELDS)) defects.push(`reuses[${position}] has unknown field "${key}"`);
			if (!Number.isInteger(entry.childIndex) || entry.childIndex < 0) defects.push(`reuses[${position}].childIndex must be a non-negative integer`);
			for (const name of [
				"taskId",
				"sourceRunId",
				"evidenceId"
			]) if (!nonBlank(entry[name])) defects.push(`reuses[${position}].${name} must be a non-empty id`);
			if (entry.criterionId !== void 0 && !nonBlank(entry.criterionId)) defects.push(`reuses[${position}].criterionId must be a non-empty string when given`);
			for (const name of ["artifactRefs", "inputRefs"]) {
				const value = entry[name];
				if (value !== void 0 && (!Array.isArray(value) || value.some((item) => !nonBlank(item)))) defects.push(`reuses[${position}].${name} must be an array of non-empty references`);
			}
			if (Number.isInteger(entry.childIndex) && entry.childIndex >= 0) {
				if (claimed.has(entry.childIndex)) defects.push(`reuses[${position}].childIndex ${entry.childIndex} is claimed by another entry; one position reads one member`);
				claimed.add(entry.childIndex);
			}
		});
	}
	return defects;
}
/** The runs of one source task that are recovery attempts, in start order (which is the store's run order). */
function recoveryAttemptsOf(snapshot, sourceTaskId) {
	return snapshot.runs.filter((run) => run.taskId === sourceTaskId && run.recovery !== void 0);
}
/** The attempt one request key names on a source task, or `undefined`. */
function recoveryAttemptWithKey(snapshot, sourceTaskId, requestKey) {
	return recoveryAttemptsOf(snapshot, sourceTaskId).find((run) => run.recovery.requestKey === requestKey);
}
/**
* The attempt one diagnosis already has whose run has not settled, or
* `undefined` — the mutual exclusion one diagnosis's recovery has (plan §F.4:
*/
function inFlightRecoveryAttempt(snapshot, sourceTaskId, sourceDiagnosisId) {
	return recoveryAttemptsOf(snapshot, sourceTaskId).find((run) => run.recovery.sourceDiagnosisId === sourceDiagnosisId && run.status === "running");
}
/**
* What makes two attempts under one key the *same* attempt: the content the key
* is bound to — the kind of round, the source run it reads and the reuse it declares. A retry
*/
function recoveryAttemptDigest(recovery) {
	return sha256Hex(canonicalize({
		kind: recovery.kind ?? "recovery",
		sourceRunId: recovery.sourceRunId ?? null,
		reusedMembers: recovery.reusedMembers.map((member) => ({
			childIndex: member.childIndex,
			taskId: member.taskId,
			sourceRunId: member.sourceRunId,
			evidenceId: member.evidenceId,
			criterionId: member.criterionId ?? null,
			artifactRefs: [...member.artifactRefs],
			inputRefs: [...member.inputRefs]
		}))
	}));
}
/**
* The source run one attempt reads, or `undefined` when the failure had none: a
* `recovery` names a run that settled `failed`, an `improve` a verified one — and
* an `improve` that names none reads the task's newest verified run.
*/
function recoverySourceRun(source, request, snapshot, kind) {
	const wanted = kind === "improvement" ? "verified" : "failed";
	const which = kind === "improvement" ? "a verified" : "a *failed*";
	if (request.sourceRunId !== null) {
		const run = snapshot.runs.find((candidate) => candidate.runId === request.sourceRunId);
		if (run === void 0) throw new Error(`task-runtime: store "${snapshot.id}" holds no run "${request.sourceRunId}"; the named source attempt does not exist`);
		if (run.taskId !== source.taskId) throw new Error(`task-runtime: run "${run.runId}" belongs to task "${run.taskId}", not to the named source "${source.taskId}"; nothing was written`);
		if (run.status !== wanted) throw new Error(`task-runtime: source run "${run.runId}" is ${run.status}; ${kind === "improvement" ? "an improvement round reads" : "a recovery recovers"} ${which} attempt (its run settled \`${wanted}\`), and this run is not one`);
		return run;
	}
	const running = snapshot.runs.filter((run) => run.taskId === source.taskId && run.status === "running");
	if (running.length > 0) throw new Error(`task-runtime: the request names no source run, but task "${source.taskId}" holds a run in flight (${running.map((run) => run.runId).join(", ")}); a failure without a run is a task that never started, not one an attempt is running for`);
	if (kind !== "improvement") return void 0;
	return [...snapshot.runs].reverse().find((run) => run.taskId === source.taskId && run.status === "verified");
}
/** The request's own content identity, derived from the same fields the stored attempt carries. */
function requestAttemptDigest(request) {
	return recoveryAttemptDigest({
		kind: recoveryKindOf(request.mode),
		...request.sourceRunId === null ? {} : { sourceRunId: request.sourceRunId },
		reusedMembers: (request.reuses ?? []).map((declaration) => ({
			childIndex: declaration.childIndex,
			taskId: declaration.taskId,
			sourceRunId: declaration.sourceRunId,
			evidenceId: declaration.evidenceId,
			...declaration.criterionId === void 0 ? {} : { criterionId: declaration.criterionId },
			artifactRefs: [...declaration.artifactRefs ?? []],
			inputRefs: [...declaration.inputRefs ?? []]
		}))
	});
}
/** Count one source task's attempt runs by kind; a row written before `kind` existed is a recovery. */
function recoveryRoundsOf(snapshot, sourceTaskId) {
	const attempts = snapshot.runs.filter((run) => run.taskId === sourceTaskId && run.recovery !== void 0);
	return {
		recovery: attempts.filter((run) => run.recovery.kind !== "improvement").length,
		improvement: attempts.filter((run) => run.recovery.kind === "improvement").length
	};
}
/** The coded refusal one exhausted per-source cap answers with (A7 §3): the caller's next move is to stop, not to retry. */
var IterationCapRefusal = class extends Error {
	code = "iteration-cap";
	constructor(message$1) {
		super(message$1);
		this.name = "IterationCapRefusal";
	}
};
/** The input references one sibling task declares, across its criteria (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`). */
function declaredInputsOf(task) {
	return new Set(task.acceptanceCriteria.flatMap((criterion) => [
		...criterion.requiresArtifact ?? [],
		...criterion.acceptsArtifact ?? [],
		...(criterion.protectedInputs ?? []).map((input) => input.path)
	]));
}
/** One declaration's citation, resolved against the store, or the reasons it does not resolve. */
function citationDefects(declaration, context, at) {
	const defects = [];
	const sibling = context.snapshot.tasks.find((task) => task.taskId === declaration.taskId);
	if (sibling === void 0) return [`${at}: no task "${declaration.taskId}" exists in this store`];
	if (sibling.parentTaskId !== context.source.taskId) defects.push(`${at}: task "${sibling.taskId}" is a child of "${sibling.parentTaskId ?? "(none)"}", not of "${context.source.taskId}" — only a sibling of this attempt's own task is reusable`);
	if (sibling.status !== "verified") defects.push(`${at}: sibling "${sibling.taskId}" is ${sibling.status}, not verified — only a passed sibling's evidence is reusable`);
	const run = context.snapshot.runs.find((candidate) => candidate.runId === declaration.sourceRunId);
	if (run === void 0) {
		defects.push(`${at}: no run "${declaration.sourceRunId}" exists in this store`);
		return defects;
	}
	if (run.taskId !== declaration.taskId) defects.push(`${at}: run "${run.runId}" belongs to task "${run.taskId}", not to the cited sibling "${declaration.taskId}"`);
	if (run.status !== "verified") defects.push(`${at}: cited run "${run.runId}" is ${run.status}, not verified — only evidence of a verified run is reusable`);
	const bundle = context.snapshot.evidence.find((item) => item.evidenceId === declaration.evidenceId);
	if (bundle === void 0) {
		defects.push(`${at}: no evidence "${declaration.evidenceId}" exists in this store`);
		return defects;
	}
	if (bundle.taskRunId !== run.runId || bundle.taskId !== run.taskId) defects.push(`${at}: evidence "${bundle.evidenceId}" belongs to task "${bundle.taskId}"/run "${bundle.taskRunId}", not to the cited "${run.taskId}"/"${run.runId}"`);
	const products = new Set(bundle.artifacts.flatMap((artifact) => [artifact.artifactId, artifact.kind]));
	for (const reference of declaration.artifactRefs ?? []) if (!products.has(reference)) defects.push(`${at}: evidence "${bundle.evidenceId}" holds no artifact "${reference}" (by artifact id or kind)`);
	const inputs = declaredInputsOf(sibling);
	for (const reference of declaration.inputRefs ?? []) if (!inputs.has(reference)) defects.push(`${at}: sibling "${sibling.taskId}" declares no input "${reference}" (requiresArtifact, acceptsArtifact or protectedInputs)`);
	if (declaration.criterionId !== void 0) if (!sibling.acceptanceCriteria.some((criterion) => criterion.criterionId === declaration.criterionId)) defects.push(`${at}: sibling "${sibling.taskId}" declares no criterion "${declaration.criterionId}"`);
	else {
		const verdict = bundle.verifierResults.find((result) => result.criterionId === declaration.criterionId);
		if (verdict?.status !== "pass") defects.push(`${at}: criterion "${declaration.criterionId}" of sibling "${sibling.taskId}" carries ${verdict === void 0 ? "no verdict" : `a "${verdict.status}" verdict`} in evidence "${bundle.evidenceId}" — only a passing verdict is reusable`);
	}
	return defects;
}
/**
* Every reason the declared reuse cannot be a binding of the original
* acceptance map — the "invalid reference" refusal, with the affected item
*/
function reuseDefects(declarations, context) {
	const defects = [];
	const map = context.source.acceptanceCriteria.flatMap((criterion) => criterion.childEvidence ?? []);
	declarations.forEach((declaration, position) => {
		const at = `reuses[${position}]`;
		if (context.sourceRun === void 0) defects.push(`${at}: source task "${context.source.taskId}" failed without a run, so there is no member sequence to read position ${position} from; a reuse is bound to the positions of the failed attempt and cannot be checked against nothing`);
		else if (context.sourceMembers[declaration.childIndex] !== declaration.taskId) defects.push(`${at}: the failed run "${context.sourceRun.runId}" reads ${context.sourceMembers[declaration.childIndex] === void 0 ? "no member" : `"${context.sourceMembers[declaration.childIndex]}"`} at position ${declaration.childIndex}, not the cited "${declaration.taskId}"`);
		defects.push(...citationDefects(declaration, context, at));
		defects.push(...mapDefects(declaration, map, at));
		defects.push(...stalenessDefects(declaration, context.snapshot, at));
	});
	return defects;
}
/**
* Every reason a citation disagrees with the original acceptance map at the
* position it claims: the map narrows a position to a criterion, to an evidence
*/
function mapDefects(declaration, map, at) {
	const defects = [];
	const entry = map.find((item) => item.childIndex === declaration.childIndex);
	if (entry === void 0) return defects;
	if (entry.criterionId !== void 0 && entry.criterionId !== declaration.criterionId) defects.push(`${at}: the original acceptance map narrows position ${declaration.childIndex} to criterion "${entry.criterionId}", and this declaration ${declaration.criterionId === void 0 ? "names no criterion" : `names "${declaration.criterionId}"`}`);
	if (entry.evidenceRef !== void 0 && declaration.evidenceId !== entry.evidenceRef && !(declaration.artifactRefs ?? []).includes(entry.evidenceRef)) defects.push(`${at}: the original acceptance map narrows position ${declaration.childIndex} to evidence "${entry.evidenceRef}", which the cited bundle "${declaration.evidenceId}" does not carry (by evidence id, artifact id or artifact kind)`);
	return defects;
}
/**
* Whether the sibling's evidence still rests on what it rested on: every input
* reference its own criteria declare (`requiresArtifact` as a verified reference
*/
function stalenessDefects(declaration, snapshot, at) {
	const sibling = snapshot.tasks.find((task) => task.taskId === declaration.taskId);
	if (sibling === void 0) return [];
	return missingRequiredArtifacts(sibling.acceptanceCriteria, snapshot).map((issue) => `${at}: the sibling "${sibling.taskId}" declares ${issue.requirement === "requires" ? "a required product" : "a raw input"} "${issue.ref}" (criterion ${issue.criterionId}), which the store does not hold now as a ${issue.requirement === "requires" ? "verified reference product" : "usable input"}`);
}
/**
* What the failed run's own facts support as a reuse (plan §F.4: the binding
* comes from the store, never from a caller's parameters).
*/
function deriveReuse(context) {
	const sourceRun = context.sourceRun;
	if (sourceRun === void 0) return {
		bound: [],
		unbound: []
	};
	const slots = runMemberSlots(sourceRun);
	const map = context.source.acceptanceCriteria.flatMap((criterion) => criterion.childEvidence ?? []);
	const bound = [];
	const unbound = [];
	slots.forEach((taskId, childIndex) => {
		if (taskId === void 0) return;
		const sibling = context.snapshot.tasks.find((task) => task.taskId === taskId);
		if (sibling === void 0 || sibling.status !== "verified") return;
		const at = `position ${childIndex}`;
		const entry = map.find((item) => item.childIndex === childIndex);
		/**
		* The sibling's own verified run and the bundle under it: the two identities
		* the citation stands on. A missing one is *not* invented here — the citation
		*/
		const verifiedRun = context.snapshot.runs.find((run) => run.taskId === taskId && run.status === "verified");
		const bundle = context.snapshot.evidence.find((item) => item.taskRunId === verifiedRun?.runId);
		const declaration = {
			childIndex,
			taskId,
			sourceRunId: verifiedRun?.runId ?? "",
			evidenceId: bundle?.evidenceId ?? "",
			...entry?.criterionId === void 0 ? {} : { criterionId: entry.criterionId },
			artifactRefs: (bundle?.artifacts ?? []).flatMap((artifact) => [artifact.artifactId, artifact.kind]),
			inputRefs: [...declaredInputsOf(sibling)]
		};
		const reasons = [
			...citationDefects(declaration, context, at),
			...mapDefects(declaration, map, at),
			...stalenessDefects(declaration, context.snapshot, at)
		];
		if (reasons.length === 0) bound.push(declaration);
		else unbound.push({
			childIndex,
			taskId,
			...entry?.criterionId === void 0 ? {} : { criterionId: entry.criterionId },
			reasons
		});
	});
	return {
		bound,
		unbound
	};
}
/** The stored form of one declaration: the closed record the run carries. */
function storedReuse(declaration) {
	return {
		childIndex: declaration.childIndex,
		taskId: declaration.taskId,
		sourceRunId: declaration.sourceRunId,
		evidenceId: declaration.evidenceId,
		...declaration.criterionId === void 0 ? {} : { criterionId: declaration.criterionId },
		artifactRefs: [...declaration.artifactRefs ?? []],
		inputRefs: [...declaration.inputRefs ?? []]
	};
}

//#endregion
//#region src/service/root-recovery.ts
async function recoverRootTask(self, storeId, request, caller) {
	const defects = recoveryRequestDefects(request);
	if (defects.length > 0) throw new Error(`task-runtime: the recovery request was refused:\n- ${defects.join("\n- ")}`);
	if (typeof caller?.sessionId !== "string" || caller.sessionId.trim().length === 0) throw new Error("task-runtime: a recovery attempt is opened for the session that asks for it: pass a non-empty caller session id");
	if (self.agentOrUndefined(caller.sessionId) === void 0) throw new Error(`task-runtime: caller session "${caller.sessionId}" has no live agent, so the new attempt's Session cannot be spawned from it; nothing was written and no run was started`);
	await assertRecoveryCallerOwnsStore(self, storeId, caller);
	await assertRecoveryReady(self, storeId, "a recovery attempt");
	return await self.serializeRootIntake(storeId, () => recoverRootTaskOnce(self, storeId, request, caller));
}
async function assertRecoveryCallerOwnsStore(self, storeId, caller) {
	const sessionId = caller.sessionId;
	const graphs = self.context.graphs;
	if (graphs === void 0) throw new Error(`task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": this deployment has no graph registry, so its ownership of this store cannot be established; nothing was written`);
	let graph;
	try {
		graph = await graphs.graphForSession(SessionId(sessionId));
	} catch (error) {
		throw new Error(`task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": its graph could not be resolved (${message(error)}), so its ownership of this store cannot be established; nothing was written`);
	}
	const ownStoreId = rootTaskStoreId(graph.rootSessionId);
	if (ownStoreId !== storeId) throw new Error(`task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": its graph's root session is "${graph.rootSessionId}", whose store is "${ownStoreId}" — a recovery attempt is opened in the store of the caller's own graph, and nothing was written`);
}
/** The coded cap refusal (A7 §3): this source has spent its rounds of this kind — nothing is opened and nothing is written. */
function assertRoundCap(supervision, rounds, kind, sourceTaskId) {
	const [spent, cap, what] = kind === "improvement" ? [
		rounds.improvement,
		supervision.maxImprovementRounds,
		"improvement rounds"
	] : [
		rounds.recovery,
		supervision.maxRecoveryRounds,
		"recovery rounds"
	];
	if (spent < cap) return;
	throw new IterationCapRefusal(`task-runtime: the ${kind === "improvement" ? "improvement round" : "recovery"} of "${sourceTaskId}" was refused (iteration-cap): the source's ${what} are spent (${spent}/${cap}); no run was opened and the store's own facts stay as they are — a deployment raises the cap, no count is reset`);
}
async function recoverRootTaskOnce(self, storeId, request, caller) {
	await assertRecoveryCallerOwnsStore(self, storeId, caller);
	const sourceTaskId = request.sourceTaskId;
	const snapshot = await self.context.task.snapshotIn(storeId);
	const source = snapshot.tasks.find((task) => task.taskId === sourceTaskId);
	if (source === void 0) throw new Error(`task-runtime: store "${storeId}" holds no task "${sourceTaskId}", so there is nothing to recover; a recovery is asked of the store that owns the failed task`);
	if (source.parentTaskId !== void 0) throw new Error(`task-runtime: task "${sourceTaskId}" is a child of "${source.parentTaskId}"; a recovery attempt is opened for the store's own root task, and a child is re-run by a batch of its parent instead`);
	const answered = recoveryAttemptForRequest(snapshot, request);
	if (answered !== void 0) return answered;
	const diagnosis = (snapshot.diagnoses ?? []).find((item) => item.diagnosisId === request.sourceDiagnosisId);
	if (diagnosis === void 0) throw new Error(`task-runtime: store "${storeId}" holds no diagnosis "${request.sourceDiagnosisId}"; a recovery is asked for by a diagnosis of this store and by nothing else, so this hand-off names no fact here`);
	if (diagnosis.taskId !== sourceTaskId) throw new Error(`task-runtime: diagnosis "${request.sourceDiagnosisId}" is about task "${diagnosis.taskId}", not the named source "${sourceTaskId}"; the hand-off and the store disagree about which task failed, and nothing was written`);
	const inFlight = inFlightRecoveryAttempt(snapshot, sourceTaskId, request.sourceDiagnosisId);
	if (inFlight !== void 0) throw new Error(`task-runtime: diagnosis "${request.sourceDiagnosisId}" already has a recovery attempt in flight (run "${inFlight.runId}", session "${inFlight.sessionId}", key "${inFlight.recovery?.requestKey ?? "unknown"}"); key "${request.requestKey}" starts nothing — an attempt ends when its run settles, and a new key may be asked for after that`);
	const kind = recoveryKindOf(request.mode);
	if (kind === "improvement") {
		if (source.status !== "verified") throw new Error(`task-runtime: root task "${sourceTaskId}" is ${source.status}; an improvement round is opened for a verified source (one whose own attempt settled \`verified\`), and this is not one — a failed source is recovered without mode, or with mode "recovery"`);
	} else if (source.status === "verified") throw new Error(`task-runtime: root task "${sourceTaskId}" is verified — a successful source is not recovered by the recovery door, and nothing was written; a verified source accepts an improvement round, judged by the same original criteria: ask again with mode "improve"`);
	else if (source.status === "running" || source.status === "verifying") throw new Error(`task-runtime: root task "${sourceTaskId}" is ${source.status}: an attempt is in flight, and a recovery does not hot-swap a live run`);
	else if (source.status !== "failed" && source.status !== "blocked") throw new Error(`task-runtime: root task "${sourceTaskId}" is ${source.status}; a recovery attempt is opened for a failed task (a \`failed\` task, or a \`blocked\` one that never ran), and this is not one`);
	assertRoundCap(supervisionSettings(self), recoveryRoundsOf(snapshot, sourceTaskId), kind, sourceTaskId);
	const sourceRun = recoverySourceRun(source, request, snapshot, kind);
	assertRecoveryContract(source);
	/**
	* The binding comes from the store, not from the caller: a request that names
	* no reuse gets the citations the failed run's own facts support, and the
	*/
	const reuseContext = {
		source,
		...sourceRun === void 0 ? {} : { sourceRun },
		sourceMembers: sourceRun === void 0 ? [] : runMemberSlots(sourceRun),
		snapshot
	};
	const declared = request.reuses;
	const derived = declared === void 0 ? deriveReuse(reuseContext) : void 0;
	const declarations = declared ?? derived?.bound ?? [];
	const reuseReasons = reuseDefects(declarations, reuseContext);
	if (reuseReasons.length > 0) throw new Error(`task-runtime: the recovery of "${sourceTaskId}" was refused; the declared reuse does not resolve:\n- ${reuseReasons.join("\n- ")}`);
	const unbound = derived?.unbound ?? [];
	const manifest = self.resolveCapabilities(source.requestedCapabilities);
	if (manifest.missing.length > 0) throw new Error(`task-runtime: the recovery of "${sourceTaskId}" was refused: the capability gap this attempt is for is still open ([${manifest.missing.join(", ")}] resolve to no row in this deployment's table); apply the row that closes it, and the recovery re-reads what the deployment holds then — nothing was written`);
	const rootSessionId = sourceRun?.sessionId ?? self.recoverySessionFor(snapshot, storeId);
	const envPath = await self.envPathForSession(rootSessionId);
	const precheck = await self.providerPrecheck(Object.keys(manifest.capabilities), { ...envPath === void 0 ? {} : { cwd: envPath } });
	const refusals = providerRefusals(precheck);
	if (refusals.length > 0) throw new Error(`task-runtime: the recovery of "${sourceTaskId}" was refused by the provider pre-check:\n- ${refusals.join("\n- ")}`);
	const budget$1 = resolveRootBudget(snapshot, self.config.rootBudget ?? {});
	if (!budget$1.ok) {
		if (hasRootLimits(self.config.rootBudget)) throw new Error(`task-runtime: the recovery of "${sourceTaskId}" was refused: the root budget cannot be resolved: ${budget$1.reason}`);
	} else {
		const verdict = checkRunStart(snapshot, budget$1);
		if (!verdict.allowed) throw new Error(`task-runtime: the recovery of "${sourceTaskId}" was refused by the root budget: ${verdict.reason}; the ceiling is not raised by this entry and no count is reset — a person raises it through the budget-extension entry`);
	}
	return await startRecoveryAttempt(self, {
		storeId,
		source,
		request,
		...sourceRun === void 0 ? {} : { sourceRun },
		declarations,
		unbound,
		manifest,
		precheck,
		rootSessionId,
		actor: caller.sessionId,
		...caller.signal === void 0 ? {} : { signal: caller.signal }
	});
}
function recoveryAttemptForRequest(snapshot, request) {
	const existing = recoveryAttemptWithKey(snapshot, request.sourceTaskId, request.requestKey);
	if (existing === void 0) return void 0;
	const stored = existing.recovery;
	/**
	* The key is bound to the *request*, not to the binding it produced: a
	* request that names no reuse has its citations derived from the store (a
	*/
	const digest = stored.requestDigest ?? recoveryAttemptDigest(stored);
	const wanted = requestAttemptDigest(request);
	if (digest !== wanted) throw new Error(`task-runtime: request key "${request.requestKey}" already names a recovery attempt of "${request.sourceTaskId}" (run "${existing.runId}", session "${existing.sessionId}", request ${digest}); this request's content is ${wanted} — one key names one request, and a different request is a different key`);
	return {
		attempt: "existing",
		storeId: snapshot.id,
		sourceTaskId: request.sourceTaskId,
		sourceDiagnosisId: stored.sourceDiagnosisId,
		requestKey: stored.requestKey,
		runId: existing.runId,
		sessionId: existing.sessionId,
		status: existing.status,
		reusedMembers: stored.reusedMembers.map((member) => ({
			...member,
			artifactRefs: [...member.artifactRefs],
			inputRefs: [...member.inputRefs]
		})),
		unboundMembers: (stored.unboundMembers ?? []).map((entry) => ({
			...entry,
			reasons: [...entry.reasons]
		})),
		detail: `request key "${stored.requestKey}" already named this recovery attempt: run "${existing.runId}" is ${existing.status}${existing.finishedAt === void 0 ? "" : ` (finished ${existing.finishedAt})`}; nothing was written`
	};
}
function assertRecoveryContract(source) {
	const contract = source.contract;
	if (contract === void 0) throw new Error(`task-runtime: task "${source.taskId}" carries no contract, so its original acceptance cannot be read; a recovery binds its reuse to that acceptance, and nothing is guessed for a task that has none`);
	const disagreement = contract.objective !== source.objective ? "its objective" : canonicalize(contract.acceptanceCriteria) !== canonicalize(source.acceptanceCriteria) ? "its acceptance criteria" : canonicalize(contract.requiredCapabilities) !== canonicalize(source.requestedCapabilities) ? "its required capabilities" : void 0;
	if (disagreement !== void 0) throw new Error(`task-runtime: task "${source.taskId}"'s contract and its projection disagree on ${disagreement}; the original contract and acceptance criteria have to be one record before an attempt can be bound to them`);
	if (source.acceptanceCriteria.length === 0) throw new Error(`task-runtime: task "${source.taskId}" declares no acceptance criterion, so there is nothing the new attempt could be judged by`);
}
/** One compact metrics line from a review record: exactly the numbers it stored, or an explicit "none". */
function reviewMetricsLine(review) {
	const parts = [];
	const tokens = review.metrics?.tokens;
	if (tokens !== void 0) {
		const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
		parts.push(`tokens ${total} (uncached input ${tokens.uncachedInputTokens}, output ${tokens.outputTokens}, cache read ${tokens.cacheReadTokens}, cache write ${tokens.cacheWriteTokens})`);
	}
	const toolCalls = review.metrics?.toolCalls;
	if (toolCalls !== void 0) parts.push(`tool calls ${toolCalls.calls} (${toolCalls.failures} reported failures)`);
	if (review.metrics?.retries !== void 0) parts.push(`retries ${review.metrics.retries}`);
	if (review.durationMs !== void 0) parts.push(`durationMs ${review.durationMs}`);
	return parts.length === 0 ? "metrics: none recorded on the review." : `metrics: ${parts.join("; ")}.`;
}
/** The round before one attempt as a notice for the new attempt's own session: criterion verdicts and effort facts, read from the store. */
function priorRoundNotice(snapshot, source, sourceRun) {
	const review = snapshot.reviews.find((item) => item.taskId === source.taskId && item.runId === sourceRun.runId);
	if (review === void 0) return void 0;
	const criteria = review.criteria ?? [];
	const passed = criteria.filter((criterion) => criterion.verdict === "pass").length;
	const verdicts = criteria.length === 0 ? "no criterion verdict is stored on it" : `criteria passed ${passed}/${criteria.length} (${criteria.map((criterion) => `${criterion.criterionId} ${criterion.verdict}`).join(", ")})`;
	return [
		`task-runtime: the round before this attempt, read from the store — review of run "${review.runId}" (outcome ${review.outcome}): ${verdicts}.`,
		reviewMetricsLine(review),
		"The original acceptance criteria judge this attempt unchanged."
	].join("\n");
}
/** The same notice for a run the store resumed: the attempt's own recovery record names the round before it. */
function priorRoundNoticeForRun(snapshot, run) {
	if (run.recovery === void 0) return void 0;
	const source = snapshot.tasks.find((task) => task.taskId === run.taskId);
	if (source === void 0) return void 0;
	const cited = run.recovery.sourceRunId;
	const sourceRun = cited !== void 0 ? snapshot.runs.find((candidate) => candidate.runId === cited) : run.recovery.kind === "improvement" ? [...snapshot.runs].reverse().find((candidate) => candidate.taskId === run.taskId && candidate.status === "verified" && candidate.runId !== run.runId) : void 0;
	return sourceRun === void 0 ? void 0 : priorRoundNotice(snapshot, source, sourceRun);
}
async function startRecoveryAttempt(self, input) {
	const { storeId, source, request, declarations, manifest, rootSessionId, actor } = input;
	const runId = `r-${randomUUID()}`;
	const sessionId = `s-${randomUUID()}`;
	const kind = recoveryKindOf(request.mode);
	const reusedMembers = declarations.map(storedReuse);
	const recovery = {
		kind,
		sourceDiagnosisId: request.sourceDiagnosisId,
		requestKey: request.requestKey,
		...input.sourceRun === void 0 ? {} : { sourceRunId: input.sourceRun.runId },
		requestedAt: now(),
		requestDigest: requestAttemptDigest(request),
		reusedMembers,
		...input.unbound.length === 0 ? {} : { unboundMembers: input.unbound.map((entry) => ({
			...entry,
			reasons: [...entry.reasons]
		})) }
	};
	/**
	* The preset the worker will be mounted on, resolved once: the run records it
	* so a resume rebuilds the same composition rather than the deployment's
	*/
	const preset = resolvePreset(manifest, self.config.defaultPreset);
	const workspacePath = await self.workspacePathForSession(rootSessionId);
	let claimed;
	if (workspacePath !== void 0 && self.workspaces !== void 0) {
		await self.workspaces.claim(workspacePath, {
			kind: "run",
			storeId,
			taskId: source.taskId,
			runId,
			since: now()
		});
		claimed = self.workspaces.ownerOf(workspacePath);
	}
	let binding;
	try {
		binding = await bindRunProviders({
			storeId,
			runId,
			manifest,
			providers: input.precheck,
			table: self.config.capabilities,
			root: self.config.runBindingRoot
		});
		const run = {
			runId,
			taskId: source.taskId,
			sessionId,
			capabilitySnapshot: capabilitySnapshot(manifest),
			...preset === void 0 ? {} : { agentPreset: preset },
			...binding === void 0 ? {} : { providerBinding: binding },
			executionPhase: "active",
			recovery,
			artifacts: [],
			verifierResults: [],
			status: "running",
			startedAt: now()
		};
		await self.context.task.startRunIn(storeId, run, actor, { manifest });
		self.sessions.set(sessionId, {
			storeId,
			taskId: source.taskId,
			runId
		});
		self.startedSessions.add(sessionId);
		self.executionGate.setPhase(sessionId, "active");
		if (workspacePath !== void 0) self.sessionWorkspaces.set(sessionId, workspacePath);
	} catch (error) {
		if (workspacePath !== void 0 && claimed !== void 0) await self.workspaces?.release(workspacePath, claimed).catch((cause) => {
			self.warn(`workspace ${workspacePath} could not be released after a refused attempt (${message(cause)})`);
		});
		throw error;
	}
	/**
	* From here the attempt is a durable fact. A spawn that fails is settled on
	* the run, never left as a running attempt nothing drives.
	*/
	try {
		await spawnTaskWorker(await self.orchestrateEnv(actor, actor, workspacePath), {
			sessionId,
			name: `recovery of ${source.objective.trim().replace(/\s+/g, " ").slice(0, 32) || source.taskId}`,
			manifest,
			...binding === void 0 ? {} : { providerBinding: binding },
			...preset === void 0 ? {} : { agentPreset: preset },
			...workspacePath === void 0 ? {} : { cwd: workspacePath },
			...input.signal === void 0 ? {} : { signal: input.signal }
		});
	} catch (error) {
		const reason = message(error);
		const env = await self.orchestrateEnv(actor, actor, workspacePath);
		const run = (await self.context.task.snapshotIn(storeId).catch(() => void 0))?.runs.find((item) => item.runId === runId);
		if (run !== void 0 && run.status === "running") await settleRunFromRuntime(env, storeId, run, "failed", `the recovery attempt's worker could not be spawned: ${reason}`);
		if (workspacePath !== void 0 && claimed !== void 0) await self.workspaces?.release(workspacePath, claimed).catch((cause) => {
			self.warn(`workspace ${workspacePath} could not be released after a failed spawn (${message(cause)})`);
		});
		throw new Error(`task-runtime: the recovery attempt of "${source.taskId}" was opened (run "${runId}", session "${sessionId}") but its worker could not be spawned: ${reason}; the attempt's run was settled failed with this cause, and a new attempt needs a new request key`);
	}
	const after = await self.context.task.snapshotIn(storeId);
	const stored = after.runs.find((item) => item.runId === runId);
	if (input.sourceRun !== void 0) {
		const notice = priorRoundNotice(after, source, input.sourceRun);
		if (notice !== void 0) self.notify(sessionId, notice);
	}
	return {
		attempt: "started",
		storeId,
		sourceTaskId: source.taskId,
		sourceDiagnosisId: request.sourceDiagnosisId,
		requestKey: request.requestKey,
		runId,
		sessionId,
		status: stored?.status ?? "running",
		reusedMembers,
		unboundMembers: input.unbound.map((entry) => ({
			...entry,
			reasons: [...entry.reasons]
		})),
		detail: `a${kind === "improvement" ? "n improvement round" : " recovery attempt"} of "${source.taskId}" was opened: run "${runId}" in session "${sessionId}" under diagnosis "${request.sourceDiagnosisId}", key "${request.requestKey}"${reusedMembers.length === 0 ? "" : `, reading ${reusedMembers.length} already verified sibling member(s) at the position(s) ${reusedMembers.map((member) => member.childIndex).join(", ")}`}${input.unbound.length === 0 ? "" : `; ${input.unbound.length} position(s) whose passed sibling could not be bound (${input.unbound.map((entry) => `#${entry.childIndex}`).join(", ")}) are done again and the reasons are on the record`}; the original acceptance criteria judge it, and the store total it spends is the same one`
	};
}
function invalidateStoreRecovery(self, storeId) {
	const state = self.storeRecovery.get(storeId);
	if (state === void 0) return;
	if (state.status === "recovering") {
		state.cancelled = true;
		self.standDownPendingDrivers(state);
		state.release(false);
	} else self.storeRecovery.delete(storeId);
}
async function recoveryStatus(self, storeId) {
	const state = self.storeRecovery.get(storeId);
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
		snapshot = await self.context.task.openStore(storeId);
	} catch (error) {
		return {
			status: "not-activated",
			reason: message(error)
		};
	}
	for (const run of snapshot.runs) {
		if (run.status !== "running") continue;
		/**
		* Live work, not recovery's: a session this process started, or a session
		* whose agent is live here (a resumed root, a spawned worker still in its
		*/
		if (self.startedSessions.has(run.sessionId)) continue;
		if (self.agentOrUndefined(run.sessionId) !== void 0) continue;
		if (run.batchId !== void 0 && self.drivers.has(`${storeId}/${run.batchId}`)) continue;
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
async function assertRecoveryReady(self, storeId, entry) {
	const readiness = await recoveryStatus(self, storeId);
	if (readiness.status === "ready" || readiness.status === "not-activated") return;
	const because = readiness.status === "recovering" ? "its recovery barrier is still running; retry once the graph's activation completes" : readiness.status === "recovery-failed" ? `the last recovery failed: ${readiness.reason}; an explicit activation (adoptRoot) retries it` : readiness.status === "needs-recovery" ? `${readiness.reason}; only reading and cancelling are allowed` : `${readiness.reason}; await the graph's activation or adoptRoot before executing against this store`;
	throw new Error(`task-runtime: ${entry} on store "${storeId}" is refused: the store is ${readiness.status} — ${because}`);
}

//#endregion
//#region src/handoff.ts
/**
* The envelope passed from a parent run to the child it delegates to (RFC §18).
* This module builds and persists the DATA of a handoff and nothing else: what
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
//#region src/orchestration/observe.ts
/** Wait for the worker to go idle or fail; explicit cancellation stops its loop. */
async function awaitWorker(handle, signal) {
	const cancel = () => handle.agent.cancel({ kind: "parent" });
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		await handle.agent.whenIdle();
		return isAborted(signal) ? { kind: "aborted" } : { kind: "idle" };
	} catch (error) {
		return isAborted(signal) ? { kind: "aborted" } : {
			kind: "failed",
			reason: message(error)
		};
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}
/**
* One batch's children in the batch's own order, with each child's dependencies
* mapped from task ids back to batch positions: the store is the only source of
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
* Wait for one run's terminal status. The subscription is taken first (through
* {@link OrchestrateEnv.watchRun}, which subscribes and then reads the current
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
/** How long a batch waits for a settled run's own settlement to finish before adopting the state as it stands. */
const SETTLEMENT_TAIL_WINDOW_MS = 2e3;
/** How often that wait re-reads the gate's phase. Short: the tail it waits for is a store write away. */
const SETTLEMENT_POLL_MS = 5;
/**
* Wait for one run to be terminal *and* settled: the status event, and then the
* in-process settlement that wrote it — whose last act is closing the gate for
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
/** The reminder a worker that went idle without submitting gets once. */
function idleReminderText(run) {
	return `task-runtime: session ${run.sessionId} went idle without submitting its result. If the work is done, call task_submit_result with a summary and the evidence you produced — an idle session is not a completion. Continue the same run until you submit or it is explicitly cancelled.`;
}
/**
* Wait for the run's terminal state or batch cancellation.
* An active worker that goes idle gets one submission reminder; a worker waiting
*/
async function observeWorkerRun(env, storeId, task, run, handle, signal) {
	const recorded = waitRunSettled(env, storeId, run.runId, run.sessionId);
	recorded.catch(() => {});
	const terminal = recorded.then((status) => ({
		kind: "terminal",
		status
	}));
	for (;;) {
		const settled = await Promise.race([terminal, awaitWorker(handle, signal)]);
		if (settled.kind !== "idle") return settled;
		const current = await env.task.runIn(storeId, run.runId);
		if (isTerminalRun(current.status)) return {
			kind: "terminal",
			status: current.status
		};
		const phase = current.executionPhase;
		if (phase === "waiting_children" || phase === "submitted") return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: "parent" }), signal, terminal);
		if (agentIsRunning(handle)) continue;
		const snapshot = await env.task.snapshotIn(storeId);
		if (openProposalOf(snapshot, task.taskId, run.runId) !== void 0 || blockingQuestionsOf(snapshot, run.runId).length > 0) return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: "parent" }), signal, terminal);
		notifyOwner(env, run.sessionId, idleReminderText(run));
		return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: "parent" }), signal, terminal);
	}
}
/** Wait for the persisted terminal state or explicit cancellation. */
async function awaitWaitingTerminal(cancel, signal, terminal) {
	if (isAborted(signal)) {
		cancel?.();
		return { kind: "aborted" };
	}
	if (signal === void 0) return await terminal;
	let stop;
	const aborted = new Promise((resolve$1) => {
		stop = () => {
			cancel?.();
			resolve$1({ kind: "aborted" });
		};
		signal.addEventListener("abort", stop, { once: true });
	});
	try {
		return await Promise.race([terminal, aborted]);
	} finally {
		signal.removeEventListener("abort", stop);
	}
}
/**
* The cancellation one session's own agent exposes, when this deployment can
* resolve it — what the driver needs to end a wait it did not start (A4 §F.1).
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
/** Restore the same active Run/Session and observe its persisted settlement. */
async function awaitAdoptedWorkerWait(env, batch, item, run, dependencyTaskIds) {
	const resumed = await resumeAdoptedWorker(env, batch.storeId, run);
	if (resumed.status !== "live") throw new Error(`task-runtime: cannot continue run "${run.runId}" in Session "${run.sessionId}" : ${resumed.reason}`);
	/**
	* The block is *derived* from the store here, never assumed — this process wrote
	* no ask, and the wait it adopted may be an answered-but-unread one, where the
	*/
	env.gate.setQuestionsBlocked(run.sessionId, blockingQuestionsOf(await env.task.snapshotIn(batch.storeId), run.runId).length > 0);
	if (resumed.status === "live" && env.gate.phaseOf(run.sessionId) === void 0) env.gate.setPhase(run.sessionId, "active");
	const terminal = waitRunSettled(env, batch.storeId, run.runId, run.sessionId).then((status) => ({
		kind: "terminal",
		status
	}));
	const observation = await awaitWaitingTerminal(cancelAgentOf(env, run.sessionId), batch.signal, terminal);
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
*/
function batchEndMessageId(batchId) {
	return `m-batchend-${batchId}`;
}
/**
* The body one batch-end message carries, rendered from the store's own account
* of the batch: every member's terminal state and the evidence it left, and what
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
*/
function batchMembers(run, batchId) {
	const batch = run.batches?.find((candidate) => candidate.batchId === batchId);
	if (batch === void 0) throw new Error(`task-runtime: run "${run.runId}" records no batch "${batchId}", so the store does not name its members; a batch is read from the run that admitted it, never derived from the task's children`);
	return [...batch.memberTaskIds];
}
/**
* The end-of-batch results one store's own facts still owe (K1 §2, §5).
* A run that is `active` has no unfinished batch — `waiting_children → active`
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
*/
async function deliverBatchResult$1(env, result) {
	if (env.deliverBatchResult === void 0) return "unavailable";
	try {
		return await env.deliverBatchResult(result);
	} catch (error) {
		return `refused: ${message(error)}`;
	}
}

//#endregion
//#region src/orchestration/batch.ts
/**
* End one batch and hand the parent back its own decision (K1 §2) — the
* settlement a driver performs once every child has a terminal state.
*/
async function finishBatch(env, batch) {
	const snapshot = await env.task.snapshotIn(batch.storeId);
	const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId);
	/**
	* The batch's own members, read from the run's accumulated batches: the task's
	* children are every batch's, and a second batch must report (and drain) its
	*/
	const members = batchMembers(parentRun, batch.batchId);
	const outcomes = await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members);
	/**
	* A parent whose run already settled was settled by somebody else, and its batch
	* end is the store's record alone: the layer the batch took at admission — and
	*/
	if (parentRun.status !== "running") {
		await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
		return outcomes;
	}
	const childTaskIds = [...members];
	if (batch.signal.aborted) {
		/**
		* The cancellation is the batch's terminal cleanup, taken as it always was:
		* the run ends `cancelled` — never failed by a drain it was stopped before —
		*/
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
	/**
	* The unprocessed coordination items no longer hold the parent where it is
	* (K1 §2): the batch ends regardless of what the parent still owes or waits
	*/
	const blocked = blockingQuestionsOf(snapshot, batch.parentRunId).length > 0;
	/**
	* Every child's write convergence, before the parent is told the batch is over
	* (§3.3): a child settles through its own submission — which drained it — but a
	*/
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
	/**
	* The handback (§2): both drains are confirmed, so the batch's layer comes off
	* and the parent's own hold is on top again (§3.4) — confirmed stops first, then
	*/
	await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId);
	/**
	* The store's half of the handback (§1.3): one phase event says the run waits on
	* nothing and closes the batch it names, so a reader of the store sees the same
	*/
	await env.task.changeRunPhaseIn(batch.storeId, batch.parentTaskId, batch.parentRunId, env.actor, {
		phase: "active",
		batchId: batch.batchId
	});
	env.gate.setPhase(parentRun.sessionId, "active");
	env.gate.setQuestionsBlocked(parentRun.sessionId, blocked);
	/**
	* …and the parent is told: the batch's own outcomes, under the identity the
	* batch derives, delivered to the Session that waited. A re-delivery states
	*/
	const message$1 = batchEndMessageText(batch.batchId, outcomes);
	const delivery = await deliverBatchResult$1(env, {
		storeId: batch.storeId,
		runId: batch.parentRunId,
		batchId: batch.batchId,
		sessionId: parentRun.sessionId,
		messageId: batchEndMessageId(batch.batchId),
		text: message$1
	});
	/**
	* A `skipped` delivery is not an undelivered one: the parent run ended before
	* it could be told (a cancellation that won the race), and the
	*/
	if (delivery !== "delivered" && delivery !== "already-present" && delivery !== "skipped") notifyOwner(env, batch.callerSessionId, `task-runtime: ${batchSummary(batch.batchId, outcomes)}; ${message$1} (delivery: ${delivery})`);
	return outcomes;
}
/**
* Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
* and owned by the runtime rather than by the tool call that admitted it.
*/
async function driveBatch(env, batch) {
	/**
	* The batch's own members, read from the run the store records as its parent
	* ({@link batchMembers}): the fallback this used to have — the parent task's
	*/
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
		/**
		* This run's verdict is written before the batch's failure seam, and that order
		* is what makes it hold: the seam aborts the driver, whose abort settles an
		*/
		const status = await failSubmittedRun(env, storeId, task, run, relatedTaskIds, reason$1, anomalies);
		if (error instanceof VerifierUnavailableError) {
			const batchId = await parentBatchOf(env, storeId, task, run);
			if (batchId !== void 0) await env.failBatch?.(storeId, batchId, `verification is unavailable: ${reason$1}`);
		}
		return status;
	}
	/**
	* Cancellation wins over a verdict that arrives after it. The store settled this
	* run while the verifier worked, so its verdict is voided: no status (the store
	*/
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
*/
async function parentBatchOf(env, storeId, task, run) {
	if (run.parentRunId === void 0 || task.parentTaskId === void 0) return void 0;
	const parentRun = (await env.task.snapshotIn(storeId)).runs.find((candidate) => candidate.runId === run.parentRunId);
	if (parentRun === void 0 || parentRun.taskId !== task.parentTaskId) return void 0;
	return parentRun.batches?.find((batch) => batch.memberTaskIds.includes(task.taskId))?.batchId;
}

//#endregion
//#region src/orchestration/child.ts
/** Block reason for a child the batch never started because the caller cancelled it. */
const CANCELLED_BEFORE_START = "cancelled by the caller before this child started";
/**
* One child's outcome as the store records it. A child that never reached a
* terminal state in a settled batch has no outcome to report and is named
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
/**
* The evidence one child's own submission, verification, or failure left in the
* store. Read back rather than carried: the store is the truth about a run, and
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
*/
async function settleChildRun(env, storeId, child, verdict) {
	const { item, run, dependencyTaskIds } = child;
	const snapshot = await env.task.snapshotIn(storeId);
	const status = snapshot.runs.find((candidate) => candidate.runId === run.runId)?.status ?? run.status;
	if (isTerminalRun(status)) return adoptedOutcome(item.taskId, run.runId, status, snapshot);
	try {
		await env.task.markRunStatusIn(storeId, item.taskId, run.runId, verdict.status, env.actor, { ...verdict.localizedCause === void 0 ? {} : { reason: verdict.localizedCause } });
	} catch (error) {
		/**
		* Two settlement paths can reach one run at once: a child that decomposed in
		* turn is settled by its own nested batch while this driver is cancelling the
		*/
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
*/
async function startChildRound(env, batch, parentTask, parentRun, items, item, snapshot) {
	const task = taskOf(snapshot, item.taskId);
	if (task === void 0) throw new Error(`task-runtime: batch ${batch.batchId} names child "${item.taskId}", which the store does not hold`);
	const dependencyTaskIds = item.dependsOn.map((dependency) => items[dependency].taskId);
	const manifest = snapshot.capabilities[item.taskId];
	/**
	* The root budget is checked once per start, from the store's own count: the
	* limit is not resettable by a restart (§3.5). A refusal is monotone — the
	*/
	const budgetSnapshot = await env.task.snapshotIn(batch.storeId);
	const budget$1 = resolveRootBudget(budgetSnapshot, env.rootBudget ?? {});
	if (!budget$1.ok) {
		if (hasRootLimits(env.rootBudget)) return {
			kind: "adopted",
			outcome: await blockChild(env, batch.storeId, item, {
				reason: `the root budget cannot be resolved: ${budget$1.reason}`,
				blockers: []
			}, dependencyTaskIds)
		};
	} else {
		const verdict = checkRunStart(budgetSnapshot, budget$1);
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
			/**
			* A resumed batch carries no verdicts — the process that judged them is
			* gone — so the pre-check is re-run from this run's own viewpoint and a
			*/
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
	/**
	* The budget is charged here, before any worker exists: `TaskStarted` is the
	* record `maxRuns` counts, so a crash between this write and the spawn does
	*/
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
	/**
	* One writer at a time (§3.4): the batch's hold is handed to this child for
	* as long as it works. A workspace this process does not hold as expected is
	*/
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
		/**
		* The batch's own members, read from the run's accumulation on every round: the
		* parent task's children are every batch it ever admitted, so a second batch
		*/
		const members = batchMembers(parentRun, batch.batchId);
		/**
		* A parent whose run already settled was settled by somebody else — a
		* cancellation, a batch failure seam, or the driver above this one. The
		*/
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
			if (started.executionPhase === "active") {
				await awaitAdoptedWorkerWait(env, batch, item, started, item.dependsOn.map((dependency) => items[dependency].taskId));
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

//#endregion
//#region src/service/notify.ts
function registerTerminalReviewListener(self, listener) {
	self.terminalReviewListeners.add(listener);
	return () => {
		self.terminalReviewListeners.delete(listener);
	};
}
function notifyTerminalReview(self, fact) {
	for (const listener of self.terminalReviewListeners) try {
		const answer = listener(fact);
		if (answer !== void 0 && typeof answer.then === "function") answer.catch((error) => {
			self.warn(`store ${fact.storeId}: a terminal-review listener failed after review ${fact.taskId}${fact.runId === null ? "" : `#${fact.runId}`} [${fact.outcome}] (${message(error)})`);
		});
	} catch (error) {
		self.warn(`store ${fact.storeId}: a terminal-review listener failed after review ${fact.taskId}${fact.runId === null ? "" : `#${fact.runId}`} [${fact.outcome}] (${message(error)})`);
	}
}
function notify(self, sessionId, text$1) {
	const agent = self.agentOrUndefined(sessionId);
	if (agent === void 0 || typeof agent.followup !== "function") return;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: text$1
		}],
		source: {
			kind: "task-runtime",
			form: "notice",
			summary: boundContextSummary(text$1)
		}
	}));
}
function notifyWhenReady(self, sessionId, text$1) {
	const storeId = self.sessions.get(sessionId)?.storeId;
	const barrier = storeId === void 0 ? void 0 : self.storeRecovery.get(storeId);
	if (barrier !== void 0 && barrier.status === "recovering" && barrier.cancelled !== true) {
		barrier.pendingNotices.push({
			sessionId,
			text: text$1
		});
		return;
	}
	notify(self, sessionId, text$1);
}
/** Queue one owner notice without waking the session: a blocked run reads it in the request the answer's wake opens. */
function appendNotice(self, sessionId, text$1) {
	const agent = self.agentOrUndefined(sessionId);
	if (agent === void 0) return;
	agent.inbox.append("next-turn", createUserMessage({
		content: [{
			type: "text",
			text: text$1
		}],
		source: {
			kind: "task-runtime",
			form: "notice",
			summary: boundContextSummary(text$1)
		}
	}));
}
async function deliverBatchResult(self, result) {
	const barrier = self.storeRecovery.get(result.storeId);
	if (barrier !== void 0 && barrier.status === "recovering" && barrier.cancelled !== true) {
		barrier.pendingBatchResults.push(result);
		return "unavailable";
	}
	return await deliverBatchResultNow(self, result);
}
async function deliverBatchResultNow(self, result) {
	let run;
	try {
		run = await self.context.task.runIn(result.storeId, result.runId);
	} catch (error) {
		self.warn(`store ${result.storeId}: whether run "${result.runId}" is still running could not be read before the end-of-batch message for "${result.batchId}" was delivered (${message(error)}); nothing was delivered and the next activation retries`);
		return "unavailable";
	}
	if (run.status !== "running") return "skipped";
	const relay = self.context.agentRuntime;
	if (typeof relay?.ensureAgentMessageDelivered !== "function") {
		self.warn(`store ${result.storeId}: batch "${result.batchId}" ended with no message relay in this deployment; run "${result.runId}" was handed back active and its Session was not told`);
		return "unavailable";
	}
	try {
		const delivery = await relay.ensureAgentMessageDelivered({
			targetSessionId: SessionId(result.sessionId),
			senderSessionId: SessionId(result.sessionId),
			messageId: result.messageId,
			text: result.text
		});
		if (delivery.status === "delivered" || delivery.status === "already-present") return delivery.status;
		self.warn(`store ${result.storeId}: the end-of-batch message for "${result.batchId}" was not delivered to session ${result.sessionId} (${delivery.status}); the batch's facts stand and the next activation retries the delivery`);
		return delivery.status === "unavailable" ? "unavailable" : "refused";
	} catch (error) {
		self.warn(`store ${result.storeId}: the end-of-batch message for "${result.batchId}" could not be delivered (${message(error)})`);
		return "refused";
	}
}
async function redeliverBatchResult(self, storeId, batchId) {
	const found = await self.batchRecordIn(storeId, batchId);
	if (found === void 0) throw new Error(`task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; there is nothing to re-deliver`);
	const outcomes = await deriveChildOutcomes(self.context.task, storeId, found.taskId, found.memberTaskIds);
	return await deliverBatchResult(self, {
		storeId,
		runId: found.run.runId,
		batchId,
		sessionId: found.run.sessionId,
		messageId: batchEndMessageId(batchId),
		text: batchEndMessageText(batchId, outcomes)
	});
}
async function reconcileSessionJobs(self, sessionId) {
	const jobs = self.softService("jobs");
	const agent = self.agentOrUndefined(sessionId);
	if (jobs === void 0 || agent === void 0) return;
	const drained = await drainSession(self.executionGate, sessionId, {
		timeoutMs: self.config.writeDrainTimeoutMs,
		jobs,
		agent
	});
	if (!drained.confirmed) self.warn(`session ${sessionId}: managed work was not confirmed stopped: ${drained.pending.join("; ")}`);
}
/** Wake every session that still holds its unread message, with this site's own text. */
function wakeUnclaimed(self, entries, text$1) {
	for (const { sessionId, messageId } of entries) {
		if (!sessionHoldsPendingMessage(self, sessionId, messageId)) continue;
		notify(self, sessionId, text$1(messageId));
	}
}
function wakeUnclaimedBatchResults(self, unread) {
	wakeUnclaimed(self, unread, (messageId) => `task-runtime: this session was brought back after a restart with the result of a child batch it has not read (message "${messageId}" is still pending in its inbox); read it and act on it — the framework will not send a second copy`);
}
function sessionHoldsPendingMessage(self, sessionId, messageId) {
	const inbox = self.agentOrUndefined(sessionId)?.inbox;
	if (inbox === void 0) return false;
	return [...inbox.nextTurn ?? [], ...inbox.nextStep ?? []].some((message$1) => String(message$1.id) === messageId);
}

//#endregion
//#region src/orchestration/replay.ts
/**
* Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
* the store, run it once through the real spawn + verify chain — or straight
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
	/**
	* The run exists before the spawn attempt so a spawn refusal can still walk
	* it to a terminal state — same discipline as a batch child. Its birth phase
	*/
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
	/**
	* The execution binding this run is placed under (S4-E §Q3): the caller's frozen
	* model selection, as one *bound view* of the env that every wait and every spawn
	*/
	const bound = {
		...env,
		...init.agentOptions === void 0 ? {} : { agentOptions: init.agentOptions }
	};
	/**
	* The replay's content binding comes from the pre-check the caller carried
	* (`ReplayRunInit.providers`), not from a fresh discovery here: the identities
	*/
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
		/**
		* The overlay's roots stay in front (a candidate skill wins a same-name
		* collision for this worker), and the run's own snapshot follows: what the
		*/
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
* worker error — and report what the run settled
*/
async function settleReplayRun(env, storeId, task, run, settlement) {
	const current = await env.task.runIn(storeId, run.runId);
	if (isTerminalRun(current.status)) return await finishReplay(env, storeId, run, statusOutcome(current.status));
	try {
		await env.task.markRunStatusIn(storeId, task.taskId, run.runId, settlement.status, env.actor, { ...settlement.reason === void 0 ? {} : { reason: settlement.reason } });
	} catch (error) {
		/**
		* The store's own arbiter rule, as in `settleChildRun`: a run it now holds
		* terminal was settled by somebody else while this settlement was in flight,
		*/
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

//#endregion
//#region src/service/replay.ts
async function replayTask(self, storeId, championTaskId, options, callerSessionId) {
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
	await self.assertRecoveryReady(storeId, "a replay");
	const champion = await self.context.task.taskIn(storeId, championTaskId);
	if (champion.status !== "verified" && champion.status !== "failed") throw new Error(`task-runtime: champion task "${championTaskId}" is ${champion.status}; only a terminal (verified or failed) task can be replayed`);
	const championRunId = champion.runIds[champion.runIds.length - 1];
	const effective = options.contract ?? {
		objective: champion.objective,
		acceptanceCriteria: champion.acceptanceCriteria,
		requiredCapabilities: champion.requestedCapabilities
	};
	const table = {
		...self.config.capabilities,
		...options.overlay?.capabilityOverrides ?? {}
	};
	const manifest = resolveCapabilities(effective.requiredCapabilities, table);
	if (manifest.missing.length > 0) throw new Error(`task-runtime: replay of "${championTaskId}" cannot run: capability gap [${manifest.missing.join(", ")}] under the overlay`);
	/**
	* The checkout this replay's everything resolves against: the workspace the
	* caller named, resolved to its real path first so the claim, the cwd and the
	*/
	const named = options.workspace === void 0 ? void 0 : await normalizeWorkspacePath(options.workspace.path);
	const envPath = named ?? await self.envPathForSession(callerSessionId);
	/**
	* The same provider pre-check the ordinary decomposition runs (S1-C item 1),
	* from the replay's checkout and under the overlay's own capability
	*/
	const precheck = await self.providerPrecheck(Object.keys(manifest.capabilities), {
		...envPath === void 0 ? {} : { cwd: envPath },
		...options.overlay?.extraSkillRoots === void 0 ? {} : { extraRoots: [...options.overlay.extraSkillRoots] }
	}, table);
	const refusals = providerRefusals(precheck);
	if (refusals.length > 0) throw new Error(`task-runtime: provider pre-check rejected replay of "${championTaskId}":\n- ${refusals.join("\n- ")}`);
	/**
	* The replay path shares the ordinary decomposition's rules: the contract's
	* own structure (T1) and the P4 parent-acceptance declarations (contract 8).
	*/
	const label = `replay of "${championTaskId}"`;
	/**
	* Protected acceptance inputs are fixed the same way the ordinary path
	* fixes them (S1-V slice 2), against the replay caller's checkout: the
	*/
	const fixed = await fixCriteriaProtectedInputs(effective.acceptanceCriteria, envPath, label);
	const acceptanceDefects = [
		...fixed.reasons,
		...contractDefects(fixed.criteria, label),
		...independentAcceptanceDefects(fixed.criteria, champion.requiresIndependentAcceptance, label)
	];
	if (acceptanceDefects.length > 0) throw new Error(`task-runtime: replay of "${championTaskId}" rejected:\n- ${acceptanceDefects.join("\n- ")}`);
	await self.assertKnownVerifierRefs(fixed.criteria.map((criterion) => ({
		childIndex: 0,
		criterion
	})), `replay of "${championTaskId}"`);
	/**
	* The replayed task's contract: the lineage-tagged objective, the criteria
	* deep-copied (a candidate definition is the caller's object, not the
	*/
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
	/**
	* A replayed worker reads its context the way every task worker does (A2):
	* the replay task is parentless by design, so the store records no handoff
	*/
	const replaySnapshot = await self.context.task.snapshotIn(storeId);
	const replayBudget = resolveRootBudget(replaySnapshot, self.config.rootBudget ?? {});
	if (!replayBudget.ok) {
		if (hasRootLimits(self.config.rootBudget)) throw new Error(`task-runtime: replay of "${championTaskId}" refused: the root budget cannot be resolved: ${replayBudget.reason}`);
	} else {
		const startVerdict = checkRunStart(replaySnapshot, replayBudget);
		if (!startVerdict.allowed) throw new Error(`task-runtime: replay of "${championTaskId}" refused: ${startVerdict.reason}`);
	}
	const workspacePath = named ?? await self.workspacePathForSession(callerSessionId);
	const workspaceOwner = workspacePath === void 0 ? void 0 : await claimReplayWorkspace(self, workspacePath, storeId, callerSessionId, championTaskId, task.taskId);
	self.replayLineage.set(task.taskId, options.lineage);
	const controller = new AbortController();
	const run = async () => {
		try {
			const outcome = await runReplayTask(await self.orchestrateEnv(callerSessionId, callerSessionId, named), storeId, {
				task,
				manifest,
				providers: precheck,
				lineage: options.lineage,
				agentPreset: options.overlay?.presetOverride ?? resolvePreset(manifest, self.config.defaultPreset),
				...options.overlay?.extraSkillRoots === void 0 ? {} : { skillRoots: [...options.overlay.extraSkillRoots] },
				...options.agentOptions === void 0 ? {} : { agentOptions: { ...options.agentOptions } },
				spawn,
				championRunId
			}, {
				...options.signal === void 0 ? {} : { admission: options.signal },
				advance: controller.signal
			});
			/**
			* A named workspace is what the outcome of this replay reports: the
			* comparison report names the directory each side's run went through. An
			*/
			return named === void 0 ? outcome : {
				...outcome,
				workspace: named
			};
		} finally {
			if (workspacePath !== void 0 && workspaceOwner !== void 0) await releaseReplayWorkspace(self, workspacePath, workspaceOwner);
		}
	};
	const promise = run();
	/**
	* A replay is a driver like a batch is: the runtime owns its progress, so a
	* cancellation or an unload stops it. Its own promise never rejects — the
	*/
	const driverKey = `replay/${storeId}/${championTaskId}`;
	self.registerDriver(driverKey, storeId, controller, promise.then(() => [], () => []));
	try {
		return await promise;
	} finally {
		self.drivers.delete(driverKey);
	}
}
async function claimReplayWorkspace(self, workspace, storeId, callerSessionId, championTaskId, replayTaskId) {
	const registry = self.workspaces;
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
	const callerRunId = self.sessions.get(callerSessionId)?.runId;
	if (!(callerRunId !== void 0 && top.storeId === storeId && top.runId === callerRunId)) throw new WorkspaceBusyError(workspace, top, top.since, `a replay from session ${callerSessionId} cannot write into a checkout held by ${top.kind} ${top.taskId ?? top.batchId ?? ""}`);
	await registry.push(workspace, top, owner);
	return owner;
}
async function releaseReplayWorkspace(self, workspace, owner) {
	const registry = self.workspaces;
	if (registry === void 0) return;
	const { conflict } = await releaseLayer(registry, workspace, (top) => top.kind === owner.kind && top.runId === owner.runId && top.storeId === owner.storeId);
	if (conflict !== void 0) self.warn(`workspace ${workspace} was expected to hold the replay layer ${owner.runId ?? ""}, but holds ${describeOwner(conflict)}`);
}

//#endregion
//#region src/service/drivers.ts
function registerDriver(self, key, storeId, controller, promise, parentTaskId) {
	self.drivers.set(key, {
		controller,
		promise,
		storeId,
		...parentTaskId === void 0 ? {} : { parentTaskId }
	});
	const forget = () => {
		if (self.drivers.get(key)?.controller === controller) self.drivers.delete(key);
	};
	promise.then(forget, async (error) => {
		forget();
		const reason = `driver ${key} failed outside its own settlement: ${message(error)}`;
		self.warn(reason);
		await failBatchFromRuntime(self, storeId, key, reason);
	});
}
function standDownPendingDrivers(self, state) {
	for (const pending of state.pendingDrivers.splice(0)) {
		if (self.drivers.get(pending.key)?.controller === pending.controller) self.drivers.delete(pending.key);
		pending.controller.abort();
	}
}
async function failBatchFromRuntime(self, storeId, key, reason, outcome = "failed") {
	const prefix = `${storeId}/`;
	if (!key.startsWith(prefix)) return;
	const batchId = key.slice(prefix.length);
	const parts = settlementParts(self, `fail-batch:${storeId}`);
	try {
		const found = await batchRecordIn(self, storeId, batchId);
		if (found === void 0) return;
		await blockUnstartedChildren(parts, storeId, found.memberTaskIds, reason);
		const parentRun = await self.context.task.runIn(storeId, found.run.runId).catch(() => void 0);
		if (parentRun === void 0 || parentRun.status !== "running") return;
		await settleRunFromRuntime(parts, storeId, parentRun, outcome, `batch ${batchId} ${outcome}: ${reason}`);
	} catch (error) {
		self.warn(`store ${storeId}: the failed driver ${key} could not be settled (${message(error)})`);
	}
}
async function batchRecordIn(self, storeId, batchId) {
	const found = [...(await self.context.task.snapshotIn(storeId)).runs].reverse().flatMap((run) => (run.batches ?? []).map((batch) => ({
		run,
		batch
	}))).find((entry) => entry.batch.batchId === batchId);
	return found === void 0 ? void 0 : {
		taskId: found.run.taskId,
		run: found.run,
		memberTaskIds: [...found.batch.memberTaskIds]
	};
}
function batchHeldByRun(run, batchId) {
	return run.batches?.some((batch) => batch.batchId === batchId) === true;
}
function settlementParts(self, actor) {
	return {
		task: self.context.task,
		actor,
		notify: (sessionId, text$1) => {
			self.notify(sessionId, text$1);
		},
		observeSession: async (sessionId) => self.observeSession(sessionId),
		budget: { ...self.config.budget },
		onRunSettled: (storeId, taskId, runId, status) => {
			runSettledFromRuntime(self, storeId, taskId, runId, status);
		},
		onTerminalReview: (fact) => self.notifyTerminalReview(fact),
		gate: self.executionGate
	};
}
function runSettledFromRuntime(self, storeId, taskId, runId, status) {
	recomputeAskingSessions(self, storeId, runId);
	const sessionId = self.sessionBoundInProcess(storeId, runId);
	if (sessionId === void 0) return;
	self.executionGate.setTerminal(sessionId);
	self.releaseRunWorkspaceLayer(storeId, runId, sessionId).catch((error) => {
		self.warn(`run ${runId}: the workspace layer it held could not be released (${message(error)})`);
	}).finally(() => {
		if (self.sessionWorkspaces.size > 0) self.sessionWorkspaces.delete(sessionId);
		if (self.sessionExecutionBindings.size > 0) self.sessionExecutionBindings.delete(sessionId);
	});
}
async function recomputeAskingSessions(self, storeId, runId) {
	try {
		releaseAskingSessions(self.executionGate, await self.context.task.snapshotIn(storeId), runId);
	} catch (error) {
		self.warn(`store ${storeId}: the question blocks of the runs that asked run "${runId}" could not be recomputed after it settled (${message(error)})`);
	}
}
function reportUnsettledQuestionDeliveries(self, storeId, deliveries) {
	const unsettled = deliveries.filter((delivery) => delivery.status === "refused" || delivery.status === "unavailable");
	if (unsettled.length === 0) return;
	const counts = /* @__PURE__ */ new Map();
	for (const delivery of unsettled) counts.set(delivery.status, (counts.get(delivery.status) ?? 0) + 1);
	const byStatus = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${count} ${status}`).join(", ");
	self.warn(`store ${storeId}: ${unsettled.length} of ${deliveries.length} owed question message${deliveries.length === 1 ? "" : "s"} could not be settled (${byStatus}): ${unsettled.map((delivery) => `${delivery.subject} [${delivery.status}${delivery.reason === void 0 ? "" : `: ${delivery.reason}`}]`).join("; ")}. The Task records still hold these intents, no substitute parent is invented, and the next activation retries them`);
}
function startBatchDriver(self, options) {
	const key = `${options.storeId}/${options.batchId}`;
	if (self.drivers.has(key)) return;
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
	const barrier = self.storeRecovery.get(options.storeId);
	const gate$1 = barrier !== void 0 && barrier.status === "recovering" ? barrier : void 0;
	const promise = (async () => {
		if (gate$1 !== void 0) {
			gate$1.pendingDrivers.push({
				key,
				controller
			});
			if (!await Promise.race([gate$1.released, new Promise((resolve$1) => {
				controller.signal.addEventListener("abort", () => resolve$1(false), { once: true });
			})]) || controller.signal.aborted) return [];
		}
		return await driveBatch(await self.orchestrateEnv(options.callerSessionId, options.callerSessionId), {
			...batch,
			signal: controller.signal
		});
	})();
	registerDriver(self, key, options.storeId, controller, promise, options.parentTaskId);
}
async function submitResult(self, callerSessionId, spec, exec = {}) {
	if (spec.summary.trim().length === 0) throw new Error("task-runtime: a submission requires a non-empty summary of what was delivered");
	const { storeId, task, run } = await self.runForSession(callerSessionId);
	/**
	* The recovery door comes before the run's own verdicts (A2 §E): a store
	* this process has not recovered is refused by name even when the run
	*/
	await self.assertRecoveryReady(storeId, "a result submission");
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
	/**
	* A run hands its result in only when the references its own contract
	* declares are satisfied (A6 §F.4: "根最终提交必须检查产物已满足"). The
	*/
	const store = await self.context.task.snapshotIn(storeId);
	const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, store);
	if (missingArtifacts.length > 0) {
		for (const missing of missingArtifacts) await self.context.task.recordObligationIn(storeId, {
			obligationId: `o-${randomUUID()}`,
			goal: `artifact/evidence "${missing.ref}" required by task "${task.taskId}" criterion ${missing.criterionId} does not exist in the task store${missing.requirement === "requires" ? " as a verified reference product" : ""}`,
			criterion: missing.requirement === "requires" ? `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict` : `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id)`,
			sourceTaskId: task.taskId
		}, callerSessionId);
		throw new Error(`task-runtime: the submission of run "${run.runId}" was refused: ${missingArtifactReason(missingArtifacts)}; the result is not handed in while the contract's own references are unsatisfied — produce or run what closes the gap, then submit`);
	}
	const submission = {
		summary: spec.summary,
		evidenceRefs: [...spec.evidenceRefs ?? []],
		...spec.notes === void 0 ? {} : { notes: spec.notes },
		submittedAt: now(),
		origin: "worker"
	};
	/**
	* Admission closes first (§3.3): this event is what refuses the next write,
	* the next decomposition and a second submission. The drain that follows is
	*/
	await self.context.task.changeRunPhaseIn(storeId, task.taskId, run.runId, callerSessionId, {
		phase: "submitted",
		submission
	});
	self.executionGate.setPhase(callerSessionId, "submitted");
	const env = await self.orchestrateEnv(callerSessionId, callerSessionId);
	const lineage = self.replayLineage.get(task.taskId);
	/**
	* What this receipt is about: a run that admitted batches is judged on them
	* (K1 §4's accumulated membership), so its review record names its members —
	*/
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
async function cancelBatch(self, storeId, batchId, callerSessionId) {
	if (!batchId.startsWith("b-")) throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`);
	const parentRun = [...(await self.context.task.snapshotIn(storeId)).runs].reverse().find((run) => run.sessionId === callerSessionId);
	if (parentRun === void 0) throw new Error(`task-runtime: batch "${batchId}" cannot be cancelled by session "${callerSessionId}": no run of store "${storeId}" is bound to it`);
	if (parentRun.batchId !== batchId) throw new Error(`task-runtime: batch "${batchId}" is not the batch run "${parentRun.runId}" is waiting on (${parentRun.batchId === void 0 ? "it holds no unfinished batch" : `it waits on "${parentRun.batchId}"`}); a batch is cancelled by the run that admitted it, while it is in flight`);
	const parentTaskId = parentRun.taskId;
	if (parentRun.status !== "running" || parentRun.executionPhase !== "waiting_children") throw new Error(`task-runtime: batch "${batchId}" is not in flight (its parent run is ${parentRun.status}${parentRun.executionPhase === void 0 ? "" : ` in phase "${parentRun.executionPhase}"`}); there is nothing to cancel`);
	const entry = self.drivers.get(`${storeId}/${batchId}`);
	if (entry === void 0) throw new Error(`task-runtime: batch "${batchId}" is not being driven by this process (it may have settled, or it is waiting for recovery); cancel the graph instead`);
	entry.controller.abort();
	/**
	* The abort reaches the batches this one owns as well: a child that
	* decomposed in turn holds a batch of its own, and leaving its driver parked
	*/
	await abortDescendantBatches(self, storeId, parentTaskId);
	/**
	* The runs under this batch that are still in flight are settled as cancelled
	* here, rather than left to their aborted drivers: a child inside a
	*/
	await settleCancelledDescendants(self, storeId, parentTaskId, batchId, callerSessionId);
	const outcomes = await entry.promise;
	/**
	* A driver that never started (a recovery barrier stood it down when this
	* cancellation aborted it) settles nothing itself: the parent run and the
	*/
	const parentNow = await self.context.task.runIn(storeId, parentRun.runId).catch(() => void 0);
	if (parentNow !== void 0 && parentNow.status === "running") await failBatchFromRuntime(self, storeId, `${storeId}/${batchId}`, `the batch was cancelled by its caller before its driver started: ${batchId}`, "cancelled");
	return outcomes;
}
async function settleCancelledDescendants(self, storeId, taskId, batchId, callerSessionId) {
	const snapshot = await self.context.task.snapshotIn(storeId);
	const parentOf = new Map(snapshot.tasks.map((task) => [task.taskId, task.parentTaskId]));
	const under = (candidate) => {
		for (let current = parentOf.get(candidate); current !== void 0; current = parentOf.get(current)) if (current === taskId) return true;
		return false;
	};
	const runs = snapshot.runs.filter((run) => run.status === "running" && run.taskId !== taskId && under(run.taskId));
	if (runs.length === 0) return;
	const env = await self.orchestrateEnv(callerSessionId, `cancel-batch:${batchId}`);
	for (const run of runs) await settleRunFromRuntime(env, storeId, run, "cancelled", `the batch was cancelled while this child ran: ${batchId}`);
}
async function abortDescendantBatches(self, storeId, taskId) {
	let snapshot;
	try {
		snapshot = await self.context.task.snapshotIn(storeId);
	} catch (error) {
		self.warn(`store ${storeId}: the batches under "${taskId}" could not be listed (${message(error)}); only the batch itself was aborted`);
		return;
	}
	const parentOf = new Map(snapshot.tasks.map((task) => [task.taskId, task.parentTaskId]));
	const under = (candidate) => {
		for (let current = parentOf.get(candidate); current !== void 0; current = parentOf.get(current)) if (current === taskId) return true;
		return false;
	};
	const entries = [...self.drivers.entries()].filter(([, driver]) => {
		if (driver.storeId !== storeId || driver.parentTaskId === void 0) return false;
		return driver.parentTaskId !== taskId && under(driver.parentTaskId);
	});
	for (const [, driver] of entries) driver.controller.abort();
	await Promise.all(entries.map(([, driver]) => driver.promise.catch(() => [])));
}
async function cancelGraph(self, storeId, reason) {
	try {
		self.reindex(storeId, await self.context.task.snapshotIn(storeId));
	} catch (error) {
		self.warn(`store ${storeId}: it could not be read for the cancellation "${reason}" (${message(error)}), so nothing was cancelled`);
		return;
	}
	/**
	* The barrier below is in effect before it is durable, so the store is marked
	* as being closed *before* the gate loop: from here until this method returns,
	*/
	self.closingStores.add(storeId);
	/**
	* A cancellation invalidates the recovery handle (A2 §E): drivers a still
	* running barrier registered but not started stand down here — not-started
	*/
	self.invalidateStoreRecovery(storeId);
	try {
		for (const [sessionId, binding] of self.sessions) if (binding.storeId === storeId) self.executionGate.setTerminal(sessionId);
		const entries = [...self.drivers.values()].filter((entry) => entry.storeId === storeId);
		for (const entry of entries) entry.controller.abort();
		await Promise.all(entries.map((entry) => entry.promise.catch(() => [])));
		const snapshot = await self.context.task.snapshotIn(storeId);
		const env = await self.orchestrateEnv(self.recoverySessionFor(snapshot, storeId), `cancel-graph:${storeId}`);
		const stillRunning = snapshot.runs.filter((run) => run.status === "running");
		for (const run of stillRunning) await settleRunFromRuntime(env, storeId, run, "cancelled", `cancelled with the graph: ${reason}`);
		for (const run of stillRunning) await self.reconcileSessionJobs(run.sessionId);
		await self.releaseStoreWorkspace(storeId);
	} finally {
		self.closingStores.delete(storeId);
	}
}
async function awaitBatch(self, storeId, batchId) {
	if (!batchId.startsWith("b-")) throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`);
	const entry = self.drivers.get(`${storeId}/${batchId}`);
	if (entry !== void 0) return await entry.promise;
	const found = await batchRecordIn(self, storeId, batchId);
	if (found === void 0) throw new Error(`task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; a batch is read from the run that admitted it, never derived from its id`);
	return await deriveChildOutcomes(self.context.task, storeId, found.taskId, found.memberTaskIds);
}
/**
* Stop a `waiting_children` run whose batch this build cannot name: settle it
* cancelled by name instead of attributing a batch the store does not record.
*/
async function stopUnidentifiedBatch(self, env, storeId, run) {
	const reason = run.batchId === void 0 ? `recovery: run "${run.runId}" waits on its children but records no batch id, and a batch this build cannot name is not restarted` : `recovery: run "${run.runId}" waits on batch "${run.batchId}", which the run's own accumulation does not hold. A batch admitted before batches were identified by (parent run, proposal) is a stopped old state: this build cannot tell which run or which proposal admitted it, so it is not restarted and its ownership is not guessed at — the run is settled cancelled`;
	self.warn(`store ${storeId}: ${reason}`);
	await settleRunFromRuntime(env, storeId, run, "cancelled", reason);
	await self.reconcileSessionJobs(run.sessionId);
}
async function reconcileStore(self, storeId) {
	const snapshot = await self.context.task.snapshotIn(storeId);
	self.reindex(storeId, snapshot);
	const depthOf = (taskId) => snapshot.tasks.find((task) => task.taskId === taskId)?.depth ?? 0;
	const ordered = snapshot.runs.filter((run) => run.status === "running").sort((left, right) => depthOf(right.taskId) - depthOf(left.taskId));
	const env = await self.orchestrateEnv(self.recoverySessionFor(snapshot, storeId), `recovery:${storeId}`);
	const questionResumes = [];
	const waiting = [];
	const submitted = [];
	await self.rebuildWorkspaceOwnership(storeId);
	for (const run of ordered) {
		if (run.executionPhase === void 0) continue;
		if (run.providerBinding !== void 0) {
			const read = await self.readRunBinding(run.providerBinding);
			if (read !== void 0 && read.defects.length > 0) throw new Error(`task-runtime: run "${run.runId}" content binding changed:\n- ${read.defects.join("\n- ")}`);
		}
		if (rootTaskStoreId(run.sessionId) !== storeId && !self.startedSessions.has(run.sessionId) && run.submission?.origin !== "runtime") {
			const attempt = await resumeAdoptedWorker(env, storeId, run);
			if (attempt.status !== "live") throw new Error(`task-runtime: cannot continue run "${run.runId}" in Session "${run.sessionId}": ${attempt.reason}`);
			questionResumes.push({
				subject: `run "${run.runId}" (session "${run.sessionId}")`,
				status: "live"
			});
		}
		if (run.executionPhase === "waiting_children") {
			if (run.batchId === void 0 || !batchHeldByRun(run, run.batchId)) {
				await stopUnidentifiedBatch(self, env, storeId, run);
				continue;
			}
			waiting.push(run);
		} else if (run.executionPhase === "submitted") submitted.push(run);
	}
	for (const run of submitted) {
		const lineage = self.replayLineage.get(run.taskId);
		await settleSubmittedRun(env, storeId, run.taskId, run.runId, lineage === void 0 ? {} : { anomalies: [lineage] });
	}
	for (const run of waiting) startBatchDriver(self, {
		storeId,
		parentTaskId: run.taskId,
		parentRunId: run.runId,
		batchId: run.batchId,
		callerSessionId: run.sessionId,
		reason: `continued batch ${run.batchId} after a restart`
	});
	/**
	* The question deliveries this store still owes (A4 §F.1). This is the pass
	* a restart runs, and it runs it *after* the sessions the barrier brought
	*/
	const deliverQuestions = async () => {
		const deliveries = await reconcileQuestionDeliveries(self.questionCoordination(), storeId);
		reportUnsettledQuestionDeliveries(self, storeId, deliveries);
		await self.wakeUnclaimedQuestionMessages(storeId, deliveries);
		const barrier$1 = self.storeRecovery.get(storeId);
		const candidates = deliveries.filter((delivery) => delivery.status === "delivered" || delivery.status === "already-present");
		if (barrier$1 !== void 0 && candidates.length > 0) {
			const snapshot$1 = await self.context.task.snapshotIn(storeId);
			const targetOf = new Map(pendingQuestionMessages(snapshot$1).messages.map((message$1) => [message$1.messageId, message$1.targetSessionId]));
			for (const delivery of candidates) {
				const target = targetOf.get(delivery.messageId);
				if (target === void 0) continue;
				if (delivery.status === "delivered" || self.sessionHoldsPendingMessage(target, delivery.messageId)) barrier$1.wokenSessions.add(target);
			}
		}
		return deliveries;
	};
	/**
	* The end-of-batch results this store still owes (K1 §2, §5) — the second
	* delivery the pass makes, and the one a crash in the window between a batch's
	*/
	const deliverBatches = async () => {
		const owed = owedBatchResults(await self.context.task.snapshotIn(storeId));
		if (owed.length === 0) return;
		const unread = [];
		for (const entry of owed) try {
			if (await self.redeliverBatchResult(storeId, entry.batchId) === "already-present") unread.push({
				sessionId: entry.sessionId,
				messageId: batchEndMessageId(entry.batchId)
			});
		} catch (error) {
			self.warn(`store ${storeId}: the end-of-batch message for "${entry.batchId}" could not be re-derived (${message(error)}); the batch's facts stand and the next activation retries`);
		}
		self.wakeUnclaimedBatchResults(unread);
	};
	const barrier = self.storeRecovery.get(storeId);
	let questionDeliveries = [];
	if (barrier === void 0 || barrier.status !== "recovering") {
		questionDeliveries = await deliverQuestions();
		await deliverBatches();
	} else if (barrier.cancelled !== true) barrier.pendingQuestionDelivery = async () => {
		await deliverQuestions();
		await deliverBatches();
	};
	/**
	* The proposal pass comes last (T2/T3 §5–§6): a batch it admits is driven by
	* the driver it starts, and the workspace question is already settled above,
	*/
	return {
		unresolvedProposals: await self.reconcileProposals(storeId),
		questionDeliveries,
		questionResumes
	};
}
async function failBatch(self, storeId, batchId, reason) {
	const found = await batchRecordIn(self, storeId, batchId);
	if (found === void 0) return;
	self.drivers.get(`${storeId}/${batchId}`)?.controller.abort();
	const env = await self.orchestrateEnv(await self.sessionForStore(storeId), `fail-batch:${storeId}`);
	await blockUnstartedChildren(env, storeId, found.memberTaskIds, reason);
	const parentRun = (await self.context.task.snapshotIn(storeId)).runs.find((run) => run.runId === found.run.runId);
	if (parentRun === void 0 || parentRun.status !== "running") return;
	await settleRunFromRuntime(env, storeId, parentRun, "failed", reason);
}

//#endregion
//#region src/service/questions.ts
async function askParentQuestionImpl(self, callerSessionId, request) {
	const caller = await questionCaller(self, callerSessionId, "task_ask_parent");
	return await askParentQuestion(questionCoordination(self), caller, request);
}
async function answerParentQuestionImpl(self, callerSessionId, request) {
	const caller = await questionCaller(self, callerSessionId, "task_answer");
	/**
	* Nothing is settled here: what the answer changes is the *asking* run's own
	* block (recomputed by the question entry from the store) and its Session,
	*/
	return await answerParentQuestion(questionCoordination(self), caller, request);
}
async function questionCaller(self, callerSessionId, entry) {
	if (self.agentOrUndefined(callerSessionId) === void 0) throw new Error(`task-runtime: ${entry} needs a live caller session; "${callerSessionId}" has no live agent in this process, and the question identity comes from the live caller's own run`);
	let binding;
	try {
		binding = await self.runForSession(callerSessionId);
	} catch (error) {
		throw new Error(`task-runtime: ${entry} refused: ${message(error)}`, { cause: error });
	}
	await self.assertRecoveryReady(binding.storeId, entry);
	return {
		sessionId: callerSessionId,
		storeId: binding.storeId,
		runId: binding.run.runId,
		actor: callerSessionId
	};
}
function questionCoordination(self) {
	return {
		task: self.context.task,
		sessionQuery: self.context.sessionQuery,
		messages: self.context.agentRuntime,
		gate: self.executionGate
	};
}
async function wakeUnclaimedQuestionMessages(self, storeId, deliveries) {
	const unread = new Set(deliveries.filter((delivery) => delivery.status === "already-present").map((delivery) => delivery.messageId));
	if (unread.size === 0) return;
	const snapshot = await self.context.task.snapshotIn(storeId);
	const targets = /* @__PURE__ */ new Map();
	for (const message$1 of pendingQuestionMessages(snapshot).messages) if (unread.has(message$1.messageId)) targets.set(message$1.targetSessionId, message$1.messageId);
	wakeUnclaimed(self, [...targets].map(([sessionId, messageId]) => ({
		sessionId,
		messageId
	})), (messageId) => `task-runtime: this session was brought back after a restart with coordination input it has not read (message "${messageId}" is still pending in its inbox); read it and act on it — the framework will not send a second copy`);
}

//#endregion
//#region src/service/sessions.ts
async function resumeAdoptedWorkerSession(self, request) {
	const sessionId = request.run.sessionId;
	const continuing = self.startedSessions.has(sessionId);
	/**
	* A session already live here is one this process holds: the resume is not
	* repeated (it would be an ownership conflict by construction), and only the
	*/
	const live = self.agentOrUndefined(sessionId) !== void 0;
	const bound = self.sessions.get(sessionId);
	if (live && (bound === void 0 || bound.storeId !== request.storeId || bound.runId !== request.run.runId)) throw new Error(`task-runtime: Session "${sessionId}" is live under another owner or Run binding`);
	if (!live) {
		const graph = await self.context.graphs.graphForSession(SessionId(sessionId));
		await self.context.agentRuntime.resumeWorkerAgent({
			sessionId: SessionId(sessionId),
			scope: {
				graphStoreId: graph.graphStoreId,
				layoutStoreId: graph.layoutStoreId
			},
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
	}
	self.sessions.set(sessionId, {
		storeId: request.storeId,
		taskId: request.run.taskId,
		runId: request.run.runId
	});
	self.startedSessions.add(sessionId);
	await applyResumedSessionGate(self, request.storeId, sessionId, request.run.runId);
	if (!live) {
		const drained = await drainAdoptedSession(self, sessionId);
		if (!drained.confirmed) {
			await stopAdoptedSession(self, sessionId);
			throw new Error(`task-runtime: managed work of Session "${sessionId}" could not be confirmed stopped: ${drained.pending.join("; ")}`);
		}
	}
	const snapshot = await self.context.task.snapshotIn(request.storeId);
	const blockedOnOwnQuestion = blockingQuestionsOf(snapshot, request.run.runId).length > 0;
	const coordinationPending = request.run.executionPhase === "waiting_children" && pendingCoordinationOf(snapshot, request.run.runId).length > 0;
	if (!continuing && (request.run.executionPhase === "active" || coordinationPending)) {
		const prior = priorRoundNoticeForRun(snapshot, request.run);
		const notice = "task-runtime: continue this same Run from the persisted conversation. Check any interrupted tool action without a receipt before repeating it; handle any unresolved Task questions from the conversation, then continue work allowed in your current execution phase and submit when ready." + (prior === void 0 ? "" : `\n${prior}`);
		if (blockedOnOwnQuestion) appendNotice(self, sessionId, notice);
		else self.notifyWhenReady(sessionId, notice);
	}
	return { status: "live" };
}
async function applyResumedSessionGate(self, storeId, sessionId, runId) {
	const token = self.executionGate.decisionToken(sessionId);
	const snapshot = await self.context.task.snapshotIn(storeId);
	const run = snapshot.runs.find((candidate) => candidate.runId === runId);
	if (run === void 0) throw new Error(`task-runtime: resumed Run "${runId}" is absent from store "${storeId}"`);
	gatePhaseFromStore(self, sessionId, run, storeId, token);
	self.executionGate.applyStoreQuestionsBlocked(sessionId, blockingQuestionsOf(snapshot, runId).length > 0, token);
}
async function drainAdoptedSession(self, sessionId) {
	return await drainSession(self.executionGate, sessionId, {
		timeoutMs: self.config.writeDrainTimeoutMs,
		jobs: self.softService("jobs"),
		agent: self.agentOrUndefined(sessionId)
	});
}
async function stopAdoptedSession(self, sessionId) {
	try {
		await self.context.agentRuntime.stopAgents([SessionId(sessionId)]);
	} catch (error) {
		self.warn(`session ${sessionId}: the resumed worker could not be stopped again (${message(error)})`);
	}
}
async function rebuildWorkspaceOwnership(self, storeId) {
	const snapshot = await self.context.task.snapshotIn(storeId);
	const rootTaskId = snapshot.tasks.find((task) => task.parentTaskId === void 0)?.taskId;
	const rootRun = snapshot.runs.find((run$1) => run$1.status === "running" && rootTaskStoreId(run$1.sessionId) === storeId) ?? snapshot.runs.find((run$1) => run$1.status === "running" && run$1.taskId === rootTaskId && run$1.recovery !== void 0);
	if (rootRun === void 0) {
		await releaseStoreWorkspace(self, storeId);
		return;
	}
	const workspace = await workspacePathForSession(self, rootRun.sessionId);
	if (workspace === void 0) return;
	const held = self.workspaces.ownerOf(workspace);
	if (held !== void 0) {
		if (held.storeId !== storeId) throw new Error(`task-runtime: workspace ${workspace} is held by ${describeOwner(held)}`);
		return;
	}
	const adoption = await self.workspaces.reconcileAdopt(workspace);
	if (!adoption.adopted) throw new Error(`task-runtime: cannot take over workspace ${workspace}: ${adoption.reason}`);
	let owner = {
		kind: "run",
		storeId,
		taskId: rootRun.taskId,
		runId: rootRun.runId,
		since: now()
	};
	await self.workspaces.claim(workspace, owner);
	let run = rootRun;
	while (run.executionPhase === "waiting_children") {
		const batch = run.batches?.find((batch$1) => batch$1.batchId === run.batchId);
		if (batch === void 0) throw new Error(`task-runtime: Run "${run.runId}" has no identifiable persisted child batch`);
		const next = {
			kind: "batch",
			storeId,
			taskId: run.taskId,
			batchId: batch.batchId,
			since: now()
		};
		await self.workspaces.push(workspace, owner, next);
		owner = next;
		const children = snapshot.runs.filter((child) => child.status === "running" && batch.memberTaskIds.includes(child.taskId));
		if (children.length > 1) throw new Error(`task-runtime: batch "${batch.batchId}" holds multiple running workspace writers`);
		if (children.length === 0) break;
		run = children[0];
		const childOwner = {
			kind: "run",
			storeId,
			taskId: run.taskId,
			runId: run.runId,
			since: now()
		};
		await self.workspaces.push(workspace, owner, childOwner);
		owner = childOwner;
	}
}
async function releaseStoreWorkspace(self, storeId) {
	if (self.workspaces === void 0) return;
	const workspace = await workspacePathForSession(self, recoverySessionFor(self, void 0, storeId));
	if (workspace === void 0) return;
	for (;;) {
		const top = self.workspaces.ownerOf(workspace);
		if (top === void 0) return;
		if (top.storeId !== storeId) {
			self.warn(`workspace ${workspace} holds a layer of store ${top.storeId} (${top.kind}) while store ${storeId} is being cancelled; only this process's own layers are released here`);
			return;
		}
		await self.workspaces.release(workspace, top);
	}
}
function recoverySessionFor(self, snapshot, storeId) {
	const rootRun = snapshot?.runs.find((run) => run.taskId === snapshot.tasks.find((task) => task.parentTaskId === void 0)?.taskId);
	if (rootRun !== void 0) return rootRun.sessionId;
	for (const [sessionId, binding] of self.sessions) if (binding.storeId === storeId) return sessionId;
	return storeId;
}
async function sessionForStore(self, storeId) {
	try {
		return recoverySessionFor(self, await self.context.task.snapshotIn(storeId), storeId);
	} catch {
		return storeId;
	}
}
async function runForSession(self, sessionId) {
	const found = await lookupRun(self, sessionId);
	if (found === void 0) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`);
	return found;
}
function allowsRuntimeDecomposition(self) {
	return self.config.allowRuntimeDecomposition;
}
function gatePhaseFromStore(self, sessionId, run, storeId, token) {
	if (self.closingStores.has(storeId) && self.executionGate.phaseOf(sessionId) !== void 0) return;
	const phase = self.runGatePhase(run);
	if (phase === void 0) return;
	self.executionGate.applyStorePhase(sessionId, phase, token);
}
async function lookupRun(self, sessionId) {
	const binding = self.sessions.get(sessionId);
	if (binding !== void 0) {
		const resolved = await resolveBinding(self, binding);
		if (resolved !== void 0) return resolved;
		self.sessions.delete(sessionId);
	}
	let rootSessionId;
	try {
		rootSessionId = (await self.context.graphs.graphForSession(SessionId(sessionId))).rootSessionId;
	} catch {
		return;
	}
	const storeId = rootTaskStoreId(rootSessionId);
	let snapshot;
	try {
		snapshot = await self.context.task.openStore(storeId);
		reindex(self, storeId, snapshot);
	} catch {
		return;
	}
	const rebinding = self.sessions.get(sessionId);
	if (rebinding === void 0) return void 0;
	return await resolveBinding(self, rebinding);
}
async function resolveBinding(self, binding) {
	try {
		const [task, run] = await Promise.all([self.context.task.taskIn(binding.storeId, binding.taskId), self.context.task.runIn(binding.storeId, binding.runId)]);
		return {
			storeId: binding.storeId,
			task,
			run
		};
	} catch {
		return;
	}
}
function reindex(self, storeId, snapshot) {
	for (const run of snapshot.runs) self.sessions.set(run.sessionId, {
		storeId,
		taskId: run.taskId,
		runId: run.runId
	});
}
async function workspacePathForSession(self, sessionId) {
	const path = await self.envPathForSession(sessionId);
	if (path === void 0) return void 0;
	try {
		return await normalizeWorkspacePath(path);
	} catch (error) {
		self.warn(`workspace ownership is skipped for session ${sessionId}: ${message(error)}`);
		return;
	}
}
async function workspacePathFor(self, sessionId) {
	return self.envPathForSession(sessionId);
}
async function assertWorkspaceHeldBy(self, workspace, storeId, parentTask, parentRunId) {
	if (self.workspaces === void 0) return;
	const top = self.workspaces.ownerOf(workspace);
	if (top === void 0) throw new WorkspaceBusyError(workspace, void 0, void 0, `store ${storeId} does not hold this workspace in this process; the run ${parentRunId} would be writing into a checkout nobody claimed (claim it through the graph entry, or resolve the ownership marker first)`);
	if (top.storeId !== storeId) throw new WorkspaceBusyError(workspace, top, top.since, `it is held by another store (${top.storeId}), not by ${storeId}`);
	if (top.taskId === parentTask.taskId) return;
	/**
	* An ancestor of this task holds it: the delegation chain the nested-child
	* case walks (a grandchild's own decomposition happens under its parent's
	*/
	let ancestor = parentTask.parentTaskId;
	while (ancestor !== void 0) {
		if (top.taskId === ancestor) return;
		ancestor = await ancestorTaskIdFor(self, storeId, ancestor);
	}
	throw new WorkspaceBusyError(workspace, top, top.since, `it is held by ${top.kind} ${top.taskId ?? top.batchId ?? ""}, which is not run ${parentRunId}'s own run, its batch, or one of its ancestors`);
}
async function ancestorTaskIdFor(self, storeId, taskId) {
	try {
		return (await self.context.task.taskIn(storeId, taskId)).parentTaskId;
	} catch {
		return;
	}
}

//#endregion
//#region src/service/env.ts
const HUMAN_TOOLS = new Set([
	"hitl_ask",
	"hitl_approve",
	"ask_user_question"
]);
function toolResultFailed(data) {
	if (data.error !== void 0) return true;
	return data.message?.isError === true;
}
function skillNameFrom(rawArguments) {
	try {
		const parsed = JSON.parse(rawArguments);
		return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : void 0;
	} catch {
		return;
	}
}
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
function admissionContext(self) {
	const budget$1 = self.config.budget;
	return {
		maxDepth: self.config.maxDepth,
		maxChildren: self.config.maxChildren,
		auditOnly: {
			...budget$1.maxToolCalls === void 0 ? {} : { maxToolCalls: budget$1.maxToolCalls },
			...budget$1.tokens === void 0 ? {} : { tokens: budget$1.tokens },
			...budget$1.attempts === void 0 ? {} : { attempts: budget$1.attempts }
		}
	};
}
async function sessionEnv(self, sessionId) {
	/**
	* The whole resolution sits inside the `try`, service lookup included: on a
	* real Cordis context an absent service throws on property access
	*/
	try {
		const envBuilder = self.context.get?.("envBuilder") ?? self.context.envBuilder;
		if (envBuilder === void 0) return void 0;
		const graph = await self.context.graphs.graphForSession(SessionId(sessionId));
		return envBuilder.store.get(graph.envId);
	} catch {
		return;
	}
}
async function envPathForSession(self, sessionId) {
	const named = self.sessionWorkspaces.get(sessionId);
	if (named !== void 0) return named;
	return (await sessionEnv(self, sessionId))?.path;
}
function contractRefusal(parentTaskId, reasons) {
	return /* @__PURE__ */ new Error(`task-runtime: contract rejected decomposition of "${parentTaskId}":\n- ${reasons.join("\n- ")}`);
}
async function orchestrateEnv(self, callerSessionId, actor, workspace) {
	/**
	* A session this process already spawned into a named workspace keeps
	* working in it: the replay's own decomposition builds its env here, and the
	*/
	const named = workspace ?? self.sessionWorkspaces.get(callerSessionId);
	const workspacePath = named ?? await self.workspacePathForSession(callerSessionId);
	/**
	* …and it keeps running under what it was spawned under (S4-E §Q3): the frozen
	* model selection of the experiment it belongs to. The same session-level
	*/
	const binding = self.sessionExecutionBindings.get(callerSessionId);
	return {
		task: self.context.task,
		actor,
		...self.config.defaultPreset !== void 0 ? { defaultPreset: self.config.defaultPreset } : {},
		...self.config.runBindingRoot === void 0 ? {} : { runBindingRoot: self.config.runBindingRoot },
		verifyTimeoutMs: self.config.verifyTimeoutMs,
		budget: { ...self.config.budget },
		allowRuntimeDecomposition: self.config.allowRuntimeDecomposition,
		gate: self.executionGate,
		workspaces: self.workspaces,
		...workspacePath === void 0 ? {} : { workspacePath },
		...named === void 0 ? {} : { workerCwd: named },
		...binding?.agentOptions === void 0 ? {} : { agentOptions: binding.agentOptions },
		writeDrainTimeoutMs: self.config.writeDrainTimeoutMs,
		...self.config.rootBudget === void 0 ? {} : { rootBudget: { ...self.config.rootBudget } },
		precheck: (capabilities, cwd) => providerPrecheck(self, capabilities, { ...cwd === void 0 ? {} : { cwd } }),
		notify: (sessionId, text$1) => {
			self.notify(sessionId, text$1);
		},
		watchRun: (storeId, runId, callback) => watchRun(self, storeId, runId, callback),
		agentFor: (sessionId) => agentOrUndefined(self, sessionId),
		jobs: self.softService("jobs"),
		onRunSettled: (storeId, taskId, runId, status) => {
			self.runSettledFromRuntime(storeId, taskId, runId, status);
		},
		failBatch: (storeId, batchId, reason) => self.failBatch(storeId, batchId, reason),
		deliverBatchResult: (message$1) => self.deliverBatchResult(message$1),
		assertPreset: async (preset) => {
			const presets = self.context.get?.("agentPresets") ?? self.context.agentPresets;
			if (presets === void 0) return;
			await presets.resolve(preset);
		},
		resolvePermissionSpec: (name) => {
			const presets = self.context.get?.("permissionPresets") ?? self.context.permissionPresets;
			if (presets === void 0) throw new Error("task-runtime: permissionPresets service is not loaded; cannot rank declared permissions");
			return presets.resolve(name);
		},
		resolveMcpEnv: async () => {
			/**
			* The same graph env the verifier's cwd comes from; absent in test
			* contexts and in deployments without env-builder — a capability that
			*/
			const env = await sessionEnv(self, callerSessionId);
			if (env === void 0) return void 0;
			/**
			* A named workspace stands in for the env root: a server this run's
			* capability grants works in the checkout the worker works in, not in
			*/
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
			const parent = liveAgent(self, callerSessionId);
			/**
			* The session this spawn creates works where the spawn says it does, and
			* this process remembers it for as long as the run behind it: an
			*/
			const sessionWorkspace = request.cwd ?? named;
			if (sessionWorkspace !== void 0) self.sessionWorkspaces.set(request.sessionId, sessionWorkspace);
			/**
			* What the session *runs under* is remembered the same way (S4-E §Q3): a
			* replay's worker carries the experiment's frozen selection, and the
			*/
			if (request.agentOptions !== void 0) self.sessionExecutionBindings.set(request.sessionId, { agentOptions: request.agentOptions });
			return self.context.agentRuntime.spawn(parent, {
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
		resumeWorkerSession: (request) => self.resumeAdoptedWorkerSession(request),
		verifyRun: async (storeId, runId, options = {}) => {
			const verifier = runVerifier(self);
			if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new VerifierUnavailableError(`task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`);
			const cwd = named ?? await envPathForSession(self, callerSessionId);
			return verifier.verifyRun(storeId, runId, {
				...cwd === void 0 ? {} : { cwd },
				...options
			});
		},
		readLogTail: async (logRef) => runVerifier(self)?.logTail?.(logRef),
		observeSession: async (sessionId) => observeSession(self, sessionId),
		onTerminalReview: (fact) => self.notifyTerminalReview(fact),
		onRunBound: (sessionId, binding$1) => {
			self.sessions.set(sessionId, binding$1);
			self.startedSessions.add(sessionId);
		}
	};
}
function watchRun(self, storeId, runId, callback) {
	const listeners = [];
	const notifyFrom = async (snapshot) => {
		const run = snapshot.runs.find((candidate) => candidate.runId === runId);
		if (run === void 0 || run.status === "running") return;
		callback(run.status);
	};
	try {
		const off = self.context.on("task/change", (snapshot) => {
			if (snapshot.id !== storeId) return;
			notifyFrom(snapshot);
		});
		if (typeof off === "function") listeners.push(off);
	} catch (error) {
		self.warn(`cannot subscribe to task/change for store ${storeId}: ${message(error)}`);
	}
	(async () => {
		try {
			await notifyFrom(await self.context.task.snapshotIn(storeId));
		} catch {}
	})();
	return () => {
		for (const off of listeners) off();
	};
}
function sessionBoundInProcess(self, storeId, runId) {
	for (const [sessionId, binding] of self.sessions) if (binding.storeId === storeId && binding.runId === runId) return sessionId;
}
async function releaseRunWorkspaceLayer(self, storeId, runId, sessionId) {
	const workspace = await self.workspacePathForSession(sessionId);
	if (workspace === void 0 || self.workspaces === void 0) return;
	await releaseLayer(self.workspaces, workspace, (top) => top.kind === "run" && top.storeId === storeId && top.runId === runId);
}
async function observeSession(self, sessionId) {
	const tokens = sessionTokens(self, sessionId);
	const events = await sessionEvents(self, sessionId);
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
function sessionTokens(self, sessionId) {
	const sessions = self.softService("sessions");
	const projections = self.softService("sessionProjections");
	if (sessions === void 0 || projections === void 0) return void 0;
	try {
		const session = sessions.get(SessionId(sessionId));
		if (session === void 0) return void 0;
		return tokenUsageOf(projections.snapshot(session, ["tokenUsage"]).values.tokenUsage);
	} catch {
		return;
	}
}
async function sessionEvents(self, sessionId) {
	const query = self.softService("sessionQuery");
	if (query === void 0 || typeof query.readSession !== "function") return void 0;
	try {
		return (await query.readSession(SessionId(sessionId))).events;
	} catch {
		return;
	}
}
function softService(self, name) {
	return optionalService(self.context, name);
}
function runVerifier(self) {
	return self.softService("verifier");
}
async function registeredVerifierIdsImpl(self) {
	return registeredVerifierIds(self.context);
}
async function providerPrecheck(self, capabilities, view, table = self.config.capabilities) {
	const verifierRefs = await registeredVerifierIdsImpl(self);
	const commitLedger = self.softService("evolution");
	return precheckProviders({
		capabilities,
		table,
		view,
		...verifierRefs === void 0 ? {} : { verifierRefs },
		...commitLedger === void 0 ? {} : { commitLedger }
	});
}
async function capabilityProviderReport(self, sessionId, capabilities) {
	const envPath = await envPathForSession(self, sessionId);
	return providerPrecheck(self, capabilities ?? Object.keys(self.config.capabilities), { ...envPath === void 0 ? {} : { cwd: envPath } });
}
async function readRunBindingImpl(binding) {
	return readRunBinding(binding);
}
async function assertKnownVerifierRefs(self, declared, what) {
	const refs = declared.filter((item) => item.criterion.verifierRef !== void 0);
	if (refs.length === 0) return;
	const registered = await registeredVerifierIdsImpl(self);
	if (registered === void 0) throw new VerifierUnavailableError(`task-runtime: cannot validate verifierRef on ${what}: the verifier service is not loaded or cannot list its registry`);
	const unknown = refs.filter((item) => !registered.includes(item.criterion.verifierRef));
	if (unknown.length === 0) return;
	const detail = unknown.map((item) => `child ${item.childIndex} criterion "${item.criterion.criterionId}" references unknown verifier "${item.criterion.verifierRef}"`).join("; ");
	throw new Error(`task-runtime: admission rejected ${what}: ${detail}; registered verifiers: ${registered.join(", ")}`);
}
function liveAgent(self, sessionId) {
	const agent = agentOrUndefined(self, sessionId);
	if (agent === void 0) throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`);
	return agent;
}
function agentOrUndefined(self, sessionId) {
	const registry = self.softService("agents");
	if (registry === void 0) return void 0;
	try {
		return registry.get(sessionId);
	} catch {
		return;
	}
}

//#endregion
//#region src/service/runtime.ts
var TaskRuntime = class extends Service {
	static inject = [
		"task",
		"agentRuntime",
		"graphs",
		"sessionQuery"
	];
	static Config = ConfigSchema;
	config;
	sessions = /* @__PURE__ */ new Map();
	startedSessions = /* @__PURE__ */ new Set();
	drivers = /* @__PURE__ */ new Map();
	replayLineage = /* @__PURE__ */ new Map();
	sessionWorkspaces = /* @__PURE__ */ new Map();
	sessionExecutionBindings = /* @__PURE__ */ new Map();
	executionGate;
	closingStores = /* @__PURE__ */ new Set();
	storeRecovery = /* @__PURE__ */ new Map();
	workspaces;
	providerLoad;
	parentChains = /* @__PURE__ */ new Map();
	rootBudgetApproval;
	terminalReviewListeners = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		super(ctx, "taskRuntime");
		const rootBudget = config?.rootBudget === void 0 ? void 0 : { ...config.rootBudget };
		/**
		* A hard limit this deployment cannot execute is refused at load, not
		* accepted and quietly ignored (§3.5). The schema keeps unknown keys on the
		*/
		if (config?.budget !== void 0) {
			const unknown = Object.keys(config.budget).filter((key) => ![
				"maxToolCalls",
				"tokens",
				"attempts"
			].includes(key));
			if (unknown.length > 0) throw new Error(`task-runtime: budget names unsupported fields [${unknown.join(", ")}]`);
		}
		assertClosedRootBudget(rootBudget);
		assertRootBudgetConfig(rootBudget ?? {});
		assertGeneratedTaskReview(config?.generatedTaskReview);
		assertSupervisionConfig(config?.supervision);
		this.config = {
			capabilities: structuredClone(config?.capabilities ?? {}),
			...config?.defaultPreset !== void 0 ? { defaultPreset: config.defaultPreset } : {},
			verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
			maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
			maxChildren: config?.maxChildren ?? DEFAULT_MAX_CHILDREN,
			budget: {
				...DEFAULT_BUDGET,
				...config?.budget ?? {}
			},
			allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
			generatedTaskReview: config?.generatedTaskReview ?? DEFAULT_GENERATED_TASK_REVIEW,
			...config?.supervision === void 0 ? {} : { supervision: { ...config.supervision } },
			runBindingRoot: config?.runBindingRoot ?? defaultRunBindingRoot(),
			...rootBudget === void 0 ? {} : { rootBudget },
			writeDrainTimeoutMs: config?.writeDrainTimeoutMs ?? DEFAULT_WRITE_DRAIN_TIMEOUT_MS
		};
		this.executionGate = new ExecutionGate();
		this.workspaces = new WorkspaceRegistry({ markerRoot: join(this.config.runBindingRoot ?? defaultRunBindingRoot(), WORKSPACE_OWNERS_DIR) });
		/**
		* Unload (A3 §3.6): every driver is aborted and awaited, the gate closes for
		* every session this runtime tracks, and the workspace markers this process
		*/
		ctx.effect(() => () => this.unload());
	}
	async unload() {
		return unload(this);
	}
	async [Service.init]() {
		return serviceInit(this);
	}
	async providerLoadReport() {
		return providerLoadReport(this);
	}
	warn(message$1) {
		return warn(this, message$1);
	}
	get verifyTimeoutMs() {
		return verifyTimeoutMs(this);
	}
	get budget() {
		return budget(this);
	}
	get generatedTaskReview() {
		return generatedTaskReview(this);
	}
	get gate() {
		return gate(this);
	}
	resolveCapabilities(required) {
		return resolveCapabilitiesImpl(this, required);
	}
	listCapabilities() {
		return listCapabilities(this);
	}
	async applyCapabilityRow(name, entry, options = {}) {
		return applyCapabilityRow(this, name, entry, options);
	}
	async adoptRoot(storeId, rootSessionId) {
		return adoptRoot(this, storeId, rootSessionId);
	}
	async initializeStoreGates(storeId) {
		return initializeStoreGates(this, storeId);
	}
	runGatePhase(run) {
		return runGatePhase(run);
	}
	async intakeRootContract(storeId, rootSessionId, spec, options = {}) {
		return intakeRootContract(this, storeId, rootSessionId, spec, options);
	}
	async submitRootContractProposal(storeId, rootSessionId, spec, options = {}) {
		return submitRootContractProposal(this, storeId, rootSessionId, spec, options);
	}
	async decomposeAndRun(storeId, parentTaskId, parentRunId, callerSessionId, spec, exec = {}) {
		return decomposeAndRun(this, storeId, parentTaskId, parentRunId, callerSessionId, spec, exec);
	}
	async submitDecompositionProposal(storeId, parentTaskId, parentRunId, callerSessionId, spec, options = {}) {
		return submitDecompositionProposal(this, storeId, parentTaskId, parentRunId, callerSessionId, spec, options);
	}
	async continueProposal(storeId, proposalId, caller, options = {}) {
		return continueProposal(this, storeId, proposalId, caller, options);
	}
	async decideProposal(storeId, proposalId, decision, decidedBy, exec = {}) {
		return decideProposal(this, storeId, proposalId, decision, decidedBy, exec);
	}
	async cancelProposal(storeId, proposalId, caller) {
		return cancelProposal(this, storeId, proposalId, caller);
	}
	async proposalIn(storeId, proposalId) {
		return proposalIn(this, storeId, proposalId);
	}
	async proposalsForParent(storeId, parentTaskId) {
		return proposalsForParent(this, storeId, parentTaskId);
	}
	registerRootBudgetApproval(approval) {
		return registerRootBudgetApproval(this, approval);
	}
	registerTerminalReviewListener(listener) {
		return registerTerminalReviewListener(this, listener);
	}
	notifyTerminalReview(fact) {
		return notifyTerminalReview(this, fact);
	}
	async extendRootBudget(sessionId, host, request) {
		return extendRootBudget(this, sessionId, host, request);
	}
	async recoverRootTask(storeId, request, caller) {
		return recoverRootTask(this, storeId, request, caller);
	}
	async deriveBatch(identity, spec) {
		return deriveBatch(this, identity, spec);
	}
	manifestsOf(batch) {
		return manifestsOf(this, batch);
	}
	storedBatchOf(proposal) {
		return storedBatchOf(proposal);
	}
	async assertDecomposableRun(storeId, parentTask, parentRun, callerSessionId, signal) {
		return assertDecomposableRun(this, storeId, parentTask, parentRun, callerSessionId, signal);
	}
	async inFlightProposalsOf(storeId, parentRunId) {
		return inFlightProposalsOf(this, storeId, parentRunId);
	}
	async checkDerivedBatch(request) {
		return checkDerivedBatch(this, request);
	}
	async admitPrecheckedBatch(request) {
		return admitPrecheckedBatch(this, request);
	}
	async existingRootTask(storeId) {
		return existingRootTask(this, storeId);
	}
	async continueRootProposalIn(storeId, proposal) {
		return continueRootProposalIn(this, storeId, proposal);
	}
	async serializeRootIntake(storeId, work) {
		return serializeRootIntake(this, storeId, work);
	}
	async continueProposalIn(storeId, proposalId, caller, options) {
		return continueProposalIn(this, storeId, proposalId, caller, options);
	}
	async staleProposal(storeId, proposal, reason) {
		return staleProposal(this, storeId, proposal, reason);
	}
	async expireProposal(storeId, proposal, reason) {
		return expireProposal(this, storeId, proposal, reason);
	}
	async requireProposal(storeId, proposalId) {
		return requireProposal(this, storeId, proposalId);
	}
	async readProposal(storeId, proposalId) {
		return readProposal(this, storeId, proposalId);
	}
	async requestProposalReview(request) {
		return requestProposalReview(this, request);
	}
	async serializeParent(storeId, parentTaskId, work) {
		return serializeParent(this, storeId, parentTaskId, work);
	}
	async reconcileProposals(storeId) {
		return reconcileProposals(this, storeId);
	}
	async reconcileRootProposal(storeId, proposal, report) {
		return reconcileRootProposal(this, storeId, proposal, report);
	}
	async replayTask(storeId, championTaskId, options, callerSessionId) {
		return replayTask(this, storeId, championTaskId, options, callerSessionId);
	}
	registerDriver(key, storeId, controller, promise, parentTaskId) {
		return registerDriver(this, key, storeId, controller, promise, parentTaskId);
	}
	standDownPendingDrivers(state) {
		return standDownPendingDrivers(this, state);
	}
	invalidateStoreRecovery(storeId) {
		return invalidateStoreRecovery(this, storeId);
	}
	async batchRecordIn(storeId, batchId) {
		return batchRecordIn(this, storeId, batchId);
	}
	runSettledFromRuntime(storeId, taskId, runId, status) {
		return runSettledFromRuntime(this, storeId, taskId, runId, status);
	}
	startBatchDriver(options) {
		return startBatchDriver(this, options);
	}
	async submitResult(callerSessionId, spec, exec = {}) {
		return submitResult(this, callerSessionId, spec, exec);
	}
	async askParentQuestion(callerSessionId, request) {
		return askParentQuestionImpl(this, callerSessionId, request);
	}
	async answerParentQuestion(callerSessionId, request) {
		return answerParentQuestionImpl(this, callerSessionId, request);
	}
	questionCoordination() {
		return questionCoordination(this);
	}
	async cancelBatch(storeId, batchId, callerSessionId) {
		return cancelBatch(this, storeId, batchId, callerSessionId);
	}
	async cancelGraph(storeId, reason) {
		return cancelGraph(this, storeId, reason);
	}
	async awaitBatch(storeId, batchId) {
		return awaitBatch(this, storeId, batchId);
	}
	async reconcileStore(storeId) {
		return reconcileStore(this, storeId);
	}
	async wakeUnclaimedQuestionMessages(storeId, deliveries) {
		return wakeUnclaimedQuestionMessages(this, storeId, deliveries);
	}
	wakeUnclaimedBatchResults(unread) {
		return wakeUnclaimedBatchResults(this, unread);
	}
	sessionHoldsPendingMessage(sessionId, messageId) {
		return sessionHoldsPendingMessage(this, sessionId, messageId);
	}
	async resumeAdoptedWorkerSession(request) {
		return resumeAdoptedWorkerSession(this, request);
	}
	async rebuildWorkspaceOwnership(storeId) {
		return rebuildWorkspaceOwnership(this, storeId);
	}
	async releaseStoreWorkspace(storeId) {
		return releaseStoreWorkspace(this, storeId);
	}
	async failBatch(storeId, batchId, reason) {
		return failBatch(this, storeId, batchId, reason);
	}
	recoverySessionFor(snapshot, storeId) {
		return recoverySessionFor(this, snapshot, storeId);
	}
	async sessionForStore(storeId) {
		return sessionForStore(this, storeId);
	}
	async runForSession(sessionId) {
		return runForSession(this, sessionId);
	}
	allowsRuntimeDecomposition() {
		return allowsRuntimeDecomposition(this);
	}
	gatePhaseFromStore(sessionId, run, storeId, token) {
		return gatePhaseFromStore(this, sessionId, run, storeId, token);
	}
	async recoveryStatus(storeId) {
		return recoveryStatus(this, storeId);
	}
	/** The live barrier's deferred work; a store this process holds no barrier for has none to show. */
	recoveryState(storeId) {
		const state = this.storeRecovery.get(storeId);
		if (state === void 0) return void 0;
		return {
			wokenSessions: [...state.wokenSessions],
			pendingNotices: state.pendingNotices.map((notice) => ({ ...notice })),
			pendingBatchResults: state.pendingBatchResults.map((result) => ({ ...result })),
			...state.cancelled === void 0 ? {} : { cancelled: state.cancelled }
		};
	}
	async assertRecoveryReady(storeId, entry) {
		return assertRecoveryReady(this, storeId, entry);
	}
	reindex(storeId, snapshot) {
		return reindex(this, storeId, snapshot);
	}
	async workspacePathForSession(sessionId) {
		return workspacePathForSession(this, sessionId);
	}
	async workspacePathFor(sessionId) {
		return workspacePathFor(this, sessionId);
	}
	async assertWorkspaceHeldBy(workspace, storeId, parentTask, parentRunId) {
		return assertWorkspaceHeldBy(this, workspace, storeId, parentTask, parentRunId);
	}
	notify(sessionId, text$1) {
		return notify(this, sessionId, text$1);
	}
	notifyWhenReady(sessionId, text$1) {
		return notifyWhenReady(this, sessionId, text$1);
	}
	async deliverBatchResult(message$1) {
		return deliverBatchResult(this, message$1);
	}
	async deliverBatchResultNow(message$1) {
		return deliverBatchResultNow(this, message$1);
	}
	async redeliverBatchResult(storeId, batchId) {
		return redeliverBatchResult(this, storeId, batchId);
	}
	async reconcileSessionJobs(sessionId) {
		return reconcileSessionJobs(this, sessionId);
	}
	admissionContext() {
		return admissionContext(this);
	}
	async envPathForSession(sessionId) {
		return envPathForSession(this, sessionId);
	}
	contractRefusal(parentTaskId, reasons) {
		return contractRefusal(parentTaskId, reasons);
	}
	async orchestrateEnv(callerSessionId, actor, workspace) {
		return orchestrateEnv(this, callerSessionId, actor, workspace);
	}
	watchRun(storeId, runId, callback) {
		return watchRun(this, storeId, runId, callback);
	}
	sessionBoundInProcess(storeId, runId) {
		return sessionBoundInProcess(this, storeId, runId);
	}
	async releaseRunWorkspaceLayer(storeId, runId, sessionId) {
		return releaseRunWorkspaceLayer(this, storeId, runId, sessionId);
	}
	async observeSession(sessionId) {
		return observeSession(this, sessionId);
	}
	softService(name) {
		return softService(this, name);
	}
	async registeredVerifierIds() {
		return registeredVerifierIdsImpl(this);
	}
	async providerPrecheck(capabilities, view, table = this.config.capabilities) {
		return providerPrecheck(this, capabilities, view, table);
	}
	async capabilityProviderReport(sessionId, capabilities) {
		return capabilityProviderReport(this, sessionId, capabilities);
	}
	async readRunBinding(binding) {
		return readRunBindingImpl(binding);
	}
	async assertKnownVerifierRefs(declared, what) {
		return assertKnownVerifierRefs(this, declared, what);
	}
	liveAgent(sessionId) {
		return liveAgent(this, sessionId);
	}
	agentOrUndefined(sessionId) {
		return agentOrUndefined(this, sessionId);
	}
	/** Public alias of the protected `Service.ctx` for the extracted modules. */
	get context() {
		return this.ctx;
	}
};

//#endregion
//#region src/obligation.ts
/**
* Parse one obligations.yml text (JSON-compatible YAML) into templates,
* refusing malformed entries loudly — a template that cannot be read is a
*/
function parseObligationTemplates(text$1, source) {
	let raw;
	try {
		raw = JSON.parse(text$1);
	} catch (error) {
		throw new Error(`obligation: ${source} is not JSON-compatible YAML: ${message(error)}`);
	}
	if (!Array.isArray(raw)) throw new Error(`obligation: ${source} must be an array of templates`);
	return raw.map((entry, index) => {
		const label = `${source} entry ${index}`;
		if (typeof entry !== "object" || entry === null) throw new Error(`obligation: ${label} must be an object`);
		const candidate = entry;
		if (!nonBlank(candidate.id)) throw new Error(`obligation: ${label} requires a non-empty "id"`);
		if (!nonBlank(candidate.question)) throw new Error(`obligation: ${label} requires a non-empty "question"`);
		if (!nonBlank(candidate.evidenceForm)) throw new Error(`obligation: ${label} requires a non-empty "evidenceForm"`);
		const capabilities = candidate.typicalCapabilities ?? [];
		if (!Array.isArray(capabilities) || capabilities.some((item) => !nonBlank(item))) throw new Error(`obligation: ${label} "typicalCapabilities" must be an array of non-empty strings`);
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
* Load every `<repoRoot>/.agents/skills/<name>/references/obligations.yml`, in directory
* order. A pack without the file contributes nothing; an absent skills root
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
		const file = join(skillsRoot, entry.name, "references", "obligations.yml");
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
var src_default = TaskRuntime;

//#endregion
export { DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_BUDGET, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_SUPERVISION, DEFAULT_VERIFY_TIMEOUT_MS, ExecutionGate, IterationCapRefusal, SKILL_SIDECAR_FILE, TOOL_LABELS, TaskRuntime, VerifierUnavailableError, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, WorkspaceBusyError, WorkspaceRegistry, bindRunProviders, capabilityToolQuery, checkObligationCoverage, checkRunStart, contractDefects, decompositionIdentity, src_default as default, driveBatch, escalationHint, executionProviders, findRepoRoot, fixProtectedInputs, fixSpecProtectedInputs, inFlightRecoveryAttempt, isOpenProposal, loadObligationTemplates, loadSkillSidecar, normalizeDecomposition, openProposalOf, optionalService, owedBatchResults, parseObligationTemplates, precheckProviders, precheckReplacedCapabilityRow, priorRoundNotice, priorRoundNoticeForRun, protectedInputDefects, providerRefusals, readVerifiedFile, recoveryAttemptWithKey, recoveryKindOf, recoveryModeOf, recoveryRoundsOf, recoverySourceRun, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, resolveCapabilities, resolveRootBudget, serializeSkillSidecar, settleRunFromRuntime, sidecarWithSkillMd, skillContentDigest, skillContractDefects, skillContractDigest, skillSearchRoots, unlistableVerifierRefusal, validateSkillProvider, walkVerified, workerBaseline };