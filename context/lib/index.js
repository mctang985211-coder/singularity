import { Context, Service } from "@deepseek-ai/cordis";
import { SESSION_NOT_IN_GRAPH } from "@dangosys/dsh-singularity-graphs";
import { blockingQuestionsOf, questionsAwaitingAnswerOf, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { TextRetainer, formatRetentionNotice } from "@deepseek-ai/dsh-output-retention";
import { SESSION_QUERY_READ_WINDOW_MAX, extractSessionEventText } from "@deepseek-ai/dsh-session-query";
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from "@dangosys/dsh-singularity-task-runtime";

//#region src/refusals.ts
/** The same vocabulary as a value, so a tool schema or a test can pin the whole set. */
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
/** One error message, from whatever a read threw. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The coded error a session-query or registry read answers with, when it carries one. */
function errorCode(error) {
	const code = error?.code;
	return typeof code === "string" ? code : void 0;
}

//#endregion
//#region src/assembly.ts
/** Section name of the assembled contract: the one slot the immutable half has ever had. */
const WORKER_CONTRACT_SECTION = "singularity:worker-contract";
/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
const WORKER_CONTRACT_ORDER = 80;
/** The dynamic half's context name on the runtime-context plane. */
const STATE_CONTEXT_NAME = "singularity:state";
/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
const STATE_CONTEXT_ORDER = 130;
/** The question plane's context name (A4 §F.1): a separate name, so planes deduplicate separately. */
const QUESTIONS_CONTEXT_NAME = "singularity:questions";
/** Placement among the runtime contexts: right behind the state plane. */
const QUESTIONS_CONTEXT_ORDER = 140;
/** The sections that sort at or ahead of {@link WORKER_CONTRACT_ORDER}, by name. */
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
/** Replace the contract section by name, or insert it at its order. */
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
/** The question plane, when it has anything to say: an empty projection adds no context at all. */
function withQuestionContext(assembly, text) {
	if (text.length > 0) withRuntimeContext(assembly, QUESTIONS_CONTEXT_NAME, text);
}
/** The one assembly step: one caller resolution, then the planes that role is owed (README: who gets what). */
async function assembleSingularityContext(service, assembly, context, next) {
	const agent = context.agent;
	if (agent === void 0) return next();
	const sessionId = String(agent.id);
	const caller = await service.load(sessionId, context.signal);
	switch (caller.resolution.kind) {
		case "worker": {
			if (caller.resolution.run.executionPhase === "active") try {
				withRuntimeContext(assembly, "singularity:task-templates", await service.templatesFor(caller));
			} catch (error) {
				throw new AssemblyRefusalError("unreadable", `task-template-catalog-unreadable: ${error instanceof Error ? error.message : String(error)}`);
			}
			const contract = await service.contractFor(caller);
			if (!contract.ok) throwRefusal(contract);
			const dynamic = await service.dynamicFor(caller);
			if (!dynamic.ok) throwRefusal(dynamic);
			const questions = await service.questionsFor(caller);
			if (!questions.ok) throwRefusal(questions);
			withContractSection(assembly, contract.text);
			withRuntimeContext(assembly, STATE_CONTEXT_NAME, dynamic.text);
			withQuestionContext(assembly, questions.text);
			return next();
		}
		case "root": {
			if (caller.resolution.run === void 0 || caller.resolution.run.executionPhase === "active") try {
				withRuntimeContext(assembly, "singularity:task-templates", await service.templatesFor(caller));
			} catch (error) {
				throw new AssemblyRefusalError("unreadable", `task-template-catalog-unreadable: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (caller.resolution.task === void 0) return next();
			const contract = await service.contractFor(caller);
			if (!contract.ok) throwRefusal(contract);
			const questions = await service.questionsFor(caller);
			if (!questions.ok) throwRefusal(questions);
			withContractSection(assembly, contract.text);
			withQuestionContext(assembly, questions.text);
			return next();
		}
		case "reviewer": {
			const contract = await service.contractFor(caller);
			if (!contract.ok) throwRefusal(contract);
			withContractSection(assembly, contract.text);
			return next();
		}
		case "member": return next();
		case "unbound":
			if (caller.resolution.placement === "outside") return next();
			throwRefusal(refused(caller.resolution.refusal, caller.resolution.detail));
	}
}

//#endregion
//#region src/bindings/types.ts
/** What a source raises instead of picking a row: a conflict, or a ledger this process cannot read. */
var ReviewerBindingError = class extends Error {
	kind;
	constructor(kind, message$1) {
		super(message$1);
		this.name = "ReviewerBindingError";
		this.kind = kind;
	}
};
/** The graph facts a resolution carries, from the registry's own record. */
function callerGraph(graph) {
	return {
		id: graph.id,
		name: graph.name,
		envId: graph.envId,
		rootSessionId: String(graph.rootSessionId)
	};
}
/** Whether one session is a published member of a graph — the check every session reference passes. */
async function isGraphMember(graphs, graphId, sessionId) {
	return (await graphs.view(graphId)).graph.agents.some((agent) => String(agent.id) === sessionId);
}

//#endregion
//#region src/bindings/reviewer.ts
/** The failure one binding source reported, from the error's own name-plus-`kind` contract. */
function reviewerFailure(error) {
	const kind = error?.kind;
	if (kind !== "binding-conflict" && kind !== "unreadable") return void 0;
	if (error instanceof Error && error.name === "ReviewerBindingError") return kind;
}
/** The one delegation recorded for a session; a source that cannot answer is reported as-is. */
async function readDelegation(deps, sessionId) {
	const source = deps.reviewerSource;
	if (source === void 0) return { kind: "none" };
	let record;
	try {
		record = await source.read(sessionId);
	} catch (error) {
		const failure = reviewerFailure(error);
		if (failure !== void 0) return {
			kind: "refused",
			refusal: failure,
			detail: message(error)
		};
		return {
			kind: "refused",
			refusal: "unreadable",
			detail: `the reviewer binding source could not be read: ${message(error)}`
		};
	}
	return record === void 0 ? { kind: "none" } : {
		kind: "record",
		record
	};
}
/** The delegator check is the registry's published members, and a registry that cannot be read refuses. */
async function delegatorStanding(deps, sessionId, graph, actor) {
	let member;
	try {
		member = await isGraphMember(deps.graphs, graph.id, actor);
	} catch (error) {
		return {
			kind: "refused",
			refusal: "unreadable",
			detail: `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be checked against graph "${graph.id}": ${message(error)}. An unverifiable delegator is not an authorization.`
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
			detail: `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be placed: ${message(error)}. A delegator whose ownership cannot be read is not an authorization.`
		};
	}
	return {
		kind: "refused",
		refusal: "cross-graph",
		detail: `the delegation of session "${sessionId}" into graph "${graph.id}" (store "${rootTaskStoreId(graph.rootSessionId)}") was recorded by "${actor}", which graph "${graph.id}" does not publish: the delegator belongs to graph "${elsewhere?.id ?? "(unknown)"}", and a delegation never opens another graph's read domain.`
	};
}

//#endregion
//#region src/bindings/resolve.ts
/** The one legal shape of a store this deployment cannot open: it does not exist yet. */
async function openDomain(task, storeId) {
	try {
		return { snapshot: await task.openStore(storeId) };
	} catch (error) {
		const detail = message(error);
		if (/does not exist/.test(detail)) return {};
		return { failure: detail };
	}
}
/** The session's own run in one store: the **last** `TaskStarted` naming it, never a runtime lookup. */
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
/** The graph a session is a published member of; any throw but the registry's fact is a failed read. */
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
			detail: `graph membership for session "${sessionId}" could not be read: ${message(error)}. A registry that cannot be read is not a session without a graph.`
		};
	}
}
/** Whether the graph itself spawned one session into it — the graph store's own `spawn` edge. */
async function spawnedInto(deps, graph, sessionId) {
	try {
		return (await deps.graphs.view(graph.id)).graph.edges.some((edge) => edge.kind === "spawn" && String(edge.to) === sessionId) ? { kind: "spawned" } : { kind: "member" };
	} catch (error) {
		return {
			kind: "failed",
			detail: `session "${sessionId}" is published by graph "${graph.id}", whose store "${rootTaskStoreId(graph.rootSessionId)}" does not exist, and whether that graph spawned this session cannot be read: ${message(error)}. A binding that cannot be read is not a binding.`
		};
	}
}
/** Resolve one live session to the domain it may read, from durable facts only. */
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
			return failed(sessionId, "unreadable", `the delegation of session "${sessionId}" names store "${delegation$1.record.rootStoreId}", and the graph registry could not be listed to place it: ${message(error)}`);
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
	const recovery = await deps.taskRuntime.recoveryStatus(storeId);
	const base = {
		sessionId,
		graph: facts,
		storeId,
		recovery
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
	if (delegation.kind === "record") return await reviewerOf(deps, sessionId, graph, delegation.record, signal, {
		...opened,
		recovery
	});
	return {
		resolution: {
			...base,
			kind: "member"
		},
		...snapshot === void 0 ? {} : { snapshot }
	};
}
/** A reviewer's resolved domain: the delegation, its graph and its delegator, all checked (Q2). */
async function reviewerOf(deps, sessionId, graph, record, signal, domain) {
	signal?.throwIfAborted();
	const facts = callerGraph(graph);
	const storeId = rootTaskStoreId(graph.rootSessionId);
	if (storeId !== record.rootStoreId) return failed(sessionId, "cross-graph", `session "${sessionId}" is a member of graph "${graph.id}" (store "${storeId}") but its recorded delegation names store "${record.rootStoreId}"; a delegation never moves a session into another graph's domain.`, facts);
	const standing = await delegatorStanding(deps, sessionId, graph, record.actor);
	if (standing.kind === "refused") return failed(sessionId, standing.refusal, standing.detail, facts);
	const opened = domain ?? await openDomain(deps.task, storeId);
	if (opened.failure !== void 0) return failed(sessionId, "unreadable", `the delegated store "${storeId}" cannot be read: ${opened.failure}`, facts);
	const recovery = domain?.recovery ?? await deps.taskRuntime.recoveryStatus(storeId);
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

//#endregion
//#region src/limits.ts
/** The outer output bound of one context read, in UTF-8 bytes: the deployment's own inline cap. */
const CONTEXT_OUTPUT_LIMIT_BYTES = 5e4;
/** UTF-8 byte length of `text`. */
function utf8Bytes(text) {
	return Buffer.byteLength(text, "utf8");
}
/** The UTF-8 width of the character starting at UTF-16 index `index`, read off its code point. */
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
/** Take at most `maxBytes` bytes from `offsetBytes`, never splitting a character, and report the next offset. */
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
/** A byte-metered line list: every line fits whole — newline included — or is refused, never cut. */
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
/** One bounded list's omission line: the platform's clause plus this read's recovery sentence. */
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
/** The bytes `lines` occupy when appended to a budget that is `empty` (`lines.length` separators, one fewer when empty). */
function linesWidth(lines, empty) {
	if (lines.length === 0) return 0;
	return lines.reduce((total, line) => total + utf8Bytes(line), 0) + lines.length - (empty ? 1 : 0);
}
/** Lay out whole units until the budget (minus `reserve`) runs out, then the tail, dropping units until it fits. */
function budgetList(budget, list) {
	if (budget.addAll(list.header ?? []) > 0) return void 0;
	const rendered = list.units.map((unit) => list.lines(unit));
	const widths = rendered.map((lines, index) => linesWidth(lines, budget.bytes === 0 && index === 0));
	const room = budget.remaining - (list.reserve ?? 0);
	let shown = 0;
	let used = 0;
	while (shown < widths.length && used + widths[shown] <= room) {
		used += widths[shown];
		shown += 1;
	}
	if (list.tail !== void 0) for (;;) {
		const tail = list.tail(shown);
		if (linesWidth(tail, budget.bytes === 0 && shown === 0) <= room - used) {
			for (let index = 0; index < shown; index += 1) budget.addAll(rendered[index]);
			budget.addAll(tail);
			return list.units.slice(0, shown);
		}
		if (shown === 0) return void 0;
		shown -= 1;
		used -= widths[shown];
	}
	for (let index = 0; index < shown; index += 1) budget.addAll(rendered[index]);
	return list.units.slice(0, shown);
}
/** One item list's omission clause: the platform's notice plus this read's recovery sentence. */
function itemsClause(scope, recovery, limit, omitted, kept = limit - omitted) {
	return omissionLine({
		scope,
		unit: "items",
		kept,
		limit,
		omitted,
		recovery
	});
}
/** The least room one item list occupies whole: its heading line and its widest omission clause. */
function itemsFloor(title, scope, recovery, count) {
	return utf8Bytes(`- ${title}:`) + 1 + utf8Bytes(itemsClause(scope, recovery, count, count, 0)) + 1;
}

//#endregion
//#region src/render/fields.ts
/** The full phase note: a phase-less run is an old record whose only continuation is cancellation. */
const NEEDS_RECOVERY = "needs-recovery (an old record: it was created before coordination phases, so it has no phase to continue from and cannot decompose, submit or verify — cancel this task tree to recover)";
/** The compact form, for a status line whose run part is a cell inside a denser line. */
const NEEDS_RECOVERY_SHORT = "needs-recovery (old record without a coordination phase)";
/** The submission a run carries, as one clause: who handed it in, when, and what it named. */
function submissionClause(submission) {
	const evidence = submission.evidenceRefs.length === 0 ? "" : `; evidence [${submission.evidenceRefs.join(", ")}]`;
	const notes = submission.notes === void 0 ? "" : `; notes: ${submission.notes}`;
	return `submitted by ${submission.origin} at ${submission.submittedAt}: "${submission.summary}"${evidence}${notes}`;
}
/** The phase one run's line shows: `active` with an open blocking question reads `waiting_answer`. */
function displayPhase(run, snapshot) {
	const phase = run.executionPhase;
	if (phase !== "active") return phase;
	return blockedByQuestion(run, snapshot) ? "waiting_answer" : phase;
}
/** Whether a blocking question this run asked is still open — the fact `waiting_answer` is derived from. */
function blockedByQuestion(run, snapshot) {
	return snapshot?.questions === void 0 ? false : blockingQuestionsOf(snapshot, run.runId).length > 0;
}
/** The phase, batch, submission and no-progress facts of one run, appended to a run line. */
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
/** The protected acceptance inputs a criterion declares, as one suffix. */
function protectedInputsPart(criterion) {
	const declared = criterion.protectedInputs ?? [];
	return declared.length === 0 ? "" : ` [protected inputs: ${declared.map((ref) => ref.path).join(", ")}]`;
}
/** The protected inputs with their fixed identity, for a record read: the digest is part of the record. */
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
/** The two contract facts a reader cannot read off the objective and the criteria table. */
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
/** The root most distant ancestor of one task: the top of its real parent chain. */
function rootAncestor(snapshot, task) {
	let current = task;
	while (current.parentTaskId !== void 0) {
		const parentId = current.parentTaskId;
		const parent = snapshot.tasks.find((item) => item.taskId === parentId);
		if (parent === void 0) return {
			task: current,
			brokenAt: parentId
		};
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
/** The handoff envelope as a projection: the delegation terms and the references a worker may read. */
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
/** The one-line identity of one task, in the shape both status reads use. */
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
/** The heading the contract of each role is printed under. */
function contractHeading(role) {
	switch (role) {
		case "reviewer": return "## Delegated contract (review-only)";
		case "root": return "## Your contract (graph root)";
		default: return "## Your contract";
	}
}
/** The contract block both the projection and `task_read` print, one shape for every role. */
function contractBody(task) {
	return [
		`task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth}`,
		`objective: ${task.objective}`,
		"acceptance criteria:",
		...task.acceptanceCriteria.length === 0 ? ["(none)"] : criteriaLines(task.acceptanceCriteria),
		...contractLines(task)
	];
}
/** The caller's own run, as one line: status, phase, and the old-record marker such a run earns. */
function ownRunLine(run, snapshot) {
	return `run ${run.runId} [${run.status}]${runPhaseSuffix(run, snapshot)} started ${run.startedAt}`;
}

//#endregion
//#region src/render/records.ts
/** The first 12 hex of a digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest) {
	return digest.slice(0, 12);
}
/** Render one run's binding summary; without `read` no readability claim is made. */
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
		...binding.snapshotRoot === void 0 ? ["- this run bound no content snapshot; it cannot supply guidance to a model request"] : [`- bound content snapshot: ${binding.snapshotRoot}`, "- the contract context loads the full Skill instructions from this frozen snapshot before task execution"]
	];
	if (read$1 !== void 0 && read$1.defects.length > 0) header.push("", "Bound content is not readable: the snapshot no longer matches this run's record, and the production skill path is not a substitute for it.", ...read$1.defects.map((defect) => `- ${defect}`));
	return header.join("\n");
}
/** The run binding block: the summary re-checked, or its re-check failure stated in its place. */
async function bindingLines(taskRuntime, binding) {
	if (binding === void 0) return [];
	let summary;
	try {
		summary = renderRunBinding(binding, await taskRuntime.readRunBinding(binding));
	} catch (error) {
		summary = [
			"## Implementation chosen for this run",
			"",
			`- bound content could not be re-read against its snapshot: ${message(error)}`
		].join("\n");
	}
	return summary.length === 0 ? [] : ["", ...summary.split("\n")];
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
/** The complete rendering of one run record, with the binding re-check appended. */
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
/** The complete rendering of one review record, identified by its `(taskId, runId)` pair. */
function reviewRecordText(review) {
	const runPart = review.runId === void 0 ? "no run — the task blocked before any run started" : `run ${review.runId}`;
	return [
		`review of task ${review.taskId} (${runPart}) [${review.outcome}]`,
		`evidence refs: ${review.evidenceRefs.length === 0 ? "(none)" : review.evidenceRefs.join(", ")}`,
		"",
		...jsonBlock(review)
	].join("\n");
}
/** The complete rendering of one diagnosis record. */
function diagnosisRecordText(diagnosis) {
	return [
		`diagnosis ${diagnosis.diagnosisId} of task ${diagnosis.taskId} [confidence ${diagnosis.confidence}]`,
		`postmortem observation: ${diagnosis.observedFailure}`,
		`localized cause: ${diagnosis.localizedCause}`,
		"",
		...jsonBlock(diagnosis)
	].join("\n");
}

//#endregion
//#region src/reads/guards.ts
/** The status page's default entry count, and the range a caller's limit is clamped into. */
const STATUS_LIMIT_DEFAULT = 20;
const STATUS_LIMIT_MAX = 100;
/** The session page's default event count, and its ceiling (the same range as a status page). */
const SESSION_LIMIT_DEFAULT = 20;
const SESSION_LIMIT_MAX = 100;
/** The floor of one session-event page, in UTF-8 bytes: a page always carries one character. */
const SESSION_EVENT_PAGE_MIN_BYTES = 4;
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
const TASK_PAGE_MIN_BYTES = 64;
/** The source line every result carries, naming what was read and how much one observation covers. */
function storeSource(graph, storeId, what) {
	return `${what} — store ${storeId} of graph ${graph.id}, one Task snapshot read`;
}
/** The recovery marker a result shows, or `undefined` while the store is simply ready. */
function recoveryMarker(recovery) {
	if (recovery.status === "ready") return void 0;
	const reason = "reason" in recovery ? ` — ${recovery.reason}` : "";
	return `recovery: ${recovery.status}${reason}`;
}
/** The sentence every result that shows a marker carries, so a marker is never read as a trigger. */
const RECOVERY_NOTE = "a recovery marker is an observation: this read neither triggers nor waits for recovery";
/** The refusal of an unbound caller, named by the resolution that produced it. */
function unboundRead(resolution) {
	return refused(resolution.refusal, resolution.detail);
}
/** The refusal of a read the output bound cannot lay out whole; a core contract is never cut to fit. */
function tooLarge(what, where) {
	return refused("context-too-large", `${what} does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound, and a core contract is never cut to fit; nothing is reported in place of it. ${where}`);
}
/** The one action that reaches a task-class record in pages. */
function taskPageHint(taskId) {
	return `Read the record in pages with \`context_read\` kind:"task" ref:"${taskId}" (offset in UTF-8 bytes, limit up to ${CONTEXT_OUTPUT_LIMIT_BYTES}).`;
}
/** Ascending comparison of the two strings a store sorts by (ids, timestamps). */
function byString(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
/** The reads' shared preamble, with the per-read differences in {@link ProjectionTargetSpec}. */
function resolveProjectionTarget(loaded, spec) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return {
		kind: "refused",
		read: unboundRead(resolution)
	};
	if (resolution.kind === "member" && spec.member !== void 0) return {
		kind: "refused",
		read: refused("unbound", `session "${resolution.sessionId}" is a published member of graph "${resolution.graph.id}" but has no Run of its own and no recorded delegation, so ${spec.member}`)
	};
	if (resolution.kind === "root" && resolution.task === void 0) return {
		kind: "refused",
		read: refused("not-activated", notActivatedLines(resolution.graph, resolution.storeId, loaded.snapshot).join("\n"))
	};
	if (resolution.kind === "reviewer" && resolution.task === void 0 && spec.delegation !== void 0) return {
		kind: "refused",
		read: refused("not-found", `the delegation of session "${resolution.sessionId}" names task "${resolution.delegation.taskId}", which store "${resolution.storeId}" does not hold; ${spec.delegation}`)
	};
	const task = "task" in resolution ? resolution.task : void 0;
	const run = resolution.kind === "worker" || resolution.kind === "root" ? resolution.run : void 0;
	return {
		kind: "bound",
		resolution,
		...task === void 0 ? {} : { task },
		...run === void 0 ? {} : { run },
		...loaded.snapshot === void 0 ? {} : { snapshot: loaded.snapshot }
	};
}
/** Workers read their branch and context; a valid review delegation reads its whole graph, read-only. */
function readableTaskIds(loaded) {
	const { resolution, snapshot } = loaded;
	if (resolution.kind !== "worker" && resolution.kind !== "reviewer") return void 0;
	const own = resolution.task;
	if (own === void 0 || snapshot === void 0) return /* @__PURE__ */ new Set();
	if (resolution.kind === "reviewer") return void 0;
	const branch = /* @__PURE__ */ new Set();
	const pending = [own.taskId];
	while (pending.length > 0) {
		const id = pending.pop();
		if (branch.has(id)) continue;
		branch.add(id);
		pending.push(...snapshot.tasks.filter((task) => task.parentTaskId === id).map((task) => task.taskId));
	}
	const visible = new Set(branch);
	for (const edge of snapshot.edges) {
		if (branch.has(edge.to)) visible.add(edge.from);
		if (branch.has(edge.from)) visible.add(edge.to);
	}
	let parent = own.parentTaskId;
	const ancestors = /* @__PURE__ */ new Set();
	while (parent !== void 0 && !ancestors.has(parent)) {
		ancestors.add(parent);
		visible.add(parent);
		parent = snapshot.tasks.find((task) => task.taskId === parent)?.parentTaskId;
	}
	return visible;
}
/** The membership gate both session reads pass before DSH is asked anything. */
async function sessionMembershipRefusal(deps, loaded, sessionId) {
	const resolution = loaded.resolution;
	let member;
	try {
		member = await isGraphMember(deps.graphs, resolution.graph.id, sessionId);
	} catch (error) {
		return refused("unreadable", `the membership of session "${sessionId}" in graph "${resolution.graph.id}" could not be read: ${message(error)}. A session reference is checked against the graph's published members before its log is read.`);
	}
	if (member) {
		const allowed = readableTaskIds(loaded);
		if (allowed !== void 0 && (allowed.size === 0 || sessionId !== resolution.sessionId && !loaded.snapshot?.runs.some((run) => run.sessionId === sessionId && allowed.has(run.taskId)))) return refused("not-found", `session "${sessionId}" is outside the caller's task branch and dependency context; nothing was read`);
		return;
	}
	return refused("cross-graph", `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the caller's own domain, and a session id is not a key to another graph.`);
}
/** What an open root proposal means; none of the three is terminal, and two still await activation. */
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
/** The not-activated view: the state named, whatever proposal is open, and the one action that changes it. */
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
//#region src/reads/contract.ts
/** One handoff reference list: laid out whole, or refused by the caller with `tooLarge`. */
function referenceList(budget, title, entries, scope, recovery, follow = 0) {
	if (entries.length === 0) return budget.add(`- ${title}: (none)`);
	return budgetList(budget, {
		header: [`- ${title}:`],
		units: entries,
		lines: (entry) => [`  ${entry}`],
		reserve: follow,
		tail: (count) => count === entries.length ? [] : [itemsClause(scope, recovery, entries.length, entries.length - count)]
	}) !== void 0;
}
/** The immutable half of the context one role is assembled with (A2 §D/§9). */
async function contractProjection(deps, loaded) {
	const target = resolveProjectionTarget(loaded, {
		member: "it has no contract to project. A member reads the graph's records by reference (`context_read`) or asks for the status view; it never inherits the root's contract.",
		delegation: "the delegated contract cannot be read."
	});
	if (target.kind === "refused") return target.read;
	const { resolution } = target;
	const snapshot = target.snapshot;
	if (snapshot === void 0) return refused("unreadable", `store "${resolution.storeId}" of graph "${resolution.graph.id}" could not be read, so the contract it holds cannot be projected.`);
	const task = target.task;
	const run = target.run;
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
	const summaryLines = role === "reviewer" && run?.providerBinding !== void 0 ? await bindingLines(deps.taskRuntime, run.providerBinding) : [];
	if (role !== "reviewer") {
		if (run?.providerBinding === void 0 || run.providerBinding.skills.length === 0) return refused("unreadable", `task "${task.taskId}" has no bound guidance Skill; its model request cannot execute unguided work.`);
		let bound;
		try {
			bound = await deps.taskRuntime.readRunBinding(run.providerBinding);
		} catch (error) {
			return refused("unreadable", `task "${task.taskId}" cannot load its frozen guidance Skill: ${message(error)}`);
		}
		if (bound === void 0 || bound.defects.length > 0 || bound.skills.length === 0 || bound.skills.some((skill) => !skill.readable || !skill.instructions?.trim())) return refused("unreadable", `task "${task.taskId}" cannot load its frozen guidance Skill: ${bound?.defects.join("; ") || "no readable bound instruction body"}`);
		summaryLines.push("", ...renderRunBinding(run.providerBinding, bound).split("\n"), "", "## Guidance loaded for this run", "These are the complete instructions from this Run’s frozen Skill snapshot. Follow them for this task; loading other Skills does not change the contract or tool permissions.", ...bound.skills.flatMap((skill) => [
			"",
			`### Skill ${skill.name}`,
			`Resources: ${bound.snapshotRoot}/${skill.name}`,
			"",
			skill.instructions
		]));
	}
	const summaryFloor = summaryLines.length === 0 ? 0 : utf8Bytes(summaryLines.join("\n")) + 2;
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
			const evidenceFloor = itemsFloor("relevant evidence", "handoff evidence references", "read them by id", references.evidence.length);
			const tail = summaryFloor;
			if (!referenceList(budget, "relevant artifacts", references.artifacts, "handoff artifact references", "read them by id", evidenceFloor + tail)) return tooLarge("the handoff references", taskPageHint(task.taskId));
			if (!referenceList(budget, "relevant evidence", references.evidence, "handoff evidence references", "read them by id", tail)) return tooLarge("the handoff references", taskPageHint(task.taskId));
		}
	}
	if (summaryLines.length > 0 && budget.addAll(summaryLines) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's immutable contract"));
}

//#endregion
//#region src/reads/dynamic.ts
/** The tasks one caller's status view covers: itself, its direct children, and its dependency neighbours. */
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
	}).sort((left, right) => byString(left.task.taskId, right.task.taskId));
}
/** The dynamic half (A2 §D/§9): run state, gate phase, related tasks; byte-stable per content. */
async function dynamicProjection(deps, loaded) {
	const target = resolveProjectionTarget(loaded, {
		member: "there is no dynamic state to project for it; the graph's tasks are readable with the status view or by reference.",
		delegation: "there is no delegated state to project."
	});
	if (target.kind === "refused") return target.read;
	const { resolution } = target;
	const task = target.task;
	const snapshot = target.snapshot;
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
	} else if (!budget.add(`your run: ${target.run === void 0 ? "none" : ownRunLine(target.run, snapshot)}`)) return tooLarge("the run line", taskPageHint(task.taskId));
	if (snapshot !== void 0) {
		const lines = relatedEntries(snapshot, task).map((entry) => taskSummaryLine(snapshot, entry.task, entry.roles));
		const clause = (omitted) => omissionLine({
			scope: "related tasks",
			unit: "items",
			kept: lines.length - omitted,
			limit: lines.length,
			omitted,
			recovery: "page through them with the status view"
		});
		if (budgetList(budget, {
			header: ["", "related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):"],
			units: lines,
			lines: (line) => [line],
			tail: (count) => count === lines.length ? [] : [clause(lines.length - count)]
		}) === void 0) return tooLarge("the related tasks list", taskPageHint(task.taskId));
	}
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's dynamic state"));
}

//#endregion
//#region src/session/page.ts
/** The exact object reference one event is read with, as the listing hands it back and the tool spells it. */
function eventReference(sessionId, seq) {
	return `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq}}`;
}
/** The lines one event occupies in a listing: its head line, then its visible text line by line. */
function eventLines(event) {
	const text = extractSessionEventText(event);
	const head = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`;
	return text.length === 0 ? [head] : [head, ...text.split("\n").map((line) => `  ${line}`)];
}
/** The UTF-8 size of the text one event carries. */
function eventTextBytes(event) {
	return utf8Bytes(extractSessionEventText(event));
}
/** The refusal of an event no listing page can carry, handing back the reference that reads it. */
function oversizedEventDetail(sessionId, event) {
	const seq = Number(event.seq);
	return `event seq ${seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its visible text alone is ${eventTextBytes(event)} UTF-8 bytes); a session listing carries whole events — DSH's read unit — so this listing cannot render it whole, and none of its text is shown here. Read that event with \`context_read\` kind:"session" ref:${eventReference(sessionId, seq)}, whose pages are the UTF-8 bytes of its visible text. Asking this listing again with offset ${seq + 1} moves past the event and shows none of its text: that is the caller's explicit choice, not a way to read the body.`;
}
/** The line a page carries when it stops before an event that does not fit, naming it and the reference that reads it. */
function notShownEventLine(sessionId, event) {
	const seq = Number(event.seq);
	return `- the next event (seq ${seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ref:${eventReference(sessionId, seq)} — its text pages in UTF-8 bytes.`;
}
/** The line the final page of an event carries: the listing continues at the event seq after this one. */
function eventEndNote(sessionId, seq) {
	return `the visible text of event seq ${seq} of session "${sessionId}" ends here; the listing of that session continues with \`context_read\` kind:"session" ref:"${sessionId}" offset = ${seq + 1} (the event seq after this one).`;
}
/** One event page as JSON — exactly the model-visible value, its `note` on the final page only. */
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

//#endregion
//#region src/reads/questions.ts
/** What nothing was proven about. */
const NOTHING_CONSUMED = /* @__PURE__ */ new Set();
/** The message identities one Session's own history proves its model has seen (A4 §7.3). */
async function consumedMessageIds(deps, sessionId) {
	const log = await deps.sessionQuery.readSession(sessionId);
	const ids = /* @__PURE__ */ new Set();
	for (const event of log.events.slice(log.inheritedEventCount)) if (event.type === "user/message") ids.add(String(event.data.id));
	return ids;
}
/** The order both lists print in: `askedAt` ascending, stable for same-millisecond asks. */
function byAskedAt(left, right) {
	return byString(left.askedAt, right.askedAt);
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
/** One bounded list of question or answer lines: the entries in ask order, then the list's guidance. */
function questionList(budget, heading, entries, guidance, scope, recovery) {
	return budgetList(budget, {
		header: ["", heading],
		units: entries,
		lines: (entry) => [entry],
		tail: (count) => [...count === entries.length ? [] : [itemsClause(scope, recovery, entries.length, entries.length - count)], guidance]
	}) === void 0 ? "too-large" : "ok";
}
/** The question plane (A4 §F.1/§7.3): open questions owed, and answers no read has been shown. */
async function questionProjection(deps, loaded) {
	const target = resolveProjectionTarget(loaded, {
		member: "it asks no parent and answers no child; questions belong to the runs that hold them.",
		delegation: "there is no delegated run whose questions could be projected."
	});
	if (target.kind === "refused") return target.read;
	const { resolution } = target;
	const snapshot = target.snapshot;
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

//#endregion
//#region src/session/session-event-read.ts
/** Whether `offsetBytes` sits on a character boundary; an offset outside the text is not one either. */
function onCharacterBoundary(text, offsetBytes) {
	if (offsetBytes === 0) return true;
	const byte = Buffer.from(text, "utf8")[offsetBytes];
	return byte !== void 0 && (byte & 192) !== 128;
}
/** One session *event*'s visible text, paged in UTF-8 bytes (A2 §D, Q3 closure). */
async function sessionEventRead(deps, loaded, ref, requestedOffset, requestedLimit, signal) {
	loaded.resolution;
	signal?.throwIfAborted();
	const sessionId = ref.sessionId;
	const seq = ref.seq;
	const offset = requestedOffset ?? 0;
	const requestedBytes = Math.trunc(requestedLimit ?? CONTEXT_OUTPUT_LIMIT_BYTES);
	const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(SESSION_EVENT_PAGE_MIN_BYTES, requestedBytes));
	const gate = await sessionMembershipRefusal(deps, loaded, sessionId);
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
	return read(page, source, {
		hasMore: !slice.done,
		nextOffset: slice.nextOffset
	});
}

//#endregion
//#region src/session/session-read.ts
/** One session page: events from `offset` (a DSH event seq) onward, whole events only. */
async function sessionRead(deps, loaded, sessionId, requestedOffset, requestedLimit, signal) {
	const resolution = loaded.resolution;
	signal?.throwIfAborted();
	const gate = await sessionMembershipRefusal(deps, loaded, sessionId);
	if (gate !== void 0) return gate;
	const offset = Math.max(0, Math.trunc(requestedOffset ?? 0));
	const requestedEvents = Math.trunc(requestedLimit ?? SESSION_LIMIT_DEFAULT);
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
	/** The closing lines a page with `shown` events owes: the stopped event, then where to continue. */
	const closing = (shown$1) => {
		const lastShownSeq = Number(events[shown$1 - 1].seq);
		const stopped = shown$1 < events.length ? events[shown$1] : void 0;
		const nextOffset = stopped === void 0 ? lastShownSeq + 1 : Number(stopped.seq);
		const hasMore = nextOffset <= capturedThroughSeq;
		return {
			lines: [...stopped === void 0 ? [] : [notShownEventLine(sessionId, stopped)], `- events shown: ${shown$1} of at most ${limit}` + (hasMore ? ` · more follows from seq ${nextOffset}` : " · end of the log")],
			nextOffset,
			hasMore
		};
	};
	const shown = budgetList(budget, {
		units: events,
		lines: eventLines,
		tail: (count) => count === 0 ? [] : closing(count).lines
	});
	if (shown === void 0 || shown.length === 0) return refused("context-too-large", oversizedEventDetail(sessionId, events[0]));
	const end = closing(shown.length);
	return read(budget.text(), `session ${sessionId} via the session query, seq ${offset}..${Number(shown[shown.length - 1].seq)} of a log through seq ${capturedThroughSeq}`, {
		hasMore: end.hasMore,
		nextOffset: end.nextOffset
	});
}

//#endregion
//#region src/reads/reference-read.ts
/** The record text one located record renders to — the kind decides, never a property sniff. */
async function recordTextOf(deps, snapshot, kind, record) {
	switch (kind) {
		case "task": return taskRecordText(record);
		case "run": return await runRecordText(deps.taskRuntime, record, snapshot);
		case "evidence": return evidenceRecordText(snapshot, record);
		case "review": return reviewRecordText(record);
		case "diagnosis": return diagnosisRecordText(record);
	}
}
function unknownDetail(noun, ref, snapshot) {
	return `no ${noun} "${ref}" in your graph's task store (it holds ${snapshot.tasks.length} tasks); ids from another graph are not readable here, and a reference never widens the read domain.`;
}
/** Resolve one reference inside the caller's own store; never outside it. */
function locateRecord(snapshot, kind, ref) {
	if (kind === "review") {
		const { taskId, runId = null } = ref;
		if (snapshot.tasks.find((item) => item.taskId === taskId) === void 0) return {
			refusal: "not-found",
			detail: `task "${taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`
		};
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
	const id = ref;
	switch (kind) {
		case "task": {
			const task = snapshot.tasks.find((item) => item.taskId === id);
			return task === void 0 ? {
				refusal: "not-found",
				detail: unknownDetail("task", id, snapshot)
			} : {
				identity: id,
				record: task
			};
		}
		case "run": {
			const run = snapshot.runs.find((item) => item.runId === id);
			return run === void 0 ? {
				refusal: "not-found",
				detail: unknownDetail("run", id, snapshot)
			} : {
				identity: id,
				record: run
			};
		}
		case "evidence": {
			const evidence = snapshot.evidence.find((item) => item.evidenceId === id);
			if (evidence === void 0) return {
				refusal: "not-found",
				detail: unknownDetail("evidence", id, snapshot)
			};
			if (!snapshot.tasks.some((item) => item.taskId === evidence.taskId)) return {
				refusal: "stale-reference",
				detail: `evidence "${id}" names task "${evidence.taskId}", which this store does not hold: the reference is stale.`
			};
			return {
				identity: id,
				record: evidence
			};
		}
		case "diagnosis": {
			const diagnosis = snapshot.diagnoses.find((item) => item.diagnosisId === id);
			if (diagnosis === void 0) return {
				refusal: "not-found",
				detail: unknownDetail("diagnosis", id, snapshot)
			};
			if (!snapshot.tasks.some((item) => item.taskId === diagnosis.taskId)) return {
				refusal: "stale-reference",
				detail: `diagnosis "${id}" names task "${diagnosis.taskId}", which this store does not hold: the reference is stale.`
			};
			return {
				identity: id,
				record: diagnosis
			};
		}
	}
}
/** `context_read` (A2 §D/A2-5): one record of the caller's own domain, by reference. */
async function contextRead(deps, loaded, query, signal) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	signal?.throwIfAborted();
	const kind = query.kind;
	if (kind === "session") {
		if (typeof query.ref === "string") return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal);
		return await sessionEventRead(deps, loaded, query.ref, query.offset, query.limit, signal);
	}
	const snapshot = loaded.snapshot;
	if (snapshot === void 0) return refused("not-activated", `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so it holds no ${kind} record to read.`);
	const allowed = readableTaskIds(loaded);
	const found = locateRecord(allowed === void 0 ? snapshot : {
		...snapshot,
		tasks: snapshot.tasks.filter((record) => allowed.has(record.taskId)),
		runs: snapshot.runs.filter((record) => allowed.has(record.taskId)),
		evidence: snapshot.evidence.filter((record) => allowed.has(record.taskId)),
		reviews: snapshot.reviews.filter((record) => allowed.has(record.taskId)),
		diagnoses: snapshot.diagnoses.filter((record) => allowed.has(record.taskId))
	}, kind, query.ref);
	if ("refusal" in found) return refused(found.refusal, found.detail);
	const recordText = await recordTextOf(deps, snapshot, kind, found.record);
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

//#endregion
//#region src/reads/task-read.ts
/** `task_read` (A2 §D/A2-5): the caller's own contract, children, run and re-checked binding. */
async function taskRead(deps, loaded) {
	const target = resolveProjectionTarget(loaded, {
		member: "no contract is bound to it, and the root's contract is not a substitute.",
		delegation: "the delegated contract cannot be read."
	});
	if (target.kind === "refused") return target.read;
	const { resolution } = target;
	const snapshot = target.snapshot;
	const task = target.task;
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
	const run = target.run;
	const lines = [
		"",
		...contractBody(task),
		...run === void 0 ? [] : ["", ownRunLine(run, snapshot)]
	];
	if (budget.addAll(lines) > 0) return tooLarge("your contract", taskPageHint(task.taskId));
	const summary = run?.providerBinding === void 0 ? [] : (await bindingLines(deps.taskRuntime, run.providerBinding)).filter((line) => line.length > 0);
	if (snapshot !== void 0 && resolution.kind === "root") {
		const children = task.childTaskIds.flatMap((taskId) => snapshot.tasks.filter((item) => item.taskId === taskId));
		const clause = (omitted) => omissionLine({
			scope: "child tasks",
			unit: "items",
			kept: children.length - omitted,
			limit: children.length,
			omitted,
			recovery: "read them with the status view or by reference"
		});
		if (budgetList(budget, {
			header: ["", `children: ${children.length}`],
			units: children,
			lines: (child) => [taskSummaryLine(snapshot, child)],
			reserve: summary.length === 0 ? 0 : utf8Bytes(summary.join("\n")) + 2,
			tail: (count) => count === children.length ? [] : [clause(children.length - count)]
		}) === void 0) return tooLarge("the root's children", taskPageHint(task.taskId));
	}
	if (summary.length > 0 && budget.addAll(summary) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "read the caller's own contract and run"));
}

//#endregion
//#region src/reads/task-status.ts
/** Best-effort obligation coverage (KISS §5.1): an absent source omits the line, never reports zero. */
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
		const uncovered = coverage.uncovered.map((template) => `${template.id} ("${template.question}") — no passing evidence bound to this criterion id`);
		return [...header, `- obligation evidence: ${coverage.covered.length}/${templates.length} satisfied${uncovered.length === 0 ? "" : `; unresolved: ${uncovered.join("; ")}`}`];
	} catch {
		return header;
	}
}
/** `task_status` (A2 §D/A2-5): the caller's related tasks, or the whole domain, paged by offset. */
async function taskStatus(deps, loaded, query) {
	const target = resolveProjectionTarget(loaded, {});
	if (target.kind === "refused") return target.read;
	const { resolution } = target;
	const snapshot = target.snapshot;
	const scope = query.scope ?? "related";
	const requestedOffset = query.offset ?? 0;
	const requestedLimit = query.limit ?? STATUS_LIMIT_DEFAULT;
	const offset = Math.max(0, Math.trunc(requestedOffset));
	const limit = Math.min(STATUS_LIMIT_MAX, Math.max(1, Math.trunc(requestedLimit)));
	const clamped = requestedOffset !== offset || requestedLimit !== limit;
	if (snapshot === void 0) return refused("not-activated", `store "${resolution.storeId}" of graph "${resolution.graph.id}" does not exist yet, so there is no task tree to read.`);
	const self = target.task;
	if (scope === "related" && self === void 0) return refused("unbound", `session "${resolution.sessionId}" has no task of its own in store "${resolution.storeId}", so there is no related scope for it; ask for scope:"graph" to read the whole domain.`);
	const allowed = readableTaskIds(loaded);
	const entries = (scope === "graph" ? [...snapshot.tasks].sort((left, right) => byString(left.taskId, right.taskId)).map((task) => ({
		task,
		roles: []
	})) : relatedEntries(snapshot, self)).filter((entry) => allowed === void 0 || allowed.has(entry.task.taskId));
	const page = entries.slice(offset, offset + limit);
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const marker = recoveryMarker(resolution.recovery);
	const header = [
		"# Task status",
		`graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
		`scope: ${scope} · offset ${offset} · limit ${limit}` + (clamped ? ` (requested offset ${requestedOffset}, limit ${requestedLimit}: both are clamped into their ranges)` : ""),
		...resolution.kind === "reviewer" && allowed === void 0 ? ["read boundary: delegated graph, read-only; task and session references cannot cross graphs"] : allowed === void 0 ? [] : ["read boundary: own branch, ancestor context and dependency neighbours"],
		`entries in scope: ${entries.length}`,
		...marker === void 0 ? [] : [marker, RECOVERY_NOTE]
	];
	if (budget.addAll(header) > 0) return tooLarge("the status header", "Ask for a smaller page (a lower `limit`) or the `related` scope.");
	const obligations = allowed === void 0 ? await obligationLines(deps.envBuilder, resolution.graph.envId, snapshot) : [];
	const obligationsReserve = obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
	const entryLines = (entry) => {
		const lines = [taskSummaryLine(snapshot, entry.task, entry.roles)];
		if (scope !== "graph") return lines;
		const taskId = entry.task.taskId;
		const incoming = snapshot.edges.filter((edge) => edge.to === taskId && (allowed === void 0 || allowed.has(edge.from))).map((edge) => edge.from);
		const outgoing = snapshot.edges.filter((edge) => edge.from === taskId && (allowed === void 0 || allowed.has(edge.to))).map((edge) => edge.to);
		const runs = snapshot.runs.filter((run) => run.taskId === taskId).map((run) => `${run.runId}=session ${run.sessionId}`);
		const reviews = snapshot.reviews.filter((review) => review.taskId === taskId).map((review) => `${taskId}#${review.runId ?? "no-run"}`);
		const diagnoses = snapshot.diagnoses.filter((diagnosis) => diagnosis.taskId === taskId).map((diagnosis) => diagnosis.diagnosisId);
		lines.push(`  parent ${entry.task.parentTaskId ?? "none"}; dependencies [${incoming.join(", ")}]; blocks [${outgoing.join(", ")}]; runs [${runs.join(", ")}]; reviewRefs [${reviews.join(", ")}]; diagnosisRefs [${diagnoses.join(", ")}]`);
		return lines;
	};
	const shown = budgetList(budget, {
		units: page,
		lines: entryLines,
		reserve: obligationsReserve,
		tail: (count) => {
			const nextOffset$1 = offset + count;
			return [
				`- more: ${nextOffset$1 < entries.length ? `yes — continue with offset ${nextOffset$1}` : "no — this is the end of the scope"}`,
				...scope === "graph" ? ["- exact records: context_read kind:\"task\"/\"run\"/\"diagnosis\" ref:<id>; kind:\"review\" ref:{taskId,runId}; kind:\"session\" ref:<sessionId> (all page in the same read domain)"] : [],
				`- source: one read of store ${resolution.storeId}; pages are observations, not a consistent snapshot across calls` + (count < page.length ? "; this page stopped at the output bound" : "")
			];
		}
	});
	if (page.length > 0 && (shown === void 0 || shown.length === 0)) {
		const first = page[0];
		const summaryBytes = utf8Bytes(taskSummaryLine(snapshot, first.task, first.roles));
		const entryBytes = utf8Bytes(entryLines(first).join("\n"));
		const summaryTooLarge = summaryBytes > CONTEXT_OUTPUT_LIMIT_BYTES;
		return tooLarge(`the ${summaryTooLarge ? "summary line" : "status entry"} of task "${first.task.taskId}" (${summaryTooLarge ? summaryBytes : entryBytes} UTF-8 bytes)`, `Nothing of that entry is shown, and a page of zero entries at offset ${offset} would report the same offset again, so the listing could never move past it. Read that task whole instead with \`context_read\` kind:"task" ref:"${first.task.taskId}" (its record pages in UTF-8 bytes), or ask for the entries *after* it with offset ${offset + 1} — the rest of the scope stays reachable that way.`);
	}
	if (shown === void 0) return tooLarge("the status page footer", "Ask for a smaller page (a lower `limit`).");
	const nextOffset = offset + shown.length;
	const hasMore = nextOffset < entries.length;
	budget.addAll(obligations);
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, `listed ${scope} tasks`), {
		hasMore,
		nextOffset
	});
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
	/** The one registered delegation source, when this deployment has one. */
	reviewerSource;
	constructor(ctx) {
		super(ctx, "singularityContext");
	}
	/** Mount the one `system-prompt/assemble` waterfall listener this service owns. */
	[Service.init]() {
		this.ctx.effect(() => this.ctx.on("system-prompt/assemble", (assembly, context, next) => assembleSingularityContext(this, assembly, context, next)), "singularityContext: system-prompt assembly");
	}
	/** Register the one reviewer-delegation source; the returned disposer removes it again. */
	registerReviewerBindingSource(source) {
		const previous = this.reviewerSource;
		this.reviewerSource = source;
		return () => {
			if (this.reviewerSource === source) this.reviewerSource = previous;
		};
	}
	/** The domain a live session may read, from durable facts. */
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
	/** The question plane (A4 §F.1/§7.3): open questions, and answers no read has been shown. */
	async questionProjection(sessionId, signal) {
		return await questionProjection(this.readDeps(), await this.load(sessionId, signal));
	}
	/** The caller's own loaded domain, resolved once for every plane of one model request. */
	async load(sessionId, signal) {
		signal?.throwIfAborted();
		return await loadCaller(this.bindingDeps(), sessionId, signal);
	}
	/** One plane of a caller already loaded — the assembly's own doors. */
	async contractFor(caller) {
		return await contractProjection(this.readDeps(), caller);
	}
	async dynamicFor(caller) {
		return await dynamicProjection(this.readDeps(), caller);
	}
	async questionsFor(caller) {
		return await questionProjection(this.readDeps(), caller);
	}
	/** Retrieve the current visible catalog before the model decides its next children. */
	async templatesFor(caller) {
		if (caller.resolution.kind === "worker" && !this.ctx.taskRuntime.allowsRuntimeDecomposition()) return "";
		const page = await this.ctx.taskRuntime.listTaskTemplates({ limit: 10 }, caller.resolution.sessionId);
		return "# Visible Task templates\n" + JSON.stringify(page) + "\nUse task_template_list for another page, a narrower catalogPath, or the full exact templateRef. Choose an applicable template and parameters, or a complete standard contract when none applies. Instance history is recorded automatically; reusable templates are published selectively through Evolution.";
	}
	bindingDeps() {
		return {
			task: this.ctx.task,
			graphs: this.ctx.graphs,
			taskRuntime: this.ctx.taskRuntime,
			...this.reviewerSource === void 0 ? {} : { reviewerSource: this.reviewerSource }
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
	/** The env builder this deployment mounts, when it mounts one. */
	envBuilder() {
		return this.ctx.get("envBuilder");
	}
};
var src_default = SingularityContextService;

//#endregion
export { AssemblyRefusalError, CONTEXT_OUTPUT_LIMIT_BYTES, NAMED_REFUSALS, OutputBudget, QUESTIONS_CONTEXT_NAME, QUESTIONS_CONTEXT_ORDER, ReviewerBindingError, STATE_CONTEXT_NAME, STATE_CONTEXT_ORDER, SingularityContextService, WORKER_CONTRACT_ORDER, WORKER_CONTRACT_SECTION, assembleSingularityContext, bindingLines, budgetList, constraintItems, contextRead, contractLines, contractProjection, criteriaLines, src_default as default, diagnosisRecordText, dynamicProjection, evidenceRecordText, handoffFor, handoffLines, handoffReferences, isGraphMember, latestRun, loadCaller, notActivatedLines, omissionLine, questionProjection, read, refused, relatedEntries, renderRunBinding, reviewRecordText, rootAncestor, runPhaseCell, runPhaseSuffix, runRecordText, sliceUtf8, taskRead, taskRecordText, taskStatus, taskSummaryLine, utf8Bytes };