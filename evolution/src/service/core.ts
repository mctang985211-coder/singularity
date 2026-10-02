/** The EvolutionService core: ledger plumbing, open-intent handling and the durable commit host.
 * @module dsh-singularity-evolution/service/core */

import { mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId, sha256Hex } from '@dangosys/dsh-singularity-task'
import {
  capabilityToolQuery,
  loadSkillSidecar,
  optionalService,
  readVerifiedFile,
  registeredVerifierIds,
  SKILL_SIDECAR_FILE,
  unlistableVerifierRefusal,
  validateSkillProvider,
} from '@dangosys/dsh-singularity-task-runtime'
import type {
  CapabilityToolQuery,
  RootRecoveryCaller,
  RootRecoveryOutcome,
  RootRecoveryRequest,
  SkillProviderCandidate,
  SkillProviderVerdict,
} from '@dangosys/dsh-singularity-task-runtime'
import { inFlightRecoveryAttempt, recoveryAttemptWithKey } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { capabilityRowDigest, validateCapabilityMutation } from '../capability-candidate.ts'
import { canonicalJson, modelSelectionOf } from '../replay.ts'
import type { ModelSelection } from '../replay.ts'
import type { CommitFile, CommitHost, CommitRequest, CommitStage, ReconcileOutcome } from '../commit.ts'
import { committedRow, reconcileIntent, syncDirectory } from '../commit.ts'
import { capabilityTableDrift, writeCapabilityRowToConfig } from '../capability-config.ts'

import type { ExperimentView } from '../experiment/freeze.ts'
import type { ExperimentSampleRecord, ExperimentStartedRecord } from '../experiment/spec.ts'
import { assertExperimentStartRecord, foldExperiments } from '../experiment/record.ts'
import { fold } from '../ledger/fold.ts'
import { objectWriteRefusal } from './writes.ts'
import { effectiveCapabilitiesOf } from './sources.ts'
import type {
  RecoveryCoordinationCaller,
  RecoveryCoordinationOutcome,
  RecoveryCoordinationRequest,
  SupervisorDelegation,
} from '../ledger/records.ts'
import {
  assertLedgerFormatVersion,
  capabilityTableStates,
  recoveryCoordinationDefects,
  recoverySourceRunId,
} from '../ledger/records.ts'
import { assertTransition } from '../ledger/state-machine.ts'
import { productionSidecarRelative, productionSkillRelative, readProductionSkill } from './skill-files.ts'
import { ledgerDirectories, ProductionReadError, resolveWithin } from '../shared.ts'
import type {
  CapabilityRowWriter,
  CommitCapability,
  CommitDirection,
  CommitIntentView,
  Config,
  EvolutionProposal,
  EvolutionRecord,
  EvolutionStatus,
  ListFilter,
  SkillMutation,
} from '../types.ts'

export class EvolutionServiceCore extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string
  /** Production skill root — champion snapshots read from here; apply/rollback write here. */
  readonly skillRoot: string
  /** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
  readonly repoRoot: string
  /** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
  protected readonly resolveModelSelection?: () => ModelSelection | undefined
  /** The commit path's typed test seam, if this instance was built with one (see {@link Config.commitProbe}). */
  protected readonly commitProbe?: (stage: CommitStage, target?: string) => void
  /** The injected supervisor-delegation source, if the assembly wired one (see {@link Config.supervisorDelegation}). */
  protected readonly resolveSupervisorDelegation?: (
    sessionId: string,
    diagnosisId: string,
  ) => Promise<SupervisorDelegation | undefined>
  /** The deployment's capability table file, when it named one (see {@link Config.capabilityConfig}). */
  protected readonly capabilityConfigPath?: string
  /** The capability-config write's typed test seam, when this instance was built with one (see {@link Config.capabilityConfigProbe}). */
  protected readonly capabilityConfigProbe?: (stage: 'before-write' | 'staged' | 'written', row: string) => void
  protected records: EvolutionRecord[] = []
  protected readonly loaded: Promise<void>
  protected writes: Promise<void> = Promise.resolve()
  protected commits: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolution')
    // Explicitly configured, never derived here: see Config.repoRoot.
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.resolveModelSelection = config.modelSelection
    this.commitProbe = config.commitProbe
    this.resolveSupervisorDelegation = config.supervisorDelegation
    this.capabilityConfigPath = config.capabilityConfig === undefined ? undefined : resolve(config.capabilityConfig)
    this.capabilityConfigProbe = config.capabilityConfigProbe
    const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, '.dsh')
    this.root = resolve(config.root ?? join(dshHome, 'evolution'))
    this.skillRoot = resolve(config.skillRoot ?? join(dshHome, 'skills'))
    this.loaded = this.load()
    ctx.effect(
      () => async () => {
        // Commits first: each one's appends are already queued behind them, so
        // draining the write chain afterwards is what makes the ledger complete.
        await this.commits
        await this.writes
      },
      'evolution: drain writes',
    )
  }

  /** Ledger file path (`<root>/proposals.jsonl`). */
  get file(): string {
    return join(this.root, 'proposals.jsonl')
  }

  /** The model selection this deployment's runs share — the one the experiment freezes and a promotion re-reads. */
  modelSelection(): ModelSelection {
    let resolved: ModelSelection | undefined
    try {
      resolved = modelSelectionOf(this.resolveModelSelection?.())
    } catch (error) {
      throw new Error(
        `evolution: the model selection cannot be resolved (${error instanceof Error ? error.message : String(error)}) — ` +
          'the experiment freezes the selection its runs share and a promotion re-reads it, so a deployment that cannot name one ' +
          'neither evaluates nor promotes a candidate',
      )
    }
    if (resolved === undefined) {
      throw new Error(
        'evolution: this deployment cannot name the model selection its runs share — no model-selection resolver was injected (or it ' +
          'answered without a structured { provider, model } route); the two-sided experiment freezes the selection before anything ' +
          "runs and the promotion gate re-reads it from the runs' own session logs, so a deployment that cannot name it can neither " +
          'evaluate nor promote a candidate',
      )
    }
    return resolved
  }

  /** One provider candidate judged by the unified validator, with the sources this deployment can see. */
  protected async providerVerdict(
    candidate: SkillProviderCandidate,
    table: Readonly<Record<string, CapabilityConfig>> | undefined = this.effectiveCapabilities(),
  ): Promise<SkillProviderVerdict> {
    const verifierRefs = await registeredVerifierIds(this.ctx)
    if (verifierRefs === undefined && candidate.directory !== undefined) {
      const loaded = await loadSkillSidecar(candidate.directory)
      if (loaded.sidecar?.type === 'execution') {
        return unlistableVerifierRefusal(candidate.name, candidate.directory, loaded.sidecar.verifier.ref)
      }
    }
    return validateSkillProvider(candidate, {
      verifierRefs: verifierRefs === undefined ? [] : [...verifierRefs],
      capabilityTools: this.capabilityToolAnswer(table),
    })
  }

  /** The capability table this service judges providers against: by default the effective table, never a cached copy. */
  protected capabilityToolAnswer(
    table: Readonly<Record<string, CapabilityConfig>> | undefined = this.effectiveCapabilities(),
  ): CapabilityToolQuery {
    if (table !== undefined) return capabilityToolQuery(table)
    return () => ({
      known: false,
      reason:
        'the effective capability registry cannot be read in this context (no task-runtime service), so the tools this ' +
        'capability grants cannot be resolved',
    })
  }

  /** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
  protected effectiveCapabilities(): Readonly<Record<string, CapabilityConfig>> | undefined {
    return effectiveCapabilitiesOf(this.ctx)
  }

  /** Settle every open commit intent, in ledger order (K2) — the explicit startup entry. */
  async reconcile(): Promise<ReconcileOutcome[]> {
    await this.loaded
    const outcomes: ReconcileOutcome[] = []
    for (const intent of this.openIntents(fold(this.records))) {
      const outcome = await this.commitExclusive(async () => {
        const open = fold(this.records).get(intent.proposalId)?.openIntent
        if (open === undefined || open.intentId !== intent.intentId) return undefined
        return reconcileIntent(this.commitHost(), open)
      })
      if (outcome !== undefined) outcomes.push(outcome)
    }
    return outcomes
  }

  /** The production targets a commit has left open (K2), in ledger order — the admission gate's per-directory blocker. */
  async openIntentTargets(): Promise<readonly string[]> {
    await this.loaded
    return this.openIntents(fold(this.records)).flatMap(intent => intent.files.map(file => file.target))
  }

  /** The capability rows a commit has left open (A6), in ledger order — the row-keyed blocker. */
  async openIntentCapabilities(): Promise<readonly string[]> {
    await this.loaded
    const rows: string[] = []
    for (const intent of this.openIntents(fold(this.records))) {
      const name = intent.capability?.name
      if (name !== undefined && !rows.includes(name)) rows.push(name)
    }
    return rows
  }

  /** Every commit intent still open, in ledger order — one per proposal at most, validated by the fold. */
  protected openIntents(proposals: ReadonlyMap<string, EvolutionProposal>): CommitIntentView[] {
    const open: CommitIntentView[] = []
    const seen = new Set<string>()
    for (const record of this.records) {
      if (record.kind !== 'commit_intent') continue
      const intent = proposals.get(record.proposalId)?.openIntent
      if (intent === undefined || intent.intentId !== record.intentId || seen.has(intent.intentId)) continue
      seen.add(intent.intentId)
      open.push(intent)
    }
    return open
  }

  /** Settle one open intent for a caller that named it (an apply/rollback retry), reporting whether it was redone or written. */
  protected async settleOpenIntent(intent: CommitIntentView): Promise<'redone' | 'written'> {
    const outcome = await reconcileIntent(this.commitHost(), intent)
    if (outcome.result === 'blocked') {
      throw new Error(outcome.detail ?? `evolution: commit intent "${intent.intentId}" cannot be settled`)
    }
    return outcome.result === 'completed-redone' ? 'redone' : 'written'
  }

  /** The production paths a commit of this proposal may write: for a skill object its files, for a capability its new skill. */
  protected commitTargets(proposal: EvolutionProposal): string[] {
    const name =
      proposal.targetType === 'capability'
        ? proposal.prepared?.skillContent?.name
        : (proposal.mutation as SkillMutation).name
    if (name === undefined) return []
    const targets = [resolveWithin(this.skillRoot, productionSkillRelative(name))]
    if (proposal.prepared?.skillContent?.contract !== undefined) {
      targets.push(resolveWithin(this.skillRoot, productionSidecarRelative(name)))
    }
    return targets
  }

  /** A fresh commit of `proposal` refuses, by name, a production **directory** another open intent targets. */
  protected assertTargetUncommitted(proposal: EvolutionProposal): void {
    if ((proposal.targetType !== 'skill' && proposal.targetType !== 'capability') || proposal.mutation === undefined)
      return
    const directories = new Set(this.commitTargets(proposal).map(target => dirname(target)))
    const rowName = proposal.prepared?.capabilityRow?.name
    for (const other of fold(this.records).values()) {
      const intent = other.openIntent
      if (intent === undefined || other.proposalId === proposal.proposalId) continue
      const shared = intent.files
        .map(file => dirname(resolve(file.target)))
        .find(directory => directories.has(directory))
      if (shared !== undefined) {
        throw new Error(
          `evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction ` +
            `"${intent.direction}") commits the production skill directory "${shared}" — proposal "${proposal.proposalId}" does not ` +
            "commit over another proposal's unsettled intent; settle that intent first (reconcile, or a retry of the proposal that owns " +
            'it): nothing was written and no commit intent was recorded',
        )
      }
      if (rowName !== undefined && intent.capability?.name === rowName) {
        throw new Error(
          `evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction "${intent.direction}") ` +
            `moves the capability row "${rowName}" — proposal "${proposal.proposalId}" does not move a row another proposal's unsettled ` +
            'intent already owns; settle that intent first (reconcile, or a retry of the proposal that owns it): nothing was written and ' +
            'no commit intent was recorded',
        )
      }
    }
  }

  /** The narrow host the commit path runs on (see `commit.ts`): the roots, the record funnel, the source reads and the write refusals. */
  protected commitHost(): CommitHost {
    return {
      root: this.root,
      skillRoot: this.skillRoot,
      append: record => this.append(record),
      readSource: async (source, sha256) => {
        const bytes = await readVerifiedFile(this.root, source)
        const digest = sha256Hex(bytes)
        if (digest !== sha256) {
          throw new Error(
            `the recorded source "${source}" no longer holds the committed bytes (sha256 ${digest} != ${sha256}); recorded ` +
              'identities are never re-digested',
          )
        }
        return bytes
      },
      readProduction: async relative => {
        try {
          return await readProductionSkill(this.skillRoot, relative)
        } catch (error) {
          throw new ProductionReadError((error as Error).message.replace(/^(evolution|verified-read): /, ''))
        }
      },
      objectWriteRefusal: intent => objectWriteRefusal(intent),
      tableWriteRefusal: intent => this.tableWriteRefusal(intent),
      verifyCommitted: intent => this.verifyCommitted(intent),
      capability: {
        read: async name => {
          const table = this.effectiveCapabilities()
          if (table === undefined) {
            throw new Error(
              'the effective capability registry cannot be read in this context, so the row a commit would move cannot be compared ' +
                'against the state it recorded',
            )
          }
          return table[name] ?? null
        },
        apply: async (intent, entry) => {
          const runtime = optionalService<CapabilityRowWriter>(this.ctx, 'taskRuntime')
          if (runtime?.applyCapabilityRow === undefined) {
            throw new Error(
              'this deployment offers no capability-registry entry (taskRuntime.applyCapabilityRow), so the row this commit carries ' +
                'cannot be installed',
            )
          }
          await runtime.applyCapabilityRow(intent.capability!.name, entry, {
            commitTargets: intent.files.map(file => file.target),
            commitRow: intent.capability!.name,
          })
        },
      },
      probe: (stage, target) => this.commitProbe?.(stage, target),
    }
  }

  /** The whole-object verification a commit runs after its last file is written. */
  protected async verifyCommitted(intent: CommitIntentView): Promise<void> {
    await this.verifyCommittedFiles(intent)
    await this.verifyCommittedRow(intent)
    await this.persistCapabilityRowText(intent)
  }

  /** The capability table's **own text** (A6): the durable half of a capability commit, written after the row is installed. */
  protected async persistCapabilityRowText(intent: CommitIntentView): Promise<void> {
    const capability = intent.capability
    if (capability === undefined) return
    if (this.capabilityConfigPath === undefined) {
      throw new Error(
        `evolution: this deployment names no capability table file, so the row "${capability.name}" of the ${intent.direction} of ` +
          `proposal "${intent.proposalId}" cannot be persisted — a row that exists only in this process is gone after a restart, and the ` +
          'completion is not recorded for a row the deployment cannot keep; configure the capability table file (Config.capabilityConfig) ' +
          'and retry, and the intent stays open in the meantime',
      )
    }
    const proposal = await this.get(intent.proposalId)
    const table = proposal.prepared?.capabilityTable
    if (table === undefined) {
      throw new Error(
        `evolution: capability-table-unfrozen: proposal "${intent.proposalId}" records no composed identity for the capability table ` +
          `"${this.capabilityConfigPath}", so whether the file still holds the state this ${intent.direction} was prepared against cannot be ` +
          `established — the row "${capability.name}" was not written into it and no completion is recorded; prepare the candidate again ` +
          '(a prepare reads the table and freezes the three whole-file digests every commit of it is compared against)',
      )
    }
    const entry = capability.contentSha256 === null ? null : await committedRow(this.commitHost(), capability)
    const written = await writeCapabilityRowToConfig({
      file: this.capabilityConfigPath,
      name: capability.name,
      entry,
      states: capabilityTableStates(intent.direction, table),
      ...(this.capabilityConfigProbe === undefined ? {} : { probe: this.capabilityConfigProbe }),
    })
    if (written.direction === 'written' && written.rowDigest !== capabilityRowDigest(entry!)) {
      throw new Error(
        `evolution: the capability row "${capability.name}" written into "${written.file}" reads back as ${written.rowDigest}, not as the ` +
          `row this ${intent.direction} committed (sha256 ${capabilityRowDigest(entry!)}); nothing is recorded as settled and the intent ` +
          'stays open',
      )
    }
  }

  /** The capability table half of the commit path's **before** picture (A6, EVO-2): the row and the file digest a write must find. */
  protected async tableWriteRefusal(intent: CommitIntentView): Promise<string | null> {
    const capability = intent.capability
    if (capability === undefined) return null
    const file = this.capabilityConfigPath
    // A deployment that names no table file refuses further along (the table write
    // itself names the missing configuration); there is nothing to compare here.
    if (file === undefined) return null
    const table = (await this.get(intent.proposalId)).prepared?.capabilityTable
    if (table === undefined) {
      return (
        `capability-table-unfrozen: the capability table "${file}" is not one this proposal may write — it records no composed identity for ` +
        `that file, so the state this ${intent.direction} was prepared against cannot be proved (prepare the candidate again, which reads ` +
        'the table and freezes it)'
      )
    }
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      return (
        `capability-table-unreadable: the capability table "${file}" cannot be read ` +
        `(${error instanceof Error ? error.message : String(error)}), so the state this ${intent.direction} would write into is unknown`
      )
    }
    const drift = capabilityTableDrift({
      name: capability.name,
      seen: sha256Hex(Buffer.from(text, 'utf8')),
      states: capabilityTableStates(intent.direction, table),
    })
    return drift === null
      ? null
      : `capability-table-changed: the capability table "${file}" is not a state this ${intent.direction} may write — ${drift}`
  }

  /** The file half of {@link verifyCommitted}. A direction that ends with files removed must find them gone. */
  protected async verifyCommittedFiles(intent: CommitIntentView): Promise<void> {
    if (intent.files.length === 0) return
    if (intent.files.every(file => file.contentSha256 === null)) {
      for (const file of intent.files) {
        const current = await readProductionSkill(this.skillRoot, relative(this.skillRoot, file.target))
        if (current !== null) {
          throw new Error(
            `evolution: the production file "${file.target}" still holds sha256 ${current.sha256} after the ${intent.direction} of ` +
              `proposal "${intent.proposalId}" removed it — the commit intent stays open and no completion is recorded`,
          )
        }
      }
      return
    }
    const skillMd = intent.files[0]!
    const directory = dirname(skillMd.target)
    const name = basename(directory)
    const twoFiles = intent.files.length === 2
    const verdict = await this.providerVerdict({ name, directory })
    const defects = verdict.valid ? '' : verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
    if (!verdict.valid) {
      throw new Error(
        `evolution: the production skill object "${directory}" does not load after the ${intent.direction} of proposal ` +
          `"${intent.proposalId}" — ${defects}; the commit intent stays open and no completion is recorded, because production is ` +
          'neither the state before the commit nor a loadable object',
      )
    }
    const expectedRole = twoFiles ? 'execution-provider' : 'guidance'
    if (verdict.role !== expectedRole) {
      throw new Error(
        `evolution: the production skill object "${directory}" loads as ${verdict.role} after the ${intent.direction} of proposal ` +
          `"${intent.proposalId}", not as the ${expectedRole} its committed file set describes — the commit intent stays open and no ` +
          'completion is recorded',
      )
    }
    if (verdict.content.skillMdSha256 !== skillMd.contentSha256) {
      throw new Error(
        `evolution: the production file "${skillMd.target}" does not carry the committed content after the ${intent.direction} of ` +
          `proposal "${intent.proposalId}" (sha256 ${verdict.content.skillMdSha256} != ${skillMd.contentSha256}) — the commit intent ` +
          'stays open and no completion is recorded',
      )
    }
    if (!twoFiles) return
    if (verdict.role !== 'execution-provider') return
    const sidecarFile = intent.files[1]!
    const sidecar = await readVerifiedFile(this.skillRoot, productionSidecarRelative(name))
    const sidecarDigest = sha256Hex(sidecar)
    if (sidecarDigest !== sidecarFile.contentSha256) {
      throw new Error(
        `evolution: the production file "${sidecarFile.target}" does not carry the committed content after the ${intent.direction} of ` +
          `proposal "${intent.proposalId}" (sha256 ${sidecarDigest} != ${sidecarFile.contentSha256}) — the commit intent stays open and ` +
          'no completion is recorded',
      )
    }
    const proposal = await this.get(intent.proposalId)
    const promised = intent.direction === 'apply' ? proposal.prepared?.skillContent : proposal.prepared?.skillBaseline
    if (promised?.contract === undefined || verdict.contractDigest !== promised.contract.contractDigest) {
      throw new Error(
        `evolution: the production skill "${name}" loads to declaration digest ${verdict.contractDigest} after the ${intent.direction} ` +
          `of proposal "${intent.proposalId}", not the ${promised?.contract?.contractDigest ?? 'identity without a sidecar half'} this ` +
          'direction recorded — the commit intent stays open and no completion is recorded, because the object a registry would absorb ' +
          'is not the one the proposal promised',
      )
    }
  }

  /** The capability half of {@link verifyCommitted} (A6): the registry must read as the intent promised. */
  protected async verifyCommittedRow(intent: CommitIntentView): Promise<void> {
    if (intent.capability === undefined) return
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        `evolution: the effective capability registry cannot be read in this context after the ${intent.direction} of proposal ` +
          `"${intent.proposalId}", so whether the row "${intent.capability.name}" is in place cannot be established — the commit intent ` +
          'stays open and no completion is recorded',
      )
    }
    const entry = table[intent.capability.name] ?? null
    const digest = entry === null ? null : capabilityRowDigest(entry)
    if (digest !== intent.capability.contentSha256) {
      throw new Error(
        `evolution: the capability registry row "${intent.capability.name}" reads ` +
          `${digest === null ? 'no row' : `sha256 ${digest}`} after the ${intent.direction} of proposal "${intent.proposalId}", not the ` +
          `${intent.capability.contentSha256 === null ? 'removed row' : `sha256 ${intent.capability.contentSha256}`} this direction ` +
          'recorded — the commit intent stays open and no completion is recorded',
      )
    }
  }

  /** Serialize one commit — its intent, its production write and its completion — */
  protected async commitExclusive<T>(run: () => Promise<T>): Promise<T> {
    const chained = this.commits.then(run)
    this.commits = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
  }

  /** Folded view of one proposal, or throws on an unknown id. */
  async get(proposalId: string): Promise<EvolutionProposal> {
    await this.loaded
    const proposal = fold(this.records).get(proposalId)
    if (proposal === undefined) throw new Error(`evolution: unknown proposal "${proposalId}"`)
    return proposal
  }

  /** Early state-machine check so a wrong-state call reports the transition it needs. */
  protected async assertNext(proposalId: string, kind: EvolutionStatus): Promise<EvolutionProposal> {
    await this.loaded
    const current = fold(this.records).get(proposalId)
    if (current === undefined) throw new Error(`evolution: unknown proposal "${proposalId}"`)
    assertTransition(current, kind)
    return current
  }

  protected async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    const records: EvolutionRecord[] = lines.map((line, index) => {
      try {
        return JSON.parse(line) as EvolutionRecord
      } catch {
        throw new Error(`evolution: corrupt ledger line ${index + 1} in ${this.file}`)
      }
    })
    // One format, one check (K2): the ledger is `formatVersion: 4`, and every line must declare it.
    for (const [index, record] of records.entries()) {
      assertLedgerFormatVersion(record, `ledger line ${index + 1} in ${this.file}`)
    }
    this.records = records
    this.foldLedger(this.records)
  }

  /** Validate a whole ledger: the proposal lifecycle fold, then the experiment family. */
  protected foldLedger(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
    const proposals = fold(records)
    foldExperiments(records, proposals)
    return proposals
  }

  /** Tell listeners one durable line landed: what moved is the proposal the record names. */
  protected broadcast(proposalId: string): void {
    const emit = this.ctx.emit as ((name: string, payload: { proposalId: string }) => void) | undefined
    emit?.('evolution/change', { proposalId })
  }

  /** The staged fold first; memory commits only once the line's bytes are durable. */
  protected async append(record: EvolutionRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      assertLedgerFormatVersion(record, `the ${record.kind} record for proposal "${record.proposalId}"`)
      this.foldLedger([...this.records, record])
      await this.appendLedgerLine(record, () => {
        this.records = [...this.records, record]
      })
      this.broadcast(record.proposalId)
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /** The ledger's one durable write path: append one whole line and make it durable before memory adopts it. */
  protected async appendLedgerLine(record: EvolutionRecord, adopt: () => void): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const step = `the ${record.kind} record for proposal "${record.proposalId}"`
    const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    let created: string | undefined
    try {
      created = await mkdir(this.root, { recursive: true })
    } catch (error) {
      throw new Error(
        `evolution: the ledger directory ${this.root} could not be created (${reason(error)}) — ${step} is not written and not ` +
          'durable, so nothing may depend on it',
      )
    }
    let handle: FileHandle | undefined
    try {
      try {
        handle = await open(this.file, 'a')
      } catch (error) {
        throw new Error(
          `evolution: the ledger file ${this.file} could not be opened for append (${reason(error)}) — ${step} is not written: the line ` +
            'is not durable and nothing may depend on it',
        )
      }
      // The length this append starts from: a write that fails part-way is rolled
      // back to it, so a fragment never survives into the ledger.
      let length: number
      try {
        length = (await handle.stat()).size
      } catch (error) {
        throw new Error(
          `evolution: the ledger file ${this.file} could not be measured before appending ${step} (${reason(error)}) — the line is not ` +
            'written and nothing may depend on it',
        )
      }
      try {
        await handle.writeFile(line, 'utf8')
        adopt()
      } catch (error) {
        try {
          await handle.truncate(length)
        } catch (restore) {
          throw new Error(
            `evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) and the file could not be truncated ` +
              `back to the ${length} bytes it held before this call (${reason(restore)}) — the ledger may hold a partial line no record ` +
              'explains; the line is not durable, so nothing may depend on it and no write it would have justified may proceed',
          )
        }
        throw new Error(
          `evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) — the ledger is back to the ${length} ` +
            'bytes it held before this call, so no fragment was left behind; the line is not durable and nothing may depend on it, so no ' +
            'write it would have justified may proceed',
        )
      }
      try {
        await handle.sync()
      } catch (error) {
        throw new Error(
          `evolution: ${step} was written to the ledger ${this.file} but could not be fsynced (${reason(error)}) — the line is not ` +
            'durable, so nothing may depend on it and no write it would have justified may proceed',
        )
      }
    } finally {
      await handle?.close().catch(() => {})
    }
    for (const directory of ledgerDirectories(this.root, created)) {
      try {
        await syncDirectory(directory)
      } catch (error) {
        throw new Error(
          `evolution: the ledger directory ${directory} could not be fsynced after appending ${step} to ${this.file} ` +
            `(${reason(error)}) — whether the line survives a power cut is unknown, so it must not be treated as durable`,
        )
      }
    }
  }

  /** Folded views, newest proposal first, optionally filtered. */
  async list(filter: ListFilter = {}): Promise<EvolutionProposal[]> {
    await this.loaded
    const proposals = [...fold(this.records).values()].reverse()
    return proposals.filter(
      proposal =>
        (filter.status === undefined || proposal.status === filter.status) &&
        (filter.targetType === undefined || proposal.targetType === filter.targetType) &&
        (filter.targetId === undefined || proposal.targetId === filter.targetId),
    )
  }

  /** The root task store of one live session, derived from its own graph — never from an id the caller passed. */
  protected async storeOfSession(sessionId: string): Promise<string> {
    const graphs = optionalService<{ graphForSession(session: SessionId): Promise<{ rootSessionId: unknown }> }>(
      this.ctx,
      'graphs',
    )
    if (graphs === undefined) {
      throw new Error(
        `evolution: this deployment offers no graph registry, so the store of session "${sessionId}" cannot be read; nothing was started`,
      )
    }
    try {
      const graph = await graphs.graphForSession(SessionId(sessionId))
      return rootTaskStoreId(String(graph.rootSessionId))
    } catch (error) {
      throw new Error(
        `evolution: session "${sessionId}" has no graph in this deployment (${error instanceof Error ? error.message : String(error)}), so the ` +
          'store a recovery would open cannot be established; nothing was started',
      )
    }
  }

  /** The one runtime call this entry makes, with the answer every path carries: the runtime's own recovery outcome. */
  protected async recoverThroughRuntime(
    storeId: string,
    recovery: RootRecoveryRequest,
    caller: RecoveryCoordinationCaller,
    delegation: SupervisorDelegation,
    coordination: readonly string[],
  ): Promise<RecoveryCoordinationOutcome> {
    const runtime = optionalService<{
      recoverRootTask(
        storeId: string,
        request: RootRecoveryRequest,
        caller: RootRecoveryCaller,
      ): Promise<RootRecoveryOutcome>
    }>(this.ctx, 'taskRuntime')
    if (runtime?.recoverRootTask === undefined) {
      throw new Error(
        'evolution: this deployment offers no execution-recovery entry (taskRuntime.recoverRootTask), so the new attempt cannot be opened; ' +
          'nothing was started',
      )
    }
    const outcome = await runtime.recoverRootTask(storeId, recovery, {
      sessionId: caller.sessionId,
      ...(caller.signal === undefined ? {} : { signal: caller.signal }),
    })
    return {
      ...outcome,
      handoff: { sessionId: delegation.sessionId, actor: delegation.actor, diagnosisId: delegation.diagnosisId },
      coordination,
    }
  }

  /** Whether this deployment declares the evolution chain on. Read softly, and read as on when the
   * switch is absent: only a deployment that says `enabled: false` relaxes the ledger's own gates. */
  protected evolutionChainOn(): boolean {
    const exposure = optionalService<{ readonly enabled?: boolean }>(this.ctx, 'singularityEvolution')
    return exposure === undefined || exposure.enabled !== false
  }

  /** The **recovery coordination** entry (A6, plan §F.4): take one recorded delegation and open the runtime's own recovery. */
  async coordinateRecovery(
    request: RecoveryCoordinationRequest,
    caller: RecoveryCoordinationCaller,
  ): Promise<RecoveryCoordinationOutcome> {
    const defects = recoveryCoordinationDefects(request)
    if (defects.length > 0) {
      throw new Error(`evolution: the recovery request was refused:\n- ${defects.join('\n- ')}`)
    }
    if (typeof caller?.sessionId !== 'string' || caller.sessionId.trim().length === 0) {
      throw new Error(
        'evolution: a recovery is asked for by the session that coordinates the hand-off: pass a non-empty caller session id',
      )
    }
    if (this.resolveSupervisorDelegation === undefined) {
      throw new Error(
        'evolution: this deployment wires no supervisor-delegation source, so "this session coordinates the hand-off" cannot be ' +
          'established; a recovery needs the ledger row that delegated the hand-off, and nothing was started',
      )
    }
    const delegation = await this.resolveSupervisorDelegation(caller.sessionId, request.sourceDiagnosisId)
    if (delegation === undefined) {
      throw new Error(
        `evolution: session "${caller.sessionId}" is not the supervisor of diagnosis "${request.sourceDiagnosisId}" — this deployment's ` +
          'ledger records no started hand-off for that pair, and a recovery entry is open to the coordinator that hand-off was delegated ' +
          'to and to no one else; nothing was started',
      )
    }
    if (delegation.sessionId !== caller.sessionId || delegation.diagnosisId !== request.sourceDiagnosisId) {
      throw new Error(
        `evolution: the delegation read back for session "${caller.sessionId}" names session "${delegation.sessionId}" and diagnosis ` +
          `"${delegation.diagnosisId}"; a delegation that does not answer the question it was asked is not an authorization, and nothing was started`,
      )
    }
    const storeId = await this.storeOfSession(caller.sessionId)
    if (storeId !== delegation.rootStoreId) {
      throw new Error(
        `evolution: session "${caller.sessionId}" belongs to store "${storeId}", while the hand-off it claims was delegated into ` +
          `"${delegation.rootStoreId}" — a delegation never moves a session into another graph's store, and nothing was started`,
      )
    }
    const task = optionalService<{ openStore(storeId: string): Promise<TaskSnapshot> }>(this.ctx, 'task')
    if (task === undefined) {
      throw new Error(
        'evolution: this deployment offers no task store, so the diagnosis a recovery names cannot be read; nothing was started',
      )
    }
    let snapshot: TaskSnapshot
    try {
      snapshot = await task.openStore(storeId)
    } catch (error) {
      throw new Error(
        `evolution: the store "${storeId}" of the hand-off could not be read (${error instanceof Error ? error.message : String(error)}); ` +
          'nothing was started',
      )
    }
    const diagnosis = (snapshot.diagnoses ?? []).find(item => item.diagnosisId === request.sourceDiagnosisId)
    if (diagnosis === undefined) {
      throw new Error(
        `evolution: store "${storeId}" holds no diagnosis "${request.sourceDiagnosisId}"; a recovery is asked for by a diagnosis of this ` +
          'store, so this hand-off names no fact here and nothing was started',
      )
    }
    const source = snapshot.tasks.find(item => item.taskId === diagnosis.taskId)
    if (source === undefined) {
      throw new Error(
        `evolution: diagnosis "${diagnosis.diagnosisId}" names task "${diagnosis.taskId}", which store "${storeId}" does not hold; ` +
          'nothing was started',
      )
    }
    if (source.parentTaskId !== undefined) {
      throw new Error(
        `evolution: task "${source.taskId}" is a child of "${source.parentTaskId}"; a recovery attempt is opened for the store's own root task, ` +
          'and a child is re-run by a batch of its parent — nothing was started',
      )
    }
    const coordination: string[] = [
      `the hand-off was delegated by session "${delegation.actor}" into store "${delegation.rootStoreId}"`,
      `the diagnosis names root task "${source.taskId}" [${source.status}]`,
    ]
    // A verified source is an improvement round: this plane forwards it and the
    // runtime, which owns the per-source cap, judges it by the original criteria.
    if (source.status === 'verified') {
      coordination.push(
        `root task "${source.taskId}" is verified, so the attempt is an improvement round — the runtime decides whether its cap admits it`,
      )
    }
    const sourceRunId = recoverySourceRunId(diagnosis, source, snapshot)
    // A key that already names an attempt is *answered*, not re-decided: the run's
    const answered = recoveryAttemptWithKey(snapshot, source.taskId, request.requestKey)
    if (answered !== undefined) {
      coordination.push(
        `request key "${request.requestKey}" already names attempt "${answered.runId}" [${answered.status}]; it is answered from that record`,
      )
      return await this.recoverThroughRuntime(
        storeId,
        {
          sourceTaskId: source.taskId,
          sourceRunId,
          sourceDiagnosisId: request.sourceDiagnosisId,
          requestKey: request.requestKey,
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
          proposalIds: answered.recovery?.proposalIds,
        },
        caller,
        delegation,
        coordination,
      )
    }
    if (source.status === 'running' || source.status === 'verifying') {
      throw new Error(
        `evolution: root task "${source.taskId}" is ${source.status}; a recovery opens a new attempt after the old one settled and never ` +
          'hot-swaps a live run — nothing was started',
      )
    }
    const chainOn = this.evolutionChainOn()
    const associated = (await this.list()).filter(proposal =>
      proposal.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`),
    )
    // The chain's capability gate (A6): a change this hand-off stands on must be
    // applied; chain off, a proposal can authorize nothing, so none blocks the attempt.
    if (chainOn) {
      for (const proposal of associated) {
        if (
          proposal.status === 'applied' &&
          proposal.applied !== undefined &&
          proposal.rolledback === undefined
        ) {
          continue
        }
        const state =
          proposal.status === 'decided' && proposal.decision === 'PROMOTE'
            ? 'PROMOTE-decided but not applied'
            : proposal.status === 'rolledback'
              ? 'rolled back'
              : proposal.status
        throw new Error(
          `evolution: the shared change this hand-off depends on (proposal "${proposal.proposalId}" ${proposal.targetType} "${proposal.targetId}") is ` +
            `${state}; a recovery that depends on this change is opened only after a person approves it and apply commits it into ` +
            'production — nothing was started, and no run was opened',
        )
      }
      if (associated.length > 0) {
        coordination.push(
          `this ledger holds ${associated.length} proposal(s) for the diagnosis, ` +
            'all applied and in force',
        )
      }
    } else if (associated.length > 0) {
      coordination.push(
        `the evolution chain is off in this deployment, so the ${associated.length} proposal(s) this ledger holds for the diagnosis are not consulted`,
      )
    }
    if (associated.length === 0) {
      // A pure artifact gap: no candidate in this ledger, so the only capability
      const requested = source.requestedCapabilities ?? []
      if (requested.length === 0) {
        coordination.push(
          'this ledger holds no proposal for the diagnosis; the source requires no capability row of its own',
        )
      } else {
        const query = optionalService<{ listCapabilities?(): Readonly<Record<string, CapabilityConfig>> }>(
          this.ctx,
          'taskRuntime',
        )
        const table = (() => {
          try {
            return query?.listCapabilities?.()
          } catch {
            return undefined
          }
        })()
        if (table === undefined) {
          throw new Error(
            `evolution: the recovery of "${source.taskId}" carries no candidate in this ledger, so it is a pure artifact gap — and the ` +
              "capability table that gap's production needs cannot be read in this context; nothing was started rather than assuming the rows resolve",
          )
        }
        const unresolved = requested.filter(name => !capabilityToolQuery(table)(name).known)
        if (unresolved.length > 0) {
          throw new Error(
            `evolution: the recovery of "${source.taskId}" carries no candidate in this ledger and the capability the production needs is still ` +
              `missing ([${unresolved.join(', ')}] resolve to no row in this deployment's table); a pure artifact gap is recoverable, a capability gap ` +
              'is not — nothing was started',
          )
        }
        coordination.push(
          `this ledger holds no proposal for the diagnosis; the row(s) the source uses ([${requested.join(', ')}]) resolve in the current table`,
        )
      }
    }
    const inFlight = inFlightRecoveryAttempt(snapshot, source.taskId, request.sourceDiagnosisId)
    if (inFlight !== undefined && inFlight.recovery?.requestKey !== request.requestKey) {
      throw new Error(
        `evolution: diagnosis "${request.sourceDiagnosisId}" already has a recovery attempt in flight (run "${inFlight.runId}", key ` +
          `"${inFlight.recovery?.requestKey ?? 'unknown'}"); key "${request.requestKey}" starts nothing — an attempt ends when its run settles, and ` +
          'a new key may be asked for after that',
      )
    }
    return await this.recoverThroughRuntime(
      storeId,
      {
        sourceTaskId: source.taskId,
        sourceRunId,
        sourceDiagnosisId: request.sourceDiagnosisId,
        requestKey: request.requestKey,
        ...(chainOn && associated.length ? { proposalIds: associated.map(proposal => proposal.proposalId) } : {}),
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
      },
      caller,
      delegation,
      coordination,
    )
  }

  /** The commit request one apply/rollback binds, read off the prepared record. */
  protected commitRequest(
    proposal: EvolutionProposal,
    direction: CommitDirection,
    actor: string,
    approvalRef: string,
  ): CommitRequest {
    if (proposal.targetType === 'capability')
      return this.capabilityCommitRequest(proposal, direction, actor, approvalRef)
    if (proposal.targetType !== 'skill') {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores the fixed ` +
          `file set of one skill object and moves one capability row, so there is no executor to ${direction} an applied ${proposal.targetType} record`,
      )
    }
    const prepared = proposal.prepared
    const content = prepared?.skillContent
    const baseline = prepared?.skillBaseline
    if (
      prepared?.sandbox == null ||
      prepared.champion !== 'captured' ||
      proposal.mutation === undefined ||
      content === undefined ||
      baseline === undefined ||
      baseline === null
    ) {
      // The fold admits only a materialized skill prepare (sandbox, champion
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`,
      )
    }
    const { name } = proposal.mutation as unknown as SkillMutation
    if (content.name !== name || baseline.name !== name) {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" records content identities for skill "${content.name}/${baseline.name}" but its ` +
          `mutation names "${name}" — the commit cannot write one skill's verified bytes onto another skill's target`,
      )
    }
    const contentContract = content.contract
    const baselineContract = baseline.contract
    if ((contentContract === undefined) !== (baselineContract === undefined)) {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" records a candidate object and a production baseline of different shapes ` +
          `(${contentContract === undefined ? 'guidance' : 'execution'} vs ${baselineContract === undefined ? 'guidance' : 'execution'}) ` +
          '— a commit moves one object between two versions of the same shape',
      )
    }
    const targets = this.commitTargets(proposal)
    const skillMd: CommitFile =
      direction === 'apply'
        ? {
            target: targets[0]!,
            baselineSha256: baseline.sha256,
            contentSha256: content.sha256,
            source: `${prepared.sandbox}/skills/${name}/SKILL.md`,
          }
        : {
            target: targets[0]!,
            baselineSha256: content.sha256,
            contentSha256: baseline.sha256,
            source: `${prepared.sandbox}/champion/skills/${name}/SKILL.md`,
          }
    const files: CommitFile[] = [skillMd]
    if (contentContract !== undefined && baselineContract !== undefined) {
      files.push(
        direction === 'apply'
          ? {
              target: targets[1]!,
              baselineSha256: baselineContract.sha256,
              contentSha256: contentContract.sha256,
              source: `${prepared.sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`,
            }
          : {
              target: targets[1]!,
              baselineSha256: contentContract.sha256,
              contentSha256: baselineContract.sha256,
              source: `${prepared.sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`,
            },
      )
    }
    return { proposalId: proposal.proposalId, direction, approvalRef, files, actor }
  }

  /** The commit one capability candidate binds (A6): the one row it moves and the file set of the new skill when it carries one. */
  protected capabilityCommitRequest(
    proposal: EvolutionProposal,
    direction: CommitDirection,
    actor: string,
    approvalRef: string,
  ): CommitRequest {
    const prepared = proposal.prepared
    const row = proposal.mutation === undefined ? undefined : validateCapabilityMutation(proposal.mutation).row
    if (
      prepared?.sandbox == null ||
      prepared.capabilityRow === undefined ||
      row === undefined ||
      prepared.capabilityBaseline === undefined
    ) {
      throw new Error(
        `evolution: capability proposal "${proposal.proposalId}" has no materialized candidate (its frozen row, its mutation and the ` +
          `baseline it read are all required), so there is nothing to ${direction}`,
      )
    }
    const sandbox = prepared.sandbox
    const baseline = prepared.capabilityBaseline
    const capability: CommitCapability =
      direction === 'apply'
        ? {
            name: prepared.capabilityRow.name,
            baselineSha256: baseline === null ? null : baseline.digest,
            contentSha256: prepared.capabilityRow.digest,
            source: `${sandbox}/capability/${prepared.capabilityRow.name}.json`,
          }
        : {
            name: prepared.capabilityRow.name,
            baselineSha256: prepared.capabilityRow.digest,
            contentSha256: baseline === null ? null : baseline.digest,
            ...(baseline === null
              ? {}
              : { source: `${sandbox}/champion/capability/${prepared.capabilityRow.name}.json` }),
          }
    const files: CommitFile[] = []
    const content = prepared.skillContent
    if (content !== undefined) {
      if (content.contract === undefined) {
        throw new Error(
          `evolution: capability proposal "${proposal.proposalId}" records a new skill without a declaration, and a capability candidate's ` +
            'skill is an execution provider — the object prepare froze is not one this build writes',
        )
      }
      const targets = this.commitTargets(proposal)
      files.push(
        direction === 'apply'
          ? {
              target: targets[0]!,
              baselineSha256: null,
              contentSha256: content.sha256,
              source: `${sandbox}/skills/${content.name}/SKILL.md`,
            }
          : { target: targets[0]!, baselineSha256: content.sha256, contentSha256: null },
      )
      files.push(
        direction === 'apply'
          ? {
              target: targets[1]!,
              baselineSha256: null,
              contentSha256: content.contract.sha256,
              source: `${sandbox}/skills/${content.name}/${SKILL_SIDECAR_FILE}`,
            }
          : { target: targets[1]!, baselineSha256: content.contract.sha256, contentSha256: null },
      )
    }
    return { proposalId: proposal.proposalId, direction, approvalRef, files, capability, actor }
  }

  /** The folded views of every experiment, one per id — the ledger's experiment family, validated. */
  protected experimentViews(): Map<string, ExperimentView> {
    return foldExperiments(this.records, fold(this.records))
  }

  /** One experiment's folded view (its frozen block and every sample record), validated. */
  async experiment(experimentId: string): Promise<ExperimentView> {
    await this.loaded
    const view = this.experimentViews().get(experimentId)
    if (view === undefined) throw new Error(`evolution: unknown experiment "${experimentId}"`)
    return view
  }

  /** Every experiment's folded view, newest first, optionally narrowed to one proposal. */
  async experiments(proposalId?: string): Promise<ExperimentView[]> {
    await this.loaded
    return [...this.experimentViews().values()]
      .filter(view => proposalId === undefined || view.proposalId === proposalId)
      .reverse()
  }

  /** Record the frozen experiment, before its first run. Idempotent by identity: an identical record is a no-op, a different one refuses. */
  async recordExperimentStart(record: ExperimentStartedRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      // One format at this door too, before anything is decided about the record.
      assertLedgerFormatVersion(record, `the experiment_started record for "${record.experimentId}"`)
      // The line must stand on its own before anything is decided about it:
      // frozen block, digest, id, budget and report path all re-derived.
      assertExperimentStartRecord(record, fold(this.records))
      // Then the repeat rule. While the derivation above holds, one id can only ever name the same frozen experiment.
      const prior = this.experimentViews().get(record.experimentId)
      if (prior !== undefined) {
        if (
          prior.frozenDigest !== record.frozenDigest ||
          prior.proposalId !== record.proposalId ||
          prior.report !== record.report ||
          prior.storeId !== record.storeId ||
          canonicalJson(prior.frozen) !== canonicalJson(record.frozen)
        ) {
          throw new Error(
            `evolution: experiment "${record.experimentId}" is already recorded with a different frozen identity — ` +
              'an experiment id names one frozen block, its own report path and the task store its runs live in; changing any of ' +
              'them freezes a different experiment',
          )
        }
        return
      }
      const staged = [...this.records, record]
      foldExperiments(staged, fold(staged))
      // The same durable append the lifecycle funnel uses: this is the ledger's
      // second (and only other) write door, and it writes through the one path.
      await this.appendLedgerLine(record, () => {
        this.records = staged
      })
      this.broadcast(record.proposalId)
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  /** Record one sample side, once. The key carries the run: a second record for the same key is refused. */
  async recordExperimentSample(record: ExperimentSampleRecord): Promise<void> {
    await this.append(record)
  }
}
