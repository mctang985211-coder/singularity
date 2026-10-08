import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { graphAccessWire } from '@dangosys/dsh-singularity-graphs'
import type { CreateGraphRequest, GraphPinsUpdate, GraphRecord } from '@dangosys/dsh-singularity-graphs'
import type { GraphViewWire } from '@dangosys/dsh-singularity-graphs/wire'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { GRAPHS_PATH } from '../../constants.ts'
import { fail, guardMethod, messageOf, readJson, sendJson, urlOf } from '../libs/http.ts'
import { graphViewOf, isSealedError, sealedGraphIdOf, sealedRefusal } from './view.ts'
import { registerHistory } from './history.ts'

/** The refusal this boundary answers a sealed graph with, when the failure is that refusal. */
function sealed(res: ServerResponse, error: unknown, fallbackId: string): boolean {
  if (!isSealedError(error)) return false
  sealedRefusal(res, sealedGraphIdOf(error) ?? fallbackId, messageOf(error))
  return true
}

/** The unified read model per graph id, or the named refusal when this deployment mounts no fact producer. */
async function summariesOf(ctx: Context): Promise<{
  readonly views: ReadonlyMap<string, GraphViewWire>
  readonly error?: { readonly error: string; readonly source: string }
}> {
  try {
    const views = await graphViewOf(ctx).summaries()
    return { views: new Map(views.map(view => [view.graph.id, view])) }
  } catch (error) {
    const source = (error as { source?: unknown }).source
    return {
      views: new Map(),
      error: { error: messageOf(error), source: typeof source === 'string' ? source : 'graph-view' },
    }
  }
}

/** One registry record as the list serves it: its repositories, its access mode and the method facts a view holds. */
function entryOf(graph: GraphRecord, repos: readonly string[], view: GraphViewWire | undefined): unknown {
  return {
    ...graph,
    repos,
    access: graphAccessWire(graph),
    ...(view === undefined ? {} : { progress: view.progress, evaluation: view.evaluation }),
  }
}

export function registerGraphs(ctx: Context): () => void {
  const history = registerHistory(ctx)

  const stopList = ctx.webServer.register({
    kind: 'exact',
    path: GRAPHS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!guardMethod(req, res, 'GET', 'POST')) return
        if (req.method === 'GET') {
          const snapshot = await ctx.graphs.snapshot()
          const { views, error } = await summariesOf(ctx)
          sendJson(res, 200, {
            ...snapshot,
            graphs: snapshot.graphs.map(graph =>
              entryOf(
                graph,
                ctx.envBuilder.store
                  .get(graph.envId)
                  .components.map(component => `${component.owner}/${component.repo}`),
                views.get(graph.id),
              ),
            ),
            ...(error === undefined ? {} : { viewError: error }),
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

        if (action === 'history') {
          if (!guardMethod(req, res, 'GET')) return
          await history(id, req, res)
          return
        }

        if (action === 'library') {
          if (!guardMethod(req, res, 'GET')) return
          const graph = await ctx.graphs.get(id)
          const runtime = optionalService<Pick<Context['taskRuntime'], 'libraryRead'>>(ctx, 'taskRuntime')
          if (runtime === undefined) {
            sendJson(res, 503, {
              error: 'graphs: this deployment mounts no task runtime, so the graph library cannot be read',
              source: 'task-runtime',
            })
            return
          }
          sendJson(res, 200, await runtime.libraryRead(graph.rootSessionId))
          return
        }

        if (action === 'select' || action === 'ready' || action === 'delete') {
          if (!guardMethod(req, res, 'POST')) return
          if (action === 'delete') {
            await ctx.graphs.remove(id)
            sendJson(res, 200, { ok: true })
            return
          }
          try {
            const graph = action === 'select' ? await ctx.graphs.select(id) : await ctx.graphs.markReady(id)
            sendJson(res, 200, graph)
          } catch (error) {
            if (sealed(res, error, id)) return
            throw error
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
