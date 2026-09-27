/**
 * The capability table's own text (A6, plan §F.4 "评估/应用必须同组补齐"): the
 * deployment's `config.yml`, whose `capabilities:` mapping under its
 * `task-runtime` entry is what a restart reads the registry from.
 *
 * Why this module exists. The runtime keeps the effective table in process
 * (`TaskRuntime.applyCapabilityRow`) so an applied row takes effect immediately —
 * but an in-process table is gone with the process. A capability commit that only
 * moved the in-memory row would look applied and be gone after the next restart,
 * so the same commit also writes the row into the file the deployment loads,
 * between the registry write and the completion line
 * (`commit.ts:CommitHost.verifyCommitted`), and a restart then reloads exactly
 * the table the commit installed.
 *
 * What the edit does, and what it refuses to do:
 *
 * - It touches **one region**: the row of one name inside the `capabilities:`
 *   block of the `- id: task-runtime` entry in the file's first YAML document.
 *   Every other byte — comments, key order, the second document (which is where a
 *   deployment keeps its API credentials) — is carried over verbatim, and the
 *   file is re-read afterwards to prove it: the row region is exactly the text
 *   this module rendered, and the whole file' other bytes are unchanged.
 * - It never prints the file: a refusal names the path and the row, never a line
 *   of the configuration (the deployment's secrets live in that file).
 * - A `null` entry removes the row (the rollback of a row the commit added) —
 *   the same edit in the other direction, so apply and rollback share one path.
 * - A file it cannot edit faithfully is a **named stop with nothing written**: no
 *   `---` document separator, no `- id: task-runtime` entry, no `config:` block,
 *   no `capabilities:` mapping, a `capabilities:` region it cannot read as rows,
 *   or a row name it cannot write as one YAML key.
 *
 * The write is atomic (`writeFileAtomic`: a same-directory staging file, fsynced
 * and renamed over the target), so a crash leaves either the old file or the new
 * one — never half of either — and the commit intent stays open until the
 * completion line records that this file already holds the row.
 *
 * The row's text is a single YAML flow mapping whose scalar is JSON: JSON is a
 * subset of YAML, a quoted key is a YAML key, and the canonical JSON of a row is
 * exactly the row an admission resolves (the promotion gate and the runtime both
 * compare rows by that same canonical form). A row this deployment wrote by hand
 * in another style is *replaced* — the region is found by name — which is stated
 * here as the boundary it is: this writer owns the rows it writes, and a
 * hand-edit of one of them is superseded by the next approved commit (the file's
 * structure and everything beside the row are still preserved byte for byte).
 * @module dsh-singularity-evolution/capability-config
 */

import { readFile } from 'node:fs/promises'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { canonicalJson } from './replay.ts'
import { sha256Hex, writeFileAtomic } from './commit.ts'
import { assertCapabilityRow, capabilityRowDigest } from './capability-candidate.ts'

/** How one document's entries are laid out, as the paragraph reader below walks them. */
interface Lines {
  readonly lines: readonly string[]
  /** Whether the last line ends with a newline, so the file is rewritten with the same shape. */
  readonly trailingNewline: boolean
}

function asLines(text: string): Lines {
  const trailingNewline = text.endsWith('\n')
  return { lines: text.split('\n'), trailingNewline }
}

/** The indentation of a line, or `-1` for a blank one (`\t` is refused by the callers that care). */
function indentOf(line: string): number {
  if (line.trim().length === 0) return -1
  return line.length - line.trimStart().length
}

/** One refusal of this module, naming the file and never quoting it. */
function refusal(file: string, detail: string): Error {
  return new Error(`evolution: the capability table "${file}" cannot be edited: ${detail}`)
}

/** Where one row's text lives inside one file. */
export interface CapabilityRowRegion {
  /** The row's own name, as the file spells it (unquoted). */
  readonly name: string
  /** Line index of the row's first line. */
  readonly start: number
  /** Line index one past the row's last line. */
  readonly end: number
  /** The capabilities block's own indent, so an inserted row lines up with the rows around it. */
  readonly indent: string
  /** The index the block's rows end at — where a new row is inserted. */
  readonly insertAt: number
}

/** The `- id: task-runtime` entry's `capabilities:` block inside the first YAML document. */
function capabilitiesBlock(lines: readonly string[], file: string): { header: number; indent: number; from: number; to: number } {
  const separator = lines.findIndex(line => line.trim() === '---')
  const first = separator < 0 ? lines.length : separator
  let header = -1
  for (let index = 0; index < first; index += 1) {
    const line = lines[index]!
    if (!/^- id:\s*task-runtime\s*$/.test(line)) continue
    // The entry runs until the next top-level list item (or the document's end):
    // its `capabilities:` has to be inside that span.
    let end = first
    for (let next = index + 1; next < first; next += 1) {
      if (/^- /.test(lines[next]!)) {
        end = next
        break
      }
    }
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (/^\s*capabilities:\s*$/.test(lines[cursor]!)) {
        header = cursor
        break
      }
      if (/^\s*capabilities:\s*\S/.test(lines[cursor]!)) {
        throw refusal(file, 'the task-runtime entry declares `capabilities:` inline, and this writer edits a block mapping (nothing was written)')
      }
    }
    if (header >= 0) {
      const indent = indentOf(lines[header]!)
      let to = header + 1
      for (; to < end; to += 1) {
        const line = lines[to]!
        if (indentOf(line) <= indent && line.trim().length > 0) break
      }
      return { header, indent, from: header + 1, to }
    }
    throw refusal(
      file,
      'its task-runtime entry declares no `capabilities:` mapping, so the row this commit moves has nowhere to be written ' +
        '(nothing was written)',
    )
  }
  throw refusal(
    file,
    'it holds no `- id: task-runtime` entry in its first document, so the capability table this deployment loads cannot be located ' +
      '(nothing was written)',
  )
}

/**
 * The row one name maps to inside the file, or `undefined` when the file holds no
 * such row — its region (where to replace it) and the exact text it currently
 * holds (what a reader may compare, never print).
 */
export function capabilityRowRegion(text: string, file: string, name: string): CapabilityRowRegion | undefined {
  const { lines } = asLines(text)
  const block = capabilitiesBlock(lines, file)
  const rowPattern = new RegExp(`^\\s*("?)([^:\\s][^:]*?)\\1:\\s*`)
  let insertAt = block.to
  let indent: string | undefined
  for (let index = block.from; index < block.to; index += 1) {
    const line = lines[index]!
    const match = rowPattern.exec(line)
    if (match === null) continue
    const rowIndent = line.slice(0, indentOf(line))
    if (indent === undefined && indentOf(line) > block.indent) indent = rowIndent
    if (rowIndent !== indent) continue
    const rowName = match[2]!
    if (rowName !== name) continue
    let end = index + 1
    while (end < block.to && indentOf(lines[end]!) > indentOf(line)) end += 1
    return { name: rowName, start: index, end, indent: rowIndent, insertAt: block.to }
  }
  // No such row: the insertion point is the end of the block, and the indent is
  // the one the block's own rows use — or, for an empty block, four spaces past
  // the `capabilities:` key itself.
  return {
    name,
    start: block.to,
    end: block.to,
    indent: indent ?? ' '.repeat(block.indent + 4),
    insertAt,
  }
}

/** The row region's own text, as the file spells it right now. */
export function capabilityRowText(text: string, file: string, name: string): string | null {
  const { lines } = asLines(text)
  const region = capabilityRowRegion(text, file, name)
  if (region === undefined || region.start === region.end) return null
  return lines.slice(region.start, region.end).join('\n')
}

/**
 * The one line this module writes for one row: `<indent>"<name>": <canonical json>`
 * — a YAML flow mapping whose value is JSON, which is a YAML scalar, and whose
 * key is quoted so a name with a colon or a space is still one key.
 */
export function renderCapabilityRow(name: string, entry: CapabilityConfig, indent: string): string {
  return `${indent}${JSON.stringify(name)}: ${canonicalJson(entry)}`
}

/**
 * The file's text with one row written, removed, or added. Pure: the caller
 * decides what the file's current state may be (the commit's own baseline check)
 * and this function only edits the one region.
 *
 * `entry === null` removes the row; a row the file does not hold is *added* at
 * the end of the capabilities block.
 */
export function applyCapabilityRowToConfig(input: {
  readonly text: string
  /** The file's path, for refusals only — never read from it here. */
  readonly file: string
  readonly name: string
  readonly entry: CapabilityConfig | null
}): string {
  const { text, file, name, entry } = input
  const { lines, trailingNewline } = asLines(text)
  const region = capabilityRowRegion(text, file, name)
  if (region === undefined) throw refusal(file, 'no capabilities block was found (nothing was written)')
  const rendered = entry === null ? undefined : renderCapabilityRow(name, entry, region.indent)
  const before = lines.slice(0, region.start)
  const after = lines.slice(region.end)
  const body = entry === null ? [] : [rendered!]
  const edited = [...before, ...body, ...after]
  // `split('\n')` of a file ending in a newline leaves one empty last element;
  // dropping it and re-adding the newline keeps every other byte in place.
  const joined = trailingNewline && edited[edited.length - 1] === '' ? edited.slice(0, -1).join('\n') + '\n' : edited.join('\n')
  return joined
}

/**
 * What one capability write did, as the commit reports it: the file, the row, the
 * direction, the canonical digest of the row the file now reads (the same basis
 * every other comparison of a row uses), and the digest of the exact text the
 * write left.
 */
export interface CapabilityConfigWrite {
  readonly file: string
  readonly name: string
  readonly direction: 'written' | 'removed'
  /** The row's canonical digest as the text now reads it (`null` for a removal). */
  readonly rowDigest: string | null
  /** SHA-256 of the row's rendered text (`null` for a removal). */
  readonly textDigest: string | null
}

/**
 * The row one rendered or read line holds, parsed back from the scalar this module
 * writes: the same parse serves the pre-write check and the read-back, so what the
 * file holds is compared on one basis.
 */
function parsedRow(file: string, name: string, line: string): CapabilityConfig {
  const separator = line.indexOf(': ')
  if (separator < 0) throw refusal(file, `its row "${name}" carries no value on the same line (nothing was written)`)
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(separator + 2))
  } catch (error) {
    throw refusal(
      file,
      `its row "${name}" does not hold the json this writer reads rows as (${error instanceof Error ? error.message : String(error)}) — ` +
        'a row this build writes is `"<name>": <canonical json>`, and a row in another style is not one it will edit (nothing was written)',
    )
  }
  return assertCapabilityRow(`the row "${name}" of ${file}`, parsed)
}

/**
 * Persist one capability row into the deployment's config file, or refuse by
 * name.
 *
 * The order is the write's own: read the file, compute the edit and the region,
 * verify the row text this module is about to leave *parses back as the row it
 * was given* (its JSON scalar and its name), hand the probe its `before-write`
 * stage, write atomically, re-read the file and prove (a) the row region is
 * exactly the rendered text and (b) every other byte is what the read found.
 * Anything that fails is a named stop with the file untouched — except a failure
 * after the rename, which is `read back after the write` and leaves the file
 * holding the row while the commit intent stays open (the next reconciliation
 * re-runs the same edit, which is idempotent: it writes the same bytes again).
 */
export async function writeCapabilityRowToConfig(input: {
  readonly file: string
  readonly name: string
  readonly entry: CapabilityConfig | null
  readonly probe?: (stage: 'before-write' | 'written', row: string) => void
}): Promise<CapabilityConfigWrite> {
  const { file, name, entry, probe } = input
  let current: string
  try {
    current = await readFile(file, 'utf8')
  } catch (error) {
    throw refusal(file, `it cannot be read (${error instanceof Error ? error.message : String(error)}) — nothing was written`)
  }
  const region = capabilityRowRegion(current, file, name)
  if (region === undefined) throw refusal(file, 'no capabilities block was found (nothing was written)')
  const rendered = entry === null ? undefined : renderCapabilityRow(name, entry, region.indent)
  if (rendered !== undefined) {
    // The one check this writer can make without a YAML parser: the scalar it is
    // about to leave is the row it was given. JSON is the subset of YAML the flow
    // mapping is written in, so parsing it back is parsing the row — and the row
    // it parses to is compared canonically, so a rendering that dropped, added or
    // reordered a field is refused instead of being written.
    const parsed = parsedRow(file, name, rendered)
    if (capabilityRowDigest(parsed) !== capabilityRowDigest(entry!)) {
      throw refusal(
        file,
        `the row "${name}" cannot be rendered without changing it (the text reads back as ${capabilityRowDigest(parsed)}, not as ` +
          `${capabilityRowDigest(entry!)}); nothing was written`,
      )
    }
  }
  const next = applyCapabilityRowToConfig({ text: current, file, name, entry })
  probe?.('before-write', name)
  await writeFileAtomic(file, Buffer.from(next, 'utf8'))
  probe?.('written', name)
  let back: string
  try {
    back = await readFile(file, 'utf8')
  } catch (error) {
    throw refusal(
      file,
      `it could not be read back after the write (${error instanceof Error ? error.message : String(error)}) — the row may be written, so the ` +
        'commit intent stays open and the next reconciliation re-runs the same edit',
    )
  }
  if (back !== next) {
    throw refusal(file, 'it changed between the write and the read back — the row may be written, so the commit intent stays open and no completion is recorded')
  }
  const written = capabilityRowText(back, file, name)
  if (entry === null) {
    if (written !== null) throw refusal(file, `the row "${name}" is still there after removing it — the commit is not settled`)
    return { file, name, direction: 'removed', rowDigest: null, textDigest: null }
  }
  const expected = renderCapabilityRow(name, entry, region.indent)
  if (written !== expected) {
    throw refusal(file, `the row "${name}" does not read back as the text this write left — the commit is not settled`)
  }
  const readBack = parsedRow(file, name, written)
  return {
    file,
    name,
    direction: 'written',
    rowDigest: capabilityRowDigest(readBack),
    textDigest: sha256Hex(Buffer.from(expected, 'utf8')),
  }
}
