/**
 * The replay experiment (guide §2.7.6, W15): run a prepared mechanical
 * mutation's candidate side — the candidate against this graph's historical
 * terminal tasks (the champions) — and record the comparison. The experiment
 * creates new parentless replay tasks (objective and review anomalies tagged
 * `evolution-replay:<proposalId>`), never edits the historical tree, and never
 * touches production.
 *
 * Per targetType:
 * - `capability`: the champion task re-runs through the real spawn + verify
 *   chain with the mutation's entry as a whole-row `capabilityOverrides`
 *   overlay for that run only.
 * - `task_definition`: deterministic criteria replay — no worker spawn; the
 *   candidate definition's criteria run through the verifier in the graph env.
 * - `agent_preset`: manual in v1 — the agent-presets roster scans
 *   constructor-fixed roots and cannot mount a sandbox-materialized preset, so
 *   nothing executes and the report records the boundary honestly.
 *
 * A `skill` candidate has no path here: its evaluation is the two-sided
 * experiment (§F.2, `experiment.ts`), which runs a new baseline and a new
 * candidate run per frozen sample instead of comparing against a historical
 * champion. Reaching this module with one is a refusal, not a fallback.
 *
 * The champion side of every comparison is the historical task's own terminal
 * review record (self-contained: outcome / criteria / durationMs), never a
 * re-execution. The report lands at `sandbox/<proposalId>/replay-report.json`
 * and the ledger's `replayed` record cites it; `evolution_gate` requires that
 * path in its regression evidence.
 *
 *
 * The model-facing tool adapter (`evolution_replay`, in
 * `@dangosys/dsh-singularity-agent`) declares the tool's schema, extracts the
 * caller, and renders this result; every rule above lives here.
 * @module dsh-singularity-evolution/replay-experiment
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  ProposalTargetType,
  ReviewCriterion,
  ReviewRecord,
  TaskInstance,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityMutation, EvolutionProposal } from './evolution.ts'
import type { ReplayReport, ReplaySideSummary, ReplayTaskComparison } from './replay.ts'
import { compareReplaySides, overallReplayVerdict } from './replay.ts'

/** The lineage tag every replay artifact (objective, review anomalies) carries. */
export function replayLineage(proposalId: string): string {
  return `evolution-replay:${proposalId}`
}

/** Why agent_preset replay is manual in v1 — recorded verbatim in the report. */
export const PRESET_REPLAY_MANUAL_REASON =
  'agent_preset replay is manual in v1: the agent-presets roster (AgentPresets.resolve/mount) scans constructor-fixed roots ' +
  'only and cannot mount a sandbox-materialized preset without reconfiguring the production service; review the sandbox ' +
  'composition under .agent-presets/ by hand and answer the gate accordingly'

const VERIFICATION_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite']

/**
 * The ledger service the experiment records through, as this module uses it: the
 * sandbox root it materialized under and the `replayed` transition itself.
 */
export interface ReplayLedger {
  /** Absolute ledger directory; the sandbox and the report live under it. */
  readonly root: string
  get(proposalId: string): Promise<EvolutionProposal>
  replay(proposalId: string, actor: string, report: ReplayReport): Promise<EvolutionProposal>
}

/**
 * The graph / task / task-runtime services the experiment reads, as the caller's
 * context holds them. Only the members used here are named, so a caller cannot
 * hand over a capability this module has no business taking (guide §1.5).
 */
export interface ReplayExperimentSources {
  readonly evolution: ReplayLedger
  readonly graphs: { graphForSession(sessionId: SessionId): Promise<{ readonly rootSessionId: SessionId }> }
  readonly task: { openStore(storeId: string): Promise<TaskSnapshot> }
  readonly taskRuntime: {
    replayTask(storeId: string, championTaskId: string, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>
  }
}

export interface ReplayExperimentRequest {
  readonly proposalId: string
  /** Champion task ids replayed as the observed set. */
  readonly taskIds: readonly string[]
  /** Champion task ids replayed the same way but reported as the held-out group. */
  readonly holdoutTaskIds: readonly string[]
  readonly caller: SessionId
  readonly signal?: AbortSignal
}

/** What one replay experiment produced: the recorded report and the comparison groups, for the caller to render. */
export interface ReplayExperimentResult {
  readonly proposalId: string
  readonly targetType: ProposalTargetType
  readonly targetId: string
  /** The report exactly as recorded in the ledger. */
  readonly report: ReplayReport
  /** Report path relative to the ledger root. */
  readonly reportPath: string
  readonly observed: readonly ReplayTaskComparison[]
  readonly holdout: readonly ReplayTaskComparison[]
  /** True for the agent_preset v1 boundary: nothing executed, `manualReason` says why. */
  readonly manual: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The terminal review record of a champion task's latest run — the comparison anchor. */
function championRecord(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

function sideFromRecord(task: TaskInstance, record: ReviewRecord): ReplaySideSummary {
  return {
    taskId: task.taskId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    outcome: record.outcome as ReplaySideSummary['outcome'],
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    criteria: (record.criteria ?? []).map((item: ReviewCriterion) => ({
      criterionId: item.criterionId,
      verdict: item.verdict,
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    })),
  }
}

function sideFromOutcome(outcome: ReplayRunOutcome): ReplaySideSummary {
  return {
    taskId: outcome.taskId,
    runId: outcome.runId,
    outcome: outcome.status,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    criteria: (outcome.criteria ?? []).map((item: ReviewCriterion) => ({
      criterionId: item.criterionId,
      verdict: item.verdict,
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    })),
  }
}

/**
 * Normalize the candidate definition's contract for a deterministic criteria
 * replay. The definition is the free-form object the mutation carried; the
 * replay needs real criteria, so a missing/empty `acceptanceCriteria` or a
 * criterion without a `criterionId` fails loudly. Fields the definition omits
 * (objective / requiredCapabilities) fall back to the champion task's.
 */
function candidateContract(
  definition: unknown,
  champion: TaskInstance,
): { objective: string; acceptanceCriteria: AcceptanceCriterion[]; requiredCapabilities: string[] } {
  if (!isRecord(definition)) throw new Error('evolution_replay: the sandbox task-definition.json must hold an object')
  const rawCriteria = definition.acceptanceCriteria
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    throw new Error('evolution_replay: the candidate definition must carry a non-empty acceptanceCriteria array')
  }
  const acceptanceCriteria: AcceptanceCriterion[] = rawCriteria.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}] must be an object`)
    if (typeof raw.criterionId !== 'string' || raw.criterionId.length === 0) {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].criterionId must be a non-empty string`)
    }
    const command = raw.command === undefined ? undefined : raw.command
    if (command !== undefined && typeof command !== 'string') {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].command must be a string`)
    }
    const mode = raw.verificationMode ?? (command === undefined ? 'review' : 'deterministic')
    if (typeof mode !== 'string' || !VERIFICATION_MODES.includes(mode as VerificationMode)) {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].verificationMode must be one of ${VERIFICATION_MODES.join(' / ')}`)
    }
    return {
      criterionId: raw.criterionId,
      description: typeof raw.description === 'string' ? raw.description : '',
      verificationMode: mode as VerificationMode,
      requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((item): item is string => typeof item === 'string') : [],
      mandatory: typeof raw.mandatory === 'boolean' ? raw.mandatory : true,
      ...(command === undefined ? {} : { command }),
    }
  })
  return {
    objective: typeof definition.objective === 'string' && definition.objective.length > 0 ? definition.objective : champion.objective,
    acceptanceCriteria,
    requiredCapabilities: Array.isArray(definition.requiredCapabilities)
      ? definition.requiredCapabilities.filter((item): item is string => typeof item === 'string')
      : [...champion.requestedCapabilities],
  }
}

/**
 * Run one replay experiment and record it. Every refusal throws with the text
 * the model-facing adapter reports after its own `evolution_replay rejected:`
 * prefix; nothing is recorded on any refusal, and the runs that did settle stay
 * in the task store as evidence (said in the mid-flight failure message).
 */
export async function runReplayExperiment(
  sources: ReplayExperimentSources,
  request: ReplayExperimentRequest,
): Promise<ReplayExperimentResult> {
  const { proposalId, caller } = request
  const proposal = await sources.evolution.get(proposalId)
  if (proposal.status !== 'prepared') {
    throw new Error(`proposal ${proposal.proposalId} is ${proposal.status}; only a prepared proposal can be replayed`)
  }
  const prepared = proposal.prepared!
  if (!prepared.mechanical) {
    throw new Error(
      `proposal ${proposal.proposalId} is bookkeeping-only (mechanical: false); nothing to replay — ` +
      'gate it directly with evolution_gate',
    )
  }
  // A skill candidate is evaluated by the two-sided experiment, never here:
  // this path compares against the historical champion, which §F.2 forbids for
  // a skill replacement. A caller reaching it with one is refused by name
  // rather than silently compared against a baseline nobody re-ran.
  if (proposal.targetType === 'skill') {
    throw new Error(
      `proposal ${proposal.proposalId} targets "skill": a skill candidate is evaluated by the two-sided experiment ` +
      '(a new baseline run and a new candidate run per frozen sample), not by this candidate-vs-champion replay',
    )
  }
  const lineage = replayLineage(proposal.proposalId)

  // agent_preset: the v1 manual boundary — record it, execute nothing.
  if (proposal.targetType === 'agent_preset') {
    const report: ReplayReport = {
      formatVersion: 1,
      proposalId: proposal.proposalId,
      targetType: proposal.targetType,
      at: new Date().toISOString(),
      mode: 'manual',
      manualReason: PRESET_REPLAY_MANUAL_REASON,
      observed: [],
      holdout: { executed: false, tasks: [] },
      verdict: 'manual',
    }
    const replayed = await sources.evolution.replay(proposal.proposalId, caller, report)
    return {
      proposalId: replayed.proposalId,
      targetType: proposal.targetType,
      targetId: proposal.targetId,
      report,
      reportPath: replayed.replayed!.report,
      observed: [],
      holdout: [],
      manual: true,
    }
  }

  const taskIds = [...request.taskIds]
  const holdoutIds = [...request.holdoutTaskIds]
  if (taskIds.length === 0) throw new Error('taskIds must name at least one champion task')
  if (new Set([...taskIds, ...holdoutIds]).size !== taskIds.length + holdoutIds.length) {
    throw new Error('taskIds and holdoutTaskIds must not overlap or repeat')
  }

  let snapshot: TaskSnapshot
  let storeId: string
  try {
    const graph = await sources.graphs.graphForSession(caller)
    storeId = rootTaskStoreId(graph.rootSessionId)
    snapshot = await sources.task.openStore(storeId)
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Validate every champion up front — a replay that starts must not die
  // halfway on a task that was never replayable.
  const champions = new Map<string, { task: TaskInstance; record: ReviewRecord }>()
  for (const taskId of [...taskIds, ...holdoutIds]) {
    const task = snapshot.tasks.find(item => item.taskId === taskId)
    if (task === undefined) throw new Error(`unknown task "${taskId}" in this graph's task store`)
    if (task.status !== 'verified' && task.status !== 'failed') {
      throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task can be a replay champion`)
    }
    const record = championRecord(snapshot, task)
    if (record === undefined) {
      throw new Error(`task "${taskId}" has no review record on its latest run; nothing to compare the candidate against`)
    }
    champions.set(taskId, { task, record })
  }

  const sandboxAbs = join(sources.evolution.root, prepared.sandbox!)
  const mutation = proposal.mutation
  const comparisons: { taskId: string; holdout: boolean; comparison: ReplayTaskComparison }[] = []
  try {
    for (const [taskId, holdout] of [...taskIds.map(id => [id, false] as const), ...holdoutIds.map(id => [id, true] as const)]) {
      const { task: champion, record } = champions.get(taskId)!
      let options: Pick<ReplayTaskOptions, 'overlay' | 'contract' | 'spawn'>
      if (proposal.targetType === 'capability') {
        const capability = mutation as CapabilityMutation
        options = { overlay: { capabilityOverrides: { [capability.name]: capability.entry } } }
      } else if (proposal.targetType === 'task_definition') {
        const definition = JSON.parse(await readFile(join(sandboxAbs, 'task-definition.json'), 'utf8'))
        options = { contract: candidateContract(definition, champion), spawn: false }
      } else {
        throw new Error(`evolution_replay: targetType "${proposal.targetType}" has no replay path`)
      }
      const outcome = await sources.taskRuntime.replayTask(storeId, taskId, { lineage, ...options, signal: request.signal }, caller)
      const championSide = sideFromRecord(champion, record)
      const candidateSide = sideFromOutcome(outcome)
      comparisons.push({
        taskId,
        holdout,
        comparison: {
          taskId,
          candidateTaskId: outcome.taskId,
          champion: championSide,
          candidate: candidateSide,
          ...compareReplaySides(championSide, candidateSide),
        },
      })
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (no replay was recorded; ${comparisons.length} ` +
      'run(s) already settled stay in the task store as evidence)',
    )
  }

  const observed = comparisons.filter(item => !item.holdout).map(item => item.comparison)
  const holdout = comparisons.filter(item => item.holdout).map(item => item.comparison)
  const report: ReplayReport = {
    formatVersion: 1,
    proposalId: proposal.proposalId,
    targetType: proposal.targetType,
    at: new Date().toISOString(),
    mode: 'executed',
    observed,
    holdout: { executed: holdout.length > 0, tasks: holdout },
    verdict: overallReplayVerdict([...observed, ...holdout]),
  }
  const replayed = await sources.evolution.replay(proposal.proposalId, caller, report)
  return {
    proposalId: replayed.proposalId,
    targetType: proposal.targetType,
    targetId: proposal.targetId,
    report,
    reportPath: replayed.replayed!.report,
    observed,
    holdout,
    manual: false,
  }
}
