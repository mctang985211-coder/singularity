import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import { contractDigest, taskTemplateDigest } from '../../../task/src/index.ts'
import { bindTaskTemplate, findTaskTemplates, parseTaskTemplate, registerTaskTemplate } from '../../src/task-template.ts'
import { defineTaskTemplateListTool } from '../../../agent-singularity/src/tools/task-template-list.ts'
import { harness, ROOT_SESSION, STORE, taskEvents } from './orchestrate.fixture.ts'

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
    id: 'verify-project', version,
    appliesTo: ['A project already provides an authoritative check command.'],
    parametersSchema: {
      type: 'object', additionalProperties: false,
      properties: { project: { type: 'string' }, check: { type: 'string' } },
      required: ['project', 'check'],
    },
    contract: {
      objective: `Verify {{project}} with project acceptance v${version}`,
      acceptanceCriteria: [{ criterionId: 'project-check', description: '{{project}} passes its check', command: '{{check}}' }],
      assumptions: ['{{project}} has an existing checker'], constraints: ['Preserve the checker'], requiredCapabilities: [],
    },
  }
}
const parameters = { project: 'demo', check: 'true' }

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
    const listed = await defineTaskTemplateListTool({ taskRuntime: h.runtime } as never).execute!({ query: 'project' }, {} as never)
    expect(JSON.parse(listed as string)).toEqual([{ templateRef: second, template: template(2) }])
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
    const h = harness()
    expect(await h.runtime.findTaskTemplates('a new goal')).toEqual([])
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'a new goal', acceptanceCriteria: [{ description: 'the existing checker passes', command: 'true' }],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const task = await h.task.taskIn(STORE, activated.taskId)
    expect(task.templateRef).toBeUndefined()
    expect(task.contractDigest).toBe(contractDigest(task.contract!))
    expect(task.definitionRef.taskType).toBe(`contract:${task.contractDigest}`)
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

describe('intake preserves a settleable goal and a root owner for missing capability', () => {
  test('keeps missing capability in the live contract, gap record and persistent obligation, with an explicit root owner', async () => {
    const h = harness()
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'produce the requested accelerator result',
      acceptanceCriteria: [{ description: 'the original authoritative acceptance passes', command: 'true' }],
      requiredCapabilities: ['missing-accelerator-provider'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks[0]?.objective).toBe('produce the requested accelerator result')
    expect(snapshot.tasks[0]?.requestedCapabilities).toEqual(['missing-accelerator-provider'])
    expect(snapshot.capabilities[activated.taskId]?.missing).toEqual(['missing-accelerator-provider'])
    expect(snapshot.obligations).toEqual([expect.objectContaining({ sourceTaskId: activated.taskId, criterion: expect.stringContaining(ROOT_SESSION) })])
    expect(activated.detail).toContain('owns missing-capability obligations')
    expect(taskEvents(h).filter(event => event.kind === 'CapabilityGapDetected')).toHaveLength(1)
  })

  test('refuses implicit mandatory review but accepts an explicitly registered supported judge and rejects mode mismatch', async () => {
    const h = harness()
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result', acceptanceCriteria: [{ description: 'someone decides it is good' }],
    })).rejects.toThrow(/explicit registered verifier/)
    Object.assign(h.verifier, { verifierIds: () => ['project-review'], verifierSupports: (_id: string, mode: string) => mode === 'review' })
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result',
      acceptanceCriteria: [{ description: 'the registered review settles it', mode: 'formal', verifierRef: 'project-review' }],
    })).rejects.toThrow(/does not support mode/)
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'deliver the original result',
      acceptanceCriteria: [{ description: 'the registered review settles it', mode: 'review', verifierRef: 'project-review' }],
    })
    expect(activated.status).toBe('activated')
  })
})
