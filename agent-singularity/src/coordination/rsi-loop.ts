/**
 * The platform-side RSI loop driver: iteration scheduling for a graph that runs
 * a recursive-self-improvement loop lives here — in the platform — and not in
 * the root agent's prompt. A graph carries its settings in `GraphRecord.rsi`
 * (round objective, total rounds, whether a human reviews), the driver writes
 * its position to `GraphRecord.rsiProgress`, and the root is never asked to
 * schedule anything.
 *
 * One round is one **terminal-settled Run of the store's root task**. Round 1 is
 * the original attempt; round N+1 is opened by this driver as a recovery of
 * round N's run — `mode: 'improve'` when that run verified, `mode: 'recovery'`
 * when it failed. The driver records one platform diagnosis for
 * each settled round (`proposals: []`), spawns a **supervisor** agent (read/glob/grep plus
 * the evolution chain), watches it to its settlement, and then opens the next
 * round itself through `taskRuntime.recoverRootTask` — platform to platform, no
 * agent tool in the path, `proposalIds` carrying whatever the round published.
 * `iterationRounds` counts execution attempts: N attempts provide N-1 chances
 * to publish and consume a method change. The final attempt keeps its actual
 * verified/failed outcome, receives a final library review and opens no further execution.
 *
 * The supervisor is the *only* place a coordination supervisor exists (F): it
 * holds no `task_recover`, because round scheduling belongs to this driver
 * alone. A round that settles (verified or failed) is handled here and nowhere
 * else; a graph without `rsi` settings has no supervisor and no autonomous
 * iteration at all — a failed task there is simply failed.
 *
 * The two invariants that keep this the only scheduler of such a graph:
 *
 * 1. Every round's diagnosis is recorded with `proposals: []`. No agent-side
 *    hand-off reads diagnoses any more (the A5 scan and the A6 hand-off trigger
 *    are gone), so nothing competes with this driver for a round.
 * 2. Every round's recovery carries a request key derived from graph and round
 *    (`rsi-<graphId>-round-<N>`), and one key names one attempt (§F.4) — so a
 *    restart that re-derives the same round returns the existing attempt instead
 *    of opening a second, supervisions already taken up are read back from the
 *    coordination ledger instead of being spawned again, and completed rounds are
 *    re-counted from the store snapshot rather than trusted to memory.
 *
 * @module @dangosys/dsh-singularity-agent/rsi-loop
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import { APPLYABLE_TARGET_TYPES, type EvolutionProposal } from '@dangosys/dsh-singularity-evolution'
import type { GraphRecord, RsiConfig, RsiProgress } from '@dangosys/dsh-singularity-graphs'
import {
  canonicalize,
  isTerminalRunStatus,
  rootTaskStoreId,
  sha256Hex,
  type Diagnosis,
  type ReviewMetrics,
  type ReviewRecord,
  type TaskRun,
  type TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import {
  recoveryAttemptWithKey,
  optionalService,
  type RecoveryMode,
  type RootRecoveryRequest,
  type TerminalReviewFact,
} from '@dangosys/dsh-singularity-task-runtime'
import { warnLine } from '../log.ts'
import { message } from '../shared.ts'
import { COORDINATION_PRESET, lastAssistantText, renderRecordedCostFacts, renderSupervisorReviewFacts, runSubtree, supervisorOutcomeOf } from './handoff-rules.ts'
import { liveRootAgentOf } from './identity.ts'
import {
  admitReviewAgent,
  readReviewAgentAttempts,
  settleReviewAgentAttempt,
  type ReviewAgentAttempt,
  type ReviewAgentAttemptRequest,
} from './ledger.ts'
import { spawnUnderClaim, type ClaimedSpawn } from './spawn-under-claim.ts'
import { registerGraphImprovementCap, unregisterGraphImprovementCap } from './supervision.ts'
import { backgroundScan } from './trigger.ts'

/**
 * How many times a stalled supervisor is re-prompted before its unfinished
 * supervision is recorded as blocked. Exhausting reminders never completes a
 * publication and never opens the next round.
 */
const MAX_SUPERVISOR_REPROMPTS = 3

/**
 * The supervisor's tool surface: the read-only investigation tools, the store's
 * own records, and the nine-step evolution chain. `task_recover` is deliberately
 * absent — round scheduling belongs to the driver, so the agent that publishes a
 * round is never the one that opens the next.
 */
export const SUPERVISOR_BASELINE: readonly string[] = [
  'task_review_pack',
  'task_review_agent',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'task_library',
  'task_template_list',
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_list',
  'read',
  'glob',
  'grep',
  'skill',
]

/** The grant one round's supervisor is spawned with. */
export function supervisorGrant(): WorkerGrant {
  return { capabilities: [], baseline: SUPERVISOR_BASELINE, keepPresetTools: false }
}

/** The id of the platform diagnosis one round's run is recorded under: the supervisor cites it and the next round's recovery names it. */
export function roundDiagnosisId(graphId: string, round: number): string {
  return `rsi-${graphId}-round-${round}`
}

/** The request key that opens one round (A7 §3): one key names one attempt, so re-asking returns the attempt that key already names. */
export function roundRequestKey(graphId: string, round: number): string {
  return `rsi-${graphId}-round-${round}`
}

/** The request key of one round's supervision attempt: one round is one supervisor hand-off, however many attempts it takes. */
export function supervisorRequestKey(graphId: string, round: number): string {
  return `rsi-supervise-${graphId}-round-${round}`
}

/** What one round's supervision settled as: proceed with what it published, stop the loop, or defer to a later activation. */
export type RoundSupervision =
  /** The supervisor finished: the applied proposals the next round consumes. */
  | { readonly kind: 'proceed'; readonly applied: readonly string[] }
  /** The supervisor explicitly stopped the loop: a contract-level defect is not retryable. */
  | { readonly kind: 'stop'; readonly outcome: 'closed' | 'blocked'; readonly reason: string }
  /** No supervision could be taken up here: nothing is opened and a later activation retries. */
  | { readonly kind: 'deferred'; readonly note: string }

/** The spawned supervisor handle, as the completion watcher needs it. */
type SpawnedHandle = Extract<ClaimedSpawn, { kind: 'spawned' }>['handle']

/** The store's own root task: the one task that never had a parent (§1.6: one root per store, ever). */
function rootTaskOf(snapshot: TaskSnapshot): { taskId: string } | undefined {
  return snapshot.tasks.find(task => task.parentTaskId === undefined)
}

/** The store's own first attempt of the root task: the run that is not a recovery of anything. */
function firstRootRun(snapshot: TaskSnapshot, rootTaskId: string): TaskRun | undefined {
  return snapshot.runs.find(run => run.taskId === rootTaskId && run.recovery === undefined)
}

/**
 * Every terminal-settled run of the root task, oldest first — the store's own
 * count of rounds. A round is a settled attempt, verified or not: the driver
 * schedules on outcomes, and a failed non-final round still has its supervisor
 * and its next recovery round. The configured count includes the original run.
 */
function terminalRootRuns(snapshot: TaskSnapshot, rootTaskId: string): TaskRun[] {
  return snapshot.runs
    .filter(run => run.taskId === rootTaskId && isTerminalRunStatus(run.status))
    .sort((left, right) =>
      left.startedAt < right.startedAt
        ? -1
        : left.startedAt > right.startedAt
          ? 1
          : left.runId < right.runId
            ? -1
            : left.runId > right.runId
              ? 1
              : 0,
    )
}

/** The run one round opened, read from the store's own attempt record by its request key. */
function roundRunOf(snapshot: TaskSnapshot, rootTaskId: string, requestKey: string): TaskRun | undefined {
  return recoveryAttemptWithKey(snapshot, rootTaskId, requestKey)
}

/** The review record of one run, as the store holds it. */
function reviewOfRun(snapshot: TaskSnapshot, runId: string): ReviewRecord | undefined {
  return snapshot.reviews.find(review => review.runId === runId)
}

/** One proposal's state as a reader says it: the id, its status, and the decision when it has one. */
function proposalLine(proposals: readonly EvolutionProposal[]): string {
  return proposals.length === 0
    ? 'no proposal is recorded for this round'
    : proposals
        .map(
          proposal =>
            `${proposal.proposalId} [${proposal.status}]${proposal.decision === undefined ? '' : ` ${proposal.decision}`}`,
        )
        .join('; ')
}

/** A publication is complete only when every apply-supported proposal of this round is settled. Research-only target types do not block it. */
function publicationOf(proposals: readonly EvolutionProposal[]): {
  readonly done: boolean
  readonly applied: string[]
  readonly unresolved: string[]
  readonly note: string
} {
  const executable = proposals.filter(proposal => APPLYABLE_TARGET_TYPES.includes(proposal.targetType))
  const applied = executable
    .filter(proposal => proposal.status === 'applied' && proposal.rolledback === undefined)
    .map(proposal => proposal.proposalId)
  const unresolved = executable.filter(proposal =>
    proposal.status !== 'applied' && proposal.status !== 'rolledback' &&
    !(proposal.status === 'decided' && (proposal.decision === 'REJECT' || proposal.decision === 'KEEP_FOR_FURTHER_RESEARCH')),
  ).map(proposal => proposal.proposalId)
  return { done: executable.length > 0 && unresolved.length === 0, applied, unresolved, note: proposalLine(proposals) }
}

interface EvolutionLedgerRead {
  list(): Promise<EvolutionProposal[]>
  experiments?(proposalId: string): Promise<readonly {
    experimentId: string
    frozen: { evaluation?: { generatedResponse?: string; generatedUsage?: ReviewMetrics['tokens'] } }
    judged?: { evaluation: { judgeUsage?: ReviewMetrics['tokens'] } }
  }[]>
}

/** Driver and agents read the same graph-scoped ledger. Legacy compositions retain their global reader. */
async function evolutionOf(ctx: Context, sessionId: string): Promise<EvolutionLedgerRead | undefined> {
  const plane = ctx.evolution as {
    list?: () => Promise<EvolutionProposal[]>
    experiments?: EvolutionLedgerRead['experiments']
    forSession?: (sessionId: string) => Promise<EvolutionLedgerRead>
  } | undefined
  const evolution = typeof plane?.forSession === 'function' ? await plane.forSession(sessionId) : plane
  const list = evolution?.list
  return typeof list !== 'function' ? undefined : {
    list: () => list.call(evolution),
    ...(evolution?.experiments === undefined ? {} : { experiments: proposalId => evolution.experiments!(proposalId) }),
  }
}

/** One graph's loop, as this process holds it while it drives it. */
interface LoopState {
  readonly graphId: string
  readonly storeId: string
  readonly rootSessionId: string
  config: RsiConfig
  /** The store's root task, read from the store; nothing is scheduled before it exists. */
  rootTaskId?: string
  /** The position the driver last wrote, so a repeated activation does not rewrite the same fact. */
  progress?: RsiProgress
  /** The loop finished its configured rounds, stopped on a defect, or its graph stopped being one: it takes no further step here. */
  stopped: boolean
}

export interface RsiLoopOptions {
  /** Where the driver's lines go; absent uses the deployment's soft logger. */
  readonly log?: (line: string) => void
}

/**
 * The RSI loop driver of one deployment. One instance is installed per process
 * (see {@link installRsiLoopDriver}); every graph with `rsi` settings gets one
 * {@link LoopState}, and graphs without them are never touched.
 */
export class RsiLoopDriver {
  private readonly ctx: Context
  private readonly log: (line: string) => void
  private readonly loops = new Map<string, LoopState>()
  private readonly byStore = new Map<string, string>()
  private readonly registered = new Set<string>()
  /** One promise chain per graph: a terminal fact, an activation and the boot seed never interleave inside one loop. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly disposers: (() => void)[] = []
  private stopped = false

  constructor(ctx: Context, options: RsiLoopOptions = {}) {
    this.ctx = ctx
    this.log = options.log ?? warnLine(ctx)
  }

  /** Subscribe to the two facts that move a loop — one terminal review, one graph activation — and seed from the persisted registry. */
  install(): () => void {
    this.disposers.push(this.ctx.taskRuntime.registerTerminalReviewListener(fact => this.handleFact(fact)))
    this.disposers.push(
      this.ctx.on('graphs/selected', (graph: GraphRecord) => {
        // The store's cap is declared synchronously, before anything the same
        // activation starts: from the first fact onward the store is known to be
        // driver-scheduled.
        this.observeGraph(graph)
      }),
    )
    this.disposers.push(this.ctx.on('graphs/change', snapshot => this.observeGraphs(snapshot.graphs)))
    backgroundScan(this.log, 'rsi loop', () => this.seed())
    return () => this.stop()
  }

  /** Forget every loop, every declared cap and every subscription of this instance. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.log(`rsi loop: a subscription could not be released (${message(error)})`)
      }
    }
    for (const storeId of this.registered) unregisterGraphImprovementCap(storeId)
    this.registered.clear()
    this.loops.clear()
    this.byStore.clear()
  }

  /** One graph became the active one: declare its cap and take its loop over. */
  observeGraph(graph: GraphRecord): void {
    if (graph.rsi === undefined) {
      this.forget(graph.id)
      return
    }
    const storeId = this.remember(graph)
    registerGraphImprovementCap(storeId, graph.rsi.iterationRounds)
    this.registered.add(storeId)
    this.log(`rsi loop: graph ${graph.id} runs ${graph.rsi.iterationRounds} round(s) over store ${storeId}`)
    void this.ensure(graph.id).catch(error => this.log(`rsi loop ${graph.id}: ${message(error)}`))
  }

  /** Reconcile the declared caps against the registry: a graph that gained a config is registered, one that lost it is forgotten. */
  observeGraphs(graphs: readonly GraphRecord[]): void {
    const live = new Set<string>()
    for (const graph of graphs) {
      if (graph.rsi === undefined) continue
      const storeId = this.remember(graph)
      registerGraphImprovementCap(storeId, graph.rsi.iterationRounds)
      this.registered.add(storeId)
      live.add(storeId)
      // A registry change may be the operator re-setting the config (a resume after a
      // blocked stop): the loop re-derives from the store, never from this event alone.
      void this.ensure(graph.id).catch(error => this.log(`rsi loop ${graph.id}: ${message(error)}`))
    }
    for (const storeId of [...this.registered]) {
      if (live.has(storeId)) continue
      unregisterGraphImprovementCap(storeId)
      this.registered.delete(storeId)
      const graphId = this.byStore.get(storeId)
      if (graphId !== undefined) this.forget(graphId)
    }
  }

  /** One graph activation (or the boot seed): read what the graph holds now and take its loop's next step. */
  ensure(graphId: string): Promise<void> {
    return this.serialize(graphId, () => this.advance(graphId))
  }

  /**
   * Bind one store to its graph before anything is read from it: a store's
   * terminal facts arrive by store id alone, so the routing has to exist from
   * the moment the graph is declared — a root task that does not exist yet
   * still has its first attempt ahead of it.
   */
  private remember(graph: GraphRecord): string {
    const state = this.loops.get(graph.id)
    // Invalidate synchronously: ensure() is queued behind an awaited supervisor,
    // but clearing/replacing the config must revoke that watcher's authority now.
    if (state !== undefined && !this.matchesGraph(state, graph)) this.forget(graph.id)
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    this.byStore.set(storeId, graph.id)
    return storeId
  }

  /** One terminal review became durable: the graph's own store moves its loop, every other store is not this driver's business. */
  private handleFact(fact: TerminalReviewFact): void {
    if (this.stopped) return
    const graphId = this.byStore.get(fact.storeId)
    if (graphId === undefined) return
    const state = this.loops.get(graphId)
    // A fact for any task but the root moves no round: rounds are root runs.
    if (state?.rootTaskId !== undefined && fact.taskId !== state.rootTaskId) return
    void this.ensure(graphId).catch(error => this.log(`rsi loop ${graphId}: ${message(error)}`))
  }

  /** Read the persisted registry once: a graph selected before this process booted still gets its loop taken over. */
  private async seed(): Promise<void> {
    if (this.stopped) return
    const graphs = this.ctx.graphs as { list?: () => Promise<readonly GraphRecord[]> } | undefined
    if (typeof graphs?.list !== 'function') return
    const all = await graphs.list()
    this.observeGraphs(all)
    for (const graph of all) {
      if (graph.rsi === undefined) continue
      await this.ensure(graph.id)
    }
  }

  /** Serialize one moment of one graph's loop: the loop's state machine is single-threaded per graph. */
  private serialize(graphId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(graphId) ?? Promise.resolve()
    const settled = previous.then(work).then(
      () => undefined,
      error => {
        this.log(`rsi loop ${graphId}: ${message(error)}`)
      },
    )
    this.queues.set(graphId, settled)
    void settled.then(() => {
      if (this.queues.get(graphId) === settled) this.queues.delete(graphId)
    })
    return settled
  }

  /**
   * The one step a loop takes, from the store's own facts: how many rounds have
   * settled, whether the next round is already open, and whether the round that
   * just settled still needs its supervision. Every entry (a terminal fact, an
   * activation, the boot seed) is this same read — memory is never the record.
   */
  private async advance(graphId: string): Promise<void> {
    if (this.stopped) return
    let graph: GraphRecord
    try {
      graph = await this.ctx.graphs.get(graphId)
    } catch (error) {
      this.log(`rsi loop: graph ${graphId} could not be read (${message(error)})`)
      return
    }
    const config = graph.rsi
    if (config === undefined) {
      this.forget(graphId)
      return
    }
    const storeId = this.remember(graph)
    registerGraphImprovementCap(storeId, config.iterationRounds)
    this.registered.add(storeId)
    const state = this.loopFor(graph, storeId)
    if (state.stopped) return
    state.config = config
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.log(`rsi loop ${graphId}: store ${storeId} could not be read (${message(error)})`)
      return
    }
    const root = rootTaskOf(snapshot)
    if (root === undefined) return
    state.rootTaskId = root.taskId
    this.byStore.set(storeId, graphId)
    const rounds = terminalRootRuns(snapshot, root.taskId)
    if (rounds.length >= config.iterationRounds) {
      await this.superviseRound(state, graph, snapshot, rounds.length, rounds.at(-1)!)
      return
    }
    const next = rounds.length + 1
    const openRun = roundRunOf(snapshot, root.taskId, roundRequestKey(graphId, next))
    if (openRun !== undefined) {
      // The next round is already in the store: a running one is reported and
      // awaited, a settled one is counted by the next read of the store.
      if (openRun.status === 'running') {
        await this.mark(state, { round: next, phase: 'running', note: `round ${next} is running` })
      }
      return
    }
    const latest = rounds.at(-1)
    if (latest === undefined) {
      // Round 1 is the store's own first attempt: nothing is opened for it, and
      // its supervision is taken up here once it settles.
      const first = firstRootRun(snapshot, root.taskId)
      if (first !== undefined && first.status === 'running') {
        await this.mark(state, { round: 1, phase: 'running', note: 'round 1 is running' })
      }
      return
    }
    await this.superviseRound(state, graph, snapshot, rounds.length, latest)
  }

  /**
   * The round that just settled: record its diagnosis, take up its supervision,
   * then open the next one. A supervisor that explicitly stopped the loop ends
   * it here; a supervision that could not be taken up opens nothing and a later
   * activation retries it.
   */
  private async superviseRound(
    state: LoopState,
    graph: GraphRecord,
    snapshot: TaskSnapshot,
    round: number,
    run: TaskRun,
  ): Promise<void> {
    if (await this.currentGraph(state) === undefined) return
    const verified = run.status === 'verified'
    const review = reviewOfRun(snapshot, run.runId)
    const diagnosisId = roundDiagnosisId(state.graphId, round)
    await this.recordDiagnosis(state, graph, round, run, review, verified)
    await this.mark(state, verified
      ? { round, phase: 'publishing', note: `round ${round} verified; supervising its method change` }
      : { round, phase: 'debugging', note: `round ${round} settled ${run.status}; supervising its repair` })
    const supervision = await this.takeUpSupervision(state, graph, round, run, review, diagnosisId, verified)
    // The supervisor can outlive a clear/replace event; its old loop never marks
    // progress or opens an execution on behalf of the newly configured graph.
    if (await this.currentGraph(state) === undefined) return
    switch (supervision.kind) {
      case 'stop':
        state.stopped = true
        await this.mark(state, {
          round,
          phase: 'failed',
          note: `round ${round}'s supervisor reported ${supervision.outcome}: ${supervision.reason}; the loop stops`,
        })
        return
      case 'deferred':
        await this.mark(state, { round, phase: 'failed', note: supervision.note })
        return
      case 'proceed':
        if (round >= state.config.iterationRounds) {
          state.stopped = true
          const cause = verified ? undefined : review?.localizedCause
          await this.mark(state, {
            round,
            phase: verified ? 'done' : 'failed',
            note: `${round}/${state.config.iterationRounds} rounds settled; final round ${run.status}` +
              `${cause === undefined ? '' : `: ${cause}`}; final library review settled; the loop is finished`,
          })
          return
        }
        await this.openRound(
          state,
          graph,
          round + 1,
          run.runId,
          diagnosisId,
          supervision.applied,
          verified ? 'improve' : 'recovery',
        )
    }
  }

  /**
   * The platform's own diagnosis for one round: the observation names what the
   * store recorded (the run's own review cause for a failed round), and
   * `proposals: []` says the driver records no suggestion — the supervisor
   * investigates. The diagnosis exists so the next round's `recoverRootTask`
   * has a store record to name.
   */
  private async recordDiagnosis(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    run: TaskRun,
    review: ReviewRecord | undefined,
    verified: boolean,
  ): Promise<void> {
    const diagnosisId = roundDiagnosisId(state.graphId, round)
    const snapshot = await this.ctx.task.snapshotIn(state.storeId)
    if (snapshot.diagnoses.some(item => item.diagnosisId === diagnosisId)) return
    const consumed = run.recovery?.proposalIds ?? []
    const diagnosis: Diagnosis = {
      diagnosisId,
      taskId: state.rootTaskId!,
      observedFailure: verified
        ? `Round ${round} of graph "${graph.name}" (${state.graphId}) verified: the root task's run "${run.runId}" settled verified ` +
          `under the store's own acceptance criteria.`
        : review?.localizedCause ??
          `Round ${round} of graph "${graph.name}" (${state.graphId}) settled ${run.status}: the root task's run "${run.runId}" ` +
            `did not pass the store's own acceptance criteria.`,
      scope: `the root task ${state.rootTaskId} of this store; graph ${state.graphId} runs a platform RSI loop of ${state.config.iterationRounds} round(s)`,
      localizedCause: round >= state.config.iterationRounds
        ? `The platform RSI loop reviews round ${round}'s library experience before completing this graph: ${state.config.task}.`
        : verified
        ? `The platform RSI loop continues this graph's verified goal with round ${round + 1}: ${state.config.task}.` +
          (consumed.length === 0
            ? ' No published change was consumed by this round.'
            : ` This round consumed the applied proposal(s) ${consumed.join(', ')}.`)
        : `The platform RSI loop hands round ${round}'s ${run.status} attempt to its supervisor, which investigates the cause and ` +
          `prepares the method change round ${round + 1} (mode "recovery") consumes: ${state.config.task}.`,
      evidenceRefs: review?.evidenceRefs ?? [],
      reviewRefs: [`${state.rootTaskId}#${run.runId}`],
      confidence: 'high',
      // Invariant (see this function's header): no suggestions. The driver's own
      // judgement is not a diagnosis of a cause; the supervisor investigates.
      proposals: [],
      producedBy: { kind: 'agent', sessionId: state.rootSessionId },
    }
    try {
      if (await this.currentGraph(state) === undefined) return
      await this.ctx.task.recordDiagnosisIn(state.storeId, diagnosis, state.rootSessionId)
      this.log(`rsi loop ${state.graphId}: round ${round} diagnosis ${diagnosisId} recorded`)
    } catch (error) {
      // A concurrent writer may have recorded the same round's diagnosis first;
      // re-read before treating the write as fatal.
      const after = await this.ctx.task.snapshotIn(state.storeId).catch(() => undefined)
      if (after?.diagnoses.some(item => item.diagnosisId === diagnosisId) === true) return
      throw error
    }
  }

  /**
   * Take up one round's supervision: hand the round to a supervisor agent and
   * watch it settle, or read what a previous attempt already settled. A settled
   * attempt is the round's answer however this process came to read it, so a
   * restart neither spawns a second supervisor for a round that already had one
   * nor forgets the outcome that stopped the loop.
   */
  private async takeUpSupervision(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    run: TaskRun,
    review: ReviewRecord | undefined,
    diagnosisId: string,
    verified: boolean,
  ): Promise<RoundSupervision> {
    const already = publicationOf(await this.proposalsFor(state, diagnosisId))
    const attempts = await readReviewAgentAttempts(state.storeId).catch(() => [])
    const settled = supervisorAttemptOf(attempts, diagnosisId)
    // An operator re-setting the graph's RSI config drops the stored loop progress; read at the start of
    // this pass, an absent progress IS the operator's resume after clearing the obstruction a `blocked`
    // settlement named. A plain `closed` — the supervisor's own judgement that the round must not be
    // retried — is final and never re-delegated by the platform.
    const operatorResume = graph.rsiProgress === undefined
    if (settled?.settlement?.status === 'closed') {
      const note = settled.settlement.note ?? 'the round was closed'
      const blocked = note.startsWith('blocked:')
      if (!(blocked && operatorResume)) return { kind: 'stop', outcome: blocked ? 'blocked' : 'closed', reason: note }
    }
    // A durable no_change is a complete answer only while its ledger agrees:
    // no active publication and no unfinished executable candidate. Legacy
    // recorded reminders without a settled publication are not completion.
    const recordedNoChange = settled?.settlement?.status === 'recorded' &&
      settled.settlement.note?.startsWith('no_change:') === true
    if (recordedNoChange) {
      if (already.applied.length === 0 && already.unresolved.length === 0) return { kind: 'proceed', applied: [] }
    } else if (already.done && (round < state.config.iterationRounds || settled?.settlement?.status === 'recorded')) {
      return { kind: 'proceed', applied: already.applied }
    }
    const delegator = liveRootAgentOf(this.ctx, state.storeId)
    if (delegator === undefined) {
      return {
        kind: 'deferred',
        note: `round ${round} was not supervised: the graph's root session is not live in this process; the next activation retries`,
      }
    }
    const sessionId = SessionId(randomUUID())
    const request: ReviewAgentAttemptRequest = {
      role: 'supervisor',
      source: { taskId: state.rootTaskId!, runId: run.runId },
      requestKey: supervisorRequestKey(state.graphId, round),
      reason: verified
        ? `the RSI loop's publication for round ${round}`
        : `the RSI loop's repair of round ${round}`,
      diagnosisId,
      handoffDigest: roundHandoffDigest({
        graphId: state.graphId,
        round,
        storeId: state.storeId,
        taskId: state.rootTaskId!,
        runId: run.runId,
      }),
      actor: delegator.sessionId,
      sessionId,
    }
    const spawned = await admitReviewAgent(state.storeId, async admission => {
      if (await this.currentGraph(state) === undefined)
        return { kind: 'refused' as const, reason: 'the RSI config was cleared or replaced' }
      const { plan } = await admission.plan(request, { recorded: () => already.done, resumeRecorded: true, retryClosed: operatorResume })
      if (plan.kind === 'refused')
        return { kind: 'refused' as const, reason: `${plan.code}: ${plan.reason ?? 'no reason given'}` }
      if (plan.kind === 'in-flight') return { kind: 'running' as const, sessionId: plan.attempt.sessionId }
      if (plan.kind === 'reuse') return { kind: 'reuse' as const, sessionId: plan.attempt.sessionId }
      const outcome = await spawnUnderClaim({
        ctx: this.ctx,
        admission,
        storeId: state.storeId,
        request,
        sessionId,
        taskId: state.rootTaskId!,
        actor: delegator.sessionId,
        parent: delegator.agent,
        name: `rsi supervisor for ${state.graphId} round ${round}`,
        preset: COORDINATION_PRESET,
        grant: supervisorGrant(),
        errorLabel: 'rsi loop: the delegation of supervisor session',
        failureLabel: 'the supervisor could not be spawned',
        prompt: () =>
          verified
            ? this.verifiedPrompt(state, graph, round, run, review, diagnosisId)
            : this.failedPrompt(state, graph, round, run, review, diagnosisId),
      })
      if (outcome.kind === 'spawn-failed') return { kind: 'spawn-failed' as const, reason: outcome.failure }
      return { kind: 'spawned' as const, agent: outcome.handle.agent }
    })
    if (spawned.kind === 'refused')
      return { kind: 'deferred', note: `round ${round} was not supervised (${spawned.reason}); the next activation retries` }
    if (spawned.kind === 'spawn-failed')
      return {
        kind: 'deferred',
        note: `round ${round} was not supervised (${spawned.reason}); the next activation retries`,
      }
    if (spawned.kind === 'running' || spawned.kind === 'reuse') {
      // Another attempt of this round owns its supervision (this process's own
      // watch is serialized behind this call): nothing is started for it here.
      return { kind: 'deferred', note: `round ${round}'s supervision is taken up already; the loop waits for it` }
    }
    return await this.watchSupervisor(state, round, diagnosisId, sessionId, spawned.agent)
  }

  /**
   * Watch one supervisor to its settlement: every executable proposal concluded,
   * an explicit no_change, the blocked re-prompt bound, or its own stop. The attempt's durable
   * outcome is settled on the coordination ledger either way, so a later
   * activation reads the same answer instead of spawning a second supervisor.
   */
  private async watchSupervisor(
    state: LoopState,
    round: number,
    diagnosisId: string,
    sessionId: SessionId,
    agent: SpawnedHandle['agent'],
  ): Promise<RoundSupervision> {
    let reprompts = 0
    try {
      for (;;) {
        await agent.whenIdle()
        if (await this.currentGraph(state) === undefined) {
          await this.settleSupervisor(state, sessionId, 'interrupted', 'the RSI config changed or the driver was unloaded')
          return { kind: 'deferred', note: 'the RSI config changed or the driver was unloaded while the supervisor ran' }
        }
        const outcome = supervisorOutcomeOf(lastAssistantText(agent.session.snapshotEvents()))
        if (outcome !== undefined && outcome.outcome !== 'no_change') {
          await this.settleSupervisor(state, sessionId, 'closed', `${outcome.outcome}: ${outcome.reason}`)
          return { kind: 'stop', outcome: outcome.outcome, reason: outcome.reason }
        }
        const publication = publicationOf(await this.proposalsFor(state, diagnosisId))
        if (await this.currentGraph(state) === undefined) {
          await this.settleSupervisor(state, sessionId, 'interrupted', 'the RSI config changed or the driver was unloaded')
          return { kind: 'deferred', note: 'the RSI config changed while reading the publication ledger' }
        }
        const invalidNoChange = outcome?.outcome === 'no_change' &&
          (publication.applied.length > 0 || publication.unresolved.length > 0)
        if (outcome?.outcome === 'no_change' && !invalidNoChange) {
          await this.settleSupervisor(state, sessionId, 'recorded', `no_change: ${outcome.reason}`)
          return { kind: 'proceed', applied: [] }
        }
        if (publication.done && !invalidNoChange) {
          await this.settleSupervisor(state, sessionId, 'recorded', publication.note)
          this.log(`rsi loop ${state.graphId}: round ${round} supervised — ${publication.note}`)
          return { kind: 'proceed', applied: publication.applied }
        }
        if (reprompts >= MAX_SUPERVISOR_REPROMPTS) {
          const reason = `supervision unfinished after ${MAX_SUPERVISOR_REPROMPTS} re-prompts: ` +
            `${invalidNoChange ? 'no_change contradicts the publication ledger; ' : ''}${publication.note}`
          await this.settleSupervisor(state, sessionId, 'closed', `blocked: ${reason}`)
          return { kind: 'stop', outcome: 'blocked', reason }
        }
        reprompts += 1
        await this.ctx.agentRuntime.prompt(agent, [
          {
            type: 'text',
            text:
              `Round ${round} of graph ${state.graphId} remains yours. Durable proposal state: ${publication.note}. ` +
              'Continue the existing proposal through its next candidate/prepare/replay/gate/decide/apply step, ' +
              'or settle it with REJECT / KEEP_FOR_FURTHER_RESEARCH and a reason. ' +
              `Unfinished executable proposals: ${publication.unresolved.join(', ') || 'none'}. ` +
              (invalidNoChange ? 'Your no_change outcome contradicts the ledger: resolve the executable proposals or correct your final answer. ' : '') +
              'The platform driver opens the next round after you settle. To retain the current method with an empty or negatively settled executable ledger, finish with ' +
              '{"outcome":"no_change","reason":"..."} in a fenced json block. Keep research suggestions as findings. ' +
              'Otherwise finish the chain or end with {"outcome":"blocked","reason":"..."} for a concrete obstruction, or ' +
              '{"outcome":"closed","reason":"..."} to end the loop, in a fenced json block.',
          },
        ])
      }
    } catch (error) {
      await this.settleSupervisor(state, sessionId, 'interrupted', message(error))
      throw error
    }
  }

  /** The proposal facts one round's publication left, read from the ledger the agents write. */
  private async proposalsFor(state: LoopState, diagnosisId: string): Promise<EvolutionProposal[]> {
    const evolution = await evolutionOf(this.ctx, state.rootSessionId)
    if (evolution === undefined) return []
    const all = await evolution.list()
    return all.filter(proposal => proposal.sourceRefs.includes(`diagnosis:${diagnosisId}`))
  }

  /** Every proposal this loop's rounds produced, oldest last, for the supervisor's "what is published now" line. */
  private async loopProposals(state: LoopState): Promise<EvolutionProposal[]> {
    const evolution = await evolutionOf(this.ctx, state.rootSessionId)
    if (evolution === undefined) return []
    const marker = `diagnosis:rsi-${state.graphId}-round-`
    return (await evolution.list()).filter(proposal => proposal.sourceRefs.some(ref => ref.startsWith(marker)))
  }

  /** Settle the ledger row of one supervisor attempt; the round's own outcome is already durable, so a refusal here is only logged. */
  private async settleSupervisor(
    state: LoopState,
    sessionId: SessionId,
    status: 'recorded' | 'interrupted' | 'closed',
    note: string,
  ): Promise<void> {
    await settleReviewAgentAttempt({
      rootStoreId: state.storeId,
      taskId: state.rootTaskId!,
      sessionId,
      status,
      note,
    }).catch(error =>
      this.log(`rsi loop ${state.graphId}: the supervisor attempt could not be settled (${message(error)})`),
    )
  }

  /**
   * Open the next round through the runtime's own recovery entry: one attempt of
   * the round's run under the round's request key — `improve` after a verified
   * round, `recovery` after a failed one — consuming the proposals it published.
   * A key that already names an attempt is answered from the store instead of
   * opening a second (§F.4).
   */
  private async openRound(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    sourceRunId: string,
    diagnosisId: string,
    applied: readonly string[],
    mode: RecoveryMode,
  ): Promise<void> {
    const requestKey = roundRequestKey(state.graphId, round)
    if (await this.currentGraph(state) === undefined) return
    const snapshot = await this.ctx.task.snapshotIn(state.storeId)
    if (roundRunOf(snapshot, state.rootTaskId!, requestKey) === undefined) {
      const delegator = liveRootAgentOf(this.ctx, state.storeId)
      if (delegator === undefined) {
        await this.mark(state, {
          round,
          phase: 'failed',
          note: `round ${round} could not be opened: the graph's root session is not live in this process; the next activation retries`,
        })
        return
      }
      const request: RootRecoveryRequest = {
        sourceTaskId: state.rootTaskId!,
        sourceRunId,
        sourceDiagnosisId: diagnosisId,
        requestKey,
        mode,
        // An improvement must execute new task members under the published
        // method. It retains the graph's workspace and frozen root contract;
        // this is not an isolated fresh-input experiment. Failure recovery
        // keeps the generic runtime's evidence-based member reuse.
        ...(mode === 'improve' ? { reuses: [] } : {}),
        ...(applied.length === 0 ? {} : { proposalIds: [...applied] }),
      }
      try {
        if (await this.currentGraph(state) === undefined) return
        const outcome = await this.ctx.taskRuntime.recoverRootTask(state.storeId, request, {
          sessionId: delegator.sessionId,
        })
        this.log(
          `rsi loop ${graph.id}: round ${round} ${outcome.attempt === 'started' ? 'opened' : 'was already open'} — run ${outcome.runId} (${outcome.status})`,
        )
      } catch (error) {
        // Recovery can persist an attempt before a spawn fails. Reconcile that
        // key first: a written terminal attempt is a round, not a pre-write
        // refusal. A later activation handles its actual terminal outcome.
        const after = await this.ctx.task.snapshotIn(state.storeId).catch(() => undefined)
        const recorded = after === undefined ? undefined : roundRunOf(after, state.rootTaskId!, requestKey)
        if (recorded !== undefined) {
          await this.mark(state, {
            round,
            phase: recorded.status === 'running' ? 'running' : recorded.status === 'verified'
              ? 'publishing' : 'debugging',
            note: `round ${round} was recorded ${recorded.status} despite its opening error: ${message(error)}; the next activation reconciles the stored attempt`,
          })
          return
        }
        if (after === undefined) {
          await this.mark(state, { round, phase: 'failed', note: `round ${round}'s opening could not be reconciled: ${message(error)}; the store could not be read, so the next activation retries the same request key` })
          return
        }
        await this.mark(state, { round, phase: 'failed', note: `round ${round} could not be opened: ${message(error)}` })
        state.stopped = true
        return
      }
    }
    await this.mark(state, { round, phase: 'running', note: `round ${round} is running` })
  }

  /** The lines both supervisor prompts share: where the round is, and what its evidence is. */
  private roundHeader(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    run: TaskRun,
    review: ReviewRecord | undefined,
  ): string[] {
    const artifacts = run.artifacts ?? []
    return [
      `Store: ${state.storeId}; root task: ${state.rootTaskId}; this round's run: ${run.runId} (session ${run.sessionId ?? 'unrecorded'}).`,
      `Round objective as recorded on the graph: ${state.config.task}`,
      `Metrics to explore and improve: ${state.config.metrics?.join('; ') || 'derive useful measurements from the task and state the assumptions'}.`,
      'Use the current task criteria to judge this execution, and its findings to improve reusable paths and experience.',
      review === undefined
        ? 'The store holds no review record for this run.'
        : `The round's review settled ${review.outcome}. ${renderSupervisorReviewFacts(review)}`,
      'Where this round\'s delivery and evidence live:',
      run.placement?.workspacePath === undefined
        ? "- the run recorded no separate working tree; read the store's evidence bundles"
        : `- the run's working tree: ${run.placement.workspacePath} (read/glob/grep it directly)`,
      ...(artifacts.length === 0
        ? ['- the run recorded no artifacts of its own']
        : artifacts.map(
            artifact =>
              `- artifact ${artifact.artifactId} (${artifact.kind}) at ${artifact.uri}${artifact.digest === undefined ? '' : ` sha256:${artifact.digest}`}`,
          )),
      review === undefined || review.evidenceRefs.length === 0
        ? '- the review recorded no evidence ids'
        : `- store evidence ids: ${review.evidenceRefs.join(', ')} (context_read kind:"evidence")`,
    ]
  }

  /** Existing review/session counters cover execution, replay and past coordination without a second cost ledger. */
  private async costFeedback(state: LoopState, run: TaskRun): Promise<string[]> {
    const snapshot = await this.ctx.task.snapshotIn(state.storeId)
    const attempts = await readReviewAgentAttempts(state.storeId)
    const sessions = [...new Set([
      ...snapshot.runs.map(item => item.sessionId),
      ...attempts.filter(attempt => attempt.started).map(attempt => attempt.sessionId),
    ])]
    const observations = new Map<string, ReviewMetrics>()
    for (const item of snapshot.reviews) {
      const sessionId = item.sessionId ?? snapshot.runs.find(candidate => candidate.runId === item.runId)?.sessionId
      if (sessionId !== undefined && item.metrics !== undefined) observations.set(sessionId, item.metrics)
    }
    const query = optionalService<{ readSession(id: SessionId): Promise<{ events: readonly SessionEvent[]; session?: SessionHeader; inheritedEventCount?: SessionLogOffset }> }>(this.ctx, 'sessionQuery')
    const live = optionalService<{ get(id: SessionId): unknown }>(this.ctx, 'sessions')
    const projections = optionalService<{
      snapshot(session: never, keys: readonly string[]): { values: Record<string, unknown> }
      restore?(checkpoint: Record<string, never>, events: readonly SessionEvent[], baseSeq: SessionLogOffset, header: SessionHeader,
        inheritedEventCount: SessionLogOffset): { snapshot: { values: Record<string, unknown> } }
    }>(this.ctx, 'sessionProjections')
    const graphObservations = new Map<string, ReviewMetrics>()
    const validTokens = (value: unknown): value is NonNullable<ReviewMetrics['tokens']> =>
      value !== undefined && value !== null && typeof value === 'object' &&
      ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(key => {
        const count = (value as Record<string, unknown>)[key]
        return typeof count === 'number' && Number.isFinite(count) && count >= 0
      })
    await Promise.all(sessions.map(async sessionId => {
      // Review metrics freeze the execution comparison. Graph totals read the
      // complete session, including model calls after the Task submitted.
      const observed: ReviewMetrics = {}
      if (live !== undefined && projections !== undefined) {
        try {
          const session = live.get(SessionId(sessionId))
          if (session !== undefined) {
            const value = projections.snapshot(session as never, ['tokenUsage']).values.tokenUsage
            if (validTokens(value)) observed.tokens = value
          }
        } catch { /* The coverage line reports an unavailable projection. */ }
      }
      if (query !== undefined) {
        try {
          const log = await query.readSession(SessionId(sessionId))
          const { events } = log
          observed.toolCalls = {
            calls: events.filter(event => event.type === 'tool/call').length,
            failures: events.filter(event => event.type === 'tool/result' &&
              ((event.data as { error?: unknown; message?: { isError?: boolean } } | undefined)?.error !== undefined ||
                (event.data as { message?: { isError?: boolean } } | undefined)?.message?.isError === true)).length,
          }
          if (observed.tokens === undefined && projections?.restore !== undefined && log.session !== undefined && log.inheritedEventCount !== undefined) {
            const value = projections.restore({}, events, SessionLogOffset(0), log.session, log.inheritedEventCount).snapshot.values.tokenUsage
            if (validTokens(value)) observed.tokens = value
          }
        } catch { /* A missing durable log remains unknown. */ }
      }
      graphObservations.set(sessionId, observed)
      observations.set(sessionId, { ...observed, ...observations.get(sessionId) })
    }))
    const auxiliary = new Map<string, ReviewMetrics>()
    const evolution = await evolutionOf(this.ctx, state.rootSessionId)
    let auxiliaryUnavailable = evolution?.experiments === undefined
    if (evolution?.experiments !== undefined) {
      for (const proposal of await evolution.list()) {
        const experiments = await evolution.experiments(proposal.proposalId).catch(() => {
          auxiliaryUnavailable = true
          return []
        })
        for (const experiment of experiments) {
          const plan = experiment.frozen.evaluation
          if (plan?.generatedResponse !== undefined) auxiliary.set(`plan:${experiment.experimentId}`, {
            ...(plan.generatedUsage === undefined ? {} : { tokens: plan.generatedUsage }), toolCalls: { calls: 0, failures: 0 },
          })
          if (experiment.judged !== undefined) auxiliary.set(`judge:${experiment.experimentId}`, {
            ...(experiment.judged.evaluation.judgeUsage === undefined ? {} : { tokens: experiment.judged.evaluation.judgeUsage }), toolCalls: { calls: 0, failures: 0 },
          })
        }
      }
    }
    return [
      renderRecordedCostFacts('Current round execution tree', runSubtree(snapshot, run.runId).map(item => item.sessionId), observations),
      renderRecordedCostFacts('Graph usage to date (executions, replay experiments and recorded coordination)', sessions, graphObservations),
      auxiliaryUnavailable ? 'Auxiliary evaluation plan/judge usage: unknown; some experiment cost reports were unavailable.' :
        auxiliary.size === 0 ? 'Auxiliary evaluation plan/judge usage: no recorded model calls.' :
        renderRecordedCostFacts('Auxiliary evaluation plan/judge usage', [...auxiliary.keys()], auxiliary, 'model calls'),
      'Compare task effects with this recorded effort, including evaluation overhead. Coverage shows available counters; an unavailable reading remains unknown.',
    ]
  }

  /** A short method prompt: library, evidence, comparison, publication and a clear ending. */
  private readonly supervisorMethod: readonly string[] = [
    'Read task_library and matching task_template_list entries, then the exact Skill or template bytes and this run\'s contracts, batches and evidence. Review temporary exploratory goals and experience; record retention or retirement with task_library review and write useful revisions in this graph\'s library.',
    'Choose the responsible skill, capability or task_definition. TaskTemplates record reusable goals and decomposition; Skills record paths, methods and conditions. Cite the evidence that supports your choice and weigh task effects with model usage and cost.',
    'Compare a useful candidate through evolution_propose → evolution_candidate → evolution_prepare → evolution_replay → evolution_gate → evolution_decide → evolution_apply. For llm-outcome, evaluation.goal is enough for an LLM-generated frozen plan; reuse real tools and artifacts. Preserve each task\'s original checks, use comparable budgets and fresh starting inputs, and identify seen cases as regression evidence.',
    'Conclude every executable proposal, keeping useful negative results and research findings. After publication inspect exact later template and Skill bindings and outcomes. The platform driver opens the next round after your supervision settles.',
    'When retaining the current methods, finish with fenced json {"outcome":"no_change","reason":"..."} and a settled proposal ledger. REJECT, KEEP_FOR_FURTHER_RESEARCH and rollback finish candidates as negative results. For a concrete obstruction use {"outcome":"blocked","reason":"..."}; for a reason to end the loop use {"outcome":"closed","reason":"..."}.',
  ]

  /** The first prompt one round's supervisor receives after a **verified** round: publish the method change the round's evidence shows. */
  private async verifiedPrompt(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    run: TaskRun,
    review: ReviewRecord | undefined,
    diagnosisId: string,
  ): Promise<string> {
    const publishedSkill = (await this.loopProposals(state))
      .filter(proposal => proposal.status === 'applied' && proposal.targetType === 'skill')
      .at(-1)
    const publishedTemplate = (await this.loopProposals(state))
      .filter(proposal => proposal.status === 'applied' && proposal.targetType === 'task_definition')
      .at(-1)
    return [
      `You are the platform RSI loop's supervisor for graph "${graph.name}" (${state.graphId}), round ${round} of ${state.config.iterationRounds}.`,
      ...this.roundHeader(state, graph, round, run, review),
      ...await this.costFeedback(state, run),
      `Current published skill of this loop: ${publishedSkill === undefined ? 'none yet — the ledger holds no applied skill for this loop' : `${publishedSkill.targetId} (proposal ${publishedSkill.proposalId}, applied)`}`,
      publishedTemplate === undefined
        ? 'Current published task template of this loop: none yet'
        : `Current published task template of this loop: ${publishedTemplate.targetId} (proposal ${publishedTemplate.proposalId}, applied)`,
      `Cite diagnosis:${diagnosisId} in evolution_propose.sourceRefs.`,
      '',
      'The round settled verified against the store\'s own acceptance criteria. Review its delivery and library experience; choose a useful improvement or retain the current method with no_change.',
      ...(round < state.config.iterationRounds ? [] : ['Final library review: review this execution\'s paths and experience for retention or revision. Settle your findings; this graph completes after review, and subsequent Tasks can test any final publication.']),
      ...this.supervisorMethod,
    ].join('\n')
  }

  /** The first prompt one round's supervisor receives after a **failed** round: debug the failure and prepare the method change the recovery round consumes. */
  private async failedPrompt(
    state: LoopState,
    graph: GraphRecord,
    round: number,
    run: TaskRun,
    review: ReviewRecord | undefined,
    diagnosisId: string,
  ): Promise<string> {
    const publishedSkill = (await this.loopProposals(state))
      .filter(proposal => proposal.status === 'applied' && proposal.targetType === 'skill')
      .at(-1)
    const publishedTemplate = (await this.loopProposals(state))
      .filter(proposal => proposal.status === 'applied' && proposal.targetType === 'task_definition')
      .at(-1)
    return [
      `You are the platform RSI loop's supervisor for graph "${graph.name}" (${state.graphId}), round ${round} of ${state.config.iterationRounds}.`,
      ...this.roundHeader(state, graph, round, run, review),
      ...await this.costFeedback(state, run),
      `Current published skill of this loop: ${publishedSkill === undefined ? 'none yet — the ledger holds no applied skill for this loop' : `${publishedSkill.targetId} (proposal ${publishedSkill.proposalId}, applied)`}`,
      publishedTemplate === undefined
        ? 'Current published task template of this loop: none yet'
        : `Current published task template of this loop: ${publishedTemplate.targetId} (proposal ${publishedTemplate.proposalId}, applied)`,
      `Cite diagnosis:${diagnosisId} in evolution_propose.sourceRefs.`,
      '',
      `The round settled ${run.status}. Debug that failure using its evidence, review and delivery, and choose the reusable method change that helps the next attempt. For a one-off environmental or input repair, retain the current methods with no_change and explain the next useful recovery.`,
      ...(round < state.config.iterationRounds ? [] : ['Final library review: retain useful failure conditions and experience, and revise methods when justified. Settle your findings; this graph completes with the recorded task outcome after review, and subsequent Tasks can test any final publication.']),
      ...this.supervisorMethod,
    ].join('\n')
  }

  /** Write one loop position, skipping a rewrite of the position the registry already holds. */
  private async mark(state: LoopState, progress: RsiProgress): Promise<void> {
    if (await this.currentGraph(state) === undefined) return
    const current = state.progress
    if (
      current !== undefined &&
      current.round === progress.round &&
      current.phase === progress.phase &&
      current.note === progress.note
    )
      return
    try {
      await this.ctx.graphs.markRsiProgress(state.graphId, progress)
      state.progress = progress
    } catch (error) {
      this.log(`rsi loop ${state.graphId}: the loop position could not be recorded (${message(error)})`)
    }
  }

  /** The loop state of one graph, created on first sight and aligned with the graph record every time it is read. */
  private loopFor(graph: GraphRecord, storeId: string): LoopState {
    const existing = this.loops.get(graph.id)
    if (existing !== undefined) {
      // Replacing config revokes the previous watcher and clears progress.
      // Resume derives from the same frozen root's recorded attempts; it does
      // not create a new business contract or reset the execution count.
      if (this.matchesGraph(existing, graph)) {
        if (existing.progress === undefined && graph.rsiProgress !== undefined) existing.progress = graph.rsiProgress
        return existing
      }
      this.forget(graph.id)
    }
    const state: LoopState = {
      graphId: graph.id,
      storeId,
      rootSessionId: String(graph.rootSessionId),
      config: graph.rsi!,
      ...(graph.rsiProgress === undefined ? {} : { progress: graph.rsiProgress }),
      stopped: false,
    }
    this.loops.set(graph.id, state)
    this.byStore.set(storeId, graph.id)
    return state
  }

  /** A graph this driver no longer schedules: its loop state goes away with its config. */
  private forget(graphId: string): void {
    const state = this.loops.get(graphId)
    if (state !== undefined) state.stopped = true
    this.loops.delete(graphId)
    // Activation declares routing/cap before the queued advance creates state.
    // Clearing at that boundary must remove those declarations as well.
    const stores = new Set([...this.byStore].filter(([, id]) => id === graphId).map(([id]) => id))
    if (state !== undefined) stores.add(state.storeId)
    for (const storeId of stores) {
      this.byStore.delete(storeId)
      unregisterGraphImprovementCap(storeId)
      this.registered.delete(storeId)
    }
  }

  /** Config replacement drops progress even when it writes identical settings. */
  private matchesGraph(state: LoopState, graph: GraphRecord): boolean {
    return graph.rsi !== undefined && String(graph.rootSessionId) === state.rootSessionId &&
      sameRsiConfig(state.config, graph.rsi) && !(state.progress !== undefined && graph.rsiProgress === undefined)
  }

  /** Re-read authority after an await and immediately before graph/recovery side effects. */
  private async currentGraph(state: LoopState): Promise<GraphRecord | undefined> {
    if (this.stopped || this.loops.get(state.graphId) !== state) return undefined
    const graph = await this.ctx.graphs.get(state.graphId).catch(() => undefined)
    if (this.stopped || this.loops.get(state.graphId) !== state || graph === undefined) return undefined
    if (!this.matchesGraph(state, graph)) {
      this.forget(state.graphId)
      return undefined
    }
    return graph
  }
}

/** The newest attempt that supervises one round's diagnosis, whether it settled or not. */
function supervisorAttemptOf(attempts: readonly ReviewAgentAttempt[], diagnosisId: string): ReviewAgentAttempt | undefined {
  return attempts.filter(attempt => attempt.role === 'supervisor' && attempt.diagnosisId === diagnosisId).at(-1)
}

/** Whether two readings agree; replacement revokes a watcher while the same frozen root's facts remain authoritative. */
function sameRsiConfig(left: RsiConfig, right: RsiConfig): boolean {
  return (
    left.task === right.task && left.iterationRounds === right.iterationRounds && left.humanReview === right.humanReview &&
    canonicalize(left.metrics ?? []) === canonicalize(right.metrics ?? [])
  )
}

/**
 * One round's supervision identity: the hand-off content this driver promises
 * for it. It is derived from the round alone, so every attempt of one round —
 * the first, the retry after a crash — carries the same promise, and the
 * ledger's own conflict check never reads two attempts of one round as two
 * different hand-offs.
 */
export function roundHandoffDigest(input: {
  readonly graphId: string
  readonly round: number
  readonly storeId: string
  readonly taskId: string
  readonly runId: string
}): string {
  return sha256Hex(canonicalize({ ...input }))
}

/** Install one deployment's RSI loop driver: every graph that carries `rsi` settings gets its platform-scheduled loop. */
export function installRsiLoopDriver(ctx: Context, options: RsiLoopOptions = {}): () => void {
  return new RsiLoopDriver(ctx, options).install()
}
