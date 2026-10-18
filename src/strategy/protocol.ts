import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type MemberSet, type ProtocolRegistry } from '../protocol/registry.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { record, revisionRef, REVISION_MEMBERS, text } from '../task/shape.ts'
import type { Calibration, Outcome } from './decision.ts'
import { count, openedKind, requirePlan, type RoundPlan } from './plan.ts'

/**
 * The plan's shape is declared in `plan.ts` beside the reader that enforces it, and published here
 * because `RoundState.plan` is this module's member: one definition, two import paths.
 */
export type { RoundPlan } from './plan.ts'

export const STRATEGY_PROTOCOL = 'strategy'
export const STRATEGY_VERSION = 9

/** The trusted role that freezes a round, receives its candidates and closes it. */
export const STRATEGY_ROLE = 'strategy'

/** The structural asset classes a candidate may change. A value here has a real edit path. */
export type EditAsset = 'workflow' | 'skill' | 'tool' | 'template'
const EDIT_ASSETS: readonly string[] = ['workflow', 'skill', 'tool', 'template']

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
export const CALIBRATION_MEMBERS = ['floor', 'source'] as const
const SUBMISSION_MEMBERS = ['slot', 'revision', 'evaluationId', 'edits'] as const
const DECIDED_MEMBERS = ['winner', 'outcomes', 'calibration'] as const

/**
 * A noise basis, read from where it is written: `round/decided.calibration`.
 *
 * Exported because the projection reads the same value from a caller as well as from a fact, and the
 * rule that a band cannot be anonymous — `measured` and `declared` floors are different claims (R06)
 * — has one definition rather than two.
 */
export function readCalibration(raw: unknown, where: string, members: MemberSet): Calibration {
  const source = record(raw, where)
  assertClosedKeys(source, members, where)
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
function editList(raw: unknown, where: string, members: MemberSet): readonly StructuralEdit[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of {asset, target}, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, members, at)
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

function submissionPayload(raw: unknown, where: string, nested: { readonly edits: MemberSet; readonly revision: MemberSet }): Submission {
  const source = record(raw, where)
  return {
    slot: count(source, 'slot', where),
    // Handed the declaration, so `nested.revision` is what closes the pin rather than the reader's own
    // default: one constant, the same one `plan.ts` declares for its incumbent.
    revision: revisionRef(source['revision'], `${where}.revision`, nested.revision),
    evaluationId: text(source, 'evaluationId', where),
    edits: editList(source['edits'], `${where}.edits`, nested.edits),
  }
}

type Decided = { winner: number | null; outcomes: readonly Outcome[]; calibration: Calibration }

function decidedPayload(raw: unknown, where: string, nested: { readonly outcomes: MemberSet; readonly calibration: MemberSet }): Decided {
  const source = record(raw, where)
  const winner = source['winner']
  if (winner !== null && (typeof winner !== 'number' || !Number.isInteger(winner) || winner < 0))
    refuse('malformed-payload', `${where}.winner must be a slot number or null, got ${winner === undefined ? 'nothing' : JSON.stringify(winner)}`)
  const rawOutcomes = source['outcomes']
  if (!Array.isArray(rawOutcomes))
    refuse('malformed-payload', `${where}.outcomes must be an array of {slot, admitted, reason}, got ${rawOutcomes === null ? 'null' : typeof rawOutcomes}`)
  const outcomes = rawOutcomes.map((entry, index): Outcome => {
    const at = `${where}.outcomes[${index}]`
    const outcome = record(entry, at)
    assertClosedKeys(outcome, nested.outcomes, at)
    const admitted = outcome['admitted']
    if (typeof admitted !== 'boolean')
      refuse('malformed-payload', `${at}.admitted must be true or false, got ${admitted === undefined ? 'nothing' : JSON.stringify(admitted)}`)
    // A reason is required for every slot, admitted or not: "no reason recorded" is how a slot went
    // unaccounted for in the previous system.
    return { slot: count(outcome, 'slot', at), admitted, reason: text(outcome, 'reason', at) }
  })
  // The band is required, not optional: a decision whose basis has to be inferred from the reasons
  // is the sentence-instead-of-a-guarantee this member exists to remove.
  return { winner, outcomes, calibration: readCalibration(source['calibration'], `${where}.calibration`, nested.calibration) }
}

/**
 * Declare `strategy@6`. Call once at load. Nothing here reads another slice: the measure views and
 * the frozen history arrive as inputs to the projection and to the command boundary.
 */
export function declareStrategyProtocol(registry: ProtocolRegistry): void {
  registry.declare<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, {
    initialState: { roundId: '', submissions: [] },
    kinds: {
      [STRATEGY_KINDS.roundOpened]: openedKind(STRATEGY_KINDS.roundOpened, STRATEGY_ROLE),

      [STRATEGY_KINDS.candidateSubmitted]: defineKind<RoundState, Submission, { edits: MemberSet; revision: MemberSet }>({
        guarantees: APPENDED,
        members: SUBMISSION_MEMBERS,
        // `edits[]` and `revision` are closed by their own readers, each handed the set named here:
        // `revisionRef` is the one revision reader, so this entry is what closes the pin.
        nested: { edits: EDIT_MEMBERS, revision: REVISION_MEMBERS },
        emitter: STRATEGY_ROLE,
        parse: (raw, where, nested) => submissionPayload(raw, where, nested),
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
          return {
            ...state,
            submissions: [
              ...state.submissions,
              {
                slot: payload.slot,
                revision: payload.revision,
                evaluationId: payload.evaluationId,
                edits: payload.edits,
                actor: envelope.actor,
                at: envelope.at,
              },
            ],
          }
        },
      }),

      [STRATEGY_KINDS.roundDecided]: defineKind<RoundState, Decided, { outcomes: MemberSet; calibration: MemberSet }>({
        guarantees: APPENDED,
        members: DECIDED_MEMBERS,
        // Each `outcomes[]` entry and the `calibration` record are closed below with these sets.
        nested: { outcomes: OUTCOME_MEMBERS, calibration: CALIBRATION_MEMBERS },
        emitter: STRATEGY_ROLE,
        parse: (raw, where, nested) => decidedPayload(raw, where, nested),
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
