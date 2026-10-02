/**
 * A4 cold recovery, closed loop (plan §F.1): a deployment whose stores and
 * sessions live in the real JSONL log is booted, driven until a worker is
 * waiting on its parent's answer, killed, and booted again over the same
 * directory — and the *whole* exchange then completes: the same Sessions come
 * back, the parent's answer reaches the asking child's own model request, the
 * child submits, and the batch ends by handing its parent back its own decision
 * (K1 §2: the runtime submits for nobody, so each parent hands in its own
 * result through the shipped tool when its turn comes).
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
 *
 * The last block is K1 §5's own subject on this same chain: the two crash windows
 * around a batch's end — every child terminal and the handback not yet durable,
 * and the handback durable with the parent not yet told — plus the replay half of
 * the second, where the parent that has to come back is a resumed worker rather
 * than the store's own root.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import {
  SessionId,
  SESSION_FORMAT_VERSION,
} from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type {
  SessionEvent,
  SessionHeader,
} from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import SessionStore from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import AgentLoop from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import LlmRuntime, {
  LlmAdapter,
  createSystemMessage,
  createUserMessage,
} from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  UserMessage,
  StreamChunk,
} from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import {
  toolCallResponse,
  textResponse,
} from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import { rootTaskStoreId, questionIdOf, TaskService } from '../../task/src/index.ts'
import type { CapabilityManifest, QuestionRecord, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { defineTaskAnswerTool } from '../../agent-singularity/src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../agent-singularity/src/tools/task-ask-parent.ts'
import { defineTaskDecomposeTool } from '../../agent-singularity/src/tools/task-decompose.ts'
import { defineTaskIntakeTool } from '../../agent-singularity/src/tools/task-intake.ts'
import { defineTaskSubmitResultTool } from '../../agent-singularity/src/tools/task-submit-result.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

export const PROVIDER = 'mock'

export const MODEL = 'mock'

export const ROOT = 's-root'

export const STORE = rootTaskStoreId(ROOT)

export const SCOPE = { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }

/** The root contract every case runs under: one goal, one criterion a command settles. */
export const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** One child spec: a goal and a criterion a command can settle. */
export const children = (objective: string): DecomposeSpec['children'] => [
  {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
  },
]

/**
 * The capability manifest a decomposed child is admitted under: no capabilities
 * at all. It is a manifest like any other — a run's store record always carries
 * one, and the recovery's worker resume rebuilds the grant from exactly this
 * record — so a fixture that admitted children without one would be testing a
 * store no real batch writes.
 */
export const NO_CAPABILITIES: CapabilityManifest = { capabilities: {}, missing: [], closure: 'closed' }

/** The tools registered as the deployment's own definitions; every other name in the plane is a stand-in. */
export const SHIPPED_TOOLS = ['task_intake', 'task_decompose', 'task_submit_result', 'task_ask_parent', 'task_answer']

/** One scripted model answer: a tool call, a final text, a latch that parks the request, or a request that never ends. */
export type ScriptEntry =
  | {
      readonly tool: string
      readonly args?: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>)
    }
  | { readonly text: string }
  | { readonly waitFor: () => Promise<void> }
  | { readonly hang: true }

/** One request the adapter served, with the texts the loop would have sent. */
export interface ServedRequest {
  readonly options: GenerateOptions
  readonly texts: readonly string[]
}

/** One tool call this deployment dispatched. */
export interface DispatchedCall {
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly args: unknown
  result?: { readonly isError: boolean; readonly text: string }
}

/** One script per session, consumed one request at a time — the model, and nothing else, is scripted. */
export class ScriptedAdapter extends LlmAdapter {
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queues.get(sessionId) ?? [...this.script(sessionId, this.index.resolve(sessionId))]
    this.queues.set(sessionId, queue)
    const served = this.requests.get(sessionId) ?? []
    served.push({
      options,
      texts: options.messages.flatMap(message =>
        message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])),
      ),
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
    const args = typeof entry.args === 'function' ? entry.args() : (entry.args ?? {})
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...args })
  }

  /** Which script index one session gets: the root is 0, the sessions this boot spawned follow in spawn order. */
  index: { resolve: (sessionId: string) => number } = { resolve: () => 0 }
}

/** Wait for one latch, or reject when the turn is cancelled: a parked request must not outlive its turn. */
export async function raceAbort(latch: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await latch
  if (signal.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('aborted'))
    }
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
export class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not part of this fixture'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not part of this fixture'))
  }
}

/** The graph store's own records, as a durable store holds them across a restart. */
export interface GraphRecords {
  readonly roots: readonly string[]
  readonly agents: readonly { readonly id: string; readonly name: string; readonly status: string }[]
  readonly edges: readonly { readonly kind: string; readonly from: string; readonly to: string }[]
}

/** One boot of the deployment over one directory; a second boot over it is the restart. */
export class Boot {
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
      readonly rootBudget?: Readonly<{ maxRuns?: number }>
      /** The review policy a root contract is intaken under; the default is this runtime's own. */
      readonly generatedTaskReview?: 'off' | 'all'
      /**
       * Park one session's write drain on a managed job that never confirms stopped
       * (`a3-recovery.spec.ts`'s lever): the settlement behind it is frozen exactly
       * where a killed process would leave it, with no timer deciding anything. The
       * index is that session's own drain count, so a case can freeze the batch
       * admission (the first) or the check the batch end makes of the parent (a
       * later one) — the crash point "every child is terminal, the handback is not
       * yet durable" (K1 §5's first window).
       */
      readonly parkDrain?: (sessionId: string, drainIndex: number) => boolean
      /**
       * Hold one relay delivery before it is made: the runtime has reached the wake
       * and the message has not landed. A latch that never resolves is the crash
       * point "the batch ended and the run is `active`, the parent was never told"
       * (K1 §5's second window). The relay itself is the real one; only its return
       * is held.
       */
      readonly gateDelivery?: (intent: { messageId: string; targetSessionId: string }) => Promise<void> | undefined
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
      create: (
        header: SessionHeader,
      ) => Promise<{ append: (events: readonly unknown[]) => Promise<void>; close: () => Promise<void> }>
      open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    }
    // The root session's own durable record: a deployment's graph creation writes
    // the header of the root it is about to open *and* the person's request that
    // justifies it, and the runtime's root entry (`ensureRoot`) resumes exactly
    // that record. The fixture writes both the way the deployment does, so a
    // second boot finds the Session already there. A Session's surface opens with
    // its system head (v4), so the seed writes the closed turn that left the
    // (empty) head behind; the loop's own projection replaces it on the first
    // request the resumed agent makes.
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
      const seededAt = Date.now()
      await seed.append([
        { type: 'turn/start', seq: 0, time: seededAt, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: seededAt + 1, data: { turn: 1, step: 1 } },
        {
          type: 'system/message',
          seq: 2,
          time: seededAt + 2,
          data: { turn: 1, step: 1, message: createSystemMessage('') },
          surfaceOp: 'append',
        },
        { type: 'step/end', seq: 3, time: seededAt + 3, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4, time: seededAt + 4, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 5,
          time: seededAt + 5,
          data: createUserMessage({ content: [{ type: 'text', text: 'ship the release' }], source: { kind: 'user' } }),
          surfaceOp: 'append',
        },
      ] as never)
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
      agents: (options.graph?.agents ?? [{ id: ROOT, name: 'Singularity', status: 'idle' }]).map(agent => ({
        ...agent,
      })),
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
        events: readonly {
          kind: string
          agent?: { id: string; name: string }
          edge?: { kind: string; from: string; to: string }
        }[],
      ) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined)
            graph.agents.push({ ...event.agent, status: 'idle' })
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
      list: async () => [
        {
          id: 'g1',
          name: 'graph',
          envId: 'env1',
          rootSessionId: ROOT,
          graphStoreId: SCOPE.graphStoreId,
          layoutStoreId: SCOPE.layoutStoreId,
        },
      ],
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
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }],
        },
        execute: async () => `${name}: fixture answer`,
      })
    }
    for (const name of [...new Set([...ROOT_TOOLS, ...OTHER_TOOLS])]) {
      if (SHIPPED_TOOLS.includes(name)) continue
      standIn(name)
    }
    const agentRuntime = new AgentRuntime(ctx)
    const holdDelivery = options.gateDelivery
    if (holdDelivery !== undefined) {
      // The relay stays the real one; only the return of the deliveries a case names
      // is held. Everything the delivery would do — the fold it reads, the inbox it
      // steers into, the flush it waits on — happens on the far side of the latch.
      const realDeliver = agentRuntime.ensureAgentMessageDelivered.bind(agentRuntime)
      const relay = agentRuntime as unknown as {
        ensureAgentMessageDelivered: (intent: Parameters<typeof realDeliver>[0]) => ReturnType<typeof realDeliver>
      }
      relay.ensureAgentMessageDelivered = async intent => {
        const held = holdDelivery({
          messageId: String(intent.messageId),
          targetSessionId: String(intent.targetSessionId),
        })
        if (held !== undefined) await held
        return await realDeliver(intent)
      }
    }
    const freezeDrain = options.parkDrain
    if (freezeDrain !== undefined) {
      // The drain's one awaited jobs call never returns, so the drain — and the
      // settlement behind it — is frozen without a timer. `list` is synchronous by
      // the seam's contract; the live entry it returns is what makes the drain call
      // `wait`.
      const drains = new Map<string, number>()
      ctx.provide('jobs', {
        list: (agent: { id?: string } | undefined) => {
          const id = agent?.id
          if (id === undefined) return []
          const index = (drains.get(id) ?? 0) + 1
          drains.set(id, index)
          return freezeDrain(id, index) ? [{ id: `frozen-drain-${id}`, status: 'running' }] : []
        },
        kill: () => undefined,
        wait: () => new Promise(() => {}),
      } as never)
    }
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
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {
      surfaceOp: 'append',
    })
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
    await this.task.createTaskIn(
      STORE,
      {
        taskId,
        definitionRef: { taskType: 'root', version: 1 },
        objective: 'champion work',
        depth: 0,
        acceptanceCriteria: [
          {
            criterionId: 'ac1-1',
            description: 'it holds',
            verificationMode: 'deterministic' as const,
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: [],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      },
      ROOT,
    )
    await this.task.admitTaskIn(STORE, taskId, ROOT, { decompositionStatus: 'leaf', manifest: NO_CAPABILITIES })
    await this.task.startRunIn(
      STORE,
      {
        runId,
        taskId,
        sessionId: 's-champion',
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: new Date().toISOString(),
      },
      ROOT,
    )
    await this.task.markRunStatusIn(STORE, taskId, runId, 'verifying', ROOT)
    await this.task.recordEvidenceIn(
      STORE,
      {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId,
        artifacts: [],
        verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
        claims: [],
        generatedAt: new Date().toISOString(),
      },
      ROOT,
    )
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
    const suffix = join(sessionId, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
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
        data?: {
          id?: string
          target?: 'next-turn' | 'next-step'
          start?: number
          removedCount?: number
          inserted?: { id?: string }[]
        }
      }
      if (event.type === 'user/message' && event.data?.id === messageId) copies += 1
      if (event.type !== 'agent/inbox/spliced' || event.data?.target === undefined) continue
      inbox[event.data.target].splice(
        event.data.start ?? 0,
        event.data.removedCount ?? 0,
        ...(event.data.inserted ?? []).map(message => String(message.id)),
      )
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
    return {
      claimed: claim.promise,
      release: () => {
        gate.resolve()
      },
    }
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

export const directories: string[] = []

export function workspace(): string {
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
export async function askWhileParentBusy(
  dir: string,
): Promise<{ boot: Boot; questionId: string; childSession: string; messageId: string }> {
  const childGo = Promise.withResolvers<void>()
  const boot = await Boot.open(dir, {
    script: (_sessionId, index) =>
      index === 0
        ? [
            { tool: 'task_decompose', args: { reason: 'split the release work', children: children('child work') } },
            { text: 'root: waiting' },
          ]
        : [
            { waitFor: () => childGo.promise },
            { tool: 'task_ask_parent', args: { requestKey: 'k1', question: 'which contract holds?' } },
            { hang: true },
          ],
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
  await vi.waitFor(async () => expect((await boot.question(questionId))?.childRunId).toBe(childRun), {
    timeout: 20_000,
  })
  // QuestionAsked precedes delivery. This fixture promises the durable,
  // unclaimed inbox append, which is the window its callers crash inside.
  await vi.waitFor(() => expect(boot.copiesOf(ROOT, `m-${questionId}`)).toBe(1), { timeout: 20_000 })
  return { boot, questionId, childSession, messageId: `m-${questionId}` }
}
