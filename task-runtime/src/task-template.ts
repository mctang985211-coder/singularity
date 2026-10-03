/** The task template library: JSON files, pinned references and parameter binding before normal admission. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { canonicalize, taskTemplateDigest, parseCatalogPath, parseTemplateScope, catalogPathWithin } from '@dangosys/dsh-singularity-task'
import type {
  TaskContractInput, TaskTemplate, TaskTemplateRef, TemplateParameters,
  CatalogPath, TemplateScope,
} from '@dangosys/dsh-singularity-task'
import { contractDefects } from './admission.ts'
import { isPlainObject, nonBlank } from './helpers.ts'
import { normalizeRootContract, normalizeDecomposition } from './normalize.ts'
import type { DecomposeSpec } from './types.ts'

/** The sole default for production and Evolution: the runtime resolves this once at construction. */
export function defaultTaskTemplatesRoot(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'singularity', 'task-templates')
}

export interface TaskTemplateMatch {
  templateRef: TaskTemplateRef
  template: TaskTemplate
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)
}

/** Reject unsupported schema vocabulary rather than claiming to validate it. */
export function parseTaskTemplate(raw: unknown): TaskTemplate {
  if (!isPlainObject(raw)) throw new Error('task-template: template must be an object')
  if (Object.keys(raw).some(key => !['id', 'version', 'catalogPath', 'appliesTo', 'parametersSchema', 'contract', 'decomposition'].includes(key))) {
    throw new Error('task-template: template declares an unknown field')
  }
  parseCatalogPath(raw.catalogPath)
  if ((raw.catalogPath as string[])[0] === 'general' && (raw.catalogPath as string[]).length !== 1)
    throw new Error('task-template: general templates use catalogPath ["general"]')
  if (!validId(raw.id) || !Number.isSafeInteger(raw.version) || (raw.version as number) < 1) {
    throw new Error('task-template: id must be a filename-safe name and version a positive integer')
  }
  if (!Array.isArray(raw.appliesTo) || raw.appliesTo.length === 0 || raw.appliesTo.some(item => !nonBlank(item))) {
    throw new Error(`task-template: ${raw.id} requires non-empty appliesTo conditions`)
  }
  const schema = raw.parametersSchema
  if (!isPlainObject(schema) || schema.type !== 'object' || schema.additionalProperties !== false ||
    !isPlainObject(schema.properties) ||
    Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))) {
    throw new Error(`task-template: ${raw.id} parametersSchema requires object properties and additionalProperties:false`)
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) ||
    schema.required.some(name => typeof name !== 'string' || !Object.hasOwn(schema.properties as object, name)))) {
    throw new Error(`task-template: ${raw.id} required parameters must name declared properties`)
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(name) || !isPlainObject(property) ||
      !['string', 'number', 'integer', 'boolean'].includes(String(property.type)) ||
      Object.keys(property).some(key => !['type', 'description', 'enum'].includes(key)) ||
      (property.description !== undefined && typeof property.description !== 'string') ||
      (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.length === 0 ||
        property.enum.some(value => !parameterTypeMatches(value, String(property.type)))))) {
      throw new Error(`task-template: ${raw.id} parameter ${name} has an unsupported schema`)
    }
  }
  if (!isPlainObject(raw.contract) || Object.keys(raw.contract).some(key =>
    !['objective', 'acceptanceCriteria', 'assumptions', 'constraints', 'requiredCapabilities'].includes(key))) {
    throw new Error(`task-template: ${raw.id} contract declares an unknown field`)
  }
  const normalized = normalizeRootContract(raw.contract)
  if (!normalized.ok) throw new Error(`task-template: ${raw.id} contract: ${normalized.reasons.join('; ')}`)
  // Protected paths are authoring data here; their digests are fixed against the instance checkout at intake.
  const defects = contractDefects(normalized.contract.acceptanceCriteria.map(({ protectedInputs: _paths, ...criterion }) => criterion), `template ${raw.id}`)
  if (defects.length > 0) throw new Error(`task-template: ${defects.join('; ')}`)
  if (raw.decomposition !== undefined) {
    if (!isPlainObject(raw.decomposition) || !Array.isArray(raw.decomposition.children))
      throw new Error(`task-template: ${raw.id} decomposition requires a direct-child proposal`)
    const children = raw.decomposition.children.map(child => {
      if (!isPlainObject(child) || child.templateRef === undefined) return child
      const allowed = ['templateRef', 'templateParameters', 'templateScope', 'dependsOn', 'decomposable', 'requiresIndependentAcceptance']
      if (Object.keys(child).some(key => !allowed.includes(key)))
        throw new Error('task-template: a decomposition child cannot override its template contract')
      return { ...child, objective: 'bound child contract', acceptanceCriteria: [{ description: 'bound child acceptance', command: 'true' }] }
    })
    const normalized = normalizeDecomposition({ ...raw.decomposition, children }, {
      storeId: 'template', parentTaskId: 'template', parentRunId: 'template', callerSessionId: 'template',
      admissionContext: { maxDepth: 0, maxChildren: children.length, auditOnly: {} },
    })
    if (!normalized.ok) throw new Error(`task-template: ${raw.id} decomposition: ${normalized.reasons.join('; ')}`)
  }
  for (const match of canonicalize([raw.contract, raw.decomposition]).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
    if (!Object.hasOwn(schema.properties, match[1]!)) {
      throw new Error(`task-template: ${raw.id} references undeclared parameter ${match[1]}`)
    }
  }
  return structuredClone(raw) as unknown as TaskTemplate
}

function parameterTypeMatches(value: unknown, type: string): boolean {
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

/** Append one immutable version. An identical repeat returns the same reference. */
export async function registerTaskTemplate(root: string, input: TaskTemplate): Promise<TaskTemplateRef> {
  const template = parseTaskTemplate(input)
  const ref = { id: template.id, version: template.version, digest: taskTemplateDigest(template) }
  await mkdir(root, { recursive: true })
  const file = join(root, `${ref.id}@${ref.version}.json`)
  try {
    await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const stored = parseTaskTemplate(JSON.parse(await readFile(file, 'utf8')))
    if (taskTemplateDigest(stored) !== ref.digest) {
      throw new Error(`task-template: ${ref.id}@${ref.version} already exists with different content; publish a new version`)
    }
  }
  return ref
}

/** Return the newest version of each id. Conditions are read by the caller; keyword search is only discovery. */
export async function findTaskTemplates(root: string | undefined, query?: string, scope?: TemplateScope): Promise<TaskTemplateMatch[]> {
  if (root === undefined) return []
  let files: string[]
  try {
    files = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const newest = new Map<string, TaskTemplateMatch>()
  for (const file of files.filter(file => file.endsWith('.json')).sort()) {
    const template = parseTaskTemplate(JSON.parse(await readFile(join(root, file), 'utf8')))
    if (file !== `${template.id}@${template.version}.json`) {
      throw new Error(`task-template: ${file} must be named ${template.id}@${template.version}.json`)
    }
    const previous = newest.get(template.id)
    if (previous === undefined || previous.template.version < template.version) {
      newest.set(template.id, {
        template,
        templateRef: { id: template.id, version: template.version, digest: taskTemplateDigest(template) },
      })
    }
  }
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return [...newest.values()].filter(({ template }) => {
    if (!templateVisible(template.catalogPath, scope)) return false
    const searchable = `${template.id}\n${template.appliesTo.join('\n')}\n${template.contract.objective}`.toLowerCase()
    return words.length === 0 || words.some(word => searchable.includes(word))
  }).sort((left, right) => left.template.id.localeCompare(right.template.id))
}

/** Expand into the same authoring fields as a free contract; no template-specific execution path follows. */
export async function bindTaskTemplate<T extends TaskContractInput>(root: string | undefined, spec: T, scope?: TemplateScope): Promise<T & TaskContractInput> {
  // Ordinary input shape belongs to normalization; binding only handles template declarations.
  if (!isPlainObject(spec)) return spec
  const selected = spec.templateScope === undefined ? scope : parseTemplateScope(spec.templateScope)
  if (scope !== undefined && selected?.some(path => !templateVisible(path, scope)))
    throw new Error('task-template: child templateScope cannot widen its parent scope')
  if (spec.templateRef === undefined) {
    if (spec.templateParameters !== undefined) throw new Error('task-template: templateParameters requires templateRef')
    return selected === undefined ? spec : { ...spec, templateScope: structuredClone(selected) }
  }
  const { template, parameters, ref, bind } = await readBinding(root, spec, selected)
  const templateScope = selected ?? (template.catalogPath[0] === 'general' ? undefined : [template.catalogPath])
  return {
    ...spec,
    ...bind(template.contract) as TaskTemplate['contract'],
    ...(templateScope === undefined ? {} : { templateScope: structuredClone(templateScope) }),
    templateRef: structuredClone(ref),
    templateParameters: structuredClone(parameters),
  }
}

/** The same exact reference, parameter and visibility checks bind contracts and direct-child proposals. */
async function readBinding(root: string | undefined, spec: TaskContractInput, scope?: TemplateScope) {
  const ref = spec.templateRef!
  const template = await readReferencedTemplate(root, ref, scope)
  for (const field of ['objective', 'acceptanceCriteria', 'assumptions', 'constraints', 'requiredCapabilities']) {
    if (Object.hasOwn(spec, field)) throw new Error(`task-template: ${field} cannot override a template contract`)
  }
  const parameters = spec.templateParameters ?? {}
  if (!isPlainObject(parameters)) throw new Error('task-template: templateParameters must be an object')
  for (const name of template.parametersSchema.required ?? []) {
    if (!Object.hasOwn(parameters, name)) throw new Error(`task-template: missing required parameter ${name}`)
  }
  for (const [name, value] of Object.entries(parameters)) {
    const property = template.parametersSchema.properties[name]
    if (!Object.hasOwn(template.parametersSchema.properties, name) || property === undefined ||
      !parameterTypeMatches(value, property.type) || (property.enum !== undefined && !property.enum.includes(value))) {
      throw new Error(`task-template: parameter ${name} does not satisfy parametersSchema`)
    }
  }
  const bind = (value: unknown, typedParameter = false): unknown => {
    if (typeof value === 'string') {
      const exact = typedParameter ? /^\{\{([a-zA-Z0-9_]+)\}\}$/.exec(value) : null
      if (exact !== null) {
        if (!Object.hasOwn(parameters, exact[1]!)) throw new Error(`task-template: unbound parameter ${exact[1]}`)
        return parameters[exact[1]!]
      }
      return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => {
        if (!Object.hasOwn(parameters, name)) throw new Error(`task-template: unbound parameter ${name}`)
        return String(parameters[name])
      })
    }
    if (Array.isArray(value)) return value.map(item => bind(item, typedParameter))
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, typedParameter || key === 'templateParameters')]))
    return value
  }
  return { template, parameters: parameters as TemplateParameters, ref, bind }
}

/** Exact lookup and binding share reference, content and caller-authority checks. */
async function readReferencedTemplate(root: string | undefined, ref: TaskTemplateRef, scope?: TemplateScope): Promise<TaskTemplate> {
  if (root === undefined) throw new Error('task-template: taskTemplatesRoot is not configured')
  if (!isPlainObject(ref) || !validId(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 ||
    typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest) ||
    Object.keys(ref).some(key => !['id', 'version', 'digest'].includes(key))) {
    throw new Error('task-template: templateRef requires id, positive version and SHA-256 digest')
  }
  const template = parseTaskTemplate(JSON.parse(await readFile(join(root, `${ref.id}@${ref.version}.json`), 'utf8')))
  if (!templateVisible(template.catalogPath, scope)) throw new Error('task-template: templateRef is outside the caller templateScope')
  if (template.id !== ref.id || template.version !== ref.version || taskTemplateDigest(template) !== ref.digest) {
    throw new Error(`task-template: ${ref.id}@${ref.version} content does not match its pinned reference`)
  }
  return template
}

export async function bindTaskDecomposition(root: string | undefined, spec: DecomposeSpec, scope?: TemplateScope): Promise<DecomposeSpec> {
  if (!isPlainObject(spec) || spec.templateRef === undefined) return spec
  if (Object.hasOwn(spec, 'reason') || Object.hasOwn(spec, 'children'))
    throw new Error('task-template: reason and children cannot override a template decomposition')
  const { template, parameters, ref, bind } = await readBinding(root, spec, scope)
  if (template.decomposition === undefined) throw new Error('task-template: selected template has no decomposition')
  return { ...spec, ...bind(template.decomposition) as DecomposeSpec, templateRef: structuredClone(ref), templateParameters: structuredClone(parameters) }
}

function templateVisible(path: CatalogPath, scope?: TemplateScope): boolean {
  return path[0] === 'general' || scope === undefined || scope.some(prefix => catalogPathWithin(path, prefix))
}

export interface TaskTemplateQuery {
  query?: string
  catalogPath?: CatalogPath
  templateRef?: TaskTemplateRef
  offset?: number
  limit?: number
}

export interface TaskTemplateCatalogPage {
  templateScope: TemplateScope | null
  entries: ({ kind: 'catalog'; catalogPath: CatalogPath; templates: number } | {
    kind: 'template'; templateRef: TaskTemplateRef; catalogPath: CatalogPath; appliesTo: string[];
    objective: string; parameters: string[]; decomposition: boolean
  })[]
  total: number
  offset: number
  nextOffset: number | null
  message?: string
}

export function taskTemplatePage(root: string | undefined, request: TaskTemplateQuery & { templateRef: TaskTemplateRef }, scope?: TemplateScope): Promise<TaskTemplateMatch>
export function taskTemplatePage(root: string | undefined, request?: Omit<TaskTemplateQuery, 'templateRef'> & { templateRef?: undefined }, scope?: TemplateScope): Promise<TaskTemplateCatalogPage>
export function taskTemplatePage(root: string | undefined, request: TaskTemplateQuery, scope?: TemplateScope): Promise<TaskTemplateMatch | TaskTemplateCatalogPage>
/** Bounded catalog and summary pages; exact references are the sole full-template read. No catalog files or index are written. */
export async function taskTemplatePage(root: string | undefined, request: TaskTemplateQuery = {}, scope?: TemplateScope): Promise<TaskTemplateMatch | TaskTemplateCatalogPage> {
  const path = request.catalogPath === undefined ? undefined : parseCatalogPath(request.catalogPath)
  if (path !== undefined && !templateVisible(path, scope)) throw new Error('task-template: catalogPath is outside the caller templateScope')
  if (request.templateRef !== undefined) {
    const ref = request.templateRef
    const template = await readReferencedTemplate(root, ref, scope)
    if (path !== undefined && !catalogPathWithin(template.catalogPath, path))
      throw new Error('task-template: templateRef is outside the caller templateScope')
    return { templateRef: ref, template }
  }
  const offset = request.offset ?? 0
  const limit = request.limit ?? 10
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new Error('task-template: offset must be non-negative and limit between 1 and 20')
  const matches = await findTaskTemplates(root, request.query, scope)
  const filtered = path === undefined ? matches : matches.filter(item => catalogPathWithin(item.template.catalogPath, path))
  const categories = new Map<string, { catalogPath: CatalogPath; templates: number }>()
  for (const { template } of filtered) {
    const prefix = scope?.find(prefix => catalogPathWithin(template.catalogPath, prefix))
    const category = template.catalogPath.slice(0, path === undefined ? (prefix?.length ?? 1) : path.length + 1)
    const key = category.join('/')
    const entry = categories.get(key) ?? { catalogPath: category, templates: 0 }
    entry.templates += 1
    categories.set(key, entry)
  }
  const catalog = [...categories.values()].sort((a, b) => a.catalogPath.join('/').localeCompare(b.catalogPath.join('/')))
  // Before root intake, browse category summaries first; select a branch to inspect its templates.
  const summaries = scope === undefined && path === undefined ? [] : filtered.map(({ templateRef, template }) => ({
    templateRef, catalogPath: template.catalogPath, appliesTo: template.appliesTo.slice(0, 3).map(text => text.slice(0, 300)),
    objective: template.contract.objective.slice(0, 500), parameters: Object.keys(template.parametersSchema.properties).slice(0, 12),
    decomposition: template.decomposition !== undefined,
  }))
  const entries = [...catalog.map(item => ({ kind: 'catalog' as const, ...item })), ...summaries.map(item => ({ kind: 'template' as const, ...item }))]
  const page = { templateScope: scope ?? null, entries: entries.slice(offset, offset + limit), total: entries.length, offset,
    nextOffset: null as number | null,
    message: filtered.length === 0 ? 'No matching Task template. A complete standard contract is allowed.' : undefined }
  // Whole entries remain pageable when escaping or Unicode makes a count-limited page unusually large.
  for (;;) {
    page.nextOffset = offset + page.entries.length < entries.length ? offset + page.entries.length : null
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') <= 40_000 || page.entries.length <= 1) break
    page.entries.pop()
  }
  return page
}
