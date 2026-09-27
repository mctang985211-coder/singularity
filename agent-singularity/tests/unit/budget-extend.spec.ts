import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { Context } from '../../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { TaskBudgetExtension, TaskBudgetExtensionClaim, TaskInstance, TaskRun, TaskSnapshot } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, RootBudgetExtensionResult } from '../../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../../task-runtime/src/index.ts'
import { defineRootBudgetApproval, defineTaskBudgetExtendTool } from '../../src/tools/budget-extend.ts'

/**
 * `task_budget_extend` (K4) against the real service, the real runtime and the
 * real approval service, driven by a controlled answerer.
 *
 * The interface under test is one call with one person in it: the tool hands the
 * runtime the request and the host execution it runs under
 * (`extendRootBudget`), the runtime derives the store, judges the request, freezes
 * the reading, and asks the one approval this deployment installed — the callback
 * `defineRootBudgetApproval` builds, which is where the native DSH
 * `approval.request()` really happens. What each case pins is therefore the two
 * halves of that seam: the card the answerer was handed (the store, the root
 * task and session, the key and its identity, the usage, both ceilings with the
 * configured value beside them, and the totals approving would put in place); and
 * what the store ends up holding — the raises, the `approval:<callId>` audit
 * reference, and nothing at all when the person says anything but
 * `allowed-once`.
 *
 * Everything the tool talks to is the deployment's: the real `TaskService` and
 * the real `TaskRuntime` (the same harness shape `task-runtime/tests/unit/
 * budget-extension.spec.ts` uses), a store built through the service's own
 * entries, and the **native `ApprovalService` itself** — the real ask and the
 * real `approval/asked` + `approval/decided` pair — with the one seam a spec is
 * supposed to drive: the answerer.
 */

const NOW = '2026-09-16T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const WORKER_SESSION = 'worker-session'
const STORE = rootTaskStoreId(ROOT_SESSION)
/** The configured wall time (one hour) resolved against the root run's own start. */
const CONFIGURED_DEADLINE = '2026-09-16T01:00:00.000Z'
const ROOT_BUDGET: Config['rootBudget'] = { wallTimeMs: 3_600_000, maxRuns: 10 }
/** The channel's own identity for one ask: a fresh uuid. Nothing this path persists may claim one any more. */
const CHANNEL_ID = /approval:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/** One ask, as the answerer was handed it: the card and the call it belongs to. */
interface Asked {
  readonly sessionId: string
  readonly toolName: string
  readonly callId: string | undefined
  readonly reason: string
}

/**
 * One session's own log in the shape the approval service writes through:
 * `append` for the pair it records, `seq`/`eventAt` for the open-turn check it
 * performs before it asks, and the events themselves for the spec to assert on.
 * The service is the real one; only the storage behind the log is this spec's.
 */
interface AuditedLog {
  readonly events: { readonly type: string; readonly data: unknown }[]
  readonly seq: number
  append(type: string, data: unknown): void
  eventAt(seq: number): { readonly type: string } | undefined
}

function auditedLog(): AuditedLog {
  const events: { type: string; data: unknown }[] = []
  return {
    events,
    get seq() { return events.length },
    append(type, data) { events.push({ type, data }) },
    eventAt(seq) { return events[seq] },
  }
}

/**
 * The deployment one call runs in: a graph whose root session is `ROOT_SESSION`,
 * a task store the runtime opens through the real service, the root's own run
 * already started, the real approval service behind the root session's own log,
 * the assembly's own approval callback installed on the runtime, and an answerer
 * the spec decides through.
 *
 * The root session's log starts inside an open turn — the approval service
 * refuses to ask outside one, because its audit pair has to be enclosed by the
 * durable log's commit boundary, and a tool call is always inside the turn that
 * dispatched it. `installApproval: false` mounts the runtime with no approval
 * registered, which is what a deployment without this assembly's constructor
 * looks like.
 */
async function harness(options: { graphRoot?: string; graphsThrow?: boolean; installApproval?: boolean } = {}) {
  const sessions = new Map<string, StoredSession>()
  const handle = (stored: StoredSession) => ({
    read: async () => ({ events: stored.events }),
    append: async (events: readonly SessionEvent[]) => { stored.events.push(...events) },
    flush: async () => {},
    close: async () => {},
  })
  const ctx = new Context()
  ctx.provide('sessionPersistence', {
    list: async () => [...sessions.values()].map(item => ({ header: item.header })),
    create: async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(String(header.id), stored)
      return handle(stored)
    },
    open: async (id: SessionId) => {
      const stored = sessions.get(String(id))
      if (stored === undefined) throw new Error(`missing session ${String(id)}`)
      return handle(stored)
    },
    flush: async () => {},
  } as never)
  ctx.provide('graphs', {
    graphForSession: async (sessionId: string) => {
      if (options.graphsThrow === true) throw new Error(`no graph holds session "${sessionId}"`)
      return {
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: options.graphRoot ?? ROOT_SESSION,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }
    },
  } as never)
  const task = new TaskService(ctx)
  const runtime = new TaskRuntime(ctx, { rootBudget: { ...ROOT_BUDGET } })
  const root = auditedLog()
  root.append('turn/start', {})
  const asks: Asked[] = []
  let answer: ApprovalOutcome = 'allowed-once'
  ctx.on('approval/request', (request: { agent?: { id?: string }; toolName?: string; callId?: unknown; reason?: string }) => {
    asks.push({
      sessionId: String(request.agent?.id ?? ''),
      toolName: String(request.toolName ?? ''),
      callId: request.callId === undefined ? undefined : String(request.callId),
      reason: String(request.reason ?? ''),
    })
    return answer
  })
  await ctx.plugin(ApprovalService, {})
  if (options.installApproval !== false) {
    runtime.registerRootBudgetApproval(defineRootBudgetApproval(ctx as never))
  }
  return {
    ctx,
    task,
    runtime,
    sessions,
    root,
    asks,
    /** What the person answers next: the controlled answerer's decision. */
    answerWith: (outcome: ApprovalOutcome) => { answer = outcome },
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

function rootTask(): TaskInstance {
  return {
    taskId: 'root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
}

function rootRun(runId = 'r-root'): TaskRun {
  return {
    runId,
    taskId: 'root',
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }
}

/** A store holding the tree's root and `runs` recorded runs, built through the service's own entries. */
async function storeWithRoot(h: Harness, runs = 1): Promise<void> {
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, rootTask(), 'test')
  await h.task.admitTaskIn(STORE, 'root', 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
  await h.task.startRunIn(STORE, rootRun(), 'test')
  for (let index = 2; index <= runs; index += 1) {
    const task: TaskInstance = { ...rootTask(), taskId: `child-${index}`, parentTaskId: 'root', depth: 1 }
    await h.task.createTaskIn(STORE, task, 'test')
    await h.task.admitTaskIn(STORE, `child-${index}`, 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
    await h.task.startRunIn(STORE, { ...rootRun(`r-${index}`), taskId: `child-${index}`, sessionId: `s-${index}` }, 'test')
  }
}

/**
 * The store's own committed log — every event the deployment's sessions hold.
 * The root session's log is deliberately not in here: what the approval channel
 * writes (`approval/asked` + `approval/decided`) is its audit, not a store write,
 * and "nothing was written" is a claim about the store.
 */
function storeEvents(h: Harness): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

function budgetEvents(h: Harness): TaskBudgetExtensionClaim[] {
  return storeEvents(h).flatMap(event => {
    if (event.type !== 'task/event') return []
    const task = event.data as { kind?: string; payload?: { extension?: TaskBudgetExtensionClaim } }
    return task.kind === 'TaskBudgetExtended' && task.payload?.extension !== undefined ? [task.payload.extension] : []
  })
}

async function snapshot(h: Harness): Promise<TaskSnapshot> {
  return await h.task.snapshotIn(STORE)
}

/** The DSH host execution a tool call runs under, reduced to what this entry reads. */
function exec(h: Harness, sessionId: string, callId = 'call-1') {
  return { agent: { id: sessionId, session: h.root }, callId, signal: new AbortController().signal } as never
}

/** The one card the tool asked, as the answerer was handed it. */
function card(h: Harness): string {
  expect(h.asks).toHaveLength(1)
  return h.asks[0]!.reason
}

/** The channel's own record of one ask and its decision, as the approval service left it on the root session's log. */
function auditOf(h: Harness): {
  asked?: { id: string; toolName: string; callId?: string; reason: string }
  decided?: { id: string; outcome: string }
} {
  const asked = h.root.events.find(event => event.type === 'approval/asked')
  const decided = h.root.events.find(event => event.type === 'approval/decided')
  return {
    ...(asked === undefined ? {} : { asked: asked.data as { id: string; toolName: string; callId?: string; reason: string } }),
    ...(decided === undefined ? {} : { decided: decided.data as { id: string; outcome: string } }),
  }
}

/** One record as the store holds it, for the scripted-runtime case. */
function recordOf(overrides: Partial<TaskBudgetExtension> = {}): TaskBudgetExtension {
  return {
    requestKey: 'k-runs',
    requestDigest: 'd'.repeat(64),
    maxRuns: { previous: 10, next: 20 },
    baseline: { maxRuns: 10, deadlineAt: CONFIGURED_DEADLINE },
    approvalRef: 'approval:call-7',
    requestedBy: ROOT_SESSION,
    recordedAt: '2026-09-16T00:00:05.000Z',
    ...overrides,
  }
}

describe('task_budget_extend', () => {
  it('asks one person once, hands them the store, both ceilings, the usage and the totals, and records what they approved', async () => {
    const h = await harness()
    await storeWithRoot(h, 3)
    const before = await snapshot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string

    // The card is what a person decides from: which store, which tree asked, the
    // request's own key and identity, the usage that is never reset, both
    // ceilings with the deployment's configured value beside them, and the total
    // this approval would put in place — and no binding, digest-token or other
    // credential standing in for the decision.
    const asked = card(h)
    expect(asked).toContain(`store "${STORE}"`)
    expect(asked).toContain('root task root')
    expect(asked).toContain(`root coordination session ${ROOT_SESSION}`)
    expect(asked).toMatch(/request key "k-runs" \(identity [0-9a-f]{64}\)/)
    expect(asked).toContain('runs the store already holds: 3 — an approved total replaces the ceiling, never this count')
    expect(asked).toContain('maxRuns: 10 in force (deployment configures 10) → approves a total of 20')
    expect(asked).toContain(`deadlineAt: ${CONFIGURED_DEADLINE} in force (deployment configures ${CONFIGURED_DEADLINE}) — this request does not name it`)
    expect(asked).toContain('approving records ONE budget-extension event')
    expect(asked).toContain('rejecting or cancelling records nothing and changes no ceiling.')
    expect(asked).not.toContain('approval binding')
    expect(asked).not.toMatch(CHANNEL_ID)

    // The channel really asked, under the host's own call, and really recorded
    // its audit pair on the asking session's log — the pair that now documents
    // the decision rather than authorizing one.
    expect(h.asks[0]).toMatchObject({ sessionId: ROOT_SESSION, toolName: 'task_budget_extend', callId: 'call-1' })
    const audit = auditOf(h)
    expect(audit.asked?.reason).toBe(asked)
    expect(audit.decided).toEqual({ id: audit.asked?.id, outcome: 'allowed-once' })

    // The answer prints the raise, the host's own identity for the call the
    // question was asked under, the asking session and the recorded time.
    expect(result).toContain(`approved and recorded on store "${STORE}"`)
    expect(result).toContain('request key "k-runs"')
    expect(result).toContain('- maxRuns: 10 → 20')
    expect(result).toContain(`approval on the record: approval:call-1 — asked by ${ROOT_SESSION} at `)
    expect(result).toContain('no run started, none resumed, no task changed and no terminal run re-opened')
    expect(result).toContain('the runs already counted still count against the approved total')

    // The durable fact is the store's: one event, one record — and nothing in
    // either claims a channel-issued id any more; the audit reference is the
    // call the tool was invoked under, and it authorizes nothing by existing.
    const recorded = await snapshot(h)
    expect(budgetEvents(h)).toHaveLength(1)
    expect(recorded.budgetExtensions?.all).toHaveLength(1)
    const record = recorded.budgetExtensions?.byRequestKey['k-runs']
    expect(record).toMatchObject({
      requestKey: 'k-runs',
      maxRuns: { previous: 10, next: 20 },
      requestedBy: ROOT_SESSION,
      approvalRef: 'approval:call-1',
    })
    expect(record?.recordedAt).toBeDefined()
    expect(result).toContain(`at ${String(record?.recordedAt)}`)
    expect(record?.approvalRef).not.toMatch(CHANNEL_ID)
    expect(result).not.toMatch(CHANNEL_ID)
    expect(result).not.toContain(String(audit.asked?.id))
    expect(budgetEvents(h)[0]).toMatchObject({ requestKey: 'k-runs', approvalRef: 'approval:call-1' })

    // Ceilings moved; runs and tasks did not.
    expect(recorded.runs).toEqual(before.runs)
    expect(recorded.tasks).toEqual(before.tasks)
  })

  it('records an approved deadline as the absolute instant the person was shown', async () => {
    const h = await harness()
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    // The request may spell the instant with any legal zone designator: what the
    // card shows and what the store keeps is the canonical one.
    const result = (await tool.execute({ requestKey: 'k-time', deadlineAt: '2026-09-16T12:00:00+08:00' }, exec(h, ROOT_SESSION))) as string

    expect(card(h)).toContain(`deadlineAt: ${CONFIGURED_DEADLINE} in force (deployment configures ${CONFIGURED_DEADLINE}) → approves a total of 2026-09-16T04:00:00.000Z`)
    expect(result).toContain('- deadlineAt: 2026-09-16T01:00:00.000Z → 2026-09-16T04:00:00.000Z')
    expect((await snapshot(h)).budgetExtensions?.byRequestKey['k-time']).toMatchObject({
      deadlineAt: { previous: CONFIGURED_DEADLINE, next: '2026-09-16T04:00:00.000Z' },
      approvalRef: 'approval:call-1',
    })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'writes nothing when the human answers %s, and says no extension was recorded',
    async outcome => {
      const h = await harness()
      await storeWithRoot(h, 2)
      h.answerWith(outcome as ApprovalOutcome)
      const before = await snapshot(h)
      const committed = JSON.stringify(storeEvents(h))
      const tool = defineTaskBudgetExtendTool(h.ctx as never)

      const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string

      expect(h.asks).toHaveLength(1)
      expect(result).toContain('task_budget_extend rejected:')
      expect(result).toContain('was not extended')
      expect(result).toContain('the ceilings are unchanged and no run started')
      // The store's own log is byte-for-byte what it was, its extension index is
      // empty, and the run facts are untouched. (The channel's audit pair on the
      // asking session's log is the channel's, not a store write.)
      expect(JSON.stringify(storeEvents(h))).toBe(committed)
      expect(budgetEvents(h)).toEqual([])
      expect((await snapshot(h)).budgetExtensions?.all).toEqual([])
      expect(await snapshot(h)).toEqual(before)
    },
  )

  it('asks a person again after a refusal: a rejection is not a cached answer', async () => {
    const h = await harness()
    await storeWithRoot(h, 2)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    h.answerWith('rejected')
    const denied = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string
    expect(denied).toContain('was not extended')
    expect(h.asks).toHaveLength(1)
    expect((await snapshot(h)).budgetExtensions?.all).toEqual([])

    // The same key, asked again: the refusal was recorded nowhere a repeat could
    // be answered from, so the question reaches a person once more — and this
    // time the answer approves.
    h.answerWith('allowed-once')
    const granted = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string
    expect(h.asks).toHaveLength(2)
    expect(granted).toContain('approved and recorded')
    expect((await snapshot(h)).budgetExtensions?.all).toHaveLength(1)
    expect(budgetEvents(h)).toHaveLength(1)
  })

  it('never reads a throwing channel as an approval: the failure reaches the tool and nothing is recorded', async () => {
    // The one way the native channel itself throws is a question asked outside
    // an open turn — its audit pair must be turn-enclosed, so the service
    // refuses before it dispatches anything. The callback deliberately lets that
    // propagate (rather than inventing a refusal of its own), so a failure of the
    // channel can never come back as a grant: the tool reports the rejection and
    // the store keeps nothing.
    const h = await harness()
    await storeWithRoot(h, 2)
    h.root.append('turn/end', {})
    const before = await snapshot(h)
    const committed = JSON.stringify(storeEvents(h))
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string

    expect(result).toContain('task_budget_extend rejected:')
    expect(result).toContain('outside an open turn')
    expect(h.asks).toEqual([])
    expect(JSON.stringify(storeEvents(h))).toBe(committed)
    expect(budgetEvents(h)).toEqual([])
    expect(await snapshot(h)).toEqual(before)
  })

  it('answers a repeated request from the record without a second human, and refuses the same key at other totals', async () => {
    const h = await harness()
    await storeWithRoot(h, 2)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const first = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string
    expect(first).toContain('approved and recorded')
    const committed = JSON.stringify(storeEvents(h))

    // The same call a second time — the retry a crash would produce: answered
    // from the record, nobody asked, nothing appended.
    const repeat = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION, 'call-2'))) as string
    expect(repeat).toContain(`already recorded on store "${STORE}"`)
    expect(repeat).toContain('no human was asked and nothing was appended')
    expect(repeat).toContain('- maxRuns: 10 → 20')
    expect(repeat).toContain('approval on the record: approval:call-1')
    expect(h.asks).toHaveLength(1)
    expect(JSON.stringify(storeEvents(h))).toBe(committed)
    expect((await snapshot(h)).budgetExtensions?.all).toHaveLength(1)

    // One key names one request: other totals under it are refused by name,
    // before anyone is asked and without a write.
    const conflicting = (await tool.execute({ requestKey: 'k-runs', maxRuns: 30 }, exec(h, ROOT_SESSION, 'call-3'))) as string
    expect(conflicting).toContain('task_budget_extend rejected:')
    expect(conflicting).toContain('already bound to a budget extension raising maxRuns 10 → 20')
    expect(h.asks).toHaveLength(1)
    expect(JSON.stringify(storeEvents(h))).toBe(committed)
  })

  it('refuses every request the service cannot grant without asking a human', async () => {
    const h = await harness()
    await storeWithRoot(h, 3)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const noDimension = (await tool.execute({ requestKey: 'k-none' }, exec(h, ROOT_SESSION))) as string
    expect(noDimension).toContain('names neither maxRuns nor deadlineAt')

    // A total below the ceiling is the increment this tool never accepts, and a
    // duration in words is not an instant: both are the runtime's refusals,
    // passed through by name rather than re-judged here.
    const increment = (await tool.execute({ requestKey: 'k-inc', maxRuns: 5 }, exec(h, ROOT_SESSION))) as string
    expect(increment).toContain('never an increment')
    const duration = (await tool.execute({ requestKey: 'k-time', deadlineAt: 'two more hours' }, exec(h, ROOT_SESSION))) as string
    expect(duration).toContain('is not an absolute instant')

    expect(h.asks).toEqual([])
    expect(budgetEvents(h)).toEqual([])
  })

  it('refuses a caller that is not the store\'s root coordination session, without asking a human', async () => {
    // A session whose graph names somebody else as its root: a worker's, or a
    // session of another graph. The store id is derived from the session, so the
    // refusal happens before any store is opened.
    const h = await harness({ graphRoot: 'another-root' })
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const refused = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, WORKER_SESSION))) as string
    expect(refused).toContain('task_budget_extend rejected:')
    expect(refused).toContain('is not a root coordination session')
    expect(h.asks).toEqual([])
    expect(budgetEvents(h)).toEqual([])

    // And a session no graph holds is refused the same way.
    const orphan = await harness({ graphsThrow: true })
    await storeWithRoot(orphan)
    const orphanTool = defineTaskBudgetExtendTool(orphan.ctx as never)
    const unresolved = (await orphanTool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(orphan, ROOT_SESSION))) as string
    expect(unresolved).toContain('its graph could not be resolved')
    expect(orphan.asks).toEqual([])
  })

  it('declares no argument that could approve anything, and refuses an undeclared one by name', async () => {
    const h = await harness()
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    // The whole declared surface: the request key and the two totals. No
    // `approved`, no `baseline`, no `callId`, no `approvalRef`, no note a model
    // could turn into a decision.
    const parameters = tool.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['requestKey', 'maxRuns', 'deadlineAt'])
    expect(parameters.required).toEqual(['requestKey'])

    for (const forged of ['baseline', 'callId', 'approvalRef', 'outcome', 'approved']) {
      const refused = (await tool.execute(
        { requestKey: 'k-runs', maxRuns: 20, [forged]: forged === 'baseline' ? { maxRuns: 10 } : 'made-up' },
        exec(h, ROOT_SESSION),
      )) as string
      expect(refused).toContain('undeclared parameter')
      expect(refused).toContain(`"${forged}"`)
      expect(refused).toContain('has no argument that approves')
    }
    expect(h.asks).toEqual([])
    expect(budgetEvents(h)).toEqual([])

    // A value of the wrong type never reaches the tool body: the schema refuses
    // it first, so nothing was read and nobody was asked.
    await expect(tool.execute({ requestKey: 'k-runs', maxRuns: 'twenty' }, exec(h, ROOT_SESSION)))
      .rejects.toThrow(/invalid arguments/)
    expect(h.asks).toEqual([])
  })

  it('hands the runtime the request and the host execution, and never asks the approval channel itself', async () => {
    // A scripted runtime: what the tool handed over is the whole assertion, and
    // the tool has nothing left to do with the answer but render it.
    const calls: Array<{ sessionId: string; host: unknown; request: unknown }> = []
    const extendRootBudget = vi.fn(async (sessionId: string, host: unknown, request: unknown): Promise<RootBudgetExtensionResult> => {
      calls.push({ sessionId, host, request })
      return { storeId: STORE, rootTaskId: 'root', answeredFromRecord: false, record: recordOf() }
    })
    const request = vi.fn(async () => 'allowed-once' as ApprovalOutcome)
    const ctx = new Context()
    ctx.provide('taskRuntime', { extendRootBudget } as never)
    ctx.provide('approval', { request } as never)
    const tool = defineTaskBudgetExtendTool(ctx as never)

    const call = { agent: { id: ROOT_SESSION }, callId: 'call-7', signal: new AbortController().signal }
    const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, call as never)) as string

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe(ROOT_SESSION)
    // The second argument is the host: the execution's own call id and the
    // handle itself, carried as it is — the runtime mints the question's
    // identity from it, and no caller-supplied stand-in travels beside it.
    const host = calls[0]?.host as { callId: string; execution: unknown }
    expect(host.callId).toBe('call-7')
    expect(host.execution).toBe(call)
    expect(calls[0]?.request).toEqual({ requestKey: 'k-runs', maxRuns: 20 })
    // The approval belongs to the installed callback: this tool never calls it,
    // whoever answers.
    expect(request).not.toHaveBeenCalled()
    expect(result).toContain('approved and recorded')
  })

  it('refuses a new request by name when this deployment installed no approval, with zero writes', async () => {
    // A runtime mounted without the assembly's installation: nobody can be
    // asked, so the runtime refuses rather than assuming a decision. The tool
    // reaches the channel nowhere itself — the answerer would have recorded an
    // ask had it done so.
    const h = await harness({ installApproval: false })
    await storeWithRoot(h, 2)
    const before = await snapshot(h)
    const committed = JSON.stringify(storeEvents(h))
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(h, ROOT_SESSION))) as string

    expect(result).toContain('task_budget_extend rejected:')
    expect(result).toContain('no approval channel installed')
    expect(result).toContain('the ceiling stays where it is')
    expect(h.asks).toEqual([])
    expect(JSON.stringify(storeEvents(h))).toBe(committed)
    expect(budgetEvents(h)).toEqual([])
    expect(await snapshot(h)).toEqual(before)
  })
})
