import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { BudgetExtensionRequest, TaskBudgetExtensionClaim, TaskEvent, TaskInstance, TaskRun, TaskSnapshot } from '../../src/index.ts'
import { TaskService, TaskState, budgetExtensionRequestDigest, canonicalBudgetInstant, rootTaskStoreId } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)
const CONFIGURED_DEADLINE = '2026-09-16T01:00:00.000Z'
const APPROVED_DEADLINE = '2026-09-16T04:00:00.000Z'

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

function harness(sessions = new Map<string, StoredSession>()) {
  const changes: string[] = []
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
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
    },
    emit: (event: string, value: { id: string }) => {
      if (event === 'task/change') changes.push(value.id)
    },
    on: () => {},
    sessionPersistence: persistence,
  }
  return { ctx, sessions, changes, disposers, persistence }
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

function rootRun(): TaskRun {
  return {
    runId: 'r-root',
    taskId: 'root',
    sessionId: ROOT_SESSION,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
  }
}

/**
 * A store with the tree's own root: one parentless root task and the run bound to
 * the session the store id derives from. Built through the service's own entries,
 * so the events are the real ones a root activation writes.
 */
async function storeWithRoot(sessions = new Map<string, StoredSession>()) {
  const h = harness(sessions)
  const service = new TaskService(h.ctx as never)
  await service.createStore(STORE)
  await service.createTaskIn(STORE, rootTask(), 'test')
  await service.admitTaskIn(STORE, 'root', 'test', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
  await service.startRunIn(STORE, rootRun(), 'test')
  return { ...h, service }
}

/**
 * One claim as the runtime submits it: what the request asks for (the whole
 * approved totals), the reading it was approved against — every dimension the
 * tree bounds, and the value each was read at — and whose request it is. The
 * identity is derived here exactly as both writers derive it, so a test can
 * change one thing and leave the rest honest.
 */
function claimFor(
  request: BudgetExtensionRequest,
  baseline: { maxRuns?: number; deadlineAt?: string } = {},
  overrides: { approvalRef?: string; requestedBy?: string; requestDigest?: string; extra?: Record<string, unknown> } = {},
): TaskBudgetExtensionClaim {
  return {
    requestKey: request.requestKey,
    requestDigest: overrides.requestDigest ?? budgetExtensionRequestDigest(request),
    baseline: { ...baseline },
    ...(request.maxRuns === undefined ? {} : { maxRuns: { previous: baseline.maxRuns as number, next: request.maxRuns } }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: { previous: baseline.deadlineAt as string, next: request.deadlineAt } }),
    approvalRef: overrides.approvalRef ?? 'approval:call-1',
    requestedBy: overrides.requestedBy ?? ROOT_SESSION,
    ...overrides.extra,
  } as TaskBudgetExtensionClaim
}

/** The raise the fixture's grant is: an approved total of 20 runs, read at 10. */
const MORE_RUNS: BudgetExtensionRequest = { requestKey: 'k-more-runs', maxRuns: 20 }

/** The store's own events, so a test can replay them onto a second state. */
function storeEvents(h: { sessions: Map<string, StoredSession> }): TaskEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => (item.data as TaskEvent)))
}

describe('budget extension identity', () => {
  test('is the key and the totals, and one instant has one spelling', () => {
    const canonical = budgetExtensionRequestDigest({ requestKey: 'k-1', deadlineAt: APPROVED_DEADLINE })
    // A deadline that is the same instant, spelled differently, canonicalises to
    // the one form the digest is taken over — so a retry with another spelling is
    // the same request rather than new content.
    expect(canonicalBudgetInstant('2026-09-16T04:00:00Z')).toBe(APPROVED_DEADLINE)
    expect(canonicalBudgetInstant('2026-09-16T04:00:00.000Z')).toBe(APPROVED_DEADLINE)
    expect(budgetExtensionRequestDigest({ requestKey: 'k-1', deadlineAt: canonicalBudgetInstant('2026-09-16T04:00:00Z') })).toBe(canonical)
    // A bare local time denotes no absolute instant, and is refused rather than read.
    expect(canonicalBudgetInstant('2026-09-16T04:00:00')).toBeUndefined()
    expect(canonicalBudgetInstant('two hours from now')).toBeUndefined()
    expect(budgetExtensionRequestDigest({ requestKey: 'k-2', deadlineAt: APPROVED_DEADLINE })).not.toBe(canonical)
    expect(budgetExtensionRequestDigest({ requestKey: 'k-1', maxRuns: 20 })).not.toBe(canonical)
  })
})

describe('TaskBudgetExtended reducer', () => {
  test('records the raise with the store\u2019s own time, and the envelope binds it to the root', async () => {
    const h = await storeWithRoot()
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)

    const snapshot = await h.service.snapshotIn(STORE)
    expect(snapshot.budgetExtensions?.all).toHaveLength(1)
    const record = snapshot.budgetExtensions?.byRequestKey['k-more-runs']
    expect(record?.maxRuns).toEqual({ previous: 10, next: 20 })
    expect(record?.approvalRef).toBe('approval:call-1')
    expect(record?.requestedBy).toBe(ROOT_SESSION)
    expect(record?.recordedAt).toBeDefined()
    // Nothing but the record: no run, no task, no status moved.
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs[0]?.status).toBe('running')
  })

  test('applies a repeat of the same request nothing, however often it is applied', async () => {
    const h = await storeWithRoot()
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)
    const after = await h.service.snapshotIn(STORE)

    // The service answers the repeat from the record and appends nothing …
    const persisted = storeEvents(h).length
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)
    expect(storeEvents(h).length).toBe(persisted)

    // … and the reducer is idempotent on the event itself, which is what replay
    // depends on: applying it twice over one snapshot leaves one record.
    const state = new TaskState(STORE, after)
    const event = storeEvents(h).at(-1) as TaskEvent
    state.apply(event)
    state.apply(event)
    expect(state.snapshot().budgetExtensions?.all).toHaveLength(1)
  })

  test('commits one request committed twice at once as one fact and one event', async () => {
    const h = await storeWithRoot()
    const claim = claimFor(MORE_RUNS, { maxRuns: 10 })
    const raced = await Promise.allSettled([
      h.service.recordBudgetExtensionIn(STORE, 'root', claim, ROOT_SESSION),
      h.service.recordBudgetExtensionIn(STORE, 'root', claim, ROOT_SESSION),
    ])

    // Both callers are answered, and they are answered with one fact: a caller
    // that reaches the store's serial region behind another one finds the key
    // already recorded there and appends nothing.
    expect(raced.map(settled => settled.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(storeEvents(h).filter(item => item.kind === 'TaskBudgetExtended')).toHaveLength(1)
    const snapshot = await h.service.snapshotIn(STORE)
    expect(snapshot.budgetExtensions?.all).toHaveLength(1)
    expect(snapshot.budgetExtensions?.byRequestKey['k-more-runs']?.maxRuns).toEqual({ previous: 10, next: 20 })
  })

  test('one key raced by two different requests: one fact, and the other refused by name', async () => {
    const h = await storeWithRoot()
    const raced = await Promise.allSettled([
      h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION),
      h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-more-runs', maxRuns: 30 }, { maxRuns: 10 }), ROOT_SESSION),
    ])
    expect(raced.map(settled => settled.status)).toEqual(['fulfilled', 'rejected'])
    const reason = (raced[1] as PromiseRejectedResult).reason as Error
    expect(reason.message).toMatch(/already bound to a budget extension raising maxRuns 10 → 20/)
    expect(storeEvents(h).filter(item => item.kind === 'TaskBudgetExtended')).toHaveLength(1)
    // The loser wrote nothing: the winner's record is the store, and it is the
    // only one — one key never names two requests, whichever one arrives first.
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all.map(entry => entry.maxRuns?.next)).toEqual([20])
  })

  test('refuses the same key at different totals, writing nothing', async () => {
    const h = await storeWithRoot()
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)
    const before = await h.service.snapshotIn(STORE)
    const persisted = storeEvents(h).length

    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-more-runs', maxRuns: 30 }, { maxRuns: 10 }), ROOT_SESSION))
      .rejects.toThrow(/already bound to a budget extension raising maxRuns 10 → 20/)
    expect(storeEvents(h).length).toBe(persisted)
    expect(await h.service.snapshotIn(STORE)).toEqual(before)
  })

  test('refuses a raise read at a ceiling that has since moved, writing nothing', async () => {
    const h = await storeWithRoot()
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)

    // The first grant left 20 in force. A second request approved against the
    // *original* reading (10) may not be committed: it would re-base a person's
    // decision on a value nobody approved.
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-more-again', maxRuns: 30 }, { maxRuns: 10 }), ROOT_SESSION))
      .rejects.toThrow(/was read at maxRuns 10, but the ceiling in force here is 20/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toHaveLength(1)

    // The same request chained onto the value in force is accepted, and it is the
    // new total that stands — never the two raises added together.
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-more-again', maxRuns: 30 }, { maxRuns: 20 }), ROOT_SESSION)
    const snapshot = await h.service.snapshotIn(STORE)
    expect(snapshot.budgetExtensions?.all.map(entry => entry.maxRuns?.next)).toEqual([20, 30])
  })

  test('refuses a deadline that is not an absolute canonical instant, and a pair that does not raise', async () => {
    const h = await storeWithRoot()
    // A deadline is an absolute instant: a bare local time is not one.
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-deadline', deadlineAt: '2026-09-16T04:00:00' },
      { deadlineAt: CONFIGURED_DEADLINE },
    ), ROOT_SESSION)).rejects.toThrow(/absolute instants in canonical UTC form/)
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-deadline', deadlineAt: '2026-09-16T00:30:00.000Z' },
      { deadlineAt: CONFIGURED_DEADLINE },
    ), ROOT_SESSION)).rejects.toThrow(/a deadline only ever moves later/)
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-same', maxRuns: 10 }, { maxRuns: 10 }), ROOT_SESSION))
      .rejects.toThrow(/only ever moves up/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('refuses an extension with no approval, no dimension, a foreign identity or an unread field', async () => {
    const h = await storeWithRoot()
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }, { approvalRef: '' }), ROOT_SESSION))
      .rejects.toThrow(/requires a non-empty approval reference/)
    const withoutDimension: TaskBudgetExtensionClaim = {
      ...claimFor(MORE_RUNS, { maxRuns: 10 }),
      maxRuns: undefined,
    }
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', withoutDimension, ROOT_SESSION))
      .rejects.toThrow(/raises nothing/)
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }, { requestDigest: 'f'.repeat(64) }), ROOT_SESSION))
      .rejects.toThrow(/which is not the identity of the request it carries/)
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }, { extra: { tokenBudget: 1000 } }), ROOT_SESSION))
      .rejects.toThrow(/an unread field must not enter the record/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('refuses a raise asked in the name of another session, or named beside a task that is not the tree\u2019s root', async () => {
    const h = await storeWithRoot()
    await h.service.createTaskIn(STORE, { ...rootTask(), taskId: 'child', parentTaskId: 'root', depth: 1 }, 'test')
    /** One hand-written event, as a foreign writer or a replay would present it. */
    const envelope = (taskId: string, sessionId: string, extension: TaskBudgetExtensionClaim): TaskEvent => ({
      kind: 'TaskBudgetExtended',
      taskId,
      sessionId,
      timestamp: NOW,
      actor: 'test',
      payload: { extension },
      schemaVersion: 1,
    })

    // A worker's session is not this store's root session: the store id derives
    // from the root session, so the claim itself says whose budget it is.
    await expect(h.service.commitIn(STORE, [
      envelope('root', 'worker-1', claimFor(MORE_RUNS, { maxRuns: 10 }, { requestedBy: 'worker-1' })),
    ])).rejects.toThrow(/is not the root session of store/)
    // The event has to say the same thing as the record.
    await expect(h.service.commitIn(STORE, [
      envelope('root', 'someone-else', claimFor(MORE_RUNS, { maxRuns: 10 })),
    ])).rejects.toThrow(/asked by session "root-session" but its event names "someone-else"/)
    // An event that names no asking session at all is not a raise either.
    await expect(h.service.commitIn(STORE, [
      { ...envelope('root', ROOT_SESSION, claimFor(MORE_RUNS, { maxRuns: 10 })), sessionId: undefined } as TaskEvent,
    ])).rejects.toThrow(/must carry the asking session on its envelope/)
    // And a budget is the tree's, so its event names no child task.
    await expect(h.service.commitIn(STORE, [
      envelope('child', ROOT_SESSION, claimFor(MORE_RUNS, { maxRuns: 10 })),
    ])).rejects.toThrow(/which is not the store's root task/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('refuses a grant read before another one moved a dimension it does not raise, writing nothing', async () => {
    const h = await storeWithRoot()
    // One reading, two requests: the first raises maxRuns, the second moves the
    // deadline, and each was approved against {maxRuns: 10, deadlineAt: T}. A
    // person who approved the second never saw the run ceiling the first left.
    const reading = { maxRuns: 10, deadlineAt: CONFIGURED_DEADLINE }
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor({ requestKey: 'k-runs', maxRuns: 20 }, reading), ROOT_SESSION)
    const before = await h.service.snapshotIn(STORE)
    const persisted = storeEvents(h).length

    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-time', deadlineAt: APPROVED_DEADLINE },
      reading,
    ), ROOT_SESSION)).rejects.toThrow(/was read at maxRuns 10, but the ceiling in force here is 20/)
    // A reading that leaves the dimension the tree has already moved out is
    // refused too: the store can measure maxRuns from its own record, and a
    // request read without it was read before that record.
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-time-2', deadlineAt: APPROVED_DEADLINE },
      { deadlineAt: CONFIGURED_DEADLINE },
    ), ROOT_SESSION)).rejects.toThrow(/was read without a maxRuns reading, but the ceiling in force here is 20/)
    expect(storeEvents(h).length).toBe(persisted)
    expect(await h.service.snapshotIn(STORE)).toEqual(before)

    // The same request re-read at the whole ceiling the first grant left is a
    // new request, and it lands as its own fact.
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-time', deadlineAt: APPROVED_DEADLINE },
      { ...reading, maxRuns: 20 },
    ), ROOT_SESSION)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all.map(entry => entry.requestKey)).toEqual(['k-runs', 'k-time'])
  })

  test('refuses a raise whose reading disagrees with the ceiling it moves from, writing nothing', async () => {
    const h = await storeWithRoot()
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      MORE_RUNS,
      { maxRuns: 10 },
      { extra: { baseline: { maxRuns: 12 } } },
    ), ROOT_SESSION)).rejects.toThrow(/raises maxRuns from 10 but was read at maxRuns 12/)
    const withoutReading: TaskBudgetExtensionClaim = { ...claimFor(MORE_RUNS, { maxRuns: 10 }), baseline: {} }
    await expect(h.service.recordBudgetExtensionIn(STORE, 'root', withoutReading, ROOT_SESSION))
      .rejects.toThrow(/raises maxRuns from 10 but was read without a maxRuns reading/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('refuses a claim that carries no reading of the ceilings it was approved against', async () => {
    const h = await storeWithRoot()
    // The shape a pre-rework build of this ticket wrote: the raise and the
    // approval, and no reading of what the tree was under. A grant the store
    // cannot check dimension by dimension is not one it can enforce, so it is
    // refused by name rather than assumed to be the dimension it happens to
    // raise — the old "only the raised dimensions are checked" judgement is not
    // kept as a fallback anywhere.
    const withoutReading = { ...claimFor(MORE_RUNS, { maxRuns: 10 }) } as unknown as Record<string, unknown>
    delete withoutReading.baseline
    await expect(h.service.commitIn(STORE, [{
      kind: 'TaskBudgetExtended',
      taskId: 'root',
      sessionId: ROOT_SESSION,
      timestamp: NOW,
      actor: 'test',
      payload: { extension: withoutReading },
      schemaVersion: 1,
    } as TaskEvent])).rejects.toThrow(/carries no reading of the ceilings it was approved against/)
    expect((await h.service.snapshotIn(STORE)).budgetExtensions?.all).toEqual([])
  })

  test('replays to the same snapshot: the record is the log, and re-applying it changes nothing', async () => {
    const h = await storeWithRoot()
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)
    await h.service.recordBudgetExtensionIn(STORE, 'root', claimFor(
      { requestKey: 'k-later-deadline', deadlineAt: APPROVED_DEADLINE },
      { maxRuns: 20, deadlineAt: CONFIGURED_DEADLINE },
    ), ROOT_SESSION)

    const live = await h.service.snapshotIn(STORE)
    expect(live.budgetExtensions?.all.map(entry => entry.requestKey)).toEqual(['k-more-runs', 'k-later-deadline'])

    // A fresh state, built from the events alone, agrees with the live one …
    const replayed = new TaskState(STORE)
    for (const event of storeEvents(h)) replayed.apply(event)
    expect(replayed.snapshot()).toEqual(live)

    // … and a state seeded with that snapshot and fed the extension events twice
    // agrees too: a duplicate event is not a second grant.
    const extensions = storeEvents(h).filter(event => event.kind === 'TaskBudgetExtended')
    expect(extensions).toHaveLength(2)
    const twice = new TaskState(STORE, live)
    for (const event of [...extensions, ...extensions]) twice.apply(event)
    expect(twice.snapshot()).toEqual(live)
  })

  test('a store reopened from its own log holds the same ceilings', async () => {
    const first = await storeWithRoot()
    await first.service.recordBudgetExtensionIn(STORE, 'root', claimFor(MORE_RUNS, { maxRuns: 10 }), ROOT_SESSION)
    const before = await first.service.snapshotIn(STORE)
    await Promise.all(first.disposers.map(dispose => dispose()))

    const reopened = new TaskService(harness(first.sessions).ctx as never)
    const after = await reopened.openStore(STORE)
    expect(after.budgetExtensions).toEqual(before.budgetExtensions)
  })
})

describe('TaskSnapshot budgetExtensions index', () => {
  test('a store without extensions carries an empty index, not an absent one', async () => {
    const h = await storeWithRoot()
    const snapshot: TaskSnapshot = await h.service.snapshotIn(STORE)
    expect(snapshot.budgetExtensions).toEqual({ all: [], byRequestKey: {} })
  })
})
