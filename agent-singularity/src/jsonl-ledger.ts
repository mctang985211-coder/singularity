/** The package's JSONL ledger primitives: read one append-only file line by line, and append one row. @module @dangosys/dsh-singularity-agent/jsonl-ledger */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Every non-empty line of one JSONL file, parsed in order, or `undefined` when the file has never been written. A line the caller's parser refuses throws under the caller's own name. */
export async function readJsonlFile<Row>(
  file: string,
  parse: (line: string, lineNumber: number) => Row,
): Promise<Row[] | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const rows: Row[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return
    rows.push(parse(line, index + 1))
  })
  return rows
}

/** Append one row to a JSONL file, creating its directory. */
export async function appendJsonlRow(file: string, row: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
}
