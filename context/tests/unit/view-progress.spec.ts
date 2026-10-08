/**
 * The one derivation of a graph's progress: every branch off the recorded
 * assignments and the configured round count, and nothing else.
 */

import { describe, expect, test } from 'vitest'
import { PROGRESS_NOTE_LIMIT, deriveProgress } from '../../src/index.ts'
import type { CoordinationAssignmentFacts, CoordinationCompletionFacts } from '../../src/index.ts'

/** One recorded assignment. */
function assignment(over: Partial<CoordinationAssignmentFacts> = {}): CoordinationAssignmentFacts {
  return {
    assignmentId: 'a-1',
    role: 'supervisor',
    round: 1,
    sessionId: 's-supervisor',
    sourceTaskId: 't-root',
    sourceRunId: 'r-root',
    state: 'open',
    ...over,
  }
}

/** One structured completion. */
function completion(over: Partial<CoordinationCompletionFacts> = {}): CoordinationCompletionFacts {
  return {
    businessAction: 'continue',
    searchNext: 'explore',
    methodDecision: 'retain',
    reason: 'the round produced no reusable change',
    evidenceRefs: [],
    at: '2026-10-08T00:00:00.000Z',
    ...over,
  }
}

describe('a graph with no assignment at all', () => {
  test('is idle, and carries the configured round count', () => {
    expect(deriveProgress(3, [])).toEqual({ round: 0, rounds: 3, phase: 'idle' })
  })

  test('is idle with zero rounds when the graph runs no improvement loop', () => {
    expect(deriveProgress(undefined, [])).toEqual({ round: 0, rounds: 0, phase: 'idle' })
  })
})

describe('a round in flight', () => {
  test('is running, on the round its own assignment names', () => {
    expect(deriveProgress(3, [assignment({ round: 2 })])).toEqual({ round: 2, rounds: 3, phase: 'running' })
  })

  test('is running with the completion reason as its note', () => {
    expect(deriveProgress(3, [assignment({ completion: completion({ reason: '  the candidate was screened  ' }) })])).toMatchObject(
      { phase: 'running', note: 'the candidate was screened' },
    )
  })

  test('awaits approval once its completion promotes a candidate with no approval recorded', () => {
    const promoting = completion({ methodDecision: 'promote', businessAction: 'finish' })
    expect(deriveProgress(3, [assignment({ completion: promoting })])).toMatchObject({
      round: 1,
      rounds: 3,
      phase: 'awaiting_approval',
    })
  })

  test('keeps running when the promotion it recorded was already approved', () => {
    const approved = completion({ methodDecision: 'promote', approval: { kind: 'platform_policy', policy: 'humanReview:false' } })
    expect(deriveProgress(3, [assignment({ completion: approved })])).toMatchObject({ phase: 'running' })
  })

  test('takes the highest open round, and ignores the rounds already interrupted', () => {
    const assignments = [
      assignment({ assignmentId: 'a-1', round: 1, state: 'settled', completion: completion() }),
      assignment({ assignmentId: 'a-2', round: 2, state: 'interrupted' }),
      assignment({ assignmentId: 'a-3', round: 3 }),
    ]
    expect(deriveProgress(4, assignments)).toMatchObject({ round: 3, rounds: 4, phase: 'running' })
  })
})

describe('no round in flight', () => {
  test('is idle while the search has settled rounds left to run', () => {
    const assignments = [assignment({ round: 1, state: 'settled', completion: completion() })]
    expect(deriveProgress(3, assignments)).toMatchObject({ round: 1, rounds: 3, phase: 'idle' })
  })

  test('is idle, never finished, when the graph runs no improvement loop', () => {
    const assignments = [assignment({ round: 1, state: 'settled', completion: completion() })]
    expect(deriveProgress(undefined, assignments)).toMatchObject({ round: 1, rounds: 0, phase: 'idle' })
  })

  test('is finished once the settled rounds reach the configured count', () => {
    const assignments = [
      assignment({ assignmentId: 'a-1', round: 1, state: 'settled', completion: completion() }),
      assignment({
        assignmentId: 'a-2',
        round: 2,
        state: 'settled',
        completion: completion({ at: '2026-10-08T01:00:00.000Z' }),
      }),
    ]
    expect(deriveProgress(2, assignments)).toMatchObject({ round: 2, rounds: 2, phase: 'finished' })
  })

  test('is stopped when the latest completion ended the search, whatever the round count', () => {
    const assignments = [
      assignment({
        round: 1,
        state: 'settled',
        completion: completion({ businessAction: 'finish', searchNext: 'stop', reason: 'no useful action is left' }),
      }),
    ]
    expect(deriveProgress(5, assignments)).toMatchObject({
      round: 1,
      rounds: 5,
      phase: 'stopped',
      note: 'no useful action is left',
    })
  })

  test('reads the latest completion by its own time, not by the order the rows arrive in', () => {
    const assignments = [
      assignment({
        assignmentId: 'a-2',
        round: 2,
        state: 'settled',
        completion: completion({ at: '2026-10-08T01:00:00.000Z', searchNext: 'stop', reason: 'the later answer' }),
      }),
      assignment({
        assignmentId: 'a-1',
        round: 1,
        state: 'settled',
        completion: completion({ at: '2026-10-08T00:00:00.000Z', reason: 'the earlier answer' }),
      }),
    ]
    expect(deriveProgress(5, assignments)).toMatchObject({ phase: 'stopped', note: 'the later answer' })
  })

  test('is idle with no note when nothing ever completed', () => {
    expect(deriveProgress(3, [assignment({ state: 'interrupted' })])).toEqual({ round: 0, rounds: 3, phase: 'idle' })
  })
})

describe('the note', () => {
  test('is the completion reason, cut to the note limit with an ellipsis', () => {
    const reason = 'x'.repeat(PROGRESS_NOTE_LIMIT * 2)
    const progress = deriveProgress(1, [assignment({ completion: completion({ reason }) })])
    expect(progress.note).toHaveLength(PROGRESS_NOTE_LIMIT)
    expect(progress.note?.endsWith('…')).toBe(true)
    expect(progress.note?.slice(0, -1)).toBe(reason.slice(0, PROGRESS_NOTE_LIMIT - 1))
  })

  test('is absent for an empty reason', () => {
    const progress = deriveProgress(1, [assignment({ completion: completion({ reason: '   ' }) })])
    expect(progress).not.toHaveProperty('note')
  })
})
