/**
 * `task_review_agent`: spawn one read-only review agent for one exact review
 * source — a task and a run, or the no-run case — take the diagnosis it
 * produces (an observation, a conclusion, and whatever judgements and
 * proposals it chose to add), and persist it as a `Diagnosis`.
 *
 * Why an agent and not a parser (§2.7.3, and the owner's ruling): extracting
 * "was this specification adequate" from a complex context is not a parsing
 * problem, it is a judgement problem, and a review agent is the tool for it. Why
 * not a resident reviewer (§2.7.2): one agent per task would multiply sessions
 * and storage. Why not "the latest review" (A5): a review reviews the run the
 * caller names, so the caller names it — a source the ledger can key on, dedupe
 * on and hand to a later reader. Why the judgements are optional (A5 §3): the
 * conclusion is the diagnosis, "no improvement needed" and "the evidence does
 * not settle this" are conclusions too, and a dimension nobody could settle is
 * left out rather than padded with `unknown`.
 *
 * One source has at most one default attempt (the call with no `requestKey`),
 * which an automatic scan and an explicit call share; a repeat returns the same
 * claim, session and result and never re-charges the budget. A new review after
 * that attempt settled is an explicit act and names a non-empty `requestKey`, so
 * two different postmortems of one source are two identifiable attempts rather
 * than one overwritten one; the same key with a different focus is refused by
 * name, and a new key while an attempt is open returns that attempt's identity
 * instead of starting a second one in parallel.
 *
 * An attempt the process holding it died with is not "in flight" for this door:
 * the ledger settles it (recorded when the store already holds its diagnosis,
 * interrupted otherwise) before the request is decided, so a source whose
 * reviewer died can be reviewed again with an explicit key — while the spent run
 * stays spent.
 *
 * This module is the *explicit* door: it validates what a model call names and
 * renders the answer for the model. The attempt itself — the admission, the
 * claim, the pack, the spawn, the watchdog, the diagnosis, the terminal fact —
 * lives in `review-agent-run.ts`, which the automatic scan (A5) runs too, so the
 * two doors cannot drift. Nothing here decides whether a review *should* happen:
 * a failed review and an explicit call are the two triggers, and no threshold
 * gates either of them.
 * @module @dangosys/dsh-singularity-agent/tools/review-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type { ReviewRecord, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ReviewAgentAttempt, ReviewAgentPlan, ReviewAgentSource } from '../review-agent-ledger.ts'
import {
  REVIEW_AGENT_TIMEOUT_MS,
  recordedDiagnosis,
  renderJudgements,
  runReviewAgentAttempt,
  sourceRef,
} from '../review-agent-run.ts'
import type { ReviewAttemptOutcome } from '../review-agent-run.ts'
import { reviewForSource } from './task-review-pack.ts'

export {
  REVIEW_AGENT_TIMEOUT_MS,
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  recordedDiagnosis,
  renderJudgements,
  reviewerGrant,
} from '../review-agent-run.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_review_agent: missing agent id')
  return SessionId(id)
}

/** A free-text argument, or `null` when the caller gave none: empty and whitespace-only read as none. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** How one attempt is named in a result, in the words the source's caller uses. */
function attemptLabel(attempt: ReviewAgentAttempt): string {
  return attempt.requestKey === null ? 'default attempt' : `requestKey "${attempt.requestKey}"`
}

/**
 * What one attempt the caller asked for already is: its identity, how it ended,
 * and — when it recorded a judgement — the same lines the attempt's own call
 * returned. A repeat is answered from the ledger and the store; nothing is
 * spawned and nothing is written (beyond the recovery note the admission may
 * have just appended for an attempt that never reached model input).
 */
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

/**
 * What one request that arrived while an attempt was open is answered with.
 *
 * Only one state reaches this text: an attempt this process is really running
 * right now. An attempt a dead process left is recovered inside the admission's
 * region before the request is decided, so it can never be reported here as
 * something in flight — and never written off for being slow, either.
 */
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
      'should focus on. A reviewer that times out, is cancelled, or answers without a diagnosis leaves an ' +
      'interrupted attempt with the reason named and records no Diagnosis. One source has one default ' +
      'attempt: a repeat of the same call (an automatic scan and an explicit call share it) returns that attempt and ' +
      'its result instead of starting another, and never spends the budget again. Reviewing the same source again ' +
      'after that attempt ended is an explicit act: pass a new non-empty requestKey, which is persisted with the ' +
      'source and the focus; the same key with a different reason is refused. While an attempt of the source is in ' +
      'flight the call returns its identity and starts nothing. The reviewer has no write, shell, spawn, or ' +
      'evolution tool, is capped per root store (default 1), and is cancelled by a watchdog if it overruns.',
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
      timeoutMs: { type: 'number', description: `Watchdog deadline in milliseconds; defaults to ${REVIEW_AGENT_TIMEOUT_MS}` },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
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
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        signal: exec.signal,
      })
      return renderOutcome(outcome, source, storeId, snapshot, review)
    },
  })
}
