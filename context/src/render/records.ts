/** The five record renderings and the run-binding summary (A2 §D). @module @dangosys/dsh-singularity-context/render-records */

import type {
  Diagnosis,
  EvidenceBundle,
  ReviewRecord,
  RunProviderBinding,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { RunBindingRead } from '@dangosys/dsh-singularity-task-runtime'
import type { ReadOnlyTaskRuntime } from '../bindings/types.ts'
import { message } from '../refusals.ts'
import { artifactLine, contractLines, criteriaLines, protectedInputsDetail, runPhaseSuffix } from './fields.ts'

/** The first 12 hex of a digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

/** Render one run's binding summary; without `read` no readability claim is made. */
export function renderRunBinding(binding: RunProviderBinding | undefined, read?: RunBindingRead): string {
  if (binding === undefined) return ''
  const lines: string[] = []
  for (const capability of binding.capabilities) {
    const selected = binding.skills.filter(skill => skill.capabilities.includes(capability))
    if (selected.length === 0) {
      lines.push(`- capability \`${capability}\`: no provider skill — the capability's tools are granted without one`)
      continue
    }
    for (const skill of selected) {
      const contract = skill.contractDigest === null ? '' : `, contract ${shortDigest(skill.contractDigest)}`
      const gaps = skill.uncovered.length === 0 ? '' : ` · not covered by this binding: ${skill.uncovered.join(', ')}`
      lines.push(
        `- capability \`${capability}\` → skill \`${skill.name}\` [${skill.role}] — ${skill.description} (content ${shortDigest(skill.contentDigest)}${contract})${gaps}`,
      )
    }
  }
  if (binding.mcpServers.length > 0) {
    lines.push(
      `- MCP servers mounted for this run: ${binding.mcpServers.map(server => `\`${server.serverName}\`${server.templateDigest === null ? '' : ` (template ${shortDigest(server.templateDigest)})`}`).join(', ')}`,
    )
  }
  if (lines.length === 0) return ''
  const header = [
    '## Implementation chosen for this run',
    '',
    `- registry revision: ${shortDigest(binding.registryRevision)}`,
    ...lines,
    // The snapshot path is rendered, not described: the views that read this
    // summary act on it, and a binding that names no snapshot says so.
    ...(binding.snapshotRoot === undefined
      ? [
          '- this run bound no content snapshot; it cannot supply guidance to a model request',
        ]
      : [
          `- bound content snapshot: ${binding.snapshotRoot}`,
          '- the contract context loads the full Skill instructions from this frozen snapshot before task execution',
        ]),
  ]
  if (read !== undefined && read.defects.length > 0) {
    // Named, never softened: a reader told this run's content is unavailable
    // must not go looking for a newer version at the production path.
    header.push(
      '',
      "Bound content is not readable: the snapshot no longer matches this run's record, and the production skill path is not a substitute for it.",
      ...read.defects.map(defect => `- ${defect}`),
    )
  }
  return header.join('\n')
}

/** The run binding block: the summary re-checked, or its re-check failure stated in its place. */
export async function bindingLines(
  taskRuntime: ReadOnlyTaskRuntime,
  binding: RunProviderBinding | undefined,
): Promise<string[]> {
  if (binding === undefined) return []
  let summary: string
  try {
    summary = renderRunBinding(binding, await taskRuntime.readRunBinding(binding))
  } catch (error) {
    summary = [
      '## Implementation chosen for this run',
      '',
      `- bound content could not be re-read against its snapshot: ${message(error)}`,
    ].join('\n')
  }
  return summary.length === 0 ? [] : ['', ...summary.split('\n')]
}

function jsonBlock(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```']
}

/** The complete rendering of one task record. */
export function taskRecordText(task: TaskInstance): string {
  const contract = task.contract
  const lines: string[] = [
    `task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth} ` +
      `taskType ${task.definitionRef.taskType}@${task.definitionRef.version}`,
    `parent: ${task.parentTaskId ?? '(none — this is a parentless record)'}`,
    `objective: ${task.objective}`,
  ]
  lines.push(
    'acceptance criteria:',
    ...(task.acceptanceCriteria.length === 0 ? ['(none)'] : criteriaLines(task.acceptanceCriteria)),
  )
  for (const criterion of task.acceptanceCriteria) {
    const extras: string[] = []
    if (criterion.requiredEvidence.length > 0)
      extras.push(`  required evidence: ${criterion.requiredEvidence.join(', ')}`)
    if (criterion.requiresArtifact !== undefined && criterion.requiresArtifact.length > 0) {
      extras.push(`  requires artifact: ${criterion.requiresArtifact.join(', ')}`)
    }
    if (criterion.acceptsArtifact !== undefined && criterion.acceptsArtifact.length > 0) {
      extras.push(`  accepts artifact: ${criterion.acceptsArtifact.join(', ')}`)
    }
    if (criterion.verifierRef !== undefined) extras.push(`  verifier: ${criterion.verifierRef}`)
    for (const child of criterion.childEvidence ?? []) {
      extras.push(
        `  child evidence: run member #${child.childIndex}` +
          `${child.criterionId === undefined ? '' : ` criterion ${child.criterionId}`}` +
          `${child.evidenceRef === undefined ? '' : ` ref ${child.evidenceRef}`}`,
      )
    }
    extras.push(...protectedInputsDetail(criterion))
    if (extras.length > 0) lines.push(...extras)
  }
  lines.push(
    `requested capabilities: ${task.requestedCapabilities.length === 0 ? '(none)' : task.requestedCapabilities.join(', ')}`,
  )
  if (task.requiresIndependentAcceptance === true) lines.push('requires independent acceptance: yes')
  lines.push(...contractLines(task))
  if (contract !== undefined) lines.push(`contract version: ${contract.contractVersion}`)
  lines.push(`runs: ${task.runIds.length === 0 ? '(none)' : task.runIds.join(', ')}`)
  lines.push(`children: ${task.childTaskIds.length === 0 ? '(none)' : task.childTaskIds.join(', ')}`)
  return lines.join('\n')
}

/** The complete rendering of one run record, with the binding re-check appended. */
export async function runRecordText(
  taskRuntime: ReadOnlyTaskRuntime,
  run: TaskRun,
  snapshot?: TaskSnapshot,
): Promise<string> {
  const { providerBinding, ...record } = run
  const lines: string[] = [
    `run ${run.runId} of task ${run.taskId} [${run.status}]${runPhaseSuffix(run, snapshot)}`,
    `session: ${run.sessionId}${run.parentRunId === undefined ? '' : ` · parent run: ${run.parentRunId}`}`,
    `started: ${run.startedAt}${run.finishedAt === undefined ? '' : ` · finished: ${run.finishedAt}`}`,
    `capabilities: ${run.capabilitySnapshot.length === 0 ? '(none)' : run.capabilitySnapshot.join(', ')}`,
    ...(run.agentPreset === undefined ? [] : [`agent preset: ${run.agentPreset}`]),
    'artifacts:',
    ...(run.artifacts.length === 0 ? ['(none)'] : run.artifacts.map(artifact => `- ${artifactLine(artifact)}`)),
    'verifier results:',
    ...(run.verifierResults.length === 0
      ? ['(none)']
      : run.verifierResults.map(
          result =>
            `- ${result.criterionId} [${result.status}] verifier ${result.verifierId}` +
            `${result.verifierVersion === undefined ? '' : ` v${result.verifierVersion}`}` +
            `${result.exitCode === undefined ? '' : ` exit ${result.exitCode}`}` +
            `${result.logRef === undefined ? '' : ` log ${result.logRef}`}`,
        )),
    '',
    'recorded fields:',
    ...jsonBlock(record),
  ]
  lines.push(...(await bindingLines(taskRuntime, providerBinding)))
  return lines.join('\n')
}

/** The complete rendering of one evidence bundle. */
export function evidenceRecordText(snapshot: TaskSnapshot, evidence: EvidenceBundle): string {
  return [
    `evidence ${evidence.evidenceId} of task ${evidence.taskId} (run ${evidence.taskRunId}), generated ${evidence.generatedAt}`,
    '',
    ...jsonBlock(evidence),
    '',
    `run state: ${snapshot.runs.find(run => run.runId === evidence.taskRunId)?.status ?? '(the run this evidence names is not in this store)'}`,
  ].join('\n')
}

/** The complete rendering of one review record, identified by its `(taskId, runId)` pair. */
export function reviewRecordText(review: ReviewRecord): string {
  const runPart =
    review.runId === undefined ? 'no run — the task blocked before any run started' : `run ${review.runId}`
  return [
    `review of task ${review.taskId} (${runPart}) [${review.outcome}]`,
    `evidence refs: ${review.evidenceRefs.length === 0 ? '(none)' : review.evidenceRefs.join(', ')}`,
    '',
    ...jsonBlock(review),
  ].join('\n')
}

/** The complete rendering of one diagnosis record. */
export function diagnosisRecordText(diagnosis: Diagnosis): string {
  return [
    `diagnosis ${diagnosis.diagnosisId} of task ${diagnosis.taskId} [confidence ${diagnosis.confidence}]`,
    `postmortem observation: ${diagnosis.observedFailure}`,
    `localized cause: ${diagnosis.localizedCause}`,
    '',
    ...jsonBlock(diagnosis),
  ].join('\n')
}
