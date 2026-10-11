import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import type { Bubble } from '../../src/task/bubble.ts'
import type { TaskTemplateRef } from '../../src/task/contract.ts'
import { projectTree, type TreeChildView, type TreeCriterionView } from '../../src/task/tree.ts'
import { projectReceipt, projectTask, type ReceiptView } from '../../src/task/view.ts'
import type { Apparatus } from './apparatus.ts'
import type { PreparedInput } from './inputs.ts'

export interface ControlSnapshot {
  readonly formatVersion: 2
  readonly controlId: string
  readonly cutoff: number
  readonly tasks: readonly {
    readonly taskId: string
    readonly goal: string
    readonly phase: string
    readonly sessionId: string | null
    readonly template: TaskTemplateRef
    readonly runs: readonly {
      readonly runId: string; readonly status: string; readonly detail: string | null
      readonly model: Bubble['model'] | null
      readonly inputSources: readonly Pick<PreparedInput, 'name' | 'digest' | 'source'>[]
      readonly receipt: ReceiptView | null
    }[]
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
  const entries = committed.entries()
  const tasks: ControlSnapshot['tasks'][number][] = []
  for (const [taskId, state] of committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)) {
    if (state.contract === undefined) continue
    const view = projectTask(state)
    const agent = state.responsibility === undefined ? undefined : committed.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, state.responsibility.agentId)
    tasks.push({ taskId, goal: state.contract.goal, phase: view.phase,
      sessionId: agent?.sessionId ?? null, template: state.contract.template,
      runs: view.runs.map(run => {
        const execution = state.runs[run.runId]!
        const revision = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
        const { inputSources } = revision.manifest as { inputSources: ControlSnapshot['tasks'][number]['runs'][number]['inputSources'] }
        return { runId: run.runId, status: run.status, model: execution.bubble?.model ?? null, inputSources,
          detail: run.failureReason ?? run.verdicts.find(entry => entry.criterionId === state.contract!.criteria[0]!.criterionId)?.detail ?? null,
          receipt: run.status === 'running' ? null : projectReceipt(apparatus.registry, entries, taskId, run.runId) }
      }),
    })
  }
  const plans = projectTree(committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).map(view => ({
    parentTaskId: view.parentTaskId,
    complete: view.complete,
    children: view.children.map(({ lastOutcome: _, ...child }) => child),
    criteria: view.criteria.map(({ supportedBy: _, ...criterion }) => criterion),
  }))
  const ordered = tasks.sort((left, right) => left.taskId.localeCompare(right.taskId))
  return { formatVersion: 2, controlId: apparatus.controlId, cutoff: entries.length, tasks: ordered, plans }
}
