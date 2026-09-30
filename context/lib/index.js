import { Context, Service } from "@deepseek-ai/cordis";
import { blockingQuestionsOf, questionsAwaitingAnswerOf, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { SESSION_NOT_IN_GRAPH } from "@dangosys/dsh-singularity-graphs";
import { SESSION_QUERY_READ_WINDOW_MAX, extractSessionEventText } from "@deepseek-ai/dsh-session-query";
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from "@dangosys/dsh-singularity-task-runtime";
import { TextRetainer, formatRetentionNotice } from "@deepseek-ai/dsh-output-retention";

//#region src/refusals.ts
/**
* The same vocabulary as a value, so a tool schema or a test can pin the whole
* set instead of trusting that no ninth name was added quietly.
*/
const NAMED_REFUSALS = [
	"not-activated",
	"unbound",
	"binding-conflict",
	"cross-graph",
	"not-found",
	"stale-reference",
	"unreadable",
	"context-too-large"
];
/** One successful read; the continuation fields appear only when something is left. */
function read(text, source, continuation) {
	if (continuation === void 0) return {
		ok: true,
		text,
		source
	};
	return {
		ok: true,
		text,
		source,
		hasMore: continuation.hasMore,
		nextOffset: continuation.nextOffset
	};
}
/** One refused read: the name first, then the detail a caller renders as-is. */
function refused(refusal, detail) {
	return {
		ok: false,
		refusal,
		detail
	};
}

//#endregion
//#region src/assembly.ts
/**
* Section name of the assembled contract. The name the old contract-reinjection
* registered, kept: it is the one slot the immutable half has ever had, now
* filled from the store at every assembly instead of rendered once at spawn.
*/
const WORKER_CONTRACT_SECTION = "singularity:worker-contract";
/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
const WORKER_CONTRACT_ORDER = 80;
/** The dynamic half's context name on the runtime-context plane. */
const STATE_CONTEXT_NAME = "singularity:state";
/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
const STATE_CONTEXT_ORDER = 130;
/**
* The question plane's context name on the same plane (A4 §F.1). A separate
* name, not a second section of {@link STATE_CONTEXT_NAME}: the two are read at
* different moments (the run's state changes with the protocol, the questions
* change with what has been answered and read), and one changing must not make
* the other look new to the loop's deduplication.
*/
const QUESTIONS_CONTEXT_NAME = "singularity:questions";
/** Placement among the runtime contexts: right behind the state plane. */
const QUESTIONS_CONTEXT_ORDER = 140;
/**
* The sections that sort at or ahead of {@link WORKER_CONTRACT_ORDER}, by name
* (`AssembledSection` carries no order, so the insertion point is computed from
* who these are): the harness identity, the deployment persona prefix, and this
* deployment's two role sections. The contract goes right behind them, ahead of
* the tool guidance that starts at order 500.
*/
const PRE_CONTRACT_SECTIONS = new Set([
	"harness:identity",
	"deployment:persona-prefix",
	"singularity:root",
	"singularity:worker"
]);
/** The error a refused assembly throws: the refusal is its name, the detail its message. */
var AssemblyRefusalError = class extends Error {
	constructor(refusal, detail) {
		super(detail);
		this.refusal = refusal;
		this.name = "AssemblyRefusalError";
	}
};
/** Throw the projection's refusal as the named rejection of this model request. */
function throwRefusal(read$1) {
	throw new AssemblyRefusalError(read$1.refusal, `system-prompt assembly refused (${read$1.refusal}): ${read$1.detail}`);
}
/** The section the immutable half becomes: literal text, never variable-interpolated. */
function contractSection(text) {
	return {
		name: WORKER_CONTRACT_SECTION,
		text,
		interpolate: false
	};
}
/**
* Replace the contract section by name, or insert it at its order. The assembly
* arrives sorted; the insertion point is the first section that is not one of
* the known pre-contract ones.
*/
function withContractSection(assembly, text) {
	const existing = assembly.sections.find((section) => section.name === WORKER_CONTRACT_SECTION);
	if (existing !== void 0) {
		existing.text = text;
		existing.interpolate = false;
		return;
	}
	let index = 0;
	while (index < assembly.sections.length && PRE_CONTRACT_SECTIONS.has(assembly.sections[index].name)) index += 1;
	assembly.sections.splice(index, 0, contractSection(text));
}
/** Append one plane to the runtime-context plane; an unchanged name is replaced, never duplicated. */
function withRuntimeContext(assembly, name, text) {
	const existing = assembly.contexts.find((context) => context.name === name);
	if (existing !== void 0) {
		existing.text = text;
		return;
	}
	assembly.contexts.push({
		name,
		text
	});
}
/**
* The question plane, when it has anything to say: an empty projection adds no
* context at all, so a run with nothing pending carries no empty entry into the
* loop's deduplication.
*/
function withQuestionContext(assembly, text) {
	if (text.length > 0) withRuntimeContext(assembly, QUESTIONS_CONTEXT_NAME, text);
}
/**
* The one assembly step this package runs (see the module doc for who gets
* what). Mutates the assembly and delegates; a bound caller whose projection
* refuses rejects the whole waterfall, which is what refuses the model request.
*/
async function assembleSingularityContext(service, assembly, context, next) {
	const agent = context.agent;
	if (agent === void 0) return next();
	const sessionId = String(agent.id);
	const resolution = await service.resolveCaller(sessionId, context.signal);
	switch (resolution.kind) {
		case "worker": {
			const contract = await service.contractProjection(sessionId, context.signal);
			if (!contract.ok) throwRefusal(contract);
			const dynamic = await service.dynamicProjection(sessionId, context.signal);
			if (!dynamic.ok) throwRefusal(dynamic);
			const questions = await service.questionProjection(sessionId, context.signal);
			if (!questions.ok) throwRefusal(questions);
			withContractSection(assembly, contract.text);
			withRuntimeContext(assembly, STATE_CONTEXT_NAME, dynamic.text);
			withQuestionContext(assembly, questions.text);
			return next();
		}
		case "root": {
			if (resolution.task === void 0) return next();
			const contract = await service.contractProjection(sessionId, context.signal);
			if (!contract.ok) throwRefusal(contract);
			const questions = await service.questionProjection(sessionId, context.signal);
			if (!questions.ok) throwRefusal(questions);
			withContractSection(assembly, contract.text);
			withQuestionContext(assembly, questions.text);
			return next();
		}
		case "reviewer": {
			const contract = await service.contractProjection(sessionId, context.signal);
			if (!contract.ok) throwRefusal(contract);
			withContractSection(assembly, contract.text);
			return next();
		}
		case "member": return next();
		case "unbound":
			if (resolution.placement === "outside") return next();
			throwRefusal(refused(resolution.refusal, resolution.detail));
	}
}

//#endregion
//#region src/bindings.ts
/**
* The one thing the single-record seam cannot express: a ledger that holds
* several *conflicting* rows for one session (or a ledger this process cannot
* read at all). A source that finds itself in either state raises this instead
* of picking a row — silently answering one of two delegations would make the
* read domain depend on file order. The service maps `kind` onto the named
* refusals `binding-conflict` / `unreadable`.
*/
var ReviewerBindingError = class extends Error {
	kind;
	constructor(kind, message$2) {
		super(message$2);
		this.name = "ReviewerBindingError";
		this.kind = kind;
	}
};
function unbound(sessionId, refusal, detail, graph, placement) {
	return { resolution: {
		kind: "unbound",
		sessionId,
		refusal,
		detail,
		placement,
		...graph === void 0 ? {} : { graph }
	} };
}
function outside(sessionId, refusal, detail) {
	return unbound(sessionId, refusal, detail, void 0, "outside");
}
function failed(sessionId, refusal, detail, graph) {
	return unbound(sessionId, refusal, detail, graph, "failed");
}
function callerGraph(graph) {
	return {
		id: graph.id,
		name: graph.name,
		envId: graph.envId,
		rootSessionId: String(graph.rootSessionId)
	};
}
/**
* The session's own run in one store: the **last** `TaskStarted` naming it, so a
* session that ran twice is read through the run it is executing now. Absent when
* the store holds no such run — which is what `member` and `not-activated` mean.
* (This is the store's record, not the runtime's `runForSession`: the read path
* never asks the runtime where a session is, because that lookup reconciles.)
*/
function runOfSessionIn(snapshot, sessionId) {
	let found;
	for (const run of snapshot.runs) {
		if (run.sessionId !== sessionId) continue;
		if (!snapshot.tasks.some((task) => task.taskId === run.taskId)) continue;
		found = run;
	}
	return found;
}
/** The task one run belongs to, as the same snapshot holds it. */
function taskOfRun(snapshot, run) {
	return run === void 0 ? void 0 : snapshot.tasks.find((task) => task.taskId === run.taskId);
}
/** The graph whose root store is `storeId`, or `undefined` when this deployment owns none. */
async function graphForStore(graphs, storeId) {
	for (const graph of await graphs.list()) if (rootTaskStoreId(graph.rootSessionId) === storeId) return graph;
}
/** The store's snapshot, or `undefined` for the one legal absence: a store that does not exist yet. */
async function openDomain(task, storeId) {
	try {
		return { snapshot: await task.openStore(storeId) };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (/does not exist/.test(detail)) return {};
		return { failure: detail };
	}
}
/**
* The failure one binding source reported, from the error's own shape. The seam
* is implemented by whatever package owns the ledger, so the error a source
* raises can be an instance of *its* copy of {@link ReviewerBindingError}: a
* class check alone would silently degrade a named conflict to a generic
* unreadable answer, so the contract (name plus `kind`) is what decides, and a
* class match is one way to satisfy it.
*/
function reviewerFailure(error) {
	const kind = error?.kind;
	if (kind !== "binding-conflict" && kind !== "unreadable") return void 0;
	if (error instanceof ReviewerBindingError || error instanceof Error && error.name === "ReviewerBindingError") return kind;
}
/**
* Consult every registered source and reduce their answers to one delegation:
* no source that answered means `none`, one distinct record means that record,
* and two sources that disagree about the same session mean a conflict rather
* than a coin toss. A source that cannot answer raises
* {@link ReviewerBindingError}, which is reported as-is.
*/
async function readDelegation(deps, sessionId) {
	const records = [];
	for (const source of deps.reviewerSources) {
		let record;
		try {
			record = await source.read(sessionId);
		} catch (error) {
			const failure = reviewerFailure(error);
			if (failure !== void 0) return {
				kind: "refused",
				refusal: failure,
				detail: error instanceof Error ? error.message : String(error)
			};
			return {
				kind: "refused",
				refusal: "unreadable",
				detail: `the reviewer binding source could not be read: ${error instanceof Error ? error.message : String(error)}`
			};
		}
		if (record === void 0) continue;
		if (!records.some((existing) => existing.rootStoreId === record.rootStoreId && existing.taskId === record.taskId && existing.actor === record.actor)) records.push(record);
	}
	if (records.length === 0) return { kind: "none" };
	if (records.length > 1) return {
		kind: "refused",
		refusal: "binding-conflict",
		detail: `session "${sessionId}" is bound to more than one reviewer delegation: ${records.map((record) => `${record.taskId} in ${record.rootStoreId} (by ${record.actor})`).join("; ")}. A read domain cannot be chosen between conflicting delegations.`
	};
	return {
		kind: "record",
		record: records[0]
	};
}
/**
* Resolve one live session to the domain it may read, from durable facts only.
*
* The order is the contract's: the caller's own graph membership, then its own
* persisted run, then a recorded delegation, then "a member with no binding of
* its own". Nothing in this function writes: opening the store is the store's
* own read-only open, and the runtime calls are observations.
*
* Every read that can fail says so in the resolution it returns: the graph
* lookup, the store's open and the ledger all answer `placement: 'failed'` when
* they cannot answer at all, so that the assembly (which is the one consumer
* that must not carry on regardless) can tell that apart from a session this
* deployment simply does not know (`placement: 'outside'`).
*/
async function loadCaller(deps, sessionId, signal) {
	signal?.throwIfAborted();
	const membership = await graphOfSession(deps.graphs, sessionId);
	if (membership.kind === "failed") return failed(sessionId, "unreadable", membership.detail);
	const graph = membership.kind === "graph" ? membership.graph : void 0;
	if (graph === void 0) {
		const delegation$1 = await readDelegation(deps, sessionId);
		if (delegation$1.kind === "refused") return failed(sessionId, delegation$1.refusal, delegation$1.detail);
		if (delegation$1.kind === "none") return outside(sessionId, "unbound", `session "${sessionId}" is not a published member of any graph and no delegation binds it; a context read needs a graph, and a session is never placed by the ids it passes.`);
		let placed;
		try {
			placed = await graphForStore(deps.graphs, delegation$1.record.rootStoreId);
		} catch (error) {
			return failed(sessionId, "unreadable", `the delegation of session "${sessionId}" names store "${delegation$1.record.rootStoreId}", and the graph registry could not be listed to place it: ${message$1(error)}`);
		}
		if (placed === void 0) return failed(sessionId, "unbound", `session "${sessionId}" is delegated to store "${delegation$1.record.rootStoreId}", which no graph in this deployment owns; the delegation cannot be placed, so there is no domain to read.`);
		return await reviewerOf(deps, sessionId, placed, delegation$1.record, signal);
	}
	const facts = callerGraph(graph);
	const storeId = rootTaskStoreId(graph.rootSessionId);
	const opened = await openDomain(deps.task, storeId);
	if (opened.failure !== void 0) return failed(sessionId, "unreadable", `the domain store "${storeId}" of graph "${graph.id}" cannot be read: ${opened.failure}`, facts);
	const snapshot = opened.snapshot;
	const isRoot = sessionId === String(graph.rootSessionId);
	if (snapshot === void 0 && !isRoot) {
		const spawned = await spawnedInto(deps, graph, sessionId);
		if (spawned.kind === "failed") return failed(sessionId, "unreadable", spawned.detail, facts);
		if (spawned.kind === "spawned") return failed(sessionId, "unreadable", `graph "${graph.id}" spawned session "${sessionId}" into itself, but its store "${storeId}" does not exist; the run this session is bound by was recorded in that store, so its absence means the store cannot be read, not that the session has nothing to read. No contract can be assembled for it.`, facts);
	}
	const base = {
		sessionId,
		graph: facts,
		storeId,
		recovery: await deps.taskRuntime.recoveryStatus(storeId)
	};
	const own = snapshot === void 0 ? void 0 : runOfSessionIn(snapshot, sessionId);
	const task = snapshot === void 0 ? void 0 : taskOfRun(snapshot, own);
	const workerRun = !isRoot && own !== void 0 && task !== void 0;
	const ledger = isRoot || workerRun ? await readDelegation(deps, sessionId) : void 0;
	if (ledger?.kind === "refused" && ledger.refusal === "binding-conflict") return failed(sessionId, ledger.refusal, ledger.detail, facts);
	if (isRoot) return {
		resolution: {
			...base,
			kind: "root",
			...task === void 0 || own === void 0 ? {} : {
				task,
				run: own
			}
		},
		...snapshot === void 0 ? {} : { snapshot }
	};
	if (workerRun) return {
		resolution: {
			...base,
			kind: "worker",
			task,
			run: own
		},
		...snapshot === void 0 ? {} : { snapshot }
	};
	const delegation = ledger ?? await readDelegation(deps, sessionId);
	if (delegation.kind === "refused") return failed(sessionId, delegation.refusal, delegation.detail, facts);
	if (delegation.kind === "record") return await reviewerOf(deps, sessionId, graph, delegation.record, signal);
	return {
		resolution: {
			...base,
			kind: "member"
		},
		...snapshot === void 0 ? {} : { snapshot }
	};
}
/** One error message, from whatever a read threw. */
function message$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The graph a session is a published member of — the registry's own lookup, read
* as the two different answers it really has. `SESSION_NOT_IN_GRAPH` is the
* registry's *fact* that no graph holds this session; anything else it throws is
* a failed read of the registry or of one of its stores, and is reported as
* such. Reading a failure as "no graph" is what let a bound worker's request be
* assembled with no contract at all (2026-09-25 rework, Q1).
*/
async function graphOfSession(graphs, sessionId) {
	try {
		return {
			kind: "graph",
			graph: await graphs.graphForSession(sessionId)
		};
	} catch (error) {
		if (error?.code === SESSION_NOT_IN_GRAPH) return { kind: "none" };
		return {
			kind: "failed",
			detail: `graph membership for session "${sessionId}" could not be read: ${message$1(error)}. A registry that cannot be read is not a session without a graph.`
		};
	}
}
/**
* Whether the graph itself spawned one session into it. `agent-runtime` records
* a `spawn` edge from the parent when it publishes a spawned session, so this is
* the graph store's own durable record — the same source membership comes from —
* and not an inference from names or status. A read that fails is reported as a
* failure: which side of the rule a session falls on decides whether its absent
* store is a named state or a read failure, and a guess would decide wrongly.
*/
async function spawnedInto(deps, graph, sessionId) {
	try {
		return (await deps.graphs.view(graph.id)).graph.edges.some((edge) => edge.kind === "spawn" && String(edge.to) === sessionId) ? { kind: "spawned" } : { kind: "member" };
	} catch (error) {
		return {
			kind: "failed",
			detail: `session "${sessionId}" is published by graph "${graph.id}", whose store "${rootTaskStoreId(graph.rootSessionId)}" does not exist, and whether that graph spawned this session cannot be read: ${message$1(error)}. A binding that cannot be read is not a binding.`
		};
	}
}
/**
* A reviewer's resolved domain: the graph its delegation names, checked against
* the graph its session is a member of. The delegation must agree with the live
* membership (`cross-graph` when it does not), and it is the delegation — not
* the caller's word — that names the delegated task; a task the store no longer
* holds leaves the contract reads at `not-found`.
*
* A delegation opens a graph's read domain, so its `actor` is checked too
* (2026-09-25 rework, Q2): the session the ledger records as the delegator must
* be one the delegated graph actually publishes (or, for a session the registry
* places nowhere, something this deployment never published at all — which is
* just as disqualifying). The actor is the ledger's own field and the
* membership is the registry's own view, so neither a model-supplied id nor a
* hand-written ledger row can grant a domain the graph does not own.
*/
async function reviewerOf(deps, sessionId, graph, record, signal) {
	signal?.throwIfAborted();
	const facts = callerGraph(graph);
	const storeId = rootTaskStoreId(graph.rootSessionId);
	if (storeId !== record.rootStoreId) return failed(sessionId, "cross-graph", `session "${sessionId}" is a member of graph "${graph.id}" (store "${storeId}") but its recorded delegation names store "${record.rootStoreId}"; a delegation never moves a session into another graph's domain.`, facts);
	const standing = await delegatorStanding(deps, sessionId, graph, record.actor);
	if (standing.kind === "refused") return failed(sessionId, standing.refusal, standing.detail, facts);
	const opened = await openDomain(deps.task, storeId);
	if (opened.failure !== void 0) return failed(sessionId, "unreadable", `the delegated store "${storeId}" cannot be read: ${opened.failure}`, facts);
	const recovery = await deps.taskRuntime.recoveryStatus(storeId);
	const task = opened.snapshot?.tasks.find((item) => item.taskId === record.taskId);
	return {
		resolution: {
			sessionId,
			graph: facts,
			storeId,
			recovery,
			kind: "reviewer",
			...task === void 0 ? {} : { task },
			delegation: record
		},
		...opened.snapshot === void 0 ? {} : { snapshot: opened.snapshot }
	};
}
/**
* Whether the session a delegation names as its delegator is really a session of
* the graph it delegated into. The check is the registry's published members
* (`view`) — the same record a `session` reference is checked against — and a
* registry that cannot be read refuses rather than assuming the actor is fine.
*/
async function delegatorStanding(deps, sessionId, graph, actor) {
	let member;
	try {
		member = await isGraphMember(deps.graphs, graph.id, actor);
	} catch (error) {
		return {
			kind: "refused",
			refusal: "unreadable",
			detail: `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be checked against graph "${graph.id}": ${message$1(error)}. An unverifiable delegator is not an authorization.`
		};
	}
	if (member) return { kind: "member" };
	let elsewhere;
	try {
		elsewhere = await deps.graphs.graphForSession(actor);
	} catch (error) {
		if (error?.code === SESSION_NOT_IN_GRAPH) return {
			kind: "refused",
			refusal: "unbound",
			detail: `the delegation of session "${sessionId}" into graph "${graph.id}" (store "${rootTaskStoreId(graph.rootSessionId)}") records "${actor}" as its delegator, and no graph in this deployment publishes that session; a delegation is granted by a session of the graph it delegates into, not by a name in a file.`
		};
		return {
			kind: "refused",
			refusal: "unreadable",
			detail: `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be placed: ${message$1(error)}. A delegator whose ownership cannot be read is not an authorization.`
		};
	}
	return {
		kind: "refused",
		refusal: "cross-graph",
		detail: `the delegation of session "${sessionId}" into graph "${graph.id}" (store "${rootTaskStoreId(graph.rootSessionId)}") was recorded by "${actor}", which graph "${graph.id}" does not publish: the delegator belongs to graph "${elsewhere?.id ?? "(unknown)"}", and a delegation never opens another graph's read domain.`
	};
}
/**
* Whether one session is a published member of the caller's graph — the check a
* `session` reference passes before any session history is read. Membership is
* the graph store's own record (read through the registry, which resolves the
* graph id to its store), so a guessed session id is refused before DSH is asked
* anything about it.
*/
async function isGraphMember(graphs, graphId, sessionId) {
	return (await graphs.view(graphId)).graph.agents.some((agent) => String(agent.id) === sessionId);
}

//#endregion
//#region src/limits.ts
/**
* The outer output bound of one context read, in UTF-8 bytes. Deliberately the
* deployment's own inline cap rather than a tighter local choice: see the module
* doc for the reference and for what stays outside the library.
*/
const CONTEXT_OUTPUT_LIMIT_BYTES = 5e4;
/** UTF-8 byte length of `text`. */
function utf8Bytes(text) {
	return Buffer.byteLength(text, "utf8");
}
/**
* The UTF-8 width of the character starting at UTF-16 index `index`.
*
* Widths are read off the code point, so an astral character (a surrogate pair,
* one character in two code units) is four bytes, and a lone surrogate — text a
* valid log cannot produce, but a string can hold — is counted as the three bytes
* the decoder writes for it. `utf8Bytes` on the same character agrees, which is
* what lets the retained byte count become the cursor below.
*/
function utf8WidthAt(text, index) {
	const code = text.codePointAt(index);
	if (code <= 127) return 1;
	if (code <= 2047) return 2;
	if (code <= 65535) return 3;
	return 4;
}
/** How many UTF-16 code units the character at `index` occupies (2 for an astral character). */
function codeUnitsAt(text, index) {
	return text.codePointAt(index) > 65535 ? 2 : 1;
}
/**
* Take at most `maxBytes` bytes starting at `offsetBytes` from `text`, never
* splitting a UTF-8 character, and report where the next page starts.
*
* The window itself is `TextRetainer({kind: 'head'})` from
* `@deepseek-ai/dsh-output-retention`: it keeps the first `maxBytes` bytes, trims
* a partial character at that cut, and reports the exact omitted byte count, so
* "where did this page end" is read off the library rather than recomputed here.
* The two things wrapped around it are the ones the library does not own: the
* cursor (`nextOffset`, derived from the bytes actually retained) and the floor
* that keeps a caller moving — an offset inside a character starts at the next
* character, and a page always carries at least that one character, so feeding
* `nextOffset` back never loops on the same offset.
*
* Both walks below advance by **code point**, and the string is cut by **code
* unit**: a surrogate pair is one character in two units, so counting characters
* into `String#slice` would start every page after an astral character one unit
* early — a lone surrogate in the page and a cursor inside a character.
*/
function sliceUtf8(text, offsetBytes, maxBytes) {
	const start = Math.max(0, Math.trunc(offsetBytes));
	const budget = Math.max(0, Math.trunc(maxBytes));
	let position = 0;
	let index = 0;
	while (index < text.length && position < start) {
		position += utf8WidthAt(text, index);
		index += codeUnitsAt(text, index);
	}
	if (index >= text.length) return {
		text: "",
		nextOffset: position,
		done: true
	};
	const rest = text.slice(index);
	const firstWidth = utf8WidthAt(text, index);
	const retainer = new TextRetainer({
		kind: "head",
		maxBytes: Math.max(budget, firstWidth)
	});
	retainer.push(rest);
	const retained = retainer.finish();
	const omitted = retained.omittedBytes.kind === "exact" ? retained.omittedBytes.count : 0;
	const kept = utf8Bytes(rest) - omitted;
	return {
		text: retained.text,
		nextOffset: position + kept,
		done: !retained.truncated
	};
}
/**
* A byte-metered line list: every line either fits whole — the newline included
* — or is refused, so no line a caller sees is a cut one. `remaining` is what a
* caller that wants to bound a *part* of its output (a reference list, say) has
* left to spend.
*
* This is the part of the bounding story `@deepseek-ai/dsh-output-retention`
* does not model: the library bounds a *byte* window or an *item* count, while a
* rendered page has to keep whole lines together, so its accounting is by line.
*/
var OutputBudget = class {
	lines = [];
	used = 0;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	get bytes() {
		return this.used;
	}
	get remaining() {
		return this.maxBytes - this.used;
	}
	/** Append one line when it fits; false leaves the budget untouched. */
	add(line) {
		const width = utf8Bytes(line) + (this.lines.length === 0 ? 0 : 1);
		if (width > this.remaining) return false;
		this.lines.push(line);
		this.used += width;
		return true;
	}
	/** Append every line that fits; returns how many were left out. */
	addAll(lines) {
		for (const [index, line] of lines.entries()) if (!this.add(line)) return lines.length - index;
		return 0;
	}
	text() {
		return this.lines.join("\n");
	}
};
/**
* One bounded list's omission line: the platform's standardized clause followed
* by this read's recovery sentence. `@deepseek-ai/dsh-output-retention`
* documents that split — the library owns the wording of *what* was omitted,
* the tool owns *how to read on* ("page through them with the status view",
* "read them by id") — so this line is composed through
* {@link formatRetentionNotice} rather than spelled out here.
*/
function omissionLine(report) {
	const omitted = {
		kind: "exact",
		count: report.omitted
	};
	return formatRetentionNotice({
		scope: report.scope,
		strategy: "head",
		unit: report.unit,
		limit: report.limit,
		kept: report.kept,
		omitted
	}, () => report.recovery);
}

//#endregion
//#region src/not-activated.ts
/**
* What an open root proposal means to the session waiting on one, in the words
* of the lifecycle the store itself holds: nothing here can be read as "the
* contract is accepted", and none of the three is a terminal state. `ready` and
* `approved` are the two a reader is most likely to misread — both mean the
* runtime still has to re-check and activate.
*/
const OPEN_ROOT_PROPOSAL_MEANING = new Map([
	["pending_review", "waiting for a review decision; the contract is not a task yet"],
	["ready", "recorded and past its re-check, waiting for the runtime to activate it"],
	["approved", "approved on the record, waiting for the runtime's post-approval re-check and activation"]
]);
/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
function openRootProposals(snapshot) {
	return (snapshot?.proposals?.all ?? []).filter((proposal) => proposal.kind === "root" && OPEN_ROOT_PROPOSAL_MEANING.has(proposal.status));
}
/** How a store with no root task stands, in the store's own terms. */
function storeStateText(snapshot) {
	return snapshot === void 0 ? "does not exist yet — a graph opens it when it is created and fills it when a contract is accepted, and neither state is a failure" : "opened, with no root task in it";
}
/**
* The not-activated view: the state named, whatever proposal is open, and the
* one action that changes it — accepting the user's own goal with `task_intake`.
* The last line is the point of the whole view: no objective is reported,
* because none has been accepted.
*/
function notActivatedLines(graph, storeId, snapshot) {
	const open = openRootProposals(snapshot);
	return [
		`graph ${graph.id} root session "${graph.rootSessionId}": not activated — no root contract has been accepted for this session, so there is no root task.`,
		`- store ${storeId}: ${storeStateText(snapshot)}`,
		...open.length === 0 ? ["- open proposals: none — no root contract is waiting for a decision or for its activation."] : ["- open proposals:", ...open.map((proposal) => `  - ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy} — ${OPEN_ROOT_PROPOSAL_MEANING.get(proposal.status)}`)],
		"- accept the user's objective here with `task_intake`: it writes the normalized root contract (objective, acceptance criteria,",
		"  assumptions, constraints and declared capabilities) and activates it as this graph's root task — or, where the deployment",
		"  reviews root contracts, it answers with a proposal id and activates nothing until a recorded decision.",
		"- `task_decompose` cannot run before that: it works on the root task, which does not exist until a contract is accepted.",
		"- no objective is reported here: this graph's name and its setup work are not a goal, and no contract has named one yet."
	];
}

//#endregion
//#region src/run-binding.ts
/** The first 12 hex of a digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest) {
	return digest.slice(0, 12);
}
/**
* Render one run's binding summary.
*
* `read` is the re-check result when the caller re-read the snapshot. A caller
* that has not read it omits it, and then no readability claim is made in either
* direction. When it is given and reports defects, they are rendered under a
* named refusal so a reader is never told to trust content that is not there.
*/
function renderRunBinding(binding, read$1) {
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
	if (read$1 !== void 0 && read$1.defects.length > 0) header.push("", "Bound content is not readable: the snapshot no longer matches this run's record, and the production skill path is not a substitute for it.", ...read$1.defects.map((defect) => `- ${defect}`));
	return header.join("\n");
}

//#endregion
//#region src/render.ts
/**
* The full phase note: what a phase-less record is and what a reader can do
* about it. A run created before the phase field existed has *no* phase, and its
* phase is never guessed — a non-terminal such run is an old record whose only
* legal continuation is cancellation, so reporting `active` for it would invite
* work nobody can admit. Terminal records need no phase.
*/
const NEEDS_RECOVERY = "needs-recovery (an old record: it was created before coordination phases, so it has no phase to continue from and cannot decompose, submit or verify — cancel this task tree to recover)";
/** The compact form, for a status line whose run part is a cell inside a denser line. */
const NEEDS_RECOVERY_SHORT = "needs-recovery (old record without a coordination phase)";
/** The submission a run carries, as one clause: who handed it in, when, and what it named. */
function submissionClause(submission) {
	const evidence = submission.evidenceRefs.length === 0 ? "" : `; evidence [${submission.evidenceRefs.join(", ")}]`;
	const notes = submission.notes === void 0 ? "" : `; notes: ${submission.notes}`;
	return `submitted by ${submission.origin} at ${submission.submittedAt}: "${submission.summary}"${evidence}${notes}`;
}
/**
* The phase one run's line shows (A4 §7.2, K1 §2): a run whose stored phase is
* `active` while a blocking question it asked is still open reads
* `waiting_answer` — a batch ending never answers that question, so the block
* outlives the batch and shows here either way. The derivation is the store's own
* question facts ({@link blockingQuestionsOf}) — never the gate, and never a
* phase written back: `waiting_children` keeps its own phase and the batch id it
* is waiting on beside any open question, and a run whose snapshot is not at hand
* (or carries no question index) shows the phase it has on record.
*/
function displayPhase(run, snapshot) {
	const phase = run.executionPhase;
	if (phase !== "active") return phase;
	return blockedByQuestion(run, snapshot) ? "waiting_answer" : phase;
}
/** Whether a blocking question this run asked is still open — the fact `waiting_answer` is derived from. */
function blockedByQuestion(run, snapshot) {
	return snapshot?.questions === void 0 ? false : blockingQuestionsOf(snapshot, run.runId).length > 0;
}
/**
* The phase, batch, submission and no-progress facts of one run, appended to a
* run line: where this run sits in the protocol, in that order, with the batch
* id only where a batch is still open — `run.batchId` is the current unfinished
* batch, cleared by the batch end that returned the run to `active`, so a run
* back at work reads without one. The batches a run ended are its history rather
* than its position: they are read from the run's own record (`run.batches`,
* printed with it by {@link runRecordText}), not folded into every line. A phase
* change and a progress marking rewrite these fields, so this is the run's
* current position, never a history.
*
* `snapshot` is where the one derived word comes from: an `active` run with an
* open blocking question reads `waiting_answer` (see {@link displayPhase}).
*/
function runPhaseSuffix(run, snapshot) {
	const parts = [];
	if (run.executionPhase !== void 0) {
		parts.push(`phase ${displayPhase(run, snapshot)}`);
		if (run.batchId !== void 0) parts.push(`batch ${run.batchId}`);
		if (run.submission !== void 0) parts.push(submissionClause(run.submission));
	} else if (run.status === "running") parts.push(NEEDS_RECOVERY);
	if (run.noProgress !== void 0) parts.push(`no-progress round ${run.noProgress.rounds} (${run.noProgress.kind})`);
	return parts.length === 0 ? "" : ` — ${parts.join("; ")}`;
}
/** The same fact for a denser line, where only the phase and the old-record marker fit. */
function runPhaseCell(run, snapshot) {
	if (run.executionPhase !== void 0) return ` — phase ${displayPhase(run, snapshot)}`;
	return run.status === "running" ? ` — ${NEEDS_RECOVERY_SHORT}` : "";
}
/**
* The protected acceptance inputs a criterion declares, as one suffix: the paths
* a worker must not modify. Empty for a criterion that declares none — such a
* criterion carries no protection, and printing an empty list would read like a
* claim that it does.
*/
function protectedInputsPart(criterion) {
	const declared = criterion.protectedInputs ?? [];
	return declared.length === 0 ? "" : ` [protected inputs: ${declared.map((ref) => ref.path).join(", ")}]`;
}
/** The protected inputs with their fixed identity, for a record read: the digest *is* part of the stored record. */
function protectedInputsDetail(criterion) {
	const declared = criterion.protectedInputs ?? [];
	if (declared.length === 0) return [];
	return ["  protected inputs:", ...declared.map((ref) => `  - ${ref.path} (sha256 ${ref.sha256})`)];
}
/** The acceptance criteria, one line per criterion, in declaration order. */
function criteriaLines(criteria) {
	return criteria.map((criterion) => {
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const flags = [
			criterion.verificationMode,
			...criterion.mandatory ? ["mandatory"] : [],
			...criterion.heuristic === true ? ["heuristic"] : []
		];
		return `- ${criterion.criterionId} [${flags.join(", ")}] ${criterion.description}${command}${protectedInputsPart(criterion)}`;
	});
}
/**
* The two contract facts a reader cannot read off the objective and the criteria
* table: what the contract assumes and what it constrains. A task created before
* the contract existed has neither, and renders exactly what it rendered before:
* nothing is invented for the part the store never held.
*/
function contractLines(task) {
	const contract = task.contract;
	if (contract === void 0) return [];
	return [...contract.assumptions.length === 0 ? [] : ["assumptions:", ...contract.assumptions.map((item) => `- ${item}`)], ...contract.constraints.length === 0 ? [] : ["constraints:", ...contract.constraints.map((item) => `- ${item}`)]];
}
/** One contract list on its own — the hard constraints a root briefing carries, or its assumptions. */
function constraintItems(task) {
	return task.contract?.constraints ?? [];
}
/** One artifact reference, as the store holds it. */
function artifactLine(artifact) {
	const digest = artifact.digest === void 0 ? "" : ` digest ${artifact.digest}`;
	return `\`${artifact.artifactId}\` [${artifact.kind}] ${artifact.uri}${digest}`;
}
/**
* The run the caller (or a referenced run) is executing, as the store recorded
* it: the providers this run was bound to, re-checked against the snapshot the
* record names before they are shown.
*
* Why the re-check is not optional: the record says which bytes the run loaded,
* and the snapshot path is the only place those bytes still exist. A snapshot
* that is missing or edited is reported as such, naming the skill — the one
* thing a read must never do is quietly show what stands at the production skill
* path now, which would read as "this is what you are running".
*
* A run with no binding record, or one whose record names no snapshot, has
* nothing to claim and renders nothing.
*/
async function bindingLines(taskRuntime, binding) {
	if (binding === void 0) return [];
	let summary;
	try {
		summary = renderRunBinding(binding, await taskRuntime.readRunBinding(binding));
	} catch (error) {
		summary = [
			"## Implementation chosen for this run",
			"",
			`- bound content could not be re-read against its snapshot: ${error instanceof Error ? error.message : String(error)}`
		].join("\n");
	}
	return summary.length === 0 ? [] : ["", ...summary.split("\n")];
}
/**
* The root most distant ancestor of one task: the top of its real parent chain,
* which is what carries the objective and hard constraints a descendant works
* under. `brokenAt` names the parent the walk stopped at when the store does not
* hold it — a chain that leaves the store is reported, never filled in.
*/
function rootAncestor(snapshot, task) {
	const visited = new Set([task.taskId]);
	let current = task;
	while (current.parentTaskId !== void 0) {
		const parentId = current.parentTaskId;
		const parent = snapshot.tasks.find((item) => item.taskId === parentId);
		if (parent === void 0) return {
			task: current,
			brokenAt: parentId
		};
		if (visited.has(parent.taskId)) return {
			task: current,
			brokenAt: parentId
		};
		visited.add(parent.taskId);
		current = parent;
	}
	return { task: current };
}
/** The latest run a task started, by the store's own run order. */
function latestRun(snapshot, task) {
	let found;
	for (const runId of task.runIds) {
		const run = snapshot.runs.find((item) => item.runId === runId);
		if (run !== void 0) found = run;
	}
	return found;
}
/** The handoff a task was delegated with, when a parent recorded one. */
function handoffFor(snapshot, taskId) {
	let found;
	for (const handoff of snapshot.handoffs) if (handoff.childTaskId === taskId) found = handoff;
	return found;
}
/**
* The handoff envelope as a projection (A2 §D): the delegation terms, the
* decided/assumed/open items, and the references a worker may read for itself.
* The parent session is named as a `context_read` reference — the one session
* entry this deployment offers — never as a raw cross-session tool.
*/
function handoffLines(handoff) {
	const field = (title, items) => items.length === 0 ? [`- ${title}: (none)`] : [`- ${title}:`, ...items.map((item) => `  - ${item}`)];
	return [
		`- parent task: ${handoff.parentTaskId} (run ${handoff.parentRunId})`,
		`- parent objective: ${handoff.parentObjective}`,
		`- reason for delegation: ${handoff.reasonForDelegation}`,
		...field("constraints", handoff.constraints),
		...field("decisions already made", handoff.decisions),
		...field("assumptions", handoff.assumptions),
		...field("open questions", handoff.openQuestions),
		...handoff.parentSessionRef === void 0 ? [] : [`- the session that delegated this task is \`${handoff.parentSessionRef}\`; read it with \`context_read\` kind:"session" ref:"${handoff.parentSessionRef}"`]
	];
}
/** The reference lists a handoff carries, as their own lines: what to read for itself. */
function handoffReferences(handoff) {
	return {
		artifacts: handoff.relevantArtifacts.map((artifact) => `- ${artifactLine(artifact)}`),
		evidence: handoff.relevantEvidence.map((evidenceId) => `- evidence \`${evidenceId}\``)
	};
}
function jsonBlock(value) {
	return [
		"```json",
		JSON.stringify(value, null, 2),
		"```"
	];
}
/** The complete rendering of one task record. */
function taskRecordText(task) {
	const contract = task.contract;
	const lines = [
		`task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth} taskType ${task.definitionRef.taskType}@${task.definitionRef.version}`,
		`parent: ${task.parentTaskId ?? "(none — this is a parentless record)"}`,
		`objective: ${task.objective}`
	];
	lines.push("acceptance criteria:", ...task.acceptanceCriteria.length === 0 ? ["(none)"] : criteriaLines(task.acceptanceCriteria));
	for (const criterion of task.acceptanceCriteria) {
		const extras = [];
		if (criterion.requiredEvidence.length > 0) extras.push(`  required evidence: ${criterion.requiredEvidence.join(", ")}`);
		if (criterion.requiresArtifact !== void 0 && criterion.requiresArtifact.length > 0) extras.push(`  requires artifact: ${criterion.requiresArtifact.join(", ")}`);
		if (criterion.acceptsArtifact !== void 0 && criterion.acceptsArtifact.length > 0) extras.push(`  accepts artifact: ${criterion.acceptsArtifact.join(", ")}`);
		if (criterion.verifierRef !== void 0) extras.push(`  verifier: ${criterion.verifierRef}`);
		for (const child of criterion.childEvidence ?? []) extras.push(`  child evidence: run member #${child.childIndex}${child.criterionId === void 0 ? "" : ` criterion ${child.criterionId}`}${child.evidenceRef === void 0 ? "" : ` ref ${child.evidenceRef}`}`);
		extras.push(...protectedInputsDetail(criterion));
		if (extras.length > 0) lines.push(...extras);
	}
	lines.push(`requested capabilities: ${task.requestedCapabilities.length === 0 ? "(none)" : task.requestedCapabilities.join(", ")}`);
	if (task.requiresIndependentAcceptance === true) lines.push("requires independent acceptance: yes");
	lines.push(...contractLines(task));
	if (contract !== void 0) lines.push(`contract version: ${contract.contractVersion}`);
	lines.push(`runs: ${task.runIds.length === 0 ? "(none)" : task.runIds.join(", ")}`);
	lines.push(`children: ${task.childTaskIds.length === 0 ? "(none)" : task.childTaskIds.join(", ")}`);
	return lines.join("\n");
}
/**
* The complete rendering of one run record, with the binding re-check appended.
* The snapshot is the store the run was read out of: it is where the one
* derived word on the run line comes from (see {@link runPhaseSuffix}).
*/
async function runRecordText(taskRuntime, run, snapshot) {
	const { providerBinding,...record } = run;
	const lines = [
		`run ${run.runId} of task ${run.taskId} [${run.status}]${runPhaseSuffix(run, snapshot)}`,
		`session: ${run.sessionId}${run.parentRunId === void 0 ? "" : ` · parent run: ${run.parentRunId}`}`,
		`started: ${run.startedAt}${run.finishedAt === void 0 ? "" : ` · finished: ${run.finishedAt}`}`,
		`capabilities: ${run.capabilitySnapshot.length === 0 ? "(none)" : run.capabilitySnapshot.join(", ")}`,
		...run.agentPreset === void 0 ? [] : [`agent preset: ${run.agentPreset}`],
		"artifacts:",
		...run.artifacts.length === 0 ? ["(none)"] : run.artifacts.map((artifact) => `- ${artifactLine(artifact)}`),
		"verifier results:",
		...run.verifierResults.length === 0 ? ["(none)"] : run.verifierResults.map((result) => `- ${result.criterionId} [${result.status}] verifier ${result.verifierId}${result.verifierVersion === void 0 ? "" : ` v${result.verifierVersion}`}${result.exitCode === void 0 ? "" : ` exit ${result.exitCode}`}${result.logRef === void 0 ? "" : ` log ${result.logRef}`}`),
		"",
		"recorded fields:",
		...jsonBlock(record)
	];
	lines.push(...await bindingLines(taskRuntime, providerBinding));
	return lines.join("\n");
}
/** The complete rendering of one evidence bundle. */
function evidenceRecordText(snapshot, evidence) {
	return [
		`evidence ${evidence.evidenceId} of task ${evidence.taskId} (run ${evidence.taskRunId}), generated ${evidence.generatedAt}`,
		"",
		...jsonBlock(evidence),
		"",
		`run state: ${snapshot.runs.find((run) => run.runId === evidence.taskRunId)?.status ?? "(the run this evidence names is not in this store)"}`
	].join("\n");
}
/**
* The complete rendering of one review record. A record is identified by its
* `(taskId, runId)` pair — a review has no id of its own — so the pair is
* printed first, and a task that settled before any run started says so instead
* of printing an invented run id.
*/
function reviewRecordText(review) {
	const runPart = review.runId === void 0 ? "no run — the task blocked before any run started" : `run ${review.runId}`;
	return [
		`review of task ${review.taskId} (${runPart}) [${review.outcome}]`,
		`evidence refs: ${review.evidenceRefs.length === 0 ? "(none)" : review.evidenceRefs.join(", ")}`,
		"",
		...jsonBlock(review)
	].join("\n");
}
/**
* The complete rendering of one diagnosis record.
*
* The persisted `observedFailure` slot is read here as what A5 made it: the
* postmortem observation, not a claim that something failed — a postmortem of a
* source that succeeded fills the same slot with what was really observed.
*/
function diagnosisRecordText(diagnosis) {
	return [
		`diagnosis ${diagnosis.diagnosisId} of task ${diagnosis.taskId} [confidence ${diagnosis.confidence}]`,
		`postmortem observation: ${diagnosis.observedFailure}`,
		`localized cause: ${diagnosis.localizedCause}`,
		"",
		...jsonBlock(diagnosis)
	].join("\n");
}
/**
* The one-line identity of one task, in the shape both status reads use: status,
* objective, the latest run with its phase, evidence ids, the most recent review
* outcome with the detail a reader can act on, and the diagnosis count.
*
* The phase cell is derived from this same snapshot, so a related task's own
* open blocking question shows as `waiting_answer` here too.
*/
function taskSummaryLine(snapshot, task, roles = []) {
	const run = latestRun(snapshot, task);
	const evidence = snapshot.evidence.filter((item) => item.taskId === task.taskId).map((item) => item.evidenceId);
	const review = [...snapshot.reviews].reverse().find((item) => item.taskId === task.taskId);
	const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId).length;
	const runPart = run === void 0 ? "run: none" : `run: ${run.status}${runPhaseCell(run, snapshot)}`;
	const evidencePart = evidence.length === 0 ? "" : ` evidence: [${evidence.join(", ")}]`;
	const failing = review?.criteria?.filter((item) => item.verdict !== "pass") ?? [];
	const detail = review?.outcome === "failed" && failing.length > 0 ? `${review.localizedCause ?? "failed"} [${failing.map((item) => `${item.criterionId}${item.exitCode === void 0 ? "" : ` exit ${item.exitCode}`}`).join(", ")}]` : review?.localizedCause ?? review?.anomalies[0];
	const reviewPart = review === void 0 ? "" : ` review: ${review.outcome}${detail === void 0 ? "" : ` — ${detail}`}`;
	const diagPart = diagnoses === 0 ? "" : ` diag: ${diagnoses}`;
	const rolePart = roles.length === 0 ? "" : ` [${roles.join(", ")}]`;
	return `- ${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart}${reviewPart}${diagPart})${rolePart}`;
}

//#endregion
//#region src/projections.ts
/** The status page's default entry count, and the range a caller's limit is clamped into. */
const STATUS_LIMIT_DEFAULT = 20;
const STATUS_LIMIT_MAX = 100;
/** The session page's default event count, and its ceiling (the same range as a status page). */
const SESSION_LIMIT_DEFAULT = 20;
const SESSION_LIMIT_MAX = 100;
/**
* The floor of one session-event page, in UTF-8 bytes: a page takes the largest
* fragment that fits, but at least this much room is always given to it, so a
* caller's `limit` can never make a page that cannot carry one character.
*/
const SESSION_EVENT_PAGE_MIN_BYTES = 4;
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
const TASK_PAGE_MIN_BYTES = 64;
/** How a caller asks for a record's identity, spelled out in every malformed-ref refusal. */
const REF_SHAPES = {
	task: "the task id",
	run: "the run id",
	evidence: "the evidence id",
	diagnosis: "the diagnosis id",
	review: "`{taskId, runId}` (with `runId: null` for a task that blocked before any run)",
	session: "the session id, or `{sessionId, seq}` for one event"
};
function storeSource(graph, storeId, what) {
	return `${what} — store ${storeId} of graph ${graph.id}, one Task snapshot read`;
}
/** The recovery marker a result shows, or `undefined` while the store is simply ready. */
function recoveryMarker(recovery) {
	if (recovery.status === "ready") return void 0;
	const reason = "reason" in recovery ? ` — ${recovery.reason}` : "";
	return `recovery: ${recovery.status}${reason}`;
}
/** The static sentence every result that shows a marker carries, so a marker is never read as a trigger. */
const RECOVERY_NOTE = "a recovery marker is an observation: this read neither triggers nor waits for recovery";
function unboundRead(resolution) {
	return refused(resolution.refusal, resolution.detail);
}
function tooLarge(what, where) {
	return refused("context-too-large", `${what} does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a core contract is never cut to fit; nothing is reported in place of it. ${where}`);
}
/** The one action that reaches a task-class record in pages. */
function taskPageHint(taskId) {
	return `Read the record in pages with \`context_read\` kind:"task" ref:"${taskId}" (offset in UTF-8 bytes, limit up to ${CONTEXT_OUTPUT_LIMIT_BYTES}).`;
}
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
	const code = error?.code;
	return typeof code === "string" ? code : void 0;
}
function contractHeading(role) {
	switch (role) {
		case "reviewer": return "## Delegated contract (review-only)";
		case "root": return "## Your contract (graph root)";
		default: return "## Your contract";
	}
}
function contractBody(task) {
	return [
		`task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth}`,
		`objective: ${task.objective}`,
		"acceptance criteria:",
		...task.acceptanceCriteria.length === 0 ? ["(none)"] : criteriaLines(task.acceptanceCriteria),
		...contractLines(task)
	];
}
/**
* The caller's own run, as one line: status, phase, and the old-record marker
* such a run earns. The snapshot is the store the run was read from, and is
* where the run line's one derived word comes from (`waiting_answer`).
*/
function ownRunLine(run, snapshot) {
	return `run ${run.runId} [${run.status}]${runPhaseSuffix(run, snapshot)} started ${run.startedAt}`;
}
/**
* One reference list inside the byte bound: entries are shown in store order
* until the budget (which also has to hold the omission clause) runs out, and
* what did not fit is named with its count. Returns `'too-large'` when not even
* the clause fits — a list that cannot say how much it hid is not shown at all.
*
* `follow` is the room the caller still owes to everything it renders *after*
* this list (the next list whole, a fixed guidance block, the run binding
* summary): the list stops early enough to leave it, so one long list names what
* it hid instead of starving what follows into a refusal. The clause's room is
* reserved *before* each entry is measured, never spent on an entry
* (`@deepseek-ai/dsh-spill-policy` reserves its own notice the same way).
*/
function referenceList(budget, title, entries, noun, how, follow = 0) {
	if (entries.length === 0) return budget.add(`- ${title}: (none)`) ? void 0 : "too-large";
	const omitted = (count) => omissionLine({
		scope: noun,
		unit: "items",
		kept: entries.length - count,
		limit: entries.length,
		omitted: count,
		recovery: how
	});
	const reserve = utf8Bytes(omitted(entries.length)) + 1 + follow;
	if (!budget.add(`- ${title}:`)) return "too-large";
	let shown = 0;
	for (const entry of entries) {
		const line = `  ${entry}`;
		if (budget.remaining < reserve + utf8Bytes(line) + 1) break;
		budget.add(line);
		shown += 1;
	}
	if (shown === entries.length) return void 0;
	return budget.add(omitted(entries.length - shown)) ? void 0 : "too-large";
}
/**
* The least a bounded list occupies whole: its heading, and the omission clause
* it would emit for `count` entries. A caller that renders two lists in a row
* hands the first this floor for the second, so the second is never starved.
*/
function referenceFloor(title, noun, count, how) {
	const clause = omissionLine({
		scope: noun,
		unit: "items",
		kept: 0,
		limit: count,
		omitted: count,
		recovery: how
	});
	return utf8Bytes(`- ${title}:`) + 1 + utf8Bytes(clause) + 1;
}
/**
* The decomposition guidance a worker's projection carries — the
* task/deployment-conditional part of the old spawn prompt's rules (A2: the
* unconditional rules are the agent runtime's worker policy section, and the
* two never repeat each other). Every condition is fixed for the whole run — a
* task's `decompositionStatus` is immutable after admission and the deployment
* switch is configuration — so the block is as byte-stable as the contract it
* rides with. A replay never sees it: a replay re-runs the one task as
* contracted, whatever the switch says.
*/
function workerDecompositionLines(taskRuntime, task) {
	const decomposable = task.decompositionStatus === "decomposable";
	const runtimeSplit = taskRuntime.allowsRuntimeDecomposition();
	if (!decomposable && !runtimeSplit) return [];
	const lines = [];
	if (decomposable) lines.push("## This task is decomposable", "", "- This task was admitted as decomposable: decide from its contract and current evidence whether it has separate, independently verifiable results worth delegating.", "- If so, call `task_decompose` with a `reason` and child tasks that each have their own result and acceptance criterion. Otherwise do the work here and submit it yourself; do not split just to add tree depth.", "- Decompose only when RFC §36 atomicity holds — clear artifact boundaries, independent checks, and matching capabilities or a gap the child can actually resolve.", "- The batch end hands this task back to you: nothing is submitted on your behalf, so read the children's results and hand this task in yourself with `task_submit_result`. You never declare completion yourself.");
	if (runtimeSplit) lines.push(...lines.length === 0 ? [] : [""], "## If the work turns out not to be atomic", "", "- Before implementation, check whether the task contains separate results with independent checks or a capability boundary that another node can own.", "- Call `task_decompose` yourself: this deployment admits a task's own decomposition, so your parent did not have to predict it. The call still has to clear admission — structure, acyclic dependencies, a command on every executable criterion, capability coverage, depth and batch-size limits — and one batch at a time is the rule, so a task may split again once its own batch ends; a refusal names the rule that blocked it, and that reason is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here.");
	lines.push("", "- A decomposition can come back waiting for a human review: it answers with a proposal id and admits nothing, so no child exists and nothing is spawned until the review decides. Read the batch as it was recorded with `task_proposal_read`; do not re-submit the same batch while it waits, because the same request is answered with the same proposal. If the review refuses it, revise the batch from the reason on the record and decompose again — a revision is a new proposal, never a re-run of the refused one.");
	return lines;
}
/**
* The immutable half of the context one role is assembled with (A2 §D/§9): the
* root objective and its hard constraints, the caller's own complete contract,
* the persisted handoff envelope, and — for replay or a reviewer — the honest
* label that says which lineage this contract belongs to.
*
* Two projections of unchanged content are byte-identical: no read counters, no
* "as of" timestamp, and every list in its store order.
*/
async function contractProjection(deps, loaded) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	if (resolution.kind === "member") return refused("unbound", `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no recorded delegation, so it has no contract to project. A member reads the graph's records by reference (\`context_read\`) or asks for the status view; it never inherits the root's contract.`);
	if (resolution.kind === "root" && resolution.task === void 0) return refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join("\n"));
	if (resolution.kind === "reviewer" && resolution.task === void 0) return refused("not-found", `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store "${resolution.storeId}" does not hold; the delegated contract cannot be read.`);
	if (loaded.snapshot === void 0) return refused("unreadable", `store "${resolution.storeId}" of graph "${resolution.graph.id}" could not be read, so the contract it holds cannot be projected.`);
	const snapshot = loaded.snapshot;
	const task = resolution.task;
	const run = resolution.kind === "worker" || resolution.kind === "root" ? resolution.run : void 0;
	const role = resolution.kind === "reviewer" ? "reviewer" : resolution.kind === "root" ? "root" : task.parentTaskId === void 0 && run?.parentRunId !== void 0 ? "replay" : "worker";
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const header = [
		"# Immutable context (contract)",
		`role: ${role}`,
		`graph: ${resolution.graph.id} "${resolution.graph.name}" (env ${resolution.graph.envId}) — root session "${resolution.graph.rootSessionId}"`,
		`session: ${resolution.sessionId} — store ${resolution.storeId}`
	];
	if (budget.addAll(header) > 0) return tooLarge("the contract projection header", taskPageHint(task.taskId));
	if (role === "replay") {
		const lines = [
			"",
			"## Own objective (replay lineage)",
			`this task is a replay: it is parentless in a store that also holds the root task, and its run carries lineage parent run ${run?.parentRunId ?? "(unrecorded)"}. The objective below is this task's own accepted contract — no other task's root objective is adopted here, and the graph's root briefing is not this task's briefing.`,
			`objective: ${task.objective}`,
			...constraintItems(task).map((constraint) => `- replay constraint: ${constraint}`)
		];
		if (budget.addAll(lines) > 0) return tooLarge("the replay lineage briefing", taskPageHint(task.taskId));
	}
	if (role === "worker") {
		const ancestor = rootAncestor(snapshot, task);
		const constraints = constraintItems(ancestor.task);
		const lines = [
			"",
			"## Root objective and hard constraints",
			`${ancestor.task.taskId} [${ancestor.task.status}]: ${ancestor.task.objective}`,
			...constraints.length === 0 ? ["- root constraints: (none recorded on the root contract)"] : ["- root constraints:", ...constraints.map((constraint) => `  - ${constraint}`)],
			...ancestor.brokenAt === void 0 ? [] : [`- the parent chain stops at "${ancestor.brokenAt}", which this store does not hold; nothing is invented for it`]
		];
		if (budget.addAll(lines) > 0) return tooLarge("the root briefing", taskPageHint(task.taskId));
	}
	if (budget.addAll([
		"",
		contractHeading(role),
		...contractBody(task)
	]) > 0) return tooLarge("your contract", taskPageHint(task.taskId));
	if (resolution.kind === "reviewer") {
		const label = ["", `- this session has no business Run: the contract above belongs to the task it was delegated to review (delegated by session ${resolution.delegation.actor}, recorded ${resolution.delegation.at}), and reading it is not executing it.`];
		if (budget.addAll(label) > 0) return tooLarge("the review-only label", taskPageHint(task.taskId));
	}
	const summaryLines = run?.providerBinding === void 0 ? [] : [
		"",
		"## Implementation chosen for this run",
		...(await bindingLines(deps.taskRuntime, run.providerBinding)).filter((line) => line.length > 0)
	];
	const summaryFloor = summaryLines.length === 0 ? 0 : utf8Bytes(summaryLines.join("\n")) + 2;
	const decomposition = role === "worker" ? workerDecompositionLines(deps.taskRuntime, task) : [];
	const decompositionFloor = decomposition.length === 0 ? 0 : utf8Bytes(["", ...decomposition].join("\n")) + 2;
	if (role === "worker") {
		const handoff = handoffFor(snapshot, task.taskId);
		if (handoff === void 0) {
			if (budget.addAll([
				"",
				"## Handoff",
				"- handoff: none recorded — this store holds no TaskHandoff naming this task as its child"
			]) > 0) return tooLarge("the handoff", taskPageHint(task.taskId));
		} else {
			if (budget.addAll([
				"",
				"## Handoff",
				...handoffLines(handoff)
			]) > 0) return tooLarge("the handoff", taskPageHint(task.taskId));
			const references = handoffReferences(handoff);
			const evidenceFloor = referenceFloor("relevant evidence", "handoff evidence references", references.evidence.length, "read them by id");
			const tail = decompositionFloor + summaryFloor;
			if (referenceList(budget, "relevant artifacts", references.artifacts, "handoff artifact references", "read them by id", evidenceFloor + tail) !== void 0) return tooLarge("the handoff references", taskPageHint(task.taskId));
			if (referenceList(budget, "relevant evidence", references.evidence, "handoff evidence references", "read them by id", tail) !== void 0) return tooLarge("the handoff references", taskPageHint(task.taskId));
		}
		if (decomposition.length > 0 && budget.addAll(["", ...decomposition]) > 0) return tooLarge("the decomposition guidance", taskPageHint(task.taskId));
	}
	if (summaryLines.length > 0 && budget.addAll(summaryLines) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's immutable contract"));
}
/**
* The tasks one caller's status view covers: the caller's own task, its direct
* children, and the tasks adjacent to it through a dependency edge — both
* directions, each labelled with what the edge means (`from` must verify before
* `to`). Sorted by task id, so the list is stable across reads.
*/
function relatedEntries(snapshot, self) {
	const roles = /* @__PURE__ */ new Map();
	const add = (taskId, role) => {
		const current = roles.get(taskId);
		if (current === void 0) roles.set(taskId, [role]);
		else if (!current.includes(role)) current.push(role);
	};
	add(self.taskId, "you");
	for (const childTaskId of self.childTaskIds) add(childTaskId, "direct child");
	for (const edge of snapshot.edges) {
		if (edge.to === self.taskId) add(edge.from, "dependency (blocks you)");
		if (edge.from === self.taskId) add(edge.to, "dependent (you block it)");
	}
	return [...roles.entries()].flatMap(([taskId, labels]) => {
		const task = snapshot.tasks.find((item) => item.taskId === taskId);
		return task === void 0 ? [] : [{
			task,
			roles: labels
		}];
	}).sort((left, right) => left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0);
}
/**
* The dynamic half (A2 §D/§9): the run's status and phase, the effective gate
* phase, the recovery marker, and the related tasks. For a reviewer, whose
* domain is real but whose run is not, the delegated task's state is shown under
* its review-only label instead of a "your run" line that would be a fiction.
*
* Nothing accumulates and nothing varies with the act of reading: two
* projections of unchanged content are byte-identical, which is what lets the
* session log deduplicate them.
*/
async function dynamicProjection(deps, loaded) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	if (resolution.kind === "member") return refused("unbound", `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no recorded delegation, so there is no dynamic state to project for it; the graph's tasks are readable with the status view or by reference.`);
	if (resolution.kind === "root" && resolution.task === void 0) return refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join("\n"));
	if (resolution.kind === "reviewer" && resolution.task === void 0) return refused("not-found", `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store "${resolution.storeId}" does not hold; there is no delegated state to project.`);
	const task = resolution.task;
	const snapshot = loaded.snapshot;
	const marker = recoveryMarker(resolution.recovery);
	const gate = deps.taskRuntime.gate.phaseOf(resolution.sessionId);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const header = [
		"# Dynamic context (state)",
		`role: ${resolution.kind}`,
		`graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
		...marker === void 0 ? [] : [marker, RECOVERY_NOTE],
		`gate phase: ${gate ?? "not tracked for this session"}`
	];
	if (budget.addAll(header) > 0) return tooLarge("the dynamic projection header", taskPageHint(task.taskId));
	if (resolution.kind === "reviewer") {
		const run = snapshot === void 0 ? void 0 : latestRun(snapshot, task);
		const label = `delegated task state (review-only, no business Run): ${run === void 0 ? "no run was ever started" : ownRunLine(run, snapshot)}`;
		if (!budget.add(label)) return tooLarge("the delegated task state", taskPageHint(task.taskId));
	} else if (!budget.add(`your run: ${resolution.run === void 0 ? "none" : ownRunLine(resolution.run, snapshot)}`)) return tooLarge("the run line", taskPageHint(task.taskId));
	if (snapshot !== void 0) {
		const lines = relatedEntries(snapshot, task).map((entry) => taskSummaryLine(snapshot, entry.task, entry.roles));
		const marker$1 = (count) => omissionLine({
			scope: "related tasks",
			unit: "items",
			kept: lines.length - count,
			limit: lines.length,
			omitted: count,
			recovery: "page through them with the status view"
		});
		const reserve = utf8Bytes(marker$1(lines.length)) + 1;
		if (budget.addAll(["", "related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):"]) > 0) return tooLarge("the related tasks heading", taskPageHint(task.taskId));
		let shown = 0;
		for (const line of lines) {
			if (budget.remaining < reserve + utf8Bytes(line) + 1) break;
			budget.add(line);
			shown += 1;
		}
		if (shown < lines.length) {
			if (!budget.add(marker$1(lines.length - shown))) return tooLarge("the related tasks list", taskPageHint(task.taskId));
		}
	}
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's dynamic state"));
}
/**
* The message identities one Session's own history proves its model has seen
* (A4 §7.3): the `user/message` events of its own event suffix, by message id.
* That is the only durable proof — a pending inbox entry is not one (the loop
* claims and removes it before the step that would carry it), and a claim whose
* write never reached history is not one either.
*
* The fold is the delivery path's (`agent-runtime`'s `ownSuffix`): the
* fork-inherited prefix belongs to the Session this one descends from, so a
* message there was never put in front of *this* Session's model. Nothing is
* written back: this function is a read, and the proof is re-derived at every
* assembly, so no consumed flag and no second ledger can disagree with the log.
*/
async function consumedMessageIds(deps, sessionId) {
	const log = await deps.sessionQuery.readSession(sessionId);
	const ids = /* @__PURE__ */ new Set();
	for (const event of log.events.slice(log.inheritedEventCount)) if (event.type === "user/message") ids.add(String(event.data.id));
	return ids;
}
/** What nothing was proven about. */
const NOTHING_CONSUMED = /* @__PURE__ */ new Set();
/**
* The order both lists print in: `askedAt` ascending, which is the order the
* store applied the asks in. Sorting explicitly keeps the claim true even if two
* asks commit out of stamp order, and `Array#sort` being stable keeps questions
* the store stamped in the same millisecond in the order it holds them.
*/
function byAskedAt(left, right) {
	return left.askedAt < right.askedAt ? -1 : left.askedAt > right.askedAt ? 1 : 0;
}
/** One question line: the identity, the asking run, the blocking flag, and where the body is. */
function questionEntry(snapshot, question) {
	const task = snapshot.runs.find((run) => run.runId === question.childRunId)?.taskId;
	const from = `from child run ${question.childRunId}${task === void 0 ? "" : ` (task ${task})`}`;
	return `- ${question.questionId} — ${from}, blocking: ${question.blocking ? "yes" : "no"}, asked ${question.askedAt}\n  body: \`context_read\` kind:"session" ref:${eventReference(question.questionRef.sessionId, question.questionRef.seq)}`;
}
/** One answer line: the identity, the question it answers, the resolution, and where the body is. */
function answerEntry(question, answer) {
	return `- ${answer.answerId} — the answer to question ${question.questionId}, resolves: ${answer.resolves ? "yes" : "no"}, answered ${answer.answeredAt}\n  body: \`context_read\` kind:"session" ref:${eventReference(answer.answerRef.sessionId, answer.answerRef.seq)}`;
}
/**
* One bounded list of question or answer lines: the entries in the store's ask
* order, then the list's guidance. What the output bound could not carry is
* named with its count (`@deepseek-ai/dsh-output-retention`'s clause) instead of
* silently dropped, and the guidance's room is reserved before each entry is
* measured, so an unusually long list never starves it. Returns `'too-large'`
* when not even the heading fits: a list that cannot say what it holds is not
* shown at all.
*/
function questionList(budget, heading, entries, guidance, scope, recovery) {
	if (!budget.add("") || !budget.add(heading)) return "too-large";
	const omitted = (count) => omissionLine({
		scope,
		unit: "items",
		kept: entries.length - count,
		limit: entries.length,
		omitted: count,
		recovery
	});
	const reserve = utf8Bytes(omitted(entries.length)) + 1 + utf8Bytes(guidance) + 1;
	let shown = 0;
	for (const entry of entries) {
		if (budget.remaining < reserve + utf8Bytes(entry) + 1) break;
		budget.add(entry);
		shown += 1;
	}
	if (shown < entries.length && !budget.add(omitted(entries.length - shown))) return "too-large";
	return budget.add(guidance) ? "ok" : "too-large";
}
/**
* The question plane (A4 §F.1, architecture §7.3): what this run owes or waits
* for in the direct parent/child conversation, for the prompt assembly's own
* named runtime context. Two lists, both derived from the store's question
* facts and neither a phase:
*
* - **as a parent**: every question of a child's that is still open and
*   unanswered (`questionsAwaitingAnswerOf`) — the question's identity, the
*   asking run, the blocking flag, and the `{sessionId, seq}` reference that
*   reads the body out of the asking Session. A question is shown until an
*   answer resolves it, whatever happened to its delivery: the store's own fact
*   is what makes the parent owe an answer.
* - **as a child**: every answer to this run's own questions that its Session
*   does not yet prove was put in front of the model. An answer is never dropped
*   because the question was answered — it is dropped only when the caller's own
*   Session holds that answer's `messageId` as a `user/message` event
*   ({@link consumedMessageIds}); a fold that cannot be read proves nothing, so
*   every recorded answer stays listed. No consumed flag is stored anywhere.
*
* The body itself is never copied here: the reference into the sending Session
* is the one source of the text, and it is what the model reads with
* `context_read`. Both lists are bounded, questions print by `askedAt` ascending
* (their answers in the order the store applied them), and a caller with nothing
* pending gets an empty text — no header, and no runtime context at all for the
* assembly to add.
*/
async function questionProjection(deps, loaded) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	if (resolution.kind === "member") return refused("unbound", `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no recorded delegation, so it asks no parent and answers no child; questions belong to the runs that hold them.`);
	if (resolution.kind === "root" && resolution.task === void 0) return refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join("\n"));
	if (resolution.kind === "reviewer" && resolution.task === void 0) return refused("not-found", `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store "${resolution.storeId}" does not hold; there is no delegated run whose questions could be projected.`);
	const snapshot = loaded.snapshot;
	const source = storeSource(resolution.graph, resolution.storeId, "projected the caller's pending questions");
	const run = resolution.kind === "worker" || resolution.kind === "root" ? resolution.run : void 0;
	if (snapshot === void 0 || run === void 0) return read("", source);
	if (snapshot.questions === void 0) return refused("unreadable", `store "${resolution.storeId}" of graph "${resolution.graph.id}" answered with a snapshot that carries no question index, so the questions it holds cannot be read; a view built without them would report "no questions" for a store that has some.`);
	const asked = [...questionsAwaitingAnswerOf(snapshot, run.runId)].sort(byAskedAt);
	const answers = [];
	for (const question of [...snapshot.questions.all].sort(byAskedAt)) {
		if (question.childRunId !== run.runId) continue;
		for (const answer of question.answers ?? []) answers.push({
			question,
			answer
		});
	}
	let consumed = NOTHING_CONSUMED;
	if (answers.length > 0) try {
		consumed = await consumedMessageIds(deps, resolution.sessionId);
	} catch {
		consumed = NOTHING_CONSUMED;
	}
	const unread = answers.filter((item) => !consumed.has(item.answer.messageId));
	if (asked.length === 0 && unread.length === 0) return read("", source);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const header = [
		"# Pending questions (coordination)",
		`role: ${resolution.kind}`,
		`graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
		"unanswered questions and answers not yet shown to have been read — derived from the store's question facts, never a phase change"
	];
	if (budget.addAll(header) > 0) return refused("context-too-large", `the pending-questions header of store "${resolution.storeId}" does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a coordination view is never returned as a fragment of itself; nothing is reported in place of it.`);
	if (asked.length > 0) {
		if (questionList(budget, `## Questions waiting for your answer (${asked.length})`, asked.map((question) => questionEntry(snapshot, question)), "Answer a question with `task_answer` {questionId, requestKey, answer, resolves}; `resolves:false` keeps it open, and the body is at the reference on the question's line.", "pending questions", "the questions this view could not carry stay open in the store") === "too-large") return questionViewTooLarge(resolution.storeId, "questions waiting for an answer");
	}
	if (unread.length > 0) {
		if (questionList(budget, `## Answers waiting to be read (${unread.length})`, unread.map((item) => answerEntry(item.question, item.answer)), "Read an answer at the reference on its line: it stays here until your own Session shows it was put in front of you.", "unread answers", "the answers this view could not carry stay unread in the store") === "too-large") return questionViewTooLarge(resolution.storeId, "answers waiting to be read");
	}
	return read(budget.text(), source);
}
/** The refusal of a question list the output bound could not lay out at all. */
function questionViewTooLarge(storeId, what) {
	return refused("context-too-large", `the ${what} of store "${storeId}" do not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a coordination view is never returned as a fragment of itself; nothing is reported in place of it.`);
}
/**
* `task_read` (A2 §D/A2-5), the tool-facing read of the caller's own contract:
*
* - a root with an accepted contract reads that contract and its children; a
*   root whose graph has none reads the named `not-activated` state (whatever
*   proposal is open, and how a goal is accepted);
* - a worker reads its own task, criteria, run and re-checked bound content;
* - a reviewer reads the delegated task's contract, marked review-only, and is
*   never presented as the executor of a business run;
* - a member with no run of its own gets `unbound`, never the root's contract.
*/
async function taskRead(deps, loaded) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	if (resolution.kind === "member") return refused("unbound", `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no recorded delegation: no contract is bound to it, and the root's contract is not a substitute.`);
	const snapshot = loaded.snapshot;
	if (resolution.kind === "root" && resolution.task === void 0) return refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, snapshot).join("\n"));
	if (resolution.kind === "reviewer" && resolution.task === void 0) return refused("not-found", `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store "${resolution.storeId}" does not hold; the delegated contract cannot be read.`);
	const task = resolution.task;
	const marker = recoveryMarker(resolution.recovery);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const header = [`store ${resolution.storeId} of graph "${resolution.graph.id}"`, ...marker === void 0 ? [] : [marker, RECOVERY_NOTE]];
	if (budget.addAll(header) > 0) return tooLarge("the task_read header", taskPageHint(task.taskId));
	if (resolution.kind === "reviewer") {
		const lines$1 = [
			"",
			"delegated task (review-only): this session has no business Run. The contract below is the task it was delegated to review.",
			...contractBody(task)
		];
		if (budget.addAll(lines$1) > 0) return tooLarge("the delegated contract", taskPageHint(task.taskId));
		return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "read the delegated task contract"));
	}
	const run = resolution.kind === "worker" || resolution.kind === "root" ? resolution.run : void 0;
	const lines = [
		"",
		...contractBody(task),
		...run === void 0 ? [] : ["", ownRunLine(run, snapshot)]
	];
	if (budget.addAll(lines) > 0) return tooLarge("your contract", taskPageHint(task.taskId));
	const summary = run?.providerBinding === void 0 ? [] : (await bindingLines(deps.taskRuntime, run.providerBinding)).filter((line) => line.length > 0);
	if (snapshot !== void 0 && resolution.kind === "root") {
		const children = task.childTaskIds.flatMap((taskId) => snapshot.tasks.filter((item) => item.taskId === taskId));
		const childLines = [
			"",
			`children: ${children.length}`,
			...children.map((child) => taskSummaryLine(snapshot, child))
		];
		const clause = (omitted$1) => omissionLine({
			scope: "child tasks",
			unit: "items",
			kept: children.length - omitted$1,
			limit: children.length,
			omitted: omitted$1,
			recovery: "read them with the status view or by reference"
		});
		const reserve = utf8Bytes(clause(children.length)) + 1 + (summary.length === 0 ? 0 : utf8Bytes(summary.join("\n")) + 2);
		let shown = 0;
		for (const line of childLines) {
			if (budget.remaining < reserve + utf8Bytes(line) + 1) break;
			budget.add(line);
			shown += 1;
		}
		if (shown < 2) return tooLarge("the root's children", taskPageHint(task.taskId));
		const omitted = children.length - (shown - 2);
		if (omitted > 0 && !budget.add(clause(omitted))) return tooLarge("the root's children", taskPageHint(task.taskId));
	}
	if (summary.length > 0 && budget.addAll(summary) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "read the caller's own contract and run"));
}
/**
* `task_status` (A2 §D/A2-5): the caller's own task, its direct children and the
* tasks directly adjacent to it through a dependency edge (`related`, the
* default), or every task in the same domain (`graph`). Entries are sorted by
* task id and paged with an explicit offset; the result states its source and
* says outright that its pages are not a consistent snapshot of the store.
*
* The limit is clamped into 1–100 and a clamp is stated in the result, so a
* caller that asked for 1000 gets 100 entries *and* knows it asked for more.
*
* Every page in this read advances: an entry line is shown whole or the page
* ends before it. When the page's *first* entry cannot be shown, the page would
* repeat the same offset forever, so the entry is refused by name
* (`context-too-large`) with both ways forward — its own record read and the
* offset that continues the listing past it.
*/
async function taskStatus(deps, loaded, query) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	const snapshot = loaded.snapshot;
	const scope = query.scope ?? "related";
	const requestedOffset = query.offset ?? 0;
	const requestedLimit = query.limit ?? STATUS_LIMIT_DEFAULT;
	const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0;
	const limit = Number.isFinite(requestedLimit) ? Math.min(STATUS_LIMIT_MAX, Math.max(1, Math.trunc(requestedLimit))) : STATUS_LIMIT_DEFAULT;
	const clamped = !Number.isFinite(requestedLimit) || !Number.isFinite(requestedOffset) || Math.trunc(requestedLimit) !== limit || truncate(requestedOffset) !== offset;
	if (resolution.kind === "root" && resolution.task === void 0) return refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, snapshot).join("\n"));
	if (snapshot === void 0) return refused("not-activated", `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so there is no task tree to read.`);
	const self = resolution.kind === "member" ? void 0 : resolution.task;
	if (scope === "related" && self === void 0) return refused("unbound", `session "${resolution.sessionId}" has no task of its own in store "${resolution.storeId}", so there is no related scope for it; ask for scope:"graph" to read the whole domain.`);
	const entries = scope === "graph" ? [...snapshot.tasks].sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0).map((task) => ({
		task,
		roles: []
	})) : relatedEntries(snapshot, self);
	const page = entries.slice(offset, offset + limit);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const marker = recoveryMarker(resolution.recovery);
	const header = [
		"# Task status",
		`graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
		`scope: ${scope} · offset ${offset} · limit ${limit}` + (clamped ? ` (requested offset ${requestedOffset}, limit ${requestedLimit}: both are clamped into their ranges)` : ""),
		`entries in scope: ${entries.length}`,
		...marker === void 0 ? [] : [marker, RECOVERY_NOTE]
	];
	if (budget.addAll(header) > 0) return tooLarge("the status header", "Ask for a smaller page (a lower `limit`) or the `related` scope.");
	const obligations = await obligationLines(deps.envBuilder, resolution.graph.envId, snapshot);
	const obligationsClause = (omitted) => omissionLine({
		scope: "obligation lines",
		unit: "lines",
		kept: obligations.length - omitted,
		limit: obligations.length,
		omitted,
		recovery: "the status page reached its output bound"
	});
	const footerReserve = utf8Bytes("- more: yes — continue with offset 999999") + 1 + utf8Bytes("- source: ") + 200 + 1 + obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0) + utf8Bytes(obligationsClause(obligations.length)) + 1;
	let shown = 0;
	for (const entry of page) {
		const line = taskSummaryLine(snapshot, entry.task, entry.roles);
		if (budget.remaining < footerReserve + utf8Bytes(line) + 1) break;
		budget.add(line);
		shown += 1;
	}
	if (shown === 0 && page.length > 0) {
		const first = page[0];
		const lineBytes = utf8Bytes(taskSummaryLine(snapshot, first.task, first.roles));
		return tooLarge(`the summary line of task "${first.task.taskId}" (${lineBytes} UTF-8 bytes)`, `Nothing of that entry is shown, and a page of zero entries at offset ${offset} would report the same offset again, so the listing could never move past it. Read that task whole instead with \`context_read\` kind:"task" ref:"${first.task.taskId}" (its record pages in UTF-8 bytes), or ask for the entries *after* it with offset ${offset + 1} — the rest of the scope stays reachable that way.`);
	}
	const nextOffset = offset + shown;
	const hasMore = nextOffset < entries.length;
	const footer = [`- more: ${hasMore ? `yes — continue with offset ${nextOffset}` : "no — this is the end of the scope"}`, `- source: one read of store ${resolution.storeId}; pages are observations, not a consistent snapshot across calls` + (shown < page.length ? "; this page stopped at the output bound" : "")];
	if (budget.addAll(footer) > 0) return tooLarge("the status page footer", "Ask for a smaller page (a lower `limit`).");
	const omittedObligations = budget.addAll(obligations);
	if (omittedObligations > 0) budget.add(obligationsClause(omittedObligations));
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, `listed ${scope} tasks`), {
		hasMore,
		nextOffset
	});
}
function truncate(value) {
	return Math.trunc(value);
}
/**
* Best-effort obligation coverage (KISS §5.1, guide §4.2 #21): templates from
* `<repoRoot>/.agents/skills/<name>/references/obligations.yml` against the graph's
* obligations and requested capabilities. Every step may be absent — no env
* builder, no repo root within reach, no template files — and an absent source
* omits the coverage line rather than reporting zero coverage. Uncovered entries
* are a hint ("satisfied, or forgotten?"), never a block.
*/
async function obligationLines(envBuilder, envId, snapshot) {
	const header = snapshot.obligations.length === 0 ? [] : [`- obligations: ${snapshot.obligations.length} recorded`];
	try {
		const envPath = envBuilder?.store.get(envId).path;
		if (envPath === void 0) return header;
		const repoRoot = await findRepoRoot(envPath);
		if (repoRoot === void 0) return header;
		const templates = (await loadObligationTemplates(repoRoot)).flatMap((file) => file.templates);
		if (templates.length === 0) return header;
		const coverage = checkObligationCoverage(templates, snapshot);
		const uncovered = coverage.uncovered.map((template) => `${template.id} ("${template.question}") — satisfied, or forgotten?`);
		return [...header, `- obligation coverage: ${coverage.covered.length}/${templates.length} covered${uncovered.length === 0 ? "" : `; uncovered: ${uncovered.join("; ")}`}`];
	} catch {
		return header;
	}
}
/**
* `context_read` (A2 §D/A2-5): one record of the caller's own domain, by
* reference. The reference never authorizes — the caller was resolved first, and
* the record is looked up inside the caller's graph store. A session reference
* is checked against the graph's published members before DSH is asked anything,
* so a session of another graph is refused as `cross-graph` without its history
* being touched.
*
* Task-class records are read whole and paged in UTF-8 bytes when they exceed
* the output bound. A session reference has two forms: a session id pages that
* session's log by DSH event seq (its own read unit), while `{sessionId, seq}`
* reads one event's visible text, paged in UTF-8 bytes — the door a listing
* hands an event too large to render inline to.
*/
async function contextRead(deps, loaded, query, signal) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	signal?.throwIfAborted();
	const snapshot = loaded.snapshot;
	const kind = query.kind;
	if (kind === "session") {
		if (typeof query.ref === "string") return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal);
		if (isSessionEventReference(query.ref)) return await sessionEventRead(deps, loaded, query.ref, query.offset, query.limit, signal);
		return malformedRef(kind, query.ref);
	}
	if (snapshot === void 0) return refused("not-activated", `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so it holds no ${kind} record to read.`);
	const found = locateRecord(snapshot, kind, query.ref);
	if ("refusal" in found) return refused(found.refusal, found.detail);
	const recordText = await recordTextOf(deps, snapshot, found.record);
	const offset = Math.max(0, Math.trunc(query.offset ?? 0));
	const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(TASK_PAGE_MIN_BYTES, Math.trunc(query.limit ?? CONTEXT_OUTPUT_LIMIT_BYTES)));
	const total = utf8Bytes(recordText);
	const banner = [
		`# context_read ${kind} ${found.identity}`,
		`store ${resolution.storeId} of graph "${resolution.graph.id}" — record ${total} UTF-8 bytes; this page starts at byte ${offset}`,
		...offset > total ? ["the offset is past the end of the record: this page is empty"] : []
	].join("\n");
	const slice = sliceUtf8(recordText, offset, Math.max(1, Math.min(limit, CONTEXT_OUTPUT_LIMIT_BYTES - utf8Bytes(banner) - 96)));
	const footer = slice.done ? `(end of record at byte ${slice.nextOffset})` : `(more of this record follows: ask again with offset ${slice.nextOffset})`;
	return read([
		banner,
		"",
		slice.text,
		"",
		footer
	].join("\n"), storeSource(resolution.graph, resolution.storeId, `read the ${kind} record`), {
		hasMore: !slice.done,
		nextOffset: slice.nextOffset
	});
}
function malformedRef(kind, ref) {
	const shape = REF_SHAPES[kind];
	return refused("not-found", `\`context_read\` kind:"${kind}" reads one record by ${shape}; the reference given (${ref === null ? "null" : JSON.stringify(ref)}) is not that shape, so it names no record.`);
}
/**
* Whether `ref` is the `{sessionId, seq}` event reference. The shape only: a
* `seq` that is a number but not a usable event seq (negative, fractional,
* non-finite) is the event read's own refusal, so the value is judged there with
* the requirement it failed, never here as a wrong shape.
*/
function isSessionEventReference(ref) {
	if (ref === null || typeof ref !== "object") return false;
	const candidate = ref;
	return typeof candidate.sessionId === "string" && typeof candidate.seq === "number";
}
function unknownDetail(noun, ref, snapshot) {
	return `no ${noun} "${ref}" in your graph's task store (it holds ${snapshot.tasks.length} tasks); ids from another graph are not readable here, and a reference never widens the read domain.`;
}
/** Resolve one reference inside the caller's own store; never outside it. */
function locateRecord(snapshot, kind, ref) {
	if (kind === "review") {
		if (typeof ref === "string" || ref === null || typeof ref !== "object") return {
			refusal: "not-found",
			detail: reviewRefDetail(ref)
		};
		const taskId = ref.taskId;
		if (typeof taskId !== "string") return {
			refusal: "not-found",
			detail: reviewRefDetail(ref)
		};
		if (snapshot.tasks.find((item) => item.taskId === taskId) === void 0) return {
			refusal: "not-found",
			detail: `task "${taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`
		};
		const runId = ref.runId ?? null;
		const review = [...snapshot.reviews].reverse().find((item) => item.taskId === taskId && (item.runId ?? null) === runId);
		if (review !== void 0) return {
			identity: `${taskId}#${runId ?? "no-run"}`,
			record: review
		};
		const others = snapshot.reviews.filter((item) => item.taskId === taskId);
		if (others.length === 0) return {
			refusal: "not-found",
			detail: `task "${taskId}" has no review record in this store, so the reference names nothing.`
		};
		return {
			refusal: "stale-reference",
			detail: `task "${taskId}" has review records, but none for run "${runId ?? "(none)"}": this store holds ${others.map((item) => `${item.taskId}#${item.runId ?? "no-run"} (${item.outcome})`).join(", ")}. The reference names a review that does not exist for that run.`
		};
	}
	if (typeof ref !== "string") return {
		refusal: "not-found",
		detail: `\`context_read\` kind:"${kind}" reads one record by ${REF_SHAPES[kind]}; the reference given is not that shape.`
	};
	switch (kind) {
		case "task": {
			const task = snapshot.tasks.find((item) => item.taskId === ref);
			return task === void 0 ? {
				refusal: "not-found",
				detail: unknownDetail("task", ref, snapshot)
			} : {
				identity: ref,
				record: task
			};
		}
		case "run": {
			const run = snapshot.runs.find((item) => item.runId === ref);
			return run === void 0 ? {
				refusal: "not-found",
				detail: unknownDetail("run", ref, snapshot)
			} : {
				identity: ref,
				record: run
			};
		}
		case "evidence": {
			const evidence = snapshot.evidence.find((item) => item.evidenceId === ref);
			if (evidence === void 0) return {
				refusal: "not-found",
				detail: unknownDetail("evidence", ref, snapshot)
			};
			if (!snapshot.tasks.some((item) => item.taskId === evidence.taskId)) return {
				refusal: "stale-reference",
				detail: `evidence "${ref}" names task "${evidence.taskId}", which this store does not hold: the reference is stale.`
			};
			return {
				identity: ref,
				record: evidence
			};
		}
		case "diagnosis": {
			const diagnosis = snapshot.diagnoses.find((item) => item.diagnosisId === ref);
			if (diagnosis === void 0) return {
				refusal: "not-found",
				detail: unknownDetail("diagnosis", ref, snapshot)
			};
			if (!snapshot.tasks.some((item) => item.taskId === diagnosis.taskId)) return {
				refusal: "stale-reference",
				detail: `diagnosis "${ref}" names task "${diagnosis.taskId}", which this store does not hold: the reference is stale.`
			};
			return {
				identity: ref,
				record: diagnosis
			};
		}
	}
}
function reviewRefDetail(ref) {
	return `\`context_read\` kind:"review" reads one record by ${REF_SHAPES.review}; the reference given (${JSON.stringify(ref)}) is not that shape.`;
}
async function recordTextOf(deps, snapshot, record) {
	if ("objective" in record) return taskRecordText(record);
	if ("capabilitySnapshot" in record) return await runRecordText(deps.taskRuntime, record, snapshot);
	if ("evidenceId" in record) return evidenceRecordText(snapshot, record);
	if ("diagnosisId" in record) return diagnosisRecordText(record);
	return reviewRecordText(record);
}
/**
* The membership gate both session forms pass before DSH is asked anything: a
* session that is not a published member of the caller's graph reads nothing,
* and a membership that cannot be read is a named failure, never a pass — a
* session reference whose ownership is unknown is not this graph's session.
* `undefined` means the session is a member and the read may proceed.
*/
async function sessionMembershipRefusal(deps, resolution, sessionId) {
	let member;
	try {
		member = await isGraphMember(deps.graphs, resolution.graph.id, sessionId);
	} catch (error) {
		return refused("unreadable", `the membership of session "${sessionId}" in graph "${resolution.graph.id}" could not be read: ${message(error)}. A session reference is checked against the graph's published members before its log is read.`);
	}
	if (member) return void 0;
	return refused("cross-graph", `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the caller's own domain, and a session id is not a key to another graph.`);
}
/**
* One session page: events from `offset` (a DSH event seq) onward, bounded by the
* event count and by the output bound. A session that is not a published member
* of the caller's graph is refused as `cross-graph` before its log is touched;
* membership is the graph store's own record, so a guessed session id never
* reaches DSH.
*
* A page is a whole number of events, never a piece of one. An event's rendered
* lines are measured as a block before any of them is added; an event too large
* for the page is refused by name (`context-too-large`) when it is the page's
* first — a session offset addresses whole events, so there is no cursor inside
* one — and merely ends the page before it when it comes later, still reachable
* at its own seq. A window that fails after an earlier one succeeded is never
* turned into a partial page: the refusal says where the read stopped and that
* nothing partial is returned in its place.
*/
async function sessionRead(deps, loaded, sessionId, requestedOffset, requestedLimit, signal) {
	const resolution = loaded.resolution;
	signal?.throwIfAborted();
	const gate = await sessionMembershipRefusal(deps, resolution, sessionId);
	if (gate !== void 0) return gate;
	const offset = Number.isFinite(requestedOffset ?? 0) ? Math.max(0, Math.trunc(requestedOffset ?? 0)) : 0;
	const requestedEvents = Number.isFinite(requestedLimit ?? SESSION_LIMIT_DEFAULT) ? Math.trunc(requestedLimit ?? SESSION_LIMIT_DEFAULT) : SESSION_LIMIT_DEFAULT;
	const limit = Math.min(SESSION_LIMIT_MAX, Math.max(1, requestedEvents));
	const clamped = requestedEvents !== limit;
	let capturedThroughSeq;
	try {
		capturedThroughSeq = (await deps.sessionQuery.readSurface(sessionId)).capturedThroughSeq;
	} catch (error) {
		signal?.throwIfAborted();
		const code = errorCode(error);
		if (code === "SESSION_QUERY_ABORTED") throw error;
		return code === "SESSION_QUERY_SESSION_NOT_FOUND" ? refused("not-found", `session "${sessionId}" has no log in this deployment: ${message(error)}`) : refused("unreadable", `session "${sessionId}" could not be read: ${message(error)}`);
	}
	const banner = [`# context_read session ${sessionId}`, `graph "${resolution.graph.id}" — raw log through seq ${capturedThroughSeq ?? "(empty)"}; events from seq ${offset}, at most ${limit}` + (clamped ? ` (requested ${requestedEvents})` : "")];
	const source = `session ${sessionId} via the session query, one log observation through seq ${capturedThroughSeq ?? "(empty)"}`;
	if (capturedThroughSeq === null || offset > capturedThroughSeq) {
		const note = capturedThroughSeq === null ? "(this session's log holds no events)" : "(the offset is at or past the end of the log)";
		return read([
			...banner,
			"",
			note
		].join("\n"), source, {
			hasMore: false,
			nextOffset: capturedThroughSeq === null ? 0 : capturedThroughSeq + 1
		});
	}
	const events = [];
	let cursor = offset;
	let asked = offset;
	while (events.length < limit && cursor <= capturedThroughSeq) {
		asked = cursor;
		let window;
		try {
			window = await deps.sessionQuery.readEvent({
				sessionId,
				seq: cursor,
				before: 0,
				after: Math.min(SESSION_QUERY_READ_WINDOW_MAX - 1, limit - events.length - 1)
			}, signal);
		} catch (error) {
			signal?.throwIfAborted();
			const code = errorCode(error);
			if (code === "SESSION_QUERY_ABORTED") throw error;
			return events.length === 0 ? refused(code === "SESSION_QUERY_EVENT_NOT_FOUND" ? "stale-reference" : "unreadable", `session "${sessionId}" could not be read at seq ${cursor}: ${message(error)}`) : refused("unreadable", `session "${sessionId}" could not be read at seq ${cursor}, after the window at seq ${offset} answered: ${message(error)}. Nothing partial is returned: the ${events.length} event(s) the read had already collected are not reported as a page of this log.`);
		}
		for (const event of window.events) {
			if (events.length >= limit) break;
			events.push(event);
		}
		if (window.endSeq <= cursor) break;
		cursor = window.endSeq + 1;
	}
	if (events.length === 0) return refused("unreadable", `session "${sessionId}" could not be read at seq ${asked}: the session query answered without advancing to an event, so nothing was read and an empty page would only repeat this offset. Nothing is returned in place of the events.`);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	budget.addAll(banner);
	budget.addAll(["", `events: seq ${offset}..${cursor - 1} of a log through seq ${capturedThroughSeq}`]);
	const reserve = sessionClosingReserve(limit, capturedThroughSeq, sessionId);
	let shown = 0;
	let stopped;
	for (const event of events) {
		const lines = eventLines(event);
		if (!blockFits(budget, lines, reserve)) {
			if (shown === 0) return refused("context-too-large", oversizedEventDetail(sessionId, event));
			stopped = event;
			break;
		}
		budget.addAll(lines);
		shown += 1;
	}
	if (stopped !== void 0) budget.add(notShownEventLine(sessionId, stopped));
	const lastShownSeq = Number(events[shown - 1].seq);
	const nextOffset = stopped === void 0 ? lastShownSeq + 1 : Number(stopped.seq);
	const hasMore = nextOffset <= capturedThroughSeq;
	budget.add(`- events shown: ${shown} of at most ${limit}` + (hasMore ? ` · more follows from seq ${nextOffset}` : " · end of the log"));
	return read(budget.text(), `session ${sessionId} via the session query, seq ${offset}..${lastShownSeq} of a log through seq ${capturedThroughSeq}`, {
		hasMore,
		nextOffset
	});
}
/** The exact object reference one event is read with, as the listing hands it back and the tool spells it. */
function eventReference(sessionId, seq) {
	return `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq}}`;
}
/**
* Whether `offsetBytes` falls between two characters of `text` — the offset
* itself or one past a character. A UTF-8 continuation byte (`10xxxxxx`) says
* the byte belongs to a character that started earlier, so a page starting there
* would carry a fragment of one; an offset outside the text is not a boundary
* either.
*/
function onCharacterBoundary(text, offsetBytes) {
	if (offsetBytes === 0) return true;
	const byte = Buffer.from(text, "utf8").at(offsetBytes);
	return byte !== void 0 && (byte & 192) !== 128;
}
/**
* The line the final page of an event carries. The two reads page by different
* units — the listing by event seq, this one by byte — so the note names the
* listing's own cursor as such: the event after this one, never this page's
* `nextOffset`.
*/
function eventEndNote(sessionId, seq) {
	return `the visible text of event seq ${seq} of session "${sessionId}" ends here; the listing of that session continues with \`context_read\` kind:"session" ref:"${sessionId}" offset = ${seq + 1} (the event seq after this one).`;
}
/**
* One event page as JSON — exactly the model-visible value. `offset` and
* `nextOffset` are byte positions in the event's visible text, `body` this
* page's raw fragment of it, and the note rides the final page only.
*/
function sessionEventPage(ref, offset, slice) {
	return JSON.stringify({
		sessionId: ref.sessionId,
		seq: ref.seq,
		offset,
		nextOffset: slice.nextOffset,
		hasMore: !slice.done,
		body: slice.text,
		...slice.done ? { note: eventEndNote(ref.sessionId, ref.seq) } : {}
	});
}
/**
* One session *event*: the visible text of a single event, paged in UTF-8 bytes
* (A2 §D, Q3 closure) — the door a session listing opens for an event too large
* to render inline. The listing's own unit is the whole event, so an event that
* does not fit a listing page has no listing cursor inside it; this read carries
* that event's `extractSessionEventText` output as bytes, and the raw session
* JSON it was extracted from is never part of a page.
*
* The order is the contract: the seq, the offset and the limit are judged before
* anything is read, membership is the graph store's own record (so a guessed
* session id never reaches DSH), and only then is the one event read. Every page
* advances — an offset inside a character or at or past the end of the text is
* `stale-reference`, never a silently re-aligned page — and the page is sized
* against the JSON the model receives, so escapes cannot push it over the bound.
*/
async function sessionEventRead(deps, loaded, ref, requestedOffset, requestedLimit, signal) {
	const resolution = loaded.resolution;
	signal?.throwIfAborted();
	const sessionId = ref.sessionId;
	const seq = ref.seq;
	if (!Number.isSafeInteger(seq) || seq < 0) return refused("not-found", `\`context_read\` kind:"session" reads one event by a \`{sessionId, seq}\` whose seq is a non-negative safe integer (a DSH event seq); the seq given (${String(seq)}) is not one, so it names no event.`);
	const offset = requestedOffset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) return refused("stale-reference", `the offset given (${String(offset)}) is not a non-negative safe integer; a session event's offset is a UTF-8 byte position in that event's visible text.`);
	const requestedBytes = requestedLimit ?? CONTEXT_OUTPUT_LIMIT_BYTES;
	if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1) return refused("not-found", `the limit given (${String(requestedBytes)}) is not a positive safe integer; a session event's limit is a page size in UTF-8 bytes, clamped into ${SESSION_EVENT_PAGE_MIN_BYTES}..${CONTEXT_OUTPUT_LIMIT_BYTES}.`);
	const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(SESSION_EVENT_PAGE_MIN_BYTES, requestedBytes));
	const gate = await sessionMembershipRefusal(deps, resolution, sessionId);
	if (gate !== void 0) return gate;
	let window;
	try {
		window = await deps.sessionQuery.readEvent({
			sessionId,
			seq,
			before: 0,
			after: 0
		}, signal);
	} catch (error) {
		signal?.throwIfAborted();
		const code = errorCode(error);
		if (code === "SESSION_QUERY_ABORTED") throw error;
		if (code === "SESSION_QUERY_EVENT_NOT_FOUND") return refused("stale-reference", `session "${sessionId}" has no event at seq ${seq}: ${message(error)}. The reference names an event this log does not hold.`);
		if (code === "SESSION_QUERY_SESSION_NOT_FOUND") return refused("not-found", `session "${sessionId}" has no log in this deployment: ${message(error)}`);
		return refused("unreadable", `session "${sessionId}" could not be read at seq ${seq}: ${message(error)}`);
	}
	const answered = window?.target;
	if (answered === void 0 || Number(answered.seq) !== seq) return refused("stale-reference", `session "${sessionId}" answered ${answered === void 0 ? "no event" : `seq ${String(answered.seq)}`} for the reference to seq ${seq}: a page of another event is not this event's text.`);
	const text = extractSessionEventText(answered);
	const total = utf8Bytes(text);
	const source = `session ${sessionId} via the session query, event seq ${seq} observed with ${total} UTF-8 bytes of visible text`;
	if (total === 0) {
		if (offset !== 0) return refused("stale-reference", `event seq ${seq} of session "${sessionId}" has no visible text, so offset ${offset} is past the end of it; offset 0 is the only page of that event.`);
		return read(sessionEventPage(ref, 0, {
			text: "",
			nextOffset: 0,
			done: true
		}), source, {
			hasMore: false,
			nextOffset: 0
		});
	}
	if (offset >= total) return refused("stale-reference", `offset ${offset} is at or past the end of the visible text of event seq ${seq} of session "${sessionId}", which is ${total} UTF-8 bytes: this page would carry nothing.`);
	if (!onCharacterBoundary(text, offset)) return refused("stale-reference", `offset ${offset} falls inside a UTF-8 character of the visible text of event seq ${seq} of session "${sessionId}"; an offset is a character boundary, and a page never starts with a fragment of a character.`);
	let pageBytes = limit;
	let slice = sliceUtf8(text, offset, pageBytes);
	let page = sessionEventPage(ref, offset, slice);
	while (utf8Bytes(page) > CONTEXT_OUTPUT_LIMIT_BYTES && pageBytes > 1) {
		const fitted = Math.floor(utf8Bytes(slice.text) * CONTEXT_OUTPUT_LIMIT_BYTES / utf8Bytes(page));
		pageBytes = Math.max(1, Math.min(pageBytes - 1, fitted));
		slice = sliceUtf8(text, offset, pageBytes);
		page = sessionEventPage(ref, offset, slice);
	}
	if (utf8Bytes(page) > CONTEXT_OUTPUT_LIMIT_BYTES) return refused("context-too-large", `a single character of event seq ${seq} of session "${sessionId}" plus the page stating where it sits does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, so no page of that event's text can be returned.`);
	return read(page, source, {
		hasMore: !slice.done,
		nextOffset: slice.nextOffset
	});
}
/** The widest rendering of one number of `value`'s magnitude, so a reserve can bound a line that carries it. */
function widestNumber(value) {
	return "9".repeat(String(Math.max(0, Math.trunc(value))).length);
}
/**
* The bytes a session page must keep for its closing lines — the `events shown`
* footer, and the line naming the event the page stopped before when there is
* one. Every number those lines can carry is bounded here by the range the page
* itself knows (the caller's limit, the log's last seq, and the widest text
* size), and the session id is the same string the page carries, so the reserve
* is an upper bound whatever event follows: a page the model receives always
* ends with its continuation cue.
*/
function sessionClosingReserve(limit, capturedThroughSeq, sessionId) {
	const seq = widestNumber(Number(capturedThroughSeq) + 1);
	const count = widestNumber(limit);
	const footer = `- events shown: ${count} of at most ${count} · more follows from seq ${seq}`;
	const stopped = `- the next event (seq ${seq}, ${widestNumber(Number.MAX_SAFE_INTEGER)} UTF-8 bytes of text) was not shown on this page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ref:${eventReference(sessionId, Number(seq))} — its text pages in UTF-8 bytes.`;
	return utf8Bytes(footer) + utf8Bytes(stopped) + 2;
}
/** Whether every one of `lines` fits the page's remaining space as one block (each separator counted), keeping `reserve` for what follows. */
function blockFits(budget, lines, reserve = 0) {
	if (lines.length === 0) return true;
	return utf8Bytes(lines.join("\n")) + (budget.bytes === 0 ? 0 : 1) + reserve <= budget.remaining;
}
/** The UTF-8 size of the text one event carries. */
function eventTextBytes(event) {
	return utf8Bytes(extractSessionEventText(event));
}
/**
* The refusal of an event no listing page can carry: a session offset addresses
* whole events (DSH's read unit), so an event larger than the bound has no
* second listing page. The detail names the event and the size of its visible
* text, says the listing cannot render it whole, and hands back the one
* reference that reads the event's text itself — pages of its visible text in
* UTF-8 bytes. Moving past the event with `offset` is mentioned as the caller's
* explicit choice, never as a way to reach the body.
*/
function oversizedEventDetail(sessionId, event) {
	const seq = Number(event.seq);
	return `event seq ${seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its visible text alone is ${eventTextBytes(event)} UTF-8 bytes); a session listing carries whole events — DSH's read unit — so this listing cannot render it whole, and none of its text is shown here. Read that event with \`context_read\` kind:"session" ref:${eventReference(sessionId, seq)}, whose pages are the UTF-8 bytes of its visible text. Asking this listing again with offset ${seq + 1} moves past the event and shows none of its text: that is the caller's explicit choice, not a way to read the body.`;
}
/**
* The line a page carries when it stops before an event that does not fit: the
* event is named with the size of its visible text and the exact reference that
* reads it, so the body the listing cannot carry is one call away, and moving
* past the event stays the caller's explicit choice.
*/
function notShownEventLine(sessionId, event) {
	const seq = Number(event.seq);
	return `- the next event (seq ${seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ref:${eventReference(sessionId, seq)} — its text pages in UTF-8 bytes.`;
}
function eventLines(event) {
	const text = extractSessionEventText(event);
	const head = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`;
	return text.length === 0 ? [head] : [head, ...text.split("\n").map((line) => `  ${line}`)];
}

//#endregion
//#region src/index.ts
var SingularityContextService = class extends Service {
	static inject = [
		"task",
		"graphs",
		"taskRuntime",
		"sessionQuery"
	];
	/** The registered delegation sources, in registration order; a later registration answers after an earlier one. */
	reviewerSources = [];
	constructor(ctx) {
		super(ctx, "singularityContext");
	}
	/**
	* Mount the one `system-prompt/assemble` waterfall listener this service owns
	* (`./assembly.ts`): the door the projections reach a real model request
	* through. The registration rides this service's fiber, so it leaves when the
	* service does.
	*/
	[Service.init]() {
		this.ctx.effect(() => this.ctx.on("system-prompt/assemble", (assembly, context, next) => assembleSingularityContext(this, assembly, context, next)), "singularityContext: system-prompt assembly");
	}
	/**
	* Register the narrow source this deployment reads reviewer delegations from
	* (the reviewer ledger). Returns the disposer that removes it again, so a
	* plugin that unloads takes its binding source with it.
	*/
	registerReviewerBindingSource(source) {
		this.reviewerSources.push(source);
		return () => {
			const index = this.reviewerSources.indexOf(source);
			if (index >= 0) this.reviewerSources.splice(index, 1);
		};
	}
	/**
	* The domain a live session may read, from durable facts. Tools and assembly
	* call this directly when they need the role (or the store) rather than a
	* rendered read.
	*/
	async resolveCaller(sessionId, signal) {
		return (await this.load(sessionId, signal)).resolution;
	}
	/** The caller's own complete contract and run (A2 §D `task_read`). */
	async taskRead(sessionId, signal) {
		return await taskRead(this.readDeps(), await this.load(sessionId, signal));
	}
	/** The project status view: the caller's relations, or the whole domain (A2 §D `task_status`). */
	async taskStatus(sessionId, query = {}, signal) {
		return await taskStatus(this.readDeps(), await this.load(sessionId, signal), query);
	}
	/** One record of the caller's own domain, by reference (A2 §D `context_read`). */
	async contextRead(sessionId, query, signal) {
		return await contextRead(this.readDeps(), await this.load(sessionId, signal), query, signal);
	}
	/** The immutable half of the caller's context: contract, root briefing, handoff (A2 §D/§9). */
	async contractProjection(sessionId, signal) {
		return await contractProjection(this.readDeps(), await this.load(sessionId, signal));
	}
	/** The dynamic half: run state, gate phase, recovery marker, related tasks (A2 §D/§9). */
	async dynamicProjection(sessionId, signal) {
		return await dynamicProjection(this.readDeps(), await this.load(sessionId, signal));
	}
	/**
	* The question plane (A4 §F.1/§7.3): the questions this run has not been
	* answered on, and the answers to its own questions that no model request has
	* been shown to have carried into its Session yet.
	*/
	async questionProjection(sessionId, signal) {
		return await questionProjection(this.readDeps(), await this.load(sessionId, signal));
	}
	async load(sessionId, signal) {
		signal?.throwIfAborted();
		return await loadCaller(this.bindingDeps(), sessionId, signal);
	}
	bindingDeps() {
		return {
			task: this.ctx.task,
			graphs: this.ctx.graphs,
			taskRuntime: this.ctx.taskRuntime,
			reviewerSources: [...this.reviewerSources]
		};
	}
	readDeps() {
		const envBuilder = this.envBuilder();
		return {
			...this.bindingDeps(),
			sessionQuery: this.ctx.sessionQuery,
			...envBuilder === void 0 ? {} : { envBuilder }
		};
	}
	/**
	* The env builder, when this deployment mounts one: the optional source the
	* obligation-coverage line walks up from. Read through `ctx.get`, because a
	* deployment without it must still answer every other read.
	*/
	envBuilder() {
		const ctx = this.ctx;
		return ctx.get?.("envBuilder") ?? ctx.envBuilder;
	}
};
var src_default = SingularityContextService;

//#endregion
export { AssemblyRefusalError, CONTEXT_OUTPUT_LIMIT_BYTES, NAMED_REFUSALS, OutputBudget, QUESTIONS_CONTEXT_NAME, QUESTIONS_CONTEXT_ORDER, ReviewerBindingError, STATE_CONTEXT_NAME, STATE_CONTEXT_ORDER, SingularityContextService, WORKER_CONTRACT_ORDER, WORKER_CONTRACT_SECTION, assembleSingularityContext, bindingLines, constraintItems, contextRead, contractLines, contractProjection, criteriaLines, src_default as default, diagnosisRecordText, dynamicProjection, evidenceRecordText, handoffFor, handoffLines, handoffReferences, isGraphMember, latestRun, loadCaller, notActivatedLines, omissionLine, openRootProposals, questionProjection, read, refused, relatedEntries, renderRunBinding, reviewRecordText, rootAncestor, runPhaseCell, runPhaseSuffix, runRecordText, sliceUtf8, storeStateText, taskRead, taskRecordText, taskStatus, taskSummaryLine, utf8Bytes };