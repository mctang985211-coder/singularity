/** The experiment's records and report: sample records, the report builder and the fold that reads them back.
 * @module dsh-singularity-evolution/experiment/record */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId, sha256Hex, TERMINAL_RUN_STATUSES } from '@dangosys/dsh-singularity-task'
import type {
  ReviewCriterion,
  ReviewRecord,
  RunStatus,
  TaskInstance,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { resolveCapabilities } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal } from '../evolution.ts'
import type {
  ExperimentAdmissionRefusal,
  ExperimentBudget,
  ExperimentCost,
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentSide,
  ExperimentSideDetail,
  FrozenSample,
} from '../replay.ts'
import {
  assertAdmissionRecord,
  assertExperimentReport,
  assertFrozenExperiment,
  canonicalJson,
  compareExperimentSides,
  digestOf,
  EXPERIMENT_OUTCOMES,
  EXPERIMENT_SIDES,
  frozenDigestOf,
  overallExperimentVerdict,
} from '../replay.ts'
import { isHex64 } from '../shared.ts'
import type { ExperimentKey, ExperimentSampleRecord, ExperimentStartedRecord } from './spec.ts'
import { nonEmpty } from './spec.ts'
import type { ExperimentSources, ExperimentView } from './freeze.ts'
import { isExperimentRecord, preparedContentDigestOf, refusedProviderLines } from './freeze.ts'
import { walkSnapshotInput } from './workspace.ts'

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
function experimentSampleLabel(key: ExperimentKey): string {
  return `${key.sampleTaskId}/${key.side}#${key.repetition}`
}

/** The recursive content digest of a directory — the input snapshot identity the freeze fixes. */
export async function directoryDigest(directory: string): Promise<string> {
  const lines: string[] = []
  await walkSnapshotInput(directory, async entry => {
    if (entry.kind !== 'file') return
    lines.push(`${entry.rel}\0${sha256Hex(entry.bytes)}`)
  })
  return sha256Hex(lines.join('\n'))
}

/** The task's latest review record — its terminal outcome is what makes a sample a sample. */
export function latestReview(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

export function reviewRefOf(review: ReviewRecord): string {
  return `${review.taskId}#${review.runId ?? 'no-run'}`
}

/** Read reported cost; a supplied snapshot requires complete tool-call counters from the whole executed Run subtree. */
export function costOf(review: ReviewRecord | undefined, snapshot?: TaskSnapshot): ExperimentCost {
  if (review === undefined) {
    return { status: 'unknown', reason: 'the run settled no review record, so no cost was reported for it' }
  }
  const metrics = review.metrics
  if (metrics === undefined) {
    return { status: 'unknown', reason: "the run's review record carries no metrics, so no cost was reported for it" }
  }
  if (metrics.tokens === undefined && metrics.toolCalls === undefined) {
    return {
      status: 'unknown',
      reason: "the run's review record carries metrics but no token and no tool-call counters",
    }
  }
  if (snapshot === undefined) return { status: 'reported', metrics: structuredClone(metrics) }
  const root = snapshot.runs.find(run => run.runId === review.runId && run.taskId === review.taskId)
  if (root === undefined) return { status: 'unknown', reason: 'the measured side has no Run in its task store' }
  const runIds = new Set([root.runId])
  let size = 0
  while (size !== runIds.size) {
    size = runIds.size
    for (const run of snapshot.runs) {
      if (run.parentRunId !== undefined && runIds.has(run.parentRunId)) runIds.add(run.runId)
    }
  }
  let calls = 0
  let failures = 0
  for (const run of snapshot.runs.filter(item => runIds.has(item.runId))) {
    const record = snapshot.reviews.find(item => item.runId === run.runId && item.taskId === run.taskId)
    const counters = record?.metrics?.toolCalls
    if (!TERMINAL_RUN_STATUSES.has(run.status) || counters === undefined ||
        !Number.isSafeInteger(counters.calls) || counters.calls < 0 ||
        !Number.isSafeInteger(counters.failures) || counters.failures < 0) {
      return { status: 'unknown', reason: `Run ${run.runId} in the executed subtree has no complete terminal tool-call counters` }
    }
    calls += counters.calls
    failures += counters.failures
  }
  if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(failures)) {
    return { status: 'unknown', reason: 'the executed subtree tool-call counters exceed safe integer range' }
  }
  return { status: 'reported', metrics: { ...structuredClone(metrics), toolCalls: { calls, failures } } }
}

/** The evidence ids of one run: the review record's own list, or the store's verdict evidence when the review carries none. */
export function evidenceRefsOf(
  snapshot: TaskSnapshot,
  runId: string | undefined,
  review: ReviewRecord | undefined,
): string[] {
  if (review !== undefined) return [...review.evidenceRefs]
  if (runId === undefined) return []
  return snapshot.evidence.filter(bundle => bundle.taskRunId === runId).map(bundle => bundle.evidenceId)
}

/** The review record's criteria, or the run's own verdicts when the review carries none. */
export function criteriaOf(review: ReviewRecord | undefined, outcome: ReplayRunOutcome | undefined): ReviewCriterion[] {
  return structuredClone([...(review?.criteria ?? outcome?.criteria ?? [])])
}

/** One criterion as the report carries it: the verdict plus the verifier that decided it (v1's report dropped the identity). */
export function criterionDetail(criterion: ReviewCriterion): ExperimentSideDetail['criteria'][number] {
  return {
    criterionId: criterion.criterionId,
    verdict: criterion.verdict,
    ...(criterion.verifierId === undefined ? {} : { verifierId: criterion.verifierId }),
    ...(criterion.verifierVersion === undefined ? {} : { verifierVersion: criterion.verifierVersion }),
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
  }
}

/** What reading one run out of the store produced — the one place store facts.
 * A terminal settlement is recorded as it stands; a run with no terminal status is an interruption. */
export interface RunFacts {
  outcome: ExperimentSideDetail['outcome']
  taskId?: string
  runId?: string
  review?: ReviewRecord
  criteria: ReviewCriterion[]
  evidenceRefs: string[]
  terminal: boolean
  detail: string
  /** Why a terminal side still records `interrupted`: a blocked run is a dead end the experiment has no outcome for. */
  interruptedReason?: string
}

/** How a settled run's own status reads in the experiment's outcome vocabulary: a blocked
 * run is a dead end and a running one never settles, so neither is an experiment outcome. */
const OUTCOME_OF_STATUS: Readonly<Record<RunStatus, ExperimentSideDetail['outcome']>> = {
  verified: 'verified',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'interrupted',
  running: 'interrupted',
}

export function runFactsOf(
  snapshot: TaskSnapshot,
  task: TaskInstance,
  settled: ReplayRunOutcome | undefined,
): RunFacts {
  const runId = settled?.runId ?? task.runIds[task.runIds.length - 1]
  const run = runId === undefined ? undefined : snapshot.runs.find(item => item.runId === runId)
  const review = runId === undefined ? undefined : snapshot.reviews.find(item => item.runId === runId)
  const status =
    review !== undefined && TERMINAL_RUN_STATUSES.has(review.outcome)
      ? review.outcome
      : run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)
        ? run.status
        : undefined
  const detail =
    runId === undefined
      ? "the store holds no run of this side's task"
      : run === undefined
        ? `the store holds no run "${runId}" of this side's task`
        : `the store holds run ${run.runId} as ${run.status}${run.executionPhase === undefined ? '' : ` (${run.executionPhase})`} with ${
            review === undefined ? 'no terminal review record' : `a terminal review record (${review.outcome})`
          }`
  const interruptedReason =
    status === 'blocked'
      ? `the store holds run ${runId} as blocked, a dead end no transition resumes, and the experiment has no blocked outcome; ` +
        'the side is recorded interrupted'
      : undefined
  return {
    outcome: status === undefined ? 'interrupted' : OUTCOME_OF_STATUS[status],
    taskId: task.taskId,
    ...(runId === undefined ? {} : { runId }),
    ...(review === undefined ? {} : { review }),
    criteria: criteriaOf(review, settled),
    evidenceRefs: evidenceRefsOf(snapshot, runId, review),
    terminal: status !== undefined,
    detail,
    ...(interruptedReason === undefined ? {} : { interruptedReason }),
  }
}

/** The one ledger line a sample side writes, from the facts its run settled to. */
export function sampleRecord(input: {
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
  /** The runtime's own admission refusal, for a side the runtime refused before a run existed (A6). */
  admission?: ExperimentAdmissionRefusal
  actor: string
}): ExperimentSampleRecord {
  return {
    formatVersion: 4,
    kind: 'experiment_sample',
    proposalId: input.view.proposalId,
    experimentId: input.view.experimentId,
    preparedContentDigest: preparedContentDigestOf(input.view.frozen),
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
    ...(input.admission === undefined ? {} : { admission: structuredClone(input.admission) }),
    actor: input.actor,
    at: new Date().toISOString(),
  }
}

/** One sample side that has a run in the store but no record: a process died mid-experiment. */
export function recoveredSampleRecord(input: {
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
    cost: costOf(facts.review, input.view.frozen.objective === 'tool-call-reduction' ? input.snapshot : undefined),
    ...(facts.interruptedReason === undefined ? {} : { reason: facts.interruptedReason }),
    actor: input.actor,
  })
}

/** One side's detail as the report carries it, read off the ledger record and nothing else. */
export function sideDetailOf(view: ExperimentView, sample: FrozenSample, side: ExperimentSide): ExperimentSideDetail {
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
    ...(record.admission === undefined ? {} : { admission: structuredClone(record.admission) }),
  }
}

/** The key one frozen sample's side has under one experiment. */
export function experimentSampleKeyOf(
  view: Pick<ExperimentView, 'proposalId' | 'frozen'>,
  sampleTaskId: string,
  side: ExperimentSide,
): ExperimentKey {
  return {
    proposalId: view.proposalId,
    preparedContentDigest: preparedContentDigestOf(view.frozen),
    sampleTaskId,
    side,
    repetition: view.frozen.repetition,
  }
}

/** Build the v3 report from the ledger records alone — the same records always reproduce the same bytes. */
export function buildExperimentReport(view: ExperimentView): ExperimentReport {
  const missing = view.frozen.samples.flatMap(sample =>
    EXPERIMENT_SIDES.filter(
      side => !view.samples.some(item => item.sampleTaskId === sample.taskId && item.side === side),
    ).map(side => `${sample.taskId}/${side}`),
  )
  if (missing.length > 0) {
    throw new Error(
      `experiment ${view.experimentId} is incomplete — no record for ${missing.join(', ')}; the settled runs stay recorded`,
    )
  }
  const samples: ExperimentSampleComparison[] = view.frozen.samples.map(sample => {
    const baseline = sideDetailOf(view, sample, 'baseline')
    const candidate = sideDetailOf(view, sample, 'candidate')
    return {
      taskId: sample.taskId,
      role: sample.role,
      baseline,
      candidate,
      verdict: compareExperimentSides(sample.role, baseline, candidate, view.frozen.objective),
    }
  })
  const at = [view.at, ...view.samples.map(record => record.at)].reduce((left, right) => (left > right ? left : right))
  const report: ExperimentReport = {
    formatVersion: 3,
    proposalId: view.proposalId,
    experimentId: view.experimentId,
    at,
    frozen: view.frozen,
    frozenDigest: view.frozenDigest,
    samples,
    verdict: overallExperimentVerdict(samples, view.frozen.objective),
  }
  assertExperimentReport(report)
  return report
}

/** The store one experiment reads: the caller's graph root, exactly as the v1 replay resolves it. */
export async function experimentStore(
  sources: ExperimentSources,
  caller: SessionId,
): Promise<{ storeId: string; snapshot: TaskSnapshot }> {
  try {
    const graph = await sources.graphs.graphForSession(caller)
    const storeId = rootTaskStoreId(graph.rootSessionId)
    return { storeId, snapshot: await sources.task.openStore(storeId) }
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The token total one settled side reported: the four buckets the run's own review record carries. */
export function tokensOfRecord(record: ExperimentSampleRecord): number | undefined {
  if (record.cost.status !== 'reported') return undefined
  const tokens = record.cost.metrics.tokens
  if (tokens === undefined || typeof tokens !== 'object') return undefined
  const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

/** The known token total of a set of settled sides: every reported four-bucket sum, added up. */
export function reportedTokensSpent(records: readonly ExperimentSampleRecord[]): number {
  return records.reduce((sum, record) => sum + (tokensOfRecord(record) ?? 0), 0)
}

/** Whether the frozen budget still leaves room for one more side to start (S4-E §F.2). */
export function assertBudgetAllowsStart(input: {
  experimentId: string
  budget: ExperimentBudget
  spentTokens: number
  settledSides: number
  /** The side this start would be, for the refusal to name what it declines. */
  where: string
}): void {
  const { experimentId, budget, spentTokens, settledSides, where } = input
  if (budget.maxTokens !== undefined && spentTokens >= budget.maxTokens) {
    const left = budget.maxTokens - spentTokens
    const position =
      left > 0 ? `${left} tokens left` : left === 0 ? 'the ceiling exactly consumed' : `${-left} over the ceiling`
    throw new Error(
      `evolution: experiment "${experimentId}" is stopped by its frozen budget — maxTokens ${budget.maxTokens} is the whole ` +
        `experiment's ceiling and its ${settledSides} settled side(s) already report ${spentTokens} tokens (${position}), so no further ` +
        `sample side is started (${where} would have been next); the settled runs stay in the task store and the ledger as what this ` +
        'experiment spent, and a promotion whose recorded total passes the ceiling is refused rather than inferred',
    )
  }
}

/** Attempt one capability sample's baseline side for real, and return the runtime's own refusal. */
export async function refusedBaselineRun(input: {
  sources: ExperimentSources
  storeId: string
  sample: FrozenSample
  lineage: string
  workspace: string
  agentOptions: ReplayTaskOptions['agentOptions']
  caller: SessionId
  signal?: AbortSignal
}): Promise<string> {
  const { sources, storeId, sample, lineage, workspace, caller } = input
  const admission = sample.admission!
  let refusal: string | undefined
  let returned: ReplayRunOutcome | undefined
  try {
    returned = await sources.taskRuntime.replayTask(
      storeId,
      sample.taskId,
      {
        lineage,
        workspace: { path: workspace },
        agentOptions: { ...input.agentOptions },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      caller,
    )
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  if (returned !== undefined) {
    throw new Error(
      `evolution: the production configuration admitted sample "${sample.taskId}" (replay settled ${returned.status}) although the ` +
        `experiment froze its refusal at admission — the configuration moved since the experiment froze, so freeze a new experiment ` +
        'rather than record either story for this side',
    )
  }
  const after = await sources.task.openStore(storeId)
  const persisted = after.tasks.find(item => item.objective.startsWith(`[${lineage}] `))
  if (persisted !== undefined) {
    throw new Error(
      `evolution: the baseline side of sample "${sample.taskId}" was expected to be refused at admission, but the store holds task ` +
        `"${persisted.taskId}" of this side's own lineage — a side that reached the store is a run, and a run is not an admission refusal`,
    )
  }
  const message = refusal ?? 'the runtime refused this replay without a message'
  if (!message.startsWith('task-runtime: ')) {
    throw new Error(
      `evolution: the baseline side of sample "${sample.taskId}" failed before its run for a reason that is not the runtime's own ` +
        `admission refusal (${message}) — the side is not recorded as not-admitted`,
    )
  }
  const table = sources.taskRuntime.listCapabilities?.()
  if (table === undefined) {
    throw new Error(
      `evolution: the effective capability table cannot be read now, so the admission refusal of sample "${sample.taskId}" cannot be ` +
        're-proved — nothing was recorded for this side',
    )
  }
  const stillRefused =
    admission.source === 'capability-gap'
      ? resolveCapabilities(admission.required, table).missing.length > 0
      : refusedProviderLines(await sources.taskRuntime.capabilityProviderReport(caller, admission.required)).length > 0
  if (!stillRefused) {
    throw new Error(
      `evolution: sample "${sample.taskId}" was frozen as refused at admission (${admission.source}), but the runtime no longer ` +
        `refuses it — the configuration moved since the freeze; freeze a new experiment rather than record a refusal that no longer holds`,
    )
  }
  return message
}

/** A recorded sample that cites a run this experiment did not create is refused by name. */
export function assertRecordedRunOrigin(
  snapshot: TaskSnapshot,
  lineage: string,
  key: ExperimentKey,
  record: ExperimentSampleRecord,
): void {
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
export function sameKeyRefusal(key: ExperimentKey, prior: ExperimentSampleRecord, experimentId: string): Error {
  return new Error(
    `experiment: sample ${experimentSampleLabel(key)} is already recorded by experiment ${prior.experimentId} ` +
      `(frozen at ${prior.at}), which is not this one (${experimentId}) — the key is spent and its record is never ` +
      'overwritten; freeze a new experiment at a higher repetition to run this side again',
  )
}

/** Validate one `experiment_started` line in its own right: the proposal it names and the sandbox it froze. */
export function assertExperimentStartRecord(
  record: ExperimentStartedRecord,
  proposals: ReadonlyMap<string, EvolutionProposal>,
): void {
  if (proposals.get(record.proposalId) === undefined) {
    throw new Error(`evolution: experiment_started record for unknown proposal "${record.proposalId}"`)
  }
  if (typeof record.experimentId !== 'string' || !/^[a-f0-9]{16}$/.test(record.experimentId)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an invalid experiment id`)
  }
  assertFrozenExperiment(record.frozen)
  if (record.frozen.proposalId !== record.proposalId) {
    throw new Error(
      `evolution: experiment_started record for "${record.proposalId}" freezes proposal "${record.frozen.proposalId}"`,
    )
  }
  if (record.frozenDigest !== frozenDigestOf(record.frozen)) {
    throw new Error(
      `evolution: experiment_started record for "${record.proposalId}" has a digest that does not match its frozen block`,
    )
  }
  if (canonicalJson(record.budget) !== canonicalJson(record.frozen.budget)) {
    throw new Error(
      `evolution: experiment_started record for "${record.proposalId}" carries a budget that is not the frozen one`,
    )
  }
  if (record.experimentId !== experimentIdOf(record.proposalId, record.frozenDigest)) {
    throw new Error(
      `evolution: experiment_started record for "${record.proposalId}" has an id that does not match its frozen identity`,
    )
  }
  if (record.report !== experimentReportPath(record.proposalId, record.experimentId)) {
    throw new Error(
      `evolution: experiment_started record for "${record.proposalId}" names a report path outside its own sandbox`,
    )
  }
  if (record.storeId !== undefined && (typeof record.storeId !== 'string' || record.storeId.length === 0)) {
    throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a malformed task store id`)
  }
  nonEmpty(record.actor, 'experiment_started actor')
  nonEmpty(record.at, 'experiment_started at')
}

export function assertSampleCriteria(criteria: unknown, field: string): asserts criteria is ReviewCriterion[] {
  if (!Array.isArray(criteria)) throw new Error(`evolution: ${field} must be an array`)
  const ids = new Set<string>()
  for (const criterion of criteria) {
    if (
      criterion === null ||
      typeof criterion !== 'object' ||
      typeof (criterion as ReviewCriterion).criterionId !== 'string' ||
      (criterion as ReviewCriterion).criterionId.length === 0 ||
      !['pass', 'fail', 'inconclusive'].includes((criterion as ReviewCriterion).verdict) ||
      ids.has((criterion as ReviewCriterion).criterionId)
    ) {
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

export function assertExperimentSample(
  record: ExperimentSampleRecord,
  view: ExperimentView | undefined,
  key: ExperimentKey,
): void {
  const field = `experiment_sample record for ${experimentSampleLabel(key)}`
  if (view === undefined) {
    throw new Error(`evolution: ${field} names unknown experiment "${record.experimentId}"`)
  }
  if (view.proposalId !== record.proposalId)
    throw new Error(`evolution: ${field} names a different proposal than its experiment`)
  if (record.preparedContentDigest !== preparedContentDigestOf(view.frozen)) {
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
  if (!EXPERIMENT_OUTCOMES.includes(record.outcome)) {
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
  if (
    !Array.isArray(record.evidenceRefs) ||
    record.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)
  ) {
    throw new Error(`evolution: ${field} has a malformed evidence ref list`)
  }
  assertSampleCriteria(record.criteria, `${field} criteria`)
  if (record.cost === null || typeof record.cost !== 'object') throw new Error(`evolution: ${field} has no cost`)
  if (record.cost.status === 'unknown') {
    if (typeof record.cost.reason !== 'string' || record.cost.reason.length === 0) {
      throw new Error(`evolution: ${field} reports an unknown cost without saying why`)
    }
  } else if (
    record.cost.status !== 'reported' ||
    record.cost.metrics === null ||
    typeof record.cost.metrics !== 'object'
  ) {
    throw new Error(`evolution: ${field} has a malformed cost report`)
  }
  if (record.outcome === 'not-admitted') {
    // A6: the runtime refused this side at admission. The record is the runtime's own words, never an invented failure.
    if (record.side !== 'baseline') {
      throw new Error(
        `evolution: ${field} records the candidate side as not-admitted — a candidate the runtime will not admit produced no run, so ` +
          'it fixed nothing and cannot stand as a fix; only a baseline side may be not-admitted',
      )
    }
    if (record.admission === undefined) {
      throw new Error(
        `evolution: ${field} is not-admitted without the runtime's refusal — a side with no run must record why`,
      )
    }
    assertAdmissionRecord(record.admission, field)
    if (record.taskId !== undefined || record.runId !== undefined || record.reviewRef !== undefined) {
      throw new Error(
        `evolution: ${field} is not-admitted and cites a task, a run or a review — a refused side produced no run, and a failure run ` +
          'invented in its place is not evidence',
      )
    }
    if (record.evidenceRefs.length > 0 || record.criteria.length > 0) {
      throw new Error(`evolution: ${field} is not-admitted and cites evidence or criteria — no run produced any`)
    }
    return
  }
  if (record.admission !== undefined) {
    throw new Error(`evolution: ${field} carries an admission refusal but settled as "${String(record.outcome)}"`)
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

/** Fold the ledger's experiment family: every `experiment_started` opens an experiment, every sample record joins one. */
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
        ...(record.storeId === undefined ? {} : { storeId: record.storeId }),
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
      throw new Error(
        `evolution: sample ${experimentSampleLabel(key)} is recorded twice; a recorded run is never overwritten or re-run`,
      )
    }
    keys.add(id)
    view!.samples.push(record)
  }
  return views
}
