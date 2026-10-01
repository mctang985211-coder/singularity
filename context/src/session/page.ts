/** How one session event renders, and the lines a page owes around it. @module @dangosys/dsh-singularity-context/session-page */

import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CONTEXT_OUTPUT_LIMIT_BYTES, utf8Bytes, type Utf8Slice } from '../limits.ts'

/** The exact object reference one event is read with, as the listing hands it back and the tool spells it. */
export function eventReference(sessionId: string, seq: number): string {
  return `{"sessionId":${JSON.stringify(sessionId)},"seq":${seq}}`
}

/** The lines one event occupies in a listing: its head line, then its visible text line by line. */
export function eventLines(event: SessionEvent): string[] {
  const text = extractSessionEventText(event)
  const head = `- seq ${event.seq} | ${event.type} | ${new Date(event.time).toISOString()}`
  return text.length === 0 ? [head] : [head, ...text.split('\n').map(line => `  ${line}`)]
}

/** The UTF-8 size of the text one event carries. */
function eventTextBytes(event: SessionEvent): number {
  return utf8Bytes(extractSessionEventText(event))
}

/** The refusal of an event no listing page can carry, handing back the reference that reads it. */
export function oversizedEventDetail(sessionId: string, event: SessionEvent): string {
  const seq = Number(event.seq)
  return (
    `event seq ${seq} of session "${sessionId}" does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page (its visible text alone ` +
    `is ${eventTextBytes(event)} UTF-8 bytes); a session listing carries whole events — DSH's read unit — so this listing cannot ` +
    `render it whole, and none of its text is shown here. Read that event with \`context_read\` kind:"session" ` +
    `ref:${eventReference(sessionId, seq)}, whose pages are the UTF-8 bytes of its visible text. Asking this listing again with ` +
    `offset ${seq + 1} moves past the event and shows none of its text: that is the caller's explicit choice, not a way to read ` +
    'the body.'
  )
}

/** The line a page carries when it stops before an event that does not fit, naming it and the reference that reads it. */
export function notShownEventLine(sessionId: string, event: SessionEvent): string {
  const seq = Number(event.seq)
  return (
    `- the next event (seq ${seq}, ${eventTextBytes(event)} UTF-8 bytes of text) was not shown on this page: ` +
    `it does not fit the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte bound, so the page ends before it. Read that event with ` +
    `ref:${eventReference(sessionId, seq)} — its text pages in UTF-8 bytes.`
  )
}

/** The line the final page of an event carries: the listing continues at the event seq after this one. */
function eventEndNote(sessionId: string, seq: number): string {
  return (
    `the visible text of event seq ${seq} of session "${sessionId}" ends here; the listing of that session continues with ` +
    `\`context_read\` kind:"session" ref:"${sessionId}" offset = ${seq + 1} (the event seq after this one).`
  )
}

/** One event page as JSON — exactly the model-visible value, its `note` on the final page only. */
export function sessionEventPage(
  ref: { readonly sessionId: string; readonly seq: number },
  offset: number,
  slice: Utf8Slice,
): string {
  return JSON.stringify({
    sessionId: ref.sessionId,
    seq: ref.seq,
    offset,
    nextOffset: slice.nextOffset,
    hasMore: !slice.done,
    body: slice.text,
    ...(slice.done ? { note: eventEndNote(ref.sessionId, ref.seq) } : {}),
  })
}
