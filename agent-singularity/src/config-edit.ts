/**
 * Text-level surgery on `config.yml` for the evolution apply/rollback track
 * (guide §2.7.7, W16): replace, add, or remove exactly one capability row in
 * document 1's `- id: task-runtime` entry. Nothing else moves — document 2 (the
 * `api:` block) and every other line stay byte-identical; there is no
 * whole-file YAML round-trip, so comments and formatting survive untouched.
 *
 * Comment ownership: a comment or blank line belongs to the entry above it when
 * it is indented at the entry's level or deeper (or sits inside that entry's
 * block body); a comment at or above the `capabilities:` indent belongs to the
 * mapping header. So an entry's span — and therefore an addition's insertion
 * point — covers its block-form body and the trailing comments that ride with
 * it, while header comments stay put.
 *
 * W19 (guide §4.2 #18) adds the read/restore pair: `readCapabilityRowSource`
 * captures a row's verbatim source lines at prepare time, and
 * `restoreCapabilityRowSource` splices them back at rollback, so a round trip
 * is byte-identical instead of schema-normalized.
 * @module dsh-singularity-agent
 */

import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'

export type CapabilityRowAction = 'replaced' | 'added' | 'removed'

export interface CapabilityRowResult {
  text: string
  action: CapabilityRowAction
}

/** A plain YAML scalar needs no quoting; anything else renders JSON-quoted (valid YAML 1.2 flow). */
function flowScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : JSON.stringify(value)
}

/**
 * The row's flow value, keys in the mutation schema's fixed order:
 * `{ skills: [verify], preset: bb-verify, mcpServers: [bbdev] }`. Every key of
 * `CapabilityConfig` renders, `mcpServers` included — a row that dropped it
 * would leave the runtime override granting a server plane the restarted
 * process no longer mounts.
 */
function flowEntry(entry: CapabilityConfig): string {
  const parts: string[] = []
  if (entry.skills !== undefined) parts.push(`skills: [${entry.skills.map(flowScalar).join(', ')}]`)
  if (entry.tools !== undefined) parts.push(`tools: [${entry.tools.map(flowScalar).join(', ')}]`)
  if (entry.preset !== undefined) parts.push(`preset: ${flowScalar(entry.preset)}`)
  if (entry.permission !== undefined) parts.push(`permission: ${flowScalar(entry.permission)}`)
  if (entry.mcpServers !== undefined) parts.push(`mcpServers: [${entry.mcpServers.map(flowScalar).join(', ')}]`)
  return `{ ${parts.join(', ')} }`
}

/** The row key as written: a plain scalar when safe, else its JSON-quoted form. */
function keySpelling(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ? name : JSON.stringify(name)
}

/** Does this line open the capabilities row for `name` (`name: {…}` or block-form `name:`)? */
function rowKeyMatch(trimmed: string, name: string): boolean {
  for (const spelling of [name, JSON.stringify(name)]) {
    if (trimmed === `${spelling}:` || trimmed.startsWith(`${spelling}: `) || trimmed.startsWith(`${spelling}:\t`)) return true
  }
  return false
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** The capabilities mapping header: `capabilities:`, `capabilities: {}`, and an optional trailing comment. */
const CAPABILITIES_HEADER = /^\s+capabilities:\s*(\{\s*\})?\s*(#.*)?$/

/** The trailing `# …` comment of a header line, whitespace-normalized, or `''`. */
function commentSuffix(line: string): string {
  const comment = /\s(#.*)$/.exec(line)?.[1]
  return comment === undefined ? '' : ` ${comment}`
}

/**
 * Exclusive end of the entry starting at `head`: its own line, the deeper lines
 * of a block-form body, and the comment or blank lines that ride with it. A
 * comment or blank line indented at or above the mapping-header indent ends the
 * entry — it belongs to the header (or to the next sibling), not to this row —
 * unless the next content line is still part of this entry's deeper body, which
 * keeps a blank line *inside* a block body with the entry.
 */
function entryEnd(lines: string[], head: number, regionEnd: number, headerIndent: number): number {
  const indent = indentOf(lines[head]!)
  let end = head + 1
  for (let index = head + 1; index < regionEnd; index += 1) {
    const line = lines[index]!
    if (isCommentOrBlank(line)) {
      let after = index + 1
      while (after < regionEnd && isCommentOrBlank(lines[after]!)) after += 1
      const insideBody = after < regionEnd && indentOf(lines[after]!) > indent
      if (!insideBody && indentOf(line) <= headerIndent) break
      end = index + 1
      continue
    }
    if (indentOf(line) <= indent) break
    end = index + 1
  }
  return end
}

/** Where the capabilities row for `name` sits inside document 1's task-runtime entry. */
interface CapabilityRowLocation {
  lines: string[]
  eol: string
  capIndex: number
  capIndent: number
  capCollapsed: boolean
  /** Head line of the row's span, or -1 when no row for the name exists. */
  rowStart: number
  /** Lines the row's span covers (block-form body and riding comments included). */
  rowSpan: number
  /** Exclusive end of the capabilities mapping's row region. */
  regionEnd: number
  /** Where a new row goes: after the last entry's whole span, else past the header's comment lines. */
  insertAt: number
  /** Indent a new row takes when no existing row sets one. */
  entryIndent: number
}

/**
 * Locate the capabilities row for `name`, scanning exactly the region
 * `editCapabilityRow` edits. Throws — locating nothing — when document 1 has no
 * task-runtime entry, more than one (the error names every matching line —
 * refusing to guess which one governs), or no capabilities mapping.
 */
function locateCapabilityRow(text: string, name: string): CapabilityRowLocation {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const docEnd = lines.findIndex(line => line.trim() === '---')
  const doc1End = docEnd === -1 ? lines.length : docEnd

  const itemIndices: number[] = []
  for (let index = 0; index < doc1End; index += 1) {
    if (/^\s*-\s+id:\s*task-runtime\s*$/.test(lines[index]!)) itemIndices.push(index)
  }
  if (itemIndices.length === 0) throw new Error('config.yml: document 1 has no "- id: task-runtime" entry')
  if (itemIndices.length > 1) {
    throw new Error(
      `config.yml: document 1 has ${itemIndices.length} "- id: task-runtime" entries ` +
      `(lines ${itemIndices.map(index => index + 1).join(', ')}); refusing to guess — keep exactly one`,
    )
  }
  const itemIndex = itemIndices[0]!
  const itemIndent = indentOf(lines[itemIndex]!)
  let blockEnd = doc1End
  for (let index = itemIndex + 1; index < doc1End; index += 1) {
    const line = lines[index]!
    if (!isCommentOrBlank(line) && indentOf(line) <= itemIndent) {
      blockEnd = index
      break
    }
  }

  let capIndex = -1
  for (let index = itemIndex + 1; index < blockEnd; index += 1) {
    if (CAPABILITIES_HEADER.test(lines[index]!)) {
      capIndex = index
      break
    }
  }
  if (capIndex === -1) throw new Error('config.yml: the task-runtime entry has no "capabilities:" mapping')
  const capIndent = indentOf(lines[capIndex]!)
  const capCollapsed = /^\s+capabilities:\s*\{\s*\}/.test(lines[capIndex]!)

  let regionEnd = blockEnd
  for (let index = capIndex + 1; index < blockEnd; index += 1) {
    const line = lines[index]!
    if (!isCommentOrBlank(line) && indentOf(line) <= capIndent) {
      regionEnd = index
      break
    }
  }

  let rowStart = -1
  let rowSpan = 0
  let lastEntryEnd = -1
  let entryIndent = capIndent + 2
  for (let index = capIndex + 1; index < regionEnd; index += 1) {
    const line = lines[index]!
    if (isCommentOrBlank(line) || index < lastEntryEnd) continue // still inside the previous entry's span
    lastEntryEnd = entryEnd(lines, index, regionEnd, capIndent)
    entryIndent = indentOf(line)
    if (rowStart === -1 && rowKeyMatch(line.trimStart(), name)) {
      rowStart = index
      rowSpan = lastEntryEnd - index
    }
  }

  // Where a new row goes: after the last entry's whole span, else past the header's comment lines.
  let insertAt = lastEntryEnd
  if (insertAt === -1) {
    insertAt = capIndex + 1
    while (insertAt < regionEnd && isCommentOrBlank(lines[insertAt]!)) insertAt += 1
  }

  return { lines, eol, capIndex, capIndent, capCollapsed, regionEnd, rowStart, rowSpan, insertAt, entryIndent }
}

/**
 * The row's verbatim source lines (`\n`-joined, block-form body and riding
 * comments included), or null when no row for `name` exists. The rollback
 * anchor of a capability prepare (W19, guide §4.2 #18): restoring these lines
 * beats re-rendering the registry entry, whose schema fills default arrays the
 * source text never spelled out.
 */
export function readCapabilityRowSource(text: string, name: string): string | null {
  const located = locateCapabilityRow(text, name)
  if (located.rowStart === -1) return null
  return located.lines.slice(located.rowStart, located.rowStart + located.rowSpan).join('\n')
}

/**
 * Splice `source` (the `\n`-joined lines `readCapabilityRowSource` captured at
 * prepare time) back over the current row for `name`, byte-for-byte; when the
 * row is gone, insert the lines where a new row would go. Every other byte of
 * the file is preserved, exactly as with `editCapabilityRow`.
 */
export function restoreCapabilityRowSource(text: string, name: string, source: string): CapabilityRowResult {
  const { lines, eol, capIndex, capIndent, capCollapsed, rowStart, rowSpan, insertAt } = locateCapabilityRow(text, name)
  const sourceLines = source.replace(/\r?\n$/, '').split('\n')
  if (rowStart !== -1) {
    lines.splice(rowStart, rowSpan, ...sourceLines)
    return { text: lines.join(eol), action: 'replaced' }
  }
  // `capabilities: {}` cannot take a block row below it, so the header reopens.
  if (capCollapsed) lines[capIndex] = `${' '.repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex]!)}`
  lines.splice(insertAt, 0, ...sourceLines)
  return { text: lines.join(eol), action: 'added' }
}

/**
 * Replace (`entry` given, row exists), add (`entry` given, row absent), or
 * remove (`entry` null) the capabilities row for `name`. The row is one line in
 * flow form (`name: { … }`) or a block-form span (`name:` plus deeper-indented
 * lines and the comment lines that ride with it); a replacement always lands as
 * one flow line at the row's indent, an addition after the last existing row's
 * whole span. Removing the final row collapses the mapping header to
 * `capabilities: {}` so the document still parses as a mapping, and adding to a
 * collapsed header reopens it — `capabilities: {}` cannot take block rows below
 * it. Throws — editing nothing — when document 1 has no task-runtime entry, more
 * than one (the error names every matching line — refusing to guess which one
 * governs), no capabilities mapping, or a removal names no existing row.
 */
export function editCapabilityRow(text: string, name: string, entry: CapabilityConfig | null): CapabilityRowResult {
  const { lines, eol, capIndex, capIndent, capCollapsed, regionEnd, rowStart, rowSpan, insertAt, entryIndent } =
    locateCapabilityRow(text, name)

  const rowLine = `${' '.repeat(rowStart === -1 ? entryIndent : indentOf(lines[rowStart]!))}${keySpelling(name)}: ${flowEntry(entry ?? {})}`

  if (entry !== null && rowStart !== -1) {
    lines.splice(rowStart, rowSpan, rowLine)
    return { text: lines.join(eol), action: 'replaced' }
  }
  if (entry !== null) {
    // `capabilities: {}` cannot take a block row below it, so the header reopens.
    if (capCollapsed) lines[capIndex] = `${' '.repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex]!)}`
    lines.splice(insertAt, 0, rowLine)
    return { text: lines.join(eol), action: 'added' }
  }
  if (rowStart === -1) throw new Error(`config.yml: no capabilities row for "${name}" to remove`)
  lines.splice(rowStart, rowSpan)
  const entriesLeft = lines.slice(capIndex + 1, regionEnd - rowSpan).some(line => !isCommentOrBlank(line))
  if (!entriesLeft) lines[capIndex] = `${' '.repeat(capIndent)}capabilities: {}`
  return { text: lines.join(eol), action: 'removed' }
}
