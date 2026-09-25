/**
 * The two-sided skill experiment (§F.2): the one evaluation this plane runs for
 * a candidate that replaces an existing single-file `SKILL.md`.
 *
 * The v1 replay compared a candidate against a historical record. This module
 * runs the comparison the plan actually asks for: for every frozen sample, one
 * **new** run of the baseline and one **new** run of the candidate, both from
 * one frozen input snapshot, each in its own workspace, all of it under one
 * frozen identity block — samples, input snapshot, judge, model, budget,
 * candidate content and comparison rules. The historical record locates the
 * case and nothing else: a sample's `observed` identity says which failure it
 * reproduces, and every side of the report is a run *this* experiment created.
 *
 * What is frozen before the first run, and why the report is traceable:
 * - `frozen.samples` — each sample's task, role, contract digest and the
 *   acceptance identity (criteria, modes, commands, protected input digests) the
 *   replay mirrors into both sides;
 * - `frozen.snapshot` — the source directory's recursive content digest; both
 *   workspaces are built from it and each side's initial digest must equal it;
 * - `frozen.candidate` / `frozen.productionBaseline` — the content identity of
 *   the bytes the candidate side runs and of the production skill it replaces;
 * - `frozen.model` and `frozen.budget` — the caller's model identity and budget,
 *   recorded as given. This plane enforces no run-level budget and says so
 *   rather than implying otherwise: `ReplayTaskOptions` carries no budget to
 *   pass through, and what a tree actually spends stays the runtime's own root
 *   budget, measured where the runs are;
 * - `frozen.comparerVersion` and `frozen.overlay` — how the verdicts are
 *   computed and what each side ran under.
 * `frozenDigest` covers the block, and the experiment id derives from it: a
 * differently frozen experiment is a *different* experiment, never a re-run of
 * this one.
 *
 * The runs go through the existing replay entry — `taskRuntime.replayTask` with
 * `options.workspace` naming the side's own directory (S4-E item 2), and the
 * candidate side's `overlay.extraSkillRoots` pointing at the prepared sandbox's
 * `skills/`. Nothing here executes a run, judges a criterion or writes
 * production: the baseline side carries no overlay at all, so it runs under the
 * production configuration, and the candidate side runs the prepared bytes.
 *
 * Idempotency (§F.2). One sample side is keyed by `(proposalId,
 * preparedContentDigest, sampleTaskId, side, repetition)` and the ledger holds
 * at most one record per key:
 * - a recorded key is reused — no run, no new spend, and the record is never
 *   overwritten; a call that reaches an existing key under a different frozen
 *   experiment is refused by name (a new experiment needs a higher repetition);
 * - a key whose run the store still holds but which has no record (a process
 *   that died mid-experiment) is settled from the store: a terminal run is
 *   recorded exactly as it settled, a run that never settled is recorded
 *   `interrupted` — the experiment never re-runs it;
 * - a key with no run at all has never been spent: the experiment starts it.
 * The report is a function of the ledger records, `at` included (the newest
 * record's timestamp, never the reading's), so re-reading an experiment
 * reproduces the same report bytes.
 *
 * Cost is never invented: a side whose review record reports no metrics is
 * `{ status: 'unknown' }` with its reason, never a zero.
 *
 * Nothing is cleaned up. Both workspaces stay under
 * `<ledger root>/sandbox/<proposalId>/exp-<experimentId>/<sampleTaskId>/<side>/`
 * for as long as the evidence is cited, and the report lands beside them at
 * `<ledger root>/sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`.
 * @module dsh-singularity-evolution/experiment
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, ReviewCriterion, ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from './evolution.ts'
import type {
  ExperimentBudget,
  ExperimentCost,
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentSampleRole,
  ExperimentSide,
  ExperimentSideDetail,
  FrozenCriterion,
  FrozenExperiment,
  FrozenSample,
  SkillContentIdentity,
} from './replay.ts'
import {
  assertExperimentReport,
  assertFrozenExperiment,
  canonicalJson,
  compareExperimentSides,
  digestOf,
  EXPERIMENT_COMPARER_VERSION,
  EXPERIMENT_SAMPLE_ROLES,
  EXPERIMENT_SIDES,
  frozenDigestOf,
  overallExperimentVerdict,
  protectedInputsDigest,
} from './replay.ts'

/** One sample as the caller's specification names it. */
export interface ExperimentSampleSpec {
  taskId: string
  role: ExperimentSampleRole
}

/**
 * The experiment a caller freezes before anything runs (§F.2). Everything here
 * is fixed *before* the first run: samples and their roles, the input snapshot
 * both sides are built from, the model identity, the budget, and the repetition
 * index. Changing any member freezes a different experiment.
 */
export interface ExperimentSpec {
  proposalId: string
  samples: ExperimentSampleSpec[]
  /** The directory whose recursive content is the frozen input both workspaces are built from. */
  snapshot: { sourceDir: string }
  /**
   * The model identity the caller froze — an opaque string (a model name, a
   * scripted configuration's digest, the tool set the runs share). Nothing here
   * interprets it, and nothing here can verify that a run used it: it is the
   * caller's declaration, recorded in the frozen block so a later reader sees
   * exactly what was claimed.
   */
  model: string
  budget: ExperimentBudget
  /**
   * This experiment's repetition index. `0` is the first run of the frozen
   * experiment; a higher index is a new, separately budgeted experiment (§F.2:
   * only an explicit new experiment may run and charge budget again).
   */
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

/**
 * The idempotency key of one sample side (§F.2). All five members together
 * name one run; the module doc says what a repeat of a key means.
 */
export interface ExperimentKey {
  proposalId: string
  /** The prepared candidate's content identity (P2's digest of the materialized `SKILL.md`). */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
}

/** One `experiment_started` ledger line: the frozen experiment, recorded before the first run. */
export interface ExperimentStartedRecord {
  formatVersion: 1
  kind: 'experiment_started'
  proposalId: string
  experimentId: string
  frozen: FrozenExperiment
  frozenDigest: string
  /** The frozen budget, carried on the record as well as inside the block (the fold requires the two to agree). */
  budget: ExperimentBudget
  /** Report path relative to the ledger root (`sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`). */
  report: string
  actor: string
  at: string
}

/**
 * One `experiment_sample` ledger line: one sample side's run and what it settled
 * to. Written once per key and never overwritten; a side with no terminal run (a
 * process that died mid-experiment) records `interrupted` and is never re-run
 * under the same key.
 */
export interface ExperimentSampleRecord {
  formatVersion: 1
  kind: 'experiment_sample'
  proposalId: string
  experimentId: string
  /** Key part: the candidate content identity this run went through. */
  preparedContentDigest: string
  sampleTaskId: string
  side: ExperimentSide
  repetition: number
  /** The replayed task this side created. Absent for a side whose run never reached the store. */
  taskId?: string
  /** The run this side created. Absent for a side whose run never reached the store. */
  runId?: string
  outcome: 'verified' | 'failed' | 'cancelled' | 'interrupted'
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string
  /** Evidence ids the run's review record (or, when it has none, the store's evidence bundles) carries. */
  evidenceRefs: string[]
  /** The run's per-criterion verdicts, with the verifier that decided each — the report's criterion detail. */
  criteria: ReviewCriterion[]
  /** The workspace this side's run went through. */
  workspace: string
  /**
   * The frozen snapshot digest the workspace was built from. A run started by
   * this call measures it right after the build; a side settled from the store
   * after a crash records the digest the workspace *was built from* — by then
   * the run has written into the directory, so re-digesting it would measure the
   * run's output, not its input. Absent only for an `interrupted` side whose
   * workspace cannot be re-proved.
   */
  initialDigest?: string
  cost: ExperimentCost
  /** Why this side has no terminal run; required for `interrupted`. */
  reason?: string
  actor: string
  at: string
}

export type ExperimentRecord = ExperimentStartedRecord | ExperimentSampleRecord

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
  /** The `experiment_started` record's own timestamp. */
  at: string
  /** Sample records in ledger order. */
  samples: ExperimentSampleRecord[]
}

/**
 * The ledger as this module uses it: the proposal it evaluates, the prepared
 * candidate's verified bytes, the folded experiment family, and the two
 * append-only writes. `EvolutionService` is the only implementation.
 */
export interface ExperimentLedger {
  /** Absolute ledger directory; the sandbox, the workspaces and the report live under it. */
  readonly root: string
  get(proposalId: string): Promise<EvolutionProposal>
  /** Read the prepared candidate's bytes and verify them against the identity recorded at prepare (P2); throws otherwise. */
  readSkillCandidate(proposalId: string): Promise<Buffer>
  /** One experiment's folded view; throws on an unknown id. */
  experiment(experimentId: string): Promise<ExperimentView>
  /**
   * Every experiment folded under one proposal, newest first. One call answers
   * both questions a run has about the ledger: which sample keys are already
   * spent, and by which frozen experiment.
   */
  experiments(proposalId: string): Promise<ExperimentView[]>
  /** Record the frozen experiment (idempotent by identity: an identical record is a no-op, a different one refuses). */
  recordExperimentStart(record: ExperimentStartedRecord): Promise<void>
  /** Record one sample side. A key that is already recorded refuses a different content by name. */
  recordExperimentSample(record: ExperimentSampleRecord): Promise<void>
}

/** The services one experiment reads, as the caller's context holds them. */
export interface ExperimentSources {
  readonly evolution: ExperimentLedger
  readonly graphs: { graphForSession(sessionId: SessionId): Promise<{ readonly rootSessionId: SessionId }> }
  readonly task: { openStore(storeId: string): Promise<TaskSnapshot> }
  readonly taskRuntime: {
    replayTask(storeId: string, championTaskId: string, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>
  }
}

/** What one experiment call produced. */
export interface ExperimentResult {
  proposalId: string
  experimentId: string
  /** The report as recorded; its bytes are exactly the file at {@link ExperimentResult.reportPath}. */
  report: ExperimentReport
  /** Report path relative to the ledger root. */
  reportPath: string
  /** The folded ledger view the report was recomputed from. */
  experiment: ExperimentView
}

/** A run state that means the run is over, whatever it settled to. */
const TERMINAL_RUN_STATUSES: readonly string[] = ['verified', 'failed', 'cancelled']

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`experiment: ${field} must be a non-empty string`)
  }
  return value
}

/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function safeSegment(value: unknown, field: string): string {
  const text = nonEmpty(value, field)
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\') || isAbsolute(text)) {
    throw new Error(`experiment: ${field} must be a single safe path segment, got "${text}"`)
  }
  return text
}

function isHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Lowercase SHA-256 hex over exact bytes. */
function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The lineage tag one sample side's replayed task carries — how a run is found again after a crash. */
export function experimentLineage(experimentId: string, sampleTaskId: string, side: ExperimentSide): string {
  return `evolution-experiment:${experimentId}:${sampleTaskId}:${side}`
}

/** The experiment id: a digest of the proposal and the frozen block, so a differently frozen experiment never shares one. */
export function experimentIdOf(proposalId: string, frozenDigest: string): string {
  return digestOf({ proposalId, frozenDigest }).slice(0, 16)
}

/** The report path one experiment's evidence lands at, relative to the ledger root. */
export function experimentReportPath(proposalId: string, experimentId: string): string {
  return `sandbox/${proposalId}/exp-${experimentId}/experiment-report.json`
}

/** The one string form of a sample key (map key, refusals, the ledger's own uniqueness check). */
export function experimentSampleKey(key: ExperimentKey): string {
  return [key.proposalId, key.preparedContentDigest, key.sampleTaskId, key.side, key.repetition].join('\0')
}

/** A sample key as a reader sees it: the sample and the side it names. */
export function experimentSampleLabel(key: ExperimentKey): string {
  return `${key.sampleTaskId}/${key.side}#${key.repetition}`
}

/**
 * The recursive content digest of a directory — the input snapshot identity
 * (§F.2): every regular file's relative path and byte digest, sorted by path,
 * hashed together. A symbolic link is digested by its target text rather than
 * followed, because a copy keeps it a link (`cp`'s default): following it would
 * describe bytes the workspace never holds.
 */
export async function directoryDigest(directory: string): Promise<string> {
  const base = resolve(directory)
  const lines: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let found
    try {
      found = await readdir(current, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `experiment: the input snapshot "${current}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const entry of [...found].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (entry.isSymbolicLink()) {
        lines.push(`${rel}\0link:${await readlink(abs)}`)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(
          `experiment: the input snapshot holds "${abs}", which is neither a file nor a directory — ` +
          'only regular files and symbolic links can be frozen as input',
        )
      }
      lines.push(`${rel}\0${sha256Hex(await readFile(abs))}`)
    }
  }
  await walk(base, '')
  return sha256Hex(lines.join('\n'))
}

/** The task's latest review record — its terminal outcome is what makes a sample a sample. */
function latestReview(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

function reviewRefOf(review: ReviewRecord): string {
  return `${review.taskId}#${review.runId ?? 'no-run'}`
}

/**
 * What one side cost, as the run's own review record reported it. `unknown` is
 * a first-class answer and never a zero: a record that carries no metrics, or
 * metrics with no token and no tool-call counters, is reported with the reason
 * it could not be read.
 */
function costOf(review: ReviewRecord | undefined): ExperimentCost {
  if (review === undefined) {
    return { status: 'unknown', reason: 'the run settled no review record, so no cost was reported for it' }
  }
  const metrics = review.metrics
  if (metrics === undefined) {
    return { status: 'unknown', reason: "the run's review record carries no metrics, so no cost was reported for it" }
  }
  if (metrics.tokens === undefined && metrics.toolCalls === undefined) {
    return { status: 'unknown', reason: "the run's review record carries metrics but no token and no tool-call counters" }
  }
  return { status: 'reported', metrics: structuredClone(metrics) }
}

/** The evidence ids of one run: the review record's own list, or the store's bundles for that run when there is no review. */
function evidenceRefsOf(snapshot: TaskSnapshot, runId: string | undefined, review: ReviewRecord | undefined): string[] {
  if (review !== undefined) return [...review.evidenceRefs]
  if (runId === undefined) return []
  return snapshot.evidence.filter(bundle => bundle.taskRunId === runId).map(bundle => bundle.evidenceId)
}

/** The review record's criteria, or the run's own verdicts when the review carries none. */
function criteriaOf(review: ReviewRecord | undefined, outcome: ReplayRunOutcome | undefined): ReviewCriterion[] {
  return structuredClone([...(review?.criteria ?? outcome?.criteria ?? [])])
}

/** One criterion as the report carries it: the verdict plus the verifier that decided it (v1's report dropped the identity). */
function criterionDetail(criterion: ReviewCriterion): ExperimentSideDetail['criteria'][number] {
  return {
    criterionId: criterion.criterionId,
    verdict: criterion.verdict,
    ...(criterion.verifierId === undefined ? {} : { verifierId: criterion.verifierId }),
    ...(criterion.verifierVersion === undefined ? {} : { verifierVersion: criterion.verifierVersion }),
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
  }
}

/**
 * The proposal this experiment may evaluate, and the candidate bytes it runs
 * against. A skill candidate only: this plane's two-sided experiment replaces an
 * existing single-file `SKILL.md`, and every other target type either has no such
 * evaluation (A6's capability candidates) or none at all. The candidate's bytes
 * are re-verified here (P2) before anything runs.
 */
async function experimentCandidate(
  sources: ExperimentSources,
  proposalId: string,
): Promise<{ proposal: EvolutionProposal; sandbox: string; candidate: SkillContentIdentity }> {
  const proposal = await sources.evolution.get(proposalId)
  if (proposal.targetType !== 'skill') {
    throw new Error(`proposal ${proposalId} targets "${proposal.targetType}"; the two-sided experiment evaluates a skill candidate only`)
  }
  if (proposal.status !== 'prepared') {
    throw new Error(`proposal ${proposalId} is ${proposal.status}; only a prepared proposal can be evaluated`)
  }
  const prepared = proposal.prepared
  if (prepared === undefined || prepared.sandbox === null || !prepared.mechanical) {
    throw new Error(`proposal ${proposalId} has no materialized candidate; prepare it before evaluating it`)
  }
  if (prepared.champion !== 'captured') {
    throw new Error(
      `proposal ${proposalId} was prepared with no production skill to replace — this experiment evaluates a replacement of an ` +
      'existing single-file SKILL.md only; promoting a brand-new skill is not what its evidence can show',
    )
  }
  const candidate = prepared.skillContent
  if (candidate === undefined) {
    throw new Error(
      `proposal ${proposalId} carries no candidate content identity (it was prepared before content binding) — ` +
      'propose a new candidate and prepare it',
    )
  }
  // P2 before anything runs: the file must still be exactly the bytes prepare recorded.
  await sources.evolution.readSkillCandidate(proposalId)
  return { proposal, sandbox: prepared.sandbox, candidate }
}

/** The specification's own shape, before anything is read or frozen. */
function validateSpec(spec: ExperimentSpec): void {
  nonEmpty(spec.proposalId, 'proposalId')
  nonEmpty(spec.model, 'model')
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
function assertSampleRole(sample: ExperimentSampleSpec, task: TaskInstance, review: ReviewRecord): void {
  const required = sample.role === 'observed-failure' ? 'failed' : 'verified'
  if (review.outcome !== required) {
    throw new Error(
      `sample "${sample.taskId}" is an ${sample.role} but its latest review record is "${review.outcome}", not "${required}" — ` +
      'a sample must be the case its role names',
    )
  }
  if (task.status !== review.outcome) {
    throw new Error(`sample "${sample.taskId}" is ${task.status} but its latest review record is "${review.outcome}"; the two must agree`)
  }
}

/** The frozen acceptance identity of one criterion, taken from the sample's own stored contract. */
function frozenCriterionOf(criterion: AcceptanceCriterion): FrozenCriterion {
  const inputs = criterion.protectedInputs ?? []
  for (const input of inputs) {
    if (typeof input?.path !== 'string' || input.path.length === 0 || !isHex64(input?.sha256)) {
      throw new Error(
        `the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — ` +
        'an acceptance input nobody fixed is not a frozen input',
      )
    }
  }
  return {
    criterionId: criterion.criterionId,
    verificationMode: criterion.verificationMode,
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    protectedInputsDigest: protectedInputsDigest(inputs),
  }
}

/** Freeze one sample from its store record: what the case is, and the acceptance the replay mirrors into both sides. */
function frozenSampleOf(sample: ExperimentSampleSpec, task: TaskInstance, review: ReviewRecord): FrozenSample {
  if (task.acceptanceCriteria.length === 0) {
    throw new Error(`sample "${sample.taskId}" carries no acceptance criteria; there is nothing for the two sides to be judged by`)
  }
  return {
    taskId: sample.taskId,
    role: sample.role,
    contractDigest: digestOf({
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredCapabilities: task.requestedCapabilities,
    }),
    criteria: task.acceptanceCriteria.map(frozenCriterionOf),
    observed: {
      outcome: review.outcome === 'failed' ? 'failed' : 'verified',
      ...(review.runId === undefined ? {} : { runId: review.runId }),
    },
  }
}

/** Build the frozen identity block (§F.2), then check it against the schema the report and the ledger share. */
function freezeExperiment(input: {
  proposalId: string
  spec: ExperimentSpec
  candidate: SkillContentIdentity
  productionBaseline?: SkillContentIdentity
  sandbox: string
  snapshotDigest: string
  samples: FrozenSample[]
}): FrozenExperiment {
  const frozen: FrozenExperiment = {
    proposalId: input.proposalId,
    repetition: input.spec.repetition,
    candidate: { name: input.candidate.name, sha256: input.candidate.sha256 },
    ...(input.productionBaseline === undefined ? {} : { productionBaseline: { ...input.productionBaseline } }),
    model: input.spec.model,
    budget: { ...input.spec.budget },
    samples: input.samples,
    snapshot: { sourceDir: resolve(input.spec.snapshot.sourceDir), digest: input.snapshotDigest },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: {
      baseline: 'none — the baseline runs under the production configuration',
      candidate: `extraSkillRoots: [${input.sandbox}/skills]`,
    },
  }
  assertFrozenExperiment(frozen)
  return frozen
}

/** Build one side's workspace from the frozen snapshot, then prove it holds exactly the frozen bytes. */
async function buildWorkspace(sourceDir: string, target: string, snapshotDigest: string): Promise<string> {
  // A key that reaches this point has no run in the store, so nothing in the
  // directory is evidence: rebuild from the frozen snapshot rather than merge
  // into whatever an earlier attempt that never ran left there.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(resolve(sourceDir), target, { recursive: true })
  const real = await realpath(target)
  const digest = await directoryDigest(real)
  if (digest !== snapshotDigest) {
    throw new Error(
      `the workspace "${real}" was built from the frozen snapshot but hashes to ${digest}, not the frozen ${snapshotDigest}; ` +
      'the build did not reproduce the frozen input, so nothing runs in it',
    )
  }
  return real
}

/**
 * What reading one run out of the store produced — the one place store facts
 * become record facts. A terminal settlement is recorded exactly as it stands; a
 * run that never settled is an interruption, with the store's own description of
 * where it stands as the reason.
 */
interface RunFacts {
  outcome: ExperimentSideDetail['outcome']
  taskId?: string
  runId?: string
  review?: ReviewRecord
  criteria: ReviewCriterion[]
  evidenceRefs: string[]
  terminal: boolean
  detail: string
}

function runFactsOf(snapshot: TaskSnapshot, task: TaskInstance, settled: ReplayRunOutcome | undefined): RunFacts {
  const runId = settled?.runId ?? task.runIds[task.runIds.length - 1]
  const run = runId === undefined ? undefined : snapshot.runs.find(item => item.runId === runId)
  const review = runId === undefined ? undefined : snapshot.reviews.find(item => item.runId === runId)
  const outcome = review !== undefined && TERMINAL_RUN_STATUSES.includes(review.outcome)
    ? review.outcome
    : run !== undefined && TERMINAL_RUN_STATUSES.includes(run.status)
      ? run.status
      : undefined
  const detail = runId === undefined
    ? "the store holds no run of this side's task"
    : run === undefined
      ? `the store holds no run "${runId}" of this side's task`
      : `the store holds run ${run.runId} as ${run.status}${run.executionPhase === undefined ? '' : ` (${run.executionPhase})`} with no terminal review record`
  const outcomeValue: ExperimentSideDetail['outcome'] = outcome === undefined
    ? 'interrupted'
    : (outcome as ExperimentSideDetail['outcome'])
  return {
    outcome: outcomeValue,
    taskId: task.taskId,
    ...(runId === undefined ? {} : { runId }),
    ...(review === undefined ? {} : { review }),
    criteria: criteriaOf(review, settled),
    evidenceRefs: evidenceRefsOf(snapshot, runId, review),
    terminal: outcome !== undefined,
    detail,
  }
}

/** The one ledger line a sample side writes, from the facts its run settled to. */
function sampleRecord(input: {
  view: ExperimentView
  sample: FrozenSample
  side: ExperimentSide
  outcome: ExperimentSideDetail['outcome']
  taskId?: string
  runId?: string
  review?: ReviewRecord
  criteria: ReviewCriterion[]
  evidenceRefs: string[]
  workspace: string
  initialDigest?: string
  cost: ExperimentCost
  reason?: string
  actor: string
}): ExperimentSampleRecord {
  return {
    formatVersion: 1,
    kind: 'experiment_sample',
    proposalId: input.view.proposalId,
    experimentId: input.view.experimentId,
    preparedContentDigest: input.view.frozen.candidate.sha256,
    sampleTaskId: input.sample.taskId,
    side: input.side,
    repetition: input.view.frozen.repetition,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    outcome: input.outcome,
    ...(input.review === undefined ? {} : { reviewRef: reviewRefOf(input.review) }),
    evidenceRefs: [...input.evidenceRefs],
    criteria: input.criteria,
    workspace: input.workspace,
    ...(input.initialDigest === undefined ? {} : { initialDigest: input.initialDigest }),
    cost: input.cost,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    actor: input.actor,
    at: new Date().toISOString(),
  }
}

/**
 * One sample side that has a run in the store but no record: a process died
 * between starting the run and recording it. The store's terminal state is what
 * gets recorded — as it stands, never re-run. A run that never settled is
 * recorded `interrupted` with the store's own description of where it stands,
 * and the workspace's frozen digest is the one it was built from (the run has
 * written into the directory since; see the module doc).
 */
function recoveredSampleRecord(input: {
  view: ExperimentView
  sample: FrozenSample
  side: ExperimentSide
  task: TaskInstance
  snapshot: TaskSnapshot
  workspace: string
  actor: string
}): ExperimentSampleRecord {
  const facts = runFactsOf(input.snapshot, input.task, undefined)
  if (!facts.terminal) {
    return sampleRecord({
      view: input.view,
      sample: input.sample,
      side: input.side,
      outcome: 'interrupted',
      ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
      ...(facts.runId === undefined ? {} : { runId: facts.runId }),
      criteria: [],
      evidenceRefs: [],
      workspace: input.workspace,
      cost: { status: 'unknown', reason: 'the run never settled, so it reported no cost' },
      reason:
        `${facts.detail} — the experiment settles what the store holds and never re-runs an in-flight sample; ` +
        'resume it, or freeze a new experiment at a higher repetition, to run this side again',
      actor: input.actor,
    })
  }
  return sampleRecord({
    view: input.view,
    sample: input.sample,
    side: input.side,
    outcome: facts.outcome,
    ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
    ...(facts.runId === undefined ? {} : { runId: facts.runId }),
    ...(facts.review === undefined ? {} : { review: facts.review }),
    criteria: facts.criteria,
    evidenceRefs: facts.evidenceRefs,
    workspace: input.workspace,
    initialDigest: input.view.frozen.snapshot.digest,
    cost: costOf(facts.review),
    actor: input.actor,
  })
}

/** One side's detail as the report carries it, read off the ledger record and nothing else. */
function sideDetailOf(view: ExperimentView, sample: FrozenSample, side: ExperimentSide): ExperimentSideDetail {
  const record = view.samples.find(item => item.sampleTaskId === sample.taskId && item.side === side)
  if (record === undefined) throw new Error(`experiment: sample ${sample.taskId}/${side} has no record`)
  return {
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    role: sample.role,
    side,
    outcome: record.outcome,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.reviewRef === undefined ? {} : { reviewRef: record.reviewRef }),
    evidenceRefs: [...record.evidenceRefs],
    workspace: record.workspace,
    ...(record.initialDigest === undefined ? {} : { initialDigest: record.initialDigest }),
    criteria: record.criteria.map(criterionDetail),
    cost: record.cost,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}

/** The key one frozen sample's side has under one experiment. */
export function experimentSampleKeyOf(view: Pick<ExperimentView, 'proposalId' | 'frozen'>, sampleTaskId: string, side: ExperimentSide): ExperimentKey {
  return {
    proposalId: view.proposalId,
    preparedContentDigest: view.frozen.candidate.sha256,
    sampleTaskId,
    side,
    repetition: view.frozen.repetition,
  }
}

/**
 * Build the v2 report from the ledger records alone — the same records always
 * give the same report, its `at` included. An experiment missing a side has no
 * report: an incomplete comparison is not evidence, and saying so is the honest
 * answer.
 */
export function buildExperimentReport(view: ExperimentView): ExperimentReport {
  const missing = view.frozen.samples.flatMap(sample =>
    EXPERIMENT_SIDES
      .filter(side => !view.samples.some(item => item.sampleTaskId === sample.taskId && item.side === side))
      .map(side => `${sample.taskId}/${side}`))
  if (missing.length > 0) {
    throw new Error(`experiment ${view.experimentId} is incomplete — no record for ${missing.join(', ')}; the settled runs stay recorded`)
  }
  const samples: ExperimentSampleComparison[] = view.frozen.samples.map(sample => {
    const baseline = sideDetailOf(view, sample, 'baseline')
    const candidate = sideDetailOf(view, sample, 'candidate')
    return {
      taskId: sample.taskId,
      role: sample.role,
      baseline,
      candidate,
      verdict: compareExperimentSides(sample.role, baseline, candidate),
    }
  })
  const at = [view.at, ...view.samples.map(record => record.at)].reduce((left, right) => (left > right ? left : right))
  const report: ExperimentReport = {
    formatVersion: 2,
    proposalId: view.proposalId,
    experimentId: view.experimentId,
    at,
    frozen: view.frozen,
    frozenDigest: view.frozenDigest,
    samples,
    verdict: overallExperimentVerdict(samples),
  }
  assertExperimentReport(report)
  return report
}

/** The store one experiment reads: the caller's graph root, exactly as the v1 replay resolves it. */
async function experimentStore(sources: ExperimentSources, caller: SessionId): Promise<{ storeId: string; snapshot: TaskSnapshot }> {
  try {
    const graph = await sources.graphs.graphForSession(caller)
    const storeId = rootTaskStoreId(graph.rootSessionId)
    return { storeId, snapshot: await sources.task.openStore(storeId) }
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run — or continue — the frozen two-sided experiment, and return the report the
 * ledger records. Idempotent per sample key: a recorded side is reused, an
 * in-flight side is settled from the store and never re-run, and only a side
 * that never ran is started. Every refusal throws with its reason, and the runs
 * that did settle stay in the task store and in the ledger.
 */
export async function runExperiment(sources: ExperimentSources, request: ExperimentRequest): Promise<ExperimentResult> {
  const { spec, caller, actor } = request
  validateSpec(spec)
  const { sandbox, candidate, proposal } = await experimentCandidate(sources, spec.proposalId)
  const { storeId, snapshot } = await experimentStore(sources, caller)
  const samples = spec.samples.map(sample => {
    const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
    if (task === undefined) throw new Error(`unknown sample task "${sample.taskId}" in this graph's task store`)
    if (task.status !== 'verified' && task.status !== 'failed') {
      throw new Error(`sample "${sample.taskId}" is ${task.status}; only a terminal (verified or failed) sample can be evaluated`)
    }
    const review = latestReview(snapshot, task)
    if (review === undefined) {
      throw new Error(`sample "${sample.taskId}" has no review record on its latest run; there is no case to reproduce`)
    }
    assertSampleRole(sample, task, review)
    return frozenSampleOf(sample, task, review)
  })
  const frozen = freezeExperiment({
    proposalId: spec.proposalId,
    spec,
    candidate,
    ...(proposal.prepared?.skillBaseline === undefined ? {} : { productionBaseline: proposal.prepared.skillBaseline }),
    sandbox,
    snapshotDigest: await directoryDigest(spec.snapshot.sourceDir),
    samples,
  })
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(spec.proposalId, frozenDigest)
  const sandboxRel = `${sandbox}/exp-${experimentId}`

  // One read of every experiment this proposal already has, before anything is
  // written: the key map decides reuse, and a key another *frozen* experiment
  // already spent refuses the call here — before a run, before a ledger line.
  const recorded = new Map<string, ExperimentSampleRecord>()
  for (const previous of await sources.evolution.experiments(spec.proposalId)) {
    for (const record of previous.samples) recorded.set(experimentSampleKey(record), record)
  }
  for (const sample of frozen.samples) {
    for (const side of EXPERIMENT_SIDES) {
      const key = experimentSampleKeyOf({ proposalId: spec.proposalId, frozen }, sample.taskId, side)
      const prior = recorded.get(experimentSampleKey(key))
      if (prior !== undefined && prior.experimentId !== experimentId) throw sameKeyRefusal(key, prior, experimentId)
    }
  }

  await sources.evolution.recordExperimentStart({
    formatVersion: 1,
    kind: 'experiment_started',
    proposalId: spec.proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: experimentReportPath(spec.proposalId, experimentId),
    actor,
    at: new Date().toISOString(),
  })
  const view = await sources.evolution.experiment(experimentId)

  let started = 0
  try {
    sampleLoop: for (const sample of view.frozen.samples) {
      for (const side of EXPERIMENT_SIDES) {
        const key = experimentSampleKeyOf(view, sample.taskId, side)
        const lineage = experimentLineage(view.experimentId, sample.taskId, side)
        const workspace = resolve(sources.evolution.root, sandboxRel, sample.taskId, side)
        const prior = recorded.get(experimentSampleKey(key))
        if (prior !== undefined) {
          assertRecordedRunOrigin(snapshot, lineage, key, prior)
          continue
        }
        if (request.signal?.aborted) break sampleLoop
        const inFlight = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
        if (inFlight !== undefined) {
          const recovered = recoveredSampleRecord({ view, sample, side, task: inFlight, snapshot, workspace, actor })
          await sources.evolution.recordExperimentSample(recovered)
          recorded.set(experimentSampleKey(key), recovered)
          continue
        }
        const real = await buildWorkspace(spec.snapshot.sourceDir, workspace, view.frozen.snapshot.digest)
        const outcome = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
          lineage,
          workspace: { path: real },
          ...(side === 'candidate' ? { overlay: { extraSkillRoots: [resolve(sources.evolution.root, sandbox, 'skills')] } } : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }, caller)
        if (outcome.workspace !== undefined && outcome.workspace !== real) {
          throw new Error(
            `the replay of "${sample.taskId}" reported workspace "${outcome.workspace}" but was given "${real}"; ` +
            "a side's frozen input and the directory its run went through must be the same directory",
          )
        }
        const after = await sources.task.openStore(storeId)
        const replayed = after.tasks.find(item => item.taskId === outcome.taskId)
        if (replayed === undefined) {
          throw new Error(`the replay of "${sample.taskId}" created task "${outcome.taskId}", which the store does not hold`)
        }
        const facts = runFactsOf(after, replayed, outcome)
        const fresh = sampleRecord({
          view,
          sample,
          side,
          outcome: facts.outcome,
          ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
          ...(facts.runId === undefined ? {} : { runId: facts.runId }),
          ...(facts.review === undefined ? {} : { review: facts.review }),
          criteria: facts.criteria,
          evidenceRefs: facts.evidenceRefs,
          workspace: real,
          initialDigest: view.frozen.snapshot.digest,
          cost: costOf(facts.review),
          actor,
        })
        await sources.evolution.recordExperimentSample(fresh)
        recorded.set(experimentSampleKey(key), fresh)
        started += 1
        // A run that settled cancelled is a stop somebody asked for: no further
        // side is started under it, and the settled ones stay recorded.
        if (facts.outcome === 'cancelled') break sampleLoop
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (started === 0) throw error instanceof Error ? error : new Error(message)
    throw new Error(
      `${message} (the experiment stopped; ${started} sample run(s) it started settled and stay in the ledger and the task store ` +
      `as evidence — resume experiment ${experimentId} to continue it)`,
    )
  }

  const finalView = await sources.evolution.experiment(experimentId)
  let report: ExperimentReport
  try {
    report = buildExperimentReport(finalView)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} — resume experiment ${experimentId} to continue it`)
  }
  const abs = resolve(sources.evolution.root, finalView.report)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { proposalId: finalView.proposalId, experimentId, report, reportPath: finalView.report, experiment: finalView }
}

/**
 * Resume a frozen experiment by id: its specification *is* the frozen block, so
 * a caller needs to remember nothing but the id. The block is re-derived from
 * the current world before anything runs, and the re-derivation must reproduce
 * the recorded one — a candidate, a sample contract, a model or a snapshot that
 * moved since the experiment froze is refused by name rather than run under a
 * different identity.
 */
export async function resumeExperiment(
  sources: ExperimentSources,
  request: { experimentId: string; caller: SessionId; actor: string; signal?: AbortSignal },
): Promise<ExperimentResult> {
  const view = await sources.evolution.experiment(request.experimentId)
  const spec: ExperimentSpec = {
    proposalId: view.proposalId,
    samples: view.frozen.samples.map(sample => ({ taskId: sample.taskId, role: sample.role })),
    snapshot: { sourceDir: view.frozen.snapshot.sourceDir },
    model: view.frozen.model,
    budget: view.frozen.budget,
    repetition: view.frozen.repetition,
  }
  return runExperiment(sources, {
    spec,
    caller: request.caller,
    actor: request.actor,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
}

/**
 * A recorded sample that cites a run this experiment did not create is refused:
 * the historical champion locates the case and is never a baseline, so a record
 * whose run no run of this experiment's own lineage created is not reused, and
 * nothing downstream is allowed to read it as evidence.
 */
function assertRecordedRunOrigin(snapshot: TaskSnapshot, lineage: string, key: ExperimentKey, record: ExperimentSampleRecord): void {
  if (record.runId === undefined) return
  const task = snapshot.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
  if (task === undefined || !task.runIds.includes(record.runId)) {
    throw new Error(
      `experiment: the recorded sample ${experimentSampleLabel(key)} cites run "${record.runId}", which no run of this ` +
      `experiment's own replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline; ` +
      'the record and the store disagree, so nothing here is reused',
    )
  }
}

/** One sample key a different frozen experiment already spent (§F.2: a re-run needs an explicit new experiment). */
function sameKeyRefusal(key: ExperimentKey, prior: ExperimentSampleRecord, experimentId: string): Error {
  return new Error(
    `experiment: sample ${experimentSampleLabel(key)} is already recorded by experiment ${prior.experimentId} ` +
    `(frozen at ${prior.at}), which is not this one (${experimentId}) — the key is spent and its record is never ` +
    'overwritten; freeze a new experiment at a higher repetition to run this side again',
  )
}

/* -------------------------------------------------------------------------- *
 * The ledger family: record validation and the fold
 * -------------------------------------------------------------------------- */

/**
 * Validate one `experiment_started` line in its own right: the proposal it names
 * exists, the experiment id, frozen digest, budget and report path are exactly
 * what the frozen block derives. Used by the fold and by the service's own write
 * path, so a line that reaches the append is checked the same way one read back
 * from the file is.
 */
export function assertExperimentStartRecord(record: ExperimentStartedRecord, proposals: ReadonlyMap<string, EvolutionProposal>): void {
  if (proposals.get(record.proposalId) === undefined) {
    throw new Error(`evolution: experiment_started record for unknown proposal "${record.proposalId}"`)
  }
  if (typeof record.experimentId !== 'string' || !/^[a-f0-9]{16}$/.test(record.experimentId)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an invalid experiment id`)
  }
  assertFrozenExperiment(record.frozen)
  if (record.frozen.proposalId !== record.proposalId) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" freezes proposal "${record.frozen.proposalId}"`)
  }
  if (record.frozenDigest !== frozenDigestOf(record.frozen)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a digest that does not match its frozen block`)
  }
  if (canonicalJson(record.budget) !== canonicalJson(record.frozen.budget)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" carries a budget that is not the frozen one`)
  }
  if (record.experimentId !== experimentIdOf(record.proposalId, record.frozenDigest)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an id that does not match its frozen identity`)
  }
  if (record.report !== experimentReportPath(record.proposalId, record.experimentId)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" names a report path outside its own sandbox`)
  }
  nonEmpty(record.actor, 'experiment_started actor')
  nonEmpty(record.at, 'experiment_started at')
}

function assertSampleCriteria(criteria: unknown, field: string): asserts criteria is ReviewCriterion[] {
  if (!Array.isArray(criteria)) throw new Error(`evolution: ${field} must be an array`)
  const ids = new Set<string>()
  for (const criterion of criteria) {
    if (criterion === null || typeof criterion !== 'object'
      || typeof (criterion as ReviewCriterion).criterionId !== 'string' || (criterion as ReviewCriterion).criterionId.length === 0
      || !['pass', 'fail', 'inconclusive'].includes((criterion as ReviewCriterion).verdict)
      || ids.has((criterion as ReviewCriterion).criterionId)) {
      throw new Error(`evolution: ${field} has an invalid or duplicate criterion verdict`)
    }
    const detail = criterion as ReviewCriterion
    for (const member of ['verifierId', 'verifierVersion', 'command'] as const) {
      if (detail[member] !== undefined && (typeof detail[member] !== 'string' || detail[member].length === 0)) {
        throw new Error(`evolution: ${field} has a malformed ${member}`)
      }
    }
    if (detail.exitCode !== undefined && typeof detail.exitCode !== 'number') {
      throw new Error(`evolution: ${field} has a malformed exit code`)
    }
    ids.add(detail.criterionId)
  }
}

function assertExperimentSample(record: ExperimentSampleRecord, view: ExperimentView | undefined, key: ExperimentKey): void {
  const field = `experiment_sample record for ${experimentSampleLabel(key)}`
  if (view === undefined) {
    throw new Error(`evolution: ${field} names unknown experiment "${record.experimentId}"`)
  }
  if (view.proposalId !== record.proposalId) throw new Error(`evolution: ${field} names a different proposal than its experiment`)
  if (record.preparedContentDigest !== view.frozen.candidate.sha256) {
    throw new Error(`evolution: ${field} names a candidate content identity that is not the experiment's own`)
  }
  if (record.repetition !== view.frozen.repetition) {
    throw new Error(`evolution: ${field} names a repetition that is not the experiment's own`)
  }
  if (!view.frozen.samples.some(sample => sample.taskId === record.sampleTaskId)) {
    throw new Error(`evolution: ${field} names sample "${record.sampleTaskId}", which the experiment never froze`)
  }
  if (!EXPERIMENT_SIDES.includes(record.side)) {
    throw new Error(`evolution: ${field} has an unknown side "${String(record.side)}"`)
  }
  if (!['verified', 'failed', 'cancelled', 'interrupted'].includes(record.outcome)) {
    throw new Error(`evolution: ${field} has an unknown outcome "${String(record.outcome)}"`)
  }
  for (const member of ['taskId', 'runId', 'reviewRef'] as const) {
    if (record[member] !== undefined && (typeof record[member] !== 'string' || record[member].length === 0)) {
      throw new Error(`evolution: ${field} has a malformed ${member}`)
    }
  }
  if (typeof record.workspace !== 'string' || record.workspace.length === 0) {
    throw new Error(`evolution: ${field} names no workspace`)
  }
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
    throw new Error(`evolution: ${field} has a malformed evidence ref list`)
  }
  assertSampleCriteria(record.criteria, `${field} criteria`)
  if (record.cost === null || typeof record.cost !== 'object') throw new Error(`evolution: ${field} has no cost`)
  if (record.cost.status === 'unknown') {
    if (typeof record.cost.reason !== 'string' || record.cost.reason.length === 0) {
      throw new Error(`evolution: ${field} reports an unknown cost without saying why`)
    }
  } else if (record.cost.status !== 'reported' || record.cost.metrics === null || typeof record.cost.metrics !== 'object') {
    throw new Error(`evolution: ${field} has a malformed cost report`)
  }
  if (record.outcome === 'interrupted') {
    if (typeof record.reason !== 'string' || record.reason.length === 0) {
      throw new Error(`evolution: ${field} is interrupted and must carry the reason it has no terminal run`)
    }
    return
  }
  if (record.initialDigest === undefined || !isHex64(record.initialDigest)) {
    throw new Error(`evolution: ${field} settled a run and must carry the frozen digest its workspace was built from`)
  }
}

/**
 * Fold the ledger's experiment family: every `experiment_started` opens an
 * experiment, every `experiment_sample` must belong to one, and the sample key
 * is unique across the whole ledger. A hand-forged line fails exactly the checks
 * a live write passes — the frozen block is re-hashed, the id re-derived, the
 * budget re-compared, and the record's key parts re-checked against the
 * experiment it claims — so the read path and the write path agree on what a
 * record is.
 *
 * The proposal fold is the other half of the same ledger and is not this
 * function's business; the caller passes its result in for the one cross-check
 * that spans the two (`experiment_started` must name a real proposal).
 */
export function foldExperiments(
  records: readonly { kind: string }[],
  proposals: ReadonlyMap<string, EvolutionProposal>,
): Map<string, ExperimentView> {
  const views = new Map<string, ExperimentView>()
  const keys = new Set<string>()
  for (const raw of records) {
    if (!isExperimentRecord(raw)) continue
    const record = raw as ExperimentStartedRecord | ExperimentSampleRecord
    if (record.kind === 'experiment_started') {
      if (views.has(record.experimentId)) {
        throw new Error(`evolution: experiment "${record.experimentId}" is recorded twice`)
      }
      assertExperimentStartRecord(record, proposals)
      views.set(record.experimentId, {
        experimentId: record.experimentId,
        proposalId: record.proposalId,
        frozen: record.frozen,
        frozenDigest: record.frozenDigest,
        budget: record.budget,
        report: record.report,
        at: record.at,
        samples: [],
      })
      continue
    }
    const view = views.get(record.experimentId)
    const key: ExperimentKey = {
      proposalId: record.proposalId,
      preparedContentDigest: record.preparedContentDigest,
      sampleTaskId: record.sampleTaskId,
      side: record.side,
      repetition: record.repetition,
    }
    assertExperimentSample(record, view, key)
    const id = experimentSampleKey(key)
    if (keys.has(id)) {
      throw new Error(`evolution: sample ${experimentSampleLabel(key)} is recorded twice; a recorded run is never overwritten or re-run`)
    }
    keys.add(id)
    view!.samples.push(record)
  }
  return views
}
