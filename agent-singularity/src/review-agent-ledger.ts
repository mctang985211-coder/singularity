/**
 * The review-agent ledger: how many review agents one root task store has
 * started, so the escalation budget guardrail survives process restarts. The
 * count is durable; taking it is a claim ({@link reserveReviewAgentRun}), so two
 * executions that read the same count cannot both start a review agent.
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

/**
 * How many review agents this root store has already started. A missing file
 * reads as zero; a corrupt line throws rather than silently undercounting.
 */
export async function countReviewAgentRuns(rootStoreId: string): Promise<number> {
  let text: string
  try {
    text = await readFile(reviewAgentLedgerFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let count = 0
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return
    let record: ReviewAgentLedgerRecord
    try {
      record = JSON.parse(line) as ReviewAgentLedgerRecord
    } catch {
      throw new Error(`review-agent-ledger: corrupt line ${index + 1} in ${reviewAgentLedgerFile()}`)
    }
    if (record.rootStoreId === rootStoreId) count += 1
  })
  // A count is a snapshot: seed this process's knowledge upward with it, never
  // downward — an append that lands between the read and this line must not be
  // undone by the older number.
  const key = budgetKey(rootStoreId)
  persistedRows.set(key, Math.max(knownRows(key), count))
  return count
}

/**
 * Rows this process knows the ledger holds, per budget — a ledger file and a
 * root store. A count is a snapshot of the file taken before the claim that
 * follows it, and a run that appends in between leaves that snapshot claiming
 * the allowance of a row that now exists. This map is raised by every append
 * this process writes and seeded upward by every count, so it never runs
 * backwards and a snapshot that lost that race cannot spend a row twice (K4-1).
 */
const persistedRows = new Map<string, number>()

/**
 * Admitted review agents whose row is not in the ledger yet, per budget — a
 * ledger file and a root store. The count is an asynchronously read file, so it
 * cannot see a review agent that is still inside its spawn: between the count
 * and the row there is a whole spawn, and anything reading the count in that
 * window would be told zero. This map is what that window is closed with
 * (K4-1): the claim stands in for the row until the row exists.
 */
const claims = new Map<string, number>()

/** The budget one count, claim, or append belongs to. */
function budgetKey(rootStoreId: string): string {
  return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`
}

/** The rows known for one budget key, without resolving the key again. */
function knownRows(key: string): number {
  return persistedRows.get(key) ?? 0
}

/**
 * The allowance one root store has spent, as of right now: the rows this process
 * knows the ledger holds — the higher of the count a caller read and the appends
 * written since — plus the runs admitted with no row yet. It is never below the
 * persisted rows, which is what keeps a count that a concurrent append overtook
 * from spending the same row's allowance twice.
 */
export function effectiveReviewAgentRuns(rootStoreId: string, used: number): number {
  const key = budgetKey(rootStoreId)
  return Math.max(used, knownRows(key)) + (claims.get(key) ?? 0)
}

/** One admitted review agent's claim on its store's allowance, until a row replaces it. */
export interface ReviewAgentReservation {
  /** The append succeeded: the ledger carries this run now, so the claim retires into it. */
  commit(): void
  /** No row was written (the spawn or the append failed): the allowance is unspent again. */
  release(): void
}

/**
 * Claim one review agent against a root store's allowance — the check and the
 * claim in one synchronous step, so two executions cannot both pass it. The
 * effective usage is {@link effectiveReviewAgentRuns}: what this process knows
 * the ledger holds plus the claims in flight, so neither a second execution that
 * read the same count nor a count overtaken by a concurrent append can admit a
 * reviewer the allowance has no room for.
 *
 * A caller must not await between reading the count and calling this, or the
 * second execution reads the same count while the first is still spawning.
 *
 * @param rootStoreId - the root task store the allowance belongs to.
 * @param max - the per-store cap (see {@link reviewAgentBudget}).
 * @param used - the count the caller just read from the ledger.
 * @returns the claim, or `undefined` when the allowance is spent.
 */
export function reserveReviewAgentRun(rootStoreId: string, max: number, used: number): ReviewAgentReservation | undefined {
  const key = budgetKey(rootStoreId)
  if (effectiveReviewAgentRuns(rootStoreId, used) >= max) return undefined
  const inFlight = claims.get(key) ?? 0
  claims.set(key, inFlight + 1)
  let settled = false
  const retire = () => {
    if (settled) return
    settled = true
    const left = (claims.get(key) ?? 1) - 1
    if (left > 0) claims.set(key, left)
    else claims.delete(key)
  }
  return { commit: retire, release: retire }
}

/** Append one started review agent. */
export async function appendReviewAgentRun(record: Omit<ReviewAgentLedgerRecord, 'formatVersion' | 'at'>): Promise<void> {
  const file = reviewAgentLedgerFile()
  await mkdir(dirname(file), { recursive: true })
  const line = { formatVersion: 1 as const, ...record, at: new Date().toISOString() }
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
  // The row is durable: this process now knows the ledger holds one more for that
  // store, so a count read before this instant cannot spend its allowance again.
  const key = budgetKey(record.rootStoreId)
  persistedRows.set(key, knownRows(key) + 1)
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
