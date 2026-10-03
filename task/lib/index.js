import { Context, Service } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";

//#region src/types.ts
/** DFS over an edge list: true when `target` is reachable from `start`. */
function reaches(edges, start$1, target) {
	const seen = /* @__PURE__ */ new Set();
	const pending = [start$1];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === target) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const edge of edges) if (edge.from === current) pending.push(edge.to);
	}
	return false;
}
/** The run statuses that end a run: no transition out of these resumes it (guide §4.2 G3 — blocked is a dead end). */
const TERMINAL_RUN_STATUSES = new Set([
	"verified",
	"failed",
	"cancelled",
	"blocked"
]);
/** Whether `status` is terminal ({@link TERMINAL_RUN_STATUSES}). */
function isTerminalRunStatus(status) {
	return TERMINAL_RUN_STATUSES.has(status);
}
/** The member **slots** one run reads, in the sequence a parent criterion's `childIndex` names: the verified siblings its {@link TaskRun.recovery} claims at the positions they name, and the `memberTaskIds` of its batches — in admission order … */
function runMemberSlots(run) {
	const claimed = [...run.recovery?.reusedMembers ?? []].sort((left, right) => left.childIndex - right.childIndex);
	if (claimed.length === 0) return (run.batches ?? []).flatMap((batch) => batch.memberTaskIds);
	const slots = [];
	for (const entry of claimed) {
		while (slots.length < entry.childIndex) slots.push(void 0);
		slots[entry.childIndex] = entry.taskId;
	}
	for (const memberTaskId of (run.batches ?? []).flatMap((batch) => batch.memberTaskIds)) {
		const free = slots.indexOf(void 0);
		if (free === -1) slots.push(memberTaskId);
		else slots[free] = memberTaskId;
	}
	return slots;
}
/** The member task ids one run reads, in slot order, with the slots it has not filled left out: what a reader that needs *which* tasks are members — not where each one sits — asks for. */
function runMemberTaskIds(run) {
	return runMemberSlots(run).filter((taskId) => taskId !== void 0);
}
/** Every judged dimension, in the order a report reads them. */
const JUDGED_DIMENSIONS = [
	"task_specification",
	"acceptance",
	"decomposition",
	"skill_fit",
	"tool_fit",
	"context_efficiency"
];
/** Every judgement verdict, for reducer validation and rendering. */
const JUDGEMENT_VERDICTS = [
	"adequate",
	"inadequate",
	"unknown"
];
/** Store id convention: one task store per root session. */
function rootTaskStoreId(rootSessionId) {
	return `sg-t-${rootSessionId}`;
}

//#endregion
//#region src/contract.ts
/** The normalized contract version this build writes. Separate from a task template's own generation number and from the event envelope's `schemaVersion` (the store's wire format): this one versions the contract data definition, and an entry … */
const TASK_CONTRACT_VERSION = 1;
/** Object keys whose value is not `undefined`: the rule canonical identities and logged events share. */
function definedKeys(source) {
	return Object.keys(source).filter((key) => source[key] !== void 0);
}
/** Stable serialization of contract data: object keys sorted, arrays kept in order, strings byte-for-byte, `undefined`-valued keys dropped. */
function canonicalize(value) {
	if (value === null) return "null";
	switch (typeof value) {
		case "string": return JSON.stringify(value);
		case "boolean": return value ? "true" : "false";
		case "number":
			if (!Number.isFinite(value)) throw new Error(`task: cannot canonicalize ${String(value)}: contract data must be finite JSON`);
			return JSON.stringify(value);
		case "object": break;
		default: throw new Error(`task: cannot canonicalize a ${typeof value}: contract data must be JSON`);
	}
	if (Array.isArray(value)) return `[${value.map((item) => item === void 0 ? "null" : canonicalize(item)).join(",")}]`;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`task: cannot canonicalize a ${value.constructor?.name ?? "non-plain object"}: contract data must be plain JSON`);
	const source = value;
	return `{${definedKeys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`).join(",")}}`;
}
function sha256(text) {
	return sha256Hex(text);
}
/** SHA-256 (lowercase hex) of raw bytes: the digest form a protected acceptance input's identity is fixed with ({@link ProtectedInputRef}), shared by the admission-time fixing and the pre-judgement re-check. */
function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/** The single-task contract identity: SHA-256 over {@link canonicalize} of the normalized contract. */
function contractDigest(contract) {
	return sha256(canonicalize(contract));
}
/** The whole-batch proposal identity: SHA-256 over {@link canonicalize} of the normalized proposal. */
function decompositionDigest(identity) {
	return sha256(canonicalize(identity));
}
/** Persist the final contract identity and its actual source on every production instance. */
function taskContractIdentity(contract) {
	const digest = contractDigest(contract);
	return {
		contractDigest: digest,
		definitionRef: contract.templateRef === void 0 ? {
			taskType: `contract:${digest}`,
			version: contract.contractVersion,
			digest
		} : {
			taskType: contract.templateRef.id,
			version: contract.templateRef.version,
			digest: contract.templateRef.digest
		},
		...contract.templateRef === void 0 ? {} : {
			templateRef: structuredClone(contract.templateRef),
			templateParameters: structuredClone(contract.templateParameters ?? {})
		}
	};
}

//#endregion
//#region src/proposal.ts
/** Every proposal kind, for validation and rendering. */
const TASK_PROPOSAL_KINDS = ["decomposition", "root"];
/** The reserved `taskId` a root proposal's events carry on the envelope. A root contract belongs to no task — the task it becomes does not exist until it is activated — so its events cannot name one, and naming a task that happens to exist … */
const ROOT_PROPOSAL_TASK_ID = "root-proposal";
/** Every proposal phase change, for validation and rendering. */
const TASK_PROPOSAL_PHASES = [
	"ready",
	"pending_review",
	"stale"
];
/** Every decision outcome, for validation and rendering. */
const TASK_PROPOSAL_DECISION_OUTCOMES = [
	"approved",
	"rejected",
	"cancelled",
	"expired"
];
/** The `p-` prefix every proposal id carries, so an id is recognizable as one wherever it is printed. Module-local: the two id derivations below are its only callers, and no other file names it (R2). */
const TASK_PROPOSAL_ID_PREFIX = "p-";
/** The proposal id one batch identity gets: `p-` plus {@link decompositionDigest} of the identity. */
function taskProposalId(identity) {
	return `${TASK_PROPOSAL_ID_PREFIX}${decompositionDigest(identity)}`;
}
/** The id one admitted batch carries in the run coordination protocol: `b-<parentRunId>-<proposalId>`. */
function batchIdFor(parentRunId, proposalId) {
	return `b-${parentRunId}-${proposalId}`;
}
/** The root contract's identity: SHA-256 over {@link canonicalize} of {@link RootProposalIdentity} — which store, which root session, which request key, and the digest of the normalized root contract. */
function rootProposalDigest(identity) {
	return sha256Hex(canonicalize(identity));
}
/** The proposal id one root contract identity gets: `p-` plus {@link rootProposalDigest} of the identity. */
function rootProposalId(identity) {
	return `${TASK_PROPOSAL_ID_PREFIX}${rootProposalDigest(identity)}`;
}
/** The identity of the limits a batch was admitted under: SHA-256 over {@link canonicalize} of the {@link AdmissionContext}. */
function admissionContextDigest(context) {
	return sha256Hex(canonicalize(context));
}
/** The identity of what a batch resolved against: SHA-256 over {@link canonicalize} of every manifest the batch resolved, **in batch order** — the order the children were proposed in, so two resolutions of the same batch that assigned the … */
function capabilityManifestDigest(manifests) {
	return sha256Hex(canonicalize(manifests));
}
/** The identity of the resolution a proposal was reviewed against: SHA-256 over {@link canonicalize} of the {@link TaskProposalReviewContext} with its verifier list normalized to ascending `(verifierId, version, configurationDigest)`. */
function reviewContextDigest(context) {
	return sha256Hex(canonicalize(normalizeReviewContext(context)));
}
/** The review context with an order-independent verifier list, for hashing only — the stored list keeps the writer's order. */
function normalizeReviewContext(context) {
	return {
		capabilityManifestDigest: context.capabilityManifestDigest,
		verifiers: [...context.verifiers].sort((left, right) => compareVerifiers(left, right))
	};
}
function compareVerifiers(left, right) {
	const a = verifierKey(left);
	const b = verifierKey(right);
	return a < b ? -1 : a > b ? 1 : 0;
}
function verifierKey(verifier) {
	return [
		verifier.verifierId,
		verifier.version ?? "",
		verifier.configurationDigest ?? ""
	].join("\0");
}

//#endregion
//#region src/budget.ts
/** The closed field set of a submitted extension: an unread field must not enter the record. */
const BUDGET_EXTENSION_CLAIM_FIELDS = [
	"requestKey",
	"requestDigest",
	"maxRuns",
	"deadlineAt",
	"approvalRef",
	"requestedBy",
	"baseline"
];
/** The closed field set of a reading: a dimension nobody read must not enter a claim either. */
const BUDGET_EXTENSION_BASELINE_FIELDS = ["maxRuns", "deadlineAt"];
/** The request identity: SHA-256 over the key and the totals asked for, each dimension in its canonical form (a deadline is the instant it denotes, not the spelling it was written in). */
function budgetExtensionRequestDigest(request) {
	return sha256Hex(canonicalize({
		requestKey: request.requestKey,
		...request.maxRuns === void 0 ? {} : { maxRuns: request.maxRuns },
		...request.deadlineAt === void 0 ? {} : { deadlineAt: request.deadlineAt }
	}));
}
/** An instant with an explicit zone designator: a UTC `Z` or a numeric offset. A string without one (`2026-09-16T04:00:00`) denotes a *local* time, which two hosts read as two different instants — it is not an absolute deadline and is refused … */
const ABSOLUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** The canonical spelling (`new Date(ms).toISOString()`) of the absolute instant a deadline value denotes, or `undefined` when it denotes none: an unreadable string, a bare local time, a duration in words. */
function canonicalBudgetInstant(value) {
	if (typeof value !== "string" || !ABSOLUTE_INSTANT.test(value)) return void 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : void 0;
}
/** One extension's raises in one phrase, for a refusal that has to say what a request key already holds. */
function describeBudgetExtension(extension) {
	return `a budget extension raising ${[...extension.maxRuns === void 0 ? [] : [`maxRuns ${extension.maxRuns.previous} → ${extension.maxRuns.next}`], ...extension.deadlineAt === void 0 ? [] : [`deadline ${extension.deadlineAt.previous} → ${extension.deadlineAt.next}`]].join(" and ")}`;
}
/** One dimension's reading in one phrase, for a refusal that has to say what a request was read at: the value it was read at, or the fact that it names the dimension nowhere. */
function describeBudgetReading(dimension, value) {
	return value === void 0 ? `was read without a ${dimension} reading` : `was read at ${dimension} ${String(value)}`;
}
/** Folds the store's extensions into the ceilings they leave in force: each dimension keeps the `next` of the *last* extension that moved it, and a dimension no extension names answers `undefined` — "the store has no approved ceiling here" … */
function approvedBudgetCeilings(extensions) {
	let maxRuns;
	let deadlineAt;
	for (const extension of extensions) {
		if (extension.maxRuns !== void 0) maxRuns = extension.maxRuns.next;
		if (extension.deadlineAt !== void 0) deadlineAt = extension.deadlineAt.next;
	}
	return {
		...maxRuns === void 0 ? {} : { maxRuns },
		...deadlineAt === void 0 ? {} : { deadlineAt }
	};
}

//#endregion
//#region src/service/checks/primitives.ts
function copy(value) {
	return structuredClone(value);
}
function nonEmpty(value) {
	return typeof value === "string" && value.length > 0;
}
/** A lowercase SHA-256 hex digest: the only shape a content or context identity is accepted in. */
function isDigest(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
/** Plain-object test: `null` and arrays are not records, whatever `typeof` says. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** One optional snapshot index, or a refusal: an absent index is "cannot see", never "holds none". */
function requireIndex(index, message) {
	if (index === void 0) throw new Error(message);
	return index;
}
function taskIn(snapshot, taskId) {
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`task: unknown task "${taskId}"`);
	return task;
}
function runIn(snapshot, runId) {
	const run = snapshot.runs.find((item) => item.runId === runId);
	if (run === void 0) throw new Error(`task: unknown run "${runId}"`);
	return run;
}

//#endregion
//#region src/question.ts
/** The `q-` prefix every question id carries, so an id is recognizable wherever it is printed. */
const QUESTION_ID_PREFIX = "q-";
/** The `a-` prefix every answer id carries. */
const ANSWER_ID_PREFIX = "a-";
/** The question id one (run, key) pair gets: `q-` plus SHA-256 over {@link canonicalize} of {@link QuestionIdentity}. */
function questionIdOf(identity) {
	return `${QUESTION_ID_PREFIX}${sha256Hex(canonicalize(identity))}`;
}
/** The answer id one (question, key) pair gets: `a-` plus SHA-256 over {@link canonicalize} of {@link QuestionAnswerIdentity}. */
function answerIdOf(identity) {
	return `${ANSWER_ID_PREFIX}${sha256Hex(canonicalize(identity))}`;
}
/** The question one id names, or `undefined` when the store holds none. A snapshot without a question index is refused rather than read as empty: a snapshot built by this build's reducer always carries the index (empty members included), so … */
function questionOf(snapshot, questionId) {
	return questionIndex$1(snapshot).byId[questionId];
}
/** The questions one run asked that are still open, in ask order. Open means both halves: no answer has resolved it, and both runs are still running — the parent has to be able to answer, and a settled run is never blocked by anything again. */
function openQuestionsOf(snapshot, childRunId) {
	return questionIndex$1(snapshot).all.filter((question) => question.childRunId === childRunId && isOpen(snapshot, question));
}
/** The open questions whose answers block the asking run — the derivation the write gate and the display read. `blocking: false` is a real question that is expected to be delivered and answered; it just never stops the run. */
function blockingQuestionsOf(snapshot, childRunId) {
	return openQuestionsOf(snapshot, childRunId).filter((question) => question.blocking);
}
/** The questions one parent run has been asked and has not resolved, in ask order — the parent-side pending list (§7.3: an unanswered question and an unread answer both keep their reference until the model has actually seen them). */
function questionsAwaitingAnswerOf(snapshot, parentRunId) {
	return questionIndex$1(snapshot).all.filter((question) => question.parentRunId === parentRunId && isOpen(snapshot, question));
}
/** The snapshot's question index, or a refusal: an absent index is "cannot see", never "holds none" (see {@link questionOf}). */
function questionIndex$1(snapshot) {
	return requireIndex(snapshot.questions, "task: snapshot carries no question index");
}
/** Whether one stored question still blocks anything: unresolved, and both runs still running. */
function isOpen(snapshot, question) {
	if (question.answers?.some((answer) => answer.resolves) === true) return false;
	return isRunning(snapshot, question.childRunId) && isRunning(snapshot, question.parentRunId);
}
function isRunning(snapshot, runId) {
	return snapshot.runs.some((run) => run.runId === runId && run.status === "running");
}

//#endregion
//#region src/service/checks/budget.ts
/** The snapshot's budget-extension index, or a refusal: an absent index is "cannot see", never "holds none". */
function budgetExtensionIndex(snapshot) {
	return requireIndex(snapshot.budgetExtensions, "task: snapshot carries no budget extension index");
}
/** Validates one claim against the store's chain and returns the record to store, or `undefined` when the request is a repeat. */
function buildBudgetExtension(snapshot, taskId, sessionId, claim, timestamp) {
	if (!isRecord(claim)) throw new Error("task: a budget extension must be an object");
	const requestKey = claim.requestKey;
	if (!nonEmpty(requestKey)) throw new Error("task: a budget extension request key must be a non-empty string");
	for (const key of Object.keys(claim)) if (!BUDGET_EXTENSION_CLAIM_FIELDS.includes(key)) throw new Error(`task: budget extension "${requestKey}" carries "${key}", which is not part of an extension; an unread field must not enter the record`);
	if (!nonEmpty(claim.approvalRef)) throw new Error(`task: budget extension "${requestKey}" requires a non-empty approval reference; a raise nobody approved is not recorded`);
	if (!nonEmpty(claim.requestedBy)) throw new Error(`task: budget extension "${requestKey}" must name the session that asked`);
	if (!nonEmpty(sessionId)) throw new Error(`task: budget extension "${requestKey}" must carry the asking session on its envelope (the event's sessionId)`);
	if (claim.requestedBy !== sessionId) throw new Error(`task: budget extension "${requestKey}" was asked by session "${claim.requestedBy}" but its event names "${sessionId}"`);
	if (rootTaskStoreId(claim.requestedBy) !== snapshot.id) throw new Error(`task: budget extension "${requestKey}" names session "${claim.requestedBy}", which is not the root session of store "${snapshot.id}" (rootTaskStoreId derives the store from its root session, and "sg-t-${claim.requestedBy}" is not this store); the tree's budget belongs to the session that accepted it, and a worker never raises its own`);
	if (taskIn(snapshot, taskId).parentTaskId !== void 0) throw new Error(`task: budget extension "${requestKey}" names task "${taskId}", which is not the store's root task; the tree's budget is the root's`);
	if (claim.maxRuns === void 0 && claim.deadlineAt === void 0) throw new Error(`task: budget extension "${requestKey}" raises nothing: it must name maxRuns, deadlineAt, or both`);
	const reading = claim.baseline;
	if (!isRecord(reading)) throw new Error(`task: budget extension "${requestKey}" carries no reading of the ceilings it was approved against (a \`baseline\`); a grant is approved against the whole ceiling the person was shown, and a record without that reading cannot be checked against the ceiling in force`);
	for (const key of Object.keys(reading)) if (!BUDGET_EXTENSION_BASELINE_FIELDS.includes(key)) throw new Error(`task: budget extension "${requestKey}" was read at "${key}", which is not a dimension of the tree's budget; an unread field must not enter the record`);
	if (reading.maxRuns !== void 0 && (!Number.isInteger(reading.maxRuns) || reading.maxRuns < 1)) throw new Error(`task: budget extension "${requestKey}" was read at maxRuns ${JSON.stringify(reading.maxRuns)}; a run ceiling reading is a positive whole number of runs`);
	if (reading.deadlineAt !== void 0 && canonicalBudgetInstant(reading.deadlineAt) !== reading.deadlineAt) throw new Error(`task: budget extension "${requestKey}" was read at deadline ${JSON.stringify(reading.deadlineAt)}; a deadline reading is an absolute instant in canonical UTC form (\`new Date(ms).toISOString()\`)`);
	if (claim.maxRuns !== void 0) {
		const { previous, next } = claim.maxRuns;
		if (!Number.isInteger(previous) || previous < 1 || !Number.isInteger(next) || next < 1) throw new Error(`task: budget extension "${requestKey}" records maxRuns ${previous} → ${next}; a run ceiling is a positive whole number of runs`);
		if (next <= previous) throw new Error(`task: budget extension "${requestKey}" records maxRuns ${previous} → ${next}; a ceiling is the whole approved total and only ever moves up`);
		if (reading.maxRuns !== previous) throw new Error(`task: budget extension "${requestKey}" raises maxRuns from ${previous} but ${describeBudgetReading("maxRuns", reading.maxRuns)}; a raise and the reading it was approved against name the same ceiling`);
	}
	if (claim.deadlineAt !== void 0) {
		const previous = canonicalBudgetInstant(claim.deadlineAt.previous);
		const next = canonicalBudgetInstant(claim.deadlineAt.next);
		if (previous === void 0 || previous !== claim.deadlineAt.previous || next === void 0 || next !== claim.deadlineAt.next) throw new Error(`task: budget extension "${requestKey}" records the deadline pair ${JSON.stringify(claim.deadlineAt)}; both ends are absolute instants in canonical UTC form (\`new Date(ms).toISOString()\`), never local time or a duration`);
		if (Date.parse(next) <= Date.parse(previous)) throw new Error(`task: budget extension "${requestKey}" records deadline ${previous} → ${next}; a deadline only ever moves later`);
		if (reading.deadlineAt !== previous) throw new Error(`task: budget extension "${requestKey}" moves the deadline from ${previous} but ${describeBudgetReading("deadlineAt", reading.deadlineAt)}; a raise and the reading it was approved against name the same ceiling`);
	}
	const digest = budgetExtensionRequestDigest({
		requestKey,
		...claim.maxRuns === void 0 ? {} : { maxRuns: claim.maxRuns.next },
		...claim.deadlineAt === void 0 ? {} : { deadlineAt: claim.deadlineAt.next }
	});
	if (claim.requestDigest !== digest) throw new Error(`task: budget extension "${requestKey}" declares identity ${JSON.stringify(claim.requestDigest)}, which is not the identity of the request it carries (${digest})`);
	const index = budgetExtensionIndex(snapshot);
	const existing = index.byRequestKey[requestKey];
	if (existing !== void 0) {
		if (existing.requestDigest === claim.requestDigest) return void 0;
		throw new Error(`task: budget extension request key "${requestKey}" is already bound to ${describeBudgetExtension(existing)} (identity ${existing.requestDigest}); one key names one request, and different content under it is a new key rather than a second grant`);
	}
	const inForce = approvedBudgetCeilings(index.all);
	if (inForce.maxRuns !== void 0 && reading.maxRuns !== inForce.maxRuns) throw new Error(`task: budget extension "${requestKey}" ${describeBudgetReading("maxRuns", reading.maxRuns)}, but the ceiling in force here is ${inForce.maxRuns}; the tree's ceiling moved since this request was read, so committing it would re-base an approval on a value nobody approved — read the whole ceiling again and ask for the difference`);
	if (!nonEmpty(timestamp)) throw new Error(`task: budget extension "${requestKey}" has no recorded time on its event`);
	return {
		requestKey,
		requestDigest: claim.requestDigest,
		...claim.maxRuns === void 0 ? {} : { maxRuns: {
			previous: claim.maxRuns.previous,
			next: claim.maxRuns.next
		} },
		...claim.deadlineAt === void 0 ? {} : { deadlineAt: {
			previous: claim.deadlineAt.previous,
			next: claim.deadlineAt.next
		} },
		approvalRef: claim.approvalRef,
		requestedBy: claim.requestedBy,
		baseline: {
			...reading.maxRuns === void 0 ? {} : { maxRuns: reading.maxRuns },
			...reading.deadlineAt === void 0 ? {} : { deadlineAt: reading.deadlineAt }
		},
		recordedAt: timestamp
	};
}

//#endregion
//#region src/template.ts
function parseCatalogPath(raw) {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8 || raw.some((segment) => typeof segment !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(segment))) throw new Error("task-template: catalogPath requires 1–8 category names of at most 64 characters");
	return [...raw];
}
function catalogPathWithin(path, prefix) {
	return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}
function parseTemplateScope(raw) {
	if (!Array.isArray(raw) || raw.length > 20) throw new Error("task-template: templateScope must be an array of at most 20 catalog paths");
	const paths = raw.map(parseCatalogPath);
	return paths.filter((path, index) => !paths.some((prefix, other) => other !== index && catalogPathWithin(path, prefix) && (prefix.length < path.length || other < index)));
}
function taskTemplateDigest(template) {
	return sha256Hex(canonicalize(template));
}

//#endregion
//#region src/service/checks/contract.ts
/** A task's contract is either absent — a task created before the contract existed — or the single source its projection fields are generated from. */
function assertContract(taskId, contract, task) {
	assertContractFields(`task "${taskId}"`, contract);
	if (task.objective !== contract.objective) throw new Error(`task: task "${taskId}" objective disagrees with its contract objective`);
	if (canonicalize(task.acceptanceCriteria) !== canonicalize(contract.acceptanceCriteria)) throw new Error(`task: task "${taskId}" acceptance criteria disagree with its contract`);
	if (canonicalize(task.requestedCapabilities) !== canonicalize(contract.requiredCapabilities)) throw new Error(`task: task "${taskId}" requested capabilities disagree with its contract`);
	if (task.contractDigest !== void 0 && task.contractDigest !== contractDigest(contract)) throw new Error(`task: task "${taskId}" contractDigest disagrees with its contract`);
	for (const field of ["templateRef", "templateParameters"]) if (canonicalize(task[field] ?? null) !== canonicalize(contract[field] ?? null)) throw new Error(`task: task "${taskId}" ${field} disagrees with its contract`);
}
/** The contract fields one normalized contract must carry, checked the same way wherever a contract is stored — on a task (T1) and on each child of a proposal's batch (T2). */
function assertContractFields(where, contract) {
	if (contract.templateScope !== void 0) parseTemplateScope(contract.templateScope);
	if (contract.contractVersion !== TASK_CONTRACT_VERSION) throw new Error(`task: ${where} declares contract version ${String(contract.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`);
	const lists = [
		["assumptions", contract.assumptions],
		["constraints", contract.constraints],
		["requiredCapabilities", contract.requiredCapabilities]
	];
	for (const [name, value] of lists) if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`task: ${where} contract ${name} must be an array of strings`);
	if (typeof contract.objective !== "string") throw new Error(`task: ${where} contract objective must be a string`);
	const ref = contract.templateRef;
	if (ref !== void 0 && (!isRecord(ref) || typeof ref.id !== "string" || !Number.isSafeInteger(ref.version) || ref.version < 1 || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/.test(ref.digest))) throw new Error(`task: ${where} templateRef must pin an id, positive version and SHA-256 digest`);
	const parameters = contract.templateParameters;
	if (ref === void 0 !== (parameters === void 0) || parameters !== void 0 && (!isRecord(parameters) || Object.values(parameters).some((value) => ![
		"string",
		"number",
		"boolean"
	].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)))) throw new Error(`task: ${where} templateRef and primitive templateParameters must be recorded together`);
}
/** The batch record a decomposition carries is the identity a later review gate binds an approval to, so a malformed one is refused rather than stored: an empty proposal digest or a non-numeric limit would make the record unusable exactly … */
function assertAdmission(taskId, admission) {
	if (typeof admission.proposalDigest !== "string" || admission.proposalDigest.length === 0) throw new Error(`task: task "${taskId}" decomposition admission requires a proposal digest`);
	const context = admission.context;
	if (!isRecord(context)) throw new Error(`task: task "${taskId}" decomposition admission requires an admission context`);
	assertAdmissionLimits(`task "${taskId}" admission context`, context);
}
/** The limits one admission context carries, checked the same way wherever one is stored — on a decomposition (T1) and on a proposal (T2: the limits the batch was submitted under, whose fingerprint an approval binds). */
function assertAdmissionLimits(where, context) {
	for (const [name, value] of [["maxDepth", context.maxDepth], ["maxChildren", context.maxChildren]]) if (!Number.isInteger(value) || value < 0) throw new Error(`task: ${where} ${name} must be a non-negative integer`);
	const auditOnly = context.auditOnly;
	if (!isRecord(auditOnly)) throw new Error(`task: ${where} auditOnly must be an object`);
	const limits = [
		["auditOnly.maxToolCalls", auditOnly.maxToolCalls],
		["auditOnly.tokens", auditOnly.tokens],
		["auditOnly.attempts", auditOnly.attempts]
	];
	for (const [name, value] of limits) if (value !== void 0 && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`task: ${where} ${name} must be a finite number when present`);
}

//#endregion
//#region src/service/checks/runs.ts
/** The content identity a run records is what a later reader re-checks the snapshot against, so a malformed record is refused rather than stored: a digest that is not a digest, or a skill entry without a name, would make the record unusable … */
function assertProviderBinding(runId, binding) {
	if (typeof binding.registryRevision !== "string" || binding.registryRevision.length === 0) throw new Error(`task: run "${runId}" provider binding requires a registry revision`);
	const list = (name, value) => {
		if (!Array.isArray(value)) throw new Error(`task: run "${runId}" provider binding ${name} must be an array`);
		return value;
	};
	for (const name of list("capabilities", binding.capabilities)) if (typeof name !== "string" || name.length === 0) throw new Error(`task: run "${runId}" provider binding capability names must be non-empty strings`);
	const digest = (where, value, nullable) => {
		if (nullable && value === null) return;
		if (!isDigest(value)) throw new Error(`task: run "${runId}" provider binding ${where} must be a lowercase SHA-256 hex digest${nullable ? " or null" : ""}`);
	};
	for (const entry of list("skills", binding.skills)) {
		if (!isRecord(entry)) throw new Error(`task: run "${runId}" provider binding skill entries must be objects`);
		if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error(`task: run "${runId}" provider binding skill requires a name`);
		if (entry.role !== "execution-provider" && entry.role !== "knowledge" && entry.role !== "guidance") throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" has an unknown role ${JSON.stringify(entry.role)}`);
		if (typeof entry.description !== "string") throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" requires a description`);
		const capabilities = entry.capabilities;
		if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" capabilities must be an array of strings`);
		const uncovered = entry.uncovered;
		if (!Array.isArray(uncovered) || uncovered.some((item) => typeof item !== "string")) throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" uncovered must be an array of strings`);
		digest(`skill "${entry.name}" contractDigest`, entry.contractDigest, true);
		digest(`skill "${entry.name}" contentDigest`, entry.contentDigest, false);
	}
	for (const entry of list("mcpServers", binding.mcpServers)) {
		if (!isRecord(entry)) throw new Error(`task: run "${runId}" provider binding MCP entries must be objects`);
		if (typeof entry.serverName !== "string" || entry.serverName.length === 0) throw new Error(`task: run "${runId}" provider binding MCP entry requires a server name`);
		digest(`MCP server "${entry.serverName}" templateDigest`, entry.templateDigest, true);
	}
	if (binding.snapshotRoot !== void 0 && (typeof binding.snapshotRoot !== "string" || binding.snapshotRoot.length === 0)) throw new Error(`task: run "${runId}" provider binding snapshotRoot must be a non-empty path when present`);
}
/** The submission record is what a reader trusts instead of re-reading the worker's transcript, so a malformed one is refused rather than stored: an unnamed summary or a ref list that is not a list would leave the record unusable exactly when … */
function assertSubmissionShape(runId, submission) {
	if (!isRecord(submission)) throw new Error(`task: run "${runId}" submission must be an object`);
	if (!nonEmpty(submission.summary)) throw new Error(`task: run "${runId}" submission requires a summary`);
	if (!Array.isArray(submission.evidenceRefs) || submission.evidenceRefs.some((item) => typeof item !== "string")) throw new Error(`task: run "${runId}" submission evidence refs must be an array of strings`);
	if (submission.notes !== void 0 && typeof submission.notes !== "string") throw new Error(`task: run "${runId}" submission notes must be a string when present`);
	if (submission.origin !== "worker" && submission.origin !== "runtime") throw new Error(`task: run "${runId}" submission origin must be "worker" or "runtime"`);
	if (!nonEmpty(submission.submittedAt)) throw new Error(`task: run "${runId}" submission requires a submission time`);
}
/** A run's birth phase is written by the runtime, and the reducer judges its shape only — the transition semantics belong to `changeRunPhase`. */
function assertBirthPhase(run) {
	const phase = run.executionPhase;
	if (phase === void 0) return;
	if (phase !== "active" && phase !== "submitted") throw new Error(`task: run "${run.runId}" execution phase must be "active" or "submitted" at start`);
	if (run.batchId !== void 0) throw new Error(`task: run "${run.runId}" is born ${phase}; a batch id is recorded by a phase change, not at start`);
	if (run.batches !== void 0) throw new Error(`task: run "${run.runId}" is born ${phase}; a run's batches are recorded by the decompositions it admits, not at start`);
	if (phase === "active") {
		if (run.submission !== void 0) throw new Error(`task: run "${run.runId}" is born active; only a submitted run carries a submission`);
		return;
	}
	if (run.submission === void 0) throw new Error(`task: run "${run.runId}" is born submitted; a submission record is required`);
	assertSubmissionShape(run.runId, run.submission);
}
/** The A3 question-id mount points ride on a phase change and are read-only since A4: the question records are the one durable source of what a run waits on, and this build's write entries refuse a phase change that carries either field. */
function assertQuestionIds(runId, payload) {
	const lists = [["pendingQuestionIds", payload.pendingQuestionIds], ["blockingQuestionIds", payload.blockingQuestionIds]];
	for (const [name, value] of lists) if (value !== void 0 && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) throw new Error(`task: run "${runId}" ${name} must be an array of strings`);
}
/** A cited body reference: the sending Session, and a seq inside its log. */
function assertMessageRef(where, ref) {
	if (!isRecord(ref)) throw new Error(`task: ${where} body reference must be an object`);
	if (!nonEmpty(ref.sessionId)) throw new Error(`task: ${where} body reference session id must be a non-empty string`);
	if (!Number.isInteger(ref.seq) || ref.seq < 0) throw new Error(`task: ${where} body reference seq must be a non-negative integer`);
}
/** The recovery attempt a run carries (A6, plan §F.4), judged by the reducer as the last gate — the entry re-checks the same facts against policy (the source's failure, the diagnosis, the limits, the capability rows), and this accepts only a … */
function assertRunRecovery(snapshot, taskId, recovery) {
	const where = `task: run recovery of "${taskId}"`;
	if (recovery.kind !== "recovery" && recovery.kind !== "improvement") throw new Error(`${where} requires kind "recovery" or "improvement" (an attempt without one cannot be counted against the cap it spends)`);
	for (const [name, value] of [
		["source diagnosis id", recovery.sourceDiagnosisId],
		["request key", recovery.requestKey],
		["requested at", recovery.requestedAt]
	]) if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${where} requires a non-empty ${name}`);
	if (recovery.sourceRunId !== void 0 && (typeof recovery.sourceRunId !== "string" || recovery.sourceRunId.length === 0)) throw new Error(`${where} source run id must be a non-empty string when present`);
	if (recovery.requestDigest !== void 0 && (typeof recovery.requestDigest !== "string" || recovery.requestDigest.trim().length === 0)) throw new Error(`${where} request digest must be a non-empty string when present`);
	if (recovery.proposalIds !== void 0 && (!Array.isArray(recovery.proposalIds) || recovery.proposalIds.some((id) => typeof id !== "string" || id.trim().length === 0) || new Set(recovery.proposalIds).size !== recovery.proposalIds.length)) throw new Error(`${where} proposalIds must be an array of unique non-empty strings`);
	const task = taskIn(snapshot, taskId);
	if (task.parentTaskId !== void 0) throw new Error(`${where} names task "${taskId}", which has a parent; a recovery attempt is opened for the store's own root task`);
	if (!snapshot.diagnoses.some((diagnosis) => diagnosis.diagnosisId === recovery.sourceDiagnosisId && diagnosis.taskId === taskId)) throw new Error(`${where} cites diagnosis "${recovery.sourceDiagnosisId}", which this store holds no record of for task "${taskId}"; a recovery is asked for by a diagnosis of the failing task and by nothing else`);
	let sourceRun;
	if (recovery.sourceRunId !== void 0) {
		sourceRun = snapshot.runs.find((run) => run.runId === recovery.sourceRunId);
		if (sourceRun === void 0) throw new Error(`${where} cites unknown run "${recovery.sourceRunId}"`);
		if (sourceRun.taskId !== taskId) throw new Error(`${where} cites run "${recovery.sourceRunId}", which belongs to task "${sourceRun.taskId}", not "${taskId}"`);
	}
	const reused = recovery.reusedMembers;
	if (!Array.isArray(reused)) throw new Error(`${where} reused members must be an array`);
	const claimed = /* @__PURE__ */ new Set();
	reused.forEach((member, position) => {
		const at = `${where} reused member ${position}`;
		if (!isRecord(member)) throw new Error(`${at} must be an object`);
		if (!Number.isInteger(member.childIndex) || member.childIndex < 0) throw new Error(`${at} childIndex ${JSON.stringify(member.childIndex)} must be a non-negative integer`);
		if (claimed.has(member.childIndex)) throw new Error(`${at} claims position ${member.childIndex}, which another entry of this record already claims; one position reads one member`);
		claimed.add(member.childIndex);
		if (sourceRun !== void 0 && runMemberSlots(sourceRun)[member.childIndex] !== member.taskId) throw new Error(`${at} claims position ${member.childIndex} for "${String(member.taskId)}", but ${recovery.kind === "improvement" ? "the verified" : "the failed"} run "${sourceRun.runId}" reads ${runMemberSlots(sourceRun)[member.childIndex] === void 0 ? "no member" : `"${runMemberSlots(sourceRun)[member.childIndex]}"`} there`);
		const sibling = snapshot.tasks.find((candidate) => candidate.taskId === member.taskId);
		if (sibling === void 0) throw new Error(`${at} cites unknown task "${String(member.taskId)}"`);
		if (sibling.parentTaskId !== taskId) throw new Error(`${at} cites task "${sibling.taskId}", which is not a child of "${taskId}"; only a sibling of the failed attempt can be reused`);
		if (sibling.status !== "verified") throw new Error(`${at} cites task "${sibling.taskId}", which is ${sibling.status}, not verified; only evidence of a passed sibling is reusable`);
		const source = snapshot.runs.find((run) => run.runId === member.sourceRunId);
		if (source === void 0) throw new Error(`${at} cites unknown run "${String(member.sourceRunId)}"`);
		if (source.taskId !== sibling.taskId) throw new Error(`${at} cites run "${source.runId}", which belongs to task "${source.taskId}", not "${sibling.taskId}"`);
		if (source.status !== "verified") throw new Error(`${at} cites run "${source.runId}", which is ${source.status}; a reused member reads the evidence of a verified run`);
		const bundle = snapshot.evidence.find((item) => item.evidenceId === member.evidenceId);
		if (bundle === void 0) throw new Error(`${at} cites unknown evidence "${String(member.evidenceId)}"`);
		if (bundle.taskRunId !== source.runId || bundle.taskId !== sibling.taskId) throw new Error(`${at} cites evidence "${bundle.evidenceId}", which belongs to task "${bundle.taskId}"/run "${bundle.taskRunId}", not to "${sibling.taskId}"/"${source.runId}"`);
		const named = new Set(bundle.artifacts.flatMap((artifact) => [artifact.artifactId, artifact.kind]));
		for (const reference of member.artifactRefs ?? []) if (!named.has(reference)) throw new Error(`${at} cites artifact "${String(reference)}", which the evidence "${bundle.evidenceId}" does not hold (by artifact id or kind)`);
		if (member.criterionId !== void 0) {
			if (sibling.acceptanceCriteria.find((item) => item.criterionId === member.criterionId) === void 0) throw new Error(`${at} names criterion "${member.criterionId}", which the sibling "${sibling.taskId}" does not declare`);
			const verdict = bundle.verifierResults.find((item) => item.criterionId === member.criterionId);
			if (verdict?.status !== "pass") throw new Error(`${at} names criterion "${member.criterionId}" of sibling "${sibling.taskId}", whose verified evidence carries ${verdict === void 0 ? "no verdict" : `a "${verdict.status}" verdict`}; only a passing verdict is reusable`);
		}
		const declaredInputs = new Set(sibling.acceptanceCriteria.flatMap((criterion) => [
			...criterion.requiresArtifact ?? [],
			...criterion.acceptsArtifact ?? [],
			...(criterion.protectedInputs ?? []).map((input) => input.path)
		]));
		for (const reference of member.inputRefs ?? []) if (!declaredInputs.has(reference)) throw new Error(`${at} cites input "${String(reference)}", which the sibling "${sibling.taskId}" does not declare (requiresArtifact, acceptsArtifact or protectedInputs)`);
		const mapEntry = task.acceptanceCriteria.flatMap((criterion) => criterion.childEvidence ?? []).find((entry) => entry.childIndex === member.childIndex);
		if (mapEntry !== void 0) {
			if (mapEntry.criterionId !== void 0 && mapEntry.criterionId !== member.criterionId) throw new Error(`${at} claims position ${member.childIndex}, which the original acceptance map narrows to criterion "${mapEntry.criterionId}"; this record ${member.criterionId === void 0 ? "names no criterion" : `names "${member.criterionId}"`}`);
			if (mapEntry.evidenceRef !== void 0 && member.evidenceId !== mapEntry.evidenceRef && !(member.artifactRefs ?? []).includes(mapEntry.evidenceRef)) throw new Error(`${at} claims position ${member.childIndex}, which the original acceptance map narrows to evidence "${mapEntry.evidenceRef}"; the cited bundle does not carry that identity (evidence id, artifact id or artifact kind)`);
		}
	});
	const unbound = recovery.unboundMembers;
	if (unbound !== void 0) {
		if (!Array.isArray(unbound)) throw new Error(`${where} unbound members must be an array`);
		for (const [position, entry] of unbound.entries()) {
			const at = `${where} unbound member ${position}`;
			if (!isRecord(entry)) throw new Error(`${at} must be an object`);
			if (!Number.isInteger(entry.childIndex) || entry.childIndex < 0) throw new Error(`${at} childIndex ${JSON.stringify(entry.childIndex)} must be a non-negative integer`);
			if (!Array.isArray(entry.reasons) || entry.reasons.length === 0 || entry.reasons.some((reason) => typeof reason !== "string" || reason.trim().length === 0)) throw new Error(`${at} must carry at least one non-empty reason; a position left unbound is a finding, never a silent omission`);
			if (claimed.has(entry.childIndex)) throw new Error(`${at} names position ${entry.childIndex}, which this record also claims; a position is either bound or left open`);
		}
	}
}

//#endregion
//#region src/service/questions.ts
/** The snapshot's question index, or a refusal: an absent index is "cannot see", never "holds none". */
function questionIndex(snapshot) {
	return requireIndex(snapshot.questions, "task: snapshot carries no question index");
}
/** A child run asks its direct parent (A4 §F.1). The reducer is the gate for the whole shape, in this order: the record must be well-formed, its id must be the identity its own (child run, request key) pair derives, the asking run must exist … */
function askQuestion(snapshot, taskId, envelopeRunId, envelopeParentTaskId, question) {
	if (!isRecord(question)) throw new Error("task: question must be an object");
	if (!nonEmpty(question.questionId)) throw new Error("task: question id must be a non-empty string");
	const id = question.questionId;
	if (!nonEmpty(question.requestKey)) throw new Error(`task: question "${id}" request key must be a non-empty string`);
	if (!nonEmpty(question.messageId)) throw new Error(`task: question "${id}" message id must be a non-empty string`);
	if (!isDigest(question.questionDigest)) throw new Error(`task: question "${id}" content digest must be a lowercase SHA-256 hex digest`);
	if (typeof question.blocking !== "boolean") throw new Error(`task: question "${id}" blocking must be a boolean`);
	if (!nonEmpty(question.askedAt)) throw new Error(`task: question "${id}" requires an ask time`);
	if (question.answers !== void 0) throw new Error(`task: question "${id}" is asked without answers; an answer is its own event`);
	assertMessageRef(`question "${id}"`, question.questionRef);
	const derived = questionIdOf({
		childRunId: question.childRunId,
		requestKey: question.requestKey
	});
	if (id !== derived) throw new Error(`task: question id "${id}" is not the identity of child run "${question.childRunId}" and request key "${question.requestKey}" ("${derived}")`);
	const child = runIn(snapshot, question.childRunId);
	if (envelopeRunId !== child.runId) throw new Error(`task: question "${id}" envelope run id mismatch: the asking run is "${child.runId}", the envelope names "${String(envelopeRunId)}"`);
	const childTask = taskIn(snapshot, child.taskId);
	if (taskId !== childTask.taskId) throw new Error(`task: question "${id}" is asked by run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`);
	if (child.status !== "running") throw new Error(`task: child run "${child.runId}" is ${child.status}; a question requires a running run`);
	if (childTask.parentTaskId === void 0) throw new Error(`task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`);
	const parentTask = taskIn(snapshot, childTask.parentTaskId);
	if (envelopeParentTaskId !== parentTask.taskId) throw new Error(`task: question "${id}" must carry parent task id "${parentTask.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`);
	const parentRunId = parentTask.runIds[parentTask.runIds.length - 1];
	if (parentRunId === void 0) throw new Error(`task: parent task "${parentTask.taskId}" has no run for question "${id}"`);
	const parentRun = runIn(snapshot, parentRunId);
	if (question.parentRunId !== parentRun.runId) throw new Error(`task: question "${id}" names parent run "${question.parentRunId}"; task "${parentTask.taskId}"'s current run is "${parentRun.runId}"`);
	if (parentRun.status !== "running") throw new Error(`task: parent run "${parentRun.runId}" is ${parentRun.status}; a question requires a running parent run`);
	if (question.questionRef.sessionId !== child.sessionId) throw new Error(`task: question "${id}" cites session "${question.questionRef.sessionId}"; the asking run's session is "${child.sessionId}"`);
	const index = questionIndex(snapshot);
	if (index.byId[id] !== void 0) throw new Error(`task: question "${id}" already exists`);
	const stored = copy(question);
	snapshot = {
		...snapshot,
		questions: {
			all: [...index.all, stored],
			byId: {
				...index.byId,
				[id]: stored
			}
		}
	};
	return snapshot;
}
/** A parent run answers one of its children's questions (A4 §F.1). An answer is appended to the question's record, so the reducer's job is to decide whether this answer may join *this* question: the id must be the one its (question, request … */
function answerQuestion(snapshot, taskId, envelopeRunId, envelopeParentTaskId, answer) {
	if (!isRecord(answer)) throw new Error("task: answer must be an object");
	if (!nonEmpty(answer.answerId)) throw new Error("task: answer id must be a non-empty string");
	const id = answer.answerId;
	if (!nonEmpty(answer.questionId)) throw new Error(`task: answer "${id}" question id must be a non-empty string`);
	if (!nonEmpty(answer.requestKey)) throw new Error(`task: answer "${id}" request key must be a non-empty string`);
	if (!nonEmpty(answer.messageId)) throw new Error(`task: answer "${id}" message id must be a non-empty string`);
	if (!isDigest(answer.answerDigest)) throw new Error(`task: answer "${id}" content digest must be a lowercase SHA-256 hex digest`);
	if (typeof answer.resolves !== "boolean") throw new Error(`task: answer "${id}" resolves must be a boolean`);
	if (!nonEmpty(answer.answeredAt)) throw new Error(`task: answer "${id}" requires an answer time`);
	assertMessageRef(`answer "${id}"`, answer.answerRef);
	const derived = answerIdOf({
		questionId: answer.questionId,
		requestKey: answer.requestKey
	});
	if (id !== derived) throw new Error(`task: answer id "${id}" is not the identity of question "${answer.questionId}" and request key "${answer.requestKey}" ("${derived}")`);
	const question = questionIndex(snapshot).byId[answer.questionId];
	if (question === void 0) throw new Error(`task: unknown question "${answer.questionId}"`);
	if (answer.parentRunId !== question.parentRunId) throw new Error(`task: answer "${id}" names parent run "${answer.parentRunId}"; question "${question.questionId}" was asked of run "${question.parentRunId}"`);
	const child = runIn(snapshot, question.childRunId);
	const parent = runIn(snapshot, question.parentRunId);
	if (child.status !== "running") throw new Error(`task: question "${question.questionId}" is not open: child run "${child.runId}" is ${child.status}; a question requires a running run`);
	if (parent.status !== "running") throw new Error(`task: question "${question.questionId}" is not open: parent run "${parent.runId}" is ${parent.status}; a question requires a running parent run`);
	if (answer.answerRef.sessionId !== parent.sessionId) throw new Error(`task: answer "${id}" cites session "${answer.answerRef.sessionId}"; the answering run's session is "${parent.sessionId}"`);
	if (envelopeRunId !== parent.runId) throw new Error(`task: answer "${id}" envelope run id mismatch: the answering run is "${parent.runId}", the envelope names "${String(envelopeRunId)}"`);
	const childTask = taskIn(snapshot, child.taskId);
	if (taskId !== childTask.taskId) throw new Error(`task: answer "${id}" belongs to run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`);
	if (envelopeParentTaskId !== parent.taskId) throw new Error(`task: answer "${id}" must carry parent task id "${parent.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`);
	const answers = question.answers ?? [];
	if (answers.some((item) => item.resolves)) throw new Error(`task: question "${question.questionId}" is already resolved; answer "${id}" is refused`);
	if (answers.some((item) => item.answerId === id)) throw new Error(`task: answer "${id}" already exists`);
	const stored = {
		...question,
		answers: [...answers, copy(answer)]
	};
	const replace = (questions) => questions.map((item) => item.questionId === question.questionId ? stored : item);
	snapshot = {
		...snapshot,
		questions: {
			all: replace(questionIndex(snapshot).all),
			byId: {
				...questionIndex(snapshot).byId,
				[question.questionId]: stored
			}
		}
	};
	return snapshot;
}

//#endregion
//#region src/service/records.ts
function resolveCapabilities(snapshot, taskId, manifest) {
	taskIn(snapshot, taskId);
	snapshot = {
		...snapshot,
		capabilities: {
			...snapshot.capabilities,
			[taskId]: copy(manifest)
		}
	};
	return snapshot;
}
function produceEvidence(snapshot, taskId, runId, evidence) {
	taskIn(snapshot, taskId);
	if (typeof evidence.evidenceId !== "string" || evidence.evidenceId.length === 0) throw new Error("task: evidence id must be a non-empty string");
	if (snapshot.evidence.some((item) => item.evidenceId === evidence.evidenceId)) throw new Error(`task: evidence "${evidence.evidenceId}" already exists`);
	if (evidence.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" does not belong to task "${taskId}"`);
	const run = runIn(snapshot, evidence.taskRunId);
	if (run.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" run "${run.runId}" belongs to task "${run.taskId}"`);
	if (runId !== void 0 && runId !== evidence.taskRunId) throw new Error(`task: evidence "${evidence.evidenceId}" envelope run id mismatch`);
	if (run.status !== "running") throw new Error(`task: run "${run.runId}" is ${run.status}; evidence can only be recorded while the run is running`);
	snapshot = {
		...snapshot,
		evidence: [...snapshot.evidence, copy(evidence)],
		runs: snapshot.runs.map((item) => item.runId === run.runId ? {
			...item,
			artifacts: [...item.artifacts, ...copy(evidence.artifacts)],
			verifierResults: [...item.verifierResults, ...copy(evidence.verifierResults)]
		} : item)
	};
	return snapshot;
}
function addHandoff(snapshot, handoff) {
	if (typeof handoff.handoffId !== "string" || handoff.handoffId.length === 0) throw new Error("task: handoff id must be a non-empty string");
	if (snapshot.handoffs.some((item) => item.handoffId === handoff.handoffId)) throw new Error(`task: handoff "${handoff.handoffId}" already exists`);
	const parent = taskIn(snapshot, handoff.parentTaskId);
	const child = taskIn(snapshot, handoff.childTaskId);
	if (child.parentTaskId !== parent.taskId) throw new Error(`task: handoff child "${child.taskId}" is not a child of "${parent.taskId}"`);
	runIn(snapshot, handoff.parentRunId);
	snapshot = {
		...snapshot,
		handoffs: [...snapshot.handoffs, copy(handoff)]
	};
	return snapshot;
}
/** A review is the legal companion of the terminal transition it follows: the run (or the runless blocked task) must already sit in the outcome the record declares, and each run accepts exactly one record — a second one is a bug in the … */
function recordReview(snapshot, taskId, envelopeRunId, review) {
	const task = taskIn(snapshot, taskId);
	if (review.taskId !== taskId) throw new Error(`task: review for "${review.taskId}" does not belong to task "${taskId}"`);
	if (review.outcome === "failed" && (typeof review.localizedCause !== "string" || review.localizedCause.length === 0)) throw new Error(`task: failed review for task "${taskId}" requires a localized cause`);
	if (review.outcome !== "failed" && review.localizedCause !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a localized cause`);
	if (review.outcome !== "failed" && review.logTail !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a log tail`);
	if (review.outcome !== "blocked" && review.blockedBy !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a blocked outcome carries blockers`);
	if (review.runId === void 0) {
		if (review.outcome !== "blocked" || task.status !== "blocked") throw new Error(`task: review for task "${taskId}" has no run; only a blocked task settles without a run`);
		if (snapshot.reviews.some((item) => item.taskId === taskId && item.runId === void 0)) throw new Error(`task: task "${taskId}" already has a runless review`);
	} else {
		const run = runIn(snapshot, review.runId);
		if (run.taskId !== taskId) throw new Error(`task: review run "${run.runId}" belongs to task "${run.taskId}"`);
		if (envelopeRunId !== void 0 && envelopeRunId !== review.runId) throw new Error(`task: review for run "${review.runId}" envelope run id mismatch`);
		if (run.status !== review.outcome) throw new Error(`task: run "${run.runId}" is ${run.status}; a review must follow the terminal transition it declares (${review.outcome})`);
		if (snapshot.reviews.some((item) => item.runId === review.runId)) throw new Error(`task: run "${review.runId}" already has a review`);
	}
	snapshot = {
		...snapshot,
		reviews: [...snapshot.reviews, copy(review)]
	};
	return snapshot;
}
/** A diagnosis is caller-triggered, not lifecycle-bound: any existing task accepts one at any time, and a task accumulates several. */
function recordDiagnosis(snapshot, taskId, diagnosis) {
	taskIn(snapshot, taskId);
	if (!nonEmpty(diagnosis.diagnosisId)) throw new Error("task: diagnosis id must be a non-empty string");
	if (snapshot.diagnoses.some((item) => item.diagnosisId === diagnosis.diagnosisId)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" already exists`);
	if (diagnosis.taskId !== taskId) throw new Error(`task: diagnosis for "${diagnosis.taskId}" does not belong to task "${taskId}"`);
	if (!nonEmpty(diagnosis.observedFailure)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires an observed failure`);
	if (!nonEmpty(diagnosis.scope)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a scope`);
	if (!nonEmpty(diagnosis.localizedCause)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a localized cause`);
	if (![
		"high",
		"medium",
		"low"
	].includes(diagnosis.confidence)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" confidence must be high, medium, or low`);
	if (!Array.isArray(diagnosis.evidenceRefs) || !Array.isArray(diagnosis.reviewRefs) || diagnosis.evidenceRefs.some((item) => !nonEmpty(item)) || diagnosis.reviewRefs.some((item) => !nonEmpty(item))) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" refs must be arrays of non-empty strings`);
	if (diagnosis.evidenceRefs.length + diagnosis.reviewRefs.length === 0) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" must rest on at least one evidence or review ref`);
	if (!Array.isArray(diagnosis.proposals)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposals must be an array`);
	for (const proposal of diagnosis.proposals) {
		if (!nonEmpty(proposal.targetType)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal target type must be a non-empty string`);
		if (!nonEmpty(proposal.targetId) || !nonEmpty(proposal.rationale)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal requires a target id and a rationale`);
	}
	if (diagnosis.producedBy !== void 0) {
		const provenance = diagnosis.producedBy;
		if (provenance.kind !== "agent" && provenance.kind !== "human") throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.kind must be "agent" or "human"`);
		if (provenance.sessionId !== void 0 && !nonEmpty(provenance.sessionId)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.sessionId must be a non-empty string`);
	}
	if (diagnosis.judgements !== void 0) {
		if (!Array.isArray(diagnosis.judgements)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgements must be an array`);
		for (const judgement of diagnosis.judgements) {
			if (!JUDGED_DIMENSIONS.includes(judgement.dimension)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement dimension must be one of ${JUDGED_DIMENSIONS.join(", ")}`);
			if (!JUDGEMENT_VERDICTS.includes(judgement.verdict)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement verdict must be one of ${JUDGEMENT_VERDICTS.join(", ")}`);
			if (!Array.isArray(judgement.evidenceRefs) || judgement.evidenceRefs.length === 0 || judgement.evidenceRefs.some((item) => !nonEmpty(item))) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" must rest on at least one non-empty evidence ref`);
			if (!nonEmpty(judgement.rationale)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" requires a rationale`);
		}
	}
	for (const related of diagnosis.relatedTaskIds ?? []) taskIn(snapshot, related);
	snapshot = {
		...snapshot,
		diagnoses: [...snapshot.diagnoses, copy(diagnosis)]
	};
	return snapshot;
}
/** An obligation is raised, never scheduled (KISS §5.1: a question, not an action): the reducer enforces integrity only — a unique non-empty id, non-empty goal and criterion, and a source task that exists in the store. */
function recordObligation(snapshot, obligation) {
	if (!nonEmpty(obligation.obligationId)) throw new Error("task: obligation id must be a non-empty string");
	if (snapshot.obligations.some((item) => item.obligationId === obligation.obligationId)) throw new Error(`task: obligation "${obligation.obligationId}" already exists`);
	if (!nonEmpty(obligation.goal)) throw new Error(`task: obligation "${obligation.obligationId}" requires a goal`);
	if (!nonEmpty(obligation.criterion)) throw new Error(`task: obligation "${obligation.obligationId}" requires a criterion`);
	taskIn(snapshot, obligation.sourceTaskId);
	snapshot = {
		...snapshot,
		obligations: [...snapshot.obligations, copy(obligation)]
	};
	return snapshot;
}

//#endregion
//#region src/service/checks/proposals.ts
/** The closed field set of a review context ({@link TaskProposalReviewContext}); an unread field must not move an identity. */
const REVIEW_CONTEXT_FIELDS = ["capabilityManifestDigest", "verifiers"];
/** The closed field set of one batch child ({@link TaskProposalChild}); an unread field must not enter an identity. */
const PROPOSAL_CHILD_FIELDS = [
	"contract",
	"dependsOn",
	"decomposable",
	"requiresIndependentAcceptance"
];
/** The closed field set of one verifier identity ({@link TaskProposalVerifierIdentity}). */
const VERIFIER_IDENTITY_FIELDS = [
	"verifierId",
	"version",
	"configurationDigest"
];
/** The closed field set of a decomposition identity ({@link DecompositionIdentity}): what its digest covers, and nothing else. */
const DECOMPOSITION_IDENTITY_FIELDS = [
	"contractVersion",
	"storeId",
	"parentTaskId",
	"parentRunId",
	"callerSessionId",
	"reason",
	"children",
	"templateRef",
	"templateParameters"
];
/** The closed field set of a root contract identity ({@link RootProposalIdentity}). */
const ROOT_IDENTITY_FIELDS = [
	"contractVersion",
	"storeId",
	"rootSessionId",
	"requestKey",
	"contractDigest"
];
/** The batch vocabulary a root consumption must not carry: the ids it names are a task id and a run id, not a batch. */
const BATCH_CONSUMPTION_FIELDS = [
	"batchId",
	"parentRunId",
	"childTaskIds"
];
/** The root vocabulary a batch consumption must not carry. */
const ROOT_CONSUMPTION_FIELDS = ["rootTaskId", "rootRunId"];
/** The stored proposal one event names, or a refusal naming the id. */
function proposalIn(snapshot, proposalId) {
	const proposal = proposalIndex(snapshot).byId[proposalId];
	if (proposal === void 0) throw new Error(`task: unknown proposal "${String(proposalId)}"`);
	return proposal;
}
/** The proposal index of the snapshot this state replays on. It is absent only when a foreign snapshot (a hand-built one from a reader that predates proposals) was replayed onto — never on this build's own value — and that is a refusal rather … */
function proposalIndex(snapshot) {
	return requireIndex(snapshot.proposals, "task: snapshot carries no proposal index");
}
/** The store's root task, if it has one: the task a root intake may not sit beside or activate a second time. */
function rootTaskIn(snapshot) {
	return snapshot.tasks.find((item) => item.parentTaskId === void 0);
}
/** A store with a root task refuses root intake by name (A0 §1.6): the root it holds is somebody's goal, and a second intake would make "the store's root" answer differently at two reads. A goal change is a new graph, never a second root here. */
function assertRootIntakeOpen(snapshot, proposalId) {
	const root = rootTaskIn(snapshot);
	if (root !== void 0) throw new Error(`task: store "${snapshot.id}" already holds root task "${root.taskId}"; proposal "${proposalId}" is refused`);
}
/** Every proposal event is about one subject, and the envelope has to name it: a decomposition proposal's events name the parent task whose batch it is; a root contract's events name the reserved {@link ROOT_PROPOSAL_TASK_ID} marker, because … */
function assertProposalTask(proposal, taskId) {
	if (proposal.kind === "root") {
		if (taskId !== ROOT_PROPOSAL_TASK_ID) throw new Error(`task: proposal "${proposal.proposalId}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${taskId}"`);
		return;
	}
	if (taskId !== proposal.identity.parentTaskId) throw new Error(`task: proposal "${proposal.proposalId}" belongs to task "${proposal.identity.parentTaskId}", not "${taskId}"`);
}
/** One proposal's status either admits this outcome or the event is a late or out-of-order write. */
function assertProposalTransition(proposal, to, from) {
	if (!from.includes(proposal.status)) throw new Error(`task: illegal proposal transition "${proposal.status}" → "${to}" for proposal "${proposal.proposalId}"`);
}
/** Replaces one proposal in place; the index's other views keep pointing at the same record. */
function setProposal(snapshot, proposalId, patch) {
	const index = proposalIndex(snapshot);
	const current = index.byId[proposalId];
	if (current === void 0) throw new Error(`task: unknown proposal "${proposalId}"`);
	const next = {
		...current,
		...patch
	};
	const replace = (proposals) => proposals.map((item) => item.proposalId === proposalId ? next : item);
	snapshot = {
		...snapshot,
		proposals: {
			all: replace(index.all),
			byId: {
				...index.byId,
				[proposalId]: next
			},
			byRequestKey: {
				...index.byRequestKey,
				[next.requestKey]: next
			},
			byParentTask: Object.fromEntries(Object.entries(index.byParentTask).map(([parentTaskId, proposals]) => [parentTaskId, replace(proposals)]))
		}
	};
	return snapshot;
}
/** A submitted proposal has to be complete and internally consistent, because everything an approval binds is taken from it: the review context is a closed record (an unread field would silently become part of an identity), the birth status … */
function assertProposal(snapshot, proposal) {
	if (!isRecord(proposal)) throw new Error("task: proposal must be an object");
	if (!nonEmpty(proposal.proposalId)) throw new Error("task: proposal id must be a non-empty string");
	const id = proposal.proposalId;
	if (!nonEmpty(proposal.requestKey)) throw new Error(`task: proposal "${id}" request key must be a non-empty string`);
	const kind = proposal.kind;
	if (kind !== void 0 && kind !== "decomposition" && kind !== "root") throw new Error(`task: proposal "${id}" kind must be one of ${TASK_PROPOSAL_KINDS.join(", ")}`);
	if (kind === void 0 && carriesRootContract(proposal)) throw new Error(`task: proposal "${id}" carries root contract fields without kind "root"`);
	if (proposal.status !== "ready" && proposal.status !== "pending_review") throw new Error(`task: proposal "${id}" status "${String(proposal.status)}" is not a birth status`);
	if (proposal.policy !== "off" && proposal.policy !== "all") throw new Error(`task: proposal "${id}" policy must be "off" or "all"`);
	if (proposal.status === "ready" && proposal.policy === "all") throw new Error(`task: proposal "${id}" is submitted ready with policy "all"`);
	if (proposal.status === "pending_review" && proposal.policy === "off") throw new Error(`task: proposal "${id}" is submitted pending_review with policy "off"`);
	if (proposal.supersedes !== void 0) {
		if (!nonEmpty(proposal.supersedes)) throw new Error(`task: proposal "${id}" supersedes must be a non-empty proposal id`);
		if (proposal.supersedes === id) throw new Error(`task: proposal "${id}" cannot supersede itself`);
		if (proposalIndex(snapshot).byId[proposal.supersedes] === void 0) throw new Error(`task: proposal "${id}" supersedes unknown proposal "${proposal.supersedes}"`);
	}
	if (proposal.kind === "root") assertRootProposal(id, proposal);
	else assertDecompositionProposal(snapshot, id, proposal);
	const context = proposal.admissionContext;
	if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires an admission context`);
	assertAdmissionLimits(`proposal "${id}" admission context`, context);
	const contextDigest = admissionContextDigest(proposal.admissionContext);
	if (proposal.admissionContextDigest !== contextDigest) throw new Error(`task: proposal "${id}" admission context digest "${String(proposal.admissionContextDigest)}" does not match its context digest "${contextDigest}"`);
	assertReviewContext(id, proposal.reviewContext);
	const reviewDigest = reviewContextDigest(proposal.reviewContext);
	if (proposal.reviewContextDigest !== reviewDigest) throw new Error(`task: proposal "${id}" review context digest "${String(proposal.reviewContextDigest)}" does not match its context digest "${reviewDigest}"`);
	if (!nonEmpty(proposal.createdAt)) throw new Error(`task: proposal "${id}" requires a creation time`);
	if (proposal.decision !== void 0) throw new Error(`task: proposal "${id}" is submitted with a decision`);
	if (proposal.consumption !== void 0) throw new Error(`task: proposal "${id}" is submitted with a consumption`);
}
/** A decomposition proposal's half of the record: the batch identity and the batch content that must be the content of that identity. */
function assertDecompositionProposal(snapshot, id, proposal) {
	if (proposal.contract !== void 0) throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot carry a root contract`);
	assertProposalIdentity(snapshot, id, proposal.identity);
	assertProposalBatch(id, proposal.batch, proposal.identity);
	const expected = decompositionDigest(proposal.identity);
	if (proposal.proposalDigest !== expected) throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`);
}
/** A root contract proposal's half of the record: the root identity (store, root session, request key, contract digest — and no parent task) and the one normalized contract it must be the digest of. */
function assertRootProposal(id, proposal) {
	if (proposal.batch !== void 0) throw new Error(`task: proposal "${id}" is a root contract and cannot carry a batch`);
	assertRootIdentity(id, proposal.identity);
	if (proposal.identity.requestKey !== proposal.requestKey) throw new Error(`task: proposal "${id}" identity request key "${proposal.identity.requestKey}" disagrees with its request key "${proposal.requestKey}"`);
	const contract = proposal.contract;
	if (!isRecord(contract)) throw new Error(`task: proposal "${id}" requires a root contract`);
	assertContractFields(`proposal "${id}" root`, contract);
	if (!Array.isArray(contract.acceptanceCriteria)) throw new Error(`task: proposal "${id}" root contract acceptance criteria must be an array`);
	const digest = contractDigest(contract);
	if (digest !== proposal.identity.contractDigest) throw new Error(`task: proposal "${id}" contract digest "${digest}" does not match its identity digest "${proposal.identity.contractDigest}"`);
	const expected = rootProposalDigest(proposal.identity);
	if (proposal.proposalDigest !== expected) throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`);
}
/** Whether a record that does not claim `kind: 'root'` still carries a root contract's fields. */
function carriesRootContract(proposal) {
	const raw = proposal;
	if (raw.contract !== void 0) return true;
	const identity = raw.identity;
	return isRecord(identity) && identity.rootSessionId !== void 0;
}
/** The batch identity a proposal carries, judged for shape only: the field semantics (a version this build knows, non-empty origins, one dependency index per child) are what a reader needs to interpret it, while the *rules* about a batch — … */
function assertProposalIdentity(snapshot, id, identity) {
	if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`);
	for (const key of Object.keys(identity)) if (!DECOMPOSITION_IDENTITY_FIELDS.includes(key)) throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`);
	if (identity.contractVersion !== TASK_CONTRACT_VERSION) throw new Error(`task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`);
	const names = [
		["store id", identity.storeId],
		["parent run id", identity.parentRunId],
		["caller session id", identity.callerSessionId]
	];
	for (const [name, value] of names) if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`);
	if (!nonEmpty(identity.parentTaskId)) throw new Error(`task: proposal "${id}" identity parent task id must be a non-empty string`);
	if (typeof identity.reason !== "string") throw new Error(`task: proposal "${id}" identity reason must be a string`);
	if (identity.templateRef !== void 0) {
		const ref = identity.templateRef;
		if (!isRecord(ref) || typeof ref.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 || !isDigest(ref.digest) || Object.keys(ref).some((key) => ![
			"id",
			"version",
			"digest"
		].includes(key))) throw new Error(`task: proposal "${id}" identity templateRef requires an exact id, version and digest`);
	} else if (identity.templateParameters !== void 0) throw new Error(`task: proposal "${id}" identity templateParameters requires templateRef`);
	if (identity.templateParameters !== void 0 && (!isRecord(identity.templateParameters) || Object.values(identity.templateParameters).some((value) => ![
		"string",
		"boolean",
		"number"
	].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)))) throw new Error(`task: proposal "${id}" identity templateParameters requires finite primitive values`);
	if (!Array.isArray(identity.children) || identity.children.length === 0) throw new Error(`task: proposal "${id}" identity requires at least one child`);
	identity.children.forEach((child, index) => {
		if (!isRecord(child)) throw new Error(`task: proposal "${id}" child ${index} must be an object`);
		if (!isDigest(child.contractDigest)) throw new Error(`task: proposal "${id}" child ${index} contract digest must be a lowercase SHA-256 hex digest`);
		if (!Array.isArray(child.dependsOn) || child.dependsOn.some((item) => !Number.isInteger(item) || item < 0)) throw new Error(`task: proposal "${id}" child ${index} dependsOn must be an array of non-negative integers`);
		if (typeof child.decomposable !== "boolean") throw new Error(`task: proposal "${id}" child ${index} decomposable must be a boolean`);
		if (typeof child.requiresIndependentAcceptance !== "boolean") throw new Error(`task: proposal "${id}" child ${index} requiresIndependentAcceptance must be a boolean`);
	});
	if (!snapshot.tasks.some((item) => item.taskId === identity.parentTaskId)) throw new Error(`task: proposal "${id}" names unknown parent task "${identity.parentTaskId}"`);
}
/** The root identity a root contract carries, judged for shape only: the version of the contract language, the store and root session it is for, its request key and the digest of the contract beside it. */
function assertRootIdentity(id, identity) {
	if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`);
	for (const key of Object.keys(identity)) if (!ROOT_IDENTITY_FIELDS.includes(key)) throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`);
	if (identity.contractVersion !== TASK_CONTRACT_VERSION) throw new Error(`task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`);
	const names = [
		["store id", identity.storeId],
		["root session id", identity.rootSessionId],
		["request key", identity.requestKey]
	];
	for (const [name, value] of names) if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`);
	if (!isDigest(identity.contractDigest)) throw new Error(`task: proposal "${id}" identity contract digest must be a lowercase SHA-256 hex digest`);
}
/** The batch content a submission carries, bound to the identity it claims to be: one child per identity child, in the same order, each carrying the contract whose {@link contractDigest} is the identity's child digest and the three … */
function assertProposalBatch(id, batch, identity) {
	if (!Array.isArray(batch)) throw new Error(`task: proposal "${id}" batch must be an array`);
	if (batch.length !== identity.children.length) throw new Error(`task: proposal "${id}" batch requires one child per identity child (identity children: ${identity.children.length}, batch children: ${batch.length})`);
	batch.forEach((child, index) => {
		const where = `proposal "${id}" child ${index}`;
		const identityChild = identity.children[index];
		if (!isRecord(child)) throw new Error(`task: ${where} must be an object`);
		for (const key of Object.keys(child)) if (!PROPOSAL_CHILD_FIELDS.includes(key)) throw new Error(`task: ${where} has an unsupported field "${key}"`);
		const contract = child.contract;
		if (!isRecord(contract)) throw new Error(`task: ${where} requires a contract`);
		assertContractFields(where, contract);
		if (!Array.isArray(child.dependsOn) || child.dependsOn.some((item) => !Number.isInteger(item) || item < 0)) throw new Error(`task: ${where} dependsOn must be an array of non-negative integers`);
		if (typeof child.decomposable !== "boolean") throw new Error(`task: ${where} decomposable must be a boolean`);
		if (typeof child.requiresIndependentAcceptance !== "boolean") throw new Error(`task: ${where} requiresIndependentAcceptance must be a boolean`);
		const digest = contractDigest(contract);
		if (digest !== identityChild.contractDigest) throw new Error(`task: ${where} contract digest "${digest}" does not match its identity digest "${identityChild.contractDigest}"`);
		if (!(child.dependsOn.length === identityChild.dependsOn.length && child.dependsOn.every((value, position) => value === identityChild.dependsOn[position]))) throw new Error(`task: ${where} dependsOn does not match its identity`);
		if (child.decomposable !== identityChild.decomposable) throw new Error(`task: ${where} decomposable does not match its identity`);
		if (child.requiresIndependentAcceptance !== identityChild.requiresIndependentAcceptance) throw new Error(`task: ${where} requiresIndependentAcceptance does not match its identity`);
	});
}
/** A decision binds the proposal it was made against, so every identity it carries is compared with the stored record: the dossier digest, the admission context, and — for an approval, always — the review context the batch resolved against … */
function assertDecisionBinding(proposal, claim) {
	if (claim.proposalDigest !== proposal.proposalDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision digest "${String(claim.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`);
	if (claim.admissionContextDigest !== proposal.admissionContextDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision admission context digest "${String(claim.admissionContextDigest)}" does not match the stored admission context digest "${proposal.admissionContextDigest}"`);
	if (claim.outcome === "approved" && claim.reviewContextDigest === void 0) throw new Error(`task: proposal "${proposal.proposalId}" approval requires the review context digest it was decided against`);
	if (claim.reviewContextDigest !== void 0 && claim.reviewContextDigest !== proposal.reviewContextDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision review context digest "${claim.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`);
}
/** A consumption binds a proposal to what it became, so it has to name the same dossier and the resolution the admission re-check confirmed — for both kinds — and then the kind's own shape: a batch names the parent run of its identity, the … */
function assertConsumptionBinding(snapshot, proposal, consumption) {
	const id = proposal.proposalId;
	if (consumption.proposalDigest !== proposal.proposalDigest) throw new Error(`task: proposal "${id}" consumption digest "${String(consumption.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`);
	if (!nonEmpty(consumption.reviewContextDigest)) throw new Error(`task: proposal "${id}" consumption requires a review context digest`);
	if (consumption.reviewContextDigest !== proposal.reviewContextDigest) throw new Error(`task: proposal "${id}" consumption review context digest "${consumption.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`);
	if (proposal.kind === "root") assertRootConsumptionShape(snapshot, proposal, consumption);
	else assertBatchConsumptionShape(snapshot, proposal, consumption);
	if (!nonEmpty(consumption.admittedAt)) throw new Error(`task: proposal "${id}" consumption requires an admission time`);
	if (consumption.reason !== void 0 && !nonEmpty(consumption.reason)) throw new Error(`task: proposal "${id}" consumption reason must be a non-empty string when present`);
}
/** The batch half of a consumption: the batch this run admitted, and children the store really holds under the proposal's parent — the record a crash recovery reads to find the batch it already admitted instead of admitting a second one. */
function assertBatchConsumptionShape(snapshot, proposal, consumption) {
	const id = proposal.proposalId;
	if (consumption.kind === "root") throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot be consumed as a root contract`);
	if (consumption.kind !== void 0 && consumption.kind !== "batch") throw new Error(`task: proposal "${id}" consumption kind must be "batch"`);
	const raw = consumption;
	for (const field of ROOT_CONSUMPTION_FIELDS) if (raw[field] !== void 0) throw new Error(`task: proposal "${id}" consumption carries the root field "${field}"; a batch consumption names batchId and childTaskIds`);
	const batch = consumption;
	if (!nonEmpty(batch.parentRunId)) throw new Error(`task: proposal "${id}" consumption requires the parent run its batch belongs to; a consumption from before batches were identified by run and proposal is refused, not guessed at`);
	if (batch.parentRunId !== proposal.identity.parentRunId) throw new Error(`task: proposal "${id}" consumption names parent run "${batch.parentRunId}", not the run "${proposal.identity.parentRunId}" its identity names`);
	if (!nonEmpty(batch.batchId)) throw new Error(`task: proposal "${id}" consumption requires a batch id`);
	const batchId = batchIdFor(proposal.identity.parentRunId, id);
	if (batch.batchId !== batchId) throw new Error(`task: proposal "${id}" consumption batch "${batch.batchId}" is not the batch of run "${proposal.identity.parentRunId}" and proposal "${id}" ("${batchId}")`);
	if (!Array.isArray(batch.childTaskIds) || batch.childTaskIds.length === 0) throw new Error(`task: proposal "${id}" consumption requires at least one child task id`);
	for (const childTaskId of batch.childTaskIds) if (!nonEmpty(childTaskId)) throw new Error(`task: proposal "${id}" consumption child task ids must be non-empty strings`);
	const seen = /* @__PURE__ */ new Set();
	for (const childTaskId of batch.childTaskIds) {
		if (seen.has(childTaskId)) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}" twice`);
		seen.add(childTaskId);
	}
	for (const childTaskId of batch.childTaskIds) {
		const child = snapshot.tasks.find((item) => item.taskId === childTaskId);
		if (child === void 0) throw new Error(`task: proposal "${id}" consumption names unknown task "${childTaskId}"`);
		if (child.parentTaskId !== proposal.identity.parentTaskId) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}", which is not a child of "${proposal.identity.parentTaskId}"`);
	}
}
/** The root half of a consumption: the root task and the root run the activation minted, and the store's one-root rule. */
function assertRootConsumptionShape(snapshot, proposal, consumption) {
	const id = proposal.proposalId;
	if (consumption.kind !== "root") throw new Error(`task: proposal "${id}" consumption must declare kind "root"`);
	const raw = consumption;
	for (const field of BATCH_CONSUMPTION_FIELDS) if (raw[field] !== void 0) throw new Error(`task: proposal "${id}" consumption carries the batch field "${field}"; a root consumption names rootTaskId and rootRunId`);
	const root = consumption;
	if (!nonEmpty(root.rootTaskId)) throw new Error(`task: proposal "${id}" consumption requires a root task id`);
	if (!nonEmpty(root.rootRunId)) throw new Error(`task: proposal "${id}" consumption requires a root run id`);
	const task = snapshot.tasks.find((item) => item.taskId === root.rootTaskId);
	if (task === void 0) throw new Error(`task: proposal "${id}" consumption names unknown task "${root.rootTaskId}"`);
	if (task.parentTaskId !== void 0) throw new Error(`task: proposal "${id}" consumption names task "${root.rootTaskId}", which is not a root task`);
	const rival = snapshot.tasks.find((item) => item.parentTaskId === void 0 && item.taskId !== root.rootTaskId);
	if (rival !== void 0) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" but store "${snapshot.id}" already holds root task "${rival.taskId}"`);
	const contract = task.contract;
	if (contract === void 0) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" without the contract the proposal committed to`);
	const digest = contractDigest(contract);
	if (digest !== proposal.identity.contractDigest) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" whose contract digest "${digest}" is not the committed "${proposal.identity.contractDigest}"`);
	const run = snapshot.runs.find((item) => item.runId === root.rootRunId);
	if (run === void 0) throw new Error(`task: proposal "${id}" consumption names unknown run "${root.rootRunId}"`);
	if (run.taskId !== root.rootTaskId) throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}", which belongs to task "${run.taskId}"`);
	if (run.sessionId !== proposal.identity.rootSessionId) throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" of session "${run.sessionId}", not the root session "${proposal.identity.rootSessionId}"`);
	if (run.status !== "running") throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" in status "${run.status}"; a root run is consumed running`);
	if (run.executionPhase !== "active") throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" with execution phase "${String(run.executionPhase)}"; a root run is born active`);
}
/** The review context's closed shape. Its manifest fingerprint and every verifier id/version/configuration are checked for the shapes that make them comparable — a digest that is not a digest, or a verifier without an id, would leave … */
function assertReviewContext(id, context) {
	if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires a review context`);
	for (const key of Object.keys(context)) if (!REVIEW_CONTEXT_FIELDS.includes(key)) throw new Error(`task: proposal "${id}" review context has an unsupported field "${key}"`);
	if (!isDigest(context.capabilityManifestDigest)) throw new Error(`task: proposal "${id}" review context capability manifest digest must be a lowercase SHA-256 hex digest`);
	if (!Array.isArray(context.verifiers)) throw new Error(`task: proposal "${id}" review context verifiers must be an array`);
	for (const verifier of context.verifiers) {
		if (!isRecord(verifier)) throw new Error(`task: proposal "${id}" review context verifiers must be objects`);
		for (const key of Object.keys(verifier)) if (!VERIFIER_IDENTITY_FIELDS.includes(key)) throw new Error(`task: proposal "${id}" review context verifier has an unsupported field "${key}"`);
		if (!nonEmpty(verifier.verifierId)) throw new Error(`task: proposal "${id}" review context verifier requires a verifier id`);
		if (verifier.version !== void 0 && !nonEmpty(verifier.version)) throw new Error(`task: proposal "${id}" review context verifier "${verifier.verifierId}" version must be a non-empty string when present`);
		if (verifier.configurationDigest !== void 0 && !isDigest(verifier.configurationDigest)) throw new Error(`task: proposal "${id}" review context verifier "${verifier.verifierId}" configuration digest must be a lowercase SHA-256 hex digest when present`);
	}
}

//#endregion
//#region src/service/proposals.ts
/** The statuses each decision may be taken from: a policy-off batch has no review to decide; a withdrawal may land on a ready or approved one. */
const DECISION_SOURCES = {
	approved: ["pending_review"],
	rejected: ["pending_review"],
	cancelled: [
		"ready",
		"pending_review",
		"approved"
	],
	expired: [
		"ready",
		"pending_review",
		"approved"
	]
};
/** The statuses each runtime phase change may come from; `ready` only from `approved` (that edge is the post-approval re-check). */
const PHASE_SOURCES = {
	ready: ["approved"],
	pending_review: ["ready"],
	stale: ["ready", "approved"]
};
/** The only status a consumption may come from: the re-check has to have passed and be on the record. */
const ADMISSION_SOURCES = ["ready"];
/** A proposal enters the store (T2/T3, §6; root contracts A0 §2). The reducer is the shape gate and the integrity gate, in that order: the record must be a well-formed proposal of its kind — the closed field set of its review context, a birth … */
function submitProposal(snapshot, taskId, proposal) {
	assertProposal(snapshot, proposal);
	assertProposalTask(proposal, taskId);
	const index = proposalIndex(snapshot);
	if (index.byId[proposal.proposalId] !== void 0) throw new Error(`task: proposal "${proposal.proposalId}" already exists`);
	const bound = index.byRequestKey[proposal.requestKey];
	if (bound !== void 0) throw new Error(`task: proposal request key "${proposal.requestKey}" is already bound to proposal "${bound.proposalId}"`);
	if (proposal.kind === "root") assertRootIntakeOpen(snapshot, proposal.proposalId);
	const stored = copy(proposal);
	if (stored.kind === "root") {
		snapshot = {
			...snapshot,
			proposals: {
				all: [...index.all, stored],
				byId: {
					...index.byId,
					[stored.proposalId]: stored
				},
				byRequestKey: {
					...index.byRequestKey,
					[stored.requestKey]: stored
				},
				byParentTask: index.byParentTask
			}
		};
		return snapshot;
	}
	const parentTaskId = stored.identity.parentTaskId;
	snapshot = {
		...snapshot,
		proposals: {
			all: [...index.all, stored],
			byId: {
				...index.byId,
				[stored.proposalId]: stored
			},
			byRequestKey: {
				...index.byRequestKey,
				[stored.requestKey]: stored
			},
			byParentTask: {
				...index.byParentTask,
				[parentTaskId]: [...index.byParentTask[parentTaskId] ?? [], stored]
			}
		}
	};
	return snapshot;
}
/** One review decision (T2/T3, §6): the outcome, bound to the dossier digest and both context fingerprints, checked against the stored proposal before anything is applied. */
function decideProposal(snapshot, taskId, claim, timestamp) {
	if (!isRecord(claim)) throw new Error("task: proposal decision must be an object");
	const proposal = proposalIn(snapshot, claim.proposalId);
	assertProposalTask(proposal, taskId);
	if (!TASK_PROPOSAL_DECISION_OUTCOMES.includes(claim.outcome)) throw new Error(`task: proposal "${proposal.proposalId}" decision outcome must be one of ${TASK_PROPOSAL_DECISION_OUTCOMES.join(", ")}`);
	assertDecisionBinding(proposal, claim);
	if (!nonEmpty(claim.decidedBy)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decider`);
	if (!nonEmpty(claim.decidedAt)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decision time`);
	if (claim.reason !== void 0 && !nonEmpty(claim.reason)) throw new Error(`task: proposal "${proposal.proposalId}" decision reason must be a non-empty string when present`);
	if (claim.outcome === "expired" && !nonEmpty(claim.reason)) throw new Error(`task: proposal "${proposal.proposalId}" expiry requires a reason`);
	assertProposalTransition(proposal, claim.outcome, DECISION_SOURCES[claim.outcome]);
	snapshot = setProposal(snapshot, proposal.proposalId, {
		status: claim.outcome,
		updatedAt: timestamp,
		decision: {
			outcome: claim.outcome,
			proposalDigest: claim.proposalDigest,
			admissionContextDigest: claim.admissionContextDigest,
			...claim.reviewContextDigest === void 0 ? {} : { reviewContextDigest: claim.reviewContextDigest },
			decidedBy: claim.decidedBy,
			decidedAt: claim.decidedAt,
			...claim.reason === void 0 ? {} : { reason: claim.reason }
		}
	});
	return snapshot;
}
/** One runtime phase change (T2/T3, §6): the two edges that are not a person's decision or a consumption — `ready → pending_review` when the deployment tightened to `all` before admission, `approved → ready` when the post-approval re-check … */
function changeProposalPhase(snapshot, taskId, change, timestamp) {
	if (!isRecord(change)) throw new Error("task: proposal phase change must be an object");
	const proposal = proposalIn(snapshot, change.proposalId);
	assertProposalTask(proposal, taskId);
	if (!TASK_PROPOSAL_PHASES.includes(change.to)) throw new Error(`task: proposal "${proposal.proposalId}" phase must be one of ${TASK_PROPOSAL_PHASES.join(", ")}`);
	if (change.to === "stale" && !nonEmpty(change.reason)) throw new Error(`task: proposal "${proposal.proposalId}" is marked stale without a reason`);
	if (change.reason !== void 0 && !nonEmpty(change.reason)) throw new Error(`task: proposal "${proposal.proposalId}" phase change reason must be a non-empty string when present`);
	assertProposalTransition(proposal, change.to, PHASE_SOURCES[change.to]);
	snapshot = setProposal(snapshot, proposal.proposalId, {
		status: change.to,
		updatedAt: timestamp
	});
	return snapshot;
}
/** A proposal is consumed (§6): what it asked for exists, and this record says what it became. */
function admitProposal(snapshot, taskId, consumption, timestamp) {
	if (!isRecord(consumption)) throw new Error("task: proposal consumption must be an object");
	const proposal = proposalIn(snapshot, consumption.proposalId);
	assertProposalTask(proposal, taskId);
	assertConsumptionBinding(snapshot, proposal, consumption);
	assertProposalTransition(proposal, "admitted", ADMISSION_SOURCES);
	snapshot = setProposal(snapshot, proposal.proposalId, {
		status: "admitted",
		updatedAt: timestamp,
		consumption: consumption.kind === "root" ? {
			kind: "root",
			proposalId: consumption.proposalId,
			proposalDigest: consumption.proposalDigest,
			reviewContextDigest: consumption.reviewContextDigest,
			rootTaskId: consumption.rootTaskId,
			rootRunId: consumption.rootRunId,
			admittedAt: consumption.admittedAt,
			...consumption.reason === void 0 ? {} : { reason: consumption.reason }
		} : {
			...consumption.kind === void 0 ? {} : { kind: consumption.kind },
			proposalId: consumption.proposalId,
			proposalDigest: consumption.proposalDigest,
			reviewContextDigest: consumption.reviewContextDigest,
			parentRunId: consumption.parentRunId,
			batchId: consumption.batchId,
			childTaskIds: [...consumption.childTaskIds],
			admittedAt: consumption.admittedAt,
			...consumption.reason === void 0 ? {} : { reason: consumption.reason }
		}
	});
	return snapshot;
}

//#endregion
//#region src/service/state.ts
const ADMITTED_OR_LATER = [
	"admitted",
	"ready",
	"running",
	"verifying",
	"verified",
	"failed"
];
const EXECUTION_PHASES = [
	"active",
	"waiting_children",
	"submitted"
];
/** The batch identity one decomposition event carries, or `undefined` for a record written before batches had one. */
function assertBatchIdentity(snapshot, taskId, payload) {
	const { batchId, parentRunId, proposalId } = payload;
	if (batchId === void 0 && parentRunId === void 0 && proposalId === void 0) return void 0;
	if (!nonEmpty(batchId) || !nonEmpty(parentRunId) || !nonEmpty(proposalId)) throw new Error(`task: task "${taskId}" decomposition batch requires a batch id, a parent run and a proposal; a batch is identified by all three or by none`);
	const run = runIn(snapshot, parentRunId);
	if (run.taskId !== taskId) throw new Error(`task: run "${parentRunId}" belongs to task "${run.taskId}", not "${taskId}"`);
	if ((run.batches ?? []).some((batch) => batch.batchId === batchId)) throw new Error(`task: run "${parentRunId}" already holds batch "${batchId}"; one batch identity names one batch`);
	const derived = batchIdFor(parentRunId, proposalId);
	if (batchId !== derived) throw new Error(`task: task "${taskId}" decomposition batch "${batchId}" is not the batch of run "${parentRunId}" and proposal "${proposalId}" ("${derived}")`);
	return {
		batchId,
		parentRunId,
		proposalId
	};
}
function addTask(snapshot, task) {
	if (typeof task.taskId !== "string" || task.taskId.length === 0) throw new Error("task: task id must be a non-empty string");
	if (typeof task.objective !== "string" || task.objective.length === 0) throw new Error(`task: task "${task.taskId}" objective must be non-empty`);
	if (snapshot.tasks.some((item) => item.taskId === task.taskId)) throw new Error(`task: task "${task.taskId}" already exists`);
	if (task.status !== "created") throw new Error(`task: task "${task.taskId}" must be created in status "created"`);
	if (task.runIds.length !== 0 || task.childTaskIds.length !== 0) throw new Error("task: task runs and children must use events");
	if (task.parentTaskId === task.taskId) throw new Error(`task: task "${task.taskId}" cannot be its own parent`);
	if (task.contract !== void 0) assertContract(task.taskId, task.contract, task);
	if (task.parentTaskId === void 0) {
		if (task.depth !== 0) throw new Error(`task: root task "${task.taskId}" depth must be 0`);
		snapshot = {
			...snapshot,
			tasks: [...snapshot.tasks, copy(task)]
		};
		return snapshot;
	}
	const parent = taskIn(snapshot, task.parentTaskId);
	if (task.depth !== parent.depth + 1) throw new Error(`task: task "${task.taskId}" depth must be parent depth + 1`);
	snapshot = {
		...snapshot,
		tasks: [...snapshot.tasks.map((item) => item.taskId === parent.taskId ? {
			...item,
			childTaskIds: [...item.childTaskIds, task.taskId]
		} : item), copy(task)]
	};
	return snapshot;
}
function admit(snapshot, taskId, decompositionStatus) {
	assertTransition(snapshot, taskId, ["created"], "admitted");
	snapshot = updateTask(snapshot, taskId, {
		status: "admitted",
		decompositionStatus
	});
	return snapshot;
}
/** A decomposition records the members one batch contributed to the parent: the children are already under it (`TaskCreated`), and this event says they were admitted together, as one batch, by one run. */
function decompose(snapshot, taskId, payload) {
	const parent = taskIn(snapshot, taskId);
	for (const childTaskId of payload.childTaskIds) if (!parent.childTaskIds.includes(childTaskId)) throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`);
	if (payload.childTaskIds.length === 0 || payload.childTaskIds.some((childTaskId) => !ADMITTED_OR_LATER.includes(taskIn(snapshot, childTaskId).status))) throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`);
	if (payload.admission !== void 0) assertAdmission(taskId, payload.admission);
	const batch = assertBatchIdentity(snapshot, taskId, payload);
	snapshot = updateTask(snapshot, taskId, { decompositionStatus: "decomposed" });
	if (batch === void 0) return snapshot;
	snapshot = {
		...snapshot,
		runs: snapshot.runs.map((item) => item.runId === batch.parentRunId ? {
			...item,
			batches: [...item.batches ?? [], {
				batchId: batch.batchId,
				proposalId: batch.proposalId,
				memberTaskIds: [...payload.childTaskIds]
			}]
		} : item)
	};
	return snapshot;
}
function addDependency(snapshot, edge) {
	taskIn(snapshot, edge.from);
	taskIn(snapshot, edge.to);
	if (edge.from === edge.to || reaches(snapshot.edges, edge.to, edge.from)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" creates a cycle`);
	if (snapshot.edges.some((item) => item.from === edge.from && item.to === edge.to)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" already exists`);
	snapshot = {
		...snapshot,
		edges: [...snapshot.edges, copy(edge)]
	};
	return snapshot;
}
function start(snapshot, taskId, envelopeRunId, run) {
	if (typeof run.runId !== "string" || run.runId.length === 0) throw new Error("task: run id must be a non-empty string");
	if (snapshot.runs.some((item) => item.runId === run.runId)) throw new Error(`task: run "${run.runId}" already exists`);
	if (run.taskId !== taskId) throw new Error(`task: run "${run.runId}" does not belong to task "${taskId}"`);
	if (envelopeRunId !== run.runId) throw new Error(`task: run "${run.runId}" envelope run id mismatch`);
	if (run.status !== "running") throw new Error(`task: run "${run.runId}" must start in status "running"`);
	if (typeof run.sessionId !== "string" || run.sessionId.length === 0) throw new Error(`task: run "${run.runId}" session id must be non-empty`);
	if (run.providerBinding !== void 0) assertProviderBinding(run.runId, run.providerBinding);
	if (run.recovery !== void 0) assertRunRecovery(snapshot, taskId, run.recovery);
	assertBirthPhase(run);
	if (run.parentRunId !== void 0) runIn(snapshot, run.parentRunId);
	const from = run.recovery?.kind === "improvement" ? [
		"admitted",
		"ready",
		"verified"
	] : ["admitted", "ready"];
	assertTransition(snapshot, taskId, from, "running");
	snapshot = {
		...snapshot,
		runs: [...snapshot.runs, copy(run)]
	};
	snapshot = updateTask(snapshot, taskId, {
		status: "running",
		runIds: [...taskIn(snapshot, taskId).runIds, run.runId]
	});
	return snapshot;
}
function block(snapshot, taskId, runId) {
	assertTransition(snapshot, taskId, [
		"admitted",
		"ready",
		"running"
	], "blocked");
	if (runId !== void 0) assertRunTransition(snapshot, runId, ["running"], "blocked");
	snapshot = updateTask(snapshot, taskId, { status: "blocked" });
	if (runId !== void 0) snapshot = setRun(snapshot, runId, "blocked");
	return snapshot;
}
function verify(snapshot, taskId, runId, finishedAt) {
	if (runId === void 0) throw new Error(`task: TaskVerified for "${taskId}" requires a run id`);
	assertTransition(snapshot, taskId, ["verifying"], "verified");
	if (!snapshot.evidence.some((item) => item.taskId === taskId && item.taskRunId === runId)) throw new Error(`task: run "${runId}" has no evidence`);
	assertRunTransition(snapshot, runId, ["running"], "verified");
	snapshot = updateTask(snapshot, taskId, { status: "verified" });
	snapshot = setRun(snapshot, runId, "verified", finishedAt);
	return snapshot;
}
function fail(snapshot, taskId, runId, finishedAt) {
	assertTransition(snapshot, taskId, ["running", "verifying"], "failed");
	if (runId !== void 0) assertRunTransition(snapshot, runId, ["running", "blocked"], "failed");
	snapshot = updateTask(snapshot, taskId, { status: "failed" });
	if (runId !== void 0) snapshot = setRun(snapshot, runId, "failed", finishedAt);
	return snapshot;
}
/** A run keeps `running` through verification (the coordination phase, not the status, is what records the submission), so a cancellation that lands while a verifier call is in flight arrives at a task that is already `verifying`. */
function cancel(snapshot, taskId, runId, finishedAt) {
	assertTransition(snapshot, taskId, ["running", "verifying"], "cancelled");
	if (runId !== void 0) assertRunTransition(snapshot, runId, ["running", "blocked"], "cancelled");
	snapshot = updateTask(snapshot, taskId, { status: "cancelled" });
	if (runId !== void 0) snapshot = setRun(snapshot, runId, "cancelled", finishedAt);
	return snapshot;
}
/** The coordination phase is the A3 admission gate, so this handler is where a transition is either one of the four legal edges or a refusal: a run accepts `active → waiting_children`, `waiting_children → active`, `active → submitted` and … */
function changeRunPhase(snapshot, taskId, runId, payload) {
	if (runId === void 0) throw new Error(`task: RunPhaseChanged for task "${taskId}" requires a run id`);
	const run = runIn(snapshot, runId);
	if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`);
	if (run.status !== "running") throw new Error(`task: run "${runId}" is ${run.status}; a phase change requires a running run`);
	const to = payload.phase;
	if (!EXECUTION_PHASES.includes(to)) throw new Error(`task: run "${runId}" execution phase must be one of ${EXECUTION_PHASES.join(", ")}`);
	const from = run.executionPhase;
	if (from === void 0) throw new Error(`task: run "${runId}" has no execution phase; only an active run changes phase`);
	if (!(from === "active" && (to === "waiting_children" || to === "submitted") || from === "waiting_children" && (to === "active" || to === "submitted"))) throw new Error(`task: illegal run phase transition "${from}" → "${to}" for run "${runId}"`);
	if (to === "waiting_children" || to === "active") {
		if (!nonEmpty(payload.batchId)) throw new Error(to === "waiting_children" ? `task: run "${runId}" entering waiting_children requires a batch id` : `task: run "${runId}" returning to active requires the batch id it closes`);
		if (payload.submission !== void 0) throw new Error(`task: run "${runId}" is entering ${to}; only the submitted phase carries a submission`);
	} else {
		if (payload.submission === void 0) throw new Error(`task: run "${runId}" submitting requires a submission record`);
		assertSubmissionShape(runId, payload.submission);
		if (payload.batchId !== void 0) throw new Error(`task: run "${runId}" is submitting; a batch id belongs to the batch edges, not the submitted phase`);
	}
	assertQuestionIds(runId, payload);
	snapshot = {
		...snapshot,
		runs: snapshot.runs.map((item) => {
			if (item.runId !== runId) return item;
			const next = {
				...item,
				executionPhase: to,
				...payload.batchId === void 0 ? {} : { batchId: payload.batchId },
				...payload.submission === void 0 ? {} : { submission: copy(payload.submission) },
				...payload.pendingQuestionIds === void 0 ? {} : { pendingQuestionIds: [...payload.pendingQuestionIds] },
				...payload.blockingQuestionIds === void 0 ? {} : { blockingQuestionIds: [...payload.blockingQuestionIds] }
			};
			if (to === "active") delete next.batchId;
			return next;
		})
	};
	return snapshot;
}
/** A no-progress marking is the A3 signal a reader shows before the budget stops a stuck run, and it is meaningful only on the phase that can still submit: `active`. */
function markRunProgress(snapshot, taskId, runId, payload, timestamp) {
	if (runId === void 0) throw new Error(`task: RunProgressMarked for task "${taskId}" requires a run id`);
	const run = runIn(snapshot, runId);
	if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`);
	if (run.status !== "running") throw new Error(`task: run "${runId}" is ${run.status}; progress can only be marked while the run is running`);
	const phase = run.executionPhase;
	if (phase !== "active") throw new Error(`task: run "${runId}" execution phase is ${phase === void 0 ? "absent" : `"${phase}"`}; progress is only marked on an active run`);
	if (payload.kind !== "unsubmitted-idle") throw new Error(`task: run "${runId}" progress kind must be "unsubmitted-idle"`);
	if (!Number.isInteger(payload.rounds) || payload.rounds < 1) throw new Error(`task: run "${runId}" progress rounds must be a positive integer`);
	if (!Number.isInteger(payload.factCount) || payload.factCount < 0) throw new Error(`task: run "${runId}" progress fact count must be a non-negative integer`);
	if (!nonEmpty(payload.note)) throw new Error(`task: run "${runId}" progress requires a note`);
	snapshot = {
		...snapshot,
		runs: snapshot.runs.map((item) => item.runId === runId ? {
			...item,
			noProgress: {
				kind: payload.kind,
				rounds: payload.rounds,
				factCount: payload.factCount,
				markedAt: timestamp
			}
		} : item)
	};
	return snapshot;
}
/** A person raised one of the tree's own ceilings (K4). The reducer is the shape gate, the identity gate and — the part that matters — the *chain* gate, in that order, and it applies nothing at all when any of them refuses. */
function transit(snapshot, taskId, from, to) {
	assertTransition(snapshot, taskId, from, to);
	snapshot = updateTask(snapshot, taskId, { status: to });
	return snapshot;
}
function assertTransition(snapshot, taskId, from, to) {
	const current = taskIn(snapshot, taskId);
	if (!from.includes(current.status)) throw new Error(`task: illegal transition "${current.status}" → "${to}" for task "${taskId}"`);
}
function assertRunTransition(snapshot, runId, from, to) {
	const current = runIn(snapshot, runId);
	if (!from.includes(current.status)) throw new Error(`task: illegal run transition "${current.status}" → "${to}" for run "${runId}"`);
}
function setRun(snapshot, runId, status, finishedAt) {
	snapshot = {
		...snapshot,
		runs: snapshot.runs.map((item) => item.runId === runId ? {
			...item,
			status,
			...finishedAt !== void 0 ? { finishedAt } : {}
		} : item)
	};
	return snapshot;
}
function updateTask(snapshot, taskId, patch) {
	snapshot = {
		...snapshot,
		tasks: snapshot.tasks.map((item) => item.taskId === taskId ? {
			...item,
			...patch
		} : item)
	};
	return snapshot;
}
/** Applies one approved budget extension to the index: an idempotent repeat is answered from the record and writes nothing. */
function extendBudget(snapshot, taskId, sessionId, claim, timestamp) {
	const extension = buildBudgetExtension(snapshot, taskId, sessionId, claim, timestamp);
	if (extension === void 0) return snapshot;
	const index = budgetExtensionIndex(snapshot);
	return {
		...snapshot,
		budgetExtensions: {
			all: [...index.all, extension],
			byRequestKey: {
				...index.byRequestKey,
				[extension.requestKey]: extension
			}
		}
	};
}
var TaskState = class TaskState {
	value;
	constructor(id, snapshot) {
		this.value = snapshot === void 0 ? emptySnapshot(id) : copy(snapshot);
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
				this.value = addTask(this.value, event$1.payload.task);
				return;
			case "TaskAdmitted":
				this.value = admit(this.value, event$1.taskId, event$1.payload.decompositionStatus);
				return;
			case "TaskRejected":
				this.value = transit(this.value, event$1.taskId, ["created"], "blocked");
				return;
			case "TaskDecomposed":
				this.value = decompose(this.value, event$1.taskId, event$1.payload);
				return;
			case "DependencyAdded":
				this.value = addDependency(this.value, event$1.payload.edge);
				return;
			case "TaskStarted":
				this.value = start(this.value, event$1.taskId, event$1.runId, event$1.payload.run);
				return;
			case "TaskBlocked":
				this.value = block(this.value, event$1.taskId, event$1.runId);
				return;
			case "TaskVerifying":
				this.value = transit(this.value, event$1.taskId, ["running"], "verifying");
				return;
			case "TaskVerified":
				this.value = verify(this.value, event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskFailed":
				this.value = fail(this.value, event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskCancelled":
				this.value = cancel(this.value, event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskRetried":
				this.value = transit(this.value, event$1.taskId, ["failed"], "ready");
				return;
			case "RunPhaseChanged":
				this.value = changeRunPhase(this.value, event$1.taskId, event$1.runId, event$1.payload);
				return;
			case "RunProgressMarked":
				this.value = markRunProgress(this.value, event$1.taskId, event$1.runId, event$1.payload, event$1.timestamp);
				return;
			case "QuestionAsked":
				this.value = askQuestion(this.value, event$1.taskId, event$1.runId, event$1.parentTaskId, event$1.payload.question);
				return;
			case "QuestionAnswered":
				this.value = answerQuestion(this.value, event$1.taskId, event$1.runId, event$1.parentTaskId, event$1.payload.answer);
				return;
			case "CapabilityResolved":
				this.value = resolveCapabilities(this.value, event$1.taskId, event$1.payload.manifest);
				return;
			case "CapabilityGapDetected":
				taskIn(this.value, event$1.taskId);
				return;
			case "EvidenceProduced":
				this.value = produceEvidence(this.value, event$1.taskId, event$1.runId, event$1.payload.evidence);
				return;
			case "HandoffCreated":
				this.value = addHandoff(this.value, event$1.payload.handoff);
				return;
			case "ReviewRecorded":
				this.value = recordReview(this.value, event$1.taskId, event$1.runId, event$1.payload.review);
				return;
			case "DiagnosisRecorded":
				this.value = recordDiagnosis(this.value, event$1.taskId, event$1.payload.diagnosis);
				return;
			case "ObligationRecorded":
				this.value = recordObligation(this.value, event$1.payload.obligation);
				return;
			case "TaskBudgetExtended":
				this.value = extendBudget(this.value, event$1.taskId, event$1.sessionId, event$1.payload.extension, event$1.timestamp);
				return;
			case "TaskProposalSubmitted":
				this.value = submitProposal(this.value, event$1.taskId, event$1.payload.proposal);
				return;
			case "TaskProposalDecided":
				this.value = decideProposal(this.value, event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			case "TaskProposalPhaseChanged":
				this.value = changeProposalPhase(this.value, event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			case "TaskProposalAdmitted":
				this.value = admitProposal(this.value, event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			default: throw new Error(`task: unknown event kind "${event$1.kind}"`);
		}
	}
};
function emptySnapshot(id) {
	return {
		version: 1,
		id,
		tasks: [],
		runs: [],
		edges: [],
		evidence: [],
		handoffs: [],
		reviews: [],
		diagnoses: [],
		obligations: [],
		capabilities: {},
		proposals: {
			all: [],
			byId: {},
			byRequestKey: {},
			byParentTask: {}
		},
		questions: {
			all: [],
			byId: {}
		},
		budgetExtensions: {
			all: [],
			byRequestKey: {}
		}
	};
}

//#endregion
//#region src/service/store.ts
/** Drop `undefined`-valued keys so an event can enter the session log, which accepts only lossless JSON and rejects `undefined` outright. */
function compact(value) {
	if (Array.isArray(value)) return value.map((item) => compact(item));
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const source = value;
	const target = {};
	for (const key of definedKeys(source)) target[key] = compact(source[key]);
	return target;
}
/** The `sessionPersistence`-backed stores one service owns: allocation, replay, serial writes and disposal. */
var EventStoreSet = class {
	stores = /* @__PURE__ */ new Map();
	closing = false;
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}
	/** Whether disposal has started; every entry refuses new work from then on. */
	get closed() {
		return this.closing;
	}
	/** The store behind `id`, which a caller must already have opened. */
	require(id) {
		this.guard(id);
		return this.lookup(id);
	}
	/** The store behind `id` (or the configured default id), opened or created on first access. */
	load(id) {
		const target = id ?? this.defaultId();
		this.guard(target);
		const existing = this.stores.get(target);
		if (existing !== void 0) return existing;
		const store = this.allocate(target);
		store.ready = this.beginOpen(store, "auto");
		this.track(store);
		return store;
	}
	/** Opens (or creates) the store behind `id` and answers its first snapshot; `create`/`open` are the explicit doors. */
	async open(id, mode = "auto") {
		this.guard(id);
		const existing = this.stores.get(id);
		if (existing !== void 0) {
			if (mode === "create") throw new Error(`${this.config.namespace}: store "${id}" is already open`);
			await existing.ready;
			return existing.state.snapshot();
		}
		const store = this.allocate(id);
		store.ready = this.beginOpen(store, mode);
		this.track(store);
		try {
			await store.ready;
		} catch (error) {
			if (this.config.onDemand !== true) this.stores.delete(id);
			throw error;
		}
		return store.state.snapshot();
	}
	/** The store's current snapshot, waiting for its open but not for queued writes. */
	async snapshot(id) {
		const store = this.resolve(id);
		await store.ready;
		return store.state.snapshot();
	}
	/** The snapshot every accepted write so far has left: open, then the shared write queue, then a detached read. */
	async settledSnapshot(id) {
		const store = this.resolve(id);
		await store.ready;
		await store.writes;
		return store.state.snapshot();
	}
	/** One batch, applied to a clone inside the store's write queue and appended only if the reducer accepted it. */
	async commit(id, events) {
		if (events.length === 0) throw new Error(`${this.config.namespace}: cannot commit an empty event batch`);
		await this.serial(id, async (state) => {
			await this.append(id, state, events);
		});
	}
	/** Runs `work` inside the store's single write queue and answers what it returned. */
	async serial(id, work) {
		const store = this.resolve(id);
		const run = store.writes.then(async () => {
			await store.ready;
			return await work(store.state);
		});
		store.writes = run.then(() => void 0, () => void 0);
		return await run;
	}
	/** The append half of a commit, for work already inside the write queue: apply the batch, append, swap, broadcast. */
	async append(id, state, events) {
		const store = this.lookup(id);
		const next = state.clone();
		for (const event$1 of events) next.apply(event$1);
		const records = events.map((event$1, index) => this.record(store.nextSeq + index, event$1));
		await store.handle.append(records);
		store.state = next;
		store.nextSeq += records.length;
		this.broadcast(store);
	}
	/** Drains readiness and queued writes of every store, closes each handle, then reports the first failure. */
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
	/** The guard every entry shares: disposal refuses all work, and a store id must be a plain file-name token. */
	guard(id) {
		if (this.closing) throw new Error(`${this.config.namespace}: service is closing`);
		if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${this.config.namespace}: invalid store id "${id}"`);
	}
	defaultId() {
		const id = this.config.defaultStoreId;
		if (id === void 0) throw new Error(`${this.config.namespace}: a store id is required when no default store id is set`);
		return id;
	}
	resolve(id) {
		return this.config.onDemand === true ? this.load(id) : this.require(id);
	}
	lookup(id) {
		const store = this.stores.get(id);
		if (store === void 0) throw new Error(`${this.config.namespace}: store "${id}" is not open`);
		return store;
	}
	allocate(id) {
		const store = {
			id,
			sessionId: SessionId(id),
			state: this.config.createState(id),
			nextSeq: 0,
			ready: Promise.resolve(),
			writes: Promise.resolve()
		};
		this.stores.set(id, store);
		return store;
	}
	/** A default store opens before any caller exists: its refusal must stay observable to that caller, never reach the process. */
	track(store) {
		store.ready.then(void 0, () => {});
	}
	async beginOpen(store, mode) {
		try {
			const listed = (await this.ctx.sessionPersistence.list()).filter((item) => item.header.id === store.sessionId);
			if (mode === "create" && listed.length > 0) throw new Error(`${this.config.namespace}: store "${store.id}" already exists`);
			if (mode === "open" && listed.length === 0) throw new Error(`${this.config.namespace}: store "${store.id}" does not exist`);
			if (listed.length > 1) throw new Error(`${this.config.namespace}: duplicate store session "${store.id}"`);
			store.handle = listed.length === 0 ? await this.ctx.sessionPersistence.create(this.header(store.sessionId)) : await this.ctx.sessionPersistence.open(store.sessionId, "write");
			const { events } = await store.handle.read();
			const migratedType = `plugin:${this.config.eventType}`;
			for (const event$1 of events) {
				if (event$1.type !== this.config.eventType && event$1.type !== migratedType || event$1.ignorable !== true) throw new Error(`${this.config.namespace}: invalid persisted event at seq ${event$1.seq}`);
				const next = store.state.clone();
				next.apply(event$1.data);
				store.state = next;
				store.nextSeq = event$1.seq + 1;
			}
			await store.handle.flush();
		} catch (error) {
			await store.handle?.close();
			throw error;
		}
	}
	record(seq, event$1) {
		return {
			type: this.config.eventType,
			seq: SessionSeq(seq),
			time: Date.now(),
			data: compact(event$1),
			ignorable: true
		};
	}
	broadcast(store) {
		const emit = this.ctx.emit;
		emit(this.config.changeEvent, store.state.snapshot());
	}
	header(id) {
		return {
			version: SESSION_FORMAT_VERSION,
			id,
			createdAt: Date.now(),
			isSeeded: false
		};
	}
};

//#endregion
//#region src/index.ts
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
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
/** The capability records one admission writes for a task: the resolved manifest, plus a gap event when something is missing. */
function capabilityEvents(taskId, actor, manifest) {
	const events = [event("CapabilityResolved", {
		taskId,
		actor,
		payload: { manifest }
	})];
	if (manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
		taskId,
		actor,
		payload: { missing: manifest.missing }
	}));
	return events;
}
var TaskService = class extends Service {
	static inject = ["sessionPersistence"];
	stores;
	constructor(ctx) {
		super(ctx, "task");
		this.stores = new EventStoreSet(ctx, {
			namespace: "task",
			eventType: "task/event",
			changeEvent: "task/change",
			createState: (storeId) => new TaskState(storeId)
		});
		ctx.effect(() => () => this.stores.close(), "task:persistence");
	}
	async createStore(storeId) {
		return await this.stores.open(storeId, "create");
	}
	async openStore(storeId) {
		return await this.stores.open(storeId, "open");
	}
	async snapshotIn(storeId) {
		return await this.stores.snapshot(storeId);
	}
	async taskIn(storeId, taskId) {
		return taskIn(await this.snapshotIn(storeId), taskId);
	}
	async runIn(storeId, runId) {
		return runIn(await this.snapshotIn(storeId), runId);
	}
	/** The tasks one run has admitted altogether, in the order their batches were admitted ({@link runMemberTaskIds} of the run's own projection) — the run's accumulative membership, which is the sequence a parent criterion's `childIndex` names. */
	async runMembersIn(storeId, runId) {
		const snapshot = await this.snapshotIn(storeId);
		return runMemberTaskIds(runIn(snapshot, runId)).map((memberTaskId) => taskIn(snapshot, memberTaskId));
	}
	/** The tasks one run reads **by position** — the sequence a parent criterion's `childIndex` indexes, with a not-yet-filled slot left `undefined` ({@link runMemberSlots}). */
	async runMemberSlotsIn(storeId, runId) {
		const snapshot = await this.snapshotIn(storeId);
		return runMemberSlots(runIn(snapshot, runId)).map((taskId) => taskId === void 0 ? void 0 : taskIn(snapshot, taskId));
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
		if (options.manifest !== void 0) events.push(...capabilityEvents(taskId, actor, options.manifest));
		events.push(event("TaskAdmitted", {
			taskId,
			actor,
			payload: { decompositionStatus: options.decompositionStatus ?? "leaf" }
		}));
		await this.commitIn(storeId, events);
	}
	async rejectTaskIn(storeId, taskId, actor, reason, manifest) {
		const events = [];
		if (manifest !== void 0) events.push(...capabilityEvents(taskId, actor, manifest));
		events.push(event("TaskRejected", {
			taskId,
			actor,
			payload: { reason }
		}));
		await this.commitIn(storeId, events);
	}
	/** The atomic batch-admission entry (A3 §1.3): every child's creation and admission, the dependency edges, the parent's decomposition record with the batch identity, the per-child capability manifests and the parent run's `active → … */
	async admitBatchIn(storeId, parentTaskId, parentRunId, children, actor, edges = [], admission, manifests, proposal) {
		if (children.length === 0) throw new Error("task: admit batch requires at least one child");
		if (manifests !== void 0 && manifests.length !== children.length) throw new Error(`task: admit batch requires one manifest per child (${children.length} children, ${manifests.length} manifests)`);
		if (proposal === void 0) throw new Error("task: admit batch requires the proposal consumption the batch is; its id is derived from the parent run and the proposal");
		if (proposal.kind === "root") throw new Error(`task: admit batch cannot record the root consumption of proposal "${proposal.proposalId}"; a root contract is activated with admitRootProposalIn`);
		if (proposal.parentRunId !== parentRunId) throw new Error(`task: admit batch requires the consumption of proposal "${proposal.proposalId}" to name the parent run it is admitted on (the consumption names "${proposal.parentRunId}", the call admits "${parentRunId}")`);
		if (proposal.childTaskIds.length !== children.length || !proposal.childTaskIds.every((childTaskId, index) => childTaskId === children[index]?.taskId)) throw new Error(`task: admit batch requires the proposal consumption to name its children in batch order (${children.length} children, ${proposal.childTaskIds.length} consumed)`);
		const batchId = batchIdFor(parentRunId, proposal.proposalId);
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
			payload: {
				childTaskIds: children.map((child) => child.taskId),
				...admission === void 0 ? {} : { admission },
				batchId,
				parentRunId,
				proposalId: proposal.proposalId
			}
		}));
		if (manifests !== void 0) children.forEach((child, index) => {
			events.push(...capabilityEvents(child.taskId, actor, manifests[index]));
		});
		events.push(event("RunPhaseChanged", {
			taskId: parentTaskId,
			runId: parentRunId,
			actor,
			payload: {
				phase: "waiting_children",
				batchId
			}
		}));
		events.push(event("TaskProposalAdmitted", {
			taskId: parentTaskId,
			actor,
			payload: proposal
		}));
		await this.commitIn(storeId, events);
	}
	/** The root activation commit (A0 §1.4, §2): the root task, its run and the proposal that asked for them land in **one** commit — a contract is either active with its task, its run and its consumption on record, or the store is untouched. */
	async admitRootProposalIn(storeId, task, run, actor, options) {
		const snapshot = await this.stores.settledSnapshot(storeId);
		const consumption = options.consumption;
		const proposal = snapshot.proposals?.byId[consumption.proposalId];
		if (proposal === void 0) throw new Error(`task: unknown proposal "${consumption.proposalId}"`);
		if (proposal.kind !== "root") throw new Error(`task: proposal "${consumption.proposalId}" is a decomposition proposal; its children are admitted with admitBatchIn`);
		const existing = snapshot.tasks.find((item) => item.parentTaskId === void 0);
		if (existing !== void 0) throw new Error(`task: store "${storeId}" already holds root task "${existing.taskId}"; proposal "${consumption.proposalId}" is refused`);
		if (consumption.rootTaskId !== task.taskId || consumption.rootRunId !== run.runId) throw new Error(`task: admit root proposal requires the consumption to name the root task and run it creates (the consumption names "${consumption.rootTaskId}"/"${consumption.rootRunId}", the call admits "${task.taskId}"/"${run.runId}")`);
		if (task.decompositionStatus !== "leaf" && task.decompositionStatus !== "decomposable") throw new Error(`task: root task "${task.taskId}" decomposition status must be "leaf" or "decomposable"`);
		const events = [event("TaskCreated", {
			taskId: task.taskId,
			parentTaskId: task.parentTaskId,
			actor,
			payload: { task }
		}), event("TaskAdmitted", {
			taskId: task.taskId,
			actor,
			payload: { decompositionStatus: task.decompositionStatus }
		})];
		if (options.manifest !== void 0) events.push(...capabilityEvents(task.taskId, actor, options.manifest));
		events.push(event("TaskStarted", {
			taskId: task.taskId,
			runId: run.runId,
			sessionId: run.sessionId,
			actor,
			payload: { run }
		}));
		for (const obligation of options.obligations ?? []) events.push(event("ObligationRecorded", {
			taskId: task.taskId,
			actor,
			payload: { obligation }
		}));
		events.push(event("TaskProposalAdmitted", {
			taskId: ROOT_PROPOSAL_TASK_ID,
			actor,
			payload: consumption
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
	/** One run starts on a task that may run — a first run, or a new attempt at a task that failed (`TaskRetried`, then `TaskStarted`, in one commit). */
	async startRunIn(storeId, run, actor, options = {}) {
		const task = (await this.stores.settledSnapshot(storeId)).tasks.find((item) => item.taskId === run.taskId);
		const events = [];
		if (task?.status === "failed") events.push(event("TaskRetried", {
			taskId: run.taskId,
			actor,
			payload: {}
		}));
		if (options.manifest !== void 0) events.push(...capabilityEvents(run.taskId, actor, options.manifest));
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
			default:
		}
	}
	/** Records one coordination-phase change on a run (A3). The reducer is the gate: only `active → waiting_children` and `waiting_children → active` (both carrying the batch id they open or close) and `active|waiting_children → submitted` … */
	async changeRunPhaseIn(storeId, taskId, runId, actor, payload) {
		if (payload.pendingQuestionIds !== void 0 || payload.blockingQuestionIds !== void 0) throw new Error("task: RunPhaseChanged no longer carries pendingQuestionIds/blockingQuestionIds; question blocking is derived from the question facts, and the A3 fields stay readable on records already written");
		await this.commitIn(storeId, [event("RunPhaseChanged", {
			taskId,
			runId,
			actor,
			payload
		})]);
	}
	/** Records one question a child run asks its direct parent (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
	async askParentQuestionIn(storeId, ask, actor) {
		const snapshot = await this.stores.settledSnapshot(storeId);
		const questionId = questionIdOf({
			childRunId: ask.childRunId,
			requestKey: ask.requestKey
		});
		const stored = questionOf(snapshot, questionId);
		if (stored !== void 0) {
			if (stored.questionDigest !== ask.questionDigest) throw new Error(`task: question request key "${ask.requestKey}" is already bound to question "${questionId}": the stored content digest does not match the one offered`);
			if (stored.blocking !== ask.blocking) throw new Error(`task: question request key "${ask.requestKey}" is already bound to question "${questionId}" with a different blocking declaration`);
			return {
				question: stored,
				created: false
			};
		}
		const child = snapshot.runs.find((item) => item.runId === ask.childRunId);
		if (child === void 0) throw new Error(`task: unknown run "${ask.childRunId}"`);
		const childTask = snapshot.tasks.find((item) => item.taskId === child.taskId);
		if (childTask === void 0) throw new Error(`task: unknown task "${child.taskId}"`);
		if (childTask.parentTaskId === void 0) throw new Error(`task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`);
		const parentTask = snapshot.tasks.find((item) => item.taskId === childTask.parentTaskId);
		if (parentTask === void 0) throw new Error(`task: unknown parent task "${childTask.parentTaskId}"`);
		const parentRunId = parentTask.runIds[parentTask.runIds.length - 1];
		if (parentRunId === void 0) throw new Error(`task: parent task "${parentTask.taskId}" has no run for a question from task "${childTask.taskId}"`);
		const question = {
			...ask,
			questionId,
			parentRunId,
			askedAt: now()
		};
		await this.commitIn(storeId, [event("QuestionAsked", {
			taskId: childTask.taskId,
			runId: child.runId,
			sessionId: child.sessionId,
			parentTaskId: parentTask.taskId,
			actor,
			payload: { question }
		})]);
		return {
			question,
			created: true
		};
	}
	/** Records one answer to a still-open question (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
	async answerParentQuestionIn(storeId, answer, actor) {
		const snapshot = await this.stores.settledSnapshot(storeId);
		const question = questionOf(snapshot, answer.questionId);
		if (question === void 0) throw new Error(`task: unknown question "${answer.questionId}"`);
		const answerId = answerIdOf({
			questionId: answer.questionId,
			requestKey: answer.requestKey
		});
		const stored = (question.answers ?? []).find((item) => item.answerId === answerId);
		if (stored !== void 0) {
			if (stored.answerDigest !== answer.answerDigest) throw new Error(`task: answer request key "${answer.requestKey}" is already bound to answer "${answerId}": the stored content digest does not match the one offered`);
			if (stored.resolves !== answer.resolves) throw new Error(`task: answer request key "${answer.requestKey}" is already bound to answer "${answerId}" with a different resolves declaration`);
			return {
				answer: stored,
				created: false
			};
		}
		const child = snapshot.runs.find((item) => item.runId === question.childRunId);
		if (child === void 0) throw new Error(`task: unknown run "${question.childRunId}"`);
		const childTask = snapshot.tasks.find((item) => item.taskId === child.taskId);
		if (childTask === void 0) throw new Error(`task: unknown task "${child.taskId}"`);
		const parent = snapshot.runs.find((item) => item.runId === answer.parentRunId);
		if (parent === void 0) throw new Error(`task: unknown run "${answer.parentRunId}"`);
		const record = {
			...answer,
			answerId,
			answeredAt: now()
		};
		await this.commitIn(storeId, [event("QuestionAnswered", {
			taskId: childTask.taskId,
			runId: parent.runId,
			sessionId: parent.sessionId,
			parentTaskId: parent.taskId,
			actor,
			payload: { answer: record }
		})]);
		return {
			answer: record,
			created: true
		};
	}
	/** Records one no-progress marking on an active run (A3). `rounds` is the caller's consecutive count; the reducer records the value it is given. */
	async markRunProgressIn(storeId, taskId, runId, actor, payload) {
		await this.commitIn(storeId, [event("RunProgressMarked", {
			taskId,
			runId,
			actor,
			payload
		})]);
	}
	/** Records one proposal submission (T2/T3 §6; root contracts A0 §2). The immutable record, the policy it was born under, the limits in force, the resolution it was reviewed against, and both context fingerprints. */
	async submitProposalIn(storeId, proposal, actor) {
		await this.commitIn(storeId, [event("TaskProposalSubmitted", {
			taskId: proposal.kind === "root" ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId,
			actor,
			payload: { proposal }
		})]);
	}
	/** Records one review decision (T2/T3 §6), bound to the dossier digest and both context fingerprints the reviewer was shown. */
	async decideProposalIn(storeId, claim, actor) {
		const taskId = await this.proposalEnvelopeTaskIn(storeId, claim.proposalId);
		await this.commitIn(storeId, [event("TaskProposalDecided", {
			taskId,
			actor,
			payload: claim
		})]);
	}
	/** Records one runtime phase change (T2/T3 §6): to `pending_review` when the deployment tightened to `all`, to `ready` when an approval passed its post-approval re-check, to `stale` when that re-check failed. */
	async changeProposalPhaseIn(storeId, change, actor) {
		const taskId = await this.proposalEnvelopeTaskIn(storeId, change.proposalId);
		await this.commitIn(storeId, [event("TaskProposalPhaseChanged", {
			taskId,
			actor,
			payload: change
		})]);
	}
	/** Records one consumption on its own (T2/T3 §6): the batch the proposal became, by child task id and batch id. */
	async consumeProposalIn(storeId, consumption, actor) {
		const taskId = await this.proposalEnvelopeTaskIn(storeId, consumption.proposalId);
		await this.commitIn(storeId, [event("TaskProposalAdmitted", {
			taskId,
			actor,
			payload: consumption
		})]);
	}
	async recordEvidenceIn(storeId, evidence, actor) {
		await this.commitIn(storeId, [event("EvidenceProduced", {
			taskId: evidence.taskId,
			runId: evidence.taskRunId,
			actor,
			payload: { evidence }
		})]);
	}
	async recordReviewIn(storeId, review, actor) {
		await this.commitIn(storeId, [event("ReviewRecorded", {
			taskId: review.taskId,
			runId: review.runId,
			actor,
			payload: { review }
		})]);
	}
	async recordDiagnosisIn(storeId, diagnosis, actor) {
		await this.commitIn(storeId, [event("DiagnosisRecorded", {
			taskId: diagnosis.taskId,
			actor,
			payload: { diagnosis }
		})]);
	}
	async recordObligationIn(storeId, obligation, actor) {
		await this.commitIn(storeId, [event("ObligationRecorded", {
			taskId: obligation.sourceTaskId,
			actor,
			payload: { obligation }
		})]);
	}
	/** Records one approved budget extension (K4), or answers a repeat of one the store already holds. */
	async recordBudgetExtensionIn(storeId, rootTaskId, claim, actor) {
		if (claim.deadlineAt !== void 0 || claim.baseline.deadlineAt !== void 0 || claim.maxRuns === void 0) throw new Error("task: new budget extensions require maxRuns and accept no deadlineAt");
		await this.stores.serial(storeId, async (state) => {
			const stored = state.snapshot().budgetExtensions?.byRequestKey[claim.requestKey];
			if (stored !== void 0) {
				if (stored.requestDigest !== claim.requestDigest) throw new Error(`task: budget extension request key "${claim.requestKey}" is already bound to ${describeBudgetExtension(stored)} (identity ${stored.requestDigest}); one key names one request, and different content under it is a new key rather than a second grant`);
				return;
			}
			await this.stores.append(storeId, state, [event("TaskBudgetExtended", {
				taskId: rootTaskId,
				sessionId: claim.requestedBy,
				actor,
				payload: { extension: claim }
			})]);
		});
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
		await this.stores.commit(storeId, events);
	}
	/** The proposal one event names, read from the store before the commit so an unknown proposal is a refusal *before* anything is queued: the reducer would reject the event anyway, and a caller that asked about a proposal the store does not … */
	async requireProposalIn(storeId, proposalId) {
		const proposal = (await this.stores.settledSnapshot(storeId)).proposals?.byId[proposalId];
		if (proposal === void 0) throw new Error(`task: unknown proposal "${proposalId}"`);
		return proposal;
	}
	/** The task id a proposal's events carry on the envelope: the parent task a decomposition batch belongs to, or the reserved root marker for a root contract, which has no parent to name (A0 §2). */
	async proposalEnvelopeTaskIn(storeId, proposalId) {
		const proposal = await this.requireProposalIn(storeId, proposalId);
		return proposal.kind === "root" ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId;
	}
};
var src_default = TaskService;

//#endregion
export { BUDGET_EXTENSION_BASELINE_FIELDS, BUDGET_EXTENSION_CLAIM_FIELDS, EventStoreSet, JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, ROOT_PROPOSAL_TASK_ID, TASK_CONTRACT_VERSION, TASK_PROPOSAL_DECISION_OUTCOMES, TASK_PROPOSAL_KINDS, TASK_PROPOSAL_PHASES, TERMINAL_RUN_STATUSES, TaskService, TaskState, admissionContextDigest, answerIdOf, approvedBudgetCeilings, batchIdFor, blockingQuestionsOf, budgetExtensionRequestDigest, canonicalBudgetInstant, canonicalize, capabilityManifestDigest, catalogPathWithin, contractDigest, decompositionDigest, src_default as default, definedKeys, describeBudgetExtension, describeBudgetReading, isTerminalRunStatus, openQuestionsOf, parseCatalogPath, parseTemplateScope, questionIdOf, questionOf, questionsAwaitingAnswerOf, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, runMemberSlots, runMemberTaskIds, sha256Hex, taskContractIdentity, taskProposalId, taskTemplateDigest };