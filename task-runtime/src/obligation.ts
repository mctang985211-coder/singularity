/**
 * Obligation templates and the coverage check (KISS §5.1, guide §4.2 #21).
 *
 * A domain pack's obligation template is the machine-readable half of "the
 * questions this domain must answer": each entry is a question, the evidence
 * form that would answer it, and the capabilities that usually do the
 * answering. The coverage check compares the template set against the current
 * task graph: an entry is covered when the graph already answers it (a task
 * requested one of its typical capabilities) or when it is consciously
 * registered as missing (an obligation names it). An uncovered entry is a
 * prompt — "satisfied, or forgotten?" — never a block: the check has no
 * scheduler and no gate.
 *
 * Template files live at `<repoRoot>/.agents/skills/<name>/obligations.yml`
 * and are scanned wholesale, so any domain pack can carry one. The file is
 * JSON-compatible YAML (YAML 1.2 accepts JSON), parsed with `JSON.parse` —
 * the same dependency-free trick the evolution package's sandbox artifacts use.
 * @module @dangosys/dsh-singularity-task-runtime/obligation
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Obligation, TaskSnapshot } from '@dangosys/dsh-singularity-task'

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
export interface ObligationTemplateFile {
  file: string
  templates: ObligationTemplate[]
}

/** The coverage verdict for one template set against one task snapshot. */
export interface ObligationCoverage {
  covered: { template: ObligationTemplate; via: string }[]
  uncovered: ObligationTemplate[]
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Parse one obligations.yml text (JSON-compatible YAML) into templates,
 * refusing malformed entries loudly — a template that cannot be read is a
 * defect in the domain pack, not an empty template set.
 */
export function parseObligationTemplates(text: string, source: string): ObligationTemplate[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`obligation: ${source} is not JSON-compatible YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(raw)) throw new Error(`obligation: ${source} must be an array of templates`)
  return raw.map((entry, index) => {
    const label = `${source} entry ${index}`
    if (typeof entry !== 'object' || entry === null) throw new Error(`obligation: ${label} must be an object`)
    const candidate = entry as Record<string, unknown>
    if (!nonEmpty(candidate.id)) throw new Error(`obligation: ${label} requires a non-empty "id"`)
    if (!nonEmpty(candidate.question)) throw new Error(`obligation: ${label} requires a non-empty "question"`)
    if (!nonEmpty(candidate.evidenceForm)) throw new Error(`obligation: ${label} requires a non-empty "evidenceForm"`)
    const capabilities = candidate.typicalCapabilities ?? []
    if (!Array.isArray(capabilities) || capabilities.some(item => !nonEmpty(item))) {
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
 * env root cannot walk to the filesystem root and pick up an unrelated repo).
 * `undefined` when no repo root is found within the cap.
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
 * Load every `<repoRoot>/.agents/skills/<name>/obligations.yml`, in directory
 * order. A pack without the file contributes nothing; an absent skills root
 * yields an empty list. A malformed file throws — see parseObligationTemplates.
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
    const file = join(skillsRoot, entry.name, 'obligations.yml')
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

/** The text a recorded obligation carries, for mention matching. */
function obligationText(obligation: Obligation): string {
  return `${obligation.goal}\n${obligation.criterion}`
}

/**
 * Compare one template set against the current task graph. An entry is covered
 * when a task requested one of its typical capabilities (`via capability
 * <name>`) or a recorded obligation mentions its id or question (`via
 * obligation <id>`). Everything else is uncovered — reported, never blocked.
 */
export function checkObligationCoverage(
  templates: readonly ObligationTemplate[],
  snapshot: TaskSnapshot,
): ObligationCoverage {
  const requested = new Set(snapshot.tasks.flatMap(task => task.requestedCapabilities))
  const obligations = snapshot.obligations
  const covered: ObligationCoverage['covered'] = []
  const uncovered: ObligationTemplate[] = []
  for (const template of templates) {
    const capability = template.typicalCapabilities.find(name => requested.has(name))
    if (capability !== undefined) {
      covered.push({ template, via: `capability ${capability}` })
      continue
    }
    const obligation = obligations.find(item =>
      obligationText(item).includes(template.id) || obligationText(item).includes(template.question))
    if (obligation !== undefined) {
      covered.push({ template, via: `obligation ${obligation.obligationId}` })
      continue
    }
    uncovered.push(template)
  }
  return { covered, uncovered }
}
