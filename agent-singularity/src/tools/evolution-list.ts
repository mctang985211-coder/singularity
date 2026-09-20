import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { mutationMechanical } from '../evolution.ts'
import type { ProposalTargetType } from '../evolution.ts'

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
      'each with its derived history (proposed → candidate → prepared → replayed → gated → decided → applied → ' +
      'rolledback for applied mechanical mutations; a mutation-less candidate gates directly). The ledger records ' +
      'proposals, sandbox materializations, human decisions, and human-approved applies/rollbacks.',
    parameters: {
      status: { type: 'string', enum: ['proposed', 'candidate', 'prepared', 'replayed', 'gated', 'decided', 'applied', 'rolledback'], description: 'Only proposals in this status' },
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
          const kind = mutationMechanical(proposal.targetType) ? 'mechanical' : 'bookkeeping-only (mechanical: false)'
          lines.push(`  mutation: ${kind} ${proposal.targetType} mutation`)
        }
        if (proposal.prepared !== undefined) {
          const view = proposal.prepared
          if (view.sandbox === null) {
            lines.push('  prepared: bookkeeping only, nothing materialized')
          } else {
            const championText = view.champion === 'captured' ? 'champion snapshot captured' : 'champion: null'
            lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox} (${view.files.length} files, ${championText})`)
          }
        }
        if (proposal.replayed !== undefined) {
          const view = proposal.replayed
          const summary = view.tasks.map(item => `${item.taskId}${item.holdout ? ' (holdout)' : ''}: ${item.relation}`).join(', ')
          lines.push(`  replayed: verdict ${view.verdict} — report ${view.report}${summary === '' ? '' : ` (${summary})`}`)
        }
        if (proposal.gate !== undefined) {
          lines.push(`  gate regression evidence: [${proposal.gate.regressionEvidenceRefs.join(', ')}]`)
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
