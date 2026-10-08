/** Graph protocol marker and access mode: the single source that tells a current graph from a sealed legacy one. */

/** The literal identity of the current protocol; a graph's protocol is fixed at creation and never rewritten. */
export const GRAPH_PROTOCOL_V2 = 'singularity/graph@2' as const

export interface GraphProtocol {
  readonly id: typeof GRAPH_PROTOCOL_V2
  readonly version: 2
  /** Stamping time (creation time); a graph never rewrites its own protocol. */
  readonly since: number
}

export type GraphAccess =
  | { readonly mode: 'current'; readonly protocol: GraphProtocol }
  | { readonly mode: 'legacy-readonly'; readonly reason: string }

/** The protocol marker a record carries; absent means the graph predates marking. */
export function protocolOf(graph: { readonly protocol?: GraphProtocol }): GraphProtocol | undefined {
  return graph.protocol
}

/** A marked graph is current, an unmarked one is sealed legacy read-only history; there is no third state. */
export function graphAccess(graph: { readonly id: string; readonly protocol?: GraphProtocol }): GraphAccess {
  const protocol = protocolOf(graph)
  if (protocol === undefined) {
    return { mode: 'legacy-readonly', reason: `graph "${graph.id}" carries no protocol marker; it predates ${GRAPH_PROTOCOL_V2}` }
  }
  return { mode: 'current', protocol }
}

/** The error every write path on a sealed legacy graph answers with. */
export class GraphSealedError extends Error {
  readonly code = 'graph-sealed'
  readonly graphId: string

  constructor(graphId: string) {
    super(`graphs: graph "${graphId}" is sealed legacy history (no ${GRAPH_PROTOCOL_V2} marker); it is read-only`)
    this.name = 'GraphSealedError'
    this.graphId = graphId
  }
}

/** The marker a current graph carries; throws {@link GraphSealedError} on a sealed legacy graph. */
export function assertCurrentGraph(graph: { readonly id: string; readonly protocol?: GraphProtocol }): GraphProtocol {
  const protocol = protocolOf(graph)
  if (protocol === undefined) throw new GraphSealedError(graph.id)
  return protocol
}
