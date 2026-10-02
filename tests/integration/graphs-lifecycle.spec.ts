import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { EnvStore } from '../../../env-builder/src/service/store.ts'
import { GraphsService } from '../../graphs/src/index.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graphs-lifecycle-'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function harness(overrides: { sessionPersistence?: unknown } = {}) {
  const ctx = new Context()
  const store = new EnvStore(root)
  const events: SessionEvent[] = []
  const agents: { id: SessionId }[] = []
  const append = vi.fn(async (records: readonly SessionEvent[]) => {
    events.push(...records)
  })
  const handle = {
    read: async () => ({ events }),
    append,
    flush: async () => {},
    close: async () => {},
  }
  const runtime = {
    createRoot: vi.fn(async ({ sessionId }: { sessionId: SessionId; cwd: string }) => {
      const agent = { id: sessionId }
      agents.push(agent)
      return { agent }
    }),
    ensureRoot: vi.fn(async (sessionId: SessionId) => ({ agent: { id: sessionId } })),
    prompt: vi.fn(async (_agent: { id: SessionId }, _prompt: { type: string; text: string }[]) => {}),
    stopAgents: vi.fn(async (_ids: readonly SessionId[]) => {}),
    stopGraph: vi.fn(async (): Promise<void> => {
      await runtime.stopAgents(agents.map(agent => agent.id))
    }),
    spawn: vi.fn(async (_parent: { id: SessionId }, options: { sessionId: SessionId; name: string }) => {
      const agent = { id: options.sessionId }
      agents.push(agent)
      return { agent }
    }),
  }
  const graph = {
    switchStore: vi.fn(async (_id: string) => {}),
    snapshot: async () => ({ agents: [...agents] }),
    snapshotIn: async (_id: string) => ({ agents: [...agents] }),
    clearActive: vi.fn(),
  }
  const layout = {
    switchStore: vi.fn(async (_id: string) => {}),
    snapshot: async () => ({ nodes: {} }),
    clearActive: vi.fn(),
  }
  const detach = vi.spyOn(store, 'detachSession')
  const deleteEnv = vi.spyOn(store, 'delete')
  const taskRuntime = {
    // The graph entry opens its root session's store and adopts whatever root that
    // store already holds (A0 §1.1): a fresh session's store holds none yet, which
    // is what `adopted: false` says.
    adoptRoot: vi.fn(async (_storeId: string, _rootSessionId: string) => ({
      adopted: false as const,
      detail: 'the fresh store holds no root task yet',
    })),
    // The A3 hook `GraphsService.remove` calls before it stops the graph: a batch
    // driver still running would keep spawning workers into an environment that
    // is being cleaned, so the store's task tree is cancelled first (§3.6).
    cancelGraph: vi.fn(async (_storeId: string, _reason: string) => {}),
  }
  ctx.provide('sessionPersistence', (overrides.sessionPersistence ?? { list: async () => [], create: async () => handle }) as never)
  ctx.provide('envBuilder', { store } as never)
  ctx.provide('graph', graph as never)
  ctx.provide('layout', layout as never)
  ctx.provide('agentRuntime', runtime as never)
  ctx.provide('taskRuntime', taskRuntime as never)
  const service = new GraphsService(ctx)
  return { ctx, service, store, events, agents, append, runtime, graph, layout, detach, deleteEnv, taskRuntime }
}

describe('graphs creation lifecycle', () => {
  it('rejects a graph environment without repositories', async () => {
    const { service, store, runtime } = harness()
    await expect(service.create({ createEnv: true })).rejects.toThrow(
      'new environment requires at least one repository',
    )
    expect(store.list()).toEqual([])

    const env = store.create()
    await expect(service.create({ envId: env.id })).rejects.toThrow(`environment "${env.id}" has no repositories`)
    expect(runtime.createRoot).not.toHaveBeenCalled()
  })

  it('uses the environment cwd and sends setup only after registry persistence completes', async () => {
    const { service, store, append, events, runtime, taskRuntime } = harness()
    const persisted = Promise.withResolvers<void>()
    append.mockImplementationOnce(async records => {
      await persisted.promise
      events.push(...records)
    })
    const creating = service.create({ createEnv: true, repos: ['acme/widget'] })
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
    expect(runtime.prompt).not.toHaveBeenCalled()
    expect(await service.list()).toEqual([])
    persisted.resolve()
    const { graph } = await creating

    expect(runtime.createRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: store.get(graph.envId).path,
        sessionId: graph.rootSessionId,
        scope: { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId },
      }),
    )
    // The graph creates no task: it opens the store and adopts the root it holds,
    // and the graph's own name never becomes an objective (A0 §1.2, §1.5).
    expect(taskRuntime.adoptRoot).toHaveBeenCalledExactlyOnceWith(`sg-t-${graph.rootSessionId}`, graph.rootSessionId)
    expect(JSON.stringify(taskRuntime.adoptRoot.mock.calls)).not.toContain('objective')
    expect(events[0]).toMatchObject({ type: 'graphs/event', data: { kind: 'graph/add', graph } })
    expect(store.get(graph.envId).sessionIds).toEqual([graph.rootSessionId])
    expect(runtime.prompt).toHaveBeenCalledOnce()
    expect(runtime.prompt.mock.calls[0][0]).toMatchObject({ id: graph.rootSessionId })
    expect(runtime.prompt.mock.calls[0][1][0].text).toContain('graph_mark_ready')
    expect(runtime.prompt.mock.calls[0][1][0].text).toContain('acme/widget')
  })

  it('stops and detaches a created root before deleting its environment when persistence fails', async () => {
    const { service, store, append, runtime, detach, deleteEnv } = harness()
    append.mockRejectedValueOnce(new Error('registry unavailable'))
    await expect(service.create({ createEnv: true, repos: ['acme/widget'] })).rejects.toThrow('registry unavailable')

    const sessionId = runtime.createRoot.mock.calls[0][0].sessionId
    expect(runtime.stopAgents).toHaveBeenCalledExactlyOnceWith([sessionId])
    expect(detach).toHaveBeenCalledExactlyOnceWith('project1', sessionId)
    expect(deleteEnv).toHaveBeenCalledExactlyOnceWith('project1')
    expect(runtime.stopAgents.mock.invocationCallOrder[0]).toBeLessThan(detach.mock.invocationCallOrder[0])
    expect(detach.mock.invocationCallOrder[0]).toBeLessThan(deleteEnv.mock.invocationCallOrder[0])
    expect(store.list()).toEqual([])
    expect(await service.list()).toEqual([])
    expect(runtime.prompt).not.toHaveBeenCalled()
  })

  it('removes a newly created environment when planning a repository fails', async () => {
    const { service, store, runtime, deleteEnv } = harness()
    await expect(service.create({ createEnv: true, repos: ['acme/widget', 'invalid'] })).rejects.toThrow()
    expect(deleteEnv).toHaveBeenCalledExactlyOnceWith('project1')
    expect(store.list()).toEqual([])
    expect(await service.list()).toEqual([])
    expect(runtime.createRoot).not.toHaveBeenCalled()
  })

  it('keeps the committed graph, environment and root binding if setup submission fails', async () => {
    const { service, store, runtime, detach, deleteEnv } = harness()
    runtime.prompt.mockRejectedValueOnce(new Error('setup submission failed'))
    await expect(service.create({ createEnv: true, repos: ['acme/widget'] })).rejects.toThrow('setup submission failed')

    const graphs = await service.list()
    expect(graphs).toHaveLength(1)
    expect(store.get(graphs[0].envId).sessionIds).toEqual([graphs[0].rootSessionId])
    expect(runtime.stopAgents).not.toHaveBeenCalled()
    expect(detach).not.toHaveBeenCalled()
    expect(deleteEnv).not.toHaveBeenCalled()
  })

  it('keeps the registered graph selected and sends no setup when the recovery barrier fails', async () => {
    const { service, store, runtime, taskRuntime, detach, deleteEnv } = harness()
    // The activation's recovery barrier is the first thing that can fail after
    // the graph is registered (A2 §E): the store's log is unreadable, so the
    // barrier fails and the failure is what the caller sees.
    taskRuntime.adoptRoot.mockRejectedValueOnce(new Error('the store log is unreadable'))
    await expect(service.create({ createEnv: true, repos: ['acme/widget'] })).rejects.toThrow('the store log is unreadable')

    // The graph stays registered and selected — visible as failed, never
    // rolled back onto the previous selection — and the barrier ran exactly
    // once, through the same activation entry every graph takes.
    const graphs = await service.list()
    expect(graphs).toHaveLength(1)
    expect((await service.snapshot()).selectedId).toBe(graphs[0]!.id)
    expect(taskRuntime.adoptRoot).toHaveBeenCalledExactlyOnceWith(`sg-t-${graphs[0]!.rootSessionId}`, graphs[0]!.rootSessionId)
    // Zero model input: the setup prompt never went out.
    expect(runtime.prompt).not.toHaveBeenCalled()
    // The committed graph keeps its environment and root binding: the failure
    // was the recovery, not the registration.
    expect(store.get(graphs[0]!.envId).sessionIds).toEqual([graphs[0]!.rootSessionId])
    expect(runtime.stopAgents).not.toHaveBeenCalled()
    expect(detach).not.toHaveBeenCalled()
    expect(deleteEnv).not.toHaveBeenCalled()
  })
})

describe('graphs boot recovery', () => {
  it('recovers the selected graph at boot through the same activation entry', async () => {
    // A registry that already holds a selected graph — the state a restart
    // replays — provided before the service opens its store, so what it reads
    // is what the previous process left.
    const rootSessionId = 's-root-1' as SessionId
    const graph = {
      id: 'graph1',
      name: 'graph1',
      envId: 'project1',
      rootSessionId,
      graphStoreId: 'sg-g-s-root-1',
      layoutStoreId: 'sg-l-s-root-1',
      createdAt: 1,
      ready: false,
    }
    const seeded = {
      list: async () => [{ header: { id: 'graphs-registry' } }],
      create: async () => { throw new Error('unreachable') },
      open: async () => ({
        read: async () => ({ events: [{ type: 'graphs/event', seq: 0, time: 1, data: { kind: 'graph/add', graph }, ignorable: true }] }),
        append: async () => {},
        flush: async () => {},
        close: async () => {},
      }),
    }
    const { ctx, service, store, taskRuntime } = harness({ sessionPersistence: seeded })
    store.create()

    // The boot recovers the selected graph by activating it (A2 §E): the
    // barrier is awaited before the environment switch, not chased by an
    // asynchronous selected-listener.
    await vi.waitFor(() => expect(taskRuntime.adoptRoot).toHaveBeenCalledExactlyOnceWith('sg-t-s-root-1', rootSessionId))
    expect((await service.snapshot()).selectedId).toBe('graph1')
    await ctx.fiber.dispose()
  })
})

describe('graphs removal lifecycle', () => {
  it('stops the graph, unbinds its environment without a cleanup agent, and archives it', async () => {
    const { service, store, agents, runtime, graph, layout, taskRuntime } = harness()
    const { graph: created } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    const workerId = 'old-worker' as SessionId
    agents.push({ id: workerId })
    store.attachSession(created.envId, workerId)
    runtime.ensureRoot.mockClear()

    await service.remove(created.id)

    expect(runtime.stopAgents).toHaveBeenCalledExactlyOnceWith([created.rootSessionId, workerId])
    expect(runtime.stopGraph).toHaveBeenCalledExactlyOnceWith({
      graphStoreId: created.graphStoreId,
      layoutStoreId: created.layoutStoreId,
    })
    // The task tree is cancelled before the graph is stopped, named by the store
    // the removed graph owns.
    expect(taskRuntime.cancelGraph).toHaveBeenCalledExactlyOnceWith(`sg-t-${created.rootSessionId}`, 'graph removed')
    // Deletion unbinds and archives only: it resumes no root and spawns no agent of its own.
    expect(runtime.ensureRoot).not.toHaveBeenCalled()
    expect(runtime.spawn).not.toHaveBeenCalled()
    expect(await service.snapshot()).toMatchObject({
      graphs: [],
      archives: [{ graph: created, agentIds: [created.rootSessionId, workerId] }],
    })
    expect(store.get(created.envId).sessionIds).toEqual([])
    expect(store.get(created.envId).running).toBe(false)
    expect(graph.clearActive).toHaveBeenCalledOnce()
    expect(layout.clearActive).toHaveBeenCalledOnce()
  })

  it('deletes without waiting on a cleanup agent whose session would grow the env on every retry', async () => {
    const { service, store, runtime, agents } = harness()
    const { graph: created } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    // The old path spawned an env-clean worker and waited ten minutes for it to call
    // env_mark_clean; the worker's session stayed bound to the env, so every attempt
    // left sessionCount one higher while the request never returned.
    runtime.spawn.mockImplementation(async (_parent, options) => {
      agents.push({ id: options.sessionId })
      store.attachSession(created.envId, options.sessionId)
      return { agent: { id: options.sessionId } }
    })

    vi.useFakeTimers()
    let outcome: 'done' | 'error' | 'pending' = 'pending'
    void service.remove(created.id).then(
      () => {
        outcome = 'done'
      },
      () => {
        outcome = 'error'
      },
    )
    await vi.advanceTimersByTimeAsync(45_000)

    expect(outcome).toBe('done')
    expect(runtime.spawn).not.toHaveBeenCalled()
    expect(store.get(created.envId).sessionIds).toEqual([])
    expect((await service.snapshot()).graphs).toEqual([])
  })

  it('unbinds a symlinked environment without touching its real checkout', async () => {
    const { service, store, deleteEnv } = harness()
    const env = store.create('bb-local')
    store.planComponent(env.id, 'DangoSys/buckyball')
    const real = join(root, 'real-buckyball')
    mkdirSync(real)
    writeFileSync(join(real, 'HEAD.txt'), 'live work')
    symlinkSync(real, join(store.get(env.id).path, 'buckyball'))
    store.setComponentStatus(env.id, 'DangoSys/buckyball', 'ready')

    const { graph: created } = await service.create({ envId: env.id })
    store.attachSession(env.id, 'stale-no-cwd-session')

    await service.remove(created.id)

    expect(readFileSync(join(real, 'HEAD.txt'), 'utf8')).toBe('live work')
    expect(deleteEnv).not.toHaveBeenCalled()
    expect(store.get(env.id).sessionIds).toEqual([])
    expect(store.get(env.id).running).toBe(false)
  })
})
