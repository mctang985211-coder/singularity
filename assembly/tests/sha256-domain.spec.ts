/**
 * The sha256 domain as a declaration: the criterion a run is judged against, the metric measured
 * beside it, and the seed a source submission starts from.
 *
 * The declaration is the subject here, not the toolchain: nothing in this file compiles RTL or runs
 * the synthesizer, and the port below never reaches a process. What a spec can pin that the loader
 * deliberately does not is the **relationship between the two criteria**: `measure@4` refuses a trial
 * whose metric names the criterion it is measured against, while a declaration is allowed to be one
 * step away from self-measurement, so the inequality is asserted here or it is asserted nowhere.
 *
 * @module singularity-core/assembly/tests/sha256-domain
 */

import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import type { VerifierProcess } from '../../src/verifier/command.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))

/** The upstream module's bytes: the SHA-256 message scheduler a submission starts from. */
const SEED_DIGEST = '0b4de636364625e34e771bb26363d24f4a4bcae6579d0f8cd3e86d7e5c14354a'

/** Loading a declaration reads files and judges nothing, so no process is ever asked for. */
const runProcess: VerifierProcess = async () => ({ exitCode: null, stderr: '', failure: 'this spec loads a declaration and judges nothing' })

const domain = await loadDomain(DIR, runProcess)

/** The metric, or a failure that says the domain is not the one this spec is about. */
function metric(): NonNullable<typeof domain.metric> {
  if (domain.metric === undefined) throw new Error('the sha256 domain declares no metric; a slice nothing can be measured on is not this domain')
  return domain.metric
}

it('judges the run against one criterion, decided by the verifier that criterion names', () => {
  expect(domain.criterion.criterionId).toBe('w-schedule')
  expect(domain.criterion.verifierRef).toBe(domain.verifier.ref)
  expect(domain.criterion.implementationDigest).toBe(domain.verifier.implementationDigest)
})

it('measures the submission by a criterion other than the one it is judged against', () => {
  expect(metric().measured.criterionId).not.toBe(domain.criterion.criterionId)
  expect(metric().measured.verifierRef).not.toBe(domain.criterion.verifierRef)
})

it('states the metric in micrometres squared, where smaller is better', () => {
  expect(metric().unit).toBe('um^2')
  expect(metric().direction).toBe('lower')
})

it('starts a source submission from the upstream module, at the path the submitted source is written to', () => {
  if (domain.initial === undefined) throw new Error('the sha256 domain declares no initial source; a source submission with no starting bytes is not this domain')
  expect(domain.file).toBe('rtl/sha256_w_mem.v')
  expect(domain.initial.path).toBe('seed/sha256_w_mem.v')
  expect(sha256(domain.initial.bytes)).toBe(SEED_DIGEST)
})

it('stages the protected input where the criterion\'s own verifier reads it from', () => {
  const input = domain.inputs[0]
  if (input === undefined) throw new Error('the sha256 domain declares no input; a criterion with no protected material is not this domain')
  const sample = domain.verifier.selftest.samples[0]
  if (sample === undefined) throw new Error('the criterion\'s verifier declares no sample; a verifier whose gate has never run is not this domain')
  // The two halves of the declaration have to agree: the file staged for the submission to read, and
  // the file the criterion's verifier actually reads. A declaration where `from` names other bytes
  // stages material the judgement never sees, and one where `path` differs stages it somewhere the
  // verifier does not look — both are this comparison, which is why `digest` is read off the sample.
  expect(input.path).toBe('tb/tb_sha256_w_mem_selfcheck.v')
  expect(sample.input.inputs[0]?.name).toBe(input.path)
  expect(sample.input.inputs[0]?.digest).toBe(input.digest)
})
