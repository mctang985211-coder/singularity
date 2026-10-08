/** Ŝ/Ĉ aggregation, repeat pooling, and noise calibration (missing trials never shrink the denominator). */
import { describe, expect, it } from 'vitest'
import { aggregateEvaluation, bootstrapStdError, calibrateNoise, poolEvaluations } from '../../src/strategy/measure.ts'
import type { EvaluationMeasurement, TaskMeasurement } from '../../src/strategy/measure.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'

function measurement(tasks: readonly TaskMeasurement[], trials: number, missing = 0, scope = 's'): EvaluationMeasurement {
  return { scope, trials, tasks, missing }
}

describe('aggregateEvaluation', () => {
  it('computes the criteria-weighted success rate (rrsi/test_core.py:69 vector)', () => {
    const score = aggregateEvaluation(measurement([
      { taskId: 'a', trials: [{ quality: 0.5, weight: 10, tokens: 100 }, { quality: 1, weight: 10, tokens: 100 }] },
      { taskId: 'b', trials: [{ quality: 0, weight: 90, tokens: 100 }, { quality: 0, weight: 90, tokens: 100 }] },
    ], 2))
    expect(score.quality).toBeCloseTo(0.075, 9)
    expect(score.expected).toBe(4)
    expect(score.missing).toBe(0)
    expect(score.cost).toBe(100)
    expect(score.incomplete).toBe(false)
  })

  // Correction test (plan §4「缺失试验不得缩小分母」): a missing trial stays a zero with
  // full weight in the denominator; deleting the hard trials would raise Ŝ and is rejected.
  it('missing trials keep the frozen denominator and count as zero', () => {
    const honest = aggregateEvaluation(measurement([
      { taskId: 'a', trials: [{ quality: 1, weight: 1, tokens: 10 }, { quality: 0, weight: 1 }] },
    ], 2, 1))
    expect(honest.expected).toBe(2)
    expect(honest.missing).toBe(1)
    expect(honest.quality).toBe(0.5)
    expect(honest.cost).toBe(10)
    expect(honest.incomplete).toBe(true)
    const droppedHardTrials = aggregateEvaluation(measurement([
      { taskId: 'a', trials: [{ quality: 1, weight: 1, tokens: 10 }] },
    ], 2, 0))
    expect(droppedHardTrials.quality).toBe(1)
    expect(honest.quality).toBeLessThan(droppedHardTrials.quality)
  })

  it('cost averages only known positive token counts and stays undefined when all unknown', () => {
    const unknown = aggregateEvaluation(measurement([
      { taskId: 'a', trials: [{ quality: 1, weight: 1 }, { quality: 0, weight: 1 }] },
    ], 2))
    expect(unknown.cost).toBeUndefined()
    expect(unknown.incomplete).toBe(true)
    const mixed = aggregateEvaluation(measurement([
      { taskId: 'a', trials: [{ quality: 1, weight: 1, tokens: 100 }, { quality: 0, weight: 1, tokens: 300 }] },
      { taskId: 'b', trials: [{ quality: 1, weight: 1 }, { quality: 0, weight: 1, tokens: 0 }] },
    ], 2))
    expect(mixed.cost).toBe(200)
    expect(mixed.incomplete).toBe(true)
  })

  it('an empty task list yields zero quality rather than NaN', () => {
    expect(aggregateEvaluation(measurement([], 3)).quality).toBe(0)
  })
})

describe('poolEvaluations', () => {
  const repeat = (qualities: number[], scope = 's'): EvaluationMeasurement => measurement([
    { taskId: 'a', trials: qualities.map((quality) => ({ quality, weight: 1, tokens: 100 })) },
  ], qualities.length, 0, scope)

  it('merges every repetition of the same frozen scope, never the latest one', () => {
    const pooled = poolEvaluations([repeat([0, 1]), repeat([1, 1]), repeat([0, 0])])
    expect(pooled.trials).toBe(6)
    expect(pooled.tasks[0].trials).toHaveLength(6)
    expect(aggregateEvaluation(pooled).quality).toBeCloseTo(0.5, 9)
    expect(aggregateEvaluation(pooled).expected).toBe(6)
  })

  // Correction test (plan §4「同一冻结评估范围聚合全部重复」): pooling all three repeats
  // gives 0.3133…, while "latest repetition wins" would report 0.34.
  it('pools repetitions with summed denominators instead of taking the latest', () => {
    const evals = [repeat([0.3]), repeat([0.3]), repeat([0.34])]
    expect(aggregateEvaluation(poolEvaluations(evals)).quality).toBeCloseTo(0.3133, 3)
    expect(aggregateEvaluation(evals[2]).quality).toBeCloseTo(0.34, 9)
  })

  it('refuses to merge across scopes or an empty list', () => {
    expect(() => poolEvaluations([repeat([1], 'a'), repeat([1], 'b')])).toThrow(/scope mismatch/)
    expect(() => poolEvaluations([])).toThrow(/no evaluations/)
  })
})

describe('bootstrapStdError', () => {
  const ev = measurement([
    { taskId: 'a', trials: [{ quality: 0, weight: 1 }, { quality: 1, weight: 1 }] },
    { taskId: 'b', trials: [{ quality: 1, weight: 1 }, { quality: 0, weight: 1 }] },
  ], 2)

  it('is deterministic for a fixed seed', () => {
    expect(bootstrapStdError(ev, 200, 7)).toBe(bootstrapStdError(ev, 200, 7))
    expect(bootstrapStdError(ev, 200, 7)).toBeGreaterThan(0)
  })

  it('is zero when every resample is identical (k=1)', () => {
    const single = measurement([{ taskId: 'a', trials: [{ quality: 1, weight: 1 }] }], 1)
    expect(bootstrapStdError(single, 100, 7)).toBe(0)
  })
})

describe('calibrateNoise', () => {
  const solved = (qualities: number[], tokens: number): EvaluationMeasurement => measurement([
    { taskId: 'a', trials: qualities.map((quality) => ({ quality, weight: 1, tokens })) },
    { taskId: 'b', trials: qualities.map((quality) => ({ quality, weight: 1, tokens })) },
  ], qualities.length)

  it('observes noise directly from >= minIndependentEvaluations independent solves', () => {
    const evals = [solved([1, 0], 1000), solved([0, 0], 1100), solved([1, 0], 950)]
    const calibration = calibrateNoise(evals, DEFAULT_STRATEGY_POLICY)
    expect(calibration.method).toBe('repeated-baseline-evaluations')
    expect(calibration.evaluations).toBe(3)
    expect(calibration.qualityBand).toBeCloseTo(2 * Math.sqrt(1 / 12) * Math.SQRT2, 6)
    expect(calibration.degenerate).toBe(false)
    expect(calibration.relativeCostBand).toBeGreaterThan(0)
  })

  // Correction test (plan §4「同版本独立求解至少三次」): two independent solves are not
  // enough to claim observed noise; the calibration must degrade to bootstrap.
  it('degrades to within-task bootstrap below three independent solves', () => {
    const evals = [solved([1, 0], 1000), solved([0, 1], 1000)]
    const calibration = calibrateNoise(evals, DEFAULT_STRATEGY_POLICY)
    expect(calibration.method).toBe('within-task-bootstrap')
    expect(calibration.qualityBand).toBeGreaterThan(0)
  })

  it('bootstraps a single solve', () => {
    const one = measurement(
      Array.from({ length: 40 }, (_, i) => ({
        taskId: `t${i}`,
        trials: [
          { quality: i % 2, weight: 1, tokens: 1000 },
          { quality: (i + 1) % 2, weight: 1, tokens: 1000 },
        ],
      })), 2)
    const calibration = calibrateNoise([one], DEFAULT_STRATEGY_POLICY)
    expect(calibration.method).toBe('within-task-bootstrap')
    expect(calibration.qualityBand).toBeGreaterThan(0)
  })

  // Correction test (plan §4「单 trial 不产生零噪声结论」): k=1 makes every resample
  // identical; the port must declare the floor instead of upstream's delta = 0
  // (rrsi/calibrate.py:103 sd_use collapses to a zero bootstrap at k=1).
  it('never reports a zero band for single-trial evidence', () => {
    const single = measurement([{ taskId: 'a', trials: [{ quality: 1, weight: 1, tokens: 100 }] }], 1)
    const calibration = calibrateNoise([single], DEFAULT_STRATEGY_POLICY)
    expect(calibration.degenerate).toBe(true)
    expect(calibration.method).toBe('declared-floor')
    expect(calibration.qualityBand).toBe(DEFAULT_STRATEGY_POLICY.noise.floor)
    expect(calibration.qualityBand).toBeGreaterThan(0)
  })

  it('marks calibration degenerate when cost noise is unobservable', () => {
    const evals = [solved([1, 0], 1000), solved([0, 1], 1000), solved([1, 1], 1000)]
    const calibration = calibrateNoise(evals, DEFAULT_STRATEGY_POLICY)
    expect(calibration.degenerate).toBe(true)
    expect(calibration.relativeCostBand).toBe(DEFAULT_STRATEGY_POLICY.noise.floor)
  })

  it('throws without any base evaluation', () => {
    expect(() => calibrateNoise([], DEFAULT_STRATEGY_POLICY)).toThrow(/no base evaluations/)
  })
})
