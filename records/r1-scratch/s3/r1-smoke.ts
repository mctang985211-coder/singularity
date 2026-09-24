/**
 * R1 smoke: one minimal real model call through the production `DeepSeekAdapter`
 * against the configured StepFun gateway, before any scenario runs. The fixed
 * contract gates everything on this: if the gateway is unreachable or the
 * credential is refused, the run is blocked and no scenario starts — no
 * scripted provider stands in.
 *
 * The smoke also answers the one accounting question the rest of the run
 * depends on: whether the gateway reports usage at all (a `usage` chunk), so
 * the token budget is measured on real numbers rather than assumed.
 */

import { Context } from '../../harness/thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import LlmRuntime, { createUserMessage } from '../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { StreamChunk } from '../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { DeepSeekAdapter, resolveAdapterOptions } from '../../harness/thirdparty/deepseek-harness/packages/llm/llm-deepseek/lib/index.js'
import { MODEL, PROVIDER, gateway, redact } from './r1-env.ts'

export interface SmokeResult {
  readonly ok: boolean
  readonly baseUrl: string
  readonly keyLength: number
  readonly model: string
  readonly text: string
  readonly finishReason?: unknown
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly error?: string
}

/** One minimal real call: 'ping', one response, usage counted from the adapter layer. */
export async function smokeCall(timeoutMs = 120_000): Promise<SmokeResult> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({
      protocol: 'chat-completions',
      baseURL: gateway.baseUrl,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'high',
      models: [{ id: MODEL, contextWindow: 128_000 }],
    }),
    resolveApiKey: async () => gateway.apiKey,
    resolveUserId: () => 'r1-smoke' as never,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('smoke timeout')), timeoutMs)
    const texts: string[] = []
    let finishReason: unknown
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    try {
      const chunks: AsyncIterable<StreamChunk> = ctx.llm.stream({
        provider: PROVIDER,
        model: MODEL,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
        sessionId: 's-smoke' as never,
        signal: controller.signal,
      })
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
        if (chunk.type === 'finish') finishReason = chunk.reason
        if (chunk.type === 'usage') {
          inputTokens = chunk.usage.inputTokens
          outputTokens = chunk.usage.outputTokens
        }
      }
    } finally {
      clearTimeout(timer)
    }
    const text = redact(texts.join(''))
    if (finishReason === undefined) return { ok: false, baseUrl: gateway.baseUrl, keyLength: gateway.apiKey.length, model: MODEL, text, error: 'the stream ended without a finish chunk' }
    return { ok: true, baseUrl: gateway.baseUrl, keyLength: gateway.apiKey.length, model: MODEL, text, finishReason, inputTokens, outputTokens }
  } catch (error) {
    return { ok: false, baseUrl: gateway.baseUrl, keyLength: gateway.apiKey.length, model: MODEL, text: '', error: redact(error instanceof Error ? error.message : String(error)) }
  } finally {
    await ctx.fiber.dispose()
  }
}
