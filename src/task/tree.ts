
import { refuse } from '../protocol/refusal.ts'
import type { AcceptanceCriterion } from './contract.ts'
import type { DecompositionChild } from './decomposition.ts'
import type { RunState, TaskState } from './protocol.ts'
import { openQuestions } from './questions.ts'

/** Direct responsibility edges have one parent and cannot point back to an ancestor. */
export function assertParentage(parentId: string, children: readonly DecompositionChild[], tasks: ReadonlyMap<string, TaskState>,
  otherPlans: readonly { readonly parentId: string; readonly children: readonly DecompositionChild[] }[] = [],
): void {
  const plans = [...tasks.values()].filter((task) => task.decomposition !== undefined)
    .map((task) => ({ parentId: task.taskId, children: task.decomposition!.children }))
  const parents = new Map([...plans, ...otherPlans].flatMap((plan) => plan.children.map((child) => [child.taskId, plan.parentId] as const)))
  for (const child of children) {
    const owner = parents.get(child.taskId)
    if (owner !== undefined && owner !== parentId)
      refuse('not-responsible', `Task ${child.taskId} already has a direct parent`)
    const seen = new Set<string>()
    let ancestor: string | undefined = parentId
    while (ancestor !== undefined) {
      if (ancestor === child.taskId || seen.has(ancestor))
        refuse('cyclic-dependency', 'delegation cannot point back to an ancestor responsibility')
      seen.add(ancestor)
      ancestor = parents.get(ancestor)
    }
  }
}

/** `stopped` means runtime failure or exhausted attempt budget. */
export type ChildStatus = 'missing' | 'blocked' | 'waiting' | 'ready' | 'running' | 'verified' | 'stopped' | 'cancelled'

/** What a sub-task's own runs have done, whether or not it was allowed to proceed. */
export type ChildOutcome = 'verified' | 'failed' | 'running' | null

export interface TreeChildView {
  readonly taskId: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly requirement: DecompositionChild['requirement']
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
  /** The parent's verified Run that accepted this criterion, or null. */
  readonly satisfiedBy: string | null
}

export interface TreeView {
  readonly parentTaskId: string
  readonly children: readonly TreeChildView[]
  readonly criteria: readonly TreeCriterionView[]
  readonly ready: readonly string[]
  readonly blocked: readonly { readonly taskId: string; readonly reason: string }[]
  /** Every criterion independently accepted after delegated work settled. */
  readonly complete: boolean
}

export const childSettled = (child: TreeChildView): boolean =>
  child.status === 'verified' || child.status === 'stopped' || child.status === 'blocked' || child.status === 'cancelled'

/** One hold, shared by the command boundary and native execution admission. */
export function taskWaitingReason(tasks: ReadonlyMap<string, TaskState>, taskId: string, action: 'plan' | 'execute' = 'execute'): string | undefined {
  const task = tasks.get(taskId)!
  const stopped = stoppedExplorationOf(tasks, taskId)
  if (stopped !== undefined) return `exploration ${stopped.taskId} was stopped by parent ${stopped.parentTaskId}: ${stopped.reason}`
  const run = Object.values(task.runs).at(-1)
  const questions = run === undefined ? [] : openQuestions(task, run.runId).filter((q) => q.blocking)
  if (questions.length)
    return `waiting for parent answers: ${questions.map((q) => q.questionId).join(', ')}; read or coordinate, then end the turn`
  if (action === 'execute' && task.decomposition !== undefined) {
    const children = projectOne(task, tasks).children
    if (!children.every(childSettled))
      return 'delegated responsibilities are pending; read evidence, answer children, or stop unselected exploration, then end the turn'
    const unmet = children.filter(child => child.requirement === 'required' && child.status !== 'verified')
    if (unmet.length) return `required delegated responsibilities have not verified: ${unmet.map(child => child.taskId).join(', ')}`
  }
  if (task.rounds?.some((request) => request.status === 'pending'))
    return 'waiting for the committed evaluation outcome; read or coordinate, then end the turn'
  return undefined
}

function runsOf(state: TaskState | undefined): readonly RunState[] {
  return state === undefined ? [] : Object.values(state.runs)
}

function outcomeOf(runs: readonly RunState[]): ChildOutcome {
  if (runs.some((run) => run.status === 'running')) return 'running'
  if (runs.some((run) => run.status === 'verified')) return 'verified'
  if (runs.some((run) => run.status === 'failed')) return 'failed'
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
    .filter((state) => state.decomposition !== undefined)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0))
    .map((parent) => projectOne(parent, tasks))
}

function projectOne(parent: TaskState, tasks: ReadonlyMap<string, TaskState>): TreeView {
  const decomposition = parent.decomposition
  const contract = parent.contract
  if (decomposition === undefined || contract === undefined)
    refuse(
      'illegal-transition',
      `task "${parent.taskId}" has a decomposition it cannot have: the protocol records a plan only after a contract, so this state is not one the protocol can produce`,
    )

  return projectPlan(parent.taskId, contract.criteria, decomposition.children, tasks, runsOf(parent))
}

export function projectPlan(
  parentId: string,
  standards: readonly AcceptanceCriterion[],
  entries: readonly DecompositionChild[],
  tasks: ReadonlyMap<string, TaskState>,
  parentRuns: readonly RunState[] = [],
): TreeView {
  const childOf = new Map(entries.map((entry) => [entry.taskId, entry]))
  const computed = new Map<string, TreeChildView>()

  /** Decide one sub-task. Recursion terminates because the reducer refuses a cyclic plan. */
  const statusOf = (taskId: string, stack: readonly string[]): TreeChildView => {
    const settled = computed.get(taskId)
    if (settled !== undefined) return settled
    const entry = childOf.get(taskId)
    if (entry === undefined)
      refuse('unknown-criterion', `"${taskId}" is not a sub-task this decomposition declares, so it has no state to decide`,
      )
    if (stack.includes(taskId))
      refuse('cyclic-dependency', `the decomposition of "${parentId}" reaches "${taskId}" twice: ${[...stack, taskId].join(' -> ')}`,
      )

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
      requirement: entry.requirement,
      runsUsed,
      lastOutcome: outcomeOf(runs),
    }

    const stopped = stoppedExplorationOf(tasks, entry.taskId)
    if (stopped !== undefined)
      return { ...shape, status: 'cancelled', reason: `stopped by parent ${stopped.parentTaskId}: ${stopped.reason}` }

    // An unadmitted child cannot run.
    if (childState === undefined || childState.contract === undefined)
      return { ...shape, status: 'missing', reason: `sub-task "${entry.taskId}" is declared but has no admitted contract, so it cannot be started`,
      }

    const dependencies = entry.dependsOn.map((dependency) => ({ dependency, view: statusOf(dependency, [...stack, entry.taskId]),
    }))
    const dead = dependencies.filter(({ view }) => view.status === 'missing' || view.status === 'blocked' || view.status === 'stopped' || view.status === 'cancelled',
    )
    if (dead.length > 0)
      return {
        ...shape,
        status: 'blocked',
        reason: `dependency ${dead
          .map(({ dependency, view }) => `"${dependency}" is ${view.status}`)
          .join(', ')}; only a verified dependency satisfies this sub-task`,
      }
    if (runs.length === 0 && parentRuns.at(-1)?.status === 'failed' && parentRuns.at(-1)?.failureCause === 'runtime')
      return { ...shape, status: 'stopped', reason: 'parent Run settled before this responsibility started' }
    const pending = dependencies.filter(({ view }) => view.status !== 'verified')
    if (pending.length > 0)
      return { ...shape, status: 'waiting', reason: `waiting for ${pending.map(({ dependency, view }) => `"${dependency}" (${view.status})`).join(', ')} to verify`,
      }

    if (runs.some((run) => run.status === 'verified')) return { ...shape, status: 'verified', reason: null }
    if (runs.some((run) => run.status === 'running')) return { ...shape, status: 'running', reason: null }
    const uncertain = runs.find((run) => run.evidence.some((entry) => entry.verdict === 'unknown'))
    if (uncertain !== undefined) return { ...shape, status: 'blocked', reason: 'verification evidence is insufficient' }
    const interrupted = runs.find((run) => run.failureCause === 'runtime')
    if (interrupted !== undefined)
      return { ...shape, status: 'stopped', reason: `runtime failure in Run "${interrupted.runId}"${interrupted.failureReason === undefined ? '' : ': ' + interrupted.failureReason}`,
      }
    if (runsUsed >= entry.maxRuns)
      return {
        ...shape,
        status: 'stopped',
        reason:
          `budget exhausted: ${runsUsed} of ${entry.maxRuns} declared runs used without a verified run` +
          (runs.some((run) => run.status === 'failed') ? ', and the last attempt failed' : ''),
      }
    if (runsUsed > 0)
      return { ...shape, status: 'ready', reason: `the previous attempt ${shape.lastOutcome ?? 'ended'} and ${entry.maxRuns - runsUsed} of ${entry.maxRuns} runs remain`,
      }
    return { ...shape, status: 'ready', reason: null }
  }

  const children = entries.map((entry) => statusOf(entry.taskId, []))

  const criteria: TreeCriterionView[] = standards.map((criterion) => {
    const supportedBy = children
      .filter((child) => child.supports.includes(criterion.criterionId)).map((child) => child.taskId)
    const byOwnRun = parentRuns.find(
      (run) => run.status === 'verified' && run.evidence.some((entry) => entry.criterionId === criterion.criterionId && entry.verdict === 'pass'),
    )
    return {
      criterionId: criterion.criterionId,
      supportedBy,
      satisfiedBy: byOwnRun?.runId ?? null,
    }
  })

  return {
    parentTaskId: parentId,
    children,
    criteria,
    ready: children.filter((child) => child.status === 'ready').map((child) => child.taskId),
    blocked: children
      .filter((child) => child.reason !== null)
      .map((child) => ({ taskId: child.taskId, reason: child.reason as string })),
    complete: criteria.every((criterion) => criterion.satisfiedBy !== null) && children.every(childSettled) &&
      children.every(child => child.requirement !== 'required' || child.status === 'verified'),
  }
}

/** A persisted stop covers the selected branch and every delegated descendant. */
export function stoppedExplorationOf(tasks: ReadonlyMap<string, TaskState>, taskId: string):
  { readonly parentTaskId: string; readonly taskId: string; readonly reason: string; readonly seq: number } | undefined {
  let current = taskId
  for (;;) {
    const parent = [...tasks.values()].find(task => task.decomposition?.children.some(child => child.taskId === current))
    if (parent === undefined) return undefined
    const stopped = parent.decomposition!.stopped?.find(entry => entry.taskId === current)
    if (stopped !== undefined) return { parentTaskId: parent.taskId, ...stopped }
    current = parent.taskId
  }
}

/** Read-only relationships for one committed cut; never persisted as another graph. */
export function taskRelations(tasks: ReadonlyMap<string, TaskState>) {
  const parents = new Map<string, string>()
  const consumers = new Map<string, string[]>()
  for (const task of tasks.values()) {
    for (const child of task.decomposition?.children ?? []) parents.set(child.taskId, task.taskId)
    for (const input of task.contract?.inputs ?? []) if (input.source.kind === 'artifact') {
      const ids = consumers.get(input.source.taskId) ?? []
      if (!ids.includes(task.taskId)) ids.push(task.taskId)
      consumers.set(input.source.taskId, ids)
    }
  }
  const ancestors = (id: string): string[] => {
    const path: string[] = []
    for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) path.push(parent)
    return path
  }
  const rootOf = (id: string): string => ancestors(id).at(-1) ?? id
  return { parents, consumers, ancestors, rootOf }
}
