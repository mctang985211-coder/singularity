/**
 * The verifier declaration gate and its selftest: what a deployment must say about an
 * implementation before a criterion may name it, and what actually proves it can judge.
 *
 * The two halves are kept apart on purpose. `assertVerifierRunnable` reads the declaration's
 * shape — including the claim that the selftest has produced both verdicts — and refuses a
 * one-sided gate by name. `runVerifierSelftest` is the run that can disagree with that claim, and
 * a disagreement is a report entry, never a throw.
 */

import { describe, expect, it } from 'vitest'

import { verifierRegistryOf } from '../src/task/contract.ts'
import {
  assertVerifierRunnable,
  runVerifierSelftest,
  verifierIdentityOf,
  type VerifierImplementation,
  type VerifierInput,
  type VerifierSelftest,
  type VerifierSelftestSample,
  type VerifierVerdict,
} from '../src/verifier/implementation.ts'
import { refusalOf } from './fixtures.ts'

/** A digest of the implementation itself, as a deployment would supply it. */
const IMPLEMENTATION_DIGEST = '7'.repeat(64)
const REBUILT_DIGEST = 'e'.repeat(64)

const PASSING_INPUT: VerifierInput = {
  subject: 'word-counter',
  artifactDigest: 'a'.repeat(64),
  inputs: [{ name: 'words.txt', digest: 'b'.repeat(64) }],
}

const FAILING_INPUT: VerifierInput = {
  subject: 'word-counter',
  artifactDigest: 'f'.repeat(64),
  inputs: [{ name: 'words.txt', digest: 'b'.repeat(64) }],
}

const PASS_SAMPLE: VerifierSelftestSample = { name: 'counts the words', expected: 'pass', input: PASSING_INPUT }
const FAIL_SAMPLE: VerifierSelftestSample = { name: 'rejects a truncated file', expected: 'fail', input: FAILING_INPUT }

const selftestOf = (samples: readonly VerifierSelftestSample[]): VerifierSelftest => ({ samples })

/** A judge that stands in for the real adapter: one artifact, one verdict, no side effects. */
const judgeByArtifact = async (value: VerifierInput): Promise<VerifierVerdict> => ({
  verdict: value.artifactDigest.startsWith('f') ? 'fail' : 'pass',
})

/** One deployment declaration, with whatever a spec wants to vary. */
function commandImplementation(overrides: Partial<VerifierImplementation> = {}): VerifierImplementation {
  return {
    ref: 'command',
    version: '1',
    implementationDigest: IMPLEMENTATION_DIGEST,
    selftest: selftestOf([PASS_SAMPLE, FAIL_SAMPLE]),
    judge: judgeByArtifact,
    ...overrides,
  }
}

describe('the verifier declaration gate', () => {
  it('refuses an empty ref, version or implementation digest as a malformed declaration', () => {
    expect(
      [{ ref: '' }, { version: '' }, { implementationDigest: '' }].map(
        overrides => refusalOf(() => assertVerifierRunnable(commandImplementation(overrides))).code,
      ),
    ).toEqual(['malformed-declaration', 'malformed-declaration', 'malformed-declaration'])
  })

  it('names the member that is missing, and refuses a non-string rather than coercing it', () => {
    expect(refusalOf(() => assertVerifierRunnable(commandImplementation({ ref: '' }))).detail).toContain(
      'ref must be a non-empty string',
    )
    expect(
      refusalOf(() => assertVerifierRunnable(commandImplementation({ version: 7 as unknown as string }))),
    ).toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('number') })
  })

  it('refuses a selftest with no fail sample: a gate that has never failed is not known to work', () => {
    expect(
      refusalOf(() => assertVerifierRunnable(commandImplementation({ selftest: selftestOf([PASS_SAMPLE]) }))),
    ).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('no sample expected to fail') })
  })

  it('refuses a selftest with no pass sample, so only failing is not runnable either', () => {
    expect(
      refusalOf(() => assertVerifierRunnable(commandImplementation({ selftest: selftestOf([FAIL_SAMPLE]) }))),
    ).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('no sample expected to pass') })
  })

  it('refuses a selftest with no samples at all, rather than reading the empty set as agreement', () => {
    expect(refusalOf(() => assertVerifierRunnable(commandImplementation({ selftest: selftestOf([]) }))).code).toBe(
      'unregistered-verifier',
    )
  })

  it('accepts a declaration whose selftest claims both verdicts', () => {
    expect(() => assertVerifierRunnable(commandImplementation())).not.toThrow()
  })
})

describe('the verifier selftest', () => {
  it('runs every sample and reports the implementation digest it was declared with', async () => {
    expect(await runVerifierSelftest(commandImplementation())).toEqual({
      ref: 'command',
      version: '1',
      implementationDigest: IMPLEMENTATION_DIGEST,
      ran: 2,
      failures: [],
    })
  })

  it('reports a lying implementation as a failure entry instead of throwing', async () => {
    // The declaration claims both verdicts, so the gate passes; the judge then always says fail.
    const liar = commandImplementation({ judge: async () => ({ verdict: 'fail' }) })
    expect(() => assertVerifierRunnable(liar)).not.toThrow()
    const report = await runVerifierSelftest(liar)
    expect([report.ran, report.failures]).toEqual([2, [{ name: PASS_SAMPLE.name, expected: 'pass', actual: 'fail' }]])
  })

  it('reports every disagreeing sample, and still counts the ones it ran', async () => {
    const report = await runVerifierSelftest(commandImplementation({ judge: async () => ({ verdict: 'pass' }) }))
    expect([report.ran, report.failures]).toEqual([2, [{ name: FAIL_SAMPLE.name, expected: 'fail', actual: 'pass' }]])
  })
})

describe('the verifier identity', () => {
  it('is ref@version plus the first 12 characters of the digest, reusing the verifier role naming', () => {
    const implementation = commandImplementation()

    // `verifierRoleOf` owns the `ref@version` naming; the identity is that name without its
    // namespace, plus the digest the legacy hand-written version string lacked.
    expect(verifierIdentityOf(implementation)).toBe(`command@1#${IMPLEMENTATION_DIGEST}`)
    // The name is exactly the key `verifierRegistryOf` looks an implementation up under, so a
    // deployment cannot report it available under one string and known by another.
    expect(
      verifierRegistryOf([verifierIdentityOf(implementation)]).has(
        implementation.ref,
        implementation.version,
        implementation.implementationDigest,
      ),
    ).toBe(true)
  })

  it('changes when the implementation is replaced, even at the same ref@version', () => {
    const first = verifierIdentityOf(commandImplementation())
    const rebuilt = verifierIdentityOf(commandImplementation({ implementationDigest: REBUILT_DIGEST }))
    const laterVersion = verifierIdentityOf(commandImplementation({ version: '2' }))

    expect(first).not.toBe(rebuilt)
    expect(rebuilt).toBe(`command@1#${REBUILT_DIGEST}`)
    expect(laterVersion).toBe(`command@2#${IMPLEMENTATION_DIGEST}`) // The whole digest is carried, so the identity is usable as a lookup key rather than a label that merely resembles one
  })
})
