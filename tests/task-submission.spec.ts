import { describe, expect, it } from 'vitest'
import { MemoryLog, foldSubject, TASK_PROTOCOL, TASK_VERSION, type TaskState, type EmitInput } from '../src/index.ts'
import {
  admitted,
  assigned,
  started,
  bubbleOpened,
  contract,
  taskRegistry,
  SUBJECTS,
  TASK_ID,
  RUN_ID,
  ARTIFACT,
  BUBBLE_INPUTS,
  fileAttachment,
  judged,
  UNIT_VERIFIER,
  failed,
} from './task-fixtures.ts'
import { asyncRefusalOf } from './fixtures.ts'
const submission = {
  requestId: 'call-1',
  requestDigest: '1'.repeat(64),
  artifactDigest: ARTIFACT,
  inputDigests: BUBBLE_INPUTS,
  files: {
    artifact: fileAttachment(ARTIFACT, 'artifact.json'),
    inputs: BUBBLE_INPUTS.map(i => ({ name: i.name, attachment: fileAttachment(i.digest, i.name) })),
  },
  source: { sessionId: 'session-1', eventCount: 7, digest: '3'.repeat(64) },
}
const fact = (value: unknown = submission, commandId = 'submit'): EmitInput => ({
  commandId,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind: 'run/submitted',
  subject: TASK_ID,
  payload: { runId: RUN_ID, submission: value },
})
async function working() {
  const log = new MemoryLog(taskRegistry(), { subjects: { ...SUBJECTS, stranger: 'stranger' } })
  for (const e of [admitted(), assigned(), started(), bubbleOpened()]) await log.emit(e)
  return log
}
const state = (log: MemoryLog) =>
  foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)!
describe('atomic artifact submission', () => {
  it('records frozen files and transcript in one fact and replays the same receipt after settlement', async () => {
    const log = await working(),
      event = await log.emit(fact())
    expect(state(log).runs[RUN_ID]).toMatchObject({
      stage: 'submitted',
      submission,
      request: { id: 'call-1', digest: '1'.repeat(64) },
    })
    await log.emit(failed('fixture stopped'))
    const count = log.count
    expect(await log.emit(fact())).toEqual(event)
    expect(log.count).toBe(count)
  })
  it('serializes duplicate submissions and refuses changed content', async () => {
    const log = await working(),
      [a, b] = await Promise.all([log.emit(fact()), log.emit(fact())])
    expect(a).toEqual(b)
    expect(await asyncRefusalOf(() => log.emit(fact({ ...submission, requestDigest: '4'.repeat(64) })))).toMatchObject({
      code: 'command-conflict',
    })
    expect(await asyncRefusalOf(() => log.emit(fact(submission, 'other')))).toMatchObject({
      code: 'illegal-transition',
    })
  })
  it('rejects foreign ownership, changed inputs and later context without committing', async () => {
    const log = await working(),
      count = log.count
    expect(await asyncRefusalOf(() => log.emit({ ...fact(), as: 'stranger' }))).toMatchObject({
      code: 'not-responsible',
    })
    expect(
      await asyncRefusalOf(() =>
        log.emit(fact({ ...submission, inputDigests: [], files: { ...submission.files, inputs: [] } })),
      ),
    ).toMatchObject({ code: 'evidence-input-mismatch' })
    expect(log.count).toBe(count)
    await log.emit(fact())
    expect(await asyncRefusalOf(() => log.emit(bubbleOpened()))).toMatchObject({ code: 'illegal-transition' })
    expect(
      await asyncRefusalOf(() =>
        log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { artifactDigest: '5'.repeat(64) })),
      ),
    ).toMatchObject({ code: 'evidence-input-mismatch' })
  })
  it('refuses incomplete source and mismatching immutable attachment metadata', async () => {
    const log = await working(),
      files = submission.files,
      input = files.inputs[0]!,
      count = log.count
    const malformed = [
      { ...submission, extra: true },
      { ...submission, programDigest: '2'.repeat(64) },
      { ...submission, source: { ...submission.source, eventCount: -1 } },
      { ...submission, source: { ...submission.source, digest: 'wrong' } },
      { ...submission, files: {} },
      { ...submission, files: { ...files, artifact: { ...files.artifact, extra: true } } },
      { ...submission, files: { ...files, artifact: { ...files.artifact, attachmentId: 'sha256:' + '6'.repeat(64) } } },
      { ...submission, files: { ...files, inputs: [] } },
      { ...submission, files: { ...files, inputs: [input, input] } },
      { ...submission, files: { ...files, inputs: [{ ...input, name: 'other' }] } },
      ...[-1, 1.5, NaN, Infinity, '1'].map(bytes => ({
        ...submission,
        files: { ...files, artifact: { ...files.artifact, bytes } },
      })),
    ]
    for (const value of malformed) {
      expect(await asyncRefusalOf(() => log.emit(fact(value)))).toMatchObject({ code: 'malformed-payload' })
      expect(log.count).toBe(count)
    }
  })
  it('keeps concrete checkers out of Task admission', () => {
    expect(contract().criteria[0]).toEqual({ criterionId: 'correctness', statement: 'counts match the golden file' })
    expect(taskRegistry().kindsOf(TASK_PROTOCOL, TASK_VERSION)).not.toContain('run/submitting')
  })
})
