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
import { assertTemplateSources, type Domain } from './domain.ts'
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
  readonly rootTemplate: string
  readonly templates: readonly unknown[]
  readonly skills: readonly MethodSkill[]
  readonly tools: readonly MethodTool[]
}
export const METHOD_FORMAT = `Candidate JSON: {rootTemplate:string, templates:Template[], skills:Skill[], tools:Tool[]}.
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
export async function parseMethod(domain: Domain, raw: unknown, assetRoot?: string,
): Promise<{ assets: MethodAssets; domain: Domain }> {
  const content = record(raw, 'Revision')
  assertClosedKeys(content, ['rootTemplate', 'templates', 'skills', 'tools'], 'Revision', 'malformed-declaration')
  const skills = list(content['skills'], 'Revision.skills').map((raw, index) => {
    const skill = record(raw, `skills[${index}]`)
    assertClosedKeys(skill, ['name', 'description', 'capabilities', 'requiredTools', 'content'], 'Skill', 'malformed-declaration',
    )
    const name = text(skill, 'name', 'Skill')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', 'Skill name must be kebab-case')
    return { name, description: text(skill, 'description', 'Skill'), content: text(skill, 'content', 'Skill'),
      capabilities: names(skill['capabilities'], 'Skill.capabilities'), requiredTools: names(skill['requiredTools'], 'Skill.requiredTools'),
    }
  })
  const tools = list(content['tools'], 'Revision.tools').map((raw) => {
    const tool = record(raw, 'Tool')
    assertClosedKeys(tool, ['name', 'source', 'verifier'], 'Tool', 'malformed-declaration')
    const name = text(tool, 'name', 'Tool')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) refuse('malformed-declaration', 'Tool name must be kebab-case')
    let verifier: MethodTool['verifier']
    if (tool['verifier'] !== undefined) {
      const declaration = record(tool['verifier'], 'Tool.verifier')
      assertClosedKeys(declaration, ['samples'], 'Tool.verifier', 'malformed-declaration')
      verifier = { samples: list(declaration['samples'], 'Tool.verifier.samples').map((raw) => {
        const sample = record(raw, 'verifier sample')
        assertClosedKeys(sample, ['name', 'artifactContent', 'inputContent', 'expected'], 'verifier sample', 'malformed-declaration',
          )
        const expected = sample['expected']
        if (expected !== 'pass' && expected !== 'fail') refuse('malformed-declaration', 'verifier samples require positive and negative verdicts')
        const artifactContent = sample['artifactContent'], inputContent = sample['inputContent']
        if (typeof artifactContent !== 'string' || typeof inputContent !== 'string')
          refuse('malformed-declaration', 'verifier sample artifactContent and inputContent must be literal file contents',
            )
        return { name: text(sample, 'name', 'sample'), artifactContent, inputContent, expected }
      }),
      }
    }
    return { name, source: text(tool, 'source', 'Tool'), ...(verifier === undefined ? {} : { verifier }) }
  })
  for (const assets of [skills, tools]) if (new Set(assets.map((asset) => asset.name)).size !== assets.length) refuse('malformed-declaration', 'Revision repeats asset names')
  for (const skill of skills) for (const name of skill.requiredTools)
    if (!tools.some((tool) => tool.name === name)) refuse('malformed-declaration', `Skill ${skill.name} requires unavailable Tool ${name}`)
  const assets: MethodAssets = { rootTemplate: text(content, 'rootTemplate', 'Revision'), templates: list(content['templates'], 'Revision.templates'), skills, tools,
  }
  if (assets.rootTemplate !== domain.rootTemplate) refuse('malformed-declaration', 'Revision cannot change the protected root template')
  const verifiers = [...domain.verifiers]
  if (tools.some((tool) => tool.verifier !== undefined) && assetRoot === undefined) refuse('malformed-declaration', 'generated verifiers require an asset workspace')
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
  for (const rawTemplate of assets.templates) {
    const declared = record(rawTemplate, 'Revision template')
    if (declared['initial'] !== undefined && record(declared['initial'], 'template initial')['from'] !== undefined)
      refuse('malformed-declaration', 'Revision initial source must be frozen as initial.content')
    const template = await readTemplate(domain.dir, rawTemplate, verifiers, 'Revision template')
    if (templates.has(template.id)) refuse('malformed-declaration', 'Revision repeats template ' + template.id)
    const original = domain.templates.get(template.id)
    if (
      template.id === domain.rootTemplate && original !== undefined &&
      (digestOf(original.inputs) !== digestOf(template.inputs) || digestOf(original.criteria) !== digestOf(template.criteria) ||
        digestOf(original.checks.map(({ criterion, input }) => ({ criterion, input }))) !== digestOf(template.checks.map(({ criterion, input }) => ({ criterion, input }))) ||
        original.artifact !== template.artifact))
      refuse('malformed-declaration', 'Revision cannot change protected input or acceptance')
    if (template.id === domain.rootTemplate && (template.initial === undefined ? null : sha256(template.initial.bytes)) !==
      (original!.initial === undefined ? null : sha256(original!.initial.bytes)))
      refuse('malformed-declaration', 'Revision cannot replace the protected initial root source with a precomputed answer',
      )
    for (const skill of template.skills) if (!skills.some((asset) => asset.name === skill)) refuse('malformed-declaration', `template ${template.id} requires missing Skill ${skill}`)
    templates.set(template.id, template)
  }
  const loaded: Domain = { ...domain, templates, verifiers,
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
  const seed = await createMethod(apparatus, initial ?? { rootTemplate: apparatus.domain.rootTemplate,
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
export async function loadMethod(apparatus: Apparatus, revision: RevisionRef,
): Promise<{ assets: MethodAssets; domain: Domain }> {
  if (revision.environmentId !== methodEnvironment(apparatus)) refuse('unknown-revision', 'Revision belongs to another asset library')
  const held = assertPinnedRevision(revision, apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'load Revision',
  )
  const loaded = await parseMethod(apparatus.domain, held.manifest, join(apparatus.workspaceRoot, 'assets', revision.digest),
  )
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
  const { assets, domain } = await loadMethod(apparatus, run.revision)
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].find(
    (task) => task.runs[run.runId] !== undefined,
  )!
  return {
    reference: run.revision,
    assets,
    domain,
    bindings: bindingsForContract(task.contract!, assets),
  }
}
