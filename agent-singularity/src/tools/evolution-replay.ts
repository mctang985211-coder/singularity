/**
 * `evolution_replay` (guide §2.7.6, W15 / S4-E §F.2): evaluate a prepared
 * mechanical mutation and record the comparison.
 *
 * Two evaluation paths, chosen by what the proposal targets — a routing
 * decision the tool owns because it is a property of the *call*, not of the
 * ledger:
 *
 * - a **skill** candidate that replaces an existing `SKILL.md` is evaluated by
 *   the two-sided experiment ({@link ExperimentSpec}): every sample runs the
 *   baseline and the candidate as *new* runs of this graph, each in its own
 *   workspace built from one frozen snapshot. The sample roles are derived from
 *   the store's own history here rather than taken from the caller (§F.2): the
 *   caller names tasks, the ledger's latest review calls each one an observed
 *   failure, an observed regression or a holdout;
 * - every other target type keeps the v1 replay path
 *   ({@link runReplayExperiment}) unchanged: the candidate against the
 *   historical terminal records, agent_preset manual.
 *
 * What this adapter supplies beyond the call's own arguments: the caller
 * session (from the live call), the input snapshot both experiment workspaces
 * are built from — the workspace the caller's session runs in, read through
 * `TaskRuntime.workspacePathFor` — and the model identity the experiment
 * freezes, read through the evolution service's injected resolver
 * (`EvolutionService.modelIdentity`), the same source the promotion gate
 * re-reads. All three are read, never asked of the model: a caller's prose is
 * not evidence of where a run happened or which model ran it.
 *
 * The experiment itself (its frozen identity, the per-sample workspaces, the
 * idempotency keys, the report and its ledger records) and the v1 replay both
 * live in `@dangosys/dsh-singularity-evolution`; this adapter declares the tool,
 * derives the call's identity, and renders what came back.
 * @module dsh-singularity-agent/tools/evolution-replay
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { PRESET_REPLAY_MANUAL_REASON, runReplayExperiment } from '@dangosys/dsh-singularity-evolution'
import type {
  ExperimentBudget,
  ExperimentCriterionDetail,
  ExperimentResult,
  ExperimentSampleSpec,
  ReplayExperimentResult,
  ReplayTaskComparison,
} from '@dangosys/dsh-singularity-evolution'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_replay: missing agent id')
  return id
}

/**
 * The model identity this experiment freezes — read from the evolution plane's
 * injected resolver, never from the caller (§F.2: the model is frozen before the
 * runs, and a model-filled string could not be one). The injection is the whole
 * point: the promotion gate re-reads the same resolver off the same service, so
 * the identity this call freezes is the one that gate later compares against.
 * A deployment that cannot name its model gets the service's own refusal here —
 * before any run, before any ledger line.
 */
function modelIdentity(ctx: Context): string {
  return ctx.evolution.modelIdentity()
}

/** The workspace the caller's own session runs in — the frozen input snapshot both experiment sides are built from. */
async function callerWorkspace(ctx: Context, caller: SessionId): Promise<string> {
  const runtime = optionalService<{ workspacePathFor?(sessionId: string): Promise<string | undefined> }>(ctx, 'taskRuntime')
  let path: string | undefined
  try {
    path = await runtime?.workspacePathFor?.(caller)
  } catch (error) {
    throw new Error(`cannot resolve the caller session's workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(
      `this deployment cannot name the workspace of session "${caller}", which the experiment would freeze as its input ` +
      'snapshot — name the caller\'s env workspace (S4-E item 2) before evaluating a skill candidate',
    )
  }
  return path
}

/** The task's latest review record — the record a sample's role is read from. */
function latestReview(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

/**
 * The role one named task has, from the store's own history: its latest review
 * decides whether the case is a failure the candidate is meant to fix or a
 * passing case it must not break. The caller names tasks; it does not get to
 * label them (§F.2).
 */
function roleOf(snapshot: TaskSnapshot, taskId: string): ExperimentSampleSpec['role'] {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`unknown task "${taskId}" in this graph's task store`)
  if (task.status !== 'verified' && task.status !== 'failed') {
    throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task carries the history a role is read from`)
  }
  const review = latestReview(snapshot, task)
  if (review === undefined) throw new Error(`task "${taskId}" has no review record on its latest run; there is no case to reproduce`)
  if (review.outcome === 'failed') return 'observed-failure'
  if (review.outcome === 'verified') return 'observed-regression'
  throw new Error(
    `task "${taskId}" is ${task.status} but its latest review record is "${review.outcome}"; a sample must be the case its ` +
    'role names, and only a failed or verified record names one',
  )
}

/**
 * The samples one skill experiment runs, derived from the call's task lists and
 * the store's history. Observed and holdout are both required and both
 * non-empty (§F.2): without a failure there is nothing the candidate fixes, and
 * without a holdout there is nothing it must not break — a comparison missing
 * either is not the evidence the promotion gate is asked for.
 */
function deriveExperimentSamples(
  snapshot: TaskSnapshot,
  taskIds: readonly string[],
  holdoutTaskIds: readonly string[],
): ExperimentSampleSpec[] {
  const named = [...taskIds, ...holdoutTaskIds]
  if (new Set(named).size !== named.length) {
    throw new Error('taskIds and holdoutTaskIds must not overlap or repeat')
  }
  if (taskIds.length === 0) {
    throw new Error(
      'taskIds must name the samples the candidate is evaluated against: at least one task whose latest review is failed ' +
      '(the observed failure it is meant to fix) and any verified tasks it must not break',
    )
  }
  if (holdoutTaskIds.length === 0) {
    throw new Error(
      'holdoutTaskIds must name at least one task that did not select this candidate — the two-sided experiment evaluates ' +
      'the observed cases and the held-out ones together, and an empty holdout proves nothing about what the candidate may break',
    )
  }
  const samples: ExperimentSampleSpec[] = [
    ...taskIds.map(taskId => ({ taskId, role: roleOf(snapshot, taskId) })),
    ...holdoutTaskIds.map(taskId => ({ taskId, role: 'holdout' as const })),
  ]
  if (!samples.some(sample => sample.role === 'observed-failure')) {
    throw new Error(
      'none of taskIds has a failed latest review, so there is no observed failure for this candidate to fix — name the task ' +
      'whose recorded failure this candidate addresses (a candidate with no reproduced failure cannot be evaluated as a fix)',
    )
  }
  return samples
}

/** The v1 replay's criterion diff: `criterionId champion→candidate`, as the report recorded it. */
function renderReplayCriterionDiff(diff: ReplayTaskComparison['criteriaDiff']): string {
  if (diff.length === 0) return 'no criterion diff'
  return diff.map(item => `${item.criterionId} ${item.champion ?? '—'}→${item.candidate ?? '—'}`).join(', ')
}

/** The experiment's criterion diff: the baseline run's verdict → the candidate run's, per criterion that moved. */
function renderExperimentCriterionDiff(baseline: readonly ExperimentCriterionDetail[], candidate: readonly ExperimentCriterionDetail[]): string {
  const byId = new Map(candidate.map(item => [item.criterionId, item]))
  const diff: string[] = []
  for (const item of baseline) {
    const other = byId.get(item.criterionId)
    byId.delete(item.criterionId)
    if (other?.verdict !== item.verdict) diff.push(`${item.criterionId} ${item.verdict}→${other?.verdict ?? '—'}`)
  }
  for (const item of byId.values()) diff.push(`${item.criterionId} —→${item.verdict}`)
  return diff.length === 0 ? 'no criterion diff' : diff.join(', ')
}

/**
 * What one experiment produced, as its caller reads it. The baseline is said to
 * be a new run of *this* experiment in the first line that describes the sides:
 * §F.2's whole point is that the historical record locates a case and is never
 * the comparison's baseline, so the report is rendered without that vocabulary
 * at all.
 */
function renderExperiment(result: ExperimentResult, targetId: string): string {
  const { report } = result
  const budget = JSON.stringify(report.frozen.budget)
  const baseline = report.frozen.productionBaseline
  return [
    `proposal ${report.proposalId} [experiment] skill ${targetId} — verdict: ${report.verdict}`,
    `samples (${report.samples.length}):`,
    ...report.samples.map(sample =>
      `  ${sample.taskId} [${sample.role}] baseline ${sample.baseline.outcome} → candidate ${sample.candidate.outcome} ` +
      `(${renderExperimentCriterionDiff(sample.baseline.criteria, sample.candidate.criteria)}) — ${sample.verdict}`),
    'every side above is a new run this experiment started — the baseline under the production configuration, the candidate ' +
    'on the prepared SKILL.md; the sample\'s historical record only locates the case',
    `report: ${result.reportPath}`,
    `experiment ${result.experimentId} (repetition ${report.frozen.repetition}, frozen ${report.frozenDigest}); ` +
    `candidate sha256 ${report.frozen.candidate.sha256}; production baseline sha256 ${baseline?.sha256 ?? 'not recorded'}; ` +
    `model ${report.frozen.model}; budget ${budget}; snapshot ${report.frozen.snapshot.digest}; comparer ${report.frozen.comparerVersion}`,
    'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
  ].join('\n')
}

/** The v1 replay rendering, unchanged: the comparison groups as the caller reads them, historical side first. */
function renderReplayResult(result: ReplayExperimentResult): string {
  if (result.manual) {
    return [
      `proposal ${result.proposalId} [replayed] manual — nothing was executed`,
      PRESET_REPLAY_MANUAL_REASON,
      `report: ${result.reportPath}`,
      'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
    ].join('\n')
  }
  const renderGroup = (title: string, group: readonly ReplayTaskComparison[]) => [
    `${title} (${group.length}):`,
    ...group.map(item =>
      `  ${item.taskId} champion ${item.champion.outcome} → candidate ${item.candidate!.outcome} ` +
      `(${renderReplayCriterionDiff(item.criteriaDiff)}) — ${item.relation}`),
  ]
  return [
    `proposal ${result.proposalId} [replayed] ${result.targetType} ${result.targetId} — verdict: ${result.report.verdict}`,
    ...renderGroup('observed', result.observed),
    result.holdout.length === 0
      ? 'holdout: not run (no holdoutTaskIds given)'
      : renderGroup('holdout', result.holdout).join('\n'),
    `report: ${result.reportPath}`,
    'comparison only — the replay ran as new evolution-replay tasks; the historical tree and production were not changed',
    'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
  ].join('\n')
}

/** The experiment one skill call runs: the derived samples, the caller's frozen input, and the model identity it runs under. */
async function runSkillExperiment(
  ctx: Context,
  args: { proposalId: string; taskIds: readonly string[]; holdoutTaskIds: readonly string[]; repetition?: number; budget?: ExperimentBudget },
  caller: SessionId,
  signal: AbortSignal,
): Promise<ExperimentResult> {
  let snapshot: TaskSnapshot
  try {
    const graph = await ctx.graphs.graphForSession(caller)
    snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`)
  }
  return ctx.evolution.runExperiment({
    proposalId: args.proposalId,
    samples: deriveExperimentSamples(snapshot, args.taskIds, args.holdoutTaskIds),
    snapshot: { sourceDir: await callerWorkspace(ctx, caller) },
    model: modelIdentity(ctx),
    budget: { ...(args.budget ?? {}) },
    repetition: args.repetition ?? 0,
  }, caller, caller, { signal })
}

export function defineEvolutionReplayTool(ctx: Context) {
  return defineTool({
    name: 'evolution_replay',
    description:
      'Evaluate a prepared mechanical EvolutionProposal and record the comparison. A **skill** candidate that replaces an ' +
      'existing single-file SKILL.md runs the two-sided experiment: every named task is run twice — a new baseline run under ' +
      'the production configuration and a new candidate run on the prepared bytes — each in its own workspace built from the ' +
      'caller session\'s env workspace (the frozen input snapshot), all under one frozen identity (samples, snapshot digest, ' +
      'candidate content, model, budget, comparer). Sample roles are derived from the store\'s history: a task whose latest ' +
      'review is failed is the observed failure, a verified one is an observed regression, and holdoutTaskIds are the held-out ' +
      'cases; a call with no failed sample, or with an empty holdout, is refused — the experiment requires both. The historical ' +
      'record locates each case and is never a baseline. Every other targetType keeps the v1 replay path: capability re-runs ' +
      'each historical task under the mutation entry as a per-run capability overlay, task_definition replays the candidate ' +
      'definition\'s criteria through the verifier alone, and agent_preset is manual in v1 (nothing executes and the report says ' +
      'so). Writes the report under sandbox/<proposalId>/ and records the ledger entries; cite the report path in ' +
      'evolution_gate\'s regressionEvidenceRefs. Repeating the same call reuses the settled runs — it never re-runs or ' +
      'overwrites one; a higher `repetition` freezes a new experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Prepared proposal (mechanical mutation) to evaluate' },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Sample task ids from this graph\'s task store: for a skill candidate at least one whose latest review is ' +
          'failed (the observed failure) plus any verified regressions; otherwise the terminal tasks to replay against',
      },
      holdoutTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verified task ids the candidate was not selected on; a skill experiment requires at least one',
      },
      repetition: {
        type: 'integer',
        description: 'Repeat index of the frozen experiment (default 0). Only a new experiment at a higher index may run a ' +
          'sample again and charge budget again.',
      },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wallTimeMs: { type: 'integer', description: 'Wall-clock ceiling for the whole experiment, in milliseconds' },
          maxTokens: { type: 'integer', description: 'Token ceiling for the whole experiment' },
          note: { type: 'string', description: 'What the budget was derived from and why it is judged enough' },
        },
        description: 'The budget frozen with the experiment, recorded as given (defaults to none stated)',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const taskIds = (args.taskIds as unknown[]).map(id => String(id))
      const holdoutTaskIds = ((args.holdoutTaskIds as unknown[] | undefined) ?? []).map(id => String(id))
      try {
        const proposal = await ctx.evolution.get(args.proposalId)
        if (proposal.targetType === 'skill') {
          const result = await runSkillExperiment(ctx, {
            proposalId: args.proposalId,
            taskIds,
            holdoutTaskIds,
            ...(args.repetition === undefined ? {} : { repetition: args.repetition }),
            ...(args.budget === undefined ? {} : { budget: args.budget }),
          }, caller, exec.signal)
          return renderExperiment(result, proposal.targetId)
        }
        const result = await runReplayExperiment(
          { evolution: ctx.evolution, graphs: ctx.graphs, task: ctx.task, taskRuntime: ctx.taskRuntime },
          { proposalId: args.proposalId, taskIds, holdoutTaskIds, caller, signal: exec.signal },
        )
        return renderReplayResult(result)
      } catch (error) {
        return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
