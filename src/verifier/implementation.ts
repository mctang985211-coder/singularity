/**
 * What a deployment declares about a verifier it can run, and the one gate that makes the
 * declaration usable.
 *
 * Three boundaries are deliberate:
 *
 * - **The digest is not computed here.** `implementationDigest` is a content digest of the
 *   implementation itself — its code plus the toolchain it pins — and that belongs to whoever
 *   builds it. We cannot hash another deployment's implementation; we require the value and
 *   compare it. So no hashing helper for implementations lives in this module.
 * - **No process runs here.** `judge` is a port. Real execution lives in the deployment-side
 *   adapter `scripts/verifier-command.mjs`, the only file that spawns anything, so this module
 *   stays pure and a fold can read a declaration on a machine that cannot run it.
 * - **A failing selftest is a report, not a throw.** Whether it blocks use is a command-time
 *   decision for a caller that can see today's deployment.
 *
 * The gate is the "a gate that has never failed is not known to work" rule applied to verifiers:
 * a selftest that has never produced one of the two verdicts proves nothing about the other, and
 * such a declaration is refused by name — `unregistered-verifier`, the code that already means
 * "a criterion names a verifier this deployment cannot currently run".
 *
 * @module singularity-core/verifier/implementation
 */

import { refuse } from '../protocol/refusal.ts'
import { verifierRoleOf } from '../task/protocol.ts'

/** One input the verdict is formed on: a name and the content digest it was resolved to. */
export interface VerifierInput {
  readonly subject: string
  readonly artifactDigest: string
  readonly inputs: readonly { readonly name: string; readonly digest: string }[]
}

/** The one shape a judgement has. Nothing here is a score or a confidence: pass, or fail. */
export interface VerifierVerdict {
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail?: string
}

/** One known sample: an input, and the verdict the implementation must produce for it. */
export interface VerifierSelftestSample {
  readonly name: string
  readonly expected: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly input: VerifierInput
}

/** Known samples that prove the implementation can produce BOTH verdicts. */
export interface VerifierSelftest {
  readonly samples: readonly VerifierSelftestSample[]
}

/** What a deployment declares about one verifier it can run. */
export interface VerifierImplementation {
  /** Stable within the deployment, e.g. 'command'. */
  readonly ref: string
  /** Declared by the deployment; a different build at the same version is what the digest catches. */
  readonly version: string
  /**
   * Content digest of the implementation itself (code + pinned toolchain), supplied BY THE
   * DEPLOYMENT. We cannot hash someone else's implementation; we only require and compare it.
   */
  readonly implementationDigest: string
  readonly selftest: VerifierSelftest
  judge(input: VerifierInput): Promise<VerifierVerdict>
}

/** One sample whose observed verdict disagreed with what the sample declared. */
interface SelftestFailure {
  readonly name: string
  readonly expected: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly actual: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail?: string
}

/** What running the selftest observed: how many samples ran, and which ones disagreed. */
export interface SelftestReport {
  readonly ref: string
  readonly version: string
  readonly implementationDigest: string
  readonly ran: number
  readonly failures: readonly SelftestFailure[]
}

/** A declaration that is empty where it must name something cannot be bound at all. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-declaration', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

/** The verdicts a declaration says it can produce. A declaration with no samples says none. */
function declaredVerdicts(implementation: VerifierImplementation): readonly string[] {
  const samples: unknown = implementation.selftest?.samples
  if (!Array.isArray(samples)) return []
  return samples.map((sample: VerifierSelftestSample) => sample.expected)
}

/**
 * The declaration gate: is this something a criterion may name at all?
 *
 * Shape only. It checks that the naming members exist and that the selftest *claims* both
 * verdicts; it does not run the selftest, because a declaration can lie about what its `judge`
 * does — running it is `runVerifierSelftest`, which reports the lie.
 *
 * A one-sided selftest is refused as `unregistered-verifier` rather than `malformed-declaration`:
 * the declaration is well formed, it just names an implementation this deployment cannot show can
 * decide anything but one outcome.
 */
export function assertVerifierRunnable(implementation: VerifierImplementation): void {
  const ref = requireText(implementation.ref, 'verifier declaration ref')
  const version = requireText(implementation.version, 'verifier declaration version')
  requireText(implementation.implementationDigest, 'verifier declaration implementationDigest')

  const expected = declaredVerdicts(implementation)
  if (!expected.includes('pass'))
    refuse(
      'unregistered-verifier',
      `verifier "${ref}@${version}" declares a selftest with no sample expected to pass; nothing shows it can produce a passing verdict, so it is not runnable here`,
    )
  if (!expected.includes('fail'))
    refuse(
      'unregistered-verifier',
      `verifier "${ref}@${version}" declares a selftest with no sample expected to fail; a gate that has never failed is not known to work, so it is not runnable here`,
    )
}

/**
 * Run every sample and compare the judge's verdict with the sample's expectation.
 *
 * A disagreement is data — a failure entry — and is never thrown, so a caller can record a
 * failing selftest and make the command-time decision itself. A judge that *throws* is a
 * different case: there is no verdict to compare, so the error is the only honest report of it
 * and it propagates.
 */
export async function runVerifierSelftest(implementation: VerifierImplementation): Promise<SelftestReport> {
  const samples = implementation.selftest.samples
  const failures: SelftestFailure[] = []
  for (const sample of samples) {
    const verdict = await implementation.judge(sample.input)
    if (verdict.verdict !== sample.expected)
      failures.push({ name: sample.name, expected: sample.expected, actual: verdict.verdict,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) })
  }
  return {
    ref: implementation.ref,
    version: implementation.version,
    implementationDigest: implementation.implementationDigest,
    ran: samples.length,
    failures,
  }
}

/**
 * The one canonical name of an implementation: `ref@version#<implementationDigest>`.
 *
 * Exactly one string names an implementation, and it is the string `verifierRegistryOf` keys a
 * deployment's runnable set on, so "the name a deployment knows it by" and "the key it is
 * available under" cannot drift apart. An earlier draft truncated the digest to twelve characters
 * for display, which produced two look-alike names of different precision — one of them a lookup
 * key — and a silent miss is precisely the failure this slice exists to prevent. A renderer that
 * wants a short form truncates where it renders.
 *
 * The `ref@version` half is composed by `verifierRoleOf`, which owns how a verifier is named as an
 * emitter role; re-spelling the join here would put the naming in two places. That role namespaces
 * itself (`verifier:`), and this identity drops the namespace, because it names the implementation
 * rather than the role the implementation emits under.
 *
 * The digest is the point: replacing the implementation while keeping `ref@version` — the legacy
 * system's hand-written version string — yields a different identity here.
 */
export function verifierIdentityOf(implementation: VerifierImplementation): string {
  const role = verifierRoleOf({ verifierRef: implementation.ref, verifierVersion: implementation.version })
  const namespace = role.indexOf(':')
  const named = namespace === -1 ? role : role.slice(namespace + 1)
  return `${named}#${implementation.implementationDigest}`
}
