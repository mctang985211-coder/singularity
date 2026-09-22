import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex } from '../../../task/src/index.ts'
import { normalizeWorkspacePath, readProcessStartTime, WorkspaceBusyError, WorkspaceRegistry, WORKSPACE_OWNERS_DIR } from '../../src/workspace.ts'
import type { WorkspaceOwner } from '../../src/workspace.ts'

/**
 * Workspace ownership as it is actually used: a real tmp checkout, real marker
 * files, and assertions on the bytes on disk. The two things these tests are
 * about are (a) that a refused claim changes nothing — no marker write, no stack
 * push — and (b) that a marker is only ever taken over by `reconcileAdopt`, never
 * by a normal claim.
 *
 * The one boundary not exercised here is the EPERM liveness path
 * (`process.kill(pid, 0)` on another user's live process counts as alive): it
 * cannot be constructed from a test without a second user on the machine, so it
 * is the EPERM branch of `pidIsAlive` — an explicit rule, not a default.
 */

let workspace: string
let markerRoot: string
let checkout: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'workspace-ownership-'))
  // The deployment's own layout: markers live under the run-binding root, in
  // `workspace-owners/`.
  markerRoot = join(workspace, WORKSPACE_OWNERS_DIR)
  checkout = join(workspace, 'env')
  await mkdir(checkout, { recursive: true })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function registry(pid?: number): WorkspaceRegistry {
  return new WorkspaceRegistry(pid === undefined ? { markerRoot } : { markerRoot, pid })
}

function runOwner(taskId = 't-1', runId = 'r-1', since = '2026-09-22T00:00:00.000Z'): WorkspaceOwner {
  return { kind: 'run', storeId: 'sg-t-root', taskId, runId, since }
}

function batchOwner(since = '2026-09-22T00:00:01.000Z'): WorkspaceOwner {
  return { kind: 'batch', storeId: 'sg-t-root', batchId: 'b-t-1', since }
}

function verifierOwner(since = '2026-09-22T00:00:02.000Z'): WorkspaceOwner {
  return { kind: 'verifier', storeId: 'sg-t-root', taskId: 't-1', runId: 'r-2', since }
}

async function markerText(reg: WorkspaceRegistry): Promise<string> {
  return readFile(reg.markerPath(checkout), 'utf8')
}

async function markerExists(): Promise<boolean> {
  return readdir(markerRoot).then(entries => entries.includes(`${sha256Hex(checkout)}.json`), () => false)
}

/** A pid that is certainly not alive: a child of this test that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid as number
  await new Promise<void>(resolve => child.once('close', () => { resolve() }))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`child ${pid} is still signalable after exiting`)
}

/** A live process that is not this one, so a marker can name a real foreign pid. */
async function liveChild(): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000)'], { stdio: 'ignore' })
  const pid = child.pid as number
  return { pid, stop: () => { child.kill('SIGKILL') } }
}

/** Write a marker by hand, the shape a killed process would have left behind. */
async function writeRawMarker(reg: WorkspaceRegistry, contents: unknown | string, path = checkout): Promise<void> {
  await mkdir(markerRoot, { recursive: true })
  const body = typeof contents === 'string' ? contents : JSON.stringify(contents)
  await writeFile(reg.markerPath(path), body, 'utf8')
}

describe('normalizeWorkspacePath', () => {
  test('resolves symbolic links to the real directory and absolutizes', async () => {
    const link = join(workspace, 'env-link')
    await symlink(checkout, link)
    const real = await realpath(checkout)
    expect(await normalizeWorkspacePath(link)).toBe(real)
    expect(await normalizeWorkspacePath(join(checkout, '..', 'env'))).toBe(real)
  })

  test('throws, naming the path, when it cannot be resolved', async () => {
    await expect(normalizeWorkspacePath(join(workspace, 'absent'))).rejects.toThrow(/cannot be resolved to a real path/)
  })
})

describe('WorkspaceRegistry claim and the marker file', () => {
  test('writes one marker under sha256(path).json naming the owner, this pid and the start time', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    const marker = JSON.parse(await markerText(reg)) as Record<string, unknown>
    expect(reg.markerPath(checkout)).toBe(join(markerRoot, `${sha256Hex(checkout)}.json`))
    expect(marker.path).toBe(checkout)
    expect(marker.pid).toBe(process.pid)
    expect(marker.since).toBe('2026-09-22T00:00:00.000Z')
    expect(marker.owner).toEqual(runOwner())
    if (process.platform === 'linux') {
      // Read for pid-reuse comparison; the marker carries the kernel's own token.
      expect(await readProcessStartTime(process.pid)).toBe(marker.processStartedAt)
    }
    expect(reg.ownerOf(checkout)).toEqual(runOwner())
    expect(await markerExists()).toBe(true)
  })

  test('a second claim in the same process is busy and leaves the marker bytes untouched', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    const before = await markerText(reg)
    await expect(reg.claim(checkout, verifierOwner())).rejects.toBeInstanceOf(WorkspaceBusyError)
    await expect(reg.claim(checkout, verifierOwner())).rejects.toThrow(/already holds the workspace/)
    expect(await markerText(reg)).toBe(before)
  })

  test('a marker naming this process while the stack is empty is busy, not taken over', async () => {
    const writer = registry()
    await writer.claim(checkout, runOwner())
    const reader = registry()
    expect(reader.ownerOf(checkout)).toBeUndefined()
    const error = await reader.claim(checkout, verifierOwner()).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(WorkspaceBusyError)
    const busy = error as WorkspaceBusyError
    expect(busy.workspace).toBe(checkout)
    expect(busy.owner).toEqual(runOwner())
    expect(busy.since).toBe('2026-09-22T00:00:00.000Z')
    expect(busy.message).toContain(checkout)
    expect(busy.message).toContain('sg-t-root')
    expect(busy.message).toContain('2026-09-22T00:00:00.000Z')
    expect(busy.message).toContain('names this process')
    const adoption = await reader.reconcileAdopt(checkout)
    expect(adoption).toEqual({ adopted: false, reason: expect.stringContaining('still has a holder') })
  })
})

describe('WorkspaceRegistry stack', () => {
  test('push and release keep the top in step with the marker', async () => {
    const reg = registry()
    const run = runOwner()
    const batch = batchOwner()
    const verifier = verifierOwner()
    await reg.claim(checkout, run)
    await reg.push(checkout, run, batch)
    await reg.push(checkout, batch, verifier)
    expect(reg.ownerOf(checkout)).toEqual(verifier)
    expect((JSON.parse(await markerText(reg)) as { owner: WorkspaceOwner }).owner).toEqual(verifier)

    await reg.release(checkout, verifier)
    expect(reg.ownerOf(checkout)).toEqual(batch)
    expect((JSON.parse(await markerText(reg)) as { owner: WorkspaceOwner }).owner).toEqual(batch)

    await reg.release(checkout, batch)
    expect(reg.ownerOf(checkout)).toEqual(run)
    await reg.release(checkout, run)
    expect(reg.ownerOf(checkout)).toBeUndefined()
    expect(await markerExists()).toBe(false)
  })

  test('releasing an owner that is not on top throws and changes nothing', async () => {
    const reg = registry()
    const run = runOwner()
    const batch = batchOwner()
    await reg.claim(checkout, run)
    await reg.push(checkout, run, batch)
    const before = await markerText(reg)
    await expect(reg.release(checkout, run)).rejects.toThrow(/only the holder on top of the stack releases it/)
    expect(reg.ownerOf(checkout)).toEqual(batch)
    expect(await markerText(reg)).toBe(before)
  })

  test('handing over from an owner that is not the holder throws and changes nothing', async () => {
    const reg = registry()
    const run = runOwner()
    await reg.claim(checkout, run)
    const before = await markerText(reg)
    await expect(reg.push(checkout, verifierOwner(), batchOwner())).rejects.toThrow(/a handover names the holder that is actually there/)
    expect(reg.ownerOf(checkout)).toEqual(run)
    expect(await markerText(reg)).toBe(before)
    await expect(reg.release(checkout, verifierOwner())).rejects.toThrow(/only the holder on top of the stack releases it/)
  })

  test('releasing a workspace this process never claimed throws', async () => {
    await expect(registry().release(checkout, runOwner())).rejects.toThrow(/holds no claim on it/)
    await expect(registry().push(checkout, runOwner(), batchOwner())).rejects.toThrow(/holds no claim on it/)
  })
})

describe('stale markers', () => {
  test('a dead pid makes the claim busy, and only reconcileAdopt takes it over', async () => {
    const reg = registry()
    const previous = runOwner()
    await writeRawMarker(reg, { path: checkout, pid: await deadPid(), owner: previous, since: previous.since })

    const busy = await reg.claim(checkout, verifierOwner()).catch((thrown: unknown) => thrown)
    expect(busy).toBeInstanceOf(WorkspaceBusyError)
    expect((busy as WorkspaceBusyError).message).toContain('is not alive, so the marker is stale')
    expect((busy as WorkspaceBusyError).message).toContain('reconcileAdopt')
    expect(reg.ownerOf(checkout)).toBeUndefined()

    const adoption = await reg.reconcileAdopt(checkout)
    expect(adoption).toEqual({ adopted: true })
    expect(await markerExists()).toBe(false)
    await reg.claim(checkout, verifierOwner())
    expect(reg.ownerOf(checkout)).toEqual(verifierOwner())
  })

  test('a pid that cannot be alive is stale by the same rule', async () => {
    const reg = registry()
    const previous = batchOwner()
    await writeRawMarker(reg, { path: checkout, pid: 2 ** 31 - 2, owner: previous, since: previous.since })
    await expect(reg.claim(checkout, verifierOwner())).rejects.toThrow(/is not alive, so the marker is stale/)
    expect(await reg.reconcileAdopt(checkout)).toEqual({ adopted: true })
  })

  test('an adopted workspace with no marker at all changes nothing', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    const other = join(workspace, 'env2')
    await mkdir(other, { recursive: true })
    expect(await reg.reconcileAdopt(other)).toEqual({ adopted: true })
    expect(reg.ownerOf(checkout)).toEqual(runOwner())
  })

  test('a marker written by another pid is stale once that pid is gone, and is only taken over by reconcileAdopt', async () => {
    const gone = await deadPid()
    const writer = registry(gone)
    await writer.claim(checkout, runOwner())
    const reader = registry()
    await expect(reader.claim(checkout, verifierOwner())).rejects.toThrow(new RegExp(`pid ${gone} is not alive`))
    expect(await reader.reconcileAdopt(checkout)).toEqual({ adopted: true })
  })

  test('an unreadable marker is busy with no owner named, and is never adopted', async () => {
    const reg = registry()
    await writeRawMarker(reg, '{ this is not json')
    const busy = await reg.claim(checkout, runOwner()).catch((thrown: unknown) => thrown)
    expect(busy).toBeInstanceOf(WorkspaceBusyError)
    expect((busy as WorkspaceBusyError).owner).toBeUndefined()
    expect((busy as WorkspaceBusyError).since).toBeUndefined()
    expect((busy as WorkspaceBusyError).message).toContain('names no holder')
    expect((busy as WorkspaceBusyError).message).toMatch(/not readable JSON/)
    const adoption = await reg.reconcileAdopt(checkout)
    expect(adoption.adopted).toBe(false)
    expect(await markerExists()).toBe(true)
  })

  test('a marker whose path disagrees with the claimed workspace is refused', async () => {
    const reg = registry()
    const other = join(workspace, 'env2')
    await mkdir(other, { recursive: true })
    await writeRawMarker(reg, { path: other, pid: await deadPid(), owner: runOwner(), since: runOwner().since })
    await expect(reg.claim(checkout, verifierOwner())).rejects.toThrow(/describes workspace/)
    expect((await reg.reconcileAdopt(checkout)).adopted).toBe(false)
  })
})

describe('live foreign markers', () => {
  test('a marker naming a live foreign pid is busy, and reports a reused pid when the start times disagree', async () => {
    const child = await liveChild()
    try {
      const reg = registry()
      const previous = runOwner()
      const recorded = await readProcessStartTime(child.pid)
      await writeRawMarker(reg, { path: checkout, pid: child.pid, processStartedAt: recorded, owner: previous, since: previous.since })
      const busy = await reg.claim(checkout, verifierOwner()).catch((thrown: unknown) => thrown)
      expect(busy).toBeInstanceOf(WorkspaceBusyError)
      expect((busy as WorkspaceBusyError).message).toContain(`names pid ${child.pid}, which is alive`)
      expect((busy as WorkspaceBusyError).message).not.toContain('the pid was reused')
      expect((await reg.reconcileAdopt(checkout)).adopted).toBe(false)

      // The pid is live, but the process answering to it did not write this
      // marker: the recorded start time says so, and the reason names it. The
      // rule is unchanged — a live pid is never adopted.
      await writeRawMarker(reg, { path: checkout, pid: child.pid, processStartedAt: '1', owner: previous, since: previous.since })
      const reused = await reg.claim(checkout, verifierOwner()).catch((thrown: unknown) => thrown)
      const text = (reused as WorkspaceBusyError).message
      if (recorded !== undefined) expect(text).toContain('the pid was reused')
      expect((await reg.reconcileAdopt(checkout)).adopted).toBe(false)
      expect(await markerExists()).toBe(true)
    } finally {
      child.stop()
    }
  })
})

describe('close', () => {
  test('releases the markers this process holds and forgets the stacks', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    const other = join(workspace, 'env2')
    await mkdir(other, { recursive: true })
    await reg.claim(other, batchOwner())
    await reg.close()
    expect(reg.ownerOf(checkout)).toBeUndefined()
    expect(reg.ownerOf(other)).toBeUndefined()
    expect(await readdir(markerRoot)).toEqual([])
  })

  test('leaves a marker another process wrote in its place alone', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    // A foreign process overwrote the marker after this one claimed: the marker
    // no longer names this process, so the unload path must not delete it.
    const stranger = runOwner('t-9', 'r-9', '2026-09-22T00:00:09.000Z')
    await writeRawMarker(reg, { path: checkout, pid: await deadPid(), owner: stranger, since: stranger.since })
    await reg.close()
    expect(reg.ownerOf(checkout)).toBeUndefined()
    expect(await markerExists()).toBe(true)
    expect((JSON.parse(await markerText(reg)) as { owner: WorkspaceOwner }).owner).toEqual(stranger)
  })

  test('close is idempotent and leaves nothing behind for a second call', async () => {
    const reg = registry()
    await reg.claim(checkout, runOwner())
    await reg.close()
    await reg.close()
    expect(await markerExists()).toBe(false)
  })
})
