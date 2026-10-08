/**
 * The coordination store: the only two records a graph's coordination keeps —
 * one `assignment` written (and fsynced) before an agent is spawned, and one
 * `completion` written when its session ends. How a session is running, whether
 * it is live and what it spent are DSH's own facts; this file never keeps a
 * second copy of them.
 *
 * The file is `$SINGULARITY_COORDINATION_DIR/assignments.jsonl` (default
 * `$DSH_HOME/coordination`), append-only, one {@link CoordinationRow} per line,
 * `formatVersion: 1`. A row whose version or kind this build does not read is
 * refused by name — the legacy `$DSH_HOME/review-agents/agents.jsonl` ledger is
 * never read and never written.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/store
 */

import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { CoordinationBindingSource } from '@dangosys/dsh-singularity-context'
import { CoordinationBindingError } from '@dangosys/dsh-singularity-context'
import { DEFAULT_SUPERVISION, supervisionSettings } from './supervision.ts'

/** The only row format this build reads. */
export const COORDINATION_FORMAT_VERSION = 1

/** How many times one work item may be re-assigned after an infrastructure failure (`interrupted`). */
export const MAX_ASSIGNMENT_ATTEMPTS = 3

/** The coordination responsibilities a work item can carry. */
export type CoordinationRole = 'supervisor' | 'reviewer'

/** What one coordination work item is about: a business round's supervision, or a review of one source. */
export type CoordinationSubject =
  | {
      readonly kind: 'round'
      readonly businessRound: number
      readonly searchRound: number
      readonly source: { readonly taskId: string; readonly runId: string }
    }
  | {
      readonly kind: 'review'
      readonly businessRound: number | null
      readonly source: { readonly taskId: string; readonly runId: string | null }
      readonly requestKey: string | null
    }

/** One work item's identity: one identity has one live session at a time, ever. */
export interface CoordinationKey {
  readonly graphId: string
  readonly epoch: number
  readonly role: CoordinationRole
  readonly subject: CoordinationSubject
}

/** One recorded assignment — the row written before the spawn, and the row a completion names. */
export interface CoordinationAssignment {
  readonly formatVersion: 1
  readonly kind: 'assignment'
  readonly graphId: string
  /** The root task store this work item belongs to; the graph key readers filter by. */
  readonly storeId: string
  readonly epoch: number
  readonly role: CoordinationRole
  readonly subject: CoordinationSubject
  readonly sessionId: string
  readonly actor: string
  /** The subject's content digest: the same key with another digest is a conflict. */
  readonly digest: string
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly at: string
}

/** One approval source as the platform recorded it. */
export interface CompletionApproval {
  readonly source: 'human' | 'platform_policy'
  readonly ref: string
}

/** What one work item settled as. */
export type CompletionResult =
  /** A supervisor called `supervisor_complete`: the model's own report, plus the fields the platform derived. */
  | {
      readonly kind: 'completed'
      readonly businessAction: 'continue' | 'recover' | 'finish'
      readonly reason: string
      readonly evidenceRefs: readonly string[]
      readonly trialCandidateRef: string | null
      readonly methodDecision: 'retain' | 'trial' | 'promote' | 'discard' | 'rollback'
      readonly searchNext: 'explore' | 'stop'
      readonly approval?: CompletionApproval
    }
  /** A reviewer called `reviewer_complete`: the diagnosis it recorded, and how sure it was. */
  | { readonly kind: 'reviewed'; readonly diagnosisId: string; readonly confidence: 'high' | 'medium' | 'low' }
  /** The session's turn ended without a completion call: a protocol failure, recorded once and never re-asked. */
  | { readonly kind: 'protocol-failure'; readonly detail: string }
  /** The platform never got the session to model input (spawn or resume failure): retryable, bounded. */
  | { readonly kind: 'interrupted'; readonly detail: string }

/** One recorded completion. */
export interface CoordinationCompletion {
  readonly formatVersion: 1
  readonly kind: 'completion'
  readonly graphId: string
  readonly storeId: string
  readonly epoch: number
  readonly role: CoordinationRole
  readonly sessionId: string
  readonly result: CompletionResult
  readonly at: string
}

/** Every row the coordination file may hold. */
export type CoordinationRow = CoordinationAssignment | CoordinationCompletion

/** One assignment and the completion it settled with, if it has one. */
export interface CoordinatedWork {
  readonly assignment: CoordinationAssignment
  readonly completion?: CoordinationCompletion
}

/**
 * The caller's own coordination identity, as the completion tools and the
 * binding source read it: the wide shape this store holds. The context package's
 * narrower wire is a projection of it (see {@link coordinationBindingSource}).
 */
export interface CoordinationBinding {
  readonly graphId: string
  readonly rootStoreId: string
  readonly epoch: number
  readonly role: CoordinationRole
  readonly subject: CoordinationSubject
  readonly sourceTaskId: string
  readonly sourceRunId: string | null
  readonly sessionId: string
  readonly actor: string
  readonly at: string
  readonly completed: boolean
}

/** The directory this deployment's coordination file lives in. `SINGULARITY_COORDINATION_DIR` wins over `$DSH_HOME`. */
export function coordinationDir(): string {
  const override = process.env.SINGULARITY_COORDINATION_DIR
  if (override !== undefined && override.length > 0) return resolve(override)
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'coordination')
}

/** The coordination file itself. */
export function coordinationFile(): string {
  return join(coordinationDir(), 'assignments.jsonl')
}

/** The per-store cap on coordination runs: env `SINGULARITY_COORDINATION_BUDGET` wins, then the deployment's policy. */
export function coordinationBudget(): number {
  const raw = process.env.SINGULARITY_COORDINATION_BUDGET
  const parsed = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw)
  if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed)
  return supervisionSettings().coordinationBudget || DEFAULT_SUPERVISION.coordinationBudget
}

/** One parsed row; an unrecognized version or kind is refused by name. */
function asRow(parsed: unknown, line: number): CoordinationRow {
  const row = parsed as { formatVersion?: unknown; kind?: unknown }
  if (row.formatVersion !== COORDINATION_FORMAT_VERSION || (row.kind !== 'assignment' && row.kind !== 'completion')) {
    throw new Error(`coordination-store: unrecognized row ${line} in ${coordinationFile()}`)
  }
  return parsed as CoordinationRow
}

/** Every row, or `undefined` when the file has never been written. A corrupt line throws by name. */
export async function readCoordinationRows(): Promise<CoordinationRow[] | undefined> {
  let text: string
  try {
    text = await readFile(coordinationFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const rows: CoordinationRow[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`coordination-store: corrupt line ${index + 1} in ${coordinationFile()}`)
    }
    rows.push(asRow(parsed, index + 1))
  })
  return rows
}

function isAssignment(row: CoordinationRow): row is CoordinationAssignment {
  return row.kind === 'assignment'
}

/** The completion one session recorded, if any — the first one is the only one written. */
function completionOf(rows: readonly CoordinationRow[], sessionId: string): CoordinationCompletion | undefined {
  return rows.find(row => row.kind === 'completion' && row.sessionId === sessionId) as CoordinationCompletion | undefined
}

/** Every work item one graph holds, an assignment followed by its own completion. */
export async function coordinatedWork(graphId: string): Promise<readonly CoordinatedWork[]> {
  const rows = (await readCoordinationRows()) ?? []
  return workOf(rows, graphId)
}

/** The rows-only projection of {@link coordinatedWork}, for callers that already hold the rows. */
export function workOf(rows: readonly CoordinationRow[], graphId: string): readonly CoordinatedWork[] {
  const mine = rows.filter(row => row.graphId === graphId)
  const work: CoordinatedWork[] = []
  for (const row of mine) {
    if (!isAssignment(row)) continue
    const completion = completionOf(mine, row.sessionId)
    work.push({ assignment: row, ...(completion === undefined ? {} : { completion }) })
  }
  return work
}

/** Every work item of one graph's key space, newest assignment last. */
export function assignmentsForKey(rows: readonly CoordinationRow[], key: CoordinationKey): readonly CoordinationAssignment[] {
  return rows.filter(isAssignment).filter(
    row =>
      row.graphId === key.graphId &&
      row.epoch === key.epoch &&
      row.role === key.role &&
      sameSubject(row.subject, key.subject),
  )
}

/** Whether two subjects name the same work item. */
export function sameSubject(left: CoordinationSubject, right: CoordinationSubject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'round' && right.kind === 'round') {
    return (
      left.businessRound === right.businessRound &&
      left.searchRound === right.searchRound &&
      left.source.taskId === right.source.taskId &&
      left.source.runId === right.source.runId
    )
  }
  if (left.kind === 'review' && right.kind === 'review') {
    return (
      left.businessRound === right.businessRound &&
      left.source.taskId === right.source.taskId &&
      left.source.runId === right.source.runId &&
      left.requestKey === right.requestKey
    )
  }
  return false
}

/** The completion one assignment settled with, from the rows alone. */
export function completionFor(rows: readonly CoordinationRow[], sessionId: string): CoordinationCompletion | undefined {
  return completionOf(rows, sessionId)
}

/** fsync one directory, so a freshly created file's name survives a crash. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The directories this process has already fsynced after creating a file in them. */
const syncedDirs = new Set<string>()

/** Append one row and flush it to the device before returning; the first write also fsyncs its directory. */
async function appendRow(row: CoordinationRow): Promise<void> {
  const file = coordinationFile()
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const firstWrite = !syncedDirs.has(dir)
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flush: true })
  if (firstWrite) {
    await syncDir(dir)
    syncedDirs.add(dir)
  }
}

/**
 * Persist one assignment. Returns only after the row is on the device, which is
 * what makes "claim before spawn" a real order rather than a hoped-for one.
 */
export async function appendAssignment(assignment: CoordinationAssignment): Promise<void> {
  await appendRow(assignment)
}

/** Persist one completion, then wake this process's driver. */
export async function recordCompletion(completion: CoordinationCompletion): Promise<void> {
  await appendRow(completion)
  for (const listener of listeners) {
    try {
      listener(completion)
    } catch {
      // A listener that throws is not a reason for a durable completion to fail.
    }
  }
}

/** Whether one assignment is already on the device (the spawn read-back asserts it). */
export async function assignmentIsDurable(sessionId: string): Promise<boolean> {
  const rows = await readCoordinationRows()
  return (rows ?? []).some(row => row.kind === 'assignment' && row.sessionId === sessionId)
}

/** The serial regions, one promise chain per graph: decisions and writes never interleave inside one graph. */
const regions = new Map<string, Promise<void>>()

/** Run one piece of work inside a graph's serial region, after everything already queued for it. */
export async function serializeCoordination<T>(graphId: string, work: () => Promise<T>): Promise<T> {
  const previous = regions.get(graphId) ?? Promise.resolve()
  const result = previous.then(work)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  regions.set(graphId, tail)
  void tail.then(() => {
    if (regions.get(graphId) === tail) regions.delete(graphId)
  })
  return result
}

/** This process's completion listeners — the driver's first wake-up source. */
const listeners = new Set<(completion: CoordinationCompletion) => void>()

/** Subscribe to this process's own completion writes; the returned disposer removes the listener. */
export function onCoordinationCompletion(listener: (completion: CoordinationCompletion) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every assignment of one session, as the binding read needs them. */
function assignmentsOfSession(rows: readonly CoordinationRow[], sessionId: string): readonly CoordinationAssignment[] {
  return rows.filter(isAssignment).filter(row => row.sessionId === sessionId)
}

/**
 * Read the caller's coordination identity by session id. Two assignments of one
 * session that disagree about what the session is (a different graph, store,
 * role or subject) is a conflict and is refused, never resolved by picking one.
 */
export async function readCoordinationBinding(sessionId: string): Promise<CoordinationBinding | undefined> {
  let rows: CoordinationRow[] | undefined
  try {
    rows = await readCoordinationRows()
  } catch (error) {
    throw new CoordinationBindingError(
      'unreadable',
      `the coordination store cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const mine = assignmentsOfSession(rows ?? [], sessionId)
  const first = mine[0]
  if (first === undefined) return undefined
  const conflicting = mine.some(
    row =>
      row.graphId !== first.graphId ||
      row.storeId !== first.storeId ||
      row.epoch !== first.epoch ||
      row.role !== first.role ||
      !sameSubject(row.subject, first.subject),
  )
  if (conflicting) {
    throw new CoordinationBindingError(
      'binding-conflict',
      `session "${sessionId}" is recorded under more than one coordination assignment: ` +
        mine.map(row => `${row.role} of ${row.graphId} in ${row.storeId} (by ${row.actor})`).join('; '),
    )
  }
  const completion = completionOf(rows ?? [], sessionId)
  return {
    graphId: first.graphId,
    rootStoreId: first.storeId,
    epoch: first.epoch,
    role: first.role,
    subject: first.subject,
    sourceTaskId: first.subject.source.taskId,
    sourceRunId: first.subject.source.runId,
    sessionId,
    actor: first.actor,
    at: first.at,
    completed: completion !== undefined,
  }
}

/** The ledger row as the context package's binding wire: the wide shape narrowed to the seam it reads. */
async function coordinationBindingOf(sessionId: string): Promise<
  { readonly role: CoordinationRole } & {
    readonly sourceTaskId: string
    readonly sourceRunId: string | null
    readonly actor: string
    readonly rootStoreId: string
    readonly at: string
  } | undefined
> {
  const binding = await readCoordinationBinding(sessionId)
  if (binding === undefined) return undefined
  return {
    role: binding.role,
    sourceTaskId: binding.sourceTaskId,
    sourceRunId: binding.sourceRunId,
    actor: binding.actor,
    rootStoreId: binding.rootStoreId,
    at: binding.at,
  }
}

/** The binding source this deployment registers into the context service. */
export function coordinationBindingSource(): CoordinationBindingSource {
  return { read: coordinationBindingOf }
}
