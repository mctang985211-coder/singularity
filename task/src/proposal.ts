/** Task proposals (construction guide §6): one immutable batch submission with its review contexts and lifecycle. @module @dangosys/dsh-singularity-task/proposal */

import { canonicalize, decompositionDigest, sha256Hex } from './contract.ts'
import type { AdmissionContext, DecompositionIdentity, TaskContract, TaskContractVersion } from './contract.ts'
import type { CapabilityManifest, RunId, TaskId } from './types.ts'

/** The review policy a proposal was submitted under (§5). Deployment configuration decides it; a node cannot switch it, and it is stored with the proposal because the audit has to be able to tell a batch that ran without a human review … */
export type TaskProposalPolicy = 'off' | 'all'

/** What a proposal proposes (§2): a parent task's decomposition batch, or a root session's contract. */
type TaskProposalKind = 'decomposition' | 'root'

/** Every proposal kind, for validation and rendering. */
export const TASK_PROPOSAL_KINDS: readonly TaskProposalKind[] = ['decomposition', 'root']

/** The reserved `taskId` a root proposal's events carry on the envelope. A root contract belongs to no task — the task it becomes does not exist until it is activated — so its events cannot name one, and naming a task that happens to exist … */
export const ROOT_PROPOSAL_TASK_ID = 'root-proposal'

/** Where one proposal sits in the review lifecycle (§6). Separate from `TaskStatus` on purpose — a proposal is not a task, and none of these states may be read as "the task ran". */
export type TaskProposalStatus =
  'ready' | 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'stale' | 'admitted' | 'expired'

/** The statuses a `TaskProposalPhaseChanged` event may write: what the runtime (as opposed to a person deciding or a batch being admitted) moves a proposal to. */
export type TaskProposalPhase = 'ready' | 'pending_review' | 'stale'

/** Every proposal phase change, for validation and rendering. */
export const TASK_PROPOSAL_PHASES: readonly TaskProposalPhase[] = ['ready', 'pending_review', 'stale']

/** What a decision may be. The four are kept apart because they mean different things to a reader and to the next stage: `approved` is the only one that can lead to execution, `rejected` says a reviewer refused the batch, `cancelled` says the … */
export type TaskProposalDecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'expired'

/** Every decision outcome, for validation and rendering. */
export const TASK_PROPOSAL_DECISION_OUTCOMES: readonly TaskProposalDecisionOutcome[] = [
  'approved',
  'rejected',
  'cancelled',
  'expired',
]

/** One judging instance a batch's criteria resolved to, as the review context records it (§6): the registered verifier's id, the version it declares, and — when the deployment can name one — the fingerprint of the configuration that instance … */
export interface TaskProposalVerifierIdentity {
  /** The registered verifier id a criterion of this batch resolves to. */
  verifierId: string
  /** The version the registered instance declares, when it declares one. */
  version?: string
  /** Fingerprint of the configuration the instance was built from, when the deployment can name one. */
  configurationDigest?: string
}

/** What a proposal's approval actually covered (§6): the capability manifests this batch resolved, and the judging instances its criteria resolved to. */
export interface TaskProposalReviewContext {
  /** {@link capabilityManifestDigest} of the manifests this batch resolved, in batch order. */
  capabilityManifestDigest: string
  /** Every judging instance the batch's criteria resolve to. Order is not part of {@link reviewContextDigest}. */
  verifiers: TaskProposalVerifierIdentity[]
}

/** One child of a proposal's batch, in full (§5): the normalized contract a reviewer reads, plus the three declarations the batch identity digests. */
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

/** Everything a root contract proposal's identity covers (§2): which store and which root session the contract is for, the caller's request key, and the digest of the single normalized contract stored beside it. */
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

/** One review decision on record (§6): what was decided, against which dossier and which contexts, by whom and when. */
interface TaskProposalDecision {
  /** What was decided. Only `approved` can lead to admission, through `approved → ready`. */
  outcome: TaskProposalDecisionOutcome
  /** The batch identity the decision was made against; must equal the stored proposal's. */
  proposalDigest: string
  /** The admission-context fingerprint shown with the proposal; must equal the stored one. */
  admissionContextDigest: string
  /** The review-context fingerprint the decision was made against. Required for an approval — an approval that did not bind the resolution it reviewed is not an approval — and, when present on any other outcome, still checked against the stored … */
  reviewContextDigest?: string
  /** Who decided: the approval channel's own identity, a session id, or the deployment for a withdrawal. Never a model-supplied reference. */
  decidedBy: string
  /** When the decision was taken, as the writer recorded it. */
  decidedAt: string
  /** Why, when the decider gave a reason. Required for an expiry, which must name what ended the batch. */
  reason?: string
}

/** One consumption (§6): the record that turns a proposal into what it became. Written in the same commit as that thing, so the store can always answer "which proposal became which tasks" — and so a crash between the admission and the first … */
export interface TaskProposalBatchConsumption {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'batch'
  /** The proposal being consumed. */
  proposalId: string
  /** The batch identity that was admitted; must equal the stored proposal's. */
  proposalDigest: string
  /** The review-context fingerprint the admission re-check confirmed; must equal the stored one. */
  reviewContextDigest: string
  /** The parent run whose batch this is; must equal the stored identity's `parentRunId`. */
  parentRunId: RunId
  /** The batch's id in the run coordination protocol: `b-<parentRunId>-<proposalId>` ({@link batchIdFor}). */
  batchId: string
  /** The children this proposal became, in batch order — the ids the admission commit created. */
  childTaskIds: TaskId[]
  /** When the batch was admitted, as the writer recorded it. */
  admittedAt: string
  /** Anything further a reader should know; absent when the writer left none. */
  reason?: string
}

/** What a root contract was activated as (A0 §2): the root task and the root run the activation commit created, named by id. */
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

/** One submitted proposal: the batch or the root contract to run, what it was judged against, and where it stands. */
export interface TaskProposalBase {
  /** The proposal's identity: `p-` plus {@link taskProposalId}'s derivation from the proposal content. */
  proposalId: string
  /** The stable key the caller derived from its own context (§6). One key names at most one proposal: a repeated request with the same key is answered with the stored proposal, a new revision gets a new key, and the store refuses a key that is … */
  requestKey: string
  /** The proposal this one revises (§6), when the caller is replacing a rejected or stale one. */
  supersedes?: string
  /** Where the proposal stands. See {@link TaskProposalStatus} for the full table. */
  status: TaskProposalStatus
  /** The review policy in force when the proposal was submitted (§5). Stored, never re-resolved: `off` is the audit record that this batch ran without a human review (`policy-off`, never a fake `human-approved`), and a later deployment change … */
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
  /** What this proposal became, once it was admitted. Absent while it still might become something. */
  consumption?: TaskProposalConsumption
}

/** One decomposition proposal (T2/T3): a parent task's children, submitted as a batch. `kind` is optional so a record written before the field existed — and a writer that has no reason to state the obvious — still reads as this arm. */
export interface TaskProposalDecomposition extends TaskProposalBase {
  /** The kind, when the writer stated it. Absent means this arm. */
  kind?: 'decomposition'
  /** The complete batch identity, {@link decompositionDigest}'d into {@link proposalDigest}. */
  identity: DecompositionIdentity
  /** The complete batch content, one {@link TaskProposalChild} per {@link identity} child and in the same order: the goals, criteria, assumptions, constraints, capability requirements, dependencies and flags a reviewer reads and a person … */
  batch: readonly TaskProposalChild[]
}

/** One root contract proposal (A0 §2): the goal of a root session, normalized — objective, assumptions, constraints, mandatory acceptance criteria — and submitted as a single contract rather than as children. */
export interface TaskProposalRoot extends TaskProposalBase {
  kind: 'root'
  /** The root contract's identity: {@link rootProposalDigest}'d into {@link proposalDigest}. */
  identity: RootProposalIdentity
  /** The single normalized root contract this proposal asks to run (the content an approval covers and a reviewer reads, stored whole for the same reasons a batch is). */
  contract: TaskContract
}

/** One submitted proposal, either kind. A reader must narrow by `kind` before touching the payload — that is the whole point of the union: `batch` and `contract` are alternatives, and neither exists on the other arm. */
export type TaskProposal = TaskProposalDecomposition | TaskProposalRoot

/** What a decision states when it is written (the payload of `TaskProposalDecided`): {@link TaskProposalDecision} plus the proposal it is about. The reducer checks every field against the stored proposal before the record is applied. */
export interface TaskProposalDecisionClaim extends TaskProposalDecision {
  /** The proposal this decision is about. */
  proposalId: string
}

/** One runtime-driven phase change (the payload of `TaskProposalPhaseChanged`): a proposal sent to review because the deployment tightened to `all`, an approval whose re-check passed (`approved → ready`, §6's "批准已落账、等待重检/准入"), or one whose … */
export interface TaskProposalPhaseChange {
  /** The proposal being moved. */
  proposalId: string
  /** Where it moves to; see {@link TaskProposalPhase} and {@link TaskProposalStatus} for the legal sources. */
  to: TaskProposalPhase
  /** Why the runtime moved it. Required for `stale` — an invalidation has to name what changed. */
  reason?: string
}

/** The proposal queries a snapshot answers (§6/§7): by id, by the request key a caller derived, and by parent task — the three questions a runtime asks when it decides whether to submit, decide, or resume a batch. */
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

/** The `p-` prefix every proposal id carries, so an id is recognizable as one wherever it is printed. Module-local: the two id derivations below are its only callers, and no other file names it (R2). */
const TASK_PROPOSAL_ID_PREFIX = 'p-'

/** The proposal id one batch identity gets: `p-` plus {@link decompositionDigest} of the identity. */
export function taskProposalId(identity: DecompositionIdentity): string {
  return `${TASK_PROPOSAL_ID_PREFIX}${decompositionDigest(identity)}`
}

/** The id one admitted batch carries in the run coordination protocol: `b-<parentRunId>-<proposalId>`. */
export function batchIdFor(parentRunId: RunId, proposalId: string): string {
  return `b-${parentRunId}-${proposalId}`
}

/** The root contract's identity: SHA-256 over {@link canonicalize} of {@link RootProposalIdentity} — which store, which root session, which request key, and the digest of the normalized root contract. */
export function rootProposalDigest(identity: RootProposalIdentity): string {
  return sha256Hex(canonicalize(identity))
}

/** The proposal id one root contract identity gets: `p-` plus {@link rootProposalDigest} of the identity. */
export function rootProposalId(identity: RootProposalIdentity): string {
  return `${TASK_PROPOSAL_ID_PREFIX}${rootProposalDigest(identity)}`
}

/** The identity of the limits a batch was admitted under: SHA-256 over {@link canonicalize} of the {@link AdmissionContext}. */
export function admissionContextDigest(context: AdmissionContext): string {
  return sha256Hex(canonicalize(context))
}

/** The identity of what a batch resolved against: SHA-256 over {@link canonicalize} of every manifest the batch resolved, **in batch order** — the order the children were proposed in, so two resolutions of the same batch that assigned the … */
export function capabilityManifestDigest(manifests: readonly CapabilityManifest[]): string {
  return sha256Hex(canonicalize(manifests))
}

/** The identity of the resolution a proposal was reviewed against: SHA-256 over {@link canonicalize} of the {@link TaskProposalReviewContext} with its verifier list normalized to ascending `(verifierId, version, configurationDigest)`. */
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
