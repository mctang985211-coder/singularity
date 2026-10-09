import { a as graphAccess, i as assertCurrentGraph, n as GRAPH_PROTOCOL_V2, o as protocolOf, r as GraphSealedError, t as graphAccessWire } from "./wire-BJWK8tlL.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { EventStoreSet, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { latestBubbleWorkspacePath, materializeBubble } from "@dangosys/dsh-singularity-task-runtime";

//#region src/service/state.ts
/** Whether an existing workspace can be bound by a new graph: no graph and no sessions. */
function isReusableEnv(env, boundEnvIds) {
	return !boundEnvIds.has(env.id) && env.sessionIds.length === 0;
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
			case "graph/model": {
				const idx = this.value.graphs.findIndex((g) => g.id === event.id);
				if (idx < 0) throw new Error(`graphs: unknown graph "${event.id}"`);
				const { model: _cleared,...bare } = this.value.graphs[idx];
				const next = event.model === null ? bare : {
					...bare,
					model: event.model
				};
				const graphs = [...this.value.graphs];
				graphs[idx] = next;
				this.value = {
					...this.value,
					graphs
				};
				return;
			}
			case "graph/rsi": {
				const idx = this.value.graphs.findIndex((g) => g.id === event.id);
				if (idx < 0) throw new Error(`graphs: unknown graph "${event.id}"`);
				const { rsi: _previous,...bare } = this.value.graphs[idx];
				const next = event.rsi === null ? bare : {
					...bare,
					rsi: event.rsi
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
			default:
				if (event.kind === "graph/rsi-progress") return;
				throw new Error(`graphs: unknown event kind "${event.kind}"`);
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
//#region src/model.ts
/** Agent options for the model a graph pins, or `undefined` when it follows the deployment default. */
function graphAgentOptions(graph) {
	const model = graph.model;
	if (model === void 0) return void 0;
	return {
		provider: model.provider,
		model: model.model,
		...model.reasoningEffort === void 0 ? {} : { reasoningEffort: model.reasoningEffort }
	};
}
/** Refuse a model whose provider route is not registered, or whose route does not advertise that model. */
async function assertModelServiceable(llm, model) {
	if (!llm.listProviders().some((route) => route.id === model.provider)) throw new Error(`graphs: model.provider "${model.provider}" is not a registered provider route`);
	if (!(await llm.listModels(model.provider)).some((entry) => entry.id === model.model)) throw new Error(`graphs: model.model "${model.model}" is not served by provider "${model.provider}"`);
}

//#endregion
//#region src/prompts/setup.prompts.ts
/** What the root is told when a graph is created (A0 §1.1): the setup work, not the graph's goal. */
function setupPromptText(graphId, env) {
	const pending = env.components.filter((component) => component.status === "installing");
	const present = env.components.filter((component) => component.status !== "installing");
	const names = (components) => components.map((component) => `${component.owner}/${component.repo}`).join(", ");
	const presentLine = present.length === 0 ? "" : `\nAlready present: ${names(present)}.`;
	return `Set up Singularity graph ${graphId}. Environment ${env.id} is at ${env.path}.
Planned repositories: ${names(pending) || "(none)"}.${presentLine}

Install and register planned repositories through graph_spawn, then call graph_mark_ready. An empty workspace is ready immediately. After setup, explore the user's objective and measures, read this graph's task_library, and establish the task_intake contract for this execution. Record useful goals, decomposition paths and experience as TaskTemplates or Skills in the graph library; the supervisor reviews them during iteration.`;
}

//#endregion
//#region src/read/legacy.ts
/** One door read, with a failure named by the source it came from. */
async function readDoor(kind, graphId, read) {
	try {
		return await read();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`graphs: reading the ${kind} of legacy graph "${graphId}" failed: ${detail}`);
	}
}
/**
* One legacy graph's whole history: its registry record, the three stores it may
* hold, and the old evolution and completion records, each kept verbatim. The
* stores are read in a fixed order (topology, layout, tasks) through read-only
* doors, so a read creates nothing and a missing store is reported rather than
* treated as a failure. `writable` is `false` by construction: no caller can
* mistake this projection for a write path.
*/
async function readLegacyGraph(deps, graph) {
	const key = rootTaskStoreId(graph.rootSessionId);
	const topology = await readDoor("topology", graph.id, () => deps.graph.snapshotReadOnlyIn(graph.graphStoreId));
	const layout = await readDoor("layout", graph.id, () => deps.layout.snapshotReadOnlyIn(graph.layoutStoreId));
	const tasks = await readDoor("tasks", graph.id, () => deps.task.snapshotReadOnly(key));
	const evolution = deps.legacyEvolution === void 0 ? void 0 : await deps.legacyEvolution(key);
	const completions = deps.legacyCompletions === void 0 ? [] : await deps.legacyCompletions(key);
	return {
		formatVersion: "legacy-v1",
		writable: false,
		graph,
		access: graphAccessWire(graph),
		topology: topology.exists ? topology.snapshot : null,
		layout: layout.exists ? layout.snapshot : null,
		tasks: tasks.exists ? tasks.snapshot : null,
		proposals: evolution?.proposals ?? [],
		experiments: evolution?.experiments ?? [],
		completions,
		sources: [
			{
				id: graph.graphStoreId,
				kind: "topology",
				exists: topology.exists
			},
			{
				id: graph.layoutStoreId,
				kind: "layout",
				exists: layout.exists
			},
			{
				id: key,
				kind: "tasks",
				exists: tasks.exists
			}
		]
	};
}

//#endregion
//#region src/index.ts
function nextGraphId(existing) {
	let n = 1;
	while (existing.includes(`graph${n}`)) n += 1;
	return `graph${n}`;
}
/** The fields an RSI config carries: anything else is refused by name rather than ignored. */
const RSI_FIELDS = [
	"task",
	"metrics",
	"iterationRounds",
	"humanReview",
	"epoch",
	"strategy"
];
/** Validates one RSI config, refusing a malformed one with the offending field named. */
function assertRsiConfig(rsi) {
	if (typeof rsi !== "object" || rsi === null || Array.isArray(rsi)) throw new Error(`graphs: rsi must be an object carrying ${RSI_FIELDS.join(", ")}`);
	const fields = rsi;
	for (const key of Object.keys(fields)) if (!RSI_FIELDS.includes(key)) throw new Error(`graphs: rsi carries "${key}", which is not part of an RSI config; it carries ${RSI_FIELDS.join(", ")} and nothing else`);
	if (typeof fields.task !== "string" || fields.task.trim().length === 0) throw new Error("graphs: rsi.task must be a non-empty string");
	if (fields.metrics !== void 0 && (!Array.isArray(fields.metrics) || fields.metrics.some((metric) => typeof metric !== "string" || metric.trim().length === 0))) throw new Error("graphs: rsi.metrics must be an array of non-empty descriptions");
	const rounds = fields.iterationRounds;
	if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) throw new Error("graphs: rsi.iterationRounds must be an integer >= 1");
	if (typeof fields.humanReview !== "boolean") throw new Error("graphs: rsi.humanReview must be a boolean");
	if (fields.epoch !== void 0 && (typeof fields.epoch !== "number" || !Number.isInteger(fields.epoch) || fields.epoch < 1)) throw new Error("graphs: rsi.epoch must be an integer >= 1");
	if (fields.strategy !== void 0 && fields.strategy !== "regularized" && fields.strategy !== "unregularized") throw new Error(`graphs: rsi.strategy must be 'regularized' or 'unregularized'`);
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
			if (selected !== void 0) await this.transition(() => this.enterSelected(selected));
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
	/**
	* One graph's metadata, topology and layout. Every store is read through the
	* zero-write door: a graph whose store this process never opened answers
	* `null` rather than being created by the read, which is what keeps a sealed
	* legacy graph readable without a single write.
	*/
	async view(id) {
		const meta = await this.get(id);
		const [graph, layout] = await Promise.all([this.ctx.graph.snapshotReadOnlyIn(meta.graphStoreId), this.ctx.layout.snapshotReadOnlyIn(meta.layoutStoreId)]);
		return {
			meta,
			access: graphAccessWire(meta),
			graph: graph.exists ? graph.snapshot : null,
			layout: layout.exists ? layout.snapshot : null
		};
	}
	async list() {
		return (await this.state()).snapshot().graphs;
	}
	async select(id) {
		return this.transition(async () => {
			const graph = await this.writableGraph(id);
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
			if (request.model !== void 0) await this.assertModel(request.model);
			if (request.rsi !== void 0 && (typeof request.rsi !== "object" || request.rsi === null || Array.isArray(request.rsi))) assertRsiConfig(request.rsi);
			const rsi = request.rsi === void 0 ? void 0 : {
				iterationRounds: 3,
				humanReview: false,
				epoch: 1,
				...request.rsi
			};
			if (rsi !== void 0) assertRsiConfig(rsi);
			const modelOptions = request.model === void 0 ? void 0 : graphAgentOptions({ model: request.model });
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
				const envPath = store.get(envId).path;
				const runtime = this.taskRuntime();
				const environment = runtime === void 0 ? void 0 : await runtime.ensureInitialEnvironment(rootSessionId, rootSessionId);
				const workspace = await materializeBubble(envPath, process.env.DSH_HOME || join(homedir(), ".dsh"), rootSessionId, id, 1, { ...environment?.revision === void 0 ? {} : { methodRevisionId: environment.revision.manifest.revisionId } });
				runtime?.pinSessionWorkspace(rootSessionId, workspace);
				const handle = await this.ctx.agentRuntime.createRoot({
					sessionId: rootSessionId,
					cwd: workspace,
					scope: {
						graphStoreId,
						layoutStoreId
					},
					...modelOptions === void 0 ? {} : { agentOptions: modelOptions }
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
					ready: false,
					protocol: {
						id: GRAPH_PROTOCOL_V2,
						version: 2,
						since: Date.now()
					},
					...request.model === void 0 ? {} : { model: request.model },
					...rsi === void 0 ? {} : { rsi }
				};
				await this.commit([{
					kind: "graph/add",
					graph
				}]);
				committed = true;
				await this.activate(graph);
				const setup = [{
					type: "text",
					text: setupPromptText(id, store.get(envId))
				}];
				if (rsi === void 0) await this.ctx.agentRuntime.prompt(handle.agent, setup);
				else await this.ctx.agentRuntime.promptUser(handle.agent, [{
					type: "text",
					text: [rsi.task, ...rsi.metrics?.length ? ["关注指标：", ...rsi.metrics.map((metric) => `- ${metric}`)] : []].join("\n")
				}], setup);
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
		if (this.ctx.envBuilder.store.get(envId).sessionIds.length > 0) throw new Error(`graphs: environment "${envId}" still has sessions`);
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
		await this.writableGraph(id);
		await this.commit([{
			kind: "graph/ready",
			id
		}]);
		return (await this.state()).get(id);
	}
	/** Pin, replace, or clear (null) one graph's model. Only later spawns read it; existing sessions keep theirs. */
	async setModel(id, model) {
		return this.setPins(id, { model });
	}
	/**
	* Set, replace, or clear (null) one graph's RSI config.
	* A configured driver reconciles the same frozen root task; a new objective requires a new graph.
	*/
	async setRsi(id, rsi) {
		return this.setPins(id, { rsi });
	}
	/** Validate all supplied settings before committing one event batch in the graph transition queue. */
	async setPins(id, update) {
		return this.transition(async () => {
			await this.ready;
			await this.writableGraph(id);
			const { model, rsi } = update;
			if (model === void 0 && rsi === void 0) throw new Error("graphs: model or rsi is required (pass null to clear either)");
			if (rsi !== void 0 && rsi !== null) assertRsiConfig(rsi);
			if (model !== void 0 && model !== null) await this.assertModel(model);
			const events = [];
			if (model !== void 0) events.push({
				kind: "graph/model",
				id,
				model
			});
			if (rsi !== void 0) events.push({
				kind: "graph/rsi",
				id,
				rsi
			});
			await this.commit(events);
			return (await this.state()).get(id);
		});
	}
	/** Refuse a pin the current provider registry cannot serve; the message names the offending field. */
	async assertModel(model) {
		const llm = this.ctx.get("llm");
		if (llm === void 0) throw new Error("graphs: llm service is not loaded; cannot validate a model pin");
		await assertModelServiceable(llm, model);
	}
	/** Which graph publishes a session, read through the zero-write door: a read never opens a store as a side effect. */
	async graphForSession(sessionId) {
		for (const graph of (await this.state()).snapshot().graphs) {
			const snapshot = await this.ctx.graph.snapshotReadOnlyIn(graph.graphStoreId);
			if (snapshot.exists && snapshot.snapshot.agents.some((agent) => agent.id === sessionId)) return graph;
		}
		throw new SessionNotInGraphError(sessionId);
	}
	async remove(id) {
		return this.transition(async () => {
			const graph = await this.get(id);
			const access = graphAccess(graph);
			let agentIds;
			if (access.mode === "current") {
				const taskRuntime = this.taskRuntime();
				if (taskRuntime !== void 0) await taskRuntime.cancelGraph(rootTaskStoreId(graph.rootSessionId), "graph removed");
				await this.ctx.agentRuntime.stopGraph({
					graphStoreId: graph.graphStoreId,
					layoutStoreId: graph.layoutStoreId
				});
				this.ctx.envBuilder.store.markClean(graph.envId);
				agentIds = (await this.ctx.graph.snapshotIn(graph.graphStoreId)).agents.map((agent) => agent.id);
			} else {
				const snapshot = await this.ctx.graph.snapshotReadOnlyIn(graph.graphStoreId);
				agentIds = snapshot.exists ? snapshot.snapshot.agents.map((agent) => agent.id) : [];
			}
			const archive = {
				graph,
				agentIds: [...agentIds],
				archivedAt: Date.now()
			};
			await this.commit([{
				kind: "graph/remove",
				id,
				archive
			}]);
			const selected = (await this.state()).selected();
			if (selected !== void 0) Promise.resolve().then(() => this.enterSelected(selected)).catch(() => {});
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
	/**
	* The one write gate: every entry that would change one graph's settings,
	* readiness or selection resolves its record through here first, and a sealed
	* legacy graph answers {@link GraphSealedError} before anything is committed.
	*/
	async writableGraph(id) {
		const graph = await this.get(id);
		assertCurrentGraph(graph);
		return graph;
	}
	/**
	* The selected graph becomes this process's running environment. A sealed
	* legacy graph is history: it is never activated, so selecting it — or booting
	* with it selected — writes nothing, adopts nothing and publishes nothing.
	*/
	async enterSelected(graph) {
		if (graphAccess(graph).mode === "legacy-readonly") {
			this.ctx.graph.clearActive();
			this.ctx.layout.clearActive();
			return;
		}
		await this.activate(graph);
	}
	/** One graph becomes this process's running environment: recovery barrier, then store and env switch (A2 §E). */
	async activate(graph) {
		const modelOptions = graphAgentOptions(graph);
		const scope = {
			graphStoreId: graph.graphStoreId,
			layoutStoreId: graph.layoutStoreId
		};
		if (modelOptions === void 0) await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, scope);
		else await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, scope, modelOptions);
		const taskRuntime = this.taskRuntime();
		if (taskRuntime === void 0) throw new Error("graphs: taskRuntime service is not loaded; cannot recover the root store");
		const bubble = latestBubbleWorkspacePath(process.env.DSH_HOME || join(homedir(), ".dsh"), graph.rootSessionId);
		if (bubble !== void 0) taskRuntime.pinSessionWorkspace(graph.rootSessionId, bubble);
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
export { GRAPH_PROTOCOL_V2, GraphSealedError, GraphsService, GraphsState, SESSION_NOT_IN_GRAPH, SessionNotInGraphError, assertCurrentGraph, assertModelServiceable, src_default as default, graphAccess, graphAccessWire, graphAgentOptions, isReusableEnv, protocolOf, readLegacyGraph };