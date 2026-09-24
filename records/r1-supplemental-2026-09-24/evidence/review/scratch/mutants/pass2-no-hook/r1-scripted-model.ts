/**
 * A scripted model provider for the R1 stack: the model output stands in, and
 * nothing else does.
 *
 * This module replaces exactly one thing — the provider's answers. The chunk
 * builders are the repository's own (`agent-loop/tests/mock-adapter.ts`), so a
 * scripted tool call reaches the real loop as the shape the loop's own tests
 * use, and the adapter class extends the same built `LlmAdapter` the deployment
 * registers. Everything the scripted run then exercises — `hitl_ask`, the
 * `userQuestions` seam, the session log, `TaskRuntime`, the verifier — is the
 * production code, which is why a criteria/fixture validation can be driven
 * here without a network call.
 *
 * The requests themselves are recorded: their messages are what the loop really
 * sent, which is how a spec reads back that a tool result reached the model
 * instead of assuming it.
 */

import { toolCallResponse, textResponse } from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { GenerateOptions, Message, StreamChunk } from '../../../../../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { LlmAdapter } from '../../../../../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'

/** One scripted model answer: a tool call, a final text, a latch, or a hang. */
export type ScriptEntry =
  | { readonly tool: string; readonly args?: Readonly<Record<string, unknown>> }
  | { readonly text: string }
  /** Block this request until the latch resolves, then answer from the next entry. */
  | { readonly waitFor: () => Promise<void> }
  /** Answer nothing and never finish: the request stays in flight until its turn is cancelled. */
  | { readonly hang: true }

/** One model request the adapter answered, with the texts the loop would have sent. */
export interface ScriptedRequest {
  readonly options: GenerateOptions
  /** Every text block of the request's messages, in message order. */
  readonly texts: readonly string[]
}

/** Every text block of one request's messages, in message order. */
function requestTexts(messages: readonly Message[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'text') texts.push(block.text)
  }
  return texts
}

/**
 * The scripted provider: one script per session, consumed one request at a
 * time. An exhausted script answers an empty text, which ends the turn — the
 * scripted session has finished the work it was given.
 */
export class ScriptedModelAdapter extends LlmAdapter {
  private readonly requests = new Map<string, ScriptedRequest[]>()
  private readonly queues = new Map<string, ScriptEntry[]>()
  private callSeq = 0

  /**
   * @param script - the script of one session; index 0 is the primary root, 1..n the spawned sessions in spawn order.
   * @param indexOf - the session index the script is keyed by.
   */
  constructor(
    private readonly script: (sessionId: string, index: number) => readonly ScriptEntry[],
    private readonly indexOf: (sessionId: string) => number,
  ) {
    super()
  }

  /** Every request this adapter served for one session, in order. */
  requestsOf(sessionId: string): readonly ScriptedRequest[] {
    return this.requests.get(sessionId) ?? []
  }

  private queueFor(sessionId: string): ScriptEntry[] {
    const existing = this.queues.get(sessionId)
    if (existing !== undefined) return existing
    const created = [...this.script(sessionId, this.indexOf(sessionId))]
    this.queues.set(sessionId, created)
    return created
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queueFor(sessionId)
    const recorded = this.requests.get(sessionId) ?? []
    recorded.push({ options, texts: requestTexts(options.messages) })
    this.requests.set(sessionId, recorded)

    let entry: ScriptEntry | undefined
    for (;;) {
      entry = queue.shift()
      if (entry === undefined) break
      if ('waitFor' in entry) {
        await raceAbort(entry.waitFor(), options.signal)
        continue
      }
      break
    }
    if (entry === undefined) {
      yield* textResponse('')
      return
    }
    if ('hang' in entry) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'still working' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if ('text' in entry) {
      yield* textResponse(entry.text)
      return
    }
    this.callSeq += 1
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...(entry.args ?? {}) })
  }
}

/** Wait for one latch, or reject when the turn is cancelled: a parked request must not outlive its turn. */
async function raceAbort(latch: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await latch
  if (signal.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    void latch.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error as Error)
      },
    )
  })
}
