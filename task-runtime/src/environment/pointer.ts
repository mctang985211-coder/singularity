/**
 * The one effective pointer of an environment library and the one transaction
 * that moves it: persistent intent, freeze by rename, verified read-back, atomic
 * switch, completion record, intent clear — with a reconcile that settles any
 * window a killed process left open.
 * @module dsh-singularity-task-runtime/environment/pointer
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import { skillContentDigest } from '../skill-contract.ts'
import { ENVIRONMENT_DRAFT_ID, ENVIRONMENT_REVISION_ID, emptyRevisionManifest, manifestDigest, parseRevisionManifest } from './revision.ts'
import type { EnvironmentRevision, EnvironmentRevisionManifest } from './revision.ts'
import {
  appendLineDurable,
  draftsRoot,
  ensureEnvironmentLayout,
  ensureProtocolMarker,
  freezeDraftDirectory,
  hasLegacyLayout,
  readRevision,
  readRevisionManifest,
  revisionRoot,
  serialEnvironment,
  syncDirectory,
  verifyRevisionDirectory,
  writeFileAtomic,
  writeRevisionManifest,
} from './store.ts'
import type { LibraryRoots } from './store.ts'

/** The one active pointer of a library; `generation` increments on every switch and is the CAS dimension. */
export interface EnvironmentPointer {
  readonly formatVersion: 1
  readonly libraryId: string
  readonly revisionId: string
  readonly manifestDigest: string
  readonly generation: number
  readonly publishedAt: string
  readonly publishedBy: string
  readonly approvalRef?: string
}

/** The persistent record of an in-flight switch; exists only inside the switch window. */
export interface EnvironmentPointerIntent {
  readonly formatVersion: 1
  /** `${libraryId}/g<expected.generation+1>/<nextRevisionId>` — deterministic, so a replayed request names the same intent. */
  readonly intentId: string
  readonly libraryId: string
  readonly direction: 'publish' | 'rollback'
  /** The pointer this switch expects to replace; `null` only for a library's first revision. */
  readonly expected: { revisionId: string; generation: number } | null
  readonly next: { revisionId: string; manifestDigest: string }
  readonly draftId?: string
  readonly approvalRef?: string
  readonly actor: string
  readonly at: string
}

/** One settled switch, appended to `completions.jsonl`. */
export interface EnvironmentPointerCompletion {
  readonly formatVersion: 1
  readonly intentId: string
  readonly libraryId: string
  readonly direction: 'publish' | 'rollback'
  readonly revisionId: string
  readonly manifestDigest: string
  readonly generation: number
  readonly supersededRevisionId: string | null
  readonly approvalRef?: string
  readonly actor: string
  readonly at: string
}

/** The stages the transaction reports to a test probe, in order. */
export type EnvironmentCommitStage =
  | 'intent-recorded'
  | 'revision-frozen'
  | 'revision-verified'
  | 'pointer-switched'
  | 'completion-recorded'
  | 'intent-cleared'

/** The host a commit runs against; `probe` is a typed test seam a production deployment never sets. */
export interface EnvironmentCommitHost {
  readonly library: LibraryRoots
  probe?(stage: EnvironmentCommitStage, detail?: string): void | Promise<void>
}

/** Where a published revision comes from: a draft (frozen by the transaction) or an already frozen revision. */
export type EnvironmentPublishSource =
  | { readonly kind: 'draft'; readonly draftId: string }
  | { readonly kind: 'revision'; readonly revisionId: string }

/** One requested switch. `expected` is the two-dimensional CAS: the caller must have read exactly this pointer. */
export interface PublishRequest {
  readonly direction: 'publish' | 'rollback'
  readonly source: EnvironmentPublishSource
  readonly expected: { revisionId: string; generation: number }
  readonly approvalRef?: string
  readonly actor: string
}

/** The result of one settled switch. */
export interface PublishOutcome {
  readonly pointer: EnvironmentPointer
  readonly supersededRevisionId: string | null
  readonly completion: EnvironmentPointerCompletion
  /** `fresh` when this call ran the transaction; the other two name which step a reconcile had to redo. */
  readonly recovered: 'fresh' | 'completed-frozen' | 'completed-switched'
}

/** What `reconcileEnvironmentPointer` concluded about one open intent. */
export interface EnvironmentPointerReconcile {
  readonly intentId: string
  readonly direction: 'publish' | 'rollback'
  readonly result: 'completed-switched' | 'completed-frozen' | 'blocked'
  readonly revisionId: string
  readonly detail?: string
}

/** What the initial revision of a new-protocol library is seeded with. */
interface InitialSeed {
  readonly actor: string
  readonly at?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pointerPath(library: LibraryRoots): string {
  return join(library.root, 'pointer.json')
}

function intentPath(library: LibraryRoots): string {
  return join(library.root, 'pointer-intent.json')
}

function completionsPath(library: LibraryRoots): string {
  return join(library.root, 'completions.jsonl')
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`environment: ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parsePointer(raw: unknown, where: string): EnvironmentPointer {
  if (!isRecord(raw)) throw new Error(`${where}: a pointer must be an object`)
  if (raw.formatVersion !== 1) throw new Error(`${where}: unsupported pointer formatVersion ${JSON.stringify(raw.formatVersion)}`)
  if (typeof raw.libraryId !== 'string' || raw.libraryId.length === 0) throw new Error(`${where}: a pointer requires a libraryId`)
  if (typeof raw.revisionId !== 'string' || !ENVIRONMENT_REVISION_ID.test(raw.revisionId)) throw new Error(`${where}: a pointer requires a valid revisionId`)
  if (typeof raw.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.manifestDigest)) throw new Error(`${where}: a pointer requires a manifestDigest`)
  if (!Number.isInteger(raw.generation) || (raw.generation as number) < 1) throw new Error(`${where}: a pointer generation must be a positive integer`)
  if (typeof raw.publishedAt !== 'string' || raw.publishedAt.length === 0) throw new Error(`${where}: a pointer requires publishedAt`)
  if (typeof raw.publishedBy !== 'string' || raw.publishedBy.length === 0) throw new Error(`${where}: a pointer requires publishedBy`)
  if (raw.approvalRef !== undefined && typeof raw.approvalRef !== 'string') throw new Error(`${where}: approvalRef must be a string when present`)
  return raw as unknown as EnvironmentPointer
}

function parseIntent(raw: unknown, where: string): EnvironmentPointerIntent {
  if (!isRecord(raw)) throw new Error(`${where}: a pointer intent must be an object`)
  if (raw.formatVersion !== 1) throw new Error(`${where}: unsupported intent formatVersion ${JSON.stringify(raw.formatVersion)}`)
  for (const name of ['intentId', 'libraryId', 'actor', 'at'] as const) {
    if (typeof raw[name] !== 'string' || (raw[name] as string).length === 0) throw new Error(`${where}: a pointer intent requires a non-empty ${name}`)
  }
  if (raw.direction !== 'publish' && raw.direction !== 'rollback') throw new Error(`${where}: intent direction must be "publish" or "rollback"`)
  if (raw.expected !== null) {
    if (!isRecord(raw.expected) || typeof raw.expected.revisionId !== 'string' || !Number.isInteger(raw.expected.generation)) {
      throw new Error(`${where}: intent expected must be { revisionId, generation } or null`)
    }
  }
  if (!isRecord(raw.next) || typeof raw.next.revisionId !== 'string' || !ENVIRONMENT_REVISION_ID.test(raw.next.revisionId) ||
    typeof raw.next.manifestDigest !== 'string') {
    throw new Error(`${where}: intent next must be { revisionId, manifestDigest }`)
  }
  if (raw.draftId !== undefined && (typeof raw.draftId !== 'string' || !ENVIRONMENT_DRAFT_ID.test(raw.draftId))) {
    throw new Error(`${where}: intent draftId must be a draft id when present`)
  }
  if (raw.approvalRef !== undefined && typeof raw.approvalRef !== 'string') throw new Error(`${where}: approvalRef must be a string when present`)
  return raw as unknown as EnvironmentPointerIntent
}

function parseCompletion(raw: unknown, where: string): EnvironmentPointerCompletion {
  if (!isRecord(raw)) throw new Error(`${where}: a pointer completion must be an object`)
  if (raw.formatVersion !== 1) throw new Error(`${where}: unsupported completion formatVersion ${JSON.stringify(raw.formatVersion)}`)
  for (const name of ['intentId', 'libraryId', 'revisionId', 'manifestDigest', 'actor', 'at'] as const) {
    if (typeof raw[name] !== 'string' || (raw[name] as string).length === 0) throw new Error(`${where}: a completion requires a non-empty ${name}`)
  }
  if (raw.direction !== 'publish' && raw.direction !== 'rollback') throw new Error(`${where}: completion direction must be "publish" or "rollback"`)
  if (!Number.isInteger(raw.generation) || (raw.generation as number) < 1) throw new Error(`${where}: a completion generation must be a positive integer`)
  if (raw.supersededRevisionId !== null && typeof raw.supersededRevisionId !== 'string') {
    throw new Error(`${where}: supersededRevisionId must be a string or null`)
  }
  return raw as unknown as EnvironmentPointerCompletion
}

/** Read the current pointer, or `null` when the library has none yet (a fresh or a legacy root). */
export async function readPointer(library: LibraryRoots): Promise<EnvironmentPointer | null> {
  const raw = await readJson(pointerPath(library))
  if (raw === undefined) return null
  return parsePointer(raw, `environment: ${pointerPath(library)}`)
}

/** The in-flight switch's intent, or `null` outside a switch window; the single concurrency exclusion point. */
export async function openPointerIntent(library: LibraryRoots): Promise<EnvironmentPointerIntent | null> {
  const raw = await readJson(intentPath(library))
  if (raw === undefined) return null
  return parseIntent(raw, `environment: ${intentPath(library)}`)
}

/** Every settled switch of one library, in append order. */
export async function listPointerCompletions(library: LibraryRoots): Promise<EnvironmentPointerCompletion[]> {
  let text: string
  try {
    text = await readFile(completionsPath(library), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => parseCompletion(JSON.parse(line), `environment: ${completionsPath(library)} line ${index + 1}`))
}

/** The revision the pointer currently names; both must exist and agree, or the library is broken by name. */
export async function readActiveRevision(library: LibraryRoots): Promise<EnvironmentRevision> {
  const pointer = await readPointer(library)
  if (pointer === null) throw new Error(`environment: library "${library.id}" has no active revision; a new-protocol library is born with one`)
  const revision = await readRevision(library, pointer.revisionId)
  if (revision === undefined) {
    throw new Error(`environment: pointer of library "${library.id}" names revision "${pointer.revisionId}", which does not exist on disk`)
  }
  if (revision.manifest.contentDigest !== pointer.manifestDigest) {
    throw new Error(`environment: pointer of library "${library.id}" names digest ${pointer.manifestDigest} but revision "${pointer.revisionId}" reads ${revision.manifest.contentDigest}`)
  }
  return revision
}

/**
 * Create the initial revision `r0001` of a new-protocol library, seeded with the
 * generic task-coordination guidance, and point at it (generation 1). A library
 * with the old mutable layout is refused by name: it enters the legacy read-only
 * view instead, and no `pointer.json` is ever created for it.
 */
export async function ensureInitialRevision(library: LibraryRoots, seed: InitialSeed): Promise<EnvironmentRevision> {
  return serialEnvironment(library, async () => {
    const pointer = await readPointer(library)
    if (pointer !== null) return readActiveRevision(library)
    if (await hasLegacyLayout(library)) {
      throw new Error(
        `environment: library "${library.id}" has the legacy mutable layout (index.json / flat skills); it is read-only and never gets an environment pointer`,
      )
    }
    await ensureEnvironmentLayout(library)
    await ensureProtocolMarker(library)
    const at = seed.at ?? new Date().toISOString()
    const root = revisionRoot(library, 'r0001')
    const existing = await readRevision(library, 'r0001')
    if (existing === undefined) {
      const skillDir = join(root, 'skills', 'task-coordination')
      await mkdir(skillDir, { recursive: true })
      const source = join(dirname(fileURLToPath(import.meta.resolve('@dangosys/dsh-singularity-agent-runtime/package.json'))), 'skills/task-coordination/SKILL.md')
      const skillMd = await readFile(source, 'utf8')
      await writeFile(join(skillDir, 'SKILL.md'), skillMd)
      await writeFile(join(root, 'capabilities.json'), `${JSON.stringify({ rows: {}, mcpServers: {} }, null, 2)}\n`)
      const skillMdSha256 = sha256Hex(skillMd)
      const manifest = emptyRevisionManifest({ libraryId: library.id, revisionId: 'r0001', kind: 'official', basedOn: null, createdAt: at })
      const seeded: EnvironmentRevisionManifest = {
        ...manifest,
        skills: [{
          name: 'task-coordination',
          version: 1,
          digest: skillMdSha256,
          contentDigest: skillContentDigest({ skillMdSha256, resources: [] }),
          contractDigest: null,
          status: 'retained',
          reason: 'Generic platform task coordination guidance',
        }],
      }
      const { contentDigest: _, ...rest } = seeded
      const withDigest: EnvironmentRevisionManifest = { ...rest, contentDigest: manifestDigest(rest) }
      await writeRevisionManifest(root, withDigest)
    }
    const manifest = await readRevisionManifest(library, 'r0001')
    const written: EnvironmentPointer = {
      formatVersion: 1,
      libraryId: library.id,
      revisionId: 'r0001',
      manifestDigest: manifest.contentDigest,
      generation: 1,
      publishedAt: at,
      publishedBy: seed.actor,
    }
    await writeFileAtomic(pointerPath(library), `${JSON.stringify(written, null, 2)}\n`)
    const readback = parsePointer(await readJson(pointerPath(library)), `environment: ${pointerPath(library)} readback`)
    if (canonicalize(readback) !== canonicalize(written)) {
      throw new Error('environment: pointer.json did not read back as written; the initial revision is not in effect')
    }
    const revision = await readRevision(library, 'r0001')
    if (revision === undefined) throw new Error('environment: revision "r0001" is absent after seeding')
    return revision
  })
}

interface ResolvedSource {
  readonly next: { revisionId: string; manifestDigest: string }
  readonly draftId?: string
}

/** Resolve the request's source to the revision it switches to, re-checking draft bytes against their recorded digest. */
async function resolveSource(library: LibraryRoots, request: PublishRequest): Promise<ResolvedSource> {
  if (request.source.kind === 'revision') {
    const revision = await readRevision(library, request.source.revisionId)
    if (revision === undefined) {
      throw new Error(`environment: revision "${request.source.revisionId}" is absent; a switch names a frozen revision on disk`)
    }
    return { next: { revisionId: revision.manifest.revisionId, manifestDigest: revision.manifest.contentDigest } }
  }
  if (request.direction !== 'publish') throw new Error('environment: a rollback switches to a frozen revision, never to a draft')
  const draftId = request.source.draftId
  if (!ENVIRONMENT_DRAFT_ID.test(draftId)) throw new Error(`environment: ${JSON.stringify(draftId)} is not a draft id`)
  const draftDir = join(draftsRoot(library), draftId)
  const draftRecord = await readJson(join(draftDir, 'draft.json'))
  if (draftRecord === undefined) throw new Error(`environment: draft "${draftId}" is absent; a discarded or never-created draft cannot be published`)
  const manifest = await parseDraftManifest(draftDir, draftId)
  if (isRecord(draftRecord) && isRecord(draftRecord.manifest) && draftRecord.manifest.contentDigest !== manifest.contentDigest) {
    throw new Error(`environment: draft "${draftId}" draft.json and manifest.json disagree; the draft was edited outside the draft machinery`)
  }
  return { next: { revisionId: manifest.revisionId, manifestDigest: manifest.contentDigest }, draftId }
}

async function parseDraftManifest(draftDir: string, draftId: string): Promise<EnvironmentRevisionManifest> {
  let text: string
  try {
    text = await readFile(join(draftDir, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`environment: draft "${draftId}" holds no manifest.json`)
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`environment: draft "${draftId}" manifest.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseRevisionManifest(raw, `environment: draft "${draftId}"`)
}

/** One full transaction: `publish` freezes its draft source first; `rollback` verifies its target instead. */
async function commitPointer(host: EnvironmentCommitHost, request: PublishRequest): Promise<PublishOutcome> {
  const library = host.library
  return serialEnvironment(library, async () => {
    // 1. Read the pointer and check the two-dimensional CAS: revisionId + generation.
    const before = await readPointer(library)
    if (before === null) throw new Error(`environment: library "${library.id}" has no pointer to switch; the initial revision creates generation 1`)
    if (before.revisionId !== request.expected.revisionId || before.generation !== request.expected.generation) {
      throw new Error(
        `environment-pointer-changed: library "${library.id}" is at "${before.revisionId}" generation ${before.generation}, ` +
          `not the expected "${request.expected.revisionId}" generation ${request.expected.generation}; re-read the pointer before publishing`,
      )
    }
    const open = await openPointerIntent(library)
    if (open !== null) {
      throw new Error(`environment-intent-open: library "${library.id}" has an open pointer intent "${open.intentId}"; reconcile it before publishing`)
    }
    // 2. Resolve the source; draft bytes are re-digested from disk.
    const source = await resolveSource(library, request)
    // 3. The target revision name must be free; an idempotent replay goes through reconcile.
    if (source.draftId !== undefined && (await readRevision(library, source.next.revisionId)) !== undefined) {
      throw new Error(`environment: revision "${source.next.revisionId}" already exists; if a previous attempt was killed, reconcile the pointer instead of re-publishing`)
    }
    const intent: EnvironmentPointerIntent = {
      formatVersion: 1,
      intentId: `${library.id}/g${before.generation + 1}/${source.next.revisionId}`,
      libraryId: library.id,
      direction: request.direction,
      expected: { revisionId: before.revisionId, generation: before.generation },
      next: source.next,
      ...(source.draftId !== undefined ? { draftId: source.draftId } : {}),
      ...(request.approvalRef !== undefined ? { approvalRef: request.approvalRef } : {}),
      actor: request.actor,
      at: new Date().toISOString(),
    }
    // 4. Persist the intent, atomically.
    await writeFileAtomic(intentPath(library), `${JSON.stringify(intent, null, 2)}\n`)
    await host.probe?.('intent-recorded', intent.intentId)
    // 5. Freeze the draft by rename (publish), or confirm the rollback target exists.
    if (source.draftId !== undefined) await freezeDraftDirectory(library, source.draftId, source.next.revisionId)
    await host.probe?.('revision-frozen', source.next.revisionId)
    // 6. Read the frozen revision back and verify the whole directory against its manifest.
    const manifest = await readRevisionManifest(library, source.next.revisionId)
    const { defects } = await verifyRevisionDirectory(revisionRoot(library, source.next.revisionId), manifest)
    if (defects.length > 0) {
      throw new Error(`environment: revision "${source.next.revisionId}" does not verify against its manifest:\n- ${defects.join('\n- ')}`)
    }
    if (manifest.contentDigest !== source.next.manifestDigest) {
      throw new Error(`environment: revision "${source.next.revisionId}" reads digest ${manifest.contentDigest}, expected ${source.next.manifestDigest}`)
    }
    await host.probe?.('revision-verified', source.next.revisionId)
    // 7. Switch the pointer, atomically; generation increments by one. Re-check the CAS first: a third party that moved the pointer mid-transaction is refused, never overwritten.
    const recheck = await readPointer(library)
    if (recheck === null || recheck.revisionId !== before.revisionId || recheck.generation !== before.generation) {
      throw new Error(
        `environment-pointer-changed: library "${library.id}" moved to ${recheck === null ? 'no pointer' : `"${recheck.revisionId}" generation ${recheck.generation}`} ` +
          'while this switch was in flight; the frozen revision stays, the intent stays open, and the third-party pointer is not overwritten',
      )
    }
    const pointer = await switchPointer(library, intent, before, manifest, request)
    await host.probe?.('pointer-switched', pointer.revisionId)
    // 8. Read the pointer back; it must be exactly what was written.
    await assertPointerReadback(library, pointer)
    // 9. Record the completion, durably.
    const completion = await recordCompletion(library, intent, pointer, before.revisionId, request)
    await host.probe?.('completion-recorded', completion.intentId)
    // 10. Clear the intent; the window is closed.
    await clearIntent(library)
    await host.probe?.('intent-cleared', intent.intentId)
    return { pointer, supersededRevisionId: before.revisionId, completion, recovered: 'fresh' }
  })
}

async function switchPointer(
  library: LibraryRoots,
  intent: EnvironmentPointerIntent,
  before: EnvironmentPointer,
  manifest: EnvironmentRevisionManifest,
  request: PublishRequest,
): Promise<EnvironmentPointer> {
  const pointer: EnvironmentPointer = {
    formatVersion: 1,
    libraryId: library.id,
    revisionId: intent.next.revisionId,
    manifestDigest: manifest.contentDigest,
    generation: before.generation + 1,
    publishedAt: new Date().toISOString(),
    publishedBy: request.actor,
    ...(request.approvalRef !== undefined ? { approvalRef: request.approvalRef } : {}),
  }
  await writeFileAtomic(pointerPath(library), `${JSON.stringify(pointer, null, 2)}\n`)
  return pointer
}

async function assertPointerReadback(library: LibraryRoots, pointer: EnvironmentPointer): Promise<void> {
  const readback = await readPointer(library)
  if (readback === null || canonicalize(readback) !== canonicalize(pointer)) {
    throw new Error(
      `environment: pointer.json did not read back as the switch wrote it; the completion is not recorded and the intent stays open until reconcile settles it`,
    )
  }
}

async function recordCompletion(
  library: LibraryRoots,
  intent: EnvironmentPointerIntent,
  pointer: EnvironmentPointer,
  supersededRevisionId: string | null,
  request: PublishRequest,
): Promise<EnvironmentPointerCompletion> {
  const completion: EnvironmentPointerCompletion = {
    formatVersion: 1,
    intentId: intent.intentId,
    libraryId: library.id,
    direction: intent.direction,
    revisionId: pointer.revisionId,
    manifestDigest: pointer.manifestDigest,
    generation: pointer.generation,
    supersededRevisionId,
    ...(request.approvalRef !== undefined ? { approvalRef: request.approvalRef } : {}),
    actor: request.actor,
    at: new Date().toISOString(),
  }
  await appendLineDurable(completionsPath(library), `${JSON.stringify(completion)}\n`)
  return completion
}

async function clearIntent(library: LibraryRoots): Promise<void> {
  await rm(intentPath(library), { force: true })
  await syncDirectory(library.root)
}

/** Publish a draft or a frozen candidate revision: one CAS-checked pointer switch. */
export async function publishEnvironmentRevision(host: EnvironmentCommitHost, request: PublishRequest): Promise<PublishOutcome> {
  if (request.direction !== 'publish') throw new Error('environment: publishEnvironmentRevision requires direction "publish"')
  return commitPointer(host, request)
}

/** Roll back to a frozen revision: the same transaction, freezing skipped, target verified. */
export async function rollbackEnvironmentRevision(host: EnvironmentCommitHost, request: PublishRequest): Promise<PublishOutcome> {
  if (request.direction !== 'rollback') throw new Error('environment: rollbackEnvironmentRevision requires direction "rollback"')
  if (request.source.kind !== 'revision') throw new Error('environment: a rollback switches to a frozen revision, never to a draft')
  return commitPointer(host, request)
}

/**
 * Settle every open intent of one library after a crash or at startup. The
 * classification reads only disk facts: a switched pointer is completed and
 * cleared, a frozen-but-unswitched intent is finished from step 7, an unfrozen
 * publish intent is redone from step 5, and a pointer moved by a third party
 * blocks the intent without touching anything.
 */
export async function reconcileEnvironmentPointer(host: EnvironmentCommitHost): Promise<EnvironmentPointerReconcile[]> {
  const library = host.library
  return serialEnvironment(library, async () => {
    const intent = await openPointerIntent(library)
    if (intent === null) return []
    const report = (result: EnvironmentPointerReconcile['result'], detail?: string): EnvironmentPointerReconcile[] => [
      { intentId: intent.intentId, direction: intent.direction, result, revisionId: intent.next.revisionId, ...(detail !== undefined ? { detail } : {}) },
    ]
    const pointer = await readPointer(library)
    const expectedGeneration = (intent.expected?.generation ?? 0) + 1
    if (pointer !== null && pointer.revisionId === intent.next.revisionId && pointer.generation === expectedGeneration) {
      // The switch happened; only completion and cleanup may remain.
      const manifest = await readRevisionManifest(library, intent.next.revisionId)
      const { defects } = await verifyRevisionDirectory(revisionRoot(library, intent.next.revisionId), manifest)
      if (defects.length > 0) return report('blocked', `revision "${intent.next.revisionId}" does not verify: ${defects.join('; ')}`)
      const completions = await listPointerCompletions(library)
      if (!completions.some(item => item.intentId === intent.intentId)) {
        await appendLineDurable(completionsPath(library), `${JSON.stringify({
          formatVersion: 1,
          intentId: intent.intentId,
          libraryId: library.id,
          direction: intent.direction,
          revisionId: pointer.revisionId,
          manifestDigest: pointer.manifestDigest,
          generation: pointer.generation,
          supersededRevisionId: intent.expected?.revisionId ?? null,
          ...(intent.approvalRef !== undefined ? { approvalRef: intent.approvalRef } : {}),
          actor: intent.actor,
          at: new Date().toISOString(),
        } satisfies EnvironmentPointerCompletion)}\n`)
        await host.probe?.('completion-recorded', intent.intentId)
      }
      await clearIntent(library)
      await host.probe?.('intent-cleared', intent.intentId)
      return report('completed-switched')
    }
    const expected = intent.expected
    const pointerIsExpected =
      expected === null ? pointer === null : pointer !== null && pointer.revisionId === expected.revisionId && pointer.generation === expected.generation
    if (!pointerIsExpected) {
      return report(
        'blocked',
        `pointer is at ${pointer === null ? 'none' : `"${pointer.revisionId}" generation ${pointer.generation}`}, which is neither the expected ` +
          `${expected === null ? 'none' : `"${expected.revisionId}" generation ${expected.generation}`} nor the intent's target; a third party moved the pointer, and the intent stays open`,
      )
    }
    const frozen = await readRevision(library, intent.next.revisionId)
    if (frozen !== undefined) {
      if (pointer === null) return report('blocked', 'the library has no pointer at all; an intent without a prior pointer is not a state this build produces')
      // Frozen but not switched: finish from step 7.
      const { defects } = await verifyRevisionDirectory(frozen.root, frozen.manifest)
      if (defects.length > 0) return report('blocked', `revision "${intent.next.revisionId}" does not verify: ${defects.join('; ')}`)
      if (frozen.manifest.contentDigest !== intent.next.manifestDigest) {
        return report('blocked', `revision "${intent.next.revisionId}" reads ${frozen.manifest.contentDigest}, intent expected ${intent.next.manifestDigest}`)
      }
      const request: PublishRequest = {
        direction: intent.direction,
        source: { kind: 'revision', revisionId: intent.next.revisionId },
        expected: expected ?? { revisionId: '', generation: 0 },
        ...(intent.approvalRef !== undefined ? { approvalRef: intent.approvalRef } : {}),
        actor: intent.actor,
      }
      const switched = await switchPointer(library, intent, pointer, frozen.manifest, request)
      await host.probe?.('pointer-switched', switched.revisionId)
      await assertPointerReadback(library, switched)
      const completion = await recordCompletion(library, intent, switched, pointer.revisionId, request)
      await host.probe?.('completion-recorded', completion.intentId)
      await clearIntent(library)
      await host.probe?.('intent-cleared', intent.intentId)
      return report('completed-switched')
    }
    if (intent.direction === 'publish' && intent.draftId !== undefined) {
      const draftPresent = await readJson(join(draftsRoot(library), intent.draftId, 'draft.json'))
      if (draftPresent !== undefined) {
        if (pointer === null) return report('blocked', 'the library has no pointer at all; an intent without a prior pointer is not a state this build produces')
        // The freeze never happened: redo from step 5.
        await freezeDraftDirectory(library, intent.draftId, intent.next.revisionId)
        await host.probe?.('revision-frozen', intent.next.revisionId)
        const manifest = await readRevisionManifest(library, intent.next.revisionId)
        const { defects } = await verifyRevisionDirectory(revisionRoot(library, intent.next.revisionId), manifest)
        if (defects.length > 0) return report('blocked', `revision "${intent.next.revisionId}" does not verify after refreezing: ${defects.join('; ')}`)
        await host.probe?.('revision-verified', intent.next.revisionId)
        const request: PublishRequest = {
          direction: intent.direction,
          source: { kind: 'revision', revisionId: intent.next.revisionId },
          expected: expected ?? { revisionId: '', generation: 0 },
          ...(intent.approvalRef !== undefined ? { approvalRef: intent.approvalRef } : {}),
          actor: intent.actor,
        }
        const switched = await switchPointer(library, intent, pointer, manifest, request)
        await host.probe?.('pointer-switched', switched.revisionId)
        await assertPointerReadback(library, switched)
        const completion = await recordCompletion(library, intent, switched, pointer.revisionId, request)
        await host.probe?.('completion-recorded', completion.intentId)
        await clearIntent(library)
        await host.probe?.('intent-cleared', intent.intentId)
        return report('completed-frozen')
      }
    }
    return report('blocked', `revision "${intent.next.revisionId}" is absent and there is no draft to re-freeze; a human must settle the intent by name`)
  })
}
