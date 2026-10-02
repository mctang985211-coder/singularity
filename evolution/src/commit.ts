/** The one commit path behind `apply` and `rollback` (K2): durable intent, atomic per-file writes, completion and reconciliation.
 * @module dsh-singularity-evolution/commit */

import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { CommitCapability, CommitDirection, CommitIntentView, EvolutionRecord } from './evolution.ts'
import { capabilityRowDigest } from './capability-candidate.ts'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { ProductionReadError } from './shared.ts'

export { sha256Hex }

/** The durable stages of one commit, observed through the commit probe and never on disk. */
export type CommitStage = 'intent-recorded' | 'write-staged' | 'write-renamed' | 'commit-verified'

/** One file of one commit: where it goes, the bytes production must hold before and after, and where its recoverable source lives. */
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

/** The capability-registry half of a commit host (A6): required exactly when a commit carries a capability row. */
export interface CommitCapabilityHost {
  /** The row the registry holds for `name` right now, or `null` when it holds none. */
  read(name: string): Promise<CapabilityConfig | null>
  /** Install (`entry`) or remove (`null`) one capability row, inside the commit's own order. */
  apply(intent: CommitIntentView, entry: CapabilityConfig | null): Promise<void>
}

/** What the commit path needs from the evolution service, and no more: the roots, the record funnel, the source reads and the write refusals. */
export interface CommitHost {
  /** Absolute ledger root: `source` resolves against it and is confined to it. */
  readonly root: string
  /** Production skill root: a commit's target must sit under it. */
  readonly skillRoot: string
  readonly taskTemplatesRoot?: string
  /** Append one record through the service's funnel (format check, staged fold, durable write). */
  append(record: EvolutionRecord): Promise<void>
  /** Read the recoverable bytes a commit names and verify them against the digest the intent records. */
  readSource(source: string, sha256: string): Promise<Buffer>
  /** The service's walk-verified production read: `null` when nothing is there, a throw for a symlink or a non-file. */
  readProduction(relative: string): Promise<{ bytes: Buffer; sha256: string } | null>
  /** The named reason this commit must not write the directory its file set lives in, or `null` when it may. */
  objectWriteRefusal(intent: CommitIntentView): Promise<string | null>
  /** The named reason this commit must not write anything because the capability table moved, or `null` when it may. */
  tableWriteRefusal(intent: CommitIntentView): Promise<string | null>
  /** Called after every file has been written and read back (and the row installed), to verify the whole object. */
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
  /** `completed-redone`: production still held the pre-commit state, so the same write was carried out again. */
  result: 'completed-redone' | 'completed-written' | 'blocked'
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  detail?: string
}

/** Replace `target` with exactly `bytes`, atomically: the staging files a dead process left behind are swept first. */
export async function writeFileAtomic(
  target: string,
  bytes: Buffer,
  onStaged?: () => void | Promise<void>,
  appendOnly = false,
): Promise<void> {
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
    await onStaged?.()
    if (appendOnly) {
      await link(staging, target)
      await rm(staging)
    } else await rename(staging, target)
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

/** Remove every entry beside `target` whose name begins with this target's own staging prefix. */
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

/** Persist one commit and carry it out, in the order the recovery rule fixes, so a dead process settles from what production holds. */
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
  const targets = request.files.map(file => productionRelative(host, file.target))
  const sources = request.files.map(file =>
    file.source === undefined ? undefined : ledgerRelative(host, request, file.source),
  )
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
  if (request.capability?.mcpServers !== undefined) await host.readSource(request.capability.mcpSource!, request.capability.mcpServers.digest)
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
  if (request.capability?.mcpServers !== undefined) await syncSourceRelative(host, request, request.capability.mcpSource!, 'MCP definitions')
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
  // The last gate before the intent line, and the one no digest below can be: the object-level write refusal.
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
  // The last gate before production moves, and the one that keeps a capability
  const tableRefusal = await host.tableWriteRefusal(intent)
  if (tableRefusal !== null) {
    throw new Error(
      `evolution: ${tableRefusal}; nothing was written for the ${request.direction} of proposal "${request.proposalId}", its commit intent ` +
        `"${intent.intentId}" is recorded and stays open and no completion is recorded, so the table keeps exactly the bytes it holds now and ` +
        'the row this commit was to install is not in it',
    )
  }
  await installDirection(host, intent, bytes, targets)
  await host.verifyCommitted(intent)
  host.probe('commit-verified')
  await appendCompletion(host, intent)
}

/** Settle one open intent against the filesystem and the registry, or stop by name. */
export async function reconcileIntent(host: CommitHost, intent: CommitIntentView): Promise<ReconcileOutcome> {
  const targets = intent.files.map(file => file.target)
  const outcome = (result: ReconcileOutcome['result'], detail?: string): ReconcileOutcome => ({
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
  if (intent.capability?.mcpServers !== undefined) {
    try {
      await host.readSource(intent.capability.mcpSource!, intent.capability.mcpServers.digest)
    } catch (error) {
      return outcome(
        'blocked',
        `evolution: the recoverable MCP source "${intent.capability.mcpSource}" of commit intent "${intent.intentId}" cannot be ` +
          `re-verified (${error instanceof Error ? error.message : String(error)}); the intent stays open and nothing was written`,
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
  let rowState: 'baseline' | 'content' | 'other' | 'unreadable' =
    intent.capability === undefined ? 'content' : 'baseline'
  if (intent.capability !== undefined) {
    const seen = await currentCapabilityRow(host, intent)
    if (seen === undefined) {
      rowState = 'unreadable'
    } else {
      rowState =
        seen.digest === intent.capability.baselineSha256
          ? 'baseline'
          : seen.digest === intent.capability.contentSha256
            ? 'content'
            : 'other'
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
          `(${error instanceof ProductionReadError ? error.reason : (error as Error).message}) — the commit stops by name and the intent stays open; ` +
          'nothing was written',
      )
    }
    relatives.push(relative)
    digests.push(current?.sha256 ?? 'absent')
    const digest = current?.sha256 ?? null
    states.push(digest === file.baselineSha256 ? 'baseline' : digest === file.contentSha256 ? 'content' : 'other')
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

  // The table half of that same before picture (A6, EVO-2): the row a capability
  const tableRefusal = await host.tableWriteRefusal(intent)
  if (tableRefusal !== null) {
    return outcome(
      'blocked',
      `evolution: ${tableRefusal}; nothing was written for the ${intent.direction} of proposal "${intent.proposalId}" and commit intent ` +
        `"${intent.intentId}" stays open — a commit writes its row into that file only while it reads as a state the prepare froze, and a ` +
        'human settles the table (or restores it, and this recovery is run again)',
    )
  }

  const settled = states.every(state => state === 'content') && rowState === 'content'
  if (!settled) {
    // The side that did not land is carried out in the direction's own order —
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
    // The side that already landed has its durability re-established (the rename and its directory fsync).
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

  // This branch writes no bytes, but it still leaves no trace of its own staging files behind.
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

/** Make one production target's directory durable before a completion is recorded. */
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

/** Carry out one commit — a fresh one, or the half a redo found missing — in the intent's own order. */
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

/** One file of one commit: an atomic replace and its read-back when the direction writes it. */
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
  await writeFileAtomic(file.target, bytes, () => host.probe('write-staged', file.target), host.taskTemplatesRoot !== undefined && dirname(file.target) === host.taskTemplatesRoot)
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

/** Remove one production file this direction ends without — only ever a file the intent names. */
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
  if (directory !== host.skillRoot && directory !== host.taskTemplatesRoot) {
    directoryGone = await rmdir(directory).then(
      () => true,
      () => false,
    )
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

/** Install (or remove) the one capability row a commit carries, once the registry reads as the intent expected. */
async function installCapability(
  host: CommitHost,
  intent: CommitIntentView,
  entry: CapabilityConfig | null,
): Promise<void> {
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

/** The registry row a commit's own recoverable bytes hold, parsed and verified against the intent's digests. */
export async function committedRow(
  host: CommitHost,
  capability: CommitIntentView['capability'],
): Promise<CapabilityConfig> {
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
async function assertCapabilitySource(
  host: CommitHost,
  request: CommitRequest,
  capability: CommitCapability,
): Promise<void> {
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

/** Close one intent: the completion line, written for the intent's own grant and direction. */
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

/** One commit target relative to the production skill root: the shape the intent records. */
function productionRelative(host: CommitHost, target: string): string {
  if (host.taskTemplatesRoot !== undefined && dirname(resolve(target)) === host.taskTemplatesRoot && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*@[1-9][0-9]*\.json$/.test(basename(target))) return resolve(target)
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

/** The check that the recoverable source an intent will name for one file stands under the ledger root. */
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

/** Make one file's recoverable source durable *before* the intent that names it is recorded. */
async function syncSource(
  host: CommitHost,
  request: CommitRequest,
  file: CommitFile,
  sourceRelative: string,
): Promise<void> {
  await syncSourceRelative(host, request, sourceRelative, `"${file.source}"`)
}

/** The same durability rule for any source a commit names — a file's bytes or a capability row's. */
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

/** The directories that make a source's *path* durable, inside-out: the one that holds it first, up to the ledger root. */
function sourceDirectories(root: string, source: string): readonly string[] {
  const directories: string[] = []
  for (let directory = dirname(source); ; directory = dirname(directory)) {
    directories.push(directory)
    if (directory === root || dirname(directory) === directory) break
  }
  return directories
}

/** fsync one directory so an entry created or renamed inside it is durable. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}
