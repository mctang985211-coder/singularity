import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_gate: missing agent id')
  return id
}

export function defineEvolutionGateTool(ctx: Context) {
  return defineTool({
    name: 'evolution_gate',
    description:
      'Answer the minimal Validation Gate for a candidate (status: gated). The six questions (细化想法4 §32): ' +
      '1. Target failure fixed? 2. Original acceptance maintained? 3. Existing regression maintained? ' +
      '4. No unacceptable side effects? 5. Holdout performance acceptable? 6. Resource cost acceptable? ' +
      'All six answers are required, and the regression side must cite evidence ids (from this graph\'s task store) or ' +
      'file paths whose existence is checked — cited evidence is never executed. A skill candidate must pass ' +
      'evolution_prepare (sandbox materialization) and then evolution_replay (the two-sided experiment: a new baseline run ' +
      'and a new candidate run per frozen sample), and its report path must be one of the regressionEvidenceRefs — the gate ' +
      'refuses a skill candidate whose experiment is not complete. A proposal of any other target type cannot become a ' +
      'candidate and has no gate to answer. Records the ledger entry only; nothing is promoted or changed. ' +
      'Next step is evolution_decide, which always asks a human.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Candidate to gate' },
      targetFailureFixed: { type: 'string', required: true, description: 'Answer to "1. Target failure fixed?"' },
      originalAcceptanceMaintained: { type: 'string', required: true, description: 'Answer to "2. Original acceptance maintained?"' },
      existingRegressionMaintained: { type: 'string', required: true, description: 'Answer to "3. Existing regression maintained?"' },
      noUnacceptableSideEffects: { type: 'string', required: true, description: 'Answer to "4. No unacceptable side effects?"' },
      holdoutPerformanceAcceptable: { type: 'string', required: true, description: 'Answer to "5. Holdout performance acceptable?"' },
      resourceCostAcceptable: { type: 'string', required: true, description: 'Answer to "6. Resource cost acceptable?"' },
      regressionEvidenceRefs: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Evidence behind the regression answers: the experiment report path plus evidence ids or paths (existence-checked, never executed), at least one',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      // Evidence ids come from the caller's task store; a missing store just
      // means no id resolves, while on-disk path refs still can.
      let evidenceIds = new Set<string>()
      try {
        const graph = await ctx.graphs.graphForSession(caller)
        const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
        evidenceIds = new Set(snapshot.evidence.map(item => item.evidenceId))
      } catch {
        evidenceIds = new Set()
      }
      try {
        const proposal = await ctx.evolution.gate(
          args.proposalId,
          {
            targetFailureFixed: args.targetFailureFixed,
            originalAcceptanceMaintained: args.originalAcceptanceMaintained,
            existingRegressionMaintained: args.existingRegressionMaintained,
            noUnacceptableSideEffects: args.noUnacceptableSideEffects,
            holdoutPerformanceAcceptable: args.holdoutPerformanceAcceptable,
            resourceCostAcceptable: args.resourceCostAcceptable,
            regressionEvidenceRefs: args.regressionEvidenceRefs,
          },
          caller,
          async ref => evidenceIds.has(ref),
        )
        return [
          `proposal ${proposal.proposalId} [gated] gate answered 6/6, regression evidence: [${proposal.gate!.regressionEvidenceRefs.join(', ')}]`,
          'ledger entry only — nothing executed or promoted; next: evolution_decide (human approval required)',
        ].join('\n')
      } catch (error) {
        return `evolution_gate rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
