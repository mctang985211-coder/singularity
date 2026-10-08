/**
 * One immutable environment revision: the manifest type, its content digest, and
 * the pure edit functions a draft applies. No I/O lives here; `store.ts` owns the
 * bytes, `draft.ts` and `pointer.ts` own when an edit lands.
 * @module dsh-singularity-task-runtime/environment/revision
 */

import { canonicalize, sha256Hex, taskTemplateDigest } from '@dangosys/dsh-singularity-task'
import type { TaskTemplate, TaskTemplateRef } from '@dangosys/dsh-singularity-task'
import { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'
import type { CapabilityConfig } from '../capability.ts'
import type { McpServerTemplate } from '../mcp-servers.ts'
import { parseTaskTemplate } from '../task-template.ts'
import {
  SKILL_SIDECAR_FILE,
  isSupportedSkillResourcePath,
  skillContentDigest,
  skillContractDigest,
} from '../skill-contract.ts'
import type { SkillSidecar } from '../skill-contract.ts'

/** The one id shape a revision directory, a pointer and a run record all agree on. */
export const ENVIRONMENT_REVISION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The id shape of a draft directory; allocated monotonically per library. */
export const ENVIRONMENT_DRAFT_ID = /^d[0-9]{4}$/

/** The id a draft's prospective revision carries: deterministic, so a killed publish replays onto the same name. */
export function candidateRevisionId(draftId: string): string {
  if (!ENVIRONMENT_DRAFT_ID.test(draftId)) throw new Error(`environment: "${draftId}" is not a draft id (^d[0-9]{4}$)`)
  return `c-${draftId}`
}

/** One skill as one revision holds it: the current entry of its name, with the lineage-local version and both digests. */
export interface EnvironmentSkillEntry {
  readonly name: string
  /** Monotonic within the graph library's lineage; two drafts of the same base both get version+1 and the pointer CAS settles the conflict. */
  readonly version: number
  /** sha256 of the exact `SKILL.md` bytes. */
  readonly digest: string
  /** `skillContentDigest` of `SKILL.md` plus the declared resources. */
  readonly contentDigest: string
  /** `skillContractDigest` of the declared sidecar, or `null` for a skill that declares none. */
  readonly contractDigest: string | null
  readonly status: 'temporary' | 'retained' | 'retired'
  readonly reason?: string
  readonly reviewedBy?: string
}

/** One task template as one revision holds it. */
export interface EnvironmentTaskTemplateEntry {
  readonly templateRef: TaskTemplateRef
  readonly status: 'temporary' | 'retained' | 'retired'
  readonly skills: string[]
  readonly reason?: string
  readonly reviewedBy?: string
}

/** The graph-internal capability table of one revision: explicit rows (including candidate `method:*` rows) and the MCP templates they resolve against. */
export interface EnvironmentCapabilityEntry {
  readonly rows: Readonly<Record<string, CapabilityConfig>>
  readonly mcpServers: Readonly<Record<string, McpServerTemplate>>
}

/** The self-describing identity of one immutable revision directory; `contentDigest` covers every other field. */
export interface EnvironmentRevisionManifest {
  readonly formatVersion: 1
  readonly revisionId: string
  readonly libraryId: string
  readonly kind: 'official' | 'candidate'
  readonly basedOn: string | null
  readonly createdAt: string
  readonly skills: readonly EnvironmentSkillEntry[]
  readonly taskTemplates: readonly EnvironmentTaskTemplateEntry[]
  readonly capabilities: EnvironmentCapabilityEntry
  /** sha256 over `canonicalize` of this manifest without this field. */
  readonly contentDigest: string
}

/** A revision directory resolved to its roots. */
export interface EnvironmentRevision {
  readonly manifest: EnvironmentRevisionManifest
  readonly root: string
  readonly skillRoot: string
  readonly taskTemplatesRoot: string
}

/** The listing projection of one revision: identity plus sizes, never the full manifest. */
export interface EnvironmentRevisionRef {
  readonly revisionId: string
  readonly kind: 'official' | 'candidate'
  readonly basedOn: string | null
  readonly contentDigest: string
  readonly createdAt: string
  readonly skills: number
  readonly taskTemplates: number
}

/** One skill edit staged into a draft: the complete new `SKILL.md` and the complete declared resource set. */
export interface SkillEdit {
  readonly name: string
  readonly skillMd: string
  /** The complete resource set of the new version: `<dir>/<file>` per `isSupportedSkillResourcePath`, plus optionally `SKILL.contract.json`. */
  readonly resources?: Record<string, string>
  /** Must equal the current entry's version (0 when the name is new); the same discipline as the old library's `expectedVersion`. */
  readonly expectedVersion?: number
  readonly actor: string
}

/** One task template edit staged into a draft. */
export interface TemplateEdit {
  readonly template: TaskTemplate
  readonly actor: string
}

/** One capability-row edit staged into a draft: `entry` null removes the row; an `mcpServers` value of null removes that template. */
export interface CapabilityRowEdit {
  readonly name: string
  readonly entry: CapabilityConfig | null
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate | null>>
  readonly actor: string
}

/** One retention review staged into a draft (the shape the old library's `reviewTaskLibrary` accepted, plus the reviewer). */
export interface EnvironmentReview {
  readonly kind: 'task' | 'skill'
  readonly name: string
  readonly version: number
  readonly status: 'retained' | 'retired'
  readonly reason: string
  readonly actor: string
}

/** Every edit a draft accepts. */
export type EnvironmentEdit =
  | { readonly kind: 'skill'; readonly edit: SkillEdit }
  | { readonly kind: 'task'; readonly edit: TemplateEdit }
  | { readonly kind: 'review'; readonly review: EnvironmentReview }
  | { readonly kind: 'capability'; readonly edit: CapabilityRowEdit }

const DIGEST = /^[0-9a-f]{64}$/
const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const STATUSES: readonly string[] = ['temporary', 'retained', 'retired']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The content digest of a manifest: what the revision **holds** — its skill
 * entries, its task templates and its capability table — plus the generation it
 * belongs to, and nothing else. The identity it is filed under (`revisionId`,
 * which for a candidate is derived from the draft id, the revision it was based
 * on, and when it was staged) is identity, not content: two drafts carrying the
 * same bytes therefore read the same content digest, and a client that keys a
 * candidate by its content (the strategy's same-bytes refutation) matches on it.
 * The identity members are pinned elsewhere — the revision id by the directory
 * name it must equal, and the base and timestamp by the draft record.
 */
export function manifestDigest(manifest: Omit<EnvironmentRevisionManifest, 'contentDigest'>): string {
  const { formatVersion, libraryId, kind, skills, taskTemplates, capabilities } = manifest
  return sha256Hex(canonicalize({ formatVersion, libraryId, kind, skills, taskTemplates, capabilities }))
}

function withDigest(manifest: Omit<EnvironmentRevisionManifest, 'contentDigest'>): EnvironmentRevisionManifest {
  const { contentDigest: _dropped, ...rest } = manifest as EnvironmentRevisionManifest
  return { ...rest, contentDigest: manifestDigest(rest) }
}

/** The manifest of a revision that holds nothing yet; `ensureInitialRevision` fills it, a draft copies and edits it. */
export function emptyRevisionManifest(input: {
  libraryId: string
  revisionId: string
  kind: 'official' | 'candidate'
  basedOn: string | null
  createdAt: string
}): EnvironmentRevisionManifest {
  if (!ENVIRONMENT_REVISION_ID.test(input.revisionId)) {
    throw new Error(`environment: revision id ${JSON.stringify(input.revisionId)} is not a valid revision id`)
  }
  return withDigest({ formatVersion: 1, ...input, skills: [], taskTemplates: [], capabilities: { rows: {}, mcpServers: {} } })
}

function parseSkillEntry(raw: unknown, where: string): EnvironmentSkillEntry {
  if (!isRecord(raw)) throw new Error(`${where}: a skill entry must be an object`)
  if (typeof raw.name !== 'string' || !SKILL_NAME.test(raw.name)) throw new Error(`${where}: a skill entry requires a valid name`)
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) throw new Error(`${where}: skill "${raw.name}" version must be a positive integer`)
  if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest)) throw new Error(`${where}: skill "${raw.name}" digest must be a lowercase SHA-256 hex digest`)
  if (typeof raw.contentDigest !== 'string' || !DIGEST.test(raw.contentDigest)) throw new Error(`${where}: skill "${raw.name}" contentDigest must be a lowercase SHA-256 hex digest`)
  if (raw.contractDigest !== null && (typeof raw.contractDigest !== 'string' || !DIGEST.test(raw.contractDigest)))
    throw new Error(`${where}: skill "${raw.name}" contractDigest must be a lowercase SHA-256 hex digest or null`)
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) throw new Error(`${where}: skill "${raw.name}" has an unknown status ${JSON.stringify(raw.status)}`)
  if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error(`${where}: skill "${raw.name}" reason must be a string when present`)
  if (raw.reviewedBy !== undefined && typeof raw.reviewedBy !== 'string') throw new Error(`${where}: skill "${raw.name}" reviewedBy must be a string when present`)
  return raw as unknown as EnvironmentSkillEntry
}

function parseTemplateEntry(raw: unknown, where: string): EnvironmentTaskTemplateEntry {
  if (!isRecord(raw)) throw new Error(`${where}: a task template entry must be an object`)
  const ref = raw.templateRef
  if (!isRecord(ref) || typeof ref.id !== 'string' || ref.id.length === 0 || !Number.isInteger(ref.version) || (ref.version as number) < 1 ||
    typeof ref.digest !== 'string' || !DIGEST.test(ref.digest)) {
    throw new Error(`${where}: a task template entry requires a valid templateRef (id, positive integer version, digest)`)
  }
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) throw new Error(`${where}: task template "${ref.id}" has an unknown status ${JSON.stringify(raw.status)}`)
  if (!Array.isArray(raw.skills) || raw.skills.some(item => typeof item !== 'string')) throw new Error(`${where}: task template "${ref.id}" skills must be an array of strings`)
  if (raw.reason !== undefined && typeof raw.reason !== 'string') throw new Error(`${where}: task template "${ref.id}" reason must be a string when present`)
  if (raw.reviewedBy !== undefined && typeof raw.reviewedBy !== 'string') throw new Error(`${where}: task template "${ref.id}" reviewedBy must be a string when present`)
  return raw as unknown as EnvironmentTaskTemplateEntry
}

/** Parse and fully validate one manifest, including its self-digest: a manifest whose bytes were edited is refused by name. */
export function parseRevisionManifest(raw: unknown, where: string): EnvironmentRevisionManifest {
  if (!isRecord(raw)) throw new Error(`${where}: a revision manifest must be an object`)
  if (raw.formatVersion !== 1) throw new Error(`${where}: unsupported revision manifest formatVersion ${JSON.stringify(raw.formatVersion)}`)
  if (typeof raw.revisionId !== 'string' || !ENVIRONMENT_REVISION_ID.test(raw.revisionId)) throw new Error(`${where}: a revision manifest requires a valid revisionId`)
  if (typeof raw.libraryId !== 'string' || raw.libraryId.length === 0) throw new Error(`${where}: a revision manifest requires a libraryId`)
  if (raw.kind !== 'official' && raw.kind !== 'candidate') throw new Error(`${where}: revision kind must be "official" or "candidate"`)
  if (raw.basedOn !== null && (typeof raw.basedOn !== 'string' || !ENVIRONMENT_REVISION_ID.test(raw.basedOn))) throw new Error(`${where}: basedOn must be a revision id or null`)
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) throw new Error(`${where}: a revision manifest requires createdAt`)
  if (!Array.isArray(raw.skills)) throw new Error(`${where}: skills must be an array`)
  const skills = raw.skills.map((entry, index) => parseSkillEntry(entry, `${where} skills[${index}]`))
  const seen = new Set<string>()
  for (const entry of skills) {
    if (seen.has(entry.name)) throw new Error(`${where}: skill "${entry.name}" appears twice; a revision holds one entry per name`)
    seen.add(entry.name)
  }
  if (!Array.isArray(raw.taskTemplates)) throw new Error(`${where}: taskTemplates must be an array`)
  const taskTemplates = raw.taskTemplates.map((entry, index) => parseTemplateEntry(entry, `${where} taskTemplates[${index}]`))
  if (!isRecord(raw.capabilities) || !isRecord(raw.capabilities.rows) || !isRecord(raw.capabilities.mcpServers)) {
    throw new Error(`${where}: capabilities must hold a rows record and an mcpServers record`)
  }
  if (typeof raw.contentDigest !== 'string' || !DIGEST.test(raw.contentDigest)) throw new Error(`${where}: a revision manifest requires a contentDigest`)
  const manifest = raw as unknown as EnvironmentRevisionManifest
  const { contentDigest, ...rest } = manifest
  const computed = manifestDigest(rest)
  if (computed !== contentDigest) {
    throw new Error(`${where}: manifest contentDigest ${contentDigest} does not match its content (${computed}); the manifest was edited outside the draft machinery`)
  }
  return manifest
}

/** The current entry of one skill name in a revision. */
export function revisionSkillOf(manifest: EnvironmentRevisionManifest, name: string): EnvironmentSkillEntry | undefined {
  return manifest.skills.find(entry => entry.name === name)
}

/** The newest entry of one template id in a revision. */
export function revisionTemplateOf(manifest: EnvironmentRevisionManifest, id: string): EnvironmentTaskTemplateEntry | undefined {
  return manifest.taskTemplates
    .filter(entry => entry.templateRef.id === id)
    .sort((left, right) => right.templateRef.version - left.templateRef.version)[0]
}

/** The listing projection of one manifest. */
export function revisionRefOf(manifest: EnvironmentRevisionManifest): EnvironmentRevisionRef {
  return {
    revisionId: manifest.revisionId,
    kind: manifest.kind,
    basedOn: manifest.basedOn,
    contentDigest: manifest.contentDigest,
    createdAt: manifest.createdAt,
    skills: manifest.skills.length,
    taskTemplates: manifest.taskTemplates.length,
  }
}

/** The graph-internal capability rows of one revision; replaces the old index-derived `libraryCapabilities`. */
export function revisionCapabilityRows(manifest: EnvironmentRevisionManifest): Record<string, CapabilityConfig> {
  const rows: Record<string, CapabilityConfig> = {
    'execute-task': { skills: ['task-coordination'], tools: ['filesystem', 'search', 'bash', 'jobs', 'skill'] },
  }
  for (const skill of manifest.skills) {
    const row = `method:${skill.name}`
    if (skill.status === 'retired' || row in rows) continue
    rows[row] = { skills: [skill.name], tools: ['skill'] }
  }
  return { ...rows, ...manifest.capabilities.rows }
}

/** The skills one template consumes, resolved against a capability table (the rule the old library applied at write time). */
function templateSkillsOf(template: TaskTemplate, table: Readonly<Record<string, CapabilityConfig>>): string[] {
  return [...new Set((template.contract.requiredCapabilities ?? []).flatMap(name =>
    name.startsWith('method:') ? [name.slice(7)] : name === 'execute-task' ? ['task-coordination'] : table[name]?.skills ?? []))].sort()
}

/** The hard rules any draft edit must pass, checked before any byte moves; the apply functions re-check them. */
export function assertDraftEditAllowed(manifest: EnvironmentRevisionManifest, edit: EnvironmentEdit): void {
  if (edit.kind === 'skill') {
    const { name, skillMd, expectedVersion, resources } = edit.edit
    if (!SKILL_NAME.test(name)) throw new Error(`environment: invalid Skill name ${JSON.stringify(name)}`)
    if (parseSkillFile(skillMd, `skills/${name}/SKILL.md`).name !== name) {
      throw new Error('environment: Skill frontmatter name must match')
    }
    for (const path of Object.keys(resources ?? {})) {
      if (path !== SKILL_SIDECAR_FILE && !isSupportedSkillResourcePath(path)) {
        throw new Error(`environment: resource path ${JSON.stringify(path)} is not a supported skill resource path`)
      }
    }
    const current = revisionSkillOf(manifest, name)
    if (expectedVersion !== (current?.version ?? 0)) {
      throw new Error(`environment: expectedVersion must be ${current?.version ?? 0}; read the current version before changing a Skill`)
    }
    return
  }
  if (edit.kind === 'review') {
    const review = edit.review
    if (review.kind === 'skill' && review.name === 'task-coordination' && review.status === 'retired') {
      throw new Error('task-coordination supplies execute-task; retain or revise it to keep generic tasks executable')
    }
    if (!review.reason.trim()) throw new Error('environment: review requires a reason from execution evidence')
    return
  }
  if (edit.kind === 'capability') {
    if (typeof edit.edit.name !== 'string' || edit.edit.name.length === 0) throw new Error('environment: a capability row edit requires a name')
  }
}

/** Apply one skill edit to a manifest, purely: the entry's digests come from the edit's declared bytes. */
export function applySkillEdit(manifest: EnvironmentRevisionManifest, edit: SkillEdit): EnvironmentRevisionManifest {
  assertDraftEditAllowed(manifest, { kind: 'skill', edit })
  const resourceList = Object.entries(edit.resources ?? {})
    .filter(([path]) => path !== SKILL_SIDECAR_FILE)
    .map(([path, content]) => ({ path, sha256: sha256Hex(content) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const skillMdSha256 = sha256Hex(edit.skillMd)
  let contractDigest: string | null = null
  const sidecarText = edit.resources?.[SKILL_SIDECAR_FILE]
  if (sidecarText !== undefined) {
    let declared: unknown
    try {
      declared = JSON.parse(sidecarText)
    } catch (error) {
      throw new Error(`environment: ${SKILL_SIDECAR_FILE} of skill "${edit.name}" is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    contractDigest = skillContractDigest(declared as SkillSidecar)
  }
  const current = revisionSkillOf(manifest, edit.name)
  const entry: EnvironmentSkillEntry = {
    name: edit.name,
    version: (current?.version ?? 0) + 1,
    digest: skillMdSha256,
    contentDigest: skillContentDigest({ skillMdSha256, resources: resourceList }),
    contractDigest,
    status: 'temporary',
  }
  if (current !== undefined && current.digest === entry.digest && current.contentDigest === entry.contentDigest && current.contractDigest === entry.contractDigest) {
    return manifest
  }
  return withDigest({
    ...manifest,
    skills: [...manifest.skills.filter(item => item.name !== edit.name), entry].sort((left, right) => (left.name < right.name ? -1 : 1)),
  })
}

/** Apply one task template edit to a manifest, purely: an identical repeat is a no-op, a conflicting version is refused. */
export function applyTemplateEdit(
  manifest: EnvironmentRevisionManifest,
  template: TaskTemplate,
  table?: Readonly<Record<string, CapabilityConfig>>,
): EnvironmentRevisionManifest {
  const parsed = parseTaskTemplate(template)
  const ref: TaskTemplateRef = { id: parsed.id, version: parsed.version, digest: taskTemplateDigest(parsed) }
  const existing = manifest.taskTemplates.find(entry => entry.templateRef.id === ref.id && entry.templateRef.version === ref.version)
  if (existing !== undefined) {
    if (existing.templateRef.digest === ref.digest) return manifest
    throw new Error(`environment: ${ref.id}@${ref.version} already exists with different content; publish a new version`)
  }
  const entry: EnvironmentTaskTemplateEntry = {
    templateRef: ref,
    status: 'temporary',
    skills: templateSkillsOf(parsed, table ?? manifest.capabilities.rows),
  }
  return withDigest({ ...manifest, taskTemplates: [...manifest.taskTemplates, entry] })
}

/** Apply one retention review to a manifest, purely: status is a field of the revision, never an in-place edit of a shared index. */
export function applyReviewEdit(manifest: EnvironmentRevisionManifest, review: EnvironmentReview, reviewedBy: string): EnvironmentRevisionManifest {
  assertDraftEditAllowed(manifest, { kind: 'review', review })
  if (review.kind === 'skill') {
    const current = manifest.skills.find(entry => entry.name === review.name && entry.version === review.version)
    if (current === undefined) throw new Error(`environment: reviewed skill "${review.name}" version ${review.version} is absent`)
    const updated: EnvironmentSkillEntry = { ...current, status: review.status, reason: review.reason, reviewedBy }
    return withDigest({ ...manifest, skills: manifest.skills.map(entry => (entry === current ? updated : entry)) })
  }
  const current = manifest.taskTemplates.find(entry => entry.templateRef.id === review.name && entry.templateRef.version === review.version)
  if (current === undefined) throw new Error(`environment: reviewed task template "${review.name}" version ${review.version} is absent`)
  const updated: EnvironmentTaskTemplateEntry = { ...current, status: review.status, reason: review.reason, reviewedBy }
  return withDigest({ ...manifest, taskTemplates: manifest.taskTemplates.map(entry => (entry === current ? updated : entry)) })
}

/** Apply one capability-row edit to a manifest, purely: a null entry removes the row, a null MCP template removes it. */
export function applyCapabilityRowEdit(manifest: EnvironmentRevisionManifest, edit: CapabilityRowEdit): EnvironmentRevisionManifest {
  assertDraftEditAllowed(manifest, { kind: 'capability', edit })
  const rows = { ...manifest.capabilities.rows }
  if (edit.entry === null) delete rows[edit.name]
  else rows[edit.name] = edit.entry
  const mcpServers = { ...manifest.capabilities.mcpServers }
  for (const [name, template] of Object.entries(edit.mcpServers ?? {})) {
    if (template === null) delete mcpServers[name]
    else mcpServers[name] = template
  }
  return withDigest({ ...manifest, capabilities: { rows, mcpServers } })
}
