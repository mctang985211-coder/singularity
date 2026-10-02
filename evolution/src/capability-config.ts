/** The capability table's own text (A6): the deployment config's capabilities row, read, frozen and written as one whole file.
 * @module dsh-singularity-evolution/capability-config */

import { readFile } from 'node:fs/promises'
import { parseMcpServerRegistry, type McpServerTemplate, type CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { canonicalJson } from './replay.ts'
import { writeFileAtomic } from './commit.ts'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { tableChangedRefusal, tableRefusal } from './shared.ts'
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
  return tableRefusal(file, detail)
}

/** The refusal a table that is not a frozen state is reported by (EVO-2 内容漂移), naming the file and never quoting it. */
function tableChanged(file: string, detail: string): Error {
  return tableChangedRefusal(file, detail)
}

/** Where one row's text lives inside one file. */
interface CapabilityRowRegion {
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
function capabilitiesBlock(
  lines: readonly string[],
  file: string,
): { header: number; indent: number; from: number; to: number } {
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
        throw refusal(
          file,
          'the task-runtime entry declares `capabilities:` inline, and this writer edits a block mapping (nothing was written)',
        )
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

/** The row one name maps to inside the file, or `undefined` when the file holds no such row. */
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
  // No such row: the insertion point is the end of the block, and the indent is the block's own.
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

/** The one line this module writes for one row: `<indent>"<name>": <canonical json>` */
export function renderCapabilityRow(name: string, entry: CapabilityConfig, indent: string): string {
  return `${indent}${JSON.stringify(name)}: ${canonicalJson(entry)}`
}

/** The file's text with one row written, removed, or added. Pure: the caller writes it. */
export function applyCapabilityRowToConfig(input: {
  readonly text: string
  /** The file's path, for refusals only — never read from it here. */
  readonly file: string
  readonly name: string
  readonly entry: CapabilityConfig | null
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate | null>>
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
  const joined =
    trailingNewline && edited[edited.length - 1] === '' ? edited.slice(0, -1).join('\n') + '\n' : edited.join('\n')
  return applyMcpServersToConfig(joined, file, input.mcpServers ?? {})
}

/** Edit the same task-runtime configuration document; row and definitions share one atomic write. */
function applyMcpServersToConfig(text: string, file: string, definitions: Readonly<Record<string, McpServerTemplate | null>>): string {
  if (Object.keys(definitions).length === 0) return text
  parseMcpServerRegistry(Object.fromEntries(Object.entries(definitions).filter(([, value]) => value !== null)))
  const lines = [...asLines(text).lines]
  const capability = capabilitiesBlock(lines, file)
  const runtime = lines.findIndex(line => /^- id:\s*task-runtime\s*$/.test(line))
  let end = runtime + 1
  while (end < lines.length && !/^- |^---\s*$/.test(lines[end]!)) end++
  let header = -1
  for (let i = runtime + 1; i < end; i++) {
    if (/^\s*mcpServers:\s*$/.test(lines[i]!)) header = i
    else if (/^\s*mcpServers:\s*\S/.test(lines[i]!)) throw refusal(file, 'mcpServers must be a block mapping')
  }
  if (header < 0) {
    if (Object.values(definitions).every(value => value === null)) return text
    header = capability.header
    lines.splice(header, 0, `${' '.repeat(capability.indent)}mcpServers:`)
  }
  const indent = indentOf(lines[header]!)
  let to = header + 1
  while (to < lines.length && (indentOf(lines[to]!) > indent || lines[to]!.trim().length === 0)) to++
  const body = lines.slice(header + 1, to)
  const existingRow = body.find(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
  const rowIndent = ' '.repeat(existingRow === undefined ? indent + 4 : indentOf(existingRow))
  for (const [name, definition] of Object.entries(definitions)) {
    let start = body.findIndex(line => {
      if (indentOf(line) <= indent) return false
      const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^:\s]+)):\s*/.exec(line)
      return (match?.[1] ?? match?.[2] ?? match?.[3]) === name
    })
    let stop = start + 1
    if (start >= 0) while (stop < body.length && indentOf(body[stop]!) > indentOf(body[start]!)) stop++
    else start = stop = body.length
    body.splice(start, stop - start, ...(definition === null ? [] : [`${rowIndent}${JSON.stringify(name)}: ${canonicalJson(definition)}`]))
  }
  if (body.every(line => line.trim().length === 0)) lines.splice(header, to - header)
  else lines.splice(header + 1, to - header - 1, ...body)
  return lines.join('\n')
}

/** One table file's **composed identity**, frozen when a capability candidate is prepared. */
export interface CapabilityTableIdentity {
  /** SHA-256 of the whole file as prepare read it. */
  readonly baselineSha256: string
  /** SHA-256 of the whole file the apply leaves (this candidate's row written in). */
  readonly applySha256: string
  /** SHA-256 of the whole file the rollback leaves (the row it restores written in, or the row it removes). */
  readonly rollbackSha256: string
}

/** The two whole-file states one capability write may find: the state it starts from, and the state its own write leaves. */
export interface CapabilityTableStates {
  readonly beforeSha256: string
  readonly afterSha256: string
}

/** Freeze one table file's composed identity for one candidate (pure): the file as prepare read it and the files apply and rollback leave. */
export function capabilityTableIdentity(input: {
  readonly text: string
  /** The file's path, for refusals only — never read from it here. */
  readonly file: string
  readonly name: string
  /** The candidate's row — what an apply writes into the file. */
  readonly entry: CapabilityConfig
  /** The row a rollback restores, or `null` when this candidate adds the row and its rollback removes it. */
  readonly restored: CapabilityConfig | null
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate>>
}): CapabilityTableIdentity {
  const { text, file, name, entry, restored } = input
  const digest = (value: string): string => sha256Hex(Buffer.from(value, 'utf8'))
  const applied = applyCapabilityRowToConfig({ text, file, name, entry, ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }) })
  return {
    baselineSha256: digest(text),
    applySha256: digest(applied),
    rollbackSha256: digest(applyCapabilityRowToConfig({ text: applied, file, name, entry: restored, mcpServers: Object.fromEntries(Object.keys(input.mcpServers ?? {}).map(key => [key, null])) })),
  }
}

/** The named reason one whole-file digest is not a state a capability write may overwrite, or `null` when it is one of the two states. */
export function capabilityTableDrift(input: {
  readonly name: string
  readonly seen: string
  readonly states: CapabilityTableStates
}): string | null {
  const { name, seen, states } = input
  if (seen === states.beforeSha256 || seen === states.afterSha256) return null
  return (
    `it reads sha256 ${seen}, which is neither the whole-file state this write starts from (sha256 ${states.beforeSha256}) nor the state ` +
    `its own write leaves (sha256 ${states.afterSha256}) — the row "${name}" is not written over a third party's move of the file, and the ` +
    'bytes that move left are exactly the bytes it keeps'
  )
}

/** What one capability write did, as the commit reports it: the file, the row, the direction and the two digests. */
interface CapabilityConfigWrite {
  readonly file: string
  readonly name: string
  readonly direction: 'written' | 'removed'
  /** The row's canonical digest as the text now reads it (`null` for a removal). */
  readonly rowDigest: string | null
  /** SHA-256 of the row's rendered text (`null` for a removal). */
  readonly textDigest: string | null
}

/** The row one rendered or read line holds, parsed back from the scalar this module renders. */
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

/** Persist one capability row into the deployment's config file, or refuse by name with nothing written. */
export async function writeCapabilityRowToConfig(input: {
  readonly file: string
  readonly name: string
  readonly entry: CapabilityConfig | null
  readonly mcpServers?: Readonly<Record<string, McpServerTemplate | null>>
  /** The two whole-file states this write may find, as the proposal's prepare froze them. */
  readonly states: CapabilityTableStates
  readonly probe?: (stage: 'before-write' | 'staged' | 'written', row: string) => void
}): Promise<CapabilityConfigWrite> {
  const { file, name, entry, states, probe } = input
  let current: string
  try {
    current = await readFile(file, 'utf8')
  } catch (error) {
    throw refusal(
      file,
      `it cannot be read (${error instanceof Error ? error.message : String(error)}) — nothing was written`,
    )
  }
  const region = capabilityRowRegion(current, file, name)
  if (region === undefined) throw refusal(file, 'no capabilities block was found (nothing was written)')
  const rendered = entry === null ? undefined : renderCapabilityRow(name, entry, region.indent)
  if (rendered !== undefined) {
    // The one check this writer can make without a YAML parser: the scalar it is about to leave must parse back to the row it wrote.
    const parsed = parsedRow(file, name, rendered)
    if (capabilityRowDigest(parsed) !== capabilityRowDigest(entry!)) {
      throw refusal(
        file,
        `the row "${name}" cannot be rendered without changing it (the text reads back as ${capabilityRowDigest(parsed)}, not as ` +
          `${capabilityRowDigest(entry!)}); nothing was written`,
      )
    }
  }
  const next = applyCapabilityRowToConfig({ text: current, file, name, entry, ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }) })
  probe?.('before-write', name)
  // The window between the read this edit was computed from and the rename is closed by this re-read of the file.
  let reread: string
  try {
    reread = await readFile(file, 'utf8')
  } catch (error) {
    throw refusal(
      file,
      `it could not be read again before the write (${error instanceof Error ? error.message : String(error)}) — nothing was written`,
    )
  }
  if (reread !== current) {
    throw tableChanged(
      file,
      `it changed between the read this write's edit was computed from and the write itself — the write that landed in that window is not ` +
        `one this commit may carry over, so the row "${name}" was not written into it and the file is left exactly as that write left it`,
    )
  }
  const drift = capabilityTableDrift({ name, seen: sha256Hex(Buffer.from(reread, 'utf8')), states })
  if (drift !== null) throw tableChanged(file, `${drift}; nothing was written`)
  // The staged seam is the last point at which a third party's write can still
  const verifyStaged = async (): Promise<void> => {
    probe?.('staged', name)
    let staged: string
    try {
      staged = await readFile(file, 'utf8')
    } catch (error) {
      throw refusal(
        file,
        `it could not be read again immediately before the rename (${error instanceof Error ? error.message : String(error)}) — ` +
          `nothing was written, and the staged bytes of the row "${name}" are removed`,
      )
    }
    const changed = capabilityTableDrift({ name, seen: sha256Hex(Buffer.from(staged, 'utf8')), states })
    if (changed !== null) {
      throw tableChanged(
        file,
        `${changed}; the write that landed in the window between this edit and the rename is not one this commit may carry over, so ` +
          `the staged bytes of the row "${name}" were removed and the file keeps exactly what that write left`,
      )
    }
  }
  if (next !== current) {
    await writeFileAtomic(file, Buffer.from(next, 'utf8'), verifyStaged)
    probe?.('written', name)
  }
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
    throw refusal(
      file,
      'it changed between the write and the read back — the row may be written, so the commit intent stays open and no completion is recorded',
    )
  }
  const written = capabilityRowText(back, file, name)
  if (entry === null) {
    if (written !== null)
      throw refusal(file, `the row "${name}" is still there after removing it — the commit is not settled`)
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
