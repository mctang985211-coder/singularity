import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Rows = { role: 'user' | 'assistant'; text: string }[]
type Inbox = { 'next-turn': unknown[]; 'next-step': unknown[] }
type TranscriptRows = (
  entries: unknown[],
  session: { pendingSubmissions: unknown[] },
  inbox: Inbox | undefined,
) => Rows
type Target = string | { parentSessionId: string; childSessionId: string; mode: string }
type SubagentTarget = (sessionId: string, parentSessionId: string | undefined, known: Target | undefined) => Target
type ReadOnlyChat = (snapshot: {
  subagent:
    | { address: { mode: 'one-shot' | 'continuable' | 'unknown' }; parentAvailable?: boolean }
    | null
}) => boolean

let transcriptRows!: TranscriptRows
let subagentTarget!: SubagentTarget
let readOnlyChat!: ReadOnlyChat
runInNewContext(readFileSync(new URL('../../src/frontend/client.js', import.meta.url), 'utf8'), {
  window: {
    __ModuleLoader__: {
      load: ({
        factory,
      }: {
        factory: () => {
          transcriptRows: TranscriptRows
          subagentTarget: SubagentTarget
          readOnlyChat: ReadOnlyChat
        }
      }) => {
        const exports = factory()
        transcriptRows = exports.transcriptRows
        subagentTarget = exports.subagentTarget
        readOnlyChat = exports.readOnlyChat
      },
    },
  },
})

function inbox(queue: unknown[] = [], steering: unknown[] = []): Inbox {
  return { 'next-turn': queue, 'next-step': steering }
}

function pending(requestId: string, placement: 'transcript' | 'queued' | 'steering' = 'queued') {
  return { requestId, placement, time: 0, text: 'follow up', attachments: [] }
}

function queued(id = 'message-1', rpcId: string | undefined = 'request-1', text = 'follow up') {
  return {
    id,
    role: 'user',
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
    content: [{ type: 'text', text }],
  }
}

function durable(rpcId?: string) {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'user', rpcId },
        content: [{ type: 'text', text: 'follow up' }],
      },
    },
  }
}

function live(attemptId: string, text: string) {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq: 1,
      time: 0,
      data: { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
    },
  }
}

describe('canvas transcript projection', () => {
  it('keeps a running-session submission visible throughout echo, inbox admission and durable handoff', () => {
    const expected = [{ role: 'user', text: 'follow up' }]
    expect(transcriptRows([], { pendingSubmissions: [pending('request-1')] }, inbox())).toEqual(expected)
    expect(
      transcriptRows([], { pendingSubmissions: [pending('request-1')] }, inbox([queued()])),
    ).toEqual(expected)
    expect(transcriptRows([], { pendingSubmissions: [] }, inbox([queued()]))).toEqual(expected)
    expect(
      transcriptRows([durable('request-1')], { pendingSubmissions: [pending('request-1')] }, inbox([queued()])),
    ).toEqual(expected)
    expect(transcriptRows([durable('request-1')], { pendingSubmissions: [] }, inbox())).toEqual(expected)
  })

  it('deduplicates the one-frame durable/echo overlap by request identity, not message text', () => {
    expect(
      transcriptRows([durable('request-1')], {
        pendingSubmissions: [pending('request-1', 'transcript'), pending('request-2', 'transcript')],
      }, inbox()),
    ).toEqual([
      { role: 'user', text: 'follow up' },
      { role: 'user', text: 'follow up' },
    ])
  })

  it('uses message identity for non-RPC inbox handoff and leaves non-user producers out', () => {
    expect(
      transcriptRows([durable()], { pendingSubmissions: [] }, inbox([queued('message-1', undefined)])),
    ).toEqual([{ role: 'user', text: 'follow up' }])
    const injected = { ...queued('message-2'), source: { kind: 'task' } }
    expect(transcriptRows([], { pendingSubmissions: [] }, inbox([injected]))).toEqual([])
  })

  it('renders the queued next-turn list before the steering next-step list', () => {
    expect(
      transcriptRows([], { pendingSubmissions: [] }, inbox(
        [queued('message-1', 'request-1', 'first')],
        [queued('message-2', 'request-2', 'steering')],
      )),
    ).toEqual([
      { role: 'user', text: 'first' },
      { role: 'user', text: 'steering' },
    ])
  })

  it('tolerates an inbox projection that has not arrived', () => {
    expect(transcriptRows([], { pendingSubmissions: [pending('request-1')] }, undefined)).toEqual([
      { role: 'user', text: 'follow up' },
    ])
  })

  it('shows the assistant while it is streaming', () => {
    expect(
      transcriptRows([live('attempt-1', 'Hello '), live('attempt-1', '**world**')], {
        pendingSubmissions: [],
      }, inbox()),
    ).toEqual([{ role: 'assistant', text: 'Hello **world**' }])
  })
})

describe('canvas chat target and composer rules', () => {
  it('keeps the bare id for a root or plain Session, even with a stray parent', () => {
    expect(subagentTarget('root-1', undefined, undefined)).toBe('root-1')
    expect(subagentTarget('plain-1', '', undefined)).toBe('plain-1')
  })

  it('opens a child under its durable parent address when the client cannot resolve one', () => {
    expect(subagentTarget('child-1', 'parent-1', undefined)).toEqual({
      parentSessionId: 'parent-1',
      childSessionId: 'child-1',
      mode: 'unknown',
    })
  })

  it('prefers the address the client already knows over the graph-edge parent', () => {
    const known = { parentSessionId: 'parent-2', childSessionId: 'child-1', mode: 'continuable' }
    expect(subagentTarget('child-1', 'parent-1', known)).toEqual(known)
  })

  it('locks the composer for one-shot, unknown-mode and parent-offline children only', () => {
    const snapshot = (mode: 'one-shot' | 'continuable' | 'unknown', parentAvailable?: boolean) => ({
      subagent: { address: { mode }, ...(parentAvailable === undefined ? {} : { parentAvailable }) },
    })
    expect(readOnlyChat({ subagent: null })).toBe(false)
    expect(readOnlyChat(snapshot('continuable'))).toBe(false)
    expect(readOnlyChat(snapshot('continuable', false))).toBe(true)
    expect(readOnlyChat(snapshot('one-shot'))).toBe(true)
    expect(readOnlyChat(snapshot('unknown'))).toBe(true)
  })
})
