/**
 * The legacy v4 ledger (`proposals.jsonl`) as this deployment still holds it:
 * the read-only projection of every proposal, and the one recovery that settles
 * an interrupted commit intent from the bytes the intent itself recorded.
 *
 * Nothing here drafts, evaluates, promotes or publishes: the new protocol's
 * `draft → evaluate → publish` path owns all of that, and the publish pointer
 * transaction owns every new production write. What survives is the one job a
 * deployment with an old ledger still needs — its production files are made to
 * agree with what the ledger recorded, or the disagreement is reported by name.
 *
 * @module dsh-singularity-evolution/legacy/service
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { assertSegment } from '../shared.ts'

/** Which way one legacy commit moves a production target. */
export type CommitDirection = 'apply' | 'rollback'

/** One file of one legacy commit: where it goes, the bytes production must hold before and after, and where its recoverable source lives. */
export interface CommitFile {
  readonly target: string
  /** The digest this file must hold before the write; `null` when it must not exist. */
  readonly baselineSha256: string | null
  /** The digest this file must hold after the write; `null` when the commit removes it. */
  readonly contentSha256: string | null
  /** The recoverable bytes for this file, relative to the ledger root; absent when this direction removes the file. */
  readonly source?: string
}

/** The one capability row a legacy commit carries. */
export interface CommitCapability {
  readonly name: string
  readonly baselineSha256: string | null
  readonly contentSha256: string | null
  readonly source?: string
}

/** One open legacy commit intent, as every read of the old ledger exposes it. */
export interface CommitIntentView {
  readonly intentId: string
  readonly proposalId: string
  readonly direction: CommitDirection
  readonly approvalRef: string
  readonly files: readonly CommitFile[]
  readonly capability?: CommitCapability
  readonly actor: string
  readonly at: string
}

/** What one apply of the legacy path changed, returned to a caller that asked for it. */
export interface ApplyOutcome {
  readonly targets: readonly string[]
  /** Set only when the settle found a commit intent already open for the proposal. */
  readonly recovered?: 'redone' | 'written'
}

/** What one reconciliation of an open legacy intent settled to. */
export interface ReconcileOutcome {
  readonly intentId: string
  readonly proposalId: string
  readonly direction: CommitDirection
  /** The absolute production targets the intent committed, in intent order. */
  readonly targets: readonly string[]
  /** `completed-redone`: production still held the pre-commit state, so the same write was carried out again. */
  readonly result: 'completed-redone' | 'completed-written' | 'blocked'
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  readonly detail?: string
}

/** The legacy service's own configuration; every field optional — the constructor resolves defaults. */
export interface Config {
  /** Graph library identity supplied by the server when it constructs a scoped service. */
  libraryId?: string
  /** Directory of the ledger file `proposals.jsonl`. Defaults to `$DSH_HOME/evolution`. */
  root?: string
  /** Production skill root — a legacy settle reads and writes here. Defaults to `$DSH_HOME/skills`. */
  skillRoot?: string
  /** The harness repo root: the parent of the `$DSH_HOME` fallback. */
  repoRoot?: string
  /** The deployment's capability table file, named in the refusal of an intent that carries a capability row. */
  capabilityConfig?: string
  /**
   * The model-selection resolver the v4 deployment wired. The legacy path
   * records no model and reads none, so this is accepted for composition
   * compatibility only; a new evaluation names its selection on the plan.
   */
  modelSelection?: () => unknown
  /** Task template catalog root for this graph's library, carried for composition compatibility only. */
  taskTemplatesRoot?: string
}

interface LegacyRecord {
  formatVersion?: unknown
  kind: string
  proposalId?: unknown
  intentId?: unknown
  direction?: unknown
  approvalRef?: unknown
  actor?: unknown
  at?: unknown
  targets?: unknown
  files?: unknown
  capability?: unknown
}

interface ProposalState {
  proposalId: string
  openIntent?: CommitIntentView
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve `rel` under `base`, refusing anything that would land outside it. */
function within(base: string, rel: string): string {
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    throw new Error(`evolution: the recorded path "${rel}" escapes ${base}`)
  }
  return abs
}

/**
 * The legacy plane as this deployment still holds it: one `proposals.jsonl`,
 * read for display and settled when a commit was interrupted.
 */
export class EvolutionService extends Service {
  /** The server-bound graph library; undefined denotes the shared/global service. */
  readonly libraryId?: string
  /** Absolute ledger directory resolved at construction. */
  readonly root: string
  /** Production skill root — a settle reads and writes here. */
  readonly skillRoot: string
  /** Repo root that relative evidence paths resolve against (see `Config.repoRoot`). */
  readonly repoRoot: string
  /** The deployment's capability table file, when it named one. */
  private readonly capabilityConfigPath?: string
  private records: LegacyRecord[] = []
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolution')
    if (config.libraryId !== undefined) assertSegment(config.libraryId, 'libraryId')
    this.libraryId = config.libraryId
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.capabilityConfigPath = config.capabilityConfig === undefined ? undefined : resolve(config.capabilityConfig)
    const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, '.dsh')
    this.root = resolve(config.root ?? join(dshHome, 'evolution'))
    this.skillRoot = resolve(config.skillRoot ?? join(dshHome, 'skills'))
    this.loaded = this.load()
    ctx.effect(() => () => this.writes, 'evolution: drain writes')
  }

  /** Ledger file path (`<root>/proposals.jsonl`). */
  get file(): string {
    return join(this.root, 'proposals.jsonl')
  }

  /**
   * Settle every open commit intent, in ledger order. An intent whose
   * production state is the one it recorded is carried out; an intent whose
   * production moved is reported by name and left alone.
   */
  async reconcile(): Promise<ReconcileOutcome[]> {
    await this.loaded
    const outcomes: ReconcileOutcome[] = []
    for (const intent of this.openIntents()) outcomes.push(await this.settle(intent))
    return outcomes
  }

  /** The production targets the ledger's open commit intents name, in ledger order. */
  async openIntentTargets(): Promise<readonly string[]> {
    await this.loaded
    return this.openIntents().flatMap(intent => intent.files.map(file => file.target))
  }

  /** The capability rows the ledger's open commit intents name, in ledger order. */
  async openIntentCapabilities(): Promise<readonly string[]> {
    await this.loaded
    const rows: string[] = []
    for (const intent of this.openIntents()) {
      const name = intent.capability?.name
      if (name !== undefined && !rows.includes(name)) rows.push(name)
    }
    return rows
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const records: LegacyRecord[] = text
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as LegacyRecord
        } catch {
          throw new Error(`evolution: corrupt ledger line ${index + 1} in ${this.file}`)
        }
      })
    for (const [index, record] of records.entries()) {
      if (record.formatVersion === 4) continue
      throw new Error(
        `evolution: ledger line ${index + 1} in ${this.file} declares formatVersion ` +
          `${JSON.stringify(record.formatVersion ?? null)} — this reader reads the v4 ledger only, so a v1, a v2, a v3, an unversioned or a ` +
          'v5 line is refused before anything is settled (a new-protocol graph is read through the draft views)',
      )
    }
    this.records = records
  }

  /** Every commit intent still open, in ledger order — one per proposal at most. */
  private openIntents(): CommitIntentView[] {
    const proposals = new Map<string, ProposalState>()
    for (const record of this.records) {
      const proposalId = typeof record.proposalId === 'string' ? record.proposalId : undefined
      if (proposalId === undefined) continue
      if (record.kind === 'commit_intent') {
        const intent = this.intentOf(record, proposalId)
        if (intent !== undefined) proposals.set(proposalId, { proposalId, openIntent: intent })
        continue
      }
      if (record.kind === 'applied' || record.kind === 'rolledback') {
        const state = proposals.get(proposalId)
        if (state?.openIntent !== undefined && state.openIntent.intentId === record.intentId) state.openIntent = undefined
      }
    }
    return [...proposals.values()].flatMap(state => (state.openIntent === undefined ? [] : [state.openIntent]))
  }

  private intentOf(record: LegacyRecord, proposalId: string): CommitIntentView | undefined {
    if (!Array.isArray(record.files)) return undefined
    const files: CommitFile[] = record.files.filter(isRecord).map(file => ({
      target: String(file.target ?? ''),
      baselineSha256: typeof file.baselineSha256 === 'string' ? file.baselineSha256 : null,
      contentSha256: typeof file.contentSha256 === 'string' ? file.contentSha256 : null,
      ...(typeof file.source === 'string' ? { source: file.source } : {}),
    }))
    if (files.some(file => file.target.length === 0)) return undefined
    const capability = isRecord(record.capability)
      ? {
          name: String(record.capability.name ?? ''),
          baselineSha256: typeof record.capability.baselineSha256 === 'string' ? record.capability.baselineSha256 : null,
          contentSha256: typeof record.capability.contentSha256 === 'string' ? record.capability.contentSha256 : null,
          ...(typeof record.capability.source === 'string' ? { source: record.capability.source } : {}),
        }
      : undefined
    return {
      intentId: String(record.intentId ?? ''),
      proposalId,
      direction: record.direction === 'rollback' ? 'rollback' : 'apply',
      approvalRef: String(record.approvalRef ?? ''),
      files,
      ...(capability === undefined ? {} : { capability }),
      actor: String(record.actor ?? ''),
      at: String(record.at ?? ''),
    }
  }

  /** Settle one open intent against the filesystem, or stop by name. */
  private async settle(intent: CommitIntentView): Promise<ReconcileOutcome> {
    const targets = intent.files.map(file => file.target)
    const outcome = (result: ReconcileOutcome['result'], detail?: string): ReconcileOutcome => ({
      intentId: intent.intentId,
      proposalId: intent.proposalId,
      direction: intent.direction,
      targets,
      result,
      ...(detail === undefined ? {} : { detail }),
    })

    // The recoverable bytes, re-verified against the digest the intent recorded.
    const bytes: (Buffer | undefined)[] = []
    for (const file of intent.files) {
      if (file.source === undefined) {
        bytes.push(undefined)
        continue
      }
      try {
        bytes.push(await this.readSource(file.source, file.contentSha256))
      } catch (error) {
        return outcome(
          'blocked',
          `the recoverable source "${file.source}" of commit intent "${intent.intentId}" for the file "${file.target}" is no longer ` +
            `readable as the bytes it committed (${message(error)}) — the source bytes cannot be re-verified under ${this.root}, so the ` +
            'commit stops by name and the intent stays open; nothing was written',
        )
      }
    }
    if (intent.capability !== undefined) {
      return outcome(
        'blocked',
        `the commit intent "${intent.intentId}" moves the capability row "${intent.capability.name}", and a capability row is materialized ` +
          `by the environment revision a publish installs${this.capabilityConfigPath === undefined ? '' : ` (the table file "${this.capabilityConfigPath}")`} — ` +
          'the v4 row swap was retired with the publish pointer transaction, so the row is not installed here and the intent stays open',
      )
    }

    // The state each target holds right now, against the two the intent recorded.
    const states: ('baseline' | 'content' | 'other')[] = []
    const seen: string[] = []
    for (const file of intent.files) {
      let current: { sha256: string } | null
      try {
        current = await this.readProduction(file.target)
      } catch (error) {
        return outcome(
          'blocked',
          `the production file "${file.target}" of commit intent "${intent.intentId}" cannot be read as a regular file (${message(error)}) — ` +
            'the commit stops by name and the intent stays open; nothing was written',
        )
      }
      const digest = current?.sha256 ?? null
      seen.push(current?.sha256 ?? 'absent')
      states.push(digest === file.baselineSha256 ? 'baseline' : digest === file.contentSha256 ? 'content' : 'other')
    }
    const foreign = states.findIndex(state => state === 'other')
    if (foreign >= 0) {
      const file = intent.files[foreign]!
      const absent = seen[foreign] === 'absent'
      return outcome(
        'blocked',
        `the production file "${file.target}" of commit intent "${intent.intentId}" ${absent ? 'is missing' : `holds sha256 ${seen[foreign]}`} — ` +
          `it holds neither the state before the commit (${file.baselineSha256 === null ? 'absent' : `sha256 ${file.baselineSha256}`}) nor the ` +
          `state it committed (${file.contentSha256 === null ? 'absent' : `sha256 ${file.contentSha256}`}); a third party ${absent ? 'removed' : 'changed'} ` +
          `it, so the commit stops by name and the intent stays open; nothing is ${absent ? 'recreated' : 'overwritten'}`,
      )
    }

    if (states.every(state => state === 'content')) {
      await this.appendCompletion(intent)
      return outcome('completed-written')
    }
    for (const [index, file] of intent.files.entries()) {
      if (states[index] === 'content') continue
      await this.install(file, bytes[index])
    }
    await this.verify(intent)
    await this.appendCompletion(intent)
    return outcome('completed-redone')
  }

  /** Read the recoverable bytes a legacy intent names, verified against the digest it recorded. */
  private async readSource(source: string, sha256: string | null): Promise<Buffer> {
    const bytes = await readFile(within(this.root, source))
    const digest = sha256Hex(bytes)
    if (digest !== sha256) {
      throw new Error(`the recorded source no longer holds the committed bytes (sha256 ${digest} != ${sha256})`)
    }
    return bytes
  }

  /** Read one production file, refusing a symlink or a non-file; `null` when nothing is there. */
  private async readProduction(target: string): Promise<{ sha256: string } | null> {
    const relative = this.productionRelative(target)
    const abs = within(this.skillRoot, relative)
    let stat
    try {
      stat = await lstat(abs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!stat.isFile()) throw new Error(`"${abs}" is not a regular file`)
    return { sha256: sha256Hex(await readFile(abs)) }
  }

  /** The production-relative path of one absolute target inside the skill root. */
  private productionRelative(target: string): string {
    if (!isAbsolute(target)) throw new Error(`the production target "${target}" is not an absolute path`)
    const rel = relative(this.skillRoot, target)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`"${target}" is outside the production skill root ${this.skillRoot}`)
    }
    return rel
  }

  /** Install one direction of one file: the recorded bytes, or the removal of the target. */
  private async install(file: CommitFile, bytes: Buffer | undefined): Promise<void> {
    if (file.contentSha256 === null) {
      await rm(file.target, { force: true })
      return
    }
    if (bytes === undefined) throw new Error(`evolution: commit intent names no source for "${file.target}"`)
    await writeFileAtomic(file.target, bytes)
  }

  /** The read-back a settle runs after its last write: every target must hold the bytes the intent committed. */
  private async verify(intent: CommitIntentView): Promise<void> {
    for (const file of intent.files) {
      const current = await this.readProduction(file.target)
      const digest = current?.sha256 ?? null
      if (digest !== file.contentSha256) {
        throw new Error(
          `evolution: the production file "${file.target}" does not carry the committed content after the ${intent.direction} of ` +
            `proposal "${intent.proposalId}" (${digest === null ? 'absent' : `sha256 ${digest}`} != ${file.contentSha256 ?? 'absent'}) — the ` +
            'commit intent stays open and no completion is recorded',
        )
      }
    }
  }

  /** Append one completion line, durable before it is adopted. */
  private async appendCompletion(intent: CommitIntentView): Promise<void> {
    const record = {
      formatVersion: 4,
      kind: intent.direction === 'apply' ? 'applied' : 'rolledback',
      proposalId: intent.proposalId,
      targets: intent.files.map(file => file.target),
      approvalRef: intent.approvalRef,
      intentId: intent.intentId,
      actor: intent.actor,
      at: new Date().toISOString(),
    }
    const run = this.writes.then(async () => {
      await appendLine(this.file, this.root, `${JSON.stringify(record)}\n`)
      this.records = [...this.records, record]
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }
}

/** Replace `target` with exactly `bytes`, atomically: the staging file is swept and the rename made durable. */
async function writeFileAtomic(target: string, bytes: Buffer): Promise<void> {
  const directory = dirname(target)
  const staging = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  await mkdir(directory, { recursive: true })
  let handle: FileHandle | undefined
  try {
    handle = await open(staging, 'w')
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  await rename(staging, target)
  await syncDirectory(directory)
}

/** Append one whole line to the ledger and make it durable before anything may depend on it. */
async function appendLine(file: string, root: string, line: string): Promise<void> {
  await mkdir(root, { recursive: true })
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'a')
    const length = (await handle.stat()).size
    try {
      await handle.writeFile(line, 'utf8')
    } catch (error) {
      await handle.truncate(length).catch(() => {})
      throw new Error(`evolution: the completion line could not be written to ${file} (${message(error)})`)
    }
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
  await syncDirectory(root)
}

/** fsync one directory, refusing to pretend an unsynced rename is durable. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } finally {
    await handle?.close().catch(() => {})
  }
}

export default EvolutionService
