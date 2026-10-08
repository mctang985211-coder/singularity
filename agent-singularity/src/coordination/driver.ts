/**
 * The one coordinator this platform runs: a per-graph serial driver that reads
 * facts, reduces them once and executes that step, waking on events with a
 * two-second fallback pass. It never awaits a supervision session — a session
 * ends on its own, and `agent/status: idle`, a completion write or the fallback
 * tick brings the driver back to look again.
 *
 * Whether a graph is driven at all is decided by its protocol marker
 * (`graphAccess(graph).mode`), never by a configuration field: a sealed legacy
 * graph is not even read here.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/driver
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { graphAccess, type GraphRecord } from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId, type TaskSnapshot } from '@dangosys/dsh-singularity-task'
import {
  bubbleWorkspacePath,
  executionUsage,
  materializeBubble,
  optionalService,
  settleBubble,
  type ExecutionUsage,
  type RootRecoveryRequest,
} from '@dangosys/dsh-singularity-task-runtime'
import { warnLine } from '../log.ts'
import { message } from '../shared.ts'
import { subjectDigest, type AssignmentRequest } from './assignment.ts'
import { bindingOfAssignment, protocolFailure } from './completion.ts'
import { coordinationBindingSource, coordinationBudget, coordinationFile, readCoordinationRows, recordCompletion, workOf, serializeCoordination, type CoordinatedWork, type CoordinationRow } from './store.ts'
import { liveRootAgentOf } from './identity.ts'
import { activeMethodRevision } from './method-read.ts'
import { supervisionPrompt } from './prompts.ts'
import { reduce, roundKeyOf, type Reduction, type ReductionFacts } from './reducer.ts'
import { aggregateUsage, renderExecutionCost } from './render.ts'
import { reviewerGrant, supervisorGrant, COORDINATION_PRESET } from './roles.ts'
import { rootTaskOf, roundDiagnosis, roundDiagnosisId, terminalRootRuns } from './rounds.ts'
import { flushSessions, readSessionFactsOf, sessionSpent, type CoordinationSessionFacts } from './session-facts.ts'
import { spawnAssignment } from './spawn-assignment.ts'
import { registerGraphImprovementCap, unregisterGraphImprovementCap } from './supervision.ts'
import { backgroundScan } from './trigger.ts'

/** How one driver is installed. */
export interface CoordinationDriverOptions {
  readonly log?: (line: string) => void
  /** The fallback reconciliation period; events are the first wake-up source. */
  readonly fallbackMs?: number
  /** How long one completed session's own log may take to materialize before the next round opens anyway. */
  readonly settleGraceMs?: number
}

/** This process's coordination driver over the graph registry. */
export class CoordinationDriver {
  private readonly ctx: Context
  private readonly log: (line: string) => void
  private readonly fallbackMs: number
  private readonly settleGraceMs: number
  private readonly byStore = new Map<string, string>()
  private readonly registered = new Set<string>()
  /** Graphs holding an unsettled work item: the only ones the fallback tick reads. */
  private readonly active = new Set<string>()
  private readonly disposers: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(ctx: Context, options: CoordinationDriverOptions = {}) {
    this.ctx = ctx
    this.log = options.log ?? warnLine(ctx)
    this.fallbackMs = options.fallbackMs ?? 2000
    this.settleGraceMs = options.settleGraceMs ?? 30_000
  }

  /** Subscribe to every wake-up source, take the registry's graphs over, and start the fallback tick. */
  install(): () => void {
    this.log(`coordination: assignments are kept in ${coordinationFile()}`)
    this.warnAboutRetiredNames()
    this.disposers.push(
      this.ctx.taskRuntime.registerTerminalReviewListener(fact => {
        const graphId = this.byStore.get(fact.storeId)
        if (graphId !== undefined) void this.wake(graphId).catch(error => this.logLine(graphId, error))
      }),
    )
    const on = this.ctx.on.bind(this.ctx) as unknown as (name: string, listener: (payload: never) => void) => () => void
    this.disposers.push(
      on('agent/status', payload => {
        const { agent, status } = payload as unknown as { agent: { id: string }; status: string }
        if (status !== 'idle') return
        void this.wakeBySession(agent.id)
      }),
    )
    this.disposers.push(on('graphs/selected', graph => this.observe(graph as unknown as GraphRecord)))
    this.disposers.push(
      on('graphs/change', snapshot => this.observeAll((snapshot as unknown as { graphs: readonly GraphRecord[] }).graphs)),
    )
    backgroundScan(this.log, 'coordination driver', () => this.seed())
    this.timer = setInterval(() => {
      for (const graphId of this.active) void this.wake(graphId).catch(error => this.logLine(graphId, error))
    }, this.fallbackMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  /** Release every subscription, cap and timer of this instance. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.log(`coordination: a subscription could not be released (${message(error)})`)
      }
    }
    for (const storeId of this.registered) unregisterGraphImprovementCap(storeId)
    this.registered.clear()
    this.byStore.clear()
    this.active.clear()
  }

  /** Read the registry once: a graph the platform already holds gets its loop taken over here. */
  async seed(): Promise<void> {
    if (this.stopped) return
    const graphs = this.ctx.graphs as { list?: () => Promise<readonly GraphRecord[]> } | undefined
    if (typeof graphs?.list !== 'function') return
    const all = await graphs.list()
    this.observeAll(all)
    await Promise.all(all.map(async graph => await this.wake(graph.id).catch(error => this.logLine(graph.id, error))))
  }

  /** One graph activation: remember it when it is a current graph with RSI settings, forget it otherwise. */
  observe(graph: GraphRecord): void {
    if (this.stopped) return
    if (graph.rsi === undefined || graphAccess(graph).mode !== 'current') {
      this.forget(graph.id)
      return
    }
    const storeId = this.remember(graph)
    this.log(`coordination: graph ${graph.id} runs ${graph.rsi.iterationRounds} round(s) over store ${storeId}`)
    void this.wake(graph.id).catch(error => this.logLine(graph.id, error))
  }

  /** Reconcile the driven set against the registry: what gained settings joins, what lost them leaves. */
  observeAll(graphs: readonly GraphRecord[]): void {
    const live = new Set<string>()
    for (const graph of graphs) {
      if (graph.rsi === undefined || graphAccess(graph).mode !== 'current') continue
      this.remember(graph)
      live.add(graph.id)
    }
    for (const graphId of new Set(this.byStore.values())) if (!live.has(graphId)) this.forget(graphId)
  }

  /** One pass for one graph, inside its own serial region. */
  wake(graphId: string): Promise<Reduction | undefined> {
    if (this.stopped) return Promise.resolve(undefined)
    return serializeCoordination(graphId, () => this.reconcile(graphId))
  }

  /** The graph one idle session belongs to, from the session's own coordination assignment. */
  private async wakeBySession(sessionId: string): Promise<void> {
    const binding = await coordinationBindingSource()
      .read(sessionId)
      .catch(() => undefined)
    if (binding === undefined) return
    const graphId = this.byStore.get(binding.rootStoreId)
    if (graphId === undefined) return
    await this.wake(graphId).catch(error => this.logLine(graphId, error))
  }

  /** Read facts → reduce → execute once, repeated while the facts keep moving; never awaits a session. */
  async reconcile(graphId: string): Promise<Reduction | undefined> {
    let last: Reduction | undefined
    for (let pass = 0; pass < 8; pass += 1) {
      const step = await this.once(graphId)
      if (step === undefined) return last
      last = step
      const again = await this.execute(graphId, step)
      if (!again) return step
    }
    return last
  }

  /** The work items one graph holds, as the driver reads them. */
  async workOf(graphId: string): Promise<readonly CoordinatedWork[]> {
    return await workOf((await readCoordinationRows()) ?? [], graphId)
  }

  /** One read-and-decide pass; `undefined` means this graph is not driven here any more. */
  private async once(graphId: string): Promise<Reduction | undefined> {
    const graph = await this.readGraph(graphId)
    if (graph === undefined) return undefined
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    const snapshot = await this.ctx.task.snapshotIn(storeId).catch(error => {
      this.log(`coordination: store ${storeId} could not be read (${message(error)})`)
      return undefined
    })
    if (snapshot === undefined) return { kind: 'idle', detail: `store ${storeId} could not be read` }
    const rootLive = liveRootAgentOf(this.ctx, storeId)
    const facts = await this.factsFor(graph, storeId, snapshot, rootLive !== undefined)
    return facts === undefined ? { kind: 'idle', detail: 'the store holds no settled round yet' } : reduce(facts)
  }

  /** The graph as this driver may drive it now, or `undefined` after forgetting it. */
  private async readGraph(graphId: string): Promise<GraphRecord | undefined> {
    if (this.stopped) return undefined
    const graph = await this.ctx.graphs.get(graphId).catch(error => {
      this.log(`coordination: graph ${graphId} could not be read (${message(error)})`)
      return undefined
    })
    if (graph === undefined || graph.rsi === undefined || graphAccess(graph).mode !== 'current') {
      this.forget(graphId)
      return undefined
    }
    this.remember(graph)
    return graph
  }

  /** The facts one decision is made from, or `undefined` when the graph has no settled round yet. */
  private async factsFor(
    graph: GraphRecord,
    storeId: string,
    snapshot: TaskSnapshot,
    rootLive: boolean,
  ): Promise<ReductionFacts | undefined> {
    const config = graph.rsi!
    const root = rootTaskOf(snapshot)
    if (root === undefined) return undefined
    const rounds = terminalRootRuns(snapshot, root.taskId)
    const run = rounds.at(-1)
    if (run === undefined) return undefined
    const epoch = config.epoch ?? 1
    const businessRound = rounds.length
    const key = roundKeyOf({ graphId: graph.id, epoch, businessRound, taskId: root.taskId, runId: run.runId })
    const rows = (await readCoordinationRows()) ?? []
    const sessions = await readSessionFactsOf(this.ctx, [
      ...rows.filter(row => row.graphId === graph.id).map(row => row.sessionId),
      String(graph.rootSessionId),
    ])
    const candidate: AssignmentRequest = {
      key,
      storeId,
      sessionId: SessionId(randomUUID()),
      actor: String(graph.rootSessionId),
      digest: subjectDigest(key),
      focus:
        run.status === 'verified'
          ? `the RSI loop's publication for round ${businessRound}`
          : `the RSI loop's repair of round ${businessRound}`,
      ...(graph.model === undefined ? {} : { model: graph.model }),
    }
    return {
      graph: { id: graph.id, name: graph.name, storeId, rootSessionId: String(graph.rootSessionId), config },
      snapshot,
      rows,
      sessions,
      budget: { used: spentOf(rows, storeId, sessions), max: coordinationBudget() },
      rootLive,
      candidate,
    }
  }

  /** Run one reduction's action; `true` when the caller should look again immediately. */
  private async execute(graphId: string, step: Reduction): Promise<boolean> {
    await this.refreshActive(graphId).catch(() => undefined)
    switch (step.kind) {
      case 'idle':
        return false
      case 'suspended':
        this.log(`coordination: graph ${graphId} ${step.phase} — ${step.detail}`)
        this.active.delete(graphId)
        return false
      case 'protocol-failure': {
        await recordCompletion(protocolFailure(bindingOfAssignment(step.work.assignment, false), step.detail))
        this.log(`coordination: graph ${graphId} protocol failure — ${step.detail}`)
        return true
      }
      case 'open-round':
        await this.openRound(graphId, step.request, step.work)
        return true
      case 'supervise':
        return await this.supervise(graphId, step)
    }
  }

  /** Keep the fallback tick pointed at the graphs that still have an unsettled work item. */
  private async refreshActive(graphId: string): Promise<void> {
    const rows = (await readCoordinationRows()) ?? []
    const unsettled = await workOf(rows, graphId)
    if (unsettled.some(work => work.completion === undefined)) this.active.add(graphId)
    else this.active.delete(graphId)
  }

  /** Claim or recover the round's supervisor. */
  private async supervise(graphId: string, step: Extract<Reduction, { kind: 'supervise' }>): Promise<boolean> {
    const graph = await this.readGraph(graphId)
    if (graph === undefined) return false
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    const liveRoot = liveRootAgentOf(this.ctx, storeId)
    if (liveRoot === undefined) {
      this.log(`coordination: graph ${graphId} cannot be supervised here — the graph's root session is not live in this process`)
      this.active.add(graphId)
      return false
    }
    if (step.plan.kind === 'resume') return await this.resume(graph, step.plan.work)
    const reuse = step.plan.kind === 'assign' ? step.plan.reuseSessionId : undefined
    const request: AssignmentRequest = { ...step.request, ...(reuse === undefined ? {} : { sessionId: SessionId(reuse) }) }
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const rootTask = rootTaskOf(snapshot)
    const run = rootTask === undefined ? undefined : terminalRootRuns(snapshot, rootTask.taskId).at(-1)
    const businessRound = request.key.subject.kind === 'round' ? request.key.subject.businessRound : 0
    if (run === undefined) {
      this.log(`coordination: graph ${graphId} round ${businessRound} has no settled run to hand a supervisor`)
      this.active.delete(graphId)
      return false
    }
    await this.settleRoundBubble(graph, businessRound)
    const prompt = await this.supervisionText(request, snapshot, graph, run.runId)
    const spawned = await spawnAssignment({
      ctx: this.ctx,
      request,
      parent: liveRoot.agent,
      name: `rsi supervisor for ${graphId} round ${businessRound}`,
      preset: COORDINATION_PRESET,
      grant: supervisorGrant(),
      role: 'supervisor',
      prompt: () => prompt,
    })
    this.active.add(graphId)
    this.log(
      `coordination: graph ${graphId} round ${businessRound} ${
        spawned.kind === 'spawned'
          ? `supervisor session ${String(request.sessionId)} assigned`
          : `supervisor could not be spawned (${spawned.failure})`
      }`,
    )
    return false
  }

  /** Bring a stored session that never finished its turn back, under the assignment's own composition. */
  private async resume(graph: GraphRecord, work: CoordinatedWork): Promise<boolean> {
    const assignment = work.assignment
    try {
      await this.ctx.agentRuntime.resumeCoordinationSession({
        sessionId: SessionId(assignment.sessionId),
        scope: { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId },
        coordinationRole: assignment.role,
        agentPreset: COORDINATION_PRESET,
        grant: assignment.role === 'supervisor' ? supervisorGrant() : reviewerGrant(),
        permissionPreset: 'danger-full-access',
      })
      this.active.add(graph.id)
      this.log(`coordination: graph ${graph.id} resumed ${assignment.role} session ${assignment.sessionId}`)
    } catch (error) {
      await recordCompletion(
        protocolFailure(
          bindingOfAssignment(assignment, false),
          `the coordination session could not be resumed: ${message(error)}`,
        ),
      ).catch(() => undefined)
      this.log(`coordination: graph ${graph.id} could not resume session ${assignment.sessionId} (${message(error)})`)
    }
    return false
  }

  /** Flush the concluded session, record the round's diagnosis, and open the next round. */
  private async openRound(
    graphId: string,
    request: Extract<Reduction, { kind: 'open-round' }>['request'],
    work: CoordinatedWork,
  ): Promise<void> {
    const graph = await this.readGraph(graphId)
    if (graph === undefined) return
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    const rootSessionId = String(graph.rootSessionId)
    await flushSessions(this.ctx)
    await this.awaitMaterialized(work.assignment.sessionId)
    if ((await this.readGraph(graphId)) === undefined) return
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const root = rootTaskOf(snapshot)
    if (root === undefined) return
    const config = graph.rsi!
    const epoch = config.epoch ?? 1
    const diagnosisId = roundDiagnosisId(graphId, epoch, request.businessRound - 1)
    if (!snapshot.diagnoses.some(item => item.diagnosisId === diagnosisId)) {
      const source = terminalRootRuns(snapshot, root.taskId).at(-1)
      if (source !== undefined) {
        const review = snapshot.reviews.find(item => item.runId === source.runId)
        await this.ctx.task
          .recordDiagnosisIn(
            storeId,
            roundDiagnosis({
              diagnosisId,
              taskId: root.taskId,
              graphId,
              graphName: graph.name,
              epoch,
              businessRound: request.businessRound - 1,
              rounds: config.iterationRounds,
              objective: config.task,
              run: source,
              ...(review === undefined ? {} : { review }),
              producedBySessionId: rootSessionId,
            }),
            rootSessionId,
          )
          .catch(error => this.log(`coordination: graph ${graphId} could not record its round diagnosis (${message(error)})`))
      }
    }
    const envPath = await this.envPathOf(graph)
    const workspacePath =
      envPath === undefined
        ? undefined
        : await materializeBubble(envPath, bubbleHome(), rootSessionId, graphId, request.businessRound).catch(error => {
            this.log(`coordination: graph ${graphId} round ${request.businessRound} bubble could not be materialized (${message(error)})`)
            return undefined
          })
    const sourceTaskId = work.assignment.subject.source.taskId
    const recovery: RootRecoveryRequest = {
      sourceTaskId,
      sourceRunId: request.sourceRunId,
      sourceDiagnosisId: request.sourceDiagnosisId,
      requestKey: request.requestKey,
      mode: request.mode,
      ...(request.mode === 'improve' ? { reuses: [] } : {}),
      ...(workspacePath === undefined ? {} : { workspacePath }),
    }
    try {
      const outcome = await this.ctx.taskRuntime.recoverRootTask(storeId, recovery, { sessionId: rootSessionId })
      this.log(
        `coordination: graph ${graphId} round ${request.businessRound} ${
          outcome.attempt === 'started' ? 'opened' : 'was already open'
        } — run ${outcome.runId} (${outcome.status})`,
      )
    } catch (error) {
      const after = await this.ctx.task.snapshotIn(storeId).catch(() => undefined)
      const recorded =
        after === undefined
          ? undefined
          : terminalRootRuns(after, root.taskId).find(run => run.recovery?.requestKey === request.requestKey)
      this.log(
        recorded === undefined
          ? `coordination: graph ${graphId} round ${request.businessRound} could not be opened (${message(error)}); ` +
            'the same request key is retried on the next activation'
          : `coordination: graph ${graphId} round ${request.businessRound} was recorded ${recorded.status} despite its ` +
            `opening error (${message(error)}); the next activation reconciles the stored attempt`,
      )
    }
  }

  /** Wait, bounded, for one completed session's own log to reach the persistence layer. */
  private async awaitMaterialized(sessionId: string): Promise<void> {
    const persistence = optionalService<{ stat?(id: string): Promise<unknown> }>(this.ctx, 'sessionPersistence')
    if (typeof persistence?.stat !== 'function') return
    const deadline = Date.now() + this.settleGraceMs
    while (Date.now() < deadline) {
      if ((await persistence.stat(sessionId).catch(() => undefined)) !== undefined) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** The one supervision request one round's supervisor receives. */
  private async supervisionText(
    request: AssignmentRequest,
    snapshot: TaskSnapshot,
    graph: GraphRecord,
    runId: string,
  ): Promise<string> {
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    const root = rootTaskOf(snapshot)
    const rounds = root === undefined ? [] : terminalRootRuns(snapshot, root.taskId)
    const run = rounds.find(candidate => candidate.runId === runId) ?? rounds.at(-1)!
    const subject = request.key.subject
    const businessRound = subject.kind === 'round' ? subject.businessRound : rounds.length
    const config = graph.rsi!
    const epoch = config.epoch ?? 1
    const method = await activeMethodRevision(this.ctx, String(graph.rootSessionId))
    const review = snapshot.reviews.find(item => item.runId === run.runId)
    return supervisionPrompt({
      graphId: graph.id,
      graphName: graph.name,
      epoch,
      businessRound,
      searchRound: subject.kind === 'round' ? subject.searchRound : businessRound,
      rounds: config.iterationRounds,
      objective: config.task,
      metrics: config.metrics ?? [],
      outcome: run.status === 'verified' ? 'verified' : 'failed',
      run,
      ...(review === undefined ? {} : { review }),
      diagnosisId: roundDiagnosisId(graph.id, epoch, businessRound),
      cost: await this.costLines(storeId, snapshot, run.runId),
      method: { ...(method === undefined ? {} : { activeRevision: method.revisionId }) },
      finalRound: businessRound >= config.iterationRounds,
    })
  }

  /** The round's and the graph's recorded effort, read from execution receipts alone. */
  private async costLines(storeId: string, snapshot: TaskSnapshot, runId: string | undefined): Promise<string[]> {
    const receipts = await this.ctx.taskRuntime.receiptsOfStore(storeId).catch(() => [])
    const round = receipts.find(receipt => receipt.runId === runId)
    const roundUsage: ExecutionUsage | undefined = round === undefined ? undefined : executionUsage(snapshot, round)
    const totalUsage = aggregateUsage(receipts.map(receipt => executionUsage(snapshot, receipt)))
    return [
      renderExecutionCost('Current round execution tree', roundUsage, round?.subtree.length ?? 0),
      renderExecutionCost('Graph usage to date (executions and recorded coordination)', totalUsage, receipts.length),
      'Compare task effects with this recorded effort, including evaluation overhead. A reading an execution receipt does not carry remains unknown.',
    ]
  }

  /** The environment checkout one graph binds, when this deployment has an env builder. */
  private async envPathOf(graph: GraphRecord): Promise<string | undefined> {
    const envBuilder = optionalService<{ store?: { get(id: string): { path: string } } }>(this.ctx, 'envBuilder')
    if (typeof envBuilder?.store?.get !== 'function') return undefined
    try {
      return envBuilder.store.get(graph.envId).path
    } catch {
      return undefined
    }
  }

  /** Persist one settled round's bubble, so the next round materializes from it. */
  private async settleRoundBubble(graph: GraphRecord, round: number): Promise<void> {
    const envPath = await this.envPathOf(graph)
    if (envPath === undefined || round <= 0) return
    await settleBubble(envPath, bubbleWorkspacePath(bubbleHome(), String(graph.rootSessionId), round), graph.id, round).catch(
      error => this.log(`coordination: graph ${graph.id} round ${round} bubble could not be settled (${message(error)})`),
    )
  }

  /** Bind one store to its graph before anything is read from it. */
  private remember(graph: GraphRecord): string {
    const storeId = rootTaskStoreId(String(graph.rootSessionId))
    this.byStore.set(storeId, graph.id)
    registerGraphImprovementCap(storeId, graph.rsi?.iterationRounds ?? 0)
    this.registered.add(storeId)
    return storeId
  }

  /** A graph this driver no longer drives: its cap goes away with it. */
  private forget(graphId: string): void {
    for (const [storeId, id] of [...this.byStore]) {
      if (id !== graphId) continue
      this.byStore.delete(storeId)
      unregisterGraphImprovementCap(storeId)
      this.registered.delete(storeId)
    }
    this.active.delete(graphId)
  }

  /** The retired environment names, said at startup instead of being silently honoured (R20). */
  private warnAboutRetiredNames(): void {
    const retired = ['SINGULARITY_REVIEW_LEDGER_DIR', 'SINGULARITY_REVIEW_AGENT_BUDGET'].filter(
      name => (process.env[name] ?? '').length > 0,
    )
    if (retired.length === 0) return
    this.log(
      `coordination: ${retired.join(' and ')} ${retired.length === 1 ? 'is' : 'are'} no longer read; ` +
        `this deployment's coordination store is ${coordinationFile()}`,
    )
  }

  private logLine(graphId: string, error: unknown): void {
    this.log(`coordination: graph ${graphId}: ${message(error)}`)
  }
}

/** How many assignments of one store have materialized a session — the spend the allowance counts. */
function spentOf(
  rows: readonly CoordinationRow[],
  storeId: string,
  sessions: ReadonlyMap<string, CoordinationSessionFacts>,
): number {
  return rows
    .filter(row => row.kind === 'assignment' && row.storeId === storeId)
    .filter(row => sessionSpent(sessions.get(row.sessionId))).length
}

/** The bubble home this deployment's round workspaces live under. */
function bubbleHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Install one deployment's coordination driver and register its fact reader. */
export function installCoordinationDriver(
  ctx: Context,
  options: CoordinationDriverOptions = {},
): { readonly driver: CoordinationDriver; readonly dispose: () => void } {
  const driver = new CoordinationDriver(ctx, options)
  const stop = driver.install()
  return { driver, dispose: stop }
}
