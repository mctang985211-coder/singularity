import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { EVOLUTION_DECISIONS, renderProviderRoles } from '@dangosys/dsh-singularity-evolution'
import { continueProposalHandoff } from '../coordination/evolution-handoff.ts'
import { denialReason, message, sessionId, text } from '../shared.ts'

export function defineEvolutionDecideTool(ctx: Context) {
  return defineTool({
    name: 'evolution_decide',
    description:
      'Decide a gated proposal after human approval: PROMOTE, REJECT or KEEP_FOR_FURTHER_RESEARCH. A PROMOTE rechecks ' +
      'the frozen Task template, Skill or capability candidate and its completed experiment before showing the exact mutation ' +
      'and evidence to the person. This records a decision only; evolution_apply requests the production write separately. ' +
      'A refused approval leaves the proposal gated.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Gated proposal to decide' },
      decision: { type: 'string', required: true, enum: EVOLUTION_DECISIONS, description: 'Decision to record after human approval' },
      note: { type: 'string', description: 'Optional rationale attached to the decision record' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_decide')
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_decide: missing agent')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_decide rejected: ${message(error)}`
      }
      if (proposal.status !== 'gated') {
        return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`
      }
      let promotion
      if (args.decision === 'PROMOTE') {
        try {
          promotion = await ctx.evolution.checkPromotion(proposal.proposalId)
        } catch (error) {
          return `evolution_decide rejected: ${message(error)}`
        }
      }
      const gate = proposal.gate!
      const reason = [
        `Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        `evaluated mutation: ${JSON.stringify(proposal.mutation)}`,
        ...(proposal.prepared?.mcpServers === undefined ? [] : [`MCP definitions sha256:${proposal.prepared.mcpServers.digest}`]),
        ...(proposal.prepared?.capabilityTable === undefined ? [] : [`deployment config baseline sha256:${proposal.prepared.capabilityTable.baselineSha256}; apply sha256:${proposal.prepared.capabilityTable.applySha256}; rollback sha256:${proposal.prepared.capabilityTable.rollbackSha256}`]),
        `version set: ${Object.entries(proposal.versionSet!).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `gate: 1. Target failure fixed? ${gate.targetFailureFixed}`,
        `gate: 2. Original acceptance maintained? ${gate.originalAcceptanceMaintained}`,
        `gate: 3. Existing regression maintained? ${gate.existingRegressionMaintained} [evidence: ${gate.regressionEvidenceRefs.join(', ')}]`,
        `gate: 4. No unacceptable side effects? ${gate.noUnacceptableSideEffects}`,
        `gate: 5. Holdout performance acceptable? ${gate.holdoutPerformanceAcceptable}`,
        `gate: 6. Resource cost acceptable? ${gate.resourceCostAcceptable}`,
        `proposed decision: ${args.decision}${args.note === undefined ? '' : ` — ${args.note}`}`,
        `this promotion would put in place: ${promotion === undefined || promotion.providers.length === 0 ? 'no provider skill' : renderProviderRoles(promotion.providers).join('; ')}`,
      ].join('\n')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'evolution_decide',
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        const why = denialReason(outcome)
        return `evolution_decide: no decision recorded — ${why}; proposal ${proposal.proposalId} stays gated`
      }
      try {
        const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note)
        return [
          `proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === undefined ? '' : ` — ${decided.decisionNote}`}`,
          ...(await continueProposalHandoff(ctx, decided, caller)),
          decided.decision === 'PROMOTE'
            ? 'recorded after human approval — nothing applied yet; evolution_apply (second human gate) takes it to production'
            : 'recorded after human approval — the ledger notes the decision only; nothing was applied',
        ].join('\n')
      } catch (error) {
        return `evolution_decide rejected: ${message(error)}`
      }
    },
  })
}
