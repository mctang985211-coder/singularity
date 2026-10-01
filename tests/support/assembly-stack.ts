/**
 * A deployment whose model loop is the only thing missing: the real
 * `JsonlSessionPersistence` and the bytes it writes, the real `SystemPrompt`
 * registry and its `system-prompt/assemble` waterfall, the real
 * `TaskService`/`TaskRuntime`/`VerifierRegistry`/`AgentRuntime`, the real
 * singularity tool plane, and the real context read core mounted where the
 * deployment's bundle mounts it.
 *
 * Why this shape: the subject of `context-assembly.spec.ts` and
 * `worker-contract.spec.ts` is what a session's request is **assembled** from —
 * the store's records, the caller's graph domain, and the deployment's sections —
 * so the fixture has to be a deployment the assembly really runs in. The agent
 * factory is a stub only in that no provider is called: it mints the scoped world
 * and awaits `setup` (what the loop does before its first request), and its
 * `whenIdle` runs the scripted body and hands the run in, exactly the hook
 * `run-stack.ts` uses.
 *
 * Two things are deliberately replaceable seams, both *read-only* planes the
 * read core observes: the graph registry (membership and graph facts) and the
 * session plane's exact reads. Everything the assertions rest on — the store,
 * the log, the assembled sections, the tool results — is the real implementation.
 * @module tests/support/assembly-stack
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry, assembleContextFor } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { SessionQueryError } from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { createUserMessage, freezeMessage, MessageId } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { createScope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import { rootTaskStoreId, TaskService } from '../../task/src/index.ts'
import { SessionNotInGraphError } from '../../graphs/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { AgentMessageIntent, SpawnRequest } from '../../agent-runtime/src/index.ts'
import { SingularityAgent } from '../../agent-singularity/src/index.ts'
import type { Config } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, mountContextReadCore } from './context-plane.ts'
import { OTHER_TOOLS, ROOT_TOOLS, type SupervisionOptions } from './scripted-loop.ts'

/** One graph this deployment publishes: its root session and the sessions it holds. */
export interface GraphSpec {
  readonly id: string
  readonly rootSessionId: string
  /** Sessions that are members of this graph (the root is one by construction). */
  readonly members?: readonly string[]
  /**
   * Sessions this graph is already recorded as having spawned — the graph store's
   * own `spawn` edges, which a restart re-reads from that store. A booted process
   * records its own edges as it spawns (see {@link AssemblyStack.spawnEdges}); this
   * field is how a case hands a *new* process the edges the durable store held.
   */
  readonly spawned?: readonly string[]
}

export interface AssemblyStackOptions {
  /** The graphs this deployment starts with. Defaults to one graph rooted at `s-root`. */
  readonly graphs?: readonly GraphSpec[]
  /** The checkout every session of this deployment works in. Defaults to a fresh directory inside its workspace. */
  readonly checkout?: string
  /** What one worker does when its scripted turn ends, before it hands its result in. */
  readonly worker?: (sessionId: string) => Promise<void> | void
  /** The review policy this store runs under. Defaults to the runtime's own (`off`). */
  readonly review?: 'off' | 'all'
  /** Inherited deployment presentation; root setup may override it. */
  readonly toolsMode?: 'native' | 'ptc' | 'both'
  /**
   * The tree-wide root budget this deployment enforces (`Config.rootBudget`): the
   * run count and the deadline a store's whole tree is measured against. A case
   * that measures what a killed process's runs still count is booted with the
   * ceiling those runs leave, so the next admission is refused by the store's own
   * count rather than by a reading the case computed for itself.
   */
  readonly rootBudget?: Readonly<{ wallTimeMs?: number; maxRuns?: number; maxConcurrentWrites?: number }>
  /**
   * The deployment's supervision policy (A5/A6/A7), passed into the plugin's own
   * configuration exactly as a deployment's `config.yml` states it. Absent leaves
   * the shipped defaults in force: every terminal review is accepted, and the
   * iteration caps are the deployment's own.
   */
  readonly supervision?: SupervisionOptions
  /** Reuse a workspace (a restart). Absent = a fresh directory. */
  readonly dir?: string
}

function standIn(name: string, ran: string[]): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
    execute: async () => {
      ran.push(name)
      return `${name}: fixture answer`
    },
  }
}

/** One tool call's model-facing answer, as the registry settled it. */
export interface StackCallResult {
  readonly isError: boolean
  readonly text: string
}

/** One message the runtime stated through the relay, and what the real delivery settled as. */
export interface RelayedIntent {
  readonly messageId: string
  readonly targetSessionId: string
  readonly text: string
  /** The real delivery's status, or the refusal it threw with. */
  readonly status: string
}

export class AssemblyStack {
  readonly ctx: Context
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  readonly runtime: TaskRuntime
  readonly agentRuntime: AgentRuntime
  readonly dir: string
  readonly home: string
  readonly checkout: string
  readonly roots: readonly string[]
  /** Every spawn the runtime asked the agent runtime for, in order. */
  readonly spawns: SpawnRequest[] = []
  /**
   * Every message the runtime stated through the real relay, in order: the
   * intent it carried and what the real delivery settled as. The relay is
   * *observed*, never replaced — the deployment's own
   * `ensureAgentMessageDelivered` decides every one — so a case can say what a
   * Session was told (and what it was not) without a stand-in that would decide
   * it instead. A stand-in loop cannot witness a delivered message in the
   * target's own log (a spawned worker holds no durable log here), which is why
   * the statement itself is what this records.
   */
  readonly relayed: RelayedIntent[] = []
  /** The graph store's own `spawn` edges this process committed, in order: what a restart would re-read. */
  private readonly committedEdges: { kind: string; from: string; to: string }[] = []
  /** The approval door, counted: a read or an assembly must never reach it (A2-4). */
  readonly approvalRequest = vi.fn(async () => 'allowed-once' as const)
  /** The stand-in bodies that really ran, by tool name. */
  private readonly ran: string[] = []
  private readonly handles: { close: () => Promise<void> }[] = []
  private readonly live = new Map<string, Agent>()
  /** Every agent this process minted, disposed ones included: what a case reads to prove zero model input. */
  private readonly minted = new Map<string, Agent>()
  private readonly membership = new Map<string, string>()
  private readonly graphs: GraphSpec[]
  private callSeq = 0
  private persistence!: JsonlSessionPersistence
  private previousHome: string | undefined

  constructor(private readonly options: AssemblyStackOptions = {}) {
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), 'singularity-assembly-'))
    this.home = join(this.dir, 'home')
    this.checkout = options.checkout ?? join(this.dir, 'env')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(join(this.home, 'skills'), { recursive: true })
    mkdirSync(this.checkout, { recursive: true })
    this.previousHome = process.env.DSH_HOME
    vi.stubEnv('DSH_HOME', this.home)
    vi.stubEnv('HOME', this.home)
    process.env.DSH_HOME = this.home
    this.graphs = options.graphs === undefined || options.graphs.length === 0
      ? [{ id: 'g1', rootSessionId: 's-root' }]
      : [...options.graphs]
    for (const graph of this.graphs) {
      this.membership.set(graph.rootSessionId, graph.id)
      for (const member of graph.members ?? []) this.membership.set(member, graph.id)
    }
    this.roots = this.graphs.map(graph => graph.rootSessionId)
    this.ctx = new Context()
    this.task = new TaskService(this.ctx)
    this.verifier = new VerifierRegistry(this.ctx, { evidenceRoot: join(this.dir, 'evidence') })
    this.agentRuntime = new AgentRuntime(this.ctx)
    this.runtime = new TaskRuntime(this.ctx, {
      ...(options.review === undefined ? {} : { generatedTaskReview: options.review }),
      ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
      runBindingRoot: join(this.home, 'run-bindings'),
    } as Config)
  }

  async start(): Promise<this> {
    const ctx = this.ctx
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, this.options.toolsMode === undefined ? {} : { mode: this.options.toolsMode })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry, {})
    this.persistence = new JsonlSessionPersistence(ctx, { root: this.dir, compression: 'none' })
    // Every handle this process takes, so a "crash" can close exactly what a dying
    // process's descriptors would release.
    const backend = this.persistence as unknown as {
      create: (...args: never[]) => Promise<{ close: () => Promise<void> }>
      open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    }
    const originalCreate = backend.create.bind(this.persistence)
    const originalOpen = backend.open.bind(this.persistence)
    backend.create = async (...args: never[]) => {
      const handle = await originalCreate(...args)
      this.handles.push(handle)
      return handle
    }
    backend.open = async (...args: never[]) => {
      const handle = await originalOpen(...args)
      this.handles.push(handle)
      return handle
    }
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
    ctx.provide('layout', { setIn: async () => {} })
    ctx.provide('approval', { request: this.approvalRequest })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
    const graphAgents = this.roots.map(id => ({ id, name: 'Singularity', status: 'idle' as const }))
    // The graph store's own edges, committed by the deployment's `AgentRuntime`
    // when it publishes a spawn: the record that tells a spawned session's absent
    // store apart from a member's named pre-activation state.
    const graphEdges: { kind: string; from: string; to: string }[] = []
    for (const graph of this.graphs) {
      for (const to of graph.spawned ?? []) {
        graphEdges.push({ kind: 'spawn', from: graph.rootSessionId, to })
        // The node the spawning process's own commit published for that session: a
        // resume reads the graph store for the session *and* its spawn edge, so a
        // boot handed the edges has to be handed the nodes beside them.
        graphAgents.push({ id: to, name: 'Singularity', status: 'idle' })
      }
    }
    this.committedEdges.length = 0
    ctx.provide('graph', {
      snapshotIn: async () => ({
        version: 1,
        id: 'g',
        roots: [...this.roots],
        agents: [...graphAgents],
        groups: [],
        edges: [...graphEdges],
      }),
      commitIn: async (
        _store: string,
        events: readonly { kind: string; agent?: (typeof graphAgents)[number]; edge?: { kind: string; from: string; to: string } }[],
      ) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined) graphAgents.push(event.agent)
          if (event.kind === 'edge/add' && event.edge !== undefined) {
            graphEdges.push(event.edge)
            this.committedEdges.push(event.edge)
          }
        }
      },
      setStatusIn: async () => {},
      addAgentIn: async (_store: string, agent: (typeof graphAgents)[number]) => { graphAgents.push(agent) },
    } as never)
    ctx.provide('graphs', graphRegistry({
      graphForSession: async (sessionId: string) => {
        const graphId = this.membership.get(String(sessionId))
        const graph = this.graphs.find(candidate => candidate.id === graphId)
        // The registry's own fact, told apart from a failed read the way the
        // real registry tells it: this error means "no graph publishes that
        // session", and any other throw is a read this fixture's specs can hand
        // back deliberately broken.
        if (graph === undefined) throw new SessionNotInGraphError(sessionId)
        return { id: graph.id, name: graph.id, envId: 'env1', rootSessionId: graph.rootSessionId }
      },
      list: async () => this.graphs.map(graph => ({
        id: graph.id,
        name: graph.id,
        envId: 'env1',
        rootSessionId: graph.rootSessionId,
      })),
      members: id => [...this.membership.entries()].filter(([, graphId]) => graphId === id).map(([sessionId]) => sessionId),
      edges: id => (id === this.graphs[0]!.id ? graphEdges : []),
    }) as never)
    // The session plane's read-only half (A2) over the real JSONL log.
    const readLog = async (sessionId: string): Promise<readonly SessionEvent[]> => {
      const handle = await (this.persistence as unknown as {
        open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
      }).open(SessionId(sessionId), 'read')
      try {
        return (await handle.read()).events
      } finally {
        await handle.close()
      }
    }
    /**
     * The one read the whole-log fold and a worker resume share: the log, and the
     * header the persistence itself holds. The header is not a fixture invention —
     * a resume rebuilds the composition a run was spawned in from it
     * (`agentPreset`), and the real engine's `readSession` returns the stored
     * header, so this one does too (a session whose header cannot be read fails the
     * read, exactly as the real engine's absent-log condition does).
     */
    const readSession = async (sessionId: string): Promise<{ session: unknown; inheritedEventCount: number; events: readonly SessionEvent[] }> => {
      const handle = await (this.persistence as unknown as {
        open: (id: SessionId, access: 'read') => Promise<{ header: unknown; read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
      }).open(SessionId(sessionId), 'read')
      try {
        return { session: handle.header, inheritedEventCount: 0, events: (await handle.read()).events }
      } finally {
        await handle.close()
      }
    }
    ctx.provide('sessionQuery', {
      readSurface: async (sessionId: string) => ({ capturedThroughSeq: (await readLog(sessionId)).at(-1)?.seq ?? null }),
      // The whole-log fold a consumption proof is read off (A4 §7.3). A session
      // this fixture holds no log for fails the read, exactly as the real
      // engine's absent-log condition does.
      readSession,
      readEvent: async (request: { sessionId: string; seq: number; before?: number; after?: number }) => {
        const events = await readLog(String(request.sessionId))
        const target = events.find(event => event.seq === request.seq)
        // The lack of an event at a seq is a *coded* condition in DSH's own
        // engine, and the read core tells it apart from a source that failed;
        // the stand-in answers it the same way.
        if (target === undefined) {
          throw new SessionQueryError(
            `session "${String(request.sessionId)}" has no event at seq ${request.seq}`,
            'SESSION_QUERY_EVENT_NOT_FOUND',
          )
        }
        const start = Math.max(0, request.seq - (request.before ?? 0))
        const end = Math.min(events.length - 1, request.seq + (request.after ?? 0))
        return { target, events: events.slice(start, end + 1), startSeq: start, endSeq: end }
      },
    } as never)
    ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: this.checkout, components: [] } : undefined) } } as never)
    await this.verifier.ready()
    // The read core and its assembly (A2), then the deployment's own composition:
    // the plugin registers the real tool plane (its four read/reference tools, the
    // intake, the coordination tools and the reviewer's), so what a case calls is
    // the adapter the deployment ships. Every other name a surface resolves against
    // is a stand-in, and a stand-in records that its body ran.
    await mountContextReadCore(ctx)
    await ctx.plugin(SingularityAgent, {
      evolution: 'off',
      ...(this.options.supervision === undefined ? {} : { supervision: this.options.supervision }),
    })
    for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
      if (ctx.tools.get(name) !== undefined) continue
      ctx.tools.register(standIn(name, this.ran))
    }

    ctx.agents.setFactory({
      createAgent: async (_owner: Context, options: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
        ({ agent: await this.mint(options.sessionId, options.setup), dispose: async () => { this.live.delete(String(options.sessionId)) } }),
      resume: async (_owner: Context, options: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
        ({ agent: await this.mint(options.resumeSessionId, options.setup), dispose: async () => { this.live.delete(String(options.resumeSessionId)) } }),
    } as never)
    const originalSpawn = this.agentRuntime.spawn.bind(this.agentRuntime)
    this.agentRuntime.spawn = async (parent: Agent, request: SpawnRequest) => {
      this.spawns.push(request)
      this.membership.set(String(request.sessionId), this.membership.get(String(parent.id)) ?? this.graphs[0]!.id)
      return await originalSpawn(parent, request)
    }
    const originalDeliver = this.agentRuntime.ensureAgentMessageDelivered.bind(this.agentRuntime)
    this.agentRuntime.ensureAgentMessageDelivered = async (intent: AgentMessageIntent) => {
      const record = {
        messageId: String(intent.messageId),
        targetSessionId: String(intent.targetSessionId),
        text: String(intent.text),
      }
      try {
        const delivery = await originalDeliver(intent)
        this.relayed.push({ ...record, status: delivery.status })
        return delivery
      } catch (error) {
        this.relayed.push({ ...record, status: `refused: ${error instanceof Error ? error.message : String(error)}` })
        throw error
      }
    }
    for (const root of this.roots) {
      await this.agentRuntime.createRoot({
        sessionId: SessionId(root),
        scope: { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' },
        cwd: this.checkout,
      })
    }
    return this
  }

  /** Mint one agent's scoped world and run `setup` on it, exactly as the loop's factory does. */
  private async mint(sessionId: SessionId, setup?: (agentCtx: Context, agent: Agent) => Promise<unknown>): Promise<Agent> {
    let self!: Agent
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      whenIdle: async () => { await this.runWorkerTurn(String(sessionId)) },
      session: { id: sessionId, header: { id: String(sessionId), cwd: this.checkout, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    self = agent
    let scope!: ReturnType<typeof createScope>
    await this.ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (this.ctx.agents.register(agent) as unknown as Promise<void>)
    this.live.set(String(sessionId), agent)
    this.minted.set(String(sessionId), agent)
    return agent
  }

  /**
   * One scripted worker turn: the spec's body, then the submission a live worker
   * owes — the run is handed in before the agent is idle again, so the runtime's
   * `whenIdle` observation already sees a terminal run.
   *
   * A body that decomposed leaves its run `waiting_children`, and a parent may
   * not submit while its children run (K1 §2): the batch has to end and hand the
   * run back `active` first. That handback is the wake a live worker's next turn
   * reads, so the fixture follows it — it waits for the batch this run opened to
   * settle, then hands the result in. The submission is still the run's own,
   * made at the point the protocol allows it.
   */
  private async runWorkerTurn(sessionId: string): Promise<void> {
    const agent = this.live.get(sessionId) as unknown as { status?: string } | undefined
    if (agent !== undefined) agent.status = 'running'
    try {
      await this.options.worker?.(sessionId)
    } finally {
      if (agent !== undefined) agent.status = 'idle'
    }
    const bound = await this.runtime.runForSession(sessionId).catch(() => undefined)
    if (bound === undefined) return
    if (bound.run.status === 'running' && bound.run.executionPhase === 'waiting_children' && bound.run.batchId !== undefined) {
      await this.runtime.awaitBatch(bound.storeId, bound.run.batchId)
    }
    const current = await this.runtime.runForSession(sessionId).catch(() => undefined)
    if (current === undefined || current.run.status !== 'running' || current.run.executionPhase !== 'active') return
    await this.runtime.submitResult(sessionId, { summary: 'worker finished (fixture auto-submit)' })
  }

  agent(sessionId: string): Agent | undefined {
    return this.live.get(sessionId)
  }

  /** One agent this process minted, even after its handle was disposed. */
  mintedAgent(sessionId: string): Agent | undefined {
    return this.minted.get(sessionId)
  }

  root(sessionId: string = this.roots[0]!): Agent {
    const agent = this.live.get(sessionId)
    if (agent === undefined) throw new Error(`the stack holds no live agent for "${sessionId}"`)
    return agent
  }

  /** What the deployment assembles for one session's next request — the real waterfall. */
  assemble(sessionId: string) {
    const agent = this.live.get(sessionId) ?? ({ id: sessionId } as unknown as Agent)
    return this.ctx.systemPrompt.assemble(assembleContextFor(agent))
  }

  /** The rendered system prompt of that assembly: every section, node 0's own text included. */
  async prompt(sessionId: string): Promise<string> {
    return renderPrompt(await this.assemble(sessionId))
  }

  /** The rendered runtime-context snapshot of that assembly — the dynamic plane the loop sends beside the prompt. */
  async contextSnapshot(sessionId: string): Promise<string> {
    return renderContextSnapshot(await this.assemble(sessionId))
  }

  /** Dispatch one tool call as one session, through the real registry and gate waterfall. */
  async call(sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<StackCallResult> {
    this.callSeq += 1
    const agent = this.live.get(sessionId) ?? ({ id: sessionId } as unknown as Agent)
    const answer = await this.ctx.tools.execute({
      callId: `call-${this.callSeq}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    return {
      isError: answer.isError === true,
      text: (answer.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
    }
  }

  storeIdOf(sessionId: string = this.roots[0]!): string {
    return rootTaskStoreId(this.roots.find(root => this.membership.get(root) === this.membership.get(sessionId)) ?? sessionId)
  }

  async snapshot(storeId?: string): Promise<TaskSnapshot> {
    return await this.task.snapshotIn(storeId ?? this.storeIdOf())
  }

  /** Every task event one store appended, read back off the JSONL log as a reader. */
  async events(storeId?: string): Promise<TaskEvent[]> {
    const id = storeId ?? this.storeIdOf()
    const handle = await (this.persistence as unknown as {
      open: (sessionId: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
    }).open(SessionId(id), 'read')
    try {
      return (await handle.read()).events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
    } finally {
      await handle.close()
    }
  }

  /** The stand-in tool bodies that really ran, by name. */
  executed(): readonly string[] {
    return this.ran
  }

  /** The graph store's own `spawn` edges this process committed: a restart's `GraphSpec.spawned`. */
  spawnEdges(): readonly { kind: string; from: string; to: string }[] {
    return [...this.committedEdges]
  }

  /** A session's whole stored log, as the JSONL backend holds it. */
  async log(sessionId: string): Promise<readonly SessionEvent[]> {
    const handle = await (this.persistence as unknown as {
      open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
    }).open(SessionId(sessionId), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }

  /** Seed one session's durable log, the way a person's own request gets there. */
  async seedLog(sessionId: string, texts: readonly string[], options: { parentSession?: string; agentPreset?: string } = {}): Promise<void> {
    const handle = await (this.persistence as unknown as {
      create: (header: { id: SessionId; version: number; createdAt: number; isSeeded: boolean; cwd: string; agentPreset: string; parentSession?: SessionId }) => Promise<{ append: (events: readonly unknown[]) => Promise<void>; close: () => Promise<void> }>
    }).create({
      id: SessionId(sessionId),
      version: SESSION_FORMAT_VERSION,
      createdAt: Date.now(),
      isSeeded: false,
      cwd: this.checkout,
      agentPreset: options.agentPreset ?? 'standard',
      // The header a *spawn* writes: the session's parent is the session that
      // spawned it, which is what a worker resume re-reads against the graph's own
      // spawn edge.
      ...(options.parentSession === undefined ? {} : { parentSession: SessionId(options.parentSession) }),
    } as never)
    try {
      await handle.append(texts.map((text, seq) => ({
        type: 'user/message',
        seq,
        time: Date.now() + seq,
        data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      })) as never)
    } finally {
      await handle.close()
    }
  }

  /**
   * Append one relayed message to a session's durable log, in the shape the loop
   * writes when a claimed inbox message reaches a model request: a `user/message`
   * event carrying the message's own identity and an `agent-message` source.
   * That event is the one durable proof A4 §7.3 accepts that the model was given
   * the message — a pending inbox entry is not one — so a case that simulates
   * consumption writes exactly this and nothing else.
   */
  async appendMessage(sessionId: string, messageId: string, text = `message ${messageId}`): Promise<void> {
    const next = (await this.log(sessionId)).length
    const handle = await (this.persistence as unknown as {
      open: (id: SessionId, access: 'write') => Promise<{
        append: (events: readonly unknown[]) => Promise<void>
        close: () => Promise<void>
      }>
    }).open(SessionId(sessionId), 'write')
    try {
      await handle.append([{
        type: 'user/message',
        seq: next,
        time: Date.now(),
        data: freezeMessage({
          id: MessageId(messageId),
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
          source: { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: sessionId },
        }),
        surfaceOp: 'append',
      }] as never)
    } finally {
      await handle.close()
    }
  }

  /**
   * Close every handle this process holds, the way a dying process releases its
   * descriptors — the durability barrier first (a live Session's appends are
   * batched, and the bytes a next process reads have to be the bytes this one
   * really wrote), then the descriptors, so the durable bytes stay while the
   * in-memory services do not.
   */
  async crash(): Promise<void> {
    const backend = this.persistence as unknown as { flush?: () => Promise<void> }
    if (typeof backend.flush === 'function') await backend.flush()
    for (const handle of this.handles.splice(0)) await handle.close().catch(() => undefined)
  }

  /** Give the whole workspace back: the context, the pinned env and the directory. */
  async dispose(options: { remove?: boolean } = {}): Promise<void> {
    if (this.previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = this.previousHome
    await this.ctx.fiber.dispose()
    if (options.remove !== false) rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Boot one deployment over its own workspace (or over an existing one, for a restart). */
export async function startAssemblyStack(options: AssemblyStackOptions = {}): Promise<AssemblyStack> {
  const stack = new AssemblyStack(options)
  return await stack.start()
}
