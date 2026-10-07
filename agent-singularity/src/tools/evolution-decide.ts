import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { EVOLUTION_DECISIONS } from '@dangosys/dsh-singularity-evolution'
import { continueProposalHandoff } from '../coordination/evolution-handoff.ts'
import { message, sessionId, text } from '../shared.ts'

export function defineEvolutionDecideTool(ctx: Context) {
  return defineTool({
    name: 'evolution_decide',
    description:
      'Record the model decision for a gated proposal: PROMOTE, REJECT or KEEP_FOR_FURTHER_RESEARCH. PROMOTE rechecks ' +
      'the frozen Task template, Skill or capability candidate and completed experiment. This records a decision only; evolution_apply handles the production ' +
      'write under the deployment publication approval policy.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Gated proposal to decide' },
      decision: { type: 'string', required: true, enum: EVOLUTION_DECISIONS, description: 'Model decision to record' },
      note: { type: 'string', description: 'Optional rationale attached to the decision record' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_decide')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_decide rejected: ${message(error)}`
      }
      if (proposal.status !== 'gated') {
        return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`
      }
      if (args.decision === 'PROMOTE') {
        try {
          await ctx.evolution.checkPromotion(proposal.proposalId)
        } catch (error) {
          return `evolution_decide rejected: ${message(error)}`
        }
      }
      try {
        const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `decision:${exec.callId}`, args.note)
        return [
          `proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === undefined ? '' : ` — ${decided.decisionNote}`}`,
          ...(await continueProposalHandoff(ctx, decided, caller)),
          decided.decision === 'PROMOTE'
            ? 'model decision recorded — nothing applied yet; continue with evolution_apply'
            : 'model decision recorded — nothing was applied',
        ].join('\n')
      } catch (error) {
        return `evolution_decide rejected: ${message(error)}`
      }
    },
  })
}
