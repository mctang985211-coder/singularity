import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { APPLYABLE_TARGET_TYPES, applyTargets } from '../evolution.ts'
import type { EvolutionProposal } from '../evolution.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_apply: missing agent id')
  return id
}

/**
 * Why a decided PROMOTE proposal still cannot be applied, per boundary
 * L4 and non-materialized surfaces have no production executor yet.
 */
function manualGuidance(proposal: EvolutionProposal): string | null {
  if (proposal.level === 'L4') {
    return 'L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow'
  }
  if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) {
    return proposal.targetType === 'task_definition'
      ? 'task_definition has no production registry to write (the task store keeps denormalized instances only): a definition executor is still required before supervisor candidates can be promoted here'
      : `${proposal.targetType} mutations are bookkeeping-only (mechanical: false): an executor and target-specific validation are still required; the ledger keeps the record`
  }
  if (proposal.prepared?.sandbox == null) {
    return 'this candidate carried no structured mutation, so nothing was materialized: create a new structured candidate, evaluate it, then request human review'
  }
  return null
}

/** How fast each applied type takes effect, stated honestly in the output. */
export function effectNote(proposal: EvolutionProposal): string {
  switch (proposal.targetType) {
    case 'skill':
      return 'effective immediately — the skill filesystem watches the skill root, so the write is live'
    case 'agent_preset':
      return 'effective immediately — preset discovery re-reads the roots on every resolve'
    default:
      return 'effective immediately for admissions in this process (the runtime registry row was replaced); config.yml keeps it across restarts'
  }
}

export function defineEvolutionApplyTool(ctx: Context) {
  return defineTool({
    name: 'evolution_apply',
    description:
      'Apply a PROMOTE-decided EvolutionProposal to production (status: applied). Only the three mechanical types ' +
      '(skill / agent_preset / capability) at L1–L3 with a materialized sandbox; task_definition, the five ' +
      'bookkeeping-only types, and L4 lack executors and are refused with instructions. Always asks a human through the ' +
      'native approval seam first — a second gate after evolution_decide — naming every production path it will ' +
      'write; a reject, cancel, or unavailable answerer writes nothing and leaves the proposal decided. A skill ' +
      'apply additionally re-verifies the production baseline recorded at prepare (the production SKILL.md must ' +
      'still be those exact bytes, or still be absent) before the human is asked and again after the grant, and ' +
      'refuses a stale candidate instead of overwriting a production skill that changed. skill and ' +
      'agent_preset take effect on write; a capability row is mirrored into the running registry and persists in ' +
      'config.yml. evolution_rollback restores the champion snapshot.',
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
      try {
        await ctx.evolution.checkPromotion(proposal.proposalId)
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
        effectNote(proposal),
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
        let runtimeNote = ''
        if (applied.capability !== undefined) {
          try {
            ctx.taskRuntime.applyCapabilityRow(applied.capability.name, applied.capability.entry)
            runtimeNote = '\nruntime registry row replaced — new admissions in this process use it now'
          } catch (error) {
            runtimeNote = `\nruntime override failed (${error instanceof Error ? error.message : String(error)}) — the config.yml row takes effect on the next restart`
          }
        }
        return [
          `proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
          'wrote production targets:',
          ...applied.targets.map(target => `  - ${target}`),
          effectNote(proposal),
          `human approval: approval:${exec.callId} — rollback with evolution_rollback`,
        ].join('\n') + runtimeNote
      } catch (error) {
        return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
