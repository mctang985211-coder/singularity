import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasNode } from '@dangosys/dsh-singularity-graph'
import type { HitlAnswer } from '@dangosys/dsh-singularity-agent'
import { EVENTS_PATH, GRAPH_PATH, HITL_PATH, LAYOUT_PATH } from '../../constants.ts'
import type { GraphBroadcast } from '../libs/broadcast.ts'
import { fail, graphIdOf, guardMethod, readJson, sendJson } from '../libs/http.ts'

interface LayoutPutBody {
  readonly sessionId: SessionId
  readonly node: CanvasNode
}

export function registerGraph(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: GRAPH_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      try {
        sendJson(res, 200, await ctx.graphs.view(graphIdOf(req, 'graph')))
      } catch (error) {
        fail(res, error, 409)
      }
    },
  })
}

export function registerEvents(ctx: Context, broadcast: GraphBroadcast): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      const graph = await ctx.graphs.get(graphIdOf(req, 'events'))
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.on('close', () => broadcast.clients.delete(res))
      broadcast.subscribe(res, graph)
      res.write(`event: hitl\ndata: ${JSON.stringify({ pending: ctx.hitl.list() })}\n\n`)
    },
  })
}

export function registerHitl(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: HITL_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET', 'POST')) return
      if (req.method === 'GET') {
        sendJson(res, 200, { pending: ctx.hitl.list() })
        return
      }
      const body = await readJson<{ id: string; answer: HitlAnswer }>(req)
      if (typeof body.id !== 'string' || body.id.length === 0) throw new Error('hitl: missing id')
      if (body.answer === undefined) throw new Error('hitl: missing answer')
      ctx.hitl.answer(body.id, body.answer)
      sendJson(res, 200, { ok: true, pending: ctx.hitl.list() })
    },
  })
}

export function registerLayout(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: LAYOUT_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const graph = await ctx.graphs.get(graphIdOf(req, 'layout'))
        if (req.method === 'GET') {
          sendJson(res, 200, await ctx.layout.snapshotIn(graph.layoutStoreId))
          return
        }
        if (!guardMethod(req, res, 'PUT')) return
        const body = await readJson<LayoutPutBody>(req)
        if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
          throw new Error('layout put: sessionId required')
        }
        if (body.node === undefined || typeof body.node !== 'object') {
          throw new Error('layout put: node required')
        }
        const topology = await ctx.graph.snapshotIn(graph.graphStoreId)
        if (!topology.agents.some(agent => agent.id === body.sessionId))
          throw new Error('layout: session belongs to another graph')
        await ctx.layout.setIn(graph.layoutStoreId, body.sessionId, body.node)
        sendJson(res, 200, await ctx.layout.snapshotIn(graph.layoutStoreId))
      } catch (error) {
        fail(res, error)
      }
    },
  })
}
