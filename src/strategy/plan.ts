import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { digest, record, text, maybeText, revisionRef, REVISION_MEMBERS } from '../task/shape.ts'
import type { RoundState } from './protocol.ts'

/**
 * What `round/opened` froze. Present exactly when the opening fact was recorded, so a reader that
 * has a plan has a round number, a cutoff, a budget and a caliber that no later fact can move.
 */
export interface RoundPlan {
  readonly campaignId: string
  readonly round: number
  /** The one comparison the whole round is drafted against. */
  readonly incumbent: RevisionRef
  readonly productionHead?: string
  /** m slots, `0..m-1`. */
  readonly candidates: number
  /** The frozen log position: this round reads only facts below it (R03). */
  readonly historyCutoff: number
  readonly caliber: string
  readonly weights: { readonly quality: number; readonly cost: number }
}

const APPENDED = { appended: true } as const
const WEIGHTS_MEMBERS = ['quality', 'cost'] as const
const OPENED_MEMBERS = ['campaignId', 'round', 'incumbent', 'productionHead', 'candidates', 'historyCutoff', 'caliber', 'weights'] as const

/** A non-negative integer. Absent, fractional, negative and non-numeric are all refusals. */
export function count(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    refuse('malformed-payload', `${where}.${key} must be an integer >= 0, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`)
  return value
}

/** The plan a round must have to accept a submission or a decision, or a refusal naming why not. */
export function requirePlan(state: RoundState, where: string): RoundPlan {
  const plan = state.plan
  if (plan === undefined)
    refuse('illegal-transition', `${where} reached round "${state.roundId}", which has no opening fact: a slot count, a budget, a frozen cutoff and a caliber cannot be inferred after the fact`)
  return plan
}

function openedPayload(raw: unknown, where: string, nested: { readonly incumbent: MemberSet; readonly weights: MemberSet }): RoundPlan {
  const source = record(raw, where)
  const round = count(source, 'round', where)
  if (round < 1) refuse('malformed-payload', `${where}.round must be an integer >= 1, got ${round}; round numbering is explicit, never a count of history entries`)
  const candidates = count(source, 'candidates', where)
  if (candidates < 1) refuse('malformed-payload', `${where}.candidates must be at least 1, got ${candidates}: a round with no slot has no candidate to decide`)
  const weights = record(source['weights'], `${where}.weights`)
  assertClosedKeys(weights, nested.weights, `${where}.weights`)
  const quality = weights['quality']
  const cost = weights['cost']
  for (const [key, value] of [['quality', quality], ['cost', cost]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      refuse('malformed-payload', `${where}.weights.${key} must be a finite number >= 0, got ${JSON.stringify(value ?? null)}`)
  }
  if (quality === 0)
    refuse('malformed-payload', `${where}.weights.quality is 0: a round weighting quality at nothing cannot prefer a better candidate to a worse one`)

  return {
    ...(source['productionHead'] === undefined ? {} : { productionHead: maybeText(source, 'productionHead', where)! }),
    campaignId: text(source, 'campaignId', where),
    round,
    incumbent: revisionRef(source['incumbent'], `${where}.incumbent`, nested.incumbent),
    candidates,
    historyCutoff: count(source, 'historyCutoff', where),
    caliber: digest(source, 'caliber', `${where}.caliber`),
    weights: { quality: quality as number, cost: cost as number },
  }
}

export function openedKind(kind: string, emitter: string): KindRule<RoundState> {
  return defineKind<RoundState, RoundPlan, { incumbent: MemberSet; weights: MemberSet }>({
    guarantees: APPENDED,
    members: OPENED_MEMBERS,
    // The incumbent is a revision pin and the weights are a record; both are closed below, out of
    // this declaration, by the sets named here.
    nested: { incumbent: REVISION_MEMBERS, weights: WEIGHTS_MEMBERS },
    emitter,
    parse: (raw, where, nested) => openedPayload(raw, where, nested),
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
