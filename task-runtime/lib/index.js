import { randomUUID } from "node:crypto";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { RootTaskSpec, rootTaskStoreId } from "@dangosys/dsh-singularity-task";

//#region src/capability.ts
/**
* Resolve required capability names against the configured registry.
* A required name that has an entry contributes its skills/tools/preset to the
* manifest; a name without an entry lands in `missing`. Closure is `closed`
* when nothing is missing, otherwise `gap`.
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
		capabilities[name] = {
			skills: [...entry.skills ?? []],
			tools: [...entry.tools ?? []],
			...entry.preset !== void 0 ? { preset: entry.preset } : {}
		};
	}
	return {
		capabilities,
		missing,
		closure: missing.length > 0 ? "gap" : "closed"
	};
}
/** Flatten a manifest's granted skills and tools into a run's capability snapshot. */
function capabilitySnapshot(manifest) {
	const granted = /* @__PURE__ */ new Set();
	for (const entry of Object.values(manifest.capabilities)) {
		for (const skill of entry.skills) granted.add(skill);
		for (const tool of entry.tools) granted.add(tool);
	}
	return [...granted].sort();
}
/** First preset named by a matched capability, else the configured default. */
function resolvePreset(manifest, defaultPreset) {
	for (const entry of Object.values(manifest.capabilities)) if (entry.preset !== void 0) return entry.preset;
	return defaultPreset;
}

//#endregion
//#region src/admission.ts
/** Modes whose criterion is executed by the command verifier and therefore needs `command`. */
const EXECUTABLE_MODES = [
	"deterministic",
	"simulation",
	"measurement"
];
/**
* Structural admission checks for one decomposition batch (RFC §36). Pure:
* every rule is validated up front and the caller persists only when the
* verdict is `ok`, so admission is atomic for the whole batch.
*/
function checkDecomposition(parent, children, existingEdges) {
	const reasons = [];
	const policy = parent.decompositionPolicy;
	if (!policy.allowed) reasons.push(`task "${parent.taskId}" decomposition is not allowed`);
	if (policy.maxDepth !== void 0 && parent.depth + 1 > policy.maxDepth) reasons.push(`task "${parent.taskId}" children would exceed maxDepth ${policy.maxDepth} (depth ${parent.depth + 1})`);
	if (policy.maxChildren !== void 0 && children.length > policy.maxChildren) reasons.push(`task "${parent.taskId}" would have ${children.length} children, above maxChildren ${policy.maxChildren}`);
	if (children.length === 0) reasons.push(`task "${parent.taskId}" decomposition requires at least one child`);
	const plannedEdges = [];
	children.forEach((child, index) => {
		const label = `child ${index} ("${child.taskId}")`;
		if (child.objective.trim().length === 0) reasons.push(`${label} objective must be non-empty`);
		if (child.acceptanceCriteria.length === 0) reasons.push(`${label} requires at least one acceptance criterion`);
		for (const criterion of child.acceptanceCriteria) if (EXECUTABLE_MODES.includes(criterion.verificationMode) && (criterion.command ?? "").trim().length === 0) reasons.push(`${label} criterion "${criterion.criterionId}" (${criterion.verificationMode}) requires a command`);
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
/** DFS over an edge list: true when `target` is reachable from `start`. */
function reaches(edges, start, target) {
	const seen = /* @__PURE__ */ new Set();
	const pending = [start];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === target) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const edge of edges) if (edge.from === current) pending.push(edge.to);
	}
	return false;
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
* reminder when the child may split further, and the rules — a few thousand
* tokens at most.
*/
function renderWorkerPrompt(handoff, childTask) {
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
			"- Keep changes scoped to this task; escalate conflicts through your parent."
		].join("\n")
	];
	if (childTask.decompositionStatus === "decomposable") blocks.push(decomposition);
	return `${blocks.join("\n\n")}\n`;
}

//#endregion
//#region src/orchestrate.ts
/** Raised when the verifier service (ticket C2) is not loaded in the context. */
var VerifierUnavailableError = class extends Error {
	name = "VerifierUnavailableError";
};
/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
const VERIFY_SAFETY_MARGIN_MS = 15e3;
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal) {
	return signal?.aborted === true;
}
function unmetMandatory(criteria, results) {
	return criteria.filter((criterion) => criterion.mandatory).flatMap((criterion) => {
		const result = results.find((item) => item.criterionId === criterion.criterionId);
		if (result?.status === "pass") return [];
		return [{
			criterionId: criterion.criterionId,
			detail: result === void 0 ? "no result" : `${result.status}${result.details === void 0 ? "" : ` (${result.details})`}`
		}];
	});
}
function failureReason(unmet) {
	return `mandatory criteria not satisfied: ${unmet.map((item) => `${item.criterionId} ${item.detail}`).join(", ")}`;
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
	/** Hand the verifier its own deadline and keep the safety net one margin behind it. */
	const verify = (runId) => withTimeout(env.verifyRun(storeId, runId, { timeoutMs: env.verifyTimeoutMs }), env.verifyTimeoutMs, runId);
	const blockRemaining = async (why) => {
		for (const index of remaining) {
			const taskId = plans[index].task.taskId;
			await env.task.markRunStatusIn(storeId, taskId, void 0, "blocked", env.actor, { reason: why(index) });
			outcomes[index] = {
				taskId,
				status: "blocked"
			};
		}
		remaining.clear();
	};
	while (remaining.size > 0) {
		if (isAborted(signal)) {
			for (const index$1 of remaining) outcomes[index$1] = {
				taskId: plans[index$1].task.taskId,
				status: "cancelled"
			};
			remaining.clear();
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
		const handoff = buildHandoff({
			parentTask,
			parentRun,
			childTask: plan.task,
			reason,
			callerSessionId,
			relevantEvidence: snapshot.evidence.filter((item) => dependencyTaskIds.includes(item.taskId)).map((item) => item.evidenceId)
		});
		await env.task.recordHandoffIn(storeId, handoff, env.actor);
		const sessionId = `s-${randomUUID()}`;
		const name = plan.task.objective.trim().replace(/\s+/g, " ").slice(0, 40) || `child-${index + 1}`;
		const agentPreset = resolvePreset(plan.manifest, env.defaultPreset);
		let handle;
		try {
			handle = await env.spawn({
				sessionId,
				name,
				prompt: renderWorkerPrompt(handoff, plan.task),
				...agentPreset !== void 0 ? { agentPreset } : {},
				...signal !== void 0 ? { signal } : {}
			});
		} catch {
			outcomes[index] = {
				taskId: childTaskId,
				status: "failed"
			};
			remaining.delete(index);
			continue;
		}
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
		env.onRunBound(sessionId, {
			storeId,
			taskId: childTaskId,
			runId: run.runId
		});
		const cancel = () => handle.agent.cancel({ kind: "parent" });
		signal?.addEventListener("abort", cancel, { once: true });
		let failed;
		let aborted = false;
		try {
			await handle.agent.whenIdle();
			signal?.throwIfAborted();
		} catch (error) {
			if (isAborted(signal)) aborted = true;
			else failed = message(error);
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
		if (aborted) {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "cancelled", env.actor, { reason: "aborted by caller" });
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "cancelled"
			};
			remaining.delete(index);
			for (const rest of remaining) outcomes[rest] = {
				taskId: plans[rest].task.taskId,
				status: "cancelled"
			};
			remaining.clear();
			break;
		}
		if (failed !== void 0) {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: failed });
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
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: message(error) });
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "failed"
			};
			remaining.delete(index);
			if (error instanceof VerifierUnavailableError) {
				for (const rest of remaining) outcomes[rest] = {
					taskId: plans[rest].task.taskId,
					status: "failed"
				};
				remaining.clear();
				throw error;
			}
			continue;
		}
		const unmet = unmetMandatory(plan.task.acceptanceCriteria, bundle.verifierResults);
		if (unmet.length === 0) {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "verified", env.actor);
			outcomes[index] = {
				taskId: childTaskId,
				runId: run.runId,
				status: "verified",
				evidenceId: bundle.evidenceId
			};
			verified.add(index);
		} else {
			await env.task.markRunStatusIn(storeId, childTaskId, run.runId, "failed", env.actor, { reason: failureReason(unmet) });
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
		return settled;
	}
	await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "verifying", env.actor);
	try {
		const parentBundle = await verify(parentRun.runId);
		const parentUnmet = unmetMandatory(parentTask.acceptanceCriteria, parentBundle.verifierResults);
		if (parentUnmet.length === 0) await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "verified", env.actor);
		else await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "failed", env.actor, { reason: failureReason(parentUnmet) });
	} catch (error) {
		await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, "failed", env.actor, { reason: message(error) });
		if (error instanceof VerifierUnavailableError) throw error;
	}
	return settled;
}

//#endregion
//#region src/index.ts
const DEFAULT_VERIFY_TIMEOUT_MS = 600 * 1e3;
const DEFAULT_CAPABILITIES = {
	"design-chip": { skills: ["chip-designer"] },
	"design-ball": {
		skills: ["ball-align"],
		tools: ["filesystem", "bash"]
	},
	"check-ball-registration": { skills: ["check"] },
	"verify-ball-functional": {
		skills: ["verify"],
		preset: "bb-verify"
	},
	"run-bemu-regression": {
		skills: ["verify"],
		preset: "bb-verify"
	},
	"run-verilator-regression": {
		skills: ["verify"],
		preset: "bb-verify"
	},
	"analyze-waveform": { skills: ["waveform"] },
	"research": { preset: "default" }
};
const Capability = z.object({
	skills: z.array(z.string()),
	tools: z.array(z.string()),
	preset: z.string()
});
const ConfigSchema = z.object({
	capabilities: z.dict(Capability).default({ ...DEFAULT_CAPABILITIES }),
	defaultPreset: z.string(),
	verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS)
});
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function normalizeCriteria(criteria, childIndex) {
	return criteria.map((criterion, index) => ({
		criterionId: `ac${childIndex + 1}-${index + 1}`,
		description: criterion.description,
		verificationMode: criterion.mode ?? (criterion.command !== void 0 ? "deterministic" : "review"),
		requiredEvidence: [...criterion.requiredEvidence ?? []],
		mandatory: criterion.mandatory ?? true,
		...criterion.command !== void 0 ? { command: criterion.command } : {}
	}));
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
			verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
		};
	}
	/** Resolve required capability names against the configured registry. */
	resolveCapabilities(required) {
		return resolveCapabilities(required, this.config.capabilities);
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
		const task = {
			taskId: `t-${randomUUID()}`,
			definitionRef: {
				taskType: RootTaskSpec.taskType,
				version: RootTaskSpec.version
			},
			objective: options.objective,
			depth: 0,
			acceptanceCriteria: RootTaskSpec.acceptanceCriteria.map((criterion) => ({
				...criterion,
				requiredEvidence: [...criterion.requiredEvidence]
			})),
			requestedCapabilities: [...RootTaskSpec.requiredCapabilities],
			decompositionStatus: "decomposable",
			status: "created",
			runIds: [],
			childTaskIds: []
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
	* Atomic decomposition plus the sequential run cascade: structural admission
	* and capability admission must pass for the whole batch before anything is
	* persisted; children then run one at a time in dependency order.
	*/
	async decomposeAndRun(storeId, parentTaskId, parentRunId, callerSessionId, spec, exec = {}) {
		const actor = callerSessionId;
		const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId);
		const parentRun = await this.ctx.task.runIn(storeId, parentRunId);
		if (parentRun.taskId !== parentTaskId) throw new Error(`task-runtime: run "${parentRunId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`);
		if (parentRun.sessionId !== callerSessionId) throw new Error(`task-runtime: run "${parentRunId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`);
		if (!Array.isArray(spec.children) || spec.children.length === 0) throw new Error("task-runtime: decomposition requires at least one child");
		const childTaskIds = spec.children.map(() => `t-${randomUUID()}`);
		const criteria = spec.children.map((child, index) => normalizeCriteria(child.acceptanceCriteria, index));
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const verdict = checkDecomposition({
			...parentTask,
			decompositionPolicy: { allowed: parentTask.decompositionStatus !== "leaf" }
		}, spec.children.map((child, index) => ({
			taskId: childTaskIds[index],
			objective: child.objective,
			acceptanceCriteria: criteria[index],
			dependsOn: child.dependsOn
		})), snapshot.edges);
		if (!verdict.ok) throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join("\n- ")}`);
		const manifests = spec.children.map((child) => this.resolveCapabilities(child.requiredCapabilities ?? []));
		const rejected = spec.children.map((child, index) => ({
			child,
			index,
			manifest: manifests[index]
		})).filter(({ child, manifest }) => manifest.missing.length > 0 && child.decomposable !== true);
		if (rejected.length > 0) {
			const detail = rejected.map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(", ")}] and may not decompose`).join("; ");
			throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}`);
		}
		const children = spec.children.map((child, index) => ({
			taskId: childTaskIds[index],
			definitionRef: {
				taskType: "subtask",
				version: 1
			},
			parentTaskId,
			objective: child.objective,
			depth: parentTask.depth + 1,
			acceptanceCriteria: criteria[index],
			requestedCapabilities: [...child.requiredCapabilities ?? []],
			decompositionStatus: child.decomposable === true || manifests[index].missing.length > 0 ? "decomposable" : "leaf",
			status: "created",
			runIds: [],
			childTaskIds: []
		}));
		const edges = spec.children.flatMap((child, to) => (child.dependsOn ?? []).map((from) => ({
			from: childTaskIds[from],
			to: childTaskIds[to]
		})));
		await this.ctx.task.decomposeIn(storeId, parentTaskId, children, actor, edges);
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
		const plans = children.map((task, index) => ({
			task,
			manifest: manifests[index],
			dependsOn: spec.children[index].dependsOn ?? []
		}));
		return runChildrenCascade(this.orchestrateEnv(callerSessionId, actor), storeId, parentTask, parentRun, plans, spec.reason, callerSessionId, exec.signal);
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
	orchestrateEnv(callerSessionId, actor) {
		return {
			task: this.ctx.task,
			actor,
			...this.config.defaultPreset !== void 0 ? { defaultPreset: this.config.defaultPreset } : {},
			verifyTimeoutMs: this.config.verifyTimeoutMs,
			spawn: (request) => {
				const parent = this.liveAgent(callerSessionId);
				return this.ctx.agentRuntime.spawn(parent, {
					sessionId: SessionId(request.sessionId),
					name: request.name,
					prompt: [{
						type: "text",
						text: request.prompt
					}],
					...request.agentPreset !== void 0 ? { agentPreset: request.agentPreset } : {},
					...request.signal !== void 0 ? { signal: request.signal } : {}
				});
			},
			verifyRun: async (storeId, runId, options = {}) => {
				const verifier = this.ctx.get?.("verifier") ?? this.ctx.verifier;
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
			onRunBound: (sessionId, binding) => {
				this.sessions.set(sessionId, binding);
			}
		};
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
export { DEFAULT_CAPABILITIES, DEFAULT_VERIFY_TIMEOUT_MS, TaskRuntime, VerifierUnavailableError, buildHandoff, checkDecomposition, src_default as default, renderWorkerPrompt, resolveCapabilities, runChildrenCascade };