/**
 * What DSH itself knows about one coordination session: whether it exists,
 * whether it is live, whether its last turn ended, and whether it ever called a
 * completion tool. Nothing here is a second record of the session's state —
 * every reading comes from `ctx.agents`, `ctx.sessionPersistence` or
 * `ctx.sessionQuery`, and a reading this process cannot take stays absent rather
 * than becoming a zero.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/session-facts
 */

import type { Context } from '@deepseek-ai/cordis'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'

/** The tools whose call in a session's own log marks that session's work as concluded. */
export const COMPLETION_TOOLS: readonly string[] = ['supervisor_complete', 'reviewer_complete']

/** One session's DSH-native facts. */
export interface CoordinationSessionFacts {
  readonly sessionId: string
  readonly presence: 'live' | 'stored' | 'missing'
  readonly status?: 'idle' | 'running'
  /** The persisted log holds at least one `turn/start`. */
  readonly hasTurn: boolean
  /** The persisted log's last turn ended — the only evidence that a session settled its turn. */
  readonly turnClosed: boolean
  /** The persisted log holds a call to one of {@link COMPLETION_TOOLS}. */
  readonly completionCall: boolean
}

/** The sessions registry, as this module reads it. */
interface LiveAgents {
  get(id: string): { readonly status?: string } | undefined
}

/** The persistence backend's "is there a stored session" answer, read softly across backends. */
interface PersistedSessions {
  stat?(id: string): Promise<unknown>
  list?(): Promise<readonly { readonly header: { readonly id: string } }[]>
}

/** One session's persisted log, as the query service answers it. */
interface SessionLog {
  readonly events: readonly { readonly type: string; readonly data?: unknown }[]
}

/** One session's log, or `undefined` when this process cannot read it. */
async function logOf(ctx: Context, sessionId: string): Promise<SessionLog | undefined> {
  const query = optionalService<{ readSession(id: string): Promise<SessionLog> }>(ctx, 'sessionQuery')
  if (query === undefined) return undefined
  try {
    return await query.readSession(sessionId)
  } catch {
    return undefined
  }
}

/** Whether one event is a tool call to a completion tool. */
function isCompletionCall(event: { readonly type: string; readonly data?: unknown }): boolean {
  if (event.type !== 'tool/call') return false
  const name = (event.data as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && COMPLETION_TOOLS.includes(name)
}

/** The turn facts one persisted log carries. */
function turnFacts(events: readonly { readonly type: string }[]): {
  readonly hasTurn: boolean
  readonly turnClosed: boolean
} {
  let open = false
  let hasTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      hasTurn = true
      open = true
    } else if (event.type === 'turn/end') {
      open = false
    }
  }
  return { hasTurn, turnClosed: hasTurn && !open }
}

/** Whether a stored session exists, without insisting on either backend's API. */
async function stored(ctx: Context, sessionId: string): Promise<boolean> {
  const persistence = optionalService<PersistedSessions>(ctx, 'sessionPersistence')
  if (persistence === undefined) return false
  if (typeof persistence.stat === 'function') {
    try {
      return (await persistence.stat(sessionId)) !== undefined
    } catch {
      return false
    }
  }
  if (typeof persistence.list === 'function') {
    try {
      return (await persistence.list()).some(item => String(item.header.id) === sessionId)
    } catch {
      return false
    }
  }
  return false
}

/** One session's facts: live from the registry, otherwise from the persisted log. */
export async function readSessionFacts(ctx: Context, sessionId: string): Promise<CoordinationSessionFacts> {
  const registry = optionalService<LiveAgents>(ctx, 'agents')
  const live = registry?.get(sessionId)
  const log = await logOf(ctx, sessionId)
  const turns = turnFacts(log?.events ?? [])
  const presence: CoordinationSessionFacts['presence'] =
    live !== undefined ? 'live' : (await stored(ctx, sessionId)) ? 'stored' : 'missing'
  return {
    sessionId,
    presence,
    ...(live?.status === 'idle' || live?.status === 'running' ? { status: live.status } : {}),
    hasTurn: turns.hasTurn,
    turnClosed: turns.turnClosed,
    completionCall: (log?.events ?? []).some(isCompletionCall),
  }
}

/** The facts of several sessions, read together. */
export async function readSessionFactsOf(
  ctx: Context,
  sessionIds: readonly string[],
): Promise<Map<string, CoordinationSessionFacts>> {
  const facts = new Map<string, CoordinationSessionFacts>()
  await Promise.all(
    [...new Set(sessionIds)].map(async sessionId => {
      facts.set(sessionId, await readSessionFacts(ctx, sessionId))
    }),
  )
  return facts
}

/** DSH's own durability barrier: every session log a writer appended so far is where the next reader finds it. */
export async function flushSessions(ctx: Context): Promise<void> {
  const persistence = optionalService<{ flush?(): Promise<void> }>(ctx, 'sessionPersistence')
  if (typeof persistence?.flush === 'function') await persistence.flush()
}

/** Whether one assignment has consumed its store's budget: its session reached the store at all. */
export function sessionSpent(facts: CoordinationSessionFacts | undefined): boolean {
  return facts !== undefined && facts.presence !== 'missing'
}

/** Whether one session's turn has ended and nothing further is running in it. */
export function turnSettled(facts: CoordinationSessionFacts | undefined): boolean {
  if (facts === undefined) return false
  if (facts.status === 'running') return false
  return facts.turnClosed
}
