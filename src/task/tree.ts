/**
 * The decomposition tree: readiness, named blockers, and how sub-tasks support the parent.
 *
 * This is a **whole-log** read, which the task protocol did not have before. It exists because the
 * questions it answers are cross-subject by nature: whether a sub-task exists, whether what it
 * depends on has verified, and whether the parent's criteria are actually accepted by anything.
 * Those cannot be decided by a per-subject reducer, and copying the answers onto the parent subject
 * would record the same fact twice.
 *
 * Two rules carry the weight:
 *
 * 1. **Only `verified` satisfies a dependency.** A dependency that ended any other way leaves its
 *    dependents blocked, named, and never started — the behaviour the frozen repo got right
 *    (`child.ts:576-582,658-663`) and the one thing about its coordination worth copying.
 * 2. **A parent is never complete because its children ended.** Completion is *derived*: every
 *    criterion of the parent's own contract must be accepted, either by a verified sub-task that
 *    declared it supports that criterion, or by the parent's own verified run. Nothing is
 *    persisted, so there is no completion fact that could be declared early.
 *
 * The projection is for reading and diagnosis. Enforcement of the same conditions happens at the
 * serial command boundary, which is the only place a check can stop work from starting.
 *
 * @module singularity-core/task/tree
 */

import { refuse } from '../protocol/refusal.ts'
import type { DecompositionChild } from './decomposition.ts'
import type { RunState, TaskState } from './protocol.ts'

/** What a scheduler should do about one sub-task. `stopped` means its declared budget is spent. */
export type ChildStatus = 'missing' | 'blocked' | 'waiting' | 'ready' | 'running' | 'verified' | 'stopped'

/** What a sub-task's own runs have done, whether or not it was allowed to proceed. */
export type ChildOutcome = 'verified' | 'failed' | 'running' | null

export interface TreeChildView {
  readonly taskId: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly runsUsed: number
  readonly status: ChildStatus
  readonly lastOutcome: ChildOutcome
  /** Why this sub-task is not `ready`, `running` or `verified`; null when it is. */
  readonly reason: string | null
}

export interface TreeCriterionView {
  readonly criterionId: string
  /** Sub-tasks that declared they support this criterion, in declaration order. */
  readonly supportedBy: readonly string[]
  /** The verified sub-task that accepted it, `own-run`, or null while nothing has. */
  readonly satisfiedBy: string | null
}

export interface TreeView {
  readonly parentTaskId: string
  readonly children: readonly TreeChildView[]
  readonly criteria: readonly TreeCriterionView[]
  readonly ready: readonly string[]
  readonly blocked: readonly { readonly taskId: string; readonly reason: string }[]
  /** Every criterion accepted **and** every declared sub-task verified. Never declared, always derived. */
  readonly complete: boolean
}

function runsOf(state: TaskState | undefined): readonly RunState[] {
  return state === undefined ? [] : Object.values(state.runs)
}

function outcomeOf(runs: readonly RunState[]): ChildOutcome {
  if (runs.some(run => run.status === 'running')) return 'running'
  if (runs.some(run => run.status === 'verified')) return 'verified'
  if (runs.some(run => run.status === 'failed')) return 'failed'
  return null
}

/**
 * Every task that declared a decomposition, as a tree, in a deterministic order.
 *
 * A task without a decomposition is not in the result: `projectTask` is its read, and returning an
 * empty tree for it would invite a reader to think a plan existed and was empty.
 */
export function projectTree(tasks: ReadonlyMap<string, TaskState>): readonly TreeView[] {
  return [...tasks.values()]
    .filter(state => state.decomposition !== undefined)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0))
    .map(parent => projectOne(parent, tasks))
}

function projectOne(parent: TaskState, tasks: ReadonlyMap<string, TaskState>): TreeView {
  const decomposition = parent.decomposition
  const contract = parent.contract
  if (decomposition === undefined || contract === undefined)
    refuse(
      'illegal-transition',
      `task "${parent.taskId}" has a decomposition it cannot have: the protocol records a plan only after a contract, so this state is not one the protocol can produce`,
    )

  const childOf = new Map(decomposition.children.map(entry => [entry.taskId, entry]))
  const computed = new Map<string, TreeChildView>()

  /** Decide one sub-task. Recursion terminates because the reducer refuses a cyclic plan. */
  const statusOf = (taskId: string, stack: readonly string[]): TreeChildView => {
    const settled = computed.get(taskId)
    if (settled !== undefined) return settled
    const entry = childOf.get(taskId)
    if (entry === undefined)
      refuse('unknown-criterion', `"${taskId}" is not a sub-task this decomposition declares, so it has no state to decide`)
    if (stack.includes(taskId))
      refuse('cyclic-dependency', `the decomposition of "${parent.taskId}" reaches "${taskId}" twice: ${[...stack, taskId].join(' -> ')}`)

    const childState = tasks.get(taskId)
    const runs = runsOf(childState)
    const runsUsed = runs.length
    const view = decide(entry, childState, runs, runsUsed, stack)
    computed.set(taskId, view)
    return view
  }

  const decide = (
    entry: DecompositionChild,
    childState: TaskState | undefined,
    runs: readonly RunState[],
    runsUsed: number,
    stack: readonly string[],
  ): TreeChildView => {
    const shape = {
      taskId: entry.taskId,
      dependsOn: entry.dependsOn,
      supports: entry.supports,
      maxRuns: entry.maxRuns,
      runsUsed,
      lastOutcome: outcomeOf(runs),
    }

    // A sub-task that is not an admitted task accepts nothing, whoever declared it.
    if (childState === undefined || childState.contract === undefined)
      return { ...shape, status: 'missing', reason: `sub-task "${entry.taskId}" is declared but has no admitted contract, so it cannot be started` }

    const dependencies = entry.dependsOn.map(dependency => ({ dependency, view: statusOf(dependency, [...stack, entry.taskId]) }))
    const dead = dependencies.filter(({ view }) => view.status === 'missing' || view.status === 'blocked' || view.status === 'stopped')
    if (dead.length > 0)
      return {
        ...shape,
        status: 'blocked',
        reason: `dependency ${dead
          .map(({ dependency, view }) => `"${dependency}" is ${view.status}`)
          .join(', ')}; only a verified dependency satisfies this sub-task`,
      }
    const pending = dependencies.filter(({ view }) => view.status !== 'verified')
    if (pending.length > 0)
      return { ...shape, status: 'waiting', reason: `waiting for ${pending.map(({ dependency, view }) => `"${dependency}" (${view.status})`).join(', ')} to verify` }

    if (runs.some(run => run.status === 'verified')) return { ...shape, status: 'verified', reason: null }
    if (runs.some(run => run.status === 'running')) return { ...shape, status: 'running', reason: null }
    if (runsUsed >= entry.maxRuns)
      return {
        ...shape,
        status: 'stopped',
        reason:
          `budget exhausted: ${runsUsed} of ${entry.maxRuns} declared runs used without a verified run` +
          (runs.some(run => run.status === 'failed') ? ', and the last attempt failed' : ''),
      }
    if (runsUsed > 0)
      return { ...shape, status: 'ready', reason: `the previous attempt ${shape.lastOutcome ?? 'ended'} and ${entry.maxRuns - runsUsed} of ${entry.maxRuns} runs remain` }
    return { ...shape, status: 'ready', reason: null }
  }

  const children = decomposition.children.map(entry => statusOf(entry.taskId, []))

  const parentRuns = runsOf(parent)
  const criteria: TreeCriterionView[] = contract.criteria.map(criterion => {
    const supportedBy = children.filter(child => child.supports.includes(criterion.criterionId)).map(child => child.taskId)
    const byChild = supportedBy.find(taskId => children.find(child => child.taskId === taskId)?.status === 'verified')
    const byOwnRun = parentRuns.some(
      run => run.status === 'verified' && run.evidence.some(entry => entry.criterionId === criterion.criterionId && entry.verdict === 'pass'),
    )
    return {
      criterionId: criterion.criterionId,
      supportedBy,
      satisfiedBy: byChild ?? (byOwnRun ? 'own-run' : null),
    }
  })

  return {
    parentTaskId: parent.taskId,
    children,
    criteria,
    ready: children.filter(child => child.status === 'ready').map(child => child.taskId),
    blocked: children
      .filter(child => child.reason !== null)
      .map(child => ({ taskId: child.taskId, reason: child.reason as string })),
    complete: criteria.every(criterion => criterion.satisfiedBy !== null) && children.every(child => child.status === 'verified'),
  }
}
