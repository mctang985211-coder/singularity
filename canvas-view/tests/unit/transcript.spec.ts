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

let transcriptRows!: TranscriptRows
runInNewContext(readFileSync(new URL('../../src/frontend/client.js', import.meta.url), 'utf8'), {
  window: {
    __ModuleLoader__: {
      load: ({ factory }: { factory: () => { transcriptRows: TranscriptRows } }) => {
        transcriptRows = factory().transcriptRows
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
