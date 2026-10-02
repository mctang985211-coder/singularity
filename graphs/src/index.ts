/** @module dsh-singularity-graphs */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EventStoreSet } from '@dangosys/dsh-singularity-task'
import type { EnvRecord, EnvStore } from '@dangosys/dsh-env-builder'
import type {} from '@dangosys/dsh-singularity-graph'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type {
  CreateGraphRequest,
  CreateGraphResult,
  GraphArchive,
  GraphRecord,
  GraphsEvent,
  GraphsSnapshot,
} from './types.ts'
import { GraphsState, isReusableEnv } from './service/state.ts'
import { setupPromptText } from './prompts/setup.prompts.ts'

export * from './types.ts'
export { GraphsState, isReusableEnv } from './service/state.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One graph-registry mutation in the graphs-registry store; the GraphsEvent union that GraphsState replays on load. */
    'graphs/event': GraphsEvent
  }
}

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

/** The registry's own answer when no graph publishes a session; distinguishable by code from a failed read. */
export const SESSION_NOT_IN_GRAPH = 'graph-session-not-found'

/** See {@link SESSION_NOT_IN_GRAPH}: the one error that means "no graph holds this session". */
export class SessionNotInGraphError extends Error {
  readonly code = SESSION_NOT_IN_GRAPH

  constructor(sessionId: SessionId | string) {
    super(`graphs: session "${String(sessionId)}" is not in a graph`)
    this.name = 'SessionNotInGraphError'
  }
}

/** The environment a create request resolves to: an existing one by id, or the label and repos of a new one. */
type EnvChoice =
  { readonly reuse: string } | { readonly create: { readonly label?: string; readonly repos: readonly string[] } }

export class GraphsService extends Service {
  static inject = ['sessionPersistence', 'graph', 'layout', 'agentRuntime', 'envBuilder']
  private readonly stores: EventStoreSet<'graphs/event', GraphsSnapshot, GraphsState>
  private readonly storeId = SessionId('graphs-registry')
  private readonly ready: Promise<void>
  private transitions = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'graphs')
    this.stores = new EventStoreSet<'graphs/event', GraphsSnapshot, GraphsState>(ctx, {
      namespace: 'graphs',
      eventType: 'graphs/event',
      changeEvent: 'graphs/change',
      createState: () => new GraphsState(),
    })
    this.ready = this.stores.open(this.storeId, 'auto').then(() => undefined)
    ctx.on('agentRuntime/spawned', async ({ parentId, sessionId }) => {
      const graph = await this.graphForSession(parentId)
      ctx.envBuilder.store.attachSession(graph.envId, sessionId)
    })
    ctx.effect(
      () => async () => {
        await this.ready
        await this.transitions
        await this.stores.close()
      },
      'graphs:persistence',
    )
    ctx.effect(async () => {
      await this.ready
      const selected = (await this.state()).selected()
      if (selected !== undefined) await this.transition(() => this.activate(selected))
      return () => {}
    }, 'graphs: boot selected')
  }

  async snapshot(): Promise<GraphsSnapshot> {
    return (await this.state()).snapshot()
  }

  /** The selected graph; throws when no graph is selected. */
  async current(): Promise<GraphRecord> {
    const selected = (await this.state()).selected()
    if (selected === undefined) throw new Error('graphs: no graph selected')
    return selected
  }

  async get(id: string): Promise<GraphRecord> {
    return (await this.state()).get(id)
  }

  async view(id: string) {
    const meta = await this.get(id)
    const graph = await this.ctx.graph.snapshotIn(meta.graphStoreId)
    const layout = await this.ctx.layout.snapshotIn(meta.layoutStoreId)
    return { meta, graph, layout }
  }

  async list(): Promise<readonly GraphRecord[]> {
    return (await this.state()).snapshot().graphs
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
      const store = this.ctx.envBuilder.store
      const choice = await this.resolveEnv(store, request)
      try {
        let envId: string
        let reused = false
        if ('reuse' in choice) {
          envId = choice.reuse
          reused = true
        } else {
          const { label, repos } = choice.create
          if (repos.length === 0) throw new Error('graphs: new environment requires at least one repository')
          const env = label === undefined ? store.create() : store.create(label)
          envId = createdEnvId = env.id
          for (const ref of repos) store.planComponent(envId, ref)
        }
        const registry = (await this.state()).snapshot()
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
          cwd: store.get(envId).path,
          scope: { graphStoreId, layoutStoreId },
        })
        rootAgentId = handle.agent.id
        // The graph registers before it recovers (A2 §E): a barrier failure leaves it selected and visible, retryable.
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
        const env = store.get(envId)
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

  private async resolveEnv(store: EnvStore, request: CreateGraphRequest): Promise<EnvChoice> {
    if (request.envId !== undefined) {
      if (request.createEnv === true || request.workspace !== undefined || request.fresh === true) {
        throw new Error('graphs: envId cannot combine with createEnv, workspace, or fresh')
      }
      if (request.repos !== undefined) throw new Error('graphs: repos only allowed with createEnv')
      await this.assertReusable(request.envId)
      return { reuse: request.envId }
    }
    if (request.workspace !== undefined) {
      const label = request.workspace.trim()
      if (label.length === 0) throw new Error('graphs: workspace is empty')
      if (request.fresh !== true) {
        const bound = (await this.state()).boundEnvIds()
        const matches = store.findByLabel(label)
        const available = matches.find(env => isReusableEnv(env, bound))
        if (available !== undefined) {
          await this.assertReusable(available.id)
          return { reuse: available.id }
        }
        if (matches.length > 0) throw new Error(await this.workspaceTaken(label, matches))
      }
      return { create: { label, repos: request.repos ?? [] } }
    }
    if (request.createEnv === true) {
      const repos = request.repos ?? []
      if (repos.length === 0) throw new Error('graphs: new environment requires at least one repository')
      if (request.fresh !== true) {
        const bound = (await this.state()).boundEnvIds()
        const match = store.findByRepos(repos).find(env => isReusableEnv(env, bound))
        if (match !== undefined) {
          await this.assertReusable(match.id)
          return { reuse: match.id }
        }
      }
      return { create: { repos } }
    }
    throw new Error('graphs: provide exactly one of createEnv, envId, workspace')
  }

  private async assertReusable(envId: string): Promise<void> {
    const occupant = (await this.state()).snapshot().graphs.find(graph => graph.envId === envId)
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

  private async workspaceTaken(label: string, matches: readonly EnvRecord[]): Promise<string> {
    const graphs = (await this.state()).snapshot().graphs
    const details = matches
      .map(env => {
        const occupant = graphs.find(graph => graph.envId === env.id)
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
    await this.commit([{ kind: 'graph/ready', id }])
    return (await this.state()).get(id)
  }

  async graphForSession(sessionId: SessionId): Promise<GraphRecord> {
    for (const graph of (await this.state()).snapshot().graphs) {
      const snapshot = await this.ctx.graph.snapshotIn(graph.graphStoreId)
      if (snapshot.agents.some(agent => agent.id === sessionId)) return graph
    }
    throw new SessionNotInGraphError(sessionId)
  }

  async remove(id: string): Promise<void> {
    return this.transition(async () => {
      const graph = await this.get(id)
      const scope = { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId }
      // The task tree stops before its graph; a runtime-less deployment simply has nothing to cancel (A3 §3.6).
      const taskRuntime = this.taskRuntime()
      if (taskRuntime !== undefined) {
        await taskRuntime.cancelGraph(rootTaskStoreId(graph.rootSessionId), 'graph removed')
      }
      await this.ctx.agentRuntime.stopGraph(scope)
      // Deletion unbinds and archives only: the checkout is never cleaned here, so a broken
      // or symlinked environment can neither hang the request nor be written through.
      this.ctx.envBuilder.store.markClean(graph.envId)
      const snapshot = await this.ctx.graph.snapshotIn(graph.graphStoreId)
      const archive: GraphArchive = { graph, agentIds: snapshot.agents.map(agent => agent.id), archivedAt: Date.now() }
      await this.commit([{ kind: 'graph/remove', id, archive }])
      const selected = (await this.state()).selected()
      if (selected !== undefined) await this.activate(selected)
      else {
        this.ctx.graph.clearActive()
        this.ctx.layout.clearActive()
      }
    })
  }

  /** Resolved lazily: task-runtime injects graphs, so a hard inject here would deadlock the plugin loader. */
  private taskRuntime(): Context['taskRuntime'] | undefined {
    return this.ctx.get('taskRuntime') as Context['taskRuntime'] | undefined
  }

  /** One graph becomes this process's running environment: recovery barrier, then store and env switch (A2 §E). */
  private async activate(graph: GraphRecord): Promise<void> {
    await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, {
      graphStoreId: graph.graphStoreId,
      layoutStoreId: graph.layoutStoreId,
    })
    const taskRuntime = this.taskRuntime()
    if (taskRuntime === undefined) {
      throw new Error('graphs: taskRuntime service is not loaded; cannot recover the root store')
    }
    await taskRuntime.adoptRoot(rootTaskStoreId(graph.rootSessionId), graph.rootSessionId)
    await this.ctx.graph.switchStore(graph.graphStoreId)
    await this.ctx.layout.switchStore(graph.layoutStoreId)
    this.ctx.envBuilder.store.select(graph.envId)
    this.ctx.emit('graphs/selected', graph)
  }

  private async commit(events: readonly GraphsEvent[]): Promise<void> {
    await this.stores.commit(this.storeId, events)
  }

  private transition<T>(work: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(work)
    this.transitions = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** The live registry reducer; every read goes through `ready` so a failed constructor open stays caller-visible. */
  private async state(): Promise<GraphsState> {
    await this.ready
    return this.stores.require(this.storeId).state
  }
}

export default GraphsService
