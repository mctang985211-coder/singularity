import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { EVOLUTION_DECISIONS, renderProviderRoles } from '@dangosys/dsh-singularity-evolution'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_decide: missing agent id')
  return id
}

export function defineEvolutionDecideTool(ctx: Context) {
  return defineTool({
    name: 'evolution_decide',
    description:
      'Close a gated EvolutionProposal with a human decision (status: decided). Always asks a human through the native ' +
      'approval seam first — every level L1–L4, no exemption — and records the decision (PROMOTE / REJECT / ' +
      'KEEP_FOR_FURTHER_RESEARCH) only after an explicit approve. A reject, cancel, or unavailable answerer records ' +
      'nothing and leaves the proposal gated. A PROMOTE is checked before the human is asked: the candidate\'s whole ' +
      'content identity (the `SKILL.md` bytes, plus the derived sidecar and its declaration digest when the object declares ' +
      'an execution provider), its provider verdict (role, registered verifier, granted tools) and the completed two-sided ' +
      'experiment must still hold. An existing skill may not change role, weaken its verifier or grow a capability through ' +
      'a content update; a capability promotion moves exactly one whole row, optionally with a new execution skill, and ' +
      'cannot add unauthorized tools or change permission or preset. A recorded PROMOTE still applies ' +
      'nothing by itself: the change takes effect only through evolution_apply, which asks the human a second time, names ' +
      'every production file it writes, and leaves a run already bound to the previous version on its own snapshot.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Gated proposal to decide' },
      decision: { type: 'string', required: true, enum: EVOLUTION_DECISIONS, description: 'Decision to record after human approval' },
      note: { type: 'string', description: 'Optional rationale attached to the decision record' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_decide: missing agent')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      if (proposal.status !== 'gated') {
        return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`
      }
      let promotion
      if (args.decision === 'PROMOTE') {
        try {
          promotion = await ctx.evolution.checkPromotion(proposal.proposalId)
        } catch (error) {
          return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const gate = proposal.gate!
      const reason = [
        `Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
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
        const why = outcome === 'rejected'
          ? 'the human rejected it'
          : outcome === 'cancelled'
            ? 'the request was cancelled before the human decided'
            : 'no approval answerer available'
        return `evolution_decide: no decision recorded — ${why}; proposal ${proposal.proposalId} stays gated`
      }
      try {
        const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note)
        return [
          `proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === undefined ? '' : ` — ${decided.decisionNote}`}`,
          decided.decision === 'PROMOTE'
            ? 'recorded after human approval — nothing applied yet; evolution_apply (second human gate) takes it to production'
            : 'recorded after human approval — the ledger notes the decision only; nothing was applied',
        ].join('\n')
      } catch (error) {
        return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
