import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { ProposalContinuation } from '@dangosys/dsh-singularity-task-runtime'
import { undeclaredParameters } from './proposal-parameters.ts'
import { proposalStoreFor } from './root-store.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_proposal_continue: missing agent id')
  return id
}

/**
 * What one continuation settled, in the terms the caller acts on. A waiting
 * proposal is **not** an error and this text says so: the batch stays exactly
 * where it is, no child was created and nothing was spawned, and the caller
 * keeps working (or ends its turn) rather than asking again — a repeat of the
 * same request is answered by the same proposal.
 *
 * A root contract continued here is reported as what it is (A0 §2): the runtime
 * created the root task and its run, so the ids are named rather than folded
 * into the batch vocabulary. Nothing about a batch was admitted, and saying so
 * is the point — a reader that took this arm for an admission would go looking
 * for children that do not exist.
 */
function renderContinuation(continuation: ProposalContinuation): string {
  if (continuation.status === 'admitted') {
    return [
      `proposal ${continuation.proposalId} was admitted as batch ${continuation.batchId}:`,
      ...continuation.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
      '',
      'The runtime owns the batch now: it starts the children one at a time in dependency order and settles this task when they',
      'are all terminal. This call returns at admission and does not wait for the batch.',
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
      const caller = sessionId(exec)
      let continuation: ProposalContinuation
      try {
        const storeId = await proposalStoreFor(ctx, caller)
        continuation = await ctx.taskRuntime.continueProposal(storeId, args.proposalId, caller, {
          // The registration id of this call, so the batch's drain does not wait
          // for the call that is asking (A3 §3.3). A caller without one — a test
          // double — drains without the exclusion.
          ...(typeof exec.callId === 'string' && exec.callId.length > 0 ? { exec: { callId: String(exec.callId) } } : {}),
        })
      } catch (error) {
        return `task_proposal_continue rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      return renderContinuation(continuation)
    },
  })
}
