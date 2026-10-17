import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { mountCampaignMemory } from '../src/index.ts'
import { mountProviderCalls, isProviderRetryDelay } from '../src/provider.ts'
import { projectedTokenUsage, billedTokens } from '../src/evaluation-cost.ts'
import type { Apparatus } from '../src/apparatus.ts'

const nativeRequire = createRequire('/home/ROXY/singularity-next/dsh/node_modules/@deepseek-ai/dsh-agent-loop/package.json')
const { default: SystemPrompt } = await import(nativeRequire.resolve('@deepseek-ai/dsh-system-prompt')) as typeof import('@deepseek-ai/dsh-system-prompt')
const { default: SessionProjections } = await import(nativeRequire.resolve('@deepseek-ai/dsh-session-projection')) as typeof import('@deepseek-ai/dsh-session-projection')
const { default: BasicCompaction } = await import(nativeRequire.resolve('@deepseek-ai/dsh-compaction-basic')) as typeof import('@deepseek-ai/dsh-compaction-basic')
const { default: TokenMeter } = await import(nativeRequire.resolve('@deepseek-ai/dsh-token-meter')) as typeof import('@deepseek-ai/dsh-token-meter')
let ctx: Context | undefined, directory: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  ctx = undefined; directory = undefined
})

class UsageAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  reportUsage = false
  sample: TokenUsage = { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 200_000 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Completed observation.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed observation.' } }
    if (this.reportUsage) yield { type: 'usage', usage: this.sample }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'usage-native-'))
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  mountCampaignMemory(ctx)
  const adapter = new UsageAdapter()
  ctx.llm.registerAdapter(['usage-test'], adapter)
  const root = await ctx.agentLoop.create(SessionId('root'), { provider: 'usage-test', model: 'test', maxTokens: 10 })
  const peer = await ctx.agentLoop.create(SessionId('peer'), { provider: 'usage-test', model: 'test', maxTokens: 10 })
  const send = async (agent = root) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the assigned work. '.repeat(400) }] }))
    await agent.whenIdle()
    expect(await ctx!.sessions.flush(agent.session)).toBe(true)
  }
  const events = async () => {
    const handle = await ctx!.sessionPersistence.open(root.session.id, 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  }
  const usage = () => ctx!.sessionProjections.snapshot(root.session, ['tokenUsage']).values.tokenUsage!
  return { ctx, adapter, root, peer, send, events, usage }
}

it('continues the same native session and peers after missing usage, with no campaign cap or cancellation', async () => {
  const h = await fixture(), rootCancelled = vi.spyOn(h.root, 'cancel'), peerCancelled = vi.spyOn(h.peer, 'cancel')
  await h.send()
  expect(h.usage()).toEqual({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  h.adapter.reportUsage = true
  await Promise.all([h.send(), h.send(h.peer)])
  await h.send()
  expect(h.adapter.requests.filter(request => request.sessionId === h.root.session.id)).toHaveLength(3)
  expect(h.adapter.requests.every(request => request.maxTokens === 10)).toBe(true)
  expect(rootCancelled).not.toHaveBeenCalled()
  expect(peerCancelled).not.toHaveBeenCalled()
  expect(h.usage()).toEqual({ uncachedInputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

it('counts retried provider attempts through the native token-meter projection', async () => {
  const h = await fixture()
  const timer = globalThis.setTimeout
  const fastTimer = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    timer(callback, isProviderRetryDelay(delay) ? 0 : delay, ...args)) as typeof setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(fastTimer)
  const original = h.adapter.stream.bind(h.adapter)
  let failed = 0
  h.adapter.reportUsage = true
  h.adapter.stream = async function* (options) {
    if (failed++ < 2) {
      yield { type: 'usage', usage: this.sample }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ANY', message: 'upstream failed' } } }
    } else yield* original(options)
  }
  const unavailable = vi.fn()
  const lifetime = new AbortController()
  mountProviderCalls(h.ctx, () => lifetime.signal, unavailable)
  try {
    await h.send()
    expect(h.usage()).toEqual({ uncachedInputTokens: 300, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect((await h.events()).filter(event => event.type === 'assistant/attempt')).toHaveLength(2)
    expect((await h.events()).filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(unavailable).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})

it('freezes exactly the tokenUsage view served to ui-chat, including native compaction semantics', async () => {
  const h = await fixture()
  h.adapter.reportUsage = true
  await h.send(); await h.send()
  await h.root.ctx.plugin(BasicCompaction, { retainTokens: 0 })
  await (h.root.ctx.get('compaction') as Context['compaction']).compactNow(h.root, new AbortController().signal)
  expect(await h.ctx.sessions.flush(h.root.session)).toBe(true)
  const events = await h.events()
  expect(events.some(event => event.type === 'compaction/summary')).toBe(true)
  expect(events.filter(event => event.type === 'singularity/memory-call')).toEqual([])
  const handle = await h.ctx.sessionPersistence.open(h.root.session.id, 'read')
  try {
    const frozen = projectedTokenUsage({ projections: h.ctx.sessionProjections } as Apparatus, handle, events)
    expect(frozen).toEqual(h.usage())
    expect(billedTokens(frozen)).toBe(210)
  } finally { await handle.close() }
  await h.send()
  expect(h.adapter.requests.at(-1)!.purpose).not.toBe('compaction')
})

it('uses the ui-chat total across native cache buckets and counts reasoning only inside output', async () => {
  const h = await fixture()
  h.adapter.reportUsage = true
  h.adapter.sample = { inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 5, reasoningTokens: 4, totalTokens: 999 }
  await h.send()
  expect(h.usage()).toEqual({ uncachedInputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 5 })
  expect(billedTokens(h.usage())).toBe(105)
})
