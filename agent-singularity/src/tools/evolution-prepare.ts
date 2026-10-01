import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { message, sessionId, text } from '../shared.ts'

export function defineEvolutionPrepareTool(ctx: Context) {
  return defineTool({
    name: 'evolution_prepare',
    description:
      "Materialize a candidate's structured mutation into the proposal sandbox (status: prepared). A skill candidate is prepared " +
      'as the complete object it improves: a guidance skill is its `SKILL.md` alone, and an execution skill is ' +
      '`SKILL.md` plus the `SKILL.contract.json` beside it, derived from the production declaration with only ' +
      'content.skillMdSha256 recomputed — the model never submits a sidecar. A capability candidate (A6) is prepared as its whole ' +
      'row, plus the new execution skill that row grants when it carries one; the baseline a later apply compares against is then ' +
      'the row the registry held, or its recorded absence. For an existing skill, one verified read of the production target ' +
      'comes first — it yields both the champion/ snapshot and the baseline identity a later apply compares against — and a ' +
      'target that is not there, or is not the loadable object its files claim (a defective declaration, an undeclared ' +
      'file), is refused by name before any sandbox or ledger write, never prepared against nothing. A knowledge sidecar, an ' +
      'object declaring resources and a proposal of any other kind are refused by name too; for an existing skill, production fixes the shape: this ' +
      'path cannot add a `SKILL.contract.json` to a skill that has none, and it never changes the object\'s role. Writes go ' +
      'only to the proposal sandbox ' +
      '(<ledger root>/sandbox/<proposalId>/: `skills/<name>/SKILL.md` — plus `skills/<name>/SKILL.contract.json` for an ' +
      'execution object — and the same paths under `champion/` for the production bytes the snapshot captures). Nothing ' +
      'here touches production; the next step is evolution_replay, the two-sided experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Skill or capability candidate carrying a mutation, to materialize into its sandbox' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_prepare')
      try {
        const prepared = await ctx.evolution.prepare(args.proposalId, caller)
        const view = prepared.prepared!
        if (view.capabilityRow !== undefined) {
          // The A6 arm: one capability row, plus the new execution skill when the
          // candidate carries one. The production baseline this arm compares
          const rowBaseline = view.capabilityBaseline ?? null
          return [
            `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
            ...view.files.map(file => `  wrote ${file}`),
            `candidate row: ${view.capabilityRow.name} sha256:${view.capabilityRow.digest.slice(0, 12)}…`,
            rowBaseline === null
              ? 'registry baseline: the table held no such row, so this candidate adds it'
              : `registry baseline: row sha256:${rowBaseline.digest.slice(0, 12)}… (an apply refuses if the registry row changed since this read)`,
            view.skillContent === undefined
              ? 'candidate object: the row alone — no new skill object is materialized'
              : 'candidate object: a new execution provider (SKILL.md + SKILL.contract.json) the row grants, judged by a registered ' +
                'verifier with resources: []',
            'sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate',
          ].join('\n')
        }
        // The skill arm: the fold admits one prepared shape, a materialized skill
        // prepare that carries both content identities (P2/P3), so the render reads
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
        return `evolution_prepare rejected: ${message(error)}`
      }
    },
  })
}
