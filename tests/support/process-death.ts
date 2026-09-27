/**
 * A **real process death**, as a test base: the child process that performs the
 * work is killed inside it, and the process that reads what it left is a
 * different process image that never held that state in memory.
 *
 * What this exists for, and why the in-process seams cannot stand in for it. The
 * commit/`jobs`/`store` probes a fixture can throw from are *catchable*: the throw
 * unwinds through the live process's own `catch` and `finally`, its staging files
 * are cleaned up, its in-memory services survive, and the next call runs in the
 * same image with all of it still there. A kill has none of that — no `catch`, no
 * `finally`, no cleanup of the stage it died in, and no memory at all — which is
 * the state a killed deployment really leaves (`k2-evolution-commit.spec.ts`'s
 * real-exit cases state the difference for the commit windows; this module is the
 * same discipline, generalized so the recovery windows can use it too).
 *
 * How a child is started: a nested `vitest` run of the *spec file that spawned
 * it*, filtered to that file's one child case. Two details make the signal the
 * parent observes the case body's own:
 *
 * - `--pool=threads` — the case body then runs in the process `spawnSync`
 *   started, not in a worker beside it, so `child.pid` is the pid the death's
 *   marker names;
 * - `-t <case name>` — keeps every parent case (this spawner included) out of the
 *   nested run, so a child cannot spawn a child.
 *
 * The child is told what to do by environment variables only (its spec file reads
 * them), it writes a marker file naming its own pid and the boundary it reached
 * *before* it dies, and it kills itself with `SIGKILL`. The parent then asserts
 * the death itself — a signal, no exit code, the marker's pid equal to the pid
 * `spawnSync` started, and that pid gone — before it asserts anything about the
 * durable state. Reading the state is a *boot* in the parent: a second deployment
 * over the same directory, reading the files off disk and nothing else.
 *
 * No production source carries a crash hook: the armed boundary is a value in the
 * child's own environment, and the probe that answers it lives in the spec's
 * child case.
 * @module tests/support/process-death
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

/** The repo root a nested run starts from — the same `vitest` the outer run is, without a wrapper. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The vitest entry a nested run is started with. */
export const VITEST_BIN = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs')

/** One nested run of a spec file's own child case, armed by environment. */
export interface ChildDeathPlan {
  /** The spec file the child case lives in — the file that spawned it. */
  readonly specPath: string
  /** The child case's own name (the nested run is filtered to it). */
  readonly caseName: string
  /** The directory both images share: the child's durable state, the parent's to read. */
  readonly workspace: string
  /** Environment variables the child case reads to know its boundary (and its workspace). */
  readonly env: Readonly<Record<string, string>>
  /** Bound on a child that hangs, so the parent's case fails loudly instead of stalling. */
  readonly timeoutMs?: number
}

/**
 * Start the child and wait for it: it boots over {@link ChildDeathPlan.workspace},
 * drives to its boundary and kills itself there. The returned result is the nested
 * run's own — a death by signal, which {@link assertRealDeath} checks is one.
 */
export function spawnSelfChild(plan: ChildDeathPlan): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [
    VITEST_BIN,
    'run',
    '--project', 'integration',
    '--pool=threads',
    plan.specPath,
    '-t', plan.caseName,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: plan.timeoutMs ?? 120_000,
    env: { ...process.env, ...plan.env, A6_CHILD_WORKSPACE: plan.workspace },
  })
}

/** What a child's marker file says: which image died, and the boundary it died at. */
export interface DeathMarker {
  /** The child's own pid — the process image that did the work and is gone. */
  readonly pid: number
  /** The boundary the child reached and died at, as the child itself named it. */
  readonly boundary: string
  /** Anything else the case recorded before dying (run ids, batch ids, counts). */
  readonly [key: string]: unknown
}

/** Read a child's marker file, written before the death. */
export async function readMarker<T extends DeathMarker = DeathMarker>(workspace: string, markerFile: string): Promise<T> {
  return JSON.parse(await readFile(join(workspace, markerFile), 'utf8')) as T
}

/**
 * The death itself, asserted before anything about the durable state: the nested
 * run answered a *signal* (no exit code, no normal unwind), the marker names a
 * pid that is not the reader's and is the one `spawnSync` started, and that pid is
 * gone. An in-process throw looks like none of this.
 */
export async function assertRealDeath<T extends DeathMarker = DeathMarker>(
  workspace: string,
  markerFile: string,
  child: SpawnSyncReturns<string>,
): Promise<T> {
  const transcript = `nested run status ${String(child.status)}, signal ${String(child.signal)}, error ${String(child.error)}\n${child.stdout}\n${child.stderr}`
  expect(child.signal, `the nested run exited instead of being killed by its own boundary — ${transcript}`).toBe('SIGKILL')
  expect(child.status, `a killed process has no exit code — ${transcript}`).toBeNull()
  const marker = await readMarker<T>(workspace, markerFile)
  expect(marker.pid, 'the marker must name the process image that did the work, not the reader').not.toBe(process.pid)
  expect(marker.pid).toBe(child.pid)
  expect(pidProbe(marker.pid)).toBe('ESRCH')
  return marker
}

/** What the null probe to a pid answered: `undefined` when it exists, `ESRCH` when it is gone. */
export function pidProbe(pid: number): string | undefined {
  try {
    process.kill(pid, 0)
    return undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

/**
 * Kill this process where it stands — the child case's own last act, and the one
 * thing an in-process probe cannot imitate. Nothing after it runs: no `catch`, no
 * `finally`, no flush, no close, no descriptor released by a handler. Only the
 * kernel's own teardown happens, exactly as when a deployment is killed.
 */
export function dieHere(boundary: string): never {
  process.kill(process.pid, 'SIGKILL')
  throw new Error(`the SIGKILL at "${boundary}" did not end this process`)
}
