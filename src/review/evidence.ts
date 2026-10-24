import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse, type RefusalCode } from '../protocol/refusal.ts'
import { record, text } from '../task/shape.ts'

/** A page of one native event; an index range alone is not evidence. */
export interface NativeEventRef {
  readonly sessionId: string
  readonly eventSeq: number
  readonly rootId?: string
  readonly from?: number
  readonly count?: number
}

export function nativeEventRef(raw: unknown, where: string, code: RefusalCode = 'malformed-payload'): NativeEventRef {
  const row = record(raw, where)
  assertClosedKeys(row, ['sessionId', 'eventSeq', 'rootId', 'from', 'count'], where, code)
  if (!Number.isSafeInteger(row['eventSeq']) || (row['eventSeq'] as number) < 0)
    refuse(
      code,
      `${where}.eventSeq is required and must be a nonnegative integer; copy seq from a trajectory index entry. from/count without eventSeq selects an index, not a native event page`,
    )
  if (row['from'] !== undefined && (!Number.isSafeInteger(row['from']) || (row['from'] as number) < 0))
    refuse(code, `${where}.from must be a nonnegative UTF-8 byte offset`)
  if (
    row['count'] !== undefined &&
    (!Number.isSafeInteger(row['count']) || (row['count'] as number) < 4 || (row['count'] as number) > 8192)
  )
    refuse(code, `${where}.count must be an integer from 4 to 8192 UTF-8 bytes`)
  return {
    sessionId: text(row, 'sessionId', where),
    eventSeq: row['eventSeq'] as number,
    ...(row['rootId'] === undefined ? {} : { rootId: text(row, 'rootId', where) }),
    ...(row['from'] === undefined ? {} : { from: row['from'] as number }),
    ...(row['count'] === undefined ? {} : { count: row['count'] as number }),
  }
}
