/** The experiment comparer and the schema validators the report read path runs.
 * @module dsh-singularity-evolution/replay/comparer */

import { isHex64, isRecord } from '../shared.ts'
import type {
  ExperimentAdmissionRefusal,
  ExperimentAdmissionSource,
  ExperimentBudget,
  ExperimentCost,
  ExperimentCriterionDetail,
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentSampleRole,
  ExperimentSampleVerdict,
  ExperimentSide,
  ExperimentSideComparison,
  ExperimentSideDetail,
  ExperimentVerdict,
  FrozenCapability,
  FrozenCapabilityRow,
  FrozenCapabilitySide,
  FrozenExperiment,
  FrozenProviderIdentity,
  FrozenProviderSkill,
  FrozenSample,
  FrozenSampleAdmission,
  ModelSelection,
  ReplaySideSummary,
  SkillContentIdentity,
} from './contract.ts'
import {
  compareReplaySides,
  EXPERIMENT_ADMISSION_SOURCES,
  EXPERIMENT_COMPARER_VERSION,
  EXPERIMENT_OUTCOMES,
  EXPERIMENT_SAMPLE_ROLES,
  EXPERIMENT_SAMPLE_VERDICTS,
  EXPERIMENT_SIDES,
  EXPERIMENT_VERDICTS,
  frozenDigestOf,
  OUTCOME_RANK,
} from './contract.ts'

/** One side as the v1 comparer reads it: the same outcome rank and criterion semantics, so v1's rules stay the rules. */
function asReplaySide(side: ExperimentSideComparison): ReplaySideSummary {
  return {
    // The comparer never reads the task identity (its answer is over outcomes
    // and criteria only); the report's identity checks are their own rule.
    taskId: '',
    // An interrupted side is unrankable exactly as a cancelled one is; the ranking treats both as no rank.
    outcome: side.outcome === 'interrupted' ? 'cancelled' : side.outcome,
    criteria: side.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      verdict: criterion.verdict,
      ...(criterion.command === undefined ? {} : { command: criterion.command }),
      ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
    })),
  }
}

/** One sample's mechanical verdict. An unrankable side (cancelled / interrupted) */
export function compareExperimentSides(
  role: ExperimentSampleRole,
  baseline: ExperimentSideComparison,
  candidate: ExperimentSideComparison,
): ExperimentSampleVerdict {
  // A6: the runtime's own admission refusal, before any outcome ranking. A
  // candidate that produced no run did not fix anything.
  if (candidate.outcome === 'not-admitted') return role === 'observed-failure' ? 'not-fixed' : 'inconclusive'
  if (baseline.outcome === 'not-admitted') {
    if (candidate.outcome !== 'verified') return role === 'observed-failure' ? 'both-failed' : 'inconclusive'
    return role === 'observed-failure' ? 'fixed' : 'maintained'
  }
  const relation = compareReplaySides(asReplaySide(baseline), asReplaySide(candidate)).relation
  if (relation === 'inconclusive') return 'inconclusive'
  const baselineRank = OUTCOME_RANK[baseline.outcome]
  const candidateRank = OUTCOME_RANK[candidate.outcome]
  if (role === 'observed-failure') {
    if (baselineRank === 0 && candidateRank === 0) return 'both-failed'
    return baselineRank === 0 && candidateRank === 1 ? 'fixed' : 'not-fixed'
  }
  // `verified` is the only comparable baseline: a shared failure is not a fix.
  if (baselineRank !== 1) return 'inconclusive'
  return relation === 'worse' ? 'regressed' : 'maintained'
}

/** The overall verdict over every sample, from the sample verdicts alone: any non-fixed sample makes the experiment not-fixed. */
export function overallExperimentVerdict(
  samples: readonly Pick<ExperimentSampleComparison, 'role' | 'verdict'>[],
): ExperimentVerdict {
  if (samples.some(sample => sample.verdict === 'inconclusive')) return 'inconclusive'
  if (samples.some(sample => sample.verdict === 'both-failed')) return 'both-failed'
  const failures = samples.filter(sample => sample.role === 'observed-failure')
  const fixedAll = failures.length > 0 && failures.every(sample => sample.verdict === 'fixed')
  const regressedAny = samples.some(sample => sample.verdict === 'regressed')
  if (!fixedAll) return regressedAny ? 'regressed' : 'not-fixed'
  return regressedAny ? 'fixed-with-regression' : 'fixed'
}

const EXPERIMENT_OUTCOME_SET = new Set<string>(EXPERIMENT_OUTCOMES)

const EXPERIMENT_CONDITION_VERDICTS = ['pass', 'fail', 'inconclusive'] as const

function assertIdentity(value: unknown, field: string): asserts value is SkillContentIdentity {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0 || !isHex64(value.sha256)) {
    throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256, contract? }`)
  }
  if (value.contract !== undefined) {
    const contract = value.contract
    if (!isRecord(contract) || !isHex64(contract.sha256) || !isHex64(contract.contractDigest)) {
      throw new Error(
        `evolution: experiment report ${field}.contract must be { sha256, contractDigest } with both a SHA-256 hex — a frozen object ` +
          'with an execution sidecar names that file by its exact bytes and by the canonical declaration identity together',
      )
    }
  }
}

/** Validate a frozen identity block: every member present and shaped, the digests consistent. */
export function assertFrozenExperiment(value: unknown): asserts value is FrozenExperiment {
  if (!isRecord(value)) throw new Error('evolution: experiment report frozen must be an object')
  if (typeof value.proposalId !== 'string' || value.proposalId.length === 0) {
    throw new Error('evolution: experiment report frozen.proposalId must be a non-empty string')
  }
  if (!Number.isInteger(value.repetition) || (value.repetition as number) < 0) {
    throw new Error('evolution: experiment report frozen.repetition must be a non-negative integer')
  }
  if (value.candidate === undefined && value.capability === undefined) {
    throw new Error(
      'evolution: experiment report frozen must name the candidate it evaluates — a skill object identity (frozen.candidate) or a ' +
        'capability candidate (frozen.capability, with frozen.candidate only when the candidate carries a new skill); a block that ' +
        'names neither is not an experiment this build can re-read',
    )
  }
  if (value.candidate !== undefined) assertIdentity(value.candidate, 'frozen.candidate')
  if (value.capability !== undefined) assertFrozenCapability(value.capability)
  if (value.productionBaseline !== undefined) {
    if (value.candidate === undefined) {
      throw new Error(
        'evolution: experiment report frozen.productionBaseline names the object a skill candidate replaces, but this block carries no ' +
          "frozen.candidate — a capability candidate's production baseline is the registry row it moves (frozen.capability.baseline), " +
          'never a skill object it does not touch',
      )
    }
    assertIdentity(value.productionBaseline, 'frozen.productionBaseline')
  }
  assertModelSelection(value.model, 'frozen.model')
  assertExperimentBudget(value.budget, 'frozen.budget')
  if (
    !isRecord(value.snapshot) ||
    typeof value.snapshot.sourceDir !== 'string' ||
    value.snapshot.sourceDir.length === 0 ||
    !isHex64(value.snapshot.digest)
  ) {
    throw new Error(
      'evolution: experiment report frozen.snapshot must be { sourceDir, digest } with a SHA-256 content digest',
    )
  }
  if (value.comparerVersion !== EXPERIMENT_COMPARER_VERSION) {
    throw new Error(
      `evolution: experiment report frozen.comparerVersion must be "${EXPERIMENT_COMPARER_VERSION}" — ` +
        `got ${JSON.stringify(value.comparerVersion)}; a report this build cannot re-derive is refused, not trusted`,
    )
  }
  if (
    !isRecord(value.overlay) ||
    typeof value.overlay.baseline !== 'string' ||
    value.overlay.baseline.length === 0 ||
    typeof value.overlay.candidate !== 'string' ||
    value.overlay.candidate.length === 0
  ) {
    throw new Error('evolution: experiment report frozen.overlay must name what each side ran under')
  }
  if (!Array.isArray(value.samples) || value.samples.length === 0) {
    throw new Error('evolution: experiment report frozen.samples must be a non-empty array')
  }
  const taskIds = new Set<string>()
  value.samples.forEach((sample, index) =>
    assertFrozenSample(sample, `frozen.samples[${index}]`, taskIds, value.capability !== undefined),
  )
  const roles = value.samples.map(sample => (sample as FrozenSample).role)
  if (!roles.includes('observed-failure')) {
    throw new Error(
      'evolution: an experiment frozen block needs at least one observed-failure sample (§F.2: the target failure must be reproduced)',
    )
  }
  if (!roles.includes('holdout')) {
    throw new Error(
      'evolution: an experiment frozen block needs at least one holdout sample (§F.2: the candidate must not be selected on every case)',
    )
  }
}

/** One capability candidate's frozen identity (A6): the row, the row it replaces, and the gap it came from. */
function assertFrozenCapability(value: unknown): asserts value is FrozenCapability {
  if (!isRecord(value)) {
    throw new Error(
      'evolution: experiment report frozen.capability must be the capability candidate { row, baseline, sourceRefs } — the whole row ' +
        "the candidate installs, the registry row it moves, and the proposal's source refs",
    )
  }
  assertFrozenCapabilityRow(value.row, 'frozen.capability.row')
  if (value.baseline !== null) assertFrozenCapabilityRow(value.baseline, 'frozen.capability.baseline')
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
    throw new Error(
      'evolution: experiment report frozen.capability.sourceRefs must be an array of non-empty source refs',
    )
  }
}

function assertFrozenCapabilityRow(value: unknown, field: string): asserts value is FrozenCapabilityRow {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !isHex64(value.digest) ||
    !isRecord(value.entry) ||
    !Array.isArray(value.entry.skills) ||
    (value.entry.skills as unknown[]).some(skill => typeof skill !== 'string' || skill.length === 0)
  ) {
    throw new Error(
      `evolution: experiment report ${field} must be one whole capability row { name, entry, digest } — the name, the row itself ` +
        '(at least its skills) and the SHA-256 of its canonical bytes',
    )
  }
}

/** One side's frozen provider identity of a capability sample (A6). */
function assertFrozenCapabilitySide(value: unknown, field: string): asserts value is FrozenCapabilitySide {
  if (
    !isRecord(value) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.some(item => typeof item !== 'string' || item.length === 0) ||
    typeof value.registryRevision !== 'string' ||
    value.registryRevision.length === 0 ||
    !Array.isArray(value.mcpServers) ||
    value.mcpServers.some(item => typeof item !== 'string' || item.length === 0) ||
    (value.preset !== null && (typeof value.preset !== 'string' || value.preset.length === 0)) ||
    !Array.isArray(value.skills)
  ) {
    throw new Error(
      `evolution: experiment report ${field} must be one capability side's frozen identity ` +
        '(capabilities, registryRevision, mcpServers, preset, skills)',
    )
  }
  const names = new Set<string>()
  for (const skill of value.skills) {
    assertFrozenProviderSkill(skill, `${field}.skills[${(skill as { name?: unknown }).name as string}]`)
    if (names.has((skill as FrozenProviderSkill).name)) {
      throw new Error(`evolution: experiment report ${field} repeats skill "${(skill as FrozenProviderSkill).name}"`)
    }
    names.add((skill as FrozenProviderSkill).name)
  }
}

/** One sample's frozen production refusal (A6). */
function assertFrozenSampleAdmission(value: unknown, field: string): asserts value is FrozenSampleAdmission {
  if (
    !isRecord(value) ||
    !EXPERIMENT_ADMISSION_SOURCES.includes(value.source as ExperimentAdmissionSource) ||
    !Array.isArray(value.required) ||
    value.required.some(item => typeof item !== 'string' || item.length === 0) ||
    !Array.isArray(value.missing) ||
    value.missing.some(item => typeof item !== 'string' || item.length === 0) ||
    typeof value.reason !== 'string' ||
    value.reason.length === 0
  ) {
    throw new Error(
      `evolution: experiment report ${field} must record the production configuration's own refusal ` +
        `(source: one of ${EXPERIMENT_ADMISSION_SOURCES.join(' / ')}, required, missing, reason)`,
    )
  }
}

function assertExperimentBudget(value: unknown, field: string): asserts value is ExperimentBudget {
  if (!isRecord(value)) throw new Error(`evolution: ${field} must be an object (the whole experiment's token ceiling)`)
  for (const key of Object.keys(value)) {
    if (key === 'wallTimeMs') {
      throw new Error(
        `evolution: ${field}.wallTimeMs is removed — an experiment has no wall-clock ceiling; freeze an optional ` +
          "`maxTokens` total instead, and bound a run's time with the deployment's own limits (rootBudget.wallTimeMs, " +
          'or the per-run Config.budget.wallTimeMs). A budget this build cannot enforce is refused rather than ignored',
      )
    }
    if (key !== 'maxTokens' && key !== 'note') {
      throw new Error(`evolution: ${field} has unknown key "${key}"`)
    }
  }
  const member = value.maxTokens
  if (member !== undefined && (typeof member !== 'number' || !Number.isFinite(member) || member < 0)) {
    throw new Error(`evolution: ${field}.maxTokens must be a non-negative number`)
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length === 0)) {
    throw new Error(`evolution: ${field}.note must be a non-empty string`)
  }
}

function assertModelSelection(value: unknown, field: string): asserts value is ModelSelection {
  if (!isRecord(value)) {
    throw new Error(
      `evolution: experiment report ${field} must be the structured model selection { provider, model } this build froze — ` +
        'a record that froze a bare string cannot name the route its runs took, so it is refused rather than read as one',
    )
  }
  for (const key of Object.keys(value)) {
    if (!['provider', 'model', 'reasoningEffort', 'maxTokens', 'label'].includes(key)) {
      throw new Error(`evolution: experiment report ${field} has unknown key "${key}"`)
    }
  }
  if (typeof value.provider !== 'string' || value.provider.length === 0) {
    throw new Error(`evolution: experiment report ${field}.provider must be the provider route the runs go through`)
  }
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new Error(`evolution: experiment report ${field}.model must be the model id the runs go through`)
  }
  if (
    value.reasoningEffort !== undefined &&
    (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length === 0)
  ) {
    throw new Error(`evolution: experiment report ${field}.reasoningEffort must be a non-empty string when present`)
  }
  if (
    value.maxTokens !== undefined &&
    (typeof value.maxTokens !== 'number' || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0)
  ) {
    throw new Error(`evolution: experiment report ${field}.maxTokens must be a positive number when present`)
  }
  if (value.label !== `${value.provider}/${value.model}`) {
    throw new Error(
      `evolution: experiment report ${field}.label must be the derived display form "${value.provider}/${value.model}" — ` +
        'the label is a rendering of the structured members, never an identity of its own',
    )
  }
}

function assertFrozenProviderSkill(value: unknown, field: string): asserts value is FrozenProviderSkill {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !['execution-provider', 'knowledge', 'guidance'].includes(value.role as string) ||
    (value.contractDigest !== null && !isHex64(value.contractDigest)) ||
    !isHex64(value.contentDigest)
  ) {
    throw new Error(
      `evolution: experiment report ${field} must be a resolved skill identity { name, role, contractDigest, contentDigest }`,
    )
  }
}

function assertFrozenProviderIdentity(value: unknown, field: string): asserts value is FrozenProviderIdentity {
  if (!isRecord(value)) {
    throw new Error(
      `evolution: experiment report ${field} must be the frozen provider identity of the sample's production baseline ` +
        '(capabilities, registryRevision, mcpServers, preset, skills) — a sample frozen before that identity was recorded cannot ' +
        'constrain what its sides really ran against',
    )
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some(item => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`evolution: experiment report ${field}.capabilities must be an array of capability names`)
  }
  if (typeof value.registryRevision !== 'string' || value.registryRevision.length === 0) {
    throw new Error(
      `evolution: experiment report ${field}.registryRevision must be the revision the runtime's pre-check produced`,
    )
  }
  if (typeof value.candidateRegistryRevision !== 'string' || value.candidateRegistryRevision.length === 0) {
    throw new Error(
      `evolution: experiment report ${field}.candidateRegistryRevision must be the revision the candidate side's run has to bind ` +
        "— the production revision over the same rows with the improved skill's own declaration digest substituted; a block that " +
        'records only the production value cannot say what the candidate side was compared against',
    )
  }
  if (
    !Array.isArray(value.mcpServers) ||
    value.mcpServers.some(item => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`evolution: experiment report ${field}.mcpServers must be an array of MCP server names`)
  }
  if (value.preset !== null && (typeof value.preset !== 'string' || value.preset.length === 0)) {
    throw new Error(
      `evolution: experiment report ${field}.preset must be the declared preset or null (the deployment default governs)`,
    )
  }
  if (!Array.isArray(value.skills)) throw new Error(`evolution: experiment report ${field}.skills must be an array`)
  const names = new Set<string>()
  for (const skill of value.skills) {
    assertFrozenProviderSkill(skill, `${field}.skills[${(skill as { name?: unknown }).name as string}]`)
    if (names.has((skill as FrozenProviderSkill).name)) {
      throw new Error(`evolution: experiment report ${field} repeats skill "${(skill as FrozenProviderSkill).name}"`)
    }
    names.add((skill as FrozenProviderSkill).name)
  }
}

function assertFrozenSample(
  value: unknown,
  field: string,
  seen: Set<string>,
  capability: boolean,
): asserts value is FrozenSample {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: experiment report ${field} must carry a taskId`)
  }
  if (seen.has(value.taskId)) throw new Error(`evolution: experiment report ${field} repeats task "${value.taskId}"`)
  seen.add(value.taskId)
  if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role as ExperimentSampleRole)) {
    throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
  }
  if (!isHex64(value.contractDigest))
    throw new Error(`evolution: experiment report ${field}.contractDigest must be a SHA-256 hex`)
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new Error(
      `evolution: experiment report ${field}.criteria must be a non-empty array (the acceptance the replay mirrors)`,
    )
  }
  const criterionIds = new Set<string>()
  for (const criterion of value.criteria) {
    if (
      !isRecord(criterion) ||
      typeof criterion.criterionId !== 'string' ||
      criterion.criterionId.length === 0 ||
      criterionIds.has(criterion.criterionId) ||
      typeof criterion.verificationMode !== 'string' ||
      criterion.verificationMode.length === 0 ||
      (criterion.command !== undefined && typeof criterion.command !== 'string') ||
      !isHex64(criterion.protectedInputsDigest)
    ) {
      throw new Error(`evolution: experiment report ${field} has an invalid or duplicate frozen criterion`)
    }
    if (typeof criterion.verifierRef !== 'string' || criterion.verifierRef.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} criterion "${criterion.criterionId}" must pin the judge it was frozen with — ` +
          'a criterion whose judge nobody can name cannot be recalled against the instance that decides it',
      )
    }
    if (typeof criterion.verifierVersion !== 'string' || criterion.verifierVersion.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} criterion "${criterion.criterionId}" must carry the version of the pinned judge it ` +
          'was frozen with — a verdict belongs to the instance that judged it',
      )
    }
    if (typeof criterion.verifierAnchor !== 'string' || criterion.verifierAnchor.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} criterion "${criterion.criterionId}" must name how its judge identity is anchored`,
      )
    }
    criterionIds.add(criterion.criterionId)
  }
  if (
    !isRecord(value.observed) ||
    (value.observed.outcome !== 'verified' && value.observed.outcome !== 'failed') ||
    (value.observed.runId !== undefined &&
      (typeof value.observed.runId !== 'string' || value.observed.runId.length === 0))
  ) {
    throw new Error(
      `evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`,
    )
  }
  if (!capability) {
    for (const member of ['admission', 'candidateProvider'] as const) {
      if (value[member] !== undefined) {
        throw new Error(
          `evolution: experiment report ${field}.${member} belongs to a capability experiment (A6), and this frozen block carries no ` +
            "frozen.capability — a skill experiment's samples bind one production identity and nothing else",
        )
      }
    }
  }
  if (value.admission !== undefined) {
    assertFrozenSampleAdmission(value.admission, `${field}.admission`)
    if (value.provider !== undefined) {
      throw new Error(
        `evolution: experiment report ${field} records both a production provider identity and the refusal that stands in its place — ` +
          'a baseline side either runs under the production configuration or is refused at admission, never both',
      )
    }
  }
  if (value.provider !== undefined) assertFrozenProviderIdentity(value.provider, `${field}.provider`)
  if (capability) {
    if (value.candidateProvider === undefined) {
      throw new Error(
        `evolution: experiment report ${field} is a capability sample and must record the overlay identity its candidate side binds ` +
          '(candidateProvider: capabilities, registryRevision, mcpServers, preset, skills) — a side whose configuration nobody froze ' +
          'cannot be compared against anything',
      )
    }
    assertFrozenCapabilitySide(value.candidateProvider, `${field}.candidateProvider`)
    if (value.admission === undefined && value.provider === undefined) {
      throw new Error(
        `evolution: experiment report ${field} records neither the production provider identity nor the admission refusal that stands ` +
          'in its place — what its baseline side is or why it could not run must be frozen before the experiment runs',
      )
    }
    return
  }
  if (value.provider === undefined) {
    throw new Error(
      `evolution: experiment report ${field}.provider must be the frozen provider identity of the sample's production baseline ` +
        '(capabilities, registryRevision, candidateRegistryRevision, mcpServers, preset, skills) — a sample frozen before that identity ' +
        'was recorded cannot constrain what its sides really ran against',
    )
  }
}

function assertCriterionDetail(value: unknown, field: string): asserts value is ExperimentCriterionDetail {
  if (
    !isRecord(value) ||
    typeof value.criterionId !== 'string' ||
    value.criterionId.length === 0 ||
    !EXPERIMENT_CONDITION_VERDICTS.includes(value.verdict as 'pass' | 'fail' | 'inconclusive') ||
    (value.verifierId !== undefined && (typeof value.verifierId !== 'string' || value.verifierId.length === 0)) ||
    (value.verifierVersion !== undefined &&
      (typeof value.verifierVersion !== 'string' || value.verifierVersion.length === 0)) ||
    (value.command !== undefined && typeof value.command !== 'string') ||
    (value.exitCode !== undefined && typeof value.exitCode !== 'number')
  ) {
    throw new Error(`evolution: experiment report ${field} has an invalid criterion verdict`)
  }
}

function assertCost(value: unknown, field: string): asserts value is ExperimentCost {
  if (!isRecord(value)) throw new Error(`evolution: experiment report ${field} must be a cost object`)
  if (value.status === 'unknown') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      throw new Error(`evolution: experiment report ${field} must say why the cost is unknown`)
    }
    return
  }
  if (value.status !== 'reported' || !isRecord(value.metrics)) {
    throw new Error(
      `evolution: experiment report ${field} must be { status: "reported", metrics } or { status: "unknown", reason }`,
    )
  }
}

function assertSideDetail(value: unknown, field: string, sample: FrozenSample): asserts value is ExperimentSideDetail {
  if (!isRecord(value)) throw new Error(`evolution: experiment report ${field} must be an object`)
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.taskId must be a non-empty string when present`)
  }
  if (value.taskId === sample.taskId) {
    throw new Error(
      `evolution: experiment report ${field} names the sample's own historical task "${sample.taskId}" as a run of this experiment — ` +
        'the historical task is the case, not a baseline; both sides must be new replayed tasks',
    )
  }
  if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role as ExperimentSampleRole)) {
    throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
  }
  if (!EXPERIMENT_SIDES.includes(value.side as ExperimentSide)) {
    throw new Error(`evolution: experiment report ${field}.side must be one of ${EXPERIMENT_SIDES.join(' / ')}`)
  }
  if (!EXPERIMENT_OUTCOME_SET.has(value.outcome as string)) {
    throw new Error(`evolution: experiment report ${field}.outcome must be one of ${EXPERIMENT_OUTCOMES.join(' / ')}`)
  }
  for (const key of ['runId', 'reviewRef'] as const) {
    const member = value[key]
    if (member !== undefined && (typeof member !== 'string' || member.length === 0)) {
      throw new Error(`evolution: experiment report ${field}.${key} must be a non-empty string when present`)
    }
  }
  if (sample.observed.runId !== undefined && value.runId === sample.observed.runId) {
    throw new Error(
      `evolution: experiment report ${field} cites run "${sample.observed.runId}", the sample's own historical run — ` +
        "the historical champion locates the case and is never this experiment's baseline; both sides must be new runs",
    )
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)
  ) {
    throw new Error(`evolution: experiment report ${field}.evidenceRefs must be an array of non-empty evidence ids`)
  }
  if (typeof value.workspace !== 'string' || value.workspace.length === 0) {
    throw new Error(`evolution: experiment report ${field}.workspace must be the directory the run went through`)
  }
  if (value.initialDigest !== undefined && !isHex64(value.initialDigest)) {
    throw new Error(
      `evolution: experiment report ${field}.initialDigest must be the SHA-256 of the frozen workspace content`,
    )
  }
  if (!Array.isArray(value.criteria)) throw new Error(`evolution: experiment report ${field}.criteria must be an array`)
  const ids = new Set<string>()
  for (const criterion of value.criteria) {
    assertCriterionDetail(
      criterion,
      `${field}.criteria[${(criterion as { criterionId?: unknown }).criterionId as string}]`,
    )
    if (ids.has((criterion as ExperimentCriterionDetail).criterionId)) {
      throw new Error(`evolution: experiment report ${field} has a duplicate criterion`)
    }
    ids.add((criterion as ExperimentCriterionDetail).criterionId)
  }
  assertCost(value.cost, `${field}.cost`)
  if (value.outcome === 'not-admitted') {
    // A6: the runtime refused this side before a run existed. The record is the
    // refusal and nothing else — no Task, no Run, no evidence, no criteria.
    if (value.side !== 'baseline') {
      throw new Error(
        `evolution: experiment report ${field} records the candidate side as not-admitted — a candidate the runtime will not admit ` +
          'produced no run, so it fixed nothing and cannot stand as a fix; only a baseline side may be not-admitted',
      )
    }
    if (sample.admission === undefined) {
      throw new Error(
        `evolution: experiment report ${field} is not-admitted, but the frozen sample records no production refusal to check it ` +
          'against — a side that never ran needs the admission identity frozen before the experiment',
      )
    }
    assertAdmissionRecord(value.admission, field)
    if (value.taskId !== undefined || value.runId !== undefined || value.reviewRef !== undefined) {
      throw new Error(
        `evolution: experiment report ${field} is not-admitted and cites a task, a run or a review — a refused side produced no run, ` +
          'and a failure run invented in its place is not evidence',
      )
    }
    if (value.evidenceRefs.length > 0 || ids.size > 0) {
      throw new Error(
        `evolution: experiment report ${field} is not-admitted and cites evidence or criteria — no run produced any`,
      )
    }
    return
  }
  if (value.admission !== undefined) {
    throw new Error(
      `evolution: experiment report ${field} carries an admission refusal but settled as "${String(value.outcome)}"`,
    )
  }
  if (value.outcome === 'interrupted') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} is interrupted and must carry the reason it has no terminal run`,
      )
    }
    return
  }
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: experiment report ${field} settled a run and must name the replayed task it created`)
  }
  if (value.initialDigest === undefined) {
    throw new Error(`evolution: experiment report ${field} settled a run and must carry the workspace's initial digest`)
  }
  if (value.outcome === 'verified' && ids.size === 0) {
    throw new Error(`evolution: experiment report ${field} verified outcome needs criterion evidence`)
  }
}

/** The runtime's own refusal, as the report carries it for a `not-admitted` side (A6). */
export function assertAdmissionRecord(value: unknown, field: string): asserts value is ExperimentAdmissionRefusal {
  if (
    !isRecord(value) ||
    !EXPERIMENT_ADMISSION_SOURCES.includes(value.source as ExperimentAdmissionSource) ||
    typeof value.proposalId !== 'string' ||
    value.proposalId.length === 0 ||
    !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.some(ref => typeof ref !== 'string' || ref.length === 0) ||
    !Array.isArray(value.required) ||
    value.required.some(item => typeof item !== 'string' || item.length === 0) ||
    !Array.isArray(value.missing) ||
    value.missing.some(item => typeof item !== 'string' || item.length === 0) ||
    typeof value.reason !== 'string' ||
    value.reason.length === 0
  ) {
    throw new Error(
      `evolution: experiment report ${field}.admission must record which admission rule refused the side (one of ` +
        `${EXPERIMENT_ADMISSION_SOURCES.join(' / ')}), the proposal and source refs it belongs to, the required rows, the rows the table ` +
        "did not hold and the runtime's own refusal text",
    )
  }
}

/** Validate a v3 report against itself — and further than a shape check: every cited identity must recompute to the same digest. */
export function assertExperimentReport(report: unknown): asserts report is ExperimentReport {
  if (!isRecord(report)) throw new Error('evolution: experiment report must be an object')
  if (report.formatVersion !== 3) {
    throw new Error(
      `evolution: experiment report formatVersion must be 3 — got ${JSON.stringify(report.formatVersion)}; this build writes and ` +
        "reads one report schema, the one whose frozen block carries the improved skill's complete content identity and both sides' " +
        'provider identities, and a report from another build is refused by name rather than read with fields it does not have',
    )
  }
  if (typeof report.proposalId !== 'string' || report.proposalId.length === 0) {
    throw new Error('evolution: experiment report.proposalId must be a non-empty string')
  }
  if (typeof report.experimentId !== 'string' || report.experimentId.length === 0) {
    throw new Error('evolution: experiment report.experimentId must be a non-empty string')
  }
  if (typeof report.at !== 'string' || report.at.length === 0) {
    throw new Error('evolution: experiment report.at must be a non-empty string')
  }
  assertFrozenExperiment(report.frozen)
  const frozen = report.frozen as FrozenExperiment
  if (frozen.proposalId !== report.proposalId) {
    throw new Error(
      `evolution: experiment report frozen.proposalId "${frozen.proposalId}" does not match "${report.proposalId}"`,
    )
  }
  if (report.frozenDigest !== frozenDigestOf(frozen)) {
    throw new Error('evolution: experiment report frozenDigest does not match its frozen identity block')
  }
  if (!Array.isArray(report.samples)) throw new Error('evolution: experiment report.samples must be an array')
  const reportSamples = report.samples as unknown[]
  const byTask = new Map(frozen.samples.map(sample => [sample.taskId, sample]))
  if (reportSamples.length !== frozen.samples.length) {
    throw new Error('evolution: experiment report must carry exactly one comparison per frozen sample')
  }
  const seen = new Set<string>()
  reportSamples.forEach((entry, index) => {
    const field = `samples[${index}]`
    if (!isRecord(entry)) throw new Error(`evolution: experiment report ${field} must be an object`)
    const taskId = entry.taskId
    const frozenSample = typeof taskId === 'string' ? byTask.get(taskId) : undefined
    if (frozenSample === undefined) {
      throw new Error(`evolution: experiment report ${field}.taskId is not one of the frozen samples`)
    }
    if (seen.has(frozenSample.taskId))
      throw new Error(`evolution: experiment report ${field} repeats sample "${frozenSample.taskId}"`)
    seen.add(frozenSample.taskId)
    if (entry.role !== frozenSample.role) {
      throw new Error(`evolution: experiment report ${field}.role does not match the frozen sample's role`)
    }
    if (!EXPERIMENT_SAMPLE_VERDICTS.includes(entry.verdict as ExperimentSampleVerdict)) {
      throw new Error(
        `evolution: experiment report ${field}.verdict must be one of ${EXPERIMENT_SAMPLE_VERDICTS.join(' / ')}`,
      )
    }
    assertSideDetail(entry.baseline, `${field}.baseline`, frozenSample)
    assertSideDetail(entry.candidate, `${field}.candidate`, frozenSample)
    const baseline = entry.baseline as ExperimentSideDetail
    const candidate = entry.candidate as ExperimentSideDetail
    if (baseline.side !== 'baseline' || candidate.side !== 'candidate') {
      throw new Error(`evolution: experiment report ${field} must carry one baseline and one candidate side`)
    }
    if (baseline.role !== frozenSample.role || candidate.role !== frozenSample.role) {
      throw new Error(`evolution: experiment report ${field} sides must carry the sample's role`)
    }
    if (baseline.workspace === candidate.workspace) {
      throw new Error(
        `evolution: experiment report ${field} sides share one workspace "${baseline.workspace}" — two sides need two workspaces`,
      )
    }
    const computed = compareExperimentSides(frozenSample.role, baseline, candidate)
    if (entry.verdict !== computed) {
      throw new Error(
        `evolution: experiment report ${field}.verdict "${String(entry.verdict)}" does not match its own evidence ("${computed}")`,
      )
    }
  })
  const computedVerdict = overallExperimentVerdict(reportSamples as ExperimentSampleComparison[])
  if (report.verdict !== computedVerdict) {
    throw new Error(
      `evolution: experiment report.verdict "${String(report.verdict)}" does not match its samples ("${computedVerdict}")`,
    )
  }
  if (!EXPERIMENT_VERDICTS.includes(report.verdict as ExperimentVerdict)) {
    throw new Error(`evolution: experiment report.verdict must be one of ${EXPERIMENT_VERDICTS.join(' / ')}`)
  }
}
