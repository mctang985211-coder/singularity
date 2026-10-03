import { describe, expect, it, vi } from 'vitest'
import { defineSpawnTool } from '../../agent-singularity/src/tools/spawn.ts'

describe('graph_spawn', () => {
  it('creates a setup worker before readiness and returns its final response', async () => {
    const worker = {
      id: 'worker-1',
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      session: {
        snapshotEvents: () => [
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'tests passed' }] } },
          },
        ],
      },
    }
    const spawn = vi.fn(async () => ({ agent: worker }))
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', ready: false }))
    const tool = defineSpawnTool({ agentRuntime: { spawn }, graphs: { graphForSession } } as never)
    const parent = { id: 'root-1' }
    const result = await tool.execute({ name: 'test-worker', task: 'Run the test suite' }, {
      agent: parent,
      signal: new AbortController().signal,
    } as never)
    expect(graphForSession).toHaveBeenCalledExactlyOnceWith(parent.id)
    expect(spawn).toHaveBeenCalledWith(parent, {
      sessionId: expect.any(String),
      name: 'test-worker',
      prompt: [{ type: 'text', text: 'Run the test suite' }],
      signal: expect.any(AbortSignal),
    })
    expect(worker.whenIdle).toHaveBeenCalledOnce()
    expect(result).toContain('tests passed')
  })

  it('inherits the graph model pin as agentOptions on the worker spawn', async () => {
    const worker = {
      id: 'worker-1',
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      session: {
        snapshotEvents: () => [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        ],
      },
    }
    const spawn = vi.fn(async () => ({ agent: worker }))
    const graphForSession = vi.fn(async () => ({
      id: 'graph-1',
      ready: false,
      model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    }))
    const tool = defineSpawnTool({ agentRuntime: { spawn }, graphs: { graphForSession } } as never)
    const parent = { id: 'root-1' }

    await tool.execute({ name: 'setup', task: 'Prepare' }, {
      agent: parent,
      signal: new AbortController().signal,
    } as never)

    expect(spawn).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ agentOptions: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }),
    )
  })

  it('rejects a ready graph before creating any worker', async () => {
    const spawn = vi.fn()
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', ready: true }))
    const tool = defineSpawnTool({ agentRuntime: { spawn }, graphs: { graphForSession } } as never)

    await expect(
      tool.execute({ name: 'bypass', task: 'Implement objective work' }, {
        agent: { id: 'root-1' },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('graph_spawn: graph graph-1 is ready; delegate objective work with task_decompose')
    expect(graphForSession).toHaveBeenCalledExactlyOnceWith('root-1')
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([undefined, {}])('rejects a missing caller identity before reading a graph or spawning (%j)', async agent => {
    const spawn = vi.fn()
    const graphForSession = vi.fn()
    const tool = defineSpawnTool({ agentRuntime: { spawn }, graphs: { graphForSession } } as never)

    await expect(
      tool.execute({ name: 'setup', task: 'Prepare the environment' }, {
        agent,
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('graph_spawn: missing agent id')
    expect(graphForSession).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('propagates a graph read failure without creating a worker', async () => {
    const failure = new Error('graph store unavailable')
    const spawn = vi.fn()
    const graphForSession = vi.fn(async () => {
      throw failure
    })
    const tool = defineSpawnTool({ agentRuntime: { spawn }, graphs: { graphForSession } } as never)

    await expect(
      tool.execute({ name: 'setup', task: 'Prepare the environment' }, {
        agent: { id: 'root-1' },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toBe(failure)
    expect(graphForSession).toHaveBeenCalledExactlyOnceWith('root-1')
    expect(spawn).not.toHaveBeenCalled()
  })
})
