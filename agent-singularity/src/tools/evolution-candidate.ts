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
      'for the branch model only: no branch is created and nothing is executed or changed. Optionally attach a structured ' +
      'mutation — the patch description; a candidate carrying one must pass evolution_prepare (sandbox materialization) ' +
      'and evolution_replay (candidate vs champion over this graph\'s terminal tasks) before evolution_gate, a candidate without one gates directly.',
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
          'Optional structured patch description, shape fixed by targetType — skill: { name, content } (full SKILL.md text); ' +
          'agent_preset: { presetId, files: [{ path, content }] } (paths relative to the preset dir); capability: ' +
          '{ name, entry } (entry = { skills?, tools?, preset?, permission?, mcpServers? }); task_definition: { baseVersion, definition }. ' +
          'The other five target types take a free-form object, recorded mechanical: false (bookkeeping only).',
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
          ? 'next: evolution_gate'
          : 'mutation recorded — next: evolution_prepare (sandbox materialization), then evolution_replay (candidate vs champion), then evolution_gate'
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
