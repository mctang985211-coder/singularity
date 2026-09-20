import { describe, expect, test } from 'vitest'
import type {
  Diagnosis,
  JudgedDimension,
  ReviewJudgement,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskId,
} from '../../src/types.ts'
import { JUDGED_DIMENSIONS } from '../../src/types.ts'
import { TaskState } from '../../src/service/state.ts'

const NOW = '2026-09-18T00:00:00.000Z'

function ev<K extends TaskEventKind>(
  kind: K,
  payload: TaskEventPayloads[K],
  init: { taskId?: TaskId } = {},
): TaskEvent {
  return {
    kind,
    taskId: init.taskId ?? 't1',
    timestamp: NOW,
    actor: 'test',
    payload,
    schemaVersion: 1,
  } as unknown as TaskEvent
}

/** A store holding one existing task, which is all a diagnosis needs. */
function createdState(): TaskState {
  const state = new TaskState('sg-t-root')
  state.apply(ev('TaskCreated', {
    task: {
      taskId: 't1',
      definitionRef: { taskType: 'build', version: 1 },
      objective: 'Build the feature',
      depth: 0,
      acceptanceCriteria: [],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    },
  }))
  return state
}

function judgement(overrides: Partial<ReviewJudgement> = {}): ReviewJudgement {
  return {
    dimension: 'skill_fit',
    verdict: 'inadequate',
    evidenceRefs: ['t1#r1'],
    rationale: 'the task never loaded the skill it was granted',
    ...overrides,
  }
}

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    diagnosisId: 'd1',
    taskId: 't1',
    observedFailure: 'criterion c1 failed',
    scope: 'task t1',
    localizedCause: 'agent review of t1: inadequate [skill_fit]',
    evidenceRefs: ['e1'],
    reviewRefs: ['t1#r1'],
    confidence: 'medium',
    proposals: [],
    ...overrides,
  }
}

describe('TaskState diagnosis judgements', () => {
  test('a diagnosis round-trips producer and judgements', () => {
    const state = createdState()
    const judgements = JUDGED_DIMENSIONS.map(dimension => judgement({ dimension }))
    const record = diagnosis({ producedBy: { kind: 'agent', sessionId: 's-rev-1' }, judgements })
    state.apply(ev('DiagnosisRecorded', { diagnosis: record }))
    expect(state.snapshot().diagnoses[0]?.producedBy).toEqual({ kind: 'agent', sessionId: 's-rev-1' })
    expect(state.snapshot().diagnoses[0]?.judgements).toEqual(judgements)
  })

  test('a diagnosis without the new fields still validates (old-record shape)', () => {
    const state = createdState()
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis() }))
    expect(state.snapshot().diagnoses[0]?.producedBy).toBeUndefined()
    expect(state.snapshot().diagnoses[0]?.judgements).toBeUndefined()
  })

  test('a judgement with empty evidence refs is rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ evidenceRefs: [] })] }),
    }))).toThrow('must rest on at least one non-empty evidence ref')
    // A present-but-empty-string ref is the same defect.
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ evidenceRefs: [''] })] }),
    }))).toThrow('must rest on at least one non-empty evidence ref')
  })

  test('an unknown dimension is rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ dimension: 'outcome_correctness' as JudgedDimension })] }),
    }))).toThrow('judgement dimension must be one of')
  })

  test('an unknown verdict is rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ verdict: 'scored-9' as ReviewJudgement['verdict'] })] }),
    }))).toThrow('judgement verdict must be one of')
  })

  test('a judgement without a rationale is rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ rationale: '' })] }),
    }))).toThrow('requires a rationale')
  })

  test('an unknown producer kind is rejected; a session-less human is accepted', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ producedBy: { kind: 'robot' as 'human' } }),
    }))).toThrow('producedBy.kind must be "agent" or "human"')
    state.apply(ev('DiagnosisRecorded', { diagnosis: diagnosis({ producedBy: { kind: 'human' } }) }))
    expect(state.snapshot().diagnoses[0]?.producedBy).toEqual({ kind: 'human' })
  })

  test('a present-but-empty session id is rejected', () => {
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ producedBy: { kind: 'agent', sessionId: '' } }),
    }))).toThrow('producedBy.sessionId must be a non-empty string')
  })

  test('an unknown verdict never sneaks in through a judgement without refs', () => {
    // The whole point: evidence that settles nothing must read as unknown, and
    // the reducer still refuses a judgement that cites nothing at all.
    const state = createdState()
    expect(() => state.apply(ev('DiagnosisRecorded', {
      diagnosis: diagnosis({ judgements: [judgement({ verdict: 'unknown', evidenceRefs: [] })] }),
    }))).toThrow('must rest on at least one non-empty evidence ref')
  })
})
