import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const runner = fileURLToPath(new URL('../scripts/verify-domain.mjs', import.meta.url))
const deploy = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url))
const temporary: string[] = []
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('requires an explicit domain and reports an absent verification entry as skipped', async () => {
  await expect(execute(process.execPath, [runner])).rejects.toMatchObject({ code: 1 })
  const dir = await mkdtemp(join(tmpdir(), 'domain-entry-')); temporary.push(dir)
  expect((await execute(process.execPath, [runner, dir])).stdout).toContain('SKIP domain verification:')
})

it('executes the selected package in its own directory and preserves verification failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'domain-entry-')); temporary.push(dir)
  await writeFile(join(dir, 'verify.mjs'), 'console.log(process.cwd()); process.exitCode = 7\n')
  await expect(execute(process.execPath, [runner, dir])).rejects.toMatchObject({ code: 7, stdout: dir + '\n' })
})

it('refuses deployment without an explicit domain before materialising a profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'domain-deploy-')); temporary.push(dir)
  await expect(execute(process.execPath, [deploy], {
    env: { ...process.env, DSH_HOME: dir, SINGULARITY_DOMAIN: '' },
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SINGULARITY_DOMAIN must name') })
})
