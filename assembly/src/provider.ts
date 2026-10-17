import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'

/** The one provider retry policy: DSH's exponential shape, capped at three minutes. */
export const PROVIDER_RETRY = { limit: 20, initialDelayMs: 500, maxDelayMs: 180_000, jitterRatio: 0.1 } as const

/** Jittered exponential wait: `min(initialDelayMs × 2^(retry-1), maxDelayMs)`, the host policy's own shape. */
export function providerRetryDelay(retry: number, random: () => number = Math.random): number {
  const exponential = Math.min(PROVIDER_RETRY.initialDelayMs * 2 ** Math.min(retry - 1, 1024), PROVIDER_RETRY.maxDelayMs)
  const jitter = 1 - PROVIDER_RETRY.jitterRatio + 2 * PROVIDER_RETRY.jitterRatio * random()
  return Math.min(exponential * jitter, PROVIDER_RETRY.maxDelayMs)
}

/** True for a wait this policy can schedule; tests collapse exactly these timers. */
export function isProviderRetryDelay(delayMs: unknown): boolean {
  return typeof delayMs === 'number' && delayMs >= PROVIDER_RETRY.initialDelayMs * (1 - PROVIDER_RETRY.jitterRatio) &&
    delayMs <= PROVIDER_RETRY.maxDelayMs
}

/** Non-serializable hooks used to make the jittered schedule deterministic in tests. */
export interface ProviderRetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  readonly random?: () => number
}

/** One policy for every model stream, including calls outside the agent loop. */
export function mountProviderCalls(ctx: Context, stopped: () => AbortSignal,
  unavailable: () => Promise<void>, internals: ProviderRetryInternals = {}): void {
  const replay = new AsyncLocalStorage<GenerateOptions>()
  ctx.on('llm/stream', async function* (options, next) {
    if (replay.getStore() === options) return yield* next()
    const signal = AbortSignal.any([stopped(), ...(options.signal === undefined ? [] : [options.signal])])
    const retryId = randomUUID() as RetryId
    for (let retry = 0; retry <= PROVIDER_RETRY.limit; retry++) {
      signal.throwIfAborted()
      const chunks: StreamChunk[] = []
      const attempt = new AssistantStreamAccumulator()
      let complete = false
      try {
        const request = { ...options, signal }
        await replay.run(request, async () => {
          // Each attempt gets its own cancellable native dispatch and accumulator.
          const stream = ctx.llm.stream(request)
          for await (const chunk of stream) {
            signal.throwIfAborted()
            chunks.push(chunk)
            attempt.push({ time: Date.now(), chunk })
            if (chunk.type === 'finish') complete = chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted'
          }
        })
      } catch {
        signal.throwIfAborted()
        complete = false
      }
      signal.throwIfAborted()
      if (complete) { yield* chunks; return }
      const delayMs = providerRetryDelay(retry + 1, internals.random ?? Math.random)
      // Retain failed conversation attempts for DSH's native tokenUsage projection.
      const session = isAgentLoopRequest(options) && options.sessionId !== undefined ? ctx.sessions.get(options.sessionId) : undefined
      let step: SessionEvent<'step/start'>['data'] | undefined
      if (session !== undefined) {
        for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
          const event = session.eventAt(SessionSeq(seq))!
          if (event.type === 'step/start') { step = event.data; break }
        }
        session.append('assistant/attempt', { ...step!, stream: [...attempt.snapshot()] })
        if (retry < PROVIDER_RETRY.limit) session.append('llm/retry', { ...step!, retryId, provider: options.provider,
          mode: 'normal', policyKey: `singularity:${PROVIDER_RETRY.initialDelayMs}:${PROVIDER_RETRY.maxDelayMs}:${PROVIDER_RETRY.limit}`,
          retry: retry + 1, maxRetries: PROVIDER_RETRY.limit, delayMs,
          failure: { code: 'PROVIDER_UNSTABLE', message: 'provider 不稳定' } })
        if (!(await ctx.sessions.flush(session))) throw new Error('Provider attempt has no native durability listener')
      }
      signal.throwIfAborted()
      if (retry < PROVIDER_RETRY.limit) {
        ctx.logger.warn(`provider call failed; retry ${retry + 1}/${PROVIDER_RETRY.limit} in ${Math.round(delayMs / 1000)}s`)
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(signal.reason) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, delayMs)
          signal.addEventListener('abort', cancel, { once: true })
        })
        if (session !== undefined) session.append('llm/retry-started', { ...step!, retry: retry + 1, retryId })
      }
    }
    await unavailable()
    throw new Error('provider 不稳定；整张图已结束')
  })
}
