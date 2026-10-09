/**
 * The skill sidecar loader and the one pre-check every provider entry shares
 * (guide §2.3/§2.4, S1-C): config load, provider replacement and candidate
 */

import type { McpServerTemplate } from './mcp-servers.ts'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import {
  SKILL_SIDECAR_FILE,
  SUPPORTED_SKILL_RESOURCE_DIRS,
  skillContentDigest,
  skillContractDefects,
  skillContractDigest,
} from './skill-contract.ts'
import type {
  KnowledgeContentCheck,
  SkillContentIdentity,
  SkillContractDefectCode,
  SkillPort,
  SkillResourceIdentity,
  SkillSidecar,
} from './skill-contract.ts'
import { resolveCapabilities, type CapabilityConfig } from './capability.ts'
import { walkVerified } from './verified-read.ts'
import { message } from './helpers.ts'

/** Every reason a provider is refused, named so a caller can act on the kind of problem. */
type SkillDefectCode =
  | SkillContractDefectCode
  | 'skill-missing'
  | 'skill-file-invalid'
  | 'skill-name-mismatch'
  | 'sidecar-unreadable'
  | 'sidecar-mismatch'
  | 'content-mismatch'
  | 'content-unsupported'
  | 'verifier-unknown'
  | 'capability-unknown'
  | 'tool-not-covered'
  | 'commit-intent-open'
  | 'commit-ledger-unreadable'

/** One named reason a provider is not acceptable, with the detail a caller reports. */
export interface SkillDefect {
  code: SkillDefectCode
  detail: string
}

/** What the real DSH tool plane a capability grants looks like: expanded names plus the servers it mounts. */
interface CapabilityGrants {
  /** Real DSH tool names the capability's tool labels expand to. */
  readonly tools: readonly string[]
  /** MCP server names the capability mounts; their tools reach a worker as `mcp__<server>__<tool>`. */
  readonly mcpServers: readonly string[]
}

/**
 * What the context knows about one capability. `known: false` covers both "no
 * such row" and "the row does not resolve" (an unknown tool label, an unknown
 */
type CapabilityToolAnswer =
  ({ readonly known: true } & CapabilityGrants) | { readonly known: false; readonly reason: string }

/** How a caller lends its capability table to the pre-check. */
type CapabilityToolQuery = (capability: string) => CapabilityToolAnswer

/** Everything the pre-check needs that is not the candidate itself. */
export interface SkillValidationContext {
  /** Verifier ids the registry can dispatch to (`VerifierRegistry.verifierIds()`): the whole vocabulary `verifier.ref` may name. */
  readonly verifierRefs: readonly string[]
  /** The expanded tool plane of a capability, in the same vocabulary a sidecar's `requiredTools` is written in. */
  readonly capabilityTools: CapabilityToolQuery
}

/**
 * A capability table as a query, going through `resolveCapabilities` — the same
 * resolution admission performs — so the pre-check sees exactly the grant a
 */
export function capabilityToolQuery(capabilities: Readonly<Record<string, CapabilityConfig>>, mcpRegistry?: Readonly<Record<string, McpServerTemplate>>): CapabilityToolQuery {
  return capability => {
    let manifest
    try {
      manifest = resolveCapabilities([capability], capabilities, mcpRegistry)
    } catch (error) {
      return { known: false, reason: message(error) }
    }
    const entry = manifest.capabilities[capability]
    if (entry === undefined) {
      return { known: false, reason: `capability "${capability}" is not in the capability table` }
    }
    return { known: true, tools: entry.tools, mcpServers: (entry.mcpServers ?? []).map(key => mcpRegistry === undefined ? key : mcpRegistry[key]!.serverName) }
  }
}

/** Build the pre-check context from a capability table and the registered verifier ids. */
export function skillValidationContext(
  capabilities: Readonly<Record<string, CapabilityConfig>>,
  verifierRefs: readonly string[],
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>,
): SkillValidationContext {
  return { verifierRefs: [...verifierRefs].sort(), capabilityTools: capabilityToolQuery(capabilities, mcpRegistry) }
}

/** What a skill directory honestly held when it was read. */
interface LoadedSkillSidecar {
  /** The skill directory that was read, as given. */
  readonly directory: string
  /** The declared sidecar, when the directory holds a readable one that passed the shape rules. */
  readonly sidecar?: SkillSidecar
  /** The identity of the bytes actually read; absent when there is no readable regular `SKILL.md`. */
  readonly content?: SkillContentIdentity
  /**
   * What the `SKILL.md` frontmatter declares — the name the file loads under
   * and the purpose a reader sees. Absent exactly when the file could not be
   */
  readonly frontmatter?: LoadedSkillFrontmatter
  /** Instruction body parsed from the same bytes whose digest was checked. */
  readonly instructions?: string
  /** Direct entries the supported vocabulary does not cover (a directory reads as `name/`), sorted. */
  readonly uncovered: readonly string[]
  /** Every reason the directory or its sidecar is not acceptable; empty means a clean load. */
  readonly defects: readonly SkillDefect[]
}

/**
 * The frontmatter two consumers need: the spawn's `readSkillFile` (which
 * publishes the body under `name`) and every renderer that shows what a
 */
interface LoadedSkillFrontmatter {
  /** The name the file declares it is; a directory reached under another name is refused. */
  readonly name: string
  /** The purpose the file declares, in the author's words. */
  readonly description: string
}

/** One provider under pre-check: the granted skill name and where discovery found it. */
interface SkillProviderCandidate {
  /** The skill name a capability grants; the directory under a skill root is named after it. */
  readonly name: string
  /** Absolute path of the skill directory discovery resolved, or absent when nothing was found. */
  readonly directory?: string
  /**
   * A sidecar the caller already holds (a prepare-time declaration, a ledger
   * copy). It is never trusted as a substitute for the directory: it must be
   */
  readonly sidecar?: SkillSidecar
}

/** The only verdict kind that may close an execution gap: an execution sidecar that passed every rule. */
export interface ExecutionProviderVerdict {
  readonly valid: true
  readonly role: 'execution-provider'
  readonly name: string
  readonly directory: string
  readonly capabilities: readonly string[]
  /** The declared precondition, carried verbatim for the caller that renders a worker summary. */
  readonly precondition: string
  /**
   * The purpose this skill declares for itself (`SKILL.md` frontmatter), carried
   * so a run summary or a record can say what the provider is for without
   */
  readonly description: string
  readonly inputs: readonly SkillPort[]
  readonly outputs: readonly SkillPort[]
  readonly requiredTools: readonly string[]
  readonly verifierRef: string
  /** {@link skillContractDigest} of the sidecar the verdict was taken from. */
  readonly contractDigest: string
  readonly content: SkillContentIdentity
  /** {@link skillContentDigest} of {@link content}: the bytes this verdict is about, in one string. */
  readonly contentDigest: string
}

/** A knowledge skill: loadable, content-verified, and deliberately without any execution claim. */
interface KnowledgeProviderVerdict {
  readonly valid: true
  readonly role: 'knowledge'
  readonly name: string
  readonly directory: string
  readonly source: string
  readonly scope: string
  /** The declared content check, carried — this pre-check never runs it. */
  readonly contentCheck: KnowledgeContentCheck
  /** The purpose this skill declares for itself; see {@link ExecutionProviderVerdict.description}. */
  readonly description: string
  readonly contractDigest: string
  readonly content: SkillContentIdentity
  readonly contentDigest: string
}

/** A skill with no sidecar: guidance a worker may read, with no execution claim and no defect. */
interface GuidanceProviderVerdict {
  readonly valid: true
  readonly role: 'guidance'
  readonly name: string
  readonly directory: string
  /** The purpose this skill declares for itself; see {@link ExecutionProviderVerdict.description}. */
  readonly description: string
  readonly content: SkillContentIdentity
  readonly contentDigest: string
  readonly uncovered: readonly string[]
}

export type AcceptedSkillProviderVerdict = ExecutionProviderVerdict | KnowledgeProviderVerdict | GuidanceProviderVerdict

/** A refused provider: every reason named, nothing written, nothing claimed. */
export interface RejectedProviderVerdict {
  readonly valid: false
  readonly name: string
  readonly directory?: string
  readonly defects: readonly SkillDefect[]
}

export type SkillProviderVerdict = AcceptedSkillProviderVerdict | RejectedProviderVerdict

/** One provider's declared content identity inside the registry revision. */
interface SkillProviderIdentity {
  /** The skill name a capability grants. */
  readonly name: string
  /** {@link skillContractDigest} of the provider's sidecar, or `null` when the skill carries none. */
  readonly contractDigest: string | null
}

interface ScannedDirectory {
  skillMdPresent: boolean
  skillMdSha256?: string
  frontmatter?: LoadedSkillFrontmatter
  instructions?: string
  resources: SkillResourceIdentity[]
  uncovered: string[]
  /**
   * Paths (a directory as `name/`) whose entries were refused for their shape —
   * a link, a nested tree, a non-text file. The declared-identity comparison
   */
  unsupported: string[]
  defects: SkillDefect[]
}

function defect(code: SkillDefectCode, detail: string): SkillDefect {
  return { code, detail }
}

/** The sidecar contract's own defect codes are already named the same way, so they carry over unchanged. */
function contractDefects(defects: readonly { code: SkillContractDefectCode; reason: string }[]): SkillDefect[] {
  return defects.map(item => defect(item.code, item.reason))
}

/** Whether the bytes are text a worker can read: valid UTF-8 with no NUL byte. */
function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Read the compiled bytes of one file under the skill directory, turning a
 * refusal into a named defect rather than a throw, so one broken entry does not
 */
async function readBytes(
  directory: string,
  relativePath: string,
  relative: string,
  defects: SkillDefect[],
): Promise<Buffer | undefined> {
  try {
    const walked = await walkVerified(directory, relativePath)
    if (walked.missing) {
      defects.push(defect('content-mismatch', `${relative} is declared but missing from the skill directory`))
      return undefined
    }
    return await readFile(walked.abs)
  } catch (error) {
    defects.push(defect('content-unsupported', `${relative} cannot be read as a real file: ${message(error)}`))
    return undefined
  }
}

/**
 * Walk one skill directory and describe it: which files sit at supported
 * positions with their real digests, which direct entries the supported
 */
async function scanSkillDirectory(directory: string): Promise<ScannedDirectory> {
  const scanned: ScannedDirectory = {
    skillMdPresent: false,
    resources: [],
    uncovered: [],
    unsupported: [],
    defects: [],
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    scanned.defects.push(defect('skill-missing', `skill directory ${directory} cannot be read: ${message(error)}`))
    return scanned
  }
  for (const entry of entries) {
    const name = entry.name
    const at = join(directory, name)
    let info
    try {
      info = await lstat(at)
    } catch (error) {
      scanned.defects.push(defect('content-unsupported', `${name} cannot be read: ${message(error)}`))
      continue
    }
    if (name === 'SKILL.md') {
      scanned.skillMdPresent = true
      if (info.isSymbolicLink()) {
        scanned.defects.push(
          defect('content-unsupported', "SKILL.md is a symbolic link; a skill's SKILL.md must be a real file"),
        )
        continue
      }
      if (!info.isFile()) {
        scanned.defects.push(defect('content-unsupported', 'SKILL.md is not a regular file'))
        continue
      }
      const bytes = await readBytes(directory, 'SKILL.md', 'SKILL.md', scanned.defects)
      if (bytes !== undefined) {
        scanned.skillMdSha256 = sha256Hex(bytes)
        /**
         * The name this file loads under, parsed by the same reader the spawn
         * uses (`readSkillFile`): a file declaring another name, or whose
         */
        try {
          const parsed = parseSkillFile(bytes.toString('utf8'), join(directory, 'SKILL.md'))
          scanned.frontmatter = { name: parsed.name, description: parsed.description }
          scanned.instructions = parsed.content
          if (parsed.content.trim().length === 0) {
            scanned.defects.push(defect('skill-file-invalid', 'SKILL.md has no instruction body; a task needs actual guidance'))
          }
          if (!parsed.invocation.modelInvocable) {
            scanned.defects.push(defect('skill-file-invalid', 'SKILL.md disables model invocation; a task must be able to load its guidance'))
          }
        } catch (error) {
          scanned.defects.push(defect('skill-file-invalid', message(error)))
        }
      }
      continue
    }
    if (name === SKILL_SIDECAR_FILE) {
      // The loader reads the sidecar itself; a link or a directory here is refused there.
      continue
    }
    if (SUPPORTED_SKILL_RESOURCE_DIRS.includes(name)) {
      if (info.isSymbolicLink()) {
        scanned.unsupported.push(`${name}/`)
        scanned.defects.push(
          defect('content-unsupported', `${name}/ is a symbolic link; a skill directory\'s entries must be real`),
        )
        continue
      }
      if (!info.isDirectory()) {
        scanned.unsupported.push(`${name}/`)
        scanned.defects.push(defect('content-unsupported', `${name} is not a directory`))
        continue
      }
      let children
      try {
        children = await readdir(at, { withFileTypes: true })
      } catch (error) {
        scanned.unsupported.push(`${name}/`)
        scanned.defects.push(defect('content-unsupported', `${name}/ cannot be read: ${message(error)}`))
        continue
      }
      for (const child of children) {
        const relative = `${name}/${child.name}`
        let childInfo
        try {
          childInfo = await lstat(join(at, child.name))
        } catch (error) {
          scanned.unsupported.push(relative)
          scanned.defects.push(defect('content-unsupported', `${relative} cannot be read: ${message(error)}`))
          continue
        }
        if (childInfo.isSymbolicLink()) {
          scanned.unsupported.push(relative)
          scanned.defects.push(
            defect('content-unsupported', `${relative} is a symbolic link; a resource must be a real file`),
          )
          continue
        }
        if (childInfo.isDirectory()) {
          scanned.unsupported.push(relative)
          scanned.defects.push(
            defect(
              'content-unsupported',
              `${relative} is a directory nested deeper than the supported one-level shape (${name}/<file>)`,
            ),
          )
          continue
        }
        if (!childInfo.isFile()) {
          scanned.unsupported.push(relative)
          scanned.defects.push(defect('content-unsupported', `${relative} is not a regular file`))
          continue
        }
        const bytes = await readBytes(directory, relative, relative, scanned.defects)
        if (bytes === undefined) {
          scanned.unsupported.push(relative)
          continue
        }
        if (!isText(bytes)) {
          scanned.unsupported.push(relative)
          scanned.defects.push(
            defect(
              'content-unsupported',
              `${relative} is not UTF-8 text; a supported resource is a text file a worker can read`,
            ),
          )
          continue
        }
        scanned.resources.push({ path: relative, sha256: sha256Hex(bytes) })
      }
      continue
    }
    if (info.isSymbolicLink()) {
      scanned.defects.push(
        defect('content-unsupported', `${name} is a symbolic link; a skill directory holds real entries only`),
      )
      continue
    }
    scanned.uncovered.push(info.isDirectory() ? `${name}/` : name)
  }
  scanned.resources.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  scanned.uncovered.sort()
  return scanned
}

/**
 * Load and check one skill directory: the directory itself, `SKILL.md`, the
 * sidecar when there is one, the identity of the bytes on disk, and the shape
 */
export async function loadSkillSidecar(directory: string): Promise<LoadedSkillSidecar> {
  let info
  try {
    info = await lstat(directory)
  } catch (error) {
    return {
      directory,
      uncovered: [],
      defects: [defect('skill-missing', `skill directory ${directory} cannot be read: ${message(error)}`)],
    }
  }
  if (info.isSymbolicLink()) {
    return {
      directory,
      uncovered: [],
      defects: [
        defect('content-unsupported', `${directory} is a symbolic link; a skill directory must be a real directory`),
      ],
    }
  }
  if (!info.isDirectory()) {
    return { directory, uncovered: [], defects: [defect('skill-missing', `${directory} is not a directory`)] }
  }
  const scanned = await scanSkillDirectory(directory)
  const defects = [...scanned.defects]
  if (!scanned.skillMdPresent) {
    defects.push(
      defect('skill-missing', `${join(directory, 'SKILL.md')} does not exist; a skill directory carries a SKILL.md`),
    )
  }
  const content =
    scanned.skillMdSha256 === undefined
      ? undefined
      : { skillMdSha256: scanned.skillMdSha256, resources: scanned.resources }

  let sidecar: SkillSidecar | undefined
  let sidecarBytes: Buffer | undefined
  try {
    const walked = await walkVerified(directory, SKILL_SIDECAR_FILE)
    if (!walked.missing) sidecarBytes = await readFile(walked.abs)
  } catch (error) {
    defects.push(
      defect('content-unsupported', `${SKILL_SIDECAR_FILE} cannot be read as a real file: ${message(error)}`),
    )
  }
  if (sidecarBytes !== undefined) {
    if (!isText(sidecarBytes)) {
      defects.push(defect('sidecar-unreadable', `${SKILL_SIDECAR_FILE} is not UTF-8 text`))
    } else {
      let declared: unknown
      try {
        declared = JSON.parse(sidecarBytes.toString('utf8'))
      } catch (error) {
        defects.push(defect('sidecar-unreadable', `${SKILL_SIDECAR_FILE} is not readable JSON: ${message(error)}`))
      }
      if (declared !== undefined) {
        const declaredDefects = skillContractDefects(declared)
        defects.push(...contractDefects(declaredDefects))
        if (declaredDefects.length === 0) {
          const sidecarValue = declared as SkillSidecar
          sidecar = sidecarValue
          /**
           * The declared identity against the bytes just read. A declaration is
           * only worth the directory it describes, so an undeclared file at a
           */
          if (content !== undefined) {
            defects.push(...contentDefects(sidecarValue.content, content, scanned.uncovered, scanned.unsupported))
          }
        }
      }
    }
  }
  return {
    directory,
    ...(sidecar === undefined ? {} : { sidecar }),
    ...(content === undefined ? {} : { content }),
    ...(scanned.frontmatter === undefined ? {} : { frontmatter: scanned.frontmatter }),
    ...(scanned.instructions === undefined ? {} : { instructions: scanned.instructions }),
    uncovered: scanned.uncovered,
    defects,
  }
}

/**
 * Compare a declared identity with the bytes on disk: the declared `SKILL.md`
 * digest, every declared resource, and — the other direction — every file the
 */
function contentDefects(
  declared: SkillContentIdentity,
  actual: SkillContentIdentity,
  uncovered: readonly string[],
  unsupported: readonly string[],
): SkillDefect[] {
  const defects: SkillDefect[] = []
  if (declared.skillMdSha256 !== actual.skillMdSha256) {
    defects.push(
      defect(
        'content-mismatch',
        `SKILL.md is not the declared content: declared ${declared.skillMdSha256}, read ${actual.skillMdSha256}`,
      ),
    )
  }
  const refused = (path: string): boolean =>
    unsupported.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
  const actualResources = new Map(actual.resources.map(resource => [resource.path, resource.sha256]))
  for (const declaredResource of declared.resources) {
    const read = actualResources.get(declaredResource.path)
    if (read === undefined) {
      if (refused(declaredResource.path)) continue
      defects.push(
        defect('content-mismatch', `${declaredResource.path} is declared but missing from the skill directory`),
      )
      continue
    }
    if (read !== declaredResource.sha256) {
      defects.push(
        defect(
          'content-mismatch',
          `${declaredResource.path} is not the declared content: declared ${declaredResource.sha256}, read ${read}`,
        ),
      )
    }
  }
  const declaredPaths = new Set(declared.resources.map(resource => resource.path))
  for (const resource of actual.resources) {
    if (!declaredPaths.has(resource.path)) {
      defects.push(
        defect(
          'content-unsupported',
          `${resource.path} is not covered by the declared identity; the identity must name every file in the skill directory`,
        ),
      )
    }
  }
  for (const entry of uncovered) {
    defects.push(
      defect(
        'content-unsupported',
        `${entry} is not covered by the declared identity; a sidecar declares SKILL.md plus resources under ${SUPPORTED_SKILL_RESOURCE_DIRS.join('/, ')}/ only`,
      ),
    )
  }
  return defects
}

/**
 * The unified pre-check: one candidate provider against the deployment's
 * verifier vocabulary and capability table (guide §2.3, S1-C item 3). Every
 */
export async function validateSkillProvider(
  candidate: SkillProviderCandidate,
  context: SkillValidationContext,
): Promise<SkillProviderVerdict> {
  const defects: SkillDefect[] = []
  const refuse = (directory: string | undefined): RejectedProviderVerdict => ({
    valid: false,
    name: candidate.name,
    ...(directory === undefined ? {} : { directory }),
    defects,
  })
  if (candidate.directory === undefined) {
    defects.push(
      defect(
        'skill-missing',
        `no directory was discovered for skill "${candidate.name}"; a provider without a SKILL.md on disk cannot be an execution provider`,
      ),
    )
    return refuse(undefined)
  }
  const directory = candidate.directory
  if (basename(directory) !== candidate.name) {
    defects.push(
      defect(
        'skill-name-mismatch',
        `skill "${candidate.name}" resolves to directory ${directory}, whose name is "${basename(directory)}"; a skill directory is named after the skill it holds`,
      ),
    )
  }
  const loaded = await loadSkillSidecar(directory)
  defects.push(...loaded.defects)
  const content = loaded.content
  const frontmatter = loaded.frontmatter
  /**
   * The name the file declares, checked against the name the capability grants
   * with the spawn's own sentence. Directory naming and declared naming are two
   */
  if (frontmatter !== undefined && frontmatter.name !== candidate.name) {
    defects.push(
      defect(
        'skill-name-mismatch',
        `skill file ${join(directory, 'SKILL.md')} declares name "${frontmatter.name}" but the capability grants "${candidate.name}"`,
      ),
    )
  }

  if (candidate.sidecar !== undefined) {
    const suppliedDefects = skillContractDefects(candidate.sidecar)
    defects.push(...contractDefects(suppliedDefects))
    if (loaded.sidecar === undefined) {
      defects.push(
        defect(
          'sidecar-mismatch',
          `skill "${candidate.name}" was checked against a supplied sidecar, but ${join(directory, SKILL_SIDECAR_FILE)} holds none; a declaration must describe the directory it is validated against`,
        ),
      )
    } else if (
      suppliedDefects.length === 0 &&
      skillContractDigest(loaded.sidecar) !== skillContractDigest(candidate.sidecar)
    ) {
      defects.push(
        defect(
          'sidecar-mismatch',
          `the supplied sidecar for skill "${candidate.name}" is not the declaration in ${join(directory, SKILL_SIDECAR_FILE)}`,
        ),
      )
    }
  }

  const sidecar = loaded.sidecar ?? candidate.sidecar
  if (sidecar === undefined) {
    // Guidance: no declaration, so no execution claim and nothing to hold the
    // directory to. What the identity does not cover is named, not hidden.
    if (defects.length > 0 || content === undefined || frontmatter === undefined) return refuse(directory)
    return {
      valid: true,
      role: 'guidance',
      name: candidate.name,
      directory,
      description: frontmatter.description,
      content,
      contentDigest: skillContentDigest(content),
      uncovered: loaded.uncovered,
    }
  }

  if (sidecar.type === 'execution') {
    if (!context.verifierRefs.includes(sidecar.verifier.ref)) {
      const registered = [...context.verifierRefs].sort()
      defects.push(
        defect(
          'verifier-unknown',
          `skill "${candidate.name}" declares execution verifier ${JSON.stringify(sidecar.verifier.ref)}, which is not registered; registered verifiers: ${registered.length === 0 ? 'none' : registered.join(', ')}`,
        ),
      )
    }
    const tools = new Set<string>()
    const servers = new Set<string>()
    let grantComplete = true
    for (const capability of sidecar.capabilities) {
      const answer = context.capabilityTools(capability)
      if (!answer.known) {
        grantComplete = false
        defects.push(
          defect(
            'capability-unknown',
            `skill "${candidate.name}" declares capability ${JSON.stringify(capability)}: ${answer.reason}`,
          ),
        )
        continue
      }
      for (const tool of answer.tools) tools.add(tool)
      for (const server of answer.mcpServers) servers.add(server)
    }
    if (grantComplete) {
      /**
       * The worker baseline is deliberately not part of the covering set: a
       * capability must grant what the provider it carries needs, and a run
       */
      const uncoveredTools = sidecar.requiredTools.filter(
        tool =>
          !tools.has(tool) &&
          ![...servers].some(server => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length),
      )
      if (uncoveredTools.length > 0) {
        const granted = [...tools].sort().join(', ')
        defects.push(
          defect(
            'tool-not-covered',
            `skill "${candidate.name}" requires tools its declared capabilities do not grant: ${[...uncoveredTools]
              .sort()
              .map(tool => JSON.stringify(tool))
              .join(
                ', ',
              )}; declared capabilities ${sidecar.capabilities.join(', ')} grant: ${granted}${servers.size === 0 ? '' : ` · mounted servers: ${[...servers].sort().join(', ')}`}`,
          ),
        )
      }
    }
    if (defects.length > 0 || content === undefined || frontmatter === undefined) return refuse(directory)
    return {
      valid: true,
      role: 'execution-provider',
      name: candidate.name,
      directory,
      capabilities: [...sidecar.capabilities],
      precondition: sidecar.precondition,
      description: frontmatter.description,
      inputs: sidecar.inputs.map(port => ({ name: port.name, description: port.description, required: port.required })),
      outputs: sidecar.outputs.map(port => ({
        name: port.name,
        description: port.description,
        required: port.required,
      })),
      requiredTools: [...sidecar.requiredTools],
      verifierRef: sidecar.verifier.ref,
      contractDigest: skillContractDigest(sidecar),
      content,
      contentDigest: skillContentDigest(content),
    }
  }

  if (defects.length > 0 || content === undefined || frontmatter === undefined) return refuse(directory)
  return {
    valid: true,
    role: 'knowledge',
    name: candidate.name,
    directory,
    source: sidecar.source,
    scope: sidecar.scope,
    contentCheck: { kind: sidecar.contentCheck.kind, command: sidecar.contentCheck.command },
    description: frontmatter.description,
    contractDigest: skillContractDigest(sidecar),
    content,
    contentDigest: skillContentDigest(content),
  }
}

/**
 * The registry revision: SHA-256 over {@link canonicalize} of the capability
 * table (each row sorted by name, carrying its skills, the tool labels it
 */
export function registryRevision(
  capabilities: Readonly<Record<string, CapabilityConfig>>,
  providers: readonly SkillProviderIdentity[],
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>,
): string {
  const table = Object.keys(capabilities)
    .sort()
    .map(name => {
      const entry = capabilities[name] as CapabilityConfig
      const answers = capabilityToolQuery(capabilities)(name)
      return {
        name,
        skills: [...new Set(entry.skills ?? [])].sort(),
        /**
         * Both the declared labels and the names they expand to: the labels are
         * what the config says, the names are what a worker is granted, and a
         */
        declaredTools: [...new Set(entry.tools ?? [])].sort(),
        tools: answers.known ? [...new Set(answers.tools)].sort() : [],
        mcpServers: answers.known ? [...new Set(answers.mcpServers)].sort() : [],
        ...(entry.preset === undefined ? {} : { preset: entry.preset }),
        ...(entry.permission === undefined ? {} : { permission: entry.permission }),
      }
    })
  const sidecars = providers
    .map(provider => ({ name: provider.name, contractDigest: provider.contractDigest }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return sha256Hex(canonicalize({ capabilities: table, providers: sidecars, ...(mcpRegistry === undefined || Object.keys(mcpRegistry).length === 0 ? {} : { mcpRegistry }) }))
}
