import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityMutation, PrepareChampion } from '../evolution.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_prepare: missing agent id')
  return id
}

/**
 * Champion anchor for a task_definition target. The task store keeps no
 * definitions registry — definition fields live denormalized on each task
 * instance — so the snapshot is the first instance matching
 * { taskType: targetId, version: baseVersion } ('v3' and '3' both read as 3),
 * reduced to the fields instances actually hold (decompositionPolicy and
 * budgetPolicy are not retained per instance). No match, or no store, means the
 * champion is unresolvable: null.
 */
async function definitionChampion(
  ctx: Context,
  caller: string,
  targetId: string,
  baseVersion: string,
): Promise<Record<string, unknown> | null> {
  const version = Number(baseVersion.replace(/^v/, ''))
  if (!Number.isInteger(version)) return null
  try {
    const graph = await ctx.graphs.graphForSession(caller)
    const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
    const task = snapshot.tasks.find(item => item.definitionRef.taskType === targetId && item.definitionRef.version === version)
    if (task === undefined) return null
    return {
      taskType: task.definitionRef.taskType,
      version: task.definitionRef.version,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredCapabilities: task.requestedCapabilities,
    }
  } catch {
    return null
  }
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
      // Champion resolution: capability reads the effective registry, task_definition
      // the task store; skill / preset champions the service reads from the
      // production roots itself.
      const champion: PrepareChampion = {}
      if (proposal.targetType === 'capability' && proposal.mutation !== undefined) {
        const name = (proposal.mutation as CapabilityMutation).name
        champion.capabilityEntry = ctx.taskRuntime.listCapabilities()[name] ?? null
      }
      if (proposal.targetType === 'task_definition') {
        champion.taskDefinition = await definitionChampion(ctx, caller, proposal.targetId, proposal.baseVersion)
      }
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
        return [
          `proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
          ...view.files.map(file => `  wrote ${file}`),
          championText,
          'sandbox only — production was not touched; next: evolution_replay (candidate vs champion), then evolution_gate',
        ].join('\n')
      } catch (error) {
        return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
