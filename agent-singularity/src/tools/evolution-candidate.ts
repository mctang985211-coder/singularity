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
      'for the branch model only: no branch is created and nothing is executed or changed. This build admits one candidate ' +
      'lifecycle — a same-name improvement of an existing skill as a whole loadable object: the mutation { name, content } ' +
      'carries the full replacement SKILL.md text and nothing else, because `content` is the whole new body rather than a ' +
      'diff, no sidecar patch and no resource is accepted, and an unknown mutation field is refused by name. When that ' +
      "skill declares an execution provider, evolution_prepare derives the candidate's SKILL.contract.json from the " +
      'production declaration with only content.skillMdSha256 recomputed, so a content update can never move a capability, ' +
      'a required tool, a verifier or a port. The candidate must then pass evolution_prepare (sandbox materialization) and ' +
      'evolution_replay (the two-sided experiment) before evolution_gate. A proposal of any other target type is refused ' +
      'by name and stays a record — evolution_propose may still record such a suggestion, but a suggestion never becomes a ' +
      'candidate.',
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
        required: true,
        description:
          'The structured patch, required: { name, content } — the existing skill\'s name and the full replacement ' +
          'SKILL.md text this candidate is materialized from and evaluated on. Nothing else is submitted here: the object\'s ' +
          'SKILL.contract.json, when it has one, is derived from production at evolution_prepare, and an unknown mutation ' +
          'field is refused by name.',
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
        return [
          `proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`,
          'ledger entry only — no branch created, nothing executed; mutation recorded — next: evolution_prepare (sandbox ' +
          'materialization), then evolution_replay (the two-sided experiment), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_candidate rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
