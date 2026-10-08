// RRSI strategy port — derived from google-research/rrsi @ be50316 (Apache-2.0),
// rrsi/{schedule,history,evaluate,calibrate,selection}.py. Divergences are marked
// "plan §4 override" at each site and pinned by correction tests.

/**
 * The one adapter between real products and the strategy's inputs: an
 * `EvaluationReport` becomes a measurement, and one decision record is written
 * beside the report so it recomputes from the report alone.
 */

import type { CostReading, EvaluationReport, TrialResult } from '../types.ts'
import { digestOf } from '../shared.ts'
import type { AggregateScore, EvaluationMeasurement, NoiseCalibration, TaskMeasurement, TrialObservation } from './measure.ts'
import { aggregateEvaluation, poolEvaluations } from './measure.ts'
import type { QualityScale } from './scale.ts'
import { qualityOf } from './scale.ts'
import type { Admission, CandidateMeasurement } from './selection.ts'
import { admit } from './selection.ts'
import type { DeclaredEdit, ScreenRefusalCode } from './screen.ts'
import type { HistoryView } from './history.ts'
import type { MechanismKind, StrategyPolicy } from './policy.ts'
import { DEFAULT_STRATEGY_POLICY, strategyPolicyDigest } from './policy.ts'

/** The four token buckets of one side's execution subtree, or `undefined` when the side does not report them. */
export function reportedTokensOf(cost: CostReading): number | undefined {
  if (cost.status !== 'reported') return undefined
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = cost.tokens
  return uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
}

/** The mechanism one asset kind's candidate declares. */
export function mechanismOf(kind: EvaluationReport['kind']): MechanismKind {
  if (kind === 'skill') return 'skill'
  if (kind === 'capability') return 'capability'
  return 'task-template'
}

/** The quality scale one report's rules freeze: the original acceptance, or the declared numeric metric. */
export function scaleOf(report: EvaluationReport): QualityScale {
  const quality = report.plan.rules.quality
  if (quality.metricId === 'acceptance') return { kind: 'acceptance-success-rate' }
  return { kind: 'fixed-numeric-scale', metricId: quality.metricId, atLeast: 0, atMost: 1, direction: 'higher-is-better' }
}

/** The numeric a `fixed-numeric-scale` reads out of one side's own criteria verdicts, when the scale asks for one. */
function numericMeasurementOf(trial: TrialResult, scale: QualityScale): number | undefined {
  if (scale.kind !== 'fixed-numeric-scale') return undefined
  const judged = trial.receipt.criteria.filter(criterion => criterion.criterionId === scale.metricId)
  if (judged.length === 0) return undefined
  return judged.filter(criterion => criterion.verdict === 'pass').length / judged.length
}

/** One trial's raw observation: the original acceptance decides first, the numeric scale second. */
export function observationOf(trial: TrialResult, scale: QualityScale): { observation: TrialObservation; inconclusive: boolean } {
  const acceptance: 'pass' | 'fail' | 'inconclusive' =
    trial.outcome === 'verified' ? 'pass' : trial.outcome === 'failed' || trial.outcome === 'not-admitted' ? 'fail' : 'inconclusive'
  const numeric = numericMeasurementOf(trial, scale)
  const quality = qualityOf(scale, { acceptance, ...(numeric === undefined ? {} : { numeric }) })
  const tokens = reportedTokensOf(trial.receipt.cost)
  return {
    observation: { quality, weight: 1, ...(tokens === undefined ? {} : { tokens }) },
    inconclusive: acceptance === 'inconclusive',
  }
}

/** The frozen scope identity of one report: everything that must agree before two evaluations may pool. */
export function cohortDigestOf(report: EvaluationReport): string {
  const plan = report.plan
  return digestOf({
    libraryId: plan.libraryId,
    kind: plan.kind,
    input: plan.input,
    rules: plan.rules,
    overlay: plan.overlay,
    baseline: {
      revision: plan.sides.baseline.revision,
      model: plan.sides.baseline.model,
      capabilities: plan.sides.baseline.capabilities,
      acceptance: plan.sides.baseline.acceptance,
    },
    samples: plan.samples.map(sample => ({ taskId: sample.taskId, role: sample.role, contractDigest: sample.contractDigest })),
    strategy: plan.strategy?.policyDigest ?? null,
  })
}

/**
 * The measurement one side of one report yields under a frozen scale. `policy`
 * travels with the measurement because the scale's scope is the policy's scope;
 * nothing else in the measurement depends on it.
 */
export function sideMeasurementOf(input: {
  report: EvaluationReport
  side: 'baseline' | 'candidate'
  scale: QualityScale
  policy: StrategyPolicy
}): EvaluationMeasurement {
  const { report, side, scale } = input
  const tasks: TaskMeasurement[] = []
  let missing = 0
  for (const comparison of report.trials) {
    const { observation, inconclusive } = observationOf(comparison[side], scale)
    if (inconclusive) missing += 1
    tasks.push({ taskId: comparison.sampleTaskId, trials: [observation] })
  }
  return { scope: cohortDigestOf(report), trials: 1, tasks, missing }
}

/** One side's aggregate reading of one report. */
export function aggregateSideOf(report: EvaluationReport, side: 'baseline' | 'candidate', scale: QualityScale): AggregateScore {
  return aggregateEvaluation(
    sideMeasurementOf({ report, side, scale, policy: DEFAULT_STRATEGY_POLICY }),
  )
}

/** Pool every measured report of one candidate under one scope, in the order the caller names them. */
export function poolReports(
  reports: readonly EvaluationReport[],
  side: 'baseline' | 'candidate',
  policy: StrategyPolicy,
): EvaluationMeasurement {
  return poolEvaluations(reports.map(report => sideMeasurementOf({ report, side, scale: scaleOf(report), policy })))
}

/** One candidate measurement taken from a report: a draft changes one asset, so one declared edit. */
export function candidateMeasurementOf(report: EvaluationReport): CandidateMeasurement {
  const declared: DeclaredEdit = {
    id: report.draftId,
    mechanism: mechanismOf(report.kind),
    hypothesis: `${report.kind} candidate "${report.plan.draftId}"`,
    targets: [report.plan.sides.candidate.revision.revisionId],
  }
  return {
    candidateId: report.draftId,
    contentDigest: report.plan.sides.candidate.revision.digest,
    scope: cohortDigestOf(report),
    edits: [declared],
    aggregate: aggregateSideOf(report, 'candidate', scaleOf(report)),
  }
}

/** One settled strategy decision, written beside the report it was taken from. */
export interface StrategyDecisionRecord {
  formatVersion: 1
  kind: 'strategy_decision'
  libraryId: string
  /** The frozen scope identity: any change to it makes a different comparison. */
  scope: string
  cohortDigest: string
  policyDigest: string
  round: number
  calibration: NoiseCalibration
  incumbent: AggregateScore
  bestQuality: number
  admissions: readonly Admission[]
  winner?: { readonly candidateId: string; readonly contentDigest: string }
  reservedDrafts: number
  steering: HistoryView['steering']
  refusedBeforeMeasurement: readonly { readonly candidateId: string; readonly reasonCode: ScreenRefusalCode; readonly reason: string }[]
  at: string
}

/** Build the one decision record for a report. Pure: the same inputs recompute the same record. */
export function strategyDecisionOf(input: {
  report: EvaluationReport
  policy: StrategyPolicy
  incumbent: AggregateScore
  bestQuality: number
  calibration: NoiseCalibration
  history: HistoryView
  guards: readonly string[]
  at: string
  /** The candidates this round screened out before any measurement; they never enter the measured history. */
  refusedBeforeMeasurement?: readonly { readonly candidateId: string; readonly reasonCode: ScreenRefusalCode; readonly reason: string }[]
}): StrategyDecisionRecord {
  const { report, policy, incumbent, bestQuality, calibration, history, guards } = input
  const candidate = candidateMeasurementOf(report)
  const admission = admit({
    candidate,
    incumbent,
    // The incumbent this round compares against is the same frozen scope the
    // candidate was measured under (the report's own baseline reading).
    incumbentScope: candidate.scope,
    bestQuality,
    calibration,
    guards,
    policy,
  })
  return {
    formatVersion: 1,
    kind: 'strategy_decision',
    libraryId: report.libraryId,
    scope: candidate.scope,
    cohortDigest: cohortDigestOf(report),
    policyDigest: strategyPolicyDigest(policy),
    round: history.entries.length,
    calibration,
    incumbent,
    bestQuality,
    admissions: [admission],
    ...(admission.admissible ? { winner: { candidateId: candidate.candidateId, contentDigest: candidate.contentDigest } } : {}),
    reservedDrafts: 0,
    steering: history.steering,
    refusedBeforeMeasurement: [...(input.refusedBeforeMeasurement ?? [])],
    at: input.at,
  }
}

/** Recompute a landed decision and compare it byte for byte; a mismatch is a tampered or stale record. */
export function assertStrategyDecisionRecomputes(input: {
  report: EvaluationReport
  policy: StrategyPolicy
  decision: StrategyDecisionRecord
  incumbent: AggregateScore
  bestQuality: number
  calibration: NoiseCalibration
  history: HistoryView
  guards: readonly string[]
  refusedBeforeMeasurement?: readonly { readonly candidateId: string; readonly reasonCode: ScreenRefusalCode; readonly reason: string }[]
}): void {
  const recomputed = strategyDecisionOf({ ...input, at: input.decision.at })
  if (digestOf(recomputed) !== digestOf(input.decision)) {
    throw new Error(
      `evolution: the strategy decision of report "${input.report.evaluationId}" does not recompute from that report and the frozen ` +
        `policy (recorded ${digestOf(input.decision)}, recomputed ${digestOf(recomputed)}) — a decision that cannot be recomputed is not evidence`,
    )
  }
}
