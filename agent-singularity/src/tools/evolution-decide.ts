import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { GateAnswers } from '@dangosys/dsh-singularity-evolution'
import { EVOLUTION_DECISIONS } from '@dangosys/dsh-singularity-evolution'
import { denialReason, message, sessionId, text } from '../shared.ts'

/** The six verbatim gate questions with their answers, the regression evidence on the third — what the human approves. */
function gateAnswerLines(gate: GateAnswers | undefined): string[] {
  if (gate === undefined) return ['gate answers: none recorded']
  const evidence = gate.regressionEvidenceRefs.length === 0 ? '' : ` [evidence: ${gate.regressionEvidenceRefs.join(', ')}]`
  return [
    'gate answers:',
    `1. Target failure fixed? ${gate.targetFailureFixed}`,
    `2. Original acceptance maintained? ${gate.originalAcceptanceMaintained}`,
    `3. Existing regression maintained? ${gate.existingRegressionMaintained}${evidence}`,
    `4. No unacceptable side effects? ${gate.noUnacceptableSideEffects}`,
    `5. Holdout performance acceptable? ${gate.holdoutPerformanceAcceptable}`,
    `6. Resource cost acceptable? ${gate.resourceCostAcceptable}`,
  ]
}

export function defineEvolutionDecideTool(ctx: Context) {
  return defineTool({
    name: 'evolution_decide',
    description:
      'Record the model decision for a gated proposal: PROMOTE, REJECT or KEEP_FOR_FURTHER_RESEARCH. PROMOTE rechecks ' +
      'the frozen Task template, Skill or capability candidate and completed experiment. The decision is recorded only ' +
      'after one approval is requested through the native seam — a graph whose RSI settings run without a human resolves ' +
      'it on the spot; evolution_apply handles the production write afterwards.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Gated proposal to decide' },
      decision: { type: 'string', required: true, enum: EVOLUTION_DECISIONS, description: 'Model decision to record' },
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
      if (args.decision === 'PROMOTE') {
        try {
          await ctx.evolution.checkPromotion(proposal.proposalId)
        } catch (error) {
          return `evolution_decide rejected: ${message(error)}`
        }
      }
      // The decision is the human's, not the model's alone: it reaches the ledger only through the native approval
      // seam (auto-resolved in an unmanned graph). Every refusal above landed before anyone was asked.
      const reason = [
        `Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        ...gateAnswerLines(proposal.gate),
        `proposed decision: ${args.decision}${args.note === undefined ? '' : ` — ${args.note}`}`,
        `proposal rationale: ${proposal.rationale}`,
        'this records the decision only — nothing is promoted, written or rolled back.',
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
        return `evolution_decide: no decision recorded — ${why}; proposal ${proposal.proposalId} stays ${proposal.status}`
      }
      try {
        const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note)
        return [
          `proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === undefined ? '' : ` — ${decided.decisionNote}`}`,
          decided.decision === 'PROMOTE'
            ? 'nothing applied yet; evolution_apply (second human gate) takes it to production'
            : 'no decision becomes production — nothing was applied',
        ].join('\n')
      } catch (error) {
        return `evolution_decide rejected: ${message(error)}`
      }
    },
  })
}
