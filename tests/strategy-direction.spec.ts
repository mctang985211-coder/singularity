/**
 * The round's declared metric direction, read by the three comparisons that have to respect it.
 *
 * `round/opened` froze `metric.direction` and nothing read it: a round declaring `direction: 'lower'`
 * (an error rate, where the *smaller* number is the better candidate) was ranked by raw quality, so it
 * elected the **worse** candidate. This is the argmax, the incumbent floor and the reported gain, each
 * under a direction-declaring round, through the repository's own reducer and `projectRound`.
 *
 * Every expected number is a hand-written literal from the round's own unit — the gain is `incumbent −
 * quality` under `lower`, computed here by hand — never recomputed the way the code computes it.
 */

import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/protocol/envelope.ts'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import type { RevisionRef } from '../src/task/protocol.ts'
import type { Calibration } from '../src/strategy/decision.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_ROLE, STRATEGY_VERSION, type RoundState } from '../src/strategy/protocol.ts'
import { projectRound, type FrozenAggregate, type MeasureSlice, type RoundEvaluation } from '../src/strategy/view.ts'

const CALIBER = 'f'.repeat(64)
const CALIBRATION: Calibration = { floor: 0.1, source: 'measured' }
const SUBJECTS: Readonly<Record<string, string>> = { [STRATEGY_ROLE]: 'strategy-service' }
const SKILL = [{ asset: 'skill' as const, target: 'count' }]
const rev = (revisionId: string, seed: string): RevisionRef => ({ environmentId: 'library-1', revisionId, digest: seed.repeat(64) })
const INCUMBENT = rev('r0001', 'a')
let counter = 0
const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`

/** One evaluation as the measure slice projects it. `quality` is the declared metric's own number. */
const evaluation = (evaluationId: string, candidate: RevisionRef, quality: number): RoundEvaluation => ({
  evaluationId, caliberDigest: CALIBER, baseline: INCUMBENT, candidate, denominator: 2, observed: 2, missing: [],
  quality, cost: 10, constraints: [{ criterionId: 'correctness', met: true }], admissible: true, why: null,
})

/**
 * The projected decision of a round declaring `direction: 'lower'` over `error-rate`: the incumbent
 * measured at `incumbent`, two slots measured at `qualities`, both against the incumbent and the
 * round's own caliber, and the round's own `metric` frozen by the reducer.
 */
function lowerRound(incumbent: number, qualities: readonly [number, number]): ReturnType<typeof projectRound> {
  const registry = new ProtocolRegistry()
  declareStrategyProtocol(registry)
  const log = new MemoryLog(registry, { subjects: SUBJECTS, now: () => '2026-10-09T00:00:00.000Z' })
  const emit = (kind: string, payload: unknown): Envelope =>
    log.emit({ commandId: nextId('e'), protocol: STRATEGY_PROTOCOL, version: STRATEGY_VERSION, kind, subject: 'round-1', payload })
  emit(STRATEGY_KINDS.roundOpened, {
    round: 1, incumbent: INCUMBENT, candidates: 2, explorationSlots: 0, editBudget: 2, historyCutoff: 5,
    caliber: CALIBER, metric: { unit: 'error-rate', direction: 'lower' }, weights: { quality: 100, cost: 15 },
  })
  const candidates = [rev('r0002', 'b'), rev('r0003', 'c')] as const
  candidates.forEach((revision, slot) => {
    emit(STRATEGY_KINDS.candidateSubmitted, { slot, revision, evaluationId: `e-${slot}`, edits: SKILL, exploratory: false })
  })
  const slice: MeasureSlice = {
    entries: log.entries(),
    evaluationOf: id => {
      const slot = id === 'e-0' ? 0 : 1
      return evaluation(id, candidates[slot], qualities[slot])
    },
    incumbentBelow: (_revision, cutoff) => (cutoff > 0 ? { quality: incumbent, cost: 10 } satisfies FrozenAggregate : null),
  }
  const state = log.stateAt<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1', log.count) as RoundState
  return projectRound(state, slice, CALIBRATION)
}

describe('a round declaring direction "lower" is ranked in that direction', async () => {
  it('elects the smaller error rate, the better candidate of the two', async () => {
    // Both candidates clear the floor (0.9 − 0.1 = 0.8) read either way round, so only the ranking
    // is under test here — and 0.4 is the better error rate, so slot 0 wins rather than the larger 0.5.
    expect(lowerRound(0.9, [0.4, 0.5]).winner).toBe(0)
  })

  it('admits what clears the floor and refuses what is above it, the worse side under "lower"', async () => {
    // The incumbent's 0.9 less the 0.1 band is a floor of 0.8: 0.5 clears it, 0.95 is above it.
    const decision = lowerRound(0.9, [0.5, 0.95])
    expect(decision.outcomes.map(outcome => outcome.admitted)).toEqual([true, false])
  })

  it('reports a fall in the error rate as the gain it is, not as a negative difference', async () => {
    // 0.9 → 0.4 is an improvement of +0.5 in the metric's own direction, so the cost rule funds it.
    expect(lowerRound(0.9, [0.4, 0.6]).slots[0]?.gain).toBe(0.5)
  })
})
