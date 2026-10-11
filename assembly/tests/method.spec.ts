import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it } from 'vitest'
import { openApparatus, bindCaller } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { createMethod, loadMethod, type MethodAssets } from '../src/method.ts'
import { methodSkill, observeMethodSkill, runMethodTool } from '../src/method-run.ts'
import { propose } from '../src/surfaces.ts'
import { taskStateOf } from '../src/apparatus.ts'
import { attachmentsAt, FakePersistence } from './seam.ts'

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
  const declared = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as { rootTemplate: string; templates: unknown[] }
  const assets: MethodAssets = { rootTemplate: declared.rootTemplate, templates: declared.templates, skill: 'Use the method tool, then submit its program.', tool }
  const caller = { agentId: 'method-agent', sessionId: 'method-session', model: { provider: 'test', model: 'test' } }
  await bindCaller(apparatus, caller)
  return { apparatus, assets, caller }
}

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

it('records template construction, model-visible skill and executed tool as three real consumptions of one pinned Method', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, assets)
  const proposal = await propose(apparatus, caller, 'propose', { goal: 'method trial', method })
  const readRun = () => taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!
  expect(readRun().consumed.map(entry => entry.method)).toEqual(['template'])
  const skill = await methodSkill(apparatus, caller.agentId)
  expect(skill).toContain(assets.skill)
  expect(readRun().consumed.map(entry => entry.method)).toEqual(['template'])
  await observeMethodSkill(apparatus, caller.sessionId, skill!, 'system/message:3')
  const result = await runMethodTool(apparatus, caller, proposal.taskId, 'tool-call', new AbortController().signal)
  expect(result.program).toBe(tool)
  expect(result.artifact).toBe((await readFile(join(dir, 'samples/pass-report.txt'), 'utf8')).trim())
  expect(readRun().consumed.map(entry => entry.method)).toEqual(['template', 'skill', 'tool'])
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
