/**
 * The decomposition fact: one complete fact declaring a task's sub-tasks.
 *
 * One fact, not one fact per edge. DSH's `append` is not a multi-record crash-atomic transaction,
 * so a decomposition split across several facts could be observed half-declared after a crash; the
 * only honest way to express a business-atomic operation is a single complete fact.
 *
 * What the fact decides, all in the reducer and all on the parent's own subject:
 *
 * - a decomposition is declared **once**; a later one is refused rather than merged;
 * - every `dependsOn` names a child this same fact declares, so B has no dependency reaching
 *   outside the declared set and can therefore be checked here at all;
 * - `supports` names criteria of the **parent's own contract**, so "which sub-task accepts which
 *   part of the parent's goal" is a claim the parent's contract can refuse;
 * - the graph is **acyclic**;
 * - `maxRuns` is the sub-task's declared budget, and no kind can raise it.
 *
 * What it deliberately does NOT decide: whether the children exist as admitted tasks, and whether
 * they are ready. Those are cross-subject questions, so they are checked at the serial command
 * boundary before a scheduler may start work, and shown by `projectTree` for readers. Copying a
 * child's contract into the parent would be the same fact recorded twice.
 *
 * @module singularity-core/task/decomposition
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import type { TaskContract } from './contract.ts'
import type { TaskState } from './protocol.ts'
import { record, requireContractOf, text } from './shape.ts'

/** One declared sub-task: what it is, what must verify before it, what it accepts, its budget. */
export interface DecompositionChild {
  readonly taskId: string
  /** Child task ids that must be **verified** before this one may start. */
  readonly dependsOn: readonly string[]
  /** Criterion ids of the **parent's** contract that this sub-task's verification supports. */
  readonly supports: readonly string[]
  /** How many runs this sub-task may start. The budget is fixed here and nothing can raise it. */
  readonly maxRuns: number
}

/** A task's fixed decomposition, as declared. */
export interface Decomposition {
  readonly children: readonly DecompositionChild[]
  readonly at: string
}

export const DECOMPOSITION_MEMBERS = ['children'] as const
export const DECOMPOSITION_CHILD_MEMBERS = ['taskId', 'dependsOn', 'supports', 'maxRuns'] as const

/** A bare name in a list. `text` reads a member of a record; these entries are values. */
function name(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.length === 0)
    refuse('malformed-payload', `${where} must be a non-empty string, got ${raw === null ? 'null' : typeof raw}`)
  return raw
}

/** A list of distinct non-empty names. A repeat is refused rather than de-duplicated. */
function nameList(raw: unknown, where: string): readonly string[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of names, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const value = name(entry, `${where}[${index}]`)
    if (seen.has(value)) refuse('malformed-payload', `${where} names ${JSON.stringify(value)} twice`)
    seen.add(value)
    return value
  })
}

/**
 * One declared sub-task, closed by the set the declaring rule hands over.
 *
 * No default: the only caller is `task/decomposed`, whose `nested.children` is the one value this
 * shape has. A reader with a set of its own is how a declaration and a reader drift apart.
 */
function child(raw: unknown, where: string, members: MemberSet): DecompositionChild {
  const source = record(raw, where)
  assertClosedKeys(source, members, where)
  const maxRuns = source['maxRuns']
  if (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1)
    refuse('malformed-payload', `${where}.maxRuns must be an integer >= 1, got ${JSON.stringify(maxRuns ?? null)}`)
  return {
    taskId: text(source, 'taskId', where),
    dependsOn: nameList(source['dependsOn'], `${where}.dependsOn`),
    supports: nameList(source['supports'], `${where}.supports`),
    maxRuns,
  }
}

/**
 * Refuse a dependency cycle, naming the cycle rather than only its existence.
 *
 * A cycle cannot be satisfied by any execution order, and it is a property of the declared shape
 * alone, so it is decided here rather than left for a scheduler to discover by hanging.
 */
function assertAcyclic(children: readonly DecompositionChild[], where: string): void {
  const dependencies = new Map(children.map(entry => [entry.taskId, entry.dependsOn]))
  const settled = new Set<string>()
  const path: string[] = []
  const onPath = new Set<string>()
  const visit = (taskId: string): void => {
    if (settled.has(taskId)) return
    if (onPath.has(taskId))
      refuse('cyclic-dependency', `${where} declares a dependency cycle: ${[...path.slice(path.indexOf(taskId)), taskId].join(' -> ')}`)
    onPath.add(taskId)
    path.push(taskId)
    for (const dependency of dependencies.get(taskId) ?? []) visit(dependency)
    path.pop()
    onPath.delete(taskId)
    settled.add(taskId)
  }
  for (const entry of children) visit(entry.taskId)
}

/**
 * Check the parts of a decomposition that need the parent's contract.
 *
 * Kept separate and exported so the command boundary can run the same rule against the contract it
 * is about to admit, instead of discovering an unknown criterion after the fact was written.
 */
export function assertDecompositionAgainst(children: readonly DecompositionChild[], contract: TaskContract, where: string): void {
  for (const entry of children) {
    for (const criterionId of entry.supports) {
      if (!contract.criteria.some(criterion => criterion.criterionId === criterionId))
        refuse(
          'unknown-criterion',
          `${where} declares that sub-task "${entry.taskId}" supports criterion "${criterionId}", which this task's contract does not declare`,
        )
    }
  }
}

/**
 * The `task/decomposed` rule.
 *
 * The kind name and the emitter role are passed in rather than imported, so this module depends on
 * `protocol.ts` for types only: the runtime dependency runs one way, and there is no import cycle
 * to reason about.
 */
export function decomposedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { children: readonly DecompositionChild[] }, { children: MemberSet }>({
    guarantees: { appended: true, atomicFact: true },
    members: DECOMPOSITION_MEMBERS,
    // Each element of `children` is closed by `child` with the one set named here, handed over rather
    // than read out of a second copy in the reader.
    nested: { children: DECOMPOSITION_CHILD_MEMBERS },
    emitter,
    parse: (raw, _where, nested) => {
      const where = `${kind} payload`
      const source = record(raw, where)
      const rawChildren = source['children']
      if (!Array.isArray(rawChildren) || rawChildren.length === 0)
        refuse('malformed-payload', `${where}.children must declare at least one sub-task; an empty decomposition plans nothing`)
      const children = rawChildren.map((entry, index) => child(entry, `${where}.children[${index}]`, nested.children))
      const ids = new Set<string>()
      for (const entry of children) {
        if (ids.has(entry.taskId))
          refuse('malformed-payload', `${where}.children declares "${entry.taskId}" twice; one sub-task has one plan entry`)
        ids.add(entry.taskId)
      }
      return { children }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const contract = requireContractOf(state, where, envelope.subject)
      if (state.decomposition !== undefined)
        refuse(
          'illegal-transition',
          `${where} decomposes task "${envelope.subject}" again (declared at ${state.decomposition.at}); a plan is fixed once declared`,
        )

      const declared = new Set(payload.children.map(entry => entry.taskId))
      for (const entry of payload.children) {
        if (entry.taskId === envelope.subject)
          refuse('malformed-payload', `${where} declares "${entry.taskId}" as its own sub-task; a task cannot be its own child`)
        for (const dependency of entry.dependsOn) {
          if (dependency === entry.taskId)
            refuse('malformed-payload', `${where} sub-task "${entry.taskId}" depends on itself`)
          if (!declared.has(dependency))
            refuse(
              'malformed-payload',
              `${where} sub-task "${entry.taskId}" depends on "${dependency}", which this decomposition does not declare; a dependency outside the declared set could never be checked here`,
            )
        }
      }
      assertDecompositionAgainst(payload.children, contract, where)
      assertAcyclic(payload.children, where)
      return { ...state, decomposition: { children: payload.children, at: envelope.at } }
    },
  })
}
