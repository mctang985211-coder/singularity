/** Frozen cost optimization is measured over actual Run descendants and rechecked at promotion. */
import { describe, expect, it } from 'vitest'
import type { ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { costOf, experimentLineage } from '../../src/experiment/record.ts'
import { assertSideEvidence } from '../../src/promotion/binding.ts'
import {
  assertFrozenExperiment, compareExperimentSides, EXPERIMENT_COMPARER_VERSION,
  overallExperimentVerdict,
} from '../../src/replay.ts'
import type { ExperimentSideComparison, FrozenExperiment, FrozenSample } from '../../src/replay.ts'

const objective = 'tool-call-reduction' as const
const hex = 'a'.repeat(64)

function side(calls: number | undefined, overrides: Partial<ExperimentSideComparison> = {}): ExperimentSideComparison {
  return {
    outcome: 'verified', criteria: [{ criterionId: 'goal', verdict: 'pass' }],
    cost: calls === undefined ? { status: 'unknown', reason: 'no readable session log' }
      : { status: 'reported', metrics: { toolCalls: { calls, failures: 0 } } },
    ...overrides,
  }
}

function sample(role: FrozenSample['role']): FrozenSample {
  return {
    taskId: role, role, contractDigest: hex, observed: { outcome: role === 'observed-failure' ? 'failed' : 'verified' },
    criteria: [{ criterionId: 'goal', verificationMode: 'deterministic', protectedInputsDigest: hex,
      verifierRef: 'command', verifierVersion: '1', verifierAnchor: 'registered', command: 'true' }],
    provider: { capabilities: [], registryRevision: hex, candidateRegistryRevision: hex, mcpServers: [], preset: null, skills: [] },
  }
}

function frozen(): FrozenExperiment {
  return {
    proposalId: 'p1', objective, repetition: 0, candidate: { name: 'skill', sha256: hex },
    model: { provider: 'mock', model: 'mock', label: 'mock/mock' }, budget: {},
    samples: [sample('observed-success'), sample('holdout')], snapshot: { sourceDir: '/fixture', digest: hex },
    comparerVersion: EXPERIMENT_COMPARER_VERSION, overlay: { baseline: 'production', candidate: 'sandbox' },
  }
}

describe('the frozen tool-call objective', () => {
  it('requires an observed successful case and independent holdout; failure repair keeps its prior rule', () => {
    expect(() => assertFrozenExperiment(frozen())).not.toThrow()
    expect(() => assertFrozenExperiment({ ...frozen(), objective: undefined })).toThrow(/observed-failure/)
    expect(() => assertFrozenExperiment({ ...frozen(), samples: [sample('observed-failure'), sample('holdout')] })).toThrow(/observed-success/)
    expect(() => assertFrozenExperiment({ ...frozen(), samples: [sample('observed-success')] })).toThrow(/holdout/)
    expect(() => assertFrozenExperiment({ ...frozen(), objective: 'elapsed-time' })).toThrow(/objective/)
  })

  it.each([
    [8, 3, 'improved'], [8, 8, 'not-improved'], [8, 9, 'not-improved'],
    [undefined, 0, 'inconclusive'], [8, undefined, 'inconclusive'], [8, -1, 'inconclusive'],
  ] as const)('compares observed calls %s → %s as %s', (before, after, verdict) => {
    expect(compareExperimentSides('observed-success', side(before), side(after), objective)).toBe(verdict)
  })

  it('requires both executions to pass unchanged acceptance', () => {
    expect(compareExperimentSides('observed-success', side(8), side(1, { outcome: 'failed' }), objective)).toBe('regressed')
    expect(compareExperimentSides('observed-success', side(8, { outcome: 'failed' }), side(1), objective)).toBe('inconclusive')
    expect(compareExperimentSides('observed-success', side(8), side(1, { criteria: [] }), objective)).toBe('regressed')
    expect(compareExperimentSides('observed-success', side(8), side(1, {
      criteria: [{ criterionId: 'goal', verdict: 'fail' }],
    }), objective)).toBe('regressed')
    expect(compareExperimentSides('observed-success', side(8), side(1, { outcome: 'cancelled' }), objective)).toBe('inconclusive')
    const optionalFailure = [{ criterionId: 'optional', verdict: 'fail' as const }]
    expect(compareExperimentSides('observed-success', side(8, { criteria: optionalFailure }), side(1, { criteria: optionalFailure }), objective)).toBe('improved')
  })

  it('permits flat holdout cost and blocks holdout regression even when the observed source improved', () => {
    expect(compareExperimentSides('holdout', side(8), side(8), objective)).toBe('maintained')
    expect(compareExperimentSides('holdout', side(8), side(9), objective)).toBe('regressed')
    const target = { role: 'observed-success' as const, verdict: 'improved' as const }
    expect(overallExperimentVerdict([target, { role: 'holdout', verdict: 'maintained' }], objective)).toBe('improved')
    expect(overallExperimentVerdict([target, { role: 'holdout', verdict: 'regressed' }], objective)).toBe('regressed')
    expect(overallExperimentVerdict([target, { role: 'holdout', verdict: 'inconclusive' }], objective)).toBe('inconclusive')
    expect(overallExperimentVerdict([{ ...target, verdict: 'not-improved' }], objective)).toBe('not-improved')
  })

  it('does not reinterpret failure repair as optimization', () => {
    expect(compareExperimentSides('observed-failure', side(1, { outcome: 'failed' }), side(99))).toBe('fixed')
    expect(overallExperimentVerdict([{ role: 'observed-failure', verdict: 'fixed' }, { role: 'holdout', verdict: 'maintained' }])).toBe('fixed')
  })
})

function subtree(): TaskSnapshot {
  const runs = [
    { runId: 'root', taskId: 'replayed', status: 'verified' },
    { runId: 'child', taskId: 'child-task', parentRunId: 'root', status: 'verified' },
    { runId: 'grandchild', taskId: 'grandchild-task', parentRunId: 'child', status: 'verified' },
    { runId: 'unrelated', taskId: 'other', status: 'verified' },
  ]
  const reviews = runs.map((run, index) => ({
    runId: run.runId, taskId: run.taskId, outcome: 'verified', criteria: [], evidenceRefs: [],
    metrics: { toolCalls: { calls: [2, 7, 3, 100][index], failures: index === 1 ? 1 : 0 } },
  }))
  return { runs, reviews, evidence: [], tasks: [{ taskId: 'replayed', runIds: ['root'],
    objective: `[${experimentLineage('exp1', 'observed-success', 'candidate')}] goal` }] } as unknown as TaskSnapshot
}

describe('complete subtree cost evidence', () => {
  it('includes descendants once and excludes unrelated runs; default repair retains session metrics', () => {
    const snapshot = subtree()
    expect(costOf(snapshot.reviews[0], snapshot)).toEqual({ status: 'reported', metrics: { toolCalls: { calls: 12, failures: 1 } } })
    expect(costOf(snapshot.reviews[0])).toEqual({ status: 'reported', metrics: { toolCalls: { calls: 2, failures: 0 } } })
  })

  it.each(['no-review', 'no-counter', 'in-flight', 'invalid-counter'] as const)('marks a %s descendant as unknown', missing => {
    const snapshot = subtree()
    if (missing === 'no-review') snapshot.reviews.splice(1, 1)
    if (missing === 'no-counter') snapshot.reviews[1]!.metrics = {}
    if (missing === 'in-flight') snapshot.runs[1]!.status = 'running'
    if (missing === 'invalid-counter') snapshot.reviews[1]!.metrics!.toolCalls!.calls = Number.NaN
    expect(costOf(snapshot.reviews[0], snapshot)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('child') })
  })

  it('rechecks durable subtree counters before promotion; a smaller forged report cannot pass', () => {
    const snapshot = subtree()
    const review = snapshot.reviews[0] as ReviewRecord
    const input = {
      objective, sample: sample('observed-success'), experimentId: 'exp1', snapshot, where: 'candidate',
      detail: { taskId: 'replayed', runId: 'root', role: 'observed-success' as const, side: 'candidate' as const,
        outcome: 'verified' as const, reviewRef: 'replayed#root', evidenceRefs: [], criteria: [],
        workspace: '/candidate', initialDigest: hex, cost: costOf(review, snapshot) },
    }
    expect(() => assertSideEvidence(input)).not.toThrow()
    input.detail.cost = { status: 'reported', metrics: { toolCalls: { calls: 1, failures: 0 } } }
    expect(() => assertSideEvidence(input)).toThrow(/subtree.*counters/)
    input.detail.cost = costOf(review, snapshot)
    snapshot.reviews[1]!.metrics!.toolCalls!.calls += 1
    expect(() => assertSideEvidence(input)).toThrow(/subtree.*counters/)
  })
})
