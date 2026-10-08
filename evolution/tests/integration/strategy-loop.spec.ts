/** Pure-function dry run of the search loop: annealed budget, stall steering, pruning,
 *  and stop-search termination — no runtime, no model. */
import { describe, expect, it } from 'vitest'
import { editBudget, editBudgetTable } from '../../src/strategy/schedule.ts'
import { screenBeforeMeasurement } from '../../src/strategy/screen.ts'
import { admit } from '../../src/strategy/selection.ts'
import { foldHistory, renderHistory } from '../../src/strategy/history.ts'
import type { HistoryFacts } from '../../src/strategy/history.ts'
import { aggregateEvaluation, poolEvaluations } from '../../src/strategy/measure.ts'
import type { EvaluationMeasurement, NoiseCalibration } from '../../src/strategy/measure.ts'
import { DEFAULT_STRATEGY_POLICY, MECHANISM_KINDS } from '../../src/strategy/policy.ts'
import type { MechanismKind, StrategyPolicy } from '../../src/strategy/policy.ts'

const calibration: NoiseCalibration = {
  qualityBand: 0.05, relativeCostBand: 0.04, method: 'repeated-baseline-evaluations',
  evaluations: 3, standardError: 0.035, degenerate: false,
}
const critic = { verdict: 'accept' as const, reason: 'ok', evidenceRefs: [], criticId: 'critic-1', at: '2026-10-08T00:00:00Z' }
const structure = { ok: true, findings: [] as readonly string[] }

function measurementOf(scope: string, quality: number, tokens = 1000): EvaluationMeasurement {
  return { scope, trials: 1, missing: 0, tasks: [{ taskId: 't', trials: [{ quality, weight: 1, tokens }] }] }
}

function runLoop(policy: StrategyPolicy, gains: Record<number, number>) {
  const scope = 'loop'
  const candidates: HistoryFacts['candidates'][number][] = [{
    candidateId: 'inc', libraryId: 'lib', contentDigest: 'd-inc', round: -1, scope,
    edits: [{ id: 'C0', mechanism: 'text', targets: ['x'] }],
  }]
  const evaluations: HistoryFacts['evaluations'][number][] = [
    { candidateId: 'inc', scope, measurement: measurementOf(scope, 0.5), verdict: 'done', evidenceRefs: [] },
  ]
  const refutations: HistoryFacts['refutations'][number][] = []
  const versions: HistoryFacts['versions'][number][] = [
    { round: -1, libraryId: 'lib', revisionId: 'r-inc', contentDigest: 'd-inc' },
  ]
  const facts: HistoryFacts = { candidates, evaluations, consumption: [], refutations, versions }
  let incumbentQuality = 0.5
  let incumbentDigest = 'd-inc'
  const steerings: string[] = []
  let stoppedAt: number | undefined
  for (let t = 0; t < policy.rounds; t += 1) {
    const view = foldHistory(facts, policy, t)
    steerings.push(view.steering)
    if (view.steering === 'stop-search') { stoppedAt = t; break }
    const budget = editBudget(t, { rounds: policy.rounds, ...policy.editBudget })
    const mechanism: MechanismKind = view.steering === 'steer-untested'
      ? view.untestedMechanisms[0]
      : MECHANISM_KINDS[t % MECHANISM_KINDS.length]
    const candidateId = `c${t}`
    const contentDigest = `d-${t}`
    candidates.push({
      candidateId, libraryId: 'lib', contentDigest, round: t, scope,
      edits: [{ id: 'C1', mechanism, hypothesis: `h${t}`, targets: ['x'] }],
    })
    const screen = screenBeforeMeasurement({
      round: t, edits: [{ id: 'C1', mechanism, targets: ['x'] }], structure, critic, policy,
    })
    if (!screen.ok) {
      refutations.push({
        candidateId, contentDigest, mechanism, hypothesis: `h${t}`,
        reasonCode: screen.reasonCode, reason: screen.reason, evidenceRefs: [], round: t,
      })
      continue
    }
    const quality = incumbentQuality + (gains[t] ?? 0.005)
    evaluations.push({ candidateId, scope, measurement: measurementOf(scope, quality), verdict: 'done', evidenceRefs: [`ev-${t}`] })
    const admission = admit({
      candidate: {
        candidateId, contentDigest, scope,
        edits: [{ id: 'C1', mechanism, targets: ['x'] }],
        aggregate: aggregateEvaluation(measurementOf(scope, quality)),
      },
      incumbent: aggregateEvaluation(measurementOf(scope, incumbentQuality)),
      incumbentScope: scope,
      bestQuality: Math.max(0.5, incumbentQuality),
      calibration, guards: [], policy,
    })
    if (admission.admissible) {
      versions.push({ round: t, libraryId: 'lib', revisionId: `r-${t}`, contentDigest })
      incumbentQuality = quality
      incumbentDigest = contentDigest
    } else {
      refutations.push({
        candidateId, contentDigest, mechanism, hypothesis: `h${t}`,
        reasonCode: admission.reasonCode, reason: admission.reason, evidenceRefs: [`ev-${t}`], round: t,
      })
    }
  }
  return { facts, steerings, stoppedAt, incumbentQuality, incumbentDigest }
}

describe('strategy loop dry run', () => {
  it('runs all 20 rounds under a never-stalling policy, with the annealed budget enforced', () => {
    const policy: StrategyPolicy = { ...DEFAULT_STRATEGY_POLICY, stallRounds: 25 }
    const gains = { 0: 0.06, 1: 0.06 }
    const { stoppedAt, incumbentQuality } = runLoop(policy, gains)
    expect(stoppedAt).toBeUndefined()
    expect(incumbentQuality).toBeCloseTo(0.62, 9)
    const table = editBudgetTable({ rounds: policy.rounds, ...policy.editBudget })
    expect(table[19]).toBe(1)
    expect(table[0]).toBe(2)
  })

  it('steers to untested mechanisms after two gainless rounds and stops when none remain', () => {
    const gains = { 0: 0.06, 1: 0.06 }
    const { steerings, stoppedAt, facts } = runLoop(DEFAULT_STRATEGY_POLICY, gains)
    expect(steerings).toContain('steer-untested')
    expect(stoppedAt).toBeDefined()
    expect(stoppedAt!).toBeLessThan(DEFAULT_STRATEGY_POLICY.rounds)
    const finalView = foldHistory(facts, DEFAULT_STRATEGY_POLICY, stoppedAt!)
    expect(finalView.untestedMechanisms).toEqual([])
    expect(finalView.steering).toBe('stop-search')
    const rendered = renderHistory(finalView, 40)
    expect(rendered.length).toBeLessThanOrEqual(40)
    expect(rendered.some((e) => e.measured)).toBe(true)
  })

  it('a late-round bundle exceeding the annealed budget is refused before measurement', () => {
    const screen = screenBeforeMeasurement({
      round: 19,
      edits: [
        { id: 'C1', mechanism: 'text', targets: ['x'] },
        { id: 'C2', mechanism: 'skill', targets: ['y'] },
      ],
      structure, critic, policy: DEFAULT_STRATEGY_POLICY,
    })
    expect(screen).toMatchObject({ ok: false, reasonCode: 'over-budget' })
  })

  // plan §4「同一冻结评估范围聚合全部重复」: the admission verdict over three pooled
  // repetitions must not depend on their order, and must differ from "latest wins".
  it('pooled repetitions admit identically regardless of evaluation order', () => {
    const scope = 'loop'
    const repeats = [0.30, 0.30, 0.34].map((q) => measurementOf(scope, q))
    const incumbent = aggregateEvaluation(measurementOf(scope, 0.3))
    const verdictFor = (evals: EvaluationMeasurement[]) => {
      const pooled = aggregateEvaluation(poolEvaluations(evals))
      return admit({
        candidate: { candidateId: 'x', contentDigest: 'd-x', scope, edits: [{ id: 'C1', mechanism: 'text', targets: ['x'] }], aggregate: pooled },
        incumbent, incumbentScope: scope, bestQuality: 0.32,
        calibration: { ...calibration, qualityBand: 0.005 }, guards: [], policy: DEFAULT_STRATEGY_POLICY,
      })
    }
    const forward = verdictFor(repeats)
    const reversed = verdictFor([...repeats].reverse())
    expect(aggregateEvaluation(poolEvaluations(repeats)).quality).toBeCloseTo(0.3133, 3)
    expect(forward.reasonCode).toBe('below-floor')
    expect(reversed.reasonCode).toBe(forward.reasonCode)
    expect(verdictFor([repeats[2]]).admissible).not.toBe(forward.admissible)
  })
})
