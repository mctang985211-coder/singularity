/**
 * `method_evaluate`: run the one evaluation pipeline over one draft and report
 * what it settled. The caller names the frozen cohort, the models the strategy
 * already froze, the scale and the repetitions; the tool derives nothing about
 * the samples and writes nothing but the pipeline's own records.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-evaluate
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  OUTCOME_JUDGE_PROMPT,
  assertOutcomePlan,
  canonicalJson,
  digestOf,
  modelSelectionOf,
} from '@dangosys/dsh-singularity-evolution'
import type {
  EvaluationRules,
  ModelSelection,
  OutcomeEvaluationPlan,
  OutcomeModelCall,
  OutcomeModelResult,
  PlannedSample,
} from '@dangosys/dsh-singularity-evolution'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'
import { methodLedgerPlaneOf, strategyPlaneOf } from './method-shared.ts'
import { renderAdmission, renderEvaluation } from './method-render.ts'

const PARAMETERS = [
  'draftId', 'round', 'samples', 'quality', 'objective', 'evaluation', 'budget', 'repetition', 'input', 'maxParallel',
] as const

const SAMPLE_ROLES: readonly PlannedSample['role'][] = ['observed-failure', 'observed-success', 'observed-regression', 'holdout']

/** The model selection this deployment's runs share, read exactly as the assembly's own resolver reads it. */
function deploymentModel(ctx: Context): ModelSelection | undefined {
  const defaults = optionalService<{
    currentSelection(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown; maxTokens?: unknown } | undefined
  }>(ctx, 'agentDefaultModel')
  return modelSelectionOf(defaults?.currentSelection())
}

/** One fresh one-shot model call, using the deployment's own llm route and no executor conversation. */
function judgeCall(ctx: Context): OutcomeModelCall {
  return async (model, prompt, input, signal): Promise<OutcomeModelResult> => {
    const llm = optionalService<{ stream(options: GenerateOptions): AsyncIterable<StreamChunk> }>(ctx, 'llm')
    if (llm === undefined) throw new Error('the llm-outcome objective needs the deployment llm service')
    const assembled = new BlockAssembler()
    let finished = false
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort as GenerateOptions['reasoningEffort'] }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      system: prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      signal,
    })) {
      assembled.push(chunk)
      if (chunk.type === 'finish') {
        if (chunk.reason.kind !== 'stop') throw new Error(`the outcome model stopped with ${JSON.stringify(chunk.reason)}`)
        finished = true
      }
    }
    const response = assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    if (!finished || response.trim().length === 0) throw new Error('the outcome model returned no complete response')
    const usage = assembled.usage
    return {
      response,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              uncachedInputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            },
          }),
    }
  }
}

/** One frozen outcome evaluation plan: the caller's plan, or one plan the judge model writes from the goal. */
async function outcomePlanOf(
  ctx: Context,
  input: { readonly goal: string; readonly rubric?: string; readonly measurements?: readonly { readonly id: string; readonly command: string }[] },
  samples: readonly { readonly taskId: string; readonly role: PlannedSample['role'] }[],
  model: ModelSelection,
  signal: AbortSignal | undefined,
): Promise<OutcomeEvaluationPlan> {
  const judge = { model, prompt: OUTCOME_JUDGE_PROMPT, digest: digestOf({ model, prompt: OUTCOME_JUDGE_PROMPT }) }
  let rubric = input.rubric
  let measurements = input.measurements
  let generatedResponse: string | undefined
  let generatedUsage: OutcomeModelResult['usage']
  if (rubric === undefined || measurements === undefined) {
    const generated = await judgeCall(ctx)(
      model,
      'Create an outcome evaluation plan from the supplied goal and samples. Return JSON {"rubric":"…","measurements":[{"id":"safe_name","command":"…"}]}. ' +
        'Each command runs in one isolated workspace with a 300 second limit and a 1 MiB output limit per stream. Preserve any supplied rubric and measurements, and keep the original acceptance fixed.',
      canonicalJson({ goal: input.goal, rubric, measurements, samples }),
      signal,
    )
    if (typeof generated === 'string') throw new Error('the outcome plan model returned no usage record')
    generatedResponse = generated.response
    generatedUsage = generated.usage
    const parsed = JSON.parse(generated.response) as Pick<OutcomeEvaluationPlan, 'rubric' | 'measurements'>
    rubric ??= parsed.rubric
    measurements ??= parsed.measurements
  }
  const plan: OutcomeEvaluationPlan = {
    goal: input.goal,
    rubric: rubric ?? '',
    measurements: measurements === undefined ? [] : [...measurements],
    judge,
    ...(generatedResponse === undefined ? {} : { generatedResponse }),
    ...(generatedUsage === undefined ? {} : { generatedUsage }),
  }
  assertOutcomePlan(plan)
  return plan
}

export function defineMethodEvaluateTool(ctx: Context) {
  return defineTool({
    name: 'method_evaluate',
    description:
      'Measure one draft through the one evaluation pipeline. Name the frozen cohort explicitly — both sides of every sample, its ' +
      'role and the original acceptance — the [0,1] quality scale, the objective and the budget; the tool derives no sample and no ' +
      'role. At least three independent repetitions calibrate noise: a single trial never claims a zero noise band. A missing cost ' +
      'inside the cohort is inconclusive rather than zero, and a missing trial does not shrink the denominator. The same frozen ' +
      'cohort returns the same evaluation without charging again. Next: method_publish (one approval) or method_discard.',
    parameters: {
      draftId: { type: 'string', required: true, description: 'The draft to measure' },
      round: { type: 'integer', required: true, description: 'The search round this evaluation belongs to' },
      samples: {
        type: 'array',
        required: true,
        description: 'The frozen cohort: [{taskId, role}] with role observed-failure | observed-success | observed-regression | holdout',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', description: 'An existing task in this graph store' },
            role: { type: 'string', enum: [...SAMPLE_ROLES], description: 'How this sample entered the cohort' },
          },
        },
      },
      quality: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'The frozen [0,1] quality scale: the original acceptance, or a declared numeric metric',
        properties: {
          metricId: { type: 'string', description: 'acceptance for the original acceptance rate, or a criterion id carrying a numeric reading' },
          extractor: { type: 'string', description: 'How the number is read out of the side' },
        },
      },
      objective: { type: 'string', enum: ['tool-call-reduction', 'llm-outcome'], description: 'Omit for failure repair against the original acceptance' },
      evaluation: {
        type: 'object',
        additionalProperties: true,
        description: 'Required for llm-outcome: {goal, rubric?, measurements?}; rubric and measurements may be generated once and are then frozen',
        properties: {
          goal: { type: 'string' },
          rubric: { type: 'string' },
          measurements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, command: { type: 'string' } } } },
        },
      },
      budget: { type: 'object', additionalProperties: true, description: 'The token ceiling frozen with this evaluation: {maxTokens?, note?}' },
      repetition: { type: 'integer', required: true, description: 'This cohort\'s repetition; 0 is the first. At least 3 calibrate noise' },
      input: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'The frozen input both sides are built from',
        properties: {
          sourceDir: { type: 'string', description: 'A clean input directory both sides copy' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Only the files or directories needed for the comparison' },
          rebaseFrom: { type: 'string', description: 'A workspace path the declared contracts use, relocated into each side' },
        },
      },
      maxParallel: { type: 'integer', description: 'Scheduling limit for the sides this evaluation starts' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_evaluate')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_evaluate')
      try {
        if (typeof args.draftId !== 'string' || args.draftId.length === 0) throw new Error('draftId is required')
        if (!Number.isInteger(args.round) || (args.round as number) < 0) throw new Error('round must be a non-negative integer')
        if (!Number.isInteger(args.repetition) || (args.repetition as number) < 0) throw new Error('repetition must be a non-negative integer')
        if (!Array.isArray(args.samples) || args.samples.length === 0) throw new Error('samples must name at least one sample; the cohort is never inferred')
        const samples = (args.samples as { taskId?: unknown; role?: unknown }[]).map((sample, index) => {
          if (typeof sample.taskId !== 'string' || sample.taskId.length === 0) throw new Error(`samples[${index}].taskId is required`)
          if (!SAMPLE_ROLES.includes(sample.role as PlannedSample['role'])) throw new Error(`samples[${index}].role must be one of ${SAMPLE_ROLES.join(' | ')}`)
          return { taskId: sample.taskId, role: sample.role as PlannedSample['role'] }
        })
        const quality = args.quality as { metricId?: unknown; extractor?: unknown } | undefined
        if (quality === undefined || typeof quality.metricId !== 'string' || quality.metricId.length === 0) {
          throw new Error('quality.metricId is required: the frozen scale must be named before anything is measured')
        }
        if (typeof quality.extractor !== 'string' || quality.extractor.length === 0) throw new Error('quality.extractor is required')
        const input = args.input as { sourceDir?: unknown; paths?: unknown; rebaseFrom?: unknown } | undefined
        if (input === undefined || typeof input.sourceDir !== 'string' || input.sourceDir.length === 0) {
          throw new Error('input.sourceDir is required: both sides are built from one clean input directory')
        }
        const model = deploymentModel(ctx)
        if (model === undefined) {
          throw new Error(
            'this deployment offers no default model, so the model both sides run under cannot be frozen; nothing was evaluated',
          )
        }
        const rules: EvaluationRules = {
          ...(args.objective === undefined ? {} : { objective: args.objective as EvaluationRules['objective'] }),
          quality: { metricId: quality.metricId, direction: 'higher-is-better', extractor: quality.extractor },
          guards: [],
        }
        if (rules.objective !== 'llm-outcome' && args.evaluation !== undefined) {
          throw new Error('evaluation is only valid for the llm-outcome objective')
        }
        // The objective's own requirements are settled before the ledger is
        // touched: a call that names no judged goal never reaches a read.
        let evaluation: OutcomeEvaluationPlan | undefined
        let judge: OutcomeModelCall | undefined
        if (rules.objective === 'llm-outcome') {
          const declared = args.evaluation as { goal?: unknown; rubric?: unknown; measurements?: unknown } | undefined
          if (declared === undefined || typeof declared.goal !== 'string' || declared.goal.length === 0) {
            throw new Error('objective llm-outcome requires evaluation.goal; the judged objective is never assumed')
          }
          judge = judgeCall(ctx)
          evaluation = await outcomePlanOf(
            ctx,
            {
              goal: declared.goal,
              ...(typeof declared.rubric === 'string' ? { rubric: declared.rubric } : {}),
              ...(Array.isArray(declared.measurements)
                ? { measurements: declared.measurements as { id: string; command: string }[] }
                : {}),
            },
            samples,
            model,
            exec.signal,
          )
        }
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        const existing = await ledger.evaluationOf(args.draftId)
        const report = await ledger.evaluate(
          {
            draftId: args.draftId,
            samples,
            input: {
              sourceDir: input.sourceDir,
              ...(Array.isArray(input.paths) ? { paths: input.paths as string[] } : {}),
              ...(typeof input.rebaseFrom === 'string' ? { rebaseFrom: input.rebaseFrom } : {}),
            },
            rules,
            budget: (args.budget as { maxTokens?: number; note?: string } | undefined) ?? {},
            repetition: args.repetition as number,
            model,
            ...(evaluation === undefined ? {} : { evaluation }),
            ...(judge === undefined ? {} : { judge }),
            ...(args.maxParallel === undefined ? {} : { maxParallel: args.maxParallel as number }),
          },
          exec.signal,
        )
        const decision = (await ledger.decisionFor(args.draftId)) ?? (await ledger.recordDecision(report))
        const admission = decision.admissions.find(entry => entry.candidateId === args.draftId)
        // The graph's own strategy switch: the decision above was derived under
        // this policy, and the plan froze it, so the line names both digests.
        const strategy = strategyPlaneOf(ledger.policy)
        const lines = [
          renderEvaluation(report),
          ...(admission === undefined ? ['admission: the frozen strategy recorded no admission for this draft'] : renderAdmission(admission, decision.calibration)),
          `scope: ${decision.scope}`,
          `strategy: ${strategy.policy.version}, policy digest ${decision.policyDigest.slice(0, 12)} — the strategy this graph is configured with${
            report.plan.strategy === undefined ? '' : `, frozen into the plan as ${report.plan.strategy.policyDigest.slice(0, 12)}`
          }`,
        ]
        if (existing !== undefined) lines.push('this draft was already measured under this frozen cohort; the same report was read back and nothing was charged again')
        lines.push(
          admission?.admissible === true
            ? 'next: method_publish (one approval; a refused or tampered candidate is refused before anyone is asked) or method_discard'
            : 'next: method_discard — the frozen strategy did not admit this candidate, so no approval will be requested',
        )
        return lines.join('\n')
      } catch (error) {
        return `method_evaluate rejected: ${message(error)}`
      }
    },
  })
}
