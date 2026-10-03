/**
 * The admission-time provider pre-check (guide §2.3 item 1, S1-C item 1): for
 * every skill a matched capability declares, ask the question the spawn would
 */

import type { McpServerTemplate } from './mcp-servers.ts'
import { dirname, join, resolve } from 'node:path'
import { message } from './helpers.ts'
import { findSkillFileIn, skillRootsFor } from '@dangosys/dsh-singularity-agent-runtime'
import type { CapabilityConfig } from './capability.ts'
import { loadSkillSidecar, registryRevision, skillValidationContext, validateSkillProvider } from './sidecar.ts'
import type { RejectedProviderVerdict, SkillDefect, SkillProviderVerdict } from './sidecar.ts'

/**
 * The verifier service as a provider check uses it: an optional plugin this
 * package never imports, resolved softly from whichever context is asking.
 */
interface VerifierVocabulary {
  /** Idempotent registration gate; awaited before the registry is read. */
  ready?(): Promise<void>
  /** The registered verifier ids, the vocabulary a sidecar's `verifier.ref` may name. */
  verifierIds?(): string[]
  /**
   * The declared version of each registered verifier, by id — the registry
   * metadata a verdict is stamped with. Optional: a registry that reports ids
   */
  verifierVersions?(): Record<string, string>
}

/**
 * Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
 * the soft pattern this repo uses for services a deployment may or may not
 */
export function optionalService<T>(host: unknown, name: string): T | undefined {
  if (host === null || typeof host !== 'object') return undefined
  const holder = host as { get?: (name: string) => unknown } & Record<string, unknown>
  try {
    const viaContext = typeof holder.get === 'function' ? holder.get(name) : undefined
    if (viaContext !== undefined) return viaContext as T
    return holder[name] as T | undefined
  } catch {
    return undefined
  }
}

/**
 * The registered verifier vocabulary a provider check judges execution sidecars
 * against, or `undefined` when the deployment cannot list it — no verifier
 */
export async function registeredVerifierIds(host: unknown): Promise<readonly string[] | undefined> {
  return (await registeredVerifierVocabulary(host))?.ids
}

/**
 * The registered verifier vocabulary *and the version each instance declares*,
 * or `undefined` under exactly the conditions {@link registeredVerifierIds}
 */
export async function registeredVerifierVocabulary(
  host: unknown,
): Promise<{ ids: readonly string[]; versions: Readonly<Record<string, string>> } | undefined> {
  const verifier = optionalService<VerifierVocabulary>(host, 'verifier')
  if (verifier === undefined) return undefined
  try {
    await verifier.ready?.()
    const ids = verifier.verifierIds?.()
    if (ids === undefined) return undefined
    return { ids, versions: verifier.verifierVersions?.() ?? {} }
  } catch {
    return undefined
  }
}

/**
 * The refusal of an execution sidecar the deployment cannot judge because its
 * verifier vocabulary could not be listed: the declared ref is refused rather
 */
export function unlistableVerifierRefusal(
  name: string,
  directory: string | undefined,
  ref: string,
): RejectedProviderVerdict {
  return {
    valid: false,
    name,
    ...(directory === undefined ? {} : { directory }),
    defects: [
      defect(
        'verifier-unknown',
        `skill "${name}" declares execution verifier ${JSON.stringify(ref)} but the verifier registry cannot be ` +
          'listed (verifierIds() is unavailable, so the registry was never readied); the ref is refused rather than assumed registered',
      ),
    ],
  }
}

/**
 * The evolution commit ledger as a provider check reads it (K2): the production
 * targets a commit left open. Task-runtime never imports the evolution package —
 */
export interface EvolutionCommitLedger {
  /**
   * The absolute production file paths of every open commit intent, in ledger
   * order (`EvolutionService.openIntentTargets`): for one K3 commit, the files
   */
  openIntentTargets?(): Promise<readonly string[]>
  /**
   * The capability rows every open commit intent moves, in ledger order
   * (`EvolutionService.openIntentCapabilities`) — the half of a capability
   */
  openIntentCapabilities?(): Promise<readonly string[]>
}

/**
 * What one pre-check read from the evolution ledger: the directory each open
 * commit target lies in, the rows the open intents move, or why that read could
 */
interface CommitGate {
  /** The absolute directory every open commit target resolved into; empty when the read failed. */
  readonly openTargets: ReadonlySet<string>
  /** Every capability row an open commit intent moves, exactly as the ledger spells it. */
  readonly openCapabilities: ReadonlySet<string>
  /**
   * Why the ledger could not be read at all, or absent when it was. Every skill
   * candidate is then refused by name: a ledger nobody can read cannot be
   */
  readonly unreadable?: string
}

/**
 * Read the ledger's open commit intents, once per pre-check. `undefined` means
 * this deployment offers no evolution service at all — no commit can be in
 */
async function readCommitGate(ledger: EvolutionCommitLedger | undefined): Promise<CommitGate | undefined> {
  if (ledger === undefined) return undefined
  if (ledger.openIntentTargets === undefined) {
    return {
      openTargets: new Set(),
      openCapabilities: new Set(),
      unreadable: 'the evolution service offers no openIntentTargets() read',
    }
  }
  if (ledger.openIntentCapabilities === undefined) {
    return {
      openTargets: new Set(),
      openCapabilities: new Set(),
      unreadable: 'the evolution service offers no openIntentCapabilities() read',
    }
  }
  try {
    const [targets, capabilities] = await Promise.all([ledger.openIntentTargets(), ledger.openIntentCapabilities()])
    return {
      openTargets: new Set(targets.map(target => dirname(resolve(target)))),
      openCapabilities: new Set(capabilities),
    }
  } catch (error) {
    return {
      openTargets: new Set(),
      openCapabilities: new Set(),
      unreadable: `reading it failed (${message(error)})`,
    }
  }
}

/**
 * The refusal of a provider whose directory a commit left open (K2-3, matched by
 * directory since K3): the intent is the record that a production write is
 */
function openCommitRefusal(name: string, directory: string): RejectedProviderVerdict {
  return {
    valid: false,
    name,
    directory,
    defects: [
      defect(
        'commit-intent-open',
        `skill "${name}" is the target of an open evolution commit intent: a file of ${directory} was named by an apply or rollback, ` +
          'its intent was persisted and its completion was never recorded, so production may not hold the version the ledger describes. ' +
          'One intent covers the fixed file set of that directory together (`SKILL.md`, plus the `SKILL.contract.json` beside it when ' +
          'the skill has one), so a directory holding any file under an open intent is refused whole rather than admitted as a mixed ' +
          'version: the provider stays refused until a reconciliation settles that commit (the deployment reconciles at startup, or an ' +
          'apply/rollback retry settles it)',
      ),
    ],
  }
}

/**
 * The refusal of one capability **row** an open evolution commit intent moves
 * (A6): row-keyed, not directory-keyed, because a row-only capability commit has
 */
function openCapabilityRowRefusal(name: string): SkillDefect {
  return defect(
    'commit-intent-open',
    `capability "${name}" is the target of an open evolution commit intent: an apply or rollback persisted that intent and never recorded ` +
      'its completion. A capability commit persists the deployment configuration before updating the runtime registry, and its completion ' +
      'confirms both steps. The row stays refused until reconciliation settles the commit (the deployment ' +
      'reconciles at startup, or an apply/rollback retry settles it)',
  )
}

/**
 * The refusal of every skill candidate on a deployment whose evolution ledger
 * cannot be read: whether a commit intent is open against this provider cannot
 */
function unreadableCommitLedgerRefusal(
  name: string,
  directory: string,
  target: string,
  why: string,
): RejectedProviderVerdict {
  return {
    valid: false,
    name,
    directory,
    defects: [
      defect(
        'commit-ledger-unreadable',
        `skill "${name}" cannot be admitted against ${target}: the deployment's evolution commit ledger is unreadable (${why}), so ` +
          'whether a commit intent is open against this provider cannot be established — the provider is refused rather than assumed ' +
          'clear (fail-closed)',
      ),
    ],
  }
}

/**
 * Where a pre-check looks for a skill: the viewpoint of the worker that would
 * load it. `cwd` is the session's checkout — the directory the worker's own
 */
export interface SkillDiscoveryView {
  /** The worker's working directory (the session's checkout); absent when the deployment cannot name one. */
  readonly cwd?: string
  /** Roots searched before the standard ones: the replay overlay's skill roots, in the order the grant registers them. */
  readonly extraRoots?: readonly string[]
}

/**
 * Every root one discovery view covers, in search order — the single root list
 * the pre-check searches and the one a refusal names, so "searched the roots"
 */
export async function skillSearchRoots(view: SkillDiscoveryView = {}): Promise<string[]> {
  return [...(view.extraRoots ?? []), ...(await skillRootsFor(view.cwd))]
}

/** What one capability row's declared skills resolved to. */
export interface CapabilityProviderPrecheck {
  /** The capability row the skills were read from. */
  readonly capability: string
  /** One verdict per distinct skill the row declares, in declaration order; empty for a row that was refused before it was resolved. */
  readonly skills: readonly SkillProviderVerdict[]
  /**
   * The named reasons this **row** — not a skill of it — may not be admitted,
   * empty or absent when it may. Row-keyed refusals exist because a capability
   */
  readonly refusals?: readonly SkillDefect[]
}

/**
 * The result of one pre-check, shaped to be carried: per capability, the
 * verdict for every skill it declares; the roots that were searched; the
 */
export interface ProviderPrecheck {
  /** Every capability row that was checked, in the order given. */
  readonly capabilities: readonly CapabilityProviderPrecheck[]
  /** The discovery roots the search covered, in order. */
  readonly roots: readonly string[]
  /**
   * The registered verifier ids the execution sidecars were checked against.
   * **Absent** means the registry could not be listed at all, which is not the
   */
  readonly verifierRefs?: readonly string[]
  /**
   * {@link registryRevision} over the table the rows came from and the provider
   * identity of every **accepted** skill in play (a skill without a sidecar
   */
  readonly revision: string
}

/**
 * One accepted provider's content identity, as the pre-check resolved it: the
 * skill's name and the digest of the sidecar contract it declares.
 */
export interface ResolvedProviderIdentity {
  readonly name: string
  readonly contractDigest: string | null
}

/** What one pre-check needs beyond the view: the rows in play and their table. */
interface ProviderPrecheckRequest {
  /**
   * The capability rows in play, in the order they should be reported — the
   * matched rows of the batch's manifests (ordinary decomposition, replay) or
   */
  readonly capabilities: readonly string[]
  /** The capability table the rows were resolved from; its identity is part of {@link ProviderPrecheck.revision}. */
  readonly mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
  readonly table: Readonly<Record<string, CapabilityConfig>>
  /** Where discovery looks. */
  readonly view: SkillDiscoveryView
  /**
   * The registered verifier ids (`VerifierRegistry.verifierIds()`, after
   * `ready()`), or absent when the registry cannot be listed.
   */
  readonly verifierRefs?: readonly string[]
  /**
   * The deployment's evolution ledger, resolved softly by the caller
   * (`optionalService(ctx, 'evolution')`) or absent when the deployment mounts
   */
  readonly commitLedger?: EvolutionCommitLedger
}

function defect(code: SkillDefect['code'], detail: string): SkillDefect {
  return { code, detail }
}

/**
 * The refusal one skill candidate gets from the commit gate, or `undefined` when
 * the gate has nothing to say about it: only a provider whose discovered
 */
function commitRefusalFor(
  gate: CommitGate | undefined,
  name: string,
  directory: string,
): RejectedProviderVerdict | undefined {
  if (gate === undefined) return undefined
  const skillFile = resolve(join(directory, 'SKILL.md'))
  if (gate.unreadable !== undefined) return unreadableCommitLedgerRefusal(name, directory, skillFile, gate.unreadable)
  if (!gate.openTargets.has(resolve(directory))) return undefined
  return openCommitRefusal(name, directory)
}

/**
 * The row-keyed half of that same gate (A6): the defects one capability row owes
 * because an open commit intent moves it, or `[]` when none does. It is asked
 */
function capabilityRowRefusals(gate: CommitGate | undefined, capability: string): SkillDefect[] {
  if (gate === undefined) return []
  if (!gate.openCapabilities.has(capability)) return []
  return [openCapabilityRowRefusal(capability)]
}

/** The search-failure refusal: the skill name and the roots, which no phase-1 validator can know. */
function undiscovered(name: string, roots: readonly string[]): RejectedProviderVerdict {
  return {
    valid: false,
    name,
    defects: [
      defect(
        'skill-missing',
        `no SKILL.md for skill "${name}" is reachable from the worker's discovery roots; searched ${roots.join(', ')}`,
      ),
    ],
  }
}

/**
 * The one provider identity a revision can cite: a validated sidecar, or
 * `null` for a skill that declares none. Guidance skills declare no execution
 */
function providerIdentity(verdict: SkillProviderVerdict): ResolvedProviderIdentity | undefined {
  if (!verdict.valid) return undefined
  return verdict.role === 'guidance'
    ? { name: verdict.name, contractDigest: null }
    : { name: verdict.name, contractDigest: verdict.contractDigest }
}

/**
 * Every provider content identity one pre-check resolved, deduplicated by name
 * and sorted by it: the list a caller folds into whatever it records about the
 */
export function providerContentIdentities(
  capabilities: readonly CapabilityProviderPrecheck[],
): ResolvedProviderIdentity[] {
  return capabilities
    .flatMap(row => row.skills)
    .flatMap(verdict => providerIdentity(verdict) ?? [])
    .filter((identity, index, all) => all.findIndex(entry => entry.name === identity.name) === index)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Check every skill every listed capability declares, from one discovery
 * viewpoint.
 */
export async function precheckProviders(request: ProviderPrecheckRequest): Promise<ProviderPrecheck> {
  const roots = await skillSearchRoots(request.view)
  const verifierRefs = request.verifierRefs
  const context = skillValidationContext(request.table, verifierRefs ?? [], request.mcpRegistry)
  const commitGate = await readCommitGate(request.commitLedger)
  const capabilities: CapabilityProviderPrecheck[] = []
  for (const capability of request.capabilities) {
    /**
     * A6, and first: a row an open commit intent moves is refused whole. It is
     * not resolved — no skill verdict is taken, no revision absorbs it — because
     */
    const rowRefusals = capabilityRowRefusals(commitGate, capability)
    if (rowRefusals.length > 0) {
      capabilities.push({ capability, skills: [], refusals: rowRefusals })
      continue
    }
    const resolved = context.capabilityTools(capability)
    if (!resolved.known) {
      capabilities.push({ capability, skills: [], refusals: [{ code: 'capability-unknown', detail: resolved.reason }] })
      continue
    }
    const declared = request.table[capability]?.skills ?? []
    const skills: SkillProviderVerdict[] = []
    for (const name of [...new Set(declared)]) {
      const file = await findSkillFileIn(roots, name)
      if (file === undefined) {
        skills.push(undiscovered(name, roots))
        continue
      }
      const directory = dirname(file)
      /**
       * K2-3: a commit that left its intent behind owns this directory — the
       * whole fixed file set of the skill — until a reconciliation settles it.
       */
      const commitRefusal = commitRefusalFor(commitGate, name, directory)
      if (commitRefusal !== undefined) {
        skills.push(commitRefusal)
        continue
      }
      if (verifierRefs === undefined) {
        /**
         * The registry cannot be listed, so `ref` cannot be proved registered.
         * Only an execution sidecar loses anything by that: a knowledge or
         */
        const loaded = await loadSkillSidecar(directory)
        if (loaded.sidecar?.type === 'execution') {
          skills.push(unlistableVerifierRefusal(name, directory, loaded.sidecar.verifier.ref))
          continue
        }
      }
      skills.push(await validateSkillProvider({ name, directory }, context))
    }
    capabilities.push({ capability, skills })
  }
  const providers = providerContentIdentities(capabilities)
  return {
    capabilities,
    roots,
    ...(verifierRefs === undefined ? {} : { verifierRefs: [...verifierRefs] }),
    revision: registryRevision(request.table, providers, request.mcpRegistry),
  }
}

/**
 * One capability row as it would read after a replacement, checked by the same
 * pre-check a batch is admitted under: `entry` is folded into `table` — the row
 */
export async function precheckReplacedCapabilityRow(request: {
  /** The capability row being written. */
  readonly name: string
  /** The row's entry as it will read after the replacement. */
  readonly entry: CapabilityConfig
  /** The table the row is folded into — the replacement table, then. */
  readonly mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
  readonly table: Readonly<Record<string, CapabilityConfig>>
  /** Where discovery looks; a deployment's own process viewpoint or a worker's checkout. */
  readonly view: SkillDiscoveryView
  /** The registered verifier ids (`VerifierRegistry.verifierIds()`), or absent when the registry cannot be listed. */
  readonly verifierRefs?: readonly string[]
  /** The deployment's evolution ledger (`optionalService(ctx, 'evolution')`), or absent when the deployment mounts none. */
  readonly commitLedger?: EvolutionCommitLedger
}): Promise<{ readonly precheck: ProviderPrecheck; readonly refusals: readonly string[] }> {
  const precheck = await precheckProviders({
    capabilities: [request.name],
    table: { ...request.table, [request.name]: request.entry },
    ...(request.mcpRegistry === undefined ? {} : { mcpRegistry: request.mcpRegistry }),
    view: request.view,
    ...(request.verifierRefs === undefined ? {} : { verifierRefs: request.verifierRefs }),
    ...(request.commitLedger === undefined ? {} : { commitLedger: request.commitLedger }),
  })
  return { precheck, refusals: providerRefusals(precheck) }
}

/**
 * The head every refusal line shares: the capability that declares the skill,
 * the skill itself, and the directory discovery found (when it found one).
 */
function refusalHead(capability: string, verdict: RejectedProviderVerdict): string {
  const where = verdict.directory === undefined ? '' : ` (found at ${verdict.directory})`
  return `capability ${JSON.stringify(capability)} skill ${JSON.stringify(verdict.name)}${where}`
}

/** One rendered refusal: its line prefix and the defects that follow it. */
interface PrecheckRefusal {
  /** The line prefix: the capability for a row-level refusal, the verdict head for a skill. */
  head: string
  defects: readonly { code: string; detail: string }[]
}

/** Every refusal of one pre-check: row-level refusals first, then one entry per refused provider. */
function precheckRefusals(precheck: ProviderPrecheck): PrecheckRefusal[] {
  return precheck.capabilities.flatMap(row => [
    ...(row.refusals ?? []).map(item => ({ head: `capability ${JSON.stringify(row.capability)}`, defects: [item] })),
    ...row.skills
      .filter((verdict): verdict is RejectedProviderVerdict => !verdict.valid)
      .map(verdict => ({ head: refusalHead(row.capability, verdict), defects: verdict.defects })),
  ])
}

/**
 * Every refused provider of one pre-check, one line each, naming the capability
 * that declares it, the skill, the directory when one was found, and every
 */
export function providerRefusals(precheck: ProviderPrecheck, taskCapabilities?: readonly string[]): string[] {
  const selected = taskCapabilities === undefined
    ? precheck
    : { ...precheck, capabilities: precheck.capabilities.filter(row => taskCapabilities.includes(row.capability)) }
  const refusals = precheckRefusals(selected).map(
    entry => `${entry.head}: ${entry.defects.map(item => `${item.code}: ${item.detail}`).join('; ')}`,
  )
  if (taskCapabilities !== undefined && !selected.capabilities.some(row => row.skills.some(skill => skill.valid))) {
    refusals.push(
      `task capabilities [${taskCapabilities.join(', ')}] provide no readable guidance Skill; select at least one relevant Skill through requiredCapabilities before executing this task`,
    )
  }
  return refusals
}

/**
 * The same refusals, one line per defect: the shape a loud report wants, since
 * a caller reading a log needs the capability, the skill, the defect code and
 */
export function providerDefectLines(precheck: ProviderPrecheck): string[] {
  return precheckRefusals(precheck).flatMap(entry =>
    entry.defects.map(item => `${entry.head}: ${item.code}: ${item.detail}`),
  )
}
