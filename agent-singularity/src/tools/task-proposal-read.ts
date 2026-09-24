import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { TaskProposal, TaskProposalDecomposition, TaskProposalRoot } from '@dangosys/dsh-singularity-task'
import { renderProposalChildren, renderRootContract } from '../proposal-review.ts'
import { undeclaredParameters } from './proposal-parameters.ts'
import { proposalStoreFor } from './proposal-store.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
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

/** What the batch or the root contract became, once it became one — the ids a retry must not mint again (§6). */
function consumptionLines(proposal: TaskProposal): string[] {
  const consumption = proposal.consumption
  if (consumption === undefined) return []
  // Two kinds, two vocabularies (A0 §2): a batch is consumed as `b-<parent>`
  // plus its children, a root contract as the one root task and run it became.
  // The record says which it is, so nothing here has to infer it.
  if (consumption.kind === 'root') {
    return [
      `consumed as root task ${consumption.rootTaskId} with run ${consumption.rootRunId} at ${consumption.admittedAt}:`,
      ...(consumption.reason === undefined ? [] : [`- ${consumption.reason}`]),
    ]
  }
  return [
    `consumed as batch ${consumption.batchId} at ${consumption.admittedAt}:`,
    ...consumption.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
  ]
}

/**
 * The payload digest and the two context fingerprints, as every reader of a
 * record needs them. `subject` names what the digest is of — a batch and a root
 * contract are both read through this tool, and calling a contract's digest a
 * batch digest would mislabel the number a decision binds.
 */
function digestLines(proposal: TaskProposal, subject: 'batch' | 'contract'): string[] {
  return [
    `${subject} digest (sha256): ${proposal.proposalDigest}`,
    `admission context digest: ${proposal.admissionContextDigest} (maxDepth ${proposal.admissionContext.maxDepth}, maxChildren ${proposal.admissionContext.maxChildren}${proposal.admissionContext.wallTimeMs === undefined ? '' : `, wallTimeMs ${proposal.admissionContext.wallTimeMs}`})`,
    `review context digest: ${proposal.reviewContextDigest} (capability manifest digest ${proposal.reviewContext.capabilityManifestDigest}; judging verifiers ${proposal.reviewContext.verifiers.map(verifier => verifier.verifierId).join(', ') || 'none pinned'})`,
  ]
}

/** The immutable-record footer every proposal is read under, whichever kind it is. */
const RECORD_NOTE = [
  'The record is immutable: a revision is a new proposal with a new id and a new request key, and only a decision on this',
  'record (written by the approval channel, never by a caller) can move it.',
].join('\n')

/** One saved decomposition proposal: its parent, its whole batch, the decision and what it became. */
function renderBatchProposal(proposal: TaskProposalDecomposition): string {
  return [
    `proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
    `submitted ${proposal.createdAt}${proposal.updatedAt === undefined ? '' : `, last moved ${proposal.updatedAt}`}`,
    `parent task ${proposal.identity.parentTaskId} run ${proposal.identity.parentRunId} (session ${proposal.identity.callerSessionId})`,
    `reason: ${proposal.identity.reason}`,
    `request key: ${proposal.requestKey}${proposal.supersedes === undefined ? '' : `; supersedes ${proposal.supersedes}`}`,
    '',
    ...digestLines(proposal, 'batch'),
    '',
    ...decisionLines(proposal),
    ...consumptionLines(proposal),
    '',
    `children (${proposal.batch.length}):`,
    ...renderProposalChildren(proposal),
    RECORD_NOTE,
  ].join('\n')
}

/**
 * One saved root contract proposal: the session it is the goal of, the contract
 * itself rather than a child batch — there is no parent task and no batch to
 * print — the decision and the root task it became.
 */
function renderRootProposal(proposal: TaskProposalRoot): string {
  return [
    `proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
    `submitted ${proposal.createdAt}${proposal.updatedAt === undefined ? '' : `, last moved ${proposal.updatedAt}`}`,
    `root session ${proposal.identity.rootSessionId} (store ${proposal.identity.storeId})`,
    `request key: ${proposal.requestKey}${proposal.supersedes === undefined ? '' : `; supersedes ${proposal.supersedes}`}`,
    '',
    ...digestLines(proposal, 'contract'),
    '',
    ...decisionLines(proposal),
    ...consumptionLines(proposal),
    '',
    'root contract:',
    ...renderRootContract(proposal.contract),
    RECORD_NOTE,
  ].join('\n')
}

/**
 * One saved proposal, as the record holds it — the whole batch, or the whole
 * root contract, not a summary, and nothing that is not on the record. There is
 * no argument for a status: the answer is the store's.
 */
export function renderProposal(proposal: TaskProposal): string {
  return proposal.kind === 'root' ? renderRootProposal(proposal) : renderBatchProposal(proposal)
}

export function defineTaskProposalReadTool(ctx: Context) {
  return defineTool({
    name: 'task_proposal_read',
    description:
      'Read one proposal by id: where it stands, the policy it was born under, and the subject it carries — every child of a ' +
      'decomposition batch (objective, criteria, assumptions, constraints, dependencies and capability requirements), or the single ' +
      'root contract a root session asked to be admitted as — plus the digest, both context fingerprints, the decision on record and ' +
      'what the proposal became, if it became something. Read-only, and the answer is always the stored record: there is no argument ' +
      'here that can claim a status or an approval. A root session reads the proposal holding its contract before its root exists — ' +
      'with no run bound to it, the reader falls back to the store the session owns.',
    parameters: {
      proposalId: {
        type: 'string',
        required: true,
        description: 'The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, ['proposalId'], 'task_proposal_read')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec)
      try {
        const storeId = await proposalStoreFor(ctx, caller)
        return renderProposal(await ctx.taskRuntime.proposalIn(storeId, args.proposalId))
      } catch (error) {
        return `task_proposal_read rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
