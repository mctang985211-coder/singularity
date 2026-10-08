/**
 * The reduction of one pass: what the platform does about the round that just
 * settled. Every branch is a fact a spec can construct — a settled round, four
 * completion shapes, four session readings — because the reducer takes facts and
 * returns a decision, and nothing else.
 */
import { describe, expect, test } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { keyLabel, subjectDigest, type AssignmentRequest } from '../../src/coordination/assignment.ts'
import { nextRoundMode, reduce, roundKeyOf, type ReductionFacts } from '../../src/coordination/reducer.ts'
import type { CoordinationSessionFacts } from '../../src/coordination/session-facts.ts'
import {
  MAX_ASSIGNMENT_ATTEMPTS,
  type CoordinationCompletion,
  type CoordinationRow,
  type CompletionResult,
} from '../../src/coordination/store.ts'
import { assignmentOf } from '../../src/coordination/assignment.ts'

const root = { taskId: 't-root', parentTaskId: undefined }
const run = (index: number, status: string, recovery?: unknown) => ({
  runId: `r-${index}`,
  taskId: 't-root',
  status,
  startedAt: `2026-10-08T00:0${index}:00.000Z`,
  ...(recovery === undefined ? {} : { recovery }),
})

function snapshot(runs: readonly unknown[], diagnoses: readonly unknown[] = []): TaskSnapshot {
  return {
    tasks: [root as never],
    runs: runs as never,
    reviews: [],
    diagnoses: diagnoses as never,
    evidence: [],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot
}

function live(sessionId: string, status: 'idle' | 'running'): CoordinationSessionFacts {
  return { sessionId, presence: 'live', status, hasTurn: true, turnClosed: status === 'idle', completionCall: false }
}

function stopped(sessionId: string): CoordinationSessionFacts {
  return { sessionId, presence: 'stored', hasTurn: true, turnClosed: true, completionCall: false }
}

function completion(sessionId: string, result: CompletionResult): CoordinationCompletion {
  return {
    formatVersion: 1,
    kind: 'completion',
    graphId: 'g1',
    storeId: 'sg-t-root',
    epoch: 1,
    role: 'supervisor',
    sessionId,
    result,
    at: '2026-10-08T00:05:00.000Z',
  }
}

const settled = (sessionId: string, businessAction: 'continue' | 'recover' | 'finish'): CoordinationCompletion =>
  completion(sessionId, {
    kind: 'completed',
    businessAction,
    reason: 'the recorded reason',
    evidenceRefs: ['t-root#r-1'],
    trialCandidateRef: null,
    methodDecision: 'retain',
    searchNext: 'explore',
  })

function facts(input: {
  readonly runs: readonly unknown[]
  readonly rows?: readonly CoordinationRow[]
  readonly sessions?: CoordinationSessionFacts[]
  readonly epoch?: number
  readonly iterationRounds?: number
  readonly rootLive?: boolean
  readonly diagnoses?: readonly unknown[]
  readonly budget?: { used: number; max: number }
}): ReductionFacts {
  const epoch = input.epoch ?? 1
  const run = input.runs.at(-1) as { runId: string } | undefined
  const key = roundKeyOf({
    graphId: 'g1',
    epoch,
    businessRound: input.runs.length,
    taskId: 't-root',
    runId: run?.runId ?? 'r-1',
  })
  const candidate: AssignmentRequest = {
    key,
    storeId: 'sg-t-root',
    sessionId: SessionId('s-new'),
    actor: 's-root',
    digest: subjectDigest(key),
    focus: null,
  }
  return {
    graph: {
      id: 'g1',
      name: 'graph one',
      storeId: 'sg-t-root',
      rootSessionId: 's-root',
      config: { task: 'improve the method', iterationRounds: input.iterationRounds ?? 2, humanReview: false, epoch },
    },
    snapshot: snapshot(input.runs, input.diagnoses),
    rows: input.rows ?? [],
    sessions: new Map((input.sessions ?? []).map(item => [item.sessionId, item])),
    budget: input.budget ?? { used: 0, max: 8 },
    rootLive: input.rootLive ?? true,
    candidate,
  }
}

/** One round's rows: the assignment plus a completion, for the round the last settled run names. */
function roundRows(input: {
  readonly businessRound: number
  readonly runId: string
  readonly sessionId: string
  readonly result: CompletionResult
}): CoordinationRow[] {
  const key = roundKeyOf({
    graphId: 'g1',
    epoch: 1,
    businessRound: input.businessRound,
    taskId: 't-root',
    runId: input.runId,
  })
  const assignment = assignmentOf(
    { key, storeId: 'sg-t-root', sessionId: SessionId(input.sessionId), actor: 's-root', digest: subjectDigest(key), focus: null },
    '2026-10-08T00:04:00.000Z',
  )
  return [assignment, completion(input.sessionId, input.result)]
}

describe('nothing to do yet', () => {
  test('a store with no settled round is idle', () => {
    expect(reduce(facts({ runs: [run(1, 'running')] }))).toMatchObject({ kind: 'idle' })
  })

  test('a round already taken up is idle while its session runs, and a protocol failure once it settles', () => {
    const rows: CoordinationRow[] = [
      assignmentOf(
        {
          key: roundKeyOf({ graphId: 'g1', epoch: 1, businessRound: 1, taskId: 't-root', runId: 'r-1' }),
          storeId: 'sg-t-root',
          sessionId: SessionId('s-live'),
          actor: 's-root',
          digest: subjectDigest(roundKeyOf({ graphId: 'g1', epoch: 1, businessRound: 1, taskId: 't-root', runId: 'r-1' })),
          focus: null,
        },
        '2026-10-08T00:04:00.000Z',
      ),
    ]
    const running = reduce(facts({ runs: [run(1, 'verified')], rows, sessions: [live('s-live', 'running')] }))
    expect(running).toMatchObject({ kind: 'idle' })

    const ended = reduce(facts({ runs: [run(1, 'verified')], rows, sessions: [stopped('s-live')] }))
    expect(ended).toMatchObject({ kind: 'protocol-failure' })
    expect((ended as { detail: string }).detail).toContain('without calling supervisor_complete')

    const liveIdle = reduce(facts({ runs: [run(1, 'verified')], rows, sessions: [live('s-live', 'idle')] }))
    expect(liveIdle).toMatchObject({ kind: 'protocol-failure' })
  })
})

describe('claiming the round that settled', () => {
  test('assigns when the round has no work item and the allowance is there', () => {
    expect(reduce(facts({ runs: [run(1, 'verified')] }))).toMatchObject({ kind: 'supervise', plan: { kind: 'assign' } })
  })

  test('a spent allowance suspends the loop with an actionable reason, and does not retry every pass', () => {
    const step = reduce(facts({ runs: [run(1, 'verified')], budget: { used: 8, max: 8 } }))
    expect(step).toMatchObject({ kind: 'suspended', phase: 'failed' })
    expect((step as { detail: string }).detail).toContain('budget-exhausted')
  })

  test('the candidate key is the round the store last settled', () => {
    const step = reduce(facts({ runs: [run(1, 'verified'), run(2, 'failed')] }))
    expect(step).toMatchObject({ kind: 'supervise' })
    expect(keyLabel((step as { request: AssignmentRequest }).request.key)).toContain('round 2')
  })

  test('MAX_ASSIGNMENT_ATTEMPTS exhausted attempts suspend the loop instead of being retried', () => {
    const key = roundKeyOf({ graphId: 'g1', epoch: 1, businessRound: 1, taskId: 't-root', runId: 'r-1' })
    const rows: CoordinationRow[] = []
    for (let attempt = 0; attempt < MAX_ASSIGNMENT_ATTEMPTS; attempt += 1) {
      rows.push(
        assignmentOf(
          { key, storeId: 'sg-t-root', sessionId: SessionId(`s-${attempt}`), actor: 's-root', digest: subjectDigest(key), focus: null },
          '2026-10-08T00:04:00.000Z',
        ),
      )
      rows.push(completion(`s-${attempt}`, { kind: 'interrupted', detail: 'the spawn failed' }))
    }
    const step = reduce(facts({ runs: [run(1, 'verified')], rows }))
    expect(step).toMatchObject({ kind: 'suspended', phase: 'failed' })
    expect((step as { detail: string }).detail).toContain('attempts-exhausted')
  })
})

describe('a round that concluded', () => {
  test('a verified round asking to continue opens the next round as an improvement with no reused members', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'continue',
        reason: 'publish the better method',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'promote',
        searchNext: 'explore',
      },
    })
    const step = reduce(facts({ runs: [run(1, 'verified')], rows }))
    expect(step).toMatchObject({
      kind: 'open-round',
      request: { businessRound: 2, sourceRunId: 'r-1', mode: 'improve', reuses: [] },
    })
    expect((step as { request: { requestKey: string } }).request.requestKey).toBe('rsi-g1-e1-round-2')
    expect((step as { request: { sourceDiagnosisId: string } }).request.sourceDiagnosisId).toBe('rsi-g1-e1-round-1')
  })

  test('a failed round asking to recover opens a recovery round, letting the runtime reuse what it has', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'recover',
        reason: 'repair the failing step',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'retain',
        searchNext: 'explore',
      },
    })
    expect(reduce(facts({ runs: [run(1, 'failed')], rows }))).toMatchObject({
      kind: 'open-round',
      request: { mode: 'recovery' },
    })
  })

  test('an action that disagrees with the round is a protocol failure, never an execution', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'continue',
        reason: 'claims it verified',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'retain',
        searchNext: 'explore',
      },
    })
    const step = reduce(facts({ runs: [run(1, 'failed')], rows }))
    expect(step).toMatchObject({ kind: 'suspended', phase: 'protocol-failure' })
    expect((step as { detail: string }).detail).toContain('the two disagree')
  })

  test('finish stops the loop and keeps the round\'s real outcome, even on the last round', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'finish',
        reason: 'no further method change is justified',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'retain',
        searchNext: 'stop',
      },
    })
    expect(reduce(facts({ runs: [run(1, 'failed')], rows, iterationRounds: 1 }))).toMatchObject({
      kind: 'suspended',
      phase: 'failed',
    })
    expect(reduce(facts({ runs: [run(1, 'verified')], rows }))).toMatchObject({ kind: 'suspended', phase: 'done' })
  })

  test('the configured rounds, once spent, stop the loop without rewriting the outcome', () => {
    const rows = roundRows({
      businessRound: 2,
      runId: 'r-2',
      sessionId: 's-2',
      result: {
        kind: 'completed',
        businessAction: 'recover',
        reason: 'would repair again',
        evidenceRefs: ['t-root#r-2'],
        trialCandidateRef: null,
        methodDecision: 'retain',
        searchNext: 'explore',
      },
    })
    const step = reduce(facts({ runs: [run(1, 'verified'), run(2, 'failed')], rows }))
    expect(step).toMatchObject({ kind: 'suspended', phase: 'failed' })
    expect((step as { detail: string }).detail).toContain('the business outcome stays failed')
  })

  test('a next round already opened is not opened twice', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'continue',
        reason: 'improve',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'promote',
        searchNext: 'explore',
      },
    })
    const opened = snapshot([run(1, 'verified'), run(2, 'running', { requestKey: 'rsi-g1-e1-round-2' })])
    const step = reduce({ ...facts({ runs: [run(1, 'verified')], rows }), snapshot: opened })
    expect(step).toMatchObject({ kind: 'idle' })
  })

  test('a protocol-failure completion is reported once, with the way out named', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: { kind: 'protocol-failure', detail: 'ended without calling the tool' },
    })
    const step = reduce(facts({ runs: [run(1, 'verified')], rows }))
    expect(step).toMatchObject({ kind: 'suspended', phase: 'protocol-failure' })
    expect((step as { detail: string }).detail).toContain('raise the graph')
  })

  test('a trial candidate rides into the next round request unchanged', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'continue',
        reason: 'try the candidate explicitly',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: 'd0007',
        methodDecision: 'trial',
        searchNext: 'explore',
      },
    })
    expect(reduce(facts({ runs: [run(1, 'verified')], rows }))).toMatchObject({
      kind: 'open-round',
      request: { trialCandidateRef: 'd0007' },
    })
  })

  test('without a live root nothing is opened, and the pass says so', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: {
        kind: 'completed',
        businessAction: 'continue',
        reason: 'improve',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'promote',
        searchNext: 'explore',
      },
    })
    const step = reduce(facts({ runs: [run(1, 'verified')], rows, rootLive: false }))
    expect(step).toMatchObject({ kind: 'idle' })
    expect((step as { detail: string }).detail).toContain('not live')
  })
})

describe('the epoch', () => {
  test('bumping it makes a fresh work item, with a fresh diagnosis id', () => {
    const rows = roundRows({
      businessRound: 1,
      runId: 'r-1',
      sessionId: 's-1',
      result: { kind: 'protocol-failure', detail: 'the model never called the tool' },
    })
    // Under epoch 1 the round is a recorded protocol failure and stops.
    expect(reduce(facts({ runs: [run(1, 'verified')], rows }))).toMatchObject({
      kind: 'suspended',
      phase: 'protocol-failure',
    })
    // Under epoch 2 the same round is a new key: it is supervised again.
    const second = reduce(facts({ runs: [run(1, 'verified')], rows, epoch: 2 }))
    expect(second).toMatchObject({ kind: 'supervise', plan: { kind: 'assign' } })
    expect((second as { request: AssignmentRequest }).request.key.epoch).toBe(2)
  })
})

describe('the next round mode', () => {
  test('is the business action and the round outcome agreeing', () => {
    expect(nextRoundMode('continue', 'verified')).toBe('improve')
    expect(nextRoundMode('continue', 'failed')).toBeUndefined()
    expect(nextRoundMode('recover', 'failed')).toBe('recovery')
    expect(nextRoundMode('recover', 'verified')).toBeUndefined()
    expect(nextRoundMode('finish', 'verified')).toBeUndefined()
  })
})

describe('the pass candidate', () => {
  test('a pass whose candidate describes another round is idle, never a guess', () => {
    const withCandidate = facts({ runs: [run(1, 'verified')] })
    const stale = { ...withCandidate, candidate: { ...withCandidate.candidate, key: { ...withCandidate.candidate.key, subject: { ...withCandidate.candidate.key.subject, businessRound: 7 } } as never } }
    expect(reduce(stale)).toMatchObject({ kind: 'idle' })
  })
})
