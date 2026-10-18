import { SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import { digestOf } from '../../src/protocol/envelope.ts'
import type { RunSubmission } from '../../src/task/run.ts'

/** Read the same token-meter wire projection served to ui-chat, at the frozen log cut. */
export function projectedTokenUsage(apparatus: Apparatus, handle: SessionHandle, events: readonly SessionEvent[]): TokenUsageProjection {
  const { tokenUsage } = apparatus.projections.restore({}, events, SessionLogOffset(0), handle.header, handle.inheritedEventCount).snapshot.values
  if (tokenUsage === undefined) refuse('malformed-declaration', 'token usage requires the native token-meter projection')
  return tokenUsage
}

/** A borrowed root chat may contain older Tasks. Keep its native prefix for replay, and subtract that prefix's projection. */
export function taskTokenUsage(apparatus: Apparatus, handle: SessionHandle, events: readonly SessionEvent[], from: number): TokenUsageProjection {
  const end = projectedTokenUsage(apparatus, handle, events)
  if (from === 0) return end
  const before = projectedTokenUsage(apparatus, handle, events.slice(0, from))
  return {
    uncachedInputTokens: end.uncachedInputTokens - before.uncachedInputTokens,
    cacheReadTokens: end.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: end.cacheWriteTokens - before.cacheWriteTokens,
    outputTokens: end.outputTokens - before.outputTokens,
  }
}

/** Include the step that introduced this Task's dispatch; other dedicated sessions start at zero. */
export function taskDispatchStart(events: readonly SessionEvent[], controlId: string, taskId: string): number | undefined {
  const dispatch = events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'singularity' &&
    event.data.source.controlId === controlId && event.data.source.taskId === taskId && event.data.source.purpose === 'dispatch')
  if (dispatch < 0) return undefined
  const step = events.findLastIndex((event, index) => index < dispatch && event.type === 'step/start')
  return step < 0 ? dispatch : step
}

/** StatsPills totals the four disjoint native billing buckets; reasoning is already in output. */
export const billedTokens = (usage: TokenUsageProjection): number =>
  usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
/** Keep the native total unchanged; missing billing samples only weaken comparison evidence. */
export const completeUsage = (events: readonly SessionEvent[]): boolean => events.every(event => {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return true
  return 'usage' in event.data && event.data.usage !== undefined || lastAssistantStreamChunk(event.data.stream, 'usage') !== undefined
})
/** Freeze native usage at the artifact/judgment submission, excluding later summaries. */
export function executionEvents(events: readonly SessionEvent[], from = 0): readonly SessionEvent[] {
  const submitted = events.findLastIndex((event, index) => index >= from && event.type === 'tool/call' && event.data.name === 'singularity_submit')
  return submitted < 0 ? events : events.slice(0, submitted + 1)
}

/** Freeze a borrowed root at its own sealed submission, even if a later Task has already run. */
export function taskExecutionWindow(events: readonly SessionEvent[], controlId: string, taskId: string,
  source?: RunSubmission['source'],
): { events: readonly SessionEvent[]; from: number; complete: boolean } {
  const start = taskDispatchStart(events, controlId, taskId)
  if (start === undefined)
    return { events, from: events.length, complete: false }
  const from = start
  let end = events.length
  if (source !== undefined) {
    end = source.eventCount
    if (end < from || end > events.length ||
        digestOf({ sessionId: source.sessionId, eventCount: end, events: events.slice(0, end) }) !== source.digest)
      refuse('digest-mismatch', 'Task cost differs from its sealed submission transcript')
  } else {
    const next = events.find((event, index) => index > from && event.type === 'user/message' &&
      event.data.source.kind === 'singularity' && event.data.source.controlId === controlId &&
      event.data.source.purpose === 'dispatch' && event.data.source.taskId !== taskId)
    if (next?.type === 'user/message' && next.data.source.kind === 'singularity')
      end = taskDispatchStart(events, controlId, next.data.source.taskId)!
  }
  return { events: executionEvents(events.slice(0, end), from), from, complete: true }
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
  readonly sessions: readonly { readonly sessionId: string; readonly from: number; readonly end: number; readonly tokens: number; readonly complete: boolean }[]
}
