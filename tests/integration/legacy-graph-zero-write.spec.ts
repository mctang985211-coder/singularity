import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { GraphsService } from '../../graphs/src/index.ts'
import { GraphService } from '../../graph/src/index.ts'
import { LayoutService } from '../../graph/src/layout.ts'
import { TaskService } from '../../task/src/index.ts'
import { registerGraph, registerLayout } from '../../graph-web/src/web/api/routes.ts'
import { registerGraphs } from '../../graph-web/src/web/api/graphs.ts'
import { registerTask } from '../../graph-web/src/web/api/task.ts'
import { registerView } from '../../graph-web/src/web/api/view.ts'
import type { GraphViewReader } from '../../graph-web/src/web/api/view.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** The legacy graph this deployment still holds: no protocol marker, so it is sealed history. */
const LEGACY_GRAPH = {
  id: 'legacy1',
  name: 'legacy1',
  envId: 'project1',
  rootSessionId: 'root-legacy' as SessionId,
  graphStoreId: 'sg-g-root-legacy',
  layoutStoreId: 'sg-l-root-legacy',
  createdAt: 1,
  ready: true,
}

const REGISTRY = 'graphs-registry'
const TASK_STORE = 'sg-t-root-legacy'

/**
 * A session persistence that keeps its sessions in memory and counts every call
 * that could create or extend one. `create` and `append` are the master gate:
 * a read that touches either has written to the store it was only supposed to
 * look at.
 */
class CountedPersistence {
  readonly sessions = new Map<string, SessionEvent[]>()
  readonly createCalls: string[] = []
  readonly appendCalls: { readonly id: string; readonly events: number }[] = []
  readonly opens: { readonly id: string; readonly mode: string }[] = []

  constructor(seed: Record<string, SessionEvent[]>) {
    for (const [id, events] of Object.entries(seed)) this.sessions.set(id, structuredClone(events))
  }

  async list(): Promise<{ header: { id: string } }[]> {
    return [...this.sessions.keys()].map(id => ({ header: { id } }))
  }

  async create(header: { id: string }): Promise<unknown> {
    this.createCalls.push(header.id)
    this.sessions.set(header.id, [])
    return this.handle(header.id)
  }

  async open(id: string, mode: string): Promise<unknown> {
    this.opens.push({ id, mode })
    if (!this.sessions.has(id)) throw new Error(`session-persistence: session "${id}" does not exist`)
    return this.handle(id)
  }

  private handle(id: string): unknown {
    return {
      read: async () => ({ events: structuredClone(this.sessions.get(id) ?? []) }),
      append: async (records: readonly SessionEvent[]) => {
        this.appendCalls.push({ id, events: records.length })
        this.sessions.set(id, [...(this.sessions.get(id) ?? []), ...structuredClone([...records])])
      },
      flush: async () => {},
      close: async () => {},
    }
  }
}

function seed(): Record<string, SessionEvent[]> {
  const event = (type: string, data: unknown, seq: number): SessionEvent =>
    ({ type, seq, time: 1, data, ignorable: true }) as unknown as SessionEvent
  return {
    [REGISTRY]: [
      event('graphs/event', { kind: 'graph/add', graph: LEGACY_GRAPH }, 0),
      event('graphs/event', { kind: 'graph/select', id: LEGACY_GRAPH.id }, 1),
    ],
    // The topology and layout of the old graph exist on disk; its task store does not.
    [LEGACY_GRAPH.graphStoreId]: [
      event('graph/event', { kind: 'agent/add', agent: { id: 'root-legacy', name: 'Legacy root', status: 'idle' }, root: true }, 0),
    ],
    // The two default stores every graph/layout service holds open; they exist already.
    'graph-idle': [],
    'layout-idle': [],
    [LEGACY_GRAPH.layoutStoreId]: [
      event('layout/event', { kind: 'node/set', sessionId: 'root-legacy', node: { x: 1, y: 2, width: 3, height: 4, shape: 'card' } }, 0),
    ],
  }
}

function mockRes() {
  const chunks: string[] = []
  return {
    statusCode: 0,
    body: '',
    destroyed: false,
    writeHead(status: number) {
      this.statusCode = status
    },
    write(chunk: string) {
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

function mockReq(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  return req
}

/** The console's read model, as the coordination and method planes would register it. */
const VIEW: GraphViewReader = {
  view: async () => ({
    formatVersion: 2,
    graph: { id: LEGACY_GRAPH.id, name: LEGACY_GRAPH.name, createdAt: 1 },
    access: { mode: 'current' },
    revision: null,
    evaluation: null,
    progress: { round: 0, rounds: 0, phase: 'idle' },
    generation: 1,
  }),
  summaries: async () => [],
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'legacy-zero-write-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

interface Console {
  readonly ctx: Context
  readonly persistence: CountedPersistence
  readonly handlers: Map<string, Handler>
  readonly graphs: GraphsService
}

/** A running deployment holding one sealed legacy graph, wired by its real services. */
function console_(): Console {
  const ctx = new Context()
  const persistence = new CountedPersistence(seed())
  const handlers = new Map<string, Handler>()
  const services: Record<string, unknown> = {
    sessionPersistence: persistence,
    envBuilder: { store: { get: () => ({ components: [] }) } },
    // The library root a legacy history resolves its old ledger through; nothing else of the runtime is touched.
    taskRuntime: { config: {} },
    hitl: { list: () => [] },
    singularityGraphView: VIEW,
    webServer: {
      register: ({ kind, path, handler }: { kind: 'exact' | 'prefix'; path: string; handler: Handler }) => {
        const key = kind === 'exact' ? path : `${path}/*`
        handlers.set(key, handler)
        return () => handlers.delete(key)
      },
    },
  }
  for (const [name, value] of Object.entries(services)) ctx.provide(name as never, value as never)
  const graph = new GraphService(ctx)
  const layout = new LayoutService(ctx)
  const task = new TaskService(ctx)
  const graphs = new GraphsService(ctx)
  registerGraph(ctx)
  registerLayout(ctx)
  registerGraphs(ctx)
  registerView(ctx)
  registerTask(ctx)
  return { ctx, persistence, handlers, graphs }
}

/** Run one route against the console, as an HTTP client would. */
async function call(console: Console, key: string, method: string, url: string): Promise<ReturnType<typeof mockRes>> {
  const res = mockRes()
  await console.handlers.get(key)!(mockReq(method, url), res as unknown as ServerResponse)
  return res
}

describe('a sealed legacy graph is read, and only read', () => {
  it('answers list, canvas, layout, history, task and the tool reads without one write', async () => {
    const console = console_()
    // Setup is not the subject: every counter starts from here.
    console.persistence.createCalls.length = 0
    console.persistence.appendCalls.length = 0
    console.persistence.opens.length = 0
    const registryBefore = structuredClone(console.persistence.sessions.get(REGISTRY))

    // 1. the registry list
    const listed = await call(console, '/singularity/graphs', 'GET', '/singularity/graphs')
    expect(listed.statusCode).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({
      graphs: [{ id: 'legacy1', access: { mode: 'legacy-readonly' } }],
    })

    // 2. the canvas projection
    const canvas = await call(console, '/singularity/graph', 'GET', '/singularity/graph?graphId=legacy1')
    expect(canvas.statusCode).toBe(200)
    expect(JSON.parse(canvas.body)).toMatchObject({
      access: { mode: 'legacy-readonly' },
      graph: { agents: [{ id: 'root-legacy' }] },
    })

    // 3. the layout read
    const layoutRead = await call(console, '/singularity/layout', 'GET', '/singularity/layout?graphId=legacy1')
    expect(layoutRead.statusCode).toBe(200)
    expect(JSON.parse(layoutRead.body)).toMatchObject({ nodes: { 'root-legacy': { x: 1 } } })

    // 4. the legacy history
    const history = await call(console, '/singularity/graphs/*', 'GET', '/singularity/graphs/legacy1/history')
    expect(history.statusCode).toBe(200)
    expect(JSON.parse(history.body)).toMatchObject({
      writable: false,
      access: { mode: 'legacy-readonly' },
      sources: [
        { id: LEGACY_GRAPH.graphStoreId, kind: 'topology', exists: true },
        { id: LEGACY_GRAPH.layoutStoreId, kind: 'layout', exists: true },
        { id: TASK_STORE, kind: 'tasks', exists: false },
      ],
      tasks: null,
    })

    // 5. the console's task read, of a store this graph never created
    const taskRead = await call(console, '/singularity/task', 'GET', `/singularity/task?storeId=${TASK_STORE}`)
    expect(taskRead.statusCode).toBe(200)
    expect(JSON.parse(taskRead.body)).toEqual({ snapshot: null })

    // 6. the view route refuses the sealed graph before reading anything
    const view = await call(console, '/singularity/view', 'GET', '/singularity/view?graphId=legacy1')
    expect(view.statusCode).toBe(409)
    expect(JSON.parse(view.body)).toMatchObject({ error: 'graph-sealed', history: '/singularity/graphs/legacy1/history' })

    // 7. selecting it is refused: zero commits, and the registry never moved
    const selected = await call(console, '/singularity/graphs/*', 'POST', '/singularity/graphs/legacy1/select')
    expect(selected.statusCode).toBe(409)
    expect(JSON.parse(selected.body)).toMatchObject({ error: 'graph-sealed' })

    // 8. the tool-side reads: membership and the graph projection the tools use
    await expect(console.graphs.graphForSession('not-here' as SessionId)).rejects.toThrow('not in a graph')
    expect(await console.graphs.graphForSession('root-legacy' as SessionId)).toMatchObject({ id: 'legacy1' })
    expect(await console.graphs.view('legacy1')).toMatchObject({ access: { mode: 'legacy-readonly' } })

    // The master gate: nothing was created and nothing was appended.
    expect(console.persistence.createCalls).toEqual([])
    expect(console.persistence.appendCalls).toEqual([])
    // Every read of the legacy graph used the `'read'` lease, in the fixed order of
    // the routes above: canvas (topology, layout), layout, history (topology, layout),
    // membership, and the tool-side projection (topology, layout). The only `'write'`
    // open is the graphs registry itself, the store this process owns and commits to.
    // A store that does not exist — this graph's task store — is never opened at all.
    expect(console.persistence.opens).toEqual([
      // The two default stores the graph and layout services hold open by construction.
      { id: 'graph-idle', mode: 'write' },
      { id: 'layout-idle', mode: 'write' },
      { id: REGISTRY, mode: 'write' },
      { id: LEGACY_GRAPH.graphStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.layoutStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.layoutStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.graphStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.layoutStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.graphStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.graphStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.graphStoreId, mode: 'read' },
      { id: LEGACY_GRAPH.layoutStoreId, mode: 'read' },
    ])
    expect(console.persistence.createCalls).not.toContain(TASK_STORE)
    // The registry itself is untouched.
    expect(console.persistence.sessions.get(REGISTRY)).toEqual(registryBefore)
  })

  it('archives a sealed graph from the registry alone, stopping nothing and cleaning nothing', async () => {
    const console = console_()
    console.persistence.createCalls.length = 0
    console.persistence.appendCalls.length = 0

    const removed = await call(console, '/singularity/graphs/*', 'POST', '/singularity/graphs/legacy1/delete')
    expect(removed.statusCode).toBe(200)
    expect(JSON.parse(removed.body)).toEqual({ ok: true })

    // Archiving is one registry append; no store of the legacy graph is written.
    expect(console.persistence.appendCalls).toEqual([{ id: REGISTRY, events: 1 }])
    expect(console.persistence.createCalls).toEqual([])
    const snapshot = await console.graphs.snapshot()
    expect(snapshot.graphs).toEqual([])
    expect(snapshot.archives.map(archive => archive.graph.id)).toEqual(['legacy1'])
    expect(snapshot.selectedId).toBeUndefined()
  })

  it('keeps a sealed graph out of the boot activation, so a restart writes nothing either', async () => {
    const console = console_()
    // The registry records the legacy graph as selected; the boot effect must not take it over.
    await vi.waitFor(() => expect(console.persistence.opens.length).toBeGreaterThan(0))
    expect(console.persistence.createCalls).toEqual([])
    expect(console.persistence.appendCalls).toEqual([])
    expect((await console.graphs.snapshot()).selectedId).toBe('legacy1')
  })
})
