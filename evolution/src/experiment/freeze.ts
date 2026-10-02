import { validateTaskDefinitionMutation, oracleContractDigest, independentOracleCriteria } from '../task-definition.ts'
import type { FrozenTaskDefinition } from '../task-definition.ts'
import { directoryDigest, latestReview } from './record.ts'
/** Freezing one proposal into an experiment: the candidate's identity, the frozen samples, the judge vocabulary and both sides' sources.
 * @module dsh-singularity-evolution/experiment/freeze */

import { resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { McpServerTemplate, CapabilityConfig, ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { mcpServerBindings, registryRevision, resolveCapabilities } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from '../evolution.ts'
import type { PreparedCapability } from '../capability-candidate.ts'
import { capabilityOverlay, capabilityRowIdentity } from '../capability-candidate.ts'
import type {
  ExperimentBudget,
  FrozenCapability,
  FrozenCapabilitySide,
  FrozenCriterion,
  FrozenExperiment,
  FrozenProviderIdentity,
  FrozenProviderSkill,
  FrozenSample,
  FrozenSampleAdmission,
  SkillContentIdentity,
} from '../replay.ts'
import { assertFrozenExperiment, digestOf, EXPERIMENT_COMPARER_VERSION, protectedInputsDigest } from '../replay.ts'
import { isHex64 } from '../shared.ts'
import type {
  ExperimentRecord,
  ExperimentSampleRecord,
  ExperimentSampleSpec,
  ExperimentSpec,
  ExperimentStartedRecord,
} from './spec.ts'

/** The idempotency key's content member (K3, A6): the digest of the candidate's complete identity. */
export function preparedContentDigestOf(frozen: {
  candidate?: SkillContentIdentity
  capability?: FrozenCapability
  taskDefinition?: FrozenTaskDefinition
}): string {
  if (frozen.taskDefinition !== undefined) return digestOf(frozen.taskDefinition)
  if (frozen.capability !== undefined) {
    return digestOf({
      capability: frozen.capability,
      ...(frozen.candidate === undefined ? {} : { candidate: frozen.candidate }),
    })
  }
  if (frozen.candidate === undefined) {
    throw new Error(
      'experiment: a frozen block with neither a candidate object nor a capability candidate has no identity to key a sample by',
    )
  }
  return digestOf(frozen.candidate)
}

/** True for a record of the experiment family — the lines the proposal fold must leave alone. */
export function isExperimentRecord(record: { kind: string }): record is ExperimentRecord {
  return record.kind === 'experiment_started' || record.kind === 'experiment_sample'
}

/** One experiment's folded view: its started record plus every sample record written under it. */
export interface ExperimentView {
  experimentId: string
  proposalId: string
  frozen: FrozenExperiment
  frozenDigest: string
  budget: ExperimentBudget
  report: string
  /** The task store this experiment's runs were created in (see {@link ExperimentStartedRecord.storeId}). */
  storeId?: string
  /** The `experiment_started` record's own timestamp. */
  at: string
  /** Sample records in ledger order. */
  samples: ExperimentSampleRecord[]
}

/** The ledger as this module uses it: the proposal it evaluates, the candidate's files, the experiment views and the ledger root. */
export interface ExperimentLedger {
  /** Absolute ledger directory; the sandbox, the workspaces and the report live under it. */
  readonly root: string
  get(proposalId: string): Promise<EvolutionProposal>
  /** Read the prepared candidate object's files — `SKILL.md`, and the sidecar when it carries one. */
  readSkillCandidate(proposalId: string): Promise<{ skillMd: Buffer; sidecar?: Buffer }>
  /** Read a prepared **capability** candidate back out of its sandbox and verify it. */
  readCapabilityCandidate(proposalId: string): Promise<PreparedCapability>
  readTaskDefinitionCandidate(proposalId: string): Promise<FrozenTaskDefinition>
  /** One experiment's folded view; throws on an unknown id. */
  experiment(experimentId: string): Promise<ExperimentView>
  /** Every experiment folded under one proposal, newest first. One call answers the whole family. */
  experiments(proposalId: string): Promise<ExperimentView[]>
  /** Record the frozen experiment (idempotent by identity: an identical record is a no-op, a different one refuses). */
  recordExperimentStart(record: ExperimentStartedRecord): Promise<void>
  /** Record one sample side. A key that is already recorded refuses a different content by name. */
  recordExperimentSample(record: ExperimentSampleRecord): Promise<void>
}

/** One accepted provider verdict, as a freeze reads it off the runtime's own pre-check (the members it records, and no more). */
export interface PrecheckSkillVerdict {
  readonly valid: boolean
  readonly name: string
  readonly role?: string
  readonly contractDigest?: string | null
  readonly contentDigest?: string
  readonly defects?: readonly { readonly code: string; readonly detail: string }[]
}

/** The runtime's provider pre-check as the freeze consumes it (`TaskRuntime.capabilityProviderReport`). */
export interface ProviderPrecheckView {
  readonly capabilities: readonly { readonly capability: string; readonly skills: readonly PrecheckSkillVerdict[]; readonly refusals?: readonly { code: string; detail: string }[] }[]
  readonly revision: string
}

/** The services one experiment reads, as the caller's context holds them. */
export interface ExperimentSources {
  readonly evolution: ExperimentLedger
  readonly graphs: { graphForSession(sessionId: SessionId): Promise<{ readonly rootSessionId: SessionId }> }
  readonly task: { openStore(storeId: string): Promise<TaskSnapshot> }
  readonly taskRuntime: {
    replayTask(
      storeId: string,
      championTaskId: string,
      options: ReplayTaskOptions,
      callerSessionId: string,
    ): Promise<ReplayRunOutcome>
    /** The runtime's own provider pre-check for one session's viewpoint (S4-E §Q3). */
    capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheckView>
    /** The runtime's own pre-check over a capability table the experiment names (A6). */
    precheckCapabilityTable?(request: {
      capabilities: readonly string[]
      table: Readonly<Record<string, CapabilityConfig>>
      extraRoots: readonly string[]
      mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
    }): Promise<ProviderPrecheckView>
    /** The effective capability table, as the runtime holds it — the rows a pre-check covered and the servers they grant. */
    listCapabilities?(): Readonly<Record<string, CapabilityConfig>>
    listMcpServers?(): Readonly<Record<string, McpServerTemplate>>
  }
  /** The registered judge vocabulary at freeze time (S4-E §Q3), or `undefined` */
  verifierVocabulary?(): Promise<VerifierVocabularyView | undefined>
}

/** What one experiment call evaluates: the proposal, its sandbox, and the identity it froze the candidate as. */
export interface ExperimentCandidate {
  proposal: EvolutionProposal
  sandbox: string
  /** The skill object the candidate side runs (a skill candidate, or a capability candidate's new skill). */
  candidate?: SkillContentIdentity
  /** The capability candidate's frozen identity (A6); absent for a skill candidate. */
  capability?: FrozenCapability
  taskDefinition?: FrozenTaskDefinition
  /** The candidate-side overlay of a capability candidate: the row override and the sandbox skill root. */
  overlay?: { capabilityOverrides: Record<string, CapabilityConfig>; extraSkillRoots: string[]; mcpServers?: Record<string, McpServerTemplate> }
}

/** The proposal this experiment may evaluate, and the candidate identity it runs against. */
export async function experimentCandidate(
  sources: ExperimentSources,
  proposalId: string,
): Promise<ExperimentCandidate> {
  const proposal = await sources.evolution.get(proposalId)
  if (proposal.targetType !== 'skill' && proposal.targetType !== 'capability' && proposal.targetType !== 'task_definition') {
    throw new Error(
      `proposal ${proposalId} targets "${proposal.targetType}"; the two-sided experiment evaluates a skill candidate or a ` +
        'capability candidate (A6) only',
    )
  }
  if (proposal.status !== 'prepared') {
    throw new Error(`proposal ${proposalId} is ${proposal.status}; only a prepared proposal can be evaluated`)
  }
  const prepared = proposal.prepared
  // The checks below narrow the view's optional fields; every one of them is required by the fold.
  if (prepared === undefined || prepared.sandbox === null || !prepared.mechanical) {
    throw new Error(`proposal ${proposalId} has no materialized candidate; prepare it before evaluating it`)
  }
  if (proposal.targetType === 'task_definition') return { proposal, sandbox: prepared.sandbox, taskDefinition: await sources.evolution.readTaskDefinitionCandidate(proposalId) }
  if (proposal.targetType === 'capability') {
    if (prepared.capabilityRow === undefined) {
      throw new Error(
        `proposal ${proposalId} carries no frozen capability row — a capability prepare records the row it installs and the row it ` +
          'moves, so a proposal without them has nothing this experiment could compare',
      )
    }
    // P2/P3 before anything runs: every byte is the one prepare recorded.
    const verified = await sources.evolution.readCapabilityCandidate(proposalId)
    const identity = capabilityRowIdentity(verified.row)
    if (identity.digest !== prepared.capabilityRow.digest || identity.name !== prepared.capabilityRow.name) {
      throw new Error(
        `proposal ${proposalId} prepared capability row "${prepared.capabilityRow.name}" (${prepared.capabilityRow.digest}), but the ` +
          `sandbox holds row "${identity.name}" (${identity.digest}) — the two must be the same row before anything runs`,
      )
    }
    const baselineRow =
      verified.baseline === undefined
        ? null
        : capabilityRowIdentity({ name: prepared.capabilityRow.name, entry: verified.baseline.entry })
    const recordedBaseline = prepared.capabilityBaseline ?? null
    const baseline =
      recordedBaseline === null
        ? null
        : { name: recordedBaseline.name, entry: recordedBaseline.entry, digest: recordedBaseline.digest }
    if (
      (baselineRow === null) !== (baseline === null) ||
      (baselineRow !== null && baseline !== null && baselineRow.digest !== baseline.digest)
    ) {
      throw new Error(
        `proposal ${proposalId} records capability baseline ${baseline?.digest ?? 'no row'}, but the sandbox holds ` +
          `${baselineRow?.digest ?? 'none'} — the row this candidate moves cannot be re-proved, so nothing runs under it`,
      )
    }
    return {
      proposal,
      sandbox: prepared.sandbox,
      capability: {
        row: { name: prepared.capabilityRow.name, entry: verified.row.entry, digest: prepared.capabilityRow.digest },
        baseline,
        sourceRefs: [...proposal.sourceRefs],
        ...(verified.mcpServers === undefined ? {} : { mcpServers: verified.mcpServers }),
      },
      ...(prepared.skillContent === undefined ? {} : { candidate: prepared.skillContent }),
      overlay: capabilityOverlay(proposal, { root: sources.evolution.root }),
    }
  }
  const candidate = prepared.skillContent
  if (candidate === undefined) {
    throw new Error(
      `proposal ${proposalId} carries no candidate content identity — ` + 'propose a new candidate and prepare it',
    )
  }
  // P2 before anything runs: the file must still be exactly the bytes prepare recorded.
  await sources.evolution.readSkillCandidate(proposalId)
  return { proposal, sandbox: prepared.sandbox, candidate }
}

/** The registered judge vocabulary one freeze reads: the ids and declared versions the runs are judged by. */
export interface VerifierVocabularyView {
  readonly ids: readonly string[]
  readonly versions: Readonly<Record<string, string>>
}

/** One criterion's frozen judge identity (S4-E §Q3), read from the criterion's verifier ref and the live vocabulary. */
export function frozenCriterionOf(
  criterion: AcceptanceCriterion,
  where: string,
  vocabulary: VerifierVocabularyView | undefined,
): FrozenCriterion {
  const inputs = criterion.protectedInputs ?? []
  for (const input of inputs) {
    if (typeof input?.path !== 'string' || input.path.length === 0 || !isHex64(input?.sha256)) {
      throw new Error(
        `the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — ` +
          'an acceptance input nobody fixed is not a frozen input',
      )
    }
  }
  const ref = criterion.verifierRef
  if (ref === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins no verifierRef — the judge a verdict belongs to is fixed before the first ` +
        'run, so a criterion that lets the registry choose by mode cannot be frozen; pin the registered, versioned verifier that decides it',
    )
  }
  if (vocabulary === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}" but this deployment cannot list its verifier registry ` +
        '(verifierIds()/verifierVersions() are unavailable), so the judge identity cannot be frozen — an experiment whose judge nobody ' +
        'can name is refused before it runs',
    )
  }
  if (!vocabulary.ids.includes(ref)) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry does not hold ` +
        `(registered: ${vocabulary.ids.length === 0 ? 'none' : vocabulary.ids.join(', ')}) — the criterion would be judged inconclusive ` +
        'by a judge that does not exist; name a registered verifier before freezing the experiment',
    )
  }
  const declared = vocabulary.versions[ref]
  if (declared === undefined) {
    throw new Error(
      `${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry holds but declares no version for — ` +
        'a verdict belongs to the instance that judged it, so a judge nobody can recall by version is refused before the experiment runs',
    )
  }
  return {
    criterionId: criterion.criterionId,
    verificationMode: criterion.verificationMode,
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    protectedInputsDigest: protectedInputsDigest(inputs),
    verifierRef: ref,
    verifierVersion: declared,
    verifierAnchor: `registered verifier "${ref}" declares version "${declared}"`,
  }
}

/** The provider identity the production baseline side of one sample must bind, read from the runtime's own pre-check. */
export async function frozenProviderIdentity(input: {
  sources: ExperimentSources
  caller: SessionId
  sampleTaskId: string
  required: readonly string[]
  /** The candidate object this experiment prepares to promote: what its side's registry revision substitutes. */
  candidate: SkillContentIdentity
  where: string
}): Promise<FrozenProviderIdentity> {
  const { sources, caller, required, candidate, where } = input
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `${where} cannot fix the provider identity the production baseline runs under: this deployment's task runtime exposes no ` +
        'capability table (listCapabilities), so which rows, servers and skills the sample resolves to is not knowable before it runs — ' +
        'the experiment is refused rather than run under an identity nobody can compare against',
    )
  }
  const missing = [...new Set(required)].filter(name => table[name] === undefined).sort()
  if (missing.length > 0) {
    throw new Error(
      `${where} requires ${missing.length > 1 ? 'capabilities' : 'capability'} [${missing.join(', ')}], which the effective capability ` +
        'table does not hold — the runtime would refuse the replay for a capability gap after freezing; name rows the deployment has',
    )
  }
  const rows = [...new Set(required)].sort()
  let precheck: ProviderPrecheckView
  try {
    precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows)
  } catch (error) {
    throw new Error(
      `${where} cannot run the runtime's provider pre-check over rows [${rows.join(', ') || 'none'}] (${error instanceof Error ? error.message : String(error)}) — ` +
        'the provider identity the production baseline would bind cannot be fixed, so the experiment is refused before it runs',
    )
  }
  const refused = precheck.capabilities.flatMap(row =>
    row.skills
      .filter(skill => !skill.valid)
      .map(
        skill =>
          `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map(defect => `${defect.code}: ${defect.detail}`).join('; ')})`,
      ),
  )
  if (refused.length > 0) {
    throw new Error(
      `${where} resolves to providers the deployment cannot use, so the production baseline could not run under them:\n- ${refused.join('\n- ')}`,
    )
  }
  const skills: FrozenProviderSkill[] = precheck.capabilities
    .flatMap(row => row.skills)
    .filter(skill => skill.valid)
    .filter((skill, index, all) => all.findIndex(entry => entry.name === skill.name) === index)
    .map((skill): FrozenProviderSkill => {
      const role = skill.role
      if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
        throw new Error(
          `${where} resolved skill "${skill.name}" to an unknown role "${String(role)}"; the provider identity cannot be frozen`,
        )
      }
      if (typeof skill.contentDigest !== 'string' || skill.contentDigest.length === 0) {
        throw new Error(
          `${where} resolved skill "${skill.name}" without a content digest; the provider identity cannot be frozen`,
        )
      }
      return {
        name: skill.name,
        role,
        contractDigest: skill.contractDigest ?? null,
        contentDigest: skill.contentDigest,
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const mcpServers = [...new Set(rows.flatMap(row => table[row]?.mcpServers ?? []))].sort()
  const declaredPresets = new Set(
    rows.flatMap(row => {
      const preset = table[row]?.preset
      return preset === undefined ? [] : [preset]
    }),
  )
  if (declaredPresets.size > 1) {
    throw new Error(
      `${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(', ')}); one worker requires one preset, so the ` +
        'runtime would refuse the replay — split the rows or align the presets before freezing the experiment',
    )
  }
  return {
    capabilities: rows,
    registryRevision: precheck.revision,
    candidateRegistryRevision: candidateRegistryRevisionOf({ table, skills, candidate, where, mcpRegistry: sources.taskRuntime.listMcpServers?.() }),
    mcpServers,
    ...(mcpServers.length === 0 ? {} : { mcpBindings: mcpServerBindings(resolveCapabilities(rows, table, sources.taskRuntime.listMcpServers?.() ?? {}), sources.taskRuntime.listMcpServers?.() ?? {}) }),
    preset: declaredPresets.size === 0 ? null : [...declaredPresets][0]!,
    skills,
  }
}

/** One frozen side identity built from one pre-check's verdicts, refusing a deployment whose providers are unusable or whose roles are unknown. */
export function frozenCapabilitySideOf(input: {
  precheck: ProviderPrecheckView
  table: Readonly<Record<string, CapabilityConfig>>
  rows: readonly string[]
  where: string
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
}): FrozenCapabilitySide {
  const { precheck, table, rows, where } = input
  const refused = refusedProviderLines(precheck)
  if (refused.length > 0) {
    throw new Error(`${where} resolves to providers the deployment cannot use:\n- ${refused.join('\n- ')}`)
  }
  const skills: FrozenProviderSkill[] = precheck.capabilities
    .flatMap(row => row.skills)
    .filter(skill => skill.valid)
    .filter((skill, index, all) => all.findIndex(entry => entry.name === skill.name) === index)
    .map((skill): FrozenProviderSkill => {
      const role = skill.role
      if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
        throw new Error(
          `${where} resolved skill "${skill.name}" to an unknown role "${String(role)}"; the provider identity cannot be frozen`,
        )
      }
      if (typeof skill.contentDigest !== 'string' || skill.contentDigest.length === 0) {
        throw new Error(
          `${where} resolved skill "${skill.name}" without a content digest; the provider identity cannot be frozen`,
        )
      }
      return {
        name: skill.name,
        role,
        contractDigest: skill.contractDigest ?? null,
        contentDigest: skill.contentDigest,
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const declaredPresets = new Set(
    rows.flatMap(row => {
      const preset = table[row]?.preset
      return preset === undefined ? [] : [preset]
    }),
  )
  if (declaredPresets.size > 1) {
    throw new Error(
      `${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(', ')}); one worker requires one preset, so the ` +
        'runtime would refuse the replay — split the rows or align the presets before freezing the experiment',
    )
  }
  return {
    capabilities: [...rows],
    registryRevision: precheck.revision,
    mcpServers: [...new Set(rows.flatMap(row => table[row]?.mcpServers ?? []))].sort(),
    ...(rows.some(row => (table[row]?.mcpServers?.length ?? 0) > 0) ? { mcpBindings: mcpServerBindings(resolveCapabilities(rows, table, input.mcpRegistry ?? {}), input.mcpRegistry ?? {}) } : {}),
    preset: declaredPresets.size === 0 ? null : [...declaredPresets][0]!,
    skills,
  }
}

/** Every provider one pre-check refused, as a refusal line names it — the one rendering the freeze and the admission record share. */
export function refusedProviderLines(precheck: ProviderPrecheckView): string[] {
  return precheck.capabilities.flatMap(row => [
    ...(row.refusals ?? []).map(item => `${row.capability}: ${item.code}: ${item.detail}`),
    ...row.skills
      .filter(skill => !skill.valid)
      .map(
        skill =>
          `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map(defect => `${defect.code}: ${defect.detail}`).join('; ')})`,
      ),
  ])
}

/** What the two sides of one **capability** sample are frozen against (A6). */
export async function frozenCapabilitySample(input: {
  sources: ExperimentSources
  caller: SessionId
  sampleTaskId: string
  required: readonly string[]
  overlay: { capabilityOverrides: Record<string, CapabilityConfig>; extraSkillRoots: string[]; mcpServers?: Record<string, McpServerTemplate> }
}): Promise<{
  provider?: FrozenProviderIdentity
  admission?: FrozenSampleAdmission
  candidateProvider: FrozenCapabilitySide
}> {
  const { sources, caller, overlay, sampleTaskId } = input
  const where = `sample "${sampleTaskId}"`
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `${where} cannot fix the provider identities a capability experiment compares: this deployment's task runtime exposes no ` +
        'capability table (listCapabilities), so which rows, servers and skills each side resolves to is not knowable before it runs — ' +
        'the experiment is refused rather than run under identities nobody can compare against',
    )
  }
  const rows = [...new Set(input.required)].sort()
  const mcpRegistry = sources.taskRuntime.listMcpServers?.() ?? {}
  const overlayRegistry = { ...mcpRegistry, ...overlay.mcpServers }
  const overlayTable = { ...table, ...overlay.capabilityOverrides }
  const overlayManifest = resolveCapabilities(rows, overlayTable, overlayRegistry)
  if (overlayManifest.missing.length > 0) {
    throw new Error(
      `${where} requires ${overlayManifest.missing.length > 1 ? 'capabilities' : 'capability'} ` +
        `[${overlayManifest.missing.join(', ')}], which the candidate overlay does not resolve — the candidate side could not run the case ` +
        'the candidate is evaluated on, so the experiment is refused before it runs',
    )
  }
  if (sources.taskRuntime.precheckCapabilityTable === undefined) {
    throw new Error(
      `${where} cannot fix the provider identity the candidate overlay produces: this deployment's task runtime exposes no capability ` +
        'pre-check over a table the caller names, so what the candidate side would load cannot be frozen before it runs',
    )
  }
  const candidateProvider = frozenCapabilitySideOf({
    precheck: await sources.taskRuntime.precheckCapabilityTable({
      capabilities: rows,
      table: overlayTable,
      mcpRegistry: overlayRegistry,
      extraRoots: [...overlay.extraSkillRoots],
    }),
    table: overlayTable,
    mcpRegistry: overlayRegistry,
    rows,
    where: `${where} candidate side`,
  })
  const manifest = resolveCapabilities(rows, table)
  if (manifest.missing.length > 0) {
    // The production configuration cannot resolve the sample's rows at all: the whole sample is refused.
    return {
      admission: {
        source: 'capability-gap',
        required: rows,
        missing: [...manifest.missing].sort(),
        reason:
          `the effective capability table does not hold ${manifest.missing.map(name => JSON.stringify(name)).join(', ')}, so the ` +
          `production configuration cannot admit this sample (the runtime's own resolution reports a closure gap)`,
      },
      candidateProvider,
    }
  }
  const precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows)
  const refused = refusedProviderLines(precheck)
  if (refused.length > 0) {
    return {
      admission: {
        source: 'provider-refused',
        required: rows,
        missing: [],
        reason: `the production configuration resolves providers this deployment cannot use:\n- ${refused.join('\n- ')}`,
      },
      candidateProvider,
    }
  }
  const productionSide = frozenCapabilitySideOf({ precheck, table, rows, mcpRegistry, where: `${where} production side` })
  return {
    provider: {
      capabilities: rows,
      registryRevision: productionSide.registryRevision,
      // A capability sample's candidate side is the overlay, frozen as the production side's own revision.
      candidateRegistryRevision: productionSide.registryRevision,
      mcpServers: productionSide.mcpServers,
      ...(productionSide.mcpBindings === undefined ? {} : { mcpBindings: productionSide.mcpBindings }),
      preset: productionSide.preset,
      skills: productionSide.skills,
    },
    candidateProvider,
  }
}

/** The registry revision the **candidate** side of one sample must bind (K3): the composed table's own revision. */
export function candidateRegistryRevisionOf(input: {
  table: Readonly<Record<string, CapabilityConfig>>
  skills: readonly FrozenProviderSkill[]
  candidate: SkillContentIdentity
  where: string
  mcpRegistry?: Readonly<Record<string, McpServerTemplate>>
}): string {
  const { table, skills, candidate, where } = input
  if (!skills.some(skill => skill.name === candidate.name)) {
    throw new Error(
      `${where} resolves no provider named "${candidate.name}", the skill this experiment replaces — the candidate side's registry ` +
        "revision is the frozen provider list with that skill's declaration digest substituted, so a list that does not hold it cannot " +
        'say what the candidate side resolves to; the experiment is refused before it runs',
    )
  }
  const candidateDigest = candidate.contract?.contractDigest ?? null
  return registryRevision(
    table,
    skills.map(skill => ({
      name: skill.name,
      contractDigest: skill.name === candidate.name ? candidateDigest : skill.contractDigest,
    })),
    input.mcpRegistry,
  )
}

/** What one sample's two sides are frozen against: a skill sample's production identity, or a capability sample's production/overlay pair. */
export type SampleProviders = Pick<FrozenSample, 'provider' | 'admission' | 'candidateProvider'>

/** Freeze one sample from its store record: what the case is, the acceptance the replay mirrors into both sides, and the provider identities. */
export function frozenSampleOf(
  sample: ExperimentSampleSpec,
  task: TaskInstance,
  review: ReviewRecord,
  providers: SampleProviders,
  vocabulary: VerifierVocabularyView | undefined,
): FrozenSample {
  if (task.acceptanceCriteria.length === 0) {
    throw new Error(
      `sample "${sample.taskId}" carries no acceptance criteria; there is nothing for the two sides to be judged by`,
    )
  }
  const where = `sample "${sample.taskId}"`
  return {
    taskId: sample.taskId,
    role: sample.role,
    contractDigest: digestOf({
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredCapabilities: task.requestedCapabilities,
    }),
    criteria: task.acceptanceCriteria.map(criterion => frozenCriterionOf(criterion, where, vocabulary)),
    observed: {
      outcome: review.outcome === 'failed' ? 'failed' : 'verified',
      ...(review.runId === undefined ? {} : { runId: review.runId }),
    },
    ...providers,
  }
}

/** One content identity as a frozen block carries it: the whole object's identity, copied member by member (never shared). */
export function frozenIdentityOf(identity: SkillContentIdentity): SkillContentIdentity {
  return {
    name: identity.name,
    sha256: identity.sha256,
    ...(identity.contract === undefined
      ? {}
      : { contract: { sha256: identity.contract.sha256, contractDigest: identity.contract.contractDigest } }),
  }
}

/** Build the frozen identity block (§F.2), then check it against the schema the report reader uses. */
export function freezeExperiment(input: {
  proposalId: string
  spec: ExperimentSpec
  candidate?: SkillContentIdentity
  productionBaseline?: SkillContentIdentity
  capability?: FrozenCapability
  taskDefinition?: FrozenTaskDefinition
  sandbox: string
  snapshotDigest: string
  samples: FrozenSample[]
}): FrozenExperiment {
  const candidate = input.candidate
  const capability = input.capability
  const taskDefinition = input.taskDefinition
  const frozen: FrozenExperiment = {
    proposalId: input.proposalId,
    ...(input.spec.objective === undefined ? {} : { objective: input.spec.objective }),
    repetition: input.spec.repetition,
    ...(candidate === undefined ? {} : { candidate: frozenIdentityOf(candidate) }),
    ...(input.productionBaseline === undefined
      ? {}
      : { productionBaseline: frozenIdentityOf(input.productionBaseline) }),
    ...(capability === undefined
      ? {}
      : {
          capability: {
            row: {
              name: capability.row.name,
              entry: structuredClone(capability.row.entry),
              digest: capability.row.digest,
            },
            baseline:
              capability.baseline === null
                ? null
                : {
                    name: capability.baseline.name,
                    entry: structuredClone(capability.baseline.entry),
                    digest: capability.baseline.digest,
                  },
            sourceRefs: [...capability.sourceRefs],
            ...(capability.mcpServers === undefined ? {} : { mcpServers: structuredClone(capability.mcpServers) }),
          },
        }),
    ...(taskDefinition === undefined ? {} : { taskDefinition: structuredClone(taskDefinition) }),
    model: {
      provider: input.spec.model.provider,
      model: input.spec.model.model,
      ...(input.spec.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.spec.model.reasoningEffort }),
      ...(input.spec.model.maxTokens === undefined ? {} : { maxTokens: input.spec.model.maxTokens }),
      label: `${input.spec.model.provider}/${input.spec.model.model}`,
    },
    budget: { ...input.spec.budget },
    samples: input.samples,
    snapshot: { sourceDir: resolve(input.spec.snapshot.sourceDir), digest: input.snapshotDigest },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: {
      baseline: taskDefinition === undefined ? 'none — the baseline runs under the production configuration' : 'session template library: frozen baseline',
      candidate:
        taskDefinition !== undefined ? 'session template library: appended candidate, only new child contracts use it' : capability === undefined
          ? `extraSkillRoots: [${input.sandbox}/skills] — the complete candidate object: ` +
            `${
              candidate!.contract === undefined
                ? `the guidance object "${candidate!.name}" (SKILL.md alone, no sidecar)`
                : `the execution object "${candidate!.name}" (SKILL.md plus the derived SKILL.contract.json)`
            }, ` +
            "loaded whole through the runtime's own discovery"
          : `capabilityOverrides: { "${capability.row.name}": the prepared row }` +
            `${
              candidate === undefined
                ? ' and no extra skill root — a row-only candidate adds no object'
                : `, extraSkillRoots: [${input.sandbox}/skills] — the new execution object "${candidate.name}" ` +
                  "(SKILL.md plus the SKILL.contract.json beside it), loaded whole through the runtime's own discovery"
            }`,
    },
  }
  assertFrozenExperiment(frozen)
  return frozen
}

/** Criterion repair examples keep the existing outer oracle and its historical labels. */
export async function freezeCriterionRepair(definition: FrozenTaskDefinition, proposal: EvolutionProposal, snapshot: TaskSnapshot, samples: FrozenSample[], vocabulary: VerifierVocabularyView | undefined): Promise<void> {
  const repair = validateTaskDefinitionMutation(proposal.mutation).criterionRepair
  if (repair === undefined) return
  const parent = snapshot.tasks.find(task => task.taskId === samples[0]?.taskId)
  if (parent === undefined) throw new Error('evolution: criterion repair requires a parent oracle sample')
  if (independentOracleCriteria(parent).length === 0) throw new Error('evolution: criterion repair needs independent command acceptance on the source parent')
  if (vocabulary === undefined) throw new Error('evolution: criterion repair verifier vocabulary is unavailable')
  const guardVerifierVersions: Record<string, string> = {}
  for (const criterion of [...independentOracleCriteria(parent), ...definition.candidate.template.contract.acceptanceCriteria]) {
    const ref = criterion.verifierRef
    if (ref === undefined || vocabulary.versions[ref] === undefined) throw new Error('evolution: criterion guards must pin a registered versioned verifier')
    guardVerifierVersions[ref] = vocabulary.versions[ref]!
  }
  const examples = {} as NonNullable<FrozenTaskDefinition['criterionRepair']>
  for (const label of ['positive', 'negative'] as const) {
    const input = repair[label]
    const task = snapshot.tasks.find(item => item.taskId === input.taskId)
    const review = task === undefined ? undefined : latestReview(snapshot, task)
    const expected = label === 'positive' ? 'verified' : 'failed'
    if (task === undefined || task.status !== expected || review?.outcome !== expected || !review.criteria?.length || review.criteria.some(criterion => criterion.verdict === 'inconclusive') || (label === 'negative' && !review.criteria.some(criterion => criterion.verdict === 'fail'))) throw new Error(`evolution: ${label} criterion example must be an existing definitive ${expected} Run`)
    if (oracleContractDigest(task) !== oracleContractDigest(parent)) throw new Error('evolution: criterion examples must be judged by the fixed independent parent oracle')
    const judged = independentOracleCriteria(task).map(criterion => review.criteria!.find(item => item.criterionId === criterion.criterionId)?.verdict)
    if (judged.length === 0 || judged.some(verdict => verdict === undefined || verdict === 'inconclusive') || (label === 'positive' ? judged.some(verdict => verdict !== 'pass') : !judged.includes('fail'))) throw new Error('evolution: criterion example labels must come from the independent parent acceptance')
    examples[label] = { ...input, sourceDir: resolve(input.sourceDir), snapshotDigest: await directoryDigest(input.sourceDir), contractDigest: oracleContractDigest(task) }
  }
  if (examples.positive.snapshotDigest === examples.negative.snapshotDigest) throw new Error('evolution: positive and negative criterion examples require distinct existing inputs')
  definition.criterionRepair = examples
  definition.guardVerifierVersions = guardVerifierVersions
}
