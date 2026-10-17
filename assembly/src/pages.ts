import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { refuse } from '../../src/protocol/refusal.ts'

/** Index native events first; explicitly page a selected body without spilling host files. */
export function trajectoryPage(events: readonly SessionEvent[], from = 0, count?: number, eventSeq?: number) {
  if (eventSeq === undefined) {
    count ??= 20
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
      refuse('malformed-declaration', 'trajectory index requires from >= 0 and 1 to 100 events per page')
    return events.slice(from, from + count).map(event => ({
      seq: event.seq, time: event.time, type: event.type,
      bytes: Buffer.byteLength(JSON.stringify(event, null, 2)),
      ...(event.type === 'tool/call' ? { tool: event.data.name } : {}),
    }))
  }
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0)
    refuse('malformed-declaration', 'eventSeq must be a nonnegative native event sequence')
  const event = events.find(event => event.seq === eventSeq)
  if (event === undefined) refuse('malformed-declaration', 'eventSeq is outside this readable trajectory')
  return { seq: event.seq, type: event.type, ...textPage(Buffer.from(JSON.stringify(event, null, 2)), from, count) }
}

export function textPage(bytes: Buffer, from = 0, count = 4096) {
  if (!Number.isSafeInteger(from) || from < 0 || from > bytes.length ||
      !Number.isSafeInteger(count) || count < 4 || count > 8192 ||
      (from < bytes.length && (bytes[from]! & 0xc0) === 0x80))
    refuse('malformed-declaration', 'text pages require a UTF-8 byte boundary and 4 to 8192 bytes')
  let next = Math.min(bytes.length, from + count)
  while (next < bytes.length && (bytes[next]! & 0xc0) === 0x80) next--
  return { totalBytes: bytes.length, from, next,
    complete: next === bytes.length, text: bytes.subarray(from, next).toString('utf8') }
}
