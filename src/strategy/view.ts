/**
 * The round projection: what the frozen plan plus the measure slice's projections add up to, and
 * then the one call into the decision layer.
 *
 * Three properties carry this file, and each is a measured defect of the previous system:
 *
 * 1. **The gain is frozen, not recomputed.** Each candidate's gain is computed against the round's
 *    own `incumbent` and the aggregate that incumbent had **below the round's `historyCutoff`** —
 *    never against today's head. `review.md` R03 measured what recomputing costs: with A=0.6 and
 *    B=0.8, B's Δ was +0.2 before B was published and 0 after it, and A's moved from 0 to −0.2.
 *    Attribution, pruning and stall detection then read a different history depending on when they
 *    ran. Here the cutoff comes from the round's own opening fact and from nowhere else.
 * 2. **Pooling needs one caliber.** Two candidates whose frozen calibers differ were measured under
 *    different questions, so their scores may not be compared: the projection refuses with
 *    `caliber-mismatch` and names the alternative (re-measure, or decide them in separate rounds).
 * 3. **A violated hard constraint is not for sale.** `constraintsMet` and `inadmissible` are filled
 *    here from the measure projection's own `constraints` — `null` (not yet checked) is not `true` —
 *    and they are the inputs the decision layer uses to drop a candidate **before** any argmax. An
 *    incomplete measurement is inadmissible too, with the missing trial slots named: `review.md`
 *    R06's counterexample reported `quality` from the one observation it had while quietly dropping
 *    the plan's denominator.
 * 4. **The incumbent's own quality is a floor, and its band is the round's calibration.** `select`
 *    cannot enforce upstream's `S' >= S* - delta` (`rrsi/selection.py:107`): `S*` is not one of its
 *    inputs, so a candidate far below the incumbent can still be admitted when its cost saving is
 *    large enough. The floor therefore lives here, with the band taken from the round's own
 *    `Calibration` — a `measured` floor and a `declared` one behave differently because the value is
 *    the band, and the source is named in the reason (R06). Quality is floored; `constraintsMet` is
 *    not: a below-floor candidate and an out-of-bounds one carry two different reasons.
 *
 * Every submitted slot gets a decision and a reason, admitted or not. `winner: null` means nothing
 * was admitted and the incumbent stands.
 *
 * One consequence a first reader will meet: a round opened with `historyCutoff: 0` on a fresh log has
 * nothing below its cutoff, so the incumbent has no frozen aggregate, every slot has no frozen gain,
 * and the round can only retain the incumbent. That is the correct reading of a frozen history — the
 * cutoff has to be the position after the incumbent's own measurement — not a broken round.
 *
 * @module singularity-core/strategy/view
 */

import type { EvaluationView } from '../measure/view.ts'
import type { Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { RevisionRef } from '../task/protocol.ts'
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
import { readCalibration, sameRevision, type CandidateSubmission, type RoundState, type StructuralEdit } from './protocol.ts'
import { publishedAssetsBelow } from './published-assets.ts'

/**
 * One evaluation as `src/measure/**` projects it (`docs/phase-cd-design.md` §5.4), plus the members
 * this slice needs to *anchor* it: the evaluation id, the two revisions, and the caliber digest §5.4
 * derives separately (`caliberDigestOf`).
 *
 * The two revisions are required because the caliber deliberately excludes them (§5.4): equal
 * calibers alone do not say the two candidates were drafted against **this round's** incumbent, and
 * a gain measured against a different baseline is not this round's gain (`review.md` R03).
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
 * *accepted* in it is derived from it by `publishedAssetsBelow` — one owner of the definition —
 * rather than injected here as a second one (E1: two wirings had invented two conventions, and
 * novelty feeds selection, so two conventions can produce two winners from one log).
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
  readonly exploratory: boolean
  /** The pooled caliber digest, or `null` when this slot's measurement is not there yet. */
  readonly caliberDigest: string | null
  readonly quality: number | null
  readonly cost: number | null
  readonly denominator: number | null
  readonly missingTrials: EvaluationView['missing']
  /** `quality − the incumbent's frozen quality`, or `null` when either side is not measurable. */
  readonly gain: number | null
  readonly costGain: number | null
  /** Structural asset classes of this candidate that were never accepted before (R05). */
  readonly novelty: number
  /**
   * Whether every hard constraint this evaluation judged is met. `false` is never compensable, so
   * the decision layer drops such a candidate before any aggregate is compared — and this is the
   * value that says so, filled from the measure projection's own `constraints` and not inferred from
   * the aggregate.
   */
  readonly constraintsMet: boolean
  readonly admissible: boolean
  /** Why this slot was not admitted; `null` exactly when it was. */
  readonly reason: string | null
}

/** The whole round as one reader sees it: the frozen plan, every slot, and the selection. */
export interface RoundDecision {
  readonly roundId: string
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: number
  readonly explorationSlots: number
  readonly editBudget: number
  readonly historyCutoff: number
  /** The noise basis the selection was made against, with its source (`measured` / `declared`). */
  readonly calibration: Calibration
  /** The round's frozen caliber: the measurement settings every pooled candidate answers (§5.4). */
  readonly caliber: string
  readonly slots: readonly SlotView[]
  readonly winner: number | null
  readonly outcomes: readonly Outcome[]
}

/** One slot between "read the measurement" and "pool it": the reason and the frozen gain. */
interface PlannedSlot {
  readonly submission: CandidateSubmission
  readonly evaluation: RoundEvaluation | undefined
  readonly reason: string | null
  readonly gain: number | null
  readonly costGain: number | null
  readonly constraintsMet: boolean
}

/** The structural asset classes one submission touches, de-duplicated: novelty counts types. */
function assetsOf(edits: readonly StructuralEdit[]): readonly string[] {
  return [...new Set(edits.map(edit => edit.asset))].sort()
}

function describeRevision(revision: RevisionRef): string {
  return `${revision.environmentId}/${revision.revisionId}@${revision.digest.slice(0, 12)}…`
}

/**
 * Why one measured slot is not admissible, or `null` when it is.
 *
 * The order is the order of the questions a reader asks: is this measurement even about this
 * candidate (the two anchors), does it answer the question this round froze (its caliber), did a hard
 * constraint fail, is the measurement complete, is there a frozen baseline to make its gain a gain at
 * all, does its quality clear the incumbent's floor, and — last, because it is the least specific —
 * does the measure slice refuse it for a reason only it can see.
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
    return `measured under caliber ${evaluation.caliberDigest.slice(0, 12)}… but round ${plan.round} pools only ${plan.caliber.slice(0, 12)}…; a score from another caliber answers a different question, so it is not this round's to rank — re-measure it under the round's caliber, or open a round that freezes this one`
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
  // more than the band below the round's incumbent is not a candidate, however cheap it is.
  const floor = incumbentAggregate.quality - calibration.floor
  if (evaluation.quality < floor)
    return `quality ${evaluation.quality.toFixed(4)} sits ${(floor - evaluation.quality).toFixed(4)} below the admissible floor ${floor.toFixed(4)} (round ${plan.round}'s incumbent ${incumbentAggregate.quality.toFixed(4)} less the ${calibration.source} noise band ${calibration.floor.toFixed(4)}); a cost saving below the floor is not a gain, so this candidate does not enter the comparison — improve it, or propose it in a round whose incumbent it can clear`
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
  // An unmeasured slot has met no constraint: absence of a judgement is not a passed one.
  if (evaluation === undefined) return { submission, evaluation, reason: null, gain: null, costGain: null, constraintsMet: false }
  const frozenCostGain =
    incumbentAggregate === null || evaluation.cost === null || incumbentAggregate.cost === null
      ? null
      : evaluation.cost - incumbentAggregate.cost
  return {
    submission,
    evaluation,
    reason: inadmissibleReason(evaluation, submission, plan, incumbentAggregate, calibration),
    gain: incumbentAggregate === null ? null : evaluation.quality - incumbentAggregate.quality,
    costGain: frozenCostGain,
    constraintsMet: evaluation.constraints.every(constraint => constraint.met === true),
  }
}

function measurementOf(slot: SlotView): Measurement | null {
  if (slot.quality === null || slot.denominator === null) return null
  return { quality: slot.quality, cost: slot.cost, denominator: slot.denominator, missing: slot.missingTrials.length }
}

function slotViewOf(planned: PlannedSlot, history: History): SlotView {
  const { submission, evaluation, reason } = planned
  const novelty = noveltyOf(assetsOf(submission.edits), history)
  if (evaluation === undefined)
    return {
      slot: submission.slot,
      evaluationId: submission.evaluationId,
      exploratory: submission.exploratory,
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
      reason: `no evaluation "${submission.evaluationId}" is in this log, so slot ${submission.slot} has no aggregate to compare; measure the candidate and record its evaluation first`,
    }
  return {
    slot: submission.slot,
    evaluationId: submission.evaluationId,
    exploratory: submission.exploratory,
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
 * function. The environment the accepted classes belong to is the incumbent's, out of the same
 * frozen plan.
 */
export function projectRound(state: RoundState, slice: MeasureSlice, calibration: Calibration): RoundDecision {
  const plan = requirePlan(state, `project round "${state.roundId}"`)
  // One definition of "a band must name its provenance", shared with the payload that records it.
  readCalibration(calibration, 'the noise basis')

  const incumbentAggregate = slice.incumbentBelow(plan.incumbent, plan.historyCutoff)
  const acceptedAssets = publishedAssetsBelow(slice.entries, plan.incumbent.environmentId, plan.historyCutoff)
  const submissions = [...state.submissions].sort((left, right) => left.slot - right.slot)

  // Comparability first: two calibers in one pool would be two questions averaged into one ranking.
  const measured = submissions
    .map(submission => ({ submission, evaluation: slice.evaluationOf(submission.evaluationId) }))
    .filter((entry): entry is { submission: CandidateSubmission; evaluation: RoundEvaluation } => entry.evaluation !== undefined)
  const pooled = [...new Set(measured.map(entry => entry.evaluation.caliberDigest))]
  const first = measured[0]
  const clash = measured.find(entry => entry.evaluation.caliberDigest !== first?.evaluation.caliberDigest)
  if (pooled.length > 1 && first !== undefined && clash !== undefined) {
    refuse(
      'caliber-mismatch',
      `round ${plan.round} pools ${pooled.length} calibers: slot ${first.submission.slot} (evaluation "${first.evaluation.evaluationId}") was measured under ${first.evaluation.caliberDigest.slice(0, 12)}… and slot ${clash.submission.slot} (evaluation "${clash.evaluation.evaluationId}") under ${clash.evaluation.caliberDigest.slice(0, 12)}…; scores from different calibers answer different questions, so they may not be ranked together — re-measure them under one caliber, or decide them in separate rounds`,
    )
  }

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
  const candidates: Candidate[] = slots.map(slot => {
    const edits = submissions.find(submission => submission.slot === slot.slot)?.edits ?? []
    return {
      slot: slot.slot,
      exploratory: slot.exploratory,
      assets: assetsOf(edits),
      measurement: measurementOf(slot),
      constraintsMet: slot.constraintsMet,
      inadmissible: slot.reason,
    }
  })

  const selection = select(candidates, history, calibration, plan.weights)

  return {
    roundId: state.roundId,
    round: plan.round,
    incumbent: plan.incumbent,
    candidates: plan.candidates,
    explorationSlots: plan.explorationSlots,
    editBudget: plan.editBudget,
    historyCutoff: plan.historyCutoff,
    calibration,
    caliber: plan.caliber,
    slots,
    winner: selection.winner,
    outcomes: selection.outcomes,
  }
}
