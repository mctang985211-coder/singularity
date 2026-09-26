import { describe, expect, test } from 'vitest'
import { TASK_CONTRACT_VERSION } from '../../src/contract.ts'
import type { AdmissionContext, DecompositionAdmission, TaskContract } from '../../src/contract.ts'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  Diagnosis,
  EvidenceBundle,
  Obligation,
  ReviewRecord,
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
import { batchIdFor } from '../../src/proposal.ts'
import { runMemberTaskIds } from '../../src/types.ts'

const NOW = '2026-09-16T00:00:00.000Z'

/** The three fields one batch identity is spelled out as, for a given run and proposal. */
function batchIdentity(parentRunId: RunId, proposalId: string): { batchId: string; parentRunId: RunId; proposalId: string } {
  return { batchId: batchIdFor(parentRunId, proposalId), parentRunId, proposalId }
}

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
    // A parent may decompose more than once: the same child, recorded under a
    // second batch, is a second admission of it, not a repeat of the first.
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))
    expect(state.snapshot().tasks.find(item => item.taskId === 'root')?.decompositionStatus).toBe('decomposed')
  })

  test('a second batch under the same run and proposal is refused, a different one is not', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' }))
    state.apply(ev('TaskStarted', { run: run({ taskId: 'root', executionPhase: 'active' }) }, { taskId: 'root', runId: 'r1' }))
    for (const childTaskId of ['c1', 'c2']) {
      state.apply(ev('TaskCreated', { task: task({ taskId: childTaskId, parentTaskId: 'root', depth: 1 }) }, { taskId: childTaskId, parentTaskId: 'root' }))
      state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: childTaskId }))
    }
    const batch = batchIdentity('r1', 'p-one')
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'], ...batch }, { taskId: 'root' }))
    expect(state.snapshot().runs[0]?.batches).toEqual([
      { batchId: batch.batchId, proposalId: 'p-one', memberTaskIds: ['c1'] },
    ])
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'], ...batch }, { taskId: 'root' })))
      .toThrow('already holds batch')
    // The second proposal of one run is a second batch, and its members append.
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c2'], ...batchIdentity('r1', 'p-two') }, { taskId: 'root' }))
    expect(state.snapshot().runs[0]?.batches?.map(item => item.memberTaskIds)).toEqual([['c1'], ['c2']])
    expect(runMemberTaskIds(state.snapshot().runs[0]!)).toEqual(['c1', 'c2'])
  })

  test('a batch identity that is not the pair it names, or names another task\'s run, is refused', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
    state.apply(ev('TaskStarted', { run: run({ taskId: 'root', executionPhase: 'active' }) }, { taskId: 'root', runId: 'r1' }))
    const before = state.snapshot()
    expect(() => state.apply(ev('TaskDecomposed', {
      childTaskIds: ['c1'], batchId: 'b-r1-p-one', parentRunId: 'r1', proposalId: 'p-two',
    }, { taskId: 'root' })))
      .toThrow('is not the batch of run "r1" and proposal "p-two"')
    expect(() => state.apply(ev('TaskDecomposed', {
      childTaskIds: ['c1'], batchId: 'b-r1-p-one', parentRunId: 'r1',
    }, { taskId: 'root' })))
      .toThrow('a batch is identified by all three or by none')
    expect(state.snapshot()).toEqual(before)
    state.apply(ev('TaskCreated', { task: task({ taskId: 'other-run-task', depth: 0 }) }, { taskId: 'other-run-task' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'other-run-task' }))
    state.apply(ev('TaskStarted', { run: run({ runId: 'r2', taskId: 'other-run-task', executionPhase: 'active' }) }, { taskId: 'other-run-task', runId: 'r2' }))
    expect(() => state.apply(ev('TaskDecomposed', {
      childTaskIds: ['c1'], ...batchIdentity('r2', 'p-one'),
    }, { taskId: 'root' })))
      .toThrow('belongs to task "other-run-task", not "root"')
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

describe('TaskState reviews', () => {
  function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
    return { taskId: 't1', outcome: 'verified', evidenceRefs: ['e1'], anomalies: [], ...overrides }
  }

  test('a terminal run accepts exactly one review; a second one is rejected', () => {
    const state = verifiedState()
    state.apply(ev('ReviewRecorded', { review: review({ runId: 'r1' }) }, { runId: 'r1' }))
    expect(state.snapshot().reviews).toEqual([review({ runId: 'r1' })])
    expect(() => state.apply(ev('ReviewRecorded', { review: review({ runId: 'r1' }) }, { runId: 'r1' }))).toThrow('already has a review')
  })

  test('a review must follow the run\'s terminal state and carries a cause iff failed', () => {
    const failed = failedState()
    expect(() => failed.apply(ev('ReviewRecorded', { review: review({ runId: 'r1', outcome: 'failed' }) }, { runId: 'r1' })))
      .toThrow('requires a localized cause')
    failed.apply(ev('ReviewRecorded', { review: review({ runId: 'r1', outcome: 'failed', localizedCause: 'boom' }) }, { runId: 'r1' }))
    expect(failed.snapshot().reviews[0]?.localizedCause).toBe('boom')

    const verified = verifiedState()
    expect(() => verified.apply(ev('ReviewRecorded', { review: review({ runId: 'r1', localizedCause: 'stray' }) }, { runId: 'r1' })))
      .toThrow('only a failed outcome')
    expect(() => verified.apply(ev('ReviewRecorded', { review: review({ runId: 'r1', outcome: 'failed', localizedCause: 'boom' }) }, { runId: 'r1' })))
      .toThrow('must follow the terminal transition')
    expect(() => verified.apply(ev('ReviewRecorded', { review: review({ runId: 'ghost' }) }, { runId: 'ghost' }))).toThrow('unknown run')
  })

  test('a runless review is accepted only for a blocked task, exactly once', () => {
    const state = admittedState()
    const blockedReview = review({ outcome: 'blocked', evidenceRefs: [], anomalies: ['dependencies [t0] did not verify'], relatedTaskIds: ['t0'] })
    expect(() => state.apply(ev('ReviewRecorded', { review: blockedReview }))).toThrow('only a blocked task settles without a run')
    state.apply(ev('TaskBlocked', { reason: 'dependencies [t0] did not verify' }))
    state.apply(ev('ReviewRecorded', { review: blockedReview }))
    expect(state.snapshot().reviews).toEqual([blockedReview])
    expect(() => state.apply(ev('ReviewRecorded', { review: blockedReview }))).toThrow('already has a runless review')
  })

  test('a log tail rides only on a failed outcome; criteria and durationMs pass through untouched', () => {
    const verified = verifiedState()
    expect(() => verified.apply(ev('ReviewRecorded', { review: review({ runId: 'r1', logTail: 'tail' }) }, { runId: 'r1' })))
      .toThrow('only a failed outcome carries a log tail')
    verified.apply(ev('ReviewRecorded', {
      review: review({
        runId: 'r1',
        durationMs: 42,
        criteria: [{ criterionId: 'c1', verdict: 'pass', command: 'true', exitCode: 0, logRef: 'store/r1/c1.log' }],
      }),
    }, { runId: 'r1' }))
    expect(verified.snapshot().reviews[0]).toMatchObject({ durationMs: 42, criteria: [{ criterionId: 'c1', verdict: 'pass', exitCode: 0 }] })

    const failed = failedState()
    failed.apply(ev('ReviewRecorded', {
      review: review({ runId: 'r1', outcome: 'failed', localizedCause: 'boom', logTail: 'tail', durationMs: 7 }),
    }, { runId: 'r1' }))
    expect(failed.snapshot().reviews[0]).toMatchObject({ logTail: 'tail', durationMs: 7 })
  })

  test('blockers ride only on a blocked outcome', () => {
    const verified = verifiedState()
    expect(() => verified.apply(ev('ReviewRecorded', {
      review: review({ runId: 'r1', blockedBy: [{ taskId: 't0', outcome: 'failed' }] }),
    }, { runId: 'r1' }))).toThrow('only a blocked outcome carries blockers')

    const state = admittedState()
    state.apply(ev('TaskBlocked', { reason: 'dependencies [t0] did not verify' }))
    state.apply(ev('ReviewRecorded', {
      review: review({ outcome: 'blocked', evidenceRefs: [], anomalies: ['dependencies [t0] did not verify'], blockedBy: [{ taskId: 't0', outcome: 'failed' }] }),
    }))
    expect(state.snapshot().reviews[0]?.blockedBy).toEqual([{ taskId: 't0', outcome: 'failed' }])
  })
})

describe('TaskState diagnoses', () => {
  function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
    return {
      diagnosisId: 'd1',
      taskId: 't1',
      observedFailure: 'criterion c1 failed',
      scope: 'this task only',
      localizedCause: 'the parser rejects empty input',
      evidenceRefs: ['e1'],
      reviewRefs: ['t1#r1'],
      confidence: 'medium',
      proposals: [],
      ...overrides,
    }
  }

  test('a task accepts a diagnosis and several diagnoses accumulate under distinct ids', () => {
    const state = verifiedState()
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis() }))
    expect(state.snapshot().diagnoses).toEqual([diagnosis()])
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ diagnosisId: 'd2', confidence: 'low' }) }))
    expect(state.snapshot().diagnoses.map(item => item.diagnosisId)).toEqual(['d1', 'd2'])
  })

  test('a repeated diagnosis id is rejected, across tasks too', () => {
    const state = verifiedState()
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis() }))
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis() }))).toThrow('already exists')
    expect(state.snapshot().diagnoses).toHaveLength(1)
  })

  test('the diagnosis must belong to an existing task and match the envelope task', () => {
    const state = verifiedState()
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ taskId: 'ghost' }) }, { taskId: 'ghost' }))).toThrow('unknown task')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ taskId: 'other' }) }))).toThrow('does not belong')
  })

  test('empty text fields, a stray confidence, and missing refs are rejected', () => {
    const state = verifiedState()
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ observedFailure: '' }) }))).toThrow('observed failure')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ scope: '' }) }))).toThrow('scope')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ localizedCause: '' }) }))).toThrow('localized cause')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ confidence: '0.41' as Diagnosis['confidence'] }) }))).toThrow('confidence')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ evidenceRefs: [], reviewRefs: [] }) }))).toThrow('at least one evidence or review ref')
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ evidenceRefs: [''] }) }))).toThrow('non-empty strings')
  })

  test('proposals name one of the nine frozen target types and carry id and rationale', () => {
    const state = verifiedState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ proposals: [{ targetType: 'production' as Diagnosis['proposals'][number]['targetType'], targetId: 'x', rationale: 'y' }] }),
    }))).toThrow('target type')
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ proposals: [{ targetType: 'skill', targetId: '', rationale: 'y' }] }),
    }))).toThrow('target id and a rationale')
    state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ proposals: [{ targetType: 'verifier', targetId: 'command', rationale: 'the criterion command misses the empty-input case' }] }),
    }))
    expect(state.snapshot().diagnoses[0]?.proposals).toEqual([
      { targetType: 'verifier', targetId: 'command', rationale: 'the criterion command misses the empty-input case' },
    ])
  })

  test('relatedTaskIds point at existing tasks (cross-task lineage inside the store)', () => {
    const state = verifiedState()
    expect(() => state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ relatedTaskIds: ['ghost'] }) }))).toThrow('unknown task')
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ relatedTaskIds: ['t1'] }) }))
    expect(state.snapshot().diagnoses[0]?.relatedTaskIds).toEqual(['t1'])
  })
})

describe('TaskState obligations', () => {
  function obligation(overrides: Partial<Obligation> = {}): Obligation {
    return {
      obligationId: 'o1',
      goal: 'artifact "bemu_trace" required by task "t1" criterion c1 does not exist in the task store',
      criterion: 'the task store holds evidence or an artifact named "bemu_trace"',
      sourceTaskId: 't1',
      ...overrides,
    }
  }

  test('a task accepts an obligation and several obligations accumulate under distinct ids', () => {
    const state = createdState()
    state.apply(ev('ObligationRecorded', { obligation: obligation() }))
    expect(state.snapshot().obligations).toEqual([obligation()])
    state.apply(ev('ObligationRecorded', { obligation: obligation({ obligationId: 'o2', goal: 'capability "ppa" is not granted' }) }))
    expect(state.snapshot().obligations.map(item => item.obligationId)).toEqual(['o1', 'o2'])
  })

  test('a repeated obligation id is rejected', () => {
    const state = createdState()
    state.apply(ev('ObligationRecorded', { obligation: obligation() }))
    expect(() => state.apply(ev('ObligationRecorded', { obligation: obligation() }))).toThrow('already exists')
    expect(state.snapshot().obligations).toHaveLength(1)
  })

  test('empty fields and an unknown source task are rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('ObligationRecorded', { obligation: obligation({ obligationId: '' }) }))).toThrow('non-empty string')
    expect(() => state.apply(ev('ObligationRecorded', { obligation: obligation({ goal: '' }) }))).toThrow('requires a goal')
    expect(() => state.apply(ev('ObligationRecorded', { obligation: obligation({ criterion: '' }) }))).toThrow('requires a criterion')
    expect(() => state.apply(ev('ObligationRecorded', { obligation: obligation({ sourceTaskId: 'ghost' }) }))).toThrow('unknown task')
    expect(state.snapshot().obligations).toHaveLength(0)
  })
})

describe('TaskState contract and admission records', () => {
  const PROPOSAL_DIGEST = '3f2a1c0e9d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f'

  const CRITERION: AcceptanceCriterion = {
    criterionId: 'c1',
    description: 'compiles',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command: 'true',
  }

  const ADMISSION_CONTEXT: AdmissionContext = {
    maxDepth: 2,
    maxChildren: 4,
    wallTimeMs: 600_000,
    auditOnly: { maxToolCalls: 200, tokens: 1_000_000, attempts: 3 },
  }

  function contract(overrides: Partial<TaskContract> = {}): TaskContract {
    return {
      contractVersion: TASK_CONTRACT_VERSION,
      objective: 'build the thing',
      acceptanceCriteria: [CRITERION],
      assumptions: ['the checkout is clean'],
      constraints: ['no network access'],
      requiredCapabilities: [],
      ...overrides,
    }
  }

  /**
   * A task whose projection fields are generated from its contract, so the two
   * agree by construction; a `projection` override breaks that agreement on
   * purpose for the refusal cases.
   */
  function contractedTask(
    contractOverrides: Partial<TaskContract> = {},
    projection: Partial<Pick<TaskInstance, 'objective' | 'acceptanceCriteria' | 'requestedCapabilities'>> = {},
  ): TaskInstance {
    const value = contract(contractOverrides)
    return task({
      objective: value.objective,
      acceptanceCriteria: value.acceptanceCriteria,
      requestedCapabilities: [...value.requiredCapabilities],
      contract: value,
      ...projection,
    })
  }

  function admission(overrides: Record<string, unknown> = {}): DecompositionAdmission {
    return { proposalDigest: PROPOSAL_DIGEST, context: ADMISSION_CONTEXT, ...overrides } as DecompositionAdmission
  }

  function decomposableState(): TaskState {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task({ taskId: 'root', decompositionStatus: 'decomposable' }) }, { taskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'decomposable' }, { taskId: 'root' }))
    state.apply(ev('TaskCreated', { task: task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }) }, { taskId: 'c1', parentTaskId: 'root' }))
    state.apply(ev('TaskAdmitted', { decompositionStatus: 'leaf' }, { taskId: 'c1' }))
    return state
  }

  test('stores a task with a consistent contract and reads it back unchanged', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: contractedTask() }))
    const stored = state.snapshot().tasks[0]
    expect(stored?.contract).toEqual(contract())
    expect(stored?.contract?.assumptions).toEqual(['the checkout is clean'])
    expect(stored?.contract?.constraints).toEqual(['no network access'])
    expect(stored?.objective).toBe('build the thing')
    expect(stored?.acceptanceCriteria).toEqual([CRITERION])
    expect(stored?.requestedCapabilities).toEqual([])
  })

  test('accepts a contract that spells the same data with keys in another order', () => {
    const state = new TaskState('store')
    const reordered: TaskContract = {
      requiredCapabilities: [],
      constraints: ['no network access'],
      assumptions: ['the checkout is clean'],
      acceptanceCriteria: [
        { command: 'true', mandatory: true, requiredEvidence: [], verificationMode: 'deterministic', description: 'compiles', criterionId: 'c1' },
      ],
      objective: 'build the thing',
      contractVersion: TASK_CONTRACT_VERSION,
    }
    state.apply(ev('TaskCreated', { task: task({ contract: reordered }) }))
    expect(state.snapshot().tasks).toHaveLength(1)
  })

  const disagreeing: Array<[string, TaskInstance, string]> = [
    ['objective', contractedTask({}, { objective: 'ship the release' }), 'task: task "t1" objective disagrees with its contract objective'],
    ['acceptance criteria', contractedTask({}, { acceptanceCriteria: [{ ...CRITERION, command: 'false' }] }), 'task: task "t1" acceptance criteria disagree with its contract'],
    ['requested capabilities', contractedTask({ requiredCapabilities: ['research'] }, { requestedCapabilities: [] }), 'task: task "t1" requested capabilities disagree with its contract'],
  ]

  test.each(disagreeing)('refuses a task whose %s disagree with its contract and stores nothing', (_name, created, message) => {
    const state = new TaskState('store')
    expect(() => state.apply(ev('TaskCreated', { task: created }))).toThrow(message)
    expect(state.snapshot().tasks).toHaveLength(0)
  })

  test('refuses a contract version this build does not know', () => {
    const state = new TaskState('store')
    const future = contractedTask({ contractVersion: 2 as TaskContract['contractVersion'] })
    expect(() => state.apply(ev('TaskCreated', { task: future })))
      .toThrow('task: task "t1" declares contract version 2; this build stores version 1')
    expect(state.snapshot().tasks).toHaveLength(0)
  })

  test('refuses a contract whose assumptions carry a non-string', () => {
    const state = new TaskState('store')
    const malformed = contractedTask({ assumptions: ['the checkout is clean', 7 as unknown as string] })
    expect(() => state.apply(ev('TaskCreated', { task: malformed })))
      .toThrow('task: task "t1" contract assumptions must be an array of strings')
    expect(state.snapshot().tasks).toHaveLength(0)
  })

  test('a task created without a contract still applies (legacy store compatibility)', () => {
    const state = new TaskState('store')
    state.apply(ev('TaskCreated', { task: task() }))
    const stored = state.snapshot().tasks[0]
    expect(stored).toEqual(task())
    expect(stored?.contract).toBeUndefined()
  })

  const malformedAdmissions: Array<[string, DecompositionAdmission, string]> = [
    ['an empty proposal digest', admission({ proposalDigest: '' }), 'task: task "root" decomposition admission requires a proposal digest'],
    ['a non-string proposal digest', admission({ proposalDigest: 42 }), 'task: task "root" decomposition admission requires a proposal digest'],
    ['a non-object context', admission({ context: 'limits' }), 'task: task "root" decomposition admission requires an admission context'],
    ['a null context', admission({ context: null }), 'task: task "root" decomposition admission requires an admission context'],
    ['an array context', admission({ context: [] }), 'task: task "root" decomposition admission requires an admission context'],
    ['a negative maxDepth', admission({ context: { ...ADMISSION_CONTEXT, maxDepth: -1 } }), 'task: task "root" admission context maxDepth must be a non-negative integer'],
    ['a fractional maxChildren', admission({ context: { ...ADMISSION_CONTEXT, maxChildren: 1.5 } }), 'task: task "root" admission context maxChildren must be a non-negative integer'],
    ['a non-object auditOnly', admission({ context: { ...ADMISSION_CONTEXT, auditOnly: 'none' } }), 'task: task "root" admission context auditOnly must be an object'],
    ['an array auditOnly', admission({ context: { ...ADMISSION_CONTEXT, auditOnly: [] } }), 'task: task "root" admission context auditOnly must be an object'],
    ['an infinite wallTimeMs', admission({ context: { ...ADMISSION_CONTEXT, wallTimeMs: Number.POSITIVE_INFINITY } }), 'task: task "root" admission context wallTimeMs must be a finite number when present'],
    ['a NaN tokens limit', admission({ context: { ...ADMISSION_CONTEXT, auditOnly: { maxToolCalls: 200, tokens: Number.NaN } } }), 'task: task "root" admission context auditOnly.tokens must be a finite number when present'],
  ]

  test.each(malformedAdmissions)('refuses a decomposition carrying %s and leaves the parent decomposable', (_name, value, message) => {
    const state = decomposableState()
    expect(() => state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'], admission: value }, { taskId: 'root' }))).toThrow(message)
    expect(state.snapshot().tasks.find(item => item.taskId === 'root')?.decompositionStatus).toBe('decomposable')
  })

  test('records a decomposition whose admission is well-formed', () => {
    const state = decomposableState()
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'], admission: admission() }, { taskId: 'root' }))
    expect(state.snapshot().tasks.find(item => item.taskId === 'root')?.decompositionStatus).toBe('decomposed')
  })

  test('a decomposition event without an admission still applies (legacy store compatibility)', () => {
    const state = decomposableState()
    state.apply(ev('TaskDecomposed', { childTaskIds: ['c1'] }, { taskId: 'root' }))
    expect(state.snapshot().tasks.find(item => item.taskId === 'root')?.decompositionStatus).toBe('decomposed')
  })
})
