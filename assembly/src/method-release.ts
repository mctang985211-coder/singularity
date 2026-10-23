import { sealedBytes } from './sealed.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
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
import { digestOf } from '../../src/protocol/envelope.ts'
import { pairedReport } from '../../src/measure/paired.ts'
import { matrixOf } from '../../src/measure/suite.ts'
import { sameRevision } from '../../src/task/shape.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'
import { rsiDesignReference } from './rsi-policy.ts'
export type MethodRelease = { readonly roundId: string }
export async function releaseMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  callId: string, request: MethodRelease, signal: AbortSignal,
) {
  const owner = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .find(task => task.transfer?.roundId === request.roundId || task.rounds?.some(round => round.roundId === request.roundId))
  const active = () => {
    signal.throwIfAborted()
    if (owner !== undefined) {
      const cut = apparatus.store.load(), current = cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, owner.taskId)!
      const run = Object.values(current.runs).at(-1)
      if (run?.status !== 'running' || run.stage !== 'submitted') refuse('illegal-transition', 'publication requires its submitted RSI Run')
      if (run.relatedTo !== undefined && cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, run.relatedTo.taskId)?.rsi?.status !== 'running')
        refuse('illegal-transition', 'publication requires its running root RSI')
    }
  }
  active()
  const release = createReleaseCommands({ store: apparatus.store, require: active }),
    environmentId = methodEnvironment(apparatus)
  const transfer = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .find(task => task.transfer?.roundId === request.roundId)?.transfer
  if (apparatus.domain.suite === undefined || !transfer?.consumed || transfer.outcome !== 'improved')
    refuse('unapproved-revision', 'publication requires a suite and frozen independent paired validation')
  const drafted = await release.draftFromDecision({ commandId: `${callId}:draft`, roundId: request.roundId })
  const draft = drafted.payload as import('../../src/release/protocol.ts').ReleaseDraft
  const revision = { environmentId, revisionId: draft.revisionId, digest: draft.contentDigest }
  if (draft.basis.kind !== 'decision') refuse('illegal-transition', 'method publication requires a measured decision')
  const evaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
  const baseline = evaluations.get(`${request.roundId}:bootstrap:evaluation`), candidate = evaluations.get(draft.basis.evaluationId)
  const expected = matrixOf(apparatus.domain.suite, 'validation', transfer.executionProfileDigest)
  if (transfer.suiteDigest !== expected.suiteDigest || !sameRevision(transfer.champion, revision) ||
      baseline?.candidate === undefined || candidate?.baseline === undefined || candidate.candidate === undefined ||
      !sameRevision(baseline.candidate, transfer.baseline) || !sameRevision(candidate.baseline, transfer.baseline) ||
      !sameRevision(candidate.candidate, transfer.champion) || digestOf(baseline.matrix ?? null) !== digestOf(expected) ||
      digestOf(candidate.matrix ?? null) !== digestOf(expected) || pairedReport(baseline, candidate).status !== 'improved')
      refuse('unapproved-revision', 'publication evidence must pair the frozen baseline and champion on the exact independent validation matrix')
  if (publishedMethod(apparatus)?.digest === revision.digest) {
    const approved = apparatus.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)!
    return { revision, approvalId: approved.approvalId! }
  }
  const assets = (await loadMethod(apparatus, revision)).assets
  const incumbent = publishedMethod(apparatus)!
  const evidence = [
    baseline!, candidate!,
  ].map((e) => ({
    evaluationId: e.evaluationId,
    report: projectEvaluation(e),
    failures: e.failed ?? [], missing: e.missed, matrix: e.matrix ?? null,
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
      transfer: { ...transfer, report: JSON.parse((await sealedBytes(apparatus, transfer.report!)).toString('utf8')) },
      requirements:
        'Judge protected acceptance, independent evaluation, actually consumed assets and measured root-through-acceptance costs. All RSI usage stays outside comparison. Reusing one template or passing one task does not establish transfer. A prewritten task algorithm without a conditional general mechanism is task specialization even if the baseline already contained it. Separate observed cost changes, reviewer sampling and tested transfer. Do not claim domain generalization without unseen-task evidence. Frozen Task and session references support detailed evidence reads.',
    },
    signal, undefined, false,
  )
  active()
  if (witness.verdict !== 'pass') return { revision, approvalId: null }
  await release.approveReview({
    commandId: `${callId}:approve`, environmentId, revisionId: draft.revisionId, draftDigest: draft.draftDigest, witness,
  })
  active()
  await release.publish({ commandId: `${callId}:publish`, environmentId, expected: draft.basis.expected,
    to: draft.revisionId,
  })
  return { revision, approvalId: witness.reviewId }
}
