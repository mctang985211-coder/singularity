import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { TOOL_LABELS, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, capabilityToolQuery, checkObligationCoverage, findRepoRoot, loadObligationTemplates, loadSkillSidecar, optionalService, precheckReplacedCapabilityRow, readVerifiedFile, registeredVerifierIds, renderRunBinding, unlistableVerifierRefusal, validateSkillProvider, walkVerified, workerBaseline } from "@dangosys/dsh-singularity-task-runtime";
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
			const text$27 = await this.enqueue(request.agent?.id ?? "unknown", "ask", question.question, request.signal);
			if (text$27.kind !== "ask") throw new Error("hitl: expected ask answer");
			return { answers: [{
				id: question.id,
				selected: [],
				custom: text$27.text
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
	enqueue(sessionId$22, kind, prompt, callerSignal) {
		const signal = callerSignal === void 0 ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (typeof sessionId$22 !== "string" || sessionId$22.length === 0) throw new Error("hitl: missing session id");
		const id = randomUUID();
		const pending = {
			id,
			kind,
			prompt,
			sessionId: sessionId$22,
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
		let text$27;
		try {
			text$27 = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text$27.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
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
	const changedContract = criteriaDiff.some((diff) => diff.champion === void 0 || diff.candidate === void 0) || champion.criteria.some((before) => candidate.criteria.find((after) => after.criterionId === before.criterionId)?.command !== before.command);
	return {
		verdictMatch,
		criteriaDiff,
		relation: candidateRank < championRank || regressedCriterion ? "worse" : changedContract ? "inconclusive" : "not-worse"
	};
}
/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
function overallReplayVerdict(comparisons) {
	if (comparisons.some((item) => item.relation === "worse")) return "worse";
	if (comparisons.length === 0 || comparisons.some((item) => item.relation === "inconclusive")) return "inconclusive";
	if (comparisons.every((item) => item.relation === "manual")) return "manual";
	if (comparisons.some((item) => item.relation === "manual")) return "inconclusive";
	return "not-worse";
}
function isRecord$3(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertSide(value, field) {
	if (!isRecord$3(value) || typeof value.taskId !== "string" || value.taskId.length === 0 || ![
		"verified",
		"failed",
		"cancelled"
	].includes(value.outcome) || !Array.isArray(value.criteria)) throw new Error(`evolution: replay report ${field} must carry a taskId, a valid outcome and criteria`);
	const ids = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		if (!isRecord$3(criterion) || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || ids.has(criterion.criterionId) || ![
			"pass",
			"fail",
			"inconclusive"
		].includes(criterion.verdict) || criterion.command !== void 0 && typeof criterion.command !== "string") throw new Error(`evolution: replay report ${field} has an invalid or duplicate criterion`);
		ids.add(criterion.criterionId);
	}
	if (value.outcome === "verified" && ids.size === 0) throw new Error(`evolution: replay report ${field} verified outcome needs criterion evidence`);
}
function assertComparison(value, field, mode) {
	if (!isRecord$3(value)) throw new Error(`evolution: replay report ${field} must be an object`);
	if (typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: replay report ${field}.taskId must be a non-empty string`);
	if (!isRecord$3(value.champion) || typeof value.champion.outcome !== "string") throw new Error(`evolution: replay report ${field}.champion must carry an outcome`);
	if (typeof value.relation !== "string" || !REPLAY_RELATIONS.includes(value.relation)) throw new Error(`evolution: replay report ${field}.relation must be one of ${REPLAY_RELATIONS.join(" / ")}`);
	assertSide(value.champion, `${field}.champion`);
	if (value.taskId !== value.champion.taskId) throw new Error(`evolution: replay report ${field} champion identity mismatch`);
	if (mode === "manual") {
		if (value.relation !== "manual" || value.candidate !== void 0) throw new Error(`evolution: replay report ${field} manual comparison cannot claim an executed candidate`);
		return;
	}
	assertSide(value.candidate, `${field}.candidate`);
	if (value.candidateTaskId !== value.candidate.taskId || value.candidate.taskId === value.taskId) throw new Error(`evolution: replay report ${field} candidate identity mismatch`);
	const computed = compareReplaySides(value.champion, value.candidate);
	if (value.relation !== computed.relation || value.verdictMatch !== computed.verdictMatch || JSON.stringify(value.criteriaDiff) !== JSON.stringify(computed.criteriaDiff)) throw new Error(`evolution: replay report ${field} comparison does not match its evidence`);
}
/**
* Validate a report against the proposal it claims to serve. The v1 manual
* boundary is enforced here: only an agent_preset replay may record
* `mode: 'manual'` (the preset roster scans constructor-fixed roots and cannot
* mount a sandbox-materialized preset), and only a manual report may carry the
* `manual` verdict — every other targetType must produce executed evidence.
* A skill report must additionally carry the candidate content identity
* (`candidateContent`) the replay ran against; equality with the prepared
* record is the service's check, not this schema's.
*/
function assertReplayReport(proposal, report) {
	if (!isRecord$3(report)) throw new Error("evolution: replay report must be an object");
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
	report.observed.forEach((item, index) => assertComparison(item, `observed[${index}]`, report.mode));
	if (!isRecord$3(report.holdout) || typeof report.holdout.executed !== "boolean" || !Array.isArray(report.holdout.tasks)) throw new Error("evolution: replay report.holdout must be { executed: boolean, tasks: [] }");
	report.holdout.tasks.forEach((item, index) => assertComparison(item, `holdout.tasks[${index}]`, report.mode));
	if (report.holdout.executed !== report.holdout.tasks.length > 0) throw new Error("evolution: replay report.holdout.executed must agree with its task list (empty = not run)");
	if (report.mode === "executed" && report.observed.length === 0) throw new Error("evolution: an executed replay report needs at least one observed task comparison");
	const comparisons = [...report.observed, ...report.holdout.tasks];
	const taskIds = comparisons.map((item) => item.taskId);
	const candidateIds = comparisons.flatMap((item) => item.candidate === void 0 ? [] : [item.candidate.taskId]);
	if (new Set(taskIds).size !== taskIds.length || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => taskIds.includes(id))) throw new Error("evolution: replay report observed and holdout must use distinct champion and candidate tasks");
	if (report.mode === "executed" && report.verdict !== overallReplayVerdict(comparisons)) throw new Error("evolution: replay report verdict does not match its comparisons");
	if (proposal.targetType === "skill") {
		const identity = report.candidateContent;
		if (!isRecord$3(identity) || typeof identity.name !== "string" || identity.name.length === 0 || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error("evolution: a skill replay report must carry candidateContent { name, sha256 } bound at prepare — evidence without the candidate content identity predates content binding; propose a new candidate and re-evaluate it");
	}
}
/** A human approval cannot substitute for two independent, non-regressing replay groups. */
function assertReplayPromotable(report) {
	if (report.mode !== "executed") throw new Error("evolution: promotion requires executed replay evidence, not a manual report");
	for (const [name, tasks] of [["observed", report.observed], ["holdout", report.holdout.tasks]]) if (overallReplayVerdict(tasks) !== "not-worse") throw new Error(`evolution: promotion requires non-empty ${name} replay with no regressions or inconclusive results`);
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
function locateCapabilityRow(text$27, name) {
	const eol = text$27.includes("\r\n") ? "\r\n" : "\n";
	const lines = text$27.split(eol);
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
function readCapabilityRowSource(text$27, name) {
	const located = locateCapabilityRow(text$27, name);
	if (located.rowStart === -1) return null;
	return located.lines.slice(located.rowStart, located.rowStart + located.rowSpan).join("\n");
}
/**
* Splice `source` (the `\n`-joined lines `readCapabilityRowSource` captured at
* prepare time) back over the current row for `name`, byte-for-byte; when the
* row is gone, insert the lines where a new row would go. Every other byte of
* the file is preserved, exactly as with `editCapabilityRow`.
*/
function restoreCapabilityRowSource(text$27, name, source) {
	const { lines, eol, capIndex, capIndent, capCollapsed, rowStart, rowSpan, insertAt } = locateCapabilityRow(text$27, name);
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
function editCapabilityRow(text$27, name, entry) {
	const { lines, eol, capIndex, capIndent, capCollapsed, regionEnd, rowStart, rowSpan, insertAt, entryIndent } = locateCapabilityRow(text$27, name);
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
/** One accepted verdict as a promotion report entry: the role, the content it was taken from, and the verifier ref only an execution provider has. */
function promotionProviderOf(verdict) {
	return {
		name: verdict.name,
		role: verdict.role,
		contentDigest: verdict.contentDigest,
		...verdict.role === "execution-provider" ? { verifierRef: verdict.verifierRef } : {}
	};
}
/** One provider role per line, for a decision or apply report. */
function renderProviderRoles(providers) {
	return providers.map((provider) => {
		if (provider.role === "execution-provider") return `provider: skill \`${provider.name}\` → execution-provider (verifier ${provider.verifierRef})`;
		if (provider.role === "knowledge") return `provider: skill \`${provider.name}\` → knowledge (loadable content; it does not close an execution gap)`;
		return `provider: skill \`${provider.name}\` → guidance (no sidecar; loadable guidance, not an execution provider)`;
	});
}
function nonEmpty(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: ${field} must be a non-empty string`);
	return value;
}
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertOnlyKeys(value, allowed, field) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`evolution: ${field} has unknown key "${key}"`);
}
/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function assertSegment(value, field) {
	const text$27 = nonEmpty(value, field);
	if (text$27 === "." || text$27 === ".." || text$27.includes("/") || text$27.includes("\\") || isAbsolute(text$27)) throw new Error(`evolution: ${field} must be a single safe path segment, got "${text$27}"`);
	return text$27;
}
/** A clean relative path: never absolute (posix or drive-letter), no `\`, no empty / `.` / `..` segments. */
function assertSandboxPath(value, field) {
	const text$27 = nonEmpty(value, field);
	if (isAbsolute(text$27) || /^[A-Za-z]:[\\/]/.test(text$27) || text$27.includes("\\") || text$27.includes("\0")) throw new Error(`evolution: ${field} must be a relative path inside the sandbox, got "${text$27}"`);
	if (text$27.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`evolution: ${field} must be a clean relative path (no empty / "." / ".." segments), got "${text$27}"`);
	return text$27;
}
/** Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt. */
function resolveWithin(base, rel) {
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(`${base}${sep}`)) throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`);
	return abs;
}
/** Lowercase SHA-256 hex over exact bytes — the content identity primitive (P2). */
function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/**
* The production skill target as it stands right now (P3): null when nothing
* is there, otherwise the exact bytes plus their SHA-256. Read through the same
* component walk as the ledger root (`walkVerified`, shared with the skill
* sidecar loader in task-runtime), so a production path that became a
* directory, or that is a symbolic link (the file itself or an ancestor), is a
* conflict the caller refuses — never a silent follow.
*/
async function readProductionSkill(skillRoot, name) {
	const walked = await walkVerified(skillRoot, join(name, "SKILL.md"));
	if (walked.missing) return null;
	const bytes = await readFile(walked.abs);
	return {
		bytes,
		sha256: sha256Hex(bytes)
	};
}
/**
* Validate a candidate's mutation against the proposal's targetType. The four
* mechanical types have fixed schemas and every path field is checked to stay
* inside the sandbox; the five other types take any structured object and are
* bookkeeping-only (mechanical: false).
*/
function validateMutation(targetType, mutation, baseVersion) {
	if (!isRecord$2(mutation)) throw new Error("evolution: mutation must be an object");
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
				if (!isRecord$2(file)) throw new Error(`evolution: mutation.files[${index}] must be an object`);
				assertOnlyKeys(file, ["path", "content"], `mutation.files[${index}]`);
				assertSandboxPath(file.path, `mutation.files[${index}].path`);
				nonEmpty(file.content, `mutation.files[${index}].content`);
			});
			return;
		case "capability":
			assertOnlyKeys(mutation, ["name", "entry"], "capability mutation");
			nonEmpty(mutation.name, "mutation.name");
			if (!isRecord$2(mutation.entry)) throw new Error("evolution: mutation.entry must be an object");
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
			if (!isRecord$2(mutation.definition) || Object.keys(mutation.definition).length === 0) throw new Error("evolution: mutation.definition must be a non-empty object (the new version's definition fields)");
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
	if (!isRecord$2(versionSet)) throw new Error("evolution: versionSet must be an object");
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
	if (!isRecord$2(answers)) throw new Error("evolution: gate answers must be an object");
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
function parseChampionEntry(text$27, name) {
	const line = text$27.split("\n").map((item) => item.trim()).filter((item) => item.length > 0 && !item.startsWith("#")).at(-1);
	if (line === void 0) throw new Error("evolution: the champion capability snapshot carries no entry line");
	const parsed = JSON.parse(line);
	if (!isRecord$2(parsed) || !(name in parsed) || !isRecord$2(parsed[name])) throw new Error(`evolution: the champion capability snapshot does not hold an entry for "${name}"`);
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
/**
* The entries of a candidate's own directory beyond the one file the skill
* executor writes — `SKILL.md`'s siblings, a directory read as `name/`, sorted.
* Empty for a single-file candidate, and also for a directory that cannot be
* listed: a candidate with nothing there is then refused by the validator with
* the defect its absence deserves (`skill-missing`), not by this boundary.
*/
async function unsupportedCandidateEntries(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.name !== "SKILL.md").map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
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
	*
	* A skill candidate additionally records `skillContent` (P2): the name plus
	* the SHA-256 of the exact bytes of the file that was actually materialized
	* (read back from disk, never re-rendered from the mutation string), so
	* replay, the gates, and apply can verify this exact content later. The same
	* single read of the production file also yields `skillBaseline` (P3), the
	* digest the later apply compares the production target against.
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
		let skillContent;
		let skillBaseline;
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
			skillBaseline = written.skillBaseline;
			files = written.files;
			if (current.targetType === "skill") {
				const { name } = mutation;
				skillContent = {
					name,
					sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`))
				};
			}
		}
		await this.append({
			formatVersion: 1,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical,
			champion: championState,
			...championSource === void 0 ? {} : { championSource },
			...skillContent === void 0 ? {} : { skillContent },
			...skillBaseline === void 0 ? {} : { skillBaseline },
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
	*
	* For a skill candidate the service additionally binds the content identity
	* (P2): the report must carry the same `candidateContent` prepare recorded,
	* and the candidate file on disk must still hash to it. The tool re-checks
	* before it runs anything; this check runs after the runs and before the
	* record is written, so a modification that happened and persisted during
	* the replay is refused instead of recorded.
	*/
	async replay(proposalId, actor, report) {
		const current = await this.assertNext(proposalId, "replayed");
		assertReplayReport(current, report);
		const sandbox = current.prepared?.sandbox;
		if (sandbox === void 0 || sandbox === null) throw new Error(`evolution: proposal "${proposalId}" names no sandbox; cannot place the replay report`);
		if (current.targetType === "skill") await this.assertSkillContentBound(current, report);
		const rel = `${sandbox}/replay-report.json`;
		const abs = resolveWithin(this.root, rel);
		await mkdir(dirname(abs), { recursive: true });
		const content = `${JSON.stringify(report, null, 2)}\n`;
		await writeFile(abs, content, "utf8");
		await this.append({
			formatVersion: 1,
			kind: "replayed",
			proposalId,
			reportDigest: createHash("sha256").update(content).digest("hex"),
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
	* The skill replay's content binding (P2), enforced on the service entry that
	* writes the `replayed` record: the report's identity must equal the one
	* prepare recorded, and the candidate file must still be those exact bytes.
	* A candidate prepared before content binding, or one that changed and stayed
	* changed, is refused with the same guidance — fix the candidate through a
	* new proposal and evaluation; the append-only ledger never re-digests an old
	* record.
	*/
	async assertSkillContentBound(proposal, report) {
		const identity = proposal.prepared?.skillContent;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" was prepared before candidate content binding — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		if (report.candidateContent === void 0) throw new Error("evolution: a skill replay report must carry candidateContent { name, sha256 }");
		if (report.candidateContent.name !== identity.name || report.candidateContent.sha256 !== identity.sha256) throw new Error(`evolution: replay report candidate content identity { name: "${report.candidateContent.name}", sha256: ${report.candidateContent.sha256} } does not match the identity prepared for proposal "${proposal.proposalId}" { name: "${identity.name}", sha256: ${identity.sha256} }`);
		await this.readVerifiedSkillCandidate(proposal);
	}
	/**
	* Move candidate → gated (manual candidates), prepared → gated
	* (bookkeeping-only mutations), or replayed → gated (mechanical mutations):
	* all six Gate answers plus regression evidence refs. Every ref must exist —
	* a path on disk (relative to the repo root or absolute) or an id the
	* caller-side resolver knows (task-store evidence). Existence only; nothing
	* here executes anything. A replayed proposal must additionally cite its
	* replay report path; its contents must match the recorded digest and schema.
	*/
	async gate(proposalId, answers, actor, refKnown) {
		const current = await this.assertNext(proposalId, "gated");
		validateGateAnswers(answers);
		if (current.replayed !== void 0) {
			const report = current.replayed.report;
			if (!answers.regressionEvidenceRefs.includes(report)) throw new Error(`evolution: a replayed candidate's regression evidence must cite the replay report "${report}"`);
			if (!existsSync(resolveWithin(this.root, report))) throw new Error(`evolution: the replay report "${report}" no longer exists under the ledger root`);
			await this.readRecordedReplay(current);
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
		if (decision === "PROMOTE") await this.checkPromotion(proposalId);
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
	*
	* A skill apply re-verifies the production baseline (P3) after the human
	* grant and immediately before the write: the production target must still be
	* the one prepare recorded. A direct service call therefore cannot bypass the
	* check the tool already ran before asking for approval.
	*
	* The promotion check (S1-C item 3) runs here too, immediately before the
	* write and after the grant: a candidate whose provider role changed while the
	* human was deciding (a sidecar that appeared in the sandbox, a capability row
	* whose skill stopped being reachable, a verifier that was unregistered) is
	* refused here, so no entry can write something a later admission would have
	* refused.
	*/
	async apply(proposalId, actor, approvalRef) {
		const current = await this.assertNext(proposalId, "applied");
		nonEmpty(approvalRef, "approvalRef");
		const promotion = await this.checkPromotion(proposalId);
		await this.checkProductionBaseline(proposalId);
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
			providers: promotion.providers,
			proposal: await this.get(proposalId)
		};
	}
	/**
	* Preflight for tools before asking for approval; mutation methods repeat the
	* check. Returns the providers the promotion would put in place, each with the
	* role it may be counted as (an empty list for a target type that carries
	* none), so the callers that already gate on this check can report them.
	*
	* Three checks run here, in this order, all of them shared with the service
	* entry the tools ultimately call:
	*
	* 1. P2: the candidate bytes must still be the ones prepare recorded.
	* 2. The replay gate (`assertReplayPromotable`).
	* 3. S1-C item 3: the provider check. A skill candidate's sandbox directory and
	*    a capability candidate's new row are judged by the same
	*    {@link validateSkillProvider} admission, config load and capability
	*    replacement use, so `evolution_apply` is not the only entry that knows
	*    what a usable provider is — and a candidate carrying an execution
	*    sidecar with an unregistered verifier or ungranted tools is refused here,
	*    before a human is asked, before `decided` is recorded, and before
	*    anything is written.
	*/
	async checkPromotion(proposalId) {
		const proposal = await this.get(proposalId);
		if (proposal.prepared?.mechanical !== true) return { providers: [] };
		if (proposal.targetType === "skill") await this.readVerifiedSkillCandidate(proposal);
		assertReplayPromotable(await this.readRecordedReplay(proposal));
		return { providers: await this.assertProvidersPromotable(proposal) };
	}
	/**
	* The promotion-time provider check (S1-C item 3): what the promotion would
	* put in place, judged as a provider before it becomes production state.
	*
	* - `skill`: the materialized candidate directory
	*   (`sandbox/<id>/skills/<name>/`) is read as a skill directory and judged
	*   against the deployment's own sources — the effective capability table and
	*   the registered verifier vocabulary. Nothing is discovered from a root: the
	*   candidate is exactly the directory this promotion would write.
	* - `capability`: the row as it will read after the replacement is checked by
	*   the admission pre-check itself, over the table the replacement produces
	*   and the harness process's own discovery roots (the row's own tool labels
	*   expand through the same `resolveCapabilities` admission uses, which is what
	*   makes them the covering set for a skill that declares this row). Whichever
	*   skill the row grants must be reachable and usable from that viewpoint, or
	*   the row is refused rather than written and refused later at admission.
	* - every other target type carries no provider: nothing to judge.
	*
	* What the verdict means, in the vocabulary the whole system uses
	* (`sidecar.ts`): only an execution sidecar whose verifier is registered and
	* whose required tools its declared capabilities grant may be counted as an
	* execution provider; knowledge and guidance are loadable and are recorded as
	* such; anything else is a refusal naming every defect. None of it writes,
	* and nothing is recorded before the caller's own transition.
	*/
	async assertProvidersPromotable(proposal) {
		if (proposal.targetType === "skill") return [await this.assertSkillCandidateProvider(proposal)];
		if (proposal.targetType === "capability") return this.assertCapabilityRowProviders(proposal);
		return [];
	}
	/**
	* The candidate skill's provider verdict, taken from the directory the
	* promotion would write — plus the executor boundary this promotion cannot
	* cross.
	*
	* The boundary: `writeProduction` promotes a **single `SKILL.md`**, so a
	* candidate whose directory carries anything else (`SKILL.contract.json`, a
	* `references/` or `scripts/` tree, any other file) is refused here by name.
	* The executor is not being extended to multi-file candidates; what is being
	* refused is the promotion of a candidate whose declaration or resources
	* production would never receive — a promotion that reported an
	* `execution-provider` role (or a content identity covering files nobody
	* wrote) for content that does not exist is exactly the false record this
	* refusal prevents.
	*
	* Both the shape and the declaration are named when both are wrong: the
	* validator's own defects stay in the message with their codes, so this entry
	* reports the same defect vocabulary admission, config load and capability
	* replacement report for the same directory.
	*/
	async assertSkillCandidateProvider(proposal) {
		const sandbox = proposal.prepared?.sandbox;
		const { name } = proposal.mutation;
		if (sandbox == null) throw new Error(`evolution: proposal "${proposal.proposalId}" names no sandbox; the candidate's provider role cannot be judged`);
		const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`);
		const unsupported = await unsupportedCandidateEntries(directory);
		const verdict = await this.providerVerdict({
			name,
			directory
		});
		const defects = verdict.valid ? "" : verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
		if (unsupported.length > 0) throw new Error(`evolution: skill candidate "${name}" at ${directory} carries ${unsupported.map((entry) => JSON.stringify(entry)).join(", ")} — the skill executor promotes single-file SKILL.md candidates only, so a sidecar or resource this promotion would not write is refused rather than silently dropped${verdict.valid ? "" : `; the declared provider is unusable too — ${defects}`}`);
		if (!verdict.valid) throw new Error(`evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant`);
		return promotionProviderOf(verdict);
	}
	/**
	* One provider candidate judged by the unified validator, with the sources the
	* deployment actually has:
	*
	* - the effective capability table (the runtime registry — what a restart
	*   re-reads from `config.yml`), asked through `capabilityToolQuery`, so a
	*   capability's grant is read by the same resolution admission performs;
	* - the registered verifier vocabulary, `ready()` first, fail-closed: an
	*   execution sidecar whose ref cannot be proven registered against a live
	*   registry is refused with the same named defect the admission pre-check
	*   uses rather than assumed valid.
	*
	* A context with no runtime registry at all answers every capability question
	* as unreadable instead of as "granting nothing": an execution provider is then
	* refused (fail-closed), while knowledge and guidance — which make no tool
	* claim — are judged by the same validator as everywhere else.
	*/
	async providerVerdict(candidate) {
		const verifierRefs = await registeredVerifierIds(this.ctx);
		if (verifierRefs === void 0 && candidate.directory !== void 0) {
			const loaded = await loadSkillSidecar(candidate.directory);
			if (loaded.sidecar?.type === "execution") return unlistableVerifierRefusal(candidate.name, candidate.directory, loaded.sidecar.verifier.ref);
		}
		return validateSkillProvider(candidate, {
			verifierRefs: verifierRefs === void 0 ? [] : [...verifierRefs],
			capabilityTools: this.capabilityToolAnswer()
		});
	}
	/**
	* The capability table this service judges providers against: the running
	* registry, which is the table a restart re-reads from `config.yml` and the one
	* `evolution_prepare` snapshots the champion from. Absent (no task-runtime in
	* this context) means the table cannot be read — reported as an unreadable
	* grant rather than mistaken for an empty table.
	*/
	capabilityToolAnswer() {
		const table = this.effectiveCapabilities();
		if (table !== void 0) return capabilityToolQuery(table);
		return () => ({
			known: false,
			reason: "the effective capability registry cannot be read in this context (no task-runtime service), so the tools this capability grants cannot be resolved"
		});
	}
	/**
	* The row a capability promotion would write, checked as the pre-check checks
	* a row: the replacement is folded into the effective table, and every skill
	* the new row grants is discovered from the harness process's own roots and
	* judged by {@link validateSkillProvider} — `verifierRefs` from the live
	* registry, the row's own tool labels expanding through `resolveCapabilities`
	* as the covering set. A refusal names the capability, the skill and every
	* defect, and nothing is written.
	*/
	async assertCapabilityRowProviders(proposal) {
		const { name, entry } = proposal.mutation;
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: capability "${name}" cannot be promoted: the effective capability registry cannot be read in this context (no task-runtime service), so the providers the new row would grant cannot be judged`);
		const verifierRefs = await registeredVerifierIds(this.ctx);
		const { precheck, refusals } = await precheckReplacedCapabilityRow({
			name,
			entry,
			table,
			view: { cwd: process.cwd() },
			...verifierRefs === void 0 ? {} : { verifierRefs }
		});
		if (refusals.length > 0) throw new Error(`evolution: capability "${name}" cannot be promoted — the row it would write grants providers that are not usable:\n` + refusals.map((line) => `- ${line}`).join("\n"));
		return precheck.capabilities.flatMap((row) => row.skills).filter((verdict) => verdict.valid).map((verdict) => promotionProviderOf(verdict));
	}
	/** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
	effectiveCapabilities() {
		const runtime = optionalService(this.ctx, "taskRuntime");
		try {
			return runtime?.listCapabilities?.();
		} catch {
			return;
		}
	}
	/**
	* Read a prepared skill candidate's materialized bytes and verify them
	* against the content identity recorded at prepare (P2). The one read path
	* every stage shares: the replay tool's pre-execution check, the `replayed`
	* record's post-execution recheck, every promotion gate, and the apply write.
	* Throws — never silently re-digests — when the candidate file is missing,
	* is not a regular file, its path crosses a symbolic link, or its bytes no
	* longer match the recorded digest.
	*/
	async readSkillCandidate(proposalId) {
		return this.readVerifiedSkillCandidate(await this.get(proposalId));
	}
	/**
	* The production-baseline check (P3), on the apply seams only: the
	* evolution_apply tool runs it before asking a human, and `apply` runs it
	* again immediately before the production write, so a baseline that moved
	* while the human was deciding is still refused and a direct service call
	* cannot bypass it. Nothing here writes, merges, or overwrites — a conflict
	* only throws.
	*
	* `captured` requires a real regular file whose bytes still hash to the
	* digest prepare recorded; `missing` requires the target to still be absent.
	* A file that appeared, changed, disappeared, changed type (now a directory),
	* or sits behind a symbolic link (the file itself or an ancestor) is a
	* conflict. Only `targetType: skill` carries a baseline; every other
	* targetType passes untouched.
	*/
	async checkProductionBaseline(proposalId) {
		await this.assertProductionBaseline(await this.get(proposalId));
	}
	async assertProductionBaseline(proposal) {
		if (proposal.targetType !== "skill") return;
		const prepared = proposal.prepared;
		if (prepared?.mechanical !== true || prepared.sandbox == null) return;
		const { name } = proposal.mutation;
		const target = `${this.skillRoot}/${name}/SKILL.md`;
		const guidance = "create a new candidate from the current production state and re-evaluate it; an apply never overwrites a production skill it cannot verify";
		let current;
		try {
			current = await readProductionSkill(this.skillRoot, name);
		} catch (error) {
			throw new Error(`evolution: the production skill "${target}" is no longer a readable regular file (${error.message.replace(/^evolution: /, "")}) — ${guidance}`);
		}
		if (prepared.champion === "missing") {
			if (current !== null) throw new Error(`evolution: skill proposal "${proposal.proposalId}" was prepared with no production "${target}", but the file exists now (sha256 ${current.sha256}) — ${guidance}`);
			return;
		}
		const identity = prepared.skillBaseline;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no production baseline identity (it was prepared before the baseline was recorded) — ${guidance}`);
		if (current === null) throw new Error(`evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`);
		if (current.sha256 !== identity.sha256) throw new Error(`evolution: the production skill "${target}" changed since prepare (sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`);
	}
	async readVerifiedSkillCandidate(proposal) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`);
		const sandbox = proposal.prepared?.sandbox;
		const identity = proposal.prepared?.skillContent;
		if (sandbox == null || identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — it was prepared before content binding; propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized SKILL.md)`);
		const rel = `${sandbox}/skills/${identity.name}/SKILL.md`;
		const bytes = await readVerifiedFile(this.root, rel);
		const digest = sha256Hex(bytes);
		if (digest !== identity.sha256) throw new Error(`evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare (sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		return bytes;
	}
	async readRecordedReplay(proposal) {
		const replay = proposal.replayed;
		if (replay?.reportDigest === void 0) throw new Error("evolution: replay has no report digest; run a new candidate replay before promotion");
		const content = await readFile(resolveWithin(this.root, replay.report), "utf8");
		if (createHash("sha256").update(content).digest("hex") !== replay.reportDigest) throw new Error("evolution: replay report changed after recording; candidate must be evaluated again");
		const report = JSON.parse(content);
		assertReplayReport(proposal, report);
		return report;
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
				if (direction === "apply") {
					const bytes = await this.readVerifiedSkillCandidate(proposal);
					await mkdir(dirname(dst), { recursive: true });
					await writeFile(dst, bytes);
					return { targets: [dst] };
				}
				const content = await readVerifiedFile(this.root, `${sandbox}/champion/skills/${name}/SKILL.md`);
				await mkdir(dirname(dst), { recursive: true });
				await writeFile(dst, content);
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
				const text$27 = await readFile(this.configFile, "utf8");
				let row;
				let edited;
				if (direction === "apply") {
					row = entry;
					edited = editCapabilityRow(text$27, name, row);
				} else if (champion === "missing") {
					row = null;
					edited = editCapabilityRow(text$27, name, null);
				} else if (proposal.prepared?.championSource === "config-text") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = restoreCapabilityRowSource(text$27, name, await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.source.txt`), "utf8"));
				} else if (proposal.prepared?.championSource === "code-default") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text$27, name, null);
				} else {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text$27, name, row);
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
		let text$27;
		try {
			text$27 = await readFile(this.configFile, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		return readCapabilityRowSource(text$27, name);
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
	* config.yml row's verbatim source text when the row exists there. A skill
	* champion is read exactly once (P3): those bytes become both the snapshot
	* and the recorded `skillBaseline` digest, so the two can never describe two
	* different reads of the production file.
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
				const production = await readProductionSkill(this.skillRoot, name);
				if (production === null) return {
					files,
					champion: "missing"
				};
				await write(`champion/skills/${name}/SKILL.md`, production.bytes.toString("utf8"));
				return {
					files,
					champion: "captured",
					skillBaseline: {
						name,
						sha256: production.sha256
					}
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
					if (record.skillContent !== void 0) {
						if (current.targetType !== "skill") throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillContent but targetType "${current.targetType}" is not skill`);
						if (!isRecord$2(record.skillContent) || typeof record.skillContent.name !== "string" || record.skillContent.name.length === 0 || typeof record.skillContent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillContent.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillContent identity`);
					}
					if (record.skillBaseline !== void 0) {
						if (current.targetType !== "skill") throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillBaseline but targetType "${current.targetType}" is not skill`);
						if (!isRecord$2(record.skillBaseline) || typeof record.skillBaseline.name !== "string" || record.skillBaseline.name.length === 0 || typeof record.skillBaseline.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillBaseline.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillBaseline identity`);
					}
					current.prepared = {
						sandbox: record.sandbox,
						mechanical: record.mechanical,
						champion: record.champion,
						...record.championSource === void 0 ? {} : { championSource: record.championSource },
						...record.skillContent === void 0 ? {} : { skillContent: {
							name: record.skillContent.name,
							sha256: record.skillContent.sha256
						} },
						...record.skillBaseline === void 0 ? {} : { skillBaseline: {
							name: record.skillBaseline.name,
							sha256: record.skillBaseline.sha256
						} },
						files: [...record.files]
					};
					break;
				}
				case "replayed":
					if (typeof record.report !== "string" || record.report.length === 0) throw new Error(`evolution: replayed record for "${record.proposalId}" has no report path`);
					if (!REPLAY_VERDICTS.includes(record.verdict)) throw new Error(`evolution: replayed record for "${record.proposalId}" has unknown verdict "${String(record.verdict)}"`);
					if (!Array.isArray(record.tasks) || record.tasks.some((item) => !isRecord$2(item) || typeof item.taskId !== "string" || !REPLAY_RELATIONS.includes(item.relation) || typeof item.holdout !== "boolean")) throw new Error(`evolution: replayed record for "${record.proposalId}" has a malformed task summary`);
					if (record.reportDigest !== void 0 && !/^[a-f0-9]{64}$/.test(record.reportDigest)) throw new Error(`evolution: replayed record for "${record.proposalId}" has an invalid report digest`);
					current.replayed = {
						report: record.report,
						verdict: record.verdict,
						tasks: record.tasks.map((item) => ({ ...item })),
						...record.reportDigest === void 0 ? {} : { reportDigest: record.reportDigest }
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
		let text$27;
		try {
			text$27 = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text$27.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
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
//#region src/proposal-review.ts
/** The prefix `rootTaskStoreId` writes; see {@link ownerSessionOfStore} for why it is re-checked rather than trusted. */
const STORE_PREFIX = "sg-t-";
/** The tool name a batch review's question is about: the decomposition the batch would become (audit and presentation). */
const BATCH_REVIEW_TOOL_NAME = "task_decompose";
/**
* The tool name a root contract review's question is about: the intake that
* submitted the contract. A root contract is nobody's decomposition, so a card
* labelled `task_decompose` would ask a person about a call that was never made.
*/
const ROOT_REVIEW_TOOL_NAME = "task_intake";
/**
* The owner session of a task store — whose approval surface a review of that
* store's batches belongs on — or `undefined` for an id this deployment did not
* build.
*
* The parse is re-checked through {@link rootTaskStoreId} rather than trusted:
* the mapping from a root session to its store belongs to the task package, and
* a string that merely looks like one must not name a session that never owned
* a store (which would route a review into a stranger's conversation).
*/
function ownerSessionOfStore(storeId) {
	if (!storeId.startsWith(STORE_PREFIX)) return void 0;
	const sessionId$22 = storeId.slice(5);
	return sessionId$22.length > 0 && rootTaskStoreId(sessionId$22) === storeId ? sessionId$22 : void 0;
}
/**
* The decider identity the channel records: the approval surface of the owner
* session the review was shown in. Deliberately a channel-shaped value — the
* same `approval:` family the native grants use (`escalate`, `evolution_decide`)
* — because a reader of the record must be able to tell a human grant apart
* from a session id and from anything a model could have written.
*/
function reviewDecider(ownerSessionId) {
	return `approval:${ownerSessionId}`;
}
/** How a container field is listed, or that it held nothing — never an omitted line a reader has to notice. */
function listField(title, items, empty) {
	if (items.length === 0) return [`  ${title}: ${empty}`];
	return [`  ${title}:`, ...items.map((item) => `  - ${item}`)];
}
/**
* The protected acceptance inputs a criterion declares, with the identity fixed
* at submission: a reviewer has to see that they are protected *and* which bytes
* were fixed, because the verifier re-reads exactly these before judging.
*/
function protectedInputsPart$1(criterion) {
	const declared = criterion.protectedInputs ?? [];
	if (declared.length === 0) return "";
	return ` [protected inputs: ${declared.map((ref) => `${ref.path} sha256:${ref.sha256}`).join(", ")}]`;
}
/** The evidence and artifact requirements a criterion declares, as one suffix — omitted entirely when it declares none. */
function requirementParts(criterion) {
	const parts = [];
	if (criterion.requiredEvidence.length > 0) parts.push(`required evidence: ${criterion.requiredEvidence.join(", ")}`);
	if ((criterion.requiresArtifact ?? []).length > 0) parts.push(`requires verified artifact: ${criterion.requiresArtifact.join(", ")}`);
	if ((criterion.acceptsArtifact ?? []).length > 0) parts.push(`accepts artifact: ${criterion.acceptsArtifact.join(", ")}`);
	if (criterion.childEvidence !== void 0 && criterion.childEvidence.length > 0) parts.push(`child evidence: ${criterion.childEvidence.map((item) => `child ${item.childIndex}${item.criterionId === void 0 ? "" : `:${item.criterionId}`}${item.evidenceRef === void 0 ? "" : `#${item.evidenceRef}`}`).join(", ")}`);
	return parts;
}
/**
* How a criterion reads to a reviewer: its id, its mode, whether it is mandatory,
* whether it is a heuristic judgement (which never counts as a deterministic
* pass — §5 requires the marking, not a footnote), what it says, and what it
* pins (command, named verifier, protected inputs, artifact requirements).
*
* `indent` is the caller's, because the same criterion line is read under a
* child of a batch and under a root contract: the marking is the subject, the
* depth is the caller's business.
*/
function criterionLine(criterion, indent = "    ") {
	const qualifiers = [
		criterion.verificationMode,
		...criterion.mandatory ? ["mandatory"] : ["optional"],
		...criterion.heuristic === true ? ["heuristic — judged by a model, never a deterministic pass"] : []
	];
	const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
	const verifier = criterion.verifierRef === void 0 ? "" : ` [verifier: ${criterion.verifierRef}]`;
	const requirements = requirementParts(criterion);
	const requirementText = requirements.length === 0 ? "" : ` [${requirements.join("; ")}]`;
	return `${indent}- ${criterion.criterionId} [${qualifiers.join(", ")}] ${criterion.description}${command}${verifier}${protectedInputsPart$1(criterion)}${requirementText}`;
}
/**
* How one declared capability resolved when this batch was proposed: the
* manifest the runtime built for *this* child, with the skills and tools a
* worker would be granted — and the capability gap named when a requirement is
* not in the registry, rather than silently absent (§5's 声明能力及当前解析).
*
* `undefined` is the honest answer for a request that carried no manifest for
* this child: the resolution is then not shown at all, and nothing is claimed
* about it.
*/
function resolutionLines(manifest) {
	if (manifest === void 0) return [];
	const entries = Object.entries(manifest.capabilities);
	if (entries.length === 0 && manifest.missing.length === 0) return [];
	const lines = entries.map(([name, entry]) => {
		const parts = [
			...entry.skills.length === 0 ? [] : [`skills: ${entry.skills.join(", ")}`],
			...entry.tools.length === 0 ? [] : [`tools: ${entry.tools.join(", ")}`],
			...entry.preset === void 0 ? [] : [`preset: ${entry.preset}`],
			...entry.permission === void 0 ? [] : [`permission: ${entry.permission}`],
			...entry.mcpServers === void 0 || entry.mcpServers.length === 0 ? [] : [`mcp servers: ${entry.mcpServers.join(", ")}`]
		];
		return `  - ${name} → ${parts.length === 0 ? "granted no skill or tool" : parts.join("; ")}`;
	});
	const missing = manifest.missing.map((name) => `  - ${name} → NOT GRANTED (capability gap: the registry has no such row, and this batch's admission recorded it)`);
	return [
		"  resolution (the manifests this batch resolved to):",
		...lines,
		...missing
	];
}
/**
* One child of the batch as a reviewer reads it (§5): its goal, its criteria,
* what it inherits as assumptions and constraints, what it waits for, what it
* requires, and how those requirements currently resolve.
*
* `dependsOn` names the sibling objective as well as the index: a batch whose
* ordering matters must not require a reviewer to count positions.
*/
function renderProposalChild(child, options) {
	const contract = child.contract;
	const verifierRefs = [...new Set(contract.acceptanceCriteria.flatMap((criterion) => criterion.verifierRef ?? []))];
	const dependencies = child.dependsOn.map((index) => {
		const sibling = options.siblings[index];
		return `child ${index}${sibling === void 0 ? "" : ` (${sibling.contract.objective})`}`;
	});
	return [
		`- child ${options.index}: ${contract.objective}`,
		...options.contractDigest === void 0 ? [] : [`  contract digest (sha256): ${options.contractDigest}`],
		`  contract version: ${contract.contractVersion}`,
		"  acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => criterionLine(criterion)),
		...verifierRefs.length === 0 ? [] : [`  pinned verifiers: ${verifierRefs.join(", ")}`],
		...listField("assumptions", contract.assumptions, "(none declared — the contract rests on nothing stated)"),
		...listField("constraints", contract.constraints, "(none declared)"),
		...listField("required capabilities", contract.requiredCapabilities, "(none)"),
		...resolutionLines(options.manifest),
		...listField("depends on", dependencies, "(nothing — this child may start first)"),
		`  decomposable: ${child.decomposable ? "yes" : "no"}; requires independent acceptance: ${child.requiresIndependentAcceptance ? "yes" : "no"}`
	];
}
/**
* The complete batch content of a stored proposal, one block per child in batch
* order — the whole set, never a prefix. `manifests`, when a caller has them,
* are the resolution recorded with the request and are aligned with the
* children positionally.
*
* The parameter is the decomposition arm of {@link TaskProposal} on purpose: a
* root contract has no batch, and a renderer that could still be handed one
* would be rendering a payload that does not exist as if it did.
*/
function renderProposalChildren(proposal, manifests) {
	return proposal.batch.flatMap((child, index) => [...renderProposalChild(child, {
		index,
		siblings: proposal.batch,
		...proposal.identity.children[index]?.contractDigest === void 0 ? {} : { contractDigest: proposal.identity.children[index].contractDigest },
		...manifests?.[index] === void 0 ? {} : { manifest: manifests[index] }
	}), ""]);
}
/**
* One root contract as a reviewer reads it (§5's display list for the subject
* that has no parent): the contract version, the objective, every criterion
* with the markings {@link criterionLine} prints, the assumptions and
* constraints it rests on, the capabilities it declares, and — when the caller
* has them — the resolution this intake recorded, whose single manifest covers
* the contract's declared capabilities.
*
* A pure rendering of the contract it is given: it shows what the record holds
* and nothing about a parent, a batch or a task, because none of those exist
* while a root contract waits.
*/
function renderRootContract(contract, manifests) {
	return [
		`- contract version: ${contract.contractVersion}`,
		`- objective: ${contract.objective}`,
		"- acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => criterionLine(criterion, "  ")),
		...listField("assumptions", contract.assumptions, "(none declared — the contract rests on nothing stated)"),
		...listField("constraints", contract.constraints, "(none declared)"),
		...listField("required capabilities", contract.requiredCapabilities, "(none)"),
		...resolutionLines(manifests?.[0])
	];
}
/** The limits one proposal was admitted under, as the record holds them, with the enforced and the audited values kept apart. */
function limitLines(proposal) {
	const context = proposal.admissionContext;
	const audited = [
		...context.auditOnly.maxToolCalls === void 0 ? [] : [`maxToolCalls ${context.auditOnly.maxToolCalls}`],
		...context.auditOnly.tokens === void 0 ? [] : [`tokens ${context.auditOnly.tokens}`],
		...context.auditOnly.attempts === void 0 ? [] : [`attempts ${context.auditOnly.attempts}`]
	];
	return [
		`- enforced at admission: maxDepth ${context.maxDepth}, maxChildren ${context.maxChildren}`,
		`- enforced in flight: ${context.wallTimeMs === void 0 ? "no wall-clock ceiling was configured" : `wallTimeMs ${context.wallTimeMs}`}`,
		`- audited after the run (never enforced in flight): ${audited.length === 0 ? "none configured" : audited.join(", ")}`
	];
}
/**
* The review material one person is shown (§5), rendered from the saved facts:
* for a batch, the parent, every child, the limits, the obligations, the
* identity a decision binds and what this record honestly cannot promise; for a
* root contract, the contract itself and no parent at all — the task it becomes
* does not exist while it waits.
*
* The subject is discriminated by kind, and the two arms share every part that
* means the same thing in both (the limits, the identity, the boundary
* statements): a reviewer deciding a root intake is answering a different
* question, not reading a one-child batch of nobody.
*
* A pure function of the request, so what a deployment shows and what a test
* asserts are the same rendering.
*/
function renderProposalReview(request) {
	return request.kind === "root" ? renderRootReview(request) : renderBatchReview(request);
}
/**
* The identity a decision binds, as both subjects print it: the three digests,
* the resolution, the key and the submission time. `subject` only names what
* the pinned verifiers belong to.
*/
function identityLines(proposal, subject, registeredVerifiers) {
	return [
		`- proposal digest (sha256): ${proposal.proposalDigest}`,
		`- admission context digest (the limits above): ${proposal.admissionContextDigest}`,
		`- review context digest (the resolution above): ${proposal.reviewContextDigest}`,
		`- capability manifest digest: ${proposal.reviewContext.capabilityManifestDigest}`,
		`- judging verifiers (the ids this ${subject}'s criteria pin): ${proposal.reviewContext.verifiers.length === 0 ? "(none pinned — criteria dispatch by mode)" : proposal.reviewContext.verifiers.map((verifier) => verifier.verifierId).join(", ")}`,
		...registeredVerifiers === void 0 ? ["- the deployment could not list its verifier registry when this review was requested"] : [`- registered verifiers now: ${registeredVerifiers.join(", ")}`],
		`- request key: ${proposal.requestKey}`,
		...proposal.supersedes === void 0 ? [] : [`- supersedes: ${proposal.supersedes}`],
		`- submitted at: ${proposal.createdAt}`
	];
}
/**
* The obligations a review lists, as the request carried them. An empty list is
* printed as one line rather than omitted: "nothing is on record" is what a
* reviewer has to be able to read, and a root contract has no task to raise one
* on, so its list is empty by construction rather than by omission.
*/
function reviewObligationLines(obligations) {
	return obligations.length === 0 ? ["(none recorded when this review was requested)"] : obligations.map((obligation) => `- ${obligation.obligationId}: ${obligation.goal} — judged by: ${obligation.criterion}`);
}
/** The review of a decomposition batch (T2/T3 §5): the parent's own goal, every child, the limits and the obligations on the parent. */
function renderBatchReview(request) {
	const proposal = request.proposal;
	if (proposal.kind === "root") throw new Error(`proposal-review: proposal "${proposal.proposalId}" is a root contract, which a batch review cannot carry`);
	const parent = request.parentTask;
	return [
		`Batch review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
		`store: ${request.storeId}`,
		"",
		"A decision answers one question: should this batch run as it is written here? Approving it does not mean the work is",
		"accepted (the verifiers still judge every criterion), does not grant a capability, and does not close a gap. The",
		"decision binds the batch digest and both context fingerprints printed below: a revision, a re-resolution or a",
		"changed limit is a different proposal.",
		"",
		"## Parent task",
		`- ${parent.taskId} [${parent.status}/${parent.decompositionStatus}] depth ${parent.depth}`,
		`- objective: ${parent.objective}`,
		"- acceptance criteria:",
		...parent.acceptanceCriteria.map((criterion) => `  - ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ", mandatory" : ""}] ${criterion.description}`),
		`- run: ${proposal.identity.parentRunId} (proposing session ${proposal.identity.callerSessionId})`,
		`- reason recorded for this batch: ${proposal.identity.reason}`,
		"",
		`## Children (${request.batch.children.length})`,
		...renderProposalChildren(proposal, request.manifests),
		"## Limits this batch is admitted under",
		...limitLines(proposal),
		"",
		`## Unmet obligations on the parent (${request.obligations.length})`,
		...reviewObligationLines(request.obligations),
		"",
		"## Identity — what an approval would bind",
		...identityLines(proposal, "batch", request.registeredVerifiers),
		"",
		"## What this review cannot promise",
		"- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What a worker",
		"  actually loads is pinned per run at spawn, which happens after this decision.",
		"- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the",
		"  configuration that registration currently stands for.",
		"- a criterion marked heuristic is judged by a model; nothing in this batch turns it into a deterministic pass."
	].join("\n");
}
/**
* The review of a root contract (A0 §3): the goal a root session would be
* admitted as, and no parent section — there is no parent task, and the root
* task this contract becomes does not exist while it waits.
*
* What a decision here binds is the contract: its objective and criteria are
* the goal the whole graph is later judged against, so the rendering walks
* every criterion with the markings §5 requires (mode, mandatory, heuristic,
* protected inputs, the command or verifier it pins) and prints the declared
* capabilities with the resolution this intake recorded.
*/
function renderRootReview(request) {
	const proposal = request.proposal;
	return [
		`Root contract review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
		`store: ${request.storeId}`,
		"",
		"A decision answers one question: should this root contract be accepted as the goal this graph works toward? Approving",
		"it does not mean the work is accepted (the verifiers still judge every criterion), does not grant a capability and does",
		"not close a gap. Nothing exists while it waits — no root task, no run and no worker: the root task is what this contract",
		"becomes once the runtime re-checks and activates it. The decision binds the contract digest and both context",
		"fingerprints printed below: a revision, a re-resolution or a changed limit is a different proposal.",
		"",
		"## Root contract (the goal this session would be admitted as)",
		`- root session: ${request.rootSessionId}`,
		...renderRootContract(request.contract, request.manifests),
		"",
		"## Limits this contract is admitted under",
		...limitLines(proposal),
		"",
		`## Unmet obligations on this root contract (${request.obligations.length})`,
		...reviewObligationLines(request.obligations),
		"",
		"## Identity — what an approval would bind",
		...identityLines(proposal, "contract", request.registeredVerifiers),
		"",
		"## What this review cannot promise",
		"- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What the root run",
		"  actually loads is pinned when it is activated, which happens after this decision.",
		"- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the",
		"  configuration that registration currently stands for.",
		"- a criterion marked heuristic is judged by a model; nothing in this contract turns it into a deterministic pass.",
		"- the objective above is the root agent's reading of the user's request. This card carries the contract, not the request",
		"  it was built from, and machine admission does not prove that reading correct (A0 §1.10)."
	].join("\n");
}
/**
* The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and
* records; it never admits anything itself — a recorded decision is what moves a
* proposal, and the runtime performs the post-approval re-check and the
* admission on its own.
*/
var ProposalReviewService = class extends Service {
	lifetime = new AbortController();
	constructor(ctx) {
		super(ctx, "proposalReviewChannel");
		ctx.effect(() => () => this.lifetime.abort(/* @__PURE__ */ new Error("proposal-review: service disposed")), "proposal-review: pending asks");
	}
	async requestReview(request) {
		const ownerSessionId = ownerSessionOfStore(request.storeId);
		if (ownerSessionId === void 0) return {
			requested: false,
			detail: `store "${request.storeId}" does not name the root session a review has to be shown in, so nobody was asked; the proposal stays pending_review`
		};
		const agent = this.liveAgent(ownerSessionId);
		if (agent === void 0) return {
			requested: false,
			detail: `the owner session "${ownerSessionId}" has no live agent, so nobody was asked; the proposal stays pending_review until a decision is recorded (opening the graph again asks on the next request)`
		};
		if (!this.asksAPerson(agent)) return {
			requested: false,
			detail: `the owner session "${ownerSessionId}" runs with approval policy "never": an ask here is auto-rejected before any answerer sees it, which would record a refusal nobody made. Nobody was asked; the proposal stays pending_review`
		};
		const ask = this.ctx.approval.request({
			agent,
			toolName: request.kind === "root" ? ROOT_REVIEW_TOOL_NAME : BATCH_REVIEW_TOOL_NAME,
			reason: renderProposalReview(request),
			signal: this.lifetime.signal
		});
		let reached;
		try {
			reached = await Promise.race([ask, Promise.resolve("pending")]);
		} catch (error) {
			return {
				requested: false,
				detail: `the approval channel could not ask the owner session "${ownerSessionId}" (${message$1(error)}), so nobody was asked; the proposal stays pending_review`
			};
		}
		if (reached === "pending") {
			ask.then((outcome) => this.record(request, ownerSessionId, outcome)).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the review request to session "${ownerSessionId}" ended without a usable answer (${message$1(error)}); the proposal keeps the status the store holds`));
			return {
				requested: true,
				detail: `the review was put to the owner session "${ownerSessionId}" through the approval channel; the proposal stays pending_review until the decision is recorded, and the runtime continues the batch when it is`
			};
		}
		if (reached === "allowed-once" || reached === "rejected") {
			this.record(request, ownerSessionId, reached).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the answer of session "${ownerSessionId}" could not be recorded (${message$1(error)}); the proposal keeps the status the store holds`));
			return {
				requested: true,
				detail: `the owner session "${ownerSessionId}" answered the review with ${reached === "allowed-once" ? "approval" : "a refusal"}; the decision is being recorded on the proposal`
			};
		}
		return {
			requested: false,
			detail: reached === "cancelled" ? "the review request was withdrawn before a person decided, so no decision was recorded; the proposal stays pending_review" : "no approval answerer was available, so nobody was asked; the proposal stays pending_review"
		};
	}
	/**
	* One human answer, turned into the only thing that can move a waiting
	* proposal: a decision on the record. An approval is recorded as `approved`
	* (the runtime then re-checks the batch and admits it); an explicit refusal as
	* `rejected`, naming who refused. Nothing else is written: `unavailable` and
	* `cancelled` are states of the ask, and §6 allows exactly one decision per
	* proposal — so a store that refuses this write because the proposal moved on
	* meanwhile is warned about, never retried into a second decision.
	*/
	async record(request, ownerSessionId, outcome) {
		const proposalId = request.proposal.proposalId;
		const decidedBy = reviewDecider(ownerSessionId);
		if (outcome === "allowed-once") {
			const result = await this.runtime().decideProposal(request.storeId, proposalId, { outcome: "approved" }, decidedBy);
			this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" approved the batch — ${result.detail}`);
			return;
		}
		if (outcome === "rejected") {
			const result = await this.runtime().decideProposal(request.storeId, proposalId, {
				outcome: "rejected",
				reason: `the owner refused this batch through the approval channel (session "${ownerSessionId}")`
			}, decidedBy);
			this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" refused the batch — ${result.detail}`);
		}
	}
	/** The live agent behind one session, or `undefined` — an absent registry or a departed session is a state, not a throw. */
	liveAgent(sessionId$22) {
		const holder = this.ctx;
		const registry = (typeof holder.get === "function" ? holder.get("agents") : void 0) ?? holder.agents;
		try {
			return registry?.get?.(sessionId$22);
		} catch {
			return;
		}
	}
	/**
	* Whether one session's approval policy asks a person at all. The policy is
	* the approval service's own (a session override, else the configured
	* default): under `never` the service answers `rejected` without dispatching
	* anything, so a request routed there would look like a human refusal.
	* Reading it before asking is what keeps that outcome from being invented.
	*/
	asksAPerson(agent) {
		const service = this.ctx.approval;
		return (service?.overrideOf?.(agent.session) ?? service?.config?.policy ?? "ask") === "ask";
	}
	/** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
	runtime() {
		return this.ctx.taskRuntime;
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message$2) {
		const logger = this.ctx.logger;
		logger?.("proposal-review").warn(message$2);
	}
	/** The same seam at info level, for the trace of a decision that landed. */
	info(message$2) {
		const logger = this.ctx.logger;
		logger?.("proposal-review").info(message$2);
	}
};
function message$1(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/tools/approve.ts
const text$26 = (value) => [{
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
			render: (_a, v) => text$26(v)
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
const text$25 = (value) => [{
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
			render: (_a, v) => text$25(v)
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
const text$24 = (value) => [{
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
/** The first 12 hex of a content digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest) {
	return digest.slice(0, 12);
}
/**
* One skill's provider verdict, in the words the pre-check uses: the role it
* was accepted as — an execution provider, loadable knowledge, plain guidance —
* or `invalid` with every named defect, so a model reading this before it
* dispatches sees the same conclusion admission will reach.
*/
function renderProvider(verdict) {
	if (!verdict.valid) return `${verdict.name} → invalid (${verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")})`;
	if (verdict.role === "execution-provider") {
		const tools = verdict.requiredTools.length === 0 ? "none declared" : verdict.requiredTools.join(", ");
		return `${verdict.name} → execution-provider (verifier: ${verdict.verifierRef}; requires: ${tools}; content: ${shortDigest(verdict.contentDigest)})`;
	}
	if (verdict.role === "knowledge") return `${verdict.name} → knowledge (no execution verifier by design; content: ${shortDigest(verdict.contentDigest)})`;
	return `${verdict.name} → guidance (no sidecar; loadable guidance, not an execution provider; content: ${shortDigest(verdict.contentDigest)})`;
}
/**
* The provider line under one capability row: every skill's verdict, or the
* fact that the row grants none. `rows` is the pre-check's own output, so an
* error message or a missing skill cannot be papered over here.
*/
function renderProviders(row) {
	if (row === void 0) return "providers: (not checked)";
	if (row.skills.length === 0) return "providers: (none — the capability grants no skill)";
	return `providers: ${row.skills.map(renderProvider).join(" · ")}`;
}
function defineCapabilityListTool(ctx) {
	return defineTool({
		name: "capability_list",
		description: "List the capability names the task runtime can grant, with the tools/skills/agent preset each one carries and the provider verdict for every skill it declares. Call this before task_decompose to pick requiredCapabilities: a name outside this list is a capability gap, and the gap rejects the whole decomposition batch unless that child is declared decomposable.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$24(v)
		},
		execute: async (_args, exec) => {
			const capabilities = ctx.taskRuntime.listCapabilities();
			const names = Object.keys(capabilities);
			if (names.length === 0) return "no capabilities configured";
			const caller = exec.agent?.id;
			const report = typeof caller === "string" && caller.length > 0 ? await ctx.taskRuntime.capabilityProviderReport(caller) : void 0;
			const verdicts = new Map((report?.capabilities ?? []).map((row) => [row.capability, row]));
			const lines = names.flatMap((name) => {
				const entry = capabilities[name];
				const mcp = renderMcpServers(entry);
				return [`- ${name} — ${[
					renderTools(entry),
					`skills: [${(entry.skills ?? []).join(", ")}]`,
					...entry.preset !== void 0 ? [`preset: ${entry.preset}`] : [],
					...mcp === "" ? [] : [mcp],
					renderPermission(entry)
				].join(" ")}`, `    ${report === void 0 ? "providers: (not checked — the tool was called without a calling session)" : renderProviders(verdicts.get(name))}`];
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
				"provider verdicts are the same pre-check admission runs, from this session's own skill roots: execution-provider means the skill carries an execution sidecar whose verifier is registered and whose required tools its capabilities grant; knowledge and guidance are loadable but never count as an execution provider; invalid means admission refuses a batch that requires this capability, with the defects shown.",
				...report === void 0 ? [] : [`skill roots searched for this session: ${report.roots.join(", ")}`],
				"mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run's environment checkout; a server that cannot start fails the spawn loudly.",
				"permissions: a capability that declares none leaves the worker on the deployment default (danger-full-access); flipping the default is blocked until worker approvals reliably reach the canvas (#17 in the working guide)."
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/escalate.ts
const text$23 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$21(exec) {
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
			render: (_a, v) => text$23(v)
		},
		execute: async (args, exec) => {
			if (args.list === true) {
				const escalations = await ctx.escalation.list();
				if (escalations.length === 0) return "escalations: none recorded";
				return [`escalations (${escalations.length}):`, ...escalations.map(renderEscalation$1)].join("\n");
			}
			const caller = sessionId$21(exec);
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
const text$22 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$20(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_apply: missing agent id");
	return id;
}
/**
* Why a decided PROMOTE proposal still cannot be applied, per boundary
* L4 and non-materialized surfaces have no production executor yet.
*/
function manualGuidance(proposal) {
	if (proposal.level === "L4") return "L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow";
	if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) return proposal.targetType === "task_definition" ? "task_definition has no production registry to write (the task store keeps denormalized instances only): a definition executor is still required before supervisor candidates can be promoted here" : `${proposal.targetType} mutations are bookkeeping-only (mechanical: false): an executor and target-specific validation are still required; the ledger keeps the record`;
	if (proposal.prepared?.sandbox == null) return "this candidate carried no structured mutation, so nothing was materialized: create a new structured candidate, evaluate it, then request human review";
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
		description: "Apply a PROMOTE-decided EvolutionProposal to production (status: applied). Only the three mechanical types (skill / agent_preset / capability) at L1–L3 with a materialized sandbox; task_definition, the five bookkeeping-only types, and L4 lack executors and are refused with instructions. Always asks a human through the native approval seam first — a second gate after evolution_decide — naming every production path it will write; a reject, cancel, or unavailable answerer writes nothing and leaves the proposal decided. A skill apply additionally re-verifies the production baseline recorded at prepare (the production SKILL.md must still be those exact bytes, or still be absent) before the human is asked and again after the grant, and refuses a stale candidate instead of overwriting a production skill that changed. A skill candidate is promoted as one file: one carrying a SKILL.contract.json or any resource is refused (the executor writes SKILL.md only, so such a candidate would be reported as a provider production never received). skill and agent_preset take effect on write; a capability row is mirrored into the running registry and persists in config.yml. evolution_rollback restores the champion snapshot.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Decided (PROMOTE) proposal to apply to production"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$22(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$20(exec);
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
			let promotion;
			try {
				promotion = await ctx.evolution.checkPromotion(proposal.proposalId);
				await ctx.evolution.checkProductionBaseline(proposal.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const targets = applyTargets(proposal, ctx.evolution);
			const reason = [
				`Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				"recorded decision: PROMOTE",
				"this writes production targets:",
				...targets.map((target) => `  - ${target}`),
				...renderProviderRoles(promotion.providers),
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
					await ctx.taskRuntime.applyCapabilityRow(applied.capability.name, applied.capability.entry);
					runtimeNote = "\nruntime registry row replaced — new admissions in this process use it now";
				} catch (error) {
					runtimeNote = `\nruntime override failed (${error instanceof Error ? error.message : String(error)}) — the config.yml row takes effect on the next restart`;
				}
				return [
					`proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
					"wrote production targets:",
					...applied.targets.map((target) => `  - ${target}`),
					...renderProviderRoles(applied.providers ?? []),
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
const text$21 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$19(exec) {
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
			render: (_a, v) => text$21(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$19(exec);
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
const text$20 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$18(exec) {
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
			render: (_a, v) => text$20(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$18(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_decide: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "gated") return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`;
			let promotion;
			if (args.decision === "PROMOTE") try {
				promotion = await ctx.evolution.checkPromotion(proposal.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
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
				`proposed decision: ${args.decision}${args.note === void 0 ? "" : ` — ${args.note}`}`,
				`this promotion would put in place: ${promotion === void 0 || promotion.providers.length === 0 ? "no provider skill" : renderProviderRoles(promotion.providers).join("; ")}`
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
const text$19 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$17(exec) {
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
			render: (_a, v) => text$19(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$17(exec);
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
const text$18 = (value) => [{
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
			render: (_a, v) => text$18(v)
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
						const contentText = view.skillContent === void 0 ? "" : `, candidate content ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}…`;
						const baselineText = view.skillBaseline === void 0 ? "" : `, production baseline ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}…`;
						lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox} (${view.files.length} files, ${championText}${contentText}${baselineText})`);
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
const text$17 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$16(exec) {
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
			render: (_a, v) => text$17(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$16(exec);
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
				const baselineText = prepared.targetType === "skill" ? view.skillBaseline === void 0 ? "production baseline: none — the production skill does not exist yet (an apply refuses if one appears)" : `production baseline: ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}… (an apply refuses if the production skill changed since this read)` : null;
				return [
					`proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
					...view.files.map((file) => `  wrote ${file}`),
					championText,
					...baselineText === null ? [] : [baselineText],
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
const text$16 = (value) => [{
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
const TARGET_TYPE_SET$1 = new Set(TARGET_TYPES$1);
function isProposalTargetType$1(value) {
	return typeof value === "string" && TARGET_TYPE_SET$1.has(value);
}
function sessionId$15(exec) {
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
			render: (_a, v) => text$16(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$15(exec);
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
			if (!isProposalTargetType$1(targetType)) throw new Error(`evolution_propose: targetType must be one of ${TARGET_TYPES$1.join(" / ")}, got "${String(targetType)}"`);
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
const text$15 = (value) => [{
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
function sessionId$14(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_replay: missing agent id");
	return id;
}
function isRecord$1(value) {
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
	if (!isRecord$1(definition)) throw new Error("evolution_replay: the sandbox task-definition.json must hold an object");
	const rawCriteria = definition.acceptanceCriteria;
	if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) throw new Error("evolution_replay: the candidate definition must carry a non-empty acceptanceCriteria array");
	const acceptanceCriteria = rawCriteria.map((raw, index) => {
		if (!isRecord$1(raw)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}] must be an object`);
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
			render: (_a, v) => text$15(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$14(exec);
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "prepared") return `evolution_replay rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a prepared proposal can be replayed`;
			const prepared = proposal.prepared;
			if (!prepared.mechanical) return `evolution_replay rejected: proposal ${proposal.proposalId} is bookkeeping-only (mechanical: false); nothing to replay — gate it directly with evolution_gate`;
			if (proposal.targetType === "skill") try {
				await ctx.evolution.readSkillCandidate(proposal.proposalId);
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
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
				...proposal.targetType === "skill" ? { candidateContent: prepared.skillContent } : {},
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
const text$14 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$13(exec) {
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
			render: (_a, v) => text$14(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$13(exec);
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
					await ctx.taskRuntime.applyCapabilityRow(rolledback.capability.name, rolledback.capability.entry);
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
const text$13 = (value) => [{
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
			render: (_a, v) => text$13(v)
		},
		execute: async (_args, exec) => {
			const sessionId$22 = exec.agent?.id;
			if (sessionId$22 === void 0) throw new Error("graph_mark_ready: missing agent id");
			const graph = await ctx.graphs.graphForSession(sessionId$22);
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
//#region src/tools/task-cancel.ts
const text$12 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$12(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_cancel: missing agent id");
	return id;
}
function renderOutcome(outcome) {
	const run = outcome.runId === void 0 ? "" : ` run ${outcome.runId}`;
	const evidence = outcome.evidenceId === void 0 ? "" : ` evidence ${outcome.evidenceId}`;
	return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`;
}
function defineTaskCancelTool(ctx) {
	return defineTool({
		name: "task_cancel",
		description: "Cancel the batch of child tasks this run is waiting on. The children still in flight are cancelled, the ones that never started are blocked before start, and this run is cancelled with them — a batch that cannot finish is ended here, never left hanging. Only the run whose own batch it is may cancel it, and only while the batch is in flight; a run with no batch open is told so and nothing changes. To end work that is not a batch of yours, remove the graph instead.",
		parameters: { reason: {
			type: "string",
			description: "Why the batch is being cancelled; the settlement answer echoes it back to you"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$12(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$12(exec);
			const { storeId, run } = await ctx.taskRuntime.runForSession(caller);
			if (run.executionPhase !== "waiting_children" || run.batchId === void 0) return `task_cancel: no batch is in flight for run "${run.runId}" (${run.status}${run.executionPhase === void 0 ? ", no coordination phase recorded" : `, phase ${run.executionPhase}`}); nothing was changed`;
			const batchId = run.batchId;
			let outcomes;
			try {
				outcomes = await ctx.taskRuntime.cancelBatch(storeId, batchId, caller);
			} catch (error) {
				return `task_cancel rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return [`cancelled batch ${batchId}${args.reason === void 0 ? "" : ` (${args.reason})`}:`, ...outcomes.map(renderOutcome)].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-decompose.ts
const text$11 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$11(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_decompose: missing agent id");
	return id;
}
function defineTaskDecomposeTool(ctx) {
	return defineTool({
		name: "task_decompose",
		description: "Decompose the caller's current task into child tasks. The batch is admitted atomically and the runtime then runs them one at a time in dependency order; this call returns at admission and does not wait. Each child is verified independently; only verified children count as done. Where this deployment reviews generated tasks, the batch may instead come back waiting for a human review — nothing is admitted or spawned then, and the answer names the proposal that holds it.",
		parameters: {
			reason: {
				type: "string",
				required: true,
				description: "Why this delegation is needed; recorded in each child handoff"
			},
			contractVersion: {
				type: "integer",
				description: "Contract version this batch is written under. The runtime stores version 1 and refuses a declared version it does not know, so callers normally omit this field and let the runtime write the current version"
			},
			requestKey: {
				type: "string",
				description: "The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime derives one from the calling context and the batch content when this is omitted). One key names at most one proposal: repeating a request with the same key is answered with the proposal already stored, while the same key with different content is refused. A revision is different content, so it needs a new key"
			},
			supersedes: {
				type: "string",
				description: "The proposal id this batch revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the new request key this submission needs"
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
									criterionId: {
										type: "string",
										description: "Stable id for this criterion: fixed at admission, and the only id a parent-level childEvidence.criterionId can rely on. Omitted, the runtime generates one from the batch position; declared ids must be unique inside a child. A parent-level childEvidence.criterionId must name an id the child it points to actually declared, which only holds when that child declares the id explicitly here"
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
										description: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product (a verified run carrying a passing verdict) for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation"
									},
									acceptsArtifact: {
										type: "array",
										items: { type: "string" },
										description: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state. Missing blocks the child before spawn and registers an obligation"
									},
									verifierRef: {
										type: "string",
										description: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode."
									},
									childEvidence: {
										type: "array",
										description: "Parent-level evidence map (composite mode only): which child of this decomposition batch — by 0-based position — this criterion rests on, optionally narrowed to a child criterion and an evidence reference. Judged at parent-acceptance time; an incomplete mapping fails the parent naming the missing items",
										items: {
											type: "object",
											additionalProperties: false,
											properties: {
												childIndex: {
													type: "integer",
													required: true,
													description: "0-based position of the child in this decomposition batch"
												},
												criterionId: {
													type: "string",
													description: "The child criterion whose passing verdict is required"
												},
												evidenceRef: {
													type: "string",
													description: "The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence"
												}
											}
										}
									},
									heuristic: {
										type: "boolean",
										description: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass. Mutually exclusive with childEvidence"
									},
									protectedInputs: {
										type: "array",
										items: { type: "string" },
										description: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the task's checkout (an absolute path stays absolute). Admission resolves each one against the session's checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole batch, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed. Only declared paths are protected: a criterion that lists none is not protected and nothing is checked or claimed for it."
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
						constraints: {
							type: "array",
							items: { type: "string" },
							description: "Execution scope and limits this child runs under; persisted in the child's contract and handed to its worker"
						},
						decomposable: {
							type: "boolean",
							description: "Declare that this child should split further instead of doing the work: its worker is told to call task_decompose. Together with a capability gap this decides whether the child is admitted as decomposable."
						},
						requiresIndependentAcceptance: {
							type: "boolean",
							description: "Contract-level marker: this child demands independent parent acceptance — at least one of its acceptance criteria must carry a childEvidence map, or admission refuses the batch. Deleting the map never silently degrades acceptance back to the all-children-verified conjunction"
						}
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$11(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$11(exec);
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			const { requestKey, supersedes,...spec } = args;
			const callId = typeof exec.callId === "string" && exec.callId.length > 0 ? String(exec.callId) : void 0;
			let submission;
			let continued;
			try {
				submission = await ctx.taskRuntime.submitDecompositionProposal(storeId, task.taskId, run.runId, caller, spec, {
					...requestKey === void 0 ? {} : { requestKey: String(requestKey) },
					...supersedes === void 0 ? {} : { supersedes: String(supersedes) },
					exec: {
						signal: exec.signal,
						...callId === void 0 ? {} : { callId }
					}
				});
				continued = await ctx.taskRuntime.continueProposal(storeId, submission.proposalId, caller, { ...callId === void 0 ? {} : { exec: { callId } } });
			} catch (error) {
				return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (continued.status === "admitted") return admittedText(task.taskId, continued.batchId, continued.childTaskIds);
			if (continued.status === "pending_review") return await pendingText$1(ctx, storeId, task.taskId, continued.proposalId, continued.detail);
			if (continued.status === "activated") return [
				`task_decompose: proposal ${continued.proposalId} activated root task ${continued.taskId} with run ${continued.runId} instead of admitting a batch.`,
				`- ${continued.detail}`,
				"- This is a root contract, not a decomposition: no child task exists and this task is not decomposed. Read the root",
				"  contract with `task_read` and decompose it with `task_decompose` once it is the root task you are working on."
			].join("\n");
			return [
				`task_decompose rejected: decomposition of "${task.taskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}${continued.reason === void 0 ? "" : ` — ${continued.reason}`}`,
				"A rejected, cancelled, stale or expired batch never runs: revise it (a revision is new content, a new request key and a",
				"new proposal) or do the work in this task instead. Nothing was admitted and nothing was spawned."
			].join("\n");
		}
	});
}
/**
* The batch is admitted, not finished (A3 §3.1): the call returns as soon as the
* atomic commit landed, and the runtime drives the children from there. What the
* caller may do next is not a matter of taste — the phase it is in decides it —
* so the tool states the contract it is now under rather than leaving the model
* to infer it from a status line.
*/
function admittedText(taskId, batchId, childTaskIds) {
	return [
		`decomposed ${taskId} into ${childTaskIds.length} children (batch ${batchId}):`,
		...childTaskIds.map((childTaskId, index) => `- child ${index + 1}: ${childTaskId}`),
		"",
		`The runtime owns batch ${batchId} now: it starts the children one at a time in dependency order and settles this task when they are all terminal. This call returns at admission and does not wait for the batch.`,
		"You are in phase waiting_children: read and query with `task_read`/`task_status` (and diagnose or inspect), or end the batch with `task_cancel`. Writes, shell commands, another decomposition and a submission of your own are refused while the children run — do not start work that would collide with theirs in the shared checkout.",
		"You are notified when the batch settles; the runtime then submits this task for verification on your behalf, so an idle session is not a completion and needs no submission from you."
	].join("\n");
}
/**
* A batch waiting for a human review (T2/T3 §5–§6): the proposal holds the
* whole batch, nothing was admitted, and the caller's next move is not another
* submission — the same request answers with this same proposal. The policy is
* read back from the proposal rather than assumed, because a proposal born under
* `off` and sent to review by a tightened deployment keeps its birth policy on
* the record; when the record cannot be read the text says so instead of
* inventing one.
*/
async function pendingText$1(ctx, storeId, taskId, proposalId, detail) {
	let policy = "unknown — the proposal record could not be read back";
	try {
		policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`;
	} catch {}
	return [
		`task_decompose is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this batch, and ${taskId} has not been decomposed.`,
		`- ${detail}`,
		"- No child task exists, no worker was spawned, and this task is not decomposed: the batch is admitted only after the review",
		"  decides and the runtime re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
		`- Read the batch as it was recorded with \`task_proposal_read\` (${proposalId}).`,
		"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime continues the batch",
		"  immediately, so you are notified when it settles.",
		"- A refusal is a fact on the record: revise the batch against its reason (fix the cause, never weaken a criterion or drop a",
		"  mandatory one) and call `task_decompose` again — a revision is new content, hence a new proposal, and you may name the",
		"  refused one with `supersedes`.",
		"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal."
	].join("\n");
}

//#endregion
//#region src/tools/task-diagnose.ts
const text$10 = (value) => [{
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
const TARGET_TYPE_SET = new Set(TARGET_TYPES);
function isProposalTargetType(value) {
	return typeof value === "string" && TARGET_TYPE_SET.has(value);
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
* Validate the model-supplied proposals into the recorded shape. The tool
* schema rejects an out-of-vocabulary targetType at the arguments boundary;
* this check is what keeps the recorded `DiagnosisProposal` typed without
* asserting the model's string into the enum.
*/
function toProposals(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("task_diagnose: proposals must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`task_diagnose: proposals[${index}] must be an object`);
		if (!isProposalTargetType(item.targetType)) throw new Error(`task_diagnose: proposals[${index}].targetType must be one of ${TARGET_TYPES.join(" / ")}, got "${String(item.targetType)}"`);
		if (typeof item.targetId !== "string") throw new Error(`task_diagnose: proposals[${index}].targetId must be a string`);
		if (typeof item.rationale !== "string") throw new Error(`task_diagnose: proposals[${index}].rationale must be a string`);
		return {
			targetType: item.targetType,
			targetId: item.targetId,
			rationale: item.rationale
		};
	});
}
function sessionId$10(exec) {
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
			render: (_a, v) => text$10(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$10(exec);
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
				proposals: toProposals(args.proposals),
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
//#region src/tools/root-store.ts
/**
* What an open root proposal means to the session waiting on one, in the words
* of the lifecycle the store itself holds (A0 §2): nothing here can be read as
* "the contract is accepted", and none of the three is a terminal state.
* `ready` and `approved` are the two a reader is most likely to misread — both
* mean the runtime still has to re-check and activate.
*/
const OPEN_ROOT_PROPOSAL_MEANING = new Map([
	["pending_review", "waiting for a review decision; the contract is not a task yet"],
	["ready", "recorded and past its re-check, waiting for the runtime to activate it"],
	["approved", "approved on the record, waiting for the runtime's post-approval re-check and activation"]
]);
/**
* The root store's snapshot, or `undefined` when no such store exists yet — the
* pre-intake state §1.1 allows, answered as a state rather than thrown at a
* reader. The store's own word for it is "does not exist"; every other failure
* (a log this process cannot read, a store it cannot open) is the reader's to
* surface and is re-raised unchanged.
*/
async function rootSnapshotOrUndefined(ctx, storeId) {
	try {
		return await ctx.task.openStore(storeId);
	} catch (error) {
		if (error instanceof Error && /does not exist/.test(error.message)) return void 0;
		throw error;
	}
}
/**
* The store's root task, or `undefined` — parentless is what a root is
* (`adoptRoot` reads the same field), and a store with no root task is the
* pre-intake state.
*/
function rootTaskIn(snapshot) {
	return snapshot?.tasks.find((task) => task.parentTaskId === void 0);
}
/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
function openRootProposals(snapshot) {
	return (snapshot?.proposals?.all ?? []).filter((proposal) => proposal.kind === "root" && OPEN_ROOT_PROPOSAL_MEANING.has(proposal.status));
}
/**
* The store one proposal call belongs to (A0 §1.5, stage-D defect 1).
*
* A worker's store comes from the run it is executing — the lookup both proposal
* tools have always made. A **root session before its contract is accepted has
* no run at all** (the root task is what an approved contract becomes), and that
* is exactly the state in which it has to read the proposal holding its
* contract: `task_intake`'s answers and the root prompt both send it to
* `task_proposal_read`. So when the run lookup answers "no task run is bound to
* this session", the fallback is the store this session owns as a graph's root
* session — `sg-t-<rootSessionId>` — and it is offered to that session alone: a
* session that is not a graph's root, or that is in no graph at all, keeps the
* runtime's own refusal unchanged, and what a caller hears when no store was
* ever opened for its session is the store's own "does not exist".
*/
async function proposalStoreFor(ctx, sessionId$22) {
	try {
		return (await ctx.taskRuntime.runForSession(sessionId$22)).storeId;
	} catch (error) {
		if (!(error instanceof Error) || !/no task run is bound to session/.test(error.message)) throw error;
		const storeId = await rootStoreOfSession(ctx, sessionId$22);
		if (storeId === void 0) throw error;
		return storeId;
	}
}
/**
* The root store one session owns, or `undefined` for a session that is not a
* graph's root session (or that is in no graph this process can place). A probe,
* not a refusal: a caller that has to *say* why a session is not a root renders
* that on its own (`task_intake`'s named refusal), and a caller using this as a
* fallback keeps the error it already had.
*/
async function rootStoreOfSession(ctx, sessionId$22) {
	try {
		const graph = await ctx.graphs.graphForSession(sessionId$22);
		return graph.rootSessionId === sessionId$22 ? rootTaskStoreId(graph.rootSessionId) : void 0;
	} catch {
		return;
	}
}
/**
* The view both readers answer with while the store holds no root task (A0
* §1.5): the state named, whatever proposal is open, and the one action that
* changes it — accepting the user's own goal with `task_intake`. The last line
* is the point of the whole view: no objective is reported, because none has
* been accepted.
*/
function notActivatedLines(graphId, storeId, rootSessionId, snapshot) {
	const open = openRootProposals(snapshot);
	return [
		`graph ${graphId} root session "${rootSessionId}": not activated — no root contract has been accepted for this session, so there is no root task.`,
		`- store ${storeId}: ${snapshot === void 0 ? "does not exist yet — a graph opens it when it is created and fills it when a contract is accepted, and neither state is a failure" : "opened, with no root task in it"}`,
		...open.length === 0 ? ["- open proposals: none — no root contract is waiting for a decision or for its activation."] : ["- open proposals:", ...open.map((proposal) => `  - ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy} — ${OPEN_ROOT_PROPOSAL_MEANING.get(proposal.status)}`)],
		"- accept the user's objective here with `task_intake`: it writes the normalized root contract (objective, acceptance criteria,",
		"  assumptions, constraints and declared capabilities) and activates it as this graph's root task — or, where the deployment",
		"  reviews root contracts, it answers with a proposal id and activates nothing until a recorded decision.",
		"- `task_decompose` cannot run before that: it works on the root task, which does not exist until a contract is accepted.",
		"- no objective is reported here: this graph's name and its setup work are not a goal, and no contract has named one yet."
	];
}

//#endregion
//#region src/tools/task-intake.ts
const text$9 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$9(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_intake: missing agent id");
	return id;
}
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Why a root contract is refused, when the store holds no record of it
* (A0 §1.2–§1.6): the three things a caller does not learn from a single
* message, because the message is about one rule and the caller is about to
* decide what to do next. Nothing here restates a rule — the reason is the
* runtime's, printed verbatim — and nothing here claims a record was written.
*/
const NOTHING_WRITTEN_NOTES = [
	"- Nothing was written: no proposal, no root task, no run and no worker. A contract that fails a rule is refused before a record",
	"  exists, so the reason above is the whole diagnosis.",
	"- A store that already holds a root task is never re-intaken, and a root run that reached a terminal state is not revived: an",
	"  existing root is history, and a new goal is a new graph.",
	"- The rule a root contract has that a child contract does not: at least one mandatory criterion judged by something other than the",
	"  composite conjunction. \"All children verified\" restates the decomposition and cannot be the root's only mandatory criterion."
];
/**
* Which of the three this refusal was, from the store's own facts. The record is
* matched exactly: by the caller's request key when it gave one (one key names
* one proposal, and a key bound to other content is refused rather than stored),
* else by the objective *and* the acceptance-criteria descriptions this call
* sent — both stored verbatim. Comparing the whole contract would mean
* normalizing it here, which is the runtime's work and not this tool's.
*/
async function probeRefusedRecord(ctx, storeId, call, requestKey) {
	let snapshot;
	try {
		snapshot = await rootSnapshotOrUndefined(ctx, storeId);
	} catch (error) {
		return {
			kind: "unreadable",
			reason: message(error)
		};
	}
	if (snapshot === void 0) return { kind: "none" };
	const open = openRootProposals(snapshot);
	const criteria = Array.isArray(call.acceptanceCriteria) ? call.acceptanceCriteria : [];
	const matches = (proposal$1) => requestKey !== void 0 ? proposal$1.requestKey === requestKey : proposal$1.contract.objective === call.objective && proposal$1.contract.acceptanceCriteria.length === criteria.length && proposal$1.contract.acceptanceCriteria.every((criterion, index) => criterion.description === criteria[index]?.description);
	const proposal = [...open].reverse().find(matches);
	return proposal === void 0 ? { kind: "none" } : {
		kind: "recorded",
		proposal
	};
}
/**
* The notes one refusal is rendered with, by the path it took. The recorded path
* says what is on the record and how the retry is addressed — the same contract
* is answered by that same proposal, and the continuation that activates a
* recorded root contract is `task_proposal_continue`; the unreadable path claims
* neither, because this call could not tell which of the two it was.
*/
function refusalNotes(record, storeId) {
	if (record.kind === "recorded") {
		const proposal = record.proposal;
		return [
			`- The contract itself was recorded: proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}) is on the record, so the`,
			"  contract was accepted — a proposal is written only after every contract rule has passed — and what failed is the activation:",
			"  the intake records the proposal first and activates it second, and the activation claims the checkout before it commits.",
			"- The record is where a retry continues from: asking again with the same content is answered by that same proposal rather than",
			`  by a second one, and \`task_proposal_continue\` (${proposal.proposalId}) re-checks it and activates the root when the cause is gone.`,
			`- Read the contract as it was recorded with \`task_proposal_read\` (${proposal.proposalId}).`
		];
	}
	if (record.kind === "unreadable") return [
		`- Whether this contract was recorded could not be read back from store ${storeId} (${record.reason}), so this call cannot say which of`,
		"  the two it was: the reason above is what the runtime refused with, and a retry with the same content is answered by the same",
		"  proposal if one is on the record."
	];
	return NOTHING_WRITTEN_NOTES;
}
/**
* The root contract intake (A0 §3 stage C): the one tool that turns a user's
* objective into the graph's root task, and the root session's own action — a
* worker has a task already and cannot intake one (`task_intake` is in
* ROOT_TOOLS only).
*
* The tool normalizes nothing, judges nothing and activates nothing: the whole
* contract is handed to `intakeRootContract`, which is the entry a direct
* service call uses too, and every rule — the closed field set, the
* independent-criterion rule, the capability resolution, the review policy, the
* atomic activation — stays in the runtime. What this file owes the model is
* therefore a *surface*: a schema whose criterion objects are closed, and three
* answers rendered as they are.
*
* What the schema must not do is suggest that a review can be shortcut: the
* deployment's policy decides whether a contract waits, the channel is the only
* writer of a decision, and no parameter here — or anywhere in this tool's
* description — may read as a way to approve one (§7's reverse discipline; the
* same rule `proposal-parameters.ts` enforces for the proposal tools).
*
* The criterion face is the one `task_decompose.ts` declares, with one
* exception: **no `childEvidence`**. A map names positions in a batch, and a
* root contract is submitted before any batch exists — the root's own
* decomposition happens later, so a position declared here could not name
* anything the runtime would ever judge. The schema refuses the key rather than
* letting a model declare a map nothing can check.
*/
function defineTaskIntakeTool(ctx) {
	return defineTool({
		name: "task_intake",
		description: "Accept this root session's contract: the objective the graph works toward, the acceptance criteria a verifier will judge it by, the assumptions and constraints it rests on and the capabilities the work needs. Only the root session of a graph may call this — the contract becomes that session's root task, and a worker's task was admitted by its parent already. The runtime also checks where the contract came from: only a message DSH attests as human input counts, so a session whose own log holds none of the user's is refused — the prompts this deployment writes (the graph setup text, a spawn's delegated task) and the notices it sends are attributed to their producers, not to a person. A delegated child session is refused too, and a contract is never intaken for another session's store. The runtime normalizes and judges the contract first, and one rule is the root's own: at least one mandatory criterion must be judged by something other than the composite conjunction, so \"all children verified\" cannot be the only thing standing behind the goal. Where this deployment reviews contracts, the call then answers with a proposal id and nothing activated; the decision is recorded by the review channel and the runtime activates the contract itself — no parameter of this call approves anything, and a contract waiting for a review has no root task, no run and no worker.",
		parameters: {
			objective: {
				type: "string",
				required: true,
				description: "The goal of this graph, in the user's terms: what has to exist when the work is done. It stays fixed once the contract is accepted, and it is what every later decomposition is judged against. The objective is the user's request, not this graph's name and not the environment setup work"
			},
			acceptanceCriteria: {
				type: "array",
				required: true,
				description: "How the goal is judged, at least one criterion mandatory and aimed at the delivered artifact: a root whose only mandatory criterion is the conjunction of its children has no independent check of the goal it was given",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						description: {
							type: "string",
							required: true,
							description: "What must hold true of the delivered artifact"
						},
						criterionId: {
							type: "string",
							description: "Stable id for this criterion; omitted, the runtime generates one from its position (`ac-1`, `ac-2`, …). Declared ids must be unique inside the contract"
						},
						command: {
							type: "string",
							description: "Shell command the verifier runs; exit code 0 proves the criterion (deterministic modes)"
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
							description: "Verifier kind; defaults to deterministic when a command is given, review otherwise. `composite` is the conjunction of the children this goal later decomposes into: it may be one of the mandatory criteria, never the only one"
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
							description: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product for this criterion to be judgeable; a missing one blocks the run and registers an obligation"
						},
						acceptsArtifact: {
							type: "array",
							items: { type: "string" },
							description: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state"
						},
						verifierRef: {
							type: "string",
							description: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole contract at intake and the error lists the registered ids. Omit to dispatch by mode."
						},
						heuristic: {
							type: "boolean",
							description: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass"
						},
						protectedInputs: {
							type: "array",
							items: { type: "string" },
							description: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the graph's checkout (an absolute path stays absolute). Intake resolves each one against that checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole contract, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed."
						}
					}
				}
			},
			assumptions: {
				type: "array",
				items: { type: "string" },
				description: "External conditions this contract rests on, in your words, each marked as an assumption rather than as something the user asked for. They are persisted with the contract and shown to whoever reviews it"
			},
			constraints: {
				type: "array",
				items: { type: "string" },
				description: "Execution scope and limits the work runs under, in your words; persisted in the contract and handed to the workers that run under it"
			},
			requiredCapabilities: {
				type: "array",
				items: { type: "string" },
				description: "Capability names the goal needs; call capability_list first to see the names this deployment can grant. A root contract has nobody above it to delegate a gap to, so a name the registry cannot grant refuses the contract by name rather than being recorded as an obligation"
			},
			contractVersion: {
				type: "integer",
				description: "Contract version this intake is written under. The runtime stores version 1 and refuses a declared version it does not know, so callers normally omit this field and let the runtime write the current version"
			},
			requestKey: {
				type: "string",
				description: "The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime derives one from the store, this root session and the contract content when this is omitted). One key names at most one proposal: repeating a request with the same key is answered with the proposal already stored, while the same key with different content is refused. A revision is different content, so it needs a new key"
			},
			supersedes: {
				type: "string",
				description: "The proposal id this contract revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the new request key this submission needs"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$9(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$9(exec);
			const graph = await ctx.graphs.graphForSession(caller);
			if (graph.rootSessionId !== caller) return [
				`task_intake rejected: session "${caller}" is not the root session of graph "${graph.id}" (its root session is "${graph.rootSessionId}") —`,
				"a root contract is the goal of one root session, and a worker's task was admitted by its parent's decomposition.",
				"Nothing was read and nothing was written."
			].join("\n");
			const storeId = rootTaskStoreId(graph.rootSessionId);
			const { requestKey, supersedes,...spec } = args;
			let result;
			try {
				result = await ctx.taskRuntime.intakeRootContract(storeId, caller, spec, {
					...requestKey === void 0 ? {} : { requestKey: String(requestKey) },
					...supersedes === void 0 ? {} : { supersedes: String(supersedes) },
					exec: { signal: exec.signal }
				});
			} catch (error) {
				const recorded = await probeRefusedRecord(ctx, storeId, {
					objective: args.objective,
					acceptanceCriteria: args.acceptanceCriteria
				}, requestKey === void 0 ? void 0 : String(requestKey));
				return [`task_intake rejected: ${message(error)}`, ...refusalNotes(recorded, storeId)].join("\n");
			}
			if (result.status === "activated") return activatedText(caller, result);
			return await pendingText(ctx, storeId, result.proposalId, result.detail);
		}
	});
}
/**
* The contract is live: the ids the activation commit minted, and what the
* session does with them. The last line is the one fact a root can misread —
* having a root task is not having a finished graph — so it is stated rather
* than left to the verifier's later verdict.
*/
function activatedText(rootSessionId, result) {
	return [
		`task_intake activated the root contract of session "${rootSessionId}": root task ${result.taskId}, root run ${result.runId} (proposal ${result.proposalId}).`,
		`- ${result.detail}`,
		"- The root task carries exactly this contract: `task_read` shows its objective, criteria, assumptions and constraints, and the",
		"  graph's tree grows from it.",
		"- `task_decompose` works on the root task from here on: that call was refused before this intake because no root task existed.",
		"- The runtime submits the root task for verification when its batch settles; nothing here claims the goal is met."
	].join("\n");
}
/**
* The contract waits for a review (A0 §1.3): the proposal holds it, nothing was
* activated, and the caller's next move is not another submission — the same
* request answers with this same proposal. The policy is read back from the
* record rather than assumed, because a proposal born under `off` and sent to
* review by a tightened deployment keeps its birth policy; when the record
* cannot be read the text says so instead of inventing one.
*/
async function pendingText(ctx, storeId, proposalId, detail) {
	let policy = "unknown — the proposal record could not be read back";
	try {
		policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`;
	} catch {}
	return [
		`task_intake is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this root contract, and no root task exists.`,
		`- ${detail}`,
		"- Nothing was activated and no worker was spawned: the contract is admitted only after the review decides, and the runtime",
		"  then re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
		`- Read the contract as it was recorded with \`task_proposal_read\` (${proposalId}).`,
		"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime activates the root",
		"  contract immediately, so `task_read` shows the root task once it is live.",
		"- A refusal is a fact on the record: revise the contract against its reason (fix the cause, never weaken a criterion or drop",
		"  the mandatory independent one) and call `task_intake` again — a revision is new content, hence a new request key and a new",
		"  proposal, and you may name the refused one with `supersedes`.",
		"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.",
		"- Do not call `task_decompose` before the contract is activated: there is no root task yet, and `task_read` says so."
	].join("\n");
}

//#endregion
//#region src/tools/proposal-parameters.ts
/**
* The proposal tools' argument closure (T2/T3 stage C).
*
* A DSH tool's parameter map is an implicitly **open** object root
* (`tools/schema.ts`: "The map itself is an implicit open object root"), so the
* schema cannot refuse a key a tool does not declare — which is deliberate for
* `task_decompose`, whose whole batch is handed to the runtime to refuse field
* by field. The three proposal tools have the opposite need: their entire
* contract is "a proposal id and nothing else", and in particular there is no
* argument anywhere that could mean "approved". A caller that tries one — a
* model inventing `approved: true`, or any other approval credential — must be
* told *by name* that this tool has no such parameter, instead of having the
* value silently ignored while the call runs as if it had been accepted.
*
* The check is the tool's own and runs before any service call, so a refused
* call has no side effect at all (§6: 服务入口执行所有检查；工具层只是显示与发起请求).
* @module dsh-singularity-agent/tools/proposal-parameters
*/
/**
* Refuse a call that carries a key the tool does not declare.
* @param args - the parsed arguments, as the model sent them.
* @param declared - every parameter the tool declares.
* @param toolName - the tool's own name, for the refusal text.
* @returns the refusal text, or `undefined` when the call carries nothing undeclared.
*/
function undeclaredParameters(args, declared, toolName) {
	const undeclared = Object.keys(args).filter((key) => !declared.includes(key));
	if (undeclared.length === 0) return void 0;
	return [
		`${toolName} rejected: undeclared parameter${undeclared.length === 1 ? "" : "s"} ${undeclared.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${declared.join(", ")} and has no argument that approves, decides, or stands in for a review;`,
		"nothing was read and nothing was changed."
	].join(" ");
}

//#endregion
//#region src/tools/task-proposal-cancel.ts
const text$8 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$8(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_cancel: missing agent id");
	return id;
}
function defineTaskProposalCancelTool(ctx) {
	return defineTool({
		name: "task_proposal_cancel",
		description: "Withdraw a decomposition proposal this session submitted, before its batch is admitted: the proposal is recorded as cancelled and its record is kept. Only the session that proposed the batch may withdraw it — a withdrawal by anybody else is a decision, and is recorded as one by the review channel, not by this call. Cancelling admits nothing and spawns nothing; a batch that is already admitted is not affected (end it with task_cancel instead).",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$8(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_cancel");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId$8(exec);
			const { storeId } = await ctx.taskRuntime.runForSession(caller);
			try {
				return [`${(await ctx.taskRuntime.cancelProposal(storeId, args.proposalId, caller)).detail}`, "The record is kept: a cancelled proposal is a fact, and a revision is a new proposal with its own request key."].join("\n");
			} catch (error) {
				return `task_proposal_cancel rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/task-proposal-continue.ts
const text$7 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$7(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_continue: missing agent id");
	return id;
}
/**
* What one continuation settled, in the terms the caller acts on. A waiting
* proposal is **not** an error and this text says so: the batch stays exactly
* where it is, no child was created and nothing was spawned, and the caller
* keeps working (or ends its turn) rather than asking again — a repeat of the
* same request is answered by the same proposal.
*
* A root contract continued here is reported as what it is (A0 §2): the runtime
* created the root task and its run, so the ids are named rather than folded
* into the batch vocabulary. Nothing about a batch was admitted, and saying so
* is the point — a reader that took this arm for an admission would go looking
* for children that do not exist.
*/
function renderContinuation(continuation) {
	if (continuation.status === "admitted") return [
		`proposal ${continuation.proposalId} was admitted as batch ${continuation.batchId}:`,
		...continuation.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
		"",
		"The runtime owns the batch now: it starts the children one at a time in dependency order and settles this task when they",
		"are all terminal. This call returns at admission and does not wait for the batch."
	].join("\n");
	if (continuation.status === "activated") return [
		`proposal ${continuation.proposalId} was activated as root task ${continuation.taskId} with run ${continuation.runId}:`,
		`- ${continuation.detail}`,
		"",
		"This is a root contract: the runtime created the root task and its root run and bound this session to them, so no batch",
		"was admitted and no child exists yet. `task_read` shows the contract now, and `task_decompose` works on the root task from",
		"here on."
	].join("\n");
	const reason = continuation.reason === void 0 ? "" : ` — ${continuation.reason}`;
	return [
		`proposal ${continuation.proposalId} is ${continuation.status}: ${continuation.detail}${reason}`,
		"",
		...continuation.status === "pending_review" ? [
			"Nothing was admitted and nothing is spawned while it waits: the review is the gate. Read the batch with",
			"`task_proposal_read` (or wait for the notification) — a decision on the record continues the batch automatically,",
			"and re-submitting the same content answers with this same proposal rather than building another one."
		] : ["A terminal proposal is never re-run: revise the batch and propose it again — a revision is new content, a new request", "key and a new proposal that names this one in `supersedes`."]
	].join("\n");
}
function defineTaskProposalContinueTool(ctx) {
	return defineTool({
		name: "task_proposal_continue",
		description: "Continue a proposal this session submitted: re-check it against everything that was true when it was proposed (what it belongs to, the limits, the capability resolution, the judging verifiers) and act on it if it still passes and carries an approval — a decomposition batch is admitted, a root contract is activated as this session's root task and run. A proposal still waiting for its review is reported as waiting — that is not an error and nothing changes; a rejected, cancelled, stale or expired one is reported with the reason it will never run. Only the session that proposed it can continue it, and this call cannot approve anything: the approval is a decision the review channel records. A root session continues the contract it recorded before its root exists — with no run bound to it, the continuation falls back to the store the session owns, and a ready or approved contract is activated from there.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$7(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_continue");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId$7(exec);
			let continuation;
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				continuation = await ctx.taskRuntime.continueProposal(storeId, args.proposalId, caller, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { exec: { callId: String(exec.callId) } } : {} });
			} catch (error) {
				return `task_proposal_continue rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return renderContinuation(continuation);
		}
	});
}

//#endregion
//#region src/tools/task-proposal-read.ts
const text$6 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$6(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_read: missing agent id");
	return id;
}
/** The decision on record, as a reader has to see it: what was decided, by whom, when, and why when a reason was given. */
function decisionLines(proposal) {
	const decision = proposal.decision;
	if (decision === void 0) return [proposal.status === "pending_review" ? "decision: none yet — the batch waits for one, and only a recorded decision moves it" : "decision: none recorded"];
	return [
		`decision: ${decision.outcome} by ${decision.decidedBy} at ${decision.decidedAt}`,
		...decision.reason === void 0 ? [] : [`decision reason: ${decision.reason}`],
		`decision bound digest ${decision.proposalDigest} and admission context ${decision.admissionContextDigest}`
	];
}
/** What the batch or the root contract became, once it became one — the ids a retry must not mint again (§6). */
function consumptionLines(proposal) {
	const consumption = proposal.consumption;
	if (consumption === void 0) return [];
	if (consumption.kind === "root") return [`consumed as root task ${consumption.rootTaskId} with run ${consumption.rootRunId} at ${consumption.admittedAt}:`, ...consumption.reason === void 0 ? [] : [`- ${consumption.reason}`]];
	return [`consumed as batch ${consumption.batchId} at ${consumption.admittedAt}:`, ...consumption.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`)];
}
/**
* The payload digest and the two context fingerprints, as every reader of a
* record needs them. `subject` names what the digest is of — a batch and a root
* contract are both read through this tool, and calling a contract's digest a
* batch digest would mislabel the number a decision binds.
*/
function digestLines(proposal, subject) {
	return [
		`${subject} digest (sha256): ${proposal.proposalDigest}`,
		`admission context digest: ${proposal.admissionContextDigest} (maxDepth ${proposal.admissionContext.maxDepth}, maxChildren ${proposal.admissionContext.maxChildren}${proposal.admissionContext.wallTimeMs === void 0 ? "" : `, wallTimeMs ${proposal.admissionContext.wallTimeMs}`})`,
		`review context digest: ${proposal.reviewContextDigest} (capability manifest digest ${proposal.reviewContext.capabilityManifestDigest}; judging verifiers ${proposal.reviewContext.verifiers.map((verifier) => verifier.verifierId).join(", ") || "none pinned"})`
	];
}
/** The immutable-record footer every proposal is read under, whichever kind it is. */
const RECORD_NOTE = ["The record is immutable: a revision is a new proposal with a new id and a new request key, and only a decision on this", "record (written by the approval channel, never by a caller) can move it."].join("\n");
/** One saved decomposition proposal: its parent, its whole batch, the decision and what it became. */
function renderBatchProposal(proposal) {
	return [
		`proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
		`submitted ${proposal.createdAt}${proposal.updatedAt === void 0 ? "" : `, last moved ${proposal.updatedAt}`}`,
		`parent task ${proposal.identity.parentTaskId} run ${proposal.identity.parentRunId} (session ${proposal.identity.callerSessionId})`,
		`reason: ${proposal.identity.reason}`,
		`request key: ${proposal.requestKey}${proposal.supersedes === void 0 ? "" : `; supersedes ${proposal.supersedes}`}`,
		"",
		...digestLines(proposal, "batch"),
		"",
		...decisionLines(proposal),
		...consumptionLines(proposal),
		"",
		`children (${proposal.batch.length}):`,
		...renderProposalChildren(proposal),
		RECORD_NOTE
	].join("\n");
}
/**
* One saved root contract proposal: the session it is the goal of, the contract
* itself rather than a child batch — there is no parent task and no batch to
* print — the decision and the root task it became.
*/
function renderRootProposal(proposal) {
	return [
		`proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
		`submitted ${proposal.createdAt}${proposal.updatedAt === void 0 ? "" : `, last moved ${proposal.updatedAt}`}`,
		`root session ${proposal.identity.rootSessionId} (store ${proposal.identity.storeId})`,
		`request key: ${proposal.requestKey}${proposal.supersedes === void 0 ? "" : `; supersedes ${proposal.supersedes}`}`,
		"",
		...digestLines(proposal, "contract"),
		"",
		...decisionLines(proposal),
		...consumptionLines(proposal),
		"",
		"root contract:",
		...renderRootContract(proposal.contract),
		RECORD_NOTE
	].join("\n");
}
/**
* One saved proposal, as the record holds it — the whole batch, or the whole
* root contract, not a summary, and nothing that is not on the record. There is
* no argument for a status: the answer is the store's.
*/
function renderProposal(proposal) {
	return proposal.kind === "root" ? renderRootProposal(proposal) : renderBatchProposal(proposal);
}
function defineTaskProposalReadTool(ctx) {
	return defineTool({
		name: "task_proposal_read",
		description: "Read one proposal by id: where it stands, the policy it was born under, and the subject it carries — every child of a decomposition batch (objective, criteria, assumptions, constraints, dependencies and capability requirements), or the single root contract a root session asked to be admitted as — plus the digest, both context fingerprints, the decision on record and what the proposal became, if it became something. Read-only, and the answer is always the stored record: there is no argument here that can claim a status or an approval. A root session reads the proposal holding its contract before its root exists — with no run bound to it, the reader falls back to the store the session owns.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$6(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_read");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId$6(exec);
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				return renderProposal(await ctx.taskRuntime.proposalIn(storeId, args.proposalId));
			} catch (error) {
				return `task_proposal_read rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/run-phase.ts
/**
* The A3 coordination phase of one run, as the two readers of the store render
* it. Both views come from these functions so `task_read` and `task_status` can
* never describe the same run differently — the same discipline
* `renderRunBinding` applies to the "chosen implementation" section.
*
* The rendering rule, and why it is a rule: a run created before the phase
* field existed has *no* phase, and its phase is never guessed. A non-terminal
* such run is displayed as `needs-recovery` — an old record whose only legal
* continuation is cancellation (`TaskRuntime.reconcileStore` leaves it exactly
* as it stands, and admission and submission both refuse it) — while a terminal
* one renders nothing extra, because a finished run needs no phase. Reporting
* `active` for it would invite work nobody can admit.
*/
/** The full form: what the record is and what a reader can do about it. */
const NEEDS_RECOVERY = "needs-recovery (an old record: it was created before coordination phases, so it has no phase to continue from and cannot decompose, submit or verify — cancel this task tree to recover)";
/** The compact form for `task_status`, whose run part is a cell inside a denser line. */
const NEEDS_RECOVERY_SHORT = "needs-recovery (old record without a coordination phase)";
/** The submission a run carries, as one clause: who handed it in, when, and what it named. */
function submissionClause(submission) {
	const evidence = submission.evidenceRefs.length === 0 ? "" : `; evidence [${submission.evidenceRefs.join(", ")}]`;
	const notes = submission.notes === void 0 ? "" : `; notes: ${submission.notes}`;
	return `submitted by ${submission.origin} at ${submission.submittedAt}: "${submission.summary}"${evidence}${notes}`;
}
/**
* The phase, batch, submission and no-progress facts of one run, appended to a
* `task_read` run line: where this run sits in the protocol, in that order, with
* the batch id only where a batch exists to name. A phase change and a progress
* marking rewrite these fields, so this is the run's current position, never a
* history.
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
/** The same fact for `task_status`, whose run part is a cell inside a denser line. */
function runPhaseCell(run) {
	if (run.executionPhase !== void 0) return ` — phase ${run.executionPhase}`;
	return run.status === "running" ? ` — ${NEEDS_RECOVERY_SHORT}` : "";
}

//#endregion
//#region src/tools/task-read.ts
const text$5 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$5(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_read: missing agent id");
	return id;
}
function latestRun(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.runs.find((run) => run.runId === runId);
}
/**
* The two contract facts a worker cannot read off the objective and the
* criteria table: what its contract assumes and what it constrains (T1 §4) —
* persisted with the task, so this store-backed view and the handoff-rendered
* block say the same thing. A task created before the contract existed has
* neither, and renders exactly what it rendered before: nothing is invented
* for the part the store never held.
*/
function contractLines(task) {
	const contract = task.contract;
	if (contract === void 0) return [];
	return [...contract.assumptions.length === 0 ? [] : ["assumptions:", ...contract.assumptions.map((item) => `- ${item}`)], ...contract.constraints.length === 0 ? [] : ["constraints:", ...contract.constraints.map((item) => `- ${item}`)]];
}
/**
* The protected acceptance inputs a criterion declares, as one suffix a worker
* can read: the paths it must not modify. Empty for a criterion that declares
* none — such a criterion carries no protection, and printing an empty list
* would read like a claim that it does.
*/
function protectedInputsPart(criterion) {
	const declared = criterion.protectedInputs ?? [];
	return declared.length === 0 ? "" : ` [protected inputs: ${declared.map((ref) => ref.path).join(", ")}]`;
}
/**
* The run the caller is executing, as the store recorded it (S1-C item 4): the
* providers this run was bound to, re-checked against the snapshot the record
* names before they are shown.
*
* Why the re-check is not optional: the record says which bytes the run loaded,
* and the snapshot path is the only place those bytes still exist. A snapshot
* that is missing or edited is reported as such, naming the skill — the one
* thing this view must never do is quietly show what stands at the production
* skill path now, which would read as "this is what you are running".
*
* A run created before the field existed, or by a caller that assembled its plan
* without a pre-check, carries no binding: then there is nothing to claim and
* nothing is rendered, exactly as before.
*/
async function bindingLines(ctx, run) {
	const binding = run.providerBinding;
	if (binding === void 0) return [];
	const summary = renderRunBinding(binding, await ctx.taskRuntime.readRunBinding(binding));
	return summary.length === 0 ? [] : ["", ...summary.split("\n")];
}
function defineTaskReadTool(ctx) {
	return defineTool({
		name: "task_read",
		description: "Read the caller's task contract. The root session sees the root task, its acceptance criteria, and child task statuses — or, before any root contract has been accepted, the named state saying so together with whatever proposal is still open (the graph's name is never shown as an objective). A worker sees its own task and run. A run line carries the coordination phase this run is in — and its batch id, its submission and any no-progress marking when it has them; a run with no phase is an old record and is shown as needs-recovery.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$5(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId$5(exec);
			const graph = await ctx.graphs.graphForSession(caller);
			if (graph.rootSessionId !== caller) {
				const { task, run } = await ctx.taskRuntime.runForSession(caller);
				return [
					`task ${task.taskId} [${task.status}] depth ${task.depth}`,
					`objective: ${task.objective}`,
					"acceptance criteria:",
					...task.acceptanceCriteria.map((criterion) => {
						const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
						return `- ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ", mandatory" : ""}] ${criterion.description}${command}${protectedInputsPart(criterion)}`;
					}),
					...contractLines(task),
					`run ${run.runId} [${run.status}]${runPhaseSuffix(run)} started ${run.startedAt}`,
					...await bindingLines(ctx, run)
				].join("\n");
			}
			const storeId = rootTaskStoreId(graph.rootSessionId);
			const snapshot = await rootSnapshotOrUndefined(ctx, storeId);
			const root = rootTaskIn(snapshot);
			if (snapshot === void 0 || root === void 0) return notActivatedLines(graph.id, storeId, graph.rootSessionId, snapshot).join("\n");
			const children = root.childTaskIds.map((taskId) => snapshot.tasks.find((task) => task.taskId === taskId)).filter((task) => task !== void 0);
			return [
				`root task ${root.taskId} [${root.status}/${root.decompositionStatus}]`,
				`objective: ${root.objective}`,
				"acceptance criteria:",
				...root.acceptanceCriteria.map((criterion) => `- ${criterion.criterionId} [${criterion.verificationMode}] ${criterion.description}${protectedInputsPart(criterion)}`),
				`children: ${children.length}`,
				...children.map((child) => {
					const run = latestRun(snapshot, child);
					const runPart = run === void 0 ? "no run" : `run ${run.runId} [${run.status}]${runPhaseSuffix(run)}`;
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
	let text$27;
	try {
		text$27 = await readFile(reviewAgentLedgerFile(), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
	let count = 0;
	text$27.split("\n").forEach((line, index) => {
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
const text$4 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$4(exec) {
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
		const judge = criterion.verifierId === void 0 ? "" : criterion.verifierVersion === void 0 ? ` [${criterion.verifierId}]` : ` [${criterion.verifierId}@${criterion.verifierVersion}]`;
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const exit = criterion.exitCode === void 0 ? "" : ` exit ${criterion.exitCode}`;
		const log = criterion.logRef === void 0 ? "" : ` log ${criterion.logRef}`;
		lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}`);
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
* What each of the task's runs was bound to and loaded (S1-C item 4): one line
* per run that recorded a binding, naming the registry revision, the providers
* (skill, role, short content digest) and the granted MCP servers. This is what
* makes "which version did this execution run against?" answerable from the
* pack, next to the run ids the reviews above already cite.
*
* The pack reports the record; it does not re-read the snapshots. It is the
* facts sheet a reviewer starts from, and the bytes are re-checked by the
* entries that act on them (`task_read`, a run re-entry) — a line here says what
* the run was bound to, never that the content is still on disk. A run that
* carries no binding (one written before the field existed, or one whose caller
* assembled its plan without a pre-check) contributes no line, and nothing is
* invented for it.
*/
function renderBindings(snapshot, taskId) {
	const lines = [];
	for (const run of snapshot.runs.filter((item) => item.taskId === taskId)) {
		const binding = run.providerBinding;
		if (binding === void 0) continue;
		const skills = binding.skills.length === 0 ? "no provider skill" : binding.skills.map((skill) => `${skill.name} [${skill.role}] content ${skill.contentDigest.slice(0, 12)}${skill.contractDigest === null ? "" : ` contract ${skill.contractDigest.slice(0, 12)}`}`).join("; ");
		const servers = binding.mcpServers.length === 0 ? "" : `; mcp ${binding.mcpServers.map((server) => server.serverName).join(", ")}`;
		const snapshotRoot = binding.snapshotRoot === void 0 ? "" : `; snapshot ${binding.snapshotRoot}`;
		lines.push(`- run ${run.runId} [${run.status}] bound registry ${binding.registryRevision.slice(0, 12)}: ${skills}${servers}${snapshotRoot}`);
	}
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
		...reviews.flatMap(renderReview),
		...renderBindings(snapshot, task.taskId)
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
			render: (_a, v) => text$4(v)
		},
		execute: async (args, exec) => {
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(sessionId$4(exec))).rootSessionId);
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
const text$3 = (value) => [{
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
function sessionId$3(exec) {
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
			render: (_a, v) => text$3(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$3(exec);
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
const text$2 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$2(exec) {
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
		description: "Compact snapshot of the caller's graph task tree: task id, objective, status, latest run status with its coordination phase (a phase-less non-terminal run reads needs-recovery), evidence ids, and terminal review outcome. Before any root contract has been accepted it answers the named not-activated state (with whatever proposal is still open) instead of an empty tree. Also lists recorded obligations and the domain-template coverage hint.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$2(v)
		},
		execute: async (_args, exec) => {
			const graph = await ctx.graphs.graphForSession(sessionId$2(exec));
			const storeId = rootTaskStoreId(graph.rootSessionId);
			const snapshot = await rootSnapshotOrUndefined(ctx, storeId);
			const root = rootTaskIn(snapshot);
			if (snapshot === void 0 || root === void 0) return notActivatedLines(graph.id, storeId, graph.rootSessionId, snapshot).join("\n");
			const lines = snapshot.tasks.map((task) => {
				const runId = task.runIds[task.runIds.length - 1];
				const run = snapshot.runs.find((item) => item.runId === runId);
				const evidence = snapshot.evidence.filter((item) => item.taskId === task.taskId).map((item) => item.evidenceId);
				const review = [...snapshot.reviews].reverse().find((item) => item.taskId === task.taskId);
				const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId).length;
				const runPart = run === void 0 ? "run: none" : `run: ${run.status}${runPhaseCell(run)}`;
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
//#region src/tools/task-submit-result.ts
const text$1 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$1(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_submit_result: missing agent id");
	return id;
}
function defineTaskSubmitResultTool(ctx) {
	return defineTool({
		name: "task_submit_result",
		description: "Hand in this run's result for acceptance. This is the explicit submission the coordination protocol is built on: it records what was delivered (summary, plus the evidence/artifact references you produced), closes admission for this run — no further write, command or decomposition is admitted — drains the calls still in flight, and hands the run to the verifier. The call returns the verdict. An idle session is not a completion: a worker that goes idle without submitting gets one reminder and is stopped by the no-progress budget if it still has not submitted. A run waiting on its own child batch cannot submit — the batch submits for it when the children are terminal.",
		parameters: {
			summary: {
				type: "string",
				required: true,
				description: "What was delivered, in your own words; a blank summary is refused"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence ids, artifact refs or review refs you name as proof of the summary"
			},
			notes: {
				type: "string",
				description: "Anything further a reader of the submission should know"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$1(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$1(exec);
			let result;
			try {
				result = await ctx.taskRuntime.submitResult(caller, args, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { callId: String(exec.callId) } : {} });
			} catch (error) {
				return `task_submit_result rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return `task_submit_result ${result.status}: ${result.detail}`;
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
/**
* The shipped switch position: `off`.
*
* The default run is the one nobody configured, and R0 asks that this run not
* carry the evolution chain (guide §1.3: "默认运行只提供当前角色需要的能力").
* `on` is therefore an explicit act by a deployment, and what it resolved to is
* readable back from the context ({@link EvolutionExposure}) — a switch whose
* position cannot be read is one nobody can tell from an unwired exposure.
*/
const DEFAULT_EVOLUTION = "off";
const ConfigSchema = z.object({ evolution: z.union([z.const("off"), z.const("on")]).default(DEFAULT_EVOLUTION) });
/**
* The evolution exposure this composition resolved, provided on the agent's own
* fiber as `ctx.singularityEvolution`.
*
* The registration gate in {@link SingularityAgent} is the enforcement; this
* service is the fact a sibling assembly reads to keep its own surface in step
* — the root agent's tool allow-list names these nine names and has to leave
* them out when they were never registered. Read it softly:
*
* ```ts
* const evolution = ctx.get('singularityEvolution')?.enabled ?? false
* ```
*
* A composition that does not mount this plugin provides no such service, and
* that absence reads as the closed state: a deployment that never turned the
* chain on must not be assembled as if it had.
*/
var EvolutionExposure = class extends Service {
	/** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
	enabled;
	constructor(ctx, enabled) {
		super(ctx, "singularityEvolution");
		this.enabled = enabled;
	}
};
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
	static Config = ConfigSchema;
	constructor(ctx, config) {
		super(ctx, "singularityAgent");
		this.assertClosedConfig(config);
		const evolution = this.resolveEvolution(config);
		ctx.plugin(HitlService);
		new EvolutionService(ctx);
		new EscalationService(ctx);
		new ProposalReviewService(ctx);
		new EvolutionExposure(ctx, evolution === "on");
		ctx.tools.register(defineMarkReadyTool(ctx));
		ctx.tools.register(defineSpawnTool(ctx));
		ctx.tools.register(defineAskTool(ctx));
		ctx.tools.register(defineApproveTool(ctx));
		ctx.tools.register(defineTaskReadTool(ctx));
		ctx.tools.register(defineCapabilityListTool(ctx));
		ctx.tools.register(defineTaskIntakeTool(ctx));
		ctx.tools.register(defineTaskDecomposeTool(ctx));
		ctx.tools.register(defineTaskProposalReadTool(ctx));
		ctx.tools.register(defineTaskProposalContinueTool(ctx));
		ctx.tools.register(defineTaskProposalCancelTool(ctx));
		ctx.tools.register(defineTaskStatusTool(ctx));
		ctx.tools.register(defineTaskSubmitResultTool(ctx));
		ctx.tools.register(defineTaskCancelTool(ctx));
		ctx.tools.register(defineTaskVerifyTool(ctx));
		ctx.tools.register(defineTaskReviewPackTool(ctx));
		ctx.tools.register(defineTaskReviewAgentTool(ctx));
		ctx.tools.register(defineTaskDiagnoseTool(ctx));
		if (evolution === "on") {
			ctx.tools.register(defineEvolutionProposeTool(ctx));
			ctx.tools.register(defineEvolutionCandidateTool(ctx));
			ctx.tools.register(defineEvolutionPrepareTool(ctx));
			ctx.tools.register(defineEvolutionReplayTool(ctx));
			ctx.tools.register(defineEvolutionGateTool(ctx));
			ctx.tools.register(defineEvolutionDecideTool(ctx));
			ctx.tools.register(defineEvolutionApplyTool(ctx));
			ctx.tools.register(defineEvolutionRollbackTool(ctx));
			ctx.tools.register(defineEvolutionListTool(ctx));
		}
		ctx.tools.register(defineEscalateTool(ctx));
	}
	/**
	* Refuse a configuration member this plugin does not read. The schema keeps
	* unknown keys on the object it validates, so this is where a caller's typo
	* is caught: a misspelled member would otherwise read as a configuration that
	* took effect while the switch stayed at its default.
	*/
	assertClosedConfig(config) {
		if (config === void 0) return;
		const known = new Set(["evolution"]);
		const unknown = Object.keys(config).filter((key) => !known.has(key));
		if (unknown.length === 0) return;
		throw new Error(`singularity-agent: the configuration names [${unknown.join(", ")}], which this plugin does not read; a member nobody reads refuses to start rather than being silently ignored`);
	}
	/**
	* The switch position this assembly acts on. The schema types the member, but
	* a deployment that constructs this plugin directly (a test, an embedding
	* process) bypasses the schema, and a near miss must not be read as "not on,
	* therefore off": a caller who asked for something this build does not
	* implement would get the closed composition while believing otherwise.
	*/
	resolveEvolution(config) {
		const value = config?.evolution;
		if (value === void 0) return DEFAULT_EVOLUTION;
		if (value === "off" || value === "on") return value;
		throw new Error(`singularity-agent: evolution is ${JSON.stringify(value)}; it is "off" or "on" (a switch this build cannot execute refuses to start rather than assembling an exposure nobody chose)`);
	}
};
var src_default = SingularityAgent;

//#endregion
export { APPLYABLE_TARGET_TYPES, CHAMPION_SOURCES, CHAMPION_STATES, DEFAULT_EVOLUTION, ESCALATION_TRIGGERS, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EscalationService, EvolutionExposure, EvolutionService, HitlService, MECHANICAL_TARGET_TYPES, ProposalReviewService, REPLAY_RELATIONS, REPLAY_VERDICTS, SingularityAgent, applyTargets, compareReplaySides, src_default as default, mutationMechanical, overallReplayVerdict, ownerSessionOfStore, renderProposalReview, reviewDecider };