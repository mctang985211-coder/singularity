import { Context, Events, Service } from "@deepseek-ai/cordis";
import { SessionEventMap, SessionEventType, SessionId } from "@deepseek-ai/dsh-session";
import { SessionHandle } from "@deepseek-ai/dsh-session-persistence";

//#region src/contract.d.ts
/** The normalized contract version this build writes. Separate from a task template's own generation number and from the event envelope's `schemaVersion` (the store's wire format): this one versions the contract data definition, and an entry … */
declare const TASK_CONTRACT_VERSION: 1;
/** Every version of {@link TaskContract} this build can write or read. */
type TaskContractVersion = typeof TASK_CONTRACT_VERSION;
/** One task's contract, in normalized form: defaults already filled, criterion ids already fixed, every array present. */
interface TaskContract {
  contractVersion: TaskContractVersion;
  /** The self-contained goal/deliverable, verbatim. */
  objective: string;
  /** At least one criterion, at least one of them mandatory; ids unique within the task. */
  acceptanceCriteria: AcceptanceCriterion[];
  /** External conditions the contract rests on; `[]` when none were declared. */
  assumptions: string[];
  /** Execution scope and limits in the caller's words; `[]` when none were declared. */
  constraints: string[];
  /** Capability *requirements* by name (never a skill id): the runtime resolves these against its registry. */
  requiredCapabilities: string[];
}
/** The limits one decomposition batch was admitted under (§4). Recorded with the batch, never derived from the contract: a contract's own text has no field that can raise a limit, and the runtime resolves every value here from its … */
interface AdmissionContext {
  /** Growth guardrail enforced at admission: a batch reaching depth `maxDepth + 1` is refused before anything is persisted. */
  maxDepth: number;
  /** Growth guardrail enforced at admission: a batch above `maxChildren` is refused before anything is persisted. */
  maxChildren: number;
  /** Effective values that are only audited after a run settled — never enforced in flight (the orchestrator can observe tool calls and tokens only once the session log is readable). */
  auditOnly: {
    maxToolCalls?: number;
    tokens?: number;
    attempts?: number;
  };
}
/** The identity of one admitted batch, recorded on the parent's decomposition event: what the batch asked for (digest) and the limits it was admitted under (context). */
interface DecompositionAdmission {
  /** {@link decompositionDigest} of the normalized batch. */
  proposalDigest: string;
  context: AdmissionContext;
}
/** One child of a decomposition proposal, reduced to what its identity covers. */
interface DecompositionChildIdentity {
  /** {@link contractDigest} of the child's normalized contract. */
  contractDigest: string;
  /** Sibling indices (0-based, in batch order) this child's run waits for; order is insignificant to execution but part of the digest. */
  dependsOn: readonly number[];
  /** Whether the child may split further; a declaration, not a permission (admission still applies every guardrail). */
  decomposable: boolean;
  /** Whether the child demands independent parent acceptance (P4 marker). */
  requiresIndependentAcceptance: boolean;
}
/** Everything a batch proposal's identity covers (§4): where it came from (store, parent task and run, caller), which contract language it is written in, why it was proposed, and the complete ordered children. */
interface DecompositionIdentity {
  contractVersion: TaskContractVersion;
  storeId: string;
  parentTaskId: string;
  parentRunId: string;
  callerSessionId: string;
  reason: string;
  children: readonly DecompositionChildIdentity[];
}
/** Object keys whose value is not `undefined`: the rule canonical identities and logged events share. */
declare function definedKeys(source: Record<string, unknown>): string[];
/** Stable serialization of contract data: object keys sorted, arrays kept in order, strings byte-for-byte, `undefined`-valued keys dropped. */
declare function canonicalize(value: unknown): string;
/** SHA-256 (lowercase hex) of raw bytes: the digest form a protected acceptance input's identity is fixed with ({@link ProtectedInputRef}), shared by the admission-time fixing and the pre-judgement re-check. */
declare function sha256Hex(bytes: Uint8Array | string): string;
/** The single-task contract identity: SHA-256 over {@link canonicalize} of the normalized contract. */
declare function contractDigest(contract: TaskContract): string;
/** The whole-batch proposal identity: SHA-256 over {@link canonicalize} of the normalized proposal. */
declare function decompositionDigest(identity: DecompositionIdentity): string;
//#endregion
//#region src/budget.d.ts
/** Approved budget extensions (K4): one durable record per approved raise of the tree's own budget. @module @dangosys/dsh-singularity-task/budget */
/** What one caller asks for: the request key it will be answered under, and the totals it wants in force. */
interface BudgetExtensionRequest {
  readonly requestKey: string;
  /** The run count asked for as the whole approved total. */
  readonly maxRuns?: number;
  /** The absolute instant asked for as the ceiling the tree stops at. */
  readonly deadlineAt?: string;
}
/** One dimension's raise as it is recorded: the ceiling in force before, and the ceiling approved now. */
interface BudgetRaise<T> {
  /** The ceiling in force when the request was read; the value the request was approved against. */
  readonly previous: T;
  /** The ceiling in force once this record stands: the whole approved total, never the difference. */
  readonly next: T;
}
/** What a request becomes once it is judged: the raise each dimension moves, and the request's own identity. This is the form a review is shown — the two numbers a person is approving — and the form a recorded extension keeps. */
interface BudgetExtensionProposal {
  readonly requestKey: string;
  /** {@link budgetExtensionRequestDigest} of the key and the totals above. */
  readonly requestDigest: string;
  readonly maxRuns?: BudgetRaise<number>;
  readonly deadlineAt?: BudgetRaise<string>;
}
/** The ceilings one request was read at: what was in force, dimension by dimension, when the runtime froze them for the question and the person decided. The reading is the *whole* ceiling, never only the dimension a request names. */
interface BudgetExtensionBaseline {
  /** The run ceiling read, or absent when the reading does not name one. */
  readonly maxRuns?: number;
  /** The deadline read, in the canonical form the resolver reports it. */
  readonly deadlineAt?: string;
}
/** One extension as it is submitted: the proposal, the whole reading the runtime froze when it asked, and whose request it is. */
interface TaskBudgetExtensionClaim extends BudgetExtensionProposal {
  readonly approvalRef: string;
  /** The root coordination session that asked — the store's own root session. */
  readonly requestedBy: string;
  /** The ceilings this request was read at — every dimension the tree bounds, not only the ones it raises. */
  readonly baseline: BudgetExtensionBaseline;
}
/** One extension as the store holds it: the accepted claim, stamped with the event's own time. */
interface TaskBudgetExtension extends TaskBudgetExtensionClaim {
  /** The moment the store recorded it, taken from the event — never from the caller. */
  readonly recordedAt: string;
}
/** The extensions a snapshot answers: all of them in the order they were recorded, and the one bound to a request key. */
interface TaskBudgetExtensionIndex {
  readonly all: readonly TaskBudgetExtension[];
  /** `requestKey` → the extension bound to it. At most one, by construction. */
  readonly byRequestKey: Readonly<Record<string, TaskBudgetExtension>>;
}
/** The closed field set of a submitted extension: an unread field must not enter the record. */
declare const BUDGET_EXTENSION_CLAIM_FIELDS: readonly string[];
/** The closed field set of a reading: a dimension nobody read must not enter a claim either. */
declare const BUDGET_EXTENSION_BASELINE_FIELDS: readonly string[];
/** The request identity: SHA-256 over the key and the totals asked for, each dimension in its canonical form (a deadline is the instant it denotes, not the spelling it was written in). */
declare function budgetExtensionRequestDigest(request: BudgetExtensionRequest): string;
/** The canonical spelling (`new Date(ms).toISOString()`) of the absolute instant a deadline value denotes, or `undefined` when it denotes none: an unreadable string, a bare local time, a duration in words. */
declare function canonicalBudgetInstant(value: unknown): string | undefined;
/** One extension's raises in one phrase, for a refusal that has to say what a request key already holds. */
declare function describeBudgetExtension(extension: BudgetExtensionProposal): string;
/** One dimension's reading in one phrase, for a refusal that has to say what a request was read at: the value it was read at, or the fact that it names the dimension nowhere. */
declare function describeBudgetReading(dimension: 'maxRuns' | 'deadlineAt', value: number | string | undefined): string;
/** The ceilings the approved extensions of `extensions` leave in force, per dimension each one moved. */
interface ApprovedBudgetCeilings {
  /** The approved run count in force, or `undefined` when the store has no extension for that dimension. */
  readonly maxRuns?: number;
  /** The approved deadline in force, or `undefined` when the store has no extension for that dimension. */
  readonly deadlineAt?: string;
}
/** Folds the store's extensions into the ceilings they leave in force: each dimension keeps the `next` of the *last* extension that moved it, and a dimension no extension names answers `undefined` — "the store has no approved ceiling here" … */
declare function approvedBudgetCeilings(extensions: readonly TaskBudgetExtension[]): ApprovedBudgetCeilings;
//#endregion
//#region src/proposal.d.ts
/** The review policy a proposal was submitted under (§5). Deployment configuration decides it; a node cannot switch it, and it is stored with the proposal because the audit has to be able to tell a batch that ran without a human review … */
type TaskProposalPolicy = 'off' | 'all';
/** What a proposal proposes (§2): a parent task's decomposition batch, or a root session's contract. */
type TaskProposalKind = 'decomposition' | 'root';
/** Every proposal kind, for validation and rendering. */
declare const TASK_PROPOSAL_KINDS: readonly TaskProposalKind[];
/** The reserved `taskId` a root proposal's events carry on the envelope. A root contract belongs to no task — the task it becomes does not exist until it is activated — so its events cannot name one, and naming a task that happens to exist … */
declare const ROOT_PROPOSAL_TASK_ID = "root-proposal";
/** Where one proposal sits in the review lifecycle (§6). Separate from `TaskStatus` on purpose — a proposal is not a task, and none of these states may be read as "the task ran". */
type TaskProposalStatus = 'ready' | 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'stale' | 'admitted' | 'expired';
/** The statuses a `TaskProposalPhaseChanged` event may write: what the runtime (as opposed to a person deciding or a batch being admitted) moves a proposal to. */
type TaskProposalPhase = 'ready' | 'pending_review' | 'stale';
/** Every proposal phase change, for validation and rendering. */
declare const TASK_PROPOSAL_PHASES: readonly TaskProposalPhase[];
/** What a decision may be. The four are kept apart because they mean different things to a reader and to the next stage: `approved` is the only one that can lead to execution, `rejected` says a reviewer refused the batch, `cancelled` says the … */
type TaskProposalDecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'expired';
/** Every decision outcome, for validation and rendering. */
declare const TASK_PROPOSAL_DECISION_OUTCOMES: readonly TaskProposalDecisionOutcome[];
/** One judging instance a batch's criteria resolved to, as the review context records it (§6): the registered verifier's id, the version it declares, and — when the deployment can name one — the fingerprint of the configuration that instance … */
interface TaskProposalVerifierIdentity {
  /** The registered verifier id a criterion of this batch resolves to. */
  verifierId: string;
  /** The version the registered instance declares, when it declares one. */
  version?: string;
  /** Fingerprint of the configuration the instance was built from, when the deployment can name one. */
  configurationDigest?: string;
}
/** What a proposal's approval actually covered (§6): the capability manifests this batch resolved, and the judging instances its criteria resolved to. */
interface TaskProposalReviewContext {
  /** {@link capabilityManifestDigest} of the manifests this batch resolved, in batch order. */
  capabilityManifestDigest: string;
  /** Every judging instance the batch's criteria resolve to. Order is not part of {@link reviewContextDigest}. */
  verifiers: TaskProposalVerifierIdentity[];
}
/** One child of a proposal's batch, in full (§5): the normalized contract a reviewer reads, plus the three declarations the batch identity digests. */
interface TaskProposalChild {
  /** The child's normalized contract (T1 §4): defaults filled, criterion ids fixed, lists present. */
  contract: TaskContract;
  /** Sibling indices (0-based, in batch order) this child's run waits for; order is insignificant to execution but part of the digest. */
  dependsOn: readonly number[];
  /** Whether the child may split further; a declaration, not a permission (admission still applies every guardrail). */
  decomposable: boolean;
  /** Whether the child demands independent parent acceptance (P4 marker). */
  requiresIndependentAcceptance: boolean;
}
/** Everything a root contract proposal's identity covers (§2): which store and which root session the contract is for, the caller's request key, and the digest of the single normalized contract stored beside it. */
interface RootProposalIdentity {
  contractVersion: TaskContractVersion;
  storeId: string;
  /** The root session this contract is the goal of; the store is its `sg-t-<rootSessionId>` store. */
  rootSessionId: string;
  /** The caller's stable request key (§6); must equal the proposal record's own. */
  requestKey: string;
  /** {@link contractDigest} of the normalized root contract stored beside it. */
  contractDigest: string;
}
/** One review decision on record (§6): what was decided, against which dossier and which contexts, by whom and when. */
interface TaskProposalDecision {
  /** What was decided. Only `approved` can lead to admission, through `approved → ready`. */
  outcome: TaskProposalDecisionOutcome;
  /** The batch identity the decision was made against; must equal the stored proposal's. */
  proposalDigest: string;
  /** The admission-context fingerprint shown with the proposal; must equal the stored one. */
  admissionContextDigest: string;
  /** The review-context fingerprint the decision was made against. Required for an approval — an approval that did not bind the resolution it reviewed is not an approval — and, when present on any other outcome, still checked against the stored … */
  reviewContextDigest?: string;
  /** Who decided: the approval channel's own identity, a session id, or the deployment for a withdrawal. Never a model-supplied reference. */
  decidedBy: string;
  /** When the decision was taken, as the writer recorded it. */
  decidedAt: string;
  /** Why, when the decider gave a reason. Required for an expiry, which must name what ended the batch. */
  reason?: string;
}
/** One consumption (§6): the record that turns a proposal into what it became. Written in the same commit as that thing, so the store can always answer "which proposal became which tasks" — and so a crash between the admission and the first … */
interface TaskProposalBatchConsumption {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'batch';
  /** The proposal being consumed. */
  proposalId: string;
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string;
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string;
  /** The parent run whose batch this is; must equal the stored identity's `parentRunId`. */
  parentRunId: RunId;
  /** The batch's id in the run coordination protocol: `b-<parentRunId>-<proposalId>` ({@link batchIdFor}). */
  batchId: string;
  /** The children this proposal became, in batch order — the ids the admission commit created. */
  childTaskIds: TaskId[];
  /** When the batch was admitted, as the writer recorded it. */
  admittedAt: string;
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string;
}
/** What a root contract was activated as (A0 §2): the root task and the root run the activation commit created, named by id. */
interface TaskProposalRootConsumption {
  kind: 'root';
  /** The proposal being consumed. */
  proposalId: string;
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string;
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string;
  /** The root task the activation minted: parentless, depth 0, carrying the approved contract. */
  rootTaskId: TaskId;
  /** The root run the activation minted: born `active`, running, in the proposal's root session. */
  rootRunId: RunId;
  /** When the contract was activated, as the writer recorded it. */
  admittedAt: string;
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string;
}
/** A consumption, of either kind; a reader narrows by `kind` before reading the ids. */
type TaskProposalConsumption = TaskProposalBatchConsumption | TaskProposalRootConsumption;
/** One submitted proposal: the batch or the root contract to run, what it was judged against, and where it stands. */
interface TaskProposalBase {
  /** The proposal's identity: `p-` plus {@link taskProposalId}'s derivation from the proposal content. */
  proposalId: string;
  /** The stable key the caller derived from its own context (§6). One key names at most one proposal: a repeated request with the same key is answered with the stored proposal, a new revision gets a new key, and the store refuses a key that is … */
  requestKey: string;
  /** The proposal this one revises (§6), when the caller is replacing a rejected or stale one. */
  supersedes?: string;
  /** Where the proposal stands. See {@link TaskProposalStatus} for the full table. */
  status: TaskProposalStatus;
  /** The review policy in force when the proposal was submitted (§5). Stored, never re-resolved: `off` is the audit record that this batch ran without a human review (`policy-off`, never a fake `human-approved`), and a later deployment change … */
  policy: TaskProposalPolicy;
  /** {@link decompositionDigest} of a decomposition identity, {@link rootProposalDigest} of a root one: the content identity an approval binds to. */
  proposalDigest: string;
  /** The limits in force when the proposal was submitted, recorded next to it, never derived from the contract. */
  admissionContext: AdmissionContext;
  /** {@link admissionContextDigest} of {@link admissionContext}. */
  admissionContextDigest: string;
  /** What the payload resolved against when it was submitted (capability manifests, judging verifiers). */
  reviewContext: TaskProposalReviewContext;
  /** {@link reviewContextDigest} of {@link reviewContext}. */
  reviewContextDigest: string;
  /** When the proposal was submitted. */
  createdAt: string;
  /** When the last lifecycle event applied to it was written; absent until one was. */
  updatedAt?: string;
  /** The decision on record, once one was made. Absent while the proposal is undecided. */
  decision?: TaskProposalDecision;
  /** What this proposal became, once it was admitted. Absent while it still might become something. */
  consumption?: TaskProposalConsumption;
}
/** One decomposition proposal (T2/T3): a parent task's children, submitted as a batch. `kind` is optional so a record written before the field existed — and a writer that has no reason to state the obvious — still reads as this arm. */
interface TaskProposalDecomposition extends TaskProposalBase {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'decomposition';
  /** The complete batch identity, {@link decompositionDigest}'d into {@link proposalDigest}. */
  identity: DecompositionIdentity;
  /** The complete batch content, one {@link TaskProposalChild} per {@link identity} child and in the same order: the goals, criteria, assumptions, constraints, capability requirements, dependencies and flags a reviewer reads and a person … */
  batch: readonly TaskProposalChild[];
}
/** One root contract proposal (A0 §2): the goal of a root session, normalized — objective, assumptions, constraints, mandatory acceptance criteria — and submitted as a single contract rather than as children. */
interface TaskProposalRoot extends TaskProposalBase {
  kind: 'root';
  /** The root contract's identity: {@link rootProposalDigest}'d into {@link proposalDigest}. */
  identity: RootProposalIdentity;
  /** The single normalized root contract this proposal asks to run (the content an approval covers and a reviewer reads, stored whole for the same reasons a batch is). */
  contract: TaskContract;
}
/** One submitted proposal, either kind. A reader must narrow by `kind` before touching the payload — that is the whole point of the union: `batch` and `contract` are alternatives, and neither exists on the other arm. */
type TaskProposal = TaskProposalDecomposition | TaskProposalRoot;
/** What a decision states when it is written (the payload of `TaskProposalDecided`): {@link TaskProposalDecision} plus the proposal it is about. The reducer checks every field against the stored proposal before the record is applied. */
interface TaskProposalDecisionClaim extends TaskProposalDecision {
  /** The proposal this decision is about. */
  proposalId: string;
}
/** One runtime-driven phase change (the payload of `TaskProposalPhaseChanged`): a proposal sent to review because the deployment tightened to `all`, an approval whose re-check passed (`approved → ready`, §6's "批准已落账、等待重检/准入"), or one whose … */
interface TaskProposalPhaseChange {
  /** The proposal being moved. */
  proposalId: string;
  /** Where it moves to; see {@link TaskProposalPhase} and {@link TaskProposalStatus} for the legal sources. */
  to: TaskProposalPhase;
  /** Why the runtime moved it. Required for `stale` — an invalidation has to name what changed. */
  reason?: string;
}
/** The proposal queries a snapshot answers (§6/§7): by id, by the request key a caller derived, and by parent task — the three questions a runtime asks when it decides whether to submit, decide, or resume a batch. */
interface TaskProposalIndex {
  /** Every proposal the store holds, in submission order. */
  readonly all: readonly TaskProposal[];
  /** `proposalId` → the proposal. */
  readonly byId: Readonly<Record<string, TaskProposal>>;
  /** `requestKey` → the proposal bound to it. At most one, by construction. */
  readonly byRequestKey: Readonly<Record<string, TaskProposal>>;
  /** `parentTaskId` → that task's proposals, in submission order. A root contract is in no entry here. */
  readonly byParentTask: Readonly<Record<string, readonly TaskProposal[]>>;
}
/** The proposal id one batch identity gets: `p-` plus {@link decompositionDigest} of the identity. */
declare function taskProposalId(identity: DecompositionIdentity): string;
/** The id one admitted batch carries in the run coordination protocol: `b-<parentRunId>-<proposalId>`. */
declare function batchIdFor(parentRunId: RunId, proposalId: string): string;
/** The root contract's identity: SHA-256 over {@link canonicalize} of {@link RootProposalIdentity} — which store, which root session, which request key, and the digest of the normalized root contract. */
declare function rootProposalDigest(identity: RootProposalIdentity): string;
/** The proposal id one root contract identity gets: `p-` plus {@link rootProposalDigest} of the identity. */
declare function rootProposalId(identity: RootProposalIdentity): string;
/** The identity of the limits a batch was admitted under: SHA-256 over {@link canonicalize} of the {@link AdmissionContext}. */
declare function admissionContextDigest(context: AdmissionContext): string;
/** The identity of what a batch resolved against: SHA-256 over {@link canonicalize} of every manifest the batch resolved, **in batch order** — the order the children were proposed in, so two resolutions of the same batch that assigned the … */
declare function capabilityManifestDigest(manifests: readonly CapabilityManifest[]): string;
/** The identity of the resolution a proposal was reviewed against: SHA-256 over {@link canonicalize} of the {@link TaskProposalReviewContext} with its verifier list normalized to ascending `(verifierId, version, configurationDigest)`. */
declare function reviewContextDigest(context: TaskProposalReviewContext): string;
//#endregion
//#region src/question.d.ts
/** A citation into the Session that sent a question or an answer: which Session, and which seq in its log. */
interface QuestionMessageRef {
  /** The sending run's Session — the Session the cited `tool/call` event lives in. */
  sessionId: string;
  /** The seq of that `tool/call` event in the sending Session's log. */
  seq: number;
}
/** What a caller states when asking (the payload of `QuestionAsked`, minus what the store derives and stamps): which run asks, the key that makes the request stable, the content digest of the question, the citation of the body, the message … */
interface QuestionAsk {
  /** The run asking; its task's direct parent is the addressee. */
  childRunId: RunId;
  /** The caller's stable request key (§F.1); one key per question, and re-sends repeat it. */
  requestKey: string;
  /** SHA-256 of the question body as the sender wrote it — the content identity used for idempotency, never the body itself. */
  questionDigest: string;
  /** Where the question's body is: the child session's own `tool/call` event. */
  questionRef: QuestionMessageRef;
  /** The delivery identity the message carries into the parent's Session (agent-runtime's handle; the store records it so a retry re-delivers the same message). */
  messageId: string;
  /** Whether an answer is required before the asking run may continue. */
  blocking: boolean;
}
/** What a caller states when answering (the payload of `QuestionAnswered`, minus what the store derives and stamps). */
interface QuestionAnswer {
  /** The question being answered. */
  questionId: string;
  /** The answering run; must equal the question record's parent run. */
  parentRunId: RunId;
  /** The caller's stable request key for this answer; several keys may answer one open question. */
  requestKey: string;
  /** SHA-256 of the answer body as the sender wrote it — content identity for idempotency, never the body itself. */
  answerDigest: string;
  /** The parent's declaration that the question is answered (true) or still open (false). Never a classification and never an authorization. */
  resolves: boolean;
  /** Where the answer's body is: the parent session's own `tool/call` event. */
  answerRef: QuestionMessageRef;
  /** The delivery identity the answer carries into the child's Session. */
  messageId: string;
}
/** One stored question: the ask as it was written, plus the id it derives from, the parent run it was addressed to, the time the store recorded it, and the answers that have arrived. */
interface QuestionRecord extends QuestionAsk {
  /** `q-` plus {@link questionIdOf}'s derivation from the run and the key. */
  questionId: string;
  /** The run the question is addressed to: the parent task's current run when the question was recorded. */
  parentRunId: RunId;
  /** When the ask was recorded, as the writer stated it. */
  askedAt: string;
  /** The answers recorded so far, in application order; absent until the first one. */
  answers?: readonly QuestionAnswerRecord[];
}
/** One stored answer: the claim as it was written, plus the id it derives from and the time it was recorded. */
interface QuestionAnswerRecord extends QuestionAnswer {
  /** `a-` plus {@link answerIdOf}'s derivation from the question and the key. */
  answerId: string;
  /** When the answer was recorded, as the writer stated it. */
  answeredAt: string;
}
/** The questions a snapshot holds, indexed by the one question a reader asks ("what does this run wait on?" is a filter, but "what was this id?" is not): every question in ask order, and by id. */
interface TaskQuestionIndex {
  /** Every question the store holds, in ask order. */
  readonly all: readonly QuestionRecord[];
  /** `questionId` → the question, answers included. */
  readonly byId: Readonly<Record<string, QuestionRecord>>;
}
/** What an ask returns: the stored record, and whether this call is the one that recorded it. */
interface QuestionAskResult {
  readonly question: QuestionRecord;
  readonly created: boolean;
}
/** What an answer returns: the stored record, and whether this call is the one that recorded it. */
interface QuestionAnswerResult {
  readonly answer: QuestionAnswerRecord;
  readonly created: boolean;
}
/** The identity a question id is derived from. Exactly these two fields: the asking run keeps two tasks' identical keys apart, and the key keeps two questions of one run apart, so a retry addresses the question it means. */
interface QuestionIdentity {
  childRunId: RunId;
  requestKey: string;
}
/** The identity an answer id is derived from: the question and the answering caller's key. The question already covers its asking run and its own key. */
interface QuestionAnswerIdentity {
  questionId: string;
  requestKey: string;
}
/** The question id one (run, key) pair gets: `q-` plus SHA-256 over {@link canonicalize} of {@link QuestionIdentity}. */
declare function questionIdOf(identity: QuestionIdentity): string;
/** The answer id one (question, key) pair gets: `a-` plus SHA-256 over {@link canonicalize} of {@link QuestionAnswerIdentity}. */
declare function answerIdOf(identity: QuestionAnswerIdentity): string;
/** The question one id names, or `undefined` when the store holds none. A snapshot without a question index is refused rather than read as empty: a snapshot built by this build's reducer always carries the index (empty members included), so … */
declare function questionOf(snapshot: TaskSnapshot, questionId: string): QuestionRecord | undefined;
/** The questions one run asked that are still open, in ask order. Open means both halves: no answer has resolved it, and both runs are still running — the parent has to be able to answer, and a settled run is never blocked by anything again. */
declare function openQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[];
/** The open questions whose answers block the asking run — the derivation the write gate and the display read. `blocking: false` is a real question that is expected to be delivered and answered; it just never stops the run. */
declare function blockingQuestionsOf(snapshot: TaskSnapshot, childRunId: RunId): QuestionRecord[];
/** The questions one parent run has been asked and has not resolved, in ask order — the parent-side pending list (§7.3: an unanswered question and an unread answer both keep their reference until the model has actually seen them). */
declare function questionsAwaitingAnswerOf(snapshot: TaskSnapshot, parentRunId: RunId): QuestionRecord[];
//#endregion
//#region src/types.d.ts
type TaskId = string;
type RunId = string;
interface ArtifactRef {
  artifactId: string;
  kind: string;
  uri: string;
  digest?: string;
}
type VerificationMode = 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite';
interface AcceptanceCriterion {
  criterionId: string;
  description: string;
  verificationMode: VerificationMode;
  requiredEvidence: string[];
  mandatory: boolean;
  command?: string;
  /** Artifact or evidence references (kinds or ids) that must exist in the task store before this criterion can be judged at all (KISS §5.1 `requires_artifact`): an ordering constraint declared as an evidence dependency, not a sequence step. */
  requiresArtifact?: string[];
  /** Artifact or evidence references (kinds or ids) this criterion consumes as a **raw input** (KISS §5.1): existence in the task store is the whole requirement — any run state, verified or not. */
  acceptsArtifact?: string[];
  /** The registered verifier id that judges this criterion (KISS §4.1 `verifier_ref`). Absent keeps the current behavior: dispatch by `verificationMode` to whichever registered verifier supports it. */
  verifierRef?: string;
  /** The parent-level evidence map (KISS §6 C2, minimal mechanical version): which child of this task — by position in its decomposition batch, the same index vocabulary `dependsOn` uses — this criterion rests on, optionally narrowed to one of … */
  childEvidence?: ChildEvidenceRef[];
  /** Marks this criterion's judgement as **heuristic** (KISS §5.1): the verdict is explicitly labeled as such wherever it is reported, and it is never counted as a deterministic pass — a natural-language coverage signal can inform a reader but … */
  heuristic?: boolean;
  /** The acceptance inputs this criterion's verdict rests on that the executing side must not modify (S1-V slice 2): acceptance scripts, threshold files, fixtures. */
  protectedInputs?: ProtectedInputRef[];
}
/** One protected acceptance input ({@link AcceptanceCriterion.protectedInputs}): the path as declared, plus the SHA-256 of the file's bytes fixed when the task was admitted. */
interface ProtectedInputRef {
  /** The input path as declared, resolved against the run's checkout directory. */
  path: string;
  /** SHA-256 (lowercase hex) of the file's bytes at admission. */
  sha256: string;
}
/** One entry of a parent criterion's evidence map ({@link AcceptanceCriterion.childEvidence}): a member of the parent run's admitted batches, named by its stable position in that run's accumulation — the only child identity that exists when … */
interface ChildEvidenceRef {
  /** Position of the member in the parent run's accumulated batch members (0-based, admission order). */
  childIndex: number;
  /** The child criterion whose passing verdict is required; absent requires only the child's verified state. */
  criterionId?: string;
  /** The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence; absent requires only the child's evidence. */
  evidenceRef?: string;
}
type TaskStatus = 'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled';
type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed';
interface TaskInstance {
  taskId: TaskId;
  definitionRef: {
    taskType: string;
    version: number;
  };
  parentTaskId?: TaskId;
  /** The task's goal: the projection of {@link contract} (or, on a task created before the contract existed, the whole of what the store holds). */
  objective: string;
  depth: number;
  /** The criteria the verifier judges: the projection of {@link contract}, checked for disagreement on write. */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Capability requirements by name: the projection of {@link TaskContract.requiredCapabilities}. */
  requestedCapabilities: string[];
  /** Where the task sits in the decomposition tree; `decomposed` is written when the task registers children. */
  decompositionStatus: DecompositionStatus;
  status: TaskStatus;
  runIds: RunId[];
  childTaskIds: TaskId[];
  /** The normalized contract this instance was created from (T1, construction guide §4): defaults filled, criterion ids fixed, assumptions and constraints persisted rather than left in a spawn prompt. */
  contract?: TaskContract;
  /** Contract-level marker (KISS §6 C2): this task's acceptance must be decided by its own criteria and evidence map, never by the composite "all children verified" conjunction alone. */
  requiresIndependentAcceptance?: boolean;
}
interface DependencyEdge {
  from: TaskId;
  to: TaskId;
}
/** DFS over an edge list: true when `target` is reachable from `start`. */
declare function reaches(edges: readonly DependencyEdge[], start: TaskId, target: TaskId): boolean;
type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled';
/** The run statuses that end a run: no transition out of these resumes it (guide §4.2 G3 — blocked is a dead end). */
declare const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus>;
/** Whether `status` is terminal ({@link TERMINAL_RUN_STATUSES}). */
declare function isTerminalRunStatus(status: RunStatus): boolean;
/** One skill a run's grant was built from, as the admission-time provider pre-check judged it (S1-C item 4). */
interface RunSkillBinding {
  /** The skill name a capability granted; the snapshot directory is named after it. */
  name: string;
  /** How the pre-check accepted it — execution provider, loadable knowledge, or plain guidance. */
  role: 'execution-provider' | 'knowledge' | 'guidance';
  /** The run's capability rows that grant this skill, sorted: the capability names a worker's summary groups its providers under, read from the record rather than re-derived from the store. */
  capabilities: string[];
  /** The purpose the skill declares for itself, so a summary can say what the provider is for without reading its body. */
  description: string;
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null;
  /** `skillContentDigest` of the bytes the run loaded. */
  contentDigest: string;
  /** Entries of the source skill directory the identity does not cover (a guidance skill's extra files, a directory reads as `name/`). */
  uncovered: string[];
}
/** One MCP server a run's manifest granted: the registry key it resolved through and the identity of the template it resolved to. */
interface RunMcpServerBinding {
  /** The server name the capability declared and the worker's tools are namespaced under. */
  serverName: string;
  /** SHA-256 over the registry template the name resolved to, or `null` when the registry holds no such name. Diagnostic (see the interface note): never an execution identity. */
  templateDigest: string | null;
}
/** What one run resolved against and loaded (S1-C item 4): the registry revision the admission-time pre-check computed, the identity of every skill the run's grant was built from, the MCP servers its manifest granted, and — when the run … */
interface RunProviderBinding {
  /** The registry revision the admission-time provider pre-check computed for this run's table and accepted providers (`provider-precheck.ts:registryRevision`): two runs citing the same revision resolved the same rows over the same declared … */
  registryRevision: string;
  /** Every capability row this run's manifest matched, sorted — including a row that grants no skill (its tools are granted without a provider). */
  capabilities: string[];
  /** One entry per skill the run's grant was built from, sorted by name. A skill two capabilities declare appears once, naming both. */
  skills: RunSkillBinding[];
  /** The MCP servers the run's manifest granted, in first-declaration order. */
  mcpServers: RunMcpServerBinding[];
  /** Absolute path of this run's snapshot skill root — the directory whose `<name>/SKILL.md` entries the worker's skill layer registers — present exactly when the run materialized the content it was bound to. */
  snapshotRoot?: string;
}
/** Where one run sits in the A3 coordination protocol. `active` is the phase a run is born in, and the only one in which it may write, decompose or submit; `waiting_children` is a run whose decomposition batch was admitted atomically and … */
type ExecutionPhase = 'active' | 'waiting_children' | 'submitted';
/** What one run handed in when it submitted (A3 `task_submit_result`): the submitter's own account plus the references it names as proof. */
interface SubmissionRecord {
  /** What was delivered, in the submitter's words (the runtime writes it for a workerless criteria replay). */
  summary: string;
  /** The evidence ids, artifact refs, or review refs the submitter names as proof. */
  evidenceRefs: string[];
  /** Anything further a reader should know; absent when the submitter left none. */
  notes?: string;
  /** When the submission was recorded — the phase-change event's own timestamp. */
  submittedAt: string;
  /** Who submitted: the run's own agent through its explicit call, or the runtime recording a workerless criteria replay. */
  origin: 'worker' | 'runtime';
}
/** One no-progress marking on an `active` run (A3 `RunProgressMarked`): the observable record that a worker went idle where a submission was due. */
interface NoProgressRecord {
  /** The only kind A3 writes. */
  kind: 'unsubmitted-idle';
  /** Consecutive no-progress rounds the caller observed; a positive integer, recorded as given. */
  rounds: number;
  /** The run subtree's fact count at marking time — the snapshot-derivable progress measure (A3 §3.5). */
  factCount: number;
  /** When the marking was recorded — the event's own timestamp. */
  markedAt: string;
}
/** One batch a run admitted, as the run's snapshot projects it: the batch id {@link batchIdFor} derives, the proposal it consumed, and the member task ids that admission created, in batch order. */
interface TaskRunBatch {
  /** The batch id: {@link batchIdFor} of this run and this proposal. */
  batchId: string;
  /** The proposal this batch consumed; the content identity its members were admitted under. */
  proposalId: string;
  /** The member task ids this batch created, in batch order. */
  memberTaskIds: TaskId[];
}
/** One member slot of a recovery attempt's run that is filled by an **already verified sibling** instead of by a task this run admitted (A6, plan §F.4). */
interface RunMemberReuse {
  /** The absolute position in this run's member sequence the entry claims — the `childIndex` a parent criterion's `childEvidence` map names. */
  childIndex: number;
  /** The already verified sibling task the slot reads as: a child task of this run's own task. */
  taskId: TaskId;
  /** The sibling's own verified run — the one whose evidence is cited. Its task is {@link taskId} and it is `verified` in this store. */
  sourceRunId: RunId;
  /** The evidence bundle under {@link sourceRunId} the citation rests on. */
  evidenceId: string;
  /** The criterion the sibling must have passed when the original acceptance map narrows this position to one: the cited bundle must carry a `pass` verdict for it and the sibling must declare it. Absent when the map names only the position. */
  criterionId?: string;
  /** Artifacts the citation names, by artifact id or kind, all present in the cited bundle. */
  artifactRefs: string[];
  /** Input references the citation names, from the sibling's own declared input vocabulary (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`). Empty when the citation rests on the run/evidence/product identity alone. */
  inputRefs: string[];
}
/** The recovery attempt a run **is** (A6, plan §F.4): a failed root task's new attempt, opened by the runtime's recovery entry in the same store, with the diagnosis and request that asked for it and the sibling evidence it reads instead of … */
interface RunRecovery {
  /** The diagnosis the attempt was requested for: the id of a `Diagnosis` record this store holds for this task. */
  sourceDiagnosisId: string;
  /** The caller's request key. One key names one attempt of one diagnosis, and the same key answers with the same run. */
  requestKey: string;
  /** The failed run the source task's previous attempt was, when it had one. A task that failed without a run (a rejected admission, a blocked task) names none, and nothing is invented for it. */
  sourceRunId?: RunId;
  /** When the attempt was opened. */
  requestedAt: string;
  /** The identity of the **request** this attempt answers: the source run it names and the citations its caller declared, over their canonical form (`requestAttemptDigest`). */
  requestDigest?: string;
  /** The already verified siblings this attempt reads, by the positions they claim. Empty when it re-runs everything. */
  reusedMembers: RunMemberReuse[];
  /** The positions of the failed run that read a **passed sibling the attempt could not bind**, with the reasons it could not: an unresolved evidence, product or input identity, or a criterion the original acceptance map narrows the position to … */
  unboundMembers?: RunMemberReuseRefusal[];
}
/** One position of a failed run the attempt did not bind, and why (see {@link RunRecovery.unboundMembers}). */
interface RunMemberReuseRefusal {
  /** The position in the run's member sequence the failed run read the member at. */
  childIndex: number;
  /** The passed sibling the failed run read there, when it read one. */
  taskId?: TaskId;
  /** The criterion the original acceptance map narrows that position to, when it names one. */
  criterionId?: string;
  /** Every reason the sibling's evidence could not be bound to this position, each naming the identity that did not resolve. */
  reasons: string[];
}
interface TaskRun {
  runId: RunId;
  taskId: TaskId;
  sessionId: string;
  parentRunId?: RunId;
  capabilitySnapshot: string[];
  agentPreset?: string;
  /** What this run was bound to and loaded (S1-C item 4). Absent on every run created before the field existed, and on a run whose caller assembled its plan without an admission-time pre-check: neither loaded content this build can vouch for … */
  providerBinding?: RunProviderBinding;
  /** Where this run sits in the A3 coordination protocol. A new run is born `active`, or `submitted` when it has no worker at all (a `spawn: false` replay). */
  executionPhase?: ExecutionPhase;
  /** The batch this run is waiting on: the one still open, the id {@link batchIdFor} derives from this run and the proposal it consumed. */
  batchId?: string;
  /** Every batch this run admitted, in admission order, with the member task ids each created — the run's accumulative membership. */
  batches?: TaskRunBatch[];
  /** The recovery attempt this run *is* (A6). Absent on every run that is not one: a first attempt, a child, a replay — an ordinary run is not a recovery of anything, and nothing is inferred for it. */
  recovery?: RunRecovery;
  /** What this run handed in, written by the transition into `submitted`. Absent on a run that has not submitted; its presence is what makes a second submission a refusal rather than an overwrite. */
  submission?: SubmissionRecord;
  /** The A3 question-id mount point, kept readable and never written again (A4): the store's question records are the one durable source of what a run waits on, and a second index that could disagree with them is what A4 took out of the write … */
  pendingQuestionIds?: string[];
  /** The A3 blocking-question mount point, kept readable and never written again; see {@link pendingQuestionIds}. */
  blockingQuestionIds?: string[];
  /** The last no-progress marking on this run (A3). Overwritten by each `RunProgressMarked`; absent until a caller marks one, and on every run written before the field existed. */
  noProgress?: NoProgressRecord;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}
/** The member **slots** one run reads, in the sequence a parent criterion's `childIndex` names: the verified siblings its {@link TaskRun.recovery} claims at the positions they name, and the `memberTaskIds` of its batches — in admission order … */
declare function runMemberSlots(run: TaskRun): (TaskId | undefined)[];
/** The member task ids one run reads, in slot order, with the slots it has not filled left out: what a reader that needs *which* tasks are members — not where each one sits — asks for. */
declare function runMemberTaskIds(run: TaskRun): TaskId[];
interface VerificationResult {
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  /** The version of the registered verifier instance that produced this verdict (S1-V slice 2, KISS §8.2): stamped by the verifier registry from the instance it actually dispatched to — never from the criterion's own text or from the verifier's … */
  verifierVersion?: string;
  command?: string;
  exitCode?: number;
  logRef?: string;
  details?: string;
  /** Which side an `inconclusive` verdict belongs to (KISS §4.3's UNKNOWN split): `task` when the check never ran (timeout, the command never started) — the criterion was never tested; `verifier` when the judge itself is broken (the verifier … */
  unknownKind?: 'task' | 'verifier';
}
interface EvidenceClaim {
  claimId: string;
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  /** Copied from the {@link VerificationResult} this claim rests on: the registered instance's version, the second half of the `(verifierRef, version)` index key (KISS §8.2). */
  verifierVersion?: string;
  artifactRefs: string[];
  details?: string;
  /** Copied from the {@link VerificationResult} this claim rests on; see that field. */
  unknownKind?: 'task' | 'verifier';
}
interface EvidenceBundle {
  evidenceId: string;
  taskRunId: RunId;
  taskId: TaskId;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  claims: EvidenceClaim[];
  generatedAt: string;
}
interface TaskHandoff {
  handoffId: string;
  parentTaskId: TaskId;
  parentRunId: RunId;
  childTaskId: TaskId;
  parentObjective: string;
  reasonForDelegation: string;
  constraints: string[];
  decisions: string[];
  relevantArtifacts: ArtifactRef[];
  relevantEvidence: string[];
  assumptions: string[];
  openQuestions: string[];
  parentSessionRef?: string;
  createdAt: string;
}
interface CapabilityManifest {
  capabilities: Record<string, {
    skills: string[];
    /** Real DSH tool names the capability grants: labels are expanded when the manifest is resolved. */
    tools: string[];
    preset?: string;
    permission?: string;
    /** MCP server names the capability grants, resolved against the task runtime's server registry at admission and mounted per worker at spawn (`mcp__<server>__<tool>` on the worker's own tool layer). Absent = none. */
    mcpServers?: string[];
  }>;
  missing: string[];
  closure: 'closed' | 'partial' | 'gap';
}
/** The terminal outcome one run (or a child blocked before its run ever started) settled in. */
type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked';
/** One criterion's verdict as the verifier reported it, copied onto the review record so a reader sees what was checked — command and exit code included — without replaying the run or opening the evidence bundle. */
interface ReviewCriterion {
  criterionId: string;
  /** The verifier's verdict for this criterion. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** The registered verifier that decided the verdict, copied from the verifier result. */
  verifierId?: string;
  /** The deciding instance's version, copied from the verifier result (S1-V slice 2); absent when it declared none or the record predates the field. */
  verifierVersion?: string;
  /** The command that was run, from the verifier result or the criterion itself, when the mode runs one. */
  command?: string;
  /** The command's exit code, when the verifier reported one. */
  exitCode?: number;
  /** Log path relative to the verifier evidence root, when the verifier wrote one. */
  logRef?: string;
  /** Which side an inconclusive verdict belongs to, copied from the verifier result so a review reader (and the E3 escalation signal) can tell "the check never ran" (`task`) from "the judge is broken" (`verifier`) without reopening the evidence … */
  unknownKind?: 'task' | 'verifier';
}
/** One dependency whose outcome kept a blocked task from ever starting a run. */
interface ReviewBlocker {
  taskId: TaskId;
  /** The dependency's task status at the moment this task settled blocked. */
  outcome: TaskStatus;
}
/** The four token buckets a session's `tokenUsage` projection reports, copied verbatim from that projection's wire view (upstream `llm/token-meter/src/usage-projection.ts:117-150`). */
interface ReviewTokenUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
/** One tool name a session log shows being called, with how many times. */
interface ReviewToolCall {
  name: string;
  /** `tool/call` events naming this tool in the session. */
  count: number;
}
/** Dimension 1, outcome correctness: the terminal status the run settled in and what the verifier said per criterion. */
interface OutcomeCorrectnessFacts {
  outcome: ReviewOutcome;
  /** Criteria the record carries a verdict for; 0 when the verifier never reported. */
  criteriaCount: number;
  /** Ids of the criteria whose verdict was not `pass`. */
  unmetCriterionIds: string[];
}
/** Dimension 2, task specification quality: how much specification the task carried, as counts. Purely mechanical — a thin specification is a fact here, not a verdict. */
interface TaskSpecificationFacts {
  /** Whether the objective has non-whitespace content. */
  objectivePresent: boolean;
  /** The task's acceptance criteria count. */
  criteriaCount: number;
  /** How many of them declare a `command`. */
  criteriaWithCommand: number;
}
/** One criterion's declaration shape, as authored on the task (not the verifier's verdict). */
interface AcceptanceCriterionShape {
  criterionId: string;
  mode: VerificationMode;
  /** Whether the criterion declares a `command` to run. */
  hasCommand: boolean;
  mandatory: boolean;
}
/** Dimension 3, acceptance quality: each criterion's declared verification mode and whether it hands the verifier a command. Limitation: mode and command presence are the only mechanically observed facts here. */
interface AcceptanceFacts {
  criteria: AcceptanceCriterionShape[];
}
/** Dimension 4, decomposition quality: the position and shape of this task in the decomposition tree at review time. Limitation: shape only. */
interface DecompositionFacts {
  depth: number;
  decompositionStatus: DecompositionStatus;
  childCount: number;
  /** Dependency edges whose target is this task (must verify before it starts). */
  incomingEdges: number;
  /** Dependency edges whose source is this task (it must verify before they start). */
  outgoingEdges: number;
}
/** Dimension 5, capability coverage: what the task's resolved manifest granted and what it could not resolve. Limitation: this is the admission-time resolution, not a claim that the granted capability was the *right* one for the work. */
interface CapabilityCoverageFacts {
  /** The manifest's closure verdict: `closed` when nothing required was missing. */
  closure: CapabilityManifest['closure'];
  /** Flattened skills+tools of the resolved manifest — exactly the list a run records in its `capabilitySnapshot`. */
  granted: string[];
  /** Required capability names the registry could not grant. */
  missing: string[];
}
/** Dimension 6, skill fit: skills the run's capabilities granted against skills the session's log shows the `skill` tool actually loading. */
interface SkillFitFacts {
  /** Skill names the run's capabilities granted. */
  granted: string[];
  /** Skill names the session's `skill` calls loaded, deduplicated and sorted; absent when no log was readable. */
  loaded?: string[];
  /** Loaded skill names outside `granted`; empty means every load was covered by the grant. */
  loadedOutsideGrant?: string[];
}
/** Dimension 7, tool fit: tools the run's capabilities granted (plus the worker baseline) against tools the session's log shows being called. */
interface ToolFitFacts {
  /** Real DSH tool names the run's capabilities granted (labels expanded at admission). */
  granted: string[];
  /** Tool names the session shows being called, with counts; absent when no log was readable. */
  called?: ReviewToolCall[];
  /** Called names outside `granted` ∪ `workerBaseline()`; empty means every call was covered. */
  calledOutsideGrant?: string[];
}
/** Dimension 8, context efficiency: only numbers that can be read reliably, and nothing that rates them. */
interface ContextEfficiencyFacts {
  /** Whole-session token buckets; the same value {@link ReviewMetrics.tokens} carries. */
  tokens?: ReviewTokenUsage;
  /** `compaction/start` events observed in the session log. */
  compactions?: number;
}
/** The eight review dimensions (§2.7.3), each carrying mechanically observed facts — never a score, never an LLM judgement, never transcript text. Every member is optional and is omitted, not defaulted, when the data behind it does not exist. */
interface ReviewDimensions {
  outcomeCorrectness?: OutcomeCorrectnessFacts;
  taskSpecification?: TaskSpecificationFacts;
  acceptance?: AcceptanceFacts;
  decomposition?: DecompositionFacts;
  capabilityCoverage?: CapabilityCoverageFacts;
  skillFit?: SkillFitFacts;
  toolFit?: ToolFitFacts;
  contextEfficiency?: ContextEfficiencyFacts;
}
/** Call and failure totals over one session's tool traffic. */
interface ReviewToolCallTotals {
  /** `tool/call` events in the session log. */
  calls: number;
  /** `tool/result` events whose payload reports a failure. */
  failures: number;
}
/** The six engineering-effort indicators, as counters. Every member is optional and is omitted rather than filled with a placeholder when its source is unavailable. */
interface ReviewMetrics {
  /** Provider-reported, whole-session token buckets from the session's `tokenUsage` projection. */
  tokens?: ReviewTokenUsage;
  /** Session tool traffic; absent when no session log was readable. */
  toolCalls?: ReviewToolCallTotals;
  /** Count of human-intervention events in the session log: `approval/asked` plus calls to `hitl_ask` / `hitl_approve` / `ask_user_question`. */
  humanInterventions?: number;
  /** `TaskStarted` count minus one for this task (`TaskInstance.runIds.length - 1`). Limitation: the current orchestrator has no retry branch, so this is structurally always 0 — a reader must not conclude "it was tried again and did not need to … */
  retries?: number;
  /** Criteria on this record that carry a `logRef` — where the evidence for a verdict was written. */
  evidenceLogs?: number;
}
/** One lightweight terminal record per run, written exactly once when the run reaches its terminal state. No scoring and no judge — a human reads it. */
interface ReviewRecord {
  taskId: TaskId;
  /** Absent when the task was blocked before any run started. */
  runId?: RunId;
  /** Absent when no run/session was ever bound to the task. */
  sessionId?: string;
  outcome: ReviewOutcome;
  /** Evidence ids recorded under this run, taken from the store at terminal time. */
  evidenceRefs: string[];
  /** Notable facts; for `blocked`, the text naming the dependency that did not verify. */
  anomalies: string[];
  /** Failed outcomes only: the same reason text the terminal status event carries. */
  localizedCause?: string;
  /** The tasks this run related to (a child's dependencies; a parent's children). */
  relatedTaskIds?: TaskId[];
  /** Wall-clock duration of the run from start to its terminal transition, in milliseconds. Absent when no run started. */
  durationMs?: number;
  /** Per-criterion verdicts from the run's verification bundle; absent when the verifier never ran. */
  criteria?: ReviewCriterion[];
  /** Failed outcomes only: tail excerpt of a failing criterion's log (bounded, see verifier logTail), so a review reads without a replay. */
  logTail?: string;
  /** Blocked outcomes only: the dependencies whose outcomes kept this task from running. */
  blockedBy?: ReviewBlocker[];
  /** Mechanically observed facts per review dimension; absent when none could be derived. */
  dimensions?: ReviewDimensions;
  /** Engineering-effort counters; absent when none could be collected. See {@link ReviewMetrics}. */
  metrics?: ReviewMetrics;
}
/** How sure the diagnoser is of its localized cause. Coarse on purpose (§2.7.3: Review ≠ Judge — a diagnosis explains, it does not score). */
type DiagnosisConfidence = 'high' | 'medium' | 'low';
/** The mutation surfaces the Evolution ledger records a proposal under (§2.7.6). This is Evolution's own vocabulary — what it can *execute* is narrower still (`APPLYABLE_TARGET_TYPES` in the evolution package) — and it is deliberately not the … */
type ProposalTargetType = 'skill' | 'tool' | 'capability' | 'task_definition' | 'decomposition_policy' | 'agent_preset' | 'workflow_policy' | 'verifier' | 'runtime_policy';
/** One structured suggestion a diagnosis raises. In P4 a proposal never executes by itself (§2.7.6: no automatic production changes); it is data for a human or a later Evolution step. */
interface DiagnosisProposal {
  /** The mutation surface the suggestion points at, as a non-empty open name (A5): a diagnosis explains, and the store does not freeze what a suggestion may name — a target type no executor exists for is a recorded suggestion, refused by name … */
  targetType: string;
  targetId: string;
  rationale: string;
}
/** The six review dimensions whose conclusion is not mechanically observable (§2.7.3): the fact table records what the run did, and only a reader holding the whole context can say whether what it did was adequate. */
type JudgedDimension = 'task_specification' | 'acceptance' | 'decomposition' | 'skill_fit' | 'tool_fit' | 'context_efficiency';
/** Every judged dimension, in the order a report reads them. */
declare const JUDGED_DIMENSIONS: readonly JudgedDimension[];
/** One dimension's coarse conclusion. Three values on purpose — this is not a rating scale. */
type JudgementVerdict = 'adequate' | 'inadequate' | 'unknown';
/** Every judgement verdict, for reducer validation and rendering. */
declare const JUDGEMENT_VERDICTS: readonly JudgementVerdict[];
/** One judged dimension: an agent's (or a person's) conclusion over the facts a `ReviewRecord` carries. Still not a score — `verdict` is a coarse three-way call, `evidenceRefs` names what it rests on, and `rationale` states the reasoning. */
interface ReviewJudgement {
  /** Which dimension this concludes; only the six non-mechanical ones are judgeable. */
  dimension: JudgedDimension;
  /** The conclusion: adequate, inadequate, or unknown. */
  verdict: JudgementVerdict;
  /** Refs the judgement rests on: evidence ids, the review refs `task_review_pack` prints (`<taskId>#<runId>`, or `<taskId>#no-run`), or session ids. Required and non-empty — a conclusion that cites nothing is not reviewable. */
  evidenceRefs: string[];
  /** Why this verdict, in the writer's words. */
  rationale: string;
}
/** Who produced a diagnosis, so an agent's judgement is never mistaken for a person's. */
interface DiagnosisProvenance {
  /** `agent` when a spawned review agent wrote it; `human` for a person. */
  kind: 'agent' | 'human';
  /** The session that produced it, when one did — the id a reader drills into. */
  sessionId?: string;
}
/** The core product of review (§2.7.3): an explanation of what a task's reviews show, not a score. Diagnosis lineage is a graph, not a tree (§2.7.4): `reviewRefs` may name several records and `relatedTaskIds` may point across tasks. */
interface Diagnosis {
  diagnosisId: string;
  taskId: TaskId;
  /** The failure or anomaly under explanation, as observed in the evidence. */
  observedFailure: string;
  /** How far the cause reaches (this task, its subtree, a shared assumption, …). */
  scope: string;
  /** The most specific explanation the evidence supports. */
  localizedCause: string;
  /** Evidence ids the diagnosis rests on. */
  evidenceRefs: string[];
  /** The review records the diagnosis rests on, named by the refs task_review_pack prints (`<taskId>#<runId>`, or `<taskId>#no-run`). */
  reviewRefs: string[];
  confidence: DiagnosisConfidence;
  /** Structured suggestions only; nothing here auto-executes. */
  proposals: DiagnosisProposal[];
  /** Other tasks this diagnosis implicates (cross-task lineage, §2.7.4). */
  relatedTaskIds?: TaskId[];
  /** Who wrote this diagnosis. Absent on records written before this field existed, and on any writer that does not declare itself; absence is read as human-written (the only producer there was). */
  producedBy?: DiagnosisProvenance;
  /** The six judged dimensions, when the writer made explicit calls. Optional: a diagnosis may explain a cause without judging every dimension, and an all-`unknown` judgement is a legitimate outcome — it says the evidence did not settle the … */
  judgements?: ReviewJudgement[];
}
/** One structured record of what is still missing (KISS §2/§5): an Obligation is a question, not an action — `goal` names the gap, `criterion` says how its satisfaction would be judged, and `sourceTaskId` names the task whose failure, block … */
interface Obligation {
  obligationId: string;
  /** What is still missing, as a question or a named gap. */
  goal: string;
  /** How a reader would judge the obligation satisfied. */
  criterion: string;
  /** The task whose terminal transition (or rejected admission) raised it. */
  sourceTaskId: TaskId;
}
/** Store id convention: one task store per root session. */
declare function rootTaskStoreId(rootSessionId: string): string;
interface TaskSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly tasks: readonly TaskInstance[];
  readonly runs: readonly TaskRun[];
  readonly edges: readonly DependencyEdge[];
  readonly evidence: readonly EvidenceBundle[];
  readonly handoffs: readonly TaskHandoff[];
  readonly reviews: readonly ReviewRecord[];
  readonly diagnoses: readonly Diagnosis[];
  readonly obligations: readonly Obligation[];
  readonly capabilities: Readonly<Record<string, CapabilityManifest>>;
  /** The store's proposals, indexed for the three questions a review gate asks (§6/§7): by proposal id, by the caller's request key, and by parent task. */
  readonly proposals?: TaskProposalIndex;
  /** The store's parent/child questions (A4 §F.1), in ask order and by id, each carrying the answers recorded so far. */
  readonly questions?: TaskQuestionIndex;
  /** The ceilings a person raised on this tree's own budget (K4), in the order they were recorded and by request key. */
  readonly budgetExtensions?: TaskBudgetExtensionIndex;
}
interface TaskEventPayloads {
  /** A task instance enters the store (created status, no runs or children attached). */
  TaskCreated: {
    task: TaskInstance;
  };
  /** A created task is admitted as a leaf or as decomposable. */
  TaskAdmitted: {
    decompositionStatus: 'leaf' | 'decomposable';
  };
  /** A created task is rejected at admission and settles blocked. */
  TaskRejected: {
    reason: string;
  };
  /** A decomposable task's children are registered under it and the parent closes as decomposed. */
  TaskDecomposed: {
    childTaskIds: TaskId[];
    /** The batch's content identity and the limits it was admitted under (construction guide §4). */
    admission?: DecompositionAdmission;
    /** The batch id {@link batchIdFor} derives from the run and the proposal below; refused when it is not that id. */
    batchId?: string;
    /** The run that admitted this batch; its accumulation gains one entry naming these members. */
    parentRunId?: RunId;
    /** The proposal this batch consumed — the second half of the batch's identity. */
    proposalId?: string;
  };
  /** A dependency edge is added to the DAG (from must verify before to starts). */
  DependencyAdded: {
    edge: DependencyEdge;
  };
  /** A run starts on an admitted/ready task. */
  TaskStarted: {
    run: TaskRun;
  };
  /** A task settles blocked, optionally taking its running run with it. */
  TaskBlocked: {
    reason?: string;
  };
  /** A running task hands its run to the verifier. */
  TaskVerifying: Record<string, never>;
  /** A verifying task settles verified; requires evidence under the run. */
  TaskVerified: {
    finishedAt?: string;
  };
  /** A running/verifying task settles failed. */
  TaskFailed: {
    reason?: string;
    finishedAt?: string;
  };
  /** A running task settles cancelled. */
  TaskCancelled: {
    reason?: string;
    finishedAt?: string;
  };
  /** A failed task returns to ready so a new run can start. */
  TaskRetried: Record<string, never>;
  /** A running run's coordination phase changes (A3). The transition is the admission gate: `active → waiting_children` when its decomposition batch is admitted atomically, `waiting_children → active` when that batch ends and execution is … */
  RunPhaseChanged: {
    phase: ExecutionPhase;
    /** The batch an `active ↔ waiting_children` edge names: the batch opened on the way out and the batch closed on the way back (`b-<parentRunId>-<proposalId>`, {@link batchIdFor}). */
    batchId?: string;
    /** The record a `submitted` run hands in; required for that phase and refused elsewhere. */
    submission?: SubmissionRecord;
    /** The A3 question-id mount point, readable for old records only: the reducer still shape-checks and carries it, so a store written before A4 replays to the same snapshot, while this build's write entries refuse a phase change that carries it … */
    pendingQuestionIds?: string[];
    /** The A3 blocking-question mount point, readable for old records only; same handling as `pendingQuestionIds`. */
    blockingQuestionIds?: string[];
    /** The caller's account of the transition, when a reader needs one. */
    reason?: string;
  };
  /** A run was observed idle without submitting (A3): the no-progress record a reader shows before the budget stops a stuck run. */
  RunProgressMarked: {
    /** The only kind A3 writes. */
    kind: 'unsubmitted-idle';
    /** Consecutive no-progress rounds the caller observed; a positive integer. */
    rounds: number;
    /** The run subtree's fact count at marking time (A3 §3.5). */
    factCount: number;
    /** The observable diagnostic: why the run looks stuck. */
    note: string;
  };
  /** A child run asks its direct parent task a question (A4, plan §F.1). The record is the durable half of the exchange — the question's identity, the asking and answering runs, the citation of the body, the delivery's messageId, the request … */
  QuestionAsked: {
    question: QuestionRecord;
  };
  /** A parent run answers one of its children's questions (A4, plan §F.1). The answer is its own event, appended to the question's record: an open question accepts several answers (a partial one, then a resolving one), and `resolves` is the … */
  QuestionAnswered: {
    answer: QuestionAnswerRecord;
  };
  /** The capability manifest a task was admitted with is stored. */
  CapabilityResolved: {
    manifest: CapabilityManifest;
  };
  /** Admission found required capabilities the registry cannot grant. */
  CapabilityGapDetected: {
    missing: string[];
  };
  /** An evidence bundle is recorded under a running run. */
  EvidenceProduced: {
    evidence: EvidenceBundle;
  };
  /** A parent run hands a child task off to its worker. */
  HandoffCreated: {
    handoff: TaskHandoff;
  };
  /** A terminal run's one lightweight review record, written exactly once at terminal time. */
  ReviewRecorded: {
    review: ReviewRecord;
  };
  /** One caller-triggered diagnosis over a task's review records; immutable once written, unique per diagnosisId. */
  DiagnosisRecorded: {
    diagnosis: Diagnosis;
  };
  /** A structured "what is still missing" record raised by a failure, a block, or a capability gap; an Obligation is a question, never an action. */
  ObligationRecorded: {
    obligation: Obligation;
  };
  /** A person raised a ceiling of the tree's own budget (K4): the run count the tree may reach, the instant it must stop by, or both — each recorded as the pair (the ceiling in force when the request was read → the ceiling approved now), with … */
  TaskBudgetExtended: {
    extension: TaskBudgetExtensionClaim;
  };
  /** A proposal enters the store (T2/T3, construction guide §6; root contracts A0 §2): one immutable submission with the policy it was born under, the complete normalized contracts it proposes, the limits it was admitted under, the resolution … */
  TaskProposalSubmitted: {
    proposal: TaskProposal;
  };
  /** A human review decision (T2/T3, §6): approved, rejected, cancelled or expired, bound to the dossier digest and both context fingerprints shown when it was taken. */
  TaskProposalDecided: TaskProposalDecisionClaim;
  /** A runtime-driven proposal phase change (T2/T3, §6): to `pending_review` when the deployment tightens to `all` while a policy-off proposal is still un-admitted (only tightening is allowed; a waiting proposal is never released), to `ready` … */
  TaskProposalPhaseChanged: TaskProposalPhaseChange;
  /** A proposal is consumed (T2/T3, §6; root contracts A0 §2): what it asked for now exists, bound to the ids this event carries. */
  TaskProposalAdmitted: TaskProposalConsumption;
}
type TaskEventKind = keyof TaskEventPayloads;
interface TaskEventEnvelope<K$1 extends TaskEventKind, P> {
  readonly kind: K$1;
  readonly taskId: TaskId;
  readonly runId?: RunId;
  readonly sessionId?: string;
  readonly parentTaskId?: TaskId;
  readonly timestamp: string;
  readonly actor: string;
  readonly payload: P;
  readonly schemaVersion: 1;
}
type TaskEvent = { [K in TaskEventKind]: TaskEventEnvelope<K, TaskEventPayloads[K]> }[TaskEventKind];
//#endregion
//#region src/service/state.d.ts
declare class TaskState {
  private value;
  constructor(id: string, snapshot?: TaskSnapshot);
  clone(): TaskState;
  snapshot(): TaskSnapshot;
  apply(event: TaskEvent): void;
}
//#endregion
//#region src/service/store.d.ts
/** The reducer one store set replays: a private snapshot, one event at a time, read detached. */
interface EventStoreState<Event, Snapshot> {
  clone(): this;
  apply(event: Event): void;
  snapshot(): Snapshot;
}
/** One open store: its identity, its reducer state, and the queues every caller of it shares. */
interface StoreEntry<K$1 extends SessionEventType, State> {
  readonly id: string;
  readonly sessionId: SessionId;
  state: State;
  handle?: SessionHandle;
  nextSeq: number;
  ready: Promise<void>;
  writes: Promise<void>;
}
/** How a store opens: `create` refuses an existing stored session, `open` a missing one, `auto` takes whichever it finds. */
type StoreOpenMode = 'create' | 'open' | 'auto';
/** Everything one store set needs: the log vocabulary, the reducer, the open policy and the refusals it answers with. */
interface EventStoreConfig<K$1 extends SessionEventType, Snapshot, State extends EventStoreState<SessionEventMap[K$1], Snapshot>> {
  /** Refusal prefix and identity namespace, e.g. `task`. */
  readonly namespace: string;
  /** The SessionEventMap key these stores append and replay. */
  readonly eventType: K$1;
  /** The cordis event broadcast with the fresh snapshot after every commit. */
  readonly changeEvent: keyof Events & string;
  /** Builds the reducer state for one store id; a state without one (the graph registry) ignores the argument. */
  readonly createState: (storeId: string) => State;
  /** The store id {@link EventStoreSet.load} takes when a caller names none. */
  readonly defaultStoreId?: string;
  /** Open a store nobody opened yet on first access instead of refusing it, and keep a failed open registered so `close()` reports it. */
  readonly onDemand?: boolean;
}
/** The `sessionPersistence`-backed stores one service owns: allocation, replay, serial writes and disposal. */
declare class EventStoreSet<K$1 extends SessionEventType, Snapshot, State extends EventStoreState<SessionEventMap[K$1], Snapshot>> {
  private readonly ctx;
  private readonly config;
  private readonly stores;
  private closing;
  constructor(ctx: Context, config: EventStoreConfig<K$1, Snapshot, State>);
  /** Whether disposal has started; every entry refuses new work from then on. */
  get closed(): boolean;
  /** The store behind `id`, which a caller must already have opened. */
  require(id: string): StoreEntry<K$1, State>;
  /** The store behind `id` (or the configured default id), opened or created on first access. */
  load(id?: string): StoreEntry<K$1, State>;
  /** Opens (or creates) the store behind `id` and answers its first snapshot; `create`/`open` are the explicit doors. */
  open(id: string, mode?: StoreOpenMode): Promise<Snapshot>;
  /** The store's current snapshot, waiting for its open but not for queued writes. */
  snapshot(id: string): Promise<Snapshot>;
  /** The snapshot every accepted write so far has left: open, then the shared write queue, then a detached read. */
  settledSnapshot(id: string): Promise<Snapshot>;
  /** One batch, applied to a clone inside the store's write queue and appended only if the reducer accepted it. */
  commit(id: string, events: readonly SessionEventMap[K$1][]): Promise<void>;
  /** Runs `work` inside the store's single write queue and answers what it returned. */
  serial<T>(id: string, work: (state: State) => Promise<T> | T): Promise<T>;
  /** The append half of a commit, for work already inside the write queue: apply the batch, append, swap, broadcast. */
  append(id: string, state: State, events: readonly SessionEventMap[K$1][]): Promise<void>;
  /** Drains readiness and queued writes of every store, closes each handle, then reports the first failure. */
  close(): Promise<void>;
  /** The guard every entry shares: disposal refuses all work, and a store id must be a plain file-name token. */
  private guard;
  private defaultId;
  private resolve;
  private lookup;
  private allocate;
  /** A default store opens before any caller exists: its refusal must stay observable to that caller, never reach the process. */
  private track;
  private beginOpen;
  private record;
  private broadcast;
  private header;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One task-store mutation in a per-task store; the TaskEvent union that TaskState replays on load. */
    'task/event': TaskEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    task: TaskService;
  }
  interface Events {
    'task/change'(snapshot: TaskSnapshot): void;
  }
}
declare class TaskService extends Service {
  static inject: string[];
  private readonly stores;
  constructor(ctx: Context);
  createStore(storeId: string): Promise<TaskSnapshot>;
  openStore(storeId: string): Promise<TaskSnapshot>;
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
  taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance>;
  runIn(storeId: string, runId: RunId): Promise<TaskRun>;
  /** The tasks one run has admitted altogether, in the order their batches were admitted ({@link runMemberTaskIds} of the run's own projection) — the run's accumulative membership, which is the sequence a parent criterion's `childIndex` names. */
  runMembersIn(storeId: string, runId: RunId): Promise<TaskInstance[]>;
  /** The tasks one run reads **by position** — the sequence a parent criterion's `childIndex` indexes, with a not-yet-filled slot left `undefined` ({@link runMemberSlots}). */
  runMemberSlotsIn(storeId: string, runId: RunId): Promise<(TaskInstance | undefined)[]>;
  createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void>;
  admitTaskIn(storeId: string, taskId: TaskId, actor: string, options?: {
    decompositionStatus?: 'leaf' | 'decomposable';
    manifest?: CapabilityManifest;
  }): Promise<void>;
  rejectTaskIn(storeId: string, taskId: TaskId, actor: string, reason: string, manifest?: CapabilityManifest): Promise<void>;
  /** The atomic batch-admission entry (A3 §1.3): every child's creation and admission, the dependency edges, the parent's decomposition record with the batch identity, the per-child capability manifests and the parent run's `active → … */
  admitBatchIn(storeId: string, parentTaskId: TaskId, parentRunId: RunId, children: readonly TaskInstance[], actor: string, edges?: readonly DependencyEdge[], admission?: DecompositionAdmission, manifests?: readonly CapabilityManifest[], proposal?: TaskProposalConsumption): Promise<void>;
  /** The root activation commit (A0 §1.4, §2): the root task, its run and the proposal that asked for them land in **one** commit — a contract is either active with its task, its run and its consumption on record, or the store is untouched. */
  admitRootProposalIn(storeId: string, task: TaskInstance, run: TaskRun, actor: string, options: {
    consumption: TaskProposalRootConsumption;
    manifest?: CapabilityManifest;
  }): Promise<void>;
  addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void>;
  /** One run starts on a task that may run — a first run, or a new attempt at a task that failed (`TaskRetried`, then `TaskStarted`, in one commit). */
  startRunIn(storeId: string, run: TaskRun, actor: string, options?: {
    manifest?: CapabilityManifest;
  }): Promise<void>;
  markRunStatusIn(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus | 'verifying', actor: string, options?: {
    reason?: string;
    finishedAt?: string;
  }): Promise<void>;
  /** Records one coordination-phase change on a run (A3). The reducer is the gate: only `active → waiting_children` and `waiting_children → active` (both carrying the batch id they open or close) and `active|waiting_children → submitted` … */
  changeRunPhaseIn(storeId: string, taskId: TaskId, runId: RunId, actor: string, payload: TaskEventPayloads['RunPhaseChanged']): Promise<void>;
  /** Records one question a child run asks its direct parent (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
  askParentQuestionIn(storeId: string, ask: QuestionAsk, actor: string): Promise<QuestionAskResult>;
  /** Records one answer to a still-open question (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
  answerParentQuestionIn(storeId: string, answer: QuestionAnswer, actor: string): Promise<QuestionAnswerResult>;
  /** Records one no-progress marking on an active run (A3). `rounds` is the caller's consecutive count; the reducer records the value it is given. */
  markRunProgressIn(storeId: string, taskId: TaskId, runId: RunId, actor: string, payload: TaskEventPayloads['RunProgressMarked']): Promise<void>;
  /** Records one proposal submission (T2/T3 §6; root contracts A0 §2). The immutable record, the policy it was born under, the limits in force, the resolution it was reviewed against, and both context fingerprints. */
  submitProposalIn(storeId: string, proposal: TaskProposal, actor: string): Promise<void>;
  /** Records one review decision (T2/T3 §6), bound to the dossier digest and both context fingerprints the reviewer was shown. */
  decideProposalIn(storeId: string, claim: TaskProposalDecisionClaim, actor: string): Promise<void>;
  /** Records one runtime phase change (T2/T3 §6): to `pending_review` when the deployment tightened to `all`, to `ready` when an approval passed its post-approval re-check, to `stale` when that re-check failed. */
  changeProposalPhaseIn(storeId: string, change: TaskProposalPhaseChange, actor: string): Promise<void>;
  /** Records one consumption on its own (T2/T3 §6): the batch the proposal became, by child task id and batch id. */
  consumeProposalIn(storeId: string, consumption: TaskProposalConsumption, actor: string): Promise<void>;
  recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void>;
  recordReviewIn(storeId: string, review: ReviewRecord, actor: string): Promise<void>;
  recordDiagnosisIn(storeId: string, diagnosis: Diagnosis, actor: string): Promise<void>;
  recordObligationIn(storeId: string, obligation: Obligation, actor: string): Promise<void>;
  /** Records one approved budget extension (K4), or answers a repeat of one the store already holds. */
  recordBudgetExtensionIn(storeId: string, rootTaskId: TaskId, claim: TaskBudgetExtensionClaim, actor: string): Promise<void>;
  recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void>;
  commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void>;
  /** The proposal one event names, read from the store before the commit so an unknown proposal is a refusal *before* anything is queued: the reducer would reject the event anyway, and a caller that asked about a proposal the store does not … */
  private requireProposalIn;
  /** The task id a proposal's events carry on the envelope: the parent task a decomposition batch belongs to, or the reserved root marker for a root contract, which has no parent to name (A0 §2). */
  private proposalEnvelopeTaskIn;
}
//#endregion
export { AcceptanceCriterion, AdmissionContext, ArtifactRef, BUDGET_EXTENSION_BASELINE_FIELDS, BUDGET_EXTENSION_CLAIM_FIELDS, BudgetExtensionProposal, BudgetExtensionRequest, CapabilityManifest, ChildEvidenceRef, DecompositionAdmission, DecompositionIdentity, DependencyEdge, Diagnosis, DiagnosisConfidence, DiagnosisProposal, type EventStoreConfig, EventStoreSet, type EventStoreState, EvidenceBundle, EvidenceClaim, ExecutionPhase, JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, JudgedDimension, JudgementVerdict, Obligation, ProposalTargetType, ProtectedInputRef, QuestionAnswer, QuestionAnswerRecord, QuestionAnswerResult, QuestionAsk, QuestionAskResult, QuestionMessageRef, QuestionRecord, ROOT_PROPOSAL_TASK_ID, ReviewBlocker, ReviewCriterion, ReviewDimensions, ReviewJudgement, ReviewMetrics, ReviewOutcome, ReviewRecord, ReviewTokenUsage, ReviewToolCall, RootProposalIdentity, RunId, RunMcpServerBinding, RunMemberReuse, RunMemberReuseRefusal, RunProviderBinding, RunRecovery, RunSkillBinding, RunStatus, type StoreEntry, type StoreOpenMode, SubmissionRecord, TASK_CONTRACT_VERSION, TASK_PROPOSAL_DECISION_OUTCOMES, TASK_PROPOSAL_KINDS, TASK_PROPOSAL_PHASES, TERMINAL_RUN_STATUSES, TaskBudgetExtension, TaskBudgetExtensionClaim, TaskBudgetExtensionIndex, TaskContract, TaskContractVersion, TaskEvent, TaskEventKind, TaskEventPayloads, TaskHandoff, TaskId, TaskInstance, TaskProposal, TaskProposalBase, TaskProposalBatchConsumption, TaskProposalChild, TaskProposalConsumption, TaskProposalDecisionClaim, TaskProposalDecisionOutcome, TaskProposalDecomposition, TaskProposalIndex, TaskProposalPhase, TaskProposalPhaseChange, TaskProposalPolicy, TaskProposalReviewContext, TaskProposalRoot, TaskProposalRootConsumption, TaskProposalStatus, TaskProposalVerifierIdentity, TaskQuestionIndex, TaskRun, TaskService, TaskService as default, TaskSnapshot, TaskState, TaskStatus, VerificationMode, VerificationResult, admissionContextDigest, answerIdOf, approvedBudgetCeilings, batchIdFor, blockingQuestionsOf, budgetExtensionRequestDigest, canonicalBudgetInstant, canonicalize, capabilityManifestDigest, contractDigest, decompositionDigest, definedKeys, describeBudgetExtension, describeBudgetReading, isTerminalRunStatus, openQuestionsOf, questionIdOf, questionOf, questionsAwaitingAnswerOf, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, runMemberSlots, runMemberTaskIds, sha256Hex, taskProposalId };