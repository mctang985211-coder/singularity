import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import { createScope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionStore, { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rootTaskStoreId, TaskService } from '../../task/src/index.ts'
import type { RunProviderBinding, TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import type { VerifyRunOptions } from '../../verifier/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import type { CapabilityConfig, Config, DecomposeSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

/**
 * A3 acceptance on a real restart: a deployment whose stores live in the real
 * JSONL session log is booted, driven to a crash point, abandoned, and booted
 * again over the same directory.
 *
 * What is real: `session-persistence-jsonl` and the bytes it writes (the store
 * the second boot reads is the first boot's artifact, not a shared object), the
 * real `TaskService` and its reducer, the real `TaskRuntime` entries (decompose,
 * submit, reconcile, awaitBatch), the real `VerifierRegistry`, the real
 * `AgentRuntime` spawn path, and the real `task_read` tool for the read side.
 *
 * What is replaced, and why:
 * - the model loop — a stub agent factory mints an agent whose `whenIdle` runs a
 *   scripted worker body and then hands its run in, exactly the hook run-stack
 *   uses. Recovery is about the store and the phases, not about turns.
 * - **the checkout** — this deployment resolves no env, so every run is
 *   `unbound` (§3.4's own case): `WorkspaceRegistry.reconcileAdopt` refuses a
 *   marker that names *this* process's pid, which two boots inside one test
 *   process cannot avoid, and the spec would then be asserting that artifact
 *   rather than recovery. Ownership has its own spec in `a3-workspace.spec.ts`.
 *
 * **Crash semantics.** `session-persistence-jsonl` writes each append through to
 * disk before `append` resolves. Probed on this fixture's shape (`compression:
 * 'none'`): after `await handle.append([…])` the artifact
 * `<dir>/_no-cwd/sg-t-s-root/session.v3.jsonl` already held the header line and the
 * event line — no flush was needed — and a second write-open of the same session
 * while the first handle was live threw `SessionAlreadyOwnedError` (the backend's
 * `flock`). A dying process closes its descriptors and releases that lock, so
 * {@link Boot.crash} does exactly that: the service's durability barrier
 * (`flush()`, the seam's own promise) and then `close()` on every handle the store
 * opened. The first context is *not* disposed: its drivers stay parked on promises
 * that will never settle, which is the state a killed process leaves behind and the
 * reason a second boot has to recover from the log rather than from memory.
 *
 * **Evidence that the recovery cases are decisive (2026-09-22).** With the batch
 * restart temporarily removed from `reconcileStore` (recovery settling what it can
 * and never restarting an admitted batch), cases (a) and (d) fail — the child of
 * case (a) is never started and the batch reports `['failed']` instead of
 * `['verified']`, and the parent of case (d) stays `running`. The temporary edit
 * was reverted immediately (md5 re-checked against a copy taken before it).
 */

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)
/** A capability row with a guidance skill, so a bound run materializes a snapshot case (f) can tamper with. */
const SKILL_ROW = 'recovery-row'
const SKILL_NAME = 'recovery-fixture-skill'

/** A latch that never resolves: the run stays inside its verifier call until the process dies. */
const never = (): Promise<void> => new Promise(() => {})

/** One child spec: a goal and a criterion a command settles. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/**
 * Write one terminal champion task straight into the store — the record a replay
 * descends from — through the store's own service, so the replay's subject is the
 * historical shape and not a fixture invention. The caller creates the store: a
 * case that already ran `createRootTask` must not try to create it twice.
 */
async function writeChampion(boot: Boot): Promise<string> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await boot.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, ROOT)
  await boot.task.admitTaskIn(STORE, taskId, ROOT, { decompositionStatus: 'leaf' })
  await boot.task.startRunIn(STORE, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, ROOT)
  await boot.task.markRunStatusIn(STORE, taskId, runId, 'verifying', ROOT)
  await boot.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, ROOT)
  await boot.task.markRunStatusIn(STORE, taskId, runId, 'verified', ROOT)
  return taskId
}

/** A spawn the runtime handed the agent runtime, in order. */
interface SpawnRecord {
  readonly sessionId: string
  readonly name: string
}

/** What one stub worker does when its agent goes idle. */
type WorkerBody = (sessionId: string) => Promise<void> | void

interface BootOptions {
  /** A worker body that never returns parks the batch driver with the child in flight (crash point b). */
  readonly worker?: WorkerBody
  /**
   * Park one session's write drain on a managed job that never confirms stopped:
   * the phase change is already durable, the settlement is frozen exactly where a
   * killed process would leave it, and no timer is involved. The index is that
   * session's own drain count, so a case can park the *first* drain (the batch
   * admission, before any child) or a later one (a settlement).
   */
  readonly parkDrain?: (sessionId: string, drainIndex: number) => boolean
  /**
   * A latch one verification waits on before it runs at all: the run sits inside a
   * verifier call (its `TaskVerifying` committed) for as long as the latch is
   * unresolved, which is the crash point `parkDrain` cannot express and the state a
   * cancellation has to arrive in. Returning `undefined` leaves that call ungated.
   */
  readonly gateVerification?: (callIndex: number, runId: string) => Promise<void> | undefined
  /**
   * A latch one verification waits on *after* it has finished — evidence recorded,
   * verdict not yet written. That window is the one a cancellation can land in
   * without the verifier noticing, so it is where the verdict has to be voided.
   */
  readonly gateVerdict?: (callIndex: number, runId: string) => Promise<void> | undefined
  readonly capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** The tree-wide root budget this deployment runs under (`Config.rootBudget`); absent means it sets none. */
  readonly rootBudget?: Readonly<{ wallTimeMs?: number; maxRuns?: number; maxConcurrentWrites?: number }>
}

interface Boot {
  readonly ctx: Context
  readonly task: TaskService
  readonly runtime: TaskRuntime
  /** Every spawn this boot's runtime asked for. */
  readonly spawns: SpawnRecord[]
  /** The store's snapshot as the store itself holds it. */
  snapshot(storeId?: string): Promise<TaskSnapshot>
  /** The store's own event log, read back from the JSONL backend as a reader. */
  events(storeId?: string): Promise<readonly SessionEvent[]>
  /** Simulate process death: the durability barrier, then close every handle this boot opened. */
  crash(): Promise<void>
  dispose(): Promise<void>
}

/** The stacks a spec must dispose: every boot whose context is still alive, and every workspace to remove. */
const live: Boot[] = []
const directories: string[] = []

afterEach(async () => {
  for (const boot of live.splice(0)) {
    // A boot whose drivers are parked on promises that will never settle cannot
    // be disposed; the wait is bounded so a failing case reports its assertion
    // instead of a hung teardown.
    await Promise.race([boot.dispose(), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** One tmp directory holding a deployment's whole world: session log, evidence, run bindings. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-a3-recovery-'))
  directories.push(dir)
  return dir
}

/** Write one guidance skill where the pre-check's discovery finds it (`$DSH_HOME/skills/<name>/SKILL.md`). */
function installSkill(home: string, name = SKILL_NAME): void {
  const directory = join(home, 'skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} fixture skill\n---\n\nDo the recovery fixture work.\n`, 'utf8')
}

/**
 * Boot one deployment over one directory. Everything the deployment's loader
 * mounts is mounted here the same way, except the agent loop.
 */
async function boot(dir: string, options: BootOptions = {}): Promise<Boot> {
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  const ctx = new Context()
  const persistence = new JsonlSessionPersistence(ctx, { root: dir, compression: 'none' })
  // Every handle the store takes, so `crash()` can close exactly what a dying
  // process's descriptors would release.
  const handles: { close: () => Promise<void> }[] = []
  const backend = persistence as unknown as {
    create: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    flush: () => Promise<void>
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

  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  // A worker whose run bound content registers it into its own skill layer, so
  // the deployment's skill registry is part of this plane.
  await ctx.plugin(SkillRegistry, {})
  // The deployment's tool plane: stand-ins for every name the root's own
  // allow-list and a worker's grant resolve against, and the real `task_read`
  // for the read side this spec asserts on.
  for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
    if (name === 'task_read') continue
    ctx.tools.register({
      name,
      description: `tool ${name}`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
      execute: async () => `${name}: fixture answer`,
    })
  }
  ctx.tools.register(defineTaskReadTool(ctx))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
  ctx.provide('layout', { setIn: async () => {} })
  const graphState = {
    version: 1,
    id: 'g1',
    roots: [ROOT],
    agents: [] as { id: string; name: string; status: string }[],
    groups: [] as unknown[],
    edges: [] as unknown[],
  }
  ctx.provide('graph', {
    snapshotIn: async () => structuredClone(graphState),
    commitIn: async (_storeId: string, events: readonly { kind: string; agent?: { id: string; name: string; status: string }; edge?: unknown }[]) => {
      for (const event of events) {
        if (event.kind === 'agent/add' && event.agent !== undefined) graphState.agents.push(event.agent)
        if (event.kind === 'edge/add' && event.edge !== undefined) graphState.edges.push(event.edge)
      }
    },
    setStatusIn: async () => {},
    addAgentIn: async (_storeId: string, agent: { id: string; name: string; status: string }) => { graphState.agents.push(agent) },
  } as never)
  ctx.provide('graphs', {
    graphForSession: async () => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }),
  } as never)
  if (options.parkDrain !== undefined) {
    // The drain's one awaited jobs call never returns, so the drain — and the
    // settlement behind it — is frozen without a timer. `list` is synchronous by
    // the seam's contract; the live entry it returns is what makes the drain
    // call `wait`.
    const drains = new Map<string, number>()
    ctx.provide('jobs', {
      list: (agent: { id?: string } | undefined) => {
        const id = agent?.id
        if (id === undefined) return []
        const index = (drains.get(id) ?? 0) + 1
        drains.set(id, index)
        return options.parkDrain!(id, index) ? [{ id: `frozen-drain-${id}`, status: 'running' }] : []
      },
      kill: () => undefined,
      wait: () => new Promise(() => {}),
    } as never)
  }

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(dir, 'evidence') })
  await verifier.ready()
  const gateFor = options.gateVerification ?? (() => undefined)
  const verdictGateFor = options.gateVerdict ?? (() => undefined)
  const realVerify = verifier.verifyRun.bind(verifier)
  let verifyCalls = 0
  verifier.verifyRun = async (storeId: string, runId: string, verifyOptions?: VerifyRunOptions) => {
    const callIndex = verifyCalls++
    const before = gateFor(callIndex, runId)
    if (before !== undefined) await before
    const bundle = await realVerify(storeId, runId, verifyOptions)
    const after = verdictGateFor(callIndex, runId)
    if (after !== undefined) await after
    return bundle
  }

  const spawns: SpawnRecord[] = []
  const agentRuntime = new AgentRuntime(ctx)
  const runtime = await mountRuntime(ctx, options)
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, opts: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.sessionId, opts.setup), dispose: async () => {} }),
    resume: async (_ownerCtx: Context, opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.resumeSessionId, opts.setup), dispose: async () => {} }),
  } as never)

  /** Hand one stub agent to the runtime: the scope, the setup hook, and the idle body. */
  async function mint(sessionId: SessionId, setup?: (agentCtx: Context, agent: Agent) => Promise<unknown>): Promise<Agent> {
    let self!: Agent
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      // A worker body that returns without submitting leaves the run `active`
      // where a submission was due, which is the no-progress path; a body that
      // never returns parks the driver with the child in flight.
      whenIdle: async () => { await runWorkerTurn(String(sessionId), self) },
      session: { id: String(sessionId), header: { id: String(sessionId), cwd: dir, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    self = agent
    let scope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    return agent
  }

  async function runWorkerTurn(sessionId: string, agent: Agent): Promise<void> {
    const record = agent as unknown as { status?: string }
    record.status = 'running'
    try {
      await options.worker?.(sessionId)
    } finally {
      record.status = 'idle'
    }
    const { run } = await runtime.runForSession(sessionId)
    if (run.status !== 'running' || run.executionPhase !== 'active') return
    await runtime.submitResult(sessionId, { summary: 'recovery fixture worker finished' })
  }

  const originalSpawn = agentRuntime.spawn.bind(agentRuntime)
  agentRuntime.spawn = async (parent: Agent, request: SpawnRequest) => {
    spawns.push({ sessionId: String(request.sessionId), name: request.name })
    return await originalSpawn(parent, request)
  }
  // The deployment's root session, created the way a graph entry creates one.
  await agentRuntime.createRoot({ sessionId: SessionId(ROOT), scope: { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }, cwd: dir })

  const boot: Boot = {
    ctx,
    task,
    runtime,
    spawns,
    snapshot: async (storeId = STORE) => await task.snapshotIn(storeId),
    events: async (storeId = STORE) => {
      const handle = await (persistence as unknown as { open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }> }).open(SessionId(storeId), 'read')
      try {
        return (await handle.read()).events
      } finally {
        await handle.close()
      }
    },
    crash: async () => {
      // A crashed process has nothing left to dispose: its drivers are parked on
      // promises that will never settle, and the boot leaves this list with the
      // descriptors it closed.
      const index = live.indexOf(boot)
      if (index >= 0) live.splice(index, 1)
      await backend.flush()
      for (const handle of handles.splice(0)) await handle.close()
    },
    dispose: async () => {
      const index = live.indexOf(boot)
      if (index >= 0) live.splice(index, 1)
      await ctx.fiber.dispose()
    },
  }
  live.push(boot)
  return boot
}

/** Mount the runtime the way the deployment's loader does, so `[Service.init]` wires the gate. */
async function mountRuntime(ctx: Context, options: BootOptions): Promise<TaskRuntime> {
  await ctx.plugin(TaskRuntime, {
    capabilities: { ...(options.capabilities ?? {}) },
    ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
    runBindingRoot: join(process.env.DSH_HOME ?? '.', 'run-bindings'),
  } as Config)
  return ctx.get('taskRuntime') as TaskRuntime
}

/** Every task event one store appended, filtered out of its session log. */
function taskEvents(events: readonly SessionEvent[]): TaskEvent[] {
  return events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The one run that is not the root's, in a store with one child. */
function childRunOf(snapshot: TaskSnapshot, rootTaskId: string): TaskSnapshot['runs'][number] {
  const run = snapshot.runs.find(candidate => candidate.taskId !== rootTaskId)
  if (run === undefined) throw new Error('the store holds no child run')
  return run
}

describe('A3 recovery from the real session log', () => {
  it('resumes an admitted batch whose first child never started, without paying for the root twice', async () => {
    const dir = workspace()
    // The root's first drain is the batch's admission drain: the atomic commit is
    // durable, the driver is frozen behind it, and no child has been started.
    const a = await boot(dir, { parkDrain: (sessionId, index) => sessionId === ROOT && index === 1 })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('first child'),
    })

    // The crash point: the batch is admitted (parent waiting_children, child
    // created) and the driver is frozen in its admission drain, so the child has
    // no run and no worker.
    const before = await a.snapshot()
    expect(before.runs).toHaveLength(1)
    expect(before.tasks).toHaveLength(2)
    expect(before.runs[0]!.status).toBe('running')
    expect(before.runs[0]!.executionPhase).toBe('waiting_children')
    expect(before.runs[0]!.batchId).toBe(batchId)
    expect(before.reviews).toHaveLength(0)
    expect(a.spawns).toHaveLength(0)
    await a.crash()

    const b = await boot(dir)
    const opened = await b.task.openStore(STORE)
    expect(opened.runs).toHaveLength(1)
    await b.runtime.reconcileStore(STORE)

    // The batch is driven to its end by the second process: one child, started
    // exactly once (the first process never started it), verified by the real
    // verifier, and the parent accepted by its composite criterion.
    const outcomes = await b.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(b.spawns).toHaveLength(1)
    const after = await b.snapshot()
    expect(after.runs).toHaveLength(2)
    const child = childRunOf(after, root.taskId)
    expect(child.taskId).toBe(childTaskIds[0])
    expect(child.status).toBe('verified')
    expect(child.executionPhase).toBe('submitted')
    expect(after.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('verified')
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('verified')
    // The root run was started once, in the first process: the budget is not
    // refunded by a restart, and no second root run appears.
    expect(after.runs.filter(run => run.taskId === root.taskId)).toHaveLength(1)
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === root.taskId)).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === childTaskIds[0])).toHaveLength(1)
    await b.dispose()
  })

  it('cancels a worker that was in flight when the process died, and settles its batch by the rules', async () => {
    const dir = workspace()
    const a = await boot(dir, { worker: () => new Promise<void>(() => {}) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('long child'),
    })
    // The crash point: the child is spawned and mid-turn, never submitted.
    await vi.waitFor(async () => expect((await a.snapshot()).runs).toHaveLength(2))
    const crashedRun = childRunOf(await a.snapshot(), root.taskId)
    expect(crashedRun.executionPhase).toBe('active')
    expect(a.spawns).toHaveLength(1)
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The in-flight worker is cancelled by name — nothing can confirm the writes
    // it may already have made — and the batch is settled by its own rules: a
    // child that did not verify cannot be accepted.
    const outcomes = await b.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const after = await b.snapshot()
    const cancelled = after.runs.find(run => run.runId === crashedRun.runId)!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.runId).toBe(crashedRun.runId)
    const cancelledReview = after.reviews.find(review => review.runId === crashedRun.runId)!
    expect(cancelledReview.outcome).toBe('cancelled')
    expect(cancelledReview.anomalies.join(' ')).toContain('was in flight when this store was reopened and never submitted')
    expect(after.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('cancelled')
    // The parent is judged, not silently accepted: its composite criterion needs
    // a verified child, and this one is not.
    const parent = await b.task.runIn(STORE, root.runId)
    expect(parent.status).toBe('failed')
    expect(after.reviews.find(review => review.runId === root.runId)?.outcome).toBe('failed')
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('failed')
    // Recovery started nothing: the child that existed is the child that was
    // settled, and no second run was charged to the tree.
    expect(b.spawns).toHaveLength(0)
    expect(after.runs).toHaveLength(2)
    await b.dispose()
  })

  it('verifies a run that submitted before the crash, without starting or charging it again', async () => {
    const dir = workspace()
    // The worker's own drain is the one its submission runs: the phase change is
    // durable, the settlement is frozen behind it, and no verdict exists.
    const a = await boot(dir, { parkDrain: sessionId => sessionId !== ROOT })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('submitted child'),
    })
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      const run = snapshot.runs.find(candidate => candidate.taskId === childTaskIds[0])
      expect(run?.executionPhase).toBe('submitted')
    })
    const crashed = childRunOf(await a.snapshot(), root.taskId)
    // An A3 run keeps `running` through verification — the phase is the record
    // that it handed in, and `TaskVerifying` moves the task, not the run.
    expect(crashed.status).toBe('running')
    expect(crashed.executionPhase).toBe('submitted')
    expect(crashed.submission?.origin).toBe('worker')
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    const outcomes = await b.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const after = await b.snapshot()
    // The same run, the same submission, one verdict: the recovery continued the
    // run rather than re-running it.
    const verified = after.runs.find(run => run.runId === crashed.runId)!
    expect(verified.status).toBe('verified')
    expect(verified.submission?.summary).toBe('recovery fixture worker finished')
    expect(after.runs).toHaveLength(2)
    expect(after.runs.filter(run => run.taskId === childTaskIds[0])).toHaveLength(1)
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(1)
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('verified')
    expect(b.spawns).toHaveLength(0)
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'RunPhaseChanged' && event.runId === crashed.runId && event.payload.phase === 'submitted')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === childTaskIds[0])).toHaveLength(1)
    await b.dispose()
  })

  it('accepts a parent whose children are all terminal when the crash interrupted its own acceptance', async () => {
    const dir = workspace()
    // The root's first drain is its batch's admission; the second is the
    // settlement drain its acceptance runs behind. Freezing there lands the crash
    // exactly between "every child is terminal" and the parent's verdict, with the
    // children's own verifications untouched.
    const a = await boot(dir, { parkDrain: (sessionId, index) => sessionId === ROOT && index === 2 })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('terminal child'),
    })
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.runs.find(run => run.taskId === childTaskIds[0])?.status).toBe('verified')
      // The parent's own settlement drain is frozen, so its acceptance has not
      // run: the children are all terminal and the parent run is still waiting.
      expect(snapshot.runs.find(run => run.runId === root.runId)?.executionPhase).toBe('waiting_children')
    })
    const crashed = await a.snapshot()
    expect(crashed.runs.find(run => run.runId === root.runId)!.status).toBe('running')
    expect(crashed.runs.find(run => run.runId === root.runId)!.executionPhase).toBe('waiting_children')
    expect(crashed.reviews.filter(review => review.runId === root.runId)).toHaveLength(0)
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The restarted batch adopts its terminal children and runs the parent's
    // acceptance: it is judged by the real verifier, with no new run and no new
    // spawn, and the batch identity is the one the first process admitted.
    expect((await b.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    const after = await b.snapshot()
    expect(after.runs.find(run => run.runId === root.runId)!.status).toBe('verified')
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('verified')
    const review = after.reviews.find(item => item.runId === root.runId)!
    expect(review.outcome).toBe('verified')
    expect(review.criteria?.every(criterion => criterion.verdict === 'pass')).toBe(true)
    expect(after.runs).toHaveLength(2)
    expect(after.runs.find(run => run.runId === root.runId)!.batchId).toBe(batchId)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('leaves a run that predates coordination phases exactly as it is, and refuses to build on it', async () => {
    const dir = workspace()
    const a = await boot(dir)
    // A record from before A3: written through the store's own service, with no
    // execution phase at all and no runtime involved. The child is the run the
    // read side renders; the root is the run admission refuses to build on.
    await a.task.createStore(STORE)
    await a.task.createTaskIn(STORE, {
      taskId: 't-old-root',
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'an old root record',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'composite', requiredEvidence: [], mandatory: true }],
      requestedCapabilities: [],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT)
    await a.task.admitTaskIn(STORE, 't-old-root', ROOT, { decompositionStatus: 'decomposable' })
    await a.task.startRunIn(STORE, {
      runId: 'r-old-root',
      taskId: 't-old-root',
      sessionId: ROOT,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT)
    await a.task.createTaskIn(STORE, {
      taskId: 't-old-child',
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: 't-old-root',
      objective: 'an old child record',
      depth: 1,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT)
    await a.task.admitTaskIn(STORE, 't-old-child', ROOT, { decompositionStatus: 'leaf' })
    await a.task.startRunIn(STORE, {
      runId: 'r-old-child',
      taskId: 't-old-child',
      sessionId: 's-old-child',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT)
    const written = taskEvents(await a.events()).length
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // Nothing was invented for either record: no phase, no terminal state, no
    // review, no evidence, and no run started on their behalf.
    const after = await b.snapshot()
    for (const runId of ['r-old-root', 'r-old-child']) {
      const run = after.runs.find(candidate => candidate.runId === runId)!
      expect(run.status).toBe('running')
      expect(run.executionPhase).toBeUndefined()
    }
    expect(after.reviews).toHaveLength(0)
    expect(after.evidence).toHaveLength(0)
    expect(after.tasks.map(task => task.status)).toEqual(['running', 'running'])
    expect(b.spawns).toHaveLength(0)
    expect(taskEvents(await b.events())).toHaveLength(written)

    // The read side derives needs-recovery from the missing phase, through the
    // real tool: the root session's view renders the child run.
    const answer = await b.ctx.tools.execute({
      callId: 'call-old-record',
      name: 'task_read',
      arguments: {},
      agent: { id: ROOT } as never,
      signal: new AbortController().signal,
    })
    const text = answer.content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
    expect(answer.isError).toBeFalsy()
    expect(text).toContain('r-old-child [running] — needs-recovery')
    expect(text).toContain('cannot decompose, submit or verify')

    // And its only legal continuation is cancellation: both continuations are
    // refused by name, with nothing written.
    await expect(b.runtime.decomposeAndRun(STORE, 't-old-root', 'r-old-root', ROOT, {
      reason: 'split the old record',
      children: children('child of an old record'),
    })).rejects.toThrow(/predates coordination phases/)
    await expect(b.runtime.submitResult('s-old-child', { summary: 'old work' })).rejects.toThrow(/predates coordination phases/)
    const unchanged = await b.snapshot()
    expect(unchanged.tasks).toHaveLength(2)
    expect(unchanged.runs).toHaveLength(2)
    expect(unchanged.runs.every(run => run.status === 'running')).toBe(true)
    expect(taskEvents(await b.events())).toHaveLength(written)
    await b.dispose()
  })

  it('refuses to continue a run whose bound content no longer reads back, instead of falling back', async () => {
    const dir = workspace()
    installSkill(join(dir, 'home'))
    const a = await boot(dir, {
      capabilities: { [SKILL_ROW]: { skills: [SKILL_NAME] } },
      // The worker's own drain is the one its submission runs.
      parkDrain: sessionId => sessionId !== ROOT,
    })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: [{ ...children('bound child')[0]!, requiredCapabilities: [SKILL_ROW] }],
    })
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      const run = snapshot.runs.find(candidate => candidate.taskId === childTaskIds[0])
      expect(run?.status).toBe('running')
      expect(run?.executionPhase).toBe('submitted')
    })
    const crashed = childRunOf(await a.snapshot(), root.taskId)
    const binding = crashed.providerBinding as RunProviderBinding
    expect(binding.snapshotRoot).toBeDefined()
    const snapshotRoot = binding.snapshotRoot as string
    // The bytes the run was bound to are gone.
    rmSync(snapshotRoot, { recursive: true, force: true })
    await a.crash()

    const b = await boot(dir, { capabilities: { [SKILL_ROW]: { skills: [SKILL_NAME] } } })
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The batch settles on the refused run rather than continuing past it.
    expect((await b.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['failed'])
    const after = await b.snapshot()
    const failed = after.runs.find(run => run.runId === crashed.runId)!
    expect(failed.status).toBe('failed')
    const review = after.reviews.find(item => item.runId === crashed.runId)!
    expect(review.outcome).toBe('failed')
    expect(review.localizedCause).toContain("recovery re-check rejected this run's content binding")
    expect(review.localizedCause).toContain('cannot be read')
    // Nothing fell back to the production skill path: the run was not verified,
    // no evidence was recorded for it, and the parent could not accept it.
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(0)
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('failed')
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })
})

/**
 * The crash point that lands *after* a verification started, which the cases above
 * deliberately avoid: the process died inside the verifier call, so the store holds
 * `task=verifying`, `run.executionPhase=submitted`, `run.status=running` and no
 * verdict. §3.1 makes this the recovery path's own case — the submitted phase is
 * the whole evidence — so both the interrupted worker run and the interrupted
 * parent acceptance must be completed by the second boot, with the redundant
 * `TaskVerifying` mark skipped (the reducer refuses `verifying → verifying`, and
 * the later `TaskVerified` needs the task to already be there).
 */
describe('A3 recovery: a crash inside the verification call', () => {
  it('completes a worker run whose verification was interrupted after the verifying mark', async () => {
    const dir = workspace()
    // The child's verification is the first one this deployment makes, and it
    // never returns: the phase and `TaskVerifying` are committed, and no verdict
    // exists.
    const a = await boot(dir, { gateVerification: callIndex => (callIndex === 0 ? never() : undefined) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('interrupted child'),
    })
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.tasks.find(task => task.taskId === childTaskIds[0])?.status).toBe('verifying')
    })
    const crashed = childRunOf(await a.snapshot(), root.taskId)
    expect(crashed.executionPhase).toBe('submitted')
    expect(crashed.status).toBe('running')
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The second process finishes the verification the first one started: one
    // verdict for the run, one evidence bundle, and the batch that follows from it.
    const after = await b.snapshot()
    const verified = after.runs.find(run => run.runId === crashed.runId)!
    expect(verified.status).toBe('verified')
    expect(after.reviews.filter(item => item.runId === crashed.runId)).toHaveLength(1)
    expect(after.reviews.find(item => item.runId === crashed.runId)!.outcome).toBe('verified')
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(1)
    expect(after.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('verified')
    // The recovered run is the same run: no second spawn, no second run, and the
    // verification mark stays written once.
    expect(b.spawns).toHaveLength(0)
    expect(after.runs).toHaveLength(2)
    expect(after.runs.filter(run => run.taskId === childTaskIds[0])).toHaveLength(1)
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskVerifying' && event.taskId === childTaskIds[0])).toHaveLength(1)
    await b.dispose()
  })

  it('completes a parent acceptance whose verification was interrupted after the verifying mark', async () => {
    const dir = workspace()
    // The child verifies normally (the first call); the parent's own acceptance is
    // the second, and it never returns — the crash lands after every child is
    // terminal and after the parent's own `TaskVerifying`.
    const a = await boot(dir, { gateVerification: callIndex => (callIndex === 1 ? never() : undefined) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('interrupted parent'),
    })
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.tasks.find(task => task.taskId === root.taskId)?.status).toBe('verifying')
    })
    const crashed = await a.snapshot()
    const parent = crashed.runs.find(run => run.runId === root.runId)!
    expect(crashed.runs.find(run => run.taskId === childTaskIds[0])?.status).toBe('verified')
    expect(parent.executionPhase).toBe('submitted')
    expect(parent.status).toBe('running')
    expect(crashed.reviews.filter(review => review.runId === root.runId)).toHaveLength(0)
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The acceptance finishes in the second process: the composite criterion sees
    // its verified child and the parent settles verified.
    const after = await b.snapshot()
    expect(after.runs.find(run => run.runId === root.runId)!.status).toBe('verified')
    expect(after.tasks.find(task => task.taskId === root.taskId)!.status).toBe('verified')
    const review = after.reviews.find(item => item.runId === root.runId)!
    expect(review.outcome).toBe('verified')
    expect(review.criteria?.every(criterion => criterion.verdict === 'pass')).toBe(true)
    // The same run and the same batch, accepted once: no new run, no new spawn, and
    // the verifying mark stays written once for the parent.
    expect(b.spawns).toHaveLength(0)
    expect(after.runs).toHaveLength(2)
    expect(after.runs.find(run => run.runId === root.runId)!.batchId).toBe(batchId)
    expect((await b.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskVerifying' && event.taskId === root.taskId)).toHaveLength(1)
    await b.dispose()
  })

  it('completes a criteria replay whose verification was interrupted after the verifying mark', async () => {
    const dir = workspace()
    // A replay with no worker is born `submitted` (origin `runtime`) and goes
    // straight to the verifier — the same settlement entry as every other
    // submission, and the first verification this deployment makes.
    const a = await boot(dir, { gateVerification: callIndex => (callIndex === 0 ? never() : undefined) })
    await a.task.createStore(STORE)
    const championTaskId = await writeChampion(a)
    // The call never returns (its verifier hangs), so it is not awaited: the
    // store's own state is what this case reads.
    const replaying = a.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p1', spawn: false }, ROOT)
    replaying.catch(() => {})
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.tasks.find(task => task.taskId !== championTaskId)?.status).toBe('verifying')
    })
    const crashed = (await a.snapshot()).runs.find(run => run.taskId !== championTaskId)!
    expect(crashed.executionPhase).toBe('submitted')
    expect(crashed.status).toBe('running')
    expect(a.spawns).toHaveLength(0)
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    // The recovered replay is judged by the same verifier the interrupted one was
    // waiting on: one verdict, one evidence bundle, and no worker anywhere.
    const after = await b.snapshot()
    const verified = after.runs.find(run => run.runId === crashed.runId)!
    expect(verified.status).toBe('verified')
    expect(after.tasks.find(task => task.taskId === crashed.taskId)!.status).toBe('verified')
    expect(after.reviews.find(item => item.runId === crashed.runId)!.outcome).toBe('verified')
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskVerifying' && event.taskId === crashed.taskId)).toHaveLength(1)
    await b.dispose()
  })
})

/**
 * A cancellation that lands *while* a verifier call is in flight: the run's phase
 * says `submitted`, the task says `verifying`, and the run's own status is still
 * `running` — so both the cancellation entry and the verdict must agree on who
 * wins. The second boot resumes the interrupted verification and cancels it
 * there, because `cancelGraph` (the entry `graphs.remove` calls,
 * `graphs/src/index.ts:313`) waits for this process's own drivers before it
 * settles the runs that are still in flight.
 */
describe('A3: a cancellation during verification', () => {
  it('cancels a run whose verification finished but whose verdict was not written, and voids that verdict', async () => {
    const dir = workspace()
    // The first boot dies inside the child's verification: `task=verifying`,
    // `phase=submitted`, and the verifier call never returns.
    const a = await boot(dir, { gateVerification: callIndex => (callIndex === 0 ? never() : undefined) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { batchId, childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('cancelled while verifying'),
    })
    await vi.waitFor(async () => {
      expect((await a.snapshot()).tasks.find(task => task.taskId === childTaskIds[0])?.status).toBe('verifying')
    })
    const crashed = childRunOf(await a.snapshot(), root.taskId)
    await a.crash()

    // The second boot resumes that verification, which now finishes — evidence and
    // all — and is held just before its verdict is written. That is the window a
    // cancellation can land in without the verifier noticing.
    const verdictPending = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const b = await boot(dir, {
      gateVerdict: callIndex => {
        if (callIndex !== 0) return undefined
        verdictPending.resolve()
        return release.promise
      },
    })
    await b.task.openStore(STORE)
    const recovering = b.runtime.reconcileStore(STORE)
    recovering.catch(() => {})
    await verdictPending.promise
    expect((await b.snapshot()).evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(1)

    // The graph removal hook's own entry (`graphs/src/index.ts:313`) cancels the
    // tree while the run is being verified.
    await b.runtime.cancelGraph(STORE, 'graph removed')
    const cancelled = await b.snapshot()
    expect(cancelled.runs.find(run => run.runId === crashed.runId)!.status).toBe('cancelled')
    expect(cancelled.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('cancelled')
    expect((await b.task.runIn(STORE, root.runId)).status).toBe('cancelled')
    expect(cancelled.reviews.filter(item => item.runId === crashed.runId).map(item => item.outcome)).toEqual(['cancelled'])

    // The verdict now arrives: cancellation wins, nothing is written twice, and
    // the recovery pass reports no failure of its own.
    release.resolve()
    await expect(recovering).resolves.toBeUndefined()
    const after = await b.snapshot()
    expect(after.runs.find(run => run.runId === crashed.runId)!.status).toBe('cancelled')
    expect(after.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('cancelled')
    // One review only — the cancellation's — while the verdict's evidence stays on
    // the record: voided, not erased.
    expect(after.reviews.filter(item => item.runId === crashed.runId).map(item => item.outcome)).toEqual(['cancelled'])
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(1)
    // The batch's identity is untouched and no worker was started anywhere.
    expect(after.runs.find(run => run.runId === root.runId)!.batchId).toBe(batchId)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('refuses the evidence a cancelled run\'s late verifier tries to record', async () => {
    const dir = workspace()
    const a = await boot(dir, { gateVerification: callIndex => (callIndex === 0 ? never() : undefined) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const { childTaskIds } = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: children('cancelled before verifying'),
    })
    await vi.waitFor(async () => {
      expect((await a.snapshot()).tasks.find(task => task.taskId === childTaskIds[0])?.status).toBe('verifying')
    })
    const crashed = childRunOf(await a.snapshot(), root.taskId)
    await a.crash()

    // The resumed verification is held before it runs: when the cancellation
    // lands, the verifier has produced no evidence yet, and the run is already
    // settled by the time it tries to.
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const b = await boot(dir, {
      gateVerification: callIndex => {
        if (callIndex !== 0) return undefined
        entered.resolve()
        return release.promise
      },
    })
    await b.task.openStore(STORE)
    const recovering = b.runtime.reconcileStore(STORE)
    recovering.catch(() => {})
    await entered.promise

    await b.runtime.cancelGraph(STORE, 'graph removed')
    release.resolve()
    await expect(recovering).resolves.toBeUndefined()
    const after = await b.snapshot()
    // The store refused the late evidence, no verdict was written, and the one
    // review on the record is the cancellation's.
    expect(after.evidence.filter(item => item.taskRunId === crashed.runId)).toHaveLength(0)
    expect(after.runs.find(run => run.runId === crashed.runId)!.status).toBe('cancelled')
    expect(after.tasks.find(task => task.taskId === childTaskIds[0])!.status).toBe('cancelled')
    expect(after.reviews.filter(item => item.runId === crashed.runId).map(item => item.outcome)).toEqual(['cancelled'])
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })
})

/**
 * A replay whose worker was in flight when the process died. Its task is
 * parentless by design (W15 keeps a comparison experiment out of the historical
 * tree), which is why the recovery pass used to read it as a root — and a root
 * legitimately sits `active` between its own decisions. The two are told apart by
 * the run's *session*, not by parentage: only a run bound to the store's root
 * session is the root's own. Both halves are asserted here, because the fix must
 * not start cancelling root runs.
 */
describe('A3 recovery: an in-flight replay is not a root', () => {
  it('cancels the replay whose worker was in flight, and leaves the root run alone', async () => {
    const dir = workspace()
    const a = await boot(dir, { worker: () => new Promise<void>(() => {}) })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const championTaskId = await writeChampion(a)
    // A spawning replay: its worker never returns, so the crash lands with the
    // replay run `active` and its session bound to a worker that no longer exists.
    const replaying = a.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p1' }, ROOT)
    replaying.catch(() => {})
    await vi.waitFor(async () => {
      const snapshot = await a.snapshot()
      expect(snapshot.runs.some(run => run.taskId !== championTaskId && run.taskId !== root.taskId && run.executionPhase === 'active' && run.status === 'running')).toBe(true)
    })
    const crashed = (await a.snapshot()).runs.find(run => run.taskId !== championTaskId && run.taskId !== root.taskId)!
    expect(a.spawns).toHaveLength(1)
    await a.crash()

    const b = await boot(dir)
    await b.task.openStore(STORE)
    await b.runtime.reconcileStore(STORE)

    const after = await b.snapshot()
    // The replay's worker is cancelled with the recovery named, not left running.
    const cancelled = after.runs.find(run => run.runId === crashed.runId)!
    expect(cancelled.status).toBe('cancelled')
    const review = after.reviews.find(item => item.runId === crashed.runId)!
    expect(review.outcome).toBe('cancelled')
    expect(review.anomalies.join(' ')).toContain('was in flight when this store was reopened and never submitted')
    expect(after.tasks.find(task => task.taskId === crashed.taskId)!.status).toBe('cancelled')
    // The root run is untouched: it is the store's own session, and it may sit
    // `active` between its own decisions.
    const rootRun = after.runs.find(run => run.runId === root.runId)!
    expect(rootRun.status).toBe('running')
    expect(rootRun.executionPhase).toBe('active')
    expect(after.reviews.filter(item => item.runId === root.runId)).toHaveLength(0)
    // Recovery started nothing: the worker that existed is the worker that was
    // cancelled.
    expect(b.spawns).toHaveLength(0)
    expect(after.runs).toHaveLength(3)
    await b.dispose()
  })
})

/**
 * The root total survives a restart as the store's own fact: a replay's run is
 * recorded like any other run, so re-opening the log counts it again and the
 * next replay is refused by the same limit rather than starting a fresh
 * allowance (§3.5: a restart does not reset the budget).
 */
describe('A3 recovery: the root budget counts a replay\u2019s run again after a restart', () => {
  it('refuses the next replay once the recorded runs have spent the shared total', async () => {
    const dir = workspace()
    const a = await boot(dir, { rootBudget: { maxRuns: 3 } })
    const root = await a.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT }, ROOT)
    const championTaskId = await writeChampion(a)
    // root run + champion run = 2 recorded; the replay takes the last slot.
    const admitted = await a.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p1', spawn: false }, ROOT)
    expect(admitted.status).toBe('verified')
    expect((await a.snapshot()).runs).toHaveLength(3)
    await a.crash()

    const b = await boot(dir, { rootBudget: { maxRuns: 3 } })
    await b.task.openStore(STORE)
    const before = await b.snapshot()
    expect(before.runs).toHaveLength(3)
    expect(before.runs.filter(run => run.taskId === root.taskId)).toHaveLength(1)

    await expect(b.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p2', spawn: false }, ROOT))
      .rejects.toThrow(/root budget allows 3 run\(s\).*already holds 3/s)
    const after = await b.snapshot()
    // The refusal persisted nothing: no task, no run, no evidence.
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.evidence).toHaveLength(before.evidence.length)
    await b.dispose()
  })
})
