/**
 * The production measurement: prove the implementation and the inputs before a number is believed.
 *
 * `protocol.ts` records what a deployment accepts, and `implementation.ts` declares what it can run.
 * This module is the step that refuses to take either on its word, in the same five steps as the
 * verdict path — because the failure it exists to prevent is the same one: a number attributed to
 * an implementation that did not produce it.
 *
 * 1. **Resolve by digest, not by name.** A deployment that rebuilt `ref@version` under different
 *    bytes holds no implementation this metric can name, so the lookup is keyed on the content
 *    digest. A name-keyed lookup would run the rebuilt code and report `wrong-verifier` afterwards,
 *    turning "this deployment cannot run that implementation at all" into an accusation about the
 *    implementation it did run.
 * 2. **Run the selftest in both directions**, through the verifier implementation's own gate and
 *    runner: a measurement program that has never produced the failing outcome is not known to be
 *    able to tell anything apart. This is deliberately the *same* selftest code, not a second one.
 * 3. **Hash the bytes on disk** before the program runs. The bubble's declared digests are a claim
 *    about now; reading the files is the proof, and a mismatch is refused before anything measures.
 * 4. **Accept the number only from the metric's implementation.** The real program reports the
 *    digest of the implementation that produced the number — computed from the bytes that ran. A
 *    different digest is `wrong-verifier`. A program that produced *no* number reports a miss, and a
 *    miss stays a miss: turning it into `0` would enter the score as a real measurement.
 * 5. **Hash the artifact after execution.** The digest must name what the number was formed on, so
 *    it comes from the bytes left behind, never from the program's own report. An unreadable
 *    artifact is refused by name like an unreadable input.
 *
 * What this module deliberately does not do: it runs nothing and writes nothing. Process execution
 * is a port (`measure`) wired by the deployment to `scripts/measure-runner.mjs`, because a
 * measurement that spawned a process could never be replayed by a fold. Its only `node:fs` use is
 * read-only.
 *
 * Every refusal reuses a code that already means this failure, and no new one is added: "this
 * deployment cannot run that implementation" (`unregistered-verifier`), "the bytes are not the
 * declared bytes" (`evidence-input-mismatch`), "something else produced this number"
 * (`wrong-verifier`), or "this is not a report" (`malformed-payload`).
 *
 * @module singularity-core/measure/execution
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { refuse } from '../protocol/refusal.ts'
import { BUBBLE_INPUT_MEMBERS, inputList, type BubbleInput } from '../task/bubble.ts'
import { assertCriterionShape, CRITERION_MEMBERS, type VerifierCriterion } from '../task/contract.ts'
import { digest, maybeText, record, text } from '../task/shape.ts'
import {
  assertVerifierRunnable,
  runVerifierSelftest,
  type SelftestReport,
  type VerifierImplementation,
} from '../verifier/implementation.ts'
import type { ProductionExecution, ProductionInput, VerifierCommand } from '../verifier/production.ts'

/** What a real measurement reported: the number, and the implementation that produced it. */
export interface MeasuredNumber {
  readonly quality: number
  /** Absent means the program reported no cost. The path keeps it absent; it never becomes 0. */
  readonly cost?: number
  /** The content digest of the implementation that produced the number, computed from what ran. */
  readonly implementationDigest: string
  readonly detail?: string
}

/** One measurement that produced no number. The reason is the only report it can make. */
export interface MissedMeasurement {
  readonly reason: string
}

/**
 * The real measurement port. Execution stays outside `src/`; the deployment wires this to the
 * adapter that spawns the program. A port that reports a miss is reporting an outcome; a port that
 * *throws* could not measure at all, and the error is the only honest report of it.
 */
export type RealMeasurement = (execution: ProductionExecution) => Promise<MeasuredNumber | MissedMeasurement>

/** One trial's numbers, and the bytes they were formed on. */
export interface MeasuredTrial {
  readonly quality: number
  readonly cost?: number
  readonly artifactDigest: string
  /** The digests of the bytes that were read, each taken at the moment it was proven. */
  readonly inputDigests: readonly BubbleInput[]
  readonly implementationDigest: string
  readonly detail?: string
}

/** What one attempt produced: a trial, or a named miss. Never a trial with an invented zero. */
export type MeasurementOutcome =
  { readonly kind: 'trial'; readonly trial: MeasuredTrial } | { readonly kind: 'missed'; readonly reason: string }

/**
 * Everything one measurement is formed from: the metric that decides it, the implementations the
 * deployment holds, the run's declared inputs, and where the program runs.
 */
export interface MeasurementRequest {
  readonly metric: VerifierCriterion
  readonly implementations: readonly VerifierImplementation[]
  readonly inputs: readonly BubbleInput[]
  readonly workspace: string
  /** Workspace-relative path of the artifact this measurement is formed on; hashed after the run. */
  readonly artifactPath: string
  readonly command: VerifierCommand
  readonly measure: RealMeasurement
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    refuse('malformed-payload', `${field} must be a finite number, got ${String(value)}`)
  return value
}

/** One shell line, or a non-empty argv of non-empty strings. Nothing is defaulted. */
function requireCommand(value: unknown, field: string): VerifierCommand {
  if (typeof value === 'string') return text({ command: value }, 'command', field)
  if (Array.isArray(value) && value.length > 0)
    return value.map((entry, index) => text({ entry }, 'entry', `${field}[${index}]`))
  refuse(
    'malformed-payload',
    `${field} must be a non-empty command line or a non-empty argv array, got ${JSON.stringify(value ?? null)}`,
  )
}

/**
 * The absolute path a declared name resolves to inside the workspace.
 *
 * The containment test is **lexical**, and it is not a sandbox: it stops a declared name from
 * reaching outside the workspace by `..`, not a symlink from pointing outside it. A general sandbox
 * is deliberately out of scope; this is "resolve the declared thing, do not trust the name" applied
 * to paths, exactly as the digest lookup applies it to implementations.
 */
function workspacePath(workspace: string, name: string, field: string): string {
  if (isAbsolute(name))
    refuse(
      'malformed-payload',
      `${field} is ${JSON.stringify(name)}, an absolute path; a declared input is named inside the workspace`,
    )
  const root = resolve(workspace)
  const path = resolve(root, name)
  const inside = relative(root, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    refuse(
      'malformed-payload',
      `${field} is ${JSON.stringify(name)}, which resolves outside the workspace; a declaration may not name bytes it is not bound to`,
    )
  return path
}

/** The implementations this deployment holds, read as declarations before any of them is run. */
function readImplementations(raw: unknown): readonly VerifierImplementation[] {
  if (!Array.isArray(raw))
    refuse(
      'malformed-payload',
      `request.implementations must be an array of the implementations this deployment holds, got ${raw === null ? 'null' : typeof raw}`,
    )
  return raw.map((entry, index) => {
    const where = `request.implementations[${index}]`
    const held = record(entry, where)
    text(held, 'ref', `${where}.ref`)
    text(held, 'version', `${where}.version`)
    digest(held, 'implementationDigest', `${where}.implementationDigest`)
    if (typeof held['judge'] !== 'function')
      refuse(
        'malformed-payload',
        `${where}.judge must be a function; a declaration with no judge cannot pass its selftest`,
      )
    return entry as VerifierImplementation
  })
}

/** The run's declared inputs, resolved into the workspace each one will be read from. */
function readInputs(raw: unknown, workspace: string): readonly ProductionInput[] {
  return inputList(raw, 'request.inputs', BUBBLE_INPUT_MEMBERS).map((entry, index) => ({
    ...entry,
    path: workspacePath(workspace, entry.name, `request.inputs[${index}].name`),
  }))
}

interface ResolvedRequest {
  readonly metric: VerifierCriterion
  readonly implementations: readonly VerifierImplementation[]
  readonly inputs: readonly ProductionInput[]
  readonly workspace: string
  readonly artifactPath: string
  readonly command: VerifierCommand
  readonly measure: RealMeasurement
}

/** Everything that makes this request a request, before anything in it is run. */
function readRequestShape(request: MeasurementRequest): ResolvedRequest {
  const source = record(request, 'the measurement request')
  const workspace = text(source, 'workspace', 'request.workspace')
  const measure = source['measure']
  if (typeof measure !== 'function')
    refuse(
      'malformed-payload',
      'request.measure must be a function; execution is a port, and a missing one is not a measurement',
    )
  return {
    // The metric's shape is the contract owner's rule, read here by the same function the contract's
    // own admission uses: a second reader of the same shape is a second place for the two to drift.
    metric: assertCriterionShape(source['metric'], 'request.metric', CRITERION_MEMBERS),
    implementations: readImplementations(source['implementations']),
    inputs: readInputs(source['inputs'], workspace),
    workspace,
    artifactPath: workspacePath(
      workspace,
      text(source, 'artifactPath', 'request.artifactPath'),
      'request.artifactPath',
    ),
    command: requireCommand(source['command'], 'request.command'),
    measure: measure as RealMeasurement,
  }
}

/**
 * Step 1: the implementation the metric names, looked up by the digest of its bytes.
 *
 * The digest is the key; the name only has to agree once a candidate is found.
 */
function resolveImplementation(
  implementations: readonly VerifierImplementation[],
  metric: VerifierCriterion,
): VerifierImplementation {
  const named = `${metric.verifierRef}@${metric.verifierVersion}`
  const byDigest = implementations.filter(entry => entry.implementationDigest === metric.implementationDigest)
  const resolved = byDigest.find(entry => entry.ref === metric.verifierRef && entry.version === metric.verifierVersion)
  if (resolved !== undefined) return resolved

  const sameName = implementations.filter(
    entry => entry.ref === metric.verifierRef && entry.version === metric.verifierVersion,
  )
  const held =
    byDigest.length > 0
      ? `this deployment holds that digest as ${byDigest.map(entry => `${entry.ref}@${entry.version}`).join(', ')}, not as ${named}`
      : sameName.length === 0
        ? 'this deployment holds no implementation with that digest'
        : `"${named}" is held only as ${sameName.map(entry => `${entry.implementationDigest.slice(0, 12)}…`).join(', ')}, a different implementation`
  refuse(
    'unregistered-verifier',
    `metric "${metric.criterionId}" names the verifier ${named} implemented by ${metric.implementationDigest.slice(0, 12)}…, but ${held}; a rebuilt implementation is not found by its name`,
  )
}

/** Step 2: the declaration's own gate, then the selftest that can disagree with it. */
async function assertSelftestHolds(implementation: VerifierImplementation): Promise<void> {
  assertVerifierRunnable(implementation)
  const report: SelftestReport = await runVerifierSelftest(implementation).catch((error: unknown) =>
    refuse(
      'unregistered-verifier',
      `the selftest of "${implementation.ref}@${implementation.version}" could not run at all (${messageOf(error)}); a measurement whose gate cannot run is not runnable here`,
    ),
  )
  if (report.failures.length > 0) {
    const disagreements = report.failures
      .map(failure => `"${failure.name}" declared ${failure.expected} but produced ${failure.actual}`)
      .join('; ')
    refuse(
      'unregistered-verifier',
      `the selftest of "${implementation.ref}@${implementation.version}" disagreed with its own declaration: ${disagreements}; a measurement program that cannot produce both outcomes is not runnable here`,
    )
  }
}

/** Step 3: hash the bytes actually read, and refuse any input that is not the declared one. */
async function readInputDigests(inputs: readonly ProductionInput[]): Promise<readonly BubbleInput[]> {
  const digests: BubbleInput[] = []
  for (const input of inputs) {
    let bytes: Buffer
    try {
      bytes = await readFile(input.path)
    } catch (error) {
      refuse(
        'evidence-input-mismatch',
        `input "${input.name}" could not be read from the workspace (${messageOf(error)}); bytes that cannot be read cannot be shown to be the declared bytes`,
      )
    }
    const digestOfBytes = createHash('sha256').update(bytes).digest('hex')
    if (digestOfBytes !== input.digest)
      refuse(
        'evidence-input-mismatch',
        `input "${input.name}" declares ${input.digest.slice(0, 12)}…, but the bytes on disk hash to ${digestOfBytes.slice(0, 12)}…; the measurement would be formed on bytes the run never declared`,
      )
    digests.push({ name: input.name, digest: digestOfBytes })
  }
  return digests
}

/** Step 4: run the real measurement, and accept its report only from the metric's implementation. */
async function acceptReport(
  measure: RealMeasurement,
  execution: ProductionExecution,
  metric: VerifierCriterion,
): Promise<MeasuredNumber | MissedMeasurement> {
  const reported = record(await measure(execution), 'the recorded measurement')
  // A miss is a report about the attempt, and it is read first: nothing else it carries is a number.
  if (Object.hasOwn(reported, 'reason')) return { reason: text(reported, 'reason', 'the recorded measurement') }

  const quality = requireNumber(reported['quality'], 'the recorded measurement.quality')
  const cost =
    reported['cost'] === undefined ? undefined : requireNumber(reported['cost'], 'the recorded measurement.cost')
  const implementationDigest = digest(reported, 'implementationDigest', 'the recorded measurement')
  if (implementationDigest !== metric.implementationDigest)
    refuse(
      'wrong-verifier',
      `metric "${metric.criterionId}" names the implementation ${metric.implementationDigest.slice(0, 12)}…, but the number was produced by ${implementationDigest.slice(0, 12)}…; the digest of what ran is what the metric must name`,
    )
  const detail = maybeText(reported, 'detail', 'the recorded measurement')
  return {
    quality,
    ...(cost === undefined ? {} : { cost }),
    implementationDigest,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Step 5: the digest of the bytes the number is bound to, read after the run.
 *
 * An unreadable artifact is refused with the same code and discipline as an unreadable input: the
 * measurement would name bytes that do not exist. A bare read error escaping here would be the one
 * path that fails outside the refusal contract.
 */
async function readArtifactDigest(artifactPath: string, criterionId: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(artifactPath))
      .digest('hex')
  } catch (error) {
    refuse(
      'evidence-input-mismatch',
      `the artifact metric "${criterionId}" would be bound to (${artifactPath}) could not be read (${messageOf(error)}); a measurement cannot name bytes that are not there`,
    )
  }
}

/**
 * Measure once, in the five steps, refusing by name at each one.
 *
 * A miss is an outcome, not an error and not a zero: the caller records it as `trial/missed`, so the
 * plan's slot stays named and the denominator stays where it was.
 */
export async function runMeasurement(request: MeasurementRequest): Promise<MeasurementOutcome> {
  const { metric, implementations, inputs, workspace, artifactPath, command, measure } = readRequestShape(request)

  const implementation = resolveImplementation(implementations, metric)
  await assertSelftestHolds(implementation)
  const inputDigests = await readInputDigests(inputs)
  const reported = await acceptReport(measure, { workspace, artifactPath, command, inputs }, metric)
  if ('reason' in reported) return { kind: 'missed', reason: reported.reason }
  // After execution, not before: this digest names the bytes the number was formed on.
  const artifactDigest = await readArtifactDigest(artifactPath, metric.criterionId)

  return {
    kind: 'trial',
    trial: {
      quality: reported.quality,
      ...(reported.cost === undefined ? {} : { cost: reported.cost }),
      artifactDigest,
      inputDigests,
      implementationDigest: reported.implementationDigest,
      ...(reported.detail === undefined ? {} : { detail: reported.detail }),
    },
  }
}
