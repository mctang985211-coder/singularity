import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { GraphViewService } from '../../context/src/view/service.ts'
import { registerView } from '../../graph-web/src/web/api/view.ts'
import { GraphBroadcast } from '../../graph-web/src/web/libs/broadcast.ts'
import type { CoordinationAssignmentFacts } from '../../context/src/view/types.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

const GRAPH = {
  id: 'graph1',
  name: 'graph1',
  envId: 'project1',
  rootSessionId: 'root1',
  graphStoreId: 'sg-g-root1',
  layoutStoreId: 'sg-l-root1',
  createdAt: 1,
  ready: true,
  protocol: { id: 'singularity/graph@2', version: 2, since: 1 },
  rsi: { task: 'improve', iterationRounds: 3, humanReview: true, epoch: 1 },
}

const REVISION = {
  revisionId: 'r0002',
  manifestDigest: 'sha256:bb',
  origin: 'published' as const,
  publishedAt: '2026-10-08T02:00:00.000Z',
}

const EVALUATION = {
  state: 'decided' as const,
  reportRef: 'report-2',
  candidateRef: 'd0002',
  decidedAt: '2026-10-08T03:00:00.000Z',
  decision: { kind: 'promote' as const, source: { kind: 'human' as const, actor: 'operator' }, at: '2026-10-08T03:00:00.000Z' },
}

const ASSIGNMENTS: readonly CoordinationAssignmentFacts[] = [
  {
    assignmentId: 'a1',
    role: 'supervisor',
    round: 1,
    sessionId: 's1',
    sourceTaskId: 't1',
    sourceRunId: 'run1',
    state: 'settled',
    completion: {
      businessAction: 'continue',
      searchNext: 'explore',
      methodDecision: 'promote',
      reason: 'round 1 published r0001',
      evidenceRefs: ['receipt:1'],
      at: '2026-10-08T01:00:00.000Z',
    },
  },
  {
    assignmentId: 'a2',
    role: 'supervisor',
    round: 2,
    sessionId: 's2',
    sourceTaskId: 't2',
    sourceRunId: 'run2',
    state: 'open',
  },
]

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

/** A deployment whose read model is served over HTTP, over SSE and to the tools from one source. */
function deployment(overrides: { graph?: unknown; assignments?: readonly CoordinationAssignmentFacts[] } = {}) {
  const ctx = new Context()
  const handlers = new Map<string, Handler>()
  const reads = { revision: 0, evaluation: 0, assignments: 0 }
  const graph = overrides.graph ?? GRAPH
  ctx.provide(
    'graphs',
    {
      get: async (id: string) => {
        if (id !== graph.id) throw new Error(`graphs: unknown graph "${id}"`)
        return graph
      },
      list: async () => [graph],
      view: async (id: string) => {
        const record = await (ctx as never as { graphs: { get(id: string): Promise<unknown> } }).graphs.get(id)
        return {
          meta: record,
          access: { mode: 'current' },
          graph: { version: 1, id: 'sg-g-root1', roots: ['root1'], agents: [{ id: 'root1', name: 'root', status: 'idle' }], edges: [] },
          layout: { version: 1, id: 'sg-l-root1', nodes: {} },
        }
      },
    } as never,
  )
  ctx.provide(
    'webServer',
    {
      register: ({ kind, path, handler }: { kind: 'exact' | 'prefix'; path: string; handler: Handler }) => {
        handlers.set(kind === 'exact' ? path : `${path}/*`, handler)
        return () => handlers.delete(path)
      },
    } as never,
  )
  const service = new GraphViewService(ctx)
  service.registerCoordinationFacts({
    assignments: async () => {
      reads.assignments += 1
      return overrides.assignments ?? ASSIGNMENTS
    },
  })
  service.registerMethodFacts({
    activeRevision: async () => {
      reads.revision += 1
      return REVISION
    },
    latestEvaluation: async () => {
      reads.evaluation += 1
      return EVALUATION
    },
  })
  registerView(ctx)
  return { ctx, service, handlers, reads }
}

async function httpView(handlers: Map<string, Handler>): Promise<{ status: number; body: unknown }> {
  const res = mockRes()
  await handlers.get('/singularity/view')!(mockReq('GET', '/singularity/view?graphId=graph1'), res as unknown as ServerResponse)
  return { status: res.statusCode, body: res.statusCode === 200 ? JSON.parse(res.body) : res.body }
}

describe('one read model behind every transport', () => {
  it('serves the tool plane the identical revision, evaluation and progress the HTTP route serves', async () => {
    const { service, handlers, reads } = deployment()

    const http = await httpView(handlers)
    const tool = await service.view('graph1')

    expect(http.status).toBe(200)
    // Field by field: the Web route adds nothing and drops nothing.
    expect(http.body).toEqual(tool)
    expect(tool).toMatchObject({
      formatVersion: 2,
      graph: { id: 'graph1', name: 'graph1', createdAt: 1 },
      access: { mode: 'current' },
      revision: REVISION,
      evaluation: EVALUATION,
      progress: { round: 2, rounds: 3, phase: 'running' },
    })
    // The projection is what the fact producers answered, not a recomputation.
    expect(reads).toEqual({ revision: 1, evaluation: 1, assignments: 1 })
  })

  it('carries the same projection on the SSE frame a canvas client already holds', async () => {
    const { ctx, service, handlers } = deployment()
    const broadcast = new GraphBroadcast(ctx)
    const res = mockRes()
    broadcast.subscribe(res as unknown as ServerResponse, 'graph1')
    await new Promise(resolve => setTimeout(resolve, 0))

    const frame = /event: snapshot\ndata: (.*)\n\n/.exec(res.body)
    expect(frame).not.toBeNull()
    const parsed = JSON.parse(frame![1]!) as { graphView: unknown; access: unknown; graph: unknown; layout: unknown }
    expect(parsed.graphView).toEqual(await service.view('graph1'))
    expect(parsed.access).toEqual({ mode: 'current' })
    expect(parsed.graph).toMatchObject({ agents: [{ id: 'root1' }] })
    expect(parsed.layout).toMatchObject({ nodes: {} })

    // The HTTP route and the frame cannot disagree: same source, same facts.
    expect(parsed.graphView).toEqual((await httpView(handlers)).body)
  })

  it('moves both transports together when the facts move, and refuses by name when a producer is missing', async () => {
    const { ctx, service, handlers } = deployment()
    const before = await service.view('graph1')
    service.registerMethodFacts({
      activeRevision: async () => ({ ...REVISION, revisionId: 'r0003' }),
      latestEvaluation: async () => EVALUATION,
    })
    const after = await service.view('graph1')
    const http = await httpView(handlers)
    expect(after.revision).toEqual({ ...REVISION, revisionId: 'r0003' })
    expect((http.body as { revision: unknown }).revision).toEqual(after.revision)
    expect(after.generation).not.toBe(before.generation)

    const bare = new Context()
    bare.provide('graphs', { get: async () => GRAPH, list: async () => [GRAPH] } as never)
    bare.provide(
      'webServer',
      { register: () => () => {} } as never,
    )
    const bareService = new GraphViewService(bare)
    bareService.registerMethodFacts({
      activeRevision: async () => REVISION,
      latestEvaluation: async () => EVALUATION,
    })
    await expect(bareService.view('graph1')).rejects.toMatchObject({ code: 'read-source-unavailable', source: 'coordination' })
    bareService.registerCoordinationFacts({ assignments: async () => ASSIGNMENTS })
    await expect(bareService.view('graph1')).resolves.toMatchObject({ progress: { round: 2 } })
    // The one source is the service this deployment mounted, under its own name.
    expect((ctx.get('singularityGraphView') as unknown as { name: string }).name).toBe('singularityGraphView')
  })
})
