import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { digestOf } from '../../src/protocol/envelope.ts'
import { createExecution } from '../src/execution.ts'

const mounts: { readonly ctx: Context; readonly root: string }[] = []
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-transcript-'))
  const ctx = new Context()
  mounts.push({ ctx, root })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  new AgentRegistry(ctx)
  const sessions = new SessionStore(ctx)
  ctx.provide('tools', { guard: () => ctx.effect(() => () => undefined) })
  const session = sessions.create(SessionId('root'))
  const writer = await ctx.sessionPersistence.create(session.header)
  ctx.effect(() => () => writer.close())
  const agent = { id: session.id, session, ctx } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  let onFlush = () => undefined
  ctx.on(
    'session/flush',
    () => {
      onFlush()
    },
    { prepend: true },
  )
  return {
    ctx,
    session,
    writer,
    exec: { agent } as ToolRunContext,
    execution: createExecution(
      ctx,
      () => undefined,
      () => undefined,
    ),
    duringFlush: (callback: () => undefined) => {
      onFlush = callback
    },
  }
}

afterEach(async () => {
  for (const { ctx, root } of mounts.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

describe('the sealed transcript source', () => {
  it('uses a durable fixed prefix while the live log appends during flush, without taking another write lease', async () => {
    const h = await harness()
    const first = h.session.append('turn/start', { turn: 1 })
    h.duringFlush(() => {
      h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return undefined
    })
    const source = await h.execution.sealTranscript(h.exec)
    expect(source).toEqual({
      sessionId: 'root',
      eventCount: 1,
      digest: digestOf({ sessionId: 'root', eventCount: 1, events: [first] }),
    })
    expect(h.session.seq).toBe(2)
    expect((await h.writer.read()).events).toHaveLength(2)
    await h.writer.flush()
  })

  it('propagates a flush failure and never returns a content reference', async () => {
    const h = await harness()
    h.ctx.on('session/flush', async () => {
      throw new Error('checkpoint failed')
    })
    await expect(h.execution.sealTranscript(h.exec)).rejects.toThrow('checkpoint failed')
  })

  it('rejects storage that has not received the sealed live prefix', async () => {
    const h = await harness()
    h.session.append('turn/start', { turn: 1 })
    const read = await h.ctx.sessionPersistence.open(h.session.id, 'read')
    vi.spyOn(read, 'read').mockResolvedValue({ eventState: 'detached', events: [] })
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockResolvedValue(read)
    await expect(h.execution.sealTranscript(h.exec)).rejects.toThrow('write-not-durable')
  })

  it('rejects a noncontinuous transcript prefix', async () => {
    const h = await harness()
    const first = h.session.append('turn/start', { turn: 1 })
    const read = await h.ctx.sessionPersistence.open(h.session.id, 'read')
    vi.spyOn(read, 'read').mockResolvedValue({ eventState: 'detached', events: [{ ...first, seq: SessionSeq(2) }] })
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockResolvedValue(read)
    await expect(h.execution.sealTranscript(h.exec)).rejects.toThrow('seq mismatch')
  })

  it('propagates read-handle close failure', async () => {
    const h = await harness()
    const read = await h.ctx.sessionPersistence.open(h.session.id, 'read')
    const close = read.close.bind(read)
    vi.spyOn(read, 'close').mockImplementation(async () => {
      await close()
      throw new Error('read close failed')
    })
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockResolvedValue(read)
    await expect(h.execution.sealTranscript(h.exec)).rejects.toThrow('read close failed')
  })
})
