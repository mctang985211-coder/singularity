import { describe, expect, test } from 'vitest'
import { assertRootBudgetConfig, checkBatchAdmission, checkRunStart, countSubtreeFacts, hasRootLimits, resolveRootBudget, runDeadlineMs } from '../../src/root-budget.ts'
import type { ResolvedRootBudget } from '../../src/root-budget.ts'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import type {
  Diagnosis,
  EvidenceBundle,
  Obligation,
  ReviewRecord,
  TaskHandoff,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '../../../task/src/index.ts'

/**
 * The root budget and the progress count, as pure functions of a hand-built
 * snapshot. Every case here is a recovery case as much as a live one: a run that
 * is refused because the store already holds its runs, a deadline measured from
 * an instant that was persisted rather than from "now", and a root whose start
 * cannot be read refusing instead of being given a fresh clock.
 */

const STORE = 'sg-t-root'

/**
 * The root session this store id derives from (`rootTaskStoreId`), and its
 * counterpart: the session a replay's own run carries, which names no root of
 * this store. The distinction is what makes a parentless *replay* task share
 * the tree's budget instead of claiming one of its own (A3 §3.5).
 */
const ROOT_SESSION = 'root'
const REPLAY_SESSION = 's-replay-1'

/** One parentless task whose run is bound to this store as its root: the budget owner in the simple cases. */
function rootTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return snapshot({
    tasks: [task('root', undefined)],
    runs: [run('r-root', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION)],
    ...overrides,
  })
}

function task(taskId: string, parentTaskId: string | undefined, childTaskIds: string[] = []): TaskInstance {
  return {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    objective: taskId,
    depth: parentTaskId === undefined ? 0 : 1,
    acceptanceCriteria: [],
    requestedCapabilities: [],
    decompositionStatus: childTaskIds.length > 0 ? 'decomposed' : 'leaf',
    status: 'running',
    runIds: [`r-${taskId}`],
    childTaskIds,
  }
}

function run(runId: string, taskId: string, startedAt = '2026-09-22T00:00:00.000Z', sessionId = `s-${runId}`): TaskRun {
  return { runId, taskId, sessionId, capabilitySnapshot: [], artifacts: [], verifierResults: [], status: 'running', startedAt }
}

function evidence(evidenceId: string, taskId: string): EvidenceBundle {
  return { evidenceId, taskRunId: `r-${taskId}`, taskId, artifacts: [], verifierResults: [], claims: [], generatedAt: '2026-09-22T00:00:10.000Z' }
}

function handoff(handoffId: string, parentTaskId: string, childTaskId: string): TaskHandoff {
  return {
    handoffId,
    parentTaskId,
    parentRunId: `r-${parentTaskId}`,
    childTaskId,
    parentObjective: parentTaskId,
    reasonForDelegation: 'because',
    constraints: [],
    decisions: [],
    relevantArtifacts: [],
    relevantEvidence: [],
    assumptions: [],
    openQuestions: [],
    createdAt: '2026-09-22T00:00:05.000Z',
  }
}

function review(taskId: string): ReviewRecord {
  return { taskId, outcome: 'verified', evidenceRefs: [], anomalies: [] }
}

function diagnosis(diagnosisId: string, taskId: string): Diagnosis {
  return {
    diagnosisId,
    taskId,
    observedFailure: 'none',
    scope: taskId,
    localizedCause: 'none',
    evidenceRefs: [],
    reviewRefs: [],
    confidence: 'high',
    proposals: [],
  }
}

function obligation(obligationId: string, sourceTaskId: string): Obligation {
  return { obligationId, goal: obligationId, criterion: 'it is done', sourceTaskId }
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    version: 1,
    id: STORE,
    tasks: [],
    runs: [],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
    ...overrides,
  }
}

/**
 * The three-level tree the count tests use: root → child-a → grandchild, with child-b beside it,
 * plus a parentless task that is not this store's root (the shape a replay leaves behind).
 */
function threeLevelTree(): TaskSnapshot {
  return snapshot({
    tasks: [
      task('root', undefined, ['child-a', 'child-b']),
      task('child-a', 'root', ['grandchild']),
      task('grandchild', 'child-a'),
      task('child-b', 'root'),
      task('outsider', undefined),
    ],
    runs: [
      run('r-root', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION),
      run('r-child-a', 'child-a'),
      run('r-grandchild', 'grandchild'),
      run('r-child-b', 'child-b'),
      run('r-outsider', 'outsider', '2026-09-22T00:00:00.000Z', REPLAY_SESSION),
    ],
    edges: [
      { from: 'child-a', to: 'child-b' },
      { from: 'grandchild', to: 'root' },
      { from: 'outsider', to: 'outsider' },
    ],
    evidence: [evidence('e-1', 'root'), evidence('e-2', 'grandchild'), evidence('e-3', 'child-b'), evidence('e-4', 'outsider')],
    handoffs: [handoff('h-1', 'root', 'child-a'), handoff('h-2', 'root', 'child-b'), handoff('h-3', 'outsider', 'outsider')],
    reviews: [review('root'), review('grandchild'), review('child-b'), review('outsider')],
    diagnoses: [diagnosis('d-1', 'root'), diagnosis('d-2', 'child-a'), diagnosis('d-3', 'outsider')],
    obligations: [obligation('o-1', 'grandchild'), obligation('o-2', 'child-b'), obligation('o-3', 'outsider')],
  })
}

describe('resolveRootBudget', () => {
  test('reads the budget from the root run that is already recorded', () => {
    const tree = snapshot({
      tasks: [task('root', undefined, ['child-a']), task('child-a', 'root')],
      runs: [run('r-root', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION), run('r-child-a', 'child-a')],
    })
    const resolved = resolveRootBudget(tree, { wallTimeMs: 60_000, maxRuns: 8 })
    expect(resolved).toEqual({
      ok: true,
      rootTaskId: 'root',
      acceptedAt: '2026-09-22T00:00:00.000Z',
      deadlineAt: '2026-09-22T00:01:00.000Z',
      maxRuns: 8,
    })
  })

  test('measures from the root task\u2019s own first run when it has several', () => {
    const tree = snapshot({
      tasks: [{ ...task('root', undefined), runIds: ['r-root-2', 'r-root-1'] }],
      runs: [run('r-root-1', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION), run('r-root-2', 'root', '2026-09-22T00:05:00.000Z', ROOT_SESSION)],
    })
    const resolved = resolveRootBudget(tree, { wallTimeMs: 60_000 })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('unreachable')
    expect(resolved.acceptedAt).toBe('2026-09-22T00:05:00.000Z')
    expect(resolved.deadlineAt).toBe('2026-09-22T00:06:00.000Z')
  })

  test('leaves the deadline absent when no wall time is configured', () => {
    const resolved = resolveRootBudget(snapshot({ tasks: [task('root', undefined)], runs: [run('r-root', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION)] }), {})
    expect(resolved).toEqual({ ok: true, rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z' })
  })

  test('refuses a store with no root, naming the store', () => {
    const resolved = resolveRootBudget(snapshot({ tasks: [task('child', 'someone')], runs: [run('r-child', 'child')] }), {})
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.reason).toContain(STORE)
    expect(resolved.reason).toContain('no root task')
  })

  test('resolves the store\u2019s own root out of several parentless tasks, with a replay\u2019s task beside it', () => {
    // The store's root is the parentless task whose run is bound to the root
    // session the store id derives from; a replay's parentless task carries no
    // such binding and shares the root's total instead of splitting it (§3.5).
    const resolved = resolveRootBudget(threeLevelTree(), {})
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) throw new Error('unreachable')
    expect(resolved.rootTaskId).toBe('root')
    expect(resolved.acceptedAt).toBe('2026-09-22T00:00:00.000Z')
    expect(rootTaskStoreId(ROOT_SESSION)).toBe(STORE)
    expect(rootTaskStoreId(REPLAY_SESSION)).not.toBe(STORE)
  })

  test('refuses a store whose parentless tasks are all unbound: no run names a root session of this store', () => {
    const tree = snapshot({
      tasks: [task('replayed', undefined)],
      runs: [run('r-replayed', 'replayed', '2026-09-22T00:00:00.000Z', REPLAY_SESSION)],
    })
    const resolved = resolveRootBudget(tree, {})
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.reason).toContain('replayed')
    expect(resolved.reason).toContain(REPLAY_SESSION)
    expect(resolved.reason).toContain('no budget owner')
  })

  test('refuses a store with two tasks both bound to this store as its root, naming them', () => {
    const tree = snapshot({
      tasks: [task('root', undefined), task('root-again', undefined)],
      runs: [
        run('r-root', 'root', '2026-09-22T00:00:00.000Z', ROOT_SESSION),
        run('r-root-again', 'root-again', '2026-09-22T00:01:00.000Z', ROOT_SESSION),
      ],
    })
    const resolved = resolveRootBudget(tree, {})
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.reason).toContain('root')
    expect(resolved.reason).toContain('root-again')
    expect(resolved.reason).toContain('no single budget owner')
  })

  test('refuses a root with no run at all', () => {
    const resolved = resolveRootBudget(snapshot({ tasks: [task('root', undefined)] }), { wallTimeMs: 1000 })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.reason).toContain('has no run recorded')
    expect(resolved.reason).toContain('restart time is not a substitute')
  })

  test('refuses a root run whose startedAt is missing or unreadable, without inventing one', () => {
    const missing = resolveRootBudget(rootTaskSnapshot({ runs: [run('r-root', 'root', '', ROOT_SESSION)] }), { wallTimeMs: 1000 })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('unreachable')
    expect(missing.reason).toContain('no readable startedAt')
    const unreadable = resolveRootBudget(rootTaskSnapshot({ runs: [run('r-root', 'root', 'yesterday', ROOT_SESSION)] }), {})
    expect(unreadable.ok).toBe(false)
    if (unreadable.ok) throw new Error('unreachable')
    expect(unreadable.reason).toContain('no honest start instant')
  })

  test('a root whose own run is unbound is not a budget owner', () => {
    const resolved = resolveRootBudget(snapshot({ tasks: [task('root', undefined)], runs: [run('r-root', 'root')] }), { wallTimeMs: 1000 })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('unreachable')
    expect(resolved.reason).toContain('no budget owner')
  })
})

describe('hasRootLimits', () => {
  test('a budget with no member in force enforces nothing, whatever its object presence says', () => {
    expect(hasRootLimits(undefined)).toBe(false)
    // The configuration schema materializes an absent `rootBudget` as `{}`, so a
    // refusal may not key off the object's presence: only a member in force is a
    // limit this deployment asked for.
    expect(hasRootLimits({})).toBe(false)
    expect(hasRootLimits({ maxRuns: 1 })).toBe(true)
    expect(hasRootLimits({ wallTimeMs: 1000 })).toBe(true)
    expect(hasRootLimits({ maxConcurrentWrites: 1 })).toBe(true)
  })
})

describe('checkRunStart', () => {
  const budget: ResolvedRootBudget = { rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z', maxRuns: 5 }

  test('refuses a start once the store holds maxRuns runs, and allows one below it', () => {
    const tree = threeLevelTree()
    expect(tree.runs).toHaveLength(5)
    const refused = checkRunStart(tree, budget, Date.parse('2026-09-22T00:00:01.000Z'))
    expect(refused.allowed).toBe(false)
    if (refused.allowed) throw new Error('unreachable')
    expect(refused.reason).toContain('allows 5 run(s)')
    expect(refused.reason).toContain('already holds 5')
    const under: ResolvedRootBudget = { ...budget, maxRuns: 6 }
    expect(checkRunStart(tree, under, Date.parse('2026-09-22T00:00:01.000Z'))).toEqual({ allowed: true })
  })

  test('refuses a start past the deadline, and allows one before it', () => {
    const tree = snapshot({ tasks: [task('root', undefined)], runs: [run('r-root', 'root')] })
    const withDeadline: ResolvedRootBudget = { rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z', deadlineAt: '2026-09-22T00:01:00.000Z' }
    expect(checkRunStart(tree, withDeadline, Date.parse('2026-09-22T00:00:59.999Z'))).toEqual({ allowed: true })
    const refused = checkRunStart(tree, withDeadline, Date.parse('2026-09-22T00:01:00.000Z'))
    expect(refused.allowed).toBe(false)
    if (refused.allowed) throw new Error('unreachable')
    expect(refused.reason).toContain('deadline 2026-09-22T00:01:00.000Z has passed')
    expect(refused.reason).toContain('accepted at 2026-09-22T00:00:00.000Z')
  })

  test('never counts a start as free just because a restart happened: the count comes from the store', () => {
    const tree = threeLevelTree()
    const tight: ResolvedRootBudget = { rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z', maxRuns: 1 }
    expect(checkRunStart(tree, tight, Date.parse('2026-09-22T00:00:01.000Z')).allowed).toBe(false)
  })
})

describe('checkBatchAdmission', () => {
  test('reserves a run slot per child and refuses the whole batch when they do not fit', () => {
    const tree = threeLevelTree()
    const budget: ResolvedRootBudget = { rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z', maxRuns: 7 }
    // 5 runs + 2 children fit exactly.
    expect(checkBatchAdmission(tree, budget, 2)).toEqual({ allowed: true })
    const refused = checkBatchAdmission(tree, budget, 3)
    expect(refused.allowed).toBe(false)
    if (refused.allowed) throw new Error('unreachable')
    expect(refused.reason).toContain('batch of 3 child task(s)')
    expect(refused.reason).toContain('allows 7 run(s)')
    expect(refused.reason).toContain('5 are already recorded')
    expect(refused.reason).toContain('refused whole, with no side effects')
  })

  test('allows any batch when no run limit is configured', () => {
    const budget: ResolvedRootBudget = { rootTaskId: 'root', acceptedAt: '2026-09-22T00:00:00.000Z' }
    expect(checkBatchAdmission(threeLevelTree(), budget, 100)).toEqual({ allowed: true })
  })
})

describe('runDeadlineMs', () => {
  test('takes the tighter of the run wall time and the root remainder', () => {
    const now = Date.parse('2026-09-22T00:10:00.000Z')
    // Run wall time has 5 minutes left; the root has 30.
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', 15 * 60_000, '2026-09-22T00:40:00.000Z', now)).toBe(5 * 60_000)
    // The root's remainder is the tighter one.
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', 60 * 60_000, '2026-09-22T00:20:00.000Z', now)).toBe(10 * 60_000)
  })

  test('measures the run wall time from its persisted start, so a resume does not restart the clock', () => {
    const start = '2026-09-22T00:00:00.000Z'
    const midRun = Date.parse('2026-09-22T00:09:00.000Z')
    const later = Date.parse('2026-09-22T00:09:30.000Z')
    expect(runDeadlineMs(start, 10 * 60_000, undefined, midRun)).toBe(60_000)
    // The same run observed later has less left — never a fresh window.
    expect(runDeadlineMs(start, 10 * 60_000, undefined, later)).toBe(30_000)
    // And once the run's own wall time has passed, nothing is left.
    expect(runDeadlineMs(start, 10 * 60_000, undefined, Date.parse('2026-09-22T00:11:00.000Z'))).toBe(0)
  })

  test('returns 0 once a bound has passed and 0 for a bound nobody can read', () => {
    const now = Date.parse('2026-09-22T00:20:00.000Z')
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', 60_000, '2026-09-22T00:30:00.000Z', now)).toBe(0)
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', 60 * 60_000, '2026-09-22T00:10:00.000Z', now)).toBe(0)
    expect(runDeadlineMs('never', 60_000, undefined, now)).toBe(0)
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', 60_000, 'never', now)).toBe(0)
  })

  test('reports no bound at all when neither is configured', () => {
    expect(runDeadlineMs('2026-09-22T00:00:00.000Z', undefined, undefined, Date.parse('2026-09-22T00:20:00.000Z'))).toBe(Number.POSITIVE_INFINITY)
  })

})

describe('countSubtreeFacts', () => {
  test('counts every entry of a three-level subtree and nothing outside it', () => {
    const tree = threeLevelTree()
    // root subtree: tasks root/child-a/child-b/grandchild = 4, runs = 4,
    // edges: child-a→child-b and grandchild→root (the outsider self-edge is
    // outside) = 2, evidence = 3, handoffs = 2, reviews = 3, diagnoses = 2,
    // obligations = 2.
    expect(countSubtreeFacts(tree, 'root')).toBe(4 + 4 + 2 + 3 + 2 + 3 + 2 + 2)
    // child-a subtree: child-a + grandchild = 2 tasks, 2 runs, 2 edges (both
    // edges out of the subtree have their `from` inside), 1 evidence, 1 handoff
    // (root→child-a has its `childTaskId` inside), 1 review, 1 diagnosis, 1
    // obligation.
    expect(countSubtreeFacts(tree, 'child-a')).toBe(2 + 2 + 2 + 1 + 1 + 1 + 1 + 1)
    // A leaf counts itself and what names it.
    expect(countSubtreeFacts(tree, 'child-b')).toBe(1 + 1 + 1 + 1 + 1 + 1 + 0 + 1)
  })

  test('does not count a sibling tree living in the same store', () => {
    const tree = threeLevelTree()
    const sibling = countSubtreeFacts(tree, 'outsider')
    const rooted = countSubtreeFacts(tree, 'root')
    // Work recorded against the outsider sub-tree moves its own count and leaves
    // the root's alone: the filter is the subtree, not the store.
    const withMore = { ...tree, diagnoses: [...tree.diagnoses, diagnosis('d-9', 'outsider')] }
    expect(countSubtreeFacts(withMore, 'root')).toBe(rooted)
    expect(countSubtreeFacts(withMore, 'outsider')).toBe(sibling + 1)
  })

  test('is stable for an unknown task and does not loop on a cycle', () => {
    expect(countSubtreeFacts(threeLevelTree(), 'no-such-task')).toBe(0)
    const cyclic = snapshot({
      tasks: [task('a', undefined, ['b']), task('b', 'a', ['a'])],
      runs: [run('r-a', 'a'), run('r-b', 'b')],
    })
    expect(countSubtreeFacts(cyclic, 'a')).toBe(2 + 2)
  })
})

describe('assertRootBudgetConfig', () => {
  test('accepts the only concurrent-write limit this deployment can enforce', () => {
    expect(() => assertRootBudgetConfig({})).not.toThrow()
    expect(() => assertRootBudgetConfig({ maxConcurrentWrites: 1 })).not.toThrow()
    expect(() => assertRootBudgetConfig({ wallTimeMs: 1000, maxRuns: 3 })).not.toThrow()
  })

  test('refuses a concurrent-write limit it cannot execute, naming the value', () => {
    expect(() => assertRootBudgetConfig({ maxConcurrentWrites: 2 })).toThrow(/maxConcurrentWrites is 2/)
    expect(() => assertRootBudgetConfig({ maxConcurrentWrites: 2 })).toThrow(/enforces exactly 1 concurrent writer/)
    expect(() => assertRootBudgetConfig({ maxConcurrentWrites: 0 })).toThrow(/maxConcurrentWrites is 0/)
  })
})
