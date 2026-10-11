import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { callerOf, openApparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import type { PlannedChild } from '../src/driver.ts'
import { spawnProcess } from '../src/process.ts'
import { decompose, propose } from '../src/surfaces.ts'
import { agentFor, factsOf, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const children: readonly PlannedChild[] = [
  { key: 'extract', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 },
  { key: 'count', template: 'count-letters', dependsOn: ['extract'], supports: ['letters'], maxRuns: 1 },
]

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'assembly-plan-'))
  roots.push(root)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('plans', root, await loadDomain(domainDir, spawnProcess), medium as never)
  const agent = agentFor('parent', 'parent-session')
  const caller = callerOf(agent)
  const parent = await propose(apparatus, caller, 'propose', { goal: 'count letters' })
  const dispatched: string[] = []
  const scheduler = { advance: async () => { dispatched.push('dispatch'); return [] }, settled: async () => [], close: async () => undefined }
  return { apparatus, medium, agent, caller, parent, scheduler, dispatched }
}

describe('a fully checked domain decomposition', () => {
  it.each([
    ['unknown-template', [{ ...children[0]!, template: 'missing' }]],
    ['missing-producer', [{ ...children[1]!, dependsOn: [] }]],
    ['unknown-key', [{ ...children[1]!, dependsOn: ['missing'] }]],
    ['cycle', [{ ...children[0]!, dependsOn: ['count'] }, children[1]!]],
    ['unknown-support', [{ ...children[0]!, supports: ['missing'] }]],
    ['duplicate-key', [children[0]!, children[0]!]],
    ['invalid-budget', [{ ...children[0]!, maxRuns: 0 }]],
    ['wrong-producer', [{ ...children[0]!, template: 'count-source' }, children[1]!]],
    ['ambiguous-producer', [children[0]!, { ...children[0]!, key: 'other' }, { ...children[1]!, dependsOn: ['extract', 'other'] }]],
  ] as const)('refuses %s before creating or admitting children', async (_case, proposal) => {
    const h = await setup()
    const before = factsOf(h.medium)
    await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, h.caller, h.agent,
      { taskId: h.parent.taskId, children: proposal }))
    expect(factsOf(h.medium)).toEqual(before)
    expect(h.dispatched).toEqual([])
  })

  it('rejects a stranger before binding the stranger or preparing a child', async () => {
    const h = await setup()
    const before = factsOf(h.medium)
    const stranger = agentFor('stranger', 'stranger-session')
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, callerOf(stranger), stranger,
      { taskId: h.parent.taskId, children }))).toMatchObject({ code: 'not-responsible' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('refuses an assigned child proposing another root Task before binding or admitting it', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, h.agent, { taskId: h.parent.taskId, children })
    const child = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(state => state.contract?.template.id === 'extract-letters')!
    const id = child.responsibility!.agentId
    const before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => propose(h.apparatus, callerOf(agentFor(id, id)), 'fork-root', { goal: 'new independent task' })))
      .toMatchObject({ code: 'illegal-transition' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('refuses an assigned child publishing another plan before creating any descendants', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, h.agent, { taskId: h.parent.taskId, children })
    const child = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(state => state.contract?.template.id === 'extract-letters')!
    const id = child.responsibility!.agentId
    const agent = agentFor(id, id)
    const before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, callerOf(agent), agent,
      { taskId: child.taskId, children }))).toMatchObject({ code: 'illegal-transition' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('publishes child-specific contracts with the precise producer Task source', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, h.agent, { taskId: h.parent.taskId, children })
    const states = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    const extract = states.find(state => state.contract?.template.id === 'extract-letters')!
    const count = states.find(state => state.contract?.template.id === 'count-letters')!
    expect(extract.contract?.criteria[0]?.criterionId).toBe('extracted')
    expect(count.contract).toMatchObject({ inputs: [{ name: 'in/letters.txt', source: { kind: 'artifact', taskId: extract.taskId } }],
      criteria: [{ criterionId: 'counted' }] })
    expect(factsOf(h.medium).at(-1)?.kind).toBe('task/decomposed')
    expect(h.dispatched).toEqual(['dispatch'])
  })

  it('rejects a changed plan replay without adding preparation facts', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, h.agent, { taskId: h.parent.taskId, children })
    const before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, h.caller, h.agent,
      { taskId: h.parent.taskId, children: [{ ...children[0]!, key: 'changed' }] }))).toMatchObject({ code: 'command-conflict' })
    expect(factsOf(h.medium)).toEqual(before)
  })
})
