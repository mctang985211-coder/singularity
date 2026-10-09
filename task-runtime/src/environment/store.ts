/**
 * The on-disk layout of one environment library and the only definition of
 * "a revision directory is complete": paths, durable file writes, freeze by
 * rename, and whole-revision verification against its manifest.
 * @module dsh-singularity-task-runtime/environment/store
 */

import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { canonicalize, sha256Hex, taskTemplateDigest } from '@dangosys/dsh-singularity-task'
import type { TaskTemplate } from '@dangosys/dsh-singularity-task'
import { parseTaskTemplate } from '../task-template.ts'
import { loadSkillSidecar } from '../sidecar.ts'
import { SKILL_SIDECAR_FILE, skillContentDigest, skillContractDigest } from '../skill-contract.ts'
import { ENVIRONMENT_REVISION_ID, manifestDigest, parseRevisionManifest, revisionRefOf } from './revision.ts'
import type {
  EnvironmentRevision,
  EnvironmentRevisionManifest,
  EnvironmentRevisionRef,
} from './revision.ts'

/** One library's identity and root: `$DSH_HOME/singularity/environments/<id>`. */
export interface LibraryRoots {
  readonly id: string
  readonly root: string
}

/** A library root is derived from the graph's immutable root session identity; no second persistent binding. */
export function libraryRoots(rootSessionId: string, home = process.env.DSH_HOME || join(homedir(), '.dsh')): LibraryRoots {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(rootSessionId)) throw new Error('environment: invalid graph root session id')
  return { id: rootSessionId, root: join(home, 'singularity', 'environments', rootSessionId) }
}

function environmentProtocolMarker(library: LibraryRoots): string {
  return join(library.root, 'protocol.json')
}

export function revisionsRoot(library: LibraryRoots): string {
  return join(library.root, 'revisions')
}

export function draftsRoot(library: LibraryRoots): string {
  return join(library.root, 'drafts')
}

/** The directory of one revision; the id is validated before it ever becomes a path component. */
export function revisionRoot(library: LibraryRoots, revisionId: string): string {
  if (!ENVIRONMENT_REVISION_ID.test(revisionId)) throw new Error(`environment: ${JSON.stringify(revisionId)} is not a revision id`)
  return join(revisionsRoot(library), revisionId)
}

/** fsync one directory so an entry created, renamed or removed inside it is durable. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Replace `target` with exactly `bytes`, durably: staging sibling, file fsync, rename, directory fsync. */
export async function writeFileAtomic(target: string, bytes: Buffer | string): Promise<void> {
  const directory = dirname(target)
  const staging = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let handle: FileHandle | undefined
  try {
    await mkdir(directory, { recursive: true })
    handle = await open(staging, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(staging, target)
    await syncDirectory(directory)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(staging, { force: true }).catch(() => {})
    throw error
  }
}

/** Append one line to a JSONL log, durably: append, file fsync, directory fsync. */
export async function appendLineDurable(target: string, line: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const handle = await open(target, 'a')
  try {
    await handle.writeFile(line)
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
  await syncDirectory(dirname(target))
}

/** Create the two directories every library of the new protocol holds. */
export async function ensureEnvironmentLayout(library: LibraryRoots): Promise<void> {
  await mkdir(revisionsRoot(library), { recursive: true })
  await mkdir(draftsRoot(library), { recursive: true })
}

/** The new-protocol marker, written once when a library's initial revision is created; a legacy layout never gets one. */
export async function ensureProtocolMarker(library: LibraryRoots): Promise<void> {
  const marker = environmentProtocolMarker(library)
  const text = `${JSON.stringify({ formatVersion: 1, protocol: 'environment-revision' }, null, 2)}\n`
  try {
    await writeFile(marker, text, { flag: 'wx' })
    await syncDirectory(library.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(marker, 'utf8').catch(() => '')
    if (existing !== text) throw new Error(`environment: ${marker} exists with different content; the protocol marker is written once and never edited`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Whether this library root predates the revision protocol: no marker, but the old mutable layout's tell-tale entries. */
export async function hasLegacyLayout(library: LibraryRoots): Promise<boolean> {
  if (await pathExists(environmentProtocolMarker(library))) return false
  for (const name of ['index.json', 'skills', 'task-templates']) {
    if (await pathExists(join(library.root, name))) return true
  }
  return false
}

/** Per-library write serialization: one tail promise per root, shared by draft staging and the pointer transaction. */
const tails = new Map<string, Promise<unknown>>()
export async function serialEnvironment<T>(library: LibraryRoots, work: () => Promise<T>): Promise<T> {
  const pending = (tails.get(library.root) ?? Promise.resolve()).catch(() => {}).then(work)
  tails.set(library.root, pending)
  try {
    return await pending
  } finally {
    if (tails.get(library.root) === pending) tails.delete(library.root)
  }
}

async function readManifestFile(directory: string, where: string): Promise<EnvironmentRevisionManifest> {
  let text: string
  try {
    text = await readFile(join(directory, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`environment: ${where} holds no manifest.json`)
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`environment: ${where} manifest.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseRevisionManifest(raw, `environment: ${where}`)
}

/** Read and fully validate one revision's manifest, including its self-digest. */
export async function readRevisionManifest(library: LibraryRoots, revisionId: string): Promise<EnvironmentRevisionManifest> {
  const directory = revisionRoot(library, revisionId)
  const manifest = await readManifestFile(directory, `revision "${revisionId}"`)
  if (manifest.revisionId !== revisionId) {
    throw new Error(`environment: ${directory} holds a manifest for "${manifest.revisionId}", not "${revisionId}"; a revision directory and its manifest name one revision`)
  }
  if (manifest.libraryId !== library.id) {
    throw new Error(`environment: revision "${revisionId}" belongs to library "${manifest.libraryId}", not "${library.id}"`)
  }
  return manifest
}

/** Resolve one revision directory, or `undefined` when it does not exist. */
export async function readRevision(library: LibraryRoots, revisionId: string): Promise<EnvironmentRevision | undefined> {
  const root = revisionRoot(library, revisionId)
  if (!(await pathExists(root))) return undefined
  const manifest = await readRevisionManifest(library, revisionId)
  return { manifest, root, skillRoot: join(root, 'skills'), taskTemplatesRoot: join(root, 'task-templates') }
}

/** List every revision of one library as listing projections, sorted by id. */
export async function listRevisions(library: LibraryRoots): Promise<EnvironmentRevisionRef[]> {
  let entries
  try {
    entries = await readdir(revisionsRoot(library), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const revisions: EnvironmentRevisionRef[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    revisions.push(revisionRefOf(await readRevisionManifest(library, entry.name)))
  }
  return revisions.sort((left, right) => (left.revisionId < right.revisionId ? -1 : 1))
}

/** Write one manifest into its directory, durably; the manifest's self-digest is re-checked before a byte moves. */
export async function writeRevisionManifest(directory: string, manifest: EnvironmentRevisionManifest): Promise<void> {
  const { contentDigest, ...rest } = manifest
  if (manifestDigest(rest) !== contentDigest) {
    throw new Error(`environment: refusing to write a manifest whose contentDigest does not match its content (${directory})`)
  }
  await writeFileAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Freeze one draft into an immutable revision: an atomic same-filesystem rename,
 * then fsync of both the revisions directory and the library root, in that order —
 * a pointer may only ever be written after this returns.
 */
export async function freezeDraftDirectory(library: LibraryRoots, draftId: string, revisionId: string): Promise<void> {
  const from = join(draftsRoot(library), draftId)
  const to = revisionRoot(library, revisionId)
  const exists = await readdir(to).then(() => true, () => false)
  if (exists) throw new Error(`environment: revision "${revisionId}" already exists; a frozen revision is immutable`)
  try {
    await rename(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      throw new Error(`environment: drafts and revisions of library "${library.id}" are on different filesystems; freezing a draft requires an atomic rename`)
    }
    if (code === 'ENOENT') throw new Error(`environment: draft "${draftId}" is absent; nothing to freeze`)
    throw error
  }
  await syncDirectory(revisionsRoot(library))
  await syncDirectory(library.root)
}

/** Copy one revision directory as the starting content of a draft; a draft never edits its base in place. */
export async function copyRevisionDirectory(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, errorOnExist: true, force: false })
  await syncDirectory(dirname(to))
}

/** The defects one revision directory has against its manifest; empty means the directory is exactly what the manifest declares. */
interface RevisionDefects {
  readonly defects: readonly string[]
}

/**
 * Verify one whole revision directory against its manifest: every skill's bytes
 * and sidecar, every template file, and the capability table — the single check
 * that replaces the old commit path's per-file and per-row read-backs.
 */
export async function verifyRevisionDirectory(directory: string, manifest: EnvironmentRevisionManifest): Promise<RevisionDefects> {
  const defects: string[] = []
  const skillsDir = join(directory, 'skills')
  const skillEntries = await readdir(skillsDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (manifest.skills.length > 0) defects.push(`${skillsDir} is absent but the manifest declares ${manifest.skills.length} skills`)
      return null
    }
    throw error
  })
  if (skillEntries !== null) {
    const declared = new Set(manifest.skills.map(entry => entry.name))
    for (const entry of skillEntries) {
      if (entry.name.startsWith('.')) continue
      if (!declared.has(entry.name)) defects.push(`${join(skillsDir, entry.name)} is not declared by the manifest; a revision holds declared entries only`)
    }
    for (const entry of manifest.skills) {
      const loaded = await loadSkillSidecar(join(skillsDir, entry.name))
      defects.push(...loaded.defects.map(defect => `skill "${entry.name}": ${defect.code}: ${defect.detail}`))
      if (loaded.content === undefined) continue
      if (loaded.content.skillMdSha256 !== entry.digest) {
        defects.push(`skill "${entry.name}": SKILL.md is not the declared content: manifest ${entry.digest}, read ${loaded.content.skillMdSha256}`)
      }
      const contentDigest = skillContentDigest(loaded.content)
      if (contentDigest !== entry.contentDigest) {
        defects.push(`skill "${entry.name}": content identity mismatch: manifest ${entry.contentDigest}, read ${contentDigest}`)
      }
      const declared3 = loaded.sidecar === undefined ? null : skillContractDigest(loaded.sidecar)
      if (declared3 !== entry.contractDigest) {
        defects.push(`skill "${entry.name}": sidecar mismatch: manifest ${entry.contractDigest ?? 'none'}, read ${declared3 ?? 'none'}`)
      }
    }
  }
  const templatesDir = join(directory, 'task-templates')
  const templateEntries = await readdir(templatesDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (manifest.taskTemplates.length > 0) defects.push(`${templatesDir} is absent but the manifest declares ${manifest.taskTemplates.length} task templates`)
      return null
    }
    throw error
  })
  if (templateEntries !== null) {
    const declared = new Set(manifest.taskTemplates.map(entry => `${entry.templateRef.id}@${entry.templateRef.version}.json`))
    for (const entry of templateEntries) {
      if (entry.name.startsWith('.')) continue
      if (!declared.has(entry.name)) defects.push(`${join(templatesDir, entry.name)} is not declared by the manifest`)
    }
    for (const entry of manifest.taskTemplates) {
      const file = join(templatesDir, `${entry.templateRef.id}@${entry.templateRef.version}.json`)
      let template: TaskTemplate
      try {
        template = parseTaskTemplate(JSON.parse(await readFile(file, 'utf8')))
      } catch (error) {
        defects.push(`task template "${entry.templateRef.id}@${entry.templateRef.version}": ${file} is not a readable template: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const digest = taskTemplateDigest(template)
      if (digest !== entry.templateRef.digest) {
        defects.push(`task template "${entry.templateRef.id}@${entry.templateRef.version}": content mismatch: manifest ${entry.templateRef.digest}, read ${digest}`)
      }
    }
  }
  const capabilitiesFile = join(directory, 'capabilities.json')
  let capabilitiesText: string | undefined
  try {
    capabilitiesText = await readFile(capabilitiesFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    defects.push(`${capabilitiesFile} is absent; every revision declares its capability table`)
  }
  if (capabilitiesText !== undefined) {
    try {
      const parsed = JSON.parse(capabilitiesText) as unknown
      if (canonicalize(parsed) !== canonicalize(manifest.capabilities)) {
        defects.push(`${capabilitiesFile} does not match the manifest's capability table`)
      }
    } catch (error) {
      defects.push(`${capabilitiesFile} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { defects }
}
