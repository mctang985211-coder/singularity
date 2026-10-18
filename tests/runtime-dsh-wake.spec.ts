import { hostInstall } from '../scripts/host-config.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context, type Plugin } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

const installed = hostInstall()
const resolveInstalled = createRequire(join(installed, 'resolve.cjs'))
const { SystemPrompt } = await import(pathToFileURL(resolveInstalled.resolve('@deepseek-ai/dsh-system-prompt')).href) as typeof import('@deepseek-ai/dsh-system-prompt')
const { SessionProjectionRegistry } = await import(pathToFileURL(resolveInstalled.resolve('@deepseek-ai/dsh-session-projection')).href) as { SessionProjectionRegistry: Plugin<void> }
const checkpoint = await import(pathToFileURL(resolveInstalled.resolve('@deepseek-ai/dsh-session-checkpoint-policy')).href) as Plugin<void>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class RecordedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const live: { context: Context; root: string }[] = []
afterEach(async () => {
  for (const deployment of live.splice(0)) {
    try { await deployment.context.fiber.dispose() }
    finally { await rm(deployment.root, { recursive: true, force: true }) }
  }
})

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-dsh-wake-'))
  const context = new Context()
  live.push({ root, context })
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await context.plugin(SessionStore)
  await context.plugin(AgentRegistry)
  await context.plugin(LlmRuntime)
  await context.plugin(SystemPrompt, {})
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(ToolRuntime, {})
  await context.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  await context.plugin(checkpoint)
  const adapter = new RecordedAdapter()
  context.llm.registerAdapter(['wake-test'], adapter)
  return { context, adapter }
}

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function seedPending(context: Context, input: UserMessage, target: 'next-turn' | 'next-step' = 'next-turn') {
  const id = SessionId('wake-' + crypto.randomUUID())
  const detached = Session.create(id)
  const event = detached.append('agent/inbox/spliced', { target, start: 0, inserted: [input] })
  const handle = await context.sessionPersistence.create(detached.header)
  try { await handle.append([event]); await handle.flush() }
  finally { await handle.close() }
  return context.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'wake-test', model: 'fixture' } })
}

async function eventsOf(context: Context, agent: Agent): Promise<readonly SessionEvent[]> {
  expect(await context.sessions.flush(agent.session)).toBe(true)
  const read = await context.sessionPersistence.open(agent.session.id, 'read')
  try { return (await read.read()).events }
  finally { await read.close() }
}

describe('the private DSH pending-only wake port', () => {
  it.each(['next-turn', 'next-step'] as const)('resumes durable %s input with the original identity, once', async target => {
    const { context, adapter } = await runtime()
    const input = message('resume this pending work')
    const handle = await seedPending(context, input, target)
    expect(handle.agent.status).toBe('idle')
    expect(adapter.calls).toHaveLength(0)
    handle.agent.wake()
    handle.agent.wake()
    await handle.agent.whenIdle()
    const events = await eventsOf(context, handle.agent)
    expect(events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)).toEqual([input])
    expect(events.filter(event => event.type === 'user/message').map(event => event.data)).toEqual([input])
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
    expect(adapter.calls).toHaveLength(1)
    expect([handle.agent.inbox.nextTurn, handle.agent.inbox.nextStep]).toEqual([[], []])
    await handle.dispose()
  })

  it('does not create an empty turn when the inbox is empty', async () => {
    const { context, adapter } = await runtime()
    const handle = await context.agents.create({ sessionId: SessionId('empty-wake') })
    const before = Number(handle.agent.session.seq)
    handle.agent.wake()
    await handle.agent.whenIdle()
    expect(Number(handle.agent.session.seq)).toBe(before)
    expect(adapter.calls).toHaveLength(0)
    await handle.dispose()
  })

  it('releases existing input behind maintenance without re-enqueuing it', async () => {
    const { context, adapter } = await runtime()
    const input = message('held by maintenance')
    const handle = await seedPending(context, input)
    const release = deferred()
    const maintenance = handle.agent.runMaintenance(() => release.promise)
    try {
      handle.agent.wake()
      expect(adapter.calls).toHaveLength(0)
    } finally { release.resolve() }
    await maintenance
    await handle.agent.whenIdle()
    expect(adapter.calls).toHaveLength(1)
    const events = await eventsOf(context, handle.agent)
    expect(events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)).toEqual([input])
    await handle.dispose()
  })

  it('uses the existing checkpoint policy to reject before provider dispatch on flush failure', async () => {
    const { context, adapter } = await runtime()
    const handle = await seedPending(context, message('must never dispatch'))
    const off = context.on('session/flush', () => { throw new Error('checkpoint disk failure') })
    handle.agent.wake()
    await handle.agent.whenIdle()
    expect(adapter.calls).toHaveLength(0)
    off()
    const events = await eventsOf(context, handle.agent)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['error'])
    await handle.dispose()
  })

  it('keeps input parked after a disposed cancellation', async () => {
    const { context, adapter } = await runtime()
    const input = message('pending while owner closes')
    const handle = await seedPending(context, input)
    const release = deferred()
    const maintenance = handle.agent.runMaintenance(() => release.promise)
    handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    try { handle.agent.wake() } finally { release.resolve() }
    await maintenance
    await handle.agent.whenIdle()
    expect(handle.agent.status).toBe('idle')
    expect(handle.agent.inbox.nextTurn).toEqual([input])
    expect(adapter.calls).toHaveLength(0)
    await handle.dispose()
  })

  it('closes pending input and releases the write lease before same-session resume', async () => {
    const { context, adapter } = await runtime()
    const input = message('pending at unload')
    const handle = await seedPending(context, input)
    const id = handle.agent.session.id
    await handle.dispose()
    expect(context.agents.get(id)).toBeUndefined()
    expect(context.sessions.get(id)).toBeUndefined()
    const resumed = await context.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'wake-test', model: 'fixture' } })
    expect([resumed.agent.inbox.nextTurn, resumed.agent.inbox.nextStep]).toEqual([[], []])
    resumed.agent.wake()
    await resumed.agent.whenIdle()
    expect(adapter.calls).toHaveLength(0)
    const events = await eventsOf(context, resumed.agent)
    expect(events.filter(event => event.type === 'agent/inbox/spliced').map(event => event.data.outcome)).toEqual([undefined, 'canceled'])
    await resumed.dispose()
  })

  it('latches existing pending input behind a canceled active turn', async () => {
    const { context, adapter } = await runtime()
    const handle = await seedPending(context, message('the canceled first claim'))
    const entered = deferred()
    const release = deferred()
    const off = context.on('agent/pre-step', async ({ agent }, next) => {
      if (agent !== handle.agent) return next()
      entered.resolve()
      await release.promise
      return next()
    })
    handle.agent.wake()
    try {
      await entered.promise
      const input = message('the pending second turn')
      handle.agent.send(input, 'next-turn', false)
      handle.agent.cancel({ kind: 'parent' }, { keepInbox: true })
      handle.agent.wake()
    } finally { release.resolve() }
    await handle.agent.whenIdle()
    off()
    expect(adapter.calls).toHaveLength(1)
    const events = await eventsOf(context, handle.agent)
    expect(events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)).toHaveLength(2)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted', 'completed'])
    expect(events.filter(event => event.type === 'user/message').map(event => event.data.content)).toEqual([[{ type: 'text', text: 'the pending second turn' }]])
    await handle.dispose()
  })
})
