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
 *
 * Every submitted slot gets a decision and a reason, admitted or not. `winner: null` means nothing
 * was admitted and the incumbent stands.
 *
 * @module singularity-core/strategy/view
 */

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
import { requirePlan, sameRevision, type CandidateSubmission, type RoundState, type StructuralEdit } from './protocol.ts'

/** One trial slot the measure slice reports as having no observation, with its own reason. */
export interface MissingTrial {
  readonly slot: number
  readonly reason: string
}

/** One hard constraint's state. `null` = not checked yet, which is not the same as met. */
export interface CaliberConstraint {
  readonly criterionId: string
  readonly met: boolean | null
}

/**
 * One evaluation as `src/measure/**` projects it (`docs/phase-cd-design.md` §5.4), plus the members
 * this slice needs to *anchor* it: the evaluation id, the two revisions, and the caliber digest §5.4
 * derives separately.
 *
 * The two revisions are required because the caliber deliberately excludes them (§5.4): equal
 * calibers alone do not say the two candidates were drafted against **this round's** incumbent, and
 * a gain measured against a different baseline is not this round's gain (`review.md` R03).
 */
export interface RoundEvaluation {
  readonly evaluationId: string
  /** The digest of the frozen measurement settings: run, metric, weights, trials, judgement. */
  readonly caliberDigest: string
  readonly baseline: RevisionRef
  readonly candidate: RevisionRef
  /** `trials` from the evaluation's plan — the denominator, not the number of observations. */
  readonly denominator: number
  readonly observed: number
  readonly missing: readonly MissingTrial[]
  /** `sum(observed quality) / denominator`: a missing trial counts 0 and the denominator stays. */
  readonly quality: number
  /** `null` = unknown, which is not 0. */
  readonly cost: number | null
  readonly constraints: readonly CaliberConstraint[]
  readonly admissible: boolean
  /** The measure projection's own named reason when it says the evaluation is inadmissible. */
  readonly why: string | null
}

/**
 * The measure slice as one round reads it.
 *
 * The three reads are functions, and the two historical ones take the round's own `historyCutoff` as
 * an argument: `projectRound` passes the cutoff out of the round's opening fact, so substituting
 * today's head for the frozen position means changing this file, not a caller's habit.
 */
export interface MeasureSlice {
  readonly evaluationOf: (evaluationId: string) => RoundEvaluation | undefined
  /** The incumbent's own frozen aggregate from facts below `cutoff`; `null` = never measured there. */
  readonly incumbentBelow: (revision: RevisionRef, cutoff: number) => FrozenAggregate | null
  /** Asset classes actually published below `cutoff`; novelty is counted against these (R05). */
  readonly acceptedAssetsBelow: (cutoff: number) => readonly string[]
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
  readonly missingTrials: readonly MissingTrial[]
  /** `quality − the incumbent's frozen quality`, or `null` when either side is not measurable. */
  readonly gain: number | null
  readonly costGain: number | null
  /** Structural asset classes of this candidate that were never accepted before (R05). */
  readonly novelty: number
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
  readonly noise: Calibration
  /** The one caliber every measured slot shares; `null` when nothing is measured yet. */
  readonly caliberDigest: string | null
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
}

/** The structural asset classes one submission touches, de-duplicated: novelty counts types. */
function assetsOf(edits: readonly StructuralEdit[]): readonly string[] {
  return [...new Set(edits.map(edit => edit.asset))].sort()
}

function describeRevision(revision: RevisionRef): string {
  return `${revision.environmentId}/${revision.revisionId}@${revision.digest.slice(0, 12)}…`
}

/** A noise basis is a number and its provenance; either half being wrong makes the band fiction. */
function assertCalibration(calibration: Calibration): void {
  if (!Number.isFinite(calibration.floor) || calibration.floor < 0)
    refuse('malformed-payload', `the noise floor must be a finite number >= 0, got ${JSON.stringify(calibration.floor)}`)
  if (calibration.source !== 'measured' && calibration.source !== 'declared')
    refuse(
      'malformed-payload',
      `the noise floor's source must be "measured" or "declared", got ${JSON.stringify(calibration.source)}; a band whose provenance is unknown cannot be told from a declared floor (R06)`,
    )
}

/**
 * Why one measured slot is not admissible, or `null` when it is.
 *
 * The order is the order of the questions a reader asks: is this measurement even about this
 * candidate (the two anchors), did the measure slice itself refuse it, did a hard constraint fail,
 * is it complete, and is there a frozen baseline to make its gain a gain at all.
 */
function inadmissibleReason(
  evaluation: RoundEvaluation,
  submission: CandidateSubmission,
  incumbent: RevisionRef,
  incumbentAggregate: FrozenAggregate | null,
  round: number,
): string | null {
  if (!sameRevision(evaluation.baseline, incumbent))
    return `measured against ${describeRevision(evaluation.baseline)}, not round ${round}'s incumbent ${describeRevision(incumbent)}; its gain is not this round's gain — re-measure it against the incumbent, or propose it in a round whose incumbent it was measured against`
  if (!sameRevision(evaluation.candidate, submission.revision))
    return `measured on ${describeRevision(evaluation.candidate)}, but slot ${submission.slot} offers ${describeRevision(submission.revision)}; the observation is about a different candidate — submit the evaluation of the revision this slot offers`
  if (!evaluation.admissible)
    return `the measure slice refuses it: ${evaluation.why ?? 'no reason recorded, which is itself a reason not to pool it'}`
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
    return `the incumbent ${describeRevision(incumbent)} has no aggregate below the round's frozen history cutoff, so this candidate has no frozen gain to place against the noise floor; measure the incumbent first, or this round can only retain it`
  return null
}

function plannedOf(
  submission: CandidateSubmission,
  slice: MeasureSlice,
  plan: { incumbent: RevisionRef; round: number; historyCutoff: number },
  incumbentAggregate: FrozenAggregate | null,
): PlannedSlot {
  const evaluation = slice.evaluationOf(submission.evaluationId)
  if (evaluation === undefined) return { submission, evaluation, reason: null, gain: null, costGain: null }
  const frozenCostGain =
    incumbentAggregate === null || evaluation.cost === null || incumbentAggregate.cost === null
      ? null
      : evaluation.cost - incumbentAggregate.cost
  return {
    submission,
    evaluation,
    reason: inadmissibleReason(evaluation, submission, plan.incumbent, incumbentAggregate, plan.round),
    gain: incumbentAggregate === null ? null : evaluation.quality - incumbentAggregate.quality,
    costGain: frozenCostGain,
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
 */
export function projectRound(state: RoundState, slice: MeasureSlice, calibration: Calibration): RoundDecision {
  const plan = requirePlan(state, `project round "${state.roundId}"`)
  assertCalibration(calibration)

  const incumbentAggregate = slice.incumbentBelow(plan.incumbent, plan.historyCutoff)
  const acceptedAssets = slice.acceptedAssetsBelow(plan.historyCutoff)
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

  const planned = submissions.map(submission => plannedOf(submission, slice, plan, incumbentAggregate))

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
      constraintsMet: slot.admissible,
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
    noise: calibration,
    caliberDigest: pooled.length === 1 ? (pooled[0] as string) : null,
    slots,
    winner: selection.winner,
    outcomes: selection.outcomes,
  }
}
