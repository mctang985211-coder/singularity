/**
 * The facts the RSI loop driver and the review tools share: how a review record
 * reads as a compact block, what a coordination agent's last message says, and
 * how the coordination ledger's supervisor attempts are rendered. There is no
 * hand-off rule left in this deployment (F): a supervisor exists only inside the
 * platform's own loop, and the driver — not a diagnosis — decides what happens
 * next.
 *
 * @module @dangosys/dsh-singularity-agent/handoff-rules
 */

import type { ReviewRecord } from '@dangosys/dsh-singularity-task'
import type { ReviewAgentAttempt } from './ledger.ts'

/** Shared host preset; runtime installs the actual coordination role. */
export const COORDINATION_PRESET = 'singularity-coordinator'

/**
 * A supervisor explicitly concludes that no shared method change is justified,
 * closes the loop, or names an obstruction. The driver checks a no_change
 * answer against the evolution ledger before accepting it as a completed round.
 */
export function supervisorOutcomeOf(
  reply: string | undefined,
): { readonly outcome: 'closed' | 'blocked' | 'no_change'; readonly reason: string } | undefined {
  if (reply === undefined) return undefined
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]!)
  for (const block of blocks.reverse()) {
    try {
      const parsed: unknown = JSON.parse(block)
      if (parsed === null || typeof parsed !== 'object') continue
      const outcome = (parsed as { outcome?: unknown }).outcome
      if (outcome !== 'closed' && outcome !== 'blocked' && outcome !== 'no_change') continue
      const reason = (parsed as { reason?: unknown }).reason
      if (typeof reason !== 'string' || reason.trim().length === 0) continue
      return { outcome, reason: reason.trim() }
    } catch {
      continue
    }
  }
  return undefined
}

/** The text of one session's last assistant message — the reply a coordination agent's outcome is read from. */
export function lastAssistantText(events: readonly { type: string; data?: unknown }[]): string | undefined {
  const event = [...events].reverse().find(item => item.type === 'assistant/message')
  if (event === undefined) return undefined
  const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } } | undefined)
    ?.message
  const content = (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
  return content.length === 0 ? undefined : content
}

/** One review record's facts as the compact read-only block a supervisor's first request carries — criteria verdicts, the derived passed/total, and the effort counters. */
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

/** The effort counters of one review record, one clause per counter that exists — an absent field means "not observed". */
function metricsLine(review: ReviewRecord): string | undefined {
  const metrics = review.metrics
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

/**
 * The supervisor attempts one diagnosis left, as the review pack renders them:
 * the session each attempt ran under and how it ended, or a named absence. Only
 * a graph that runs an RSI loop has such attempts — every other store's
 * diagnoses are dropped by the graph's root supervisor.
 */
export function supervisorAttemptsLine(diagnosisId: string, attempts: readonly ReviewAgentAttempt[]): string {
  const mine = attempts.filter(attempt => attempt.role === 'supervisor' && attempt.diagnosisId === diagnosisId)
  if (mine.length === 0)
    return 'no supervisor attempt — a graph without RSI settings runs no platform supervisor for its diagnoses'
  return mine
    .map(attempt => {
      const status = attempt.settlement?.status ?? 'in-flight'
      const note = attempt.settlement?.note === undefined ? '' : ` — ${attempt.settlement.note}`
      return `supervisor attempt ${attempt.sessionId} [${status}]${note}`
    })
    .join('; ')
}
