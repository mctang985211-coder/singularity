import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { optionalService } from "@dangosys/dsh-singularity-task-runtime";
import { isReusableEnv } from "@dangosys/dsh-singularity-graphs";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

//#region src/constants.ts
const GRAPH_PATH = "/singularity/graph";
const LAYOUT_PATH = "/singularity/layout";
const EVENTS_PATH = "/singularity/events";
const MAP_PATH = "/singularity/map";
const GRAPHS_PATH = "/singularity/graphs";
const GRAPH_ENVS_PATH = "/singularity/graph-envs";
const REPO_CHECK_PATH = "/singularity/repo-check";
const HITL_PATH = "/singularity/hitl";
const TASK_PATH = "/singularity/task";
const TASK_DECIDE_PATH = "/singularity/task/proposals/decide";
const EVOLUTION_PATH = "/singularity/evolution";
const RECOVERY_PATH = "/singularity/recovery";
const REVIEW_PATH = "/singularity/review";

//#endregion
//#region src/web/libs/http.ts
const MAX_BODY = 64 * 1024;
/** The request URL against the harness-local base; every route reads its query and path through this. */
function urlOf(req) {
	return new URL(req.url ?? "/", "http://dsh.local");
}
function send(res, status, type, value) {
	res.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store"
	});
	res.end(typeof value === "string" ? value : JSON.stringify(value));
}
/** Answer with a JSON value. */
function sendJson(res, status, value) {
	send(res, status, "application/json; charset=utf-8", value);
}
async function readJson(req, limit = MAX_BODY) {
	const chunks = [];
	let length = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buf.length;
		if (length > limit) throw new Error("request body too large");
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) throw new Error("empty request body");
	return JSON.parse(raw);
}
/** Answer 405 and report `false` unless the request method is one of `allowed`. */
function guardMethod(req, res, ...allowed) {
	if (allowed.includes(req.method ?? "")) return true;
	send(res, 405, "text/plain; charset=utf-8", "method not allowed");
	return false;
}
/** Answer with the error's message; `status` defaults to 400. */
function fail(res, error, status = 400) {
	send(res, status, "text/plain; charset=utf-8", messageOf(error));
}
/** The `graphId` query parameter, or the caller-named refusal when it is absent. */
function graphIdOf(req, who) {
	const id = urlOf(req).searchParams.get("graphId");
	if (id === null) throw new Error(`${who}: graphId required`);
	return id;
}
/** One required non-empty query parameter, or the caller-named refusal when it is absent. */
function queryOf(req, key, who) {
	const value = urlOf(req).searchParams.get(key);
	if (value === null || value.length === 0) throw new Error(`${who}: ${key} required`);
	return value;
}
/** The error's message, or the value itself when it is not an error. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/web/api/routes.ts
function registerGraph(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: GRAPH_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			try {
				sendJson(res, 200, await ctx.graphs.view(graphIdOf(req, "graph")));
			} catch (error) {
				fail(res, error, 409);
			}
		}
	});
}
function registerEvents(ctx, broadcast) {
	return ctx.webServer.register({
		kind: "exact",
		path: EVENTS_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			const graph = await ctx.graphs.get(graphIdOf(req, "events"));
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive"
			});
			res.on("close", () => broadcast.clients.delete(res));
			broadcast.subscribe(res, graph);
			res.write(`event: hitl\ndata: ${JSON.stringify({ pending: ctx.hitl.list() })}\n\n`);
		}
	});
}
function registerHitl(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: HITL_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET", "POST")) return;
			if (req.method === "GET") {
				sendJson(res, 200, { pending: ctx.hitl.list() });
				return;
			}
			const body = await readJson(req);
			if (typeof body.id !== "string" || body.id.length === 0) throw new Error("hitl: missing id");
			if (body.answer === void 0) throw new Error("hitl: missing answer");
			ctx.hitl.answer(body.id, body.answer);
			sendJson(res, 200, {
				ok: true,
				pending: ctx.hitl.list()
			});
		}
	});
}
function registerLayout(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: LAYOUT_PATH,
		handler: async (req, res) => {
			try {
				const graph = await ctx.graphs.get(graphIdOf(req, "layout"));
				if (req.method === "GET") {
					sendJson(res, 200, await ctx.layout.snapshotIn(graph.layoutStoreId));
					return;
				}
				if (!guardMethod(req, res, "PUT")) return;
				const body = await readJson(req);
				if (typeof body.sessionId !== "string" || body.sessionId.length === 0) throw new Error("layout put: sessionId required");
				if (body.node === void 0 || typeof body.node !== "object") throw new Error("layout put: node required");
				if (!(await ctx.graph.snapshotIn(graph.graphStoreId)).agents.some((agent) => agent.id === body.sessionId)) throw new Error("layout: session belongs to another graph");
				await ctx.layout.setIn(graph.layoutStoreId, body.sessionId, body.node);
				sendJson(res, 200, await ctx.layout.snapshotIn(graph.layoutStoreId));
			} catch (error) {
				fail(res, error);
			}
		}
	});
}

//#endregion
//#region src/web/api/evolution.ts
/** The ledger the console may read: absent when the chain is off (`singularityEvolution.enabled`), or when no service was mounted. */
function evolutionOf(ctx) {
	const exposure = optionalService(ctx, "singularityEvolution");
	if (exposure !== void 0 && exposure.enabled === false) return void 0;
	return optionalService(ctx, "evolution");
}
function registerEvolution(ctx) {
	const stopList = ctx.webServer.register({
		kind: "exact",
		path: EVOLUTION_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			const evolution = evolutionOf(ctx);
			if (evolution === void 0) {
				sendJson(res, 200, {
					proposals: [],
					experiments: []
				});
				return;
			}
			try {
				sendJson(res, 200, {
					proposals: await evolution.list(),
					experiments: await evolution.experiments()
				});
			} catch (error) {
				fail(res, error);
			}
		}
	});
	const stopDetail = ctx.webServer.register({
		kind: "prefix",
		path: EVOLUTION_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			try {
				const url = urlOf(req);
				const id = decodeURIComponent(url.pathname.slice(EVOLUTION_PATH.length + 1));
				if (id.length === 0 || id.includes("/")) throw new Error(`evolution: unknown path ${url.pathname}`);
				const evolution = evolutionOf(ctx);
				if (evolution === void 0) throw new Error(`evolution: unknown proposal "${id}"`);
				sendJson(res, 200, { proposal: await evolution.get(id) });
			} catch (error) {
				sendJson(res, 404, { error: messageOf(error) });
			}
		}
	});
	return () => {
		stopList();
		stopDetail();
	};
}

//#endregion
//#region src/web/api/graph-envs.ts
function registerGraphEnvs(ctx) {
	const stopList = ctx.webServer.register({
		kind: "exact",
		path: GRAPH_ENVS_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			const bound = new Set((await ctx.graphs.list()).map((g) => g.envId));
			sendJson(res, 200, { envs: ctx.envBuilder.store.list().map((env) => ({
				id: env.id,
				label: env.label,
				path: env.path,
				componentCount: env.components.length,
				sessionCount: env.sessionIds.length,
				available: isReusableEnv(env, bound),
				bound: bound.has(env.id)
			})) });
		}
	});
	const stopCheck = ctx.webServer.register({
		kind: "exact",
		path: REPO_CHECK_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "POST")) return;
			const body = await readJson(req);
			if (typeof body.repo !== "string" || body.repo.trim().length === 0) throw new Error("repo-check: missing repo");
			const parsed = await ctx.envBuilder.assertRepo(body.repo);
			sendJson(res, 200, {
				owner: parsed.owner,
				repo: parsed.repo,
				ref: parsed.dir
			});
		}
	});
	return () => {
		stopList();
		stopCheck();
	};
}

//#endregion
//#region src/web/api/graphs.ts
function registerGraphs(ctx) {
	const stopList = ctx.webServer.register({
		kind: "exact",
		path: GRAPHS_PATH,
		handler: async (req, res) => {
			try {
				if (!guardMethod(req, res, "GET", "POST")) return;
				if (req.method === "GET") {
					const snapshot = await ctx.graphs.snapshot();
					sendJson(res, 200, {
						...snapshot,
						graphs: snapshot.graphs.map((graph$1) => ({
							...graph$1,
							repos: ctx.envBuilder.store.get(graph$1.envId).components.map((component) => `${component.owner}/${component.repo}`)
						}))
					});
					return;
				}
				const body = await readJson(req);
				const { graph, reused } = await ctx.graphs.create(body);
				sendJson(res, 200, {
					...graph,
					reused
				});
			} catch (error) {
				fail(res, error);
			}
		}
	});
	const stopActions = ctx.webServer.register({
		kind: "prefix",
		path: GRAPHS_PATH,
		handler: async (req, res) => {
			try {
				const url = urlOf(req);
				const parts = url.pathname.slice(GRAPHS_PATH.length + 1).split("/").filter(Boolean);
				if (parts.length !== 2) throw new Error(`graphs: unknown path ${url.pathname}`);
				const [id, action] = parts;
				if (id.length === 0) throw new Error("graphs: missing graph id");
				if (action === "select" || action === "ready" || action === "delete") {
					if (!guardMethod(req, res, "POST")) return;
					if (action === "select") sendJson(res, 200, await ctx.graphs.select(id));
					else if (action === "ready") sendJson(res, 200, await ctx.graphs.markReady(id));
					else {
						await ctx.graphs.remove(id);
						sendJson(res, 200, { ok: true });
					}
					return;
				}
				throw new Error(`graphs: unknown action ${action}`);
			} catch (error) {
				fail(res, error);
			}
		}
	});
	return () => {
		stopList();
		stopActions();
	};
}

//#endregion
//#region src/web/api/map-static.ts
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".json": "application/json; charset=utf-8"
};
const require = createRequire(import.meta.url);
function appDir() {
	return resolve(require.resolve("@dangosys/dsh-singularity-map/package.json"), "..", "dist");
}
function assetPath(root, rel) {
	const abs = resolve(root, normalize(rel));
	if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`map static: path escape "${rel}"`);
	return abs;
}
function registerMapStatic(ctx) {
	const root = appDir();
	const prefix = MAP_PATH;
	const serve = async (req, res) => {
		let rel = urlOf(req).pathname.slice(prefix.length).replace(/^\/+/, "") || "index.html";
		if (rel.endsWith("/")) rel += "index.html";
		const abs = assetPath(root, rel);
		const body = await readFile(abs);
		const type = MIME[extname(abs).toLowerCase()];
		if (type === void 0) throw new Error(`map static: unknown mime for ${abs}`);
		res.writeHead(200, {
			"content-type": type,
			"cache-control": "no-store"
		});
		res.end(body);
	};
	const stopRedirect = ctx.webServer.register({
		kind: "exact",
		path: prefix,
		handler: (_req, res) => {
			res.writeHead(302, { location: prefix + "/" });
			res.end();
		}
	});
	const stopStatic = ctx.webServer.register({
		kind: "prefix",
		path: prefix,
		handler: serve
	});
	return () => {
		stopRedirect();
		stopStatic();
	};
}

//#endregion
//#region src/web/api/task.ts
const DECISIONS = [
	"approve",
	"reject",
	"continue",
	"cancel"
];
/** The console carries no session; a decision it records names the operator seat. */
const DECIDED_BY = "operator";
/** The `storeId` query parameter, answered with the route's own refusal when it is missing. */
function storeIdOf(req, who, res) {
	try {
		return queryOf(req, "storeId", who);
	} catch (error) {
		fail(res, error);
		return;
	}
}
/** The session a proposal belongs to: the one its continuation and withdrawal act on behalf of. */
function callerOf(proposal) {
	return proposal.kind === "root" ? proposal.identity.rootSessionId : proposal.identity.callerSessionId;
}
/** The one decision call a console action maps to, in the runtime's own signatures. */
async function decide(runtime, body) {
	if (body.decision === "approve" || body.decision === "reject") {
		await runtime.decideProposal(body.storeId, body.proposalId, {
			outcome: body.decision === "approve" ? "approved" : "rejected",
			...body.reason === void 0 || body.reason.length === 0 ? {} : { reason: body.reason }
		}, DECIDED_BY);
		return;
	}
	const proposal = await runtime.readProposal(body.storeId, body.proposalId);
	if (proposal === void 0) throw new Error(`task-runtime: store "${body.storeId}" holds no proposal "${body.proposalId}"`);
	const caller = callerOf(proposal);
	if (body.decision === "continue") {
		await runtime.continueProposal(body.storeId, body.proposalId, caller);
		return;
	}
	await runtime.cancelProposal(body.storeId, body.proposalId, caller);
}
function registerTask(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: TASK_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			const storeId = storeIdOf(req, "task", res);
			if (storeId === void 0) return;
			const task = optionalService(ctx, "task");
			if (task === void 0) {
				sendJson(res, 503, { error: "task: this deployment mounts no task store" });
				return;
			}
			try {
				sendJson(res, 200, { snapshot: await task.openStore(storeId) });
			} catch (error) {
				sendJson(res, 404, { error: messageOf(error) });
			}
		}
	});
}
function registerProposalDecide(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: TASK_DECIDE_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "POST")) return;
			let body;
			try {
				body = await readJson(req);
				if (typeof body.storeId !== "string" || body.storeId.length === 0) throw new Error("decide: storeId required");
				if (typeof body.proposalId !== "string" || body.proposalId.length === 0) throw new Error("decide: proposalId required");
				if (!DECISIONS.includes(body.decision)) throw new Error(`decide: unknown decision ${String(body.decision)}`);
				if (body.reason !== void 0 && typeof body.reason !== "string") throw new Error("decide: reason must be a string");
			} catch (error) {
				fail(res, error);
				return;
			}
			const runtime = optionalService(ctx, "taskRuntime");
			if (runtime === void 0) {
				sendJson(res, 200, {
					ok: false,
					error: "task-runtime: this deployment mounts no task runtime"
				});
				return;
			}
			try {
				await decide(runtime, body);
				sendJson(res, 200, { ok: true });
			} catch (error) {
				sendJson(res, 200, {
					ok: false,
					error: messageOf(error)
				});
			}
		}
	});
}
function registerRecovery(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: RECOVERY_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			const storeId = storeIdOf(req, "recovery", res);
			if (storeId === void 0) return;
			const runtime = optionalService(ctx, "taskRuntime");
			if (runtime === void 0) {
				sendJson(res, 200, {
					recovery: null,
					reconcile: null
				});
				return;
			}
			sendJson(res, 200, {
				recovery: {
					...await runtime.recoveryStatus(storeId),
					...runtime.recoveryState(storeId)
				},
				reconcile: null
			});
		}
	});
}
function registerReview(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: REVIEW_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			let runId;
			const storeId = storeIdOf(req, "review", res);
			if (storeId === void 0) return;
			try {
				runId = queryOf(req, "runId", "review");
			} catch (error) {
				fail(res, error);
				return;
			}
			const task = optionalService(ctx, "task");
			if (task === void 0) {
				sendJson(res, 503, { error: "task: this deployment mounts no task store" });
				return;
			}
			let reviews;
			try {
				reviews = (await task.openStore(storeId)).reviews;
			} catch (error) {
				sendJson(res, 404, { error: messageOf(error) });
				return;
			}
			const review = reviews.find((record) => record.runId === runId);
			if (review === void 0) {
				sendJson(res, 200, {
					review: null,
					logTail: null
				});
				return;
			}
			const verifier = optionalService(ctx, "verifier");
			const logRef = (review.criteria ?? []).map((criterion) => criterion.logRef).find((ref) => ref !== void 0);
			let logTail = null;
			if (verifier !== void 0 && logRef !== void 0) try {
				logTail = await verifier.logTail(logRef) ?? null;
			} catch (error) {
				logTail = null;
			}
			sendJson(res, 200, {
				review,
				logTail
			});
		}
	});
}

//#endregion
//#region src/web/libs/broadcast.ts
var GraphBroadcast = class {
	clients = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	subscribe(res, graph) {
		this.clients.set(res, {
			graph,
			writes: Promise.resolve()
		});
		this.snapshot(res);
	}
	snapshot(res) {
		const client = this.clients.get(res);
		client.writes = client.writes.then(async () => {
			const view = await this.ctx.graphs.view(client.graph.id);
			if (!res.destroyed) res.write(`event: snapshot\ndata: ${JSON.stringify(view)}\n\n`);
		}).catch((error) => {
			this.clients.delete(res);
			res.destroy(error);
		});
	}
	publishEvent(name$1, value) {
		const frame = `event: ${name$1}\ndata: ${JSON.stringify(value)}\n\n`;
		for (const [res] of this.clients) if (res.destroyed) this.clients.delete(res);
		else res.write(frame);
	}
	publishGraphs(snapshot) {
		for (const [res, client] of this.clients) if (res.destroyed) this.clients.delete(res);
		else if (snapshot.graphs.some((graph) => graph.id === client.graph.id)) this.snapshot(res);
		else res.end();
	}
	publishLayout(snapshot) {
		for (const [res, client] of this.clients) if (client.graph.layoutStoreId === snapshot.id) this.snapshot(res);
	}
	publish(snapshot) {
		for (const [res, client] of this.clients) if (client.graph.graphStoreId === snapshot.id) this.snapshot(res);
	}
	close() {
		for (const res of this.clients.keys()) res.end();
		this.clients.clear();
	}
};

//#endregion
//#region src/index.ts
const name = "graph-web";
const inject = [
	"graph",
	"layout",
	"graphs",
	"envBuilder",
	"webServer",
	"hitl"
];
function apply(ctx) {
	const broadcast = new GraphBroadcast(ctx);
	ctx.on("graph/change", (snapshot) => broadcast.publish(snapshot));
	ctx.on("layout/change", (snapshot) => broadcast.publishLayout(snapshot));
	ctx.on("graphs/change", (snapshot) => broadcast.publishGraphs(snapshot));
	ctx.on("hitl/change", (pending) => broadcast.publishEvent("hitl", { pending }));
	ctx.on("task/change", (snapshot) => broadcast.publishEvent("task", { storeId: snapshot.id }));
	ctx.on("evolution/change", ({ proposalId }) => broadcast.publishEvent("evolution", { id: proposalId }));
	ctx.on("pr-chat/path", (event) => broadcast.publishEvent("pr-chat/path", event));
	ctx.on("pr-chat/sent", (event) => broadcast.publishEvent("pr-chat/sent", event));
	ctx.effect(() => {
		const graph = registerGraph(ctx);
		const layout = registerLayout(ctx);
		const graphs = registerGraphs(ctx);
		const graphEnvs = registerGraphEnvs(ctx);
		const hitl = registerHitl(ctx);
		const task = registerTask(ctx);
		const propose = registerProposalDecide(ctx);
		const recovery = registerRecovery(ctx);
		const review = registerReview(ctx);
		const evolution = registerEvolution(ctx);
		const events = registerEvents(ctx, broadcast);
		const map = registerMapStatic(ctx);
		return () => {
			graph();
			layout();
			graphs();
			graphEnvs();
			hitl();
			task();
			propose();
			recovery();
			review();
			evolution();
			events();
			map();
			broadcast.close();
		};
	}, "web: routes");
}

//#endregion
export { apply, inject, name };