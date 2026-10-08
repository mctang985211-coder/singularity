import { describe, expect, test } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TaskEvent, TaskInstance } from '../../src/index.ts'
import { TaskService } from '../../src/index.ts'

const STORE = 'sg-t-read-only'
const NOW = '2026-10-08T00:00:00.000Z'

function task(taskId: string): TaskInstance {
  return {
    taskId,
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'read without writing',
    depth: 0,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
}

function created(taskId: string): TaskEvent {
  return {
    kind: 'TaskCreated',
    taskId,
    timestamp: NOW,
    actor: 'tester',
    payload: { task: task(taskId) },
    schemaVersion: 1,
  }
}

function row(type: string, seq: number, data: TaskEvent): SessionEvent {
  const event: { type: string; seq: SessionSeq; time: number; data: TaskEvent; ignorable?: true } = {
    type,
    seq: SessionSeq(seq),
    time: Date.now(),
    data,
    ignorable: true,
  }
  return event as SessionEvent
}

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface PersistenceCalls {
  create: number
  append: number
  openModes: string[]
  closed: number
}

function harness(storedSessions: StoredSession[]) {
  const calls: PersistenceCalls = { create: 0, append: 0, openModes: [], closed: 0 }
  const persistence = {
    list: async () => storedSessions.map(stored => ({ header: stored.header })),
    create: async (header: SessionHeader) => {
      calls.create += 1
      const stored: StoredSession = { header, events: [] }
      storedSessions.push(stored)
      return handleOf(stored, calls)
    },
    open: async (id: SessionId, access: 'read' | 'write') => {
      calls.openModes.push(access)
      const stored = storedSessions.find(item => item.header.id === id)
      if (stored === undefined) throw new Error(`no such session "${String(id)}"`)
      return handleOf(stored, calls)
    },
  }
  const ctx = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      execute()
    },
    emit: () => {},
    on: () => {},
    sessionPersistence: persistence,
  }
  return { ctx, calls }
}

function handleOf(stored: StoredSession, calls: PersistenceCalls) {
  return {
    read: async () => ({ events: stored.events }),
    append: async (batch: SessionEvent[]) => {
      calls.append += 1
      stored.events.push(...batch)
    },
    flush: async () => {},
    close: async () => {
      calls.closed += 1
    },
  }
}

function storedSession(id: string, events: SessionEvent[]): StoredSession {
  return { header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), isSeeded: false }, events }
}

describe('snapshotReadOnly', () => {
  test('answers exists:false for a missing store and never creates one', async () => {
    const h = harness([])
    const service = new TaskService(h.ctx as never)
    const result = await service.snapshotReadOnly(STORE)
    expect(result.exists).toBe(false)
    expect(h.calls.create).toBe(0)
    expect(h.calls.openModes).toEqual([])
  })

  test('replays an existing store over a read handle and closes it', async () => {
    const h = harness([storedSession(STORE, [row('task/event', 0, created('t1')), row('task/event', 1, created('t2'))])])
    const service = new TaskService(h.ctx as never)
    const result = await service.snapshotReadOnly(STORE)
    expect(result.exists).toBe(true)
    if (result.exists) expect(result.snapshot.tasks.map(item => item.taskId)).toEqual(['t1', 't2'])
    expect(h.calls.openModes).toEqual(['read'])
    expect(h.calls.create).toBe(0)
    expect(h.calls.append).toBe(0)
    expect(h.calls.closed).toBe(1)
  })

  test('never enters the store map: a later snapshotIn still reports the store as not open', async () => {
    const h = harness([storedSession(STORE, [row('task/event', 0, created('t1'))])])
    const service = new TaskService(h.ctx as never)
    await service.snapshotReadOnly(STORE)
    await expect(service.snapshotIn(STORE)).rejects.toThrow(`task: store "${STORE}" is not open`)
  })

  test('refuses a duplicated store session by name', async () => {
    const h = harness([storedSession(STORE, []), storedSession(STORE, [])])
    const service = new TaskService(h.ctx as never)
    await expect(service.snapshotReadOnly(STORE)).rejects.toThrow(`task: duplicate store session "${STORE}"`)
    expect(h.calls.create).toBe(0)
  })

  test('refuses a foreign event name and still closes the handle', async () => {
    const h = harness([storedSession(STORE, [row('graphs/event', 0, created('t1'))])])
    const service = new TaskService(h.ctx as never)
    await expect(service.snapshotReadOnly(STORE)).rejects.toThrow('task: invalid persisted event at seq 0')
    expect(h.calls.closed).toBe(1)
  })
})
