import type { Agent } from '@deepseek-ai/dsh-agent'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { createReleaseCommands } from '../../src/release/commands.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseDraft } from '../../src/release/protocol.ts'
import type { ApprovalSeams } from '../../src/runtime/approval.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import type { RevisionRef } from '../../src/task/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Apparatus } from './apparatus.ts'
import { loadMethod, methodEnvironment } from './method.ts'
import { structuralEditsOf } from './evolution.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { foldSubject } from '../../src/protocol/fold.ts'

export type MethodRelease = { readonly bootstrap: RevisionRef } | { readonly roundId: string }

export async function releaseMethod(apparatus: Apparatus, seams: ApprovalSeams, agent: Agent,
  callId: string, request: MethodRelease, signal: AbortSignal): Promise<{ revision: RevisionRef; approvalId: string }> {
  const release = createReleaseCommands({ store: apparatus.store, approvalSeams: seams })
  const environmentId = methodEnvironment(apparatus)
  const library = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, environmentId)
  let expected: string
  let review: unknown
  if ('bootstrap' in request) {
    if (library?.pointer !== undefined) refuse('illegal-transition', 'bootstrap is only available for an unpublished Method library')
    const method = await loadMethod(apparatus, request.bootstrap)
    await release.draft({ commandId: `${callId}:draft`, revision: request.bootstrap })
    expected = ''
    review = { purpose: 'Bootstrap Method library', revision: request.bootstrap, assets: method.assets }
  } else {
    const draft = await release.draftFromDecision({ commandId: `${callId}:draft`, roundId: request.roundId })
    const content = draft.payload as ReleaseDraft
    if (content.basis.kind !== 'decision') throw new Error('a winner draft must bind its decision')
    const basis = content.basis
    expected = basis.expected
    const cut = apparatus.store.load()
    const round = cut.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, request.roundId)!
    const candidate = { environmentId, revisionId: content.revisionId, digest: content.contentDigest }
    const before = (await loadMethod(apparatus, round.plan!.incumbent)).assets
    const after = (await loadMethod(apparatus, candidate)).assets
    const report = foldSubject<EvaluationState>(apparatus.registry, cut.entries().filter(fact => fact.seq < basis.decisionSeq),
      MEASURE_PROTOCOL, MEASURE_VERSION, basis.evaluationId)!
    review = { purpose: 'Publish selected Method', revision: candidate, basis: content.basis,
      edits: structuralEditsOf(before, after), before, after,
      report: projectEvaluation(report), calibration: round.decision!.calibration,
      costUnit: 'native model tokens', metric: round.plan!.caliber,
      experiment: apparatus.domain.measurement === undefined ? 'functional engineering comparison' : 'domain method comparison',
      ...(apparatus.domain.measurement === undefined ? {} : { qualityUnit: 'baseline area ratio', baselineArea: apparatus.domain.measurement.baseline }) }
  }
  const draft = apparatus.store.load().stateOf<ReleaseDraft>(RELEASE_PROTOCOL, RELEASE_VERSION, environmentId)!
  const approval = await release.approve({ commandId: `${callId}:approve`, environmentId, revisionId: draft.revisionId,
    draftDigest: draft.draftDigest, approvedBy: `web-user:${agent.session.id}`,
    ask: { agent, toolName: 'singularity_release_method', callId, reason: JSON.stringify(review, null, 2), signal } })
  await release.publish({ commandId: `${callId}:publish`, environmentId, expected, to: draft.revisionId })
  return { revision: { environmentId, revisionId: draft.revisionId, digest: draft.contentDigest },
    approvalId: (approval.payload as { approvalId: string }).approvalId }
}
