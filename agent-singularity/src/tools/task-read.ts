import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-context'
import { adaptRead, callerSessionId } from './projected-read.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

export function defineTaskReadTool(ctx: Context) {
  return defineTool({
    name: 'task_read',
    description:
      'Read the caller\'s task contract. The root session sees the root task, its acceptance criteria, and child task statuses — or, before any root contract has ' +
      'been accepted, the named not-activated state together with whatever proposal is still open (the graph\'s name is never shown as an objective). A worker sees its own task and run. ' +
      'A reviewer sees the task it was delegated to review, marked review-only. A run line carries the coordination phase this run is in — and the id of the batch ' +
      'it is still waiting on, its submission and any no-progress marking when it has them; a run that returned to active waits on no batch, though its record ' +
      'keeps every batch it ended. A run with no phase is an old record and is shown as needs-recovery. ' +
      'This is the same read the worker\'s assembled context is projected from, so the two cannot disagree.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const caller = callerSessionId(exec, 'task_read')
      return adaptRead('task_read', await ctx.singularityContext.taskRead(caller, exec.signal))
    },
  })
}
