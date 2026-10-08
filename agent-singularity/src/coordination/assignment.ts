/**
 * One coordination work item's application: the identity it is claimed under,
 * the digest that detects "same key, different subject", and the pure decision
 * that says whether this key is assigned, already taken up, resumable, or spent.
 *
 * Nothing here writes: the plan is a value, and the driver acts on it inside the
 * graph's serial region.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/assignment
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import type { CoordinationSessionFacts } from './session-facts.ts'
import {
  MAX_ASSIGNMENT_ATTEMPTS,
  completionFor,
  assignmentsForKey,
  type CoordinationAssignment,
  type CoordinationKey,
  type CoordinationRow,
  type CoordinatedWork,
} from './store.ts'

/** One work item's application, from the driver (a round's supervisor) or a review tool. */
export interface AssignmentRequest {
  readonly key: CoordinationKey
  /** The root task store the work item belongs to. */
  readonly storeId: string
  /** The pre-allocated session: a resume recovers this very session, never a new one. */
  readonly sessionId: SessionId
  readonly actor: string
  /** The subject's content digest; the same key carrying another digest is a conflict. */
  readonly digest: string
  /** The caller's focus text; it shapes the prompt and nothing else. */
  readonly focus: string | null
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** Why one plan refused a work item, by name. */
export type AssignmentRefusalCode =
  /** The key already names this work item with different contents. */
  | 'subject-conflict'
  /** The store has spent its whole coordination allowance. */
  | 'budget-exhausted'
  /** The key's session never reached model input `MAX_ASSIGNMENT_ATTEMPTS` times. */
  | 'attempts-exhausted'
  /** The key is claimed for another store or role. */
  | 'role-mismatch'

/** What one key's application settled as. */
export type AssignmentPlan =
  /** The key already has an assignment that settled: return it, spawn nothing. */
  | { readonly kind: 'reuse'; readonly work: CoordinatedWork }
  /** The key's assignment is taken up and not settled here: wait for it. */
  | { readonly kind: 'in-flight'; readonly work: CoordinatedWork }
  /** The key's session exists but never finished its turn: bring that same session back. */
  | { readonly kind: 'resume'; readonly work: CoordinatedWork }
  | { readonly kind: 'refused'; readonly code: AssignmentRefusalCode; readonly detail: string; readonly work?: CoordinatedWork }
  /** A new attempt, which the caller writes before it spawns. */
  | { readonly kind: 'assign'; readonly reuseSessionId?: string }

/** Whether two keys name the same work item. */
export function sameCoordinationKey(left: CoordinationKey, right: CoordinationKey): boolean {
  return (
    left.graphId === right.graphId && left.epoch === right.epoch && left.role === right.role &&
    sameSubjectOf(left, right)
  )
}

function sameSubjectOf(left: CoordinationKey, right: CoordinationKey): boolean {
  const a = left.subject
  const b = right.subject
  if (a.kind !== b.kind) return false
  if (a.kind === 'round' && b.kind === 'round')
    return a.businessRound === b.businessRound && a.searchRound === b.searchRound &&
      a.source.taskId === b.source.taskId && a.source.runId === b.source.runId
  if (a.kind === 'review' && b.kind === 'review')
    return a.businessRound === b.businessRound && a.source.taskId === b.source.taskId &&
      a.source.runId === b.source.runId && a.requestKey === b.requestKey
  return false
}

/** The canonical digest of one work item: graph, epoch, role and subject, and nothing else. */
export function subjectDigest(key: CoordinationKey): string {
  return sha256Hex(canonicalize({ graphId: key.graphId, epoch: key.epoch, role: key.role, subject: key.subject }))
}

/** One work item's readable name, for logs, refusals and progress notes. */
export function keyLabel(key: CoordinationKey): string {
  const subject = key.subject
  const described =
    subject.kind === 'round'
      ? `round ${subject.businessRound}`
      : `review of ${subject.source.taskId}#${subject.source.runId ?? 'no-run'}`
  return `${key.role} of graph ${key.graphId} (epoch ${key.epoch}) for ${described}`
}

/** The row one new attempt is persisted as, before anything is spawned for it. */
export function assignmentOf(request: AssignmentRequest, at: string): CoordinationAssignment {
  return {
    formatVersion: 1,
    kind: 'assignment',
    graphId: request.key.graphId,
    storeId: request.storeId,
    epoch: request.key.epoch,
    role: request.key.role,
    subject: request.key.subject,
    sessionId: String(request.sessionId),
    actor: request.actor,
    digest: request.digest,
    ...(request.model === undefined ? {} : { model: request.model }),
    at,
  }
}

/** One assignment's last completion, when it has one. */
function settledWork(
  rows: readonly CoordinationRow[],
  assignment: CoordinationAssignment,
): CoordinatedWork | undefined {
  const completion = completionFor(rows, assignment.sessionId)
  return completion === undefined ? undefined : { assignment, completion }
}

/**
 * Decide one key's application from the rows it already has, what DSH knows
 * about its sessions and what the store has spent. The decision is the whole
 * state machine of "may this key run now, wait, resume, or never again".
 */
export function planAssignment(input: {
  readonly request: AssignmentRequest
  readonly rows: readonly CoordinationRow[]
  readonly sessions: ReadonlyMap<string, CoordinationSessionFacts>
  readonly budget: { readonly used: number; readonly max: number }
}): AssignmentPlan {
  const { request, rows, sessions, budget } = input
  const mine = assignmentsForKey(rows, request.key)
  const last = mine.at(-1)
  if (last === undefined) {
    if (budget.used >= budget.max)
      return {
        kind: 'refused',
        code: 'budget-exhausted',
        detail: `store ${request.storeId} has spent its whole coordination allowance (${budget.used}/${budget.max})`,
      }
    return { kind: 'assign' }
  }
  if (last.storeId !== request.storeId || last.role !== request.key.role)
    return {
      kind: 'refused',
      code: 'role-mismatch',
      detail: `${keyLabel(request.key)} is recorded for ${last.role} of store ${last.storeId}`,
      work: { assignment: last },
    }
  if (last.digest !== request.digest)
    return {
      kind: 'refused',
      code: 'subject-conflict',
      detail:
        `${keyLabel(request.key)} already names a work item with another subject digest ` +
        `(${last.digest.slice(0, 19)}…) — a key names one work item and its contents cannot be changed`,
      work: { assignment: last },
    }
  const settled = settledWork(rows, last)
  if (settled !== undefined && settled.completion!.result.kind !== 'interrupted') return { kind: 'reuse', work: settled }
  if (settled !== undefined) {
    if (mine.length >= MAX_ASSIGNMENT_ATTEMPTS)
      return {
        kind: 'refused',
        code: 'attempts-exhausted',
        detail:
          `${keyLabel(request.key)} never reached model input ${MAX_ASSIGNMENT_ATTEMPTS} times ` +
          `(${(settled.completion!.result as { detail: string }).detail}); the platform does not ask again`,
        work: settled,
      }
    return { kind: 'assign' }
  }
  const facts = sessions.get(last.sessionId)
  if (facts === undefined || facts.presence === 'missing') return { kind: 'assign', reuseSessionId: last.sessionId }
  if (facts.presence === 'stored' && !facts.turnClosed) return { kind: 'resume', work: { assignment: last } }
  return { kind: 'in-flight', work: { assignment: last } }
}
