/**
 * The unified read route: one graph's access mode, its active revision, its
 * latest evaluation and its derived progress — the same projection the tool
 * plane reads. A sealed legacy graph is answered with a pointer to its history
 * route instead, and a deployment without a fact producer refuses by name.
 * @module dsh-singularity-graph-web/api/view
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { GraphSealedError, graphAccessWire } from '@dangosys/dsh-singularity-graphs'
import type { GraphViewWire } from '@dangosys/dsh-singularity-graphs/wire'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { GRAPHS_PATH, VIEW_PATH } from '../../constants.ts'
import { fail, graphIdOf, guardMethod, messageOf, sendJson, urlOf } from '../libs/http.ts'

/** The one read source this boundary reads: the context view service, one projection for Web and tools. */
export interface GraphViewReader {
  view(graphId: string): Promise<GraphViewWire>
  summaries(): Promise<readonly GraphViewWire[]>
}

/** A read this deployment mounted no producer for; the route answers it as a named 503. */
export function readSourceUnavailable(source: string, detail: string): Error & { code: string; source: string } {
  return Object.assign(new Error(detail), { code: 'read-source-unavailable', source })
}

/** The one view source, or this route's own refusal naming what is missing. */
export function graphViewOf(ctx: Context): GraphViewReader {
  const service = optionalService<GraphViewReader>(ctx, 'singularityGraphView')
  if (service === undefined) {
    throw readSourceUnavailable(
      'graph-view',
      'singularity/view: this deployment mounts no graph view service, so a graph has no readable revision, evaluation or progress',
    )
  }
  return service
}

/** Answer a read failure: a missing fact producer is a named 503, anything else the caller's own 400. */
export function failRead(res: ServerResponse, error: unknown): void {
  const source = (error as { source?: unknown }).source
  if ((error as { code?: unknown }).code === 'read-source-unavailable' && typeof source === 'string') {
    sendJson(res, 503, { error: messageOf(error), source })
    return
  }
  fail(res, error)
}

/** Where a sealed graph's own history lives; the refusal names it so a caller is never left guessing. */
export function historyPathOf(graphId: string): string {
  return `${GRAPHS_PATH}/${encodeURIComponent(graphId)}/history`
}

/**
 * Whether one failure is a sealed-graph refusal. The marker is the error's own
 * `code`, not its class: a service built from source and a route built from the
 * bundle are two module instances of the same contract.
 */
export function isSealedError(error: unknown): boolean {
  if (error instanceof GraphSealedError) return true
  if (error === null || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === 'graph-sealed'
}

/** The graph a sealed refusal names, when it names one. */
export function sealedGraphIdOf(error: unknown): string | undefined {
  const id = (error as { graphId?: unknown }).graphId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The sealed refusal every current-protocol read answers a legacy graph with. */
export function sealedRefusal(res: ServerResponse, graphId: string, reason: string): void {
  sendJson(res, 409, { error: 'graph-sealed', graphId, reason, history: historyPathOf(graphId) })
}

/** The summary projection: the mode, the identity and the derived progress, without the method facts. */
function summaryOf(wire: GraphViewWire): unknown {
  return {
    formatVersion: wire.formatVersion,
    graph: wire.graph,
    access: wire.access,
    progress: wire.progress,
    generation: wire.generation,
  }
}

export function registerView(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: VIEW_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      try {
        const graphId = graphIdOf(req, 'view')
        const graph = await ctx.graphs.get(graphId)
        const access = graphAccessWire(graph)
        if (access.mode !== 'current') {
          sealedRefusal(res, graphId, access.reason ?? `${graphId} carries no protocol marker`)
          return
        }
        const wire = await graphViewOf(ctx).view(graphId)
        const summary = urlOf(req).searchParams.get('summary')
        sendJson(res, 200, summary === '1' || summary === 'true' ? summaryOf(wire) : wire)
      } catch (error) {
        failRead(res, error)
      }
    },
  })
}
