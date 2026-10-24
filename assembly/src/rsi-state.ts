import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseDraft } from '../../src/release/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../../src/environment/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { searchView } from './rsi-history.ts'
import { methodEnvironment } from './method.ts'

/** A projection of Task facts, shared by admission, prompt exposure and recovery. */
export function rsiState(task: TaskState) {
  if (task.search === undefined) return undefined
  const run = task.runs[task.search.runId]!
  const remainingSlots =
    task.search.maxProposals - (task.search.batches ?? []).reduce((n, batch) => n + batch.slots.length, 0)
  const batch = task.search.batches?.find(batch => !batch.settled)
  const round = task.rounds?.find(round => round.status === 'pending')
  const executionPhase =
    run.status !== 'running'
      ? run.failureCause === 'cancelled'
        ? 'cancelled'
        : run.status === 'verified' || run.failureCause === 'acceptance'
          ? 'completed'
          : 'failed'
      : run.stage !== 'working'
        ? task.transfer?.consumed && task.transfer.outcome === undefined
          ? 'validating'
          : 'reporting'
        : batch !== undefined
          ? 'screening'
          : round !== undefined
            ? 'evaluating'
            : 'ready'
  const reportReview =
    run.status === 'verified'
      ? ('accepted' as const)
      : run.failureCause === 'acceptance'
        ? ('rejected' as const)
        : run.submission === undefined
          ? ('not-submitted' as const)
          : run.status === 'running'
            ? ('pending' as const)
            : ('unavailable' as const)
  return {
    executionPhase,
    reportReview,
    remainingSlots,
    canPropose: executionPhase === 'ready' && remainingSlots > 0,
    canSubmit: executionPhase === 'ready',
    pending: batch
      ? { kind: 'batch' as const, batchId: batch.batchId }
      : round
        ? { kind: 'evaluation' as const, roundId: round.roundId }
        : null,
    next: ['screening', 'evaluating', 'validating', 'reporting'].includes(executionPhase)
      ? 'End this turn. The host owns pending work and will resume you with its committed outcome.'
      : executionPhase === 'ready'
        ? remainingSlots > 0
          ? 'Read evidence and relevant assets; propose one mechanism, or submit an honest final report.'
          : 'Proposal budget exhausted. Submit the final report with actual outcomes and limitations.'
        : 'This search is terminal.',
  }
}

export function rsiToolReason(task: TaskState, name: string): string | undefined {
  const state = rsiState(task)
  if (state === undefined) return undefined
  if (name === 'singularity_propose_method' && !state.canPropose) return `RSI ${state.executionPhase}: ${state.next}`
  if (name === 'singularity_submit' && !state.canSubmit) return `RSI ${state.executionPhase}: ${state.next}`
  if (['write', 'edit'].includes(name) && state.executionPhase !== 'ready')
    return `RSI ${state.executionPhase}: authoring is closed. ${state.next}`
  return undefined
}

/** User-facing semantics, derived from the same committed cut as the snapshot/read. */
export function rsiSummary(apparatus: Apparatus, task: TaskState, cut = apparatus.store.load()) {
  const tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const analysis =
    task.search !== undefined
      ? task
      : [...tasks.values()].find(
          candidate =>
            candidate.search !== undefined && candidate.runs[candidate.search.runId]?.relatedTo?.taskId === task.taskId,
        )
  const run = analysis?.search === undefined ? undefined : analysis.runs[analysis.search.runId]
  const root = run?.relatedTo === undefined ? task : tasks.get(run.relatedTo.taskId)!
  if (analysis === undefined && root.rsi === undefined) return null
  const state = analysis === undefined ? undefined : rsiState(analysis)
  const search = analysis === undefined ? null : searchView(apparatus, analysis, cut)
  const transfer = analysis?.transfer
  let activeDraft: ReleaseDraft | undefined,
    draft: ReleaseDraft | undefined,
    approved = false,
    published = false
  for (const fact of cut.entries()) {
    if (fact.subject !== methodEnvironment(apparatus)) continue
    if (fact.protocol === RELEASE_PROTOCOL && fact.version === RELEASE_VERSION && fact.kind === 'release/drafted') {
      activeDraft = fact.payload as ReleaseDraft
      if (activeDraft.basis.kind === 'decision' && activeDraft.basis.roundId === transfer?.roundId) draft = activeDraft
    }
    if (
      fact.protocol === ENVIRONMENT_PROTOCOL &&
      fact.version === ENVIRONMENT_VERSION &&
      fact.kind === 'pointer/switched' &&
      activeDraft === draft &&
      draft?.basis.kind === 'decision' &&
      draft.basis.roundId === transfer?.roundId &&
      draft.revisionId === (fact.payload as { to: string }).to
    )
      published = true
    if (
      fact.protocol === RELEASE_PROTOCOL &&
      fact.version === RELEASE_VERSION &&
      fact.kind === 'release/approved' &&
      draft !== undefined &&
      (fact.payload as { draftDigest: string }).draftDigest === draft.draftDigest
    )
      approved = true
  }
  const review = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find(
    review =>
      review.target.kind === 'publication' &&
      review.target.draftDigest === draft?.draftDigest &&
      draft?.basis.kind === 'decision' &&
      draft.basis.roundId === transfer?.roundId,
  )
  const publication = published
    ? ('published' as const)
    : approved
      ? ('approved' as const)
      : review?.status === 'completed'
        ? review.findings!.every(finding => finding.verdict === 'pass')
          ? ('reviewed' as const)
          : ('rejected' as const)
        : review?.status === 'failed'
          ? ('failed' as const)
          : review !== undefined
            ? ('reviewing' as const)
            : transfer?.outcome === 'improved'
              ? ('validated' as const)
              : transfer?.outcome !== undefined
                ? ('withheld' as const)
                : transfer?.consumed
                  ? ('validating' as const)
                  : ('not-published' as const)
  return {
    executionPhase: root.rsi?.status === 'cancelled' ? 'cancelled' : (state?.executionPhase ?? root.rsi!.status),
    searchOutcome: search?.outcome ?? null,
    reportReview: state?.reportReview ?? 'not-submitted',
    publication,
    businessOutcome: root.closure?.reason ?? null,
  }
}
