/** Recipes bind pinned children and use the existing structural admission and persistence. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import { decompositionDigest } from '../../../task/src/index.ts'
import type { DecomposeSpec } from '../../src/types.ts'
import { harness, ROOT_SESSION, STORE, taskEvents } from './orchestrate.fixture.ts'
import { pinSkillHome } from '../support/skill-roots.ts'

const roots: string[] = []
beforeEach(() => pinSkillHome('verify'))
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const contract = { objective: 'verify the original project', acceptanceCriteria: [{ description: 'project check passes', command: 'true' }], requiredCapabilities: ['recipe-guidance'] }

async function fixture() {
  const library = await mkdtemp(join(tmpdir(), 'task-recipe-')); roots.push(library)
  const h = harness({ config: { taskTemplatesRoot: library, capabilities: { 'recipe-guidance': { skills: ['verify'] } } } })
  const root = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, contract)
  if (root.status !== 'activated') throw new Error(root.detail)
  return { h, root }
}
function recipe(children: NonNullable<TaskTemplate['decomposition']>['children'], version = 1): TaskTemplate {
  return { id: 'verify-plan', version, catalogPath: ['general'], appliesTo: ['project verification'],
    parametersSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
    contract, decomposition: { reason: 'verify {{project}} in dependency order', children } }
}

describe('direct-child decomposition templates', () => {
  test('commits expanded child bindings, recipe provenance and the actual dependency; later publication cannot change them', async () => {
    const { h, root } = await fixture()
    const child = await h.runtime.registerTaskTemplate({ id: 'verify-child', version: 1, catalogPath: ['general'], appliesTo: ['project check'],
      parametersSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
      contract: { ...contract, objective: 'verify {{project}}' } })
    const authored = recipe([
      { templateRef: child, templateParameters: { project: '{{project}}' }, dependsOn: [1] },
      { ...contract, objective: 'prepare {{project}}' },
    ])
    const ref = await h.runtime.registerTaskTemplate(authored)
    const spec: DecomposeSpec = { templateRef: ref, templateParameters: { project: 'demo' } }
    const batch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, spec)
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const snapshot = await h.task.snapshotIn(STORE)
    const proposal = snapshot.proposals!.all.find(item => item.kind !== 'root' && item.identity.parentRunId === root.runId)!
    if (proposal.kind === 'root') throw new Error('expected decomposition')
    expect(proposal.identity.templateRef).toEqual(ref)
    expect(proposal.identity.templateParameters).toEqual({ project: 'demo' })
    expect(decompositionDigest(proposal.identity)).toBe(proposal.proposalDigest)
    expect(proposal.batch[0]!.contract.objective).toBe('verify demo')
    expect(proposal.batch[0]!.contract.templateRef).toEqual(child)
    expect(proposal.batch[1]!.contract.objective).toBe('prepare demo')
    expect(snapshot.edges).toContainEqual({ from: batch.childTaskIds[1], to: batch.childTaskIds[0] })
    const before = structuredClone(proposal)
    await h.runtime.registerTaskTemplate(recipe([{ ...contract, objective: 'a different future plan' }], 2))
    await h.task.openStore(STORE)
    expect((await h.task.snapshotIn(STORE)).proposals!.byId[proposal.proposalId]).toEqual(before)
    expect((await h.task.taskIn(STORE, root.taskId)).objective).toBe(contract.objective)
  })

  test('cycles and wrong sibling indices are denied by normal decomposition admission without creating child tasks', async () => {
    const { h, root } = await fixture()
    const before = (await h.task.snapshotIn(STORE)).tasks.length
    for (const [index, dependencies] of [[[1], [0]], [[0], []], [[2], []]].entries()) {
      const ref = await h.runtime.registerTaskTemplate(recipe(dependencies.map((dependsOn, child) => ({ ...contract, objective: `child ${child}`, dependsOn })), index + 1))
      await expect(h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION,
        { templateRef: ref, templateParameters: { project: 'demo' } })).rejects.toThrow(/cycle|itself|out of range/)
    }
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(before)
    expect(taskEvents(h).filter(event => event.kind === 'TaskDecomposed')).toEqual([])
  })

  test('a caller cannot replace a selected recipe or omit the pinned reference and required parameters', async () => {
    const { h, root } = await fixture()
    const ref = await h.runtime.registerTaskTemplate(recipe([contract]))
    for (const spec of [
      { templateRef: ref, templateParameters: { project: 'demo' }, children: [contract], reason: 'override' },
      { templateRef: ref, templateParameters: {} },
      { templateRef: { ...ref, digest: '0'.repeat(64) }, templateParameters: { project: 'demo' } },
      { templateParameters: { project: 'demo' }, children: [contract], reason: 'fake provenance' },
    ]) await expect(h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, spec as DecomposeSpec)).rejects.toThrow(/override|parameter|reference/i)
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
  })
})
