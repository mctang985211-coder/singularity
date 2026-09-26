import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { APPLYABLE_TARGET_TYPES, applyTargets, renderProviderRoles } from '@dangosys/dsh-singularity-evolution'
import type { EvolutionProposal } from '@dangosys/dsh-singularity-evolution'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_apply: missing agent id')
  return id
}

/**
 * Why a decided PROMOTE proposal still cannot be applied: L4 harness evolution
 * and every target type this build has no executor for.
 */
function manualGuidance(proposal: EvolutionProposal): string | null {
  if (proposal.level === 'L4') {
    return 'L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow'
  }
  if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) {
    return `this build writes a single SKILL.md only, so a decided "${proposal.targetType}" proposal has no executor here — its ledger record stays readable and nothing writes it; the capability evaluation such a proposal would need belongs to A6, not to this build`
  }
  if (proposal.prepared?.sandbox == null) {
    return 'this candidate carried no structured mutation, so nothing was materialized: create a new structured candidate, evaluate it, then request human review'
  }
  return null
}

/** How fast an applied skill takes effect, stated honestly in the output. */
function effectNote(): string {
  return 'effective immediately — the skill filesystem watches the skill root, so the write is live'
}

export function defineEvolutionApplyTool(ctx: Context) {
  return defineTool({
    name: 'evolution_apply',
    description:
      'Apply a PROMOTE-decided EvolutionProposal to production (status: applied). One target type: a single-file ' +
      'SKILL.md replacement at L1–L3 with a materialized sandbox. Every other target type and L4 lack executors and are ' +
      'refused with instructions. Always asks a human through the native approval seam first — a second gate after ' +
      'evolution_decide — naming every production path it will write; a reject, cancel, or unavailable answerer writes ' +
      'nothing and leaves the proposal decided. A skill apply additionally re-verifies the production baseline recorded ' +
      'at prepare (the production SKILL.md must still be those exact bytes; one that changed or disappeared since prepare ' +
      'refuses) before the human is asked and again after the grant, and refuses a stale candidate instead of overwriting a ' +
      'production skill that changed. A skill candidate is promoted as one file: one carrying a SKILL.contract.json or any ' +
      'resource is refused (the executor writes SKILL.md only, so such a candidate would be reported as a provider production ' +
      'never received). evolution_rollback restores the champion snapshot.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Decided (PROMOTE) proposal to apply to production' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_apply: missing agent')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      // Every refusal lands BEFORE the human is asked — a proposal that cannot
      // apply never burns an approval.
      if (proposal.status !== 'decided') {
        return `evolution_apply rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a decided proposal can be applied`
      }
      if (proposal.decision !== 'PROMOTE') {
        return `evolution_apply rejected: proposal ${proposal.proposalId} was decided ${proposal.decision}; only a PROMOTE decision can be applied`
      }
      const manual = manualGuidance(proposal)
      if (manual !== null) return `evolution_apply rejected: ${manual}`
      let promotion
      try {
        promotion = await ctx.evolution.checkPromotion(proposal.proposalId)
        // P3: the production baseline must still be the one this candidate was
        // evaluated against, checked BEFORE the human is asked. The service
        // entry re-runs it after the grant, immediately before the write.
        await ctx.evolution.checkProductionBaseline(proposal.proposalId)
      } catch (error) {
        return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      const targets = applyTargets(proposal, ctx.evolution)
      const reason = [
        `Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        'recorded decision: PROMOTE',
        'this writes production targets:',
        ...targets.map(target => `  - ${target}`),
        ...renderProviderRoles(promotion.providers),
        effectNote(),
        'rollback: evolution_rollback restores the champion snapshot from the sandbox',
      ].join('\n')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'evolution_apply',
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
        return `evolution_apply: nothing written — ${why}; proposal ${proposal.proposalId} stays decided`
      }
      try {
        const applied = await ctx.evolution.apply(args.proposalId, caller, `approval:${exec.callId}`)
        return [
          `proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
          'wrote production targets:',
          ...applied.targets.map(target => `  - ${target}`),
          ...renderProviderRoles(applied.providers ?? []),
          effectNote(),
          `human approval: approval:${exec.callId} — rollback with evolution_rollback`,
        ].join('\n')
      } catch (error) {
        return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
