import { testProjections } from './seam.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { callerOf, openApparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import type { PlannedChild } from '../src/driver.ts'
import { spawnProcess } from '../src/process.ts'
import { decompose, propose, retry } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { createMethod, loadMethod, seedMethod } from '../src/method.ts'
import { templateDeclaration, type TemplateChild } from '../src/template.ts'
import { attachmentsAt, agentFor, factsOf, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const recipe: readonly TemplateChild[] = [
  { key: 'extract', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1, requirement: 'required' as const },
  { key: 'count', template: 'count-letters', dependsOn: ['extract'], supports: ['letters'], maxRuns: 1, requirement: 'required' as const },
]
async function setup(withRecipe = false) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-plan-')); roots.push(root)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('plans', root, await loadDomain(domainDir, spawnProcess), medium as never, attachmentsAt(root), testProjections)
  const caller = callerOf(agentFor('parent', 'parent-session'))
  const method = withRecipe ? await createMethod(apparatus, { workflowGuidance: '',
    templates: [...apparatus.domain.templates.values()].map((template) => ({ ...templateDeclaration(template),
      ...(template.id === apparatus.domain.rootTemplate ? { decomposition: { children: recipe } } : {}),
    })), skills: [], tools: [],
  }) : undefined
  const parent = await propose(apparatus, caller, 'propose', { goal: 'count letters', ...(method === undefined ? {} : { method }) })
  const dispatched: string[] = []
  const scheduler = { advance: async () => { dispatched.push('dispatch'); return [] }, close: async () => undefined }
  const children: readonly PlannedChild[] = recipe.map(({ template, ...edge }) => ({ ...edge,
    contract: contractFor(apparatus.domain, apparatus.domain.templates.get(template)!,
      apparatus.domain.templates.get(template)!.goal, new Map([['extract-letters', 'extract']])),
  }))
  return { apparatus, medium, caller, parent, scheduler, dispatched, children }
}

describe('one complete task declaration', () => {
  it('admits explicit declarations and replays without duplicate instances or facts', async () => {
    const h = await setup(true)
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children })
    const before = factsOf(h.medium)
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children })
    expect(factsOf(h.medium)).toEqual(before)
    expect(before.filter((fact) => fact.kind === 'task/decomposed')).toHaveLength(1)
    expect(before.filter((fact) => fact.kind === 'task/admitted')).toHaveLength(3)
    expect(before.some((fact) => fact.kind === 'method/consumed' &&
      (fact.payload as { method: string }).method.startsWith('decomposition:'))).toBe(false)
  })

  it('freezes concrete additional acceptance criteria inside the contract', async () => {
    const h = await setup()
    const child = h.children[0]!
    const contract = { ...child.contract, goal: 'extract a bounded result', criteria: [...child.contract.criteria,
      { criterionId: 'bounded', statement: 'The delivered result has at most 100 bytes.' }] }
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [{ ...child, contract }] })
    const id = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(h.parent.taskId)!.decomposition!.children[0]!.taskId
    expect(h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(id)!.contract).toEqual(contract)
  })

  it('rejects changed declarations under a committed key', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children })
    const before = factsOf(h.medium)
    await expect(decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId,
      children: [{ ...h.children[0]!, maxRuns: 2 }] })).rejects.toMatchObject({ refusal: { code: 'command-conflict' } })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('allows two instances and an explicit choice of their artifact producer', async () => {
    const h = await setup()
    const extract = h.children[0]!, count = h.children[1]!
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [
      { ...extract, key: 'first' }, { ...extract, key: 'second', contract: { ...extract.contract, goal: 'Independently verify source order by extracting letters.' } },
      { ...count, dependsOn: ['first', 'second'], contract: { ...count.contract,
        inputs: [{ ...count.contract.inputs[0]!, source: { kind: 'artifact', taskId: 'second' } }] } },
    ] })
    const states = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    const copies = states.filter((task) => task.contract?.template?.id === 'extract-letters')
    expect(copies).toHaveLength(2)
    expect(states.find((task) => task.contract?.template?.id === 'count-letters')!.contract!.inputs[0]!.source)
      .toEqual({ kind: 'artifact', taskId: copies[1]!.taskId })
  })

  it('rejects template shortcuts and missing contracts before admission', async () => {
    const h = await setup()
    const before = factsOf(h.medium)
    for (const input of [{ taskId: h.parent.taskId, useTemplateDecomposition: true },
      { taskId: h.parent.taskId, children: [] },
      { taskId: h.parent.taskId, children: recipe },
      { taskId: h.parent.taskId, children: [{ ...h.children[0]!, template: 'extract-letters' }] },
    ]) await expect(decompose(h.apparatus, h.scheduler, h.caller, input as never)).rejects.toThrow()
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('keeps hypotheses separate from verified evidence and names invalid citations', async () => {
    const h = await setup()
    const before = factsOf(h.medium)
    const handoff = { decisions: [], hypotheses: ['Punctuation changes the count.'], exclusions: [], evidence: [h.parent.taskId] }
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId,
      children: [{ ...h.children[0]!, handoff }] }))).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining(h.parent.taskId) })
    expect(factsOf(h.medium)).toEqual(before)
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId,
      children: [{ ...h.children[0]!, handoff: { ...handoff, evidence: [] } }] })
    expect(h.dispatched).toEqual(['dispatch'])
  })

  it.each(['missing-dependency', 'cycle', 'unknown-support', 'duplicate-key', 'invalid-budget',
    'wrong-template-digest', 'removed-standard', 'wrong-producer'] as const)('refuses %s before creating children', async (kind) => {
    const h = await setup(), first = h.children[0]!, second = h.children[1]!
    let children: readonly PlannedChild[] = h.children
    switch (kind) {
      case 'missing-dependency': children = [first, { ...second, dependsOn: [] }]; break
      case 'cycle': children = [{ ...first, dependsOn: ['count'] }, second]; break
      case 'unknown-support': children = [{ ...first, supports: ['missing'] }]; break
      case 'duplicate-key': children = [first, first]; break
      case 'invalid-budget': children = [{ ...first, maxRuns: 0, requirement: 'required' as const }]; break
      case 'wrong-template-digest': children = [{ ...first, contract: { ...first.contract,
        template: { id: 'extract-letters', digest: '0'.repeat(64) } } }]; break
      case 'removed-standard': children = [{ ...first, contract: { ...first.contract,
        criteria: [{ criterionId: 'different', statement: 'A different standard.' }] } }]; break
      case 'wrong-producer': children = [{ ...first, contract: contractFor(h.apparatus.domain,
        h.apparatus.domain.templates.get('count-source')!, 'count source') }, second]; break
    }
    const before = factsOf(h.medium)
    await expect(decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children })).rejects.toThrow()
    expect(factsOf(h.medium)).toEqual(before)
    expect(h.dispatched).toEqual([])
  })

  it('validates optional reusable decomposition advice when admitting a method', async () => {
    const h = await setup(), { assets } = await loadMethod(h.apparatus, h.parent.method)
    const before = factsOf(h.medium)
    await expect(createMethod(h.apparatus, { ...assets, templates: assets.templates.map((raw) => {
      const template = raw as { id: string }
      return template.id === h.apparatus.domain.rootTemplate ? { ...template,
        decomposition: { children: [{ ...recipe[0]!, template: 'missing' }] } } : template
    }) })).rejects.toThrow()
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('rejects a stranger without preparing a child', async () => {
    const h = await setup(), before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, callerOf(agentFor('stranger', 'stranger-session')),
      { taskId: h.parent.taskId, children: h.children }))).toMatchObject({ code: 'not-responsible' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('keeps the declared attempt budget', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children })
    const child = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find((state) => state.contract?.template?.id === 'extract-letters')!
    const caller = callerOf(agentFor(child.responsibility!.agentId, child.responsibility!.agentId))
    const run = await startAttempt(h.apparatus, caller, child.taskId, 'first', await seedMethod(h.apparatus))
    await h.apparatus.tasks.forAgent(caller.agentId).failRun({ commandId: 'failed', taskId: child.taskId, runId: run.runId, reason: 'failed exploration' })
    const before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => retry(h.apparatus, caller, 'retry', { taskId: child.taskId }))).toMatchObject({ code: 'illegal-transition' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('rejects repeated responsibility under a fresh child key while work is pending', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children })
    const before = factsOf(h.medium)
    await expect(decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId,
      children: [{ ...h.children[0]!, key: 'additional' }] })).rejects.toThrow('duplicate child responsibility')
    expect(factsOf(h.medium)).toEqual(before)
  })
})

it('appends independent responsibilities during child execution while retaining execution and submission barriers', async () => {
  const h = await setup()
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [h.children[0]!] })
  const child = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(h.parent.taskId)!.decomposition!.children[0]!
  const state = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(child.taskId)!
  await startAttempt(h.apparatus, { ...h.caller, agentId: state.responsibility!.agentId, sessionId: state.responsibility!.agentId }, child.taskId, 'in-flight', h.parent.method)
  const additional = { ...h.children[0]!, key: 'independent', contract: { ...h.children[0]!.contract, goal: 'Independently check the source encoding.' } }
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [additional] })
  const { coordinationOf } = await import('../src/coordination.ts')
  expect(coordinationOf(h.apparatus, h.parent.taskId).responsibility).toMatchObject({ canPlan: true, canExecute: false, canSubmit: false })
  const before = factsOf(h.medium)
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [additional] })
  expect(factsOf(h.medium)).toEqual(before)
})

it('allows one exact root-to-worker handoff, replays it, and refuses recursive redelegation', async () => {
  const h = await setup()
  const handoff = { key: 'deliver', contract: h.parent.contract, supports: h.parent.contract.criteria.map(criterion => criterion.criterionId),
    dependsOn: [], maxRuns: 1, requirement: 'required' as const }
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [handoff] })
  const before = factsOf(h.medium)
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: [handoff] })
  expect(factsOf(h.medium)).toEqual(before)
  const state = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(h.parent.taskId)!
  const childId = state.decomposition!.children[0]!.taskId
  const child = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(childId)!
  const caller = { ...h.caller, agentId: child.responsibility!.agentId, sessionId: child.responsibility!.agentId }
  await startAttempt(h.apparatus, caller, childId, 'working', h.parent.method)
  await expect(decompose(h.apparatus, h.scheduler, caller, { taskId: childId, children: [handoff] })).rejects.toThrow('ancestor responsibility')
})

it('exposes direction and root-local metadata without exposing another trial', async () => {
  const h = await setup()
  await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children: h.children.map(child => ({ ...child,
    handoff: { decisions: ['Private branch working advice'], hypotheses: [], exclusions: [], evidence: [] },
  })) })
  const states = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const child = [...states.values()].find(state => state.contract?.template?.id === 'extract-letters')!
  const caller = { ...h.caller, agentId: child.responsibility!.agentId, sessionId: child.responsibility!.agentId }
  await startAttempt(h.apparatus, caller, child.taskId, 'metadata', h.parent.method)
  const foreign = await propose(h.apparatus, { ...h.caller, agentId: 'foreign', sessionId: 'foreign' }, 'foreign',
    { contract: { goal: 'Private task in a different trial', artifact: 'private.txt', inputs: [], criteria: [{ criterionId: 'private', statement: 'Private criterion' }] } })
  const { coordinationOf } = await import('../src/coordination.ts')
  const { readForAgent } = await import('../src/read.ts')
  expect(coordinationOf(h.apparatus, child.taskId).direction!.root).toMatchObject({ taskId: h.parent.taskId, goal: h.parent.contract.goal })
  const overview = await readForAgent(h.apparatus, caller.agentId, { kind: 'workflow' }) as { rootId: string; nodes: { taskId: string }[] }
  expect(overview.rootId).toBe(h.parent.taskId)
  expect(overview.nodes).toHaveLength(3)
  expect(overview.nodes.some(node => node.taskId === foreign.taskId)).toBe(false)
  expect(JSON.stringify(overview)).not.toContain('Private branch working advice')
  expect(JSON.stringify(overview)).not.toContain('handoff')
  await expect(readForAgent(h.apparatus, caller.agentId, { kind: 'workflow', ref: foreign.taskId })).rejects.toThrow('outside this Task root')
})
