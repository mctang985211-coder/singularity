/**
 * The deployment's domain: everything a task is about that the protocol does not know — read from
 * `task.json` and the bytes beside it, with a declaration this version cannot carry refused by name.
 *
 * @module @dangosys/dsh-singularity-next/domain
 */

import { join } from 'node:path'

import { refuse } from '../../src/protocol/refusal.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import type { VerifierProcess } from '../../src/verifier/command.ts'
import type { VerifierImplementation } from '../../src/verifier/implementation.ts'
import { sha256 } from './ids.ts'
import { inside, list, nonEmpty, readBytes, record, text } from './shape.ts'
import { requireVerifier, verifierOf } from './verifiers.ts'

export interface DomainVerifier extends VerifierImplementation {
  /** The program whose bytes {@link VerifierImplementation.implementationDigest} names. */
  readonly program: string
  /** The declared template; `{artifact}` and `{input}` are the two paths one judgement reads. */
  readonly args: readonly string[]
}
/**
 * One piece of protected material: where its bytes are staged, where they came from, and the digest of
 * those exact bytes.
 *
 * The bytes are kept, not just the digest, because staging has to be a write of what was digested: a
 * caller that re-read `sourcePath` could stage bytes the digest never covered, and the mismatch would
 * surface later as if the workspace were at fault.
 */
export interface DomainInput {
  /** Workspace-relative path this material is staged to. */
  readonly path: string
  /** Domain-relative path its bytes were read from. Reported so a reader can find the source. */
  readonly sourcePath: string
  readonly digest: string
  readonly bytes: Uint8Array
}
/**
 * What the domain offers to be measured, and how to read the number.
 *
 * `direction` is part of the metric and not a convention: a deployment where smaller is worse cannot say
 * so anywhere else. `measured` is a full criterion because a number with no verifier is a number nobody
 * can reproduce; it must be a **different** criterion from the one the run is judged against, which the
 * measure protocol enforces when the trial is recorded.
 */
export interface DomainMetric {
  readonly unit: string
  readonly direction: 'higher' | 'lower'
  readonly measured: AcceptanceCriterion
}
export interface Domain {
  readonly dir: string
  /** Content digest of the declaration itself: what a run's revision is frozen against. */
  readonly templateDigest: string
  /** The protected material, in declaration order. Judged material is named by the contract. */
  readonly inputs: readonly DomainInput[]
  /**
   * How a submission becomes the artifact: a program to run, or the source itself.
   *
   * The distinction is the whole of the domain's shape, and it is declared rather than inferred: a
   * `source` submission is judged as written, while a `program` submission has to be run to produce
   * anything to judge.
   */
  readonly submission: 'program' | 'source'
  /** Workspace-relative path the submitted text is written to, in both shapes. */
  readonly file: string
  /** Workspace-relative path the criterion's verifier is pointed at. */
  readonly artifact: string
  /** The starting bytes a `source` submission edits, already read and digested. */
  readonly initial?: { readonly path: string; readonly bytes: Uint8Array }
  readonly criterion: AcceptanceCriterion
  /** The criterion's own verifier, and every implementation this deployment holds. */
  readonly verifier: DomainVerifier
  readonly verifiers: readonly DomainVerifier[]
  /** Absent when the domain offers nothing to trade: a criterion can exist without a metric. */
  readonly metric?: DomainMetric
}
export async function loadDomain(dir: string, runProcess: VerifierProcess): Promise<Domain> {
  const declaration = join(dir, 'task.json')
  const bytes = await readBytes(declaration, 'the domain declaration')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    refuse('malformed-declaration', `${declaration} is not JSON (${error instanceof Error ? error.message : String(error)}); a task template that cannot be read is not a template`)
  }
  const declared = record(parsed, 'task.json')

  // A declared input is protected material: a workspace-relative destination and a domain-relative
  // source, with the digest computed here from the bytes actually read.
  const inputs: DomainInput[] = []
  for (const [index, entry] of list(declared['inputs'], 'task.json.inputs').entries()) {
    const at = `task.json.inputs[${index}]`
    const declaredInput = record(entry, at)
    const path = text(declaredInput, 'path', at)
    const sourcePath = text(declaredInput, 'from', at)
    const source = inside(dir, sourcePath, `${at}.from`)
    const bytes = await readBytes(source, `the input ${JSON.stringify(sourcePath)}`)
    inputs.push({ path, sourcePath, digest: sha256(bytes), bytes })
  }
  // The template vocabulary is closed and `{input}` is singular, so a second declared input would expand
  // to whichever one this layer happened to pick. Refused by name rather than half-filled.
  if (inputs.length !== 1)
    refuse(
      'malformed-declaration',
      `task.json declares ${inputs.length} inputs, and the command template's {input} names exactly one staged path; a domain that needs two has to say how the second reaches the verifier, which this version cannot express`,
    )

  const workspace = record(declared['workspace'], 'task.json.workspace')
  const submission = text(workspace, 'submission', 'task.json.workspace')
  if (submission !== 'program' && submission !== 'source')
    refuse(
      'malformed-declaration',
      `task.json.workspace.submission is ${JSON.stringify(submission)}; a submission is either "program" (the submitted text is run and its output is judged) or "source" (the submitted text is judged as written), and a third shape is not one this layer can stage`,
    )
  const file = text(workspace, 'file', 'task.json.workspace')
  const artifact = text(workspace, 'artifact', 'task.json.workspace')
  if (submission === 'source' && file !== artifact)
    refuse(
      'malformed-declaration',
      `task.json declares a "source" submission writing ${JSON.stringify(file)} while its artifact is ${JSON.stringify(artifact)}; a source is judged as written, so the path that is submitted and the path that is judged have to be the same one`,
    )
  const declaredInitial = workspace['initial']
  if (submission === 'program' && declaredInitial !== undefined)
    refuse(
      'malformed-declaration',
      `task.json declares a "program" submission and an initial source; a program produces the artifact, so material placed at ${JSON.stringify(file)} before it runs would make the program a second writer of the bytes it is judged on`,
    )
  let initial: { path: string; bytes: Uint8Array } | undefined
  if (declaredInitial !== undefined) {
    const sourcePath = nonEmpty(declaredInitial, 'task.json.workspace.initial')
    const source = inside(dir, sourcePath, 'task.json.workspace.initial')
    initial = { path: sourcePath, bytes: await readBytes(source, `the initial source ${JSON.stringify(sourcePath)}`) }
  }

  const verifiers: DomainVerifier[] = []
  for (const [index, entry] of list(declared['verifiers'], 'task.json.verifiers').entries())
    verifiers.push(await verifierOf(dir, entry, `task.json.verifiers[${index}]`, runProcess))

  const criteria = list(declared['criteria'], 'task.json.criteria')
  if (criteria.length !== 1)
    refuse('malformed-declaration', `task.json declares ${criteria.length} criteria; this version records one verdict per run, so it adjudicates exactly one criterion`)
  const criterion = record(criteria[0], 'task.json.criteria[0]')

  const criterionOf = (container: Record<string, unknown>, at: string): AcceptanceCriterion => {
    const resolved = requireVerifier(verifiers, text(container, 'verifier', at), at)
    return {
      criterionId: text(container, 'criterionId', at),
      statement: text(container, 'statement', at),
      verifierRef: resolved.ref,
      verifierVersion: resolved.version,
      implementationDigest: resolved.implementationDigest,
    }
  }

  let metric: DomainMetric | undefined
  if (declared['metric'] !== undefined) {
    const declaredMetric = record(declared['metric'], 'task.json.metric')
    const direction = text(declaredMetric, 'direction', 'task.json.metric')
    if (direction !== 'higher' && direction !== 'lower')
      refuse('malformed-declaration', `task.json.metric.direction is ${JSON.stringify(direction)}; a metric is either "higher" or "lower", because "what counts as better" is not a convention this layer may assume`)
    metric = {
      unit: text(declaredMetric, 'unit', 'task.json.metric'),
      direction,
      measured: criterionOf(record(declaredMetric['measured'], 'task.json.metric.measured'), 'task.json.metric.measured'),
    }
  }

  return {
    dir,
    templateDigest: sha256(bytes),
    inputs,
    submission,
    file,
    artifact,
    ...(initial === undefined ? {} : { initial }),
    verifiers,
    verifier: requireVerifier(verifiers, text(criterion, 'verifier', 'task.json.criteria[0]'), 'task.json.criteria[0]'),
    criterion: criterionOf(criterion, 'task.json.criteria[0]'),
    ...(metric === undefined ? {} : { metric }),
  }
}
export function commandOf(verifier: DomainVerifier, artifactPath: string, inputPath: string): readonly string[] {
  const paths: Record<string, string> = { artifact: artifactPath, input: inputPath }
  return [process.execPath, verifier.program, ...verifier.args.map(arg => arg.replace(/\{(\w+)\}/g, (_, name: string) => paths[name]!))]
}
