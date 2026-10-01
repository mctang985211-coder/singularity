/** The dynamic half of a caller's context: run state, gate phase, related tasks (A2 §D/§9). @module @dangosys/dsh-singularity-context/reads-dynamic */

import type { TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList, omissionLine } from '../limits.ts'
import { read, type ProjectedRead } from '../refusals.ts'
import { latestRun, ownRunLine, taskSummaryLine } from '../render/fields.ts'
import type { ReadDeps } from '../types.ts'
import {
  byString,
  RECOVERY_NOTE,
  recoveryMarker,
  resolveProjectionTarget,
  storeSource,
  taskPageHint,
  tooLarge,
} from './guards.ts'

/** One related task with the direction labels it earns in the caller's view. */
export interface RelatedEntry {
  readonly task: TaskInstance
  readonly roles: string[]
}

/** The tasks one caller's status view covers: itself, its direct children, and its dependency neighbours. */
export function relatedEntries(snapshot: TaskSnapshot, self: TaskInstance): RelatedEntry[] {
  const roles = new Map<string, string[]>()
  const add = (taskId: string, role: string): void => {
    const current = roles.get(taskId)
    if (current === undefined) roles.set(taskId, [role])
    else if (!current.includes(role)) current.push(role)
  }
  add(self.taskId, 'you')
  for (const childTaskId of self.childTaskIds) add(childTaskId, 'direct child')
  for (const edge of snapshot.edges) {
    if (edge.to === self.taskId) add(edge.from, 'dependency (blocks you)')
    if (edge.from === self.taskId) add(edge.to, 'dependent (you block it)')
  }
  return [...roles.entries()]
    .flatMap(([taskId, labels]) => {
      const task = snapshot.tasks.find(item => item.taskId === taskId)
      return task === undefined ? [] : [{ task, roles: labels }]
    })
    .sort((left, right) => byString(left.task.taskId, right.task.taskId))
}

/** The dynamic half (A2 §D/§9): run state, gate phase, related tasks; byte-stable per content. */
export async function dynamicProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const target = resolveProjectionTarget(loaded, {
    member:
      "there is no dynamic state to project for it; the graph's tasks are readable with the status view or by reference.",
    delegation: 'there is no delegated state to project.',
  })
  if (target.kind === 'refused') return target.read
  const { resolution } = target
  const task = target.task as TaskInstance
  const snapshot = target.snapshot
  const marker = recoveryMarker(resolution.recovery)
  const gate = deps.taskRuntime.gate.phaseOf(resolution.sessionId)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Dynamic context (state)',
    `role: ${resolution.kind}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" — store ${resolution.storeId}`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
    `gate phase: ${gate ?? 'not tracked for this session'}`,
  ]
  if (budget.addAll(header) > 0) return tooLarge('the dynamic projection header', taskPageHint(task.taskId))

  if (resolution.kind === 'reviewer') {
    const run = snapshot === undefined ? undefined : latestRun(snapshot, task)
    const label = `delegated task state (review-only, no business Run): ${run === undefined ? 'no run was ever started' : ownRunLine(run, snapshot)}`
    if (!budget.add(label)) return tooLarge('the delegated task state', taskPageHint(task.taskId))
  } else {
    if (!budget.add(`your run: ${target.run === undefined ? 'none' : ownRunLine(target.run, snapshot)}`)) {
      return tooLarge('the run line', taskPageHint(task.taskId))
    }
  }

  if (snapshot !== undefined) {
    const entries = relatedEntries(snapshot, task)
    const lines = entries.map(entry => taskSummaryLine(snapshot, entry.task, entry.roles))
    const clause = (omitted: number): string =>
      omissionLine({
        scope: 'related tasks',
        unit: 'items',
        kept: lines.length - omitted,
        limit: lines.length,
        omitted,
        recovery: 'page through them with the status view',
      })
    const shown = budgetList(budget, {
      header: [
        '',
        'related tasks (you, your direct children, and the tasks directly adjacent through a dependency edge):',
      ],
      units: lines,
      lines: line => [line],
      tail: count => (count === lines.length ? [] : [clause(lines.length - count)]),
    })
    if (shown === undefined) return tooLarge('the related tasks list', taskPageHint(task.taskId))
  }

  return read(budget.text(), storeSource(resolution.graph, resolution.storeId, "projected the caller's dynamic state"))
}
