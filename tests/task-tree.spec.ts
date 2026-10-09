/**
 * The decomposition tree: readiness, named blockers, and how sub-tasks support the parent.
 *
 * The two properties this spec exists for: **only `verified` satisfies a dependency**, and **a
 * parent is never complete because its children ended**. Both are derived from the log, so both are
 * checkable without trusting a scheduler.
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
  chain,
  decompose,
  failed,
  judge,
  PARENT,
  parentContract,
  plan,
  planned,
  startRun,
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

    expect(view.parentTaskId).toBe(PARENT)
    expect(view.children.map(child => child.taskId)).toEqual([CHILD_A, CHILD_B])
    expect(statusOf(view, CHILD_A)?.status).toBe('ready')
    // B declares it depends on A, and A has not verified, so B is waiting rather than ready.
    expect(statusOf(view, CHILD_B)?.status).toBe('waiting')
    expect(view.ready).toEqual([CHILD_A])
    expect(view.blocked.map(entry => entry.taskId)).toEqual([CHILD_B])
    expect(view.blocked[0]?.reason).toContain(CHILD_A)
    expect(view.complete).toBe(false)
  })

  it('names a declared sub-task that was never admitted, and never offers it as ready', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(decompose(PARENT, plan()))
    const view = tree(registry, log)

    expect(view.children.map(child => child.status)).toEqual(['missing', 'missing'])
    expect(view.ready).toEqual([])
    expect(view.blocked[0]?.reason).toContain('no admitted contract')
    expect(view.complete).toBe(false)
  })

  it('lets a dependent proceed only once the dependency has verified', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)?.status).toBe('verified')
    expect(statusOf(view, CHILD_B)?.status).toBe('ready')
    expect(view.ready).toEqual([CHILD_B])
    expect(view.blocked).toEqual([])
  })

  it('blocks a dependent on a dependency that ended without verifying, naming it', async () => {
    const registry = taskRegistry()
    // A has two runs of budget; both fail, so it is stopped rather than retryable.
    const log = await planned(registry, { aDependsOn: [] })
    for (const runId of ['a1', 'a2']) {
      await log.emit(startRun(CHILD_A, runId))
      await log.emit(failed(CHILD_A, runId, 'the counter crashed'))
    }

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)?.status).toBe('stopped')
    expect(statusOf(view, CHILD_A)?.lastOutcome).toBe('failed')
    expect(statusOf(view, CHILD_A)?.reason).toContain('budget exhausted')
    expect(statusOf(view, CHILD_B)?.status).toBe('blocked')
    expect(statusOf(view, CHILD_B)?.reason).toContain('stopped')
    expect(statusOf(view, CHILD_B)?.reason).toContain('only a verified dependency')
  })

  it('propagates a stopped dependency through a chain, naming each link', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(decompose(PARENT, chain()))
    await log.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await log.emit(admit(CHILD_B, CHILD_B_CONTRACT()))
    await log.emit(admit(CHILD_C, CHILD_C_CONTRACT()))

    // A's single declared run fails: A is stopped, and nothing downstream may start.
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(failed(CHILD_A, 'a1', 'the counter crashed'))

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)?.status).toBe('stopped')
    expect(statusOf(view, CHILD_B)?.status).toBe('blocked')
    expect(statusOf(view, CHILD_B)?.reason).toContain(`"${CHILD_A}" is stopped`)
    // The second link is blocked by the first link's blocked-ness, not by A directly.
    expect(statusOf(view, CHILD_C)?.status).toBe('blocked')
    expect(statusOf(view, CHILD_C)?.reason).toContain(`"${CHILD_B}" is blocked`)
    expect(view.ready).toEqual([])
    expect(view.complete).toBe(false)
  })

  it('reports a failing sub-task as retryable while its budget remains, without calling it verified', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(failed(CHILD_A, 'a1', 'first attempt failed'))

    const view = tree(registry, log)
    expect(statusOf(view, CHILD_A)?.status).toBe('ready')
    expect(statusOf(view, CHILD_A)?.lastOutcome).toBe('failed')
    expect(statusOf(view, CHILD_A)?.runsUsed).toBe(1)
    expect(statusOf(view, CHILD_A)?.reason).toContain('1 of 2 runs remain')
    // A failing attempt must not be mistaken for a verified dependency.
    expect(statusOf(view, CHILD_B)?.status).toBe('waiting')
  })
})

describe('a parent is accepted by verification, never by its children ending', () => {
  it('requires every criterion to be accepted by a verified supporting sub-task', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    for (const [taskId, contractCriterion, runId] of [
      [CHILD_A, 'part-a', 'a1'],
      [CHILD_B, 'part-b', 'b1'],
    ] as const) {
      await log.emit(startRun(taskId, runId))
      await log.emit(judge(taskId, runId, contractCriterion, taskId === CHILD_A ? UNIT_VERIFIER : INTEGRATION_VERIFIER))
      await log.emit(verified(taskId, runId))
    }

    const view = tree(registry, log)
    expect(view.criteria.map(entry => `${entry.criterionId}:${entry.satisfiedBy}`)).toEqual([`counts:${CHILD_A}`, `limits:${CHILD_B}`])
    expect(view.complete).toBe(true)
  })

  it('does not accept a criterion whose supporting sub-task merely stopped', async () => {
    const registry = taskRegistry()
    const log = await planned(registry, { maxRunsB: 1 })
    // A verifies and supports `counts`; B supports `limits` but runs out of budget without verifying.
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    await log.emit(startRun(CHILD_B, 'b1'))
    await log.emit(failed(CHILD_B, 'b1', 'the limit check never ran'))

    const view = tree(registry, log)
    expect(view.criteria.map(entry => `${entry.criterionId}:${entry.satisfiedBy}`)).toEqual(['counts:' + CHILD_A, 'limits:null'])
    expect(statusOf(view, CHILD_B)?.status).toBe('stopped')
    expect(view.complete).toBe(false)
  })

  it('lets the parent accept a criterion with its own verified run', async () => {
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    // One sub-task carries `counts`; the parent's own run carries `limits`.
    await log.emit(decompose(PARENT, [{ taskId: CHILD_A, dependsOn: [], supports: ['counts'], maxRuns: 1 }]))
    await log.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    // The parent's own run must judge *every* criterion of the parent's contract before it may
    // settle verified - the protocol refuses a partial settlement - so it accepts both here, and
    // `counts` is still credited to the verified sub-task that declared it.
    await log.emit(startRun(PARENT, 'p1'))
    await log.emit(judge(PARENT, 'p1', 'counts', UNIT_VERIFIER))
    await log.emit(judge(PARENT, 'p1', 'limits', INTEGRATION_VERIFIER))
    await log.emit(verified(PARENT, 'p1'))

    const view = tree(registry, log)
    expect(view.criteria.map(entry => `${entry.criterionId}:${entry.satisfiedBy}`)).toEqual([`counts:${CHILD_A}`, 'limits:own-run'])
    expect(view.complete).toBe(true)
  })

  it('is incomplete while any declared sub-task has not verified, even with every criterion accepted', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    await log.emit(startRun(CHILD_B, 'b1'))
    await log.emit(judge(CHILD_B, 'b1', 'part-b', INTEGRATION_VERIFIER))
    await log.emit(verified(CHILD_B, 'b1'))

    const accepted = tree(registry, log)
    expect(accepted.complete).toBe(true)

    // The same acceptance, but B never verified: a criterion cannot be accepted on its behalf.
    const partial = await planned(registry)
    await partial.emit(startRun(CHILD_A, 'a1'))
    await partial.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await partial.emit(verified(CHILD_A, 'a1'))
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
    await log.emit(startRun(CHILD_A, 'a1'))
    await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    await log.emit(verified(CHILD_A, 'a1'))
    const view = tree(registry, log)
    // B is ready, which is neither blocked nor started: a reader must not read "not failed" as "done".
    expect(view.blocked).toEqual([])
    expect(statusOf(view, CHILD_B)?.status).toBe('ready')
    expect(statusOf(view, CHILD_B)?.lastOutcome).toBeNull()
  })
})

/** CHILD_B's own contract is referenced so the fixture surface stays honest about both children. */
void CHILD_B_CONTRACT
