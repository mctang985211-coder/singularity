import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_prepare: missing agent id')
  return id
}

export function defineEvolutionPrepareTool(ctx: Context) {
  return defineTool({
    name: 'evolution_prepare',
    description:
      "Materialize a skill candidate's structured mutation into the proposal sandbox (status: prepared). Writes go only to " +
      '.dsh/evolution/sandbox/<proposalId>/ — skills/<name>/SKILL.md for the candidate — plus a champion/ snapshot of the ' +
      "production SKILL.md (champion: null when the production skill does not exist yet). A proposal of any other target type " +
      'cannot become a candidate and has nothing to prepare. Nothing here touches production; the next step is evolution_replay, ' +
      'the two-sided experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Skill candidate carrying a mutation, to materialize into its sandbox' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      try {
        const prepared = await ctx.evolution.prepare(args.proposalId, caller)
        const view = prepared.prepared!
        const championText = view.champion === 'captured'
          ? 'champion snapshot: captured under champion/'
          : 'champion snapshot: none — champion: null (the production target does not exist yet)'
        // P3: the production baseline the later apply compares against — the
        // digest of the same single production read that produced the snapshot.
        const baselineText = view.skillBaseline === undefined
          ? 'production baseline: none — the production skill does not exist yet (an apply refuses if one appears)'
          : `production baseline: ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}… (an apply refuses if the production skill changed since this read)`
        return [
          `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
          ...view.files.map(file => `  wrote ${file}`),
          championText,
          baselineText,
          'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
