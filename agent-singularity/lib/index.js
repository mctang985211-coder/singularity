import { Context, Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";

//#region src/hitl.ts
var HitlService = class extends Service {
	waiters = /* @__PURE__ */ new Map();
	lifetime = new AbortController();
	constructor(ctx) {
		super(ctx, "hitl");
		ctx.effect(() => () => this.lifetime.abort(/* @__PURE__ */ new Error("hitl: service disposed")), "hitl: waiters");
	}
	list() {
		return [...this.waiters.values()].map((w) => w.pending);
	}
	ask(sessionId$6, prompt, signal) {
		if (prompt.trim().length === 0) throw new Error("hitl: ask prompt is empty");
		return this.enqueue(sessionId$6, "ask", prompt, signal).then((answer) => {
			if (answer.kind !== "ask") throw new Error("hitl: expected ask answer");
			return answer.text;
		});
	}
	approve(sessionId$6, prompt, signal) {
		if (prompt.trim().length === 0) throw new Error("hitl: approve prompt is empty");
		return this.enqueue(sessionId$6, "approve", prompt, signal).then((answer) => {
			if (answer.kind !== "approve") throw new Error("hitl: expected approve answer");
			return answer.decision;
		});
	}
	answer(id, answer) {
		const waiter = this.waiters.get(id);
		if (waiter === void 0) throw new Error(`hitl: unknown request "${id}"`);
		if (waiter.pending.kind !== answer.kind) throw new Error(`hitl: kind mismatch for "${id}"`);
		if (answer.kind === "ask" && answer.text.trim().length === 0) throw new Error("hitl: empty ask answer");
		if (answer.kind === "approve" && answer.decision !== "approve" && answer.decision !== "reject") throw new Error("hitl: invalid approval decision");
		waiter.dispose();
		this.waiters.delete(id);
		waiter.resolve(answer);
		this.ctx.emit("hitl/change", this.list());
	}
	enqueue(sessionId$6, kind, prompt, callerSignal) {
		const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (typeof sessionId$6 !== "string" || sessionId$6.length === 0) throw new Error("hitl: missing session id");
		const id = randomUUID();
		const pending = {
			id,
			kind,
			prompt,
			sessionId: sessionId$6,
			createdAt: Date.now()
		};
		const abort = () => {
			this.waiters.get(id).reject(signal.reason);
			this.waiters.delete(id);
			this.ctx.emit("hitl/change", this.list());
		};
		const promise = new Promise((resolve, reject) => {
			this.waiters.set(id, {
				pending,
				resolve,
				reject,
				dispose: () => signal.removeEventListener("abort", abort)
			});
			signal.addEventListener("abort", abort, { once: true });
		});
		this.ctx.emit("hitl/change", this.list());
		return promise.finally(() => signal.removeEventListener("abort", abort));
	}
};

//#endregion
//#region src/tools/approve.ts
const text$6 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$5(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("hitl_approve: missing agent id");
	return id;
}
function defineApproveTool(ctx) {
	return defineTool({
		name: "hitl_approve",
		description: "Request human approve/reject and wait. Use before irreversible or sensitive actions.",
		parameters: { prompt: {
			type: "string",
			required: true,
			description: "Approval request shown to the human"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$6(v)
		},
		execute: async (args, exec) => {
			return await ctx.hitl.approve(sessionId$5(exec), args.prompt, exec.signal);
		}
	});
}

//#endregion
//#region src/tools/ask.ts
const text$5 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$4(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("hitl_ask: missing agent id");
	return id;
}
function defineAskTool(ctx) {
	return defineTool({
		name: "hitl_ask",
		description: "Ask the human a text question and wait for the answer. Use for environment setup or decisions that need human input.",
		parameters: { prompt: {
			type: "string",
			required: true,
			description: "Question shown to the human"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$5(v)
		},
		execute: async (args, exec) => {
			return await ctx.hitl.ask(sessionId$4(exec), args.prompt, exec.signal);
		}
	});
}

//#endregion
//#region src/tools/mark-ready.ts
const text$4 = (value) => [{
	type: "text",
	text: value
}];
function defineMarkReadyTool(ctx) {
	return defineTool({
		name: "graph_mark_ready",
		description: "Mark the current Singularity graph ready after environment setup is complete. Required before free-form human chat.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$4(v)
		},
		execute: async (_args, exec) => {
			const sessionId$6 = exec.agent?.id;
			if (sessionId$6 === void 0) throw new Error("graph_mark_ready: missing agent id");
			const graph = await ctx.graphs.graphForSession(sessionId$6);
			await ctx.graphs.markReady(graph.id);
			return `graph ${graph.id} ready`;
		}
	});
}

//#endregion
//#region src/tools/spawn.ts
function defineSpawnTool(ctx) {
	return defineTool({
		name: "graph_spawn",
		description: "Delegate one task to a new Singularity worker node and wait for its final response.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Short worker name shown on the graph"
			},
			task: {
				type: "string",
				required: true,
				description: "Complete task for the worker"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const handle = await ctx.agentRuntime.spawn(exec.agent, {
				sessionId: SessionId(randomUUID()),
				name: args.name,
				prompt: [{
					type: "text",
					text: args.task
				}],
				signal: exec.signal
			});
			const cancel = () => handle.agent.cancel({ kind: "parent" });
			exec.signal.addEventListener("abort", cancel, { once: true });
			try {
				await handle.agent.whenIdle();
				exec.signal.throwIfAborted();
			} finally {
				exec.signal.removeEventListener("abort", cancel);
			}
			const event = [...handle.agent.session.snapshotEvents()].reverse().find((item) => item.type === "assistant/message");
			if (event === void 0 || event.type !== "assistant/message") throw new Error(`graph_spawn: worker ${handle.agent.id} produced no response`);
			const result = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (result.length === 0) throw new Error(`graph_spawn: worker ${handle.agent.id} produced no text response`);
			return `Worker ${handle.agent.id} completed:\n${result}`;
		}
	});
}

//#endregion
//#region src/tools/task-decompose.ts
const text$3 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$3(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_decompose: missing agent id");
	return id;
}
function renderOutcome(outcome) {
	const run = outcome.runId === void 0 ? "" : ` run ${outcome.runId}`;
	const evidence = outcome.evidenceId === void 0 ? "" : ` evidence ${outcome.evidenceId}`;
	return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`;
}
function defineTaskDecomposeTool(ctx) {
	return defineTool({
		name: "task_decompose",
		description: "Decompose the caller's current task into child tasks, then run them one at a time in dependency order. Each child is verified independently; only verified children count as done.",
		parameters: {
			reason: {
				type: "string",
				required: true,
				description: "Why this delegation is needed; recorded in each child handoff"
			},
			children: {
				type: "array",
				required: true,
				description: "Child tasks to admit and run",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						objective: {
							type: "string",
							required: true,
							description: "Complete, self-contained goal of the child task"
						},
						acceptanceCriteria: {
							type: "array",
							required: true,
							description: "How a verifier decides the child is done",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									description: {
										type: "string",
										required: true,
										description: "What must hold true"
									},
									command: {
										type: "string",
										description: "Shell command; exit code 0 proves the criterion (deterministic modes)"
									},
									mode: {
										type: "string",
										enum: [
											"deterministic",
											"simulation",
											"formal",
											"measurement",
											"review",
											"composite"
										],
										description: "Verifier kind; defaults to deterministic when a command is given, review otherwise"
									},
									mandatory: {
										type: "boolean",
										description: "Whether the criterion must pass; default true"
									},
									requiredEvidence: {
										type: "array",
										items: { type: "string" },
										description: "Evidence kinds the verifier must attach"
									}
								}
							}
						},
						requiredCapabilities: {
							type: "array",
							items: { type: "string" },
							description: "Capability names the child needs"
						},
						dependsOn: {
							type: "array",
							items: { type: "integer" },
							description: "Indices of sibling children that must verify before this one starts"
						},
						decomposable: {
							type: "boolean",
							description: "Declare that this child should split further instead of doing the work: its worker is told to call task_decompose. Together with a capability gap this decides whether the child is admitted as decomposable."
						}
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$3(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$3(exec);
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			let outcomes;
			try {
				outcomes = await ctx.taskRuntime.decomposeAndRun(storeId, task.taskId, run.runId, caller, {
					reason: args.reason,
					children: args.children
				}, { signal: exec.signal });
			} catch (error) {
				return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return [`decomposed ${task.taskId} into ${outcomes.length} children:`, ...outcomes.map(renderOutcome)].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-read.ts
const text$2 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$2(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_read: missing agent id");
	return id;
}
function latestRun(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.runs.find((run) => run.runId === runId);
}
function defineTaskReadTool(ctx) {
	return defineTool({
		name: "task_read",
		description: "Read the caller's task contract. The root session sees the root task, its acceptance criteria, and child task statuses; a worker sees its own task and run.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$2(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId$2(exec);
			const graph = await ctx.graphs.graphForSession(caller);
			if (graph.rootSessionId !== caller) {
				const { task, run } = await ctx.taskRuntime.runForSession(caller);
				return [
					`task ${task.taskId} [${task.status}] depth ${task.depth}`,
					`objective: ${task.objective}`,
					"acceptance criteria:",
					...task.acceptanceCriteria.map((criterion) => {
						const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
						return `- ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ", mandatory" : ""}] ${criterion.description}${command}`;
					}),
					`run ${run.runId} [${run.status}] started ${run.startedAt}`
				].join("\n");
			}
			const storeId = rootTaskStoreId(graph.rootSessionId);
			const snapshot = await ctx.task.openStore(storeId);
			const root = snapshot.tasks.find((task) => task.depth === 0);
			if (root === void 0) throw new Error(`task_read: store "${storeId}" has no root task`);
			const children = root.childTaskIds.map((taskId) => snapshot.tasks.find((task) => task.taskId === taskId)).filter((task) => task !== void 0);
			return [
				`root task ${root.taskId} [${root.status}/${root.decompositionStatus}]`,
				`objective: ${root.objective}`,
				"acceptance criteria:",
				...root.acceptanceCriteria.map((criterion) => `- ${criterion.criterionId} [${criterion.verificationMode}] ${criterion.description}`),
				`children: ${children.length}`,
				...children.map((child) => {
					const run = latestRun(snapshot, child);
					const runPart = run === void 0 ? "no run" : `run ${run.runId} [${run.status}]`;
					return `- ${child.taskId} [${child.status}/${child.decompositionStatus}] ${runPart} ${child.objective}`;
				})
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-status.ts
const text$1 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$1(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_status: missing agent id");
	return id;
}
function defineTaskStatusTool(ctx) {
	return defineTool({
		name: "task_status",
		description: "Compact snapshot of the caller's graph task tree: task id, objective, status, latest run status, and evidence ids.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$1(v)
		},
		execute: async (_args, exec) => {
			const graph = await ctx.graphs.graphForSession(sessionId$1(exec));
			const storeId = rootTaskStoreId(graph.rootSessionId);
			const snapshot = await ctx.task.openStore(storeId);
			const lines = snapshot.tasks.map((task) => {
				const runId = task.runIds[task.runIds.length - 1];
				const run = snapshot.runs.find((item) => item.runId === runId);
				const evidence = snapshot.evidence.filter((item) => item.taskId === task.taskId).map((item) => item.evidenceId);
				const runPart = run === void 0 ? "run: none" : `run: ${run.status}`;
				const evidencePart = evidence.length === 0 ? "" : ` evidence: [${evidence.join(", ")}]`;
				return `${"  ".repeat(task.depth)}${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart})`;
			});
			return [`graph ${graph.id} task tree (${snapshot.tasks.length} tasks):`, ...lines].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-verify.ts
const text = (value) => [{
	type: "text",
	text: value
}];
function sessionId(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_verify: missing agent id");
	return id;
}
function softService(ctx, name) {
	return ctx.get?.(name) ?? ctx[name];
}
function defineTaskVerifyTool(ctx) {
	return defineTool({
		name: "task_verify",
		description: "Self-check: re-run the verifier against the caller's current task run and report per-criterion results. Records no task status; use it to see what the verifier would say before reporting back.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId(exec);
			const verifier = softService(ctx, "verifier");
			if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new Error("task_verify: verifier service is not loaded");
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			let cwd;
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				cwd = softService(ctx, "envBuilder")?.store.get(graph.envId).path;
			} catch {
				cwd = void 0;
			}
			const bundle = await verifier.verifyRun(storeId, run.runId, cwd === void 0 ? {} : { cwd });
			return [`run ${run.runId} of task ${task.taskId}: evidence ${bundle.evidenceId} (self-check, status unchanged)`, ...bundle.verifierResults.map((result) => {
				const command = result.command === void 0 ? "" : ` — $ ${result.command}`;
				const exit = result.exitCode === void 0 ? "" : ` exit ${result.exitCode}`;
				const details = result.details === void 0 ? "" : ` (${result.details})`;
				return `- ${result.criterionId}: ${result.status} by ${result.verifierId}${command}${exit}${details}`;
			})].join("\n");
		}
	});
}

//#endregion
//#region src/index.ts
var SingularityAgent = class extends Service {
	static inject = [
		"tools",
		"graphs",
		"agentRuntime",
		"task",
		"taskRuntime"
	];
	constructor(ctx) {
		super(ctx, "singularityAgent");
		ctx.plugin(HitlService);
		ctx.tools.register(defineMarkReadyTool(ctx));
		ctx.tools.register(defineSpawnTool(ctx));
		ctx.tools.register(defineAskTool(ctx));
		ctx.tools.register(defineApproveTool(ctx));
		ctx.tools.register(defineTaskReadTool(ctx));
		ctx.tools.register(defineTaskDecomposeTool(ctx));
		ctx.tools.register(defineTaskStatusTool(ctx));
		ctx.tools.register(defineTaskVerifyTool(ctx));
	}
};
var src_default = SingularityAgent;

//#endregion
export { HitlService, SingularityAgent, src_default as default };