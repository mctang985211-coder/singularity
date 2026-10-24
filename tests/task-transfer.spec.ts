import { describe, expect, it } from 'vitest'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../src/task/protocol.ts'
import {
  admitted,
  assigned,
  REVISION,
  RUN_ID,
  SCHEDULER,
  started,
  TASK_ID,
  taskRegistry,
  fileAttachment,
  bubbleOpened,
  ARTIFACT,
  BUBBLE_INPUTS,
} from './task-fixtures.ts'

const champion = { ...REVISION, revisionId: 'champion', digest: 'b'.repeat(64) }
const frozen = {
  baseline: REVISION,
  champion,
  suiteDigest: 'c'.repeat(64),
  executionProfileDigest: 'd'.repeat(64),
  roundId: 'validation-round',
}
const subjects = { scheduler: SCHEDULER }
const report = (hex: string) => ({ attachmentId: `sha256:${hex.repeat(64)}`, name: 'transfer-report.json', bytes: 128 })
const emit = (log: MemoryLog, kind: string, payload: unknown, commandId = `${kind}:${log.count}`) =>
  log.emit({
    commandId,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind,
    subject: TASK_ID,
    payload,
  })
function running(purpose = 'improve', sealed = true) {
  const log = new MemoryLog(taskRegistry(), { subjects })
  log.emit(admitted())
  log.emit(assigned())
  const start = started()
  log.emit({ ...start, payload: { ...(start.payload as object), purpose } })
  log.emit(bubbleOpened())
  emit(log, 'rsi/search-opened', { runId: RUN_ID, maxProposals: 6 })
  if (sealed) submitReport(log)
  return log
}
function submitReport(log: MemoryLog) {
  emit(log, 'run/submitted', {
    runId: RUN_ID,
    submission: {
      requestId: 'report',
      requestDigest: '1'.repeat(64),
      artifactDigest: ARTIFACT,
      inputDigests: BUBBLE_INPUTS,
      files: {
        artifact: fileAttachment(ARTIFACT, 'artifact.json'),
        inputs: BUBBLE_INPUTS.map(input => ({
          name: input.name,
          attachment: fileAttachment(input.digest, input.name),
        })),
      },
      source: { sessionId: 'improvement', eventCount: 7, digest: '3'.repeat(64) },
    },
  })
}
const batch = (id = 'batch-1') => ({
  batchId: id,
  incumbent: REVISION,
  historyCutoff: 0,
  slots: [
    {
      path: 'candidate.json',
      contentDigest: 'e'.repeat(64),
      proposal: fileAttachment('e'.repeat(64), 'candidate.json', 128),
    },
  ],
})
const state = (log: MemoryLog) => log.stateAt<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID, log.count)!

describe('frozen champion and one-use validation tranche', () => {
  it('cannot expose private validation while the author can still change its report', () => {
    const log = running('improve', false),
      count = log.count
    expect(() => emit(log, 'rsi/transfer-frozen', frozen)).toThrow('submitted report')
    expect(log.count).toBe(count)
    expect(state(log).transfer).toBeUndefined()
  })
  it('freezes exact baseline, champion, suite and execution profile once, then bars new search candidates', () => {
    const log = running()
    const fact = emit(log, 'rsi/transfer-frozen', frozen, 'freeze-champion')
    expect(state(log).transfer).toEqual({ ...frozen, consumed: false })
    const count = log.count
    expect(emit(log, 'rsi/transfer-frozen', frozen, 'freeze-champion')).toEqual(fact)
    expect(log.count).toBe(count)
    expect(() => emit(log, 'rsi/transfer-frozen', { ...frozen, champion: REVISION })).toThrow('already frozen')
    expect(() => emit(log, 'rsi/batch-opened', batch('fresh-batch'))).toThrow('working RSI Run')
    expect(() =>
      emit(log, 'rsi/round-requested', {
        runId: RUN_ID,
        roundId: 'after-freeze',
        round: 2,
        incumbent: champion,
        candidates: [REVISION],
      }),
    ).toThrow('champion is frozen')
    expect(log.count).toBe(count)
  })

  it.each(['batch', 'evaluation'] as const)('refuses to freeze while %s is pending', pending => {
    const log = running('improve', false)
    if (pending === 'batch') emit(log, 'rsi/batch-opened', batch())
    if (pending === 'evaluation')
      emit(log, 'rsi/round-requested', {
        runId: RUN_ID,
        roundId: 'pending-round',
        round: 1,
        incumbent: REVISION,
        candidates: [champion],
      })
    const count = log.count
    expect(() => emit(log, 'rsi/transfer-frozen', frozen)).toThrow('submitted report and settled search work')
    expect(state(log).transfer).toBeUndefined()
    expect(log.count).toBe(count)
  })

  it('allows freezing after every planned slot and evaluation settles, including rejected slots', () => {
    const log = running('improve', false)
    emit(log, 'rsi/batch-opened', batch())
    emit(log, 'rsi/batch-slot-settled', {
      batchId: 'batch-1',
      slot: 0,
      status: 'critic-rejected',
      detail: 'Unsupported task-specific mechanism',
    })
    expect(() => emit(log, 'rsi/transfer-frozen', frozen)).toThrow('submitted report and settled search work')
    emit(log, 'rsi/batch-ended', { batchId: 'batch-1' })
    submitReport(log)
    emit(log, 'rsi/transfer-frozen', frozen)
    expect(state(log).transfer).toEqual({ ...frozen, consumed: false })
  })

  it('consumes the exact suite once and settles once without giving cold recovery another tranche', () => {
    const log = running()
    expect(() => emit(log, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest })).toThrow('unavailable')
    emit(log, 'rsi/transfer-frozen', frozen)
    expect(() => emit(log, 'rsi/transfer-settled', { outcome: 'improved', report: report('1') })).toThrow(
      'consumed once',
    )
    expect(() => emit(log, 'rsi/transfer-started', { suiteDigest: '0'.repeat(64) })).toThrow('unavailable')
    const start = emit(log, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest }, 'consume-tranche')
    expect(emit(log, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest }, 'consume-tranche')).toEqual(start)
    const restored = MemoryLog.adopt(JSON.parse(JSON.stringify(log.entries())), taskRegistry(), { subjects })
    expect(state(restored).transfer).toEqual({ ...frozen, consumed: true })
    expect(() => emit(restored, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest })).toThrow('unavailable')
    const result = { outcome: 'insufficient-evidence', report: report('2') }
    const settled = emit(restored, 'rsi/transfer-settled', result, 'settle-tranche')
    expect(emit(restored, 'rsi/transfer-settled', result, 'settle-tranche')).toEqual(settled)
    expect(() => emit(restored, 'rsi/transfer-settled', { ...result, outcome: 'improved' })).toThrow('consumed once')
    expect(state(restored).transfer).toEqual({ ...frozen, consumed: true, ...result })
  })

  it.each(['improved', 'no-improvement', 'insufficient-evidence'] as const)(
    'persists the honest %s result',
    outcome => {
      const log = running()
      emit(log, 'rsi/transfer-frozen', frozen)
      emit(log, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest })
      emit(log, 'rsi/transfer-settled', { outcome, report: report('3') })
      expect(state(log).transfer).toMatchObject({ outcome, report: report('3'), baseline: REVISION, champion })
    },
  )

  it('closes consumed validation after its analysis fails using insufficient evidence only', () => {
    const log = running()
    emit(log, 'rsi/transfer-frozen', frozen)
    emit(log, 'rsi/transfer-started', { suiteDigest: frozen.suiteDigest })
    emit(log, 'run/failed', { runId: RUN_ID, cause: 'runtime', reason: 'native retries exhausted' })
    expect(() => emit(log, 'rsi/transfer-settled', { outcome: 'improved', report: report('4') })).toThrow(
      'submitted report',
    )
    emit(log, 'rsi/transfer-settled', { outcome: 'insufficient-evidence', report: report('4') })
    expect(state(log).transfer).toMatchObject({ consumed: true, outcome: 'insufficient-evidence' })
  })
})
