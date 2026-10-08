import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { EnvStore } from '../../../env-builder/src/service/store.ts'
import { GraphsService } from '../../graphs/src/index.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-model-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** The provider registry the validation reads: `p1` serves `m1`, `p2` serves nothing. */
function catalog() {
  return {
    listProviders: () => [
      { id: 'p1', name: 'Provider One' },
      { id: 'p2', name: 'Provider Two' },
    ],
    listModels: async (provider: string) => (provider === 'p1' ? [{ id: 'm1', name: 'Model One' }] : []),
  }
}

function harness() {
  const store = new EnvStore(root)
  const events: SessionEvent[] = []
  const handle = {
    read: async () => ({ events }),
    append: async (records: readonly SessionEvent[]) => {
      events.push(...records)
    },
    flush: async () => {},
    close: async () => {},
  }
  const runtime = {
    createRoot: vi.fn(async ({ sessionId }: { sessionId: SessionId }) => ({ agent: { id: sessionId } })),
    ensureRoot: vi.fn(async (sessionId: SessionId) => ({ agent: { id: sessionId } })),
    prompt: vi.fn(async () => {}),
    stopAgents: vi.fn(async () => {}),
    stopGraph: vi.fn(async () => {}),
    spawn: vi.fn(),
  }
  const graph = { switchStore: vi.fn(async () => {}), snapshotIn: async () => ({ agents: [] }), clearActive: vi.fn() }
  const layout = { switchStore: vi.fn(async () => {}), clearActive: vi.fn() }
  const persistence = { list: async () => [], create: async () => handle }
  const provide = (ctx: Context) => {
    ctx.provide('sessionPersistence', persistence as never)
    ctx.provide('envBuilder', { store } as never)
    ctx.provide('graph', graph as never)
    ctx.provide('layout', layout as never)
    ctx.provide('agentRuntime', runtime as never)
    ctx.provide('taskRuntime', {
      adoptRoot: vi.fn(async () => ({ adopted: false, detail: 'none' })),
      sessionWorkspaces: new Map<string, string>(),
    } as never)
    ctx.provide('llm', catalog() as never)
  }
  const ctx = new Context()
  provide(ctx)
  const service = new GraphsService(ctx)
  // A second service over the same persisted events replays the pin.
  const reopen = () => {
    const next = new Context()
    provide(next)
    return new GraphsService(next)
  }
  return { service, reopen, store, events, runtime }
}

function seedEnv(store: EnvStore, repos: readonly string[]) {
  const env = store.create()
  for (const ref of repos) store.planComponent(env.id, ref)
  for (const ref of repos) store.setComponentStatus(env.id, ref, 'ready')
  return store.get(env.id)
}

describe('graph model pinning', () => {
  it('stores a validated pin, creates the root under it, and recovers the root under it', async () => {
    const { service, store, runtime } = harness()
    seedEnv(store, ['acme/widget'])

    const { graph } = await service.create({
      createEnv: true,
      repos: ['acme/widget'],
      model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    })

    expect(graph.model).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
    expect(runtime.createRoot).toHaveBeenCalledWith(
      expect.objectContaining({ agentOptions: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }),
    )
    expect(runtime.ensureRoot).toHaveBeenCalledWith(
      graph.rootSessionId,
      { graphStoreId: graph.graphStoreId, layoutStoreId: graph.layoutStoreId },
      { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    )
  })

  it('refuses an unknown provider route, naming the field, before any side effect', async () => {
    const { service, store, runtime } = harness()
    seedEnv(store, ['acme/widget'])

    await expect(
      service.create({ createEnv: true, repos: ['acme/widget'], model: { provider: 'p9', model: 'm1' } }),
    ).rejects.toThrow('model.provider "p9" is not a registered provider route')
    expect(runtime.createRoot).not.toHaveBeenCalled()
    expect(await service.list()).toEqual([])
  })

  it('refuses a model the named route does not serve, naming the field', async () => {
    const { service, store, runtime } = harness()
    seedEnv(store, ['acme/widget'])

    await expect(
      service.create({ createEnv: true, repos: ['acme/widget'], model: { provider: 'p1', model: 'm9' } }),
    ).rejects.toThrow('model.model "m9" is not served by provider "p1"')
    expect(runtime.createRoot).not.toHaveBeenCalled()
  })

  it('creates without a pin under the deployment default: no model stored and no agentOptions key', async () => {
    const { service, store, runtime } = harness()
    seedEnv(store, ['acme/widget'])

    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'] })

    expect(graph.model).toBeUndefined()
    const request = runtime.createRoot.mock.calls[0]![0] as Record<string, unknown>
    expect('agentOptions' in request).toBe(false)
    expect(runtime.ensureRoot).toHaveBeenCalledWith(graph.rootSessionId, {
      graphStoreId: graph.graphStoreId,
      layoutStoreId: graph.layoutStoreId,
    })
  })

  it('pins, replaces, and clears a graph model through the persisted event log', async () => {
    const { service, reopen, store, events } = harness()
    seedEnv(store, ['acme/widget'])
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'] })

    expect((await service.setModel(graph.id, { provider: 'p1', model: 'm1' })).model).toEqual({
      provider: 'p1',
      model: 'm1',
    })
    expect((await reopen().get(graph.id)).model).toEqual({ provider: 'p1', model: 'm1' })

    expect((await service.setModel(graph.id, null)).model).toBeUndefined()
    const replayed = await reopen().get(graph.id)
    expect(replayed.id).toBe(graph.id)
    expect('model' in replayed).toBe(false)
    expect(events.filter(event => (event.data as { kind?: string }).kind === 'graph/model')).toHaveLength(2)
  })

  it('refuses an invalid PATCH pin and leaves the stored model untouched', async () => {
    const { service, store } = harness()
    seedEnv(store, ['acme/widget'])
    const { graph } = await service.create({ createEnv: true, repos: ['acme/widget'], model: { provider: 'p1', model: 'm1' } })

    await expect(service.setModel(graph.id, { provider: 'p1', model: 'm9' })).rejects.toThrow(
      'model.model "m9" is not served by provider "p1"',
    )
    expect((await service.get(graph.id)).model).toEqual({ provider: 'p1', model: 'm1' })
  })
})
