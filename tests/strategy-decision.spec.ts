/**
 * Behaviour of the pure decision layer, and a counterexample for every deliberate tightening.
 *
 * Each `describe` below states the rule, the upstream behaviour it departs from (measured against
 * google-research/rrsi @ be50316 with `python3`, so the numbers in the comments are real), and the
 * input that tells the two apart. A tightening whose counterexample is not in this file is a
 * tightening nothing enforces; the mutation table in `docs/divergence-ledger.md` names, for each
 * rule, the one line that can be disabled to make one of these fail.
 */

import { describe, expect, it } from 'vitest'

import {
  editBudgetFor,
  noveltyOf,
  select,
  type Calibration,
  type Candidate,
  type History,
  type Measurement,
  type Outcome,
  type Selection,
} from '../src/strategy/decision.ts'

const WEIGHTS = { quality: 100, cost: 15 }
const MEASURED: Calibration = { floor: 0.02, source: 'measured' }

function measurement(quality: number, rest: Partial<Measurement> = {}): Measurement {
  return { quality, cost: 1000, denominator: 2, missing: 0, ...rest }
}

function candidate(slot: number, rest: Partial<Candidate> = {}): Candidate {
  return { slot, exploratory: false, assets: [], measurement: measurement(0.5), constraintsMet: true, inadmissible: null, ...rest }
}

function delta(slot: number, deltaQuality: number, deltaCost: number | null = 0): History['deltas'][number] {
  return { slot, deltaQuality, deltaCost }
}

function history(deltas: readonly History['deltas'][number][], acceptedAssets: readonly string[] = []): History {
  return { acceptedAssets, deltas }
}

function reasonFor(selection: Selection, slot: number): string {
  const outcome: Outcome | undefined = selection.outcomes.find((entry) => entry.slot === slot)
  if (outcome === undefined) throw new Error(`selection reports no outcome for slot ${slot}`)
  return outcome.reason
}

function admittedSlots(selection: Selection): number[] {
  return selection.outcomes.filter((entry) => entry.admitted).map((entry) => entry.slot)
}

/** Upstream `rrsi/schedule.py:43-50`: the same cosine divided by `T`, not by `T - 1`. */
function upstreamBudget(round: number, rounds: number, first: number, minimum: number): number {
  const step = Math.max(0, Math.min(round, rounds))
  return Math.ceil(Number((minimum + (first - minimum) * 0.5 * (1 + Math.cos((Math.PI * step) / rounds))).toFixed(9)))
}

/** Upstream `rrsi/selection.py:84-86`: `beta0 + beta1·dS`, with no ceiling. */
function upstreamCostBudget(gain: number): number {
  return 0.10 + 40 * gain
}

describe('editBudgetFor: the budget anneals by rounds-1 (ADR tightening #1)', () => {
  it('reaches the minimum in the last round, where upstream stays one step above it', () => {
    // Upstream's own table for T=20 divides by 20, so its last in-range round (t=19) is 2 and only
    // the out-of-range endpoint t=T reaches b_min. That endpoint is never asked for by range(T).
    expect(upstreamBudget(19, 20, 4, 1)).toBe(2)
    expect(editBudgetFor(20, 20, 4, 1)).toBe(1)
  })

  it('is the rounds-1 anneal table end to end, and is monotone non-increasing', () => {
    const table = Array.from({ length: 20 }, (_, index) => editBudgetFor(index + 1, 20, 4, 1))
    expect(table).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1])
  })

  it('gives a one-round run the minimum: that round is its own last round', () => {
    expect(upstreamBudget(0, 1, 4, 1)).toBe(4)
    expect(editBudgetFor(1, 1, 4, 1)).toBe(1)
  })

  it('clamps an out-of-range round to the nearest end', () => {
    expect(editBudgetFor(0, 20, 4, 1)).toBe(4)
    expect(editBudgetFor(25, 20, 4, 1)).toBe(1)
  })
})

describe('noveltyOf: mechanism types, not edits (R05)', () => {
  it('counts two skill edits as one class and two classes as two', () => {
    expect(noveltyOf(['skill', 'skill'], history([], []))).toBe(1)
    expect(noveltyOf(['skill', 'tool'], history([], []))).toBe(2)
  })

  it('does not count a class that has already been accepted', () => {
    expect(noveltyOf(['skill'], history([], ['skill']))).toBe(0)
    expect(noveltyOf(['skill', 'tool'], history([], ['skill']))).toBe(1)
  })

  it('counts nothing when no structural class was declared (ADR tightening #5)', () => {
    // Upstream recovers a class from the diff: normalize('prompt', a diff whose only changed lines
    // are text under a `skills/` path) returns 'skill', so a text tweak earns novelty 1. The port
    // has no diff input at all: a class that was not declared and verified is not a class.
    expect(noveltyOf([], history([], []))).toBe(0)
  })

  it('takes the verified declaration as truth instead of recovering one from the diff', () => {
    // Upstream, measured: normalize('client_tool', '+++ b/harness/tools/registry.py\n+
    // registry.add(tool)') === 'prompt' — the real tool change carries no signal from the regex
    // table, so it is downgraded to the non-structural default and earns novelty 0.
    expect(noveltyOf(['tool'], history([], []))).toBe(1)
    // And the declaration is not silently widened either: the class is whatever the adapter
    // verified against the real diff, so an unchanged candidate declares no class at all.
    expect(noveltyOf([], history([], ['tool']))).toBe(0)
  })
})

describe('select: admissibility before any comparison', () => {
  it('refuses a high-scoring candidate whose hard constraint is violated (non-compensating)', () => {
    const selection = select(
      [candidate(0, { measurement: measurement(0.9), constraintsMet: false }), candidate(1, { measurement: measurement(0.6) })],
      history([delta(0, 0.4), delta(1, 0.1)]),
      MEASURED,
      WEIGHTS,
    )
    expect([selection.winner, reasonFor(selection, 0)]).toEqual([1, expect.stringContaining('hard constraint violated')])
  })

  it('returns winner null when the only high scorer is the one that violates a constraint', () => {
    const selection = select(
      [candidate(0, { measurement: measurement(0.99), constraintsMet: false })],
      history([delta(0, 0.49)]),
      MEASURED,
      WEIGHTS,
    )
    expect([selection.winner, reasonFor(selection, 0)]).toEqual([null, expect.stringContaining('non-compensating')])
  })

  it('refuses an incomplete measurement instead of scoring it (R06)', () => {
    // trials=2, one observation missing: the denominator stays 2 and the candidate is not
    // admissible at all, so quality 0.9 cannot outrank a complete 0.6.
    const selection = select(
      [candidate(0, { measurement: measurement(0.9, { missing: 1, denominator: 2 }) }), candidate(1, { measurement: measurement(0.6) })],
      history([delta(0, 0.4), delta(1, 0.1)]),
      MEASURED,
      WEIGHTS,
    )
    expect([selection.winner, reasonFor(selection, 0)]).toEqual([1, expect.stringContaining('incomplete measurement: 1 of 2')])
  })

  it('refuses an unmeasured slot and a slot the caller already called inadmissible', () => {
    const selection = select(
      [
        candidate(0, { measurement: null }),
        candidate(1, { inadmissible: 'caliber-mismatch' }),
        candidate(2, { measurement: measurement(0.7) }),
      ],
      history([delta(0, 0), delta(1, 0.2), delta(2, 0.2)]),
      MEASURED,
      WEIGHTS,
    )
    expect([selection.winner, reasonFor(selection, 0), reasonFor(selection, 1)]).toEqual([2, expect.stringContaining('not measured'), expect.stringContaining('caliber-mismatch')])
  })

  it('refuses a slot whose frozen gain is missing rather than inventing one', () => {
    const selection = select(
      [candidate(0, { measurement: measurement(0.8) }), candidate(1, { measurement: measurement(0.7) })],
      history([delta(1, 0.2)]),
      MEASURED,
      WEIGHTS,
    )
    expect([selection.winner, reasonFor(selection, 0)]).toEqual([1, expect.stringContaining('no frozen gain')])
  })

  it('keeps the incumbent with winner null, and still reports a reason per slot', () => {
    const selection = select(
      [candidate(0, { measurement: measurement(0.5) }), candidate(1, { measurement: measurement(0.5) })],
      history([delta(0, 0), delta(1, 0)]),
      MEASURED,
      WEIGHTS,
    )
    expect(selection.winner).toBeNull()
    // The reason is the judgement, not merely a string: both slots are refused by the in-band rule,
    // which is the fact a caller reads instead of a winner. A non-empty reason would not say that.
    expect(selection.outcomes.map((entry) => entry.reason)).toEqual([expect.stringContaining('in-band candidate'), expect.stringContaining('in-band candidate')])
  })
})

describe('select: the noise band', () => {
  it('does not let a gain inside the band buy a cost increase', () => {
    // Same +24% cost. Outside the band (dS = +0.04) the gain funds it, up to the cap. Inside the
    // band (dS = +0.015) the gain is not a gain, and the in-band rate 100*0.015 - 15*0.24 = -2.1
    // is not positive, so the very same cost is refused.
    const outside = select([candidate(0, { measurement: measurement(0.54) })], history([delta(0, 0.04, 0.24)]), MEASURED, WEIGHTS)
    const inside = select([candidate(0, { measurement: measurement(0.515) })], history([delta(0, 0.015, 0.24)]), MEASURED, WEIGHTS)
    expect(outside.winner).toBe(0)
    expect([inside.winner, reasonFor(inside, 0)]).toEqual([null, expect.stringContaining('inside the noise band')])
  })

  it('admits an in-band candidate that pays for itself with cost', () => {
    const selection = select([candidate(0, { measurement: measurement(0.5) })], history([delta(0, 0, -0.1)]), MEASURED, WEIGHTS)
    expect([selection.winner, reasonFor(selection, 0)]).toEqual([0, expect.stringContaining('100*dS - 15*dC = +1.5000')])
  })

  it('records whether the band was measured or declared, without changing the rule (R06)', () => {
    const measured = select([candidate(0)], history([delta(0, 0.015, 0.24)]), { floor: 0.02, source: 'measured' }, WEIGHTS)
    const declared = select([candidate(0)], history([delta(0, 0.015, 0.24)]), { floor: 0.02, source: 'declared' }, WEIGHTS)
    expect([measured.winner, declared.winner]).toEqual([null, null])
    expect([reasonFor(measured, 0), reasonFor(declared, 0)]).toEqual([expect.stringContaining('(measured)'), expect.stringContaining('(declared)')])
  })
})

describe('select: the cost rule', () => {
  it('caps what a gain may buy at +25% (ADR tightening #2)', () => {
    // Upstream's budget for dS = +0.05 is 0.10 + 40*0.05 = 2.10, so it admits +30% cost.
    expect(upstreamCostBudget(0.05)).toBeCloseTo(2.1, 9)
    const refused = select([candidate(0)], history([delta(0, 0.05, 0.3)]), MEASURED, WEIGHTS)
    expect([refused.winner, reasonFor(refused, 0)]).toEqual([null, expect.stringContaining('> budget 0.250')])
    const boundary = select([candidate(0)], history([delta(0, 0.05, 0.25)]), MEASURED, WEIGHTS)
    expect(boundary.winner).toBe(0)
  })

  it('refuses an unknown cost change instead of reading it as 0.0 (ADR tightening #4)', () => {
    // Upstream relative_cost_change(None, 1000) === 0.0, so the gaining branch (budget 2.10) and
    // the in-band branch with novelty (shaped 0 - 0 + 0.5*2 = +1.0) both pass silently.
    const gaining = select([candidate(0)], history([delta(0, 0.05, null)]), MEASURED, WEIGHTS)
    expect([gaining.winner, reasonFor(gaining, 0)]).toEqual([null, expect.stringContaining('cost change unknown')])
    const inBand = select(
      [candidate(0, { assets: ['skill', 'tool'] })],
      history([delta(0, 0, null)], []),
      MEASURED,
      WEIGHTS,
    )
    expect(inBand.winner).toBeNull()
  })
})

describe('select: argmax and the deterministic tie-break (ADR tightening #3)', () => {
  it('picks the highest measured quality among the admissible', () => {
    const selection = select(
      [candidate(0, { measurement: measurement(0.6) }), candidate(1, { measurement: measurement(0.8) }), candidate(2, { measurement: measurement(0.7) })],
      history([delta(0, 0.1), delta(1, 0.3), delta(2, 0.2)]),
      MEASURED,
      WEIGHTS,
    )
    expect(selection.winner).toBe(1)
  })

  it('breaks a quality tie by slot number ascending, not by novelty', () => {
    // Slot 2 touches two never-accepted structural classes and slots 0..1 touch none. Upstream's
    // in-band rule pays +w_n*nu for that (shaped +1.0 on a neutral candidate); here it buys
    // nothing, and the tie is settled by the slot number.
    const selection = select(
      [candidate(2, { measurement: measurement(0.7), assets: ['skill', 'tool'] }), candidate(0, { measurement: measurement(0.7) }), candidate(1, { measurement: measurement(0.7) })],
      history([delta(0, 0.2), delta(1, 0.2), delta(2, 0.2)], []),
      MEASURED,
      WEIGHTS,
    )
    expect(noveltyOf(['skill', 'tool'], history([], []))).toBe(2)
    expect(selection.winner).toBe(0)
    expect(admittedSlots(selection)).toEqual([0, 1, 2])
  })

  it('produces the same selection for the same facts in any arrival order', () => {
    const forward = select(
      [candidate(0, { measurement: measurement(0.7) }), candidate(1, { measurement: measurement(0.7) }), candidate(2, { measurement: measurement(0.9) })],
      history([delta(0, 0.2), delta(1, 0.2), delta(2, 0.4)]),
      MEASURED,
      WEIGHTS,
    )
    const reversed = select(
      [candidate(2, { measurement: measurement(0.9) }), candidate(1, { measurement: measurement(0.7) }), candidate(0, { measurement: measurement(0.7) })],
      history([delta(2, 0.4), delta(1, 0.2), delta(0, 0.2)]),
      MEASURED,
      WEIGHTS,
    )
    expect(reversed).toEqual(forward)
    expect(reversed.winner).toBe(2)
  })
})

describe('select: the frozen round facts (R03)', () => {
  it('judges each slot against its own round incumbent, never against a re-derived head', () => {
    // The measured counterexample: A = 0.6, B = 0.8 against incumbent 0.6. Before B is published
    // the deltas are A +0.0, B +0.2; after it, recomputing against the new head gives A -0.2,
    // B 0.0. The measurements did not change — only the head did.
    const candidates = [candidate(0, { measurement: measurement(0.6) }), candidate(1, { measurement: measurement(0.8) })]
    const frozen = select(candidates, history([delta(0, 0), delta(1, 0.2)]), MEASURED, WEIGHTS)
    const rederived = select(candidates, history([delta(0, -0.2), delta(1, 0)]), MEASURED, WEIGHTS)
    expect(frozen.winner).toBe(1)
    expect(rederived.winner).toBeNull()
    expect(candidates.map((entry) => entry.measurement?.quality)).toEqual([0.6, 0.8])
  })

  it('reads the frozen gain of a slot by slot number, not by position', () => {
    const candidates = [candidate(0, { measurement: measurement(0.6) }), candidate(1, { measurement: measurement(0.8) })]
    const byPosition = history([delta(0, 0), delta(1, 0.2)])
    const shuffled = history([delta(1, 0.2), delta(0, 0)])
    expect(select(candidates, shuffled, MEASURED, WEIGHTS)).toEqual(select(candidates, byPosition, MEASURED, WEIGHTS))
  })
})
