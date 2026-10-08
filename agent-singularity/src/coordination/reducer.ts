/**
 * The one reduction of a graph's coordination: given the immutable facts a pass
 * just read — the store's rounds, the coordination rows, DSH's session facts and
 * whether the root is live here — it says what the driver should do exactly
 * once. Pure: no clock beyond the facts, no I/O, no context.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/reducer
 */

import type { RsiConfig } from '@dangosys/dsh-singularity-graphs'
import type { TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { RecoveryMode } from '@dangosys/dsh-singularity-task-runtime'
import { keyLabel, planAssignment, sameCoordinationKey, type AssignmentPlan, type AssignmentRequest } from './assignment.ts'
import type { BusinessAction } from './completion.ts'
import {
  assignmentsForKey,
  completionFor,
  type CoordinationKey,
  type CoordinationRow,
  type CoordinatedWork,
} from './store.ts'
import { turnSettled, type CoordinationSessionFacts } from './session-facts.ts'
import { rootTaskOf, roundDiagnosisId, roundRequestKey, roundRunOf, terminalRootRuns } from './rounds.ts'

/** Everything one pass read; every field is immutable for the duration of the decision. */
export interface ReductionFacts {
  readonly graph: {
    readonly id: string
    readonly name: string
    readonly storeId: string
    readonly rootSessionId: string
    readonly config: RsiConfig
  }
  readonly snapshot: TaskSnapshot
  readonly rows: readonly CoordinationRow[]
  readonly sessions: ReadonlyMap<string, CoordinationSessionFacts>
  /** How much of the store's coordination allowance is spent, and what it is. */
  readonly budget: { readonly used: number; readonly max: number }
  /** Whether this process holds the graph's root session live; without it nothing is opened or spawned. */
  readonly rootLive: boolean
  /** The work item this pass would claim if it claims one. */
  readonly candidate: AssignmentRequest
}

/** How one pass ended up. */
export type Reduction =
  /** Nothing to do now: wait for the next wake-up. */
  | { readonly kind: 'idle'; readonly detail: string }
  /** Claim or recover one work item. */
  | { readonly kind: 'supervise'; readonly plan: AssignmentPlan; readonly request: AssignmentRequest }
  /** A session ended its turn without a completion call: record the protocol failure once. */
  | { readonly kind: 'protocol-failure'; readonly work: CoordinatedWork; readonly detail: string }
  /** A round concluded and the business work continues: open the next round. */
  | { readonly kind: 'open-round'; readonly request: OpenRoundRequest; readonly work: CoordinatedWork }
  /** The loop takes no further step for this graph. */
  | {
      readonly kind: 'suspended'
      readonly phase: 'done' | 'failed' | 'protocol-failure'
      readonly detail: string
    }

/** One next round, as the runtime's recovery entry takes it. */
export interface OpenRoundRequest {
  readonly businessRound: number
  readonly sourceRunId: string
  readonly sourceDiagnosisId: string
  readonly requestKey: string
  readonly mode: RecoveryMode
  /** The candidate the supervisor asked to try; bound to the next Run by the environment plane. */
  readonly trialCandidateRef?: string
  /** `improve` never reuses members: an improved method must execute them again. */
  readonly reuses?: readonly string[]
}

/** The recovery mode one business action asks for, or nothing when the action and the round disagree. */
export function nextRoundMode(action: BusinessAction, outcome: 'verified' | 'failed'): RecoveryMode | undefined {
  if (action === 'continue') return outcome === 'verified' ? 'improve' : undefined
  if (action === 'recover') return outcome === 'failed' ? 'recovery' : undefined
  return undefined
}

/** The round work item's key: one round, one supervisor, per epoch. */
export function roundKeyOf(input: {
  readonly graphId: string
  readonly epoch: number
  readonly businessRound: number
  readonly taskId: string
  readonly runId: string
}): CoordinationKey {
  return {
    graphId: input.graphId,
    epoch: input.epoch,
    role: 'supervisor',
    subject: {
      kind: 'round',
      businessRound: input.businessRound,
      searchRound: input.businessRound,
      source: { taskId: input.taskId, runId: input.runId },
    },
  }
}

/** The assignment that claimed one key, if any. */
function claimedFor(rows: readonly CoordinationRow[], key: CoordinationKey): CoordinatedWork | undefined {
  const mine = assignmentsForKey(rows, key)
  const last = mine.at(-1)
  if (last === undefined) return undefined
  const completion = completionFor(rows, last.sessionId)
  return { assignment: last, ...(completion === undefined ? {} : { completion }) }
}

/** The reduction of one round that already has a completion. */
function ofCompletion(input: {
  readonly facts: ReductionFacts
  readonly key: CoordinationKey
  readonly work: CoordinatedWork
  readonly run: TaskRun
  readonly outcome: 'verified' | 'failed'
  readonly businessRound: number
}): Reduction {
  const { facts, key, work, run, outcome, businessRound } = input
  const completion = work.completion!
  const config = facts.graph.config
  const epoch = config.epoch ?? 1
  if (completion.result.kind === 'protocol-failure')
    return {
      kind: 'suspended',
      phase: 'protocol-failure',
      detail: `${keyLabel(key)} ended without a completion call (${completion.result.detail}); raise the graph's epoch to try this round again`,
    }
  if (completion.result.kind !== 'completed')
    return { kind: 'suspended', phase: 'failed', detail: `${keyLabel(key)} settled ${completion.result.kind}, which no round does` }
  const action = completion.result.businessAction
  const mode = nextRoundMode(action, outcome)
  if (action === 'finish')
    return {
      kind: 'suspended',
      phase: outcome === 'verified' ? 'done' : 'failed',
      detail: `${keyLabel(key)} finished the business work: round ${businessRound} settled ${run.status} — ${completion.result.reason}`,
    }
  if (mode === undefined)
    return {
      kind: 'suspended',
      phase: 'protocol-failure',
      detail:
        `${keyLabel(key)} asked to "${action}" a round that settled ${run.status}; the two disagree, ` +
        'so no execution is opened',
    }
  if (businessRound >= config.iterationRounds)
    return {
      kind: 'suspended',
      phase: outcome === 'verified' ? 'done' : 'failed',
      detail:
        `${businessRound}/${config.iterationRounds} rounds settled; the search is over and the business outcome stays ` +
        `${run.status} — ${completion.result.reason}`,
    }
  const nextRound = businessRound + 1
  const nextKey = roundRequestKey(facts.graph.id, epoch, nextRound)
  if (roundRunOf(facts.snapshot, run.taskId, nextKey) !== undefined)
    return { kind: 'idle', detail: `round ${nextRound} is already open` }
  if (!facts.rootLive)
    return {
      kind: 'idle',
      detail: `round ${nextRound} cannot be opened here: the graph's root session is not live in this process`,
    }
  const trial = completion.result.trialCandidateRef
  return {
    kind: 'open-round',
    work,
    request: {
      businessRound: nextRound,
      sourceRunId: run.runId,
      sourceDiagnosisId: roundDiagnosisId(facts.graph.id, epoch, businessRound),
      requestKey: nextKey,
      mode,
      ...(trial === null ? {} : { trialCandidateRef: trial }),
      ...(mode === 'improve' ? { reuses: [] } : {}),
    },
  }
}

/**
 * One pass's decision. The graph's protocol marker and the store's own facts are
 * the only inputs: a legacy graph never reaches this function at all (the driver
 * refuses to build these facts for it).
 */
export function reduce(facts: ReductionFacts): Reduction {
  const config = facts.graph.config
  const epoch = config.epoch ?? 1
  const root = rootTaskOf(facts.snapshot)
  if (root === undefined) return { kind: 'idle', detail: 'the store holds no root task yet' }
  const rounds = terminalRootRuns(facts.snapshot, root.taskId)
  if (rounds.length === 0) return { kind: 'idle', detail: 'the root task has no settled round yet' }
  const businessRound = rounds.length
  const run = rounds.at(-1)!
  if (businessRound > config.iterationRounds)
    return {
      kind: 'suspended',
      phase: run.status === 'verified' ? 'done' : 'failed',
      detail: `round ${businessRound} settled beyond the graph's ${config.iterationRounds} configured round(s); nothing more is opened`,
    }
  const outcome = run.status === 'verified' ? 'verified' : 'failed'
  const key = roundKeyOf({
    graphId: facts.graph.id,
    epoch,
    businessRound,
    taskId: root.taskId,
    runId: run.runId,
  })
  if (!sameCoordinationKey(key, facts.candidate.key))
    return {
      kind: 'idle',
      detail: `this pass's work item does not describe round ${businessRound}; the driver re-derives it next time`,
    }
  const claimed = claimedFor(facts.rows, key)
  // An interrupted work item never reached model input: the platform retries it,
  // bounded, or ends the key — so it falls through to the same plan a fresh key
  // gets rather than being read as a settled round.
  const interrupted = claimed?.completion?.result.kind === 'interrupted'
  if (claimed?.completion !== undefined && !interrupted)
    return ofCompletion({ facts, key, work: claimed, run, outcome, businessRound })
  if (claimed !== undefined && !interrupted) {
    const session = claimed.assignment.sessionId
    const factsOfSession = facts.sessions.get(session)
    if ((factsOfSession?.hasTurn ?? false) && turnSettled(factsOfSession))
      return {
        kind: 'protocol-failure',
        work: claimed,
        detail:
          `${keyLabel(key)}: session ${session} ended its turn without calling supervisor_complete; ` +
          'the round is recorded as a protocol failure and the platform does not ask again',
      }
    return { kind: 'idle', detail: `${keyLabel(key)} is taken up by session ${session}; the loop waits for it` }
  }
  const plan = planAssignment({
    request: facts.candidate,
    rows: facts.rows,
    sessions: facts.sessions,
    budget: facts.budget,
  })
  if (plan.kind === 'refused')
    return { kind: 'suspended', phase: 'failed', detail: `${plan.code}: ${plan.detail}` }
  if (plan.kind === 'assign' || plan.kind === 'resume') return { kind: 'supervise', plan, request: facts.candidate }
  return { kind: 'idle', detail: `${keyLabel(key)} is already claimed; the loop waits for it` }
}
