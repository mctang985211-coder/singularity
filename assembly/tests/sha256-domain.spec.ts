/**
 * The sha256 domain as a declaration: the criterion a run is judged against, the metric measured
 * beside it, and the seed a source submission starts from.
 *
 * The declaration is the subject here, not the toolchain: nothing in this file compiles RTL or runs
 * the synthesizer, and the specs a measurement is formed on are the domain's own selftest samples.
 * What a spec can pin that the loader deliberately does not is the **relationship between the two
 * criteria**: `measure@4` refuses a trial whose metric names the criterion it is measured against,
 * while a declaration is allowed to be one step away from self-measurement, so the inequality is
 * asserted here or it is asserted nowhere.
 *
 * @module singularity-core/assembly/tests/sha256-domain
 */

import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import type { VerifierProcess } from '../../src/verifier/command.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))

/** The upstream module's bytes: the SHA-256 message scheduler this domain starts a submission from. */
const SEED_DIGEST = '0b4de636364625e34e771bb26363d24f4a4bcae6579d0f8cd3e86d7e5c14354a'

/** A port that never runs a process: loading a declaration reads files, it does not judge anything. */
const runProcess: VerifierProcess = async () => ({ exitCode: null, stderr: '', failure: 'this spec loads a declaration and judges nothing' })

const domain = await loadDomain(DIR, runProcess)

it('judges the submission against one criterion, decided by the verifier that criterion names', () => {
  expect(domain.criterion.criterionId).toBe('w-schedule')
  expect(domain.criterion.verifierRef).toBe(domain.verifier.ref)
  expect(domain.criterion.implementationDigest).toBe(domain.verifier.implementationDigest)
})

it('measures the submission by a different criterion than the one it is judged against', () => {
  expect(domain.metric?.unit).toBe('um^2')
  expect(domain.metric?.direction).toBe('lower')
  expect(domain.metric?.measured.criterionId).not.toBe(domain.criterion.criterionId)
  expect(domain.metric?.measured.verifierRef).not.toBe(domain.criterion.verifierRef)
})

it('starts a source submission from the upstream module, carrying the bytes it digested', () => {
  if (domain.initial === undefined) throw new Error('the sha256 domain declares no initial source; a source submission with no starting bytes is not this domain')
  expect(domain.initial.path).toBe('seed/sha256_w_mem.v')
  expect(sha256(domain.initial.bytes)).toBe(SEED_DIGEST)
})

it('stages the protected testbench with the digest of the bytes a caller will write', () => {
  const input = domain.inputs[0]
  if (input === undefined) throw new Error('the sha256 domain declares no input; a criterion with no protected material is not this domain')
  expect(input.path).toBe('tb/tb_sha256_w_mem_selfcheck.v')
  expect(input.digest).toBe(sha256(input.bytes))
})
