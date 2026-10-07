/**
 * The typed skill sidecar contract: the declaration that sits beside a skill's
 * `SKILL.md` (`SKILL.contract.json`) and says what kind of skill it is, what it
 */

import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import { isPlainObject, nonBlank, unknownFieldKeys } from './helpers.ts'

/**
 * The sidecar file, read as JSON, named exactly here so every producer and
 * reader of a skill directory agrees on one spelling.
 */
export const SKILL_SIDECAR_FILE = 'SKILL.contract.json'

/**
 * The sidecar contract version this build writes and reads. Like the task
 * contract's `TASK_CONTRACT_VERSION` it versions the data definition, not a
 */
export const SKILL_CONTRACT_VERSION = 1 as const

/** Every version of {@link SkillSidecar} this build can write or read. */
type SkillContractVersion = typeof SKILL_CONTRACT_VERSION

/**
 * The directories a skill may hold supporting files in. The supported shape is
 * deliberately one level deep — `<dir>/<file>` — because a deeper tree cannot
 */
export const SUPPORTED_SKILL_RESOURCE_DIRS: readonly string[] = ['references', 'scripts', 'resources']

/**
 * Whether one declared resource path is a path this contract can identify:
 * exactly `<dir>/<file>` with `<dir>` in {@link SUPPORTED_SKILL_RESOURCE_DIRS},
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
 */
interface SkillVerifierRef {
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
 */
export type SkillContractDefectCode = 'sidecar-unknown-version' | 'sidecar-unknown-field' | 'sidecar-shape'

/** One reason a declared sidecar is not acceptable, with the kind of problem named. */
export interface SkillContractDefect {
  code: SkillContractDefectCode
  /** The readable reason, naming the field and the vocabulary it was checked against. */
  reason: string
}

const EXECUTION_FIELDS: readonly string[] = [
  'contractVersion',
  'type',
  'capabilities',
  'precondition',
  'inputs',
  'outputs',
  'requiredTools',
  'verifier',
  'content',
]
const KNOWLEDGE_FIELDS: readonly string[] = ['contractVersion', 'type', 'source', 'scope', 'content', 'contentCheck']
const PORT_FIELDS: readonly string[] = ['name', 'description', 'required']
const RESOURCE_FIELDS: readonly string[] = ['path', 'sha256']
const VERIFIER_FIELDS: readonly string[] = ['ref']
const CONTENT_CHECK_FIELDS: readonly string[] = ['kind', 'command']
const CONTENT_FIELDS: readonly string[] = ['skillMdSha256', 'resources']

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

function unknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  carries: string,
): SkillContractDefect[] {
  return unknownFieldKeys(value, allowed)
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
  const defects = unknownFields(
    value,
    CONTENT_FIELDS,
    'sidecar.content',
    'a content identity carries skillMdSha256, resources',
  )
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
      defects.push(
        shape(
          `${at}.path ${described(resource.path)} is not a supported resource path (references/<file> or scripts/<file>)`,
        ),
      )
    } else if (seen.has(resource.path)) {
      defects.push(shape(`${at} duplicates ${JSON.stringify(resource.path)}`))
    } else {
      if (previous !== undefined && resource.path < previous) {
        defects.push(
          shape(
            `${at} path ${JSON.stringify(resource.path)} precedes ${JSON.stringify(previous)}; the list must be sorted by path`,
          ),
        )
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
  const defects = unknownFields(
    value,
    CONTENT_CHECK_FIELDS,
    'sidecar.contentCheck',
    'a content check carries kind, command',
  )
  if (value.kind !== 'command') {
    defects.push(shape(`sidecar.contentCheck.kind ${described(value.kind)} is not one of command`))
  }
  if (!nonBlank(value.command)) defects.push(shape('sidecar.contentCheck.command must be a non-blank string'))
  return defects
}

/**
 * Every reason one declared sidecar is not acceptable, in field order — never
 * just the first, so one refusal names everything wrong with the declaration.
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
    defects.push(
      ...unknownFields(
        value,
        EXECUTION_FIELDS,
        'sidecar',
        `an execution sidecar carries ${EXECUTION_FIELDS.join(', ')}`,
      ),
    )
    defects.push(
      ...nameListDefects(
        value.capabilities,
        'sidecar.capabilities',
        'sidecar.capabilities must be a non-empty array of capability names',
        (name, index) => `sidecar.capabilities[${index}] duplicates ${JSON.stringify(name)}`,
        1,
      ),
    )
    if (!nonBlank(value.precondition)) defects.push(shape('sidecar.precondition must be a non-blank string'))
    defects.push(...portDefects(value.inputs, 'sidecar.inputs'))
    defects.push(...portDefects(value.outputs, 'sidecar.outputs'))
    defects.push(
      ...nameListDefects(
        value.requiredTools,
        'sidecar.requiredTools',
        'sidecar.requiredTools must be an array of tool names',
        (name, index) => `sidecar.requiredTools[${index}] duplicates ${JSON.stringify(name)}`,
      ),
    )
    defects.push(...verifierDefects(value.verifier))
    defects.push(...contentDefects(value.content))
    return defects
  }
  defects.push(
    ...unknownFields(value, KNOWLEDGE_FIELDS, 'sidecar', `a knowledge sidecar carries ${KNOWLEDGE_FIELDS.join(', ')}`),
  )
  if (!nonBlank(value.source)) defects.push(shape('sidecar.source must be a non-blank string'))
  if (!nonBlank(value.scope)) defects.push(shape('sidecar.scope must be a non-blank string'))
  defects.push(...contentDefects(value.content))
  defects.push(...contentCheckDefects(value.contentCheck))
  return defects
}

/**
 * The identity of a whole sidecar: SHA-256 over {@link canonicalize} of the
 * declared data, so key order and `undefined`-valued keys do not move it while
 */
export function skillContractDigest(sidecar: SkillSidecar): string {
  return sha256Hex(canonicalize(sidecar))
}

/**
 * The identity of one content identity: SHA-256 over {@link canonicalize} of the
 * `SKILL.md` digest and the resource list. Separate from
 */
export function skillContentDigest(content: SkillContentIdentity): string {
  return sha256Hex(canonicalize(content))
}

/**
 * The same declaration with one field replaced: `content.skillMdSha256`.
 * A same-name improvement of an execution skill changes the `SKILL.md` and
 */
export function sidecarWithSkillMd(sidecar: SkillSidecar, skillMdSha256: string): SkillSidecar {
  if (!/^[0-9a-f]{64}$/.test(skillMdSha256)) {
    throw new Error(
      `skill-contract: cannot replace sidecar content.skillMdSha256 with ${JSON.stringify(skillMdSha256)} — a content identity is a ` +
        'lowercase 64-character hex SHA-256, and a rewritten sidecar is a declaration a loader will have to verify against real bytes',
    )
  }
  return { ...sidecar, content: { ...sidecar.content, skillMdSha256 } }
}

/**
 * The deterministic byte sequence of one declaration — what a file holds when
 * this build writes a sidecar.
 */
export function serializeSkillSidecar(sidecar: SkillSidecar): string {
  return `${JSON.stringify(JSON.parse(canonicalize(sidecar)), null, 2)}\n`
}
