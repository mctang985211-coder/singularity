import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskInstance, TaskRun, TaskSnapshot } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, RootBudgetExtensionDraft } from '../../src/index.ts'
import { TaskRuntime, resolveRootBudget } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const WORKER_SESSION = 'worker-session'
const STORE = rootTaskStoreId(ROOT_SESSION)
/** The configured wall time (one hour) resolved against the root run's own start. */
const CONFIGURED_DEADLINE = '2026-09-16T01:00:00.000Z'
const APPROVED_DEADLINE = '2026-09-16T04:00:00.000Z'

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/**
 * A deployment with one graph whose root session is `ROOT_SESSION`, a task store
 * the runtime opens through the real service, and the root's own run already
 * started. Nothing here writes a root contract: what a budget extension needs is
 * the tree's root run — the instant its ceilings are measured from — and that is
 * the fixture.
 */
function harness(options: {
  config?: Partial<Config>
  sessions?: Map<string, StoredSession>
  /** The graph's root session, when a test wants a session that is not the one that accepted the tree. */
  graphRoot?: string
  /** Refuse the graph lookup entirely, as a session no graph can name. */
  graphsThrow?: boolean
} = {}) {
  const sessions = options.sessions ?? new Map<string, StoredSession>()
  const disposers: Array<() => unknown> = []
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }
  const graphs = {
    graphForSession: vi.fn(async (sessionId: string) => {
      if (options.graphsThrow === true) throw new Error(`no graph holds session "${sessionId}"`)
      return {
        id: 'g1',
        rootSessionId: options.graphRoot ?? ROOT_SESSION,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }
    }),
  }
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
    },
    emit: () => {},
    on: () => {},
    sessionPersistence: persistence,
    graphs,
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
  return { ctx, task, runtime, sessions, disposers, graphs }
}

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

const ROOT_BUDGET: Config['rootBudget'] = { wallTimeMs: 3_600_000, maxRuns: 10 }

/** A store holding the tree's root and one recorded run, built through the service's own entries. */
async function storeWithRoot(h: ReturnType<typeof harness>, runs = 1): Promise<void> {
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, rootTask(), 'test')
  await h.task.admitTaskIn(STORE, 'root', 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
  await h.task.startRunIn(STORE, rootRun(), 'test')
  for (let index = 2; index <= runs; index += 1) {
    const task: TaskInstance = {
      ...rootTask(),
      taskId: `child-${index}`,
      parentTaskId: 'root',
      depth: 1,
    }
    await h.task.createTaskIn(STORE, task, 'test')
    await h.task.admitTaskIn(STORE, `child-${index}`, 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
    await h.task.startRunIn(STORE, { ...rootRun(`r-${index}`), taskId: `child-${index}`, sessionId: `s-${index}` }, 'test')
  }
}

function events(h: ReturnType<typeof harness>): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

/** The run ceiling the store's facts leave in force, read through the one resolver that enforces it. */
function effectiveMaxRuns(snapshot: TaskSnapshot): number | undefined {
  const resolution = resolveRootBudget(snapshot, ROOT_BUDGET as NonNullable<Config['rootBudget']>)
  if (!resolution.ok) throw new Error(`the budget did not resolve: ${resolution.reason}`)
  return resolution.maxRuns
}

/** The run/status facts an extension may never touch. */
function runFacts(snapshot: TaskSnapshot): unknown {
  return snapshot.runs.map(run => ({ runId: run.runId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt }))
}

async function draft(h: ReturnType<typeof harness>, request: Parameters<TaskRuntime['budgetExtensionDraft']>[1]): Promise<RootBudgetExtensionDraft> {
  return await h.runtime.budgetExtensionDraft(ROOT_SESSION, request)
}

/** The proposal the draft would commit, or a failure naming the refusal it got instead. */
function proposed(outcome: RootBudgetExtensionDraft['outcome']) {
  if (outcome.kind !== 'proposed') throw new Error(`expected a proposal, got ${JSON.stringify(outcome)}`)
  return outcome.proposal
}

describe('budgetExtensionDraft', () => {
  test('reads the ceilings and the usage, and writes nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    const before = await h.task.snapshotIn(STORE)
    const persisted = events(h).length

    const reported = await draft(h, { requestKey: 'k-1', maxRuns: 20 })
    expect(reported.storeId).toBe(STORE)
    expect(reported.rootTaskId).toBe('root')
    expect(reported.rootSessionId).toBe(ROOT_SESSION)
    expect(reported.configured).toEqual({ deadlineAt: CONFIGURED_DEADLINE, maxRuns: 10 })
    expect(reported.effective).toEqual({ deadlineAt: CONFIGURED_DEADLINE, maxRuns: 10 })
    expect(reported.runsUsed).toBe(3)
    expect(proposed(reported.outcome).maxRuns).toEqual({ previous: 10, next: 20 })
    expect(proposed(reported.outcome).requestKey).toBe('k-1')

    expect(events(h).length).toBe(persisted)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
  })

  test('answers a request the store already holds from the record, and refuses the same key at other totals', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h)
    const first = await draft(h, { requestKey: 'k-1', maxRuns: 20 })
    await h.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-1',
      maxRuns: 20,
      baseline: { maxRuns: 10 },
      approvalRef: 'approval:call-1',
    })

    const repeat = await draft(h, { requestKey: 'k-1', maxRuns: 20 })
    expect(repeat.outcome.kind).toBe('recorded')
    if (repeat.outcome.kind !== 'recorded') throw new Error('unreachable')
    expect(repeat.outcome.record.maxRuns).toEqual({ previous: 10, next: 20 })
    // The reading moved with the grant, and the query still reports both numbers.
    expect(repeat.effective.maxRuns).toBe(20)
    expect(repeat.configured.maxRuns).toBe(10)

    const conflicting = await draft(h, { requestKey: 'k-1', maxRuns: 30 })
    expect(conflicting.outcome.kind).toBe('refused')
    if (conflicting.outcome.kind !== 'refused') throw new Error('unreachable')
    expect(conflicting.outcome.reason).toContain('already bound to a budget extension raising maxRuns 10 → 20')
    expect(first.outcome.kind).toBe('proposed')
  })

  test('refuses every request that is not a raise of a configured ceiling', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)

    const reasons: Record<string, string> = {
      'no dimension': (await draft(h, { requestKey: 'k-none' })).outcome.kind === 'refused'
        ? ((await draft(h, { requestKey: 'k-none' })).outcome as { reason: string }).reason
        : '',
      'no key': ((await draft(h, { requestKey: '', maxRuns: 20 })).outcome as { reason: string }).reason,
      'fractional total': ((await draft(h, { requestKey: 'k-frac', maxRuns: 12.5 })).outcome as { reason: string }).reason,
      'not above the ceiling': ((await draft(h, { requestKey: 'k-low', maxRuns: 10 })).outcome as { reason: string }).reason,
      'increment read as a total': ((await draft(h, { requestKey: 'k-inc', maxRuns: 5 })).outcome as { reason: string }).reason,
      'local time': ((await draft(h, { requestKey: 'k-local', deadlineAt: '2026-09-16T04:00:00' })).outcome as { reason: string }).reason,
      'duration in words': ((await draft(h, { requestKey: 'k-words', deadlineAt: 'two more hours' })).outcome as { reason: string }).reason,
      'deadline not later': ((await draft(h, { requestKey: 'k-earlier', deadlineAt: '2026-09-16T00:30:00.000Z' })).outcome as { reason: string }).reason,
    }
    expect(reasons['no dimension']).toContain('names neither maxRuns nor deadlineAt')
    expect(reasons['no key']).toContain('non-empty request key')
    expect(reasons['fractional total']).toContain('not a positive whole number of runs')
    expect(reasons['not above the ceiling']).toContain('does not raise the 10 in force')
    expect(reasons['increment read as a total']).toContain('never an increment')
    expect(reasons['local time']).toContain('is not an absolute instant')
    expect(reasons['duration in words']).toContain('is not an absolute instant')
    expect(reasons['deadline not later']).toContain('is not later than the 2026-09-16T01:00:00.000Z in force')
  })

  test('refuses a dimension this deployment leaves unlimited, naming it', async () => {
    // A budget with a run ceiling only: naming the deadline asks for a limit
    // nobody set, and the answer says so rather than inventing one.
    const h = harness({ config: { rootBudget: { maxRuns: 10 } } })
    await storeWithRoot(h)
    const refused = await draft(h, { requestKey: 'k-deadline', deadlineAt: APPROVED_DEADLINE })
    expect(refused.outcome.kind).toBe('refused')
    if (refused.outcome.kind !== 'refused') throw new Error('unreachable')
    expect(refused.outcome.reason).toContain('sets no deadlineAt ceiling')
    expect(refused.effective).toEqual({ maxRuns: 10 })

    // And the other way round, with no run ceiling configured.
    const other = harness({ config: { rootBudget: { wallTimeMs: 3_600_000 } } })
    await storeWithRoot(other)
    const runsRefused = await draft(other, { requestKey: 'k-runs', maxRuns: 20 })
    expect(runsRefused.outcome.kind).toBe('refused')
    if (runsRefused.outcome.kind !== 'refused') throw new Error('unreachable')
    expect(runsRefused.outcome.reason).toContain('sets no maxRuns ceiling')
  })

  test('refuses a caller that is not the store\u2019s root coordination session', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET }, graphRoot: ROOT_SESSION })
    await storeWithRoot(h)
    // A worker: the graph's root session is another session, so this one cannot
    // reach the tree's budget at all.
    await expect(h.runtime.budgetExtensionDraft(WORKER_SESSION, { requestKey: 'k-1', maxRuns: 20 }))
      .rejects.toThrow(/is not a root coordination session \(its graph's root session is "root-session"\)/)
    // A session no graph holds: the same refusal, before any store is opened.
    const orphan = harness({ config: { rootBudget: ROOT_BUDGET }, graphsThrow: true })
    await storeWithRoot(orphan)
    await expect(orphan.runtime.budgetExtensionDraft(ROOT_SESSION, { requestKey: 'k-1', maxRuns: 20 }))
      .rejects.toThrow(/its graph could not be resolved/)
    // A store this session's graph does not own: the store id is derived from the
    // graph's root session, so a stranger's session reads nothing.
    const stranger = harness({ config: { rootBudget: ROOT_BUDGET }, graphRoot: 'another-root' })
    await expect(stranger.runtime.budgetExtensionDraft(ROOT_SESSION, { requestKey: 'k-1', maxRuns: 20 }))
      .rejects.toThrow(/is not a root coordination session/)
  })
})

describe('extendRootBudget', () => {
  test('records the approved raise, and only the raise: no run, no task, no usage moves', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    const before = await h.task.snapshotIn(STORE)
    const reading = await draft(h, { requestKey: 'k-more-time', deadlineAt: APPROVED_DEADLINE })

    const record = await h.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-more-time',
      deadlineAt: APPROVED_DEADLINE,
      baseline: reading.effective,
      approvalRef: 'approval:call-9',
    })
    expect(record.deadlineAt).toEqual({ previous: CONFIGURED_DEADLINE, next: APPROVED_DEADLINE })
    expect(record.approvalRef).toBe('approval:call-9')
    expect(record.requestedBy).toBe(ROOT_SESSION)
    expect(record.recordedAt).toBeDefined()

    const after = await h.task.snapshotIn(STORE)
    expect(after.budgetExtensions?.all).toHaveLength(1)
    expect(runFacts(after)).toEqual(runFacts(before))
    expect(after.tasks.map(task => task.status)).toEqual(before.tasks.map(task => task.status))
    expect(after.runs).toHaveLength(before.runs.length)

    // The ceiling every path reads is now the approved one, and the deployment's
    // own total is still readable beside it.
    const resolution = resolveRootBudget(after, ROOT_BUDGET)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('unreachable')
    expect(resolution.deadlineAt).toBe(APPROVED_DEADLINE)
    expect(resolution.configured.deadlineAt).toBe(CONFIGURED_DEADLINE)
    expect(resolution.maxRuns).toBe(10)
  })

  test('a repeat of the same commit returns the stored record and appends nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 2)
    const reading = await draft(h, { requestKey: 'k-runs', maxRuns: 20 })
    const commit = { requestKey: 'k-runs', maxRuns: 20, baseline: { maxRuns: reading.effective.maxRuns as number }, approvalRef: 'approval:call-1' }
    const first = await h.runtime.extendRootBudget(ROOT_SESSION, commit)
    const persisted = events(h).length

    const repeat = await h.runtime.extendRootBudget(ROOT_SESSION, commit)
    expect(repeat).toEqual(first)
    expect(events(h).length).toBe(persisted)
    expect((await h.task.snapshotIn(STORE)).budgetExtensions?.all).toHaveLength(1)
    // The service-level entry is idempotent on its own as well: a second write of
    // the same claim is answered from the record.
    await h.task.recordBudgetExtensionIn(STORE, 'root', {
      requestKey: 'k-runs',
      requestDigest: first.requestDigest,
      maxRuns: { previous: 10, next: 20 },
      approvalRef: 'approval:call-1',
      requestedBy: ROOT_SESSION,
    }, ROOT_SESSION)
    expect(events(h).length).toBe(persisted)
  })

  test('refuses a commit with no approval, a stale reading, a non-raise or an unlimited dimension, writing nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    const persisted = events(h).length
    const refuse = async (commit: Parameters<TaskRuntime['extendRootBudget']>[1]): Promise<string> => {
      try {
        await h.runtime.extendRootBudget(ROOT_SESSION, commit)
        throw new Error(`the commit was accepted: ${JSON.stringify(commit)}`)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    // The channel's fact is the one thing a grant cannot be made without.
    expect(await refuse({ requestKey: 'k-1', maxRuns: 20, baseline: { maxRuns: 10 }, approvalRef: '' }))
      .toContain('carries no approval reference')
    // The reading the person approved against has to be the reading in force.
    expect(await refuse({ requestKey: 'k-2', maxRuns: 20, baseline: { maxRuns: 4 }, approvalRef: 'approval:call-1' }))
      .toContain('maxRuns moved since this request was read')
    // The baseline has to name the dimension the request raises.
    expect(await refuse({ requestKey: 'k-3', maxRuns: 20, baseline: {}, approvalRef: 'approval:call-1' }))
      .toContain('does not say what maxRuns was when it was read')
    expect(await refuse({ requestKey: 'k-4', maxRuns: 9, baseline: { maxRuns: 10 }, approvalRef: 'approval:call-1' }))
      .toContain('does not raise the 10 in force')
    // The unlimited dimension of a different budget: refused by name, never granted.
    const unlimited = harness({ config: { rootBudget: { maxRuns: 10 } } })
    await storeWithRoot(unlimited)
    await expect(unlimited.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-6',
      deadlineAt: APPROVED_DEADLINE,
      baseline: {},
      approvalRef: 'approval:call-1',
    })).rejects.toThrow(/sets no deadlineAt ceiling/)

    expect(events(h).length).toBe(persisted)
    expect((await h.task.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('two commits approved against one reading cannot both stand', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    // Both requests were read at the same ceiling (10) — the shape a person
    // approves twice, or a retry that raced another caller.
    const first = { requestKey: 'k-a', maxRuns: 20, baseline: { maxRuns: 10 }, approvalRef: 'approval:call-a' }
    const second = { requestKey: 'k-b', maxRuns: 25, baseline: { maxRuns: 10 }, approvalRef: 'approval:call-b' }
    await h.runtime.extendRootBudget(ROOT_SESSION, first)
    await expect(h.runtime.extendRootBudget(ROOT_SESSION, second))
      .rejects.toThrow(/maxRuns moved since this request was read: it was read at 10 and it is 20 in force now/)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.budgetExtensions?.all.map(entry => entry.requestKey)).toEqual(['k-a'])
    expect(effectiveMaxRuns(snapshot)).toBe(20)

    // The same second request, re-read against the value in force, is a new
    // request: it lands as its own total, never as the two raises added up.
    await h.runtime.extendRootBudget(ROOT_SESSION, { ...second, baseline: { maxRuns: 20 } })
    expect(effectiveMaxRuns(await h.task.snapshotIn(STORE))).toBe(25)
  })

  test('a raise survives a reopen of the store, and the deadline is not recomputed from the restart', async () => {
    const first = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(first, 2)
    await first.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-more-time',
      deadlineAt: APPROVED_DEADLINE,
      baseline: { deadlineAt: CONFIGURED_DEADLINE },
      approvalRef: 'approval:call-1',
    })
    const before = await first.task.snapshotIn(STORE)
    await Promise.all(first.disposers.map(dispose => dispose()))

    // A new process, the same store: the approved ceiling is a fact of the log.
    const reopened = harness({ config: { rootBudget: ROOT_BUDGET }, sessions: first.sessions })
    const snapshot = await reopened.task.openStore(STORE)
    const resolution = resolveRootBudget(snapshot, ROOT_BUDGET)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('unreachable')
    expect(resolution.deadlineAt).toBe(APPROVED_DEADLINE)
    expect(resolution.acceptedAt).toBe(before.runs[0]?.startedAt)
    expect(resolution.configured.deadlineAt).toBe(CONFIGURED_DEADLINE)
    expect(snapshot.runs.map(run => run.startedAt)).toEqual(before.runs.map(run => run.startedAt))

    // And the query in the new process reports the same two ceilings.
    const reported = await reopened.runtime.budgetExtensionDraft(ROOT_SESSION, { requestKey: 'k-next', maxRuns: 12 })
    expect(reported.effective).toEqual({ deadlineAt: APPROVED_DEADLINE, maxRuns: 10 })
    expect(reported.configured).toEqual({ deadlineAt: CONFIGURED_DEADLINE, maxRuns: 10 })
  })

  test('a store whose tree has no root run is refused by the resolver\u2019s own words', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await h.task.createStore(STORE)
    await expect(h.runtime.budgetExtensionDraft(ROOT_SESSION, { requestKey: 'k-1', maxRuns: 20 }))
      .rejects.toThrow(/cannot be extended: store .* holds no root task/)
  })
})
