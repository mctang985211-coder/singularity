import type { ControlReadCut, ControlSessionStore } from '../control/session-store.ts'
import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { sameRevision } from '../task/shape.ts'
import { type Calibration } from './decision.ts'
import {
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_VERSION,
  type RoundState,
  type StructuralEdit,
} from './protocol.ts'
import { projectRound, type MeasureSlice, type RoundDecision } from './view.ts'

export interface OpenRoundInput {
  readonly campaignId: string
  readonly commandId: string
  readonly roundId: string
  /** The explicit round number (`review.md` R01). Never derived from history or candidate index. */
  readonly round: number
  readonly incumbent: RevisionRef
  readonly productionHead?: string
  readonly candidates: number

  readonly historyCutoff: number
  /** The digest of the measurement settings every pooled candidate must have been measured under. */
  readonly caliber: string
  readonly weights: { readonly quality: number; readonly cost: number }
}

/** One candidate, offered for one slot of one round. */
export interface SubmitCandidateInput {
  readonly commandId: string
  readonly roundId: string
  readonly slot: number
  readonly revision: RevisionRef
  readonly evaluationId: string
  readonly edits: readonly StructuralEdit[]

}

export interface DecideRoundInput {
  readonly commandId: string
  readonly roundId: string
}

export interface StrategyCommandOptions {
  readonly store: ControlSessionStore
  /** The noise basis this deployment decides against, with its provenance (`measured`/`declared`). */
  readonly calibration: Calibration
  /**
   * The measure slice's projections at one committed cut. A function of the cut, not a value, so a
   * check reads the same cut the fact it guards will be appended to.
   */
  readonly measuresAt: (cut: ControlReadCut) => MeasureSlice
}

export interface StrategyCommands {
  openRound(input: OpenRoundInput): Promise<Envelope>
  submitCandidate(input: SubmitCandidateInput): Promise<Envelope>
  decideRound(input: DecideRoundInput): Promise<Envelope>
}

export function createStrategyCommands(options: StrategyCommandOptions): StrategyCommands {
  return {
    openRound: input =>
      emitRaw(
        options,
        input.commandId,
        STRATEGY_KINDS.roundOpened,
        input.roundId,
        {
          campaignId: input.campaignId,
          round: input.round,
          incumbent: input.incumbent,
          ...(input.productionHead === undefined ? {} : { productionHead: input.productionHead }),
          candidates: input.candidates,
          historyCutoff: input.historyCutoff,
          caliber: input.caliber,
          weights: input.weights,
        },
        () => {
          for (const [subject, state] of options.store.load().statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION)) {
            if (subject === input.roundId || state.plan === undefined) continue
            if (state.plan.campaignId !== input.campaignId || state.plan.round !== input.round) continue
            refuse(
              'illegal-transition',
              `cannot open round ${input.round} as "${input.roundId}": round "${subject}" already carries that number (opened at ${state.openedAt ?? 'an unrecorded time'}, history cutoff ${state.plan.historyCutoff}); two rounds with one number would freeze two different histories under one identity`,
            )
          }
          const rounds = [...options.store.load().statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
            .filter(state => state.plan?.campaignId === input.campaignId && state.roundId !== input.roundId)
          const previous = rounds.sort((a, b) => b.plan!.round - a.plan!.round)[0]
          if (previous !== undefined) {
            if (previous.decision === undefined) refuse('illegal-transition', 'settle the current search round before advancing its head')
            if (previous.plan!.caliber !== input.caliber) refuse('caliber-mismatch', 'a campaign cannot change its frozen suite or execution caliber')
            const selected = previous.submissions.find(candidate => candidate.slot === previous.decision!.winner)?.revision ?? previous.plan!.incumbent
            if (!sameRevision(selected, input.incumbent)) refuse('evidence-input-mismatch', 'round incumbent must be the preceding accepted search head')
            if (input.round !== previous.plan!.round + 1) refuse('illegal-transition', 'campaign round numbers must advance by one')
          }
        },
      ),

    submitCandidate: input =>
      emitRaw(
        options,
        input.commandId,
        STRATEGY_KINDS.candidateSubmitted,
        input.roundId,
        {
          slot: input.slot,
          revision: input.revision,
          evaluationId: input.evaluationId,
          edits: input.edits,
          },
        () => {
          const cut = options.store.load()
          // The reducer names a submission to a round that was never opened; the anchor below is
          // about a real round, so it stays out of the way of that refusal.
          const round = cut.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)
          if (round?.plan === undefined) return
          const evaluation = options.measuresAt(cut).evaluationOf(input.evaluationId)
          // An evaluation that is not in the log yet is not a lie: measurement takes time, and the
          // projection reports the slot as unmeasured with its own reason. An evaluation that *is*
          // in the log and is about another revision is a mismatch, and the score it produced can
          // never belong to the candidate this slot offers.
          if (evaluation === undefined) return
          if (!sameRevision(evaluation.candidate, input.revision))
            refuse(
              'evidence-input-mismatch',
              `slot ${input.slot} offers revision "${input.revision.revisionId}" but evaluation "${input.evaluationId}" measured "${evaluation.candidate.revisionId}" (${evaluation.candidate.digest.slice(0, 12)}…); the observation is about a different candidate, so record the evaluation of the revision this slot offers or offer the revision that was measured`,
            )
        },
      ),

    decideRound: input => {
      const at = options.store.load()
      const state = at.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)
      if (state === undefined)
        refuse('illegal-transition', `round "${input.roundId}" was never opened in this log, so there is nothing to decide`)
      const payload = decisionPayload(projectRound(state, options.measuresAt(at), options.calibration))
      return emitRaw(options, input.commandId, STRATEGY_KINDS.roundDecided, input.roundId, payload, () => {
        const now = options.store.load()
        const current = now.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)
        if (current === undefined)
          refuse('illegal-transition', `round "${input.roundId}" is not in the log this decision would be appended to`)
        const recomputed = decisionPayload(projectRound(current, options.measuresAt(now), options.calibration))
        if (digestOf(recomputed) !== digestOf(payload))
          refuse(
            'illegal-transition',
            `round "${input.roundId}" changed between composing this decision and committing it: the decision closes out slots [${payload.outcomes
              .map(outcome => outcome.slot)
              .join(', ')}] with winner ${describeWinner(payload.winner)}, while the facts now imply slots [${recomputed.outcomes
              .map(outcome => outcome.slot)
              .join(', ')}] with winner ${describeWinner(recomputed.winner)}; recompute the decision against the current cut and submit it under a new command id`,
          )
      })
    },
  }
}

/**
 * The frozen member set of `round/decided`: a slot number and a reason per candidate, plus the noise
 * basis the selection was made against — the band that was actually used, not one looked up again.
 */
function decisionPayload(decision: RoundDecision): { winner: number | null; outcomes: RoundDecision['outcomes']; calibration: RoundDecision['calibration'] } {
  return { winner: decision.winner, outcomes: decision.outcomes, calibration: decision.calibration }
}

function describeWinner(winner: number | null): string {
  return winner === null ? 'none (the incumbent stands)' : `slot ${winner}`
}

/**
 * Produce one fact, with its cross-subject preconditions handed to the append path.
 *
 * They are not run immediately before the call, because command identity has to be decided first: a
 * re-delivered command was already decided, and deciding it again against a state that has moved on
 * would turn "give me back the result I lost" into a refusal.
 */
async function emitRaw(
  options: StrategyCommandOptions,
  commandId: string,
  kind: string,
  subject: string,
  payload: unknown,
  require?: () => void,
): Promise<Envelope> {
  return options.store.emit({ commandId, protocol: STRATEGY_PROTOCOL, version: STRATEGY_VERSION, kind, subject, payload }, require) as Promise<Envelope>
}
