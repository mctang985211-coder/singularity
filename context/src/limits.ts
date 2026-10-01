/** The one output bound (50 000 UTF-8 bytes per read) and the vocabulary of a bounded read. @module @dangosys/dsh-singularity-context/limits */

import {
  TextRetainer,
  formatRetentionNotice,
  type Omitted,
  type RetentionNotice,
} from '@deepseek-ai/dsh-output-retention'

/** The outer output bound of one context read, in UTF-8 bytes: the deployment's own inline cap. */
export const CONTEXT_OUTPUT_LIMIT_BYTES = 50_000

/** UTF-8 byte length of `text`. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** One page out of a longer text: the bytes taken, the offset after them, and whether the source ended. */
export interface Utf8Slice {
  readonly text: string
  /** Byte offset the next page starts at; always on a character boundary. */
  readonly nextOffset: number
  /** True when this page reached the end of the source. */
  readonly done: boolean
}

/** The UTF-8 width of the character starting at UTF-16 index `index`, read off its code point. */
function utf8WidthAt(text: string, index: number): number {
  const code = text.codePointAt(index) as number
  if (code <= 0x7f) return 1
  if (code <= 0x7ff) return 2
  if (code <= 0xffff) return 3
  return 4
}

/** How many UTF-16 code units the character at `index` occupies (2 for an astral character). */
function codeUnitsAt(text: string, index: number): number {
  return (text.codePointAt(index) as number) > 0xffff ? 2 : 1
}

/** Take at most `maxBytes` bytes from `offsetBytes`, never splitting a character, and report the next offset. */
export function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice {
  const start = Math.max(0, Math.trunc(offsetBytes))
  const budget = Math.max(0, Math.trunc(maxBytes))
  // Walk to the first character at or after `start`: `position` is its byte
  // offset (where the page really begins) and `index` its UTF-16 index.
  let position = 0
  let index = 0
  while (index < text.length && position < start) {
    position += utf8WidthAt(text, index)
    index += codeUnitsAt(text, index)
  }
  // Past the end: nothing left to take, and the cursor stays where the text does.
  if (index >= text.length) return { text: '', nextOffset: position, done: true }

  const rest = text.slice(index)
  const firstWidth = utf8WidthAt(text, index)
  const retainer = new TextRetainer({ kind: 'head', maxBytes: Math.max(budget, firstWidth) })
  retainer.push(rest)
  const retained = retainer.finish()
  const omitted = retained.omittedBytes.kind === 'exact' ? retained.omittedBytes.count : 0
  const kept = utf8Bytes(rest) - omitted
  return { text: retained.text, nextOffset: position + kept, done: !retained.truncated }
}

/** A byte-metered line list: every line fits whole — newline included — or is refused, never cut. */
export class OutputBudget {
  private readonly lines: string[] = []
  private used = 0

  constructor(readonly maxBytes: number) {}

  get bytes(): number {
    return this.used
  }

  get remaining(): number {
    return this.maxBytes - this.used
  }

  /** Append one line when it fits; false leaves the budget untouched. */
  add(line: string): boolean {
    const width = utf8Bytes(line) + (this.lines.length === 0 ? 0 : 1)
    if (width > this.remaining) return false
    this.lines.push(line)
    this.used += width
    return true
  }

  /** Append every line that fits; returns how many were left out. */
  addAll(lines: readonly string[]): number {
    for (const [index, line] of lines.entries()) {
      if (!this.add(line)) return lines.length - index
    }
    return 0
  }

  text(): string {
    return this.lines.join('\n')
  }
}

/** One bounded list's omission, in the shape the platform's notice vocabulary takes. */
export interface OmissionReport {
  /** What was bounded, e.g. `related tasks` — the notice's scope label. */
  readonly scope: string
  /** What the omitted units are, in the library's own vocabulary. */
  readonly unit: RetentionNotice['unit']
  /** How many units the page carried. */
  readonly kept: number
  /** The bound the page filled, in units. */
  readonly limit: number
  /** The exact number of units left out. */
  readonly omitted: number
  /** This read's own recovery sentence — the half the library leaves to the tool. */
  readonly recovery: string
}

/** One bounded list's omission line: the platform's clause plus this read's recovery sentence. */
export function omissionLine(report: OmissionReport): string {
  const omitted: Omitted = { kind: 'exact', count: report.omitted }
  return formatRetentionNotice(
    {
      scope: report.scope,
      strategy: 'head',
      unit: report.unit,
      limit: report.limit,
      kept: report.kept,
      omitted,
    },
    () => report.recovery,
  )
}

/** One budgeted list: its units, the lines they occupy, and what is owed around them. */
export interface BudgetedList<T> {
  readonly units: readonly T[]
  readonly lines: (unit: T) => readonly string[]
  /** Lines laid out before the units: a heading, a count, a blank separator. */
  readonly header?: readonly string[]
  /** Room kept whole for what the caller renders after this list. */
  readonly reserve?: number
  /** The lines owed after the units, given how many were shown: a clause, guidance, a footer. */
  readonly tail?: (shown: number) => readonly string[]
}

/** The bytes `lines` occupy when appended to a budget that is `empty` (`lines.length` separators, one fewer when empty). */
function linesWidth(lines: readonly string[], empty: boolean): number {
  if (lines.length === 0) return 0
  const body = lines.reduce((total, line) => total + utf8Bytes(line), 0)
  return body + lines.length - (empty ? 1 : 0)
}

/** Lay out whole units until the budget (minus `reserve`) runs out, then the tail, dropping units until it fits. */
export function budgetList<T>(budget: OutputBudget, list: BudgetedList<T>): readonly T[] | undefined {
  if (budget.addAll(list.header ?? []) > 0) return undefined
  const rendered = list.units.map(unit => list.lines(unit))
  const widths = rendered.map((lines, index) => linesWidth(lines, budget.bytes === 0 && index === 0))
  const room = budget.remaining - (list.reserve ?? 0)
  let shown = 0
  let used = 0
  while (shown < widths.length && used + (widths[shown] as number) <= room) {
    used += widths[shown] as number
    shown += 1
  }
  if (list.tail !== undefined) {
    for (;;) {
      const tail = list.tail(shown)
      if (linesWidth(tail, budget.bytes === 0 && shown === 0) <= room - used) {
        for (let index = 0; index < shown; index += 1) budget.addAll(rendered[index] as string[])
        budget.addAll(tail)
        return list.units.slice(0, shown)
      }
      if (shown === 0) return undefined
      shown -= 1
      used -= widths[shown] as number
    }
  }
  for (let index = 0; index < shown; index += 1) budget.addAll(rendered[index] as string[])
  return list.units.slice(0, shown)
}

/** One item list's omission clause: the platform's notice plus this read's recovery sentence. */
export function itemsClause(
  scope: string,
  recovery: string,
  limit: number,
  omitted: number,
  kept = limit - omitted,
): string {
  return omissionLine({ scope, unit: 'items', kept, limit, omitted, recovery })
}

/** The least room one item list occupies whole: its heading line and its widest omission clause. */
export function itemsFloor(title: string, scope: string, recovery: string, count: number): number {
  return utf8Bytes(`- ${title}:`) + 1 + utf8Bytes(itemsClause(scope, recovery, count, count, 0)) + 1
}
