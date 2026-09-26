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
import type { AdmissionContext, DecompositionIdentity, TaskContract } from '../../src/contract.ts'
import { TASK_CONTRACT_VERSION, contractDigest, decompositionDigest, sha256Hex } from '../../src/contract.ts'
import type { TaskProposalBatchConsumption, TaskProposalDecomposition, TaskProposalReviewContext } from '../../src/proposal.ts'
import {
  admissionContextDigest,
  batchIdFor,
  reviewContextDigest,
  taskProposalId,
} from '../../src/proposal.ts'
import { TaskService } from '../../src/index.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-16T00:00:00.000Z'
const STORE = 'sg-t-root-session'
/** The batch id the phase tests open and close: the pair `(r1, p-one)` as spelled by the one derivation. */
const BATCH = batchIdFor('r1', 'p-one')

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
  state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { runId: 'r1' }))
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
  test('active → waiting_children records the phase and the batch id it opens', () => {
    const state = activeState()
    state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('waiting_children')
    expect(stored?.batchId).toBe(BATCH)
    expect(stored?.submission).toBeUndefined()
    // The batch id is the pair the derivation spells out, not a task id.
    expect(stored?.batchId).toBe('b-r1-p-one')
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

  test('waiting_children → active closes the batch: the phase returns and the current batch id is cleared', () => {
    const state = waitingChildrenState()
    state.apply(ev('RunPhaseChanged', { phase: 'active', batchId: BATCH }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('active')
    expect(stored?.batchId).toBeUndefined()
    expect(stored?.submission).toBeUndefined()
    // The cleared field is the *current* batch; which batches ran is history.
    expect(stored && 'batchId' in stored).toBe(false)
  })

  test('a run may close one batch and open another: waiting_children → active → waiting_children', () => {
    const state = waitingChildrenState()
    state.apply(ev('RunPhaseChanged', { phase: 'active', batchId: BATCH }, { runId: 'r1' }))
    const second = batchIdFor('r1', 'p-two')
    state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: second }, { runId: 'r1' }))
    expect(state.snapshot().runs[0]?.executionPhase).toBe('waiting_children')
    expect(state.snapshot().runs[0]?.batchId).toBe(second)
  })

  test('waiting_children → submitted keeps the batch id, the carried question ids, and a runtime submission', () => {
    const state = activeState()
    state.apply(ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH, pendingQuestionIds: ['q1'] }, { runId: 'r1' }))
    state.apply(ev('RunPhaseChanged', { phase: 'submitted', submission: submission({ origin: 'runtime', summary: 'children settled' }) }, { runId: 'r1' }))
    const stored = state.snapshot().runs[0]
    expect(stored?.executionPhase).toBe('submitted')
    expect(stored?.batchId).toBe(BATCH)
    expect(stored?.pendingQuestionIds).toEqual(['q1'])
    expect(stored?.submission?.origin).toBe('runtime')
  })

  const refusedPhaseChanges: Array<[string, () => TaskState, TaskEvent, string]> = [
    ['active → active', activeState, ev('RunPhaseChanged', { phase: 'active', batchId: BATCH }, { runId: 'r1' }), 'illegal run phase transition "active" → "active"'],
    ['submitted → active', submittedState, ev('RunPhaseChanged', { phase: 'active', batchId: BATCH }, { runId: 'r1' }), 'illegal run phase transition "submitted" → "active"'],
    ['submitted → submitted', submittedState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'illegal run phase transition "submitted" → "submitted"'],
    ['submitted → waiting_children', submittedState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { runId: 'r1' }), 'illegal run phase transition "submitted" → "waiting_children"'],
    ['waiting_children → waiting_children', waitingChildrenState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { runId: 'r1' }), 'illegal run phase transition "waiting_children" → "waiting_children"'],
    ['a phase change without a run id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }), 'requires a run id'],
    ['a phase change on an unknown run', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { runId: 'ghost' }), 'unknown run'],
    ['a phase change naming another task\'s run', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH }, { taskId: 'other', runId: 'r1' }), 'belongs to task "t1", not "other"'],
    ['a phase change on a run with no phase', legacyRunningState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'has no execution phase'],
    ['a late phase change on a cancelled run', cancelledState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'is cancelled; a phase change requires a running run'],
    ['a late phase change on a failed run', failedState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission() }, { runId: 'r1' }), 'is failed; a phase change requires a running run'],
    ['an unknown target phase', activeState, ev('RunPhaseChanged', { phase: 'paused' as ExecutionPhase }, { runId: 'r1' }), 'execution phase must be one of active, waiting_children, submitted'],
    ['a waiting_children transition without a batch id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children' }, { runId: 'r1' }), 'entering waiting_children requires a batch id'],
    ['an empty batch id', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: '' }, { runId: 'r1' }), 'entering waiting_children requires a batch id'],
    ['a return to active without the batch it closes', waitingChildrenState, ev('RunPhaseChanged', { phase: 'active' }, { runId: 'r1' }), 'returning to active requires the batch id it closes'],
    ['a return to active carrying a submission', waitingChildrenState, ev('RunPhaseChanged', { phase: 'active', batchId: BATCH, submission: submission() }, { runId: 'r1' }), 'is entering active; only the submitted phase carries a submission'],
    ['a waiting_children transition carrying a submission', activeState, ev('RunPhaseChanged', { phase: 'waiting_children', batchId: BATCH, submission: submission() }, { runId: 'r1' }), 'only the submitted phase carries a submission'],
    ['a submitted transition without a submission', activeState, ev('RunPhaseChanged', { phase: 'submitted' }, { runId: 'r1' }), 'submitting requires a submission record'],
    ['a submitted transition carrying a batch id', activeState, ev('RunPhaseChanged', { phase: 'submitted', submission: submission(), batchId: BATCH }, { runId: 'r1' }), 'a batch id belongs to the batch edges, not the submitted phase'],
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
    ['an active run carrying a batch id', run({ executionPhase: 'active', batchId: BATCH }), 'a batch id is recorded by a phase change, not at start'],
    ['an active run carrying batches', run({
      executionPhase: 'active',
      batches: [{ batchId: BATCH, proposalId: 'p-one', memberTaskIds: ['c1'] }],
    }), 'a run\'s batches are recorded by the decompositions it admits, not at start'],
    ['a submitted run without a submission', run({ executionPhase: 'submitted' }), 'is born submitted; a submission record is required'],
    ['a submitted run carrying a batch id', run({ executionPhase: 'submitted', submission: submission(), batchId: BATCH }), 'a batch id is recorded by a phase change, not at start'],
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

/** The limits a test proposal is submitted under: both fingerprints are derived from these records, never faked. */
const ADMISSION_CONTEXT: AdmissionContext = { maxDepth: 4, maxChildren: 8, auditOnly: { maxToolCalls: 150 } }
const REVIEW_CONTEXT: TaskProposalReviewContext = { capabilityManifestDigest: sha256Hex('[]'), verifiers: [] }

/** The contract one test child carries: the projection the `task()` fixture already spells out. */
function contractOf(child: TaskInstance): TaskContract {
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    objective: child.objective,
    acceptanceCriteria: child.acceptanceCriteria,
    assumptions: [],
    constraints: [],
    requiredCapabilities: child.requestedCapabilities,
  }
}

/**
 * The proposal one batch of test children is admitted as, and the consumption
 * that admits it — identity, content and the three digests derived from the
 * children themselves, so the reducer's content↔identity check is exercised
 * rather than bypassed.
 */
function batchFixture(
  children: readonly TaskInstance[],
  options: { runId?: RunId; requestKey?: string } = {},
): { proposal: TaskProposalDecomposition; consumption: TaskProposalBatchConsumption } {
  const parentRunId = options.runId ?? 'r1'
  const batch = children.map(child => ({
    contract: contractOf(child),
    dependsOn: [] as number[],
    decomposable: false,
    requiresIndependentAcceptance: false,
  }))
  const identity: DecompositionIdentity = {
    contractVersion: TASK_CONTRACT_VERSION,
    storeId: STORE,
    parentTaskId: 'root',
    parentRunId,
    callerSessionId: 's-root',
    reason: 'split the work',
    children: batch.map(child => ({
      contractDigest: contractDigest(child.contract),
      dependsOn: child.dependsOn,
      decomposable: child.decomposable,
      requiresIndependentAcceptance: child.requiresIndependentAcceptance,
    })),
  }
  const proposal: TaskProposalDecomposition = {
    proposalId: taskProposalId(identity),
    requestKey: options.requestKey ?? 'k-batch',
    status: 'ready',
    policy: 'off',
    identity,
    batch,
    proposalDigest: decompositionDigest(identity),
    admissionContext: ADMISSION_CONTEXT,
    admissionContextDigest: admissionContextDigest(ADMISSION_CONTEXT),
    reviewContext: REVIEW_CONTEXT,
    reviewContextDigest: reviewContextDigest(REVIEW_CONTEXT),
    createdAt: NOW,
  }
  return {
    proposal,
    consumption: {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      parentRunId,
      batchId: batchIdFor(parentRunId, proposal.proposalId),
      childTaskIds: children.map(child => child.taskId),
      admittedAt: NOW,
    },
  }
}

describe('TaskService batch admission', () => {
  test('one commit admits the whole batch and closes the parent gate', async () => {
    const { h, service } = await rootWithRun()
    const manifests: CapabilityManifest[] = [
      { capabilities: { build: { skills: [], tools: ['write'] } }, missing: [], closure: 'closed' },
      { capabilities: {}, missing: ['verilog-sim'], closure: 'gap' },
    ]
    const children = [
      task({ taskId: 'c1', parentTaskId: 'root', depth: 1 }),
      task({ taskId: 'c2', parentTaskId: 'root', depth: 1 }),
    ]
    const { proposal, consumption } = batchFixture(children)
    await service.submitProposalIn(STORE, proposal, 'tester')
    const before = storedEvents(h).length
    await service.admitBatchIn(
      STORE,
      'root',
      'r1',
      children,
      'tester',
      [{ from: 'c1', to: 'c2' }],
      undefined,
      manifests,
      consumption,
    )
    expect(storedEvents(h).length - before).toBe(11)
    expect(h.changes).toHaveLength(5)

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
    expect(parentRun.batchId).toBe(batchIdFor('r1', proposal.proposalId))
    expect(parentRun.batchId).toBe(`b-r1-${proposal.proposalId}`)
    expect(parentRun.batches).toEqual([{
      batchId: batchIdFor('r1', proposal.proposalId),
      proposalId: proposal.proposalId,
      memberTaskIds: ['c1', 'c2'],
    }])
    expect(parentRun.submission).toBeUndefined()
    expect((await service.runMembersIn(STORE, 'r1')).map(child => child.taskId)).toEqual(['c1', 'c2'])
    for (const stored of storedEvents(h)) {
      expect(JSON.parse(JSON.stringify(stored))).toStrictEqual(stored)
    }
  })

  test('admitBatchIn requires the proposal consumption the batch is, and its parent run', async () => {
    const { h, service } = await rootWithRun()
    const children = [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })]
    const before = persistedKinds(h)
    await expect(service.admitBatchIn(STORE, 'root', 'r1', children, 'tester'))
      .rejects.toThrow('requires the proposal consumption the batch is')
    const { proposal, consumption } = batchFixture(children)
    await expect(service.admitBatchIn(STORE, 'root', 'r1', children, 'tester', [], undefined, undefined, consumption))
      .rejects.toThrow(`task: unknown proposal "${proposal.proposalId}"`)
    await service.submitProposalIn(STORE, proposal, 'tester')
    const afterSubmit = persistedKinds(h)
    await expect(service.admitBatchIn(
      STORE, 'root', 'r2', children, 'tester', [], undefined, undefined, consumption,
    )).rejects.toThrow('to name the parent run it is admitted on')
    expect(persistedKinds(h)).toEqual(afterSubmit)
    expect(before.length + 1).toBe(afterSubmit.length)
  })

  test('a batch whose phase change cannot apply persists nothing and the store stays writable', async () => {
    const h = harness()
    const service = new TaskService(h.ctx as never)
    await service.createStore(STORE)
    await service.createTaskIn(STORE, task({ taskId: 'root', decompositionStatus: 'decomposable' }), 'tester')
    await service.admitTaskIn(STORE, 'root', 'tester', { decompositionStatus: 'decomposable' })
    const children = [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })]
    const { proposal, consumption } = batchFixture(children)
    await service.submitProposalIn(STORE, proposal, 'tester')

    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', children, 'tester', [], undefined, undefined, consumption),
    ).rejects.toThrow('unknown run')
    expect(persistedKinds(h)).toEqual(['TaskCreated', 'TaskAdmitted', 'TaskProposalSubmitted'])
    const refused = await service.snapshotIn(STORE)
    expect(refused.tasks).toHaveLength(1)
    expect(refused.edges).toHaveLength(0)
    expect(refused.proposals?.byId[proposal.proposalId]?.status).toBe('ready')

    await service.startRunIn(STORE, run({ taskId: 'root', executionPhase: 'active' }), 'tester')
    await service.admitBatchIn(STORE, 'root', 'r1', children, 'tester', [], undefined, undefined, consumption)
    expect((await service.taskIn(STORE, 'root')).decompositionStatus).toBe('decomposed')
    expect((await service.runIn(STORE, 'r1')).batchId).toBe(consumption.batchId)
  })

  test('a batch on a run whose gate already closed is refused whole', async () => {
    const { h, service } = await rootWithRun()
    const children = [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })]
    const { proposal, consumption } = batchFixture(children)
    await service.submitProposalIn(STORE, proposal, 'tester')
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'submitted', submission: submission() })
    const before = persistedKinds(h)
    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', children, 'tester', [], undefined, undefined, consumption),
    ).rejects.toThrow('illegal run phase transition "submitted" → "waiting_children"')
    expect(persistedKinds(h)).toEqual(before)
    const snapshot = await service.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.edges).toHaveLength(0)
  })

  test('admitBatchIn refuses an empty batch, a foreign child and a misaligned manifest list before writing', async () => {
    const { h, service } = await rootWithRun()
    const children = [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })]
    const { consumption } = batchFixture(children)
    const before = persistedKinds(h)
    await expect(service.admitBatchIn(STORE, 'root', 'r1', [], 'tester', [], undefined, undefined, consumption))
      .rejects.toThrow('at least one child')
    await expect(
      service.admitBatchIn(
        STORE,
        'root',
        'r1',
        [task({ taskId: 'c1', parentTaskId: 'other', depth: 1 })],
        'tester',
        [],
        undefined,
        undefined,
        consumption,
      ),
    ).rejects.toThrow('parentTaskId')
    await expect(
      service.admitBatchIn(STORE, 'root', 'r1', children, 'tester', [], undefined, [], consumption),
    ).rejects.toThrow('one manifest per child')
    expect(persistedKinds(h)).toEqual(before)
  })

  test('a parent run accumulates its batches: members append, and each run keeps its own', async () => {
    const { service } = await rootWithRun()
    const first = [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })]
    const firstBatch = batchFixture(first)
    await service.submitProposalIn(STORE, firstBatch.proposal, 'tester')
    await service.admitBatchIn(STORE, 'root', 'r1', first, 'tester', [], undefined, undefined, firstBatch.consumption)
    expect((await service.runIn(STORE, 'r1')).executionPhase).toBe('waiting_children')

    // The batch ends: the parent takes execution back, then opens a second one.
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'active', batchId: firstBatch.consumption.batchId })
    const closed = await service.runIn(STORE, 'r1')
    expect(closed.executionPhase).toBe('active')
    expect(closed.batchId).toBeUndefined()
    expect(closed.batches?.map(batch => batch.memberTaskIds)).toEqual([['c1']])

    const second = [task({ taskId: 'c2', parentTaskId: 'root', depth: 1, objective: 'build the second thing' })]
    const secondBatch = batchFixture(second, { requestKey: 'k-second' })
    await service.submitProposalIn(STORE, secondBatch.proposal, 'tester')
    await service.admitBatchIn(STORE, 'root', 'r1', second, 'tester', [], undefined, undefined, secondBatch.consumption)
    const accumulated = await service.runIn(STORE, 'r1')
    expect(accumulated.batches?.map(batch => batch.proposalId)).toEqual([firstBatch.proposal.proposalId, secondBatch.proposal.proposalId])
    expect((await service.runMembersIn(STORE, 'r1')).map(child => child.taskId)).toEqual(['c1', 'c2'])

    // A second run of the same task holds only what *it* admitted: the members
    // of the first batch stay the first run's history.
    await service.markRunStatusIn(STORE, 'root', 'r1', 'failed', 'tester', { reason: 'verification failed' })
    await service.startRunIn(STORE, run({ runId: 'r2', taskId: 'root', executionPhase: 'active' }), 'tester')
    expect(await service.runMembersIn(STORE, 'r2')).toEqual([])
    const third = [task({ taskId: 'c3', parentTaskId: 'root', depth: 1 })]
    const thirdBatch = batchFixture(third, { runId: 'r2', requestKey: 'k-third' })
    await service.submitProposalIn(STORE, thirdBatch.proposal, 'tester')
    await service.admitBatchIn(STORE, 'root', 'r2', third, 'tester', [], undefined, undefined, thirdBatch.consumption)
    expect((await service.runMembersIn(STORE, 'r2')).map(child => child.taskId)).toEqual(['c3'])
    expect((await service.runMembersIn(STORE, 'r1')).map(child => child.taskId)).toEqual(['c1', 'c2'])
    expect((await service.taskIn(STORE, 'root')).childTaskIds).toEqual(['c1', 'c2', 'c3'])
  })

  test('decomposeIn still admits a batch without touching the parent run phase', async () => {
    const { service } = await rootWithRun()
    await service.decomposeIn(STORE, 'root', [task({ taskId: 'c1', parentTaskId: 'root', depth: 1 })], 'tester')
    const parentRun = await service.runIn(STORE, 'r1')
    expect(parentRun.executionPhase).toBe('active')
    expect(parentRun.batchId).toBeUndefined()
    // Nothing names the run this decomposition belongs to, so no run
    // accumulation is invented for it (the legacy shape, kept readable).
    expect(parentRun.batches).toBeUndefined()
    expect(await service.runMembersIn(STORE, 'r1')).toEqual([])
  })
})

describe('TaskService coordination entries', () => {
  test('changeRunPhaseIn opens a batch, refuses a nameless return, and closes it with its batch id', async () => {
    const { h, service } = await rootWithRun()
    const opened = batchIdFor('r1', 'p-one')
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'waiting_children', batchId: opened })
    expect((await service.runIn(STORE, 'r1')).batchId).toBe(opened)

    // A return to `active` names the batch it closes: the edge is not a
    // rollback, and without the id the phase change says nothing about which
    // batch ended.
    const before = persistedKinds(h)
    await expect(service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'active' }))
      .rejects.toThrow('returning to active requires the batch id it closes')
    await expect(service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'active', batchId: '' }))
      .rejects.toThrow('returning to active requires the batch id it closes')
    expect(persistedKinds(h)).toEqual(before)

    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'active', batchId: opened })
    const returned = await service.runIn(STORE, 'r1')
    expect(returned.executionPhase).toBe('active')
    expect(returned.batchId).toBeUndefined()

    // The parent may wait on a second batch, and that one submits as ever.
    const second = batchIdFor('r1', 'p-two')
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', { phase: 'waiting_children', batchId: second })
    await service.changeRunPhaseIn(STORE, 'root', 'r1', 'tester', {
      phase: 'submitted',
      submission: submission({ origin: 'runtime', summary: 'children settled' }),
    })
    const stored = await service.runIn(STORE, 'r1')
    expect(stored.executionPhase).toBe('submitted')
    expect(stored.batchId).toBe(second)
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
