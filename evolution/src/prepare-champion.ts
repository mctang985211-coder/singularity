/**
 * Champion resolution for `evolution_prepare`: the pieces of a prepare the
 * caller has to supply because the production state they describe lives outside
 * this plane.
 *
 * Plane separation holds: the ledger itself never reads the task store or the
 * capability registry. Skill and agent_preset champions the ledger reads from
 * the production roots directly; a capability champion is the mutation-named
 * row of the *effective* registry (the table a restart re-reads from
 * `config.yml`), and a task_definition champion is the base definition's
 * snapshot out of the task store — both of which only the caller's own context
 * can read, and both of which are resolved here so the model-facing adapter
 * holds no rule about what a champion is.
 *
 * The model-facing tool adapter (`evolution_prepare`, in
 * `@dangosys/dsh-singularity-agent`) declares the tool's schema, extracts the
 * caller, and renders the result.
 * @module dsh-singularity-evolution/prepare-champion
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityMutation, EvolutionProposal, PrepareChampion } from './evolution.ts'

/**
 * The graph / task / task-runtime services champion resolution reads, as the
 * caller's context holds them — only the members used here.
 */
export interface PrepareChampionSources {
  readonly graphs: { graphForSession(sessionId: SessionId): Promise<{ readonly rootSessionId: SessionId }> }
  readonly task: { openStore(storeId: string): Promise<TaskSnapshot> }
  readonly taskRuntime: { listCapabilities(): Readonly<Record<string, CapabilityConfig>> }
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
  sources: PrepareChampionSources,
  caller: SessionId,
  targetId: string,
  baseVersion: string,
): Promise<Record<string, unknown> | null> {
  const version = Number(baseVersion.replace(/^v/, ''))
  if (!Number.isInteger(version)) return null
  try {
    const graph = await sources.graphs.graphForSession(caller)
    const snapshot = await sources.task.openStore(rootTaskStoreId(graph.rootSessionId))
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

/**
 * Resolve the caller-supplied half of a prepare: the capability champion from
 * the effective registry, the task_definition champion from the task store;
 * skill / preset champions the ledger reads from the production roots itself.
 * A capability prepare whose row is absent records `null` — the capability is
 * new — while a task_definition whose base definition is unresolvable also
 * records `null`.
 */
export async function resolvePrepareChampion(
  sources: PrepareChampionSources,
  proposal: EvolutionProposal,
  caller: SessionId,
): Promise<PrepareChampion> {
  const champion: PrepareChampion = {}
  if (proposal.targetType === 'capability' && proposal.mutation !== undefined) {
    const name = (proposal.mutation as CapabilityMutation).name
    champion.capabilityEntry = sources.taskRuntime.listCapabilities()[name] ?? null
  }
  if (proposal.targetType === 'task_definition') {
    champion.taskDefinition = await definitionChampion(sources, caller, proposal.targetId, proposal.baseVersion)
  }
  return champion
}
