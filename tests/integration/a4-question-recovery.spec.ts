import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '../../../../thirdparty/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import LlmRuntime, { LlmAdapter } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { boundContextSummary, createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { toolCallResponse, textResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { blockingQuestionsOf, rootTaskStoreId } from '../../task/src/index.ts'
import { TaskService } from '../../task/src/index.ts'
import type { RunProviderBinding, TaskEvent, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import type { Config } from '../../task-runtime/src/index.ts'
import { graphRegistry } from '../support/context-plane.ts'

/**
 * A4 recovery acceptance on a real restart (plan §F.1): a deployment whose store
 * and sessions live in the real JSONL log is booted, driven to a crash point,
 * abandoned, and booted again over the same directory.
 *
 * What is real: `session-persistence-jsonl` and the bytes it writes (the store
 * the second boot reads is the first boot's artifact), the real `SessionStore`
 * and agent loop, the real `SessionQueryEngine` (the read path the delivery and
 * the citations go through), the real `TaskService` and `TaskRuntime` with their
 * drivers, the real `AgentRuntime` delivery path, and the real verifier. What is
 * scripted is the model: one adapter answers each request from a per-session
 * script, so a `tool/call` exists because a model made it.
 *
 * Three facts only a restart can show, and the reason this spec exists:
 *
 * - a run whose unresolved blocking question is on the record is **not** an
 *   abandoned in-flight run: recovery leaves it (same session, same run), while
 *   a run without such a question is still settled cancelled;
 * - the write gate is rebuilt from the durable question facts, not from the dead
 *   process's memory;
 * - the delivery the first process could not make (its target was not live) is
 *   made **once** by the recovery pass that brings the target back.
 *
 * The two recovery entries the ticket names are both exercised: `reconcileStore`
 * (the index.ts site, a run nobody drives) and the batch driver's adoption
 * branch (the orchestrate.ts site, a child a resumed batch finds in flight).
 */

const PROVIDER = 'fake'
const MODEL = 'fake-1'
const ROOT = 's-root'
const CHILD = 's-child'
const MIDDLE = 's-middle'
const GRANDCHILD = 's-grandchild'
const STORE = rootTaskStoreId(ROOT)
const ACTOR = 'tester'

/** The criterion every task in this spec carries: a command the real verifier can settle. */
const CRITERIA = [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic' as const, requiredEvidence: [], mandatory: true, command: 'true' }]

/** One scripted model answer: a tool call, a final text, or a latch the spec releases. */
type ScriptEntry =
  | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly text: string }
  | { readonly waitFor: () => Promise<void> }

/** One request the adapter served, with the texts the loop would have sent. */
interface ServedRequest {
  readonly options: GenerateOptions
  readonly texts: readonly string[]
}

/** One tool call the deployment dispatched (the fixture's own record of what the model asked for). */
interface DispatchedCall {
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

/** One script per session, consumed one request at a time — the model, and nothing else, is scripted. */
class ScriptedAdapter extends LlmAdapter {
  private readonly queues = new Map<string, ScriptEntry[]>()
  private readonly requests = new Map<string, ServedRequest[]>()
  private callSeq = 0

  constructor(private readonly script: (sessionId: string) => readonly ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  requestsOf(sessionId: string): readonly ServedRequest[] {
    return this.requests.get(sessionId) ?? []
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queues.get(sessionId) ?? [...this.script(sessionId)]
    this.queues.set(sessionId, queue)
    const served = this.requests.get(sessionId) ?? []
    served.push({ options, texts: options.messages.flatMap(message => message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))) })
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
    if ('text' in entry) {
      yield* textResponse(entry.text)
      return
    }
    this.callSeq += 1
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...entry.args })
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

/** The engine's two search faces are not this fixture's subject; every exact read is the shipped implementation. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not part of this fixture'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not part of this fixture'))
  }
}

/** One boot of the deployment over one directory; a second boot over the same directory is the restart. */
class Boot {
  private constructor(
    readonly dir: string,
    readonly ctx: Context,
    readonly task: TaskService,
    readonly runtime: TaskRuntime,
    readonly adapter: ScriptedAdapter,
    private readonly handles: { close: () => Promise<void> }[],
    private readonly createAgent: (sessionId: string, options: { provider: string; model: string }) => Promise<Agent>,
  ) {}

  static async open(dir: string, script: (sessionId: string) => readonly ScriptEntry[]): Promise<Boot> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
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
    const adapter = new ScriptedAdapter(script)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(TestSessionQuery)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: () => {}, resolve: () => ({}) })
    ctx.provide('layout', { setIn: async () => {} })
    ctx.provide('graph', {
      snapshotIn: async () => ({ version: 1, id: 'g', roots: [ROOT], agents: [], groups: [], edges: [] }),
      commitIn: async () => {},
      setStatusIn: async () => {},
      addAgentIn: async () => {},
    })
    ctx.provide('graphs', graphRegistry({
      graphForSession: async () => ({
        id: 'g',
        name: 'graph',
        envId: 'env1',
        rootSessionId: ROOT,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
    }) as never)
    // The tools this deployment offers: the two question tools stand in for the
    // shipped adapters (A4 ③c owns those), and the fixture deliberately does not
    // restrict any session's surface — so a scripted call reaches the waterfall
    // and leaves the `tool/call` event a spec cites the runtime entry with.
    for (const name of ['task_ask_parent', 'task_answer']) {
      ctx.tools.register({
        name,
        description: `tool ${name}`,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }] },
        execute: async () => `${name}: fixture answer`,
      })
    }
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'task_ask_parent' || exec.name === 'task_answer') {
        calls.push({ sessionId: String(exec.agent?.id ?? ''), callId: String(exec.callId), name: exec.name, args: exec.arguments })
      }
      return next()
    })
    new AgentRuntime(ctx)
    const task = new TaskService(ctx)
    await ctx.plugin(VerifierRegistry, { evidenceRoot: join(dir, 'evidence') })
    await ctx.plugin(TaskRuntime, {
      capabilities: {},
      runBindingRoot: join(dir, 'run-bindings'),
    } as Config)
    const runtime = ctx.get('taskRuntime') as TaskRuntime
    return new Boot(dir, ctx, task, runtime, adapter, handles, (sessionId, options) => harness.create(SessionId(sessionId), options))
  }

  /** Create one live Session the way a spawn does, and materialize its artifact. */
  async create(sessionId: string): Promise<Agent> {
    const agent = await this.createAgent(sessionId, { provider: PROVIDER, model: MODEL })
    await this.ctx.sessions.flush(agent.session)
    return agent
  }

  /**
   * Give one live Session its first input, the way a spawn's kickoff does. A
   * created Session has no turn of its own until something is addressed to it,
   * and this fixture's scripted model answers per request — so the request has to
   * be made, and it is made the way the deployment makes it (a plugin-sourced
   * message, never a person's).
   */
  begin(agent: Agent, text: string): void {
    agent.followup(createUserMessage({
      content: [{ type: 'text' as const, text }],
      source: { kind: 'plugin', plugin: 'fixture', form: 'notice', summary: boundContextSummary(text) },
    }))
  }

  /** Bring one persisted Session back live — what a recovery pass does before it retries a delivery. */
  async resume(sessionId: string): Promise<Agent> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    return handle.agent
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

  /** Simulate process death: the durability barrier for every live Session, then release every descriptor. */
  async crash(): Promise<void> {
    for (const session of this.ctx.sessions.list()) await this.ctx.sessions.flush(session)
    for (const handle of this.handles.splice(0)) await handle.close()
  }

  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
  }

  snapshot(): Promise<TaskSnapshot> {
    return this.task.snapshotIn(STORE)
  }

  /** One session's durable events, folded from its own artifact bytes. */
  eventsOf(sessionId: string): TaskEvent[] {
    return readFileSync(this.artifact(sessionId), 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .flatMap(line => {
        const event = JSON.parse(line) as { type?: string; data?: unknown }
        return event.type === 'task/event' ? [event.data as TaskEvent] : []
      })
  }

  /** How many durable copies one message identity has in a Session's artifact — history plus pending inbox. */
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
}

/** Every question tool call this process dispatched, in order. */
const calls: DispatchedCall[] = []

const directories: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-a4-recovery-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  // The dispatch log is this process's, and a session id ("s-child") is the same
  // string in every case: without this, a later case would read an earlier
  // boot's call id as its own.
  calls.length = 0
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The task record one boot seeds: a root task with a run, and one child with a run of its own. */
async function seedParentChild(boot: Boot, options: { parentWaitingChildren?: boolean } = {}): Promise<{ parentRun: TaskRun; childRun: TaskRun }> {
  await boot.task.createStore(STORE)
  await boot.task.createTaskIn(STORE, {
    taskId: 't-root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria: CRITERIA,
    requestedCapabilities: [],
    decompositionStatus: options.parentWaitingChildren === true ? 'decomposed' : 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ACTOR)
  await boot.task.admitTaskIn(STORE, 't-root', ACTOR, { decompositionStatus: options.parentWaitingChildren === true ? 'decomposed' : 'leaf' })
  await boot.task.startRunIn(STORE, {
    runId: 'r-root',
    taskId: 't-root',
    sessionId: ROOT,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ACTOR)
  if (options.parentWaitingChildren === true) {
    await boot.task.changeRunPhaseIn(STORE, 't-root', 'r-root', ACTOR, { phase: 'waiting_children', batchId: 'b-t-root' })
  }
  await boot.task.createTaskIn(STORE, {
    taskId: 't-child',
    definitionRef: { taskType: 'root', version: 1 },
    parentTaskId: 't-root',
    objective: 'child work',
    depth: 1,
    acceptanceCriteria: CRITERIA,
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ACTOR)
  await boot.task.admitTaskIn(STORE, 't-child', ACTOR, { decompositionStatus: 'leaf' })
  await boot.task.startRunIn(STORE, {
    runId: 'r-child',
    taskId: 't-child',
    sessionId: CHILD,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ACTOR)
  return {
    parentRun: await boot.task.runIn(STORE, 'r-root'),
    childRun: await boot.task.runIn(STORE, 'r-child'),
  }
}

/**
 * The task record a parent's own acceptance needs: a root, a **middle** task whose
 * run is `waiting_children` with a batch, one grandchild of that batch already
 * terminal, and a question the middle's run asked the root's run. Every write
 * goes through the store's own service — the shape a live tree reaches anyway —
 * so what the case asserts is the runtime's rule, not a fixture's invention.
 */
async function seedMiddleTree(boot: Boot): Promise<void> {
  await boot.task.createStore(STORE)
  await boot.task.createTaskIn(STORE, {
    taskId: 't-root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria: CRITERIA,
    requestedCapabilities: [],
    decompositionStatus: 'decomposed',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ACTOR)
  await boot.task.admitTaskIn(STORE, 't-root', ACTOR, { decompositionStatus: 'decomposed' })
  await boot.task.startRunIn(STORE, {
    runId: 'r-root',
    taskId: 't-root',
    sessionId: ROOT,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ACTOR)
  await boot.task.createTaskIn(STORE, {
    taskId: 't-middle',
    definitionRef: { taskType: 'root', version: 1 },
    parentTaskId: 't-root',
    objective: 'middle work',
    depth: 1,
    acceptanceCriteria: CRITERIA,
    requestedCapabilities: [],
    decompositionStatus: 'decomposed',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ACTOR)
  await boot.task.admitTaskIn(STORE, 't-middle', ACTOR, { decompositionStatus: 'decomposed' })
  await boot.task.startRunIn(STORE, {
    runId: 'r-middle',
    taskId: 't-middle',
    sessionId: MIDDLE,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ACTOR)
  await boot.task.changeRunPhaseIn(STORE, 't-middle', 'r-middle', ACTOR, { phase: 'waiting_children', batchId: 'b-t-middle' })
  await boot.task.createTaskIn(STORE, {
    taskId: 't-grand',
    definitionRef: { taskType: 'root', version: 1 },
    parentTaskId: 't-middle',
    objective: 'grandchild work',
    depth: 2,
    acceptanceCriteria: CRITERIA,
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ACTOR)
  await boot.task.admitTaskIn(STORE, 't-grand', ACTOR, { decompositionStatus: 'leaf' })
  await boot.task.startRunIn(STORE, {
    runId: 'r-grand',
    taskId: 't-grand',
    sessionId: GRANDCHILD,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    executionPhase: 'active',
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ACTOR)
  // The batch's only child is terminal: nothing but the middle's own coordination
  // stands between the batch's settlement and the middle's acceptance.
  await boot.task.markRunStatusIn(STORE, 't-grand', 'r-grand', 'cancelled', ACTOR, { reason: 'fixture: the child of the batch is already terminal' })
}

describe("the parent's own acceptance (A4 §F.1)", () => {
  it('holds a settled batch back while the parent waits on its own answer, and submits it once that answer closes the last item', async () => {
    const dir = workspace()
    const answerNow = Promise.withResolvers<void>()
    let questionId = ''
    const a = await Boot.open(dir, sessionId => sessionId === MIDDLE
      ? [{ tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'does the frozen contract still hold?' } }, { waitFor: () => answerNow.promise }]
      : [{ waitFor: () => answerNow.promise }, { tool: 'task_answer', args: { questionId, requestKey: 'a1', answer: 'it holds', resolves: true } }])
    await seedMiddleTree(a)
    const middle = await a.create(MIDDLE)
    a.begin(middle, 'the middle begins')
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_ask_parent' && call.sessionId === MIDDLE)).toBe(true))
    const askCall = calls.find(call => call.name === 'task_ask_parent' && call.sessionId === MIDDLE) as DispatchedCall
    const asked = await a.runtime.askParentQuestion(MIDDLE, { callId: askCall.callId, requestKey: 'k1', blocking: true })
    questionId = asked.question.questionId
    expect(asked.delivery.status).toBe('unavailable')

    // The root comes back (adoption), which also restarts the middle's batch
    // driver: the batch's children are all terminal, and the parent's submission
    // is exactly what the batch driver owns. It must not submit: the middle's own
    // question is still open.
    const root = await a.create(ROOT)
    await a.runtime.adoptRoot(STORE, ROOT)
    const outcomes = await a.runtime.awaitBatch(STORE, 'b-t-middle')
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const held = await a.snapshot()
    expect(held.runs.find(run => run.runId === 'r-middle')?.executionPhase).toBe('waiting_children')
    expect(held.runs.find(run => run.runId === 'r-middle')?.status).toBe('running')
    expect(held.runs.find(run => run.runId === 'r-middle')?.submission).toBeUndefined()
    expect(held.tasks.find(task => task.taskId === 't-middle')?.status).not.toBe('verified')
    expect(held.reviews.some(review => review.runId === 'r-middle')).toBe(false)
    // The middle is blocked by its own question, and the answer it waits for was
    // delivered to the root once it was live.
    expect(a.runtime.gate.questionsBlocked(MIDDLE)).toBe(true)
    expect(a.copiesOf(ROOT, asked.question.messageId)).toBe(1)

    // The answer closes the last coordination item: the driver that owns the
    // parent's submission is re-entered and the parent is judged by its own
    // criteria — the runtime submits on its behalf, exactly as it does for a
    // batch whose children settled with no coordination left.
    answerNow.resolve()
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_answer' && call.sessionId === ROOT)).toBe(true))
    const answerCall = calls.find(call => call.name === 'task_answer' && call.sessionId === ROOT) as DispatchedCall
    const answered = await a.runtime.answerParentQuestion(ROOT, { callId: answerCall.callId, questionId, requestKey: 'a1', resolves: true })
    expect(answered.created).toBe(true)
    const settled = await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.runs.find(run => run.runId === 'r-middle')?.status).toBe('verified')
      return snapshot
    })
    expect(settled.tasks.find(task => task.taskId === 't-middle')?.status).toBe('verified')
    const review = settled.reviews.find(item => item.runId === 'r-middle')
    expect(review?.outcome).toBe('verified')
    const submitted = settled.runs.find(run => run.runId === 'r-middle')
    expect(submitted?.submission?.origin).toBe('runtime')
    expect(settled.questions?.byId[questionId]?.answers?.map(answer => answer.resolves)).toEqual([true])
    expect(a.runtime.gate.questionsBlocked(MIDDLE)).toBe(false)
    void root
    await a.dispose()
  }, 30_000)
})

describe('A4 recovery from the real session log', () => {
  it('leaves a question-waiting run in flight, restores its block, and delivers the question once when the target comes back', async () => {
    const dir = workspace()
    const asked = Promise.withResolvers<void>()

    // The first process: the child asks its parent and the parent is not live, so
    // the delivery is `unavailable` — the intent is durable and nothing was sent.
    const a = await Boot.open(dir, sessionId => sessionId === CHILD
      ? [{ tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { waitFor: () => asked.promise }]
      : [{ waitFor: () => asked.promise }])
    await seedParentChild(a)
    const child = await a.create(CHILD)
    a.begin(child, 'begin the child work')
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_ask_parent' && call.sessionId === CHILD)).toBe(true))
    const firstCall = calls.find(call => call.name === 'task_ask_parent' && call.sessionId === CHILD) as DispatchedCall
    const askedOutcome = await a.runtime.askParentQuestion(CHILD, { callId: firstCall.callId, requestKey: 'k1', blocking: true })
    expect(askedOutcome.created).toBe(true)
    expect(askedOutcome.delivery.status).toBe('unavailable')
    expect(blockingQuestionsOf(await a.snapshot(), 'r-child')).toHaveLength(1)
    expect(askedOutcome.question.childRunId).toBe('r-child')
    await a.crash()

    // The second process: the root's session comes back, the store recovers, and
    // the child is *not* an abandoned in-flight run — its question is on the
    // record and the answer it waits for is still owed.
    const b = await Boot.open(dir, () => [{ text: 'recovered' }])
    await b.create(ROOT)
    const adopted = await b.runtime.adoptRoot(STORE, ROOT)
    expect(adopted).toMatchObject({ adopted: true, taskId: 't-root', runId: 'r-root' })
    const after = await b.snapshot()
    const childRun = after.runs.find(run => run.runId === 'r-child')
    expect(childRun?.status).toBe('running')
    expect(childRun?.sessionId).toBe(CHILD)
    expect(after.reviews.some(review => review.runId === 'r-child')).toBe(false)
    // The block is rebuilt from the durable facts, for a session this process
    // never bound: the gate keys on the session the store's runs name.
    expect(b.runtime.gate.questionsBlocked(CHILD)).toBe(true)
    expect(b.runtime.gate.phaseOf(CHILD)).toBe('active')
    const denied = b.runtime.gate.decide(CHILD, 'write')
    expect(denied.allow).toBe(false)
    if (denied.allow) throw new Error('unreachable')
    expect(denied.reason).toContain('waiting on an unresolved blocking question')
    // The delivery the first process could not make is made exactly once here,
    // and the record's identity is the one that landed.
    expect(b.copiesOf(ROOT, askedOutcome.question.messageId)).toBe(1)
    const report = await b.runtime.reconcileStore(STORE)
    expect(report.questionDeliveries).toEqual([{
      subject: `question "${askedOutcome.question.questionId}"`,
      messageId: askedOutcome.question.messageId,
      status: 'already-present',
    }])
    expect(b.copiesOf(ROOT, askedOutcome.question.messageId)).toBe(1)
    // And the parent's own model really saw it: the request it served carries the
    // question identity and the words.
    const served = b.adapter.requestsOf(ROOT)
    expect(served.some(request => request.texts.some(text => text.includes(askedOutcome.question.questionId)))).toBe(true)
    expect(served.some(request => request.texts.some(text => text.includes('which contract holds?')))).toBe(true)
    // Nothing else was touched: the child is still the one run that was in flight,
    // and no second run was charged to the tree.
    expect(after.runs).toHaveLength(2)
    // The child's own session is still the one the store names, and the answer
    // a parent would send would go to it (the record says so).
    expect(after.questions?.byId[askedOutcome.question.questionId]?.childRunId).toBe('r-child')
    expect(child.session.id).toBe(SessionId(CHILD))
    await b.dispose()
  })

  it('settles an in-flight run without a question cancelled, exactly as it did before (the counter-example)', async () => {
    const dir = workspace()
    const a = await Boot.open(dir, () => [{ text: 'nothing to do' }])
    await seedParentChild(a)
    await a.create(CHILD)
    await a.crash()

    const b = await Boot.open(dir, () => [{ text: 'recovered' }])
    await b.create(ROOT)
    await b.runtime.adoptRoot(STORE, ROOT)
    const after = await b.snapshot()
    const childRun = after.runs.find(run => run.runId === 'r-child')
    expect(childRun?.status).toBe('cancelled')
    const review = after.reviews.find(item => item.runId === 'r-child')
    expect(review?.outcome).toBe('cancelled')
    expect(review?.anomalies.join(' ')).toContain('was in flight when this store was reopened')
    expect(b.runtime.gate.questionsBlocked(CHILD)).toBe(false)
    expect(b.runtime.gate.phaseOf(CHILD)).toBe('terminal')
    // A late answer to the question nobody asked cannot revive it.
    await expect(b.task.answerParentQuestionIn(STORE, {
      questionId: 'q-none',
      parentRunId: 'r-root',
      requestKey: 'a1',
      answerDigest: 'a'.repeat(64),
      resolves: true,
      answerRef: { sessionId: ROOT, seq: 0 },
      messageId: 'm-q-none',
    }, ACTOR)).rejects.toThrow(/unknown question/)
    expect((await b.snapshot()).runs.find(run => run.runId === 'r-child')?.status).toBe('cancelled')
    await b.dispose()
  })

  it('makes a resumed batch wait for the question-waiting child instead of cancelling it, and the parent settles by its own rules', async () => {
    const dir = workspace()
    const asked = Promise.withResolvers<void>()
    const a = await Boot.open(dir, sessionId => sessionId === CHILD
      ? [{ tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { waitFor: () => asked.promise }]
      : [{ waitFor: () => asked.promise }])
    await seedParentChild(a, { parentWaitingChildren: true })
    const child = await a.create(CHILD)
    a.begin(child, 'begin the child work')
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_ask_parent' && call.sessionId === CHILD)).toBe(true))
    const firstCall = calls.find(call => call.name === 'task_ask_parent' && call.sessionId === CHILD) as DispatchedCall
    const askedOutcome = await a.runtime.askParentQuestion(CHILD, { callId: firstCall.callId, requestKey: 'k1', blocking: true })
    expect(askedOutcome.delivery.status).toBe('unavailable')
    await a.crash()

    // The second process: the parent is `waiting_children` with a batch whose only
    // child is the question-waiting run. The recovery pass leaves the child (its
    // question is on the record), and the driver the pass restarts adopts it —
    // without cancelling it, because it is waiting exactly where the protocol put
    // it. The driver's own adoption is the only writer that touches this session's
    // gate decision, so the token moving is what proves it got there.
    const b = await Boot.open(dir, () => [{ text: 'recovered' }])
    await b.create(ROOT)
    await b.runtime.adoptRoot(STORE, ROOT)
    expect(b.runtime.gate.decisionToken(CHILD)).toBe(0)
    expect(b.runtime.gate.questionsBlocked(CHILD)).toBe(true)
    await vi.waitFor(() => expect(b.runtime.gate.decisionToken(CHILD)).toBeGreaterThan(0))
    const running = await b.snapshot()
    expect(running.runs.find(run => run.runId === 'r-child')?.status).toBe('running')
    expect(running.reviews.some(review => review.runId === 'r-child')).toBe(false)
    expect(b.copiesOf(ROOT, askedOutcome.question.messageId)).toBe(1)

    // Now the child is stopped the way any other terminal write stops it (the
    // store's own service, by the actor that owns the run): the wait ends, the
    // driver adopts the terminal child, and the batch settles by its own rules —
    // the parent is submitted, drained and judged by the verifier, exactly as a
    // batch whose children all reached a terminal state always was.
    await b.task.markRunStatusIn(STORE, 't-child', 'r-child', 'cancelled', ACTOR, { reason: 'test: the child was stopped by its owner' })
    const outcomes = await b.runtime.awaitBatch(STORE, 'b-t-root')
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const after = await b.snapshot()
    const settled = after.runs.find(run => run.runId === 'r-child')
    expect(settled?.status).toBe('cancelled')
    // The cancellation is the one this test wrote: the driver never cancelled it.
    const cancellation = b.eventsOf(STORE).filter(event => event.kind === 'TaskCancelled' && event.runId === 'r-child')
    expect(cancellation).toHaveLength(1)
    expect(JSON.stringify(cancellation[0])).toContain('the child was stopped by its owner')
    expect(JSON.stringify(cancellation[0])).not.toContain('was in flight when batch')
    expect(after.runs.find(run => run.runId === 'r-root')?.status).toBe('verified')
    expect(after.reviews.find(review => review.runId === 'r-root')?.outcome).toBe('verified')
    await b.dispose()
  })

  it('refuses a late answer to a question whose asking run is already terminal, and revives nothing', async () => {
    const dir = workspace()
    const asked = Promise.withResolvers<void>()
    let questionId = ''
    const a = await Boot.open(dir, sessionId => sessionId === CHILD
      ? [{ tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } }, { waitFor: () => asked.promise }]
      : [{ waitFor: () => asked.promise }])
    await seedParentChild(a)
    const child = await a.create(CHILD)
    a.begin(child, 'begin the child work')
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_ask_parent' && call.sessionId === CHILD)).toBe(true))
    const firstCall = calls.find(call => call.name === 'task_ask_parent' && call.sessionId === CHILD) as DispatchedCall
    const askedOutcome = await a.runtime.askParentQuestion(CHILD, { callId: firstCall.callId, requestKey: 'k1', blocking: true })
    questionId = askedOutcome.question.questionId
    await a.crash()

    const b = await Boot.open(dir, sessionId => sessionId === ROOT
      ? [{ tool: 'task_answer', args: { questionId, requestKey: 'a1', answer: 'the frozen contract holds', resolves: true } }]
      : [{ text: 'nothing' }])
    const root = await b.create(ROOT)
    await b.runtime.adoptRoot(STORE, ROOT)
    // The question-waiting run is in flight after recovery. Its owner then stops
    // it (the store's own terminal write), which is the state a late answer must
    // meet: the question record stays as the audit, and nothing may answer it.
    await b.task.markRunStatusIn(STORE, 't-child', 'r-child', 'cancelled', ACTOR, { reason: 'test: stopped before the answer' })
    const eventsBefore = b.eventsOf(STORE).length
    b.begin(root, 'answer the child')
    await vi.waitFor(() => expect(calls.some(call => call.name === 'task_answer' && call.sessionId === ROOT)).toBe(true))
    const answerCall = calls.find(call => call.name === 'task_answer' && call.sessionId === ROOT) as DispatchedCall
    await expect(b.runtime.answerParentQuestion(ROOT, { callId: answerCall.callId, questionId, requestKey: 'a1', resolves: true }))
      .rejects.toThrow(/is not open: child run "r-child" is cancelled/)
    const after = await b.snapshot()
    expect(after.runs.find(run => run.runId === 'r-child')?.status).toBe('cancelled')
    expect(after.questions?.byId[questionId]?.answers ?? []).toEqual([])
    expect(b.eventsOf(STORE)).toHaveLength(eventsBefore)
    // The store's own derivation agrees: a cancelled run is released from the
    // question without a cancellation event, and the block cannot outlive it.
    // (The gate flag itself is the runtime's bookkeeping around a terminal write,
    // and this cancellation was written straight through the store's service
    // rather than through the runtime's settlement closure — the closure is what
    // closes a gate, which the recovery cases above assert.)
    expect(blockingQuestionsOf(after, 'r-child')).toEqual([])
    await b.dispose()
  })
})
