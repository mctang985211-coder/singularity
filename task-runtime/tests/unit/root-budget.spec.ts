import { describe, expect, test } from 'vitest'
import {
  assertRootBudgetConfig,
  checkBatchAdmission,
  checkRunStart,
  hasRootLimits,
  resolveRootBudget,
} from '../../src/root-budget.ts'
import type { TaskBudgetExtension, TaskSnapshot } from '../../../task/src/index.ts'

function tree(runs = 1): TaskSnapshot {
  return {
    version: 1,
    id: 'sg-t-root',
    tasks: [
      {
        taskId: 'root',
        definitionRef: { taskType: 'root', version: 1 },
        objective: 'root',
        depth: 0,
        acceptanceCriteria: [],
        requestedCapabilities: [],
        decompositionStatus: 'leaf',
        status: 'running',
        runIds: ['r-root'],
        childTaskIds: [],
      },
    ],
    runs: Array.from({ length: runs }, (_, i) => ({
      runId: i === 0 ? 'r-root' : `r-${i}`,
      taskId: i === 0 ? 'root' : `child-${i}`,
      sessionId: i === 0 ? 'root' : `s-${i}`,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: '2026-09-22T00:00:00.000Z',
    })),
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
  }
}

function extension(overrides: Partial<TaskBudgetExtension>): TaskBudgetExtension {
  return {
    requestKey: 'raise',
    requestDigest: 'historical-identity',
    approvalRef: 'approval:1',
    requestedBy: 'root',
    baseline: { maxRuns: 3 },
    recordedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  }
}

function resolve(snapshot: TaskSnapshot, maxRuns?: number) {
  const result = resolveRootBudget(snapshot, maxRuns === undefined ? {} : { maxRuns })
  if (!result.ok) throw new Error(result.reason)
  return result
}

describe('persisted root budget', () => {
  test('keeps observed acceptance time and run ceiling across reopening', () => {
    expect(resolve(tree(3), 8)).toEqual({
      ok: true,
      rootTaskId: 'root',
      acceptedAt: '2026-09-22T00:00:00.000Z',
      maxRuns: 8,
      configured: { maxRuns: 8 },
    })
  })

  test('uses the store root while a parentless replay shares its run count', () => {
    const snapshot = tree(2)
    const withReplay: TaskSnapshot = {
      ...snapshot,
      tasks: [...snapshot.tasks, { ...snapshot.tasks[0]!, taskId: 'replay', runIds: ['r-replay'] }],
      runs: [...snapshot.runs, { ...snapshot.runs[0]!, taskId: 'replay', runId: 'r-replay', sessionId: 's-replay' }],
    }
    expect(resolve(withReplay, 3).rootTaskId).toBe('root')
    expect(checkRunStart(withReplay, resolve(withReplay, 3)).allowed).toBe(false)
  })

  test('does not refund recorded runs after a restart', () => {
    const snapshot = tree(3)
    expect(checkRunStart(snapshot, resolve(snapshot, 3))).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('already holds 3'),
    })
    expect(checkRunStart(snapshot, resolve(snapshot, 4))).toEqual({ allowed: true })
  })

  test('reserves every child run before admitting the batch', () => {
    const snapshot = tree(3)
    expect(checkBatchAdmission(snapshot, resolve(snapshot, 5), 2)).toEqual({ allowed: true })
    expect(checkBatchAdmission(snapshot, resolve(snapshot, 5), 3)).toMatchObject({ allowed: false })
    expect(checkBatchAdmission(snapshot, resolve(snapshot), 100)).toEqual({ allowed: true })
  })

  test('approved maxRuns remains in force while old approved deadlines are only historical data', () => {
    const snapshot = tree(3)
    const legacy = extension({
      maxRuns: { previous: 3, next: 7 },
      deadlineAt: { previous: '2026-09-22T00:01:00.000Z', next: '2026-09-22T00:02:00.000Z' },
      baseline: { maxRuns: 3, deadlineAt: '2026-09-22T00:01:00.000Z' },
    })
    const extended: TaskSnapshot = { ...snapshot, budgetExtensions: { all: [legacy], byRequestKey: { raise: legacy } } }
    const budget = resolve(extended, 3)
    expect(budget).toEqual({
      ok: true,
      rootTaskId: 'root',
      acceptedAt: snapshot.runs[0]!.startedAt,
      maxRuns: 7,
      configured: { maxRuns: 3 },
    })
    expect(checkRunStart(snapshot, budget)).toEqual({ allowed: true })
    expect(resolve(extended).maxRuns).toBe(7)
    expect(extended.budgetExtensions!.all[0]!.deadlineAt).toEqual(legacy.deadlineAt)
  })

  test('rejects missing budget owner and unreadable observed start', () => {
    const snapshot = tree()
    expect(resolveRootBudget({ ...snapshot, tasks: [] }, {}).ok).toBe(false)
    const missingRun = tree()
    expect(resolveRootBudget({ ...missingRun, runs: [] }, { maxRuns: 3 }).ok).toBe(false)
    const unreadable = tree()
    unreadable.runs[0]!.startedAt = 'unreadable'
    expect(resolveRootBudget(unreadable, {}).ok).toBe(false)
  })

  test('has no limit without a run count or concurrent writer setting', () => {
    expect(hasRootLimits(undefined)).toBe(false)
    expect(hasRootLimits({})).toBe(false)
    expect(hasRootLimits({ maxRuns: 3 })).toBe(true)
    expect(hasRootLimits({ maxConcurrentWrites: 1 })).toBe(true)
  })

  test('enforces exactly one workspace writer', () => {
    expect(() => assertRootBudgetConfig({ maxRuns: 3, maxConcurrentWrites: 1 })).not.toThrow()
    expect(() => assertRootBudgetConfig({ maxConcurrentWrites: 2 })).toThrow('exactly 1')
  })
})
