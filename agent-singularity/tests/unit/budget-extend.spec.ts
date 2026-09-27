import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskBudgetExtensionClaim, TaskInstance, TaskRun, TaskSnapshot } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config } from '../../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../../task-runtime/src/index.ts'
import { defineTaskBudgetExtendTool } from '../../src/tools/budget-extend.ts'

/**
 * `task_budget_extend` (K4) against the real service and a driven human seam.
 *
 * The tool is the one door a person's decision travels through: it reads the
 * store through the runtime's zero-write query, shows what it read on the
 * approval card, and hands the approved raise back to the runtime's committing
 * entry. What each case pins is therefore the tool's own responsibility — that
 * the card carries the store, both ceilings and the usage; that a refusal,
 * rejection or cancellation writes nothing at all; that a repeat of a recorded
 * request is answered without a second human; and that no argument of this tool
 * can stand in for an approval.
 *
 * Everything the tool talks to is the deployment's: the real `TaskService` and
 * the real `TaskRuntime` (the same harness shape `task-runtime/tests/unit/
 * budget-extension.spec.ts` uses), a store built through the service's own
 * entries, and the native approval seam as a fake — the one seam a spec is
 * supposed to drive, because a person is not available in a test.
 */

const NOW = '2026-09-16T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const WORKER_SESSION = 'worker-session'
const STORE = rootTaskStoreId(ROOT_SESSION)
/** The configured wall time (one hour) resolved against the root run's own start. */
const CONFIGURED_DEADLINE = '2026-09-16T01:00:00.000Z'
const ROOT_BUDGET: Config['rootBudget'] = { wallTimeMs: 3_600_000, maxRuns: 10 }

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/**
 * The deployment one call runs in: a graph whose root session is `ROOT_SESSION`,
 * a task store the runtime opens through the real service, the root's own run
 * already started, and the approval seam a spec answers through.
 */
function harness(options: { graphRoot?: string; graphsThrow?: boolean } = {}) {
  const sessions = new Map<string, StoredSession>()
  const handle = (stored: StoredSession) => ({
    read: async () => ({ events: stored.events }),
    append: async (events: readonly SessionEvent[]) => { stored.events.push(...events) },
    flush: async () => {},
    close: async () => {},
  })
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: () => {},
    emit: () => {},
    on: () => {},
    sessionPersistence: {
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
    },
    graphs: {
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
    },
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(ctx as never, { rootBudget: { ...ROOT_BUDGET } })
  ctx.taskRuntime = runtime
  const approval = { request: vi.fn(async (_request: unknown) => 'allowed-once') }
  ctx.approval = approval
  return { ctx, task, runtime, approval, sessions }
}

type Harness = ReturnType<typeof harness>

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

/** Every event the deployment committed, the store's own log included. */
function events(h: Harness): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

function budgetEvents(h: Harness): TaskBudgetExtensionClaim[] {
  return events(h).flatMap(event => {
    if (event.type !== 'task/event') return []
    const task = event.data as { kind?: string; payload?: { extension?: TaskBudgetExtensionClaim } }
    return task.kind === 'TaskBudgetExtended' && task.payload?.extension !== undefined ? [task.payload.extension] : []
  })
}

async function snapshot(h: Harness): Promise<TaskSnapshot> {
  return await h.task.snapshotIn(STORE)
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

/** The one card the tool asked, as the seam recorded it. */
function card(h: Harness): string {
  expect(h.approval.request).toHaveBeenCalledTimes(1)
  return (h.approval.request.mock.calls[0]![0] as { reason: string }).reason
}

describe('task_budget_extend', () => {
  it('asks a person once, on a card naming the store, both ceilings and the runs used, and records what they approved', async () => {
    const h = harness()
    await storeWithRoot(h, 3)
    const before = await snapshot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(ROOT_SESSION))) as string

    // The card is what a person decides from: which store, the ceiling in force
    // and the one the deployment configured beside it, the usage that is never
    // reset, and the total this approval would put in place.
    const asked = card(h)
    expect(asked).toContain(`store "${STORE}"`)
    expect(asked).toContain('root task root')
    expect(asked).toContain(`root coordination session ${ROOT_SESSION}`)
    expect(asked).toContain('request key "k-runs"')
    expect(asked).toContain('runs the store already holds: 3')
    expect(asked).toContain('maxRuns: 10 in force (deployment configures 10) → approves a total of 20')
    expect(asked).toContain(`deadlineAt: ${CONFIGURED_DEADLINE} in force (deployment configures ${CONFIGURED_DEADLINE}) — this request does not name it`)
    expect(asked).toContain('approving records ONE budget-extension event')

    expect(result).toContain(`approved and recorded on store "${STORE}"`)
    expect(result).toContain('request key "k-runs"')
    expect(result).toContain('- maxRuns: 10 → 20')
    expect(result).toContain(`approval on the record: approval:call-1 — asked by ${ROOT_SESSION}`)

    // The durable fact is the store's: one event, one record, attributed to the
    // approving channel's reference — and the run/task facts are untouched.
    const recorded = await snapshot(h)
    expect(recorded.budgetExtensions?.all).toHaveLength(1)
    expect(recorded.budgetExtensions?.byRequestKey['k-runs']).toMatchObject({
      requestKey: 'k-runs',
      maxRuns: { previous: 10, next: 20 },
      approvalRef: 'approval:call-1',
      requestedBy: ROOT_SESSION,
    })
    expect(recorded.budgetExtensions?.byRequestKey['k-runs']?.recordedAt).toBeDefined()
    expect(recorded.runs).toEqual(before.runs)
    expect(recorded.tasks).toEqual(before.tasks)
    expect(budgetEvents(h)).toHaveLength(1)
    expect(budgetEvents(h)[0]).toMatchObject({ requestKey: 'k-runs', approvalRef: 'approval:call-1' })
  })

  it('records an approved deadline as the absolute instant the person was shown', async () => {
    const h = harness()
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    // The request may spell the instant with any legal zone designator: what the
    // card shows and what the store keeps is the canonical one.
    const result = (await tool.execute({ requestKey: 'k-time', deadlineAt: '2026-09-16T12:00:00+08:00' }, exec(ROOT_SESSION))) as string

    expect(card(h)).toContain(`deadlineAt: ${CONFIGURED_DEADLINE} in force (deployment configures ${CONFIGURED_DEADLINE}) → approves a total of 2026-09-16T04:00:00.000Z`)
    expect(result).toContain('- deadlineAt: 2026-09-16T01:00:00.000Z → 2026-09-16T04:00:00.000Z')
    expect((await snapshot(h)).budgetExtensions?.byRequestKey['k-time']).toMatchObject({
      deadlineAt: { previous: CONFIGURED_DEADLINE, next: '2026-09-16T04:00:00.000Z' },
      approvalRef: 'approval:call-1',
    })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'writes nothing when the human answers %s',
    async outcome => {
      const h = harness()
      await storeWithRoot(h, 2)
      h.approval.request.mockResolvedValue(outcome)
      const before = await snapshot(h)
      const committed = events(h).length
      const tool = defineTaskBudgetExtendTool(h.ctx as never)

      const result = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(ROOT_SESSION))) as string

      expect(h.approval.request).toHaveBeenCalledTimes(1)
      expect(result).toContain('no extension recorded')
      expect(result).toContain('the ceilings are unchanged')
      expect(events(h).length).toBe(committed)
      expect(budgetEvents(h)).toEqual([])
      expect((await snapshot(h)).budgetExtensions?.all).toEqual([])
      expect((await snapshot(h)).runs).toEqual(before.runs)
    },
  )

  it('answers a repeated request from the record without a second human, and refuses the same key at other totals', async () => {
    const h = harness()
    await storeWithRoot(h, 2)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const first = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(ROOT_SESSION))) as string
    expect(first).toContain('approved and recorded')
    const committed = events(h).length

    const repeat = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(ROOT_SESSION))) as string
    expect(repeat).toContain('already recorded')
    expect(repeat).toContain('no human was asked and nothing was appended')
    expect(repeat).toContain('- maxRuns: 10 → 20')
    // One ask, one event: the retry is answered from the record.
    expect(h.approval.request).toHaveBeenCalledTimes(1)
    expect(events(h).length).toBe(committed)
    expect((await snapshot(h)).budgetExtensions?.all).toHaveLength(1)

    const conflicting = (await tool.execute({ requestKey: 'k-runs', maxRuns: 30 }, exec(ROOT_SESSION))) as string
    expect(conflicting).toContain('task_budget_extend refused:')
    expect(conflicting).toContain('already bound to a budget extension raising maxRuns 10 → 20')
    expect(conflicting).toContain('no human was asked and nothing was written')
    expect(h.approval.request).toHaveBeenCalledTimes(1)
    expect(events(h).length).toBe(committed)
  })

  it('refuses every request the service cannot grant without asking a human', async () => {
    const h = harness()
    await storeWithRoot(h, 3)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const noDimension = (await tool.execute({ requestKey: 'k-none' }, exec(ROOT_SESSION))) as string
    expect(noDimension).toContain('names neither maxRuns nor deadlineAt')
    expect(noDimension).toContain('no human was asked and nothing was written')

    // A total below the ceiling is the increment this tool never accepts, and a
    // duration in words is not an instant: both are the service's refusals,
    // passed through by name rather than re-judged here.
    const increment = (await tool.execute({ requestKey: 'k-inc', maxRuns: 5 }, exec(ROOT_SESSION))) as string
    expect(increment).toContain('never an increment')
    const duration = (await tool.execute({ requestKey: 'k-time', deadlineAt: 'two more hours' }, exec(ROOT_SESSION))) as string
    expect(duration).toContain('is not an absolute instant')

    expect(h.approval.request).not.toHaveBeenCalled()
    expect(events(h).filter(event => event.type === 'TaskBudgetExtended')).toEqual([])
  })

  it('refuses a caller that is not the store\'s root coordination session, without asking a human', async () => {
    // A session whose graph names somebody else as its root: a worker's, or a
    // session of another graph. The store id is derived from the session, so the
    // refusal happens before any store is opened.
    const h = harness({ graphRoot: 'another-root' })
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    const refused = (await tool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(WORKER_SESSION))) as string
    expect(refused).toContain('task_budget_extend rejected:')
    expect(refused).toContain('is not a root coordination session')
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(budgetEvents(h)).toEqual([])

    // And a session no graph holds is refused the same way.
    const orphan = harness({ graphsThrow: true })
    await storeWithRoot(orphan)
    const orphanTool = defineTaskBudgetExtendTool(orphan.ctx as never)
    const unresolved = (await orphanTool.execute({ requestKey: 'k-runs', maxRuns: 20 }, exec(ROOT_SESSION))) as string
    expect(unresolved).toContain('its graph could not be resolved')
    expect(orphan.approval.request).not.toHaveBeenCalled()
  })

  it('declares no argument that could approve anything, and refuses an undeclared one by name', async () => {
    const h = harness()
    await storeWithRoot(h)
    const tool = defineTaskBudgetExtendTool(h.ctx as never)

    // The whole declared surface: the request key and the two totals. No
    // `approved`, no `approvalRef`, no note a model could turn into a decision.
    const parameters = tool.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['requestKey', 'maxRuns', 'deadlineAt'])
    expect(parameters.required).toEqual(['requestKey'])

    for (const forged of [{ approved: true }, { approvalRef: 'approval:call-9' }, { increment: 5 }]) {
      const refused = (await tool.execute(
        { requestKey: 'k-runs', maxRuns: 20, ...forged },
        exec(ROOT_SESSION),
      )) as string
      expect(refused).toContain('undeclared parameter')
      expect(refused).toContain('has no argument that approves')
    }
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(events(h).filter(event => event.type === 'TaskBudgetExtended')).toEqual([])

    // A value of the wrong type never reaches the tool body: the schema refuses
    // it first, so nothing was read and nobody was asked.
    await expect(tool.execute({ requestKey: 'k-runs', maxRuns: 'twenty' }, exec(ROOT_SESSION)))
      .rejects.toThrow(/invalid arguments/)
    expect(h.approval.request).not.toHaveBeenCalled()
  })
})
