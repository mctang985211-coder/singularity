/**
 * Task proposals (construction guide §6): one immutable batch submission — the
 * complete normalized contracts of every child, kept as content and not only as
 * digests — the policy it was submitted under, the contexts it was reviewed
 * against, and the review's result: the data a review gate, a display, and a
 * recovery need, and nothing more.
 *
 * Why the content is carried whole: §5 requires an approval request to show
 * every child's goal, criteria, assumptions, constraints, dependencies and
 * capabilities, and §7 requires graph/canvas to render waiting, rejected and
 * admitted proposals from saved facts. A proposal that stored only the child
 * digests would make all of that depend on some other read of some other store,
 * and would make "what did the person approve" unanswerable from the record.
 * The identity stays the commitment — its per-child `contractDigest` is the
 * digest of the contract stored beside it, and the reducer refuses a submission
 * where the two disagree.
 *
 * Why a proposal is a record and not a status on `TaskInstance`: §6 is explicit
 * that the review lifecycle is not the task lifecycle. A task that has not been
 * admitted does not exist yet, so a rejected batch would have to be written as
 * a task (and its children as tasks) that were never meant to run. The proposal
 * lives beside the tasks in the same store — same events, same reducer, same
 * persistence discipline — and a proposal only ever *becomes* tasks when it is
 * admitted, in the same commit that records the consumption.
 *
 * Identities (three, deliberately separate, §4):
 *
 * - the batch content identity is {@link decompositionDigest} of
 *   {@link TaskProposal.identity} (T1). It covers store/parent task/parent
 *   run/caller, the contract version, the reason, and the complete ordered
 *   children — one digest per child contract, so it commits to exactly the
 *   {@link TaskProposal.batch} content stored with it. Ids minted at admission
 *   are not in it, so a retry of the same proposal keeps one identity;
 * - {@link admissionContextDigest} fingerprints the limits in force
 *   ({@link AdmissionContext}) — the enforced ceilings and the audited ones.
 *   Budgets are not contract text: a contract cannot raise them, and a proposal
 *   re-checked after a deployment tightened them is a different gate;
 * - {@link reviewContextDigest} fingerprints what the batch actually resolved
 *   against: the capability manifests and the judging verifiers with their
 *   versions and configuration. §6's stale rule ("能力实现、有效预算或 verifier
 *   选择变化，首版保守标 stale") rests on these two fingerprints, so an
 *   unrelated registry edit does not invalidate a reviewed proposal while a
 *   change to *this* batch's resolution does.
 *
 * Two kinds, one lifecycle (A0 §2): a proposal is either a **decomposition**
 * batch — a parent task's children, the shape T2/T3 built — or a **root
 * contract**, the single normalized contract a root session is admitted as,
 * carried as {@link TaskProposalRoot.contract} instead of a child batch and
 * identified by {@link RootProposalIdentity} (store, root session, request key,
 * contract digest) instead of a parent task and run. The kind is a discriminant
 * on the record, and its absence means `decomposition`: a proposal written
 * before the field existed is read exactly as it was, and the decomposition
 * path's identities do not move when a writer states `kind: 'decomposition'`
 * explicitly — the kind is not part of either identity. The lifecycle is not
 * duplicated for the second kind: the same statuses, the same decision binding
 * (dossier digest plus both context fingerprints), the same post-approval
 * re-check and the same consumption discipline apply to both, and only the
 * shape a decision or a consumption is checked against is branched by kind.
 *
 * A root proposal has no parent task, so its events cannot name one: they carry
 * the reserved {@link ROOT_PROPOSAL_TASK_ID} marker in the envelope's `taskId`,
 * which the reducer requires for `kind: 'root'` and refuses everywhere else —
 * a real task id must never be able to impersonate a root intake, and no intake
 * may name a task that does not exist.
 *
 * An approval binds all three: the decision event carries the dossier digest
 * and both fingerprints, and the reducer refuses a decision whose numbers do
 * not match the stored proposal. Approving "this batch, as reviewed, under
 * these limits and this resolution" is therefore the only thing an approval can
 * mean — a revision, a re-resolution or a budget change is a different
 * proposal, and the old approval never travels to it.
 *
 * What the review context does *not* carry: the content identity of the skills
 * the batch's capabilities grant. Capability manifests name skills, tools and
 * presets, not the bytes behind them; a run's loaded content is pinned per run
 * by S1-C's provider binding, which is resolved at spawn — after admission, so
 * it cannot be an input to the review. A deployment that wants a granted
 * skill's content change to invalidate a reviewed proposal must fold that into
 * the manifest identity it records here; the digest covers exactly what it is
 * given, and nothing invents a version a source does not have.
 * @module @dangosys/dsh-singularity-task/proposal
 */

import { canonicalize, decompositionDigest, sha256Hex } from './contract.ts'
import type { AdmissionContext, DecompositionIdentity, TaskContract, TaskContractVersion } from './contract.ts'
import type { CapabilityManifest, RunId, TaskId } from './types.ts'

/**
 * The review policy a proposal was submitted under (§5). Deployment
 * configuration decides it; a node cannot switch it, and it is stored with the
 * proposal because the audit has to be able to tell a batch that ran without a
 * human review (`off`, recorded as `policy-off`) from one a person approved.
 */
export type TaskProposalPolicy = 'off' | 'all'

/**
 * What a proposal proposes (§2): a parent task's decomposition batch, or a root
 * session's contract. Absent means `decomposition` — every record written
 * before the field existed — so a reader must treat the two the same and never
 * invent a kind for a stored record.
 */
export type TaskProposalKind = 'decomposition' | 'root'

/** Every proposal kind, for validation and rendering. */
export const TASK_PROPOSAL_KINDS: readonly TaskProposalKind[] = ['decomposition', 'root']

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
export const ROOT_PROPOSAL_TASK_ID = 'root-proposal'

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
export type TaskProposalStatus =
  | 'ready'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'stale'
  | 'admitted'
  | 'expired'

/** Every proposal status, for validation and rendering. */
export const TASK_PROPOSAL_STATUSES: readonly TaskProposalStatus[] = [
  'ready', 'pending_review', 'approved', 'rejected', 'cancelled', 'stale', 'admitted', 'expired',
]

/**
 * The statuses a `TaskProposalPhaseChanged` event may write: what the runtime
 * (as opposed to a person deciding or a batch being admitted) moves a proposal
 * to. `pending_review` is on the list because §5's tightening path needs it;
 * `admitted` is not, because that is the consumption event's business.
 */
export type TaskProposalPhase = 'ready' | 'pending_review' | 'stale'

/** Every proposal phase change, for validation and rendering. */
export const TASK_PROPOSAL_PHASES: readonly TaskProposalPhase[] = ['ready', 'pending_review', 'stale']

/**
 * What a decision may be. The four are kept apart because they mean different
 * things to a reader and to the next stage: `approved` is the only one that can
 * lead to execution, `rejected` says a reviewer refused the batch, `cancelled`
 * says the batch was withdrawn (by a person or by the deployment), and
 * `expired` says the decision arrived when the batch could no longer be
 * dispatched (§6: a late approval may only invalidate the proposal).
 */
export type TaskProposalDecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'expired'

/** Every decision outcome, for validation and rendering. */
export const TASK_PROPOSAL_DECISION_OUTCOMES: readonly TaskProposalDecisionOutcome[] = [
  'approved', 'rejected', 'cancelled', 'expired',
]

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
export interface TaskProposalVerifierIdentity {
  /** The registered verifier id a criterion of this batch resolves to. */
  verifierId: string
  /** The version the registered instance declares, when it declares one. */
  version?: string
  /** Fingerprint of the configuration the instance was built from, when the deployment can name one. */
  configurationDigest?: string
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
export interface TaskProposalReviewContext {
  /** {@link capabilityManifestDigest} of the manifests this batch resolved, in batch order. */
  capabilityManifestDigest: string
  /** Every judging instance the batch's criteria resolve to. Order is not part of {@link reviewContextDigest}. */
  verifiers: TaskProposalVerifierIdentity[]
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
export interface TaskProposalChild {
  /** The child's normalized contract (T1 §4): defaults filled, criterion ids fixed, lists present. */
  contract: TaskContract
  /** Sibling indices (0-based, in batch order) this child's run waits for; order is insignificant to execution but part of the digest. */
  dependsOn: readonly number[]
  /** Whether the child may split further; a declaration, not a permission (admission still applies every guardrail). */
  decomposable: boolean
  /** Whether the child demands independent parent acceptance (P4 marker). */
  requiresIndependentAcceptance: boolean
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
export interface RootProposalIdentity {
  contractVersion: TaskContractVersion
  storeId: string
  /** The root session this contract is the goal of; the store is its `sg-t-<rootSessionId>` store. */
  rootSessionId: string
  /** The caller's stable request key (§6); must equal the proposal record's own. */
  requestKey: string
  /** {@link contractDigest} of the normalized root contract stored beside it. */
  contractDigest: string
}

/**
 * One review decision on record (§6): what was decided, against which dossier
 * and which contexts, by whom and when. The three identity fields are what make
 * an approval non-transferable — the reducer refuses a decision whose
 * `proposalDigest`, `admissionContextDigest` or `reviewContextDigest` disagrees
 * with the stored proposal, so a decision can only ever mean "this exact batch,
 * under these exact limits, with this exact resolution".
 */
export interface TaskProposalDecision {
  /** What was decided. Only `approved` can lead to admission, through `approved → ready`. */
  outcome: TaskProposalDecisionOutcome
  /** The batch identity the decision was made against; must equal the stored proposal's. */
  proposalDigest: string
  /** The admission-context fingerprint shown with the proposal; must equal the stored one. */
  admissionContextDigest: string
  /**
   * The review-context fingerprint the decision was made against. Required for
   * an approval — an approval that did not bind the resolution it reviewed is
   * not an approval — and, when present on any other outcome, still checked
   * against the stored one.
   */
  reviewContextDigest?: string
  /** Who decided: the approval channel's own identity, a session id, or the deployment for a withdrawal. Never a model-supplied reference. */
  decidedBy: string
  /** When the decision was taken, as the writer recorded it. */
  decidedAt: string
  /** Why, when the decider gave a reason. Required for an expiry, which must name what ended the batch. */
  reason?: string
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
export interface TaskProposalBatchConsumption {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'batch'
  /** The proposal being consumed. */
  proposalId: string
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string
  /** The batch's id in the run coordination protocol: `b-<parentTaskId>` (A3). */
  batchId: string
  /** The children this proposal became, in batch order — the ids the admission commit created. */
  childTaskIds: TaskId[]
  /** When the batch was admitted, as the writer recorded it. */
  admittedAt: string
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string
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
export interface TaskProposalRootConsumption {
  kind: 'root'
  /** The proposal being consumed. */
  proposalId: string
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string
  /** The root task the activation minted: parentless, depth 0, carrying the approved contract. */
  rootTaskId: TaskId
  /** The root run the activation minted: born `active`, running, in the proposal's root session. */
  rootRunId: RunId
  /** When the contract was activated, as the writer recorded it. */
  admittedAt: string
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string
}

/** A consumption, of either kind; a reader narrows by `kind` before reading the ids. */
export type TaskProposalConsumption = TaskProposalBatchConsumption | TaskProposalRootConsumption

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
export interface TaskProposalBase {
  /**
   * The proposal's identity: `p-` plus {@link taskProposalId}'s derivation from
   * the proposal content. Content-derived rather than minted, so a retry —
   * within a process or after a restart — addresses the same proposal, and the
   * store refuses a second submission of the same content instead of building
   * a second batch (§4: random ids must never make one operation into two).
   */
  proposalId: string
  /**
   * The stable key the caller derived from its own context (§6). One key names
   * at most one proposal: a repeated request with the same key is answered with
   * the stored proposal, a new revision gets a new key, and the store refuses a
   * key that is already bound to another proposal.
   */
  requestKey: string
  /**
   * The proposal this one revises (§6), when the caller is replacing a rejected
   * or stale one. The superseded record is kept — a rejection is a fact, not an
   * edit — and a new *key* is what makes the revision new, so re-submitting the
   * old key would be refused rather than silently superseding anything.
   */
  supersedes?: string
  /** Where the proposal stands. See {@link TaskProposalStatus} for the full table. */
  status: TaskProposalStatus
  /**
   * The review policy in force when the proposal was submitted (§5). Stored,
   * never re-resolved: `off` is the audit record that this batch ran without a
   * human review (`policy-off`, never a fake `human-approved`), and a later
   * deployment change to `all` tightens `status` without rewriting this field.
   */
  policy: TaskProposalPolicy
  /** {@link decompositionDigest} of a decomposition identity, {@link rootProposalDigest} of a root one: the content identity an approval binds to. */
  proposalDigest: string
  /** The limits in force when the proposal was submitted, recorded next to it, never derived from the contract. */
  admissionContext: AdmissionContext
  /** {@link admissionContextDigest} of {@link admissionContext}. */
  admissionContextDigest: string
  /** What the payload resolved against when it was submitted (capability manifests, judging verifiers). */
  reviewContext: TaskProposalReviewContext
  /** {@link reviewContextDigest} of {@link reviewContext}. */
  reviewContextDigest: string
  /** When the proposal was submitted. */
  createdAt: string
  /** When the last lifecycle event applied to it was written; absent until one was. */
  updatedAt?: string
  /** The decision on record, once one was made. Absent while the proposal is undecided. */
  decision?: TaskProposalDecision
  /**
   * What this proposal became, once it was admitted. Absent while it still
   * might become something. The kind of the stored consumption always agrees
   * with the kind of the proposal that carries it — the reducer refuses the
   * other combination — so a reader narrows it the way it narrowed this record.
   */
  consumption?: TaskProposalConsumption
}

/**
 * One decomposition proposal (T2/T3): a parent task's children, submitted as a
 * batch. `kind` is optional so a record written before the field existed — and
 * a writer that has no reason to state the obvious — still reads as this arm.
 */
export interface TaskProposalDecomposition extends TaskProposalBase {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'decomposition'
  /** The complete batch identity, {@link decompositionDigest}'d into {@link proposalDigest}. */
  identity: DecompositionIdentity
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
  batch: readonly TaskProposalChild[]
}

/**
 * One root contract proposal (A0 §2): the goal of a root session, normalized —
 * objective, assumptions, constraints, mandatory acceptance criteria — and
 * submitted as a single contract rather than as children. `kind: 'root'` is
 * required: a root contract has no parent task to place it under, so nothing
 * about the record can be read as a decomposition of something.
 */
export interface TaskProposalRoot extends TaskProposalBase {
  kind: 'root'
  /** The root contract's identity: {@link rootProposalDigest}'d into {@link proposalDigest}. */
  identity: RootProposalIdentity
  /**
   * The single normalized root contract this proposal asks to run (the content
   * an approval covers and a reviewer reads, stored whole for the same reasons
   * a batch is). Bound to the identity: the reducer refuses a submission whose
   * contract does not digest to {@link RootProposalIdentity.contractDigest}, and
   * the admission entry refuses a root task that does not carry this contract.
   */
  contract: TaskContract
}

/**
 * One submitted proposal, either kind. A reader must narrow by `kind` before
 * touching the payload — that is the whole point of the union: `batch` and
 * `contract` are alternatives, and neither exists on the other arm.
 */
export type TaskProposal = TaskProposalDecomposition | TaskProposalRoot

/**
 * What a decision states when it is written (the payload of
 * `TaskProposalDecided`): {@link TaskProposalDecision} plus the proposal it is
 * about. The reducer checks every field against the stored proposal before the
 * record is applied.
 */
export interface TaskProposalDecisionClaim extends TaskProposalDecision {
  /** The proposal this decision is about. */
  proposalId: string
}

/**
 * One runtime-driven phase change (the payload of
 * `TaskProposalPhaseChanged`): a proposal sent to review because the deployment
 * tightened to `all`, an approval whose re-check passed (`approved → ready`,
 * §6's "批准已落账、等待重检/准入"), or one whose re-check failed (`→ stale`).
 */
export interface TaskProposalPhaseChange {
  /** The proposal being moved. */
  proposalId: string
  /** Where it moves to; see {@link TaskProposalPhase} and {@link TaskProposalStatus} for the legal sources. */
  to: TaskProposalPhase
  /** Why the runtime moved it. Required for `stale` — an invalidation has to name what changed. */
  reason?: string
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
export interface TaskProposalIndex {
  /** Every proposal the store holds, in submission order. */
  readonly all: readonly TaskProposal[]
  /** `proposalId` → the proposal. */
  readonly byId: Readonly<Record<string, TaskProposal>>
  /** `requestKey` → the proposal bound to it. At most one, by construction. */
  readonly byRequestKey: Readonly<Record<string, TaskProposal>>
  /** `parentTaskId` → that task's proposals, in submission order. A root contract is in no entry here. */
  readonly byParentTask: Readonly<Record<string, readonly TaskProposal[]>>
}

/** The `p-` prefix every proposal id carries, so an id is recognizable as one wherever it is printed. */
export const TASK_PROPOSAL_ID_PREFIX = 'p-'

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
export function taskProposalId(identity: DecompositionIdentity): string {
  return `${TASK_PROPOSAL_ID_PREFIX}${decompositionDigest(identity)}`
}

/**
 * The root contract's identity: SHA-256 over {@link canonicalize} of
 * {@link RootProposalIdentity} — which store, which root session, which request
 * key, and the digest of the normalized root contract. Exactly those fields and
 * nothing else (A0 §2), so the same contract asked for again by the same key is
 * one proposal, a revision is a different one, and no id minted at activation
 * is in it.
 */
export function rootProposalDigest(identity: RootProposalIdentity): string {
  return sha256Hex(canonicalize(identity))
}

/**
 * The proposal id one root contract identity gets: `p-` plus
 * {@link rootProposalDigest} of the identity. The same derivation and the same
 * prefix as a batch proposal (§4: content-derived ids, never minted), so an id
 * is one kind of thing wherever it is printed and a retry addresses the same
 * proposal.
 */
export function rootProposalId(identity: RootProposalIdentity): string {
  return `${TASK_PROPOSAL_ID_PREFIX}${rootProposalDigest(identity)}`
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
export function admissionContextDigest(context: AdmissionContext): string {
  return sha256Hex(canonicalize(context))
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
export function capabilityManifestDigest(manifests: readonly CapabilityManifest[]): string {
  return sha256Hex(canonicalize(manifests))
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
export function reviewContextDigest(context: TaskProposalReviewContext): string {
  return sha256Hex(canonicalize(normalizeReviewContext(context)))
}

/** The review context with an order-independent verifier list, for hashing only — the stored list keeps the writer's order. */
function normalizeReviewContext(context: TaskProposalReviewContext): TaskProposalReviewContext {
  return {
    capabilityManifestDigest: context.capabilityManifestDigest,
    verifiers: [...context.verifiers].sort((left, right) => compareVerifiers(left, right)),
  }
}

function compareVerifiers(left: TaskProposalVerifierIdentity, right: TaskProposalVerifierIdentity): number {
  const a = verifierKey(left)
  const b = verifierKey(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function verifierKey(verifier: TaskProposalVerifierIdentity): string {
  return [verifier.verifierId, verifier.version ?? '', verifier.configurationDigest ?? ''].join('\u0000')
}
