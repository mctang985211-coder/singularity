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
      'aligns to (e.g. taskDefinition / skill / capabilityTable / agentPreset / verifier / runtimePolicy versions). ' +
      'Bookkeeping for the branch model only: no branch is created and nothing is executed or changed. This build admits ' +
      'two candidate lifecycles, both shaped by the proposal\'s target type: ' +
      '(1) a same-name improvement of an existing skill as a whole loadable object — the mutation { name, content } carries ' +
      'the full replacement SKILL.md text and nothing else, because `content` is the whole new body rather than a diff, no ' +
      'sidecar patch and no resource is accepted; evolution_prepare derives the SKILL.contract.json from the production ' +
      'declaration with only content.skillMdSha256 recomputed, so a content update can never move a capability, a required ' +
      'tool, a verifier or a port. ' +
      '(2) one whole capability row, with an optional new execution skill — the mutation { rows, skill? }, where `rows` holds ' +
      'exactly one row ({ skills, tools?, preset?, permission?, mcpServers? }: no field is inherited from the row it ' +
      'replaces) and `skill`, when given, is { name, content, sidecar } for a NEW execution object (SKILL.md plus the ' +
      'existing SKILL.contract.json protocol, resources: [], granting that row, judged by a registered verifier). The new ' +
      'row may not grant a tool or mount a server this deployment has not already authorized, and may not move the preset ' +
      'or permission a worker runs under; improving an existing skill is the same-name path, never a new name. ' +
      'Unknown mutation fields are refused by name, and so is a proposal of any other target type — it stays a record, ' +
      'because evolution_propose may record a suggestion no executor exists for. Either candidate must then pass ' +
      'evolution_prepare (sandbox materialization) and evolution_replay (the two-sided experiment) before evolution_gate.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Proposal to move into candidate' },
      versionSet: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Complete version set the candidate aligns to: name → version string, at least one entry',
      },
      mutation: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            description:
              'A skill candidate: the existing skill\'s name and the full replacement SKILL.md text this candidate is ' +
              'materialized from and evaluated on. The object\'s SKILL.contract.json, when it has one, is derived from ' +
              'production at evolution_prepare with only content.skillMdSha256 recomputed.',
            properties: {
              name: { type: 'string', required: true, description: 'The existing skill\'s name (a single safe path segment)' },
              content: { type: 'string', required: true, description: 'The whole replacement SKILL.md text (frontmatter included)' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            description:
              'A capability candidate: exactly one capability row, whole, plus optionally one NEW execution skill the row grants.',
            properties: {
              rows: {
                type: 'object',
                additionalProperties: true,
                required: true,
                description:
                  'Exactly one entry — the row name mapped to its whole configuration { skills: [names, at least one], ' +
                  'tools?: [labels], preset?, permission?, mcpServers?: [names] }. No field is inherited from the row it ' +
                  'replaces: a tool or server the table does not already authorize, and a preset or permission different from ' +
                  'the row being replaced, are refused by name.',
              },
              skill: {
                type: 'object',
                additionalProperties: true,
                description:
                  'The optional new execution skill this row grants: { name, content, sidecar } — a name no discovery finds, ' +
                  'the whole SKILL.md text, and its SKILL.contract.json declaration (type "execution", resources: [], ' +
                  'capabilities including this row, a registered verifier). A renamed copy of an existing production object is refused.',
              },
            },
          },
        ],
        required: true,
        description:
          'The structured patch, required, shaped by the proposal\'s target type: { name, content } for a skill proposal, or ' +
          '{ rows, skill? } for a capability proposal. An unknown mutation field is refused by name.',
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
