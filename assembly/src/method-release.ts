import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createReleaseCommands } from '../../src/release/commands.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../../src/release/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { Apparatus } from './apparatus.ts'
import { loadMethod, methodEnvironment, publishedMethod } from './method.ts'
import { reviewSubject } from './review.ts'
import { nativeTokensOf } from './budget.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'
export type MethodRelease = { readonly roundId: string }
export async function releaseMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  callId: string, request: MethodRelease, signal: AbortSignal,
) {
  const release = createReleaseCommands({ store: apparatus.store }),
    environmentId = methodEnvironment(apparatus)
  const drafted = await release.draftFromDecision({ commandId: `${callId}:draft`, roundId: request.roundId })
  const draft = drafted.payload as import('../../src/release/protocol.ts').ReleaseDraft
  const revision = { environmentId, revisionId: draft.revisionId, digest: draft.contentDigest }
  if (publishedMethod(apparatus)?.digest === revision.digest) {
    const approved = apparatus.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)!
    return { revision, approvalId: approved.approvalId! }
  }
  if (draft.basis.kind !== 'decision') refuse('illegal-transition', 'method publication requires a measured decision')
  const evaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
    const candidate = projectEvaluation(evaluations.get(draft.basis.evaluationId)!),
    baseline = projectEvaluation(evaluations.get(`${request.roundId}:bootstrap:evaluation`)!)
  const assets = (await loadMethod(apparatus, revision)).assets
  const incumbent = publishedMethod(apparatus)!
  const evidence = [
    evaluations.get(`${request.roundId}:bootstrap:evaluation`)!,
    evaluations.get(draft.basis.evaluationId)!,
  ].map((e) => ({
    evaluationId: e.evaluationId,
    report: projectEvaluation(e),
    trials: e.observed.map((t) => ({ slot: t.slot, detail: t.detail, artifactDigest: t.artifactDigest })),
  }))
  const witness = await reviewSubject(
    apparatus,
    seams,
    agent,
    `${callId}:review`,
    {
      purpose: 'publication',
      draft,
      assets,
      changes: structuralEditDetailsOf((await loadMethod(apparatus, incumbent)).assets, assets),
      evidence,
      requirements:
        'Judge reusable method changes, protected acceptance, independent evaluation, actual consumed assets and complete native costs. Reject answer memorization or cross-trial solution transfer. Frozen Task and session references support detailed evidence reads.',
    },
    signal,
  )
  const review = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, witness.reviewId)!
  const sessions = new Set([
    review.sessionId,
    ...review.children.flatMap((c) => [...taskSessionsOf(apparatus, c.taskId)]),
  ])
  let reviewCost = 0
  for (const sessionId of sessions) {
      const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
      try { reviewCost += nativeTokensOf((await handle.read()).events) } finally { await handle.close() }
    }
    if (baseline.cost === null || candidate.cost === null || candidate.cost + reviewCost > baseline.cost * 1.25)
      refuse('unapproved-revision', 'candidate plus publication review exceeds the 25% native cost ceiling')
  await release.approveReview({
    commandId: `${callId}:approve`, environmentId, revisionId: draft.revisionId, draftDigest: draft.draftDigest, witness,
  })
  await release.publish({ commandId: `${callId}:publish`, environmentId, expected: draft.basis.expected,
    to: draft.revisionId,
  })
  return { revision, approvalId: witness.reviewId }
}
