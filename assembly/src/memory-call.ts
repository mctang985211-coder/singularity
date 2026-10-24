import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  AssistantStreamAccumulator,
  type AssistantStreamRecord,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { record, nonEmpty } from './shape.ts'

export const parentMemoryCall = new AsyncLocalStorage<string>()
export type MemoryCall = { readonly memoryId: string } & (
  | {
      readonly phase: 'started'
      readonly provider: string
      readonly model: string
      readonly maxTokens?: number
      readonly inputDigest: string
      readonly sourceEventCount: number
      readonly instruction: RequestMessage
    }
  | {
      readonly phase: 'settled'
      readonly callSeq: number
      readonly dispatched: boolean
      readonly stream: readonly AssistantStreamRecord[]
    }
)
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'singularity/memory-call': MemoryCall
  }
}

/** Preserve parent checkpoint provenance in its owning native session. */
export function mountMemoryCalls(ctx: Context) {
  return {
    stream: async function* (
      options: GenerateOptions,
      next: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> {
      const sessionId = String(options.sessionId),
        session = ctx.sessions.get(SessionId(sessionId))!
      const memoryId = parentMemoryCall.getStore()
      if (memoryId === undefined) refuse('illegal-transition', 'parent checkpoint call has no owner')
      const instruction = options.messages.at(-1)!
      const started = session.append(
        'singularity/memory-call',
        {
          memoryId,
          phase: 'started',
          provider: options.provider,
          model: options.model,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          inputDigest: digestOf({
            messages: options.messages,
            ...(options.tools === undefined ? {} : { tools: options.tools }),
          }),
          sourceEventCount: Number(session.seq),
          instruction,
        },
        { ignorable: true },
      )
      const durable = async () => {
        if (!(await ctx.sessions.flush(session)))
          refuse('write-not-durable', 'memory call has no native durability listener')
      }
      const stream = new AssistantStreamAccumulator()
      let dispatched = false
      try {
        await durable()
        options.signal?.throwIfAborted()
        dispatched = true
        for await (const chunk of next()) {
          stream.push({ time: Date.now(), chunk })
          yield chunk
        }
      } finally {
        session.append(
          'singularity/memory-call',
          {
            memoryId,
            phase: 'settled',
            callSeq: Number(started.seq),
            dispatched,
            stream: stream.snapshot(),
          },
          { ignorable: true },
        )
        await durable()
      }
    },
  }
}

export function memoryCallsOf(events: readonly SessionEvent[]): readonly SessionEvent<'singularity/memory-call'>[] {
  const calls = events.filter(
    (event): event is SessionEvent<'singularity/memory-call'> => event.type === 'singularity/memory-call',
  )
  const started = new Map<number, SessionEvent<'singularity/memory-call'>>()
  const settled = new Set<number>()
  for (const event of calls) {
    const at = `memory call ${event.seq}`,
      data = record(event.data, at)
    nonEmpty(data['memoryId'], `${at}.memoryId`)
    if (event.ignorable !== true) refuse('malformed-declaration', `${at} must be explicitly log-only and ignorable`)
    if (event.data.phase === 'started') {
      assertClosedKeys(
        data,
        ['memoryId', 'phase', 'provider', 'model', 'maxTokens', 'inputDigest', 'sourceEventCount', 'instruction'],
        at,
      )
      nonEmpty(data['provider'], `${at}.provider`)
      nonEmpty(data['model'], `${at}.model`)
      if (typeof data['inputDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(data['inputDigest']))
        refuse('malformed-declaration', `${at}.inputDigest must be a sha256 digest`)
      if (data['sourceEventCount'] !== Number(event.seq))
        refuse('malformed-declaration', `${at} must bind its exact pre-call source prefix`)
      if (
        data['maxTokens'] !== undefined &&
        (!Number.isSafeInteger(data['maxTokens']) || Number(data['maxTokens']) < 1)
      )
        refuse('malformed-declaration', `${at}.maxTokens must be a positive safe integer`)
      const instruction = record(data['instruction'], `${at}.instruction`)
      if (instruction['role'] !== 'user' || !Array.isArray(instruction['content']))
        refuse('malformed-declaration', `${at}.instruction must be the appended user message`)
      started.set(Number(event.seq), event)
    } else if (event.data.phase === 'settled') {
      assertClosedKeys(data, ['memoryId', 'phase', 'callSeq', 'dispatched', 'stream'], at)
      const call = started.get(event.data.callSeq)
      if (
        !Number.isSafeInteger(event.data.callSeq) ||
        event.data.callSeq >= Number(event.seq) ||
        call === undefined ||
        call.data.memoryId !== event.data.memoryId ||
        settled.has(event.data.callSeq)
      )
        refuse('malformed-declaration', `${at} must settle exactly one earlier call for its summary owner`)
      if (!Array.isArray(event.data.stream))
        refuse('malformed-declaration', `${at}.stream must contain the exact timed provider stream`)
      if (typeof event.data.dispatched !== 'boolean' || (!event.data.dispatched && event.data.stream.length !== 0))
        refuse('malformed-declaration', `${at} must distinguish dispatch from an empty pre-call failure`)
      settled.add(event.data.callSeq)
    } else refuse('malformed-declaration', `${at}.phase must be started or settled`)
  }
  return calls
}
