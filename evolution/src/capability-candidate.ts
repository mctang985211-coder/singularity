/** The capability candidate (A6): one whole capability row plus an optional new skill object, prepared and committed as one unit.
 * @module dsh-singularity-evolution/capability-candidate */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerTemplate, CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import {
  capabilityToolQuery,
  parseMcpServerRegistry,
  readVerifiedFile,
  skillContractDefects,
  SKILL_SIDECAR_FILE,
  walkVerified,
} from '@dangosys/dsh-singularity-task-runtime'
import type { SkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from './evolution.ts'
import { canonicalJson, digestOf } from './replay.ts'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { assertSegment as sharedSegment, codedRefusal, isRecord, nonEmpty as sharedNonEmpty } from './shared.ts'

/** The keys a capability row may declare — the whole vocabulary `CapabilityConfig` has. */
const ROW_KEYS: readonly string[] = ['skills', 'tools', 'preset', 'permission', 'mcpServers']

/** The keys one capability mutation may declare: the rows, and the optional new skill. */
const MUTATION_KEYS: readonly string[] = ['rows', 'skill', 'mcpServers']

/** The keys one carried new skill may declare. */
const SKILL_KEYS: readonly string[] = ['name', 'content', 'sidecar']

/** The refusal of one rule, carrying its machine-readable code as the message's second word. */
export function capabilityRefusal(code: string, detail: string): Error {
  return codedRefusal(code, detail)
}

/** The same refusal, as the one function every rule in this module reports through. */
function refusal(code: string, detail: string): Error {
  return capabilityRefusal(code, detail)
}

function nonEmpty(value: unknown, field: string): string {
  return sharedNonEmpty(value, field, detail => refusal('capability-row-invalid', detail))
}

/** A single safe path segment: the skill-name rule every other entry of this plane uses. */
function assertSegment(value: unknown, field: string): string {
  return sharedSegment(value, field, detail => refusal('capability-row-invalid', detail))
}

/** One whole capability row: its name and its entry, as the candidate submits them. */
export interface CapabilityRow {
  name: string
  entry: CapabilityConfig
}

/** The new execution skill a capability candidate may carry: the text, and the declaration that authorises it. */
export interface CapabilitySkill {
  name: string
  /** The whole `SKILL.md` text (frontmatter included). */
  content: string
  /** The `SKILL.contract.json` declaration this new object carries — authored, because there is no production object to derive it from. */
  sidecar: SkillSidecar
}

/** One validated capability mutation, normalized. */
interface CapabilityCandidate {
  row: CapabilityRow
  skill?: CapabilitySkill
  mcpServers?: Record<string, McpServerTemplate>
}

/** The frozen identity of one capability row: its name, the row itself, and the digest of its canonical bytes. */
export interface CapabilityRowIdentity {
  name: string
  entry: CapabilityConfig
  digest: string
}

export interface McpServerIdentity { definitions: Record<string, McpServerTemplate>; digest: string }

export function mcpServerIdentity(value: unknown): McpServerIdentity {
  const definitions = parseMcpServerRegistry(value)
  return { definitions, digest: digestOf(definitions) }
}

export function assertMcpServerIdentity(value: unknown): McpServerIdentity {
  if (!isRecord(value)) throw refusal('capability-server-invalid', 'MCP identity must be an object')
  const identity = mcpServerIdentity(value.definitions)
  if (value.digest !== identity.digest) throw refusal('capability-server-drifted', 'MCP identity digest does not match its definitions')
  return identity
}

/** The overlay a candidate-side evaluation mounts on this candidate (A6 interface): the table override and the sandbox skill roots. */
interface CapabilityOverlay {
  capabilityOverrides: Record<string, CapabilityConfig>
  extraSkillRoots: string[]
  mcpServers?: Record<string, McpServerTemplate>
}

/** The canonical bytes of one row — what a sandbox freezes and an intent's source holds. */
export function capabilityRowBytes(entry: CapabilityConfig): string {
  return canonicalJson(entry)
}

/** SHA-256 of {@link capabilityRowBytes}: the identity a row is compared by, everywhere. */
export function capabilityRowDigest(entry: CapabilityConfig): string {
  return digestOf(entry)
}

/** The frozen identity of one row, as a prepared record and a commit intent name it. */
export function capabilityRowIdentity(row: CapabilityRow): CapabilityRowIdentity {
  return { name: row.name, entry: row.entry, digest: capabilityRowDigest(row.entry) }
}

/** The table a candidate would produce: the store's rows with this one row folded in. */
export function capabilityTableWith(
  table: Readonly<Record<string, CapabilityConfig>>,
  row: CapabilityRow,
): Record<string, CapabilityConfig> {
  return { ...table, [row.name]: row.entry }
}

/** Validate one capability row's shape and return it normalized — the whole row, no inherited field and no unknown key. */
export function assertCapabilityRow(where: string, value: unknown): CapabilityConfig {
  if (!isRecord(value)) {
    throw refusal(
      'capability-row-invalid',
      `${where} must be an object carrying the row's own fields (${ROW_KEYS.join(', ')})`,
    )
  }
  for (const key of Object.keys(value)) {
    if (!ROW_KEYS.includes(key)) {
      throw refusal(
        'capability-row-invalid',
        `${where} declares unknown field ${JSON.stringify(key)}; a capability row carries ${ROW_KEYS.join(', ')}`,
      )
    }
  }
  const names = (field: string, list: unknown, minItems: number): string[] | undefined => {
    if (list === undefined) return undefined
    if (!Array.isArray(list)) throw refusal('capability-row-invalid', `${where}.${field} must be an array`)
    const seen = new Set<string>()
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw refusal('capability-row-invalid', `${where}.${field} must hold non-empty strings`)
      }
      if (seen.has(item))
        throw refusal('capability-row-invalid', `${where}.${field} lists ${JSON.stringify(item)} twice`)
      seen.add(item)
    }
    if (list.length < minItems)
      throw refusal('capability-row-invalid', `${where}.${field} must name at least ${minItems} entry`)
    return [...list]
  }
  const skills = names('skills', value.skills, 0)
  const entry: CapabilityConfig = skills === undefined ? {} : { skills }
  const tools = names('tools', value.tools, 0)
  if (tools !== undefined) entry.tools = tools
  const mcpServers = names('mcpServers', value.mcpServers, 0)
  if (mcpServers !== undefined) entry.mcpServers = mcpServers
  for (const field of ['preset', 'permission'] as const) {
    const declared = value[field]
    if (declared === undefined) continue
    if (typeof declared !== 'string' || declared.trim().length === 0) {
      throw refusal('capability-row-invalid', `${where}.${field} must be a non-empty string`)
    }
    entry[field] = declared
  }
  if ((skills?.length ?? 0) + (tools?.length ?? 0) + (mcpServers?.length ?? 0) === 0)
    throw refusal('capability-row-invalid', `${where} must grant a skill, native tool or MCP server`)
  return entry
}

/** The declaration of one carried new skill, validated: shape, loader acceptance, then the rules a new object must satisfy. */
function assertCarriedSkill(row: CapabilityRow, value: unknown): CapabilitySkill {
  if (!isRecord(value)) {
    throw refusal('skill-invalid', "the candidate's skill must be an object carrying name, content and sidecar")
  }
  for (const key of Object.keys(value)) {
    if (!SKILL_KEYS.includes(key)) {
      throw refusal(
        'skill-invalid',
        `the candidate's skill declares unknown field ${JSON.stringify(key)}; it carries ${SKILL_KEYS.join(', ')}`,
      )
    }
  }
  const name = assertSegment(value.name, 'skill.name')
  if (typeof value.content !== 'string' || value.content.length === 0) {
    throw refusal('skill-invalid', 'skill.content must be the whole non-empty SKILL.md text')
  }
  const content = value.content
  const defects = skillContractDefects(value.sidecar)
  if (defects.length > 0) {
    throw refusal(
      'skill-sidecar-invalid',
      `the declaration of the new skill "${name}" is not one this build reads — ` +
        `${defects.map(defect => `${defect.code}: ${defect.reason}`).join('; ')}`,
    )
  }
  const sidecar = value.sidecar as SkillSidecar
  if (sidecar.type !== 'execution') {
    throw refusal(
      'skill-sidecar-not-execution',
      `the new skill "${name}" carries a ${sidecar.type} declaration, and a capability candidate's skill is the execution provider its row grants — ` +
        'a knowledge or guidance object claims no capability and no verifier, so it is not the object this row would install',
    )
  }
  if (sidecar.content.resources.length > 0) {
    throw refusal(
      'skill-resources-nonempty',
      `the new skill "${name}" declares ${sidecar.content.resources.length} resource(s) ` +
        `(${sidecar.content.resources.map(resource => JSON.stringify(resource.path)).join(', ')}), and this build's candidate is ` +
        'SKILL.md plus the SKILL.contract.json beside it with `resources: []` — resources need an executor that writes them, ' +
        'so the candidate is refused before anything is written',
    )
  }
  const digest = sha256Hex(content)
  if (sidecar.content.skillMdSha256 !== digest) {
    throw refusal(
      'skill-content-mismatch',
      `the new skill "${name}" declares content.skillMdSha256 ${sidecar.content.skillMdSha256}, but the submitted SKILL.md hashes to ${digest} — ` +
        'the declaration must be the identity of the bytes it authorises',
    )
  }
  if (!sidecar.capabilities.includes(row.name)) {
    throw refusal(
      'skill-capabilities-missing-row',
      `the new skill "${name}" declares capabilities [${sidecar.capabilities.join(', ')}], which does not include the row "${row.name}" this ` +
        "candidate writes — a provider the candidate's own capability does not carry would be granted by nothing",
    )
  }
  if (!(row.entry.skills ?? []).includes(name)) {
    throw refusal(
      'capability-row-grants-no-skill',
      `the row "${row.name}" grants [${(row.entry.skills ?? []).join(', ')}], which does not include the new skill "${name}" this candidate carries — ` +
        'the row is what grants the provider, so a candidate that writes a skill nothing grants is refused',
    )
  }
  return { name, content, sidecar }
}

/** Validate one whole capability mutation and return it normalized. The entry carries one row and an optional new skill. */
export function validateCapabilityMutation(mutation: unknown): CapabilityCandidate {
  if (!isRecord(mutation)) {
    throw refusal(
      'capability-row-missing',
      'a capability mutation must be an object carrying exactly one row under `rows`',
    )
  }
  for (const key of Object.keys(mutation)) {
    if (!MUTATION_KEYS.includes(key)) {
      throw refusal(
        'capability-row-invalid',
        `a capability mutation declares unknown key ${JSON.stringify(key)}; it carries ${MUTATION_KEYS.join(', ')}`,
      )
    }
  }
  const rows = mutation.rows
  if (!isRecord(rows)) {
    throw refusal(
      'capability-row-missing',
      'a capability mutation carries `rows` — an object holding exactly one capability row',
    )
  }
  const names = Object.keys(rows)
  if (names.length === 0) {
    throw refusal(
      'capability-row-missing',
      'a capability mutation carries no row: exactly one capability row is the unit this build prepares',
    )
  }
  if (names.length > 1) {
    throw refusal(
      'capability-row-multiple',
      `a capability mutation carries ${names.length} rows (${names.map(name => JSON.stringify(name)).join(', ')}); exactly one whole row is the ` +
        'unit this build prepares, and a candidate that moved several rows is refused rather than split',
    )
  }
  const row: CapabilityRow = {
    name: nonEmpty(names[0]!, 'row name'),
    entry: assertCapabilityRow(`row "${names[0]!}"`, rows[names[0]!]),
  }
  const skill = mutation.skill === undefined ? undefined : assertCarriedSkill(row, mutation.skill)
  const mcpServers = mutation.mcpServers === undefined ? undefined : parseMcpServerRegistry(mutation.mcpServers)
  if (mcpServers !== undefined) {
    if (Object.keys(mcpServers).length === 0) throw refusal('capability-server-invalid', 'mcpServers must carry at least one definition')
    for (const name of Object.keys(mcpServers)) if (!(row.entry.mcpServers ?? []).includes(name))
      throw refusal('capability-server-ungranted', `server ${name} is not granted by row ${row.name}`)
  }
  return { row, ...(skill === undefined ? {} : { skill }), ...(mcpServers === undefined ? {} : { mcpServers }) }
}

/** The real DSH tools and MCP servers a store's current capability table authorizes. */
function authorizedToolPlane(table: Readonly<Record<string, CapabilityConfig>>, registry?: Readonly<Record<string, McpServerTemplate>>): {
  tools: Set<string>
  servers: Set<string>
} {
  const tools = new Set<string>()
  const servers = new Set<string>()
  const query = capabilityToolQuery(table, registry)
  for (const name of Object.keys(table)) {
    const answer = query(name)
    if (!answer.known) continue
    for (const tool of answer.tools) tools.add(tool)
    for (const server of answer.mcpServers) servers.add(server)
  }
  return { tools, servers }
}

/** Whether one tool a declaration requires is inside the store's authorized plane (`mcp__<server>__<tool>` counts when the server is mounted). */
function insidePlane(plane: { tools: Set<string>; servers: Set<string> }, tool: string): boolean {
  if (plane.tools.has(tool)) return true
  return [...plane.servers].some(
    server => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length,
  )
}

/** The store view the candidate's rules read: the effective capability table, the verifier vocabulary and every skill root. */
export interface CapabilityStoreView {
  readonly table: Readonly<Record<string, CapabilityConfig>>
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate>>
  /** `undefined` when the deployment cannot list its verifiers — an execution provider is then refused rather than assumed registered. */
  readonly verifierVocabulary?: { readonly ids: readonly string[]; readonly versions: Readonly<Record<string, string>> }
  /** Every root discovery searches, in order (the production root first when the caller has it). */
  readonly skillRoots: readonly string[]
  /** The production skill root a candidate's new directory would land in. */
  readonly skillRoot: string
}

/** Whether one candidate row may be written at all: no tool the store has not granted and no unknown MCP server. */
function assertCapabilityRowAdmissible(
  store: CapabilityStoreView,
  row: CapabilityRow,
  baseline: CapabilityConfig | null,
  definitions: Record<string, McpServerTemplate> = {},
): void {
  const replacement = capabilityTableWith(store.table, row)
  const registry = parseMcpServerRegistry({ ...store.mcpServers, ...definitions })
  const answer = capabilityToolQuery(replacement, registry)(row.name)
  if (!answer.known) {
    throw refusal('capability-row-invalid', `the row "${row.name}" does not resolve: ${answer.reason}`)
  }
  const plane = authorizedToolPlane(store.table, store.mcpServers ?? {})
  const newTools = answer.tools.filter(tool => !plane.tools.has(tool))
  if (newTools.length > 0) {
    throw refusal(
      'capability-new-tool',
      `the row "${row.name}" grants tool(s) this store's capability table does not authorize ` +
        `(${newTools.map(tool => JSON.stringify(tool)).join(', ')}); this build composes granted capabilities and never authorizes a new tool — ` +
        'a provider that needs one is refused by name',
    )
  }
  for (const field of ['preset', 'permission'] as const) {
    if (row.entry[field] === baseline?.[field]) continue
    throw refusal(
      'capability-policy-change',
      `the row "${row.name}" declares ${field} ${row.entry[field] === undefined ? '(none)' : JSON.stringify(row.entry[field])}, while the store's ` +
        `row reads ${baseline?.[field] === undefined ? '(none)' : JSON.stringify(baseline?.[field])} — a capability candidate composes granted ` +
        'capabilities and adds a provider, and never moves the permission or preset a worker runs under',
    )
  }

}

/** One existing production object's `SKILL.md`, as the name and body a new candidate must not repeat. */
interface ExistingSkill {
  name: string
  body: string
}

/** The `SKILL.md` discovery finds for one skill name under `roots`, or `undefined` */
export async function discoverSkill(roots: readonly string[], name: string): Promise<string | undefined> {
  for (const root of [...new Set(roots)]) {
    let walked
    try {
      walked = await walkVerified(root, join(name, 'SKILL.md'))
    } catch {
      continue
    }
    if (!walked.missing) return walked.abs
  }
  return undefined
}

/** Every skill object discovery can see, read through the walk-verified read (a link that escapes or loops is refused by name). */
async function existingSkills(roots: readonly string[]): Promise<ExistingSkill[]> {
  const found: ExistingSkill[] = []
  for (const root of [...new Set(roots)]) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      let walked
      try {
        walked = await walkVerified(root, join(entry.name, 'SKILL.md'))
      } catch {
        continue
      }
      if (walked.missing) continue
      const bytes = await readFile(walked.abs)
      found.push({ name: entry.name, body: skillBody(bytes.toString('utf8')) })
    }
  }
  return found
}

/** Whether the declared verifier is one this deployment can judge a run with: it must be registered, else the row is refused by name. */
function assertVerifierRegistered(store: CapabilityStoreView, name: string, ref: string): void {
  const vocabulary = store.verifierVocabulary
  if (vocabulary === undefined) {
    throw refusal(
      'skill-verifier-unregistered',
      `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, and this deployment cannot list its verifier registry ` +
        '(no verifier service, or `verifierIds()` unavailable) — the ref is refused rather than assumed registered',
    )
  }
  const registered = [...vocabulary.ids].sort()
  if (!vocabulary.ids.includes(ref)) {
    throw refusal(
      'skill-verifier-unregistered',
      `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, which is not registered; registered verifiers: ` +
        `${registered.length === 0 ? 'none' : registered.join(', ')} — a candidate does not register its own judge`,
    )
  }
  const version = vocabulary.versions[ref]
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw refusal(
      'skill-verifier-unregistered',
      `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, which the registry lists without a declared version — a judge ` +
        'no evidence can be pinned to is not one this build promotes against',
    )
  }
}

/** Every rule the capability candidate itself must satisfy against the store it will be written to. */
export async function assertCapabilityCandidateAdmissible(
  store: CapabilityStoreView,
  candidate: CapabilityCandidate,
  baseline: CapabilityConfig | null,
): Promise<void> {
  for (const key of Object.keys(candidate.mcpServers ?? {})) if (store.mcpServers?.[key] !== undefined)
    throw refusal('capability-server-conflict', `MCP server ${key} already exists in the deployment registry`)
  assertCapabilityRowAdmissible(store, candidate.row, baseline, candidate.mcpServers)
  const skill = candidate.skill
  if (skill === undefined) return
  assertVerifierRegistered(store, skill.name, skill.sidecar.type === 'execution' ? skill.sidecar.verifier.ref : '')
  const plane = authorizedToolPlane(capabilityTableWith(store.table, candidate.row), { ...store.mcpServers, ...candidate.mcpServers })
  const unauthorized =
    skill.sidecar.type === 'execution' ? skill.sidecar.requiredTools.filter(tool => !insidePlane(plane, tool)) : []
  if (unauthorized.length > 0) {
    throw refusal(
      'skill-tool-unauthorized',
      `the new skill "${skill.name}" requires tool(s) this store's capability table does not authorize ` +
        `(${unauthorized
          .map(tool => JSON.stringify(tool))
          .sort()
          .join(', ')}); this build composes the tools a deployment already grants, and a ` +
        'provider that needs a new one is refused by name rather than granted',
    )
  }
  const body = skillBody(skill.content)
  const existing = await existingSkills([store.skillRoot, ...store.skillRoots])
  const taken = existing.find(entry => entry.name === skill.name)
  if (taken !== undefined) {
    throw refusal(
      'skill-name-taken',
      `the candidate's new skill is named "${skill.name}", which is already a skill object this store's discovery finds — a new directory may not ` +
        'cover a same-name production object; improving that object is the same-name update (a `skill` candidate), not a new skill',
    )
  }
  const renamed = body.length === 0 ? undefined : existing.find(entry => entry.body === body)
  if (renamed !== undefined) {
    throw refusal(
      'skill-renamed-production',
      `the candidate's new skill "${skill.name}" carries the same body as the production skill "${renamed.name}" — a renamed copy is not a new ` +
        'object, and an existing object is improved through the same-name path rather than around it',
    )
  }
}

/** The body of one `SKILL.md`: everything after its frontmatter block, trimmed. */
function skillBody(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return content.trim()
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end === -1
    ? content.trim()
    : lines
        .slice(end + 1)
        .join('\n')
        .trim()
}

/** The candidate-side overlay of one prepared capability proposal (A6 interface): the frozen row override and the sandbox skill roots. */
export function capabilityOverlay(proposal: EvolutionProposal, roots: { root: string }): CapabilityOverlay {
  const prepared = proposal.prepared
  const row = prepared?.capabilityRow
  if (prepared?.sandbox == null || row === undefined) {
    throw refusal(
      'capability-overlay-unprepared',
      `proposal "${proposal.proposalId}" carries no prepared capability candidate — an overlay is the identity prepare froze, so a proposal ` +
        'without one has nothing to mount',
    )
  }
  return {
    capabilityOverrides: { [row.name]: row.entry },
    ...(prepared.mcpServers === undefined ? {} : { mcpServers: prepared.mcpServers.definitions }),
    extraSkillRoots: prepared.skillContent === undefined ? [] : [join(roots.root, prepared.sandbox, 'skills')],
  }
}

/** The prepared candidate as its bytes: the row (and its baseline), the new skill, every file read and verified. */
export interface PreparedCapability {
  /** The candidate row, read back from the sandbox and verified against `prepared.capabilityRow`. */
  row: CapabilityRow
  rowBytes: Buffer
  mcpServers?: McpServerIdentity
  /** The row the store held at prepare, with its frozen champion bytes — `undefined` when the store held none. */
  baseline?: { entry: CapabilityConfig; bytes: Buffer }
  /** The new skill, when the candidate carries one: the declaration and the exact bytes prepare froze. */
  skill?: CapabilitySkill & { skillMd: Buffer; sidecarBytes: Buffer }
  /** The sandbox root the new skill's directory lives under (`<sandbox>/skills`) — the extra discovery root a row pre-check mounts. */
  skillRoot?: string
  /** The sandbox directory of the new skill, as a loader would read it (only when `skill` is present). */
  skillDirectory?: string
}

/** Read one prepared capability candidate back from its sandbox and verify it against the identity prepare froze. */
export async function readPreparedCapability(root: string, proposal: EvolutionProposal): Promise<PreparedCapability> {
  const prepared = proposal.prepared
  const identity = prepared?.capabilityRow
  if (prepared?.sandbox == null || identity === undefined) {
    throw refusal(
      'capability-unprepared',
      `proposal "${proposal.proposalId}" has no materialized capability candidate — nothing this proposal names was ever prepared, so ` +
        'there is nothing to evaluate, promote or write',
    )
  }
  const sandbox = prepared.sandbox
  const rowRel = `${sandbox}/capability/${identity.name}.json`
  const rowBytes = await readVerifiedFile(root, rowRel)
  const digest = sha256Hex(rowBytes)
  if (digest !== identity.digest) {
    throw refusal(
      'capability-row-drifted',
      `the frozen row "${rowRel}" no longer hashes to the identity prepare recorded (sha256 ${digest} != ${identity.digest}) — ` +
        'propose a new candidate and re-evaluate it; recorded identities are never re-digested',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rowBytes.toString('utf8'))
  } catch (error) {
    throw refusal(
      'capability-row-invalid',
      `the frozen row "${rowRel}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const entry = assertCapabilityRow(`the frozen row "${identity.name}"`, parsed)
  if (capabilityRowDigest(entry) !== identity.digest) {
    throw refusal(
      'capability-row-drifted',
      `the frozen row "${rowRel}" holds data that hashes to ${capabilityRowDigest(entry)}, not the ${identity.digest} prepare recorded`,
    )
  }
  const result: PreparedCapability = { row: { name: identity.name, entry }, rowBytes }
  if (prepared.capabilityBaseline != null) {
    const baselineRel = `${sandbox}/champion/capability/${identity.name}.json`
    const bytes = await readVerifiedFile(root, baselineRel)
    const baselineDigest = sha256Hex(bytes)
    if (baselineDigest !== prepared.capabilityBaseline.digest) {
      throw refusal(
        'capability-row-drifted',
        `the champion row "${baselineRel}" no longer hashes to the identity prepare recorded (sha256 ${baselineDigest} != ` +
          `${prepared.capabilityBaseline.digest}) — the row this candidate would restore cannot be re-proved, so nothing is promoted`,
      )
    }
    result.baseline = { entry: prepared.capabilityBaseline.entry, bytes }
  }
  if (prepared.mcpServers !== undefined) {
    const bytes = await readVerifiedFile(root, `${sandbox}/mcp-servers.json`)
    if (sha256Hex(bytes) !== prepared.mcpServers.digest) throw refusal('capability-server-drifted', 'frozen MCP definitions changed')
    result.mcpServers = mcpServerIdentity(JSON.parse(bytes.toString('utf8')))
    if (result.mcpServers.digest !== prepared.mcpServers.digest) throw refusal('capability-server-drifted', 'MCP definitions are not the prepared identity')
  }
  const content = prepared.skillContent
  if (content === undefined) return result
  const directory = `${sandbox}/skills/${content.name}`
  const skillMd = await readVerifiedFile(root, `${directory}/SKILL.md`)
  const skillMdDigest = sha256Hex(skillMd)
  if (skillMdDigest !== content.sha256) {
    throw refusal(
      'capability-skill-drifted',
      `the new skill's "${directory}/SKILL.md" no longer matches the identity prepare recorded (sha256 ${skillMdDigest} != ` +
        `${content.sha256}) — propose a new candidate and re-evaluate it`,
    )
  }
  if (content.contract === undefined) {
    throw refusal(
      'capability-skill-drifted',
      `the prepared identity of the new skill "${content.name}" records no declaration, and a capability candidate's skill is an execution ` +
        'provider with its SKILL.contract.json beside it — the object prepare froze is not one this build writes',
    )
  }
  const sidecarBytes = await readVerifiedFile(root, `${directory}/${SKILL_SIDECAR_FILE}`)
  const sidecarDigest = sha256Hex(sidecarBytes)
  if (sidecarDigest !== content.contract.sha256) {
    throw refusal(
      'capability-skill-drifted',
      `the new skill's "${directory}/${SKILL_SIDECAR_FILE}" no longer matches the identity prepare recorded (sha256 ${sidecarDigest} != ` +
        `${content.contract.sha256}) — propose a new candidate and re-evaluate it`,
    )
  }
  const sidecar = JSON.parse(sidecarBytes.toString('utf8')) as SkillSidecar
  const defects = skillContractDefects(sidecar)
  if (defects.length > 0) {
    throw refusal(
      'skill-sidecar-invalid',
      `the frozen declaration of the new skill "${content.name}" is not one this build reads — ` +
        `${defects.map(defect => `${defect.code}: ${defect.reason}`).join('; ')}`,
    )
  }
  return {
    ...result,
    skill: { name: content.name, content: skillMd.toString('utf8'), sidecar, skillMd, sidecarBytes },
    skillRoot: join(root, sandbox, 'skills'),
    skillDirectory: join(root, directory),
  }
}
