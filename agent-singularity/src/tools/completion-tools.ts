/**
 * The two tools a coordination session ends with. Everything about the call's
 * authority — which graph, which source Run, which role, what the session was
 * asked to do — comes from the assignment the caller is recorded under, never
 * from an argument; and everything about the method (the decision, the approval
 * source, whether the search continues) is derived by the platform from what the
 * round actually recorded.
 *
 * Writing the completion closes the session's write access: reads, evidence and
 * findings remain available, and the platform opens the next execution once this
 * session's log has been flushed.
 *
 * @module @dangosys/dsh-singularity-agent/tools/completion-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import {
  validateReviewCompletion,
  validateSupervisorCompletion,
  reviewCompletion,
  supervisorCompletion,
  type BusinessAction,
  type ReviewCompletionPayload,
  type SupervisorCompletionPayload,
} from '../coordination/completion.ts'
import { nextRoundMode } from '../coordination/reducer.ts'
import { methodDecisionOf, roundMethodRecords, searchNextOf } from '../coordination/method-read.ts'
import { renderCompletion } from '../coordination/render.ts'
import { readCoordinationBinding, recordCompletion, type CoordinationBinding } from '../coordination/store.ts'
import { sessionId, text, undeclaredParameters } from '../shared.ts'

const SUPERVISOR_PARAMETERS = ['businessAction', 'reason', 'evidenceRefs', 'trialCandidateRef'] as const
const REVIEWER_PARAMETERS = [
  'observation',
  'conclusion',
  'confidence',
  'scope',
  'reviewRefs',
  'evidenceRefs',
  'relatedTaskIds',
  'judgements',
  'proposals',
] as const

/** Why a completion call was refused, in the caller's own terms. */
function refuse(tool: string, detail: string): string {
  return `${tool} rejected: ${detail}; nothing was recorded and this session may still work`
}

/** The already-recorded completion one repeat of a call returns. */
function alreadySettled(tool: string, binding: CoordinationBinding, summary: string): string {
  return `${tool}: this session (${binding.sessionId}) already settled its work item — ${summary}; a completion is recorded once`
}

/** The completion call's own binding: the session must hold an unsettled work item of the expected role. */
async function bindingFor(
  tool: string,
  caller: string,
  role: 'supervisor' | 'reviewer',
): Promise<CoordinationBinding> {
  const binding = await readCoordinationBinding(caller)
  if (binding === undefined)
    throw new Error(refuse(tool, `session "${caller}" holds no coordination work item; the platform assigns work, a session never claims it`))
  if (binding.role !== role)
    throw new Error(refuse(tool, `session "${caller}" is recorded as a ${binding.role}, and only a ${role} calls ${tool}`))
  return binding
}

/** The graph's configured round count, when this deployment's registry can answer for it. */
async function readGraphRounds(ctx: Context, graphId: string): Promise<number | undefined> {
  const graphs = ctx.graphs as { get?: (id: string) => Promise<{ readonly rsi?: { readonly iterationRounds: number } }> } | undefined
  if (typeof graphs?.get !== 'function') return undefined
  try {
    return (await graphs.get(graphId)).rsi?.iterationRounds
  } catch {
    return undefined
  }
}

/** The supervisor's completion tool. */
export function defineSupervisorCompleteTool(ctx: Context) {
  return defineTool({
    name: 'supervisor_complete',
    description:
      'Conclude this round and tell the platform what the business work does next. businessAction is your own judgement ' +
      "of the business step only: 'continue' when the verified round's work should run again with the improved method, " +
      "'recover' when the failed round must be repaired and tried again, 'finish' when the business work should not run " +
      'another round. reason is non-empty free text. evidenceRefs must name at least one reference this store already ' +
      'holds (a review ref taskId#runId, an evidence bundle id, or a criterion id) — a conclusion that rests on nothing ' +
      'is not recorded. trialCandidateRef is optional and names one candidate this next round should explicitly try. ' +
      'The method decision, the approval source and whether the method search continues are derived by the platform ' +
      'from what this round actually recorded: they are not parameters, and passing one is an undeclared parameter. ' +
      'businessAction must agree with the round you were given: continue after a verified round, recover after a failed ' +
      'one, finish in either case. Calling this tool closes this session’s write access; reads and findings stay ' +
      'available, and the platform opens the next execution after this session’s log is flushed.',
    parameters: {
      businessAction: {
        type: 'string',
        required: true,
        enum: ['continue', 'recover', 'finish'],
        description: 'What the business work does next: continue | recover | finish',
      },
      reason: { type: 'string', required: true, description: 'Why this is the right next step, in your own words' },
      evidenceRefs: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'At least one recorded reference: a review ref taskId#runId, an evidence bundle id, or a criterion id',
      },
      trialCandidateRef: {
        type: 'string',
        description: 'Optional: the candidate id the next round should explicitly try without promoting it',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, SUPERVISOR_PARAMETERS, 'supervisor_complete')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'supervisor_complete')
      let binding: CoordinationBinding
      try {
        binding = await bindingFor('supervisor_complete', caller, 'supervisor')
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (binding.completed)
        return alreadySettled(
          'supervisor_complete',
          binding,
          `the round already has a completion for session ${binding.sessionId}`,
        )
      const snapshot = await ctx.task.openStore(binding.rootStoreId)
      const run = snapshot.runs.find(candidate => candidate.runId === binding.sourceRunId)
      const outcome = run?.status === 'verified' ? 'verified' : 'failed'
      const payload: SupervisorCompletionPayload = {
        businessAction: args.businessAction as BusinessAction,
        reason: args.reason,
        evidenceRefs: Array.isArray(args.evidenceRefs) ? (args.evidenceRefs as string[]) : [],
        ...(typeof args.trialCandidateRef === 'string' && args.trialCandidateRef.trim().length > 0
          ? { trialCandidateRef: args.trialCandidateRef }
          : {}),
      }
      const validated = validateSupervisorCompletion({ binding, snapshot, outcome, payload })
      if (!validated.ok) return `supervisor_complete rejected: ${validated.refusal}; nothing was recorded`
      const action = validated.payload.businessAction
      if (action !== 'finish' && nextRoundMode(action, outcome) === undefined)
        return (
          `supervisor_complete rejected: businessAction "${action}" does not agree with the round this session was given ` +
          `(the source run settled ${outcome}); use ${outcome === 'verified' ? '\'continue\'' : '\'recover\''} or 'finish'; ` +
          'nothing was recorded'
        )
      const graph = await readGraphRounds(ctx, binding.graphId)
      const businessRound = binding.subject.kind === 'round' ? binding.subject.businessRound : 0
      const rounds = graph ?? businessRound
      const records = await roundMethodRecords(ctx, binding.graphId, businessRound)
      const completion = supervisorCompletion(binding, validated.payload, {
        ...methodDecisionOf(records, validated.payload.trialCandidateRef),
        searchNext: searchNextOf({ businessRound, rounds }),
      })
      await recordCompletion(completion)
      ctx.agentRuntime.sealCoordinationSession(caller)
      return renderCompletion(completion)
    },
  })
}

/** The reviewer's completion tool. */
export function defineReviewerCompleteTool(ctx: Context) {
  return defineTool({
    name: 'reviewer_complete',
    description:
      'Conclude this review and record the diagnosis it produced. observation is required: the postmortem observation ' +
      '(复盘观察) — what was actually observed in the source, whether it failed or succeeded. conclusion is required: ' +
      'the cause, citing the original outcome evidence. confidence is required: high, medium or low. scope, reviewRefs, ' +
      'evidenceRefs and relatedTaskIds are optional and must name records this store already holds (reviewRefs as exact ' +
      'taskId#runId or taskId#no-run; evidenceRefs as evidence bundle ids). judgements are optional: ' +
      '[{dimension, verdict, evidenceRefs, rationale}] where dimension is one of the judged dimensions, verdict is ' +
      'adequate|inadequate|unknown, and each judgement cites at least one recorded ref and a rationale — a judgement ' +
      'that cites nothing is refused rather than downgraded. proposals are optional suggestions ([{targetType, ' +
      'targetId, rationale}]); nothing here executes them. Calling this tool writes the Diagnosis and closes this ' +
      'session’s write access. A session that ends its turn without calling it is a protocol failure: no diagnosis is ' +
      'invented from its silence, and the platform does not ask again.',
    parameters: {
      observation: { type: 'string', required: true, description: 'The postmortem observation (复盘观察): what was actually observed' },
      conclusion: { type: 'string', required: true, description: 'The cause, citing the original outcome evidence' },
      confidence: { type: 'string', required: true, enum: ['high', 'medium', 'low'], description: 'How sure you are; coarse on purpose' },
      scope: { type: 'string', description: 'How far the cause reaches (this task, its subtree, a shared assumption, …)' },
      reviewRefs: { type: 'array', items: { type: 'string' }, description: 'Exact taskId#runId (or taskId#no-run) refs this conclusion rests on' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Evidence bundle ids read through context_read kind:"evidence"' },
      relatedTaskIds: { type: 'array', items: { type: 'string' }, description: 'Actual task ids in this graph the finding spans' },
      judgements: {
        type: 'array',
        description: 'Optional judgements on dimensions no parser settles; each needs refs and a rationale',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dimension: { type: 'string', required: true, description: 'One of the judged dimensions' },
            verdict: { type: 'string', required: true, enum: ['adequate', 'inadequate', 'unknown'], description: 'The judgement' },
            evidenceRefs: { type: 'array', items: { type: 'string' }, required: true, description: 'At least one recorded ref' },
            rationale: { type: 'string', required: true, description: 'Why this verdict, grounded in the refs' },
          },
        },
      },
      proposals: {
        type: 'array',
        description: 'Optional structured suggestions for the supervisor; stored as data, never auto-executed',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            targetType: { type: 'string', required: true, description: 'The mutation surface the suggestion points at' },
            targetId: { type: 'string', required: true, description: 'The concrete target name' },
            rationale: { type: 'string', required: true, description: 'The mechanism, expected benefit and how it could be tested' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, REVIEWER_PARAMETERS, 'reviewer_complete')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'reviewer_complete')
      let binding: CoordinationBinding
      try {
        binding = await bindingFor('reviewer_complete', caller, 'reviewer')
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (binding.completed) {
        const rows = await ctx.task.openStore(binding.rootStoreId)
        const diagnosis = rows.diagnoses.find(item => item.diagnosisId === `review-agent-${binding.sessionId}`)
        return alreadySettled(
          'reviewer_complete',
          binding,
          diagnosis === undefined ? 'the review already has a completion' : `diagnosis ${diagnosis.diagnosisId} is recorded`,
        )
      }
      const snapshot = await ctx.task.openStore(binding.rootStoreId)
      const payload = args as unknown as ReviewCompletionPayload
      const validated = validateReviewCompletion({ binding, snapshot, payload })
      if (!validated.ok) return `reviewer_complete rejected: ${validated.refusal}; nothing was recorded`
      const diagnosis = validated.payload.diagnosis
      try {
        await ctx.task.recordDiagnosisIn(binding.rootStoreId, diagnosis, binding.sessionId)
      } catch (error) {
        return `reviewer_complete rejected: the diagnosis could not be recorded (${
          error instanceof Error ? error.message : String(error)
        }); nothing was recorded`
      }
      const completion = reviewCompletion(binding, diagnosis.diagnosisId, diagnosis.confidence)
      await recordCompletion(completion)
      ctx.agentRuntime.sealCoordinationSession(caller)
      return [
        `reviewer_complete: diagnosis ${diagnosis.diagnosisId} [${diagnosis.confidence}] recorded`,
        `refs: ${diagnosis.reviewRefs.length} review, ${diagnosis.evidenceRefs.length} evidence, ${(diagnosis.relatedTaskIds ?? []).length} related task(s)`,
        `judgements: ${diagnosis.judgements?.length ?? 0}; proposals: ${diagnosis.proposals.length} (suggestions only)`,
        'writes are closed for this session; reads and findings remain available',
      ].join('; ')
    },
  })
}
