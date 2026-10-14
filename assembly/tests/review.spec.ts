import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createReviewCommands } from '../../src/review/commands.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { openApparatus, callerOf, declareCaller, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { propose, decompose } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { submit } from '../src/submission.ts'
import { acceptanceSubject, submitReview, reviewSubject } from '../src/review.ts'
import type { ChildSessionRequest } from '../../src/runtime/child-session.ts'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { schedulerMessage } from '../src/scheduler-message.ts'
import { reviewInputsOf } from '../src/inputs.ts'
import { fixtureReview } from './review-fixture.ts'
import { sha256 } from '../src/ids.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { readTrajectory } from '../src/read.ts'
import { createScheduler } from '../src/scheduler.ts'
import { attachmentsAt, FakePersistence, agentFor, execFor, fakeExecution } from './seam.ts'
const roots: string[] = []
const child = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async (original) => ({
  ...(await original<object>()), openChildSession: child.open,
}))
afterEach(async () => {
  child.open.mockReset()
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-run-'))
  roots.push(root)
  const apparatus = await openApparatus(
      'review',
      root,
      await loadDomain('/home/ROXY/code/singularity-core/deployment/domain/letters', spawnProcess),
      new FakePersistence() as never,
      attachmentsAt(root),
    ),
    caller = callerOf(agentFor('worker', 'worker')),
    proposal = await propose(apparatus, caller, 'root', { goal: 'count' }),
    commands = apparatus.tasks.forAgent(caller.agentId),
    run = taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!
  const bytes = Buffer.from('0'),
    artifact = await apparatus.attachments.saveFile({ name: proposal.artifact, data: bytes })
  await commands.submitRun({
    commandId: 'seal',
    taskId: proposal.taskId,
    runId: run.runId,
    submission: {
      requestId: 'submit',
      requestDigest: sha256('submit'),
      artifactDigest: sha256(bytes),
      inputDigests: run.bubble!.inputs,
      files: { artifact, inputs: run.bubble!.inputs.map((i) => ({ name: i.name, attachment: i.attachment! })) },
      source: { sessionId: 'worker', eventCount: 0, digest: digestOf({ sessionId: 'worker', eventCount: 0, events: [] }) },
    },
  })
  const subject = Buffer.from(
      JSON.stringify(
        await acceptanceSubject(
          apparatus,
          proposal.taskId,
          taskStateOf(apparatus, proposal.taskId).runs[run.runId]!,
          [],
        ),
      ),
    ),
    subjectDigest = sha256(subject)
  return {
    root,
    apparatus,
    proposal,
    caller,
    run,
    subject,
    subjectDigest,
    commands: createReviewCommands(apparatus.store),
  }
}
async function start(h: Awaited<ReturnType<typeof setup>>, agentId = 'reviewer') {
  const reviewId = `review-${sha256('review/outer').slice(0, 24)}`
  const key = declareCaller(h.apparatus, agentId)
  if (agentId !== 'worker')
    await h.apparatus.agents.open({ commandId: 'agent:' + agentId, agentId, sessionId: agentId, role: 'review' })
  await h.commands.start('review-start', reviewId, {
    target: {
      kind: 'acceptance',
      taskId: h.proposal.taskId,
      runId: h.run.runId,
      contractDigest: taskStateOf(h.apparatus, h.proposal.taskId).contractDigest!,
      artifactDigest: sha256('0'),
    },
    subject: await h.apparatus.attachments.saveFile({ name: 'subject.json', data: h.subject }),
    subjectDigest: h.subjectDigest,
    criteria: h.proposal.contract.criteria,
    agentId,
    sessionId: agentId,
    identity: h.apparatus.store.identityOf(key)!,
    workspace: join(h.root, 'review'),
    model: h.run.bubble!.model,
    method: h.run.revision,
  })
  return h.apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
}
it('refuses a reviewer with the executor identity', async () => {
  const h = await setup()
  await expect(start(h, 'worker')).rejects.toThrow('executor cannot review')
  await h.apparatus.store.close()
})
it('activates a review with no delegated evidence without fabricating a completed plan', async () => {
  const h = await setup(), review = await start(h)
  const scheduler = createScheduler(h.apparatus, { agents: { get: () => agentFor('reviewer', 'reviewer') } as never })
  expect(await scheduler.advance(review.reviewId)).toEqual([])
  expect(h.apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, review.reviewId)!.status).toBe('running')
  await scheduler.close(); await h.apparatus.store.close()
})
it.each(['subject.json', 'submitted-artifact'])('isolates frozen input %s from reviewer host files', async (name) => {
  const h = await setup(), taskId = 'one-off', commands = h.apparatus.tasks.forAgent(h.caller.agentId)
  const input = h.proposal.contract.inputs[0]!
  await commands.admit({ commandId: 'admit:one-off', taskId, contract: {
    goal: 'inspect frozen input', artifact: 'finding.txt', inputs: [{ ...input, name }],
    criteria: [{ criterionId: 'finding', statement: 'the finding accurately describes its frozen input' }],
  } })
  await commands.assign({ commandId: 'assign:one-off', taskId, agentId: h.caller.agentId })
  const run = await startAttempt(h.apparatus, h.caller, taskId, 'one-off', h.run.revision)
  const artifact = await h.apparatus.attachments.saveFile({ name: 'finding.txt', data: Buffer.from('finding') })
  await commands.submitRun({ commandId: 'seal:one-off', taskId, runId: run.runId, submission: {
    requestId: 'one-off', requestDigest: sha256('one-off'), artifactDigest: sha256('finding'),
    inputDigests: run.bubble!.inputs,
    files: { artifact, inputs: run.bubble!.inputs.map((i) => ({ name: i.name, attachment: i.attachment! })) },
    source: { sessionId: h.caller.sessionId, eventCount: 0, digest: sha256('one-off-source') },
  } })
  const subject = await acceptanceSubject(h.apparatus, taskId, taskStateOf(h.apparatus, taskId).runs[run.runId]!, [])
  child.open.mockImplementation(async (_seams: unknown, request: ChildSessionRequest) => {
    const dispatch = JSON.parse((request.message!.content[0] as { text: string }).text)
    expect(dispatch.inputs).toEqual([{ name, path: join('inputs', name) }])
    expect(JSON.parse(await readFile(join(request.cwd, 'subject.json'), 'utf8'))).toEqual(subject)
    expect(await readFile(join(request.cwd, 'submitted-artifact'), 'utf8')).toBe('finding')
    expect(await readFile(join(request.cwd, 'inputs', name), 'utf8')).toBe('The quick brown fox jumps over the lazy dog.\n')
    await writeFile(join(request.cwd, 'review.json'), JSON.stringify({ subjectDigest: dispatch.subjectDigest,
      findings: [{ criterionId: 'finding', verdict: 'pass', detail: 'independent finding', evidence: [join('inputs', name)] }],
    }))
    const review = h.apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, dispatch.reviewId)!
    await submitReview(h.apparatus, review, 'review.json')
    return { wait: async () => undefined, stop: () => undefined, close: async () => undefined }
  })
  const witness = await reviewSubject(h.apparatus, {}, agentFor('worker', 'worker'), 'one-off', subject,
    new AbortController().signal, h.run.revision)
  expect(witness.verdict).toBe('pass')
  expect(child.open).toHaveBeenCalledTimes(1)
  await h.apparatus.store.close()
})
it('records a reviewer setup failure without leaving its Run active', async () => {
  const h = await setup()
  child.open.mockRejectedValue(Error('session opening failed'))
  await expect(reviewSubject(h.apparatus, {}, agentFor('worker', 'worker'), 'setup-failure',
    JSON.parse(h.subject.toString('utf8')), new AbortController().signal, h.run.revision))
    .rejects.toThrow('session opening failed')
  expect([...h.apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()])
    .toMatchObject([{ status: 'failed', failure: 'Error: session opening failed' }])
  await h.apparatus.store.close()
})
it('allows evidence Tasks with their own review and completes a negative outer judgment once', async () => {
  const h = await setup(),
    review = await start(h),
    evidenceInputs = reviewInputsOf(review, JSON.parse(h.subject.toString('utf8'))),
    caller = { ...h.caller, agentId: 'reviewer', sessionId: 'reviewer' },
    scheduler = { advance: async () => [], close: async () => undefined }
  await decompose(h.apparatus, scheduler, caller, {
    taskId: review.reviewId,
    children: [
      {
        key: 'evidence',
        contract: {
          goal: 'check the arithmetic claim',
          artifact: 'proof.txt',
          inputs: evidenceInputs.filter((i) => i.name !== 'subject.json').map(({ name, source }) => ({ name, source })),
          criteria: [{ criterionId: 'proof', statement: 'a reproducible count or counterexample' }],
        },
        dependsOn: [],
        supports: ['letters'],
        maxRuns: 1,
      },
    ],
  })
  await expect(
    h.commands.complete(
      'early',
      review.reviewId,
      [],
      await h.apparatus.attachments.saveFile({ name: 'review.json', data: Buffer.from('{}') }),
      'agent:reviewer',
    ),
  ).rejects.toThrow('have not settled')
  const held = h.apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, review.reviewId)!,
    childId = held.children[0]!.taskId,
    id = taskStateOf(h.apparatus, childId).responsibility!.agentId,
    childCaller = { ...caller, agentId: id, sessionId: id },
    run = await startAttempt(h.apparatus, childCaller, childId, 'proof', h.run.revision)
  const event = { seq: SessionSeq(0), time: 0, type: 'turn/end', data: {} } as SessionEvent
  const reading = { ...h.apparatus, persistence: { open: async () => ({
    read: async (_from?: number, count?: number) => ({ events: [event].slice(0, count) }),
    close: async () => undefined,
  }) } as never }
  expect(await readTrajectory(reading, caller.agentId, childCaller.sessionId, 0, 1)).toEqual([event])
  expect(await readTrajectory(reading, caller.agentId, h.caller.sessionId, 0, 1)).toEqual([])
  await expect(readTrajectory(reading, caller.agentId, 'foreign')).rejects.toThrow('outside the frozen evidence scope')
  expect(await readFile(join(run.bubble!.workspace.ref, 'submitted-artifact'), 'utf8')).toBe('0')
  expect(await readFile(join(run.bubble!.workspace.ref, 'inputs/in/source.txt'), 'utf8'))
    .toBe('The quick brown fox jumps over the lazy dog.\n')
  await h.apparatus.tasks.forAgent(h.caller.agentId).admit({ commandId: 'admit:outsider', taskId: 'outsider', contract: {
    goal: 'read someone else’s review', artifact: 'answer.txt',
    inputs: [{ name: 'subject.json', source: evidenceInputs[0]!.source }],
    criteria: [{ criterionId: 'read', statement: 'read the evidence' }],
  } })
  await h.apparatus.tasks.forAgent(h.caller.agentId).assign({ commandId: 'assign:outsider', taskId: 'outsider', agentId: h.caller.agentId })
  await expect(startAttempt(h.apparatus, h.caller, 'outsider', 'outsider', h.run.revision))
    .rejects.toThrow('frozen input')
  await writeFile(join(run.bubble!.workspace.ref, 'proof.txt'), 'The source has 35 ASCII letters; zero is false.')
  await submit(
    h.apparatus,
    fakeExecution(() => undefined),
    childCaller,
    execFor(agentFor(id, id), 'proof'),
    { taskId: childId, path: 'proof.txt' },
    new AbortController().signal,
    fixtureReview(h.apparatus),
  )
  await mkdir(review.workspace, { recursive: true })
  await writeFile(
    join(review.workspace, 'review.json'),
    JSON.stringify({
      subjectDigest: review.subjectDigest,
      findings: [
        {
          criterionId: 'letters',
          verdict: 'fail',
          detail: 'The submitted count is zero, but independent evidence finds 35.',
          evidence: [childId],
        },
      ],
    }),
  )
  const events: SessionEvent[] = []
  const terminal = h.apparatus.store.load().entries().findLast((f) => f.subject === childId && f.kind === 'run/verified')!
  const message = schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome', controlId: h.apparatus.controlId,
    parentTaskId: review.reviewId, taskId: childId, runId: run.runId, factSeq: terminal.seq }, 'evidence settled')
  let waits = 0
  child.open.mockResolvedValue({ sessionId: review.sessionId, wait: async () => {
    waits++
    if (waits === 2) events.push({ seq: SessionSeq(events.length), time: 0, type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [message] } } as SessionEvent)
    if (waits === 3) events.push({ seq: SessionSeq(events.length), time: 0, type: 'user/message', data: message } as SessionEvent)
    if (waits === 4) await submitReview(h.apparatus, held, 'review.json')
  }, stop: () => undefined, close: async () => undefined })
  const persistence = { open: async () => ({ read: async () => ({ events }), close: async () => undefined }) }
  const witness = await reviewSubject({ ...h.apparatus, persistence: persistence as never }, {}, agentFor('worker', 'worker'),
    'outer', JSON.parse(h.subject.toString('utf8')), new AbortController().signal, h.run.revision, false)
  expect(witness.verdict).toBe('fail')
  expect(waits).toBe(4)
  expect(h.apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).size).toBe(2)
  expect(h.apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, review.reviewId)!.status).toBe(
    'completed',
  )
  await h.apparatus.store.close()
})
