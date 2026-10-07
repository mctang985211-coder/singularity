/** `task_read`: the tool-facing read of the caller's own contract and run (A2 §D/A2-5). @module @dangosys/dsh-singularity-context/reads-task-read */

import type { TaskInstance } from '@dangosys/dsh-singularity-task'
import type { LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList, omissionLine, utf8Bytes } from '../limits.ts'
import { read, type ProjectedRead } from '../refusals.ts'
import { contractBody, ownRunLine, taskSummaryLine } from '../render/fields.ts'
import { bindingLines } from '../render/records.ts'
import type { ReadDeps } from '../types.ts'
import {
  RECOVERY_NOTE,
  recoveryMarker,
  resolveProjectionTarget,
  storeSource,
  taskPageHint,
  tooLarge,
} from './guards.ts'

/** `task_read` (A2 §D/A2-5): the caller's own contract, children, run and re-checked binding. */
export async function taskRead(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const target = resolveProjectionTarget(loaded, {
    member: "no contract is bound to it, and the root's contract is not a substitute.",
    delegation: 'the delegated contract cannot be read.',
  })
  if (target.kind === 'refused') return target.read
  const { resolution } = target
  const snapshot = target.snapshot
  const task = target.task as TaskInstance
  const marker = recoveryMarker(resolution.recovery)
  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    `store ${resolution.storeId} of graph "${resolution.graph.id}"`,
    ...(marker === undefined ? [] : [marker, RECOVERY_NOTE]),
  ]
  if (budget.addAll(header) > 0) return tooLarge('the task_read header', taskPageHint(task.taskId))

  if (resolution.kind === 'reviewer') {
    const lines = [
      '',
      resolution.delegation.role === 'supervisor'
        ? 'source task (method supervision): this session has no business Run. Preserve this contract while comparing reusable method candidates; the platform schedules rounds.'
        : 'delegated task (review-only): this session has no business Run. The contract below is the task it was delegated to review.',
      ...(resolution.delegation.sourceRunId == null ? [] : [`exact source Run: ${resolution.delegation.sourceRunId}`]),
      ...contractBody(task),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the delegated contract', taskPageHint(task.taskId))
    return read(budget.text(), storeSource(resolution.graph, resolution.storeId, 'read the delegated task contract'))
  }

  const run = target.run
  const lines = ['', ...contractBody(task), ...(run === undefined ? [] : ['', ownRunLine(run, snapshot)])]
  if (budget.addAll(lines) > 0) return tooLarge('your contract', taskPageHint(task.taskId))

  // The summary is owed after the children list; its room is kept for it, so an
  // unusually long list of children is cut and named instead of starving it.
  const summary =
    run?.providerBinding === undefined
      ? []
      : (await bindingLines(deps.taskRuntime, run.providerBinding)).filter(line => line.length > 0)

  if (snapshot !== undefined && resolution.kind === 'root') {
    const children = task.childTaskIds.flatMap(taskId => snapshot.tasks.filter(item => item.taskId === taskId))
    const clause = (omitted: number): string =>
      omissionLine({
        scope: 'child tasks',
        unit: 'items',
        kept: children.length - omitted,
        limit: children.length,
        omitted,
        recovery: 'read them with the status view or by reference',
      })
    const shown = budgetList(budget, {
      header: ['', `children: ${children.length}`],
      units: children,
      lines: child => [taskSummaryLine(snapshot, child)],
      reserve: summary.length === 0 ? 0 : utf8Bytes(summary.join('\n')) + 2,
      tail: count => (count === children.length ? [] : [clause(children.length - count)]),
    })
    if (shown === undefined) return tooLarge("the root's children", taskPageHint(task.taskId))
  }

  if (summary.length > 0 && budget.addAll(summary) > 0)
    return tooLarge('the run binding summary', taskPageHint(task.taskId))

  return read(
    budget.text(),
    storeSource(resolution.graph, resolution.storeId, "read the caller's own contract and run"),
  )
}
