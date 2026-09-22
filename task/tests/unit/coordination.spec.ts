import { describe, expect, test, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  CapabilityManifest,
  ExecutionPhase,
  RunId,
  SubmissionRecord,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
} from '../../src/types.ts'
import { TaskService } from '../../src/index.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId; runId?: RunId; parentTaskId?: TaskId } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 't1',
    runId: init.runId,
    parentTaskId: init.parentTaskId,
    timestamp: NOW,
    actor: 'test',
    payload,
    schemaVersion: 1,
  } as unknown as TaskEvent
}

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 't1',
    definitionRef: { taskType: 'build', version: 1 },
    objective: 'build the thing',
    depth: 0,
    acceptanceCriteria: [
      { criterionId: 'c1', description: 'compiles', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'r1',
    taskId: 't1',
    sessionId: 's1',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

function submission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    summary: 'the thing is built',
    evidenceRefs: ['e1'],
    submittedAt: NOW,
    origin: 'worker',
    ...overrides,
  }
}

function admittedState(): TaskState {
  const state = new TaskState('store')
  state.apply(ev('TaskCreated', { task: task() }))
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
  return state
}

/** A run written before the coordination fields: `TaskStarted` with no phase. */
function legacyRunningState(): TaskState {
  const state = admittedState()
  state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
  return state
}

function activeState(): TaskState {
  const state = admittedState()
  state.apply(ev('TaskStarted', { run: run({ executionPhase: 'active' }) }, { runId: 'r1' }))
  return state
}

function waitingChildrenState(): TaskState {
  const state = activeState()
  state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { runId: 'r1' }))
  return state
}

function submittedState(): TaskState {
  const state = activeState()
  state.apply(ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }))
  return state
}

function cancelledState(): TaskState {
  const state = activeState()
  state.apply(ev('TaskCancelled', { reason: 'abort' }, { runId: 'r1' }))
  return state
}

function failedState(): TaskState {
  const state = activeState()
  state.apply(ev('TaskFailed', { reason: 'verification failed' }, { runId: 'r1' }))
  return state
}

describe('TaskState coordination phases', () => {
  test('active → waiting_children records the phase and the deterministic batch id', () => {
    const state = activeState()
    state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('waiting_children')
    expect(stored?.batchId).toBe('b-t1')
    expect(stored?.submission).toBeUndefined()
  })

  test('active → submitted records the submission and carries A4 question ids', () => {
    const state = activeState()
    const value = submission({ notes: 'one criterion left to check' })
    state.apply(ev('RunPhaseChanged', {
      phase: 'submitted',
      submission: value,
      pendingQuestionIds: ['q1'],
      blockingQuestionIds: [],
      reason: 'worker submitted',
    }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('submitted')
    expect(stored?.submission).toEqual(value)
    expect(stored?.pendingQuestionIds).toEqual(['q1'])
    expect(stored?.blockingQuestionIds).toEqual([])
    expect(stored?.batchId).toBeUndefined()
  })

  test('waiting_children → submitted keeps the batch id, the carried question ids, and a runtime submission', () => {
    const state = activeState()
    state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1', pendingQuestionIds: ['q1'] }, { runId: 'r1' }))
    state.apply(ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ origin: 'runtime', summary: 'children settled' }) }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('submitted')
    expect(stored?.batchId).toBe('b-t1')
    expect(stored?.pendingQuestionIds).toEqual(['q1'])
    expect(stored?.submission?.origin).toBe('runtime')
  })

  const refusedPhaseChanges: Array<[string, () => TaskState, TaskEvent, string]> = [
    ['active → active', activeState, ev('RunPhaseChanged', { phase: 'active' }, { runId: 'r1' }), 'illegal run phase transition "active" → "active"'],
    ['waiting_children → active', waitingChildrenState, ev('RunPhaseChanged', { phase: 'active' }, { runId: 'r1' }), 'illegal run phase transition "waiting_children" → "active"'],
    ['submitted → submitted', submittedState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'illegal run phase transition "submitted" → "submitted"'],
    ['submitted → waiting_children', submittedState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { runId: 'r1' }), 'illegal run phase transition "submitted" → "waiting_children"'],
    ['waiting_children → waiting_children', waitingChildrenState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { runId: 'r1' }), 'illegal run phase transition "waiting_children" → "waiting_children"'],
    ['a phase change without a run id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }), 'requires a run id'],
    ['a phase change on an unknown run', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { runId: 'ghost' }), 'unknown run'],
    ['a phase change naming another task\'s run', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1' }, { taskId: 'other', runId: 'r1' }), 'belongs to task "t1", not "other"'],
    ['a phase change on a run with no phase', legacyRunningState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'has no execution phase'],
    ['a late phase change on a cancelled run', cancelledState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'is cancelled; a phase change requires a running run'],
    ['a late phase change on a failed run', failedState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'is failed; a phase change requires a running run'],
    ['an unknown target phase', activeState, ev('RunPhaseChanged', { phase: 'paused' as ExecutionPhase }, { runId: 'r1' }), 'execution phase must be one of active, waiting_children, submitted'],
    ['a waiting_children transition without a batch id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children' }, { runId: 'r1' }), 'entering waiting_children requires a batch id'],
    ['an empty batch id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: '' }, { runId: 'r1' }), 'entering waiting_children requires a batch id'],
    ['a waiting_children transition carrying a submission', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: 'b-t1', submission: submission() }, { runId: 'r1' }), 'only the submitted phase carries a submission'],
    ['a submitted transition without a submission', activeState, ev('RunPhaseChanged', { phase: 'submitted' }, { runId: 'r1' }), 'submitting requires a submission record'],
    ['a submitted transition carrying a batch id', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission(), batchId: 'b-t1' }, { runId: 'r1' }), 'a batch id belongs to the waiting_children phase'],
    ['an empty submission summary', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ summary: '' }) }, { runId: 'r1' }), 'submission requires a summary'],
    ['a non-list evidence refs', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ evidenceRefs: 'e1' as unknown as string[] }) }, { runId: 'r1' }), 'evidence refs must be an array of strings'],
    ['a non-string evidence ref', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ evidenceRefs: ['e1', 7 as unknown as string] }) }, { runId: 'r1' }), 'evidence refs must be an array of strings'],
    ['non-string submission notes', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ notes: 7 as unknown as string }) }, { runId: 'r1' }), 'notes must be a string when present'],
    ['an unknown submission origin', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ origin: 'agent' as SubmissionRecord['origin'] }) }, { runId: 'r1' }), 'origin must be "worker" or "runtime"'],
    ['a missing submission time', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ submittedAt: '' }) }, { runId: 'r1' }), 'submission requires a submission time'],
    ['a non-list pendingQuestionIds', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission(), pendingQuestionIds: 'q1' as unknown as string[] }, { runId: 'r1' }), 'pendingQuestionIds must be an array of strings'],
    ['a non-string blockingQuestionIds entry', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission(), blockingQuestionIds: [3 as unknown as string] }, { runId: 'r1' }), 'blockingQuestionIds must be an array of strings'],
  ]

  test.each(refusedPhaseChanges)('%s is refused without touching the run', (_name, setup, event, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => state.apply(event)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })
})

describe('TaskState no-progress markings', () => {
  test('an active run records a marking and the caller\'s round count is taken as given', () => {
    const state = activeState()
    state.apply(ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 3, note: 'idle with no submission' }, { runId: 'r1' }))
    expect(state.snapshot().runs[0]?.noProgress).toEqual({ kind: 'unsubmitted-idle', rounds: 1, factCount: 3, markedAt: NOW })
    state.apply(ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 5, factCount: 3, note: 'still idle' }, { runId: 'r1' }))
    expect(state.snapshot().runs[0]?.noProgress).toEqual({ kind: 'unsubmitted-idle', rounds: 5, factCount: 3, markedAt: NOW })
  })

  const refusedMarkings: Array<[string, () => TaskState, TaskEvent, string]> = [
    ['a run with no phase', legacyRunningState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'execution phase is absent'],
    ['a waiting_children run', waitingChildrenState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'execution phase is "waiting_children"'],
    ['a submitted run', submittedState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'execution phase is "submitted"'],
    ['a cancelled run', cancelledState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'is cancelled; progress can only be marked while the run is running'],
    ['a failed run', failedState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'is failed; progress can only be marked while the run is running'],
    ['an unknown run', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'ghost' }), 'unknown run'],
    ['a marking without a run id', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }), 'requires a run id'],
    ['a marking naming another task\'s run', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { taskId: 'other', runId: 'r1' }), 'belongs to task "t1", not "other"'],
    ['an unknown kind', activeState, ev('RunProgressMarked', { kind: 'stalled' as 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'progress kind must be "unsubmitted-idle"'],
    ['zero rounds', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 0, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'rounds must be a positive integer'],
    ['fractional rounds', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1.5, factCount: 0, note: 'idle' }, { runId: 'r1' }), 'rounds must be a positive integer'],
    ['a negative fact count', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: -1, note: 'idle' }, { runId: 'r1' }), 'fact count must be a non-negative integer'],
    ['a fractional fact count', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0.5, note: 'idle' }, { runId: 'r1' }), 'fact count must be a non-negative integer'],
    ['an empty note', activeState, ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: '' }, { runId: 'r1' }), 'progress requires a note'],
  ]

  test.each(refusedMarkings)('%s is refused without touching the run', (_name, setup, event, message) => {
    const state = setup()
    const before = state.snapshot()
    expect(() => state.apply(event)).toThrow(message)
    expect(state.snapshot()).toEqual(before)
  })
})

describe('TaskStarted birth phase', () => {
  test('a run born without a phase applies unchanged', () => {
    const state = admittedState()
    state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
    expect(state.snapshot().runs[0]).toEqual(run())
  })

  test('a worker run is born active and a workerless replay may be born submitted', () => {
    const active = admittedState()
    active.apply(ev('TaskStarted', { run: run({ executionPhase: 'active' }) }, { runId: 'r1' }))
    expect(active.snapshot().runs[0]?.executionPhase).toBe('active')
    expect(active.snapshot().runs[0]?.submission).toBeUndefined()

    const replay = admittedState()
    replay.apply(ev('TaskStarted', { run: run({ executionPhase: 'submitted', submission: submission({ origin: 'runtime' }) }) }, { runId: 'r1' }))
    expect(replay.snapshot().runs[0]?.executionPhase).toBe('submitted')
    expect(replay.snapshot().runs[0]?.submission?.origin).toBe('runtime')
  })

  const refusedBirths: Array<[string, TaskRun, string]> = [
    ['an active run carrying a submission', run({ executionPhase: 'active', submission: submission() }), 'is born active; only a submitted run carries a submission'],
    ['an active run carrying a batch id', run({ executionPhase: 'active', batchId: 'b-t1' }), 'a batch id is recorded by a phase change, not at start'],
    ['a submitted run without a submission', run({ executionPhase: 'submitted' }), 'is born submitted; a submission record is required'],
    ['a submitted run carrying a batch id', run({ executionPhase: 'submitted', submission: submission(), batchId: 'b-t1' }), 'a batch id is recorded by a phase change, not at start'],
    ['a submitted run with a malformed submission', run({ executionPhase: 'submitted', submission: submission({ summary: '' }) }), 'submission requires a summary'],
    ['a run born waiting_children', run({ executionPhase: 'waiting_children' }), 'execution phase must be "active" or "submitted" at start'],
    ['a run born with an unknown phase', run({ executionPhase: 'paused' as ExecutionPhase }), 'execution phase must be "active" or "submitted" at start'],
  ]

  test.each(refusedBirths)('refuses %s and starts no run', (_name, value, message) => {
    const state = admittedState()
    expect(() => state.apply(ev('TaskStarted', { run: value }, { runId: 'r1' }))).toThrow(message)
    expect(state.snapshot().runs).toHaveLength(0)
    expect(state.snapshot().tasks[0]?.status).toBe('admitted')
  })
})

describe('TaskState legacy records', () => {
  test('a run written before the coordination fields replays unchanged and admits no marking', () => {
    const state = legacyRunningState()
    const stored = state.snapshot().runs[0]
    expect(stored).toEqual(run())
    expect(stored?.executionPhase).toBeUndefined()
    expect(stored?.batchId).toBeUndefined()
    expect(stored?.submission).toBeUndefined()
    expect(stored?.pendingQuestionIds).toBeUndefined()
    expect(stored?.blockingQuestionIds).toBeUndefined()
    expect(stored?.noProgress).toBeUndefined()
    expect(() => state.apply(ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' })))
      .toThrow('has no execution phase')
    expect(() => state.apply(ev('RunProgressMarked', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }, { runId: 'r1' })))
      .toThrow('execution phase is absent')
  })
})

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface Harness {
  readonly ctx: unknown
  readonly sessions: Map<string, StoredSession>
  readonly changes: string[]
}

function harness(sessions = new Map<string, StoredSession>()): Harness {
  const changes: string[] = []
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
    effect: (execute: () => unknown) => { execute() },
    emit: (event: string, value: { id: string }) => {
      if (event === 'task/change') changes.push(value.id)
    },
    on: () => {},
    sessionPersistence: persistence,
  }
  return { ctx, sessions, changes }
}

function storedEvents(h: Harness): SessionEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events)
}

function persistedKinds(h: Harness): string[] {
  return storedEvents(h).map(item => (item.data as TaskEvent).kind)
}

function record(seq: number, data: TaskEvent): SessionEvent {
  return { type: 'task/event', seq: SessionSeq(seq), time: 0, data, ignorable: true } as SessionEvent
}

/** A store whose root task runs on an active run, ready to admit one batch. */
async function rootWithRun(phase: ExecutionPhase = 'active'): Promise<{ h: Harness; service: TaskService }> {
  const h = harness()
  const service = new TaskService(h.ctx as never)
  await service.createStore(STORE)
  await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
  await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })
  await service.startRunIn(STORE, run({ taskId: 'root', executionPhase: phase }), 'tester')
  return { h, service }
}

describe('TaskService batch admission', () => {
  test('one commit admits the whole batch and closes the parent gate', async () => {
    const { h, service } = await rootWithRun()
    const manifests: CapabilityManifest[] = [
      { capabilities: { build: { skills: [], tools: ['write'] } }, missing: [], closure: 'closed' },
      { capabilities: {}, missing: ['verilog-sim'], closure: 'gap' },
    ]
    const before = storedEvents(h).length
    await service.admitBatchIn(
      STORE,
      'root',
      'r1',
      [
        task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }),
        task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }),
      ],
      'tester',
      [{ from: 'c1', to: 'c2' }],
      undefined,
      manifests,
    )
    expect(storedEvents(h).length - before).toBe(10)
    expect(h.changes).toHaveLength(4)

    const parent = await service.taskIn(STORE, 'root')
    expect(parent.decompositionStatus).toBe('decomposed')
    expect(parent.childTaskIds).toEqual(['c1', 'c2'])
    expect((await service.childrenIn(STORE, 'root')).map(child => child.status)).toEqual(['admitted', 'admitted'])
    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.edges).toEqual([{ from: 'c1', to: 'c2' }])
    expect(snapshot.capabilities['c1']).toEqual(manifests[0])
    expect(snapshot.capabilities['c2']).toEqual(manifests[1])
    const parentRun = await service.runIn(STORE, 'r1')
    expect(parentRun.executionPhase).toBe('waiting_children')
    expect(parentRun.batchId).toBe('b-root')
    expect(parentRun.submission).toBeUndefined()
    for (const stored of storedEvents(h)) {
      expect(JSON.parse(JSON.stringify(stored))).toStrictEqual(stored)
    }
  })

  test('a batch whose phase change cannot apply persists nothing and the store stays writable', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })

    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester'),
    ).rejects.toThrow('unknown run')
    expect(persistedKinds(h)).toEqual(['TaskCreated', 'TaskAdmitted'])
    const refused = await service.snapshotIn(STORE)
    expect(refused.tasks).toHaveLength(1)
    expect(refused.edges).toHaveLength(0)

    await service.startRunIn(STORE, run({ taskId: 'root', executionPhase: 'active' }), 'tester')
    await service.admitBatchIn(STORE, 'root', 'r1', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester')
    expect((await service.taskIn(STORE, 'root')).decompositionStatus).toBe('decomposed')
    expect((await service.runIn(STORE, 'r1')).batchId).toBe('b-root')
  })

  test('a batch on a run whose gate already closed is refused whole', async () => {
    const { h, service } = await rootWithRun()
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'submitted', submission: submission() })
    const before = persistedKinds(h)
    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester'),
    ).rejects.toThrow('illegal run phase transition "submitted" → "waiting_children"')
    expect(persistedKinds(h)).toEqual(before)
    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.edges).toHaveLength(0)
  })

  test('admitBatchIn refuses an empty batch, a foreign child and a misaligned manifest list before writing', async () => {
    const { h, service } = await rootWithRun()
    const before = persistedKinds(h)
    await expect(service.admitBatchIn(STORE, 'root', 'r1', [], 'tester')).rejects.toThrow('at least one child')
    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', [task({ taskId: 'c1', parentTaskId: 'other', depth: 1 })], 'tester'),
    ).rejects.toThrow('parentTaskId')
    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester', [], undefined, []),
    ).rejects.toThrow('one manifest per child')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('decomposeIn still admits a batch without touching the parent run phase', async () => {
    const { service } = await rootWithRun()
    await service.decomposeIn(STORE, 'root', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester')
    const parentRun = await service.runIn(STORE, 'r1')
    expect(parentRun.executionPhase).toBe('active')
    expect(parentRun.batchId).toBeUndefined()
  })
})

describe('TaskService coordination entries', () => {
  test('changeRunPhaseIn walks the batch gate and refuses a rollback without writing', async () => {
    const { h, service } = await rootWithRun()
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'waiting_children', batchId: 'b-root' })
    expect((await service.runIn(STORE, 'r1')).batchId).toBe('b-root')

    const before = persistedKinds(h)
    await expect(service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'active' }))
      .rejects.toThrow('illegal run phase transition "waiting_children" → "active"')
    expect(persistedKinds(h)).toEqual(before)

    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', {
      phase: 'submitted',
      submission: submission({ origin: 'runtime', summary: 'children settled' }),
    })
    const stored = await service.runIn(STORE, 'r1')
    expect(stored.executionPhase).toBe('submitted')
    expect(stored.batchId).toBe('b-root')
    expect(stored.submission?.origin).toBe('runtime')
  })

  test('changeRunPhaseIn refuses a second submission and keeps the recorded one', async () => {
    const { h, service } = await rootWithRun()
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'submitted', submission: submission() })
    const before = persistedKinds(h)
    await expect(
      service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'submitted', submission: submission({ summary: 'again' }) }),
    ).rejects.toThrow('illegal run phase transition "submitted" → "submitted"')
    expect(persistedKinds(h)).toEqual(before)
    expect((await service.runIn(STORE, 'r1')).submission?.summary).toBe('the thing is built')
  })

  test('markRunProgressIn records the caller\'s round count and refuses a closed phase', async () => {
    const { h, service } = await rootWithRun()
    await service.markRunProgressIn(STORE, 'root', 'r1', 'tester', { kind: 'unsubmitted-idle', rounds: 1, factCount: 2, note: 'idle with no submission' })
    expect((await service.runIn(STORE, 'r1')).noProgress)
      .toEqual({ kind: 'unsubmitted-idle', rounds: 1, factCount: 2, markedAt: expect.any(String) })
    await service.markRunProgressIn(STORE, 'root', 'r1', 'tester', { kind: 'unsubmitted-idle', rounds: 2, factCount: 2, note: 'still idle' })
    expect((await service.runIn(STORE, 'r1')).noProgress?.rounds).toBe(2)

    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'submitted', submission: submission() })
    const before = persistedKinds(h)
    await expect(
      service.markRunProgressIn(STORE, 'root', 'r1', 'tester', { kind: 'unsubmitted-idle', rounds: 3, factCount: 2, note: 'idle' }),
    ).rejects.toThrow('progress is only marked on an active run')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a store written before the coordination fields opens unchanged', async () => {
    const sessions = new Map<string, StoredSession>()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: makeSessionId(STORE), createdAt: 0, isSeeded: false }
    sessions.set(STORE, {
      header,
      events: [
        record(0, ev('TaskCreated', { task: task() })),
        record(1, ev('TaskAdmitted', { decompositionStatus: 'leaf' })),
        record(2, ev('TaskStarted', { run: run() }, { runId: 'r1' })),
      ],
    })
    const h = harness(sessions)
    const service = new TaskService(h.ctx as never)
    const snapshot = await service.openStore(STORE)
    expect(snapshot.runs[0]).toEqual(run())
    expect(snapshot.runs[0]?.executionPhase).toBeUndefined()
    expect((await service.taskIn(STORE, 't1')).status).toBe('running')

    await expect(service.changeRunPhaseIn(STORE, 't1', 'r1', 'tester', { phase: 'submitted', submission: submission() }))
      .rejects.toThrow('has no execution phase')
    await expect(service.markRunProgressIn(STORE, 't1', 'r1', 'tester', { kind: 'unsubmitted-idle', rounds: 1, factCount: 0, note: 'idle' }))
      .rejects.toThrow('execution phase is absent')
    expect(await service.snapshotIn(STORE)).toEqual(snapshot)
  })
})
