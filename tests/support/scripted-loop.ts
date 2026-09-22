/**
 * A whole deployment whose model is scripted: the real DSH loop, the real
 * singularity tool surface, and one script per session instead of a provider.
 *
 * What is replaced, and why:
 * - the model provider — {@link ScriptedModelAdapter} answers each request from
 *   the script of the session that asked (keyed by `GenerateOptions.sessionId`,
 *   the field the loop sets on every request). No network, no key, and the
 *   requests themselves are the record: their messages are what the loop would
 *   have sent, plugin notices included.
 * - `sessionPersistence` — an in-memory backend with the JSONL backend's
 *   contract shape, so the session log a spec reads back is the log the loop
 *   really appended through. Living sessions route their events into their
 *   write handle, which is what makes `eventsOf` a read of the durable surface
 *   and not of a fixture copy.
 *
 * Everything else is the deployment's own: `LlmRuntime`, `SessionStore`,
 * `SessionProjectionRegistry`, `SystemPrompt`, `ToolRuntime`, `AgentRegistry`,
 * `AgentLoop`, the real `AgentRuntime` (so `spawn` goes through
 * `ctx.agents.create` and the loop really starts the worker's turn), the real
 * `TaskService`/`TaskRuntime`/`VerifierRegistry`, and the real singularity
 * tools. The tool plane is the global registry rather than a mounted preset
 * scope: both the root's own allow-list (`ROOT_TOOLS`, applied by
 * `AgentRuntime`) and the worker grant (`grants.ts`) filter the inherited plane
 * the same way, so the surfaces here are the deployment's.
 *
 * Crash recovery is deliberately *not* this fixture's subject (a process-local
 * log cannot die): `tests/integration/a3-recovery.spec.ts` mounts the real JSONL
 * backend for that.
 * @module tests/support/scripted-loop
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { toolCallResponse, textResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import LlmRuntime, { LlmAdapter, createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { GenerateOptions, Message, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import AgentLoop from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { TaskInstance, TaskRun } from '../../task/src/types.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { defineCapabilityListTool } from '../../agent-singularity/src/tools/capability-list.ts'
import { defineTaskCancelTool } from '../../agent-singularity/src/tools/task-cancel.ts'
import { defineTaskDecomposeTool } from '../../agent-singularity/src/tools/task-decompose.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import { defineTaskStatusTool } from '../../agent-singularity/src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../agent-singularity/src/tools/task-submit-result.ts'
import type { CapabilityConfig, Config } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'

/** The root agent's allow-list, exactly as `agent-runtime` composes it. Exported so a fixture that mounts no loop still composes the deployment's root surface. */
export const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'skill', 'task_decompose',
  'task_submit_result', 'task_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/** The deployment's other global tools: the worker baseline's plane plus the session readers. */
export const OTHER_TOOLS = [
  'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'ask_user_question',
  'web_fetch', 'subagent_fetchless', 'session_search', 'session_event_read', 'session_trace',
]

/** The tools this fixture registers for real; every other name is a stand-in. */
const REAL_TOOLS = ['task_read', 'task_status', 'capability_list', 'task_decompose', 'task_submit_result', 'task_cancel']

/** One scripted model answer: a tool call, a final text, a latch that blocks the request, or a hang. */
export type ScriptEntry =
  | { readonly tool: string; readonly args?: Readonly<Record<string, unknown>> }
  | { readonly text: string }
  /**
   * Block this request until the latch resolves, then answer from the *next*
   * entry in the same request. That is what keeps a session mid-turn ("in
   * flight") for as long as a spec needs, without ending its turn — an idle
   * session would be a different state for the runtime to read.
   */
  | { readonly waitFor: () => Promise<void> }
  /** Answer nothing and never finish: the request stays in flight until the turn is cancelled. */
  | { readonly hang: true }

/** One model request the adapter answered or is answering, with the texts the loop would have sent. */
export interface ScriptedRequest {
  readonly options: GenerateOptions
  /** Every text block of every message in the request, flattened for assertions. */
  readonly texts: readonly string[]
}

/** One tool call this deployment dispatched, in dispatch order. */
export interface ToolCallRecord {
  readonly order: number
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly args: unknown
  /** The settled answer, once the call reported a result — a deny is a result too. */
  result?: { readonly isError: boolean; readonly text: string }
}

/** One spawn the runtime asked the real `AgentRuntime` for. */
export interface ScriptedSpawn {
  readonly sessionId: string
  readonly name: string
  readonly prompt: string
}

export interface ScriptedLoopOptions {
  readonly capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** Root sessions of this deployment, in order; the first is the primary. Defaults to `['s-root']`. */
  readonly roots?: readonly string[]
  /** No-progress rounds before an unsubmitted worker is stopped. Defaults to the runtime's own (3). */
  readonly noProgressRounds?: number
  readonly verifyTimeoutMs?: number
  readonly writeDrainTimeoutMs?: number
  readonly objective?: string
  /** Tools whose recorded execution also keeps its arguments — the side-effect probe a denial is asserted against. */
  readonly probes?: readonly string[]
  /**
   * The script of one session: index 0 is the primary root, 1..n the sessions
   * the runtime spawned, in spawn order. Entries are consumed one request at a
   * time; an exhausted script answers an empty text, which ends the turn.
   */
  readonly script: (sessionId: string, index: number) => readonly ScriptEntry[]
}

export interface ScriptedLoop {
  readonly ctx: Context
  readonly runtime: TaskRuntime
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  /** The tmp directory the whole fixture lives in. */
  readonly workspace: string
  /** The pinned `$DSH_HOME`/`$HOME`. */
  readonly home: string
  /** The env checkout every worker runs in and the verifier's commands run from. */
  readonly checkout: string
  /** Every spawn request, in order. */
  readonly spawns: readonly ScriptedSpawn[]
  /** Every tool call dispatched here, in order, deny included. */
  readonly calls: readonly ToolCallRecord[]
  /** Every stand-in body that actually ran, in order (`name`, or `name:{args}` for a probed tool) — a denied call never reaches one. */
  readonly executed: readonly string[]
  /** The requests of one session, in order, as the adapter saw them. */
  requestsOf(sessionId: SessionId | string): readonly ScriptedRequest[]
  /** One session's events, read back from the persistence backend the loop appended through. */
  eventsOf(sessionId: SessionId | string): readonly SessionEvent[]
  /** The store's snapshot as the store itself holds it. */
  snapshot(storeId: string): Promise<TaskSnapshot>
  /** Create the root run and start the root's first turn. */
  begin(): Promise<{ storeId: string; taskId: string; runId: string }>
  /** The run a session is bound to, with the store and task it belongs to. */
  runForSession(sessionId: SessionId | string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }>
  dispose(): Promise<void>
}

/** The stacks in play, so a spec's `afterEach` can dispose whatever a failed test left behind. */
const stacks: ScriptedLoopImpl[] = []

/** Dispose every stack started since the last call and release the pinned environment. */
export async function disposeScriptedLoops(): Promise<void> {
  for (const stack of stacks.splice(0)) await stack.dispose()
  vi.unstubAllEnvs()
}

/** Boot the stack. Every tmp path is created inside one newly minted workspace. */
export async function startScriptedLoop(options: ScriptedLoopOptions): Promise<ScriptedLoop> {
  const stack = new ScriptedLoopImpl(options)
  stacks.push(stack)
  return stack.start()
}

/** A stand-in for one tool name: it answers its own name, and records that its body ran. */
function standIn(name: string, ran: (name: string, args: unknown) => void): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
    execute: async (args: unknown) => {
      ran(name, args)
      return `${name}: fixture answer`
    },
  }
}

/** Wait for one latch, or reject when the turn is cancelled: a parked request must not outlive its turn. */
async function raceAbort(latch: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await latch
  if (signal.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    void latch.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error as Error)
      },
    )
  })
}

/** Every text block the loop put in one request, in message order. */
function requestTexts(messages: readonly Message[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'text') texts.push(block.text)
  }
  return texts
}

/**
 * The scripted provider: one script per session, consumed one request at a
 * time. The chunk builders are DSH's own (`agent-loop/tests/mock-adapter.ts`),
 * so what a scripted tool call looks like on the wire is the shape the real
 * loop's tests use, not a second implementation of it.
 */
class ScriptedModelAdapter extends LlmAdapter {
  private readonly requests = new Map<string, ScriptedRequest[]>()
  private readonly queues = new Map<string, ScriptEntry[]>()
  private callSeq = 0

  constructor(
    private readonly script: (sessionId: string, index: number) => readonly ScriptEntry[],
    private readonly indexOf: (sessionId: string) => number,
  ) {
    super()
  }

  requestsOf(sessionId: string): readonly ScriptedRequest[] {
    return this.requests.get(sessionId) ?? []
  }

  private queueFor(sessionId: string): ScriptEntry[] {
    const existing = this.queues.get(sessionId)
    if (existing !== undefined) return existing
    const created = [...this.script(sessionId, this.indexOf(sessionId))]
    this.queues.set(sessionId, created)
    return created
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queueFor(sessionId)
    const recorded = this.requests.get(sessionId) ?? []
    recorded.push({ options, texts: requestTexts(options.messages) })
    this.requests.set(sessionId, recorded)

    let entry: ScriptEntry | undefined
    for (;;) {
      entry = queue.shift()
      if (entry === undefined) break
      if ('waitFor' in entry) {
        await raceAbort(entry.waitFor(), options.signal)
        continue
      }
      break
    }
    if (entry === undefined) {
      // The script is spent: the model answers nothing and the turn ends, which
      // is how a scripted session finishes the work it was given.
      yield* textResponse('')
      return
    }
    if ('hang' in entry) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'still working' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if ('text' in entry) {
      yield* textResponse(entry.text)
      return
    }
    this.callSeq += 1
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...(entry.args ?? {}) })
  }
}

/** One stored session: the header and the events every handle of it shares. */
interface StoredSession {
  header: SessionHeader
  events: SessionEvent[]
}

class ScriptedLoopImpl implements ScriptedLoop {
  readonly workspace: string
  readonly home: string
  readonly checkout: string
  private readonly roots: readonly SessionId[]
  readonly ctx: Context
  readonly task: TaskService
  /** Assigned by `start()`, after the plugins they are mounted as. */
  verifier!: VerifierRegistry
  runtime!: TaskRuntime
  private readonly storeId: string
  readonly adapter: ScriptedModelAdapter
  private readonly log = new Map<string, StoredSession>()
  private readonly sessionRoot = new Map<string, string>()
  private readonly spawnRecords: ScriptedSpawn[] = []
  private readonly callRecords: ToolCallRecord[] = []
  private readonly executedNames: string[] = []
  private readonly primary: SessionId
  private previousHome: string | undefined
  private callOrder = 0

  constructor(private readonly options: ScriptedLoopOptions) {
    this.workspace = mkdtempSync(join(tmpdir(), 'singularity-scripted-loop-'))
    this.checkout = join(this.workspace, 'env')
    this.home = join(this.workspace, 'dsh-home')
    mkdirSync(this.checkout, { recursive: true })
    mkdirSync(join(this.home, 'skills'), { recursive: true })
    this.roots = (options.roots ?? ['s-root']).map(id => id as SessionId)
    this.primary = this.roots[0]!
    this.storeId = rootTaskStoreId(this.primary)
    this.ctx = new Context()
    this.previousHome = process.env.DSH_HOME
    vi.stubEnv('DSH_HOME', this.home)
    vi.stubEnv('HOME', this.home)
    process.env.DSH_HOME = this.home
    for (const root of this.roots) this.sessionRoot.set(root, root)
    this.adapter = new ScriptedModelAdapter(options.script, sessionId => {
      const rootIndex = this.roots.indexOf(sessionId as SessionId)
      if (rootIndex >= 0) return rootIndex
      const spawned = this.spawnRecords.findIndex(record => record.sessionId === sessionId)
      return spawned < 0 ? this.roots.length : this.roots.length + spawned
    })
    this.task = new TaskService(this.ctx)
  }

  async start(): Promise<this> {
    const ctx = this.ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], this.adapter))
    for (const header of this.roots) {
      this.log.set(header, {
        header: {
          version: SESSION_FORMAT_VERSION,
          id: header,
          createdAt: Date.now(),
          isSeeded: false,
          cwd: this.checkout,
          agentPreset: 'standard',
        } as unknown as SessionHeader,
        events: [],
      })
    }
    ctx.provide('sessionPersistence', {
      list: async () => [...this.log.values()].map(stored => ({ header: stored.header })),
      create: async (header: SessionHeader) => {
        if (this.log.has(header.id)) throw new Error(`session "${header.id}" already exists`)
        this.log.set(header.id, { header, events: [] })
        return this.handle(header.id, 'write')
      },
      open: async (id: SessionId, access: 'read' | 'write' = 'read') => {
        if (!this.log.has(id)) throw new Error(`missing session ${id}`)
        return this.handle(id, access)
      },
      flush: async () => {},
    } as never)
    // The deployment's other services. The loop's own turn drives everything
    // else, so these are the seams a graph deployment provides and nothing more.
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
    ctx.provide('approval', { request: vi.fn(async () => 'allowed-once') })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
    ctx.provide('layout', { setIn: async () => {} })
    const graphState = {
      version: 1,
      id: 'g1',
      roots: [...this.roots],
      agents: this.roots.map(id => ({ id, name: 'Singularity', status: 'idle' as const })),
      groups: [] as unknown[],
      edges: [] as unknown[],
    }
    ctx.provide('graph', {
      snapshotIn: async () => structuredClone(graphState),
      commitIn: async (_storeId: string, events: readonly { kind: string; agent?: { id: string; name: string; status: string }; edge?: unknown }[]) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined) graphState.agents.push(event.agent as never)
          if (event.kind === 'edge/add' && event.edge !== undefined) graphState.edges.push(event.edge)
        }
      },
      setStatusIn: async () => {},
      addAgentIn: async (_storeId: string, agent: { id: string; name: string; status: string }) => { graphState.agents.push(agent as never) },
    } as never)
    ctx.provide('graphs', {
      graphForSession: async (sessionId: SessionId) => ({
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: this.sessionRoot.get(sessionId) ?? this.primary,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
    } as never)
    ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: this.checkout, components: [] } : undefined) } } as never)

    // The tool plane: the real singularity tools, stand-ins for the rest, and a
    // probe for the names a spec wants proof about.
    const probe = new Set(this.options.probes ?? [])
    const register = (name: string): void => {
      ctx.tools.register(standIn(name, (ran, args) => {
        if (probe.has(ran)) this.executedNames.push(`${ran}:${JSON.stringify(args ?? {})}`)
        else this.executedNames.push(ran)
      }))
    }
    for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
      if (REAL_TOOLS.includes(name)) continue
      register(name)
    }
    ctx.tools.register(defineTaskReadTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineCapabilityListTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    ctx.tools.register(defineTaskCancelTool(ctx))

    // The dispatch record: every call the deployment ran through the registry,
    // deny included (a denied call reports a result too), in order.
    ctx.on('tools/result', (exec, result) => {
      const record = this.callRecords.find(item => item.callId === String(exec.callId))
      if (record === undefined) return
      const text = (result.content ?? [])
        .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n')
      record.result = { isError: result.isError === true, text }
    })
    // Live events of every announced session land in its stored log, which is
    // what makes `eventsOf` a read of the durable surface.
    ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
      this.log.get(String(session.id))?.events.push(event)
    })

    this.agentRuntime = new RecordingAgentRuntime(ctx, request => this.spawnRecords.push({
      sessionId: String(request.sessionId),
      name: request.name,
      prompt: request.prompt.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
    }))
    await ctx.plugin(AgentLoop, { agents: [] })
    // The verifier and the runtime are mounted the way the deployment's loader
    // mounts them, not constructed beside it: `[Service.init]` is what registers
    // the runtime's gate on `tools/pre-execute`/`tools/result`, so a fixture that
    // built the service with `new` would run every tool call ungated.
    await ctx.plugin(VerifierRegistry, { evidenceRoot: join(this.workspace, 'evidence') })
    this.verifier = ctx.get('verifier') as VerifierRegistry
    await ctx.plugin(TaskRuntime, {
      capabilities: { ...(this.options.capabilities ?? {}) },
      ...(this.options.noProgressRounds === undefined ? {} : { noProgressRounds: this.options.noProgressRounds }),
      ...(this.options.verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs: this.options.verifyTimeoutMs }),
      ...(this.options.writeDrainTimeoutMs === undefined ? {} : { writeDrainTimeoutMs: this.options.writeDrainTimeoutMs }),
      runBindingRoot: join(this.home, 'singularity', 'run-bindings'),
    } as Config)
    this.runtime = ctx.get('taskRuntime') as TaskRuntime
    // The call record goes in front of the gate's own pre-execute listener,
    // because a denial short-circuits the waterfall and would otherwise leave a
    // refused call unrecorded. Registered here — after the runtime's own
    // `prepend` — so `unshift` puts this listener first.
    ctx.on('tools/pre-execute', (exec, next) => {
      const known = this.callRecords.find(record => record.callId === String(exec.callId))
      if (known !== undefined) return next()
      this.callOrder += 1
      this.callRecords.push({
        order: this.callOrder,
        sessionId: String(exec.agent?.id ?? ''),
        callId: String(exec.callId),
        name: String(exec.name),
        args: exec.arguments,
      })
      return next()
    }, { prepend: true })
    // The root agents the real loop's own entry mints: `resumeRoot` reads the
    // graph, the persisted header and the agent preset, so what runs here is the
    // deployment's root composition (its prompt section and its allow-list).
    for (const root of this.roots) await this.agentRuntime.ensureRoot(root, { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' })
    return this
  }

  agentRuntime!: RecordingAgentRuntime

  private handle(id: SessionId, access: 'read' | 'write') {
    const stored = (): StoredSession => {
      const found = this.log.get(String(id))
      if (found === undefined) throw new Error(`missing session ${id}`)
      return found
    }
    return {
      id,
      header: stored().header,
      access,
      inheritedEventCount: 0,
      read: async (offset = 0, length?: number) => ({ eventState: 'detached' as const, events: stored().events.slice(offset, length === undefined ? undefined : offset + length) }),
      append: async (events: readonly SessionEvent[]) => {
        stored().events.push(...events)
      },
      flush: async () => {},
      close: async () => {},
    }
  }

  get spawns(): readonly ScriptedSpawn[] {
    return this.spawnRecords
  }

  get calls(): readonly ToolCallRecord[] {
    return this.callRecords
  }

  get executed(): readonly string[] {
    return this.executedNames
  }

  requestsOf(sessionId: SessionId | string): readonly ScriptedRequest[] {
    return this.adapter.requestsOf(String(sessionId))
  }

  eventsOf(sessionId: SessionId | string): readonly SessionEvent[] {
    return this.log.get(String(sessionId))?.events ?? []
  }

  async snapshot(storeId: string): Promise<TaskSnapshot> {
    return await this.task.snapshotIn(storeId)
  }

  /** The live agent of one session, from the real loop's registry. */
  private agent(sessionId: SessionId | string = this.primary): Agent {
    const agent = this.ctx.agents.get(String(sessionId))
    if (agent === undefined) throw new Error(`the stack holds no live agent for "${sessionId}"`)
    return agent
  }

  async runForSession(sessionId: SessionId | string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
    return await this.runtime.runForSession(String(sessionId))
  }

  async begin(): Promise<{ storeId: string; taskId: string; runId: string }> {
    const { taskId, runId } = await this.runtime.createRootTask(
      this.storeId,
      { objective: this.options.objective ?? 'ship the release', rootSessionId: this.primary },
      this.primary,
    )
    this.agent(this.primary).followup(createUserMessage({ content: [{ type: 'text', text: 'begin' }], source: { kind: 'user' } }))
    return { storeId: this.storeId, taskId, runId }
  }

  async dispose(): Promise<void> {
    if (this.previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = this.previousHome
    await this.ctx.fiber.dispose()
    rmSync(this.workspace, { recursive: true, force: true })
  }
}

/**
 * The real `AgentRuntime`, with the root agent minted by the real loop
 * (`ensureRoot`) and every spawn recorded. Nothing about the spawn path is
 * replaced: `spawn` resolves the live parent from the registry, calls
 * `ctx.agents.create` (the loop's own factory), which mints the worker's
 * session, scope and first turn.
 */
class RecordingAgentRuntime extends AgentRuntime {
  constructor(
    ctx: Context,
    private readonly onSpawn: (request: SpawnRequest) => void,
  ) {
    super(ctx)
  }

  override async spawn(parent: Agent, request: SpawnRequest) {
    this.onSpawn(request)
    return await super.spawn(parent, request)
  }
}
