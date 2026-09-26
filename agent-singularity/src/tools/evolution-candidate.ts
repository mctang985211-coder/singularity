import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_candidate: missing agent id')
  return id
}

export function defineEvolutionCandidateTool(ctx: Context) {
  return defineTool({
    name: 'evolution_candidate',
    description:
      'Claim a proposed EvolutionProposal into validation (status: candidate) by recording the complete version set it ' +
      'aligns to (e.g. taskDefinition / skill / toolProfile / agentPreset / verifier / runtimePolicy versions). Bookkeeping ' +
      'for the branch model only: no branch is created and nothing is executed or changed. Only a single-file SKILL.md ' +
      'replacement can become a candidate in this build: the mutation { name, content } carries the full SKILL.md text, and ' +
      'the candidate must then pass evolution_prepare (sandbox materialization) and evolution_replay (the two-sided ' +
      'experiment) before evolution_gate. A proposal of any other target type is refused by name and stays a record — ' +
      'evolution_propose may still record such a suggestion, but a suggestion never becomes a candidate.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Proposal to move into candidate' },
      versionSet: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Complete version set the candidate aligns to: name → version string, at least one entry',
      },
      mutation: {
        type: 'object',
        additionalProperties: true,
        description:
          'The structured patch: { name, content } — the skill name and the full replacement SKILL.md text. It must be ' +
          'recorded for the candidate to be evaluated at all (a candidate without one has nothing to materialize).',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const versions = args.versionSet as Record<string, unknown>
      try {
        const proposal = await ctx.evolution.candidate(
          args.proposalId,
          versions as Record<string, string>,
          caller,
          args.mutation,
        )
        const versionsText = Object.entries(proposal.versionSet!).map(([key, value]) => `${key}=${value}`).join(', ')
        const next = proposal.mutation === undefined
          ? 'no mutation recorded — nothing this build can evaluate; a candidate it can promote carries the replacement SKILL.md text'
          : 'mutation recorded — next: evolution_prepare (sandbox materialization), then evolution_replay (the two-sided experiment), then evolution_gate'
        return [
          `proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`,
          `ledger entry only — no branch created, nothing executed; ${next}`,
        ].join('\n')
      } catch (error) {
        return `evolution_candidate rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
