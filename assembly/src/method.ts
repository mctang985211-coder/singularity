import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPinnedRevision } from '../../src/environment/binding.ts'
import {
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../../src/environment/protocol.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import {
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
  type RevisionRef,
  type RunState,
} from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import type { TaskTemplateRef } from '../../src/task/contract.ts'
import { assertTemplateSources, templateOf, type Domain } from './domain.ts'
import { list, record, text } from './shape.ts'
import { readTemplate, templateDeclaration, type TaskTemplate } from './template.ts'
import { verifierOf } from './verifiers.ts'
import { spawnProcess } from './process.ts'
import { sha256 } from './ids.ts'
import { assertVerifierRunnable, runVerifierSelftest } from '../../src/verifier/implementation.ts'
import type { TaskContract } from '../../src/task/contract.ts'

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
  readonly verifier?: { readonly samples: readonly { readonly name: string
      readonly artifactContent: string
      readonly inputContent: string
      readonly expected: 'pass' | 'fail' }[] }
}
export interface MethodAssets {
  readonly workflowGuidance: string
  readonly templates: readonly unknown[]
  readonly skills: readonly MethodSkill[]
  readonly tools: readonly MethodTool[]
}
export const METHOD_FORMAT = `Complete Method JSON: {workflowGuidance:string, templates:Template[], skills:Skill[], tools:Tool[]}.
All four fields are required. RSI proposal.template.method contains the complete current Method: edit it and retain every unchanged asset. This is a complete replacement, not a partial patch. Empty arrays explicitly remove their assets.
workflowGuidance is explicit reusable workflow advice, empty or at most 8192 UTF-8 bytes. Templates are optional patterns; an empty array is legal. Task contracts own goals, inputs and acceptance.
Skill: {name:kebab-case, description:string, capabilities:string[], requiredTools:string[], content:string}.
Tool: {name:kebab-case, source:string, verifier?:{samples:{name:string, artifactContent:string, inputContent:string, expected:'pass'|'fail'}[]}}.
Tool source is a Node ESM program: frozen input paths appear in contract order starting at argv[2], followed by the candidate path when supplied; stdout is the returned artifact text. singularity_run_method takes {tool,candidatePath?}, with candidatePath naming an existing workspace file. A verifier Tool receives the candidate path at argv[2] followed by frozen input paths, exiting 0 for pass or 1 for fail. Verifier samples and template checks each bind one named input, with both positive and negative samples required.
Template: {id:string, goal:string, artifact:string, inputs:{name:string,source:{kind:'protected',ref:string}|{kind:'artifact',template:string}}[], criteria:{criterionId:string,statement:string}[], skills:string[], capabilities:string[], guidance?:string, applicability?:string, decomposition?:{children:{key:string,template:string,dependsOn:string[],supports:string[],maxRuns:number,requirement:'required'|'exploration'}[]}, checks:{criterionId:string,verifier:string,input:string}[], initial?:{content:string}}.
goal defines responsibility; guidance gives optional procedure. Template reads return prefilled contracts with concrete input identities; decomposition submits that contract shape with optional template:{id,digest} provenance.
contract.skills and matching capabilities select Skills; capability names and selected Skills' requiredTools bind Tools. Binding happens at Run admission, even if no tool is called.
Each comparison freezes a caliber: model, bound tool names/versions/content digests, conditions and inputs, plus metric, weights, trials and judgement. Adding, removing or editing a root-bound tool changes caliber and excludes that candidate; unchanged tools retain their identity across method revisions. Keep root bindings unchanged for this comparison; helpers may be bound to delegated Tasks. A rejected candidate does not fail the round or replace the incumbent. Retrying it unchanged cannot help.
Root inputs, artifact, criteria, protected checks and initial source remain frozen.`
export interface MethodBindings {
  readonly skills: readonly { readonly name: string; readonly digest: string }[]
  readonly tools: readonly { readonly name: string; readonly digest: string }[]
  readonly gaps: readonly string[]
}
export function bindAssets(selection: { readonly skills: readonly string[]; readonly capabilities: readonly string[] }, assets: MethodAssets): MethodBindings {
  for (const name of selection.skills)
    if (!assets.skills.some((skill) => skill.name === name))
      refuse('malformed-declaration', `responsibility requires missing Skill ${name}`)
  const skills = assets.skills.filter((skill) => selection.skills.includes(skill.name))
  const requested = new Set(selection.capabilities)
  for (const skill of skills) for (const capability of skill.capabilities) requested.delete(capability)
  for (const skill of assets.skills) {
    if (!skill.capabilities.some((capability) => requested.has(capability))) continue
    skills.push(skill)
    for (const capability of skill.capabilities) requested.delete(capability)
  }
  const tools = assets.tools.filter(
    (tool) => selection.capabilities.includes(tool.name) || skills.some((skill) => skill.requiredTools.includes(tool.name)),
  )
  for (const tool of tools) requested.delete(tool.name)
  return { skills: skills.map((skill) => ({ name: skill.name, digest: digestOf(skill) })),
    tools: tools.map((tool) => ({ name: tool.name, digest: digestOf(tool) })), gaps: [...requested],
  }
}
export function bindingsForContract(contract: TaskContract, assets: MethodAssets): MethodBindings {
  return bindAssets({ skills: contract.skills ?? [], capabilities: contract.capabilities ?? [] }, assets)
}
export function methodToolReferences(apparatus: Apparatus, run: RunState): readonly string[] {
  return (run.bubble?.tools ?? []).filter((tool) => tool.name.startsWith('method:'))
    .map((tool) => join(apparatus.workspaceRoot, 'assets', run.revision.digest, `${tool.name.slice(7)}.mjs`))
}
export const methodEnvironment = (apparatus: Apparatus): string => `${apparatus.controlId}:methods`
async function frozenFile(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { mode: 0o400, flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readFile(path, 'utf8')) !== content) refuse('digest-mismatch', 'immutable asset bytes changed: ' + path)
  }
}
const names = (value: unknown, where: string): string[] => list(value, where).map((entry) => {
  if (typeof entry !== 'string' || entry.length === 0) refuse('malformed-declaration', `${where} must contain names`)
  return entry
})
/** Check the replacement envelope before a missing collection can look like asset deletion. */
export function assertMethodShape(raw: unknown): asserts raw is MethodAssets {
  const content = record(raw, 'method')
  assertClosedKeys(content, ['workflowGuidance', 'templates', 'skills', 'tools'], 'method', 'malformed-declaration')
  const missing = ['workflowGuidance', 'templates', 'skills', 'tools'].filter(key => !Object.hasOwn(content, key))
  if (missing.length) refuse('malformed-declaration', `Missing ${missing.map(key => `method.${key}`).join(', ')}. method must be a complete replacement; copy kind=method proposal.template.method and retain unchanged fields`)
  if (typeof content['workflowGuidance'] !== 'string' || Buffer.byteLength(content['workflowGuidance']) > 8192)
    refuse('malformed-declaration', 'method.workflowGuidance must be an explicit string of at most 8192 UTF-8 bytes')
  for (const field of ['templates', 'skills', 'tools']) list(content[field], `method.${field}`)
}
export async function parseMethod(domain: Domain, raw: unknown, assetRoot?: string,
): Promise<{ assets: MethodAssets; domain: Domain }> {
  assertMethodShape(raw)
  const content = raw
  const skills = content.skills.map((raw, index) => {
    const path = `method.skills[${index}]`, skill = record(raw, path)
    assertClosedKeys(skill, ['name', 'description', 'capabilities', 'requiredTools', 'content'], path, 'malformed-declaration',
    )
    const name = text(skill, 'name', path)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', `${path}.name must be kebab-case`)
    return { name, description: text(skill, 'description', path), content: text(skill, 'content', path),
      capabilities: names(skill['capabilities'], `${path}.capabilities`), requiredTools: names(skill['requiredTools'], `${path}.requiredTools`),
    }
  })
  const tools = content.tools.map((raw, index) => {
    const path = `method.tools[${index}]`, tool = record(raw, path)
    assertClosedKeys(tool, ['name', 'source', 'verifier'], path, 'malformed-declaration')
    const name = text(tool, 'name', path)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', `${path}.name must be kebab-case`)
    let verifier: MethodTool['verifier']
    if (tool['verifier'] !== undefined) {
      const declaration = record(tool['verifier'], `${path}.verifier`)
      assertClosedKeys(declaration, ['samples'], `${path}.verifier`, 'malformed-declaration')
      verifier = { samples: list(declaration['samples'], `${path}.verifier.samples`).map((raw, index) => {
        const samplePath = `${path}.verifier.samples[${index}]`, sample = record(raw, samplePath)
        assertClosedKeys(sample, ['name', 'artifactContent', 'inputContent', 'expected'], samplePath, 'malformed-declaration',
          )
        const expected = sample['expected']
        if (expected !== 'pass' && expected !== 'fail') refuse('malformed-declaration', `${samplePath}.expected must be pass or fail`)
        const artifactContent = sample['artifactContent'], inputContent = sample['inputContent']
        if (typeof artifactContent !== 'string' || typeof inputContent !== 'string')
          refuse('malformed-declaration', `${samplePath}.artifactContent and inputContent must be literal file contents`,
            )
        return { name: text(sample, 'name', samplePath), artifactContent, inputContent, expected }
      }),
      }
    }
    return { name, source: text(tool, 'source', path), ...(verifier === undefined ? {} : { verifier }) }
  })
  for (const assets of [skills, tools]) if (new Set(assets.map((asset) => asset.name)).size !== assets.length) refuse('malformed-declaration', 'Revision repeats asset names')
  for (const skill of skills) for (const name of skill.requiredTools)
    if (!tools.some((tool) => tool.name === name)) refuse('malformed-declaration', `Skill ${skill.name} requires unavailable Tool ${name}`)
  const workflowGuidance = content['workflowGuidance']
  const assets: MethodAssets = { workflowGuidance, templates: content.templates, skills, tools,
  }
  const verifiers = [...domain.verifiers]
  if (assetRoot === undefined) for (const tool of tools) {
    if (tool.verifier === undefined) continue
    if (verifiers.some(verifier => verifier.ref === tool.name)) refuse('malformed-declaration', 'generated verifier cannot replace a protected verifier')
    const samples = tool.verifier.samples.map((sample, index) => ({ name: sample.name, expected: sample.expected,
      input: { subject: `${tool.name}:${index}`, artifactDigest: sha256(sample.artifactContent),
        inputs: [{ name: 'input', digest: sha256(sample.inputContent) }] } }))
    const verifier = { ref: tool.name, version: sha256(tool.source), implementationDigest: sha256(tool.source),
      program: `${tool.name}.mjs`, args: ['{artifact}', '{input}'], selftest: { samples },
      judge: async (): Promise<never> => refuse('illegal-transition', 'unmaterialized verifier cannot execute') }
    assertVerifierRunnable(verifier)
    verifiers.push(verifier)
  }
  if (assetRoot !== undefined) {
    await mkdir(assetRoot, { recursive: true })
    for (const tool of tools) {
      await frozenFile(join(assetRoot, `${tool.name}.mjs`), tool.source)
      if (tool.verifier === undefined) continue
      if (verifiers.some((verifier) => verifier.ref === tool.name)) refuse('malformed-declaration', 'generated verifier cannot replace a protected verifier')
      const selftest = []
      for (const [index, sample] of tool.verifier.samples.entries()) {
        const artifact = `${tool.name}-${index}-artifact`, input = `${tool.name}-${index}-input`
        await frozenFile(join(assetRoot, artifact), sample.artifactContent)
        await frozenFile(join(assetRoot, input), sample.inputContent)
        selftest.push({ name: sample.name, artifact, argv: [artifact, input], expected: sample.expected })
      }
      verifiers.push(await verifierOf(assetRoot, { ref: tool.name, version: sha256(tool.source), program: `${tool.name}.mjs`, args: ['{artifact}', '{input}'], selftest,
          },
          'generated verifier',
          (invocation) => spawnProcess(invocation, undefined, assetRoot, { root: assetRoot, writable: false, protected: [], references: domain.references,
            }),
        ),
      )
    }
  }
  const templates = new Map<string, TaskTemplate>()
  for (const [index, rawTemplate] of assets.templates.entries()) {
    const path = `method.templates[${index}]`, declared = record(rawTemplate, path)
    if (declared['initial'] !== undefined && record(declared['initial'], 'template initial')['from'] !== undefined)
      refuse('malformed-declaration', 'Revision initial source must be frozen as initial.content')
    const template = await readTemplate(domain.dir, rawTemplate, verifiers, path)
    if (templates.has(template.id)) refuse('malformed-declaration', 'Revision repeats template ' + template.id)
    const original = domain.templates.get(template.id)
    if (template.id === domain.rootTemplate && original !== undefined) {
      if (digestOf(original.inputs) !== digestOf(template.inputs) || digestOf(original.criteria) !== digestOf(template.criteria) ||
        digestOf(original.checks.map(({ criterion, input }) => ({ criterion, input }))) !== digestOf(template.checks.map(({ criterion, input }) => ({ criterion, input }))) ||
        original.artifact !== template.artifact)
        refuse('malformed-declaration', 'Revision cannot change protected input or acceptance')
      if ((template.initial === undefined ? null : sha256(template.initial.bytes)) !==
        (original.initial === undefined ? null : sha256(original.initial.bytes)))
        refuse('malformed-declaration', 'Revision cannot replace the protected initial root source')
    }
    for (const skill of template.skills) if (!skills.some((asset) => asset.name === skill)) refuse('malformed-declaration', `template ${template.id} requires missing Skill ${skill}`)
    templates.set(template.id, template)
  }
  const loaded: Domain = { ...domain, contractTemplates: domain.templates, templates, verifiers,
  }
  assertTemplateSources(loaded)
  return { assets, domain: loaded }
}
export async function createMethod(apparatus: Apparatus, raw: unknown): Promise<RevisionRef> {
  const digest = digestOf(raw)
  const revisionId = `method-${digest.slice(0, 24)}`
  const environmentId = methodEnvironment(apparatus)
  const loaded = await parseMethod(apparatus.domain, raw, join(apparatus.workspaceRoot, 'assets', digest))
  for (const verifier of loaded.domain.verifiers.filter((held) =>
    loaded.assets.tools.some((tool) => tool.verifier !== undefined && tool.name === held.ref),
  )) {
    assertVerifierRunnable(verifier)
    const selftest = await runVerifierSelftest(verifier)
    if (selftest.failures.length !== 0) refuse('unregistered-verifier', `generated verifier ${verifier.ref} fails its positive/negative samples: ${JSON.stringify(selftest.failures)}`,
      )
  }
  await apparatus.environments.createRevision({ commandId: `method:${digest}`, environmentId, revisionId, manifest: loaded.assets,
  })
  for (const verifier of loaded.domain.verifiers) {
    if (!apparatus.implementations.some((held) => held.implementationDigest === verifier.implementationDigest)) {
      apparatus.implementations.push(verifier)
      apparatus.store.declareSubject(`verifier:${verifier.ref}@${verifier.version}`, `${apparatus.controlId}:verifier:${verifier.ref}@${verifier.version}`,
      )
    }
  }
  return { environmentId, revisionId, digest: digestOf(loaded.assets) }
}
export async function seedMethod(apparatus: Apparatus, initial?: unknown): Promise<RevisionRef> {
  const published = publishedMethod(apparatus)
  if (published !== undefined) return published
  const seed = await createMethod(apparatus, initial ?? { workflowGuidance: '',
    templates: [...apparatus.domain.templates.values()].map(templateDeclaration), skills: [], tools: [],
  })
  if (publishedMethod(apparatus) === undefined)
    await apparatus.store.emit({
      commandId: 'seed:initialize',
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.pointerSwitched,
      subject: seed.environmentId,
      payload: { expected: '', to: seed.revisionId },
    })
  return seed
}
export async function loadMethod(apparatus: Apparatus, revision: RevisionRef, provenance?: TaskTemplateRef,
): Promise<{ assets: MethodAssets; domain: Domain }> {
  if (revision.environmentId !== methodEnvironment(apparatus)) refuse('unknown-revision', 'Revision belongs to another asset library')
  const held = assertPinnedRevision(revision, apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'load Revision',
  )
  const loaded = await parseMethod(apparatus.domain, held.manifest, join(apparatus.workspaceRoot, 'assets', revision.digest),
  )
  // Task provenance survives method edits. Resolve exact content from the same immutable library.
  if (provenance !== undefined && loaded.domain.templates.get(provenance.id)?.digest !== provenance.digest &&
    loaded.domain.contractTemplates?.get(provenance.id)?.digest !== provenance.digest) {
    const library = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, revision.environmentId)!
    for (const source of Object.values(library.revisions)) {
      if (source.contentDigest === revision.digest) continue
      const parsed = await parseMethod(apparatus.domain, source.manifest)
      if (parsed.domain.templates.get(provenance.id)?.digest !== provenance.digest) continue
      const frozen = (await loadMethod(apparatus, { environmentId: revision.environmentId,
        revisionId: source.revisionId, digest: source.contentDigest })).domain.templates.get(provenance.id)!
      const templates = new Map(loaded.domain.contractTemplates)
      templates.set(frozen.id, frozen)
      loaded.domain = { ...loaded.domain, contractTemplates: templates,
        verifiers: [...loaded.domain.verifiers, ...frozen.checks.map(check => check.verifier)
          .filter(verifier => !loaded.domain.verifiers.some(held => held.ref === verifier.ref && held.version === verifier.version))] }
      break
    }
    templateOf(loaded.domain, provenance)
  }
  for (const verifier of loaded.domain.verifiers) {
    if (!apparatus.implementations.some(
        (existing) => existing.ref === verifier.ref && existing.version === verifier.version,
      )) {
      apparatus.implementations.push(verifier)
      apparatus.store.declareSubject(`verifier:${verifier.ref}@${verifier.version}`, `${apparatus.controlId}:verifier:${verifier.ref}@${verifier.version}`,
      )
    }
  }
  return loaded
}
export function publishedMethod(apparatus: Apparatus): RevisionRef | undefined {
  const library = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))
  return library?.pointer === undefined ? undefined : { environmentId: library.environmentId, revisionId: library.pointer, digest: library.revisions[library.pointer]!.contentDigest,
      }
}
export async function methodForRun(apparatus: Apparatus, run: RunState,
): Promise<{
  reference: RevisionRef
  assets: MethodAssets
  domain: Domain
  bindings: MethodBindings
}> {
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].find(
    (task) => task.runs[run.runId] !== undefined,
  )!
  const { assets, domain } = await loadMethod(apparatus, run.revision, task.contract!.template)
  return {
    reference: run.revision,
    assets,
    domain,
    bindings: bindingsForContract(task.contract!, assets),
  }
}
