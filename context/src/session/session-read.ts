/** One session's log, paged by DSH event seq and by the output bound (A2 §D). @module @dangosys/dsh-singularity-context/session-read */

import { SESSION_QUERY_READ_WINDOW_MAX } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CallerResolution, LoadedCaller } from '../bindings/types.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES, OutputBudget, budgetList } from '../limits.ts'
import { errorCode, message, refused, read, type ProjectedRead } from '../refusals.ts'
import { sessionMembershipRefusal, SESSION_LIMIT_DEFAULT, SESSION_LIMIT_MAX } from '../reads/guards.ts'
import type { ReadDeps } from '../types.ts'
import { eventLines, notShownEventLine, oversizedEventDetail } from './page.ts'

/** One session page: events from `offset` (a DSH event seq) onward, whole events only. */
export async function sessionRead(
  deps: ReadDeps,
  loaded: LoadedCaller,
  sessionId: string,
  requestedOffset: number | undefined,
  requestedLimit: number | undefined,
  signal?: AbortSignal,
): Promise<ProjectedRead> {
  const resolution = loaded.resolution as Exclude<CallerResolution, { kind: 'unbound' }>
  signal?.throwIfAborted()
  const gate = await sessionMembershipRefusal(deps, loaded, sessionId)
  if (gate !== undefined) return gate
  const offset = Math.max(0, Math.trunc(requestedOffset ?? 0))
  const requestedEvents = Math.trunc(requestedLimit ?? SESSION_LIMIT_DEFAULT)
  const limit = Math.min(SESSION_LIMIT_MAX, Math.max(1, requestedEvents))
  const clamped = requestedEvents !== limit
  let capturedThroughSeq: number | null
  try {
    capturedThroughSeq = (await deps.sessionQuery.readSurface(sessionId)).capturedThroughSeq
  } catch (error) {
    signal?.throwIfAborted()
    const code = errorCode(error)
    if (code === 'SESSION_QUERY_ABORTED') throw error
    return code === 'SESSION_QUERY_SESSION_NOT_FOUND'
      ? refused('not-found', `session "${sessionId}" has no log in this deployment: ${message(error)}`)
      : refused('unreadable', `session "${sessionId}" could not be read: ${message(error)}`)
  }
  const banner = [
    `# context_read session ${sessionId}`,
    `graph "${resolution.graph.id}" — raw log through seq ${capturedThroughSeq ?? '(empty)'}; events from seq ${offset}, at most ${limit}` +
      (clamped ? ` (requested ${requestedEvents})` : ''),
  ]
  const source = `session ${sessionId} via the session query, one log observation through seq ${capturedThroughSeq ?? '(empty)'}`
  if (capturedThroughSeq === null || offset > capturedThroughSeq) {
    const note =
      capturedThroughSeq === null
        ? "(this session's log holds no events)"
        : '(the offset is at or past the end of the log)'
    return read([...banner, '', note].join('\n'), source, {
      hasMore: false,
      nextOffset: capturedThroughSeq === null ? 0 : capturedThroughSeq + 1,
    })
  }

  const events: SessionEvent[] = []
  let cursor = offset
  let asked = offset
  while (events.length < limit && cursor <= capturedThroughSeq) {
    asked = cursor
    let window: Awaited<ReturnType<ReadDeps['sessionQuery']['readEvent']>>
    try {
      window = await deps.sessionQuery.readEvent(
        {
          sessionId,
          seq: cursor,
          before: 0,
          after: Math.min(SESSION_QUERY_READ_WINDOW_MAX - 1, limit - events.length - 1),
        },
        signal,
      )
    } catch (error) {
      signal?.throwIfAborted()
      const code = errorCode(error)
      if (code === 'SESSION_QUERY_ABORTED') throw error
      // A window that fails once an earlier one has answered leaves the log half
      // read, and half a log is not a page: the caller is told the read failed.
      return events.length === 0
        ? refused(
            code === 'SESSION_QUERY_EVENT_NOT_FOUND' ? 'stale-reference' : 'unreadable',
            `session "${sessionId}" could not be read at seq ${cursor}: ${message(error)}`,
          )
        : refused(
            'unreadable',
            `session "${sessionId}" could not be read at seq ${cursor}, after the window at seq ${offset} answered: ${message(error)}. ` +
              `Nothing partial is returned: the ${events.length} event(s) the read had already collected are not reported as a page of this log.`,
          )
    }
    for (const event of window.events) {
      if (events.length >= limit) break
      events.push(event)
    }
    if (window.endSeq <= cursor) break
    cursor = window.endSeq + 1
  }
  if (events.length === 0) {
    // An empty page here would claim `hasMore` at the same offset and be read again forever.
    return refused(
      'unreadable',
      `session "${sessionId}" could not be read at seq ${asked}: the session query answered without advancing to an event, ` +
        'so nothing was read and an empty page would only repeat this offset. Nothing is returned in place of the events.',
    )
  }

  const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES)
  budget.addAll(banner)
  budget.addAll(['', `events: seq ${offset}..${cursor - 1} of a log through seq ${capturedThroughSeq}`])
  /** The closing lines a page with `shown` events owes: the stopped event, then where to continue. */
  const closing = (
    shown: number,
  ): { readonly lines: readonly string[]; readonly nextOffset: number; readonly hasMore: boolean } => {
    const lastShownSeq = Number((events[shown - 1] as SessionEvent).seq)
    const stopped = shown < events.length ? events[shown] : undefined
    // A page that stopped before an event continues at that event's own seq,
    // never at seq+1: skipping it is the caller's decision, not this read's.
    const nextOffset = stopped === undefined ? lastShownSeq + 1 : Number(stopped.seq)
    const hasMore = nextOffset <= capturedThroughSeq
    return {
      lines: [
        ...(stopped === undefined ? [] : [notShownEventLine(sessionId, stopped)]),
        `- events shown: ${shown} of at most ${limit}` +
          (hasMore ? ` · more follows from seq ${nextOffset}` : ' · end of the log'),
      ],
      nextOffset,
      hasMore,
    }
  }
  const shown = budgetList(budget, {
    units: events,
    lines: eventLines,
    tail: count => (count === 0 ? [] : closing(count).lines),
  })
  // A session offset addresses whole events, so an event that does not fit has
  // no second page inside the page: the first one is refused by name.
  if (shown === undefined || shown.length === 0) {
    return refused('context-too-large', oversizedEventDetail(sessionId, events[0] as SessionEvent))
  }
  const end = closing(shown.length)
  return read(
    budget.text(),
    `session ${sessionId} via the session query, seq ${offset}..${Number((shown[shown.length - 1] as SessionEvent).seq)} of a log through seq ${capturedThroughSeq}`,
    { hasMore: end.hasMore, nextOffset: end.nextOffset },
  )
}
