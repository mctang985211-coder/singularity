/**
 * The three candidate adapters: each one parses its asset out of the candidate
 * revision, says what changed against the baseline, and proves the change was
 * really consumed. None of them owns an experiment, a verdict or a publish —
 * those live in `pipeline/`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { SKILL_SIDECAR_FILE, loadSkillSidecar, parseSkillFile, parseTaskTemplate } from '@dangosys/dsh-singularity-task-runtime'
import { assertCapabilityRow } from '../capability-candidate.ts'
import { proveAdmissionRefusal, proveSkillLoaded, proveTemplateConsumed } from '../evidence/consumption.ts'
import type { ConsumptionProof } from '../evidence/consumption.ts'
import { digestOf } from '../shared.ts'
import type {
  AssetContentIdentity,
  EvaluationPlan,
  GuardOutcome,
  MethodAssetKind,
  MethodDraft,
  RevisionView,
  TrialComparison,
} from '../types.ts'

/** One candidate file, as the adapter read it. */
export interface CandidateFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: Buffer
}

/** What one prepared candidate is: the files it holds and the asset identity it carries. */
export interface PreparedCandidate {
  readonly files: readonly CandidateFile[]
  readonly assetIdentity: AssetContentIdentity
  readonly change: { readonly kind: MethodAssetKind; readonly identity: string; readonly before: string | null; readonly after: string }
}

export interface PrepareInput {
  readonly draft: MethodDraft
  readonly revision: RevisionView
  readonly baseline: RevisionView
}

export interface SideDeltaInput {
  readonly draft: MethodDraft
  readonly baseline: RevisionView
  readonly candidate: RevisionView
  /** The capability rows the sample's contract requires. */
  readonly required: readonly string[]
}

/** What the candidate side holds that the baseline side does not. */
export interface AssetSideDelta {
  readonly skills: readonly string[]
  readonly capabilities: readonly string[]
  readonly note: string
}

export interface ConsumedInput {
  readonly plan: EvaluationPlan
  readonly comparison: TrialComparison
  readonly candidateReceipt: import('@dangosys/dsh-singularity-task').ExecutionReceipt
  readonly baselineReceipt?: import('@dangosys/dsh-singularity-task').ExecutionReceipt
}

export interface GuardInput {
  readonly plan: EvaluationPlan
  readonly trials: readonly TrialComparison[]
}

/** What one class of asset contributes to the single evaluation pipeline. */
export interface CandidateAdapter {
  readonly kind: MethodAssetKind
  /** Parse and read the candidate; any shape this build cannot represent is refused by name. */
  prepare(input: PrepareInput): Promise<PreparedCandidate>
  /** The candidate side's difference from the baseline side. */
  sideDelta(input: SideDeltaInput): AssetSideDelta
  /** The actual-consumption proof for this class of asset. */
  assertConsumed(input: ConsumedInput): ConsumptionProof
  /** The domain guard, when this class of asset has one. */
  guard(input: GuardInput): GuardOutcome | undefined
}

function assetIdentity(kind: MethodAssetKind, identity: string, digest: string, present: boolean): AssetContentIdentity {
  return { kind, identity, digest, present }
}

function bytesOf(bytes: Buffer, path: string): CandidateFile {
  return { path, sha256: sha256Hex(bytes), bytes }
}

/** One skill object read out of a revision directory, with every declared resource and its sidecar. */
export async function readSkillObject(
  revision: RevisionView,
  name: string,
): Promise<{ files: CandidateFile[]; contentDigest: string; contractDigest: string | null }> {
  const directory = join(revision.skillRoot, name)
  const loaded = await loadSkillSidecar(directory)
  if (loaded.content === undefined) {
    throw new Error(`evolution: the candidate revision holds no skill "${name}" at ${directory}`)
  }
  if (loaded.defects.length > 0 || loaded.uncovered.length > 0) {
    throw new Error(
      `evolution: the candidate skill "${name}" is not a loadable object — ` +
        `${loaded.defects.map(defect => `${defect.code}: ${defect.detail}`).join('; ') || loaded.uncovered.join(', ')}`,
    )
  }
  const skillMd = await readFile(join(directory, 'SKILL.md'))
  const parsed = parseSkillFile(skillMd.toString('utf8'), join(directory, 'SKILL.md'))
  if (parsed.name !== name) {
    throw new Error(`evolution: the candidate skill "${name}" declares "${parsed.name}" in its frontmatter`)
  }
  if (!parsed.content.trim() || !parsed.invocation.modelInvocable) {
    throw new Error(`evolution: the candidate skill "${name}" must carry instructions and permit model invocation`)
  }
  const files: CandidateFile[] = [bytesOf(skillMd, 'SKILL.md')]
  for (const resource of loaded.content.resources) {
    files.push(bytesOf(await readFile(join(directory, resource.path)), resource.path))
  }
  const sidecar = await readFile(join(directory, SKILL_SIDECAR_FILE)).catch(() => undefined)
  if (sidecar !== undefined) files.push(bytesOf(sidecar, SKILL_SIDECAR_FILE))
  const entry = revision.skills.find(skill => skill.name === name)
  return {
    files,
    contentDigest: entry?.contentDigest ?? sha256Hex(skillMd),
    contractDigest: entry?.contractDigest ?? null,
  }
}

/** A skill candidate: a same-name improvement, or a first version the baseline does not hold. */
export const skillAdapter: CandidateAdapter = {
  kind: 'skill',
  async prepare({ draft, revision, baseline }) {
    const name = draft.identity
    const object = await readSkillObject(revision, name)
    const before = baseline.skills.find(skill => skill.name === name)
    return {
      files: object.files,
      assetIdentity: assetIdentity('skill', name, object.contentDigest, before !== undefined),
      change: {
        kind: 'skill',
        identity: name,
        before: before?.contentDigest ?? null,
        after: object.contentDigest,
      },
    }
  },
  sideDelta({ draft, baseline, candidate }) {
    const added = candidate.skills.filter(skill => !baseline.skills.some(other => other.name === skill.name)).map(skill => skill.name)
    const capabilities = candidate.capabilityRows[`method:${draft.identity}`] === undefined ? [] : [`method:${draft.identity}`]
    return {
      skills: added,
      capabilities,
      note:
        added.length === 0
          ? `skill "${draft.identity}" is already a provider of the baseline side; the candidate changes its content`
          : `skill "${draft.identity}" enters the candidate side through its own row and skill root`,
    }
  },
  assertConsumed({ plan, candidateReceipt }) {
    return proveSkillLoaded({ plan, receipt: candidateReceipt, where: `sample of draft "${plan.draftId}"` })
  },
  guard() {
    return undefined
  },
}

/** A capability row candidate: the row, plus the skill it may add. */
export const capabilityAdapter: CandidateAdapter = {
  kind: 'capability',
  async prepare({ draft, revision, baseline }) {
    const name = draft.identity
    const entry = assertCapabilityRow(`capability row "${name}"`, revision.capabilityRows[name])
    const beforeEntry = baseline.capabilityRows[name]
    const before = beforeEntry === undefined ? null : digestOf(beforeEntry)
    const after = digestOf(entry)
    if (before === after) {
      throw new Error(`evolution: the candidate revision's row "${name}" is identical to the baseline's; a draft proposes a change`)
    }
    const newSkills = (entry.skills ?? []).filter(skill => !(beforeEntry?.skills ?? []).includes(skill))
    const files: CandidateFile[] = []
    for (const skill of newSkills) {
      const object = await readSkillObject(revision, skill)
      files.push(...object.files.map(file => ({ ...file, path: `${skill}/${file.path}` })))
    }
    return {
      files,
      assetIdentity: assetIdentity('capability', name, after, before !== null),
      change: { kind: 'capability', identity: name, before, after },
    }
  },
  sideDelta({ draft, baseline, candidate, required }) {
    const row = candidate.capabilityRows[draft.identity]
    if (row === undefined) {
      throw new Error(`evolution: the candidate revision holds no capability row "${draft.identity}"`)
    }
    const skills = (row.skills ?? []).filter(skill => !baseline.skills.some(entry => entry.name === skill))
    return {
      skills,
      capabilities: required.includes(draft.identity) ? [] : [draft.identity],
      note: `capability row "${draft.identity}" is replaced on the candidate side${skills.length === 0 ? '' : ` and grants ${skills.join(', ')}`}`,
    }
  },
  assertConsumed({ plan, candidateReceipt, baselineReceipt, comparison }) {
    if (comparison.baseline.outcome === 'not-admitted' || comparison.candidate.outcome === 'not-admitted') {
      return proveAdmissionRefusal({
        plan,
        candidate: comparison.baseline.outcome === 'not-admitted' ? comparison.baseline : comparison.candidate,
        where: `sample "${comparison.sampleTaskId}"`,
      })
    }
    if (baselineReceipt === undefined) {
      throw new Error(`evolution: sample "${comparison.sampleTaskId}" ran no baseline side, so the candidate side has nothing to be compared against`)
    }
    const registry = candidateReceipt.environment.providerRegistryRevision
    if (registry === null) {
      throw new Error(
        `evolution: the candidate side of sample "${comparison.sampleTaskId}" bound no provider registry revision, so the row this ` +
          'candidate installs cannot be shown to have been resolved',
      )
    }
    if (registry === baselineReceipt.environment.providerRegistryRevision) {
      throw new Error(
        `evolution: both sides of sample "${comparison.sampleTaskId}" bound registry revision "${registry}", so the candidate side did not ` +
          'consume the row this candidate replaces',
      )
    }
    return {
      kind: plan.kind,
      proven: true,
      detail: `candidate side resolved registry revision ${registry} for row "${plan.planId === '' ? '' : comparison.candidate.receipt.boundRevision}"`,
    }
  },
  guard({ plan, trials }) {
    const refused = trials.filter(comparison => comparison.baseline.outcome === 'not-admitted' || comparison.candidate.outcome === 'not-admitted')
    if (refused.length === 0) return undefined
    return {
      id: 'capability-admission',
      kind: 'domain',
      ok: false,
      detail:
        `the runtime refused ${refused.length} side(s) at admission (${refused.map(comparison => comparison.sampleTaskId).join(', ')}); an ` +
        `admission refusal is a gap in the plan, never a measured outcome of "${plan.draftId}"`,
    }
  },
}

/** A task-template candidate: a new version appended to the library. */
export const taskTemplateAdapter: CandidateAdapter = {
  kind: 'task-template',
  async prepare({ draft, revision, baseline }) {
    const entry = revision.templates.find(template => template.id === draft.identity)
    if (entry === undefined) {
      throw new Error(`evolution: the candidate revision holds no task template "${draft.identity}"`)
    }
    const file = await readFile(join(revision.taskTemplatesRoot, `${entry.id}@${entry.version}.json`)).catch(() => undefined)
    if (file === undefined) {
      throw new Error(`evolution: the candidate revision's template directory holds no ${entry.id}@${entry.version}.json`)
    }
    const template = parseTaskTemplate(JSON.parse(file.toString('utf8')))
    if (template.id !== entry.id || template.version !== entry.version) {
      throw new Error(`evolution: the candidate file reads ${template.id}@${template.version}, not the ${entry.id}@${entry.version} the manifest records`)
    }
    const before = baseline.templates.find(other => other.id === draft.identity)
    if (before !== undefined && before.version >= entry.version) {
      throw new Error(
        `evolution: the candidate template "${entry.id}@${entry.version}" does not move past the baseline's "${entry.id}@${before.version}"; a ` +
          'template candidate appends a new version',
      )
    }
    return {
      files: [{ ...bytesOf(file, `${entry.id}@${entry.version}.json`) }],
      assetIdentity: assetIdentity('task-template', draft.identity, entry.digest, before !== undefined),
      change: { kind: 'task-template', identity: draft.identity, before: before?.digest ?? null, after: entry.digest },
    }
  },
  sideDelta({ draft, baseline, candidate }) {
    const entry = candidate.templates.find(template => template.id === draft.identity)
    const before = baseline.templates.find(template => template.id === draft.identity)
    if (entry === undefined) throw new Error(`evolution: the candidate revision holds no task template "${draft.identity}"`)
    return {
      skills: [],
      capabilities: [],
      note: `template "${draft.identity}" ${before === undefined ? 'is added' : `moves from @${before.version}`} to @${entry.version}; only new child contracts use it`,
    }
  },
  assertConsumed({ plan, candidateReceipt }) {
    return proveTemplateConsumed({
      plan,
      receipt: candidateReceipt,
      parentCriteria: plan.samples.flatMap(sample => sample.criteria.map(criterion => criterion.criterionId)),
      where: `sample of draft "${plan.draftId}"`,
    })
  },
  guard({ trials }) {
    const unjudged = trials.filter(comparison => comparison.candidate.receipt.criteria.length === 0)
    return {
      id: 'independent-parent-acceptance',
      kind: 'acceptance',
      ok: unjudged.length === 0,
      detail:
        unjudged.length === 0
          ? 'every candidate side carries its own criteria verdicts, judged by the frozen verifiers'
          : `the candidate side of ${unjudged.map(comparison => comparison.sampleTaskId).join(', ')} carries no criteria verdict`,
    }
  },
}

const ADAPTERS: Readonly<Record<MethodAssetKind, CandidateAdapter>> = {
  skill: skillAdapter,
  capability: capabilityAdapter,
  'task-template': taskTemplateAdapter,
}

/** The one adapter of one asset class. */
export function adapterFor(kind: MethodAssetKind): CandidateAdapter {
  const adapter = ADAPTERS[kind]
  if (adapter === undefined) throw new Error(`evolution: no candidate adapter for asset kind ${JSON.stringify(kind)}`)
  return adapter
}
