import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import type { TaskContract } from './contract.ts'
import type { TaskState } from './protocol.ts'
import { requireResponsible } from './responsibility.ts'
import { record, requireContractOf, text } from './shape.ts'

/** One declared sub-task: dependencies, parent contributions and its fixed attempt budget. */
export interface DecompositionChild {
  readonly taskId: string
  /** Child task ids that must be **verified** before this one may start. */
  readonly dependsOn: readonly string[]
  /** Criterion ids of the **parent's** contract that this sub-task's verification supports. */
  readonly supports: readonly string[]
  /** How many runs this sub-task may start. The budget is fixed here and nothing can raise it. */
  readonly maxRuns: number
  /** Parent's decisions, scope and evidence to reuse; never inherited conversation. */
  readonly handoff?: { readonly context: string; readonly evidence: readonly string[] }
}

/** A task's fixed decomposition, as declared. */
export interface Decomposition {
  readonly children: readonly DecompositionChild[]
  readonly at: string
}

export const DECOMPOSITION_MEMBERS = ['children'] as const
export const DECOMPOSITION_CHILD_MEMBERS = ['taskId', 'dependsOn', 'supports', 'maxRuns', 'handoff'] as const

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
  const handoff = source['handoff'] === undefined ? undefined : record(source['handoff'], `${where}.handoff`)
  if (handoff !== undefined) assertClosedKeys(handoff, ['context', 'evidence'], `${where}.handoff`)
  return {
    taskId: text(source, 'taskId', where),
    dependsOn: nameList(source['dependsOn'], `${where}.dependsOn`),
    supports: nameList(source['supports'], `${where}.supports`),
    maxRuns,
    ...(handoff === undefined ? {} : { handoff: { context: text(handoff, 'context', `${where}.handoff`),
      evidence: nameList(handoff['evidence'], `${where}.handoff.evidence`) } }),
  }
}

/**
 * Refuse a dependency cycle, naming the cycle rather than only its existence.
 *
 * A cycle cannot be satisfied by any execution order, and it is a property of the declared shape
 * alone, so it is decided here rather than left for a scheduler to discover by hanging.
 */
function assertAcyclic(children: readonly DecompositionChild[], where: string): void {
  const dependencies = new Map(children.map((entry) => [entry.taskId, entry.dependsOn]))
  const settled = new Set<string>()
  const path: string[] = []
  const onPath = new Set<string>()
  const visit = (taskId: string): void => {
    if (settled.has(taskId)) return
    if (onPath.has(taskId))
      refuse('cyclic-dependency', `${where} declares a dependency cycle: ${[...path.slice(path.indexOf(taskId)), taskId].join(' -> ')}`,
      )
    onPath.add(taskId)
    path.push(taskId)
    for (const dependency of dependencies.get(taskId)!) visit(dependency)
    path.pop()
    onPath.delete(taskId)
    settled.add(taskId)
  }
  for (const entry of children) visit(entry.taskId)
}

function childrenOf(raw: unknown, where: string, members: MemberSet): readonly DecompositionChild[] {
  if (!Array.isArray(raw) || raw.length === 0)
    refuse('malformed-payload', `${where} must declare at least one sub-task; an empty decomposition plans nothing`)
  const children = raw.map((entry, index) => child(entry, `${where}[${index}]`, members))
  const ids = new Set<string>()
  for (const entry of children) {
    if (ids.has(entry.taskId))
      refuse('malformed-payload', `${where} declares "${entry.taskId}" twice; one sub-task has one plan entry`)
    ids.add(entry.taskId)
  }
  return children
}

/** Pure preflight and replay use the same dependency rules. */
export function assertDecomposition(raw: unknown, contract: Pick<TaskContract, 'criteria'>, parentTaskId: string,
): readonly DecompositionChild[] {
  const where = `decomposition of "${parentTaskId}"`
  const children = childrenOf(raw, where, DECOMPOSITION_CHILD_MEMBERS)
  const declared = new Set(children.map((entry) => entry.taskId))
  for (const entry of children) {
    if (entry.taskId === parentTaskId)
      refuse('malformed-payload', `${where} declares "${entry.taskId}" as its own sub-task`)
    for (const dependency of entry.dependsOn) {
      if (dependency === entry.taskId)
        refuse('malformed-payload', `${where} sub-task "${entry.taskId}" depends on itself`)
      if (!declared.has(dependency))
        refuse('malformed-payload', `${where} sub-task "${entry.taskId}" depends on "${dependency}", which this decomposition does not declare`,
        )
    }
    if (entry.supports.length === 0) refuse('malformed-payload', 'a child must support at least one parent criterion')
    for (const criterionId of entry.supports) {
      if (!contract.criteria.some((criterion) => criterion.criterionId === criterionId))
        refuse(
          'unknown-criterion',
          `${where} declares that sub-task "${entry.taskId}" supports criterion "${criterionId}", which this task's contract does not declare`,
        )
    }
  }
  assertAcyclic(children, where)
  return children
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
      return { children: childrenOf(source['children'], `${where}.children`, nested.children) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const contract = requireContractOf(state, where, envelope.subject)
      // The plan is the holder's act, and the identity is the one the log stamps: a caller cannot
      // claim it, and an agent bound to a task it does not hold cannot write its plan.
      requireResponsible(state, envelope.actor, where)
      const existing = state.decomposition?.children ?? []
      const added = new Set(payload.children.map((child) => child.taskId))
      if (existing.some((child) => added.has(child.taskId)))
        refuse('illegal-transition', `${where} repeats an existing child`)
      const children = assertDecomposition([...existing, ...payload.children], contract, envelope.subject)
      return { ...state, decomposition: { children, at: envelope.at } }

    },
  })
}
