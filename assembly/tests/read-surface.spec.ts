import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { openApparatus, declareCaller } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { createMethod } from '../src/method.ts'
import { spawnProcess } from '../src/process.ts'
import { historyOf } from '../src/read.ts'
import { propose, status } from '../src/surfaces.ts'
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
  expect(proposal.templates).toEqual(templates)
  await expect(createMethod(apparatus, { rootTemplate: declared.rootTemplate, templates: proposal.templates, skill: 'Inspect source.', tool: 'process.stdout.write("inspection")' })).resolves.toMatchObject({ digest: expect.any(String) })
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
  const declaration = JSON.parse(await readFile(join(letters, 'task.json'), 'utf8'))
  const assets = { rootTemplate: declaration.rootTemplate, templates: declaration.templates, skill: 'Count.', tool: counting }
  const reference = await createMethod(apparatus, assets)
  expect((await historyOf(apparatus, [])).methods).toEqual([{ reference, assets }])
})
