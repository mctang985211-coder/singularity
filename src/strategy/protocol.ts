/**
 * `strategy@4` — the explicit round: a plan frozen in one fact, a submission gate that is a refusal
 * rather than a sentence in a prompt, and a decision that carries the basis it was made on.
 *
 * The previous system derived the round from the number of history entries and the candidate index
 * (`review.md` R01: `historyFactsOf` used the candidate index as the round; `decision` used the
 * history entry count). So the annealed budget annealed against a number that moved whenever a
 * candidate was re-measured, and two candidates of one round could be drafted against different
 * incumbents and still be compared. A round here **carries its own number**, its common incumbent,
 * its slot count, its reserved exploration slots, its annealed budget, the log position its history
 * is frozen at, the caliber it pools under, and the metric and weights it is measured under.
 *
 * What the reducer decides, on the round's own subject, and therefore inside the serial region that
 * produces the fact:
 *
 * 1. **A submission after the close is refused.** A candidate that arrives after the decision was
 *    otherwise measured against an incumbent nobody re-elected.
 * 2. **A slot outside `[0, candidates)` is refused**, and a slot that already holds one is refused
 *    with `evidence-conflict`: one slot, one candidate.
 * 3. **The annealed budget is real**: more structural edits than `editBudget` is `budget-exhausted`.
 * 4. **A reserved exploration slot is a slot, not advice.** The last `explorationSlots` slots are
 *    reserved, and a submission that does not declare `exploratory: true` may not occupy one. RRSI
 *    re-checks this against the diff after the critic (`loop.py:523-530`); the previous port kept the
 *    prompt sentence and dropped the check.
 * 5. **A decision covers every declared slot with a named reason**, and carries the **noise basis**
 *    it was made against. The coverage is the plan's `[0, candidates)`, not the submitted subset: a
 *    slot nobody submitted to is untested, and `admitted: false` with a reason that names it says so
 *    instead of leaving the slot out of the round's trajectory (R01). Such a slot can never be
 *    admitted, so a hand-made decision cannot elect a candidate that does not exist. `winner` is an
 *    admitted slot or `null`, and `null` means the incumbent stands.
 *
 * `edits` are the identity of the structural change (`asset` + `target`), not a line count: they are
 * what novelty counts and what a duplicate check can decide. A repeated `(asset, target)` inside one
 * submission is refused rather than de-duplicated, so a caller cannot pad a budget check.
 *
 * **Version 2** adds two required members in one bump, because both close a way a fact could not be
 * replayed from:
 *
 * - `round/opened.caliber`: the digest of the measurement settings the round pools under. Without
 *   it, comparability could only be checked *between* the submissions at hand, so one submission
 *   measured under other weights was pooled with whatever else arrived and nothing exposed it until
 *   a second candidate happened to differ.
 * - `round/decided.calibration`: the noise floor and its source (`measured` / `declared`), which
 *   `review.md` R07 requires the selection fact to retain. Until now the band survived only as prose
 *   inside the outcome reasons — a guarantee dressed as a sentence, which is the thing this rebuild
 *   exists to remove.
 *
 * Version 1 facts are refused by name with no compatibility layer, as every other bump in this stack
 * is: there is nothing to migrate, and inventing a default caliber or a default band would be
 * inventing the very facts the members exist to record.
 *
 * **Version 3** moves the **accepted language** of a decision, not its shape. A `round/decided` must
 * now account for every slot the round declared; version 2 accepted one that accounted only for the
 * slots somebody had submitted to, so a declared slot nobody offered a candidate to appeared in no
 * outcome and in no reason at all — `review.md` R01's sentence was false exactly there. The members
 * (`winner`, `outcomes`, `calibration`), the kind set and the reducers' other rules are unchanged:
 * what moved is which decisions count as complete, and a complete decision is what a replay of the
 * round's trajectory rests on. Version 2 facts are refused **by name** — `version-mismatch`, from
 * the same gate as version 1 — with no compatibility layer: the trajectory v2 left out cannot be
 * recovered from the fact, and reading its absence as "untested" would invent the very reason this
 * rule exists to record.
 *
 * **Version 4** removes `round/opened.metric.unit`. It was a required member no reader ever
 * consumed — the projection ranks on `metric.direction` and the round's own numbers, so the label
 * named a quantity nothing compared. Removing a required member changes the accepted shape exactly
 * as adding one does, so version 3 facts, which carry `unit`, are refused **by name** from the same
 * gate as versions 1 and 2, with no compatibility layer: this build cannot frame that payload, and
 * reading it as a round without a unit would be the silent reinterpretation the closed shape is for.
 *
 * @module singularity-core/strategy/protocol
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { record, text } from '../task/shape.ts'
import type { Calibration, Outcome } from './decision.ts'
import { count, openedKind, requirePlan, revisionRef, type RoundPlan } from './plan.ts'

/**
 * The plan's shape is declared in `plan.ts` beside the reader that enforces it, and published here
 * because `RoundState.plan` is this module's member: one definition, two import paths.
 */
export type { RoundPlan } from './plan.ts'

export const STRATEGY_PROTOCOL = 'strategy'
/**
 * 4: `round/opened` no longer carries `metric.unit`, a required member with no reader, so a version 3
 * fact is refused by name instead of being re-read as a round without a unit. 3: a decision's accepted
 * language — it accounts for every declared slot, not only the submitted ones, so an old decision is
 * refused by name rather than re-read as a complete one. 2: `round/opened` gained a required
 * `caliber`, and `round/decided` a required `calibration`.
 */
export const STRATEGY_VERSION = 4

/** The trusted role that freezes a round, receives its candidates and closes it. */
export const STRATEGY_ROLE = 'strategy'

/** The structural asset classes a candidate may change. A value here has a real edit path. */
export type EditAsset = 'skill' | 'tool' | 'template'
const EDIT_ASSETS: readonly string[] = ['skill', 'tool', 'template']

/** One structural change, by the identity of what it touches. */
export interface StructuralEdit {
  readonly asset: EditAsset
  readonly target: string
}

/** One candidate as submitted: the claim, with the log's own emitter stamp. */
export interface CandidateSubmission {
  readonly slot: number
  readonly revision: RevisionRef
  readonly evaluationId: string
  readonly edits: readonly StructuralEdit[]
  readonly exploratory: boolean
  /** The identity the log stamped. Never what a caller asked for. */
  readonly actor: string
  readonly at: string
}

/** The one decision a round may carry; `winner: null` means none was admitted. */
export interface RoundDecisionRecord {
  readonly winner: number | null
  readonly outcomes: readonly Outcome[]
  /** The noise basis the selection was made against, so a replay can reconstruct the band (R07). */
  readonly calibration: Calibration
  readonly at: string
}

/** The folded state of one round. `subject` in every envelope is this round's id. */
export interface RoundState {
  readonly roundId: string
  readonly plan?: RoundPlan
  readonly openedAt?: string
  readonly submissions: readonly CandidateSubmission[]
  readonly decision?: RoundDecisionRecord
}

export const STRATEGY_KINDS = {
  roundOpened: 'round/opened',
  candidateSubmitted: 'candidate/submitted',
  roundDecided: 'round/decided',
} as const

const APPENDED = { appended: true } as const
const EDIT_MEMBERS = ['asset', 'target'] as const
const OUTCOME_MEMBERS = ['slot', 'admitted', 'reason'] as const
const CALIBRATION_MEMBERS = ['floor', 'source'] as const

/** Two revision references name the same content. An id alone is not enough: it can be re-pointed. */
export function sameRevision(left: RevisionRef, right: RevisionRef): boolean {
  return left.environmentId === right.environmentId && left.revisionId === right.revisionId && left.digest === right.digest
}

/**
 * A noise basis, read from where it is written: `round/decided.calibration`.
 *
 * Exported because the projection reads the same value from a caller as well as from a fact, and the
 * rule that a band cannot be anonymous — `measured` and `declared` floors are different claims (R06)
 * — has one definition rather than two.
 */
export function readCalibration(raw: unknown, where: string): Calibration {
  const source = record(raw, where)
  assertClosedKeys(source, CALIBRATION_MEMBERS, where)
  const floor = source['floor']
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0)
    refuse('malformed-payload', `${where}.floor must be a finite number >= 0, got ${JSON.stringify(floor ?? null)}`)
  const origin = source['source']
  if (origin !== 'measured' && origin !== 'declared')
    refuse(
      'malformed-payload',
      `${where}.source must be "measured" or "declared", got ${JSON.stringify(origin ?? null)}; a band whose provenance is unknown cannot be told from a declared floor (R06)`,
    )
  return { floor, source: origin }
}

/**
 * The structural edits of one submission: each an identity, none repeated.
 *
 * A repeat is refused rather than de-duplicated, exactly as a decomposition refuses a repeated name:
 * a caller listing one edit twice would otherwise pass a budget check it did not earn, and a reader
 * could not tell "one change named twice" from "two changes".
 */
function editList(raw: unknown, where: string): readonly StructuralEdit[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of {asset, target}, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, EDIT_MEMBERS, at)
    const asset = source['asset']
    if (typeof asset !== 'string' || !EDIT_ASSETS.includes(asset))
      refuse('malformed-payload', `${at}.asset must be one of ${EDIT_ASSETS.join(', ')}, got ${JSON.stringify(asset ?? null)}`)
    const target = text(source, 'target', at)
    const identity = `${asset}\u0000${target}`
    if (seen.has(identity)) refuse('malformed-payload', `${where} names the ${asset} edit of ${JSON.stringify(target)} twice; one submission names one structural change per target`)
    seen.add(identity)
    return { asset: asset as EditAsset, target }
  })
}

/** The submission payload, before the log stamps who submitted it. */
type Submission = Omit<CandidateSubmission, 'actor' | 'at'>

function submissionPayload(raw: unknown, where: string): Submission {
  const source = record(raw, where)
  assertClosedKeys(source, ['slot', 'revision', 'evaluationId', 'edits', 'exploratory'], where)
  const exploratory = source['exploratory']
  if (typeof exploratory !== 'boolean')
    refuse('malformed-payload', `${where}.exploratory must be true or false, got ${exploratory === undefined ? 'nothing' : JSON.stringify(exploratory)}; a reserved slot turns on this member and a missing one is not a false one`)
  return {
    slot: count(source, 'slot', where),
    revision: revisionRef(source['revision'], `${where}.revision`),
    evaluationId: text(source, 'evaluationId', where),
    edits: editList(source['edits'], `${where}.edits`),
    exploratory,
  }
}

type Decided = { winner: number | null; outcomes: readonly Outcome[]; calibration: Calibration }

function decidedPayload(raw: unknown, where: string): Decided {
  const source = record(raw, where)
  assertClosedKeys(source, ['winner', 'outcomes', 'calibration'], where)
  const winner = source['winner']
  if (winner !== null && (typeof winner !== 'number' || !Number.isInteger(winner) || winner < 0))
    refuse('malformed-payload', `${where}.winner must be a slot number or null, got ${winner === undefined ? 'nothing' : JSON.stringify(winner)}`)
  const rawOutcomes = source['outcomes']
  if (!Array.isArray(rawOutcomes))
    refuse('malformed-payload', `${where}.outcomes must be an array of {slot, admitted, reason}, got ${rawOutcomes === null ? 'null' : typeof rawOutcomes}`)
  const outcomes = rawOutcomes.map((entry, index): Outcome => {
    const at = `${where}.outcomes[${index}]`
    const outcome = record(entry, at)
    assertClosedKeys(outcome, OUTCOME_MEMBERS, at)
    const admitted = outcome['admitted']
    if (typeof admitted !== 'boolean')
      refuse('malformed-payload', `${at}.admitted must be true or false, got ${admitted === undefined ? 'nothing' : JSON.stringify(admitted)}`)
    // A reason is required for every slot, admitted or not: "no reason recorded" is how a slot went
    // unaccounted for in the previous system.
    return { slot: count(outcome, 'slot', at), admitted, reason: text(outcome, 'reason', at) }
  })
  // The band is required, not optional: a decision whose basis has to be inferred from the reasons
  // is the sentence-instead-of-a-guarantee this member exists to remove.
  return { winner, outcomes, calibration: readCalibration(source['calibration'], `${where}.calibration`) }
}

/**
 * Declare `strategy@4`. Call once at load. Nothing here reads another slice: the measure views and
 * the frozen history arrive as inputs to the projection and to the command boundary.
 */
export function declareStrategyProtocol(registry: ProtocolRegistry): void {
  registry.declare<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, {
    initialState: { roundId: '', submissions: [] },
    kinds: {
      [STRATEGY_KINDS.roundOpened]: openedKind(STRATEGY_KINDS.roundOpened, STRATEGY_ROLE),

      [STRATEGY_KINDS.candidateSubmitted]: defineKind<RoundState, Submission>({
        guarantees: APPENDED,
        emitter: STRATEGY_ROLE,
        parse: (raw, where) => submissionPayload(raw, where),
        reduce: (state, envelope, payload) => {
          const where = `${STRATEGY_KINDS.candidateSubmitted} #${envelope.seq}`
          const plan = requirePlan(state, where)
          if (state.decision !== undefined)
            refuse(
              'illegal-transition',
              `${where} offers slot ${payload.slot} after round ${plan.round} closed at ${state.decision.at}; a candidate that arrives after the decision was never compared against this round's incumbent`,
            )
          if (payload.slot >= plan.candidates)
            refuse(
              'illegal-transition',
              `${where} offers slot ${payload.slot}, but round ${plan.round} plans slots 0..${plan.candidates - 1} (${plan.candidates} candidates); a slot outside the plan has no place in the comparison`,
            )
          const occupied = state.submissions.find(entry => entry.slot === payload.slot)
          if (occupied !== undefined)
            refuse(
              'evidence-conflict',
              `${where} offers slot ${payload.slot} again: ${occupied.actor} submitted revision "${occupied.revision.revisionId}" there at ${occupied.at}; one slot holds one candidate`,
            )
          if (payload.edits.length > plan.editBudget)
            refuse(
              'budget-exhausted',
              `${where} declares ${payload.edits.length} structural edits, but round ${plan.round} anneals to a budget of ${plan.editBudget}; a wider change is a different round, not a wider submission`,
            )
          const reservedFrom = plan.candidates - plan.explorationSlots
          if (!payload.exploratory && payload.slot >= reservedFrom)
            refuse(
              'illegal-transition',
              `${where} puts a non-exploratory candidate in slot ${payload.slot}, which round ${plan.round} reserves for exploration (slots ${reservedFrom}..${plan.candidates - 1} are reserved); declare exploratory: true or take a slot below ${reservedFrom}`,
            )
          return {
            ...state,
            submissions: [
              ...state.submissions,
              {
                slot: payload.slot,
                revision: payload.revision,
                evaluationId: payload.evaluationId,
                edits: payload.edits,
                exploratory: payload.exploratory,
                actor: envelope.actor,
                at: envelope.at,
              },
            ],
          }
        },
      }),

      [STRATEGY_KINDS.roundDecided]: defineKind<RoundState, Decided>({
        guarantees: APPENDED,
        emitter: STRATEGY_ROLE,
        parse: (raw, where) => decidedPayload(raw, where),
        reduce: (state, envelope, payload) => {
          const where = `${STRATEGY_KINDS.roundDecided} #${envelope.seq}`
          const plan = requirePlan(state, where)
          if (state.decision !== undefined)
            refuse(
              'illegal-transition',
              `${where} decides round ${plan.round} again; it was decided at ${state.decision.at} with winner ${state.decision.winner === null ? 'none' : `slot ${state.decision.winner}`}`,
            )

          // Coverage is the plan's, not the submissions': a slot `round/opened` declared and nobody
          // submitted to still has a disposition, and "untested" is a fact with a reason rather than a
          // slot that appears in no reason at all (R01).
          const declared = Array.from({ length: plan.candidates }, (_, slot) => slot)
          const named = payload.outcomes.map(outcome => outcome.slot)
          const repeated = named.filter((slot, index) => named.indexOf(slot) !== index)
          if (repeated.length > 0)
            refuse('illegal-transition', `${where} closes slot ${repeated[0]} out twice; each declared slot has one disposition`)
          const missing = declared.filter(slot => !named.includes(slot))
          if (missing.length > 0)
            refuse(
              'illegal-transition',
              `${where} decides round ${plan.round} without an outcome for declared slot${missing.length === 1 ? '' : 's'} ${missing.join(', ')}; a decision covers every slot the round declared (0..${plan.candidates - 1}), and a slot nobody submitted to is untested rather than unaccounted for`,
            )
          const outside = named.filter(slot => slot >= plan.candidates)
          if (outside.length > 0)
            refuse(
              'illegal-transition',
              `${where} carries an outcome for slot${outside.length === 1 ? '' : 's'} ${outside.join(', ')}, which round ${plan.round} does not declare (slots 0..${plan.candidates - 1}); a decision covers the plan and nothing else`,
            )
          const submitted = state.submissions.map(entry => entry.slot)
          const unoffered = payload.outcomes.find(outcome => outcome.admitted && !submitted.includes(outcome.slot))
          if (unoffered !== undefined)
            refuse(
              'illegal-transition',
              `${where} closes slot ${unoffered.slot} out as admitted, but round ${plan.round} has no submission in that slot; a slot nobody submitted to is untested, and only a submitted slot can be a winner`,
            )

          if (payload.winner !== null) {
            const elected = payload.outcomes.find(outcome => outcome.slot === payload.winner)
            if (elected === undefined || !elected.admitted)
              refuse(
                'illegal-transition',
                `${where} elects slot ${payload.winner}, which it does not admit; a winner is an admitted slot or null, and null means the incumbent stands`,
              )
          }

          return {
            ...state,
            decision: {
              winner: payload.winner,
              outcomes: payload.outcomes,
              calibration: payload.calibration,
              at: envelope.at,
            },
          }
        },
      }),
    },
  })
}
