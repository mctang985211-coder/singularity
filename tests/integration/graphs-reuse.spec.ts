import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { EnvStore } from '../../../env-builder/src/service/store.ts'
import { GraphsService } from '../../graphs/src/index.ts'
import { ensureInitialRevision, libraryRoots, readRevision } from '../../task-runtime/src/environment/index.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graphs-reuse-'))
  vi.stubEnv('DSH_HOME', root)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function harness() {
  const ctx = new Context()
  const store = new EnvStore(root)
  const events: SessionEvent[] = []
  const agents: { id: SessionId }[] = []
  const handle = {
    read: async () => ({ events }),
    append: async (records: readonly SessionEvent[]) => {
      events.push(...records)
    },
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
  const taskRuntime = {
    // The graph entry opens its root session's store and adopts the root it already
    // holds (A0 §1.1); creating a graph mints no task.
    adoptRoot: vi.fn(async () => ({ adopted: false as const, detail: 'the fresh store holds no root task yet' })),
    pinSessionWorkspace: vi.fn(),
    // The graph's library fixes its initial revision before round 1's bubble is
    // materialized; the real seeding runs here so the volume is real bytes.
    ensureInitialEnvironment: vi.fn(async (rootSessionId: string, actor: string) => {
      const roots = libraryRoots(rootSessionId, root)
      await ensureInitialRevision(roots, { actor })
      return { id: roots.id, revision: await readRevision(roots, 'r0001') }
    }),
  }
  ctx.provide('sessionPersistence', { list: async () => [], create: async () => handle } as never)
  ctx.provide('envBuilder', { store } as never)
  ctx.provide('graph', graph as never)
  ctx.provide('layout', layout as never)
  ctx.provide('agentRuntime', runtime as never)
  ctx.provide('taskRuntime', taskRuntime as never)
  const service = new GraphsService(ctx)
  return { ctx, service, store, events, agents, runtime, graph, layout, taskRuntime }
}

function seedEnv(store: EnvStore, repos: readonly string[], label?: string) {
  const env = store.create(label)
  for (const ref of repos) store.planComponent(env.id, ref)
  for (const ref of repos) store.setComponentStatus(env.id, ref, 'ready')
  return store.get(env.id)
}

describe('graphs environment reuse', () => {
  it('reuses an available environment whose repos match exactly, lowest projectN first', async () => {
    const { service, store, runtime } = harness()
    const first = seedEnv(store, ['acme/widget'])
    seedEnv(store, ['acme/widget'])

    const result = await service.create({ createEnv: true, repos: ['https://github.com/acme/widget.git'] })

    expect(result.reused).toBe(true)
    expect(result.graph.envId).toBe(first.id)
    expect(store.list()).toHaveLength(2)
    const text = runtime.prompt.mock.calls[0][1][0].text
    expect(text).toContain('Already present: acme/widget.')
    expect(text).toContain('Planned repositories: (none).')
    expect(text).toContain('call graph_mark_ready')
  })

  it('creates a fresh environment when no available environment matches the repo set', async () => {
    const { service, store } = harness()
    seedEnv(store, ['acme/widget'])

    const result = await service.create({ createEnv: true, repos: ['acme/widget', 'acme/other'] })

    expect(result.reused).toBe(false)
    expect(result.graph.envId).toBe('project2')
    expect(store.get('project2').components.map(c => c.status)).toEqual(['installing', 'installing'])
  })

  it('skips environments that are bound, session-held, or empty during repo matching', async () => {
    const { service, store } = harness()
    const held = seedEnv(store, ['acme/widget'])
    store.attachSession(held.id, 'stray-session')
    const empty = store.create()
    expect(empty.components).toEqual([])

    const result = await service.create({ createEnv: true, repos: ['acme/widget'] })

    expect(result.reused).toBe(false)
    expect(result.graph.envId).toBe('project3')
  })

  it('fresh: true bypasses repo matching and always creates a new environment', async () => {
    const { service, store } = harness()
    seedEnv(store, ['acme/widget'])

    const result = await service.create({ createEnv: true, fresh: true, repos: ['acme/widget'] })

    expect(result.reused).toBe(false)
    expect(result.graph.envId).toBe('project2')
  })

  it('workspace creates and labels a new environment when no env carries the label', async () => {
    const { service, store } = harness()

    const result = await service.create({ workspace: 'bb', repos: ['acme/widget'] })

    expect(result.reused).toBe(false)
    expect(store.get(result.graph.envId).label).toBe('bb')
  })

  it('workspace reuses the available env carrying the label', async () => {
    const { service, store } = harness()
    const env = seedEnv(store, ['acme/widget'], 'bb')

    const result = await service.create({ workspace: 'bb' })

    expect(result.reused).toBe(true)
    expect(result.graph.envId).toBe(env.id)
    expect(store.list()).toHaveLength(1)
  })

  it('workspace reports the occupying graph when the labeled env is taken', async () => {
    const { service, store } = harness()
    const first = await service.create({ workspace: 'bb', repos: ['acme/widget'] })

    await expect(service.create({ workspace: 'bb', repos: ['acme/widget'] })).rejects.toThrow(
      `workspace "bb" is taken by ${first.graph.envId} (bound to graph "${first.graph.id}")`,
    )
    await expect(service.create({ workspace: 'bb', repos: ['acme/widget'] })).rejects.toThrow(
      'POST /singularity/graphs/<id>/delete',
    )
    expect(store.list()).toHaveLength(1)
    expect(await service.list()).toHaveLength(1)
  })

  it('envId reuse error names the occupying graph and the release path', async () => {
    const { service } = harness()
    const first = await service.create({ createEnv: true, repos: ['acme/widget'] })

    await expect(service.create({ envId: first.graph.envId })).rejects.toThrow(
      `environment "${first.graph.envId}" already bound to graph "${first.graph.id}"`,
    )
    await expect(service.create({ envId: first.graph.envId })).rejects.toThrow(
      `POST /singularity/graphs/${first.graph.id}/delete`,
    )
  })

  it('rejects invalid mode combinations and an empty workspace', async () => {
    const { service } = harness()
    await expect(service.create({})).rejects.toThrow('provide exactly one of createEnv, envId, workspace')
    await expect(service.create({ envId: 'project1', workspace: 'bb' })).rejects.toThrow('cannot combine')
    await expect(service.create({ createEnv: true, workspace: ' ', repos: ['acme/widget'] })).rejects.toThrow(
      'workspace is empty',
    )
    const { graph } = await service.create({ workspace: 'missing' })
    expect(graph.envId).toBeDefined()
  })

  it('setup prompt keeps installing components planned in a partially set-up env', async () => {
    const { service, store, runtime } = harness()
    const env = store.create()
    store.planComponent(env.id, 'acme/done')
    store.setComponentStatus(env.id, 'acme/done', 'ready')
    store.planComponent(env.id, 'acme/todo')

    const result = await service.create({ envId: env.id })

    expect(result.reused).toBe(true)
    const text = runtime.prompt.mock.calls[0][1][0].text
    expect(text).toContain('Planned repositories: acme/todo.')
    expect(text).toContain('Already present: acme/done.')
    expect(text).toContain('graph_spawn')
  })
})
