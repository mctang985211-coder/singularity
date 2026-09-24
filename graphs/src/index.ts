/**
 * Multi-graph registry: each graph binds one environment and a root session.
 * @module dsh-singularity-graphs
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@dangosys/dsh-env-builder'
import { cleanPromptText, type EnvRecord } from '@dangosys/dsh-env-builder'
import type {} from '@dangosys/dsh-singularity-graph'
import type {} from '@dangosys/dsh-singularity-layout'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { CreateGraphRequest, CreateGraphResult, GraphArchive, GraphRecord, GraphsEvent, GraphsSnapshot } from './types.ts'
import { GraphsState } from './service/state.ts'
import { setupPromptText } from './prompts/setup.prompts.ts'

export * from './types.ts'
export { GraphsState } from './service/state.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One graph-registry mutation in the graphs-registry store; the GraphsEvent union that GraphsState replays on load. */
    'graphs/event': GraphsEvent
  }
}

type StoredEvent = SessionEvent<'graphs/event'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphs: GraphsService
  }
  interface Events {
    'graphs/change'(snapshot: GraphsSnapshot): void
    'graphs/selected'(graph: GraphRecord): void
  }
}

function nextGraphId(existing: readonly string[]): string {
  let n = 1
  while (existing.includes(`graph${n}`)) n += 1
  return `graph${n}`
}

export class GraphsService extends Service {
  // taskRuntime is resolved lazily at create() time: task-runtime injects
  // graphs, so a hard inject here would deadlock the plugin loader.
  static inject = ['sessionPersistence', 'graph', 'layout', 'agentRuntime', 'envBuilder']
  private readonly ready: Promise<void>
  private readonly storeId = SessionId('graphs-registry')
  private handle: SessionHandle | undefined
  private state = new GraphsState()
  private nextSeq = 0
  private writes = Promise.resolve()
  private transitions = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'graphs')
    this.ready = this.open(ctx)
    ctx.on('agentRuntime/spawned', async ({ parentId, sessionId }) => {
      const graph = await this.graphForSession(parentId)
      ctx.envBuilder.store.attachSession(graph.envId, sessionId)
    })
    ctx.effect(
      () => async () => {
        await this.ready
        await this.transitions
        await this.writes
        await this.handle?.close()
      },
      'graphs:persistence',
    )
    ctx.effect(async () => {
      await this.ready
      const selected = this.state.selected()
      if (selected !== undefined) await this.transition(() => this.activate(selected))
      return () => {}
    }, 'graphs: boot selected')
  }

  async snapshot(): Promise<GraphsSnapshot> {
    await this.ready
    return this.state.snapshot()
  }

  async current(): Promise<GraphRecord> {
    await this.ready
    const selected = this.state.selected()
    if (selected === undefined) throw new Error('graphs: no graph selected')
    return selected
  }

  async get(id: string): Promise<GraphRecord> {
    await this.ready
    return this.state.get(id)
  }

  async view(id: string) {
    const meta = await this.get(id)
    const graph = await this.ctx.graph.snapshotIn(meta.graphStoreId)
    const layout = await this.ctx.layout.snapshotIn(meta.layoutStoreId)
    return { meta, graph, layout }
  }

  async list(): Promise<readonly GraphRecord[]> {
    await this.ready
    return this.state.snapshot().graphs
  }

  async select(id: string): Promise<GraphRecord> {
    return this.transition(async () => {
      const graph = await this.get(id)
      await this.activate(graph)
      await this.commit([{ kind: 'graph/select', id }])
      return graph
    })
  }

  async create(request: CreateGraphRequest): Promise<CreateGraphResult> {
    return this.transition(async () => {
      await this.ready
      let createdEnvId: string | undefined
      let attached: { envId: string; sessionId: SessionId } | undefined
      let rootAgentId: SessionId | undefined
      let committed = false
      try {
        const store = this.ctx.envBuilder.store
        let envId: string
        let reused = false
        if (request.envId !== undefined) {
          if (request.createEnv === true || request.workspace !== undefined || request.fresh === true) {
            throw new Error('graphs: envId cannot combine with createEnv, workspace, or fresh')
          }
          if (request.repos !== undefined) throw new Error('graphs: repos only allowed with createEnv')
          envId = request.envId
          this.assertReusable(envId)
          reused = true
        } else if (request.workspace !== undefined) {
          const label = request.workspace.trim()
          if (label.length === 0) throw new Error('graphs: workspace is empty')
          if (request.fresh !== true) {
            const matches = store.findByLabel(label)
            const available = matches.filter(env => this.isReusable(env))
            if (available.length > 0) {
              envId = available[0].id
              this.assertReusable(envId)
              reused = true
            } else if (matches.length > 0) {
              throw new Error(this.workspaceTaken(label, matches))
            }
          }
          if (!reused) {
            if (request.repos === undefined || request.repos.length === 0) {
              throw new Error('graphs: new environment requires at least one repository')
            }
            const env = store.create(label)
            envId = createdEnvId = env.id
            for (const ref of request.repos) store.planComponent(envId, ref)
          }
        } else if (request.createEnv === true) {
          if (request.repos === undefined || request.repos.length === 0) {
            throw new Error('graphs: new environment requires at least one repository')
          }
          if (request.fresh !== true) {
            const match = store.findByRepos(request.repos).find(env => this.isReusable(env))
            if (match !== undefined) {
              envId = match.id
              this.assertReusable(envId)
              reused = true
            }
          }
          if (!reused) {
            const env = store.create()
            envId = createdEnvId = env.id
            for (const ref of request.repos) store.planComponent(envId, ref)
          }
        } else {
          throw new Error('graphs: provide exactly one of createEnv, envId, workspace')
        }
        const registry = this.state.snapshot()
        const id = nextGraphId([
          ...registry.graphs.map(graph => graph.id),
          ...registry.archives.map(archive => archive.graph.id),
        ])
        const name = request.name === undefined ? id : request.name.trim()
        if (name.length === 0) throw new Error('graphs: name is empty')
        const rootSessionId = SessionId(randomUUID())
        const graphStoreId = `sg-g-${rootSessionId}`
        const layoutStoreId = `sg-l-${rootSessionId}`

        const handle = await this.ctx.agentRuntime.createRoot({
          sessionId: rootSessionId,
          cwd: this.ctx.envBuilder.store.get(envId).path,
          scope: { graphStoreId, layoutStoreId },
        })
        rootAgentId = handle.agent.id
        // **The graph creates no task** (A0 §1.1) and it registers before it
        // recovers (A2 §E): the environment is attached and `graph/add` commits —
        // selectedId included, so the new graph is visible while it is still
        // recovering — and the same activation entry below then runs its recovery
        // barrier (`adoptRoot`: open the store, bind an existing root, recover
        // it). A fresh graph's store therefore holds no task at all until its
        // root agent intakes a contract; a barrier failure keeps the registered
        // graph selected and shows the reason rather than pretending the
        // previous selection stood, so the failure can be retried explicitly.
        this.ctx.envBuilder.store.attachSession(envId, handle.agent.id)
        attached = { envId, sessionId: handle.agent.id }
        this.ctx.envBuilder.store.select(envId)

        const graph: GraphRecord = {
          id,
          name,
          envId,
          rootSessionId: handle.agent.id,
          graphStoreId,
          layoutStoreId,
          createdAt: Date.now(),
          ready: false,
        }
        await this.commit([{ kind: 'graph/add', graph }])
        committed = true
        await this.activate(graph)
        const env = this.ctx.envBuilder.store.get(envId)
        await this.ctx.agentRuntime.prompt(handle.agent, [
          {
            type: 'text',
            text: setupPromptText(id, env),
          },
        ])
        return { graph, reused }
      } catch (error) {
        if (committed) throw error
        if (attached !== undefined) {
          await this.ctx.agentRuntime.stopAgents([attached.sessionId])
          this.ctx.envBuilder.store.detachSession(attached.envId, attached.sessionId)
        } else if (rootAgentId !== undefined) {
          await this.ctx.agentRuntime.stopAgents([rootAgentId])
        }
        if (createdEnvId !== undefined) this.ctx.envBuilder.store.delete(createdEnvId)
        throw error
      }
    })
  }

  private isReusable(env: EnvRecord): boolean {
    return env.components.length > 0 && !this.state.boundEnvIds().has(env.id) && env.sessionIds.length === 0
  }

  private assertReusable(envId: string): void {
    const occupant = this.state.snapshot().graphs.find(graph => graph.envId === envId)
    if (occupant !== undefined) {
      throw new Error(
        `graphs: environment "${envId}" already bound to graph "${occupant.id}" ("${occupant.name}"); ` +
          `release it with POST /singularity/graphs/${occupant.id}/delete or choose another environment`,
      )
    }
    const env = this.ctx.envBuilder.store.get(envId)
    if (env.components.length === 0) throw new Error(`graphs: environment "${envId}" has no repositories`)
    if (env.sessionIds.length > 0) throw new Error(`graphs: environment "${envId}" still has sessions`)
  }

  private workspaceTaken(label: string, matches: readonly EnvRecord[]): string {
    const details = matches
      .map(env => {
        const occupant = this.state.snapshot().graphs.find(graph => graph.envId === env.id)
        const reason =
          occupant !== undefined
            ? `bound to graph "${occupant.id}"`
            : env.sessionIds.length > 0
              ? `has ${env.sessionIds.length} session(s)`
              : 'has no repositories'
        return `${env.id} (${reason})`
      })
      .join(', ')
    return (
      `graphs: workspace "${label}" is taken by ${details}; ` +
      'release the occupying graph with POST /singularity/graphs/<id>/delete or choose another workspace name'
    )
  }

  async markReady(id: string): Promise<GraphRecord> {
    await this.ready
    await this.commit([{ kind: 'graph/ready', id }])
    return this.state.get(id)
  }

  async graphForSession(sessionId: SessionId): Promise<GraphRecord> {
    await this.ready
    for (const graph of this.state.snapshot().graphs) {
      const snapshot = await this.ctx.graph.snapshotIn(graph.graphStoreId)
      if (snapshot.agents.some(agent => agent.id === sessionId)) return graph
    }
    throw new Error(`graphs: session "${sessionId}" is not in a graph`)
  }

  async remove(id: string): Promise<void> {
    return this.transition(async () => {
      const graph = await this.get(id)
      const scope = { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId }
      // The task tree is stopped before its graph is: a batch driver still
      // running would otherwise keep spawning workers into an environment that is
      // being cleaned. The runtime is resolved lazily, the same way `create`
      // resolves it, and a deployment without it (or without this graph's task
      // store) simply has nothing to cancel. `cancelGraph` itself is idempotent,
      // so a repeated removal is safe (A3 §3.6).
      const taskRuntime = (this.ctx.get?.('taskRuntime') ?? this.ctx.taskRuntime) as Context['taskRuntime'] | undefined
      if (taskRuntime !== undefined) {
        await taskRuntime.cancelGraph(rootTaskStoreId(graph.rootSessionId), 'graph removed')
      }
      await this.ctx.agentRuntime.stopGraph(scope)
      const root = await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, {
        graphStoreId: graph.graphStoreId,
        layoutStoreId: graph.layoutStoreId,
      })
      let stop!: () => void
      let timer!: ReturnType<typeof setTimeout>
      const cleaned = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`graphs: env clean timed out for "${graph.envId}"`)), 10 * 60 * 1000)
        stop = this.ctx.on('envBuilder/cleaned', (envId: string) => {
          if (envId === graph.envId) resolve()
        })
      })
      try {
        await Promise.all([
          this.ctx.agentRuntime.spawn(root.agent, {
            sessionId: SessionId(randomUUID()),
            name: 'env-clean',
            prompt: [{ type: 'text', text: cleanPromptText(graph.envId) }],
          }),
          cleaned,
        ])
      } finally {
        clearTimeout(timer)
        stop()
        await this.ctx.agentRuntime.stopGraph(scope)
      }
      const snapshot = await this.ctx.graph.snapshotIn(graph.graphStoreId)
      const archive: GraphArchive = { graph, agentIds: snapshot.agents.map(agent => agent.id), archivedAt: Date.now() }
      await this.commit([{ kind: 'graph/remove', id, archive }])
      const selected = this.state.selected()
      if (selected !== undefined) await this.activate(selected)
      else {
        this.ctx.graph.clearActive()
        this.ctx.layout.clearActive()
      }
    })
  }

  /**
   * One graph becomes this process's running environment, in the fixed order
   * (A2 §E): the root session's graph queue is drained by `ensureRoot` first,
   * then the root store's recovery barrier runs to its end — the fact
   * reconciliation, every known session's gate initialization and the driver
   * registrations the pass owes, never the batch execution behind them — and
   * only then does this process switch its stores and environment and deliver
   * input. Boot recovery of the selected graph goes through here too, not
   * through an asynchronous selected-listener.
   *
   * A barrier failure leaves the commit to the caller: `select` has not
   * committed (the previous selection stands), `remove`'s re-activation of the
   * next graph fails loudly, and `create` keeps the registered graph selected
   * and shows the failure rather than pretending the old selection stood.
   */
  private async activate(graph: GraphRecord): Promise<void> {
    await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, {
      graphStoreId: graph.graphStoreId,
      layoutStoreId: graph.layoutStoreId,
    })
    // The recovery barrier, resolved lazily the way `create` resolves it:
    // task-runtime injects graphs, so a hard inject here would deadlock the
    // plugin loader. A deployment without the runtime cannot open a root
    // store at all, so the activation refuses by name rather than skipping
    // recovery.
    const taskRuntime = (this.ctx.get?.('taskRuntime') ?? this.ctx.taskRuntime) as Context['taskRuntime'] | undefined
    if (taskRuntime === undefined) {
      throw new Error('graphs: taskRuntime service is not loaded; cannot recover the root store')
    }
    await taskRuntime.adoptRoot(rootTaskStoreId(graph.rootSessionId), graph.rootSessionId)
    await this.ctx.graph.switchStore(graph.graphStoreId)
    await this.ctx.layout.switchStore(graph.layoutStoreId)
    this.ctx.envBuilder.store.select(graph.envId)
    this.ctx.emit('graphs/selected', graph)
    this.ctx.emit('graph/change', await this.ctx.graph.snapshot())
    this.ctx.emit('layout/change', await this.ctx.layout.snapshot())
  }

  private async commit(events: readonly GraphsEvent[]): Promise<void> {
    if (events.length === 0) throw new Error('graphs: cannot commit an empty event batch')
    const run = this.writes.then(async () => {
      await this.ready
      const next = this.state.clone()
      for (const event of events) next.apply(event)
      const records = events.map((event, index): StoredEvent => ({
        type: 'graphs/event',
        seq: SessionSeq(this.nextSeq + index),
        time: Date.now(),
        data: event,
        ignorable: true,
      }))
      await this.handle!.append(records)
      this.state = next
      this.nextSeq += records.length
      this.ctx.emit('graphs/change', this.state.snapshot())
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private transition<T>(work: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(work)
    this.transitions = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async open(ctx: Context): Promise<void> {
    const listed = (await ctx.sessionPersistence.list()).filter(item => item.header.id === this.storeId)
    if (listed.length > 1) throw new Error(`graphs: duplicate store session "${this.storeId}"`)
    this.handle =
      listed.length === 0
        ? await ctx.sessionPersistence.create(this.header())
        : await ctx.sessionPersistence.open(this.storeId, 'write')
    const { events } = await this.handle.read()
    for (const event of events) {
      if (event.type !== 'graphs/event' || event.ignorable !== true) {
        throw new Error(`graphs: invalid persisted event at seq ${event.seq}`)
      }
      const stored = event as StoredEvent
      const next = this.state.clone()
      next.apply(stored.data)
      this.state = next
      this.nextSeq = event.seq + 1
    }
    await this.handle.flush()
  }

  private header(): SessionHeader {
    return { version: SESSION_FORMAT_VERSION, id: this.storeId, createdAt: Date.now(), isSeeded: false }
  }
}

export default GraphsService
