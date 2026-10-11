import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { CONTROL_EVENT_TYPE } from '../../src/control/session-store.ts'
import { digestOf, sealEnvelope } from '../../src/protocol/envelope.ts'
import { TASK_KINDS } from '../../src/task/protocol.ts'
import { projectReceipt } from '../../src/task/view.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { bindCaller, openApparatus, taskStateOf, type Apparatus } from '../src/apparatus.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { loadDomain, type Domain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { sha256 } from '../src/ids.ts'
import { openDriver } from '../src/driver.ts'
import { repair } from '../src/repair.ts'
import { spawnProcess } from '../src/process.ts'
import { submit } from '../src/submission.ts'
import { agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const TASK = 'recovery-task'
const CALLER = { agentId: 'agent-7', sessionId: 'session-9', model: 'test/model' }
const PROGRAM = "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2]+'.runs','execution\\n'); process.stdout.write('35')"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const execution = fakeExecution(() => undefined)

async function working() {
  const root = await mkdtemp(join(tmpdir(), 'assembly-recovery-'))
  roots.push(root)
  const domainDir = join(root, 'domain')
  await cp(REAL, domainDir, { recursive: true })
  const domain = await loadDomain(domainDir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('lib-1', root, domain, medium as unknown as SessionPersistence)
  await bindCaller(apparatus, CALLER)
  const commands = apparatus.tasks.forAgent(CALLER.agentId)
  const template = domain.templates.get(domain.rootTemplate)!
  await commands.admit({ commandId: 'admit', taskId: TASK, contract: contractFor(domain, template, template.goal) })
  await commands.assign({ commandId: 'assign', taskId: TASK, agentId: CALLER.agentId })
  const run = await startAttempt(apparatus, CALLER, TASK, 'proposal')
  return { apparatus, medium, domain, template, root, taskId: TASK, runId: run.runId, workspace: workspaceOf(apparatus, TASK, run.runId) }
}
type Fixture = Awaited<ReturnType<typeof working>>

async function submitted(failureKind: string = TASK_KINDS.evidenceProduced): Promise<Fixture> {
  const fixture = await working()
  fixture.medium.failAppendOf(failureKind)
  expect(await asyncRefusalOf(() => submit(fixture.apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'submit'),
    { taskId: TASK, program: PROGRAM }, new AbortController().signal))).toMatchObject({ code: 'write-not-durable' })
  return fixture
}

async function reopen(fixture: Fixture, domain: Domain = fixture.domain): Promise<Apparatus> {
  await fixture.apparatus.store.close()
  return await openApparatus('lib-1', fixture.root, domain, fixture.medium as unknown as SessionPersistence)
}

const current = (apparatus: Apparatus, fixture: Fixture) => taskStateOf(apparatus, fixture.taskId).runs[fixture.runId]!

interface Manifest {
  task: string
  taskTemplate: { id: string; digest: string }
  inputSources: { name: string; digest: string; source: { kind: string; ref?: string; digest?: string; taskId?: string; runId?: string } }[]
}
function rewriteManifest(fixture: Fixture, change: (manifest: Manifest) => void): void {
  const run = current(fixture.apparatus, fixture)
  const fact = factsOf(fixture.medium).find(fact => fact.kind === 'revision/created' &&
    (fact.payload as { revisionId: string }).revisionId === run.revision.revisionId)!
  const manifest = structuredClone((fact.payload as { manifest: Manifest }).manifest)
  change(manifest)
  let previousDigest: string | null = null
  for (const [index, event] of fixture.medium.events.entries()) {
    if (event.type !== CONTROL_EVENT_TYPE) throw new Error('expected a control event')
    const data = event.data
    const { digest: _digest, ...body } = data.payload
    let payload = body.payload
    if (data.payload === fact) payload = { ...(payload as object), manifest }
    if (body.kind === TASK_KINDS.runStarted && body.subject === fixture.taskId)
      payload = { ...(payload as object), revision: { ...run.revision, digest: digestOf(manifest) } }
    const envelope = sealEnvelope({ ...body, payload, prevDigest: previousDigest })
    previousDigest = envelope.digest
    fixture.medium.events[index] = { ...event, data: { ...data, payload: envelope } }
  }
}

async function artifactWorking(): Promise<Fixture & { producerWorkspace: string }> {
  const fixture = await working()
  const commands = fixture.apparatus.tasks.forAgent(CALLER.agentId)
  const producer = fixture.domain.templates.get('extract-letters')!
  await commands.admit({ commandId: 'admit-producer', taskId: 'producer', contract: contractFor(fixture.domain, producer, producer.goal) })
  await commands.assign({ commandId: 'assign-producer', taskId: 'producer', agentId: CALLER.agentId })
  const run = await startAttempt(fixture.apparatus, CALLER, 'producer', 'producer-start')
  const program = "import { readFileSync } from 'node:fs'; process.stdout.write((readFileSync(process.argv[2],'utf8').match(/[A-Za-z]/g)||[]).join(''))"
  await submit(fixture.apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'producer-submit'),
    { taskId: 'producer', program }, new AbortController().signal)
  const template = fixture.domain.templates.get('count-letters')!
  await commands.admit({ commandId: 'admit-dependent', taskId: 'dependent', contract: contractFor(fixture.domain, template, template.goal, 'producer') })
  await commands.assign({ commandId: 'assign-dependent', taskId: 'dependent', agentId: CALLER.agentId })
  const dependent = await startAttempt(fixture.apparatus, CALLER, 'dependent', 'dependent-start')
  return { ...fixture, taskId: 'dependent', template, runId: dependent.runId, workspace: workspaceOf(fixture.apparatus, 'dependent', dependent.runId),
    producerWorkspace: workspaceOf(fixture.apparatus, 'producer', run.runId) }
}

describe('recovery of the committed Run stage', () => {
  it('retains the exact working Run and agent session without invoking a verifier', async () => {
    const fixture = await working()
    const before = factsOf(fixture.medium)
    const apparatus = await reopen(fixture, { ...fixture.domain, verifiers: fixture.domain.verifiers.map(verifier => ({ ...verifier,
      judge: async () => { throw new Error('a working Run must not invoke a verifier') },
    })) })
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ runId: fixture.runId, stage: 'working', status: 'running', bubble: { workspace: { ref: fixture.workspace } }, evidence: [] })
    expect(factsOf(fixture.medium)).toEqual(before)
    expect(apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, CALLER.agentId)).toMatchObject({ sessionId: CALLER.sessionId })
  })

  it.each(['template', 'input', 'missing-input', 'verifier'] as const)('fails a working Run whose frozen %s changed without restaging it', async changed => {
    const fixture = await working()
    const inputPath = join(fixture.workspace, fixture.template.input.name)
    const before = await readFile(inputPath)
    let domain = fixture.domain
    if (changed === 'template') {
      const path = join(domain.dir, 'task.json')
      const declared = JSON.parse(await readFile(path, 'utf8'))
      declared.templates[0].workspace.artifact = 'another-report.txt'
      await writeFile(path, JSON.stringify(declared))
      domain = await loadDomain(domain.dir, spawnProcess)
    } else if (changed === 'verifier') await writeFile(fixture.template.verifier.program, 'throw new Error("changed verifier")')
    else if (changed === 'missing-input') await rm(inputPath)
    else await writeFile(inputPath, 'changed frozen bytes')
    const apparatus = await reopen(fixture, domain)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-') })
    if (changed === 'missing-input') await expect(access(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(inputPath)).toEqual(changed === 'input' ? Buffer.from('changed frozen bytes') : before)
  })

  it.each(['task', 'template', 'input-source'] as const)('fails a working Run pinned to a revision for a different %s', async changed => {
    const fixture = await working()
    rewriteManifest(fixture, manifest => {
      if (changed === 'task') manifest.task = 'another-task'
      else if (changed === 'template') manifest.taskTemplate.id = 'extract-letters'
      else manifest.inputSources[0]!.source.ref = 'another-protected-source'
    })
    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-revision') })
  })

  it.each(['deleted', 'changed'] as const)('recovers a sealed dependent from its own frozen input after the producer artifact was %s', async changed => {
    const fixture = await artifactWorking()
    fixture.medium.failAppendOf(TASK_KINDS.evidenceProduced)
    await asyncRefusalOf(() => submit(fixture.apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'dependent-submit'),
      { taskId: fixture.taskId, program: PROGRAM }, new AbortController().signal))
    const frozen = await readFile(join(fixture.workspace, fixture.template.input.name))
    if (changed === 'deleted') await rm(fixture.producerWorkspace, { recursive: true })
    else await writeFile(join(fixture.producerWorkspace, 'letters.txt'), 'changed producer bytes')
    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', submission: { inputDigests: [{ name: fixture.template.input.name, digest: sha256(frozen) }] } })
    expect(await readFile(join(fixture.workspace, fixture.template.input.name))).toEqual(frozen)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it.each(['missing', 'working', 'failed'] as const)('fails an artifact input revision naming a %s producer Run even if the frozen digest matches', async status => {
    const fixture = await artifactWorking()
    let runId = 'another-producer-run'
    if (status !== 'missing') {
      const run = await startAttempt(fixture.apparatus, CALLER, 'producer', 'unverified-producer-start')
      runId = run.runId
      if (status === 'failed') {
        const verdict = await submit(fixture.apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'unverified-producer-submit'),
          { taskId: 'producer', program: "process.stdout.write('wrong extraction')" }, new AbortController().signal)
        expect(verdict.verdict).toBe('fail')
      }
    }
    rewriteManifest(fixture, manifest => { manifest.inputSources[0]!.source.runId = runId })
    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-revision') })
  })

  it('fails incomplete preparation when a started Run has no committed bubble', async () => {
    const fixture = await working()
    fixture.medium.events.pop()
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('incomplete-preparation') })
  })

  it('fails a reserved but unsealed submission and returns the same failure on redelivery', async () => {
    const fixture = await working()
    fixture.medium.failAppendOf(TASK_KINDS.runFailed)
    const exec = execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'interrupted-submit')
    const request = { taskId: TASK, program: PROGRAM }
    await asyncRefusalOf(() => submit(fixture.apparatus, { ...execution, drain: async () => { throw new Error('interrupted drain') } }, CALLER, exec, request, new AbortController().signal))
    const apparatus = await reopen(fixture)
    await repair(apparatus)
    const committed = fixture.medium.events.length

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', stage: 'submitting', failureReason: expect.stringContaining('interrupted-submission') })
    expect(await submit(apparatus, { ...execution, drain: async () => { throw new Error('redelivery must not execute') } }, CALLER, exec, request, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'fail', detail: expect.stringContaining('interrupted-submission') })
    expect(fixture.medium.events.length).toBe(committed)
    await expect(access(join(fixture.workspace, fixture.template.file))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('judges a sealed submission with its original Run, source and bytes without rerunning the program', async () => {
    const fixture = await submitted()
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', stage: 'submitted', submission: { source: { sessionId: CALLER.sessionId, eventCount: 0 } } })
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
    expect(projectReceipt(apparatus.registry, apparatus.store.load().entries(), TASK, fixture.runId)).toMatchObject({ source: { sessionId: CALLER.sessionId, eventCount: 0 } })
  })

  it('refuses a redelivered submission still in flight without repeating its program', async () => {
    const fixture = await submitted()
    expect(current(fixture.apparatus, fixture)).toMatchObject({ status: 'running', stage: 'submitted', evidence: [] })
    const before = factsOf(fixture.medium)

    expect(await asyncRefusalOf(() => submit(fixture.apparatus, execution, CALLER,
      execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'submit'), { taskId: TASK, program: PROGRAM }, new AbortController().signal)))
      .toMatchObject({ code: 'illegal-transition' })
    expect(factsOf(fixture.medium)).toEqual(before)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it('settles a sealed submission with a committed verdict without invoking its verifier again', async () => {
    const fixture = await submitted(TASK_KINDS.runVerified)
    const apparatus = await reopen(fixture, { ...fixture.domain, verifiers: fixture.domain.verifiers.map(verifier => ({ ...verifier,
      judge: async () => { throw new Error('a committed verdict must not be produced again') },
    })) })
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', evidence: [{ verdict: 'pass' }] })
    expect(factsOf(fixture.medium).filter(fact => fact.kind === TASK_KINDS.evidenceProduced)).toHaveLength(1)
  })

  it.each(['unchanged', 'verifier-changed', 'artifact-removed'] as const)('restores the original failed execution after its failure commit was lost (%s)', async deployment => {
    const fixture = await working()
    const exec = execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'failed-submit')
    const request = { taskId: TASK, program: PROGRAM + '; process.exit(3)' }
    fixture.medium.failAppendOf(TASK_KINDS.runFailed)
    expect(await asyncRefusalOf(() => submit(fixture.apparatus, execution, CALLER, exec, request, new AbortController().signal)))
      .toMatchObject({ code: 'write-not-durable' })
    const sealed = current(fixture.apparatus, fixture).submission!
    expect(current(fixture.apparatus, fixture)).toMatchObject({ status: 'running', stage: 'submitted', evidence: [] })
    expect(sealed.executionFailure).toContain('process-execution-failed')
    expect(await readFile(join(fixture.workspace, fixture.template.artifact), 'utf8')).toBe('35')
    if (deployment === 'verifier-changed')
      await writeFile(fixture.template.verifier.program, 'throw new Error("this verifier must not run")')
    if (deployment === 'artifact-removed') await rm(join(fixture.workspace, fixture.template.artifact))

    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: sealed.executionFailure, evidence: [] })
    expect(projectReceipt(apparatus.registry, apparatus.store.load().entries(), TASK, fixture.runId))
      .toMatchObject({ status: 'failed', submission: sealed, source: sealed.source })
    const committed = fixture.medium.events.length
    expect(await submit(apparatus, execution, CALLER, exec, request, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'fail', phase: 'failed', detail: sealed.executionFailure })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it.each(['program', 'artifact', 'input', 'missing-artifact'] as const)('fails when the sealed %s bytes cannot be recovered', async changed => {
    const fixture = await submitted()
    const path = join(fixture.workspace, changed === 'program' ? fixture.template.file : changed === 'input' ? fixture.template.input.name : fixture.template.artifact)
    if (changed === 'missing-artifact') await rm(path)
    else await writeFile(path, 'different bytes')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-submission'), evidence: [] })
  })

  it.each(['renamed', 'replaced'] as const)('settles a run frozen against an input this deployment no longer declares, and still opens (%s)', async changed => {
    const fixture = await submitted()
    const frozenInput = fixture.domain.inputs[0]!
    const inputName = fixture.template.input.name
    const staged = await readFile(join(fixture.workspace, inputName))
    if (changed === 'renamed') {
      const declarationPath = join(fixture.domain.dir, 'task.json')
      const declaration = JSON.parse(await readFile(declarationPath, 'utf8'))
      declaration.templates[0]!.input.name = 'in/renamed-source.txt'
      await writeFile(declarationPath, JSON.stringify(declaration))
    } else {
      await writeFile(join(fixture.domain.dir, frozenInput.sourcePath), 'A'.repeat(35))
    }
    const domain = await loadDomain(fixture.domain.dir, spawnProcess)
    const apparatus = await reopen(fixture, domain)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining(changed === 'renamed' ? 'unrecoverable-template' : 'the deployment no longer declares the frozen input ' + inputName), evidence: [] })
    expect(await readFile(join(fixture.workspace, inputName))).toEqual(staged)
    expect(factsOf(fixture.medium).some(fact => fact.kind === TASK_KINDS.evidenceProduced)).toBe(false)
  })

  it('returns the recovered failure on redelivery even when pass evidence was already committed', async () => {
    const fixture = await submitted(TASK_KINDS.runVerified)
    await writeFile(join(fixture.workspace, fixture.template.artifact), '0')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-submission'), evidence: [{ verdict: 'pass' }] })
    const failureReason = current(apparatus, fixture).failureReason
    const committed = fixture.medium.events.length
    expect(await submit(apparatus, { ...execution, drain: async () => { throw new Error('redelivery must not execute') } }, CALLER,
      execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'submit'), { taskId: TASK, program: PROGRAM }, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'fail', phase: 'failed', detail: failureReason })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it('fails when a reloaded verifier changes the admitted template identity', async () => {
    const fixture = await submitted()
    const verifier = fixture.template.verifier.program
    await writeFile(verifier, (await readFile(verifier, 'utf8')) + '\n// different implementation\n')
    const domain = await loadDomain(fixture.domain.dir, spawnProcess)
    const apparatus = await reopen(fixture, domain)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-template'), evidence: [] })
  })

  it('propagates verifier runtime failure while retaining the submitted attempt', async () => {
    const fixture = await submitted()
    const failure = new Error('verifier process unavailable')
    const apparatus = await reopen(fixture, { ...fixture.domain, verifiers: fixture.domain.verifiers.map(verifier => ({ ...verifier, judge: async () => { throw failure } })) })
    await expect(repair(apparatus)).rejects.toThrow('verifier process unavailable')

    expect(current(apparatus, fixture)).toMatchObject({ status: 'running', stage: 'submitted', evidence: [] })
    expect(factsOf(fixture.medium).some(fact => fact.kind === TASK_KINDS.runFailed)).toBe(false)
  })

  it.each([TASK_KINDS.evidenceProduced, TASK_KINDS.runVerified])('propagates recovery persistence failure at %s', async kind => {
    const fixture = await submitted()
    const apparatus = await reopen(fixture)
    fixture.medium.failAppendOf(kind)
    expect(await asyncRefusalOf(() => repair(apparatus))).toMatchObject({ code: 'write-not-durable' })

    expect(current(apparatus, fixture)).toMatchObject({ status: 'running', stage: 'submitted' })
    expect(factsOf(fixture.medium).some(fact => fact.kind === TASK_KINDS.runFailed)).toBe(false)
  })

  it('leaves a terminal Run and its receipt unchanged after its workspace is deleted', async () => {
    const fixture = await submitted()
    const repaired = await reopen(fixture)
    await repair(repaired)
    const before = factsOf(fixture.medium)
    const receipt = projectReceipt(repaired.registry, repaired.store.load().entries(), TASK, fixture.runId)
    await rm(fixture.workspace, { recursive: true })
    await repaired.store.close()
    const apparatus = await openApparatus('lib-1', fixture.root, fixture.domain, fixture.medium as unknown as SessionPersistence)
    await repair(apparatus)

    expect(factsOf(fixture.medium)).toEqual(before)
    expect(projectReceipt(apparatus.registry, apparatus.store.load().entries(), TASK, fixture.runId)).toEqual(receipt)
  })

  it('retains the committed result and workspace through driver close and reopen', async () => {
    const fixture = await working()
    await fixture.apparatus.store.close()
    const options = { controlId: 'lib-1', workspaceRoot: fixture.root, domain: fixture.domain,
      persistence: fixture.medium as unknown as SessionPersistence, seams: {}, execution: fakeExecution }
    const agent = agentFor(CALLER.agentId, CALLER.sessionId)
    const driver = await openDriver(options)
    await driver.forCall(execFor(agent, 'driver-submit')).submit({ taskId: TASK, program: PROGRAM })
    const status = await driver.forCall(execFor(agent, 'status')).status({ taskId: TASK })
    const committed = fixture.medium.events.length
    await driver.close()
    const reopened = await openDriver(options)
    try {
      expect(status.phase).toBe('verified')
      expect(await reopened.forCall(execFor(agent, 'status')).status({ taskId: TASK })).toEqual(status)
      expect(fixture.medium.events.length).toBe(committed)
      await expect(access(join(fixture.workspace, fixture.template.artifact))).resolves.toBeUndefined()
    } finally {
      await reopened.close()
    }
  })
})
