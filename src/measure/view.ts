/**
 * The one read projection of an evaluation: what the plan asked for, and what actually arrived.
 *
 * **The denominator is the plan's.** `quality` is `sum(observed) / trials`, never
 * `sum(observed) / observed.length`. The measurement this replaces aggregated whatever it had and
 * answered `quality = 1, incomplete = true` for `trials = 2` with one observation: the absent
 * repetition filled nothing, so a single lucky run read as a perfect score, and every consumer that
 * forgot to read `incomplete` was wrong. Keeping the plan's denominator means an incomplete
 * measurement reads as a *worse* one, which is the truthful direction, and `missing` names each slot
 * so no reader has to derive the gap from two counts.
 *
 * **Unknown cost stays unknown.** An observation that reported no cost contributes no zero to the
 * total: `cost` is `null` unless every observation reported one. A summed `0` would claim the
 * repetitions were free, and the cost rule downstream would then compare an invented number against
 * a real one.
 *
 * **Nothing here throws.** An evaluation whose plan was never opened, a hard constraint nobody
 * checked: each is `admissible: false` with a named reason, because the round that consumes this
 * view owes *every* slot a reason — a projection that refused would make one unopened plan
 * unreadable for every other candidate in the same round.
 *
 * **The caliber is derived, never persisted.** It is the set of measurement settings two
 * evaluations must share to be comparable: everything the plan froze except the two revisions being
 * compared and the run's identity, which the run's *context* digest replaces. Its digest is computed
 * from the folded state at read time: a stored one would be a second copy of the facts, free to
 * drift away from them, and `caliber-mismatch` is only meaningful while the comparison is over the
 * settings actually frozen in the plan.
 *
 * @module singularity-core/measure/view
 */

import { digestOf } from '../protocol/envelope.ts'
import type { VerifierCriterion } from '../task/contract.ts'
import type { EvaluationMetric, EvaluationState, EvaluationWeights, TrialRecord } from './protocol.ts'

/** One planned slot that produced no number, with the reason it produced none. */
export interface MissingSlot {
  readonly slot: number
  readonly reason: string
}

/** One hard constraint of the plan, as checked or not. */
export interface ConstraintView {
  readonly criterionId: string
  /** `null` until the criterion's own implementation checks it. Unchecked is not failed. */
  readonly met: boolean | null
}

/** The evaluation as a reader sees it. Derived at read time and never written. */
export interface EvaluationView {
  /** The plan's slot count. It is the denominator, and it does not move when observations are missing. */
  readonly denominator: number
  readonly observed: number
  /** Every planned slot without an observation, in slot order, each with its reason. */
  readonly missing: readonly MissingSlot[]
  /** `sum(observed quality) / denominator`: a missing slot contributes 0 and keeps its place. */
  readonly quality: number
  /** `null` when any observation left its cost unknown. Never 0. */
  readonly cost: number | null
  /**
   * Which way a better number goes, **from the plan's own metric** — the measurement's, not the
   * reader's. A round that ranked candidates by a direction of its own elected the worse candidate
   * whenever the two disagreed, and nothing compared them; the direction travels with the number it
   * orients, so two directions that disagree are two calibers, which may not be pooled.
   *
   * `null` when no plan was opened: a measurement that is not one has no orientation to state.
   */
  readonly direction: 'higher' | 'lower' | null
  /** Every hard constraint of the plan, in judgement order. */
  readonly constraints: readonly ConstraintView[]
  readonly admissible: boolean
  /** Why it is not admissible, naming each failing rule. `null` only when it is admissible. */
  readonly why: string | null
  readonly families?: readonly { readonly familyId: string; readonly quality: number; readonly planned: number; readonly observed: number }[]
  readonly cases?: readonly { readonly caseId: string; readonly familyId: string; readonly quality: number;
    readonly planned: number; readonly observed: number; readonly cost: number | null; readonly guardsMet: boolean | null }[]
}

/** The measured cost, or `null` if any observation left it unknown. Nothing measured has no cost. */
function costOf(observed: readonly Pick<TrialRecord, 'cost'>[]): number | null {
  if (observed.length === 0) return null
  let total = 0
  for (const entry of observed) {
    // Unknown is not zero: an invented 0 would enter the cost rule as a real measurement.
    if (entry.cost === undefined) return null
    total += entry.cost
  }
  return total
}

/** Project one folded evaluation state into the one view every reader shares. */
export function projectEvaluation(state: EvaluationState): EvaluationView {
  const denominator = state.trials ?? 0
  const judgement = state.judgement ?? []
  const observed = [...state.observed, ...(state.failed ?? [])]

  const missing: MissingSlot[] = []
  for (let slot = 0; slot < denominator; slot += 1) {
    if (observed.some((entry) => entry.slot === slot)) continue
    const declared = state.missed.find((entry) => entry.slot === slot)
    missing.push({
      slot,
      reason: declared?.reason ?? 'neither an observation nor a declared miss was recorded for this planned slot',
    })
  }

  const constraints: ConstraintView[] = judgement.map((criterion) => {
    const checked = state.checks.find((entry) => entry.criterionId === criterion.criterionId)
    return { criterionId: criterion.criterionId, met: checked === undefined ? null : checked.met }
  })

  const reasons: string[] = []
  if (state.matrix !== undefined && observed.some(entry => entry.guardsMet !== true)) reasons.push('a trial failed or did not establish its hard guards')
  if (state.trials === undefined) reasons.push('no measurement plan was opened for this evaluation, so there is nothing to report it against')
  for (const constraint of constraints) {
    if (constraint.met === null) reasons.push(`hard constraint "${constraint.criterionId}" has not been checked by its implementation`)
    else if (!constraint.met) reasons.push(`hard constraint "${constraint.criterionId}" was checked by its implementation and not met`)
  }
  if (missing.length > 0)
    reasons.push(
      `${missing.length} of ${denominator} planned trial slots have no observation: ${missing.map((entry) => `slot ${entry.slot} (${entry.reason})`).join('; ')}`,
    )

  const weighted = (slots: readonly number[]) => {
    const weight = slots.reduce((sum, slot) => sum + (state.matrix?.slots[slot]?.weight ?? 1), 0)
    return weight === 0 ? 0 : slots.reduce((sum, slot) => sum + (observed.find(entry => entry.slot === slot)?.quality ?? 0) * (state.matrix?.slots[slot]?.weight ?? 1), 0) / weight
  }
  return {
    denominator,
    observed: observed.length,
    missing,
    quality: weighted(Array.from({ length: denominator }, (_, slot) => slot)),
    cost: costOf(observed),
    // The metric is the plan's, so its direction is the plan's too — read from the one place the
    // plan wrote it, never restated by a reader that would then be free to disagree with it.
    direction: state.metric?.direction ?? null,
    constraints,
    admissible: reasons.length === 0,
    why: reasons.length === 0 ? null : reasons.join('; '),
    ...(state.matrix === undefined ? {} : { cases: [...new Set(state.matrix.slots.map(slot => slot.caseId))].sort().map(caseId => {
      const slots = state.matrix!.slots.flatMap((slot, index) => slot.caseId === caseId ? [index] : [])
      const results = observed.filter(entry => slots.includes(entry.slot))
      return { caseId, familyId: state.matrix!.slots[slots[0]!]!.familyId, quality: weighted(slots),
        planned: slots.length, observed: results.length, cost: results.length === slots.length ? costOf(results) : null,
        guardsMet: results.some(t => t.guardsMet === false) ? false
          : results.length === slots.length && results.every(t => t.guardsMet === true) ? true : null }
    }), families: [...new Set(state.matrix.slots.map(slot => slot.familyId))].sort().map(familyId => {
      const slots = state.matrix!.slots.flatMap((slot, index) => slot.familyId === familyId ? [index] : [])
      return { familyId, quality: weighted(slots), planned: slots.length, observed: observed.filter(entry => slots.includes(entry.slot)).length }
    }) }),
  }
}

/**
 * The measurement settings two evaluations must share to be comparable: everything the plan froze
 * except the two revisions being compared — and except the run, whose *context* stands in its place.
 *
 * The run identity is deliberately not here. If it were, only candidates measured inside one run
 * could be pooled, so no candidate could be measured in its own bubble; the isolation manifest a
 * bubble declares (model, tool digests, conditions) exists to make exactly that comparison honest,
 * so the caliber carries that manifest's digest and lets two runs be comparable.
 */
export interface Caliber {
  /** `contextDigestOf` of the run's bubble: the model, the tool digests, the conditions, the inputs. */
  readonly context: string
  readonly metric: EvaluationMetric
  readonly weights: EvaluationWeights
  readonly trials: number
  readonly judgement: readonly VerifierCriterion[]
}

/**
 * The caliber of one evaluation, or `undefined` when no plan was opened under that id.
 *
 * `undefined` is comparable with nothing: two unopened evaluations are not "equal" because both
 * digests are missing, and a caller that pools on `digestA === digestB` alone pools them.
 */
export function caliberOf(state: EvaluationState): Caliber | undefined {
  const { context, metric, weights, trials, judgement } = state
  if (context === undefined || metric === undefined || weights === undefined || trials === undefined || judgement === undefined) return undefined
  return { context: state.matrix === undefined ? context : digestOf(state.matrix), metric, weights, trials, judgement }
}

/**
 * The caliber's content digest. Two evaluations are comparable exactly when both digests are
 * defined and equal; a measurement that does not exist shares its settings with nothing.
 */
export function caliberDigestOf(state: EvaluationState): string | undefined {
  const caliber = caliberOf(state)
  return caliber === undefined ? undefined : digestOf(caliber)
}
