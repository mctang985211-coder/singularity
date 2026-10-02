/** `evolution_replay`: evaluate a prepared candidate with the two-sided experiment (baseline vs candidate) and record the frozen report. @module dsh-singularity-agent/tools/evolution-replay */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {
  ExperimentBudget,
  ExperimentCriterionDetail,
  ExperimentObjective,
  ExperimentResult,
  ExperimentSampleSpec,
  ModelSelection,
} from '@dangosys/dsh-singularity-evolution'
import { message, sessionId, text } from '../shared.ts'

/** The model selection this experiment freezes — read from the evolution plane's injected resolver, never from the caller (§F.2: the model is frozen before the runs, and a model-filled string could not be one). */
function modelSelection(ctx: Context): ModelSelection {
  return ctx.evolution.modelSelection()
}

/** The workspace the caller's own session runs in — the frozen input snapshot both experiment sides are built from. */
async function callerWorkspace(ctx: Context, caller: SessionId): Promise<string> {
  const runtime = optionalService<{ workspacePathFor?(sessionId: string): Promise<string | undefined> }>(ctx, 'taskRuntime')
  let path: string | undefined
  try {
    path = await runtime?.workspacePathFor?.(caller)
  } catch (error) {
    throw new Error(`cannot resolve the caller session's workspace: ${message(error)}`)
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(
      `this deployment cannot name the workspace of session "${caller}", which the experiment would freeze as its input ` +
      'snapshot — name the caller\'s env workspace before evaluating a Task template, Skill or capability candidate',
    )
  }
  return path
}

/** The task's latest review record — the record a sample's role is read from. */
function latestReview(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

/** The role one named task has, from the store's own history: its latest review decides whether the case is a failure the candidate is meant to fix or a passing case it must not break. The caller names tasks; */
function roleOf(snapshot: TaskSnapshot, taskId: string, objective?: ExperimentObjective): ExperimentSampleSpec['role'] {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`unknown task "${taskId}" in this graph's task store`)
  if (task.status !== 'verified' && task.status !== 'failed') {
    throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task carries the history a role is read from`)
  }
  const review = latestReview(snapshot, task)
  if (review === undefined) throw new Error(`task "${taskId}" has no review record on its latest run; there is no case to reproduce`)
  if (review.outcome === 'failed') return 'observed-failure'
  if (review.outcome === 'verified') return objective === 'tool-call-reduction' ? 'observed-success' : 'observed-regression'
  throw new Error(
    `task "${taskId}" is ${task.status} but its latest review record is "${review.outcome}"; a sample must be the case its ` +
    'role names, and only a failed or verified record names one',
  )
}

/** The samples one skill experiment runs, derived from the call's task lists and the store's history. Observed and holdout are both required and both non-empty (§F.2): */
function deriveExperimentSamples(
  snapshot: TaskSnapshot,
  taskIds: readonly string[],
  holdoutTaskIds: readonly string[],
  objective?: ExperimentObjective,
): ExperimentSampleSpec[] {
  const named = [...taskIds, ...holdoutTaskIds]
  if (new Set(named).size !== named.length) {
    throw new Error('taskIds and holdoutTaskIds must not overlap or repeat')
  }
  if (taskIds.length === 0) {
    throw new Error(
      'taskIds must name the observed samples the candidate is evaluated against',
    )
  }
  if (holdoutTaskIds.length === 0) {
    throw new Error(
      'holdoutTaskIds must name at least one task that did not select this candidate — the two-sided experiment evaluates ' +
      'the observed cases and the held-out ones together, and an empty holdout proves nothing about what the candidate may break',
    )
  }
  const samples: ExperimentSampleSpec[] = [
    ...taskIds.map(taskId => ({ taskId, role: roleOf(snapshot, taskId, objective) })),
    ...holdoutTaskIds.map(taskId => ({ taskId, role: 'holdout' as const })),
  ]
  const requiredRole = objective === 'tool-call-reduction' ? 'observed-success' : 'observed-failure'
  if (!samples.some(sample => sample.role === requiredRole)) {
    throw new Error(
      `taskIds must include at least one ${requiredRole} for the experiment objective`,
    )
  }
  return samples
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

/** What one experiment produced, as its caller reads it. The baseline is said to be a new run of *this* experiment in the first line that describes the sides: */
function renderExperiment(result: ExperimentResult, targetId: string): string {
  const { report } = result
  const ceiling = report.frozen.budget.maxTokens
  const budget = ceiling === undefined ? 'no maxTokens ceiling declared' : `maxTokens ${ceiling}`
  const baseline = report.frozen.productionBaseline
  const candidate = report.frozen.candidate
  const capability = report.frozen.capability
  const definition = report.frozen.taskDefinition
  const skillIdentity = candidate === undefined
    ? undefined
    : `${candidate.contract === undefined ? 'guidance' : 'execution'} sha256 ${candidate.sha256}` +
      `${candidate.contract === undefined ? '' : ` sidecar sha256 ${candidate.contract.sha256}`}`
  const candidateIdentity = definition !== undefined
    ? `TaskTemplate ${definition.candidate.template.id}@${definition.candidate.template.version} sha256:${definition.candidate.digest}`
    : capability !== undefined
    ? `capability row "${capability.row.name}" sha256 ${capability.row.digest}` +
      ` (the table held ${capability.baseline === null ? 'no such row' : `row sha256 ${capability.baseline.digest}`})` +
      `${skillIdentity === undefined ? '' : ` and a new skill, ${skillIdentity}`}`
    : skillIdentity
  if (candidateIdentity === undefined) {
    throw new Error(
      `experiment ${result.experimentId} carries neither a skill object identity nor a capability row — a report without a candidate ` +
      'identity is not one this build evaluated, and its record is read back through evolution_list',
    )
  }
  const baselineIdentity = definition !== undefined
    ? `template baseline ${definition.baseline === null ? 'absent' : `${definition.baseline.template.id}@${definition.baseline.template.version} sha256:${definition.baseline.digest}`}; fixed original parent oracle; only new children use the side library`
    : capability === undefined
    ? `production baseline ${baseline?.sha256 ?? 'not recorded'}${baseline?.contract === undefined ? '' : ` sidecar sha256 ${baseline.contract.sha256}`}`
    : `row this candidate moves: ${capability.baseline === null ? 'none (a new row)' : `sha256 ${capability.baseline.digest}`}`
  return [
    `proposal ${report.proposalId} [experiment] ${definition !== undefined ? 'task_definition' : capability === undefined ? 'skill' : 'capability'} ${targetId} — verdict: ${report.verdict}`,
    `samples (${report.samples.length}):`,
    ...report.samples.map(sample =>
      `  ${sample.taskId} [${sample.role}] baseline ${sample.baseline.outcome} → candidate ${sample.candidate.outcome} ` +
      `(${renderExperimentCriterionDiff(sample.baseline.criteria, sample.candidate.criteria)}) — ${sample.verdict}` +
      (report.frozen.objective === 'tool-call-reduction'
        ? `; subtree toolCalls ${sample.baseline.cost.status === 'reported' ? sample.baseline.cost.metrics.toolCalls?.calls ?? 'unknown' : 'unknown'} → ${sample.candidate.cost.status === 'reported' ? sample.candidate.cost.metrics.toolCalls?.calls ?? 'unknown' : 'unknown'}`
        : '')),
    'every side above is a new run this experiment started — the baseline under the production configuration (the production ' +
    'object, or the production table for a capability sample, whose frozen identity is read again at every promotion gate), the ' +
    "candidate on the prepared object's bytes (the prepared `SKILL.md`, the sidecar derived from production for an execution " +
    'skill, and, for a capability candidate, the frozen row the candidate overlay mounts); the sample\'s historical record only ' +
    'locates the case',
    `report: ${result.reportPath}`,
    `experiment ${result.experimentId} (repetition ${report.frozen.repetition}, frozen ${report.frozenDigest}); candidate ${candidateIdentity}; ` +
    baselineIdentity +
    `; model ${report.frozen.model.label}; budget ${budget}; snapshot ${report.frozen.snapshot.digest}; comparer ${report.frozen.comparerVersion}`,
    'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
  ].join('\n')
}

/** The experiment one call runs: the derived samples, the caller's frozen input, and the model selection it runs under. */
async function runExperimentFor(
  ctx: Context,
  args: { proposalId: string; taskIds: readonly string[]; holdoutTaskIds: readonly string[]; objective?: ExperimentObjective; repetition?: number; budget?: ExperimentBudget },
  caller: SessionId,
  signal: AbortSignal,
): Promise<ExperimentResult> {
  let snapshot: TaskSnapshot
  try {
    const graph = await ctx.graphs.graphForSession(caller)
    snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${message(error)}`)
  }
  return ctx.evolution.runExperiment({
    proposalId: args.proposalId,
    samples: deriveExperimentSamples(snapshot, args.taskIds, args.holdoutTaskIds, args.objective),
    ...(args.objective === undefined ? {} : { objective: args.objective }),
    snapshot: { sourceDir: await callerWorkspace(ctx, caller) },
    model: modelSelection(ctx),
    budget: { ...(args.budget ?? {}) },
    repetition: args.repetition ?? 0,
  }, caller, caller, { signal })
}

export function defineEvolutionReplayTool(ctx: Context) {
  return defineTool({
    name: 'evolution_replay',
    description:
      'Compare a prepared Task template, Skill or capability candidate with its frozen baseline. Both sides execute through ' +
      'the same runtime and original acceptance in separate copies of the caller workspace. Task replay freezes the complete ' +
      'template library for each side; new children must use the candidate template while the parent oracle stays fixed. ' +
      'Capability replay mounts the candidate row, MCP definitions and optional Skill; a baseline admission refusal is recorded ' +
      'as that refusal. Samples, inputs, model, budget and comparer are frozen. Omit objective for observed failure repair. ' +
      'For a verified source use tool-call-reduction: both sides pass, every observed sample uses fewer tool calls over its ' +
      'complete executed Run subtree, and holdouts pass without cost growth. Missing counters are inconclusive. Every experiment ' +
      'requires nonempty holdoutTaskIds. Cite the sandbox report in evolution_gate.regressionEvidenceRefs. The same call reuses ' +
      'settled Runs; a higher repetition freezes a new experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Prepared Task template, Skill or capability candidate' },
      objective: { type: 'string', enum: ['tool-call-reduction'], description: 'Verified-source optimization: fewer tool calls across the complete executed Run subtree while retaining frozen acceptance. Omit for failure repair.' },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Observed task ids: a failed target plus verified regressions for failure repair; verified sources for objective tool-call-reduction',
      },
      holdoutTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verified task ids the candidate was not selected on; the experiment requires at least one',
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
          maxTokens: {
            type: 'integer',
            description: 'Token ceiling for the whole experiment. No further side is started once the sides already settled have ' +
              'reported this many tokens (the ledger is the count, so a restart does not reset it)',
          },
          note: { type: 'string', description: 'What the budget was derived from and why it is judged enough' },
        },
        description: 'The budget frozen with the experiment. maxTokens is optional; omit it when this deployment does not report ' +
          'token counts for business Runs. If you declare it, promotion requires a measured token total for every executed ' +
          'side; tool-call counts and model guesses cannot satisfy that check. A declared total also stops further sides once ' +
          'reported usage reaches it. Runs retain the deployment\'s own runtime limits.',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec, 'evolution_replay')
      const taskIds = (args.taskIds as unknown[]).map(id => String(id))
      const holdoutTaskIds = ((args.holdoutTaskIds as unknown[] | undefined) ?? []).map(id => String(id))
      try {
        const proposal = await ctx.evolution.get(args.proposalId)
        if (proposal.targetType !== 'skill' && proposal.targetType !== 'capability' && proposal.targetType !== 'task_definition') {
          throw new Error(
            `proposal ${proposal.proposalId} targets "${proposal.targetType}" — this tool evaluates a prepared Task template, ` +
            'Skill or capability candidate; this target has no evaluator, so its proposal stays a record',
          )
        }
        const result = await runExperimentFor(ctx, {
          proposalId: args.proposalId,
          taskIds,
          holdoutTaskIds,
          ...(args.objective === undefined ? {} : { objective: args.objective }),
          ...(args.repetition === undefined ? {} : { repetition: args.repetition }),
          ...(args.budget === undefined ? {} : { budget: args.budget }),
        }, caller, exec.signal)
        return renderExperiment(result, proposal.targetId)
      } catch (error) {
        return `evolution_replay rejected: ${message(error)}`
      }
    },
  })
}
