import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, TaskEvent, TaskHandoff, TaskInstance, TaskRun } from '../../src/index.ts'
import { TaskService, rootTaskStoreId } from '../../src/index.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'

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

function evidence(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    evidenceId: 'e1',
    taskRunId: 'r1',
    taskId: 't1',
    artifacts: [],
    verifierResults: [],
    claims: [],
    generatedAt: NOW,
    ...overrides,
  }
}

function handoff(overrides: Partial<TaskHandoff> = {}): TaskHandoff {
  return {
    handoffId: 'h1',
    parentTaskId: 't1',
    parentRunId: 'r1',
    childTaskId: 'c1',
    parentObjective: 'build the thing',
    reasonForDelegation: 'split work',
    constraints: [],
    decisions: [],
    relevantArtifacts: [],
    relevantEvidence: [],
    assumptions: [],
    openQuestions: [],
    createdAt: NOW,
    ...overrides,
  }
}

function persistedKinds(h: { sessions: Map<string, StoredSession> }): string[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => (item.data as TaskEvent).kind))
}

describe('TaskService store lifecycle', () => {
  test('createStore and openStore own distinct error paths around replay', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    expect(rootTaskStoreId('abc')).toBe('sg-t-abc')

    await expect(service.openStore('sg-t-missing')).rejects.toThrow('does not exist')
    await expect(service.snapshotIn(STORE)).rejects.toThrow('not open')

    const empty = await service.createStore(STORE)
    expect(empty).toEqual({ version: 1, id: STORE, tasks: [], runs: [], edges: [], evidence: [], handoffs: [], capabilities: {} })
    await expect(service.createStore(STORE)).rejects.toThrow('already open')
    await expect(service.createStore('bad id!')).rejects.toThrow('invalid store id')

    const again = await service.openStore(STORE)
    expect(again.id).toBe(STORE)

    await Promise.all(h.disposers.map(dispose => dispose()))
    const h2 = harness(h.sessions)
    const service2 = new TaskService(h2.ctx as never)
    await expect(service2.createStore(STORE)).rejects.toThrow('already exists')
    const reopened = await service2.openStore(STORE)
    expect(reopened.id).toBe(STORE)
  })
})

describe('TaskService run lifecycle', () => {
  test('drives a task from creation to verified, gating on evidence', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task(), 'tester')
    await service.admitTaskIn(STORE, 't1', 'tester', { manifest: { capabilities: {}, missing: [], closure: 'closed' } })
    await service.startRunIn(STORE, run(), 'tester')
    await service.markRunStatusIn(STORE, 't1', 'r1', 'verifying', 'tester')

    const before = [...h.sessions.values()][0]!.events.length
    const broadcasts = h.changes.length
    await expect(service.markRunStatusIn(STORE, 't1', 'r1', 'verified', 'tester')).rejects.toThrow('no evidence')
    expect([...h.sessions.values()][0]!.events).toHaveLength(before)
    expect(h.changes).toHaveLength(broadcasts)

    await service.recordEvidenceIn(STORE, evidence(), 'tester')
    await service.markRunStatusIn(STORE, 't1', 'r1', 'verified', 'tester')
    expect((await service.taskIn(STORE, 't1')).status).toBe('verified')
    const finished = await service.runIn(STORE, 'r1')
    expect(finished.status).toBe('verified')
    expect(finished.finishedAt).toBeDefined()
    expect(h.changes.every(id => id === STORE)).toBe(true)

    await expect(service.markRunStatusIn(STORE, 't1', 'r1', 'running', 'tester')).rejects.toThrow('startRunIn')
    expect(persistedKinds(h)).toEqual([
      'TaskCreated',
      'CapabilityResolved',
      'TaskAdmitted',
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
    ])
  })

  test('a failed run retries through startRunIn with a TaskRetried event', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task(), 'tester')
    await service.admitTaskIn(STORE, 't1', 'tester')
    await service.startRunIn(STORE, run(), 'tester')
    await service.markRunStatusIn(STORE, 't1', 'r1', 'failed', 'tester', { reason: 'verifier failed' })
    expect((await service.taskIn(STORE, 't1')).status).toBe('failed')

    await service.startRunIn(STORE, run({ runId: 'r2', sessionId: 's2' }), 'tester')
    const retried = await service.taskIn(STORE, 't1')
    expect(retried.status).toBe('running')
    expect(retried.runIds).toEqual(['r1', 'r2'])
    expect((await service.runIn(STORE, 'r1')).status).toBe('failed')
    expect(persistedKinds(h)).toEqual([
      'TaskCreated',
      'TaskAdmitted',
      'TaskStarted',
      'TaskFailed',
      'TaskRetried',
      'TaskStarted',
    ])
  })

  test('evidence for a terminal run is refused and never reaches the log', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task(), 'tester')
    await service.admitTaskIn(STORE, 't1', 'tester')
    await service.startRunIn(STORE, run(), 'tester')
    await service.markRunStatusIn(STORE, 't1', 'r1', 'failed', 'tester', { reason: 'verification timed out after 600000ms' })

    const before = persistedKinds(h)
    await expect(service.recordEvidenceIn(STORE, evidence(), 'verifier')).rejects.toThrow(
      'task: run "r1" is failed; evidence can only be recorded while the run is running',
    )
    expect(persistedKinds(h)).toEqual(before)
    expect((await service.snapshotIn(STORE)).evidence).toHaveLength(0)

    await service.startRunIn(STORE, run({ runId: 'r2', sessionId: 's2' }), 'tester')
    await service.recordEvidenceIn(STORE, evidence({ evidenceId: 'e2', taskRunId: 'r2' }), 'verifier')
    expect((await service.snapshotIn(STORE)).evidence.map(item => item.evidenceId)).toEqual(['e2'])
  })

  test('rejected validation never reaches the persisted log and the store stays writable', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task(), 'tester')

    await expect(service.startRunIn(STORE, run(), 'tester')).rejects.toThrow('illegal transition')
    expect(persistedKinds(h)).toEqual(['TaskCreated'])

    await service.admitTaskIn(STORE, 't1', 'tester')
    await service.startRunIn(STORE, run(), 'tester')
    expect((await service.taskIn(STORE, 't1')).status).toBe('running')
  })
})

describe('TaskService admission', () => {
  test('records capability manifests, gaps, and rejections', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'gap-task' }), 'tester')
    await service.createTaskIn(STORE, task({ taskId: 'rejected-task' }), 'tester')

    const gap = { capabilities: {}, missing: ['verilog-sim'], closure: 'gap' as const }
    await service.admitTaskIn(STORE, 'gap-task', 'tester', { decompositionStatus: 'decomposable', manifest: gap })
    const admitted = await service.taskIn(STORE, 'gap-task')
    expect(admitted.status).toBe('admitted')
    expect(admitted.decompositionStatus).toBe('decomposable')

    await service.rejectTaskIn(STORE, 'rejected-task', 'tester', 'capability gap and decomposition not allowed', gap)
    expect((await service.taskIn(STORE, 'rejected-task')).status).toBe('blocked')

    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.capabilities['gap-task']).toEqual(gap)
    expect(snapshot.capabilities['rejected-task']).toEqual(gap)
    expect(persistedKinds(h)).toEqual([
      'TaskCreated',
      'TaskCreated',
      'CapabilityResolved',
      'CapabilityGapDetected',
      'TaskAdmitted',
      'CapabilityResolved',
      'CapabilityGapDetected',
      'TaskRejected',
    ])
  })
})

describe('TaskService decomposition', () => {
  test('decomposeIn creates and admits children, wires edges, and decomposes the parent', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })

    await service.decomposeIn(STORE, 'root', [
      task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }),
      task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }),
    ], 'tester', [{ from: 'c1', to: 'c2' }])

    const parent = await service.taskIn(STORE, 'root')
    expect(parent.decompositionStatus).toBe('decomposed')
    expect(parent.childTaskIds).toEqual(['c1', 'c2'])
    const children = await service.childrenIn(STORE, 'root')
    expect(children.map(child => child.status)).toEqual(['admitted', 'admitted'])
    expect((await service.snapshotIn(STORE)).edges).toEqual([{ from: 'c1', to: 'c2' }])
    expect(persistedKinds(h)).toEqual([
      'TaskCreated',
      'TaskAdmitted',
      'TaskCreated',
      'TaskAdmitted',
      'TaskCreated',
      'TaskAdmitted',
      'DependencyAdded',
      'TaskDecomposed',
    ])

    await expect(service.addDependencyIn(STORE, { from: 'c2', to: 'c1' }, 'tester')).rejects.toThrow('cycle')
  })

  test('a cyclic decompose batch persists nothing and the store stays writable', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })

    const children = () => [
      task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }),
      task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }),
    ]
    await expect(
      service.decomposeIn(STORE, 'root', children(), 'tester', [{ from: 'c1', to: 'c2' }, { from: 'c2', to: 'c1' }]),
    ).rejects.toThrow('cycle')
    expect(persistedKinds(h)).toEqual(['TaskCreated', 'TaskAdmitted'])
    expect((await service.snapshotIn(STORE)).tasks).toHaveLength(1)

    await service.decomposeIn(STORE, 'root', children(), 'tester', [{ from: 'c1', to: 'c2' }])
    expect((await service.taskIn(STORE, 'root')).decompositionStatus).toBe('decomposed')
  })

  test('decomposeIn rejects empty children and wrong parent links before committing', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root' }), 'tester')
    await expect(service.decomposeIn(STORE, 'root', [], 'tester')).rejects.toThrow('at least one child')
    await expect(
      service.decomposeIn(STORE, 'root', [task({ taskId: 'c1', parentTaskId: 'other', depth: 1 })], 'tester'),
    ).rejects.toThrow('parentTaskId')
    expect(persistedKinds(h)).toEqual(['TaskCreated'])
  })
})

describe('TaskService handoffs', () => {
  test('recordHandoffIn stores handoffs between a parent run and a child task', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })
    await service.startRunIn(STORE, run({ taskId: 'root' }), 'tester')
    await service.decomposeIn(STORE, 'root', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester')

    await expect(
      service.recordHandoffIn(STORE, handoff({ parentTaskId: 'root', childTaskId: 'c1', parentRunId: 'ghost' }), 'tester'),
    ).rejects.toThrow('unknown run')
    await service.recordHandoffIn(STORE, handoff({ parentTaskId: 'root', childTaskId: 'c1' }), 'tester')
    expect((await service.snapshotIn(STORE)).handoffs).toHaveLength(1)
  })
})

describe('TaskService replay', () => {
  test('append → close → open replays into an equal snapshot and stays writable', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    const storeId = rootTaskStoreId('replay-root')
    await service.createStore(storeId)
    await service.createTaskIn(storeId, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(storeId, 'root', 'tester', { decompositionStatus: 'decomposable' })
    await service.decomposeIn(storeId, 'root', [
      task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }),
      task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }),
    ], 'tester', [{ from: 'c1', to: 'c2' }])
    await service.startRunIn(storeId, run({ taskId: 'c1' }), 'tester')
    await service.markRunStatusIn(storeId, 'c1', 'r1', 'verifying', 'tester')
    await service.recordEvidenceIn(storeId, evidence({ taskId: 'c1' }), 'tester')
    await service.markRunStatusIn(storeId, 'c1', 'r1', 'verified', 'tester')
    await service.recordHandoffIn(storeId, handoff({ parentTaskId: 'root', childTaskId: 'c2' }), 'tester')
    const before = await service.snapshotIn(storeId)
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness(h.sessions)
    const service2 = new TaskService(h2.ctx as never)
    const after = await service2.openStore(storeId)
    expect(after).toEqual(before)

    await service2.startRunIn(storeId, run({ runId: 'r2', taskId: 'c2', sessionId: 's2' }), 'tester')
    expect((await service2.runIn(storeId, 'r2')).status).toBe('running')
    const seqs = [...h2.sessions.values()][0]!.events.map(item => item.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })
})

describe('TaskService event log', () => {
  test('persisted events survive the lossless JSON round trip the session log enforces', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    const storeId = rootTaskStoreId('json-root')
    await service.createStore(storeId)
    await service.createTaskIn(storeId, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(storeId, 'root', 'tester', { decompositionStatus: 'decomposable' })
    await service.decomposeIn(storeId, 'root', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester', [])
    await service.startRunIn(storeId, run({ taskId: 'c1' }), 'tester')
    await service.markRunStatusIn(storeId, 'c1', 'r1', 'failed', 'tester')

    const records = [...h.sessions.values()][0]!.events
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(JSON.parse(JSON.stringify(record))).toStrictEqual(record)
    }
  })
})
