import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_status: missing agent id')
  return id
}

export function defineTaskStatusTool(ctx: Context) {
  return defineTool({
    name: 'task_status',
    description: 'Compact snapshot of the caller\'s graph task tree: task id, objective, status, latest run status, and evidence ids.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const graph = await ctx.graphs.graphForSession(sessionId(exec))
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot = await ctx.task.openStore(storeId)
      const lines = snapshot.tasks.map(task => {
        const runId = task.runIds[task.runIds.length - 1]
        const run = snapshot.runs.find(item => item.runId === runId)
        const evidence = snapshot.evidence.filter(item => item.taskId === task.taskId).map(item => item.evidenceId)
        const runPart = run === undefined ? 'run: none' : `run: ${run.status}`
        const evidencePart = evidence.length === 0 ? '' : ` evidence: [${evidence.join(', ')}]`
        return `${'  '.repeat(task.depth)}${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart})`
      })
      return [`graph ${graph.id} task tree (${snapshot.tasks.length} tasks):`, ...lines].join('\n')
    },
  })
}
