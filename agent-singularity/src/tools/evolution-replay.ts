/** `evolution_replay`: evaluate a prepared candidate with the two-sided experiment (baseline vs candidate) and record the frozen report. @module dsh-singularity-agent/tools/evolution-replay */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
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
  OutcomeEvaluationPlan,
  OutcomeModelResult,
} from '@dangosys/dsh-singularity-evolution'
import { assertOutcomePlan, canonicalJson, digestOf, normalizeSnapshot, OUTCOME_JUDGE_PROMPT } from '@dangosys/dsh-singularity-evolution'
import { message, sessionId, text } from '../shared.ts'
import { evolutionForSession } from './evolution-scope.ts'

/** The model selection this experiment freezes — read from the evolution plane's injected resolver, never from the caller (§F.2: the model is frozen before the runs, and a model-filled string could not be one). */
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
  if (review.outcome === 'verified') return objective !== undefined ? 'observed-success' : 'observed-regression'
  throw new Error(
    `task "${taskId}" is ${task.status} but its latest review record is "${review.outcome}"; a sample must be the case its ` +
    'role names, and only a failed or verified record names one',
  )
}

/** Derive sample roles from real Task history. Shared publication also needs independent holdout Tasks. */
function deriveExperimentSamples(
  snapshot: TaskSnapshot,
  taskIds: readonly string[],
  holdoutTaskIds: readonly string[],
  objective?: ExperimentObjective,
  libraryId?: string,
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
  if (holdoutTaskIds.length === 0 && libraryId === undefined) {
    throw new Error(
      'holdoutTaskIds must name at least one task that did not select this candidate — the two-sided experiment evaluates ' +
      'the observed cases and the held-out ones together, and an empty holdout proves nothing about what the candidate may break',
    )
  }
  const samples: ExperimentSampleSpec[] = [
    ...taskIds.map(taskId => ({ taskId, role: roleOf(snapshot, taskId, objective) })),
    ...holdoutTaskIds.map(taskId => ({ taskId, role: 'holdout' as const })),
  ]
  const requiredRole = objective !== undefined ? 'observed-success' : 'observed-failure'
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
  const tokens = (usage: import('@dangosys/dsh-singularity-task').ReviewTokenUsage | undefined) =>
    usage === undefined ? 'unknown' : Object.values(usage).reduce((sum, value) => sum + value, 0)
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
    ? `production baseline ${baseline?.sha256 ?? 'absent (first Skill)'}${baseline?.contract === undefined ? '' : ` sidecar sha256 ${baseline.contract.sha256}`}`
    : `row this candidate moves: ${capability.baseline === null ? 'none (a new row)' : `sha256 ${capability.baseline.digest}`}`
  return [
    `proposal ${report.proposalId} [experiment] ${definition !== undefined ? 'task_definition' : capability === undefined ? 'skill' : 'capability'} ${targetId} — verdict: ${report.verdict}`,
    `samples (${report.samples.length}):`,
    ...(report.frozen.libraryId === undefined ? [] : [
      `graph library: ${report.frozen.libraryId}; ${report.samples.some(sample => sample.role === 'holdout') ? 'independent holdout included' : 'graph-local observed evidence; transfer to unseen Tasks: unknown'}`,
    ]),
    ...report.samples.map(sample =>
      `  ${sample.taskId} [${sample.role}] baseline ${sample.baseline.outcome} → candidate ${sample.candidate.outcome} ` +
      `(${renderExperimentCriterionDiff(sample.baseline.criteria, sample.candidate.criteria)}) — ${sample.verdict}` +
      `; subtree tokens ${tokens(sample.baseline.cost.status === 'reported' ? sample.baseline.cost.metrics.tokens : undefined)} → ${tokens(sample.candidate.cost.status === 'reported' ? sample.candidate.cost.metrics.tokens : undefined)}` +
      `; toolCalls ${sample.baseline.cost.status === 'reported' ? sample.baseline.cost.metrics.toolCalls?.calls ?? 'unknown' : 'unknown'} → ${sample.candidate.cost.status === 'reported' ? sample.candidate.cost.metrics.toolCalls?.calls ?? 'unknown' : 'unknown'}`),
    'every side above is a new run this experiment started — the baseline under the production configuration (the production ' +
    'object, or the production table for a capability sample, whose frozen identity is read again at every promotion gate), the ' +
    "candidate on the prepared object's bytes (the prepared `SKILL.md`, the sidecar derived from production for an execution " +
    'skill, and, for a capability candidate, the frozen row the candidate overlay mounts); the sample\'s historical record only ' +
    'locates the case',
    `report: ${result.reportPath}`,
    ...(report.evaluation === undefined ? [] : [
      `independent judge: ${report.frozen.evaluation!.judge.model.label}; input ${report.evaluation.inputDigest}; response ${report.evaluation.responseDigest}`,
      `auxiliary model tokens: plan ${report.frozen.evaluation!.generatedResponse === undefined ? '0 (provided plan)' : tokens(report.frozen.evaluation!.generatedUsage)}; judge ${tokens(report.evaluation.judgeUsage)}; monetary cost unknown (no price source)`,
      ...report.evaluation.judgement.samples.map(sample => `${sample.taskId} judge ${sample.verdict}: ${sample.findings.map(finding => `${finding.claim} [${finding.evidenceRefs.join(', ')}]`).join('; ')}; uncertainty: ${sample.uncertainties.join('; ') || 'none reported'}`),
    ]),
    `experiment ${result.experimentId} (repetition ${report.frozen.repetition}, frozen ${report.frozenDigest}); candidate ${candidateIdentity}; ` +
    baselineIdentity +
    `; model ${report.frozen.model.label}; budget ${budget}; snapshot ${report.frozen.snapshot.digest}; comparer ${report.frozen.comparerVersion}`,
    'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
  ].join('\n')
}

interface EvaluationInput {
  goal: string
  rubric?: string
  measurements?: { id: string; command: string }[]
}

/** Fresh one-shot context, using the same deployed llm/stream route, without executor conversation or tools. */
async function outcomeModel(ctx: Context, model: ModelSelection, prompt: string, input: string, signal?: AbortSignal): Promise<OutcomeModelResult> {
  const llm = optionalService<{ stream(options: GenerateOptions): AsyncIterable<StreamChunk> }>(ctx, 'llm')
  if (llm === undefined) throw new Error('llm-outcome requires the deployment llm service')
  const assembled = new BlockAssembler()
  let finished = false
  for await (const chunk of llm.stream({
    provider: model.provider, model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as GenerateOptions['reasoningEffort'] }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    system: prompt, messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], signal,
  })) {
    assembled.push(chunk)
    if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'stop') throw new Error(`outcome model stopped with ${JSON.stringify(chunk.reason)}`)
      finished = true
    }
  }
  const response = assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  if (!finished || !response.trim()) throw new Error('outcome model returned no complete response')
  const usage = assembled.usage
  const tokens = usage === undefined ? undefined : {
    uncachedInputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
  return { response, ...(tokens === undefined ? {} : { usage: tokens }) }
}

async function evaluationPlan(ctx: Context, input: EvaluationInput, samples: ExperimentSampleSpec[], snapshot: TaskSnapshot, signal: AbortSignal, model: ModelSelection): Promise<OutcomeEvaluationPlan> {
  let rubric = input.rubric
  let measurements = input.measurements
  let generatedResponse: string | undefined
  let generatedUsage: OutcomeModelResult['usage']
  if (rubric === undefined || measurements === undefined) {
    const generatedCall = await outcomeModel(ctx, model,
      'Create an outcome evaluation plan from the supplied goal, original tasks and available artifacts. Return JSON {"rubric":"...","measurements":[{"id":"safe_name","command":"..."}]}. Use concise commands that inspect real outputs in each isolated workspace. Preserve supplied rubric and measurements. Each command runs with a 300 second limit and a 1 MiB output limit per stream. Keep the original acceptance fixed and explain benefit, uncertainty and model cost through the measurements.',
      canonicalJson({ goal: input.goal, rubric, measurements,
        tasks: samples.map(sample => snapshot.tasks.find(task => task.taskId === sample.taskId)) }), signal)
    generatedResponse = generatedCall.response
    generatedUsage = generatedCall.usage
    const generated = JSON.parse(generatedResponse) as Pick<OutcomeEvaluationPlan, 'rubric' | 'measurements'>
    rubric ??= generated.rubric
    measurements ??= generated.measurements
  }
  const judge = { model, prompt: OUTCOME_JUDGE_PROMPT, digest: digestOf({ model, prompt: OUTCOME_JUDGE_PROMPT }) }
  const plan = { goal: input.goal, rubric, measurements, judge,
    ...(generatedResponse === undefined ? {} : { generatedResponse }),
    ...(generatedUsage === undefined ? {} : { generatedUsage }) }
  assertOutcomePlan(plan)
  return plan
}

/** The experiment one call runs: the derived samples, the caller's frozen input, and the model selection it runs under. */
async function runExperimentFor(
  ctx: Context,
  args: { proposalId: string; taskIds: readonly string[]; holdoutTaskIds: readonly string[]; objective?: ExperimentObjective; evaluation?: EvaluationInput; repetition?: number; budget?: ExperimentBudget; snapshot?: { sourceDir: string; paths?: string[]; rebaseFrom?: string }; maxParallel?: number },
  caller: SessionId,
  signal: AbortSignal,
): Promise<ExperimentResult> {
  const evolution = await evolutionForSession(ctx, caller)
  const model = evolution.modelSelection()
  let snapshot: TaskSnapshot
  try {
    const graph = await ctx.graphs.graphForSession(caller)
    snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
  } catch (error) {
    throw new Error(`cannot open this graph's task store: ${message(error)}`)
  }
  const proposal = await evolution.get(args.proposalId)
  const samples = deriveExperimentSamples(snapshot, args.taskIds, args.holdoutTaskIds, args.objective,
    proposal.targetType === 'capability' ? undefined : evolution.libraryId)
  if (args.snapshot !== undefined && !args.snapshot.sourceDir.trim()) throw new Error('snapshot.sourceDir must name a clean input directory')
  const sourceDir = args.snapshot === undefined ? await callerWorkspace(ctx, caller)
    : isAbsolute(args.snapshot.sourceDir) ? args.snapshot.sourceDir
    : resolve(await callerWorkspace(ctx, caller), args.snapshot.sourceDir)
  const inputSnapshot = normalizeSnapshot({ ...args.snapshot, sourceDir })
  let evaluation: OutcomeEvaluationPlan | undefined
  if (args.objective === 'llm-outcome') {
    if (args.evaluation === undefined) throw new Error('objective llm-outcome requires evaluation.goal')
    const previous = (await evolution.experiments(args.proposalId)).find(item =>
      item.frozen.objective === 'llm-outcome' && item.frozen.repetition === (args.repetition ?? 0))
    if (previous !== undefined) {
      evaluation = previous.frozen.evaluation!
      if (evaluation.goal !== args.evaluation.goal ||
          (args.evaluation.rubric !== undefined && evaluation.rubric !== args.evaluation.rubric) ||
          (args.evaluation.measurements !== undefined && canonicalJson(evaluation.measurements) !== canonicalJson(args.evaluation.measurements)) ||
          canonicalJson(evaluation.judge.model) !== canonicalJson(model))
        throw new Error('evaluation plan or resolved judge changed; use a new repetition for a new experiment')
    } else evaluation = await evaluationPlan(ctx, args.evaluation, samples, snapshot, signal, model)
  } else if (args.evaluation !== undefined) throw new Error('evaluation is only valid for objective llm-outcome')
  return evolution.runExperiment({
    proposalId: args.proposalId,
    samples,
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(args.objective === undefined ? {} : { objective: args.objective }),
    snapshot: inputSnapshot,
    model,
    budget: { ...(args.budget ?? {}) },
    repetition: args.repetition ?? 0,
  }, caller, caller, { signal, ...(args.maxParallel === undefined ? {} : { maxParallel: args.maxParallel }), judge: (model, prompt, input, abort) => outcomeModel(ctx, model, prompt, input, abort) })
}

export function defineEvolutionReplayTool(ctx: Context) {
  return defineTool({
    name: 'evolution_replay',
    description:
      'Compare a prepared Task template, Skill or capability candidate with its frozen baseline. Both sides execute through ' +
      'the same runtime and original acceptance in parallel, separate copies of snapshot.sourceDir (or the caller workspace when omitted). ' +
      'Supply clean original inputs; snapshot.paths selects only the files or directories needed for comparison. Use cwd-relative contracts, ' +
      'or snapshot.rebaseFrom to relocate declared absolute workspace paths into each side while retaining the original checks. Task replay freezes the complete ' +
      'template library for each side; new children must use the candidate template while the parent oracle stays fixed. ' +
      'Capability replay mounts the candidate row, MCP definitions and optional Skill; a baseline admission refusal is recorded ' +
      'as that refusal. Samples, inputs, model, budget and comparer are frozen. Omit objective for observed failure repair. ' +
      'For a verified source use llm-outcome with evaluation.goal for generic domain benefit, or tool-call-reduction for fewer calls. ' +
      'llm-outcome freezes the supplied or LLM-generated rubric and measurement commands before replay; commands execute in each ' +
      'side workspace, then one independent LLM request judges actual outputs. The deployed resolved model and judge prompt are ' +
      'fixed, and gate/apply recheck saved evidence without resampling. The candidate may already be prepared before plan freeze. ' +
      'For tool-call-reduction both sides pass, every observed sample uses fewer tool calls over its ' +
      'complete executed Run subtree, and holdouts pass without cost growth. Missing counters are inconclusive. Graph-local ' +
      'experience can use the observed Task; add independent holdoutTaskIds when available to measure transfer. Shared publication ' +
      'and capability changes require a holdout. Cite the sandbox report in evolution_gate.regressionEvidenceRefs. The same call reuses ' +
      'settled Runs; a higher repetition freezes a new experiment.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Prepared Task template, Skill or capability candidate' },
      snapshot: { type: 'object', additionalProperties: false, properties: {
        sourceDir: { type: 'string', required: true, description: 'Clean input directory copied separately to every side; absolute or relative to caller workspace. Omit snapshot to use the caller workspace.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Relative files or directories needed for comparison, such as fixture, checks and a small workload. Omit to freeze all content. The selection and its digest are frozen.' },
        rebaseFrom: { type: 'string', description: 'Original absolute workspace root in the Task contract. Its declared paths are mapped into each independent side. Input file contents stay fixed; scripts and binaries use their own relative paths.' },
      } },
      maxParallel: { type: 'integer', description: 'Concurrent experiment sides. Defaults to deployment maxActiveWorkers (normally at least 2); runtime worker limits still apply.' },
      objective: { type: 'string', enum: ['tool-call-reduction', 'llm-outcome'], description: 'Verified-source optimization: measured domain benefit with an independent judge, or fewer subtree tool calls. Original acceptance remains mandatory. Omit for failure repair.' },
      evaluation: {
        type: 'object', additionalProperties: false,
        properties: {
          goal: { type: 'string', required: true, description: 'Original user outcome to improve; domain measurements must come from real tools.' },
          rubric: { type: 'string', description: 'Frozen comparison rules; omit to generate with the deployed LLM.' },
          measurements: { type: 'array', items: { type: 'object', additionalProperties: false,
            properties: { id: { type: 'string', required: true }, command: { type: 'string', required: true } } },
            description: 'Same shell commands in each side workspace, 300s/1 MiB per stream; omit to generate. Excess output errors explicitly.' },
        }, description: 'Required for llm-outcome. Plan and judge are frozen before replay, then real command outputs are judged once.',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Observed task ids: a failed target plus verified regressions for failure repair; verified sources for either success objective',
      },
      holdoutTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Independent verified Tasks for transfer evidence. Optional for graph-local Skill/Task experience; shared publication and capability changes require at least one.',
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
        description: 'The total token budget frozen with the experiment, including business Run subtrees and llm-outcome plan/judge calls. maxTokens is optional; omit it when this deployment does not report ' +
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
        const evolution = await evolutionForSession(ctx, caller)
        const proposal = await evolution.get(args.proposalId)
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
          ...(args.evaluation === undefined ? {} : { evaluation: args.evaluation }),
          ...(args.repetition === undefined ? {} : { repetition: args.repetition }),
          ...(args.budget === undefined ? {} : { budget: args.budget }),
          ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
          ...(args.maxParallel === undefined ? {} : { maxParallel: args.maxParallel }),
        }, caller, exec.signal)
        return renderExperiment(result, proposal.targetId)
      } catch (error) {
        return `evolution_replay rejected: ${message(error)}`
      }
    },
  })
}
