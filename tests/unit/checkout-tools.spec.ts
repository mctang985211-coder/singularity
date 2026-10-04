import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkoutTools } from '../support/log-pipeline.ts'

// A zombie has exited; Linux may retain its process record until init reaps it.
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
  } catch {
    return false
  }
}

it.each(['cancel', 'timeout'] as const)('kills the bash process and its background child on %s', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-bash-stop-'))
  const abort = new AbortController()
  const bash = checkoutTools({ bashTimeoutMs: mode === 'timeout' ? 1_000 : 60_000 }).find(tool => tool.name === 'bash')!
  const pending = bash.execute({ command: 'sleep 30 & echo "$$ $!" > pids; wait' }, {
    agent: { session: { header: { cwd: dir } } }, signal: abort.signal,
  } as never)
  // Attach before cancellation so a prompt rejection cannot become unhandled.
  let settled = false
  const outcome = pending.then(() => undefined, error => error as Error).finally(() => { settled = true })
  let pids: number[] = []
  try {
    await vi.waitFor(() => expect(existsSync(join(dir, 'pids'))).toBe(true), { timeout: 500 })
    pids = readFileSync(join(dir, 'pids'), 'utf8').trim().split(' ').map(Number)
    expect(pids).toHaveLength(2)
    expect(pids.every(running)).toBe(true)
    if (mode === 'cancel') abort.abort()
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 })
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain(mode === 'cancel' ? 'cancelled' : 'timed out')
    await vi.waitFor(() => expect(pids.some(running)).toBe(false), { timeout: 2_000 })
  } finally {
    abort.abort()
    // A failing assertion must still leave no child alive even against a broken tool.
    if (pids.length === 0 && existsSync(join(dir, 'pids'))) {
      pids = readFileSync(join(dir, 'pids'), 'utf8').trim().split(' ').map(Number)
    }
    if (pids[0] !== undefined) {
      try { process.kill(-pids[0], 'SIGKILL') } catch { /* already gone */ }
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await outcome
    rmSync(dir, { recursive: true, force: true })
  }
}, 5_000)
