import { Context, Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TOOL_LABELS, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, checkObligationCoverage, findRepoRoot, loadObligationTemplates, workerBaseline } from "@dangosys/dsh-singularity-task-runtime";
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { SessionId } from "@deepseek-ai/dsh-session";

//#region src/hitl.ts
/**
* The canvas answerer on the native interaction seams: root tools ask through
* `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics
* live there), and this service is the answerer that bridges those waterfalls
* onto the pending-card store the canvas UI polls over `GET/POST
* /singularity/hitl` and the `hitl/change` SSE. A card the canvas cannot
* present faithfully (a multi-question batch) is delegated to `next()`, so the
* native NO_PROVIDER / 'unavailable' fail-closed path stays intact.
*
* Both listeners are registered with `prepend`, ahead of every listener
* already on the event. The gateway's mux forwarder (api-remotes) claims
* `approval/request` by position and parks the request until a browser mux
* client answers or delegates; with zero clients attached it never calls
* `next()`, so a later listener never sees the request at all (guide §4.2
* #17). Claiming first makes this service the decision surface either way;
* the native answerer chain below it is untouched.
*/
var HitlService = class extends Service {
	static inject = ["userQuestions", "approval"];
	waiters = /* @__PURE__ */ new Map();
	lifetime = new AbortController();
	constructor(ctx) {
		super(ctx, "hitl");
		ctx.effect(() => () => this.lifetime.abort(/* @__PURE__ */ new Error("hitl: service disposed")), "hitl: waiters");
		ctx.on("user-questions/request", async (request, next) => {
			if (request.questions.length !== 1) return next();
			const question = request.questions[0];
			const text$21 = await this.enqueue(request.agent?.id ?? "unknown", "ask", question.question, request.signal);
			if (text$21.kind !== "ask") throw new Error("hitl: expected ask answer");
			return { answers: [{
				id: question.id,
				selected: [],
				custom: text$21.text
			}] };
		}, { prepend: true });
		ctx.on("approval/request", async (request) => {
			const prompt = request.reason ?? `Approve ${request.toolName}?`;
			const answer = await this.enqueue(request.agent.id, "approve", prompt, request.signal);
			if (answer.kind !== "approve") throw new Error("hitl: expected approve answer");
			return answer.decision === "approve" ? "allowed-once" : "rejected";
		}, { prepend: true });
	}
	list() {
		return [...this.waiters.values()].map((w) => w.pending);
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
	enqueue(sessionId$16, kind, prompt, callerSignal) {
		const signal = callerSignal === void 0 ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (typeof sessionId$16 !== "string" || sessionId$16.length === 0) throw new Error("hitl: missing session id");
		const id = randomUUID();
		const pending = {
			id,
			kind,
			prompt,
			sessionId: sessionId$16,
			createdAt: Date.now()
		};
		const abort = () => {
			this.waiters.get(id).reject(signal.reason);
			this.waiters.delete(id);
			this.ctx.emit("hitl/change", this.list());
		};
		const promise = new Promise((resolve$1, reject) => {
			this.waiters.set(id, {
				pending,
				resolve: resolve$1,
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
//#region src/escalation.ts
const ESCALATION_TRIGGERS = [
	"capability-gap",
	"budget-exhausted",
	"unknown-convergence",
	"human"
];
function nonEmpty$1(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`escalation: ${field} must be a non-empty string`);
	return value;
}
/**
* Payload validation shared by the write path (`raise`) and the fold, so a
* hand-forged ledger line fails load exactly as it would fail append: the kind
* must be known, the id non-empty, the three KISS §7 elements present, the
* trigger one of the four, and the human-approval evidence real.
*/
function assertRaised(record) {
	if (record.kind !== "raised") throw new Error(`escalation: unknown ledger kind "${String(record.kind)}"`);
	nonEmpty$1(record.escalationId, "escalationId");
	nonEmpty$1(record.what, "what");
	nonEmpty$1(record.tried, "tried");
	nonEmpty$1(record.suggested, "suggested");
	if (!ESCALATION_TRIGGERS.includes(record.trigger)) throw new Error(`escalation: unknown trigger "${String(record.trigger)}"`);
	if (!Array.isArray(record.sourceRefs) || record.sourceRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) throw new Error("escalation: sourceRefs must be an array of non-empty strings");
	if (record.sourceTaskId !== void 0) nonEmpty$1(record.sourceTaskId, "sourceTaskId");
	nonEmpty$1(record.approvalRef, "approvalRef");
	nonEmpty$1(record.actor, "actor");
	nonEmpty$1(record.at, "at");
}
/**
* The escalation ledger (plane separation: this store is independent of the
* task store and refers to it by id only). Append and replay share one fold,
* so a corrupt or duplicated line fails loudly instead of silently drifting.
* Writes are serialized; the file is opened per append, so closing the service
* is just draining the write queue.
*/
var EscalationService = class extends Service {
	/** Absolute ledger directory resolved at construction. */
	root;
	/** Repo root that relative paths resolve against. */
	repoRoot;
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "escalation");
		this.repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
		const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, ".dsh");
		this.root = resolve(config.root ?? dshHome);
		this.loaded = this.load();
		ctx.effect(() => async () => {
			await this.writes;
		}, "escalation: drain writes");
	}
	/** Ledger file path (`<root>/escalations.jsonl`). */
	get file() {
		return join(this.root, "escalations.jsonl");
	}
	/**
	* Record one card. The caller (the `escalate` tool) must hold a human grant
	* from `ctx.approval.request` first and pass its call id as `approvalRef`
	* (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled,
	* or unavailable ask must never reach this method. Payload validation runs
	* before anything touches disk.
	*/
	async raise(input, actor, approvalRef) {
		const record = {
			formatVersion: 1,
			kind: "raised",
			escalationId: nonEmpty$1(input.escalationId ?? `esc-${randomUUID()}`, "escalationId"),
			what: nonEmpty$1(input.what, "what"),
			tried: nonEmpty$1(input.tried, "tried"),
			suggested: nonEmpty$1(input.suggested, "suggested"),
			trigger: input.trigger,
			...input.sourceTaskId === void 0 ? {} : { sourceTaskId: nonEmpty$1(input.sourceTaskId, "sourceTaskId") },
			sourceRefs: (input.sourceRefs ?? []).map((ref, index) => nonEmpty$1(ref, `sourceRefs[${index}]`)),
			approvalRef: nonEmpty$1(approvalRef, "approvalRef"),
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (!ESCALATION_TRIGGERS.includes(record.trigger)) throw new Error(`escalation: unknown trigger "${String(input.trigger)}"`);
		await this.append(record);
		return this.get(record.escalationId);
	}
	/** Folded view of one card, or throws on an unknown id. */
	async get(escalationId) {
		await this.loaded;
		const escalation = this.fold(this.records).get(escalationId);
		if (escalation === void 0) throw new Error(`escalation: unknown escalation "${escalationId}"`);
		return escalation;
	}
	/** Folded views, newest card first. */
	async list() {
		await this.loaded;
		return [...this.fold(this.records).values()].reverse();
	}
	/**
	* Fold records into cards, enforcing the payload rules on every step: a
	* `raised` line starts a new id, a repeated id is refused, and every field
	* is re-validated, so an illegal line fails load exactly as it would fail
	* append.
	*/
	fold(records) {
		const escalations = /* @__PURE__ */ new Map();
		for (const record of records) {
			assertRaised(record);
			if (escalations.has(record.escalationId)) throw new Error(`escalation: escalation "${record.escalationId}" already exists`);
			escalations.set(record.escalationId, {
				escalationId: record.escalationId,
				what: record.what,
				tried: record.tried,
				suggested: record.suggested,
				trigger: record.trigger,
				status: "open",
				...record.sourceTaskId === void 0 ? {} : { sourceTaskId: record.sourceTaskId },
				sourceRefs: [...record.sourceRefs],
				approvalRef: record.approvalRef,
				actor: record.actor,
				at: record.at,
				history: [{
					status: "open",
					actor: record.actor,
					at: record.at
				}]
			});
		}
		return escalations;
	}
	async load() {
		let text$21;
		try {
			text$21 = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text$21.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`escalation: corrupt ledger line ${index + 1} in ${this.file}`);
			}
		});
		for (const record of records) if (record.formatVersion !== 1) throw new Error(`escalation: unsupported ledger formatVersion "${String(record.formatVersion)}"`);
		this.records = records;
		this.fold(this.records);
	}
	/** Validate the staged fold first; memory commits only after the line is on disk. */
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			this.fold([...this.records, record]);
			await mkdir(this.root, { recursive: true });
			await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
			this.records = [...this.records, record];
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
	}
};

//#endregion
//#region src/replay.ts
const REPLAY_VERDICTS = [
	"not-worse",
	"worse",
	"inconclusive",
	"manual"
];
const REPLAY_RELATIONS = [
	"not-worse",
	"worse",
	"inconclusive",
	"manual"
];
/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
const OUTCOME_RANK = {
	verified: 1,
	failed: 0
};
/**
* Compare one task's two sides. A regression is mechanical: the candidate's
* outcome ranks below the champion's, or a criterion both sides report flipped
* from pass to anything else. An unrankable candidate outcome (cancelled) is
* inconclusive — it says nothing about the candidate's quality.
*/
function compareReplaySides(champion, candidate) {
	const championCriteria = new Map(champion.criteria.map((item) => [item.criterionId, item.verdict]));
	const candidateCriteria = new Map(candidate.criteria.map((item) => [item.criterionId, item.verdict]));
	const criteriaDiff = [];
	for (const criterionId of new Set([...championCriteria.keys(), ...candidateCriteria.keys()])) {
		const before = championCriteria.get(criterionId);
		const after = candidateCriteria.get(criterionId);
		if (before !== after) criteriaDiff.push({
			criterionId,
			...before === void 0 ? {} : { champion: before },
			...after === void 0 ? {} : { candidate: after }
		});
	}
	const verdictMatch = champion.outcome === candidate.outcome && criteriaDiff.length === 0;
	const championRank = OUTCOME_RANK[champion.outcome];
	const candidateRank = OUTCOME_RANK[candidate.outcome];
	if (candidateRank === void 0 || championRank === void 0) return {
		verdictMatch,
		criteriaDiff,
		relation: "inconclusive"
	};
	const regressedCriterion = criteriaDiff.some((diff) => diff.champion === "pass");
	return {
		verdictMatch,
		criteriaDiff,
		relation: candidateRank < championRank || regressedCriterion ? "worse" : "not-worse"
	};
}
/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
function overallReplayVerdict(comparisons) {
	if (comparisons.some((item) => item.relation === "worse")) return "worse";
	if (comparisons.length === 0 || comparisons.some((item) => item.relation === "inconclusive")) return "inconclusive";
	if (comparisons.every((item) => item.relation === "manual")) return "manual";
	return "not-worse";
}
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertComparison(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: replay report ${field} must be an object`);
	if (typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: replay report ${field}.taskId must be a non-empty string`);
	if (!isRecord$2(value.champion) || typeof value.champion.outcome !== "string") throw new Error(`evolution: replay report ${field}.champion must carry an outcome`);
	if (typeof value.relation !== "string" || !REPLAY_RELATIONS.includes(value.relation)) throw new Error(`evolution: replay report ${field}.relation must be one of ${REPLAY_RELATIONS.join(" / ")}`);
}
/**
* Validate a report against the proposal it claims to serve. The v1 manual
* boundary is enforced here: only an agent_preset replay may record
* `mode: 'manual'` (the preset roster scans constructor-fixed roots and cannot
* mount a sandbox-materialized preset), and only a manual report may carry the
* `manual` verdict — every other targetType must produce executed evidence.
*/
function assertReplayReport(proposal, report) {
	if (!isRecord$2(report)) throw new Error("evolution: replay report must be an object");
	if (report.formatVersion !== 1) throw new Error("evolution: replay report formatVersion must be 1");
	if (report.proposalId !== proposal.proposalId) throw new Error(`evolution: replay report proposalId "${String(report.proposalId)}" does not match "${proposal.proposalId}"`);
	if (report.targetType !== proposal.targetType) throw new Error(`evolution: replay report targetType "${String(report.targetType)}" does not match "${proposal.targetType}"`);
	if (typeof report.at !== "string" || report.at.length === 0) throw new Error("evolution: replay report.at must be a non-empty string");
	if (report.mode !== "executed" && report.mode !== "manual") throw new Error("evolution: replay report mode must be \"executed\" or \"manual\"");
	if (report.mode === "manual") {
		if (proposal.targetType !== "agent_preset") throw new Error(`evolution: a manual replay report is only valid for agent_preset proposals, not "${proposal.targetType}"`);
		if (typeof report.manualReason !== "string" || report.manualReason.length === 0) throw new Error("evolution: a manual replay report requires a manualReason");
	}
	if (typeof report.verdict !== "string" || !REPLAY_VERDICTS.includes(report.verdict)) throw new Error(`evolution: replay report verdict must be one of ${REPLAY_VERDICTS.join(" / ")}`);
	if (report.mode === "manual" && report.verdict !== "manual") throw new Error("evolution: a manual replay report must carry verdict \"manual\"");
	if (report.mode === "executed" && report.verdict === "manual") throw new Error("evolution: an executed replay report cannot carry verdict \"manual\"");
	if (!Array.isArray(report.observed)) throw new Error("evolution: replay report.observed must be an array");
	report.observed.forEach((item, index) => assertComparison(item, `observed[${index}]`));
	if (!isRecord$2(report.holdout) || typeof report.holdout.executed !== "boolean" || !Array.isArray(report.holdout.tasks)) throw new Error("evolution: replay report.holdout must be { executed: boolean, tasks: [] }");
	report.holdout.tasks.forEach((item, index) => assertComparison(item, `holdout.tasks[${index}]`));
	if (report.holdout.executed !== report.holdout.tasks.length > 0) throw new Error("evolution: replay report.holdout.executed must agree with its task list (empty = not run)");
	if (report.mode === "executed" && report.observed.length === 0) throw new Error("evolution: an executed replay report needs at least one observed task comparison");
}

//#endregion
//#region src/config-edit.ts
/** A plain YAML scalar needs no quoting; anything else renders JSON-quoted (valid YAML 1.2 flow). */
function flowScalar(value) {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : JSON.stringify(value);
}
/**
* The row's flow value, keys in the mutation schema's fixed order:
* `{ skills: [verify], preset: bb-verify, mcpServers: [bbdev] }`. Every key of
* `CapabilityConfig` renders, `mcpServers` included — a row that dropped it
* would leave the runtime override granting a server plane the restarted
* process no longer mounts.
*/
function flowEntry(entry) {
	const parts = [];
	if (entry.skills !== void 0) parts.push(`skills: [${entry.skills.map(flowScalar).join(", ")}]`);
	if (entry.tools !== void 0) parts.push(`tools: [${entry.tools.map(flowScalar).join(", ")}]`);
	if (entry.preset !== void 0) parts.push(`preset: ${flowScalar(entry.preset)}`);
	if (entry.permission !== void 0) parts.push(`permission: ${flowScalar(entry.permission)}`);
	if (entry.mcpServers !== void 0) parts.push(`mcpServers: [${entry.mcpServers.map(flowScalar).join(", ")}]`);
	return `{ ${parts.join(", ")} }`;
}
/** The row key as written: a plain scalar when safe, else its JSON-quoted form. */
function keySpelling(name) {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ? name : JSON.stringify(name);
}
/** Does this line open the capabilities row for `name` (`name: {…}` or block-form `name:`)? */
function rowKeyMatch(trimmed, name) {
	for (const spelling of [name, JSON.stringify(name)]) if (trimmed === `${spelling}:` || trimmed.startsWith(`${spelling}: `) || trimmed.startsWith(`${spelling}:\t`)) return true;
	return false;
}
function indentOf(line) {
	return line.length - line.trimStart().length;
}
function isCommentOrBlank(line) {
	const trimmed = line.trim();
	return trimmed === "" || trimmed.startsWith("#");
}
/** The capabilities mapping header: `capabilities:`, `capabilities: {}`, and an optional trailing comment. */
const CAPABILITIES_HEADER = /^\s+capabilities:\s*(\{\s*\})?\s*(#.*)?$/;
/** The trailing `# …` comment of a header line, whitespace-normalized, or `''`. */
function commentSuffix(line) {
	const comment = /\s(#.*)$/.exec(line)?.[1];
	return comment === void 0 ? "" : ` ${comment}`;
}
/**
* Exclusive end of the entry starting at `head`: its own line, the deeper lines
* of a block-form body, and the comment or blank lines that ride with it. A
* comment or blank line indented at or above the mapping-header indent ends the
* entry — it belongs to the header (or to the next sibling), not to this row —
* unless the next content line is still part of this entry's deeper body, which
* keeps a blank line *inside* a block body with the entry.
*/
function entryEnd(lines, head, regionEnd, headerIndent) {
	const indent = indentOf(lines[head]);
	let end = head + 1;
	for (let index = head + 1; index < regionEnd; index += 1) {
		const line = lines[index];
		if (isCommentOrBlank(line)) {
			let after = index + 1;
			while (after < regionEnd && isCommentOrBlank(lines[after])) after += 1;
			if (!(after < regionEnd && indentOf(lines[after]) > indent) && indentOf(line) <= headerIndent) break;
			end = index + 1;
			continue;
		}
		if (indentOf(line) <= indent) break;
		end = index + 1;
	}
	return end;
}
/**
* Locate the capabilities row for `name`, scanning exactly the region
* `editCapabilityRow` edits. Throws — locating nothing — when document 1 has no
* task-runtime entry, more than one (the error names every matching line —
* refusing to guess which one governs), or no capabilities mapping.
*/
function locateCapabilityRow(text$21, name) {
	const eol = text$21.includes("\r\n") ? "\r\n" : "\n";
	const lines = text$21.split(eol);
	const docEnd = lines.findIndex((line) => line.trim() === "---");
	const doc1End = docEnd === -1 ? lines.length : docEnd;
	const itemIndices = [];
	for (let index = 0; index < doc1End; index += 1) if (/^\s*-\s+id:\s*task-runtime\s*$/.test(lines[index])) itemIndices.push(index);
	if (itemIndices.length === 0) throw new Error("config.yml: document 1 has no \"- id: task-runtime\" entry");
	if (itemIndices.length > 1) throw new Error(`config.yml: document 1 has ${itemIndices.length} "- id: task-runtime" entries (lines ${itemIndices.map((index) => index + 1).join(", ")}); refusing to guess — keep exactly one`);
	const itemIndex = itemIndices[0];
	const itemIndent = indentOf(lines[itemIndex]);
	let blockEnd = doc1End;
	for (let index = itemIndex + 1; index < doc1End; index += 1) {
		const line = lines[index];
		if (!isCommentOrBlank(line) && indentOf(line) <= itemIndent) {
			blockEnd = index;
			break;
		}
	}
	let capIndex = -1;
	for (let index = itemIndex + 1; index < blockEnd; index += 1) if (CAPABILITIES_HEADER.test(lines[index])) {
		capIndex = index;
		break;
	}
	if (capIndex === -1) throw new Error("config.yml: the task-runtime entry has no \"capabilities:\" mapping");
	const capIndent = indentOf(lines[capIndex]);
	const capCollapsed = /^\s+capabilities:\s*\{\s*\}/.test(lines[capIndex]);
	let regionEnd = blockEnd;
	for (let index = capIndex + 1; index < blockEnd; index += 1) {
		const line = lines[index];
		if (!isCommentOrBlank(line) && indentOf(line) <= capIndent) {
			regionEnd = index;
			break;
		}
	}
	let rowStart = -1;
	let rowSpan = 0;
	let lastEntryEnd = -1;
	let entryIndent = capIndent + 2;
	for (let index = capIndex + 1; index < regionEnd; index += 1) {
		const line = lines[index];
		if (isCommentOrBlank(line) || index < lastEntryEnd) continue;
		lastEntryEnd = entryEnd(lines, index, regionEnd, capIndent);
		entryIndent = indentOf(line);
		if (rowStart === -1 && rowKeyMatch(line.trimStart(), name)) {
			rowStart = index;
			rowSpan = lastEntryEnd - index;
		}
	}
	let insertAt = lastEntryEnd;
	if (insertAt === -1) {
		insertAt = capIndex + 1;
		while (insertAt < regionEnd && isCommentOrBlank(lines[insertAt])) insertAt += 1;
	}
	return {
		lines,
		eol,
		capIndex,
		capIndent,
		capCollapsed,
		regionEnd,
		rowStart,
		rowSpan,
		insertAt,
		entryIndent
	};
}
/**
* The row's verbatim source lines (`\n`-joined, block-form body and riding
* comments included), or null when no row for `name` exists. The rollback
* anchor of a capability prepare (W19, guide §4.2 #18): restoring these lines
* beats re-rendering the registry entry, whose schema fills default arrays the
* source text never spelled out.
*/
function readCapabilityRowSource(text$21, name) {
	const located = locateCapabilityRow(text$21, name);
	if (located.rowStart === -1) return null;
	return located.lines.slice(located.rowStart, located.rowStart + located.rowSpan).join("\n");
}
/**
* Splice `source` (the `\n`-joined lines `readCapabilityRowSource` captured at
* prepare time) back over the current row for `name`, byte-for-byte; when the
* row is gone, insert the lines where a new row would go. Every other byte of
* the file is preserved, exactly as with `editCapabilityRow`.
*/
function restoreCapabilityRowSource(text$21, name, source) {
	const { lines, eol, capIndex, capIndent, capCollapsed, rowStart, rowSpan, insertAt } = locateCapabilityRow(text$21, name);
	const sourceLines = source.replace(/\r?\n$/, "").split("\n");
	if (rowStart !== -1) {
		lines.splice(rowStart, rowSpan, ...sourceLines);
		return {
			text: lines.join(eol),
			action: "replaced"
		};
	}
	if (capCollapsed) lines[capIndex] = `${" ".repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex])}`;
	lines.splice(insertAt, 0, ...sourceLines);
	return {
		text: lines.join(eol),
		action: "added"
	};
}
/**
* Replace (`entry` given, row exists), add (`entry` given, row absent), or
* remove (`entry` null) the capabilities row for `name`. The row is one line in
* flow form (`name: { … }`) or a block-form span (`name:` plus deeper-indented
* lines and the comment lines that ride with it); a replacement always lands as
* one flow line at the row's indent, an addition after the last existing row's
* whole span. Removing the final row collapses the mapping header to
* `capabilities: {}` so the document still parses as a mapping, and adding to a
* collapsed header reopens it — `capabilities: {}` cannot take block rows below
* it. Throws — editing nothing — when document 1 has no task-runtime entry, more
* than one (the error names every matching line — refusing to guess which one
* governs), no capabilities mapping, or a removal names no existing row.
*/
function editCapabilityRow(text$21, name, entry) {
	const { lines, eol, capIndex, capIndent, capCollapsed, regionEnd, rowStart, rowSpan, insertAt, entryIndent } = locateCapabilityRow(text$21, name);
	const rowLine = `${" ".repeat(rowStart === -1 ? entryIndent : indentOf(lines[rowStart]))}${keySpelling(name)}: ${flowEntry(entry ?? {})}`;
	if (entry !== null && rowStart !== -1) {
		lines.splice(rowStart, rowSpan, rowLine);
		return {
			text: lines.join(eol),
			action: "replaced"
		};
	}
	if (entry !== null) {
		if (capCollapsed) lines[capIndex] = `${" ".repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex])}`;
		lines.splice(insertAt, 0, rowLine);
		return {
			text: lines.join(eol),
			action: "added"
		};
	}
	if (rowStart === -1) throw new Error(`config.yml: no capabilities row for "${name}" to remove`);
	lines.splice(rowStart, rowSpan);
	if (!lines.slice(capIndex + 1, regionEnd - rowSpan).some((line) => !isCommentOrBlank(line))) lines[capIndex] = `${" ".repeat(capIndent)}capabilities: {}`;
	return {
		text: lines.join(eol),
		action: "removed"
	};
}

//#endregion
//#region src/evolution.ts
const EVOLUTION_LEVELS = [
	"L1",
	"L2",
	"L3",
	"L4"
];
const EVOLUTION_DECISIONS = [
	"PROMOTE",
	"REJECT",
	"KEEP_FOR_FURTHER_RESEARCH"
];
/**
* The four target types whose mutations this version materializes mechanically
* into the sandbox. Mutations on the other five target types (tool /
* decomposition_policy / workflow_policy / verifier / runtime_policy) are
* free-form structured descriptions, recorded with `mechanical: false` —
* bookkeeping only, never materialized.
*/
const MECHANICAL_TARGET_TYPES = [
	"skill",
	"agent_preset",
	"capability",
	"task_definition"
];
/** True for the target types whose mutations materialize mechanically into the sandbox. */
function mutationMechanical(targetType) {
	return MECHANICAL_TARGET_TYPES.includes(targetType);
}
/**
* The three target types `evolution_apply` promotes mechanically (W16): the
* sandbox copy lands on a real production root. task_definition stays manual
* (the task store keeps no definitions registry — W14's fidelity cap), and the
* five bookkeeping-only types never materialized anything to apply.
*/
const APPLYABLE_TARGET_TYPES = [
	"skill",
	"agent_preset",
	"capability"
];
/**
* Whether a decided proposal may record `applied`: the decision is PROMOTE,
* the level is not L4 (L4 harness evolution is human-run by rule, §2.7.7 /
* §2.9.2), the target type is one of the three applyable mechanical ones, and
* a sandbox was actually materialized (a mutation-less manual candidate has
* nothing to copy).
*/
function applyable(proposal) {
	return proposal.decision === "PROMOTE" && proposal.level !== "L4" && APPLYABLE_TARGET_TYPES.includes(proposal.targetType) && proposal.prepared?.sandbox != null;
}
const CHAMPION_STATES = [
	"captured",
	"missing",
	"none"
];
const CHAMPION_SOURCES = [
	"config-text",
	"code-default",
	"missing"
];
function nonEmpty(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: ${field} must be a non-empty string`);
	return value;
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertOnlyKeys(value, allowed, field) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`evolution: ${field} has unknown key "${key}"`);
}
/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function assertSegment(value, field) {
	const text$21 = nonEmpty(value, field);
	if (text$21 === "." || text$21 === ".." || text$21.includes("/") || text$21.includes("\\") || isAbsolute(text$21)) throw new Error(`evolution: ${field} must be a single safe path segment, got "${text$21}"`);
	return text$21;
}
/** A clean relative path: never absolute (posix or drive-letter), no `\`, no empty / `.` / `..` segments. */
function assertSandboxPath(value, field) {
	const text$21 = nonEmpty(value, field);
	if (isAbsolute(text$21) || /^[A-Za-z]:[\\/]/.test(text$21) || text$21.includes("\\") || text$21.includes("\0")) throw new Error(`evolution: ${field} must be a relative path inside the sandbox, got "${text$21}"`);
	if (text$21.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`evolution: ${field} must be a clean relative path (no empty / "." / ".." segments), got "${text$21}"`);
	return text$21;
}
/** Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt. */
function resolveWithin(base, rel) {
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(`${base}${sep}`)) throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`);
	return abs;
}
/**
* Validate a candidate's mutation against the proposal's targetType. The four
* mechanical types have fixed schemas and every path field is checked to stay
* inside the sandbox; the five other types take any structured object and are
* bookkeeping-only (mechanical: false).
*/
function validateMutation(targetType, mutation, baseVersion) {
	if (!isRecord$1(mutation)) throw new Error("evolution: mutation must be an object");
	switch (targetType) {
		case "skill":
			assertOnlyKeys(mutation, ["name", "content"], "skill mutation");
			assertSegment(mutation.name, "mutation.name");
			nonEmpty(mutation.content, "mutation.content");
			return;
		case "agent_preset":
			assertOnlyKeys(mutation, ["presetId", "files"], "agent_preset mutation");
			assertSegment(mutation.presetId, "mutation.presetId");
			if (!Array.isArray(mutation.files) || mutation.files.length === 0) throw new Error("evolution: mutation.files must be a non-empty array of { path, content }");
			mutation.files.forEach((file, index) => {
				if (!isRecord$1(file)) throw new Error(`evolution: mutation.files[${index}] must be an object`);
				assertOnlyKeys(file, ["path", "content"], `mutation.files[${index}]`);
				assertSandboxPath(file.path, `mutation.files[${index}].path`);
				nonEmpty(file.content, `mutation.files[${index}].content`);
			});
			return;
		case "capability":
			assertOnlyKeys(mutation, ["name", "entry"], "capability mutation");
			nonEmpty(mutation.name, "mutation.name");
			if (!isRecord$1(mutation.entry)) throw new Error("evolution: mutation.entry must be an object");
			assertOnlyKeys(mutation.entry, [
				"skills",
				"tools",
				"preset",
				"permission",
				"mcpServers"
			], "mutation.entry");
			if (Object.keys(mutation.entry).length === 0) throw new Error("evolution: mutation.entry must grant at least one of skills / tools / preset / permission / mcpServers");
			for (const list of [
				"skills",
				"tools",
				"mcpServers"
			]) {
				const value = mutation.entry[list];
				if (value === void 0) continue;
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`evolution: mutation.entry.${list} must be an array of non-empty strings`);
			}
			for (const scalar of ["preset", "permission"]) if (mutation.entry[scalar] !== void 0) nonEmpty(mutation.entry[scalar], `mutation.entry.${scalar}`);
			return;
		case "task_definition": {
			assertOnlyKeys(mutation, ["baseVersion", "definition"], "task_definition mutation");
			const base = nonEmpty(mutation.baseVersion, "mutation.baseVersion");
			if (base !== baseVersion) throw new Error(`evolution: mutation.baseVersion "${base}" must equal the proposal's baseVersion "${baseVersion}"`);
			if (!isRecord$1(mutation.definition) || Object.keys(mutation.definition).length === 0) throw new Error("evolution: mutation.definition must be a non-empty object (the new version's definition fields)");
			return;
		}
		default: return;
	}
}
/**
* Candidate versionSet payload validation, shared by the write path
* (`candidate`) and the fold: a hand-forged ledger line must fail the same
* checks a live append does.
*/
function validateVersionSet(versionSet) {
	if (!isRecord$1(versionSet)) throw new Error("evolution: versionSet must be an object");
	const entries = Object.entries(versionSet);
	if (entries.length === 0) throw new Error("evolution: versionSet must record at least one version");
	for (const [key, value] of entries) {
		nonEmpty(key, "versionSet key");
		if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: versionSet["${key}"] must be a non-empty string`);
	}
}
/**
* Gate-answers payload validation, shared by the write path (`gate`) and the
* fold: all six answers non-empty, at least one regression evidence ref, every
* ref a non-empty string. Evidence existence (disk path / caller-resolved id /
* the replay report still sitting in the sandbox) stays write-path-only — the
* fold never touches disk, so a ledger stays replayable after evidence files
* rotate away.
*/
function validateGateAnswers(answers) {
	if (!isRecord$1(answers)) throw new Error("evolution: gate answers must be an object");
	nonEmpty(answers.targetFailureFixed, "gate answer \"1. Target failure fixed?\"");
	nonEmpty(answers.originalAcceptanceMaintained, "gate answer \"2. Original acceptance maintained?\"");
	nonEmpty(answers.existingRegressionMaintained, "gate answer \"3. Existing regression maintained?\"");
	nonEmpty(answers.noUnacceptableSideEffects, "gate answer \"4. No unacceptable side effects?\"");
	nonEmpty(answers.holdoutPerformanceAcceptable, "gate answer \"5. Holdout performance acceptable?\"");
	nonEmpty(answers.resourceCostAcceptable, "gate answer \"6. Resource cost acceptable?\"");
	if (!Array.isArray(answers.regressionEvidenceRefs) || answers.regressionEvidenceRefs.length === 0) throw new Error("evolution: the regression/replay answer must cite at least one evidence ref");
	for (const ref of answers.regressionEvidenceRefs) nonEmpty(ref, "regression evidence ref");
}
/**
* The state machine, data-dependent at candidate: a candidate carrying a
* mutation must be prepared (sandbox materialization) before anything else; a
* mutation-less (manual) candidate gates directly — the pre-mutation shape old
* ledgers replay against. A prepared MECHANICAL mutation must then be replayed
* (candidate vs champion over this graph's historical terminal tasks) before it
* can gate; a bookkeeping-only (non-mechanical) one has nothing to replay and
* gates from prepared. After the human decision, only a PROMOTE on an
* applyable, materialized, sub-L4 mutation can be applied (W16), and only an
* applied proposal can be rolled back.
*/
function nextStates(proposal) {
	switch (proposal.status) {
		case "proposed": return ["candidate"];
		case "candidate": return proposal.mutation === void 0 ? ["gated"] : ["prepared"];
		case "prepared": return mutationMechanical(proposal.targetType) ? ["replayed"] : ["gated"];
		case "replayed": return ["gated"];
		case "gated": return ["decided"];
		case "decided": return applyable(proposal) ? ["applied"] : [];
		case "applied": return ["rolledback"];
		case "rolledback": return [];
	}
}
/** The one transition check shared by live appends and replay, so an illegal migration reads identically in both. */
function assertTransition(current, kind) {
	if (nextStates(current).includes(kind)) return;
	const hint = current.status === "candidate" && current.mutation !== void 0 && kind === "gated" ? " — this candidate carries a mutation; record \"prepared\" first (evolution_prepare)" : current.status === "prepared" && mutationMechanical(current.targetType) && kind === "gated" ? " — this mutation was materialized; record \"replayed\" first (evolution_replay)" : current.status === "decided" && kind === "applied" ? current.decision !== "PROMOTE" ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied` : " — only a materialized skill / agent_preset / capability mutation at L1–L3 applies; anything else stays a manual human edit" : "";
	throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`);
}
/**
* The capability patch file: a YAML header recording the whole-row replacement
* semantics, then the entry as one JSON object line (JSON is valid YAML 1.2, so
* the artifact stays parseable without a YAML dependency).
*/
function capabilityPatchYaml(proposalId, name, entry) {
	return [
		`# Evolution capability patch — proposal ${proposalId}, capability "${name}"`,
		"# Apply semantics: whole-row replacement — this entry replaces the row for this name",
		"# under `capabilities:` in config.yml doc 1's task-runtime line verbatim (no deep merge).",
		"# Sandbox artifact only: nothing applies it automatically; a human edit of production",
		"# is the only way it takes effect.",
		JSON.stringify({ [name]: entry }),
		""
	].join("\n");
}
/**
* Champion twin of the patch file: the entry currently in effect, same whole-row
* semantics. Comparison anchor and runtime-override payload; the rollback text
* anchor is the source-text snapshot (`capability-table.source.txt`) when the
* row lives in config.yml (W19).
*/
function championEntryYaml(name, entry) {
	return [
		`# Champion snapshot — capability "${name}" as in effect at prepare time`,
		"# (task-runtime capability registry). Anchor for candidate-vs-champion diff and",
		"# rollback; whole-row replacement semantics, same as the patch file.",
		JSON.stringify({ [name]: entry }),
		""
	].join("\n");
}
/** Read back the champion capability snapshot: the single JSON line under the `#` header, keyed by the capability name. */
function parseChampionEntry(text$21, name) {
	const line = text$21.split("\n").map((item) => item.trim()).filter((item) => item.length > 0 && !item.startsWith("#")).at(-1);
	if (line === void 0) throw new Error("evolution: the champion capability snapshot carries no entry line");
	const parsed = JSON.parse(line);
	if (!isRecord$1(parsed) || !(name in parsed) || !isRecord$1(parsed[name])) throw new Error(`evolution: the champion capability snapshot does not hold an entry for "${name}"`);
	return parsed[name];
}
/**
* The production write targets of an apply (and its matching rollback), for
* the approval reason and the audit record — the human sees exactly what a
* grant will touch.
*/
function applyTargets(proposal, roots) {
	const mutation = proposal.mutation;
	switch (proposal.targetType) {
		case "skill": return [join(roots.skillRoot, mutation.name, "SKILL.md")];
		case "agent_preset": return [join(roots.presetRoot, mutation.presetId)];
		case "capability": return [`${roots.configFile} — document 1 task-runtime capabilities row "${mutation.name}"`];
		default: return [];
	}
}
/** All files under `dir` as `/`-joined relative paths, sorted for a deterministic ledger record. */
async function listFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory()) for (const nested of await listFiles(join(dir, entry.name))) files.push(`${entry.name}/${nested}`);
	else files.push(entry.name);
	return files;
}
/**
* The Evolution plane ledger (plane separation: this store is independent of
* the task store and refers to it by id only). Replay and append share one
* fold, so a corrupt or out-of-order log fails loudly instead of silently
* drifting. Writes are serialized; the file is opened per append, so closing
* the service is just draining the write queue. Sandbox materialization is the
* only other write, confined to `<root>/sandbox/<proposalId>/`.
*/
var EvolutionService = class extends Service {
	/** Absolute ledger directory resolved at construction. */
	root;
	/** Production skill root — champion snapshots read from here; apply/rollback write here. */
	skillRoot;
	/** Production agent-preset root — champion snapshots read from here; apply/rollback write here. */
	presetRoot;
	/** Production config.yml a capability apply/rollback edits. */
	configFile;
	/** Repo root that relative evidence paths resolve against. */
	repoRoot;
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
		const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, ".dsh");
		this.root = resolve(config.root ?? join(dshHome, "evolution"));
		this.skillRoot = resolve(config.skillRoot ?? join(dshHome, "skills"));
		this.presetRoot = resolve(config.presetRoot ?? join(dshHome, ".agent-presets"));
		this.configFile = resolve(config.configFile ?? join(this.repoRoot, "config.yml"));
		this.loaded = this.load();
		ctx.effect(() => async () => {
			await this.writes;
		}, "evolution: drain writes");
	}
	/** Ledger file path (`<root>/proposals.jsonl`). */
	get file() {
		return join(this.root, "proposals.jsonl");
	}
	async propose(input, actor) {
		const record = {
			formatVersion: 1,
			kind: "proposed",
			proposalId: nonEmpty(input.proposalId, "proposalId"),
			targetType: input.targetType,
			targetId: nonEmpty(input.targetId, "targetId"),
			baseVersion: nonEmpty(input.baseVersion, "baseVersion"),
			level: input.level,
			rationale: nonEmpty(input.rationale, "rationale"),
			sourceRefs: input.sourceRefs,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (!EVOLUTION_LEVELS.includes(record.level)) throw new Error(`evolution: unknown level "${String(input.level)}"`);
		if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) throw new Error("evolution: sourceRefs must name at least one source (diagnosisId / reviewRef / evidenceId)");
		input.sourceRefs.forEach((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`));
		await this.append(record);
		return this.get(record.proposalId);
	}
	/**
	* Move proposed → candidate, recording the complete version set the candidate
	* aligns to. `mutation` is the optional structured patch description, shaped
	* and checked against the proposal's targetType; a candidate carrying one
	* must be prepared before it can gate.
	*/
	async candidate(proposalId, versionSet, actor, mutation) {
		const current = await this.assertNext(proposalId, "candidate");
		validateVersionSet(versionSet);
		if (mutation !== void 0) validateMutation(current.targetType, mutation, current.baseVersion);
		await this.append({
			formatVersion: 1,
			kind: "candidate",
			proposalId,
			versionSet: { ...versionSet },
			...mutation === void 0 ? {} : { mutation: structuredClone(mutation) },
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → prepared: materialize a mechanical mutation into
	* `<root>/sandbox/<proposalId>/` and snapshot the champion (the current
	* production target) under `champion/` — the anchor for candidate-vs-champion
	* comparison and rollback. A production target that does not exist yet
	* records `champion: 'missing'` (champion: null). Non-mechanical mutations
	* materialize nothing and record `mechanical: false`. Materialization runs
	* before the ledger append; every write is confined to the sandbox dir.
	*/
	async prepare(proposalId, actor, champion = {}) {
		const current = await this.assertNext(proposalId, "prepared");
		const mutation = current.mutation;
		if (mutation === void 0) throw new Error(`evolution: proposal "${proposalId}" carries no mutation; nothing to prepare`);
		validateMutation(current.targetType, mutation, current.baseVersion);
		const mechanical = mutationMechanical(current.targetType);
		let sandbox = null;
		let championState = "none";
		let championSource;
		let files = [];
		if (mechanical) {
			if (current.targetType === "capability" && !("capabilityEntry" in champion)) throw new Error("evolution: preparing a capability mutation requires champion.capabilityEntry (pass null when the capability is new)");
			if (current.targetType === "task_definition" && !("taskDefinition" in champion)) throw new Error("evolution: preparing a task_definition mutation requires champion.taskDefinition (pass null when the base definition is unresolvable)");
			assertSegment(proposalId, "proposalId");
			const dir = join(this.root, "sandbox", proposalId);
			const written = await this.materialize(dir, current, mutation, champion);
			sandbox = `sandbox/${proposalId}`;
			championState = written.champion;
			championSource = written.championSource;
			files = written.files;
		}
		await this.append({
			formatVersion: 1,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical,
			champion: championState,
			...championSource === void 0 ? {} : { championSource },
			files,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move prepared → replayed: record the outcome of the candidate-vs-champion
	* replay (the `evolution_replay` tool ran it) and write the comparison report
	* to `<sandbox>/replay-report.json`. Only a prepared mechanical mutation can
	* be replayed; the report is validated against the proposal (manual mode is
	* the agent_preset v1 boundary — the preset roster cannot mount
	* sandbox-materialized presets — and every other targetType must carry
	* executed evidence). The report write is confined to the sandbox; the ledger
	* record cites it by root-relative path, and the gate later requires that
	* path in its regression evidence.
	*/
	async replay(proposalId, actor, report) {
		const current = await this.assertNext(proposalId, "replayed");
		assertReplayReport(current, report);
		const sandbox = current.prepared?.sandbox;
		if (sandbox === void 0 || sandbox === null) throw new Error(`evolution: proposal "${proposalId}" names no sandbox; cannot place the replay report`);
		const rel = `${sandbox}/replay-report.json`;
		const abs = resolveWithin(this.root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		await this.append({
			formatVersion: 1,
			kind: "replayed",
			proposalId,
			report: rel,
			verdict: report.verdict,
			tasks: [...report.observed.map((item) => ({
				taskId: item.taskId,
				relation: item.relation,
				holdout: false
			})), ...report.holdout.tasks.map((item) => ({
				taskId: item.taskId,
				relation: item.relation,
				holdout: true
			}))],
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → gated (manual candidates), prepared → gated
	* (bookkeeping-only mutations), or replayed → gated (mechanical mutations):
	* all six Gate answers plus regression evidence refs. Every ref must exist —
	* a path on disk (relative to the repo root or absolute) or an id the
	* caller-side resolver knows (task-store evidence). Existence only; nothing
	* here executes anything. A replayed proposal must additionally cite its
	* replay report path, and that report must still exist in the sandbox.
	*/
	async gate(proposalId, answers, actor, refKnown) {
		const current = await this.assertNext(proposalId, "gated");
		validateGateAnswers(answers);
		if (current.replayed !== void 0) {
			const report = current.replayed.report;
			if (!answers.regressionEvidenceRefs.includes(report)) throw new Error(`evolution: a replayed candidate's regression evidence must cite the replay report "${report}"`);
			if (!existsSync(resolveWithin(this.root, report))) throw new Error(`evolution: the replay report "${report}" no longer exists under the ledger root`);
		}
		for (const ref of answers.regressionEvidenceRefs) {
			if (current.replayed !== void 0 && ref === current.replayed.report) continue;
			if (!(this.refExistsOnDisk(ref) || refKnown !== void 0 && await refKnown(ref))) throw new Error(`evolution: regression evidence ref "${ref}" matches no known evidence id and no existing path`);
		}
		await this.append({
			formatVersion: 1,
			kind: "gated",
			proposalId,
			gate: {
				...answers,
				regressionEvidenceRefs: [...answers.regressionEvidenceRefs]
			},
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move gated → decided. Callers (the evolution_decide tool) must have a
	* human grant from `ctx.approval.request` before calling this and pass its
	* call id as `approvalRef` (`approval:<callId>`, the applied/rolledback
	* shape) — the service only records, and the ref makes the human review
	* auditable from the ledger alone. A rejected or cancelled ask must never
	* reach this method.
	*/
	async decide(proposalId, decision, actor, approvalRef, note) {
		await this.assertNext(proposalId, "decided");
		if (!EVOLUTION_DECISIONS.includes(decision)) throw new Error(`evolution: decision must be one of ${EVOLUTION_DECISIONS.join(" / ")}`);
		nonEmpty(approvalRef, "approvalRef");
		if (note !== void 0) nonEmpty(note, "note");
		await this.append({
			formatVersion: 1,
			kind: "decided",
			proposalId,
			decision,
			approvalRef,
			...note === void 0 ? {} : { note },
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move decided → applied: copy the sandbox materialization into production
	* (W16). Reachable only for a PROMOTE decision on a materialized skill /
	* agent_preset / capability mutation at L1–L3 (the state machine itself
	* refuses anything else); the caller (the evolution_apply tool) must hold a
	* human grant from `ctx.approval.request` first, exactly as for decide.
	* Production writes run BEFORE the ledger append, so a failed write leaves
	* the proposal decided and retryable. skill: the sandbox SKILL.md replaces
	* the production one (the champion snapshot covers that file only, so the
	* write is file-level, never a directory delete). agent_preset: whole-dir
	* replacement (the champion snapshot is the full directory). capability:
	* text-level surgery on the one capabilities row in config.yml document 1 —
	* the runtime registry is NOT hot-reloaded by that edit; the tool mirrors
	* the row into the running TaskRuntime afterwards.
	*/
	async apply(proposalId, actor, approvalRef) {
		const current = await this.assertNext(proposalId, "applied");
		nonEmpty(approvalRef, "approvalRef");
		const outcome = await this.writeProduction(current, "apply");
		await this.append({
			formatVersion: 1,
			kind: "applied",
			proposalId,
			targets: outcome.targets,
			approvalRef,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			...outcome,
			proposal: await this.get(proposalId)
		};
	}
	/**
	* Move applied → rolledback: undo the apply. Champion captured → restore the
	* snapshot (skill SKILL.md written back, preset directory replaced,
	* capability row restored — verbatim from `champion/capability-table.source.txt`
	* for a `config-text` champion (W19), row removed for a `code-default`
	* champion so the code default governs again, registry-form restore from
	* `champion/capability-table.entry.yml` for pre-W19 records);
	* champion missing → delete what the apply created (production skill/preset
	* dir removed, capability row dropped). Same approval discipline as apply:
	* the tool asks a human first, the service only executes and records.
	*/
	async rollback(proposalId, actor, approvalRef) {
		const current = await this.assertNext(proposalId, "rolledback");
		nonEmpty(approvalRef, "approvalRef");
		const outcome = await this.writeProduction(current, "rollback");
		await this.append({
			formatVersion: 1,
			kind: "rolledback",
			proposalId,
			targets: outcome.targets,
			approvalRef,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			...outcome,
			proposal: await this.get(proposalId)
		};
	}
	/**
	* The production write behind apply/rollback. The write side is picked by
	* `direction`; every path goes through `resolveWithin`, so a write can never
	* leave the production root it targets.
	*/
	async writeProduction(proposal, direction) {
		const sandbox = proposal.prepared?.sandbox;
		const champion = proposal.prepared?.champion;
		if (sandbox == null || champion === void 0 || proposal.mutation === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
		switch (proposal.targetType) {
			case "skill": {
				const { name } = proposal.mutation;
				const dst = resolveWithin(this.skillRoot, join(name, "SKILL.md"));
				if (direction === "rollback" && champion === "missing") {
					await rm(resolveWithin(this.skillRoot, name), {
						recursive: true,
						force: true
					});
					return { targets: [`${resolveWithin(this.skillRoot, name)} (deleted — the apply had created it)`] };
				}
				const content = await readFile(resolveWithin(this.root, direction === "apply" ? `${sandbox}/skills/${name}/SKILL.md` : `${sandbox}/champion/skills/${name}/SKILL.md`), "utf8");
				await mkdir(dirname(dst), { recursive: true });
				await writeFile(dst, content, "utf8");
				return { targets: [dst] };
			}
			case "agent_preset": {
				const { presetId } = proposal.mutation;
				const dst = resolveWithin(this.presetRoot, presetId);
				if (direction === "rollback" && champion === "missing") {
					await rm(dst, {
						recursive: true,
						force: true
					});
					return { targets: [`${dst} (deleted — the apply had created it)`] };
				}
				const src = resolveWithin(this.root, direction === "apply" ? `${sandbox}/.agent-presets/${presetId}` : `${sandbox}/champion/.agent-presets/${presetId}`);
				await rm(dst, {
					recursive: true,
					force: true
				});
				await mkdir(dirname(dst), { recursive: true });
				await cp(src, dst, { recursive: true });
				return { targets: [dst] };
			}
			case "capability": {
				const { name, entry } = proposal.mutation;
				const text$21 = await readFile(this.configFile, "utf8");
				let row;
				let edited;
				if (direction === "apply") {
					row = entry;
					edited = editCapabilityRow(text$21, name, row);
				} else if (champion === "missing") {
					row = null;
					edited = editCapabilityRow(text$21, name, null);
				} else if (proposal.prepared?.championSource === "config-text") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = restoreCapabilityRowSource(text$21, name, await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.source.txt`), "utf8"));
				} else if (proposal.prepared?.championSource === "code-default") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text$21, name, null);
				} else {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text$21, name, row);
				}
				await writeFile(this.configFile, edited.text, "utf8");
				return {
					targets: [`${this.configFile} — document 1 task-runtime capabilities row "${name}" (${edited.action})`],
					capability: {
						name,
						entry: row === null ? null : structuredClone(row)
					}
				};
			}
			default: throw new Error(`evolution: targetType "${proposal.targetType}" never applies mechanically`);
		}
	}
	/** Folded view of one proposal, or throws on an unknown id. */
	async get(proposalId) {
		await this.loaded;
		const proposal = this.fold(this.records).get(proposalId);
		if (proposal === void 0) throw new Error(`evolution: unknown proposal "${proposalId}"`);
		return proposal;
	}
	/** Folded views, newest proposal first, optionally filtered. */
	async list(filter = {}) {
		await this.loaded;
		return [...this.fold(this.records).values()].reverse().filter((proposal) => (filter.status === void 0 || proposal.status === filter.status) && (filter.targetType === void 0 || proposal.targetType === filter.targetType) && (filter.targetId === void 0 || proposal.targetId === filter.targetId));
	}
	refExistsOnDisk(ref) {
		return existsSync(isAbsolute(ref) ? ref : resolve(this.repoRoot, ref));
	}
	/**
	* The verbatim source lines of the capability's row in the production
	* config.yml (W19), or null when the file or the row is absent — the latter
	* meaning the capability comes from the code default table. A config.yml
	* without a task-runtime capabilities mapping fails loudly, exactly as an
	* apply would.
	*/
	async capabilityRowSource(name) {
		let text$21;
		try {
			text$21 = await readFile(this.configFile, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		return readCapabilityRowSource(text$21, name);
	}
	/**
	* Early state-machine check so a wrong-state call reports the transition
	* error before any payload validation; `append` re-checks under the write
	* lock, which is the authoritative gate. Returns the folded proposal so
	* callers can validate payloads against targetType / baseVersion / mutation.
	*/
	async assertNext(proposalId, kind) {
		await this.loaded;
		const current = this.fold(this.records).get(proposalId);
		if (current === void 0) throw new Error(`evolution: unknown proposal "${proposalId}"`);
		assertTransition(current, kind);
		return current;
	}
	/**
	* Write one mechanical mutation into the sandbox dir `dir`, then the champion
	* snapshot. Every path goes through `resolveWithin`, so a write can never
	* land outside the sandbox; production roots are read-only here. Capability
	* champions carry a `championSource` (W19): the rollback anchor is the
	* config.yml row's verbatim source text when the row exists there.
	*/
	async materialize(dir, proposal, mutation, champion) {
		const files = [];
		const write = async (rel, content) => {
			const abs = resolveWithin(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content, "utf8");
			files.push(rel);
		};
		switch (proposal.targetType) {
			case "skill": {
				const { name, content } = mutation;
				await write(`skills/${name}/SKILL.md`, content);
				const championFile = join(this.skillRoot, name, "SKILL.md");
				if (!existsSync(championFile)) return {
					files,
					champion: "missing"
				};
				await write(`champion/skills/${name}/SKILL.md`, await readFile(championFile, "utf8"));
				return {
					files,
					champion: "captured"
				};
			}
			case "agent_preset": {
				const { presetId, files: presetFiles } = mutation;
				for (const file of presetFiles) await write(`.agent-presets/${presetId}/${file.path}`, file.content);
				const championDir = join(this.presetRoot, presetId);
				if (!existsSync(championDir)) return {
					files,
					champion: "missing"
				};
				const target = resolveWithin(dir, `champion/.agent-presets/${presetId}`);
				await mkdir(dirname(target), { recursive: true });
				await cp(championDir, target, { recursive: true });
				for (const rel of await listFiles(target)) files.push(`champion/.agent-presets/${presetId}/${rel}`);
				return {
					files,
					champion: "captured"
				};
			}
			case "capability": {
				const { name, entry } = mutation;
				await write("capability-table.patch.yml", capabilityPatchYaml(proposal.proposalId, name, entry));
				if (champion.capabilityEntry == null) return {
					files,
					champion: "missing",
					championSource: "missing"
				};
				await write("champion/capability-table.entry.yml", championEntryYaml(name, champion.capabilityEntry));
				const source = await this.capabilityRowSource(name);
				if (source === null) return {
					files,
					champion: "captured",
					championSource: "code-default"
				};
				await write("champion/capability-table.source.txt", `${source}\n`);
				return {
					files,
					champion: "captured",
					championSource: "config-text"
				};
			}
			case "task_definition":
				await write("task-definition.json", `${JSON.stringify(mutation.definition, null, 2)}\n`);
				if (champion.taskDefinition == null) return {
					files,
					champion: "missing"
				};
				await write("champion/task-definition.json", `${JSON.stringify(champion.taskDefinition, null, 2)}\n`);
				return {
					files,
					champion: "captured"
				};
			default: throw new Error(`evolution: targetType "${proposal.targetType}" has no mechanical materialization`);
		}
	}
	/**
	* Fold records into proposals, enforcing the state machine on every step:
	* proposed starts a new id; each later kind must be exactly an allowed next
	* state, and payload-bearing kinds re-run the write path's payload
	* validation (candidate versionSet/mutation, gate answers, the
	* prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
	* load exactly as it would fail append. The same rules guard replay and live
	* appends, so an illegal migration is rejected identically in both paths.
	*/
	fold(records) {
		const proposals = /* @__PURE__ */ new Map();
		for (const record of records) {
			const current = proposals.get(record.proposalId);
			if (record.kind === "proposed") {
				if (current !== void 0) throw new Error(`evolution: proposal "${record.proposalId}" already exists`);
				proposals.set(record.proposalId, {
					proposalId: record.proposalId,
					targetType: record.targetType,
					targetId: record.targetId,
					baseVersion: record.baseVersion,
					level: record.level,
					rationale: record.rationale,
					sourceRefs: [...record.sourceRefs],
					status: "proposed",
					history: [{
						status: "proposed",
						actor: record.actor,
						at: record.at
					}]
				});
				continue;
			}
			if (current === void 0) throw new Error(`evolution: unknown proposal "${record.proposalId}"`);
			assertTransition(current, record.kind);
			current.history.push({
				status: record.kind,
				actor: record.actor,
				at: record.at
			});
			switch (record.kind) {
				case "candidate":
					validateVersionSet(record.versionSet);
					if (record.mutation !== void 0) {
						validateMutation(current.targetType, record.mutation, current.baseVersion);
						current.mutation = structuredClone(record.mutation);
					}
					current.versionSet = { ...record.versionSet };
					break;
				case "prepared": {
					const mechanical = mutationMechanical(current.targetType);
					if (record.mechanical !== mechanical) throw new Error(`evolution: prepared record for "${record.proposalId}" marks mechanical=${record.mechanical}, but targetType "${current.targetType}" implies ${mechanical}`);
					if (!CHAMPION_STATES.includes(record.champion)) throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown champion state "${String(record.champion)}"`);
					if (record.sandbox !== null && typeof record.sandbox !== "string") throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string sandbox`);
					if (!Array.isArray(record.files) || record.files.some((file) => typeof file !== "string")) throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`);
					if (mechanical && (record.sandbox === null || record.champion === "none")) throw new Error(`evolution: prepared record for "${record.proposalId}" is mechanical but names no sandbox`);
					if (!mechanical && (record.sandbox !== null || record.champion !== "none" || record.files.length > 0)) throw new Error(`evolution: prepared record for "${record.proposalId}" is bookkeeping-only but carries sandbox artifacts`);
					if (record.championSource !== void 0) {
						if (!CHAMPION_SOURCES.includes(record.championSource)) throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown championSource "${String(record.championSource)}"`);
						if (current.targetType !== "capability") throw new Error(`evolution: prepared record for "${record.proposalId}" carries championSource but targetType "${current.targetType}" is not capability`);
						if (record.championSource === "missing" !== (record.champion === "missing")) throw new Error(`evolution: prepared record for "${record.proposalId}" has championSource "${record.championSource}" but champion "${record.champion}"`);
					}
					current.prepared = {
						sandbox: record.sandbox,
						mechanical: record.mechanical,
						champion: record.champion,
						...record.championSource === void 0 ? {} : { championSource: record.championSource },
						files: [...record.files]
					};
					break;
				}
				case "replayed":
					if (typeof record.report !== "string" || record.report.length === 0) throw new Error(`evolution: replayed record for "${record.proposalId}" has no report path`);
					if (!REPLAY_VERDICTS.includes(record.verdict)) throw new Error(`evolution: replayed record for "${record.proposalId}" has unknown verdict "${String(record.verdict)}"`);
					if (!Array.isArray(record.tasks) || record.tasks.some((item) => !isRecord$1(item) || typeof item.taskId !== "string" || !REPLAY_RELATIONS.includes(item.relation) || typeof item.holdout !== "boolean")) throw new Error(`evolution: replayed record for "${record.proposalId}" has a malformed task summary`);
					current.replayed = {
						report: record.report,
						verdict: record.verdict,
						tasks: record.tasks.map((item) => ({ ...item }))
					};
					break;
				case "gated":
					validateGateAnswers(record.gate);
					current.gate = record.gate;
					break;
				case "decided":
					current.decision = record.decision;
					if (record.note !== void 0) current.decisionNote = record.note;
					if (record.approvalRef !== void 0) {
						if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: decided record for "${record.proposalId}" has an empty human-approval evidence ref`);
						current.decisionApprovalRef = record.approvalRef;
					}
					break;
				case "applied":
				case "rolledback":
					if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.some((target) => typeof target !== "string" || target.length === 0)) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list`);
					if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`);
					current[record.kind] = {
						targets: [...record.targets],
						approvalRef: record.approvalRef
					};
					break;
			}
			current.status = record.kind;
		}
		return proposals;
	}
	async load() {
		let text$21;
		try {
			text$21 = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text$21.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`evolution: corrupt ledger line ${index + 1} in ${this.file}`);
			}
		});
		for (const record of records) if (record.formatVersion !== 1) throw new Error(`evolution: unsupported ledger formatVersion "${String(record.formatVersion)}"`);
		this.records = records;
		this.fold(this.records);
	}
	/** Validate the staged fold first; memory commits only after the line is on disk. */
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			this.fold([...this.records, record]);
			await mkdir(this.root, { recursive: true });
			await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
			this.records = [...this.records, record];
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
	}
};

//#endregion
//#region src/tools/approve.ts
const text$20 = (value) => [{
	type: "text",
	text: value
}];
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
			render: (_a, v) => text$20(v)
		},
		execute: async (args, exec) => {
			if (args.prompt.trim().length === 0) throw new Error("hitl_approve: prompt is empty");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("hitl_approve: missing agent");
			switch (await ctx.approval.request({
				agent,
				toolName: "hitl_approve",
				callId: exec.callId,
				reason: args.prompt,
				signal: exec.signal
			})) {
				case "allowed-once": return "approve";
				case "rejected": return "reject";
				case "cancelled": return "reject (cancelled before the human decided)";
				case "unavailable": return "reject (no approval answerer available)";
			}
		}
	});
}

//#endregion
//#region src/tools/ask.ts
const text$19 = (value) => [{
	type: "text",
	text: value
}];
const QUESTION_ID = "hitl-ask";
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
			render: (_a, v) => text$19(v)
		},
		execute: async (args, exec) => {
			if (args.prompt.trim().length === 0) throw new Error("hitl_ask: prompt is empty");
			const item = (await ctx.userQuestions.ask({
				questions: [{
					id: QUESTION_ID,
					question: args.prompt
				}],
				...exec.agent !== void 0 ? { agent: exec.agent } : {},
				signal: exec.signal
			})).answers.find((entry) => entry.id === QUESTION_ID);
			return item?.custom ?? item?.selected.join(", ") ?? "";
		}
	});
}

//#endregion
//#region src/tools/capability-list.ts
const text$18 = (value) => [{
	type: "text",
	text: value
}];
/**
* `filesystem → read, write, edit, read_image` — the label kept, the real DSH
* names it resolves to shown, so a reader can see what a worker is actually
* granted. A label outside the vocabulary is shown as such and is what
* admission rejects when the capability is next resolved.
*/
function renderTools(entry) {
	const labels = entry.tools ?? [];
	if (labels.length === 0) return "tools: []";
	return `tools: [${labels.map((label) => TOOL_LABELS[label] === void 0 ? `${label} → (unknown label)` : `${label} → ${TOOL_LABELS[label].join(", ")}`).join("; ")}]`;
}
function renderPermission(entry) {
	return entry.permission === void 0 ? "permission: (none — the worker keeps danger-full-access)" : `permission: ${entry.permission}`;
}
function renderMcpServers(entry) {
	const servers = entry.mcpServers ?? [];
	if (servers.length === 0) return "";
	return `mcpServers: [${servers.join(", ")}] (mounted per worker at spawn, bound to the run's env checkout; tools appear as mcp__<server>__<tool>)`;
}
function defineCapabilityListTool(ctx) {
	return defineTool({
		name: "capability_list",
		description: "List the capability names the task runtime can grant, with the tools/skills/agent preset each one carries. Call this before task_decompose to pick requiredCapabilities: a name outside this list is a capability gap, and the gap rejects the whole decomposition batch unless that child is declared decomposable.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$18(v)
		},
		execute: async () => {
			const capabilities = ctx.taskRuntime.listCapabilities();
			const names = Object.keys(capabilities);
			if (names.length === 0) return "no capabilities configured";
			const lines = names.map((name) => {
				const entry = capabilities[name];
				const mcp = renderMcpServers(entry);
				return `- ${name} — ${[
					renderTools(entry),
					`skills: [${(entry.skills ?? []).join(", ")}]`,
					...entry.preset !== void 0 ? [`preset: ${entry.preset}`] : [],
					...mcp === "" ? [] : [mcp],
					renderPermission(entry)
				].join(" ")}`;
			});
			return [
				`capabilities (${names.length}):`,
				...lines,
				"",
				`worker baseline (every capability worker keeps these on top of its grants): ${workerBaseline().join(", ")}`,
				`baseline labels: ${WORKER_BASELINE_LABELS.join(", ")}; task machinery: ${WORKER_BASELINE_TOOLS.join(", ")}`,
				"",
				"tool labels: a capability declares labels (filesystem, bash, …); each expands to the DSH tool names shown after \"→\".",
				"tool grants are fail-closed: a worker sees its capabilities' tools plus the baseline plus (when a capability names its own preset) that preset's whole tool plane — nothing else from the global layer.",
				"skill grants are not exclusive: DSH has no per-agent skill hiding, so a granted skill is registered for that worker alone and guaranteed loadable, but the worker's skill catalog still lists every skill its composition can discover.",
				"mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run's environment checkout; a server that cannot start fails the spawn loudly.",
				"permissions: a capability that declares none leaves the worker on the deployment default (danger-full-access); flipping the default is blocked until worker approvals reliably reach the canvas (#17 in the working guide)."
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/escalate.ts
const text$17 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$15(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("escalate: missing agent id");
	return id;
}
/** The three KISS §7 elements, named the way the refusal and the record name them. */
const ELEMENTS = [
	"what",
	"tried",
	"suggested"
];
/** One card as the approval reason shows it to the human. */
function cardLines(card) {
	return [
		`trigger: ${card.trigger}`,
		`what: ${card.what}`,
		`tried: ${card.tried}`,
		`suggested: ${card.suggested}`,
		...card.sourceTaskId === void 0 ? [] : [`source task: ${card.sourceTaskId}`],
		...card.sourceRefs === void 0 || card.sourceRefs.length === 0 ? [] : [`sourceRefs: [${card.sourceRefs.join(", ")}]`]
	];
}
function renderEscalation$1(escalation) {
	return [
		`- ${escalation.escalationId} [${escalation.status}] ${escalation.trigger} — what: ${escalation.what}`,
		`  tried: ${escalation.tried}`,
		`  suggested: ${escalation.suggested}`,
		`  source task: ${escalation.sourceTaskId ?? "(none)"} sourceRefs: [${escalation.sourceRefs.join(", ")}]`,
		`  approval: ${escalation.approvalRef} by ${escalation.actor} at ${escalation.at}`
	].join("\n");
}
function defineEscalateTool(ctx) {
	return defineTool({
		name: "escalate",
		description: "Report work you cannot settle yourself to a human (KISS §7 L4): a capability gap, an exhausted budget, or an UNKNOWN(verifier) verdict. The card names what is missing, what was already tried, and what is suggested — an incomplete card is refused, because a human must be able to decide from it in ten minutes. The card is shown to the human through the native approval seam first and is recorded in the append-only escalation ledger (`.dsh/escalations.jsonl`) only after an explicit approve; a reject, cancel, or unavailable answerer records nothing. Set list to read the recorded cards back without asking a human.",
		parameters: {
			what: {
				type: "string",
				description: "What is missing — the gap, the exhausted budget, or the verdict that cannot be judged"
			},
			tried: {
				type: "string",
				description: "What was already tried before escalating"
			},
			suggested: {
				type: "string",
				description: "What you suggest the human do"
			},
			trigger: {
				type: "string",
				enum: ESCALATION_TRIGGERS,
				description: "What raised the card"
			},
			escalationId: {
				type: "string",
				description: "Stable id for the card; omitted derives one. A repeated id is refused, so a retry after a failed raise stays idempotent"
			},
			sourceTaskId: {
				type: "string",
				description: "The task the card is about, when it has one"
			},
			sourceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence / task / diagnosis refs behind the card"
			},
			list: {
				type: "boolean",
				description: "Read-only: list the recorded escalations instead of raising one"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$17(v)
		},
		execute: async (args, exec) => {
			if (args.list === true) {
				const escalations = await ctx.escalation.list();
				if (escalations.length === 0) return "escalations: none recorded";
				return [`escalations (${escalations.length}):`, ...escalations.map(renderEscalation$1)].join("\n");
			}
			const caller = sessionId$15(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("escalate: missing agent");
			const missing = ELEMENTS.filter((element) => {
				const value = args[element];
				return typeof value !== "string" || value.trim().length === 0;
			});
			if (missing.length > 0) return [
				`escalate rejected: incomplete L4 card — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
				"a human must be able to decide in ten minutes from what is missing, what was tried, and what is suggested",
				"nothing was recorded and no human was asked"
			].join("; ");
			if (args.trigger === void 0 || !ESCALATION_TRIGGERS.includes(args.trigger)) return `escalate rejected: trigger must be one of ${ESCALATION_TRIGGERS.join(" / ")}; nothing was recorded and no human was asked`;
			const card = {
				trigger: args.trigger,
				what: args.what,
				tried: args.tried,
				suggested: args.suggested,
				...args.escalationId === void 0 ? {} : { escalationId: args.escalationId },
				...args.sourceTaskId === void 0 ? {} : { sourceTaskId: args.sourceTaskId },
				...args.sourceRefs === void 0 ? {} : { sourceRefs: args.sourceRefs }
			};
			const reason = [
				"L4 escalation — a human decision is required",
				...cardLines(card),
				"approving records the card in the escalation ledger; rejecting records nothing"
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "escalate",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `escalate: no escalation recorded — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; the work stays where it was`;
			try {
				const escalation = await ctx.escalation.raise(card, caller, `approval:${exec.callId}`);
				return [
					`escalation ${escalation.escalationId} recorded [${escalation.status}] trigger: ${escalation.trigger}`,
					...cardLines(escalation),
					"acceptance: all three elements present (what / tried / suggested) — a human can decide from this card in ten minutes",
					`recorded after human approval ${escalation.approvalRef}; ledger: ${ctx.escalation.file}`
				].join("\n");
			} catch (error) {
				return `escalate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-apply.ts
const text$16 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$14(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_apply: missing agent id");
	return id;
}
/**
* Why a decided PROMOTE proposal still cannot be applied, per boundary
* (§2.7.7 / §2.9.2): L4 and the non-materialized surfaces are human-run.
*/
function manualGuidance(proposal) {
	if (proposal.level === "L4") return "L4 harness evolution is human-run by rule: a human edits the harness itself; evolution_apply never applies L4";
	if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) return proposal.targetType === "task_definition" ? "task_definition has no production registry to write (the task store keeps denormalized instances only): a human edits the definition source; evolution_apply never applies it" : `${proposal.targetType} mutations are bookkeeping-only (mechanical: false): a human edits that surface by hand; the ledger keeps the record`;
	if (proposal.prepared?.sandbox == null) return "this candidate carried no structured mutation, so nothing was materialized: apply it as a manual human edit";
	return null;
}
/** How fast each applied type takes effect, stated honestly in the output. */
function effectNote(proposal) {
	switch (proposal.targetType) {
		case "skill": return "effective immediately — the skill filesystem watches the skill root, so the write is live";
		case "agent_preset": return "effective immediately — preset discovery re-reads the roots on every resolve";
		default: return "effective immediately for admissions in this process (the runtime registry row was replaced); config.yml keeps it across restarts";
	}
}
function defineEvolutionApplyTool(ctx) {
	return defineTool({
		name: "evolution_apply",
		description: "Apply a PROMOTE-decided EvolutionProposal to production (status: applied). Only the three mechanical types (skill / agent_preset / capability) at L1–L3 with a materialized sandbox; task_definition, the five bookkeeping-only types, and L4 stay manual and are refused with instructions. Always asks a human through the native approval seam first — a second gate after evolution_decide — naming every production path it will write; a reject, cancel, or unavailable answerer writes nothing and leaves the proposal decided. skill and agent_preset take effect on write; a capability row is mirrored into the running registry and persists in config.yml. evolution_rollback restores the champion snapshot.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Decided (PROMOTE) proposal to apply to production"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$16(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$14(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_apply: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "decided") return `evolution_apply rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a decided proposal can be applied`;
			if (proposal.decision !== "PROMOTE") return `evolution_apply rejected: proposal ${proposal.proposalId} was decided ${proposal.decision}; only a PROMOTE decision can be applied`;
			const manual = manualGuidance(proposal);
			if (manual !== null) return `evolution_apply rejected: ${manual}`;
			const targets = applyTargets(proposal, ctx.evolution);
			const reason = [
				`Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				"recorded decision: PROMOTE",
				"this writes production targets:",
				...targets.map((target) => `  - ${target}`),
				effectNote(proposal),
				"rollback: evolution_rollback restores the champion snapshot from the sandbox"
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_apply",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_apply: nothing written — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays decided`;
			try {
				const applied = await ctx.evolution.apply(args.proposalId, caller, `approval:${exec.callId}`);
				let runtimeNote = "";
				if (applied.capability !== void 0) try {
					ctx.taskRuntime.applyCapabilityRow(applied.capability.name, applied.capability.entry);
					runtimeNote = "\nruntime registry row replaced — new admissions in this process use it now";
				} catch (error) {
					runtimeNote = `\nruntime override failed (${error instanceof Error ? error.message : String(error)}) — the config.yml row takes effect on the next restart`;
				}
				return [
					`proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
					"wrote production targets:",
					...applied.targets.map((target) => `  - ${target}`),
					effectNote(proposal),
					`human approval: approval:${exec.callId} — rollback with evolution_rollback`
				].join("\n") + runtimeNote;
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-candidate.ts
const text$15 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$13(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_candidate: missing agent id");
	return id;
}
function defineEvolutionCandidateTool(ctx) {
	return defineTool({
		name: "evolution_candidate",
		description: "Claim a proposed EvolutionProposal into validation (status: candidate) by recording the complete version set it aligns to (e.g. taskDefinition / skill / toolProfile / agentPreset / verifier / runtimePolicy versions). Bookkeeping for the branch model only: no branch is created and nothing is executed or changed. Optionally attach a structured mutation — the patch description; a candidate carrying one must pass evolution_prepare (sandbox materialization) and evolution_replay (candidate vs champion over this graph's terminal tasks) before evolution_gate, a candidate without one gates directly.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Proposal to move into candidate"
			},
			versionSet: {
				type: "object",
				additionalProperties: true,
				required: true,
				description: "Complete version set the candidate aligns to: name → version string, at least one entry"
			},
			mutation: {
				type: "object",
				additionalProperties: true,
				description: "Optional structured patch description, shape fixed by targetType — skill: { name, content } (full SKILL.md text); agent_preset: { presetId, files: [{ path, content }] } (paths relative to the preset dir); capability: { name, entry } (entry = { skills?, tools?, preset?, permission?, mcpServers? }); task_definition: { baseVersion, definition }. The other five target types take a free-form object, recorded mechanical: false (bookkeeping only)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$15(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$13(exec);
			const versions = args.versionSet;
			try {
				const proposal = await ctx.evolution.candidate(args.proposalId, versions, caller, args.mutation);
				const versionsText = Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ");
				const next = proposal.mutation === void 0 ? "next: evolution_gate" : "mutation recorded — next: evolution_prepare (sandbox materialization), then evolution_replay (candidate vs champion), then evolution_gate";
				return [`proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`, `ledger entry only — no branch created, nothing executed; ${next}`].join("\n");
			} catch (error) {
				return `evolution_candidate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-decide.ts
const text$14 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$12(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_decide: missing agent id");
	return id;
}
function defineEvolutionDecideTool(ctx) {
	return defineTool({
		name: "evolution_decide",
		description: "Close a gated EvolutionProposal with a human decision (status: decided). Always asks a human through the native approval seam first — every level L1–L4, no exemption — and records the decision (PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH) only after an explicit approve. A reject, cancel, or unavailable answerer records nothing and leaves the proposal gated. A recorded PROMOTE still applies nothing by itself: the change takes effect only through evolution_apply, which asks the human a second time.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Gated proposal to decide"
			},
			decision: {
				type: "string",
				required: true,
				enum: EVOLUTION_DECISIONS,
				description: "Decision to record after human approval"
			},
			note: {
				type: "string",
				description: "Optional rationale attached to the decision record"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$14(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$12(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_decide: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "gated") return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`;
			const gate = proposal.gate;
			const reason = [
				`Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				`version set: ${Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ")}`,
				`gate: 1. Target failure fixed? ${gate.targetFailureFixed}`,
				`gate: 2. Original acceptance maintained? ${gate.originalAcceptanceMaintained}`,
				`gate: 3. Existing regression maintained? ${gate.existingRegressionMaintained} [evidence: ${gate.regressionEvidenceRefs.join(", ")}]`,
				`gate: 4. No unacceptable side effects? ${gate.noUnacceptableSideEffects}`,
				`gate: 5. Holdout performance acceptable? ${gate.holdoutPerformanceAcceptable}`,
				`gate: 6. Resource cost acceptable? ${gate.resourceCostAcceptable}`,
				`proposed decision: ${args.decision}${args.note === void 0 ? "" : ` — ${args.note}`}`
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_decide",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_decide: no decision recorded — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays gated`;
			try {
				const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note);
				return [`proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === void 0 ? "" : ` — ${decided.decisionNote}`}`, decided.decision === "PROMOTE" ? "recorded after human approval — nothing applied yet; evolution_apply (second human gate) takes it to production" : "recorded after human approval — the ledger notes the decision only; nothing was applied"].join("\n");
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-gate.ts
const text$13 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$11(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_gate: missing agent id");
	return id;
}
function defineEvolutionGateTool(ctx) {
	return defineTool({
		name: "evolution_gate",
		description: "Answer the minimal Validation Gate for a candidate (status: gated). The six questions (细化想法4 §32): 1. Target failure fixed? 2. Original acceptance maintained? 3. Existing regression maintained? 4. No unacceptable side effects? 5. Holdout performance acceptable? 6. Resource cost acceptable? All six answers are required; the regression/replay side must cite evidence ids (from this graph's task store) or file paths whose existence is checked — cited evidence is never executed. A candidate carrying a mutation must pass evolution_prepare (sandbox materialization) and, for a mechanical mutation, evolution_replay — the replay report path must then be one of the regressionEvidenceRefs. Records the ledger entry only; nothing is promoted or changed. Next step is evolution_decide, which always asks a human.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Candidate to gate"
			},
			targetFailureFixed: {
				type: "string",
				required: true,
				description: "Answer to \"1. Target failure fixed?\""
			},
			originalAcceptanceMaintained: {
				type: "string",
				required: true,
				description: "Answer to \"2. Original acceptance maintained?\""
			},
			existingRegressionMaintained: {
				type: "string",
				required: true,
				description: "Answer to \"3. Existing regression maintained?\""
			},
			noUnacceptableSideEffects: {
				type: "string",
				required: true,
				description: "Answer to \"4. No unacceptable side effects?\""
			},
			holdoutPerformanceAcceptable: {
				type: "string",
				required: true,
				description: "Answer to \"5. Holdout performance acceptable?\""
			},
			resourceCostAcceptable: {
				type: "string",
				required: true,
				description: "Answer to \"6. Resource cost acceptable?\""
			},
			regressionEvidenceRefs: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Evidence behind the regression/replay answers: evidence ids or paths (existence-checked, never executed), at least one"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$13(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$11(exec);
			let evidenceIds = /* @__PURE__ */ new Set();
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId));
				evidenceIds = new Set(snapshot.evidence.map((item) => item.evidenceId));
			} catch {
				evidenceIds = /* @__PURE__ */ new Set();
			}
			try {
				const proposal = await ctx.evolution.gate(args.proposalId, {
					targetFailureFixed: args.targetFailureFixed,
					originalAcceptanceMaintained: args.originalAcceptanceMaintained,
					existingRegressionMaintained: args.existingRegressionMaintained,
					noUnacceptableSideEffects: args.noUnacceptableSideEffects,
					holdoutPerformanceAcceptable: args.holdoutPerformanceAcceptable,
					resourceCostAcceptable: args.resourceCostAcceptable,
					regressionEvidenceRefs: args.regressionEvidenceRefs
				}, caller, async (ref) => evidenceIds.has(ref));
				return [`proposal ${proposal.proposalId} [gated] gate answered 6/6, regression evidence: [${proposal.gate.regressionEvidenceRefs.join(", ")}]`, "ledger entry only — nothing executed or promoted; next: evolution_decide (human approval required)"].join("\n");
			} catch (error) {
				return `evolution_gate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-list.ts
const text$12 = (value) => [{
	type: "text",
	text: value
}];
const TARGET_TYPES$2 = [
	"skill",
	"tool",
	"capability",
	"task_definition",
	"decomposition_policy",
	"agent_preset",
	"workflow_policy",
	"verifier",
	"runtime_policy"
];
function defineEvolutionListTool(ctx) {
	return defineTool({
		name: "evolution_list",
		description: "Read-only. List EvolutionProposals in the evolution ledger, optionally filtered by status / targetType / targetId, each with its derived history (proposed → candidate → prepared → replayed → gated → decided → applied → rolledback for applied mechanical mutations; a mutation-less candidate gates directly). The ledger records proposals, sandbox materializations, human decisions, and human-approved applies/rollbacks.",
		parameters: {
			status: {
				type: "string",
				enum: [
					"proposed",
					"candidate",
					"prepared",
					"replayed",
					"gated",
					"decided",
					"applied",
					"rolledback"
				],
				description: "Only proposals in this status"
			},
			targetType: {
				type: "string",
				enum: TARGET_TYPES$2,
				description: "Only proposals pointing at this mutation surface"
			},
			targetId: {
				type: "string",
				description: "Only proposals pointing at this target"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$12(v)
		},
		execute: async (args) => {
			const proposals = await ctx.evolution.list({
				...args.status === void 0 ? {} : { status: args.status },
				...args.targetType === void 0 ? {} : { targetType: args.targetType },
				...args.targetId === void 0 ? {} : { targetId: args.targetId }
			});
			if (proposals.length === 0) return "evolution ledger: no proposals match";
			const lines = [`evolution ledger (${proposals.length}):`];
			for (const proposal of proposals) {
				const decision = proposal.decision === void 0 ? "" : ` ${proposal.decision}`;
				lines.push(`- ${proposal.proposalId} [${proposal.status}${decision}] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`);
				lines.push(`  rationale: ${proposal.rationale}`);
				lines.push(`  sourceRefs: [${proposal.sourceRefs.join(", ")}]`);
				if (proposal.versionSet !== void 0) lines.push(`  version set: ${Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ")}`);
				if (proposal.mutation !== void 0) {
					const kind = mutationMechanical(proposal.targetType) ? "mechanical" : "bookkeeping-only (mechanical: false)";
					lines.push(`  mutation: ${kind} ${proposal.targetType} mutation`);
				}
				if (proposal.prepared !== void 0) {
					const view = proposal.prepared;
					if (view.sandbox === null) lines.push("  prepared: bookkeeping only, nothing materialized");
					else {
						const championText = view.champion === "captured" ? "champion snapshot captured" : "champion: null";
						lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox} (${view.files.length} files, ${championText})`);
					}
				}
				if (proposal.replayed !== void 0) {
					const view = proposal.replayed;
					const summary = view.tasks.map((item) => `${item.taskId}${item.holdout ? " (holdout)" : ""}: ${item.relation}`).join(", ");
					lines.push(`  replayed: verdict ${view.verdict} — report ${view.report}${summary === "" ? "" : ` (${summary})`}`);
				}
				if (proposal.gate !== void 0) lines.push(`  gate regression evidence: [${proposal.gate.regressionEvidenceRefs.join(", ")}]`);
				if (proposal.applied !== void 0) lines.push(`  applied: [${proposal.applied.targets.join(", ")}] (approval ${proposal.applied.approvalRef})`);
				if (proposal.rolledback !== void 0) lines.push(`  rolled back: [${proposal.rolledback.targets.join(", ")}] (approval ${proposal.rolledback.approvalRef})`);
				lines.push(`  history: ${proposal.history.map((entry) => `${entry.status} by ${entry.actor} at ${entry.at}`).join(" → ")}`);
			}
			return lines.join("\n");
		}
	});
}

//#endregion
//#region src/tools/evolution-prepare.ts
const text$11 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$10(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_prepare: missing agent id");
	return id;
}
/**
* Champion anchor for a task_definition target. The task store keeps no
* definitions registry — definition fields live denormalized on each task
* instance — so the snapshot is the first instance matching
* { taskType: targetId, version: baseVersion } ('v3' and '3' both read as 3),
* reduced to the fields instances actually hold (decompositionPolicy and
* budgetPolicy are not retained per instance). No match, or no store, means the
* champion is unresolvable: null.
*/
async function definitionChampion(ctx, caller, targetId, baseVersion) {
	const version = Number(baseVersion.replace(/^v/, ""));
	if (!Number.isInteger(version)) return null;
	try {
		const graph = await ctx.graphs.graphForSession(caller);
		const task = (await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))).tasks.find((item) => item.definitionRef.taskType === targetId && item.definitionRef.version === version);
		if (task === void 0) return null;
		return {
			taskType: task.definitionRef.taskType,
			version: task.definitionRef.version,
			objective: task.objective,
			acceptanceCriteria: task.acceptanceCriteria,
			requiredCapabilities: task.requestedCapabilities
		};
	} catch {
		return null;
	}
}
function defineEvolutionPrepareTool(ctx) {
	return defineTool({
		name: "evolution_prepare",
		description: "Materialize a candidate's structured mutation into the proposal sandbox (status: prepared). Writes go only to .dsh/evolution/sandbox/<proposalId>/ — skills/<name>/SKILL.md for a skill, .agent-presets/<presetId>/… for an agent_preset, capability-table.patch.yml (whole-row replacement semantics) for a capability, task-definition.json for a task_definition — plus a champion/ snapshot of the current production target (champion: null when it is new). The other five target types are bookkeeping-only (mechanical: false) and materialize nothing. Nothing here touches production; next step is evolution_replay for the mechanical types, evolution_gate for bookkeeping-only ones.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Candidate carrying a mutation, to materialize into its sandbox"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$11(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$10(exec);
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const champion = {};
			if (proposal.targetType === "capability" && proposal.mutation !== void 0) {
				const name = proposal.mutation.name;
				champion.capabilityEntry = ctx.taskRuntime.listCapabilities()[name] ?? null;
			}
			if (proposal.targetType === "task_definition") champion.taskDefinition = await definitionChampion(ctx, caller, proposal.targetId, proposal.baseVersion);
			try {
				const prepared = await ctx.evolution.prepare(args.proposalId, caller, champion);
				const view = prepared.prepared;
				if (!view.mechanical) return [`proposal ${prepared.proposalId} [prepared] bookkeeping only — ${prepared.targetType} mutations are not mechanically applied (mechanical: false)`, "ledger entry only — nothing materialized; next: evolution_gate"].join("\n");
				const championText = view.champion === "captured" ? view.championSource === "config-text" ? "champion snapshot: captured under champion/ (config.yml row source text — rollback restores it verbatim)" : view.championSource === "code-default" ? "champion snapshot: captured under champion/ (code default, no config.yml row — rollback removes the applied row so the default governs again)" : "champion snapshot: captured under champion/" : "champion snapshot: none — champion: null (the production target does not exist yet)";
				return [
					`proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
					...view.files.map((file) => `  wrote ${file}`),
					championText,
					"sandbox only — production was not touched; next: evolution_replay (candidate vs champion), then evolution_gate"
				].join("\n");
			} catch (error) {
				return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-propose.ts
const text$10 = (value) => [{
	type: "text",
	text: value
}];
const TARGET_TYPES$1 = [
	"skill",
	"tool",
	"capability",
	"task_definition",
	"decomposition_policy",
	"agent_preset",
	"workflow_policy",
	"verifier",
	"runtime_policy"
];
function sessionId$9(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_propose: missing agent id");
	return id;
}
function defineEvolutionProposeTool(ctx) {
	return defineTool({
		name: "evolution_propose",
		description: "Register an EvolutionProposal in the evolution ledger (status: proposed). Pure bookkeeping: nothing here executes or changes production — promotion requires evolution_candidate, evolution_gate, and a human-approved evolution_decide. Fill targetType/targetId/rationale manually, or pass fromDiagnosis to transcribe one proposal out of a recorded diagnosis (task_diagnose). baseVersion, level, and at least one sourceRef (diagnosisId / reviewRef / evidenceId) are required.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Unique id for this proposal; a duplicate id is rejected"
			},
			level: {
				type: "string",
				required: true,
				enum: [
					"L1",
					"L2",
					"L3",
					"L4"
				],
				description: "Evolution level (L1 execution adaptation / L2 capability / L3 workflow / L4 harness); v1 routes every level through human review"
			},
			baseVersion: {
				type: "string",
				required: true,
				description: "Version of the target this proposal starts from"
			},
			targetType: {
				type: "string",
				enum: TARGET_TYPES$1,
				description: "The mutation surface the proposal points at (required unless fromDiagnosis)"
			},
			targetId: {
				type: "string",
				description: "Name of the concrete target (required unless fromDiagnosis)"
			},
			rationale: {
				type: "string",
				description: "Why this change would address the diagnosed cause (required unless fromDiagnosis)"
			},
			sourceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Sources this proposal rests on (diagnosisId / reviewRef / evidenceId)"
			},
			fromDiagnosis: {
				type: "object",
				additionalProperties: false,
				description: "Transcribe targetType/targetId/rationale from one proposal of a recorded diagnosis",
				properties: {
					diagnosisId: {
						type: "string",
						required: true,
						description: "Recorded diagnosis id"
					},
					proposalIndex: {
						type: "number",
						required: true,
						description: "Index into the diagnosis proposals array (0-based)"
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$10(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$9(exec);
			let targetType = args.targetType;
			let targetId = args.targetId;
			let rationale = args.rationale;
			const sourceRefs = [...args.sourceRefs ?? []];
			if (args.fromDiagnosis !== void 0) {
				if (targetType !== void 0 || targetId !== void 0 || rationale !== void 0) throw new Error("evolution_propose: fromDiagnosis already supplies targetType/targetId/rationale — do not pass both");
				const graph = await ctx.graphs.graphForSession(caller);
				const diagnosis = (await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))).diagnoses.find((item) => item.diagnosisId === args.fromDiagnosis.diagnosisId);
				if (diagnosis === void 0) throw new Error(`evolution_propose: unknown diagnosis "${args.fromDiagnosis.diagnosisId}"`);
				const proposal = diagnosis.proposals[args.fromDiagnosis.proposalIndex];
				if (proposal === void 0) throw new Error(`evolution_propose: diagnosis "${diagnosis.diagnosisId}" has no proposal #${args.fromDiagnosis.proposalIndex}`);
				targetType = proposal.targetType;
				targetId = proposal.targetId;
				rationale = proposal.rationale;
				sourceRefs.unshift(`diagnosis:${diagnosis.diagnosisId}`);
			} else if (targetType === void 0 || targetId === void 0 || rationale === void 0) throw new Error("evolution_propose: targetType, targetId and rationale are required without fromDiagnosis");
			try {
				const proposal = await ctx.evolution.propose({
					proposalId: args.proposalId,
					targetType,
					targetId,
					baseVersion: args.baseVersion,
					level: args.level,
					rationale,
					sourceRefs
				}, caller);
				return [
					`proposal ${proposal.proposalId} registered [proposed] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`,
					`rationale: ${proposal.rationale}`,
					`sourceRefs: [${proposal.sourceRefs.join(", ")}]`,
					"ledger entry only — nothing was executed or changed; next: evolution_candidate"
				].join("\n");
			} catch (error) {
				return `evolution_propose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-replay.ts
const text$9 = (value) => [{
	type: "text",
	text: value
}];
/** The lineage tag every replay artifact (objective, review anomalies) carries. */
function replayLineage(proposalId) {
	return `evolution-replay:${proposalId}`;
}
/** Why agent_preset replay is manual in v1 — recorded verbatim in the report. */
const PRESET_REPLAY_MANUAL_REASON = "agent_preset replay is manual in v1: the agent-presets roster (AgentPresets.resolve/mount) scans constructor-fixed roots only and cannot mount a sandbox-materialized preset without reconfiguring the production service; review the sandbox composition under .agent-presets/ by hand and answer the gate accordingly";
const VERIFICATION_MODES = [
	"deterministic",
	"simulation",
	"formal",
	"measurement",
	"review",
	"composite"
];
function sessionId$8(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_replay: missing agent id");
	return id;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** The terminal review record of a champion task's latest run — the comparison anchor. */
function championRecord(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.reviews.find((item) => item.runId === runId);
}
function sideFromRecord(task, record) {
	return {
		taskId: task.taskId,
		...record.runId === void 0 ? {} : { runId: record.runId },
		outcome: record.outcome,
		...record.durationMs === void 0 ? {} : { durationMs: record.durationMs },
		criteria: (record.criteria ?? []).map((item) => ({
			criterionId: item.criterionId,
			verdict: item.verdict,
			...item.command === void 0 ? {} : { command: item.command },
			...item.exitCode === void 0 ? {} : { exitCode: item.exitCode }
		}))
	};
}
function sideFromOutcome(outcome) {
	return {
		taskId: outcome.taskId,
		runId: outcome.runId,
		outcome: outcome.status,
		...outcome.durationMs === void 0 ? {} : { durationMs: outcome.durationMs },
		criteria: (outcome.criteria ?? []).map((item) => ({
			criterionId: item.criterionId,
			verdict: item.verdict,
			...item.command === void 0 ? {} : { command: item.command },
			...item.exitCode === void 0 ? {} : { exitCode: item.exitCode }
		}))
	};
}
/**
* Normalize the candidate definition's contract for a deterministic criteria
* replay. The definition is the free-form object the mutation carried; the
* replay needs real criteria, so a missing/empty `acceptanceCriteria` or a
* criterion without a `criterionId` fails loudly. Fields the definition omits
* (objective / requiredCapabilities) fall back to the champion task's.
*/
function candidateContract(definition, champion) {
	if (!isRecord(definition)) throw new Error("evolution_replay: the sandbox task-definition.json must hold an object");
	const rawCriteria = definition.acceptanceCriteria;
	if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) throw new Error("evolution_replay: the candidate definition must carry a non-empty acceptanceCriteria array");
	const acceptanceCriteria = rawCriteria.map((raw, index) => {
		if (!isRecord(raw)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}] must be an object`);
		if (typeof raw.criterionId !== "string" || raw.criterionId.length === 0) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].criterionId must be a non-empty string`);
		const command = raw.command === void 0 ? void 0 : raw.command;
		if (command !== void 0 && typeof command !== "string") throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].command must be a string`);
		const mode = raw.verificationMode ?? (command === void 0 ? "review" : "deterministic");
		if (typeof mode !== "string" || !VERIFICATION_MODES.includes(mode)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].verificationMode must be one of ${VERIFICATION_MODES.join(" / ")}`);
		return {
			criterionId: raw.criterionId,
			description: typeof raw.description === "string" ? raw.description : "",
			verificationMode: mode,
			requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((item) => typeof item === "string") : [],
			mandatory: typeof raw.mandatory === "boolean" ? raw.mandatory : true,
			...command === void 0 ? {} : { command }
		};
	});
	return {
		objective: typeof definition.objective === "string" && definition.objective.length > 0 ? definition.objective : champion.objective,
		acceptanceCriteria,
		requiredCapabilities: Array.isArray(definition.requiredCapabilities) ? definition.requiredCapabilities.filter((item) => typeof item === "string") : [...champion.requestedCapabilities]
	};
}
function renderCriterionDiff(diff) {
	if (diff.length === 0) return "no criterion diff";
	return diff.map((item) => `${item.criterionId} ${item.champion ?? "—"}→${item.candidate ?? "—"}`).join(", ");
}
function defineEvolutionReplayTool(ctx) {
	return defineTool({
		name: "evolution_replay",
		description: "Replay a prepared mechanical EvolutionProposal against this graph's historical terminal tasks (status: replayed). Per targetType: capability re-runs each champion task with the mutation entry as a per-run capability overlay, skill re-runs with the sandbox skills/ shadowing production for the replay worker, task_definition re-runs the candidate definition's criteria through the verifier alone (deterministic criteria replay, no worker), and agent_preset is manual in v1 (the preset roster cannot mount sandbox presets) — nothing executes and the report says so. Every replayed task is a new parentless task tagged evolution-replay:<proposalId>; the historical tree and production are never touched. Writes sandbox/<proposalId>/replay-report.json and records the ledger entry; cite that path in evolution_gate's regressionEvidenceRefs.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Prepared proposal (mechanical mutation) to replay"
			},
			taskIds: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Champion task ids (terminal: verified/failed) to replay against — the observed set"
			},
			holdoutTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Champion task ids replayed the same way but reported as the held-out group"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$9(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$8(exec);
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "prepared") return `evolution_replay rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a prepared proposal can be replayed`;
			const prepared = proposal.prepared;
			if (!prepared.mechanical) return `evolution_replay rejected: proposal ${proposal.proposalId} is bookkeeping-only (mechanical: false); nothing to replay — gate it directly with evolution_gate`;
			const lineage = replayLineage(proposal.proposalId);
			if (proposal.targetType === "agent_preset") {
				const report$1 = {
					formatVersion: 1,
					proposalId: proposal.proposalId,
					targetType: proposal.targetType,
					at: (/* @__PURE__ */ new Date()).toISOString(),
					mode: "manual",
					manualReason: PRESET_REPLAY_MANUAL_REASON,
					observed: [],
					holdout: {
						executed: false,
						tasks: []
					},
					verdict: "manual"
				};
				try {
					await ctx.evolution.replay(proposal.proposalId, caller, report$1);
				} catch (error) {
					return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
				}
				return [
					`proposal ${proposal.proposalId} [replayed] manual — nothing was executed`,
					PRESET_REPLAY_MANUAL_REASON,
					`report: ${prepared.sandbox}/replay-report.json`,
					"next: evolution_gate (cite the report path in regressionEvidenceRefs)"
				].join("\n");
			}
			const taskIds = args.taskIds.map((id) => String(id));
			const holdoutIds = (args.holdoutTaskIds ?? []).map((id) => String(id));
			if (taskIds.length === 0) return "evolution_replay rejected: taskIds must name at least one champion task";
			if (new Set([...taskIds, ...holdoutIds]).size !== taskIds.length + holdoutIds.length) return "evolution_replay rejected: taskIds and holdoutTaskIds must not overlap or repeat";
			let snapshot;
			let storeId;
			try {
				storeId = rootTaskStoreId((await ctx.graphs.graphForSession(caller)).rootSessionId);
				snapshot = await ctx.task.openStore(storeId);
			} catch (error) {
				return `evolution_replay rejected: cannot open this graph\'s task store: ${error instanceof Error ? error.message : String(error)}`;
			}
			const champions = /* @__PURE__ */ new Map();
			for (const taskId of [...taskIds, ...holdoutIds]) {
				const task = snapshot.tasks.find((item) => item.taskId === taskId);
				if (task === void 0) return `evolution_replay rejected: unknown task "${taskId}" in this graph's task store`;
				if (task.status !== "verified" && task.status !== "failed") return `evolution_replay rejected: task "${taskId}" is ${task.status}; only a terminal (verified or failed) task can be a replay champion`;
				const record = championRecord(snapshot, task);
				if (record === void 0) return `evolution_replay rejected: task "${taskId}" has no review record on its latest run; nothing to compare the candidate against`;
				champions.set(taskId, {
					task,
					record
				});
			}
			const sandboxAbs = join(ctx.evolution.root, prepared.sandbox);
			const mutation = proposal.mutation;
			const comparisons = [];
			try {
				for (const [taskId, holdout$1] of [...taskIds.map((id) => [id, false]), ...holdoutIds.map((id) => [id, true])]) {
					const { task: champion, record } = champions.get(taskId);
					let options;
					if (proposal.targetType === "capability") {
						const capability = mutation;
						options = { overlay: { capabilityOverrides: { [capability.name]: capability.entry } } };
					} else if (proposal.targetType === "skill") options = { overlay: { extraSkillRoots: [join(sandboxAbs, "skills")] } };
					else if (proposal.targetType === "task_definition") options = {
						contract: candidateContract(JSON.parse(await readFile(join(sandboxAbs, "task-definition.json"), "utf8")), champion),
						spawn: false
					};
					else throw new Error(`evolution_replay: targetType "${proposal.targetType}" has no replay path`);
					const outcome = await ctx.taskRuntime.replayTask(storeId, taskId, {
						lineage,
						...options,
						signal: exec.signal
					}, caller);
					const championSide = sideFromRecord(champion, record);
					const candidateSide = sideFromOutcome(outcome);
					comparisons.push({
						taskId,
						holdout: holdout$1,
						comparison: {
							taskId,
							candidateTaskId: outcome.taskId,
							champion: championSide,
							candidate: candidateSide,
							...compareReplaySides(championSide, candidateSide)
						}
					});
				}
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)} (no replay was recorded; ${comparisons.length} run(s) already settled stay in the task store as evidence)`;
			}
			const observed = comparisons.filter((item) => !item.holdout).map((item) => item.comparison);
			const holdout = comparisons.filter((item) => item.holdout).map((item) => item.comparison);
			const report = {
				formatVersion: 1,
				proposalId: proposal.proposalId,
				targetType: proposal.targetType,
				at: (/* @__PURE__ */ new Date()).toISOString(),
				mode: "executed",
				observed,
				holdout: {
					executed: holdout.length > 0,
					tasks: holdout
				},
				verdict: overallReplayVerdict([...observed, ...holdout])
			};
			let replayed;
			try {
				replayed = await ctx.evolution.replay(proposal.proposalId, caller, report);
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const renderGroup = (title, group) => [`${title} (${group.length}):`, ...group.map((item) => `  ${item.taskId} champion ${item.champion.outcome} → candidate ${item.candidate.outcome} (${renderCriterionDiff(item.criteriaDiff)}) — ${item.relation}`)];
			return [
				`proposal ${replayed.proposalId} [replayed] ${proposal.targetType} ${proposal.targetId} — verdict: ${report.verdict}`,
				...renderGroup("observed", observed),
				holdout.length === 0 ? "holdout: not run (no holdoutTaskIds given)" : renderGroup("holdout", holdout).join("\n"),
				`report: ${replayed.replayed.report}`,
				"comparison only — the replay ran as new evolution-replay tasks; the historical tree and production were not changed",
				"next: evolution_gate (cite the report path in regressionEvidenceRefs)"
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/evolution-rollback.ts
const text$8 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$7(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_rollback: missing agent id");
	return id;
}
function defineEvolutionRollbackTool(ctx) {
	return defineTool({
		name: "evolution_rollback",
		description: "Roll back an applied EvolutionProposal (status: rolledback). Restores the champion snapshot taken at prepare time (skill SKILL.md / preset directory / capability config.yml row); when the champion did not exist (champion: null), deletes what the apply created. Always asks a human through the native approval seam first — reject / cancel / unavailable writes nothing and the proposal stays applied. Only an applied proposal can be rolled back; a rolled-back proposal keeps its full ledger history.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Applied proposal to roll back"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$8(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$7(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_rollback: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "applied") return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`;
			const targets = applyTargets(proposal, ctx.evolution);
			const restore = proposal.prepared?.champion !== "captured" ? "the champion did not exist (champion: null) — this DELETES what the apply created:" : proposal.prepared?.championSource === "code-default" ? "the champion is a code default (no config.yml row at prepare time) — this REMOVES the applied row so the default governs again:" : "this restores the champion snapshot over production targets:";
			const reason = [
				`Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				`applied at: ${proposal.applied.targets.join(", ")} (approval ${proposal.applied.approvalRef})`,
				restore,
				...targets.map((target) => `  - ${target}`)
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_rollback",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_rollback: nothing written — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays applied`;
			try {
				const rolledback = await ctx.evolution.rollback(args.proposalId, caller, `approval:${exec.callId}`);
				let runtimeNote = "";
				if (rolledback.capability !== void 0) try {
					ctx.taskRuntime.applyCapabilityRow(rolledback.capability.name, rolledback.capability.entry);
					runtimeNote = rolledback.capability.entry === null ? "\nruntime registry row removed — new admissions in this process no longer see it" : "\nruntime registry row restored — new admissions in this process use the champion entry now";
				} catch (error) {
					runtimeNote = `\nruntime override failed (${error instanceof Error ? error.message : String(error)}) — the config.yml row takes effect on the next restart`;
				}
				return [
					`proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — champion restored`,
					"wrote production targets:",
					...rolledback.targets.map((target) => `  - ${target}`),
					`human approval: approval:${exec.callId}`
				].join("\n") + runtimeNote;
			} catch (error) {
				return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/mark-ready.ts
const text$7 = (value) => [{
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
			render: (_a, v) => text$7(v)
		},
		execute: async (_args, exec) => {
			const sessionId$16 = exec.agent?.id;
			if (sessionId$16 === void 0) throw new Error("graph_mark_ready: missing agent id");
			const graph = await ctx.graphs.graphForSession(sessionId$16);
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
const text$6 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$6(exec) {
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
									},
									requiresArtifact: {
										type: "array",
										items: { type: "string" },
										description: "Artifact/evidence kinds or ids that must already exist in the task store for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation"
									},
									verifierRef: {
										type: "string",
										description: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode."
									}
								}
							}
						},
						requiredCapabilities: {
							type: "array",
							items: { type: "string" },
							description: "Capability names the child needs; call capability_list first to see the names the runtime can grant — an unlisted name is a capability gap that rejects the whole batch unless the child is declared decomposable"
						},
						dependsOn: {
							type: "array",
							items: { type: "integer" },
							description: "Indices of sibling children that must verify before this one starts"
						},
						assumptions: {
							type: "array",
							items: { type: "string" },
							description: "External conditions this child's contract rests on; merged with dependency-evidence references into the worker handoff"
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
			render: (_a, v) => text$6(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$6(exec);
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
//#region src/tools/task-diagnose.ts
const text$5 = (value) => [{
	type: "text",
	text: value
}];
const TARGET_TYPES = [
	"skill",
	"tool",
	"capability",
	"task_definition",
	"decomposition_policy",
	"agent_preset",
	"workflow_policy",
	"verifier",
	"runtime_policy"
];
function sessionId$5(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_diagnose: missing agent id");
	return id;
}
function defineTaskDiagnoseTool(ctx) {
	return defineTool({
		name: "task_diagnose",
		description: "Record a diagnosis for a task: an explanation of what its reviews show (observed failure, scope, localized cause, confidence), not a score. Call task_review_pack first and ground every diagnosis in its output — evidenceRefs and reviewRefs must name real evidence ids and the review refs the pack prints; at least one ref is required. proposals are structured suggestions only: they are stored as data and never execute automatically. Written once per diagnosisId and immutable afterwards.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "Task the diagnosis explains"
			},
			diagnosisId: {
				type: "string",
				required: true,
				description: "Unique id for this diagnosis; a duplicate id is rejected"
			},
			observedFailure: {
				type: "string",
				required: true,
				description: "The failure or anomaly under explanation, as observed"
			},
			scope: {
				type: "string",
				required: true,
				description: "How far the cause reaches (this task, its subtree, a shared assumption, …)"
			},
			localizedCause: {
				type: "string",
				required: true,
				description: "The most specific explanation the evidence supports"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence ids the diagnosis rests on"
			},
			reviewRefs: {
				type: "array",
				items: { type: "string" },
				description: "Review refs from task_review_pack (<taskId>#<runId> or <taskId>#no-run)"
			},
			confidence: {
				type: "string",
				required: true,
				enum: [
					"high",
					"medium",
					"low"
				],
				description: "How sure the diagnoser is; coarse on purpose"
			},
			proposals: {
				type: "array",
				description: "Structured suggestions for later Evolution steps; stored as data, never auto-executed",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						targetType: {
							type: "string",
							required: true,
							enum: TARGET_TYPES,
							description: "The mutation surface the proposal points at"
						},
						targetId: {
							type: "string",
							required: true,
							description: "Name of the concrete target"
						},
						rationale: {
							type: "string",
							required: true,
							description: "Why this change would address the localized cause"
						}
					}
				}
			},
			relatedTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Other tasks this diagnosis implicates (cross-task lineage)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$5(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$5(exec);
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(caller)).rootSessionId);
			const diagnosis = {
				diagnosisId: args.diagnosisId,
				taskId: args.taskId,
				observedFailure: args.observedFailure,
				scope: args.scope,
				localizedCause: args.localizedCause,
				evidenceRefs: args.evidenceRefs ?? [],
				reviewRefs: args.reviewRefs ?? [],
				confidence: args.confidence,
				proposals: args.proposals ?? [],
				...args.relatedTaskIds === void 0 ? {} : { relatedTaskIds: args.relatedTaskIds }
			};
			try {
				await ctx.task.recordDiagnosisIn(storeId, diagnosis, caller);
			} catch (error) {
				return `task_diagnose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const proposals = diagnosis.proposals.map((item) => `- ${item.targetType} ${item.targetId}: ${item.rationale}`);
			return [
				`diagnosis ${diagnosis.diagnosisId} recorded for task ${diagnosis.taskId} [${diagnosis.confidence}]`,
				`cause: ${diagnosis.localizedCause}`,
				...proposals.length === 0 ? ["proposals: none"] : [`proposals (${proposals.length}, suggestions only — none auto-executes):`, ...proposals]
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-read.ts
const text$4 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$4(exec) {
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
			render: (_a, v) => text$4(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId$4(exec);
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
//#region src/tools/review-escalation.ts
/** How many review agents one root store may start before the guardrail holds. */
const REVIEW_AGENT_BUDGET_DEFAULT = 1;
function latestReview$1(snapshot, taskId) {
	return [...snapshot.reviews].reverse().find((item) => item.taskId === taskId);
}
/**
* The capability coverage of one task, read from the review's dimension facts
* when present and from the stored admission manifest otherwise. Both describe
* the same resolution; the review's copy is the one a reader sees, the stored
* manifest is what exists for a runless or dimension-less record.
*/
function capabilityGap(snapshot, taskId, review) {
	const coverage = review?.dimensions?.capabilityCoverage;
	if (coverage !== void 0) return coverage.closure === "gap" || coverage.missing.length > 0;
	const manifest = snapshot.capabilities[taskId];
	if (manifest === void 0) return false;
	return manifest.closure === "gap" || manifest.missing.length > 0;
}
/**
* Compute the escalation decision for one task against a store snapshot.
* @param snapshot - the root task store snapshot.
* @param taskId - the task whose review is under consideration.
* @param budget - review agents already started, and the cap (defaults to
*   `used: 0, max: REVIEW_AGENT_BUDGET_DEFAULT`).
* @returns the signals that hold, whether to escalate, and the budget state.
*/
function computeEscalation(snapshot, taskId, budget = {}) {
	const resolved = {
		used: Math.max(0, budget.used ?? 0),
		max: Math.max(1, budget.max ?? REVIEW_AGENT_BUDGET_DEFAULT)
	};
	const review = latestReview$1(snapshot, taskId);
	const reasons = [];
	if (review?.outcome === "failed") {
		reasons.push("E1");
		if (review.logTail === void 0 && review.evidenceRefs.length === 0) reasons.push("E2");
	}
	if ((review?.criteria ?? []).some((criterion) => criterion.verdict === "inconclusive")) reasons.push("E3");
	if (capabilityGap(snapshot, taskId, review)) reasons.push("E4");
	const exhausted = reasons.length > 0 && resolved.used >= resolved.max;
	return {
		reasons,
		required: reasons.length > 0 && !exhausted,
		budget: resolved,
		suppressed: exhausted ? reasons : []
	};
}
/**
* The machine-readable escalation line `task_review_pack` prints. Three shapes:
* required with signals, not required, and not required because the guardrail
* spent the budget (which still names what it withheld — a suppressed signal is
* a fact, not a silence).
*/
function renderEscalation(escalation) {
	const budget = `${escalation.budget.used}/${escalation.budget.max}`;
	if (escalation.required) return `escalation: required ${escalation.reasons.join(", ")} (budget ${budget})`;
	if (escalation.suppressed.length > 0) return `escalation: not required (budget ${budget}) — suppressed ${escalation.suppressed.join(", ")}: budget exhausted`;
	return `escalation: not required (budget ${budget})`;
}
/**
* The judgement line: the six dimensions whose conclusion the fact table does
* not carry, named so a reader cannot mistake the facts for a verdict.
*/
function renderJudgementDimensions() {
	return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(", ")} (not mechanically observable from the fact table; task_review_agent concludes these)`;
}

//#endregion
//#region src/review-agent-ledger.ts
/** Repo root, derived the way `EvolutionService` derives it (both files sit at the same depth). */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
/** Directory holding the ledger; `$DSH_HOME/review-agents` unless overridden. */
function reviewAgentLedgerDir() {
	const override = process.env.SINGULARITY_REVIEW_LEDGER_DIR;
	if (override !== void 0 && override.length > 0) return resolve(override);
	return join(process.env.DSH_HOME ?? join(repoRoot, ".dsh"), "review-agents");
}
/** The ledger file (`<dir>/agents.jsonl`). */
function reviewAgentLedgerFile() {
	return join(reviewAgentLedgerDir(), "agents.jsonl");
}
/** The per-root-store cap; `SINGULARITY_REVIEW_AGENT_BUDGET` when it parses to a positive integer. */
function reviewAgentBudget() {
	const raw = process.env.SINGULARITY_REVIEW_AGENT_BUDGET;
	const parsed = raw === void 0 || raw.length === 0 ? NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : REVIEW_AGENT_BUDGET_DEFAULT;
}
/**
* How many review agents this root store has already started. A missing file
* reads as zero; a corrupt line throws rather than silently undercounting.
*/
async function countReviewAgentRuns(rootStoreId) {
	let text$21;
	try {
		text$21 = await readFile(reviewAgentLedgerFile(), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
	let count = 0;
	text$21.split("\n").forEach((line, index) => {
		if (line.trim().length === 0) return;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error(`review-agent-ledger: corrupt line ${index + 1} in ${reviewAgentLedgerFile()}`);
		}
		if (record.rootStoreId === rootStoreId) count += 1;
	});
	return count;
}
/** Append one started review agent. */
async function appendReviewAgentRun(record) {
	const file = reviewAgentLedgerFile();
	await mkdir(dirname(file), { recursive: true });
	const line = {
		formatVersion: 1,
		...record,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

//#endregion
//#region src/tools/task-review-pack.ts
const text$3 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$3(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_review_pack: missing agent id");
	return id;
}
/** The ref a diagnosis uses in `reviewRefs` to name one review record. */
function reviewRef(review) {
	return `${review.taskId}#${review.runId ?? "no-run"}`;
}
/** The task's most recent review, or nothing when it never settled one. */
function latestReview(snapshot, taskId) {
	return [...snapshot.reviews].reverse().find((item) => item.taskId === taskId);
}
function reviewSummary(snapshot, taskId) {
	const review = latestReview(snapshot, taskId);
	if (review === void 0) return "no review";
	const detail = review.localizedCause ?? review.anomalies[0];
	return `review ${reviewRef(review)}: ${review.outcome}${detail === void 0 ? "" : ` — ${detail}`}`;
}
/**
* The effort line: one clause per counter that exists, and nothing for the ones
* that do not — an absent field means "not observed" (see `ReviewMetrics`), so
* printing 0 for it would invent a measurement. The two counters whose scope is
* easy to misread (`tokens`, `humanInterventions`) and the one that is
* structurally constant (`retries`) carry their caveat inline.
*/
function renderMetrics(metrics) {
	const parts = [];
	if (metrics.tokens !== void 0) parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens} (session-cumulative)`);
	if (metrics.toolCalls !== void 0) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`);
	if (metrics.humanInterventions !== void 0) parts.push(`humanInterventions ${metrics.humanInterventions} (session-scoped)`);
	if (metrics.retries !== void 0) parts.push(`retries ${metrics.retries} (no retry branch exists yet; always 0)`);
	if (metrics.evidenceLogs !== void 0) parts.push(`evidenceLogs ${metrics.evidenceLogs}`);
	return parts.join(" — ");
}
/**
* One line per dimension that the record actually carries: the observed facts,
* copied out, never rated and never narrated. Anything a dimension omits is
* omitted here too, so the pack stays a fact sheet — the explanation lives in
* the diagnoses below it.
*/
function renderDimensions(dimensions) {
	const lines = [];
	const outcome = dimensions.outcomeCorrectness;
	if (outcome !== void 0) lines.push(`  dim outcome correctness: ${outcome.outcome}, criteria ${outcome.criteriaCount}, unmet [${outcome.unmetCriterionIds.join(", ")}]`);
	const specification = dimensions.taskSpecification;
	if (specification !== void 0) lines.push(`  dim task specification: objective ${specification.objectivePresent ? "present" : "empty"}, criteria ${specification.criteriaCount}, with command ${specification.criteriaWithCommand}`);
	const acceptance = dimensions.acceptance;
	if (acceptance !== void 0) {
		const criteria = acceptance.criteria.map((item) => `${item.criterionId} ${item.mode}${item.hasCommand ? " +command" : ""}${item.mandatory ? "" : " optional"}`);
		lines.push(`  dim acceptance: ${criteria.join("; ")}`);
	}
	const decomposition = dimensions.decomposition;
	if (decomposition !== void 0) lines.push(`  dim decomposition: depth ${decomposition.depth}, ${decomposition.decompositionStatus}, children ${decomposition.childCount}, edges in/out ${decomposition.incomingEdges}/${decomposition.outgoingEdges}`);
	const coverage = dimensions.capabilityCoverage;
	if (coverage !== void 0) lines.push(`  dim capability coverage: ${coverage.closure}, granted [${coverage.granted.join(", ")}], missing [${coverage.missing.join(", ")}]`);
	const skill = dimensions.skillFit;
	if (skill !== void 0) {
		const loaded = skill.loaded === void 0 || skill.loadedOutsideGrant === void 0 ? "" : `, loaded [${skill.loaded.join(", ")}], outside grant [${skill.loadedOutsideGrant.join(", ")}]`;
		lines.push(`  dim skill fit: granted [${skill.granted.join(", ")}]${loaded}`);
	}
	const tools = dimensions.toolFit;
	if (tools !== void 0) {
		const called = tools.called === void 0 || tools.calledOutsideGrant === void 0 ? "" : `, called [${tools.called.map((item) => `${item.name} x${item.count}`).join(", ")}], outside grant [${tools.calledOutsideGrant.join(", ")}]`;
		lines.push(`  dim tool fit: granted [${tools.granted.join(", ")}]${called}`);
	}
	const context = dimensions.contextEfficiency;
	if (context !== void 0) {
		const tokens = context.tokens === void 0 ? "" : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`;
		const compactions = context.compactions === void 0 ? "" : ` compactions ${context.compactions}`;
		lines.push(`  dim context efficiency:${tokens}${compactions}`);
	}
	return lines;
}
/**
* One review line, with the session id a reader drills into. Printing it here
* is what lets a diagnosis point `session_trace` at the session the review came
* from without a second lookup (§2.7.5).
*/
function renderReview(review) {
	const duration = review.durationMs === void 0 ? "" : ` duration ${review.durationMs}ms`;
	const session = review.sessionId === void 0 ? "" : ` session ${review.sessionId}`;
	const lines = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(", ")}]${session}`];
	if (review.localizedCause !== void 0) lines.push(`  cause: ${review.localizedCause}`);
	for (const anomaly of review.anomalies) lines.push(`  anomaly: ${anomaly}`);
	for (const criterion of review.criteria ?? []) {
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const exit = criterion.exitCode === void 0 ? "" : ` exit ${criterion.exitCode}`;
		const log = criterion.logRef === void 0 ? "" : ` log ${criterion.logRef}`;
		lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${exit}${command}${log}`);
	}
	for (const blocker of review.blockedBy ?? []) lines.push(`  blockedBy ${blocker.taskId} [${blocker.outcome}]`);
	if (review.metrics !== void 0) {
		const metrics = renderMetrics(review.metrics);
		if (metrics.length > 0) lines.push(`  metrics: ${metrics}`);
	}
	if (review.dimensions !== void 0) lines.push(...renderDimensions(review.dimensions));
	if (review.logTail !== void 0) lines.push("  logTail:", ...review.logTail.split("\n").map((line) => `    ${line}`));
	return lines;
}
/**
* One diagnosis, with its agent judgements kept visually apart from the
* mechanical facts above: the facts say what was observed, a judgement says
* what an agent concluded, and the header names the session so the two are
* never read as one table.
*/
function renderDiagnosis(diagnosis) {
	const producer = diagnosis.producedBy === void 0 ? "" : diagnosis.producedBy.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? ` [agent ${diagnosis.producedBy.sessionId}]` : ` [${diagnosis.producedBy.kind}]`;
	const lines = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`];
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) {
		const header = diagnosis.producedBy?.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? `judgements (agent ${diagnosis.producedBy.sessionId})` : "judgements";
		lines.push(`  ${header}:`);
		for (const judgement of diagnosis.judgements) lines.push(`    ${judgement.dimension}: ${judgement.verdict} — ${judgement.rationale} refs [${judgement.evidenceRefs.join(", ")}]`);
	}
	for (const proposal of diagnosis.proposals) lines.push(`  proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	return lines;
}
/**
* The pack for one task: the facts first (reviews, dependency edges,
* parent/child summaries), then the escalation decision, then the judgement
* dimensions the facts cannot settle, then the diagnoses that explain them.
* @throws when `taskId` is not in the snapshot.
*/
function buildReviewPack(snapshot, taskId, escalation) {
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`task_review_pack: unknown task "${taskId}"`);
	const reviews = snapshot.reviews.filter((item) => item.taskId === task.taskId);
	const parent = task.parentTaskId === void 0 ? void 0 : snapshot.tasks.find((item) => item.taskId === task.parentTaskId);
	const incoming = snapshot.edges.filter((edge) => edge.to === task.taskId).map((edge) => edge.from);
	const outgoing = snapshot.edges.filter((edge) => edge.from === task.taskId).map((edge) => edge.to);
	const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId);
	const lines = [
		`review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
		`objective: ${task.objective}`,
		`dependencies: must verify first [${incoming.join(", ")}]; blocks [${outgoing.join(", ")}]`,
		renderEscalation(escalation),
		renderJudgementDimensions(),
		`reviews (${reviews.length}):`,
		...reviews.flatMap(renderReview)
	];
	if (parent !== void 0) lines.push(`parent ${parent.taskId} [${parent.status}]: ${reviewSummary(snapshot, parent.taskId)}`);
	lines.push(`children (${task.childTaskIds.length}):`);
	for (const childId of task.childTaskIds) {
		const child = snapshot.tasks.find((item) => item.taskId === childId);
		if (child === void 0) continue;
		lines.push(`- ${child.taskId} [${child.status}]: ${reviewSummary(snapshot, child.taskId)}`);
	}
	lines.push(`diagnoses (${diagnoses.length}):`);
	for (const diagnosis of diagnoses) lines.push(...renderDiagnosis(diagnosis));
	return lines.join("\n");
}
function defineTaskReviewPackTool(ctx) {
	return defineTool({
		name: "task_review_pack",
		description: "Read-only. Assemble the diagnosis input pack for one task: the task itself, all its review records in full (criteria, log tail, blockers, the session each review came from), the machine escalation decision, the six dimensions whose conclusion the fact table does not carry, one-line review summaries of its children and parent, the dependency edges touching it, and its diagnoses with any agent judgements. Local evidence plus parent/children summaries — no ancestry replay (guide §2.7.5). Feed this to task_diagnose, or to task_review_agent when escalation requires a judgement.",
		parameters: { taskId: {
			type: "string",
			required: true,
			description: "Task to assemble the pack for"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$3(v)
		},
		execute: async (args, exec) => {
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(sessionId$3(exec))).rootSessionId);
			const snapshot = await ctx.task.openStore(storeId);
			const used = await countReviewAgentRuns(storeId);
			const escalation = computeEscalation(snapshot, args.taskId, {
				used,
				max: reviewAgentBudget()
			});
			return buildReviewPack(snapshot, args.taskId, escalation);
		}
	});
}

//#endregion
//#region src/tools/review-agent.ts
const text$2 = (value) => [{
	type: "text",
	text: value
}];
/** The preset the review agent mounts (`$DSH_HOME/.agent-presets/singularity-reviewer/`). */
const REVIEWER_PRESET = "singularity-reviewer";
/**
* The review agent's whole tool surface. Read-only by construction: the grant
* allow-list is this list intersected with what the composition offers, so
* `bash`, `write`, `edit`, `jobs`, `subagent`, `graph_spawn`, `hitl_*` and
* `evolution_*` are absent however the deployment is composed. `session_trace`
* and its siblings are here so the reviewer can drill into the sessions the
* pack names, which is the point of printing session ids on every review line.
*/
const REVIEWER_BASELINE = [
	"task_review_pack",
	"task_read",
	"task_status",
	"capability_list",
	"session_event_read",
	"session_event_trace",
	"session_trace",
	"read",
	"glob",
	"grep",
	"skill"
];
/** The capability grant one review agent is spawned with. */
function reviewerGrant() {
	return {
		capabilities: [],
		baseline: REVIEWER_BASELINE,
		keepPresetTools: false
	};
}
/** Default watchdog deadline for one review agent (10 minutes). */
const REVIEW_AGENT_TIMEOUT_MS = 6e5;
function sessionId$2(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_review_agent: missing agent id");
	return id;
}
/** The last top-level brace-balanced object in the text, if any (fallback when no fence parses). */
function lastBalancedObject(source) {
	let depth = 0;
	let start = -1;
	let last;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) last = source.slice(start, index + 1);
		}
	}
	return last;
}
/**
* Pull the judgement list out of the reviewer's reply. The last fenced block
* wins, then the last balanced object; a reply with neither parses as nothing,
* which the caller turns into six `unknown` judgements rather than a failure.
*/
function parseReviewerJudgements(reply) {
	if (reply === void 0) return void 0;
	const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
	const candidates = [fenced[fenced.length - 1], lastBalancedObject(reply)].filter((value) => value !== void 0);
	for (const candidate of candidates) try {
		const parsed = JSON.parse(candidate);
		const list = Array.isArray(parsed) ? parsed : parsed?.judgements;
		if (Array.isArray(list)) return list;
	} catch {}
}
/**
* Normalize a reviewer reply into exactly one judgement per judged dimension.
* Missing dimensions become `unknown`; a verdict outside the vocabulary becomes
* `unknown`; and a judgement with no evidence ref is downgraded to `unknown`
* with the review ref cited, because evidence that settles nothing must not
* read as a conclusion.
*/
function normalizeJudgements(raw, fallbackRef, missingRationale) {
	return JUDGED_DIMENSIONS.map((dimension) => {
		const entry = [...raw ?? []].reverse().find((item) => item.dimension === dimension);
		if (entry === void 0) return {
			dimension,
			verdict: "unknown",
			evidenceRefs: [fallbackRef],
			rationale: missingRationale
		};
		const refs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs.filter((value) => typeof value === "string" && value.length > 0) : [];
		const rationale = typeof entry.rationale === "string" && entry.rationale.length > 0 ? entry.rationale : "no rationale provided";
		const verdict = JUDGEMENT_VERDICTS.includes(entry.verdict) ? entry.verdict : "unknown";
		if (refs.length === 0) return {
			dimension,
			verdict: "unknown",
			evidenceRefs: [fallbackRef],
			rationale: `${rationale} (evidenceRefs empty — downgraded to unknown)`
		};
		return {
			dimension,
			verdict,
			evidenceRefs: refs,
			rationale
		};
	});
}
/** A mechanical restatement of the judgements — what was concluded, not an invented cause. */
function renderCause(taskId, judgements) {
	const by = (verdict) => judgements.filter((item) => item.verdict === verdict).map((item) => item.dimension);
	const parts = [];
	for (const verdict of [
		"inadequate",
		"unknown",
		"adequate"
	]) {
		const dimensions = by(verdict);
		if (dimensions.length > 0) parts.push(`${verdict} [${dimensions.join(", ")}]`);
	}
	return `agent review of ${taskId}: ${parts.join("; ")}`;
}
/** The judged dimensions rendered as report lines (agent judgements, kept apart from the fact lines). */
function renderJudgements(judgements) {
	return judgements.map((item) => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(", ")}]`);
}
function lastAssistantText(events) {
	const event = [...events].reverse().find((item) => item.type === "assistant/message");
	if (event === void 0) return void 0;
	const content = ((event.data?.message)?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return content.length === 0 ? void 0 : content;
}
function defineTaskReviewAgentTool(ctx) {
	return defineTool({
		name: "task_review_agent",
		description: "Spawn ONE read-only review agent for a task, take its structured judgement of the six dimensions the fact table cannot settle (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency), and persist that judgement as a Diagnosis. Each dimension returns verdict adequate|inadequate|unknown, required evidence refs, and a rationale — never a score; evidence that does not settle a dimension must be unknown. The reviewer has no write, shell, spawn, or evolution tool. It runs only when task_review_pack's escalation criterion fires, is capped per root store (default 1), and is cancelled by a watchdog if it overruns.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "Task whose review needs judgement"
			},
			timeoutMs: {
				type: "number",
				description: `Watchdog deadline in milliseconds; defaults to ${REVIEW_AGENT_TIMEOUT_MS}`
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$2(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$2(exec);
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(caller)).rootSessionId);
			const snapshot = await ctx.task.openStore(storeId);
			if (snapshot.tasks.find((item) => item.taskId === args.taskId) === void 0) return `task_review_agent: unknown task "${args.taskId}"`;
			const review = latestReview(snapshot, args.taskId);
			if (review === void 0) return `task_review_agent: task ${args.taskId} has no review record; nothing to judge`;
			const max = reviewAgentBudget();
			const used = await countReviewAgentRuns(storeId);
			const escalation = computeEscalation(snapshot, args.taskId, {
				used,
				max
			});
			if (escalation.suppressed.length > 0) return `task_review_agent: budget exhausted (${used}/${max}) for store ${storeId}; suppressed ${escalation.suppressed.join(", ")} — no review agent spawned`;
			if (!escalation.required) return `task_review_agent: escalation is not required for task ${args.taskId} (budget ${used}/${max}); no review agent spawned`;
			const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : REVIEW_AGENT_TIMEOUT_MS;
			const ref = reviewRef(review);
			const pack = buildReviewPack(snapshot, args.taskId, escalation);
			const prompt = [
				"You are a Singularity review agent. Judge six dimensions of the task below from the review pack, and nothing else.",
				"Do not score. Do not modify anything. Cite only refs printed in the pack (evidence ids, review refs like `task#run`, or session ids).",
				"When the pack does not settle a dimension, return verdict \"unknown\" — never guess.",
				"Return EXACTLY one fenced json block, no prose around it:",
				"```json",
				"{\"judgements\":[{\"dimension\":\"task_specification\",\"verdict\":\"adequate|inadequate|unknown\",\"evidenceRefs\":[\"...\"],\"rationale\":\"...\"}]}",
				"```",
				`Include all six dimensions exactly once: ${JUDGED_DIMENSIONS.join(", ")}.`,
				"",
				"--- review pack ---",
				pack
			].join("\n");
			const reviewerSessionId = SessionId(randomUUID());
			let spawnFailure;
			const handle = await ctx.agentRuntime.spawn(exec.agent, {
				sessionId: reviewerSessionId,
				name: `review ${args.taskId}`,
				prompt: [{
					type: "text",
					text: prompt
				}],
				agentPreset: REVIEWER_PRESET,
				grant: reviewerGrant(),
				signal: exec.signal
			}).catch((error) => {
				spawnFailure = error instanceof Error ? error.message : String(error);
			});
			if (handle === void 0) return `task_review_agent: spawn failed: ${spawnFailure ?? "unknown error"}`;
			await appendReviewAgentRun({
				rootStoreId: storeId,
				taskId: args.taskId,
				sessionId: reviewerSessionId,
				actor: caller
			});
			const cancel = () => handle.agent.cancel({ kind: "parent" });
			exec.signal.addEventListener("abort", cancel, { once: true });
			let timer;
			let timedOut = false;
			const deadline = new Promise((resolve$1) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve$1("timeout");
				}, timeoutMs);
			});
			const idle = handle.agent.whenIdle().then(() => "idle").catch(() => "failed");
			const outcome = await Promise.race([idle, deadline]);
			if (timer !== void 0) clearTimeout(timer);
			exec.signal.removeEventListener("abort", cancel);
			if (outcome === "timeout") handle.agent.cancel({ kind: "parent" });
			const reply = timedOut ? void 0 : lastAssistantText(handle.agent.session.snapshotEvents());
			const parsed = timedOut ? void 0 : parseReviewerJudgements(reply);
			const judgements = normalizeJudgements(parsed, ref, timedOut ? `review agent timed out after ${timeoutMs}ms with no judgement` : "no judgement returned for this dimension");
			const confidence = timedOut || parsed === void 0 ? "low" : judgements.some((item) => item.verdict === "unknown") ? "medium" : "high";
			const diagnosis = {
				diagnosisId: `review-agent-${reviewerSessionId}`,
				taskId: args.taskId,
				observedFailure: review.localizedCause ?? review.anomalies[0] ?? `escalation ${escalation.reasons.join(", ")} fired with no terminal failure text`,
				scope: `task ${args.taskId}`,
				localizedCause: renderCause(args.taskId, judgements),
				evidenceRefs: review.evidenceRefs,
				reviewRefs: [ref],
				confidence,
				proposals: [],
				producedBy: {
					kind: "agent",
					sessionId: reviewerSessionId
				},
				judgements
			};
			try {
				await ctx.task.recordDiagnosisIn(storeId, diagnosis, caller);
			} catch (error) {
				return `task_review_agent: judgement produced but not recorded: ${error instanceof Error ? error.message : String(error)}`;
			}
			return [
				timedOut ? `task_review_agent: review agent ${reviewerSessionId} timed out after ${timeoutMs}ms; cancelled. All six dimensions recorded unknown.` : `task_review_agent: review agent ${reviewerSessionId} judged task ${args.taskId} (escalation ${escalation.reasons.join(", ") || "none"})`,
				`judgements (agent ${reviewerSessionId}):`,
				...renderJudgements(judgements),
				`diagnosis ${diagnosis.diagnosisId} recorded [${confidence}]`
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
/**
* Best-effort obligation coverage for the footer (KISS §5.1, guide §4.2 #21):
* templates from `<repoRoot>/.agents/skills/<name>/obligations.yml` against the
* graph's obligations and requested capabilities. Every step may be absent —
* no env builder, no repo root within 8 levels, no template files — and an
* absent source omits the line rather than reporting zero coverage. Uncovered
* entries are a hint ("satisfied, or forgotten?"), never a block.
*/
async function obligationLines(ctx, envId, snapshot) {
	const header = snapshot.obligations.length === 0 ? [] : [`obligations: ${snapshot.obligations.length} recorded`];
	try {
		const envPath = (ctx.get?.("envBuilder") ?? ctx.envBuilder)?.store.get(envId).path;
		if (envPath === void 0) return header;
		const repoRoot$1 = await findRepoRoot(envPath);
		if (repoRoot$1 === void 0) return header;
		const templates = (await loadObligationTemplates(repoRoot$1)).flatMap((file) => file.templates);
		if (templates.length === 0) return header;
		const coverage = checkObligationCoverage(templates, snapshot);
		const uncovered = coverage.uncovered.map((template) => `${template.id} ("${template.question}") — satisfied, or forgotten?`);
		return [...header, `obligation coverage: ${coverage.covered.length}/${templates.length} covered${uncovered.length === 0 ? "" : `; uncovered: ${uncovered.join("; ")}`}`];
	} catch {
		return header;
	}
}
function defineTaskStatusTool(ctx) {
	return defineTool({
		name: "task_status",
		description: "Compact snapshot of the caller's graph task tree: task id, objective, status, latest run status, evidence ids, and terminal review outcome. Also lists recorded obligations and the domain-template coverage hint.",
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
				const review = [...snapshot.reviews].reverse().find((item) => item.taskId === task.taskId);
				const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId).length;
				const runPart = run === void 0 ? "run: none" : `run: ${run.status}`;
				const evidencePart = evidence.length === 0 ? "" : ` evidence: [${evidence.join(", ")}]`;
				const failing = review?.criteria?.filter((item) => item.verdict !== "pass") ?? [];
				const detail = review?.outcome === "failed" && failing.length > 0 ? `${review.localizedCause ?? "failed"} [${failing.map((item) => `${item.criterionId}${item.exitCode === void 0 ? "" : ` exit ${item.exitCode}`}`).join(", ")}]` : review?.localizedCause ?? review?.anomalies[0];
				const reviewPart = review === void 0 ? "" : ` review: ${review.outcome}${detail === void 0 ? "" : ` — ${detail}`}`;
				const diagPart = diagnoses === 0 ? "" : ` diag: ${diagnoses}`;
				return `${"  ".repeat(task.depth)}${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart}${reviewPart}${diagPart})`;
			});
			return [
				`graph ${graph.id} task tree (${snapshot.tasks.length} tasks):`,
				...lines,
				...await obligationLines(ctx, graph.envId, snapshot)
			].join("\n");
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
		description: "Self-check: re-run the verifier against the caller's current task run, record the resulting evidence bundle in the task store, and report per-criterion results. Records evidence but no task status; only valid while the run is running — calling it on a finished run returns an error.",
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
			if (run.status !== "running") return `task_verify: run ${run.runId} of task ${task.taskId} is ${run.status}; evidence can only be recorded while the run is running`;
			let cwd;
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				cwd = softService(ctx, "envBuilder")?.store.get(graph.envId).path;
			} catch {
				cwd = void 0;
			}
			const timeoutMs = ctx.taskRuntime.verifyTimeoutMs;
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`task_verify: task runtime exposes no positive verifyTimeoutMs (got ${String(timeoutMs)}); refusing to run the verifier without a deadline`);
			const bundle = await verifier.verifyRun(storeId, run.runId, {
				...cwd === void 0 ? {} : { cwd },
				timeoutMs
			});
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
		"taskRuntime",
		"userQuestions",
		"approval"
	];
	constructor(ctx) {
		super(ctx, "singularityAgent");
		ctx.plugin(HitlService);
		new EvolutionService(ctx);
		new EscalationService(ctx);
		ctx.tools.register(defineMarkReadyTool(ctx));
		ctx.tools.register(defineSpawnTool(ctx));
		ctx.tools.register(defineAskTool(ctx));
		ctx.tools.register(defineApproveTool(ctx));
		ctx.tools.register(defineTaskReadTool(ctx));
		ctx.tools.register(defineCapabilityListTool(ctx));
		ctx.tools.register(defineTaskDecomposeTool(ctx));
		ctx.tools.register(defineTaskStatusTool(ctx));
		ctx.tools.register(defineTaskVerifyTool(ctx));
		ctx.tools.register(defineTaskReviewPackTool(ctx));
		ctx.tools.register(defineTaskReviewAgentTool(ctx));
		ctx.tools.register(defineTaskDiagnoseTool(ctx));
		ctx.tools.register(defineEvolutionProposeTool(ctx));
		ctx.tools.register(defineEvolutionCandidateTool(ctx));
		ctx.tools.register(defineEvolutionPrepareTool(ctx));
		ctx.tools.register(defineEvolutionReplayTool(ctx));
		ctx.tools.register(defineEvolutionGateTool(ctx));
		ctx.tools.register(defineEvolutionDecideTool(ctx));
		ctx.tools.register(defineEvolutionApplyTool(ctx));
		ctx.tools.register(defineEvolutionRollbackTool(ctx));
		ctx.tools.register(defineEvolutionListTool(ctx));
		ctx.tools.register(defineEscalateTool(ctx));
	}
};
var src_default = SingularityAgent;

//#endregion
export { APPLYABLE_TARGET_TYPES, CHAMPION_SOURCES, CHAMPION_STATES, ESCALATION_TRIGGERS, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EscalationService, EvolutionService, HitlService, MECHANICAL_TARGET_TYPES, REPLAY_RELATIONS, REPLAY_VERDICTS, SingularityAgent, applyTargets, compareReplaySides, src_default as default, mutationMechanical, overallReplayVerdict };