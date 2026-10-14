/**
 * The decomposition fact's invariants, and the one guarantee that makes it a single fact.
 *
 * Every case here is decided by the payload parser or by the reducer, so none of them depends on a
 * scheduler, a runtime or a deployment's goodwill. The plan is also where a *cycle* is caught: no
 * execution order satisfies one, and it is a property of the declared shape alone.
 */

import { describe, expect, it } from 'vitest'

import {
  foldSubject,
  MemoryLog,
  type ProtocolRegistry,
  type RefusalCode,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import { assertDecomposition } from '../src/task/decomposition.ts'
import {
  admit,
  CHILD_A,
  CHILD_A_CONTRACT,
  CHILD_B,
  CHILD_B_CONTRACT,
  assigned,
  decompose,
  PARENT,
  parentContract,
  plan,
  treeLog,
} from './tree-fixtures.ts'
import { SUBJECTS, taskRegistry } from './task-fixtures.ts'

/** A parent with a plan, in a log whose registry the caller keeps so it can be folded. */
async function decomposed(children = plan(), registry: ProtocolRegistry = taskRegistry()): Promise<ReturnType<typeof treeLog>> {
  const log = treeLog(registry)
  await log.emit(admit(PARENT, parentContract()))
  await log.emit(assigned(PARENT))
  await log.emit(decompose(PARENT, children))
  return log
}

const child = (taskId: string, extra: Partial<{ dependsOn: readonly string[]; supports: readonly string[]; maxRuns: number }> = {}) => ({
  taskId,
  dependsOn: extra.dependsOn ?? [],
  supports: extra.supports ?? [],
  maxRuns: extra.maxRuns ?? 1,
})

describe('a decomposition is one complete fact', () => {
  it('validates the whole plan through the same pure port before any preparation', () => {
    expect(assertDecomposition(plan(), parentContract(), PARENT)).toEqual(plan())
    for (const [children, code] of [
      [[], 'malformed-payload'],
      [[child(PARENT)], 'malformed-payload'],
      [[child(CHILD_A), child(CHILD_A)], 'malformed-payload'],
      [[child(CHILD_A, { dependsOn: ['outside'] })], 'malformed-payload'],
      [[child(CHILD_A, { dependsOn: [CHILD_B] }), child(CHILD_B, { dependsOn: [CHILD_A] })], 'cyclic-dependency'],
      [[child(CHILD_A, { supports: ['unknown'] })], 'unknown-criterion'],
      [[{ ...child(CHILD_A), extra: true }], 'malformed-payload'],
    ] as const) expect(refusalOf(() => assertDecomposition(children, parentContract(), PARENT)).code).toBe(code)
  })

  it('folds the declared plan onto the parent, and claims business atomicity', async () => {
    const registry = taskRegistry()
    const log = await decomposed(plan(), registry)
    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, PARENT)
    expect([state?.decomposition?.children.map(entry => entry.taskId), state?.decomposition?.children[1]?.dependsOn, typeof state?.decomposition?.at]).toEqual([[CHILD_A, CHILD_B], [CHILD_A], 'string'])

    // One fact stands for the whole plan, so it declares that it is business-atomic.
    const declared = registry.ruleFor(TASK_PROTOCOL, TASK_VERSION, TASK_KINDS.decomposed).guarantees
    expect([declared.atomicFact, declared.appended]).toEqual([true, true])
  })

  it('refuses duplicate children in appended decompositions', async () => {
    const log = await decomposed()
    const refusal = await asyncRefusalOf(() => log.emit(decompose(PARENT, [child(CHILD_A)])))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('repeats an existing child') })
  })

  it('refuses a plan its task-holder did not write', async () => {
    // The task is assigned to an agent whose identity one deployment stamps, and the plan arrives under a
    // table where that name resolves to somebody else. Same facts, different trusted table — which is the
    // only way anybody but the holder could ever emit this fact, since the actor is never a request field.
    const registry = taskRegistry()
    const log = treeLog(registry)
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(assigned(PARENT))
    const stranger = new MemoryLog(registry, { subjects: { ...SUBJECTS, scheduler: 'runtime-elsewhere' } })
    await stranger.emit(admit(PARENT, parentContract()))
    await stranger.emit(assigned(PARENT))
    const refusal = await asyncRefusalOf(() => stranger.emit(decompose(PARENT, plan())))
    expect(refusal).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining('runtime-elsewhere') })
  })

  it('refuses a plan that cannot be executed, each by name', async () => {
    const cases: readonly { readonly label: string; readonly children: unknown; readonly code: RefusalCode }[] = [
      { label: 'no children', children: [], code: 'malformed-payload' },
      { label: 'the parent as its own child', children: [child(PARENT)], code: 'malformed-payload' },
      { label: 'a duplicate child', children: [child(CHILD_A), child(CHILD_A)], code: 'malformed-payload' },
      { label: 'a dependency outside the declared set', children: [child(CHILD_A, { dependsOn: ['task-elsewhere'] })], code: 'malformed-payload' },
      { label: 'a self-dependency', children: [child(CHILD_A, { dependsOn: [CHILD_A] })], code: 'malformed-payload' },
      { label: 'a repeated dependency', children: [child(CHILD_A, { dependsOn: [CHILD_B, CHILD_B] })], code: 'malformed-payload' },
      { label: 'a cycle', children: [child(CHILD_A, { dependsOn: [CHILD_B] }), child(CHILD_B, { dependsOn: [CHILD_A] })], code: 'cyclic-dependency' },
      { label: 'a criterion the parent does not declare', children: [child(CHILD_A, { supports: ['not-a-criterion'] })], code: 'unknown-criterion' },
      { label: 'a zero budget', children: [child(CHILD_A, { maxRuns: 0 })], code: 'malformed-payload' },
      { label: 'a fractional budget', children: [child(CHILD_A, { maxRuns: 1.5 })], code: 'malformed-payload' },
      { label: 'an unknown member', children: [{ ...child(CHILD_A), note: 'extra' }], code: 'malformed-payload' },
    ]

    for (const item of cases) {
      const log = treeLog()
      await log.emit(admit(PARENT, parentContract()))
      await log.emit(assigned(PARENT))
      const refusal = await asyncRefusalOf(() => log.emit(decompose(PARENT, item.children as never)))
      expect(`${item.label}: ${refusal.code}`).toBe(`${item.label}: ${item.code}`)
    }
  })

  it('names the cycle it found rather than only reporting one', async () => {
    const log = treeLog()
    await log.emit(admit(PARENT, parentContract()))
    await log.emit(assigned(PARENT))
    const refusal = await asyncRefusalOf(() => log.emit(decompose(PARENT, [child(CHILD_A, { dependsOn: [CHILD_B] }), child(CHILD_B, { dependsOn: [CHILD_A] })])))
    expect(refusal).toMatchObject({ code: 'cyclic-dependency', detail: expect.stringContaining(`${CHILD_A} -> ${CHILD_B}`) })
  })

  it('refuses a plan for a task that has no contract to plan against', async () => {
    const log = treeLog()
    const refusal = await asyncRefusalOf(() => log.emit(decompose(PARENT, plan())))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('contract') })
  })

  it('does not require the sub-tasks to exist yet, so either publication order recovers', async () => {
    // Plan first, children admitted after: a crash in between leaves them `missing`, which the tree
    // names and the command boundary refuses to schedule. The reverse order is just as valid,
    // because the children are ordinary tasks that happen to be named by a plan.
    const registry = taskRegistry()
    const planFirst = await decomposed(plan(), registry)
    await planFirst.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await planFirst.emit(admit(CHILD_B, CHILD_B_CONTRACT()))

    const childrenFirst = treeLog(registry)
    await childrenFirst.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
    await childrenFirst.emit(admit(CHILD_B, CHILD_B_CONTRACT()))
    await childrenFirst.emit(admit(PARENT, parentContract()))
    await childrenFirst.emit(assigned(PARENT))
    await childrenFirst.emit(decompose(PARENT, plan()))
    expect([planFirst, childrenFirst].map(log => foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, PARENT)?.decomposition?.children.map(entry => entry.taskId))).toEqual([[CHILD_A, CHILD_B], [CHILD_A, CHILD_B]])
  })
})
