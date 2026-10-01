import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-context'
import { adaptRead, sessionId, text } from '../shared.ts'

export function defineTaskStatusTool(ctx: Context) {
  return defineTool({
    name: 'task_status',
    description:
      'The caller\'s project status, paged. Scope `related` (the default) covers the caller\'s own task, its direct children and the tasks directly ' +
      'adjacent to it through a dependency edge; scope `graph` is the whole domain overview, sorted by task id. Each line carries the task status, ' +
      'its latest run with its coordination phase (a phase-less non-terminal run reads needs-recovery), evidence ids, the terminal review outcome and ' +
      'the diagnosis count. Entries are sorted by task id and paged with `offset` (from 0) and `limit` (default 20, at most 100); the answer states ' +
      'whether more entries follow and the offset to continue with. Pages are observations, not a consistent snapshot across calls. Before any root ' +
      'contract has been accepted the answer is the named not-activated state (with whatever proposal is still open).',
    parameters: {
      scope: {
        type: 'string',
        enum: ['related', 'graph'],
        description: 'related (default): the caller\'s own task, its direct children and its direct dependency neighbours; graph: every task in the domain',
      },
      offset: { type: 'number', description: 'Entry offset to start the page at, from 0; default 0' },
      limit: { type: 'number', description: 'Entries per page; default 20, clamped into 1–100 (a clamp is stated in the answer)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'task_status')
      return adaptRead(
        'task_status',
        await ctx.singularityContext.taskStatus(caller, {
          ...(args.scope === undefined ? {} : { scope: args.scope as 'related' | 'graph' }),
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        }, exec.signal),
      )
    },
  })
}
