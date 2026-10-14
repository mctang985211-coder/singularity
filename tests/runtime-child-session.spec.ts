import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { openChildSession, type ChildSessionSeams } from '../src/runtime/child-session.ts'
import { openAgentSession } from '../src/runtime/agent-session.ts'
import { schedulerMessage } from '../src/runtime/task-message.ts'

vi.mock('../src/runtime/agent-session.ts', () => ({
  openAgentSession: vi.fn(), closeAgentSession: vi.fn(), agentSessionIdOf: (id: string) => `singularity:agent:${id}`,
}))
vi.mock('../src/runtime/identified-message.ts', () => ({ postIdentifiedMessage: vi.fn(async () => 'posted') }))
afterEach(() => vi.resetAllMocks())

it.each([false, true])('mounts the isolated review preset on create/resume (resumed=%s) with the unchanged model route', async resumed => {
  const childCtx = {} as Context
  const parent = { ctx: {}, options: {}, session: { requestHeader: () => ({ config: { reasoningEffort: 'high' } }) } } as unknown as Agent
  const agent = {} as Agent
  const mount = vi.fn(async () => undefined), composeFrom = vi.fn(() => 'singularity-next')
  const seams = { sessionPersistence: { stat: async () => resumed ? {} : undefined }, sessions: {},
    agentPresets: { mount, composeFrom } } as unknown as ChildSessionSeams
  vi.mocked(openAgentSession).mockImplementation(async (_seams, request) => {
    await (request.setup as AgentSetup)(childCtx, agent)
    expect(request.preset).toBe('singularity-review')
    expect(request.resume).toBe(resumed)
    expect(request.agentOptions).toEqual({ provider: 'gateway', model: 'same-model', reasoningEffort: 'high' })
    return { agentId: 'review', sessionId: 'singularity:agent:review', resumed, agent }
  })
  const opened = await openChildSession(seams, { agentId: 'review', cwd: '/review', parent,
    model: { provider: 'gateway', model: 'same-model' }, preset: 'singularity-review', signal: new AbortController().signal,
    message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: 'control', parentTaskId: 'root', taskId: 'review', runId: 'run', factSeq: 1 }, 'Judge the frozen subject'),
  })
  expect(opened.delivery).toBe('posted')
  expect(mount).toHaveBeenCalledExactlyOnceWith(childCtx, 'singularity-review')
  expect(composeFrom).not.toHaveBeenCalled()
  await opened.close()
})
