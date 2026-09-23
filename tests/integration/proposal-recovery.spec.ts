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
import { ROOT_PROPOSAL_TASK_ID, rootTaskStoreId, TaskService } from '../../task/src/index.ts'
import type { TaskEvent, TaskProposal, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import type {
  Config,
  DecomposeSpec,
  ProposalReviewChannel,
  ProposalReviewNotice,
  ProposalReviewRequest,
  RootContractSpec,
} from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'
import { OTHER_TOOLS, ROOT_TOOLS } from '../support/scripted-loop.ts'

/**
 * T3 acceptance on a real restart: a deployment whose stores live in the real
 * JSONL session log is driven to a crash point, abandoned, and booted again over
 * the same directory — with the review policy, the proposal record and the
 * recovery pass all being the deployment's own code.
 *
 * What is real: `session-persistence-jsonl` and the bytes it writes (the store
 * the second boot reads is the first boot's artifact), the real `TaskService`
 * and its reducer, the real `TaskRuntime` (submission, decisions, recovery,
 * `awaitBatch`), the real `VerifierRegistry`, the real `AgentRuntime` spawn
 * path, and the real `task_read` tool for the read side.
 *
 * What is replaced, and why:
 * - the model loop — a stub agent factory mints an agent whose `whenIdle` runs a
 *   scripted worker body and then hands its run in, exactly the hook
 *   `a3-recovery.spec.ts` uses. Recovery is about the store and the phases, not
 *   about turns.
 * - **the review channel** — a recording stub answers `requested: true` and
 *   keeps every request, because these cases are about what recovery does with a
 *   proposal, not about how a person is asked; the channel's own rendering and
 *   routing are covered by `proposal-review.spec.ts` and the unit suites.
 * - **the checkout** — this deployment resolves no env, so every run is
 *   `unbound` (§3.4's own case): the workspace registry has its own spec
 *   (`a3-workspace.spec.ts`) and would otherwise only add a second reason for a
 *   refusal.
 *
 * **Crash semantics.** `session-persistence-jsonl` writes every append through
 * to disk before `append` resolves, and a dying process closes its descriptors
 * (releasing the backend's `flock`), so {@link Boot.crash} is the durability
 * barrier (`flush()`) and then `close()` on every handle the boot opened. The
 * first context is deliberately *not* disposed: its drivers stay parked on
 * promises that will never settle, which is the state a killed process leaves
 * behind and the reason the second boot has to recover from the log.
 *
 * Every case asserts proposal records, batch membership, child ids, run
 * identities and the events behind them — the facts a restart must keep — and a
 * case whose batch runs to its end also asserts the parent's own composite
 * acceptance, which the runtime submits on the batch's behalf.
 */

const ROOT = 's-root'
const STORE = rootTaskStoreId(ROOT)

/** One child spec: a goal and a criterion a command settles. */
const children = (objective: string, extra: Partial<DecomposeSpec['children'][number]> = {}): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
  ...extra,
}]

/** The batch spec one request is made of. */
const specOf = (objective: string): DecomposeSpec => ({ reason: 'split the work', children: children(objective) })

/** One review request the runtime put to the channel, as the channel received it. */
interface ReviewAsk {
  readonly trigger: string
  readonly storeId: string
  readonly proposalId: string
  readonly request: ProposalReviewRequest
}

/** The recording stand-in for the review channel: it asks nobody and keeps everything. */
class RecordingReviewChannel implements ProposalReviewChannel {
  readonly asks: ReviewAsk[] = []

  async requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice> {
    // A root contract's own review is recorded nowhere here: its rendering is
    // stage C's, and every case in this file is about a batch's proposal — which
    // is what an ask list should contain for a reader to reason about.
    if (request.kind !== 'root') {
      this.asks.push({
        trigger: request.trigger,
        storeId: request.storeId,
        proposalId: request.proposal.proposalId,
        request,
      })
    }
    return { requested: true, detail: 'the fixture channel asked a person' }
  }
}

/** A spawn the runtime handed the agent runtime, in order. */
interface SpawnRecord {
  readonly sessionId: string
  readonly name: string
}

/** What one stub worker does when its agent goes idle. */
type WorkerBody = (sessionId: string) => Promise<void> | void

interface BootOptions {
  /** The review policy this boot runs under (`Config.generatedTaskReview`). Defaults to the runtime's own (`off`). */
  readonly generatedTaskReview?: 'off' | 'all'
  /** The tree-wide root budget this boot runs under. */
  readonly rootBudget?: Readonly<{ wallTimeMs?: number; maxRuns?: number }>
  readonly maxChildren?: number
  /** A worker body that never returns parks the driver with the child in flight. */
  readonly worker?: WorkerBody
  /** Park one session's write drain on a managed job that never confirms stopped: the commit is durable, the settlement is frozen. */
  readonly parkDrain?: (sessionId: string, drainIndex: number) => boolean
}

interface Boot {
  readonly ctx: Context
  readonly task: TaskService
  readonly runtime: TaskRuntime
  readonly review: RecordingReviewChannel
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

/** The boots a spec must dispose: every boot whose context is still alive, and every workspace to remove. */
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
  const dir = mkdtempSync(join(tmpdir(), 'singularity-proposal-recovery-'))
  directories.push(dir)
  return dir
}

/** Boot one deployment over one directory: everything the loader mounts, except the loop and the review channel. */
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
  // allow-list and a worker's grant resolve against, and the real `task_read`.
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
  const review = new RecordingReviewChannel()
  ctx.provide('proposalReviewChannel', review as never)
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
    // settlement behind it — is frozen without a timer.
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
  const spawns: SpawnRecord[] = []
  const agentRuntime = new AgentRuntime(ctx)
  await ctx.plugin(TaskRuntime, {
    capabilities: {},
    ...(options.generatedTaskReview === undefined ? {} : { generatedTaskReview: options.generatedTaskReview }),
    ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
    ...(options.maxChildren === undefined ? {} : { maxChildren: options.maxChildren }),
    runBindingRoot: join(home, 'run-bindings'),
  } as Config)
  const runtime = ctx.get('taskRuntime') as TaskRuntime
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
      // A body that returns without submitting leaves the run `active` where a
      // submission was due; a body that never returns parks the driver.
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
  await agentRuntime.createRoot({ sessionId: SessionId(ROOT), scope: { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }, cwd: dir })

  /**
   * The person's request, on the root session's own durable log — the JSONL
   * surface, written before any intake reads it (A0 §1.10). It is the *existence*
   * of a user-sourced message that the rule asks for, so one text stands for the
   * request this deployment's root contract states. A reopen finds it already on
   * the log and writes nothing: the fact is durable, not this process's memory.
   */
  async function recordPersonRequest(): Promise<void> {
    const handle = await openRootLog()
    try {
      const { events } = await handle.read(0)
      if (events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
      await handle.append([personRequest('ship the release', events.length)])
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

  const unit: Boot = {
    ctx,
    task,
    runtime,
    review,
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

/** Boot over the same directory and run the deployment's recovery pass, the way opening the graph does. */
async function reopen(dir: string, options: BootOptions = {}): Promise<Boot> {
  const next = await boot(dir, options)
  await next.task.openStore(STORE)
  await next.runtime.reconcileStore(STORE)
  return next
}

/** Every task event one store logged, as the JSONL reader holds it. */
function taskEvents(events: readonly SessionEvent[]): TaskEvent[] {
  return events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** One proposal as the store holds it. */
async function proposalOf(boot: Boot, proposalId: string): Promise<TaskProposal> {
  const proposal = (await boot.snapshot()).proposals?.byId[proposalId]
  if (proposal === undefined) throw new Error(`the store holds no proposal "${proposalId}"`)
  return proposal
}

/** The one the store holds, for a case that made exactly one. */
/**
 * The proposal events one store recorded for a **batch**. The root session's own
 * intake wrote records of its own — the contract that became the root — and it
 * rides the reserved envelope task id, so a case about a batch's proposal counts
 * batches.
 */
function batchProposalEvents(events: readonly TaskEvent[]): TaskEvent[] {
  return events.filter(event =>
    event.kind.startsWith('TaskProposal') && event.taskId !== ROOT_PROPOSAL_TASK_ID)
}

async function onlyProposal(boot: Boot): Promise<TaskProposal> {
  // The **batch** proposal, and exactly one of them: the root session's own intake
  // record is a different subject (the contract that became the root), so a case
  // about a batch's proposal counts batches.
  const proposals = ((await boot.snapshot()).proposals?.all ?? []).filter(proposal => proposal.kind !== 'root')
  expect(proposals).toHaveLength(1)
  return proposals[0]!
}

/** The proposal status the store holds, waited for. */
async function statusOf(boot: Boot, proposalId: string, expected: string): Promise<TaskProposal> {
  await vi.waitFor(async () => expect((await proposalOf(boot, proposalId)).status).toBe(expected))
  return await proposalOf(boot, proposalId)
}

/** The run one task holds, or a failure naming the task. */
function runOf(snapshot: TaskSnapshot, taskId: string): TaskSnapshot['runs'][number] {
  const run = snapshot.runs.find(candidate => candidate.taskId === taskId)
  if (run === undefined) throw new Error(`the store holds no run for task "${taskId}"`)
  return run
}

/** A batch id is `b-<parentTaskId>`; the parent id is what a case drives. */
const batchOf = (parentTaskId: string): string => `b-${parentTaskId}`

/**
 * Wait for a boot to have spawned `count` workers. The window is generous on
 * purpose: a spawn is asynchronous by protocol — after the admission commit comes
 * the driver's drain of the parent session and then the worker's own minting, the
 * last of which writes a real session log here — and the suite runs many spec
 * files in parallel forks. The verdicts that follow are read from the store, so
 * this timeout bounds a wait, it does not stand in for evidence. An expired wait
 * reports what the store holds.
 */
async function spawned(boot: Boot, count: number): Promise<void> {
  try {
    await vi.waitFor(() => expect(boot.spawns).toHaveLength(count), { timeout: 20_000, interval: 25 })
  } catch (error) {
    const snapshot = await boot.snapshot()
    const causes = snapshot.reviews.map(item => item.localizedCause ?? item.outcome).join('; ')
    throw new Error(`no worker was spawned: the store's reviews say ${causes === '' ? 'nothing yet' : causes} (${String(error)})`)
  }
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
    acceptanceCriteria: [
      // The goal's own independent check (A0 §1.2's structural rule needs at
      // least one of these) …
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      // … and the conjunction this deployment's trees have always been accepted
      // by: a batch that did not verify cannot be a delivered goal, which is what
      // the recovery cases below read a failed root off.
      { criterionId: 'root-children-verified', description: 'all mandatory children verified', mode: 'composite', mandatory: true },
    ],
  }
}

/**
 * Activate one boot's root through the real intake (A0 §1.3–§1.4) and hand back
 * what it became. Under policy `all` the contract waits for a review like every
 * other proposal; **the fixture records that decision**, through the same entry
 * the channel calls, because every case in this file is about a *batch's*
 * proposal recovery. The root contract's own review — its rendering and its
 * routing to a person — is stage C's, and the fixture's channel is the stub the
 * module doc describes: it answers `requested: true` and keeps the requests it
 * was handed, which for a contract it cannot render is exactly the batch's.
 */
async function activateRoot(boot: Boot, objective = 'ship the release'): Promise<{ taskId: string; runId: string }> {
  const submitted = await boot.runtime.intakeRootContract(STORE, ROOT, rootContract(objective))
  if (submitted.status === 'activated') return { taskId: submitted.taskId, runId: submitted.runId }
  const waiting = await boot.runtime.proposalIn(STORE, submitted.proposalId)
  if (waiting.status === 'pending_review') {
    await boot.runtime.decideProposal(STORE, submitted.proposalId, { outcome: 'approved' }, 'fixture-setup')
  }
  const continued = await boot.runtime.continueProposal(STORE, submitted.proposalId, ROOT)
  if (continued.status !== 'activated') throw new Error(`the root contract was not activated: ${continued.detail}`)
  return { taskId: continued.taskId, runId: continued.runId }
}

describe('proposal recovery from the real session log (T3 §6)', () => {
  it('keeps a waiting proposal waiting across a restart, re-asks from the saved facts, and is advanced only by a decision', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const root = await activateRoot(a)
    const pending = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(pending.status).toBe('pending_review')
    const proposalId = pending.proposalId
    expect(a.review.asks.map(ask => ask.trigger)).toEqual(['submitted'])
    await a.crash()

    const b = await reopen(dir, { generatedTaskReview: 'all' })
    // The proposal is still waiting: recovery never advances one, and the batch
    // it holds never ran in either process.
    expect((await onlyProposal(b)).status).toBe('pending_review')
    const snapshot = await b.snapshot()
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.reviews).toHaveLength(0)
    expect(b.spawns).toHaveLength(0)
    expect(taskEvents(await b.events()).filter(event => event.kind === 'TaskDecomposed')).toHaveLength(0)
    expect(batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    // …and the person is asked again, from the record: the same proposal, the
    // same batch, the same parent — nothing a live process remembered.
    expect(b.review.asks.map(ask => ask.trigger)).toEqual(['recovered'])
    const reasked = b.review.asks[0]!.request
    expect(reasked.proposal.proposalId).toBe(proposalId)
    expect(reasked.parentTask.objective).toBe('ship the release')
    expect(reasked.batch.children.map(child => child.contract.objective)).toEqual(['first child'])
    expect(reasked.manifests).toHaveLength(1)

    // A decision on the record is what admits the batch, and it runs to the end.
    const decided = await b.runtime.decideProposal(STORE, proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(decided.status).toBe('admitted')
    const outcomes = await b.runtime.awaitBatch(STORE, batchOf(root.taskId))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(b.spawns).toHaveLength(1)
    const after = await b.snapshot()
    expect(after.proposals!.byId[proposalId]!.status).toBe('admitted')
    expect(after.proposals!.byId[proposalId]!.consumption!.childTaskIds).toEqual(outcomes.map(outcome => outcome.taskId))
    // The batch the recovery admitted is the batch that ran: its child verified,
    // and the parent's own acceptance settled on that verdict.
    expect((await b.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    await b.dispose()
  })

  it('continues an approval that was recorded before the crash, in one batch with stable child ids', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const root = await activateRoot(a)
    const pending = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(pending.status).toBe('pending_review')
    const proposalId = pending.proposalId
    // The decision is on the record and the process that made it is gone before
    // the continuation ran: written through the store's own entry, which is what
    // the review channel writes, and nothing continues it here.
    const stored = await onlyProposal(a)
    await a.task.decideProposalIn(STORE, {
      proposalId,
      outcome: 'approved',
      proposalDigest: stored.proposalDigest,
      admissionContextDigest: stored.admissionContextDigest,
      reviewContextDigest: stored.reviewContextDigest,
      decidedBy: `approval:${ROOT}`,
      decidedAt: new Date().toISOString(),
    }, `approval:${ROOT}`)
    const before = await a.snapshot()
    expect(before.proposals!.byId[proposalId]!.status).toBe('approved')
    expect(before.proposals!.byId[proposalId]!.decision!.outcome).toBe('approved')
    expect(before.proposals!.byId[proposalId]!.consumption).toBeUndefined()
    expect(before.tasks).toHaveLength(1)
    expect(before.runs).toHaveLength(1)
    expect(a.spawns).toHaveLength(0)
    await a.crash()

    // The process that adopts the store re-checks the approval and admits the
    // batch itself: no caller re-presents anything, and the batch runs.
    const b = await reopen(dir, { generatedTaskReview: 'all' })
    const admitted = await statusOf(b, proposalId, 'admitted')
    const consumption = admitted.consumption!
    expect(consumption.childTaskIds).toHaveLength(1)
    expect(consumption.batchId).toBe(batchOf(root.taskId))
    const outcomes = await b.runtime.awaitBatch(STORE, consumption.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(outcomes.map(outcome => outcome.taskId)).toEqual(consumption.childTaskIds)
    expect((await b.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('verified')

    // The re-check is on the record, and the whole log holds one admission, one
    // batch and one child task — a second recovery pass changes nothing.
    const events = taskEvents(await b.events())
    const phases = batchProposalEvents(events).filter(event => event.kind === 'TaskProposalPhaseChanged')
    expect(phases.map(event => event.payload.to)).toEqual(['ready'])
    expect(batchProposalEvents(events).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskCreated')).toHaveLength(2)
    expect(events.filter(event => event.kind === 'TaskDecomposed')).toHaveLength(1)
    const settled = await b.snapshot()
    expect(settled.tasks).toHaveLength(2)
    expect(settled.runs).toHaveLength(2)
    expect(settled.proposals!.all.filter(proposal => proposal.kind !== 'root')).toHaveLength(1)
    await b.runtime.reconcileStore(STORE)
    const again = await b.snapshot()
    expect(again.tasks.map(task => task.taskId)).toEqual(settled.tasks.map(task => task.taskId))
    expect(again.runs.map(run => run.runId)).toEqual(settled.runs.map(run => run.runId))
    expect(batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect(b.spawns).toHaveLength(1)
    await b.dispose()
  })

  it('retries an approval whose admission was refused whole, still in one batch', async () => {
    const dir = workspace()
    // The budget is what keeps the approval from being admitted in the first
    // process: the root run already holds the only slot, so the post-approval
    // admission is refused whole — nothing is minted, no run is charged, and the
    // decision stays on the record.
    const a = await boot(dir, { generatedTaskReview: 'all', rootBudget: { maxRuns: 1 } })
    const root = await activateRoot(a)
    const pending = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(pending.status).toBe('pending_review')
    const proposalId = pending.proposalId

    const approved = await a.runtime.decideProposal(STORE, proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(approved.outcome).toBe('approved')
    expect(approved.status).toBe('ready')
    expect(approved.detail).toContain('the batch was not admitted')
    expect(approved.detail).toContain('root budget allows 1 run(s)')
    const refused = await proposalOf(a, proposalId)
    expect(refused.status).toBe('ready')
    expect(refused.decision!.outcome).toBe('approved')
    expect(refused.consumption).toBeUndefined()
    expect(batchProposalEvents(taskEvents(await a.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    await a.crash()

    // A deployment that can afford the batch now recovers the approval and
    // admits the same batch: still one admission, one child, one batch.
    const b = await reopen(dir, { generatedTaskReview: 'all', rootBudget: { maxRuns: 10 } })
    const admitted = await statusOf(b, proposalId, 'admitted')
    expect(admitted.decision!.outcome).toBe('approved')
    const consumption = admitted.consumption!
    const outcomes = await b.runtime.awaitBatch(STORE, consumption.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(outcomes.map(outcome => outcome.taskId)).toEqual(consumption.childTaskIds)
    expect((await b.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    expect(batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect((await b.snapshot()).tasks).toHaveLength(2)
    expect(b.spawns).toHaveLength(1)
    await b.dispose()
  })

  it('drives an admitted batch whose children were never started from the proposal its consumption names', async () => {
    const dir = workspace()
    // The root's first drain is the batch's admission drain: the atomic commit —
    // children, admission, phase change and the proposal's consumption — is
    // durable, and the driver is frozen behind it before any child started.
    const a = await boot(dir, { parkDrain: (sessionId, index) => sessionId === ROOT && index === 1 })
    const root = await activateRoot(a)
    const admitted = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(admitted.status).toBe('admitted')
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    const proposalId = admitted.proposalId
    const consumption = (await onlyProposal(a)).consumption!
    expect(consumption.childTaskIds).toEqual(admitted.childTaskIds)
    expect(consumption.batchId).toBe(admitted.batchId)
    expect((await a.snapshot()).tasks).toHaveLength(2)
    expect(a.spawns).toHaveLength(0)
    await a.crash()

    const b = await reopen(dir)
    const outcomes = await b.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The same batch: the ids the consumption recorded are the ids that ran, and
    // no second batch was built around them.
    expect(outcomes.map(outcome => outcome.taskId)).toEqual(consumption.childTaskIds)
    expect(b.spawns).toHaveLength(1)
    const after = await b.snapshot()
    expect(after.proposals!.byId[proposalId]!.status).toBe('admitted')
    expect(after.proposals!.byId[proposalId]!.consumption!.childTaskIds).toEqual(consumption.childTaskIds)
    expect(after.tasks.map(task => task.taskId).sort()).toEqual([root.taskId, ...consumption.childTaskIds].sort())
    expect(after.runs).toHaveLength(2)
    const events = taskEvents(await b.events())
    expect(batchProposalEvents(events).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === consumption.childTaskIds[0])).toHaveLength(1)
    expect((await b.task.taskIn(STORE, consumption.childTaskIds[0]!)).status).toBe('verified')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    await b.dispose()
  })

  it('settles a run that was in flight when the process died without executing it again', async () => {
    const dir = workspace()
    const a = await boot(dir, { worker: () => new Promise(() => {}) })
    const root = await activateRoot(a)
    const admitted = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('long child'))
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    await spawned(a, 1)
    const crashed = runOf(await a.snapshot(), admitted.childTaskIds[0]!)
    expect(crashed.executionPhase).toBe('active')
    await a.crash()

    const b = await reopen(dir)
    const outcomes = await b.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    // The run that was in flight is the run that is settled: its id is unchanged,
    // nothing re-runs it, and the proposal keeps the batch it already consumed.
    const after = await b.snapshot()
    const settled = runOf(after, admitted.childTaskIds[0]!)
    expect(settled.runId).toBe(crashed.runId)
    expect(settled.status).toBe('cancelled')
    expect(after.runs.filter(run => run.taskId === admitted.childTaskIds[0])).toHaveLength(1)
    expect(after.proposals!.byId[admitted.proposalId]!.consumption!.childTaskIds).toEqual(admitted.childTaskIds)
    expect(b.spawns).toHaveLength(0)
    const review = after.reviews.find(item => item.runId === crashed.runId)
    expect(review?.outcome).toBe('cancelled')
    expect(review?.anomalies.join(' ')).toContain('was in flight when this store was reopened and never submitted')
    // The parent was judged on that settlement, not left running: a child that
    // did not verify cannot be accepted.
    expect((await b.task.taskIn(STORE, admitted.childTaskIds[0]!)).status).toBe('cancelled')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('failed')
    await b.dispose()
  })

  it('answers a repeated request from the record, in the first process and after a restart', async () => {
    const dir = workspace()
    const a = await boot(dir)
    const root = await activateRoot(a)
    const first = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(first.existing).toBe(false)
    // The same request — the same calling context and the same content — is the
    // same proposal, and it is not admitted by asking twice.
    const repeat = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(repeat.existing).toBe(true)
    expect(repeat.proposalId).toBe(first.proposalId)
    expect(((await a.snapshot()).proposals!.all).filter(proposal => proposal.kind !== 'root')).toHaveLength(1)
    expect((await a.snapshot()).tasks).toHaveLength(1)
    // A different batch under the same calling context is a different proposal,
    // and a revision is a different request.
    const other = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('a different child'))
    expect(other.proposalId).not.toBe(first.proposalId)
    expect((await a.snapshot()).proposals!.all.filter(proposal => proposal.kind !== 'root')).toHaveLength(2)
    const continued = await a.runtime.continueProposal(STORE, first.proposalId, ROOT)
    expect(continued.status).toBe('admitted')
    const outcomes = await a.runtime.awaitBatch(STORE, batchOf(root.taskId))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect((await a.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await a.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    expect(a.spawns).toHaveLength(1)
    await a.crash()

    const b = await reopen(dir)
    const again = await b.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(again.existing).toBe(true)
    expect(again.proposalId).toBe(first.proposalId)
    expect(again.status).toBe('admitted')
    const after = await b.snapshot()
    expect(after.proposals!.all.filter(proposal => proposal.kind !== 'root')).toHaveLength(2)
    expect(after.tasks).toHaveLength(2)
    expect(after.runs).toHaveLength(2)
    expect(b.spawns).toHaveLength(0)
    // The proposal that was never continued could not become the parent's batch:
    // the parent already has one, so the recovery pass marks it stale instead of
    // admitting a second batch beside the first.
    expect(after.proposals!.byId[other.proposalId]!.status).toBe('stale')
    expect(after.proposals!.byId[first.proposalId]!.consumption!.childTaskIds).toEqual(outcomes.map(outcome => outcome.taskId))
    await b.dispose()
  })

  it('does not re-run a sibling that verified before the crash', async () => {
    const dir = workspace()
    let stack!: Boot
    stack = await boot(dir, {
      // The first child hands its work in; every later one hangs once it starts,
      // which is where the process dies.
      worker: sessionId => {
        const index = stack.spawns.findIndex(spawn => spawn.sessionId === sessionId)
        if (index <= 0) return
        return new Promise(() => {})
      },
    })
    const a = stack
    const root = await activateRoot(a)
    const admitted = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: [...children('first child'), ...children('second child', { dependsOn: [0] })],
    })
    if (admitted.status !== 'admitted') throw new Error('unreachable')
    await spawned(a, 2)
    const passed = runOf(await a.snapshot(), admitted.childTaskIds[0]!)
    await vi.waitFor(async () => expect(runOf(await a.snapshot(), admitted.childTaskIds[0]!).status).toBe('verified'))
    const inFlight = runOf(await a.snapshot(), admitted.childTaskIds[1]!)
    expect(inFlight.executionPhase).toBe('active')
    expect(passed.runId).not.toBe(inFlight.runId)
    await a.crash()

    const b = await reopen(dir)
    const outcomes = await b.runtime.awaitBatch(STORE, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'cancelled'])
    const after = await b.snapshot()
    // The verified sibling is history: one run, one start, its evidence kept.
    expect(after.runs.filter(run => run.taskId === admitted.childTaskIds[0])).toHaveLength(1)
    expect(runOf(after, admitted.childTaskIds[0]!).status).toBe('verified')
    expect(after.tasks.find(task => task.taskId === admitted.childTaskIds[0])!.status).toBe('verified')
    // The run that was in flight is settled, not executed again.
    expect(runOf(after, admitted.childTaskIds[1]!).runId).toBe(inFlight.runId)
    expect(runOf(after, admitted.childTaskIds[1]!).status).toBe('cancelled')
    const events = taskEvents(await b.events())
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === admitted.childTaskIds[0])).toHaveLength(1)
    expect(events.filter(event => event.kind === 'TaskStarted' && event.taskId === admitted.childTaskIds[1])).toHaveLength(1)
    // And the parent was judged on those two verdicts: one child that did not
    // verify is a parent its own criteria refuse.
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('failed')
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('admits one of two proposals competing for the same parent, and names the loser', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const root = await activateRoot(a)
    const first = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first batch child'))
    const second = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('second batch child'))
    if (first.status !== 'pending_review' || second.status !== 'pending_review') throw new Error('unreachable')
    expect(a.review.asks).toHaveLength(2)

    const winner = await a.runtime.decideProposal(STORE, second.proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(winner.status).toBe('admitted')
    await spawned(a, 1)
    // The other approval arrives when the parent's run has left the phase that
    // could dispatch it — the registration cannot be transferred to the batch a
    // competitor already took, so it is recorded as the invalidation it is.
    const loser = await a.runtime.decideProposal(STORE, first.proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(loser.outcome).toBe('expired')
    expect(loser.status).toBe('expired')
    expect(loser.reason ?? loser.detail).toContain('the approval arrived after the batch could be dispatched')
    const lost = await proposalOf(a, first.proposalId)
    expect(lost.status).toBe('expired')
    expect(lost.consumption).toBeUndefined()

    const outcomes = await a.runtime.awaitBatch(STORE, batchOf(root.taskId))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const after = await a.snapshot()
    expect(after.proposals!.byId[second.proposalId]!.status).toBe('admitted')
    expect(after.tasks).toHaveLength(2)
    expect(batchProposalEvents(taskEvents(await a.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    // The child that ran is the winner's, and the loser's batch never existed.
    const childTask = after.tasks.find(task => task.parentTaskId === root.taskId)!
    expect(childTask.contract!.objective).toBe('second batch child')
    expect((await a.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await a.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    expect(a.spawns).toHaveLength(1)
    await a.dispose()
  })

  it('marks a competing proposal stale when it is continued after the parent already decomposed', async () => {
    const dir = workspace()
    const a = await boot(dir)
    const root = await activateRoot(a)
    // Two un-reviewed batches for one parent, both `ready`: whichever is
    // continued second finds the parent already decomposed, and a task
    // decomposes once.
    const first = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first batch child'))
    const second = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('second batch child'))
    expect((await a.runtime.continueProposal(STORE, second.proposalId, ROOT)).status).toBe('admitted')

    const loser = await a.runtime.continueProposal(STORE, first.proposalId, ROOT)
    expect(loser.status).toBe('stale')
    expect(loser.reason).toContain('already has a batch')
    expect(loser.reason).toContain('the approval is not transferred to another batch')
    expect((await proposalOf(a, first.proposalId)).status).toBe('stale')
    expect((await proposalOf(a, first.proposalId)).consumption).toBeUndefined()

    const outcomes = await a.runtime.awaitBatch(STORE, batchOf(root.taskId))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const after = await a.snapshot()
    expect(after.proposals!.byId[second.proposalId]!.status).toBe('admitted')
    expect(after.tasks).toHaveLength(2)
    expect(after.tasks.find(task => task.parentTaskId === root.taskId)!.contract!.objective).toBe('second batch child')
    expect(batchProposalEvents(taskEvents(await a.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(1)
    expect((await a.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await a.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    expect(a.spawns).toHaveLength(1)
    await a.dispose()
  })

  it('sends a policy-off proposal that never ran to review when the deployment tightened, and admits it only after the decision', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'off' })
    const root = await activateRoot(a)
    // Submitted, not continued: under `off` the batch would run at once, but this
    // request stops at the record, which is the shape a running caller leaves
    // behind when it dies between the two halves.
    const submission = await a.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(submission.status).toBe('ready')
    expect(submission.policy).toBe('off')
    expect(a.review.asks).toHaveLength(0)
    await a.crash()

    // The deployment now reviews generated tasks: §5's tightening reaches what
    // has not run yet, and only tightening is allowed.
    const b = await reopen(dir, { generatedTaskReview: 'all' })
    const tightened = await statusOf(b, submission.proposalId, 'pending_review')
    expect(tightened.policy).toBe('off')
    expect(tightened.decision).toBeUndefined()
    expect(b.review.asks.map(ask => ask.trigger)).toEqual(['tightened'])
    expect(b.review.asks[0]!.request.proposal.proposalId).toBe(submission.proposalId)
    const waiting = await b.snapshot()
    expect(waiting.tasks).toHaveLength(1)
    expect(waiting.runs).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    expect(batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    // A continuation adds nothing while it waits.
    expect((await b.runtime.continueProposal(STORE, submission.proposalId, ROOT)).status).toBe('pending_review')
    expect(b.spawns).toHaveLength(0)

    const decided = await b.runtime.decideProposal(STORE, submission.proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(decided.status).toBe('admitted')
    const outcomes = await b.runtime.awaitBatch(STORE, batchOf(root.taskId))
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const after = await b.snapshot()
    expect(after.proposals!.byId[submission.proposalId]!.policy).toBe('off')
    expect(after.proposals!.byId[submission.proposalId]!.decision!.decidedBy).toBe(`approval:${ROOT}`)
    expect((await b.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await b.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    await b.dispose()
  })

  it('never releases a waiting proposal by loosening the policy to off', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all' })
    const root = await activateRoot(a)
    const pending = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    await a.crash()

    const b = await reopen(dir, { generatedTaskReview: 'off' })
    expect((await onlyProposal(b)).status).toBe('pending_review')
    expect(b.review.asks.map(ask => ask.trigger)).toEqual(['recovered'])
    expect((await b.snapshot()).tasks).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    expect((await b.runtime.continueProposal(STORE, pending.proposalId, ROOT)).status).toBe('pending_review')
    expect(b.spawns).toHaveLength(0)

    // A recorded refusal ends it; a later request for the same batch is answered
    // by the refused record rather than by building a second proposal.
    const refused = await b.runtime.decideProposal(STORE, pending.proposalId, {
      outcome: 'rejected',
      reason: 'the batch is not the work this task should do',
    }, `approval:${ROOT}`)
    expect(refused.status).toBe('rejected')
    const again = await b.runtime.submitDecompositionProposal(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    expect(again.existing).toBe(true)
    expect(again.status).toBe('rejected')
    expect((await b.snapshot()).proposals!.all.filter(proposal => proposal.kind !== 'root')).toHaveLength(1)
    expect(b.spawns).toHaveLength(0)
    await b.dispose()
  })

  it('marks an approval stale when the limits moved while it waited, and admits nothing', async () => {
    const dir = workspace()
    const a = await boot(dir, { generatedTaskReview: 'all', maxChildren: 1 })
    const root = await activateRoot(a)
    const pending = await a.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, specOf('first child'))
    if (pending.status !== 'pending_review') throw new Error('unreachable')
    const stored = await proposalOf(a, pending.proposalId)
    await a.crash()

    // The same store, a deployment that admits batches under different limits:
    // the approval bound the limits it was reviewed under, so the batch is not
    // admitted under new ones.
    const b = await reopen(dir, { generatedTaskReview: 'all', maxChildren: 4 })
    expect((await proposalOf(b, pending.proposalId)).admissionContextDigest).toBe(stored.admissionContextDigest)
    const decided = await b.runtime.decideProposal(STORE, pending.proposalId, { outcome: 'approved' }, `approval:${ROOT}`)
    expect(decided.outcome).toBe('approved')
    expect(decided.status).toBe('stale')
    const stale = await proposalOf(b, pending.proposalId)
    expect(stale.status).toBe('stale')
    expect(stale.consumption).toBeUndefined()
    expect(stale.decision!.outcome).toBe('approved')
    const phases = batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalPhaseChanged')
    expect(phases).toHaveLength(1)
    expect(phases[0]!.payload.to).toBe('stale')
    expect(phases[0]!.payload.reason).toContain('the limits in force moved since the batch was proposed and reviewed')
    expect(phases[0]!.payload.reason).toContain(stored.admissionContextDigest)
    expect(b.spawns).toHaveLength(0)
    expect((await b.snapshot()).tasks).toHaveLength(1)
    expect(batchProposalEvents(taskEvents(await b.events())).filter(event => event.kind === 'TaskProposalAdmitted')).toHaveLength(0)
    await b.dispose()
  })
})
