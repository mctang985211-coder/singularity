import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { VerifierProcess } from '../../src/verifier/command.ts'
import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))
const SEED_DIGEST = '0b4de636364625e34e771bb26363d24f4a4bcae6579d0f8cd3e86d7e5c14354a'
const runProcess: VerifierProcess = async () => { throw new Error('loading a declaration must not run a process') }
const domain = await loadDomain(DIR, runProcess)
const template = domain.templates.get(domain.rootTemplate)!

it('binds the SHA256 schedule template to its independent functional verifier', () => {
  expect(template.criterion).toMatchObject({ criterionId: 'w-schedule', verifierRef: 'functional',
    implementationDigest: template.verifier.implementationDigest })
  expect(domain.verifiers.map(verifier => verifier.ref)).toEqual(['functional'])
})

it('starts the source template at the upstream module bytes and judges the submitted source itself', () => {
  expect([template.submission, template.file, template.artifact, sha256(template.initial!.bytes)])
    .toEqual(['source', 'rtl/sha256_w_mem.v', 'rtl/sha256_w_mem.v', SEED_DIGEST])
})

it('binds the protected testbench bytes and destination to the functional verifier sample', () => {
  const source = template.input.source
  expect(source).toEqual({ kind: 'protected', ref: 'testbench' })
  const input = domain.inputs.find(input => input.ref === 'testbench')!
  expect(template.verifier.selftest.samples[0]!.input.inputs).toEqual([{ name: template.input.name, digest: input.digest }])
  expect(template.input.name).toBe('tb/tb_sha256_w_mem_selfcheck.v')
})
