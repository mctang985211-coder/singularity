import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CreateGraphRequest, GraphPinsUpdate } from '@dangosys/dsh-singularity-graphs'
import { GRAPHS_PATH } from '../../constants.ts'
import { fail, guardMethod, readJson, sendJson, urlOf } from '../libs/http.ts'

export function registerGraphs(ctx: Context): () => void {
  const stopList = ctx.webServer.register({
    kind: 'exact',
    path: GRAPHS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!guardMethod(req, res, 'GET', 'POST')) return
        if (req.method === 'GET') {
          const snapshot = await ctx.graphs.snapshot()
          sendJson(res, 200, {
            ...snapshot,
            graphs: snapshot.graphs.map(graph => ({
              ...graph,
              repos: ctx.envBuilder.store
                .get(graph.envId)
                .components.map(component => `${component.owner}/${component.repo}`),
            })),
          })
          return
        }
        const body = await readJson<CreateGraphRequest>(req)
        const { graph, reused } = await ctx.graphs.create(body)
        sendJson(res, 200, { ...graph, reused })
      } catch (error) {
        fail(res, error)
      }
    },
  })

  const stopActions = ctx.webServer.register({
    kind: 'prefix',
    path: GRAPHS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = urlOf(req)
        const parts = url.pathname
          .slice(GRAPHS_PATH.length + 1)
          .split('/')
          .filter(Boolean)
        const [id, action] = parts
        if (id === undefined || id.length === 0) throw new Error('graphs: missing graph id')

        if (parts.length === 1) {
          // The graph's pins: `null` clears the model (back to the deployment default) or the RSI config.
          if (!guardMethod(req, res, 'PATCH')) return
          const body = await readJson<GraphPinsUpdate>(req)
          const graph = await ctx.graphs.setPins(id, body)
          sendJson(res, 200, graph)
          return
        }
        if (parts.length !== 2) throw new Error(`graphs: unknown path ${url.pathname}`)

        if (action === 'select' || action === 'ready' || action === 'delete') {
          if (!guardMethod(req, res, 'POST')) return
          if (action === 'select') sendJson(res, 200, await ctx.graphs.select(id))
          else if (action === 'ready') sendJson(res, 200, await ctx.graphs.markReady(id))
          else {
            await ctx.graphs.remove(id)
            sendJson(res, 200, { ok: true })
          }
          return
        }

        throw new Error(`graphs: unknown action ${action}`)
      } catch (error) {
        fail(res, error)
      }
    },
  })

  return () => {
    stopList()
    stopActions()
  }
}
