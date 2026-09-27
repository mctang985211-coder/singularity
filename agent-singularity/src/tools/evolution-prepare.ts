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
      "Materialize a skill candidate's structured mutation into the proposal sandbox (status: prepared). What is prepared is " +
      'the complete object the candidate improves: a guidance skill is its `SKILL.md` alone, and an execution skill is ' +
      '`SKILL.md` plus the `SKILL.contract.json` beside it, derived from the production declaration with only ' +
      'content.skillMdSha256 recomputed — the model never submits a sidecar. One verified read of the production object ' +
      'comes first — it yields both the champion/ snapshot and the baseline identity a later apply compares against — and a ' +
      'target that is not there, or is not the loadable object its files claim (a defective declaration, an undeclared ' +
      'file), is refused by name before any sandbox or ledger write, never prepared against nothing. A knowledge sidecar, an ' +
      'object declaring resources and a non-skill proposal are refused by name too, and production fixes the shape: this ' +
      'path cannot add a `SKILL.contract.json` to a skill that has none, and it never changes the object\'s role. Writes go ' +
      'only to the proposal sandbox ' +
      '(<ledger root>/sandbox/<proposalId>/: `skills/<name>/SKILL.md` — plus `skills/<name>/SKILL.contract.json` for an ' +
      'execution object — and the same paths under `champion/` for the production bytes the snapshot captures). Nothing ' +
      'here touches production; the next step is evolution_replay, the two-sided experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Skill candidate carrying a mutation, to materialize into its sandbox' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      try {
        const prepared = await ctx.evolution.prepare(args.proposalId, caller)
        const view = prepared.prepared!
        // The fold admits one prepared shape: a materialized skill prepare that
        // carries both content identities (P2/P3), so the render reads the
        // champion and the production baseline straight off the record.
        const baseline = view.skillBaseline!
        return [
          `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
          ...view.files.map(file => `  wrote ${file}`),
          view.skillContent!.contract === undefined
            ? 'candidate object: guidance (one file, SKILL.md)'
            : 'candidate object: execution provider (SKILL.md + SKILL.contract.json) — the sidecar is derived from production ' +
              'with only content.skillMdSha256 rewritten, so this candidate cannot move a capability, a required tool or a verifier',
          'champion snapshot: captured under champion/',
          `production baseline: ${baseline.name} sha256:${baseline.sha256.slice(0, 12)}… (an apply refuses if the production ` +
            'object changed since this read)',
          'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
