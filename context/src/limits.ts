/**
 * The one output bound this package has (A2 §D) and the vocabulary a bounded
 * read uses to say what it left out.
 *
 * The bound is **50 000 UTF-8 bytes for a single read** — the same model-facing
 * cap this deployment's own tool-result policy uses
 * (`@deepseek-ai/dsh-spill-policy`'s `maxInlineBytes: 50000`, mounted by the
 * base bundle at `packages/bundle/base/cordis.patch.yml`). Aligning with it is
 * the point: one Singularity read stays inside what the platform already treats
 * as inline content, so a read is never replaced by a spill preview, and a read
 * that asks for a whole record asks for exactly as much as the platform's own
 * tools may put in front of a model. The policy reserves its notice's byte cost
 * out of that budget before filling a preview; the session pages here do the
 * same for their closing lines.
 *
 * The *mechanics* of bounding a body are not this package's invention either.
 * Byte windows, the guarantee that a cut never splits a UTF-8 character, and the
 * wording of what was omitted come from `@deepseek-ai/dsh-output-retention`
 * (`TextRetainer`, `describeOmitted` through `formatRetentionNotice`) — the
 * library whose documented split is "the library owns the omission clause, the
 * tool supplies its own recovery guidance". What has no counterpart there, and
 * therefore lives here, is exactly two things: the **cursor** (`nextOffset`,
 * which lets a caller read on, and which the library deliberately does not
 * model) and the **per-line budget** (`OutputBudget`, which counts lines rather
 * than bytes because a page must never carry half a line).
 *
 * What the bound never does is truncate silently: a record read pages with an
 * explicit continuation offset; a core contract that cannot fit is refused by
 * name (`context-too-large`) rather than cut; a bounded list says in the
 * platform's own words how many entries it did not show, plus where to read
 * them.
 * @module @dangosys/dsh-singularity-context/limits
 */

import { TextRetainer, formatRetentionNotice, type Omitted, type RetentionNotice } from '@deepseek-ai/dsh-output-retention'

/**
 * The outer output bound of one context read, in UTF-8 bytes. Deliberately the
 * deployment's own inline cap rather than a tighter local choice: see the module
 * doc for the reference and for what stays outside the library.
 */
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

/**
 * The UTF-8 width of the character starting at UTF-16 index `index`.
 *
 * Widths are read off the code point, so an astral character (a surrogate pair,
 * one character in two code units) is four bytes, and a lone surrogate — text a
 * valid log cannot produce, but a string can hold — is counted as the three bytes
 * the decoder writes for it. `utf8Bytes` on the same character agrees, which is
 * what lets the retained byte count become the cursor below.
 */
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

/**
 * Take at most `maxBytes` bytes starting at `offsetBytes` from `text`, never
 * splitting a UTF-8 character, and report where the next page starts.
 *
 * The window itself is `TextRetainer({kind: 'head'})` from
 * `@deepseek-ai/dsh-output-retention`: it keeps the first `maxBytes` bytes, trims
 * a partial character at that cut, and reports the exact omitted byte count, so
 * "where did this page end" is read off the library rather than recomputed here.
 * The two things wrapped around it are the ones the library does not own: the
 * cursor (`nextOffset`, derived from the bytes actually retained) and the floor
 * that keeps a caller moving — an offset inside a character starts at the next
 * character, and a page always carries at least that one character, so feeding
 * `nextOffset` back never loops on the same offset.
 *
 * Both walks below advance by **code point**, and the string is cut by **code
 * unit**: a surrogate pair is one character in two units, so counting characters
 * into `String#slice` would start every page after an astral character one unit
 * early — a lone surrogate in the page and a cursor inside a character.
 */
export function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice {
  const start = Math.max(0, Math.trunc(offsetBytes))
  const budget = Math.max(0, Math.trunc(maxBytes))
  // Walk to the first character at or after `start`: `position` is its byte
  // offset (where the page really begins) and `index` its UTF-16 index (where the
  // string is cut).
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

/**
 * A byte-metered line list: every line either fits whole — the newline included
 * — or is refused, so no line a caller sees is a cut one. `remaining` is what a
 * caller that wants to bound a *part* of its output (a reference list, say) has
 * left to spend.
 *
 * This is the part of the bounding story `@deepseek-ai/dsh-output-retention`
 * does not model: the library bounds a *byte* window or an *item* count, while a
 * rendered page has to keep whole lines together, so its accounting is by line.
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

/**
 * One bounded list's omission line: the platform's standardized clause followed
 * by this read's recovery sentence. `@deepseek-ai/dsh-output-retention`
 * documents that split — the library owns the wording of *what* was omitted,
 * the tool owns *how to read on* ("page through them with the status view",
 * "read them by id") — so this line is composed through
 * {@link formatRetentionNotice} rather than spelled out here.
 */
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
