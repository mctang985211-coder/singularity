import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

function mockRes() {
  const chunks: string[] = []
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    destroyed: false,
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code
      if (headers) Object.assign(this.headers, headers)
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

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  return req
}

function mockCtx(services: Record<string, unknown>) {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const ctx = {
    ...services,
    webServer: {
      register: ({
        kind,
        path,
        handler,
      }: {
        kind: 'exact' | 'prefix'
        path: string
        handler: Handler
      }) => {
        const key = kind === 'exact' ? path : `${path}/*`
        handlers.set(key, handler)
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
  return { ctx, handlers, listeners }
}

function json(res: ReturnType<typeof mockRes>): unknown {
  return JSON.parse(res.body)
}

const emptySnapshot = {
  version: 1,
  id: 'sg-t-root',
  tasks: [],
  runs: [],
  edges: [],
  evidence: [],
  handoffs: [],
  reviews: [],
  diagnoses: [],
  obligations: [],
  capabilities: {},
}

describe('singularity console routes', () => {
  it('GET /singularity/task serves the native snapshot and answers 404 for an unknown store', async () => {
    const { ctx, handlers } = mockCtx({
      task: {
        openStore: async (id: string) => {
          if (id === 'missing') throw new Error(`task: store "missing" does not exist`)
          return emptySnapshot
        },
      },
    })
    apply(ctx as never)
    const serve = handlers.get('/singularity/task')!

    const ok = mockRes()
    await serve(mockReq('GET', '/singularity/task?storeId=sg-t-root'), ok as never)
    expect(ok.statusCode).toBe(200)
    expect(json(ok)).toEqual({ snapshot: emptySnapshot })

    const missing = mockRes()
    await serve(mockReq('GET', '/singularity/task?storeId=missing'), missing as never)
    expect(missing.statusCode).toBe(404)
    expect(json(missing)).toEqual({ error: 'task: store "missing" does not exist' })

    const malformed = mockRes()
    await serve(mockReq('GET', '/singularity/task'), malformed as never)
    expect(malformed.statusCode).toBe(400)
  })

  it('POST /singularity/task/proposals/decide maps every decision onto the runtime entry it names', async () => {
    const calls: unknown[][] = []
    const runtime = {
      decideProposal: async (...args: unknown[]) => {
        calls.push(['decide', ...args])
      },
      continueProposal: async (...args: unknown[]) => {
        calls.push(['continue', ...args])
      },
      cancelProposal: async (...args: unknown[]) => {
        calls.push(['cancel', ...args])
      },
      readProposal: async () => ({ kind: 'root', identity: { rootSessionId: 's-root' } }),
      recoveryStatus: async () => ({ status: 'ready' }),
    }
    const { ctx, handlers } = mockCtx({ taskRuntime: runtime })
    apply(ctx as never)
    const serve = handlers.get('/singularity/task/proposals/decide')!

    const approved = mockRes()
    await serve(mockReq('POST', '/singularity/task/proposals/decide', {
      storeId: 'sg-t-root',
      proposalId: 'p1',
      decision: 'approve',
      reason: 'looks right',
    }), approved as never)
    expect(approved.statusCode).toBe(200)
    expect(json(approved)).toEqual({ ok: true })
    expect(calls[0]).toEqual(['decide', 'sg-t-root', 'p1', { outcome: 'approved', reason: 'looks right' }, 'operator'])

    await serve(
      mockReq('POST', '/singularity/task/proposals/decide', { storeId: 'sg-t-root', proposalId: 'p2', decision: 'continue' }),
      mockRes() as never,
    )
    expect(calls[1]).toEqual(['continue', 'sg-t-root', 'p2', 's-root'])

    await serve(
      mockReq('POST', '/singularity/task/proposals/decide', { storeId: 'sg-t-root', proposalId: 'p3', decision: 'cancel' }),
      mockRes() as never,
    )
    expect(calls[2]).toEqual(['cancel', 'sg-t-root', 'p3', 's-root'])
  })

  it('POST /singularity/task/proposals/decide answers a domain refusal with 200 and non-2xx only for a malformed request', async () => {
    const runtime = {
      decideProposal: async () => {
        throw new Error('task-runtime: proposal "p1" is not awaiting a decision')
      },
    }
    const { ctx, handlers } = mockCtx({ taskRuntime: runtime })
    apply(ctx as never)
    const serve = handlers.get('/singularity/task/proposals/decide')!

    const refused = mockRes()
    await serve(
      mockReq('POST', '/singularity/task/proposals/decide', { storeId: 'sg-t-root', proposalId: 'p1', decision: 'reject' }),
      refused as never,
    )
    expect(refused.statusCode).toBe(200)
    expect(json(refused)).toEqual({ ok: false, error: 'task-runtime: proposal "p1" is not awaiting a decision' })

    const malformed = mockRes()
    await serve(mockReq('POST', '/singularity/task/proposals/decide', { storeId: 'sg-t-root' }), malformed as never)
    expect(malformed.statusCode).toBe(400)
  })

  it('GET /singularity/evolution serves the ledger, and empty arrays while the chain is off', async () => {
    const proposal = { proposalId: 'evo-1', status: 'decided' }
    const evolution = {
      list: async () => [proposal],
      experiments: async () => [{ experimentId: 'exp-1' }],
      get: async (id: string) => {
        if (id !== 'evo-1') throw new Error(`evolution: unknown proposal "${id}"`)
        return proposal
      },
    }

    const on = mockCtx({ evolution, singularityEvolution: { enabled: true } })
    apply(on.ctx as never)
    const listed = mockRes()
    await on.handlers.get('/singularity/evolution')!(mockReq('GET', '/singularity/evolution'), listed as never)
    expect(listed.statusCode).toBe(200)
    expect(json(listed)).toEqual({ proposals: [proposal], experiments: [{ experimentId: 'exp-1' }] })

    const detail = mockRes()
    await on.handlers.get('/singularity/evolution/*')!(
      mockReq('GET', '/singularity/evolution/evo-1'),
      detail as never,
    )
    expect(detail.statusCode).toBe(200)
    expect(json(detail)).toEqual({ proposal })

    const unknown = mockRes()
    await on.handlers.get('/singularity/evolution/*')!(
      mockReq('GET', '/singularity/evolution/nope'),
      unknown as never,
    )
    expect(unknown.statusCode).toBe(404)
    expect(json(unknown)).toEqual({ error: 'evolution: unknown proposal "nope"' })

    const off = mockCtx({ evolution, singularityEvolution: { enabled: false } })
    apply(off.ctx as never)
    const disabled = mockRes()
    await off.handlers.get('/singularity/evolution')!(mockReq('GET', '/singularity/evolution'), disabled as never)
    expect(disabled.statusCode).toBe(200)
    expect(json(disabled)).toEqual({ proposals: [], experiments: [] })
  })

  it('GET /singularity/recovery pairs the runtime recovery status with a null reconcile report', async () => {
    const state = {
      wokenSessions: ['s-1'],
      pendingNotices: [{ sessionId: 's-1', text: 'the batch settled' }],
      pendingBatchResults: [{ storeId: 'sg-t-root', runId: 'r-1', batchId: 'b-1', sessionId: 's-1', messageId: 'm-1', text: 'done' }],
      cancelled: true,
    }
    const { ctx, handlers } = mockCtx({
      taskRuntime: {
        recoveryStatus: async (id: string) => ({ status: 'recovery-required', reason: `run in ${id}` }),
        recoveryState: (id: string) => (id === 'sg-t-root' ? state : undefined),
      },
    })
    apply(ctx as never)
    const res = mockRes()
    await handlers.get('/singularity/recovery')!(mockReq('GET', '/singularity/recovery?storeId=sg-t-root'), res as never)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({
      recovery: { status: 'recovery-required', reason: 'run in sg-t-root', ...state },
      reconcile: null,
    })

    // A store this process holds no barrier for serves the status alone.
    const bare = mockRes()
    await handlers.get('/singularity/recovery')!(mockReq('GET', '/singularity/recovery?storeId=sg-t-other'), bare as never)
    expect(json(bare)).toEqual({ recovery: { status: 'recovery-required', reason: 'run in sg-t-other' }, reconcile: null })
  })

  it('GET /singularity/review serves the run record and a fresh log tail', async () => {
    const review = {
      taskId: 't1',
      runId: 'r1',
      outcome: 'failed',
      evidenceRefs: [],
      anomalies: [],
      criteria: [{ criterionId: 'c1', verdict: 'fail', logRef: 'sg-t-root/r1/c1.log' }],
    }
    const services = {
      task: { openStore: async () => ({ ...emptySnapshot, reviews: [review] }) },
      verifier: { logTail: async (logRef: string) => `tail of ${logRef}` },
    }
    const { ctx, handlers } = mockCtx(services)
    apply(ctx as never)
    const serve = handlers.get('/singularity/review')!

    const found = mockRes()
    await serve(mockReq('GET', '/singularity/review?storeId=sg-t-root&runId=r1'), found as never)
    expect(found.statusCode).toBe(200)
    expect(json(found)).toEqual({ review, logTail: 'tail of sg-t-root/r1/c1.log' })

    const other = mockRes()
    await serve(mockReq('GET', '/singularity/review?storeId=sg-t-root&runId=r9'), other as never)
    expect(json(other)).toEqual({ review: null, logTail: null })

    const withoutVerifier = mockCtx({ task: services.task })
    apply(withoutVerifier.ctx as never)
    const noVerifier = mockRes()
    await withoutVerifier.handlers.get('/singularity/review')!(
      mockReq('GET', '/singularity/review?storeId=sg-t-root&runId=r1'),
      noVerifier as never,
    )
    expect(json(noVerifier)).toEqual({ review, logTail: null })
  })

  it('forwards task-store changes onto SSE clients as a task frame', async () => {
    const { ctx, handlers, listeners } = mockCtx({
      graphs: {
        get: async () => ({ id: 'graph1' }),
        view: async () => ({ meta: { id: 'graph1' }, graph: {}, layout: {} }),
      },
      hitl: { list: () => [] },
    })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/events')!(mockReq('GET', '/singularity/events?graphId=graph1'), res as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    const forwards = [...(listeners.get('task/change') ?? [])]
    expect(forwards.length).toBe(1)
    forwards[0]!({ id: 'sg-t-root' } as never)
    expect(res.body).toContain('event: task')
    expect(res.body).toContain('"storeId":"sg-t-root"')
  })

  it('forwards ledger changes onto SSE clients as an evolution frame', async () => {
    const { ctx, handlers, listeners } = mockCtx({
      graphs: {
        get: async () => ({ id: 'graph1' }),
        view: async () => ({ meta: { id: 'graph1' }, graph: {}, layout: {} }),
      },
      hitl: { list: () => [] },
    })
    apply(ctx as never)

    const res = mockRes()
    await handlers.get('/singularity/events')!(mockReq('GET', '/singularity/events?graphId=graph1'), res as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    const forwards = [...(listeners.get('evolution/change') ?? [])]
    expect(forwards.length).toBe(1)
    forwards[0]!({ proposalId: 'p-1' } as never)
    expect(res.body).toContain('event: evolution')
    expect(res.body).toContain('"id":"p-1"')
  })
})

describe('singularity model catalog and graph model pin', () => {
  it('GET /singularity/models lists the registered routes and the deployment default, isolating a failed route', async () => {
    const { ctx, handlers } = mockCtx({
      llm: {
        listProviders: () => [
          { id: 'p1', name: 'Provider One' },
          { id: 'p2', name: 'Provider Two' },
        ],
        listModels: async (id: string) => {
          if (id === 'p2') throw new Error('route p2 unreachable')
          return [{ id: 'm1', name: 'Model One' }]
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'high' }) },
    })
    apply(ctx as never)
    const res = mockRes()
    await handlers.get('/singularity/models')!(mockReq('GET', '/singularity/models'), res as never)

    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({
      providers: [
        { id: 'p1', displayName: 'Provider One', models: [{ id: 'm1', name: 'Model One' }] },
        { id: 'p2', displayName: 'Provider Two', models: [], error: 'route p2 unreachable' },
      ],
      default: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    })
  })

  it('POST /singularity/graphs forwards the create body and graph settings to the service', async () => {
    const create = vi.fn(async (body: { model?: unknown; rsi?: unknown }) => ({
      graph: { id: 'graph1', model: body.model, rsi: body.rsi },
      reused: false,
    }))
    const { ctx, handlers } = mockCtx({ graphs: { create } })
    apply(ctx as never)
    const body = {
      createEnv: true,
      repos: ['acme/widget'],
      model: { provider: 'p1', model: 'm1' },
      rsi: { task: 'Improve widget', iterationRounds: 3, humanReview: true },
    }
    const res = mockRes()
    await handlers.get('/singularity/graphs')!(mockReq('POST', '/singularity/graphs', body), res as never)

    expect(res.statusCode).toBe(200)
    expect(create).toHaveBeenCalledExactlyOnceWith(body)
    expect(json(res)).toEqual({ id: 'graph1', model: body.model, rsi: body.rsi, reused: false })
  })

  it('PATCH /singularity/graphs/:id forwards model and RSI pins in one service transaction', async () => {
    const setPins = vi.fn(async (id: string, pins: { model?: unknown; rsi?: unknown }) => {
      if (pins.model === undefined && pins.rsi === undefined) throw new Error('graphs: model or rsi is required')
      return { id, ...pins }
    })
    const { ctx, handlers } = mockCtx({ graphs: { setPins } })
    apply(ctx as never)
    const serve = handlers.get('/singularity/graphs/*')!

    const pinned = mockRes()
    await serve(
      mockReq('PATCH', '/singularity/graphs/graph1', { model: { provider: 'p1', model: 'm1' } }),
      pinned as never,
    )
    expect(pinned.statusCode).toBe(200)
    expect(setPins).toHaveBeenLastCalledWith('graph1', { model: { provider: 'p1', model: 'm1' } })

    const cleared = mockRes()
    await serve(mockReq('PATCH', '/singularity/graphs/graph1', { model: null }), cleared as never)
    expect(setPins).toHaveBeenLastCalledWith('graph1', { model: null })

    const rsi = { task: 'Improve widget', iterationRounds: 2, humanReview: false }
    const configured = mockRes()
    await serve(mockReq('PATCH', '/singularity/graphs/graph1', { rsi }), configured as never)
    expect(configured.statusCode).toBe(200)
    expect(setPins).toHaveBeenLastCalledWith('graph1', { rsi })

    const combined = { model: { provider: 'p1', model: 'm1' }, rsi }
    const updated = mockRes()
    await serve(mockReq('PATCH', '/singularity/graphs/graph1', combined), updated as never)
    expect(updated.statusCode).toBe(200)
    expect(setPins).toHaveBeenLastCalledWith('graph1', combined)
    expect(json(updated)).toEqual({ id: 'graph1', ...combined })

    const stopped = mockRes()
    await serve(mockReq('PATCH', '/singularity/graphs/graph1', { rsi: null }), stopped as never)
    expect(stopped.statusCode).toBe(200)
    expect(setPins).toHaveBeenLastCalledWith('graph1', { rsi: null })

    const missing = mockRes()
    await serve(mockReq('PATCH', '/singularity/graphs/graph1', {}), missing as never)
    expect(missing.statusCode).toBe(400)
    expect(setPins).toHaveBeenCalledTimes(6)
  })
})
