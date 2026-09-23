import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { TaskProposal } from '@dangosys/dsh-singularity-task'
import { renderProposalChildren } from '../proposal-review.ts'
import { undeclaredParameters } from './proposal-parameters.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_proposal_read: missing agent id')
  return id
}

/** The decision on record, as a reader has to see it: what was decided, by whom, when, and why when a reason was given. */
function decisionLines(proposal: TaskProposal): string[] {
  const decision = proposal.decision
  if (decision === undefined) {
    return [proposal.status === 'pending_review'
      ? 'decision: none yet — the batch waits for one, and only a recorded decision moves it'
      : 'decision: none recorded']
  }
  return [
    `decision: ${decision.outcome} by ${decision.decidedBy} at ${decision.decidedAt}`,
    ...(decision.reason === undefined ? [] : [`decision reason: ${decision.reason}`]),
    `decision bound digest ${decision.proposalDigest} and admission context ${decision.admissionContextDigest}`,
  ]
}

/** What the batch became, once it became one — the ids a retry must not mint again (§6). */
function consumptionLines(proposal: TaskProposal): string[] {
  const consumption = proposal.consumption
  if (consumption === undefined) return []
  return [
    `consumed as batch ${consumption.batchId} at ${consumption.admittedAt}:`,
    ...consumption.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
  ]
}

/**
 * One saved proposal, as the record holds it — the whole batch, not a summary,
 * and nothing that is not on the record. There is no argument for a status: the
 * answer is the store's.
 */
export function renderProposal(proposal: TaskProposal): string {
  return [
    `proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
    `submitted ${proposal.createdAt}${proposal.updatedAt === undefined ? '' : `, last moved ${proposal.updatedAt}`}`,
    `parent task ${proposal.identity.parentTaskId} run ${proposal.identity.parentRunId} (session ${proposal.identity.callerSessionId})`,
    `reason: ${proposal.identity.reason}`,
    `request key: ${proposal.requestKey}${proposal.supersedes === undefined ? '' : `; supersedes ${proposal.supersedes}`}`,
    '',
    `batch digest (sha256): ${proposal.proposalDigest}`,
    `admission context digest: ${proposal.admissionContextDigest} (maxDepth ${proposal.admissionContext.maxDepth}, maxChildren ${proposal.admissionContext.maxChildren}${proposal.admissionContext.wallTimeMs === undefined ? '' : `, wallTimeMs ${proposal.admissionContext.wallTimeMs}`})`,
    `review context digest: ${proposal.reviewContextDigest} (capability manifest digest ${proposal.reviewContext.capabilityManifestDigest}; judging verifiers ${proposal.reviewContext.verifiers.map(verifier => verifier.verifierId).join(', ') || 'none pinned'})`,
    '',
    ...decisionLines(proposal),
    ...consumptionLines(proposal),
    '',
    `children (${proposal.batch.length}):`,
    ...renderProposalChildren(proposal),
    'The record is immutable: a revision is a new proposal with a new id and a new request key, and only a decision on this',
    'record (written by the approval channel, never by a caller) can move it.',
  ].join('\n')
}

export function defineTaskProposalReadTool(ctx: Context) {
  return defineTool({
    name: 'task_proposal_read',
    description:
      'Read one decomposition proposal by id: where it stands, the policy it was born under, the complete batch it carries — every ' +
      'child\'s objective, criteria, assumptions, constraints, dependencies and capability requirements — the digest, both context ' +
      'fingerprints, the decision on record and the batch it became, if it became one. Read-only, and the answer is always the ' +
      'stored record: there is no argument here that can claim a status or an approval.',
    parameters: {
      proposalId: {
        type: 'string',
        required: true,
        description: 'The proposal id a previous task_decompose answered with (or that task_proposal_continue reported); an unknown id is refused',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, ['proposalId'], 'task_proposal_read')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec)
      const { storeId } = await ctx.taskRuntime.runForSession(caller)
      try {
        return renderProposal(await ctx.taskRuntime.proposalIn(storeId, args.proposalId))
      } catch (error) {
        return `task_proposal_read rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
