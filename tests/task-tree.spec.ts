/**
 * The decomposition tree: readiness, named blockers, and how sub-tasks support the parent.
 */

import { describe, expect, it } from 'vitest'

import {
  foldSubjects,
  MemoryLog,
  projectTree,
  type ProtocolRegistry,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TreeChildView,
  type TaskState,
  type TreeView,
} from '../src/index.ts'
import { INTEGRATION_VERIFIER, taskRegistry, UNIT_VERIFIER } from './task-fixtures.ts'
import {
  admit,
  CHILD_A,
  CHILD_A_CONTRACT,
  CHILD_B,
  CHILD_B_CONTRACT,
  CHILD_C,
  CHILD_C_CONTRACT,
  assigned,
  chain,
  decompose,
  failed,
  judge,
  PARENT,
  parentContract,
  plan,
  openRun,
  planned,
  treeLog,
  verified,
} from './tree-fixtures.ts'

/** The one tree in a log that declares exactly one plan. */
function tree(registry: ProtocolRegistry, log: MemoryLog): TreeView {
  const views = projectTree(foldSubjects<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION))
  expect(views).toHaveLength(1)
  const view = views[0]
  if (view === undefined) throw new Error('expected one projected tree')
  return view
}

const statusOf = (view: TreeView, taskId: string): TreeChildView | undefined =>
  view.children.find(child => child.taskId === taskId)

describe('a plan is presented with its gates, not its hopes', () => {
  it('shows a sub-task as ready only when nothing gates it, and names what gates the other', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    const view = tree(registry, log)

    // A is ready because nothing gates it; B depends on A, which has not verified, so B waits, naming it.
    expect(view).toMatchObject({ parentTaskId: PARENT, children: [{ taskId: CHILD_A, status: 'ready' }, { taskId: CHILD_B, status: 'waiting' }], ready: [CHILD_A], blocked: [{ taskId: CHILD_B, reason: expect.stringContaining(CHILD_A) }], complete: false, })
  })

  it('names a declared sub-task that was never admitted, and never offers it as ready', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(assigned(PARENT))
    await log.emit(decompose(PARENT, plan()))
    const view = tree(registry, log)

    expect(view).toMatchObject({ children: [{ taskId: CHILD_A, status: 'missing' }, { taskId: CHILD_B, status: 'missing' }], ready: [], complete: false, })
    // A declared sub-task nobody admitted is never offered as ready; the blocked list names it.
    expect(view.blocked[0]?.reason).toContain('no admitted contract')
  })

  it('lets a dependent proceed only once the dependency has verified', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))

    const view = tree(registry, log)
    // The dependency verified, so the dependent proceeds: nothing is waiting and nothing is blocked.
    expect(view).toMatchObject({ children: [{ taskId: CHILD_A, status: 'verified' }, { taskId: CHILD_B, status: 'ready' }], ready: [CHILD_B], blocked: [], })
  })

  it('blocks a dependent on a dependency that ended without verifying, naming it', async () => {
    const registry = taskRegistry()
    const log = await planned(registry, { aDependsOn: [] })
    for (const runId of ['a1', 'a2']) {
      await openRun(log, CHILD_A, runId)
      await log.emit(judge(CHILD_A, runId, 'part-a', UNIT_VERIFIER, 'fail'))
      await log.emit(failed(CHILD_A, runId, 'the count is wrong', 'acceptance'))
    }

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)).toMatchObject({ status: 'stopped', lastOutcome: 'failed', reason: expect.stringContaining('budget exhausted'), })
    // B is blocked by A being stopped, not merely having failed: the reason names that link and the
    // rule behind it, that only a verified dependency satisfies a dependent.
    expect(statusOf(view, CHILD_B)).toMatchObject({ status: 'blocked', reason: expect.stringMatching(new RegExp(`"${CHILD_A}" is stopped.*only a verified dependency`)), })
  })

  it('propagates a stopped dependency through a chain, naming each link', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(assigned(PARENT))
    await log.emit(decompose(PARENT, chain()))
    await log.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await log.emit(admit(CHILD_B, CHILD_B_CONTRACT()))
    await log.emit(admit(CHILD_C, CHILD_C_CONTRACT()))
    for (const subject of [CHILD_A, CHILD_B, CHILD_C]) await log.emit(assigned(subject))

    // A's single declared run fails: A is stopped, and nothing downstream may start.
    await openRun(log, CHILD_A, 'a1')
    await log.emit(failed(CHILD_A, 'a1', 'the counter crashed'))

    const view = tree(registry, log)
    // The second link is blocked by the first link's blocked-ness, not by A directly.
    expect(view).toMatchObject({ children: [ { taskId: CHILD_A, status: 'stopped' }, { taskId: CHILD_B, status: 'blocked', reason: expect.stringContaining(`"${CHILD_A}" is stopped`) }, { taskId: CHILD_C, status: 'blocked', reason: expect.stringContaining(`"${CHILD_B}" is blocked`) }, ], ready: [], complete: false, })
  })

  it('reports a failing sub-task as retryable while its budget remains, without calling it verified', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER, 'fail'))
    await log.emit(failed(CHILD_A, 'a1', 'first attempt failed', 'acceptance'))

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)).toMatchObject({ status: 'ready', lastOutcome: 'failed', runsUsed: 1, reason: expect.stringContaining('1 of 2 runs remain'), })
    // A failing attempt must not be mistaken for a verified dependency.
    expect(statusOf(view, CHILD_B)?.status).toBe('waiting')
  })
})

describe('a parent is accepted by verification, never by its children ending', () => {
  it('keeps verified child support separate from the parent\'s own acceptance', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    for (const [taskId, contractCriterion, runId] of [
      [CHILD_A, 'part-a', 'a1'],
      [CHILD_B, 'part-b', 'b1'],
    ] as const) {
      await openRun(log, taskId, runId)
      await log.emit(judge(taskId, runId, contractCriterion, taskId === CHILD_A ? UNIT_VERIFIER : INTEGRATION_VERIFIER))
      await log.emit(verified(taskId, runId))
    }

    const view = tree(registry, log)
    expect(view.criteria.map(entry => entry.satisfiedBy)).toEqual([null, null])
    expect(view.criteria.map(entry => entry.supportedBy)).toEqual([[CHILD_A], [CHILD_B]])
    expect(view.complete).toBe(false)
  })

  it('does not accept a criterion whose supporting sub-task merely stopped', async () => {
    const registry = taskRegistry()
    const log = await planned(registry, { maxRunsB: 1 })
    // A verifies and supports `counts`; B supports `limits` but runs out of budget without verifying.
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    await openRun(log, CHILD_B, 'b1')
    await log.emit(failed(CHILD_B, 'b1', 'the limit check never ran'))

    const view = tree(registry, log)
    expect(view.criteria.map(entry => `${entry.criterionId}:${entry.satisfiedBy}`)).toEqual(['counts:null', 'limits:null'])
    expect(statusOf(view, CHILD_B)?.status).toBe('stopped')
    expect(view.complete).toBe(false)
  })

  it('lets the parent accept a criterion with its own verified run', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(assigned(PARENT))
    // The child supports `counts`; the parent independently judges both criteria.
    await log.emit(decompose(PARENT, [{ taskId: CHILD_A, dependsOn: [], supports: ['counts'], maxRuns: 1 }]))
    await log.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await log.emit(assigned(CHILD_A))
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    await openRun(log, PARENT, 'p1')
    await log.emit(judge(PARENT, 'p1', 'counts', UNIT_VERIFIER))
    await log.emit(judge(PARENT, 'p1', 'limits', INTEGRATION_VERIFIER))
    await log.emit(verified(PARENT, 'p1'))

    const view = tree(registry, log)
    expect(view.criteria.map(entry => `${entry.criterionId}:${entry.satisfiedBy}`)).toEqual(['counts:p1', 'limits:p1'])
    expect(view.complete).toBe(true)
  })

  it('is incomplete while any declared sub-task has not verified, even with every criterion accepted', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    await openRun(log, CHILD_B, 'b1')
    await log.emit(judge(CHILD_B, 'b1', 'part-b', INTEGRATION_VERIFIER))
    await log.emit(verified(CHILD_B, 'b1'))

    await openRun(log, PARENT, 'p1')
    await log.emit(judge(PARENT, 'p1', 'counts', UNIT_VERIFIER))
    await log.emit(judge(PARENT, 'p1', 'limits', INTEGRATION_VERIFIER))
    await log.emit(verified(PARENT, 'p1'))
    expect(tree(registry, log).complete).toBe(true)

    // The parent's acceptance does not remove the requirement that B also verifies.
    const partial = await planned(registry)
    await openRun(partial, CHILD_A, 'a1')
    await partial.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await partial.emit(verified(CHILD_A, 'a1'))
    await openRun(partial, PARENT, 'p1')
    await partial.emit(judge(PARENT, 'p1', 'counts', UNIT_VERIFIER))
    await partial.emit(judge(PARENT, 'p1', 'limits', INTEGRATION_VERIFIER))
    await partial.emit(verified(PARENT, 'p1'))
    expect(tree(registry, partial).complete).toBe(false)
  })
})

describe('what the tree refuses to answer', () => {
  it('returns nothing for a task that declared no plan', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    expect(projectTree(foldSubjects<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION))).toEqual([])
  })

  it('keeps a child that has not started out of the blocked list', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    const view = tree(registry, log)
    const childB = statusOf(view, CHILD_B)
    // B is ready, which is neither blocked nor started: a reader must not read "not failed" as "done".
    expect([view.blocked, childB?.status, childB?.lastOutcome]).toEqual([[], 'ready', null])
  })
})

/** CHILD_B's own contract is referenced so the fixture surface stays honest about both children. */
void CHILD_B_CONTRACT
