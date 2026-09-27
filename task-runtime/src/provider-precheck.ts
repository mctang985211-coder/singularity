/**
 * The admission-time provider pre-check (guide §2.3 item 1, S1-C item 1): for
 * every skill a matched capability declares, ask the question the spawn would
 * ask — where would the worker that is about to load this skill find it, and is
 * what stands there a usable provider? — before a child is minted or a worker
 * spawned.
 *
 * Why admission asks it at all: `grantSkills`
 * (`agent-runtime/src/grants.ts`) resolves a granted skill at spawn, so a
 * capability row naming a skill that is not on disk fails *after* the batch is
 * persisted, one child at a time. That is a configuration fault known before
 * the first write, and guide §2.3 puts it where it belongs: the runtime refuses
 * the whole batch, naming the capability, the skill and the roots it searched.
 *
 * The discovery here is not a second discovery. It is
 * `findSkillFileIn`/`skillRootsFor` from `agent-runtime/src/skill-file.ts` —
 * the primitives `grantSkills` falls back to — run over the same roots in the
 * same order, with one addition the spawn makes itself: the replay overlay's
 * skill roots come first, because `applyWorkerGrant` registers them before it
 * resolves granted names and a same-name overlay skill is what that worker
 * loads. What the pre-check deliberately does **not** model: the DSH skill
 * service's own discovery (`skills.get`), which a worker walks first when its
 * composition mounts it. A skill only that service can see is therefore refused
 * here — fail-closed, and named as such rather than passed through.
 *
 * What the verdict means, and what it does not: every discovered directory goes
 * through {@link validateSkillProvider} — the one validator config load,
 * provider replacement and candidate promotion share (S1-C item 3) — so an
 * execution sidecar with an unregistered verifier, a `requiredTools` list its
 * capabilities do not grant, tampered content or an unsupported shape is a
 * named refusal. Knowledge and guidance skills are loadable and are *not*
 * execution providers: this module neither closes a capability gap nor changes
 * the closure, which stays a property of the capability table alone.
 *
 * Verdicts are values, and the pre-check writes nothing: the caller refuses the
 * batch on {@link providerRefusals} before the first store write, so a refused
 * batch leaves no task, no run, no event and no obligation behind.
 *
 * One more source of refusal, added by K2: a production target an evolution
 * commit left open. The ledger is read softly (`commitLedger`, absent when the
 * deployment mounts no evolution plane), and a provider whose directory holds
 * such a target is refused by name until a reconciliation settles that commit —
 * production may not hold the version the ledger describes, and nothing may load
 * against it. The match is the directory, not the file (K3): one intent covers
 * the fixed file set of a skill directory together, so a target naming either
 * file — or any other path in it — refuses the whole directory rather than
 * admitting a mixed version. The read is
 * `EvolutionService.openIntentTargets`: pure, so an admission question never
 * settles a commit as a side effect. A ledger that cannot be read at all refuses
 * every skill candidate (fail-closed), because "no commit is open" is exactly
 * the claim such a ledger cannot be trusted to make.
 * @module @dangosys/dsh-singularity-task-runtime/provider-precheck
 */

import { dirname, join, resolve } from 'node:path'
import { findSkillFileIn, skillRootsFor } from '@dangosys/dsh-singularity-agent-runtime'
import type { CapabilityConfig } from './capability.ts'
import { loadSkillSidecar, registryRevision, skillValidationContext, validateSkillProvider } from './sidecar.ts'
import type {
  ExecutionProviderVerdict,
  KnowledgeProviderVerdict,
  RejectedProviderVerdict,
  SkillDefect,
  SkillProviderVerdict,
} from './sidecar.ts'

/**
 * The verifier service as a provider check uses it: an optional plugin this
 * package never imports, resolved softly from whichever context is asking.
 */
export interface VerifierVocabulary {
  /** Idempotent registration gate; awaited before the registry is read. */
  ready?(): Promise<void>
  /** The registered verifier ids, the vocabulary a sidecar's `verifier.ref` may name. */
  verifierIds?(): string[]
  /**
   * The declared version of each registered verifier, by id — the registry
   * metadata a verdict is stamped with. Optional: a registry that reports ids
   * only (an older implementation, a minimal test double) leaves every version
   * undeclared, which a reader reports as "none" rather than inventing one.
   */
  verifierVersions?(): Record<string, string>
}

/**
 * Resolve an optional sibling plugin's service by property or `ctx.get(name)`,
 * the soft pattern this repo uses for services a deployment may or may not
 * mount (`verifier`, `sessionQuery`, `agents`): absent in test contexts and in
 * smaller bundles, not an error.
 *
 * Both lookups are inside the `try` because cordis refuses a property read of a
 * service the asking context does not have (`cannot get property "verifier"
 * without inject`, `reflect.ts` — it throws instead of returning `undefined`).
 * An optional service that is absent is exactly the case this function exists
 * for, so the refusal is the answer: `undefined`.
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
 * service, a service that never became ready, or a registry whose own read
 * throws.
 *
 * `ready()` first, and only here: a verifier service that has been constructed
 * but not readied reports an empty `verifierIds()`, and reading that as "no
 * verifier is registered" would refuse every execution provider on a deployment
 * whose registry is merely still loading. The distinction between "the registry
 * could not answer" and "the registry answered: empty" is exactly what the
 * returned `undefined` preserves: a caller refuses an execution sidecar in the
 * first case (fail-closed, {@link unlistableVerifierRefusal}) and names the
 * registry's own answer in the second.
 *
 * One implementation for every consumer — the admission pre-check, the
 * load-time scan and the promotion checks all ask it (guide §2.4, S1-C item 3).
 */
export async function registeredVerifierIds(host: unknown): Promise<readonly string[] | undefined> {
  const verifier = optionalService<VerifierVocabulary>(host, 'verifier')
  if (verifier === undefined) return undefined
  try {
    await verifier.ready?.()
    return verifier.verifierIds?.()
  } catch {
    return undefined
  }
}

/**
 * The registered verifier vocabulary *and the version each instance declares*,
 * or `undefined` under exactly the conditions {@link registeredVerifierIds}
 * answers `undefined`. The two are read together by a caller that has to recall
 * a verdict against the instance that produced it (the evolution promotion
 * gate): an id list cannot tell a re-registered judge from the one that judged,
 * and a version list read without the ids could name a judge that is gone.
 *
 * Registration is awaited once, then both halves are read from the same
 * instance. A registry that implements `verifierIds()` but no
 * `verifierVersions()` answers an empty map — "no version was declared", which
 * is the truth for it, not a refusal.
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
 * than assumed registered (fail-closed). The admission pre-check and the
 * evolution promotion checks share this function, so one situation reads the
 * same way in every entry instead of each inventing its own explanation.
 */
export function unlistableVerifierRefusal(name: string, directory: string | undefined, ref: string): RejectedProviderVerdict {
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
 * the dependency runs one way, evolution → task-runtime — so this is a
 * structural read of whatever service a deployment mounts under `evolution`;
 * a deployment that mounts none has no commit in flight to gate on.
 */
export interface EvolutionCommitLedger {
  /**
   * The absolute production file paths of every open commit intent, in ledger
   * order (`EvolutionService.openIntentTargets`): for one K3 commit, the files
   * the skill's directory holds — `SKILL.md`, and the `SKILL.contract.json`
   * beside it when the skill has an execution sidecar. A pure read: it writes
   * nothing and never reconciles, so asking an admission question cannot settle
   * a commit as a side effect. The gate resolves each path to the directory that
   * holds it and matches providers by that directory, because one intent covers
   * the whole fixed file set together. Optional because this is a structural
   * read of a service this package does not own — a service that cannot answer
   * it is refused by name rather than read as "no commit is open"
   * (`commit-ledger-unreadable`, fail-closed).
   */
  openIntentTargets?(): Promise<readonly string[]>
}

/**
 * What one pre-check read from the evolution ledger: the directory each open
 * commit target lies in, or why that read could not be made.
 */
interface CommitGate {
  /** The absolute directory every open commit target resolved into; empty when the read failed. */
  readonly openTargets: ReadonlySet<string>
  /**
   * Why the ledger could not be read at all, or absent when it was. Every skill
   * candidate is then refused by name: a ledger nobody can read cannot be
   * trusted to say "no commit is open against this provider".
   */
  readonly unreadable?: string
}

/**
 * Read the ledger's open commit intents, once per pre-check. `undefined` means
 * this deployment offers no evolution service at all — no commit can be in
 * flight, so no gate is applied. A ledger that cannot be read answers a gate
 * that refuses by name instead.
 *
 * Every target is kept as the directory that holds it, never as the file path:
 * the gate matches providers by directory ({@link commitRefusalFor}), so a
 * ledger naming the sidecar of a two-file commit lands on the same entry as one
 * naming its `SKILL.md`.
 */
async function readCommitGate(ledger: EvolutionCommitLedger | undefined): Promise<CommitGate | undefined> {
  if (ledger === undefined) return undefined
  if (ledger.openIntentTargets === undefined) {
    return { openTargets: new Set(), unreadable: 'the evolution service offers no openIntentTargets() read' }
  }
  try {
    const targets = await ledger.openIntentTargets()
    return { openTargets: new Set(targets.map(target => dirname(resolve(target)))) }
  } catch (error) {
    return {
      openTargets: new Set(),
      unreadable: `reading it failed (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/**
 * The refusal of a provider whose directory a commit left open (K2-3, matched by
 * directory since K3): the intent is the record that a production write is
 * underway and its completion has not been recorded, so production may not be
 * what the ledger says it is. One intent covers a skill directory's fixed file
 * set together, so a target naming any one of those files refuses the directory
 * as a whole — the version standing beside it may be the other half of a mixed
 * pair, which is not admissible either. The provider stays refused until a
 * reconciliation settles that commit, and every other provider in the same
 * pre-check is judged exactly as before.
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
 * The refusal of every skill candidate on a deployment whose evolution ledger
 * cannot be read: whether a commit intent is open against this provider cannot
 * be established, so it is refused rather than assumed clear (fail-closed). The
 * absence of an evolution service is a different situation and is not refused —
 * a deployment with no ledger has no commit in flight.
 */
function unreadableCommitLedgerRefusal(name: string, directory: string, target: string, why: string): RejectedProviderVerdict {
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
 * discovery walks upward from — and `extraRoots` are the roots that precede the
 * standard ones (the replay overlay's, exactly as `applyWorkerGrant` orders
 * them).
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
 * in an error message is never a hand-written approximation of the search.
 */
export async function skillSearchRoots(view: SkillDiscoveryView = {}): Promise<string[]> {
  return [...(view.extraRoots ?? []), ...(await skillRootsFor(view.cwd))]
}

/** What one capability row's declared skills resolved to. */
export interface CapabilityProviderPrecheck {
  /** The capability row the skills were read from. */
  readonly capability: string
  /** One verdict per distinct skill the row declares, in declaration order. */
  readonly skills: readonly SkillProviderVerdict[]
}

/**
 * The result of one pre-check, shaped to be carried: per capability, the
 * verdict for every skill it declares; the roots that were searched; the
 * verifier vocabulary the execution sidecars were judged against; and the
 * registry revision the accepted providers produce.
 *
 * The verdicts carry their own facts (`role`, `directory`, `contentDigest`,
 * `contractDigest`, `verifierRef`, the declared ports), so a caller that has to
 * *record* what a run resolved against — the Run binding (S1-C item 4) — reads
 * them off this value instead of re-reading the skill directories.
 */
export interface ProviderPrecheck {
  /** Every capability row that was checked, in the order given. */
  readonly capabilities: readonly CapabilityProviderPrecheck[]
  /** The discovery roots the search covered, in order. */
  readonly roots: readonly string[]
  /**
   * The registered verifier ids the execution sidecars were checked against.
   * **Absent** means the registry could not be listed at all, which is not the
   * same as "no verifier is registered": an execution sidecar is refused in
   * that case rather than assumed valid (fail-closed).
   */
  readonly verifierRefs?: readonly string[]
  /**
   * {@link registryRevision} over the table the rows came from and the provider
   * identity of every **accepted** skill in play (a skill without a sidecar
   * contributes `null`; a refused one contributes nothing, because a refused
   * provider is never something a run resolved against).
   */
  readonly revision: string
}

/**
 * One accepted provider's content identity, as the pre-check resolved it: the
 * skill's name and the digest of the sidecar contract it declares.
 * `contractDigest: null` is a skill that declares no sidecar — a knowledge or
 * guidance skill whose *contract* this deployment cannot pin. What a caller
 * records against this value (the run binding, the review context) is exactly
 * what it says and no more.
 */
export interface ResolvedProviderIdentity {
  readonly name: string
  readonly contractDigest: string | null
}

/** What one pre-check needs beyond the view: the rows in play and their table. */
export interface ProviderPrecheckRequest {
  /**
   * The capability rows in play, in the order they should be reported — the
   * matched rows of the batch's manifests (ordinary decomposition, replay) or
   * every row of the table (`capability_list`). A name the table does not hold
   * contributes nothing: resolution already refused it as a gap, which is a
   * different question from this one.
   */
  readonly capabilities: readonly string[]
  /** The capability table the rows were resolved from; its identity is part of {@link ProviderPrecheck.revision}. */
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
   * none. Absence means no commit can be in flight; a service that is present
   * but cannot answer its read is refused by name (fail-closed,
   * {@link EvolutionCommitLedger}).
   */
  readonly commitLedger?: EvolutionCommitLedger
}

function defect(code: SkillDefect['code'], detail: string): SkillDefect {
  return { code, detail }
}

/**
 * The refusal one skill candidate gets from the commit gate, or `undefined` when
 * the gate has nothing to say about it: only a provider whose discovered
 * directory holds a file an open commit names is refused, and every other
 * candidate in the same pre-check is judged exactly as it would be without the
 * gate.
 *
 * The comparison is by directory, not by file (K3): one commit intent covers the
 * fixed file set of a skill directory together (`SKILL.md`, and the
 * `SKILL.contract.json` beside it when the skill has one), so a ledger naming
 * either file marks the same directory as owned by an unsettled commit. Matching
 * file paths would admit a directory whenever the ledger reported the one file
 * this check did not look at.
 */
function commitRefusalFor(gate: CommitGate | undefined, name: string, directory: string): RejectedProviderVerdict | undefined {
  if (gate === undefined) return undefined
  const skillFile = resolve(join(directory, 'SKILL.md'))
  if (gate.unreadable !== undefined) return unreadableCommitLedgerRefusal(name, directory, skillFile, gate.unreadable)
  if (!gate.openTargets.has(resolve(directory))) return undefined
  return openCommitRefusal(name, directory)
}

/** The search-failure refusal: the skill name and the roots, which no phase-1 validator can know. */
function undiscovered(name: string, roots: readonly string[]): RejectedProviderVerdict {
  return {
    valid: false,
    name,
    defects: [
      defect('skill-missing', `no SKILL.md for skill "${name}" is reachable from the worker's discovery roots; searched ${roots.join(', ')}`),
    ],
  }
}

/**
 * The one provider identity a revision can cite: a validated sidecar, or
 * `null` for a skill that declares none. Guidance skills declare no execution
 * contract, so they are cited as the name alone rather than given a digest
 * that does not exist.
 */
function providerIdentity(verdict: SkillProviderVerdict): ResolvedProviderIdentity | undefined {
  if (!verdict.valid) return undefined
  return verdict.role === 'guidance' ? { name: verdict.name, contractDigest: null } : { name: verdict.name, contractDigest: verdict.contractDigest }
}

/**
 * Every provider content identity one pre-check resolved, deduplicated by name
 * and sorted by it: the list a caller folds into whatever it records about the
 * resolution (the registry revision here, the review context in
 * `./proposal.ts`). One function so those two cannot disagree about what
 * "resolved" means: refused verdicts contribute nothing (a refused provider is
 * never something a run resolved against), and a name that appears in two rows
 * is one identity.
 */
export function providerContentIdentities(capabilities: readonly CapabilityProviderPrecheck[]): ResolvedProviderIdentity[] {
  return capabilities
    .flatMap(row => row.skills)
    .flatMap(verdict => providerIdentity(verdict) ?? [])
    .filter((identity, index, all) => all.findIndex(entry => entry.name === identity.name) === index)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Check every skill every listed capability declares, from one discovery
 * viewpoint.
 *
 * The rules, in the order they are applied per skill: it must be discoverable
 * from the view's roots; no file of the directory it resolves into may be a
 * target an evolution commit left open (K2, matched by directory since K3); the
 * directory must pass {@link validateSkillProvider} against the table and the
 * verifier vocabulary. An execution sidecar is refused when the vocabulary is
 * unknown (`verifierRefs` absent) — the one case the phase-1 validator cannot
 * judge, because it would read an empty list as "nothing is registered".
 *
 * Nothing is written and nothing is thrown: every refusal is a verdict, and
 * {@link providerRefusals} turns the refusals into the lines a caller reports
 * before it refuses the whole batch. The commit gate is read once per call and
 * only refusals — nothing here reconciles, so asking an admission question
 * never settles a commit as a side effect.
 */
export async function precheckProviders(request: ProviderPrecheckRequest): Promise<ProviderPrecheck> {
  const roots = await skillSearchRoots(request.view)
  const verifierRefs = request.verifierRefs
  const context = skillValidationContext(request.table, verifierRefs ?? [])
  const commitGate = await readCommitGate(request.commitLedger)
  const capabilities: CapabilityProviderPrecheck[] = []
  for (const capability of request.capabilities) {
    const declared = request.table[capability]?.skills ?? []
    const skills: SkillProviderVerdict[] = []
    for (const name of [...new Set(declared)]) {
      const file = await findSkillFileIn(roots, name)
      if (file === undefined) {
        skills.push(undiscovered(name, roots))
        continue
      }
      const directory = dirname(file)
      // K2-3: a commit that left its intent behind owns this directory — the
      // whole fixed file set of the skill — until a reconciliation settles it.
      // The gate answers before the validator runs, and it answers for this
      // provider only.
      const commitRefusal = commitRefusalFor(commitGate, name, directory)
      if (commitRefusal !== undefined) {
        skills.push(commitRefusal)
        continue
      }
      if (verifierRefs === undefined) {
        // The registry cannot be listed, so `ref` cannot be proved registered.
        // Only an execution sidecar loses anything by that: a knowledge or
        // guidance skill claims no verifier, and is judged by the same
        // validator as everywhere else.
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
    revision: registryRevision(request.table, providers),
  }
}

/**
 * One capability row as it would read after a replacement, checked by the same
 * pre-check a batch is admitted under: `entry` is folded into `table` — the row
 * as `config.yml` will hold it once written — and every skill the new row grants
 * is discovered from `view` and judged by {@link validateSkillProvider}, with
 * the row's own tool labels expanding through `resolveCapabilities` as the
 * covering set for a skill that declares this row.
 *
 * The two entries that write a row share this function, so the run-time registry
 * mirror (`TaskRuntime.applyCapabilityRow`) asks exactly the question the
 * promotion gate (`EvolutionService.checkPromotion`) asked before the row
 * reached `config.yml`: one composition, one vocabulary of refusals, no entry
 * that can be replaced without being judged. `refusals` is empty for a row that
 * grants no skill or only loadable providers.
 */
export async function precheckReplacedCapabilityRow(request: {
  /** The capability row being written. */
  readonly name: string
  /** The row's entry as it will read after the replacement. */
  readonly entry: CapabilityConfig
  /** The table the row is folded into — the replacement table, then. */
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
    view: request.view,
    ...(request.verifierRefs === undefined ? {} : { verifierRefs: request.verifierRefs }),
    ...(request.commitLedger === undefined ? {} : { commitLedger: request.commitLedger }),
  })
  return { precheck, refusals: providerRefusals(precheck) }
}

/**
 * The head every refusal line shares: the capability that declares the skill,
 * the skill itself, and the directory discovery found (when it found one).
 * One function, so the two renderings below can never describe the same refusal
 * differently.
 */
function refusalHead(capability: string, verdict: RejectedProviderVerdict): string {
  const where = verdict.directory === undefined ? '' : ` (found at ${verdict.directory})`
  return `capability ${JSON.stringify(capability)} skill ${JSON.stringify(verdict.name)}${where}`
}

/**
 * Every refused provider of one pre-check, one line each, naming the capability
 * that declares it, the skill, the directory when one was found, and every
 * defect with its code. Empty means the batch may proceed — which is a
 * statement about *loadable* providers only: this pre-check never adds a
 * capability to the closure, and knowledge/guidance verdicts are loadable
 * without being execution providers.
 */
export function providerRefusals(precheck: ProviderPrecheck): string[] {
  return precheck.capabilities.flatMap(row =>
    row.skills
      .filter((verdict): verdict is RejectedProviderVerdict => !verdict.valid)
      .map(verdict => `${refusalHead(row.capability, verdict)}: ${verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')}`),
  )
}

/**
 * The same refusals, one line per defect: the shape a loud report wants, since
 * a caller reading a log needs the capability, the skill, the defect code and
 * the detail of each problem rather than a summary line per provider. The
 * load-time scan (`TaskRuntime.providerLoadReport`) prints these; admission
 * refuses a batch on {@link providerRefusals}.
 */
export function providerDefectLines(precheck: ProviderPrecheck): string[] {
  return precheck.capabilities.flatMap(row =>
    row.skills
      .filter((verdict): verdict is RejectedProviderVerdict => !verdict.valid)
      .flatMap(verdict => verdict.defects.map(item => `${refusalHead(row.capability, verdict)}: ${item.code}: ${item.detail}`)),
  )
}
