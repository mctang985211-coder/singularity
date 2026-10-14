import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../../src/environment/protocol.ts'
import { openApparatus, declareCaller } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { createMethod, loadMethod, methodOfRun, seedMethod } from '../src/method.ts'
import { REVIEW_TEMPLATE, SUBJECT_INPUT } from '../src/review.ts'
import { sha256 } from '../src/ids.ts'
import { spawnProcess } from '../src/process.ts'
import { historyOf, templateDeclaration } from '../src/read.ts'
import { propose, retry, status } from '../src/surfaces.ts'
import { submit } from '../src/submission.ts'
import { attachmentsAt, agentFor, execFor, fakeExecution, FakePersistence } from './seam.ts'

const letters = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const shaDomain = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))
const counting = "import { readFileSync } from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))"
const extracting = "import { readFileSync } from 'node:fs'; process.stdout.write((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).join(''))"
const caller = { agentId: 'root', sessionId: 'root-session', model: { provider: 'test', model: 'test' } }
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function fixture(dir = letters) {
  const root = await mkdtemp(join(tmpdir(), 'singularity-read-'))
  const persistence = new FakePersistence()
  const apparatus = await openApparatus('read', root, await loadDomain(dir, spawnProcess), persistence as unknown as SessionPersistence, attachmentsAt(root))
  cleanup = async () => { await apparatus.store.close(); await rm(root, { recursive: true, force: true }) }
  return { apparatus, persistence }
}

it('publishes the actual protected input, initial source and reusable template declarations', async () => {
  const { apparatus } = await fixture(shaDomain)
  const proposal = await propose(apparatus, caller, 'read-input', { goal: 'implement schedule' })
  const declared = JSON.parse(await readFile(join(shaDomain, 'task.json'), 'utf8'))
  expect(proposal.inputContent).toBe(await readFile(join(shaDomain, declared.inputs[0].from), 'utf8'))
  expect(proposal.initialSource).toBe(await readFile(join(shaDomain, 'seed/sha256_w_mem.v'), 'utf8'))
  const templates = declared.templates.map((template: { workspace: { initial?: string } }) => {
    delete template.workspace.initial
    return template
  })
  expect(proposal.templates.slice(0, templates.length)).toMatchObject(templates)
  await expect(createMethod(apparatus, { rootTemplate: declared.rootTemplate, templates: proposal.templates, skills: [], tools: [] })).resolves.toMatchObject({ digest: expect.any(String) })
})

it('reads every settled Run and source from sealed attachments after workspace mutation', async () => {
  const { apparatus, persistence } = await fixture()
  const first = await propose(apparatus, caller, 'first', { goal: 'count letters' })
  await submit(apparatus, fakeExecution(() => undefined), caller, execFor(agentFor(caller.agentId, caller.sessionId), 'submit-first'), { taskId: first.taskId, program: counting }, new AbortController().signal)
  await writeFile(join(first.workspace, 'program.mjs'), 'overwritten source')
  await writeFile(join(first.workspace, 'report.txt'), 'overwritten artifact')
  const second = await propose(apparatus, caller, 'second', { goal: 'count letters' })
  expect(second.taskId).toBe(first.taskId)
  const before = persistence.events.length
  const result = await status(apparatus, caller, { taskId: first.taskId })
  expect(result.task.runs).toHaveLength(2)
  expect(result.task.runs[0]).toMatchObject({ runId: first.runId, program: counting, artifact: '35', source: { sessionId: caller.sessionId } })
  expect(result.task.runs[1]).toMatchObject({ runId: second.runId, program: null, artifact: null })
  expect(persistence.events).toHaveLength(before)
  const history = await historyOf(apparatus, [])
  expect(history.tasks).toEqual([result.task])
  expect(history.decisions).toEqual([])
})

it('retries the exact failed contract and Revision after the publication pointer changes', async () => {
  const { apparatus, persistence } = await fixture()
  const first = await propose(apparatus, caller, 'first', { goal: 'Count letters; preserve the exact protected input and natural-language acceptance.' })
  const task = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, first.taskId)!
  const original = methodOfRun(apparatus, task.runs[first.runId]!)!
  await apparatus.tasks.forAgent(caller.agentId).failRun({ commandId: 'failed', taskId: first.taskId, runId: first.runId, reason: 'not accepted' })
  const assets = (await historyOf(apparatus, [])).methods[0]!.assets
  const changed = structuredClone(assets.templates) as { goal: string }[]
  changed[0]!.goal = 'Changed published method instructions.'
  const published = await createMethod(apparatus, { ...assets, templates: changed })
  await apparatus.store.emit({ commandId: 'changed-head', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: published.environmentId, payload: { expected: '', to: published.revisionId } })
  const second = await retry(apparatus, caller, 'second', { taskId: first.taskId })
  const after = (await status(apparatus, caller, { taskId: first.taskId })).task
  expect(after.contract).toEqual(task.contract)
  expect(methodOfRun(apparatus, apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, first.taskId)!.runs[second.runId]!)).toEqual(original)
  expect(second).toMatchObject({ taskId: first.taskId, inputContent: first.inputContent, templates: first.templates })
  const cutoff = persistence.events.length
  expect(await retry(apparatus, caller, 'second', { taskId: first.taskId })).toEqual(second)
  expect(persistence.events).toHaveLength(cutoff)
  expect(await asyncRefusalOf(() => retry(apparatus, { ...caller, agentId: 'other' }, 'third', { taskId: first.taskId }))).toMatchObject({ code: 'not-responsible' })
})

it('allows only the exact direct parent to read its child sealed answer', async () => {
  const { apparatus } = await fixture()
  const parent = await propose(apparatus, caller, 'parent', { goal: 'count letters' })
  const child = { agentId: 'child', sessionId: 'child-session', model: caller.model }
  declareCaller(apparatus, child.agentId)
  await apparatus.agents.open({ commandId: 'child-agent', agentId: child.agentId, sessionId: child.sessionId, role: 'child' })
  const template = apparatus.domain.templates.get('extract-letters')!
  await apparatus.tasks.admit({ commandId: 'child-contract', taskId: 'child-task', contract: contractFor(apparatus.domain, template, template.goal) })
  await apparatus.tasks.assign({ commandId: 'child-owner', taskId: 'child-task', agentId: child.agentId })
  await apparatus.tasks.forAgent(caller.agentId).decompose({ commandId: 'parent-plan', parentTaskId: parent.taskId, children: [{ taskId: 'child-task', dependsOn: [], supports: ['letters'], maxRuns: 1 }] })
  const run = await startAttempt(apparatus, child, 'child-task', 'child-run')
  const whileWorking = await status(apparatus, caller, { taskId: 'child-task' })
  expect(whileWorking.task.runs[0]).toMatchObject({ runId: run.runId, artifact: null })
  await submit(apparatus, fakeExecution(() => undefined), child, execFor(agentFor(child.agentId, child.sessionId), 'child-submit'), { taskId: 'child-task', program: extracting }, new AbortController().signal)
  const result = await status(apparatus, caller, { taskId: 'child-task' })
  expect(result.task.runs[0]?.artifact).toBe('Thequickbrownfoxjumpsoverthelazydog')
  expect((await asyncRefusalOf(() => status(apparatus, { ...caller, agentId: 'unrelated' }, { taskId: 'child-task' }))).code).toBe('not-responsible')
})

it('publishes complete immutable Method contents in the same history port', async () => {
  const { apparatus } = await fixture()
  const assets = { rootTemplate: apparatus.domain.rootTemplate, templates: [...apparatus.domain.templates.values()].map(templateDeclaration), skills: [], tools: [{ name: 'count', source: counting }] }
  const reference = await createMethod(apparatus, assets)
  expect((await historyOf(apparatus, [])).methods).toEqual([{ reference, assets }])
})

it('keeps independent trial history inside its own tree and pinned Revision', async () => {
  const { apparatus } = await fixture()
  const original = await propose(apparatus, caller, 'original', { goal: 'count letters' })
  await submit(apparatus, fakeExecution(() => undefined), caller, execFor(agentFor(caller.agentId, caller.sessionId), 'accepted'),
    { taskId: original.taskId, program: counting }, new AbortController().signal)
  const seed = methodOfRun(apparatus, apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, original.taskId)!.runs[original.runId]!)!
  const assets = (await historyOf(apparatus, [])).methods[0]!.assets
  const candidate = await createMethod(apparatus, { ...assets, skills: [{ name: 'candidate-answer', description: 'secret', capabilities: [], requiredTools: [], content: 'previous solved answer' }] })
  const trialCaller = { ...caller, agentId: 'trial', sessionId: 'trial-session' }
  const trial = await propose(apparatus, trialCaller, 'trial', { goal: 'count letters', method: seed },
    { purpose: 'evaluation', relatedTo: { taskId: original.taskId, runId: original.runId } })
  const history = await historyOf(apparatus, [], trialCaller.agentId)
  expect(history.tasks.map(task => task.taskId)).toEqual([trial.taskId])
  expect(history.methods.map(method => method.reference)).toEqual([seed])
  expect(history.methods.some(method => method.reference.digest === candidate.digest)).toBe(false)
  expect(history.tasks.flatMap(task => task.runs).every(run => run.artifact === null)).toBe(true)
  expect(history.decisions).toEqual([])
})

it('exposes an audit frozen basis and candidate without exposing unrelated method assets', async () => {
  const { apparatus } = await fixture()
  const owner = await propose(apparatus, caller, 'owner', { goal: 'count letters' })
  const seed = await seedMethod(apparatus)
  const { assets, domain } = await loadMethod(apparatus, seed)
  const withTool = (name: string) => ({ ...assets, tools: [{ name, source: counting }] })
  const basis = await createMethod(apparatus, withTool('basis'))
  const revision = await createMethod(apparatus, withTool('candidate'))
  const unrelated = await createMethod(apparatus, withTool('unrelated'))
  const bytes = Buffer.from(JSON.stringify({ purpose: 'asset-admission', taskId: owner.taskId, runId: owner.runId, basis, revision }))
  const auditDomain = { ...domain, inputs: [...domain.inputs.filter(input => input.ref !== SUBJECT_INPUT),
    { ref: SUBJECT_INPUT, digest: sha256(bytes), bytes, sourcePath: '' }] }
  const reviewer = { ...caller, agentId: 'reviewer', sessionId: 'reviewer-session' }
  declareCaller(apparatus, reviewer.agentId)
  await apparatus.agents.open({ commandId: 'reviewer-agent', agentId: reviewer.agentId, sessionId: reviewer.sessionId, role: 'review' })
  const template = auditDomain.templates.get(REVIEW_TEMPLATE)!
  await apparatus.tasks.admit({ commandId: 'review-contract', taskId: 'review-task',
    contract: { ...contractFor(auditDomain, template, template.goal), assets: seed } })
  await apparatus.tasks.assign({ commandId: 'review-owner', taskId: 'review-task', agentId: reviewer.agentId })
  await startAttempt(apparatus, reviewer, 'review-task', 'review-run', seed, { domain: auditDomain, purpose: 'review' })
  const history = await historyOf(apparatus, [], reviewer.agentId)
  expect(history.methods.map(method => method.reference)).toEqual([seed, basis, revision])
  expect(history.tasks.map(task => task.taskId)).toEqual([owner.taskId, 'review-task'])
  expect(history.methods.some(method => method.reference.digest === unrelated.digest)).toBe(false)
})
