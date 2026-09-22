/**
 * The typed skill sidecar contract: the declaration that sits beside a skill's
 * `SKILL.md` (`SKILL.contract.json`) and says what kind of skill it is, what it
 * provides, and exactly which bytes it is.
 *
 * Why a sidecar exists at all (guide §2.4): DSH's `SKILL.md` carries both
 * executable capability and domain knowledge, and the two need different
 * guarantees. An execution skill must name the capabilities it serves, the real
 * DSH tools it needs, and the registered verifier that judges its result, so a
 * caller can refuse it *before* a run rather than discovering the gap at spawn.
 * A knowledge skill has no execution verifier and must not pretend to have one:
 * it declares where its content comes from, what it applies to, and how to
 * check the content, and it never closes an execution gap.
 *
 * The identities here are content identities, on the same discipline as the
 * task contract (`./contract.ts`): the digest covers exact bytes — no trim, no
 * newline conversion — and a skill whose directory holds a file the
 * declaration does not cover is not "mostly covered"; it is refused. A reader
 * must never be able to summarize one file and silently miss another part of
 * what a worker will read.
 *
 * This module owns the vocabulary and the shape rules only (both are pure): the
 * filesystem load, the identity comparison against real bytes, and the unified
 * pre-check live in `task-runtime/src/sidecar.ts`, which consumes these
 * definitions instead of restating them.
 * @module @dangosys/dsh-singularity-task/skill-contract
 */

import { canonicalize, sha256Hex } from './contract.ts'

/**
 * The sidecar file, read as JSON, named exactly here so every producer and
 * reader of a skill directory agrees on one spelling.
 */
export const SKILL_SIDECAR_FILE = 'SKILL.contract.json'

/**
 * The sidecar contract version this build writes and reads. Like the task
 * contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
 * skill: a sidecar declaring a version this build does not know is refused
 * rather than read with the wrong field semantics.
 */
export const SKILL_CONTRACT_VERSION = 1 as const

/** Every version of {@link SkillSidecar} this build can write or read. */
export type SkillContractVersion = typeof SKILL_CONTRACT_VERSION

/**
 * The directories a skill may hold supporting files in. The supported shape is
 * deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
 * be described by the identity without inventing rules for directories, and an
 * unsupported shape has to be refused by name rather than skipped.
 */
export const SUPPORTED_SKILL_RESOURCE_DIRS: readonly string[] = ['references', 'scripts']

/**
 * Whether one declared resource path is a path this contract can identify:
 * exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
 * POSIX separators, no `.`/`..` segment, nothing absolute. Anything else —
 * nested trees, a second segment, backslashes, a bare directory — is outside
 * the supported shape and is refused by name.
 */
export function isSupportedSkillResourcePath(path: string): boolean {
  const segments = path.split('/')
  if (segments.length !== 2) return false
  const [directory, file] = segments as [string, string]
  if (!SUPPORTED_SKILL_RESOURCE_DIRS.includes(directory)) return false
  return file.length > 0 && file !== '.' && file !== '..' && !file.includes('\\')
}

/**
 * One supporting file's identity: where it is inside the skill directory and the
 * SHA-256 of its exact bytes.
 */
export interface SkillResourceIdentity {
  /** Path relative to the skill directory, POSIX separators, `<dir>/<file>` per {@link isSupportedSkillResourcePath}. */
  path: string
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string
}

/**
 * What a sidecar claims about the bytes a worker will read: the `SKILL.md`
 * itself plus every supported resource, in one sorted list. A skill directory
 * holding a file this identity does not name is refused by the loader — the
 * point of the identity is that it covers the content, not most of it.
 */
export interface SkillContentIdentity {
  /** SHA-256 of the exact `SKILL.md` bytes. */
  skillMdSha256: string
  /** Every supported resource the identity covers, sorted by `path`, each path once. */
  resources: readonly SkillResourceIdentity[]
}

/**
 * One declared input or output of an execution skill. Ports are named in the
 * skill's own vocabulary; the runtime does not resolve them against artifacts
 * or inputs in v1, so they are a readable contract, not a wiring.
 */
export interface SkillPort {
  /** Port name. */
  name: string
  /** What the port carries, in the author's words, stored verbatim. */
  description: string
  /** Whether the port must be satisfied for the skill to apply. */
  required: boolean
}

/**
 * The registered judge an execution skill's result is verified by. Only the ref
 * is bound in v1: the registry exposes its ids (`VerifierRegistry.verifierIds()`)
 * and no per-ref version, so a version declared here could not be checked and
 * would be a field nobody consumes.
 */
export interface SkillVerifierRef {
  /** Verifier id the registry is queried under; an unknown ref makes the skill an invalid provider. */
  ref: string
}

/** An execution skill: it provides capabilities and is judged by a verifier. */
export interface ExecutionSkillSidecar {
  contractVersion: SkillContractVersion
  type: 'execution'
  /** Capability names this skill serves; at least one, each unique. */
  capabilities: readonly string[]
  /** What must hold before the skill applies, verbatim. */
  precondition: string
  /** Declared inputs; `[]` when the skill declares none. */
  inputs: readonly SkillPort[]
  /** Declared outputs; `[]` when the skill declares none. */
  outputs: readonly SkillPort[]
  /** Real DSH tool names the skill needs, in the same vocabulary a capability expands to. */
  requiredTools: readonly string[]
  verifier: SkillVerifierRef
  content: SkillContentIdentity
}

/**
 * How a knowledge skill's content is checked. v1 knows one kind, `command`: a
 * check the deciding gate runs in the skill directory and reads the exit code
 * of. Nothing in this module — or in the loader — executes it; the reference is
 * validated as a declaration and carried, never run as a side effect of
 * validation.
 */
export interface KnowledgeContentCheck {
  /** The one check kind this build recognizes. */
  kind: 'command'
  /** The command line, verbatim, to be executed by the gate that owns the decision. */
  command: string
}

/**
 * A knowledge skill: guidance a worker may read, with no execution verifier and
 * no place in the execution closure. It declares its source and scope so a
 * reader can judge where the content came from and what it applies to.
 */
export interface KnowledgeSkillSidecar {
  contractVersion: SkillContractVersion
  type: 'knowledge'
  /** Where the content comes from, verbatim. */
  source: string
  /** What the content applies to, verbatim. */
  scope: string
  content: SkillContentIdentity
  contentCheck: KnowledgeContentCheck
}

/** The discriminated sidecar: `type` decides which field set is the closed one. */
export type SkillSidecar = ExecutionSkillSidecar | KnowledgeSkillSidecar

/**
 * The named kind of one declaration refusal. `unknown-version` and
 * `unknown-field` are their own codes because a caller acts differently on
 * them (one build-versions the reader, the other says which fields a type
 * carries); everything else is a shape defect inside the declared field set.
 */
export type SkillContractDefectCode = 'sidecar-unknown-version' | 'sidecar-unknown-field' | 'sidecar-shape'

/** One reason a declared sidecar is not acceptable, with the kind of problem named. */
export interface SkillContractDefect {
  code: SkillContractDefectCode
  /** The readable reason, naming the field and the vocabulary it was checked against. */
  reason: string
}

const EXECUTION_FIELDS: readonly string[] = [
  'contractVersion', 'type', 'capabilities', 'precondition', 'inputs', 'outputs', 'requiredTools', 'verifier', 'content',
]
const KNOWLEDGE_FIELDS: readonly string[] = ['contractVersion', 'type', 'source', 'scope', 'content', 'contentCheck']
const PORT_FIELDS: readonly string[] = ['name', 'description', 'required']
const RESOURCE_FIELDS: readonly string[] = ['path', 'sha256']
const VERIFIER_FIELDS: readonly string[] = ['ref']
const CONTENT_CHECK_FIELDS: readonly string[] = ['kind', 'command']
const CONTENT_FIELDS: readonly string[] = ['skillMdSha256', 'resources']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Non-blank text: the one check every string field shares, with no rewriting of the value. */
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** How an unexpected value reads in a refusal: JSON for scalars, a noun for containers. */
function described(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return 'an object'
  return String(value)
}

/** What a value *is*, for the one refusal that cannot name a field (the whole sidecar). */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

function shape(reason: string): SkillContractDefect {
  return { code: 'sidecar-shape', reason }
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], where: string, carries: string): SkillContractDefect[] {
  return Object.keys(value)
    .filter(key => !allowed.includes(key))
    .sort()
    .map(key => ({
      code: 'sidecar-unknown-field' as const,
      reason: `${where} declares unknown field ${JSON.stringify(key)}; ${carries}`,
    }))
}

/** One string list: an array of non-blank names, each once, `[]` allowed unless `minItems` says otherwise. */
function nameListDefects(
  value: unknown,
  where: string,
  missing: string,
  duplicate: (name: string, index: number) => string,
  minItems = 0,
): SkillContractDefect[] {
  if (!Array.isArray(value) || (minItems > 0 && value.length < minItems)) return [shape(missing)]
  const defects: SkillContractDefect[] = []
  const seen = new Set<string>()
  value.forEach((item, index) => {
    if (!nonBlank(item)) {
      defects.push(shape(`${where}[${index}] must be a non-blank string`))
      return
    }
    if (seen.has(item)) {
      defects.push(shape(duplicate(item, index)))
      return
    }
    seen.add(item)
  })
  return defects
}

/** Ports: closed objects, each list naming a port once. */
function portDefects(value: unknown, where: string): SkillContractDefect[] {
  if (!Array.isArray(value)) return [shape(`${where} must be an array of ports`)]
  const defects: SkillContractDefect[] = []
  const seen = new Set<string>()
  value.forEach((port, index) => {
    const at = `${where}[${index}]`
    if (!isPlainObject(port)) {
      defects.push(shape(`${at} must be an object carrying name, description, required`))
      return
    }
    defects.push(...unknownFields(port, PORT_FIELDS, at, 'a port carries name, description, required'))
    if (!nonBlank(port.name)) defects.push(shape(`${at}.name must be a non-blank string`))
    if (!nonBlank(port.description)) defects.push(shape(`${at}.description must be a non-blank string`))
    if (typeof port.required !== 'boolean') defects.push(shape(`${at}.required must be a boolean`))
    if (nonBlank(port.name)) {
      if (seen.has(port.name)) defects.push(shape(`${at} duplicates port ${JSON.stringify(port.name)}`))
      seen.add(port.name)
    }
  })
  return defects
}

/** The content identity: exact digests, a supported path vocabulary, and one sorted list. */
function contentDefects(value: unknown): SkillContractDefect[] {
  if (!isPlainObject(value)) return [shape('sidecar.content must be an object carrying skillMdSha256 and resources')]
  const defects = unknownFields(value, CONTENT_FIELDS, 'sidecar.content', 'a content identity carries skillMdSha256, resources')
  if (!isSha256Hex(value.skillMdSha256)) {
    defects.push(shape('sidecar.content.skillMdSha256 must be a lowercase 64-character hex digest'))
  }
  const resources = value.resources
  if (!Array.isArray(resources)) {
    defects.push(shape('sidecar.content.resources must be an array of resource identities'))
    return defects
  }
  const seen = new Set<string>()
  let previous: string | undefined
  resources.forEach((resource, index) => {
    const at = `sidecar.content.resources[${index}]`
    if (!isPlainObject(resource)) {
      defects.push(shape(`${at} must be an object carrying path, sha256`))
      return
    }
    defects.push(...unknownFields(resource, RESOURCE_FIELDS, at, 'a resource identity carries path, sha256'))
    if (!nonBlank(resource.path) || !isSupportedSkillResourcePath(resource.path)) {
      defects.push(shape(`${at}.path ${described(resource.path)} is not a supported resource path (references/<file> or scripts/<file>)`))
    } else if (seen.has(resource.path)) {
      defects.push(shape(`${at} duplicates ${JSON.stringify(resource.path)}`))
    } else {
      if (previous !== undefined && resource.path < previous) {
        defects.push(shape(`${at} path ${JSON.stringify(resource.path)} precedes ${JSON.stringify(previous)}; the list must be sorted by path`))
      }
      seen.add(resource.path)
      previous = resource.path
    }
    if (!isSha256Hex(resource.sha256)) {
      defects.push(shape(`${at}.sha256 must be a lowercase 64-character hex digest`))
    }
  })
  return defects
}

function verifierDefects(value: unknown): SkillContractDefect[] {
  if (!isPlainObject(value)) return [shape('sidecar.verifier must be an object carrying a ref')]
  const defects = unknownFields(value, VERIFIER_FIELDS, 'sidecar.verifier', 'a verifier reference carries ref')
  if (!nonBlank(value.ref)) defects.push(shape('sidecar.verifier.ref must be a non-blank string'))
  return defects
}

function contentCheckDefects(value: unknown): SkillContractDefect[] {
  if (!isPlainObject(value)) return [shape('sidecar.contentCheck must be an object carrying kind and command')]
  const defects = unknownFields(value, CONTENT_CHECK_FIELDS, 'sidecar.contentCheck', 'a content check carries kind, command')
  if (value.kind !== 'command') {
    defects.push(shape(`sidecar.contentCheck.kind ${described(value.kind)} is not one of command`))
  }
  if (!nonBlank(value.command)) defects.push(shape('sidecar.contentCheck.command must be a non-blank string'))
  return defects
}

/**
 * Every reason one declared sidecar is not acceptable, in field order — never
 * just the first, so one refusal names everything wrong with the declaration.
 *
 * Purely declaration-level: the version, the closed field set of the declared
 * type, the shape of every field, and the internal consistency of the content
 * identity. It reads no files, so it cannot tell whether the digests are true —
 * that comparison needs the skill directory and lives in the loader. The
 * returned defects are values, not throws: a caller refusing a sidecar reports
 * all of them and writes nothing.
 */
export function skillContractDefects(value: unknown): SkillContractDefect[] {
  if (!isPlainObject(value)) return [shape(`the sidecar must be a JSON object, got ${kindOf(value)}`)]
  const defects: SkillContractDefect[] = []
  if (value.contractVersion === undefined) {
    defects.push({
      code: 'sidecar-unknown-version',
      reason: `sidecar.contractVersion is missing; this build reads and writes version ${SKILL_CONTRACT_VERSION}`,
    })
  } else if (value.contractVersion !== SKILL_CONTRACT_VERSION) {
    defects.push({
      code: 'sidecar-unknown-version',
      reason: `sidecar.contractVersion ${described(value.contractVersion)} is not a version this build reads (${SKILL_CONTRACT_VERSION})`,
    })
  }
  const type = value.type
  if (type !== 'execution' && type !== 'knowledge') {
    defects.push(shape(`sidecar.type ${described(type)} is not one of execution, knowledge`))
    // Without a type there is no closed field set to check the remaining fields
    // against: reporting them as unknown would invent a second vocabulary.
    return defects
  }
  if (type === 'execution') {
    defects.push(...unknownFields(value, EXECUTION_FIELDS, 'sidecar', `an execution sidecar carries ${EXECUTION_FIELDS.join(', ')}`))
    defects.push(...nameListDefects(
      value.capabilities,
      'sidecar.capabilities',
      'sidecar.capabilities must be a non-empty array of capability names',
      (name, index) => `sidecar.capabilities[${index}] duplicates ${JSON.stringify(name)}`,
      1,
    ))
    if (!nonBlank(value.precondition)) defects.push(shape('sidecar.precondition must be a non-blank string'))
    defects.push(...portDefects(value.inputs, 'sidecar.inputs'))
    defects.push(...portDefects(value.outputs, 'sidecar.outputs'))
    defects.push(...nameListDefects(
      value.requiredTools,
      'sidecar.requiredTools',
      'sidecar.requiredTools must be an array of tool names',
      (name, index) => `sidecar.requiredTools[${index}] duplicates ${JSON.stringify(name)}`,
    ))
    defects.push(...verifierDefects(value.verifier))
    defects.push(...contentDefects(value.content))
    return defects
  }
  defects.push(...unknownFields(value, KNOWLEDGE_FIELDS, 'sidecar', `a knowledge sidecar carries ${KNOWLEDGE_FIELDS.join(', ')}`))
  if (!nonBlank(value.source)) defects.push(shape('sidecar.source must be a non-blank string'))
  if (!nonBlank(value.scope)) defects.push(shape('sidecar.scope must be a non-blank string'))
  defects.push(...contentDefects(value.content))
  defects.push(...contentCheckDefects(value.contentCheck))
  return defects
}

/**
 * The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
 * declared data, so key order and `undefined`-valued keys do not move it while
 * any declared field does. Call it on a sidecar that passed
 * {@link skillContractDefects}: an unvalidated object can carry fields this
 * identity would then cover without a rule saying what they mean.
 */
export function skillContractDigest(sidecar: SkillSidecar): string {
  return sha256Hex(canonicalize(sidecar))
}

/**
 * The identity of one content identity: SHA-256 over {@link canonicalize} of the
 * `SKILL.md` digest and the resource list. Separate from
 * {@link skillContractDigest} so a caller can name the bytes (a run recording
 * what it read) without claiming a sidecar it did not read.
 */
export function skillContentDigest(content: SkillContentIdentity): string {
  return sha256Hex(canonicalize(content))
}
