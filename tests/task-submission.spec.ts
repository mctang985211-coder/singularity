import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'

import { AGENT_ROLE, foldSubject, MemoryLog, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type EmitInput, type TaskState } from '../src/index.ts'
import { AGENT, CHILD, commandsFor, createRevision, deployment, openAgent, PARENT, pin, planned } from './command-fixtures.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import { admitted, ARTIFACT, assigned, BUBBLE_CONDITIONS, BUBBLE_INPUTS, BUBBLE_MODEL, BUBBLE_TOOLS, bubbleOpened, contract, failed, fileAttachment, judged, REVISION, RUN_ID, SCHEDULER, started, SUBJECTS, TASK_ID, taskRegistry, UNIT_IMPLEMENTATION, UNIT_VERIFIER, verified } from './task-fixtures.ts'

const SUBMISSION = {
  requestId: 'control-1/session-1/call-1',
  requestDigest: '1'.repeat(64),
  programDigest: '2'.repeat(64),
  artifactDigest: ARTIFACT,
  inputDigests: BUBBLE_INPUTS,
  files: {
    program: fileAttachment('2'.repeat(64), 'program.ts', 127),
    artifact: fileAttachment(ARTIFACT, 'artifact.json', 0),
    inputs: BUBBLE_INPUTS.map(input => ({ name: input.name, attachment: fileAttachment(input.digest, 'words.txt', 19) })),
  },
  source: { sessionId: 'session-1', eventCount: 7, digest: '3'.repeat(64) },
} as const

const submissionFact = (submission: unknown = SUBMISSION, commandId = 'submit-1'): EmitInput => ({
  commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/submitted', subject: TASK_ID,
  payload: { runId: RUN_ID, submission },
})

const beginningFact = (commandId = 'begin-submit', requestDigest = SUBMISSION.requestDigest): EmitInput => ({
  commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/submitting', subject: TASK_ID,
  payload: { runId: RUN_ID, requestId: SUBMISSION.requestId, requestDigest },
})

async function working(bubble = true): Promise<MemoryLog> {
  const log = new MemoryLog(taskRegistry(), { subjects: { ...SUBJECTS, [AGENT_ROLE]: 'apparatus-1', stranger: 'stranger-1' } })
  await log.emit(admitted())
  await log.emit(assigned())
  await log.emit(started())
  if (bubble) await log.emit(bubbleOpened())
  return log
}

function state(log: MemoryLog): TaskState {
  const task = foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
  if (task === undefined) throw new Error('expected task')
  return task
}

describe('one Task has one complete running attempt', () => {
  it('starts in working and refuses another Run until settlement', async () => {
    const log = await working()
    expect(state(log).runs[RUN_ID]?.stage).toBe('working')
    expect(await asyncRefusalOf(() => log.emit(started('run-2')))).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining(RUN_ID) })
    await log.emit(failed('cancelled'))
    await log.emit(started('run-2'))
    expect(state(log).runs['run-2']?.status).toBe('running')
  })

  it('serializes two starts even when no child plan owns the Task', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit', taskId: PARENT, contract: contract() })
    await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })
    const outcomes = await Promise.allSettled([
      commands.startRun({ commandId: 'start-a', taskId: PARENT, runId: 'run-a', revision: pin(live) }),
      commands.startRun({ commandId: 'start-b', taskId: PARENT, runId: 'run-b', revision: pin(live) }),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(Object.keys(live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)?.runs ?? {})).toHaveLength(1)
  })
})

describe('submission freezes the attempt', () => {
  it('reserves one submission request before execution and refuses changed content', async () => {
    const log = await working()
    const reserved = await log.emit(beginningFact())
    expect(state(log).runs[RUN_ID]).toMatchObject({ stage: 'submitting', request: { id: SUBMISSION.requestId, digest: SUBMISSION.requestDigest } })
    expect(await log.emit(beginningFact())).toEqual(reserved)
    expect(await asyncRefusalOf(() => log.emit(beginningFact('begin-submit', '4'.repeat(64))))).toMatchObject({ code: 'command-conflict' })
    expect(await asyncRefusalOf(() => log.emit(beginningFact('other-call')))).toMatchObject({ code: 'illegal-transition' })
    expect(await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).toMatchObject({ code: 'illegal-transition' })
  })

  it('records the exact request, bytes and source on the responsible Run', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const submitted = await log.emit(submissionFact())
    expect(state(log).runs[RUN_ID]).toMatchObject({ status: 'running', stage: 'submitted', submission: SUBMISSION, submittedAt: submitted.at })
    expect(await log.emit(submissionFact())).toEqual(submitted)
    expect(await asyncRefusalOf(() => log.emit(submissionFact({ ...SUBMISSION, programDigest: '4'.repeat(64),
      files: { ...SUBMISSION.files, program: fileAttachment('4'.repeat(64), 'program.ts', 128) },
    })))).toMatchObject({ code: 'command-conflict' })
    expect(await asyncRefusalOf(() => log.emit(submissionFact(SUBMISSION, 'second-submit')))).toMatchObject({ code: 'illegal-transition' })
  })

  it('refuses missing context, foreign responsibility and different inputs without committing', async () => {
    const withoutBubble = await working(false)
    expect(await asyncRefusalOf(() => withoutBubble.emit(beginningFact()))).toMatchObject({ code: 'illegal-transition' })
    const log = await working()
    const before = log.count
    expect(await asyncRefusalOf(() => log.emit({ ...beginningFact(), as: 'stranger' }))).toMatchObject({ code: 'not-responsible' })
    expect(log.count).toBe(before)
    await log.emit(beginningFact())
    const reserved = log.count
    expect(await asyncRefusalOf(() => log.emit({ ...submissionFact(), as: 'stranger' }))).toMatchObject({ code: 'not-responsible' })
    expect(await asyncRefusalOf(() => log.emit(submissionFact({ ...SUBMISSION, inputDigests: [], files: { ...SUBMISSION.files, inputs: [] } })))).toMatchObject({ code: 'evidence-input-mismatch' })
    expect(log.count).toBe(reserved)
  })

  it('refuses context and consumption changes once submission begins', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const lateConsumption = {
      commandId: 'late-method', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.methodConsumed, subject: TASK_ID,
      payload: { runId: RUN_ID, revision: REVISION, method: 'count', source: 'late-event' },
    }
    expect(await asyncRefusalOf(() => log.emit(bubbleOpened()))).toMatchObject({ code: 'illegal-transition' })
    expect(await asyncRefusalOf(() => log.emit(lateConsumption))).toMatchObject({ code: 'illegal-transition' })
    await log.emit(submissionFact())
    expect(await asyncRefusalOf(() => log.emit(bubbleOpened()))).toMatchObject({ code: 'illegal-transition' })
    expect(await asyncRefusalOf(() => log.emit(lateConsumption))).toMatchObject({ code: 'illegal-transition' })
  })

  it('requires the reserved request and refuses beginning after a verdict', async () => {
    const log = await working()
    expect(await asyncRefusalOf(() => log.emit(submissionFact()))).toMatchObject({ code: 'illegal-transition' })
    await log.emit(beginningFact())
    expect(await asyncRefusalOf(() => log.emit(submissionFact({ ...SUBMISSION, requestDigest: '4'.repeat(64) })))).toMatchObject({ code: 'command-conflict' })
    expect(await asyncRefusalOf(() => log.emit(submissionFact({ ...SUBMISSION, requestId: 'another-call' })))).toMatchObject({ code: 'command-conflict' })
    const judgedLog = await working()
    await judgedLog.emit(judged('correctness', UNIT_VERIFIER))
    expect(await asyncRefusalOf(() => judgedLog.emit(beginningFact()))).toMatchObject({ code: 'illegal-transition' })
  })

  it('binds verifier evidence to the submitted artifact', async () => {
    const log = await working()
    await log.emit(beginningFact())
    await log.emit(submissionFact())
    expect(await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { artifactDigest: '5'.repeat(64) })))).toMatchObject({ code: 'evidence-input-mismatch' })
    await log.emit(judged('correctness', UNIT_VERIFIER))
    expect(state(log).runs[RUN_ID]?.evidence[0]?.artifactDigest).toBe(ARTIFACT)
  })

  it('seals execution failure but refuses evidence and verified settlement', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const submission = { ...SUBMISSION, executionFailure: 'program exited with code 3' }
    await log.emit(submissionFact(submission))
    const before = log.count
    expect(await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).toMatchObject({ code: 'illegal-transition' })
    expect(await asyncRefusalOf(() => log.emit(verified()))).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('failed program execution') })
    expect(await asyncRefusalOf(() => log.emit({ ...failed(), payload: { runId: RUN_ID, cause: 'acceptance' } })))
      .toMatchObject({ code: 'illegal-transition' })
    expect(log.count).toBe(before)
    expect(state(log).runs[RUN_ID]).toMatchObject({ status: 'running', submission, evidence: [] })
    await log.emit(failed(submission.executionFailure))
    expect(state(log).runs[RUN_ID]).toMatchObject({ status: 'failed', submission, failureReason: submission.executionFailure })
  })

  it('refuses verified settlement of a sealed submission with no verifier evidence', async () => {
    const log = await working()
    await log.emit(beginningFact())
    await log.emit(submissionFact())
    expect(await asyncRefusalOf(() => log.emit(verified()))).toMatchObject({ code: 'unadjudicated-criterion' })
  })

  it('refuses reusing one reservation command for another Task before changing its Run', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const anotherTask = 'task-b'
    for (const fact of [admitted(), assigned(), started(), bubbleOpened()])
      await log.emit({ ...fact, subject: anotherTask })
    const before = log.count
    expect(await asyncRefusalOf(() => log.emit({ ...beginningFact(), subject: anotherTask }))).toMatchObject({ code: 'command-conflict' })
    expect(log.count).toBe(before)
    const other = foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, anotherTask)
    expect(other?.runs[RUN_ID]).toMatchObject({ stage: 'working' })
    expect(other?.runs[RUN_ID]?.request).toBeUndefined()
  })

  it('rejects unknown members and malformed source identity', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const malformed = [
      { ...SUBMISSION, extra: true },
      { ...SUBMISSION, programDigest: 'wrong' },
      { ...SUBMISSION, executionFailure: 3 },
      { ...SUBMISSION, executionFailure: '' },
      { ...SUBMISSION, source: { ...SUBMISSION.source, extra: true } },
      { ...SUBMISSION, source: { ...SUBMISSION.source, eventCount: -1 } },
      { ...SUBMISSION, source: { ...SUBMISSION.source, eventCount: 1.5 } },
      { ...SUBMISSION, source: { ...SUBMISSION.source, digest: 'wrong' } },
    ]
    for (const payload of malformed)
      expect(await asyncRefusalOf(() => log.emit(submissionFact(payload)))).toMatchObject({ code: 'malformed-payload' })
  })

  it('requires native file receipts whose content IDs bind every submitted digest', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const before = log.count
    const { files, ...withoutFiles } = SUBMISSION
    const input = files.inputs[0]!
    const malformed = [
      withoutFiles,
      { ...SUBMISSION, files: {} },
      { ...SUBMISSION, files: { ...files, extra: true } },
      { ...SUBMISSION, files: { ...files, program: { ...files.program, extra: true } } },
      { ...SUBMISSION, files: { ...files, artifact: { ...files.artifact, extra: true } } },
      { ...SUBMISSION, files: { ...files, program: { ...files.program, attachmentId: 'wrong' } } },
      { ...SUBMISSION, files: { ...files, program: { ...files.program, attachmentId: SUBMISSION.programDigest } } },
      { ...SUBMISSION, files: { ...files, program: { ...files.program, attachmentId: AttachmentId('sha256:' + '4'.repeat(64)) } } },
      { ...SUBMISSION, files: { ...files, artifact: { ...files.artifact, attachmentId: AttachmentId('sha256:' + '4'.repeat(64)) } } },
      { ...SUBMISSION, files: { ...files, program: { ...files.program, name: '' } } },
      { ...SUBMISSION, files: { ...files, inputs: null } },
      { ...SUBMISSION, files: { ...files, inputs: [] } },
      { ...SUBMISSION, files: { ...files, inputs: [{ ...input, extra: true }] } },
      { ...SUBMISSION, files: { ...files, inputs: [{ ...input, name: 'foreign-input' }] } },
      { ...SUBMISSION, files: { ...files, inputs: [{ ...input, attachment: { ...input.attachment, extra: true } }] } },
      { ...SUBMISSION, files: { ...files, inputs: [{ ...input, attachment: { ...input.attachment, attachmentId: AttachmentId('sha256:' + '4'.repeat(64)) } }] } },
      { ...SUBMISSION, files: { ...files, inputs: [input, input] } },
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(bytes =>
        ({ ...SUBMISSION, files: { ...files, artifact: { ...files.artifact, bytes } } })),
    ]
    for (const payload of malformed) {
      expect(await asyncRefusalOf(() => log.emit(submissionFact(payload)))).toMatchObject({ code: 'malformed-payload' })
      expect(log.count).toBe(before)
    }
  })

  it('refuses reordered or duplicate input receipts even when all content IDs are valid', async () => {
    const log = await working()
    await log.emit(beginningFact())
    const first = SUBMISSION.files.inputs[0]!
    const second = { name: 'other-input', attachment: fileAttachment('5'.repeat(64), 'other.txt', 1) }
    const inputDigests = [...BUBBLE_INPUTS, { name: second.name, digest: '5'.repeat(64) }]
    for (const inputs of [[second, first], [first, first]])
      expect(await asyncRefusalOf(() => log.emit(submissionFact({ ...SUBMISSION, inputDigests,
        files: { ...SUBMISSION.files, inputs },
      })))).toMatchObject({ code: 'malformed-payload' })
    expect(state(log).runs[RUN_ID]?.stage).toBe('submitting')
  })

  it('exposes submission through the bound agent command and replays after settlement', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit', taskId: PARENT, contract: contract() })
    await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })
    const bound = commands.forAgent(AGENT)
    await bound.startRun({ commandId: 'start', taskId: PARENT, runId: RUN_ID, revision: pin(live) })
    await bound.openBubble({ commandId: 'bubble', taskId: PARENT, runId: RUN_ID, inputs: BUBBLE_INPUTS, workspace: { kind: 'dir', ref: '/workspace/run-1' }, model: BUBBLE_MODEL, tools: BUBBLE_TOOLS, conditions: BUBBLE_CONDITIONS })
    await bound.beginSubmission({ commandId: 'begin-submit', taskId: PARENT, runId: RUN_ID, requestId: SUBMISSION.requestId, requestDigest: SUBMISSION.requestDigest })
    const input = { commandId: 'submit', taskId: PARENT, runId: RUN_ID, submission: SUBMISSION }
    const original = await bound.submitRun(input)
    expect(original.actor).toBe(SCHEDULER)
    await bound.failRun({ commandId: 'cancel', taskId: PARENT, runId: RUN_ID, reason: 'cancelled' })
    expect(await bound.submitRun(input)).toEqual(original)
  })

  it('grants one fresh reservation to concurrent identical commands and replays its durable envelope', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit', taskId: PARENT, contract: contract() })
    await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })
    const bound = commands.forAgent(AGENT)
    await bound.startRun({ commandId: 'start', taskId: PARENT, runId: RUN_ID, revision: pin(live) })
    await bound.openBubble({ commandId: 'bubble', taskId: PARENT, runId: RUN_ID, inputs: BUBBLE_INPUTS, workspace: { kind: 'dir', ref: '/workspace/run-1' }, model: BUBBLE_MODEL, tools: BUBBLE_TOOLS, conditions: BUBBLE_CONDITIONS })
    const input = { commandId: 'begin-submit', taskId: PARENT, runId: RUN_ID, requestId: SUBMISSION.requestId, requestDigest: SUBMISSION.requestDigest }
    const [first, concurrent] = await Promise.all([bound.beginSubmission(input), bound.beginSubmission(input)])
    expect([first.fresh, concurrent.fresh]).toEqual([true, false])
    expect(concurrent.envelope).toEqual(first.envelope)
    await bound.failRun({ commandId: 'cancel', taskId: PARENT, runId: RUN_ID, reason: 'cancelled' })
    expect(await bound.beginSubmission(input)).toEqual({ envelope: first.envelope, fresh: false })
    expect(live.store.load().entries().filter(fact => fact.kind === TASK_KINDS.runSubmitting)).toEqual([first.envelope])
  })

  it('waits for its own children before submission while allowing the child to submit', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = await planned(live)
    const context = { runId: RUN_ID, inputs: BUBBLE_INPUTS, workspace: { kind: 'dir', ref: '/workspace/run-1' }, model: BUBBLE_MODEL, tools: BUBBLE_TOOLS, conditions: BUBBLE_CONDITIONS }
    await commands.startRun({ commandId: 'parent-start', taskId: PARENT, runId: RUN_ID, revision: pin(live) })
    await commands.openBubble({ commandId: 'parent-bubble', taskId: PARENT, ...context })
    const parentSubmit = { commandId: 'parent-submit', taskId: PARENT, runId: RUN_ID, requestId: SUBMISSION.requestId, requestDigest: SUBMISSION.requestDigest }
    const before = live.store.load().entries().length
    expect(await asyncRefusalOf(() => commands.beginSubmission(parentSubmit))).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining(CHILD) })
    expect(live.store.load().entries().length).toBe(before)
    await commands.startRun({ commandId: 'child-start', taskId: CHILD, runId: RUN_ID, revision: pin(live) })
    await commands.openBubble({ commandId: 'child-bubble', taskId: CHILD, ...context })
    await commands.beginSubmission({ ...parentSubmit, commandId: 'child-begin', taskId: CHILD })
    await commands.submitRun({ commandId: 'child-submit', taskId: CHILD, runId: RUN_ID, submission: SUBMISSION })
    await commands.recordVerdict({ commandId: 'child-verdict', taskId: CHILD, verdict: { runId: RUN_ID, criterionId: 'part', verdict: 'pass', implementationDigest: UNIT_IMPLEMENTATION, artifactDigest: ARTIFACT, inputDigests: BUBBLE_INPUTS } })
    await commands.settle({ commandId: 'child-settle', taskId: CHILD, runId: RUN_ID })
    expect((await commands.beginSubmission(parentSubmit)).envelope.kind).toBe('run/submitting')
  })

  it('rejects task v7 rather than guessing a failed Run cause', () => {
    expect(TASK_VERSION).toBe(9)
    expect(refusalOf(() => taskRegistry().ruleFor(TASK_PROTOCOL, 7, TASK_KINDS.runStarted))).toMatchObject({ code: 'version-mismatch' })
  })
})
