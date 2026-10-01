import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'

export function defineTaskProposalCancelTool(ctx: Context) {
  return defineTool({
    name: 'task_proposal_cancel',
    description:
      'Withdraw a decomposition proposal this session submitted, before its batch is admitted: the proposal is recorded as cancelled ' +
      'and its record is kept. Only the session that proposed the batch may withdraw it — a withdrawal by anybody else is a decision, ' +
      'and is recorded as one by the review channel, not by this call. Cancelling admits nothing and spawns nothing; a batch that is ' +
      'already admitted is not affected (end it with task_cancel instead).',
    parameters: {
      proposalId: {
        type: 'string',
        required: true,
        description: 'The proposal id a previous task_decompose (or task_proposal_read) reported; an unknown id is refused',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, ['proposalId'], 'task_proposal_cancel')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'task_proposal_cancel')
      const { storeId } = await ctx.taskRuntime.runForSession(caller)
      try {
        // The service decides who may withdraw what: a session that did not
        // propose this batch is refused there, by name, and nothing is written.
        const result = await ctx.taskRuntime.cancelProposal(storeId, args.proposalId, caller)
        return [
          `${result.detail}`,
          'The record is kept: a cancelled proposal is a fact, and a revision is a new proposal with its own request key.',
        ].join('\n')
      } catch (error) {
        return `task_proposal_cancel rejected: ${message(error)}`
      }
    },
  })
}
