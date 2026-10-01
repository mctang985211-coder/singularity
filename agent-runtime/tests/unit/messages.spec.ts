/**
 * The delivery module's pure half (A4 §F.1): the message representation one
 * recorded identity becomes, the two body frames, and the fold that decides
 * whether a Session already holds an identity.
 *
 * These are asserted without a Context on purpose: the fold is DSH's durable
 * representation read back (`agent/inbox/spliced` replays plus history), and a
 * second derivation of it — for instance one that only looks at the pending
 * queue — is exactly the bug the integration spec's duplication counterexample
 * finds. The event values here are the shapes `Session.append` accepts, built by
 * hand so the fold's own rules are visible.
 */

import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  answerMessageText,
  messageAccepted,
  questionMessageText,
  relayMessage,
  toolCallRefIn,
} from '../../src/messages.ts'
import type { SessionOwnLog } from '../../src/messages.ts'

const TARGET = SessionId('s-parent')
const SENDER = SessionId('s-child')

/** One durable inbox splice, the only event that moves pending input. */
function splice(
  seq: number,
  data: { target: 'next-turn' | 'next-step'; start: number; removedCount?: number; inserted: readonly UserMessage[] },
): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: SessionSeq(seq), time: seq, data } as SessionEvent
}

/** One model-visible history entry. */
function history(seq: number, message: UserMessage): SessionEvent {
  return { type: 'user/message', seq: SessionSeq(seq), time: seq, data: message } as SessionEvent
}

/** One relayed message with a stable identity, as the module builds it. */
function relay(messageId: string, text = 'body'): UserMessage {
  return relayMessage({ targetSessionId: TARGET, senderSessionId: SENDER, messageId, text })
}

/** One `tool/call` event, the shape a citation names. */
function call(seq: number, callId: string): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: seq,
    data: { callId, name: 'task_ask_parent', arguments: '{}' },
  } as SessionEvent
}

/** One Session's own log: `inheritedEventCount` leading events came from the fork's ancestor. */
function ownLog(inheritedEventCount: number, events: readonly SessionEvent[]): SessionOwnLog {
  return { session: { id: SENDER }, inheritedEventCount, events }
}

describe('relayed message representation', () => {
  it('keeps the recorded identity and attributes the body to the sending Session, never to a person', () => {
    const message = relay('m-question-1', '[task-question q-1] what now?')

    expect(message.id).toBe('m-question-1')
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '[task-question q-1] what now?' }])
    expect(message.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: 's-child' })
    expect(message.source.kind).not.toBe('user')
  })

  it('freezes the message, so a delivered identity cannot be rewritten in place', () => {
    const message = relay('m-answer-1')

    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('stamps the question and the answer body with both stable identities', () => {
    expect(questionMessageText('q-abc', 'Which contract holds?')).toBe('[task-question q-abc] Which contract holds?')
    expect(answerMessageText('a-def', 'q-abc', 'The frozen one.')).toBe('[task-answer a-def for q-abc] The frozen one.')
  })
})

/**
 * The citation lookup one question call goes through (A4 §F.1): the body must be
 * read back from the *caller's own* `tool/call`, so the id it holds can only ever
 * name an event of its own Session suffix — a fork-inherited prefix belongs to
 * the Session this one descends from, and a call made there is not a call this
 * Session made.
 */
describe('the citation of one own tool call', () => {
  it('finds an id in the own suffix of the log', () => {
    const log = ownLog(2, [call(0, 'call-inherited'), call(1, 'call-other'), call(2, 'call-mine')])

    expect(toolCallRefIn(log, 'call-mine')).toEqual({ sessionId: SENDER, seq: 2 })
  })

  it('does not find an id that only the fork-inherited prefix holds', () => {
    const log = ownLog(2, [call(0, 'call-inherited'), call(1, 'call-also-inherited'), call(2, 'call-mine')])

    expect(toolCallRefIn(log, 'call-inherited')).toBeUndefined()
    expect(toolCallRefIn(log, 'call-also-inherited')).toBeUndefined()
    expect(toolCallRefIn(log, 'call-mine')).toEqual({ sessionId: SENDER, seq: 2 })
  })

  it('answers a duplicated id with its latest durable record, and an unknown one with nothing', () => {
    const log = ownLog(1, [call(0, 'call-inherited'), call(1, 'call-twice'), call(2, 'call-twice')])

    expect(toolCallRefIn(log, 'call-twice')).toEqual({ sessionId: SENDER, seq: 2 })
    expect(toolCallRefIn(log, 'call-never-made')).toBeUndefined()
  })
})

describe('the durable acceptance fold', () => {
  it('accepts an identity still pending in the inbox', () => {
    const events = [splice(0, { target: 'next-step', start: 0, inserted: [relay('m-1')] })]

    expect(messageAccepted(events, 'm-1')).toBe(true)
    expect(messageAccepted(events, 'm-other')).toBe(false)
  })

  it('accepts an identity that reached history', () => {
    const events = [history(0, relay('m-1'))]

    expect(messageAccepted(events, 'm-1')).toBe(true)
    expect(messageAccepted(events, 'm-other')).toBe(false)
  })

  it('refuses an identity a claim already removed and history never took', () => {
    const events = [
      splice(0, { target: 'next-step', start: 0, inserted: [relay('m-1')] }),
      splice(1, { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ]

    expect(messageAccepted(events, 'm-1')).toBe(false)
  })

  it('keeps a next-turn identity pending while only next-step input is claimed', () => {
    const events = [
      splice(0, { target: 'next-turn', start: 0, inserted: [relay('m-1')] }),
      splice(1, { target: 'next-step', start: 0, inserted: [] }),
    ]

    expect(messageAccepted(events, 'm-1')).toBe(true)
  })

  it('folds a claim of one identity without losing a second pending one', () => {
    const events = [
      splice(0, { target: 'next-step', start: 0, inserted: [relay('m-1'), relay('m-2')] }),
      splice(1, { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
    ]

    expect(messageAccepted(events, 'm-1')).toBe(false)
    expect(messageAccepted(events, 'm-2')).toBe(true)
  })

  it('replays splices by position, so an earlier insert is not lost by a later one', () => {
    const events = [
      splice(0, { target: 'next-turn', start: 0, inserted: [relay('m-1')] }),
      splice(1, { target: 'next-turn', start: 0, inserted: [relay('m-2')] }),
    ]

    expect(messageAccepted(events, 'm-1')).toBe(true)
    expect(messageAccepted(events, 'm-2')).toBe(true)
  })
})
