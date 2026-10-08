/**
 * The v5 ledger on disk: `<root>/methods.jsonl`, one record per line. A line is
 * folded before it is written and again on load, so a file a hand edited is
 * refused by name rather than folded into a state no sequence of records made.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isMethodRecordV5, validateDraftRecord } from '../ledger/records.ts'
import type { EvolutionRecordV5 } from '../ledger/records.ts'
import { foldMethods } from '../ledger/fold.ts'
import type { MethodLedger } from '../draft/draft.ts'
import { readLegacyMethods } from '../history/legacy-reader.ts'

/** One open v5 ledger: the records it holds and the one write door. */
export interface MethodLedgerStore extends MethodLedger {
  readonly root: string
  readonly file: string
  /** Every v4 line the file held, projected read-only; empty for a new-protocol ledger. */
  legacy(): Promise<readonly import('../history/legacy-reader.ts').LegacyMethodView[]>
  reload(): Promise<void>
}

function lineOf(record: EvolutionRecordV5): string {
  return `${JSON.stringify(record)}\n`
}

/** Parse one ledger file's bytes into v5 records, refusing a mixed or hand-edited file by name. */
export function parseMethodLedger(text: string, where: string): EvolutionRecordV5[] {
  const records: EvolutionRecordV5[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error(`evolution: corrupt ledger line ${index + 1} in ${where}`)
    }
    if (!isMethodRecordV5(raw)) {
      throw new Error(
        `evolution: ledger line ${index + 1} of ${where} is not a v5 record; a v4 ledger is history and is read through the legacy projection, ` +
          'never appended to',
      )
    }
    validateDraftRecord(raw)
    records.push(raw)
  }
  foldMethods(records)
  return records
}

/** Open one library's ledger; a file that does not exist yet holds no drafts. */
export async function openMethodLedger(input: { root: string; libraryId: string }): Promise<MethodLedgerStore> {
  const file = `${input.root}/methods.jsonl`
  let records: EvolutionRecordV5[] = []
  let writes: Promise<void> = Promise.resolve()

  const loadInto = async (): Promise<void> => {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        records = []
        return
      }
      throw error
    }
    records = parseMethodLedger(text, file)
  }
  await loadInto()

  return {
    root: input.root,
    file,
    libraryId: input.libraryId,
    records: () => records,
    reload: loadInto,
    async legacy() {
      return await readLegacyMethods(file, { libraryId: input.libraryId })
    },
    async append(record: EvolutionRecordV5): Promise<void> {
      const step = `${record.kind} record`
      const run = writes.then(async () => {
        validateDraftRecord(record)
        const staged = [...records, record]
        foldMethods(staged)
        await mkdir(input.root, { recursive: true })
        let handle: FileHandle | undefined
        try {
          handle = await open(file, 'a')
          await handle.writeFile(lineOf(record), 'utf8')
          await handle.sync()
        } catch (error) {
          throw new Error(
            `evolution: the ${step} could not be written to ${file} (${error instanceof Error ? error.message : String(error)}); it is not ` +
              'durable, so nothing may depend on it',
          )
        } finally {
          await handle?.close().catch(() => {})
        }
        records = staged
      })
      writes = run.then(
        () => undefined,
        () => undefined,
      )
      await run
    },
  }
}
