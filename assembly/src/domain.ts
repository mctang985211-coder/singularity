/**
 * The deployment's domain: everything a task is about that the protocol does not know — read from
 * `task.json` and the bytes beside it, with a declaration this version cannot carry refused by name.
 *
 * @module @dangosys/dsh-singularity-next/domain
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { refuse } from '../../src/protocol/refusal.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { runVerifierCommand, type VerifierProcess } from '../../src/verifier/command.ts'
import type { VerifierImplementation, VerifierInput, VerifierSelftestSample, VerifierVerdict } from '../../src/verifier/implementation.ts'
import { sha256 } from './ids.ts'

export interface DomainVerifier extends VerifierImplementation {
  /** The program whose bytes {@link VerifierImplementation.implementationDigest} names. */
  readonly program: string
  /** The declared template; `{artifact}` and `{input}` are the two paths one judgement reads. */
  readonly args: readonly string[]
}
export interface Domain {
  readonly dir: string
  /** Content digest of the declaration itself: what a run's revision is frozen against. */
  readonly templateDigest: string
  /** Workspace-relative path of the single declared input, as core's own input reference reads it. */
  readonly inputPath: string
  readonly program: string
  readonly artifact: string
  readonly criterion: AcceptanceCriterion
  /** The criterion's own verifier, and every implementation this deployment holds. */
  readonly verifier: DomainVerifier
  readonly verifiers: readonly DomainVerifier[]
}
const described = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value)

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-declaration', `${where} must be an object, got ${described(value)}`)
  return value as Record<string, unknown>
}
function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) refuse('malformed-declaration', `${where} must be a list, got ${described(value)}`)
  return value
}
function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse('malformed-declaration', `${where} must be a non-empty string, got ${described(value)}`)
  return value
}
const text = (source: Record<string, unknown>, key: string, where: string): string => nonEmpty(source[key], `${where}.${key}`)

async function readBytes(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    refuse('malformed-declaration', `${what} (${path}) could not be read (${error instanceof Error ? error.message : String(error)}); declared material that is not there cannot be run`)
  }
}
function inside(root: string, name: string, where: string): string {
  if (isAbsolute(name)) refuse('malformed-declaration', `${where} is ${JSON.stringify(name)}, an absolute path; a declared name lives inside the tree it belongs to`)
  const within = relative(resolve(root), resolve(root, name))
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    refuse('malformed-declaration', `${where} is ${JSON.stringify(name)}, which resolves outside ${root}`)
  return resolve(root, name)
}
async function samplesOf(dir: string, entries: readonly unknown[], where: string): Promise<{ samples: VerifierSelftestSample[]; argv: Map<string, readonly string[]> }> {
  const samples: VerifierSelftestSample[] = []
  const argv = new Map<string, readonly string[]>()
  for (const [index, entry] of entries.entries()) {
    const at = `${where}.selftest[${index}]`
    const declared = record(entry, at)
    const name = text(declared, 'name', at)
    const artifact = inside(dir, text(declared, 'artifact', at), `${at}.artifact`)
    const declaredArgv = list(declared['argv'], `${at}.argv`).map((argument, position) => nonEmpty(argument, `${at}.argv[${position}]`))
    const command = declaredArgv.map((argument, position) => inside(dir, argument, `${at}.argv[${position}]`))
    if (command[0] !== artifact)
      refuse('malformed-declaration', `${at} declares sample "${name}" reading ${command[0] ?? 'nothing'}, but its artifact is ${artifact}; a sample whose bytes are not the bytes it reads proves nothing`)
    if (argv.has(artifact))
      refuse('malformed-declaration', `${at} declares sample "${name}" on artifact ${artifact}, which another sample already declares; one artifact is one known sample, or the selftest cannot say which one ran`)
    const expected = declared['expected']
    if (expected !== 'pass' && expected !== 'fail') refuse('malformed-declaration', `${at}.expected must be "pass" or "fail", got ${JSON.stringify(expected ?? null)}`)
    const inputs: { name: string; digest: string }[] = []
    for (const [position, path] of command.slice(1).entries())
      inputs.push({ name: declaredArgv[position + 1]!, digest: sha256(await readBytes(path, `the input of sample "${name}"`)) })
    samples.push({ name, expected, input: { subject: artifact, artifactDigest: sha256(await readBytes(artifact, `the artifact of sample "${name}"`)), inputs } })
    argv.set(artifact, command)
  }
  return { samples, argv }
}
async function verifierOf(dir: string, entry: unknown, where: string, runProcess: VerifierProcess): Promise<DomainVerifier> {
  const declared = record(entry, where)
  const program = inside(dir, text(declared, 'program', where), `${where}.program`)
  const args = list(declared['args'], `${where}.args`).map((argument, index) => nonEmpty(argument, `${where}.args[${index}]`))
  for (const [index, argument] of args.entries()) {
    const unfillable = [...argument.matchAll(/\{(\w+)\}/g)].filter(match => match[1] !== 'artifact' && match[1] !== 'input')
    if (unfillable.length > 0)
      refuse('malformed-declaration', `${where}.args[${index}] names the placeholder ${unfillable[0]![0]}, which this version cannot fill; a template is filled with {artifact} and {input} and nothing else`)
  }
  const { samples, argv } = await samplesOf(dir, list(declared['selftest'], `${where}.selftest`), where)
  return {
    ref: text(declared, 'ref', where),
    version: text(declared, 'version', where),
    program,
    args,
    implementationDigest: sha256(await readBytes(program, `${where}.program`)),
    selftest: { samples },
    // This port is the selftest's: a real judgement reaches the verifier through `runJudge`.
    judge: async (sample: VerifierInput): Promise<VerifierVerdict> => {
      const command = argv.get(sample.subject)
      if (command === undefined) refuse('malformed-declaration', `the selftest asked for ${JSON.stringify(sample.subject)}, which is not the artifact of any declared sample`)
      const judged = await runVerifierCommand({ command: [process.execPath, program, ...command], artifactPath: sample.subject }, runProcess)
      return { verdict: judged.verdict, detail: judged.detail }
    },
  }
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

  // A declared input is one workspace-relative name and core's own input reference, with no second label.
  const inputs = list(declared['inputs'], 'task.json.inputs').map((entry, index) => nonEmpty(entry, `task.json.inputs[${index}]`))
  const [inputPath] = inputs
  if (inputPath === undefined || inputs.length !== 1)
    refuse('malformed-declaration', `task.json declares ${inputs.length} inputs; this version builds a workspace from exactly one input, so a domain declaring a different number is refused by name rather than half-built`)
  inside(dir, inputPath, 'task.json.inputs[0]')

  const workspace = record(declared['workspace'], 'task.json.workspace')
  const program = text(workspace, 'program', 'task.json.workspace')
  const artifact = text(workspace, 'artifact', 'task.json.workspace')
  inside(dir, program, 'task.json.workspace.program')
  inside(dir, artifact, 'task.json.workspace.artifact')

  const verifiers: DomainVerifier[] = []
  for (const [index, entry] of list(declared['verifiers'], 'task.json.verifiers').entries())
    verifiers.push(await verifierOf(dir, entry, `task.json.verifiers[${index}]`, runProcess))

  const criteria = list(declared['criteria'], 'task.json.criteria')
  if (criteria.length !== 1)
    refuse('malformed-declaration', `task.json declares ${criteria.length} criteria; this version records one verdict per run, so it adjudicates exactly one criterion`)
  const criterion = record(criteria[0], 'task.json.criteria[0]')
  const named = text(criterion, 'verifier', 'task.json.criteria[0]')
  const verifier = verifiers.find(entry => entry.ref === named)
  if (verifier === undefined)
    refuse('malformed-declaration', `criterion ${JSON.stringify(text(criterion, 'criterionId', 'task.json.criteria[0]'))} names the verifier ${JSON.stringify(named)}, which task.json does not declare`)

  return {
    dir,
    templateDigest: sha256(bytes),
    inputPath,
    program,
    artifact,
    verifier,
    verifiers,
    criterion: {
      criterionId: text(criterion, 'criterionId', 'task.json.criteria[0]'),
      statement: text(criterion, 'statement', 'task.json.criteria[0]'),
      verifierRef: verifier.ref,
      verifierVersion: verifier.version,
      implementationDigest: verifier.implementationDigest,
    },
  }
}
export function commandOf(verifier: DomainVerifier, artifactPath: string, inputPath: string): readonly string[] {
  const paths: Record<string, string> = { artifact: artifactPath, input: inputPath }
  return [process.execPath, verifier.program, ...verifier.args.map(arg => arg.replace(/\{(\w+)\}/g, (_, name: string) => paths[name]!))]
}
