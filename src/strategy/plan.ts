/**
 * The frozen plan of a round: the one fact that fixes what a round is measured under.
 *
 * The plan is one fact rather than a member on each kind because every part of it must be decided
 * **once, before any candidate exists**: the common incumbent, the slot count, the reserved
 * exploration slots, the annealed budget, the frozen history cutoff, the weights — and the
 * **caliber**, the digest of the measurement settings the round pools under.
 *
 * Why the caliber is here and not only on the evaluations. Two candidates may be compared only if
 * they answer the same question (`docs/phase-cd-design.md` §5.4: equal `caliberDigestOf`). While the
 * round had no caliber of its own, the only comparability check possible was *between* the
 * candidates at hand, so a single submission measured under different weights and judgement was
 * pooled with whatever else arrived, and nothing exposed it until a *second* candidate happened to
 * differ — which is a coincidence, not a check. A round now names the question it asks; a submission
 * that answers a different one is refused a place in the ranking, by name.
 *
 * Why this module exists. This is the `round/opened` kind, its payload reader and its reducer, split
 * out exactly as `task/decomposition.ts` holds the decomposition kind: the runtime dependency runs
 * one way — `protocol.ts` imports this module for the kind, and this module imports only *types*
 * from `protocol.ts` — so there is no import cycle to reason about, and the file budget is met by
 * responsibility rather than by shaving the reasoning out of the comments.
 *
 * @module singularity-core/strategy/plan
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { digest, record, text } from '../task/shape.ts'
import type { RoundState } from './protocol.ts'

/**
 * What `round/opened` froze. Present exactly when the opening fact was recorded, so a reader that
 * has a plan has a round number, a cutoff, a budget and a caliber that no later fact can move.
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
  /** The frozen log position: this round reads only facts below it (R03). */
  readonly historyCutoff: number
  /**
   * The measurement settings every pooled candidate must have been measured under (§5.4).
   *
   * The **direction** is one of them, and it is the measurement's: the caliber contains the metric,
   * so a round pools only numbers that agree on which way is better. A plan-level direction was a
   * second declaration, read by every comparison and compared to the measurement's by nothing — a
   * round could rank in `higher` while its measurements said `lower` and elect the worse candidate.
   */
  readonly caliber: string
  readonly weights: { readonly quality: number; readonly cost: number }
}

const APPENDED = { appended: true } as const
const REVISION_MEMBERS = ['environmentId', 'revisionId', 'digest'] as const
const WEIGHTS_MEMBERS = ['quality', 'cost'] as const
const OPENED_MEMBERS = ['round', 'incumbent', 'candidates', 'explorationSlots', 'editBudget', 'historyCutoff', 'caliber', 'weights'] as const

/** A non-negative integer. Absent, fractional, negative and non-numeric are all refusals. */
export function count(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    refuse('malformed-payload', `${where}.${key} must be an integer >= 0, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`)
  return value
}

/** The revision a pin names. The digest is read too: an id alone can be re-pointed. */
export function revisionRef(raw: unknown, where: string): RevisionRef {
  const source = record(raw, where)
  assertClosedKeys(source, REVISION_MEMBERS, where)
  return {
    environmentId: text(source, 'environmentId', where),
    revisionId: text(source, 'revisionId', where),
    digest: digest(source, 'digest', where),
  }
}

/** The plan a round must have to accept a submission or a decision, or a refusal naming why not. */
export function requirePlan(state: RoundState, where: string): RoundPlan {
  const plan = state.plan
  if (plan === undefined)
    refuse('illegal-transition', `${where} reached round "${state.roundId}", which has no opening fact: a slot count, a budget, a frozen cutoff and a caliber cannot be inferred after the fact`)
  return plan
}

function openedPayload(raw: unknown, where: string): RoundPlan {
  const source = record(raw, where)
  assertClosedKeys(source, OPENED_MEMBERS, where)
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

  const weights = record(source['weights'], `${where}.weights`)
  assertClosedKeys(weights, WEIGHTS_MEMBERS, `${where}.weights`)
  const quality = weights['quality']
  const cost = weights['cost']
  for (const [key, value] of [['quality', quality], ['cost', cost]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      refuse('malformed-payload', `${where}.weights.${key} must be a finite number >= 0, got ${JSON.stringify(value ?? null)}`)
  }
  if (quality === 0)
    refuse('malformed-payload', `${where}.weights.quality is 0: a round weighting quality at nothing cannot prefer a better candidate to a worse one`)

  return {
    round,
    incumbent: revisionRef(source['incumbent'], `${where}.incumbent`),
    candidates,
    explorationSlots,
    editBudget: count(source, 'editBudget', where),
    historyCutoff: count(source, 'historyCutoff', where),
    caliber: digest(source, 'caliber', `${where}.caliber`),
    weights: { quality: quality as number, cost: cost as number },
  }
}

/**
 * The `round/opened` rule.
 *
 * One-shot: a round that later needs a different incumbent, cutoff, budget or caliber is a different
 * round, and the whole point of freezing them in one fact is that no later fact can move them. The
 * direction is not here because it is not the round's to freeze: it comes with the measurement the
 * round pools, and the caliber is what makes every pooled measurement agree on it.
 */
export function openedKind(kind: string, emitter: string): KindRule<RoundState> {
  return defineKind<RoundState, RoundPlan>({
    guarantees: APPENDED,
    emitter,
    parse: (raw, where) => openedPayload(raw, where),
    reduce: (state, envelope, payload) => {
      if (state.plan !== undefined)
        refuse(
          'illegal-transition',
          `${kind} #${envelope.seq} opens round ${payload.round} on "${envelope.subject}", which already opened round ${state.plan.round} at ${state.openedAt ?? 'an unrecorded time'}; a different incumbent, cutoff, budget or caliber is a different round, and it gets a different subject`,
        )
      return {
        roundId: envelope.subject,
        plan: payload,
        openedAt: envelope.at,
        submissions: [],
      }
    },
  })
}
