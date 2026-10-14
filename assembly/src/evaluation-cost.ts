import { SessionId } from '@deepseek-ai/dsh-session'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { nativeTokensOf } from './budget.ts'
export interface ProposalCost {
  readonly sessionId: string
  readonly sessions: readonly { readonly sessionId: string
    readonly start: number
    readonly end: number
    readonly tokens: number }[]
  readonly tokens: number
  readonly candidates: readonly string[]
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
    sessions.add(agents.get(task.responsibility!.agentId)!.sessionId)
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
  readonly proposal: ProposalCost & { readonly share: number }
  readonly sessions: readonly { readonly sessionId: string; readonly end: number; readonly tokens: number }[]
}
export interface EvaluationCostSummary {
  readonly executionTokens: number
  readonly proposalTokens: number
  readonly totalTokens: number
}
export async function evaluationCostSummaryOf(
  _apparatus: Apparatus,
  basis: EvaluationCostBasis,
): Promise<EvaluationCostSummary> {
  const executionTokens = basis.sessions.reduce((n, s) => n + s.tokens, 0),
    proposalTokens = basis.proposal.share
  return { executionTokens, proposalTokens, totalTokens: executionTokens + proposalTokens }
}
export async function proposalCostOf(apparatus: Apparatus, sessionId: string, candidates: readonly string[],
): Promise<ProposalCost> {
  const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const agents = apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const owner = [...tasks.values()].findLast((t) => agents.get(t.responsibility!.agentId)!.sessionId === sessionId)!
  const starts = new Map<string, number>()
  for (const evaluation of apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values())
    for (const trial of evaluation.observed) {
      if (trial.detail === undefined) continue
      const prior = (JSON.parse(trial.detail) as { costBasis?: EvaluationCostBasis }).costBasis?.proposal
      if (prior?.sessionId === sessionId) for (const held of prior.sessions)
        starts.set(held.sessionId, Math.max(starts.get(held.sessionId) ?? 0, held.end))
    }
  const costs: ProposalCost['sessions'][number][] = []
  for (const id of taskSessionsOf(apparatus, owner.taskId)) {
    const handle = await apparatus.persistence.open(SessionId(id), 'read')
    try {
      const { events } = await handle.read()
      const start = starts.get(id) ?? 0
      costs.push({ sessionId: id, start, end: events.length, tokens: nativeTokensOf(events.slice(start)) })
    } finally { await handle.close() }
  }
  return { sessionId, sessions: costs, tokens: costs.reduce((n, s) => n + s.tokens, 0), candidates }
}
