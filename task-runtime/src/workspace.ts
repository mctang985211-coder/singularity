/**
 * One workspace, one writer (A3 §3.4): the ownership record that stands between
 * two runs that would otherwise write into the same checkout.
 *
 * Why a registry and not a lock: a task tree pays for its parallelism by handing
 * the same checkout down a chain — a root run, the batch the runtime drives, the
 * child that currently works, the verifier that reads the result — and every one
 * of those steps must be sure the previous writer has stopped before it starts.
 * The dangerous case is not two simultaneous calls in one process; it is a
 * *second* process (a restarted deployment, a second graph) claiming a checkout
 * whose previous owner died mid-write. So ownership is recorded twice, with two
 * different jobs:
 *
 * 1. **In process**: a stack per workspace in a `Map`, with the top of the stack
 *    being the current owner. This is the truth for this process: claim, hand
 *    over (`push`) and release are checked against it, and a stack that does not
 *    match the request is a loud diagnostic, never a silent pop.
 * 2. **On disk**: `<markerRoot>/<sha256(path)>.json`, written tmp+rename so a
 *    reader never sees a half-written marker. Every write uses its own temporary
 *    name: a child's submission chain and the batch driver can mutate the same
 *    workspace's marker at the same time while a run settles, and one shared
 *    temporary path would let the first `rename` consume the file the second was
 *    about to move — an ENOENT out of a release that is nobody's protocol error.
 *    Concurrent writes therefore leave one whole marker, the write that landed
 *    last; which owner that is remains the caller's business, because the
 *    in-process stack is the truth for this process and handovers are meant to be
 *    serialized. This is what a *later* process reads, and all it can honestly
 *    say is "the pid in here was alive when I looked" — the boundary §3.4 states
 *    rather than hides: `process.kill(pid, 0)` reports EPERM for another user's
 *    process and must count as alive; a reused pid makes a dead owner look alive
 *    (the marker carries the kernel's own start-time token, compared with the live
 *    process's and *reported* when they disagree — a reused pid is still a live
 *    pid, so the comparison is a diagnostic, not an authorisation: only a pid that
 *    is provably gone is adopted); and a `DSH_HOME` shared across machines makes
 *    the pid meaningless.
 *
 * What that means for the rules, and why they are this strict:
 *
 * - A claim runs only into an empty stack *and* no marker. Any marker at all —
 *   alive, dead, or unreadable — refuses the claim. Only
 *   {@link WorkspaceRegistry.reconcileAdopt} takes a stale marker over, and it
 *   is meant for one caller: the recovery path, which has first settled the dead
 *   tree it is adopting. A normal claim that could take over a stale marker would
 *   let an ordinary second graph walk into a checkout a crashed run may still be
 *   leaving bytes in.
 * - A marker naming *this* process while the in-process stack is empty is a
 *   disagreement, not evidence: it means a claim was recorded on disk without a
 *   holder, or a holder was dropped without releasing. Either way the honest
 *   answer is the same one a live foreign owner gets — busy, with the
 *   disagreement named.
 * - `release`/`push` demand the owner that is actually on top. A mismatch throws
 *   with both owners in the text: popping the wrong owner would silently hand a
 *   checkout to a writer while another writer still believes it holds it.
 *
 * Paths are keys here, compared as given: a caller normalizes once with
 * {@link normalizeWorkspacePath} (a symlinked checkout reached two ways must
 * hash to one marker, and only the caller knows which path it resolved) and
 * passes that string everywhere. The registry never resolves anything itself, so
 * it cannot key the same directory under two names.
 * @module @dangosys/dsh-singularity-task-runtime/workspace
 */

import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { RunId, TaskId } from '@dangosys/dsh-singularity-task'

/** The directory under a deployment's run-binding root that holds ownership markers (§3.4). */
export const WORKSPACE_OWNERS_DIR = 'workspace-owners'

/**
 * Who holds a workspace. One shape for the three roles the protocol gives it:
 * the run that is writing, the verifier that owns the checkout exclusively
 * while it judges, and the runtime itself in the gap between children.
 */
export interface WorkspaceOwner {
  kind: 'run' | 'verifier' | 'batch'
  /** The store this owner belongs to; a second store claiming the same checkout is a conflict, not a merge. */
  storeId: string
  taskId?: TaskId
  runId?: RunId
  batchId?: string
  /** When this owner took the workspace (the marker's own instant). */
  since: string
}

/** What one workspace's marker file holds: the owner, plus what a later process can check about it. */
interface WorkspaceMarker {
  /** The normalized path this marker was written for; a mismatch is reported rather than ignored. */
  path: string
  /** The pid that wrote it. */
  pid: number
  /**
   * The kernel's start-time token for {@link pid} (`/proc/<pid>/stat` field 22,
   * clock ticks since boot), when `/proc` answered. Opaque on purpose: it exists
   * so a reader can tell "the process that wrote this marker" from "some process
   * that later got the same pid", by comparing it with the same field for the
   * live pid. Absent on a platform that cannot answer, and the pid-reuse boundary
   * is then simply not defended.
   */
  processStartedAt?: string
  owner: WorkspaceOwner
  /** The owner's `since`, copied here so the marker reads on its own. */
  since: string
}

/**
 * A workspace that cannot be claimed because something already holds it — or
 * because a marker exists that cannot be read as a holder. Carries the three
 * things a caller needs to report it: which workspace, who holds it, and since
 * when. `owner`/`since` are absent only in the unreadable-marker case, where
 * nothing on disk names a holder; the message says so instead of inventing one.
 */
export class WorkspaceBusyError extends Error {
  readonly workspace: string
  readonly owner?: WorkspaceOwner
  readonly since?: string

  constructor(workspace: string, owner: WorkspaceOwner | undefined, since: string | undefined, detail: string) {
    const held = owner === undefined
      ? `a marker exists but names no holder: ${detail}`
      : `held by ${describeOwner(owner)} since ${since ?? owner.since} — ${detail}`
    super(`workspace ${workspace} is busy: ${held}`)
    this.name = 'WorkspaceBusyError'
    this.workspace = workspace
    this.owner = owner
    this.since = since
  }
}

/**
 * What `reconcileAdopt` found. `adopted` true means the caller may start owning
 * the workspace (nothing held it, or a stale marker was cleared); `adopted` false
 * leaves every byte as it was and names why.
 */
export type WorkspaceAdoption =
  | { readonly adopted: true }
  | { readonly adopted: false; readonly reason: string }

export interface WorkspaceRegistryOptions {
  /** Where markers live (a deployment passes `<runBindingRoot>/workspace-owners`). Created on demand. */
  markerRoot: string
  /**
   * The pid this registry runs as; defaults to `process.pid`. Injected so a test
   * can stand in for another process's registry, and so a marker can be written
   * that names a pid this process is not.
   */
  pid?: number
}

/** One line naming an owner the way every diagnostic in this module names it. */
export function describeOwner(owner: WorkspaceOwner): string {
  const parts = [`kind ${owner.kind}`, `store ${owner.storeId}`]
  if (owner.taskId !== undefined) parts.push(`task ${owner.taskId}`)
  if (owner.runId !== undefined) parts.push(`run ${owner.runId}`)
  if (owner.batchId !== undefined) parts.push(`batch ${owner.batchId}`)
  return parts.join(' ')
}

/**
 * The identity of an owner as a stack compares it: every declared field, `since`
 * included. Strict on purpose — two claims by the same run at different instants
 * are two different holders, and a handover that names the run but not the
 * instant it was taken is not the holder this stack is looking at.
 */
function ownerKey(owner: WorkspaceOwner): string {
  return JSON.stringify([owner.kind, owner.storeId, owner.taskId ?? null, owner.runId ?? null, owner.batchId ?? null, owner.since])
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve a checkout path the way ownership keys it: absolute, with symbolic
 * links resolved, so the two spellings of one directory cannot become two
 * markers. Throws when the path cannot be resolved (absent, a broken link, no
 * permission) — a workspace whose identity is unknown is not a workspace this
 * module will record an owner for.
 */
export async function normalizeWorkspacePath(path: string): Promise<string> {
  try {
    return await realpath(resolvePath(path))
  } catch (error) {
    throw new Error(`workspace ${path} cannot be resolved to a real path: ${message(error)}`)
  }
}

/**
 * The kernel's start-time token for `pid`, or `undefined` when it cannot be read
 * (a non-Linux platform, a pid that is gone, a process this user may not stat).
 * Exported because it is the one honest pid-reuse check available here: compare
 * it with the value a marker recorded.
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  let stat: string
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  // The command name in field 2 is parenthesized and may itself contain spaces
  // and parentheses, so the fields after it are counted from the last ')'.
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  // Fields after ')': field 3 (state) is index 0, so starttime (field 22) is 19.
  const starttime = fields[19]
  return starttime === undefined || starttime.length === 0 ? undefined : starttime
}

/** True when `pid` is a live process this user can signal; EPERM means another user's live process, which counts as alive. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * How many marker writes this process has started; it names each write's
 * temporary file. Two chains mutate one workspace's marker at the same time in a
 * real deployment — a child's submission chain takes the verifier layer in and
 * out while the batch driver releases the child it has seen settle — and with one
 * shared temporary path the first `rename` takes the file away from the second,
 * whose release then fails with ENOENT. A counter per process rather than per
 * registry, because two registries in one process (a second graph's) write the
 * same marker path for the same workspace.
 */
let markerWriteSeq = 0

type MarkerRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'held'; marker: WorkspaceMarker }

/** Parse a marker file's bytes; anything that is not a well-formed marker is reported, never repaired. */
function parseMarker(raw: string, file: string): MarkerRead {
  let declared: unknown
  try {
    declared = JSON.parse(raw)
  } catch (error) {
    return { kind: 'unreadable', reason: `${file} is not readable JSON (${message(error)}); an unreadable marker is not evidence that a workspace is free` }
  }
  if (declared === null || typeof declared !== 'object') {
    return { kind: 'unreadable', reason: `${file} does not hold a marker object` }
  }
  const candidate = declared as Partial<WorkspaceMarker>
  if (typeof candidate.pid !== 'number' || candidate.owner === null || typeof candidate.owner !== 'object' || typeof candidate.path !== 'string') {
    return { kind: 'unreadable', reason: `${file} does not name a pid and an owner; only a human should decide what to do with it` }
  }
  const owner = candidate.owner as WorkspaceOwner
  return {
    kind: 'held',
    marker: {
      path: candidate.path,
      pid: candidate.pid,
      // A marker whose start time is not a string is read as one that recorded
      // none: the pid-reuse comparison is then simply not made, rather than made
      // against a value no `/proc` field can equal.
      ...(typeof candidate.processStartedAt === 'string' ? { processStartedAt: candidate.processStartedAt } : {}),
      owner,
      since: typeof candidate.since === 'string' ? candidate.since : owner.since,
    },
  }
}

/**
 * The in-process and on-disk ownership of a deployment's workspaces. One
 * instance per runtime; `close()` releases what this process still holds.
 */
/**
 * Release the layer on top of one workspace's stack, when `holds` says it is the
 * caller's. The comparison is the caller's own identity rule — a caller that
 * rebuilds its owner description from scratch cannot reproduce the instant a
 * layer was taken, so the registry's full-key check is not what decides here —
 * and the layer actually on top is what the registry is asked to pop, so the pop
 * can never take a stranger's.
 *
 * Returns `released: false` with the offending holder when the top is not the
 * caller's layer, and `released: false` alone when this process holds nothing:
 * the two cases mean different things, and each caller's policy decides which of
 * them is worth a diagnostic.
 */
export async function releaseLayer(
  registry: WorkspaceRegistry,
  workspace: string,
  holds: (top: WorkspaceOwner) => boolean,
): Promise<{ readonly released: boolean; readonly conflict?: WorkspaceOwner }> {
  const top = registry.ownerOf(workspace)
  if (top === undefined) return { released: false }
  if (!holds(top)) return { released: false, conflict: top }
  await registry.release(workspace, top)
  return { released: true }
}

export class WorkspaceRegistry {
  private readonly markerRoot: string
  private readonly pid: number
  private readonly stacks = new Map<string, WorkspaceOwner[]>()

  constructor(options: WorkspaceRegistryOptions) {
    this.markerRoot = options.markerRoot
    this.pid = options.pid ?? process.pid
  }

  /** Where one workspace's marker lives — derived from the path as given, so it is the same key the stack uses. */
  markerPath(workspace: string): string {
    return join(this.markerRoot, `${sha256Hex(workspace)}.json`)
  }

  /** The owner on top of the stack, or `undefined` when this process holds nothing for the workspace. */
  ownerOf(workspace: string): WorkspaceOwner | undefined {
    const held = this.stacks.get(workspace)
    return held === undefined || held.length === 0 ? undefined : held[held.length - 1]
  }

  /**
   * Take a workspace for `owner`. Refuses — before anything is written, so a
   * refused claim leaves the marker exactly as it was — when this process
   * already holds it, or when any marker is already there.
   */
  async claim(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const top = this.ownerOf(workspace)
    if (top !== undefined) {
      throw new WorkspaceBusyError(workspace, top, top.since, 'this process already holds the workspace; release the holder before claiming it again')
    }
    const read = await this.readMarker(workspace)
    if (read.kind !== 'absent') throw await this.busyFromMarker(workspace, read)
    await this.writeMarker(workspace, owner)
    this.stacks.set(workspace, [owner])
  }

  /**
   * Hand the workspace from `from` (which must be the current holder) to `to`,
   * pushing `to` on the stack and rewriting the marker to name it. The stack is
   * the ownership history: the run at the bottom keeps its claim while its batch
   * and current child are on top of it.
   */
  async push(workspace: string, from: WorkspaceOwner, to: WorkspaceOwner): Promise<void> {
    const held = this.stacks.get(workspace)
    if (held === undefined || held.length === 0) {
      throw new Error(`workspace ${workspace} cannot be handed from ${describeOwner(from)} to ${describeOwner(to)}: this process holds no claim on it`)
    }
    const top = held[held.length - 1]
    if (ownerKey(top) !== ownerKey(from)) {
      throw new Error(
        `workspace ${workspace} cannot be handed over: its current holder is ${describeOwner(top)} (since ${top.since}), not ${describeOwner(from)} (since ${from.since}); ` +
        'a handover names the holder that is actually there',
      )
    }
    held.push(to)
    await this.writeMarker(workspace, to)
  }

  /**
   * Release `owner`, which must be the current holder. A mismatch throws with
   * both owners named — popping a lower holder would hand the checkout to
   * someone while a writer still believes it holds the workspace. The last
   * release deletes the marker; an earlier one rewrites it to the new top.
   */
  async release(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const held = this.stacks.get(workspace)
    if (held === undefined || held.length === 0) {
      throw new Error(`workspace ${workspace} cannot be released by ${describeOwner(owner)} (since ${owner.since}): this process holds no claim on it`)
    }
    const top = held[held.length - 1]
    if (ownerKey(top) !== ownerKey(owner)) {
      throw new Error(
        `workspace ${workspace} cannot be released by ${describeOwner(owner)} (since ${owner.since}): ` +
        `its current holder is ${describeOwner(top)} (since ${top.since}); only the holder on top of the stack releases it`,
      )
    }
    held.pop()
    if (held.length === 0) {
      this.stacks.delete(workspace)
      await this.removeMarker(workspace)
    } else {
      await this.writeMarker(workspace, held[held.length - 1])
    }
  }

  /**
   * Take over a marker whose owning process is gone — the recovery path only,
   * and the only way a stale marker is ever cleared. An absent marker is a
   * success that changes nothing; a marker whose pid is alive, or whose bytes
   * cannot be read as a marker, is a refusal that leaves
   * everything in place, because adopting it would hand the checkout to a caller
   * while a writer that may still be running has no idea.
   */
  async reconcileAdopt(workspace: string): Promise<WorkspaceAdoption> {
    const read = await this.readMarker(workspace)
    if (read.kind === 'absent') return { adopted: true }
    if (read.kind === 'unreadable') return { adopted: false, reason: read.reason }
    const { marker } = read
    if (pidIsAlive(marker.pid)) {
      const owner = marker.pid === this.pid
        ? `the marker names this process's own pid ${marker.pid}, so no liveness probe can tell its holder apart from this process — settle this process's own claims instead`
        : `the marker names pid ${marker.pid}, which is alive${marker.processStartedAt === undefined ? '' : ` (start time ${marker.processStartedAt})`}; a live owner is never taken over, however the recovery path explains it`
      return { adopted: false, reason: `workspace ${workspace} still has a holder: ${owner}` }
    }
    this.stacks.delete(workspace)
    await this.removeMarker(workspace)
    return { adopted: true }
  }

  /**
   * Release everything this process still holds, as an unload path does. Only
   * markers that name this process's pid are deleted: a marker written by
   * another process describes a writer this unload knows nothing about, and
   * removing it could hand a checkout to the next caller while that writer runs.
   */
  async close(): Promise<void> {
    const workspaces = [...this.stacks.keys()]
    this.stacks.clear()
    for (const workspace of workspaces) {
      const read = await this.readMarker(workspace)
      if (read.kind !== 'held') continue
      if (read.marker.pid !== this.pid) continue
      await this.removeMarker(workspace)
    }
  }

  /** The busy error a marker earns: whose, why, and — when the recorded start time disagrees — that the pid was reused. */
  private async busyFromMarker(workspace: string, read: Exclude<MarkerRead, { kind: 'absent' }>): Promise<WorkspaceBusyError> {
    if (read.kind === 'unreadable') {
      return new WorkspaceBusyError(workspace, undefined, undefined, read.reason)
    }
    const { marker } = read
    if (marker.pid === this.pid) {
      return new WorkspaceBusyError(
        workspace,
        marker.owner,
        marker.since,
        `the marker at ${this.markerPath(workspace)} names this process's own pid ${marker.pid}, but this process holds no claim on the workspace; ` +
        'the in-process stack is the truth, so the marker and this process disagree and the workspace is reported busy rather than taken',
      )
    }
    if (!pidIsAlive(marker.pid)) {
      return new WorkspaceBusyError(
        workspace,
        marker.owner,
        marker.since,
        `the marker's pid ${marker.pid} is not alive, so the marker is stale; only the recovery path (reconcileAdopt) may take a stale marker over, ` +
        'because the process that wrote it may have died mid-write',
      )
    }
    const recorded = marker.processStartedAt
    const live = recorded === undefined ? undefined : await readProcessStartTime(marker.pid)
    const reused = recorded !== undefined && live !== undefined && live !== recorded
      ? `; its recorded start time ${recorded} differs from the live ${live}, so the pid was reused and the marker's writer is gone (still reported busy: only reconcileAdopt clears a marker)`
      : ''
    return new WorkspaceBusyError(
      workspace,
      marker.owner,
      marker.since,
      `the marker names pid ${marker.pid}, which is alive${reused}`,
    )
  }

  private async readMarker(workspace: string): Promise<MarkerRead> {
    const file = this.markerPath(workspace)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
      return { kind: 'unreadable', reason: `${file} cannot be read (${message(error)}); an unreadable marker is not evidence that a workspace is free` }
    }
    const read = parseMarker(raw, file)
    if (read.kind === 'held' && read.marker.path !== workspace) {
      return {
        kind: 'unreadable',
        reason: `${file} describes workspace ${read.marker.path}, not ${workspace}; the marker and this path disagree, which only a human should resolve`,
      }
    }
    return read
  }

  private async writeMarker(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const file = this.markerPath(workspace)
    const marker: WorkspaceMarker = { path: workspace, pid: this.pid, owner, since: owner.since }
    // The token describes the pid the marker names — this process, unless a test
    // injected another pid — so a reader can compare it with the live process at
    // that pid. Omitted when `/proc` cannot answer for it, which is honest: the
    // pid-reuse comparison is then simply not available for this marker.
    const startedAt = await readProcessStartTime(this.pid)
    if (startedAt !== undefined) marker.processStartedAt = startedAt
    await mkdir(dirname(file), { recursive: true })
    markerWriteSeq += 1
    const tmp = `${file}.${markerWriteSeq}.tmp`
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  private async removeMarker(workspace: string): Promise<void> {
    await rm(this.markerPath(workspace), { force: true })
  }
}
