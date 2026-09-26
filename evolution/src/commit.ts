/**
 * The one commit path behind `apply` and `rollback` (K2): the durable intent
 * comes first, production is replaced atomically, and only then is the
 * completion recorded.
 *
 * The order is the whole point. A commit that wrote production and then failed
 * to record it left a ledger that could not be reconciled against production,
 * and a retry that wrote first could not tell "production already carries the
 * new bytes" from "production carries someone else's". So an
 * `apply`/`rollback` now persists a {@link CommitRequest} into the ledger as a
 * `commit_intent` line — proposal, direction, human approval, absolute target,
 * the digest production must hold *before* the write, the digest it must hold
 * *after*, and a recoverable byte source relative to the ledger root — before a
 * byte of production changes. The write itself is one same-directory temp file
 * (`open`/write/`fsync`/close, then a rename over the target, then a directory
 * `fsync`, all best-effort beyond the rename), so a production `SKILL.md` is
 * never truncated and never half-written: it is one complete version or the
 * other. Only after the rename has been read back and verified does the
 * completion (`applied`/`rolledback`) land, and that line closes the intent at
 * the fold.
 *
 * A process that dies between any two of those writes leaves exactly one open
 * intent, and {@link reconcileIntent} is what a startup or resume does with it:
 * the recoverable source is re-read and re-verified, production is read again,
 * and then — production still carries the `baselineSha256` state, so the
 * operation never happened — the same write is redone and the completion
 * appended; or production already carries `contentSha256`, so only the
 * completion is appended and production is not touched again. Anything else
 * (a source that is gone or changed, a target a third party rewrote or removed)
 * stops by name with the intent left open, because overwriting a change this
 * commit did not make is exactly what a recovery must never do.
 *
 * This module owns no policy: which candidate bytes a commit may write, what a
 * promotion gate checks, and how a completion folds are the evolution service's
 * (`evolution.ts`), which is also the only caller. It imports only *types* from
 * there, so the dependency stays one-way at runtime.
 * @module dsh-singularity-evolution-commit
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CommitDirection, CommitIntentView, EvolutionRecord } from './evolution.ts'

/** Lowercase SHA-256 hex over exact bytes — the content identity primitive the commit path reuses (P2/P3). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The durable stages of one commit. A deployment only ever observes them through
 * {@link CommitHost.probe}, the typed test seam that simulates a process exiting
 * at that point.
 */
export type CommitStage = 'intent-recorded' | 'write-staged' | 'write-renamed'

/** One commit's request: what the intent line will say, and what the write will do. */
export interface CommitRequest {
  readonly proposalId: string
  readonly direction: CommitDirection
  /** The human grant behind this commit, recorded on the intent and on the completion that closes it. */
  readonly approvalRef: string
  /** Absolute production path this commit replaces. */
  readonly target: string
  /** The digest production must hold before the write — the state a reconciliation redoes the write from. */
  readonly baselineSha256: string
  /** The digest production must hold after the write; always the digest of the bytes being committed. */
  readonly contentSha256: string
  /** The recoverable bytes, relative to the ledger root. */
  readonly source: string
  /** The actor the completion record is written for. */
  readonly actor: string
}

/**
 * What the commit path needs from the evolution service, and no more: the roots
 * a target and a source resolve against, the service's own verified reads (P2
 * for a candidate, the champion snapshot read, the walk-verified production
 * read), the append funnel every ledger line goes through, and the probe seam.
 * Passing these in — rather than reaching for the service — is what keeps this
 * module free of a runtime dependency on the service that owns the lifecycle.
 */
export interface CommitHost {
  /** Absolute ledger root: `source` resolves against it and is confined to it. */
  readonly root: string
  /** Production skill root: a commit's target must sit under it. */
  readonly skillRoot: string
  /** Append one record through the service's funnel (format check, staged fold, serialized write). */
  append(record: EvolutionRecord): Promise<void>
  /**
   * Read the recoverable bytes a commit names and verify them against the digest
   * the intent recorded. Implemented on the service's verified reads, so a
   * source that disappeared, changed type, moved behind a symbolic link or no
   * longer holds those exact bytes throws instead of being written.
   */
  readSource(source: string, sha256: string): Promise<Buffer>
  /** The service's walk-verified production read: `null` when nothing is there, a throw for a symlink or a non-file. */
  readProduction(relative: string): Promise<{ bytes: Buffer; sha256: string } | null>
  /** The typed test seam ({@link Config.commitProbe}); a production deployment never sets one. */
  probe(stage: CommitStage): void
}

/** What one reconciliation of an open intent settled to. */
export interface ReconcileOutcome {
  intentId: string
  proposalId: string
  direction: CommitDirection
  /** The absolute production target the intent committed. */
  target: string
  /**
   * `completed-redone`: production still held the pre-commit state, so the same
   * write was redone and the completion recorded. `completed-written`:
   * production already held the committed content, so only the completion was
   * recorded. `blocked`: neither state was found (or the source is gone) — the
   * intent stays open and nothing was written.
   */
  result: 'completed-redone' | 'completed-written' | 'blocked'
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  detail?: string
}

/**
 * Replace `target` with exactly `bytes`, atomically: a sibling temp file in the
 * same directory is opened exclusively, written, fsynced and closed, then
 * renamed over the target (one filesystem operation, so a reader sees the old
 * complete file or the new one), then the directory is fsynced best-effort so
 * the rename itself survives a power cut. The target file is never opened for
 * writing, never truncated and never partially visible.
 *
 * `onStaged` fires between the fsync and the rename — the point where the new
 * bytes are durable beside the target but have not replaced it. Every failure,
 * that hook included, removes the temp file and throws: a failed write leaves no
 * half-installed version behind, and the caller's intent stays open.
 */
export async function writeFileAtomic(target: string, bytes: Buffer, onStaged?: () => void): Promise<void> {
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
    onStaged?.()
    await rename(staging, target)
    await syncDirectory(directory)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(staging, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Persist one commit and carry it out: the intent line, then the atomic
 * production write with its read-back verification, then the completion that
 * closes the intent. `bytes` are the already-verified bytes the caller read
 * through its own identity check (P2 for a candidate, the champion digest for a
 * rollback); their digest must be the request's `contentSha256`, so what the
 * intent promises and what the write installs cannot disagree.
 *
 * A throw from any stage leaves the intent open and is the caller's to report:
 * the intent is the record of what was underway, and reconciliation — not a
 * second guess — is what settles it.
 */
export async function commitIntent(host: CommitHost, request: CommitRequest, bytes: Buffer): Promise<void> {
  const digest = sha256Hex(bytes)
  if (digest !== request.contentSha256) {
    throw new Error(
      `evolution: the bytes this ${request.direction} would write hash to sha256 ${digest}, not the content identity ` +
      `${request.contentSha256} its commit records — nothing was written`,
    )
  }
  const intent: CommitIntentView = {
    intentId: `${request.proposalId}/${request.direction}`,
    proposalId: request.proposalId,
    direction: request.direction,
    approvalRef: request.approvalRef,
    target: request.target,
    baselineSha256: request.baselineSha256,
    contentSha256: request.contentSha256,
    source: request.source,
    actor: request.actor,
    at: new Date().toISOString(),
  }
  await host.append({ formatVersion: 3, kind: 'commit_intent', ...intent })
  host.probe('intent-recorded')
  await installAndVerify(host, intent, bytes)
  await appendCompletion(host, intent)
}

/**
 * Settle one open intent against the filesystem, or stop by name: re-read the
 * intent's own recoverable source and verify it still hashes to what the intent
 * committed; read production again; then
 *
 * - production still holds `baselineSha256` — the commit never landed — so the
 *   same bytes are written atomically and the completion recorded
 *   (`completed-redone`);
 * - production already holds `contentSha256` — the write landed but its
 *   completion did not — so only the completion is recorded, and production is
 *   left exactly as it is (`completed-written`);
 * - a missing target, a target holding neither digest, or a source that is gone
 *   or changed — a `blocked` outcome naming the intent, the target and what was
 *   actually found, with nothing written and the intent left open.
 *
 * It never throws for a blocked commit: one batch of reconciliations reports
 * every intent it could not settle. A real I/O failure of the redo write is
 * *not* a blocked commit and is propagated: the caller must not read a failed
 * write as "settled".
 */
export async function reconcileIntent(host: CommitHost, intent: CommitIntentView): Promise<ReconcileOutcome> {
  const outcome = (
    result: ReconcileOutcome['result'],
    detail?: string,
  ): ReconcileOutcome => ({
    intentId: intent.intentId,
    proposalId: intent.proposalId,
    direction: intent.direction,
    target: intent.target,
    result,
    ...(detail === undefined ? {} : { detail }),
  })

  let bytes: Buffer
  try {
    bytes = await host.readSource(intent.source, intent.contentSha256)
  } catch (error) {
    return outcome(
      'blocked',
      `evolution: the recoverable source "${intent.source}" of commit intent "${intent.intentId}" is no longer readable as ` +
      `the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot be re-verified under ` +
      `${host.root}, so the commit stops by name and the intent stays open; nothing was written`,
    )
  }

  let current: { bytes: Buffer; sha256: string } | null
  let relativeTarget: string
  try {
    relativeTarget = productionRelative(host, intent.target)
    current = await host.readProduction(relativeTarget)
  } catch (error) {
    return outcome(
      'blocked',
      `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" cannot be read as a regular file ` +
      `(${(error as Error).message.replace(/^(evolution|verified-read): /, '')}) — the commit stops by name and the intent stays open; ` +
      'nothing was written',
    )
  }

  if (current === null) {
    return outcome(
      'blocked',
      `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" is missing — it holds neither the ` +
      `state before the commit (sha256 ${intent.baselineSha256}) nor the content it committed (sha256 ${intent.contentSha256}); a third ` +
      'party removed it, so the commit stops by name and the intent stays open (nothing is written, nothing is recreated)',
    )
  }
  if (current.sha256 === intent.baselineSha256) {
    await installAndVerify(host, intent, bytes)
    await appendCompletion(host, intent)
    return outcome('completed-redone')
  }
  if (current.sha256 === intent.contentSha256) {
    await appendCompletion(host, intent)
    return outcome('completed-written')
  }
  return outcome(
    'blocked',
    `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" holds sha256 ${current.sha256}, which is ` +
    `neither the state before the commit (sha256 ${intent.baselineSha256}) nor the content it committed ` +
    `(sha256 ${intent.contentSha256}) — a third party changed it, so the commit stops by name and the intent stays open; the target is ` +
    'never overwritten and the completion is never recorded',
  )
}

/**
 * The write half of one commit, shared by a fresh commit and a redo: atomic
 * replace, read back, verify the target now carries exactly the committed
 * content, and only then report the rename stage. The read-back is not a
 * formality — it is what makes "the rename happened" and "production carries
 * this content" the same fact, so a completion is never recorded over bytes the
 * commit did not install.
 */
async function installAndVerify(host: CommitHost, intent: CommitIntentView, bytes: Buffer): Promise<void> {
  await writeFileAtomic(intent.target, bytes, () => host.probe('write-staged'))
  const readback = await host.readProduction(productionRelative(host, intent.target))
  if (readback === null || readback.sha256 !== intent.contentSha256) {
    throw new Error(
      `evolution: the production target "${intent.target}" does not hold the committed content after the atomic replace ` +
      `(sha256 ${readback?.sha256 ?? 'missing'} != ${intent.contentSha256}) — the intent stays open and a reconciliation reports what ` +
      'production actually carries by name',
    )
  }
  host.probe('write-renamed')
}

/**
 * Close one intent: the completion line, written for the intent's own grant and
 * target — its `approvalRef`, its `target` and its actor, so a completion can
 * never describe a second approval or a second path. The fold refuses a
 * completion with no matching open intent, which is what makes a repeat (a
 * retry, a restart, a double reconciliation) cost nothing: the second line has
 * nothing to close.
 */
async function appendCompletion(host: CommitHost, intent: CommitIntentView): Promise<void> {
  await host.append({
    formatVersion: 3,
    kind: intent.direction === 'apply' ? 'applied' : 'rolledback',
    proposalId: intent.proposalId,
    targets: [intent.target],
    approvalRef: intent.approvalRef,
    intentId: intent.intentId,
    actor: intent.actor,
    at: new Date().toISOString(),
  })
}

/**
 * A commit target relative to the production skill root: the shape the
 * walk-verified production read takes, and the check that a target can only
 * ever resolve inside the root it claims — a target that escapes it (or *is*
 * the root) is refused before any read or write.
 */
function productionRelative(host: CommitHost, target: string): string {
  const rel = relative(host.skillRoot, resolve(target))
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `evolution: the commit target "${target}" is not inside the production skill root ${host.skillRoot} — a commit writes one ` +
      `SKILL.md under that root and nothing else`,
    )
  }
  return rel
}

/** fsync a directory so a rename inside it is durable — best effort: a filesystem that refuses the open still has the rename. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    return
  } finally {
    await handle?.close().catch(() => {})
  }
}
