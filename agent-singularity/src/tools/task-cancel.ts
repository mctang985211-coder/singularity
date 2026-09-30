import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChildOutcome } from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_cancel: missing agent id')
  return id
}

function renderOutcome(outcome: ChildOutcome): string {
  const run = outcome.runId === undefined ? '' : ` run ${outcome.runId}`
  const evidence = outcome.evidenceId === undefined ? '' : ` evidence ${outcome.evidenceId}`
  return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`
}

export function defineTaskCancelTool(ctx: Context) {
  return defineTool({
    name: 'task_cancel',
    description:
      'Cancel your current run together with its in-flight child batch. The children still in flight are cancelled, the ones that never ' +
      'started are blocked before start, and this run is cancelled with them — a batch that cannot finish is ended here, never ' +
      'left hanging. Only the run whose own batch it is may cancel it, and only while the batch is in flight: a run that already ' +
      'got its execution back holds no batch to cancel, and a run with no batch open is told so and nothing changes. To end work ' +
      'that is not a batch of yours, remove the graph instead.',
    parameters: {
      reason: { type: 'string', description: 'Why the batch is being cancelled; the settlement answer echoes it back to you' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const { storeId, run } = await ctx.taskRuntime.runForSession(caller)
      if (run.executionPhase !== 'waiting_children' || run.batchId === undefined) {
        return (
          `task_cancel: no batch is in flight for run "${run.runId}" ` +
          `(${run.status}${run.executionPhase === undefined ? ', no coordination phase recorded' : `, phase ${run.executionPhase}`}); ` +
          'nothing was changed'
        )
      }
      const batchId = run.batchId
      let outcomes: ChildOutcome[]
      try {
        outcomes = await ctx.taskRuntime.cancelBatch(storeId, batchId, caller)
      } catch (error) {
        return `task_cancel rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      return [
        `cancelled batch ${batchId}${args.reason === undefined ? '' : ` (${args.reason})`}:`,
        ...outcomes.map(renderOutcome),
      ].join('\n')
    },
  })
}
