/**
 * The review-agent ledger: how many review agents one root task store has
 * started, so the escalation budget guardrail survives process restarts.
 *
 * This is deliberately NOT a task-store event. The task store records what
 * happened to tasks; a review agent is a runtime act of the root agent, and
 * writing it into the task log would make a tool's bookkeeping part of the
 * domain's event history. So the count lives in an append-only JSONL file
 * under `$DSH_HOME`, the same shape (and the same home) the Evolution ledger
 * uses (`agent-singularity/src/evolution.ts`).
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

/** Repo root, derived the way `EvolutionService` derives it (both files sit at the same depth). */
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
  return count
}

/** Append one started review agent. */
export async function appendReviewAgentRun(record: Omit<ReviewAgentLedgerRecord, 'formatVersion' | 'at'>): Promise<void> {
  const file = reviewAgentLedgerFile()
  await mkdir(dirname(file), { recursive: true })
  const line = { formatVersion: 1 as const, ...record, at: new Date().toISOString() }
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
}
