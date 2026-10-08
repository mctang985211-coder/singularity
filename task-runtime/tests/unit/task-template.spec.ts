import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import { contractDigest, taskTemplateDigest } from '../../../task/src/index.ts'
import { bindTaskDecomposition, bindTaskTemplate, findTaskTemplates, parseTaskTemplate, registerTaskTemplate, taskTemplatePage } from '../../src/task-template.ts'
import { defineTaskTemplateListTool } from '../../../agent-singularity/src/tools/task-template-list.ts'
import { harness as baseHarness, ROOT_SESSION, STORE, taskEvents } from './orchestrate.fixture.ts'
import { pinSkillHome } from '../support/skill-roots.ts'

beforeEach(() => pinSkillHome('verify'))
function harness(options: Parameters<typeof baseHarness>[0] = {}, sessions?: Parameters<typeof baseHarness>[1]) {
  return baseHarness({ ...options, config: { ...options.config, capabilities: {
    'template-guidance': { skills: ['verify'] }, ...options.config?.capabilities,
  } } }, sessions)
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function library() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-task-templates-'))
  roots.push(root)
  return root
}
function template(version = 1): TaskTemplate {
  return {
    id: 'verify-project', version, catalogPath: ['general'],
    appliesTo: ['A project already provides an authoritative check command.'],
    parametersSchema: {
      type: 'object', additionalProperties: false,
      properties: { project: { type: 'string' }, check: { type: 'string' } },
      required: ['project', 'check'],
    },
    contract: {
      objective: `Verify {{project}} with project acceptance v${version}`,
      acceptanceCriteria: [{ criterionId: 'project-check', description: '{{project}} passes its check', command: '{{check}}' }],
      assumptions: ['{{project}} has an existing checker'], constraints: ['Preserve the checker'], requiredCapabilities: ['template-guidance'],
    },
  }
}
const parameters = { project: 'demo', check: 'true' }
function categorized(id: string, catalogPath: string[]): TaskTemplate {
  return { ...template(), id, catalogPath }
}

describe('immutable task templates enter the existing contract path', () => {
  test('registration is append-only, discovery lists latest versions and exposes the complete binding contract', async () => {
    const root = await library()
    const first = await registerTaskTemplate(root, template())
    expect(first.digest).toBe(taskTemplateDigest(template()))
    expect(await registerTaskTemplate(root, template())).toEqual(first)
    await expect(registerTaskTemplate(root, { ...template(), appliesTo: ['different'] })).rejects.toThrow(/new version/)
    const second = await registerTaskTemplate(root, template(2))
    expect((await findTaskTemplates(root, 'project'))[0]?.templateRef).toEqual(second)
    expect(await findTaskTemplates(root, 'unrelated')).toEqual([])
    expect(await findTaskTemplates(undefined)).toEqual([])
    const h = harness({ config: { taskTemplatesRoot: root } })
    const listed = await defineTaskTemplateListTool({ taskRuntime: h.runtime } as never).execute!({ templateRef: second }, { agent: { id: ROOT_SESSION } } as never)
    expect(JSON.parse(listed as string)).toEqual({ templateRef: second, template: template(2) })
    expect(parseTaskTemplate(JSON.parse(await readFile(join(root, 'verify-project@1.json'), 'utf8')))).toEqual(template())
  })

  test('root and child bind before normal admission; later versions leave the old instance and run unchanged through reopening', async () => {
    const root = await library()
    const h = harness({ config: { taskTemplatesRoot: root } })
    const first = await h.runtime.registerTaskTemplate(template())
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, { templateRef: first, templateParameters: parameters })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const before = await h.task.snapshotIn(STORE)
    const original = structuredClone(before.tasks[0]!)
    const originalRun = structuredClone(before.runs[0]!)
    expect(original.objective).toBe('Verify demo with project acceptance v1')
    expect(original.templateRef).toEqual(first)
    expect(original.templateParameters).toEqual(parameters)
    expect(original.definitionRef).toEqual({ taskType: first.id, version: first.version, digest: first.digest })
    expect(original.contractDigest).toBe(contractDigest(original.contract!))
    const second = await h.runtime.registerTaskTemplate(template(2))
    expect((await h.runtime.findTaskTemplates())[0]?.templateRef).toEqual(second)
    const reopened = harness({ config: { taskTemplatesRoot: root } }, h.sessions)
    await reopened.task.openStore(STORE)
    const replayed = await reopened.task.snapshotIn(STORE)
    expect(replayed.tasks[0]).toEqual(original)
    expect(replayed.runs[0]).toEqual(originalRun)
    const batch = await h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'Verify the direct result with the current reusable contract',
      children: [{ templateRef: second, templateParameters: parameters }],
    })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const child = await h.task.taskIn(STORE, batch.childTaskIds[0]!)
    expect(child.templateRef).toEqual(second)
    expect(child.objective).toContain('v2')
    expect(child.contractDigest).toBe(contractDigest(child.contract!))
    expect(child.status).toBe('verified')
    expect((await h.task.taskIn(STORE, activated.taskId)).templateRef).toEqual(first)
  })

  test('no applicable template permits a complete free contract with its real content source', async () => {
    const root = await library()
    const h = harness({ config: { taskTemplatesRoot: root } })
    expect(await h.runtime.findTaskTemplates('a new goal')).toEqual([])
    const page = await h.runtime.listTaskTemplates({ query: 'a new goal' }, ROOT_SESSION)
    expect(page).toMatchObject({ entries: [], message: expect.stringContaining('complete one-off contract') })
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'a new goal', acceptanceCriteria: [{ description: 'the existing checker passes', command: 'true' }],
      requiredCapabilities: ['template-guidance'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const task = await h.task.taskIn(STORE, activated.taskId)
    expect(task.templateRef).toBeUndefined()
    expect(task.contractDigest).toBe(contractDigest(task.contract!))
    expect(task.definitionRef.taskType).toBe(`contract:${task.contractDigest}`)
    const batch = await h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'a new result without a matching shared template',
      children: [{ objective: 'deliver the next one-off result',
        acceptanceCriteria: [{ description: 'the result passes its own existing check', command: 'true' }],
        requiredCapabilities: ['template-guidance'] }],
    })
    const [outcome] = await h.runtime.awaitBatch(STORE, batch.batchId)
    expect(outcome?.status).toBe('verified')
    expect((await h.task.taskIn(STORE, batch.childTaskIds[0]!)).templateRef).toBeUndefined()
    expect(await h.runtime.findTaskTemplates()).toEqual([])
  })

  test('rejects invalid parameter bindings and digest/source overrides before recording any proposal', async () => {
    const root = await library()
    const ref = await registerTaskTemplate(root, template())
    const h = harness({ config: { taskTemplatesRoot: root } })
    for (const spec of [
      { templateRef: ref, templateParameters: { project: 'demo' } },
      { templateRef: ref, templateParameters: { ...parameters, surprise: true } },
      { templateRef: ref, templateParameters: { ...parameters, project: 12 } },
      { templateRef: { ...ref, digest: '0'.repeat(64) }, templateParameters: parameters },
      { templateRef: ref, templateParameters: parameters, objective: 'replace the requested goal' },
      { templateParameters: parameters, objective: 'free', acceptanceCriteria: [{ description: 'check', command: 'true' }] },
    ]) {
      await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, spec)).rejects.toThrow(/task-template/)
    }
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated' || event.kind === 'TaskProposalSubmitted')).toEqual([])
    expect(() => parseTaskTemplate({ ...template(), parametersSchema: { ...template().parametersSchema, oneOf: [] } })).toThrow(/parametersSchema/)
  })

  test('bound protected acceptance paths are fixed in the current checkout before contract persistence', async () => {
    const root = await library()
    await writeFile(join(root, 'oracle.txt'), 'original project oracle')
    const authored = template()
    authored.contract.acceptanceCriteria = [{ description: 'project oracle succeeds', command: '{{check}}', protectedInputs: ['{{project}}'] }]
    const ref = await registerTaskTemplate(root, authored)
    const h = harness({ config: { taskTemplatesRoot: root } })
    vi.spyOn(h.runtime, 'envPathForSession').mockResolvedValue(root)
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      templateRef: ref, templateParameters: { project: 'oracle.txt', check: 'true' },
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const task = await h.task.taskIn(STORE, activated.taskId)
    expect(task.contract?.acceptanceCriteria[0]?.protectedInputs).toEqual([{ path: 'oracle.txt', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }])
    expect(task.contractDigest).toBe(contractDigest(task.contract!))
  })

  test('binding an older pinned version still succeeds after a newer version exists', async () => {
    const root = await library()
    const first = await registerTaskTemplate(root, template())
    await registerTaskTemplate(root, template(2))
    const bound = await bindTaskTemplate(root, { templateRef: first, templateParameters: parameters })
    expect(bound.objective).toContain('v1')
  })
})

describe('catalog summaries and contract scope', () => {
  test('recipe child parameter bindings preserve number and boolean types while contract text interpolates strings', async () => {
    const root = await library()
    const schema = {
      type: 'object' as const, additionalProperties: false as const,
      properties: { count: { type: 'integer' as const }, strict: { type: 'boolean' as const } }, required: ['count', 'strict'],
    }
    const authored = { ...template(), parametersSchema: schema, contract: { requiredCapabilities: ['template-guidance'], objective: 'verify {{count}} projects, strict={{strict}}', acceptanceCriteria: [{ description: 'check all projects', command: 'true' }] } }
    const childRef = await registerTaskTemplate(root, { ...authored, id: 'typed-child' })
    const recipeRef = await registerTaskTemplate(root, { ...authored, id: 'typed-recipe', decomposition: {
      reason: 'verify {{count}} targets', children: [{ templateRef: childRef, templateParameters: { count: '{{count}}', strict: '{{strict}}' } }],
    } })
    const expanded = await bindTaskDecomposition(root, { templateRef: recipeRef, templateParameters: { count: 2, strict: true } }, [])
    expect(expanded.children?.[0]?.templateParameters).toEqual({ count: 2, strict: true })
    expect((await bindTaskTemplate(root, expanded.children![0]!, [])).objective).toBe('verify 2 projects, strict=true')
  })

  test('derives categories from JSON and pages bounded summaries before the exact full read', async () => {
    const root = await library()
    const hardware = await registerTaskTemplate(root, categorized('hardware-check', ['hardware', 'buckyball']))
    await registerTaskTemplate(root, categorized('software-check', ['software', 'typescript']))
    await registerTaskTemplate(root, template())
    const browsing = await taskTemplatePage(root)
    expect(browsing.entries.map(item => item.kind)).toEqual(['catalog', 'catalog', 'catalog', 'template', 'template', 'template'])
    expect(browsing.entries.filter(item => item.kind === 'catalog').map(item => item.catalogPath)).toEqual([['general'], ['hardware'], ['software']])
    const selected = await taskTemplatePage(root, { catalogPath: ['hardware'], limit: 1 })
    expect(selected.entries).toEqual([{ kind: 'catalog', catalogPath: ['hardware', 'buckyball'], templates: 1 }])
    expect(selected.nextOffset).toBe(1)
    const next = await taskTemplatePage(root, { catalogPath: ['hardware'], offset: 1, limit: 1 })
    expect(next.entries).toEqual([expect.objectContaining({ kind: 'template', templateRef: hardware, parameters: ['project', 'check'] })])
    expect(JSON.stringify(next)).not.toContain('acceptanceCriteria')
    expect((await taskTemplatePage(root, { templateRef: hardware })).template).toEqual(categorized('hardware-check', ['hardware', 'buckyball']))
    expect((await taskTemplatePage(undefined)).message).toContain('No matching Task template')
    await expect(taskTemplatePage(root, { limit: 21 })).rejects.toThrow(/limit/)
    expect(() => parseTaskTemplate({ ...template(), catalogPath: ['x'.repeat(65)] })).toThrow(/catalogPath/)
    await expect(taskTemplatePage(root, { templateRef: { ...hardware, extra: true } } as never)).rejects.toThrow(/templateRef/)
  })

  test('keeps large escaped summaries within one finite page and resumes at the first omitted entry', async () => {
    const root = await library()
    for (let index = 0; index < 20; index += 1) await registerTaskTemplate(root, {
      ...categorized(`bounded-${index}`, ['hardware']), appliesTo: ['\u0001'.repeat(300), '\u0001'.repeat(300), '\u0001'.repeat(300)],
      contract: { ...template().contract, objective: '\u0001'.repeat(500) },
    })
    const page = await taskTemplatePage(root, { limit: 20 }, [['hardware']])
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(40_000)
    expect(page.nextOffset).toBe(page.entries.length)
    expect(page.entries.length).toBeLessThan(20)
    const next = await taskTemplatePage(root, { limit: 20, offset: page.nextOffset! }, [['hardware']])
    const firstRefs = page.entries.flatMap(item => 'templateRef' in item ? [item.templateRef.id] : [])
    const nextRefs = next.entries.flatMap(item => 'templateRef' in item ? [item.templateRef.id] : [])
    expect(nextRefs.some(id => firstRefs.includes(id))).toBe(false)
    expect(nextRefs.length).toBeGreaterThan(0)
  })

  test('root chooses a branch, child scopes inherit or narrow, and scoped listing and binding reject the same foreign reference', async () => {
    const root = await library()
    const hardware = await registerTaskTemplate(root, categorized('hardware-check', ['hardware', 'buckyball']))
    const software = await registerTaskTemplate(root, categorized('software-check', ['software', 'typescript']))
    const general = await registerTaskTemplate(root, template())
    expect((await bindTaskTemplate(root, { templateRef: hardware, templateParameters: parameters })).templateScope).toEqual([['hardware', 'buckyball']])
    const h = harness({ config: { taskTemplatesRoot: root } })
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'verify accelerator projects', templateScope: [['hardware'], ['hardware', 'buckyball']],
      acceptanceCriteria: [{ description: 'authoritative check passes', command: 'true' }], requiredCapabilities: ['template-guidance'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const task = await h.task.taskIn(STORE, activated.taskId)
    expect(task.contract?.templateScope).toEqual([['hardware']])
    const page = await h.runtime.listTaskTemplates({}, ROOT_SESSION)
    expect(JSON.stringify(page)).toContain('hardware-check')
    expect(JSON.stringify(page)).toContain('verify-project')
    expect(JSON.stringify(page)).not.toContain('software-check')
    const narrowPage = await taskTemplatePage(root, {}, [['hardware', 'buckyball']])
    expect(narrowPage.entries.filter(item => item.kind === 'catalog').map(item => item.catalogPath)).toEqual([['general'], ['hardware', 'buckyball']])
    const before = taskEvents(h).length
    await expect(h.runtime.listTaskTemplates({ templateRef: software }, ROOT_SESSION)).rejects.toThrow(/outside/)
    await expect(h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'foreign domain', children: [{ templateRef: software, templateParameters: parameters }],
    })).rejects.toThrow(/outside/)
    await expect(h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'widen domain', children: [{ templateRef: hardware, templateParameters: parameters, templateScope: [['software']] }],
    })).rejects.toThrow(/cannot widen/)
    expect(taskEvents(h)).toHaveLength(before)
    const batch = await h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'verify independent scoped projects', children: [
        { templateRef: hardware, templateParameters: { ...parameters, project: 'accelerator A' }, templateScope: [['hardware', 'buckyball']] },
        { templateRef: general, templateParameters: { ...parameters, project: 'accelerator B' } },
      ],
    })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const children = await Promise.all(batch.childTaskIds.map(id => h.task.taskIn(STORE, id)))
    expect(children.map(child => child.contract?.templateScope)).toEqual([[['hardware', 'buckyball']], [['hardware']]])
    const reopened = harness({ config: { taskTemplatesRoot: root } }, h.sessions)
    await reopened.task.openStore(STORE)
    expect((await reopened.task.taskIn(STORE, activated.taskId)).contract?.templateScope).toEqual([['hardware']])
  })

  test('binding one reusable template to different targets creates distinct instances and frozen contracts', async () => {
    const root = await library()
    const ref = await registerTaskTemplate(root, template())
    const h = harness({ config: { taskTemplatesRoot: root } })
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'verify two projects', acceptanceCriteria: [{ description: 'both project checks pass', command: 'true' }], requiredCapabilities: ['template-guidance'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const batch = await h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, {
      reason: 'each project has its own acceptance command',
      children: ['one', 'two'].map(project => ({ templateRef: ref, templateParameters: { project, check: 'true' } })),
    })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const [one, two] = await Promise.all(batch.childTaskIds.map(id => h.task.taskIn(STORE, id)))
    expect(one?.taskId).not.toBe(two?.taskId)
    expect(one?.contractDigest).not.toBe(two?.contractDigest)
    expect(one?.templateRef).toEqual(two?.templateRef)
    expect(one?.objective).toContain('one')
    expect(two?.objective).toContain('two')
  })
})

describe('intake preserves a settleable goal and a root owner for missing capability', () => {
  test('keeps missing capability in the live contract, gap record and persistent obligation, with an explicit root owner', async () => {
    const h = harness()
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'produce the requested accelerator result',
      acceptanceCriteria: [{ description: 'the original authoritative acceptance passes', command: 'true' }],
      requiredCapabilities: ['template-guidance', 'missing-accelerator-provider'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks[0]?.objective).toBe('produce the requested accelerator result')
    expect(snapshot.tasks[0]?.requestedCapabilities).toEqual(['template-guidance', 'missing-accelerator-provider'])
    expect(snapshot.capabilities[activated.taskId]?.missing).toEqual(['missing-accelerator-provider'])
    expect(snapshot.obligations).toEqual([expect.objectContaining({ sourceTaskId: activated.taskId, criterion: expect.stringContaining(ROOT_SESSION) })])
    expect(activated.detail).toContain('owns missing-capability obligations')
    expect(taskEvents(h).filter(event => event.kind === 'CapabilityGapDetected')).toHaveLength(1)
  })

  test('refuses implicit mandatory review but accepts an explicitly registered supported judge and rejects mode mismatch', async () => {
    const h = harness()
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result', acceptanceCriteria: [{ description: 'someone decides it is good' }],
      requiredCapabilities: ['template-guidance'],
    })).rejects.toThrow(/explicit registered verifier/)
    Object.assign(h.verifier, { verifierIds: () => ['project-review'], verifierSupports: (_id: string, mode: string) => mode === 'review' })
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result',
      requiredCapabilities: ['template-guidance'],
      acceptanceCriteria: [{ description: 'the registered review settles it', mode: 'formal', verifierRef: 'project-review' }],
    })).rejects.toThrow(/does not support mode/)
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result',
      requiredCapabilities: ['template-guidance'],
      acceptanceCriteria: [{ description: 'the registered review settles it', mode: 'review', verifierRef: 'project-review' }],
    })
    expect(activated.status).toBe('activated')
  })
})
