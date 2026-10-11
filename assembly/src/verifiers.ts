/**
 * Declaring a verifier: the program whose bytes are its identity, the template its judgement is invoked
 * with, and the samples that prove it can produce both verdicts.
 *
 * The samples are read here rather than at the call site because a selftest's digests have to be the
 * digests of the bytes actually declared — computed from the files, never taken from the declaration.
 *
 * @module @dangosys/dsh-singularity-next/verifiers
 */

import { refuse } from '../../src/protocol/refusal.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { runVerifierCommand, type VerifierProcess } from '../../src/verifier/command.ts'
import type { VerifierInput, VerifierSelftestSample, VerifierVerdict } from '../../src/verifier/implementation.ts'
import type { DomainVerifier } from './domain.ts'
import { sha256 } from './ids.ts'
import { inside, list, nonEmpty, readBytes, record, text } from './shape.ts'

async function samplesOf(dir: string, entries: readonly unknown[], where: string): Promise<{ samples: VerifierSelftestSample[]; argv: Map<string, readonly string[]> }> {
  const samples: VerifierSelftestSample[] = []
  const argv = new Map<string, readonly string[]>()
  for (const [index, entry] of entries.entries()) {
    const at = `${where}.selftest[${index}]`
    const declared = record(entry, at)
    assertClosedKeys(declared, ['name', 'artifact', 'argv', 'expected'], at, 'malformed-declaration')
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
export async function verifierOf(dir: string, entry: unknown, where: string, runProcess: VerifierProcess): Promise<DomainVerifier> {
  const declared = record(entry, where)
  assertClosedKeys(declared, ['ref', 'version', 'program', 'args', 'selftest'], where, 'malformed-declaration')
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
/** The verifier a declaration names, or a refusal naming the one it asked for. */
export function requireVerifier(verifiers: readonly DomainVerifier[], named: string, where: string): DomainVerifier {
  const resolved = verifiers.find(entry => entry.ref === named)
  if (resolved === undefined)
    refuse('malformed-declaration', `${where} names the verifier ${JSON.stringify(named)}, which task.json does not declare`)
  return resolved
}
