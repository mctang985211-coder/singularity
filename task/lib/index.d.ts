import { Context, Service } from "@deepseek-ai/cordis";

//#region src/contract.d.ts

/**
 * The normalized contract version this build writes. Separate from a
 * `TaskDefinition.version` (a template's own generation) and from the event
 * envelope's `schemaVersion` (the store's wire format): this one versions the
 * contract data definition, and an entry that declares a version this build
 * does not know is refused rather than read with the wrong field semantics.
 */
declare const TASK_CONTRACT_VERSION: 1;
/** Every version of {@link TaskContract} this build can write or read. */
type TaskContractVersion = typeof TASK_CONTRACT_VERSION;
/**
 * One task's contract, in normalized form: defaults already filled, criterion
 * ids already fixed, every array present. A stored task's contract is
 * immutable — a revision is a new task, never an edit — which is why the store
 * can carry it verbatim and why the projection fields on `TaskInstance`
 * (`objective`, `acceptanceCriteria`, `requestedCapabilities`) are generated
 * from it and checked for disagreement on write.
 *
 * `assumptions` and `constraints` are persisted here instead of living only in
 * the spawn prompt: a worker handoff renders them, a reader of the store can
 * quote them later, and neither is allowed to drift from what the task was
 * admitted with. Text is stored verbatim (no trimming, no newline rewriting) —
 * non-blank validation happens on the entry, byte identity in the digest.
 */
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
/**
 * The limits one decomposition batch was admitted under (§4). Recorded with
 * the batch, never derived from the contract: a contract's own text has no
 * field that can raise a limit, and the runtime resolves every value here from
 * its configuration at admission time. The split between enforced and audited
 * values is the point of the record — a reader must be able to tell which
 * ceiling would actually have stopped the run.
 */
interface AdmissionContext {
  /** Growth guardrail enforced at admission: a batch reaching depth `maxDepth + 1` is refused before anything is persisted. */
  maxDepth: number;
  /** Growth guardrail enforced at admission: a batch above `maxChildren` is refused before anything is persisted. */
  maxChildren: number;
  /** Enforced in flight: each run of the batch races this wall-clock deadline and settles failed naming the budget when it expires. Absent when the deployment configures none. */
  wallTimeMs?: number;
  /**
   * Effective values that are only audited after a run settled — never
   * enforced in flight (the orchestrator can observe tool calls and tokens
   * only once the session log is readable). Recorded so a later gate sees what
   * the batch ran under instead of re-deriving it from a config that may have
   * moved on.
   */
  auditOnly: {
    maxToolCalls?: number;
    tokens?: number;
    attempts?: number;
  };
}
/**
 * The identity of one admitted batch, recorded on the parent's decomposition
 * event: what the batch asked for (digest) and the limits it was admitted
 * under (context). T2's review gate binds an approval to exactly this pair;
 * nothing in T1 acts on it beyond writing it down truthfully.
 */
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
/**
 * Everything a batch proposal's identity covers (§4): where it came from
 * (store, parent task and run, caller), which contract language it is written
 * in, why it was proposed, and the complete ordered children. The caller's
 * `reason` is inside the digest on purpose — two batches with identical
 * contracts but different reasons are different proposals.
 */
interface DecompositionIdentity {
  contractVersion: TaskContractVersion;
  storeId: string;
  parentTaskId: string;
  parentRunId: string;
  callerSessionId: string;
  reason: string;
  children: readonly DecompositionChildIdentity[];
}
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
declare function canonicalize(value: unknown): string;
/**
 * SHA-256 (lowercase hex) of raw bytes: the digest form a protected
 * acceptance input's identity is fixed with ({@link ProtectedInputRef}),
 * shared by the admission-time fixing and the pre-judgement re-check.
 */
declare function sha256Hex(bytes: Uint8Array | string): string;
/** The single-task contract identity: SHA-256 over {@link canonicalize} of the normalized contract. */
declare function contractDigest(contract: TaskContract): string;
/** The whole-batch proposal identity: SHA-256 over {@link canonicalize} of the normalized proposal. */
declare function decompositionDigest(identity: DecompositionIdentity): string;
//#endregion
//#region src/proposal.d.ts

/**
 * The review policy a proposal was submitted under (§5). Deployment
 * configuration decides it; a node cannot switch it, and it is stored with the
 * proposal because the audit has to be able to tell a batch that ran without a
 * human review (`off`, recorded as `policy-off`) from one a person approved.
 */
type TaskProposalPolicy = 'off' | 'all';
/**
 * What a proposal proposes (§2): a parent task's decomposition batch, or a root
 * session's contract. Absent means `decomposition` — every record written
 * before the field existed — so a reader must treat the two the same and never
 * invent a kind for a stored record.
 *
 * Module-local on purpose: the record's own discriminant is the literal on each
 * arm (`kind?: 'batch'`, `kind: 'root'`), and the only reader of this union is
 * the validation vocabulary below. Nothing outside this file names it, so it is
 * not part of the package's public surface (R2).
 */
type TaskProposalKind = 'decomposition' | 'root';
/** Every proposal kind, for validation and rendering. */
declare const TASK_PROPOSAL_KINDS: readonly TaskProposalKind[];
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
declare const ROOT_PROPOSAL_TASK_ID = "root-proposal";
/**
 * Where one proposal sits in the review lifecycle (§6). Separate from
 * `TaskStatus` on purpose — a proposal is not a task, and none of these states
 * may be read as "the task ran".
 *
 * | state | means | legal exits |
 * |---|---|---|
 * | `ready` | admitted to execution without waiting for a review: born `ready` under policy `off`, or an approval that passed its post-approval re-check | `admitted` (consumption), `pending_review` (deployment tightened to `all` before admission), `stale` (re-check failed), `expired` (parent run gone), `cancelled` (explicit) |
 * | `pending_review` | waiting for a human decision. `TaskProposal.policy` still records the submit-time policy, so a proposal born `off` and later sent to review is a `pending_review` record with `policy: 'off'` | `approved`, `rejected`, `cancelled`, `expired` |
 * | `approved` | the approval is on the record, the batch has not been re-checked yet | `ready` (re-check passed), `stale` (re-check failed), `expired`, `cancelled` |
 * | `rejected` | a reviewer refused this batch; a revision is a new proposal (`supersedes`) | terminal |
 * | `cancelled` | somebody withdrew the batch before it could run | terminal |
 * | `stale` | the approval no longer covers the batch's context (§6: a capability, budget or verifier change), so it needs a new proposal | terminal |
 * | `expired` | the parent run was cancelled or ended while the decision was in flight (§6: a late approval may only invalidate) | terminal |
 * | `admitted` | consumed: the batch exists in the store, bound to `consumption.childTaskIds` and one batch id | terminal |
 *
 * Two rules the table encodes and a reader must not have to infer: an approval
 * alone never admits a batch — the re-check between approval and admission is
 * recorded as `approved → ready`, so admission always happens from `ready`;
 * and a `pending_review` proposal is never released back to `ready` by a
 * policy change to `off` (§5: only tightening is allowed, and a proposal
 * already waiting keeps waiting).
 */
type TaskProposalStatus = 'ready' | 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'stale' | 'admitted' | 'expired';
/** Every proposal status, for validation and rendering. */
declare const TASK_PROPOSAL_STATUSES: readonly TaskProposalStatus[];
/**
 * The statuses a `TaskProposalPhaseChanged` event may write: what the runtime
 * (as opposed to a person deciding or a batch being admitted) moves a proposal
 * to. `pending_review` is on the list because §5's tightening path needs it;
 * `admitted` is not, because that is the consumption event's business.
 */
type TaskProposalPhase = 'ready' | 'pending_review' | 'stale';
/** Every proposal phase change, for validation and rendering. */
declare const TASK_PROPOSAL_PHASES: readonly TaskProposalPhase[];
/**
 * What a decision may be. The four are kept apart because they mean different
 * things to a reader and to the next stage: `approved` is the only one that can
 * lead to execution, `rejected` says a reviewer refused the batch, `cancelled`
 * says the batch was withdrawn (by a person or by the deployment), and
 * `expired` says the decision arrived when the batch could no longer be
 * dispatched (§6: a late approval may only invalidate the proposal).
 */
type TaskProposalDecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'expired';
/** Every decision outcome, for validation and rendering. */
declare const TASK_PROPOSAL_DECISION_OUTCOMES: readonly TaskProposalDecisionOutcome[];
/**
 * One judging instance a batch's criteria resolved to, as the review context
 * records it (§6): the registered verifier's id, the version it declares, and —
 * when the deployment can name one — the fingerprint of the configuration that
 * instance was built from.
 *
 * `version` and `configurationDigest` are absent on a verifier that declares
 * neither. That absence is itself information: a source with no content version
 * cannot be held to one, and §6 says so rather than letting a reader assume
 * version binding that does not exist.
 */
interface TaskProposalVerifierIdentity {
  /** The registered verifier id a criterion of this batch resolves to. */
  verifierId: string;
  /** The version the registered instance declares, when it declares one. */
  version?: string;
  /** Fingerprint of the configuration the instance was built from, when the deployment can name one. */
  configurationDigest?: string;
}
/**
 * What a proposal's approval actually covered (§6): the capability manifests
 * this batch resolved, and the judging instances its criteria resolved to.
 * Deliberately narrow — §6: an unrelated registry edit must not invalidate a
 * reviewed proposal, so nothing that is not about *this* batch belongs here.
 *
 * The manifests are the *resolution* identity (which capabilities, skills and
 * presets the batch matched), which is what the runtime has at review time.
 * The content identity of the skills behind them is pinned per run by S1-C's
 * provider binding and is not part of a review context; see the module doc.
 */
interface TaskProposalReviewContext {
  /** {@link capabilityManifestDigest} of the manifests this batch resolved, in batch order. */
  capabilityManifestDigest: string;
  /** Every judging instance the batch's criteria resolve to. Order is not part of {@link reviewContextDigest}. */
  verifiers: TaskProposalVerifierIdentity[];
}
/**
 * One child of a proposal's batch, in full (§5): the normalized contract a
 * reviewer reads, plus the three declarations the batch identity digests. The
 * proposal carries the content itself — not only its digest — because approval
 * display, a canvas view of a waiting proposal, and a resumed approval request
 * after a restart all have to render the batch from the saved facts alone, and
 * because "what did a person approve" must be answerable from the store rather
 * than from whatever the proposing caller still holds in memory.
 *
 * The correspondence with {@link DecompositionIdentity.children} is positional
 * and one-to-one: entry `i` here is the content of entry `i` there, and the
 * reducer refuses a submission where anything disagrees — the contract digest
 * (`contractDigest(contract)`), `dependsOn`, `decomposable`, and
 * `requiresIndependentAcceptance`. An identity without its content, or content
 * without an identity, is never stored.
 */
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
/**
 * Everything a root contract proposal's identity covers (§2): which store and
 * which root session the contract is for, the caller's request key, and the
 * digest of the single normalized contract stored beside it. There is no parent
 * task and no parent run — the root task is what this proposal *becomes* — so
 * the identity names the root session instead, and nothing about a task the
 * store has not admitted yet can enter it.
 *
 * The request key is inside this identity (unlike a decomposition batch, which
 * records the key beside the identity): a root intake is answered by key, and
 * §2 derives a default key from the store, the root session and the contract
 * content — so the same request for the same contract addresses one proposal
 * and a revision, which gets a new key, is a new one. The reducer holds the
 * record to that: the identity's key must be the record's key.
 */
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
/**
 * One review decision on record (§6): what was decided, against which dossier
 * and which contexts, by whom and when. The three identity fields are what make
 * an approval non-transferable — the reducer refuses a decision whose
 * `proposalDigest`, `admissionContextDigest` or `reviewContextDigest` disagrees
 * with the stored proposal, so a decision can only ever mean "this exact batch,
 * under these exact limits, with this exact resolution".
 *
 * Module-local on purpose: the exported vocabulary of a decision is
 * {@link TaskProposalDecisionClaim} (the persisted event payload), which this
 * interface is the base of; a reader narrowing the stored record structurally
 * never needs the base's name (R2).
 */
interface TaskProposalDecision {
  /** What was decided. Only `approved` can lead to admission, through `approved → ready`. */
  outcome: TaskProposalDecisionOutcome;
  /** The batch identity the decision was made against; must equal the stored proposal's. */
  proposalDigest: string;
  /** The admission-context fingerprint shown with the proposal; must equal the stored one. */
  admissionContextDigest: string;
  /**
   * The review-context fingerprint the decision was made against. Required for
   * an approval — an approval that did not bind the resolution it reviewed is
   * not an approval — and, when present on any other outcome, still checked
   * against the stored one.
   */
  reviewContextDigest?: string;
  /** Who decided: the approval channel's own identity, a session id, or the deployment for a withdrawal. Never a model-supplied reference. */
  decidedBy: string;
  /** When the decision was taken, as the writer recorded it. */
  decidedAt: string;
  /** Why, when the decider gave a reason. Required for an expiry, which must name what ended the batch. */
  reason?: string;
}
/**
 * One consumption (§6): the record that turns a proposal into what it became.
 * Written in the same commit as that thing, so the store can always answer
 * "which proposal became which tasks" — and so a crash between the admission
 * and the first spawn is recoverable from the log alone, without a second
 * batch. The digest fields bind the consumption to what was approved: a
 * proposal that was revised, re-resolved or re-checked into a different context
 * cannot be consumed under this record, and the reducer refuses the attempt by
 * name.
 *
 * Two shapes for the two kinds (A0 §2). A decomposition batch is consumed as
 * `b-<parentTaskId>` plus its children; a root contract is consumed as the one
 * root task and root run the activation minted, because there is no parent to
 * derive a batch id from and "one intake, one root" is not a batch at all. The
 * kind is a discriminant on the record, and its absence means the batch arm —
 * a consumption written before root intake existed still reads as it was.
 */
interface TaskProposalBatchConsumption {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'batch';
  /** The proposal being consumed. */
  proposalId: string;
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string;
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string;
  /** The batch's id in the run coordination protocol: `b-<parentTaskId>` (A3). */
  batchId: string;
  /** The children this proposal became, in batch order — the ids the admission commit created. */
  childTaskIds: TaskId[];
  /** When the batch was admitted, as the writer recorded it. */
  admittedAt: string;
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string;
}
/**
 * What a root contract was activated as (A0 §2): the root task and the root run
 * the activation commit created, named by id. The batch vocabulary does not
 * apply — a root intake has no parent to derive `b-<parentTaskId>` from — so the
 * consumption names the minted ids instead, and the reducer checks that they
 * are the store's one root task and a run born `active` in the proposal's root
 * session, carrying the contract the proposal committed to.
 *
 * `kind: 'root'` is required: a root activation is written by one entry
 * (`admitRootProposalIn`), so there is no legacy record to stay compatible
 * with, and a record that does not say what it is could be read as a batch.
 */
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
/**
 * One submitted proposal: the batch or the root contract to run, what it was
 * judged against, and where it stands. Immutable in its content — `identity`,
 * the payload (`batch` or `contract`), the digests, the contexts and `policy`
 * are written once at submission and never rewritten; only `status`,
 * `updatedAt`, and the appended `decision` / `consumption` records move as the
 * lifecycle advances (§6: a revision is a new proposal with a new id and a
 * `supersedes` reference, never an edit).
 *
 * The record is discriminated by {@link TaskProposalKind}: a root contract is
 * not a one-child batch, it is a different payload for a different subject, and
 * a reader that cannot tell them apart could render a root goal as a
 * decomposition of a task nobody named.
 */
interface TaskProposalBase {
  /**
   * The proposal's identity: `p-` plus {@link taskProposalId}'s derivation from
   * the proposal content. Content-derived rather than minted, so a retry —
   * within a process or after a restart — addresses the same proposal, and the
   * store refuses a second submission of the same content instead of building
   * a second batch (§4: random ids must never make one operation into two).
   */
  proposalId: string;
  /**
   * The stable key the caller derived from its own context (§6). One key names
   * at most one proposal: a repeated request with the same key is answered with
   * the stored proposal, a new revision gets a new key, and the store refuses a
   * key that is already bound to another proposal.
   */
  requestKey: string;
  /**
   * The proposal this one revises (§6), when the caller is replacing a rejected
   * or stale one. The superseded record is kept — a rejection is a fact, not an
   * edit — and a new *key* is what makes the revision new, so re-submitting the
   * old key would be refused rather than silently superseding anything.
   */
  supersedes?: string;
  /** Where the proposal stands. See {@link TaskProposalStatus} for the full table. */
  status: TaskProposalStatus;
  /**
   * The review policy in force when the proposal was submitted (§5). Stored,
   * never re-resolved: `off` is the audit record that this batch ran without a
   * human review (`policy-off`, never a fake `human-approved`), and a later
   * deployment change to `all` tightens `status` without rewriting this field.
   */
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
  /**
   * What this proposal became, once it was admitted. Absent while it still
   * might become something. The kind of the stored consumption always agrees
   * with the kind of the proposal that carries it — the reducer refuses the
   * other combination — so a reader narrows it the way it narrowed this record.
   */
  consumption?: TaskProposalConsumption;
}
/**
 * One decomposition proposal (T2/T3): a parent task's children, submitted as a
 * batch. `kind` is optional so a record written before the field existed — and
 * a writer that has no reason to state the obvious — still reads as this arm.
 */
interface TaskProposalDecomposition extends TaskProposalBase {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'decomposition';
  /** The complete batch identity, {@link decompositionDigest}'d into {@link proposalDigest}. */
  identity: DecompositionIdentity;
  /**
   * The complete batch content, one {@link TaskProposalChild} per
   * {@link identity} child and in the same order: the goals, criteria,
   * assumptions, constraints, capability requirements, dependencies and flags a
   * reviewer reads and a person approves. Bound to the identity by the
   * reducer's consistency check (same length, same order, same contract digests,
   * same declarations), so the content and its commitment can never disagree —
   * and so a later approval request, a canvas view, or a recovery after a crash
   * renders what was reviewed from the store alone.
   */
  batch: readonly TaskProposalChild[];
}
/**
 * One root contract proposal (A0 §2): the goal of a root session, normalized —
 * objective, assumptions, constraints, mandatory acceptance criteria — and
 * submitted as a single contract rather than as children. `kind: 'root'` is
 * required: a root contract has no parent task to place it under, so nothing
 * about the record can be read as a decomposition of something.
 */
interface TaskProposalRoot extends TaskProposalBase {
  kind: 'root';
  /** The root contract's identity: {@link rootProposalDigest}'d into {@link proposalDigest}. */
  identity: RootProposalIdentity;
  /**
   * The single normalized root contract this proposal asks to run (the content
   * an approval covers and a reviewer reads, stored whole for the same reasons
   * a batch is). Bound to the identity: the reducer refuses a submission whose
   * contract does not digest to {@link RootProposalIdentity.contractDigest}, and
   * the admission entry refuses a root task that does not carry this contract.
   */
  contract: TaskContract;
}
/**
 * One submitted proposal, either kind. A reader must narrow by `kind` before
 * touching the payload — that is the whole point of the union: `batch` and
 * `contract` are alternatives, and neither exists on the other arm.
 */
type TaskProposal = TaskProposalDecomposition | TaskProposalRoot;
/**
 * What a decision states when it is written (the payload of
 * `TaskProposalDecided`): {@link TaskProposalDecision} plus the proposal it is
 * about. The reducer checks every field against the stored proposal before the
 * record is applied.
 */
interface TaskProposalDecisionClaim extends TaskProposalDecision {
  /** The proposal this decision is about. */
  proposalId: string;
}
/**
 * One runtime-driven phase change (the payload of
 * `TaskProposalPhaseChanged`): a proposal sent to review because the deployment
 * tightened to `all`, an approval whose re-check passed (`approved → ready`,
 * §6's "批准已落账、等待重检/准入"), or one whose re-check failed (`→ stale`).
 */
interface TaskProposalPhaseChange {
  /** The proposal being moved. */
  proposalId: string;
  /** Where it moves to; see {@link TaskProposalPhase} and {@link TaskProposalStatus} for the legal sources. */
  to: TaskProposalPhase;
  /** Why the runtime moved it. Required for `stale` — an invalidation has to name what changed. */
  reason?: string;
}
/**
 * The proposal queries a snapshot answers (§6/§7): by id, by the request key a
 * caller derived, and by parent task — the three questions a runtime asks when
 * it decides whether to submit, decide, or resume a batch.
 *
 * A snapshot produced by a proposal-aware reducer always carries this index
 * (with empty members for a store that holds no proposals). An absent index
 * means the snapshot did not come from one — a test double or a foreign
 * reader — and never that the store has no proposals, so a caller that cannot
 * see the index must not read it as "no proposal exists for this key".
 *
 * A root contract proposal has no parent task, so it appears in `all`, `byId`
 * and `byRequestKey` and in no `byParentTask` entry: nothing is indexed under a
 * task the store does not hold, and a reader that wants a store's root intake
 * asks by request key (or reads the root task's own existence) rather than
 * inventing a parent for it.
 */
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
declare function taskProposalId(identity: DecompositionIdentity): string;
/**
 * The root contract's identity: SHA-256 over {@link canonicalize} of
 * {@link RootProposalIdentity} — which store, which root session, which request
 * key, and the digest of the normalized root contract. Exactly those fields and
 * nothing else (A0 §2), so the same contract asked for again by the same key is
 * one proposal, a revision is a different one, and no id minted at activation
 * is in it.
 */
declare function rootProposalDigest(identity: RootProposalIdentity): string;
/**
 * The proposal id one root contract identity gets: `p-` plus
 * {@link rootProposalDigest} of the identity. The same derivation and the same
 * prefix as a batch proposal (§4: content-derived ids, never minted), so an id
 * is one kind of thing wherever it is printed and a retry addresses the same
 * proposal.
 */
declare function rootProposalId(identity: RootProposalIdentity): string;
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
declare function admissionContextDigest(context: AdmissionContext): string;
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
declare function capabilityManifestDigest(manifests: readonly CapabilityManifest[]): string;
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
declare function reviewContextDigest(context: TaskProposalReviewContext): string;
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
  /**
   * Artifact or evidence references (kinds or ids) that must exist in the task
   * store before this criterion can be judged at all (KISS §5.1
   * `requires_artifact`): an ordering constraint declared as an evidence
   * dependency, not a sequence step. Admission validates only the shape
   * (non-empty strings); existence is judged at spawn time by the orchestrator,
   * which settles the child blocked — never spawned — and registers each
   * missing item as an Obligation.
   *
   * Since P4 the match is tightened to a **verified reference product**: the
   * producing run must sit in the verified terminal state and its bundle must
   * carry a passing verdict. A failed or still-running run's same-named product
   * never satisfies the reference. A raw input that need only exist is declared
   * with {@link acceptsArtifact} instead.
   */
  requiresArtifact?: string[];
  /**
   * Artifact or evidence references (kinds or ids) this criterion consumes as a
   * **raw input** (KISS §5.1): existence in the task store is the whole
   * requirement — any run state, verified or not. This is the pre-P4
   * `requiresArtifact` semantics, kept as its own field so a reference that
   * must have been verified ({@link requiresArtifact}) and one that merely must
   * exist are never confused. Judged at spawn time, blocked + Obligation when
   * missing, exactly like `requiresArtifact`.
   */
  acceptsArtifact?: string[];
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent keeps the current behavior: dispatch by
   * `verificationMode` to whichever registered verifier supports it. Present,
   * the id must exist in the verifier registry — an unknown id rejects the
   * whole decomposition batch at admission time (never at spawn time), with
   * the error naming the registered ids.
   */
  verifierRef?: string;
  /**
   * The parent-level evidence map (KISS §6 C2, minimal mechanical version):
   * which child of this task — by position in its decomposition batch, the same
   * index vocabulary `dependsOn` uses — this criterion rests on, optionally
   * narrowed to one of the child's criteria and one evidence/artifact
   * reference. The composite verifier judges every entry at parent-acceptance
   * time against the store: the named child must be `verified`, the named
   * criterion (when given) must carry a passing verdict in the child's verified
   * run evidence, and the named reference (when given) must exist there. An
   * incomplete mapping fails the criterion with the missing items named — the
   * "all children verified" conjunction can never stand in for it.
   *
   * Absent (or empty) keeps the current composite behavior exactly. A non-empty
   * map is judged only by the composite verifier, so admission requires
   * `verificationMode: 'composite'` on the criterion that carries it — a
   * declaration no judge reads would be a silent lie — and refuses the
   * combination with `heuristic` (a heuristic judgement is never a mechanical
   * check).
   */
  childEvidence?: ChildEvidenceRef[];
  /**
   * Marks this criterion's judgement as **heuristic** (KISS §5.1): the verdict
   * is explicitly labeled as such wherever it is reported, and it is never
   * counted as a deterministic pass — a natural-language coverage signal can
   * inform a reader but cannot close the criterion mechanically. Mutually
   * exclusive with {@link childEvidence} (admission refuses the combination).
   */
  heuristic?: boolean;
  /**
   * The acceptance inputs this criterion's verdict rests on that the executing
   * side must not modify (S1-V slice 2): acceptance scripts, threshold files,
   * fixtures. Callers declare paths; admission resolves each one against the
   * session's checkout and fixes its identity as the SHA-256 of its bytes
   * ({@link ProtectedInputRef}), so the fixed identity — not a later read —
   * is what the contract and its digests describe. Before judging the
   * criterion the verifier registry re-reads every declared input and refuses
   * the verdict — `fail`, naming the path — when one is missing or its bytes
   * changed, so a rewritten acceptance script can never turn a wrong product
   * into a pass. Only declared paths are protected; a criterion that declares
   * none carries no protection and must not be described as protected.
   */
  protectedInputs?: ProtectedInputRef[];
}
/**
 * One protected acceptance input ({@link AcceptanceCriterion.protectedInputs}):
 * the path as declared, plus the SHA-256 of the file's bytes fixed when the
 * task was admitted. The path is resolved against the same checkout directory
 * the criterion's judge runs in, both at admission and at the pre-judgement
 * re-check.
 */
interface ProtectedInputRef {
  /** The input path as declared, resolved against the run's checkout directory. */
  path: string;
  /** SHA-256 (lowercase hex) of the file's bytes at admission. */
  sha256: string;
}
/**
 * One entry of a parent criterion's evidence map ({@link
 * AcceptanceCriterion.childEvidence}): a child of the decomposing task, named
 * by its position in the decomposition batch — the only child identity that
 * exists when the parent's criteria are authored, since child task ids are
 * minted by the orchestrator at decomposition time. Existence of the mapping
 * target is an acceptance-time question; admission validates the shape only.
 */
interface ChildEvidenceRef {
  /** Position of the child in the parent's decomposition batch (0-based). */
  childIndex: number;
  /** The child criterion whose passing verdict is required; absent requires only the child's verified state. */
  criterionId?: string;
  /** The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence; absent requires only the child's evidence. */
  evidenceRef?: string;
}
interface TaskDefinition {
  taskType: string;
  version: number;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredCapabilities: string[];
  decompositionPolicy: {
    allowed: boolean;
    maxDepth?: number;
    maxChildren?: number;
  };
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
  /**
   * The task's goal: the projection of {@link contract} (or, on a task created
   * before the contract existed, the whole of what the store holds). Never an
   * independent source — the store refuses an event whose projection disagrees
   * with the contract it carries.
   */
  objective: string;
  depth: number;
  /** The criteria the verifier judges: the projection of {@link contract}, checked for disagreement on write. */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Capability requirements by name: the projection of {@link TaskContract.requiredCapabilities}. */
  requestedCapabilities: string[];
  decompositionStatus: DecompositionStatus;
  status: TaskStatus;
  runIds: RunId[];
  childTaskIds: TaskId[];
  /**
   * The normalized contract this instance was created from (T1, construction
   * guide §4): defaults filled, criterion ids fixed, assumptions and
   * constraints persisted rather than left in a spawn prompt. Absent on tasks
   * created before the field existed — their contract *is* the three
   * projection fields above, read exactly as before, with nothing invented for
   * the parts the store never held (no assumptions, no constraints, no
   * version).
   */
  contract?: TaskContract;
  /**
   * Contract-level marker (KISS §6 C2): this task's acceptance must be decided
   * by its own criteria and evidence map, never by the composite "all children
   * verified" conjunction alone. Admission refuses a creation or decomposition
   * whose task carries the marker while none of its criteria carries a
   * {@link AcceptanceCriterion.childEvidence} map — deleting or never writing
   * the map can never silently degrade the task back to the conjunction.
   * Absent on every task that predates the field; a stored task's criteria are
   * immutable, so the marker is only ever set at creation time.
   */
  requiresIndependentAcceptance?: boolean;
}
interface DependencyEdge {
  from: TaskId;
  to: TaskId;
}
/** DFS over an edge list: true when `target` is reachable from `start`. */
declare function reaches(edges: readonly DependencyEdge[], start: TaskId, target: TaskId): boolean;
type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled';
/**
 * One skill a run's grant was built from, as the admission-time provider
 * pre-check judged it (S1-C item 4). The run *loaded* these bytes — the record
 * is what lets a reader tell which version an execution ran against after the
 * production files have moved on.
 *
 * Identity here is content identity, the same vocabulary the pre-check and the
 * evolution ledger use: `contentDigest` covers the `SKILL.md` bytes plus every
 * declared resource, `contractDigest` the sidecar the provider was validated
 * against. Both are recomputable from the run's own snapshot, which is what
 * makes "is this still the content the run was bound to?" a question a reader
 * can answer instead of trust.
 */
interface RunSkillBinding {
  /** The skill name a capability granted; the snapshot directory is named after it. */
  name: string;
  /** How the pre-check accepted it — execution provider, loadable knowledge, or plain guidance. */
  role: 'execution-provider' | 'knowledge' | 'guidance';
  /**
   * The run's capability rows that grant this skill, sorted: the capability names
   * a worker's summary groups its providers under, read from the record rather
   * than re-derived from the store.
   */
  capabilities: string[];
  /** The purpose the skill declares for itself, so a summary can say what the provider is for without reading its body. */
  description: string;
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null;
  /** `skillContentDigest` of the bytes the run loaded. */
  contentDigest: string;
  /**
   * Entries of the source skill directory the identity does not cover (a
   * guidance skill's extra files, a directory reads as `name/`). They are not in
   * the snapshot either, so naming them is the honest statement of what this
   * binding does not include; empty for a provider whose identity covers its
   * whole directory.
   */
  uncovered: string[];
}
/**
 * One MCP server a run's manifest granted: the registry key it resolved through
 * and the identity of the template it resolved to. The resolved spec carries
 * machine paths, so the template — the part a deployment edits — is what is
 * digestible; `null` means the registry held no such key, which the spawn then
 * refuses by name.
 *
 * **Diagnostic only.** The digest records what the run *rendered* at bind
 * time; nothing re-reads the registry to compare, so it is not an execution
 * identity and no consumer may treat a matching digest as proof that the
 * server that actually started mounted those bytes. The spawn's own failure is
 * the enforcement for a missing server; a template edited between binding and
 * spawn is not caught here.
 */
interface RunMcpServerBinding {
  /** The server name the capability declared and the worker's tools are namespaced under. */
  serverName: string;
  /** SHA-256 over the registry template the name resolved to, or `null` when the registry holds no such name. Diagnostic (see the interface note): never an execution identity. */
  templateDigest: string | null;
}
/**
 * What one run resolved against and loaded (S1-C item 4): the registry revision
 * the admission-time pre-check computed, the identity of every skill the run's
 * grant was built from, the MCP servers its manifest granted, and — when the
 * run loaded content at all — the run-scoped snapshot root those bytes were
 * materialized into.
 *
 * Why it exists next to {@link TaskRun.capabilitySnapshot}: the snapshot names
 * what was granted, this names the *bytes* that were granted. A capability row
 * can be edited, a production `SKILL.md` rewritten, a skill replaced outright;
 * a run that recorded only names cannot say which version it executed, and a
 * reader cannot tell whether the content it can see now is the content the run
 * was bound to.
 *
 * Absent members mean "not bound", never "bound to nothing": a run that loaded
 * no skill carries an empty `skills` list and no `snapshotRoot`, and a field
 * the record does not carry is never invented for it.
 */
interface RunProviderBinding {
  /**
   * The registry revision the admission-time provider pre-check computed for
   * this run's table and accepted providers (`provider-precheck.ts:registryRevision`):
   * two runs citing the same revision resolved the same rows over the same
   * declared provider content.
   */
  registryRevision: string;
  /**
   * Every capability row this run's manifest matched, sorted — including a row
   * that grants no skill (its tools are granted without a provider). The summary
   * a worker reads lists its capabilities from here, so a node that wants to
   * re-decompose or delegate never has to guess a capability name.
   */
  capabilities: string[];
  /**
   * One entry per skill the run's grant was built from, sorted by name. A skill
   * two capabilities declare appears once, naming both.
   */
  skills: RunSkillBinding[];
  /** The MCP servers the run's manifest granted, in first-declaration order. */
  mcpServers: RunMcpServerBinding[];
  /**
   * Absolute path of this run's snapshot skill root — the directory whose
   * `<name>/SKILL.md` entries the worker's skill layer registers — present
   * exactly when the run materialized the content it was bound to. A reader
   * re-checks the bytes there against this record's digests; a missing or
   * changed snapshot is a refusal to report, never a silent fallback to the
   * production path.
   */
  snapshotRoot?: string;
}
/**
 * Where one run sits in the A3 coordination protocol. `active` is the phase a
 * run is born in, and the only one in which it may write, decompose or
 * submit; `waiting_children` is a run whose decomposition batch was admitted
 * atomically and whose children have not all settled; `submitted` is a run
 * that handed in a {@link SubmissionRecord} and is waiting for (or inside)
 * verification.
 *
 * The phase — not the run status — is the admission gate: a run in
 * verification still carries status `running`, so `submitted` is what refuses
 * a second submission, a write after the gate closed, and a decomposition
 * admitted too late (A3 §1.2/§2).
 *
 * Absent on every run created before the field existed: such a run's phase is
 * unknown and is never guessed. A non-terminal phase-less run is reported as
 * `needs-recovery` — its only legal continuation is cancellation — and the
 * reducer refuses phase changes for it (A3 §3.6).
 */
type ExecutionPhase = 'active' | 'waiting_children' | 'submitted';
/**
 * What one run handed in when it submitted (A3 `task_submit_result`, or the
 * runtime settling a parent whose children all reached terminal states): the
 * submitter's own account plus the references it names as proof. Written onto
 * the run by the transition into `submitted`; that phase is terminal for the
 * transition gate, so the record is written once and never overwritten — a
 * late submission is answered from the record, not applied.
 *
 * `origin` keeps a worker's self-report apart from the runtime's automatic
 * one: only `worker` means the run's own agent made the claim.
 */
interface SubmissionRecord {
  /** What was delivered, in the submitter's words (runtime-generated for an automatic submission). */
  summary: string;
  /** The evidence ids, artifact refs, or review refs the submitter names as proof. */
  evidenceRefs: string[];
  /** Anything further a reader should know; absent when the submitter left none. */
  notes?: string;
  /** When the submission was recorded — the phase-change event's own timestamp. */
  submittedAt: string;
  /** Who submitted: the worker through its explicit call, or the runtime settling the run. */
  origin: 'worker' | 'runtime';
}
/**
 * One no-progress marking on an `active` run (A3 `RunProgressMarked`): the
 * observable record that a worker went idle where a submission was due. It is
 * a diagnostic, not an accumulator — every marking overwrites the previous
 * one, and `rounds` is the caller's own consecutive count, so replay and live
 * observation agree on the last state.
 *
 * Absent on a run that was never marked, on a run whose phase is not `active`
 * (a run waiting on children or on verification is expected to be idle), and
 * on every run written before the field existed.
 */
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
interface TaskRun {
  runId: RunId;
  taskId: TaskId;
  sessionId: string;
  parentRunId?: RunId;
  capabilitySnapshot: string[];
  agentPreset?: string;
  /**
   * What this run was bound to and loaded (S1-C item 4). Absent on every run
   * created before the field existed, and on a run whose caller assembled its
   * plan without an admission-time pre-check: neither loaded content this build
   * can vouch for, and neither is retroactively given a claim.
   */
  providerBinding?: RunProviderBinding;
  /**
   * Where this run sits in the A3 coordination protocol. A new run is born
   * `active`, or `submitted` when it has no worker at all (a `spawn: false`
   * replay). Absent on every run created before the field existed; its phase
   * is read as unknown, never defaulted to `active`.
   */
  executionPhase?: ExecutionPhase;
  /**
   * The decomposition batch this run waits on, `b-<parentTaskId>` — the
   * deterministic id a run records when it enters `waiting_children`. The
   * parent decomposes once (the phase gate refuses a second batch), so the id
   * needs no minted uniqueness. Absent on a run that never admitted a batch.
   */
  batchId?: string;
  /**
   * What this run handed in, written by the transition into `submitted`.
   * Absent on a run that has not submitted; its presence is what makes a
   * second submission a refusal rather than an overwrite.
   */
  submission?: SubmissionRecord;
  /**
   * Question ids the run is waiting on (A4 mount point). A3 never writes a
   * non-empty value; the field exists so the shape has one owner, and the
   * reducer carries whatever A4 writes through phase changes unchanged.
   */
  pendingQuestionIds?: string[];
  /** Question ids whose answers block this run's next step (A4 mount point); see {@link pendingQuestionIds}. */
  blockingQuestionIds?: string[];
  /**
   * The last no-progress marking on this run (A3). Overwritten by each
   * `RunProgressMarked`; absent until a caller marks one, and on every run
   * written before the field existed.
   */
  noProgress?: NoProgressRecord;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}
interface VerificationResult {
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  /**
   * The version of the registered verifier instance that produced this verdict
   * (S1-V slice 2, KISS §8.2): stamped by the verifier registry from the
   * instance it actually dispatched to — never from the criterion's own text
   * or from the verifier's returned object. Absent when the registered
   * instance declares no version, and on verdicts written before the field
   * existed; a later version change never rewrites historical verdicts.
   */
  verifierVersion?: string;
  command?: string;
  exitCode?: number;
  logRef?: string;
  details?: string;
  /**
   * Which side an `inconclusive` verdict belongs to (KISS §4.3's UNKNOWN
   * split): `task` when the check never ran (timeout, the command never
   * started) — the criterion was never tested; `verifier` when the judge
   * itself is broken (the verifier threw, or none supports the mode). Absent
   * on pass/fail and on a by-design inconclusive (a review criterion awaiting
   * a human). Confusing the two kinds makes the system re-test the same thing
   * forever, so the orchestrator's feedback text keeps them apart.
   */
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
    /**
     * MCP server names the capability grants, resolved against the task
     * runtime's server registry at admission and mounted per worker at spawn
     * (`mcp__<server>__<tool>` on the worker's own tool layer). Absent = none.
     */
    mcpServers?: string[];
  }>;
  missing: string[];
  closure: 'closed' | 'partial' | 'gap';
}
/** The terminal outcome one run (or a child blocked before its run ever started) settled in. */
type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked';
/**
 * One criterion's verdict as the verifier reported it, copied onto the review
 * record so a reader sees what was checked — command and exit code included —
 * without replaying the run or opening the evidence bundle.
 */
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
  /**
   * Which side an inconclusive verdict belongs to, copied from the verifier
   * result so a review reader (and the E3 escalation signal) can tell "the
   * check never ran" (`task`) from "the judge is broken" (`verifier`) without
   * reopening the evidence bundle.
   */
  unknownKind?: 'task' | 'verifier';
}
/** One dependency whose outcome kept a blocked task from ever starting a run. */
interface ReviewBlocker {
  taskId: TaskId;
  /** The dependency's task status at the moment this task settled blocked. */
  outcome: TaskStatus;
}
/**
 * The four token buckets a session's `tokenUsage` projection reports, copied
 * verbatim from that projection's wire view (upstream
 * `llm/token-meter/src/usage-projection.ts:117-150`). Cumulative for the whole
 * session, not for one run — see {@link ReviewMetrics.tokens}.
 */
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
/**
 * Dimension 1, outcome correctness: the terminal status the run settled in and
 * what the verifier said per criterion. Both facts already exist on the record
 * (`outcome`, `criteria`); this restates them in derived form so a reader gets
 * the verdict tally without re-scanning `criteria`.
 *
 * Limitation: this says what was decided, never whether the decision was right.
 * "Correct" is not mechanically observable — it is exactly what Diagnosis exists
 * to explain (§2.7.3).
 */
interface OutcomeCorrectnessFacts {
  outcome: ReviewOutcome;
  /** Criteria the record carries a verdict for; 0 when the verifier never reported. */
  criteriaCount: number;
  /** Ids of the criteria whose verdict was not `pass`. */
  unmetCriterionIds: string[];
}
/**
 * Dimension 2, task specification quality: how much specification the task
 * carried, as counts. Purely mechanical — a thin specification is a fact here,
 * not a verdict.
 *
 * Limitation: counts say nothing about whether the objective is understandable
 * or whether one criterion is doing the work of three. Present whenever the task
 * was readable.
 */
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
/**
 * Dimension 3, acceptance quality: each criterion's declared verification mode
 * and whether it hands the verifier a command.
 *
 * Limitation: mode and command presence are the only mechanically observed
 * facts here. Whether a criterion actually pins down the intended behaviour is a
 * judgement this record deliberately does not make; a `review`-mode criterion
 * (no command) is recorded as such, not as a defect.
 */
interface AcceptanceFacts {
  criteria: AcceptanceCriterionShape[];
}
/**
 * Dimension 4, decomposition quality: the position and shape of this task in
 * the decomposition tree at review time.
 *
 * Limitation: shape only. Whether the split was a *good* split is not derivable
 * from depth, child count, or edge count, and no threshold is applied to any of
 * them.
 */
interface DecompositionFacts {
  depth: number;
  decompositionStatus: DecompositionStatus;
  childCount: number;
  /** Dependency edges whose target is this task (must verify before it starts). */
  incomingEdges: number;
  /** Dependency edges whose source is this task (it must verify before they start). */
  outgoingEdges: number;
}
/**
 * Dimension 5, capability coverage: what the task's resolved manifest granted
 * and what it could not resolve.
 *
 * Limitation: this is the admission-time resolution, not a claim that the
 * granted capability was the *right* one for the work. The flattening of skills
 * and tools into `granted` mirrors `capabilitySnapshot` and loses which
 * capability contributed which name.
 */
interface CapabilityCoverageFacts {
  /** The manifest's closure verdict: `closed` when nothing required was missing. */
  closure: CapabilityManifest['closure'];
  /** Flattened skills+tools of the resolved manifest — exactly the list a run records in its `capabilitySnapshot`. */
  granted: string[];
  /** Required capability names the registry could not grant. */
  missing: string[];
}
/**
 * Dimension 6, skill fit: skills the run's capabilities granted against skills
 * the session's log shows the `skill` tool actually loading.
 *
 * Limitation: `loaded` and `loadedOutsideGrant` appear only when the deployment
 * exposes a readable session log, and they are session-scoped — a session that
 * loaded a skill before any run existed still counts. Loading a skill is not
 * evidence that its instructions changed the work.
 */
interface SkillFitFacts {
  /** Skill names the run's capabilities granted. */
  granted: string[];
  /** Skill names the session's `skill` calls loaded, deduplicated and sorted; absent when no log was readable. */
  loaded?: string[];
  /** Loaded skill names outside `granted`; empty means every load was covered by the grant. */
  loadedOutsideGrant?: string[];
}
/**
 * Dimension 7, tool fit: tools the run's capabilities granted (plus the worker
 * baseline) against tools the session's log shows being called.
 *
 * Limitation: the comparison is against capability grants and
 * `workerBaseline()`, not against what the mounted preset offers, so a worker
 * on a preset that keeps its own tool plane (`keepPresetTools`) can show names
 * in `calledOutsideGrant` that were in fact authorized by its composition. Names
 * are compared as the log records them; a tool reached through a wrapper is not
 * attributed. `called` and `calledOutsideGrant` appear only with a readable log.
 */
interface ToolFitFacts {
  /** Real DSH tool names the run's capabilities granted (labels expanded at admission). */
  granted: string[];
  /** Tool names the session shows being called, with counts; absent when no log was readable. */
  called?: ReviewToolCall[];
  /** Called names outside `granted` ∪ `workerBaseline()`; empty means every call was covered. */
  calledOutsideGrant?: string[];
}
/**
 * Dimension 8, context efficiency: only numbers that can be read reliably, and
 * nothing that rates them.
 *
 * Limitation: `tokens` is the same whole-session cumulative observation as
 * {@link ReviewMetrics.tokens} — for a long-lived root session it covers the
 * entire session, not this run, so it is systematically high. `compactions`
 * counts `compaction/start` events in the session. No ratio, budget, or
 * efficiency judgement is derived from either; absent when neither was readable.
 */
interface ContextEfficiencyFacts {
  /** Whole-session token buckets; the same value {@link ReviewMetrics.tokens} carries. */
  tokens?: ReviewTokenUsage;
  /** `compaction/start` events observed in the session log. */
  compactions?: number;
}
/**
 * The eight review dimensions (§2.7.3), each carrying mechanically observed
 * facts — never a score, never an LLM judgement, never transcript text. Every
 * member is optional and is omitted, not defaulted, when the data behind it does
 * not exist. A dimension answers "what did the system actually do here", leaving
 * "why" to Diagnosis.
 */
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
/**
 * The six engineering-effort indicators, as counters. Every member is optional
 * and is omitted rather than filled with a placeholder when its source is
 * unavailable.
 *
 * `time` is deliberately absent: wall-clock duration already lives in
 * {@link ReviewRecord.durationMs} (run `startedAt` → the terminal transition,
 * verification included) and is not duplicated here.
 *
 * `artifactCount` is deliberately absent and is not `evidenceLogs`: nothing in
 * the deployment produces an `ArtifactRef` (the type has no writer, and
 * `TaskRun.artifacts` is always empty), so there is no trustworthy artifact
 * count to record. `evidenceLogs` counts criteria that carried a `logRef`
 * instead, and is named for what it measures.
 */
interface ReviewMetrics {
  /**
   * Provider-reported, whole-session token buckets from the session's
   * `tokenUsage` projection. Limitation: the projection folds the entire
   * session, so for the long-lived root session this is a session total, not a
   * per-run figure, and it reads systematically high. Absent when the
   * deployment exposes neither `sessionProjections` nor that key.
   */
  tokens?: ReviewTokenUsage;
  /** Session tool traffic; absent when no session log was readable. */
  toolCalls?: ReviewToolCallTotals;
  /**
   * Count of human-intervention events in the session log: `approval/asked`
   * plus calls to `hitl_ask` / `hitl_approve` / `ask_user_question`.
   * Limitation: the count is session-scoped, and only `ask_user_question` is a
   * worker tool — `hitl_*` are root tools, so interventions across the whole
   * tree land on the root's record. A worker record showing 0 does not mean no
   * human was involved anywhere in its tree.
   */
  humanInterventions?: number;
  /**
   * `TaskStarted` count minus one for this task (`TaskInstance.runIds.length - 1`).
   * Limitation: the current orchestrator has no retry branch, so this is
   * structurally always 0 — a reader must not conclude "it was tried again and
   * did not need to be" from it. Omitted for a runless (blocked) task.
   */
  retries?: number;
  /** Criteria on this record that carry a `logRef` — where the evidence for a verdict was written. */
  evidenceLogs?: number;
}
/**
 * One lightweight terminal record per run, written exactly once when the run
 * reaches its terminal state. No scoring and no judge — a human reads it.
 * `localizedCause` is written only for `failed`; `anomalies` notes what is
 * otherwise notable (for `blocked`, which dependency blocked it).
 * The record is self-contained for a postmortem: `durationMs`, per-criterion
 * `criteria`, a truncated `logTail` on failure, and structured `blockedBy`
 * name the what and the why without a trip into evidence or logs.
 *
 * §2.7.3 makes Diagnosis, not Score, the first-class citizen: `dimensions`
 * therefore holds mechanically observed facts per review dimension (never a
 * rating, never an LLM judgement, never transcript text) and `metrics` holds
 * engineering-effort counters. Both are optional throughout and are omitted
 * rather than guessed when their source does not exist.
 */
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
/**
 * How sure the diagnoser is of its localized cause. Coarse on purpose
 * (§2.7.3: Review ≠ Judge — a diagnosis explains, it does not score).
 */
type DiagnosisConfidence = 'high' | 'medium' | 'low';
/**
 * The nine mutation surfaces a proposal may point at (§2.7.6). Frozen now
 * because the P5 Evolution registry consumes this exact vocabulary.
 */
type ProposalTargetType = 'skill' | 'tool' | 'capability' | 'task_definition' | 'decomposition_policy' | 'agent_preset' | 'workflow_policy' | 'verifier' | 'runtime_policy';
/**
 * One structured suggestion a diagnosis raises. In P4 a proposal never
 * executes by itself (§2.7.6: no automatic production changes); it is data
 * for a human or a later Evolution step.
 */
interface DiagnosisProposal {
  targetType: ProposalTargetType;
  targetId: string;
  rationale: string;
}
/**
 * The six review dimensions whose conclusion is not mechanically observable
 * (§2.7.3): the fact table records what the run did, and only a reader holding
 * the whole context can say whether what it did was adequate. The other two
 * dimensions are deliberately absent — `outcome_correctness` tallies the
 * verifier's own verdicts and `capability_coverage` reports the admission-time
 * `closed`/`partial`/`gap` closure, so both settle mechanically and need no
 * judgement. Names are the snake_case spelling of the `ReviewDimensions`
 * members, so a judgement and the facts it rests on read as one dimension.
 */
type JudgedDimension = 'task_specification' | 'acceptance' | 'decomposition' | 'skill_fit' | 'tool_fit' | 'context_efficiency';
/** Every judged dimension, in the order a report reads them. */
declare const JUDGED_DIMENSIONS: readonly JudgedDimension[];
/** One dimension's coarse conclusion. Three values on purpose — this is not a rating scale. */
type JudgementVerdict = 'adequate' | 'inadequate' | 'unknown';
/** Every judgement verdict, for reducer validation and rendering. */
declare const JUDGEMENT_VERDICTS: readonly JudgementVerdict[];
/**
 * One judged dimension: an agent's (or a person's) conclusion over the facts a
 * `ReviewRecord` carries. Still not a score — `verdict` is a coarse three-way
 * call, `evidenceRefs` names what it rests on, and `rationale` states the
 * reasoning. When the evidence does not settle a dimension the verdict must be
 * `unknown`, never a guess.
 */
interface ReviewJudgement {
  /** Which dimension this concludes; only the six non-mechanical ones are judgeable. */
  dimension: JudgedDimension;
  /** The conclusion: adequate, inadequate, or unknown. */
  verdict: JudgementVerdict;
  /**
   * Refs the judgement rests on: evidence ids, the review refs
   * `task_review_pack` prints (`<taskId>#<runId>`, or `<taskId>#no-run`), or
   * session ids. Required and non-empty — a conclusion that cites nothing is
   * not reviewable.
   */
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
/**
 * The core product of review (§2.7.3): an explanation of what a task's
 * reviews show, not a score. Diagnosis lineage is a graph, not a tree
 * (§2.7.4): `reviewRefs` may name several records and `relatedTaskIds` may
 * point across tasks. Written once per `diagnosisId`, immutable afterwards;
 * a task accumulates as many diagnoses as callers record.
 */
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
  /**
   * Who wrote this diagnosis. Absent on records written before this field
   * existed, and on any writer that does not declare itself; absence is read as
   * human-written (the only producer there was).
   */
  producedBy?: DiagnosisProvenance;
  /**
   * The six judged dimensions, when the writer made explicit calls. Optional: a
   * diagnosis may explain a cause without judging every dimension, and an
   * all-`unknown` judgement is a legitimate outcome — it says the evidence did
   * not settle the dimension, which is itself information.
   */
  judgements?: ReviewJudgement[];
}
/**
 * One executable selftest sample (KISS §4.3): the criterion a verifier is
 * handed, the store view a store-reading judge is judged against, and the
 * verdict a healthy verifier must return for the sample to count as proof that
 * the verifier can tell the sample's side apart.
 *
 * Samples are data, and the registry executes them — a verifier cannot prove
 * its selftest by describing it. A sample the registry cannot execute (a store
 * view for a judge the registry cannot run against one) refuses registration
 * rather than being skipped.
 */
interface VerifierSelftestSample {
  /** Which side of the discrimination this sample proves. */
  role: 'positive' | 'negative';
  /** Human-readable sample name; the refusal text names the missed sample by it. */
  name: string;
  /** The sample criterion handed to the verifier. */
  criterion: AcceptanceCriterion;
  /**
   * The verdict a healthy verifier returns for this sample: `pass` for a
   * known-good sample; `fail` for a known-bad sample; `not-pass` for a sample
   * that must merely never be auto-passed (a never-auto-pass judge such as the
   * review verifier, where "known-good is not auto-passed" plus "known-bad is
   * not judged pass" is the equivalent form the sample pair takes).
   */
  expect: 'pass' | 'fail' | 'not-pass';
  /** The store view a store-reading judge is judged against; absent for a judge that judges the criterion alone. */
  store?: VerifierSelftestStore;
}
/**
 * The task-store view one store-reading selftest sample is judged against
 * ({@link VerifierSelftestSample.store}): the child tasks the criterion is
 * judged over, plus the runs and evidence bundles a judge reads for the
 * children's verified states and verdicts. Everything else a full snapshot
 * carries is empty in a sample.
 */
interface VerifierSelftestStore {
  /** The sample task's children, by batch position — exactly what a store-reading judge's child lookup returns. */
  children: TaskInstance[];
  /** Runs the sample judge reads (a child's verified run); `[]` when the sample needs none. */
  runs?: TaskRun[];
  /** Evidence bundles the sample judge reads; `[]` when the sample needs none. */
  evidence?: EvidenceBundle[];
}
/**
 * A verifier's executable known-sample proof (KISS §4.3 `selftest`): the
 * samples the verifier must mechanically distinguish before the registry will
 * register it — at least one known-good sample and at least one known-bad one,
 * each executed through the verifier and compared against the verdict the
 * verifier declared. A missed negative sample (the known-bad case judged
 * `pass`) or a positive sample that is not accepted makes the verifier
 * unavailable, and the refusal names the sample.
 *
 * What this proves and what it does not: that the verifier, as registered,
 * returns the declared verdicts for its own declared samples — a regression
 * gate against a judge that cannot tell its known cases apart. It does not
 * prove the samples are meaningful, that the verifier is independent from any
 * executor, or that its verdicts are right on real products.
 */
interface VerifierSelftest {
  /** Executable samples; a healthy verifier returns `expect` for every one of them. */
  samples: VerifierSelftestSample[];
}
interface Verifier {
  id: string;
  /**
   * Registry metadata (KISS §4.3): a version so a later verdict recall can
   * index evidence by `(verifierRef, version)` (KISS §8.2) — the registry
   * stamps it onto every verdict and claim it dispatches, so the recorded
   * version is the registered instance's, never a self-report — and an owner
   * so the execution/judgement separation (I3) has something to compare
   * against the executing skill's owner.
   */
  version?: string;
  owner?: string;
  /**
   * The verifier's executable known-sample proof ({@link VerifierSelftest}).
   * Required to register: {@link VerifierRegistry.register} executes every
   * sample and refuses the verifier when one is missed, and refuses a
   * registration without samples — a descriptive selftest is not a selftest.
   * Only an explicit, documented test-double registration skips the gate.
   */
  selftest?: VerifierSelftest;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
}
/**
 * One structured record of what is still missing (KISS §2/§5): an Obligation
 * is a question, not an action — `goal` names the gap, `criterion` says how its
 * satisfaction would be judged, and `sourceTaskId` names the task whose
 * failure, block, or capability gap surfaced it. Recorded, never scheduled:
 * the runtime has no obligation scheduler, so nothing here auto-executes.
 */
interface Obligation {
  obligationId: string;
  /** What is still missing, as a question or a named gap. */
  goal: string;
  /** How a reader would judge the obligation satisfied. */
  criterion: string;
  /** The task whose terminal transition (or rejected admission) raised it. */
  sourceTaskId: TaskId;
}
interface VerifyRequest {
  taskId: TaskId;
  runId: RunId;
  criteria: AcceptanceCriterion[];
  cwd: string;
  logDir: string;
  timeoutMs?: number;
}
/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
declare const RootTaskSpec: Pick<TaskDefinition, 'taskType' | 'version' | 'acceptanceCriteria' | 'requiredCapabilities' | 'decompositionPolicy'>;
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
  /**
   * The store's proposals, indexed for the three questions a review gate asks
   * (§6/§7): by proposal id, by the caller's request key, and by parent task.
   * Root contracts (A0 §2) are in the first two views only: they have no parent
   * task to be indexed under.
   *
   * Optional at the type level because a snapshot is also a shape other code
   * builds by hand (a verifier's selftest store view, a test double), and those
   * literals predate proposals. A snapshot produced by this build's reducer
   * always carries it — empty members included — so an absent index means "this
   * reader cannot see proposals", never "the store holds none"; see
   * {@link TaskProposalIndex}.
   */
  readonly proposals?: TaskProposalIndex;
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
  /** A decomposable task's children are registered and the parent closes as decomposed. */
  TaskDecomposed: {
    childTaskIds: TaskId[];
    /**
     * The batch's content identity and the limits it was admitted under
     * (construction guide §4). Absent for a batch admitted before the
     * normalized contract existed — those children carry no contract either,
     * and nothing is invented for them on read.
     */
    admission?: DecompositionAdmission;
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
  /**
   * A running run's coordination phase changes (A3). The transition is the
   * admission gate: `active → waiting_children` when its decomposition batch
   * is admitted atomically, and `→ submitted` when it hands in a submission
   * (explicitly or by runtime settlement). Replaying the store reconstructs
   * exactly one path through {@link ExecutionPhase}, so a second submission, a
   * decomposition admitted after the gate closed, and any late phase write are
   * refused by the phase alone — the run status stays `running` through
   * verification and cannot serve as that gate.
   *
   * A refused transition applies nothing: the reducer validates the whole
   * payload before the run is touched.
   */
  RunPhaseChanged: {
    phase: ExecutionPhase;
    /** The batch a `waiting_children` run waits on (`b-<parentTaskId>`); required for that phase and refused elsewhere. */
    batchId?: string;
    /** The record a `submitted` run hands in; required for that phase and refused elsewhere. */
    submission?: SubmissionRecord;
    /** A4: question ids the run waits on; the reducer checks shape only and carries them unchanged. */
    pendingQuestionIds?: string[];
    /** A4: blocking question ids; same handling as `pendingQuestionIds`. */
    blockingQuestionIds?: string[];
    /** The caller's account of the transition, when a reader needs one. */
    reason?: string;
  };
  /**
   * A run was observed idle without submitting (A3): the no-progress record a
   * reader shows before the budget stops a stuck run. Only an `active` run
   * accepts a marking — a run waiting on children or on verification is
   * expected to be idle, and marking it would count a legitimate wait as
   * stagnation. `rounds` is the caller's consecutive count; the reducer
   * records the number it is given and never accumulates, so replay agrees
   * with live observation.
   */
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
  /**
   * A proposal enters the store (T2/T3, construction guide §6; root contracts
   * A0 §2): one immutable submission with the policy it was born under, the
   * complete normalized contracts it proposes, the limits it was admitted
   * under, the resolution it was reviewed against, and both context
   * fingerprints. The batch content is what a reviewer reads and an approval
   * covers, so it is stored here rather than referenced: a waiting proposal, a
   * rejected one, or a re-opened store renders it from saved facts. A proposal
   * is born `ready` under policy `off` (the batch runs without a human review,
   * and the record says so) or `pending_review` under policy `all`; the reducer
   * refuses a record that claims the other combination, refuses a payload that
   * disagrees with the identity it accompanies (length, order, contract digest,
   * dependencies, flags — or, for a root contract, a contract that is not the
   * one the identity digests), and refuses a proposal whose digests do not
   * match the content they claim to describe. Nothing is admitted, no child
   * exists, and no parent is marked decomposed by this event — a proposal is a
   * question, not work.
   *
   * The record is discriminated by `kind` (`decomposition`, the batch shape
   * above, or `root`, a single root contract for a root session); an absent kind
   * is a decomposition proposal, which is what every record written before the
   * field existed is. A root contract has no parent task, so its events carry
   * the reserved `ROOT_PROPOSAL_TASK_ID` marker on the envelope instead — never
   * a real task id, and a decomposition proposal's events may never carry the
   * marker.
   */
  TaskProposalSubmitted: {
    proposal: TaskProposal;
  };
  /**
   * A human review decision (T2/T3, §6): approved, rejected, cancelled or
   * expired, bound to the dossier digest and both context fingerprints shown
   * when it was taken. The reducer refuses a decision whose digests disagree
   * with the stored proposal and one that is not legal from the proposal's
   * current status — so an approval can never travel to a revision, a
   * re-resolution or a re-checked context, and a later approval of a batch
   * whose parent run has ended is written as `expired` (an invalidation)
   * rather than as an approval nobody could dispatch.
   */
  TaskProposalDecided: TaskProposalDecisionClaim;
  /**
   * A runtime-driven proposal phase change (T2/T3, §6): to `pending_review`
   * when the deployment tightens to `all` while a policy-off proposal is still
   * un-admitted (only tightening is allowed; a waiting proposal is never
   * released), to `ready` when an approval passed its post-approval re-check,
   * and to `stale` when that re-check found the context or the parent state
   * changed. The reducer checks the change against the status table — a
   * re-review of a proposal already awaiting review, a re-check pass without an
   * approval, and a stale marking of an admitted batch are all refused.
   */
  TaskProposalPhaseChanged: TaskProposalPhaseChange;
  /**
   * A proposal is consumed (T2/T3, §6; root contracts A0 §2): what it asked for
   * now exists, bound to the ids this event carries. For a decomposition batch
   * that means the child task ids and the batch id, written in the same commit as
   * the children, the decomposition record and the parent run's `active →
   * waiting_children` change (A3 `admitBatchIn`), so a crash after admission is
   * recovered from the log alone — "this proposal was consumed and these are its
   * tasks" is one durable fact, never a second batch. For a root contract it
   * means the one root task and root run the activation minted, written in the
   * same commit as both (`admitRootProposalIn`), so the same crash is recovered
   * the same way and never mints a second root. The reducer refuses a second
   * consumption of one proposal, a consumption whose digests do not match what
   * was approved, a batch consumption whose batch id or child ids do not match
   * what the store holds, and a root consumption naming anything but the store's
   * one parentless task and its own born-active root run.
   */
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
//#region src/skill-contract.d.ts
/**
 * The typed skill sidecar contract: the declaration that sits beside a skill's
 * `SKILL.md` (`SKILL.contract.json`) and says what kind of skill it is, what it
 * provides, and exactly which bytes it is.
 *
 * Why a sidecar exists at all (guide §2.4): DSH's `SKILL.md` carries both
 * executable capability and domain knowledge, and the two need different
 * guarantees. An execution skill must name the capabilities it serves, the real
 * DSH tools it needs, and the registered verifier that judges its result, so a
 * caller can refuse it *before* a run rather than discovering the gap at spawn.
 * A knowledge skill has no execution verifier and must not pretend to have one:
 * it declares where its content comes from, what it applies to, and how to
 * check the content, and it never closes an execution gap.
 *
 * The identities here are content identities, on the same discipline as the
 * task contract (`./contract.ts`): the digest covers exact bytes — no trim, no
 * newline conversion — and a skill whose directory holds a file the
 * declaration does not cover is not "mostly covered"; it is refused. A reader
 * must never be able to summarize one file and silently miss another part of
 * what a worker will read.
 *
 * This module owns the vocabulary and the shape rules only (both are pure): the
 * filesystem load, the identity comparison against real bytes, and the unified
 * pre-check live in `task-runtime/src/sidecar.ts`, which consumes these
 * definitions instead of restating them.
 * @module @dangosys/dsh-singularity-task/skill-contract
 */
/**
 * The sidecar file, read as JSON, named exactly here so every producer and
 * reader of a skill directory agrees on one spelling.
 */
declare const SKILL_SIDECAR_FILE = "SKILL.contract.json";
/**
 * The sidecar contract version this build writes and reads. Like the task
 * contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
 * skill: a sidecar declaring a version this build does not know is refused
 * rather than read with the wrong field semantics.
 */
declare const SKILL_CONTRACT_VERSION: 1;
/** Every version of {@link SkillSidecar} this build can write or read. */
type SkillContractVersion = typeof SKILL_CONTRACT_VERSION;
/**
 * The directories a skill may hold supporting files in. The supported shape is
 * deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
 * be described by the identity without inventing rules for directories, and an
 * unsupported shape has to be refused by name rather than skipped.
 */
declare const SUPPORTED_SKILL_RESOURCE_DIRS: readonly string[];
/**
 * Whether one declared resource path is a path this contract can identify:
 * exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
 * POSIX separators, no `.`/`..` segment, nothing absolute. Anything else —
 * nested trees, a second segment, backslashes, a bare directory — is outside
 * the supported shape and is refused by name.
 */
declare function isSupportedSkillResourcePath(path: string): boolean;
/**
 * One supporting file's identity: where it is inside the skill directory and the
 * SHA-256 of its exact bytes.
 */
interface SkillResourceIdentity {
  /** Path relative to the skill directory, POSIX separators, `<dir>/<file>` per {@link isSupportedSkillResourcePath}. */
  path: string;
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string;
}
/**
 * What a sidecar claims about the bytes a worker will read: the `SKILL.md`
 * itself plus every supported resource, in one sorted list. A skill directory
 * holding a file this identity does not name is refused by the loader — the
 * point of the identity is that it covers the content, not most of it.
 */
interface SkillContentIdentity {
  /** SHA-256 of the exact `SKILL.md` bytes. */
  skillMdSha256: string;
  /** Every supported resource the identity covers, sorted by `path`, each path once. */
  resources: readonly SkillResourceIdentity[];
}
/**
 * One declared input or output of an execution skill. Ports are named in the
 * skill's own vocabulary; the runtime does not resolve them against artifacts
 * or inputs in v1, so they are a readable contract, not a wiring.
 */
interface SkillPort {
  /** Port name. */
  name: string;
  /** What the port carries, in the author's words, stored verbatim. */
  description: string;
  /** Whether the port must be satisfied for the skill to apply. */
  required: boolean;
}
/**
 * The registered judge an execution skill's result is verified by. Only the ref
 * is bound in v1: the registry exposes its ids (`VerifierRegistry.verifierIds()`)
 * and no per-ref version, so a version declared here could not be checked and
 * would be a field nobody consumes.
 */
interface SkillVerifierRef {
  /** Verifier id the registry is queried under; an unknown ref makes the skill an invalid provider. */
  ref: string;
}
/** An execution skill: it provides capabilities and is judged by a verifier. */
interface ExecutionSkillSidecar {
  contractVersion: SkillContractVersion;
  type: 'execution';
  /** Capability names this skill serves; at least one, each unique. */
  capabilities: readonly string[];
  /** What must hold before the skill applies, verbatim. */
  precondition: string;
  /** Declared inputs; `[]` when the skill declares none. */
  inputs: readonly SkillPort[];
  /** Declared outputs; `[]` when the skill declares none. */
  outputs: readonly SkillPort[];
  /** Real DSH tool names the skill needs, in the same vocabulary a capability expands to. */
  requiredTools: readonly string[];
  verifier: SkillVerifierRef;
  content: SkillContentIdentity;
}
/**
 * How a knowledge skill's content is checked. v1 knows one kind, `command`: a
 * check the deciding gate runs in the skill directory and reads the exit code
 * of. Nothing in this module — or in the loader — executes it; the reference is
 * validated as a declaration and carried, never run as a side effect of
 * validation.
 */
interface KnowledgeContentCheck {
  /** The one check kind this build recognizes. */
  kind: 'command';
  /** The command line, verbatim, to be executed by the gate that owns the decision. */
  command: string;
}
/**
 * A knowledge skill: guidance a worker may read, with no execution verifier and
 * no place in the execution closure. It declares its source and scope so a
 * reader can judge where the content came from and what it applies to.
 */
interface KnowledgeSkillSidecar {
  contractVersion: SkillContractVersion;
  type: 'knowledge';
  /** Where the content comes from, verbatim. */
  source: string;
  /** What the content applies to, verbatim. */
  scope: string;
  content: SkillContentIdentity;
  contentCheck: KnowledgeContentCheck;
}
/** The discriminated sidecar: `type` decides which field set is the closed one. */
type SkillSidecar = ExecutionSkillSidecar | KnowledgeSkillSidecar;
/**
 * The named kind of one declaration refusal. `unknown-version` and
 * `unknown-field` are their own codes because a caller acts differently on
 * them (one build-versions the reader, the other says which fields a type
 * carries); everything else is a shape defect inside the declared field set.
 */
type SkillContractDefectCode = 'sidecar-unknown-version' | 'sidecar-unknown-field' | 'sidecar-shape';
/** One reason a declared sidecar is not acceptable, with the kind of problem named. */
interface SkillContractDefect {
  code: SkillContractDefectCode;
  /** The readable reason, naming the field and the vocabulary it was checked against. */
  reason: string;
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
declare function skillContractDefects(value: unknown): SkillContractDefect[];
/**
 * The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
 * declared data, so key order and `undefined`-valued keys do not move it while
 * any declared field does. Call it on a sidecar that passed
 * {@link skillContractDefects}: an unvalidated object can carry fields this
 * identity would then cover without a rule saying what they mean.
 */
declare function skillContractDigest(sidecar: SkillSidecar): string;
/**
 * The identity of one content identity: SHA-256 over {@link canonicalize} of the
 * `SKILL.md` digest and the resource list. Separate from
 * {@link skillContractDigest} so a caller can name the bytes (a run recording
 * what it read) without claiming a sidecar it did not read.
 */
declare function skillContentDigest(content: SkillContentIdentity): string;
//#endregion
//#region src/service/state.d.ts
declare class TaskState {
  private value;
  constructor(id: string, snapshot?: TaskSnapshot);
  clone(): TaskState;
  snapshot(): TaskSnapshot;
  apply(event: TaskEvent): void;
  private addTask;
  /**
   * A task's contract is either absent — a task created before the contract
   * existed — or the single source its projection fields are generated from.
   * The check re-derives the projections from the contract and refuses a
   * disagreement instead of letting either side stand in for the other: a
   * reader that trusts `objective` and one that trusts `contract.objective`
   * must never see two different goals. Structural comparison goes through
   * `canonicalize`, so key order in the stored payload is not a difference.
   */
  private assertContract;
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
  private assertContractFields;
  /**
   * The batch record a decomposition carries is the identity a later review
   * gate binds an approval to, so a malformed one is refused rather than
   * stored: an empty proposal digest or a non-numeric limit would make the
   * record unusable exactly when someone needs to compare it.
   */
  private assertAdmission;
  /**
   * The limits one admission context carries, checked the same way wherever one
   * is stored — on a decomposition (T1) and on a proposal (T2: the limits the
   * batch was submitted under, whose fingerprint an approval binds). `where`
   * names the record being checked, so a refusal says which producer it came
   * from instead of "some context is malformed".
   */
  private assertAdmissionLimits;
  private admit;
  private decompose;
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
  private assertProviderBinding;
  /**
   * The submission record is what a reader trusts instead of re-reading the
   * worker's transcript, so a malformed one is refused rather than stored: an
   * unnamed summary or a ref list that is not a list would leave the record
   * unusable exactly when someone asks what was handed in. Shape only —
   * whether the refs point at anything the store holds is judged by the
   * acceptance reader.
   */
  private assertSubmissionShape;
  /**
   * A run's birth phase is written by the runtime, and the reducer judges its
   * shape only — the transition semantics belong to `changeRunPhase`. A run
   * with no phase is a record from before the protocol and stays legal; a run
   * born `active` carries neither a submission nor a batch; a run born
   * `submitted` (a workerless replay) must carry a well-shaped submission and
   * no batch. `waiting_children` is not a birth phase: no creation path admits
   * a batch before the run exists.
   */
  private assertBirthPhase;
  /**
   * A4's question ids ride on the phase change; nothing reads them yet, so the
   * reducer checks that the list is a list of strings and carries it unchanged
   * — an empty list is a legitimate shape and is stored as given.
   */
  private assertQuestionIds;
  private addDependency;
  private start;
  private block;
  private verify;
  private fail;
  /**
   * A run keeps `running` through verification (the coordination phase, not the
   * status, is what records the submission), so a cancellation that lands while a
   * verifier call is in flight arrives at a task that is already `verifying`.
   * Refusing it would leave the tree half-settled — the parent cancelled, the
   * verifying child not — and make the documented exit for a store that cannot be
   * recovered (`cancelGraph`) impossible exactly when it is needed. `failed`
   * already accepts both source statuses; this is the same rule for `cancelled`.
   */
  private cancel;
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
  private changeRunPhase;
  /**
   * A no-progress marking is the A3 signal a reader shows before the budget
   * stops a stuck run, and it is meaningful only on the phase that can still
   * submit: `active`. A run waiting on children or on verification is expected
   * to be idle — marking it would count a legitimate wait as stagnation and
   * give the budget a reason to stop work that is still under way. `rounds` is
   * the caller's consecutive count; the reducer records the number it is given
   * and never accumulates, so replay and live observation agree.
   */
  private markRunProgress;
  private resolveCapabilities;
  private produceEvidence;
  private addHandoff;
  /**
   * A review is the legal companion of the terminal transition it follows: the
   * run (or the runless blocked task) must already sit in the outcome the record
   * declares, and each run accepts exactly one record — a second one is a bug in
   * the writer, not a late event to tolerate.
   */
  private recordReview;
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
  private recordDiagnosis;
  /**
   * An obligation is raised, never scheduled (KISS §5.1: a question, not an
   * action): the reducer enforces integrity only — a unique non-empty id,
   * non-empty goal and criterion, and a source task that exists in the store.
   */
  private recordObligation;
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
  private submitProposal;
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
  private decideProposal;
  /**
   * One runtime phase change (T2/T3, §6): the two edges that are not a person's
   * decision or a consumption — `ready → pending_review` when the deployment
   * tightened to `all` before admission, `approved → ready` when the
   * post-approval re-check passed, and `→ stale` when it failed. The source
   * statuses are the gate (see {@link PHASE_SOURCES}), and a `stale` marking
   * must name what changed: an invalidation a reader cannot explain is a
   * record that cannot be trusted.
   */
  private changeProposalPhase;
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
  private admitProposal;
  /** The stored proposal one event names, or a refusal naming the id. */
  private proposal;
  /**
   * The proposal index of the snapshot this state replays on. It is absent only
   * when a foreign snapshot (a hand-built one from a reader that predates
   * proposals) was replayed onto — never on this build's own value — and that
   * is a refusal rather than an empty index: a reducer that cannot see the
   * proposals would happily write a second one for the same request key.
   */
  private index;
  /**
   * Every proposal event is about one subject, and the envelope has to name it:
   * a decomposition proposal's events name the parent task whose batch it is; a
   * root contract's events name the reserved {@link ROOT_PROPOSAL_TASK_ID}
   * marker, because the task it becomes does not exist yet and naming a real
   * task would read as that task's intake (A0 §2).
   */
  private assertProposalTask;
  /** The store's root task, if it has one: the task a root intake may not sit beside or activate a second time. */
  private rootTask;
  /**
   * A store with a root task refuses root intake by name (A0 §1.6): the root it
   * holds is somebody's goal, and a second intake would make "the store's root"
   * answer differently at two reads. A goal change is a new graph, never a
   * second root here.
   */
  private assertRootIntakeOpen;
  /** One proposal's status either admits this outcome or the event is a late or out-of-order write. */
  private assertProposalTransition;
  /** Replaces one proposal in place; the index's other views keep pointing at the same record. */
  private setProposal;
  /**
   * A submitted proposal has to be complete and internally consistent, because
   * everything an approval binds is taken from it: the review context is a
   * closed record (an unread field would silently become part of an identity),
   * the birth status is the policy the deployment ran under (`off → ready`,
   * `all → pending_review` — the audit of "no human review happened" depends on
   * it), a revision must name a proposal that exists, and the three digests
   * must be the digests of the data they claim to describe.
   */
  private assertProposal;
  /**
   * A decomposition proposal's half of the record: the batch identity and the
   * batch content that must be the content of that identity. Both digests are
   * the ones they always were — this arm is the shape T2/T3 shipped, and adding
   * a kind to the union does not move its identity.
   */
  private assertDecompositionProposal;
  /**
   * A root contract proposal's half of the record: the root identity (store,
   * root session, request key, contract digest — and no parent task) and the one
   * normalized contract it must be the digest of. The two shapes are checked
   * before the digest, so a mismatch is reported as the wrong content rather
   * than as a wrong number.
   */
  private assertRootProposal;
  /**
   * Whether a record that does not claim `kind: 'root'` still carries a root
   * contract's fields. Absence of the kind is legal for exactly one arm, so a
   * record that holds a root payload without saying so is refused instead of
   * being read as a decomposition of a parent that does not exist.
   */
  private carriesRootContract;
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
  private assertProposalIdentity;
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
  private assertRootIdentity;
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
  private assertProposalBatch;
  /**
   * A decision binds the proposal it was made against, so every identity it
   * carries is compared with the stored record: the dossier digest, the
   * admission context, and — for an approval, always — the review context the
   * batch resolved against when it was shown. A mismatch is the one case the
   * reducer must never accept: an approval that travels to other content is
   * exactly the failure the digest binding exists to prevent.
   */
  private assertDecisionBinding;
  /**
   * A consumption binds a proposal to what it became, so it has to name the same
   * dossier and the resolution the admission re-check confirmed — for both kinds
   * — and then the kind's own shape: a batch names the batch id that belongs to
   * its parent (`b-<parentTaskId>`) and children the store really holds under
   * that parent; a root contract names the root task and root run of its
   * activation. The common half is checked here so the two kinds cannot drift
   * apart on the numbers that make an approval non-transferable.
   */
  private assertConsumptionBinding;
  /**
   * The batch half of a consumption: the batch of this parent, and children the
   * store really holds under it — the record a crash recovery reads to find the
   * batch it already admitted instead of admitting a second one. The batch
   * vocabulary is the only one this arm may use, and its `kind` may only be
   * absent (a record written before kinds existed) or `batch`.
   */
  private assertBatchConsumptionShape;
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
  private assertRootConsumptionShape;
  /**
   * The review context's closed shape. Its manifest fingerprint and every
   * verifier id/version/configuration are checked for the shapes that make them
   * comparable — a digest that is not a digest, or a verifier without an id,
   * would leave `reviewContextDigest` comparing values nobody can interpret —
   * and unknown fields are refused because the digest covers exactly the
   * declared surface: a field no reader understands must not move an identity.
   */
  private assertReviewContext;
  private transit;
  private assertTransition;
  private assertRunTransition;
  private setRun;
  private updateTask;
  private task;
  private run;
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
  private closing;
  constructor(ctx: Context);
  createStore(storeId: string): Promise<TaskSnapshot>;
  openStore(storeId: string): Promise<TaskSnapshot>;
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
  taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance>;
  runIn(storeId: string, runId: RunId): Promise<TaskRun>;
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>;
  createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void>;
  admitTaskIn(storeId: string, taskId: TaskId, actor: string, options?: {
    decompositionStatus?: 'leaf' | 'decomposable';
    manifest?: CapabilityManifest;
  }): Promise<void>;
  rejectTaskIn(storeId: string, taskId: TaskId, actor: string, reason: string, manifest?: CapabilityManifest): Promise<void>;
  decomposeIn(storeId: string, parentTaskId: TaskId, children: readonly TaskInstance[], actor: string, edges?: readonly DependencyEdge[], admission?: DecompositionAdmission): Promise<void>;
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
  admitBatchIn(storeId: string, parentTaskId: TaskId, parentRunId: RunId, children: readonly TaskInstance[], actor: string, edges?: readonly DependencyEdge[], admission?: DecompositionAdmission, manifests?: readonly CapabilityManifest[], proposal?: TaskProposalConsumption): Promise<void>;
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
  admitRootProposalIn(storeId: string, task: TaskInstance, run: TaskRun, actor: string, options: {
    consumption: TaskProposalRootConsumption;
    manifest?: CapabilityManifest;
  }): Promise<void>;
  addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void>;
  startRunIn(storeId: string, run: TaskRun, actor: string): Promise<void>;
  markRunStatusIn(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus | 'verifying', actor: string, options?: {
    reason?: string;
    finishedAt?: string;
  }): Promise<void>;
  /**
   * Records one coordination-phase change on a run (A3). The reducer is the
   * gate: only `active → waiting_children` (carrying the batch id) and
   * `active|waiting_children → submitted` (carrying the submission) apply, and
   * a refused transition commits nothing.
   */
  changeRunPhaseIn(storeId: string, taskId: TaskId, runId: RunId, actor: string, payload: TaskEventPayloads['RunPhaseChanged']): Promise<void>;
  /**
   * Records one no-progress marking on an active run (A3). `rounds` is the
   * caller's consecutive count; the reducer records the value it is given.
   */
  markRunProgressIn(storeId: string, taskId: TaskId, runId: RunId, actor: string, payload: TaskEventPayloads['RunProgressMarked']): Promise<void>;
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
  submitProposalIn(storeId: string, proposal: TaskProposal, actor: string): Promise<void>;
  /**
   * Records one review decision (T2/T3 §6), bound to the dossier digest and
   * both context fingerprints the reviewer was shown. An unknown proposal is
   * refused here, before the commit; every binding is checked by the reducer,
   * so a decision that does not name exactly the stored proposal applies
   * nothing.
   */
  decideProposalIn(storeId: string, claim: TaskProposalDecisionClaim, actor: string): Promise<void>;
  /**
   * Records one runtime phase change (T2/T3 §6): to `pending_review` when the
   * deployment tightened to `all`, to `ready` when an approval passed its
   * post-approval re-check, to `stale` when that re-check failed. The status
   * table lives in the reducer; a change that is not legal from the proposal's
   * current status applies nothing.
   */
  changeProposalPhaseIn(storeId: string, change: TaskProposalPhaseChange, actor: string): Promise<void>;
  /**
   * Records one consumption on its own (T2/T3 §6): the batch the proposal
   * became, by child task id and batch id. `admitBatchIn` writes the same event
   * inside the admission commit, which is the path that keeps the children and
   * the record of them one fact; this entry exists for a caller that admitted
   * the batch through another entry and is recording the consumption beside it.
   */
  consumeProposalIn(storeId: string, consumption: TaskProposalConsumption, actor: string): Promise<void>;
  recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void>;
  recordReviewIn(storeId: string, review: ReviewRecord, actor: string): Promise<void>;
  recordDiagnosisIn(storeId: string, diagnosis: Diagnosis, actor: string): Promise<void>;
  recordObligationIn(storeId: string, obligation: Obligation, actor: string): Promise<void>;
  recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void>;
  commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void>;
  /**
   * The proposal one event names, read from the store before the commit so an
   * unknown proposal is a refusal *before* anything is queued: the reducer would
   * reject the event anyway, and a caller that asked about a proposal the store
   * does not hold deserves to hear it from the entry it called. The value is
   * advisory — the write lock is not held across it — and the reducer's own check
   * is what actually binds the record.
   */
  private requireProposalIn;
  /**
   * The task id a proposal's events carry on the envelope: the parent task a
   * decomposition batch belongs to, or the reserved root marker for a root
   * contract, which has no parent to name (A0 §2). The reducer requires exactly
   * this, so a root event cannot hide behind a real task id.
   */
  private proposalEnvelopeTaskIn;
  private requireStore;
  private allocate;
  private open;
  private close;
  private header;
}
//#endregion
export { AcceptanceCriterion, AcceptanceCriterionShape, AcceptanceFacts, AdmissionContext, ArtifactRef, CapabilityCoverageFacts, CapabilityManifest, ChildEvidenceRef, ContextEfficiencyFacts, DecompositionAdmission, DecompositionChildIdentity, DecompositionFacts, DecompositionIdentity, DecompositionStatus, DependencyEdge, Diagnosis, DiagnosisConfidence, DiagnosisProposal, DiagnosisProvenance, EvidenceBundle, EvidenceClaim, ExecutionPhase, ExecutionSkillSidecar, JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, JudgedDimension, JudgementVerdict, KnowledgeContentCheck, KnowledgeSkillSidecar, NoProgressRecord, Obligation, OutcomeCorrectnessFacts, ProposalTargetType, ProtectedInputRef, ROOT_PROPOSAL_TASK_ID, ReviewBlocker, ReviewCriterion, ReviewDimensions, ReviewJudgement, ReviewMetrics, ReviewOutcome, ReviewRecord, ReviewTokenUsage, ReviewToolCall, ReviewToolCallTotals, RootProposalIdentity, RootTaskSpec, RunId, RunMcpServerBinding, RunProviderBinding, RunSkillBinding, RunStatus, SKILL_CONTRACT_VERSION, SKILL_SIDECAR_FILE, SUPPORTED_SKILL_RESOURCE_DIRS, SkillContentIdentity, SkillContractDefect, SkillContractDefectCode, SkillContractVersion, SkillFitFacts, SkillPort, SkillResourceIdentity, SkillSidecar, SkillVerifierRef, SubmissionRecord, TASK_CONTRACT_VERSION, TASK_PROPOSAL_DECISION_OUTCOMES, TASK_PROPOSAL_KINDS, TASK_PROPOSAL_PHASES, TASK_PROPOSAL_STATUSES, TaskContract, TaskContractVersion, TaskDefinition, TaskEvent, TaskEventEnvelope, TaskEventKind, TaskEventPayloads, TaskHandoff, TaskId, TaskInstance, TaskProposal, TaskProposalBase, TaskProposalBatchConsumption, TaskProposalChild, TaskProposalConsumption, TaskProposalDecisionClaim, TaskProposalDecisionOutcome, TaskProposalDecomposition, TaskProposalIndex, TaskProposalPhase, TaskProposalPhaseChange, TaskProposalPolicy, TaskProposalReviewContext, TaskProposalRoot, TaskProposalRootConsumption, TaskProposalStatus, TaskProposalVerifierIdentity, TaskRun, TaskService, TaskService as default, TaskSnapshot, TaskSpecificationFacts, TaskState, TaskStatus, ToolFitFacts, VerificationMode, VerificationResult, Verifier, VerifierSelftest, VerifierSelftestSample, VerifierSelftestStore, VerifyRequest, admissionContextDigest, canonicalize, capabilityManifestDigest, contractDigest, decompositionDigest, isSupportedSkillResourcePath, reaches, reviewContextDigest, rootProposalDigest, rootProposalId, rootTaskStoreId, sha256Hex, skillContentDigest, skillContractDefects, skillContractDigest, taskProposalId };