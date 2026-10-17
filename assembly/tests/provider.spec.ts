import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { mountProviderCalls, providerRetryDelay, PROVIDER_RETRY } from '../src/provider.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class Provider extends LlmAdapter {
  calls: GenerateOptions[] = []
  failures = 0
  throws = false
  incomplete = false
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.calls.length <= this.failures) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'discard this partial attempt' }
      if (this.throws) throw new Error('arbitrary provider exception')
      if (!this.incomplete) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ANY_PROVIDER_CODE', message: 'provider failed' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'complete response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture() {
  vi.useFakeTimers()
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const provider = new Provider(), controller = new AbortController()
  ctx.llm.registerAdapter(['provider-test'], provider)
  const unavailable = vi.fn(async () => { controller.abort(new Error('graph stopped')) })
  mountProviderCalls(ctx, () => controller.signal, unavailable, { random: () => 0.5 })
  const request: GenerateOptions = { provider: 'provider-test', model: 'test', messages: [] }
  const collect = async (options = request) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
    return chunks
  }
  return { ctx, provider, controller, unavailable, request, collect }
}

it.each(['stream error', 'throw', 'incomplete'])('retries every %s exactly twenty times with exponential backoff capped at three minutes', async kind => {
  const h = await fixture(); h.provider.failures = Infinity
  h.provider.throws = kind === 'throw'; h.provider.incomplete = kind === 'incomplete'
  const done = expect(h.collect()).rejects.toThrow('provider 不稳定')
  const schedule = (retry: number) => providerRetryDelay(retry, () => 0.5)
  expect(schedule(1)).toBe(PROVIDER_RETRY.initialDelayMs)
  expect(schedule(9)).toBe(128_000)
  expect(schedule(10)).toBe(PROVIDER_RETRY.maxDelayMs)
  expect(schedule(PROVIDER_RETRY.limit)).toBe(PROVIDER_RETRY.maxDelayMs)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.provider.calls).toHaveLength(1)
  for (let retry = 1; retry <= PROVIDER_RETRY.limit; retry++) {
    const delay = schedule(retry)
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(h.provider.calls).toHaveLength(retry)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.provider.calls).toHaveLength(retry + 1)
  }
  await done
  expect(h.unavailable).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([undefined, 'compaction', 'session-title'] as const)('retries raw %s calls and discards failed partial output', async purpose => {
  const h = await fixture(); h.provider.failures = 2
  const pending = h.collect({ ...h.request, ...(purpose === undefined ? {} : { purpose }) })
  await vi.advanceTimersByTimeAsync(600_000)
  const chunks = await pending
  expect(h.provider.calls).toHaveLength(3)
  expect(JSON.stringify(chunks)).not.toContain('discard this partial attempt')
  expect(JSON.stringify(chunks)).toContain('complete response')
  expect(h.unavailable).not.toHaveBeenCalled()
  h.provider.failures = 4
  const again = h.collect()
  await vi.advanceTimersByTimeAsync(300_000)
  await again
  expect(h.provider.calls).toHaveLength(5)
})

it('cancels a retry wait without declaring provider instability', async () => {
  const h = await fixture(); h.provider.failures = Infinity
  const cancel = new AbortController()
  const done = expect(h.collect({ ...h.request, signal: cancel.signal })).rejects.toThrow('user stopped')
  await vi.advanceTimersByTimeAsync(0)
  cancel.abort(new Error('user stopped'))
  await done
  await vi.advanceTimersByTimeAsync(6_000_000)
  expect(h.provider.calls).toHaveLength(1)
  expect(h.unavailable).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('passes graph cancellation to an active raw model call', async () => {
  const h = await fixture()
  h.provider.stream = async function* (options) {
    h.provider.calls.push(options)
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const done = expect(h.collect()).rejects.toThrow('other call stopped the graph')
  await vi.advanceTimersByTimeAsync(0)
  h.controller.abort(new Error('other call stopped the graph'))
  await done
  expect(h.provider.calls).toHaveLength(1)
  expect(h.unavailable).not.toHaveBeenCalled()
})

it('stops parallel failed calls once and cancels every remaining retry timer', async () => {
  const h = await fixture(); h.provider.failures = Infinity
  const pending = Promise.allSettled([h.collect(), h.collect()])
  await vi.advanceTimersByTimeAsync(6_000_000)
  expect((await pending).every(result => result.status === 'rejected')).toBe(true)
  expect(h.unavailable).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('covers the native prepared-call entry without redispatching its one-shot handle', async () => {
  const h = await fixture(); h.provider.failures = 1
  const prepared = await h.ctx.llm.prepareCall({ provider: 'provider-test', model: 'test' })
  const pending = (async () => {
    const chunks = []
    for await (const chunk of prepared.stream({ ...h.request, ...prepared.config })) chunks.push(chunk)
    return chunks
  })()
  await vi.advanceTimersByTimeAsync(300_000)
  expect(JSON.stringify(await pending)).toContain('complete response')
  expect(h.provider.calls).toHaveLength(2)
})
