/** Rejudge fixed existing examples; the candidate child judge must reject the known negative. */
import { resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { bindTaskTemplate, normalizeRootContract } from '@dangosys/dsh-singularity-task-runtime'
import type { ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { ExperimentSources, ExperimentView } from './freeze.ts'
import { buildWorkspace } from './workspace.ts'
import { directoryDigest, latestReview } from './record.ts'
import { independentOracleCriteria, oracleContractDigest } from '../task-definition.ts'

export function criterionGuardLineage(experimentId: string, label: 'positive' | 'negative', oracle = false): string {
  return `evolution-experiment:${experimentId}:criterion-${label}${oracle ? '-oracle' : ''}:candidate`
}

export async function criterionGuardContract(root: string, view: ExperimentView, label: 'positive' | 'negative') {
  const definition = view.frozen.taskDefinition!
  const candidate = definition.candidate
  const bound = await bindTaskTemplate(root, {
    templateRef: { id: candidate.template.id, version: candidate.template.version, digest: candidate.digest },
    templateParameters: definition.criterionRepair![label].parameters,
  })
  const normalized = normalizeRootContract(bound)
  if (!normalized.ok)
    throw new Error(`evolution: criterion example parameters rejected: ${normalized.reasons.join('; ')}`)
  return normalized.contract
}

export async function runCriterionGuards(
  sources: ExperimentSources,
  view: ExperimentView,
  caller: SessionId,
  _actor: string,
  agentOptions: ReplayTaskOptions['agentOptions'],
  signal?: AbortSignal,
): Promise<void> {
  const repair = view.frozen.taskDefinition?.criterionRepair
  if (repair === undefined) return
  if (view.storeId === undefined) throw new Error('evolution: criterion repair experiment has no task store')
  const candidateRoot = resolve(sources.evolution.root, `sandbox/${view.proposalId}/task-templates/candidate`)
  for (const label of ['positive', 'negative'] as const) {
    const example = repair[label]
    let snapshot = await sources.task.openStore(view.storeId)
    const source = snapshot.tasks.find(task => task.taskId === example.taskId)
    if (
      source === undefined ||
      oracleContractDigest(source) !== example.contractDigest ||
      (await directoryDigest(example.sourceDir)) !== example.snapshotDigest
    )
      throw new Error('evolution: frozen criterion example or its independent oracle changed')
    const expected = label === 'positive' ? 'verified' : 'failed'
    // Reproduce the label under the fixed outer oracle before checking the changed child judge.
    for (const oracle of [true, false]) {
      const lineage = criterionGuardLineage(view.experimentId, label, oracle)
      const existing = snapshot.tasks.find(task => task.objective.startsWith(`[${lineage}] `))
      if (existing !== undefined) {
        if (existing.status !== expected || latestReview(snapshot, existing)?.outcome !== expected)
          throw new Error(
            `evolution: ${label} criterion promotion guard failed under ${oracle ? 'independent parent oracle' : 'candidate child criteria'}`,
          )
        continue
      }
      if (signal?.aborted) throw new Error('evolution: criterion guard interrupted')
      const workspace = await buildWorkspace(
        example.sourceDir,
        resolve(
          sources.evolution.root,
          `sandbox/${view.proposalId}/exp-${view.experimentId}/criterion-${label}${oracle ? '-oracle' : ''}`,
        ),
        example.snapshotDigest,
      )
      const contract = oracle
        ? {
            objective: source.objective,
            acceptanceCriteria: independentOracleCriteria(source),
            requiredCapabilities: source.requestedCapabilities,
          }
        : await criterionGuardContract(candidateRoot, view, label)
      const outcome = await sources.taskRuntime.replayTask(
        view.storeId,
        example.taskId,
        {
          lineage,
          spawn: false,
          workspace: { path: workspace, ...(view.frozen.snapshot.rebaseFrom === undefined ? {} : { rebaseFrom: view.frozen.snapshot.rebaseFrom }) },
          ...(contract === undefined
            ? {}
            : {
                contract: {
                  objective: contract.objective,
                  acceptanceCriteria: contract.acceptanceCriteria,
                  requiredCapabilities: contract.requiredCapabilities,
                },
              }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
          ...(signal === undefined ? {} : { signal }),
        },
        caller,
      )
      if (outcome.status !== expected)
        throw new Error(
          `evolution: ${label} criterion promotion guard failed under ${oracle ? 'independent parent oracle' : 'candidate child criteria'}: expected ${expected}, got ${outcome.status}`,
        )
      snapshot = await sources.task.openStore(view.storeId)
    }
  }
}
