import { describe, expect, it, vi } from 'vitest'
import { defineSpawnTool } from '../../agent-singularity/src/tools/spawn.ts'
import { defineMarkReadyTool } from '../../agent-singularity/src/tools/mark-ready.ts'

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
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', rootSessionId: 'root-1', ready: false }))
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
      prompt: [{ type: 'text', text: expect.stringContaining('Run the test suite') }],
      grant: { capabilities: [], baseline: expect.arrayContaining(['bash', 'env_register_component']), keepPresetTools: false },
      // Setup works the home port before the round's bubble exists.
      permissionPreset: 'danger-full-access',
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
      rootSessionId: 'root-1',
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
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', rootSessionId: 'root-1', ready: true }))
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

  it('rejects nested setup delegation and readiness changes from non-root members', async () => {
    const spawn = vi.fn()
    const markReady = vi.fn()
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', rootSessionId: 'root-1', ready: false }))
    const ctx = { agentRuntime: { spawn }, graphs: { graphForSession, markReady } } as never
    const exec = { agent: { id: 'setup-child' }, signal: new AbortController().signal } as never
    await expect(defineSpawnTool(ctx).execute({ name: 'nested', task: 'Prepare' }, exec))
      .rejects.toThrow('only graph graph-1\'s root may delegate setup')
    await expect(defineMarkReadyTool(ctx).execute({}, exec))
      .rejects.toThrow('only graph graph-1\'s root may finish setup')
    expect(spawn).not.toHaveBeenCalled()
    expect(markReady).not.toHaveBeenCalled()
  })

  it('allows the root to mark setup ready', async () => {
    const markReady = vi.fn()
    const graphForSession = vi.fn(async () => ({ id: 'graph-1', rootSessionId: 'root-1', ready: false }))
    const tool = defineMarkReadyTool({ graphs: { graphForSession, markReady } } as never)
    await expect(tool.execute({}, { agent: { id: 'root-1' } } as never)).resolves.toBe('graph graph-1 ready')
    expect(markReady).toHaveBeenCalledWith('graph-1')
  })
})
