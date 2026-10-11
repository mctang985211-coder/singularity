import { assertPinnedRevision } from '../../src/environment/binding.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { RevisionRef, RunState } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { assertTemplateSources, type Domain } from './domain.ts'
import { list, record, text } from './shape.ts'
import { readTemplate, type TaskTemplate } from './template.ts'

export interface MethodAssets {
  readonly rootTemplate: string
  readonly templates: readonly unknown[]
  readonly skill: string
  readonly tool: string
}
export const methodEnvironment = (apparatus: Apparatus): string => `${apparatus.controlId}:methods`

export async function parseMethod(domain: Domain, raw: unknown): Promise<{ assets: MethodAssets; domain: Domain }> {
  const content = record(raw, 'Method')
  assertClosedKeys(content, ['rootTemplate', 'templates', 'skill', 'tool'], 'Method', 'malformed-declaration')
  const assets: MethodAssets = { rootTemplate: text(content, 'rootTemplate', 'Method'),
    templates: list(content['templates'], 'Method.templates'), skill: text(content, 'skill', 'Method'), tool: text(content, 'tool', 'Method') }
  if (assets.rootTemplate !== domain.rootTemplate) refuse('malformed-declaration', 'a Method cannot change the deployment root template')
  const templates = new Map<string, TaskTemplate>()
  for (const [index, rawTemplate] of assets.templates.entries()) {
    const declared = record(rawTemplate, `Method.templates[${index}]`)
    const workspace = record(declared['workspace'], 'Method template workspace')
    if (workspace['initial'] !== undefined)
      refuse('malformed-declaration', 'Method template content cannot reference a mutable initial file')
    const template = await readTemplate(domain.dir, rawTemplate, domain.verifiers, `Method.templates[${index}]`)
    if (templates.has(template.id)) refuse('malformed-declaration', 'Method repeats template ' + template.id)
    const original = domain.templates.get(template.id)
    if (original !== undefined && (digestOf(original.input) !== digestOf(template.input) || digestOf(original.criterion) !== digestOf(template.criterion)))
      refuse('malformed-declaration', 'a Method cannot change the protected input or acceptance of template ' + template.id)
    templates.set(template.id, template)
  }
  const loaded: Domain = { ...domain, templates }
  assertTemplateSources(loaded)
  return { assets, domain: loaded }
}

export async function createMethod(apparatus: Apparatus, raw: unknown): Promise<RevisionRef> {
  const { assets } = await parseMethod(apparatus.domain, raw)
  const digest = digestOf(assets)
  const revisionId = `method-${digest.slice(0, 24)}`
  const environmentId = methodEnvironment(apparatus)
  await apparatus.environments.createRevision({ commandId: `method:${digest}`, environmentId, revisionId, manifest: assets })
  return { environmentId, revisionId, digest }
}

export async function loadMethod(apparatus: Apparatus, revision: RevisionRef): Promise<{ assets: MethodAssets; domain: Domain }> {
  if (revision.environmentId !== methodEnvironment(apparatus)) refuse('unknown-revision', 'the Method belongs to a different library')
  const held = assertPinnedRevision(revision,
    apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'load Method')
  return parseMethod(apparatus.domain, held.manifest)
}

export function publishedMethod(apparatus: Apparatus): RevisionRef | undefined {
  const library = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))
  if (library?.pointer === undefined) return undefined
  return { environmentId: library.environmentId, revisionId: library.pointer, digest: library.revisions[library.pointer]!.contentDigest }
}

export function methodOfRun(apparatus: Apparatus, run: RunState): RevisionRef | undefined {
  const revision = assertPinnedRevision(run.revision,
    apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION), 'read Run method')
  return (revision.manifest as { method?: RevisionRef }).method
}

export async function domainForRun(apparatus: Apparatus, run: RunState): Promise<Domain> {
  const method = methodOfRun(apparatus, run)
  return method === undefined ? apparatus.domain : (await loadMethod(apparatus, method)).domain
}
