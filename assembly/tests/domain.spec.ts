/**
 * The deployment domain: the material a criterion is admitted from, and the only source of every
 * domain string this package uses.
 *
 * The real deployment (`deployment/domain/letters`) is read here, not a fixture: the verifier digest
 * is the digest of the bytes on disk, and the selftest runs those bytes in both directions. The
 * refusals are driven from a temporary domain whose declaration is broken on purpose, one break per
 * case.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runVerifierSelftest } from '../../src/verifier/implementation.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/submission.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let scratch: string | undefined

afterEach(async () => {
  if (scratch === undefined) return
  await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

/** One temporary domain whose declaration a case can break in exactly one place. */
async function broken(task: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'assembly-domain-'))
  scratch = dir
  await mkdir(join(dir, 'samples'), { recursive: true })
  await writeFile(join(dir, 'verifier.mjs'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(dir, 'samples', 'pass.txt'), '3', 'utf8')
  await writeFile(join(dir, 'samples', 'fail.txt'), '4', 'utf8')
  const base = {
    inputs: ['in/source.txt'],
    workspace: { program: 'program.mjs', artifact: 'report.txt' },
    criteria: [{ criterionId: 'letters', statement: 'the report is the count', verifier: 'letters' }],
    verifiers: [
      {
        ref: 'letters',
        version: '1',
        program: 'verifier.mjs',
        args: ['{artifact}', '{input}'],
        selftest: [
          { name: 'true count', expected: 'pass', artifact: 'samples/pass.txt', argv: ['samples/pass.txt', 'samples/pass.txt'] },
          { name: 'wrong count', expected: 'fail', artifact: 'samples/fail.txt', argv: ['samples/fail.txt', 'samples/pass.txt'] },
        ],
      },
    ],
  }
  await writeFile(join(dir, 'task.json'), JSON.stringify({ ...base, ...(task as object) }), 'utf8')
  return dir
}

describe('the deployment domain', () => {
  it('reads every domain string from the declared file, digesting the verifier bytes', async () => {
    const domain = await loadDomain(REAL, spawnProcess)
    const declared = JSON.parse(await readFile(join(REAL, 'task.json'), 'utf8'))
    expect([domain.inputPath, domain.artifact, domain.program]).toEqual([
      declared.inputs[0],
      declared.workspace.artifact,
      declared.workspace.program,
    ])
    expect([domain.criterion.verifierRef, domain.criterion.implementationDigest]).toEqual([
      declared.verifiers[0].ref,
      sha256(await readFile(join(REAL, declared.verifiers[0].program))),
    ])
  })

  it('runs the declared samples through the real verifier in both directions', async () => {
    const domain = await loadDomain(REAL, spawnProcess)
    const report = await runVerifierSelftest(domain.verifiers[0]!)
    expect(report).toMatchObject({ ran: 2, failures: [] })
  })

  it('refuses a domain that does not declare exactly one input, by name', async () => {
    const dir = await broken({ inputs: [] })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('exactly one input')
  })

  it('refuses a criterion naming a verifier the domain does not hold', async () => {
    const dir = await broken({ criteria: [{ criterionId: 'letters', statement: 's', verifier: 'absent' }] })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('absent')
  })

  it('refuses a sample whose artifact is not the file its command reads', async () => {
    const dir = await broken({
      verifiers: [
        {
          ref: 'letters',
          version: '1',
          program: 'verifier.mjs',
          args: ['{artifact}', '{input}'],
          selftest: [
            { name: 'true count', expected: 'pass', artifact: 'samples/pass.txt', argv: ['samples/fail.txt', 'samples/pass.txt'] },
            { name: 'wrong count', expected: 'fail', artifact: 'samples/fail.txt', argv: ['samples/fail.txt', 'samples/pass.txt'] },
          ],
        },
      ],
    })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('true count')
  })

  it('refuses a command template naming a placeholder this version cannot fill', async () => {
    const dir = await broken({
      verifiers: [
        {
          ref: 'letters',
          version: '1',
          program: 'verifier.mjs',
          args: ['{artifact}', '{artifactt}'],
          selftest: [
            { name: 'true count', expected: 'pass', artifact: 'samples/pass.txt', argv: ['samples/pass.txt', 'samples/pass.txt'] },
            { name: 'wrong count', expected: 'fail', artifact: 'samples/fail.txt', argv: ['samples/fail.txt', 'samples/pass.txt'] },
          ],
        },
      ],
    })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('{artifactt}')
  })

  it('refuses a declared path that resolves outside the workspace', async () => {
    const dir = await broken({ inputs: ['../outside.txt'] })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).code).toBe('malformed-declaration')
  })
})
