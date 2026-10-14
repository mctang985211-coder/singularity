import { SessionId } from '@deepseek-ai/dsh-session'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { nativeTokensOf } from './budget.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { domainForRun } from './method.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { SUBJECT_INPUT } from './review.ts'

export interface ProposalCost {
  readonly sessionId: string
  readonly sessions: readonly { readonly sessionId: string; readonly start: number; readonly end: number; readonly tokens: number }[]
  readonly tokens: number
  readonly candidates: readonly string[]
}
export function taskSessionsOf(apparatus: Apparatus, taskId: string): Set<string> {
  const cut = apparatus.store.load()
  const tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const agents = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const ids = new Set<string>(), sessions = new Set<string>()
  const collect = (id: string): void => {
    if (ids.has(id)) return
    ids.add(id)
    const task = tasks.get(id)!
    sessions.add(agents.get(task.responsibility!.agentId)!.sessionId)
    for (const child of task.decomposition?.children ?? []) collect(child.taskId)
  }
  collect(taskId)
  for (const task of tasks.values()) for (const run of Object.values(task.runs)) {
    const execution = cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
    const manifest = execution.manifest as { purpose: string; relatedTo?: { taskId: string } }
    if (manifest.purpose === 'review' && manifest.relatedTo !== undefined && ids.has(manifest.relatedTo.taskId)) collect(task.taskId)
  }
  return sessions
}
export interface EvaluationCostBasis {
  readonly proposal: ProposalCost & { readonly share: number }
  readonly sessions: readonly { readonly sessionId: string; readonly end: number; readonly tokens: number }[]
}
export interface EvaluationCostSummary {
  readonly executionTokens: number
  readonly proposalTokens: number
  readonly assetReviewTokens: number
  readonly totalTokens: number
}
export async function evaluationCostSummaryOf(apparatus: Apparatus, basis: EvaluationCostBasis): Promise<EvaluationCostSummary> {
  const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const agents = apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  let executionTokens = 0, assetReviewTokens = 0
  for (const held of basis.sessions) {
    const task = [...tasks.values()].find(task => task.responsibility !== undefined && agents.get(task.responsibility.agentId)!.sessionId === held.sessionId)!
    const run = Object.values(task.runs).at(-1)!
    const manifest = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!
      .revisions[run.revision.revisionId]!.manifest as { purpose: string }
    let assetReview = false
    if (manifest.purpose === 'review') {
      const input = (await domainForRun(apparatus, run)).inputs.find(input => input.ref === SUBJECT_INPUT)!
      assetReview = JSON.parse(Buffer.from(input.bytes).toString('utf8')).purpose === 'asset-admission'
    }
    if (assetReview) assetReviewTokens += held.tokens
    else executionTokens += held.tokens
  }
  const proposalTokens = basis.proposal.share
  return { executionTokens, proposalTokens, assetReviewTokens, totalTokens: executionTokens + proposalTokens + assetReviewTokens }
}
export async function proposalCostOf(apparatus: Apparatus, sessionId: string, candidates: readonly string[], frozen?: ProposalCost): Promise<ProposalCost> {
  const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const agents = apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const owner = [...tasks.values()].findLast(task => task.responsibility !== undefined && agents.get(task.responsibility.agentId)!.sessionId === sessionId)!
  const sessions = taskSessionsOf(apparatus, owner.taskId)
  for (const task of tasks.values()) for (const run of Object.values(task.runs)) {
    if (task.responsibility === undefined || !sessions.has(agents.get(task.responsibility.agentId)!.sessionId)) continue
    const execution = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
    if ((execution.manifest as { purpose: string }).purpose !== 'review') continue
    const domain = await domainForRun(apparatus, run)
    const input = domain.inputs.find(input => input.ref === SUBJECT_INPUT)!
    const subject = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as { revision?: unknown }
    if (subject.revision !== undefined) for (const id of taskSessionsOf(apparatus, task.taskId)) sessions.delete(id)
  }
  const starts = new Map<string, number>()
  if (frozen !== undefined) for (const held of frozen.sessions) starts.set(held.sessionId, held.start)
  else for (const evaluation of apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values()) {
    for (const trial of evaluation.observed) {
      if (trial.detail === undefined) continue
      const prior = (JSON.parse(trial.detail) as { costBasis?: EvaluationCostBasis }).costBasis?.proposal
      if (prior?.sessionId === sessionId) for (const held of prior.sessions)
        starts.set(held.sessionId, Math.max(starts.get(held.sessionId) ?? 0, held.end))
    }
  }
  const costs: ProposalCost['sessions'][number][] = []
  for (const id of sessions) {
    const handle = await apparatus.persistence.open(SessionId(id), 'read')
    try {
      const { events } = await handle.read()
      const start = starts.get(id) ?? 0
      costs.push({ sessionId: id, start, end: events.length, tokens: nativeTokensOf(events.slice(start)) })
    } finally { await handle.close() }
  }
  return { sessionId, sessions: costs, tokens: costs.reduce((total, held) => total + held.tokens, 0), candidates }
}
