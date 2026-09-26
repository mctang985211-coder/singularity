import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyTargets } from '@dangosys/dsh-singularity-evolution'
import { renderOpenIntentRecovery } from './evolution-commit.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_rollback: missing agent id')
  return id
}

export function defineEvolutionRollbackTool(ctx: Context) {
  return defineTool({
    name: 'evolution_rollback',
    description:
      'Roll back an applied EvolutionProposal (status: rolledback). Restores the champion snapshot taken at prepare — the ' +
      'production SKILL.md of an applied single-file skill replacement, put back byte for byte. An applied record of any ' +
      'other target type has no executor here and is refused. Always asks a human through the native approval seam first — ' +
      'reject / cancel / unavailable writes nothing and the proposal stays applied. Only an applied proposal can be rolled ' +
      'back; a rolled-back proposal keeps its full ledger history. The restore is one commit, in the same order as apply: ' +
      'a durable commit intent (proposal, direction, this approval, the target, the content identity production must hold ' +
      'before and after, and the champion snapshot as the recoverable bytes) is recorded before production changes, the ' +
      'SKILL.md is replaced atomically, and only then is the completion recorded — so a failure at any stage leaves one ' +
      'open intent and an intact file rather than a half-commit. A rollback restores this proposal\'s own baseline and ' +
      'refuses by name, with nothing written, a target that a later proposal (or any other writer) has changed since this ' +
      'version was applied, and a champion snapshot that no longer hashes to the baseline recorded at prepare. Calling ' +
      'this tool again while an intent is open settles it instead of asking for a second approval: the answer reports the ' +
      'intent id and whether the write was redone or only its completion recorded.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Applied proposal to roll back' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_rollback: missing agent')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      // A commit intent this proposal left open is settled, not bypassed (K2):
      // the recorded intent already binds its grant and the content it was
      // approved against, so the retry asks the service the only open question —
      // what does production hold? — without a second human approval.
      if (proposal.openIntent !== undefined) {
        try {
          const recovered = await ctx.evolution.rollback(args.proposalId, caller, proposal.openIntent.approvalRef)
          return [
            `proposal ${recovered.proposal.proposalId} [rolledback] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — champion restored`,
            ...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
            'wrote production targets:',
            ...recovered.targets.map(target => `  - ${target}`),
          ].join('\n')
        } catch (error) {
          return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (proposal.status !== 'applied') {
        return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`
      }
      const targets = applyTargets(proposal, ctx.evolution)
      if (targets.length === 0) {
        return `evolution_rollback rejected: proposal ${proposal.proposalId} targets "${proposal.targetType}" — this build writes and restores a single SKILL.md only, so there is no executor to roll back an applied record of another type`
      }
      const reason = [
        `Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        `applied at: ${proposal.applied!.targets.join(', ')} (approval ${proposal.applied!.approvalRef})`,
        'this restores the champion snapshot over production targets:',
        ...targets.map(target => `  - ${target}`),
      ].join('\n')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'evolution_rollback',
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
        return `evolution_rollback: nothing written — ${why}; proposal ${proposal.proposalId} stays applied`
      }
      try {
        const rolledback = await ctx.evolution.rollback(args.proposalId, caller, `approval:${exec.callId}`)
        return [
          `proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — champion restored`,
          'wrote production targets:',
          ...rolledback.targets.map(target => `  - ${target}`),
          `human approval: approval:${exec.callId}`,
        ].join('\n')
      } catch (error) {
        return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
