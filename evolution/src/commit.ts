/**
 * The one commit path behind `apply` and `rollback` (K2, extended to the whole
 * skill object in K3): the durable intent comes first, production is replaced
 * atomically, its new state is verified as a loadable object, and only then is
 * the completion recorded.
 *
 * The order is the whole point. A commit that wrote production and then failed
 * to record it left a ledger that could not be reconciled against production,
 * and a retry that wrote first could not tell "production already carries the
 * new bytes" from "production carries someone else's". So an
 * `apply`/`rollback` now persists a {@link CommitRequest} into the ledger as a
 * `commit_intent` line — proposal, direction, human approval, the **fixed file
 * set** of the skill object being replaced (K3: `SKILL.md` always, the
 * `SKILL.contract.json` beside it when the object carries an execution sidecar),
 * and for every one of those files the absolute target, the digest production
 * must hold *before* the write, the digest it must hold *after*, and a
 * recoverable byte source relative to the ledger root — before a byte of
 * production changes. Nothing about that line may be a promise: every source it
 * names is re-read and re-verified at commit time, confined to the ledger root,
 * and made durable — the file, then every directory on its chain up to the
 * ledger root, because a durable intent whose source *path* no longer resolves
 * is a recovery that can only stop — *before* the intent is appended, so a
 * source that is gone, changed or outside the root stops the commit by name with
 * nothing recorded and nothing written.
 *
 * The write is one same-directory temp file per target (`open`/write/`fsync`/
 * close, then a rename over the target, then a directory `fsync`), in the
 * order the intent lists the files — `SKILL.md` first, the sidecar second — so
 * no production file is ever truncated or half-written: each is one complete
 * version or the other, and the pair passes through at most one mixed state
 * (the `SKILL.md` already replaced, the sidecar not yet). That mixed state is
 * never admissible — a loader that reads it sees a `SKILL.md` no declaration on
 * disk covers — but it *is* recoverable, and the ledger explains it: the intent
 * is open, so admission refuses the directory until {@link reconcileIntent}
 * finishes the second file. The staging files a dead attempt of one target left
 * behind are swept before that target stages (commits are serialized per process
 * and the deployment is single-writer, so a sibling with one target's own
 * staging prefix is a leftover, never a concurrent writer), and the same sweep
 * runs when a reconciliation settles such a write by recording only its
 * completion, so a settlement never leaves a staging file of its own target
 * behind. The directory fsync after each rename is *not* best-effort: a rename
 * whose directory entry is not durable is not a settled commit, so a failure
 * there throws by name with the intent left open and no completion recorded.
 * Only after every rename has been read back and verified — and after
 * {@link CommitHost.verifyCommitted} has re-read production as a *whole object*
 * (loadable, and carrying the identity this direction promised) — does the
 * completion (`applied`/`rolledback`) land, and that line closes the intent at
 * the fold.
 *
 * A process that dies between any two of those writes leaves exactly one open
 * intent, and {@link reconcileIntent} is what a startup or resume does with it:
 * every recoverable source is re-read and re-verified, every production file is
 * read again and classified as the pre-commit state, the committed state, absent
 * or something else, and then — every file still holds its baseline, so the
 * operation never happened — the same writes are redone in order and the
 * completion appended; or every file already holds the committed content, so the
 * targets' staging leftovers are swept, their directories are fsynced, and only
 * the completion is appended, with production's bytes left untouched (a
 * completion claims a *durable* rename, so the recovery that records one
 * re-establishes that durability first, and stops by name if it cannot); or the
 * files are mixed (a crash between the two renames), so the files still holding
 * their baseline are written and the ones already carrying the content have
 * their durability re-established, and the completion lands only after the whole
 * object verifies. Anything else — a source that is gone or changed, a file a
 * third party rewrote or removed — stops by name with the intent left open,
 * because overwriting a change this commit did not make is exactly what a
 * recovery must never do.
 *
 * This module owns no policy: which candidate bytes a commit may write, what a
 * promotion gate checks, how a completion folds, and what "the object is
 * loadable and carries this identity" means are the evolution service's
 * (`evolution.ts`), which is also the only caller. It imports only *types* from
 * there, so the dependency stays one-way at runtime.
 * @module dsh-singularity-evolution-commit
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CommitDirection, CommitIntentView, EvolutionRecord } from './evolution.ts'

/** Lowercase SHA-256 hex over exact bytes — the content identity primitive the commit path reuses (P2/P3). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The durable stages of one commit. A deployment only ever observes them through
 * {@link CommitHost.probe}, the typed test seam: what it does at a stage is the
 * caller's business, and a test that answers with an ordinary throw interrupts
 * the commit there without being a process exit (a throw is caught, its `catch`
 * and `finally` run, and the process lives on). A *real* exit at one of these
 * stages is a killed process, which no throw can stand in for — see the real-exit
 * cases in `tests/integration/k2-evolution-commit.spec.ts`.
 *
 * The `write-*` stages fire once per file and carry that file's target, so a
 * caller can open a window between the two files of one object as precisely as
 * inside one file's write. `commit-verified` is the last window: every file is
 * written and read back, and the whole object passed
 * {@link CommitHost.verifyCommitted} — the completion line is the only step left.
 */
export type CommitStage = 'intent-recorded' | 'write-staged' | 'write-renamed' | 'commit-verified'

/**
 * One file of one commit: where it goes, what production must hold before the
 * write, what it must hold after, and the bytes to write again if this process
 * dies mid-commit. A K3 commit carries the fixed file set of one skill object —
 * `SKILL.md` always, `SKILL.contract.json` second when the object has an
 * execution sidecar — and the files are ordered: the `SKILL.md` first, so a
 * recovery that has to write the pair again writes the pair in the order a
 * loader would read it.
 */
export interface CommitFile {
  /** Absolute production path this commit replaces. */
  readonly target: string
  /** The digest this file must hold before the write — the state a reconciliation redoes the write from. */
  readonly baselineSha256: string
  /** The digest this file must hold after the write; always the digest of the bytes being committed. */
  readonly contentSha256: string
  /** The recoverable bytes for this file, relative to the ledger root. */
  readonly source: string
}

/** One commit's request: what the intent line will say, and what the writes will do. */
export interface CommitRequest {
  readonly proposalId: string
  readonly direction: CommitDirection
  /** The human grant behind this commit, recorded on the intent and on the completion that closes it. */
  readonly approvalRef: string
  /** The object's fixed files, in commit order (`SKILL.md` first, the sidecar second when there is one); one or two entries. */
  readonly files: readonly CommitFile[]
  /** The actor the completion record is written for. */
  readonly actor: string
}

/**
 * What the commit path needs from the evolution service, and no more: the roots
 * a target and a source resolve against, the service's own verified reads (P2
 * for a candidate, the champion snapshot read, the walk-verified production
 * read), the append funnel every ledger line goes through, the whole-object
 * verification that closes the window before the completion, and the probe seam.
 * Passing these in — rather than reaching for the service — is what keeps this
 * module free of a runtime dependency on the service that owns the lifecycle.
 */
export interface CommitHost {
  /** Absolute ledger root: `source` resolves against it and is confined to it. */
  readonly root: string
  /** Production skill root: a commit's target must sit under it. */
  readonly skillRoot: string
  /**
   * Append one record through the service's funnel (format check, staged fold,
   * serialized write). It returns only once the line and the directories holding
   * it are fsynced, so an intent this method accepted is durable.
   */
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
  /**
   * Called after every file has been written and read back, and before the
   * completion is recorded — in a fresh commit and in both reconciliation
   * branches alike. The production directory must be loadable as one complete
   * object and must carry the identity this direction promised; a throw refuses
   * the commit by name and the intent stays open. This is what makes the
   * completion claim more than "two files hold two digests": it claims the pair
   * *is* an object a loader accepts, with exactly the declaration identity the
   * proposal recorded for it, so the registry's view of the skill is already the
   * new one when the completion lands. It never writes.
   */
  verifyCommitted(intent: CommitIntentView): Promise<void>
  /** The typed test seam ({@link Config.commitProbe}); a production deployment never sets one. */
  probe(stage: CommitStage, target?: string): void
}

/** What one reconciliation of an open intent settled to. */
export interface ReconcileOutcome {
  intentId: string
  proposalId: string
  direction: CommitDirection
  /** The absolute production targets the intent committed, in intent order — the whole fixed file set. */
  targets: readonly string[]
  /**
   * `completed-redone`: production still held the pre-commit state, so the same
   * writes were redone and the completion recorded. `completed-written`:
   * production already held the committed content in every file, so only the
   * completion was recorded. `blocked`: a file holds neither state (or a source
   * is gone) — the intent stays open and nothing was written.
   */
  result: 'completed-redone' | 'completed-written' | 'blocked'
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  detail?: string
}

/**
 * Replace `target` with exactly `bytes`, atomically: the staging files a dead
 * attempt of this target left beside it are swept, then a sibling temp file in
 * the same directory is opened exclusively, written, fsynced and closed, then
 * renamed over the target (one filesystem operation, so a reader sees the old
 * complete file or the new one), then the directory is fsynced so the rename
 * itself survives a power cut. The target file is never opened for writing,
 * never truncated and never partially visible.
 *
 * The sweep is what keeps a real process death from accumulating garbage: a
 * killed attempt leaves its staging file behind (`catch` never runs for a real
 * exit), and a later redo would otherwise stage a second temp and rename that
 * one, leaving the first forever. It removes only entries whose name begins with
 * this target's own staging prefix, in the target's own directory, and only
 * non-directories — never a directory that merely shares the prefix, and never
 * anything of another target. A failure to sweep throws by name rather than
 * being swallowed: the commit must not stage its own bytes beside a leftover it
 * could not account for.
 *
 * `onStaged` fires between the fsync and the rename — the point where the new
 * bytes are durable beside the target but have not replaced it. A failure before
 * the rename — that hook included — removes the temp file and throws: a failed
 * write leaves no half-installed version behind, and the caller's intent stays
 * open. A failure of the directory fsync *after* the rename is the one failure
 * that leaves the target replaced with the durability of the rename unknown: it
 * throws by name, the intent stays open and no completion is recorded, because a
 * rename whose directory entry is not durable is not a settled commit.
 */
export async function writeFileAtomic(target: string, bytes: Buffer, onStaged?: () => void): Promise<void> {
  const directory = dirname(target)
  const staging = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let handle: FileHandle | undefined
  try {
    await mkdir(directory, { recursive: true })
    await sweepStaging(directory, target)
    handle = await open(staging, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    onStaged?.()
    await rename(staging, target)
    try {
      await syncDirectory(directory)
    } catch (error) {
      throw new Error(
        `evolution: the directory "${directory}" of the production target "${target}" could not be fsynced after the atomic ` +
        `rename (${error instanceof Error ? error.message : String(error)}) — the rename may or may not be durable, so this is not ` +
        'a settled commit: the commit intent stays open, no completion is recorded, and the state must not be treated as settled; ' +
        'production holds one of the two complete versions and a reconciliation settles the intent by name',
      )
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(staging, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Remove every entry beside `target` whose name begins with this target's own
 * staging prefix (`.<target basename>.tmp-`) — the staging files of *this*
 * target that a process which died before its rename left behind. Commits are
 * serialized per process (`commitExclusive`) and the deployment is single-writer
 * (the documented constraint), so such a sibling cannot be a concurrent writer's
 * file; the sweep is confined to the target's own directory and the target's own
 * prefix, and a directory is left alone even when it shares the prefix, so
 * nothing else in that directory is ever touched. A failure to read the
 * directory or to remove a leftover is a named stop: a leftover this commit
 * cannot account for is not one it stages beside.
 */
async function sweepStaging(directory: string, target: string): Promise<void> {
  const prefix = `.${basename(target)}.tmp-`
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(
      `evolution: the production directory "${directory}" could not be read to sweep the staging files of "${target}" ` +
      `(${error instanceof Error ? error.message : String(error)}) — a leftover of a killed attempt cannot be accounted for, so the ` +
      'commit stops by name before it stages anything',
    )
  })
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || entry.isDirectory()) continue
    const leftover = join(directory, entry.name)
    try {
      await rm(leftover, { force: true })
    } catch (error) {
      throw new Error(
        `evolution: the stale staging file "${leftover}" beside the production target "${target}" could not be removed ` +
        `(${error instanceof Error ? error.message : String(error)}) — the commit stops by name before it stages anything rather than ` +
        'stage its own bytes beside a leftover it cannot account for',
      )
    }
  }
}

/**
 * Persist one commit and carry it out, in the order the recovery rule fixes:
 * every recoverable source is verified and made durable, then the intent line is
 * appended, then the atomic production writes with their read-back verification,
 * then the whole-object verification, then the completion that closes the
 * intent. `bytes` are the already-verified bytes the caller read through its own
 * identity checks (P2 for a candidate, the champion digests for a rollback), one
 * entry per file of the request and in the same order; each digest must be that
 * file's `contentSha256`, so what the intent promises and what the writes
 * install cannot disagree — for either file of a two-file object.
 *
 * The sources come first because the intent *names* them as the bytes a recovery
 * would write again — a line naming a source that no longer holds those bytes is
 * a recovery that can never complete. So before anything is recorded every
 * source is confined to the ledger root, re-read through
 * {@link CommitHost.readSource} (which re-digests and refuses a source that is
 * gone, changed type or changed content), and fsynced together with the
 * directories that hold it. Any failure there is a named stop with no line
 * recorded and nothing written. Only then is the intent appended — through the
 * service's own durable append, so the line is on disk before production moves —
 * and only after every rename has been read back and verified, and the whole
 * object has passed {@link CommitHost.verifyCommitted}, is the completion
 * appended.
 *
 * A throw from any stage leaves the intent open and is the caller's to report:
 * the intent is the record of what was underway, and reconciliation — not a
 * second guess — is what settles it.
 */
export async function commitIntent(host: CommitHost, request: CommitRequest, bytes: readonly Buffer[]): Promise<void> {
  if (request.files.length === 0) {
    throw new Error(
      `evolution: the ${request.direction} for proposal "${request.proposalId}" names no file to commit — a commit replaces the ` +
      'fixed file set of one skill object (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar), so a ' +
      'request with nothing in it records nothing and writes nothing',
    )
  }
  if (bytes.length !== request.files.length) {
    throw new Error(
      `evolution: the ${request.direction} for proposal "${request.proposalId}" carries ${bytes.length} file(s) of verified bytes for ` +
      `${request.files.length} target file(s) — the bytes and the intent's files are the same list in the same order, so a mismatch ` +
      'stops by name with nothing written',
    )
  }
  request.files.forEach((file, index) => {
    const digest = sha256Hex(bytes[index]!)
    if (digest !== file.contentSha256) {
      throw new Error(
        `evolution: the bytes this ${request.direction} would write to "${file.target}" hash to sha256 ${digest}, not the content ` +
        `identity ${file.contentSha256} its commit records — nothing was written`,
      )
    }
  })
  // Before a byte is written or a line is recorded: every target must resolve
  // inside the production skill root. `apply`/`rollback` confine the targets when
  // they build the request, but this function is exported — so the check lives
  // where the write happens, not only where the request is built.
  const targets = request.files.map(file => productionRelative(host, file.target))
  const sources = request.files.map(file => ledgerRelative(host, request, file))
  for (const file of request.files) {
    try {
      await host.readSource(file.source, file.contentSha256)
    } catch (error) {
      throw new Error(
        `evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" does not ` +
        `hold the bytes its commit recorded (${error instanceof Error ? error.message : String(error)}) — the source an intent names must be ` +
        're-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and nothing is written',
      )
    }
  }
  for (const [index, file] of request.files.entries()) {
    await syncSource(host, request, file, sources[index]!)
  }
  const intent: CommitIntentView = {
    intentId: `${request.proposalId}/${request.direction}`,
    proposalId: request.proposalId,
    direction: request.direction,
    approvalRef: request.approvalRef,
    files: request.files.map(file => ({ ...file })),
    actor: request.actor,
    at: new Date().toISOString(),
  }
  await host.append({ formatVersion: 4, kind: 'commit_intent', ...intent })
  host.probe('intent-recorded')
  await installAndVerify(host, intent, bytes, targets)
  await host.verifyCommitted(intent)
  host.probe('commit-verified')
  await appendCompletion(host, intent)
}

/**
 * Settle one open intent against the filesystem, or stop by name: re-read every
 * one of the intent's own recoverable sources and verify it still hashes to what
 * the intent committed; read every production file again and classify it as the
 * pre-commit state (`old`), the committed content (`new`), absent or something
 * else; then
 *
 * - every file still holds its `baselineSha256` — the commit never landed — so
 *   the same bytes are written atomically, in intent order, and the completion
 *   recorded (`completed-redone`);
 * - the files are mixed (a process that died between the two renames): the files
 *   still holding their baseline are written, and the files already carrying the
 *   committed content have their own staging leftovers swept and their
 *   directories fsynced, so the earlier rename's durability is re-established
 *   too; the completion is recorded only once the whole object verifies
 *   (`completed-redone`);
 * - every file already holds `contentSha256` — the writes landed but their
 *   completion did not — so each target's staging leftovers are swept, each
 *   production directory is fsynced, and then only the completion is recorded,
 *   with production's bytes left exactly as they are (`completed-written`);
 * - a missing file, a file holding neither digest, or a source that is gone or
 *   changed — a `blocked` outcome naming the intent, the file and what was
 *   actually found, with nothing written and the intent left open.
 *
 * The `completed-written` branch still fsyncs the production directories, even
 * though it writes no bytes: the completion is the claim that production holds
 * the committed content *durably*, and a rename is durable only once the
 * directory that holds it is fsynced. A rename whose directory fsync failed when
 * its commit ran (or a process that died before it) left production on the new
 * bytes with that durability unestablished — so recording the completion without
 * re-establishing it would be exactly the "completion recorded for a write that
 * may be lost" state the commit order exists to prevent, and nothing would ever
 * reconcile it again, because the completion closes the intent. The same branch
 * sweeps each target's own staging leftovers, so the invariant is total: settling
 * an intent leaves no staging file of that object behind, whichever branch
 * settled it. The deliberate consequence: on a filesystem whose production
 * directory cannot be fsynced, a recovery stops by name — the completion is not
 * recorded and the intent stays open — instead of recording a completion it
 * cannot stand behind.
 *
 * Every branch that records a completion calls
 * {@link CommitHost.verifyCommitted} first: a mixed pair a recovery finished
 * must load as one object carrying this direction's identity before the ledger
 * may say the commit is settled, exactly as a fresh commit must.
 *
 * It never throws for a blocked commit: one batch of reconciliations reports
 * every intent it could not settle. A real I/O failure of a redo write, of a
 * directory fsync or of a sweep is *not* a blocked commit and is propagated:
 * the caller must not read a failed write as "settled".
 */
export async function reconcileIntent(host: CommitHost, intent: CommitIntentView): Promise<ReconcileOutcome> {
  const targets = intent.files.map(file => file.target)
  const outcome = (
    result: ReconcileOutcome['result'],
    detail?: string,
  ): ReconcileOutcome => ({
    intentId: intent.intentId,
    proposalId: intent.proposalId,
    direction: intent.direction,
    targets,
    result,
    ...(detail === undefined ? {} : { detail }),
  })

  const bytes: Buffer[] = []
  for (const file of intent.files) {
    try {
      bytes.push(await host.readSource(file.source, file.contentSha256))
    } catch (error) {
      return outcome(
        'blocked',
        `evolution: the recoverable source "${file.source}" of commit intent "${intent.intentId}" for the file "${file.target}" is no ` +
        `longer readable as the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot ` +
        `be re-verified under ${host.root}, so the commit stops by name and the intent stays open; nothing was written`,
      )
    }
  }

  const relatives: string[] = []
  const states: ('old' | 'new' | 'missing' | 'other')[] = []
  const digests: string[] = []
  for (const file of intent.files) {
    let relative: string
    let current: { bytes: Buffer; sha256: string } | null
    try {
      relative = productionRelative(host, file.target)
      current = await host.readProduction(relative)
    } catch (error) {
      return outcome(
        'blocked',
        `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" cannot be read as a regular file ` +
        `(${(error as Error).message.replace(/^(evolution|verified-read): /, '')}) — the commit stops by name and the intent stays open; ` +
        'nothing was written',
      )
    }
    relatives.push(relative)
    digests.push(current?.sha256 ?? 'missing')
    states.push(current === null
      ? 'missing'
      : current.sha256 === file.baselineSha256
        ? 'old'
        : current.sha256 === file.contentSha256 ? 'new' : 'other')
  }

  const absent = intent.files.findIndex((_file, index) => states[index] === 'missing')
  if (absent >= 0) {
    const file = intent.files[absent]!
    return outcome(
      'blocked',
      `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" is missing — it holds neither the state ` +
      `before the commit (sha256 ${file.baselineSha256}) nor the content it committed (sha256 ${file.contentSha256}); a third party ` +
      'removed it, so the commit stops by name and the intent stays open (nothing is written, nothing is recreated)',
    )
  }
  const foreign = intent.files.findIndex((_file, index) => states[index] === 'other')
  if (foreign >= 0) {
    const file = intent.files[foreign]!
    return outcome(
      'blocked',
      `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" holds sha256 ${digests[foreign]}, which is ` +
      `neither the state before the commit (sha256 ${file.baselineSha256}) nor the content it committed ` +
      `(sha256 ${file.contentSha256}) — a third party changed it, so the commit stops by name and the intent stays open; nothing is ` +
      'overwritten and the completion is never recorded',
    )
  }

  if (states.every(state => state === 'new')) {
    // This branch writes no bytes, but it still leaves no trace of its own
    // targets: the staging leftovers a killed attempt left beside them are swept
    // (the same prefixes, the same directories, nothing else touched), then the
    // directories are fsynced — which is what makes the earlier renames durable
    // *and* what makes the removals durable — and only then is the completion
    // recorded. The sweep comes first on purpose: a settlement that cannot sweep
    // stops by name while the intent is still open, so a later reconciliation
    // retries it, rather than recording a completion over a leftover nothing is
    // looking at any more.
    for (const file of intent.files) {
      await sweepStaging(dirname(file.target), file.target)
    }
    for (const file of intent.files) {
      await syncTargetDirectory(host, intent, file.target)
    }
    await host.verifyCommitted(intent)
    host.probe('commit-verified')
    await appendCompletion(host, intent)
    return outcome('completed-written')
  }

  // Every file still holds its baseline, or the pair is mixed because the process
  // died between the two renames. The files still holding their baseline are
  // written in intent order; the ones already carrying the content have their
  // staging swept and their directory fsynced (their rename may not be durable
  // yet). The completion is recorded only after the whole object verifies.
  for (const [index, file] of intent.files.entries()) {
    if (states[index] === 'old') {
      await writeFileAtomic(file.target, bytes[index]!, () => host.probe('write-staged', file.target))
      const readback = await host.readProduction(relatives[index]!)
      if (readback === null || readback.sha256 !== file.contentSha256) {
        throw new Error(
          `evolution: the production file "${file.target}" does not hold the committed content after the atomic replace ` +
          `(sha256 ${readback?.sha256 ?? 'missing'} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what ` +
          'production actually carries by name',
        )
      }
      host.probe('write-renamed', file.target)
      continue
    }
    await sweepStaging(dirname(file.target), file.target)
    await syncTargetDirectory(host, intent, file.target)
  }
  await host.verifyCommitted(intent)
  host.probe('commit-verified')
  await appendCompletion(host, intent)
  return outcome('completed-redone')
}

/**
 * Make one production target's directory durable before a completion is recorded
 * over bytes this process did not just rename into place (the
 * `completed-written` reconciliation, and the file a mixed-state recovery finds
 * already carrying the content).
 *
 * The completion is the claim that production holds the committed content
 * *durably*; a rename is durable only once the directory entry that names it is
 * fsynced. Re-establishing that is the one thing missing after a commit whose
 * own directory fsync failed (or a process that died before it), so a recovery
 * that skips it would close the intent on a write that may be lost — and with
 * the intent closed, nothing would ever look at the target again. The bytes are
 * never touched here: the branch's whole point is "the content is already there,
 * only the record is missing".
 *
 * A failure is a named stop: nothing is recorded, the intent stays open, and the
 * state is not settled. On a filesystem whose production directory cannot be
 * fsynced, a recovery therefore stops by name instead of recording a completion
 * it cannot stand behind.
 */
async function syncTargetDirectory(host: CommitHost, intent: CommitIntentView, target: string): Promise<void> {
  const directory = dirname(target)
  try {
    await syncDirectory(directory)
  } catch (error) {
    throw new Error(
      `evolution: the directory "${directory}" of the production target "${target}" could not be fsynced before recording the ` +
      `completion of commit intent "${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the rename that ` +
      'put the committed content there may not be durable, so the completion is not recorded, the intent stays open and the state must ' +
      'not be treated as settled; a reconciliation that can make the directory durable records the completion then',
    )
  }
}

/**
 * The write half of one commit, shared by a fresh commit and a redo: for every
 * file in intent order, atomic replace, read back, verify the target now carries
 * exactly the committed content, and only then report the rename stage.
 * `relativeTargets` are the targets' paths under the skill root, already
 * confined by the caller (a target that escapes the root is refused before this
 * runs, so nothing is ever staged outside it). The read-back is not a formality
 * — it is what makes "the rename happened" and "production carries this content"
 * the same fact, so a completion is never recorded over bytes the commit did not
 * install.
 */
async function installAndVerify(
  host: CommitHost,
  intent: CommitIntentView,
  bytes: readonly Buffer[],
  relativeTargets: readonly string[],
): Promise<void> {
  for (const [index, file] of intent.files.entries()) {
    await writeFileAtomic(file.target, bytes[index]!, () => host.probe('write-staged', file.target))
    const readback = await host.readProduction(relativeTargets[index]!)
    if (readback === null || readback.sha256 !== file.contentSha256) {
      throw new Error(
        `evolution: the production file "${file.target}" does not hold the committed content after the atomic replace ` +
        `(sha256 ${readback?.sha256 ?? 'missing'} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what ` +
        'production actually carries by name',
      )
    }
    host.probe('write-renamed', file.target)
  }
}

/**
 * Close one intent: the completion line, written for the intent's own grant and
 * its whole file set — its `approvalRef`, every `target` the intent committed in
 * intent order, and its actor, so a completion can never describe a second
 * approval or a second path. The fold refuses a completion with no matching open
 * intent, which is what makes a repeat (a retry, a restart, a double
 * reconciliation) cost nothing: the second line has nothing to close.
 */
async function appendCompletion(host: CommitHost, intent: CommitIntentView): Promise<void> {
  await host.append({
    formatVersion: 4,
    kind: intent.direction === 'apply' ? 'applied' : 'rolledback',
    proposalId: intent.proposalId,
    targets: intent.files.map(file => file.target),
    approvalRef: intent.approvalRef,
    intentId: intent.intentId,
    actor: intent.actor,
    at: new Date().toISOString(),
  })
}

/**
 * One commit target relative to the production skill root: the shape the
 * walk-verified production read takes, and the check that a target can only
 * ever resolve inside the root it claims — a target that escapes it (or *is*
 * the root) is refused before any read or write.
 */
function productionRelative(host: CommitHost, target: string): string {
  const rel = relative(host.skillRoot, resolve(target))
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `evolution: the commit target "${target}" is not inside the production skill root ${host.skillRoot} — a commit replaces the ` +
      'fixed file set of one skill object under that root (SKILL.md, and SKILL.contract.json when the object carries an execution ' +
      'sidecar) and nothing else',
    )
  }
  return rel
}

/**
 * The check that the recoverable source an intent will name for one file
 * resolves inside the ledger root — the same confinement
 * {@link productionRelative} gives a target, applied to the bytes a recovery
 * reads back. A source that escapes the root (or *is* the root) is refused by
 * name before the intent is recorded and before anything is written: the root is
 * what a reconciliation is allowed to read a source from, and a commit's
 * durability claim covers exactly those files.
 */
function ledgerRelative(host: CommitHost, request: CommitRequest, file: CommitFile): string {
  const rel = relative(host.root, resolve(host.root, file.source))
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" is not ` +
      `inside the ledger root ${host.root} — a commit names the bytes it could write again from under that root and nothing else, so ` +
      'it stops by name before the intent is recorded and nothing is written',
    )
  }
  return rel
}

/**
 * Make one file's recoverable source durable *before* the intent that names
 * it — the bytes *and* the path: fsync the file itself, then every directory on
 * the chain from the one that holds it up to and including the ledger root. The
 * bytes alone are not enough: a directory entry that never reached the disk takes
 * the name inside it with it, so a durable `commit_intent` could name a `source`
 * that no longer resolves and the recovery could only report `blocked` — a named
 * stop, but the commit was supposed to have a recoverable source. The source
 * exists (the verified read above just walked it through real entries), so every
 * directory on that chain exists too; the walk stops at the ledger root, which
 * the source's confinement already guarantees is an ancestor, and a two-file
 * commit runs this for each of its sources, so both halves of an object are
 * durable before the line that names them.
 *
 * A failure of any step is the same named stop, naming the file or the directory
 * that failed: nothing is recorded and nothing is written — an intent that names
 * a source which may not survive is exactly the state the commit order exists to
 * prevent.
 */
async function syncSource(host: CommitHost, request: CommitRequest, file: CommitFile, sourceRelative: string): Promise<void> {
  const source = resolve(host.root, sourceRelative)
  let handle: FileHandle | undefined
  try {
    handle = await open(source, 'r')
    await handle.sync()
  } catch (error) {
    throw new Error(
      `evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" could not ` +
      `be fsynced at "${source}" (${error instanceof Error ? error.message : String(error)}) — the source must be durable, bytes and path, ` +
      'before the intent that names it is recorded, so the commit stops by name: no line is recorded and nothing is written',
    )
  } finally {
    await handle?.close().catch(() => {})
  }
  for (const directory of sourceDirectories(host.root, source)) {
    try {
      await syncDirectory(directory)
    } catch (error) {
      throw new Error(
        `evolution: the directory "${directory}" holding the recoverable source "${file.source}" of the ${request.direction} for ` +
        `proposal "${request.proposalId}" could not be fsynced (${error instanceof Error ? error.message : String(error)}) — the source ` +
        'must be durable, bytes and path, before the intent that names it is recorded, so the commit stops by name: no line is recorded ' +
        'and nothing is written',
      )
    }
  }
}

/**
 * The directories that make a source's *path* durable, inside-out: the one that
 * holds the file, then each ancestor up to and including the ledger root. The
 * walk stops at the root because the source is confined to it (see
 * {@link ledgerRelative}); the extra `dirname` guard only keeps a malformed call
 * from looping, since a confined source always reaches the root first.
 */
function sourceDirectories(root: string, source: string): readonly string[] {
  const directories: string[] = []
  for (let directory = dirname(source); ; directory = dirname(directory)) {
    directories.push(directory)
    if (directory === root || dirname(directory) === directory) break
  }
  return directories
}

/**
 * fsync one directory so an entry created or renamed inside it is durable.
 *
 * It is exported because the ledger's own durable append (`evolution.ts`) needs
 * the same primitive: one implementation, so "this directory was fsynced" means
 * the same operation on the commit path and on the ledger path. It does not
 * swallow: a filesystem that refuses the open or the sync throws, and the caller
 * decides what that means — for a production rename it means the rename is not
 * settled ({@link writeFileAtomic}), and for a ledger line it means the line is
 * not durable.
 */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}
