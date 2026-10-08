import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { EnvStore } from '../../../env-builder/src/service/store.ts'
import { GraphsService } from '../../graphs/src/index.ts'
import type { GraphPinsUpdate, RsiConfig } from '../../graphs/src/types.ts'
import { registerGraphs } from '../../graph-web/src/web/api/graphs.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graphs-lifecycle-'))
  vi.stubEnv('DSH_HOME', root)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function harness(overrides: { sessionPersistence?: unknown; events?: SessionEvent[] } = {}) {
  const ctx = new Context()
  const store = new EnvStore(root)
  const events: SessionEvent[] = overrides.events ?? []
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
    promptUser: vi.fn(async (_agent: { id: SessionId }, _prompt: { type: string; text: string }[]) => {}),
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
    // The live mapping `GraphsService.create` writes: the root session works in
    // round 1's bubble, and the runtime resolves the checkout from here.
    sessionWorkspaces: new Map<string, string>(),
  }
  ctx.provide(
    'sessionPersistence',
    (overrides.sessionPersistence ?? {
      list: async () => (events.length === 0 ? [] : [{ header: { id: 'graphs-registry' } }]),
      create: async () => handle,
      open: async () => handle,
    }) as never,
  )
  ctx.provide('envBuilder', { store } as never)
  ctx.provide('graph', graph as never)
  ctx.provide('layout', layout as never)
  ctx.provide('agentRuntime', runtime as never)
  ctx.provide('taskRuntime', taskRuntime as never)
  const catalog = {
    listProviders: () => [{ id: 'p1', name: 'Provider One' }],
    listModels: vi.fn(async (_provider: string) => [
      { id: 'm1', name: 'Model One' },
      { id: 'm2', name: 'Model Two' },
    ]),
  }
  ctx.provide('llm', catalog as never)
  const service = new GraphsService(ctx)
  const reopen = (): GraphsService => harness({ events: structuredClone(events) }).service
  return {
    ctx,
    service,
    store,
    events,
    agents,
    append,
    runtime,
    graph,
    layout,
    detach,
    deleteEnv,
    taskRuntime,
    catalog,
    reopen,
  }
}

describe('graphs creation lifecycle', () => {
  it('creates an empty environment from a goal and metrics, then delivers the user goal', async () => {
    const { service, store, runtime } = harness()
    const result = await service.create({ createEnv: true, rsi: { task: 'Improve a word counter', metrics: ['correctness', 'latency'] } })
    expect(store.get(result.graph.envId).components).toEqual([])
    expect(result.graph.rsi).toEqual({ task: 'Improve a word counter', metrics: ['correctness', 'latency'], iterationRounds: 3, humanReview: false, epoch: 1 })
    expect(runtime.promptUser).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: result.graph.rootSessionId }), [
      { type: 'text', text: 'Improve a word counter\n关注指标：\n- correctness\n- latency' },
    ], [{ type: 'text', text: expect.stringContaining('Set up Singularity graph') }])
    expect(runtime.prompt).not.toHaveBeenCalled()
  })

  it('uses the round-1 bubble workspace and sends setup only after registry persistence completes', async () => {
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
    const bubble = join(root, 'singularity', 'environments', graph.rootSessionId, 'bubbles', 'round-1', 'workspace')

    expect(runtime.createRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        // The root works in round 1's bubble, not in the environment checkout.
        cwd: bubble,
        sessionId: graph.rootSessionId,
        scope: { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId },
      }),
    )
    // The root session's own workspace is that bubble: the runtime resolves the
    // graph's checkout from this mapping rather than from the environment's path.
    expect(taskRuntime.sessionWorkspaces.get(graph.rootSessionId)).toBe(bubble)
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
    await expect(service.create({ createEnv: true, repos: ['acme/widget'] })).rejects.toThrow(
      'the store log is unreadable',
    )

    // The graph stays registered and selected — visible as failed, never
    // rolled back onto the previous selection — and the barrier ran exactly
    // once, through the same activation entry every graph takes.
    const graphs = await service.list()
    expect(graphs).toHaveLength(1)
    expect((await service.snapshot()).selectedId).toBe(graphs[0]!.id)
    expect(taskRuntime.adoptRoot).toHaveBeenCalledExactlyOnceWith(
      `sg-t-${graphs[0]!.rootSessionId}`,
      graphs[0]!.rootSessionId,
    )
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

const rsiConfig: RsiConfig = { task: 'Improve widget', iterationRounds: 3, humanReview: true }

/** Drive the registered HTTP endpoint against the real registry, including its persistence queue. */
function patchGraph(service: GraphsService, store: EnvStore) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  registerGraphs({
    graphs: service,
    envBuilder: { store },
    webServer: {
      register: ({ kind, handler: registered }: { kind: string; handler: typeof handler }) => {
        if (kind === 'prefix') handler = registered
        return () => {}
      },
    },
  } as never)
  return async (id: string, body: unknown) => {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage
    req.method = 'PATCH'
    req.url = `/singularity/graphs/${id}`
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status
      },
      end(body: string) {
        this.body = body
      },
    }
    await handler!(req, res as unknown as ServerResponse)
    return res
  }
}

describe('graph RSI settings persistence and HTTP updates', () => {
  it('creates and reopens the configured graph with its protocol marker and epoch default', async () => {
    const { service, reopen, events } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'], rsi: rsiConfig })

    expect(graph.protocol).toMatchObject({ id: 'singularity/graph@2', version: 2 })
    expect(graph.rsi).toEqual({ ...rsiConfig, epoch: 1 })
    expect(events[0]).toMatchObject({ data: { kind: 'graph/add', graph: { rsi: rsiConfig } } })
    expect(await reopen().get(graph.id)).toEqual(graph)
  })

  it.each([
    ['non-object', null, 'rsi must be an object'],
    ['blank task', { ...rsiConfig, task: '  ' }, 'rsi.task'],
    ['missing task', { iterationRounds: 3, humanReview: true }, 'rsi.task'],
    ['zero rounds', { ...rsiConfig, iterationRounds: 0 }, 'rsi.iterationRounds'],
    ['fractional rounds', { ...rsiConfig, iterationRounds: 1.5 }, 'rsi.iterationRounds'],
    ['non-boolean review', { ...rsiConfig, humanReview: 'true' }, 'rsi.humanReview'],
    ['unknown setting', { ...rsiConfig, background: true }, '"background"'],
  ])('refuses create with %s before allocating an environment or root', async (_label, rsi, error) => {
    const { service, store, runtime, events } = harness()
    await expect(service.create({ createEnv: true, repos: ['acme/widget'], rsi: rsi as RsiConfig })).rejects.toThrow(
      error,
    )
    expect(store.list()).toEqual([])
    expect(await service.list()).toEqual([])
    expect(runtime.createRoot).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('set, repeated set, and clear replace the config while preserving the same graph root', async () => {
    const { service, reopen, runtime } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'], rsi: rsiConfig })
    const replacement = { ...rsiConfig, iterationRounds: 5, humanReview: false }

    const replaced = await service.setRsi(graph.id, replacement)
    expect(replaced).toEqual({ ...graph, rsi: replacement })
    expect(await reopen().get(graph.id)).toEqual(replaced)

    const repeated = await service.setRsi(graph.id, replacement)
    expect(repeated.rsi).toEqual(replacement)
    expect(repeated.rootSessionId).toBe(graph.rootSessionId)

    const cleared = await service.setRsi(graph.id, null)
    expect('rsi' in cleared).toBe(false)
    expect(cleared.rootSessionId).toBe(graph.rootSessionId)
    expect(await reopen().get(graph.id)).toEqual(cleared)
    expect(runtime.createRoot).toHaveBeenCalledOnce()
  })

  it('stamps an explicit epoch on the config it stores', async () => {
    const { service, reopen } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'], rsi: rsiConfig })
    const bumped = await service.setRsi(graph.id, { ...rsiConfig, epoch: 2 })
    expect(bumped.rsi?.epoch).toBe(2)
    expect(await reopen().get(graph.id)).toEqual(bumped)
  })

  it('replays an older graph with no RSI settings without adding defaults', async () => {
    const { service, reopen } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    const read = await reopen().get(graph.id)
    expect(read).toEqual(graph)
    expect('rsi' in read).toBe(false)
  })

  it.each([
    [{ model: { provider: 'p1', model: 'm2' }, rsi: { ...rsiConfig, iterationRounds: 0 } }, 'rsi.iterationRounds'],
    [{ model: { provider: 'p1', model: 'unknown' }, rsi: { ...rsiConfig, humanReview: false } }, 'model.model'],
    [{ rsi: { ...rsiConfig, task: '' } }, 'rsi.task'],
    [{}, 'model or rsi is required'],
  ])('HTTP refusal leaves the whole graph and event log untouched: %j', async (update, error) => {
    const { service, store, reopen, events, append } = harness()
    const { graph } = await service.create({
      createEnv: true,
      repos: ['acme/widget'],
      model: { provider: 'p1', model: 'm1' },
      rsi: rsiConfig,
    })
    const before = await service.get(graph.id)
    const recorded = structuredClone(events)
    append.mockClear()

    const response = await patchGraph(service, store)(graph.id, update)
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain(error)
    expect(await service.get(graph.id)).toEqual(before)
    expect(await reopen().get(graph.id)).toEqual(before)
    expect(events).toEqual(recorded)
    expect(append).not.toHaveBeenCalled()
  })

  it('HTTP combined success persists both pins once and broadcasts only the complete result', async () => {
    const { ctx, service, store, reopen, append } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'], rsi: rsiConfig })
    const changed = vi.fn()
    ctx.on('graphs/change', changed)
    append.mockClear()
    const update: GraphPinsUpdate = {
      model: { provider: 'p1', model: 'm2' },
      rsi: { ...rsiConfig, humanReview: false },
    }

    const response = await patchGraph(service, store)(graph.id, update)
    expect(response.statusCode).toBe(200)
    const result = JSON.parse(response.body)
    expect(result).toEqual({ ...graph, ...update })
    expect(append).toHaveBeenCalledOnce()
    expect(append.mock.calls[0][0].map(record => record.data)).toEqual([
      { kind: 'graph/model', id: graph.id, model: update.model },
      { kind: 'graph/rsi', id: graph.id, rsi: update.rsi },
    ])
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ graphs: [result] }))
    expect(await reopen().get(graph.id)).toEqual(result)

    const cleared = await patchGraph(service, store)(graph.id, { model: null, rsi: null })
    expect(cleared.statusCode).toBe(200)
    const afterClear = await service.get(graph.id)
    expect('model' in afterClear).toBe(false)
    expect('rsi' in afterClear).toBe(false)
    expect(await reopen().get(graph.id)).toEqual(afterClear)
  })

  it('a persistence failure in a combined update keeps both original settings', async () => {
    const { service, store, reopen, append, events } = harness()
    const { graph } = await service.create({
      createEnv: true,
      repos: ['acme/widget'],
      model: { provider: 'p1', model: 'm1' },
      rsi: rsiConfig,
    })
    const recorded = structuredClone(events)
    append.mockRejectedValueOnce(new Error('registry unavailable'))

    const response = await patchGraph(service, store)(graph.id, {
      model: { provider: 'p1', model: 'm2' },
      rsi: null,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('registry unavailable')
    expect(await service.get(graph.id)).toEqual(graph)
    expect(await reopen().get(graph.id)).toEqual(graph)
    expect(events).toEqual(recorded)
  })

  it('serializes a combined update with later settings changes while model validation awaits', async () => {
    const { service, catalog, append } = harness()
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    const models = Promise.withResolvers<{ id: string; name: string }[]>()
    catalog.listModels.mockImplementationOnce(() => models.promise)
    append.mockClear()
    const combined = service.setPins(graph.id, { model: { provider: 'p1', model: 'm1' }, rsi: rsiConfig })
    const cleared = service.setRsi(graph.id, null)
    await vi.waitFor(() => expect(catalog.listModels).toHaveBeenCalledOnce())
    expect(append).not.toHaveBeenCalled()

    models.resolve([{ id: 'm1', name: 'Model One' }])
    await combined
    await cleared
    expect(append.mock.calls.map(([records]) => records.map(record => (record.data as { kind: string }).kind))).toEqual(
      [['graph/model', 'graph/rsi'], ['graph/rsi']],
    )
    expect((await service.get(graph.id)).model).toEqual({ provider: 'p1', model: 'm1' })
    expect((await service.get(graph.id)).rsi).toBeUndefined()
  })

  it('refuses settings for unknown graphs without appending events', async () => {
    const { service, events } = harness()
    await expect(service.setRsi('missing', rsiConfig)).rejects.toThrow('unknown graph')
    await expect(service.setPins('missing', { model: null, rsi: null })).rejects.toThrow('unknown graph')
    expect(events).toEqual([])
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
      create: async () => {
        throw new Error('unreachable')
      },
      open: async () => ({
        read: async () => ({
          events: [{ type: 'graphs/event', seq: 0, time: 1, data: { kind: 'graph/add', graph }, ignorable: true }],
        }),
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
    await vi.waitFor(() =>
      expect(taskRuntime.adoptRoot).toHaveBeenCalledExactlyOnceWith('sg-t-s-root-1', rootSessionId),
    )
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

  it('deletes the selected graph even when the successor’s activation fails', async () => {
    const { service, runtime } = harness()
    const { graph: first } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    const { graph: second } = await service.create({ createEnv: true, repos: ['acme/widget'] })
    await service.select(first.id)
    // The successor's root cannot be taken over (its MCP server cannot start); that
    // failure belongs to the successor and must not hold or fail this delete.
    runtime.ensureRoot.mockRejectedValue(new Error('agent-runtime: session "s-x" could not be taken over safely'))

    await service.remove(first.id)

    const snapshot = await service.snapshot()
    expect(snapshot.graphs.map(graph => graph.id)).toEqual([second.id])
    expect(snapshot.selectedId).toBe(second.id)
    await vi.waitFor(() => expect(runtime.ensureRoot).toHaveBeenCalled())
  })
})
