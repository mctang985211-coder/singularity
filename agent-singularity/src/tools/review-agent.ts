/** `task_review_agent`: spawn one read-only review agent for one exact review source — a task and a run, or the no-run case — take the diagnosis it produces (an observation, a conclusion, and whatever judgements and @module @dangosys/dsh-singularity-agent/tools/review-agent */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ReviewAgentAttempt, ReviewAgentPlan, ReviewAgentSource } from '../coordination/ledger.ts'
import {
  recordedDiagnosis,
  renderJudgements,
  runReviewAgentAttempt,
  sourceRef,
} from '../coordination/review-run.ts'
import type { ReviewAttemptOutcome } from '../coordination/review-run.ts'
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

/** How one attempt is named in a result, in the words the source's caller uses. */
function attemptLabel(attempt: ReviewAgentAttempt): string {
  return attempt.requestKey === null ? 'default attempt' : `requestKey "${attempt.requestKey}"`
}

/** What one attempt the caller asked for already is: its identity, how it ended, and — when it recorded a judgement — the same lines the attempt's own call returned. A repeat is answered from the ledger and the store; */
function renderExistingAttempt(attempt: ReviewAgentAttempt, snapshot: TaskSnapshot): string {
  const diagnosis = recordedDiagnosis(snapshot, attempt.sessionId)
  const status = attempt.settlement?.status ?? (diagnosis === undefined ? 'started' : 'recorded')
  const head = `task_review_agent: source ${sourceRef(attempt.source)} already has this attempt ` +
    `(${attemptLabel(attempt)}, session ${attempt.sessionId}, ${status}` +
    `${attempt.settlement?.note === undefined ? '' : `: ${attempt.settlement.note}`}) — returning it; no review agent started`
  if (diagnosis === undefined) {
    return status === 'interrupted'
      ? `${head}; a new review for this source needs an explicit requestKey`
      : `${head}; its diagnosis is not in the store`
  }
  const lines = [
    head,
    `observation: ${diagnosis.observedFailure}`,
    `conclusion: ${diagnosis.localizedCause}`,
  ]
  if (diagnosis.judgements !== undefined && diagnosis.judgements.length > 0) {
    lines.push(`judgements (agent ${attempt.sessionId}):`, ...renderJudgements(diagnosis.judgements))
  }
  lines.push(`diagnosis ${diagnosis.diagnosisId} recorded [${diagnosis.confidence}]`)
  if (diagnosis.proposals.length === 0) lines.push('proposals: none — the conclusion carries no suggestion')
  else for (const proposal of diagnosis.proposals) lines.push(`proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`)
  return lines.join('\n')
}

/** What one refusal says, by name, before any claim or spawn exists. */
function renderRefusal(plan: Extract<ReviewAgentPlan, { kind: 'refused' }>, source: ReviewAgentSource, storeId: string): string {
  const label = plan.attempt === undefined ? '' : attemptLabel(plan.attempt)
  if (plan.code === 'request-key-conflict') {
    const named = plan.attempt!.requestKey === null
      ? `source ${sourceRef(source)} already has a ${label}`
      : `${label} already names an attempt for source ${sourceRef(source)}`
    return `task_review_agent: ${named} with a different reason ` +
      `(${JSON.stringify(plan.attempt?.reason ?? null)}); refusing — a key names one review focus and cannot be changed ` +
      `(session ${plan.attempt?.sessionId}); no review agent started`
  }
  if (plan.code === 'request-key-required') {
    const held = plan.attempts.map(attempt => `${attemptLabel(attempt)} ${attempt.sessionId}`).join(', ')
    return `task_review_agent: source ${sourceRef(source)} was already reviewed (${held}) and this request names no key; ` +
      'a new review for a reviewed source needs an explicit requestKey — no review agent started'
  }
  return `task_review_agent: budget exhausted (${plan.budget.used}/${plan.budget.max}) for store ${storeId} — no review agent started`
}

/** What one request that arrived while an attempt was open is answered with. */
function renderOpenAttempt(attempt: ReviewAgentAttempt): string {
  return `task_review_agent: source ${sourceRef(attempt.source)} already has an attempt in flight ` +
    `(${attemptLabel(attempt)}, session ${attempt.sessionId}, run by this process right now) — the new request was not accepted; ` +
    'attempts of one source never run in parallel; no review agent started'
}

/** The answer one attempt ended with, rendered for its caller. */
function renderOutcome(outcome: ReviewAttemptOutcome, source: ReviewAgentSource, storeId: string, snapshot: TaskSnapshot, review: ReviewRecord): string {
  switch (outcome.kind) {
    case 'refused':
      return renderRefusal(outcome.plan, source, storeId)
    case 'reuse':
      return renderExistingAttempt(outcome.attempt, snapshot)
    case 'in-flight':
      return renderOpenAttempt(outcome.attempt)
    case 'spawn-failed':
      return `task_review_agent: spawn failed: ${outcome.failure} ` +
        `(source ${sourceRef(source)}, attempt ${outcome.sessionId} recorded interrupted); no review agent started`
    case 'unrecorded':
      return `task_review_agent: diagnosis produced but not recorded: ${outcome.failure}`
    case 'no-diagnosis':
      return `task_review_agent: review agent ${outcome.sessionId} ended without a diagnosis — ${outcome.failure} ` +
        `(source ${sourceRef(source)}, attempt ${outcome.sessionId} recorded interrupted); no diagnosis was recorded ` +
        'and nothing was invented from its silence'
    case 'recorded':
      return [
        `task_review_agent: review agent ${outcome.sessionId} judged task ${source.taskId} ` +
          `(source ${sourceRef(source)}; the review it read settled ${review.outcome})`,
        `observation: ${outcome.observation}`,
        `conclusion: ${outcome.conclusion}`,
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
      'Spawn ONE read-only review agent for one exact review source — a task and the run under review, or runId ' +
      'null for a review that carries no run (a task blocked before it started) — take the diagnosis it produces, ' +
      'and persist it as a Diagnosis. The reviewer reads the review pack and, beyond it, whatever settles the ' +
      'question through its own context reads. What it returns is an observation (the postmortem observation — what ' +
      'really happened, for a successful source as much as a failed one), a conclusion in its own words ("no ' +
      'improvement needed" and "the evidence does not settle this" are conclusions), a confidence, and — only when it ' +
      'made them — judgements and proposals. A judgement names one of the dimensions no parser settles ' +
      '(task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency) with verdict ' +
      'adequate|inadequate|unknown, the refs it rests on and a rationale; judgements are optional and never padded, ' +
      'and a judgement that cites nothing is refused rather than downgraded. A proposal is a suggestion only: it ' +
      'names a target type the diagnosis does not freeze, and nothing here executes it. reason names what the review ' +
      'should focus on. A reviewer that is cancelled or answers without a diagnosis leaves an ' +
      'interrupted attempt with the reason named and records no Diagnosis. One source has one default ' +
      'attempt: a repeat of the same call (an automatic scan and an explicit call share it) returns that attempt and ' +
      'its result instead of starting another, and never spends the budget again. Reviewing the same source again ' +
      'after that attempt ended is an explicit act: pass a new non-empty requestKey, which is persisted with the ' +
      'source and the focus; the same key with a different reason is refused. While an attempt of the source is in ' +
      'flight the call returns its identity and starts nothing. The reviewer has no write, shell, spawn, or ' +
      'evolution tool and is capped per root store (default 1).',
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
        description: 'Optional non-empty key for an explicit further review of the same source; omit for the source\'s default attempt',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, 'task_review_agent')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'task_review_agent')
      const graph = await ctx.graphs.graphForSession(caller)
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const source: ReviewAgentSource = { taskId: args.taskId, runId: args.runId }
      const snapshot: TaskSnapshot = await ctx.task.openStore(storeId)
      const task = snapshot.tasks.find(item => item.taskId === args.taskId)
      if (task === undefined) {
        return `task_review_agent: unknown task "${args.taskId}" in store ${storeId} (the caller's graph root); no review agent started`
      }
      if (args.runId !== null && !snapshot.runs.some(run => run.runId === args.runId && run.taskId === args.taskId)) {
        return `task_review_agent: run "${args.runId}" is not a run of task "${args.taskId}"; no review agent started`
      }
      const review = reviewForSource(snapshot, source)
      if (review === undefined) {
        return `task_review_agent: no review record for source ${sourceRef(source)} in store ${storeId}; no review agent started`
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
