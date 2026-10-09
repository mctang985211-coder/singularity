/**
 * Receipt sealing: terminal Run + confirmed drain + persisted session log →
 * one immutable receipt event. Idempotent, queued behind the settlement that
 * produced it, and recoverable after a process death — and never a reason for a
 * settlement to fail.
 * @module dsh-singularity-task-runtime/service/receipts
 */

import { TERMINAL_RUN_STATUSES } from '@dangosys/dsh-singularity-task'
import type { ExecutionReceipt, RunId, TaskId, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { TaskRuntime } from './runtime.ts'
import { buildExecutionReceipt, runAncestors } from '../receipt.ts'
import type { SessionFacts } from '../session-facts.ts'
import { sessionFactsOf } from '../session-facts.ts'
import { message } from '../helpers.ts'
import { drainSession } from '../gate.ts'
import type { DrainResult, JobsView } from '../gate.ts'
import { sessionEvents, sessionTokens } from './env.ts'
import * as svcEnv from './env.ts'
import * as svcEnvironment from './environment.ts'

/** The actor every receipt is written under; no caller may write one. */
const RECEIPT_ACTOR = 'task-runtime:receipt'

/** How long the sealer waits for a session log to pass a run's terminal boundary. */
const RECEIPT_PERSIST_WAIT_MS = 2000

/** How often the sealer re-reads the log while it waits. */
const RECEIPT_PERSIST_POLL_MS = 50

/**
 * How long the sealer's own drain may take. A receipt is evidence, not a step of
 * a settlement: the settlement's callers have already drained, so this window is
 * only meant to catch the tail of a writer that is still finishing, and an
 * unconfirmed result becomes the receipt's recorded `drain` fact rather than a
 * settlement that waits out the full write-drain window.
 */
const RECEIPT_DRAIN_TIMEOUT_MS = 2_000

/** What one sealing attempt settled as. */
export type ReceiptSealStatus =
  | { readonly status: 'sealed'; readonly receipt: ExecutionReceipt }
  | { readonly status: 'already-sealed'; readonly receipt: ExecutionReceipt }
  | { readonly status: 'not-terminal'; readonly reason: string }
  | { readonly status: 'deferred'; readonly reason: string }
  | { readonly status: 'unsupported'; readonly reason: string }

/** What one flush or reconcile pass settled as. */
export interface ReceiptReconcileReport {
  readonly sealed: readonly RunId[]
  readonly alreadySealed: number
  readonly deferred: readonly { readonly runId: RunId; readonly reason: string }[]
  readonly unsupported: readonly { readonly runId: RunId; readonly reason: string }[]
}

interface MutableReport {
  sealed: RunId[]
  alreadySealed: number
  deferred: { runId: RunId; reason: string }[]
  unsupported: { runId: RunId; reason: string }[]
}

function emptyReport(): MutableReport {
  return { sealed: [], alreadySealed: 0, deferred: [], unsupported: [] }
}

function record(report: MutableReport, runId: RunId, status: ReceiptSealStatus): void {
  if (status.status === 'sealed') report.sealed.push(runId)
  else if (status.status === 'already-sealed') report.alreadySealed += 1
  else if (status.status === 'deferred') report.deferred.push({ runId, reason: status.reason })
  else if (status.status === 'unsupported') report.unsupported.push({ runId, reason: status.reason })
}

/** Whether one run is the sealed run or a descendant of it, by `parentRunId`. */
function atOrUnder(snapshot: TaskSnapshot, root: RunId, candidate: RunId): boolean {
  return runAncestors(snapshot, candidate).includes(root)
}

/**
 * Seal one Run's receipt. Its preconditions are the store's own terminal status,
 * the drain conclusion, and a persisted session log that has reached the run's
 * terminal boundary; when the last is not there yet the sealer waits inside a
 * bounded window before it records the fact as missing.
 */
export async function sealRunReceipt(
  self: TaskRuntime,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  excludeCallId?: string,
): Promise<ReceiptSealStatus> {
  // One seal per store at a time: a settlement's own seal and a recovery pass can
  // both ask for the same run, and a store accepts one receipt per run.
  return await serialSeal(self, storeId, () => sealOnce(self, storeId, taskId, runId, excludeCallId))
}

/** Run one sealing attempt on the store's own tail. */
async function serialSeal<T>(self: TaskRuntime, storeId: string, work: () => Promise<T>): Promise<T> {
  const prior = self.receiptSealTails.get(storeId) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(work)
  self.receiptSealTails.set(storeId, pending.then(() => {}, () => {}))
  return await pending
}

/** One sealing attempt, without the store's serialization. */
async function sealOnce(
  self: TaskRuntime,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  excludeCallId?: string,
): Promise<ReceiptSealStatus> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const run = snapshot.runs.find(candidate => candidate.runId === runId)
  if (run === undefined) return { status: 'deferred', reason: `run "${runId}" is absent from store "${storeId}"` }
  if (run.taskId !== taskId) return { status: 'deferred', reason: `run "${runId}" belongs to task "${run.taskId}", not "${taskId}"` }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { status: 'not-terminal', reason: `run "${runId}" is ${run.status}` }
  const existing = snapshot.receipts?.find(receipt => receipt.runId === runId)
  if (existing !== undefined) return { status: 'already-sealed', receipt: existing }
  // The new-protocol gate: a run admitted before environment revisions existed is
  // old-protocol history, and sealing it would invent a revision it never had.
  if (run.environmentRevisionId === undefined) {
    return {
      status: 'unsupported',
      reason: `run "${runId}" is an old-protocol run with no environment revision; no receipt is sealed for it`,
    }
  }
  const revision = await svcEnvironment.revisionForRun(self, run)
  if (revision === undefined) {
    return { status: 'unsupported', reason: `run "${runId}" binds revision "${run.environmentRevisionId}", which the library no longer holds` }
  }

  const drain = await drainForSealing(self, run.sessionId, excludeCallId)
  const sessionFacts = await gatherSessionFacts(self, snapshot, runId, drain)
  const built = buildExecutionReceipt({
    storeId,
    snapshot,
    run,
    drain,
    sessionFacts,
    revision: { revisionId: revision.manifest.revisionId, digest: revision.manifest.contentDigest },
    sealedAt: new Date().toISOString(),
  })
  if (built.status === 'refused') return { status: 'deferred', reason: built.reason }
  await self.context.task.recordReceiptIn(storeId, built.receipt, RECEIPT_ACTOR)
  return { status: 'sealed', receipt: built.receipt }
}

/** The drain conclusion for one session: the in-process drain, or the reconcile pass when the session is gone. */
async function drainForSealing(
  self: TaskRuntime,
  sessionId: string,
  excludeCallId?: string,
): Promise<'in-process' | 'reconciled' | 'unconfirmed'> {
  const agent = svcEnv.agentOrUndefined(self, sessionId)
  if (self.startedSessions.has(sessionId) && agent !== undefined) {
    try {
      const drained: DrainResult = await drainSession(self.executionGate, sessionId, {
        timeoutMs: Math.min(self.config.writeDrainTimeoutMs, RECEIPT_DRAIN_TIMEOUT_MS),
        // The call that is settling this run is still in flight — it cannot land
        // until the settlement returns — so waiting on it would spend the whole
        // drain window on the one write that is not the receipt's business.
        ...(excludeCallId === undefined ? {} : { excludeCallId }),
        jobs: self.softService<JobsView>('jobs'),
        agent,
      })
      return drained.confirmed ? 'in-process' : 'unconfirmed'
    } catch (error) {
      self.warn(`session ${sessionId}: the write drain before sealing failed (${message(error)})`)
      return 'unconfirmed'
    }
  }
  try {
    await self.reconcileSessionJobs(sessionId)
    return 'reconciled'
  } catch (error) {
    self.warn(`session ${sessionId}: the adopted-work reconcile before sealing failed (${message(error)})`)
    return 'unconfirmed'
  }
}

/**
 * Read the session facts of every run of one sealed subtree.
 *
 * A confirmed drain means the writer stopped, so the log is read exactly as it
 * stands. An *unconfirmed* drain is the one case where the log may still be
 * arriving: that read waits inside a bounded window for the log to catch up with
 * the run, and records the fact as unread when the window closes rather than
 * reading a half-written log as if it were whole.
 */
async function gatherSessionFacts(
  self: TaskRuntime,
  snapshot: TaskSnapshot,
  runId: RunId,
  drain: 'in-process' | 'reconciled' | 'unconfirmed',
): Promise<Map<RunId, SessionFacts>> {
  const members = snapshot.runs.filter(run => atOrUnder(snapshot, runId, run.runId))
  const facts = new Map<RunId, SessionFacts>()
  const deadline = Date.now() + RECEIPT_PERSIST_WAIT_MS
  for (const member of members) {
    const boundary = member.startedAt
    for (;;) {
      const events = await sessionEvents(self, member.sessionId)
      if (events === undefined) {
        // No readable log at all: waiting cannot produce one, so the fact is
        // recorded as unread rather than delayed by the persistence window.
        facts.set(member.runId, {})
        break
      }
      if (drain !== 'unconfirmed' || logPassedBoundary(events, boundary)) {
        facts.set(member.runId, sessionFactsOf(events, sessionTokens(self, member.sessionId)))
        break
      }
      if (Date.now() >= deadline) {
        facts.set(member.runId, { ...sessionFactsOf(events, sessionTokens(self, member.sessionId)), logEvents: undefined })
        break
      }
      await new Promise(resolve => setTimeout(resolve, RECEIPT_PERSIST_POLL_MS))
    }
  }
  return facts
}

/**
 * Whether one session log has already recorded this run's own window: its last
 * event is not older than the run's start. A log that still holds nothing from
 * the run has, by definition, not been flushed yet — waiting is then the honest
 * answer, and the wait is bounded. The log's own `time` is epoch milliseconds.
 */
function logPassedBoundary(events: readonly { time?: unknown }[], startedAt: string): boolean {
  if (events.length === 0) return false
  const last = events.at(-1)
  if (typeof last?.time !== 'number') return true
  return new Date(last.time).toISOString() >= startedAt
}

/**
 * The seal one settlement asks for: queued on a per-store tail and advanced
 * without blocking the caller. A failure is warned and kept for the next flush.
 */
export function queueReceiptSeal(self: TaskRuntime, storeId: string, taskId: TaskId, runId: RunId): void {
  const pending = self.receiptSeals.get(storeId) ?? new Set<RunId>()
  pending.add(runId)
  self.receiptSeals.set(storeId, pending)
  const next = serialSeal(self, storeId, async () => {
      try {
        const status = await sealOnce(self, storeId, taskId, runId)
        if (status.status === 'sealed' || status.status === 'already-sealed' || status.status === 'unsupported') {
          pending.delete(runId)
          return
        }
        self.warn(`store ${storeId}: the receipt of run "${runId}" was not sealed (${status.reason}); it stays queued for the next pass`)
      } catch (error) {
        self.warn(`store ${storeId}: sealing the receipt of run "${runId}" failed (${message(error)}); the settlement is unaffected and the receipt stays queued`)
      }
    })
  void next
}

/**
 * The crash-recovery pass: seal every terminal new-protocol run of one store
 * that has no receipt yet. It runs after `reconcileStore`, so a process that
 * died between the terminal record and the seal makes the receipt up once.
 */
export async function reconcileRunReceipts(self: TaskRuntime, storeId: string): Promise<ReceiptReconcileReport> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const report = emptyReport()
  for (const run of snapshot.runs) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) continue
    if (snapshot.receipts?.some(receipt => receipt.runId === run.runId) === true) {
      report.alreadySealed += 1
      continue
    }
    if (run.environmentRevisionId === undefined) {
      report.unsupported.push({ runId: run.runId, reason: 'the run is old-protocol and carries no environment revision' })
      continue
    }
    try {
      record(report, run.runId, await sealRunReceipt(self, storeId, run.taskId, run.runId))
    } catch (error) {
      report.deferred.push({ runId: run.runId, reason: message(error) })
    }
  }
  return report
}

/** One run's receipt, or `undefined`. */
export async function receiptFor(self: TaskRuntime, storeId: string, runId: RunId): Promise<ExecutionReceipt | undefined> {
  return (await self.context.task.snapshotIn(storeId)).receipts?.find(receipt => receipt.runId === runId)
}

/** Every receipt one store holds, in sealing order. */
export async function receiptsOfStore(self: TaskRuntime, storeId: string): Promise<readonly ExecutionReceipt[]> {
  return (await self.context.task.snapshotIn(storeId)).receipts ?? []
}
