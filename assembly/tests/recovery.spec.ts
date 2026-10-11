import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { TASK_KINDS } from '../../src/task/protocol.ts'
import { projectReceipt } from '../../src/task/view.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { bindCaller, openApparatus, taskStateOf, type Apparatus } from '../src/apparatus.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { loadDomain, type Domain } from '../src/domain.ts'
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
  await commands.admit({ commandId: 'admit', taskId: TASK, contract: { goal: 'count letters', inputs: domain.inputs.map(input => input.path), criteria: [domain.criterion] } })
  await commands.assign({ commandId: 'assign', taskId: TASK, agentId: CALLER.agentId })
  const run = await startAttempt(apparatus, CALLER, TASK, 'proposal')
  return { apparatus, medium, domain, root, runId: run.runId, workspace: workspaceOf(apparatus, TASK, run.runId) }
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

const current = (apparatus: Apparatus, fixture: Fixture) => taskStateOf(apparatus, TASK).runs[fixture.runId]!

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
    await expect(access(join(fixture.workspace, fixture.domain.file))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('judges a sealed submission with its original Run, source and bytes without rerunning the program', async () => {
    const fixture = await submitted()
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', stage: 'submitted', submission: { source: { sessionId: CALLER.sessionId, eventCount: 0 } } })
    expect(await readFile(join(fixture.workspace, fixture.domain.inputs[0]!.path) + '.runs', 'utf8')).toBe('execution\n')
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
    expect(await readFile(join(fixture.workspace, fixture.domain.inputs[0]!.path) + '.runs', 'utf8')).toBe('execution\n')
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
    expect(await readFile(join(fixture.workspace, fixture.domain.artifact), 'utf8')).toBe('35')
    if (deployment === 'verifier-changed')
      await writeFile(fixture.domain.verifier.program, 'throw new Error("this verifier must not run")')
    if (deployment === 'artifact-removed') await rm(join(fixture.workspace, fixture.domain.artifact))

    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: sealed.executionFailure, evidence: [] })
    expect(projectReceipt(apparatus.registry, apparatus.store.load().entries(), TASK, fixture.runId))
      .toMatchObject({ status: 'failed', submission: sealed, source: sealed.source })
    const committed = fixture.medium.events.length
    expect(await submit(apparatus, execution, CALLER, exec, request, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'fail', phase: 'failed', detail: sealed.executionFailure })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.domain.inputs[0]!.path) + '.runs', 'utf8')).toBe('execution\n')
  })

  it.each(['program', 'artifact', 'input', 'missing-artifact'] as const)('fails when the sealed %s bytes cannot be recovered', async changed => {
    const fixture = await submitted()
    const path = join(fixture.workspace, changed === 'program' ? fixture.domain.file : changed === 'input' ? fixture.domain.inputs[0]!.path : fixture.domain.artifact)
    if (changed === 'missing-artifact') await rm(path)
    else await writeFile(path, 'different bytes')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-submission'), evidence: [] })
  })

  it.each(['renamed', 'replaced'] as const)('settles a run frozen against an input this deployment no longer declares, and still opens (%s)', async changed => {
    const fixture = await submitted()
    const frozenInput = fixture.domain.inputs[0]!
    const staged = await readFile(join(fixture.workspace, frozenInput.path))
    if (changed === 'renamed') {
      const declarationPath = join(fixture.domain.dir, 'task.json')
      const declaration = JSON.parse(await readFile(declarationPath, 'utf8')) as { inputs: { path: string; from: string }[] }
      declaration.inputs[0]!.path = 'in/renamed-source.txt'
      await writeFile(declarationPath, JSON.stringify(declaration))
    } else {
      await writeFile(join(fixture.domain.dir, frozenInput.sourcePath), 'another declared dataset')
    }
    const domain = await loadDomain(fixture.domain.dir, spawnProcess)
    const apparatus = await reopen(fixture, domain)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('the deployment no longer declares the frozen input ' + frozenInput.path), evidence: [] })
    expect(await readFile(join(fixture.workspace, frozenInput.path))).toEqual(staged)
    expect(factsOf(fixture.medium).some(fact => fact.kind === TASK_KINDS.evidenceProduced)).toBe(false)
  })

  it('returns the recovered failure on redelivery even when pass evidence was already committed', async () => {
    const fixture = await submitted(TASK_KINDS.runVerified)
    await writeFile(join(fixture.workspace, fixture.domain.artifact), '0')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-submission'), evidence: [{ verdict: 'pass' }] })
    const failureReason = current(apparatus, fixture).failureReason
    const committed = fixture.medium.events.length
    expect(await submit(apparatus, { ...execution, drain: async () => { throw new Error('redelivery must not execute') } }, CALLER,
      execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'submit'), { taskId: TASK, program: PROGRAM }, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'fail', phase: 'failed', detail: failureReason })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.domain.inputs[0]!.path) + '.runs', 'utf8')).toBe('execution\n')
  })

  it('fails when the deployment changed the implementation pinned by the original contract', async () => {
    const fixture = await submitted()
    const verifier = fixture.domain.verifier.program
    await writeFile(verifier, (await readFile(verifier, 'utf8')) + '\n// different implementation\n')
    const domain = await loadDomain(fixture.domain.dir, spawnProcess)
    const apparatus = await reopen(fixture, domain)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('unrecoverable-verifier'), evidence: [] })
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
      await expect(access(join(fixture.workspace, fixture.domain.artifact))).resolves.toBeUndefined()
    } finally {
      await reopened.close()
    }
  })
})
