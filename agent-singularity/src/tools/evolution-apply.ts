import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { APPLYABLE_TARGET_TYPES, applyTargets, renderProviderRoles } from '@dangosys/dsh-singularity-evolution'
import type { EvolutionProposal } from '@dangosys/dsh-singularity-evolution'
import { renderOpenIntentRecovery } from './evolution-commit.ts'

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
    return `this build writes and restores the fixed file set of one skill object only (` +
      `SKILL.md, plus the SKILL.contract.json of a skill that declares an execution provider), so a decided "${proposal.targetType}" ` +
      'proposal has no executor here — its ledger record stays readable and nothing writes it; the capability evaluation such a ' +
      'proposal would need belongs to A6, not to this build'
  }
  return null
}

/** How an applied skill takes effect, stated honestly in the output. */
function effectNote(): string {
  return 'effective immediately — the skill filesystem watches the skill root, so the write is live; the skill directory is ' +
    'admitted again now that its commit intent is closed, and a run already bound to the previous version keeps loading the ' +
    'snapshot it was bound to'
}

export function defineEvolutionApplyTool(ctx: Context) {
  return defineTool({
    name: 'evolution_apply',
    description:
      'Apply a PROMOTE-decided EvolutionProposal to production (status: applied). One target type: a same-name improvement ' +
      'of an existing skill object at L1–L3 with a materialized sandbox — the commit writes that object\'s fixed file set, ' +
      'the `SKILL.md` and, for an execution skill, the `SKILL.contract.json` beside it. Every other target type and L4 lack ' +
      'executors and are refused with instructions. Always asks a human through the native approval seam first — a second ' +
      'gate after evolution_decide — naming every production path it will write; a reject, cancel, or unavailable answerer ' +
      'writes nothing and leaves the proposal decided. A skill apply additionally re-verifies before the human is asked, and ' +
      'again after the grant, the candidate\'s whole content identity and the production baseline recorded at prepare (the ' +
      'production file set must still be those exact bytes — a sidecar that appeared where the baseline had none, changed or ' +
      'disappeared refuses — so a stale candidate never overwrites a production skill that changed). The candidate sidecar ' +
      'is never the model\'s text: it must equal the production declaration with only content.skillMdSha256 rewritten, so a ' +
      'promotion cannot escalate requiredTools, swap a verifier, move capabilities or change the object\'s role; a candidate ' +
      'directory carrying any other entry (a resource, a stray file) is refused by name rather than reported as a provider ' +
      'production never received. The write is one commit: a durable commit intent — proposal, direction, this approval, ' +
      'every production file with the content identity each must hold before and after the write, and the bytes to write ' +
      'again — is recorded before production changes, then each file is replaced atomically (a temp file in the same ' +
      'directory, fsynced and renamed over the target; never truncated, never half-written), and only after every rename ' +
      'has been read back and the whole directory verified as one loadable object is the completion recorded. A failure ' +
      'at any stage leaves exactly one open intent rather than a half-committed object (a directory holding the new ' +
      '`SKILL.md` beside the old sidecar included), and the skill directory stays closed to new admission until that intent ' +
      'is settled; calling this tool again while ' +
      'an intent is open settles it instead of starting a second write: no approval is asked again (the intent already ' +
      'binds the grant it was authorised by, and the promotion gate is not re-run because the recorded intent already ' +
      'names the approved content), and the answer reports the intent id and whether the commit was redone (production ' +
      'still held the pre-commit state) or only completed (production already held the committed content). A source that ' +
      'is gone or changed, or a target a third party rewrote, refuses by name with the intent left open. ' +
      'evolution_rollback restores the champion snapshot.',
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
      // An intent this proposal left open is settled, not bypassed (K2): the
      // retry asks the service the only question that is still open — what does
      // production hold? — and the recorded intent already binds the grant and
      // the content it was approved against, so no human is asked a second time
      // and the promotion gate is not re-run. Everything the service refuses on
      // that path (a direction this call cannot settle, a source that is gone, a
      // target a third party changed) is reported as the service names it.
      if (proposal.openIntent !== undefined) {
        try {
          const recovered = await ctx.evolution.apply(args.proposalId, caller, proposal.openIntent.approvalRef)
          return [
            `proposal ${recovered.proposal.proposalId} [applied] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — PROMOTE in effect`,
            ...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
            'wrote production targets:',
            ...recovered.targets.map(target => `  - ${target}`),
            effectNote(),
          ].join('\n')
        } catch (error) {
          return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`
        }
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
