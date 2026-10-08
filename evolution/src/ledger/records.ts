/**
 * Record payload validation for the method ledger's own lines, shared by the
 * write door and the fold. The v5 protocol reads and writes `formatVersion: 5`
 * only: a hand-filled version set, six gate answers, an always-true mechanical
 * flag and a derivable champion are refused rather than ignored.
 *
 * @module dsh-singularity-evolution/ledger/records
 */

import { assertOnlyKeys, isHex64, isRecord } from '../shared.ts'

import type {
  AdmissionRefusal,
  CandidateRevision,
  CostReading,
  EvaluationPlan,
  EvaluationRules,
  EvaluationVerdict,
  ExecutionReceiptRef,
  MethodAssetKind,
  MethodDraft,
  RevisionRef,
  SidePlan,
  TrialCriterion,
  TrialOutcome,
  TrialResult,
} from '../types.ts'

/** The one ledger protocol the new path writes. */
export const METHOD_LEDGER_FORMAT_VERSION = 5

const KINDS: readonly string[] = ['draft', 'plan', 'trial', 'evaluation', 'discard', 'published', 'rolledback']

/** The members each v5 kind declares, and no others. */
const KIND_KEYS: Readonly<Record<string, readonly string[]>> = {
  draft: ['draftId', 'libraryId', 'assetKind', 'identity', 'baseRevision', 'candidateRevision', 'rationale', 'sourceRefs', 'actor', 'at'],
  plan: ['draftId', 'evaluationId', 'plan', 'planDigest', 'report', 'storeId', 'actor', 'at'],
  trial: ['draftId', 'evaluationId', 'trial'],
  evaluation: ['draftId', 'evaluationId', 'report', 'reportDigest', 'verdict', 'scoreDigest', 'actor', 'at'],
  discard: ['draftId', 'reason', 'actor', 'at'],
  published: ['draftId', 'revisionId', 'supersededRevisionId', 'intentId', 'approvalRef', 'actor', 'at'],
  rolledback: ['draftId', 'revisionId', 'supersededRevisionId', 'intentId', 'approvalRef', 'actor', 'at'],
}
const ASSET_KINDS: readonly MethodAssetKind[] = ['skill', 'task-template', 'capability']
const OUTCOMES: readonly TrialOutcome[] = ['verified', 'failed', 'cancelled', 'interrupted', 'not-admitted']
const SIDES: readonly string[] = ['baseline', 'candidate']
const VERDICTS: readonly EvaluationVerdict[] = [
  'fixed',
  'fixed-with-regression',
  'not-fixed',
  'both-failed',
  'improved',
  'not-improved',
  'regressed',
  'inconclusive',
]

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`evolution: ${field} must be a non-empty string`)
  return value
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requireString(value, field)
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`evolution: ${field} must be an object`)
  return value
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`evolution: ${field} must be an array`)
  return value
}

function requireDigest(value: unknown, field: string): string {
  if (!isHex64(value)) throw new Error(`evolution: ${field} must be a lowercase SHA-256 hex digest`)
  return value as string
}

function requireVerdict(value: unknown, field: string): EvaluationVerdict {
  if (typeof value !== 'string' || !VERDICTS.includes(value as EvaluationVerdict)) {
    throw new Error(`evolution: ${field} must be one of ${VERDICTS.join(' / ')}, got ${JSON.stringify(value ?? null)}`)
  }
  return value as EvaluationVerdict
}

/** One revision reference, validated. */
export function assertRevisionRef(value: unknown, field: string): RevisionRef {
  const raw = requireObject(value, field)
  return {
    revisionId: requireString(raw.revisionId, `${field}.revisionId`),
    digest: requireDigest(raw.digest, `${field}.digest`),
    libraryId: requireString(raw.libraryId, `${field}.libraryId`),
  }
}

/** One candidate revision, validated: the frozen directory plus the files it changes. */
export function assertCandidateRevision(value: unknown, field: string): CandidateRevision {
  const raw = requireObject(value, field)
  const files = requireArray(raw.files, `${field}.files`).map((entry, index) => {
    const file = requireObject(entry, `${field}.files[${index}]`)
    return {
      path: requireString(file.path, `${field}.files[${index}].path`),
      sha256: requireDigest(file.sha256, `${field}.files[${index}].sha256`),
    }
  })
  return { revisionId: requireString(raw.revisionId, `${field}.revisionId`), digest: requireDigest(raw.digest, `${field}.digest`), files }
}

/** One draft record's payload as a {@link MethodDraft}. */
export function assertMethodDraft(value: unknown, field: string): MethodDraft {
  const raw = requireObject(value, field)
  const kind = raw.kind
  if (typeof kind !== 'string' || !ASSET_KINDS.includes(kind as MethodAssetKind)) {
    throw new Error(`evolution: ${field}.kind must be one of ${ASSET_KINDS.join(' / ')}, got ${JSON.stringify(kind ?? null)}`)
  }
  return {
    draftId: requireString(raw.draftId, `${field}.draftId`),
    kind: kind as MethodAssetKind,
    identity: requireString(raw.identity, `${field}.identity`),
    baseRevision: assertRevisionRef(raw.baseRevision, `${field}.baseRevision`),
    candidateRevision: assertCandidateRevision(raw.candidateRevision, `${field}.candidateRevision`),
    rationale: requireString(raw.rationale, `${field}.rationale`),
    sourceRefs: requireArray(raw.sourceRefs, `${field}.sourceRefs`).map((ref, index) => requireString(ref, `${field}.sourceRefs[${index}]`)),
    actor: requireString(raw.actor, `${field}.actor`),
    at: requireString(raw.at, `${field}.at`),
  }
}

function assertSkill(value: unknown, field: string): import('../types.ts').FrozenProviderSkill {
  const raw = requireObject(value, field)
  const role = raw.role
  if (role !== 'execution-provider' && role !== 'knowledge' && role !== 'guidance') {
    throw new Error(`evolution: ${field}.role must be execution-provider / knowledge / guidance`)
  }
  return {
    name: requireString(raw.name, `${field}.name`),
    role,
    contractDigest: raw.contractDigest === null ? null : requireDigest(raw.contractDigest, `${field}.contractDigest`),
    contentDigest: requireDigest(raw.contentDigest, `${field}.contentDigest`),
  }
}

function assertCriterion(value: unknown, field: string): import('../types.ts').FrozenCriterion {
  const raw = requireObject(value, field)
  return {
    criterionId: requireString(raw.criterionId, `${field}.criterionId`),
    verificationMode: requireString(raw.verificationMode, `${field}.verificationMode`),
    ...(raw.command === undefined ? {} : { command: requireString(raw.command, `${field}.command`) }),
    protectedInputsDigest: requireDigest(raw.protectedInputsDigest, `${field}.protectedInputsDigest`),
    verifierRef: requireString(raw.verifierRef, `${field}.verifierRef`),
    verifierVersion: requireString(raw.verifierVersion, `${field}.verifierVersion`),
    verifierAnchor: requireString(raw.verifierAnchor, `${field}.verifierAnchor`),
  }
}

/** One side plan, validated: both sides of one evaluation carry exactly this shape. */
export function assertSidePlan(value: unknown, field: string): SidePlan {
  const raw = requireObject(value, field)
  if (raw.side !== 'baseline' && raw.side !== 'candidate') throw new Error(`evolution: ${field}.side must be baseline or candidate`)
  const model = requireObject(raw.model, `${field}.model`)
  return {
    side: raw.side,
    revision: assertRevisionRef(raw.revision, `${field}.revision`),
    capabilities: requireArray(raw.capabilities, `${field}.capabilities`).map((item, index) => requireString(item, `${field}.capabilities[${index}]`)),
    registryRevision: requireString(raw.registryRevision, `${field}.registryRevision`),
    mcpServers: requireArray(raw.mcpServers, `${field}.mcpServers`).map((item, index) => {
      const server = requireObject(item, `${field}.mcpServers[${index}]`)
      return {
        serverName: requireString(server.serverName, `${field}.mcpServers[${index}].serverName`),
        templateDigest: requireDigest(server.templateDigest, `${field}.mcpServers[${index}].templateDigest`),
      }
    }),
    preset: requireNullableString(raw.preset, `${field}.preset`),
    skills: requireArray(raw.skills, `${field}.skills`).map((item, index) => assertSkill(item, `${field}.skills[${index}]`)),
    model: {
      provider: requireString(model.provider, `${field}.model.provider`),
      model: requireString(model.model, `${field}.model.model`),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: requireString(model.reasoningEffort, `${field}.model.reasoningEffort`) }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens as number }),
      label: requireString(model.label, `${field}.model.label`),
    },
    acceptance: requireArray(raw.acceptance, `${field}.acceptance`).map((item, index) => assertCriterion(item, `${field}.acceptance[${index}]`)),
  }
}

function assertRules(value: unknown, field: string): EvaluationRules {
  const raw = requireObject(value, field)
  const quality = requireObject(raw.quality, `${field}.quality`)
  return {
    ...(raw.objective === undefined ? {} : { objective: raw.objective as EvaluationRules['objective'] }),
    quality: {
      metricId: requireString(quality.metricId, `${field}.quality.metricId`),
      direction: 'higher-is-better',
      extractor: requireString(quality.extractor, `${field}.quality.extractor`),
    },
    guards: requireArray(raw.guards, `${field}.guards`).map((item, index) => {
      const guard = requireObject(item, `${field}.guards[${index}]`)
      return {
        id: requireString(guard.id, `${field}.guards[${index}].id`),
        kind: guard.kind as 'acceptance' | 'holdout' | 'domain',
        bound: guard.bound as number,
      }
    }),
    ...(raw.floor === undefined
      ? {}
      : (() => {
          const floor = requireObject(raw.floor, `${field}.floor`)
          return { floor: { key: requireString(floor.key, `${field}.floor.key`), value: floor.value as number } }
        })()),
  }
}

/** One frozen evaluation plan, validated: the two sides, the samples, the input, the rules and the budget. */
export function assertEvaluationPlan(value: unknown, field: string): EvaluationPlan {
  const raw = requireObject(value, field)
  if (raw.schemaVersion !== 'evaluation-plan@1') {
    throw new Error(`evolution: ${field}.schemaVersion must be "evaluation-plan@1", got ${JSON.stringify(raw.schemaVersion ?? null)}`)
  }
  const kind = raw.kind
  if (typeof kind !== 'string' || !ASSET_KINDS.includes(kind as MethodAssetKind)) {
    throw new Error(`evolution: ${field}.kind must be one of ${ASSET_KINDS.join(' / ')}`)
  }
  const sides = requireObject(raw.sides, `${field}.sides`)
  const input = requireObject(raw.input, `${field}.input`)
  const budget = requireObject(raw.budget, `${field}.budget`)
  return {
    planId: requireString(raw.planId, `${field}.planId`),
    draftId: requireString(raw.draftId, `${field}.draftId`),
    kind: kind as MethodAssetKind,
    libraryId: requireString(raw.libraryId, `${field}.libraryId`),
    sides: {
      baseline: assertSidePlan(sides.baseline, `${field}.sides.baseline`),
      candidate: assertSidePlan(sides.candidate, `${field}.sides.candidate`),
    },
    samples: requireArray(raw.samples, `${field}.samples`).map((item, index) => {
      const sample = requireObject(item, `${field}.samples[${index}]`)
      const observed = requireObject(sample.observed, `${field}.samples[${index}].observed`)
      return {
        taskId: requireString(sample.taskId, `${field}.samples[${index}].taskId`),
        role: sample.role as PlannedSampleLike['role'],
        contractDigest: requireDigest(sample.contractDigest, `${field}.samples[${index}].contractDigest`),
        criteria: requireArray(sample.criteria, `${field}.samples[${index}].criteria`).map((entry, at) =>
          assertCriterion(entry, `${field}.samples[${index}].criteria[${at}]`),
        ),
        observed: {
          outcome: observed.outcome as 'verified' | 'failed',
          ...(observed.runId === undefined ? {} : { runId: requireString(observed.runId, `${field}.samples[${index}].observed.runId`) }),
        },
      }
    }),
    input: {
      sourceDir: requireString(input.sourceDir, `${field}.input.sourceDir`),
      ...(input.paths === undefined
        ? {}
        : { paths: requireArray(input.paths, `${field}.input.paths`).map((item, index) => requireString(item, `${field}.input.paths[${index}]`)) }),
      ...(input.rebaseFrom === undefined ? {} : { rebaseFrom: requireString(input.rebaseFrom, `${field}.input.rebaseFrom`) }),
      digest: requireDigest(input.digest, `${field}.input.digest`),
    },
    rules: assertRules(raw.rules, `${field}.rules`),
    budget: {
      ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens as number }),
      ...(budget.note === undefined ? {} : { note: requireString(budget.note, `${field}.budget.note`) }),
    },
    repetition: raw.repetition as number,
    ...(raw.evaluation === undefined ? {} : { evaluation: raw.evaluation as EvaluationPlan['evaluation'] }),
    overlay: (() => {
      const overlay = requireObject(raw.overlay, `${field}.overlay`)
      return {
        baseline: requireString(overlay.baseline, `${field}.overlay.baseline`),
        candidate: requireString(overlay.candidate, `${field}.overlay.candidate`),
      }
    })(),
    ...(raw.strategy === undefined ? {} : { strategy: raw.strategy as EvaluationPlan['strategy'] }),
    schemaVersion: 'evaluation-plan@1',
  }
}

type PlannedSampleLike = EvaluationPlan['samples'][number]

function assertCost(value: unknown, field: string): CostReading {
  const raw = requireObject(value, field)
  if (raw.status === 'unknown') return { status: 'unknown', reason: requireString(raw.reason, `${field}.reason`) }
  if (raw.status !== 'reported') throw new Error(`evolution: ${field}.status must be "reported" or "unknown"`)
  const tokens = raw.tokens
  if (!isRecord(tokens)) {
    throw new Error(`evolution: ${field} is reported but carries no token buckets; a cost reading without a reading is not a reading`)
  }
  for (const bucket of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (typeof tokens[bucket] !== 'number' || !Number.isSafeInteger(tokens[bucket]) || (tokens[bucket] as number) < 0) {
      throw new Error(`evolution: ${field}.tokens.${bucket} must be a non-negative whole number`)
    }
  }
  return {
    status: 'reported',
    tokens: tokens as unknown as import('../types.ts').CostReading extends never ? never : Extract<import('../types.ts').CostReading, { status: 'reported' }>['tokens'],
    ...(raw.toolCalls === undefined ? {} : { toolCalls: raw.toolCalls as { calls: number; failures: number } }),
  }
}

/** One normalized execution receipt, validated. */
export function assertReceiptRef(value: unknown, field: string): ExecutionReceiptRef {
  const raw = requireObject(value, field)
  return {
    receiptId: requireString(raw.receiptId, `${field}.receiptId`),
    digest: requireDigest(raw.digest, `${field}.digest`),
    ...(raw.taskId === undefined ? {} : { taskId: requireString(raw.taskId, `${field}.taskId`) }),
    ...(raw.runId === undefined ? {} : { runId: requireString(raw.runId, `${field}.runId`) }),
    ...(raw.reviewRef === undefined ? {} : { reviewRef: requireString(raw.reviewRef, `${field}.reviewRef`) }),
    criteria: requireArray(raw.criteria, `${field}.criteria`).map((item, index) => item as TrialCriterion),
    evidenceRefs: requireArray(raw.evidenceRefs, `${field}.evidenceRefs`).map((item, index) => requireString(item, `${field}.evidenceRefs[${index}]`)),
    cost: assertCost(raw.cost, `${field}.cost`),
    boundRevision: requireString(raw.boundRevision, `${field}.boundRevision`),
    boundModel: requireString(raw.boundModel, `${field}.boundModel`),
    workspace: requireString(raw.workspace, `${field}.workspace`),
    workspaceDigest: requireString(raw.workspaceDigest, `${field}.workspaceDigest`),
    complete: raw.complete === true,
    ...(raw.incompleteness === undefined
      ? {}
      : { incompleteness: requireArray(raw.incompleteness, `${field}.incompleteness`).map((item, index) => requireString(item, `${field}.incompleteness[${index}]`)) }),
  }
}

/** One trial result, validated: the only side-fact schema this plane keeps. */
export function assertTrialResult(value: unknown, field: string): TrialResult {
  const raw = requireObject(value, field)
  if (typeof raw.outcome !== 'string' || !OUTCOMES.includes(raw.outcome as TrialOutcome)) {
    throw new Error(`evolution: ${field}.outcome must be one of ${OUTCOMES.join(' / ')}, got ${JSON.stringify(raw.outcome ?? null)}`)
  }
  if (typeof raw.side !== 'string' || !SIDES.includes(raw.side)) throw new Error(`evolution: ${field}.side must be baseline or candidate`)
  const outcome = raw.outcome as TrialOutcome
  if (outcome === 'interrupted' && typeof raw.reason !== 'string') {
    throw new Error(`evolution: ${field} is interrupted and carries no reason; an interrupted trial names why it has no terminal run`)
  }
  return {
    sampleTaskId: requireString(raw.sampleTaskId, `${field}.sampleTaskId`),
    side: raw.side as 'baseline' | 'candidate',
    role: raw.role as TrialResult['role'],
    outcome,
    receipt: assertReceiptRef(raw.receipt, `${field}.receipt`),
    ...(raw.admission === undefined ? {} : { admission: raw.admission as AdmissionRefusal }),
    ...(raw.reason === undefined ? {} : { reason: requireString(raw.reason, `${field}.reason`) }),
    actor: requireString(raw.actor, `${field}.actor`),
    at: requireString(raw.at, `${field}.at`),
  }
}

/** Where one draft's pending decision sits in the ledger, as the fold records it. */
export interface EvaluationReportRef {
  evaluationId: string
  reportPath: string
  reportDigest: string
  verdict: EvaluationVerdict
}

/** One ledger line of the v5 protocol. */
export type EvolutionRecordV5 =
  | {
      readonly formatVersion: 5
      readonly kind: 'draft'
      readonly draftId: string
      readonly libraryId: string
      readonly assetKind: MethodAssetKind
      readonly identity: string
      readonly baseRevision: RevisionRef
      readonly candidateRevision: CandidateRevision
      readonly rationale: string
      readonly sourceRefs: readonly string[]
      readonly actor: string
      readonly at: string
    }
  | {
      readonly formatVersion: 5
      readonly kind: 'plan'
      readonly draftId: string
      readonly evaluationId: string
      readonly plan: EvaluationPlan
      readonly planDigest: string
      readonly report: string
      readonly storeId?: string
      readonly actor: string
      readonly at: string
    }
  | { readonly formatVersion: 5; readonly kind: 'trial'; readonly draftId: string; readonly evaluationId: string; readonly trial: TrialResult }
  | {
      readonly formatVersion: 5
      readonly kind: 'evaluation'
      readonly draftId: string
      readonly evaluationId: string
      readonly report: string
      readonly reportDigest: string
      readonly verdict: EvaluationVerdict
      readonly scoreDigest: string
      readonly actor: string
      readonly at: string
    }
  | { readonly formatVersion: 5; readonly kind: 'discard'; readonly draftId: string; readonly reason: string; readonly actor: string; readonly at: string }
  | {
      readonly formatVersion: 5
      readonly kind: 'published'
      readonly draftId: string
      readonly revisionId: string
      readonly supersededRevisionId: string | null
      readonly intentId: string
      readonly approvalRef?: string
      readonly actor: string
      readonly at: string
    }
  | {
      readonly formatVersion: 5
      readonly kind: 'rolledback'
      readonly draftId: string | null
      readonly revisionId: string
      readonly supersededRevisionId: string | null
      readonly intentId: string
      readonly approvalRef?: string
      readonly actor: string
      readonly at: string
    }

/** Whether one line is a v5 line (as opposed to a v4 line the legacy reader projects). */
export function isMethodRecordV5(record: unknown): record is EvolutionRecordV5 {
  return isRecord(record) && record.formatVersion === METHOD_LEDGER_FORMAT_VERSION && typeof record.kind === 'string' && KINDS.includes(record.kind)
}

/** One v5 record, fully validated: the write door and the fold share this one check. */
export function validateDraftRecord(record: unknown): asserts record is EvolutionRecordV5 {
  if (!isRecord(record)) throw new Error('evolution: a ledger record must be an object')
  if (record.formatVersion !== METHOD_LEDGER_FORMAT_VERSION) {
    throw new Error(
      `evolution: ledger line declares formatVersion ${JSON.stringify(record.formatVersion ?? null)}; the v5 protocol reads and writes ` +
        `${METHOD_LEDGER_FORMAT_VERSION} only (a v4 ledger is history: read it through the legacy projection, never re-published)`,
    )
  }
  const kind = record.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw new Error(`evolution: unknown ledger record kind ${JSON.stringify(kind ?? null)}; one of ${KINDS.join(' / ')}`)
  }
  // A v5 line carries exactly the members its kind declares: the fields the old
  // protocol hand-filled (a version set, six gate answers, an always-true
  // mechanical flag, a derivable champion) are refused rather than ignored.
  assertOnlyKeys(record, ['formatVersion', 'kind', ...KIND_KEYS[kind]!], `${kind} record`)
  // One switch: every line is validated by the member its kind requires, so a
  // hand-written line that carries another kind's fields is refused here.
  switch (kind) {
    case 'draft': {
      const draft = assertMethodDraft(
        {
          draftId: record.draftId,
          kind: record.assetKind,
          identity: record.identity,
          baseRevision: record.baseRevision,
          candidateRevision: record.candidateRevision,
          rationale: record.rationale,
          sourceRefs: record.sourceRefs,
          actor: record.actor,
          at: record.at,
        },
        `draft record`,
      )
      requireString(record.libraryId, 'draft record libraryId')
      if (draft.candidateRevision.revisionId === draft.baseRevision.revisionId) {
        throw new Error(
          `evolution: draft "${draft.draftId}" names its base revision as its candidate ("${draft.candidateRevision.revisionId}"); a draft ` +
            'proposes a version that does not exist yet',
        )
      }
      return
    }
    case 'plan': {
      requireString(record.draftId, 'plan record draftId')
      requireString(record.evaluationId, 'plan record evaluationId')
      const plan = assertEvaluationPlan(record.plan, 'plan record plan')
      if (plan.draftId !== record.draftId) {
        throw new Error(`evolution: plan record for draft "${record.draftId}" carries a plan of draft "${plan.draftId}"`)
      }
      requireDigest(record.planDigest, 'plan record planDigest')
      requireString(record.report, 'plan record report')
      return
    }
    case 'trial': {
      requireString(record.draftId, 'trial record draftId')
      requireString(record.evaluationId, 'trial record evaluationId')
      assertTrialResult(record.trial, 'trial record trial')
      return
    }
    case 'evaluation': {
      requireString(record.draftId, 'evaluation record draftId')
      requireString(record.evaluationId, 'evaluation record evaluationId')
      requireString(record.report, 'evaluation record report')
      requireDigest(record.reportDigest, 'evaluation record reportDigest')
      requireDigest(record.scoreDigest, 'evaluation record scoreDigest')
      requireVerdict(record.verdict, 'evaluation record verdict')
      requireString(record.actor, 'evaluation record actor')
      requireString(record.at, 'evaluation record at')
      return
    }
    case 'discard': {
      requireString(record.draftId, 'discard record draftId')
      requireString(record.reason, 'discard record reason')
      requireString(record.actor, 'discard record actor')
      requireString(record.at, 'discard record at')
      return
    }
    case 'published': {
      requireString(record.draftId, 'published record draftId')
      requireString(record.revisionId, 'published record revisionId')
      requireNullableString(record.supersededRevisionId, 'published record supersededRevisionId')
      requireString(record.intentId, 'published record intentId')
      requireString(record.actor, 'published record actor')
      requireString(record.at, 'published record at')
      return
    }
    case 'rolledback': {
      requireNullableString(record.draftId, 'rolledback record draftId')
      requireString(record.revisionId, 'rolledback record revisionId')
      requireNullableString(record.supersededRevisionId, 'rolledback record supersededRevisionId')
      requireString(record.intentId, 'rolledback record intentId')
      requireString(record.actor, 'rolledback record actor')
      requireString(record.at, 'rolledback record at')
      return
    }
  }
}
