/**
 * The worker recovery entry on a real restart (A4 §F.1, first sub-goal of the
 * rework): a spawned, run-bound worker is driven to a crash, the process is
 * abandoned, and a second boot over the same directory brings **the same
 * Session** back through `AgentRuntime.resumeWorkerAgent`.
 *
 * What is real: `session-persistence-jsonl` and the bytes it writes, the real
 * `SessionStore`, the real `AgentLoop` (so the Session is published, the
 * Inbox restored and the driver really idle), the real `SessionQueryEngine`
 * over those bytes, the real `ToolRuntime` with the deployment's restriction
 * and execution-guard mechanics, and the real `AgentRuntime` — the spawn that
 * creates the worker is `agent-runtime`'s own, the composition under test is
 * the shared `workerSetup`, and the delivery that follows is `messages.ts`.
 * Only the model is scripted: one adapter answers per session, so a turn exists
 * because a model produced it.
 *
 * The two facts this spec exists to pin down, both stated by the progress
 * review as the reason the ticket went back to rework:
 *
 * - a question-waiting worker's Session is **live again after a restart**, not
 *   only its Run: the same identity, the same delegation facts, the same tool
 *   face, the same permission posture, the same prompt section and the same
 *   raw-session seal — and the delivery that was `unavailable` before the
 *   resume settles as `delivered` after it;
 * - the entry wakes nothing: the resumed worker is idle, its model is asked
 *   nothing until the caller delivers what the Session is owed, and the refusal
 *   cases leave the Session's bytes and the graph exactly as they were.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { renderPrompt } from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import { assembleContextFor } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '../../../../thirdparty/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { textResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rootTaskStoreId } from '../../task/src/index.ts'
import {
  AgentRuntime,
  RAW_SESSION_READ_DENIAL,
  WorkerResumeRefusal,
  WORKER_POLICY_TEXT,
  questionMessageText,
} from '../../agent-runtime/src/index.ts'
import type { WorkerGrant } from '../../agent-runtime/src/types.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

const PROVIDER = 'fake'
const MODEL = 'fake-1'
const PARENT = 's-parent'
const WORKER = 's-worker'
const STORE = rootTaskStoreId(PARENT)
const SCOPE = { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }
const MESSAGE_ID = 'm-question-1'

/**
 * The plane this deployment mounts: the root's own composition plus the
 * deployment's other global tools — including the four raw cross-session
 * readers, registered on purpose, because the seal is an execution guard and a
 * guard can only be shown against a surface that would otherwise answer the
 * call.
 */
const PLANE = [...new Set([...ROOT_TOOLS, ...OTHER_TOOLS])]

/** The one grant this spec spawns with: a capability naming `read`, plus the baseline `task_read`. */
function grant(): WorkerGrant {
  return {
    capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }],
    baseline: ['task_read'],
    keepPresetTools: false,
  }
}

/** One tool the deployment offers, answering its own name and recording that its body ran. */
function standIn(name: string, ran: string[]): {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, never> }
  output: { schema: { type: 'string' }; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] }
  execute: (args: unknown) => Promise<string>
} {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }] },
    execute: async () => {
      ran.push(name)
      return `${name}: fixture answer`
    },
  }
}

/** One scripted model answer: a final text, or a request that never finishes (a process that died mid-turn). */
type ScriptEntry = { readonly text: string } | { readonly hang: true }

/** One script per session, consumed one request at a time; what is replaced here is the model and nothing else. */
class ScriptedAdapter extends LlmAdapter {
  private readonly queues = new Map<string, ScriptEntry[]>()
  private readonly requests = new Map<string, GenerateOptions[]>()

  constructor(private readonly script: (sessionId: string) => readonly ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  requestsOf(sessionId: string): readonly GenerateOptions[] {
    return this.requests.get(sessionId) ?? []
  }

  /** Every text block of every message one session's requests carried, in request order. */
  textsOf(sessionId: string): string[] {
    return this.requestsOf(sessionId).flatMap(options =>
      options.messages.flatMap(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))),
    )
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queues.get(sessionId) ?? [...this.script(sessionId)]
    this.queues.set(sessionId, queue)
    const served = this.requests.get(sessionId) ?? []
    served.push(options)
    this.requests.set(sessionId, served)
    const entry = queue.shift()
    if (entry === undefined || 'text' in entry) {
      yield* textResponse(entry === undefined ? '' : entry.text)
      return
    }
    // A request that never settles: the turn stays open, exactly as a process
    // killed mid-request leaves it in its own log.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'still working' }
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new Error('aborted'))
        return
      }
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
}

/** The engine's two search faces are not this fixture's subject; every exact read is the shipped implementation. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not part of this fixture'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not part of this fixture'))
  }
}

/** What one boot's graph store holds: the members and edges a restart re-reads. */
interface GraphSeed {
  readonly roots: readonly string[]
  readonly members: readonly string[]
  readonly edges: readonly { readonly kind: string; readonly from: string; readonly to: string }[]
}

interface BootOptions {
  /** The graph store's own record; absent = one graph rooted at the parent with the worker spawned under it. */
  readonly graph?: GraphSeed
  /** The session the model script is keyed by; absent = a worker that finishes its kickoff and waits. */
  readonly script?: (sessionId: string) => readonly ScriptEntry[]
  /** Mount the tool plane (the spawn cases need it; the restart cases read the restored surface). */
  readonly tools?: boolean
}

/** One boot of the deployment over one directory; a second boot over it is the restart. */
class Boot {
  private constructor(
    readonly ctx: Context,
    readonly runtime: AgentRuntime,
    readonly adapter: ScriptedAdapter,
    readonly dir: string,
    private readonly handles: { close: () => Promise<void> }[],
    private readonly graphState: { roots: string[]; agents: { id: string; name: string; status: string }[]; edges: { kind: string; from: string; to: string }[] },
    readonly ran: string[],
    readonly presetMounts: string[],
    readonly permissionSets: [string, string][],
    readonly statusWrites: { storeId: string; agentId: string; status: string }[],
  ) {}

  static async open(dir: string, options: BootOptions = {}): Promise<Boot> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SkillRegistry, {})
    const persistence = new JsonlSessionPersistence(ctx, { root: dir, compression: 'none' })
    const handles: { close: () => Promise<void> }[] = []
    const backend = persistence as unknown as {
      create: (...args: never[]) => Promise<{ close: () => Promise<void> }>
      open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    }
    const originalCreate = backend.create.bind(persistence)
    const originalOpen = backend.open.bind(persistence)
    backend.create = async (...args: never[]) => {
      const handle = await originalCreate(...args)
      handles.push(handle)
      return handle
    }
    backend.open = async (...args: never[]) => {
      const handle = await originalOpen(...args)
      handles.push(handle)
      return handle
    }
    const adapter = new ScriptedAdapter(options.script ?? (() => [{ text: 'noted' }]))
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(TestSessionQuery)
    await mountAgentLoopTestHarness(ctx)
    const ran: string[] = []
    if (options.tools !== false) for (const name of PLANE) ctx.tools.register(standIn(name, ran))
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
    const presetMounts: string[] = []
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      mount: async (_agentCtx: unknown, preset: string) => { presetMounts.push(preset) },
      resolve: async () => ({}),
    })
    const permissionSets: [string, string][] = []
    ctx.provide('permissionPresets', {
      // The real service records the selection itself; this fixture's stub cannot
      // reproduce its projection fold, so a case that needs the durable fact
      // writes the event into the log the way the service does.
      set: (session: { id: string }, preset: string) => { permissionSets.push([String(session.id), preset]) },
      resolve: () => ({}),
    })
    ctx.provide('layout', { setIn: async () => {} })
    const graphState = {
      roots: [...(options.graph?.roots ?? [PARENT])],
      agents: [...(options.graph?.members ?? [PARENT, WORKER])].map(id => ({ id, name: id === PARENT ? 'Singularity' : 'worker', status: 'idle' })),
      edges: [...(options.graph?.edges ?? [{ kind: 'spawn', from: PARENT, to: WORKER }])],
    }
    const statusWrites: { storeId: string; agentId: string; status: string }[] = []
    ctx.provide('graph', {
      snapshotIn: async () => ({
        version: 1,
        id: 'g',
        roots: graphState.roots,
        agents: graphState.agents,
        groups: [],
        edges: graphState.edges,
      }),
      commitIn: async (_storeId: string, events: readonly { kind: string; agent?: { id: string; name: string }; edge?: { kind: string; from: string; to: string } }[]) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined) graphState.agents.push({ ...event.agent, status: 'idle' })
          if (event.kind === 'edge/add' && event.edge !== undefined) graphState.edges.push(event.edge)
        }
      },
      addAgentIn: async (_storeId: string, agent: { id: string; name: string }) => { graphState.agents.push({ ...agent, status: 'idle' }) },
      setStatusIn: async (storeId: string, agentId: string, status: string) => { statusWrites.push({ storeId, agentId, status }) },
    })
    const runtime = new AgentRuntime(ctx)
    return new Boot(ctx, runtime, adapter, dir, handles, graphState, ran, presetMounts, permissionSets, statusWrites)
  }

  /** The parent root, created through the runtime's own root entry (the door the deployment's graph create uses). */
  async createRoot(cwd: string): Promise<Agent> {
    const handle = await this.runtime.createRoot({ sessionId: SessionId(PARENT), cwd, scope: SCOPE })
    return handle.agent
  }

  /** Spawn one task worker through the runtime's own door, with the grant this spec asserts on. */
  async spawnWorker(parent: Agent, options: { taskWorker?: boolean; prompt?: readonly { type: 'text'; text: string }[] } = {}): Promise<void> {
    await this.runtime.spawn(parent, {
      sessionId: SessionId(WORKER),
      name: 'worker',
      taskWorker: options.taskWorker ?? true,
      agentPreset: 'standard',
      permissionPreset: 'workspace-write',
      grant: grant(),
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    })
  }

  agent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  /** The names one agent's own composition offers, from the registry's view. */
  visible(agent: Agent): string[] {
    return this.ctx.tools.schemas(agent).map(schema => schema.name).sort()
  }

  /** Dispatch one call as one agent through the real registry and gate waterfall; a deny is a result too. */
  async call(agent: Agent, name: string): Promise<{ isError: boolean; text: string }> {
    const answer = await this.ctx.tools.execute({
      callId: `call-${name}`,
      name,
      arguments: {},
      agent,
      signal: new AbortController().signal,
    })
    return {
      isError: answer.isError === true,
      text: (answer.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
    }
  }

  /** The durable artifact one Session owns: the bytes a second boot would read. */
  artifact(sessionId: string): string {
    const suffix = join(sessionId, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
    const found = readdirSync(this.dir, { recursive: true })
      .map(entry => join(this.dir, String(entry)))
      .find(path => path.endsWith(suffix))
    if (found === undefined) throw new Error(`no artifact for session "${sessionId}" under ${this.dir}`)
    return found
  }

  /** The artifact's bytes, as the bytes a refused resume must leave alone. */
  bytes(sessionId: string): string {
    return readFileSync(this.artifact(sessionId), 'utf8')
  }

  /** The graph store's own commits this process made: what a restart's graph record holds. */
  commits(): { roots: string[]; members: string[]; edges: { kind: string; from: string; to: string }[] } {
    return { roots: [...this.graphState.roots], members: this.graphState.agents.map(agent => agent.id), edges: [...this.graphState.edges] }
  }

  /** The prompt one session's next request would be assembled from: the real waterfall, over the live world. */
  async prompt(sessionId: string): Promise<string> {
    const agent = this.agent(sessionId)
    if (agent === undefined) throw new Error(`the boot holds no live agent for "${sessionId}"`)
    return renderPrompt(await this.ctx.systemPrompt.assemble(assembleContextFor(agent)))
  }

  /** A process that died: the durability barrier for every live Session, then every descriptor released. */
  async crash(): Promise<void> {
    for (const session of this.ctx.sessions.list()) await this.ctx.sessions.flush(session)
    for (const handle of this.handles.splice(0)) await handle.close()
  }

  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
  }
}

const directories: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-a4-worker-resume-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The request a recovery pass states for this spec's worker: the store's Run facts and the spawn's authorization. */
function resumeRequest(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SessionId(WORKER),
    scope: SCOPE,
    run: {
      storeId: STORE,
      taskId: 't-child',
      runId: 'r-child',
      sessionId: SessionId(WORKER),
      agentPreset: 'standard',
      capabilitySnapshot: ['read'],
    },
    grant: grant(),
    permissionPreset: 'workspace-write',
    taskWorker: true,
    ...overrides,
  }
}

/** One refusal raised by an attempt, or `undefined` when it settled. */
async function refusalOf(attempt: Promise<unknown>): Promise<WorkerResumeRefusal | undefined> {
  const outcome = await attempt.then(() => undefined, (error: unknown) => error)
  expect(outcome).toBeInstanceOf(WorkerResumeRefusal)
  return outcome as WorkerResumeRefusal
}

/**
 * Boot one deployment, create the parent session, spawn the worker through the
 * real `AgentRuntime`, let its kickoff turn finish, and kill the process the way
 * a killed process dies — durable bytes stay, every descriptor goes.
 */
async function crashedWorker(dir: string, options: BootOptions = {}): Promise<{ first: Boot; graph: ReturnType<Boot['commits']>; surface: string[] }> {
  const first = await Boot.open(dir, options)
  const parent = await first.createRoot(dir)
  await first.spawnWorker(parent)
  // The worker's own turn: the scripted model answers the kickoff and the worker
  // goes idle — the state a question-waiting worker is in when the process dies.
  await vi.waitFor(() => expect(first.adapter.requestsOf(WORKER).length).toBeGreaterThan(0), { timeout: 20_000 })
  await first.agent(WORKER)!.whenIdle()
  const surface = first.visible(first.agent(WORKER)!)
  const graph = first.commits()
  await first.crash()
  return { first, graph, surface }
}

/** Boot a second process over the first one's bytes. */
async function restart(dir: string, graph: GraphSeed, options: BootOptions = {}): Promise<Boot> {
  return await Boot.open(dir, { ...options, graph })
}

describe('resuming a crashed worker (A4 §F.1)', () => {
  it('brings the same Session back live with its run binding, tool face, permission and prompt, and delivers to it', async () => {
    const dir = workspace()
    const { graph, surface } = await crashedWorker(dir)

    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })

    // The defect the rework closes: before the resume, nothing owns the worker
    // in the restarted process, so a delivery to it is `unavailable` — the
    // intent survives, nothing lands, no stand-in Session is invented.
    const before = await restarted.runtime.ensureAgentMessageDelivered({
      targetSessionId: SessionId(WORKER),
      senderSessionId: SessionId(PARENT),
      messageId: MESSAGE_ID,
      text: questionMessageText('q-1', 'which contract holds?'),
    })
    expect(before.status).toBe('unavailable')
    const requestsBefore = restarted.adapter.requestsOf(WORKER).length

    const handle = await restarted.runtime.resumeWorkerAgent(resumeRequest())
    const worker = handle.agent

    // The same Session, not a stand-in: identity, header and delegation facts.
    expect(String(worker.id)).toBe(WORKER)
    expect(String(worker.session.header.id)).toBe(WORKER)
    expect(worker.session.header.agentPreset).toBe('standard')
    expect(restarted.agent(WORKER)).toBe(worker)
    // The restarted process really re-read the durable log: the worker's first
    // turn is history, and the Session it drives is that Session's continuation.
    expect(worker.session.deriveMessages().length).toBeGreaterThan(0)

    // The composition is the spawn's: the same restricted surface (captured
    // before the crash), the same policy prompt, the same permission posture.
    expect(restarted.visible(worker)).toEqual(surface)
    expect(restarted.visible(worker)).toEqual(['read', 'task_read'])
    expect(await restarted.prompt(WORKER)).toContain(WORKER_POLICY_TEXT.split('\n')[0]!)
    expect(restarted.presetMounts).toContain('standard')
    expect(restarted.permissionSets).toContainEqual([WORKER, 'workspace-write'])

    // Restricted tools are still refused, and the seal a later mount cannot lift
    // holds on the resumed agent's own scope.
    const denied = await restarted.call(worker, 'write')
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('unknown tool "write"')
    expect(restarted.ran).toEqual([])
    for (const sealed of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      const refusal = await restarted.call(worker, sealed)
      expect(refusal.isError, sealed).toBe(true)
      expect(refusal.text, sealed).toContain(RAW_SESSION_READ_DENIAL)
    }
    expect(restarted.ran).toEqual([])

    // The wake contract: a resume sends nothing. The model was asked nothing
    // until the caller delivered what the Session was owed.
    expect(restarted.adapter.requestsOf(WORKER)).toHaveLength(requestsBefore)
    const delivery = await restarted.runtime.ensureAgentMessageDelivered({
      targetSessionId: SessionId(WORKER),
      senderSessionId: SessionId(PARENT),
      messageId: MESSAGE_ID,
      text: questionMessageText('q-1', 'which contract holds?'),
    })
    expect(delivery.status).toBe('delivered')
    await vi.waitFor(
      () => expect(restarted.adapter.requestsOf(WORKER).length).toBeGreaterThan(requestsBefore),
      { timeout: 20_000 },
    )
    // The delivered body reached an actual model request — the point of the
    // whole ticket: the worker can read the answer and continue.
    expect(restarted.adapter.textsOf(WORKER).some(text => text.includes(questionMessageText('q-1', 'which contract holds?')))).toBe(true)

    await restarted.runtime.stopAgents([SessionId(WORKER)])
    await restarted.dispose()
  })

  it('resumes a worker whose turn the crash interrupted, repairing it and waking nothing', async () => {
    const dir = workspace()
    const first = await Boot.open(dir, { script: sessionId => (sessionId === WORKER ? [{ hang: true }] : [{ text: 'noted' }]) })
    await first.createRoot(dir)
    await first.spawnWorker(first.agent(PARENT)!)
    await vi.waitFor(() => expect(first.adapter.requestsOf(WORKER).length).toBeGreaterThan(0), { timeout: 20_000 })
    const graph = first.commits()
    await first.crash()
    // The worker died mid-request: its log's last turn has no end.

    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] }, { script: sessionId => (sessionId === WORKER ? [{ hang: true }] : [{ text: 'noted' }]) })
    const requestsBefore = restarted.adapter.requestsOf(WORKER).length
    const handle = await restarted.runtime.resumeWorkerAgent(resumeRequest())

    expect(String(handle.agent.id)).toBe(WORKER)
    // The repair is in the log, and it is DSH's own: the turn the dead process
    // left open is closed, so the session folds as a balanced transcript.
    const log = await restarted.ctx.sessionQuery.readSession(SessionId(WORKER))
    const lastTurnStart = log.events.findLastIndex(event => event.type === 'turn/start')
    const lastTurnEnd = log.events.findLastIndex(event => event.type === 'turn/end')
    expect(lastTurnStart).toBeGreaterThan(-1)
    expect(lastTurnEnd).toBeGreaterThan(lastTurnStart)
    expect(restarted.adapter.requestsOf(WORKER)).toHaveLength(requestsBefore)
    // And the delivery still wakes it: the resumed session is reachable.
    const delivery = await restarted.runtime.ensureAgentMessageDelivered({
      targetSessionId: SessionId(WORKER),
      senderSessionId: SessionId(PARENT),
      messageId: MESSAGE_ID,
      text: questionMessageText('q-1', 'which contract holds?'),
    })
    expect(delivery.status).toBe('delivered')

    await restarted.runtime.stopAgents([SessionId(WORKER)])
    await restarted.dispose()
  })
})

describe('what a worker resume refuses, by name and with no side effect', () => {
  it('refuses a Session that does not exist, leaving the graph and the log alone', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })
    const workerBytes = restarted.bytes(WORKER)
    const agentsBefore = restarted.commits().members

    const refusal = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest({ sessionId: SessionId('s-ghost') })))

    expect(refusal?.code).toBe('session-missing')
    expect(restarted.agent('s-ghost')).toBeUndefined()
    expect(restarted.commits().members).toEqual(agentsBefore)
    expect(restarted.bytes(WORKER)).toBe(workerBytes)
    await restarted.dispose()
  })

  it('refuses a Session whose log is damaged, naming the read failure and writing nothing', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })
    // A killed writer's artifact, damaged past what the reader can recover: the
    // header stays readable (a restart still lists the session), one event line
    // does not.
    const artifact = restarted.artifact(WORKER)
    const lines = readFileSync(artifact, 'utf8').split('\n')
    writeFileSync(artifact, [lines[0]!, '{ "type": "turn/start" ', ...lines.slice(2)].join('\n'))
    const damaged = readFileSync(artifact, 'utf8')

    const refusal = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest()))

    expect(refusal?.code).toBe('session-unreadable')
    expect(restarted.agent(WORKER)).toBeUndefined()
    expect(readFileSync(artifact, 'utf8')).toBe(damaged)
    await restarted.dispose()
  })

  it('refuses a Session a live handle already owns, as the retryable conflict', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })
    await restarted.runtime.resumeWorkerAgent(resumeRequest())
    const workerBytes = restarted.bytes(WORKER)

    const refusal = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest()))

    expect(refusal?.code).toBe('ownership-conflict')
    // The second attempt changed nothing: the live owner is untouched and the
    // restarted process's own model was asked nothing.
    expect(restarted.agent(WORKER)).toBeDefined()
    expect(restarted.bytes(WORKER)).toBe(workerBytes)
    expect(restarted.adapter.requestsOf(WORKER)).toHaveLength(0)
    await restarted.runtime.stopAgents([SessionId(WORKER)])
    await restarted.dispose()
  })

  it('refuses a declared Run that contradicts the Session’s own record', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })
    const workerBytes = restarted.bytes(WORKER)

    const wrongSession = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest({
      run: { ...resumeRequest().run, sessionId: SessionId(PARENT) },
    })))
    expect(wrongSession?.code).toBe('binding-mismatch')

    const wrongPreset = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest({
      run: { ...resumeRequest().run, agentPreset: 'bb-verify' },
    })))
    expect(wrongPreset?.code).toBe('binding-mismatch')

    const wrongPlane = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest({
      grant: { ...grant(), capabilities: [{ capability: 'design-ball', tools: ['read', 'write'], skills: [] }] },
    })))
    expect(wrongPlane?.code).toBe('binding-mismatch')

    expect(restarted.agent(WORKER)).toBeUndefined()
    expect(restarted.bytes(WORKER)).toBe(workerBytes)
    await restarted.dispose()
  })

  it('refuses a permission preset the Session’s own recorded selection contradicts', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })
    // The durable selection the deployment's permission service records, written
    // the way it writes it: one `permission/preset` event on the session's log.
    const handle = await (restarted.ctx.sessionPersistence as unknown as {
      open: (id: SessionId, access: 'write') => Promise<{ append: (events: readonly unknown[]) => Promise<void>; close: () => Promise<void> }>
    }).open(SessionId(WORKER), 'write')
    const seq = (await restarted.ctx.sessionQuery.readSession(SessionId(WORKER))).events.length
    await handle.append([{ type: 'permission/preset', seq, time: Date.now(), data: { preset: 'read-only' } }])
    await handle.close()
    const recorded = restarted.bytes(WORKER)

    const refusal = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest()))

    expect(refusal?.code).toBe('binding-mismatch')
    expect(refusal?.message).toContain('read-only')
    expect(restarted.agent(WORKER)).toBeUndefined()
    expect(restarted.bytes(WORKER)).toBe(recorded)
    await restarted.dispose()
  })

  it('refuses a Session the graph does not publish, and a member with no delegation facts', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)

    const stranger = await restart(dir, { roots: [PARENT], members: [PARENT], edges: graph.edges })
    expect((await refusalOf(stranger.runtime.resumeWorkerAgent(resumeRequest())))?.code).toBe('not-in-graph')
    expect(stranger.agent(WORKER)).toBeUndefined()
    await stranger.dispose()

    const orphan = await restart(dir, { roots: [PARENT], members: [PARENT, WORKER], edges: [] })
    expect((await refusalOf(orphan.runtime.resumeWorkerAgent(resumeRequest())))?.code).toBe('member-facts-missing')
    expect(orphan.agent(WORKER)).toBeUndefined()
    await orphan.dispose()
  })

  it('is the narrow entry, not the root one: a graph root is refused with the entry an operator should use', async () => {
    const dir = workspace()
    const { graph } = await crashedWorker(dir)
    const restarted = await restart(dir, { ...graph, roots: [PARENT], members: [PARENT, WORKER] })

    // Stated the way a caller that confused the two entries would state it: the
    // parent's own identity, its own (empty) capability plane, no grant.
    const refusal = await refusalOf(restarted.runtime.resumeWorkerAgent(resumeRequest({
      sessionId: SessionId(PARENT),
      run: { ...resumeRequest().run, sessionId: SessionId(PARENT), capabilitySnapshot: [] },
      grant: undefined,
    })))

    expect(refusal?.code).toBe('member-facts-missing')
    expect(refusal?.message).toContain('ensureRoot')
    await restarted.dispose()
  })
})
