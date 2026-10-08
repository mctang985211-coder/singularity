/**
 * The one mutable region of an environment library: drafts. A draft is a full
 * copy of the revision it is based on plus its edits, and it can never overwrite
 * the active revision — publishing freezes it by rename and switches the pointer.
 * @module dsh-singularity-task-runtime/environment/draft
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapabilityConfig } from '../capability.ts'
import { SKILL_SIDECAR_FILE, isSupportedSkillResourcePath } from '../skill-contract.ts'
import { registerTaskTemplate } from '../task-template.ts'
import {
  ENVIRONMENT_DRAFT_ID,
  applyCapabilityRowEdit,
  applyReviewEdit,
  applySkillEdit,
  applyTemplateEdit,
  assertDraftEditAllowed,
  candidateRevisionId,
  manifestDigest,
  parseRevisionManifest,
  revisionSkillOf,
} from './revision.ts'
import type {
  EnvironmentEdit,
  EnvironmentRevision,
  EnvironmentRevisionManifest,
} from './revision.ts'
import {
  copyRevisionDirectory,
  draftsRoot,
  freezeDraftDirectory,
  hasLegacyLayout,
  readRevision,
  serialEnvironment,
  syncDirectory,
  verifyRevisionDirectory,
  writeFileAtomic,
  writeRevisionManifest,
} from './store.ts'
import type { LibraryRoots } from './store.ts'
import { readPointer } from './pointer.ts'

/** The one persisted record of a draft: `drafts/<draftId>/draft.json`. */
interface DraftRecord {
  readonly formatVersion: 1
  readonly libraryId: string
  readonly draftId: string
  readonly basedOn: string
  readonly actor: string
  readonly purpose?: string
  readonly createdAt: string
  readonly edits: readonly string[]
  readonly manifest: EnvironmentRevisionManifest
}

/** A draft: the prospective candidate revision it holds, with its lineage and a human-readable edit log. */
export interface EnvironmentDraft {
  readonly libraryId: string
  readonly draftId: string
  /** The revision this draft was copied from. */
  readonly basedOn: string
  readonly root: string
  /** The prospective revision this draft freezes into (`kind: 'candidate'`). */
  readonly manifest: EnvironmentRevisionManifest
  readonly actor: string
  readonly createdAt: string
  readonly edits: readonly string[]
}

/** The listing projection of one draft. */
export interface EnvironmentDraftRef {
  readonly draftId: string
  readonly basedOn: string
  readonly edits: number
  readonly createdAt: string
}

function draftRoot(library: LibraryRoots, draftId: string): string {
  if (!ENVIRONMENT_DRAFT_ID.test(draftId)) throw new Error(`environment: ${JSON.stringify(draftId)} is not a draft id (^d[0-9]{4}$)`)
  return join(draftsRoot(library), draftId)
}

function draftRecordOf(draft: EnvironmentDraft, purpose?: string): DraftRecord {
  return {
    formatVersion: 1,
    libraryId: draft.libraryId,
    draftId: draft.draftId,
    basedOn: draft.basedOn,
    actor: draft.actor,
    ...(purpose !== undefined ? { purpose } : {}),
    createdAt: draft.createdAt,
    edits: draft.edits,
    manifest: draft.manifest,
  }
}

async function writeDraftRecord(draft: EnvironmentDraft, purpose?: string): Promise<void> {
  await writeFileAtomic(join(draft.root, 'draft.json'), `${JSON.stringify(draftRecordOf(draft, purpose), null, 2)}\n`)
}

async function readDraftRecord(library: LibraryRoots, draftId: string): Promise<{ record: DraftRecord; root: string } | undefined> {
  const root = draftRoot(library, draftId)
  let text: string
  try {
    text = await readFile(join(root, 'draft.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`environment: draft "${draftId}" draft.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const record = raw as DraftRecord
  if (record.formatVersion !== 1 || record.draftId !== draftId || typeof record.basedOn !== 'string' || !Array.isArray(record.edits)) {
    throw new Error(`environment: draft "${draftId}" draft.json is not a valid draft record`)
  }
  const manifest = parseRevisionManifest(record.manifest, `environment: draft "${draftId}" draft.json`)
  return { record: { ...record, manifest }, root }
}

function draftOf(library: LibraryRoots, record: DraftRecord, root: string): EnvironmentDraft {
  return {
    libraryId: library.id,
    draftId: record.draftId,
    basedOn: record.basedOn,
    root,
    manifest: record.manifest,
    actor: record.actor,
    createdAt: record.createdAt,
    edits: record.edits,
  }
}

/** The next draft id of one library: monotonic `d0001`, `d0002`, …, allocated under the library's write tail. */
async function nextDraftId(library: LibraryRoots): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(draftsRoot(library))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'd0001'
    throw error
  }
  const highest = entries.filter(name => ENVIRONMENT_DRAFT_ID.test(name)).map(name => Number(name.slice(1))).reduce((max, value) => Math.max(max, value), 0)
  return `d${String(highest + 1).padStart(4, '0')}`
}

/**
 * Open a draft on top of a revision (the active one by default): a full copy of
 * the base's directory under `drafts/<draftId>` with a candidate manifest. A
 * legacy-layout library is refused by name — drafts belong to the new protocol.
 */
export async function createEnvironmentDraft(
  library: LibraryRoots,
  request: { basedOn?: string; actor: string; purpose?: string },
): Promise<EnvironmentDraft> {
  return serialEnvironment(library, async () => {
    if (await hasLegacyLayout(library)) {
      throw new Error(`environment: library "${library.id}" has the legacy mutable layout; it is read-only and never gets drafts`)
    }
    const basedOn = request.basedOn ?? (await readPointer(library))?.revisionId
    if (basedOn === undefined) {
      throw new Error(`environment: library "${library.id}" has no revision to base a draft on; the initial revision comes first`)
    }
    const base = await readRevision(library, basedOn)
    if (base === undefined) throw new Error(`environment: revision "${basedOn}" is absent; a draft copies a frozen revision`)
    const draftId = await nextDraftId(library)
    const root = join(draftsRoot(library), draftId)
    await copyRevisionDirectory(base.root, root)
    const createdAt = new Date().toISOString()
    const { contentDigest: _, ...baseRest } = base.manifest
    const prospective = {
      ...baseRest,
      revisionId: candidateRevisionId(draftId),
      kind: 'candidate' as const,
      basedOn: base.manifest.revisionId,
      createdAt,
    }
    const finalized: EnvironmentRevisionManifest = { ...prospective, contentDigest: manifestDigest(prospective) }
    await writeRevisionManifest(root, finalized)
    const draft = draftOf(library, {
      formatVersion: 1,
      libraryId: library.id,
      draftId,
      basedOn: base.manifest.revisionId,
      actor: request.actor,
      createdAt,
      edits: [],
      manifest: finalized,
    }, root)
    await writeDraftRecord(draft, request.purpose)
    return draft
  })
}

/** Read one draft, or `undefined` when it does not exist. */
export async function readEnvironmentDraft(library: LibraryRoots, draftId: string): Promise<EnvironmentDraft | undefined> {
  const loaded = await readDraftRecord(library, draftId)
  if (loaded === undefined) return undefined
  return draftOf(library, loaded.record, loaded.root)
}

/** List every draft of one library, sorted by id. */
export async function listEnvironmentDrafts(library: LibraryRoots): Promise<EnvironmentDraftRef[]> {
  let entries
  try {
    entries = await readdir(draftsRoot(library), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const drafts: EnvironmentDraftRef[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ENVIRONMENT_DRAFT_ID.test(entry.name)) continue
    const loaded = await readDraftRecord(library, entry.name)
    if (loaded === undefined) continue
    drafts.push({ draftId: entry.name, basedOn: loaded.record.basedOn, edits: loaded.record.edits.length, createdAt: loaded.record.createdAt })
  }
  return drafts.sort((left, right) => (left.draftId < right.draftId ? -1 : 1))
}

/** The newest draft one actor opened, when one exists. */
export async function latestDraftFor(library: LibraryRoots, actor: string): Promise<EnvironmentDraft | undefined> {
  const refs = await listEnvironmentDrafts(library)
  for (const ref of [...refs].reverse()) {
    const draft = await readEnvironmentDraft(library, ref.draftId)
    if (draft?.actor === actor) return draft
  }
  return undefined
}

/** Write the payload files of one edit into the draft directory, so the disk holds exactly what the new manifest declares. */
async function stageEditFiles(draft: EnvironmentDraft, edit: EnvironmentEdit, manifest: EnvironmentRevisionManifest): Promise<void> {
  if (edit.kind === 'skill') {
    const entry = revisionSkillOf(manifest, edit.edit.name)
    if (entry === undefined) return
    const directory = join(draft.root, 'skills', edit.edit.name)
    await mkdir(directory, { recursive: true })
    const declared = new Map(Object.entries(edit.edit.resources ?? {}))
    for (const [path, content] of declared) {
      if (path !== SKILL_SIDECAR_FILE && !isSupportedSkillResourcePath(path)) {
        throw new Error(`environment: resource path ${JSON.stringify(path)} is not a supported skill resource path`)
      }
      const target = join(directory, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await writeFile(join(directory, 'SKILL.md'), edit.edit.skillMd)
    // The edit declares the complete resource set: files of the base copy it no longer names leave the draft.
    const existing = await readdir(directory, { withFileTypes: true })
    for (const item of existing) {
      if (item.name === 'SKILL.md') continue
      if (item.isFile() && item.name === SKILL_SIDECAR_FILE && !declared.has(SKILL_SIDECAR_FILE)) {
        await rm(join(directory, item.name))
        continue
      }
      if (!item.isDirectory()) continue
      if (!['references', 'scripts', 'resources'].includes(item.name)) continue
      for (const file of await readdir(join(directory, item.name))) {
        if (!declared.has(`${item.name}/${file}`)) await rm(join(directory, item.name, file))
      }
      if ((await readdir(join(directory, item.name))).length === 0) await rm(join(directory, item.name), { recursive: true })
    }
    return
  }
  if (edit.kind === 'task') {
    await registerTaskTemplate(join(draft.root, 'task-templates'), edit.edit.template)
    return
  }
  if (edit.kind === 'capability') {
    await writeFileAtomic(join(draft.root, 'capabilities.json'), `${JSON.stringify(manifest.capabilities, null, 2)}\n`)
  }
}

/** A short human-readable line appended to the draft's edit log. */
function editSummary(edit: EnvironmentEdit): string {
  if (edit.kind === 'skill') return `skill ${edit.edit.name} by ${edit.edit.actor}`
  if (edit.kind === 'task') return `task template ${edit.edit.template.id}@${edit.edit.template.version} by ${edit.edit.actor}`
  if (edit.kind === 'review') return `review ${edit.review.kind} ${edit.review.name} → ${edit.review.status} by ${edit.review.reason}`
  return `capability row ${edit.edit.name} ${edit.edit.entry === null ? 'removed' : 'set'} by ${edit.edit.actor}`
}

/**
 * Stage one edit into one draft: payload bytes first, then the manifest, then the
 * draft record — all under the library's single write tail, so concurrent stages
 * of one library serialize.
 */
export async function stageEnvironmentEdit(
  library: LibraryRoots,
  draftId: string,
  edit: EnvironmentEdit,
  table?: Readonly<Record<string, CapabilityConfig>>,
): Promise<EnvironmentDraft> {
  return serialEnvironment(library, async () => {
    const draft = await readEnvironmentDraft(library, draftId)
    if (draft === undefined) throw new Error(`environment: draft "${draftId}" is absent; a discarded or frozen draft takes no edits`)
    assertDraftEditAllowed(draft.manifest, edit)
    const manifest =
      edit.kind === 'skill'
        ? applySkillEdit(draft.manifest, edit.edit)
        : edit.kind === 'task'
          ? applyTemplateEdit(draft.manifest, edit.edit.template, table)
          : edit.kind === 'review'
            ? applyReviewEdit(draft.manifest, edit.review, edit.review.actor)
            : applyCapabilityRowEdit(draft.manifest, edit.edit)
    await stageEditFiles(draft, edit, manifest)
    await writeRevisionManifest(draft.root, manifest)
    const updated: EnvironmentDraft = { ...draft, manifest, edits: [...draft.edits, editSummary(edit)] }
    await writeDraftRecord(updated)
    return updated
  })
}

/** Delete one draft's directory; a discarded draft cannot be published, because publishing reads the draft record first. */
export async function discardEnvironmentDraft(library: LibraryRoots, draftId: string): Promise<void> {
  return serialEnvironment(library, async () => {
    const root = draftRoot(library, draftId)
    const draft = await readEnvironmentDraft(library, draftId)
    if (draft === undefined) throw new Error(`environment: draft "${draftId}" is absent; nothing to discard`)
    await rm(root, { recursive: true, force: true })
    await syncDirectory(draftsRoot(library))
  })
}

/**
 * Freeze one draft into an immutable candidate revision (`revisions/c-<draftId>`
 * unless the caller names another id). The pointer does not move: only a publish
 * switches it. This is the standalone entry an explicit trial uses; a publish
 * runs the same freeze inside its transaction.
 */
export async function freezeEnvironmentDraft(library: LibraryRoots, draftId: string, revisionId?: string): Promise<EnvironmentRevision> {
  return serialEnvironment(library, async () => {
    const draft = await readEnvironmentDraft(library, draftId)
    if (draft === undefined) throw new Error(`environment: draft "${draftId}" is absent; nothing to freeze`)
    const target = revisionId ?? draft.manifest.revisionId
    let manifest = draft.manifest
    if (target !== manifest.revisionId) {
      const { contentDigest: _, ...rest } = manifest
      const renamed = { ...rest, revisionId: target }
      manifest = { ...renamed, contentDigest: manifestDigest(renamed) }
      await writeRevisionManifest(draft.root, manifest)
    }
    const { defects } = await verifyRevisionDirectory(draft.root, manifest)
    if (defects.length > 0) {
      throw new Error(`environment: draft "${draftId}" does not verify against its manifest:\n- ${defects.join('\n- ')}`)
    }
    await freezeDraftDirectory(library, draftId, target)
    const revision = await readRevision(library, target)
    if (revision === undefined) throw new Error(`environment: revision "${target}" is absent after freezing draft "${draftId}"`)
    return revision
  })
}
