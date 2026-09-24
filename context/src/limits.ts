/**
 * The one output bound this package has (A2 §D): 16 KiB for a single read —
 * whether that read is a tool-facing record, the reference lists a projection
 * carries, or the outer text of a status page. There is no second budget and no
 * configuration surface: one constant, one accounting, so "how much can a read
 * put in front of a model" has exactly one answer.
 *
 * What the bound never does is truncate silently. A record read pages with an
 * explicit continuation offset; a core contract that cannot fit is refused by
 * name (`context-too-large`) rather than cut; a reference list that does not fit
 * says how many entries it did not show.
 * @module @dangosys/dsh-singularity-context/limits
 */

/** The outer output bound of one context read, in UTF-8 bytes. */
export const CONTEXT_OUTPUT_LIMIT_BYTES = 16 * 1024

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

/**
 * Take at most `maxBytes` bytes starting at `offsetBytes` from `text`, never
 * splitting a UTF-8 character.
 *
 * An offset that lands inside a character starts at the next character (the
 * partial bytes belong to a character the caller's page boundary cut, and
 * re-emitting a fraction of one would corrupt it). A page always carries at
 * least one character: a bound smaller than the first character still advances,
 * so a caller that feeds `nextOffset` back never loops on the same offset.
 */
export function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice {
  const start = Math.max(0, Math.trunc(offsetBytes))
  const budget = Math.max(0, Math.trunc(maxBytes))
  let position = 0
  let taken = 0
  const parts: string[] = []
  for (const character of text) {
    const width = utf8Bytes(character)
    const characterStart = position
    position += width
    if (characterStart < start) continue
    if (taken + width > budget) {
      if (parts.length === 0) return { text: character, nextOffset: position, done: false }
      return { text: parts.join(''), nextOffset: characterStart, done: false }
    }
    parts.push(character)
    taken += width
  }
  return { text: parts.join(''), nextOffset: position, done: true }
}

/**
 * A byte-metered line list: every line either fits whole — the newline included
 * — or is refused, so no line a caller sees is a cut one. `remaining` is what a
 * caller that wants to bound a *part* of its output (a reference list, say) has
 * left to spend.
 */
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

/** The one-word name of an omission a bounded list reports, so a reader can tell a short list from a cut one. */
export function omittedLine(noun: string, omitted: number, how: string): string {
  return `… ${omitted} more ${noun} not shown (${how})`
}
