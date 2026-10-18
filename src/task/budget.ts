import { defineKind } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import type { Envelope } from '../protocol/envelope.ts'
import type { TaskState } from './protocol.ts'
import { taskRelations } from './tree.ts'
import { record } from './shape.ts'

export interface WorkflowLimits {
  readonly maxSteps: number
  readonly maxNodes: number
  readonly maxPlans: number
  readonly maxRuns: number
  readonly maxNoProgress: number
}
export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = { maxSteps: 1024, maxNodes: 64, maxPlans: 16, maxRuns: 128, maxNoProgress: 32 }
export const workflowLimitsKind = () => defineKind<TaskState, WorkflowLimits, {}>({
  guarantees: { appended: true }, emitter: 'scheduler', members: ['maxSteps', 'maxNodes', 'maxPlans', 'maxRuns', 'maxNoProgress'], nested: {},
  parse: raw => {
    const row = record(raw, 'workflow limits')
    for (const key of ['maxSteps', 'maxNodes', 'maxPlans', 'maxRuns', 'maxNoProgress'])
      if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 1) refuse('malformed-payload', `${key} must be positive`)
    return row as unknown as WorkflowLimits
  },
  reduce: (state, _fact, limits) => {
    if (state.contract === undefined || state.workflowLimits !== undefined || Object.keys(state.runs).length !== 0)
      refuse('illegal-transition', 'freeze workflow limits once before the first Run')
    return { ...state, workflowLimits: limits }
  },
})

/** Derived from the same cut as admission; new IDs and cold recovery cannot reset counters. */
export function workflowBudget(tasks: ReadonlyMap<string, TaskState>, entries: readonly Envelope[], taskId: string) {
  const graph = taskRelations(tasks), rootId = graph.rootOf(taskId), limits = tasks.get(rootId)?.workflowLimits
  const ids = new Set([...tasks.keys()].filter(id => graph.rootOf(id) === rootId))
  for (const id of [...ids]) for (const child of tasks.get(id)?.decomposition?.children ?? []) ids.add(child.taskId)
  const facts = entries.filter(fact => fact.protocol === 'task' && ids.has(fact.subject))
  const lastProgress = facts.findLast(fact => fact.kind === 'run/verified')?.seq ?? -1
  const runs = facts.filter(fact => fact.kind === 'run/started')
  return { rootId, limits, nodes: ids.size, plans: facts.filter(fact => fact.kind === 'task/decomposed').length,
    runs: runs.length, noProgress: runs.filter(fact => fact.seq > lastProgress).length }
}
export function assertWorkflowBudget(tasks: ReadonlyMap<string, TaskState>, entries: readonly Envelope[], taskId: string,
  addition: { readonly nodes?: number; readonly plans?: number; readonly runs?: number }): void {
  const b = workflowBudget(tasks, entries, taskId), l = b.limits
  if (l === undefined) return
  if (b.nodes + (addition.nodes ?? 0) > l.maxNodes || b.plans + (addition.plans ?? 0) > l.maxPlans ||
    b.runs + (addition.runs ?? 0) > l.maxRuns || b.noProgress + (addition.runs ?? 0) > l.maxNoProgress)
    refuse('illegal-transition', `workflow budget exhausted at ${b.rootId}; nodes ${b.nodes}/${l.maxNodes}, plans ${b.plans}/${l.maxPlans}, runs ${b.runs}/${l.maxRuns}, no progress ${b.noProgress}/${l.maxNoProgress}`)
}
