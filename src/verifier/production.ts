/**
 * The production verdict: prove the implementation and the inputs that actually produced a verdict.
 *
 * `implementation.ts` records what a deployment *declares* it can run. This module is the step that
 * refuses to take that word for it, in five named steps, each of which can only succeed by
 * observing something outside the declaration. Comparing a declared digest string is an identity
 * claim, not verification:
 *
 * 1. **Resolve by digest, not by name.** A deployment that rebuilt `ref@version` under different
 *    bytes holds no implementation this criterion can name, so the lookup is keyed on the content
 *    digest. A name-keyed lookup would find the rebuilt code, run it, and report `wrong-verifier`
 *    after the fact — turning "this deployment cannot run that implementation at all" into a
 *    misleading accusation about the implementation it did run.
 * 2. **Run the selftest in both directions.** A declaration that claims a fail sample and cannot
 *    produce one is not runnable. `runVerifierSelftest` runs the judge; this path refuses on any
 *    disagreement, and on a judge that cannot run at all.
 * 3. **Hash the bytes on disk.** The bubble's declared digests are a claim about now; reading the
 *    files is the proof. A mismatch is refused before the judge is asked anything, so a verdict can
 *    never be formed on bytes other than those the run declared.
 * 4. **Accept the verdict only from the criterion's implementation.** The real judge reports the
 *    digest of the implementation that actually produced the verdict — the bytes that ran, not the
 *    name it was asked for. A different digest is `wrong-verifier`.
 * 5. **Hash the artifact after execution.** The digest must name what the verdict was formed on, so
 *    it is taken from the bytes left behind, never from the judge's own report. An artifact that
 *    cannot be read is refused by name like an input: a verdict cannot be bound to bytes that are
 *    not there, and a missing file must not escape as a raw read error.
 *
 * What the digest inside `implementationDigest` covers, precisely: the bytes of the **judged
 * program** — the thing whose exit code is the verdict, and the thing a rebuild would replace. It
 * does not cover the deployment-side adapter that spawned it (`scripts/verifier-command.mjs`),
 * because in this deployment that adapter is a generic runner and the program is what decides. A
 * deployment whose runner is itself part of the judgement must fold the runner's own bytes into the
 * digest it declares; this module can only check the digest it is given, and that is what it does.
 *
 * What this module deliberately does not do: it runs nothing and writes nothing. Process execution
 * is a port (`runJudge`) wired by the deployment, because a judgement that spawned a process could
 * never be replayed by a fold. Its only `node:fs` use is read-only.
 *
 * The refusals use the four codes that already exist for exactly these failures, and no new code is
 * added, because every failure here is one of "this deployment cannot run that implementation"
 * (`unregistered-verifier`), "the bytes are not the declared bytes" (`evidence-input-mismatch`),
 * "something else judged it" (`wrong-verifier`), or "this is not a payload" (`malformed-payload`).
 *
 * @module singularity-core/verifier/production
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { refuse } from '../protocol/refusal.ts'
import { inputList, type BubbleInput } from '../task/bubble.ts'
import { assertCriterionShape, type AcceptanceCriterion } from '../task/contract.ts'
import {
  assertVerifierRunnable,
  runVerifierSelftest,
  type SelftestReport,
  type VerifierImplementation,
} from './implementation.ts'

/** A declared input after this path has resolved it into the workspace, where it will be read. */
export interface ProductionInput {
  readonly name: string
  readonly digest: string
  /** The absolute path inside the workspace the name resolved to. */
  readonly path: string
}

/**
 * The command this run executes: one shell line, or argv with no shell.
 *
 * The distinction is the caller's, not this module's: production resolves inputs and names the
 * artifact, while how a command is spawned belongs to the deployment-side adapter.
 */
export type VerifierCommand = string | readonly string[]

/** What one real execution needs: where it runs, what it runs, and what it was bound to. */
export interface ProductionExecution {
  readonly workspace: string
  /** Absolute path of the artifact this judgement is formed on; hashed after the run. */
  readonly artifactPath: string
  readonly command: VerifierCommand
  readonly inputs: readonly ProductionInput[]
}

/**
 * What the real judge reported. `implementationDigest` is the implementation that actually
 * produced the verdict, computed from the bytes that ran — not the digest it was asked for.
 */
export interface JudgedVerdict {
  readonly verdict: 'pass' | 'fail'
  readonly implementationDigest: string
  readonly detail?: string
}

/** The real judge port. Execution stays outside `src/`; this is the seam it reports through. */
export type RealJudge = (execution: ProductionExecution) => Promise<JudgedVerdict>

/**
 * Everything one production verdict is formed from.
 *
 * `implementations` is what the deployment holds, each with the digest of its own bytes;
 * `criterion` is the frozen acceptance criterion the verdict must belong to; `inputs` is the
 * bubble's declaration the run is bound to. The digest is the lookup key, never the name.
 */
export interface ProductionVerdictRequest {
  readonly runId: string
  readonly criterion: AcceptanceCriterion
  readonly implementations: readonly VerifierImplementation[]
  readonly inputs: readonly BubbleInput[]
  readonly workspace: string
  /** Workspace-relative path of the artifact this judgement is formed on. */
  readonly artifactPath: string
  readonly command: VerifierCommand
  readonly runJudge: RealJudge
}

/**
 * The verdict, in exactly the frozen `evidence/produced` shape: `inputDigests` and the artifact
 * digest are the digests of the bytes that were read, each one taken at the moment it was proven.
 */
export interface ProductionVerdict {
  readonly runId: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
  readonly verifierRef: string
  readonly verifierVersion: string
  readonly implementationDigest: string
  readonly artifactDigest: string
  readonly inputDigests: readonly BubbleInput[]
  readonly detail?: string
}

const DIGEST = /^[0-9a-f]{64}$/

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-payload', `${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`)
  return value as Record<string, unknown>
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-payload', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireText(value, field)
  if (!DIGEST.test(digest)) refuse('malformed-payload', `${field} must be a sha256 hex content digest, got ${JSON.stringify(digest)}`)
  return digest
}

/** One shell line, or a non-empty argv of non-empty strings. Nothing is defaulted. */
function requireCommand(value: unknown, field: string): VerifierCommand {
  if (typeof value === 'string') return requireText(value, field)
  if (Array.isArray(value) && value.length > 0) return value.map((entry, index) => requireText(entry, `${field}[${index}]`))
  refuse('malformed-payload', `${field} must be a non-empty command line or a non-empty argv array, got ${JSON.stringify(value ?? null)}`)
}

/**
 * The absolute path a declared name resolves to inside the workspace.
 *
 * The containment test is **lexical**, and it is not a sandbox: it stops a declared name from
 * reaching outside the workspace by `..`, not a symlink from pointing outside it. A general
 * sandbox is deliberately out of scope (`phase-b-design.md` §5); this is the same "resolve the
 * declared thing, do not trust the name" discipline as the digest lookup, applied to paths.
 */
function workspacePath(workspace: string, name: string, field: string): string {
  if (isAbsolute(name)) refuse('malformed-payload', `${field} is ${JSON.stringify(name)}, an absolute path; a declared input is named inside the workspace`)
  const root = resolve(workspace)
  const path = resolve(root, name)
  const inside = relative(root, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    refuse('malformed-payload', `${field} is ${JSON.stringify(name)}, which resolves outside the workspace; a declaration may not name bytes it is not bound to`)
  return path
}

/** The implementations this deployment holds, read as declarations before any of them is run. */
function readImplementations(raw: unknown): readonly VerifierImplementation[] {
  if (!Array.isArray(raw))
    refuse('malformed-payload', `request.implementations must be an array of the implementations this deployment holds, got ${raw === null ? 'null' : typeof raw}`)
  return raw.map((entry, index) => {
    const where = `request.implementations[${index}]`
    const record = requireRecord(entry, where)
    requireText(record['ref'], `${where}.ref`)
    requireText(record['version'], `${where}.version`)
    requireDigest(record['implementationDigest'], `${where}.implementationDigest`)
    if (typeof record['judge'] !== 'function')
      refuse('malformed-payload', `${where}.judge must be a function; a declaration with no judge cannot pass its selftest`)
    return entry as VerifierImplementation
  })
}

/**
 * The bubble's declared inputs, read by the shape their owner declares, then resolved into the
 * workspace each one will be read from. The shape lives in `src/task/bubble.ts` because
 * `inputDigests` is a field of that protocol's own `evidence/produced` payload.
 */
function readInputs(raw: unknown, workspace: string): readonly ProductionInput[] {
  return inputList(raw, 'request.inputs').map((entry, index) => ({
    ...entry,
    path: workspacePath(workspace, entry.name, `request.inputs[${index}].name`),
  }))
}

interface ResolvedRequest {
  readonly runId: string
  readonly criterion: AcceptanceCriterion
  readonly implementations: readonly VerifierImplementation[]
  readonly inputs: readonly ProductionInput[]
  readonly workspace: string
  readonly artifactPath: string
  readonly command: VerifierCommand
  readonly runJudge: RealJudge
}

/** Everything that makes this request a request, before anything in it is run. */
function readRequestShape(request: ProductionVerdictRequest): ResolvedRequest {
  const source = requireRecord(request, 'the production verdict request')
  const workspace = requireText(source['workspace'], 'request.workspace')
  const runJudge = source['runJudge']
  if (typeof runJudge !== 'function')
    refuse('malformed-payload', 'request.runJudge must be a function; execution is a port, and a missing one is not a judgement')
  return {
    runId: requireText(source['runId'], 'request.runId'),
    // The criterion's shape is the contract owner's rule, read here by the same function the
    // contract's own admission uses. A second reader of the same shape is a second place for the
    // two to drift apart, and the drift is invisible until a log disagrees with itself.
    criterion: assertCriterionShape(source['criterion'], 'request.criterion'),
    implementations: readImplementations(source['implementations']),
    inputs: readInputs(source['inputs'], workspace),
    workspace,
    artifactPath: workspacePath(workspace, requireText(source['artifactPath'], 'request.artifactPath'), 'request.artifactPath'),
    command: requireCommand(source['command'], 'request.command'),
    runJudge: runJudge as RealJudge,
  }
}

/**
 * Step 1: the implementation the criterion names, looked up by the digest of its bytes.
 *
 * The digest is the key; the name only has to agree once a candidate is found, so a deployment that
 * rebuilt `ref@version` under different bytes is reported as not holding it, by name.
 */
function resolveImplementation(implementations: readonly VerifierImplementation[], criterion: AcceptanceCriterion): VerifierImplementation {
  const named = `${criterion.verifierRef}@${criterion.verifierVersion}`
  const byDigest = implementations.filter(entry => entry.implementationDigest === criterion.implementationDigest)
  const resolved = byDigest.find(entry => entry.ref === criterion.verifierRef && entry.version === criterion.verifierVersion)
  if (resolved !== undefined) return resolved

  const sameName = implementations.filter(entry => entry.ref === criterion.verifierRef && entry.version === criterion.verifierVersion)
  const held =
    byDigest.length > 0
      ? `this deployment holds that digest as ${byDigest.map(entry => `${entry.ref}@${entry.version}`).join(', ')}, not as ${named}`
      : sameName.length === 0
        ? 'this deployment holds no implementation with that digest'
        : `"${named}" is held only as ${sameName.map(entry => `${entry.implementationDigest.slice(0, 12)}…`).join(', ')}, a different implementation`
  refuse(
    'unregistered-verifier',
    `criterion "${criterion.criterionId}" names the verifier ${named} implemented by ${criterion.implementationDigest.slice(0, 12)}…, but ${held}; a rebuilt implementation is not found by its name`,
  )
}

/** Step 2: the declaration's own gate, then the selftest that can disagree with it. */
async function assertSelftestHolds(implementation: VerifierImplementation): Promise<void> {
  assertVerifierRunnable(implementation)
  const report: SelftestReport = await runVerifierSelftest(implementation).catch((error: unknown) =>
    refuse(
      'unregistered-verifier',
      `the selftest of "${implementation.ref}@${implementation.version}" could not run at all (${messageOf(error)}); an implementation whose gate cannot run is not runnable here`,
    ),
  )
  if (report.failures.length > 0) {
    const disagreements = report.failures.map(failure => `"${failure.name}" declared ${failure.expected} but produced ${failure.actual}`).join('; ')
    refuse(
      'unregistered-verifier',
      `the selftest of "${implementation.ref}@${implementation.version}" disagreed with its own declaration: ${disagreements}; a verifier that cannot produce both verdicts is not runnable here`,
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
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== input.digest)
      refuse(
        'evidence-input-mismatch',
        `input "${input.name}" declares ${input.digest.slice(0, 12)}…, but the bytes on disk hash to ${digest.slice(0, 12)}…; the verdict would be formed on bytes the run never declared`,
      )
    digests.push({ name: input.name, digest })
  }
  return digests
}

/** Step 4: run the real judge, and accept its verdict only from the criterion's implementation. */
async function acceptJudgedVerdict(runJudge: RealJudge, execution: ProductionExecution, criterion: AcceptanceCriterion): Promise<JudgedVerdict> {
  const judged = requireRecord(await runJudge(execution), 'the recorded judgement')
  const verdict = judged['verdict']
  if (verdict !== 'pass' && verdict !== 'fail')
    refuse('malformed-payload', `the recorded judgement.verdict must be "pass" or "fail", got ${JSON.stringify(verdict ?? null)}`)
  const implementationDigest = requireDigest(judged['implementationDigest'], 'the recorded judgement.implementationDigest')
  if (implementationDigest !== criterion.implementationDigest)
    refuse(
      'wrong-verifier',
      `criterion "${criterion.criterionId}" names the implementation ${criterion.implementationDigest.slice(0, 12)}…, but the verdict was produced by ${implementationDigest.slice(0, 12)}…; the digest of what ran is what the criterion must name`,
    )
  const detail = judged['detail']
  if (detail !== undefined && typeof detail !== 'string') refuse('malformed-payload', 'the recorded judgement.detail must be a string when it is present')
  return { verdict, implementationDigest, ...(detail === undefined ? {} : { detail }) }
}

/**
 * Step 5: the digest of the bytes the verdict is bound to, read after the run.
 *
 * An unreadable artifact is refused with the same code and the same discipline as an unreadable
 * input: the verdict would name bytes that do not exist, which is a binding the evidence cannot
 * carry. A bare read error escaping here would be the one path that fails outside the refusal
 * contract.
 */
async function readArtifactDigest(artifactPath: string, criterionId: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(artifactPath)).digest('hex')
  } catch (error) {
    refuse(
      'evidence-input-mismatch',
      `the artifact criterion "${criterionId}" would be bound to (${artifactPath}) could not be read (${messageOf(error)}); a verdict cannot name bytes that are not there`,
    )
  }
}

/**
 * Form one verdict, in the five steps, refusing by name at each one.
 *
 * A real judge that throws is not a refusal: there is no verdict to compare, so the error is the
 * only honest report of it and it propagates.
 */
export async function runProductionVerdict(request: ProductionVerdictRequest): Promise<ProductionVerdict> {
  const { runId, criterion, implementations, inputs, workspace, artifactPath, command, runJudge } = readRequestShape(request)

  const implementation = resolveImplementation(implementations, criterion)
  await assertSelftestHolds(implementation)
  const inputDigests = await readInputDigests(inputs)
  const judged = await acceptJudgedVerdict(runJudge, { workspace, artifactPath, command, inputs }, criterion)
  // After execution, not before: the digest names the bytes the verdict was formed on.
  const artifactDigest = await readArtifactDigest(artifactPath, criterion.criterionId)

  return {
    runId,
    criterionId: criterion.criterionId,
    verdict: judged.verdict,
    verifierRef: criterion.verifierRef,
    verifierVersion: criterion.verifierVersion,
    implementationDigest: criterion.implementationDigest,
    artifactDigest,
    inputDigests,
    ...(judged.detail === undefined ? {} : { detail: judged.detail }),
  }
}
