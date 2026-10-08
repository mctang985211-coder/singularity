/**
 * The rendering a coordination session reads: a review record as a compact
 * block, the judged dimensions, one work item as a line, a completion as a
 * summary, and the cost lines the supervisor's prompt carries — which are read
 * from execution receipts and never scanned out of session logs.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/render
 */

import type { ExecutionUsage } from '@dangosys/dsh-singularity-task-runtime'
import type { ReviewJudgement, ReviewMetrics, ReviewRecord } from '@dangosys/dsh-singularity-task'
import type { CoordinatedWork, CoordinationCompletion } from './store.ts'

/** One review record's facts as the compact read-only block a supervisor's request carries. */
export function renderSupervisorReviewFacts(review: ReviewRecord): string {
  const criteria = review.criteria ?? []
  const passed = criteria.filter(criterion => criterion.verdict === 'pass').length
  const lines = [`review ${review.taskId}#${review.runId ?? 'no-run'} [${review.outcome}]`]
  lines.push(
    criteria.length === 0
      ? 'criteria: none recorded'
      : `criteria (${passed}/${criteria.length} passed): ${criteria.map(criterion => `${criterion.criterionId} ${criterion.verdict}`).join('; ')}`,
  )
  const metrics = metricsLine(review)
  if (metrics !== undefined) lines.push(`metrics: ${metrics}`)
  if (review.logTail !== undefined) lines.push(`logTail: ${review.logTail}`)
  return lines.join('\n')
}

/** The effort counters of one review record, one clause per counter that exists. */
function metricsLine(review: ReviewRecord): string | undefined {
  const metrics: ReviewMetrics | undefined = review.metrics
  if (metrics === undefined) return undefined
  const parts: string[] = []
  if (metrics.tokens !== undefined) {
    parts.push(
      `tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ` +
        `${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens}`,
    )
  }
  if (metrics.toolCalls !== undefined)
    parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`)
  if (metrics.humanInterventions !== undefined) parts.push(`humanInterventions ${metrics.humanInterventions}`)
  if (metrics.retries !== undefined) parts.push(`retries ${metrics.retries}`)
  if (metrics.evidenceLogs !== undefined) parts.push(`evidenceLogs ${metrics.evidenceLogs}`)
  return parts.length === 0 ? undefined : parts.join(' — ')
}

/** The judged dimensions rendered as report lines. */
export function renderJudgements(judgements: readonly ReviewJudgement[]): string[] {
  return judgements.map(item => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(', ')}]`)
}

/** One work item as a reader reads it: its identity, its role, how it stands and how it ended. */
export function renderCoordinationWork(work: CoordinatedWork): string {
  const assignment = work.assignment
  const subject = assignment.subject
  const described =
    subject.kind === 'round'
      ? `round ${subject.businessRound}`
      : `review of ${subject.source.taskId}#${subject.source.runId ?? 'no-run'}${subject.requestKey === null ? '' : ` (key ${subject.requestKey})`}`
  const completion = work.completion
  const status =
    completion === undefined
      ? 'open'
      : completion.result.kind === 'reviewed'
        ? `settled (diagnosis ${completion.result.diagnosisId})`
        : completion.result.kind === 'completed'
          ? `settled (${completion.result.businessAction})`
          : completion.result.kind
  return `${assignment.role} ${described}: session ${assignment.sessionId} [${status}]`
}

/** One completion as a single line: what was concluded, on what, and what was closed. */
export function renderCompletion(completion: CoordinationCompletion): string {
  const result = completion.result
  switch (result.kind) {
    case 'completed':
      return [
        `supervisor_complete: ${result.businessAction} — ${result.reason}`,
        `${result.evidenceRefs.length} evidence ref(s) [${result.evidenceRefs.join(', ')}]`,
        `method ${result.methodDecision}; search ${result.searchNext}`,
        ...(result.trialCandidateRef === null ? [] : [`trial candidate ${result.trialCandidateRef}`]),
        ...(result.approval === undefined ? [] : [`approval ${result.approval.source}:${result.approval.ref}`]),
        'writes are closed for this session; the platform opens the next execution after this session settles',
      ].join('; ')
    case 'reviewed':
      return `reviewer_complete: diagnosis ${result.diagnosisId} [${result.confidence}] recorded; writes are closed for this session`
    case 'protocol-failure':
      return `protocol-failure: ${result.detail}`
    case 'interrupted':
      return `interrupted: ${result.detail}`
  }
}

/** The sum of several receipts' usages, or `undefined` when not one of them reported. */
export function aggregateUsage(usages: readonly ExecutionUsage[]): ExecutionUsage | undefined {
  const reported = usages.filter(usage => usage.status === 'reported')
  if (reported.length === 0) return undefined
  const runIds = [...new Set(reported.flatMap(usage => usage.runIds))]
  const incompleteRuns = [...new Set(reported.flatMap(usage => usage.incompleteRuns))]
  const withTokens = reported.filter(usage => usage.tokens !== undefined)
  const withCalls = reported.filter(usage => usage.toolCalls !== undefined)
  const tokens =
    withTokens.length === 0
      ? undefined
      : withTokens.reduce(
          (sum, usage) => ({
            uncachedInputTokens: sum.uncachedInputTokens + usage.tokens!.uncachedInputTokens,
            outputTokens: sum.outputTokens + usage.tokens!.outputTokens,
            cacheReadTokens: sum.cacheReadTokens + usage.tokens!.cacheReadTokens,
            cacheWriteTokens: sum.cacheWriteTokens + usage.tokens!.cacheWriteTokens,
          }),
          { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        )
  const toolCalls =
    withCalls.length === 0
      ? undefined
      : withCalls.reduce(
          (sum, usage) => ({ calls: sum.calls + usage.toolCalls!.calls, failures: sum.failures + usage.toolCalls!.failures }),
          { calls: 0, failures: 0 },
        )
  return {
    status: 'reported',
    runIds,
    incompleteRuns,
    ...(tokens === undefined ? {} : { tokens }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
  }
}

/**
 * One cost line, from execution receipts alone. A reading the receipts do not
 * carry stays `unknown`: nothing here walks session logs, and nothing invents a
 * number a Run did not record.
 */
export function renderExecutionCost(label: string, usage: ExecutionUsage | undefined, runs: number): string {
  if (usage === undefined) {
    return `${label}: ${runs} run(s); tokens unknown; toolCalls unknown; monetary cost unknown (no recorded price).`
  }
  const tokens =
    usage.tokens === undefined
      ? 'tokens unknown'
      : `tokens ${Object.values(usage.tokens).reduce((sum, value) => sum + value, 0)} (input ${usage.tokens.uncachedInputTokens}, ` +
        `output ${usage.tokens.outputTokens}, cache read ${usage.tokens.cacheReadTokens}, cache write ${usage.tokens.cacheWriteTokens})`
  const tools = usage.toolCalls === undefined ? 'toolCalls unknown' : `toolCalls ${usage.toolCalls.calls} (${usage.toolCalls.failures} failed)`
  const coverage = usage.incompleteRuns.length === 0
    ? 'coverage complete'
    : `coverage incomplete for run(s) ${usage.incompleteRuns.join(', ')}`
  return `${label}: ${usage.runIds.length} run(s); ${tokens}; ${tools}; ${coverage}; monetary cost unknown (no recorded price).`
}
