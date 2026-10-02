/** The task template library: JSON files, pinned references and parameter binding before normal admission. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { canonicalize, taskTemplateDigest } from '@dangosys/dsh-singularity-task'
import type {
  TaskContractInput, TaskTemplate, TaskTemplateRef, TemplateParameters,
} from '@dangosys/dsh-singularity-task'
import { contractDefects } from './admission.ts'
import { isPlainObject, nonBlank } from './helpers.ts'
import { normalizeRootContract } from './normalize.ts'

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
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)
}

/** Reject unsupported schema vocabulary rather than claiming to validate it. */
export function parseTaskTemplate(raw: unknown): TaskTemplate {
  if (!isPlainObject(raw)) throw new Error('task-template: template must be an object')
  if (Object.keys(raw).some(key => !['id', 'version', 'appliesTo', 'parametersSchema', 'contract'].includes(key))) {
    throw new Error('task-template: template declares an unknown field')
  }
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
    if (!/^[a-zA-Z0-9_]+$/.test(name) || !isPlainObject(property) ||
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
  for (const match of canonicalize(raw.contract).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
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
export async function findTaskTemplates(root: string | undefined, query?: string): Promise<TaskTemplateMatch[]> {
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
    const searchable = `${template.id}\n${template.appliesTo.join('\n')}\n${template.contract.objective}`.toLowerCase()
    return words.length === 0 || words.some(word => searchable.includes(word))
  }).sort((left, right) => left.template.id.localeCompare(right.template.id))
}

/** Expand into the same authoring fields as a free contract; no template-specific execution path follows. */
export async function bindTaskTemplate<T extends TaskContractInput>(root: string | undefined, spec: T): Promise<T & TaskContractInput> {
  // Ordinary input shape belongs to normalization; binding only handles template declarations.
  if (!isPlainObject(spec)) return spec
  if (spec.templateRef === undefined) {
    if (spec.templateParameters !== undefined) throw new Error('task-template: templateParameters requires templateRef')
    return spec
  }
  const ref = spec.templateRef
  if (root === undefined) throw new Error('task-template: taskTemplatesRoot is not configured')
  if (!isPlainObject(ref) || !validId(ref.id) || !Number.isSafeInteger(ref.version) || ref.version < 1 ||
    typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest) ||
    Object.keys(ref).some(key => !['id', 'version', 'digest'].includes(key))) {
    throw new Error('task-template: templateRef requires id, positive version and SHA-256 digest')
  }
  for (const field of ['objective', 'acceptanceCriteria', 'assumptions', 'constraints', 'requiredCapabilities']) {
    if (Object.hasOwn(spec, field)) throw new Error(`task-template: ${field} cannot override a template contract`)
  }
  const template = parseTaskTemplate(JSON.parse(await readFile(join(root, `${ref.id}@${ref.version}.json`), 'utf8')))
  if (template.id !== ref.id || template.version !== ref.version || taskTemplateDigest(template) !== ref.digest) {
    throw new Error(`task-template: ${ref.id}@${ref.version} content does not match its pinned reference`)
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
  const bind = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => {
      if (!Object.hasOwn(parameters, name)) throw new Error(`task-template: unbound parameter ${name}`)
      return String(parameters[name])
    })
    if (Array.isArray(value)) return value.map(bind)
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)]))
    return value
  }
  return {
    ...spec,
    ...bind(template.contract) as TaskTemplate['contract'],
    templateRef: structuredClone(ref),
    templateParameters: structuredClone(parameters) as TemplateParameters,
  }
}
