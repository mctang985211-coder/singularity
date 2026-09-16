import { describe, expect, test } from 'vitest'
import type {
  CapabilityManifest,
  EvidenceBundle,
  RunId,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskHandoff,
  TaskId,
  TaskInstance,
  TaskRun,
} from '../../src/types.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-16T00:00:00.000Z'

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

function createdState(): TaskState {
  const state = new TaskState('store')
  state.apply(ev('TaskCreated', { task: task() }))
  return state
}

function admittedState(): TaskState {
  const state = createdState()
  state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
  return state
}

function runningState(): TaskState {
  const state = admittedState()
  state.apply(ev('TaskStarted', { run: run() }, { runId: 'r1' }))
  return state
}

function verifyingState(): TaskState {
  const state = runningState()
  state.apply(ev('TaskVerifying', {}, { runId: 'r1' }))
  return state
}

function failedState(): TaskState {
  const state = verifyingState()
  state.apply(ev('TaskFailed', {}, { runId: 'r1' }))
  return state
}

function verifiedState(): TaskState {
  const state = verifyingState()
  state.apply(ev('EvidenceProduced', { evidence: evidence() }, { runId: 'r1' }))
  state.apply(ev('TaskVerified', { finishedAt: NOW }, { runId: 'r1' }))
  return state
}

describe('TaskState state machine', () => {
  test('walks the happy path created → admitted → running → verifying → verified', () => {
    const state = verifiedState()
    const snapshot = state.snapshot()
    expect(snapshot.tasks[0]?.status).toBe('verified')
    expect(snapshot.runs[0]?.status).toBe('verified')
    expect(snapshot.runs[0]?.finishedAt).toBe(NOW)
    expect(snapshot.tasks[0]?.runIds).toEqual(['r1'])
  })

  const illegal: Array<[string, () => TaskState, TaskEvent, string]> = [
    ['re-admit an admitted task', admittedState, ev('TaskAdmitted', { decompositionStatus: 'leaf' }), 'illegal transition'],
    ['reject an admitted task', admittedState, ev('TaskRejected', { reason: 'late' }), 'illegal transition'],
    ['start a run on a created task', createdState, ev('TaskStarted', { run: run() }, { runId: 'r1' }), 'illegal transition'],
    ['enter verifying from admitted', admittedState, ev('TaskVerifying', {}, { runId: 'r1' }), 'illegal transition'],
    ['verify a running task directly', runningState, ev('TaskVerified', {}, { runId: 'r1' }), 'illegal transition'],
    ['fail a created task', createdState, ev('TaskFailed', {}, { runId: 'r1' }), 'illegal transition'],
    ['retry a running task', runningState, ev('TaskRetried', {}), 'illegal transition'],
    ['retry an admitted task', admittedState, ev('TaskRetried', {}), 'illegal transition'],
    ['block a created task', createdState, ev('TaskBlocked', {}), 'illegal transition'],
    ['cancel an admitted task', admittedState, ev('TaskCancelled', {}), 'illegal transition'],
    ['verify without a run id', verifyingState, ev('TaskVerified', {}), 'requires a run id'],
    ['verify without evidence', verifyingState, ev('TaskVerified', {}, { runId: 'r1' }), 'no evidence'],
  ]

  test.each(illegal)('%s is rejected', (_name, setup, event, message) => {
    const state = setup()
    expect(() => state.apply(event)).toThrow(message)
  })

  test('a rejected TaskVerified leaves task and run untouched', () => {
    const state = verifyingState()
    expect(() => state.apply(ev('TaskVerified', {}, { runId: 'r1' }))).toThrow('no evidence')
    expect(state.snapshot().tasks[0]?.status).toBe('verifying')
    expect(state.snapshot().runs[0]?.status).toBe('running')
  })

  test('evidence for a run that has left the running state is refused and unlocks nothing', () => {
    const state = failedState()
    state.apply(ev('TaskRetried', {}))
    state.apply(ev('TaskStarted', { run: run({ runId: 'r2', sessionId: 's2' }) }, { runId: 'r2' }))
    state.apply(ev('TaskVerifying', {}, { runId: 'r2' }))
    expect(() => state.apply(ev('EvidenceProduced', { evidence: evidence({ taskRunId: 'r1' }) }, { runId: 'r1' })))
      .toThrow('task: run "r1" is failed; evidence can only be recorded while the run is running')
    expect(() => state.apply(ev('TaskVerified', {}, { runId: 'r2' }))).toThrow('no evidence')
    expect(state.snapshot().tasks[0]?.status).toBe('verifying')
    expect(state.snapshot().runs.map(item => item.status)).toEqual(['failed', 'running'])
  })

  test('blocked from running marks the run blocked; blocked from ready needs no run', () => {
    const state = runningState()
    state.apply(ev('TaskBlocked', { reason: 'waiting on dependency' }, { runId: 'r1' }))
    expect(state.snapshot().tasks[0]?.status).toBe('blocked')
    expect(state.snapshot().runs[0]?.status).toBe('blocked')

    const ready = failedState()
    ready.apply(ev('TaskRetried', {}))
    expect(ready.snapshot().tasks[0]?.status).toBe('ready')
    ready.apply(ev('TaskBlocked', { reason: 'deps unmet' }))
    expect(ready.snapshot().tasks[0]?.status).toBe('blocked')
  })

  test('blocked from admitted needs no run (dependency failed before the child ever started)', () => {
    const state = admittedState()
    state.apply(ev('TaskBlocked', { reason: 'dependency failed' }))
    expect(state.snapshot().tasks[0]?.status).toBe('blocked')
    expect(state.snapshot().runs).toHaveLength(0)
  })

  test('a failed task retries through ready into a new run', () => {
    const state = failedState()
    state.apply(ev('TaskRetried', {}))
    expect(state.snapshot().tasks[0]?.status).toBe('ready')
    state.apply(ev('TaskStarted', { run: run({ runId: 'r2', sessionId: 's2' }) }, { runId: 'r2' }))
    const snapshot = state.snapshot()
    expect(snapshot.tasks[0]?.status).toBe('running')
    expect(snapshot.tasks[0]?.runIds).toEqual(['r1', 'r2'])
    expect(snapshot.runs.map(item => item.status)).toEqual(['failed', 'running'])
  })

  test('a running task cancels into a terminal state', () => {
    const state = runningState()
    state.apply(ev('TaskCancelled', { reason: 'abort' }, { runId: 'r1' }))
    expect(state.snapshot().tasks[0]?.status).toBe('cancelled')
    expect(state.snapshot().runs[0]?.status).toBe('cancelled')
    expect(() => state.apply(ev('TaskRetried', {}))).toThrow('illegal transition')
    expect(() => state.apply(ev('TaskStarted', { run: run({ runId: 'r2' }) }, { runId: 'r2' }))).toThrow('illegal transition')
  })

  test('verified is terminal', () => {
    const state = verifiedState()
    expect(() => state.apply(ev('TaskStarted', { run: run({ runId: 'r2' }) }, { runId: 'r2' }))).toThrow('illegal transition')
    expect(() => state.apply(ev('TaskRetried', {}))).toThrow('illegal transition')
    expect(() => state.apply(ev('TaskBlocked', {}))).toThrow('illegal transition')
  })

  test('clone isolates mutations from the source state', () => {
    const state = createdState()
    const next = state.clone()
    next.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }))
    expect(state.snapshot().tasks[0]?.status).toBe('created')
    expect(next.snapshot().tasks[0]?.status).toBe('admitted')
  })
})

describe('TaskState tree integrity', () => {
  test('rejects unknown parents, depth mismatches, self-parenting, and duplicate ids', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root' }) }, { taskId: 'root' }))
    expect(() =>
      state.apply(ev('TaskCreated', { task: task({ taskId: 'orphan', parentTaskId: 'ghost', depth: 1 }) }, { taskId: 'orphan' })),
    ).toThrow('unknown task')
    expect(() =>
      state.apply(ev('TaskCreated', { task: task({ taskId: 'self', parentTaskId: 'self' }) }, { taskId: 'self' })),
    ).toThrow('its own parent')
    expect(() =>
      state.apply(ev('TaskCreated', { task: task({ taskId: 'flat', parentTaskId: 'root', depth: 0 }) }, { taskId: 'flat' })),
    ).toThrow('depth')
    expect(() =>
      state.apply(ev('TaskCreated', { task: task({ taskId: 'deep', depth: 1 }) }, { taskId: 'deep' })),
    ).toThrow('depth')
    expect(() =>
      state.apply(ev('TaskCreated', { task: task({ taskId: 'root' }) }, { taskId: 'root' })),
    ).toThrow('already exists')
  })

  test('registers children on the parent exactly once', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root' }) }, { taskId: 'root' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c2', parentTaskId: 'root' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'g1', parentTaskId: 'c1', depth: 2 }) }, { taskId: 'g1', parentTaskId: 'c1' }))
    const snapshot = state.snapshot()
    expect(snapshot.tasks.find(item => item.taskId === 'root')?.childTaskIds).toEqual(['c1', 'c2'])
    expect(snapshot.tasks.find(item => item.taskId === 'c1')?.childTaskIds).toEqual(['g1'])
  })

  test('rejects tasks created with runs or children already attached', () => {
    const state = new TaskState('store')
    expect(() => state.apply(ev('TaskCreated', { task: task({ runIds: ['r1'] }) }))).toThrow('must use events')
    expect(() => state.apply(ev('TaskCreated', { task: task({ childTaskIds: ['c1'] }) }))).toThrow('must use events')
  })
})

describe('TaskState dependency DAG', () => {
  function dagState(): TaskState {
    const state = new TaskState('store')
    for (const taskId of ['a', 'b', 'c', 'd']) {
      state.apply(ev('TaskCreated', { task: task({ taskId }) }, { taskId }))
      state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId }))
    }
    return state
  }

  test('rejects self edges, duplicates, and direct cycles', () => {
    const state = dagState()
    expect(() => state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'a' } }, { taskId: 'a' }))).toThrow('cycle')
    state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'b' } }, { taskId: 'b' }))
    expect(() => state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'b' } }, { taskId: 'b' }))).toThrow('already exists')
    expect(() => state.apply(ev('DependencyAdded', { edge: { from: 'b', to: 'a' } }, { taskId: 'a' }))).toThrow('cycle')
    expect(() => state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'zz' } }, { taskId: 'zz' }))).toThrow('unknown task')
  })

  test('detects cycles across branches of the DAG', () => {
    const state = dagState()
    state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'b' } }, { taskId: 'b' }))
    state.apply(ev('DependencyAdded', { edge: { from: 'a', to: 'c' } }, { taskId: 'c' }))
    state.apply(ev('DependencyAdded', { edge: { from: 'b', to: 'd' } }, { taskId: 'd' }))
    state.apply(ev('DependencyAdded', { edge: { from: 'c', to: 'd' } }, { taskId: 'd' }))
    // d is reachable from a through both branches; d → a closes a cycle
    expect(() => state.apply(ev('DependencyAdded', { edge: { from: 'd', to: 'a' } }, { taskId: 'a' }))).toThrow('cycle')
    // a converging edge that opens no cycle is accepted
    state.apply(ev('DependencyAdded', { edge: { from: 'b', to: 'c' } }, { taskId: 'c' }))
    expect(state.snapshot().edges).toHaveLength(5)
  })
})

describe('TaskState decomposition', () => {
  function rootState(): TaskState {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' }))
    return state
  }

  test('TaskDecomposed requires at least one admitted child', () => {
    const state = rootState()
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: [] }, { taskId: 'root' }))).toThrow('admitted child')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
    // child exists but is still only created
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))).toThrow('admitted child')
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))
    expect(state.snapshot().tasks.find(item => item.taskId === 'root')?.decompositionStatus).toBe('decomposed')
  })

  test('TaskDecomposed payload must name real children and cannot repeat', () => {
    const state = rootState()
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: ['stranger'] }, { taskId: 'root' }))).toThrow('not a child')
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))).toThrow('already decomposed')
  })
})

describe('TaskState evidence and handoffs', () => {
  test('EvidenceProduced validates ownership and merges into the run', () => {
    const state = runningState()
    expect(() =>
      state.apply(ev('EvidenceProduced', { evidence: evidence({ taskId: 'other' }) }, { runId: 'r1' })),
    ).toThrow('does not belong to task')
    expect(() =>
      state.apply(ev('EvidenceProduced', { evidence: evidence({ taskRunId: 'ghost' }) }, { runId: 'ghost' })),
    ).toThrow('unknown run')
    state.apply(ev('EvidenceProduced', {
      evidence: evidence({
        artifacts: [{ artifactId: 'a1', kind: 'log', uri: 'logs/a1' }],
        verifierResults: [{ criterionId: 'c1', status: 'pass', verifierId: 'cmd' }],
      }),
    }, { runId: 'r1' }))
    const snapshot = state.snapshot()
    expect(snapshot.evidence).toHaveLength(1)
    expect(snapshot.runs[0]?.artifacts).toHaveLength(1)
    expect(snapshot.runs[0]?.verifierResults).toHaveLength(1)
    expect(() => state.apply(ev('EvidenceProduced', { evidence: evidence() }, { runId: 'r1' }))).toThrow('already exists')
  })

  test('HandoffCreated validates the parent-child relationship and parent run', () => {
    const state = runningState()
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 't1', depth: 1 }) }, { taskId: 'c1', parentTaskId: 't1' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'u1' }) }, { taskId: 'u1' }))
    expect(() => state.apply(ev('HandoffCreated', { handoff: handoff({ childTaskId: 'u1' }) }, { taskId: 'u1' }))).toThrow('not a child')
    expect(() =>
      state.apply(ev('HandoffCreated', { handoff: handoff({ parentRunId: 'ghost' }) }, { taskId: 'c1' })),
    ).toThrow('unknown run')
    state.apply(ev('HandoffCreated', { handoff: handoff() }, { taskId: 'c1', parentTaskId: 't1', runId: 'r1' }))
    expect(state.snapshot().handoffs).toHaveLength(1)
    expect(() => state.apply(ev('HandoffCreated', { handoff: handoff() }, { taskId: 'c1' }))).toThrow('already exists')
  })

  test('CapabilityResolved stores the manifest per task', () => {
    const state = createdState()
    const manifest: CapabilityManifest = { capabilities: { build: { skills: ['s'], tools: ['t'] } }, missing: [], closure: 'closed' }
    state.apply(ev('CapabilityResolved', { manifest }))
    expect(state.snapshot().capabilities['t1']).toEqual(manifest)
    expect(() => state.apply(ev('CapabilityResolved', { manifest }, { taskId: 'ghost' }))).toThrow('unknown task')
    expect(() => state.apply(ev('CapabilityGapDetected', { missing: ['x'] }, { taskId: 'ghost' }))).toThrow('unknown task')
  })
})
