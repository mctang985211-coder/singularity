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
 * - It writes into the file only while the file reads as a state this proposal's
 *   **prepare froze** (or as this commit's own write, so a retry after a crash
 *   still settles, EVO-2 "内容漂移 … 零应用"): the whole file as prepare read it,
 *   and the whole file this commit's own direction leaves, are three digests of
 *   the file — recorded in the ledger, never a copy of it — and a file that reads
 *   as neither is `capability-table-changed` with nothing written, because a
 *   third party's edit (of the row itself or of any other byte) is not something
 *   this writer may carry over. The same comparison is made across the write's
 *   own seam, so an edit that lands between the read and the rename is refused
 *   too rather than overwritten.
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

/** The refusal a table that is not a frozen state is reported by (EVO-2 内容漂移), naming the file and never quoting it. */
function tableChanged(file: string, detail: string): Error {
  return new Error(`evolution: capability-table-changed: the capability table "${file}" cannot be edited: ${detail}`)
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
 * decides what the file's current state may be (the commit's own frozen-identity
 * check) and this function only edits the one region.
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
 * One table file's **composed identity**, frozen when a capability candidate is
 * prepared (A6, plan §F.4: "prepared 固定 capability 行、文件组合身份及生产基线"):
 * the digest of the whole file as prepare read it, and the digests of the whole
 * files this proposal's own two directions leave — what the apply writes and what
 * the rollback writes. Digests only, never a copy: the file's second document is
 * where a deployment keeps its credentials, and nothing of it but these hashes is
 * recorded (in the ledger, or anywhere else).
 *
 * Every comparison a commit makes about that file is one of these three values
 * (see {@link capabilityTableDrift}), so "the file prepare froze", "the file this
 * commit's own write leaves" and "something a third party did" are three
 * distinguishable states, and the third is never written over.
 */
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

/**
 * Freeze one table file's composed identity for one candidate (pure): the file as
 * read, the file with this candidate's row written in, and the file with the row
 * a rollback restores written in — or, for a row this candidate adds, the file
 * the rollback leaves after removing that row. The rollback's text is computed
 * from the text the *apply* leaves, which is the text the rollback really edits;
 * a row the file already holds is restored in this writer's own rendering, so the
 * rollback's file is not generally the file prepare read, and the identity says
 * exactly which file it is.
 */
export function capabilityTableIdentity(input: {
  readonly text: string
  /** The file's path, for refusals only — never read from it here. */
  readonly file: string
  readonly name: string
  /** The candidate's row — what an apply writes into the file. */
  readonly entry: CapabilityConfig
  /** The row a rollback restores, or `null` when this candidate adds the row and its rollback removes it. */
  readonly restored: CapabilityConfig | null
}): CapabilityTableIdentity {
  const { text, file, name, entry, restored } = input
  const digest = (value: string): string => sha256Hex(Buffer.from(value, 'utf8'))
  const applied = applyCapabilityRowToConfig({ text, file, name, entry })
  return {
    baselineSha256: digest(text),
    applySha256: digest(applied),
    rollbackSha256: digest(applyCapabilityRowToConfig({ text: applied, file, name, entry: restored })),
  }
}

/**
 * The named reason one whole-file digest is not a state a capability write may
 * find, or `null` when it is one of them: `states.beforeSha256`, the state this
 * write starts from, or `states.afterSha256`, the state its own write leaves (so
 * a retry after a crash finds its own result and still settles). Names the row and
 * the digests it compared — never a line of the file, which carries the
 * deployment's credentials; the caller names the file itself.
 */
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
 * stage, prove the file is still the text that edit was computed from **and** that
 * this text is one of the two whole-file states `states` names (the state this
 * write starts from, or the state its own write leaves), stage the bytes, hand
 * the probe its `staged` stage, verify the file one last time (same two checks,
 * asked of the file as it reads now), rename, re-read the file and prove (a) the
 * row region is exactly the rendered text and (b) every other byte is what the
 * read found. Anything that fails is a named stop with the file untouched —
 * except a failure after the rename, which is `read back after the write` and
 * leaves the file holding the row while the commit intent stays open (the next
 * reconciliation re-runs the same edit, which is idempotent: it writes the same
 * bytes again, and finds the file its own write left among the states it
 * accepts).
 *
 * The checks before the write are the drift gate the commit path never had:
 * without them this writer carried a *stale* read — of the row's own bytes and of
 * every other byte of the file — over whatever a third party wrote in the
 * meantime. The state comparisons run after each probe stage, so a write made at
 * a seam is refused as well; they are asked of the file's bytes, never of a
 * parsed row, because the deployment's file is not this writer's to reformat.
 *
 * **The `staged` check is the last observation of the file before the rename,
 * and that is a requirement, not an implementation detail** (EVO-2 P2): POSIX
 * rename replaces the target unconditionally, so a third party's write that
 * lands after the last read and before the rename would be silently overwritten.
 * `writeFileAtomic` fires its hook between the staging file's fsync and the
 * rename, and the re-read and the whole-file comparison run inside that hook —
 * there is no injectable seam left after them. A file that changed under the
 * staged bytes is `capability-table-changed`, the staging file is removed and the
 * target keeps exactly the third party's bytes.
 */
export async function writeCapabilityRowToConfig(input: {
  readonly file: string
  readonly name: string
  readonly entry: CapabilityConfig | null
  /**
   * The two whole-file states this write may find, as the proposal's prepare
   * froze them for this direction (see {@link CapabilityTableIdentity}): the file
   * it starts from, and the file its own write leaves.
   */
  readonly states: CapabilityTableStates
  readonly probe?: (stage: 'before-write' | 'staged' | 'written', row: string) => void
}): Promise<CapabilityConfigWrite> {
  const { file, name, entry, states, probe } = input
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
  // The window between the read this edit was computed from and the rename is
  // closed here: the file is read again, and a write that landed in that window
  // is refused rather than carried over (the edit describes the text the first
  // read found, and that text is no longer the file's).
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
  // be seen: everything after it is one rename, and a rename replaces whatever
  // the target holds. So the file is read and compared once more here, and a
  // change that landed under the staged bytes removes them (the hook's failure
  // path) instead of being overwritten — the third party's bytes are what the
  // file keeps.
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
  await writeFileAtomic(file, Buffer.from(next, 'utf8'), verifyStaged)
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
