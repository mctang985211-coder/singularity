import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { EVOLUTION_PATH } from '../../constants.ts'
import { fail, guardMethod, messageOf, sendJson, urlOf } from '../libs/http.ts'

/** The evolution ledger entries this boundary reads; a deployment without the chain simply serves none. */
interface EvolutionReader {
  list(): Promise<readonly unknown[]>
  get(proposalId: string): Promise<unknown>
  experiments(proposalId?: string): Promise<readonly unknown[]>
  forSession?(sessionId: string): Promise<EvolutionReader>
}

/** The ledger the console may read: absent when the chain is off (`singularityEvolution.enabled`), or when no service was mounted. */
function evolutionOf(ctx: Context): EvolutionReader | undefined {
  const exposure = optionalService<{ readonly enabled?: boolean }>(ctx, 'singularityEvolution')
  if (exposure !== undefined && exposure.enabled === false) return undefined
  return optionalService<EvolutionReader>(ctx, 'evolution')
}

async function scopedEvolution(ctx: Context, req: IncomingMessage): Promise<EvolutionReader | undefined> {
  const evolution = evolutionOf(ctx)
  if (evolution === undefined || evolution.forSession === undefined) return evolution
  const graphId = urlOf(req).searchParams.get('graphId')
  const graph = graphId === null ? await ctx.graphs.current() : await ctx.graphs.get(graphId)
  return evolution.forSession(graph.rootSessionId)
}

export function registerEvolution(ctx: Context): () => void {
  const stopList = ctx.webServer.register({
    kind: 'exact',
    path: EVOLUTION_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      try {
        const evolution = await scopedEvolution(ctx, req)
        if (evolution === undefined) {
          sendJson(res, 200, { proposals: [], experiments: [] })
          return
        }
        sendJson(res, 200, { proposals: await evolution.list(), experiments: await evolution.experiments() })
      } catch (error) {
        fail(res, error)
      }
    },
  })

  const stopDetail = ctx.webServer.register({
    kind: 'prefix',
    path: EVOLUTION_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      try {
        const url = urlOf(req)
        const id = decodeURIComponent(url.pathname.slice(EVOLUTION_PATH.length + 1))
        if (id.length === 0 || id.includes('/')) throw new Error(`evolution: unknown path ${url.pathname}`)
        const evolution = await scopedEvolution(ctx, req)
        if (evolution === undefined) throw new Error(`evolution: unknown proposal "${id}"`)
        sendJson(res, 200, { proposal: await evolution.get(id) })
      } catch (error) {
        sendJson(res, 404, { error: messageOf(error) })
      }
    },
  })

  return () => {
    stopList()
    stopDetail()
  }
}
