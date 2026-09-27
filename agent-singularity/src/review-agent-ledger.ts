/**
 * The review-agent ledger: how many review agents one root task store has
 * started, so the escalation budget guardrail survives process restarts. The
 * count is durable — the rows the file holds — and it is taken inside
 * {@link admitReviewAgent}'s serial region, so two executions that would read
 * the same count cannot both start a review agent. The row is the only count
 * there is: no process cache and no reservation stands in for it.
 *
 * This is deliberately NOT a task-store event. The task store records what
 * happened to tasks; a review agent is a runtime act of the root agent, and
 * writing it into the task log would make a tool's bookkeeping part of the
 * domain's event history. So the count lives in an append-only JSONL file
 * under `$DSH_HOME`, the same shape (and the same home) the Evolution ledger
 * uses (`@dangosys/dsh-singularity-evolution`).
 *
 * Counts are per root store — one root graph, one budget. The file opens per
 * append, so there is no handle to close. The path is overridable through
 * `SINGULARITY_REVIEW_LEDGER_DIR` (tests) and the cap through
 * `SINGULARITY_REVIEW_AGENT_BUDGET`.
 * @module @dangosys/dsh-singularity-agent/review-agent-ledger
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReviewerBindingError } from '@dangosys/dsh-singularity-context'
import type { ReviewerBindingRecord } from '@dangosys/dsh-singularity-context'
import { REVIEW_AGENT_BUDGET_DEFAULT } from './tools/review-escalation.ts'

/** One started review agent. Immutable; the file is append-only. */
export interface ReviewAgentLedgerRecord {
  formatVersion: 1
  /** The root task store the budget is counted against. */
  rootStoreId: string
  /** The task the review agent was started for. */
  taskId: string
  /** The review agent's own session id. */
  sessionId: string
  /** The session that started it (the caller). */
  actor: string
  at: string
}

/** One started review agent as a caller submits it (the store id, the format version and the time are the ledger's). */
export interface ReviewAgentRunStart {
  readonly taskId: string
  readonly sessionId: string
  readonly actor: string
}

/** What one review-agent admission is given inside its store's serial region. */
export interface ReviewAgentAdmission {
  /**
   * The rows the ledger holds for this store as the file reads right now, taken
   * inside this admission's serial region and re-read on every call — never a
   * cache. Deferred to the call so an attempt a caller can already answer, with
   * no new start, reads the ledger not at all (K4-5).
   */
  started(): Promise<number>
  /** Persist this run's row — the durable started fact, written inside the same region. */
  start(record: ReviewAgentRunStart): Promise<void>
}

/** Repo root, derived at this file's depth — the same root the agent assembly hands the evolution ledger. */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Directory holding the ledger; `$DSH_HOME/review-agents` unless overridden. */
export function reviewAgentLedgerDir(): string {
  const override = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  if (override !== undefined && override.length > 0) return resolve(override)
  const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh')
  return join(dshHome, 'review-agents')
}

/** The ledger file (`<dir>/agents.jsonl`). */
export function reviewAgentLedgerFile(): string {
  return join(reviewAgentLedgerDir(), 'agents.jsonl')
}

/** The per-root-store cap; `SINGULARITY_REVIEW_AGENT_BUDGET` when it parses to a positive integer. */
export function reviewAgentBudget(): number {
  const raw = process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  const parsed = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : REVIEW_AGENT_BUDGET_DEFAULT
}

/** The rows one ledger file holds, as its non-empty lines. A corrupt line throws by name rather than undercounting. */
function parseLedgerRows(text: string): ReviewAgentLedgerRecord[] {
  const rows: ReviewAgentLedgerRecord[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return
    try {
      rows.push(JSON.parse(line) as ReviewAgentLedgerRecord)
    } catch {
      throw new Error(`review-agent-ledger: corrupt line ${index + 1} in ${reviewAgentLedgerFile()}`)
    }
  })
  return rows
}

/** Every ledger row, or `undefined` when the ledger has never been written (zero rows is a state, not a failure). */
async function readLedgerRows(): Promise<ReviewAgentLedgerRecord[] | undefined> {
  let text: string
  try {
    text = await readFile(reviewAgentLedgerFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseLedgerRows(text)
}

/**
 * How many review agents this root store has already started, as the file reads
 * right now. A missing file reads as zero; a corrupt line throws rather than
 * silently undercounting.
 *
 * The read door is shared: an admission takes its count through this function
 * from inside its store's serial region ({@link admitReviewAgent}), so what it
 * decides on is the file as that region reads it and never a cache — the region
 * is what keeps the read and the row the admission writes together.
 */
export async function countReviewAgentRuns(rootStoreId: string): Promise<number> {
  const rows = await readLedgerRows()
  return (rows ?? []).filter(row => row.rootStoreId === rootStoreId).length
}

/** The budget one admission belongs to: a ledger file and a root store. */
function budgetKey(rootStoreId: string): string {
  return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`
}

/**
 * The serial regions, one promise chain per budget key. A region is the only
 * place a row is counted, decided on, or written, so the count an admission
 * decides with and the row it writes cannot have another admission in between
 * them (K4-1). The chain's tail is settled either way, so a failed region
 * cannot wedge the key's next admission.
 */
const regions = new Map<string, Promise<void>>()

/** Append one started review agent's row. Only {@link admitReviewAgent} writes, and only inside its region. */
async function appendStartedRow(rootStoreId: string, record: ReviewAgentRunStart): Promise<void> {
  const file = reviewAgentLedgerFile()
  await mkdir(dirname(file), { recursive: true })
  const line: ReviewAgentLedgerRecord = {
    formatVersion: 1,
    rootStoreId,
    taskId: record.taskId,
    sessionId: record.sessionId,
    actor: record.actor,
    at: new Date().toISOString(),
  }
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
}

/**
 * Run one review-agent admission inside the ledger's serial region for a store.
 *
 * One region per (ledger file, root store): `work` runs with a `started()` that
 * counts this store's rows — the file, read inside the region on each call — and
 * a `start` that appends this run's row to the same file, the durable started
 * fact — and the region ends when `work` returns or throws. The count is
 * deferred to `work` instead of read for it, so a caller that can answer an
 * attempt it already holds reads the ledger not at all (K4-5) while the count
 * itself stays durable and uncached. Nothing else is serialized: waiting for the
 * reviewer's output, its watchdog, and recording its Diagnosis happen after
 * `work` returned, outside the region, in the caller.
 *
 * The consequence to rely on: two admissions for one store cannot interleave
 * their count-and-write, so the second one reads the count the first left
 * behind instead of a file that has not caught up yet. A `start` that fails
 * writes no row and spends nothing, and the failed region does not wedge the
 * key.
 *
 * `work` must not await another admission for the same store (that region waits
 * for this one) and must await every `start` it calls before returning.
 *
 * @param rootStoreId - the root task store the budget belongs to.
 * @param work - the admission decision and the spawn, given the store's count read and its write door.
 * @returns whatever `work` returned, once the region has ended.
 */
export async function admitReviewAgent<T>(
  rootStoreId: string,
  work: (admission: ReviewAgentAdmission) => Promise<T>,
): Promise<T> {
  const key = budgetKey(rootStoreId)
  const previous = regions.get(key) ?? Promise.resolve()
  const result = previous.then(async () => {
    const admission: ReviewAgentAdmission = {
      started: () => countReviewAgentRuns(rootStoreId),
      start: record => appendStartedRow(rootStoreId, record),
    }
    return work(admission)
  })
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  regions.set(key, tail)
  void tail.then(() => {
    if (regions.get(key) === tail) regions.delete(key)
  })
  return result
}

/**
 * The one delegation a session is recorded under, as the context package's
 * reviewer binding source reads it (A2 §D): the ledger's `sessionId` is the
 * review agent's own session, so the rows naming it are its delegation. One
 * row is the record; several rows that disagree are a conflict the reader may
 * not pick between (a read domain chosen by file order is not an
 * authorization), and a ledger this process cannot read is `unreadable` —
 * both raised as the context package's {@link ReviewerBindingError}, never
 * softened into "no delegation". Identical duplicate rows are one delegation
 * written twice, not a conflict.
 */
export async function readReviewerDelegation(sessionId: string): Promise<ReviewerBindingRecord | undefined> {
  let rows: ReviewAgentLedgerRecord[] | undefined
  try {
    rows = await readLedgerRows()
  } catch (error) {
    throw new ReviewerBindingError(
      'unreadable',
      `the reviewer ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const matches = (rows ?? []).filter(row => row.sessionId === sessionId)
  if (matches.length === 0) return undefined
  const first = matches[0]!
  const record: ReviewerBindingRecord = {
    rootStoreId: first.rootStoreId,
    taskId: first.taskId,
    actor: first.actor,
    at: first.at,
  }
  const conflicting = matches.some(
    row => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor,
  )
  if (conflicting) {
    throw new ReviewerBindingError(
      'binding-conflict',
      `session "${sessionId}" is recorded under more than one reviewer delegation: ` +
        matches.map(row => `${row.taskId} in ${row.rootStoreId} (by ${row.actor})`).join('; '),
    )
  }
  return record
}

/** The binding source the plugin registers into the context service: this deployment's ledger, as the narrow read door above. */
export function reviewerBindingSource(): { read(sessionId: string): Promise<ReviewerBindingRecord | undefined> } {
  return { read: readReviewerDelegation }
}
