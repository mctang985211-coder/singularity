/**
 * The round command boundary: the acts that freeze a round, receive its candidates and close it.
 *
 * Two things are decided here rather than by a caller, and both are decided **inside the store's
 * commit region** — the `require` step of the append path, which reads the committed cut at the
 * moment the fact will be appended:
 *
 * 1. **The annealed edit budget.** `openRound` derives it from the round number and the deployment's
 *    annealing policy (`editBudgetFor`, `rounds-1` rather than `/T`, so the last round really does
 *    reach the minimum). A caller supplies no budget, and the value it produces is frozen in the
 *    opening fact. Deriving it from "how many history entries there are" — the previous system's
 *    round (`review.md` R01) — made the budget move whenever a candidate was re-measured.
 * 2. **The decision itself is recomputed against the facts it will be appended to.** A decision is
 *    composed from a projection at call time and then re-projected inside the region; if the two
 *    disagree the append is refused and the caller is told to recompute. Without that check a
 *    decision computed before a late submission, a late trial or a late evaluation would close the
 *    round out over facts it never saw — and the reducer, which sees only the round's own subject,
 *    cannot notice a measurement that arrived after the decision was composed.
 *
 * The submission gates themselves (slot range, an occupied slot, the budget, the reserved
 * exploration slot, an after-close submission) are the reducer's, and the reducer runs inside the
 * same serial region: the command surface cannot bypass them and does not duplicate them. What this
 * boundary adds is the one submission condition the round's own state cannot decide — that the
 * evaluation a slot names is an evaluation of the revision that slot offers.
 *
 * @module singularity-core/strategy/commands
 */

import type { ControlReadCut, ControlSessionStore } from '../control/session-store.ts'
import { digestOf, type Envelope } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { RevisionRef } from '../task/protocol.ts'
import { editBudgetFor, type Calibration } from './decision.ts'
import {
  sameRevision,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_VERSION,
  type RoundState,
  type StructuralEdit,
} from './protocol.ts'
import { projectRound, type MeasureSlice, type RoundDecision } from './view.ts'

/** The round's own plan, as the opening fact will freeze it. `editBudget` is not a caller's choice. */
export interface OpenRoundInput {
  readonly commandId: string
  readonly roundId: string
  /** The explicit round number (`review.md` R01). Never derived from history or candidate index. */
  readonly round: number
  readonly incumbent: RevisionRef
  readonly candidates: number
  readonly explorationSlots: number
  readonly historyCutoff: number
  readonly metric: { readonly unit: string; readonly direction: 'higher' | 'lower' }
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
  readonly exploratory: boolean
}

export interface DecideRoundInput {
  readonly commandId: string
  readonly roundId: string
}

export interface StrategyCommandOptions {
  readonly store: ControlSessionStore
  /** How many rounds the run has: rounds are numbered `1..rounds`, and `rounds` reaches the floor. */
  readonly rounds: number
  readonly firstBudget: number
  readonly minimumBudget: number
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
  // The one policy check that no later fact can catch: a budget that *grows* with the round inverts
  // the method (a round is supposed to get sparser), while a non-integer or negative budget is
  // refused by the opening payload's own reader at the fact boundary.
  if (options.minimumBudget > options.firstBudget)
    refuse(
      'malformed-declaration',
      `the edit budget must anneal downward: minimumBudget ${options.minimumBudget} exceeds firstBudget ${options.firstBudget}`,
    )

  return {
    openRound: input =>
      emitRaw(
        options,
        input.commandId,
        STRATEGY_KINDS.roundOpened,
        input.roundId,
        {
          round: input.round,
          incumbent: input.incumbent,
          candidates: input.candidates,
          explorationSlots: input.explorationSlots,
          editBudget: editBudgetFor(input.round, options.rounds, options.firstBudget, options.minimumBudget),
          historyCutoff: input.historyCutoff,
          metric: input.metric,
          weights: input.weights,
        },
        () => {
          // Cross-subject: the round number names a round in this log, not merely inside one subject.
          // Two rounds numbered alike would anneal the same budget and occupy one position in the
          // history the next round reads, so the number would stop being an identifier.
          for (const [subject, state] of options.store.load().statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION)) {
            if (subject === input.roundId || state.plan === undefined) continue
            if (state.plan.round !== input.round) continue
            refuse(
              'illegal-transition',
              `cannot open round ${input.round} as "${input.roundId}": round "${subject}" already carries that number (opened at ${state.openedAt ?? 'an unrecorded time'}, history cutoff ${state.plan.historyCutoff}); two rounds with one number would freeze two different histories under one identity`,
            )
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
          exploratory: input.exploratory,
        },
        () => {
          const cut = options.store.load()
          // The reducer names a submission to a round that was never opened; the anchor below is
          // about a real round, so it stays out of the way of that refusal.
          if (cut.stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, input.roundId)?.plan === undefined) return
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

/** The frozen member set of `round/decided`: a slot number and a reason per candidate. */
function decisionPayload(decision: RoundDecision): { winner: number | null; outcomes: RoundDecision['outcomes'] } {
  return { winner: decision.winner, outcomes: decision.outcomes }
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
