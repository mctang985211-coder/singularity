/**
 * Scoring one evaluation: quality inside [0,1] with the original acceptance
 * first, a cost that stays unknown rather than zero, a denominator that never
 * shrinks for a missing trial, and no noise band from a single repetition.
 */

import { describe, expect, it } from 'vitest'
import { assertEvaluationReport, buildEvaluationReport, evaluationReportBytes, evaluationReportDigest } from '../../src/pipeline/report.ts'
import { scoreEvaluation } from '../../src/pipeline/score.ts'
import { digestOf } from '../../src/shared.ts'
import { samplePlan, sampleReport, trial } from './method-fixtures.ts'
import type { TrialComparison } from '../../src/types.ts'

function comparison(input: {
  sampleTaskId?: string
  baseline?: 'verified' | 'failed' | 'interrupted'
  candidate?: 'verified' | 'failed' | 'interrupted'
  baselineTokens?: number | null
  candidateTokens?: number | null
}): TrialComparison {
  const sampleTaskId = input.sampleTaskId ?? 'case-a'
  const cost = (total: number | null) =>
    total === null ? { status: 'unknown' as const, reason: 'no whole reading' } : { status: 'reported' as const, tokens: { uncachedInputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  return {
    sampleTaskId,
    role: 'observed-failure',
    baseline: trial({
      sampleTaskId,
      side: 'baseline',
      outcome: input.baseline ?? 'failed',
      cost: cost(input.baselineTokens === undefined ? 1000 : input.baselineTokens),
      verdicts: ['fail', 'fail'],
    }),
    candidate: trial({
      sampleTaskId,
      side: 'candidate',
      outcome: input.candidate ?? 'verified',
      cost: cost(input.candidateTokens === undefined ? 1000 : input.candidateTokens),
      verdicts: ['pass', 'pass'],
    }),
    verdict: 'fixed',
  }
}

describe('the quality reading', () => {
  it('reads the original acceptance success rate inside [0,1]', () => {
    const score = scoreEvaluation({ plan: samplePlan(), trials: [comparison({}), comparison({ sampleTaskId: 'case-b', candidate: 'failed' })] })
    expect(score.quality.baseline).toBe(0)
    expect(score.quality.candidate).toBe(0.5)
    expect(score.quality.delta).toBe(0.5)
    expect(score.quality.unit).toBe('acceptance-success-rate')
  })

  it('never shrinks the denominator when a trial is missing', () => {
    const full = scoreEvaluation({ plan: samplePlan(), trials: [comparison({}), comparison({ sampleTaskId: 'case-b' })] })
    const missing = scoreEvaluation({
      plan: samplePlan(),
      trials: [comparison({}), comparison({ sampleTaskId: 'case-b', candidate: 'interrupted' })],
    })
    expect(missing.quality.candidate).toBe(0.5)
    expect(missing.quality.candidate).toBeLessThan(full.quality.candidate)
    expect(missing.inconclusive).toBe(true)
  })

  it('reads a declared numeric metric through the frozen scale, acceptance first', () => {
    const plan = samplePlan({ rules: { quality: { metricId: 'c1', direction: 'higher-is-better', extractor: 'command' }, guards: [] } })
    const failed = comparison({ candidate: 'failed' })
    expect(scoreEvaluation({ plan, trials: [failed] }).quality.candidate).toBe(0)
    expect(scoreEvaluation({ plan, trials: [comparison({})] }).quality.candidate).toBe(1)
  })
})

describe('the cost reading', () => {
  it('reports the relative delta when both sides report every sample', () => {
    const score = scoreEvaluation({ plan: samplePlan(), trials: [comparison({ baselineTokens: 1000, candidateTokens: 800 })] })
    expect(score.cost).toEqual({ status: 'reported', baselineTokens: 1000, candidateTokens: 800, relativeDelta: -0.2 })
    expect(score.inconclusive).toBe(false)
  })

  it('stays unknown — never zero — when either side is unread', () => {
    const score = scoreEvaluation({ plan: samplePlan(), trials: [comparison({ candidateTokens: null })] })
    expect(score.cost.status).toBe('unknown')
    expect(score.inconclusive).toBe(true)
  })
})

describe('the uncertainty reading', () => {
  it('claims no noise band from a single repetition', () => {
    const score = scoreEvaluation({ plan: samplePlan(), trials: [comparison({})] })
    expect(score.uncertainty).toMatchObject({ basis: 'single-trial', repeats: 1 })
    expect(score.uncertainty.noiseBand).toBeNull()
    expect(score.uncertainty.reason).toMatch(/fewer than three/)
  })

  it('reports the band the caller measured once the scope has been repeated', () => {
    const score = scoreEvaluation({ plan: samplePlan(), trials: [comparison({})], repeats: 3, noiseBand: 0.02 })
    expect(score.uncertainty).toMatchObject({ basis: 'repeated-trials', repeats: 3, noiseBand: 0.02 })
  })
})

describe('the report', () => {
  it('carries a plan digest and a score that recompute from its own contents', () => {
    const report = sampleReport()
    expect(report.planDigest).toBe(digestOf(report.plan))
    expect(() => assertEvaluationReport(report)).not.toThrow()
  })

  it('refuses a report whose plan or score moved', () => {
    const report = sampleReport()
    expect(() => assertEvaluationReport({ ...report, planDigest: digestOf({ other: 1 }) })).toThrow(/planDigest/)
    expect(() =>
      assertEvaluationReport({
        ...report,
        score: { ...report.score, quality: { baseline: 0, candidate: 0.99, delta: 0.99, unit: 'acceptance-success-rate' } },
      }),
    ).toThrow(/does not recompute/)
    expect(() => assertEvaluationReport({ ...report, formatVersion: 4 })).toThrow(/formatVersion 4/)
  })

  it('writes bytes that carry a stable digest', () => {
    const report = sampleReport()
    expect(evaluationReportBytes(report).endsWith('\n')).toBe(true)
    expect(evaluationReportDigest(report)).toBe(evaluationReportDigest(sampleReport()))
  })

  it('builds a report from a plan, its trials and a verdict', () => {
    const plan = samplePlan()
    const trials = [comparison({})]
    const report = buildEvaluationReport({
      plan,
      evaluationId: 'e-1',
      at: '2026-10-08T00:00:00.000Z',
      trials,
      score: scoreEvaluation({ plan, trials, repeats: 1 }),
      guards: [],
      verdict: 'fixed',
    })
    expect(() => assertEvaluationReport(report)).not.toThrow()
    expect(report).toMatchObject({ formatVersion: 5, draftId: 'd0001', planId: plan.planId, verdict: 'fixed' })
  })
})
