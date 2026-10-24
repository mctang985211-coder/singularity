import { SessionId } from '@deepseek-ai/dsh-session'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { RELEASE_KINDS, type ReleaseDraft } from '../../src/release/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import type { ReadInput } from './read.ts'
import { trajectoryPage } from './pages.ts'
import { billedTokens, projectedTokenUsage, sessionUsageAudit, taskSessionsOf } from './evaluation-cost.ts'

/** Historical reads are explicit RSI queries; business workers and reviewers keep their existing scopes. */
export async function readHistory(apparatus: Apparatus, agentId: string, input: ReadInput): Promise<unknown> {
  const cut = apparatus.store.load(),
    tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const owner = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)
  const run = owner === undefined ? undefined : Object.values(owner.runs).at(-1)
  if (run?.purpose !== 'improve' || run.status !== 'running' || run.stage !== 'working')
    refuse('not-responsible', 'cross-round history belongs to the working RSI node')
  const roots = [...tasks.values()].filter(
    task =>
      task.closure !== undefined &&
      task.rsi !== undefined &&
      (task.taskId === run.relatedTo!.taskId || ['completed', 'failed', 'cancelled'].includes(task.rsi.status)),
  )
  const from = input.from ?? 0,
    count = input.count ?? 20
  if (
    input.kind !== 'trajectory' &&
    (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
  )
    refuse('malformed-declaration', 'history pages require from >= 0 and count from 1 to 100')
  const page = <T>(items: readonly T[]) => ({ total: items.length, from, items: items.slice(from, from + count) })
  if (input.kind === 'roots')
    return page(
      roots.map(task => ({
        rootId: task.taskId,
        sessionId: cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility!.agentId)!.sessionId,
        outcome: task.closure!.reason,
        rsi: task.rsi!.status,
        method: task.runs[task.closure!.runId]!.revision,
      })),
    )
  const root = roots.find(task => task.taskId === input.rootId)
  if (root === undefined)
    refuse('not-responsible', 'rootId must name your closed subject or a completed historical root')
  const included = new Set([root.taskId])
  // Related RSI/evaluation Tasks form the rest of this root's history. Exclude the current working RSI session.
  for (const task of tasks.values()) {
    const last = Object.values(task.runs).at(-1)
    if (
      (last?.case === undefined || last.case.split === 'evolve') &&
      last?.relatedTo !== undefined &&
      included.has(last.relatedTo.taskId) &&
      last.status !== 'running'
    )
      included.add(task.taskId)
  }
  const sessions = [...new Set([...included].flatMap(id => [...taskSessionsOf(apparatus, id)]))]
  const rounds = new Set([...included].flatMap(id => tasks.get(id)!.rounds?.map(round => round.roundId) ?? []))
  const drafts = new Set(
    cut
      .entries()
      .filter(entry => entry.kind === RELEASE_KINDS.drafted)
      .map(entry => entry.payload as ReleaseDraft)
      .filter(draft => draft.basis.kind === 'decision' && rounds.has(draft.basis.roundId))
      .map(draft => draft.draftDigest),
  )
  for (const review of cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values())
    if (review.target.kind === 'publication' && drafts.has(review.target.draftDigest) && review.status !== 'running')
      sessions.push(review.sessionId, ...review.children.flatMap(child => [...taskSessionsOf(apparatus, child.taskId)]))
  const uniqueSessions = [...new Set(sessions)]
  if (input.ref !== undefined && !uniqueSessions.includes(input.ref))
    refuse('not-responsible', 'session is outside the selected root history')
  if (input.kind === 'trajectory') {
    if (input.ref === undefined) refuse('malformed-declaration', 'trajectory requires ref=sessionId')
    const handle = await apparatus.persistence.open(SessionId(input.ref), 'read')
    try {
      return trajectoryPage((await handle.read()).events, input.from, input.count, input.eventSeq)
    } finally {
      await handle.close()
    }
  }
  const selected = input.ref === undefined ? uniqueSessions : [input.ref]
  const rows: unknown[] = []
  for (const sessionId of selected.slice(from, from + count)) {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      const { events } = await handle.read()
      if (input.kind === 'sessions') {
        const agent = [...cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values()].find(
          agent => agent.sessionId === sessionId,
        )!
        const task = [...tasks.values()].find(task => task.responsibility?.agentId === agent.agentId)
        rows.push({
          sessionId,
          eventCount: events.length,
          role: agent.role,
          ...(task === undefined ? {} : { taskId: task.taskId }),
        })
      } else if (input.kind === 'usage') {
        const tokenUsage = projectedTokenUsage(apparatus, handle, events)
        rows.push({
          sessionId,
          source: 'token-meter/tokenUsage',
          tokenUsage,
          tokens: billedTokens(tokenUsage),
          audit: sessionUsageAudit(events, tokenUsage),
        })
      } else if (input.kind === 'steps')
        rows.push({
          sessionId,
          steps: events.filter(event => event.type === 'step/start').length,
          turns: events.filter(event => event.type === 'turn/start').length,
          toolCalls: events.filter(event => event.type === 'tool/call').length,
        })
      else refuse('malformed-declaration', 'unknown history query')
    } finally {
      await handle.close()
    }
  }
  return { rootId: root.taskId, total: selected.length, from, items: rows }
}
