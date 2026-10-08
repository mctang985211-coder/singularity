import { evolutionForSession } from './evolution-scope.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { APPLYABLE_TARGET_TYPES, applyTargets, renderProviderRoles } from '@dangosys/dsh-singularity-evolution'
import type { EvolutionProposal } from '@dangosys/dsh-singularity-evolution'
import { denialReason, message, renderOpenIntentRecovery, sessionId, text } from '../shared.ts'

/** Why a decided PROMOTE proposal still cannot be applied: L4 harness evolution and target types this build has no executor for. */
function manualGuidance(proposal: EvolutionProposal): string | null {
  if (proposal.level === 'L4') {
    return 'L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow'
  }
  if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) {
    return `this build writes a Task template, an existing Skill or one capability row with optional MCP definitions and Skill, so a decided ` +
      `"${proposal.targetType}" proposal has no executor here — its ledger record stays readable and nothing writes it`
  }
  return null
}

/** How the approved production write takes effect. */
function effectNote(proposal: EvolutionProposal): string {
  if (proposal.targetType === 'task_definition') {
    return 'effective for new task instances — the library serves the published template; existing task contracts and Run bindings stay fixed'
  }
  if (proposal.targetType === 'capability') {
    return 'effective for new admissions — the committed capability row, MCP definitions and optional new execution Skill are available to ' +
      'the runtime; a run already bound to the previous capability snapshot keeps that snapshot'
  }
  return 'effective immediately — the skill filesystem watches the skill root, so the write is live; the skill directory is ' +
    'admitted again now that its commit intent is closed, and a run already bound to the previous version keeps loading the ' +
    'snapshot it was bound to'
}

export function defineEvolutionApplyTool(ctx: Context) {
  return defineTool({
    name: 'evolution_apply',
    description:
      'Apply a PROMOTE-decided Task template, Skill or capability candidate at L1–L3. Recheck the frozen candidate, experiment ' +
      'and production baseline. One exact-write approval is always requested through the native seam — a graph whose RSI ' +
      'settings run without a human resolves it on the spot. Review shows the exact mutation, definitions and targets. ' +
      'One existing durable commit writes production; retry settles its open intent without asking again. New admissions ' +
      'consume the published version; existing Task contracts and Run bindings stay fixed. evolution_rollback restores the baseline.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Decided (PROMOTE) proposal to apply to production' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_apply')
      const evolution = await evolutionForSession(ctx, caller)
      const agent = exec.agent
      if (agent === undefined) throw new Error('evolution_apply: missing agent')
      let proposal
      try {
        proposal = await evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_apply rejected: ${message(error)}`
      }
      // An intent this proposal left open is settled, not bypassed (K2): the
      // retry asks the service the only question that is still open — what does
      if (proposal.openIntent !== undefined) {
        try {
          const recovered = await evolution.apply(args.proposalId, caller, proposal.openIntent.approvalRef)
          return [
            `proposal ${recovered.proposal.proposalId} [applied] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — PROMOTE in effect`,
            ...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
            'wrote production targets:',
            ...(recovered.proposal.targetType === 'capability' ? [`  - capability row ${recovered.proposal.targetId} in the production table`] : []),
            ...recovered.targets.map(target => `  - ${target}`),
            effectNote(recovered.proposal),
          ].join('\n')
        } catch (error) {
          return `evolution_apply rejected: ${message(error)}`
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
        promotion = await evolution.checkPromotion(proposal.proposalId)
        // P3: the production baseline must still be the one this candidate was
        // evaluated against, checked BEFORE the human is asked. The service
        await evolution.checkProductionBaseline(proposal.proposalId)
      } catch (error) {
        return `evolution_apply rejected: ${message(error)}`
      }
      const targets = applyTargets(proposal, evolution)
      const reason = [
        `Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
        `rationale: ${proposal.rationale}`,
        'recorded decision: PROMOTE',
        `version set: ${JSON.stringify(proposal.versionSet)}`,
        `evaluated mutation: ${JSON.stringify(proposal.mutation)}`,
        `evaluation gate: ${JSON.stringify(proposal.gate)}`,
        `experiment/regression evidence: ${proposal.gate!.regressionEvidenceRefs.join(', ')}`,
        ...(proposal.prepared?.mcpServers === undefined ? [] : [`MCP definitions sha256:${proposal.prepared.mcpServers.digest}`]),
        ...(proposal.prepared?.capabilityTable === undefined ? [] : [`deployment config baseline sha256:${proposal.prepared.capabilityTable.baselineSha256}; apply sha256:${proposal.prepared.capabilityTable.applySha256}; rollback sha256:${proposal.prepared.capabilityTable.rollbackSha256}`]),
        'this writes production targets:',
        ...(proposal.targetType === 'capability' ? [`  - capability row ${proposal.targetId} in the production table`] : []),
        ...targets.map(target => `  - ${target}`),
        ...renderProviderRoles(promotion.providers),
        effectNote(proposal),
        proposal.targetType === 'capability'
          ? 'rollback: evolution_rollback restores the row baseline and removes new MCP definitions and any new Skill'
          : proposal.targetType === 'task_definition'
            ? 'rollback: append the previous template content as a new version, or remove a first publication; existing contracts stay fixed'
            : 'rollback: evolution_rollback restores the champion snapshot from the sandbox',
      ].join('\n')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'evolution_apply',
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        const why = denialReason(outcome)
        return `evolution_apply: nothing written — ${why}; proposal ${proposal.proposalId} stays decided`
      }
      const approvalRef = `approval:${exec.callId}`
      try {
        const applied = await evolution.apply(args.proposalId, caller, approvalRef)
        return [
          `proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
          'wrote production targets:',
          ...(applied.proposal.targetType === 'capability' ? [`  - capability row ${applied.proposal.targetId} in the production table`] : []),
          ...applied.targets.map(target => `  - ${target}`),
          ...renderProviderRoles(applied.providers ?? []),
          effectNote(applied.proposal),
          `human approval: ${approvalRef} — rollback with evolution_rollback`,
        ].join('\n')
      } catch (error) {
        return `evolution_apply rejected: ${message(error)}`
      }
    },
  })
}
