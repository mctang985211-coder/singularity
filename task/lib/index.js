import { Context, Service } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";

//#region src/contract.ts
/**
* The normalized contract version this build writes. Separate from a
* `TaskDefinition.version` (a template's own generation) and from the event
* envelope's `schemaVersion` (the store's wire format): this one versions the
* contract data definition, and an entry that declares a version this build
* does not know is refused rather than read with the wrong field semantics.
*/
const TASK_CONTRACT_VERSION = 1;
/**
* Stable serialization of contract data: object keys sorted, arrays kept in
* order, strings byte-for-byte, `undefined`-valued keys dropped (the session
* log drops them too, so the digest describes what is actually persisted).
*
* Two spellings of the same data must serialize identically — that is what
* makes key order irrelevant to an identity. Values the session log cannot
* round-trip (functions, symbols, `NaN`, `Infinity`, `bigint`) are refused
* loudly: a digest over such a value would compare equal to a digest of a
* different value that happened to stringify the same way.
*/
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
	return `{${Object.keys(source).filter((key) => source[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`).join(",")}}`;
}
function sha256(text) {
	return sha256Hex(text);
}
/**
* SHA-256 (lowercase hex) of raw bytes: the digest form a protected
* acceptance input's identity is fixed with ({@link ProtectedInputRef}),
* shared by the admission-time fixing and the pre-judgement re-check.
*/
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

//#endregion
//#region src/proposal.ts
/** Every proposal kind, for validation and rendering. */
const TASK_PROPOSAL_KINDS = ["decomposition", "root"];
/**
* The reserved `taskId` a root proposal's events carry on the envelope. A root
* contract belongs to no task — the task it becomes does not exist until it is
* activated — so its events cannot name one, and naming a task that happens to
* exist would make an intake read as that task's business. The marker is
* deliberately outside the shape mints use (`t-<uuid>` in task-runtime's root,
* batch and replay paths), so it can never collide with a real task id and no
* task can ever shadow it; the reducer requires it for `kind: 'root'` and
* refuses it for `decomposition`.
*/
const ROOT_PROPOSAL_TASK_ID = "root-proposal";
/** Every proposal status, for validation and rendering. */
const TASK_PROPOSAL_STATUSES = [
	"ready",
	"pending_review",
	"approved",
	"rejected",
	"cancelled",
	"stale",
	"admitted",
	"expired"
];
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
/** The `p-` prefix every proposal id carries, so an id is recognizable as one wherever it is printed. */
const TASK_PROPOSAL_ID_PREFIX = "p-";
/**
* The proposal id one batch identity gets: `p-` plus {@link decompositionDigest}
* of the identity. One implementation, used by every writer and by the
* idempotency lookup, so "the proposal I sent before the restart" and "the
* proposal in the store" cannot be two different addresses for one batch.
*
* The id is not part of the digest it is derived from, and neither is the
* admission context: both contexts are recorded *beside* the id, so the same
* batch re-submitted after a configuration change addresses the same proposal
* and is refused as a duplicate (a genuinely new submission is new content, or
* a new revision with its own key).
*/
function taskProposalId(identity) {
	return `${TASK_PROPOSAL_ID_PREFIX}${decompositionDigest(identity)}`;
}
/**
* The root contract's identity: SHA-256 over {@link canonicalize} of
* {@link RootProposalIdentity} — which store, which root session, which request
* key, and the digest of the normalized root contract. Exactly those fields and
* nothing else (A0 §2), so the same contract asked for again by the same key is
* one proposal, a revision is a different one, and no id minted at activation
* is in it.
*/
function rootProposalDigest(identity) {
	return sha256Hex(canonicalize(identity));
}
/**
* The proposal id one root contract identity gets: `p-` plus
* {@link rootProposalDigest} of the identity. The same derivation and the same
* prefix as a batch proposal (§4: content-derived ids, never minted), so an id
* is one kind of thing wherever it is printed and a retry addresses the same
* proposal.
*/
function rootProposalId(identity) {
	return `${TASK_PROPOSAL_ID_PREFIX}${rootProposalDigest(identity)}`;
}
/**
* The identity of the limits a batch was admitted under: SHA-256 over
* {@link canonicalize} of the {@link AdmissionContext}. Key order and an
* explicit `undefined` limit are not differences (the canonical form drops
* them), so the same configuration always fingerprints the same way, and any
* enforced or audited value that moves moves the fingerprint.
*
* The re-check between approval and admission compares this fingerprint
* (§6: "有效预算…变化，首版保守标 stale"), which is why it covers the
* audit-only values too: they are part of what a reviewer was shown.
*/
function admissionContextDigest(context) {
	return sha256Hex(canonicalize(context));
}
/**
* The identity of what a batch resolved against: SHA-256 over
* {@link canonicalize} of every manifest the batch resolved, **in batch
* order** — the order the children were proposed in, so two resolutions of the
* same batch that assigned the manifests to different children are two
* identities rather than one.
*
* One implementation so the writer and any later re-computation agree; the
* digest covers exactly the manifests it is given (nothing about unrelated
* registry rows), which is what keeps §6's "an unrelated registry edit must not
* invalidate a reviewed proposal" true.
*/
function capabilityManifestDigest(manifests) {
	return sha256Hex(canonicalize(manifests));
}
/**
* The identity of the resolution a proposal was reviewed against: SHA-256 over
* {@link canonicalize} of the {@link TaskProposalReviewContext} with its
* verifier list normalized to ascending `(verifierId, version,
* configurationDigest)`.
*
* The normalization is the point: the same set of judging instances resolved in
* two orders is one identity, because the order a registry happened to hand
* them over in says nothing about what was reviewed — and a fingerprint that
* flapped with it would mark proposals stale for no reason. Sorting is a plain
* codepoint comparison, never a locale-sensitive one, so a fingerprint does not
* depend on the platform's collation.
*
* Like every other digest here it hashes what it is given: shape validation is
* the entry's job (the reducer refuses a malformed record before comparing
* fingerprints), and the covered field set is closed by
* {@link TaskProposalReviewContext}.
*/
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
//#region src/types.ts
/** DFS over an edge list: true when `target` is reachable from `start`. */
function reaches(edges, start, target) {
	const seen = /* @__PURE__ */ new Set();
	const pending = [start];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === target) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const edge of edges) if (edge.from === current) pending.push(edge.to);
	}
	return false;
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
/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
const RootTaskSpec = {
	taskType: "root",
	version: 1,
	acceptanceCriteria: [{
		criterionId: "root-children-verified",
		description: "all mandatory children verified",
		verificationMode: "composite",
		requiredEvidence: [],
		mandatory: true
	}],
	requiredCapabilities: [],
	decompositionPolicy: { allowed: true }
};
/** Store id convention: one task store per root session. */
function rootTaskStoreId(rootSessionId) {
	return `sg-t-${rootSessionId}`;
}

//#endregion
//#region src/service/state.ts
function copy(value) {
	return structuredClone(value);
}
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
const PROPOSAL_TARGET_TYPES = [
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
/**
* The statuses each decision may be taken from — the one thing a decision's
* legality is checked against. `approved` and `rejected` require a proposal
* that actually waited for review (a policy-off batch has no review to decide),
* while `cancelled` and `expired` may also land on a `ready` or `approved`
* proposal: withdrawing a batch and invalidating a late approval are things
* that happen to a batch nobody is reviewing.
*/
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
/**
* The statuses each runtime phase change may come from. `pending_review` is
* reachable only from `ready` (the deployment tightened to `all` before the
* batch was admitted) and never from `pending_review` itself — re-asking for a
* review a proposal is already waiting for would fake progress. `ready` is
* reachable only from `approved`: that edge *is* the post-approval re-check
* passing, so it cannot be written for a proposal nobody approved. `stale`
* invalidates a re-check, so it applies to what a re-check can reach: a
* re-checked approval or an un-admitted `ready` proposal (§6 runs the re-check
* after approval and before admission; a proposal still awaiting review is not
* re-checked — it expires or is decided instead).
*/
const PHASE_SOURCES = {
	ready: ["approved"],
	pending_review: ["ready"],
	stale: ["ready", "approved"]
};
/** The only status a consumption may come from: the re-check has to have passed and be on the record. */
const ADMISSION_SOURCES = ["ready"];
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
	"children"
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
const BATCH_CONSUMPTION_FIELDS = ["batchId", "childTaskIds"];
/** The root vocabulary a batch consumption must not carry. */
const ROOT_CONSUMPTION_FIELDS = ["rootTaskId", "rootRunId"];
/** One store's proposal index with nothing in it; what a store without proposals answers. */
function emptyProposalIndex() {
	return {
		all: [],
		byId: {},
		byRequestKey: {},
		byParentTask: {}
	};
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
var TaskState = class TaskState {
	value;
	constructor(id, snapshot) {
		this.value = snapshot === void 0 ? {
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
			proposals: emptyProposalIndex()
		} : copy(snapshot);
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
				this.addTask(event$1.payload.task);
				return;
			case "TaskAdmitted":
				this.admit(event$1.taskId, event$1.payload.decompositionStatus);
				return;
			case "TaskRejected":
				this.transit(event$1.taskId, ["created"], "blocked");
				return;
			case "TaskDecomposed":
				this.decompose(event$1.taskId, event$1.payload.childTaskIds, event$1.payload.admission);
				return;
			case "DependencyAdded":
				this.addDependency(event$1.payload.edge);
				return;
			case "TaskStarted":
				this.start(event$1.taskId, event$1.runId, event$1.payload.run);
				return;
			case "TaskBlocked":
				this.block(event$1.taskId, event$1.runId);
				return;
			case "TaskVerifying":
				this.transit(event$1.taskId, ["running"], "verifying");
				return;
			case "TaskVerified":
				this.verify(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskFailed":
				this.fail(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskCancelled":
				this.cancel(event$1.taskId, event$1.runId, event$1.payload.finishedAt);
				return;
			case "TaskRetried":
				this.transit(event$1.taskId, ["failed"], "ready");
				return;
			case "RunPhaseChanged":
				this.changeRunPhase(event$1.taskId, event$1.runId, event$1.payload);
				return;
			case "RunProgressMarked":
				this.markRunProgress(event$1.taskId, event$1.runId, event$1.payload, event$1.timestamp);
				return;
			case "CapabilityResolved":
				this.resolveCapabilities(event$1.taskId, event$1.payload.manifest);
				return;
			case "CapabilityGapDetected":
				this.task(event$1.taskId);
				return;
			case "EvidenceProduced":
				this.produceEvidence(event$1.taskId, event$1.runId, event$1.payload.evidence);
				return;
			case "HandoffCreated":
				this.addHandoff(event$1.payload.handoff);
				return;
			case "ReviewRecorded":
				this.recordReview(event$1.taskId, event$1.runId, event$1.payload.review);
				return;
			case "DiagnosisRecorded":
				this.recordDiagnosis(event$1.taskId, event$1.payload.diagnosis);
				return;
			case "ObligationRecorded":
				this.recordObligation(event$1.payload.obligation);
				return;
			case "TaskProposalSubmitted":
				this.submitProposal(event$1.taskId, event$1.payload.proposal);
				return;
			case "TaskProposalDecided":
				this.decideProposal(event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			case "TaskProposalPhaseChanged":
				this.changeProposalPhase(event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			case "TaskProposalAdmitted":
				this.admitProposal(event$1.taskId, event$1.payload, event$1.timestamp);
				return;
			default: throw new Error(`task: unknown event kind "${event$1.kind}"`);
		}
	}
	addTask(task) {
		if (typeof task.taskId !== "string" || task.taskId.length === 0) throw new Error("task: task id must be a non-empty string");
		if (typeof task.objective !== "string" || task.objective.length === 0) throw new Error(`task: task "${task.taskId}" objective must be non-empty`);
		if (this.value.tasks.some((item) => item.taskId === task.taskId)) throw new Error(`task: task "${task.taskId}" already exists`);
		if (task.status !== "created") throw new Error(`task: task "${task.taskId}" must be created in status "created"`);
		if (task.runIds.length !== 0 || task.childTaskIds.length !== 0) throw new Error("task: task runs and children must use events");
		if (task.parentTaskId === task.taskId) throw new Error(`task: task "${task.taskId}" cannot be its own parent`);
		if (task.contract !== void 0) this.assertContract(task.taskId, task.contract, task);
		if (task.parentTaskId === void 0) {
			if (task.depth !== 0) throw new Error(`task: root task "${task.taskId}" depth must be 0`);
			this.value = {
				...this.value,
				tasks: [...this.value.tasks, copy(task)]
			};
			return;
		}
		const parent = this.task(task.parentTaskId);
		if (task.depth !== parent.depth + 1) throw new Error(`task: task "${task.taskId}" depth must be parent depth + 1`);
		this.value = {
			...this.value,
			tasks: [...this.value.tasks.map((item) => item.taskId === parent.taskId ? {
				...item,
				childTaskIds: [...item.childTaskIds, task.taskId]
			} : item), copy(task)]
		};
	}
	/**
	* A task's contract is either absent — a task created before the contract
	* existed — or the single source its projection fields are generated from.
	* The check re-derives the projections from the contract and refuses a
	* disagreement instead of letting either side stand in for the other: a
	* reader that trusts `objective` and one that trusts `contract.objective`
	* must never see two different goals. Structural comparison goes through
	* `canonicalize`, so key order in the stored payload is not a difference.
	*/
	assertContract(taskId, contract, task) {
		this.assertContractFields(`task "${taskId}"`, contract);
		if (task.objective !== contract.objective) throw new Error(`task: task "${taskId}" objective disagrees with its contract objective`);
		if (canonicalize(task.acceptanceCriteria) !== canonicalize(contract.acceptanceCriteria)) throw new Error(`task: task "${taskId}" acceptance criteria disagree with its contract`);
		if (canonicalize(task.requestedCapabilities) !== canonicalize(contract.requiredCapabilities)) throw new Error(`task: task "${taskId}" requested capabilities disagree with its contract`);
	}
	/**
	* The contract fields one normalized contract must carry, checked the same
	* way wherever a contract is stored — on a task (T1) and on each child of a
	* proposal's batch (T2). `where` names the record being checked, so a refusal
	* says which contract it came from instead of "some contract is malformed".
	*
	* Shape only: whether the contract is the *right* one is a question the
	* callers answer (a task's projections must agree with it; a proposal's batch
	* must digest to its identity's child digest).
	*/
	assertContractFields(where, contract) {
		if (contract.contractVersion !== TASK_CONTRACT_VERSION) throw new Error(`task: ${where} declares contract version ${String(contract.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`);
		const lists = [
			["assumptions", contract.assumptions],
			["constraints", contract.constraints],
			["requiredCapabilities", contract.requiredCapabilities]
		];
		for (const [name, value] of lists) if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`task: ${where} contract ${name} must be an array of strings`);
		if (typeof contract.objective !== "string") throw new Error(`task: ${where} contract objective must be a string`);
	}
	/**
	* The batch record a decomposition carries is the identity a later review
	* gate binds an approval to, so a malformed one is refused rather than
	* stored: an empty proposal digest or a non-numeric limit would make the
	* record unusable exactly when someone needs to compare it.
	*/
	assertAdmission(taskId, admission) {
		if (typeof admission.proposalDigest !== "string" || admission.proposalDigest.length === 0) throw new Error(`task: task "${taskId}" decomposition admission requires a proposal digest`);
		const context = admission.context;
		if (!isRecord(context)) throw new Error(`task: task "${taskId}" decomposition admission requires an admission context`);
		this.assertAdmissionLimits(`task "${taskId}" admission context`, context);
	}
	/**
	* The limits one admission context carries, checked the same way wherever one
	* is stored — on a decomposition (T1) and on a proposal (T2: the limits the
	* batch was submitted under, whose fingerprint an approval binds). `where`
	* names the record being checked, so a refusal says which producer it came
	* from instead of "some context is malformed".
	*/
	assertAdmissionLimits(where, context) {
		for (const [name, value] of [["maxDepth", context.maxDepth], ["maxChildren", context.maxChildren]]) if (!Number.isInteger(value) || value < 0) throw new Error(`task: ${where} ${name} must be a non-negative integer`);
		const auditOnly = context.auditOnly;
		if (!isRecord(auditOnly)) throw new Error(`task: ${where} auditOnly must be an object`);
		const limits = [
			["wallTimeMs", context.wallTimeMs],
			["auditOnly.maxToolCalls", auditOnly.maxToolCalls],
			["auditOnly.tokens", auditOnly.tokens],
			["auditOnly.attempts", auditOnly.attempts]
		];
		for (const [name, value] of limits) if (value !== void 0 && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`task: ${where} ${name} must be a finite number when present`);
	}
	admit(taskId, decompositionStatus) {
		this.assertTransition(taskId, ["created"], "admitted");
		this.updateTask(taskId, {
			status: "admitted",
			decompositionStatus
		});
	}
	decompose(taskId, childTaskIds, admission) {
		const parent = this.task(taskId);
		if (parent.decompositionStatus === "decomposed") throw new Error(`task: task "${taskId}" is already decomposed`);
		for (const childTaskId of childTaskIds) if (!parent.childTaskIds.includes(childTaskId)) throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`);
		if (parent.childTaskIds.filter((childTaskId) => ADMITTED_OR_LATER.includes(this.task(childTaskId).status)).length === 0) throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`);
		if (admission !== void 0) this.assertAdmission(taskId, admission);
		this.updateTask(taskId, { decompositionStatus: "decomposed" });
	}
	/**
	* The content identity a run records is what a later reader re-checks the
	* snapshot against, so a malformed record is refused rather than stored: a
	* digest that is not a digest, or a skill entry without a name, would make the
	* record unusable exactly when someone asks whether an execution's bound
	* content is still the content on disk. Only the shape is judged here — the
	* bytes are the runtime's business, and a record whose snapshot no longer
	* matches is a refusal its reader reports, not a reason to reject the event
	* that already happened.
	*/
	assertProviderBinding(runId, binding) {
		if (typeof binding.registryRevision !== "string" || binding.registryRevision.length === 0) throw new Error(`task: run "${runId}" provider binding requires a registry revision`);
		const list = (name, value) => {
			if (!Array.isArray(value)) throw new Error(`task: run "${runId}" provider binding ${name} must be an array`);
			return value;
		};
		for (const name of list("capabilities", binding.capabilities)) if (typeof name !== "string" || name.length === 0) throw new Error(`task: run "${runId}" provider binding capability names must be non-empty strings`);
		const digest = (where, value, nullable) => {
			if (nullable && value === null) return;
			if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`task: run "${runId}" provider binding ${where} must be a lowercase SHA-256 hex digest${nullable ? " or null" : ""}`);
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
	/**
	* The submission record is what a reader trusts instead of re-reading the
	* worker's transcript, so a malformed one is refused rather than stored: an
	* unnamed summary or a ref list that is not a list would leave the record
	* unusable exactly when someone asks what was handed in. Shape only —
	* whether the refs point at anything the store holds is judged by the
	* acceptance reader.
	*/
	assertSubmissionShape(runId, submission) {
		if (!isRecord(submission)) throw new Error(`task: run "${runId}" submission must be an object`);
		if (!nonEmpty(submission.summary)) throw new Error(`task: run "${runId}" submission requires a summary`);
		if (!Array.isArray(submission.evidenceRefs) || submission.evidenceRefs.some((item) => typeof item !== "string")) throw new Error(`task: run "${runId}" submission evidence refs must be an array of strings`);
		if (submission.notes !== void 0 && typeof submission.notes !== "string") throw new Error(`task: run "${runId}" submission notes must be a string when present`);
		if (submission.origin !== "worker" && submission.origin !== "runtime") throw new Error(`task: run "${runId}" submission origin must be "worker" or "runtime"`);
		if (!nonEmpty(submission.submittedAt)) throw new Error(`task: run "${runId}" submission requires a submission time`);
	}
	/**
	* A run's birth phase is written by the runtime, and the reducer judges its
	* shape only — the transition semantics belong to `changeRunPhase`. A run
	* with no phase is a record from before the protocol and stays legal; a run
	* born `active` carries neither a submission nor a batch; a run born
	* `submitted` (a workerless replay) must carry a well-shaped submission and
	* no batch. `waiting_children` is not a birth phase: no creation path admits
	* a batch before the run exists.
	*/
	assertBirthPhase(run) {
		const phase = run.executionPhase;
		if (phase === void 0) return;
		if (phase !== "active" && phase !== "submitted") throw new Error(`task: run "${run.runId}" execution phase must be "active" or "submitted" at start`);
		if (run.batchId !== void 0) throw new Error(`task: run "${run.runId}" is born ${phase}; a batch id is recorded by a phase change, not at start`);
		if (phase === "active") {
			if (run.submission !== void 0) throw new Error(`task: run "${run.runId}" is born active; only a submitted run carries a submission`);
			return;
		}
		if (run.submission === void 0) throw new Error(`task: run "${run.runId}" is born submitted; a submission record is required`);
		this.assertSubmissionShape(run.runId, run.submission);
	}
	/**
	* A4's question ids ride on the phase change; nothing reads them yet, so the
	* reducer checks that the list is a list of strings and carries it unchanged
	* — an empty list is a legitimate shape and is stored as given.
	*/
	assertQuestionIds(runId, payload) {
		const lists = [["pendingQuestionIds", payload.pendingQuestionIds], ["blockingQuestionIds", payload.blockingQuestionIds]];
		for (const [name, value] of lists) if (value !== void 0 && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) throw new Error(`task: run "${runId}" ${name} must be an array of strings`);
	}
	addDependency(edge) {
		this.task(edge.from);
		this.task(edge.to);
		if (edge.from === edge.to || reaches(this.value.edges, edge.to, edge.from)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" creates a cycle`);
		if (this.value.edges.some((item) => item.from === edge.from && item.to === edge.to)) throw new Error(`task: dependency "${edge.from}" → "${edge.to}" already exists`);
		this.value = {
			...this.value,
			edges: [...this.value.edges, copy(edge)]
		};
	}
	start(taskId, envelopeRunId, run) {
		if (typeof run.runId !== "string" || run.runId.length === 0) throw new Error("task: run id must be a non-empty string");
		if (this.value.runs.some((item) => item.runId === run.runId)) throw new Error(`task: run "${run.runId}" already exists`);
		if (run.taskId !== taskId) throw new Error(`task: run "${run.runId}" does not belong to task "${taskId}"`);
		if (envelopeRunId !== run.runId) throw new Error(`task: run "${run.runId}" envelope run id mismatch`);
		if (run.status !== "running") throw new Error(`task: run "${run.runId}" must start in status "running"`);
		if (typeof run.sessionId !== "string" || run.sessionId.length === 0) throw new Error(`task: run "${run.runId}" session id must be non-empty`);
		if (run.providerBinding !== void 0) this.assertProviderBinding(run.runId, run.providerBinding);
		this.assertBirthPhase(run);
		if (run.parentRunId !== void 0) this.run(run.parentRunId);
		this.assertTransition(taskId, ["admitted", "ready"], "running");
		this.value = {
			...this.value,
			runs: [...this.value.runs, copy(run)]
		};
		this.updateTask(taskId, {
			status: "running",
			runIds: [...this.task(taskId).runIds, run.runId]
		});
	}
	block(taskId, runId) {
		this.assertTransition(taskId, [
			"admitted",
			"ready",
			"running"
		], "blocked");
		if (runId !== void 0) this.assertRunTransition(runId, ["running"], "blocked");
		this.updateTask(taskId, { status: "blocked" });
		if (runId !== void 0) this.setRun(runId, "blocked");
	}
	verify(taskId, runId, finishedAt) {
		if (runId === void 0) throw new Error(`task: TaskVerified for "${taskId}" requires a run id`);
		this.assertTransition(taskId, ["verifying"], "verified");
		if (!this.value.evidence.some((item) => item.taskId === taskId && item.taskRunId === runId)) throw new Error(`task: run "${runId}" has no evidence`);
		this.assertRunTransition(runId, ["running"], "verified");
		this.updateTask(taskId, { status: "verified" });
		this.setRun(runId, "verified", finishedAt);
	}
	fail(taskId, runId, finishedAt) {
		this.assertTransition(taskId, ["running", "verifying"], "failed");
		if (runId !== void 0) this.assertRunTransition(runId, ["running", "blocked"], "failed");
		this.updateTask(taskId, { status: "failed" });
		if (runId !== void 0) this.setRun(runId, "failed", finishedAt);
	}
	/**
	* A run keeps `running` through verification (the coordination phase, not the
	* status, is what records the submission), so a cancellation that lands while a
	* verifier call is in flight arrives at a task that is already `verifying`.
	* Refusing it would leave the tree half-settled — the parent cancelled, the
	* verifying child not — and make the documented exit for a store that cannot be
	* recovered (`cancelGraph`) impossible exactly when it is needed. `failed`
	* already accepts both source statuses; this is the same rule for `cancelled`.
	*/
	cancel(taskId, runId, finishedAt) {
		this.assertTransition(taskId, ["running", "verifying"], "cancelled");
		if (runId !== void 0) this.assertRunTransition(runId, ["running", "blocked"], "cancelled");
		this.updateTask(taskId, { status: "cancelled" });
		if (runId !== void 0) this.setRun(runId, "cancelled", finishedAt);
	}
	/**
	* The coordination phase is the A3 admission gate, so this handler is where
	* a transition is either the one legal edge or a refusal: a run accepts
	* `active → waiting_children`, `active → submitted` and
	* `waiting_children → submitted`, and nothing else. Same phase, a rollback,
	* a run with no phase at all and a run that is no longer running are all
	* refused, because "already submitted" and "already decomposed" have to be
	* answered by this one field — a second submission that overwrote the first
	* record, or a decomposition admitted after the gate closed, would make the
	* field answer differently at two reads.
	*
	* The run status is checked first because a phase change on a failed or
	* cancelled run is late by definition; verification is the case the phase
	* guard exists for, since a run inside it is still `running`.
	*
	* Only the payload's shape is judged: the batch a run waits on and what it
	* submitted are the writer's statements, and A4's question ids are carried,
	* not interpreted.
	*/
	changeRunPhase(taskId, runId, payload) {
		if (runId === void 0) throw new Error(`task: RunPhaseChanged for task "${taskId}" requires a run id`);
		const run = this.run(runId);
		if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`);
		if (run.status !== "running") throw new Error(`task: run "${runId}" is ${run.status}; a phase change requires a running run`);
		const to = payload.phase;
		if (!EXECUTION_PHASES.includes(to)) throw new Error(`task: run "${runId}" execution phase must be one of ${EXECUTION_PHASES.join(", ")}`);
		const from = run.executionPhase;
		if (from === void 0) throw new Error(`task: run "${runId}" has no execution phase; only an active run changes phase`);
		if (!(from === "active" && (to === "waiting_children" || to === "submitted") || from === "waiting_children" && to === "submitted")) throw new Error(`task: illegal run phase transition "${from}" → "${to}" for run "${runId}"`);
		if (to === "waiting_children") {
			if (!nonEmpty(payload.batchId)) throw new Error(`task: run "${runId}" entering waiting_children requires a batch id`);
			if (payload.submission !== void 0) throw new Error(`task: run "${runId}" is entering waiting_children; only the submitted phase carries a submission`);
		} else {
			if (payload.submission === void 0) throw new Error(`task: run "${runId}" submitting requires a submission record`);
			this.assertSubmissionShape(runId, payload.submission);
			if (payload.batchId !== void 0) throw new Error(`task: run "${runId}" is submitting; a batch id belongs to the waiting_children phase`);
		}
		this.assertQuestionIds(runId, payload);
		this.value = {
			...this.value,
			runs: this.value.runs.map((item) => item.runId === runId ? {
				...item,
				executionPhase: to,
				...payload.batchId === void 0 ? {} : { batchId: payload.batchId },
				...payload.submission === void 0 ? {} : { submission: copy(payload.submission) },
				...payload.pendingQuestionIds === void 0 ? {} : { pendingQuestionIds: [...payload.pendingQuestionIds] },
				...payload.blockingQuestionIds === void 0 ? {} : { blockingQuestionIds: [...payload.blockingQuestionIds] }
			} : item)
		};
	}
	/**
	* A no-progress marking is the A3 signal a reader shows before the budget
	* stops a stuck run, and it is meaningful only on the phase that can still
	* submit: `active`. A run waiting on children or on verification is expected
	* to be idle — marking it would count a legitimate wait as stagnation and
	* give the budget a reason to stop work that is still under way. `rounds` is
	* the caller's consecutive count; the reducer records the number it is given
	* and never accumulates, so replay and live observation agree.
	*/
	markRunProgress(taskId, runId, payload, timestamp) {
		if (runId === void 0) throw new Error(`task: RunProgressMarked for task "${taskId}" requires a run id`);
		const run = this.run(runId);
		if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`);
		if (run.status !== "running") throw new Error(`task: run "${runId}" is ${run.status}; progress can only be marked while the run is running`);
		const phase = run.executionPhase;
		if (phase !== "active") throw new Error(`task: run "${runId}" execution phase is ${phase === void 0 ? "absent" : `"${phase}"`}; progress is only marked on an active run`);
		if (payload.kind !== "unsubmitted-idle") throw new Error(`task: run "${runId}" progress kind must be "unsubmitted-idle"`);
		if (!Number.isInteger(payload.rounds) || payload.rounds < 1) throw new Error(`task: run "${runId}" progress rounds must be a positive integer`);
		if (!Number.isInteger(payload.factCount) || payload.factCount < 0) throw new Error(`task: run "${runId}" progress fact count must be a non-negative integer`);
		if (!nonEmpty(payload.note)) throw new Error(`task: run "${runId}" progress requires a note`);
		this.value = {
			...this.value,
			runs: this.value.runs.map((item) => item.runId === runId ? {
				...item,
				noProgress: {
					kind: payload.kind,
					rounds: payload.rounds,
					factCount: payload.factCount,
					markedAt: timestamp
				}
			} : item)
		};
	}
	resolveCapabilities(taskId, manifest) {
		this.task(taskId);
		this.value = {
			...this.value,
			capabilities: {
				...this.value.capabilities,
				[taskId]: copy(manifest)
			}
		};
	}
	produceEvidence(taskId, runId, evidence) {
		this.task(taskId);
		if (typeof evidence.evidenceId !== "string" || evidence.evidenceId.length === 0) throw new Error("task: evidence id must be a non-empty string");
		if (this.value.evidence.some((item) => item.evidenceId === evidence.evidenceId)) throw new Error(`task: evidence "${evidence.evidenceId}" already exists`);
		if (evidence.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" does not belong to task "${taskId}"`);
		const run = this.run(evidence.taskRunId);
		if (run.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" run "${run.runId}" belongs to task "${run.taskId}"`);
		if (runId !== void 0 && runId !== evidence.taskRunId) throw new Error(`task: evidence "${evidence.evidenceId}" envelope run id mismatch`);
		if (run.status !== "running") throw new Error(`task: run "${run.runId}" is ${run.status}; evidence can only be recorded while the run is running`);
		this.value = {
			...this.value,
			evidence: [...this.value.evidence, copy(evidence)],
			runs: this.value.runs.map((item) => item.runId === run.runId ? {
				...item,
				artifacts: [...item.artifacts, ...copy(evidence.artifacts)],
				verifierResults: [...item.verifierResults, ...copy(evidence.verifierResults)]
			} : item)
		};
	}
	addHandoff(handoff) {
		if (typeof handoff.handoffId !== "string" || handoff.handoffId.length === 0) throw new Error("task: handoff id must be a non-empty string");
		if (this.value.handoffs.some((item) => item.handoffId === handoff.handoffId)) throw new Error(`task: handoff "${handoff.handoffId}" already exists`);
		const parent = this.task(handoff.parentTaskId);
		const child = this.task(handoff.childTaskId);
		if (child.parentTaskId !== parent.taskId) throw new Error(`task: handoff child "${child.taskId}" is not a child of "${parent.taskId}"`);
		this.run(handoff.parentRunId);
		this.value = {
			...this.value,
			handoffs: [...this.value.handoffs, copy(handoff)]
		};
	}
	/**
	* A review is the legal companion of the terminal transition it follows: the
	* run (or the runless blocked task) must already sit in the outcome the record
	* declares, and each run accepts exactly one record — a second one is a bug in
	* the writer, not a late event to tolerate.
	*/
	recordReview(taskId, envelopeRunId, review) {
		const task = this.task(taskId);
		if (review.taskId !== taskId) throw new Error(`task: review for "${review.taskId}" does not belong to task "${taskId}"`);
		if (review.outcome === "failed" && (typeof review.localizedCause !== "string" || review.localizedCause.length === 0)) throw new Error(`task: failed review for task "${taskId}" requires a localized cause`);
		if (review.outcome !== "failed" && review.localizedCause !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a localized cause`);
		if (review.outcome !== "failed" && review.logTail !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a log tail`);
		if (review.outcome !== "blocked" && review.blockedBy !== void 0) throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a blocked outcome carries blockers`);
		if (review.runId === void 0) {
			if (review.outcome !== "blocked" || task.status !== "blocked") throw new Error(`task: review for task "${taskId}" has no run; only a blocked task settles without a run`);
			if (this.value.reviews.some((item) => item.taskId === taskId && item.runId === void 0)) throw new Error(`task: task "${taskId}" already has a runless review`);
		} else {
			const run = this.run(review.runId);
			if (run.taskId !== taskId) throw new Error(`task: review run "${run.runId}" belongs to task "${run.taskId}"`);
			if (envelopeRunId !== void 0 && envelopeRunId !== review.runId) throw new Error(`task: review for run "${review.runId}" envelope run id mismatch`);
			if (run.status !== review.outcome) throw new Error(`task: run "${run.runId}" is ${run.status}; a review must follow the terminal transition it declares (${review.outcome})`);
			if (this.value.reviews.some((item) => item.runId === review.runId)) throw new Error(`task: run "${review.runId}" already has a review`);
		}
		this.value = {
			...this.value,
			reviews: [...this.value.reviews, copy(review)]
		};
	}
	/**
	* A diagnosis is caller-triggered, not lifecycle-bound: any existing task
	* accepts one at any time, and a task accumulates several. What the reducer
	* enforces is integrity, not timing — the id is unique across the store
	* (a repeat write is a bug, not an update), every field is present and
	* well-formed, the diagnosis rests on at least one evidence or review ref,
	* and every proposal names one of the nine frozen target types (§2.7.6).
	*
	* The two optional additions are checked the same way: `producedBy` must name
	* a known producer kind (and a non-empty session when it carries one), and
	* every `judgements` entry must name a judged dimension and a known verdict,
	* carry a rationale, and rest on at least one non-empty evidence ref — an
	* `unknown` verdict still cites the refs it considered, so a judgement that
	* cites nothing is rejected rather than stored.
	*/
	recordDiagnosis(taskId, diagnosis) {
		this.task(taskId);
		if (!nonEmpty(diagnosis.diagnosisId)) throw new Error("task: diagnosis id must be a non-empty string");
		if (this.value.diagnoses.some((item) => item.diagnosisId === diagnosis.diagnosisId)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" already exists`);
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
			if (!PROPOSAL_TARGET_TYPES.includes(proposal.targetType)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal target type must be one of ${PROPOSAL_TARGET_TYPES.join(", ")}`);
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
		for (const related of diagnosis.relatedTaskIds ?? []) this.task(related);
		this.value = {
			...this.value,
			diagnoses: [...this.value.diagnoses, copy(diagnosis)]
		};
	}
	/**
	* An obligation is raised, never scheduled (KISS §5.1: a question, not an
	* action): the reducer enforces integrity only — a unique non-empty id,
	* non-empty goal and criterion, and a source task that exists in the store.
	*/
	recordObligation(obligation) {
		if (!nonEmpty(obligation.obligationId)) throw new Error("task: obligation id must be a non-empty string");
		if (this.value.obligations.some((item) => item.obligationId === obligation.obligationId)) throw new Error(`task: obligation "${obligation.obligationId}" already exists`);
		if (!nonEmpty(obligation.goal)) throw new Error(`task: obligation "${obligation.obligationId}" requires a goal`);
		if (!nonEmpty(obligation.criterion)) throw new Error(`task: obligation "${obligation.obligationId}" requires a criterion`);
		this.task(obligation.sourceTaskId);
		this.value = {
			...this.value,
			obligations: [...this.value.obligations, copy(obligation)]
		};
	}
	/**
	* A proposal enters the store (T2/T3, §6; root contracts A0 §2). The reducer
	* is the shape gate and the integrity gate, in that order: the record must be
	* a well-formed proposal of its kind — the closed field set of its review
	* context, a birth status matching the policy it was submitted under, an
	* identity and a payload whose digests are really the digests of what it
	* carries — and it must not collide with what the store already holds. One key
	* names one proposal and one content identity names one id, so a repeated
	* request can never build a second batch: the caller answers it from the index
	* instead.
	*
	* A root contract has one more gate, and it is the store's, not the record's:
	* a store that already holds a root task refuses root intake by name (A0 §1.6
	* — an old graph's root is history and is not re-intaken, and a goal change is
	* a new graph). The gate is checked here, before anything is stored, so an
	* intake on such a store leaves no trace at all.
	*
	* The digest checks are the point of the submission being an event at all: a
	* proposal whose `proposalDigest`, `admissionContextDigest` or
	* `reviewContextDigest` disagrees with the content it carries would make the
	* approval binding meaningless, because a later decision compares exactly
	* these numbers.
	*/
	submitProposal(taskId, proposal) {
		this.assertProposal(proposal);
		this.assertProposalTask(proposal, taskId);
		const index = this.index();
		if (index.byId[proposal.proposalId] !== void 0) throw new Error(`task: proposal "${proposal.proposalId}" already exists`);
		const bound = index.byRequestKey[proposal.requestKey];
		if (bound !== void 0) throw new Error(`task: proposal request key "${proposal.requestKey}" is already bound to proposal "${bound.proposalId}"`);
		if (proposal.kind === "root") this.assertRootIntakeOpen(proposal.proposalId);
		const stored = copy(proposal);
		if (stored.kind === "root") {
			this.value = {
				...this.value,
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
			return;
		}
		const parentTaskId = stored.identity.parentTaskId;
		this.value = {
			...this.value,
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
	}
	/**
	* One review decision (T2/T3, §6): the outcome, bound to the dossier digest
	* and both context fingerprints, checked against the stored proposal before
	* anything is applied. A digest that disagrees is refused by name — an
	* approval that does not name exactly this batch, under exactly these limits
	* and exactly this resolution, is not an approval of it — and an outcome that
	* is not legal from the current status is refused as a transition, so a
	* second decision never overwrites the first and a policy-off proposal can
	* never be recorded as reviewed.
	*/
	decideProposal(taskId, claim, timestamp) {
		if (!isRecord(claim)) throw new Error("task: proposal decision must be an object");
		const proposal = this.proposal(claim.proposalId);
		this.assertProposalTask(proposal, taskId);
		if (!TASK_PROPOSAL_DECISION_OUTCOMES.includes(claim.outcome)) throw new Error(`task: proposal "${proposal.proposalId}" decision outcome must be one of ${TASK_PROPOSAL_DECISION_OUTCOMES.join(", ")}`);
		this.assertDecisionBinding(proposal, claim);
		if (!nonEmpty(claim.decidedBy)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decider`);
		if (!nonEmpty(claim.decidedAt)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decision time`);
		if (claim.reason !== void 0 && !nonEmpty(claim.reason)) throw new Error(`task: proposal "${proposal.proposalId}" decision reason must be a non-empty string when present`);
		if (claim.outcome === "expired" && !nonEmpty(claim.reason)) throw new Error(`task: proposal "${proposal.proposalId}" expiry requires a reason`);
		this.assertProposalTransition(proposal, claim.outcome, DECISION_SOURCES[claim.outcome]);
		this.setProposal(proposal.proposalId, {
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
	}
	/**
	* One runtime phase change (T2/T3, §6): the two edges that are not a person's
	* decision or a consumption — `ready → pending_review` when the deployment
	* tightened to `all` before admission, `approved → ready` when the
	* post-approval re-check passed, and `→ stale` when it failed. The source
	* statuses are the gate (see {@link PHASE_SOURCES}), and a `stale` marking
	* must name what changed: an invalidation a reader cannot explain is a
	* record that cannot be trusted.
	*/
	changeProposalPhase(taskId, change, timestamp) {
		if (!isRecord(change)) throw new Error("task: proposal phase change must be an object");
		const proposal = this.proposal(change.proposalId);
		this.assertProposalTask(proposal, taskId);
		if (!TASK_PROPOSAL_PHASES.includes(change.to)) throw new Error(`task: proposal "${proposal.proposalId}" phase must be one of ${TASK_PROPOSAL_PHASES.join(", ")}`);
		if (change.to === "stale" && !nonEmpty(change.reason)) throw new Error(`task: proposal "${proposal.proposalId}" is marked stale without a reason`);
		if (change.reason !== void 0 && !nonEmpty(change.reason)) throw new Error(`task: proposal "${proposal.proposalId}" phase change reason must be a non-empty string when present`);
		this.assertProposalTransition(proposal, change.to, PHASE_SOURCES[change.to]);
		this.setProposal(proposal.proposalId, {
			status: change.to,
			updatedAt: timestamp
		});
	}
	/**
	* A proposal is consumed (§6): what it asked for exists, and this record says
	* what it became. The status gate is the re-check having passed on the record
	* (`ready` only — an approval alone never admits, so `approved → admitted` is
	* refused), and the binding is checked in full for the proposal's kind: a
	* decomposition batch names the batch of its parent and children the store
	* holds under that parent; a root contract names the root task and root run of
	* its activation, and the store refuses one intake that would leave it with
	* two roots. A second consumption is a transition refusal, so one proposal can
	* never produce two batches — or two roots.
	*/
	admitProposal(taskId, consumption, timestamp) {
		if (!isRecord(consumption)) throw new Error("task: proposal consumption must be an object");
		const proposal = this.proposal(consumption.proposalId);
		this.assertProposalTask(proposal, taskId);
		this.assertConsumptionBinding(proposal, consumption);
		this.assertProposalTransition(proposal, "admitted", ADMISSION_SOURCES);
		this.setProposal(proposal.proposalId, {
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
				batchId: consumption.batchId,
				childTaskIds: [...consumption.childTaskIds],
				admittedAt: consumption.admittedAt,
				...consumption.reason === void 0 ? {} : { reason: consumption.reason }
			}
		});
	}
	/** The stored proposal one event names, or a refusal naming the id. */
	proposal(proposalId) {
		const proposal = this.index().byId[proposalId];
		if (proposal === void 0) throw new Error(`task: unknown proposal "${String(proposalId)}"`);
		return proposal;
	}
	/**
	* The proposal index of the snapshot this state replays on. It is absent only
	* when a foreign snapshot (a hand-built one from a reader that predates
	* proposals) was replayed onto — never on this build's own value — and that
	* is a refusal rather than an empty index: a reducer that cannot see the
	* proposals would happily write a second one for the same request key.
	*/
	index() {
		const index = this.value.proposals;
		if (index === void 0) throw new Error("task: snapshot carries no proposal index");
		return index;
	}
	/**
	* Every proposal event is about one subject, and the envelope has to name it:
	* a decomposition proposal's events name the parent task whose batch it is; a
	* root contract's events name the reserved {@link ROOT_PROPOSAL_TASK_ID}
	* marker, because the task it becomes does not exist yet and naming a real
	* task would read as that task's intake (A0 §2).
	*/
	assertProposalTask(proposal, taskId) {
		if (proposal.kind === "root") {
			if (taskId !== ROOT_PROPOSAL_TASK_ID) throw new Error(`task: proposal "${proposal.proposalId}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${taskId}"`);
			return;
		}
		if (taskId !== proposal.identity.parentTaskId) throw new Error(`task: proposal "${proposal.proposalId}" belongs to task "${proposal.identity.parentTaskId}", not "${taskId}"`);
	}
	/** The store's root task, if it has one: the task a root intake may not sit beside or activate a second time. */
	rootTask() {
		return this.value.tasks.find((item) => item.parentTaskId === void 0);
	}
	/**
	* A store with a root task refuses root intake by name (A0 §1.6): the root it
	* holds is somebody's goal, and a second intake would make "the store's root"
	* answer differently at two reads. A goal change is a new graph, never a
	* second root here.
	*/
	assertRootIntakeOpen(proposalId) {
		const root = this.rootTask();
		if (root !== void 0) throw new Error(`task: store "${this.value.id}" already holds root task "${root.taskId}"; proposal "${proposalId}" is refused`);
	}
	/** One proposal's status either admits this outcome or the event is a late or out-of-order write. */
	assertProposalTransition(proposal, to, from) {
		if (!from.includes(proposal.status)) throw new Error(`task: illegal proposal transition "${proposal.status}" → "${to}" for proposal "${proposal.proposalId}"`);
	}
	/** Replaces one proposal in place; the index's other views keep pointing at the same record. */
	setProposal(proposalId, patch) {
		const index = this.index();
		const current = index.byId[proposalId];
		if (current === void 0) throw new Error(`task: unknown proposal "${proposalId}"`);
		const next = {
			...current,
			...patch
		};
		const replace = (proposals) => proposals.map((item) => item.proposalId === proposalId ? next : item);
		this.value = {
			...this.value,
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
	}
	/**
	* A submitted proposal has to be complete and internally consistent, because
	* everything an approval binds is taken from it: the review context is a
	* closed record (an unread field would silently become part of an identity),
	* the birth status is the policy the deployment ran under (`off → ready`,
	* `all → pending_review` — the audit of "no human review happened" depends on
	* it), a revision must name a proposal that exists, and the three digests
	* must be the digests of the data they claim to describe.
	*/
	assertProposal(proposal) {
		if (!isRecord(proposal)) throw new Error("task: proposal must be an object");
		if (!nonEmpty(proposal.proposalId)) throw new Error("task: proposal id must be a non-empty string");
		const id = proposal.proposalId;
		if (!nonEmpty(proposal.requestKey)) throw new Error(`task: proposal "${id}" request key must be a non-empty string`);
		const kind = proposal.kind;
		if (kind !== void 0 && kind !== "decomposition" && kind !== "root") throw new Error(`task: proposal "${id}" kind must be one of ${TASK_PROPOSAL_KINDS.join(", ")}`);
		if (kind === void 0 && this.carriesRootContract(proposal)) throw new Error(`task: proposal "${id}" carries root contract fields without kind "root"`);
		if (proposal.status !== "ready" && proposal.status !== "pending_review") throw new Error(`task: proposal "${id}" status "${String(proposal.status)}" is not a birth status`);
		if (proposal.policy !== "off" && proposal.policy !== "all") throw new Error(`task: proposal "${id}" policy must be "off" or "all"`);
		if (proposal.status === "ready" && proposal.policy === "all") throw new Error(`task: proposal "${id}" is submitted ready with policy "all"`);
		if (proposal.status === "pending_review" && proposal.policy === "off") throw new Error(`task: proposal "${id}" is submitted pending_review with policy "off"`);
		if (proposal.supersedes !== void 0) {
			if (!nonEmpty(proposal.supersedes)) throw new Error(`task: proposal "${id}" supersedes must be a non-empty proposal id`);
			if (proposal.supersedes === id) throw new Error(`task: proposal "${id}" cannot supersede itself`);
			if (this.index().byId[proposal.supersedes] === void 0) throw new Error(`task: proposal "${id}" supersedes unknown proposal "${proposal.supersedes}"`);
		}
		if (proposal.kind === "root") this.assertRootProposal(id, proposal);
		else this.assertDecompositionProposal(id, proposal);
		const context = proposal.admissionContext;
		if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires an admission context`);
		this.assertAdmissionLimits(`proposal "${id}" admission context`, context);
		const contextDigest = admissionContextDigest(proposal.admissionContext);
		if (proposal.admissionContextDigest !== contextDigest) throw new Error(`task: proposal "${id}" admission context digest "${String(proposal.admissionContextDigest)}" does not match its context digest "${contextDigest}"`);
		this.assertReviewContext(id, proposal.reviewContext);
		const reviewDigest = reviewContextDigest(proposal.reviewContext);
		if (proposal.reviewContextDigest !== reviewDigest) throw new Error(`task: proposal "${id}" review context digest "${String(proposal.reviewContextDigest)}" does not match its context digest "${reviewDigest}"`);
		if (!nonEmpty(proposal.createdAt)) throw new Error(`task: proposal "${id}" requires a creation time`);
		if (proposal.decision !== void 0) throw new Error(`task: proposal "${id}" is submitted with a decision`);
		if (proposal.consumption !== void 0) throw new Error(`task: proposal "${id}" is submitted with a consumption`);
	}
	/**
	* A decomposition proposal's half of the record: the batch identity and the
	* batch content that must be the content of that identity. Both digests are
	* the ones they always were — this arm is the shape T2/T3 shipped, and adding
	* a kind to the union does not move its identity.
	*/
	assertDecompositionProposal(id, proposal) {
		if (proposal.contract !== void 0) throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot carry a root contract`);
		this.assertProposalIdentity(id, proposal.identity);
		this.assertProposalBatch(id, proposal.batch, proposal.identity);
		const expected = decompositionDigest(proposal.identity);
		if (proposal.proposalDigest !== expected) throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`);
	}
	/**
	* A root contract proposal's half of the record: the root identity (store,
	* root session, request key, contract digest — and no parent task) and the one
	* normalized contract it must be the digest of. The two shapes are checked
	* before the digest, so a mismatch is reported as the wrong content rather
	* than as a wrong number.
	*/
	assertRootProposal(id, proposal) {
		if (proposal.batch !== void 0) throw new Error(`task: proposal "${id}" is a root contract and cannot carry a batch`);
		this.assertRootIdentity(id, proposal.identity);
		if (proposal.identity.requestKey !== proposal.requestKey) throw new Error(`task: proposal "${id}" identity request key "${proposal.identity.requestKey}" disagrees with its request key "${proposal.requestKey}"`);
		const contract = proposal.contract;
		if (!isRecord(contract)) throw new Error(`task: proposal "${id}" requires a root contract`);
		this.assertContractFields(`proposal "${id}" root`, contract);
		if (!Array.isArray(contract.acceptanceCriteria)) throw new Error(`task: proposal "${id}" root contract acceptance criteria must be an array`);
		const digest = contractDigest(contract);
		if (digest !== proposal.identity.contractDigest) throw new Error(`task: proposal "${id}" contract digest "${digest}" does not match its identity digest "${proposal.identity.contractDigest}"`);
		const expected = rootProposalDigest(proposal.identity);
		if (proposal.proposalDigest !== expected) throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`);
	}
	/**
	* Whether a record that does not claim `kind: 'root'` still carries a root
	* contract's fields. Absence of the kind is legal for exactly one arm, so a
	* record that holds a root payload without saying so is refused instead of
	* being read as a decomposition of a parent that does not exist.
	*/
	carriesRootContract(proposal) {
		const raw = proposal;
		if (raw.contract !== void 0) return true;
		const identity = raw.identity;
		return isRecord(identity) && identity.rootSessionId !== void 0;
	}
	/**
	* The batch identity a proposal carries, judged for shape only: the field
	* semantics (a version this build knows, non-empty origins, one dependency
	* index per child) are what a reader needs to interpret it, while the
	* *rules* about a batch — depth, size, dependency cycles, capability gaps —
	* belong to the admission entry that already enforces them (T1's
	* `contractDefects` and the runtime's `checkDecomposition`). The parent task
	* is the one exception, because a proposal naming a task the store does not
	* hold could never be decided or admitted against a real parent. The field set
	* is closed, like every other surface a digest covers: a field no reader
	* understands must not travel inside an identity that a decision binds.
	*/
	assertProposalIdentity(id, identity) {
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
		if (!Array.isArray(identity.children) || identity.children.length === 0) throw new Error(`task: proposal "${id}" identity requires at least one child`);
		identity.children.forEach((child, index) => {
			if (!isRecord(child)) throw new Error(`task: proposal "${id}" child ${index} must be an object`);
			if (!isDigest(child.contractDigest)) throw new Error(`task: proposal "${id}" child ${index} contract digest must be a lowercase SHA-256 hex digest`);
			if (!Array.isArray(child.dependsOn) || child.dependsOn.some((item) => !Number.isInteger(item) || item < 0)) throw new Error(`task: proposal "${id}" child ${index} dependsOn must be an array of non-negative integers`);
			if (typeof child.decomposable !== "boolean") throw new Error(`task: proposal "${id}" child ${index} decomposable must be a boolean`);
			if (typeof child.requiresIndependentAcceptance !== "boolean") throw new Error(`task: proposal "${id}" child ${index} requiresIndependentAcceptance must be a boolean`);
		});
		if (!this.value.tasks.some((item) => item.taskId === identity.parentTaskId)) throw new Error(`task: proposal "${id}" names unknown parent task "${identity.parentTaskId}"`);
	}
	/**
	* The root identity a root contract carries, judged for shape only: the
	* version of the contract language, the store and root session it is for, its
	* request key and the digest of the contract beside it. Its field set is
	* closed — a root contract has no parent task or parent run, so a record that
	* carries one is refused rather than read as something it is not — and nothing
	* about the store's tasks is checked here: a root intake names no task, and its
	* one store-level gate (the store does not already hold a root) belongs to the
	* submission, not to the identity.
	*/
	assertRootIdentity(id, identity) {
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
	/**
	* The batch content a submission carries, bound to the identity it claims to
	* be: one child per identity child, in the same order, each carrying the
	* contract whose {@link contractDigest} is the identity's child digest and the
	* three declarations the identity records. This is the reference constraint
	* that keeps a proposal from being a set of digests with no content behind
	* them — or content nobody committed to — and it is what makes "the batch a
	* reviewer was shown", "the batch an approval binds" and "the batch the
	* identity commits to" one thing rather than three.
	*
	* The content is judged for shape here (a closed field set per child, a
	* contract this build can read, a dependency list of indices, the two flags),
	* and for agreement with the identity in every field. Whether the *rules* of a
	* batch hold — depth, size, cycles, capability gaps — is the admission
	* entry's business, unchanged.
	*/
	assertProposalBatch(id, batch, identity) {
		if (!Array.isArray(batch)) throw new Error(`task: proposal "${id}" batch must be an array`);
		if (batch.length !== identity.children.length) throw new Error(`task: proposal "${id}" batch requires one child per identity child (identity children: ${identity.children.length}, batch children: ${batch.length})`);
		batch.forEach((child, index) => {
			const where = `proposal "${id}" child ${index}`;
			const identityChild = identity.children[index];
			if (!isRecord(child)) throw new Error(`task: ${where} must be an object`);
			for (const key of Object.keys(child)) if (!PROPOSAL_CHILD_FIELDS.includes(key)) throw new Error(`task: ${where} has an unsupported field "${key}"`);
			const contract = child.contract;
			if (!isRecord(contract)) throw new Error(`task: ${where} requires a contract`);
			this.assertContractFields(where, contract);
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
	/**
	* A decision binds the proposal it was made against, so every identity it
	* carries is compared with the stored record: the dossier digest, the
	* admission context, and — for an approval, always — the review context the
	* batch resolved against when it was shown. A mismatch is the one case the
	* reducer must never accept: an approval that travels to other content is
	* exactly the failure the digest binding exists to prevent.
	*/
	assertDecisionBinding(proposal, claim) {
		if (claim.proposalDigest !== proposal.proposalDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision digest "${String(claim.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`);
		if (claim.admissionContextDigest !== proposal.admissionContextDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision admission context digest "${String(claim.admissionContextDigest)}" does not match the stored admission context digest "${proposal.admissionContextDigest}"`);
		if (claim.outcome === "approved" && claim.reviewContextDigest === void 0) throw new Error(`task: proposal "${proposal.proposalId}" approval requires the review context digest it was decided against`);
		if (claim.reviewContextDigest !== void 0 && claim.reviewContextDigest !== proposal.reviewContextDigest) throw new Error(`task: proposal "${proposal.proposalId}" decision review context digest "${claim.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`);
	}
	/**
	* A consumption binds a proposal to what it became, so it has to name the same
	* dossier and the resolution the admission re-check confirmed — for both kinds
	* — and then the kind's own shape: a batch names the batch id that belongs to
	* its parent (`b-<parentTaskId>`) and children the store really holds under
	* that parent; a root contract names the root task and root run of its
	* activation. The common half is checked here so the two kinds cannot drift
	* apart on the numbers that make an approval non-transferable.
	*/
	assertConsumptionBinding(proposal, consumption) {
		const id = proposal.proposalId;
		if (consumption.proposalDigest !== proposal.proposalDigest) throw new Error(`task: proposal "${id}" consumption digest "${String(consumption.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`);
		if (!nonEmpty(consumption.reviewContextDigest)) throw new Error(`task: proposal "${id}" consumption requires a review context digest`);
		if (consumption.reviewContextDigest !== proposal.reviewContextDigest) throw new Error(`task: proposal "${id}" consumption review context digest "${consumption.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`);
		if (proposal.kind === "root") this.assertRootConsumptionShape(proposal, consumption);
		else this.assertBatchConsumptionShape(proposal, consumption);
		if (!nonEmpty(consumption.admittedAt)) throw new Error(`task: proposal "${id}" consumption requires an admission time`);
		if (consumption.reason !== void 0 && !nonEmpty(consumption.reason)) throw new Error(`task: proposal "${id}" consumption reason must be a non-empty string when present`);
	}
	/**
	* The batch half of a consumption: the batch of this parent, and children the
	* store really holds under it — the record a crash recovery reads to find the
	* batch it already admitted instead of admitting a second one. The batch
	* vocabulary is the only one this arm may use, and its `kind` may only be
	* absent (a record written before kinds existed) or `batch`.
	*/
	assertBatchConsumptionShape(proposal, consumption) {
		const id = proposal.proposalId;
		if (consumption.kind === "root") throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot be consumed as a root contract`);
		if (consumption.kind !== void 0 && consumption.kind !== "batch") throw new Error(`task: proposal "${id}" consumption kind must be "batch"`);
		const raw = consumption;
		for (const field of ROOT_CONSUMPTION_FIELDS) if (raw[field] !== void 0) throw new Error(`task: proposal "${id}" consumption carries the root field "${field}"; a batch consumption names batchId and childTaskIds`);
		const batch = consumption;
		if (!nonEmpty(batch.batchId)) throw new Error(`task: proposal "${id}" consumption requires a batch id`);
		const batchId = `b-${proposal.identity.parentTaskId}`;
		if (batch.batchId !== batchId) throw new Error(`task: proposal "${id}" consumption batch "${batch.batchId}" is not the batch of task "${proposal.identity.parentTaskId}"`);
		if (!Array.isArray(batch.childTaskIds) || batch.childTaskIds.length === 0) throw new Error(`task: proposal "${id}" consumption requires at least one child task id`);
		for (const childTaskId of batch.childTaskIds) if (!nonEmpty(childTaskId)) throw new Error(`task: proposal "${id}" consumption child task ids must be non-empty strings`);
		const seen = /* @__PURE__ */ new Set();
		for (const childTaskId of batch.childTaskIds) {
			if (seen.has(childTaskId)) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}" twice`);
			seen.add(childTaskId);
		}
		for (const childTaskId of batch.childTaskIds) {
			const child = this.value.tasks.find((item) => item.taskId === childTaskId);
			if (child === void 0) throw new Error(`task: proposal "${id}" consumption names unknown task "${childTaskId}"`);
			if (child.parentTaskId !== proposal.identity.parentTaskId) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}", which is not a child of "${proposal.identity.parentTaskId}"`);
		}
	}
	/**
	* The root half of a consumption: the root task and the root run the
	* activation minted, and the store's one-root rule. Every check is a way the
	* record could name something other than "the root this contract became":
	*
	* - the root task must exist and be parentless (a child is not a root), and it
	*   must be the store's *only* parentless task — the store refuses a second
	*   root, so a consumption that would leave it with two is refused as the one
	*   intake that tried to mint a second root (A0 §2: one consumption, one root);
	* - it must carry the contract the proposal committed to, so "what was
	*   approved" and "what was created" are one thing rather than two;
	* - the run must exist, belong to that task, be born `active` and running, and
	*   be in the proposal's root session — a root run is the root session's own
	*   execution, so a run of another session or one already settled is not it.
	*/
	assertRootConsumptionShape(proposal, consumption) {
		const id = proposal.proposalId;
		if (consumption.kind !== "root") throw new Error(`task: proposal "${id}" consumption must declare kind "root"`);
		const raw = consumption;
		for (const field of BATCH_CONSUMPTION_FIELDS) if (raw[field] !== void 0) throw new Error(`task: proposal "${id}" consumption carries the batch field "${field}"; a root consumption names rootTaskId and rootRunId`);
		const root = consumption;
		if (!nonEmpty(root.rootTaskId)) throw new Error(`task: proposal "${id}" consumption requires a root task id`);
		if (!nonEmpty(root.rootRunId)) throw new Error(`task: proposal "${id}" consumption requires a root run id`);
		const task = this.value.tasks.find((item) => item.taskId === root.rootTaskId);
		if (task === void 0) throw new Error(`task: proposal "${id}" consumption names unknown task "${root.rootTaskId}"`);
		if (task.parentTaskId !== void 0) throw new Error(`task: proposal "${id}" consumption names task "${root.rootTaskId}", which is not a root task`);
		const rival = this.value.tasks.find((item) => item.parentTaskId === void 0 && item.taskId !== root.rootTaskId);
		if (rival !== void 0) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" but store "${this.value.id}" already holds root task "${rival.taskId}"`);
		const contract = task.contract;
		if (contract === void 0) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" without the contract the proposal committed to`);
		const digest = contractDigest(contract);
		if (digest !== proposal.identity.contractDigest) throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" whose contract digest "${digest}" is not the committed "${proposal.identity.contractDigest}"`);
		const run = this.value.runs.find((item) => item.runId === root.rootRunId);
		if (run === void 0) throw new Error(`task: proposal "${id}" consumption names unknown run "${root.rootRunId}"`);
		if (run.taskId !== root.rootTaskId) throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}", which belongs to task "${run.taskId}"`);
		if (run.sessionId !== proposal.identity.rootSessionId) throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" of session "${run.sessionId}", not the root session "${proposal.identity.rootSessionId}"`);
		if (run.status !== "running") throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" in status "${run.status}"; a root run is consumed running`);
		if (run.executionPhase !== "active") throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" with execution phase "${String(run.executionPhase)}"; a root run is born active`);
	}
	/**
	* The review context's closed shape. Its manifest fingerprint and every
	* verifier id/version/configuration are checked for the shapes that make them
	* comparable — a digest that is not a digest, or a verifier without an id,
	* would leave `reviewContextDigest` comparing values nobody can interpret —
	* and unknown fields are refused because the digest covers exactly the
	* declared surface: a field no reader understands must not move an identity.
	*/
	assertReviewContext(id, context) {
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
	transit(taskId, from, to) {
		this.assertTransition(taskId, from, to);
		this.updateTask(taskId, { status: to });
	}
	assertTransition(taskId, from, to) {
		const current = this.task(taskId);
		if (!from.includes(current.status)) throw new Error(`task: illegal transition "${current.status}" → "${to}" for task "${taskId}"`);
	}
	assertRunTransition(runId, from, to) {
		const current = this.run(runId);
		if (!from.includes(current.status)) throw new Error(`task: illegal run transition "${current.status}" → "${to}" for run "${runId}"`);
	}
	setRun(runId, status, finishedAt) {
		this.value = {
			...this.value,
			runs: this.value.runs.map((item) => item.runId === runId ? {
				...item,
				status,
				...finishedAt !== void 0 ? { finishedAt } : {}
			} : item)
		};
	}
	updateTask(taskId, patch) {
		this.value = {
			...this.value,
			tasks: this.value.tasks.map((item) => item.taskId === taskId ? {
				...item,
				...patch
			} : item)
		};
	}
	task(taskId) {
		const task = this.value.tasks.find((item) => item.taskId === taskId);
		if (task === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return task;
	}
	run(runId) {
		const run = this.value.runs.find((item) => item.runId === runId);
		if (run === void 0) throw new Error(`task: unknown run "${runId}"`);
		return run;
	}
};

//#endregion
//#region src/skill-contract.ts
/**
* The sidecar file, read as JSON, named exactly here so every producer and
* reader of a skill directory agrees on one spelling.
*/
const SKILL_SIDECAR_FILE = "SKILL.contract.json";
/**
* The sidecar contract version this build writes and reads. Like the task
* contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
* skill: a sidecar declaring a version this build does not know is refused
* rather than read with the wrong field semantics.
*/
const SKILL_CONTRACT_VERSION = 1;
/**
* The directories a skill may hold supporting files in. The supported shape is
* deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
* be described by the identity without inventing rules for directories, and an
* unsupported shape has to be refused by name rather than skipped.
*/
const SUPPORTED_SKILL_RESOURCE_DIRS = ["references", "scripts"];
/**
* Whether one declared resource path is a path this contract can identify:
* exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
* POSIX separators, no `.`/`..` segment, nothing absolute. Anything else —
* nested trees, a second segment, backslashes, a bare directory — is outside
* the supported shape and is refused by name.
*/
function isSupportedSkillResourcePath(path) {
	const segments = path.split("/");
	if (segments.length !== 2) return false;
	const [directory, file] = segments;
	if (!SUPPORTED_SKILL_RESOURCE_DIRS.includes(directory)) return false;
	return file.length > 0 && file !== "." && file !== ".." && !file.includes("\\");
}
const EXECUTION_FIELDS = [
	"contractVersion",
	"type",
	"capabilities",
	"precondition",
	"inputs",
	"outputs",
	"requiredTools",
	"verifier",
	"content"
];
const KNOWLEDGE_FIELDS = [
	"contractVersion",
	"type",
	"source",
	"scope",
	"content",
	"contentCheck"
];
const PORT_FIELDS = [
	"name",
	"description",
	"required"
];
const RESOURCE_FIELDS = ["path", "sha256"];
const VERIFIER_FIELDS = ["ref"];
const CONTENT_CHECK_FIELDS = ["kind", "command"];
const CONTENT_FIELDS = ["skillMdSha256", "resources"];
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
/** Non-blank text: the one check every string field shares, with no rewriting of the value. */
function nonBlank(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isSha256Hex(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
/** How an unexpected value reads in a refusal: JSON for scalars, a noun for containers. */
function described(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object") return "an object";
	return String(value);
}
/** What a value *is*, for the one refusal that cannot name a field (the whole sidecar). */
function kindOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}
function shape(reason) {
	return {
		code: "sidecar-shape",
		reason
	};
}
function unknownFields(value, allowed, where, carries) {
	return Object.keys(value).filter((key) => !allowed.includes(key)).sort().map((key) => ({
		code: "sidecar-unknown-field",
		reason: `${where} declares unknown field ${JSON.stringify(key)}; ${carries}`
	}));
}
/** One string list: an array of non-blank names, each once, `[]` allowed unless `minItems` says otherwise. */
function nameListDefects(value, where, missing, duplicate, minItems = 0) {
	if (!Array.isArray(value) || minItems > 0 && value.length < minItems) return [shape(missing)];
	const defects = [];
	const seen = /* @__PURE__ */ new Set();
	value.forEach((item, index) => {
		if (!nonBlank(item)) {
			defects.push(shape(`${where}[${index}] must be a non-blank string`));
			return;
		}
		if (seen.has(item)) {
			defects.push(shape(duplicate(item, index)));
			return;
		}
		seen.add(item);
	});
	return defects;
}
/** Ports: closed objects, each list naming a port once. */
function portDefects(value, where) {
	if (!Array.isArray(value)) return [shape(`${where} must be an array of ports`)];
	const defects = [];
	const seen = /* @__PURE__ */ new Set();
	value.forEach((port, index) => {
		const at = `${where}[${index}]`;
		if (!isPlainObject(port)) {
			defects.push(shape(`${at} must be an object carrying name, description, required`));
			return;
		}
		defects.push(...unknownFields(port, PORT_FIELDS, at, "a port carries name, description, required"));
		if (!nonBlank(port.name)) defects.push(shape(`${at}.name must be a non-blank string`));
		if (!nonBlank(port.description)) defects.push(shape(`${at}.description must be a non-blank string`));
		if (typeof port.required !== "boolean") defects.push(shape(`${at}.required must be a boolean`));
		if (nonBlank(port.name)) {
			if (seen.has(port.name)) defects.push(shape(`${at} duplicates port ${JSON.stringify(port.name)}`));
			seen.add(port.name);
		}
	});
	return defects;
}
/** The content identity: exact digests, a supported path vocabulary, and one sorted list. */
function contentDefects(value) {
	if (!isPlainObject(value)) return [shape("sidecar.content must be an object carrying skillMdSha256 and resources")];
	const defects = unknownFields(value, CONTENT_FIELDS, "sidecar.content", "a content identity carries skillMdSha256, resources");
	if (!isSha256Hex(value.skillMdSha256)) defects.push(shape("sidecar.content.skillMdSha256 must be a lowercase 64-character hex digest"));
	const resources = value.resources;
	if (!Array.isArray(resources)) {
		defects.push(shape("sidecar.content.resources must be an array of resource identities"));
		return defects;
	}
	const seen = /* @__PURE__ */ new Set();
	let previous;
	resources.forEach((resource, index) => {
		const at = `sidecar.content.resources[${index}]`;
		if (!isPlainObject(resource)) {
			defects.push(shape(`${at} must be an object carrying path, sha256`));
			return;
		}
		defects.push(...unknownFields(resource, RESOURCE_FIELDS, at, "a resource identity carries path, sha256"));
		if (!nonBlank(resource.path) || !isSupportedSkillResourcePath(resource.path)) defects.push(shape(`${at}.path ${described(resource.path)} is not a supported resource path (references/<file> or scripts/<file>)`));
		else if (seen.has(resource.path)) defects.push(shape(`${at} duplicates ${JSON.stringify(resource.path)}`));
		else {
			if (previous !== void 0 && resource.path < previous) defects.push(shape(`${at} path ${JSON.stringify(resource.path)} precedes ${JSON.stringify(previous)}; the list must be sorted by path`));
			seen.add(resource.path);
			previous = resource.path;
		}
		if (!isSha256Hex(resource.sha256)) defects.push(shape(`${at}.sha256 must be a lowercase 64-character hex digest`));
	});
	return defects;
}
function verifierDefects(value) {
	if (!isPlainObject(value)) return [shape("sidecar.verifier must be an object carrying a ref")];
	const defects = unknownFields(value, VERIFIER_FIELDS, "sidecar.verifier", "a verifier reference carries ref");
	if (!nonBlank(value.ref)) defects.push(shape("sidecar.verifier.ref must be a non-blank string"));
	return defects;
}
function contentCheckDefects(value) {
	if (!isPlainObject(value)) return [shape("sidecar.contentCheck must be an object carrying kind and command")];
	const defects = unknownFields(value, CONTENT_CHECK_FIELDS, "sidecar.contentCheck", "a content check carries kind, command");
	if (value.kind !== "command") defects.push(shape(`sidecar.contentCheck.kind ${described(value.kind)} is not one of command`));
	if (!nonBlank(value.command)) defects.push(shape("sidecar.contentCheck.command must be a non-blank string"));
	return defects;
}
/**
* Every reason one declared sidecar is not acceptable, in field order — never
* just the first, so one refusal names everything wrong with the declaration.
*
* Purely declaration-level: the version, the closed field set of the declared
* type, the shape of every field, and the internal consistency of the content
* identity. It reads no files, so it cannot tell whether the digests are true —
* that comparison needs the skill directory and lives in the loader. The
* returned defects are values, not throws: a caller refusing a sidecar reports
* all of them and writes nothing.
*/
function skillContractDefects(value) {
	if (!isPlainObject(value)) return [shape(`the sidecar must be a JSON object, got ${kindOf(value)}`)];
	const defects = [];
	if (value.contractVersion === void 0) defects.push({
		code: "sidecar-unknown-version",
		reason: `sidecar.contractVersion is missing; this build reads and writes version ${SKILL_CONTRACT_VERSION}`
	});
	else if (value.contractVersion !== SKILL_CONTRACT_VERSION) defects.push({
		code: "sidecar-unknown-version",
		reason: `sidecar.contractVersion ${described(value.contractVersion)} is not a version this build reads (${SKILL_CONTRACT_VERSION})`
	});
	const type = value.type;
	if (type !== "execution" && type !== "knowledge") {
		defects.push(shape(`sidecar.type ${described(type)} is not one of execution, knowledge`));
		return defects;
	}
	if (type === "execution") {
		defects.push(...unknownFields(value, EXECUTION_FIELDS, "sidecar", `an execution sidecar carries ${EXECUTION_FIELDS.join(", ")}`));
		defects.push(...nameListDefects(value.capabilities, "sidecar.capabilities", "sidecar.capabilities must be a non-empty array of capability names", (name, index) => `sidecar.capabilities[${index}] duplicates ${JSON.stringify(name)}`, 1));
		if (!nonBlank(value.precondition)) defects.push(shape("sidecar.precondition must be a non-blank string"));
		defects.push(...portDefects(value.inputs, "sidecar.inputs"));
		defects.push(...portDefects(value.outputs, "sidecar.outputs"));
		defects.push(...nameListDefects(value.requiredTools, "sidecar.requiredTools", "sidecar.requiredTools must be an array of tool names", (name, index) => `sidecar.requiredTools[${index}] duplicates ${JSON.stringify(name)}`));
		defects.push(...verifierDefects(value.verifier));
		defects.push(...contentDefects(value.content));
		return defects;
	}
	defects.push(...unknownFields(value, KNOWLEDGE_FIELDS, "sidecar", `a knowledge sidecar carries ${KNOWLEDGE_FIELDS.join(", ")}`));
	if (!nonBlank(value.source)) defects.push(shape("sidecar.source must be a non-blank string"));
	if (!nonBlank(value.scope)) defects.push(shape("sidecar.scope must be a non-blank string"));
	defects.push(...contentDefects(value.content));
	defects.push(...contentCheckDefects(value.contentCheck));
	return defects;
}
/**
* The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
* declared data, so key order and `undefined`-valued keys do not move it while
* any declared field does. Call it on a sidecar that passed
* {@link skillContractDefects}: an unvalidated object can carry fields this
* identity would then cover without a rule saying what they mean.
*/
function skillContractDigest(sidecar) {
	return sha256Hex(canonicalize(sidecar));
}
/**
* The identity of one content identity: SHA-256 over {@link canonicalize} of the
* `SKILL.md` digest and the resource list. Separate from
* {@link skillContractDigest} so a caller can name the bytes (a run recording
* what it read) without claiming a sidecar it did not read.
*/
function skillContentDigest(content) {
	return sha256Hex(canonicalize(content));
}

//#endregion
//#region src/index.ts
function assertStoreId(id) {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`task: invalid store id "${id}"`);
}
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/**
* Drop `undefined`-valued keys so an event can enter the session log, which
* accepts only lossless JSON and rejects `undefined` outright. An optional
* field carrying `undefined` and an absent optional field mean the same thing
* here; exotic values are left untouched so the log reports them itself.
*/
function compact(value) {
	if (Array.isArray(value)) return value.map((item) => compact(item));
	if (value === null || typeof value !== "object") return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const source = value;
	const target = {};
	for (const [key, item] of Object.entries(source)) if (item !== void 0) target[key] = compact(item);
	return target;
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
var TaskService = class extends Service {
	static inject = ["sessionPersistence"];
	stores = /* @__PURE__ */ new Map();
	closing = false;
	constructor(ctx) {
		super(ctx, "task");
		ctx.effect(() => () => this.close(), "task:persistence");
	}
	async createStore(storeId) {
		if (this.stores.has(storeId)) throw new Error(`task: store "${storeId}" is already open`);
		const store = this.allocate(storeId);
		store.ready = (async () => {
			try {
				if ((await this.ctx.sessionPersistence.list()).filter((item) => item.header.id === store.sessionId).length > 0) throw new Error(`task: store "${storeId}" already exists`);
				store.handle = await this.ctx.sessionPersistence.create(this.header(store.sessionId));
			} catch (error) {
				this.stores.delete(storeId);
				throw error;
			}
		})();
		await store.ready;
		return store.state.snapshot();
	}
	async openStore(storeId) {
		const existing = this.stores.get(storeId);
		if (existing !== void 0) {
			await existing.ready;
			return existing.state.snapshot();
		}
		const store = this.allocate(storeId);
		store.ready = this.open(store);
		try {
			await store.ready;
		} catch (error) {
			this.stores.delete(storeId);
			throw error;
		}
		return store.state.snapshot();
	}
	async snapshotIn(storeId) {
		const store = this.requireStore(storeId);
		await store.ready;
		return store.state.snapshot();
	}
	async taskIn(storeId, taskId) {
		const task = (await this.snapshotIn(storeId)).tasks.find((item) => item.taskId === taskId);
		if (task === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return task;
	}
	async runIn(storeId, runId) {
		const run = (await this.snapshotIn(storeId)).runs.find((item) => item.runId === runId);
		if (run === void 0) throw new Error(`task: unknown run "${runId}"`);
		return run;
	}
	async childrenIn(storeId, taskId) {
		const snapshot = await this.snapshotIn(storeId);
		const parent = snapshot.tasks.find((item) => item.taskId === taskId);
		if (parent === void 0) throw new Error(`task: unknown task "${taskId}"`);
		return parent.childTaskIds.map((childTaskId) => snapshot.tasks.find((item) => item.taskId === childTaskId));
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
		if (options.manifest !== void 0) {
			events.push(event("CapabilityResolved", {
				taskId,
				actor,
				payload: { manifest: options.manifest }
			}));
			if (options.manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId,
				actor,
				payload: { missing: options.manifest.missing }
			}));
		}
		events.push(event("TaskAdmitted", {
			taskId,
			actor,
			payload: { decompositionStatus: options.decompositionStatus ?? "leaf" }
		}));
		await this.commitIn(storeId, events);
	}
	async rejectTaskIn(storeId, taskId, actor, reason, manifest) {
		const events = [];
		if (manifest !== void 0) {
			events.push(event("CapabilityResolved", {
				taskId,
				actor,
				payload: { manifest }
			}));
			if (manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId,
				actor,
				payload: { missing: manifest.missing }
			}));
		}
		events.push(event("TaskRejected", {
			taskId,
			actor,
			payload: { reason }
		}));
		await this.commitIn(storeId, events);
	}
	async decomposeIn(storeId, parentTaskId, children, actor, edges = [], admission) {
		if (children.length === 0) throw new Error("task: decompose requires at least one child");
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
				...admission === void 0 ? {} : { admission }
			}
		}));
		await this.commitIn(storeId, events);
	}
	/**
	* The atomic batch-admission entry (A3 §1.3): every child's creation and
	* admission, the dependency edges, the parent's decomposition record, the
	* per-child capability manifests and the parent run's
	* `active → waiting_children` phase change land in one commit — a batch is
	* either fully admitted with the gate closed behind it, or not admitted at
	* all. `decomposeIn` stays as the historical entry that leaves the parent
	* run's phase untouched; this is the entry that makes admission atomic.
	*
	* `manifests` is aligned with `children` by index (the caller's own batch
	* order): a list of another length is refused before anything is written.
	*
	* `proposal` consumes the proposal this batch *is* (T2/T3 §6): the
	* `TaskProposalAdmitted` event joins the same commit, so "this proposal was
	* consumed and these are its tasks" is one durable fact. The consumption must
	* name exactly these children in this order — the batch and the record of it
	* are the same batch, checked here because this is the one place that sees
	* both — and the reducer then checks the rest of the binding (digests, batch
	* id, the proposal's status, and that no second consumption is written).
	*/
	async admitBatchIn(storeId, parentTaskId, parentRunId, children, actor, edges = [], admission, manifests, proposal) {
		if (children.length === 0) throw new Error("task: admit batch requires at least one child");
		if (manifests !== void 0 && manifests.length !== children.length) throw new Error(`task: admit batch requires one manifest per child (${children.length} children, ${manifests.length} manifests)`);
		if (proposal?.kind === "root") throw new Error(`task: admit batch cannot record the root consumption of proposal "${proposal.proposalId}"; a root contract is activated with admitRootProposalIn`);
		if (proposal !== void 0 && (proposal.childTaskIds.length !== children.length || !proposal.childTaskIds.every((childTaskId, index) => childTaskId === children[index]?.taskId))) throw new Error(`task: admit batch requires the proposal consumption to name its children in batch order (${children.length} children, ${proposal.childTaskIds.length} consumed)`);
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
				...admission === void 0 ? {} : { admission }
			}
		}));
		if (manifests !== void 0) children.forEach((child, index) => {
			const manifest = manifests[index];
			events.push(event("CapabilityResolved", {
				taskId: child.taskId,
				actor,
				payload: { manifest }
			}));
			if (manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId: child.taskId,
				actor,
				payload: { missing: manifest.missing }
			}));
		});
		events.push(event("RunPhaseChanged", {
			taskId: parentTaskId,
			runId: parentRunId,
			actor,
			payload: {
				phase: "waiting_children",
				batchId: `b-${parentTaskId}`
			}
		}));
		if (proposal !== void 0) events.push(event("TaskProposalAdmitted", {
			taskId: parentTaskId,
			actor,
			payload: proposal
		}));
		await this.commitIn(storeId, events);
	}
	/**
	* The root activation commit (A0 §1.4, §2): the root task, its run and the
	* proposal that asked for them land in **one** commit — a contract is either
	* active with its task, its run and its consumption on record, or the store is
	* untouched. There is no second entry that creates a root task, so this is the
	* only way a root comes to exist, and it always consumes a proposal: the
	* consumption names the minted task id and run id, and the reducer checks that
	* they are the store's one root task and a run born `active` in the proposal's
	* root session, carrying the contract the proposal committed to.
	*
	* Two refusals happen here, before anything is queued, because they are the
	* caller's to get right: a proposal that is not a root contract (children go
	* through `admitBatchIn`), and a consumption that does not name the task and
	* run this call creates. The store's own gate — a store that already holds a
	* root task refuses root intake (§1.6: one intake, one root, and an old
	* graph's root is history) — is re-checked by the reducer inside the commit, so
	* a racing second activation writes nothing even if it passed this read.
	*/
	async admitRootProposalIn(storeId, task, run, actor, options) {
		const store = this.requireStore(storeId);
		await store.ready;
		await store.writes;
		const snapshot = store.state.snapshot();
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
		if (options.manifest !== void 0) {
			events.push(event("CapabilityResolved", {
				taskId: task.taskId,
				actor,
				payload: { manifest: options.manifest }
			}));
			if (options.manifest.missing.length > 0) events.push(event("CapabilityGapDetected", {
				taskId: task.taskId,
				actor,
				payload: { missing: options.manifest.missing }
			}));
		}
		events.push(event("TaskStarted", {
			taskId: task.taskId,
			runId: run.runId,
			sessionId: run.sessionId,
			actor,
			payload: { run }
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
	async startRunIn(storeId, run, actor) {
		const store = this.requireStore(storeId);
		await store.ready;
		await store.writes;
		const task = store.state.snapshot().tasks.find((item) => item.taskId === run.taskId);
		const events = [];
		if (task?.status === "failed") events.push(event("TaskRetried", {
			taskId: run.taskId,
			actor,
			payload: {}
		}));
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
			default: throw new Error(`task: unknown run status "${String(status)}"`);
		}
	}
	/**
	* Records one coordination-phase change on a run (A3). The reducer is the
	* gate: only `active → waiting_children` (carrying the batch id) and
	* `active|waiting_children → submitted` (carrying the submission) apply, and
	* a refused transition commits nothing.
	*/
	async changeRunPhaseIn(storeId, taskId, runId, actor, payload) {
		await this.commitIn(storeId, [event("RunPhaseChanged", {
			taskId,
			runId,
			actor,
			payload
		})]);
	}
	/**
	* Records one no-progress marking on an active run (A3). `rounds` is the
	* caller's consecutive count; the reducer records the value it is given.
	*/
	async markRunProgressIn(storeId, taskId, runId, actor, payload) {
		await this.commitIn(storeId, [event("RunProgressMarked", {
			taskId,
			runId,
			actor,
			payload
		})]);
	}
	/**
	* Records one proposal submission (T2/T3 §6; root contracts A0 §2). The
	* immutable record, the policy it was born under, the limits in force, the
	* resolution it was reviewed against, and both context fingerprints. The
	* envelope names the proposal's subject — the parent task for a decomposition
	* batch, the reserved root marker for a root contract. The reducer is the gate:
	* a malformed record, a digest that does not describe its content, a duplicate
	* id, a request key already bound to another proposal, a root intake on a store
	* that already holds a root task — each commits nothing.
	*/
	async submitProposalIn(storeId, proposal, actor) {
		await this.commitIn(storeId, [event("TaskProposalSubmitted", {
			taskId: proposal.kind === "root" ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId,
			actor,
			payload: { proposal }
		})]);
	}
	/**
	* Records one review decision (T2/T3 §6), bound to the dossier digest and
	* both context fingerprints the reviewer was shown. An unknown proposal is
	* refused here, before the commit; every binding is checked by the reducer,
	* so a decision that does not name exactly the stored proposal applies
	* nothing.
	*/
	async decideProposalIn(storeId, claim, actor) {
		const taskId = await this.proposalEnvelopeTaskIn(storeId, claim.proposalId);
		await this.commitIn(storeId, [event("TaskProposalDecided", {
			taskId,
			actor,
			payload: claim
		})]);
	}
	/**
	* Records one runtime phase change (T2/T3 §6): to `pending_review` when the
	* deployment tightened to `all`, to `ready` when an approval passed its
	* post-approval re-check, to `stale` when that re-check failed. The status
	* table lives in the reducer; a change that is not legal from the proposal's
	* current status applies nothing.
	*/
	async changeProposalPhaseIn(storeId, change, actor) {
		const taskId = await this.proposalEnvelopeTaskIn(storeId, change.proposalId);
		await this.commitIn(storeId, [event("TaskProposalPhaseChanged", {
			taskId,
			actor,
			payload: change
		})]);
	}
	/**
	* Records one consumption on its own (T2/T3 §6): the batch the proposal
	* became, by child task id and batch id. `admitBatchIn` writes the same event
	* inside the admission commit, which is the path that keeps the children and
	* the record of them one fact; this entry exists for a caller that admitted
	* the batch through another entry and is recording the consumption beside it.
	*/
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
		if (events.length === 0) throw new Error("task: cannot commit an empty event batch");
		const store = this.requireStore(storeId);
		const run = store.writes.then(async () => {
			await store.ready;
			const next = store.state.clone();
			for (const item of events) next.apply(item);
			const records = events.map((item, index) => ({
				type: "task/event",
				seq: SessionSeq(store.nextSeq + index),
				time: Date.now(),
				data: compact(item),
				ignorable: true
			}));
			await store.handle.append(records);
			store.state = next;
			store.nextSeq += records.length;
			this.ctx.emit("task/change", store.state.snapshot());
		});
		store.writes = run.then(() => void 0, () => void 0);
		await run;
	}
	/**
	* The proposal one event names, read from the store before the commit so an
	* unknown proposal is a refusal *before* anything is queued: the reducer would
	* reject the event anyway, and a caller that asked about a proposal the store
	* does not hold deserves to hear it from the entry it called. The value is
	* advisory — the write lock is not held across it — and the reducer's own check
	* is what actually binds the record.
	*/
	async requireProposalIn(storeId, proposalId) {
		const store = this.requireStore(storeId);
		await store.ready;
		await store.writes;
		const proposal = store.state.snapshot().proposals?.byId[proposalId];
		if (proposal === void 0) throw new Error(`task: unknown proposal "${proposalId}"`);
		return proposal;
	}
	/**
	* The task id a proposal's events carry on the envelope: the parent task a
	* decomposition batch belongs to, or the reserved root marker for a root
	* contract, which has no parent to name (A0 §2). The reducer requires exactly
	* this, so a root event cannot hide behind a real task id.
	*/
	async proposalEnvelopeTaskIn(storeId, proposalId) {
		const proposal = await this.requireProposalIn(storeId, proposalId);
		return proposal.kind === "root" ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId;
	}
	requireStore(storeId) {
		if (this.closing) throw new Error("task: service is closing");
		assertStoreId(storeId);
		const store = this.stores.get(storeId);
		if (store === void 0) throw new Error(`task: store "${storeId}" is not open`);
		return store;
	}
	allocate(storeId) {
		if (this.closing) throw new Error("task: service is closing");
		assertStoreId(storeId);
		const store = {
			id: storeId,
			sessionId: SessionId(storeId),
			state: new TaskState(storeId),
			nextSeq: 0,
			ready: Promise.resolve(),
			writes: Promise.resolve()
		};
		this.stores.set(storeId, store);
		return store;
	}
	async open(store) {
		try {
			const listed = (await this.ctx.sessionPersistence.list()).filter((item) => item.header.id === store.sessionId);
			if (listed.length === 0) throw new Error(`task: store "${store.id}" does not exist`);
			if (listed.length > 1) throw new Error(`task: duplicate store session "${store.id}"`);
			store.handle = await this.ctx.sessionPersistence.open(store.sessionId, "write");
			const { events } = await store.handle.read();
			for (const item of events) {
				if (item.type !== "task/event" || item.ignorable !== true) throw new Error(`task: invalid persisted event at seq ${item.seq}`);
				const next = store.state.clone();
				next.apply(item.data);
				store.state = next;
				store.nextSeq = item.seq + 1;
			}
			await store.handle.flush();
		} catch (error) {
			await store.handle?.close();
			throw error;
		}
	}
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
	header(storeId) {
		return {
			version: SESSION_FORMAT_VERSION,
			id: storeId,
			createdAt: Date.now(),
			isSeeded: false
		};
	}
};
var src_default = TaskService;

//#endregion
export { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, ROOT_PROPOSAL_TASK_ID, RootTaskSpec, SKILL_CONTRACT_VERSION, SKILL_SIDECAR_FILE, SUPPORTED_SKILL_RESOURCE_DIRS, TASK_CONTRACT_VERSION, TASK_PROPOSAL_DECISION_OUTCOMES, TASK_PROPOSAL_ID_PREFIX, TASK_PROPOSAL_KINDS, TASK_PROPOSAL_PHASES, TASK_PROPOSAL_STATUSES, TaskService, TaskState, admissionContextDigest, canonicalize, capabilityManifestDigest, contractDigest, decompositionDigest, src_default as default, isSupportedSkillResourcePath, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, sha256Hex, skillContentDigest, skillContractDefects, skillContractDigest, taskProposalId };