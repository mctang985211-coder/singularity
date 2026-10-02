/**
 * Proposal lifecycle: submission, continuation, decisions and review requests.
 */

import type { TaskRuntime } from './runtime.ts'
import { enqueueByKey, message } from '../helpers.ts'
import { randomUUID } from 'node:crypto'
import type {
  RunId,
  TaskId,
  TaskProposal,
  TaskProposalDecisionOutcome,
  TaskProposalStatus,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import {
  admissionContextDigest,
  blockingQuestionsOf,
  reviewContextDigest,
  taskProposalId,
} from '@dangosys/dsh-singularity-task'
import { providerContentIdentities } from '../provider-precheck.ts'
import { decompositionIdentity } from '../normalize.ts'
import type { DecompositionIdentityContext } from '../normalize.ts'
import { isOpenProposal, proposalRequestKey, reviewContextDelta, reviewContextOf } from '../proposal.ts'
import { VerifierUnavailableError } from '../orchestration/types.ts'
import type {
  DecomposeSpec,
  DecomposeProposalOptions,
  ProposalSubmission,
  DecomposeAdmissionResult,
  ProposalContinuation,
  ProposalDecisionResult,
  DecompositionRefusal,
  ProposalReviewRequest,
  ProposalReviewChannel,
  ReconcileReport,
  ReviewSubject,
} from '../types.ts'
import { now } from '../helpers.ts'

export async function decomposeAndRun(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
  parentRunId: RunId,
  callerSessionId: string,
  spec: DecomposeSpec,
  exec: { signal?: AbortSignal; callId?: string } = {},
): Promise<DecomposeAdmissionResult> {
  await self.assertRecoveryReady(storeId, 'a decomposition')
  const submission = await submitDecompositionProposal(
    self,
    storeId,
    parentTaskId,
    parentRunId,
    callerSessionId,
    spec,
    {
      ...(exec.signal === undefined && exec.callId === undefined ? {} : { exec }),
    },
  )
  const continued = await continueProposal(self, storeId, submission.proposalId, callerSessionId, {
    ...(exec.callId === undefined ? {} : { exec: { callId: exec.callId } }),
  })
  if (continued.status === 'admitted') {
    return {
      status: 'admitted',
      proposalId: continued.proposalId,
      batchId: continued.batchId,
      childTaskIds: continued.childTaskIds,
    }
  }
  if (continued.status === 'pending_review') {
    return {
      status: 'pending_review',
      proposalId: continued.proposalId,
      detail: continued.detail,
      batchId: undefined as never,
      childTaskIds: undefined as never,
    }
  }
  throw new Error(
    `task-runtime: decomposition of "${parentTaskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`,
  )
}

export async function submitDecompositionProposal(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
  parentRunId: RunId,
  callerSessionId: string,
  spec: DecomposeSpec,
  options: DecomposeProposalOptions = {},
): Promise<ProposalSubmission> {
  await self.assertRecoveryReady(storeId, 'a decomposition proposal')
  return await serializeParent(self, storeId, parentTaskId, () =>
    submitProposalOnce(self, storeId, parentTaskId, parentRunId, callerSessionId, spec, options),
  )
}

export async function continueProposal(
  self: TaskRuntime,
  storeId: string,
  proposalId: string,
  caller: string,
  options: { spec?: DecomposeSpec; exec?: { callId?: string } } = {},
): Promise<ProposalContinuation> {
  await self.assertRecoveryReady(storeId, 'the continuation of a proposal')
  const proposal = await requireProposal(self, storeId, proposalId)
  if (proposal.kind === 'root') {
    return await self.serializeRootIntake(storeId, () => continueProposalIn(self, storeId, proposalId, caller, options))
  }
  return await serializeParent(self, storeId, proposal.identity.parentTaskId, () =>
    continueProposalIn(self, storeId, proposalId, caller, options),
  )
}

export async function decideProposal(
  self: TaskRuntime,
  storeId: string,
  proposalId: string,
  decision: { outcome: TaskProposalDecisionOutcome; reason?: string; decidedAt?: string },
  decidedBy: string,
  exec: { callId?: string } = {},
): Promise<ProposalDecisionResult> {
  await self.assertRecoveryReady(storeId, 'a proposal decision')
  const proposal = await requireProposal(self, storeId, proposalId)
  const serialize = async <T>(work: () => Promise<T>): Promise<T> =>
    proposal.kind === 'root'
      ? await self.serializeRootIntake(storeId, work)
      : await serializeParent(self, storeId, proposal.identity.parentTaskId, work)
  return await serialize(async () => {
    const current = await requireProposal(self, storeId, proposalId)
    if (decidedBy.trim().length === 0)
      throw new Error(`task-runtime: a decision on proposal "${proposalId}" requires a decider`)
    if (decision.reason !== undefined && decision.reason.trim().length === 0) {
      throw new Error(`task-runtime: a decision reason on proposal "${proposalId}" must be non-empty when given`)
    }
    const decidedAt = decision.decidedAt ?? now()
    let outcome = decision.outcome
    let reason = decision.reason
    if (outcome === 'approved') {
      /**
       * A late approval may only invalidate (§6), and what makes it late is the
       * subject's own state: a parent run that ended, or — for a root contract —
       */
      const ended = await approvalLatenessReason(self, storeId, current)
      if (ended !== undefined) {
        outcome = 'expired'
        reason = `the approval arrived after ${current.kind === 'root' ? 'the root contract' : 'the batch'} could be dispatched: ${ended}`
      }
    }
    if (outcome === 'expired' && reason === undefined) {
      throw new Error(`task-runtime: an expiry of proposal "${proposalId}" must state what ended the batch`)
    }
    await self.context.task.decideProposalIn(
      storeId,
      {
        proposalId,
        outcome,
        proposalDigest: current.proposalDigest,
        admissionContextDigest: current.admissionContextDigest,
        ...(outcome === 'approved' ? { reviewContextDigest: current.reviewContextDigest } : {}),
        decidedBy,
        decidedAt,
        ...(reason === undefined ? {} : { reason }),
      },
      decidedBy,
    )
    if (outcome !== 'approved') {
      return {
        proposalId,
        outcome,
        status: outcome,
        detail: `proposal "${proposalId}" is ${outcome}${reason === undefined ? '' : `: ${reason}`}`,
        ...(reason === undefined ? {} : { reason }),
      }
    }
    try {
      const continuation = await continueProposalIn(self, storeId, proposalId, proposalCallerOf(current), { exec })
      return {
        proposalId,
        outcome,
        status: continuation.status,
        continuation,
        detail: `proposal "${proposalId}" is approved; ${continuation.detail}`,
      }
    } catch (error) {
      /**
       * The decision is on the record and what the proposal asked for was not
       * created. Both facts are reported: the proposal stays where the
       */
      const detail = message(error)
      self.warn(`proposal ${proposalId}: the approval is recorded but the continuation failed (${detail})`)
      const stored = await readProposal(self, storeId, proposalId).catch(() => undefined)
      return {
        proposalId,
        outcome,
        status: stored?.status ?? outcome,
        detail:
          `the approval of proposal "${proposalId}" is recorded; ` +
          `${current.kind === 'root' ? 'the root was not activated' : 'the batch was not admitted'}: ${detail}`,
      }
    }
  })
}

export async function approvalLatenessReason(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposal,
): Promise<string | undefined> {
  if (proposal.kind !== 'root') return await parentRunEndedReason(self, storeId, proposal)
  const existing = await self.existingRootTask(storeId)
  if (existing === undefined) return undefined
  return `store "${storeId}" already holds root task "${existing.taskId}"`
}

export async function cancelProposal(
  self: TaskRuntime,
  storeId: string,
  proposalId: string,
  caller: string,
): Promise<ProposalDecisionResult> {
  const proposal = await requireProposal(self, storeId, proposalId)
  const owner = proposalCallerOf(proposal)
  if (caller !== owner) {
    throw new Error(
      `task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" ` +
        'cannot withdraw it (a withdrawal by anybody else is a decision, and is recorded as one — decideProposal with "cancelled")',
    )
  }
  return await decideProposal(self, storeId, proposalId, { outcome: 'cancelled' }, caller)
}

export function proposalCallerOf(proposal: TaskProposal): string {
  return proposal.kind === 'root' ? proposal.identity.rootSessionId : proposal.identity.callerSessionId
}

export async function proposalIn(self: TaskRuntime, storeId: string, proposalId: string): Promise<TaskProposal> {
  return await requireProposal(self, storeId, proposalId)
}

export async function proposalsForParent(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
): Promise<TaskProposal[]> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  return [...(snapshot.proposals?.byParentTask[parentTaskId] ?? [])]
}

export async function submitProposalOnce(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
  parentRunId: RunId,
  callerSessionId: string,
  spec: DecomposeSpec,
  options: DecomposeProposalOptions,
): Promise<ProposalSubmission> {
  const actor = callerSessionId
  const identity: DecompositionIdentityContext = { storeId, parentTaskId, parentRunId, callerSessionId }
  const parentTask = await self.context.task.taskIn(storeId, parentTaskId)
  const parentRun = await self.context.task.runIn(storeId, parentRunId)
  // (1) The presented batch becomes a normalized one — or the request is
  //     refused, field by field, before a proposal exists.
  const derived = await self.deriveBatch(identity, spec)
  if (!derived.ok) return await refusePrecheck(self, storeId, parentTaskId, actor, derived.refusal)
  const { batch } = derived

  /**
   * (2) §6's request key: the caller's own when it has one, otherwise derived
   *     from the calling context and the batch's own digest — stable across a
   */
  const requestKey =
    options.requestKey ?? proposalRequestKey({ ...identity, proposalDigest: batch.admission.proposalDigest })
  const stored = await proposalForRequest(self, storeId, requestKey, batch.admission.proposalDigest)
  if (stored !== undefined) {
    /**
     * The caller presented the batch again and the digest says it is the one
     * this request names: the stored proposal already carries the content, so
     */
    const storedBatch = self.storedBatchOf(stored)
    const review =
      stored.status === 'pending_review'
        ? await requestProposalReview(self, {
            storeId,
            trigger: 'submitted',
            proposal: stored,
            parentTask,
            batch: storedBatch,
            manifests: self.manifestsOf(storedBatch, callerSessionId),
          })
        : undefined
    return {
      proposalId: stored.proposalId,
      status: stored.status,
      policy: stored.policy,
      existing: true,
      detail: submissionDetail(stored, true),
      ...(review === undefined ? {} : { review }),
    }
  }

  /**
   * (3) A genuinely new batch: only a run that may still decide its own work
   *     may propose one, and the batch has to clear every admission rule. Two
   */
  await self.assertDecomposableRun(storeId, parentTask, parentRun, callerSessionId, options.exec?.signal)
  const inFlight = await self.inFlightProposalsOf(storeId, parentRunId)
  if (inFlight.length > 0) {
    const held = inFlight[0]!
    throw new Error(
      `task-runtime: run "${parentRunId}" already has a proposal in flight — "${held.proposalId}" is ${held.status}; ` +
        'a run has at most one batch proposal at a time, so continue that one (or withdraw it with task_proposal_cancel) ' +
        'rather than proposing a second, and nothing was recorded',
    )
  }
  const checked = await self.checkDerivedBatch({
    identity,
    parentTask,
    batch,
    ...(derived.envPath === undefined ? {} : { envPath: derived.envPath }),
  })
  if (!checked.ok) return await refusePrecheck(self, storeId, parentTaskId, actor, checked.refusal)
  const { manifests, providers } = checked

  const reviewContext = reviewContextOf({
    manifests,
    criteria: batch.children.flatMap(child => child.contract.acceptanceCriteria),
    providers: providerContentIdentities(providers.capabilities),
  })
  const policy = self.config.generatedTaskReview
  const proposalIdentity = decompositionIdentity(identity, batch.reason, batch.children)
  const proposal: TaskProposal = {
    proposalId: taskProposalId(proposalIdentity),
    requestKey,
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    status: policy === 'all' ? 'pending_review' : 'ready',
    policy,
    identity: proposalIdentity,
    /**
     * The batch's content travels with the proposal, not only its digest: a
     * reviewer, a canvas and a resumed continuation all render what was asked
     */
    batch: batch.children,
    proposalDigest: batch.admission.proposalDigest,
    admissionContext: batch.admission.context,
    admissionContextDigest: admissionContextDigest(batch.admission.context),
    reviewContext,
    reviewContextDigest: reviewContextDigest(reviewContext),
    createdAt: now(),
  }
  try {
    await self.context.task.submitProposalIn(storeId, proposal, actor)
  } catch (error) {
    /**
     * A store that already holds *this* batch is a race, not a failure: the
     * request is answered from the record exactly as a retry is. A refusal
     */
    const raced = await readProposal(self, storeId, proposal.proposalId).catch(() => undefined)
    if (raced === undefined || raced.proposalDigest !== proposal.proposalDigest) throw error
    return {
      proposalId: raced.proposalId,
      status: raced.status,
      policy: raced.policy,
      existing: true,
      detail: submissionDetail(raced, true),
    }
  }
  if (proposal.status !== 'pending_review') {
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      policy: proposal.policy,
      existing: false,
      detail: submissionDetail(proposal, false),
    }
  }
  const review = await requestProposalReview(self, {
    storeId,
    trigger: 'submitted',
    proposal,
    parentTask,
    batch,
    manifests,
  })
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    policy: proposal.policy,
    existing: false,
    detail: submissionDetail(proposal, false),
    review,
  }
}

export async function continueProposalIn(
  self: TaskRuntime,
  storeId: string,
  proposalId: string,
  caller: string,
  options: { spec?: DecomposeSpec; exec?: { callId?: string } },
): Promise<ProposalContinuation> {
  const proposal = await requireProposal(self, storeId, proposalId)
  const owner = proposalCallerOf(proposal)
  if (caller !== owner) {
    throw new Error(
      `task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot continue it ` +
        "(a proposal belongs to the session that made it, and an approval is continued on that session's behalf)",
    )
  }
  switch (proposal.status) {
    case 'admitted': {
      const consumption = proposal.consumption
      if (consumption === undefined) {
        throw new Error(
          `task-runtime: proposal "${proposalId}" is admitted without a consumption record; the store is inconsistent and nothing is dispatched`,
        )
      }
      /**
       * What the proposal became is read off the consumption, by kind: a batch
       * names its children, a root contract names the task and run it became.
       */
      if (consumption.kind === 'root') {
        return {
          proposalId,
          status: 'activated',
          taskId: consumption.rootTaskId,
          runId: consumption.rootRunId,
          detail:
            `proposal "${proposalId}" is activated as root task ${consumption.rootTaskId} with run ${consumption.rootRunId}; ` +
            'that root is not activated again',
        }
      }
      return {
        proposalId,
        status: 'admitted',
        batchId: consumption.batchId,
        childTaskIds: [...consumption.childTaskIds],
        detail: `proposal "${proposalId}" is admitted as batch ${consumption.batchId}; the runtime owns that batch and it is not admitted again`,
      }
    }
    case 'pending_review':
      return {
        proposalId,
        status: 'pending_review',
        detail: `proposal "${proposalId}" is waiting for a review; only a decision on the record advances it (§6)`,
      }
    case 'rejected':
    case 'cancelled':
    case 'stale':
    case 'expired':
      return {
        proposalId,
        status: proposal.status,
        detail: `proposal "${proposalId}" is ${proposal.status}; nothing was admitted and nothing is dispatched`,
        ...(proposal.decision?.reason === undefined ? {} : { reason: proposal.decision.reason }),
      }
    default:
      break
  }

  /**
   * A root contract's continuation is a different ladder from a batch's — one
   * store-level gate and two fingerprints, with no parent task and no parent
   */
  if (proposal.kind === 'root') {
    return await self.continueRootProposalIn(storeId, proposal)
  }

  const parentTaskId = proposal.identity.parentTaskId
  const parentTask = await self.context.task.taskIn(storeId, parentTaskId)
  /**
   * (1) The run's own state, re-read here (K1 §3): an approval is a record, and
   * what it may still become is a question about the run *now*, never about the
   */
  const parentRun = await self.context.task.runIn(storeId, proposal.identity.parentRunId).catch(() => undefined)
  if (parentRun === undefined) {
    throw new Error(
      `task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${proposal.identity.parentRunId}" is not in store "${storeId}", ` +
        'and a batch is never admitted against a run the store does not hold',
    )
  }
  if (parentRun.batchId !== undefined) {
    return await staleProposal(
      self,
      storeId,
      proposal,
      `run "${parentRun.runId}" is already waiting on batch "${parentRun.batchId}", so this proposal's batch cannot become it ` +
        '(a run holds at most one unfinished batch); the approval is not transferred to another batch',
    )
  }
  if (parentRun.status !== 'running' || parentRun.executionPhase !== 'active') {
    throw new Error(
      `task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is ` +
        `${parentRun.status === 'running' ? `in phase "${parentRun.executionPhase ?? 'none'}"` : parentRun.status}` +
        '; only an active run may admit a batch, nothing was admitted, and the approval stays on the record',
    )
  }
  const blocking = blockingQuestionsOf(await self.context.task.snapshotIn(storeId), parentRun.runId)
  if (blocking.length > 0) {
    throw new Error(
      `task-runtime: proposal "${proposalId}" cannot be continued: its parent run "${parentRun.runId}" is waiting on ` +
        `${blocking.length === 1 ? 'an unresolved blocking question' : `${blocking.length} unresolved blocking questions`} ` +
        `(${blocking.map(question => question.questionId).join(', ')}); an answer releases the wait, and nothing was admitted`,
    )
  }

  /**
   * (2) The policy gate (§5). A batch born under `off` that has not been
   * admitted is subject to the deployment's *current* policy: tightened to
   */
  const envPath = await self.envPathForSession(owner)
  if (proposal.status === 'ready' && proposal.policy === 'off' && self.config.generatedTaskReview === 'all') {
    await self.context.task.changeProposalPhaseIn(
      storeId,
      {
        proposalId,
        to: 'pending_review',
        reason:
          'the deployment tightened the review policy to "all" while this batch had not been admitted yet (§5: only tightening is allowed, and it reaches whatever has not run)',
      },
      owner,
    )
    const tightened = await requireProposal(self, storeId, proposalId)
    const tightenedBatch = self.storedBatchOf(tightened)
    let detail = 'it is now waiting for a review'
    const reviewed = await self.checkDerivedBatch({
      identity: {
        storeId,
        parentTaskId: proposal.identity.parentTaskId,
        parentRunId: proposal.identity.parentRunId,
        callerSessionId: proposal.identity.callerSessionId,
      },
      parentTask,
      batch: tightenedBatch,
      ...(envPath === undefined ? {} : { envPath }),
    })
    if (reviewed.ok) {
      const review = await requestProposalReview(self, {
        storeId,
        trigger: 'tightened',
        proposal: tightened,
        parentTask,
        batch: tightenedBatch,
        manifests: reviewed.manifests,
      })
      detail += `; ${review.detail}`
    } else {
      detail += `, and its batch no longer passes admission (${reviewed.refusal.reasons.join('; ')})`
    }
    return { proposalId, status: 'pending_review', detail: `proposal "${proposalId}" was sent for review: ${detail}` }
  }

  /**
   * (3) The batch's content comes from the store (§6): a proposal carries what
   * was asked for, so a continuation never depends on what this process still
   */
  const identity = {
    storeId,
    parentTaskId: proposal.identity.parentTaskId,
    parentRunId: proposal.identity.parentRunId,
    callerSessionId: proposal.identity.callerSessionId,
  }
  if (options.spec !== undefined) {
    const presented = await self.deriveBatch(identity, options.spec)
    if (!presented.ok) {
      throw new Error(
        `task-runtime: the batch presented for proposal "${proposalId}" is not a usable one: ${presented.refusal.reasons.join('; ')}`,
      )
    }
    if (presented.batch.admission.proposalDigest !== proposal.proposalDigest) {
      throw new Error(
        `task-runtime: the batch presented for proposal "${proposalId}" is a different one ` +
          `(digest ${presented.batch.admission.proposalDigest} ≠ the stored ${proposal.proposalDigest}); an approval never travels to other content, ` +
          'and nothing was admitted',
      )
    }
  }
  const batch = self.storedBatchOf(proposal)

  /**
   * (4) The re-check (§6): the stored batch is judged again exactly as it was
   * judged at submission — structure, capabilities, providers, verifierRefs —
   */
  const checked = await self.checkDerivedBatch({
    identity,
    parentTask,
    batch,
    ...(envPath === undefined ? {} : { envPath }),
  })
  if (!checked.ok) {
    /**
     * A verifier service this deployment cannot read is not a changed batch:
     * it is a deployment that cannot judge the batch at all, so the approval is
     */
    if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error
    return await staleProposal(
      self,
      storeId,
      proposal,
      `the batch no longer passes admission: ${checked.refusal.reasons.join('; ')}`,
    )
  }
  const { manifests, providers } = checked
  /**
   * The limits are recomputed from *this* process's configuration and compared
   * with the fingerprint the approval bound: the stored batch carries the
   */
  const contextDigest = admissionContextDigest(self.admissionContext())
  if (contextDigest !== proposal.admissionContextDigest) {
    return await staleProposal(
      self,
      storeId,
      proposal,
      `the limits in force moved since the batch was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`,
    )
  }
  const reviewContext = reviewContextOf({
    manifests,
    criteria: batch.children.flatMap(child => child.contract.acceptanceCriteria),
    providers: providerContentIdentities(providers.capabilities),
  })
  const reviewDigest = reviewContextDigest(reviewContext)
  if (reviewDigest !== proposal.reviewContextDigest) {
    return await staleProposal(
      self,
      storeId,
      proposal,
      `the resolution this batch was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`,
    )
  }

  /**
   * (5) The re-check passed: record it (`approved → ready`) and admit. A
   * proposal that is already `ready` wrote that same fact earlier — the
   */
  if (proposal.status === 'approved') {
    await self.context.task.changeProposalPhaseIn(
      storeId,
      {
        proposalId,
        to: 'ready',
        reason:
          'the post-approval re-check passed: the parent, the limits, the capability resolution, the judging verifiers and the batch content are the ones that were reviewed',
      },
      proposal.identity.callerSessionId,
    )
  }
  const admitted = await self.admitPrecheckedBatch({
    proposal,
    parentTask,
    parentRun,
    batch,
    manifests,
    providers,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
  })
  return {
    proposalId,
    status: 'admitted',
    batchId: admitted.batchId,
    childTaskIds: admitted.childTaskIds,
    detail: `proposal "${proposalId}" is admitted as batch ${admitted.batchId} with ${admitted.childTaskIds.length} child task(s)`,
  }
}

export async function staleProposal(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposal,
  reason: string,
): Promise<ProposalContinuation> {
  await self.context.task.changeProposalPhaseIn(
    storeId,
    { proposalId: proposal.proposalId, to: 'stale', reason },
    proposalCallerOf(proposal),
  )
  return {
    proposalId: proposal.proposalId,
    status: 'stale',
    detail: `proposal "${proposal.proposalId}" is stale: ${reason}`,
    reason,
  }
}

export async function expireProposal(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposal,
  reason: string,
): Promise<ProposalContinuation> {
  await self.context.task.decideProposalIn(
    storeId,
    {
      proposalId: proposal.proposalId,
      outcome: 'expired',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      decidedBy: 'task-runtime',
      decidedAt: now(),
      reason,
    },
    'task-runtime',
  )
  return {
    proposalId: proposal.proposalId,
    status: 'expired',
    detail: `proposal "${proposal.proposalId}" is expired: ${reason}`,
    reason,
  }
}

export async function parentRunEndedReason(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposal,
): Promise<string | undefined> {
  /**
   * Only a decomposition batch has a parent run to ask about: a root contract's
   * dispatchability is the store's one-root gate, which `approvalLatenessReason`
   */
  if (proposal.kind === 'root') return undefined
  const run = await self.context.task.runIn(storeId, proposal.identity.parentRunId)
  if (run.status !== 'running') return `the parent run "${run.runId}" is ${run.status}`
  if (run.executionPhase === undefined) return `the parent run "${run.runId}" predates coordination phases`
  if (run.executionPhase !== 'active') return `the parent run "${run.runId}" is in phase "${run.executionPhase}"`
  return undefined
}

export async function proposalForRequest(
  self: TaskRuntime,
  storeId: string,
  requestKey: string,
  proposalDigest: string,
): Promise<TaskProposal | undefined> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const stored = snapshot.proposals?.byRequestKey[requestKey]
  if (stored === undefined) return undefined
  if (stored.kind === 'root') {
    /**
     * A batch request cannot be answered by a root contract, even under the same
     * key: the two address different subjects, and treating one as the other
     */
    throw new Error(
      `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a root contract; ` +
        "a request key names one proposal, and a batch cannot take over a root intake's key",
    )
  }
  if (stored.proposalDigest !== proposalDigest) {
    throw new Error(
      `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose batch is a different one ` +
        `(digest ${stored.proposalDigest} ≠ ${proposalDigest}); a revision is new content under a new key (§6)`,
    )
  }
  return stored
}

export async function requireProposal(self: TaskRuntime, storeId: string, proposalId: string): Promise<TaskProposal> {
  const proposal = await readProposal(self, storeId, proposalId)
  if (proposal === undefined) {
    throw new Error(`task-runtime: store "${storeId}" holds no proposal "${proposalId}"`)
  }
  return proposal
}

export async function readProposal(
  self: TaskRuntime,
  storeId: string,
  proposalId: string,
): Promise<TaskProposal | undefined> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  return snapshot.proposals?.byId[proposalId]
}

export function submissionDetail(proposal: TaskProposal, existing: boolean): string {
  const head = existing
    ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})`
    : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`
  switch (proposal.status) {
    case 'ready':
      return `${head}; continue it to admit the batch (policy off admits without a review, and the record says policy-off)`
    case 'pending_review':
      return `${head}; it needs a recorded decision before its batch can run, and its batch is not admitted, not spawned and its parent is not decomposed`
    case 'approved':
      return `${head}; the approval is on record and the batch has not been admitted yet — continue it to run the post-approval re-check`
    case 'admitted':
      return `${head}; its batch is admitted already and will not be admitted again`
    default:
      return `${head}; a ${proposal.status} proposal is not dispatched, and a revision is new content under a new key`
  }
}

export async function requestProposalReview(
  self: TaskRuntime,
  request: ReviewSubject,
): Promise<{ requested: boolean; detail: string }> {
  const channel = self.softService<ProposalReviewChannel>('proposalReviewChannel')
  if (channel === undefined || typeof channel.requestReview !== 'function') {
    return {
      requested: false,
      detail:
        'no review channel is mounted (ctx.proposalReviewChannel), so nobody was asked; the proposal stays pending_review and only a ' +
        'recorded decision moves it',
    }
  }
  const registeredVerifiers = await self.registeredVerifierIds()
  const obligations =
    request.kind === 'root'
      ? /**
         * A root contract has no task yet, so no obligation can have been raised on
         * it; an empty list says "nothing is on record", which is what a reviewer
         */
        []
      : await self.context.task
          .snapshotIn(request.storeId)
          .then(snapshot =>
            snapshot.obligations.filter(obligation => obligation.sourceTaskId === request.parentTask.taskId),
          )
          .catch(() => [])
  try {
    const subject: ProposalReviewRequest =
      request.kind === 'root'
        ? {
            kind: 'root',
            storeId: request.storeId,
            trigger: request.trigger,
            proposal: request.proposal,
            rootSessionId: request.rootSessionId,
            contract: structuredClone(request.contract),
            manifests: request.manifests,
            ...(registeredVerifiers === undefined ? {} : { registeredVerifiers }),
            obligations,
          }
        : {
            storeId: request.storeId,
            trigger: request.trigger,
            proposal: request.proposal,
            parentTask: request.parentTask,
            batch: request.batch,
            manifests: request.manifests,
            ...(registeredVerifiers === undefined ? {} : { registeredVerifiers }),
            obligations,
          }
    const notice = await channel.requestReview(subject)
    return {
      requested: notice.requested,
      detail:
        notice.detail ??
        (notice.requested ? 'the review was requested' : 'the review channel did not request a review'),
    }
  } catch (error) {
    const detail = message(error)
    self.warn(
      `proposal ${request.proposal.proposalId}: the review channel failed (${detail}); the proposal stays pending_review`,
    )
    return { requested: false, detail: `the review channel failed: ${detail}` }
  }
}

export async function refusePrecheck(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
  actor: string,
  refusal: DecompositionRefusal,
): Promise<never> {
  for (const gap of refusal.gaps) {
    for (const missing of gap.missing) {
      await self.context.task.recordObligationIn(
        storeId,
        {
          obligationId: `o-${randomUUID()}`,
          goal: `capability "${missing}" required by child ${gap.childIndex} ("${gap.objective}") of "${parentTaskId}" is not granted by the registry`,
          criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
          sourceTaskId: parentTaskId,
        },
        actor,
      )
    }
  }
  throw refusal.error
}

export async function serializeParent<T>(
  self: TaskRuntime,
  storeId: string,
  parentTaskId: TaskId,
  work: () => Promise<T>,
): Promise<T> {
  return await enqueueByKey(self.parentChains, `${storeId}/${parentTaskId}`, work)
}

export async function reconcileProposals(
  self: TaskRuntime,
  storeId: string,
): Promise<ReconcileReport['unresolvedProposals']> {
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.snapshotIn(storeId)
  } catch (error) {
    self.warn(`store ${storeId}: the proposals could not be read for recovery (${message(error)})`)
    return []
  }
  const unresolved: { proposalId: string; status: TaskProposalStatus; reason: string }[] = []
  const report = async (proposal: TaskProposal, status: TaskProposalStatus, reason: string): Promise<void> => {
    self.warn(`store ${storeId}: proposal ${proposal.proposalId}: ${reason}`)
    unresolved.push({ proposalId: proposal.proposalId, status, reason })
  }
  for (const proposal of snapshot.proposals?.all ?? []) {
    if (!isOpenProposal(proposal)) continue
    const proposalId = proposal.proposalId
    try {
      if (proposal.kind === 'root') {
        await self.reconcileRootProposal(storeId, proposal, report)
        continue
      }
      if (proposal.status === 'pending_review') {
        const ended = await parentRunEndedReason(self, storeId, proposal)
        if (ended !== undefined) {
          await report(
            proposal,
            proposal.status,
            `it waits for a review it can no longer be dispatched from (${ended}); only a recorded decision moves it (§6)`,
          )
          continue
        }
        const parentTask = await self.context.task.taskIn(storeId, proposal.identity.parentTaskId)
        const identity = {
          storeId,
          parentTaskId: proposal.identity.parentTaskId,
          parentRunId: proposal.identity.parentRunId,
          callerSessionId: proposal.identity.callerSessionId,
        }
        const batch = self.storedBatchOf(proposal)
        const envPath = await self.envPathForSession(proposal.identity.callerSessionId)
        const checked = await self.checkDerivedBatch({
          identity,
          parentTask,
          batch,
          ...(envPath === undefined ? {} : { envPath }),
        })
        if (!checked.ok) {
          await report(
            proposal,
            proposal.status,
            `it waits for a review and its batch no longer passes admission (${checked.refusal.reasons.join('; ')}); the proposal stays pending_review`,
          )
          continue
        }
        await requestProposalReview(self, {
          storeId,
          trigger: 'recovered',
          proposal,
          parentTask,
          batch,
          manifests: checked.manifests,
        })
        continue
      }
      const continuation = await serializeParent(self, storeId, proposal.identity.parentTaskId, () =>
        continueProposalIn(self, storeId, proposalId, proposal.identity.callerSessionId, {}),
      )
      if (continuation.status !== 'admitted' && continuation.status !== 'activated') {
        await report(proposal, continuation.status, continuation.detail)
      }
    } catch (error) {
      const reason = message(error)
      self.warn(
        `store ${storeId}: proposal ${proposalId} could not be continued during recovery (${reason}); it stays ${proposal.status}`,
      )
      unresolved.push({ proposalId, status: proposal.status, reason })
    }
  }
  return unresolved
}
