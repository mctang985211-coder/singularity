import { expect, it } from 'vitest'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../src/task/protocol.ts'
import { admitted, assigned, started, bubbleOpened, taskRegistry, TASK_ID, RUN_ID, SCHEDULER,
  REVISION, ARTIFACT, BUBBLE_INPUTS, fileAttachment } from './task-fixtures.ts'

const emit = (log: MemoryLog, kind: string, payload: unknown, commandId = `${kind}:${log.count}`) => log.emit({ commandId,
  protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject: TASK_ID, payload })
const state = (log: MemoryLog) => log.stateAt<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID, log.count)!
function running(maxProposals = 2) {
  const log = new MemoryLog(taskRegistry(), { subjects: { scheduler: SCHEDULER } })
  log.emit(admitted()); log.emit(assigned())
  const start = started()
  log.emit({ ...start, payload: { ...start.payload as object, purpose: 'improve', relatedTo: { taskId: 'closed-business', runId: 'business-run' } } })
  log.emit(bubbleOpened())
  emit(log, 'rsi/search-opened', { runId: RUN_ID, maxProposals })
  return log
}
const batch = (id = 'batch-1', hexes = ['a', 'b']) => ({ batchId: id, incumbent: REVISION, historyCutoff: 0,
  slots: hexes.map((hex, slot) => ({ path: `candidate-${slot}.json`, contentDigest: hex.repeat(64),
    proposal: fileAttachment(hex.repeat(64), `candidate-${slot}.json`, 128) })) })
const submit = (log: MemoryLog) => emit(log, 'run/submitted', { runId: RUN_ID, submission: {
  requestId: 'report', requestDigest: '1'.repeat(64), artifactDigest: ARTIFACT, inputDigests: BUBBLE_INPUTS,
  files: { artifact: fileAttachment(ARTIFACT, 'artifact.json'),
    inputs: BUBBLE_INPUTS.map(input => ({ name: input.name, attachment: fileAttachment(input.digest, input.name) })) },
  source: { sessionId: 'improvement', eventCount: 7, digest: '3'.repeat(64) },
} })

it('counts invalid and rejected slots once across recovery and permits the final report without a screening latch', () => {
  const log = running()
  emit(log, 'rsi/batch-opened', batch())
  expect(() => emit(log, 'rsi/batch-opened', batch('too-soon', ['c']))).toThrow('batch is pending')
  emit(log, 'rsi/batch-slot-settled', { batchId: 'batch-1', slot: 0, status: 'invalid', detail: 'invalid proposal JSON' })
  emit(log, 'rsi/batch-slot-settled', { batchId: 'batch-1', slot: 1, status: 'critic-rejected', detail: 'unsupported mechanism' })
  expect(() => submit(log)).toThrow('batch is pending')
  emit(log, 'rsi/batch-ended', { batchId: 'batch-1' })
  const restored = MemoryLog.adopt(JSON.parse(JSON.stringify(log.entries())), taskRegistry(), { subjects: { scheduler: SCHEDULER } })
  expect(() => emit(restored, 'rsi/batch-opened', batch('exhausted', ['c']))).toThrow('budget exhausted')
  submit(restored)
  expect(state(restored).runs[RUN_ID]).toMatchObject({ status: 'running', stage: 'submitted' })
  expect(state(restored).search!.batches![0]!.outcomes.map(outcome => outcome.status)).toEqual(['invalid', 'critic-rejected'])
  expect(() => emit(restored, 'rsi/batch-opened', batch('after-submission', ['d']))).toThrow('working RSI Run')
  expect(state(restored).search).not.toHaveProperty('proposals')
  expect(state(restored).search).not.toHaveProperty('outcome')
})

it('keeps the batch request barrier and pending evaluation authoritative until the report can submit', () => {
  const log = running(), candidate = { ...REVISION, revisionId: 'candidate', digest: 'c'.repeat(64) }
  emit(log, 'rsi/batch-opened', batch('batch-1', ['a']))
  emit(log, 'rsi/batch-slot-settled', { batchId: 'batch-1', slot: 0, status: 'evaluation-requested', detail: 'critic passed', revision: candidate })
  expect(() => submit(log)).toThrow('batch is pending')
  emit(log, 'rsi/round-requested', { runId: RUN_ID, roundId: 'round-1', round: 1, incumbent: REVISION, candidates: [candidate] })
  emit(log, 'rsi/batch-ended', { batchId: 'batch-1' })
  expect(() => submit(log)).toThrow('evaluation is pending')
  expect(() => emit(log, 'rsi/batch-opened', batch('batch-2', ['b']))).toThrow('evaluation is pending')
  emit(log, 'rsi/round-settled', { roundId: 'round-1', status: 'failed', error: 'evaluation infrastructure unavailable' })
  submit(log)
  expect(state(log).runs[RUN_ID]!.stage).toBe('submitted')
})

it('requires each frozen proposal attachment to match the slot content digest', () => {
  const log = running(), frozen = batch('batch-1', ['a'])
  const count = log.count
  expect(() => emit(log, 'rsi/batch-opened', { ...frozen, slots: [{ ...frozen.slots[0], proposal: fileAttachment('b'.repeat(64), 'candidate.json') }] }))
    .toThrow('must equal the submitted content digest')
  expect(log.count).toBe(count)
  emit(log, 'rsi/batch-opened', frozen)
  expect(state(log).search!.batches![0]!.slots[0]!.proposal).toEqual(frozen.slots[0]!.proposal)
})

it('seals the report before private validation and keeps author admission closed through its outcome', () => {
  const log = running(), suiteDigest = 'd'.repeat(64)
  submit(log)
  const sealed = state(log).runs[RUN_ID]!.submission
  emit(log, 'rsi/transfer-frozen', { baseline: REVISION, champion: { ...REVISION, revisionId: 'champion', digest: 'b'.repeat(64) },
    suiteDigest, executionProfileDigest: 'c'.repeat(64), roundId: 'validation' })
  expect(() => submit(log)).toThrow('running/submitted')
  expect(() => emit(log, 'rsi/batch-opened', batch())).toThrow('working RSI Run')
  emit(log, 'rsi/transfer-started', { suiteDigest })
  expect(state(log).runs[RUN_ID]).toMatchObject({ status: 'running', stage: 'submitted', submission: sealed })
  emit(log, 'rsi/transfer-settled', { outcome: 'insufficient-evidence', report: fileAttachment('e'.repeat(64), 'transfer-report.json', 128) })
  expect(state(log).runs[RUN_ID]!.stage).toBe('submitted')
  expect(state(log).runs[RUN_ID]!.submission).toEqual(sealed)
  expect(() => emit(log, 'rsi/batch-opened', batch())).toThrow('working RSI Run')
})
