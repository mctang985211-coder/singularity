/**
 * A4 cold recovery, closed loop (plan §F.1): a deployment whose stores and
 * sessions live in the real JSONL log is booted, driven until a worker is
 * waiting on its parent's answer, killed, and booted again over the same
 * directory — and the *whole* exchange then completes: the same Sessions come
 * back, the parent's answer reaches the asking child's own model request, the
 * child submits, and the batch settles.
 *
 * What is real in every case: `session-persistence-jsonl` and the bytes it
 * writes (the store the second boot reads is the first boot's artifact), the
 * real `SessionStore` and `AgentLoop` (so the Inbox and its restored pending
 * entries are DSH's own), the real `SessionQueryEngine`, the real
 * `AgentRuntime` — the spawn that creates a worker, the root entry that brings a
 * root back, and the worker resume the recovery pass calls — the real
 * `TaskService`/`TaskRuntime` with its drivers and gates, the real
 * `VerifierRegistry`, and the **shipped** task tools (`task_intake`,
 * `task_decompose`, `task_submit_result`, `task_ask_parent`, `task_answer`).
 * What is scripted is the model and nothing else: one adapter answers each
 * request from a per-session script, so a `tool/call` exists because a model
 * made it.
 *
 * The facts this file exists to pin down — the two blockers the progress review
 * named, plus the planned A4-3 combinations on the real chain:
 *
 * - a question-waiting worker's Session is live again after a restart, under the
 *   same Session and Run identity, and the answer its parent writes really
 *   reaches the asking child's next model request;
 * - the batch driver that adopts such a child resumes it and waits under the run
 *   deadline, so a recovered wait is bounded like any other (`no question, no
 *   delivery, no end` was the old shape);
 * - every crash point of the exchange — intent recorded but never delivered,
 *   splice lost with the writer, splice durable but unclaimed, claim without the
 *   history entry — ends with the same identity, one domain effect and no
 *   duplicate inbox entry once the store is reopened.
 *
 * The replay tree is exercised for the combination it can reach (a real
 * `task_decompose` inside a replay task, whose children ask the replay); the
 * replay *driver's* own continuation across a restart stays out of this ticket
 * (A6/S2-R) and is named in that case.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import SessionStore from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import AgentLoop from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import LlmRuntime, { LlmAdapter, createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { GenerateOptions, LlmResolvedModelInfo, UserMessage, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { toolCallResponse, textResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerMessageText, questionMessageText } from '../../agent-runtime/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import { rootTaskStoreId, questionIdOf, TaskService } from '../../task/src/index.ts'
import type { CapabilityManifest, QuestionRecord, RunId, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { defineTaskAnswerTool } from '../../agent-singularity/src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../agent-singularity/src/tools/task-ask-parent.ts'
import { defineTaskDecomposeTool } from '../../agent-singularity/src/tools/task-decompose.ts'
import { defineTaskIntakeTool } from '../../agent-singularity/src/tools/task-intake.ts'
import { defineTaskSubmitResultTool } from '../../agent-singularity/src/tools/task-submit-result.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

const PROVIDER = 'mock'
const MODEL = 'mock'
const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
const SCOPE = { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }

/** The root contract every case runs under: one goal, one criterion a command settles. */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** One child spec: a goal and a criterion a command can settle. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/**
 * The capability manifest a decomposed child is admitted under: no capabilities
 * at all. It is a manifest like any other — a run's store record always carries
 * one, and the recovery's worker resume rebuilds the grant from exactly this
 * record — so a fixture that admitted children without one would be testing a
 * store no real batch writes.
 */
const NO_CAPABILITIES: CapabilityManifest = { capabilities: {}, missing: [], closure: 'closed' }

/** The tools registered as the deployment's own definitions; every other name in the plane is a stand-in. */
const SHIPPED_TOOLS = ['task_intake', 'task_decompose', 'task_submit_result', 'task_ask_parent', 'task_answer']

/** One scripted model answer: a tool call, a final text, a latch that parks the request, or a request that never ends. */
type ScriptEntry =
  | { readonly tool: string; readonly args?: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>) }
  | { readonly text: string }
  | { readonly waitFor: () => Promise<void> }
  | { readonly hang: true }

/** One request the adapter served, with the texts the loop would have sent. */
interface ServedRequest {
  readonly options: GenerateOptions
  readonly texts: readonly string[]
}

/** One tool call this deployment dispatched. */
interface DispatchedCall {
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly args: unknown
  result?: { readonly isError: boolean; readonly text: string }
}

/** One script per session, consumed one request at a time — the model, and nothing else, is scripted. */
class ScriptedAdapter extends LlmAdapter {
  private readonly queues = new Map<string, ScriptEntry[]>()
  private readonly requests = new Map<string, ServedRequest[]>()
  private callSeq = 0

  constructor(private readonly script: (sessionId: string, index: number) => readonly ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  requestsOf(sessionId: string): readonly ServedRequest[] {
    return this.requests.get(sessionId) ?? []
  }

  /** Every text block of every request one session served, in request order. */
  textsOf(sessionId: string): string[] {
    return this.requestsOf(sessionId).flatMap(request => request.texts)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queues.get(sessionId) ?? [...this.script(sessionId, this.index.resolve(sessionId))]
    this.queues.set(sessionId, queue)
    const served = this.requests.get(sessionId) ?? []
    served.push({
      options,
      texts: options.messages.flatMap(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))),
    })
    this.requests.set(sessionId, served)
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
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
    if ('text' in entry) {
      yield* textResponse(entry.text)
      return
    }
    this.callSeq += 1
    const args = typeof entry.args === 'function' ? entry.args() : entry.args ?? {}
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...args })
  }

  /** Which script index one session gets: the root is 0, the sessions this boot spawned follow in spawn order. */
  index: { resolve: (sessionId: string) => number } = { resolve: () => 0 }
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

/** The engine's two search faces are not this fixture's subject; every exact read is the shipped implementation. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not part of this fixture'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not part of this fixture'))
  }
}

/** The graph store's own records, as a durable store holds them across a restart. */
interface GraphRecords {
  readonly roots: readonly string[]
  readonly agents: readonly { readonly id: string; readonly name: string; readonly status: string }[]
  readonly edges: readonly { readonly kind: string; readonly from: string; readonly to: string }[]
}

/** One boot of the deployment over one directory; a second boot over it is the restart. */
class Boot {
  /** Every tool call this process dispatched, in order — what the scripts answer and what a case asserts on. */
  readonly calls: DispatchedCall[] = []
  /** Every session this process spawned, in spawn order. */
  readonly spawns: string[] = []
  readonly agentRuntime: AgentRuntime

  private constructor(
    readonly dir: string,
    readonly ctx: Context,
    readonly task: TaskService,
    readonly runtime: TaskRuntime,
    readonly adapter: ScriptedAdapter,
    agentRuntime: AgentRuntime,
    private readonly handles: { close: () => Promise<void> }[],
    readonly graph: {
      roots: string[]
      agents: { id: string; name: string; status: string }[]
      edges: { kind: string; from: string; to: string }[]
    },
  ) {
    this.agentRuntime = agentRuntime
  }

  static async open(
    dir: string,
    options: {
      readonly script: (sessionId: string, index: number) => readonly ScriptEntry[]
      /** The graph store the restart re-reads; absent for a first boot. */
      readonly graph?: GraphRecords
      readonly budget?: Readonly<{ wallTimeMs?: number }>
      readonly rootBudget?: Readonly<{ wallTimeMs?: number; maxRuns?: number }>
      /** The review policy a root contract is intaken under; the default is this runtime's own. */
      readonly generatedTaskReview?: 'off' | 'all'
    },
  ): Promise<Boot> {
    mkdirSync(join(dir, 'env'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const adapter = new ScriptedAdapter(options.script)
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
    const persistence = new JsonlSessionPersistence(ctx, { root: dir, compression: 'none' })
    const handles: { close: () => Promise<void> }[] = []
    const backend = persistence as unknown as {
      create: (header: SessionHeader) => Promise<{ append: (events: readonly unknown[]) => Promise<void>; close: () => Promise<void> }>
      open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    }
    // The root session's own durable record: a deployment's graph creation writes
    // the header of the root it is about to open *and* the person's request that
    // justifies it, and the runtime's root entry (`ensureRoot`) resumes exactly
    // that record. The fixture writes both the way the deployment does, so a
    // second boot finds the Session already there.
    if (!(await persistence.list()).some(item => String(item.header.id) === ROOT)) {
      const seed = await backend.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId(ROOT),
        createdAt: Date.now(),
        isSeeded: false,
        delegationDepth: 0,
        cwd: join(dir, 'env'),
        agentPreset: 'standard',
      } as unknown as SessionHeader)
      await seed.append([{
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: createUserMessage({ content: [{ type: 'text', text: 'ship the release' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      }] as never)
      await seed.close()
    }
    const originalCreate = backend.create.bind(persistence)
    const originalOpen = backend.open.bind(persistence)
    backend.create = async (header: SessionHeader) => {
      const handle = await originalCreate(header)
      handles.push(handle)
      return handle
    }
    backend.open = async (...args: never[]) => {
      const handle = await originalOpen(...args)
      handles.push(handle)
      return handle
    }
    await ctx.plugin(TestSessionQuery)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: () => {}, resolve: () => ({}) })
    ctx.provide('approval', { request: async () => 'allowed-once' })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
    ctx.provide('layout', { setIn: async () => {} })
    // A graph store publishes its root before the root's session is opened, and a
    // restart re-reads exactly those records: the fixture seeds them the way
    // `graphs.create` does when the case hands none over.
    const graph = {
      roots: [...(options.graph?.roots ?? [ROOT])],
      agents: (options.graph?.agents ?? [{ id: ROOT, name: 'Singularity', status: 'idle' }]).map(agent => ({ ...agent })),
      edges: (options.graph?.edges ?? []).map(edge => ({ ...edge })),
    }
    ctx.provide('graph', {
      snapshotIn: async () => ({
        version: 1,
        id: 'g1',
        roots: [...graph.roots],
        agents: graph.agents.map(agent => ({ id: agent.id, name: agent.name, status: agent.status })),
        groups: [],
        edges: graph.edges.map(edge => ({ ...edge })),
      }),
      commitIn: async (
        _storeId: string,
        events: readonly { kind: string; agent?: { id: string; name: string }; edge?: { kind: string; from: string; to: string } }[],
      ) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined) graph.agents.push({ ...event.agent, status: 'idle' })
          if (event.kind === 'edge/add' && event.edge !== undefined) graph.edges.push({ ...event.edge })
        }
      },
      setStatusIn: async (_storeId: string, agentId: string, status: string) => {
        const node = graph.agents.find(agent => agent.id === agentId)
        if (node !== undefined) node.status = status
      },
      addAgentIn: async (_storeId: string, agent: { id: string; name: string; status?: string }, isRoot?: boolean) => {
        if (!graph.agents.some(candidate => candidate.id === agent.id)) {
          graph.agents.push({ id: agent.id, name: agent.name, status: agent.status ?? 'idle' })
        }
        if (isRoot === true && !graph.roots.includes(agent.id)) graph.roots.push(agent.id)
      },
    } as never)
    ctx.provide('graphs', {
      graphForSession: async (sessionId: SessionId) => ({
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: ROOT,
        graphStoreId: SCOPE.graphStoreId,
        layoutStoreId: SCOPE.layoutStoreId,
        ...(String(sessionId) === ROOT ? {} : {}),
      }),
      list: async () => [{
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: ROOT,
        graphStoreId: SCOPE.graphStoreId,
        layoutStoreId: SCOPE.layoutStoreId,
      }],
      members: () => [...graph.roots, ...graph.agents.map(agent => agent.id)],
      edges: () => graph.edges.map(edge => ({ ...edge })),
    } as never)
    // The checkout is deliberately left unresolved (no `envBuilder`): this
    // fixture's subject is the question plane across a restart, and a workspace
    // marker names the *process* that wrote it — two boots inside one test
    // process would then fail each other's takeover for a reason that has
    // nothing to do with the question (the case `a3-workspace.spec.ts` owns).
    // The sessions still run in a real checkout (`join(dir, 'env')`), which is
    // what the verifier's commands resolve against.
    const standIn = (name: string): void => {
      ctx.tools.register({
        name,
        description: `tool ${name}`,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }] },
        execute: async () => `${name}: fixture answer`,
      })
    }
    for (const name of [...new Set([...ROOT_TOOLS, ...OTHER_TOOLS])]) {
      if (SHIPPED_TOOLS.includes(name)) continue
      standIn(name)
    }
    const agentRuntime = new AgentRuntime(ctx)
    const task = new TaskService(ctx)
    await ctx.plugin(VerifierRegistry, { evidenceRoot: join(dir, 'evidence') })
    await ctx.plugin(TaskRuntime, {
      capabilities: {},
      runBindingRoot: join(dir, 'run-bindings'),
      ...(options.budget === undefined ? {} : { budget: { ...options.budget } }),
      ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
      ...(options.generatedTaskReview === undefined ? {} : { generatedTaskReview: options.generatedTaskReview }),
    } as Config)
    const runtime = ctx.get('taskRuntime') as TaskRuntime
    ctx.tools.register(defineTaskIntakeTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    ctx.tools.register(defineTaskAskParentTool(ctx))
    ctx.tools.register(defineTaskAnswerTool(ctx))
    await ctx.plugin(AgentLoop, { agents: [] })
    const boot = new Boot(dir, ctx, task, runtime, adapter, agentRuntime, handles, graph)
    // The dispatch record, registered after the loop so a call the runtime's own
    // gate refuses still leaves its record: a deny reports a result too.
    ctx.on('tools/pre-execute', (exec, next) => {
      boot.calls.push({
        sessionId: String(exec.agent?.id ?? ''),
        callId: String(exec.callId),
        name: String(exec.name),
        args: exec.arguments,
      })
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      const record = boot.calls.find(call => call.callId === String(exec.callId))
      if (record === undefined) return
      record.result = {
        isError: result.isError === true,
        text: (result.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
      }
    })
    adapter.index = {
      resolve: (sessionId: string) => {
        if (sessionId === ROOT) return 0
        const spawned = boot.spawns.indexOf(sessionId)
        return spawned < 0 ? 1 : 1 + spawned
      },
    }
    // Every spawn this process makes is recorded in spawn order, which is what a
    // script keyed by index means; nothing about the spawn path is replaced.
    const originalSpawn = agentRuntime.spawn.bind(agentRuntime)
    agentRuntime.spawn = async (parent: Agent, request: Parameters<AgentRuntime['spawn']>[1]) => {
      boot.spawns.push(String(request.sessionId))
      return await originalSpawn(parent, request)
    }
    return boot
  }

  /**
   * Open one root session's store through the deployment's own entries and start
   * its first turn: the person's request on the session's own log, the intake
   * that activates the root contract, and the turn that reads them — the shape
   * `scripted-loop.ts` established, with the real persistence underneath.
   */
  async begin(contract: RootContractSpec = ROOT_CONTRACT): Promise<{ storeId: string; taskId: string; runId: string }> {
    await this.root()
    const activated = await this.runtime.intakeRootContract(STORE, ROOT, contract)
    if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.status}`)
    this.userSays('begin')
    return { storeId: STORE, taskId: activated.taskId, runId: activated.runId }
  }

  /** Create or recover the root session through the runtime's own root entry. */
  async root(): Promise<Agent> {
    const handle = await this.agentRuntime.ensureRoot(SessionId(ROOT), SCOPE)
    return handle.agent
  }

  /** The session's own durable request, the way a person's message gets there (A0 §1.10's origin check reads this). */
  recordRequest(text: string, sessionId: string = ROOT): void {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`the boot holds no live session for "${sessionId}"`)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }

  userSays(text: string, sessionId: string = ROOT): void {
    this.agent(sessionId).followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }

  agent(sessionId: string): Agent {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`the boot holds no live agent for "${sessionId}"`)
    return agent
  }

  /**
   * Write one terminal champion task straight into the store — the record a
   * replay descends from — through the store's own service, so a replay's subject
   * is the historical shape and not a fixture invention.
   */
  async writeChampion(): Promise<string> {
    const taskId = 't-champion'
    const runId = 'r-champion'
    await this.task.createTaskIn(STORE, {
      taskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'champion work',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic' as const, requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT)
    await this.task.admitTaskIn(STORE, taskId, ROOT, { decompositionStatus: 'leaf', manifest: NO_CAPABILITIES })
    await this.task.startRunIn(STORE, {
      runId,
      taskId,
      sessionId: 's-champion',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT)
    await this.task.markRunStatusIn(STORE, taskId, runId, 'verifying', ROOT)
    await this.task.recordEvidenceIn(STORE, {
      evidenceId: `e-${runId}`,
      taskRunId: runId,
      taskId,
      artifacts: [],
      verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, ROOT)
    await this.task.markRunStatusIn(STORE, taskId, runId, 'verified', ROOT)
    return taskId
  }

  /** Adopt the root the store already holds (A2 §E: the barrier that recovers the store). */
  async adopt(): Promise<void> {
    await this.runtime.adoptRoot(STORE, ROOT)
  }

  snapshot(): Promise<TaskSnapshot> {
    return this.task.snapshotIn(STORE)
  }

  runOf(sessionId: string): Promise<TaskRun> {
    return this.runtime.runForSession(sessionId).then(binding => binding.run)
  }

  question(questionId: string): Promise<QuestionRecord | undefined> {
    return this.snapshot().then(snapshot => snapshot.questions?.byId[questionId])
  }

  /** The durable artifact one Session owns: the bytes a second boot would read. */
  artifact(sessionId: string): string {
    const suffix = join(sessionId, 'session.v3.jsonl')
    const found = readdirSync(this.dir, { recursive: true })
      .map(entry => join(this.dir, String(entry)))
      .find(path => path.endsWith(suffix))
    if (found === undefined) throw new Error(`no artifact for session "${sessionId}" under ${this.dir}`)
    return found
  }

  /** The session's stored events, folded from its own artifact bytes. */
  eventsOf(sessionId: string): SessionEvent[] {
    return readFileSync(this.artifact(sessionId), 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as SessionEvent)
  }

  /**
   * How many durable copies one message identity has in a Session's artifact —
   * history entries plus the pending inbox entries the splices still describe.
   * The fold is the test's own, so a module that delivered twice shows up as two.
   */
  copiesOf(sessionId: string, messageId: string): number {
    let copies = 0
    const inbox = { 'next-turn': [] as string[], 'next-step': [] as string[] }
    for (const line of readFileSync(this.artifact(sessionId), 'utf8').split('\n')) {
      if (line === '') continue
      const event = JSON.parse(line) as {
        type?: string
        data?: { id?: string; target?: 'next-turn' | 'next-step'; start?: number; removedCount?: number; inserted?: { id?: string }[] }
      }
      if (event.type === 'user/message' && event.data?.id === messageId) copies += 1
      if (event.type !== 'agent/inbox/spliced' || event.data?.target === undefined) continue
      inbox[event.data.target].splice(event.data.start ?? 0, event.data.removedCount ?? 0, ...(event.data.inserted ?? []).map(message => String(message.id)))
    }
    return copies + [...inbox['next-turn'], ...inbox['next-step']].filter(id => id === messageId).length
  }

  /** The graph records this process holds: what a restart re-reads. */
  commits(): GraphRecords {
    return {
      roots: [...this.graph.roots],
      agents: this.graph.agents.map(agent => ({ ...agent })),
      edges: this.graph.edges.map(edge => ({ ...edge })),
    }
  }

  /**
   * Park the next request one session assembles: the driver's claim has already
   * happened (pending input leaves the inbox before the assembly) and the request
   * never finishes, which is exactly the window a process that dies between the
   * claim and the history entry leaves behind (A4-3's fourth crash point).
   * Returns the latch to release it, and the promise for the claim itself.
   */
  parkAfterClaim(sessionId: string): { claimed: Promise<void>; release: () => void } {
    const gate = Promise.withResolvers<void>()
    const claim = Promise.withResolvers<void>()
    this.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      await gate.promise
      return next()
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (String(agent.id) === sessionId && String(message.id) !== '') claim.resolve()
    })
    return { claimed: claim.promise, release: () => { gate.resolve() } }
  }

  /** Every `user/message` one session's own log holds, as the loop wrote it. */
  messagesOf(sessionId: string): UserMessage[] {
    return this.eventsOf(sessionId).flatMap(event => (event.type === 'user/message' ? [event.data as UserMessage] : []))
  }

  /**
   * Remove the trailing bytes of one session's artifact from its last inbox
   * splice onward: the state a process that died *inside* the delivery's
   * durability barrier leaves — the relay really happened (the live Session held
   * it), the receipt never reached the disk. The spec says at the drop site which
   * bytes it removes and why; nothing else about the artifact is touched.
   */
  loseLastSplice(sessionId: string): void {
    const artifact = this.artifact(sessionId)
    const lines = readFileSync(artifact, 'utf8').split('\n')
    const index = lines.findLastIndex(line => line.includes('"agent/inbox/spliced"'))
    if (index < 0) throw new Error(`session "${sessionId}" has no inbox splice to lose`)
    writeFileSync(artifact, `${lines.slice(0, index).join('\n')}\n`)
  }

  /** Delete one Session's artifact the way a store that lost its log would: the identity exists, the bytes do not. */
  removeSession(sessionId: string): void {
    rmSync(join(this.artifact(sessionId), '..'), { recursive: true, force: true })
  }

  /** Simulate process death: the durability barrier for every live Session, then release every descriptor. */
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
  const dir = mkdtempSync(join(tmpdir(), 'singularity-a4-cold-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * One boot that leaves the addressee parked in a maintenance task: its driver is
 * busy, so a delivered message stays pending in its restored inbox — the state a
 * crash after a confirmed delivery (and before the claim) leaves, and the state
 * the recovery pass has to wake a Session out of.
 */
async function askWhileParentBusy(dir: string): Promise<{ boot: Boot; questionId: string; childSession: string; messageId: string }> {
  const childGo = Promise.withResolvers<void>()
  const boot = await Boot.open(dir, {
    script: (_sessionId, index) => index === 0
      ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }, { text: 'root: waiting' }]
      : [{ waitFor: () => childGo.promise }, { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { hang: true }],
  })
  await boot.begin()
  await vi.waitFor(() => expect(boot.spawns).toHaveLength(1), { timeout: 20_000 })
  const childSession = boot.spawns[0] as string
  const childRun = (await boot.runOf(childSession)).runId
  const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
  // The parent's driver is inside a maintenance task that never finishes, so
  // the relay lands in its inbox and is never claimed: the state a crash after
  // a confirmed delivery leaves.
  void boot.agent(ROOT).runMaintenance(() => new Promise(() => {}))
  childGo.resolve()
  await vi.waitFor(async () => expect((await boot.question(questionId))?.childRunId).toBe(childRun), { timeout: 20_000 })
  return { boot, questionId, childSession, messageId: `m-${questionId}` }
}

describe('a question relayed through a waiting middle across the restart (A4-1, three levels)', () => {
  it('brings the middle and the grandchild back, and carries grandchild → middle → root and back', async () => {
    const dir = workspace()
    const grandchildDown = Promise.withResolvers<void>()
    const grandchildAsked = Promise.withResolvers<void>()
    const recovered = Promise.withResolvers<void>()
    let middleSession = ''
    let grandchildSession = ''
    let middleRun: RunId = '' as RunId
    let grandchildRun: RunId = '' as RunId
    let relayQuestionId = ''
    let grandchildQuestionId = ''

    const middleScript: readonly ScriptEntry[] = [
      { tool: 'task_decompose', args: { reason: 'split my own work', children: children('grandchild work') } },
      { text: 'middle: my batch is the runtime\'s now' },
      { waitFor: () => grandchildAsked.promise },
      { tool: 'task_ask_parent', args: { requestKey: 'k-mid', question: 'my grandchild asks which contract holds: may I decide it?' } },
      { text: 'middle: relayed to my parent' },
    ]
    const first = await Boot.open(dir, {
      script: (_sessionId, index) => {
        if (index === 0) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('middle work') } },
            { text: 'root: the batch is the runtime\'s now' },
          ]
        }
        if (index === 1) return middleScript
        return [
          { waitFor: () => grandchildDown.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k-gc', question: 'which contract applies to me?' } },
          { waitFor: () => Promise.resolve() },
        ]
      },
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(2), { timeout: 20_000 })
    middleSession = first.spawns[0] as string
    grandchildSession = first.spawns[1] as string
    middleRun = (await first.runOf(middleSession)).runId
    grandchildRun = (await first.runOf(grandchildSession)).runId
    relayQuestionId = questionIdOf({ childRunId: middleRun, requestKey: 'k-mid' })
    grandchildQuestionId = questionIdOf({ childRunId: grandchildRun, requestKey: 'k-gc' })

    // The root is not live when the middle relays, and the grandchild's question
    // reaches the *middle* while it is: the relay's intent is durable and its
    // delivery is owed (the first crash point one level up).
    await first.agentRuntime.stopAgents([SessionId(ROOT)])
    grandchildDown.resolve()
    await vi.waitFor(() => expect(first.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === grandchildSession)).toBe(true), { timeout: 20_000 })
    await vi.waitFor(async () => expect((await first.question(grandchildQuestionId))?.parentRunId).toBe(middleRun), { timeout: 20_000 })
    grandchildAsked.resolve()
    await vi.waitFor(async () => expect(await first.question(relayQuestionId)).toBeDefined(), { timeout: 20_000 })
    const relayed = await first.question(relayQuestionId)
    expect(relayed?.parentRunId).toBe((await first.runOf(ROOT)).runId)
    expect(first.copiesOf(ROOT, relayed!.messageId)).toBe(0)
    await first.crash()

    // The second process: both non-root parents are recovered — the grandchild as
    // a blocked asker, the middle as the waiting parent that owns the answer — and
    // the relay the first process could not deliver reaches the root.
    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: (sessionId) => {
        // A second boot spawns nothing: every worker here is a *resumed* session,
        // so the script is keyed by identity — the ids the first boot reported —
        // and an unexpected session is refused rather than answered wrongly.
        if (sessionId === ROOT) {
          return [
            { waitFor: () => recovered.promise },
            { tool: 'task_answer', args: () => ({ questionId: relayQuestionId, requestKey: 'a-root', answer: 'my child decides under the frozen contract', resolves: true }) },
            { text: 'root: answered my child' },
          ]
        }
        if (sessionId === middleSession) {
          return [
            { tool: 'task_answer', args: () => ({ questionId: grandchildQuestionId, requestKey: 'a-mid', answer: 'the frozen contract holds, decided one level up', resolves: true }) },
            { text: 'middle: answered my grandchild' },
          ]
        }
        if (sessionId === grandchildSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'grandchild work delivered' } },
            { text: 'grandchild: submitted' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    await second.adopt()
    expect(second.ctx.agents.get(SessionId(middleSession)), 'the waiting middle is live again').toBeDefined()
    expect(second.ctx.agents.get(SessionId(grandchildSession)), 'the blocked grandchild is live again').toBeDefined()
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(questionMessageText(relayQuestionId, 'my grandchild asks which contract holds: may I decide it?')))).toBe(true),
      { timeout: 20_000 },
    )
    recovered.resolve()

    // Level two: the root answers the middle, the middle's own block clears, and
    // its request carries the answer.
    const rootAnswer = await vi.waitFor(async () => {
      const answer = (await second.snapshot()).questions?.byId[relayQuestionId]?.answers?.[0]
      expect(answer, `an answer to ${relayQuestionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    await vi.waitFor(
      () => expect(second.adapter.textsOf(middleSession).some(text => text.includes(answerMessageText(rootAnswer.answerId, relayQuestionId, 'my child decides under the frozen contract')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(middleSession, rootAnswer.messageId)).toBe(1)

    // Level three: the middle answers its grandchild from a phase whose writes are
    // closed, and the grandchild's next request carries it — then the child
    // submits and both batches settle by their own rules.
    const middleAnswer = await vi.waitFor(async () => {
      const answer = (await second.snapshot()).questions?.byId[grandchildQuestionId]?.answers?.[0]
      expect(answer, `an answer to ${grandchildQuestionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    await vi.waitFor(
      () => expect(second.adapter.textsOf(grandchildSession).some(text => text.includes(answerMessageText(middleAnswer.answerId, grandchildQuestionId, 'the frozen contract holds, decided one level up')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(grandchildSession, middleAnswer.messageId)).toBe(1)
    expect(second.copiesOf(ROOT, relayed!.messageId)).toBe(1)
    // The middle answered from a phase whose writes are closed and stayed there:
    // an answer releases a question, never the parent's write gate (A4 §F.1).
    expect(second.runtime.gate.phaseOf(middleSession)).toBe('waiting_children')

    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      expect(snapshot.runs.find(run => run.runId === grandchildRun)?.status).toBe('verified')
      expect(snapshot.runs.find(run => run.runId === middleRun)?.status).toBe('verified')
      expect(snapshot.runs.find(run => run.sessionId === ROOT)?.status).toBe('verified')
      return snapshot
    }, { timeout: 30_000 })
    // Identity by identity: two questions, two answers, one inbox entry each, and
    // the middle never left `waiting_children` — an answer releases a question,
    // never the parent's write gate (A4 §F.1).
    expect(settled.questions?.all.map(question => question.questionId).sort()).toEqual([relayQuestionId, grandchildQuestionId].sort())
    expect(second.runtime.gate.questionsBlocked(grandchildSession)).toBe(false)
    expect(second.runtime.gate.questionsBlocked(middleSession)).toBe(false)
    expect(settled.runs.filter(run => run.status === 'verified')).toHaveLength(3)
    await second.dispose()
  }, 90_000)
})

describe('cold recovery closes the loop (A4 §F.1)', () => {
  it('recovers the blocked child and its waiting parent, and the answer reaches the child’s own request', async () => {
    const dir = workspace()
    const parentDown = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    // The parent's first request after the restart is woken by the recovered
    // question inside the recovery barrier (A2 §E refuses business calls while a
    // store is recovering), so the script parks it: the case releases the answer
    // once the activation it awaited has completed, which is the order a real
    // deployment reaches the same state in.
    const recovered = Promise.withResolvers<void>()
    let questionId = ''
    let childSession = ''
    let childRun: RunId = '' as RunId

    const first = await Boot.open(dir, {
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
          { text: 'root: the batch is the runtime\'s now' },
        ]
        : [
          { waitFor: () => parentDown.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { waitFor: () => asked.promise },
        ],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The parent is not live when the child asks: the intent is recorded and the
    // delivery is `unavailable` — the first crash point of the exchange, and the
    // state a worker's ask reaches whenever its parent is not running.
    await first.agentRuntime.stopAgents([SessionId(ROOT)])
    parentDown.resolve()
    await vi.waitFor(() => expect(first.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === childSession)).toBe(true), { timeout: 20_000 })
    await vi.waitFor(() => expect(first.question(questionId)).resolves.toBeDefined(), { timeout: 20_000 })
    const recorded = await first.question(questionId)
    expect(recorded?.blocking).toBe(true)
    expect(recorded?.messageId).toBe(`m-${questionId}`)
    expect(first.copiesOf(ROOT, recorded!.messageId)).toBe(0)
    await first.crash()

    // The second process: the root session comes back through the runtime's own
    // root entry, the store is adopted, and the recovery pass brings the blocked
    // child's Session back under the same identity before anything is delivered.
    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: (sessionId, index) => sessionId === ROOT || index === 0
        ? [
          { waitFor: () => recovered.promise },
          { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
          { text: 'root: answered my child, my batch is the runtime\'s' },
        ]
        : [
          { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
          { text: 'child: submitted' },
        ],
    })
    await second.root()
    await second.adopt()
    // The recovery pass brought the blocked child's Session back under its own
    // identity before it delivered anything: same Session, same Run, live here.
    const resumedChild = second.ctx.agents.get(SessionId(childSession))
    expect(resumedChild, 'the recovered child Session is live under the same identity').toBeDefined()
    const recovery = await second.runtime.reconcileStore(STORE)
    // A second activation has nothing to resume: the run is this process's own
    // live work now, so the pass reads it as live rather than as recovery's — the
    // same rule that keeps a spawned worker out of a later pass.
    expect(recovery.questionResumes).toEqual([])
    const held = await second.snapshot()
    const childRunRecord = held.runs.find(run => run.runId === childRun)
    expect(childRunRecord?.status).toBe('running')
    expect(childRunRecord?.sessionId).toBe(childSession)
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(true)
    // The question the first process could not deliver reached the parent exactly
    // once, and the parent's own model request carries it.
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)

    // The parent answers through the shipped tool; the answer reaches the asking
    // child's own request, and the child — the same Session and the same Run —
    // submits the work the block had held back. The answer is released only now:
    // the barrier this case awaited has completed, so the store is admissible.
    await vi.waitFor(() => expect(second.adapter.textsOf(ROOT).length).toBeGreaterThan(0), { timeout: 20_000 })
    recovered.resolve()
    await vi.waitFor(() => expect(second.calls.some(call => call.name === 'task_answer' && call.sessionId === ROOT && call.result !== undefined)).toBe(true), { timeout: 20_000 })
    const answerCall = second.calls.find(call => call.name === 'task_answer' && call.sessionId === ROOT && call.result !== undefined)
    expect(answerCall?.result?.isError).toBe(false)
    expect(answerCall?.result?.text).toContain(`recorded for question ${questionId}`)
    const answered = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      const answer = snapshot.questions?.byId[questionId]?.answers?.[0]
      expect(answer, `an answer to ${questionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    await vi.waitFor(
      () => expect(second.adapter.textsOf(childSession).some(text => text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(false)

    // The child's submission runs through the real chain: verification, the
    // child's terminal state, the batch's own settlement, and the parent's
    // acceptance — no manual cancellation anywhere in the case.
    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      const childReview = snapshot.reviews.find(review => review.runId === childRun)
      expect(snapshot.runs.find(run => run.runId === childRun)?.status, JSON.stringify(childReview ?? null)).toBe('verified')
      expect(snapshot.runs.find(run => run.taskId !== undefined && run.sessionId === ROOT)?.status).toBe('verified')
      return snapshot
    }, { timeout: 30_000 })
    expect(settled.runs).toHaveLength(2)
    expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
    // Each settlement writes its own terminal review; the two land with the
    // statuses the wait above already saw.
    await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      expect(snapshot.reviews.filter(review => review.outcome === 'verified')).toHaveLength(2)
    }, { timeout: 10_000 })
    // One domain effect per identity: one question, one answer, one inbox entry
    // on each side — and the same messageId the first process recorded.
    expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    expect(second.copiesOf(ROOT, recorded!.messageId)).toBe(1)
    expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
    await second.dispose()
  }, 60_000)
})

/**
 * The crash points of one exchange, each driven from a real `QuestionAsked`
 * through the shipped tool and each reopened over the same directory (A4-3).
 * What they share: the intent is always the store's own record, the identity is
 * always `m-<questionId>`, and the pass that runs after the restart is the
 * deployment's recovery entry — never a hand-built intent.
 *
 * Where a killed process's lost write buffer is the difference between two
 * states, the fixture removes those bytes from the artifact and says so at the
 * drop site ({@link Boot.loseLastSplice}); everything else is the deployment's own
 * writing.
 *
 * Which point lives where: **point 1** (the intent is recorded and never
 * delivered) is the opening of the closed-loop case above, where the parent is
 * not live when the child asks and the shipped tool reports `unavailable` with
 * zero copies in the target's artifact; **points 2–4** are the three flush
 * boundaries below, all on the addressee side — the case is a
 * `waiting_children` parent, the answer side is the last case, whose addressee
 * is the `active` child. The two phases are therefore both in the set, and the
 * replay half of A4-3 is its own case below.
 */
describe('the crash points of one exchange, reopened (A4-3)', () => {
  it('(2) redelivers an append that never reached the disk', async () => {
    const dir = workspace()
    const { boot, questionId, messageId, childSession } = await askWhileParentBusy(dir)
    // The delivery confirmed the pending splice and the parent has not read it.
    expect(boot.copiesOf(ROOT, messageId)).toBe(1)
    await boot.crash()
    // A process killed inside its durability barrier loses the bytes it reported:
    // the fixture removes exactly those bytes (the trailing splice) from the
    // artifact, and the target's log holds nothing of this identity.
    boot.loseLastSplice(ROOT)
    expect(boot.copiesOf(ROOT, messageId)).toBe(0)

    const second = await Boot.open(dir, {
      graph: boot.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the recovered question' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    // The recovery barrier's own pass is what delivers it: the identity the first
    // process reported but did not leave behind is owed, and the pass makes it.
    await second.adopt()
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    // …and a second activation has nothing left to deliver: the same identity is
    // present, so no copy is added.
    const reports = await second.runtime.reconcileStore(STORE)
    expect(reports.questionDeliveries.filter(delivery => delivery.messageId === messageId).map(delivery => delivery.status)).toEqual(['already-present'])
    // One domain effect: one durable copy, and the parent's own request carries
    // the words the first process could not leave behind.
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    await second.dispose()
  }, 60_000)

  it('(3) does not insert a second copy of an append that is durable and unclaimed, and wakes the Session that holds it', async () => {
    const dir = workspace()
    const { boot, questionId, messageId, childSession } = await askWhileParentBusy(dir)
    expect(boot.copiesOf(ROOT, messageId)).toBe(1)
    await boot.crash()

    const second = await Boot.open(dir, {
      graph: boot.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the question from my restored inbox' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    const reports = await second.runtime.reconcileStore(STORE)
    expect(reports.questionDeliveries.filter(delivery => delivery.messageId === messageId)).toEqual([
      { subject: `question "${questionId}"`, messageId, status: 'already-present' },
    ])
    // The message survived the restart exactly once — a retry that steered a
    // second copy would show up here as two.
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    // Nothing would have woken the restored Session (a retry of an
    // already-present identity sends no steer), so the runtime's own notice does
    // — and the model's first request carries both the question and that notice.
    const wake = await vi.waitFor(() => {
      const notice = second.messagesOf(ROOT).find(message => message.content.some(block => block.type === 'text' && block.text.includes('coordination input it has not read')))
      expect(notice, 'the runtime wakes the Session that holds an unread delivery').toBeDefined()
      return notice!
    }, { timeout: 20_000 })
    // The wake is the deployment's own voice, never a person's, and it carries no
    // question body: the words stay in the recorded relay.
    expect(wake.source.kind).toBe('plugin')
    const noticeText = wake.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(noticeText).not.toContain('which contract holds?')
    expect(noticeText).toContain(messageId)
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    await second.dispose()
  }, 60_000)

  it('(4) redelivers when the claim left the inbox and the history never took it', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const first = await Boot.open(dir, {
      script: (_sessionId, index) => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }, { text: 'root: waiting' }]
        : [{ waitFor: () => childGo.promise }, { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { hang: true }],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    const messageId = `m-${questionId}`

    // The production driver's claim: pending input leaves the inbox before the
    // request is assembled, and `user/message` is written only after assembly.
    // The parked request is the process dying inside that window.
    const parked = first.parkAfterClaim(ROOT)
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await parked.claimed
    expect(first.copiesOf(ROOT, messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: read the redelivered question' }]
        if (sessionId === childSession) return [{ text: 'child: still waiting' }]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    // The barrier's pass redelivers what the claim never left behind, and a
    // second activation finds it present.
    await second.adopt()
    const reports = await second.runtime.reconcileStore(STORE)
    expect(reports.questionDeliveries.filter(delivery => delivery.messageId === messageId).map(delivery => delivery.status)).toEqual(['already-present'])
    await vi.waitFor(
      () => expect(second.adapter.textsOf(ROOT).some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true),
      { timeout: 20_000 },
    )
    // The redelivered identity is the one that lands, once: the claim the dead
    // process made is not a copy, and the history holds exactly one entry.
    expect(second.copiesOf(ROOT, messageId)).toBe(1)
    expect(second.messagesOf(ROOT).filter(message => message.id === messageId)).toHaveLength(1)
    await second.dispose()
  }, 60_000)

  it('carries an answer across the restart to the child that was offline when it was written', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const answerGo = Promise.withResolvers<void>()
    // The recovered child is woken by the answer *inside* the barrier (A2 §E
    // refuses business calls while a store is recovering), so its turn parks and
    // the case releases it once the activation it awaited is complete — the same
    // order a deployment reaches, where the model reads the refusal and retries.
    const recovered = Promise.withResolvers<void>()
    let childSession = ''
    let childRun: RunId = '' as RunId
    let questionId = ''

    const first = await Boot.open(dir, {
      script: (sessionId, index) => {
        if (index === 0 || sessionId === ROOT) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: 'root: the batch is the runtime\'s now' },
            { waitFor: () => answerGo.promise },
            { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered' },
          ]
        }
        return [
          { waitFor: () => childGo.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { hang: true },
        ]
      },
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The child asks while its parent is live, and is stopped before the parent
    // answers: the answer's intent is durable and its delivery is owed to a
    // Session nobody holds — the answer side of the first crash point.
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.agentRuntime.stopAgents([SessionId(childSession)])
    answerGo.resolve()
    const written = await vi.waitFor(async () => {
      const answer = (await first.question(questionId))?.answers?.[0]
      expect(answer, `an answer to ${questionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    expect(first.copiesOf(childSession, written.messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: my child is answered' }]
        if (sessionId === childSession) return [
          { waitFor: () => recovered.promise },
          { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
          { text: 'child: submitted' },
        ]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    expect(second.copiesOf(childSession, written.messageId)).toBe(1)
    const reports = await second.runtime.reconcileStore(STORE)
    expect(reports.questionDeliveries.filter(delivery => delivery.messageId === written.messageId).map(delivery => delivery.status)).toEqual(['already-present'])
    // The child is the same Session and the same Run, and its next request is the
    // proof it was given the answer the first process could not deliver.
    await vi.waitFor(
      () => expect(second.adapter.textsOf(childSession).some(text => text.includes(answerMessageText(written.answerId, questionId, 'the frozen contract holds')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(childSession, written.messageId)).toBe(1)
    expect(second.runtime.gate.questionsBlocked(childSession)).toBe(false)
    recovered.resolve()
    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      const childReview = snapshot.reviews.find(review => review.runId === childRun)
      const status = snapshot.runs.find(run => run.runId === childRun)?.status
      expect(status, JSON.stringify({
        review: childReview ?? null,
        calls: second.calls.filter(c => c.sessionId === childSession).map(c => ({ name: c.name, err: c.result?.isError, text: c.result?.text?.slice(0, 200) ?? 'in-flight' })),
        block: second.runtime.gate.questionsBlocked(childSession),
        phase: second.runtime.gate.phaseOf(childSession),
      })).toBe('verified')
      expect(snapshot.questions?.byId[questionId]?.answers).toHaveLength(1)
      return snapshot
    }, { timeout: 30_000 })
    expect(settled.runs.find(run => run.sessionId === childSession)?.runId).toBe(childRun)
    await second.dispose()
  }, 60_000)
})

/**
 * The two endings the rework had to make true (A4 §F.1): a wait whose Session
 * cannot be brought back is settled by name rather than left running forever,
 * and a wait that is recovered still runs under the deadline it started with.
 */
describe('what a recovered wait refuses and what ends it (A4 §F.1)', () => {
  it('settles the run by name when its Session cannot be brought back, and revives nothing', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const first = await Boot.open(dir, {
      script: (_sessionId, index) => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }, { text: 'root: waiting' }]
        : [{ waitFor: () => childGo.promise }, { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { hang: true }],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.crash()
    // The store lost the session's bytes: its identity is on the record, the
    // Session that would have to come back is gone.
    first.removeSession(childSession)

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: () => [{ text: 'nothing to do' }],
    })
    await second.root()
    await second.adopt()
    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      const run = snapshot.runs.find(candidate => candidate.runId === childRun)
      expect(run?.status, JSON.stringify(snapshot.reviews.find(review => review.runId === childRun) ?? null)).toBe('failed')
      return snapshot
    }, { timeout: 20_000 })
    const review = settled.reviews.find(candidate => candidate.runId === childRun)
    // The refusal is named: which Session, and which code could not be
    // established — not "recovery failed" and not silence.
    expect(review?.localizedCause).toContain('could not be brought back')
    expect(review?.localizedCause).toContain('session-missing')
    // No dead wait is left behind, and the run's questions stop being open.
    expect(second.ctx.agents.get(SessionId(childSession))).toBeUndefined()
    expect(settled.questions?.byId[questionId]?.answers ?? []).toEqual([])
    // A late answer is refused by the store and cannot revive the run.
    await expect(second.task.answerParentQuestionIn(STORE, {
      questionId,
      parentRunId: (await second.runOf(ROOT)).runId,
      requestKey: 'a1',
      answerDigest: 'a'.repeat(64),
      resolves: true,
      answerRef: { sessionId: ROOT, seq: 0 },
      messageId: `m-a-${questionId}`,
    }, ROOT)).rejects.toThrow(/is not open/)
    expect((await second.snapshot()).runs.find(candidate => candidate.runId === childRun)?.status).toBe('failed')
    await second.dispose()
  }, 60_000)

  it('ends a recovered wait at the deadline it started with, and a late answer does not revive it', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    // The first process's window is long on purpose: the deadline this case is
    // about is the *recovered* process's, computed from the run's own persisted
    // `startedAt` — so the wait the dead process left cannot end it first.
    const first = await Boot.open(dir, {
      budget: { wallTimeMs: 60_000 },
      script: (_sessionId, index) => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }, { text: 'root: waiting' }]
        : [{ waitFor: () => childGo.promise }, { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { hang: true }],
    })
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = first.spawns[0] as string
    const childRun = (await first.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    const startedAt = (await first.runOf(childSession)).startedAt
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.crash()

    // The store is reopened under a budget whose window the run's own `startedAt`
    // has already used up: the recovered wait has nothing left to wait for.
    const second = await Boot.open(dir, {
      graph: first.commits(),
      budget: { wallTimeMs: 1 },
      script: sessionId => sessionId === ROOT
        ? [{ text: 'root: my child is stopped' }]
        : [{ text: 'child: never woken' }],
    })
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(startedAt) + 1), { timeout: 20_000 })
    await second.root()
    await second.adopt()
    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      const run = snapshot.runs.find(candidate => candidate.runId === childRun)
      expect(run?.status, JSON.stringify(snapshot.reviews.find(review => review.runId === childRun) ?? null)).toBe('failed')
      return snapshot
    }, { timeout: 20_000 })
    const review = settled.reviews.find(candidate => candidate.runId === childRun)
    // The existing budget rule, applied to a wait nobody in this process started:
    // a budget stop with the wall time named, never a criteria failure.
    expect(review?.localizedCause).toContain('budget exhausted')
    expect(review?.localizedCause).toContain('wallTimeMs')
    // The question's derived effects lapse with the run, and nothing is owed any
    // more: the message the parent would have written has no address.
    expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
    expect(settled.questions?.byId[questionId]?.answers ?? []).toEqual([])
    expect(await second.runtime.reconcileStore(STORE)).toMatchObject({
      questionDeliveries: [],
    })
    // A late answer is refused by the store and revives nothing.
    await expect(second.task.answerParentQuestionIn(STORE, {
      questionId,
      parentRunId: (await second.runOf(ROOT)).runId,
      requestKey: 'a1',
      answerDigest: 'a'.repeat(64),
      resolves: true,
      answerRef: { sessionId: ROOT, seq: 0 },
      messageId: `m-a-${questionId}`,
    }, ROOT)).rejects.toThrow(/is not open/)
    expect((await second.snapshot()).runs.find(candidate => candidate.runId === childRun)?.status).toBe('failed')
    await second.dispose()
  }, 60_000)
})

/**
 * The replay combination this ticket can honestly cover (A4 §F.1 + A4-3's
 * replay half): a replay worker that really decomposes through the shipped tool,
 * a child of that batch that asks the replay — and a restart in between.
 *
 * What is *not* claimed here, and why: the replay **driver's** own continuation.
 * `runReplayTask` is a call-scoped experiment (it awaits one worker and reports
 * its outcome to the evolution ticket), and the rework's boundary is explicit —
 * a replay tree's cross-restart continuation belongs to A6/S2-R, which owns the
 * experiment's record and budget. What this case proves is the part that *is*
 * this ticket's: the replay run is a waiting parent like any other, so its
 * Session is resumed, the question addressed to it is delivered once, and the
 * answer reaches the child — the batch then settles by the ordinary rules.
 */
describe('a question inside a replay tree across the restart (A4-3, replay half)', () => {
  it('resumes the replay parent and carries its child’s question across the restart', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    // The replay is woken by the recovered question inside the barrier, so its
    // answer waits for the activation this case awaits (A2 §E refuses business
    // calls while a store is recovering).
    const recovered = Promise.withResolvers<void>()
    let replaySession = ''
    let childSession = ''
    let replayRun: RunId = '' as RunId
    let replayTaskId = ''
    let childRun: RunId = '' as RunId

    const first = await Boot.open(dir, {
      script: (_sessionId, index) => {
        if (index === 0) return [{ text: 'root: the replay is the runtime\'s' }]
        if (index === 1) {
          // The replay's own worker: it decomposes for real, which is what makes
          // the replay session a waiting parent with a batch of its own.
          return [
            { tool: 'task_decompose', args: { reason: 'split the replayed work', children: children('replay child work') } },
            { text: 'replay: the batch is the runtime\'s now' },
          ]
        }
        return [
          { waitFor: () => childGo.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract applies to me?' } },
          { hang: true },
        ]
      },
    })
    await first.begin()
    const champion = await first.writeChampion()
    const replaying = first.runtime.replayTask(STORE, champion, { lineage: 'evolution-replay:p1' }, ROOT)
    replaying.catch(() => undefined)
    await vi.waitFor(() => expect(first.spawns.length).toBeGreaterThanOrEqual(1), { timeout: 20_000 })
    replaySession = first.spawns[0] as string
    replayRun = (await first.runOf(replaySession)).runId
    replayTaskId = (await first.runOf(replaySession)).taskId
    // The replay's worker really decomposed: a child run exists under the replay
    // task, and it is the run the question will be asked from.
    await vi.waitFor(() => expect(first.spawns.length).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    childSession = first.spawns[1] as string
    childRun = (await first.runOf(childSession)).runId
    await vi.waitFor(async () => expect((await first.runOf(replaySession)).executionPhase).toBe('waiting_children'), { timeout: 20_000 })
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })

    // The replay worker is not live when its child asks (the parentless-replay
    // rule does not apply here: the *child's* parent is the replay task, and its
    // question is legal) — so the intent is recorded and the delivery is owed.
    await first.agentRuntime.stopAgents([SessionId(replaySession)])
    childGo.resolve()
    await vi.waitFor(() => expect(first.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === childSession && call.result !== undefined)).toBe(true), { timeout: 20_000 })
    const recorded = await vi.waitFor(async () => {
      const question = await first.question(questionId)
      expect(question).toBeDefined()
      return question!
    }, { timeout: 20_000 })
    expect(recorded.parentRunId).toBe(replayRun)
    expect(first.copiesOf(replaySession, recorded.messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: nothing but the replayed tree' }]
        if (sessionId === replaySession) return [
          { waitFor: () => recovered.promise },
          { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the champion contract holds, decided by the replay', resolves: true }) },
          { text: 'replay: answered my child' },
        ]
        if (sessionId === childSession) return [
          { tool: 'task_submit_result', args: { summary: 'replay child work delivered' } },
          { text: 'child: submitted' },
        ]
        throw new Error(`unexpected session ${sessionId}`)
      },
    })
    await second.root()
    await second.adopt()
    // The replay run is a waiting parent that participates in the question: its
    // Session comes back under its own identity, and so does the child's.
    expect(second.ctx.agents.get(SessionId(replaySession)), 'the replay parent is live again').toBeDefined()
    expect(second.ctx.agents.get(SessionId(childSession)), 'the asking child is live again').toBeDefined()
    await vi.waitFor(
      () => expect(second.adapter.textsOf(replaySession).some(text => text.includes(questionMessageText(questionId, 'which contract applies to me?')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(replaySession, recorded.messageId)).toBe(1)
    recovered.resolve()

    const answered = await vi.waitFor(async () => {
      const answer = (await second.snapshot()).questions?.byId[questionId]?.answers?.[0]
      expect(answer, `an answer to ${questionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    await vi.waitFor(
      () => expect(second.adapter.textsOf(childSession).some(text => text.includes(answerMessageText(answered.answerId, questionId, 'the champion contract holds, decided by the replay')))).toBe(true),
      { timeout: 20_000 },
    )
    expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
    // The replayed tree settles by the ordinary rules: the child's submission,
    // the replay's batch, and the replay run's own acceptance. The durable
    // experiment identity this case can read back is the replayed task's own
    // contract — its objective carries the lineage tag — while the review
    // record's anomaly is written by whichever process owns the settlement
    // (the in-memory lineage map does not survive the restart, and the replay
    // experiment's own record is A6/S2-R's subject, not this ticket's).
    const settled = await vi.waitFor(async () => {
      const snapshot = await second.snapshot()
      expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
      expect(snapshot.runs.find(run => run.runId === replayRun)?.status).toBe('verified')
      expect(snapshot.reviews.find(review => review.runId === replayRun)?.outcome).toBe('verified')
      return snapshot
    }, { timeout: 30_000 })
    // The question's own Task relation is what made the exchange legal: the
    // replay's child asks the *replay task*, which is its direct parent (a
    // parentless replay's own ask would have been refused by name).
    const replayChild = await second.snapshot().then(snapshot => snapshot.tasks.find(task => task.taskId === (settled.runs.find(run => run.runId === childRun)?.taskId ?? '')))
    expect(replayChild?.parentTaskId).toBe(replayTaskId)
    expect(settled.tasks.find(task => task.taskId === replayTaskId)?.objective).toContain('[evolution-replay:p1]')
    expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
    expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    await second.dispose()
  }, 90_000)
})

/**
 * The wake order a recovered store owes (A2 §E + A4 §F.1). Every case here
 * scripts the woken Session's **first** request as the business call its wake is
 * about — no `waitFor` in the model's script, nothing waits for the barrier on
 * the Session's behalf — so the exchange either completes from that wake or
 * fails where the recovery door refuses it.
 *
 * The interleaving is not left to a race. Each case holds the barrier's own
 * store read (the one the completion takes after its pass returned), so the
 * window between "the pass ran" and "the store is ready" is provably open while
 * the case looks at what reached the model: the read runs for real and carries
 * its own value, only its return is held — the lever `cancellation-gate.spec.ts`
 * already uses on this barrier. A delivery made inside that window wakes a model
 * whose first call the door refuses with nothing to wake it again; a delivery
 * held until the ready handle does the waking is answered by that first call.
 */
describe('a recovery wake waits for the ready handle (A4 §F.1)', () => {
  /**
   * Hold the barrier's first store read after its pass returned — the read the
   * completion takes at the barrier's own tail — so a case can look at what the
   * pass woke while the store is provably not ready yet.
   */
  function holdBarrierAfterPass(boot: Boot): { entered: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let armed = false
    const reconcile = boot.runtime.reconcileStore.bind(boot.runtime)
    const read = boot.task.snapshotIn.bind(boot.task)
    vi.spyOn(boot.runtime, 'reconcileStore').mockImplementation(async (...args: Parameters<TaskRuntime['reconcileStore']>) => {
      const report = await reconcile(...args)
      armed = true
      return report
    })
    vi.spyOn(boot.task, 'snapshotIn').mockImplementation(async (...args: Parameters<TaskService['snapshotIn']>) => {
      const snapshot = await read(...args)
      if (armed && args[0] === STORE) {
        armed = false
        entered.resolve()
        await release.promise
      }
      return snapshot
    })
    return { entered: entered.promise, release: () => { release.resolve() } }
  }

  /**
   * Refuse every store read the completion takes after its pass returned — the
   * door a half-recovered store must fail at, and the reads its own bookkeeping
   * swallows included, so the completion's own read cannot escape the fault.
   */
  function failBarrierAfterPass(boot: Boot, message: string): void {
    let armed = false
    const reconcile = boot.runtime.reconcileStore.bind(boot.runtime)
    const read = boot.task.snapshotIn.bind(boot.task)
    vi.spyOn(boot.runtime, 'reconcileStore').mockImplementation(async (...args: Parameters<TaskRuntime['reconcileStore']>) => {
      const report = await reconcile(...args)
      armed = true
      return report
    })
    vi.spyOn(boot.task, 'snapshotIn').mockImplementation(async (...args: Parameters<TaskService['snapshotIn']>) => {
      if (armed && args[0] === STORE) throw new Error(message)
      return await read(...args)
    })
  }

  /**
   * Whether one Session's next request is served within the window — a bounded
   * look at the adapter, never a waiter inside the model's script.
   */
  async function wokenWithin(boot: Boot, sessionId: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (boot.adapter.requestsOf(sessionId).length > 0) return true
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return false
  }

  /** The first dispatched call one Session made under one name, once its result is in. */
  async function firstCall(boot: Boot, sessionId: string, name: string): Promise<DispatchedCall> {
    return await vi.waitFor(() => {
      const call = boot.calls.find(candidate => candidate.name === name && candidate.sessionId === sessionId && candidate.result !== undefined)
      expect(call, `${name} from "${sessionId}"; dispatched: ${JSON.stringify(boot.calls.map(candidate => ({ name: candidate.name, session: candidate.sessionId, error: candidate.result?.isError ?? null })))}`).toBeDefined()
      return call!
    }, { timeout: 20_000 })
  }

  /** One boot driven to the first crash point: the child asked while its parent was not live, so the intent is durable and its delivery owed. */
  async function askWhileParentGone(dir: string): Promise<{ boot: Boot; childSession: string; childRun: RunId; questionId: string; messageId: string }> {
    const childGo = Promise.withResolvers<void>()
    const boot = await Boot.open(dir, {
      script: (_sessionId, index) => index === 0
        ? [{ tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } }, { text: 'root: the batch is the runtime\'s now' }]
        : [{ waitFor: () => childGo.promise }, { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { hang: true }],
    })
    await boot.begin()
    await vi.waitFor(() => expect(boot.spawns).toHaveLength(1), { timeout: 20_000 })
    const childSession = boot.spawns[0] as string
    const childRun = (await boot.runOf(childSession)).runId
    const questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    await boot.agentRuntime.stopAgents([SessionId(ROOT)])
    childGo.resolve()
    await vi.waitFor(() => expect(boot.calls.some(call => call.name === 'task_ask_parent' && call.sessionId === childSession && call.result !== undefined)).toBe(true), { timeout: 20_000 })
    await vi.waitFor(async () => expect(await boot.question(questionId)).toBeDefined(), { timeout: 20_000 })
    return { boot, childSession, childRun, questionId, messageId: `m-${questionId}` }
  }

  it('delivers the recovered question only once its store is ready, and the woken parent answers with its first call', async () => {
    const dir = workspace()
    const { boot: first, childSession, childRun, questionId, messageId } = await askWhileParentGone(dir)
    expect(first.copiesOf(ROOT, messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered my child' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, my batch may settle' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      await adopting
      // The parent's first request is the one the delivery opened, and it answers
      // through the shipped tool: nothing is refused and the model retries nothing.
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(answerCall.result!.text).toContain(`recorded for question ${questionId}`)
      expect(woken, 'the recovery delivery woke the parent before its store was ready').toBe(false)
      // The wake carried the question itself, and it is durable exactly once.
      expect(second.adapter.requestsOf(ROOT)[0]?.texts.some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true)
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
      // The answer reaches the asking child's own request; the child submits and
      // the batch settles under the identities the first process bound.
      const answered = await vi.waitFor(async () => {
        const answer = (await second.snapshot()).questions?.byId[questionId]?.answers?.[0]
        expect(answer, `an answer to ${questionId}`).toBeDefined()
        return answer!
      }, { timeout: 20_000 })
      await vi.waitFor(
        () => expect(second.adapter.textsOf(childSession).some(text => text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds')))).toBe(true),
        { timeout: 20_000 },
      )
      expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
      const settled = await vi.waitFor(async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.sessionId === ROOT)?.status).toBe('verified')
        return snapshot
      }, { timeout: 30_000 })
      expect(settled.questions?.all.map(question => question.questionId)).toEqual([questionId])
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('wakes a durable unread delivery only once its store is ready, and the first call acts on it', async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentBusy(dir)
    const childRun = (await first.runOf(childSession)).runId
    expect(first.copiesOf(ROOT, messageId)).toBe(1)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered the question I was woken for' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, my batch may settle' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      await adopting
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(answerCall.result!.text).toContain(`recorded for question ${questionId}`)
      expect(woken, 'the recovery notice woke the parent before its store was ready').toBe(false)
      // The retry of an already-present identity steered no second copy: the inbox
      // keeps the one the first process left, and the request that acts on it
      // carries both it and the runtime's own notice.
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
      expect(second.adapter.requestsOf(ROOT)[0]?.texts.some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(true)
      // The child's next request carries the answer the parent's first call wrote,
      // and the child submits the work the question held back.
      const answered = await vi.waitFor(async () => {
        const answer = (await second.snapshot()).questions?.byId[questionId]?.answers?.[0]
        expect(answer, `an answer to ${questionId}`).toBeDefined()
        return answer!
      }, { timeout: 20_000 })
      await vi.waitFor(
        () => expect(second.adapter.textsOf(childSession).some(text => text.includes(answerMessageText(answered.answerId, questionId, 'the frozen contract holds')))).toBe(true),
        { timeout: 20_000 },
      )
      expect(second.copiesOf(childSession, answered.messageId)).toBe(1)
      const settled = await vi.waitFor(async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.sessionId === ROOT)?.status).toBe('verified')
        return snapshot
      }, { timeout: 30_000 })
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('carries a recovered answer to the child, whose first call submits the work the wait held back', async () => {
    const dir = workspace()
    const childGo = Promise.withResolvers<void>()
    const answerGo = Promise.withResolvers<void>()
    let questionId = ''
    const first = await Boot.open(dir, {
      script: (sessionId, index) => {
        if (index === 0 || sessionId === ROOT) {
          return [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: 'root: the batch is the runtime\'s now' },
            { waitFor: () => answerGo.promise },
            { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered' },
          ]
        }
        return [
          { waitFor: () => childGo.promise },
          { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
          { hang: true },
        ]
      },
    })
    let childSession = ''
    let childRun: RunId = '' as RunId
    await first.begin()
    await vi.waitFor(() => expect(first.spawns).toHaveLength(1), { timeout: 20_000 })
    childSession = first.spawns[0] as string
    childRun = (await first.runOf(childSession)).runId
    questionId = questionIdOf({ childRunId: childRun, requestKey: 'k1' })
    // The child asks while its parent is live, and is stopped before the answer is
    // written: the answer's delivery is owed to a Session nobody holds.
    childGo.resolve()
    await vi.waitFor(async () => expect((await first.question(questionId))?.blocking).toBe(true), { timeout: 20_000 })
    await first.agentRuntime.stopAgents([SessionId(childSession)])
    answerGo.resolve()
    const written = await vi.waitFor(async () => {
      const answer = (await first.question(questionId))?.answers?.[0]
      expect(answer, `an answer to ${questionId}`).toBeDefined()
      return answer!
    }, { timeout: 20_000 })
    expect(first.copiesOf(childSession, written.messageId)).toBe(0)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: my child has what it waited for' }]
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted, nothing left to wait for' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, childSession, 1_500)
      hold.release()
      await adopting
      const submitCall = await firstCall(second, childSession, 'task_submit_result')
      expect(submitCall.result!.isError, submitCall.result!.text).toBe(false)
      expect(woken, 'the recovered answer woke the child before its store was ready').toBe(false)
      expect(second.adapter.requestsOf(childSession)[0]?.texts.some(text => text.includes(answerMessageText(written.answerId, questionId, 'the frozen contract holds')))).toBe(true)
      expect(second.copiesOf(childSession, written.messageId)).toBe(1)
      const settled = await vi.waitFor(async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.runs.find(run => run.runId === childRun)?.status).toBe('verified')
        expect(snapshot.runs.find(run => run.sessionId === ROOT)?.status).toBe('verified')
        return snapshot
      }, { timeout: 30_000 })
      expect(settled.questions?.byId[questionId]?.answers).toHaveLength(1)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('drops the wake when the barrier fails: no request, no write, and the next activation delivers', async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentGone(dir)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) {
          return [
            { tool: 'task_answer', args: () => ({ questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true }) },
            { text: 'root: answered my child' },
          ]
        }
        if (sessionId === childSession) {
          return [
            { tool: 'task_submit_result', args: { summary: 'child work delivered' } },
            { text: 'child: submitted' },
          ]
        }
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    failBarrierAfterPass(second, 'the store could not be read to initialize its sessions\' gates after recovery (injected)')
    try {
      await expect(second.adopt()).rejects.toThrow('injected')
      // The failed barrier woke nothing and delivered nothing: the question is
      // still the record's own intent, with no turn started from it.
      expect(second.copiesOf(ROOT, messageId)).toBe(0)
      expect(second.adapter.requestsOf(ROOT)).toHaveLength(0)
      vi.restoreAllMocks()
      await expect(second.question(questionId)).resolves.toBeDefined()
      // The next explicit activation is the retry: it delivers, and the parent's
      // first request answers through the shipped tool.
      await second.adopt()
      const answerCall = await firstCall(second, ROOT, 'task_answer')
      expect(answerCall.result!.isError, answerCall.result!.text).toBe(false)
      expect(second.copiesOf(ROOT, messageId)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('drops the wake when the barrier is cancelled: no request, no write, and the question stays the record\'s', async () => {
    const dir = workspace()
    const { boot: first, childSession, questionId, messageId } = await askWhileParentGone(dir)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      script: sessionId => {
        if (sessionId === ROOT) return [{ text: 'root: nothing to answer here' }]
        if (sessionId === childSession) return [{ text: 'child: waiting, nothing to do' }]
        throw new Error(`the second boot served an unexpected session "${sessionId}"`)
      },
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      await second.runtime.cancelGraph(STORE, 'the graph was removed')
      hold.release()
      await adopting.catch(() => undefined)
      // The cancelled barrier neither delivered the question nor wrote an answer,
      // and the question's own record is untouched for the next reader.
      expect(second.copiesOf(ROOT, messageId)).toBe(0)
      expect(second.adapter.requestsOf(ROOT).flatMap(request => request.texts).some(text => text.includes(questionMessageText(questionId, 'which contract holds?')))).toBe(false)
      const held = await second.snapshot()
      expect(held.questions?.byId[questionId]?.messageId).toBe(messageId)
      expect(held.questions?.byId[questionId]?.answers ?? []).toEqual([])
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)

  it('holds the activation notice for the ready handle too: the root the recovery activated decomposes on its first call', async () => {
    const dir = workspace()
    // The contract is intaken under a review policy, so it stays a proposal; the
    // decision is written through the store's own entry and the process dies
    // before any continuation ran.
    const first = await Boot.open(dir, {
      script: () => [{ text: 'root: nothing before the restart' }],
      generatedTaskReview: 'all',
    })
    await first.root()
    const submitted = await first.runtime.intakeRootContract(STORE, ROOT, ROOT_CONTRACT)
    if (submitted.status !== 'pending_review') throw new Error(`the contract was not left waiting: ${submitted.status}`)
    const stored = (await first.snapshot()).proposals?.byId[submitted.proposalId]
    if (stored === undefined || stored.kind !== 'root') throw new Error('the store lost the root contract proposal')
    await first.task.decideProposalIn(STORE, {
      proposalId: stored.proposalId,
      outcome: 'approved',
      proposalDigest: stored.proposalDigest,
      admissionContextDigest: stored.admissionContextDigest,
      reviewContextDigest: stored.reviewContextDigest,
      decidedBy: `approval:${ROOT}`,
      decidedAt: new Date().toISOString(),
    }, `approval:${ROOT}`)
    await first.crash()

    const second = await Boot.open(dir, {
      graph: first.commits(),
      generatedTaskReview: 'all',
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
          { text: 'root: the batch is the runtime\'s' },
        ]
        : [{ text: 'child: nothing to deliver' }],
    })
    await second.root()
    const hold = holdBarrierAfterPass(second)
    const adopting = second.adopt()
    try {
      await hold.entered
      const woken = await wokenWithin(second, ROOT, 1_500)
      hold.release()
      // The adoption activated the root itself (no other entry ran here), and the
      // notice it owes the session is a wake: it waits for the same ready handle
      // the recovered deliveries do.
      await adopting
      const decompose = await firstCall(second, ROOT, 'task_decompose')
      expect(decompose.result!.isError, decompose.result!.text).toBe(false)
      expect(woken, 'the activation notice woke the root before its store was ready').toBe(false)
      const activated = await vi.waitFor(async () => {
        const snapshot = await second.snapshot()
        expect(snapshot.tasks).toHaveLength(1)
        expect(snapshot.runs).toHaveLength(1)
        return snapshot
      }, { timeout: 20_000 })
      expect(activated.tasks[0]?.objective).toBe(ROOT_CONTRACT.objective)
      expect(activated.runs[0]?.sessionId).toBe(ROOT)
    } finally {
      hold.release()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
      await second.dispose()
    }
  }, 90_000)
})
