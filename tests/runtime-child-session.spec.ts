import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { closeAgentSession } from '../src/runtime/agent-session.ts'
import { openChildSession, type ChildSessionSeams } from '../src/runtime/child-session.ts'

const opened: string[] = []
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
afterEach(async () => {
  for (const id of opened.splice(0)) await closeAgentSession(id)
})

async function child(options: { idle?: Promise<void>; flush?: () => Promise<boolean>; post?: (message: UserMessage) => void } = {}) {
  const id = 'child-' + crypto.randomUUID()
  const calls: string[] = []
  const messages: UserMessage[] = []
  const native = Session.create(SessionId('singularity:agent:' + id))
  const agent = {
    id: native.id, session: native,
    followup: (message: UserMessage) => {
      calls.push('post')
      if (options.post !== undefined) options.post(message)
      messages.push(message)
    },
    whenIdle: () => { calls.push('wait'); return options.idle ?? Promise.resolve() },
    cancel: (cause: unknown, policy: unknown) => { calls.push('stop'); expect([cause, policy]).toEqual([{ kind: 'parent' }, { keepInbox: true }]) },
  } as unknown as Agent
  const seams = {
    sessionPersistence: { stat: async () => undefined } as unknown as SessionPersistence,
    sessions: { flush: async () => { calls.push('flush'); return options.flush === undefined ? true : options.flush() } } as unknown as SessionStore,
    agents: { create: async () => ({ agent, dispose: async () => { calls.push('close') } }) } as unknown as AgentRegistry,
    agentLoop: {}, agentPresets: { composeFrom: () => undefined },
  }
  const ports: ChildSessionSeams = { get: name => seams[name as keyof typeof seams] }
  const session = await openChildSession(ports, {
    agentId: id, cwd: '/tmp/task-' + id, parent: agent, model: { provider: 'test', model: 'model' }, compose: () => undefined,
  })
  opened.push(id)
  return { session, calls, messages }
}

describe('child session resource ports', () => {
  it('posts the exact identified message and returns before the child is idle', async () => {
    const pending = deferred()
    const live = await child({ idle: pending.promise })
    const message = createUserMessage({ content: [{ type: 'text', text: 'solve assigned Run' }], source: { kind: 'user' } })
    expect(live.session.post(message)).toBeUndefined()
    expect(live.messages).toEqual([message])
    expect(live.messages[0]).toBe(message)
    expect(live.calls).toEqual(['post'])
    live.session.stop()
    pending.resolve()
  })

  it('waits for quiescence before the durability barrier without creating input', async () => {
    const idle = deferred()
    const live = await child({ idle: idle.promise })
    const wait = live.session.wait()
    expect(live.calls).toEqual(['wait'])
    idle.resolve()
    await wait
    expect(live.calls).toEqual(['wait', 'flush'])
    expect(live.messages).toEqual([])
  })

  it('propagates synchronous inbox rejection without entering a resource wait', async () => {
    const error = new Error('inbox commit rejected')
    const live = await child({ post: () => { throw error } })
    const message = createUserMessage({ content: [], source: { kind: 'user' } })
    expect(() => live.session.post(message)).toThrow(error)
    expect(live.calls).toEqual(['post'])
  })

  it('propagates a failed idle wait without presenting it as quiescence', async () => {
    const idle = deferred()
    const live = await child({ idle: idle.promise })
    const wait = live.session.wait()
    idle.reject(new Error('driver failed'))
    await expect(wait).rejects.toThrow('driver failed')
    expect(live.calls).toEqual(['wait'])
  })

  it('refuses a quiescent session with no durability listener', async () => {
    const live = await child({ flush: async () => false })
    await expect(live.session.wait()).rejects.toMatchObject({ refusal: { code: 'write-not-durable' } })
  })

  it('propagates the owner durability failure', async () => {
    const live = await child({ flush: async () => { throw new Error('disk flush failed') } })
    await expect(live.session.wait()).rejects.toThrow('disk flush failed')
  })

  it('stops in flight work without waiting for it before the owner can close', async () => {
    const idle = deferred()
    const live = await child({ idle: idle.promise })
    live.session.stop()
    await closeAgentSession(live.session.agentId)
    expect(live.calls).toEqual(['stop', 'close'])
    idle.resolve()
  })
})
