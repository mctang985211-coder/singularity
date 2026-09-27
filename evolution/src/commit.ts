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
 * or something else, the directory is checked to hold this object's own files
 * and nothing else, and then — every file still holds its baseline, so the
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
 * third party rewrote or removed, an entry in the directory the intent does not
 * name — stops by name with the intent left open, because overwriting a change
 * this commit did not make is exactly what a recovery must never do.
 *
 * This module owns no policy: which candidate bytes a commit may write, what a
 * promotion gate checks, how a completion folds, and what "the object is
 * loadable and carries this identity" means are the evolution service's
 * (`evolution.ts`), which is also the only caller. It imports only *types* from
 * there, so the dependency stays one-way at runtime.
 * @module dsh-singularity-evolution-commit
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { CommitCapability, CommitDirection, CommitIntentView, EvolutionRecord } from './evolution.ts'
import { capabilityRowDigest } from './capability-candidate.ts'

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
 *
 * `null` on either side is a *state*, not a missing value (A6): a file whose
 * `baselineSha256` is `null` must not exist before this commit (it is a file the
 * candidate creates), and a file whose `contentSha256` is `null` must not exist
 * after it (it is a file the rollback removes, and there is nothing to write
 * again, so it names no source). One direction may not remove a file the other
 * created and restore it in the same commit: the two states are the two ends of
 * one candidate version.
 */
export interface CommitFile {
  /** Absolute production path this commit replaces, creates or removes. */
  readonly target: string
  /** The digest this file must hold before the write — the state a reconciliation redoes the write from; `null` when it must not exist. */
  readonly baselineSha256: string | null
  /** The digest this file must hold after the write; always the digest of the bytes being committed, `null` when the commit removes it. */
  readonly contentSha256: string | null
  /** The recoverable bytes for this file, relative to the ledger root; absent when this direction removes the file. */
  readonly source?: string
}

/** One commit's request: what the intent line will say, and what the writes will do. */
export interface CommitRequest {
  readonly proposalId: string
  readonly direction: CommitDirection
  /** The human grant behind this commit, recorded on the intent and on the completion that closes it. */
  readonly approvalRef: string
  /** The object's fixed files, in commit order (`SKILL.md` first, the sidecar second when there is one); empty for a row-only capability commit. */
  readonly files: readonly CommitFile[]
  /** The one capability row this commit also moves (A6); absent for a skill commit. */
  readonly capability?: CommitCapability
  /** The actor the completion record is written for. */
  readonly actor: string
}

/**
 * The capability-registry half of a commit host (A6): required exactly when a
 * request carries a capability row, absent for a skill commit. It is a seam of
 * its own — a nested object rather than two more members — so a host that knows
 * nothing about capability rows cannot be asked to move one by accident, and the
 * commit path refuses a row it cannot read or write by name.
 */
export interface CommitCapabilityHost {
  /**
   * The row the registry holds for `name` right now, or `null` when it holds
   * none. The read both the pre-write baseline check and a classification are
   * made from, so "the registry still reads as the intent recorded" is one
   * question with one answer.
   */
  read(name: string): Promise<CapabilityConfig | null>
  /**
   * Install (`entry`) or remove (`null`) one capability row. Called inside the
   * commit, after the skill files are written (apply) or before they are removed
   * (rollback), and always before the completion is recorded: `intent` is the
   * open line that owns this write, so an entry that must run its own admission
   * pre-check can exempt this commit's own in-flight file set by name.
   */
  apply(intent: CommitIntentView, entry: CapabilityConfig | null): Promise<void>
}

/**
 * What the commit path needs from the evolution service, and no more: the roots
 * a target and a source resolve against, the service's own verified reads (P2
 * for a candidate, the champion snapshot read, the walk-verified production
 * read), the append funnel every ledger line goes through, the whole-object
 * verification that closes the window before the completion, the capability-row
 * seam, and the probe seam. Passing these in — rather than reaching for the
 * service — is what keeps this module free of a runtime dependency on the
 * service that owns the lifecycle.
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
   * The named reason this commit must not write the directory its file set lives
   * in, or `null` when that directory holds this object's own files and nothing
   * else. The files an intent names are not the whole object: a directory can
   * grow an entry nobody declared — a guidance skill that gained an
   * `SKILL.contract.json` beside it (a role change), a file at a supported
   * resource position, a stray entry an execution declaration does not cover —
   * while every file the intent names still holds exactly the digest it
   * recorded, and the per-file digest checks are blind to it by construction.
   * What this object's own files *are* is the service's to say (it owns the
   * loader and the role rules), so the check lives there and both entry points
   * — {@link commitIntent} before the intent line and before any write,
   * {@link reconcileIntent} before any branch writes — ask the same question of
   * the same implementation. A refusal never writes and is never a throw — a
   * directory that cannot even be listed is one more reason to report, so the
   * entry point that asked decides what it means (a stop before the intent line,
   * one blocked intent in a recovery) in that entry point's own words.
   */
  objectWriteRefusal(intent: CommitIntentView): Promise<string | null>
  /**
   * Called after every file has been written and read back (and, for a
   * capability commit, after the row is in place) and before the completion is
   * recorded — in a fresh commit and in every reconciliation branch alike. The
   * production directory must be loadable as one complete object and must carry
   * the identity this direction promised, a file this direction removes must be
   * gone, and the registry must read as the row this direction installed; a
   * throw refuses the commit by name and the intent stays open. This is what
   * makes the completion claim more than "two files hold two digests": it claims
   * the pair *is* an object a loader accepts, with exactly the declaration
   * identity the proposal recorded for it, and that the capability registry
   * already reads the row this commit installed — so by the time the completion
   * lands, the deployment's own registry view is the new one. It never writes.
   */
  verifyCommitted(intent: CommitIntentView): Promise<void>
  /** The capability-registry seam; present exactly on a host that can move a row (A6). */
  readonly capability?: CommitCapabilityHost
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
   * is gone), or the directory holds an entry the intent does not name — the
   * intent stays open and nothing was written.
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
 * every recoverable source is verified and made durable, the directory the
 * commit would write is checked to be the object's own files and nothing else,
 * then the intent line is appended, then the production writes with their
 * read-back verification, then the whole-object verification, then the
 * completion that closes the intent. `bytes` are the already-verified bytes the
 * caller read through its own identity checks (P2 for a candidate, the champion
 * digests for a rollback), one entry per file of the request and in the same
 * order; each digest must be that file's `contentSha256`, so what the intent
 * promises and what the writes install cannot disagree — for either file of a
 * two-file object. A file the direction removes has no bytes to write again and
 * takes `undefined` in that slot.
 *
 * The sources come first because the intent *names* them as the bytes a recovery
 * would write again — a line naming a source that no longer holds those bytes is
 * a recovery that can never complete. So before anything is recorded every
 * source is confined to the ledger root, re-read through
 * {@link CommitHost.readSource} (which re-digests and refuses a source that is
 * gone, changed type or changed content), and fsynced together with the
 * directories that hold it. Any failure there is a named stop with no line
 * recorded and nothing written. The object check comes next and also before the
 * line: the digests above describe the files the intent names, and an entry the
 * directory grew that nobody names is exactly what they cannot see — so
 * {@link CommitHost.objectWriteRefusal} reads the *directory* first, and a
 * refusal there is a named stop with no line recorded and nothing written,
 * instead of a commit that lands and then discovers the directory was not the
 * object it committed. Only then is the intent appended — through the service's
 * own durable append, so the line is on disk before production moves — and only
 * after every write has been read back and verified, the capability row is in
 * place (a capability commit, A6) and the whole object has passed
 * {@link CommitHost.verifyCommitted}, is the completion appended.
 *
 * The order of the two halves is the direction's, and it is the one that leaves
 * nothing usable half-made: an **apply** writes the files first and moves the
 * registry row last, so a provider whose files were written but whose row never
 * landed is granted by nothing; a **rollback** moves the row first (reverting or
 * removing the grant) and removes the files after it, so a skill whose row is
 * already gone is unreachable while its files are still being removed. Either
 * interruption leaves the intent open and the deployment's registry untouched by
 * any later stage — reconciliation settles it, never a second path.
 *
 * A throw from any stage leaves the intent open and is the caller's to report:
 * the intent is the record of what was underway, and reconciliation — not a
 * second guess — is what settles it.
 */
export async function commitIntent(
  host: CommitHost,
  request: CommitRequest,
  bytes: readonly (Buffer | undefined)[],
): Promise<void> {
  if (request.files.length === 0 && request.capability === undefined) {
    throw new Error(
      `evolution: the ${request.direction} for proposal "${request.proposalId}" names nothing to commit — a commit replaces the ` +
      'fixed file set of one skill object (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar) and/or ' +
      'moves exactly one capability row, so a request with nothing in it records nothing and writes nothing',
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
    const provided = bytes[index]
    if (file.contentSha256 === null) {
      if (provided !== undefined) {
        throw new Error(
          `evolution: the ${request.direction} for proposal "${request.proposalId}" carries bytes for "${file.target}" while its intent ` +
          'records that this direction removes the file — a removal writes nothing, so the bytes and the record disagree: nothing was written',
        )
      }
      return
    }
    const digest = provided === undefined ? undefined : sha256Hex(provided)
    if (digest !== file.contentSha256) {
      throw new Error(
        `evolution: the bytes this ${request.direction} would write to "${file.target}" hash to sha256 ${digest ?? '(none provided)'}, ` +
        `not the content identity ${file.contentSha256} its commit records — nothing was written`,
      )
    }
  })
  // Before a byte is written or a line is recorded: every target must resolve
  // inside the production skill root. `apply`/`rollback` confine the targets when
  // they build the request, but this function is exported — so the check lives
  // where the write happens, not only where the request is built.
  const targets = request.files.map(file => productionRelative(host, file.target))
  const sources = request.files.map(file => (file.source === undefined ? undefined : ledgerRelative(host, request, file.source)))
  for (const file of request.files) {
    if (file.source === undefined) continue
    try {
      await host.readSource(file.source, file.contentSha256!)
    } catch (error) {
      throw new Error(
        `evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" does not ` +
        `hold the bytes its commit recorded (${error instanceof Error ? error.message : String(error)}) — the source an intent names must be ` +
        're-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and nothing is written',
      )
    }
  }
  // The same rule for the row's own recoverable bytes: a capability intent that
  // names a source must be able to read the row it installs back from it.
  if (request.capability !== undefined && request.capability.source !== undefined) {
    await assertCapabilitySource(host, request, request.capability)
  }
  for (const [index, file] of request.files.entries()) {
    if (file.source === undefined) continue
    await syncSource(host, request, file, sources[index]!)
  }
  if (request.capability !== undefined && request.capability.source !== undefined) {
    await syncSourceRelative(host, request, request.capability.source, `capability row "${request.capability.name}"`)
  }
  const intent: CommitIntentView = {
    intentId: `${request.proposalId}/${request.direction}`,
    proposalId: request.proposalId,
    direction: request.direction,
    approvalRef: request.approvalRef,
    files: request.files.map(file => ({ ...file })),
    ...(request.capability === undefined ? {} : { capability: { ...request.capability } }),
    actor: request.actor,
    at: new Date().toISOString(),
  }
  // The last gate before the intent line, and the one no digest below can be:
  // what this commit replaces is one whole *directory*. An entry the intent does
  // not name — a guidance skill that grew a `SKILL.contract.json` beside it, a
  // file at a supported resource position — leaves every per-file digest intact
  // while making the directory something other than the object the intent
  // commits, and asking after the write is asking too late: production has moved
  // and only the intent is left to explain it.
  const refusal = await host.objectWriteRefusal(intent)
  if (refusal !== null) {
    throw new Error(
      `evolution: the ${request.direction} of proposal "${request.proposalId}" cannot write the skill object ` +
      `"${dirname(intent.files[0]!.target)}" — ${refusal}; a commit replaces one complete object and nothing beside it, so the commit stops ` +
      'by name: nothing was written and no commit intent was recorded',
    )
  }
  await host.append({ formatVersion: 4, kind: 'commit_intent', ...intent })
  host.probe('intent-recorded')
  await installDirection(host, intent, bytes, targets)
  await host.verifyCommitted(intent)
  host.probe('commit-verified')
  await appendCompletion(host, intent)
}

/**
 * Settle one open intent against the filesystem and the registry, or stop by
 * name: re-read every one of the intent's own recoverable sources (every file's,
 * and the capability row's when it has one) and verify it still hashes to what
 * the intent committed; read every production file again and classify it as the
 * pre-commit state, the committed content, absent or something else; read the
 * registry row and classify it the same three ways — a source that is gone or
 * changed, or a file or row that is missing or foreign, stops by name right
 * there, in its own words — and then ask
 * {@link CommitHost.objectWriteRefusal} what the *directory* holds beyond the
 * files the intent names. If nothing refused, then
 *
 * - nothing has moved yet (every file still holds its baseline, the row its
 *   baseline): the same operation is carried out — an apply writes the files and
 *   then installs the row, a rollback reverts the row and then removes the files
 *   — and the completion recorded (`completed-redone`);
 * - the halves are mixed (a process that died between them): the side that did
 *   not land is carried out, and the side that did has its durability
 *   re-established; the completion is recorded only once
 *   {@link CommitHost.verifyCommitted} confirms the whole state
 *   (`completed-redone`);
 * - everything already holds `contentSha256` — the writes landed but their
 *   completion did not — so each target's staging leftovers are swept, each
 *   production directory is fsynced, and then only the completion is recorded,
 *   with production's bytes and the registry's row left exactly as they are
 *   (`completed-written`);
 * - a file that is missing where the intent expects a state, a file or row
 *   holding neither digest, or a source that is gone or changed — a `blocked`
 *   outcome naming the intent, the target and what was actually found, with
 *   nothing written and the intent left open;
 * - the directory holding an entry the intent does not name — the object check
 *   above — a `blocked` outcome naming the entry, with nothing written: a
 *   recovery settles an intent over the object it commits, never over a
 *   directory a third party turned into something else.
 *
 * The `completed-written` branch still fsyncs the production directories, even
 * though it writes no bytes: the completion is the claim that production holds
 * the committed content *durably*, and a rename (or a removal) is durable only
 * once the directory that holds it is fsynced. A rename whose directory fsync
 * failed when its commit ran (or a process that died before it) left production
 * on the new bytes with that durability unestablished — so recording the
 * completion without re-establishing it would be exactly the "completion
 * recorded for a write that may be lost" state the commit order exists to
 * prevent, and nothing would ever reconcile it again, because the completion
 * closes the intent. The same branch sweeps each target's own staging leftovers,
 * so the invariant is total: settling an intent leaves no staging file of that
 * object behind, whichever branch settled it. The deliberate consequence: on a
 * filesystem whose production directory cannot be fsynced, a recovery stops by
 * name — the completion is not recorded and the intent stays open — instead of
 * recording a completion it cannot stand behind.
 *
 * Every branch that records a completion calls
 * {@link CommitHost.verifyCommitted} first: a state a recovery finished must load
 * as one object carrying this direction's identity, and read as the row this
 * direction installed, before the ledger may say the commit is settled, exactly
 * as a fresh commit must.
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

  const bytes: (Buffer | undefined)[] = []
  for (const file of intent.files) {
    if (file.source === undefined) {
      bytes.push(undefined)
      continue
    }
    try {
      bytes.push(await host.readSource(file.source, file.contentSha256!))
    } catch (error) {
      return outcome(
        'blocked',
        `evolution: the recoverable source "${file.source}" of commit intent "${intent.intentId}" for the file "${file.target}" is no ` +
        `longer readable as the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot ` +
        `be re-verified under ${host.root}, so the commit stops by name and the intent stays open; nothing was written`,
      )
    }
  }
  // The capability row's own recoverable bytes, and the row the registry holds
  // right now — the two reads its classification is made from.
  let rowEntry: CapabilityConfig | null = null
  if (intent.capability !== undefined && intent.capability.contentSha256 !== null) {
    try {
      rowEntry = await committedRow(host, intent.capability)
    } catch (error) {
      return outcome(
        'blocked',
        `evolution: the capability row "${intent.capability.name}" of commit intent "${intent.intentId}" cannot be re-read from its ` +
        `recoverable bytes (${error instanceof Error ? error.message : String(error)}) — the row cannot be re-verified, so the commit ` +
        'stops by name and the intent stays open; nothing was written',
      )
    }
  }
  let rowState: 'baseline' | 'content' | 'other' | 'unreadable' = intent.capability === undefined ? 'content' : 'baseline'
  if (intent.capability !== undefined) {
    const seen = await currentCapabilityRow(host, intent)
    if (seen === undefined) {
      rowState = 'unreadable'
    } else {
      rowState = seen.digest === intent.capability.baselineSha256
        ? 'baseline'
        : seen.digest === intent.capability.contentSha256 ? 'content' : 'other'
    }
  }
  if (rowState === 'unreadable') {
    return outcome(
      'blocked',
      `evolution: the capability registry cannot be read for the row "${intent.capability!.name}" of commit intent "${intent.intentId}" — ` +
      'whether the row the intent records is in place cannot be established, so the commit stops by name and the intent stays open; ' +
      'nothing was written',
    )
  }
  if (rowState === 'other') {
    return outcome(
      'blocked',
      `evolution: the capability registry row "${intent.capability!.name}" of commit intent "${intent.intentId}" reads as neither the row ` +
      `recorded before the commit (sha256 ${intent.capability!.baselineSha256 ?? 'absent'}) nor the row it committed ` +
      `(sha256 ${intent.capability!.contentSha256 ?? 'absent'}) — a third party changed it, so the commit stops by name and the intent ` +
      'stays open; nothing is overwritten and the completion is never recorded',
    )
  }

  const relatives: string[] = []
  const states: ('baseline' | 'content' | 'other')[] = []
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
    digests.push(current?.sha256 ?? 'absent')
    const digest = current?.sha256 ?? null
    states.push(digest === file.baselineSha256
      ? 'baseline'
      : digest === file.contentSha256 ? 'content' : 'other')
  }

  const foreign = intent.files.findIndex((_file, index) => states[index] === 'other')
  if (foreign >= 0) {
    const file = intent.files[foreign]!
    const absent = digests[foreign] === 'absent'
    return outcome(
      'blocked',
      `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" ${absent ? 'is missing' : `holds sha256 ${digests[foreign]}`} — it holds ` +
      `neither the state before the commit (${file.baselineSha256 === null ? 'absent' : `sha256 ${file.baselineSha256}`}) nor the state it committed ` +
      `(${file.contentSha256 === null ? 'absent' : `sha256 ${file.contentSha256}`}); a third party ${absent ? 'removed' : 'changed'} it, so the commit stops by name and ` +
      `the intent stays open; nothing is ${absent ? 'recreated' : 'overwritten'} and the completion is never recorded`,
    )
  }

  // The same pre-write object check a fresh commit runs, asked before any branch
  // below writes a byte: the files the intent names may all hold the states a
  // recovery accepts while the *directory* is no longer the object the intent
  // commits — a guidance object that grew a `SKILL.contract.json` (a role
  // change), a resource nothing declares, a stranger's entry. A recovery that
  // wrote its bytes anyway would settle the intent on a directory no loader
  // accepts as this object, which is the state the completion must never claim.
  // The per-file classification above stays first, so a file a third party
  // changed or removed is still refused in that file's own words; this is what
  // covers every entry the intent does not name.
  if (intent.files.length > 0) {
    const refusal = await host.objectWriteRefusal(intent)
    if (refusal !== null) {
      return outcome(
        'blocked',
        `evolution: the ${intent.direction} of proposal "${intent.proposalId}" cannot write the skill object ` +
        `"${dirname(intent.files[0]!.target)}" of commit intent "${intent.intentId}" — ${refusal}; a commit replaces one complete object ` +
        'and nothing beside it, so nothing is written and the intent stays open until a human settles what the directory holds',
      )
    }
  }

  const settled = states.every(state => state === 'content') && rowState === 'content'
  if (!settled) {
    // The side that did not land is carried out in the direction's own order —
    // an apply writes files first and installs the row last, a rollback reverts
    // the row first and removes the files after it — so an interruption at any
    // point of the redo leaves the provider unreachable, never half-granted.
    const writeFiles = async (): Promise<void> => {
      for (const [index, file] of intent.files.entries()) {
        if (states[index] === 'content') continue
        await installFile(host, intent, file, relatives[index]!, bytes[index])
      }
    }
    if (intent.direction === 'apply') {
      await writeFiles()
      if (intent.capability !== undefined && rowState !== 'content') await installCapability(host, intent, rowEntry)
    } else {
      if (intent.capability !== undefined && rowState !== 'content') await installCapability(host, intent, rowEntry)
      await writeFiles()
    }
    // The side that already landed has its durability re-established (the
    // removal's directory fsync, the rename's sweep and fsync) so the completion
    // is never recorded over a write that may be lost.
    for (const file of intent.files) {
      if (file.contentSha256 === null) continue
      await sweepStaging(dirname(file.target), file.target)
      await syncTargetDirectory(host, intent, file.target)
    }
    await host.verifyCommitted(intent)
    host.probe('commit-verified')
    await appendCompletion(host, intent)
    return outcome('completed-redone')
  }

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
    if (file.contentSha256 === null) continue
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
 * Carry out one commit — a fresh one, or the half a redo found missing — in the
 * direction's own order (see {@link commitIntent}): the **apply** direction
 * writes the files and installs the capability row after them; the **rollback**
 * direction moves the row first and removes or restores the files after it. The
 * order is what makes any interruption leave nothing usable half-made: a
 * provider whose files exist but whose row never landed is granted by nothing,
 * and a skill whose row is already gone is unreachable while its files are still
 * being removed.
 *
 * `relativeTargets` are the targets' paths under the skill root, already confined
 * by the caller. `bytes` may carry an entry per file — `undefined` exactly for a
 * file this direction removes, which is written as a removal rather than a
 * rename.
 */
async function installDirection(
  host: CommitHost,
  intent: CommitIntentView,
  bytes: readonly (Buffer | undefined)[],
  relativeTargets: readonly string[],
): Promise<void> {
  const files = async (): Promise<void> => {
    for (const [index, file] of intent.files.entries()) {
      await installFile(host, intent, file, relativeTargets[index]!, bytes[index])
    }
  }
  const row = async (): Promise<void> => {
    if (intent.capability === undefined) return
    const entry = intent.capability.contentSha256 === null ? null : await committedRow(host, intent.capability)
    await installCapability(host, intent, entry)
  }
  if (intent.direction === 'apply') {
    await files()
    await row()
    return
  }
  await row()
  await files()
}

/**
 * One file of one commit: an atomic replace and its read-back when the direction
 * writes it, a removal and its read-back when the direction ends without it. The
 * read-back is not a formality — it is what makes "the write happened" and
 * "production carries this state" the same fact, so a completion is never
 * recorded over a state the commit did not install.
 */
async function installFile(
  host: CommitHost,
  intent: CommitIntentView,
  file: CommitFile,
  relativeTarget: string,
  bytes: Buffer | undefined,
): Promise<void> {
  if (file.contentSha256 === null) {
    await removeFile(host, intent, file.target)
    return
  }
  if (bytes === undefined) {
    throw new Error(
      `evolution: the ${intent.direction} of proposal "${intent.proposalId}" reaches "${file.target}" with no bytes to install while its ` +
      'intent records content — nothing was written',
    )
  }
  await writeFileAtomic(file.target, bytes, () => host.probe('write-staged', file.target))
  const readback = await host.readProduction(relativeTarget)
  if (readback === null || readback.sha256 !== file.contentSha256) {
    throw new Error(
      `evolution: the production file "${file.target}" does not hold the committed content after the atomic replace ` +
      `(sha256 ${readback?.sha256 ?? 'missing'} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what ` +
      'production actually carries by name',
    )
  }
  host.probe('write-renamed', file.target)
}

/**
 * Remove one production file this direction ends without — only ever a file the
 * candidate itself created, because a file that existed before it is *replaced*
 * by the apply and *restored* by the rollback, never deleted — together with the
 * directory the candidate created for it when that directory is now empty: the
 * baseline recorded nothing there, so production is left exactly as the baseline
 * described it (a fresh skill object is a directory that does not exist). The
 * directory fsync that follows is the removal's durability, and it lands on the
 * skill root when the directory itself went with the file.
 */
async function removeFile(host: CommitHost, intent: CommitIntentView, target: string): Promise<void> {
  const directory = dirname(target)
  try {
    await rm(target, { force: true })
  } catch (error) {
    throw new Error(
      `evolution: the production file "${target}" could not be removed for the ${intent.direction} of commit intent ` +
      `"${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the intent stays open and the state must not be ` +
      'treated as settled',
    )
  }
  let directoryGone = false
  if (directory !== host.skillRoot) {
    directoryGone = await rmdir(directory).then(() => true, () => false)
  }
  try {
    await syncDirectory(directoryGone ? dirname(directory) : directory)
  } catch (error) {
    throw new Error(
      `evolution: the directory "${directoryGone ? dirname(directory) : directory}" could not be fsynced after removing "${target}" for the ` +
      `${intent.direction} of commit intent "${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the removal ` +
      'may not be durable, so the completion is not recorded and the intent stays open',
    )
  }
  const readback = await host.readProduction(productionRelative(host, target))
  if (readback !== null) {
    throw new Error(
      `evolution: the production file "${target}" still holds sha256 ${readback.sha256} after the ${intent.direction} of commit intent ` +
      `"${intent.intentId}" removed it — the intent stays open and a reconciliation reports what production actually carries by name`,
    )
  }
}

/**
 * Install (or remove) the one capability row a commit carries, once the registry
 * still reads as the intent recorded. The baseline check is the registry's own
 * half of the object check a file commit gets from
 * {@link CommitHost.objectWriteRefusal}: a row a third party moved between the
 * decision and this write is refused by name with nothing written, and an intent
 * whose row already sits at its content state is not written a second time.
 */
async function installCapability(host: CommitHost, intent: CommitIntentView, entry: CapabilityConfig | null): Promise<void> {
  const capability = intent.capability!
  const seam = host.capability
  if (seam === undefined) {
    throw new Error(
      `evolution: the ${intent.direction} of proposal "${intent.proposalId}" carries capability row "${capability.name}" and this host ` +
      'offers no registry seam to move it — the row cannot be installed, so the commit stops by name with nothing recorded as applied',
    )
  }
  const seen = await currentCapabilityRow(host, intent)
  if (seen === undefined) {
    throw new Error(
      `evolution: the capability registry cannot be read for the row "${capability.name}" of the ${intent.direction} of proposal ` +
      `"${intent.proposalId}" — the row this commit would move cannot be compared against the one its intent recorded, so nothing was written`,
    )
  }
  if (seen.digest !== capability.baselineSha256) {
    throw new Error(
      `evolution: the capability registry row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" reads ` +
      `${seen.digest === null ? 'no row at all' : `as ${seen.digest}`}, not the state before the commit ` +
      `(${capability.baselineSha256 ?? 'no row'}) — a third party moved it, so nothing was written and no completion is recorded; create a ` +
      'new candidate from the current registry state and re-evaluate it',
    )
  }
  try {
    await seam.apply(intent, entry)
  } catch (error) {
    throw new Error(
      `evolution: the capability registry row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" could not ` +
      `be written (${error instanceof Error ? error.message : String(error)}) — nothing was recorded as applied and the commit intent stays ` +
      'open, because the provider this commit installs is not the one the deployment would resolve',
    )
  }
  const after = await currentCapabilityRow(host, intent)
  if (after === undefined || after.digest !== capability.contentSha256) {
    throw new Error(
      `evolution: the capability registry row "${capability.name}" does not read as the row this ${intent.direction} committed after the ` +
      `write (${after?.digest === undefined || after.digest === null ? 'no row' : after.digest} != ${capability.contentSha256 ?? 'no row'}) — ` +
      'the completion is not recorded and the intent stays open',
    )
  }
}

/**
 * The registry row a commit's own recoverable bytes hold, parsed and verified
 * against the digest the intent recorded. Exported because the capability
 * table's own text is written from the same read (A6,
 * `EvolutionService.verifyCommitted`): one parse, one digest check, so the file
 * and the registry can never disagree about what the commit installed.
 */
export async function committedRow(host: CommitHost, capability: CommitIntentView['capability']): Promise<CapabilityConfig> {
  const source = capability!.source
  if (source === undefined) {
    throw new Error(
      `the capability row "${capability!.name}" is recorded with content ${capability!.contentSha256} and no recoverable source — ` +
      'the row cannot be read back, and an intent must name the bytes a recovery would write again',
    )
  }
  const bytes = await host.readSource(source, capability!.contentSha256!)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `the capability row source "${source}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const entry = parsed as CapabilityConfig
  if (capabilityRowDigest(entry) !== capability!.contentSha256) {
    throw new Error(
      `the capability row source "${source}" holds a row that hashes to ${capabilityRowDigest(entry)}, not the ${capability!.contentSha256} ` +
      'its commit recorded — a row whose bytes and identity disagree is not one this commit may install',
    )
  }
  return entry
}

/** The registry row as it reads now, digested — `{ digest: null }` for a name the registry does not hold, `undefined` when it cannot be read. */
async function currentCapabilityRow(
  host: CommitHost,
  intent: CommitIntentView,
): Promise<{ digest: string | null } | undefined> {
  const capability = intent.capability
  if (capability === undefined) return undefined
  const seam = host.capability
  if (seam === undefined) return undefined
  try {
    const entry = await seam.read(capability.name)
    return { digest: entry === null ? null : capabilityRowDigest(entry) }
  } catch {
    return undefined
  }
}

/** Read and verify a capability row's recoverable bytes before the intent that names them is recorded. */
async function assertCapabilitySource(host: CommitHost, request: CommitRequest, capability: CommitCapability): Promise<void> {
  try {
    await committedRow(host, capability)
  } catch (error) {
    throw new Error(
      `evolution: the recoverable source "${capability.source}" of the capability row "${capability.name}" in the ${request.direction} for ` +
      `proposal "${request.proposalId}" does not hold the row its commit recorded (${error instanceof Error ? error.message : String(error)}) — ` +
      'the source an intent names must be re-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and ' +
      'nothing is written',
    )
  }
}

/**
 * Close one intent: the completion line, written for the intent's own grant and
 * its whole file set — its `approvalRef`, every `target` the intent committed in
 * intent order (empty for a row-only capability commit, whose row is named by the
 * intent line directly above it), and its actor, so a completion can never
 * describe a second approval or a second path. The fold refuses a completion with
 * no matching open intent, which is what makes a repeat (a retry, a restart, a
 * double reconciliation) cost nothing: the second line has nothing to close.
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
function ledgerRelative(host: CommitHost, request: CommitRequest, source: string): string {
  const rel = relative(host.root, resolve(host.root, source))
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `evolution: the recoverable source "${source}" of the ${request.direction} for proposal "${request.proposalId}" is not ` +
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
  await syncSourceRelative(host, request, sourceRelative, `"${file.source}"`)
}

/**
 * The same durability rule for any source a commit names — a file's bytes, or
 * the capability row's bytes — so both halves of a capability commit are durable
 * before the one line that names them.
 */
async function syncSourceRelative(
  host: CommitHost,
  request: CommitRequest,
  sourceRelative: string,
  label: string,
): Promise<void> {
  const source = resolve(host.root, sourceRelative)
  let handle: FileHandle | undefined
  try {
    handle = await open(source, 'r')
    await handle.sync()
  } catch (error) {
    throw new Error(
      `evolution: the recoverable source ${label} of the ${request.direction} for proposal "${request.proposalId}" could not ` +
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
        `evolution: the directory "${directory}" holding the recoverable source ${label} of the ${request.direction} for ` +
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
