import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { applyTargets } from '../evolution.ts'

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
      'Roll back an applied EvolutionProposal (status: rolledback). Restores the champion snapshot taken at prepare ' +
      'time (skill SKILL.md / preset directory / capability config.yml row); when the champion did not exist ' +
      '(champion: null), deletes what the apply created. Always asks a human through the native approval seam ' +
      'first — reject / cancel / unavailable writes nothing and the proposal stays applied. Only an applied ' +
      'proposal can be rolled back; a rolled-back proposal keeps its full ledger history.',
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
      if (proposal.status !== 'applied') {
        return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`
      }
      const targets = applyTargets(proposal, ctx.evolution)
      const restore = proposal.prepared?.champion !== 'captured'
        ? 'the champion did not exist (champion: null) — this DELETES what the apply created:'
        : proposal.prepared?.championSource === 'code-default'
          ? 'the champion is a code default (no config.yml row at prepare time) — this REMOVES the applied row so the default governs again:'
          : 'this restores the champion snapshot over production targets:'
      const reason = [
        `Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        `applied at: ${proposal.applied!.targets.join(', ')} (approval ${proposal.applied!.approvalRef})`,
        restore,
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
        let runtimeNote = ''
        if (rolledback.capability !== undefined) {
          try {
            await ctx.taskRuntime.applyCapabilityRow(rolledback.capability.name, rolledback.capability.entry)
            runtimeNote = rolledback.capability.entry === null
              ? '\nruntime registry row removed — new admissions in this process no longer see it'
              : '\nruntime registry row restored — new admissions in this process use the champion entry now'
          } catch (error) {
            runtimeNote = `\nruntime override failed (${error instanceof Error ? error.message : String(error)}) — the config.yml row takes effect on the next restart`
          }
        }
        return [
          `proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — champion restored`,
          'wrote production targets:',
          ...rolledback.targets.map(target => `  - ${target}`),
          `human approval: approval:${exec.callId}`,
        ].join('\n') + runtimeNote
      } catch (error) {
        return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
