/** The named vocabulary every read answers in, the read algebra built on it, and the one place an error is read. @module @dangosys/dsh-singularity-context/refusals */

/** Every outcome a read can refuse with, by name. */
export type NamedRefusal =
  | 'not-activated'
  | 'unbound'
  | 'binding-conflict'
  | 'cross-graph'
  | 'not-found'
  | 'stale-reference'
  | 'unreadable'
  | 'context-too-large'

/** The same vocabulary as a value, so a tool schema or a test can pin the whole set. */
export const NAMED_REFUSALS = [
  'not-activated',
  'unbound',
  'binding-conflict',
  'cross-graph',
  'not-found',
  'stale-reference',
  'unreadable',
  'context-too-large',
] as const satisfies readonly NamedRefusal[]

/** How much of a longer read one page carried, and where to continue. */
export interface ReadContinuation {
  readonly hasMore: boolean
  readonly nextOffset: number
}

/** A read that answered: the text, where it came from, and whether it is complete. */
export interface ProjectedReadOk {
  readonly ok: true
  readonly text: string
  /** True when more of the same read is available: another record page, the rest of a window, further entries. */
  readonly hasMore?: boolean
  /** The offset the next page starts at — the read's own unit (UTF-8 bytes, event seq, entry index). */
  readonly nextOffset?: number
  /** What was read and how much of it one observation covers, in one line. */
  readonly source: string
}

/** A read that refused: the named outcome and the detail a caller can act on or show. */
export interface ProjectedReadRefused {
  readonly ok: false
  readonly refusal: NamedRefusal
  readonly detail: string
}

/** What every read in this package returns. */
export type ProjectedRead = ProjectedReadOk | ProjectedReadRefused

/** One successful read; the continuation fields appear only when something is left. */
export function read(text: string, source: string, continuation?: ReadContinuation): ProjectedReadOk {
  if (continuation === undefined) return { ok: true, text, source }
  return { ok: true, text, source, hasMore: continuation.hasMore, nextOffset: continuation.nextOffset }
}

/** One refused read: the name first, then the detail a caller renders as-is. */
export function refused(refusal: NamedRefusal, detail: string): ProjectedReadRefused {
  return { ok: false, refusal, detail }
}

/** One error message, from whatever a read threw. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The coded error a session-query or registry read answers with, when it carries one. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}
