import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { applyTargets } from '@dangosys/dsh-singularity-evolution'
import { denialReason, message, renderOpenIntentRecovery, sessionId, text } from '../shared.ts'

/** What a restored object means for production, stated honestly in the output: */
function restoreNote(targetType: string): string {
  if (targetType === 'task_definition') return 'new task instances use the restored library state; existing Task contracts and Run bindings stay fixed'
  if (targetType === 'capability') {
    return 'the capability row and MCP definitions were restored or removed to their prepared baseline, and any new Skill was removed; ' +
      'new admissions read that state while runs already bound to the applied snapshot keep their snapshot'
  }
  return 'the restored object is what the skill filesystem now serves and what the next admission loads, and the skill ' +
    'directory is admitted again now that its commit intent is closed; a run already bound to the applied version keeps ' +
    'loading the snapshot it was bound to'
}

export function defineEvolutionRollbackTool(ctx: Context) {
  return defineTool({
    name: 'evolution_rollback',
    description:
      'Roll back an applied Task template, Skill or capability proposal after human approval. Restore its frozen baseline ' +
      'through the existing durable commit. Template updates append the old content at the next version; a first publication ' +
      'is removed. Capability rollback restores the row and removes new MCP definitions and any new Skill. Existing Task ' +
      'contracts and Run bindings stay fixed. Retry settles an open intent without asking again.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Applied proposal to roll back' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_rollback')
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_rollback: missing agent')
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_rollback rejected: ${message(error)}`
      }
      // A commit intent this proposal left open is settled, not bypassed (K2):
      // the recorded intent already binds its grant and the content it was
      if (proposal.openIntent !== undefined) {
        try {
          const recovered = await ctx.evolution.rollback(args.proposalId, caller, proposal.openIntent.approvalRef)
          return [
            `proposal ${recovered.proposal.proposalId} [rolledback] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — ${recovered.proposal.targetType === 'capability' ? 'production baseline restored' : 'champion restored'}`,
            ...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
            'wrote production targets:',
            ...(recovered.proposal.targetType === 'capability' ? [`  - capability row ${recovered.proposal.targetId} restored in the production table`] : []),
            ...recovered.targets.map(target => `  - ${target}`),
            restoreNote(recovered.proposal.targetType),
          ].join('\n')
        } catch (error) {
          return `evolution_rollback rejected: ${message(error)}`
        }
      }
      if (proposal.status !== 'applied') {
        return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`
      }
      const targets = applyTargets(proposal, ctx.evolution, 'rollback')
      if (targets.length === 0 && proposal.targetType !== 'capability') {
        return `evolution_rollback rejected: proposal ${proposal.proposalId} targets "${proposal.targetType}" — this build restores a Task template, Skill or capability candidate, so there is no executor for this target type`
      }
      const reason = [
        `Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        `applied mutation: ${JSON.stringify(proposal.mutation)}`,
        ...(proposal.prepared?.capabilityTable === undefined ? [] : [`deployment config baseline sha256:${proposal.prepared.capabilityTable.baselineSha256}; apply sha256:${proposal.prepared.capabilityTable.applySha256}; rollback sha256:${proposal.prepared.capabilityTable.rollbackSha256}`]),
        `applied at: ${[...(proposal.targetType === 'capability' ? [`capability row ${proposal.targetId}`] : []), ...proposal.applied!.targets].join(', ')} (approval ${proposal.applied!.approvalRef})`,
        proposal.targetType === 'capability'
          ? 'this restores the capability row baseline and removes new MCP definitions and any new Skill from production targets:'
          : proposal.targetType === 'task_definition'
            ? 'this restores the template library state; prior contracts stay fixed:'
            : 'this restores the champion snapshot over production targets:',
        ...(proposal.targetType === 'capability' ? [`  - capability row ${proposal.targetId} in the production table`] : []),
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
        const why = denialReason(outcome)
        return `evolution_rollback: nothing written — ${why}; proposal ${proposal.proposalId} stays applied`
      }
      try {
        const rolledback = await ctx.evolution.rollback(args.proposalId, caller, `approval:${exec.callId}`)
        return [
          `proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — ${rolledback.proposal.targetType === 'capability' ? 'production baseline restored' : 'champion restored'}`,
          'wrote production targets:',
          ...(rolledback.proposal.targetType === 'capability' ? [`  - capability row ${rolledback.proposal.targetId} restored in the production table`] : []),
          ...rolledback.targets.map(target => `  - ${target}`),
          restoreNote(rolledback.proposal.targetType),
          `human approval: approval:${exec.callId}`,
        ].join('\n')
      } catch (error) {
        return `evolution_rollback rejected: ${message(error)}`
      }
    },
  })
}
