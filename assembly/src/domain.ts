import { join } from 'node:path'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { TaskTemplateRef } from '../../src/task/contract.ts'
import type { BubbleWorld } from './bubble.ts'
import type { VerifierInvocation, VerifierProcess } from '../../src/verifier/command.ts'
import type { VerifierImplementation } from '../../src/verifier/implementation.ts'
import { sha256 } from './ids.ts'
import { inside, list, readBytes, record, text } from './shape.ts'
import { readTemplate, type TaskTemplate } from './template.ts'
import { verifierOf } from './verifiers.ts'
import { loadMeasurement, type DomainMeasurement } from './domain-measurement.ts'
import { assertDecomposition } from '../../src/task/decomposition.ts'
import { parseSuite, type Suite } from '../../src/measure/suite.ts'
import { containsPath } from './bubble.ts'
import { realpath } from 'node:fs/promises'

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
  readonly references: readonly string[]
  readonly verifierReferences?: readonly string[]
  readonly rootTemplate?: string
  readonly inputs: readonly DomainInput[]
  readonly templates: ReadonlyMap<string, TaskTemplate>
  readonly contractTemplates?: ReadonlyMap<string, TaskTemplate>
  readonly verifiers: readonly DomainVerifier[]
  readonly measurement?: DomainMeasurement
  readonly suite?: Suite
}
export async function loadDomain(dir: string, runProcess: (invocation: VerifierInvocation, signal?: AbortSignal, cwd?: string, world?: BubbleWorld) => ReturnType<VerifierProcess>): Promise<Domain> {
  const declaration = join(dir, 'task.json')
  const bytes = await readBytes(declaration, 'the domain declaration')
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch (error) {
    refuse('malformed-declaration', `${declaration} is not JSON (${String(error)})`)
  }
  const declared = record(parsed, 'task.json')
  assertClosedKeys(declared, ['rootTemplate', 'inputs', 'templates', 'verifiers', 'measurement', 'references', 'verifierReferences', 'suite'], 'task.json', 'malformed-declaration')
  const referencesOf = (field: string) => declared[field] === undefined ? [] : list(declared[field], `task.json.${field}`).map(value => {
    if (typeof value !== 'string' || value.length === 0) refuse('malformed-declaration', 'references must be nonempty paths')
    return value === '.' ? dir : value.startsWith('/') ? value : inside(dir, value, `task.json.${field}`)
  })
  const references = referencesOf('references'), verifierReferences = referencesOf('verifierReferences')
  for (const hidden of verifierReferences) {
    let canonical: string
    try { canonical = await realpath(hidden) } catch { refuse('malformed-declaration', `verifier reference does not exist: ${hidden}`) }
    for (const shared of [dir, ...references]) {
      const publicPath = await realpath(shared)
      if (containsPath(publicPath, canonical) || containsPath(canonical, publicPath))
        refuse('malformed-declaration', 'verifier-only reference must not overlap the domain directory or a shared reference')
    }
  }
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
    const verifier = await verifierOf(dir, entry, `task.json.verifiers[${index}]`, invocation => runProcess(invocation, undefined, dir, { root: dir, writable: false, protected: [], references: [...references, ...verifierReferences] }))
    if (verifiers.some(other => other.ref === verifier.ref)) refuse('malformed-declaration', `task.json repeats verifier ${JSON.stringify(verifier.ref)}`)
    verifiers.push(verifier)
  }
  const templates = new Map<string, TaskTemplate>()
  for (const [index, entry] of list(declared['templates'], 'task.json.templates').entries()) {
    const template = await readTemplate(dir, entry, verifiers, `task.json.templates[${index}]`)
    if (templates.has(template.id)) refuse('malformed-declaration', `task.json repeats template ${JSON.stringify(template.id)}`)
    templates.set(template.id, template)
  }
  const rootTemplate = declared['rootTemplate'] === undefined ? undefined : text(declared, 'rootTemplate', 'task.json')
  const root = rootTemplate === undefined ? undefined : templates.get(rootTemplate)
  if (rootTemplate !== undefined && root === undefined) refuse('malformed-declaration', `task.json.rootTemplate names absent template ${JSON.stringify(rootTemplate)}`)
  const measurement = declared['measurement'] === undefined ? undefined
    : await loadMeasurement(inside(dir, text(declared, 'measurement', 'task.json'), 'task.json.measurement'))
  let suite: Suite | undefined
  if (declared['suite'] !== undefined) {
    const path = inside(dir, text(declared, 'suite', 'task.json'), 'suite')
    const canonical = await realpath(path)
    for (const ref of references) if (containsPath(await realpath(ref), canonical))
      refuse('malformed-declaration', 'private suite must not be mounted as a worker reference')
    suite = parseSuite(JSON.parse((await readBytes(path, 'suite')).toString('utf8')))
    if (suite.scoring !== undefined && measurement !== undefined)
      refuse('malformed-declaration', 'choose criteria scoring or a domain measurement, not both')
    if (measurement === undefined ? suite.failureQuality !== 0 : measurement.direction === 'lower' && suite.failureQuality <= 0)
      refuse('malformed-declaration', 'failureQuality must be 0 for pass scoring and a positive worst-case penalty for lower-is-better measurements')
    for (const c of suite.cases) for (const input of c.contract.inputs) {
      const source = input.source
      if (source.kind !== 'protected' || !inputs.some(held => held.ref === source.ref && held.digest === source.digest))
        refuse('malformed-declaration', `case ${c.caseId} requires unavailable frozen inputs`)
    }
  }
  const domain = { references, ...(verifierReferences.length === 0 ? {} : { verifierReferences }), dir, ...(rootTemplate === undefined ? {} : { rootTemplate }), inputs, templates, verifiers,
    ...(suite === undefined ? {} : { suite }), ...(measurement === undefined ? {} : { measurement }) }
  assertTemplateSources(domain)
  return domain
}
export function assertTemplateSources(domain: Domain): void {
  const { templates, inputs } = domain
  for (const template of templates.values()) {
    if (template.decomposition !== undefined) {
      const children = template.decomposition.children
      assertDecomposition(children.map(child => ({ taskId: `child:${child.key}`,
        dependsOn: child.dependsOn.map(key => `child:${key}`), supports: child.supports, maxRuns: child.maxRuns, requirement: child.requirement })),
      { criteria: template.criteria }, `parent:${template.id}`)
      const byKey = new Map(children.map(child => [child.key, child]))
      for (const child of children) {
        const selected = templates.get(child.template)
        if (selected === undefined) refuse('malformed-declaration', `template ${template.id} decomposes into absent template ${child.template}`)
        for (const { source } of selected.inputs)
          if (source.kind === 'artifact' && child.dependsOn.filter(key => byKey.get(key)!.template === source.template).length !== 1)
            refuse('malformed-declaration', `template ${template.id} child ${child.key} requires exactly one producer with template ${source.template}`)
      }
    }
    for (const { source } of template.inputs)
      if (source.kind === 'protected' ? !inputs.some(input => input.ref === source.ref) : !templates.has(source.template))
        refuse('malformed-declaration', `template ${JSON.stringify(template.id)} names absent ${source.kind} source ${JSON.stringify(source.kind === 'protected' ? source.ref : source.template)}`)
  }
  const visited = new Set<string>(), path = new Set<string>()
  const visit = (template: TaskTemplate): void => {
    if (path.has(template.id)) refuse('malformed-declaration', `template artifact sources contain a cycle through ${JSON.stringify(template.id)}`)
    if (visited.has(template.id)) return
    path.add(template.id)
    for (const { source } of template.inputs) if (source.kind === 'artifact') visit(templates.get(source.template)!)
    path.delete(template.id)
    visited.add(template.id)
  }
  for (const template of templates.values()) visit(template)
}
export function templateOf(domain: Domain, reference: TaskTemplateRef): TaskTemplate {
  const current = domain.templates.get(reference.id)
  const template = current?.digest === reference.digest ? current : domain.contractTemplates?.get(reference.id)
  if (template === undefined || template.digest !== reference.digest)
    refuse('malformed-declaration', `template ${JSON.stringify(reference.id)} does not match its admitted content identity`)
  return template
}
export function commandOf(verifier: DomainVerifier, artifactPath: string, inputPath: string): readonly string[] {
  const paths: Record<string, string> = { artifact: artifactPath, input: inputPath }
  return [process.execPath, verifier.program, ...verifier.args.map(arg => arg.replace(/\{(\w+)\}/g, (_, name: string) => paths[name]!))]
}
