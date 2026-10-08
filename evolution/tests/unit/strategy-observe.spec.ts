/**
 * The strategy adapter: an `EvaluationReport` becomes a measurement, one
 * decision record is written beside the report, and the record recomputes from
 * that report and the frozen policy alone. A record that does not recompute is
 * refused — the same rule the publish path re-checks.
 */

import { describe, expect, it } from 'vitest'
import { digestOf } from '../../src/shared.ts'
import { foldHistory } from '../../src/strategy/history.ts'
import { aggregateEvaluation } from '../../src/strategy/measure.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'
import {
  aggregateSideOf,
  assertStrategyDecisionRecomputes,
  candidateMeasurementOf,
  cohortDigestOf,
  mechanismOf,
  observationOf,
  poolReports,
  reportedTokensOf,
  scaleOf,
  sideMeasurementOf,
  strategyDecisionOf,
} from '../../src/strategy/observe.ts'
import type { StrategyDecisionRecord } from '../../src/strategy/observe.ts'
import { sampleReport, samplePlan, trial } from './method-fixtures.ts'
import type { EvaluationReport, TrialComparison } from '../../src/types.ts'

const POLICY = DEFAULT_STRATEGY_POLICY
const AT = '2026-10-08T00:00:00.000Z'

const HISTORY = foldHistory({ candidates: [], evaluations: [], consumption: [], refutations: [], versions: [] }, POLICY, 0)

function tokens(total: number) {
  return { status: 'reported' as const, tokens: { uncachedInputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

/** A report whose candidate fixes every sample and whose baseline fails every sample. */
function improvingReport(input: { baselineTokens?: number; candidateTokens?: number } = {}): EvaluationReport {
  const plan = samplePlan()
  const trials: TrialComparison[] = plan.samples.map(sample => ({
    sampleTaskId: sample.taskId,
    role: sample.role,
    baseline: trial({ sampleTaskId: sample.taskId, side: 'baseline', role: sample.role, outcome: 'failed', cost: tokens(input.baselineTokens ?? 1000), verdicts: ['fail', 'fail'] }),
    candidate: trial({ sampleTaskId: sample.taskId, side: 'candidate', role: sample.role, outcome: 'verified', cost: tokens(input.candidateTokens ?? 1000), verdicts: ['pass', 'pass'] }),
    verdict: 'fixed',
  }))
  return sampleReport({ plan, trials })
}

describe('the scale and the observation', () => {
  it('reads the original acceptance first and never lets a numeric outvote it', () => {
    const scale = { kind: 'fixed-numeric-scale' as const, metricId: 'c1', atLeast: 0, atMost: 1, direction: 'higher-is-better' as const }
    const failed = trial({ sampleTaskId: 'case-a', side: 'candidate', outcome: 'failed', verdicts: ['pass', 'pass'] })
    expect(observationOf(failed, scale).observation.quality).toBe(0)
    const inconclusive = trial({ sampleTaskId: 'case-a', side: 'candidate', outcome: 'interrupted', verdicts: ['pass'] })
    expect(observationOf(inconclusive, scale)).toMatchObject({ inconclusive: true })
    expect(observationOf(inconclusive, scale).observation.quality).toBe(0)
  })

  it('reads the acceptance success rate when the report declares no metric', () => {
    expect(scaleOf(sampleReport())).toEqual({ kind: 'acceptance-success-rate' })
    const numericPlan = samplePlan({
      rules: { quality: { metricId: 'c1', direction: 'higher-is-better', extractor: 'command' }, guards: [] },
    })
    expect(scaleOf(sampleReport({ plan: numericPlan }))).toMatchObject({ kind: 'fixed-numeric-scale', metricId: 'c1' })
  })

  it('reports the four token buckets as a total, and says unknown rather than zero', () => {
    expect(reportedTokensOf({ status: 'unknown', reason: 'no whole reading' })).toBeUndefined()
    expect(reportedTokensOf(tokens(1234))).toBe(1234)
  })
})

describe('one side’s measurement', () => {
  it('counts an inconclusive side as missing without shrinking the denominator', () => {
    const report = sampleReport({
      trials: [
        {
          sampleTaskId: 'case-a',
          role: 'observed-failure',
          baseline: trial({ sampleTaskId: 'case-a', side: 'baseline', outcome: 'failed', verdicts: ['fail', 'fail'] }),
          candidate: trial({ sampleTaskId: 'case-a', side: 'candidate', outcome: 'interrupted' }),
          verdict: 'inconclusive',
        },
      ],
    })
    const measurement = sideMeasurementOf({ report, side: 'candidate', scale: scaleOf(report), policy: POLICY })
    expect(measurement.trials).toBe(1)
    expect(measurement.missing).toBe(1)
    const aggregate = aggregateEvaluation(measurement)
    expect(aggregate.expected).toBe(1)
    expect(aggregate.missing).toBe(1)
    expect(aggregate.quality).toBe(0)
    expect(aggregate.incomplete).toBe(true)
  })

  it('keeps the cohort digest stable across rebuilds and moves it when the input moves', () => {
    const report = improvingReport()
    expect(cohortDigestOf(report)).toBe(cohortDigestOf(improvingReport()))
    const moved = sampleReport({ plan: { ...report.plan, input: { ...report.plan.input, digest: digestOf({ other: 1 }) } } })
    expect(cohortDigestOf(moved)).not.toBe(cohortDigestOf(report))
  })

  it('pools repetitions instead of keeping the newest one', () => {
    const report = improvingReport()
    const pooled = poolReports([report, report, report], 'candidate', POLICY)
    expect(pooled.trials).toBe(3)
    expect(aggregateEvaluation(pooled).expected).toBe(report.plan.samples.length * 3)
  })

  it('names the mechanism of the asset the report evaluates', () => {
    expect(mechanismOf('skill')).toBe('skill')
    expect(mechanismOf('capability')).toBe('capability')
    expect(mechanismOf('task-template')).toBe('task-template')
  })

  it('reads the candidate side of a report as an aggregate above the baseline', () => {
    const report = improvingReport()
    expect(aggregateSideOf(report, 'baseline', scaleOf(report)).quality).toBe(0)
    expect(aggregateSideOf(report, 'candidate', scaleOf(report)).quality).toBe(1)
  })
})

describe('the decision record', () => {
  it('admits a candidate that fixes every sample at the same cost', () => {
    const report = improvingReport()
    const incumbent = aggregateSideOf(report, 'baseline', scaleOf(report))
    const record = strategyDecisionOf({
      report,
      policy: POLICY,
      incumbent,
      bestQuality: 0,
      calibration: { qualityBand: 0.02, relativeCostBand: 0.01, method: 'repeated-baseline-evaluations', evaluations: 3, standardError: 0.01, degenerate: false },
      history: HISTORY,
      guards: [],
      at: AT,
    })
    expect(record).toMatchObject({ formatVersion: 1, kind: 'strategy_decision', policyDigest: digestOf(POLICY), scope: cohortDigestOf(report) })
    expect(record.admissions).toHaveLength(1)
    expect(record.admissions[0]!.admissible).toBe(true)
    expect(record.winner).toEqual({ candidateId: report.draftId, contentDigest: report.plan.sides.candidate.revision.digest })
  })

  it('refuses a candidate below the historical floor', () => {
    const plan = samplePlan()
    const report = sampleReport({
      plan,
      trials: plan.samples.map((sample, index) => ({
        sampleTaskId: sample.taskId,
        role: sample.role,
        baseline: trial({ sampleTaskId: sample.taskId, side: 'baseline', role: sample.role, outcome: 'failed', verdicts: ['fail', 'fail'] }),
        candidate: trial({
          sampleTaskId: sample.taskId,
          side: 'candidate',
          role: sample.role,
          outcome: index === 0 ? 'verified' : 'failed',
          verdicts: index === 0 ? ['pass', 'pass'] : ['fail', 'fail'],
        }),
        verdict: (index === 0 ? 'fixed' : 'not-fixed') as 'fixed' | 'not-fixed',
      })),
    })
    const incumbent = aggregateSideOf(report, 'baseline', scaleOf(report))
    const record = strategyDecisionOf({
      report,
      policy: POLICY,
      incumbent,
      bestQuality: 1,
      calibration: { qualityBand: 0.02, relativeCostBand: 0.01, method: 'repeated-baseline-evaluations', evaluations: 3, standardError: 0.01, degenerate: false },
      history: HISTORY,
      guards: [],
      at: AT,
    })
    expect(record.admissions[0]!.admissible).toBe(false)
    expect(record.winner).toBeUndefined()
  })

  it('recomputes byte for byte, and refuses a record that moved', () => {
    const report = improvingReport()
    const incumbent = aggregateSideOf(report, 'baseline', scaleOf(report))
    const calibration = { qualityBand: 0.02, relativeCostBand: 0.01, method: 'repeated-baseline-evaluations', evaluations: 3, standardError: 0.01, degenerate: false } as const
    const decision = strategyDecisionOf({ report, policy: POLICY, incumbent, bestQuality: 0, calibration, history: HISTORY, guards: [], at: AT })
    const input = { report, policy: POLICY, decision, incumbent, bestQuality: 0, calibration, history: HISTORY, guards: [] }
    expect(() => assertStrategyDecisionRecomputes(input)).not.toThrow()

    const tampered: StrategyDecisionRecord = { ...decision, bestQuality: 0.5 }
    expect(() => assertStrategyDecisionRecomputes({ ...input, decision: tampered })).toThrow(/does not recompute/)

    const otherReport = sampleReport({
      plan: { ...report.plan, input: { ...report.plan.input, digest: digestOf({ moved: 1 }) } },
      trials: report.trials,
    })
    expect(() => assertStrategyDecisionRecomputes({ ...input, report: otherReport, decision })).toThrow(/does not recompute/)
  })

  it('takes one declared edit from a report: a draft changes one asset', () => {
    const measurement = candidateMeasurementOf(improvingReport())
    expect(measurement.edits).toHaveLength(1)
    expect(measurement.edits[0]).toMatchObject({ mechanism: 'skill', targets: ['c-d0001'] })
    expect(measurement.scope).toBe(cohortDigestOf(improvingReport()))
  })
})
