import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { ProposalContinuation } from '@dangosys/dsh-singularity-task-runtime'
import { message, proposalStoreFor, sessionId, text, undeclaredParameters } from '../shared.ts'

/** What one continuation settled, in the terms the caller acts on. A waiting proposal is **not** an error and this text says so: */
function renderContinuation(continuation: ProposalContinuation): string {
  if (continuation.status === 'admitted') {
    return [
      `proposal ${continuation.proposalId} was admitted as batch ${continuation.batchId}:`,
      ...continuation.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
      '',
      'The runtime owns the batch now: it starts the children one at a time in dependency order and drives the batch to its end.',
      'The batch end hands this task\'s execution back — nothing is submitted on its behalf — and this call returns at admission,',
      'so it does not wait for the batch.',
    ].join('\n')
  }
  if (continuation.status === 'activated') {
    return [
      `proposal ${continuation.proposalId} was activated as root task ${continuation.taskId} with run ${continuation.runId}:`,
      `- ${continuation.detail}`,
      '',
      'This is a root contract: the runtime created the root task and its root run and bound this session to them, so no batch',
      'was admitted and no child exists yet. `task_read` shows the contract now, and `task_decompose` works on the root task from',
      'here on.',
    ].join('\n')
  }
  const reason = continuation.reason === undefined ? '' : ` — ${continuation.reason}`
  return [
    `proposal ${continuation.proposalId} is ${continuation.status}: ${continuation.detail}${reason}`,
    '',
    ...(continuation.status === 'pending_review'
      ? [
        'Nothing was admitted and nothing is spawned while it waits: the review is the gate. Read the batch with',
        '`task_proposal_read` (or wait for the notification) — a decision on the record continues the batch automatically,',
        'and re-submitting the same content answers with this same proposal rather than building another one.',
      ]
      : [
        'A terminal proposal is never re-run: revise the batch and propose it again — a revision is new content, a new request',
        'key and a new proposal that names this one in `supersedes`.',
      ]),
  ].join('\n')
}

export function defineTaskProposalContinueTool(ctx: Context) {
  return defineTool({
    name: 'task_proposal_continue',
    description:
      'Continue a proposal this session submitted: re-check it against everything that was true when it was proposed ' +
      '(what it belongs to, the limits, the capability resolution, the judging verifiers) and act on it if it still passes and ' +
      'carries an approval — a decomposition batch is admitted, a root contract is activated as this session\'s root task and ' +
      'run. A proposal still waiting for its review is reported as waiting — that is not an error and nothing changes; a ' +
      'rejected, cancelled, stale or expired one is reported with the reason it will never run. Only the session that proposed ' +
      'it can continue it, and this call cannot approve anything: the approval is a decision the review channel records. A root ' +
      'session continues the contract it recorded before its root exists — with no run bound to it, the continuation falls back to ' +
      'the store the session owns, and a ready or approved contract is activated from there.',
    parameters: {
      proposalId: {
        type: 'string',
        required: true,
        description: 'The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, ['proposalId'], 'task_proposal_continue')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'task_proposal_continue')
      let continuation: ProposalContinuation
      try {
        const storeId = await proposalStoreFor(ctx, caller)
        continuation = await ctx.taskRuntime.continueProposal(storeId, args.proposalId, caller, {
          // The registration id of this call, so the batch's drain does not wait
          // for the call that is asking (A3 §3.3). A caller without one — a test
          ...(typeof exec.callId === 'string' && exec.callId.length > 0 ? { exec: { callId: String(exec.callId) } } : {}),
        })
      } catch (error) {
        return `task_proposal_continue rejected: ${message(error)}`
      }
      return renderContinuation(continuation)
    },
  })
}
