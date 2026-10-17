import { SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { refuse } from '../../src/protocol/refusal.ts'

/** Read the same token-meter wire projection served to ui-chat, at the frozen log cut. */
export function projectedTokenUsage(apparatus: Apparatus, handle: SessionHandle, events: readonly SessionEvent[]): TokenUsageProjection {
  const { tokenUsage } = apparatus.projections.restore({}, events, SessionLogOffset(0), handle.header, handle.inheritedEventCount).snapshot.values
  if (tokenUsage === undefined) refuse('malformed-declaration', 'token usage requires the native token-meter projection')
  return tokenUsage
}

/** StatsPills totals the four disjoint native billing buckets; reasoning is already in output. */
export const billedTokens = (usage: TokenUsageProjection): number =>
  usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
/** Freeze native usage at the artifact/judgment submission, excluding later summaries. */
export function executionEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const submitted = events.findLastIndex(event => event.type === 'tool/call' && event.data.name === 'singularity_submit')
  return submitted < 0 ? events : events.slice(0, submitted + 1)
}
export function taskSessionsOf(apparatus: Apparatus, taskId: string): Set<string> {
  const cut = apparatus.store.load(),
    tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
    agents = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const reviews = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
  const ids = new Set<string>(), sessions = new Set<string>()
  const collect = (id: string): void => {
    if (ids.has(id)) return
    ids.add(id)
    const task = tasks.get(id)!
    if (Object.keys(task.runs).length > 0) sessions.add(agents.get(task.responsibility!.agentId)!.sessionId)
    for (const child of task.decomposition?.children ?? []) collect(child.taskId)
    for (const review of reviews)
      if (review.target.kind === 'acceptance' && review.target.taskId === id) {
        sessions.add(review.sessionId)
        for (const child of review.children) collect(child.taskId)
      }
  }
  collect(taskId)
  return sessions
}
export interface EvaluationCostBasis {
  readonly sessions: readonly { readonly sessionId: string; readonly end: number; readonly tokens: number }[]
}
