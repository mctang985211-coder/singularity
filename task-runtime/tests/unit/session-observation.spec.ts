import { describe, expect, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TaskRuntime } from '../../src/index.ts'
import { observeSession } from '../../src/service/env.ts'

describe('recorded Skill loads', () => {
  test('counts only a successful result for the matching Skill call', async () => {
    const events = [
      { type: 'tool/call', data: { callId: 'ok', name: 'skill', arguments: '{"name":"loaded-method"}' } },
      { type: 'tool/call', data: { callId: 'failed', name: 'skill', arguments: '{"name":"failed-method"}' } },
      { type: 'tool/call', data: { callId: 'pending', name: 'skill', arguments: '{"name":"unresolved-method"}' } },
      { type: 'tool/call', data: { callId: 'empty', name: 'skill', arguments: '{"name":"unproven-method"}' } },
      { type: 'tool/result', data: { callId: 'empty' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'failed' }, isError: true } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'unrelated' }, isError: false } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'ok' }, isError: false } } },
    ] as unknown as SessionEvent[]
    const runtime = { softService: (name: string) => name === 'sessionQuery'
      ? { readSession: async () => ({ events }) } : undefined } as unknown as TaskRuntime
    const observation = await observeSession(runtime, 'worker')
    expect(observation?.skillCalls).toEqual(['loaded-method'])
    expect(observation?.tools).toEqual({ calls: [{ name: 'skill', count: 4 }], failures: 1 })
  })
})
