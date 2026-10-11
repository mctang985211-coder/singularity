import { join } from 'node:path'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { TaskTemplateRef } from '../../src/task/contract.ts'
import type { VerifierProcess } from '../../src/verifier/command.ts'
import type { VerifierImplementation } from '../../src/verifier/implementation.ts'
import { sha256 } from './ids.ts'
import { inside, list, readBytes, record, text } from './shape.ts'
import { readTemplate, type TaskTemplate } from './template.ts'
import { verifierOf } from './verifiers.ts'

export interface DomainVerifier extends VerifierImplementation {
  readonly program: string
  readonly args: readonly string[]
}
export interface DomainInput {
  readonly ref: string
  readonly sourcePath: string
  readonly digest: string
  readonly bytes: Uint8Array
}
export interface Domain {
  readonly dir: string
  readonly rootTemplate: string
  readonly inputs: readonly DomainInput[]
  readonly templates: ReadonlyMap<string, TaskTemplate>
  readonly verifiers: readonly DomainVerifier[]
}
export async function loadDomain(dir: string, runProcess: VerifierProcess): Promise<Domain> {
  const declaration = join(dir, 'task.json')
  const bytes = await readBytes(declaration, 'the domain declaration')
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch (error) {
    refuse('malformed-declaration', `${declaration} is not JSON (${String(error)})`)
  }
  const declared = record(parsed, 'task.json')
  assertClosedKeys(declared, ['rootTemplate', 'inputs', 'templates', 'verifiers'], 'task.json', 'malformed-declaration')
  const inputs: DomainInput[] = []
  for (const [index, entry] of list(declared['inputs'], 'task.json.inputs').entries()) {
    const at = `task.json.inputs[${index}]`
    const input = record(entry, at)
    assertClosedKeys(input, ['ref', 'from'], at, 'malformed-declaration')
    const ref = text(input, 'ref', at)
    if (inputs.some(input => input.ref === ref)) refuse('malformed-declaration', `${at} repeats protected source ${JSON.stringify(ref)}`)
    const sourcePath = text(input, 'from', at)
    const bytes = await readBytes(inside(dir, sourcePath, `${at}.from`), `the input ${JSON.stringify(sourcePath)}`)
    inputs.push({ ref, sourcePath, digest: sha256(bytes), bytes })
  }
  const verifiers: DomainVerifier[] = []
  for (const [index, entry] of list(declared['verifiers'], 'task.json.verifiers').entries()) {
    const verifier = await verifierOf(dir, entry, `task.json.verifiers[${index}]`, runProcess)
    if (verifiers.some(other => other.ref === verifier.ref)) refuse('malformed-declaration', `task.json repeats verifier ${JSON.stringify(verifier.ref)}`)
    verifiers.push(verifier)
  }
  const templates = new Map<string, TaskTemplate>()
  for (const [index, entry] of list(declared['templates'], 'task.json.templates').entries()) {
    const template = await readTemplate(dir, entry, verifiers, `task.json.templates[${index}]`)
    if (templates.has(template.id)) refuse('malformed-declaration', `task.json repeats template ${JSON.stringify(template.id)}`)
    templates.set(template.id, template)
  }
  const rootTemplate = text(declared, 'rootTemplate', 'task.json')
  const root = templates.get(rootTemplate)
  if (root === undefined) refuse('malformed-declaration', `task.json.rootTemplate names absent template ${JSON.stringify(rootTemplate)}`)
  if (root.input.source.kind !== 'protected') refuse('malformed-declaration', 'the root template must read a protected source')
  for (const template of templates.values()) {
    const source = template.input.source
    if (source.kind === 'protected' ? !inputs.some(input => input.ref === source.ref) : !templates.has(source.template))
      refuse('malformed-declaration', `template ${JSON.stringify(template.id)} names absent ${source.kind} source ${JSON.stringify(source.kind === 'protected' ? source.ref : source.template)}`)
  }
  for (const template of templates.values()) {
    const seen = new Set<string>()
    let current = template
    while (current.input.source.kind === 'artifact') {
      if (seen.has(current.id)) refuse('malformed-declaration', `template artifact sources contain a cycle through ${JSON.stringify(current.id)}`)
      seen.add(current.id)
      current = templates.get(current.input.source.template)!
    }
  }
  return { dir, rootTemplate, inputs, templates, verifiers }
}
export function templateOf(domain: Domain, reference: TaskTemplateRef): TaskTemplate {
  const template = domain.templates.get(reference.id)
  if (template === undefined || template.digest !== reference.digest)
    refuse('malformed-declaration', `template ${JSON.stringify(reference.id)} does not match its admitted content identity`)
  return template
}
export function commandOf(verifier: DomainVerifier, artifactPath: string, inputPath: string): readonly string[] {
  const paths: Record<string, string> = { artifact: artifactPath, input: inputPath }
  return [process.execPath, verifier.program, ...verifier.args.map(arg => arg.replace(/\{(\w+)\}/g, (_, name: string) => paths[name]!))]
}
