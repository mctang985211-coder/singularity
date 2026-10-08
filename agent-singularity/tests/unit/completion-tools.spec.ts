/**
 * The completion payload checks and the platform-derived fields: what a model
 * may state about its own round, what it may never state, and what the platform
 * derives from the round's own method records.
 */
import { describe, expect, test } from 'vitest'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import {
  validateReviewCompletion,
  validateSupervisorCompletion,
  type SupervisorCompletionPayload,
} from '../../src/coordination/completion.ts'
import { methodDecisionOf, searchNextOf, type RoundMethodRecord } from '../../src/coordination/method-read.ts'
import type { CoordinationBinding } from '../../src/coordination/store.ts'

const binding: CoordinationBinding = {
  graphId: 'g1',
  rootStoreId: 'sg-t-root',
  epoch: 1,
  role: 'supervisor',
  subject: { kind: 'round', businessRound: 1, searchRound: 1, source: { taskId: 't-root', runId: 'r-1' } },
  sourceTaskId: 't-root',
  sourceRunId: 'r-1',
  sessionId: 's-1',
  actor: 's-root',
  at: '2026-10-08T00:00:00.000Z',
  completed: false,
}

/** The smallest store that can resolve the refs a completion cites. */
function snapshot(): TaskSnapshot {
  return {
    tasks: [
      {
        taskId: 't-root',
        acceptanceCriteria: [{ criterionId: 'goal', description: 'the answer holds', command: 'true', verifierRef: 'command' }],
      },
    ],
    runs: [{ runId: 'r-1', taskId: 't-root', status: 'verified', startedAt: '2026-10-08T00:00:00.000Z' }],
    reviews: [
      {
        taskId: 't-root',
        runId: 'r-1',
        outcome: 'verified',
        evidenceRefs: ['ev-1'],
        localizedCause: 'the answer holds',
        sessionId: 's-run',
        criteria: [],
      },
    ],
    diagnoses: [],
    evidence: [{ evidenceId: 'ev-1' }],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot
}

const payload = (overrides: Partial<SupervisorCompletionPayload> = {}): SupervisorCompletionPayload => ({
  businessAction: 'continue',
  reason: 'the method can be improved',
  evidenceRefs: ['t-root#r-1'],
  ...overrides,
})

describe('a supervisor completion', () => {
  test('accepts a reason and evidence the store can resolve', () => {
    expect(validateSupervisorCompletion({ binding, snapshot: snapshot(), outcome: 'verified', payload: payload() })).toMatchObject({
      ok: true,
    })
  })

  test('refuses an empty reason, no evidence, and an unrecorded reference', () => {
    const store = snapshot()
    expect(validateSupervisorCompletion({ binding, snapshot: store, outcome: 'verified', payload: payload({ reason: ' ' }) })).toMatchObject({
      ok: false,
    })
    expect(validateSupervisorCompletion({ binding, snapshot: store, outcome: 'verified', payload: payload({ evidenceRefs: [] }) })).toMatchObject({
      ok: false,
    })
    const unknown = validateSupervisorCompletion({
      binding,
      snapshot: store,
      outcome: 'verified',
      payload: payload({ evidenceRefs: ['t-root#r-9'] }),
    })
    expect(unknown).toMatchObject({ ok: false })
    expect((unknown as { refusal: string }).refusal).toContain('does not hold')
  })

  test('a criterion id and an evidence bundle id resolve as well as a review ref', () => {
    const store = snapshot()
    for (const ref of ['goal', 'ev-1', 't-root#r-1'])
      expect(validateSupervisorCompletion({ binding, snapshot: store, outcome: 'verified', payload: payload({ evidenceRefs: [ref] }) })).toMatchObject({ ok: true })
  })

  test('refuses a business action outside the three the protocol declares', () => {
    expect(
      validateSupervisorCompletion({
        binding,
        snapshot: snapshot(),
        outcome: 'verified',
        payload: payload({ businessAction: 'promote' as never }),
      }),
    ).toMatchObject({ ok: false })
  })

  test('refuses an empty trial candidate reference rather than reading it as none', () => {
    expect(
      validateSupervisorCompletion({ binding, snapshot: snapshot(), outcome: 'verified', payload: payload({ trialCandidateRef: '' }) }),
    ).toMatchObject({ ok: false })
  })
})

describe('a reviewer completion', () => {
  const reviewBinding: CoordinationBinding = {
    ...binding,
    role: 'reviewer',
    subject: { kind: 'review', businessRound: 1, source: { taskId: 't-root', runId: 'r-1' }, requestKey: null },
  }

  test('builds the diagnosis the store will hold, with the review it read', () => {
    const result = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: { observation: 'the run verified', conclusion: 'nothing further is needed', confidence: 'medium' },
    })
    expect(result).toMatchObject({ ok: true })
    const diagnosis = (result as { payload: { diagnosis: { diagnosisId: string; reviewRefs: string[]; evidenceRefs: string[] } } }).payload.diagnosis
    expect(diagnosis.diagnosisId).toBe('review-agent-s-1')
    expect(diagnosis.reviewRefs).toEqual(['t-root#r-1'])
    expect(diagnosis.evidenceRefs).toEqual(['ev-1'])
  })

  test('refuses a conclusion that cites evidence this store does not hold', () => {
    const result = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: {
        observation: 'the run verified',
        conclusion: 'nothing further is needed',
        confidence: 'medium',
        evidenceRefs: ['ev-missing'],
      },
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { refusal: string }).refusal).toContain('outside store')
  })

  test('refuses a judgement that cites nothing, and one whose dimension is not judged', () => {
    const base = { observation: 'observed', conclusion: 'cause', confidence: 'low' as const }
    const empty = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: { ...base, judgements: [{ dimension: 'acceptance', verdict: 'adequate', evidenceRefs: [], rationale: 'because' }] },
    })
    expect(empty).toMatchObject({ ok: false })
    const unknownDimension = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: { ...base, judgements: [{ dimension: 'vibes', verdict: 'adequate', evidenceRefs: ['t-root#r-1'], rationale: 'because' }] },
    })
    expect(unknownDimension).toMatchObject({ ok: false })
    const unresolved = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: { ...base, judgements: [{ dimension: 'acceptance', verdict: 'adequate', evidenceRefs: ['nope'], rationale: 'because' }] },
    })
    expect(unresolved).toMatchObject({ ok: false })
  })

  test('refuses a proposal missing one of its three fields', () => {
    const result = validateReviewCompletion({
      binding: reviewBinding,
      snapshot: snapshot(),
      payload: {
        observation: 'observed',
        conclusion: 'cause',
        confidence: 'low',
        proposals: [{ targetType: 'skill', targetId: 'future-method', rationale: '' }],
      },
    })
    expect(result).toMatchObject({ ok: false })
  })

  test('refuses a supervisor binding: a round is supervised, never reviewed', () => {
    expect(
      validateReviewCompletion({
        binding,
        snapshot: snapshot(),
        payload: { observation: 'observed', conclusion: 'cause', confidence: 'low' },
      }),
    ).toMatchObject({ ok: false })
  })
})

describe('the derived method decision', () => {
  const record = (overrides: Partial<RoundMethodRecord>): RoundMethodRecord => ({
    action: 'publish',
    revisionId: 'rev-1',
    approvalRef: 'approval:1',
    decidedBy: 'human',
    reason: 'better',
    ...overrides,
  })

  test('a publish is a promotion, a rollback wins over it, and a discard is a discard', () => {
    expect(methodDecisionOf([record({})], undefined)).toEqual({
      methodDecision: 'promote',
      approval: { source: 'human', ref: 'approval:1' },
    })
    expect(methodDecisionOf([record({}), record({ action: 'rollback', decidedBy: 'platform_policy' })], undefined)).toMatchObject({
      methodDecision: 'rollback',
      approval: { source: 'platform_policy' },
    })
    expect(methodDecisionOf([record({ action: 'discard', approvalRef: null })], undefined)).toEqual({ methodDecision: 'discard' })
  })

  test('no record is a retention; a trial candidate is what the round asked to try', () => {
    expect(methodDecisionOf([], undefined)).toEqual({ methodDecision: 'retain' })
    expect(methodDecisionOf([], 'd0007')).toMatchObject({ methodDecision: 'trial' })
  })

  test('the search step stops on steering or on the last round, and never changes the business action', () => {
    expect(searchNextOf({ businessRound: 1, rounds: 3 })).toBe('explore')
    expect(searchNextOf({ businessRound: 3, rounds: 3 })).toBe('stop')
    expect(searchNextOf({ businessRound: 1, rounds: 3, steering: 'stop-search' })).toBe('stop')
  })
})
