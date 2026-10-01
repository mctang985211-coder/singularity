import { randomUUID } from "node:crypto";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { EventStoreSet, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { cleanPromptText } from "@dangosys/dsh-env-builder";

//#region src/service/state.ts
/** Whether an existing environment can be bound by a new graph: it has repositories, no graph, and no sessions. */
function isReusableEnv(env, boundEnvIds) {
	return env.components.length > 0 && !boundEnvIds.has(env.id) && env.sessionIds.length === 0;
}
function copy(value) {
	return structuredClone(value);
}
var GraphsState = class GraphsState {
	value;
	constructor(snapshot) {
		if (snapshot === void 0) {
			this.value = {
				version: 1,
				graphs: [],
				archives: []
			};
			return;
		}
		this.value = copy(snapshot);
	}
	clone() {
		return new GraphsState(this.value);
	}
	snapshot() {
		return copy(this.value);
	}
	apply(event) {
		switch (event.kind) {
			case "graph/add": {
				const graph = event.graph;
				if (this.value.graphs.some((g) => g.id === graph.id)) throw new Error(`graphs: duplicate graph id "${graph.id}"`);
				if (this.value.graphs.some((g) => g.envId === graph.envId)) throw new Error(`graphs: environment "${graph.envId}" already bound`);
				this.value = {
					...this.value,
					graphs: [...this.value.graphs, copy(graph)],
					selectedId: graph.id
				};
				return;
			}
			case "graph/select":
				if (!this.value.graphs.some((g) => g.id === event.id)) throw new Error(`graphs: unknown graph "${event.id}"`);
				this.value = {
					...this.value,
					selectedId: event.id
				};
				return;
			case "graph/ready": {
				const idx = this.value.graphs.findIndex((g) => g.id === event.id);
				if (idx < 0) throw new Error(`graphs: unknown graph "${event.id}"`);
				const graph = this.value.graphs[idx];
				if (graph.ready) throw new Error(`graphs: graph "${event.id}" is already ready`);
				const next = {
					...graph,
					ready: true
				};
				const graphs = [...this.value.graphs];
				graphs[idx] = next;
				this.value = {
					...this.value,
					graphs
				};
				return;
			}
			case "graph/remove": {
				if (!this.value.graphs.some((g) => g.id === event.id)) throw new Error(`graphs: unknown graph "${event.id}"`);
				const graphs = this.value.graphs.filter((g) => g.id !== event.id);
				const selectedId = this.value.selectedId === event.id ? graphs[0]?.id : this.value.selectedId;
				this.value = {
					...this.value,
					graphs,
					selectedId,
					archives: [...this.value.archives, copy(event.archive)]
				};
				return;
			}
			default: throw new Error(`graphs: unknown event kind "${event.kind}"`);
		}
	}
	get(id) {
		const graph = this.value.graphs.find((g) => g.id === id);
		if (graph === void 0) throw new Error(`graphs: unknown graph "${id}"`);
		return copy(graph);
	}
	selected() {
		if (this.value.selectedId === void 0) return void 0;
		return this.get(this.value.selectedId);
	}
	boundEnvIds() {
		return new Set(this.value.graphs.map((g) => g.envId));
	}
};

//#endregion
//#region src/prompts/setup.prompts.ts
/** What the root is told when a graph is created (A0 §1.1): the setup work, not the graph's goal. */
function setupPromptText(graphId, env) {
	const pending = env.components.filter((component) => component.status === "installing");
	const present = env.components.filter((component) => component.status !== "installing");
	const names = (components) => components.map((component) => `${component.owner}/${component.repo}`).join(", ");
	const presentLine = present.length === 0 ? "" : `\nAlready present (do not reinstall): ${names(present)}.`;
	return `Set up Singularity graph ${graphId}. Environment ${env.id} is at ${env.path}.
Planned repositories: ${names(pending) || "(none)"}.${presentLine}

This setup work is not the graph's goal: the goal is the user's own objective, and when the user states it, accept it with task_intake — before that the graph has no root task, so task_read reports the session as not activated and there is nothing to decompose. For each planned repository, delegate installation and registration to a worker with graph_spawn — never with task_decompose, which only has a task to work on once a root contract has been accepted. The worker must install it with bash according to the repository instructions and then call env_register_component. If a worker needs human input, you may use hitl_ask or hitl_approve. When all setup workers complete successfully, call graph_mark_ready. If there are no planned repositories, call graph_mark_ready immediately.`;
}

//#endregion
//#region src/index.ts
function nextGraphId(existing) {
	let n = 1;
	while (existing.includes(`graph${n}`)) n += 1;
	return `graph${n}`;
}
/** The registry's own answer when no graph publishes a session; distinguishable by code from a failed read. */
const SESSION_NOT_IN_GRAPH = "graph-session-not-found";
/** See {@link SESSION_NOT_IN_GRAPH}: the one error that means "no graph holds this session". */
var SessionNotInGraphError = class extends Error {
	code = SESSION_NOT_IN_GRAPH;
	constructor(sessionId) {
		super(`graphs: session "${String(sessionId)}" is not in a graph`);
		this.name = "SessionNotInGraphError";
	}
};
var GraphsService = class extends Service {
	static inject = [
		"sessionPersistence",
		"graph",
		"layout",
		"agentRuntime",
		"envBuilder"
	];
	stores;
	storeId = SessionId("graphs-registry");
	ready;
	transitions = Promise.resolve();
	constructor(ctx) {
		super(ctx, "graphs");
		this.stores = new EventStoreSet(ctx, {
			namespace: "graphs",
			eventType: "graphs/event",
			changeEvent: "graphs/change",
			createState: () => new GraphsState()
		});
		this.ready = this.stores.open(this.storeId, "auto").then(() => void 0);
		ctx.on("agentRuntime/spawned", async ({ parentId, sessionId }) => {
			const graph = await this.graphForSession(parentId);
			ctx.envBuilder.store.attachSession(graph.envId, sessionId);
		});
		ctx.effect(() => async () => {
			await this.ready;
			await this.transitions;
			await this.stores.close();
		}, "graphs:persistence");
		ctx.effect(async () => {
			await this.ready;
			const selected = (await this.state()).selected();
			if (selected !== void 0) await this.transition(() => this.activate(selected));
			return () => {};
		}, "graphs: boot selected");
	}
	async snapshot() {
		return (await this.state()).snapshot();
	}
	/** The selected graph; throws when no graph is selected. */
	async current() {
		const selected = (await this.state()).selected();
		if (selected === void 0) throw new Error("graphs: no graph selected");
		return selected;
	}
	async get(id) {
		return (await this.state()).get(id);
	}
	async view(id) {
		const meta = await this.get(id);
		return {
			meta,
			graph: await this.ctx.graph.snapshotIn(meta.graphStoreId),
			layout: await this.ctx.layout.snapshotIn(meta.layoutStoreId)
		};
	}
	async list() {
		return (await this.state()).snapshot().graphs;
	}
	async select(id) {
		return this.transition(async () => {
			const graph = await this.get(id);
			await this.activate(graph);
			await this.commit([{
				kind: "graph/select",
				id
			}]);
			return graph;
		});
	}
	async create(request) {
		return this.transition(async () => {
			await this.ready;
			let createdEnvId;
			let attached;
			let rootAgentId;
			let committed = false;
			const store = this.ctx.envBuilder.store;
			const choice = await this.resolveEnv(store, request);
			try {
				let envId;
				let reused = false;
				if ("reuse" in choice) {
					envId = choice.reuse;
					reused = true;
				} else {
					const { label, repos } = choice.create;
					if (repos.length === 0) throw new Error("graphs: new environment requires at least one repository");
					envId = createdEnvId = (label === void 0 ? store.create() : store.create(label)).id;
					for (const ref of repos) store.planComponent(envId, ref);
				}
				const registry = (await this.state()).snapshot();
				const id = nextGraphId([...registry.graphs.map((graph$1) => graph$1.id), ...registry.archives.map((archive) => archive.graph.id)]);
				const name = request.name === void 0 ? id : request.name.trim();
				if (name.length === 0) throw new Error("graphs: name is empty");
				const rootSessionId = SessionId(randomUUID());
				const graphStoreId = `sg-g-${rootSessionId}`;
				const layoutStoreId = `sg-l-${rootSessionId}`;
				const handle = await this.ctx.agentRuntime.createRoot({
					sessionId: rootSessionId,
					cwd: store.get(envId).path,
					scope: {
						graphStoreId,
						layoutStoreId
					}
				});
				rootAgentId = handle.agent.id;
				this.ctx.envBuilder.store.attachSession(envId, handle.agent.id);
				attached = {
					envId,
					sessionId: handle.agent.id
				};
				this.ctx.envBuilder.store.select(envId);
				const graph = {
					id,
					name,
					envId,
					rootSessionId: handle.agent.id,
					graphStoreId,
					layoutStoreId,
					createdAt: Date.now(),
					ready: false
				};
				await this.commit([{
					kind: "graph/add",
					graph
				}]);
				committed = true;
				await this.activate(graph);
				const env = store.get(envId);
				await this.ctx.agentRuntime.prompt(handle.agent, [{
					type: "text",
					text: setupPromptText(id, env)
				}]);
				return {
					graph,
					reused
				};
			} catch (error) {
				if (committed) throw error;
				if (attached !== void 0) {
					await this.ctx.agentRuntime.stopAgents([attached.sessionId]);
					this.ctx.envBuilder.store.detachSession(attached.envId, attached.sessionId);
				} else if (rootAgentId !== void 0) await this.ctx.agentRuntime.stopAgents([rootAgentId]);
				if (createdEnvId !== void 0) this.ctx.envBuilder.store.delete(createdEnvId);
				throw error;
			}
		});
	}
	async resolveEnv(store, request) {
		if (request.envId !== void 0) {
			if (request.createEnv === true || request.workspace !== void 0 || request.fresh === true) throw new Error("graphs: envId cannot combine with createEnv, workspace, or fresh");
			if (request.repos !== void 0) throw new Error("graphs: repos only allowed with createEnv");
			await this.assertReusable(request.envId);
			return { reuse: request.envId };
		}
		if (request.workspace !== void 0) {
			const label = request.workspace.trim();
			if (label.length === 0) throw new Error("graphs: workspace is empty");
			if (request.fresh !== true) {
				const bound = (await this.state()).boundEnvIds();
				const matches = store.findByLabel(label);
				const available = matches.find((env) => isReusableEnv(env, bound));
				if (available !== void 0) {
					await this.assertReusable(available.id);
					return { reuse: available.id };
				}
				if (matches.length > 0) throw new Error(await this.workspaceTaken(label, matches));
			}
			return { create: {
				label,
				repos: request.repos ?? []
			} };
		}
		if (request.createEnv === true) {
			const repos = request.repos ?? [];
			if (repos.length === 0) throw new Error("graphs: new environment requires at least one repository");
			if (request.fresh !== true) {
				const bound = (await this.state()).boundEnvIds();
				const match = store.findByRepos(repos).find((env) => isReusableEnv(env, bound));
				if (match !== void 0) {
					await this.assertReusable(match.id);
					return { reuse: match.id };
				}
			}
			return { create: { repos } };
		}
		throw new Error("graphs: provide exactly one of createEnv, envId, workspace");
	}
	async assertReusable(envId) {
		const occupant = (await this.state()).snapshot().graphs.find((graph) => graph.envId === envId);
		if (occupant !== void 0) throw new Error(`graphs: environment "${envId}" already bound to graph "${occupant.id}" ("${occupant.name}"); release it with POST /singularity/graphs/${occupant.id}/delete or choose another environment`);
		const env = this.ctx.envBuilder.store.get(envId);
		if (env.components.length === 0) throw new Error(`graphs: environment "${envId}" has no repositories`);
		if (env.sessionIds.length > 0) throw new Error(`graphs: environment "${envId}" still has sessions`);
	}
	async workspaceTaken(label, matches) {
		const graphs = (await this.state()).snapshot().graphs;
		return `graphs: workspace "${label}" is taken by ${matches.map((env) => {
			const occupant = graphs.find((graph) => graph.envId === env.id);
			const reason = occupant !== void 0 ? `bound to graph "${occupant.id}"` : env.sessionIds.length > 0 ? `has ${env.sessionIds.length} session(s)` : "has no repositories";
			return `${env.id} (${reason})`;
		}).join(", ")}; release the occupying graph with POST /singularity/graphs/<id>/delete or choose another workspace name`;
	}
	async markReady(id) {
		await this.commit([{
			kind: "graph/ready",
			id
		}]);
		return (await this.state()).get(id);
	}
	async graphForSession(sessionId) {
		for (const graph of (await this.state()).snapshot().graphs) if ((await this.ctx.graph.snapshotIn(graph.graphStoreId)).agents.some((agent) => agent.id === sessionId)) return graph;
		throw new SessionNotInGraphError(sessionId);
	}
	async remove(id) {
		return this.transition(async () => {
			const graph = await this.get(id);
			const scope = {
				graphStoreId: graph.graphStoreId,
				layoutStoreId: graph.layoutStoreId
			};
			const taskRuntime = this.taskRuntime();
			if (taskRuntime !== void 0) await taskRuntime.cancelGraph(rootTaskStoreId(graph.rootSessionId), "graph removed");
			await this.ctx.agentRuntime.stopGraph(scope);
			const root = await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, {
				graphStoreId: graph.graphStoreId,
				layoutStoreId: graph.layoutStoreId
			});
			let stop;
			let timer;
			const cleaned = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`graphs: env clean timed out for "${graph.envId}"`)), 600 * 1e3);
				stop = this.ctx.on("envBuilder/cleaned", (envId) => {
					if (envId === graph.envId) resolve();
				});
			});
			try {
				await Promise.all([this.ctx.agentRuntime.spawn(root.agent, {
					sessionId: SessionId(randomUUID()),
					name: "env-clean",
					prompt: [{
						type: "text",
						text: cleanPromptText(graph.envId)
					}]
				}), cleaned]);
			} finally {
				clearTimeout(timer);
				stop();
				await this.ctx.agentRuntime.stopGraph(scope);
			}
			const archive = {
				graph,
				agentIds: (await this.ctx.graph.snapshotIn(graph.graphStoreId)).agents.map((agent) => agent.id),
				archivedAt: Date.now()
			};
			await this.commit([{
				kind: "graph/remove",
				id,
				archive
			}]);
			const selected = (await this.state()).selected();
			if (selected !== void 0) await this.activate(selected);
			else {
				this.ctx.graph.clearActive();
				this.ctx.layout.clearActive();
			}
		});
	}
	/** Resolved lazily: task-runtime injects graphs, so a hard inject here would deadlock the plugin loader. */
	taskRuntime() {
		return this.ctx.get("taskRuntime");
	}
	/** One graph becomes this process's running environment: recovery barrier, then store and env switch (A2 §E). */
	async activate(graph) {
		await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, {
			graphStoreId: graph.graphStoreId,
			layoutStoreId: graph.layoutStoreId
		});
		const taskRuntime = this.taskRuntime();
		if (taskRuntime === void 0) throw new Error("graphs: taskRuntime service is not loaded; cannot recover the root store");
		await taskRuntime.adoptRoot(rootTaskStoreId(graph.rootSessionId), graph.rootSessionId);
		await this.ctx.graph.switchStore(graph.graphStoreId);
		await this.ctx.layout.switchStore(graph.layoutStoreId);
		this.ctx.envBuilder.store.select(graph.envId);
		this.ctx.emit("graphs/selected", graph);
	}
	async commit(events) {
		await this.stores.commit(this.storeId, events);
	}
	transition(work) {
		const run = this.transitions.then(work);
		this.transitions = run.then(() => void 0, () => void 0);
		return run;
	}
	/** The live registry reducer; every read goes through `ready` so a failed constructor open stays caller-visible. */
	async state() {
		await this.ready;
		return this.stores.require(this.storeId).state;
	}
};
var src_default = GraphsService;

//#endregion
export { GraphsService, GraphsState, SESSION_NOT_IN_GRAPH, SessionNotInGraphError, src_default as default, isReusableEnv };