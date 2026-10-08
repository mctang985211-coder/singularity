/**
 * One work item's application: the five branches a key can be in — assign,
 * reuse, in flight, resume, refused — decided from rows, DSH's session facts and
 * the store's allowance, and nothing else.
 */
import { describe, expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assignmentOf,
  keyLabel,
  planAssignment,
  sameCoordinationKey,
  subjectDigest,
  type AssignmentRequest,
} from '../../src/coordination/assignment.ts'
import type { CoordinationSessionFacts } from '../../src/coordination/session-facts.ts'
import { MAX_ASSIGNMENT_ATTEMPTS, type CoordinationCompletion, type CoordinationKey, type CoordinationRow } from '../../src/coordination/store.ts'

const key: CoordinationKey = {
  graphId: 'g1',
  epoch: 1,
  role: 'supervisor',
  subject: { kind: 'round', businessRound: 1, searchRound: 1, source: { taskId: 't-root', runId: 'r-1' } },
}

const request: AssignmentRequest = {
  key,
  storeId: 'sg-t-root',
  sessionId: SessionId('s-new'),
  actor: 's-root',
  digest: subjectDigest(key),
  focus: null,
}

function sessions(...facts: CoordinationSessionFacts[]): Map<string, CoordinationSessionFacts> {
  return new Map(facts.map(item => [item.sessionId, item]))
}

function live(sessionId: string, status: 'idle' | 'running'): CoordinationSessionFacts {
  return { sessionId, presence: 'live', status, hasTurn: true, turnClosed: status === 'idle', completionCall: false }
}

function stored(sessionId: string, turnClosed: boolean): CoordinationSessionFacts {
  return { sessionId, presence: 'stored', hasTurn: true, turnClosed, completionCall: false }
}

function missing(sessionId: string): CoordinationSessionFacts {
  return { sessionId, presence: 'missing', hasTurn: false, turnClosed: true, completionCall: false }
}

function completion(sessionId: string, result: CoordinationCompletion['result']): CoordinationCompletion {
  return {
    formatVersion: 1,
    kind: 'completion',
    graphId: 'g1',
    storeId: 'sg-t-root',
    epoch: 1,
    role: 'supervisor',
    sessionId,
    result,
    at: '2026-10-08T00:01:00.000Z',
  }
}

const interrupted = (sessionId: string): CoordinationCompletion =>
  completion(sessionId, { kind: 'interrupted', detail: 'the spawn failed' })
const finished = (sessionId: string): CoordinationCompletion =>
  completion(sessionId, {
    kind: 'completed',
    businessAction: 'finish',
    reason: 'done',
    evidenceRefs: ['t-root#r-1'],
    trialCandidateRef: null,
    methodDecision: 'retain',
    searchNext: 'stop',
  })

const budget = { used: 0, max: 8 }

describe('a key with no assignment', () => {
  test('is assigned while the store has allowance left', () => {
    expect(planAssignment({ request, rows: [], sessions: sessions(), budget })).toEqual({ kind: 'assign' })
  })

  test('is refused by name once the allowance is spent, with the numbers', () => {
    const plan = planAssignment({ request, rows: [], sessions: sessions(), budget: { used: 8, max: 8 } })
    expect(plan).toMatchObject({ kind: 'refused', code: 'budget-exhausted' })
    expect((plan as { detail: string }).detail).toContain('8/8')
  })
})

describe('a key that already has an assignment', () => {
  test('the same key with another subject digest is a conflict', () => {
    const rows: CoordinationRow[] = [assignmentOf({ ...request, key: { ...key } }, '2026-10-08T00:00:00.000Z')]
    const plan = planAssignment({
      request: { ...request, digest: 'other-digest' },
      rows,
      sessions: sessions(live('s-new', 'running')),
      budget,
    })
    expect(plan).toMatchObject({ kind: 'refused', code: 'subject-conflict' })
  })

  test('a settled completion is returned rather than run again', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId('s-old') }, '2026-10-08T00:00:00.000Z'),
      finished('s-old'),
    ]
    const plan = planAssignment({ request, rows, sessions: sessions(), budget: { used: 8, max: 8 } })
    expect(plan).toMatchObject({ kind: 'reuse', work: { assignment: { sessionId: 's-old' } } })
  })

  test('an interrupted attempt is retried, and stops after MAX_ASSIGNMENT_ATTEMPTS', () => {
    const one = (sessionId: string): CoordinationRow[] => [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId(sessionId) }, '2026-10-08T00:00:00.000Z'),
      interrupted(sessionId),
    ]
    expect(planAssignment({ request, rows: one('s-old'), sessions: sessions(missing('s-old')), budget })).toEqual({
      kind: 'assign',
    })
    const many: CoordinationRow[] = []
    for (let attempt = 0; attempt < MAX_ASSIGNMENT_ATTEMPTS; attempt += 1)
      many.push(...one(`s-${attempt}`).map(row => ({ ...row, at: `2026-10-08T00:0${attempt}:00.000Z` }) as CoordinationRow))
    const plan = planAssignment({ request, rows: many, sessions: sessions(), budget })
    expect(plan).toMatchObject({ kind: 'refused', code: 'attempts-exhausted' })
    expect((plan as { detail: string }).detail).toContain('never reached model input 3 times')
  })

  test('an assignment whose session never materialized is re-materialized under the same id', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId('s-old') }, '2026-10-08T00:00:00.000Z'),
    ]
    expect(planAssignment({ request, rows, sessions: sessions(missing('s-old')), budget })).toEqual({
      kind: 'assign',
      reuseSessionId: 's-old',
    })
  })

  test('a stored session whose turn never finished is resumed under the same id', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId('s-old') }, '2026-10-08T00:00:00.000Z'),
    ]
    expect(planAssignment({ request, rows, sessions: sessions(stored('s-old', false)), budget })).toMatchObject({
      kind: 'resume',
      work: { assignment: { sessionId: 's-old' } },
    })
  })

  test('a session that ended its turn is not handed a second assignment', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId('s-old') }, '2026-10-08T00:00:00.000Z'),
    ]
    expect(planAssignment({ request, rows, sessions: sessions(stored('s-old', true)), budget })).toMatchObject({
      kind: 'in-flight',
    })
    expect(planAssignment({ request, rows, sessions: sessions(live('s-old', 'idle')), budget })).toMatchObject({
      kind: 'in-flight',
    })
  })

  test('a live, running session is in flight', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, sessionId: SessionId('s-old') }, '2026-10-08T00:00:00.000Z'),
    ]
    expect(planAssignment({ request, rows, sessions: sessions(live('s-old', 'running')), budget })).toMatchObject({
      kind: 'in-flight',
    })
  })

  test('a key claimed for another store is refused as a role mismatch', () => {
    const rows: CoordinationRow[] = [
      assignmentOf({ ...request, key: { ...key }, storeId: 'sg-t-other' }, '2026-10-08T00:00:00.000Z'),
    ]
    expect(planAssignment({ request, rows, sessions: sessions(), budget })).toMatchObject({
      kind: 'refused',
      code: 'role-mismatch',
    })
  })
})

describe('the key itself', () => {
  test('is stable across derivations of the same round', () => {
    expect(subjectDigest(key)).toBe(subjectDigest({ ...key, subject: { ...key.subject } }))
    expect(sameCoordinationKey(key, { ...key })).toBe(true)
  })

  test('changes with the epoch, the role or the round', () => {
    expect(sameCoordinationKey(key, { ...key, epoch: 2 })).toBe(false)
    expect(sameCoordinationKey(key, { ...key, role: 'reviewer' })).toBe(false)
    expect(
      sameCoordinationKey(key, {
        ...key,
        subject: { ...key.subject, businessRound: 2, searchRound: 2 } as CoordinationKey['subject'],
      }),
    ).toBe(false)
    expect(subjectDigest({ ...key, epoch: 2 })).not.toBe(subjectDigest(key))
  })

  test('reads as a sentence a log or a refusal can carry', () => {
    expect(keyLabel(key)).toContain('supervisor of graph g1')
    expect(keyLabel(key)).toContain('round 1')
  })
})
