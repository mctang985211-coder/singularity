import { describe, expect, it } from 'vitest'

import {
  MemoryLog,
  projectReceipt,
  receiptDigest,
  sealEnvelope,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
} from '../src/index.ts'
import { refusalOf } from './fixtures.ts'
import {
  admitted,
  ARTIFACT,
  assigned,
  BUBBLE_INPUTS,
  bubbleOpened,
  contract,
  failed,
  fileAttachment,
  RUN_ID,
  sliceCommands,
  started,
  SUBJECTS,
  TASK_ID,
  taskRegistry,
} from './task-fixtures.ts'

describe('a run receipt seals its control source', () => {
  it.each([
    { status: 'verified', cutoff: 7 },
    { status: 'failed', cutoff: 5 },
  ] as const)('keeps a $status receipt fixed when other facts and attempts arrive', async ({ status, cutoff }) => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    const commands =
      status === 'verified' ? sliceCommands() : [admitted(), assigned(), started(), bubbleOpened(), failed('cancelled')]
    for (const command of commands) await log.emit(command)
    const receipt = projectReceipt(registry, log.entries(), TASK_ID, RUN_ID)
    expect(receipt).toMatchObject({ status, cutoff, source: null, submission: null })

    await log.emit({ ...admitted(), subject: 'another-task' })
    await log.emit(started('another-run'))
    await log.emit(failed('timeout', 'another-run'))

    expect(projectReceipt(registry, log.entries(), TASK_ID, RUN_ID)).toEqual(receipt)
    expect(receiptDigest(projectReceipt(registry, log.entries().slice(0, cutoff), TASK_ID, RUN_ID))).toBe(
      receiptDigest(receipt),
    )
  })

  it.each(['verified', 'failed'] as const)('cites the sealed execution submission of a %s run', async status => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    const commands = sliceCommands()
    for (const command of commands.slice(0, 4)) await log.emit(command)
    const submission = {
      requestId: 'session-1/call-1',
      requestDigest: '1'.repeat(64),
      artifactDigest: ARTIFACT,
      inputDigests: BUBBLE_INPUTS,
      files: {
        artifact: fileAttachment(ARTIFACT, 'artifact.json'),
        inputs: BUBBLE_INPUTS.map(input => ({
          name: input.name,
          attachment: fileAttachment(input.digest, 'words.txt'),
        })),
      },
      source: { sessionId: 'session-1', eventCount: 12, digest: '3'.repeat(64) },
    }
    await log.emit({
      commandId: 'submit',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.runSubmitted,
      subject: TASK_ID,
      payload: { runId: RUN_ID, submission },
    })
    if (status === 'verified') for (const command of commands.slice(4)) await log.emit(command)
    else await log.emit(failed('execution failed'))

    expect(projectReceipt(registry, log.entries(), TASK_ID, RUN_ID)).toMatchObject({
      cutoff: status === 'verified' ? 8 : 6,
      status,
      submission,
      source: { sessionId: 'session-1', eventCount: 12, digest: '3'.repeat(64) },
    })
  })

  it('rejects an interior sequence collision even when the last sequence matches the array length', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit({ ...admitted(), subject: 'another-task' })
    for (const command of sliceCommands()) await log.emit(command)
    let previousDigest: string | null = null
    const entries = log.entries().map((entry, index) => {
      const { digest: _digest, ...body } = entry
      const resealed = sealEnvelope({ ...body, seq: index === 0 ? 1 : entry.seq, prevDigest: previousDigest })
      previousDigest = resealed.digest
      return resealed
    })

    expect(refusalOf(() => projectReceipt(registry, entries, TASK_ID, RUN_ID))).toMatchObject({ code: 'chain-broken' })
  })

  it('rejects a broken chain in the supplied prefix after the run settled', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const command of sliceCommands()) await log.emit(command)
    await log.emit({ ...admitted(), subject: 'another-task' })
    const entries = log.entries().map((entry, index) => {
      if (index !== 7) return entry
      const { digest: _digest, ...body } = entry
      return sealEnvelope({ ...body, prevDigest: null })
    })

    expect(refusalOf(() => projectReceipt(registry, entries, TASK_ID, RUN_ID))).toMatchObject({ code: 'chain-broken' })
  })

  it('rejects a tampered envelope even when it belongs to another task after settlement', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const command of sliceCommands()) await log.emit(command)
    await log.emit({ ...admitted(), subject: 'another-task' })
    const entries = log.entries().map((entry, index) => (index === 7 ? { ...entry, actor: 'tampered-actor' } : entry))

    expect(refusalOf(() => projectReceipt(registry, entries, TASK_ID, RUN_ID))).toMatchObject({
      code: 'digest-mismatch',
    })
  })

  it.each([
    { kind: 'run/unknown', payload: {}, code: 'unknown-kind' },
    { kind: TASK_KINDS.admitted, payload: { contract: contract(), extra: true }, code: 'malformed-payload' },
  ])('rejects an unreadable $kind fact after settlement', async ({ kind, payload, code }) => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const command of sliceCommands()) await log.emit(command)
    const entries = log.entries()
    const extra = sealEnvelope({
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind,
      subject: 'another-task',
      commandId: 'unreadable-fact',
      emitter: 'scheduler',
      actor: SUBJECTS['scheduler']!,
      at: '2026-10-11T00:00:00.000Z',
      seq: 7,
      prevDigest: entries[6]!.digest,
      payload,
    })

    expect(refusalOf(() => projectReceipt(registry, [...entries, extra], TASK_ID, RUN_ID))).toMatchObject({ code })
  })
})
