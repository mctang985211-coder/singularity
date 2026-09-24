/**
 * The skill sidecar loader and the one pre-check every provider entry shares
 * (guide §2.3/§2.4, S1-C): config load, provider replacement and candidate
 * promotion all ask the same question here instead of each inventing its own
 * idea of what a valid provider is.
 *
 * What this module reads: a skill directory — `SKILL.md` and, when it exists,
 * `SKILL.contract.json` — through verified reads (a symbolic link, a directory
 * in a file's place, or a missing file is a named refusal, never a silent
 * follow), and it hashes the exact bytes it read. The declared identity in the
 * sidecar must equal those bytes; a skill whose directory holds a file the
 * declaration does not name is refused rather than described as "mostly
 * covered".
 *
 * What the verdict means, in three kinds — the distinction is the point of the
 * S1-C vocabulary, not a label:
 *
 * - `execution-provider`: an execution sidecar whose verifier is registered and
 *   whose required tools its declared capabilities actually grant. Only this
 *   verdict may close an execution gap.
 * - `knowledge`: a knowledge sidecar, loadable and content-verified, with no
 *   execution verifier and therefore no execution claim at all. Its verdict
 *   carries no execution fields, so a caller cannot read one out of it.
 * - `guidance`: a skill with no sidecar. It is loadable guidance — not an
 *   execution provider, and not a defect: refusing it would say "no execution
 *   verifier" about a file that never claimed one, which is exactly the
 *   "knowledge has no verifier, therefore nothing can be built" dead end guide
 *   §2.4 rejects. Its verdict names what its identity does not cover.
 *
 * A refused provider is reported as defects, not as an exception: every reason
 * is named (`verifier-unknown`, `tool-not-covered`, `content-mismatch`, …) and
 * nothing is written anywhere, so a caller can refuse a batch, a config load or
 * a candidate without side effects to undo.
 * @module @dangosys/dsh-singularity-task-runtime/sidecar
 */

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

/** Every reason a provider is refused, named so a caller can act on the kind of problem. */
export type SkillDefectCode =
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

/** One named reason a provider is not acceptable, with the detail a caller reports. */
export interface SkillDefect {
  code: SkillDefectCode
  detail: string
}

/** What the real DSH tool plane a capability grants looks like: expanded names plus the servers it mounts. */
export interface CapabilityGrants {
  /** Real DSH tool names the capability's tool labels expand to. */
  readonly tools: readonly string[]
  /** MCP server names the capability mounts; their tools reach a worker as `mcp__<server>__<tool>`. */
  readonly mcpServers: readonly string[]
}

/**
 * What the context knows about one capability. `known: false` covers both "no
 * such row" and "the row does not resolve" (an unknown tool label, an unknown
 * MCP server): both mean the grant cannot be read off the table, and the
 * refusal carries the reason the table itself gave.
 */
export type CapabilityToolAnswer = ({ readonly known: true } & CapabilityGrants) | { readonly known: false; readonly reason: string }

/** How a caller lends its capability table to the pre-check. */
export type CapabilityToolQuery = (capability: string) => CapabilityToolAnswer

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
 * spawn would build and a broken row is refused with the resolution's own
 * reason instead of being silently treated as granting nothing.
 */
export function capabilityToolQuery(capabilities: Readonly<Record<string, CapabilityConfig>>): CapabilityToolQuery {
  return capability => {
    let manifest
    try {
      manifest = resolveCapabilities([capability], capabilities)
    } catch (error) {
      return { known: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const entry = manifest.capabilities[capability]
    if (entry === undefined) {
      return { known: false, reason: `capability "${capability}" is not in the capability table` }
    }
    return { known: true, tools: entry.tools, mcpServers: entry.mcpServers ?? [] }
  }
}

/** Build the pre-check context from a capability table and the registered verifier ids. */
export function skillValidationContext(
  capabilities: Readonly<Record<string, CapabilityConfig>>,
  verifierRefs: readonly string[],
): SkillValidationContext {
  return { verifierRefs: [...verifierRefs].sort(), capabilityTools: capabilityToolQuery(capabilities) }
}

/** What a skill directory honestly held when it was read. */
export interface LoadedSkillSidecar {
  /** The skill directory that was read, as given. */
  readonly directory: string
  /** The declared sidecar, when the directory holds a readable one that passed the shape rules. */
  readonly sidecar?: SkillSidecar
  /** The identity of the bytes actually read; absent when there is no readable regular `SKILL.md`. */
  readonly content?: SkillContentIdentity
  /**
   * What the `SKILL.md` frontmatter declares — the name the file loads under
   * and the purpose a reader sees. Absent exactly when the file could not be
   * read or parsed, which is then a defect in {@link defects}: a skill file
   * that cannot be parsed is not a skill file a worker can load.
   */
  readonly frontmatter?: LoadedSkillFrontmatter
  /** Direct entries the supported vocabulary does not cover (a directory reads as `name/`), sorted. */
  readonly uncovered: readonly string[]
  /** Every reason the directory or its sidecar is not acceptable; empty means a clean load. */
  readonly defects: readonly SkillDefect[]
}

/**
 * The frontmatter two consumers need: the spawn's `readSkillFile` (which
 * publishes the body under `name`) and every renderer that shows what a
 * provider is for (`description`). Read once, by the same parser.
 */
export interface LoadedSkillFrontmatter {
  /** The name the file declares it is; a directory reached under another name is refused. */
  readonly name: string
  /** The purpose the file declares, in the author's words. */
  readonly description: string
}

/** One provider under pre-check: the granted skill name and where discovery found it. */
export interface SkillProviderCandidate {
  /** The skill name a capability grants; the directory under a skill root is named after it. */
  readonly name: string
  /** Absolute path of the skill directory discovery resolved, or absent when nothing was found. */
  readonly directory?: string
  /**
   * A sidecar the caller already holds (a prepare-time declaration, a ledger
   * copy). It is never trusted as a substitute for the directory: it must be
   * the same declaration the directory carries, so a validated declaration
   * cannot be paired with different bytes at apply time.
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
   * re-reading the file it was judged from.
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
export interface KnowledgeProviderVerdict {
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
export interface GuidanceProviderVerdict {
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

/**
 * The verdicts that may close an execution gap — and the only place a caller
 * needs to ask. A knowledge or guidance verdict is not in the result, so the
 * closure semantics cannot be relaxed by accident at a call site.
 */
export function executionProviders(verdicts: readonly SkillProviderVerdict[]): ExecutionProviderVerdict[] {
  return verdicts.filter((verdict): verdict is ExecutionProviderVerdict =>
    verdict.valid && verdict.role === 'execution-provider')
}

/** One provider's declared content identity inside the registry revision. */
export interface SkillProviderIdentity {
  /** The skill name a capability grants. */
  readonly name: string
  /** {@link skillContractDigest} of the provider's sidecar, or `null` when the skill carries none. */
  readonly contractDigest: string | null
}

interface ScannedDirectory {
  skillMdPresent: boolean
  skillMdSha256?: string
  frontmatter?: LoadedSkillFrontmatter
  resources: SkillResourceIdentity[]
  uncovered: string[]
  /**
   * Paths (a directory as `name/`) whose entries were refused for their shape —
   * a link, a nested tree, a non-text file. The declared-identity comparison
   * skips these: the shape refusal already names the path, and reporting it a
   * second time as "declared but missing" would hide the cause behind a
   * consequence.
   */
  unsupported: string[]
  defects: SkillDefect[]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 * hide the rest of the scan.
 */
async function readBytes(directory: string, relativePath: string, relative: string, defects: SkillDefect[]): Promise<Buffer | undefined> {
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
 * vocabulary does not cover, and every entry that is not a shape this contract
 * supports. Nothing is skipped silently — a link, a nested tree or a non-text
 * file is named.
 */
async function scanSkillDirectory(directory: string): Promise<ScannedDirectory> {
  const scanned: ScannedDirectory = { skillMdPresent: false, resources: [], uncovered: [], unsupported: [], defects: [] }
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
        scanned.defects.push(defect('content-unsupported', 'SKILL.md is a symbolic link; a skill\'s SKILL.md must be a real file'))
        continue
      }
      if (!info.isFile()) {
        scanned.defects.push(defect('content-unsupported', 'SKILL.md is not a regular file'))
        continue
      }
      const bytes = await readBytes(directory, 'SKILL.md', 'SKILL.md', scanned.defects)
      if (bytes !== undefined) {
        scanned.skillMdSha256 = sha256Hex(bytes)
        // The name this file loads under, parsed by the same reader the spawn
        // uses (`readSkillFile`): a file declaring another name, or whose
        // frontmatter does not parse, is refused here in the parser's own words
        // rather than published under a name it does not declare.
        try {
          const parsed = parseSkillFile(bytes.toString('utf8'), join(directory, 'SKILL.md'))
          scanned.frontmatter = { name: parsed.name, description: parsed.description }
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
        scanned.defects.push(defect('content-unsupported', `${name}/ is a symbolic link; a skill directory\'s entries must be real`))
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
          scanned.defects.push(defect('content-unsupported', `${relative} is a symbolic link; a resource must be a real file`))
          continue
        }
        if (childInfo.isDirectory()) {
          scanned.unsupported.push(relative)
          scanned.defects.push(defect('content-unsupported', `${relative} is a directory nested deeper than the supported one-level shape (${name}/<file>)`))
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
          scanned.defects.push(defect('content-unsupported', `${relative} is not UTF-8 text; a supported resource is a text file a worker can read`))
          continue
        }
        scanned.resources.push({ path: relative, sha256: sha256Hex(bytes) })
      }
      continue
    }
    if (info.isSymbolicLink()) {
      scanned.defects.push(defect('content-unsupported', `${name} is a symbolic link; a skill directory holds real entries only`))
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
 * of everything else in it.
 *
 * The returned `content` is the identity computed from the bytes just read —
 * the same value a clean sidecar declares, and the honest answer for a skill
 * that declares nothing. `defects` empty means the directory is fully described
 * by its identity: every file is `SKILL.md`, the sidecar itself, or a supported
 * resource the declaration names. Absence of a sidecar is not a defect: the
 * skill is then guidance, not a provider.
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
      defects: [defect('content-unsupported', `${directory} is a symbolic link; a skill directory must be a real directory`)],
    }
  }
  if (!info.isDirectory()) {
    return { directory, uncovered: [], defects: [defect('skill-missing', `${directory} is not a directory`)] }
  }
  const scanned = await scanSkillDirectory(directory)
  const defects = [...scanned.defects]
  if (!scanned.skillMdPresent) {
    defects.push(defect('skill-missing', `${join(directory, 'SKILL.md')} does not exist; a skill directory carries a SKILL.md`))
  }
  const content = scanned.skillMdSha256 === undefined
    ? undefined
    : { skillMdSha256: scanned.skillMdSha256, resources: scanned.resources }

  let sidecar: SkillSidecar | undefined
  let sidecarBytes: Buffer | undefined
  try {
    const walked = await walkVerified(directory, SKILL_SIDECAR_FILE)
    if (!walked.missing) sidecarBytes = await readFile(walked.abs)
  } catch (error) {
    defects.push(defect('content-unsupported', `${SKILL_SIDECAR_FILE} cannot be read as a real file: ${message(error)}`))
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
          // The declared identity against the bytes just read. A declaration is
          // only worth the directory it describes, so an undeclared file at a
          // supported position, a missing declared resource or a changed byte
          // are all refusals — a "mostly covered" identity is not an identity.
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
    uncovered: scanned.uncovered,
    defects,
  }
}

/**
 * Compare a declared identity with the bytes on disk: the declared `SKILL.md`
 * digest, every declared resource, and — the other direction — every file the
 * declaration does not name. A missing declared file or a changed byte is a
 * `content-mismatch`; a file nobody declared is `content-unsupported`, because
 * an identity that covers most of a directory is not an identity of it. A path
 * the scan already refused for its shape is not counted again here.
 */
function contentDefects(
  declared: SkillContentIdentity,
  actual: SkillContentIdentity,
  uncovered: readonly string[],
  unsupported: readonly string[],
): SkillDefect[] {
  const defects: SkillDefect[] = []
  if (declared.skillMdSha256 !== actual.skillMdSha256) {
    defects.push(defect('content-mismatch', `SKILL.md is not the declared content: declared ${declared.skillMdSha256}, read ${actual.skillMdSha256}`))
  }
  const refused = (path: string): boolean =>
    unsupported.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
  const actualResources = new Map(actual.resources.map(resource => [resource.path, resource.sha256]))
  for (const declaredResource of declared.resources) {
    const read = actualResources.get(declaredResource.path)
    if (read === undefined) {
      if (refused(declaredResource.path)) continue
      defects.push(defect('content-mismatch', `${declaredResource.path} is declared but missing from the skill directory`))
      continue
    }
    if (read !== declaredResource.sha256) {
      defects.push(defect('content-mismatch', `${declaredResource.path} is not the declared content: declared ${declaredResource.sha256}, read ${read}`))
    }
  }
  const declaredPaths = new Set(declared.resources.map(resource => resource.path))
  for (const resource of actual.resources) {
    if (!declaredPaths.has(resource.path)) {
      defects.push(defect('content-unsupported', `${resource.path} is not covered by the declared identity; the identity must name every file in the skill directory`))
    }
  }
  for (const entry of uncovered) {
    defects.push(defect('content-unsupported', `${entry} is not covered by the declared identity; a sidecar declares SKILL.md plus resources under ${SUPPORTED_SKILL_RESOURCE_DIRS.join('/, ')}/ only`))
  }
  return defects
}

/**
 * The unified pre-check: one candidate provider against the deployment's
 * verifier vocabulary and capability table (guide §2.3, S1-C item 3). Every
 * entry — config load, provider replacement, candidate promotion — calls this,
 * so `evolution_apply` is not the only defence and no entry can be the one that
 * skipped it.
 *
 * Rules, in the order they are checked:
 *
 * 1. The directory exists, is a real directory, and is named after the skill.
 * 2. The loader reads it: `SKILL.md`, the sidecar when present, the supported
 *    resources, and every entry whose shape the contract does not support. The
 *    declared content identity must equal the bytes read, and the `SKILL.md`
 *    frontmatter must parse and declare the granted name — the same rule, and
 *    the same words, the spawn's `readSkillFile` applies when it registers the
 *    body.
 * 3. A sidecar the caller supplied must be the one the directory carries.
 * 4. An execution sidecar's `verifier.ref` must be a registered verifier, and
 *    its `requiredTools` must be granted by the capabilities it declares it
 *    serves (`mcp__<server>__<tool>` counts when the capability mounts that
 *    server; the worker baseline is deliberately not counted — a capability
 *    must grant what the provider it carries needs).
 * 5. A knowledge sidecar is checked for content and carried as knowledge: it
 *    never becomes an execution provider.
 *
 * The verdict is a value: all defects are collected, nothing is written, and a
 * caller that only wants execution providers filters with
 * {@link executionProviders}.
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
    defects.push(defect('skill-missing', `no directory was discovered for skill "${candidate.name}"; a provider without a SKILL.md on disk cannot be an execution provider`))
    return refuse(undefined)
  }
  const directory = candidate.directory
  if (basename(directory) !== candidate.name) {
    defects.push(defect('skill-name-mismatch', `skill "${candidate.name}" resolves to directory ${directory}, whose name is "${basename(directory)}"; a skill directory is named after the skill it holds`))
  }
  const loaded = await loadSkillSidecar(directory)
  defects.push(...loaded.defects)
  const content = loaded.content
  const frontmatter = loaded.frontmatter
  // The name the file declares, checked against the name the capability grants
  // with the spawn's own sentence. Directory naming and declared naming are two
  // different ways to be wrong, and both would publish a body under a name its
  // author did not give it.
  if (frontmatter !== undefined && frontmatter.name !== candidate.name) {
    defects.push(defect('skill-name-mismatch', `skill file ${join(directory, 'SKILL.md')} declares name "${frontmatter.name}" but the capability grants "${candidate.name}"`))
  }

  if (candidate.sidecar !== undefined) {
    const suppliedDefects = skillContractDefects(candidate.sidecar)
    defects.push(...contractDefects(suppliedDefects))
    if (loaded.sidecar === undefined) {
      defects.push(defect('sidecar-mismatch', `skill "${candidate.name}" was checked against a supplied sidecar, but ${join(directory, SKILL_SIDECAR_FILE)} holds none; a declaration must describe the directory it is validated against`))
    } else if (suppliedDefects.length === 0 && skillContractDigest(loaded.sidecar) !== skillContractDigest(candidate.sidecar)) {
      defects.push(defect('sidecar-mismatch', `the supplied sidecar for skill "${candidate.name}" is not the declaration in ${join(directory, SKILL_SIDECAR_FILE)}`))
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
      defects.push(defect('verifier-unknown', `skill "${candidate.name}" declares execution verifier ${JSON.stringify(sidecar.verifier.ref)}, which is not registered; registered verifiers: ${registered.length === 0 ? 'none' : registered.join(', ')}`))
    }
    const tools = new Set<string>()
    const servers = new Set<string>()
    let grantComplete = true
    for (const capability of sidecar.capabilities) {
      const answer = context.capabilityTools(capability)
      if (!answer.known) {
        grantComplete = false
        defects.push(defect('capability-unknown', `skill "${candidate.name}" declares capability ${JSON.stringify(capability)}: ${answer.reason}`))
        continue
      }
      for (const tool of answer.tools) tools.add(tool)
      for (const server of answer.mcpServers) servers.add(server)
    }
    if (grantComplete) {
      // The worker baseline is deliberately not part of the covering set: a
      // capability must grant what the provider it carries needs, and a run
      // that only works because every worker happens to hold a tool is not a
      // capability that closed a gap.
      const uncoveredTools = sidecar.requiredTools.filter(tool =>
        !tools.has(tool) && ![...servers].some(server => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length))
      if (uncoveredTools.length > 0) {
        const granted = [...tools].sort().join(', ')
        defects.push(defect('tool-not-covered', `skill "${candidate.name}" requires tools its declared capabilities do not grant: ${[...uncoveredTools].sort().map(tool => JSON.stringify(tool)).join(', ')}; declared capabilities ${sidecar.capabilities.join(', ')} grant: ${granted}${servers.size === 0 ? '' : ` · mounted servers: ${[...servers].sort().join(', ')}`}`))
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
      outputs: sidecar.outputs.map(port => ({ name: port.name, description: port.description, required: port.required })),
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
 * declares, the DSH tool names those labels expand to, its preset, permission
 * and MCP servers — defaults and declaration order normalized away) plus every
 * provider's sidecar identity.
 *
 * What it covers, and what it deliberately does not: a run can cite this
 * revision to say which table and which declared provider content it resolved
 * against. Two runs with the same revision resolved the same rows over the same
 * declared sidecar content. It does **not** cover the bytes of a skill that
 * declares nothing (its identity is `null` here), the verifier registry's own
 * revisions, or the deployment's environment — a caller that needs those records
 * them separately rather than reading them into this digest.
 */
export function registryRevision(
  capabilities: Readonly<Record<string, CapabilityConfig>>,
  providers: readonly SkillProviderIdentity[],
): string {
  const table = Object.keys(capabilities)
    .sort()
    .map(name => {
      const entry = capabilities[name] as CapabilityConfig
      const answers = capabilityToolQuery(capabilities)(name)
      return {
        name,
        skills: [...new Set(entry.skills ?? [])].sort(),
        // Both the declared labels and the names they expand to: the labels are
        // what the config says, the names are what a worker is granted, and a
        // row whose labels do not resolve has an identity of its own instead of
        // an error message inside the digest.
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
  return sha256Hex(canonicalize({ capabilities: table, providers: sidecars }))
}
