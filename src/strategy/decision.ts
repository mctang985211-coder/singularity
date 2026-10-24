/**
 * The pure decision layer of a round: RRSI's Algorithm 2 (`rrsi/selection.py`)
 * ported from google-research/rrsi @ be50316 (Apache-2.0).
 *
 * This module holds no facts, writes no log, imports nothing and throws nothing. Why that is the
 * whole contract: the previous port recomputed every old candidate's gain against the newest
 * published revision, so publishing B moved B's frozen `+0.2` to `0` and A's `+0.2` to `-0.2`
 * (review §4 R03). A decision that reads the current head cannot be replayed against a frozen
 * cutoff; a decision computed from facts handed in can, and it produces the same selection no
 * matter which order the candidates finished in.
 *
 * Judgement order: structural admissibility -> measured improvement -> argmax
 * with a deterministic tie-break. Hard constraints and complete quality observations
 * remain mandatory. Missing or increased cost never vetoes a quality gain;
 * recorded savings can still support an in-band improvement.
 *
 * Every deliberate difference from upstream is listed, with its counterexample vector, in
 * `docs/divergence-ledger.md`.
 *
 * @module strategy/decision
 */

/** One candidate's measurement, already projected by `src/measure/**`. */
export interface Measurement {
  readonly quality: number
  /** Recorded cost for reporting; legacy callers may still supply null. Never used for admission. */
  readonly cost: number | null
  /** The planned trial count (`trials` of `measure@1`), not the number of observations. */
  readonly denominator: number
  /** Trials with no observation. Anything above `0` makes the measurement incomplete. */
  readonly missing: number
}

/** One candidate, by the slot it was submitted to. */
export interface Candidate {
  readonly slot: number
  /**
   * The structural asset classes this candidate changes, already verified against the real diff by
   * the adapter (ADR tightening #5). Read by `noveltyOf`, never by `select`: novelty must not enter
   * the selection rule at all.
   */
  readonly assets: readonly string[]
  /** `null` = not measured, or measured but incomplete. */
  readonly measurement: Measurement | null
  /** Whether every hard constraint of the judgement is satisfied. `false` is never compensable. */
  readonly constraintsMet: boolean
  /** The caller's named reason when the candidate is not admissible at all, e.g. `caliber-mismatch`. */
  readonly inadmissible: string | null
}

/** The frozen facts a round's candidates are judged against. */
export interface History {
  /**
   * The asset classes already *published*, for novelty (`R05`: two skill edits are still novelty 1).
   * The caller freezes this at the round's history cutoff; this module never widens it.
   */
  readonly acceptedAssets: readonly string[]
  /**
   * Each slot's gain against **its own round's** incumbent, frozen when it was measured and never
   * recomputed against today's head (R03). `deltaCost` can support a saving; null
   * means the relative change is undefined (for example a zero baseline), and never blocks quality gains.
   */
  readonly deltas: readonly {
    readonly slot: number
    readonly deltaQuality: number
    readonly deltaCost: number | null
  }[]
}

/** The noise band and where it came from. The source is recorded, never silently defaulted. */
export interface Calibration {
  readonly floor: number
  /** `measured` = calibrated from repeated evaluations; `declared` = a policy floor. Both are
   *  verdict-relevant only through the band value; the source must reach the decision record so a
   *  report can say which one it was (R06). */
  readonly source: 'measured' | 'declared'
}

/** Why one slot was admitted or refused. Every slot gets one, admitted or not. */
export interface Outcome {
  readonly slot: number
  readonly admitted: boolean
  readonly reason: string
}

/** A round's decision: the winning slot, or `null` to keep the incumbent. */
export interface Selection {
  readonly winner: number | null
  readonly outcomes: readonly Outcome[]
}

type RoundDelta = History['deltas'][number]
type Weights = { readonly quality: number; readonly cost: number }

interface Verdict {
  readonly admitted: boolean
  readonly reason: string
}

/** `+0.2000` / `-0.0500`: a decision record must show the sign of what it judged. */
function signed(value: number): string {
  return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4)
}

/** The band, labelled with where it came from (R06: measured or declared, never ambiguous). */
function bandOf(calibration: Calibration): string {
  return `${calibration.floor.toFixed(4)} (${calibration.source})`
}

/**
 * `nu(l')`: how many *types* of structural mechanism this candidate touches that have never been
 * accepted before (upstream `rrsi/components.py:103`).
 *
 * Types, not edits: two skill edits are novelty 1, and two classes are 2 (R05 — the previous
 * system's "two edits, so novelty 2" reading is wrong, because upstream's `set()` deduplicates).
 *
 * The classes are taken from the declaration. Upstream does not take them from the declaration: its
 * `normalize()` keeps a declared class only when a regex finds a signal for it in the diff text and
 * otherwise *recovers* one with `classify_diff`, whose last resort is the non-structural `prompt`.
 * Measured on upstream: a real tool change in `harness/tools/registry.py` is normalized to `prompt`
 * and earns no novelty, while a text edit under a `skills/` path is normalized to `skill` and earns
 * one. Verifying a declared class against the real diff is the candidate adapter's job (ADR
 * tightening #5); this function has no diff parameter on purpose, because a second, textual opinion
 * about what a candidate changed is how the previous system's novelty became a constant.
 */
export function noveltyOf(assets: readonly string[], history: History): number {
  const accepted = new Set(history.acceptedAssets)
  let novelty = 0
  for (const asset of new Set(assets)) if (!accepted.has(asset)) novelty += 1
  return novelty
}

/** Cost savings can support improvement; cost gaps or increases cannot veto it. */
function judge(
  candidate: Candidate,
  delta: RoundDelta | undefined,
  calibration: Calibration,
  weights: Weights,
): Verdict {
  if (candidate.inadmissible !== null) return { admitted: false, reason: `inadmissible: ${candidate.inadmissible}` }
  const measurement = candidate.measurement
  if (measurement === null)
    return { admitted: false, reason: 'not measured: the slot has no measurement, so there is nothing to compare' }
  if (!candidate.constraintsMet)
    return {
      admitted: false,
      reason:
        'hard constraint violated: the judgement constraints are not all met, and no quality can compensate for one that is (non-compensating)',
    }
  if (measurement.missing > 0)
    return {
      admitted: false,
      reason: `incomplete measurement: ${measurement.missing} of ${measurement.denominator} planned trials have no observation; keep the denominator and refuse the candidate, because a method cannot improve by dropping the trials it finds hard`,
    }
  if (delta === undefined)
    return {
      admitted: false,
      reason: `no frozen gain for slot ${candidate.slot}: the round's facts carry no measurement-time delta, so the quality comparison has no input`,
    }
  const gain = delta.deltaQuality
  if (gain > calibration.floor)
    return {
      admitted: true,
      reason: `admissible: gain ${signed(gain)} is outside the noise band ${bandOf(calibration)}; no cost gate`,
    }
  const saving = Math.max(0, -(delta.deltaCost ?? 0))
  const shaped = weights.quality * gain + weights.cost * saving
  const admitted = shaped > 0
  return {
    admitted,
    reason: `${admitted ? 'admissible' : 'in-band candidate'}: gain ${signed(gain)} is inside the noise band ${bandOf(calibration)}; quality and recorded savings ${weights.quality}*dS + ${weights.cost}*saving = ${signed(shaped)} ${admitted ? '>' : '<='} 0; no cost gate; novelty never enters this rule`,
  }
}

/**
 * Steps 1-4 of the frozen order over the whole round.
 *
 * `admitted` / `winner` come from the measured quality `S'` (upstream `selection.py:136` takes
 * `argmax S'` over the admissible set); the frozen deltas decide only whether a slot *is*
 * admissible. Equal qualities are separated by slot number ascending, so the selection does not
 * depend on the order the candidates finished in (R07), and novelty is not a tie-break either
 * (ADR tightening #3): the ranking input is the measurement, and the slot number is the only
 * further fact that is stable across a replay.
 */
export function select(
  candidates: readonly Candidate[],
  history: History,
  calibration: Calibration,
  weights: Weights,
): Selection {
  const deltaBySlot = new Map<number, RoundDelta>()
  for (const delta of history.deltas) deltaBySlot.set(delta.slot, delta)
  const ordered = [...candidates].sort((left, right) => left.slot - right.slot)
  const outcomes: Outcome[] = []
  const admitted: { slot: number; quality: number }[] = []
  for (const candidate of ordered) {
    const verdict = judge(candidate, deltaBySlot.get(candidate.slot), calibration, weights)
    outcomes.push({ slot: candidate.slot, admitted: verdict.admitted, reason: verdict.reason })
    const measurement = candidate.measurement
    if (verdict.admitted && measurement !== null) {
      admitted.push({ slot: candidate.slot, quality: measurement.quality })
    }
  }
  let winner: number | null = null
  let best = Number.NEGATIVE_INFINITY
  for (const entry of admitted) {
    if (entry.quality > best) {
      best = entry.quality
      winner = entry.slot
    }
  }
  return { winner, outcomes }
}
