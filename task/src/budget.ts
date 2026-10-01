/** Approved budget extensions (K4): one durable record per approved raise of the tree's own budget. @module @dangosys/dsh-singularity-task/budget */

import { canonicalize, sha256Hex } from './contract.ts'

/** What one caller asks for: the request key it will be answered under, and the totals it wants in force. */
export interface BudgetExtensionRequest {
  readonly requestKey: string
  /** The run count asked for as the whole approved total. */
  readonly maxRuns?: number
  /** The absolute instant asked for as the ceiling the tree stops at. */
  readonly deadlineAt?: string
}

/** One dimension's raise as it is recorded: the ceiling in force before, and the ceiling approved now. */
interface BudgetRaise<T> {
  /** The ceiling in force when the request was read; the value the request was approved against. */
  readonly previous: T
  /** The ceiling in force once this record stands: the whole approved total, never the difference. */
  readonly next: T
}

/** What a request becomes once it is judged: the raise each dimension moves, and the request's own identity. This is the form a review is shown — the two numbers a person is approving — and the form a recorded extension keeps. */
export interface BudgetExtensionProposal {
  readonly requestKey: string
  /** {@link budgetExtensionRequestDigest} of the key and the totals above. */
  readonly requestDigest: string
  readonly maxRuns?: BudgetRaise<number>
  readonly deadlineAt?: BudgetRaise<string>
}

/** The ceilings one request was read at: what was in force, dimension by dimension, when the runtime froze them for the question and the person decided. The reading is the *whole* ceiling, never only the dimension a request names. */
interface BudgetExtensionBaseline {
  /** The run ceiling read, or absent when the reading does not name one. */
  readonly maxRuns?: number
  /** The deadline read, in the canonical form the resolver reports it. */
  readonly deadlineAt?: string
}

/** One extension as it is submitted: the proposal, the whole reading the runtime froze when it asked, and whose request it is. */
export interface TaskBudgetExtensionClaim extends BudgetExtensionProposal {
  readonly approvalRef: string
  /** The root coordination session that asked — the store's own root session. */
  readonly requestedBy: string
  /** The ceilings this request was read at — every dimension the tree bounds, not only the ones it raises. */
  readonly baseline: BudgetExtensionBaseline
}

/** One extension as the store holds it: the accepted claim, stamped with the event's own time. */
export interface TaskBudgetExtension extends TaskBudgetExtensionClaim {
  /** The moment the store recorded it, taken from the event — never from the caller. */
  readonly recordedAt: string
}

/** The extensions a snapshot answers: all of them in the order they were recorded, and the one bound to a request key. */
export interface TaskBudgetExtensionIndex {
  readonly all: readonly TaskBudgetExtension[]
  /** `requestKey` → the extension bound to it. At most one, by construction. */
  readonly byRequestKey: Readonly<Record<string, TaskBudgetExtension>>
}

/** The closed field set of a submitted extension: an unread field must not enter the record. */
export const BUDGET_EXTENSION_CLAIM_FIELDS: readonly string[] = [
  'requestKey',
  'requestDigest',
  'maxRuns',
  'deadlineAt',
  'approvalRef',
  'requestedBy',
  'baseline',
]

/** The closed field set of a reading: a dimension nobody read must not enter a claim either. */
export const BUDGET_EXTENSION_BASELINE_FIELDS: readonly string[] = ['maxRuns', 'deadlineAt']

/** The request identity: SHA-256 over the key and the totals asked for, each dimension in its canonical form (a deadline is the instant it denotes, not the spelling it was written in). */
export function budgetExtensionRequestDigest(request: BudgetExtensionRequest): string {
  return sha256Hex(
    canonicalize({
      requestKey: request.requestKey,
      ...(request.maxRuns === undefined ? {} : { maxRuns: request.maxRuns }),
      ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
    }),
  )
}

/** An instant with an explicit zone designator: a UTC `Z` or a numeric offset. A string without one (`2026-09-16T04:00:00`) denotes a *local* time, which two hosts read as two different instants — it is not an absolute deadline and is refused … */
const ABSOLUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** The canonical spelling (`new Date(ms).toISOString()`) of the absolute instant a deadline value denotes, or `undefined` when it denotes none: an unreadable string, a bare local time, a duration in words. */
export function canonicalBudgetInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ABSOLUTE_INSTANT.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** One extension's raises in one phrase, for a refusal that has to say what a request key already holds. */
export function describeBudgetExtension(extension: BudgetExtensionProposal): string {
  const raises = [
    ...(extension.maxRuns === undefined ? [] : [`maxRuns ${extension.maxRuns.previous} → ${extension.maxRuns.next}`]),
    ...(extension.deadlineAt === undefined
      ? []
      : [`deadline ${extension.deadlineAt.previous} → ${extension.deadlineAt.next}`]),
  ]
  return `a budget extension raising ${raises.join(' and ')}`
}

/** One dimension's reading in one phrase, for a refusal that has to say what a request was read at: the value it was read at, or the fact that it names the dimension nowhere. */
export function describeBudgetReading(dimension: 'maxRuns' | 'deadlineAt', value: number | string | undefined): string {
  return value === undefined ? `was read without a ${dimension} reading` : `was read at ${dimension} ${String(value)}`
}

/** The ceilings the approved extensions of `extensions` leave in force, per dimension each one moved. */
interface ApprovedBudgetCeilings {
  /** The approved run count in force, or `undefined` when the store has no extension for that dimension. */
  readonly maxRuns?: number
  /** The approved deadline in force, or `undefined` when the store has no extension for that dimension. */
  readonly deadlineAt?: string
}

/** Folds the store's extensions into the ceilings they leave in force: each dimension keeps the `next` of the *last* extension that moved it, and a dimension no extension names answers `undefined` — "the store has no approved ceiling here" … */
export function approvedBudgetCeilings(extensions: readonly TaskBudgetExtension[]): ApprovedBudgetCeilings {
  let maxRuns: number | undefined
  let deadlineAt: string | undefined
  for (const extension of extensions) {
    if (extension.maxRuns !== undefined) maxRuns = extension.maxRuns.next
    if (extension.deadlineAt !== undefined) deadlineAt = extension.deadlineAt.next
  }
  return {
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  }
}
