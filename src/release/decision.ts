import type { ControlReadCut } from '../control/session-store.ts'
import { assertPinnedRevision } from '../environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../environment/protocol.ts'
import { declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../measure/view.ts'
import { digestOf } from '../protocol/envelope.ts'
import { foldSubject } from '../protocol/fold.ts'
import { ProtocolRegistry } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import { STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../strategy/protocol.ts'
import { sameRevision } from '../task/shape.ts'
import { releaseDraftOf, type ReleaseDraft } from './protocol.ts'

const FOLD = new ProtocolRegistry()
declareMeasureProtocol(FOLD)

export function decisionDraftOf(cut: ControlReadCut, roundId: string): { readonly environmentId: string; readonly draft: ReleaseDraft } {
  const round = cut.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
  if (round?.plan === undefined || round.decision === undefined)
    refuse('illegal-transition', `round "${roundId}" has no committed decision`)
  if (round.decision.winner === null) refuse('illegal-transition', `round "${roundId}" has no winner to release`)
  const winner = round.submissions.find(submission => submission.slot === round.decision!.winner)!
  const decision = cut.entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION)
    .find(fact => fact.subject === roundId && fact.kind === STRATEGY_KINDS.roundDecided)!
  const report = foldSubject<EvaluationState>(FOLD, cut.entries().filter(fact => fact.seq < decision.seq),
    MEASURE_PROTOCOL, MEASURE_VERSION, winner.evaluationId)
  if (report?.baseline === undefined || report.candidate === undefined)
    refuse('illegal-transition', `the committed winner has no evaluation report at decision #${decision.seq}`)
  if (!sameRevision(report.baseline, round.plan.incumbent) || !sameRevision(report.candidate, winner.revision))
    refuse('evidence-input-mismatch', 'the winner report does not bind the round incumbent and selected revision')
  if (caliberDigestOf(report) !== round.plan.caliber) refuse('caliber-mismatch', 'the winner report differs from the round caliber')
  const measured = projectEvaluation(report)
  if (!measured.admissible || measured.cost === null)
    refuse('illegal-transition', 'the committed winner has no complete admissible report with measured cost')
  const environments = cut.statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION)
  assertPinnedRevision(round.plan.incumbent, environments, 'release decision incumbent')
  assertPinnedRevision(winner.revision, environments, 'release decision winner')
  if (winner.revision.environmentId !== round.plan.incumbent.environmentId)
    refuse('evidence-input-mismatch', 'the winner and incumbent belong to different release environments')
  return { environmentId: winner.revision.environmentId, draft: releaseDraftOf(winner.revision, {
    kind: 'decision', roundId, decisionSeq: decision.seq, decisionDigest: decision.digest,
    evaluationId: winner.evaluationId, reportDigest: digestOf(report), expected: round.plan.productionHead ?? round.plan.incumbent.revisionId,
  }) }
}
