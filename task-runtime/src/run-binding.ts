/**
 * The content a run is bound to, and the bytes it actually loads (S1-C item 4).
 * Why this exists at all: a capability row names a skill, and a skill is a
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import type {
  CapabilityManifest,
  RunId,
  RunMcpServerBinding,
  RunProviderBinding,
  RunSkillBinding,
} from '@dangosys/dsh-singularity-task'
import { SKILL_SIDECAR_FILE, skillContractDefects, skillContractDigest, skillContentDigest } from './skill-contract.ts'
import type { SkillSidecar } from './skill-contract.ts'
import type { CapabilityConfig } from './capability.ts'
import { manifestMcpServers, type McpServerTemplate } from './mcp-servers.ts'
import type { ProviderPrecheck } from './provider-precheck.ts'
import type { AcceptedSkillProviderVerdict, SkillDefect } from './sidecar.ts'
import { loadSkillSidecar, registryRevision } from './sidecar.ts'
import { readVerifiedFile } from './verified-read.ts'
import { message } from './helpers.ts'

/** The directory under one run's own directory that holds its `<name>/SKILL.md` entries — a skill root as `WorkerGrant.skillRoots` expects. */
export const RUN_BINDING_SKILLS_DIR = 'skills'

/**
 * Where run bindings are materialized unless the deployment says otherwise:
 * `<DSH_HOME or ~/.dsh>/singularity/run-bindings`, resolved per call so a test
 */
export function defaultRunBindingRoot(): string {
  const home =
    process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'singularity', 'run-bindings')
}

/** Everything one run needs to bind its content: the verdicts, the rows, and where the snapshot goes. */
interface RunBindingRequest {
  /** The store the run belongs to; scopes the snapshot directory. */
  storeId: string
  /** The run the snapshot is scoped to. */
  runId: RunId
  /** The run's resolved manifest: its rows are the run's capability rows and its granted servers. */
  manifest: CapabilityManifest
  /**
   * The admission-time pre-check this run's verdicts come from. Absent when the
   * caller must supply a fresh pre-check before this run can execute.
   */
  providers?: ProviderPrecheck
  /** The capability table the run resolved against; its revision is recorded when no pre-check carries one. */
  table?: Readonly<Record<string, CapabilityConfig>>
  /** Where the run snapshot is materialized; absent means this deployment cannot materialize content, which fails a run that selected any. */
  root?: string
  /** The MCP template registry the granted server names resolve against (tests pass their own). */
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
}

/** One provider selected for a run: the verdict it came from plus the run's rows that grant it. */
interface SelectedProvider {
  readonly verdict: AcceptedSkillProviderVerdict
  readonly capabilities: string[]
}

/** The identity one accepted verdict contributes to a run's record. */
function skillBinding(provider: SelectedProvider): RunSkillBinding {
  const { verdict, capabilities } = provider
  return {
    name: verdict.name,
    role: verdict.role,
    capabilities: [...capabilities],
    description: verdict.description,
    contractDigest: verdict.role === 'guidance' ? null : verdict.contractDigest,
    contentDigest: verdict.contentDigest,
    uncovered: verdict.role === 'guidance' ? [...verdict.uncovered] : [],
  }
}

/**
 * The providers one run selects: every accepted verdict of the run's own rows,
 * one entry per skill name, carrying the rows that grant it.
 */
function selectedProviders(
  providers: ProviderPrecheck | undefined,
  rows: readonly string[],
  declaredBy: (row: string) => readonly string[],
): SelectedProvider[] {
  if (providers === undefined) return []
  const accepted = new Map<string, { verdict: AcceptedSkillProviderVerdict; capabilities: Set<string> }>()
  const refused = new Map<string, SkillDefect[]>()
  for (const row of providers.capabilities) {
    if (!rows.includes(row.capability)) continue
    /**
     * A row an open evolution commit intent moves was refused before it was
     * resolved (A6): its declared skills are refused with the row's own reason,
     */
    if ((row.refusals ?? []).length > 0) {
      for (const name of declaredBy(row.capability)) refused.set(name, [...(refused.get(name) ?? []), ...row.refusals!])
      continue
    }
    for (const verdict of row.skills) {
      if (!verdict.valid) {
        refused.set(verdict.name, [...(refused.get(verdict.name) ?? []), ...verdict.defects])
        continue
      }
      const existing = accepted.get(verdict.name)
      if (existing === undefined) accepted.set(verdict.name, { verdict, capabilities: new Set([row.capability]) })
      else existing.capabilities.add(row.capability)
    }
  }
  const missing = [...new Set(rows.flatMap(row => declaredBy(row)))].filter(name => !accepted.has(name))
  if (missing.length > 0) {
    const why = missing.map(name =>
      refused.has(name)
        ? `"${name}" (${refused
            .get(name)!
            .map(defect => `${defect.code}: ${defect.detail}`)
            .join('; ')})`
        : `"${name}" (no verdict was taken for it)`,
    )
    throw new Error(
      `the pre-check this run was admitted with holds no accepted provider for skill${missing.length > 1 ? 's' : ''} ${why.join(', ')}; ` +
        'a run loads only content its admission judged, so it cannot be started against an unjudged skill',
    )
  }
  return [...accepted.entries()]
    .map(([, entry]) => ({ verdict: entry.verdict, capabilities: [...entry.capabilities].sort() }))
    .sort((left, right) =>
      left.verdict.name < right.verdict.name ? -1 : left.verdict.name > right.verdict.name ? 1 : 0,
    )
}

/** The granted MCP servers' identity: the registry key and the template it resolved to, or `null` when the registry holds no such key. */
export function mcpServerBindings(
  manifest: CapabilityManifest,
  registry: Readonly<Record<string, McpServerTemplate>>,
): RunMcpServerBinding[] {
  return manifestMcpServers(manifest).map(serverName => {
    const template = registry[serverName]
    /**
     * Canonical JSON, the same identity rule the registry revision and the task
     * contract use: a template edited in any way moves the digest, and a mere
     */
    return {
      serverName,
      templateDigest: template === undefined ? null : sha256Hex(canonicalize(template)),
    }
  })
}

/**
 * Copy one selected provider's admitted bytes into the run's snapshot.
 * Every file is read through the verified walk (a link or a wrong type anywhere
 */
async function materializeProvider(provider: SelectedProvider, snapshotRoot: string, runId: RunId): Promise<void> {
  const { verdict } = provider
  const target = join(snapshotRoot, verdict.name)
  await mkdir(target, { recursive: true })
  const files: { rel: string; sha256: string }[] = [
    { rel: 'SKILL.md', sha256: verdict.content.skillMdSha256 },
    ...verdict.content.resources.map(resource => ({ rel: resource.path, sha256: resource.sha256 })),
  ]
  for (const file of files) {
    let bytes: Buffer
    try {
      bytes = await readVerifiedFile(verdict.directory, file.rel)
    } catch (error) {
      throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message(error)}`)
    }
    const read = sha256Hex(bytes)
    if (read !== file.sha256) {
      throw new Error(
        `run "${runId}" cannot bind skill "${verdict.name}": ${file.rel} at ${verdict.directory} is not the admitted content ` +
          `(admitted ${file.sha256}, read ${read}); the provider changed after it was judged`,
      )
    }
    const at = join(target, file.rel)
    await mkdir(dirname(at), { recursive: true })
    await writeFile(at, bytes)
  }
  if (verdict.role === 'guidance') return
  let sidecarBytes: Buffer
  try {
    sidecarBytes = await readVerifiedFile(verdict.directory, SKILL_SIDECAR_FILE)
  } catch (error) {
    throw new Error(`run "${runId}" cannot bind skill "${verdict.name}": ${message(error)}`)
  }
  let declared: unknown
  try {
    declared = JSON.parse(sidecarBytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `run "${runId}" cannot bind skill "${verdict.name}": ${SKILL_SIDECAR_FILE} is not readable JSON: ${message(error)}`,
    )
  }
  const defects = skillContractDefects(declared)
  if (defects.length > 0) {
    throw new Error(
      `run "${runId}" cannot bind skill "${verdict.name}": the declaration in ${verdict.directory} is not a valid sidecar (${defects.map(item => `${item.code}: ${item.reason}`).join('; ')})`,
    )
  }
  const digest = skillContractDigest(declared as SkillSidecar)
  if (digest !== verdict.contractDigest) {
    throw new Error(
      `run "${runId}" cannot bind skill "${verdict.name}": the declaration in ${verdict.directory} is not the one it was judged against ` +
        `(judged ${verdict.contractDigest}, read ${digest})`,
    )
  }
  await writeFile(join(target, SKILL_SIDECAR_FILE), sidecarBytes)
}

/**
 * Bind one run's content: identify the providers its admission judged,
 * materialize their admitted bytes, and verify the snapshot against the record
 */
export async function bindRunProviders(request: RunBindingRequest): Promise<RunProviderBinding> {
  const rows = Object.keys(request.manifest.capabilities)
  const selected = selectedProviders(request.providers, rows, row => request.manifest.capabilities[row]?.skills ?? [])
  if (selected.length === 0) {
    throw new Error(`run "${request.runId}" has no admitted guidance Skill; every task must select readable instructions through requiredCapabilities`)
  }
  let instructionBytes = 0
  for (const provider of selected) {
    instructionBytes += (await readVerifiedFile(provider.verdict.directory, 'SKILL.md')).byteLength
  }
  // Reserve room for the contract and execution facts in the 50 KB context read.
  if (instructionBytes > 40_000) {
    throw new Error(
      `run "${request.runId}" selects ${instructionBytes} bytes of Skill instructions, above the 40000-byte inline guidance budget; ` +
      'select concise relevant guidance, move supporting material into Skill resources, or delegate distinct responsibilities before starting this Run',
    )
  }
  const base: RunProviderBinding = {
    registryRevision: request.providers?.revision ?? registryRevision(request.table ?? {}, [], request.mcpRegistry),
    capabilities: [...rows].sort(),
    skills: selected.map(skillBinding),
    mcpServers: mcpServerBindings(request.manifest, request.mcpRegistry ?? {}),
  }
  const root = request.root
  if (root === undefined) {
    throw new Error(
      `run "${request.runId}" selects skills [${selected.map(provider => provider.verdict.name).join(', ')}] but this deployment configures no run binding root ` +
        '(`Config.runBindingRoot`); without one the run cannot load content it was admitted against',
    )
  }
  const runDirectory = join(root, request.storeId, request.runId)
  const snapshotRoot = join(runDirectory, RUN_BINDING_SKILLS_DIR)
  await mkdir(dirname(runDirectory), { recursive: true })
  try {
    /**
     * The run's own directory is created exclusively: an existing one belongs to
     * a run that already bound (and is re-checked, never overwritten), or to
     */
    await mkdir(runDirectory)
  } catch (error) {
    throw new Error(
      `run "${request.runId}" cannot bind content: ${runDirectory} already exists (${message(error)}); a run materializes once`,
    )
  }
  try {
    for (const provider of selected) await materializeProvider(provider, snapshotRoot, request.runId)
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true })
    throw error
  }
  const binding: RunProviderBinding = { ...base, snapshotRoot }
  const read = await readRunBinding(binding)
  if (read !== undefined && read.defects.length > 0) {
    await rm(runDirectory, { recursive: true, force: true })
    throw new Error(
      `run "${request.runId}" cannot bind content: the snapshot it just wrote does not read back as the record describes it:\n- ${read.defects.join('\n- ')}`,
    )
  }
  return binding
}

/** One skill's re-read result: whether the snapshot still holds the bytes the record names, and why not. */
interface RunBindingSkillRead {
  /** The skill name the record names. */
  readonly name: string
  /** The role the run was bound to it as. */
  readonly role: RunSkillBinding['role']
  /** True when the snapshot directory holds exactly the recorded content and declaration. */
  readonly readable: boolean
  /** Every reason this skill's content is not readable as recorded, each naming its code. */
  readonly defects: readonly string[]
  /** Present only when the bound instruction bytes read back without defects. */
  readonly instructions?: string
}

/** What re-reading one run's binding found. */
export interface RunBindingRead {
  /** The snapshot root the record names. */
  readonly snapshotRoot: string
  /** One entry per skill in record order. */
  readonly skills: readonly RunBindingSkillRead[]
  /** Every reason any skill's content is not readable as recorded; empty means the whole snapshot verified. */
  readonly defects: readonly string[]
}

/**
 * Re-check one run's binding against the bytes its snapshot holds now — the read
 * a later reader (an old run's summary, a re-entry, a recovery path) performs
 */
export async function readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined> {
  const root = binding.snapshotRoot
  if (root === undefined) return undefined
  const skills: RunBindingSkillRead[] = []
  const rootDefects: string[] = []
  const recorded = new Set(binding.skills.map(skill => skill.name))
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true })).map(entry => entry.name)
  } catch (error) {
    entries = []
    rootDefects.push(`${root} cannot be read: ${message(error)}; the content this run was bound to is not available`)
  }
  for (const name of entries) {
    if (!recorded.has(name)) {
      rootDefects.push(
        `${join(root, name)} is not a skill this run's record names; a worker's skill layer would register it, so it is reported rather than ignored`,
      )
    }
  }
  for (const skill of binding.skills) {
    const loaded = await loadSkillSidecar(join(root, skill.name))
    const defects: string[] = loaded.defects.map(defect => `${defect.code}: ${defect.detail}`)
    if (loaded.content === undefined) {
      if (defects.length === 0) defects.push(`skill-missing: ${join(root, skill.name)} holds no readable SKILL.md`)
    } else {
      const digest = skillContentDigest(loaded.content)
      if (digest !== skill.contentDigest) {
        defects.push(
          `content-mismatch: ${join(root, skill.name, 'SKILL.md')} and its resources are not the bound content: bound ${skill.contentDigest}, read ${digest}`,
        )
      }
      if (loaded.frontmatter === undefined && defects.length === 0) {
        defects.push(
          `skill-file-invalid: ${join(root, skill.name, 'SKILL.md')} declares no frontmatter a worker could load`,
        )
      } else if (loaded.frontmatter !== undefined && loaded.frontmatter.name !== skill.name) {
        defects.push(
          `skill-name-mismatch: skill file ${join(root, skill.name, 'SKILL.md')} declares name "${loaded.frontmatter.name}" but the record binds "${skill.name}"`,
        )
      }
      const declared = loaded.sidecar === undefined ? null : skillContractDigest(loaded.sidecar)
      if (declared !== skill.contractDigest) {
        defects.push(
          `sidecar-mismatch: the declaration in ${join(root, skill.name)} is not the one the run was bound to: bound ${skill.contractDigest ?? 'none'}, read ${declared ?? 'none'}`,
        )
      }
      /**
       * What a guidance skill's identity does *not* cover, re-read against the
       * snapshot: the loader names the directory's root entries outside its
       */
      if (skill.role === 'guidance' && loaded.sidecar === undefined) {
        for (const entry of [...loaded.uncovered].sort()) {
          const noted = skill.uncovered.includes(entry)
            ? "; this run's record lists it as uncovered in the source skill, and a snapshot carries bound content only"
            : ''
          defects.push(
            `content-mismatch: ${join(root, skill.name)} holds ${JSON.stringify(entry)}, which the content identity this run is bound to does not cover${noted}`,
          )
        }
      }
    }
    skills.push({
      name: skill.name, role: skill.role, readable: defects.length === 0, defects,
      ...(defects.length > 0 || loaded.instructions === undefined ? {} : { instructions: loaded.instructions }),
    })
  }
  const defects = [
    ...rootDefects,
    ...skills.flatMap(skill => skill.defects.map(defect => `skill "${skill.name}": ${defect}`)),
  ]
  return { snapshotRoot: root, skills, defects }
}
