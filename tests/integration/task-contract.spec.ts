import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SingularityAgent } from '../../agent-singularity/src/index.ts'
import type { TaskEvent, TaskInstance, TaskSnapshot } from '../../task/src/index.ts'
import { TaskService, canonicalize, contractDigest, decompositionDigest, rootTaskStoreId } from '../../task/src/index.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, mountContextReadCore, sessionQueryReads } from '../support/context-plane.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'

/**
 * T1 (the unified normalized task contract) end to end on the real chain: the
 * two creation entries a task can come from — the real `task_decompose` tool on
 * its mounted root plane, and `TaskRuntime.decomposeAndRun` directly — the one
 * normalization entry, admission, the real `TaskService` store and reducer, the
 * real sequential cascade, and the real `VerifierRegistry` with its real
 * `CommandVerifier` and `CompositeVerifier`.
 *
 * Every assertion reads a fact back — the persisted `task/event` log or a store
 * snapshot — never the writer's return value alone, and a refusal is asserted
 * together with its absence of side effects (no event, no task, no spawn).
 *
 * What is real: the cordis context and its `ctx.get(...)` service resolution,
 * `TaskService`, `TaskRuntime`, `VerifierRegistry`, the whole cascade, the
 * reducer's validation, the tool registry the plugin registers into, and the
 * session log the store is replayed from.
 *
 * What is stubbed, and why: `sessionPersistence` (an in-memory handle whose
 * append round-trips through JSON the way the real JSONL log does),
 * `agentRuntime.spawn` (no model loop runs here), the `agents` lookup (a
 * spawned worker's agent), and `graphs` (a fixed env binding). Nothing about
 * task creation, admission, or verification is stubbed.
 *
 * One session memory is shared by every service generation, so `reopen` below
 * is a real replay of the persisted log rather than a second peek at a live
 * object.
 */

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)

/** The wrapper the tool puts around a refusal it caught (`agent-singularity/src/tools/task-decompose.ts:154`). */
const TOOL_REJECTION = 'task_decompose rejected: '

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): unknown
}

/** One spawn the runtime asked the agent plane for, as the agent plane received it. */
interface SpawnRequest {
  sessionId: string
  name: string
  prompt: string
  contract?: string
}

/** The persisted sessions one store lives in: hoisted out of a generation so two generations can share it. */
interface SessionMemory {
  headers: Map<string, SessionHeader>
  events: Map<string, SessionEvent[]>
}

interface Generation {
  ctx: Context
  task: TaskService
  runtime: TaskRuntime
  verifier: VerifierRegistry
  /** The tool registry stand-in; populated only when the generation mounts the root agent. */
  tools: Map<string, RegisteredTool>
  spawned: SpawnRequest[]
  memory: SessionMemory
}

/** One root task plus the run bound to its session: the caller identity every entry resolves against. */
interface Root {
  storeId: string
  taskId: string
  runId: string
  session: string
}

const contexts: Context[] = []
let home: string

beforeEach(async () => {
  // The root-agent plugin derives its ledgers from `$DSH_HOME`; keep every one
  // of them inside this test's tmp fixture.
  home = await mkdtemp(join(tmpdir(), 't1-contract-home-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

function sessionMemory(): SessionMemory {
  return { headers: new Map(), events: new Map() }
}

/**
 * The session-persistence fake, hoisted out of a generation so two service
 * generations read one store. `open` is what a reopen goes through, and the
 * append path round-trips its records through JSON because the real handle
 * appends JSONL: a contract that only survives object identity has not
 * survived the store.
 */
function sessionPersistence(memory: SessionMemory) {
  const handle = (id: SessionId) => ({
    read: async () => ({ events: memory.events.get(id) ?? [] }),
    append: async (records: readonly SessionEvent[]) => {
      memory.events.get(id)?.push(...(JSON.parse(JSON.stringify(records)) as SessionEvent[]))
    },
    flush: async () => {},
    close: async () => {},
  })
  return {
    list: async () => [...memory.headers.values()].map(header => ({ header })),
    create: async (header: SessionHeader) => {
      memory.headers.set(header.id, header)
      memory.events.set(header.id, [])
      return handle(header.id)
    },
    open: async (id: SessionId) => {
      if (!memory.events.has(id)) throw new Error(`missing session ${id}`)
      return handle(id)
    },
  }
}

/** One service generation over the given persisted sessions: the boot a restart performs. */
async function generation(
  memory: SessionMemory,
  options: { config?: Partial<Config>; mountAgent?: boolean } = {},
): Promise<Generation> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('sessionPersistence', sessionPersistence(memory) as never)

  const spawned: SpawnRequest[] = []
  /**
   * The graph root each session belongs to. A root session is its own graph's
   * root; a spawned session belongs to the tree that spawned it. The runtime
   * resolves a session's environment library from this identity, so a worker
   * that mapped to itself would look for its own revision — a graph the
   * deployment never created.
   */
  const graphRoot = new Map<string, string>()
  const rootOf = (sessionId: string): string => {
    const seen = new Set<string>()
    let current = sessionId
    while (graphRoot.has(current) && !seen.has(current)) {
      seen.add(current)
      current = graphRoot.get(current)!
    }
    return current
  }
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: { sessionId: string; name: string; prompt?: { text: string }[]; taskWorker?: boolean; contract?: string }) => {
      const parentId = String((_parent as { id?: unknown } | undefined)?.id ?? '')
      graphRoot.set(request.sessionId, rootOf(memory.headers.has(parentId) ? parentId : request.sessionId))
      spawned.push({
        sessionId: request.sessionId,
        name: request.name,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt.map(block => block.text).join('\n') }),
        ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
        ...(request.contract === undefined ? {} : { contract: request.contract }),
      })
      return {
        agent: {
          id: request.sessionId,
          cancel: () => {},
          // A live worker hands its result in before it goes idle (A3 §3.2): an
          // idle session is not a completion, so a stub that only went idle would
          // be stopped by the no-progress rule instead of being verified.
          whenIdle: async () => { await runtime.submitResult(request.sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
        },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', graphRegistry({
    graphForSession: async (sessionId: SessionId) => ({ id: 'g1', name: 'graph', envId: 'env1', rootSessionId: rootOf(String(sessionId)) }),
    members: () => [...memory.headers.keys()],
  }) as never)
  // The read plane the tools and the assembly need (A2): the session log this
  // generation has open, so a session reference reads the same events this
  // fixture's assertions read.
  ctx.provide('sessionQuery', sessionQueryReads(sessionId => memory.events.get(sessionId as SessionId)) as never)

  const tools = new Map<string, RegisteredTool>()
  if (options.mountAgent === true) {
    ctx.provide('tools', {
      register: (tool: RegisteredTool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    } as never)
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) } as never)
    ctx.provide('approval', { request: async () => 'allowed-once' } as never)
  }

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: await mkdtemp(join(tmpdir(), 't1-evidence-')) })
  // Cordis readies the service when it loads the plugin; a hand-built registry
  // has to be readied explicitly, or `verifierIds()` reports no vocabulary at all.
  await verifier.ready()
  const runtime = new TaskRuntime(ctx, { ...(options.config), capabilities: { ...TASK_GUIDANCE, ...(options.config)?.capabilities } } as Config | undefined)
  if (options.mountAgent === true) {
    // The read core and the prompt assembly, mounted where the deployment's bundle
    // mounts them: the plugin's tool adapters read through this service (A2).
    await mountContextReadCore(ctx)
    await ctx.plugin(SingularityAgent)
  }
  return { ctx, task, runtime, verifier, tools, spawned, memory }
}

/** Dispose one generation and boot another over the same persisted sessions, then reopen the store from them. */
async function reopen(h: Generation, storeId: string): Promise<Generation> {
  const index = contexts.indexOf(h.ctx)
  if (index >= 0) contexts.splice(index, 1)
  await h.ctx.fiber.dispose()
  const next = await generation(h.memory)
  await next.task.openStore(storeId)
  return next
}

/** Every task event the store actually appended, read back off its session log. */
function taskEvents(h: Generation): TaskEvent[] {
  return [...h.memory.events.values()].flatMap(events => events.flatMap(event =>
    event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The payload of one task's event of one kind, or undefined when it never landed. */
function payloadOf<K extends TaskEvent['kind']>(h: Generation, kind: K, taskId: string): Extract<TaskEvent, { kind: K }>['payload'] | undefined {
  const event = taskEvents(h).find(item => item.kind === kind && item.taskId === taskId) as Extract<TaskEvent, { kind: K }> | undefined
  return event?.payload
}

/** The one stored task authored with this objective — the batch's own words, read back from the store. */
function taskWithObjective(snapshot: TaskSnapshot, objective: string): TaskInstance {
  const matches = snapshot.tasks.filter(item => item.objective === objective)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

/** Which verifier actually judged one task, read back off the evidence the store holds. */
function verifierIdsFor(snapshot: TaskSnapshot, taskId: string): string[] {
  return snapshot.evidence
    .filter(item => item.taskId === taskId)
    .flatMap(item => item.verifierResults.map(result => result.verifierId))
}

/**
 * The real root task of one session, bound to the run every entry resolves the
 * caller through — activated through the real intake (A0 §1.2) with the spec's
 * own contract: one goal, one criterion a command settles, and the conjunction,
 * because these cases read the root's verdict as the tree's. The contract is
 * stated here rather than defaulted, since a root contract owes at least one
 * mandatory criterion judged by something other than the composite conjunction.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      { criterionId: 'root-children-verified', description: 'all mandatory children verified', mode: 'composite', mandatory: true },
    ],
  }
}

async function createRoot(h: Generation, objective: string, session = ROOT_SESSION): Promise<Root> {
  const storeId = rootTaskStoreId(session)
  // The person asked for this objective, and that request is on the session's own
  // durable log before the intake reads it (A0 §1.10): the origin rule is the
  // *existence* of a user-sourced message, and these cases are about what follows
  // the intake rather than about the rule itself.
  h.memory.headers.set(session, { id: session, cwd: '.', agentPreset: 'standard' } as unknown as SessionHeader)
  if (!h.memory.events.has(session)) h.memory.events.set(session, [personRequest(objective)])
  const activated = await h.runtime.intakeRootContract(storeId, session, rootContract(objective))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { storeId, taskId: activated.taskId, runId: activated.runId, session }
}

/** The tool-run context the plugin reads the caller session off (`task-decompose.ts:9-13`). */
function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

/** Minted ids (`t-…`, `r-…`) are deliberately outside the contract digests, so two refusals of one input differ only there. */
function maskIds(text: string): string {
  return text.replace(/[tr]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Drive the real tool and return its refusal, whether it refused through its own schema or through the runtime. */
async function refusalOfTool(h: Generation, spec: Record<string, unknown>, session: string): Promise<string> {
  const tool = h.tools.get('task_decompose')
  if (tool === undefined) throw new Error('the root agent did not register task_decompose')
  let thrown: unknown
  let text: string | undefined
  try {
    text = (await tool.execute(spec, exec(session))) as string
  } catch (error) {
    thrown = error
  }
  if (thrown !== undefined) return message(thrown)
  if (typeof text !== 'string' || !text.startsWith(TOOL_REJECTION)) {
    throw new Error(`task_decompose did not refuse the batch: ${String(text)}`)
  }
  return text.slice(TOOL_REJECTION.length)
}

/** Drive the runtime directly and return its refusal; an admitted batch is this test's own failure. */
async function refusalOfRuntime(h: Generation, spec: Record<string, unknown>, root: Root): Promise<string> {
  let thrown: unknown
  try {
    await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, root.session, spec as unknown as DecomposeSpec)
  } catch (error) {
    thrown = error
  }
  if (thrown === undefined) throw new Error('the runtime admitted a batch it was supposed to refuse')
  return message(thrown)
}

/** The store's own record of one created task, plus the event it was created with. */
async function expectCreatedTask(h: Generation, root: Root, objective: string, criterionId: string): Promise<TaskInstance> {
  // The batch ending judged nobody (K1 §2): the root's own submission is what
  // runs its independent criterion and its conjunction over the children, so
  // every case that reads a terminal root hands the result in here first.
  await h.runtime.submitResult(root.session, { summary: 'the root hands in the result its batch produced' })
  const snapshot = await h.task.snapshotIn(root.storeId)
  const child = taskWithObjective(snapshot, objective)
  expect(child.parentTaskId).toBe(root.taskId)
  expect(child.objective).toBe(objective)
  expect(child.definitionRef).toEqual({ taskType: `contract:${child.contractDigest}`, version: 1, digest: child.contractDigest })
  expect(child.status).toBe('verified')
  expect(child.acceptanceCriteria.map(criterion => criterion.criterionId)).toEqual([criterionId])
  expect(child.contract?.contractVersion).toBe(1)
  expect(child.contract?.objective).toBe(objective)

  const created = payloadOf(h, 'TaskCreated', child.taskId)?.task
  expect(created?.objective).toBe(objective)
  expect(created?.definitionRef).toEqual(child.definitionRef)
  expect(created?.contract?.objective).toBe(objective)
  // The verdicts are the real verifiers': the command verifier judged the
  // child's deterministic criterion and the root's own independent one, the
  // composite verifier the root's conjunction over the children.
  expect(verifierIdsFor(snapshot, child.taskId)).toEqual(['command'])
  expect(verifierIdsFor(snapshot, root.taskId)).toEqual(['command', 'composite'])
  expect((await h.task.taskIn(root.storeId, root.taskId)).status).toBe('verified')
  return child
}

describe('T1-A: a task is created without any template', () => {
  it('creates one task through the real task_decompose tool and one through the runtime, both to verified', async () => {
    const h = await generation(sessionMemory(), { mountAgent: true })
    const viaTool = await createRoot(h, 'the root that delegates through the tool', 's-root-tool')
    const viaRuntime = await createRoot(h, 'the root that delegates through the runtime', 's-root-runtime')
    const toolObjective = 'the task the tool entry created'
    const runtimeObjective = 'the task the runtime entry created'

    const feedback = (await h.tools.get('task_decompose')!.execute({
      reason: 'delegate through the tool',
      children: [{
        objective: toolObjective, requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'tool-1', description: 'the tool child holds', command: 'true' }],
      }],
    }, exec(viaTool.session))) as string
    // The tool's own report — a convenience, not the evidence: everything
    // asserted below is read back out of the store and the event log. The tool
    // returns at admission (A3 §3.1), so the text names the batch rather than
    // outcomes nobody has produced yet; the batch id is read back from the
    // store's own record rather than parsed out of the text.
    expect(feedback).toMatch(/^decomposed t-[0-9a-f-]+ into 1 children \(batch b-r-[0-9a-f-]+-p-[0-9a-f]{64}\):/)
    expect(feedback).toContain('does not wait for the batch')
    const toolBatchId = (await h.task.runIn(viaTool.storeId, viaTool.runId)).batchId!
    await h.runtime.awaitBatch(viaTool.storeId, toolBatchId)

    const batch = await h.runtime.decomposeAndRun(viaRuntime.storeId, viaRuntime.taskId, viaRuntime.runId, viaRuntime.session, {
      reason: 'delegate through the runtime',
      children: [{
        objective: runtimeObjective, requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'runtime-1', description: 'the runtime child holds', command: 'true' }],
      }],
    })
    const outcomes = await h.runtime.awaitBatch(viaRuntime.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // Both entries really walked the cascade: one worker per created task.
    expect(h.spawned).toHaveLength(2)
    await expectCreatedTask(h, viaTool, toolObjective, 'tool-1')
    await expectCreatedTask(h, viaRuntime, runtimeObjective, 'runtime-1')
  })
})

interface RejectionCase {
  name: string
  /** The batch as the caller writes it; a fresh object per entry, so neither call can see the other's mutation. */
  spec(): Record<string, unknown>
  /** The defect the refusal must name (minted ids are masked before comparing). */
  defect: string
  /**
   * Set when the tool's own parameter schema refuses the call before
   * `decomposeAndRun` ever sees it: `task-decompose.ts:62-64` declares `mode`'s
   * enum and `additionalProperties: false`, and `defineTool` validates model
   * arguments on every execute (`dsh-tools/src/schema.ts:585-588`). The value
   * is that refusal, verbatim; the runtime still refuses the same input with
   * `defect`, which every case asserts too.
   */
  toolSchemaRefusal?: string
}

const validChild = () => ({
  objective: 'a child a verifier can judge', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'valid-1', description: 'the child holds', command: 'true' }],
})

const REJECTION_CASES: RejectionCase[] = [
  {
    name: 'an empty objective',
    spec: () => ({ reason: 'split the work', children: [{ ...validChild(), objective: '' }] }),
    defect: 'child 0 objective must be a non-empty string',
  },
  {
    name: 'an empty criteria list',
    spec: () => ({ reason: 'split the work', children: [{ objective: 'a child nothing is required of', requiredCapabilities: ['execute-task'], acceptanceCriteria: [] }] }),
    defect: 'requires at least one acceptance criterion',
  },
  {
    name: 'criteria that are all optional',
    spec: () => ({
      reason: 'split the work',
      children: [{
        objective: 'a child whose every criterion is optional', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'optional-1', description: 'a nice-to-have', command: 'true', mandatory: false }],
      }],
    }),
    defect: 'requires at least one mandatory acceptance criterion',
  },
  {
    name: 'duplicate explicit criterion ids',
    spec: () => ({
      reason: 'split the work',
      children: [{
        objective: 'a child with two criteria sharing one declared id', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [
          { criterionId: 'dup-1', description: 'the first claim', command: 'true' },
          { criterionId: 'dup-1', description: 'the second claim', command: 'true' },
        ],
      }],
    }),
    defect: 'child 0 declares criterion id "dup-1" more than once',
  },
  {
    name: 'an invalid verification mode (the tool\'s own schema refuses it first)',
    spec: () => ({
      reason: 'split the work',
      children: [{
        objective: 'a child judged by no verifier', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'bad-mode', description: 'judged by nothing', mode: 'banana' }],
      }],
    }),
    defect: 'verificationMode "banana" is not one of',
    toolSchemaRefusal: 'invalid arguments: "children[0].acceptanceCriteria[0].mode" must be one of '
      + '["deterministic","simulation","formal","measurement","review"]',
  },
  {
    name: 'an unknown contract version',
    spec: () => ({ contractVersion: 2, reason: 'split the work', children: [validChild()] }),
    defect: 'unknown contract version 2: this runtime writes version 1',
  },
  {
    name: 'an undeclared budget field (the tool\'s own schema refuses it first)',
    spec: () => ({ reason: 'split the work', children: [{ ...validChild(), budget: { wallTimeMs: 1 } }] }),
    defect: 'child 0 declares unknown field "budget"',
    toolSchemaRefusal: 'invalid arguments: "children[0].budget" is not a declared property (additionalProperties: false)',
  },
  {
    name: 'an undeclared skills field (the tool\'s own schema refuses it first)',
    spec: () => ({ reason: 'split the work', children: [{ ...validChild(), skills: ['verify'] }] }),
    defect: 'child 0 declares unknown field "skills"',
    toolSchemaRefusal: 'invalid arguments: "children[0].skills" is not a declared property (additionalProperties: false)',
  },
]

describe('T1-B: the refusals hold at the real entry and leave nothing behind', () => {
  it.each(REJECTION_CASES)('refuses $name', async ({ spec, defect, toolSchemaRefusal }) => {
    const h = await generation(sessionMemory(), { mountAgent: true })
    const root = await createRoot(h, 'the root whose batch is refused')
    const eventsBefore = taskEvents(h).length

    const toolRefusal = await refusalOfTool(h, spec(), root.session)
    const runtimeRefusal = await refusalOfRuntime(h, spec(), root)

    if (toolSchemaRefusal === undefined) {
      // The input reaches the one normalization/admission entry through both
      // entries, so the two refusals are the same text.
      expect(maskIds(toolRefusal)).toBe(maskIds(runtimeRefusal))
      expect(maskIds(toolRefusal)).toContain(defect)
    } else {
      // The tool's declared parameter schema is a second gate in front of the
      // runtime: it refuses the same input first, in its own words, so the tool
      // never emits the runtime's reason for these calls.
      expect(toolRefusal).toBe(toolSchemaRefusal)
    }
    expect(maskIds(runtimeRefusal)).toContain(defect)

    // The refusal left no trace: no event appended, no task created, no spawn.
    expect(taskEvents(h)).toHaveLength(eventsBefore)
    expect(h.spawned).toHaveLength(0)
    const snapshot = await h.task.snapshotIn(root.storeId)
    expect(snapshot.tasks.map(item => item.taskId)).toEqual([root.taskId])
    expect(snapshot.edges).toEqual([])
    expect(payloadOf(h, 'TaskDecomposed', root.taskId)).toBeUndefined()
  })
})

describe('T1-D: the contract that is persisted is the one the batch declared', () => {
  it('stores the declared contract and hands assumptions, dependency evidence and constraints to the worker', async () => {
    const h = await generation(sessionMemory())
    const root = await createRoot(h, 'the root whose batch declares conditions')

    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, root.session, {
      reason: 'split the work under declared conditions',
      children: [
        {
          objective: 'the first contracted child', requiredCapabilities: ['execute-task'],
          acceptanceCriteria: [{ criterionId: 'first-1', description: 'the first claim holds', command: 'true' }],
          assumptions: ['assumption A', 'assumption B'],
          constraints: ['constraint X'],
        },
        {
          objective: 'the second contracted child', requiredCapabilities: ['execute-task'],
          dependsOn: [0],
          acceptanceCriteria: [{ criterionId: 'second-1', description: 'the second claim holds', command: 'true' }],
          assumptions: ['assumption C'],
          constraints: ['constraint Y'],
        },
      ],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])

    const snapshot = await h.task.snapshotIn(root.storeId)
    const first = taskWithObjective(snapshot, 'the first contracted child')
    const second = taskWithObjective(snapshot, 'the second contracted child')

    expect(first.contract).toEqual({
      contractVersion: 1,
      objective: 'the first contracted child',
      acceptanceCriteria: [{
        criterionId: 'first-1',
        description: 'the first claim holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
        verifierRef: 'command',
      }],
      assumptions: ['assumption A', 'assumption B'],
      constraints: ['constraint X'],
      requiredCapabilities: ['execute-task'],
    })
    expect(second.contract).toEqual({
      contractVersion: 1,
      objective: 'the second contracted child',
      acceptanceCriteria: [{
        criterionId: 'second-1',
        description: 'the second claim holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
        verifierRef: 'command',
      }],
      assumptions: ['assumption C'],
      constraints: ['constraint Y'],
      requiredCapabilities: ['execute-task'],
    })
    // The projections the store validates against the contract agree with it.
    expect(first.objective).toBe(first.contract!.objective)
    expect(first.acceptanceCriteria).toEqual(first.contract!.acceptanceCriteria)
    expect(second.acceptanceCriteria).toEqual(second.contract!.acceptanceCriteria)

    // The handoff the store recorded: the child's declared assumptions first,
    // then the evidence its verified dependency produced, then the declared
    // constraints.
    const dependencyEvidenceId = snapshot.evidence.find(item => item.taskId === first.taskId)!.evidenceId
    const firstHandoff = payloadOf(h, 'HandoffCreated', first.taskId)!.handoff
    expect(firstHandoff.assumptions).toEqual(['assumption A', 'assumption B'])
    expect(firstHandoff.constraints).toEqual(['constraint X'])
    expect(firstHandoff.relevantEvidence).toEqual([])

    const secondHandoff = payloadOf(h, 'HandoffCreated', second.taskId)!.handoff
    expect(secondHandoff.assumptions).toEqual([
      'assumption C',
      `dependency evidence "${dependencyEvidenceId}" is verified and available as a reference`,
    ])
    expect(secondHandoff.constraints).toEqual(['constraint Y'])
    expect(secondHandoff.relevantEvidence).toEqual([dependencyEvidenceId])
  })

  it('survives a caller mutating its spec and a second service generation reopening the store', async () => {
    const h = await generation(sessionMemory())
    const root = await createRoot(h, 'the root whose caller keeps its own spec object')

    const spec = {
      reason: 'split the work',
      children: [{
        objective: 'the child whose contract is read back twice', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'readback-1', description: 'the claim holds', command: 'true' }],
        assumptions: ['declared assumption'],
        constraints: ['declared constraint'],
      }],
    }
    const { batchId } = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, root.session, spec)
    await h.runtime.awaitBatch(root.storeId, batchId)

    const before = taskWithObjective(await h.task.snapshotIn(root.storeId), 'the child whose contract is read back twice').contract!
    expect(before).toEqual({
      contractVersion: 1,
      objective: 'the child whose contract is read back twice',
      acceptanceCriteria: [{
        criterionId: 'readback-1',
        description: 'the claim holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
        verifierRef: 'command',
      }],
      assumptions: ['declared assumption'],
      constraints: ['declared constraint'],
      requiredCapabilities: ['execute-task'],
    })

    // The caller still holds its own object after the call: mutating it — arrays
    // and criterion objects alike — must not reach the store.
    spec.children[0]!.objective = 'a mutated objective'
    spec.children[0]!.assumptions.push('a mutated assumption')
    spec.children[0]!.constraints[0] = 'a mutated constraint'
    spec.children[0]!.acceptanceCriteria[0]!.description = 'a mutated description'
    spec.children[0]!.acceptanceCriteria[0]!.criterionId = 'mutated-1'

    const mutated = taskWithObjective(await h.task.snapshotIn(root.storeId), 'the child whose contract is read back twice')
    expect(mutated.contract).toEqual(before)
    expect(mutated.objective).toBe('the child whose contract is read back twice')

    const reopened = await reopen(h, root.storeId)
    const after = taskWithObjective(await reopened.task.snapshotIn(root.storeId), 'the child whose contract is read back twice').contract!
    expect(after).toEqual(before)
    expect(canonicalize(after)).toBe(canonicalize(before))
  })

  it('runs and verifies a task created through raw events without a contract, and invents none for it', async () => {
    const h = await generation(sessionMemory())
    await h.task.createStore(STORE)

    // The legacy store shape: a task authored straight through the store, with
    // no contract, whose run is bound to the caller session. The run still
    // carries its coordination phase — what is legacy here is the contract, and
    // a phase-less run would be refused by admission for a different reason.
    const legacyTaskId = 't-legacy'
    const legacyRunId = 'r-legacy'
    await h.task.createTaskIn(STORE, {
      taskId: legacyTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'the root created before contracts existed',
      depth: 0,
      acceptanceCriteria: [{
        criterionId: 'legacy-composite',
        description: 'all mandatory children verified',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
      }],
      requestedCapabilities: [],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, legacyTaskId, 'tester', { decompositionStatus: 'decomposable' })
    await h.task.startRunIn(STORE, {
      runId: legacyRunId,
      taskId: legacyTaskId,
      sessionId: ROOT_SESSION,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      executionPhase: 'active',
      startedAt: new Date().toISOString(),
    }, 'tester')

    const batch = await h.runtime.decomposeAndRun(STORE, legacyTaskId, legacyRunId, ROOT_SESSION, {
      reason: 'the legacy parent splits',
      children: [{
        objective: 'the child of a task that carries no contract', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'legacy-child-1', description: 'the child holds', command: 'true' }],
      }],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // The batch end gave the legacy parent back its own execution (K1 §2): its
    // verdict is its own submission's, and the missing contract is still missing.
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the legacy root hands in its result' })
    const snapshot = await h.task.snapshotIn(STORE)
    const legacy = snapshot.tasks.find(item => item.taskId === legacyTaskId)!
    expect(legacy.status).toBe('verified')
    expect(legacy.contract).toBeUndefined()
    expect(payloadOf(h, 'TaskCreated', legacyTaskId)?.task.contract).toBeUndefined()
    // No handoff was ever recorded for it: a handoff belongs to a delegated
    // child, and this task is the delegating side.
    const child = taskWithObjective(snapshot, 'the child of a task that carries no contract')
    expect(snapshot.handoffs.map(handoff => handoff.childTaskId)).toEqual([child.taskId])
    // Its children are ordinary contracted children: a legacy parent changes
    // nothing about what the runtime writes for what it creates.
    expect(child.contract?.contractVersion).toBe(1)
  })
})

describe('T1-E: a declared field cannot widen the admission context or touch the parent', () => {
  const NARROWED: Partial<Config> = {
    maxDepth: 3,
    maxChildren: 2,
    budget: { maxToolCalls: 150, attempts: 1 },
  }

  it('records the configured limits as the batch context and leaves the parent untouched', async () => {
    const h = await generation(sessionMemory(), { config: NARROWED })
    const root = await createRoot(h, 'the root admitted under the narrowed configuration')
    const parentBefore = await h.task.taskIn(root.storeId, root.taskId)
    expect(parentBefore.contract).toBeDefined()

    const objectives = ['the first child under the narrowed limits', 'the second child under the narrowed limits']
    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, root.session, {
      reason: 'split under the narrowed limits',
      children: [
        {
          objective: objectives[0]!, requiredCapabilities: ['execute-task'],
          acceptanceCriteria: [{ criterionId: 'narrowed-1', description: 'the first child holds', command: 'true' }],
        },
        {
          objective: objectives[1]!, requiredCapabilities: ['execute-task'],
          acceptanceCriteria: [{ criterionId: 'narrowed-2', description: 'the second child holds', command: 'true' }],
        },
      ],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])

    const admission = payloadOf(h, 'TaskDecomposed', root.taskId)!.admission!
    expect(admission.context).toEqual({
      maxDepth: 3,
      maxChildren: 2,
      auditOnly: { maxToolCalls: 150, attempts: 1 },
    })
    // This deployment configures no token ceiling, so none is recorded.
    expect(admission.context.auditOnly).not.toHaveProperty('tokens')

    // The batch identity covers the children that were actually admitted: the
    // digest recomputed from the stored contracts is the one recorded.
    const snapshot = await h.task.snapshotIn(root.storeId)
    expect(admission.proposalDigest).toBe(decompositionDigest({
      contractVersion: 1,
      storeId: root.storeId,
      parentTaskId: root.taskId,
      parentRunId: root.runId,
      callerSessionId: root.session,
      reason: 'split under the narrowed limits',
      children: objectives.map(objective => {
        const child = taskWithObjective(snapshot, objective)
        return {
          contractDigest: contractDigest(child.contract!),
          dependsOn: [],
          decomposable: child.decompositionStatus === 'decomposable',
          requiresIndependentAcceptance: false,
        }
      }),
    }))

    // The batch is the only thing that changed on the parent: its objective,
    // its criteria and its contract are the ones it was admitted with — and its
    // verdict is its own submission's (K1 §2), never the batch's.
    await h.runtime.submitResult(root.session, { summary: 'the root hands in the result its batch produced' })
    const parentAfter = await h.task.taskIn(root.storeId, root.taskId)
    expect(parentAfter.objective).toBe(parentBefore.objective)
    expect(parentAfter.acceptanceCriteria).toEqual(parentBefore.acceptanceCriteria)
    expect(parentAfter.contract).toEqual(parentBefore.contract)
    expect(parentAfter.decompositionStatus).toBe('decomposed')
    expect(parentAfter.status).toBe('verified')
  })

  it.each(['budget', 'maxDepth', 'maxChildren'] as const)('refuses a child declaring %s and persists nothing', async field => {
    const h = await generation(sessionMemory(), { config: NARROWED })
    const root = await createRoot(h, 'the root a child tries to widen the limits for')
    const eventsBefore = taskEvents(h).length

    const refusal = await refusalOfRuntime(h, {
      reason: 'try to widen the limits',
      children: [{
        ...validChild(),
        [field]: field === 'budget' ? { wallTimeMs: 999_999 } : 99,
      }],
    }, root)

    expect(refusal).toContain(`child 0 declares unknown field "${field}"`)
    expect(taskEvents(h)).toHaveLength(eventsBefore)
    expect(h.spawned).toHaveLength(0)
    expect((await h.task.snapshotIn(root.storeId)).tasks.map(item => item.taskId)).toEqual([root.taskId])
    expect(payloadOf(h, 'TaskDecomposed', root.taskId)).toBeUndefined()
  })
})
