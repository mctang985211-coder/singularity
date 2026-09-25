import { Context, Service } from "@deepseek-ai/cordis";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { SESSION_NOT_IN_GRAPH } from "@dangosys/dsh-singularity-graphs";
import { SESSION_QUERY_READ_WINDOW_MAX, extractSessionEventText } from "@deepseek-ai/dsh-session-query";
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from "@dangosys/dsh-singularity-task-runtime";

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
/** Append the dynamic half to the runtime-context plane; an unchanged name is replaced, never duplicated. */
function withStateContext(assembly, text) {
	const existing = assembly.contexts.find((context) => context.name === STATE_CONTEXT_NAME);
	if (existing !== void 0) {
		existing.text = text;
		return;
	}
	assembly.contexts.push({
		name: STATE_CONTEXT_NAME,
		text
	});
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
			withContractSection(assembly, contract.text);
			withStateContext(assembly, dynamic.text);
			return next();
		}
		case "root": {
			if (resolution.task === void 0) return next();
			const contract = await service.contractProjection(sessionId, context.signal);
			if (!contract.ok) throwRefusal(contract);
			withContractSection(assembly, contract.text);
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
	const base = {
		sessionId,
		graph: facts,
		storeId,
		recovery: await deps.taskRuntime.recoveryStatus(storeId)
	};
	const own = snapshot === void 0 ? void 0 : runOfSessionIn(snapshot, sessionId);
	const task = snapshot === void 0 ? void 0 : taskOfRun(snapshot, own);
	const isRoot = sessionId === String(graph.rootSessionId);
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
* The one output bound this package has (A2 §D): 16 KiB for a single read —
* whether that read is a tool-facing record, the reference lists a projection
* carries, or the outer text of a status page. There is no second budget and no
* configuration surface: one constant, one accounting, so "how much can a read
* put in front of a model" has exactly one answer.
*
* What the bound never does is truncate silently. A record read pages with an
* explicit continuation offset; a core contract that cannot fit is refused by
* name (`context-too-large`) rather than cut; a reference list that does not fit
* says how many entries it did not show.
* @module @dangosys/dsh-singularity-context/limits
*/
/** The outer output bound of one context read, in UTF-8 bytes. */
const CONTEXT_OUTPUT_LIMIT_BYTES = 16 * 1024;
/** UTF-8 byte length of `text`. */
function utf8Bytes(text) {
	return Buffer.byteLength(text, "utf8");
}
/**
* Take at most `maxBytes` bytes starting at `offsetBytes` from `text`, never
* splitting a UTF-8 character.
*
* An offset that lands inside a character starts at the next character (the
* partial bytes belong to a character the caller's page boundary cut, and
* re-emitting a fraction of one would corrupt it). A page always carries at
* least one character: a bound smaller than the first character still advances,
* so a caller that feeds `nextOffset` back never loops on the same offset.
*/
function sliceUtf8(text, offsetBytes, maxBytes) {
	const start = Math.max(0, Math.trunc(offsetBytes));
	const budget = Math.max(0, Math.trunc(maxBytes));
	let position = 0;
	let taken = 0;
	const parts = [];
	for (const character of text) {
		const width = utf8Bytes(character);
		const characterStart = position;
		position += width;
		if (characterStart < start) continue;
		if (taken + width > budget) {
			if (parts.length === 0) return {
				text: character,
				nextOffset: position,
				done: false
			};
			return {
				text: parts.join(""),
				nextOffset: characterStart,
				done: false
			};
		}
		parts.push(character);
		taken += width;
	}
	return {
		text: parts.join(""),
		nextOffset: position,
		done: true
	};
}
/**
* A byte-metered line list: every line either fits whole — the newline included
* — or is refused, so no line a caller sees is a cut one. `remaining` is what a
* caller that wants to bound a *part* of its output (a reference list, say) has
* left to spend.
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
/** The one-word name of an omission a bounded list reports, so a reader can tell a short list from a cut one. */
function omittedLine(noun, omitted, how) {
	return `… ${omitted} more ${noun} not shown (${how})`;
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
* The phase, batch, submission and no-progress facts of one run, appended to a
* run line: where this run sits in the protocol, in that order, with the batch
* id only where a batch exists to name. A phase change and a progress marking
* rewrite these fields, so this is the run's current position, never a history.
*/
function runPhaseSuffix(run) {
	const parts = [];
	if (run.executionPhase !== void 0) {
		parts.push(`phase ${run.executionPhase}`);
		if (run.batchId !== void 0) parts.push(`batch ${run.batchId}`);
		if (run.submission !== void 0) parts.push(submissionClause(run.submission));
	} else if (run.status === "running") parts.push(NEEDS_RECOVERY);
	if (run.noProgress !== void 0) parts.push(`no-progress round ${run.noProgress.rounds} (${run.noProgress.kind})`);
	return parts.length === 0 ? "" : ` — ${parts.join("; ")}`;
}
/** The same fact for a denser line, where only the phase and the old-record marker fit. */
function runPhaseCell(run) {
	if (run.executionPhase !== void 0) return ` — phase ${run.executionPhase}`;
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
		for (const child of criterion.childEvidence ?? []) extras.push(`  child evidence: batch child #${child.childIndex}${child.criterionId === void 0 ? "" : ` criterion ${child.criterionId}`}${child.evidenceRef === void 0 ? "" : ` ref ${child.evidenceRef}`}`);
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
async function runRecordText(taskRuntime, run) {
	const { providerBinding,...record } = run;
	const lines = [
		`run ${run.runId} of task ${run.taskId} [${run.status}]${runPhaseSuffix(run)}`,
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
/** The complete rendering of one diagnosis record. */
function diagnosisRecordText(diagnosis) {
	return [
		`diagnosis ${diagnosis.diagnosisId} of task ${diagnosis.taskId} [confidence ${diagnosis.confidence}]`,
		`observed failure: ${diagnosis.observedFailure}`,
		`localized cause: ${diagnosis.localizedCause}`,
		"",
		...jsonBlock(diagnosis)
	].join("\n");
}
/**
* The one-line identity of one task, in the shape both status reads use: status,
* objective, the latest run with its phase, evidence ids, the most recent review
* outcome with the detail a reader can act on, and the diagnosis count.
*/
function taskSummaryLine(snapshot, task, roles = []) {
	const run = latestRun(snapshot, task);
	const evidence = snapshot.evidence.filter((item) => item.taskId === task.taskId).map((item) => item.evidenceId);
	const review = [...snapshot.reviews].reverse().find((item) => item.taskId === task.taskId);
	const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId).length;
	const runPart = run === void 0 ? "run: none" : `run: ${run.status}${runPhaseCell(run)}`;
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
/** A task-class page never goes below this many bytes; below it a page could not advance usefully. */
const TASK_PAGE_MIN_BYTES = 64;
/** How a caller asks for a record's identity, spelled out in every malformed-ref refusal. */
const REF_SHAPES = {
	task: "the task id",
	run: "the run id",
	evidence: "the evidence id",
	diagnosis: "the diagnosis id",
	review: "`{taskId, runId}` (with `runId: null` for a task that blocked before any run)",
	session: "the session id"
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
/** The caller's own run, as one line: status, phase, and the old-record marker such a run earns. */
function ownRunLine(run) {
	return `run ${run.runId} [${run.status}]${runPhaseSuffix(run)} started ${run.startedAt}`;
}
/**
* One reference list inside the byte bound: entries are shown in store order
* until the budget (which also has to hold the omission marker) runs out, and
* what did not fit is named with its count. Returns `'too-large'` when not even
* the marker fits — a list that cannot say how much it hid is not shown at all.
*/
function referenceList(budget, title, entries, noun, how) {
	if (entries.length === 0) return budget.add(`- ${title}: (none)`) ? void 0 : "too-large";
	const reserve = utf8Bytes(omittedLine(noun, entries.length, how)) + 1;
	if (!budget.add(`- ${title}:`)) return "too-large";
	let shown = 0;
	for (const entry of entries) {
		if (budget.remaining <= reserve) break;
		if (!budget.add(`  ${entry}`)) break;
		shown += 1;
	}
	if (shown === entries.length) return void 0;
	return budget.add(omittedLine(noun, entries.length - shown, how)) ? void 0 : "too-large";
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
	if (decomposable) lines.push("## This task is decomposable", "", "- Do not carry the work to completion yourself: this task was admitted as decomposable.", "- Call `task_decompose` instead, with a `reason` and the child task list; every child needs an acceptance criterion a verifier can judge on its own.", "- Decompose only when RFC §36 atomicity holds — independently verifiable acceptance dimensions, clear artifact boundaries, capabilities that match or gaps you can handle; otherwise do the work here.", "- Once you decompose, the nested verification settles this task; you still never declare completion yourself.");
	if (runtimeSplit) lines.push(...lines.length === 0 ? [] : [""], "## If the work turns out not to be atomic", "", "- Call `task_decompose` yourself: this deployment admits a task's own decomposition, so your parent did not have to predict it. The call still has to clear admission — structure, acyclic dependencies, a command on every executable criterion, capability coverage, depth and batch-size limits — and a task may split only once; a refusal names the rule that blocked it, and that reason is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here.");
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
	if (run?.providerBinding !== void 0) {
		const summary = (await bindingLines(deps.taskRuntime, run.providerBinding)).filter((line) => line.length > 0);
		if (budget.addAll([
			"",
			"## Implementation chosen for this run",
			...summary
		]) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	}
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
			if (referenceList(budget, "relevant artifacts", references.artifacts, "handoff artifact references", "read them by id") !== void 0) return tooLarge("the handoff references", taskPageHint(task.taskId));
			if (referenceList(budget, "relevant evidence", references.evidence, "handoff evidence references", "read them by id") !== void 0) return tooLarge("the handoff references", taskPageHint(task.taskId));
		}
		const decomposition = workerDecompositionLines(deps.taskRuntime, task);
		if (decomposition.length > 0 && budget.addAll(["", ...decomposition]) > 0) return tooLarge("the decomposition guidance", taskPageHint(task.taskId));
	}
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
		const label = `delegated task state (review-only, no business Run): ${run === void 0 ? "no run was ever started" : ownRunLine(run)}`;
		if (!budget.add(label)) return tooLarge("the delegated task state", taskPageHint(task.taskId));
	} else if (!budget.add(`your run: ${resolution.run === void 0 ? "none" : ownRunLine(resolution.run)}`)) return tooLarge("the run line", taskPageHint(task.taskId));
	if (snapshot !== void 0) {
		const lines = relatedEntries(snapshot, task).map((entry) => taskSummaryLine(snapshot, entry.task, entry.roles));
		const reserve = utf8Bytes(omittedLine("related tasks", lines.length, "page through them with the status view")) + 1;
		if (budget.addAll(["", "related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):"]) > 0) return tooLarge("the related tasks heading", taskPageHint(task.taskId));
		let shown = 0;
		for (const line of lines) {
			if (budget.remaining <= reserve) break;
			if (!budget.add(line)) break;
			shown += 1;
		}
		if (shown < lines.length) {
			if (!budget.add(omittedLine("related tasks", lines.length - shown, "page through them with the status view"))) return tooLarge("the related tasks list", taskPageHint(task.taskId));
		}
	}
	return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's dynamic state"));
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
		...run === void 0 ? [] : ["", ownRunLine(run)]
	];
	if (budget.addAll(lines) > 0) return tooLarge("your contract", taskPageHint(task.taskId));
	if (snapshot !== void 0 && resolution.kind === "root") {
		const children = task.childTaskIds.flatMap((taskId) => snapshot.tasks.filter((item) => item.taskId === taskId));
		const childLines = [
			"",
			`children: ${children.length}`,
			...children.map((child) => taskSummaryLine(snapshot, child))
		];
		const omitted = budget.addAll(childLines);
		if (omitted > 0 && !budget.add(omittedLine("child tasks", omitted, "read them with the status view or by reference"))) return tooLarge("the root's children", taskPageHint(task.taskId));
	}
	if (run?.providerBinding !== void 0) {
		const summary = (await bindingLines(deps.taskRuntime, run.providerBinding)).filter((line) => line.length > 0);
		if (budget.addAll(summary) > 0) return tooLarge("the run binding summary", taskPageHint(task.taskId));
	}
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
	const offset = Math.max(0, Math.trunc(requestedOffset));
	const limit = Math.min(STATUS_LIMIT_MAX, Math.max(1, Math.trunc(requestedLimit)));
	const clamped = Math.trunc(requestedLimit) !== limit || truncate(requestedOffset) !== offset;
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
	const footerReserve = utf8Bytes("- more: yes — continue with offset 999999") + 1 + utf8Bytes("- source: ") + 200 + 1 + obligations.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
	let shown = 0;
	for (const entry of page) {
		if (budget.remaining <= footerReserve) break;
		if (!budget.add(taskSummaryLine(snapshot, entry.task, entry.roles))) break;
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
	if (omittedObligations > 0) budget.add(omittedLine("obligation lines", omittedObligations, "the status page reached its output bound"));
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
* `<repoRoot>/.agents/skills/<name>/obligations.yml` against the graph's
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
* the output bound; a session read pages by DSH event seq, its own read unit.
*/
async function contextRead(deps, loaded, query, signal) {
	const resolution = loaded.resolution;
	if (resolution.kind === "unbound") return unboundRead(resolution);
	signal?.throwIfAborted();
	const snapshot = loaded.snapshot;
	const kind = query.kind;
	if (kind === "session") {
		if (typeof query.ref !== "string") return malformedRef(kind, query.ref);
		return await sessionRead(deps, loaded, query.ref, query.offset, query.limit, signal);
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
		if (snapshot.tasks.find((item) => item.taskId === ref.taskId) === void 0) return {
			refusal: "not-found",
			detail: `task "${ref.taskId}" is not in your graph's task store, so the review reference does not resolve inside the caller's domain.`
		};
		const runId = ref.runId ?? null;
		const review = [...snapshot.reviews].reverse().find((item) => item.taskId === ref.taskId && (item.runId ?? null) === runId);
		if (review !== void 0) return {
			identity: `${ref.taskId}#${runId ?? "no-run"}`,
			record: review
		};
		const others = snapshot.reviews.filter((item) => item.taskId === ref.taskId);
		if (others.length === 0) return {
			refusal: "not-found",
			detail: `task "${ref.taskId}" has no review record in this store, so the reference names nothing.`
		};
		return {
			refusal: "stale-reference",
			detail: `task "${ref.taskId}" has review records, but none for run "${runId ?? "(none)"}": this store holds ${others.map((item) => `${item.taskId}#${item.runId ?? "no-run"} (${item.outcome})`).join(", ")}. The reference names a review that does not exist for that run.`
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
	if ("capabilitySnapshot" in record) return await runRecordText(deps.taskRuntime, record);
	if ("evidenceId" in record) return evidenceRecordText(snapshot, record);
	if ("diagnosisId" in record) return diagnosisRecordText(record);
	return reviewRecordText(record);
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
	if (!await isGraphMember(deps.graphs, resolution.graph.id, sessionId)) return refused("cross-graph", `session "${sessionId}" is not a published member of graph "${resolution.graph.id}"; a session reference reads the caller's own domain, and a session id is not a key to another graph.`);
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
	let shown = 0;
	let stopped;
	for (const event of events) {
		const lines = eventLines(event);
		if (!blockFits(budget, lines)) {
			if (shown === 0) return refused("context-too-large", oversizedEventDetail(sessionId, event));
			stopped = event;
			break;
		}
		budget.addAll(lines);
		shown += 1;
	}
	if (stopped !== void 0) budget.add(notShownEventLine(stopped));
	const lastShownSeq = Number(events[shown - 1].seq);
	const nextOffset = stopped === void 0 ? lastShownSeq + 1 : Number(stopped.seq);
	const hasMore = nextOffset <= capturedThroughSeq;
	budget.add(`- events shown: ${shown} of at most ${limit}` + (hasMore ? ` · more follows from seq ${nextOffset}` : " · end of the log"));
	return read(budget.text(), `session ${sessionId} via the session query, seq ${offset}..${lastShownSeq} of a log through seq ${capturedThroughSeq}`, {
		hasMore,
		nextOffset
	});
}
/** Whether every one of `lines` fits the page's remaining space as one block (each separator counted). */
function blockFits(budget, lines) {
	if (lines.length === 0) return true;
	return utf8Bytes(lines.join("\n")) + (budget.bytes === 0 ? 0 : 1) <= budget.remaining;
}
/** The UTF-8 size of the text one event carries. */
function eventTextBytes(event) {
	return utf8Bytes(extractSessionEventText(event));
}
/**
* The refusal of an event no page can carry: a session offset addresses whole
* events (DSH's read unit), so an event larger than the bound has no second
* page. The detail names the event and its size, says none of it is shown, and
* hands the caller the one deliberate way past it.
*/
function oversizedEventDetail(sessionId, event) {
	return `event seq ${event.seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its text alone is ${eventTextBytes(event)} UTF-8 bytes); a session offset addresses whole events — DSH's read unit — so this read cannot page inside one event, and none of that event's text is shown here. To continue past it, ask again with offset ${Number(event.seq) + 1}: the read never skips an event on its own, so that choice is the caller's.`;
}
/** The line a page carries when it stops before an event that does not fit; the caller must choose to move past it. */
function notShownEventLine(event) {
	return `- the next event (seq ${event.seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it.`;
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
export { AssemblyRefusalError, CONTEXT_OUTPUT_LIMIT_BYTES, NAMED_REFUSALS, OutputBudget, ReviewerBindingError, STATE_CONTEXT_NAME, STATE_CONTEXT_ORDER, SingularityContextService, WORKER_CONTRACT_ORDER, WORKER_CONTRACT_SECTION, assembleSingularityContext, bindingLines, constraintItems, contextRead, contractLines, contractProjection, criteriaLines, src_default as default, diagnosisRecordText, dynamicProjection, evidenceRecordText, handoffFor, handoffLines, handoffReferences, isGraphMember, latestRun, loadCaller, notActivatedLines, omittedLine, openRootProposals, read, refused, relatedEntries, renderRunBinding, reviewRecordText, rootAncestor, runPhaseCell, runPhaseSuffix, runRecordText, sliceUtf8, storeStateText, taskRead, taskRecordText, taskStatus, taskSummaryLine, utf8Bytes };