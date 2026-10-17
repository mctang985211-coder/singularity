/**
 * The round projection: what the frozen plan plus the measure slice's projections add up to, and
 * then the one call into the decision layer.
 *
 * The properties that carry this file, each a measured defect of the previous system:
 *
 * 1. **The gain is frozen, not recomputed.** Each candidate's gain is computed against the round's
 *    own `incumbent` and the aggregate that incumbent had **below the round's `historyCutoff`**,
 *    never against today's head: `review.md` R03 measured B's Δ moving from +0.2 to 0 and A's from 0
 *    to −0.2 when B was published.
 * 2. **Pooling needs one caliber.** Two candidates whose frozen calibers differ answered different
 *    questions, so only candidates matching the round's caliber enter the ranking.
 * 3. **A violated hard constraint is not for sale.** `constraintsMet` and `inadmissible` are filled
 *    here from the measure projection's own `constraints` — `null` (not yet checked) is not `true` —
 *    and they drop a candidate **before** any argmax. An incomplete measurement is inadmissible too,
 *    with its missing slots named (R06: `quality` from one observation is not a score).
 * 4. **The incumbent's own quality is a floor, and its band is the round's calibration.** `select`
 *    cannot enforce upstream's `S' >= S* - delta` (`rrsi/selection.py:107`), because `S*` is not one
 *    of its inputs: the floor lives here, and the reason names the band's source (R06).
 * 5. **"Better" is decided once, here, in the measurement's own direction.** Under `lower` (an error
 *    rate) the *smaller* measurement is the better candidate, and the argmax, the floor and the gain
 *    all follow that one orientation. The direction is not the round's to declare: the plan froze a
 *    caliber, a caliber contains the metric, and the metric is the measurement's — so the pooled
 *    candidates answer one direction by construction. (While the plan declared one too, a round
 *    saying `higher` over measurements saying `lower` elected the **worse** candidate and nothing
 *    compared the two.) It is normalised **once**, into the one space where more is better, not
 *    threaded into each comparison: `select` is frozen with no direction parameter (§11), and
 *    readers get the metric's own numbers in `SlotView.quality` and the reason strings.
 *
 * Every declared slot gets a decision and a reason, admitted or not, and `winner: null` means the
 * incumbent stands. A round opened with `historyCutoff: 0` on a fresh log has nothing below its
 * cutoff, so no slot has a frozen gain and the round can only retain the incumbent.
 *
 * @module singularity-core/strategy/view
 */

import type { EvaluationView } from '../measure/view.ts'
import type { Envelope } from '../protocol/envelope.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { sameRevision } from '../task/shape.ts'
import {
  noveltyOf,
  select,
  type Calibration,
  type Candidate,
  type History,
  type Measurement,
  type Outcome,
} from './decision.ts'
import { requirePlan, type RoundPlan } from './plan.ts'
import { CALIBRATION_MEMBERS, readCalibration, type CandidateSubmission, type RoundState, type StructuralEdit } from './protocol.ts'
import { publishedAssetsBelow } from './published-assets.ts'

/**
 * One evaluation as `src/measure/**` projects it (`docs/phase-cd-design.md` §5.4) — including the
 * measurement's own `direction` — plus the members this slice needs to *anchor* it: the evaluation
 * id, the two revisions, and the caliber digest §5.4 derives separately. The revisions are required
 * because the caliber excludes them: equal calibers alone do not say the two candidates were drafted
 * against **this round's** incumbent (R03).
 */
export interface RoundEvaluation extends EvaluationView {
  readonly evaluationId: string
  /**
   * The digest of the frozen measurement settings: the execution context's content — the run's
   * declared model, tool digests, conditions and inputs — plus the metric, the weights, the trial
   * plan and the judgement. The run's *identity* is deliberately not in it: two candidates may be
   * measured in two bubbles and still be answers to the same question (`measure@3`).
   */
  readonly caliberDigest: string
  readonly baseline: RevisionRef
  readonly candidate: RevisionRef
}

/**
 * The measure slice as one round reads it: the evaluations, the incumbent's own aggregate below a
 * cutoff, and the log both were read from.
 *
 * The two reads are functions of the round's own `historyCutoff`: `projectRound` passes the cutoff
 * out of the round's opening fact, so substituting today's head for the frozen position means
 * changing this file, not a caller's habit. `entries` is that same fixed log, and what counts as
 * *accepted* in it comes from `publishedAssetsBelow` — one owner of the definition, not a second
 * convention injected here (E1: two conventions mean two histories, and every reader of a slot's
 * novelty conditions on a different past).
 */
export interface MeasureSlice {
  /** Every fact at the cut this slice was taken at. The round's cutoff is what narrows it. */
  readonly entries: readonly Envelope[]
  readonly evaluationOf: (evaluationId: string) => RoundEvaluation | undefined
  /** The incumbent's own frozen aggregate from facts below `cutoff`; `null` = never measured there. */
  readonly incumbentBelow: (revision: RevisionRef, cutoff: number) => FrozenAggregate | null
}

/** What a previously measured candidate left behind: the other side of a frozen gain. */
export interface FrozenAggregate {
  readonly quality: number
  readonly cost: number | null
}


/** One submitted slot, decided: the aggregate it rests on, its caliber, its gain, its disposition. */
export interface SlotView {
  readonly slot: number
  readonly evaluationId: string

  /** The pooled caliber digest, or `null` when this slot's measurement is not there yet. */
  readonly caliberDigest: string | null
  readonly quality: number | null
  readonly cost: number | null
  readonly denominator: number | null
  readonly missingTrials: EvaluationView['missing']
  /**
   * The frozen gain: how much **better** this candidate measured than the incumbent, or `null` when
   * either side is not measurable. One convention — positive is an improvement — because the cost
   * rule *reads* it. `quality` above is the metric's own raw number; this one is not.
   */
  readonly gain: number | null
  /** Relative cost change against the frozen incumbent; `null` when it cannot be calculated. */
  readonly costGain: number | null
  /** Structural asset classes of this candidate that were never accepted before (R05). */
  readonly novelty: number
  /** Every hard constraint this evaluation judged is met. `false` is never compensable, so such a
   *  candidate is dropped before any aggregate is compared; filled from the projection's `constraints`. */
  readonly constraintsMet: boolean
  readonly admissible: boolean
  /** Why this slot was not admitted; `null` exactly when it was. */
  readonly reason: string | null
}

/** The whole round as one reader sees it: the frozen plan, every slot and the selection. */
export interface RoundDecision {
  readonly roundId: string
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: number

  readonly historyCutoff: number
  /** The noise basis the selection was made against, with its source (`measured` / `declared`). */
  readonly calibration: Calibration
  /** The round's frozen caliber: the measurement settings every pooled candidate answers (§5.4). */
  readonly caliber: string
  /** One view per submission, in slot order; `outcomes` covers the whole plan. */
  readonly slots: readonly SlotView[]
  readonly winner: number | null
  readonly outcomes: readonly Outcome[]
  /** Whether this projection read the round's committed decision; an open round is a preview. */
  readonly decided: boolean
}

/** One slot between "read the measurement" and "pool it": the reason, the gain and the reading. */
interface PlannedSlot {
  readonly submission: CandidateSubmission
  readonly evaluation: RoundEvaluation | undefined
  readonly reason: string | null
  readonly gain: number | null
  readonly costGain: number | null
  readonly constraintsMet: boolean
  /** The measurement in the round's one space, normalised where its own direction is in hand. */
  readonly measurement: Measurement | null
}

/** The structural asset classes one submission touches, de-duplicated: novelty counts types. */
function assetsOf(edits: readonly StructuralEdit[]): readonly string[] {
  return [...new Set(edits.map(edit => edit.asset))].sort()
}

function describeRevision(revision: RevisionRef): string {
  return `${revision.environmentId}/${revision.revisionId}@${revision.digest.slice(0, 12)}…`
}

/**
 * Which way the measurement at hand goes, or `null` when the view states no usable one — the one
 * place a direction is read, and an unusable member becomes an absence rather than a default of
 * `higher` (turning "nobody said" into an orientation is the defect this file exists to remove).
 */
function directionOf(evaluation: RoundEvaluation): 'higher' | 'lower' | null {
  const direction: unknown = evaluation.direction
  return direction === 'higher' || direction === 'lower' ? direction : null
}

/** The one orientation of a round: `+1` when a larger measurement is better, `-1` when a smaller one is. */
function directionSign(direction: 'higher' | 'lower'): number {
  return direction === 'lower' ? -1 : 1
}

/** A measurement in the one space every comparison in this round uses: more is better. */
function better(quality: number, direction: 'higher' | 'lower'): number {
  return directionSign(direction) * quality
}

/**
 * Why one measured slot is not admissible, or `null` when it is.
 *
 * The order is the order of the questions a reader asks: is this measurement about this candidate
 * (the anchors), does it answer the question this round froze (its caliber, which carries the
 * direction), can that direction be read, did a hard constraint fail, is it complete, is there a
 * frozen baseline, does it clear the incumbent's floor, and — least specific — does the measure
 * slice refuse it for a reason only it can see.
 */
function inadmissibleReason(
  evaluation: RoundEvaluation,
  submission: CandidateSubmission,
  plan: RoundPlan,
  incumbentAggregate: FrozenAggregate | null,
  calibration: Calibration,
): string | null {
  if (!sameRevision(evaluation.baseline, plan.incumbent))
    return `measured against ${describeRevision(evaluation.baseline)}, not round ${plan.round}'s incumbent ${describeRevision(plan.incumbent)}; its gain is not this round's gain — re-measure it against the incumbent, or propose it in a round whose incumbent it was measured against`
  if (!sameRevision(evaluation.candidate, submission.revision))
    return `measured on ${describeRevision(evaluation.candidate)}, but slot ${submission.slot} offers ${describeRevision(submission.revision)}; the observation is about a different candidate — submit the evaluation of the revision this slot offers`
  if (evaluation.caliberDigest !== plan.caliber)
    return `measured under caliber ${evaluation.caliberDigest.slice(0, 12)}… but round ${plan.round} pools only ${plan.caliber.slice(0, 12)}…; candidate excluded. ${evaluation.missing.map(entry => entry.reason).join('; ')} Re-measure under the frozen caliber; the incumbent stands unless another admissible candidate wins.`
  // A number whose orientation is unstated is not a reading of anything: the round cannot say which
  // candidate is better, so it refuses rather than defaulting to one of the two directions.
  const direction = directionOf(evaluation)
  if (direction === null)
    return `evaluation "${evaluation.evaluationId}" does not declare a usable direction for its measurement (${JSON.stringify(evaluation.direction ?? null)}); which way a better number goes is part of the measurement, not of this round, so a number whose orientation is unstated cannot be ranked — measure the candidate under a plan whose metric this log holds`
  const violated = evaluation.constraints.filter(constraint => constraint.met === false)
  if (violated.length > 0)
    return `violates hard constraint${violated.length === 1 ? '' : 's'} ${violated
      .map(constraint => `"${constraint.criterionId}"`)
      .join(', ')}; no aggregate buys a violated constraint, so this candidate does not enter the comparison — change the candidate, not the weights`
  const unchecked = evaluation.constraints.filter(constraint => constraint.met === null)
  if (unchecked.length > 0)
    return `hard constraint${unchecked.length === 1 ? '' : 's'} ${unchecked
      .map(constraint => `"${constraint.criterionId}"`)
      .join(', ')} ${unchecked.length === 1 ? 'has' : 'have'} not been checked yet; an unchecked constraint is not a met one, so this candidate is not admissible before its judgement is recorded`
  if (evaluation.missing.length > 0 || evaluation.observed !== evaluation.denominator)
    return `the measurement is incomplete: ${evaluation.observed} of ${evaluation.denominator} planned trials observed, ${
      evaluation.missing.length === 0
        ? `${evaluation.denominator - evaluation.observed} unreported`
        : `missing ${evaluation.missing.map(entry => `slot ${entry.slot} (${entry.reason})`).join(', ')}`
    }; the denominator keeps the plan's trials (R06), so this aggregate is not this candidate's score — finish the trials or record them as missed`
  if (incumbentAggregate === null)
    return `the incumbent ${describeRevision(plan.incumbent)} has no aggregate below the round's frozen history cutoff, so this candidate has no frozen gain to place against the noise floor; measure the incumbent first, or this round can only retain it`
  // Upstream's floor, which `select` cannot apply because `S*` is not one of its inputs: a candidate
  // more than the band below the round's incumbent is not a candidate, however cheap it is. Both
  // sides are compared in the measurement's direction, and the reason reports the metric's raw
  // numbers, so a reader needs no sign convention. The threshold is the incumbent with the band
  // applied *against* the direction — less under `higher`, plus under `lower` — which is the number
  // the comparison below actually used.
  const sign = directionSign(direction)
  const threshold = incumbentAggregate.quality - sign * calibration.floor
  if (sign * evaluation.quality < sign * incumbentAggregate.quality - calibration.floor) {
    const worse = direction === 'lower' ? 'above' : 'below'
    return `quality ${evaluation.quality.toFixed(4)} sits ${Math.abs(evaluation.quality - threshold).toFixed(4)} ${worse} the admissible floor ${threshold.toFixed(4)} (round ${plan.round}'s incumbent ${incumbentAggregate.quality.toFixed(4)} ${direction === 'lower' ? 'plus' : 'less'} the ${calibration.source} noise band ${calibration.floor.toFixed(4)}); a cost saving does not buy a quality ${worse} the floor, so this candidate does not enter the comparison — improve it, or propose it in a round whose incumbent it can clear`
  }
  // Last, because it is the least specific: the round's own reading of the constraints, the trials
  // and the floor names what it can see itself, and this fallback carries a refusal only the measure
  // slice could know (a broken trial identity, an unbound input, a retired implementation).
  if (!evaluation.admissible)
    return `the measure slice refuses it: ${evaluation.why ?? 'no reason recorded, which is itself a reason not to pool it'}`
  return null
}

function plannedOf(
  submission: CandidateSubmission,
  slice: MeasureSlice,
  plan: RoundPlan,
  incumbentAggregate: FrozenAggregate | null,
  calibration: Calibration,
): PlannedSlot {
  const evaluation = slice.evaluationOf(submission.evaluationId)
  if (evaluation === undefined)
    return { submission, evaluation, reason: null, gain: null, costGain: null, constraintsMet: false, measurement: null }
  const frozenCostGain =
    incumbentAggregate === null || evaluation.cost === null || incumbentAggregate.cost === null || incumbentAggregate.cost === 0
      ? null
      : (evaluation.cost - incumbentAggregate.cost) / incumbentAggregate.cost
  const direction = directionOf(evaluation)
  return {
    submission,
    evaluation,
    reason: inadmissibleReason(evaluation, submission, plan, incumbentAggregate, calibration),
    // The one normalisation: the frozen gain the cost rule reads is a gain in the measurement's
    // direction. A view that states none was given its reason above and gets no signed number.
    gain: direction === null || incumbentAggregate === null ? null : better(evaluation.quality, direction) - better(incumbentAggregate.quality, direction),
    costGain: frozenCostGain,
    constraintsMet: evaluation.constraints.every(constraint => constraint.met === true),
    measurement:
      direction === null
        ? null
        : { quality: better(evaluation.quality, direction), cost: evaluation.cost, denominator: evaluation.denominator, missing: evaluation.missing.length },
  }
}

function slotViewOf(planned: PlannedSlot, history: History): SlotView {
  const { submission, evaluation, reason } = planned
  const novelty = noveltyOf(assetsOf(submission.edits), history)
  if (evaluation === undefined)
    return {
      slot: submission.slot,
      evaluationId: submission.evaluationId,
      caliberDigest: null,
      quality: null,
      cost: null,
      denominator: null,
      missingTrials: [],
      gain: null,
      costGain: null,
      novelty,
      constraintsMet: false,
      admissible: false,
      reason: reason ?? `no evaluation "${submission.evaluationId}" is in this log, so slot ${submission.slot} has no aggregate to compare; measure the candidate and record its evaluation first`,
    }
  return {
    slot: submission.slot,
    evaluationId: submission.evaluationId,
    caliberDigest: evaluation.caliberDigest,
    quality: evaluation.quality,
    cost: evaluation.cost,
    denominator: evaluation.denominator,
    missingTrials: evaluation.missing,
    gain: planned.gain,
    costGain: planned.costGain,
    novelty,
    constraintsMet: planned.constraintsMet,
    admissible: reason === null,
    reason,
  }
}

/**
 * Pool the round's slots or refuse, project each slot, and let `select` decide.
 *
 * `history.acceptedAssets` and the incumbent's aggregate come from **below the round's cutoff**, and
 * the cutoff is the round's own; the only way to read a later fact here would be to change this
 * function.
 *
 * A round that carries a decision is reported **from the record**: `decideRound` recomputed this very
 * projection against its own cut and refused to commit a decision that disagreed, so the record is
 * the decision's own recompute, done once where the store could check it. Reading the slice again
 * here would let a fact that arrived after the decision — or a caller's different calibration —
 * flip what a closed round is read as saying. An open round has no record and is a preview,
 * labelled as one.
 */
export function projectRound(state: RoundState, slice: MeasureSlice, calibration: Calibration): RoundDecision {
  const plan = requirePlan(state, `project round "${state.roundId}"`)
  // One definition of "a band must name its provenance", shared with the payload that records it.
  readCalibration(calibration, 'the noise basis', CALIBRATION_MEMBERS)

  const incumbentAggregate = slice.incumbentBelow(plan.incumbent, plan.historyCutoff)
  const acceptedAssets = publishedAssetsBelow(slice.entries, plan.incumbent.environmentId, plan.historyCutoff)
  const submissions = [...state.submissions].sort((left, right) => left.slot - right.slot)

  const planned = submissions.map(submission => plannedOf(submission, slice, plan, incumbentAggregate, calibration))

  // The gains the decision layer sees are the frozen ones — one entry per slot whose two sides were
  // both measurable. A gain that cannot be computed is absent rather than invented as 0.
  const history: History = {
    acceptedAssets,
    deltas: planned
      .filter(entry => entry.gain !== null)
      .map(entry => ({ slot: entry.submission.slot, deltaQuality: entry.gain as number, deltaCost: entry.costGain })),
  }

  const slots = planned.map(entry => slotViewOf(entry, history))
  // Every *declared* slot is closed out, whether or not it was offered a candidate: a slot nobody
  // submitted to is untested, and its outcome says so in words instead of leaving the round's
  // trajectory one slot short (R01). `select` judges it like any other inadmissible slot, so it is
  // never admitted and therefore never the winner.
  const candidates: Candidate[] = Array.from({ length: plan.candidates }, (_, slot): Candidate => {
    const entry = planned.find(item => item.submission.slot === slot)
    if (entry === undefined)
      return { slot, assets: [], measurement: null, constraintsMet: false, inadmissible: 'no candidate was submitted to this slot' }
    return {
      slot,
      assets: assetsOf(entry.submission.edits),
      // The argmax compares in the measurement's direction: a lower error rate enters as the larger
      // number, so `select` needs no direction of its own.
      measurement: entry.measurement,
      constraintsMet: entry.constraintsMet,
      inadmissible: entry.reason,
    }
  })

  const selection = select(candidates, history, calibration, plan.weights)

  // A closed round is read from its record, which the commit region verified against this very
  // projection at its own cut. The slice above is a display of the slots as they read today; the
  // decision is the fact, and a caller's calibration names a band, not the one the decision used.
  const decided = state.decision
  return {
    roundId: state.roundId,
    round: plan.round,
    incumbent: plan.incumbent,
    candidates: plan.candidates,
    historyCutoff: plan.historyCutoff,
    calibration: decided === undefined ? calibration : decided.calibration,
    caliber: plan.caliber,
    slots,
    decided: decided !== undefined,
    winner: decided === undefined ? selection.winner : decided.winner,
    outcomes: decided === undefined ? selection.outcomes : decided.outcomes,
  }
}
