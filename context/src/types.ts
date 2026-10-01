/** The read-side types: what a caller asks for, and the seams a read observes. @module @dangosys/dsh-singularity-context/types */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BindingDeps } from './bindings/types.ts'

/** The status scopes a caller may ask for (A2 §D). */
export type StatusScope = 'related' | 'graph'

/** What one status read asks for: how much of which scope. */
export interface StatusQuery {
  readonly scope?: StatusScope
  /** Entry offset, from 0. */
  readonly offset?: number
  /** Entries per page; default 20, range 1–100. */
  readonly limit?: number
}

/** A review's identity: the pair a `ReviewRecord` carries, since a review has no id of its own. */
export interface ReviewReference {
  readonly taskId: string
  /** `null` for a task that blocked before any run started. */
  readonly runId: string | null
}

/** One session event's identity: the session it belongs to and the event's own DSH seq. */
export interface SessionEventReference {
  readonly sessionId: string
  readonly seq: number
}

/** What one reference read asks for, by kind. */
export interface ContextReadQuery {
  readonly kind: 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session'
  /** The record's own identity, in the shape its kind uses. */
  readonly ref: string | ReviewReference | SessionEventReference
  /** Task-class: byte offset into the record. Session listing: event seq. Session event: byte offset. */
  readonly offset?: number
  /** Task-class/session-event: UTF-8 bytes per page. Session listing: events per page. */
  readonly limit?: number
}

/** The session plane's read-only half, as this package uses it. */
export interface SessionQueryReads {
  readSurface(sessionId: string): Promise<{ readonly capturedThroughSeq: number | null }>
  readEvent(
    request: { readonly sessionId: string; readonly seq: number; readonly before?: number; readonly after?: number },
    signal?: AbortSignal,
  ): Promise<{
    readonly target: SessionEvent
    readonly events: readonly SessionEvent[]
    readonly startSeq: number
    readonly endSeq: number
  }>
  /** One Session's whole log, live-preferred, with the number of fork-inherited events at its head. */
  readSession(
    sessionId: string,
  ): Promise<{ readonly inheritedEventCount: number; readonly events: readonly SessionEvent[] }>
}

/** Soft view of the env-builder store: the graph env's path is where template discovery walks up from. */
export interface EnvPathSource {
  readonly store: { get(envId: string): { readonly path: string } }
}

/** Everything a projection reads from. */
export interface ReadDeps extends BindingDeps {
  readonly sessionQuery: SessionQueryReads
  /** Absent in a deployment without an env builder: the obligation-coverage line is then omitted. */
  readonly envBuilder?: EnvPathSource
}
