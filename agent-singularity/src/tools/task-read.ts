import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_read: missing agent id')
  return id
}

function latestRun(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.runs.find(run => run.runId === runId)
}

export function defineTaskReadTool(ctx: Context) {
  return defineTool({
    name: 'task_read',
    description:
      'Read the caller\'s task contract. The root session sees the root task, its acceptance criteria, and child task statuses; a worker sees its own task and run.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const caller = sessionId(exec)
      const graph = await ctx.graphs.graphForSession(caller)
      if (graph.rootSessionId !== caller) {
        const { task, run } = await ctx.taskRuntime.runForSession(caller)
        const lines = [
          `task ${task.taskId} [${task.status}] depth ${task.depth}`,
          `objective: ${task.objective}`,
          'acceptance criteria:',
          ...task.acceptanceCriteria.map(criterion => {
            const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
            return `- ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ', mandatory' : ''}] ${criterion.description}${command}`
          }),
          `run ${run.runId} [${run.status}] started ${run.startedAt}`,
        ]
        return lines.join('\n')
      }

      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot = await ctx.task.openStore(storeId)
      const root = snapshot.tasks.find(task => task.depth === 0)
      if (root === undefined) throw new Error(`task_read: store "${storeId}" has no root task`)
      const children = root.childTaskIds
        .map(taskId => snapshot.tasks.find(task => task.taskId === taskId))
        .filter(task => task !== undefined)
      const lines = [
        `root task ${root.taskId} [${root.status}/${root.decompositionStatus}]`,
        `objective: ${root.objective}`,
        'acceptance criteria:',
        ...root.acceptanceCriteria.map(criterion => `- ${criterion.criterionId} [${criterion.verificationMode}] ${criterion.description}`),
        `children: ${children.length}`,
        ...children.map(child => {
          const run = latestRun(snapshot, child)
          const runPart = run === undefined ? 'no run' : `run ${run.runId} [${run.status}]`
          return `- ${child.taskId} [${child.status}/${child.decompositionStatus}] ${runPart} ${child.objective}`
        }),
      ]
      return lines.join('\n')
    },
  })
}
