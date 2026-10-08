/** @module dsh-singularity-graphs */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EventStoreSet } from '@dangosys/dsh-singularity-task'
import type { EnvRecord, EnvStore } from '@dangosys/dsh-env-builder'
import type {} from '@dangosys/dsh-singularity-graph'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import { latestBubbleWorkspacePath, materializeBubble } from '@dangosys/dsh-singularity-task-runtime'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type {
  CreateGraphRequest,
  CreateGraphResult,
  GraphArchive,
  GraphModel,
  GraphPinsUpdate,
  GraphRecord,
  GraphsEvent,
  GraphsSnapshot,
  RsiConfig,
  RsiProgress,
} from './types.ts'
import { GraphsState, isReusableEnv } from './service/state.ts'
import { assertModelServiceable, graphAgentOptions, type ModelCatalogReader } from './model.ts'
import { setupPromptText } from './prompts/setup.prompts.ts'

export * from './types.ts'
export { GraphsState, isReusableEnv } from './service/state.ts'
export { assertModelServiceable, graphAgentOptions } from './model.ts'
export type { ModelCatalogReader } from './model.ts'

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

/** The fields an RSI config carries: anything else is refused by name rather than ignored. */
const RSI_FIELDS: readonly string[] = ['task', 'metrics', 'iterationRounds', 'humanReview']

/** Validates one RSI config, refusing a malformed one with the offending field named. */
function assertRsiConfig(rsi: unknown): asserts rsi is RsiConfig {
  if (typeof rsi !== 'object' || rsi === null || Array.isArray(rsi)) {
    throw new Error(`graphs: rsi must be an object carrying ${RSI_FIELDS.join(', ')}`)
  }
  const fields = rsi as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (!RSI_FIELDS.includes(key)) {
      throw new Error(
        `graphs: rsi carries "${key}", which is not part of an RSI config; it carries ${RSI_FIELDS.join(', ')} and nothing else`,
      )
    }
  }
  if (typeof fields.task !== 'string' || fields.task.trim().length === 0) {
    throw new Error('graphs: rsi.task must be a non-empty string')
  }
  if (fields.metrics !== undefined && (!Array.isArray(fields.metrics) || fields.metrics.some(
    metric => typeof metric !== 'string' || metric.trim().length === 0,
  ))) throw new Error('graphs: rsi.metrics must be an array of non-empty descriptions')
  const rounds = fields.iterationRounds
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error('graphs: rsi.iterationRounds must be an integer >= 1')
  }
  if (typeof fields.humanReview !== 'boolean') {
    throw new Error('graphs: rsi.humanReview must be a boolean')
  }
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
      if (request.model !== undefined) await this.assertModel(request.model)
      if (request.rsi !== undefined && (typeof request.rsi !== 'object' || request.rsi === null || Array.isArray(request.rsi))) assertRsiConfig(request.rsi)
      const rsi = request.rsi === undefined ? undefined : { iterationRounds: 3, humanReview: false, ...request.rsi }
      if (rsi !== undefined) assertRsiConfig(rsi)
      const modelOptions = request.model === undefined ? undefined : graphAgentOptions({ model: request.model })
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

        // The graph's root runs in round 1's bubble, never in the environment
        // checkout: materializing folds the environment's components into
        // `rsi/<graph>/round-0` and clones them behind the bubble's wall.
        const envPath = store.get(envId).path
        const workspace = await materializeBubble(
          envPath,
          process.env.DSH_HOME || join(homedir(), '.dsh'),
          rootSessionId,
          id,
          1,
        )
        // The root session's own workspace is that bubble: the runtime resolves the
        // graph's checkout from this mapping, never from the environment's path.
        this.taskRuntime()?.sessionWorkspaces.set(rootSessionId, workspace)
        const handle = await this.ctx.agentRuntime.createRoot({
          sessionId: rootSessionId,
          cwd: workspace,
          scope: { graphStoreId, layoutStoreId },
          ...(modelOptions === undefined ? {} : { agentOptions: modelOptions }),
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
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(rsi === undefined ? {} : { rsi }),
        }
        await this.commit([{ kind: 'graph/add', graph }])
        committed = true
        await this.activate(graph)
        const env = store.get(envId)
        const setup = [{ type: 'text' as const, text: setupPromptText(id, env) }]
        if (rsi === undefined) await this.ctx.agentRuntime.prompt(handle.agent, setup)
        else await this.ctx.agentRuntime.promptUser(handle.agent, [
          { type: 'text', text: [rsi.task,
            ...(rsi.metrics?.length ? ['关注指标：', ...rsi.metrics.map(metric => `- ${metric}`)] : []),
          ].join('\n') },
        ], setup)
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

  /** Pin, replace, or clear (null) one graph's model. Only later spawns read it; existing sessions keep theirs. */
  async setModel(id: string, model: GraphModel | null): Promise<GraphRecord> {
    return this.setPins(id, { model })
  }

  /**
   * Set, replace, or clear (null) one graph's RSI config, dropping its stored driver progress.
   * A configured driver reconciles the same frozen root task; a new objective requires a new graph.
   */
  async setRsi(id: string, rsi: RsiConfig | null): Promise<GraphRecord> {
    return this.setPins(id, { rsi })
  }

  /** Validate all supplied settings before committing one event batch in the graph transition queue. */
  async setPins(id: string, update: GraphPinsUpdate): Promise<GraphRecord> {
    return this.transition(async () => {
      await this.ready
      await this.get(id)
      const { model, rsi } = update
      if (model === undefined && rsi === undefined) {
        throw new Error('graphs: model or rsi is required (pass null to clear either)')
      }
      if (rsi !== undefined && rsi !== null) assertRsiConfig(rsi)
      if (model !== undefined && model !== null) await this.assertModel(model)
      const events: GraphsEvent[] = []
      if (model !== undefined) events.push({ kind: 'graph/model', id, model })
      if (rsi !== undefined) events.push({ kind: 'graph/rsi', id, rsi })
      await this.commit(events)
      return (await this.state()).get(id)
    })
  }

  /** Record the loop driver's live position on one graph; the registry stores it verbatim. */
  async markRsiProgress(id: string, progress: RsiProgress): Promise<void> {
    await this.get(id)
    await this.commit([{ kind: 'graph/rsi-progress', id, progress }])
  }

  /** Refuse a pin the current provider registry cannot serve; the message names the offending field. */
  private async assertModel(model: GraphModel): Promise<void> {
    const llm = this.ctx.get('llm') as ModelCatalogReader | undefined
    if (llm === undefined) throw new Error('graphs: llm service is not loaded; cannot validate a model pin')
    await assertModelServiceable(llm, model)
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
      // Successor activation is its own concern: a successor whose sessions cannot resume
      // (e.g. its MCP server cannot start) must neither hold this request nor fail the delete.
      if (selected !== undefined)
        void Promise.resolve()
          .then(() => this.activate(selected))
          .catch(() => {})
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
    const modelOptions = graphAgentOptions(graph)
    const scope = { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId }
    if (modelOptions === undefined) await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, scope)
    else await this.ctx.agentRuntime.ensureRoot(graph.rootSessionId, scope, modelOptions)
    const taskRuntime = this.taskRuntime()
    if (taskRuntime === undefined) {
      throw new Error('graphs: taskRuntime service is not loaded; cannot recover the root store')
    }
    // Re-entering a graph re-pins its root into the latest bubble round: that
    // round's workspace is where its Runs work, and without the mapping a
    // restarted process resolves the checkout to the environment port the
    // bubble was cloned from. A graph with no bubble keeps the environment path.
    const bubble = latestBubbleWorkspacePath(process.env.DSH_HOME || join(homedir(), '.dsh'), graph.rootSessionId)
    if (bubble !== undefined) taskRuntime.sessionWorkspaces.set(graph.rootSessionId, bubble)
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
