/**
 * One workspace, one writer (A3 §3.4): the ownership record that stands between
 * two runs that would otherwise write into the same checkout.
 */

import { cp, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { ArtifactRef, RunId, RunPlacement, TaskId } from '@dangosys/dsh-singularity-task'
import { enqueueByKey, message } from './helpers.ts'

/** The directory under a deployment's run-binding root that holds ownership markers (§3.4). */
export const WORKSPACE_OWNERS_DIR = 'workspace-owners'

/**
 * Who holds a workspace. One shape for the three roles the protocol gives it:
 * the run that is writing, the verifier that owns the checkout exclusively
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
   */
  processStartedAt?: string
  owner: WorkspaceOwner
  /** The owner's `since`, copied here so the marker reads on its own. */
  since: string
}

/**
 * A workspace that cannot be claimed because something already holds it — or
 * because a marker exists that cannot be read as a holder. Carries the three
 */
export class WorkspaceBusyError extends Error {
  readonly workspace: string
  readonly owner?: WorkspaceOwner
  readonly since?: string

  constructor(workspace: string, owner: WorkspaceOwner | undefined, since: string | undefined, detail: string) {
    const held =
      owner === undefined
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
 */
type WorkspaceAdoption = { readonly adopted: true } | { readonly adopted: false; readonly reason: string }

interface WorkspaceRegistryOptions {
  /** Where markers live (a deployment passes `<runBindingRoot>/workspace-owners`). Created on demand. */
  markerRoot: string
  /**
   * The pid this registry runs as; defaults to `process.pid`. Injected so a test
   * can stand in for another process's registry, and so a marker can be written
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
 */
function ownerKey(owner: WorkspaceOwner): string {
  return JSON.stringify([
    owner.kind,
    owner.storeId,
    owner.taskId ?? null,
    owner.runId ?? null,
    owner.batchId ?? null,
    owner.since,
  ])
}

/**
 * Resolve a checkout path the way ownership keys it: absolute, with symbolic
 * links resolved, so the two spellings of one directory cannot become two
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
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
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
 */
let markerWriteSeq = 0

type MarkerRead =
  { kind: 'absent' } | { kind: 'unreadable'; reason: string } | { kind: 'held'; marker: WorkspaceMarker }

/** Parse a marker file's bytes; anything that is not a well-formed marker is reported, never repaired. */
function parseMarker(raw: string, file: string): MarkerRead {
  let declared: unknown
  try {
    declared = JSON.parse(raw)
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `${file} is not readable JSON (${message(error)}); an unreadable marker is not evidence that a workspace is free`,
    }
  }
  if (declared === null || typeof declared !== 'object') {
    return { kind: 'unreadable', reason: `${file} does not hold a marker object` }
  }
  const candidate = declared as Partial<WorkspaceMarker>
  if (
    typeof candidate.pid !== 'number' ||
    candidate.owner === null ||
    typeof candidate.owner !== 'object' ||
    typeof candidate.path !== 'string'
  ) {
    return {
      kind: 'unreadable',
      reason: `${file} does not name a pid and an owner; only a human should decide what to do with it`,
    }
  }
  const owner = candidate.owner as WorkspaceOwner
  return {
    kind: 'held',
    marker: {
      path: candidate.path,
      pid: candidate.pid,
      /**
       * A marker whose start time is not a string is read as one that recorded
       * none: the pid-reuse comparison is then simply not made, rather than made
       */
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
  /**
   * One marker-mutation chain per workspace: every write and delete joins the
   * tail of its workspace's chain, so overlapping mutations of one marker land
   */
  private readonly markerWrites = new Map<string, Promise<void>>()

  constructor(options: WorkspaceRegistryOptions) {
    this.markerRoot = options.markerRoot
    this.pid = options.pid ?? process.pid
  }

  /** Queue one marker mutation after the ones this workspace already has in flight, in call order. */
  private queueMarkerMutation(workspace: string, mutate: () => Promise<void>): Promise<void> {
    return enqueueByKey(this.markerWrites, workspace, mutate)
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
   */
  async claim(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const top = this.ownerOf(workspace)
    if (top !== undefined) {
      throw new WorkspaceBusyError(
        workspace,
        top,
        top.since,
        'this process already holds the workspace; release the holder before claiming it again',
      )
    }
    const read = await this.readMarker(workspace)
    if (read.kind !== 'absent') throw await this.busyFromMarker(workspace, read)
    await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, owner))
    this.stacks.set(workspace, [owner])
  }

  /**
   * Hand the workspace from `from` (which must be the current holder) to `to`,
   * pushing `to` on the stack and rewriting the marker to name it. The stack is
   */
  async push(workspace: string, from: WorkspaceOwner, to: WorkspaceOwner): Promise<void> {
    const held = this.stacks.get(workspace)
    if (held === undefined || held.length === 0) {
      throw new Error(
        `workspace ${workspace} cannot be handed from ${describeOwner(from)} to ${describeOwner(to)}: this process holds no claim on it`,
      )
    }
    const top = held[held.length - 1]
    if (ownerKey(top) !== ownerKey(from)) {
      throw new Error(
        `workspace ${workspace} cannot be handed over: its current holder is ${describeOwner(top)} (since ${top.since}), not ${describeOwner(from)} (since ${from.since}); ` +
          'a handover names the holder that is actually there',
      )
    }
    held.push(to)
    await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, to))
  }

  /**
   * Release `owner`, which must be the current holder. A mismatch throws with
   * both owners named — popping a lower holder would hand the checkout to
   */
  async release(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const held = this.stacks.get(workspace)
    if (held === undefined || held.length === 0) {
      throw new Error(
        `workspace ${workspace} cannot be released by ${describeOwner(owner)} (since ${owner.since}): this process holds no claim on it`,
      )
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
      await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace))
    } else {
      /**
       * The owner this release leaves behind is captured here, where the stack
       * has just said it — a mutation that ran later would read whatever holder
       */
      const remaining = held[held.length - 1]!
      await this.queueMarkerMutation(workspace, () => this.writeMarker(workspace, remaining))
    }
  }

  /**
   * Take over a marker whose owning process is gone — the recovery path only,
   * and the only way a stale marker is ever cleared. An absent marker is a
   */
  async reconcileAdopt(workspace: string): Promise<WorkspaceAdoption> {
    const read = await this.readMarker(workspace)
    if (read.kind === 'absent') return { adopted: true }
    if (read.kind === 'unreadable') return { adopted: false, reason: read.reason }
    const { marker } = read
    if (pidIsAlive(marker.pid)) {
      const owner =
        marker.pid === this.pid
          ? `the marker names this process's own pid ${marker.pid}, so no liveness probe can tell its holder apart from this process — settle this process's own claims instead`
          : `the marker names pid ${marker.pid}, which is alive${marker.processStartedAt === undefined ? '' : ` (start time ${marker.processStartedAt})`}; a live owner is never taken over, however the recovery path explains it`
      return { adopted: false, reason: `workspace ${workspace} still has a holder: ${owner}` }
    }
    this.stacks.delete(workspace)
    await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace))
    return { adopted: true }
  }

  /**
   * Release everything this process still holds, as an unload path does. Only
   * markers that name this process's pid are deleted: a marker written by
   */
  async close(): Promise<void> {
    const workspaces = [...this.stacks.keys()]
    this.stacks.clear()
    for (const workspace of workspaces) {
      const read = await this.readMarker(workspace)
      if (read.kind !== 'held') continue
      if (read.marker.pid !== this.pid) continue
      await this.queueMarkerMutation(workspace, () => this.removeMarker(workspace))
    }
  }

  /** The busy error a marker earns: whose, why, and — when the recorded start time disagrees — that the pid was reused. */
  private async busyFromMarker(
    workspace: string,
    read: Exclude<MarkerRead, { kind: 'absent' }>,
  ): Promise<WorkspaceBusyError> {
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
    const reused =
      recorded !== undefined && live !== undefined && live !== recorded
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
      return {
        kind: 'unreadable',
        reason: `${file} cannot be read (${message(error)}); an unreadable marker is not evidence that a workspace is free`,
      }
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
    /**
     * The token describes the pid the marker names — this process, unless a test
     * injected another pid — so a reader can compare it with the live process at
     */
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


interface WorkspaceFile { path: string; sha256: string }
interface WorkspacePatch { files: { path: string; sha256: string | null }[] }

/** Content identity of a local workspace snapshot. */
async function workspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = []
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git' || name === '.singularity-results') continue
      const path = join(directory, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) await walk(path)
      else if (stat.isSymbolicLink()) files.push({ path: relative(root, path), sha256: sha256Hex(`symlink:${await readlink(path)}`) })
      else if (stat.isFile()) files.push({ path: relative(root, path), sha256: sha256Hex(await readFile(path)) })
      else throw new Error(`task-runtime: isolated workspace contains unsupported file ${path}`)
    }
  }
  await walk(root)
  return files
}

export async function prepareChildWorkspace(
  root: string, source: string, storeId: string, batchId: string, runId: string,
  dependencyArtifacts: readonly ArtifactRef[], dependencyEvidenceRefs: string[],
): Promise<RunPlacement> {
  const batchRoot = join(root, 'child-workspaces', sha256Hex(storeId), sha256Hex(batchId))
  const inputSnapshotPath = join(batchRoot, 'input')
  const manifestPath = join(batchRoot, 'input.json')
  let input: WorkspaceFile[]
  try { input = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkspaceFile[] }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(batchRoot, { recursive: true })
    const bindingRoot = resolvePath(root)
    await cp(source, inputSnapshotPath, {
      recursive: true, errorOnExist: true, force: false,
      filter: async path => {
        if (basename(path) === '.git' || basename(path) === '.singularity-results') return false
        // Runtime state is outside the input contract, even when DSH_HOME sits under the checkout.
        const absolute = resolvePath(path)
        if (absolute !== resolvePath(source) && (absolute === bindingRoot || bindingRoot.startsWith(absolute + sep))) return false
        return true
      },
    })
    input = await workspaceFiles(inputSnapshotPath)
    await writeFile(manifestPath, JSON.stringify(input))
  }
  const actual = await workspaceFiles(inputSnapshotPath)
  if (JSON.stringify(actual) !== JSON.stringify(input)) throw new Error('task-runtime: isolated input snapshot changed')
  const workspacePath = join(batchRoot, runId, 'workspace')
  await cp(inputSnapshotPath, workspacePath, { recursive: true, errorOnExist: true, force: false })
  const applied = new Map<string, string | null>()
  for (const artifact of dependencyArtifacts) {
    const raw = await readFile(artifact.uri)
    if (artifact.digest !== sha256Hex(raw)) throw new Error(`task-runtime: dependency patch ${artifact.artifactId} changed`)
    const patch = JSON.parse(raw.toString('utf8')) as WorkspacePatch
    for (const file of patch.files) {
      if (isAbsolute(file.path) || file.path.split(sep).includes('..')) throw new Error(`task-runtime: invalid dependency patch path ${file.path}`)
      if (applied.has(file.path) && applied.get(file.path) !== file.sha256) throw new Error(`task-runtime: dependency patches conflict at ${file.path}; an integration task must resolve them`)
      applied.set(file.path, file.sha256)
      const target = join(workspacePath, file.path)
      if (file.sha256 === null) await rm(target, { force: true })
      else {
        const payload = join(dirname(artifact.uri), 'files', file.path)
        if (sha256Hex(await readFile(payload)) !== file.sha256) throw new Error(`task-runtime: dependency patch file ${file.path} changed`)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(payload, target)
      }
    }
  }
  return { workspacePath, inputSnapshotPath, inputSnapshotDigest: sha256Hex(JSON.stringify(input)), dependencyEvidenceRefs }
}

/** A verified child's output is handed off as an immutable, digest-bound patch; it never overwrites the parent. */
export async function captureWorkspacePatch(placement: RunPlacement, runId: RunId): Promise<ArtifactRef> {
  const input = await workspaceFiles(placement.inputSnapshotPath)
  if (sha256Hex(JSON.stringify(input)) !== placement.inputSnapshotDigest) throw new Error('task-runtime: isolated input snapshot changed')
  const output = await workspaceFiles(placement.workspacePath)
  const before = new Map(input.map(file => [file.path, file.sha256]))
  const after = new Map(output.map(file => [file.path, file.sha256]))
  const patch: WorkspacePatch = { files: [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(path => before.get(path) !== after.get(path)).map(path => ({ path, sha256: after.get(path) ?? null })) }
  const resultRoot = join(dirname(placement.workspacePath), 'result')
  const uri = join(resultRoot, 'patch.json')
  const bytes = JSON.stringify(patch)
  const artifact = { artifactId: `workspace-patch:${runId}`, kind: 'workspace-patch', uri, digest: sha256Hex(bytes) }
  let prior: string | undefined
  try { prior = await readFile(uri, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (prior !== undefined) {
    if (prior !== bytes) throw new Error(`task-runtime: resumed output patch for ${runId} differs from its recorded bytes`)
    for (const file of patch.files) {
      if (file.sha256 !== null && sha256Hex(await readFile(join(resultRoot, 'files', file.path))) !== file.sha256)
        throw new Error(`task-runtime: recorded output file ${file.path} changed`)
    }
    return artifact
  }
  await mkdir(resultRoot, { recursive: true })
  for (const file of patch.files) {
    if (file.sha256 === null) continue
    const target = join(resultRoot, 'files', file.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(placement.workspacePath, file.path), target)
  }
  await writeFile(uri, bytes, { flag: 'wx' })
  return artifact
}
