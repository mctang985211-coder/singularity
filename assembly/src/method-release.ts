import type { Agent } from '@deepseek-ai/dsh-agent'
import { createReleaseCommands } from '../../src/release/commands.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../../src/release/protocol.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { Apparatus } from './apparatus.ts'
import { loadMethod, methodEnvironment, publishedMethod } from './method.ts'
import { reviewSubject } from './review.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'
import { rsiCriticRequirements, rsiDesignReference } from './rsi-policy.ts'
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
      designReference: rsiDesignReference,
      draft,
      assets,
      changes: structuralEditDetailsOf((await loadMethod(apparatus, incumbent)).assets, assets),
      evidence,
      requirements:
        rsiCriticRequirements + '\nJudge protected acceptance, independent evaluation, actually consumed assets and measured root-through-acceptance costs. All RSI usage stays outside comparison. Reusing one template or passing one task does not establish transfer. A prewritten task algorithm without a conditional general mechanism is task specialization even if the baseline already contained it. Separate observed cost changes, reviewer sampling and tested transfer. Do not claim domain generalization without unseen-task evidence. Frozen Task and session references support detailed evidence reads.',
    },
    signal,
  )
  await release.approveReview({
    commandId: `${callId}:approve`, environmentId, revisionId: draft.revisionId, draftDigest: draft.draftDigest, witness,
  })
  await release.publish({ commandId: `${callId}:publish`, environmentId, expected: draft.basis.expected,
    to: draft.revisionId,
  })
  return { revision, approvalId: witness.reviewId }
}
