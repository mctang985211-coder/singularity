import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskInstance, TaskRun, TaskSnapshot } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, RootBudgetExtensionDraft } from '../../src/index.ts'
import { TaskRuntime, budgetExtensionApprovalBinding, resolveRootBudget } from '../../src/index.ts'

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
    // The read view of one session's own log (`sessionQuery.readSession`), which
    // is where the committing entry looks for the approval channel's record.
    sessionQuery: {
      readSession: async (id: SessionId) => ({ session: { id }, inheritedEventCount: 0, events: sessions.get(String(id))?.events ?? [] }),
    },
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
  return { ctx, task, runtime, sessions, disposers, graphs }
}

/** The stored log of one session, created on first use — the surface the channel's record lands on. */
function logOf(h: ReturnType<typeof harness>, sessionId: string): SessionEvent[] {
  const existing = h.sessions.get(sessionId)
  if (existing !== undefined) return existing.events
  const stored: StoredSession = { header: { id: sessionId } as SessionHeader, events: [] }
  h.sessions.set(sessionId, stored)
  return stored.events
}

/**
 * One decision, recorded the way the approval service records it: a fresh
 * `ApprovalRequestId` (its own, service-issued), the `approval/asked` naming the
 * tool and the call with the asker's own words as its reason, and the
 * `approval/decided` that pairs with it.
 *
 * This is what the committing entry reads an approval back out of — the whole
 * point of the check, so a spec that wants a grant records the decision for the
 * exact binding the runtime will commit, and a spec that wants a refusal records
 * one that is not it (another store, another request, another tool, or no
 * allowed decision at all). The request id is a `randomUUID` because the
 * channel's is: nothing a caller could guess or choose.
 * @returns the `ApprovalRequestId` the record carries.
 */
function recordDecision(
  h: ReturnType<typeof harness>,
  sessionId: string,
  decision: { readonly callId: string; readonly reason: string; readonly outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; readonly toolName?: string },
): string {
  const id = randomUUID()
  const log = logOf(h, sessionId)
  log.push({ type: 'approval/asked', seq: log.length, time: Date.now(), data: { id, toolName: decision.toolName ?? 'task_budget_extend', callId: decision.callId, reason: decision.reason } } as unknown as SessionEvent)
  log.push({ type: 'approval/decided', seq: log.length, time: Date.now(), data: { id, outcome: decision.outcome ?? 'allowed-once' } } as unknown as SessionEvent)
  return id
}

/** The binding one draft would be approved under — the token the asking tool renders onto the card. */
function bindingOf(draft: RootBudgetExtensionDraft): string {
  if (draft.approvalBinding === undefined) throw new Error('the draft carries no approval binding')
  return draft.approvalBinding
}

/** The one thing the committing entry reads back out of the asker's card: the binding it is approved under. */
function cardOf(draft: RootBudgetExtensionDraft): string {
  return `Budget extension of store "${draft.storeId}" — approval binding: ${bindingOf(draft)}`
}

/** What one draft's own store-derived identity is, for a spec that wants to record a decision for another one. */
function anotherStoresCard(proposal: { requestDigest: string }): string {
  return `Budget extension of store "sg-t-somebody-else" — approval binding: ${budgetExtensionApprovalBinding('sg-t-somebody-else', proposal.requestDigest)}`
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
    recordDecision(h, ROOT_SESSION, { callId: 'call-1', reason: cardOf(first) })
    await h.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-1',
      maxRuns: 20,
      baseline: { maxRuns: 10 },
      callId: 'call-1',
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
    const approved = recordDecision(h, ROOT_SESSION, { callId: 'call-9', reason: cardOf(reading) })

    const record = await h.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-more-time',
      deadlineAt: APPROVED_DEADLINE,
      baseline: reading.effective,
      callId: 'call-9',
    })
    expect(record.deadlineAt).toEqual({ previous: CONFIGURED_DEADLINE, next: APPROVED_DEADLINE })
    // The record keeps the channel's own identity, read back out of its record of
    // the ask — never the call id the caller handed over.
    expect(record.approvalRef).toBe(`approval:${approved}`)
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

  test('refuses every approval the channel did not record for this store, this request and this call, writing nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    const before = await h.task.snapshotIn(STORE)
    const persisted = events(h).filter(event => event.type === 'task/event').length
    const reading = await draft(h, { requestKey: 'k-forged', maxRuns: 20 })
    const refuse = async (callId: string): Promise<string> => {
      try {
        await h.runtime.extendRootBudget(ROOT_SESSION, {
          requestKey: 'k-forged',
          maxRuns: 20,
          baseline: reading.effective,
          callId,
        })
        throw new Error(`the commit was accepted for call "${callId}"`)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    // A public caller can name any call it likes. Nothing the channel recorded
    // under that name is a grant — and the entry decides that itself, before the
    // store is written.
    expect(await refuse('made-up')).toContain('holds no ask of task_budget_extend')

    // An approval of *another store*: the binding covers the store the caller's
    // own session derives, so an ask about somebody else's tree is not this one.
    recordDecision(h, ROOT_SESSION, { callId: 'call-other-store', reason: anotherStoresCard(proposed(reading.outcome)) })
    expect(await refuse('call-other-store')).toContain('holds no ask of task_budget_extend')

    // An approval of *another request*: same call name, the request key or the
    // totals differ, so the binding the person read is not this request's.
    const otherRequest = await draft(h, { requestKey: 'k-forged', maxRuns: 30 })
    recordDecision(h, ROOT_SESSION, { callId: 'call-other-request', reason: cardOf(otherRequest) })
    expect(await refuse('call-other-request')).toContain('holds no ask of task_budget_extend')

    // An approval *another tool* asked for: the tool the ask names is part of
    // what the entry requires, so one gate's decision cannot open another's.
    recordDecision(h, ROOT_SESSION, { callId: 'call-other-tool', toolName: 'hitl_approve', reason: cardOf(reading) })
    expect(await refuse('call-other-tool')).toContain('holds no ask of task_budget_extend')

    // The question was asked for exactly this request and call, and the person
    // refused it (or it was cancelled, or nobody answered).
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const callId = `call-${outcome}`
      recordDecision(h, ROOT_SESSION, { callId, reason: cardOf(reading), outcome })
      expect(await refuse(callId)).toContain('recorded no allowed decision')
    }

    // And an approval recorded in somebody else's session is not this session's:
    // the entry reads the caller's own log.
    recordDecision(h, WORKER_SESSION, { callId: 'call-elsewhere', reason: cardOf(reading) })
    expect(await refuse('call-elsewhere')).toContain('holds no ask of task_budget_extend')

    expect(events(h).filter(event => event.type === 'task/event').length).toBe(persisted)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
  })

  test('refuses a commit that names no call, and a log the deployment cannot read, writing nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    const before = await h.task.snapshotIn(STORE)

    // The identity of the call is what the entry looks up; without one there is
    // nothing to look up, and no grant.
    await expect(h.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-empty',
      maxRuns: 20,
      baseline: { maxRuns: 10 },
      callId: '',
    })).rejects.toThrow(/names no tool call/)

    // A deployment whose approval record cannot be read at all refuses the same
    // way: an approval nobody can verify is not one this entry may assume.
    const blind = harness({ config: { rootBudget: ROOT_BUDGET } })
    delete (blind.ctx as { sessionQuery?: unknown }).sessionQuery
    await storeWithRoot(blind, 2)
    const blindBefore = await blind.task.snapshotIn(STORE)
    const reading = await draft(blind, { requestKey: 'k-blind', maxRuns: 20 })
    recordDecision(blind, ROOT_SESSION, { callId: 'call-blind', reason: cardOf(reading) })
    await expect(blind.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-blind',
      maxRuns: 20,
      baseline: reading.effective,
      callId: 'call-blind',
    })).rejects.toThrow(/cannot be read/)

    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(await blind.task.snapshotIn(STORE)).toEqual(blindBefore)
    expect((await blind.task.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('a repeat of the same commit returns the stored record and appends nothing', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 2)
    const reading = await draft(h, { requestKey: 'k-runs', maxRuns: 20 })
    const approved = recordDecision(h, ROOT_SESSION, { callId: 'call-1', reason: cardOf(reading) })
    const commit = { requestKey: 'k-runs', maxRuns: 20, baseline: { maxRuns: reading.effective.maxRuns as number }, callId: 'call-1' }
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
      approvalRef: `approval:${approved}`,
      requestedBy: ROOT_SESSION,
    }, ROOT_SESSION)
    expect(events(h).length).toBe(persisted)
  })

  test('refuses a commit with a stale reading, a non-raise or an unlimited dimension, writing nothing', async () => {
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

    // The reading the person approved against has to be the reading in force.
    expect(await refuse({ requestKey: 'k-2', maxRuns: 20, baseline: { maxRuns: 4 }, callId: 'call-1' }))
      .toContain('maxRuns moved since this request was read')
    // The baseline has to name the dimension the request raises.
    expect(await refuse({ requestKey: 'k-3', maxRuns: 20, baseline: {}, callId: 'call-1' }))
      .toContain('does not say what maxRuns was when it was read')
    expect(await refuse({ requestKey: 'k-4', maxRuns: 9, baseline: { maxRuns: 10 }, callId: 'call-1' }))
      .toContain('does not raise the 10 in force')
    // The unlimited dimension of a different budget: refused by name, never granted.
    const unlimited = harness({ config: { rootBudget: { maxRuns: 10 } } })
    await storeWithRoot(unlimited)
    await expect(unlimited.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-6',
      deadlineAt: APPROVED_DEADLINE,
      baseline: {},
      callId: 'call-1',
    })).rejects.toThrow(/sets no deadlineAt ceiling/)

    expect(events(h).length).toBe(persisted)
    expect((await h.task.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('two commits approved against one reading cannot both stand', async () => {
    const h = harness({ config: { rootBudget: ROOT_BUDGET } })
    await storeWithRoot(h, 3)
    // Both requests were read at the same ceiling (10) — the shape a person
    // approves twice, or a retry that raced another caller — and the channel
    // recorded a decision for each of them.
    const firstReading = await draft(h, { requestKey: 'k-a', maxRuns: 20 })
    const secondReading = await draft(h, { requestKey: 'k-b', maxRuns: 25 })
    recordDecision(h, ROOT_SESSION, { callId: 'call-a', reason: cardOf(firstReading) })
    recordDecision(h, ROOT_SESSION, { callId: 'call-b', reason: cardOf(secondReading) })
    const first = { requestKey: 'k-a', maxRuns: 20, baseline: { maxRuns: 10 }, callId: 'call-a' }
    const second = { requestKey: 'k-b', maxRuns: 25, baseline: { maxRuns: 10 }, callId: 'call-b' }
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
    const reading = await draft(first, { requestKey: 'k-more-time', deadlineAt: APPROVED_DEADLINE })
    recordDecision(first, ROOT_SESSION, { callId: 'call-1', reason: cardOf(reading) })
    await first.runtime.extendRootBudget(ROOT_SESSION, {
      requestKey: 'k-more-time',
      deadlineAt: APPROVED_DEADLINE,
      baseline: { deadlineAt: CONFIGURED_DEADLINE },
      callId: 'call-1',
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
