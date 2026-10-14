import type { Agent } from '@deepseek-ai/dsh-agent'
import { createReleaseCommands } from '../../src/release/commands.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../../src/release/protocol.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { RevisionRef } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { loadMethod, methodEnvironment, publishedMethod } from './method.ts'
import { reviewSubject } from './review.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeTokensOf } from './budget.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { TASK_PROTOCOL } from '../../src/task/protocol.ts'
import { STRATEGY_PROTOCOL } from '../../src/strategy/protocol.ts'
import { explorationOf } from './improvement.ts'
export type MethodRelease = { readonly bootstrap: RevisionRef } | { readonly roundId: string }
export async function releaseMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  callId: string, request: MethodRelease, signal: AbortSignal): Promise<{ revision: RevisionRef; approvalId: string }> {
  const release = createReleaseCommands({ store: apparatus.store })
  const environmentId = methodEnvironment(apparatus)
  const drafted = 'bootstrap' in request
    ? await release.draft({ commandId: `${callId}:draft`, revision: request.bootstrap })
    : await release.draftFromDecision({ commandId: `${callId}:draft`, roundId: request.roundId })
  const draft = drafted.payload as import('../../src/release/protocol.ts').ReleaseDraft
  const revision = { environmentId, revisionId: draft.revisionId, digest: draft.contentDigest }
  if (publishedMethod(apparatus)?.digest === revision.digest) {
    const approved = apparatus.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)!
    return { revision, approvalId: approved.approvalId! }
  }
  const prefix = apparatus.store.load().entries().slice(0, drafted.seq)
  const trajectories: unknown[] = []
  if (draft.basis.kind === 'decision') {
    const evaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
    for (const id of [`${draft.basis.roundId}:bootstrap:evaluation`, draft.basis.evaluationId]) for (const trial of evaluations.get(id)!.observed) {
      const result = JSON.parse(trial.detail!) as { taskId: string; runId: string }
      trajectories.push({ evaluationId: id,
        exploration: JSON.parse((await explorationOf(apparatus, result.taskId, result.runId)).toString('utf8')) })
    }
  }
  const subject = { purpose: 'publication',
    requirements: draft.basis.kind === 'decision'
      ? 'Judge publication of this exact measured winner against the frozen round, independent acceptance, actual asset use and native token costs. Attribute effects to specific changed assets and recorded use, check hypotheses against independent results and distinguish transferable domain methods from stored task answers. Available but unused mechanisms are unestablished. Missing evaluation evidence, cross-trial leakage or answer memorization is not pass. Asset admission alone is insufficient. The publisher also includes this final review cost in the 25% ceiling before switching the pointer.'
      : 'Judge initial publication of these seed assets against the independently accepted root and the exact exploration trace. This initializes the asset pointer; it is not a claim of RSI improvement or a candidate evaluation.',
    draft, assets: (await loadMethod(apparatus, revision)).assets, trajectories,
    trace: { cutoff: drafted.seq, digest: digestOf(prefix),
      records: prefix.filter(fact => [TASK_PROTOCOL, MEASURE_PROTOCOL, STRATEGY_PROTOCOL, RELEASE_PROTOCOL].includes(fact.protocol)) },
    context: 'Read singularity_method_history for the sealed results referenced by this exact committed trace.' }
  const witness = await reviewSubject(apparatus, seams, agent, `${callId}:release-review`, subject, signal)
  if (draft.basis.kind === 'decision') {
    const evaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
    const candidate = projectEvaluation(evaluations.get(draft.basis.evaluationId)!)
    const baseline = projectEvaluation(evaluations.get(`${draft.basis.roundId}:bootstrap:evaluation`)!)
    let reviewCost = 0
    for (const sessionId of taskSessionsOf(apparatus, witness.taskId)) {
      const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
      try { reviewCost += nativeTokensOf((await handle.read()).events) } finally { await handle.close() }
    }
    if (baseline.cost === null || candidate.cost === null || candidate.cost + reviewCost > baseline.cost * 1.25)
      refuse('unapproved-revision', 'candidate plus final independent review exceeds the 25% native token cost ceiling')
  }
  await release.approveReview({ commandId: `${callId}:review`, environmentId, revisionId: draft.revisionId, draftDigest: draft.draftDigest, witness })
  await release.publish({ commandId: `${callId}:publish`, environmentId, expected: draft.basis.kind === 'decision' ? draft.basis.expected : '', to: draft.revisionId })
  const approved = apparatus.store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)!
  return { revision, approvalId: approved.approvalId! }
}
