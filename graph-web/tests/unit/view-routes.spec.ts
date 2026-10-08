import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphSealedError } from '@dangosys/dsh-singularity-graphs'
import { apply } from '../../src/index.ts'
import { legacyCompletionOf } from '../../src/web/api/history.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

function mockRes() {
  const chunks: string[] = []
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    destroyed: false,
    written: [] as string[],
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code
      if (headers) Object.assign(this.headers, headers)
    },
    write(chunk: string) {
      this.written.push(chunk)
      chunks.push(chunk)
      this.body = chunks.join('')
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk)
      this.body = chunks.join('')
    },
    on() {},
    destroy() {},
  }
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  return req
}

function mockCtx(services: Record<string, unknown>) {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const registered: string[] = []
  const ctx = {
    ...services,
    webServer: {
      register: ({ kind, path, handler }: { kind: 'exact' | 'prefix'; path: string; handler: Handler }) => {
        const key = kind === 'exact' ? path : `${path}/*`
        handlers.set(key, handler)
        registered.push(key)
        return () => handlers.delete(key)
      },
    },
    on(event: string, listener: (...args: never[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    effect(run: () => void | (() => void)) {
      const cleanup = run()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    get(name: string) {
      return services[name]
    },
  }
  return { ctx, handlers, listeners, registered }
}

function json(res: ReturnType<typeof mockRes>): unknown {
  return JSON.parse(res.body)
}

const CURRENT = {
  id: 'graph1',
  name: 'graph1',
  envId: 'project1',
  rootSessionId: 'root1',
  graphStoreId: 'sg-g-root1',
  layoutStoreId: 'sg-l-root1',
  createdAt: 1,
  ready: true,
  protocol: { id: 'singularity/graph@2', version: 2, since: 1 },
}

const LEGACY = {
  id: 'graph0',
  name: 'graph0',
  envId: 'project0',
  rootSessionId: 'root0',
  graphStoreId: 'sg-g-root0',
  layoutStoreId: 'sg-l-root0',
  createdAt: 1,
  ready: true,
}

const WIRE = {
  formatVersion: 2,
  graph: { id: 'graph1', name: 'graph1', createdAt: 1 },
  access: { mode: 'current' },
  revision: { revisionId: 'r0001', manifestDigest: 'sha256:aa', origin: 'published', publishedAt: '2026-10-08T00:00:00.000Z' },
  evaluation: {
    state: 'decided',
    reportRef: 'report-1',
    candidateRef: 'd0001',
    decidedAt: '2026-10-08T01:00:00.000Z',
    decision: { kind: 'promote', source: { kind: 'human', actor: 'operator' }, at: '2026-10-08T01:00:00.000Z' },
  },
  progress: { round: 2, rounds: 3, phase: 'running', note: 'candidate published' },
  generation: 7,
}

/** The console's own graph view service, as a deployment mounts it. */
function viewService(overrides: Partial<{ view(id: string): Promise<unknown>; summaries(): Promise<readonly unknown[]> }> = {}) {
  return {
    view: vi.fn(async (_id: string) => WIRE),
    summaries: vi.fn(async () => [WIRE]),
    ...overrides,
  }
}

/** The three read doors one legacy history draws on, each counting its own reads. */
function doors() {
  const graphSnapshots: string[] = []
  const layoutSnapshots: string[] = []
  const taskSnapshots: string[] = []
  return {
    graphSnapshots,
    layoutSnapshots,
    taskSnapshots,
    graph: {
      snapshotReadOnlyIn: async (id: string) => {
        graphSnapshots.push(id)
        return { exists: true, snapshot: { version: 1, id, roots: ['root0'], agents: [{ id: 'root0', name: 'root', status: 'idle' }], edges: [] } }
      },
    },
    layout: {
      snapshotReadOnlyIn: async (id: string) => {
        layoutSnapshots.push(id)
        return { exists: true, snapshot: { version: 1, id, nodes: { root0: { x: 1, y: 2, width: 3, height: 4, shape: 'card' } } } }
      },
    },
    task: {
      snapshotReadOnly: async (id: string) => {
        taskSnapshots.push(id)
        return { exists: false }
      },
    },
  }
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'view-routes-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('singularity view route', () => {
  it('serves the one read model the tool plane reads, and its summary projection', async () => {
    const service = viewService()
    const { ctx, handlers } = mockCtx({ graphs: { get: async () => CURRENT }, singularityGraphView: service })
    apply(ctx as never)

    const full = mockRes()
    await handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view?graphId=graph1'), full as never)
    expect(full.statusCode).toBe(200)
    expect(json(full)).toEqual(WIRE)
    expect(service.view).toHaveBeenCalledExactlyOnceWith('graph1')

    const summary = mockRes()
    await handlers.get('/singularity/view')!(
      mockReq('GET', '/singularity/view?graphId=graph1&summary=1'),
      summary as never,
    )
    expect(json(summary)).toEqual({
      formatVersion: 2,
      graph: WIRE.graph,
      access: { mode: 'current' },
      progress: WIRE.progress,
      generation: 7,
    })

    const missing = mockRes()
    await handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view'), missing as never)
    expect(missing.statusCode).toBe(400)
  })

  it('answers a sealed graph with its own history pointer instead of a current-protocol view', async () => {
    const service = viewService()
    const { ctx, handlers } = mockCtx({ graphs: { get: async () => LEGACY }, singularityGraphView: service })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view?graphId=graph0'), res as never)
    expect(res.statusCode).toBe(409)
    expect(json(res)).toMatchObject({ error: 'graph-sealed', graphId: 'graph0', history: '/singularity/graphs/graph0/history' })
    // A sealed graph never reaches the read model: nothing is asked of it.
    expect(service.view).not.toHaveBeenCalled()
  })

  it('names the missing fact producer as a 503 rather than answering a default', async () => {
    const refusing = viewService({
      view: async () => {
        const error = new Error('no coordination fact source is registered in this deployment') as Error & {
          code: string
          source: string
        }
        error.code = 'read-source-unavailable'
        error.source = 'coordination'
        throw error
      },
    })
    const { ctx, handlers } = mockCtx({ graphs: { get: async () => CURRENT }, singularityGraphView: refusing })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view?graphId=graph1'), res as never)
    expect(res.statusCode).toBe(503)
    expect(json(res)).toEqual({
      error: 'no coordination fact source is registered in this deployment',
      source: 'coordination',
    })

    const bare = mockCtx({ graphs: { get: async () => CURRENT } })
    apply(bare.ctx as never)
    const unmounted = mockRes()
    await bare.handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view?graphId=graph1'), unmounted as never)
    expect(unmounted.statusCode).toBe(503)
    expect(json(unmounted)).toMatchObject({ source: 'graph-view' })
  })
})

describe('singularity graphs list', () => {
  it('serves each record its access mode and the read model its own id holds', async () => {
    const service = viewService({
      summaries: async () => [WIRE],
      view: async () => WIRE,
    })
    const { ctx, handlers } = mockCtx({
      graphs: { snapshot: async () => ({ version: 1, graphs: [CURRENT, LEGACY], archives: [], selectedId: null }) },
      envBuilder: {
        store: {
          get: (id: string) => ({ components: [{ owner: 'acme', repo: id === 'project1' ? 'widget' : 'legacy' }] }),
        },
      },
      singularityGraphView: service,
    })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/graphs')!(mockReq('GET', '/singularity/graphs'), res as never)
    expect(res.statusCode).toBe(200)
    const body = json(res) as { graphs: Record<string, unknown>[] }
    expect(body.graphs[0]).toMatchObject({
      id: 'graph1',
      access: { mode: 'current' },
      repos: ['acme/widget'],
      progress: WIRE.progress,
      evaluation: WIRE.evaluation,
    })
    expect(body.graphs[1]).toMatchObject({ id: 'graph0', access: { mode: 'legacy-readonly' }, repos: ['acme/legacy'] })
    expect(body.graphs[1]!.progress).toBeUndefined()
  })

  it('names the refused producer in the list instead of pretending every graph is facts-free', async () => {
    const service = viewService({
      summaries: async () => {
        throw Object.assign(new Error('no method fact source is registered in this deployment'), {
          code: 'read-source-unavailable',
          source: 'method',
        })
      },
    })
    const { ctx, handlers } = mockCtx({
      graphs: { snapshot: async () => ({ version: 1, graphs: [CURRENT], archives: [], selectedId: null }) },
      envBuilder: { store: { get: () => ({ components: [] }) } },
      singularityGraphView: service,
    })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/graphs')!(mockReq('GET', '/singularity/graphs'), res as never)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({
      viewError: { source: 'method', error: 'no method fact source is registered in this deployment' },
      graphs: [{ id: 'graph1', access: { mode: 'current' } }],
    })
  })
})

describe('singularity legacy history route', () => {
  it('projects a sealed graph read-only through the zero-write doors', async () => {
    const door = doors()
    writeFileSync(join(home, 'legacy-ledger.jsonl'), '')
    mkdirSync(join(home, 'review-agents'), { recursive: true })
    writeFileSync(
      join(home, 'review-agents', 'agents.jsonl'),
      [
        JSON.stringify({ kind: 'settled', rootStoreId: 'sg-t-root0', taskId: 't1', sessionId: 's1', status: 'closed', note: 'closed: the holdout held', at: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ kind: 'claim', rootStoreId: 'sg-t-root0', taskId: 't2', sessionId: 's2' }),
        JSON.stringify({ kind: 'settled', rootStoreId: 'sg-t-other', taskId: 't3', sessionId: 's3', note: 'closed: another graph' }),
      ].join('\n'),
    )
    const { ctx, handlers } = mockCtx({
      graphs: { get: async () => LEGACY },
      graph: door.graph,
      layout: door.layout,
      task: door.task,
    })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/graphs/*')!(mockReq('GET', '/singularity/graphs/graph0/history'), res as never)
    expect(res.statusCode).toBe(200)
    const body = json(res) as Record<string, unknown>
    expect(body).toMatchObject({
      formatVersion: 'legacy-v1',
      writable: false,
      access: { mode: 'legacy-readonly' },
      graph: { id: 'graph0' },
      sources: [
        { id: 'sg-g-root0', kind: 'topology', exists: true },
        { id: 'sg-l-root0', kind: 'layout', exists: true },
        { id: 'sg-t-root0', kind: 'tasks', exists: false },
      ],
      tasks: null,
      completions: [
        {
          format: 'legacy-v1',
          sessionId: 's1',
          taskId: 't1',
          note: 'closed: the holdout held',
          recordedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    expect((body.topology as { agents: unknown[] }).agents).toHaveLength(1)
    // Every store is read through its zero-write door, in the fixed order.
    expect(door.graphSnapshots).toEqual(['sg-g-root0'])
    expect(door.layoutSnapshots).toEqual(['sg-l-root0'])
    expect(door.taskSnapshots).toEqual(['sg-t-root0'])
  })

  it('refuses a current-protocol graph with a pointer to the view route', async () => {
    const door = doors()
    const { ctx, handlers } = mockCtx({ graphs: { get: async () => CURRENT }, graph: door.graph, layout: door.layout, task: door.task })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/graphs/*')!(mockReq('GET', '/singularity/graphs/graph1/history'), res as never)
    expect(res.statusCode).toBe(409)
    expect(json(res)).toEqual({ error: 'graph-not-sealed', graphId: 'graph1', view: '/singularity/view?graphId=graph1' })
    expect(door.graphSnapshots).toEqual([])
  })

  it('names the missing task store rather than reading a legacy history without one', async () => {
    const door = doors()
    const { ctx, handlers } = mockCtx({ graphs: { get: async () => LEGACY }, graph: door.graph, layout: door.layout })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/graphs/*')!(mockReq('GET', '/singularity/graphs/graph0/history'), res as never)
    expect(res.statusCode).toBe(503)
    expect(json(res)).toMatchObject({ source: 'task', error: expect.stringContaining('no task store') })
  })

  it('reads one old review ledger row as a legacy completion, and anything else as nothing', () => {
    expect(
      legacyCompletionOf({ kind: 'settled', rootStoreId: 'sg-t-root', taskId: 't1', sessionId: 's1', note: 'blocked: no key', at: 'x' }, 'sg-t-root'),
    ).toEqual({ format: 'legacy-v1', sessionId: 's1', taskId: 't1', note: 'blocked: no key', recordedAt: 'x' })
    expect(legacyCompletionOf({ kind: 'settled', rootStoreId: 'sg-t-other', taskId: 't1', sessionId: 's1', note: 'x' }, 'sg-t-root')).toBeUndefined()
    expect(legacyCompletionOf({ kind: 'settled', rootStoreId: 'sg-t-root', taskId: 't1', sessionId: 's1' }, 'sg-t-root')).toBeUndefined()
    expect(legacyCompletionOf({ kind: 'claim', rootStoreId: 'sg-t-root', taskId: 't1', sessionId: 's1', note: 'x' }, 'sg-t-root')).toBeUndefined()
    expect(legacyCompletionOf('not a row', 'sg-t-root')).toBeUndefined()
  })
})

describe('singularity legacy write gates', () => {
  it('refuses a layout write on a sealed graph and still reads its layout through the door', async () => {
    const door = doors()
    const setIn = vi.fn()
    const { ctx, handlers } = mockCtx({
      graphs: { get: async () => LEGACY },
      graph: door.graph,
      layout: { ...door.layout, setIn, snapshotIn: async () => ({ version: 1, id: 'sg-l-root0', nodes: {} }) },
      task: door.task,
    })
    apply(ctx as never)

    const read = mockRes()
    await handlers.get('/singularity/layout')!(mockReq('GET', '/singularity/layout?graphId=graph0'), read as never)
    expect(read.statusCode).toBe(200)
    expect(json(read)).toMatchObject({ id: 'sg-l-root0' })

    const write = mockRes()
    await handlers.get('/singularity/layout')!(
      mockReq('PUT', '/singularity/layout?graphId=graph0', { sessionId: 'root0', node: { x: 9, y: 9, width: 1, height: 1, shape: 'card' } }),
      write as never,
    )
    expect(write.statusCode).toBe(409)
    expect(json(write)).toMatchObject({ error: 'graph-sealed', graphId: 'graph0' })
    expect(setIn).not.toHaveBeenCalled()
  })

  it('refuses select and ready on a sealed graph before the registry is asked to commit anything', async () => {
    const select = vi.fn(async () => {
      throw new Error('graphs: graph "graph0" is sealed legacy history')
    })
    const markReady = vi.fn()
    const { ctx, handlers } = mockCtx({
      graphs: { get: async () => LEGACY, select, markReady },
      graph: doors().graph,
      layout: doors().layout,
      task: doors().task,
    })
    apply(ctx as never)

    const selected = mockRes()
    await handlers.get('/singularity/graphs/*')!(mockReq('POST', '/singularity/graphs/graph0/select'), selected as never)
    expect(selected.statusCode).toBe(400)
    expect(select).toHaveBeenCalledOnce()

    // The sealed refusal the service raises is answered 409 with the history pointer, not a bare 400.
    const sealed = new GraphSealedError('graph0')
    const refusing = mockCtx({
      graphs: {
        get: async () => LEGACY,
        select: async () => {
          throw sealed
        },
        markReady: async () => {
          throw sealed
        },
      },
      graph: doors().graph,
      layout: doors().layout,
      task: doors().task,
    })
    apply(refusing.ctx as never)
    const res = mockRes()
    await refusing.handlers.get('/singularity/graphs/*')!(mockReq('POST', '/singularity/graphs/graph0/select'), res as never)
    expect(res.statusCode).toBe(409)
    expect(json(res)).toMatchObject({ error: 'graph-sealed', graphId: 'graph0', history: '/singularity/graphs/graph0/history' })
    expect(markReady).not.toHaveBeenCalled()
  })
})
