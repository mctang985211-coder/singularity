import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { resolvePrepareChampion } from '@dangosys/dsh-singularity-evolution'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_prepare: missing agent id')
  return id
}

export function defineEvolutionPrepareTool(ctx: Context) {
  return defineTool({
    name: 'evolution_prepare',
    description:
      "Materialize a candidate's structured mutation into the proposal sandbox (status: prepared). Writes go only to " +
      '.dsh/evolution/sandbox/<proposalId>/ — skills/<name>/SKILL.md for a skill, .agent-presets/<presetId>/… for an ' +
      'agent_preset, capability-table.patch.yml (whole-row replacement semantics) for a capability, task-definition.json ' +
      'for a task_definition — plus a champion/ snapshot of the current production target (champion: null when it is ' +
      'new). The other five target types are bookkeeping-only (mechanical: false) and materialize nothing. Nothing here ' +
      'touches production; next step is evolution_replay for the mechanical types, evolution_gate for bookkeeping-only ones.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Candidate carrying a mutation, to materialize into its sandbox' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      // Champion resolution (capability: the effective registry; task_definition:
      // the task store; skill / preset: the production roots, read by the
      // ledger itself) belongs to the evolution package.
      const champion = await resolvePrepareChampion(
        { graphs: ctx.graphs, task: ctx.task, taskRuntime: ctx.taskRuntime },
        proposal,
        caller,
      )
      try {
        const prepared = await ctx.evolution.prepare(args.proposalId, caller, champion)
        const view = prepared.prepared!
        if (!view.mechanical) {
          return [
            `proposal ${prepared.proposalId} [prepared] bookkeeping only — ${prepared.targetType} mutations are not mechanically applied (mechanical: false)`,
            'ledger entry only — nothing materialized; next: evolution_gate',
          ].join('\n')
        }
        const championText = view.champion === 'captured'
          ? view.championSource === 'config-text'
            ? 'champion snapshot: captured under champion/ (config.yml row source text — rollback restores it verbatim)'
            : view.championSource === 'code-default'
              ? 'champion snapshot: captured under champion/ (code default, no config.yml row — rollback removes the applied row so the default governs again)'
              : 'champion snapshot: captured under champion/'
          : 'champion snapshot: none — champion: null (the production target does not exist yet)'
        // P3: the production baseline the later apply compares against — the
        // digest of the same single production read that produced the snapshot.
        const baselineText = prepared.targetType === 'skill'
          ? view.skillBaseline === undefined
            ? 'production baseline: none — the production skill does not exist yet (an apply refuses if one appears)'
            : `production baseline: ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}… (an apply refuses if the production skill changed since this read)`
          : null
        return [
          `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
          ...view.files.map(file => `  wrote ${file}`),
          championText,
          ...(baselineText === null ? [] : [baselineText]),
          'sandbox only — production was not touched; next: evolution_replay (candidate vs champion), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
