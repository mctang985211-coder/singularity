/** The review-agent ledger: which review attempts a root task store has, and how many review agents it has started — so both the source deduplication and the escalation budget guardrail survive process restarts. @module @dangosys/dsh-singularity-agent/review-agent-ledger */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReviewerBindingError } from '@dangosys/dsh-singularity-context'
import type { ReviewerBindingRecord } from '@dangosys/dsh-singularity-context'
import { appendJsonlRow, readJsonlFile } from '../jsonl-ledger.ts'
import { sameSource } from './identity.ts'
import { DEFAULT_SUPERVISION, supervisionSettings } from './supervision.ts'

/** How many review agents this store has started, as this region's read of the ledger holds them — the shipped default of `supervision.coordinationBudget`. */
export const REVIEW_AGENT_BUDGET_DEFAULT = DEFAULT_SUPERVISION.coordinationBudget

/** The exact source of one review: the task, and the Run it reviews — or `null` for a review that carries no Run (a task blocked before it ever started). */
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
  /** Supervisor rows only: the digest of the hand-off this attempt was started for (its store, diagnosis, source and suggestions). A claim whose digest disagrees with a later request for the same diagnosis is a conflict by */
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

/** How one attempt ended. `closed` is the supervisor's own outcome: it decided against further iteration and said so. */
export type ReviewAgentSettlementStatus = 'recorded' | 'interrupted' | 'closed'

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
export type ReviewAgentLedgerRow = ReviewAgentClaimRecord | ReviewAgentStartedRecord | ReviewAgentSettledRecord

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
  /** `null` is the source's default attempt; a caller that names none gets it. */
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
  | {
      readonly kind: 'refused'
      readonly code: ReviewAgentRefusalCode
      readonly attempt: ReviewAgentAttempt | undefined
      readonly attempts: readonly ReviewAgentAttempt[]
      readonly budget: ReviewAgentBudget
      readonly reason?: string
    }
  /** A new attempt: claim it, then spawn. */
  | { readonly kind: 'start'; readonly budget: ReviewAgentBudget }

/** What the caller knows and the ledger cannot see, offered to one decision. */
export interface ReviewAgentPlanHooks {
  /** Whether the store already holds this attempt's diagnosis. An attempt whose diagnosis is on the record ended `recorded`, whatever terminal row the ledger is missing — the store is the record of the judgement. */
  readonly recorded?: (attempt: ReviewAgentAttempt) => boolean | Promise<boolean>
  /** Existing proposal facts show an unfinished operation after the previous coordinator stopped. */
  readonly resumeRecorded?: boolean
  /** The operator re-set the graph's RSI config after the attempt closed `blocked`: the obstruction it named is declared cleared, so the closed attempt does not answer the round and a fresh one may start. */
  readonly retryClosed?: boolean
}

/** One decision, and the dead attempts it recovered on the way (see {@link ReviewAgentAdmission.plan}). */
export interface ReviewAgentPlanDecision {
  readonly plan: ReviewAgentPlan
  /** The open attempts of this request's source that this call found dead and recorded a terminal fact for — the crash recovery, in claim order. Empty for every call that met no such attempt. */
  readonly recovered: readonly ReviewAgentAttempt[]
}

/** What one review-agent admission is given inside its store's serial region. */
export interface ReviewAgentAdmission {
  /** How many review agents this store has started, as this region's read of the ledger holds them. */
  readonly started: number
  /** Decide one request against this store's attempts, read inside this region. */
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

/** The per-root-store cap: env `SINGULARITY_REVIEW_AGENT_BUDGET` wins, then the deployment's `supervision.coordinationBudget`, then {@link REVIEW_AGENT_BUDGET_DEFAULT}. */
export function reviewAgentBudget(): number {
  const raw = process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  const parsed = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw)
  if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed)
  return supervisionSettings().coordinationBudget
}

/** One parsed row. An unrecognized row throws by name rather than being read as something it is not. */
function asLedgerRow(parsed: unknown, line: number): ReviewAgentLedgerRow {
  const row = parsed as Partial<ReviewAgentLedgerRow> & { kind?: unknown }
  if (row.formatVersion === 2 && (row.kind === 'claim' || row.kind === 'started' || row.kind === 'settled')) {
    return row as ReviewAgentClaimRecord | ReviewAgentStartedRecord | ReviewAgentSettledRecord
  }
  throw new Error(`review-agent-ledger: unrecognized row ${line} in ${reviewAgentLedgerFile()}`)
}

/** Every ledger row, or `undefined` when the ledger has never been written (zero rows is a state, not a failure). A corrupt line throws by name rather than undercounting. */
async function readLedgerRows(): Promise<ReviewAgentLedgerRow[] | undefined> {
  return await readJsonlFile(reviewAgentLedgerFile(), (line, lineNumber) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`review-agent-ledger: corrupt line ${lineNumber} in ${reviewAgentLedgerFile()}`)
    }
    return asLedgerRow(parsed, lineNumber)
  })
}

/** A started fact: the spend and the delegation. */
function isStartedRow(row: ReviewAgentLedgerRow): row is ReviewAgentStartedRecord {
  return row.formatVersion === 2 && row.kind === 'started'
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
function startedRowsOf(rows: readonly ReviewAgentLedgerRow[], rootStoreId: string): ReviewAgentStartedRecord[] {
  return storeRows(rows, rootStoreId, isStartedRow)
}

/** The attempts one store's rows hold, in the order they were claimed: each claim row is an attempt, its identity is the session it names, and the started/settled rows that name the same session are its facts. A settled */
function attemptsOf(rows: readonly ReviewAgentLedgerRow[], rootStoreId: string): ReviewAgentAttempt[] {
  const startedSessions = new Set(startedRowsOf(rows, rootStoreId).map(row => row.sessionId))
  const settled = new Map<string, ReviewAgentSettlement>()
  for (const row of storeRows(
    rows,
    rootStoreId,
    (candidate): candidate is ReviewAgentSettledRecord => candidate.formatVersion === 2 && candidate.kind === 'settled',
  )) {
    if (!settled.has(row.sessionId)) {
      settled.set(row.sessionId, {
        status: row.status,
        ...(row.note === undefined ? {} : { note: row.note }),
        at: row.at,
      })
    }
  }
  return storeRows(
    rows,
    rootStoreId,
    (candidate): candidate is ReviewAgentClaimRecord => candidate.formatVersion === 2 && candidate.kind === 'claim',
  ).map(row => ({
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

/** The role a row or a request belongs to: an older row carries none and is a reviewer's. */
function roleOf(role: ReviewAgentRole | undefined): ReviewAgentRole {
  return role === 'supervisor' ? 'supervisor' : 'reviewer'
}

/** The attempts of one role among a store's attempts — the two roles never dedupe against each other. */
function attemptsOfRole(attempts: readonly ReviewAgentAttempt[], role: ReviewAgentRole): ReviewAgentAttempt[] {
  return attempts.filter(attempt => attempt.role === role)
}

/** Decide one review request against one store's attempts. Pure, so every branch is testable and the admission's order is the order written here: */
export function planReviewAttempt(input: {
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly request: ReviewAgentAttemptRequest
  readonly budget: ReviewAgentBudget
}): ReviewAgentPlan {
  const { request, budget } = input
  const mine = attemptsOfRole(input.attempts, 'reviewer').filter(attempt => sameSource(attempt.source, request.source))
  const same = mine.find(attempt => attempt.requestKey === request.requestKey)
  if (same !== undefined) {
    if (same.reason !== request.reason)
      return { kind: 'refused', code: 'request-key-conflict', attempt: same, attempts: mine, budget }
    return { kind: 'reuse', attempt: same }
  }
  const open = mine.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', attempt: open }
  if (mine.length > 0 && request.requestKey === null) {
    return { kind: 'refused', code: 'request-key-required', attempt: mine.at(-1), attempts: mine, budget }
  }
  if (budget.used >= budget.max)
    return { kind: 'refused', code: 'budget-exhausted', attempt: undefined, attempts: mine, budget }
  return { kind: 'start', budget }
}

/** Decide one round's supervisor request against one store's attempts: a concluded supervision is answered with the supervisor it already had; an interrupted one is a failure and does not block a fresh attempt. */
export function planSupervisorAttempt(input: {
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly request: ReviewAgentAttemptRequest
  readonly budget: ReviewAgentBudget
  readonly resumeRecorded?: boolean
  /** An operator reset after a `closed` settlement: the closed attempt stays on the record but does not answer the round. */
  readonly retryClosed?: boolean
}): ReviewAgentPlan {
  const { request, budget } = input
  const mine = attemptsOfRole(input.attempts, 'supervisor').filter(
    attempt => attempt.diagnosisId === request.diagnosisId,
  )
  const conflicting = mine.find(attempt => attempt.handoffDigest !== request.handoffDigest)
  if (conflicting !== undefined) {
    return { kind: 'refused', code: 'request-key-conflict', attempt: conflicting, attempts: mine, budget }
  }
  const takenUp = mine.filter(attempt => attempt.started && attempt.settlement === undefined).at(-1)
  if (takenUp !== undefined) return { kind: 'reuse', attempt: takenUp }
  const open = mine.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', attempt: open }
  // Closed outcomes and completed recovery keep their identity; unfinished durable proposals may continue.
  // A `closed` settlement is the final answer — unless the caller carries an operator reset (`retryClosed`),
  // which says the obstruction the closed attempt named was cleared and the round deserves a fresh attempt.
  const concluded = mine
    .filter(
      attempt =>
        (attempt.settlement?.status === 'closed' && input.retryClosed !== true) ||
        (attempt.settlement?.status === 'recorded' && !input.resumeRecorded),
    )
    .at(-1)
  if (concluded !== undefined) return { kind: 'reuse', attempt: concluded }
  if (budget.used >= budget.max)
    return { kind: 'refused', code: 'budget-exhausted', attempt: undefined, attempts: mine, budget }
  return { kind: 'start', budget }
}

/** Every attempt this root store's ledger holds, for a reader that renders the state rather than deciding on it (`task_review_pack`). A display query: the decision is always made inside the admission's serial region. */
export async function readReviewAgentAttempts(rootStoreId: string): Promise<ReviewAgentAttempt[]> {
  const rows = await readLedgerRows()
  return attemptsOf(rows ?? [], rootStoreId)
}

/** The budget one admission belongs to: a ledger file and a root store. */
function budgetKey(rootStoreId: string): string {
  return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`
}

/** The serial regions, one promise chain per budget key. A region is the only place an attempt is decided on and claimed, so the attempts an admission sees and the claim it writes cannot have another. */
const regions = new Map<string, Promise<void>>()

/** Append one row, creating the ledger directory if needed. Only the doors below write. */
async function appendRow(row: ReviewAgentLedgerRow): Promise<void> {
  await appendJsonlRow(reviewAgentLedgerFile(), row)
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

/** Record one attempt's terminal fact. Append-only and outside the serial region on purpose: the caller writes it after it observed the outcome, which is always after the region that started the attempt has ended (A5: */
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

/** The attempts this process started and has not settled, by the reviewer session each was claimed under. */
const liveAttempts = new Set<string>()

/** Run one review-agent admission inside the ledger's serial region for a store. */
export async function admitReviewAgent<T>(
  rootStoreId: string,
  work: (admission: ReviewAgentAdmission) => Promise<T>,
): Promise<T> {
  const key = budgetKey(rootStoreId)
  const previous = regions.get(key) ?? Promise.resolve()
  const result = previous.then(async () => {
    const rows = (await readLedgerRows()) ?? []
    const started = startedRowsOf(rows, rootStoreId).length
    // One region's own view of the store: the rows it read, plus every row its
    // doors write while it holds the region. A caller that decides twice inside
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
        // model input, or one a process started and no longer holds (a dead
        // supervisor is re-delegable, exactly as a dead reviewer is re-readable).
        const requestRole = roleOf(request.role)
        const recovered: ReviewAgentAttempt[] = []
        for (const attempt of attempts) {
          if (attempt.role !== requestRole) continue
          if (requestRole === 'reviewer') {
            if (!sameSource(attempt.source, request.source)) continue
          } else {
            if (attempt.diagnosisId !== request.diagnosisId) continue
          }
          if (attempt.settlement !== undefined) continue
          if (liveAttempts.has(attempt.sessionId) || claimedHere.has(attempt.sessionId)) continue
          // The owner may have settled after this admission read its snapshot.
          // Its live marker disappears only after the terminal row is durable.
          const latest = (await readReviewAgentAttempts(rootStoreId)).find(item => item.sessionId === attempt.sessionId)
          if (latest?.settlement !== undefined) {
            Object.assign(attempt, { settlement: latest.settlement })
            continue
          }
          const recorded = (await hooks?.recorded?.(attempt)) === true
          const status: ReviewAgentSettlementStatus = recorded ? 'recorded' : 'interrupted'
          const note = recorded
            ? requestRole === 'reviewer'
              ? DIAGNOSIS_ALREADY_RECORDED
              : 'the proposal or recovery outcome is durable; resume from its recorded facts'
            : attempt.started
              ? STARTED_OWNER_GONE
              : CLAIM_NEVER_STARTED
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
        const plan =
          requestRole === 'supervisor'
            ? planSupervisorAttempt({
                attempts,
                request,
                budget: { used, max: reviewAgentBudget() },
                resumeRecorded: hooks?.resumeRecorded,
                retryClosed: hooks?.retryClosed,
              })
            : planReviewAttempt({ attempts, request, budget: { used, max: reviewAgentBudget() } })
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

/** The one delegation a session is recorded under, as the context package's reviewer binding source reads it (A2 §D): */
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
  const claims = (rows ?? []).filter((row): row is ReviewAgentClaimRecord => row.kind === 'claim' && row.sessionId === sessionId)
  const claim = claims[0]
  const record: ReviewerBindingRecord = {
    rootStoreId: first.rootStoreId,
    taskId: first.taskId,
    actor: first.actor,
    at: first.at,
    ...(claim === undefined ? {} : { role: claim.role ?? 'reviewer', sourceRunId: claim.runId }),
  }
  const conflicting = matches.some(
    row => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor,
  )
  const claimConflict = claims.some(row => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId ||
    row.actor !== record.actor || (row.role ?? 'reviewer') !== record.role || row.runId !== record.sourceRunId)
  if (conflicting || claimConflict) {
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
