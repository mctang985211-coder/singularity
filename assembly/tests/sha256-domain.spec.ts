import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { VerifierProcess } from '../../src/verifier/command.ts'
import { loadDomain } from '../src/domain.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))
const runProcess: VerifierProcess = async () => { throw new Error('loading a declaration must not run a process') }
const domain = await loadDomain(DIR, runProcess)
const template = domain.templates.get(domain.rootTemplate)!

it('loads one RTL and one synthesis guide without prescribing an exploration workflow', async () => {
  expect((await readdir(DIR)).sort()).toEqual(['sha256.v', 'task.json', 'yosys.md'])
  expect([...domain.templates.keys()]).toEqual(['sha256-area'])
  expect(template.decomposition).toBeUndefined()
  expect(template.guidance).toBeUndefined()
  expect(template.applicability).toBeUndefined()
  expect(template.checks).toEqual([])
  expect(domain.verifiers).toEqual([])
  expect(domain.measurement).toBeUndefined()
  expect(domain.inputs.map(input => input.ref)).toEqual(['rtl', 'yosys'])
  const rtl = domain.inputs.find(input => input.ref === 'rtl')!.bytes
  expect(template.initial!.bytes).toEqual(rtl)
  expect(Buffer.from(rtl).toString('utf8').match(/^module \w+/gm))
    .toEqual(['module sha256_k_constants', 'module sha256_w_mem', 'module sha256_core'])
})

it('the documented fixed synthesis command measures the complete unchanged top baseline', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sha256-guide-'))
  try {
    await mkdir(join(work, 'rtl'))
    await writeFile(join(work, template.artifact), template.initial!.bytes)
    const guide = await readFile(join(DIR, 'yosys.md'), 'utf8')
    const command = guide.match(/```sh\n([\s\S]*?)\n```/)![1]!
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], {
      cwd: work, signal: AbortSignal.timeout(60_000), maxBuffer: 16 * 1024 * 1024,
    })
    const area = [...stdout.matchAll(/Chip area for top module '\\sha256_core': ([0-9.]+)/g)]
    expect(area).toHaveLength(1)
    expect(Number(area[0]![1])).toBeCloseTo(64858.4544, 4)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}, 65_000)
