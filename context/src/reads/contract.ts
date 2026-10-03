/** The immutable half of a caller's context: root briefing, contract, handoff (A2 §D/§9). @module @dangosys/dsh-singularity-context/reads-contract */

import type { TaskInstance } from '@dangosys/dsh-singularity-task'
import type { LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList, itemsClause, itemsFloor, utf8Bytes } from '../limits.ts'
import { message, refused, read, type ProjectedRead } from '../refusals.ts'
import {
  constraintItems,
  contractBody,
  contractHeading,
  handoffFor,
  handoffLines,
  handoffReferences,
  rootAncestor,
} from '../render/fields.ts'
import { bindingLines, renderRunBinding } from '../render/records.ts'
import type { ReadDeps } from '../types.ts'
import { resolveProjectionTarget, storeSource, taskPageHint, tooLarge } from './guards.ts'

/** One handoff reference list: laid out whole, or refused by the caller with `tooLarge`. */
function referenceList(
  budget: OutputBudget,
  title: string,
  entries: readonly string[],
  scope: string,
  recovery: string,
  follow = 0,
): boolean {
  if (entries.length === 0) return budget.add(`- ${title}: (none)`)
  const shown = budgetList(budget, {
    header: [`- ${title}:`],
    units: entries,
    lines: entry => [`  ${entry}`],
    reserve: follow,
    tail: count =>
      count === entries.length ? [] : [itemsClause(scope, recovery, entries.length, entries.length - count)],
  })
  return shown !== undefined
}

/** The immutable half of the context one role is assembled with (A2 §D/§9). */
export async function contractProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead> {
  const target = resolveProjectionTarget(loaded, {
    member:
      "it has no contract to project. A member reads the graph's records by reference (`context_read`) or asks for the " +
      "status view; it never inherits the root's contract.",
    delegation: 'the delegated contract cannot be read.',
  })
  if (target.kind === 'refused') return target.read
  const { resolution } = target
  const snapshot = target.snapshot
  if (snapshot === undefined) {
    return refused(
      'unreadable',
      `store "${resolution.storeId}" of graph "${resolution.graph.id}" could not be read, so the contract it holds cannot be projected.`,
    )
  }
  const task = target.task as TaskInstance
  const run = target.run
  const role: 'worker' | 'root' | 'reviewer' | 'replay' =
    resolution.kind === 'reviewer'
      ? 'reviewer'
      : resolution.kind === 'root'
        ? 'root'
        : task.parentTaskId === undefined && run?.parentRunId !== undefined
          ? 'replay'
          : 'worker'

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  const header = [
    '# Immutable context (contract)',
    `role: ${role}`,
    `graph: ${resolution.graph.id} "${resolution.graph.name}" (env ${resolution.graph.envId}) — root session "${resolution.graph.rootSessionId}"`,
    `session: ${resolution.sessionId} — store ${resolution.storeId}`,
  ]
  if (budget.addAll(header) > 0) return tooLarge('the contract projection header', taskPageHint(task.taskId))

  if (role === 'replay') {
    const lines = [
      '',
      '## Own objective (replay lineage)',
      'this task is a replay: it is parentless in a store that also holds the root task, and its run carries lineage ' +
        `parent run ${run?.parentRunId ?? '(unrecorded)'}. The objective below is this task's own accepted contract — no other ` +
        "task's root objective is adopted here, and the graph's root briefing is not this task's briefing.",
      `objective: ${task.objective}`,
      ...constraintItems(task).map(constraint => `- replay constraint: ${constraint}`),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the replay lineage briefing', taskPageHint(task.taskId))
  }

  if (role === 'worker') {
    const ancestor = rootAncestor(snapshot, task)
    const constraints = constraintItems(ancestor.task)
    const lines = [
      '',
      '## Root objective and hard constraints',
      `${ancestor.task.taskId} [${ancestor.task.status}]: ${ancestor.task.objective}`,
      ...(constraints.length === 0
        ? ['- root constraints: (none recorded on the root contract)']
        : ['- root constraints:', ...constraints.map(constraint => `  - ${constraint}`)]),
      ...(ancestor.brokenAt === undefined
        ? []
        : [
            `- the parent chain stops at "${ancestor.brokenAt}", which this store does not hold; nothing is invented for it`,
          ]),
    ]
    if (budget.addAll(lines) > 0) return tooLarge('the root briefing', taskPageHint(task.taskId))
  }

  if (budget.addAll(['', contractHeading(role), ...contractBody(task)]) > 0) {
    return tooLarge('your contract', taskPageHint(task.taskId))
  }

  if (resolution.kind === 'reviewer') {
    const label = [
      '',
      `- this session has no business Run: the contract above belongs to the task it was delegated to review ` +
        `(delegated by session ${resolution.delegation.actor}, recorded ${resolution.delegation.at}), and reading it is not executing it.`,
    ]
    if (budget.addAll(label) > 0) return tooLarge('the review-only label', taskPageHint(task.taskId))
  }

  // Blocks owed after the bounded lists are measured before them: the lists hand
  // their room forward, so a long reference list is cut and named instead.
  const summaryLines: string[] = role === 'reviewer' && run?.providerBinding !== undefined
    ? await bindingLines(deps.taskRuntime, run.providerBinding) : []
  if (role !== 'reviewer') {
    if (run?.providerBinding === undefined || run.providerBinding.skills.length === 0) {
      return refused('unreadable', `task "${task.taskId}" has no bound guidance Skill; its model request cannot execute unguided work.`)
    }
    let bound
    try { bound = await deps.taskRuntime.readRunBinding(run.providerBinding) }
    catch (error) { return refused('unreadable', `task "${task.taskId}" cannot load its frozen guidance Skill: ${message(error)}`) }
    if (bound === undefined || bound.defects.length > 0 ||
      bound.skills.length === 0 || bound.skills.some(skill => !skill.readable || !skill.instructions?.trim())) {
      return refused('unreadable', `task "${task.taskId}" cannot load its frozen guidance Skill: ${bound?.defects.join('; ') || 'no readable bound instruction body'}`)
    }
    summaryLines.push(
      '', ...renderRunBinding(run.providerBinding, bound).split('\n'),
      '', '## Guidance loaded for this run',
      'These are the complete instructions from this Run’s frozen Skill snapshot. Follow them for this task; loading other Skills does not change the contract or tool permissions.',
      ...bound.skills.flatMap(skill => [
        '', `### Skill ${skill.name}`, `Resources: ${bound.snapshotRoot}/${skill.name}`, '', skill.instructions!,
      ]),
    )
  }
  const summaryFloor = summaryLines.length === 0 ? 0 : utf8Bytes(summaryLines.join('\n')) + 2

  if (role === 'worker') {
    const handoff = handoffFor(snapshot, task.taskId)
    if (handoff === undefined) {
      const missing = [
        '',
        '## Handoff',
        '- handoff: none recorded — this store holds no TaskHandoff naming this task as its child',
      ]
      if (budget.addAll(missing) > 0) return tooLarge('the handoff', taskPageHint(task.taskId))
    } else {
      if (budget.addAll(['', '## Handoff', ...handoffLines(handoff)]) > 0)
        return tooLarge('the handoff', taskPageHint(task.taskId))
      const references = handoffReferences(handoff)
      const evidenceFloor = itemsFloor(
        'relevant evidence',
        'handoff evidence references',
        'read them by id',
        references.evidence.length,
      )
      const tail = summaryFloor
      if (
        !referenceList(
          budget,
          'relevant artifacts',
          references.artifacts,
          'handoff artifact references',
          'read them by id',
          evidenceFloor + tail,
        )
      ) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
      if (
        !referenceList(
          budget,
          'relevant evidence',
          references.evidence,
          'handoff evidence references',
          'read them by id',
          tail,
        )
      ) {
        return tooLarge('the handoff references', taskPageHint(task.taskId))
      }
    }
  }

  if (summaryLines.length > 0 && budget.addAll(summaryLines) > 0) {
    return tooLarge('the run binding summary', taskPageHint(task.taskId))
  }

  return read(
    budget.text(),
    storeSource(resolution.graph, resolution.storeId, "projected the caller's immutable contract"),
  )
}
