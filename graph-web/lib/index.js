import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { GraphSealedError, assertCurrentGraph, graphAccessWire, isReusableEnv, readLegacyGraph } from "@dangosys/dsh-singularity-graphs";
import { libraryRoots, optionalService, readEnvironmentDraft, readRevision } from "@dangosys/dsh-singularity-task-runtime";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { DEFAULT_STRATEGY_POLICY, cohortDigestOf, environmentHomeOf, evaluationOf, evaluationSourcesOf, foldHistory, methodList, openMethodLedger, readLegacyMethodsSync, scaleOf, sideMeasurementOf } from "@dangosys/dsh-singularity-evolution";
import { createHash } from "node:crypto";

//#region src/constants.ts
const GRAPH_PATH = "/singularity/graph";
const VIEW_PATH = "/singularity/view";
const LAYOUT_PATH = "/singularity/layout";
const EVENTS_PATH = "/singularity/events";
const MAP_PATH = "/singularity/map";
const GRAPHS_PATH = "/singularity/graphs";
const MODELS_PATH = "/singularity/models";
const GRAPH_ENVS_PATH = "/singularity/graph-envs";
const REPO_CHECK_PATH = "/singularity/repo-check";
const HITL_PATH = "/singularity/hitl";
const TASK_PATH = "/singularity/task";
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
//#region src/web/api/view.ts
/** A read this deployment mounted no producer for; the route answers it as a named 503. */
function readSourceUnavailable(source, detail) {
	return Object.assign(new Error(detail), {
		code: "read-source-unavailable",
		source
	});
}
/** The one view source, or this route's own refusal naming what is missing. */
function graphViewOf$1(ctx) {
	const service = optionalService(ctx, "singularityGraphView");
	if (service === void 0) throw readSourceUnavailable("graph-view", "singularity/view: this deployment mounts no graph view service, so a graph has no readable revision, evaluation or progress");
	return service;
}
/** Answer a read failure: a missing fact producer is a named 503, anything else the caller's own 400. */
function failRead(res, error) {
	const source = error.source;
	if (error.code === "read-source-unavailable" && typeof source === "string") {
		sendJson(res, 503, {
			error: messageOf(error),
			source
		});
		return;
	}
	fail(res, error);
}
/** Where a sealed graph's own history lives; the refusal names it so a caller is never left guessing. */
function historyPathOf(graphId) {
	return `${GRAPHS_PATH}/${encodeURIComponent(graphId)}/history`;
}
/**
* Whether one failure is a sealed-graph refusal. The marker is the error's own
* `code`, not its class: a service built from source and a route built from the
* bundle are two module instances of the same contract.
*/
function isSealedError(error) {
	if (error instanceof GraphSealedError) return true;
	if (error === null || typeof error !== "object") return false;
	return error.code === "graph-sealed";
}
/** The graph a sealed refusal names, when it names one. */
function sealedGraphIdOf(error) {
	const id = error.graphId;
	return typeof id === "string" && id.length > 0 ? id : void 0;
}
/** The sealed refusal every current-protocol read answers a legacy graph with. */
function sealedRefusal(res, graphId, reason) {
	sendJson(res, 409, {
		error: "graph-sealed",
		graphId,
		reason,
		history: historyPathOf(graphId)
	});
}
/** The summary projection: the mode, the identity and the derived progress, without the method facts. */
function summaryOf(wire) {
	return {
		formatVersion: wire.formatVersion,
		graph: wire.graph,
		access: wire.access,
		progress: wire.progress,
		generation: wire.generation
	};
}
function registerView(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: VIEW_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			try {
				const graphId = graphIdOf(req, "view");
				const access = graphAccessWire(await ctx.graphs.get(graphId));
				if (access.mode !== "current") {
					sealedRefusal(res, graphId, access.reason ?? `${graphId} carries no protocol marker`);
					return;
				}
				const wire = await graphViewOf$1(ctx).view(graphId);
				const summary = urlOf(req).searchParams.get("summary");
				sendJson(res, 200, summary === "1" || summary === "true" ? summaryOf(wire) : wire);
			} catch (error) {
				failRead(res, error);
			}
		}
	});
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
			broadcast.subscribe(res, graph.id);
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
					const layout = await ctx.layout.snapshotReadOnlyIn(graph.layoutStoreId);
					sendJson(res, 200, layout.exists ? layout.snapshot : null);
					return;
				}
				if (!guardMethod(req, res, "PUT")) return;
				assertCurrentGraph(graph);
				const body = await readJson(req);
				if (typeof body.sessionId !== "string" || body.sessionId.length === 0) throw new Error("layout put: sessionId required");
				if (body.node === void 0 || typeof body.node !== "object") throw new Error("layout put: node required");
				const topology = await ctx.graph.snapshotReadOnlyIn(graph.graphStoreId);
				if (!topology.exists || !topology.snapshot.agents.some((agent) => agent.id === body.sessionId)) throw new Error("layout: session belongs to another graph");
				await ctx.layout.setIn(graph.layoutStoreId, body.sessionId, body.node);
				sendJson(res, 200, await ctx.layout.snapshotIn(graph.layoutStoreId));
			} catch (error) {
				if (isSealedError(error)) {
					sealedRefusal(res, sealedGraphIdOf(error) ?? urlOf(req).searchParams.get("graphId") ?? "", messageOf(error));
					return;
				}
				fail(res, error);
			}
		}
	});
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
//#region src/web/api/history.ts
/** The file names one library's old evolution ledger may carry, newest writing first. */
function legacyEvolutionFiles(roots) {
	return [join(roots, "evolution", "proposals.jsonl"), join(roots, "methods.jsonl")];
}
/**
* One candidate file's legacy projection, or none when the file is not a legacy
* ledger at all: a v5 file belongs to the current protocol, so it is neither
* folded here nor allowed to refuse the history the sealed graph does hold.
*/
async function legacyLedgerOf(file) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	if (text.split("\n").some((line) => line.includes("\"formatVersion\":5"))) return [];
	return readLegacyMethodsSync(text);
}
/** The old review ledger the pre-protocol rounds wrote their completion notes into. */
function legacyCompletionsFile() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "review-agents", "agents.jsonl");
}
/** One old-ledger row as a legacy completion row, or nothing when the row carries no settled note. */
function legacyCompletionOf(row, graphKey) {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return void 0;
	const record = row;
	if (record.kind !== "settled") return void 0;
	const note = record.note;
	if (typeof note !== "string" || note.trim().length === 0) return void 0;
	if (typeof record.taskId !== "string" || typeof record.sessionId !== "string") return void 0;
	if (graphKey !== void 0 && typeof record.rootStoreId === "string" && record.rootStoreId !== graphKey) return void 0;
	return {
		format: "legacy-v1",
		sessionId: record.sessionId,
		taskId: record.taskId,
		note,
		recordedAt: typeof record.at === "string" ? record.at : ""
	};
}
/** Every legacy completion row one old ledger holds; a file that does not exist holds none. */
async function legacyCompletionsOf(file, graphKey) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const rows = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		let raw;
		try {
			raw = JSON.parse(line);
		} catch {
			throw new Error(`singularity/history: corrupt ledger line ${index + 1} in the legacy review ledger`);
		}
		const row = legacyCompletionOf(raw, graphKey);
		if (row !== void 0) rows.push(row);
	}
	return rows;
}
/**
* The read doors one legacy history draws on: the registry, the graph and layout
* services' zero-write doors, the task service's own, and the old ledgers whose
* files this deployment may still keep.
*/
function legacyReadDeps(ctx, rootSessionId) {
	const task = optionalService(ctx, "task");
	if (task === void 0) throw readSourceUnavailable("task", "singularity/history: this deployment mounts no task store, so a legacy graph's task store cannot be read");
	const runtime = optionalService(ctx, "taskRuntime");
	const libraryRoot = runtime === void 0 ? void 0 : libraryRoots(rootSessionId, environmentHomeOf(runtime)).root;
	return {
		graph: ctx.graph,
		layout: ctx.layout,
		task,
		...libraryRoot === void 0 ? {} : { legacyEvolution: async () => {
			for (const file of legacyEvolutionFiles(libraryRoot)) {
				const proposals = await legacyLedgerOf(file);
				if (proposals.length > 0) return {
					proposals,
					experiments: []
				};
			}
			return {
				proposals: [],
				experiments: []
			};
		} },
		legacyCompletions: async (key) => await legacyCompletionsOf(legacyCompletionsFile(), key)
	};
}
/**
* The history read for one graph: a current-protocol graph is refused with a
* pointer to the view route, a sealed one is projected verbatim and answered
* `writable: false`.
*/
function registerHistory(ctx) {
	return async (id, _req, res) => {
		try {
			const graph = await ctx.graphs.get(id);
			if (graphAccessWire(graph).mode === "current") {
				sendJson(res, 409, {
					error: "graph-not-sealed",
					graphId: id,
					view: `/singularity/view?graphId=${encodeURIComponent(id)}`
				});
				return;
			}
			sendJson(res, 200, await readLegacyGraph(legacyReadDeps(ctx, String(graph.rootSessionId)), graph));
		} catch (error) {
			failRead(res, error);
		}
	};
}

//#endregion
//#region src/web/api/graphs.ts
/** The refusal this boundary answers a sealed graph with, when the failure is that refusal. */
function sealed(res, error, fallbackId) {
	if (!isSealedError(error)) return false;
	sealedRefusal(res, sealedGraphIdOf(error) ?? fallbackId, messageOf(error));
	return true;
}
/** The unified read model per graph id, or the named refusal when this deployment mounts no fact producer. */
async function summariesOf(ctx) {
	try {
		const views = await graphViewOf$1(ctx).summaries();
		return { views: new Map(views.map((view) => [view.graph.id, view])) };
	} catch (error) {
		const source = error.source;
		return {
			views: /* @__PURE__ */ new Map(),
			error: {
				error: messageOf(error),
				source: typeof source === "string" ? source : "graph-view"
			}
		};
	}
}
/** One registry record as the list serves it: its repositories, its access mode and the method facts a view holds. */
function entryOf(graph, repos, view) {
	return {
		...graph,
		repos,
		access: graphAccessWire(graph),
		...view === void 0 ? {} : {
			progress: view.progress,
			evaluation: view.evaluation
		}
	};
}
function registerGraphs(ctx) {
	const history = registerHistory(ctx);
	const stopList = ctx.webServer.register({
		kind: "exact",
		path: GRAPHS_PATH,
		handler: async (req, res) => {
			try {
				if (!guardMethod(req, res, "GET", "POST")) return;
				if (req.method === "GET") {
					const snapshot = await ctx.graphs.snapshot();
					const { views, error } = await summariesOf(ctx);
					sendJson(res, 200, {
						...snapshot,
						graphs: snapshot.graphs.map((graph$1) => entryOf(graph$1, ctx.envBuilder.store.get(graph$1.envId).components.map((component) => `${component.owner}/${component.repo}`), views.get(graph$1.id))),
						...error === void 0 ? {} : { viewError: error }
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
				const [id, action] = parts;
				if (id === void 0 || id.length === 0) throw new Error("graphs: missing graph id");
				if (parts.length === 1) {
					if (!guardMethod(req, res, "PATCH")) return;
					const body = await readJson(req);
					sendJson(res, 200, await ctx.graphs.setPins(id, body));
					return;
				}
				if (parts.length !== 2) throw new Error(`graphs: unknown path ${url.pathname}`);
				if (action === "history") {
					if (!guardMethod(req, res, "GET")) return;
					await history(id, req, res);
					return;
				}
				if (action === "library") {
					if (!guardMethod(req, res, "GET")) return;
					const graph = await ctx.graphs.get(id);
					const runtime = optionalService(ctx, "taskRuntime");
					if (runtime === void 0) {
						sendJson(res, 503, {
							error: "graphs: this deployment mounts no task runtime, so the graph library cannot be read",
							source: "task-runtime"
						});
						return;
					}
					sendJson(res, 200, await runtime.libraryRead(graph.rootSessionId));
					return;
				}
				if (action === "select" || action === "ready" || action === "delete") {
					if (!guardMethod(req, res, "POST")) return;
					if (action === "delete") {
						await ctx.graphs.remove(id);
						sendJson(res, 200, { ok: true });
						return;
					}
					try {
						sendJson(res, 200, action === "select" ? await ctx.graphs.select(id) : await ctx.graphs.markReady(id));
					} catch (error) {
						if (sealed(res, error, id)) return;
						throw error;
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
//#region src/web/api/methods.ts
const METHODS_PATH = "/singularity/methods";
/** The SSE frame name a method change is broadcast under, beside `hitl` and `task`. */
const METHODS_EVENT = "methods";
/** The statuses and asset classes this surface filters by, exactly as `method_list` does. */
const STATUSES = [
	"draft",
	"evaluated",
	"discarded",
	"published"
];
const KINDS = [
	"skill",
	"task-template",
	"capability"
];
/** The file a draft's landed strategy decision sits in: beside the report it recomputes from. */
const DECISION_FILE = "strategy-decision.json";
/** Revision-directory bookkeeping no asset difference counts as an asset. */
const METADATA_FILES = new Set(["manifest.json", "draft.json"]);
function graphRegistryOf(ctx) {
	const graphs = optionalService(ctx, "graphs");
	if (graphs === void 0) throw new Error("methods: this deployment offers no graph registry, so a graph id cannot be resolved to its library");
	return graphs;
}
function methodEnvironmentOf(ctx) {
	const runtime = optionalService(ctx, "taskRuntime");
	if (runtime === void 0) throw new Error("methods: this deployment offers no task runtime, so no revision, draft or pointer can be read");
	const bind = (member) => {
		const value = runtime[member];
		if (typeof value !== "function") throw new Error(`methods: this deployment's task runtime offers no ${String(member)}, so the library cannot be read`);
		return value.bind(runtime);
	};
	return {
		libraryForSession: bind("libraryForSession"),
		activeEnvironmentView: bind("activeEnvironmentView"),
		openPointerIntent: bind("openPointerIntent")
	};
}
/**
* The graph-level projection, or the reason it could not answer. A projection
* that names a missing fact producer is reported as such: the console shows the
* pointer facts this boundary read itself and the refusal beside nothing, never a
* default that looks like a view.
*/
async function graphViewOf(ctx, graphId) {
	const service = optionalService(ctx, "singularityGraphView");
	if (service === void 0) return {
		view: null,
		refusal: "no graph view service is mounted in this deployment"
	};
	try {
		return {
			view: await service.view(graphId),
			refusal: null
		};
	} catch (error) {
		return {
			view: null,
			refusal: messageOf(error)
		};
	}
}
/**
* The publication approvals this process is holding an answer for. A publication
* approval is one HITL card, and its body is the text the tool rendered, so the
* card that names a publication is read off that text rather than a second store.
*/
function publicationApprovals(ctx) {
	const hitl = optionalService(ctx, "hitl");
	if (hitl === void 0) return [];
	return hitl.list().filter((card) => card.kind === "approve" && (card.prompt.startsWith("Method publish for ") || card.prompt.startsWith("Method rollback of library "))).map((card) => ({
		id: card.id,
		sessionId: card.sessionId,
		createdAt: card.createdAt,
		prompt: card.prompt
	}));
}
/** The landed strategy decision of one draft, read where the strategy writes it. */
async function decisionOf(root, view) {
	if (view.evaluation === void 0) return void 0;
	const path = join(dirname(resolve(root, view.evaluation.reportPath)), DECISION_FILE);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	return JSON.parse(text);
}
/**
* The compact history the strategy folds, from the same facts the `method_list`
* tool assembles: the drafts of the v5 ledger, the reports they settled, the
* landed admissions and the revisions this library published. The v5 draft line
* carries no declared edits — the report already froze the hypothesis — so the
* candidate facts carry none here either.
*/
async function historyOf(input) {
	const policy = DEFAULT_STRATEGY_POLICY;
	const candidates = input.drafts.map(({ view }, round) => ({
		candidateId: view.draft.draftId,
		libraryId: input.libraryId,
		contentDigest: view.draft.candidateRevision.digest,
		round,
		edits: []
	}));
	const evaluations = [];
	const refutations = [];
	const versions = [];
	for (const [round, { view, admission }] of input.drafts.entries()) {
		const draftId = view.draft.draftId;
		if (view.evaluation !== void 0) {
			const report = await evaluationOf(input.sources, draftId);
			evaluations.push({
				candidateId: draftId,
				scope: cohortDigestOf(report),
				measurement: sideMeasurementOf({
					report,
					side: "candidate",
					scale: scaleOf(report),
					policy
				}),
				verdict: report.verdict,
				evidenceRefs: [report.evaluationId]
			});
			if (admission !== null && !admission.admissible) refutations.push({
				candidateId: draftId,
				contentDigest: view.draft.candidateRevision.digest,
				reasonCode: admission.reasonCode,
				reason: admission.reason,
				evidenceRefs: [report.evaluationId],
				round
			});
		} else if (view.status === "discarded") refutations.push({
			candidateId: draftId,
			contentDigest: view.draft.candidateRevision.digest,
			reasonCode: "not-measured",
			reason: view.discardReason ?? "discarded without an evaluation",
			evidenceRefs: [],
			round
		});
		if (view.published !== void 0) versions.push({
			round,
			libraryId: input.libraryId,
			revisionId: view.published.revisionId,
			contentDigest: view.draft.candidateRevision.digest
		});
	}
	return foldHistory({
		candidates,
		evaluations,
		consumption: [],
		refutations,
		versions
	}, policy, candidates.length);
}
async function readLibrary(ctx, graphId, filter) {
	const graph = await graphRegistryOf(ctx).get(graphId);
	const caller = String(graph.rootSessionId);
	const env = methodEnvironmentOf(ctx);
	const resolved = await env.libraryForSession(caller);
	const library = {
		id: resolved.id,
		root: resolved.root
	};
	const [environment, intent, projection] = await Promise.all([
		env.activeEnvironmentView(caller),
		env.openPointerIntent(caller),
		graphViewOf(ctx, graphId)
	]);
	if (environment.protocol === "legacy") throw new Error(`methods: library "${environment.libraryId}" holds the legacy mutable layout, so it has a legacy method ledger and no v5 drafts; its history is read through GET /singularity/graphs/${graphId}/history`);
	const ledger = await openMethodLedger({
		root: library.root,
		libraryId: library.id
	});
	const sources = evaluationSourcesOf({
		ctx,
		caller,
		root: library.root,
		libraryId: library.id,
		ledger
	});
	const everyDraft = methodList(sources, {});
	const readings = /* @__PURE__ */ new Map();
	for (const view of everyDraft) {
		const decision = await decisionOf(library.root, view);
		readings.set(view.draft.draftId, {
			view,
			decision,
			admission: decision?.admissions.find((entry) => entry.candidateId === view.draft.draftId) ?? null
		});
	}
	const drafts = (filter.kind === void 0 && filter.status === void 0 ? everyDraft : methodList(sources, filter)).map((view) => readings.get(view.draft.draftId));
	return {
		libraryId: library.id,
		root: library.root,
		environment,
		drafts,
		history: await historyOf({
			sources,
			libraryId: library.id,
			drafts: [...readings.values()]
		}),
		intent,
		view: projection.view,
		viewRefusal: projection.refusal,
		sources
	};
}
function draftWire(reading) {
	const { draft } = reading.view;
	return {
		draftId: draft.draftId,
		kind: draft.kind,
		identity: draft.identity,
		status: reading.view.status,
		baseRevision: draft.baseRevision,
		candidateRevision: draft.candidateRevision,
		rationale: draft.rationale,
		sourceRefs: draft.sourceRefs,
		actor: draft.actor,
		at: draft.at,
		evaluation: reading.view.evaluation ?? null,
		admission: reading.admission,
		published: reading.view.published ?? null,
		rolledback: reading.view.rolledback ?? null,
		discardReason: reading.view.discardReason ?? null,
		trialSides: reading.view.trials.length,
		trail: reading.view.history
	};
}
/** One revision directory's files by path; the ledger's own bookkeeping is not an asset. */
async function fileDigestsOf(root, prefix = "") {
	let entries;
	try {
		entries = await readdir(join(root, prefix), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return /* @__PURE__ */ new Map();
		throw error;
	}
	const files = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			for (const [nested, digest] of await fileDigestsOf(root, path)) files.set(nested, digest);
			continue;
		}
		if (!entry.isFile() || METADATA_FILES.has(path)) continue;
		files.set(path, createHash("sha256").update(await readFile(join(root, path))).digest("hex"));
	}
	return files;
}
/** The candidate's difference at file identity level, in path order. */
async function fileDiffOf(input) {
	const before = input.fromRoot === null ? /* @__PURE__ */ new Map() : await fileDigestsOf(input.fromRoot);
	const after = await fileDigestsOf(input.toRoot);
	const files = [];
	for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const was = before.get(path);
		const now = after.get(path);
		if (was !== void 0 && was === now) continue;
		if (was === void 0) files.push({
			path,
			change: "added",
			sha256: now
		});
		else if (now === void 0) files.push({
			path,
			change: "removed",
			sha256: was
		});
		else files.push({
			path,
			change: "updated",
			sha256: now
		});
	}
	return {
		from: input.from,
		to: input.to,
		files,
		digest: createHash("sha256").update(files.map((file) => `${file.change} ${file.path} ${file.sha256}`).join("\n")).digest("hex")
	};
}
/**
* The candidate's difference against the revision it was written against. A
* draft that already published is read from the frozen revision the pointer
* holds; a draft still staged is read from its own directory, which only the
* pointer transaction freezes.
*/
async function diffOf(library, view) {
	const candidate = view.published === void 0 ? await readEnvironmentDraft(library, view.draft.draftId) : await readRevision(library, view.published.revisionId);
	if (candidate === void 0) return null;
	const baseline = await readRevision(library, view.draft.baseRevision.revisionId);
	return await fileDiffOf({
		from: view.draft.baseRevision.revisionId,
		fromRoot: baseline?.root ?? null,
		to: candidate.manifest.revisionId,
		toRoot: candidate.root
	});
}
/** The draft filter one request asks for, refusing an unknown enum value by name. */
function filterOf(req) {
	const params = urlOf(req).searchParams;
	const kind = params.get("kind");
	if (kind !== null && kind.length > 0 && !KINDS.includes(kind)) throw new Error(`methods: unknown kind "${kind}"; this surface serves ${KINDS.join(", ")}`);
	const status = params.get("status");
	if (status !== null && status.length > 0 && !STATUSES.includes(status)) throw new Error(`methods: unknown status "${status}"; this surface serves ${STATUSES.join(", ")}`);
	return {
		...kind === null || kind.length === 0 ? {} : { kind },
		...status === null || status.length === 0 ? {} : { status }
	};
}
/** The graph id one request names; a request without one is refused rather than answered for the selected graph. */
function graphIdOrFail(req, res) {
	try {
		return graphIdOf(req, "methods");
	} catch (error) {
		fail(res, error);
		return;
	}
}
async function serveList(ctx, req, res) {
	const graphId = graphIdOrFail(req, res);
	if (graphId === void 0) return;
	let filter;
	try {
		filter = filterOf(req);
	} catch (error) {
		fail(res, error);
		return;
	}
	try {
		const reading = await readLibrary(ctx, graphId, filter);
		sendJson(res, 200, {
			graphId,
			libraryId: reading.libraryId,
			environment: reading.environment,
			drafts: reading.drafts.map(draftWire),
			history: reading.history,
			intent: reading.intent,
			approvals: publicationApprovals(ctx),
			view: reading.view,
			viewRefusal: reading.viewRefusal
		});
	} catch (error) {
		fail(res, error);
	}
}
async function serveDetail(ctx, req, res) {
	const graphId = graphIdOrFail(req, res);
	if (graphId === void 0) return;
	const draftId = decodeURIComponent(urlOf(req).pathname.slice(21));
	if (draftId.length === 0 || draftId.includes("/")) {
		sendJson(res, 404, { error: `methods: unknown path ${urlOf(req).pathname}` });
		return;
	}
	try {
		const reading = await readLibrary(ctx, graphId, {});
		const found = reading.drafts.find((entry) => entry.view.draft.draftId === draftId);
		if (found === void 0) {
			sendJson(res, 404, { error: `methods: unknown draft "${draftId}"` });
			return;
		}
		const report = found.view.evaluation === void 0 ? null : await evaluationOf(reading.sources, draftId);
		sendJson(res, 200, {
			graphId,
			libraryId: reading.libraryId,
			environment: reading.environment,
			status: found.view.status,
			draft: found.view.draft,
			plan: found.view.plan ?? null,
			planDigest: found.view.planDigest ?? null,
			trials: found.view.trials,
			evaluation: found.view.evaluation ?? null,
			report,
			decision: found.decision ?? null,
			admission: found.admission,
			diff: await diffOf({
				id: reading.libraryId,
				root: reading.root
			}, found.view),
			intent: reading.intent
		});
	} catch (error) {
		fail(res, error);
	}
}
/**
* The read routes: the library's method state, and one draft's evaluation. Both
* are `GET` only — the console answers a publication through the HITL card the
* tool already opened, and a second write path is what the refactor removes.
*/
function registerMethods(ctx) {
	const stopList = ctx.webServer.register({
		kind: "exact",
		path: METHODS_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			await serveList(ctx, req, res);
		}
	});
	const stopDetail = ctx.webServer.register({
		kind: "prefix",
		path: METHODS_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			await serveDetail(ctx, req, res);
		}
	});
	return () => {
		stopList();
		stopDetail();
	};
}
/**
* Forward every method change onto the event stream, as `evolution/change` was
* forwarded: the console re-reads `/singularity/methods` when one arrives.
*/
function subscribeMethods(ctx, broadcast) {
	return ctx.on("methods/change", (frame) => broadcast.publishEvent(METHODS_EVENT, frame));
}

//#endregion
//#region src/web/api/models.ts
function registerModels(ctx) {
	return ctx.webServer.register({
		kind: "exact",
		path: MODELS_PATH,
		handler: async (req, res) => {
			if (!guardMethod(req, res, "GET")) return;
			try {
				const llm = ctx.get("llm");
				const defaults = ctx.get("agentDefaultModel");
				const providers = await Promise.all(llm.listProviders().map(async (route) => {
					try {
						const models = await llm.listModels(route.id);
						return {
							id: route.id,
							displayName: route.name,
							models: models.map((model) => ({
								id: model.id,
								name: model.name
							}))
						};
					} catch (error) {
						return {
							id: route.id,
							displayName: route.name,
							models: [],
							error: messageOf(error)
						};
					}
				}));
				const selection = defaults.currentSelection();
				sendJson(res, 200, {
					providers,
					default: {
						provider: selection.provider,
						model: selection.model,
						...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
					}
				});
			} catch (error) {
				fail(res, error);
			}
		}
	});
}

//#endregion
//#region src/web/api/task.ts
/** The `storeId` query parameter, answered with the route's own refusal when it is missing. */
function storeIdOf(req, who, res) {
	try {
		return queryOf(req, "storeId", who);
	} catch (error) {
		fail(res, error);
		return;
	}
}
/**
* The task store this boundary reads, through the zero-write door: a store that
* does not exist answers `exists:false` instead of being created by the read, so
* a legacy graph's console never writes anything.
*/
async function snapshotOf(task, storeId) {
	const read = await task.snapshotReadOnly(storeId);
	return read.exists ? read.snapshot : null;
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
				sendJson(res, 503, {
					error: "task: this deployment mounts no task store",
					source: "task"
				});
				return;
			}
			try {
				sendJson(res, 200, { snapshot: await snapshotOf(task, storeId) });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
				sendJson(res, 503, {
					error: "task: this deployment mounts no task store",
					source: "task"
				});
				return;
			}
			let reviews;
			try {
				const read = await task.snapshotReadOnly(storeId);
				reviews = read.exists ? read.snapshot.reviews : [];
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
/**
* One SSE client receives one `snapshot` frame: the canvas projection (metadata,
* access mode, topology, layout) plus the unified read model when this
* deployment can produce it, or the named refusal that says which producer is
* missing. No client keeps a graph record of its own any more — the frame is
* read once per client from the same services, and the read model is never
* assembled here.
*/
var GraphBroadcast = class {
	clients = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	subscribe(res, graphId) {
		this.clients.set(res, {
			graphId,
			writes: Promise.resolve()
		});
		this.snapshot(res);
	}
	snapshot(res) {
		const client = this.clients.get(res);
		client.writes = client.writes.then(async () => {
			if (res.destroyed) return;
			res.write(`event: snapshot\ndata: ${JSON.stringify(await this.frameOf(client.graphId))}\n\n`);
		}).catch((error) => {
			this.clients.delete(res);
			res.destroy(error);
		});
	}
	/** The one frame: the canvas projection, and the unified read model or its named refusal. */
	async frameOf(graphId) {
		const canvas = await this.ctx.graphs.view(graphId);
		const service = optionalService(this.ctx, "singularityGraphView");
		if (canvas.access.mode !== "current" || service === void 0) return {
			...canvas,
			graphView: null
		};
		try {
			return {
				...canvas,
				graphView: await service.view(graphId)
			};
		} catch (error) {
			const source = error.source;
			return {
				...canvas,
				graphView: null,
				viewError: {
					error: messageOf(error),
					source: typeof source === "string" ? source : "graph-view"
				}
			};
		}
	}
	publishEvent(name$1, value) {
		const frame = `event: ${name$1}\ndata: ${JSON.stringify(value)}\n\n`;
		for (const [res] of this.clients) if (res.destroyed) this.clients.delete(res);
		else res.write(frame);
	}
	publishGraphs(snapshot) {
		for (const [res, client] of this.clients) if (res.destroyed) this.clients.delete(res);
		else if (snapshot.graphs.some((graph) => graph.id === client.graphId)) this.snapshot(res);
		else res.end();
	}
	/** Re-snapshot only the clients whose own graph store is the one that changed. */
	changed(id, kind) {
		for (const [res, client] of this.clients) {
			if (res.destroyed) {
				this.clients.delete(res);
				continue;
			}
			this.ctx.graphs.get(client.graphId).then((record) => {
				if ((kind === "graph" ? record.graphStoreId : record.layoutStoreId) === id) this.snapshot(res);
			}).catch(() => {
				this.clients.delete(res);
				res.end();
			});
		}
	}
	publishLayout(snapshot) {
		this.changed(snapshot.id, "layout");
	}
	publish(snapshot) {
		this.changed(snapshot.id, "graph");
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
	"hitl",
	"llm",
	"agentDefaultModel"
];
function apply(ctx) {
	const broadcast = new GraphBroadcast(ctx);
	ctx.on("graph/change", (snapshot) => broadcast.publish(snapshot));
	ctx.on("layout/change", (snapshot) => broadcast.publishLayout(snapshot));
	ctx.on("graphs/change", (snapshot) => broadcast.publishGraphs(snapshot));
	ctx.on("hitl/change", (pending) => broadcast.publishEvent("hitl", { pending }));
	ctx.on("task/change", (snapshot) => broadcast.publishEvent("task", { storeId: snapshot.id }));
	ctx.on("pr-chat/path", (event) => broadcast.publishEvent("pr-chat/path", event));
	ctx.on("pr-chat/sent", (event) => broadcast.publishEvent("pr-chat/sent", event));
	ctx.effect(() => {
		const graph = registerGraph(ctx);
		const layout = registerLayout(ctx);
		const graphs = registerGraphs(ctx);
		const view = registerView(ctx);
		const methods = registerMethods(ctx);
		const models = registerModels(ctx);
		const graphEnvs = registerGraphEnvs(ctx);
		const hitl = registerHitl(ctx);
		const task = registerTask(ctx);
		const recovery = registerRecovery(ctx);
		const review = registerReview(ctx);
		const methodEvents = subscribeMethods(ctx, broadcast);
		const events = registerEvents(ctx, broadcast);
		const map = registerMapStatic(ctx);
		return () => {
			graph();
			layout();
			graphs();
			view();
			methods();
			models();
			graphEnvs();
			hitl();
			task();
			recovery();
			review();
			methodEvents();
			events();
			map();
			broadcast.close();
		};
	}, "web: routes");
}

//#endregion
export { apply, inject, name };