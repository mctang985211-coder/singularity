import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const TARGET_TYPES: readonly ProposalTargetType[] = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

export function defineEvolutionListTool(ctx: Context) {
  return defineTool({
    name: 'evolution_list',
    description:
      'Read-only. List EvolutionProposals in the evolution ledger, optionally filtered by status / targetType / targetId, ' +
      'each with its derived history (proposed → candidate → prepared → gated → decided → applied → rolledback for an ' +
      'applied single-file skill replacement; a non-skill proposal stays proposed — this build admits a skill candidate ' +
      'only). The ledger records proposals, sandbox materializations, human decisions, human-approved ' +
      'applies/rollbacks, and the commit intent behind each production write: a proposal whose commit was interrupted ' +
      'reports that intent — its id, direction, production target and when it was recorded — and stays in the status its ' +
      'lifecycle had reached, until a reconciliation or a retry of the apply/rollback settles it.',
    parameters: {
      status: { type: 'string', enum: ['proposed', 'candidate', 'prepared', 'gated', 'decided', 'applied', 'rolledback'], description: 'Only proposals in this status' },
      targetType: { type: 'string', enum: TARGET_TYPES, description: 'Only proposals pointing at this mutation surface' },
      targetId: { type: 'string', description: 'Only proposals pointing at this target' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async args => {
      const proposals = await ctx.evolution.list({
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.targetType === undefined ? {} : { targetType: args.targetType }),
        ...(args.targetId === undefined ? {} : { targetId: args.targetId }),
      })
      if (proposals.length === 0) return 'evolution ledger: no proposals match'
      const lines = [`evolution ledger (${proposals.length}):`]
      for (const proposal of proposals) {
        const decision = proposal.decision === undefined ? '' : ` ${proposal.decision}`
        lines.push(`- ${proposal.proposalId} [${proposal.status}${decision}] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`)
        lines.push(`  rationale: ${proposal.rationale}`)
        lines.push(`  sourceRefs: [${proposal.sourceRefs.join(', ')}]`)
        if (proposal.versionSet !== undefined) {
          lines.push(`  version set: ${Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(', ')}`)
        }
        if (proposal.mutation !== undefined) {
          lines.push(`  mutation: ${proposal.targetType} mutation recorded`)
        }
        if (proposal.prepared !== undefined) {
          const view = proposal.prepared
          // The fold admits only a materialized skill prepare with both identities.
          lines.push(
            `  sandbox: ${ctx.evolution.root}/${view.sandbox!} (${view.files.length} files, champion snapshot captured, ` +
            `candidate content ${view.skillContent!.name} sha256:${view.skillContent!.sha256.slice(0, 12)}…, ` +
            `production baseline ${view.skillBaseline!.name} sha256:${view.skillBaseline!.sha256.slice(0, 12)}…)`,
          )
        }
        if (proposal.gate !== undefined) {
          lines.push(`  gate regression evidence: [${proposal.gate.regressionEvidenceRefs.join(', ')}]`)
        }
        if (proposal.openIntent !== undefined) {
          const intent = proposal.openIntent
          lines.push(
            `  open commit intent: ${intent.intentId} (${intent.direction}) target ${intent.target} recorded ${intent.at} — ` +
            'a production write is underway and its completion has not been recorded; a reconciliation (a restart, or a retry of ' +
            'the apply/rollback) settles it before anything loads against that target',
          )
        }
        if (proposal.applied !== undefined) {
          lines.push(`  applied: [${proposal.applied.targets.join(', ')}] (approval ${proposal.applied.approvalRef})`)
        }
        if (proposal.rolledback !== undefined) {
          lines.push(`  rolled back: [${proposal.rolledback.targets.join(', ')}] (approval ${proposal.rolledback.approvalRef})`)
        }
        lines.push(`  history: ${proposal.history.map(entry => `${entry.status} by ${entry.actor} at ${entry.at}`).join(' → ')}`)
      }
      return lines.join('\n')
    },
  })
}
