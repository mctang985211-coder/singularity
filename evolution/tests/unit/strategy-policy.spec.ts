/** Frozen strategy policy: defaults, validation, the unregularized comparison arm, and digests. */
import { describe, expect, it } from 'vitest'
import {
  assertStrategyPolicy, DEFAULT_STRATEGY_POLICY, MECHANISM_KINDS, regularizersActive,
  STRUCTURAL_MECHANISM_KINDS, strategyPolicyDigest,
  UNREGULARIZED_STRATEGY_POLICY,
} from '../../src/strategy/policy.ts'
import { costRule } from '../../src/strategy/selection.ts'
import type { NoiseCalibration } from '../../src/strategy/measure.ts'

describe('DEFAULT_STRATEGY_POLICY', () => {
  it('is pinned field by field (plan §4 + rrsi/config.py provenance)', () => {
    expect(DEFAULT_STRATEGY_POLICY).toEqual({
      version: 'rrsi-strategy@1',
      rounds: 20,
      trials: 3,
      candidatesPerRound: 1,
      editBudget: { min: 1, max: 2 },
      stall: { window: 2, reservedDrafts: 1 },
      noise: { z: 2.0, minIndependentEvaluations: 3, bootstrapReps: 2000, seed: 7, floor: 0.02 },
      cost: { baseAllowance: 0.10, gainFundedIncrease: 40, maxRelativeIncrease: 0.25 },
      inBand: { minRelief: 0.05 },
      noveltyRelaxation: false,
      pruneWindow: 4,
      stallRounds: 2,
      baselineAdmissionCeilingTokens: 0,
      critic: 'required',
    })
  })

  it('declares the mechanism vocabulary with a structural subset', () => {
    expect(MECHANISM_KINDS).toEqual(['skill', 'capability', 'task-template', 'text', 'parameter'])
    expect(STRUCTURAL_MECHANISM_KINDS).toEqual(['skill', 'capability', 'task-template'])
  })
})

describe('assertStrategyPolicy', () => {
  const policy = structuredClone(DEFAULT_STRATEGY_POLICY)

  it('accepts both shipped policies', () => {
    expect(() => assertStrategyPolicy(DEFAULT_STRATEGY_POLICY)).not.toThrow()
    expect(() => assertStrategyPolicy(UNREGULARIZED_STRATEGY_POLICY)).not.toThrow()
  })

  it('rejects missing fields, wrong types, and out-of-range values', () => {
    expect(() => assertStrategyPolicy(null)).toThrow(/StrategyPolicy/)
    expect(() => assertStrategyPolicy({})).toThrow(/version/)
    expect(() => assertStrategyPolicy({ ...policy, rounds: 0 })).toThrow(/rounds/)
    expect(() => assertStrategyPolicy({ ...policy, rounds: 2.5 })).toThrow(/rounds/)
    expect(() => assertStrategyPolicy({ ...policy, trials: '3' })).toThrow(/trials/)
    expect(() => assertStrategyPolicy({ ...policy, editBudget: { min: 3, max: 2 } })).toThrow(/editBudget/)
    expect(() => assertStrategyPolicy({ ...policy, noise: { ...policy.noise, z: -1 } })).toThrow(/noise\.z/)
    expect(() => assertStrategyPolicy({ ...policy, noise: { ...policy.noise, floor: -0.1 } })).toThrow(/noise\.floor/)
    expect(() => assertStrategyPolicy({ ...policy, cost: { ...policy.cost, maxRelativeIncrease: 0 } })).toThrow(/maxRelativeIncrease/)
    expect(() => assertStrategyPolicy({ ...policy, noveltyRelaxation: true })).toThrow(/noveltyRelaxation/)
    expect(() => assertStrategyPolicy({ ...policy, critic: 'optional' })).toThrow(/critic/)
    expect(() => assertStrategyPolicy({ ...policy, baselineAdmissionCeilingTokens: -5 })).toThrow(/baselineAdmissionCeilingTokens/)
    const missing = structuredClone(policy) as unknown as Record<string, unknown>
    delete missing.stall
    expect(() => assertStrategyPolicy(missing)).toThrow(/stall/)
  })
})

describe('regularizersActive', () => {
  it('is fully on for the default and fully off for the comparison arm', () => {
    expect(regularizersActive(DEFAULT_STRATEGY_POLICY)).toEqual({
      editBudget: true, noiseFloor: true, costAdmission: true,
      inBandShaping: true, stallSteering: true, pruning: true,
    })
    expect(regularizersActive(UNREGULARIZED_STRATEGY_POLICY)).toEqual({
      editBudget: false, noiseFloor: false, costAdmission: false,
      inBandShaping: false, stallSteering: false, pruning: false,
    })
  })

  // Risk R21: both arms run the same code paths; there is no hidden policy-mode branch.
  it('both arms exercise the same cost-rule paths on the same inputs', () => {
    const calibration: NoiseCalibration = {
      qualityBand: 0.02, relativeCostBand: 0.02, method: 'repeated-baseline-evaluations',
      evaluations: 3, standardError: 0.01, degenerate: false,
    }
    const inputs: [number, number | undefined][] = [[0.05, 0.1], [0.05, undefined], [0, -0.1], [0, 0.1], [-0.1, -0.2]]
    const known = ['admissible', 'cost-inconclusive', 'in-band-no-relief', 'cost-rule-failed']
    const covered = new Set<string>()
    for (const policy of [DEFAULT_STRATEGY_POLICY, UNREGULARIZED_STRATEGY_POLICY]) {
      for (const [dS, dC] of inputs) {
        const code = costRule(dS, dC, 0, calibration, policy).reasonCode
        expect(known).toContain(code)
        covered.add(code)
      }
    }
    expect(covered).toEqual(new Set(known))
  })
})

describe('strategyPolicyDigest', () => {
  it('is sensitive to any field change', () => {
    const digest = strategyPolicyDigest(DEFAULT_STRATEGY_POLICY)
    expect(strategyPolicyDigest({ ...DEFAULT_STRATEGY_POLICY, rounds: 21 })).not.toBe(digest)
    expect(strategyPolicyDigest({
      ...DEFAULT_STRATEGY_POLICY,
      noise: { ...DEFAULT_STRATEGY_POLICY.noise, z: 2.1 },
    })).not.toBe(digest)
    expect(strategyPolicyDigest(UNREGULARIZED_STRATEGY_POLICY)).not.toBe(digest)
  })

  it('is insensitive to key order', () => {
    const reordered = {
      critic: 'required', baselineAdmissionCeilingTokens: 0, stallRounds: 2, pruneWindow: 4,
      noveltyRelaxation: false, inBand: { minRelief: 0.05 },
      cost: { maxRelativeIncrease: 0.25, gainFundedIncrease: 40, baseAllowance: 0.10 },
      noise: { floor: 0.02, seed: 7, bootstrapReps: 2000, minIndependentEvaluations: 3, z: 2.0 },
      stall: { reservedDrafts: 1, window: 2 }, editBudget: { max: 2, min: 1 },
      candidatesPerRound: 1, trials: 3, rounds: 20, version: 'rrsi-strategy@1',
    } as const
    expect(strategyPolicyDigest(reordered)).toBe(strategyPolicyDigest(DEFAULT_STRATEGY_POLICY))
  })
})
