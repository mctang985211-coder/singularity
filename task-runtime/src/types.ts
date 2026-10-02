/**
 * The runtime's public domain types: intake, proposals, budgets, review and recovery contracts.
 */

import type { AgentOptions } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  AcceptanceCriterion,
  BudgetExtensionProposal,
  CapabilityManifest,
  ExecutionPhase,
  Obligation,
  RunId,
  RunMemberReuse,
  RunMemberReuseRefusal,
  RunStatus,
  TaskBudgetExtension,
  TaskContract,
  TaskContractInput,
  TaskId,
  TaskInstance,
  TaskProposal,
  TaskProposalDecomposition,
  TaskProposalDecisionOutcome,
  TaskProposalPolicy,
  TaskProposalRoot,
  TaskProposalStatus,
  TaskRun,
} from '@dangosys/dsh-singularity-task'
import type { ProviderPrecheck } from './provider-precheck.ts'
import type { RootBudgetCeilings } from './root-budget.ts'
import type { DecompositionIdentityContext, NormalizedBatch } from './normalize.ts'
import type { RootRecoveryRequest, RootRecoveryReuse } from './recovery.ts'
import type { AdoptedWorkerResume, ReplayOverlay } from './orchestration/types.ts'
import type { QuestionReconcileReport } from './question.ts'

export interface CommitReconcileOutcome {
  readonly intentId: string
  readonly proposalId: string
  readonly direction: string
  /** Every production file the intent committed, in intent order — one or two files of the skill object (K3). */
  readonly targets: readonly string[]
  readonly result: 'completed-redone' | 'completed-written' | 'blocked'
  readonly detail?: string
}

export type { CriterionSpec } from '@dangosys/dsh-singularity-task'

export interface DecomposeChildSpec extends TaskContractInput {
  dependsOn?: readonly number[]
  decomposable?: boolean
  requiresIndependentAcceptance?: boolean
}

export interface DecomposeSpec {
  children: readonly DecomposeChildSpec[]
  reason: string
  /**
   * The contract language this batch is written in (T1). Omitted is the legacy
   * adapter — the runtime writes its current version, which is what an entry
   */
  contractVersion?: number
}

export interface RootContractSpec extends TaskContractInput {
  contractVersion?: number
}

export interface RootIntakeOptions {
  /**
   * The idempotency key this request is addressed by (§2). Absent, the runtime
   * derives it from the store, the root session and the contract's own digest
   */
  requestKey?: string
  /** The proposal this one revises (§6): a rejected or stale root contract, whose record is kept. */
  supersedes?: string
  /**
   * The call's own control: an already-aborted `signal` persists nothing. There is
   * no `callId` here and no write drain behind it — nothing about an activation
   */
  exec?: { signal?: AbortSignal }
}

export type RootIntakeResult =
  | {
      status: 'activated'
      proposalId: string
      taskId: TaskId
      runId: RunId
      detail: string
    }
  | {
      status: 'pending_review'
      proposalId: string
      detail: string
    }

export type RootAdoption =
  | {
      adopted: true
      taskId: TaskId
      runId: RunId
      /**
       * The phase this session's execution gate now holds, derived from the
       * store's own run record. A root run that reached a terminal state leaves
       */
      phase: ExecutionPhase | 'terminal'
      detail: string
    }
  | {
      adopted: false
      detail: string
    }

export interface ReplayTaskOptions {
  /** Lineage tag, e.g. `evolution-replay:<proposalId>` — written into the replayed task's objective and the review record's anomalies. */
  lineage: string
  /** Candidate-side per-run patches; absent replays under the production configuration. */
  overlay?: ReplayOverlay
  /** Candidate contract replacing the champion's (the task_definition deterministic criteria replay). */
  contract?: { objective: string; acceptanceCriteria: AcceptanceCriterion[]; requiredCapabilities: string[] }
  /** false: no worker spawn — the verifier alone settles the run (deterministic criteria replay). Default true. */
  spawn?: boolean
  /**
   * The workspace this replay runs in, when the caller has prepared one of its
   * own (S4-E) instead of replaying into its own checkout. The directory is
   */
  workspace?: { path: string }
  /**
   * The model selection this replay runs under (S4-E §Q3), replacing the
   * deployment's default for this run's worker and for every worker its
   */
  agentOptions?: AgentOptions
  signal?: AbortSignal
}

export interface DecomposeProposalOptions {
  /**
   * The idempotency key this request is addressed by (§6). Absent, the runtime
   * derives it from the calling context
   */
  requestKey?: string
  /**
   * The proposal this one revises (§6): a rejected or stale one, whose record
   * is kept. A revision is new content (and a new key); naming the predecessor
   */
  supersedes?: string
  /**
   * The admission call's own control: `signal` governs the pre-check (an
   * already-aborted call persists nothing), `callId` is the call's own
   */
  exec?: { signal?: AbortSignal; callId?: string }
}

export interface ProposalSubmission {
  proposalId: string
  status: TaskProposalStatus
  /** The policy the proposal was born under (the audit field, never a fake approval). */
  policy: TaskProposalPolicy
  /** True when this request was answered from a stored proposal (`requestKey` + content) instead of a new submission. */
  existing: boolean
  /** What the caller owes next, or what happened to the review request, in one sentence. */
  detail: string
  /** How the review request went, when the proposal is waiting for one. */
  review?: { requested: boolean; detail: string }
}

export type DecomposeAdmissionResult =
  | {
      status: 'admitted'
      proposalId: string
      batchId: string
      childTaskIds: TaskId[]
    }
  | {
      status: 'pending_review'
      proposalId: string
      /** Where the proposal stands and what a decision would have to be. */
      detail: string
      batchId: never
      childTaskIds: never
    }

export type ProposalContinuation =
  | {
      proposalId: string
      status: 'admitted'
      batchId: string
      childTaskIds: TaskId[]
      detail: string
    }
  | {
      proposalId: string
      status: 'activated'
      /** The root task the activation commit created, carrying the approved contract. */
      taskId: TaskId
      /** The root run the activation commit created, in the proposal's root session and born `active`. */
      runId: RunId
      detail: string
    }
  | {
      proposalId: string
      status: Exclude<TaskProposalStatus, 'admitted'>
      detail: string
      /** The machine reason recorded with the status, when the status is one the runtime wrote (`stale`, `expired`). */
      reason?: string
    }

export interface ProposalDecisionResult {
  proposalId: string
  /** The outcome that was **recorded**, not the one that was asked for: a late approval becomes `expired` (§6). */
  outcome: TaskProposalDecisionOutcome
  /** Where the proposal stands: its stored status, or `activated` once a root contract's approval has created it. */
  status: TaskProposalStatus | 'activated'
  /** The continuation an approval triggered, when one was attempted. */
  continuation?: ProposalContinuation
  detail: string
  /** The reason recorded with the outcome, when there was one. */
  reason?: string
}

export interface CapabilityGap {
  /** The child's batch position (its index in the proposal's children). */
  childIndex: number
  /** That child's objective, so the obligation raised for the gap names the work it blocks. */
  objective: string
  /** The capability names the registry could not grant. */
  missing: readonly string[]
}

export interface DecompositionRefusal {
  readonly error: Error
  readonly reasons: readonly string[]
  readonly gaps: readonly CapabilityGap[]
}

type ProposalReviewTrigger = 'submitted' | 'tightened' | 'recovered'

interface ProposalReviewRequestBase {
  readonly storeId: string
  readonly trigger: ProposalReviewTrigger
  readonly proposal: TaskProposal
  /** The manifests this proposal resolves to right now; aligned with the batch's children, or the root contract's declared capabilities. */
  readonly manifests: readonly CapabilityManifest[]
  /** The registered verifier ids at the moment of the request, when the deployment can list them. */
  readonly registeredVerifiers?: readonly string[]
  /** Every obligation raised on the subject so far — §5's "未满足义务说明", read from the store rather than summarized. */
  readonly obligations: readonly Obligation[]
}

export interface DecompositionReviewRequest extends ProposalReviewRequestBase {
  /** The kind, when the writer stated it. Absent means this arm — the shape every request had before root intake existed. */
  readonly kind?: 'decomposition'
  /** The parent task the batch belongs to, as the store holds it. */
  readonly parentTask: TaskInstance
  /**
   * The batch the proposal holds, rebuilt from the store (`storedBatchOf`) — the
   * contracts a reviewer has to read, not a digest, and not whatever a live
   */
  readonly batch: NormalizedBatch
}

export interface RootContractReviewRequest extends ProposalReviewRequestBase {
  readonly kind: 'root'
  /** The root session whose goal this contract is. There is no parent task to name, and none is invented. */
  readonly rootSessionId: string
  /** The normalized root contract the proposal asks to run, as stored — what a reviewer reads is what an approval binds. */
  readonly contract: TaskContract
}

export type ProposalReviewRequest = DecompositionReviewRequest | RootContractReviewRequest

export interface ProposalReviewNotice {
  /** Whether a person was actually asked. */
  readonly requested: boolean
  /** What the channel reported, for the caller to render. */
  readonly detail?: string
}

export interface ProposalReviewChannel {
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>
}

export interface QuestionResumeReport {
  /** The run the attempt was about, as the store names it (`run "r-…" (session "s-…")`). */
  readonly subject: string
  readonly status: AdoptedWorkerResume['status']
  /** Present for `retry` and `refused`: why the Session was not brought back. */
  readonly reason?: string
}

export interface ReconcileReport {
  readonly unresolvedProposals: readonly {
    proposalId: string
    status: TaskProposalStatus
    reason: string
  }[]
  /**
   * What the pass's own question deliveries settled as (A4 §F.1), one record per
   * fact the store still owed a message for — `delivered`, `already-present`, or
   */
  readonly questionDeliveries: readonly QuestionReconcileReport[]
  /**
   * What the pass's own recovery of workers settled as (A4 §F.1, widened by K1
   * §5), one record per run it tried to bring back — `live` for a Session that is
   */
  readonly questionResumes: readonly QuestionResumeReport[]
}

export type StoreRecoveryStatus =
  | { status: 'ready' }
  | { status: 'not-activated'; reason: string }
  | { status: 'recovering' }
  | { status: 'recovery-required'; reason: string }
  | { status: 'needs-recovery'; reason: string }
  | { status: 'recovery-failed'; reason: string }

export type DecompositionPrecheck =
  | { ok: true; batch: NormalizedBatch; manifests: CapabilityManifest[]; providers: ProviderPrecheck }
  | { ok: false; refusal: DecompositionRefusal }

export type RootPrecheck =
  { ok: true; manifests: CapabilityManifest[]; providers: ProviderPrecheck } | { ok: false; refusal: RootRefusal }

interface RootRefusal {
  readonly error: Error
  readonly reasons: readonly string[]
}

export type ReviewSubject =
  | {
      kind?: 'decomposition'
      storeId: string
      trigger: ProposalReviewTrigger
      proposal: TaskProposal
      parentTask: TaskInstance
      batch: NormalizedBatch
      manifests: readonly CapabilityManifest[]
    }
  | {
      kind: 'root'
      storeId: string
      trigger: ProposalReviewTrigger
      proposal: TaskProposal
      rootSessionId: string
      contract: TaskContract
      manifests: readonly CapabilityManifest[]
    }

export interface RootBudgetExtensionRequest {
  readonly requestKey: string
  readonly maxRuns: number
}

export const BUDGET_EXTENSION_REQUEST_FIELDS: readonly string[] = ['requestKey', 'maxRuns']

export interface RootBudgetExtensionHost {
  /** The host's own identity for the call the question is asked under (the DSH tool call id). */
  readonly callId: string
  /** The host execution handle; the runtime carries it and never reads it. */
  readonly execution: unknown
}

export type RootBudgetApprovalDecision =
  { readonly kind: 'allowed'; readonly reference: string } | { readonly kind: 'refused'; readonly reason: string }

export interface RootBudgetApprovalAsk {
  readonly storeId: string
  readonly rootTaskId: TaskId
  readonly rootSessionId: string
  /** What this deployment's configuration alone allows, resolved against the root's own start. */
  readonly configured: RootBudgetCeilings
  /** The complete reading in force, frozen by the runtime right now and re-checked inside the store's write queue. */
  readonly effective: RootBudgetCeilings
  readonly runsUsed: number
  readonly proposal: Omit<BudgetExtensionProposal, 'deadlineAt'>
  readonly host: RootBudgetExtensionHost
}

export type RootBudgetApproval = (ask: RootBudgetApprovalAsk) => Promise<RootBudgetApprovalDecision>

export interface RootBudgetExtensionResult {
  readonly storeId: string
  readonly rootTaskId: TaskId
  /** True when the answer is a record the store already held rather than one this call committed: nothing was written and no grant was taken. */
  readonly answeredFromRecord: boolean
  readonly record: TaskBudgetExtension
}

export type BudgetExtensionJudgement =
  | { readonly kind: 'recorded'; readonly record: TaskBudgetExtension }
  | { readonly kind: 'proposed'; readonly proposal: Omit<BudgetExtensionProposal, 'deadlineAt'> }
  | { readonly kind: 'refused'; readonly reason: string }

export interface AdmitBatchRequest {
  proposal: TaskProposalDecomposition
  parentTask: TaskInstance
  parentRun: TaskRun
  batch: NormalizedBatch
  manifests: readonly CapabilityManifest[]
  providers: ProviderPrecheck
  exec?: { signal?: AbortSignal; callId?: string }
}

/** What one root recovery attempt opens: the derived contract, the store facts it is bound to, and the caller's own control. */
export interface StartRecoveryAttemptInput {
  readonly storeId: string
  readonly source: TaskInstance
  readonly request: RootRecoveryRequest
  /** The round's source run, when the store resolved one: the facts the new attempt's kickoff notice is read from. */
  readonly sourceRun?: TaskRun
  readonly declarations: readonly RootRecoveryReuse[]
  readonly unbound: readonly RunMemberReuseRefusal[]
  readonly manifest: CapabilityManifest
  readonly precheck: ProviderPrecheck
  readonly rootSessionId: string
  /** The calling session, recorded as the actor of the attempt's own writes. */
  readonly actor: string
  readonly signal?: AbortSignal
}

/** The stored batch one continuation re-checks before admission (§6): the content the proposal carries and the limits in force now. */
export interface CheckDerivedBatchRequest {
  readonly identity: DecompositionIdentityContext
  readonly parentTask: TaskInstance
  readonly batch: NormalizedBatch
  readonly envPath?: string
}

/** The root contract one intake judges before a proposal exists. */
export interface CheckRootContractRequest {
  readonly rootSessionId: string
  readonly contract: TaskContract
  readonly envPath?: string
}

/** The commit that turns an approved root proposal into the store's root task and run. */
export interface ActivateRootContractRequest {
  readonly storeId: string
  readonly rootSessionId: string
  readonly proposal: TaskProposalRoot
  readonly contract: TaskContract
  readonly manifests: readonly CapabilityManifest[]
}

/** The batch a runtime start hands to the driver it spawns. */
export interface StartBatchDriverOptions {
  readonly storeId: string
  readonly parentTaskId: TaskId
  readonly parentRunId: RunId
  readonly batchId: string
  readonly callerSessionId: string
  readonly reason: string
  readonly providers?: ProviderPrecheck
  readonly excludeCallId?: string
}

export interface RootRecoveryCaller {
  readonly sessionId: string
  readonly signal?: AbortSignal
}

export interface RootRecoveryOutcome {
  /** `started` — this call opened the attempt; `existing` — the key already named it and nothing was written. */
  readonly attempt: 'started' | 'existing'
  readonly storeId: string
  readonly sourceTaskId: TaskId
  readonly sourceDiagnosisId: string
  readonly requestKey: string
  readonly runId: RunId
  readonly sessionId: string
  readonly status: RunStatus
  /** The verified siblings the attempt reads, by the positions they claim. */
  readonly reusedMembers: readonly RunMemberReuse[]
  /**
   * The positions of the failed run that read a passed sibling the attempt could
   * not bind, with every reason — the "affected items" a reader can act on. The
   */
  readonly unboundMembers: readonly RunMemberReuseRefusal[]
  readonly detail: string
}
