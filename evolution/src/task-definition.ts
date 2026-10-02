/** Task template candidates use the runtime's canonical library and the existing file commit. */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TaskTemplate, TemplateParameters, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { canonicalize, sha256Hex, taskTemplateDigest } from '@dangosys/dsh-singularity-task'
import { findTaskTemplates, parseTaskTemplate } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal, PreparedView } from './types.ts'
import type { CommitRequest } from './commit.ts'
import { assertOnlyKeys, isRecord, nonEmpty } from './shared.ts'
import { readVerifiedFile } from '@dangosys/dsh-singularity-task-runtime'

export interface CriterionRepairExample {
  taskId: string
  sourceDir: string
  parameters: TemplateParameters
}
export interface TaskDefinitionMutation {
  template: TaskTemplate
  criterionRepair?: { positive: CriterionRepairExample; negative: CriterionRepairExample }
}
export interface TaskDefinitionIdentity {
  template: TaskTemplate
  digest: string
  sha256: string
}
export interface FrozenCriterionExample extends CriterionRepairExample {
  snapshotDigest: string
  contractDigest: string
}
export interface FrozenTaskDefinition {
  candidate: TaskDefinitionIdentity
  baseline: TaskDefinitionIdentity | null
  libraries: { baseline: string; candidate: string }
  criterionRepair?: { positive: FrozenCriterionExample; negative: FrozenCriterionExample }
  guardVerifierVersions?: Record<string, string>
}

export function validateTaskDefinitionMutation(raw: unknown): TaskDefinitionMutation {
  if (!isRecord(raw)) throw new Error('evolution: task_definition mutation must be an object')
  assertOnlyKeys(raw, ['template', 'criterionRepair'], 'task_definition mutation')
  const template = parseTaskTemplate(raw.template)
  if (raw.criterionRepair !== undefined) {
    if (!isRecord(raw.criterionRepair))
      throw new Error('evolution: criterionRepair requires positive and negative existing examples')
    assertOnlyKeys(raw.criterionRepair, ['positive', 'negative'], 'criterionRepair')
    for (const label of ['positive', 'negative']) {
      const example = raw.criterionRepair[label]
      if (!isRecord(example)) throw new Error(`evolution: criterionRepair.${label} must be an existing example`)
      assertOnlyKeys(example, ['taskId', 'sourceDir', 'parameters'], `criterionRepair.${label}`)
      nonEmpty(example.taskId, `criterionRepair.${label}.taskId`)
      nonEmpty(example.sourceDir, `criterionRepair.${label}.sourceDir`)
      if (!isRecord(example.parameters))
        throw new Error(`evolution: criterionRepair.${label}.parameters must be an object`)
    }
    if (
      (raw.criterionRepair.positive as CriterionRepairExample).taskId ===
      (raw.criterionRepair.negative as CriterionRepairExample).taskId
    ) {
      throw new Error('evolution: criterion repair requires distinct positive and negative examples')
    }
  }
  return {
    template,
    ...(raw.criterionRepair === undefined
      ? {}
      : { criterionRepair: structuredClone(raw.criterionRepair) as TaskDefinitionMutation['criterionRepair'] }),
  }
}

export function templateBytes(template: TaskTemplate): Buffer {
  return Buffer.from(`${JSON.stringify(template, null, 2)}\n`)
}
export function templateIdentity(template: TaskTemplate): TaskDefinitionIdentity {
  return { template, digest: taskTemplateDigest(template), sha256: sha256Hex(templateBytes(template)) }
}
export function assertTemplateIdentity(raw: unknown): asserts raw is TaskDefinitionIdentity {
  if (!isRecord(raw)) throw new Error('evolution: template identity must be an object')
  const template = parseTaskTemplate(raw.template)
  if (raw.digest !== taskTemplateDigest(template) || raw.sha256 !== sha256Hex(templateBytes(template))) {
    throw new Error('evolution: template identity does not match canonical TaskTemplate content')
  }
}

export async function prepareTaskDefinition(
  root: string,
  library: string,
  proposal: EvolutionProposal,
): Promise<PreparedView> {
  const mutation = validateTaskDefinitionMutation(proposal.mutation)
  const candidate = mutation.template
  if (candidate.id !== proposal.targetId) throw new Error('evolution: template id must match task_definition targetId')
  const baseline = (await findTaskTemplates(library)).find(item => item.template.id === candidate.id)?.template
  if (
    candidate.version !== (baseline?.version ?? 0) + 1 ||
    proposal.baseVersion !== (baseline === undefined ? 'absent' : String(baseline.version))
  ) {
    throw new Error('evolution: template candidate must append the next version of the current baseVersion')
  }
  const repaired =
    baseline !== undefined &&
    canonicalize(baseline.contract.acceptanceCriteria) !== canonicalize(candidate.contract.acceptanceCriteria)
  if (repaired && mutation.criterionRepair === undefined) {
    throw new Error(
      'evolution: changing child criteria requires existing positive and negative examples plus the independent parent oracle',
    )
  }
  if (!repaired && mutation.criterionRepair !== undefined)
    throw new Error('evolution: criterionRepair is only required when child criteria change')
  const sandbox = `sandbox/${proposal.proposalId}`
  const files: string[] = []
  // Freeze the same complete library in both arms. Existing versions remain bindable.
  for (const side of ['baseline', 'candidate']) {
    const destination = join(root, sandbox, 'task-templates', side)
    await mkdir(destination, { recursive: true })
    for (const file of (
      await readdir(library).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    ).filter(file => file.endsWith('.json'))) {
      const bytes = await readVerifiedFile(library, file)
      const template = parseTaskTemplate(JSON.parse(bytes.toString()))
      if (file !== `${template.id}@${template.version}.json`)
        throw new Error('evolution: template library filename mismatch')
      await writeFile(join(destination, file), bytes)
      files.push(`task-templates/${side}/${file}`)
    }
  }
  const candidateFile = `task-templates/candidate/${candidate.id}@${candidate.version}.json`
  await writeFile(join(root, sandbox, candidateFile), templateBytes(candidate))
  files.push(candidateFile)
  if (baseline !== undefined) {
    const rollback = { ...baseline, version: candidate.version + 1 }
    const rollbackFile = `task-templates/rollback/${rollback.id}@${rollback.version}.json`
    await mkdir(join(root, sandbox, 'task-templates/rollback'), { recursive: true })
    await writeFile(join(root, sandbox, rollbackFile), templateBytes(rollback))
    files.push(rollbackFile)
  }
  return {
    sandbox,
    mechanical: true,
    champion: baseline === undefined ? 'absent' : 'captured',
    templateCandidate: templateIdentity(candidate),
    templateBaseline: baseline === undefined ? null : templateIdentity(baseline),
    templateLibraries: {
      baseline: await templateLibraryDigest(join(root, sandbox, 'task-templates/baseline')),
      candidate: await templateLibraryDigest(join(root, sandbox, 'task-templates/candidate')),
    },
    files,
  }
}

export async function readTaskDefinition(root: string, proposal: EvolutionProposal): Promise<FrozenTaskDefinition> {
  const prepared = proposal.prepared
  const candidate = prepared?.templateCandidate
  const baseline = prepared?.templateBaseline
  if (prepared?.sandbox == null || candidate === undefined || baseline === undefined)
    throw new Error('evolution: task_definition has no prepared templates')
  for (const [side, identity] of [
    ['candidate', candidate],
    ['baseline', baseline],
  ] as const) {
    if (identity === null) continue
    assertTemplateIdentity(identity)
    const bytes = await readVerifiedFile(
      root,
      `${prepared.sandbox}/task-templates/${side}/${identity.template.id}@${identity.template.version}.json`,
    )
    if (sha256Hex(bytes) !== identity.sha256) throw new Error('evolution: prepared TaskTemplate bytes changed')
  }
  if (prepared.templateLibraries === undefined)
    throw new Error('evolution: prepared template libraries have no frozen digests')
  for (const side of ['baseline', 'candidate'] as const) {
    if (
      (await templateLibraryDigest(join(root, prepared.sandbox, 'task-templates', side))) !==
      prepared.templateLibraries[side]
    )
      throw new Error('evolution: frozen template library changed')
  }
  return {
    candidate: structuredClone(candidate),
    baseline: structuredClone(baseline),
    libraries: { ...prepared.templateLibraries },
  }
}

export async function assertTemplateBaseline(
  library: string,
  proposal: EvolutionProposal,
  applied = false,
): Promise<void> {
  const identity = applied ? proposal.prepared?.templateCandidate : proposal.prepared?.templateBaseline
  if (identity === undefined) throw new Error('evolution: no frozen template baseline')
  const current = (await findTaskTemplates(library)).find(
    item => item.template.id === proposal.prepared!.templateCandidate!.template.id,
  )
  if ((current?.templateRef.digest ?? null) !== (identity?.digest ?? null))
    throw new Error('evolution: template library changed since the frozen baseline; nothing was appended')
}

export function templateCommitRequest(
  root: string,
  library: string,
  proposal: EvolutionProposal,
  direction: 'apply' | 'rollback',
  actor: string,
  approvalRef: string,
): CommitRequest {
  const prepared = proposal.prepared!
  if (direction === 'rollback' && prepared.templateBaseline === null) {
    const candidate = prepared.templateCandidate!
    return {
      proposalId: proposal.proposalId,
      direction,
      actor,
      approvalRef,
      files: [
        {
          target: resolve(library, `${candidate.template.id}@${candidate.template.version}.json`),
          baselineSha256: candidate.sha256,
          contentSha256: null,
        },
      ],
    }
  }
  const template =
    direction === 'apply'
      ? prepared.templateCandidate!.template
      : { ...prepared.templateBaseline!.template, version: prepared.templateCandidate!.template.version + 1 }
  const identity = templateIdentity(template)
  const side = direction === 'apply' ? 'candidate' : 'rollback'
  return {
    proposalId: proposal.proposalId,
    direction,
    actor,
    approvalRef,
    files: [
      {
        target: resolve(library, `${template.id}@${template.version}.json`),
        baselineSha256: null,
        contentSha256: identity.sha256,
        source: `${prepared.sandbox}/task-templates/${side}/${template.id}@${template.version}.json`,
      },
    ],
  }
}

export function independentOracleCriteria(task: TaskSnapshot['tasks'][number]) {
  return task.acceptanceCriteria.filter(
    criterion =>
      criterion.mandatory &&
      criterion.verificationMode === 'deterministic' &&
      criterion.command &&
      !criterion.heuristic &&
      !criterion.childEvidence?.length,
  )
}

export function oracleContractDigest(task: TaskSnapshot['tasks'][number]): string {
  return sha256Hex(
    canonicalize({
      acceptanceCriteria: independentOracleCriteria(task),
      requiredCapabilities: task.requestedCapabilities,
    }),
  )
}

export async function templateLibraryDigest(directory: string): Promise<string> {
  const files = (await readdir(directory)).sort()
  const identities: string[] = []
  for (const file of files) {
    const bytes = await readVerifiedFile(directory, file)
    const template = parseTaskTemplate(JSON.parse(bytes.toString()))
    if (file !== `${template.id}@${template.version}.json`)
      throw new Error('evolution: frozen template library filename mismatch')
    identities.push(`${file}:${sha256Hex(bytes)}`)
  }
  return sha256Hex(identities.join('\n'))
}
