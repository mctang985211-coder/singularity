/**
 * The review-agent ledger: which review attempts a root task store has, and how
 * many review agents it has started — so both the source deduplication and the
 * escalation budget guardrail survive process restarts.
 *
 * One attempt is one review agent working on one exact source
 * (`{rootStoreId, taskId, runId | no-run}`). The file is append-only JSONL under
 * `$DSH_HOME/review-agents/agents.jsonl` and it holds three row kinds, in the
 * order an attempt produces them:
 *
 * - `claim` (written before the spawn): the attempt's identity, its source, its
 *   `requestKey` (`null` is the source's default attempt), its review focus, the
 *   pre-allocated reviewer session id, and the caller;
 * - `started` (written by the spawn's `beforePrompt`): the model-input boundary.
 *   This is the row the budget counts — one started row is one spent run — and
 *   the row the reviewer delegation is read from;
 * - `settled` (written when the attempt ends): `recorded` when its judgement
 *   reached the store, `interrupted` when the attempt ended without one.
 *
 * **A second role rides the same file (A6).** The supervisor a pending
 * Diagnosis/Review hand-off is delegated to is a coordination session of the same
 * root store, so its delegation is a row of this same ledger — `role:
 * 'supervisor'`, naming the hand-off's `diagnosisId` and the digest of the
 * hand-off it was started for — and both roles are decided inside the same serial
 * region, count against the same per-store allowance and are read back through
 * the same readers. That is deliberate: the alternative is a second file with a
 * second count, and two counts of "how many coordination agents this store has
 * spent" can disagree (plan §F.4: 不新建第二本账). The two roles differ in what
 * dedupes them — a reviewer by its exact source, a supervisor by the hand-off's
 * diagnosis — and in what settles them: a reviewer's attempt ends when its
 * diagnosis is recorded, while a supervisor's `started` row *is* the hand-off's
 * terminal fact (the coordination session owns the hand-off from there), so a
 * started supervisor row is never recovered as "a process that died holding it".
 * A claim of either role that never reached model input is: the region records
 * `interrupted` for it and the hand-off (or source) is free for a fresh attempt.
 * Rows written before this role existed carry none and read as `reviewer`.
 *
 * The count is durable — the rows the file holds — and it is taken inside
 * {@link admitReviewAgent}'s serial region, together with the claim the same
 * region writes, so two executions cannot both start an attempt for one source.
 * The row is the only count there is: no process cache and no reservation stands
 * in for it, and a claim neither counts against the budget nor reserves it.
 *
 * An attempt's row outlives the process that wrote it, so an open row is not by
 * itself "in flight": a process killed between the claim and its terminal fact
 * leaves an attempt nobody is running. The ledger tells the two apart with what
 * the file cannot hold — {@link liveAttempts}, the identities *this* process
 * started and has not settled — and a decision that meets an open attempt no
 * process owns records the terminal fact it never got (A5: "a crash either
 * recovers the same session or records interrupted"): `interrupted`, or
 * `recorded` when the caller's own read finds the attempt's diagnosis on the
 * store. That recovery is the only terminal fact any decision writes, and it
 * never re-charges, re-claims or re-spawns the attempt.
 *
 * Row shapes written before this model existed (`formatVersion: 1`) are started
 * rows and are read as such: they count, they answer the delegation read, and
 * they are never guessed into a source, a run or a request key.
 *
 * This is deliberately NOT a task-store event. The task store records what
 * happened to tasks; a review agent is a runtime act of the root agent, and
 * writing it into the task log would make a tool's bookkeeping part of the
 * domain's event history. So the rows live in the same shape (and the same home)
 * the Evolution ledger uses (`@dangosys/dsh-singularity-evolution`).
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

/** One started review agent in the shape an earlier deployment wrote. Immutable; the file is append-only. */
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

/**
 * The exact source of one review: the task, and the Run it reviews — or `null`
 * for a review that carries no Run (a task blocked before it ever started).
 * Never derived from "the latest review": the caller names it.
 *
 * A supervisor attempt carries the same shape: the source is the task and run
 * the hand-off's Diagnosis is about (which is what its delegation has to name —
 * the domain the coordinator may read), and its identity is the `diagnosisId`
 * beside it.
 */
export interface ReviewAgentSource {
  readonly taskId: string
  readonly runId: string | null
}

/** Which kind of coordination agent one row belongs to. Rows written before A6 carry none and read as `reviewer`. */
export type ReviewAgentRole = 'reviewer' | 'supervisor'

/** One attempt's claim, as it is persisted before the coordination agent is spawned. */
export interface ReviewAgentClaimRecord {
  formatVersion: 2
  kind: 'claim'
  /** Absent on rows written before the supervisor role existed (read as `reviewer`). */
  role?: ReviewAgentRole
  rootStoreId: string
  taskId: string
  /** The Run this attempt reviews, or `null` for the no-run source. */
  runId: string | null
  /** The caller's explicit key, or `null` for the source's default attempt. */
  requestKey: string | null
  /** The review focus the caller named, or `null` when it named none. */
  reason: string | null
  /** Supervisor rows only: the hand-off's Diagnosis, which is what dedupes them. */
  diagnosisId?: string
  /**
   * Supervisor rows only: the digest of the hand-off this attempt was started
   * for (its store, diagnosis, source and suggestions). A claim whose digest
   * disagrees with a later request for the same diagnosis is a conflict by
   * name — one hand-off is not two different requests.
   */
  handoffDigest?: string
  /** The coordination session this attempt pre-allocated — the attempt's identity. */
  sessionId: string
  /** The session that asked for the attempt (the caller). */
  actor: string
  at: string
}

/** One attempt reaching the model-input boundary: the spend, and the delegation a reviewer session is read under. */
export interface ReviewAgentStartedRecord {
  formatVersion: 2
  kind: 'started'
  rootStoreId: string
  taskId: string
  sessionId: string
  actor: string
  at: string
}

/** How one attempt ended. */
export type ReviewAgentSettlementStatus = 'recorded' | 'interrupted'

/** One attempt's terminal fact. */
export interface ReviewAgentSettledRecord {
  formatVersion: 2
  kind: 'settled'
  rootStoreId: string
  taskId: string
  /** The attempt's identity: the reviewer session its claim pre-allocated. */
  sessionId: string
  status: ReviewAgentSettlementStatus
  /** What ended the attempt, when the caller has something to say about it. */
  note?: string
  at: string
}

/** Every row the ledger file may hold. */
export type ReviewAgentLedgerRow =
  | ReviewAgentLedgerRecord
  | ReviewAgentClaimRecord
  | ReviewAgentStartedRecord
  | ReviewAgentSettledRecord

/** One started review agent as a caller submits it (the store id, the format version and the time are the ledger's). */
export interface ReviewAgentRunStart {
  readonly taskId: string
  readonly sessionId: string
  readonly actor: string
}

/** One attempt's terminal fact as the ledger holds it. */
export interface ReviewAgentSettlement {
  readonly status: ReviewAgentSettlementStatus
  /** What ended the attempt, when the caller had something to say about it. */
  readonly note?: string
  readonly at: string
}

/** One attempt's terminal fact as a caller submits it (the time is the ledger's). */
export interface ReviewAgentSettlementRequest {
  readonly rootStoreId: string
  readonly taskId: string
  /** The attempt's identity: the reviewer session its claim pre-allocated. */
  readonly sessionId: string
  readonly status: ReviewAgentSettlementStatus
  readonly note?: string
}

/** One request for one source, as the admission is asked to decide it. */
export interface ReviewAgentAttemptRequest {
  /** `reviewer` (the default) for a review attempt, `supervisor` for a hand-off's coordinator. */
  readonly role?: ReviewAgentRole
  readonly source: ReviewAgentSource
  /** `null` is the source's default attempt; an automatic scan never invents a key. */
  readonly requestKey: string | null
  /** The caller's review focus, or `null` when it named none. */
  readonly reason: string | null
  /** Supervisor requests only: the hand-off's Diagnosis, which is what dedupes them. */
  readonly diagnosisId?: string
  /** Supervisor requests only: the hand-off's content digest, so the same diagnosis under another hand-off is a conflict. */
  readonly handoffDigest?: string
  /** The session that asked (the caller). */
  readonly actor: string
  /** The coordination session a new attempt would take — the caller pre-allocates it. */
  readonly sessionId: string
}

/** One attempt as the ledger holds it. */
export interface ReviewAgentAttempt {
  readonly role: ReviewAgentRole
  readonly source: ReviewAgentSource
  readonly requestKey: string | null
  readonly reason: string | null
  /** Supervisor attempts only: the hand-off's Diagnosis. */
  readonly diagnosisId?: string
  /** Supervisor attempts only: the digest of the hand-off this attempt was started for. */
  readonly handoffDigest?: string
  /** The attempt's identity: the pre-allocated coordination session. */
  readonly sessionId: string
  readonly actor: string
  readonly at: string
  /** Whether the attempt reached the model-input boundary (one spent run of the store's budget). */
  readonly started: boolean
  /** The terminal fact, when the attempt has one. */
  readonly settlement: ReviewAgentSettlement | undefined
}

/** Why an admission refuses to start an attempt by name. */
export type ReviewAgentRefusalCode = 'request-key-conflict' | 'request-key-required' | 'budget-exhausted'

/** The store's review-agent allowance as the admission read it. */
export interface ReviewAgentBudget {
  readonly used: number
  readonly max: number
}

/** What one admission decided about one request. */
export type ReviewAgentPlan =
  /** The request is this attempt already (same source, same key, same focus): return its identity, write nothing. */
  | { readonly kind: 'reuse'; readonly attempt: ReviewAgentAttempt }
  /** Another attempt of the same source is not settled: the request is not accepted, nothing is written for it. */
  | { readonly kind: 'in-flight'; readonly attempt: ReviewAgentAttempt }
  /** Refused by name before any claim or spawn. */
  | { readonly kind: 'refused'; readonly code: ReviewAgentRefusalCode; readonly attempt: ReviewAgentAttempt | undefined; readonly attempts: readonly ReviewAgentAttempt[]; readonly budget: ReviewAgentBudget }
  /** A new attempt: claim it, then spawn. */
  | { readonly kind: 'start'; readonly budget: ReviewAgentBudget }

/**
 * What the caller knows and the ledger cannot see, offered to one decision.
 *
 * A decision has to tell an attempt that ended from one that is still running,
 * and for a started attempt the ledger's own rows settle only half of it — that
 * no process *here* is running it. Whether its diagnosis is on the record lives
 * in the store, and the store is the caller's to read.
 */
export interface ReviewAgentPlanHooks {
  /**
   * Whether the store already holds this attempt's diagnosis. An attempt whose
   * diagnosis is on the record ended `recorded`, whatever terminal row the
   * ledger is missing — the store is the record of the judgement.
   */
  readonly recorded?: (attempt: ReviewAgentAttempt) => boolean | Promise<boolean>
}

/** One decision, and the dead attempts it recovered on the way (see {@link ReviewAgentAdmission.plan}). */
export interface ReviewAgentPlanDecision {
  readonly plan: ReviewAgentPlan
  /**
   * The open attempts of this request's source that this call found dead and
   * recorded a terminal fact for — the crash recovery, in claim order. Empty
   * for every call that met no such attempt.
   */
  readonly recovered: readonly ReviewAgentAttempt[]
}

/** What one review-agent admission is given inside its store's serial region. */
export interface ReviewAgentAdmission {
  /** How many review agents this store has started, as this region's read of the ledger holds them. */
  readonly started: number
  /**
   * Decide one request against this store's attempts, read inside this region.
   *
   * The one write this may perform is the recovery of an attempt that is dead
   * while its row still reads open: an attempt no process is running any more,
   * whether it never reached model input or was started by a process that is
   * gone (see the module header). Everything else about a request is decided
   * without writing.
   */
  plan(request: ReviewAgentAttemptRequest, hooks?: ReviewAgentPlanHooks): Promise<ReviewAgentPlanDecision>
  /** Persist this attempt's claim row — inside the same region, before the spawn. */
  claim(request: ReviewAgentAttemptRequest): Promise<void>
  /** Persist this attempt's started fact — from the spawn's `beforePrompt`. Idempotent per attempt. */
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

/** One parsed row. An unrecognized row throws by name rather than being read as something it is not. */
function asLedgerRow(parsed: unknown, line: number): ReviewAgentLedgerRow {
  const row = parsed as Partial<ReviewAgentLedgerRow> & { kind?: unknown }
  if (row.formatVersion === 1) return row as ReviewAgentLedgerRecord
  if (row.formatVersion === 2 && (row.kind === 'claim' || row.kind === 'started' || row.kind === 'settled')) {
    return row as ReviewAgentClaimRecord | ReviewAgentStartedRecord | ReviewAgentSettledRecord
  }
  throw new Error(`review-agent-ledger: unrecognized row ${line} in ${reviewAgentLedgerFile()}`)
}

/** The rows one ledger file holds, as its non-empty lines. A corrupt line throws by name rather than undercounting. */
function parseLedgerRows(text: string): ReviewAgentLedgerRow[] {
  const rows: ReviewAgentLedgerRow[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`review-agent-ledger: corrupt line ${index + 1} in ${reviewAgentLedgerFile()}`)
    }
    rows.push(asLedgerRow(parsed, index + 1))
  })
  return rows
}

/** Every ledger row, or `undefined` when the ledger has never been written (zero rows is a state, not a failure). */
async function readLedgerRows(): Promise<ReviewAgentLedgerRow[] | undefined> {
  let text: string
  try {
    text = await readFile(reviewAgentLedgerFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseLedgerRows(text)
}

/** A started fact, whatever version wrote it: the spend and the delegation. */
function isStartedRow(row: ReviewAgentLedgerRow): row is ReviewAgentLedgerRecord | ReviewAgentStartedRecord {
  return row.formatVersion === 1 || row.kind === 'started'
}

/** One store's rows of a kind the caller needs. */
function storeRows<Row extends ReviewAgentLedgerRow>(
  rows: readonly ReviewAgentLedgerRow[],
  rootStoreId: string,
  match: (row: ReviewAgentLedgerRow) => row is Row,
): Row[] {
  return rows.filter(row => row.rootStoreId === rootStoreId).filter(match)
}

/** The store's started rows — the durable count, and the delegation rows. */
function startedRowsOf(rows: readonly ReviewAgentLedgerRow[], rootStoreId: string): (ReviewAgentLedgerRecord | ReviewAgentStartedRecord)[] {
  return storeRows(rows, rootStoreId, isStartedRow)
}

/**
 * The attempts one store's rows hold, in the order they were claimed: each
 * claim row is an attempt, its identity is the session it names, and the
 * started/settled rows that name the same session are its facts. A settled
 * row that lands twice is the same fact written twice, so the first one holds.
 * A row without a role is a reviewer's — the only kind this file held before
 * the supervisor role was added.
 */
function attemptsOf(rows: readonly ReviewAgentLedgerRow[], rootStoreId: string): ReviewAgentAttempt[] {
  const startedSessions = new Set(startedRowsOf(rows, rootStoreId).map(row => row.sessionId))
  const settled = new Map<string, ReviewAgentSettlement>()
  for (const row of storeRows(rows, rootStoreId, (candidate): candidate is ReviewAgentSettledRecord => candidate.formatVersion === 2 && candidate.kind === 'settled')) {
    if (!settled.has(row.sessionId)) {
      settled.set(row.sessionId, { status: row.status, ...(row.note === undefined ? {} : { note: row.note }), at: row.at })
    }
  }
  return storeRows(rows, rootStoreId, (candidate): candidate is ReviewAgentClaimRecord => candidate.formatVersion === 2 && candidate.kind === 'claim')
    .map(row => ({
      role: roleOf(row.role),
      source: { taskId: row.taskId, runId: row.runId },
      requestKey: row.requestKey,
      reason: row.reason,
      ...(row.diagnosisId === undefined ? {} : { diagnosisId: row.diagnosisId }),
      ...(row.handoffDigest === undefined ? {} : { handoffDigest: row.handoffDigest }),
      sessionId: row.sessionId,
      actor: row.actor,
      at: row.at,
      started: startedSessions.has(row.sessionId),
      settlement: settled.get(row.sessionId),
    }))
}

/** Whether two sources are the same source. */
function sameSource(left: ReviewAgentSource, right: ReviewAgentSource): boolean {
  return left.taskId === right.taskId && left.runId === right.runId
}

/** The role a row or a request belongs to: an older row carries none and is a reviewer's. */
function roleOf(role: ReviewAgentRole | undefined): ReviewAgentRole {
  return role === 'supervisor' ? 'supervisor' : 'reviewer'
}

/** The attempts of one role among a store's attempts — the two roles never dedupe against each other. */
function attemptsOfRole(attempts: readonly ReviewAgentAttempt[], role: ReviewAgentRole): ReviewAgentAttempt[] {
  return attempts.filter(attempt => attempt.role === role)
}

/**
 * Decide one review request against one store's attempts. Pure, so every branch
 * is testable and the admission's order is the order written here:
 *
 * 1. the request's own attempt (same source, same key) — a repeat returns the
 *    same identity and never re-charges the budget, and a repeat with a
 *    different focus is a conflict, not a silent re-focus;
 * 2. any other attempt of the source that is not settled — the request is not
 *    accepted, because one source never runs two attempts at once;
 * 3. a request with no key for a source that was already reviewed: the default
 *    attempt is a source's first attempt, so a later one names its key;
 * 4. the budget, read only here: an exhausted store refuses a *new* attempt and
 *    still answers (1) and (2).
 *
 * Only reviewer attempts take part: a supervisor row names a hand-off, not a
 * review source, and one role's attempt never dedupes against the other's.
 */
export function planReviewAttempt(input: {
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly request: ReviewAgentAttemptRequest
  readonly budget: ReviewAgentBudget
}): ReviewAgentPlan {
  const { request, budget } = input
  const mine = attemptsOfRole(input.attempts, 'reviewer').filter(attempt => sameSource(attempt.source, request.source))
  const same = mine.find(attempt => attempt.requestKey === request.requestKey)
  if (same !== undefined) {
    if (same.reason !== request.reason) return { kind: 'refused', code: 'request-key-conflict', attempt: same, attempts: mine, budget }
    return { kind: 'reuse', attempt: same }
  }
  const open = mine.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', attempt: open }
  if (mine.length > 0 && request.requestKey === null) {
    return { kind: 'refused', code: 'request-key-required', attempt: mine.at(-1), attempts: mine, budget }
  }
  if (budget.used >= budget.max) return { kind: 'refused', code: 'budget-exhausted', attempt: undefined, attempts: mine, budget }
  return { kind: 'start', budget }
}

/**
 * Decide one hand-off's supervisor request (A6) against one store's attempts.
 *
 * A hand-off is deduped by its **diagnosis**, not by a source and not by a
 * caller's key: one diagnosis has at most one supervisor, and a repeat of the
 * request is answered with that supervisor's identity however long ago it was
 * started (plan §F.4: 重复消费/重启只返回同一 supervisor 身份). The order:
 *
 * 1. a claim of the same diagnosis under another hand-off digest is a conflict
 *    by name, before anything is answered from it: the digest is what the
 *    diagnosis promises about content, and an id carrying different suggestions
 *    is not the hand-off this ledger took up;
 * 2. an attempt that reached model input and is not settled **is** the hand-off's
 *    supervisor: the request is that attempt, in this process and after a restart
 *    alike — a coordination session is not a bounded job, and re-answering a
 *    repeat with a *new* session would be a second coordinator for one hand-off;
 * 3. an attempt that never reached model input — a claim the region settles
 *    `interrupted` when no process here is running it — is not an identity, and
 *    neither is a started attempt whose own terminal fact is `interrupted` (a
 *    spawn that failed after its started row was written): the hand-off is free
 *    for a fresh attempt, and the spend that did happen stays on the record;
 * 4. the allowance, read only here: an exhausted store refuses a *new*
 *    coordinator and still answers (2).
 */
export function planSupervisorAttempt(input: {
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly request: ReviewAgentAttemptRequest
  readonly budget: ReviewAgentBudget
}): ReviewAgentPlan {
  const { request, budget } = input
  const mine = attemptsOfRole(input.attempts, 'supervisor').filter(attempt => attempt.diagnosisId === request.diagnosisId)
  const conflicting = mine.find(attempt => attempt.handoffDigest !== request.handoffDigest)
  if (conflicting !== undefined) {
    return { kind: 'refused', code: 'request-key-conflict', attempt: conflicting, attempts: mine, budget }
  }
  const takenUp = mine.filter(attempt => attempt.started && attempt.settlement === undefined).at(-1)
  if (takenUp !== undefined) return { kind: 'reuse', attempt: takenUp }
  const open = mine.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', attempt: open }
  if (budget.used >= budget.max) return { kind: 'refused', code: 'budget-exhausted', attempt: undefined, attempts: mine, budget }
  return { kind: 'start', budget }
}

/**
 * How many review agents this root store has already started, as the file reads
 * right now. A missing file reads as zero; a corrupt line throws rather than
 * silently undercounting.
 *
 * A display query only: it caches nothing, so it can never be the count an
 * admission decides on — that one is read inside the store's serial region
 * ({@link admitReviewAgent}) together with the claim it writes.
 */
export async function countReviewAgentRuns(rootStoreId: string): Promise<number> {
  const rows = await readLedgerRows()
  return startedRowsOf(rows ?? [], rootStoreId).length
}

/**
 * Every attempt this root store's ledger holds, for a reader that renders the
 * state rather than deciding on it (`task_review_pack`). A display query: the
 * decision is always made inside the admission's serial region.
 *
 * Both roles are in the answer — the rows are one file — and a reader that
 * means one of them filters by {@link ReviewAgentAttempt.role}.
 */
export async function readReviewAgentAttempts(rootStoreId: string): Promise<ReviewAgentAttempt[]> {
  const rows = await readLedgerRows()
  return attemptsOf(rows ?? [], rootStoreId)
}

/**
 * The supervisor one hand-off is delegated to, as the ledger holds it: the
 * **started** attempt of role `supervisor` whose `diagnosisId` is this one, or
 * `undefined` when the hand-off has no coordinator (nothing was started for it,
 * or the only claims never reached model input).
 *
 * This is the read a hand-off's state and the recovery entry's identity check
 * share: a started row that has not settled `interrupted` is what makes a session
 * "the coordinator of this hand-off", and it is the ledger's own record, never a
 * model's claim about which session it is.
 */
export async function readSupervisorHandoff(rootStoreId: string, diagnosisId: string): Promise<ReviewAgentAttempt | undefined> {
  const attempts = await readReviewAgentAttempts(rootStoreId)
  return attempts
    .filter(attempt => attempt.role === 'supervisor' && attempt.diagnosisId === diagnosisId && attempt.started)
    .filter(attempt => attempt.settlement === undefined)
    .at(-1)
}

/** The budget one admission belongs to: a ledger file and a root store. */
function budgetKey(rootStoreId: string): string {
  return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`
}

/**
 * The serial regions, one promise chain per budget key. A region is the only
 * place an attempt is decided on and claimed, so the attempts an admission sees
 * and the claim it writes cannot have another admission in between them (K4-1).
 * The chain's tail is settled either way, so a failed region cannot wedge the
 * key's next admission.
 */
const regions = new Map<string, Promise<void>>()

/** Append one row, creating the ledger directory if needed. Only the doors below write. */
async function appendRow(row: ReviewAgentLedgerRow): Promise<void> {
  const file = reviewAgentLedgerFile()
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
}

/** The claim row one request becomes. */
function claimRow(rootStoreId: string, request: ReviewAgentAttemptRequest): ReviewAgentClaimRecord {
  const role = roleOf(request.role)
  return {
    formatVersion: 2,
    kind: 'claim',
    ...(role === 'reviewer' ? {} : { role }),
    rootStoreId,
    taskId: request.source.taskId,
    runId: request.source.runId,
    requestKey: request.requestKey,
    reason: request.reason,
    ...(request.diagnosisId === undefined ? {} : { diagnosisId: request.diagnosisId }),
    ...(request.handoffDigest === undefined ? {} : { handoffDigest: request.handoffDigest }),
    sessionId: request.sessionId,
    actor: request.actor,
    at: new Date().toISOString(),
  }
}

/**
 * Record one attempt's terminal fact. Append-only and outside the serial region
 * on purpose: the caller writes it after it observed the outcome, which is
 * always after the region that started the attempt has ended (A5: waiting for
 * the reviewer's output never runs inside the region). Two writers of the same
 * fact produce the same fact twice, which reads as one.
 *
 * Writing this fact — and only writing it — ends *this process's* ownership of
 * the attempt (see {@link liveAttempts}): until the row is durably on the file,
 * the attempt counts as one this process is still running, so no admission
 * meeting it in that window may read it as a dead process's attempt and record a
 * second terminal fact for it. The marker is dropped once the append has landed,
 * and also when the append throws — the attempt is over here either way, and a
 * marker that outlived its attempt would pin the source in flight. A terminal
 * fact nobody could write is recovered from the store's own record on the next
 * decision.
 */
export async function settleReviewAgentAttempt(settlement: ReviewAgentSettlementRequest): Promise<void> {
  try {
    await appendRow({
      formatVersion: 2,
      kind: 'settled',
      rootStoreId: settlement.rootStoreId,
      taskId: settlement.taskId,
      sessionId: settlement.sessionId,
      status: settlement.status,
      ...(settlement.note === undefined ? {} : { note: settlement.note }),
      at: new Date().toISOString(),
    })
  } finally {
    liveAttempts.delete(settlement.sessionId)
  }
}

/** What a claim without a started row says about how the attempt ended. */
const CLAIM_NEVER_STARTED = 'the attempt was claimed but its process never reached model input'

/** What a started attempt no process is running any more says about how it ended. */
const STARTED_OWNER_GONE = 'the process that started this attempt is gone and no result was recorded'

/** What an attempt whose diagnosis the store already holds says about how it ended. */
const DIAGNOSIS_ALREADY_RECORDED = 'the diagnosis was already recorded; the ledger is read back from the store'

/**
 * The attempts this process started and has not settled, by the reviewer session
 * each was claimed under.
 *
 * The file cannot hold this fact: a started row says a run was spent, not that
 * anybody is still working on it. This set is the one thing that tells a *live*
 * attempt from one a dead process left behind — a row that is open and not in
 * here belongs to no running process, so it can be recorded as interrupted. It
 * is not a count, not a cache and not a reservation: the count stays the started
 * rows, the attempts stay the claim rows, and no decision reads this for
 * anything but "is that attempt still being run here?".
 *
 * A deployment that runs two processes over one ledger home would have each of
 * them see the other's live attempts as dead; the ledger is a single writer's by
 * design (`admitReviewAgent`'s serial region).
 */
const liveAttempts = new Set<string>()

/**
 * Run one review-agent admission inside the ledger's serial region for a store.
 *
 * One region per (ledger file, root store): inside it the whole ledger file is
 * read, this store's attempts and its started count are derived, and `work` runs
 * with the decision door (`plan`), the claim door and the started door. The
 * region ends when `work` returns or throws. Nothing else is serialized: waiting
 * for the reviewer's output and recording its Diagnosis happen
 * after `work` returned, outside the region, in the caller.
 *
 * The consequence to rely on: two admissions for one store cannot interleave
 * their read-and-claim, so the second one reads what the first left behind
 * instead of a file that has not caught up yet — one attempt per source, and
 * one started row per allowance. A claim that fails writes no row and spends
 * nothing, and the failed region does not wedge the key.
 *
 * The one recovery {@link ReviewAgentAdmission.plan} performs: an open attempt
 * that no process is running — one that never reached model input, or one that
 * was started but is not in this process's {@link liveAttempts} — is recorded
 * with the terminal fact it never got: `interrupted`, or `recorded` when the
 * caller's own read finds its diagnosis on the store. The same identity, no
 * second claim, no second started row, no re-charge — and after it the request
 * is decided as if the attempt were settled, which is what lets a source whose
 * reviewer died be reviewed again. An attempt this process is really running is
 * left untouched and answered as in flight.
 *
 * A **started supervisor** attempt is never recovered: its started row is the
 * hand-off's terminal fact (the coordination session owns the hand-off from
 * there, and a coordinator is not a bounded job whose result a later read could
 * recover), so the recovery loop leaves it exactly as it is — after a restart
 * included. Only a supervisor *claim* that never reached model input is settled
 * `interrupted`, which is what frees a hand-off whose coordinator never started.
 *
 * `work` must not await another admission for the same store (that region waits
 * for this one) and must await every `claim`/`start` it calls before returning.
 *
 * @param rootStoreId - the root task store the budget belongs to.
 * @param work - the admission decision and the spawn, given the store's count and its write doors.
 * @returns whatever `work` returned, once the region has ended.
 */
export async function admitReviewAgent<T>(
  rootStoreId: string,
  work: (admission: ReviewAgentAdmission) => Promise<T>,
): Promise<T> {
  const key = budgetKey(rootStoreId)
  const previous = regions.get(key) ?? Promise.resolve()
  const result = previous.then(async () => {
    const rows = await readLedgerRows() ?? []
    const started = startedRowsOf(rows, rootStoreId).length
    // One region's own view of the store: the rows it read, plus every row its
    // doors write while it holds the region. A caller that decides twice inside
    // one region therefore sees what its own writes did, exactly as the next
    // admission will.
    let used = started
    const attempts = attemptsOf(rows, rootStoreId)
    /** The attempt identities this store has already spent a run on, as this region read them. */
    const startedSessions = new Set(startedRowsOf(rows, rootStoreId).map(row => row.sessionId))
    /** The attempts this very region claimed: its own work in progress, never a dead one. */
    const claimedHere = new Set<string>()
    const admission: ReviewAgentAdmission = {
      started,
      plan: async (request, hooks) => {
        // The recovery, before anything is decided: every open attempt of this
        // request's subject that no process is running — one that never reached
        // model input, or one started by a process that is gone — is dead, and
        // the terminal fact it never got is written here, inside the region, so
        // the decision below sees the attempt as the settled one it is. This is
        // what keeps a crashed attempt from pinning its source (or its hand-off)
        // in flight forever. A started supervisor attempt is not "dead" in this
        // sense: its started row is the hand-off's terminal fact (see the module
        // header), so it is never settled here however old it is.
        const requestRole = roleOf(request.role)
        const recovered: ReviewAgentAttempt[] = []
        for (const attempt of attempts) {
          if (attempt.role !== requestRole) continue
          if (requestRole === 'reviewer') {
            if (!sameSource(attempt.source, request.source)) continue
          } else {
            if (attempt.diagnosisId !== request.diagnosisId) continue
            if (attempt.started) continue
          }
          if (attempt.settlement !== undefined) continue
          if (liveAttempts.has(attempt.sessionId) || claimedHere.has(attempt.sessionId)) continue
          const recorded = (await hooks?.recorded?.(attempt)) === true
          const status: ReviewAgentSettlementStatus = recorded ? 'recorded' : 'interrupted'
          const note = recorded
            ? DIAGNOSIS_ALREADY_RECORDED
            : attempt.started ? STARTED_OWNER_GONE : CLAIM_NEVER_STARTED
          await settleReviewAgentAttempt({
            rootStoreId,
            taskId: attempt.source.taskId,
            sessionId: attempt.sessionId,
            status,
            note,
          })
          const settlement: ReviewAgentSettlement = { status, note, at: new Date().toISOString() }
          Object.assign(attempt, { settlement })
          recovered.push(attempt)
        }
        const planner = requestRole === 'supervisor' ? planSupervisorAttempt : planReviewAttempt
        const plan = planner({ attempts, request, budget: { used, max: reviewAgentBudget() } })
        return { plan, recovered }
      },
      claim: async request => {
        await appendRow(claimRow(rootStoreId, request))
        claimedHere.add(request.sessionId)
        const role = roleOf(request.role)
        attempts.push({
          role,
          source: request.source,
          requestKey: request.requestKey,
          reason: request.reason,
          ...(request.diagnosisId === undefined ? {} : { diagnosisId: request.diagnosisId }),
          ...(request.handoffDigest === undefined ? {} : { handoffDigest: request.handoffDigest }),
          sessionId: request.sessionId,
          actor: request.actor,
          at: new Date().toISOString(),
          started: false,
          settlement: undefined,
        })
      },
      start: async record => {
        // One attempt reaches the model-input boundary once: the fact is written
        // once per attempt identity, so a caller that asks twice neither appends
        // a second row nor spends a second run ("already started is not
        // re-recorded").
        if (startedSessions.has(record.sessionId)) return
        await appendRow({
          formatVersion: 2,
          kind: 'started',
          rootStoreId,
          taskId: record.taskId,
          sessionId: record.sessionId,
          actor: record.actor,
          at: new Date().toISOString(),
        })
        startedSessions.add(record.sessionId)
        used += 1
        // This process is the one running it from here on: while it stays
        // unsettled, no later admission may read it as a dead process's attempt.
        liveAttempts.add(record.sessionId)
        for (const attempt of attempts) {
          if (attempt.sessionId === record.sessionId) Object.assign(attempt, { started: true })
        }
      },
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
 * reviewer binding source reads it (A2 §D): the started row's `sessionId` is the
 * coordination agent's own session, so the started rows naming it are its
 * delegation. A claim alone is not a delegation — the claim is an intent, and a
 * session that never reached model input was never delegated a read domain — so
 * only rows that record a start are read here.
 *
 * Both roles answer this read, and that is the point: a supervisor is delegated
 * into the same domain a reviewer is (the root store and the source task the
 * hand-off's Diagnosis is about), so the same row shape carries either
 * delegation. What tells them apart is the row's own field, not this reader.
 * One row is the record; several rows that disagree are a conflict the reader
 * may not pick between (a read domain chosen by file order is not an
 * authorization), and a ledger this process cannot read is `unreadable` — both
 * raised as the context package's {@link ReviewerBindingError}, never softened
 * into "no delegation". Identical duplicate rows are one delegation written
 * twice, not a conflict.
 */
export async function readReviewerDelegation(sessionId: string): Promise<ReviewerBindingRecord | undefined> {
  let rows: ReviewAgentLedgerRow[] | undefined
  try {
    rows = await readLedgerRows()
  } catch (error) {
    throw new ReviewerBindingError(
      'unreadable',
      `the reviewer ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const matches = (rows ?? []).filter(isStartedRow).filter(row => row.sessionId === sessionId)
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

/**
 * One recorded **supervisor** delegation (A6): the hand-off it was started for,
 * beside the delegation fields every row carries. This is what the recovery
 * entry's identity check reads — "session X is the coordinator of diagnosis D" —
 * and it is answered from the ledger's own started rows, never from a caller's
 * word about which session it is.
 */
export interface SupervisorDelegationRecord extends ReviewerBindingRecord {
  /** The supervisor session the delegation names — the same id the reader asked about, repeated so a caller never re-derives it. */
  readonly sessionId: string
  /** The Diagnosis this supervisor was delegated for. */
  readonly diagnosisId: string
}

/**
 * The supervisor delegation of one (session, diagnosis) pair, as the ledger holds
 * it, or `undefined` when no started row names both.
 *
 * The same discipline as {@link readReviewerDelegation}: only a started row is a
 * delegation (a claim alone is an intent), several rows that disagree are a
 * conflict the reader may not pick between, and a ledger this process cannot read
 * is `unreadable` — a session is never told it is not a supervisor because the
 * file holding the answer broke.
 */
export async function readSupervisorDelegation(sessionId: string, diagnosisId: string): Promise<SupervisorDelegationRecord | undefined> {
  let rows: ReviewAgentLedgerRow[] | undefined
  try {
    rows = await readLedgerRows()
  } catch (error) {
    throw new ReviewerBindingError(
      'unreadable',
      `the supervisor ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const startedSessions = new Set((rows ?? []).filter(isStartedRow).map(row => row.sessionId))
  const matches = (rows ?? [])
    .filter((row): row is ReviewAgentClaimRecord => row.formatVersion === 2 && row.kind === 'claim')
    .filter(row => row.role === 'supervisor' && row.diagnosisId === diagnosisId && row.sessionId === sessionId)
    .filter(row => startedSessions.has(row.sessionId))
  const first = matches[0]
  if (first === undefined) return undefined
  const record: SupervisorDelegationRecord = {
    rootStoreId: first.rootStoreId,
    taskId: first.taskId,
    actor: first.actor,
    at: first.at,
    sessionId: first.sessionId,
    diagnosisId,
  }
  const conflicting = matches.some(
    row => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor,
  )
  if (conflicting) {
    throw new ReviewerBindingError(
      'binding-conflict',
      `session "${sessionId}" is recorded under more than one supervisor delegation for diagnosis "${diagnosisId}": ` +
        matches.map(row => `${row.taskId} in ${row.rootStoreId} (by ${row.actor})`).join('; '),
    )
  }
  return record
}

/** The delegation source the assembly injects into the evolution plane (A6): this deployment's ledger, as the narrow read door above. */
export function supervisorDelegationSource(): {
  read(sessionId: string, diagnosisId: string): Promise<SupervisorDelegationRecord | undefined>
} {
  return { read: readSupervisorDelegation }
}

/** The binding source the plugin registers into the context service: this deployment's ledger, as the narrow read door above. */
export function reviewerBindingSource(): { read(sessionId: string): Promise<ReviewerBindingRecord | undefined> } {
  return { read: readReviewerDelegation }
}
