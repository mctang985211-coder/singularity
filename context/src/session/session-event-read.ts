/** One session event's visible text, paged in UTF-8 bytes (A2 §D, Q3 closure). @module @dangosys/dsh-singularity-context/session-event-read */

import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CallerResolution, LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, sliceUtf8, utf8Bytes, type Utf8Slice } from '../limits.ts'
import { errorCode, message, refused, read, type ProjectedRead } from '../refusals.ts'
import { sessionMembershipRefusal, SESSION_EVENT_PAGE_MIN_BYTES } from '../reads/guards.ts'
import type { ReadDeps, SessionEventReference } from '../types.ts'
import { sessionEventPage } from './page.ts'

/** Whether `offsetBytes` sits on a character boundary; an offset outside the text is not one either. */
function onCharacterBoundary(text: string, offsetBytes: number): boolean {
  if (offsetBytes === 0) return true
  const byte = Buffer.from(text, 'utf8')[offsetBytes]
  return byte !== undefined && (byte & 0b1100_0000) !== 0b1000_0000
}

/** One session *event*'s visible text, paged in UTF-8 bytes (A2 §D, Q3 closure). */
export async function sessionEventRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  ref: SessionEventReference,
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution as Exclude<CallerResolution, { kind: 'unbound' }>
  signal?.throwIfAborted()
  const sessionId = ref.sessionId
  const seq = ref.seq
  const offset = requestedOffset ?? 0
  const requestedBytes = Math.trunc(requestedLimit ?? CONTEXT_OUTPUT_LIMIT_BYTES)
  const limit = Math.min(CONTEXT_OUTPUT_LIMIT_BYTES, Math.max(SESSION_EVENT_PAGE_MIN_BYTES, requestedBytes))
  const gate = await sessionMembershipRefusal(deps, loaded, sessionId)
  if (gate !== undefined) return gate

  let window: Awaited<ReturnType<ReadDeps['sessionQuery']['readEvent']>>
  try {
    window = await deps.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const code = errorCode(error)
    if (code === 'SESSION_QUERY_ABORTED') throw error
    if (code === 'SESSION_QUERY_EVENT_NOT_FOUND') {
      return refused(
        'stale-reference',
        `session "${sessionId}" has no event at seq ${seq}: ${message(error)}. The reference names an event this log does not hold.`,
      )
    }
    if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return refused('not-found', `session "${sessionId}" has no log in this deployment: ${message(error)}`)
    }
    return refused('unreadable', `session "${sessionId}" could not be read at seq ${seq}: ${message(error)}`)
  }
  const answered = window?.target as SessionEvent | undefined
  // A source that answers another event must not have that event's text rendered as this one's.
  if (answered === undefined || Number(answered.seq) !== seq) {
    return refused(
      'stale-reference',
      `session "${sessionId}" answered ${answered === undefined ? 'no event' : `seq ${String(answered.seq)}`} for the ` +
        `reference to seq ${seq}: a page of another event is not this event's text.`,
    )
  }
  const text = extractSessionEventText(answered)
  const total = utf8Bytes(text)
  const source = `session ${sessionId} via the session query, event seq ${seq} observed with ${total} UTF-8 bytes of visible text`
  if (total === 0) {
    // An event with no visible text has exactly one page, and it is offset 0's.
    if (offset !== 0) {
      return refused(
        'stale-reference',
        `event seq ${seq} of session "${sessionId}" has no visible text, so offset ${offset} is past the end of it; ` +
          'offset 0 is the only page of that event.',
      )
    }
    const empty: Utf8Slice = { text: '', nextOffset: 0, done: true }
    return read(sessionEventPage(ref, 0, empty), source, { hasMore: false, nextOffset: 0 })
  }
  if (offset >= total) {
    return refused(
      'stale-reference',
      `offset ${offset} is at or past the end of the visible text of event seq ${seq} of session "${sessionId}", which is ` +
        `${total} UTF-8 bytes: this page would carry nothing.`,
    )
  }
  if (!onCharacterBoundary(text, offset)) {
    return refused(
      'stale-reference',
      `offset ${offset} falls inside a UTF-8 character of the visible text of event seq ${seq} of session "${sessionId}"; ` +
        'an offset is a character boundary, and a page never starts with a fragment of a character.',
    )
  }
  // The page is sized against the JSON the model receives, not the raw fragment:
  // escapes widen a fragment, so the raw budget is shrunk until the page fits.
  let pageBytes = limit
  let slice = sliceUtf8(text, offset, pageBytes)
  let page = sessionEventPage(ref, offset, slice)
  while (utf8Bytes(page) > CONTEXT_OUTPUT_LIMIT_BYTES && pageBytes > 1) {
    const fitted = Math.floor((utf8Bytes(slice.text) * CONTEXT_OUTPUT_LIMIT_BYTES) / utf8Bytes(page))
    pageBytes = Math.max(1, Math.min(pageBytes - 1, fitted))
    slice = sliceUtf8(text, offset, pageBytes)
    page = sessionEventPage(ref, offset, slice)
  }
  return read(page, source, { hasMore: !slice.done, nextOffset: slice.nextOffset })
}
