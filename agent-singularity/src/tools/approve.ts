import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { approvalAnswer, text } from '../shared.ts'

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
      return approvalAnswer(outcome)
    },
  })
}
