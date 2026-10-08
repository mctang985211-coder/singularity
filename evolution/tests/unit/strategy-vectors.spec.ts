/** Python→TS test vectors extracted from google-research/rrsi @ be50316 (Apache-2.0)
 *  by tests/vectors/extract-rrsi-vectors.py. kind "deterministic" vectors run upstream
 *  and the port through identical inputs; "port-adapted" vectors carry expected values
 *  recomputed with the port's deterministic rules; "upstream-native" vectors document
 *  divergences and are not re-executed against the TS port. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { editBudget, editBudgetTable } from '../../src/strategy/schedule.ts'
import { aggregateEvaluation, calibrateNoise } from '../../src/strategy/measure.ts'
import type { EvaluationMeasurement, NoiseCalibration } from '../../src/strategy/measure.ts'
import { costRule, noveltyOf, selectRound } from '../../src/strategy/selection.ts'
import type { CandidateMeasurement } from '../../src/strategy/selection.ts'
import { exploration, stallFlag } from '../../src/strategy/history.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'
import type { StrategyPolicy } from '../../src/strategy/policy.ts'

interface Vector {
  id: string
  source: string
  kind: 'deterministic' | 'port-adapted' | 'upstream-native'
  function: string
  input: unknown
  expected: unknown
  portNote?: string
  provenance: { commit: string; file: string; line: number; license: string }
}

const doc = JSON.parse(readFileSync(new URL('../vectors/rrsi-vectors.json', import.meta.url), 'utf8')) as {
  provenance: { repository: string; commit: string; license: string; licenseFile: string; extractedBy: string }
  vectors: Vector[]
}

function toMeasurement(raw: unknown): EvaluationMeasurement {
  const ev = raw as { scope: string; trials: number; missing: number; tasks: { taskId: string; trials: { quality: number; weight: number; tokens: number | null }[] }[] }
  return {
    scope: ev.scope, trials: ev.trials, missing: ev.missing,
    tasks: ev.tasks.map((t) => ({
      taskId: t.taskId,
      trials: t.trials.map((tr) => ({ quality: tr.quality, weight: tr.weight, tokens: tr.tokens ?? undefined })),
    })),
  }
}

function policyOf(profile: string): StrategyPolicy {
  if (profile === 'default') return DEFAULT_STRATEGY_POLICY
  if (profile === 'upstream-equivalent') {
    // Reproduces upstream rrsi/config.py:70 (beta0 = 0.10, beta1 = 40) without the port's
    // 25% cap and without the in-band minRelief floor, for divergence vectors only.
    return {
      ...DEFAULT_STRATEGY_POLICY,
      cost: { baseAllowance: 0.10, gainFundedIncrease: 40, maxRelativeIncrease: Number.POSITIVE_INFINITY },
      inBand: { minRelief: 0 },
    }
  }
  throw new Error(`unknown policy profile ${profile}`)
}

function policyWithOverrides(overrides: Record<string, unknown>): StrategyPolicy {
  return {
    ...DEFAULT_STRATEGY_POLICY,
    noise: { ...DEFAULT_STRATEGY_POLICY.noise, ...(overrides.noise as object) },
  }
}

function calibrationOf(raw: { qualityBand: number; relativeCostBand: number }): NoiseCalibration {
  return {
    ...raw, method: 'repeated-baseline-evaluations', evaluations: 3, standardError: 0, degenerate: false,
  }
}

describe('rrsi-vectors.json provenance', () => {
  it('records the upstream commit, license, and extractor', () => {
    expect(doc.provenance).toMatchObject({
      repository: 'https://github.com/google-research/rrsi',
      commit: 'be50316',
      license: 'Apache-2.0',
      licenseFile: 'rrsi/LICENSE',
      extractedBy: 'evolution/tests/vectors/extract-rrsi-vectors.py',
    })
  })

  it('every vector carries complete provenance', () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(20)
    for (const v of doc.vectors) {
      expect(v.provenance.commit, v.id).toBe('be50316')
      expect(v.provenance.file, v.id).toMatch(/^(rrsi|tests)\//)
      expect(v.provenance.line, v.id).toBeGreaterThan(0)
      expect(v.provenance.license, v.id).toBe('Apache-2.0')
    }
  })
})

describe('rrsi vectors', () => {
  for (const v of doc.vectors) {
    it(`${v.id} (${v.kind})`, () => {
      switch (v.function) {
        case 'editBudgetTable': {
          const input = v.input as unknown as { rounds: number; min: number; max: number }
          const table = editBudgetTable(input)
          if (v.kind === 'upstream-native') {
            // Upstream divides by T, so its last in-range round never reaches b_min;
            // the port divides by rounds-1 (plan §4 override) and diverges exactly there.
            expect(table).not.toEqual(v.expected)
            expect((v.expected as number[])[input.rounds - 1]).not.toBe(input.min)
          } else {
            expect(table).toEqual(v.expected)
          }
          break
        }
        case 'editBudget': {
          const input = v.input as unknown as { round: number; rounds: number; min: number; max: number }
          expect(editBudget(input.round, input)).toBe(v.expected)
          break
        }
        case 'aggregateEvaluation': {
          const score = aggregateEvaluation(toMeasurement(v.input as never))
          const expected = v.expected as { quality: number; cost: number | null; expected: number; missing: number; incomplete: boolean }
          expect(score.quality).toBeCloseTo(expected.quality, 9)
          expect(score.cost ?? null).toBe(expected.cost)
          expect(score.expected).toBe(expected.expected)
          expect(score.missing).toBe(expected.missing)
          expect(score.incomplete).toBe(expected.incomplete)
          break
        }
        case 'calibrateNoise': {
          const input = v.input as unknown as { evals: never[]; policy: Record<string, unknown> }
          const calibration = calibrateNoise(input.evals.map(toMeasurement), policyWithOverrides(input.policy))
          const expected = v.expected as { qualityBand: number; relativeCostBand: number; method: string; evaluations: number; standardError: number; degenerate: boolean }
          expect(calibration.qualityBand).toBeCloseTo(expected.qualityBand, 5)
          expect(calibration.relativeCostBand).toBeCloseTo(expected.relativeCostBand, 5)
          expect(calibration.standardError).toBeCloseTo(expected.standardError, 5)
          expect(calibration.method).toBe(expected.method)
          expect(calibration.evaluations).toBe(expected.evaluations)
          expect(calibration.degenerate).toBe(expected.degenerate)
          break
        }
        case 'costRule': {
          const input = v.input as unknown as { deltaQuality: number; deltaCost: number | null; novelty: number; calibration: { qualityBand: number; relativeCostBand: number }; policy: string }
          const rule = costRule(input.deltaQuality, input.deltaCost ?? undefined, input.novelty, calibrationOf(input.calibration), policyOf(input.policy))
          expect(rule).toMatchObject(v.expected as object)
          break
        }
        case 'selectRound': {
          const input = v.input as unknown as {
            candidates: (Omit<CandidateMeasurement, 'aggregate' | 'refusedBy'> & { aggregate: CandidateMeasurement['aggregate'] | null; refusedBy?: string })[]
            incumbent: CandidateMeasurement['aggregate']; incumbentScope: string; bestQuality: number
            calibration: { qualityBand: number; relativeCostBand: number }
            guards: Record<string, string[]>; policy: string
          }
          const candidates = input.candidates.map((c) => ({
            ...c, aggregate: c.aggregate ?? undefined, refusedBy: c.refusedBy as CandidateMeasurement['refusedBy'],
          }))
          const { winner, admissions } = selectRound({
            candidates, incumbent: input.incumbent!, incumbentScope: input.incumbentScope,
            bestQuality: input.bestQuality, calibration: calibrationOf(input.calibration),
            guardsFor: (c) => input.guards[c.candidateId] ?? [], policy: policyOf(input.policy),
          })
          const expected = v.expected as { winner: string | null; admissions: unknown[] }
          expect(winner?.candidateId ?? null).toBe(expected.winner)
          expect(admissions.map((a) => ({ candidateId: a.candidateId, admissible: a.admissible, reasonCode: a.reasonCode })))
            .toEqual(expected.admissions)
          break
        }
        case 'noveltyOf': {
          const input = v.input as unknown as { cases: { mechanisms: Parameters<typeof noveltyOf>[0]; incumbentCounts: Parameters<typeof noveltyOf>[1] }[] }
          expect(input.cases.map((c) => noveltyOf(c.mechanisms, c.incumbentCounts))).toEqual(v.expected)
          break
        }
        case 'stallFlag': {
          const input = v.input as unknown as { trajectory: number[]; band: number; cases: { t: number; window: number }[] }
          expect(input.cases.map((c) => stallFlag(input.trajectory, c.t, c.window, input.band))).toEqual(v.expected)
          break
        }
        case 'exploration': {
          const input = v.input as unknown as { t: number; stall: 0 | 1; tried: ('skill' | 'capability' | 'task-template' | 'text' | 'parameter')[]; reservedDrafts: number }
          const expected = v.expected as { sigma: 0 | 1; untried: string[]; reservedDrafts: number; textIncludes: string }
          const result = exploration(input.t, input.stall, input.tried, input.reservedDrafts)
          expect(result.sigma).toBe(expected.sigma)
          expect(result.untried).toEqual(expected.untried)
          expect(result.reservedDrafts).toBe(expected.reservedDrafts)
          expect(result.text).toContain(expected.textIncludes)
          break
        }
        case 'foldHistory': {
          // upstream-native documentation vector: the port derives history from facts with a
          // single frozen incumbent baseline; strategy-history.spec.ts pins the port semantics.
          expect(v.kind).toBe('upstream-native')
          expect(v.expected).toMatchObject({ tried: ['memory', 'prompt', 'skill'] })
          break
        }
        default:
          throw new Error(`no TS dispatch for vector function ${v.function}`)
      }
    })
  }
})
