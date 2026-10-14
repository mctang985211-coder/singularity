import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it } from 'vitest'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { openApparatus, bindCaller } from '../src/apparatus.ts'
import { commandOf, loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { createMethod, loadMethod, methodEnvironment, methodOfRun, publishedMethod, type MethodAssets } from '../src/method.ts'
import { assertMethodAdmitted } from '../src/method-admission.ts'
import { templateDeclaration } from '../src/read.ts'
import { methodSkill, mountMethodSkills, recordMethodContext, runMethodTool } from '../src/method-run.ts'
import { IMPROVEMENT_TEMPLATE, REVIEW_TEMPLATE } from '../src/review.ts'
import { propose } from '../src/surfaces.ts'
import { taskStateOf } from '../src/apparatus.ts'
import { agentFor, attachmentsAt, FakePersistence } from './seam.ts'

const dir = '/home/ROXY/code/singularity-core/deployment/domain/letters'
const tool = "import {readFileSync} from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2],'utf8').match(/[A-Za-z]/g)??[]).length))"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-method-'))
  roots.push(root)
  const domain = await loadDomain(dir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('method-spec', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root))
  const assets: MethodAssets = { rootTemplate: apparatus.domain.rootTemplate, templates: [...apparatus.domain.templates.values()].map(templateDeclaration), skills: [{ name: 'count', description: 'Count letters', capabilities: ['count'], requiredTools: ['count'], content: 'Count letters using available evidence.' }], tools: [{ name: 'count', source: tool }] }
  const caller = { agentId: 'method-agent', sessionId: 'method-session', model: { provider: 'test', model: 'test' } }
  await bindCaller(apparatus, caller)
  return { apparatus, assets, caller, root, medium }
}

it('refuses use of a frozen candidate before its independent review passes', async () => {
  const { apparatus, assets } = await setup()
  const revision = await createMethod(apparatus, assets)
  expect(() => assertMethodAdmitted(apparatus, revision)).toThrow('no passing independent review')
  await apparatus.store.close()
})

it('offers pinned Skills without forcing a template binding or recording discovery as a load', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, assets)
  const proposal = await propose(apparatus, caller, 'discover-skills', { goal: 'count letters', method })
  const view = JSON.parse((await methodSkill(apparatus, caller.agentId))!)
  expect(view.assigned[0].bindings.skills).toEqual([])
  expect(view.skills).toEqual([{ taskId: proposal.taskId, name: 'count', description: 'Count letters' }])
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.some(use => use.method === 'skill:count')).toBe(false)
  await apparatus.store.close()
})

it('delivers candidate guidance and bound Skills separately from the fixed root objective, including recovery', async () => {
  const { apparatus, assets, caller, root, medium } = await setup()
  const method = await createMethod(apparatus, { ...assets, templates: assets.templates.map(raw => {
    const template = raw as { id: string }
    return template.id === assets.rootTemplate ? { ...template, goal: 'APPLY_CANDIDATE_METHOD_MARKER', skills: ['count'] } : template
  }) })
  const proposal = await propose(apparatus, caller, 'evaluation-context', { goal: 'fixed human objective', method }, { purpose: 'evaluation' })
  const task = taskStateOf(apparatus, proposal.taskId)
  expect(task.contract!.goal).toBe('fixed human objective')
  expect(proposal.methodContext).toMatchObject({ guidance: 'APPLY_CANDIDATE_METHOD_MARKER',
    boundSkills: [{ name: 'count', content: assets.skills[0]!.content }] })
  const loaded = await loadMethod(apparatus, method)
  const template = loaded.domain.templates.get(loaded.assets.rootTemplate)!
  const workspace = join(root, 'tasks', proposal.taskId, 'runs', proposal.runId)
  expect(proposal.methodContext!.references).toEqual([loaded.domain.dir, ...loaded.domain.references])
  expect(proposal.methodContext!.localCheck).toEqual(commandOf(template.verifier,
    join(workspace, template.artifact), join(workspace, template.input.name)))
  expect(task.runs[proposal.runId]!.consumed.some(use => use.method === 'skill:count')).toBe(false)
  const context = await methodSkill(apparatus, caller.agentId)
  expect(JSON.parse(context!).assigned[0]).toMatchObject(proposal.methodContext!)
  await recordMethodContext(apparatus, caller.agentId)
  const consumption = taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed
  expect(consumption).toContainEqual({ method: 'skill:count', source: `${method.digest}/context:skill:count:${digestOf(assets.skills[0])}` })
  await recordMethodContext(apparatus, caller.agentId)
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed).toEqual(consumption)
  await apparatus.store.close()
  const restored = await openApparatus('method-spec', root, await loadDomain(dir, spawnProcess), medium as unknown as SessionPersistence, attachmentsAt(root))
  expect(await methodSkill(restored, caller.agentId)).toBe(context)
  await recordMethodContext(restored, caller.agentId)
  expect(taskStateOf(restored, proposal.taskId).runs[proposal.runId]!.consumed).toEqual(consumption)
  await restored.store.close()
})

it('executes generated verifier samples from exact literal content, including an empty input', async () => {
  const { apparatus, assets } = await setup()
  const content = { ...assets, tools: [...assets.tools, { name: 'content-check',
    source: "import {readFileSync} from 'node:fs'; process.exit(readFileSync(process.argv[2],'utf8') === 'accepted bytes' && readFileSync(process.argv[3],'utf8') === '' ? 0 : 1)",
    verifier: { samples: [
      { name: 'accept exact bytes', artifactContent: 'accepted bytes', inputContent: '', expected: 'pass' as const },
      { name: 'reject changed bytes', artifactContent: 'wrong bytes', inputContent: '', expected: 'fail' as const },
    ] } }] }
  const revision = await createMethod(apparatus, content)
  expect((await loadMethod(apparatus, revision)).assets).toEqual(content)
  await apparatus.store.close()
})

it('returns generated verifier execution details when a declared positive sample fails', async () => {
  const { apparatus, assets } = await setup()
  await expect(createMethod(apparatus, { ...assets, tools: [...assets.tools, { name: 'broken-check',
    source: "console.error('cannot compile staged RTL sample'); process.exit(1)",
    verifier: { samples: [
      { name: 'positive', artifactContent: 'sample RTL', inputContent: '', expected: 'pass' },
      { name: 'negative', artifactContent: 'changed RTL', inputContent: '', expected: 'fail' },
    ] } }] })).rejects.toThrow('cannot compile staged RTL sample')
  await apparatus.store.close()
})

it('loads the exact immutable content and admits a self-created template using the declared domain ports', async () => {
  const { apparatus, assets } = await setup()
  const custom = structuredClone(assets.templates[0]) as { id: string; goal: string }
  custom.id = 'count-exploration'
  custom.goal = 'Count using a streaming traversal.'
  const content = { ...assets, templates: [...assets.templates, custom] }
  const revision = await createMethod(apparatus, content)
  expect((await loadMethod(apparatus, revision)).assets).toEqual(content)
  expect((await loadMethod(apparatus, revision)).domain.templates.get(custom.id)?.goal).toBe(custom.goal)
  await expect(createMethod(apparatus, content)).resolves.toEqual(revision)
  await apparatus.store.close()
})

it('refuses changes to protected task input or acceptance while allowing changed solver instructions', async () => {
  const { apparatus, assets } = await setup()
  let changed = structuredClone(assets.templates) as { goal: string; input: { source: { ref: string } }; criterion: { verifier: string } }[]
  changed[0]!.goal = 'Use a single-pass counter.'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).resolves.toBeDefined()
  changed = structuredClone(changed)
  changed[0]!.criterion.verifier = 'extract-letters'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).rejects.toThrow('acceptance')
  changed[0]!.criterion.verifier = 'letters'
  changed[0]!.input.source.ref = 'invented-source'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).rejects.toThrow()
  await apparatus.store.close()
})

it('passes a model-created candidate to the pinned auxiliary tool without making it the submission', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, { ...assets,
    tools: [{ name: 'count', source: "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[3],'utf8').toUpperCase())" }] })
  const proposal = await propose(apparatus, caller, 'candidate-test', { goal: 'inspect candidate', method })
  const result = await runMethodTool(apparatus, caller, proposal.taskId, 'inspect', new AbortController().signal, 'count', 'model-created source')
  expect(result.artifact).toBe('MODEL-CREATED SOURCE')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.submission).toBeUndefined()
  await apparatus.store.close()
})

it('freezes capability bindings to Skills and Tools from the same Revision and reports uncovered declarations', async () => {
  const { apparatus, assets, caller } = await setup()
  const probe = { name: 'probe', source: "process.stdout.write('probe result')" }
  const method = await createMethod(apparatus, { ...assets,
    templates: assets.templates.map(raw => {
      const template = raw as { id: string }
      return template.id === assets.rootTemplate ? { ...template, capabilities: ['count', 'probe', 'yosys'] } : template
    }), tools: [...assets.tools, probe] })
  const proposal = await propose(apparatus, caller, 'bind-generated-assets', { goal: 'count letters', method })
  const run = taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!
  const manifest = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!
    .revisions[run.revision.revisionId]!.manifest as { bindings: unknown }
  const bindings = { skills: [{ name: 'count', digest: digestOf(assets.skills[0]) }],
    tools: [{ name: 'count', digest: digestOf(assets.tools[0]) }, { name: 'probe', digest: digestOf(probe) }], gaps: ['yosys'] }
  expect(manifest.bindings).toEqual(bindings)
  const view = JSON.parse((await methodSkill(apparatus, caller.agentId))!)
  expect(view.assigned[0]).toMatchObject({ method, bindings })
  expect((await runMethodTool(apparatus, caller, proposal.taskId, 'probe', new AbortController().signal, 'probe')).artifact).toBe('probe result')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed).toContainEqual({
    method: 'tool:probe', source: `${method.digest}/tool:probe:${digestOf(probe)}:${caller.sessionId}/probe` })
  await apparatus.store.close()
})

it('keeps an existing Run on its Revision across publication and reload, while a new Run consumes the published version', async () => {
  const { apparatus, assets, caller, root, medium } = await setup()
  const first = await createMethod(apparatus, assets)
  const secondAssets = { ...assets,
    skills: [{ ...assets.skills[0]!, content: 'Second version instructions.' }],
    tools: [{ name: 'count', source: "process.stdout.write('second version')" }, { name: 'new-tool', source: "process.stdout.write('new Tool')" }] }
  const second = await createMethod(apparatus, secondAssets)
  const environmentId = methodEnvironment(apparatus)
  await apparatus.store.emit({ commandId: 'publish-first', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: environmentId, payload: { expected: '', to: first.revisionId } })
  const original = await propose(apparatus, caller, 'before-publication', { goal: 'original task' })
  await apparatus.store.emit({ commandId: 'publish-second', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: environmentId, payload: { expected: first.revisionId, to: second.revisionId } })
  await apparatus.store.close()
  const restored = await openApparatus(apparatus.controlId, root, apparatus.domain, medium as unknown as SessionPersistence, attachmentsAt(root))
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry, {})
    await mountMethodSkills(restored, Object.assign(agentFor(caller.agentId, caller.sessionId), { ctx }))
    expect((await ctx.skills.get('count'))?.content).toBe(assets.skills[0]!.content)
    const firstResult = await runMethodTool(restored, caller, original.taskId, 'first-tool', new AbortController().signal, 'count')
    expect(firstResult.artifact).toMatch(/^\d+$/)
    const originalRun = taskStateOf(restored, original.taskId).runs[original.runId]!
    expect(methodOfRun(restored, originalRun)).toEqual(first)
    expect(originalRun.consumed).toContainEqual({ method: 'skill:count', source: `${first.digest}/skill:count:${digestOf(assets.skills[0])}` })
    expect(originalRun.consumed.every(use => use.source.startsWith(`${first.digest}/`))).toBe(true)
    expect(publishedMethod(restored)).toEqual(second)
    await expect(runMethodTool(restored, caller, original.taskId, 'new-tool', new AbortController().signal, 'new-tool'))
      .rejects.toThrow('absent from the pinned Revision')
    const nextCaller = { ...caller, agentId: 'next-agent', sessionId: 'next-session' }
    const next = await propose(restored, nextCaller, 'after-publication', { goal: 'next task' })
    const nextCtx = new Context()
    try {
      await nextCtx.plugin(SkillRegistry, {})
      await mountMethodSkills(restored, Object.assign(agentFor(nextCaller.agentId, nextCaller.sessionId), { ctx: nextCtx }))
      expect((await nextCtx.skills.get('count'))?.content).toBe(secondAssets.skills[0]!.content)
      expect((await runMethodTool(restored, nextCaller, next.taskId, 'next-tool', new AbortController().signal, 'count')).artifact).toBe('second version')
      const nextRun = taskStateOf(restored, next.taskId).runs[next.runId]!
      expect(methodOfRun(restored, nextRun)).toEqual(second)
      expect(nextRun.consumed.every(use => use.source.startsWith(`${second.digest}/`))).toBe(true)
      expect([...restored.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).values()]
        .filter(environment => environment.pointer !== undefined).map(environment => environment.environmentId)).toEqual([environmentId])
    } finally { await nextCtx.fiber.dispose() }
  } finally { await ctx.fiber.dispose(); await restored.store.close() }
})

it('reads the Run frozen binding instead of recomputing it from the current resolver', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, { ...assets,
    templates: assets.templates.map(raw => {
      const template = raw as { id: string }
      return template.id === assets.rootTemplate ? { ...template, capabilities: ['count'] } : template
    }) })
  const proposal = await propose(apparatus, caller, 'recorded-binding', { goal: 'count letters', method })
  await apparatus.tasks.forAgent(caller.agentId).failRun({ commandId: 'finish-original', taskId: proposal.taskId, runId: proposal.runId, reason: 'fixture stopped' })
  const bindings = { skills: [], tools: [], gaps: ['count'] }
  const manifest = { method, bindings }
  await apparatus.environments.createRevision({ commandId: 'frozen-context', environmentId: apparatus.controlId, revisionId: 'frozen-context', manifest })
  await apparatus.tasks.forAgent(caller.agentId).startRun({ commandId: 'frozen-run', taskId: proposal.taskId, runId: 'frozen-run',
    revision: { environmentId: apparatus.controlId, revisionId: 'frozen-context', digest: digestOf(manifest) } })
  expect(JSON.parse((await methodSkill(apparatus, caller.agentId))!).assigned[0]).toMatchObject({ method, bindings })
  await apparatus.store.close()
})

it('records Tool consumption only after successful execution and records it once', async () => {
  const { apparatus, assets, caller } = await setup()
  const conditional = { name: 'count', source: "import {readFileSync} from 'node:fs'; if (readFileSync(process.argv[3],'utf8') !== 'pass') { console.error('rejected candidate'); process.exit(1) }; process.stdout.write('accepted')" }
  const method = await createMethod(apparatus, { ...assets, tools: [conditional] })
  const proposal = await propose(apparatus, caller, 'tool-failure', { goal: 'inspect tool', method })
  await expect(runMethodTool(apparatus, caller, proposal.taskId, 'failed', new AbortController().signal, 'count', 'fail')).rejects.toThrow('rejected candidate')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.some(use => use.method === 'tool:count')).toBe(false)
  await runMethodTool(apparatus, caller, proposal.taskId, 'success', new AbortController().signal, 'count', 'pass')
  await runMethodTool(apparatus, caller, proposal.taskId, 'again', new AbortController().signal, 'count', 'pass')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.filter(use => use.method === 'tool:count')).toEqual([
    { method: 'tool:count', source: `${method.digest}/tool:count:${digestOf(conditional)}:${caller.sessionId}/success` } ])
  await apparatus.store.close()
})

it.each([REVIEW_TEMPLATE, IMPROVEMENT_TEMPLATE])('rejects an incomplete Revision missing %s without minting another version', async id => {
  const { apparatus, assets } = await setup()
  const incomplete = { ...assets, templates: assets.templates.filter(raw => (raw as { id: string }).id !== id) }
  const revisionId = 'incomplete-method'
  await apparatus.environments.createRevision({ commandId: 'incomplete', environmentId: methodEnvironment(apparatus), revisionId, manifest: incomplete })
  const reference = { environmentId: methodEnvironment(apparatus), revisionId, digest: digestOf(incomplete) }
  const count = apparatus.store.load().entries().length
  await expect(loadMethod(apparatus, reference)).rejects.toThrow('Revision lacks infrastructure template ' + id)
  expect(apparatus.store.load().entries()).toHaveLength(count)
  await apparatus.store.close()
})
