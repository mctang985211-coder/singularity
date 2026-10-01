import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { sessionId, text } from '../shared.ts'

export function defineMarkReadyTool(ctx: Context) {
  return defineTool({
    name: 'graph_mark_ready',
    description:
      'Mark the current Singularity graph ready after environment setup is complete. Required before free-form human chat.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec: ToolRunContext) => {
      const caller = sessionId(exec, 'graph_mark_ready')
      const graph = await ctx.graphs.graphForSession(caller)
      await ctx.graphs.markReady(graph.id)
      return `graph ${graph.id} ready`
    },
  })
}
