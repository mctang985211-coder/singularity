import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPinnedRevision } from '../../src/environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { RevisionRef, RunState } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { assertTemplateSources, type Domain } from './domain.ts'
import { list, record, text } from './shape.ts'
import { readTemplate, type TaskTemplate } from './template.ts'
import { templateDeclaration } from './read.ts'
import { verifierOf } from './verifiers.ts'
import { spawnProcess } from './process.ts'
import { sha256 } from './ids.ts'
import { assertVerifierRunnable, runVerifierSelftest } from '../../src/verifier/implementation.ts'
import { IMPROVEMENT_TEMPLATE, REVIEW_TEMPLATE } from './review.ts'

export interface MethodSkill {
  readonly name: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly requiredTools: readonly string[]
  readonly content: string
}
export interface MethodTool {
  readonly name: string
  readonly source: string
  readonly verifier?: { readonly samples: readonly { readonly name: string; readonly artifactContent: string; readonly inputContent: string; readonly expected: 'pass' | 'fail' }[] }
}
export interface MethodAssets {
  readonly rootTemplate: string
  readonly templates: readonly unknown[]
  readonly skills: readonly MethodSkill[]
  readonly tools: readonly MethodTool[]
}
export interface MethodBindings {
  readonly skills: readonly { readonly name: string; readonly digest: string }[]
  readonly tools: readonly { readonly name: string; readonly digest: string }[]
  readonly gaps: readonly string[]
}
export function bindAssets(template: TaskTemplate, assets: MethodAssets): MethodBindings {
  const skills = assets.skills.filter(skill => template.skills.includes(skill.name))
  const requested = new Set(template.capabilities)
  for (const skill of skills) for (const capability of skill.capabilities) requested.delete(capability)
  for (const skill of assets.skills) {
    if (!skill.capabilities.some(capability => requested.has(capability))) continue
    skills.push(skill)
    for (const capability of skill.capabilities) requested.delete(capability)
  }
  const tools = assets.tools.filter(tool => requested.has(tool.name) || skills.some(skill => skill.requiredTools.includes(tool.name)))
  for (const tool of tools) requested.delete(tool.name)
  return { skills: skills.map(skill => ({ name: skill.name, digest: digestOf(skill) })),
    tools: tools.map(tool => ({ name: tool.name, digest: digestOf(tool) })), gaps: [...requested] }
}
export const methodEnvironment = (apparatus: Apparatus): string => `${apparatus.controlId}:methods`
async function frozenFile(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { mode: 0o400, flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== content) refuse('digest-mismatch', 'immutable asset bytes changed: ' + path)
  }
}
const names = (value: unknown, where: string): string[] => list(value, where).map(entry => {
  if (typeof entry !== 'string' || entry.length === 0) refuse('malformed-declaration', `${where} must contain names`)
  return entry
})
export async function parseMethod(domain: Domain, raw: unknown, assetRoot?: string): Promise<{ assets: MethodAssets; domain: Domain }> {
  const content = record(raw, 'Revision')
  assertClosedKeys(content, ['rootTemplate', 'templates', 'skills', 'tools'], 'Revision', 'malformed-declaration')
  const skills = list(content['skills'], 'Revision.skills').map((raw, index) => {
    const skill = record(raw, `skills[${index}]`)
    assertClosedKeys(skill, ['name', 'description', 'capabilities', 'requiredTools', 'content'], 'Skill', 'malformed-declaration')
    const name = text(skill, 'name', 'Skill')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', 'Skill name must be kebab-case')
    return { name, description: text(skill, 'description', 'Skill'), content: text(skill, 'content', 'Skill'),
      capabilities: names(skill['capabilities'], 'Skill.capabilities'), requiredTools: names(skill['requiredTools'], 'Skill.requiredTools') }
  })
  const tools = list(content['tools'], 'Revision.tools').map(raw => {
    const tool = record(raw, 'Tool')
    assertClosedKeys(tool, ['name', 'source', 'verifier'], 'Tool', 'malformed-declaration')
    const name = text(tool, 'name', 'Tool')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', 'Tool name must be kebab-case')
    let verifier: MethodTool['verifier']
    if (tool['verifier'] !== undefined) {
      const declaration = record(tool['verifier'], 'Tool.verifier')
      assertClosedKeys(declaration, ['samples'], 'Tool.verifier', 'malformed-declaration')
      verifier = { samples: list(declaration['samples'], 'Tool.verifier.samples').map(raw => {
        const sample = record(raw, 'verifier sample')
        assertClosedKeys(sample, ['name', 'artifactContent', 'inputContent', 'expected'], 'verifier sample', 'malformed-declaration')
        const expected = sample['expected']
        if (expected !== 'pass' && expected !== 'fail') refuse('malformed-declaration', 'verifier samples require positive and negative verdicts')
        const artifactContent = sample['artifactContent'], inputContent = sample['inputContent']
        if (typeof artifactContent !== 'string' || typeof inputContent !== 'string')
          refuse('malformed-declaration', 'verifier sample artifactContent and inputContent must be literal file contents')
        return { name: text(sample, 'name', 'sample'), artifactContent, inputContent, expected }
      }) }
    }
    return { name, source: text(tool, 'source', 'Tool'), ...(verifier === undefined ? {} : { verifier }) }
  })
  for (const assets of [skills, tools]) if (new Set(assets.map(asset => asset.name)).size !== assets.length) refuse('malformed-declaration', 'Revision repeats asset names')
  for (const skill of skills) for (const name of skill.requiredTools)
    if (!tools.some(tool => tool.name === name)) refuse('malformed-declaration', `Skill ${skill.name} requires unavailable Tool ${name}`)
  const assets: MethodAssets = { rootTemplate: text(content, 'rootTemplate', 'Revision'), templates: list(content['templates'], 'Revision.templates'), skills, tools }
  if (assets.rootTemplate !== domain.rootTemplate) refuse('malformed-declaration', 'Revision cannot change the protected root template')
  const verifiers = [...domain.verifiers]
  if (tools.some(tool => tool.verifier !== undefined) && assetRoot === undefined) refuse('malformed-declaration', 'generated verifiers require an asset workspace')
  if (assetRoot !== undefined) {
    await mkdir(assetRoot, { recursive: true })
    for (const tool of tools) {
      await frozenFile(join(assetRoot, `${tool.name}.mjs`), tool.source)
      if (tool.verifier === undefined) continue
      if (verifiers.some(verifier => verifier.ref === tool.name)) refuse('malformed-declaration', 'generated verifier cannot replace a protected verifier')
      const selftest = []
      for (const [index, sample] of tool.verifier.samples.entries()) {
        const artifact = `${tool.name}-${index}-artifact`, input = `${tool.name}-${index}-input`
        await frozenFile(join(assetRoot, artifact), sample.artifactContent)
        await frozenFile(join(assetRoot, input), sample.inputContent)
        selftest.push({ name: sample.name, artifact, argv: [artifact, input], expected: sample.expected })
      }
      verifiers.push(await verifierOf(assetRoot, { ref: tool.name, version: sha256(tool.source), program: `${tool.name}.mjs`, args: ['{artifact}', '{input}'], selftest }, 'generated verifier', invocation => spawnProcess(invocation, undefined, assetRoot, { root: assetRoot, writable: false, protected: [], references: [domain.dir, ...domain.references] })))
    }
  }
  const templates = new Map<string, TaskTemplate>()
  for (const rawTemplate of assets.templates) {
    const declared = record(rawTemplate, 'Revision template')
    const workspace = record(declared['workspace'], 'template workspace')
    if (workspace['initial'] !== undefined) refuse('malformed-declaration', 'Revision initial source must be frozen as initialContent')
    const template = await readTemplate(domain.dir, rawTemplate, verifiers, 'Revision template')
    if (templates.has(template.id)) refuse('malformed-declaration', 'Revision repeats template ' + template.id)
    const original = domain.templates.get(template.id)
    if ([domain.rootTemplate, REVIEW_TEMPLATE, IMPROVEMENT_TEMPLATE].includes(template.id) && original !== undefined &&
      (digestOf(original.input) !== digestOf(template.input) || digestOf(original.criterion) !== digestOf(template.criterion)))
      refuse('malformed-declaration', 'Revision cannot change protected input or acceptance')
    if (template.id === domain.rootTemplate && (template.initial === undefined ? null : sha256(template.initial.bytes)) !==
      (original!.initial === undefined ? null : sha256(original!.initial.bytes)))
      refuse('malformed-declaration', 'Revision cannot replace the protected initial root source with a precomputed answer')
    for (const skill of template.skills) if (!skills.some(asset => asset.name === skill)) refuse('malformed-declaration', `template ${template.id} requires missing Skill ${skill}`)
    templates.set(template.id, template)
  }
  for (const id of [REVIEW_TEMPLATE, IMPROVEMENT_TEMPLATE])
    if (!templates.has(id)) refuse('malformed-declaration', 'Revision lacks infrastructure template ' + id)
  const loaded: Domain = { ...domain, templates, verifiers, references: [...domain.references, ...(assetRoot === undefined ? [] : [assetRoot])] }
  assertTemplateSources(loaded)
  return { assets, domain: loaded }
}
export async function createMethod(apparatus: Apparatus, raw: unknown): Promise<RevisionRef> {
  const digest = digestOf(raw)
  const revisionId = `method-${digest.slice(0, 24)}`
  const environmentId = methodEnvironment(apparatus)
  const loaded = await parseMethod(apparatus.domain, raw, join(apparatus.workspaceRoot, 'assets', digest))
  for (const verifier of loaded.domain.verifiers.filter(held => loaded.assets.tools.some(tool => tool.verifier !== undefined && tool.name === held.ref))) {
    assertVerifierRunnable(verifier)
    const selftest = await runVerifierSelftest(verifier)
    if (selftest.failures.length !== 0) refuse('unregistered-verifier', `generated verifier ${verifier.ref} fails its positive/negative samples: ${JSON.stringify(selftest.failures)}`)
  }
  await apparatus.environments.createRevision({ commandId: `method:${digest}`, environmentId, revisionId, manifest: loaded.assets })
  for (const verifier of loaded.domain.verifiers) {
    if (!apparatus.implementations.some(held => held.implementationDigest === verifier.implementationDigest)) {
      apparatus.implementations.push(verifier)
      apparatus.store.declareSubject(`verifier:${verifier.ref}@${verifier.version}`, `${apparatus.controlId}:verifier:${verifier.ref}@${verifier.version}`)
    }
  }
  return { environmentId, revisionId, digest: digestOf(loaded.assets) }
}
export async function seedMethod(apparatus: Apparatus): Promise<RevisionRef> {
  return createMethod(apparatus, { rootTemplate: apparatus.domain.rootTemplate,
    templates: [...apparatus.domain.templates.values()].map(templateDeclaration), skills: [], tools: [] })
}
export async function loadMethod(apparatus: Apparatus, revision: RevisionRef): Promise<{ assets: MethodAssets; domain: Domain }> {
  if (revision.environmentId !== methodEnvironment(apparatus)) refuse('unknown-revision', 'Revision belongs to another asset library')
  const held = assertPinnedRevision(revision, apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'load Revision')
  const loaded = await parseMethod(apparatus.domain, held.manifest, join(apparatus.workspaceRoot, 'assets', revision.digest))
  for (const verifier of loaded.domain.verifiers) {
    if (!apparatus.implementations.some(existing => existing.ref === verifier.ref && existing.version === verifier.version)) {
      apparatus.implementations.push(verifier)
      apparatus.store.declareSubject(`verifier:${verifier.ref}@${verifier.version}`, `${apparatus.controlId}:verifier:${verifier.ref}@${verifier.version}`)
    }
  }
  return loaded
}
export function publishedMethod(apparatus: Apparatus): RevisionRef | undefined {
  const library = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))
  return library?.pointer === undefined ? undefined : { environmentId: library.environmentId, revisionId: library.pointer, digest: library.revisions[library.pointer]!.contentDigest }
}
export function methodOfRun(apparatus: Apparatus, run: RunState): RevisionRef | undefined {
  return manifestOfRun(apparatus, run).method
}
interface RunManifest {
  readonly method?: RevisionRef
  readonly bindings: MethodBindings
  readonly context?: { readonly inputs: readonly { readonly ref: string; readonly digest: string; readonly content: string }[] }
}
function manifestOfRun(apparatus: Apparatus, run: RunState): RunManifest {
  return assertPinnedRevision(run.revision, apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'read Run context').manifest as RunManifest
}
function frozenDomain(domain: Domain, { context }: RunManifest): Domain {
  if (context === undefined) return domain
  const inputs = context.inputs.map(input => {
    const bytes = Buffer.from(input.content, 'base64')
    if (sha256(bytes) !== input.digest) refuse('digest-mismatch', 'frozen context input changed')
    return { ref: input.ref, digest: input.digest, bytes, sourcePath: '' }
  })
  return { ...domain, inputs: [...domain.inputs.filter(held => !inputs.some(input => input.ref === held.ref)), ...inputs] }
}
export async function methodForRun(apparatus: Apparatus, run: RunState): Promise<{
  reference: RevisionRef; assets: MethodAssets; domain: Domain; bindings: MethodBindings
}> {
  const manifest = manifestOfRun(apparatus, run)
  if (manifest.method === undefined) refuse('unknown-revision', 'Run has no asset Revision')
  const { assets, domain } = await loadMethod(apparatus, manifest.method)
  return { reference: manifest.method, assets, domain: frozenDomain(domain, manifest), bindings: manifest.bindings }
}
export async function domainForRun(apparatus: Apparatus, run: RunState): Promise<Domain> {
  const manifest = manifestOfRun(apparatus, run)
  const domain = manifest.method === undefined ? apparatus.domain : (await loadMethod(apparatus, manifest.method)).domain
  return frozenDomain(domain, manifest)
}
