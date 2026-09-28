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
      'applied skill object or capability row, optionally with a new execution skill; other target types stay proposed). ' +
      'A skill object has `SKILL.md` plus `SKILL.contract.json` when it is an execution provider. The ledger records proposals, sandbox ' +
      'materializations, human decisions, human-approved ' +
      'applies/rollbacks, and the commit intent behind each production write: a proposal whose commit was interrupted ' +
      'reports that intent — its id, direction, every production file it commits and when it was recorded — and stays in ' +
      'the status its lifecycle had reached, until a reconciliation or a retry of the apply/rollback settles it.',
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
          if (proposal.targetType === 'capability') {
            const row = view.capabilityRow!
            const baseline = view.capabilityBaseline
            lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox!} (${view.files.length} files, capability row${view.skillContent === undefined ? '' : ' + new execution skill'})`)
            lines.push(`  candidate row: ${row.name} sha256:${row.digest.slice(0, 12)}…`)
            lines.push(`  production row baseline: ${baseline === null ? 'absent' : `${baseline!.name} sha256:${baseline!.digest.slice(0, 12)}…`}`)
            lines.push(view.skillContent === undefined
              ? '  no new skill object'
              : `  new execution skill: ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}… (SKILL.md + SKILL.contract.json)`)
            if (view.skillContent !== undefined) lines.push('  production skill baseline: absent')
          } else {
            const shape = view.skillContent!.contract === undefined
              ? 'guidance (SKILL.md)'
              : 'execution provider (SKILL.md + SKILL.contract.json)'
            lines.push(
              `  sandbox: ${ctx.evolution.root}/${view.sandbox!} (${view.files.length} files, ${shape}, champion snapshot captured, ` +
              `candidate content ${view.skillContent!.name} sha256:${view.skillContent!.sha256.slice(0, 12)}…, ` +
              `production baseline ${view.skillBaseline!.name} sha256:${view.skillBaseline!.sha256.slice(0, 12)}…)`,
            )
          }
        }
        if (proposal.gate !== undefined) {
          lines.push(`  gate regression evidence: [${proposal.gate.regressionEvidenceRefs.join(', ')}]`)
        }
        if (proposal.openIntent !== undefined) {
          const intent = proposal.openIntent
          lines.push(
            `  open commit intent: ${intent.intentId} (${intent.direction}) recorded ${intent.at} — production targets ` +
            `[${intent.files.map(file => file.target).join(', ')}]`,
            '  a production write is underway and its completion has not been recorded: ' +
            `${proposal.targetType === 'capability' ? 'the capability table and optional new skill directory stay' : 'the skill directory stays'} ` +
            'closed to new admission until a reconciliation (a restart, or a retry of the apply/rollback) settles it',
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
