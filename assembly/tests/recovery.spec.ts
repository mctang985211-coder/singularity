import { access, chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { acceptanceSubject, IMPROVEMENT_TEMPLATE, REVIEW_TEMPLATE, SUBJECT_INPUT } from '../src/review.ts'
import { loadMethod, methodEnvironment, seedMethod } from '../src/method.ts'
import { assertImprovementOwner } from '../src/improvement.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { attachmentsAt, agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const TASK = 'recovery-task'
const CALLER = { agentId: 'agent-7', sessionId: 'session-9', model: { provider: 'test', model: 'model' } }
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
  const apparatus = await openApparatus('lib-1', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root))
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
  return await openApparatus('lib-1', fixture.root, domain, fixture.medium as unknown as SessionPersistence, attachmentsAt(fixture.root))
}

const current = (apparatus: Apparatus, fixture: Fixture) => taskStateOf(apparatus, fixture.taskId).runs[fixture.runId]!

it('restores working Runs without activating an unrelated rejected asset proposal', async () => {
  const fixture = await working()
  await fixture.apparatus.environments.createRevision({ commandId: 'rejected-proposal', environmentId: methodEnvironment(fixture.apparatus),
    revisionId: 'rejected', manifest: { rootTemplate: 'absent', templates: [], skills: [], tools: [] } })
  const apparatus = await reopen(fixture)
  await repair(apparatus)
  expect(current(apparatus, fixture).status).toBe('running')
  await apparatus.store.close()
})

it('restores the activated failed Task owner so its existing retry tool can reopen the same contract', async () => {
  const fixture = await working()
  await fixture.apparatus.tasks.forAgent(CALLER.agentId).failRun({ commandId: 'failed-turn', taskId: TASK,
    runId: fixture.runId, reason: 'interrupted native turn' })
  const contract = taskStateOf(fixture.apparatus, TASK).contract
  await fixture.apparatus.store.close()
  const agent = agentFor(CALLER.agentId, CALLER.sessionId)
  const driver = await openDriver({ controlId: 'lib-1', workspaceRoot: fixture.root, domain: fixture.domain,
    persistence: fixture.medium as never, attachments: attachmentsAt(fixture.root),
    seams: { agents: { get: () => agent } as never }, execution: fakeExecution })
  try {
    await driver.activate(CALLER.sessionId)
    const reopened = await driver.forCall(execFor(agent, 'retry-after-reload')).retry({ taskId: TASK })
    expect(reopened).toMatchObject({ taskId: TASK, phase: 'running' })
    const task = (await driver.forCall(execFor(agent, 'status')).status({ taskId: TASK })).task
    expect(task.contract).toEqual(contract)
    expect(task.runs.map(run => run.status)).toEqual(['failed', 'running'])
  } finally { await driver.close() }
})

it('restores prompt responsibilities from the exact frozen Run rather than inherited agent instructions', async () => {
  const fixture = await working()
  const method = await seedMethod(fixture.apparatus)
  const domain = (await loadMethod(fixture.apparatus, method)).domain
  for (const purpose of ['review', 'improve', 'evaluation']) {
    const caller = { ...CALLER, agentId: purpose, sessionId: purpose }
    await bindCaller(fixture.apparatus, caller)
    const template = domain.templates.get(purpose === 'review' ? REVIEW_TEMPLATE
      : purpose === 'improve' ? IMPROVEMENT_TEMPLATE : domain.rootTemplate)!
    const commands = fixture.apparatus.tasks.forAgent(caller.agentId)
    await commands.admit({ commandId: `admit:${purpose}`, taskId: purpose,
      contract: { ...contractFor(domain, template, 'The parent uses a coding preset.'), assets: method } })
    await commands.assign({ commandId: `assign:${purpose}`, taskId: purpose, agentId: caller.agentId })
    await startAttempt(fixture.apparatus, caller, purpose, `run:${purpose}`, method, { domain, purpose })
  }
  await fixture.apparatus.store.close()
  const driver = await openDriver({ controlId: 'lib-1', workspaceRoot: fixture.root, domain: fixture.domain,
    persistence: fixture.medium as never, attachments: attachmentsAt(fixture.root), seams: {}, execution: fakeExecution })
  try {
    expect(driver.purpose(CALLER.agentId)).toBe('solve')
    expect(['review', 'improve', 'evaluation'].map(id => driver.purpose(id))).toEqual(['review', 'improve', 'evaluation'])
    expect(driver.purpose('new-human-session')).toBe('solve')
  } finally { await driver.close() }
})

it('allows evaluation only inside the accepted root improvement tree, including ordinary delegated nodes', async () => {
  const fixture = await working()
  const { apparatus, taskId } = fixture
  expect(() => assertImprovementOwner(apparatus, CALLER.agentId)).toThrow('only the accepted root')
  const method = await seedMethod(apparatus)
  const domain = (await loadMethod(apparatus, method)).domain
  const template = domain.templates.get(IMPROVEMENT_TEMPLATE)!
  for (const id of ['improvement', 'delegated-programming']) {
    const caller = { ...CALLER, agentId: id, sessionId: id }
    await bindCaller(apparatus, caller)
    const commands = apparatus.tasks.forAgent(id)
    await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: { ...contractFor(domain, template, template.goal), assets: method } })
    await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId: id })
    await startAttempt(apparatus, caller, id, `run:${id}`, method,
      { domain, purpose: id === 'improvement' ? 'improve' : 'solve', relatedTo: { taskId, runId: fixture.runId } })
  }
  await apparatus.tasks.forAgent('improvement').decompose({ commandId: 'delegate', parentTaskId: 'improvement',
    children: [{ taskId: 'delegated-programming', dependsOn: [], supports: [template.criterion.criterionId], maxRuns: 1 }] })
  expect(() => assertImprovementOwner(apparatus, 'improvement')).toThrow('has not passed independent acceptance')
  expect(() => assertImprovementOwner(apparatus, 'delegated-programming')).toThrow('has not passed independent acceptance')
  await submit(apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'complete-root'),
    { taskId, program: PROGRAM }, new AbortController().signal)
  expect(() => assertImprovementOwner(apparatus, 'improvement')).not.toThrow()
  expect(() => assertImprovementOwner(apparatus, 'delegated-programming')).not.toThrow()
  expect(() => assertImprovementOwner(apparatus, CALLER.agentId)).toThrow('requires a working improvement')
  await apparatus.store.close()
})

it('resumes the first frozen acceptance subject across verifier temporary directories and rejects changed evidence', async () => {
  const fixture = await submitted()
  const { taskId } = fixture
  const apparatus = await reopen(fixture)
  fixture.apparatus = apparatus
  const run = current(apparatus, fixture)
  const criterion = fixture.template.criterion
  const judgement = { ...criterion, runId: run.runId, verdict: 'pass' as const,
    artifactDigest: run.submission!.artifactDigest, inputDigests: run.submission!.inputDigests,
    detail: 'verifier exited 0 in judged-first' }
  const subject = await acceptanceSubject(apparatus, taskId, run, judgement)
  const bytes = Buffer.from(JSON.stringify(subject))
  const operationId = `accept:${taskId}/${run.runId}`
  const reviewId = `review-${sha256(`${apparatus.controlId}/${operationId}/${sha256(bytes)}`).slice(0, 24)}`
  const agentId = String(agentSessionIdOf(reviewId))
  await bindCaller(apparatus, { ...CALLER, agentId, sessionId: agentId })
  const method = await seedMethod(apparatus)
  const domain = { ...apparatus.domain, inputs: [...apparatus.domain.inputs.filter(input => input.ref !== SUBJECT_INPUT),
    { ref: SUBJECT_INPUT, digest: sha256(bytes), bytes, sourcePath: '' }] }
  const template = domain.templates.get(REVIEW_TEMPLATE)!
  const commands = apparatus.tasks.forAgent(agentId)
  await commands.admit({ commandId: 'review-admit', taskId: reviewId, contract: { ...contractFor(domain, template, template.goal), assets: method } })
  await commands.assign({ commandId: 'review-assign', taskId: reviewId, agentId })
  await startAttempt(apparatus, { ...CALLER, agentId, sessionId: agentId }, reviewId, operationId, method,
    { domain, purpose: 'review', relatedTo: { taskId, runId: run.runId } })
  const reopened = await reopen(fixture)
  await expect(acceptanceSubject(reopened, taskId, current(reopened, fixture), { ...judgement, detail: 'verifier exited 0 in judged-second' }))
    .resolves.toEqual(subject)
  await expect(acceptanceSubject(reopened, taskId, current(reopened, fixture), { ...judgement, implementationDigest: 'f'.repeat(64) }))
    .rejects.toThrow('changed its frozen subject')
  await reopened.store.close()
})

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
      .toMatchObject({ runId: fixture.runId, verdict: 'unknown', detail: expect.stringContaining('interrupted-submission') })
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
      .toMatchObject({ runId: fixture.runId, verdict: 'unknown', phase: 'failed', detail: sealed.executionFailure })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it.each(['program', 'artifact', 'input', 'missing-artifact'] as const)('recovers sealed bytes after the editable %s file changes', async changed => {
    const fixture = await submitted()
    const path = join(fixture.workspace, changed === 'program' ? fixture.template.file : changed === 'input' ? fixture.template.input.name : fixture.template.artifact)
    if (changed === 'missing-artifact') await rm(path)
    else await writeFile(path, 'different bytes')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', evidence: [{ verdict: 'pass' }] })
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

  it('returns the recovered sealed success after editable bytes change and pass evidence was committed', async () => {
    const fixture = await submitted(TASK_KINDS.runVerified)
    await writeFile(join(fixture.workspace, fixture.template.artifact), '0')
    const apparatus = await reopen(fixture)
    await repair(apparatus)

    expect(current(apparatus, fixture)).toMatchObject({ status: 'verified', evidence: [{ verdict: 'pass' }] })
    const committed = fixture.medium.events.length
    expect(await submit(apparatus, { ...execution, drain: async () => { throw new Error('redelivery must not execute') } }, CALLER,
      execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'submit'), { taskId: TASK, program: PROGRAM }, new AbortController().signal))
      .toMatchObject({ runId: fixture.runId, verdict: 'pass', phase: 'verified' })
    expect(fixture.medium.events.length).toBe(committed)
    expect(await readFile(join(fixture.workspace, fixture.template.input.name) + '.runs', 'utf8')).toBe('execution\n')
  })

  it.each(['missing', 'corrupt'] as const)('fails explicitly when the authoritative sealed object is %s', async damage => {
    const fixture = await submitted()
    const ref = current(fixture.apparatus, fixture).submission!.files.artifact
    const path = attachmentsAt(fixture.root).fileHostPath(ref)
    if (damage === 'missing') await rm(path)
    else { await chmod(path, 0o600); await writeFile(path, 'corrupt sealed storage') }
    const apparatus = await reopen(fixture)
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureCause: 'runtime',
      failureReason: expect.stringContaining('unrecoverable-submission'), evidence: [] })
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

  it('stops a submitted attempt when recovery verification cannot execute', async () => {
    const fixture = await submitted()
    const failure = new Error('verifier process unavailable')
    const apparatus = await reopen(fixture, { ...fixture.domain, verifiers: fixture.domain.verifiers.map(verifier => ({ ...verifier, judge: async () => { throw failure } })) })
    await repair(apparatus)
    expect(current(apparatus, fixture)).toMatchObject({ status: 'failed', failureCause: 'runtime', failureReason: expect.stringContaining('verifier process unavailable'), evidence: [] })
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
    const apparatus = await openApparatus('lib-1', fixture.root, fixture.domain, fixture.medium as unknown as SessionPersistence, attachmentsAt(fixture.root))
    await repair(apparatus)

    expect(factsOf(fixture.medium)).toEqual(before)
    expect(projectReceipt(apparatus.registry, apparatus.store.load().entries(), TASK, fixture.runId)).toEqual(receipt)
  })

  it('retains the committed result and workspace through driver close and reopen', async () => {
    const fixture = await working()
    await submit(fixture.apparatus, execution, CALLER, execFor(agentFor(CALLER.agentId, CALLER.sessionId), 'driver-submit'), { taskId: TASK, program: PROGRAM }, new AbortController().signal)
    await fixture.apparatus.store.close()
    const options = { controlId: 'lib-1', workspaceRoot: fixture.root, domain: fixture.domain,
      persistence: fixture.medium as unknown as SessionPersistence, seams: {}, execution: fakeExecution, attachments: attachmentsAt(fixture.root) }
    const agent = agentFor(CALLER.agentId, CALLER.sessionId)
    const driver = await openDriver(options)
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
