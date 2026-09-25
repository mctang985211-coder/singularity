/**
 * One deployment-shaped stack for the S1-C integration specs that need the real
 * agent plane, not only the store: the real `TaskService` store and reducer, the
 * real `TaskRuntime` entries (`intakeRootContract` / `adoptRoot`, `decomposeAndRun`,
 * `replayTask`),
 * the real `AgentRuntime.spawn` over the real DSH tool/skill planes, the real
 * `VerifierRegistry` with its built-in `CommandVerifier`, and the real
 * filesystem the skills live on.
 *
 * What is replaced, and why:
 * - `sessionPersistence` — an in-memory handle with the JSONL log's shape, so a
 *   test can read back the events a store actually appended.
 * - the agent factory (`ctx.agents.setFactory`) — the model loop. The stub mints
 *   the scoped world and awaits `setup`, which is exactly what the loop does
 *   before the first prompt, so the grant, the tool restriction and the skill
 *   registration asserted here are the ones a live worker's first request would
 *   be assembled against.
 * - `graph`/`graphs`/`envBuilder` — a fixed env whose checkout is this test's tmp
 *   directory, i.e. the same directory a worker's cwd resolves to in a real
 *   graph. `graphForSession` keeps one root per spawned session, because two
 *   roots in one deployment (a second admission after a version moved) is a shape
 *   these specs need and a single-root fixture cannot express.
 * - `approval`/`userQuestions` — the human seams, answered 'allowed-once' so a
 *   tool path can run; a spec that cares about *not* burning an approval asserts
 *   on the spy.
 *
 * Everything a spec asserts is read back from a durable surface: the store's own
 * events and snapshot, the run binding the store holds, the bytes on disk, or the
 * skill/tool registration a worker's own scope resolves.
 * @module tests/support/run-stack
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import { SessionSeq } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import * as SkillFilesystem from '../../../../thirdparty/deepseek-harness/packages/skill/skill-filesystem/lib/index.js'
import * as SkillTool from '../../../../thirdparty/deepseek-harness/packages/skill/tool-skill/lib/index.js'
import { createScope, type Scope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import { renderPrompt } from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import type { Agent, AgentHandle, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { SingularityContextService } from '../../context/src/index.ts'
import { defineCapabilityListTool } from '../../agent-singularity/src/tools/capability-list.ts'
import { defineContextReadTool } from '../../agent-singularity/src/tools/context-read.ts'
import { defineTaskCancelTool } from '../../agent-singularity/src/tools/task-cancel.ts'
import { defineTaskDecomposeTool } from '../../agent-singularity/src/tools/task-decompose.ts'
import { defineTaskIntakeTool } from '../../agent-singularity/src/tools/task-intake.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import { defineTaskStatusTool } from '../../agent-singularity/src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../agent-singularity/src/tools/task-submit-result.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import type { CapabilityConfig, Config, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, sessionQueryReads } from './context-plane.ts'

/** The fixture skills the deployment's own pre-check fixtures install. */
const FIXTURE_SKILLS = fileURLToPath(new URL('../../task-runtime/tests/fixtures/skills/', import.meta.url))

/** Exactly the root agent's allow-list, so the root composition is the deployment's own. */
export const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'context_read', 'skill', 'task_intake', 'task_decompose',
  'task_submit_result', 'task_answer', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/**
 * The global-plane machinery every agent inherits. `skill` rides the preset plane,
 * as `tool-skill` mounts it in the deployment. The four raw cross-session readers
 * are registered here on purpose: the seal this deployment puts on them is an
 * execution guard, and a guard can only be shown to hold where the surface would
 * otherwise answer the call.
 */
export const GLOBAL_TOOLS = [
  ...ROOT_TOOLS.filter(name => name !== 'skill'),
  'session_search', 'session_event_read', 'session_event_trace', 'session_trace',
]

/** The tools a stack can mount for real ({@link RunStackOptions.tools}); the stand-ins skip these names. */
const REAL_TOOLS = ['task_read', 'task_status', 'context_read', 'capability_list', 'task_intake', 'task_decompose', 'task_submit_result', 'task_cancel']

/** What the `standard`-style preset contributes on its own plane. */
export const PRESET_TOOLS = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill', 'ask_user_question', 'web_fetch', 'subagent_fetchless']

export interface RunStackOptions {
  /** The capability table admissions resolve against. Defaults to no capabilities. */
  readonly capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** Root sessions of this deployment, in order; the first is the primary. Defaults to `['s-root']`. */
  readonly roots?: readonly string[]
  /** Mount the deployment's filesystem skill provider, so a worker's own catalog is real. */
  readonly discovery?: boolean
  /** Mount the real `skill` loader (`@deepseek-ai/dsh-tool-skill`) instead of a stand-in. */
  readonly skillTool?: boolean
  /** Register the real singularity tools (`task_read`, `capability_list`, `task_decompose`) on the global plane. */
  readonly tools?: boolean
  /** Where run bindings are materialized. Defaults to `<home>/singularity/run-bindings`. */
  readonly runBindingRoot?: string
  /** Depth ceiling for a cascade; defaults to the runtime's own. */
  readonly maxDepth?: number
  /**
   * The tree-wide root budget (`Config.rootBudget`): the deadline and run count
   * a store's whole tree — replays included, since a replay's parentless task
   * shares the root's total — is measured against.
   */
  readonly rootBudget?: Readonly<{ wallTimeMs?: number; maxRuns?: number; maxConcurrentWrites?: number }>
  /**
   * The scripted worker: what one spawned agent does before it goes idle. The
   * runtime awaits it through `whenIdle` — after the spawn resolved, so a worker
   * that re-decomposes calls back into the runtime from outside the spawn it is
   * running under, exactly as a live one does.
   */
  readonly worker?: (sessionId: SessionId, agent: Agent) => Promise<void> | void
  /**
   * Whether the fixture worker submits its own result once the scripted body
   * returns (default `true`). A live worker has to: an idle session is not a
   * completion, and a run that never submits is stopped under the no-progress
   * budget. `false` is the un-submitted path — the run stays `active` where a
   * submission was due — and is for the specs that are about idle meaning no
   * completion. A worker whose body decomposed is skipped either way: its run is
   * `waiting_children`, and its batch submits for it.
   */
  readonly submit?: boolean
}

export interface RunStack {
  readonly ctx: Context
  readonly runtime: TaskRuntime
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  /** The tmp directory the whole fixture lives in. */
  readonly workspace: string
  /** The pinned `$DSH_HOME` and `$HOME`: a skill installed here is reachable from both discovery viewpoints. */
  readonly home: string
  /** The env checkout every worker runs in and every provider pre-check discovers from. */
  readonly checkout: string
  readonly roots: readonly SessionId[]
  /** Every spawn request the runtime handed to the agent runtime, in order. */
  readonly spawns: readonly SpawnRequest[]
  /** The live agent for one session, as the deployment's registry holds it. */
  agent(sessionId: SessionId): Agent | undefined
  /** The root agent of the primary (or a named) root session. */
  rootAgent(sessionId?: SessionId): Agent
  /** The tool names one worker's composition offers, from the registry's own view. */
  visible(agent: Agent): string[]
  /** Every task event one store appended, read back off its own session log. */
  events(storeId: string): TaskEvent[]
  /** The store's snapshot as the store itself holds it. */
  snapshot(storeId: string): Promise<TaskSnapshot>
  /**
   * Activate one root session's tree through the real intake entry, with the root
   * contract the *spec* hands in (A0 §1.2): the proposal is submitted, a policy of
   * `off` continues it in the same call, and the root task and run this returns are
   * the ones the activation committed.
   *
   * There is no default contract, on purpose. The harness cannot know what a spec's
   * root is *for*, and the acceptance rule a root owes (at least one mandatory
   * criterion judged by something other than the composite conjunction) is exactly
   * the thing a plausible-looking default would paper over.
   */
  root(sessionId: SessionId, contract: RootContractSpec): Promise<{ storeId: string; taskId: string; runId: string }>
  /** Dispatch one tool call on behalf of one agent, the way the loop does. */
  call(agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolCallResult>
  /**
   * What the deployment assembles for one agent's next request (A2): the real
   * `system-prompt/assemble` waterfall, called with the same context the loop
   * passes (`assembleContextFor`: the agent as its own scope). This fixture
   * replaces the model loop, so this is the door a spec reads the assembled
   * request through — the production listener, not a re-render.
   */
  assemblePrompt(agent: Agent): Promise<string>
}

/** What one dispatched tool call answered: the model-facing text, and whether the registry settled it as an error. */
export interface ToolCallResult {
  readonly isError: boolean
  readonly text: string
}

/** The stacks in play, so a spec's `afterEach` can dispose whatever a failed test left behind. */
const stacks: RunStackImpl[] = []

/** Dispose every stack started since the last call and release the pinned environment. */
export async function disposeRunStacks(): Promise<void> {
  for (const stack of stacks.splice(0)) await stack.dispose()
  vi.unstubAllEnvs()
}

/**
 * Boot the stack. Every tmp path is created inside one newly minted workspace, and
 * `$DSH_HOME`/`$HOME` are pinned into it so a skill installed on the machine
 * running the suite can never decide a verdict here.
 */
export async function startRunStack(options: RunStackOptions = {}): Promise<RunStack> {
  const stack = new RunStackImpl(options)
  stacks.push(stack)
  return stack.start()
}

/** A stand-in for one tool name: enough for the registry and the grant filter, and it answers its own name. */
function standIn(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
    execute: async () => name,
  }
}

class RunStackImpl implements RunStack {
  readonly workspace: string
  readonly home: string
  readonly checkout: string
  readonly roots: readonly SessionId[]
  readonly ctx: Context
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  readonly agentRuntime: RecordingAgentRuntime
  readonly runtime: TaskRuntime
  /**
   * The persistence service this stack mounts, kept so {@link recordRequest} can
   * write through the same handle a loop's own appends travel through. It is
   * declared structurally — this fixture needs `open`/`append`/`close` and no
   * more.
   */
  private persistence!: {
    open(id: SessionId, access: 'write'): Promise<{
      append(events: readonly SessionEvent[]): Promise<void>
      close(): Promise<void>
    }>
  }
  private readonly log = new Map<string, SessionEvent[]>()
  private readonly headers = new Map<string, SessionHeader>()
  private readonly live = new Map<string, Agent>()
  private readonly sessionRoot = new Map<string, string>()
  private readonly primary: SessionId
  private previousHome: string | undefined
  private callSeq = 0

  constructor(private readonly options: RunStackOptions) {
    this.workspace = mkdtempSync(join(tmpdir(), 'singularity-run-stack-'))
    // The checkout a worker runs in, the env path admission discovers from, and
    // the directory the root agent's cwd resolves to are one directory, as they
    // are in a deployment.
    this.checkout = join(this.workspace, 'env')
    this.home = join(this.workspace, 'dsh-home')
    mkdirSync(join(this.home, 'skills'), { recursive: true })
    mkdirSync(this.checkout, { recursive: true })
    this.roots = (options.roots ?? ['s-root']).map(id => id as SessionId)
    this.primary = this.roots[0]!
    this.ctx = new Context()
    for (const root of this.roots) this.sessionRoot.set(root, root)
    this.previousHome = process.env.DSH_HOME
    vi.stubEnv('DSH_HOME', this.home)
    vi.stubEnv('HOME', this.home)
    process.env.DSH_HOME = this.home

    // Every service the boot mounts is constructed after the provides it injects,
    // the order a cordis deployment resolves in.
    this.task = new TaskService(this.ctx)
    this.verifier = new VerifierRegistry(this.ctx, { evidenceRoot: join(this.workspace, 'evidence') })
    this.agentRuntime = new RecordingAgentRuntime(this.ctx, this.sessionRoot, () => this.primary)
    this.runtime = new TaskRuntime(this.ctx, {
      capabilities: { ...(this.options.capabilities ?? {}) },
      ...(this.options.maxDepth === undefined ? {} : { maxDepth: this.options.maxDepth }),
      ...(this.options.rootBudget === undefined ? {} : { rootBudget: { ...this.options.rootBudget } }),
      runBindingRoot: this.options.runBindingRoot ?? join(this.home, 'singularity', 'run-bindings'),
    } as Config)
  }

  async start(): Promise<this> {
    const ctx = this.ctx
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry, {})
    // The real loader when the spec is about loading; the preset plane's stand-in
    // otherwise, which is what the deployment's `skill` tool looks like to a tool
    // surface that only counts names.
    if (this.options.skillTool === true) await ctx.plugin(SkillTool, {})
    if (this.options.discovery === true) {
      await ctx.plugin(SkillFilesystem, { dshHome: this.home, agentsHome: join(this.workspace, 'agents-home'), watch: false })
    }
    for (const name of GLOBAL_TOOLS) {
      if (this.options.tools === true && REAL_TOOLS.includes(name)) continue
      ctx.tools.register(standIn(name))
    }
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
    ctx.provide('sessions', {})
    ctx.provide('approval', { request: vi.fn(async () => 'allowed-once') })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })

    for (const root of this.roots) {
      this.headers.set(root, { id: root, cwd: this.checkout, agentPreset: 'standard' } as unknown as SessionHeader)
      // A root session's own log exists from the graph's creation — the surface a
      // person's request lands on (A0 §1.10, {@link recordRequest}).
      this.log.set(root, [])
    }
    // The persistence service every store and every session of this stack writes
    // through: the JSONL-shaped handle the deployment mounts, with the write half
    // this fixture needs to record a request on a session's own log.
    const persistence = {
      list: async () => [...this.headers.values()].map(header => ({ header })),
      create: async (header: SessionHeader) => {
        this.headers.set(header.id, header)
        this.log.set(header.id, [])
        return this.handle(header.id)
      },
      open: async (id: SessionId) => {
        if (!this.log.has(id)) throw new Error(`missing session ${id}`)
        return this.handle(id)
      },
    }
    this.persistence = persistence
    ctx.provide('sessionPersistence', persistence as never)
    ctx.provide('layout', { setIn: async () => {} })
    const graphAgents = this.roots.map(id => ({ id, name: 'Singularity', status: 'idle' as const }))
    ctx.provide('graph', {
      snapshotIn: async () => ({ version: 1, id: 'g', roots: [...this.roots], agents: [...graphAgents], groups: [], edges: [] }),
      commitIn: async () => {},
      setStatusIn: async () => {},
      addAgentIn: async () => {},
    } as never)
    // One graph per root session, so a second admission in the same deployment
    // (a new version after an apply) has its own store and its own root run.
    ctx.provide('graphs', graphRegistry({
      graphForSession: async (sessionId: SessionId) => ({
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: this.sessionRoot.get(sessionId) ?? this.primary,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
      list: async () => [{
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: this.primary,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }],
      // This fixture mints one live agent per session — root or spawn — and that
      // registry is the published membership a session reference is checked against.
      members: () => [...this.roots.map(String), ...this.live.keys(), ...this.sessionRoot.keys()],
    }) as never)
    // The session plane's read-only half (A2): exact reads over this fixture's own
    // log, the records `events()` and the store read back.
    ctx.provide('sessionQuery', sessionQueryReads(sessionId => this.log.get(String(sessionId))) as never)
    ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: this.checkout, components: [] } : undefined) } } as never)

    // A preset's standing mount lives in its own scope; an agent joins it by scope parentage.
    const presetKey = { id: 'preset:standard' }
    let presetScope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { presetScope = createScope(inner, presetKey) }, { inject: ['tools', 'systemPrompt'] }))
    for (const name of PRESET_TOOLS) if (name !== 'skill' || this.options.skillTool !== true) presetScope.ctx.tools.register(standIn(name))
    // The root always rides a standard-style plane, whose allow-list names the loader.
    const rootPresetKey = { id: 'preset:root-standard' }
    await ctx.plugin(Object.assign((inner: Context) => {
      const rootPresetScope = createScope(inner, rootPresetKey)
      for (const name of PRESET_TOOLS) if (name !== 'skill' || this.options.skillTool !== true) rootPresetScope.ctx.tools.register(standIn(name))
    }, { inject: ['tools', 'systemPrompt'] }))

    const rootKeys = new Map(this.roots.map(root => [root as string, rootPresetKey]))
    ctx.agents.setFactory({
      // `meta.cwd` is what a session's own header carries in the real loop, and a
      // worker's cwd is where its tools resolve relative paths: a factory that
      // dropped it would answer a worker whose session disagrees with the spawn.
      createAgent: async (_ownerCtx: Context, opts: { sessionId: SessionId; meta?: { cwd?: string }; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
        ({ agent: await this.mint(opts.sessionId, opts.setup, rootKeys.get(opts.sessionId) ?? presetKey, opts.meta?.cwd), dispose: async () => { this.live.delete(opts.sessionId) } }),
      resume: async (_ownerCtx: Context, opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
        ({ agent: await this.mint(opts.resumeSessionId, opts.setup, rootKeys.get(opts.resumeSessionId) ?? presetKey), dispose: async () => { this.live.delete(opts.resumeSessionId) } }),
    } as never)

    await this.verifier.ready()
    // The read core and the prompt assembly (A2), mounted where the deployment's
    // bundle mounts them: after the runtime whose observations they read, before
    // the agent plane whose requests they assemble.
    await ctx.plugin(SingularityContextService)
    if (this.options.tools === true) {
      ctx.tools.register(defineTaskReadTool(ctx))
      ctx.tools.register(defineTaskStatusTool(ctx))
      ctx.tools.register(defineContextReadTool(ctx))
      ctx.tools.register(defineCapabilityListTool(ctx))
      ctx.tools.register(defineTaskIntakeTool(ctx))
      ctx.tools.register(defineTaskDecomposeTool(ctx))
      ctx.tools.register(defineTaskSubmitResultTool(ctx))
      ctx.tools.register(defineTaskCancelTool(ctx))
    }
    for (const root of this.roots) await this.agentRuntime.ensureRoot(root, { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' })
    return this
  }

  private handle(id: SessionId) {
    return {
      read: async () => ({ events: this.log.get(id) ?? [] }),
      append: async (records: readonly SessionEvent[]) => { this.log.get(id)?.push(...records) },
      flush: async () => {},
      close: async () => {},
    }
  }

  /**
   * Mint one agent's scoped world and run `setup` on it, exactly as the loop's
   * factory does. `cwd` is the session's own working directory when the creation
   * named one (a spawn's `meta.cwd`); a session the fixture already holds a header
   * for — a root — keeps the header it was seeded with.
   */
  private async mint(
    sessionId: SessionId,
    setup: ((agentCtx: Context, agent: Agent) => Promise<unknown>) | undefined,
    parentKey: { id: string },
    cwd?: string,
  ): Promise<Agent> {
    let self!: Agent
    /** The pending idle wait's resolver, so `cancel` converges a turn the way the real loop's does. */
    let releaseIdle: (() => void) | undefined
    const agent = {
      id: sessionId,
      // A live agent is idle when its loop is not running a turn, and that is
      // what the runtime's no-progress phase machine reads before it marks a
      // worker as having gone idle where a submission was due
      // (`orchestrate.ts:agentIsRunning`). The scripted body below flips it the
      // way a turn would, so the field is honest in both states.
      status: 'idle',
      followup: vi.fn(),
      // Cancelling a live worker ends its turn, and a turn that never ends cannot
      // be stopped: a batch cancellation reaches a parked worker through this
      // resolver, exactly as the loop's own `cancel` converges a real turn. The
      // scripted body itself is the spec's, and only it decides when to return.
      cancel: vi.fn(() => { releaseIdle?.() }),
      append: vi.fn(),
      // A live worker goes idle when its work is done; here that is whatever the
      // spec scripted for this session, run at the same point in the cascade.
      whenIdle: () => new Promise<void>((resolve, reject) => {
        releaseIdle = resolve
        void this.runWorkerTurn(sessionId, self).then(resolve, reject)
      }),
      session: {
        id: sessionId,
        header: this.headers.get(sessionId) ?? { id: sessionId, cwd: cwd ?? this.checkout, agentPreset: 'standard' },
        append: vi.fn(),
      },
    } as unknown as Agent
    self = agent
    let scope!: Scope
    await this.ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent, { parent: parentKey })
    }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (this.ctx.agents.register(agent) as unknown as Promise<void>)
    this.live.set(sessionId, agent)
    return agent
  }

  /**
   * One scripted worker turn: the spec's body with the agent marked as running,
   * then the submission a live worker owes — the run is handed in before the
   * agent is idle again, so the runtime's `whenIdle` observation already sees a
   * terminal run and never marks a no-progress round. A body that decomposed
   * leaves the run `waiting_children`: its batch submits for it, and a second
   * submission from the worker would be refused by the protocol anyway.
   */
  private async runWorkerTurn(sessionId: SessionId, agent: Agent): Promise<void> {
    const record = agent as unknown as { status?: string }
    record.status = 'running'
    try {
      await this.options.worker?.(sessionId, agent)
    } finally {
      record.status = 'idle'
    }
    if (this.options.submit === false) return
    const { run } = await this.runtime.runForSession(sessionId)
    if (run.status !== 'running' || run.executionPhase !== 'active') return
    await this.runtime.submitResult(sessionId, { summary: 'worker finished (fixture auto-submit)' })
  }

  agent(sessionId: SessionId): Agent | undefined {
    return this.live.get(sessionId)
  }

  rootAgent(sessionId: SessionId = this.primary): Agent {
    const agent = this.live.get(sessionId)
    if (agent === undefined) throw new Error(`the stack holds no root agent for "${sessionId}"`)
    return agent
  }

  get spawns(): readonly SpawnRequest[] {
    return this.agentRuntime.requests
  }

  visible(agent: Agent): string[] {
    return this.ctx.tools.schemas(agent).map(schema => schema.name).sort()
  }

  events(storeId: string): TaskEvent[] {
    return (this.log.get(storeId) ?? []).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
  }

  async snapshot(storeId: string): Promise<TaskSnapshot> {
    return this.task.snapshotIn(storeId)
  }

  async root(sessionId: SessionId, contract: RootContractSpec): Promise<{ storeId: string; taskId: string; runId: string }> {
    const storeId = rootTaskStoreId(sessionId)
    // The person asked for this objective, and that request is recorded on the
    // session's own durable log before the intake reads it (A0 §1.10): a root
    // contract's origin is what the session's log holds, and a fixture that
    // intaken without one would model a session nobody asked anything of.
    await this.recordRequest(sessionId, contract.objective)
    const activated = await this.runtime.intakeRootContract(storeId, sessionId, contract)
    if (activated.status !== 'activated') {
      throw new Error(
        `the fixture expected an activated root for session "${sessionId}" but the intake answered "${activated.status}": ${activated.detail}`,
      )
    }
    return { storeId, taskId: activated.taskId, runId: activated.runId }
  }

  /**
   * Record one request of the person's own on a session's durable log: the
   * `user/message` event with `source.kind === 'user'` that a root contract's
   * origin is read from. This stack runs no model turn, so the message is written
   * through the persistence handle the loop's own appends travel through instead of
   * queued at an agent, in the shape the loop writes (surface intent included).
   */
  private async recordRequest(sessionId: SessionId, text: string): Promise<void> {
    const stored = this.log.get(String(sessionId))
    if (stored === undefined) throw new Error(`the fixture holds no session log for "${String(sessionId)}"`)
    const handle = await this.persistence.open(sessionId, 'write')
    try {
      await handle.append([{
        type: 'user/message',
        seq: SessionSeq(stored.length),
        time: Date.now(),
        data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      }])
    } finally {
      await handle.close()
    }
  }

  async call(agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.callSeq += 1
    const result = await this.ctx.tools.execute({
      callId: `call-${this.callSeq}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
    return {
      isError: result.isError,
      text: result.content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
    }
  }

  async assemblePrompt(agent: Agent): Promise<string> {
    const assembly = await this.ctx.systemPrompt.assemble({ agent, scope: agent })
    return renderPrompt(assembly)
  }

  async dispose(): Promise<void> {
    if (this.previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = this.previousHome
    await this.ctx.fiber.dispose()
    rmSync(this.workspace, { recursive: true, force: true })
  }
}

/**
 * The real `AgentRuntime.spawn`, with every request recorded: the prompt and the
 * contract block the runtime hands a worker are what the deployment's own spawn
 * seam receives, so a spec asserting "the worker was told" reads them here rather
 * than from a re-render.
 */
class RecordingAgentRuntime extends AgentRuntime {
  readonly requests: SpawnRequest[] = []

  constructor(
    ctx: Context,
    private readonly sessionRoot: Map<string, string>,
    private readonly primary: () => string,
  ) {
    super(ctx)
  }

  override async spawn(parent: Agent, request: SpawnRequest): Promise<AgentHandle> {
    this.requests.push(request)
    this.sessionRoot.set(request.sessionId, this.sessionRoot.get(parent.id) ?? this.primary())
    return super.spawn(parent, request)
  }
}

/** SHA-256 of text, computed here so the implementation is never confirmed against itself. */
export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A loadable `SKILL.md`: the frontmatter `readSkillFile` requires, plus whatever body a test is about. */
export function skillText(body: string, name: string, description = `${name} fixture skill`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
}

/**
 * Write one guidance skill — a `SKILL.md` alone, the shape the deployment's own
 * reference skills have — where both discovery viewpoints reach it. The digest a
 * spec sees in a binding or a verdict is of exactly these bytes.
 */
export async function writeGuidanceSkill(root: string, name: string, body: string, declaredName = name): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), skillText(body, declaredName), 'utf8')
  return directory
}

/**
 * Write one knowledge skill: a `SKILL.md` plus a knowledge sidecar whose declared
 * content identity is the digest of exactly those bytes. `extra` merges into the
 * declaration, so a spec can install a shape the validator must refuse.
 */
export async function writeKnowledgeSkill(
  root: string,
  name: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const content = skillText(body, name)
  await writeFile(join(directory, 'SKILL.md'), content, 'utf8')
  const sidecar = {
    contractVersion: 1,
    type: 'knowledge',
    source: 'this test fixture',
    scope: 'S1-C integration fixture',
    content: { skillMdSha256: sha256Of(content), resources: [] },
    contentCheck: { kind: 'command', command: 'true' },
    ...extra,
  }
  await writeFile(join(directory, 'SKILL.contract.json'), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
  return directory
}

/** Copy one fixture skill directory (`task-runtime/tests/fixtures/skills/<name>`) under `root`. */
export async function copyFixtureSkill(root: string, name: string): Promise<string> {
  const directory = join(root, name)
  await cp(join(FIXTURE_SKILLS, name), directory, { recursive: true })
  return directory
}

/** Write an arbitrary file inside a directory, creating parents — for resources and tamper fixtures. */
export async function writeWithin(directory: string, relative: string, contents: string): Promise<string> {
  const file = join(directory, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
  return file
}
