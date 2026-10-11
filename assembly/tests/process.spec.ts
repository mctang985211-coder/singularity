import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'

import { spawnProcess } from '../src/process.ts'

it('does not finish cancellation before the actual process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assembly-process-'))
  const ready = join(root, 'ready')
  const controller = new AbortController()
  const code = `import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
    writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 100);`
  let pid: number | undefined
  try {
    const pending = spawnProcess({ shell: false, argv: [process.execPath, '--input-type=module', '-e', code] }, controller.signal)
    await vi.waitFor(() => access(ready))
    pid = Number(await readFile(ready, 'utf8'))
    controller.abort(new Error('unloading'))
    expect(await pending).toMatchObject({ exitCode: null, failure: expect.any(String) })
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('does not leave a descendant writing after its submitted process finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assembly-descendant-'))
  const marker = join(root, 'late-write')
  const child = `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'late'), 250)`
  const parent = `import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); child.unref();`
  try {
    expect(await spawnProcess({ shell: false, argv: [process.execPath, '--input-type=module', '-e', parent] })).toMatchObject({ exitCode: 0 })
    await setTimeout(400)
    await expect(access(marker)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
