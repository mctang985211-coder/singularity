/**
 * Obligation templates and the coverage check (KISS §5.1, guide §4.2 #21).
 * A domain pack's obligation template is the machine-readable half of "the
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { message, nonBlank } from './helpers.ts'

/** One known obligation of a domain pack: a question plus what would answer it. */
export interface ObligationTemplate {
  id: string
  /** The question the domain must answer ("where is your differential reference?"). */
  question: string
  /** The evidence form that counts as an answer. */
  evidenceForm: string
  /** Capability names that usually answer it; empty means no deployed capability covers it. */
  typicalCapabilities: string[]
}

/** One loaded template file and where it came from. */
interface ObligationTemplateFile {
  file: string
  templates: ObligationTemplate[]
}

/** The coverage verdict for one template set against one task snapshot. */
interface ObligationCoverage {
  covered: { template: ObligationTemplate; via: string }[]
  uncovered: ObligationTemplate[]
}

/**
 * Parse one obligations.yml text (JSON-compatible YAML) into templates,
 * refusing malformed entries loudly — a template that cannot be read is a
 */
export function parseObligationTemplates(text: string, source: string): ObligationTemplate[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`obligation: ${source} is not JSON-compatible YAML: ${message(error)}`)
  }
  if (!Array.isArray(raw)) throw new Error(`obligation: ${source} must be an array of templates`)
  return raw.map((entry, index) => {
    const label = `${source} entry ${index}`
    if (typeof entry !== 'object' || entry === null) throw new Error(`obligation: ${label} must be an object`)
    const candidate = entry as Record<string, unknown>
    if (!nonBlank(candidate.id)) throw new Error(`obligation: ${label} requires a non-empty "id"`)
    if (!nonBlank(candidate.question)) throw new Error(`obligation: ${label} requires a non-empty "question"`)
    if (!nonBlank(candidate.evidenceForm)) throw new Error(`obligation: ${label} requires a non-empty "evidenceForm"`)
    const capabilities = candidate.typicalCapabilities ?? []
    if (!Array.isArray(capabilities) || capabilities.some(item => !nonBlank(item))) {
      throw new Error(`obligation: ${label} "typicalCapabilities" must be an array of non-empty strings`)
    }
    return {
      id: candidate.id,
      question: candidate.question,
      evidenceForm: candidate.evidenceForm,
      typicalCapabilities: capabilities as string[],
    }
  })
}

/**
 * Walk up from `start` to the directory holding `.git` (the same semantics as
 * skill-filesystem's findProjectRoot, here with an 8-level cap so a detached
 */
export async function findRepoRoot(start: string, maxLevels = 8): Promise<string | undefined> {
  let current = start
  for (let level = 0; level <= maxLevels; level += 1) {
    try {
      await stat(join(current, '.git'))
      return current
    } catch {
      // not the root; keep walking
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Load every `<repoRoot>/.agents/skills/<name>/references/obligations.yml`, in directory
 * order. A pack without the file contributes nothing; an absent skills root
 */
export async function loadObligationTemplates(repoRoot: string): Promise<ObligationTemplateFile[]> {
  const skillsRoot = join(repoRoot, '.agents', 'skills')
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const files: ObligationTemplateFile[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const file = join(skillsRoot, entry.name, 'references', 'obligations.yml')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    files.push({ file, templates: parseObligationTemplates(text, file) })
  }
  return files
}

/** A domain obligation is satisfied only by a matching criterion in the latest verified run's evidence. */
export function checkObligationCoverage(
  templates: readonly ObligationTemplate[],
  snapshot: TaskSnapshot,
): ObligationCoverage {
  const covered: ObligationCoverage['covered'] = []
  const uncovered: ObligationTemplate[] = []
  for (const template of templates) {
    const evidence = snapshot.tasks.flatMap(task => {
      if (task.status !== 'verified' || !task.acceptanceCriteria.some(criterion => criterion.criterionId === template.id)) return []
      const runId = task.runIds.at(-1)
      if (!snapshot.runs.some(run => run.runId === runId && run.status === 'verified')) return []
      return snapshot.evidence.filter(bundle => bundle.taskRunId === runId && bundle.taskId === task.taskId &&
        bundle.verifierResults.some(result => result.criterionId === template.id && result.status === 'pass'))
    })[0]
    if (evidence === undefined) uncovered.push(template)
    else covered.push({ template, via: `evidence ${evidence.evidenceId}` })
  }
  return { covered, uncovered }
}
