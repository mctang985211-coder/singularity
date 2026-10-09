/**
 * `strategy@1` — the explicit round: a plan frozen in one fact, and a submission gate that is a
 * refusal rather than a sentence in a prompt.
 *
 * The previous system derived the round from the number of history entries and the candidate index
 * (`review.md` R01: `historyFactsOf` used the candidate index as the round; `decision` used the
 * history entry count). Two consequences, both measured there: the annealed edit budget annealed
 * against a number that moved whenever a candidate was re-measured, and two candidates of one round
 * could be drafted against different incumbents and still be compared. So a round here **carries its
 * own number**, its common incumbent, its slot count, its reserved exploration slots, its annealed
 * budget, the log position its history is frozen at, and the metric and weights it is measured
 * under. `round/opened` is one-shot: a round that later needs a different cutoff is a different
 * round, and it gets a different subject.
 *
 * What the reducer decides, on the round's own subject, and therefore inside the serial region that
 * produces the fact:
 *
 * 1. **A submission after the close is refused.** A candidate that arrives after the decision would
 *    otherwise be measured against an incumbent nobody re-elected.
 * 2. **A slot outside `[0, candidates)` is refused**, and a slot that already holds a submission is
 *    refused with `evidence-conflict` — one slot holds one candidate, so "which candidate is slot 2"
 *    has one answer.
 * 3. **The annealed budget is real.** More structural edits than `editBudget` is `budget-exhausted`,
 *    the whole point of the budget being frozen in the opening fact.
 * 4. **A reserved exploration slot is a slot, not advice.** The last `explorationSlots` slots are
 *    reserved, and a submission that does not declare `exploratory: true` may not occupy one. RRSI
 *    re-checks this against the diff after the critic (`loop.py:523-530`); the previous port kept
 *    the prompt sentence and dropped the check.
 * 5. **A decision covers every submitted slot with a named reason.** An outcome for a slot nobody
 *    submitted is refused too: otherwise a hand-made decision could elect a candidate that does not
 *    exist. `winner` is an admitted slot or `null`, and `null` means the incumbent stands.
 *
 * `edits` are the identity of the structural change (`asset` + `target`), not a line count: they are
 * what novelty counts and what a duplicate check can decide. Payloads are closed; a repeated
 * `(asset, target)` inside one submission is refused rather than de-duplicated, so a caller cannot
 * pad a budget check with the same edit twice.
 *
 * @module singularity-core/strategy/protocol
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { digest, record, text } from '../task/shape.ts'
import type { Outcome } from './decision.ts'

export const STRATEGY_PROTOCOL = 'strategy'
export const STRATEGY_VERSION = 1

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

/** The one decision a round may carry. `winner: null` means no candidate was admitted. */
export interface RoundDecisionRecord {
  readonly winner: number | null
  readonly outcomes: readonly Outcome[]
  readonly decidedBy: string
  readonly at: string
}

/**
 * What `round/opened` froze. Present exactly when the opening fact was recorded, so a reader that
 * has a plan has a round number, a cutoff and a budget that no later fact can move.
 */
export interface RoundPlan {
  readonly round: number
  /** The one comparison the whole round is drafted against. */
  readonly incumbent: RevisionRef
  /** m slots, `0..m-1`. */
  readonly candidates: number
  /** How many of the last slots are reserved for exploration. */
  readonly explorationSlots: number
  /** Structural edits a candidate may declare, annealed from `round`. */
  readonly editBudget: number
  /** The frozen log position: this round reads only facts below it (`review.md` R03). */
  readonly historyCutoff: number
  readonly metric: { readonly unit: string; readonly direction: 'higher' | 'lower' }
  readonly weights: { readonly quality: number; readonly cost: number }
}

/** The folded state of one round. `subject` in every envelope is this round's id. */
export interface RoundState {
  readonly roundId: string
  readonly plan?: RoundPlan
  readonly openedBy?: string
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

const REVISION_MEMBERS = ['environmentId', 'revisionId', 'digest'] as const
const METRIC_MEMBERS = ['unit', 'direction'] as const
const WEIGHTS_MEMBERS = ['quality', 'cost'] as const
const EDIT_MEMBERS = ['asset', 'target'] as const
const OUTCOME_MEMBERS = ['slot', 'admitted', 'reason'] as const

/** A non-negative integer. Absent, fractional, negative and non-numeric are all refusals. */
function count(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    refuse('malformed-payload', `${where}.${key} must be an integer >= 0, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`)
  return value
}

function revisionRef(raw: unknown, where: string): RevisionRef {
  const source = record(raw, where)
  assertClosedKeys(source, REVISION_MEMBERS, where)
  return {
    environmentId: text(source, 'environmentId', where),
    revisionId: text(source, 'revisionId', where),
    digest: digest(source, 'digest', where),
  }
}

/**
 * The structural edits of one submission: each an identity, none repeated.
 *
 * A repeat is refused rather than de-duplicated, exactly as a decomposition refuses a repeated
 * name: a caller that lists one edit twice would otherwise pass a budget check it did not earn, and
 * a reader could not tell "one change named twice" from "two changes".
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

/** Two revision references name the same content. An id alone is not enough: it can be re-pointed. */
export function sameRevision(left: RevisionRef, right: RevisionRef): boolean {
  return left.environmentId === right.environmentId && left.revisionId === right.revisionId && left.digest === right.digest
}

/** The plan a round must have to accept a submission or a decision, or a refusal naming why not. */
export function requirePlan(state: RoundState, where: string): RoundPlan {
  const plan = state.plan
  if (plan === undefined)
    refuse('illegal-transition', `${where} reached round "${state.roundId}", which has no opening fact: a slot count, a budget and a frozen cutoff cannot be inferred after the fact`)
  return plan
}

function openedPayload(raw: unknown, where: string): RoundPlan {
  const source = record(raw, where)
  assertClosedKeys(
    source,
    ['round', 'incumbent', 'candidates', 'explorationSlots', 'editBudget', 'historyCutoff', 'metric', 'weights'],
    where,
  )
  const round = count(source, 'round', where)
  if (round < 1) refuse('malformed-payload', `${where}.round must be an integer >= 1, got ${round}; round numbering is explicit, never a count of history entries`)
  const candidates = count(source, 'candidates', where)
  if (candidates < 1) refuse('malformed-payload', `${where}.candidates must be at least 1, got ${candidates}: a round with no slot has no candidate to decide`)
  const explorationSlots = count(source, 'explorationSlots', where)
  if (explorationSlots > candidates)
    refuse(
      'malformed-payload',
      `${where}.explorationSlots is ${explorationSlots} of ${candidates} slots; a reservation cannot exceed the plan it reserves from`,
    )
  const editBudget = count(source, 'editBudget', where)
  const historyCutoff = count(source, 'historyCutoff', where)

  const metric = record(source['metric'], `${where}.metric`)
  assertClosedKeys(metric, METRIC_MEMBERS, `${where}.metric`)
  const direction = metric['direction']
  if (direction !== 'higher' && direction !== 'lower')
    refuse('malformed-payload', `${where}.metric.direction must be "higher" or "lower", got ${JSON.stringify(direction ?? null)}`)

  const weights = record(source['weights'], `${where}.weights`)
  assertClosedKeys(weights, WEIGHTS_MEMBERS, `${where}.weights`)
  const quality = weights['quality']
  const cost = weights['cost']
  for (const [key, value] of [['quality', quality], ['cost', cost]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      refuse('malformed-payload', `${where}.weights.${key} must be a finite number >= 0, got ${JSON.stringify(value ?? null)}`)
  }
  if (quality === 0)
    refuse('malformed-payload', `${where}.weights.quality is 0: a round that weights quality at nothing cannot prefer a better candidate to a worse one`)

  return {
    round,
    incumbent: revisionRef(source['incumbent'], `${where}.incumbent`),
    candidates,
    explorationSlots,
    editBudget,
    historyCutoff,
    metric: { unit: text(metric, 'unit', `${where}.metric`), direction },
    weights: { quality: quality as number, cost: cost as number },
  }
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

function decidedPayload(raw: unknown, where: string): { winner: number | null; outcomes: readonly Outcome[] } {
  const source = record(raw, where)
  assertClosedKeys(source, ['winner', 'outcomes'], where)
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
  return { winner, outcomes }
}

/**
 * Declare `strategy@1`. Call once at load. Nothing here reads another slice: the measure views and
 * the frozen history arrive as inputs to the projection and to the command boundary.
 */
export function declareStrategyProtocol(registry: ProtocolRegistry): void {
  registry.declare<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, {
    initialState: { roundId: '', submissions: [] },
    kinds: {
      [STRATEGY_KINDS.roundOpened]: defineKind<RoundState, RoundPlan>({
        guarantees: APPENDED,
        emitter: STRATEGY_ROLE,
        parse: (raw, where) => openedPayload(raw, where),
        reduce: (state, envelope, payload) => {
          if (state.plan !== undefined)
            refuse(
              'illegal-transition',
              `${STRATEGY_KINDS.roundOpened} #${envelope.seq} opens round ${payload.round} on "${envelope.subject}", which already opened round ${state.plan.round} at ${state.openedAt ?? 'an unrecorded time'}; a different incumbent, cutoff or budget is a different round, and it gets a different subject`,
            )
          return {
            roundId: envelope.subject,
            plan: payload,
            openedBy: envelope.actor,
            openedAt: envelope.at,
            submissions: [],
          }
        },
      }),

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
              `${where} offers slot ${payload.slot} again: ${occupied.actor} already submitted revision "${occupied.revision.revisionId}" there at ${occupied.at}; one slot holds one candidate`,
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

      [STRATEGY_KINDS.roundDecided]: defineKind<RoundState, { winner: number | null; outcomes: readonly Outcome[] }>({
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

          const submitted = state.submissions.map(entry => entry.slot).sort((left, right) => left - right)
          const named = payload.outcomes.map(outcome => outcome.slot)
          const repeated = named.filter((slot, index) => named.indexOf(slot) !== index)
          if (repeated.length > 0)
            refuse(
              'illegal-transition',
              `${where} closes slot ${repeated[0]} out twice; each submitted slot has one disposition`,
            )
          const missing = submitted.filter(slot => !named.includes(slot))
          if (missing.length > 0)
            refuse(
              'illegal-transition',
              `${where} decides round ${plan.round} without an outcome for submitted slot${missing.length === 1 ? '' : 's'} ${missing.join(', ')}; every submitted slot is closed out with a named reason, and an unaccounted slot is how a round's trajectory goes missing`,
            )
          const invented = named.filter(slot => !submitted.includes(slot))
          if (invented.length > 0)
            refuse(
              'illegal-transition',
              `${where} carries an outcome for slot${invented.length === 1 ? '' : 's'} ${invented.join(', ')}, which round ${plan.round} has no submission for; an outcome is about a candidate that was submitted`,
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
            decision: { winner: payload.winner, outcomes: payload.outcomes, decidedBy: envelope.actor, at: envelope.at },
          }
        },
      }),
    },
  })
}
