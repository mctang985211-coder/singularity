import { Context, Service } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";

//#region src/service/state.ts
function copy(value) {
	return structuredClone(value);
}
const ADMITTED_OR_LATER = [
	"admitted",
	"ready",
	"running",
	"verifying",
	"verified",
	"failed"
];
var TaskState = class TaskState {
	value;
	constructor(id, snapshot) {
		this.value = snapshot === void 0 ? {
			version: 1,
			id,
			tasks: [],
			runs: [],
			edges: [],
			evidence: [],
			handoffs: [],
			capabilities: {}
		} : copy(snapshot);
	}
	clone() {
		return new TaskState(this.value.id, this.value);
	}
	snapshot() {
		return copy(this.value);
	}
	apply(event$1) {
		switch (event$1.kind) {
			case "TaskCreated":
				this.addTask(event$1.payload.task);
				return;
			case "TaskAdmitted":
				this.admit(event$1.taskId, event$1.payload.decompositionStatus);
				return;
			case "TaskRejected":
				this.transit(event$1.taskId, ["created"], "blocked");
				return;
			case "TaskDecomposed":
				this.decompose(event$1.taskId, event$1.payload.childTaskIds);
				return;
			case "DependencyAdded":
				this.addDependency(event$1.payload.edge);
				return;
			case "TaskStarted":
				this.start(event$1.taskId, event$1.runId, event$1.payload.run);
				return;
			case "TaskBlocked":
				this.block(event$1.taskId, event$1.runId);
				return;
			case "TaskVerifying":
				this.transit(event$1.taskId, ["running"], "verifying");
				return;
			case "TaskVerified":
				this.verify(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskFailed":
				this.fail(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskCancelled":
				this.cancel(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskRetried":
				this.transit(event$1.taskId, ["failed"], "ready");
				return;
			case "CapabilityResolved":
				this.resolveCapabilities(event$1.taskId, event$1.payload.manifest);
				return;
			case "CapabilityGapDetected":
				this.task(event$1.taskId);
				return;
			case "EvidenceProduced":
				this.produceEvidence(event$1.taskId, event$1.runId, event$1.payload.evidence);
				return;
			case "HandoffCreated":
				this.addHandoff(event$1.payload.handoff);
				return;
			default: throw new Error(`task: unknown event kind "${event$1.kind}"`);
		}
	}
	addTask(task) {
		if (typeof task.taskId !== "string" || task.taskId.length === 0) throw new Error("task: task id must be a non-empty string");
		if (typeof task.objective !== "string" || task.objective.length === 0) throw new Error(`task: task "${task.taskId}" objective must be non-empty`);
		if (this.value.tasks.some((item) => item.taskId === task.taskId)) throw new Error(`task: task "${task.taskId}" already exists`);
		if (task.status !== "created") throw new Error(`task: task "${task.taskId}" must be created in status "created"`);
		if (task.runIds.length !== 0 || task.childTaskIds.length !== 0) throw new Error("task: task runs and children must use events");
		if (task.parentTaskId === task.taskId) throw new Error(`task: task "${task.taskId}" cannot be its own parent`);
		if (task.parentTaskId === void 0) {
			if (task.depth !== 0) throw new Error(`task: root task "${task.taskId}" depth must be 0`);
			this.value = {
				...this.value,
				tasks: [...this.value.tasks, copy(task)]
			};
			return;
		}
		const parent = this.task(task.parentTaskId);
		if (task.depth !== parent.depth + 1) throw new Error(`task: task "${task.taskId}" depth must be parent depth + 1`);
		this.value = {
			...this.value,
			tasks: [...this.value.tasks.map((item) => item.taskId === parent.taskId ? {
				...item,
				childTaskIds: [...item.childTaskIds, task.taskId]
			} : item), copy(task)]
		};
	}
	admit(taskId, decompositionStatus) {
		this.assertTransition(taskId, ["created"], "admitted");
		this.updateTask(taskId, {
			status: "admitted",
			decompositionStatus
		});
	}
	decompose(taskId, childTaskIds) {
		const parent = this.task(taskId);
		if (parent.decompositionStatus === "decomposed") throw new Error(`task: task "${taskId}" is already decomposed`);
		for (const childTaskId of childTaskIds) if (!parent.childTaskIds.includes(childTaskId)) throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`);
		if (parent.childTaskIds.filter((childTaskId) => ADMITTED_OR_LATER.includes(this.task(childTaskId).status)).length === 0) throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`);
		this.updateTask(taskId, { decompositionStatus: "decomposed" });
	}
	addDependency(edge) {
		this.task(edge.from);
		this.task(edge.to);
		if (edge.from === edge.to || this.reaches(edge.to, edge.from)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" creates a cycle`);
		if (this.value.edges.some((item) => item.from === edge.from && item.to === edge.to)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" already exists`);
		this.value = {
			...this.value,
			edges: [...this.value.edges, copy(edge)]
		};
	}
	start(taskId, envelopeRunId, run) {
		if (typeof run.runId !== "string" || run.runId.length === 0) throw new Error("task: run id must be a non-empty string");
		if (this.value.runs.some((item) => item.runId === run.runId)) throw new Error(`task: run "${run.runId}" already exists`);
		if (run.taskId !== taskId) throw new Error(`task: run "${run.runId}" does not belong to task "${taskId}"`);
		if (envelopeRunId !== run.runId) throw new Error(`task: run "${run.runId}" envelope run id mismatch`);
		if (run.status !== "running") throw new Error(`task: run "${run.runId}" must start in status "running"`);
		if (typeof run.sessionId !== "string" || run.sessionId.length === 0) throw new Error(`task: run "${run.runId}" session id must be non-empty`);
		if (run.parentRunId !== void 0) this.run(run.parentRunId);
		this.assertTransition(taskId, ["admitted", "ready"], "running");
		this.value = {
			...this.value,
			runs: [...this.value.runs, copy(run)]
		};
		this.updateTask(taskId, {
			status: "running",
			runIds: [...this.task(taskId).runIds, run.runId]
		});
	}
	block(taskId, runId) {
		this.assertTransition(taskId, [
			"admitted",
			"ready",
			"running"
		], "blocked");
		if (runId !== void 0) this.assertRunTransition(runId, ["running"], "blocked");
		this.updateTask(taskId, { status: "blocked" });
		if (runId !== void 0) this.setRun(runId, "blocked");
	}
	verify(taskId, runId, finishedAt) {
		if (runId === void 0) throw new Error(`task: TaskVerified for "${taskId}" requires a run id`);
		this.assertTransition(taskId, ["verifying"], "verified");
		if (!this.value.evidence.some((item) => item.taskId === taskId && item.taskRunId === runId)) throw new Error(`task: run "${runId}" has no evidence`);
		this.assertRunTransition(runId, ["running"], "verified");
		this.updateTask(taskId, { status: "verified" });
		this.setRun(runId, "verified", finishedAt);
	}
	fail(taskId, runId, finishedAt) {
		this.assertTransition(taskId, ["running", "verifying"], "failed");
		if (runId !== void 0) this.assertRunTransition(runId, ["running", "blocked"], "failed");
		this.updateTask(taskId, { status: "failed" });
		if (runId !== void 0) this.setRun(runId, "failed", finishedAt);
	}
	cancel(taskId, runId, finishedAt) {
		this.assertTransition(taskId, ["running"], "cancelled");
		if (runId !== void 0) this.assertRunTransition(runId, ["running", "blocked"], "cancelled");
		this.updateTask(taskId, { status: "cancelled" });
		if (runId !== void 0) this.setRun(runId, "cancelled", finishedAt);
	}
	resolveCapabilities(taskId, manifest) {
		this.task(taskId);
		this.value = {
			...this.value,
			capabilities: {
				...this.value.capabilities,
				[taskId]: copy(manifest)
			}
		};
	}
	produceEvidence(taskId, runId, evidence) {
		this.task(taskId);
		if (typeof evidence.evidenceId !== "string" || evidence.evidenceId.length === 0) throw new Error("task: evidence id must be a non-empty string");
		if (this.value.evidence.some((item) => item.evidenceId === evidence.evidenceId)) throw new Error(`task: evidence "${evidence.evidenceId}" already exists`);
		if (evidence.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" does not belong to task "${taskId}"`);
		const run = this.run(evidence.taskRunId);
		if (run.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" run "${run.runId}" belongs to task "${run.taskId}"`);
		if (runId !== void 0 && runId !== evidence.taskRunId) throw new Error(`task: evidence "${evidence.evidenceId}" envelope run id mismatch`);
		if (run.status !== "running") throw new Error(`task: run "${run.runId}" is ${run.status}; evidence can only be recorded while the run is running`);
		this.value = {
			...this.value,
			evidence: [...this.value.evidence, copy(evidence)],
			runs: this.value.runs.map((item) => item.runId === run.runId ? {
				...item,
				artifacts: [...item.artifacts, ...copy(evidence.artifacts)],
				verifierResults: [...item.verifierResults, ...copy(evidence.verifierResults)]
			} : item)
		};
	}
	addHandoff(handoff) {
		if (typeof handoff.handoffId !== "string" || handoff.handoffId.length === 0) throw new Error("task: handoff id must be a non-empty string");
		if (this.value.handoffs.some((item) => item.handoffId === handoff.handoffId)) throw new Error(`task: handoff "${handoff.handoffId}" already exists`);
		const parent = this.task(handoff.parentTaskId);
		const child = this.task(handoff.childTaskId);
		if (child.parentTaskId !== parent.taskId) throw new Error(`task: handoff child "${child.taskId}" is not a child of "${parent.taskId}"`);
		this.run(handoff.parentRunId);
		this.value = {
			...this.value,
			handoffs: [...this.value.handoffs, copy(handoff)]
		};
	}
	reaches(start, target) {
		const seen = /* @__PURE__ */ new Set();
		const pending = [start];
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === target) return true;
			if (seen.has(current)) continue;
			seen.add(current);
			for (const edge of this.value.edges) if (edge.from === current) pending.push(edge.to);
		}
		return false;
	}
	transit(taskId, from, to) {
		this.assertTransition(taskId, from, to);
		this.updateTask(taskId, { status: to });
	}
	assertTransition(taskId, from, to) {
		const current = this.task(taskId);
		if (!from.includes(current.status)) throw new Error(`task: illegal transition "${current.status}" → "${to}" for task "${taskId}"`);
	}
	assertRunTransition(runId, from, to) {
		const current = this.run(runId);
		if (!from.includes(current.status)) throw new Error(`task: illegal run transition "${current.status}" → "${to}" for run "${runId}"`);
	}
	setRun(runId, status, finishedAt) {
		this.value = {
			...this.value,
			runs: this.value.runs.map((item) => item.runId === runId ? {
				...item,
				status,
				...finishedAt !== void 0 ? { finishedAt } : {}
			} : item)
		};
	}
	updateTask(taskId, patch) {
		this.value = {
			...this.value,
			tasks: this.value.tasks.map((item) => item.taskId === taskId ? {
				...item,
				...patch
			} : item)
		};
	}
	task(taskId) {
		const task = this.value.tasks.find((item) => item.taskId === taskId);
		if (task === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return task;
	}
	run(runId) {
		const run = this.value.runs.find((item) => item.runId === runId);
		if (run === void 0) throw new Error(`task: unknown run "${runId}"`);
		return run;
	}
};

//#endregion
//#region src/types.ts
/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
const RootTaskSpec = {
	taskType: "root",
	version: 1,
	acceptanceCriteria: [{
		criterionId: "root-children-verified",
		description: "all mandatory children verified",
		verificationMode: "composite",
		requiredEvidence: [],
		mandatory: true
	}],
	requiredCapabilities: [],
	decompositionPolicy: { allowed: true }
};
/** Store id convention: one task store per root session. */
function rootTaskStoreId(rootSessionId) {
	return `sg-t-${rootSessionId}`;
}

//#endregion
//#region src/index.ts
function assertStoreId(id) {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`task: invalid store id "${id}"`);
}
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/**
* Drop `undefined`-valued keys so an event can enter the session log, which
* accepts only lossless JSON and rejects `undefined` outright. An optional
* field carrying `undefined` and an absent optional field mean the same thing
* here; exotic values are left untouched so the log reports them itself.
*/
function compact(value) {
	if (Array.isArray(value)) return value.map((item) => compact(item));
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const source = value;
	const target = {};
	for (const [key, item] of Object.entries(source)) if (item !== void 0) target[key] = compact(item);
	return target;
}
function event(kind, init) {
	return {
		kind,
		taskId: init.taskId,
		runId: init.runId,
		sessionId: init.sessionId,
		parentTaskId: init.parentTaskId,
		timestamp: now(),
		actor: init.actor,
		payload: init.payload,
		schemaVersion: 1
	};
}
var TaskService = class extends Service {
	static inject = ["sessionPersistence"];
	stores = /* @__PURE__ */ new Map();
	closing = false;
	constructor(ctx) {
		super(ctx, "task");
		ctx.effect(() => () => this.close(), "task:persistence");
	}
	async createStore(storeId) {
		if (this.stores.has(storeId)) throw new Error(`task: store "${storeId}" is already open`);
		const store = this.allocate(storeId);
		store.ready = (async () => {
			try {
				if ((await this.ctx.sessionPersistence.list()).filter((item) => item.header.id === store.sessionId).length > 0) throw new Error(`task: store "${storeId}" already exists`);
				store.handle = await this.ctx.sessionPersistence.create(this.header(store.sessionId));
			} catch (error) {
				this.stores.delete(storeId);
				throw error;
			}
		})();
		await store.ready;
		return store.state.snapshot();
	}
	async openStore(storeId) {
		const existing = this.stores.get(storeId);
		if (existing !== void 0) {
			await existing.ready;
			return existing.state.snapshot();
		}
		const store = this.allocate(storeId);
		store.ready = this.open(store);
		try {
			await store.ready;
		} catch (error) {
			this.stores.delete(storeId);
			throw error;
		}
		return store.state.snapshot();
	}
	async snapshotIn(storeId) {
		const store = this.requireStore(storeId);
		await store.ready;
		return store.state.snapshot();
	}
	async taskIn(storeId, taskId) {
		const task = (await this.snapshotIn(storeId)).tasks.find((item) => item.taskId === taskId);
		if (task === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return task;
	}
	async runIn(storeId, runId) {
		const run = (await this.snapshotIn(storeId)).runs.find((item) => item.runId === runId);
		if (run === void 0) throw new Error(`task: unknown run "${runId}"`);
		return run;
	}
	async childrenIn(storeId, taskId) {
		const snapshot = await this.snapshotIn(storeId);
		const parent = snapshot.tasks.find((item) => item.taskId === taskId);
		if (parent === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return parent.childTaskIds.map((childTaskId) => snapshot.tasks.find((item) => item.taskId === childTaskId));
	}
	async createTaskIn(storeId, task, actor) {
		await this.commitIn(storeId, [event("TaskCreated", {
			taskId: task.taskId,
			parentTaskId: task.parentTaskId,
			actor,
			payload: { task }
		})]);
	}
	async admitTaskIn(storeId, taskId, actor, options = {}) {
		const events = [];
		if (options.manifest !== void 0) {
			events.push(event("CapabilityResolved", {
				taskId,
				actor,
				payload: { manifest: options.manifest }
			}));
			if (options.manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId,
				actor,
				payload: { missing: options.manifest.missing }
			}));
		}
		events.push(event("TaskAdmitted", {
			taskId,
			actor,
			payload: { decompositionStatus: options.decompositionStatus ?? "leaf" }
		}));
		await this.commitIn(storeId, events);
	}
	async rejectTaskIn(storeId, taskId, actor, reason, manifest) {
		const events = [];
		if (manifest !== void 0) {
			events.push(event("CapabilityResolved", {
				taskId,
				actor,
				payload: { manifest }
			}));
			if (manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId,
				actor,
				payload: { missing: manifest.missing }
			}));
		}
		events.push(event("TaskRejected", {
			taskId,
			actor,
			payload: { reason }
		}));
		await this.commitIn(storeId, events);
	}
	async decomposeIn(storeId, parentTaskId, children, actor, edges = []) {
		if (children.length === 0) throw new Error("task: decompose requires at least one child");
		const events = [];
		for (const child of children) {
			if (child.parentTaskId !== parentTaskId) throw new Error(`task: child "${child.taskId}" parentTaskId must be "${parentTaskId}"`);
			if (child.decompositionStatus !== "leaf" && child.decompositionStatus !== "decomposable") throw new Error(`task: child "${child.taskId}" decomposition status must be "leaf" or "decomposable"`);
			events.push(event("TaskCreated", {
				taskId: child.taskId,
				parentTaskId,
				actor,
				payload: { task: child }
			}));
			events.push(event("TaskAdmitted", {
				taskId: child.taskId,
				actor,
				payload: { decompositionStatus: child.decompositionStatus }
			}));
		}
		for (const edge of edges) events.push(event("DependencyAdded", {
			taskId: edge.to,
			actor,
			payload: { edge }
		}));
		events.push(event("TaskDecomposed", {
			taskId: parentTaskId,
			actor,
			payload: { childTaskIds: children.map((child) => child.taskId) }
		}));
		await this.commitIn(storeId, events);
	}
	async addDependencyIn(storeId, edge, actor) {
		await this.commitIn(storeId, [event("DependencyAdded", {
			taskId: edge.to,
			actor,
			payload: { edge }
		})]);
	}
	async startRunIn(storeId, run, actor) {
		const store = this.requireStore(storeId);
		await store.ready;
		await store.writes;
		const task = store.state.snapshot().tasks.find((item) => item.taskId === run.taskId);
		const events = [];
		if (task?.status === "failed") events.push(event("TaskRetried", {
			taskId: run.taskId,
			actor,
			payload: {}
		}));
		events.push(event("TaskStarted", {
			taskId: run.taskId,
			runId: run.runId,
			sessionId: run.sessionId,
			actor,
			payload: { run }
		}));
		await this.commitIn(storeId, events);
	}
	async markRunStatusIn(storeId, taskId, runId, status, actor, options = {}) {
		switch (status) {
			case "blocked":
				await this.commitIn(storeId, [event("TaskBlocked", {
					taskId,
					runId,
					actor,
					payload: { reason: options.reason }
				})]);
				return;
			case "verifying":
				await this.commitIn(storeId, [event("TaskVerifying", {
					taskId,
					runId,
					actor,
					payload: {}
				})]);
				return;
			case "verified":
				await this.commitIn(storeId, [event("TaskVerified", {
					taskId,
					runId,
					actor,
					payload: { finishedAt: options.finishedAt ?? now() }
				})]);
				return;
			case "failed":
				await this.commitIn(storeId, [event("TaskFailed", {
					taskId,
					runId,
					actor,
					payload: {
						reason: options.reason,
						finishedAt: options.finishedAt ?? now()
					}
				})]);
				return;
			case "cancelled":
				await this.commitIn(storeId, [event("TaskCancelled", {
					taskId,
					runId,
					actor,
					payload: {
						reason: options.reason,
						finishedAt: options.finishedAt ?? now()
					}
				})]);
				return;
			case "running": throw new Error("task: start a run with startRunIn");
			default: throw new Error(`task: unknown run status "${String(status)}"`);
		}
	}
	async recordEvidenceIn(storeId, evidence, actor) {
		await this.commitIn(storeId, [event("EvidenceProduced", {
			taskId: evidence.taskId,
			runId: evidence.taskRunId,
			actor,
			payload: { evidence }
		})]);
	}
	async recordHandoffIn(storeId, handoff, actor) {
		await this.commitIn(storeId, [event("HandoffCreated", {
			taskId: handoff.childTaskId,
			runId: handoff.parentRunId,
			parentTaskId: handoff.parentTaskId,
			actor,
			payload: { handoff }
		})]);
	}
	async commitIn(storeId, events) {
		if (events.length === 0) throw new Error("task: cannot commit an empty event batch");
		const store = this.requireStore(storeId);
		const run = store.writes.then(async () => {
			await store.ready;
			const next = store.state.clone();
			for (const item of events) next.apply(item);
			const records = events.map((item, index) => ({
				type: "task/event",
				seq: SessionSeq(store.nextSeq + index),
				time: Date.now(),
				data: compact(item),
				ignorable: true
			}));
			await store.handle.append(records);
			store.state = next;
			store.nextSeq += records.length;
			this.ctx.emit("task/change", store.state.snapshot());
		});
		store.writes = run.then(() => void 0, () => void 0);
		await run;
	}
	requireStore(storeId) {
		if (this.closing) throw new Error("task: service is closing");
		assertStoreId(storeId);
		const store = this.stores.get(storeId);
		if (store === void 0) throw new Error(`task: store "${storeId}" is not open`);
		return store;
	}
	allocate(storeId) {
		if (this.closing) throw new Error("task: service is closing");
		assertStoreId(storeId);
		const store = {
			id: storeId,
			sessionId: SessionId(storeId),
			state: new TaskState(storeId),
			nextSeq: 0,
			ready: Promise.resolve(),
			writes: Promise.resolve()
		};
		this.stores.set(storeId, store);
		return store;
	}
	async open(store) {
		try {
			const listed = (await this.ctx.sessionPersistence.list()).filter((item) => item.header.id === store.sessionId);
			if (listed.length === 0) throw new Error(`task: store "${store.id}" does not exist`);
			if (listed.length > 1) throw new Error(`task: duplicate store session "${store.id}"`);
			store.handle = await this.ctx.sessionPersistence.open(store.sessionId, "write");
			const { events } = await store.handle.read();
			for (const item of events) {
				if (item.type !== "task/event" || item.ignorable !== true) throw new Error(`task: invalid persisted event at seq ${item.seq}`);
				const next = store.state.clone();
				next.apply(item.data);
				store.state = next;
				store.nextSeq = item.seq + 1;
			}
			await store.handle.flush();
		} catch (error) {
			await store.handle?.close();
			throw error;
		}
	}
	async close() {
		this.closing = true;
		const results = await Promise.allSettled([...this.stores.values()].map(async (store) => {
			await store.ready;
			await store.writes;
			await store.handle?.close();
		}));
		this.stores.clear();
		for (const result of results) if (result.status === "rejected") throw result.reason;
	}
	header(storeId) {
		return {
			version: SESSION_FORMAT_VERSION,
			id: storeId,
			createdAt: Date.now(),
			isSeeded: false
		};
	}
};
var src_default = TaskService;

//#endregion
export { RootTaskSpec, TaskService, TaskState, src_default as default, rootTaskStoreId };