/** `task_review_agent`: spawn one read-only review session for one exact review source — a task and a run, or the
 * no-run case — and take the diagnosis it records through `reviewer_complete`. @module @dangosys/dsh-singularity-agent/tools/review-agent */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { CoordinatedWork } from '../coordination/store.ts'
import {
  recordedDiagnosis,
  renderJudgements,
  runReviewAgentAttempt,
  sourceRef,
  type ReviewAttemptOutcome,
} from '../coordination/review-run.ts'
import { reviewForSource } from './task-review-pack.ts'
import { sessionId, text, undeclaredParameters } from '../shared.ts'

export {
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  recordedDiagnosis,
  renderJudgements,
  reviewerGrant,
} from '../coordination/review-run.ts'

const DECLARED_PARAMETERS = ['taskId', 'runId', 'reason', 'requestKey'] as const

/** A free-text argument, or `null` when the caller gave none: empty and whitespace-only read as none. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** How one work item is named in a result, in the words the source's caller uses. */
function workLabel(work: CoordinatedWork): string {
  const requestKey = work.assignment.subject.kind === 'review' ? work.assignment.subject.requestKey : null
  return requestKey === null ? 'default work item' : `requestKey "${requestKey}"`
}

/** What one work item the caller asked for already is: its identity, how it ended, and the diagnosis it recorded. */
function renderExistingWork(work: CoordinatedWork, snapshot: TaskSnapshot): string {
  const assignment = work.assignment
  const diagnosis = recordedDiagnosis(snapshot, assignment.sessionId)
  const status = work.completion?.result.kind ?? (diagnosis === undefined ? 'open' : 'recorded')
  const head =
    `task_review_agent: source ${sourceRef(assignment.subject.source)} already has this work item ` +
    `(${workLabel(work)}, session ${assignment.sessionId}, ${status}) — returning it; no review session started`
  if (diagnosis === undefined) {
    return status === 'interrupted' || status === 'protocol-failure'
      ? `${head}; a new review for this source needs an explicit requestKey`
      : `${head}; its diagnosis is not in the store`
  }
  const lines = [
    head,
    `observation: ${diagnosis.observedFailure}`,
    `conclusion: ${diagnosis.localizedCause}`,
    `scope: ${diagnosis.scope}; related tasks: ${diagnosis.relatedTaskIds?.join(', ') || 'none'}`,
    `review refs: ${diagnosis.reviewRefs.join(', ')}; evidence refs: ${diagnosis.evidenceRefs.join(', ') || 'none'}`,
  ]
  if (diagnosis.judgements !== undefined && diagnosis.judgements.length > 0) {
    lines.push(`judgements (agent ${assignment.sessionId}):`, ...renderJudgements(diagnosis.judgements))
  }
  lines.push(`diagnosis ${diagnosis.diagnosisId} recorded [${diagnosis.confidence}]`)
  if (diagnosis.proposals.length === 0) lines.push('proposals: none — the conclusion carries no suggestion')
  else
    for (const proposal of diagnosis.proposals)
      lines.push(`proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`)
  return lines.join('\n')
}

/** What one refusal says, by name, before any assignment or spawn exists. */
function renderRefusal(outcome: Extract<ReviewAttemptOutcome, { kind: 'refused' }>, source: { readonly taskId: string; readonly runId: string | null }, storeId: string): string {
  if (outcome.code === 'subject-conflict')
    return (
      `task_review_agent: ${outcome.detail} for source ${sourceRef(source)}; refusing — a key names one review focus ` +
      `and cannot be changed. No review session started`
    )
  if (outcome.code === 'attempts-exhausted')
    return (
      `task_review_agent: ${outcome.detail}; a new review for this source needs an explicit requestKey — ` +
      'no review session started'
    )
  return `task_review_agent: ${outcome.detail}; no review session started for store ${storeId}`
}

/** The answer one attempt ended with, rendered for its caller. */
function renderOutcome(
  outcome: ReviewAttemptOutcome,
  source: { readonly taskId: string; readonly runId: string | null },
  storeId: string,
  snapshot: TaskSnapshot,
  review: ReviewRecord,
): string {
  switch (outcome.kind) {
    case 'refused':
      return renderRefusal(outcome, source, storeId)
    case 'reuse':
      return renderExistingWork(outcome.work, snapshot)
    case 'in-flight':
      return (
        `task_review_agent: source ${sourceRef(source)} already has a work item in flight ` +
        `(${workLabel(outcome.work)}, session ${outcome.work.assignment.sessionId}) — the new request was not accepted; ` +
        'one source never runs two review sessions at once; no review session started'
      )
    case 'spawn-failed':
      return (
        `task_review_agent: spawn failed: ${outcome.failure} ` +
        `(source ${sourceRef(source)}, work item ${outcome.sessionId} recorded interrupted); no review session started`
      )
    case 'no-completion':
      return (
        `task_review_agent: review session ${outcome.sessionId} ended without a diagnosis — ${outcome.failure} ` +
        `(source ${sourceRef(source)}, work item ${outcome.sessionId} recorded as a protocol failure); no diagnosis was ` +
        'recorded and nothing was invented from its silence'
      )
    case 'recorded':
      return [
        `task_review_agent: review session ${outcome.sessionId} judged task ${source.taskId} ` +
          `(source ${sourceRef(source)}; the review it read settled ${review.outcome})`,
        `observation: ${outcome.observation}`,
        `conclusion: ${outcome.conclusion}`,
        `scope: ${outcome.scope}; related tasks: ${outcome.relatedTaskIds.join(', ') || 'none'}`,
        `review refs: ${outcome.reviewRefs.join(', ')}; evidence refs: ${outcome.evidenceRefs.join(', ') || 'none'}`,
        ...(outcome.judgements.length === 0
          ? []
          : [`judgements (agent ${outcome.sessionId}):`, ...renderJudgements(outcome.judgements)]),
        `diagnosis ${outcome.diagnosisId} recorded [${outcome.confidence}]`,
        ...(outcome.proposals.length === 0
          ? ['proposals: none — the conclusion carries no suggestion']
          : [
              `proposals (${outcome.proposals.length}, suggestions only — none auto-executes):`,
              ...outcome.proposals.map(item => `- ${item.targetType} ${item.targetId}: ${item.rationale}`),
            ]),
      ].join('\n')
  }
}

export function defineTaskReviewAgentTool(ctx: Context) {
  return defineTool({
    name: 'task_review_agent',
    description:
      'Spawn ONE read-only review session for one exact review source — a task and the run under review, or runId ' +
      'null for a review that carries no run (a task blocked before it started) — and take the diagnosis it records. ' +
      'The reviewer reads the review pack and, beyond it, whatever settles the question through its own context reads. ' +
      'It ends by calling reviewer_complete with an observation (required: what really happened, for a successful ' +
      'source as much as a failed one), a conclusion in its own words ("no improvement needed" and "the evidence does ' +
      'not settle this" are conclusions), a confidence, and — only when it made them — scope, refs, judgements and ' +
      'proposals. A judgement names one of the dimensions no parser settles (task_specification, acceptance, ' +
      'decomposition, skill_fit, tool_fit, context_efficiency) with verdict adequate|inadequate|unknown, the refs it ' +
      'rests on and a rationale; a judgement that cites nothing is refused rather than downgraded. A proposal is a ' +
      'suggestion only: it names a target type the diagnosis does not freeze, and nothing here executes it. reason ' +
      'names what the review should focus on. A session whose turn ends without calling reviewer_complete is a ' +
      'protocol failure: no Diagnosis is invented from its silence, and the platform does not ask again. One source ' +
      'has one default work item: a repeat of the same call returns that work item and its result instead of starting ' +
      'another. Reviewing the same source again after that work item settled is an explicit act: pass a new non-empty ' +
      'requestKey, which is persisted with the source and the focus; the same key with a different source is refused. ' +
      'While a work item of the source is in flight the call returns its identity and starts nothing. The reviewer has ' +
      'no write, shell, spawn, or evolution tool and is capped per root store.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task whose review needs judgement' },
      runId: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        required: true,
        description: 'The Run under review, exactly as its review record names it; null selects a review with no run',
      },
      reason: { type: 'string', description: 'Optional non-empty free text: what this review should focus on' },
      requestKey: {
        type: 'string',
        description:
          "Optional non-empty key for an explicit further review of the same source; omit for the source's default work item",
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, 'task_review_agent')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'task_review_agent')
      const graph = await ctx.graphs.graphForSession(caller)
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const source = { taskId: args.taskId, runId: args.runId }
      const snapshot: TaskSnapshot = await ctx.task.openStore(storeId)
      const task = snapshot.tasks.find(item => item.taskId === args.taskId)
      if (task === undefined) {
        return `task_review_agent: unknown task "${args.taskId}" in store ${storeId} (the caller's graph root); no review session started`
      }
      if (args.runId !== null && !snapshot.runs.some(run => run.runId === args.runId && run.taskId === args.taskId)) {
        return `task_review_agent: run "${args.runId}" is not a run of task "${args.taskId}"; no review session started`
      }
      const review = reviewForSource(snapshot, source)
      if (review === undefined) {
        return `task_review_agent: no review record for source ${sourceRef(source)} in store ${storeId}; no review session started`
      }
      const outcome = await runReviewAgentAttempt({
        ctx,
        storeId,
        source,
        review,
        // The caller's own agent is the parent: the review node is published as
        // this session's child, exactly as any other spawn of it would be.
        parent: exec.agent!,
        actor: caller,
        requestKey: optionalText(args.requestKey),
        reason: optionalText(args.reason),
        signal: exec.signal,
      })
      return renderOutcome(outcome, source, storeId, snapshot, review)
    },
  })
}
