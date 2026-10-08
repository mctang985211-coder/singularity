/**
 * Scoring one evaluation: quality, cost and uncertainty. The quality and cost
 * rules themselves live in the strategy's pure functions (`qualityOf`,
 * `aggregateEvaluation`); this module only assembles their answers into the one
 * `EvaluationScore` a report carries. A missing fact is never filled in — an
 * unknown cost stays unknown and a missing trial never shrinks the denominator.
 */

import type { EvaluationPlan, EvaluationScore, TrialComparison } from '../types.ts'
import type { QualitySample } from '../strategy/scale.ts'
import { qualityOf } from '../strategy/scale.ts'
import type { QualityScale } from '../strategy/scale.ts'

/** The frozen scale one plan's rules name. */
export function scaleOfPlan(plan: EvaluationPlan): QualityScale {
  const quality = plan.rules.quality
  if (quality.metricId === 'acceptance') return { kind: 'acceptance-success-rate' }
  return { kind: 'fixed-numeric-scale', metricId: quality.metricId, atLeast: 0, atMost: 1, direction: 'higher-is-better' }
}

function outcomeAcceptance(trial: TrialComparison['baseline']): QualitySample['acceptance'] {
  if (trial.outcome === 'verified') return 'pass'
  if (trial.outcome === 'failed' || trial.outcome === 'not-admitted') return 'fail'
  return 'inconclusive'
}

function totalTokens(trial: TrialComparison['baseline']): number | undefined {
  const cost = trial.receipt.cost
  if (cost.status !== 'reported') return undefined
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = cost.tokens
  return uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
}

function numericOf(trial: TrialComparison['baseline'], scale: QualityScale): number | undefined {
  if (scale.kind !== 'fixed-numeric-scale') return undefined
  const judged = trial.receipt.criteria.filter(criterion => criterion.criterionId === scale.metricId)
  if (judged.length === 0) return undefined
  return judged.filter(criterion => criterion.verdict === 'pass').length / judged.length
}

/** One side's mean quality over every frozen sample: an inconclusive trial scores 0 and keeps its place. */
function meanQuality(trials: readonly TrialComparison[], side: 'baseline' | 'candidate', scale: QualityScale): number {
  if (trials.length === 0) return 0
  let total = 0
  for (const comparison of trials) {
    const trial = comparison[side]
    const numeric = numericOf(trial, scale)
    total += qualityOf(scale, { acceptance: outcomeAcceptance(trial), ...(numeric === undefined ? {} : { numeric }) })
  }
  return total / trials.length
}

/**
 * Score one evaluation. `repeats` is how many independent repetitions of this
 * frozen scope the caller is pooling: a single repetition never yields a noise
 * band, and a band is only reported when the caller measured one.
 */
export function scoreEvaluation(input: {
  plan: EvaluationPlan
  trials: readonly TrialComparison[]
  repeats?: number
  noiseBand?: number | null
}): EvaluationScore {
  const scale = scaleOfPlan(input.plan)
  const baseline = meanQuality(input.trials, 'baseline', scale)
  const candidate = meanQuality(input.trials, 'candidate', scale)
  const unit = scale.kind === 'acceptance-success-rate' ? 'acceptance-success-rate' : scale.metricId

  const baselineTokens: number[] = []
  const candidateTokens: number[] = []
  for (const comparison of input.trials) {
    const left = totalTokens(comparison.baseline)
    const right = totalTokens(comparison.candidate)
    if (left === undefined || right === undefined) {
      baselineTokens.length = 0
      candidateTokens.length = 0
      break
    }
    baselineTokens.push(left)
    candidateTokens.push(right)
  }
  const cost: EvaluationScore['cost'] =
    baselineTokens.length === 0 || candidateTokens.length === 0
      ? {
          status: 'unknown',
          reason:
            'at least one side of one sample reports no whole token reading, so the relative cost is unknown; a missing reading is never ' +
            'counted as zero',
        }
      : (() => {
          const left = baselineTokens.reduce((sum, value) => sum + value, 0)
          const right = candidateTokens.reduce((sum, value) => sum + value, 0)
          return {
            status: 'reported' as const,
            baselineTokens: left,
            candidateTokens: right,
            relativeDelta: left === 0 ? (right === 0 ? 0 : Number.POSITIVE_INFINITY) : (right - left) / left,
          }
        })()

  const repeats = input.repeats ?? 1
  const noisy = repeats >= 3
  const inconclusive =
    cost.status === 'unknown' ||
    input.trials.length === 0 ||
    input.trials.some(comparison => comparison.baseline.outcome === 'interrupted' || comparison.candidate.outcome === 'interrupted')

  return {
    quality: { baseline, candidate, delta: candidate - baseline, unit },
    cost,
    uncertainty: {
      basis: noisy ? 'repeated-trials' : 'single-trial',
      repeats,
      noiseBand: input.noiseBand ?? null,
      ...(noisy
        ? {}
        : { reason: 'fewer than three independent repetitions of the frozen scope; no noise band is claimed from one trial' }),
    },
    inconclusive,
  }
}

/** Whether every sample of one comparison settled to a terminal side on both ends. */
export function fullySettled(trials: readonly TrialComparison[]): boolean {
  return trials.every(
    comparison =>
      comparison.baseline.outcome !== 'interrupted' &&
      comparison.candidate.outcome !== 'interrupted' &&
      comparison.baseline.outcome !== 'cancelled' &&
      comparison.candidate.outcome !== 'cancelled',
  )
}
