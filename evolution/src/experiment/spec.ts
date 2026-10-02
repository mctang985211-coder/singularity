/** The experiment's caller-facing specification: the request, the idempotency key, the frozen samples and the records.
 * @module dsh-singularity-evolution/experiment/spec */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ReviewCriterion, ReviewRecord, TaskInstance } from '@dangosys/dsh-singularity-task'
import type {
  ExperimentAdmissionRefusal,
  ExperimentBudget,
  ExperimentCost,
  ExperimentObjective,
  ExperimentSampleRole,
  ExperimentSide,
  ExperimentSideDetail,
  FrozenExperiment,
  ModelSelection,
} from '../replay.ts'
import { EXPERIMENT_SAMPLE_ROLES } from '../replay.ts'
import { assertSegment as sharedSegment, nonEmpty as sharedNonEmpty } from '../shared.ts'

/** One sample as the caller's specification names it. */
export interface ExperimentSampleSpec {
  taskId: string
  role: ExperimentSampleRole
}

/** The experiment a caller freezes before anything runs (§F.2). Everything here is frozen into the report's identity block. */
export interface ExperimentSpec {
  proposalId: string
  objective?: ExperimentObjective
  samples: ExperimentSampleSpec[]
  /** The directory whose recursive content is the frozen input both workspaces are built from. */
  snapshot: { sourceDir: string }
  /** The deployment's own model selection, frozen before the first run (S4-E §Q3). */
  model: ModelSelection
  budget: ExperimentBudget
  /** This experiment's repetition index. `0` is the first run of the frozen specification. */
  repetition: number
}

/** One experiment call: the frozen specification, the session it runs as, and the caller's cancellation. */
export interface ExperimentRequest {
  readonly spec: ExperimentSpec
  /** The session every replayed run of this experiment is run as. */
  readonly caller: SessionId
  readonly actor: string
  readonly signal?: AbortSignal
}

/** The idempotency key of one sample side (§F.2). All five members together name one record. */
export interface ExperimentKey {
  proposalId: string
  /** The digest of the prepared candidate's **complete** content identity (K3): the key that separates two prepared objects. */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
}

/** One `experiment_started` ledger line: the frozen experiment, recorded before the first run. */
export interface ExperimentStartedRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4
  kind: 'experiment_started'
  proposalId: string
  experimentId: string
  frozen: FrozenExperiment
  frozenDigest: string
  /** The frozen budget, carried on the record as well as inside the block (the fold requires the two to agree). */
  budget: ExperimentBudget
  /** Report path relative to the ledger root (`sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`). */
  report: string
  /** The task store every run of this experiment was created in, so a later resume reads the same store. */
  storeId?: string
  actor: string
  at: string
}

/** One `experiment_sample` ledger line: one sample side's run and what it settled to. */
export interface ExperimentSampleRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4
  kind: 'experiment_sample'
  proposalId: string
  experimentId: string
  /** Key part: the digest of the complete candidate content identity this run was placed under. */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
  /** The replayed task this side created. Absent for a side whose run never reached the store. */
  taskId?: string
  /** The run this side created. Absent for a side whose run never reached the store. */
  runId?: string
  outcome: ExperimentSideDetail['outcome']
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string
  /** Evidence ids the run's review record (or, when it has none, the store's evidence bundles) carries. */
  evidenceRefs: string[]
  /** The run's per-criterion verdicts, with the verifier that decided each — the report's criterion detail. */
  criteria: ReviewCriterion[]
  /** The workspace this side's run went through. */
  workspace: string
  /** The frozen snapshot digest the workspace was built from. A run started by a replay records it. */
  initialDigest?: string
  cost: ExperimentCost
  /** Why this side has no terminal run; required for `interrupted`. */
  reason?: string
  /** The runtime's own admission refusal, carried by a `not-admitted` side (A6): the gap and the proposal source. */
  admission?: ExperimentAdmissionRefusal
  actor: string
  at: string
}

export type ExperimentRecord = ExperimentStartedRecord | ExperimentSampleRecord

export function nonEmpty(value: unknown, field: string): string {
  return sharedNonEmpty(value, field, detail => new Error(`experiment: ${detail}`))
}

/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
export function safeSegment(value: unknown, field: string): string {
  return sharedSegment(value, field, detail => new Error(`experiment: ${detail}`))
}

/** The specification's own shape, before anything is read or frozen. */
export function validateSpec(spec: ExperimentSpec): void {
  nonEmpty(spec.proposalId, 'proposalId')
  if (spec.objective !== undefined && spec.objective !== 'tool-call-reduction') {
    throw new Error('experiment: objective must be tool-call-reduction when declared')
  }
  if (
    spec.model === null ||
    typeof spec.model !== 'object' ||
    typeof spec.model.provider !== 'string' ||
    spec.model.provider.length === 0 ||
    typeof spec.model.model !== 'string' ||
    spec.model.model.length === 0
  ) {
    throw new Error(
      'experiment: model must be the structured selection { provider, model } the runs are placed under — a bare string names no ' +
        'route a spawn can be given, so nothing may be frozen under it',
    )
  }
  if (typeof spec.snapshot?.sourceDir !== 'string' || spec.snapshot.sourceDir.trim().length === 0) {
    throw new Error('experiment: snapshot.sourceDir must be the directory both sides are built from')
  }
  if (!Number.isInteger(spec.repetition) || spec.repetition < 0) {
    throw new Error("experiment: repetition must be the experiment's non-negative integer repeat index")
  }
  if (!Array.isArray(spec.samples) || spec.samples.length === 0) {
    throw new Error('experiment: samples must name at least one sample')
  }
  const seen = new Set<string>()
  for (const [index, sample] of spec.samples.entries()) {
    safeSegment(sample.taskId, `samples[${index}].taskId`)
    if (seen.has(sample.taskId)) throw new Error(`experiment: samples[${index}] repeats task "${sample.taskId}"`)
    seen.add(sample.taskId)
    if (!EXPERIMENT_SAMPLE_ROLES.includes(sample.role)) {
      throw new Error(`experiment: samples[${index}].role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
    }
  }
}

/** The role a sample must have been chosen for, against the historical record it carries. */
export function assertSampleRole(sample: ExperimentSampleSpec, task: TaskInstance, review: ReviewRecord): void {
  const required = sample.role === 'observed-failure' ? 'failed' : 'verified'
  if (review.outcome !== required) {
    throw new Error(
      `sample "${sample.taskId}" is an ${sample.role} but its latest review record is "${review.outcome}", not "${required}" — ` +
        'a sample must be the case its role names',
    )
  }
  if (task.status !== review.outcome) {
    throw new Error(
      `sample "${sample.taskId}" is ${task.status} but its latest review record is "${review.outcome}"; the two must agree`,
    )
  }
}
