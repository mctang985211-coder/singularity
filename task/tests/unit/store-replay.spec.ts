import { describe, expect, test } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TaskEvent, TaskInstance } from '../../src/index.ts'
import { TaskService } from '../../src/index.ts'

const STORE = 'sg-t-replay'
const NOW = '2026-09-16T00:00:00.000Z'

function task(taskId: string): TaskInstance {
  return {
    taskId,
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'replay the persisted log',
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

/** One persisted row as a migrated V3 log stores it; the static `SessionEvent` union cannot name `plugin:<name>`. */
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

function harness(events: SessionEvent[]) {
  const stored: StoredSession = {
    header: { version: SESSION_FORMAT_VERSION, id: SessionId(STORE), createdAt: Date.now(), isSeeded: false },
    events,
  }
  const persistence = {
    list: async () => [{ header: stored.header }],
    create: async () => {
      throw new Error('create is not expected in replay tests')
    },
    open: async () => ({
      read: async () => ({ events: stored.events }),
      append: async (batch: SessionEvent[]) => {
        stored.events.push(...batch)
      },
      flush: async () => {},
      close: async () => {},
    }),
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
  return { ctx, stored }
}

describe('event store replay after the V3→V4 event rename', () => {
  test('replays both the bare and the plugin-prefixed spelling', async () => {
    const h = harness([
      row('task/event', 0, created('t1')),
      row('plugin:task/event', 1, created('t2')),
    ])
    const service = new TaskService(h.ctx as never)
    const snapshot = await service.openStore(STORE)
    expect(snapshot.tasks.map(item => item.taskId)).toEqual(['t1', 't2'])

    await service.createTaskIn(STORE, task('t3'), 'tester')
    expect(h.stored.events.at(-1)?.type).toBe('task/event')
  })

  test.each(['graphs/event', 'plugin:graphs/event'])('refuses the foreign event name %s', async type => {
    const h = harness([row(type, 0, created('t1'))])
    const service = new TaskService(h.ctx as never)
    await expect(service.openStore(STORE)).rejects.toThrow('task: invalid persisted event at seq 0')
  })
})
