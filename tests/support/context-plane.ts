/**
 * The two read-only planes a fixture has to provide for the context read core
 * (A2): the graph registry's facts and the session plane's exact reads.
 *
 * Both are *stand-ins for DSH/graph services a fixture replaces* — the same role
 * `graphs.graphForSession` and the tool plane play in every fixture here — and
 * both are shaped exactly as the real services answer, so a fixture that mounts
 * the real `singularityContext` reads through the same calls a deployment does.
 * Nothing else in the read path is replaced: the store is the fixture's real
 * `TaskService`, and the runtime observations come from the real `TaskRuntime`.
 * @module tests/support/context-plane
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { SingularityContextService } from '../../context/src/index.ts'

/** The fields of a registry graph the read core reads (`context/src/bindings.ts:GraphRecordFacts`). */
export interface GraphRecordFactsLike {
  readonly id: string
  readonly name: string
  readonly envId: string
  readonly rootSessionId: string
  /** Present on the real registry record; unused by the reads, kept so a fixture's own assertions can still read it. */
  readonly graphStoreId?: string
  readonly layoutStoreId?: string
}

/**
 * One published graph edge (`agent-runtime` records a `spawn` edge from the
 * parent when it publishes a spawned session).
 */
export interface GraphEdgeLike {
  readonly kind: string
  readonly from: string
  readonly to: string
}

/** The registry, as the read core uses it: which graph a session is in, which graphs exist, and who one publishes. */
export interface GraphRegistryLike {
  graphForSession(sessionId: string): Promise<GraphRecordFactsLike>
  list(): Promise<readonly GraphRecordFactsLike[]>
  view(id: string): Promise<{
    readonly graph: { readonly agents: readonly { readonly id: string }[]; readonly edges: readonly GraphEdgeLike[] }
  }>
}

export interface GraphRegistryOptions {
  /**
   * The fixture's own graph lookup. A *miss* must be reported the way the real
   * registry reports it — `SessionNotInGraphError` (its `SESSION_NOT_IN_GRAPH`
   * fact) — because the read core tells that fact apart from a failed read: any
   * other throw is a registry or graph-store failure, and a session bound by it
   * is refused by name rather than read as "this session is in no graph".
   */
  readonly graphForSession: (sessionId: string) => Promise<GraphRecordFactsLike> | GraphRecordFactsLike
  /**
   * Every graph this deployment owns, for the store→graph direction a recorded
   * delegation needs. Defaults to none: a fixture whose subjects are not
   * reviewers delegated outside their own graph has no other graph to place.
   */
  readonly list?: () => Promise<readonly GraphRecordFactsLike[]> | readonly GraphRecordFactsLike[]
  /**
   * The sessions one graph publishes, by that graph's own id (the registry's
   * `view`). Defaults to none: membership is only read for a **session
   * reference** (a guessed id must not reach DSH), and a fixture that reads
   * sessions passes its own list — per graph, because a deployment with two of
   * them must not publish one's members into the other.
   */
  readonly members?: (id: string) => readonly string[]
  /**
   * The graph store's own edges, by graph id. Defaults to none: a fixture whose
   * graph publishes nothing spawned has no `spawn` edge to report, which is what
   * a mount-only graph store holds. A fixture that spawns real sessions through
   * the deployment's `AgentRuntime` passes the edges it committed.
   */
  readonly edges?: (id: string) => readonly GraphEdgeLike[]
}

/**
 * The registry a fixture provides, with the read-only half the context core
 * needs added to the one lookup that fixture already had.
 */
export function graphRegistry(options: GraphRegistryOptions): GraphRegistryLike {
  return {
    graphForSession: async (sessionId: string) => await options.graphForSession(sessionId),
    list: async () => (options.list === undefined ? [] : await options.list()),
    view: async (id: string) => ({
      graph: {
        id,
        agents: [...(options.members?.(id) ?? [])].map(member => ({ id: member })),
        edges: [...(options.edges?.(id) ?? [])],
      },
    }),
  }
}

/**
 * The session plane's read-only half (`context/src/projections.ts:SessionQueryReads`)
 * over one fixture's own log: `offset` is a DSH event seq, so the read is the
 * window around the event a caller named. A session the fixture holds no log for
 * is refused by name, which is what the read core reports as `unreadable`.
 */
export function sessionQueryReads(
  eventsOf: (sessionId: string) => readonly SessionEvent[] | undefined,
): {
  readSurface(sessionId: string): Promise<{ capturedThroughSeq: number | null }>
  readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<{
    target: SessionEvent
    events: readonly SessionEvent[]
    startSeq: number
    endSeq: number
  }>
} {
  const log = (sessionId: string): readonly SessionEvent[] => {
    const events = eventsOf(sessionId)
    if (events === undefined) throw new Error(`session "${sessionId}" has no log in this fixture`)
    return events
  }
  return {
    readSurface: async (sessionId: string) => ({ capturedThroughSeq: log(sessionId).at(-1)?.seq ?? null }),
    readEvent: async (request: { sessionId: string; seq: number; before?: number; after?: number }) => {
      const events = log(String(request.sessionId))
      const target = events.find(event => event.seq === request.seq)
      // DSH's own engine answers a seq its log does not hold with this coded
      // error, and the read core tells it apart from a source that failed; the
      // stand-in must not soften that into an uncoded failure.
      if (target === undefined) {
        throw new SessionQueryError(
          `session "${String(request.sessionId)}" has no event at seq ${request.seq}`,
          'SESSION_QUERY_EVENT_NOT_FOUND',
        )
      }
      const start = Math.max(0, request.seq - (request.before ?? 0))
      const end = Math.min(events.length - 1, request.seq + (request.after ?? 0))
      return { target, events: events.slice(start, end + 1), startSeq: start, endSeq: end }
    },
  }
}

/**
 * Mount the read core and the prompt assembly on a fixture.
 *
 * Through `ctx.plugin`, not `new SingularityContextService(ctx)`: the assembly
 * listener is registered by `[Service.init]`, which cordis runs for a class
 * plugin — a hand-constructed service would read correctly and assemble nothing.
 * The fixture must have provided `task`, `graphs` (see {@link graphRegistry}),
 * `taskRuntime` and `sessionQuery` (see {@link sessionQueryReads}) first, the
 * order the deployment's own bundle mounts them in.
 */
export async function mountContextReadCore(ctx: Context): Promise<SingularityContextService> {
  await ctx.plugin(SingularityContextService)
  return ctx.get('singularityContext') as SingularityContextService
}
