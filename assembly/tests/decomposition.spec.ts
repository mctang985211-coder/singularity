import { seedMethod } from '../src/method.ts'
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
import { decompose, propose, retry } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { createMethod, loadMethod } from '../src/method.ts'
import { templateDeclaration } from '../src/read.ts'
import { attachmentsAt, agentFor, factsOf, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const children: readonly PlannedChild[] = [
  { key: 'extract', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 },
  { key: 'count', template: 'count-letters', dependsOn: ['extract'], supports: ['letters'], maxRuns: 1 },
]

async function setup(recipe?: readonly PlannedChild[]) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-plan-'))
  roots.push(root)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('plans', root, await loadDomain(domainDir, spawnProcess), medium as never, attachmentsAt(root),
  )
  const agent = agentFor('parent', 'parent-session')
  const caller = callerOf(agent)
  const method = recipe === undefined ? undefined : await createMethod(apparatus, { rootTemplate: apparatus.domain.rootTemplate,
    templates: [...apparatus.domain.templates.values()].map((template) => ({ ...templateDeclaration(template),
      ...(template.id === apparatus.domain.rootTemplate ? { applicability: 'independent extraction and counting', decomposition: { children: recipe } } : {}),
          })),
    skills: [], tools: [],
        })
  const parent = await propose(apparatus, caller, 'propose', { goal: 'count letters', ...(method === undefined ? {} : { method }),
  })
  const dispatched: string[] = []
  const scheduler = { advance: async () => { dispatched.push('dispatch')
      return [] }, close: async () => undefined,
  }
  return { apparatus, medium, agent, caller, parent, scheduler, dispatched }
}

describe('a fully checked domain decomposition', () => {
  it('selects only direct children of the pinned definition and replays without duplicate instances or facts', async () => {
    const h = await setup(children)
    expect(h.parent.methodContext).toMatchObject({ applicability: 'independent extraction and counting', decomposition: { children },
    })
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, useTemplateDecomposition: true })
    const before = factsOf(h.medium)
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, useTemplateDecomposition: true })
    expect(factsOf(h.medium)).toEqual(before)
    expect(before.filter((fact) => fact.kind === 'task/decomposed')).toHaveLength(1)
    expect(before.filter((fact) => fact.kind === 'task/admitted')).toHaveLength(3)
    expect(before.some(
        (fact) => fact.kind === 'method/consumed' && (fact.payload as { method: string }).method.startsWith('decomposition:'),
      ),
    ).toBe(true)
  })

  it('rejects conflicting declarations under a committed instance key', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children })
    const before = factsOf(h.medium)
    await expect(decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId,
      children: [{ ...children[0]!, maxRuns: 2 }],
      }),
    ).rejects.toMatchObject({ refusal: { code: 'command-conflict' } })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('allows multiple instances of the same reusable definition', async () => {
    const h = await setup([{ ...children[0]!, key: 'first' }, { ...children[0]!, key: 'second' },
    ])
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, useTemplateDecomposition: true })
    const instances = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .filter(
      (task) => task.contract?.template?.id === 'extract-letters',
    )
    expect(instances).toHaveLength(2)
    expect(instances[0]!.taskId).not.toBe(instances[1]!.taskId)
  })

  it('rejects missing, empty and mixed selection before admission', async () => {
    const h = await setup()
    const before = factsOf(h.medium)
    for (const input of [{ taskId: h.parent.taskId, useTemplateDecomposition: true },
      { taskId: h.parent.taskId, children: [] }, { taskId: h.parent.taskId, children, useTemplateDecomposition: true },
    ])
      await expect(decompose(h.apparatus, h.scheduler, h.caller, input as never)).rejects.toThrow()
    expect(factsOf(h.medium)).toEqual(before)
  })

  it.each([
    ['unknown-template', [{ ...children[0]!, template: 'missing' }]],
    ['missing-producer', [{ ...children[1]!, dependsOn: [] }]],
    ['cycle', [{ ...children[0]!, dependsOn: ['count'] }, children[1]!]],
    ['unknown-support', [{ ...children[0]!, supports: ['missing'] }]],
    ['duplicate-key', [children[0]!, children[0]!]],
    ['wrong-producer', [{ ...children[0]!, template: 'count-source' }, children[1]!]],
  ] as const)('refuses reusable %s during Revision admission', async (_case, recipe) => {
    const h = await setup()
    const reference = h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).get(h.parent.taskId)!.runs[h.parent.runId]!.revision
    const { assets } = await loadMethod(h.apparatus, reference)
    const before = factsOf(h.medium)
    await expect(createMethod(h.apparatus, { ...assets, templates: assets.templates.map((raw) => {
      const template = raw as { id: string }
      return template.id === assets.rootTemplate ? { ...template, decomposition: { children: recipe } } : template
    }),
      }),
    ).rejects.toThrow()
    expect(factsOf(h.medium)).toEqual(before)
  })

  it.each([
    ['unknown-template', [{ ...children[0]!, template: 'missing' }]],
    ['missing-producer', [{ ...children[1]!, dependsOn: [] }]],
    ['unknown-key', [{ ...children[1]!, dependsOn: ['missing'] }]],
    ['cycle', [{ ...children[0]!, dependsOn: ['count'] }, children[1]!]],
    ['unknown-support', [{ ...children[0]!, supports: ['missing'] }]],
    ['duplicate-key', [children[0]!, children[0]!]],
    ['invalid-budget', [{ ...children[0]!, maxRuns: 0 }]],
    ['wrong-producer', [{ ...children[0]!, template: 'count-source' }, children[1]!]],
    ['ambiguous-producer', [children[0]!, { ...children[0]!, key: 'other' }, { ...children[1]!, dependsOn: ['extract', 'other'] }],
    ],
  ] as const)('refuses %s before creating or admitting children', async (_case, proposal) => {
    const h = await setup()
    const before = factsOf(h.medium)
    await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, h.caller,
      { taskId: h.parent.taskId, children: proposal }),
    )
    expect(factsOf(h.medium)).toEqual(before)
    expect(h.dispatched).toEqual([])
  })

  it('rejects a stranger before binding the stranger or preparing a child', async () => {
    const h = await setup()
    const before = factsOf(h.medium)
    const stranger = agentFor('stranger', 'stranger-session')
    expect(await asyncRefusalOf(() => decompose(h.apparatus, h.scheduler, callerOf(stranger),
      { taskId: h.parent.taskId, children }),
      ),
    ).toMatchObject({ code: 'not-responsible' })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('keeps an assigned node within its own Task and declared Run budget', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children })
    const child = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(
      (state) => state.contract?.template?.id === 'extract-letters',
    )!
    const id = child.responsibility!.agentId
    const caller = callerOf(agentFor(id, id))
    const run = await startAttempt(h.apparatus, caller, child.taskId, 'first', await seedMethod(h.apparatus))
    await h.apparatus.tasks.forAgent(id).failRun({ commandId: 'failed', taskId: child.taskId, runId: run.runId, reason: 'failed exploration' })
    const before = factsOf(h.medium)
    expect(await asyncRefusalOf(() => retry(h.apparatus, caller, 'retry', { taskId: child.taskId }))).toMatchObject({ code: 'illegal-transition',
      detail: expect.stringContaining('runtime failure'),
    })
    expect(factsOf(h.medium)).toEqual(before)
  })

  it('publishes child-specific contracts with the precise producer Task source', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children })
    const states = [...h.apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    const extract = states.find((state) => state.contract?.template?.id === 'extract-letters')!
    const count = states.find((state) => state.contract?.template?.id === 'count-letters')!
    expect(extract.contract?.criteria[0]?.criterionId).toBe('extracted')
    expect(count.contract).toMatchObject({ inputs: [{ name: 'in/letters.txt', source: { kind: 'artifact', taskId: extract.taskId } }],
      criteria: [{ criterionId: 'counted' }],
    })
    expect(factsOf(h.medium).at(-1)?.kind).toBe('task/decomposed')
    expect(h.dispatched).toEqual(['dispatch'])
  })

  it('refuses another delegation while retaining pending responsibilities', async () => {
    const h = await setup()
    await decompose(h.apparatus, h.scheduler, h.caller, { taskId: h.parent.taskId, children })
    const before = factsOf(h.medium)
    await expect(decompose(h.apparatus, h.scheduler, h.caller,
      { taskId: h.parent.taskId, children: [{ ...children[0]!, key: 'additional' }] },
    )).rejects.toThrow('delegated responsibilities are pending')
    expect(factsOf(h.medium)).toEqual(before)
  })
})
