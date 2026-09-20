import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'

const text = (value: string) => [{ type: 'text' as const, text: value }]

export function defineApproveTool(ctx: Context) {
  return defineTool({
    name: 'hitl_approve',
    description: 'Request human approve/reject and wait. Use before irreversible or sensitive actions.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Approval request shown to the human' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      if (args.prompt.trim().length === 0) throw new Error('hitl_approve: prompt is empty')
      const agent = exec.agent
      if (agent === undefined) throw new Error('hitl_approve: missing agent')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'hitl_approve',
        callId: exec.callId,
        reason: args.prompt,
        signal: exec.signal,
      })
      // Only 'allowed-once' grants; every other native outcome fails closed to
      // a rejection, keeping the reason audible to the model.
      switch (outcome) {
        case 'allowed-once': return 'approve'
        case 'rejected': return 'reject'
        case 'cancelled': return 'reject (cancelled before the human decided)'
        case 'unavailable': return 'reject (no approval answerer available)'
      }
    },
  })
}
