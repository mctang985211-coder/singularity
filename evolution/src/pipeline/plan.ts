/**
 * Freezing one evaluation: both sides' revisions, the input, the model, the
 * original acceptance, the rules, the budget and the strategy. Everything a
 * reader needs to reproduce the comparison is fixed here, before anything runs,
 * and both sides go through the same one freeze function.
 */

import type { AcceptanceCriterion, ReviewRecord, TaskInstance } from '@dangosys/dsh-singularity-task'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig, McpServerTemplate } from '@dangosys/dsh-singularity-task-runtime'
import { digestOf, isHex64 } from '../shared.ts'
import { adapterFor } from '../draft/adapters.ts'
import { freezeInput } from '../evidence/snapshot.ts'
import type { InputSnapshot } from '../evidence/snapshot.ts'
import { refusedProviderLines } from './sources.ts'
import type { EvaluationSources, ProviderPrecheckView, VerifierVocabulary } from './sources.ts'
import type {
  AdmissionRefusal,
  EvaluationBudget,
  EvaluationPlan,
  EvaluationRules,
  FrozenCriterion,
  FrozenProviderSkill,
  MethodDraft,
  ModelSelection,
  OutcomeEvaluationPlan,
  PlannedSample,
  PlannedStrategy,
  RevisionView,
  SidePlan,
} from '../types.ts'

/** SHA-256 over a criterion's protected input identities, in path order — the acceptance input identity of one criterion. */
export function protectedInputsDigest(inputs: readonly { path: string; sha256: string }[]): string {
  const lines = inputs.map(input => `${input.path}\0${input.sha256}`).sort()
  return sha256Hex(lines.join('\n'))
}

/** One criterion's frozen judge identity, read from the criterion's verifier ref and the live vocabulary. */
export function frozenCriterionOf(
  criterion: AcceptanceCriterion,
  where: string,
  vocabulary: VerifierVocabulary | undefined,
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

/** The frozen scale every side's acceptance is mirrored from. */
export interface FreezeSideInput {
  readonly side: 'baseline' | 'candidate'
  readonly revision: RevisionView
  readonly required: readonly string[]
  /** The samples' frozen acceptance, mirrored into both sides unchanged. */
  readonly acceptance: readonly FrozenCriterion[]
  readonly where: string
  readonly model: ModelSelection
  readonly sources: EvaluationSources
  readonly mcpRegistry: Readonly<Record<string, McpServerTemplate>>
  /** The table the side resolves against; the candidate side's own rows override the active ones. */
  readonly table: Readonly<Record<string, CapabilityConfig>>
  /** The pre-check the side's identity is read from; absent means the freeze runs it itself. */
  readonly precheck?: ProviderPrecheckView
  /** True for a baseline side whose refusal is recorded on the samples instead of refusing the freeze. */
  readonly allowRefusal?: boolean
}

/** One side's provider reading: the rows it resolves, the registry revision and every provider it loads. */
function providerIdentityOf(input: {
  precheck: ProviderPrecheckView
  table: Readonly<Record<string, CapabilityConfig>>
  mcpRegistry: Readonly<Record<string, McpServerTemplate>>
  rows: readonly string[]
  where: string
}): Pick<SidePlan, 'capabilities' | 'registryRevision' | 'mcpServers' | 'preset' | 'skills'> {
  const refused = refusedProviderLines(input.precheck)
  if (refused.length > 0) {
    throw new Error(`${input.where} resolves to providers the deployment cannot use:\n- ${refused.join('\n- ')}`)
  }
  const skills: FrozenProviderSkill[] = input.precheck.capabilities
    .flatMap(row => row.skills)
    .filter(skill => skill.valid)
    .filter((skill, index, all) => all.findIndex(entry => entry.name === skill.name) === index)
    .map((skill): FrozenProviderSkill => {
      const role = skill.role
      if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
        throw new Error(`${input.where} resolved skill "${skill.name}" to an unknown role "${String(role)}"`)
      }
      if (typeof skill.contentDigest !== 'string' || skill.contentDigest.length === 0) {
        throw new Error(`${input.where} resolved skill "${skill.name}" without a content digest`)
      }
      return { name: skill.name, role, contractDigest: skill.contractDigest ?? null, contentDigest: skill.contentDigest }
    })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
  const presets = new Set(input.rows.flatMap(row => (input.table[row]?.preset === undefined ? [] : [input.table[row]!.preset!])))
  if (presets.size > 1) {
    throw new Error(`${input.where}'s rows declare conflicting presets (${[...presets].sort().join(', ')}); one worker requires one preset`)
  }
  const serverNames = [...new Set(input.rows.flatMap(row => input.table[row]?.mcpServers ?? []))].sort()
  const mcpServers = serverNames.map(serverName => {
    const template = input.mcpRegistry[serverName]
    if (template === undefined) {
      throw new Error(`${input.where} grants MCP server "${serverName}", which this deployment defines no template for`)
    }
    return { serverName, templateDigest: digestOf(template) }
  })
  return {
    capabilities: [...input.rows],
    registryRevision: input.precheck.revision,
    mcpServers,
    preset: presets.size === 0 ? null : [...presets][0]!,
    skills,
  }
}

/** The one side freeze: the identity a side must bind, read from the runtime's own pre-check. */
export async function freezeSide(input: FreezeSideInput): Promise<SidePlan> {
  const rows = [...new Set(input.required)].sort()
  const missing = rows.filter(row => input.table[row] === undefined)
  if (missing.length > 0 && input.allowRefusal !== true) {
    throw new Error(
      `${input.where} requires ${missing.length > 1 ? 'capabilities' : 'capability'} ${missing.map(row => JSON.stringify(row)).join(', ')}, ` +
        'which the side\'s table does not hold — the runtime would refuse a run under it',
    )
  }
  const precheck =
    input.precheck !== undefined
      ? input.precheck
      : input.side === 'baseline'
      ? await input.sources.runtime.capabilityProviderReport(input.sources.caller, rows)
      : await input.sources.runtime.precheckCapabilityTable({
          capabilities: rows,
          table: input.table,
          extraRoots: [input.revision.skillRoot],
          mcpRegistry: input.mcpRegistry,
        })
  return {
    side: input.side,
    revision: input.revision.ref,
    ...providerIdentityOf({
      precheck: input.allowRefusal === true ? { ...precheck, capabilities: precheck.capabilities.map(row => ({ ...row, refusals: [] })) } : precheck,
      table: input.table,
      mcpRegistry: input.mcpRegistry,
      rows,
      where: input.where,
    }),
    model: input.model,
    acceptance: [...input.acceptance],
  }
}

/** One sample's frozen identity, plus the refusal the runtime's own pre-check reported for its baseline side. */
export interface FrozenSamplePlan {
  readonly sample: PlannedSample
  readonly baselineAdmission?: AdmissionRefusal
}

/** What one evaluation is frozen from. */
export interface PlanInput {
  readonly draft: MethodDraft
  readonly samples: readonly { readonly taskId: string; readonly role: PlannedSample['role'] }[]
  readonly input: InputSnapshot
  readonly model: ModelSelection
  readonly rules: EvaluationRules
  readonly budget: EvaluationBudget
  readonly repetition: number
  readonly evaluation?: OutcomeEvaluationPlan
  readonly strategy?: PlannedStrategy
  readonly libraryId: string
}

/** The criteria a sample's own task carries, as the acceptance both sides are judged by. */
function acceptanceOf(task: TaskInstance, where: string): readonly AcceptanceCriterion[] {
  if (task.acceptanceCriteria.length === 0) {
    throw new Error(`${where} carries no acceptance criteria; there is nothing for the two sides to be judged by`)
  }
  return task.acceptanceCriteria
}

function requireTerminal(task: TaskInstance, where: string): 'verified' | 'failed' {
  if (task.status !== 'verified' && task.status !== 'failed') {
    throw new Error(`${where} is ${task.status}; only a terminal (verified or failed) sample can be evaluated`)
  }
  return task.status
}

function assertSampleRole(role: PlannedSample['role'], taskId: string, review: ReviewRecord | undefined): void {
  const required = role === 'observed-failure' ? 'failed' : 'verified'
  if (review === undefined) {
    throw new Error(`sample "${taskId}" has no review record on its latest run; there is no case to reproduce`)
  }
  if (review.outcome !== required) {
    throw new Error(`sample "${taskId}" is an ${role} but its latest review record is "${review.outcome}", not "${required}"`)
  }
}

/**
 * Freeze one evaluation plan. Both sides are read from frozen revision
 * directories, both go through the same `freezeSide`, and the sample's own
 * acceptance is mirrored into each side so a run cannot be judged by another
 * criterion set.
 */
export async function buildEvaluationPlan(sources: EvaluationSources, input: PlanInput): Promise<EvaluationPlan> {
  const draft = input.draft
  const baseline = await sources.runtime.activeRevision(sources.caller)
  if (baseline.ref.revisionId !== draft.baseRevision.revisionId) {
    throw new Error(
      `evolution: draft "${draft.draftId}" was written against revision "${draft.baseRevision.revisionId}", but the library's active revision ` +
        `is "${baseline.ref.revisionId}" — a candidate is evaluated against the revision it was written against`,
    )
  }
  if (baseline.ref.digest !== draft.baseRevision.digest) {
    throw new Error(
      `evolution: draft "${draft.draftId}" freezes baseline digest ${draft.baseRevision.digest}, but revision ` +
        `"${baseline.ref.revisionId}" reads ${baseline.ref.digest}`,
    )
  }
  const candidate = await sources.runtime.revision(sources.caller, draft.candidateRevision.revisionId)
  if (candidate.ref.digest !== draft.candidateRevision.digest) {
    throw new Error(
      `evolution: draft "${draft.draftId}" freezes candidate digest ${draft.candidateRevision.digest}, but revision ` +
        `"${candidate.ref.revisionId}" reads ${candidate.ref.digest} — the candidate moved since it was drafted`,
    )
  }

  const storeId = await sources.runtime.storeOfSession(sources.caller)
  const snapshot = await sources.tasks.openStore(storeId)
  const vocabulary: VerifierVocabulary | undefined = await sources.verifierVocabulary()
  const mcpRegistry = sources.runtime.mcpServers()
  const activeTable = await sources.runtime.capabilitiesForSession(sources.caller)
  const candidateTable = { ...activeTable, ...candidate.capabilityRows }

  const samples: PlannedSample[] = []
  for (const sample of input.samples) {
    const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
    if (task === undefined) throw new Error(`sample "${sample.taskId}" is absent from this graph's task store`)
    const where = `sample "${sample.taskId}"`
    requireTerminal(task, where)
    const review = snapshot.reviews.filter(item => item.taskId === task.taskId).at(-1)
    assertSampleRole(sample.role, sample.taskId, review)
    const criteria = acceptanceOf(task, where)
    samples.push({
      taskId: sample.taskId,
      role: sample.role,
      contractDigest: digestOf({
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        requiredCapabilities: task.requestedCapabilities,
      }),
      criteria: criteria.map(criterion => frozenCriterionOf(criterion, where, vocabulary)),
      observed: {
        outcome: requireTerminal(task, where),
        ...(review?.runId === undefined ? {} : { runId: review.runId }),
      },
    })
  }

  const frozenInput = await freezeInput(input.input)
  const required = [
    ...new Set(snapshot.tasks.filter(task => samples.some(sample => sample.taskId === task.taskId)).flatMap(task => task.requestedCapabilities)),
  ].sort()
  const acceptance = samples.flatMap(sample => sample.criteria)
  const baselinePrecheck = await sources.runtime.capabilityProviderReport(sources.caller, required)
  const missingRows = required.filter(row => activeTable[row] === undefined)
  const refused = refusedProviderLines(baselinePrecheck)
  const admission: AdmissionRefusal | undefined =
    missingRows.length > 0
      ? {
          source: 'capability-gap',
          required,
          missing: missingRows,
          reason:
            `the active revision's capability table does not hold ${missingRows.map(row => JSON.stringify(row)).join(', ')}, so the production ` +
            'configuration cannot admit this sample (the runtime\'s own resolution reports a closure gap)',
        }
      : refused.length > 0
        ? { source: 'provider-refused', required, missing: [], reason: `the production configuration resolves providers this deployment cannot use:\n- ${refused.join('\n- ')}` }
        : undefined
  const baselineSide = await freezeSide({
    side: 'baseline',
    revision: baseline,
    required,
    acceptance,
    where: 'the baseline side',
    model: input.model,
    sources,
    mcpRegistry,
    table: activeTable,
    precheck: baselinePrecheck,
    ...(admission === undefined ? {} : { allowRefusal: true }),
  })
  const candidateSide = await freezeSide({
    side: 'candidate',
    revision: candidate,
    // The candidate's own asset enters its side through the rows the adapter
    // names: a first skill comes in through its synthesized `method:` row, a
    // capability candidate through the row it installs.
    required: [...new Set([...required, ...adapterFor(draft.kind).sideDelta({ draft, baseline, candidate, required }).capabilities])].sort(),
    acceptance,
    where: 'the candidate side',
    model: input.model,
    sources,
    mcpRegistry,
    table: candidateTable,
  })
  const sides: EvaluationPlan['sides'] = { baseline: baselineSide, candidate: candidateSide }

  const plannedSamples: PlannedSample[] = samples.map(sample => (admission === undefined ? sample : { ...sample, admission }))
  const plan: EvaluationPlan = {
    planId: digestOf({ draftId: draft.draftId, candidate: candidate.ref, input: frozenInput.digest, samples: samples.map(sample => sample.taskId) }).slice(0, 16),
    draftId: draft.draftId,
    kind: draft.kind,
    libraryId: input.libraryId,
    sides,
    samples: plannedSamples,
    input: frozenInput,
    rules: input.rules,
    budget: { ...input.budget },
    repetition: input.repetition,
    ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
    overlay: {
      baseline: 'none — the baseline runs under the active revision',
      candidate: `trialCandidateRef: "${candidate.ref.revisionId}" — the candidate revision, loaded through the runtime's own binding`,
    },
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    schemaVersion: 'evaluation-plan@1',
  }
  return plan
}
