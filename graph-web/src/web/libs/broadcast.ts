import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { GraphSnapshot, LayoutSnapshot } from '@dangosys/dsh-singularity-graph'
import type { GraphsSnapshot } from '@dangosys/dsh-singularity-graphs'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type { GraphViewReader } from './../api/view.ts'
import { messageOf } from './http.ts'

/** What one client is: the graph it subscribed to, and the queue its frames are written in order through. */
interface Client {
  readonly graphId: string
  writes: Promise<void>
}

/**
 * One SSE client receives one `snapshot` frame: the canvas projection (metadata,
 * access mode, topology, layout) plus the unified read model when this
 * deployment can produce it, or the named refusal that says which producer is
 * missing. No client keeps a graph record of its own any more — the frame is
 * read once per client from the same services, and the read model is never
 * assembled here.
 */
export class GraphBroadcast {
  readonly clients = new Map<ServerResponse, Client>()

  constructor(private readonly ctx: Context) {}

  subscribe(res: ServerResponse, graphId: string): void {
    this.clients.set(res, { graphId, writes: Promise.resolve() })
    this.snapshot(res)
  }

  snapshot(res: ServerResponse): void {
    const client = this.clients.get(res)!
    client.writes = client.writes
      .then(async () => {
        if (res.destroyed) return
        res.write(`event: snapshot\ndata: ${JSON.stringify(await this.frameOf(client.graphId))}\n\n`)
      })
      .catch(error => {
        this.clients.delete(res)
        res.destroy(error)
      })
  }

  /** The one frame: the canvas projection, and the unified read model or its named refusal. */
  private async frameOf(graphId: string): Promise<unknown> {
    const canvas = await this.ctx.graphs.view(graphId)
    const service = optionalService<GraphViewReader>(this.ctx, 'singularityGraphView')
    if (canvas.access.mode !== 'current' || service === undefined) return { ...canvas, graphView: null }
    try {
      return { ...canvas, graphView: await service.view(graphId) }
    } catch (error) {
      const source = (error as { source?: unknown }).source
      return {
        ...canvas,
        graphView: null,
        viewError: { error: messageOf(error), source: typeof source === 'string' ? source : 'graph-view' },
      }
    }
  }

  publishEvent(name: string, value: unknown): void {
    const frame = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`
    for (const [res] of this.clients) {
      if (res.destroyed) this.clients.delete(res)
      else res.write(frame)
    }
  }

  publishGraphs(snapshot: GraphsSnapshot): void {
    for (const [res, client] of this.clients) {
      if (res.destroyed) this.clients.delete(res)
      else if (snapshot.graphs.some(graph => graph.id === client.graphId)) this.snapshot(res)
      else res.end()
    }
  }

  /** Re-snapshot only the clients whose own graph store is the one that changed. */
  private changed(id: string, kind: 'graph' | 'layout'): void {
    for (const [res, client] of this.clients) {
      if (res.destroyed) {
        this.clients.delete(res)
        continue
      }
      void this.ctx.graphs
        .get(client.graphId)
        .then(record => {
          const mine = kind === 'graph' ? record.graphStoreId : record.layoutStoreId
          if (mine === id) this.snapshot(res)
        })
        .catch(() => {
          this.clients.delete(res)
          res.end()
        })
    }
  }

  publishLayout(snapshot: LayoutSnapshot): void {
    this.changed(snapshot.id, 'layout')
  }

  publish(snapshot: GraphSnapshot): void {
    this.changed(snapshot.id, 'graph')
  }

  close(): void {
    for (const res of this.clients.keys()) res.end()
    this.clients.clear()
  }
}
