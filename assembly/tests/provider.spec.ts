import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  resolveRetryPolicy,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { hostRequire } from '../../scripts/host-config.mjs'

const nativeRequire = hostRequire()
const { default: SystemPrompt } = (await import(
  nativeRequire.resolve('@deepseek-ai/dsh-system-prompt')
)) as typeof import('@deepseek-ai/dsh-system-prompt')
const { default: SessionProjections } = (await import(
  nativeRequire.resolve('@deepseek-ai/dsh-session-projection')
)) as typeof import('@deepseek-ai/dsh-session-projection')
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class Provider extends LlmAdapter {
  calls: GenerateOptions[] = []
  failures = 0
  code = 'TRANSPORT'
  partial?: 'reasoning' | 'text' | 'tool-call'
  private readonly delayMs: number
  constructor(delayMs = 1) {
    super()
    this.delayMs = delayMs
  }
  override providerRetryPolicy() {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 20,
        backoff: { initialDelayMs: this.delayMs, maxDelayMs: this.delayMs, jitterRatio: 0 },
      },
      'provider fixture',
    )
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.calls.length <= this.failures) {
      if (this.partial === 'reasoning' || this.partial === 'text') {
        yield { type: 'block-start', index: 0, blockType: this.partial }
        yield {
          type: this.partial === 'reasoning' ? 'reasoning-delta' : 'text-delta',
          index: 0,
          text: 'discarded partial output',
        }
      } else if (this.partial === 'tool-call') {
        const id = ToolCallId('partial-tool')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'effect', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'effect', arguments: '{}' } }
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: this.code, message: 'terminated' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'complete response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(delayMs = 1) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRetry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const provider = new Provider(delayMs)
  const registration = ctx.llm.registerAdapter(['provider-test'], provider)
  const root = await ctx.agentLoop.create(SessionId('root'), { provider: 'provider-test', model: 'test' })
  const request: GenerateOptions = { provider: 'provider-test', model: 'test', messages: [] }
  const send = async () => {
    root.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }))
    await root.whenIdle()
  }
  const events = () => root.session.snapshotEvents()
  return { ctx, provider, registration, root, request, send, events }
}

it.each(['reasoning', 'text'] as const)(
  'lets native recovery retry TRANSPORT terminated after partial %s',
  async partial => {
    const h = await fixture()
    h.provider.failures = 1
    h.provider.partial = partial
    await h.send()
    expect(h.provider.calls).toHaveLength(2)
    expect(h.provider.calls[1]?.messages).toEqual(h.provider.calls[0]?.messages)
    expect(h.events().filter(event => event.type === 'llm/retry')).toMatchObject([
      { data: { retry: 1, failure: { code: 'TRANSPORT', message: 'terminated' } } },
    ])
    expect(h.events().filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(h.root.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'complete response' }],
    })
    expect(JSON.stringify(h.root.session.deriveMessages())).not.toContain('discarded partial output')
    expect(h.events().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  },
)

it('discards a failed partial tool call before native recovery without executing it', async () => {
  const h = await fixture(),
    execute = vi.fn(async () => 'done')
  h.ctx.tools.register(
    defineTool({
      name: 'effect',
      description: 'Record an effect.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute,
    }),
  )
  h.provider.failures = 1
  h.provider.partial = 'tool-call'
  await h.send()
  expect(h.provider.calls).toHaveLength(2)
  expect(execute).not.toHaveBeenCalled()
  expect(h.events().some(event => event.type === 'tool/call')).toBe(false)
  expect(h.events().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  expect(JSON.stringify(h.root.session.deriveMessages())).not.toContain('partial-tool')
  expect(JSON.stringify(h.provider.calls[1]?.messages)).not.toContain('partial-tool')
  expect(h.events().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
})

it('ends the native turn with the original failure after twenty retries', async () => {
  const h = await fixture()
  h.provider.failures = Infinity
  await h.send()
  expect(h.provider.calls).toHaveLength(21)
  expect(h.events().filter(event => event.type === 'llm/retry')).toHaveLength(20)
  expect(h.events().filter(event => event.type === 'assistant/attempt')).toHaveLength(21)
  expect(h.events().filter(event => event.type === 'assistant/message')).toHaveLength(0)
  expect(h.events().filter(event => event.type === 'step/start')).toHaveLength(1)
  expect(h.events().at(-1)).toMatchObject({
    type: 'turn/end',
    data: {
      reason: {
        kind: 'error',
        error: { code: 'TRANSPORT', message: 'terminated' },
      },
    },
  })
})

it('lets native cancellation interrupt retry backoff', async () => {
  const h = await fixture(500)
  h.provider.failures = Infinity
  const scheduled = new Promise<void>(resolve =>
    h.ctx.on('session/event', (session, event) => {
      if (session === h.root.session && event.type === 'llm/retry') resolve()
    }),
  )
  const pending = h.send()
  await scheduled
  h.root.cancel({ kind: 'user' })
  await pending
  expect(h.provider.calls).toHaveLength(1)
  expect(h.events().some(event => event.type === 'llm/retry-started')).toBe(false)
  expect(h.events().at(-1)).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
})

it('preserves a permanent AUTH failure without retrying', async () => {
  const h = await fixture()
  h.provider.failures = Infinity
  h.provider.code = 'AUTH'
  await h.send()
  expect(h.provider.calls).toHaveLength(1)
  expect(h.events().some(event => event.type === 'llm/retry')).toBe(false)
  expect(h.events().at(-1)).toMatchObject({
    type: 'turn/end',
    data: {
      reason: {
        kind: 'error',
        error: { code: 'AUTH', message: 'terminated' },
      },
    },
  })
})

it('leaves raw streams single-attempt under the native caller', async () => {
  const h = await fixture()
  h.provider.failures = Infinity
  const chunks: StreamChunk[] = []
  for await (const chunk of h.ctx.llm.stream(h.request)) chunks.push(chunk)
  expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } }])
  expect(h.provider.calls).toHaveLength(1)
  expect(h.events().some(event => event.type === 'llm/retry')).toBe(false)
})

it('keeps a prepared call bound to its original adapter without redispatch', async () => {
  const h = await fixture()
  const prepared = await h.ctx.llm.prepareCall({ provider: 'provider-test', model: 'test' })
  const replacement = new Provider()
  h.registration()
  h.ctx.llm.registerAdapter(['provider-test'], replacement)
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream({ ...h.request, ...prepared.config })) chunks.push(chunk)
  expect(JSON.stringify(chunks)).toContain('complete response')
  expect(h.provider.calls).toHaveLength(1)
  expect(replacement.calls).toHaveLength(0)
})
