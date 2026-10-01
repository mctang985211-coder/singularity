import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rootTaskStoreId, TaskService } from '../../task/src/index.ts'
import type { TaskEvent, TaskProposalRoot, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { ProposalReviewService } from '../../agent-singularity/src/services/proposal-review.ts'
import { defineContextReadTool } from '../../agent-singularity/src/tools/context-read.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, mountContextReadCore } from '../support/context-plane.ts'
import { seedLegacyRoot } from '../support/legacy-root.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

/**
 * The A0 crash points on a real restart (design §3 stage B, §4): a root contract
 * whose process died at each of the two points between "the review decided" and
 * "the root is live", a root that was activated by a process that is gone, and
 * the historical root shape the graph entry used to mint.
 *
 * What is real: `session-persistence-jsonl` and the bytes it writes (the store
 * the second boot reads is the first boot's artifact), the real `TaskService`
 * and its reducer, the real `TaskRuntime` (intake, decisions, recovery,
 * `adoptRoot`, the execution gate), the real `VerifierRegistry` and the real
 * `AgentRuntime` spawn path, the **deployment's own review channel**
 * (`ProposalReviewService`) over an approval seam this file records but never
 * answers, and the real `task_read` for the read side.
 *
 * **The door these cases use.** A restart is the deployment's own adoption —
 * `adoptRoot`, which opens the store, runs the recovery pass and re-binds the root
 * it holds (that is what `graphs.create` and every graph entry call) — never a
 * hand-rolled `openStore` + `reconcileStore` pair the real entry might drift from.
 * The one case that is *about* a single door (the recorded approval) calls
 * `adoptRoot` and nothing else, so the recovery it exercises is the one a graph
 * reopen performs.
 *
 * What is replaced, and why: the model loop — a stub agent factory mints an agent
 * whose `whenIdle` runs a scripted worker body and then hands its run in, the same
 * hook `proposal-recovery.spec.ts` uses; recovery is about the store and the
 * phases, not about turns. The checkout resolves to nothing, so every run is
 * unbound (§3.4's own case: the workspace registry has its own spec, and a
 * checkout would only add a second reason for a refusal).
 *
 * **Crash semantics.** `session-persistence-jsonl` writes every append through to
 * disk before `append` resolves, and a dying process closes its descriptors
 * (releasing the backend's `flock`), so {@link Boot.crash} is the durability
 * barrier (`flush()`) and then `close()` on every handle the boot opened. The
 * first context is deliberately *not* disposed: its drivers stay parked on
 * promises that will never settle, which is the state a killed process leaves
 * behind and the reason the second boot has to recover from the log.
 *
 * The root contract's own rendering and routing, and the introduction side of
 * every state below, are `root-intake.spec.ts`.
 */

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)

/** What the user asked for, in the user's words. */
const GOAL = 'publish the quarterly alignment report'

/** The one review ask this seam saw: which tool the channel named, and the material it rendered. */
interface ReviewAsk {
  readonly toolName: string
  readonly reason: string
}

/**
 * The human seam these boots mount: the deployment's own channel asks through it
 * — rendering from the store's facts — and this records what was asked. Nothing
 * is ever answered here: every decision in this file is written through the
 * trusted entry a person's answer goes through too, so "an ask was recorded" is
 * exactly what "somebody was asked" means.
 */
class ApprovalSeam {
  readonly asks: ReviewAsk[] = []

  request(request: { toolName?: string; reason?: string }): Promise<never> {
    this.asks.push({ toolName: String(request.toolName ?? ''), reason: String(request.reason ?? '') })
    return new Promise<never>(() => {})
  }
}

/** A spawn the runtime handed the agent runtime, in order. */
interface SpawnRecord {
  readonly sessionId: string
  readonly name: string
}

interface BootOptions {
  /** The review policy this boot runs under (`Config.generatedTaskReview`). Defaults to the runtime's own (`off`). */
  readonly generatedTaskReview?: 'off' | 'all'
}

interface Boot {
  readonly ctx: Context
  readonly task: TaskService
  readonly runtime: TaskRuntime
  /** Every ask the deployment's channel put to the approval seam, in order. */
  readonly review: ApprovalSeam
  /** Every spawn this boot's runtime asked for. */
  readonly spawns: SpawnRecord[]
  /** The store's snapshot as the store itself holds it. */
  snapshot(storeId?: string): Promise<TaskSnapshot>
  /** The store's own event log, read back from the JSONL backend as a reader. */
  events(storeId?: string): Promise<readonly SessionEvent[]>
  /** Dispatch one tool call as the root session, the way the loop does. */
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }>
  /** Simulate process death: the durability barrier, then close every handle this boot opened. */
  crash(): Promise<void>
  dispose(): Promise<void>
}

/** The boots a spec must dispose: every boot whose context is still alive, and every workspace to remove. */
const live: Boot[] = []
const directories: string[] = []

afterEach(async () => {
  for (const boot of live.splice(0)) {
    // A boot whose drivers are parked on promises that will never settle cannot be
    // disposed; the wait is bounded so a failing case reports its assertion instead
    // of a hung teardown.
    await Promise.race([boot.dispose(), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** One tmp directory holding a deployment's whole world: session log, evidence, run bindings. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-root-intake-recovery-'))
  directories.push(dir)
  return dir
}

/** One tool name the root's own allow-list and a worker's grant resolve against — a stand-in, except for the readers. */
function standIn(name: string) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: value as string }] },
    execute: async () => `${name}: fixture answer`,
  }
}

/**
 * Boot one deployment over one directory: everything the loader mounts except the
 * model loop, plus the real root session the graph entry creates (which is what
 * makes a review askable and a spawn possible).
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
  await ctx.plugin(SkillRegistry, {})
  // The deployment's tool plane: stand-ins for every name the root's own
  // allow-list — which the real `AgentRuntime` applies — resolves against, and
  // the real `task_read` for the read side.
  for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
    if (name === 'task_read' || name === 'context_read') continue
    ctx.tools.register(standIn(name))
  }
  ctx.tools.register(defineTaskReadTool(ctx))
  ctx.tools.register(defineContextReadTool(ctx))
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
    commitIn: async () => {},
    setStatusIn: async () => {},
    addAgentIn: async (_storeId: string, agent: { id: string; name: string; status: string }) => { graphState.agents.push(agent) },
  } as never)
  ctx.provide('graphs', graphRegistry({
    graphForSession: async () => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }),
    list: async () => [{
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }],
    members: () => [ROOT, ...graphState.agents.map(agent => String(agent.id))],
  }) as never)
  // The session plane's read-only half (A2), over the real JSONL log this boot
  // writes through the backend's own read handle.
  const readLog = async (sessionId: string): Promise<readonly SessionEvent[]> => {
    const handle = await (persistence as unknown as {
      open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
    }).open(SessionId(sessionId), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  ctx.provide('sessionQuery', {
    readSurface: async (sessionId: string) => ({ capturedThroughSeq: (await readLog(sessionId)).at(-1)?.seq ?? null }),
    readEvent: async (request: { sessionId: string; seq: number; before?: number; after?: number }) => {
      const events = await readLog(String(request.sessionId))
      const target = events.find(event => event.seq === request.seq)
      if (target === undefined) {
        throw new Error(`session "${String(request.sessionId)}" has no event at seq ${request.seq}`)
      }
      const start = Math.max(0, request.seq - (request.before ?? 0))
      const end = Math.min(events.length - 1, request.seq + (request.after ?? 0))
      return { target, events: events.slice(start, end + 1), startSeq: start, endSeq: end }
    },
  } as never)

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(dir, 'evidence') })
  await verifier.ready()
  const spawns: SpawnRecord[] = []
  const agentRuntime = new AgentRuntime(ctx)
  await ctx.plugin(TaskRuntime, {
    capabilities: {},
    ...(options.generatedTaskReview === undefined ? {} : { generatedTaskReview: options.generatedTaskReview }),
    runBindingRoot: join(home, 'run-bindings'),
  } as Config)
  const runtime = ctx.get('taskRuntime') as TaskRuntime
  // The read core and its assembly (A2), mounted where the deployment's bundle
  // mounts them: the read side of every case below goes through it.
  await mountContextReadCore(ctx)

  /** Hand one stub agent to the runtime: the scope, the setup hook, and the idle body. */
  async function mint(sessionId: SessionId, setup?: (agentCtx: Context, agent: Agent) => Promise<unknown>): Promise<Agent> {
    let self!: Agent
    const agent = {
      id: String(sessionId),
      status: 'idle',
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      // A live worker hands its result in before it goes idle (A3 §3.2): an idle
      // session is not a completion, so a stub that only went idle would be stopped
      // by the no-progress rule instead of being verified.
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
      // The scripted worker's whole body: it submits what it was asked for.
    } finally {
      record.status = 'idle'
    }
    const { run } = await runtime.runForSession(sessionId)
    if (run.status !== 'running' || run.executionPhase !== 'active') return
    await runtime.submitResult(sessionId, { summary: 'recovery fixture worker finished' })
  }

  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, opts: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.sessionId, opts.setup), dispose: async () => {} }),
    resume: async (_ownerCtx: Context, opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(opts.resumeSessionId, opts.setup), dispose: async () => {} }),
  } as never)

  // The human seam and the deployment's own channel, mounted where the deployment
  // mounts it — at the service assembly, not on any agent's tool plane.
  const review = new ApprovalSeam()
  ctx.provide('approval', { request: (request: { toolName?: string; reason?: string }) => review.request(request) })
  new ProposalReviewService(ctx)

  const originalSpawn = agentRuntime.spawn.bind(agentRuntime)
  agentRuntime.spawn = async (parent: Agent, request: SpawnRequest) => {
    spawns.push({ sessionId: String(request.sessionId), name: request.name })
    return await originalSpawn(parent, request)
  }
  // The graph entry's own two steps: the root session, then the store it is bound
  // to (opened here, adopted by the caller when the case wants that door).
  await agentRuntime.createRoot({ sessionId: SessionId(ROOT), scope: { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }, cwd: dir })

  /**
   * The person's request, on the root session's own durable log — written through
   * the JSONL backend the runtime reads it from, and flushed, so the second boot
   * finds exactly what the first left (A0 §1.10). The rule is the *existence* of a
   * user-sourced message, so one text stands for the goal these cases intake; a
   * reopen writes nothing, because the request is already on the log.
   */
  async function recordPersonRequest(): Promise<void> {
    const handle = await openRootLog()
    try {
      const { events } = await handle.read(0)
      if (events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
      await handle.append([personRequest(GOAL, events.length)])
      await backend.flush()
    } finally {
      await handle.close()
    }
  }

  /**
   * One write handle onto the root session's stored log. A real deployment stores
   * the root session when the graph creates it — the loop's own write handle is
   * what does it — and no model loop runs here, so the fixture creates that stored
   * session itself when it is not there yet.
   */
  async function openRootLog(): Promise<Awaited<ReturnType<typeof persistence.open>>> {
    try {
      return await persistence.open(SessionId(ROOT), 'write')
    } catch (error) {
      if (!(error instanceof Error) || !/not found/.test(error.message)) throw error
      return await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId(ROOT),
        createdAt: Date.now(),
        isSeeded: false,
        cwd: dir,
        agentPreset: 'standard',
      } as unknown as SessionHeader)
    }
  }
  await recordPersonRequest()

  let callSeq = 0
  const unit: Boot = {
    ctx,
    task,
    runtime,
    review,
    spawns,
    snapshot: async (storeId = STORE) => await task.snapshotIn(storeId),
    events: async (storeId = STORE) => {
      const handle = await (persistence as unknown as {
        open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly SessionEvent[] }>; close: () => Promise<void> }>
      }).open(SessionId(storeId), 'read')
      try {
        return (await handle.read()).events
      } finally {
        await handle.close()
      }
    },
    call: async (name, args = {}) => {
      const result = await ctx.tools.execute({
        callId: `boot-call-${++callSeq}`,
        name,
        arguments: args,
        agent: ctx.agents.get(ROOT) as never,
        signal: new AbortController().signal,
      })
      return {
        isError: result.isError === true,
        text: result.content.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
      }
    },
    crash: async () => {
      const index = live.indexOf(unit)
      if (index >= 0) live.splice(index, 1)
      await backend.flush()
      for (const handle of handles.splice(0)) await handle.close()
    },
    dispose: async () => {
      const index = live.indexOf(unit)
      if (index >= 0) live.splice(index, 1)
      await ctx.fiber.dispose()
    },
  }
  live.push(unit)
  return unit
}

/**
 * Boot over the same directory and adopt the store the way the deployment does:
 * `graphs.create` and every graph entry call `adoptRoot`, which opens the store,
 * runs the recovery pass and re-binds the root it holds. These cases therefore
 * exercise the public door rather than a hand-rolled `openStore` +
 * `reconcileStore` pair, so what a real reopen does is what they measure.
 */
async function reopen(dir: string, options: BootOptions = {}): Promise<Boot> {
  const next = await boot(dir, options)
  await next.runtime.adoptRoot(STORE, ROOT)
  return next
}

/* --- reading the deployment's own facts ---------------------------------- */

/** Every task event one store logged, as the JSONL reader holds it. */
function taskEvents(events: readonly SessionEvent[]): TaskEvent[] {
  return events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** One root contract proposal as the store holds it. */
async function rootProposalOf(boot_: Boot, proposalId: string): Promise<TaskProposalRoot> {
  const proposal = (await boot_.snapshot()).proposals?.byId[proposalId]
  if (proposal === undefined) throw new Error(`the store holds no proposal "${proposalId}"`)
  if (proposal.kind !== 'root') throw new Error(`proposal "${proposalId}" is not a root contract`)
  return proposal
}

/** The proposal status the store holds, waited for. */
async function statusOf(boot_: Boot, proposalId: string, expected: string): Promise<TaskProposalRoot> {
  await vi.waitFor(async () => expect((await rootProposalOf(boot_, proposalId)).status).toBe(expected))
  return await rootProposalOf(boot_, proposalId)
}

/**
 * The root contract these cases run under (A0 §1.2): one goal, one criterion a
 * command settles. The intake is the real one, so the contract is stated here
 * rather than defaulted — a root contract owes at least one mandatory criterion
 * judged by something other than the composite conjunction.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

describe('root intake recovery from the real session log (A0 §1.4, §3 stage B)', () => {
  it('keeps a waiting contract waiting across a restart, re-asks from the saved facts, and activates only on a decision', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const submitted = await a.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    expect(submitted.status).toBe('pending_review')
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    const proposalId = submitted.proposalId
    expect(a.review.asks.map(ask => ask.toolName)).toEqual(['task_intake'])
    expect(a.review.asks[0]!.reason).toContain(`- objective: ${GOAL}`)
    expect((await a.snapshot()).tasks).toHaveLength(0)
    expect((await a.snapshot()).runs).toHaveLength(0)
    expect(a.spawns).toHaveLength(0)
    await a.crash()

    const b = await boot(dir, { generatedTaskReview: 'all' })
    // The public door, and nothing else. A waiting contract is not advanced by it
    // — only a persisted decision moves one — but its review is re-asked out of
    // the store's own facts, and the answer names what is left waiting instead of
    // reporting a failure or minting anything.
    const adopted = await b.runtime.adoptRoot(STORE, ROOT)
    expect(adopted.adopted).toBe(false)
    if (adopted.adopted) throw new Error('unreachable')
    expect(adopted.detail).toContain('created no task, no run and no proposal')
    expect(adopted.detail).toContain(`"${proposalId}" (pending_review)`)
    // Recovery never advances a waiting proposal, and it created nothing while
    // re-reading the log.
    const waiting = await b.runtime.proposalIn(STORE, proposalId)
    expect(waiting.status).toBe('pending_review')
    expect((await b.snapshot()).tasks).toHaveLength(0)
    expect((await b.snapshot()).runs).toHaveLength(0)
    expect(b.spawns).toHaveLength(0)
    // The person is asked again, out of the store's own facts: same proposal, same
    // contract, and the trigger says this ask came from recovery.
    expect(b.review.asks).toHaveLength(1)
    expect(b.review.asks[0]!.toolName).toBe('task_intake')
    expect(b.review.asks[0]!.reason).toContain(`Root contract review — proposal ${proposalId} [pending_review] (policy all, trigger: recovered)`)
    expect(b.review.asks[0]!.reason).toContain(`- objective: ${GOAL}`)
    expect(b.review.asks[0]!.reason).toContain('- proposal digest (sha256):')

    // A decision on the record is what activates it — and that is one root task
    // with one root run, in the root session, with no worker anywhere.
    const decided = await b.runtime.decideProposal(STORE, proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(decided.outcome).toBe('approved')
    expect(decided.status).toBe('activated')
    const admitted = await statusOf(b, proposalId, 'admitted')
    const consumption = admitted.consumption!
    if (consumption.kind !== 'root') throw new Error('the root proposal was consumed as a batch')
    const after = await b.snapshot()
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(after.tasks[0]!.taskId).toBe(consumption.rootTaskId)
    expect(after.tasks[0]!.objective).toBe(GOAL)
    expect(after.runs[0]!.runId).toBe(consumption.rootRunId)
    expect(after.runs[0]!.sessionId).toBe(ROOT)
    expect(b.spawns).toHaveLength(0)
    await expect(b.runtime.proposalIn(STORE, proposalId)).resolves.toMatchObject({ status: 'admitted' })
    await b.dispose()
  })

  it('continues an approval recorded before the crash, activating the root it was about', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const submitted = await a.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    const proposalId = submitted.proposalId
    // The decision is on the record and the process that made it is gone before the
    // continuation ran: written through the store's own entry, which is the one the
    // review channel writes, and nothing continues it here.
    const stored = await rootProposalOf(a, proposalId)
    await a.task.decideProposalIn(STORE, {
      proposalId,
      outcome: 'approved',
      proposalDigest: stored.proposalDigest,
      admissionContextDigest: stored.admissionContextDigest,
      reviewContextDigest: stored.reviewContextDigest,
      decidedBy: `approval:${ROOT}`,
      decidedAt: new Date().toISOString(),
    }, `approval:${ROOT}`)
    expect((await rootProposalOf(a, proposalId)).status).toBe('approved')
    expect((await a.snapshot()).tasks).toHaveLength(0)
    expect((await a.snapshot()).runs).toHaveLength(0)
    await a.crash()

    // The process that adopts the store re-checks the approval and activates the
    // root itself: no caller re-presents anything, and the adoption's own recovery
    // pass is the only thing that runs — this case calls no other entry after the
    // crash, and `reconcileStore` appears nowhere in it.
    const b = await boot(dir, { generatedTaskReview: 'all' })
    const adopted = await b.runtime.adoptRoot(STORE, ROOT)
    // What the public door answered, in one assertion: this is the counterexample
    // the review measured — an early-returning adoption reports `adopted: false`,
    // leaves the store at 0 tasks and 0 runs and the proposal `approved`.
    const atAdoption = await b.snapshot()
    expect({
      adopted: adopted.adopted,
      tasks: atAdoption.tasks.length,
      runs: atAdoption.runs.length,
      proposal: (await rootProposalOf(b, proposalId)).status,
    }).toEqual({ adopted: true, tasks: 1, runs: 1, proposal: 'admitted' })

    // The ids the consumption names are the root the adoption binds, and the gate
    // phase came off the run's own record.
    const admitted = await statusOf(b, proposalId, 'admitted')
    const consumption = admitted.consumption!
    if (consumption.kind !== 'root') throw new Error('the root proposal was consumed as a batch')
    expect(adopted).toMatchObject({
      adopted: true,
      taskId: consumption.rootTaskId,
      runId: consumption.rootRunId,
      phase: 'active',
    })
    const after = await b.snapshot()
    expect(after.tasks[0]!.taskId).toBe(consumption.rootTaskId)
    expect(after.tasks[0]!.objective).toBe(GOAL)
    expect(after.runs[0]!.runId).toBe(consumption.rootRunId)
    expect(after.runs[0]!.sessionId).toBe(ROOT)
    expect(b.spawns).toHaveLength(0)
    // One activation on the log, and a second call through the same door activates
    // nothing further: the same ids, still one admit event, still one task and run.
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    const again = await b.runtime.adoptRoot(STORE, ROOT)
    expect(again).toMatchObject({ adopted: true, taskId: consumption.rootTaskId, runId: consumption.rootRunId })
    const second = await b.snapshot()
    expect(second.tasks.map(task => task.taskId)).toEqual([consumption.rootTaskId])
    expect(second.runs.map(run => run.runId)).toEqual([consumption.rootRunId])
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('answers a store with nothing to recover as nothing to adopt, and mints nothing', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'off' })
    // The state a fresh graph starts in (A0 §1.1): the root session exists, no
    // contract was ever intaken, and the adoption is what opens the store. An open
    // store with nothing in it is normal, so the answer is `adopted: false` — not
    // a failure — and the recovery pass behind it has nothing to continue.
    const adopted = await a.runtime.adoptRoot(STORE, ROOT)
    expect(adopted.adopted).toBe(false)
    if (adopted.adopted) throw new Error('unreachable')
    expect(adopted.detail).toContain(`store "${STORE}" holds no root task`)
    expect(adopted.detail).toContain('created no task, no run and no proposal')
    expect(adopted.detail).toContain('no proposal is open on it')
    const snapshot = await a.snapshot()
    expect(snapshot.tasks).toHaveLength(0)
    expect(snapshot.runs).toHaveLength(0)
    expect(snapshot.proposals?.all ?? []).toHaveLength(0)
    // Nothing was written to the store's own log: adoption is not a second way to
    // mint a root, and the empty answer is not a task event either.
    expect(taskEvents(await a.events())).toHaveLength(0)
    expect(a.review.asks).toHaveLength(0)
    expect(a.spawns).toHaveLength(0)
    // Asking again answers the same and still writes nothing.
    expect((await a.runtime.adoptRoot(STORE, ROOT)).adopted).toBe(false)
    expect(taskEvents(await a.events())).toHaveLength(0)
    await a.dispose()
  })

  it('rebinds a root whose activation is durable and whose process is gone, without minting a second root', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'off' })
    const activated = await a.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    if (activated.status !== 'activated') throw new Error(`the root was not activated: ${activated.detail}`)
    const ids = { taskId: activated.taskId, runId: activated.runId }
    await a.crash()

    // The commit is durable and the process that made it is gone: the next
    // process starts with no binding, and the store is the only thing that knows
    // what this session's root is.
    const b = await boot(dir, { generatedTaskReview: 'off' })
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)

    // The graph entry's own door rebinds the session to the ids the store holds,
    // with the phase derived from the run record rather than assumed.
    const adopted = await b.runtime.adoptRoot(STORE, ROOT)
    expect(adopted).toMatchObject({ adopted: true, taskId: ids.taskId, runId: ids.runId, phase: 'active' })
    // The runtime's own lookup door answers the same ids — both read the store, so
    // neither can mint a second root.
    const bound = await b.runtime.runForSession(ROOT)
    expect(bound.task.taskId).toBe(ids.taskId)
    expect(bound.run.runId).toBe(ids.runId)

    // The reader answers the root's own contract, and the store still holds
    // exactly one task and one run — the second process minted nothing.
    const read = await b.call('task_read')
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`task ${ids.taskId} [running/decomposable]`)
    expect(read.text).toContain(`objective: ${GOAL}`)
    expect(read.text).toContain(`run ${ids.runId} [running] — phase active`)
    const snapshot = await b.snapshot()
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskCreated')).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('answers a repeated intake and a replayed continuation with the one root it already has', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'off' })
    const first = await a.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    if (first.status !== 'activated') throw new Error(`the root was not activated: ${first.detail}`)
    await a.crash()

    const b = await boot(dir, { generatedTaskReview: 'off' })
    // The same accepted fact, replayed by the next process: the same contract
    // addressed by the same derived key is answered from the record, and the root
    // it already became is not created a second time.
    const again = await b.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    expect(again.status).toBe('activated')
    if (again.status !== 'activated') throw new Error('unreachable')
    expect(again.taskId).toBe(first.taskId)
    expect(again.runId).toBe(first.runId)
    expect(again.proposalId).toBe(first.proposalId)

    // The continuation is idempotent from the outside for the same reason: an
    // admitted proposal answers with what its consumption recorded.
    const replay = await b.runtime.continueProposal(STORE, first.proposalId, ROOT)
    expect(replay.status).toBe('activated')
    if (replay.status !== 'activated') throw new Error('unreachable')
    expect(replay.taskId).toBe(first.taskId)
    expect(replay.runId).toBe(first.runId)

    const snapshot = await b.snapshot()
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('leaves an old graph\'s root exactly as history, and refuses an intake on top of it', async () => {
    const dir = workspace()
    const legacyObjective = 'legacy-graph-name'
    const a = await boot(dir, { generatedTaskReview: 'off' })
    // The historical shape, seeded through the store's own entries: a root whose
    // objective is the graph's own name and whose only criterion is the
    // conjunction. No intake can produce it any more, which is the point.
    const seeded = await seedLegacyRoot({ task: a.task, runtime: a.runtime, storeId: STORE, rootSessionId: ROOT, objective: legacyObjective })
    const before = await a.snapshot()
    expect(before.tasks).toHaveLength(1)
    expect(before.tasks[0]!.objective).toBe(legacyObjective)
    expect(before.tasks[0]!.acceptanceCriteria.map(criterion => criterion.verificationMode)).toEqual(['composite'])
    expect(a.spawns).toHaveLength(0)
    // The store's own log as the first process left it.
    const history = await a.events()
    await a.crash()

    const b = await boot(dir, { generatedTaskReview: 'off' })
    const adopted = await b.runtime.adoptRoot(STORE, ROOT)
    expect(adopted).toMatchObject({ adopted: true, taskId: seeded.taskId, runId: seeded.runId, phase: 'active' })

    // Reading is unchanged: the goal is the one the old entry wrote, the record
    // the restart replays is byte-for-byte the one it holds, and the recovery pass
    // the adoption now runs wrote no proposal onto the store.
    const read = await b.call('task_read')
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`task ${seeded.taskId} [running/decomposable]`)
    expect(read.text).toContain(`objective: ${legacyObjective}`)
    const after = await b.snapshot()
    expect(after.tasks[0]!.taskId).toBe(seeded.taskId)
    expect(after.tasks[0]!.acceptanceCriteria).toEqual(before.tasks[0]!.acceptanceCriteria)
    expect(after.proposals?.all ?? []).toHaveLength(0)
    expect(await b.events()).toEqual(history)

    // An intake on top of it is refused by name: one root per store, and a changed
    // goal is a new graph (§1.6).
    await expect(b.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL)))
      .rejects.toThrow(/already holds root task/)
    expect((await b.snapshot()).proposals?.all ?? []).toHaveLength(0)

    // Acceptance and completion still work the way they always did: the tree
    // decomposes, its child verifies, and the old root's own conjunction closes it.
    const admitted = await b.runtime.decomposeAndRun(STORE, seeded.taskId, seeded.runId, ROOT, {
      reason: 'the old graph keeps working',
      children: [{ objective: 'legacy child', acceptanceCriteria: [{ description: 'the legacy child works', command: 'true' }] }],
    } satisfies DecomposeSpec)
    if (admitted.status !== 'admitted') throw new Error(`the legacy batch was not admitted: ${admitted.detail}`)
    const outcomes = await b.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await b.task.taskIn(STORE, admitted.childTaskIds[0]!)).status).toBe('verified')
    // The old root's own conjunction closes it — through the root's own
    // submission (K1 §2), which is the only thing that starts its acceptance.
    await b.runtime.submitResult(ROOT, { summary: 'the legacy root hands in its result' })
    expect((await b.task.taskIn(STORE, seeded.taskId)).status).toBe('verified')
    expect(b.spawns).toHaveLength(1)
    await b.dispose()
  })

  it('sends a contract born under off for the review it never had when the deployment tightened', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'off' })
    // The draft as `off` leaves it: recorded and not yet activated (the
    // continuation is what would activate it, and this process never runs it).
    const submission = await a.runtime.submitRootContractProposal(STORE, ROOT, rootContract(GOAL))
    expect(submission.status).toBe('ready')
    expect(submission.policy).toBe('off')
    expect(a.review.asks).toHaveLength(0)
    await a.crash()

    const b = await reopen(dir, { generatedTaskReview: 'all' })
    // §5's tightening reaches it — the only direction a policy change may move a
    // proposal — and it goes to a person rather than to a task.
    const tightened = await b.runtime.proposalIn(STORE, submission.proposalId)
    expect(tightened.status).toBe('pending_review')
    expect(tightened.policy).toBe('off')
    expect((await b.snapshot()).tasks).toHaveLength(0)
    expect(b.review.asks).toHaveLength(1)
    expect(b.review.asks[0]!.reason).toContain(`proposal ${submission.proposalId} [pending_review] (policy off, trigger: tightened)`)
    expect(b.review.asks[0]!.reason).toContain(`- objective: ${GOAL}`)
    await b.dispose()
  })

  it('never releases a waiting contract when the deployment relaxes to off', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const submitted = await a.runtime.intakeRootContract(STORE, ROOT, rootContract(GOAL))
    if (submitted.status !== 'pending_review') throw new Error('unreachable')
    await a.crash()

    const b = await reopen(dir, { generatedTaskReview: 'off' })
    // The relaxed deployment asks again (from the record) instead of letting the
    // contract through: a waiting proposal is not released by a policy change.
    const waiting = await b.runtime.proposalIn(STORE, submitted.proposalId)
    expect(waiting.status).toBe('pending_review')
    expect(waiting.policy).toBe('all')
    expect((await b.snapshot()).tasks).toHaveLength(0)
    expect((await b.snapshot()).runs).toHaveLength(0)
    expect(b.review.asks).toHaveLength(1)
    expect(b.review.asks[0]!.reason).toContain('trigger: recovered')
    await b.dispose()
  })
})
