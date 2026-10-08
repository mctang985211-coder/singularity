import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, describe, expect, test } from 'vitest'
import type { TaskTemplate } from '../../../task/src/index.ts'
import { graphLibrary, ensureTaskLibrary, writeTaskLibrary, readTaskLibrary, reviewTaskLibrary, libraryCapabilities } from '../../src/library.ts'
import { bindTaskTemplate, taskTemplatePage, findTaskTemplates } from '../../src/task-template.ts'
import { harness, ROOT_SESSION, STORE } from './orchestrate.fixture.ts'

let home: string
let previousHome: string | undefined
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'singularity-library-')); previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home })
afterEach(async () => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true }) })
const skill = (body: string) => `---\nname: explore-metrics\ndescription: Explore a useful metric from task evidence.\n---\n${body}\n`
const template = (): TaskTemplate => ({
  id: 'explore-next-stage', version: 1, catalogPath: ['general'], appliesTo: ['A task needs to explore a useful next step.'],
  parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  contract: { objective: 'Explore a useful next step with task evidence', acceptanceCriteria: [{ description: 'The task result passes its check', command: 'true' }], requiredCapabilities: ['execute-task', 'method:explore-metrics'] },
})

describe('graph-owned task and method library', () => {
  test('fresh graphs have only general coordination guidance and never inherit host domain templates', async () => {
    const first = await ensureTaskLibrary(graphLibrary('s-one'))
    const second = await ensureTaskLibrary(graphLibrary('s-two'))
    await writeTaskLibrary(first, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Inspect the metric and record useful evidence.'), expectedVersion: 0 })
    const task = await writeTaskLibrary(first, { kind: 'task', template: template() })
    expect(task).toMatchObject({ status: 'temporary', skills: ['task-coordination', 'explore-metrics'] })
    expect((await readTaskLibrary(second)).tasks).toEqual([])
    expect((await readTaskLibrary(second)).skills.map(item => item.name)).toEqual(['task-coordination'])
    expect(first.root).toBe(join(home, 'singularity', 'environments', 's-one'))
    expect(first.skillRoot).not.toContain('.agents')
    expect((await libraryCapabilities(first))['method:explore-metrics']).toEqual({ skills: ['explore-metrics'], tools: ['skill'] })
  })

  test('empty graph adoption and recovery retain the real root session before first intake', async () => {
    const h = harness()
    h.graphs.graphForSession.mockImplementation(async (id: string) => {
      if (id !== ROOT_SESSION) throw new Error(`graphs: session ${id} not in graph`)
      return { id: 'g1', name: 'graph', envId: 'env1', rootSessionId: ROOT_SESSION, graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root', createdAt: 0, ready: true }
    })
    await expect(h.runtime.adoptRoot(STORE, ROOT_SESSION)).resolves.toMatchObject({ adopted: false })
    expect(h.graphs.graphForSession.mock.calls.every(([id]) => id === ROOT_SESSION)).toBe(true)
    expect((await h.runtime.libraryRead(ROOT_SESSION)).skills.map(item => item.name)).toContain('task-coordination')
    expect((await h.task.snapshotIn(STORE)).tasks).toEqual([])
    await h.runtime.unload()
  })

  test('concurrent updates serialize, demand the observed version, and preserve the previous method bytes', async () => {
    const library = graphLibrary('s-concurrency')
    await writeTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Method one'), expectedVersion: 0 })
    const attempts = await Promise.allSettled([
      writeTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Method two'), expectedVersion: 1 }),
      writeTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Competing method'), expectedVersion: 1 }),
    ])
    expect(attempts.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
    expect(await readFile(join(library.root, 'skill-versions', 'explore-metrics', '1', 'SKILL.md'), 'utf8')).toBe(skill('Method one'))
    await expect(writeTaskLibrary(library, { kind: 'task', template: template() })).resolves.toMatchObject({ status: 'temporary' })
    await expect(writeTaskLibrary(library, { kind: 'task', template: { ...template(), appliesTo: ['conflicting bytes'] } })).rejects.toThrow(/new version/)
  })

  test('temporary methods and task templates enter real Run bindings and children share the graph library', async () => {
    const h = harness()
    const method = await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Method one'), expectedVersion: 0 })
    const authored = { ...template(), catalogPath: ['python', 'metrics'] }
    const ref = await h.runtime.registerTaskTemplate(authored, ROOT_SESSION)
    expect(JSON.stringify(await h.runtime.listTaskTemplates({}, ROOT_SESSION))).toContain('explore-next-stage')
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, { templateRef: ref })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const original = await h.task.runIn(STORE, activated.runId)
    const library = await h.runtime.libraryForSession(ROOT_SESSION)
    expect(original.taskTemplatesRoot).toBe(library.taskTemplatesRoot)
    expect(JSON.stringify(await h.runtime.listTaskTemplates({}, ROOT_SESSION))).toContain('explore-next-stage')
    const originalBinding = structuredClone(original.providerBinding)
    expect(original.providerBinding?.skills.map(item => item.name)).toEqual(expect.arrayContaining(['task-coordination', 'explore-metrics']))
    expect(method).toMatchObject({ status: 'temporary', version: 1 })
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Method two'), expectedVersion: 1 })
    const batch = await h.runtime.decomposeAndRun(STORE, activated.taskId, activated.runId, ROOT_SESSION, { reason: 'Explore the next result', children: [{ templateRef: ref }] })
    await h.runtime.awaitBatch(STORE, batch.batchId)
    const child = await h.task.taskIn(STORE, batch.childTaskIds[0]!)
    const childRun = await h.task.runIn(STORE, child.runIds[0]!)
    expect(await h.runtime.libraryForSession(childRun.sessionId)).toEqual(library)
    expect(childRun.taskTemplatesRoot).toBe(library.taskTemplatesRoot)
    expect(childRun.providerBinding?.skills.find(item => item.name === 'explore-metrics')?.contentDigest).not.toEqual(original.providerBinding?.skills.find(item => item.name === 'explore-metrics')?.contentDigest)
    expect((await h.task.runIn(STORE, activated.runId)).providerBinding).toEqual(originalBinding)
    expect(await readFile(join(original.providerBinding!.snapshotRoot!, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(skill('Method one'))
    await h.runtime.unload()
  })

  test('candidate replay roots override the library while the source Run and graph methods stay frozen', async () => {
    const h = harness()
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Library method'), expectedVersion: 0 })
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, { ...template().contract })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    const original = await h.task.runIn(STORE, activated.runId)
    // Existing verifier service settles a submitted root into its independent Task result.
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'Completed the original result' })
    const overlay = join(home, 'candidate-skills')
    await mkdir(join(overlay, 'explore-metrics'), { recursive: true })
    await writeFile(join(overlay, 'explore-metrics', 'SKILL.md'), skill('Candidate method'))
    const outcome = await h.runtime.replayTask(STORE, activated.taskId, {
      lineage: 'library-candidate', overlay: { extraSkillRoots: [overlay] },
    }, ROOT_SESSION)
    expect(outcome.status).toBe('verified')
    const replay = await h.task.runIn(STORE, outcome.runId)
    expect(await readFile(join(replay.providerBinding!.snapshotRoot!, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(skill('Candidate method'))
    expect(replay.taskTemplatesRoot).not.toBe(original.taskTemplatesRoot)
    const view = await h.runtime.libraryRead(replay.sessionId)
    expect(view).toMatchObject({ readOnly: true, skillRoot: replay.providerBinding!.snapshotRoot, taskTemplatesRoot: replay.taskTemplatesRoot })
    expect(view.root).not.toBe((await h.runtime.libraryForSession(ROOT_SESSION)).root)
    await expect(h.runtime.libraryWrite(replay.sessionId, { kind: 'skill', name: 'explore-metrics', skillMd: skill('An experiment must not mutate the graph'), expectedVersion: 1 })).rejects.toThrow(/Include findings in task_submit_result/)
    await expect(h.runtime.libraryReview(replay.sessionId, { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'self approval' })).rejects.toThrow(/comparison findings/)
    expect((await h.task.runIn(STORE, activated.runId)).providerBinding).toEqual(original.providerBinding)
    expect(await readFile(join((await h.runtime.libraryForSession(ROOT_SESSION)).skillRoot, 'explore-metrics', 'SKILL.md'), 'utf8')).toBe(skill('Library method'))
    await h.runtime.unload()
  })

  test('retirement removes discoverable methods and templates while leaving immutable versions readable', async () => {
    const library = graphLibrary('s-retention')
    await writeTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Keep useful paths'), expectedVersion: 0 })
    const taskRow = await writeTaskLibrary(library, { kind: 'task', template: template() })
    const ref = 'templateRef' in taskRow ? taskRow.templateRef : undefined
    await reviewTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'Useful transfer with lower model effort in run one' }, 's-supervisor')
    expect((await readTaskLibrary(library)).skills.find(item => item.name === 'explore-metrics')).toMatchObject({ status: 'retained', reviewedBy: 's-supervisor' })
    await reviewTaskLibrary(library, { kind: 'task', name: template().id, version: 1, status: 'retired', reason: 'A simpler contract covered the result in run two' }, 's-supervisor')
    await reviewTaskLibrary(library, { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retired', reason: 'Redundant advice increased model effort in run two' }, 's-supervisor')
    expect(await findTaskTemplates(library.taskTemplatesRoot)).toEqual([])
    await expect(bindTaskTemplate(library.taskTemplatesRoot, { templateRef: ref })).rejects.toThrow(/retired/)
    expect((await taskTemplatePage(library.taskTemplatesRoot, { templateRef: ref! })).templateRef).toEqual(ref)
    await expect(reviewTaskLibrary(library, { kind: 'skill', name: 'task-coordination', version: 1, status: 'retired', reason: 'testing the baseline' }, 's-supervisor')).rejects.toThrow(/retain or revise/)
    expect((await libraryCapabilities(library))['method:explore-metrics']).toBeUndefined()
    expect(await readFile(join(library.taskTemplatesRoot, `${template().id}@1.json`), 'utf8')).toContain('explore-next-stage')
  })

  test('temporary writes remain available during planning and execution, and terminal workers keep read access', async () => {
    const h = harness()
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'task', template: { ...template(), contract: { ...template().contract, requiredCapabilities: ['execute-task'] } } })
    const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'Deliver a checked result', acceptanceCriteria: [{ description: 'The result passes the check', command: 'true' }], requiredCapabilities: ['execute-task'],
    })
    if (activated.status !== 'activated') throw new Error(activated.detail)
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('An experience from execution'), expectedVersion: 0 })
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'Delivered the checked result' })
    await expect(h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Late mutation'), expectedVersion: 1 })).rejects.toThrow(/active Task/)
    expect((await h.runtime.libraryRead(ROOT_SESSION)).skills.some(item => item.name === 'explore-metrics')).toBe(true)
    await h.runtime.unload()
  })

  test('provider admission checks the graph Evolution ledger before consuming a method', async () => {
    const h = harness()
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('Current method'), expectedVersion: 0 })
    const library = await h.runtime.libraryForSession(ROOT_SESSION)
    const scopedCallers: string[] = []
    let globalRead = false
    h.ctx.evolution = {
      openIntentTargets: async () => { globalRead = true; return [] },
      forSession: async (caller: string) => { scopedCallers.push(caller); return { openIntentTargets: async () => [join(library.skillRoot, 'explore-metrics', 'SKILL.md')], openIntentCapabilities: async () => [] } },
    }
    const report = await h.runtime.capabilityProviderReport(ROOT_SESSION, ['method:explore-metrics'])
    expect(scopedCallers).toEqual([ROOT_SESSION])
    expect(globalRead).toBe(false)
    expect(report.capabilities[0]!.skills[0]).toMatchObject({ valid: false, defects: [expect.objectContaining({ code: 'commit-intent-open' })] })
    await h.runtime.unload()
  })

  test('worker retention decisions require supervisor delegation', async () => {
    const h = harness()
    await h.runtime.libraryWrite(ROOT_SESSION, { kind: 'skill', name: 'explore-metrics', skillMd: skill('A useful path'), expectedVersion: 0 })
    await expect(h.runtime.libraryReview('s-worker', { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'self approval' })).rejects.toThrow(/supervisor/)
    h.ctx.singularityContext = { resolveCaller: async () => ({ kind: 'reviewer', delegation: { role: 'supervisor' } }) }
    await expect(h.runtime.libraryReview('s-supervisor', { kind: 'skill', name: 'explore-metrics', version: 1, status: 'retained', reason: 'The executed task supports retaining this path' })).resolves.toMatchObject({ status: 'retained', reviewedBy: 's-supervisor' })
  })
})
