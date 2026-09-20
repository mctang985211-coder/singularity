import { describe, expect, test } from 'vitest'
import type { ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { JUDGED_DIMENSIONS } from '@dangosys/dsh-singularity-task'
import { computeEscalation, renderEscalation, renderJudgementDimensions } from '../../src/tools/review-escalation.ts'

const task = {
  taskId: 't1',
  parentTaskId: undefined,
  objective: 'Build the feature',
  depth: 0,
  acceptanceCriteria: [],
  requestedCapabilities: [],
  decompositionStatus: 'leaf' as const,
  status: 'failed' as const,
  runIds: ['r1'],
  childTaskIds: [],
}

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    taskId: 't1',
    runId: 'r1',
    sessionId: 's-worker',
    outcome: 'failed',
    evidenceRefs: ['ev-1'],
    anomalies: [],
    localizedCause: 'criterion c1 failed',
    logTail: 'boom',
    ...overrides,
  }
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    version: 1,
    id: 'sg-t-root',
    tasks: [task],
    runs: [],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [review()],
    diagnoses: [], obligations: [],
    capabilities: {},
    ...overrides,
  }
}

describe('computeEscalation', () => {
  test('a failed review with a log tail and evidence is E1 only', () => {
    const decision = computeEscalation(snapshot(), 't1')
    expect(decision.reasons).toEqual(['E1'])
    expect(decision.required).toBe(true)
    expect(decision.budget).toEqual({ used: 0, max: 1 })
    expect(decision.suppressed).toEqual([])
  })

  test('E2 fires when the failure left neither a log tail nor evidence refs', () => {
    const decision = computeEscalation(snapshot({ reviews: [review({ logTail: undefined, evidenceRefs: [] })] }), 't1')
    expect(decision.reasons).toEqual(['E1', 'E2'])
  })

  test('a failure with evidence but no log tail is E1 without E2', () => {
    const decision = computeEscalation(snapshot({ reviews: [review({ logTail: undefined, evidenceRefs: ['ev-1'] })] }), 't1')
    expect(decision.reasons).toEqual(['E1'])
  })

  test('E3 fires on an inconclusive criterion, on any outcome', () => {
    const verified = snapshot({
      tasks: [{ ...task, status: 'verified' }],
      reviews: [review({
        outcome: 'verified',
        localizedCause: undefined,
        logTail: undefined,
        criteria: [{ criterionId: 'c1', verdict: 'inconclusive' }],
      })],
    })
    expect(computeEscalation(verified, 't1').reasons).toEqual(['E3'])
  })

  test('E4 reads the review dimension facts first', () => {
    const decision = computeEscalation(snapshot({
      tasks: [{ ...task, status: 'verified' }],
      reviews: [review({
        outcome: 'verified',
        localizedCause: undefined,
        logTail: undefined,
        dimensions: { capabilityCoverage: { closure: 'gap', granted: [], missing: ['waveform'] } },
      })],
    }), 't1')
    expect(decision.reasons).toEqual(['E4'])
  })

  test('E4 falls back to the stored admission manifest when the review carries no dimensions', () => {
    const decision = computeEscalation(snapshot({
      tasks: [{ ...task, status: 'verified' }],
      reviews: [review({ outcome: 'verified', localizedCause: undefined, logTail: undefined })],
      capabilities: { t1: { capabilities: {}, missing: ['waveform'], closure: 'partial' } },
    }), 't1')
    expect(decision.reasons).toEqual(['E4'])
  })

  test('a clean verified review with closed capabilities does not escalate', () => {
    const decision = computeEscalation(snapshot({
      tasks: [{ ...task, status: 'verified' }],
      reviews: [review({
        outcome: 'verified',
        localizedCause: undefined,
        logTail: undefined,
        criteria: [{ criterionId: 'c1', verdict: 'pass' }],
        dimensions: { capabilityCoverage: { closure: 'closed', granted: ['read'], missing: [] } },
      })],
    }), 't1')
    expect(decision.reasons).toEqual([])
    expect(decision.required).toBe(false)
  })

  test('every signal that holds is reported in code order', () => {
    const decision = computeEscalation(snapshot({
      reviews: [review({ logTail: undefined, evidenceRefs: [], criteria: [{ criterionId: 'c1', verdict: 'inconclusive' }] })],
      capabilities: { t1: { capabilities: {}, missing: ['waveform'], closure: 'gap' } },
    }), 't1')
    expect(decision.reasons).toEqual(['E1', 'E2', 'E3', 'E4'])
  })

  test('a spent budget suppresses a real signal instead of hiding it', () => {
    const decision = computeEscalation(snapshot(), 't1', { used: 1, max: 1 })
    expect(decision.reasons).toEqual(['E1'])
    expect(decision.required).toBe(false)
    expect(decision.suppressed).toEqual(['E1'])
  })

  test('the budget default is one', () => {
    expect(computeEscalation(snapshot(), 't1').budget.max).toBe(1)
  })

  test('a task with no review at all does not escalate on E1/E2/E3', () => {
    expect(computeEscalation(snapshot({ reviews: [] }), 't1').reasons).toEqual([])
  })
})

describe('renderEscalation', () => {
  test('prints the required signals and the budget', () => {
    expect(renderEscalation(computeEscalation(snapshot(), 't1'))).toBe('escalation: required E1 (budget 0/1)')
  })

  test('prints not-required with the budget when nothing fired', () => {
    expect(renderEscalation(computeEscalation(snapshot({ reviews: [] }), 't1'))).toBe('escalation: not required (budget 0/1)')
  })

  test('prints the exhaustion and what it withheld', () => {
    expect(renderEscalation(computeEscalation(snapshot(), 't1', { used: 1, max: 1 })))
      .toBe('escalation: not required (budget 1/1) — suppressed E1: budget exhausted')
  })
})

describe('renderJudgementDimensions', () => {
  test('names the six judged dimensions and none of the mechanical two', () => {
    const line = renderJudgementDimensions()
    for (const dimension of JUDGED_DIMENSIONS) expect(line).toContain(dimension)
    expect(line).not.toContain('outcome_correctness')
    expect(line).not.toContain('capability_coverage')
    expect(line).toContain('not mechanically observable')
  })
})
