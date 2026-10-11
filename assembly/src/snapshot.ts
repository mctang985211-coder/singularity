import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { projectTree, type TreeChildView, type TreeCriterionView } from '../../src/task/tree.ts'
import { projectTask } from '../../src/task/view.ts'
import type { Apparatus } from './apparatus.ts'

export interface ControlSnapshot {
  readonly formatVersion: 1
  readonly controlId: string
  readonly cutoff: number
  readonly tasks: readonly {
    readonly taskId: string
    readonly goal: string
    readonly phase: string
    readonly runs: readonly { readonly runId: string; readonly status: string; readonly detail: string | null }[]
  }[]
  readonly plans: readonly {
    readonly parentTaskId: string
    readonly complete: boolean
    readonly children: readonly Omit<TreeChildView, 'lastOutcome'>[]
    readonly criteria: readonly Omit<TreeCriterionView, 'supportedBy'>[]
  }[]
}

export async function snapshotOf(apparatus: Apparatus): Promise<ControlSnapshot> {
  const committed = apparatus.store.load()
  const tasks: ControlSnapshot['tasks'][number][] = []
  for (const [taskId, state] of committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)) {
    if (state.contract === undefined) continue
    const view = projectTask(state)
    tasks.push({ taskId, goal: state.contract.goal, phase: view.phase,
      runs: view.runs.map(run => ({
        runId: run.runId,
        status: run.status,
        detail: run.failureReason ?? run.verdicts.find(entry => entry.criterionId === state.contract!.criteria[0]!.criterionId)?.detail ?? null,
      })),
    })
  }
  const plans = projectTree(committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).map(view => ({
    parentTaskId: view.parentTaskId,
    complete: view.complete,
    children: view.children.map(({ lastOutcome: _, ...child }) => child),
    criteria: view.criteria.map(({ supportedBy: _, ...criterion }) => criterion),
  }))
  const ordered = tasks.sort((left, right) => left.taskId.localeCompare(right.taskId))
  return { formatVersion: 1, controlId: apparatus.controlId, cutoff: committed.entries().length, tasks: ordered, plans }
}
