/**
 * Approved budget extensions (K4): the one durable fact that says a person
 * raised a ceiling of the tree's own budget — which dimensions, from what to
 * what, on whose request, under which approval — and nothing else.
 *
 * Why the record is a pair of ceilings and never an amount: "add two hours" or
 * "add five runs" has to be applied to something, and whatever that something
 * is, it moves. A pair (`previous` → `next`) states the two absolute values in
 * force at either end, so a reader of the record alone can tell what was
 * approved without recomputing anything from a configuration that may since
 * have changed, and the reducer can refuse a record whose `previous` is not the
 * value actually in force — which is what makes two grants approved against the
 * same reading mutually exclusive instead of additive.
 *
 * Why the record keeps the whole reading ({@link BudgetExtensionBaseline}) and
 * not only the dimensions it raises: the pairs say what one request moved, and
 * what it was *read* at is the other half of the same decision. Two requests can
 * name different dimensions of one reading — one the run count, one the deadline
 * — and the reason they cannot both stand is the dimension each of them leaves
 * alone, which no pair of either record states. So the runtime that asks the
 * person freezes that reading itself and the reading travels with the claim,
 * re-checked dimension by dimension inside the store's serial region; a request
 * whose reading no longer matches a ceiling the store can measure is refused by
 * name, with nothing written.
 *
 * Why the *previous* value is not an identity input: it is a reading, not a
 * request. The identity of an extension is the key plus the totals it asks for
 * ({@link budgetExtensionRequestDigest}), so a retry of the same request after a
 * crash addresses the same record whatever it read before, and a second request
 * under one key at different totals is new content — refused by name rather than
 * silently added to the first.
 *
 * What the record deliberately does not hold: the approval's own payload (the
 * channel's transcript, the person's words). It holds the channel's reference
 * ({@link TaskBudgetExtensionClaim.approvalRef}), exactly as the other human
 * gates in this workspace do — the reference is the durable fact, the transcript
 * belongs to the tool that asked.
 * @module @dangosys/dsh-singularity-task/budget
 */

import { canonicalize, sha256Hex } from './contract.ts'

/**
 * What one caller asks for: the request key it will be answered under, and the
 * totals it wants in force. The totals are absolute — the run count the tree may
 * reach, the instant it must stop by — never an increment, a duration or a
 * second account. A dimension left out is not asked for.
 */
export interface BudgetExtensionRequest {
  readonly requestKey: string
  /** The run count asked for as the whole approved total. */
  readonly maxRuns?: number
  /** The absolute instant asked for as the ceiling the tree stops at. */
  readonly deadlineAt?: string
}

/** One dimension's raise as it is recorded: the ceiling in force before, and the ceiling approved now. */
export interface BudgetRaise<T> {
  /** The ceiling in force when the request was read; the value the request was approved against. */
  readonly previous: T
  /** The ceiling in force once this record stands: the whole approved total, never the difference. */
  readonly next: T
}

/**
 * What a request becomes once it is judged: the raise each dimension moves, and
 * the request's own identity. This is the form a review is shown — the two
 * numbers a person is approving — and the form a recorded extension keeps.
 */
export interface BudgetExtensionProposal {
  readonly requestKey: string
  /** {@link budgetExtensionRequestDigest} of the key and the totals above. */
  readonly requestDigest: string
  readonly maxRuns?: BudgetRaise<number>
  readonly deadlineAt?: BudgetRaise<string>
}

/**
 * The ceilings one request was read at: what was in force, dimension by
 * dimension, when the runtime froze them for the question and the person
 * decided.
 *
 * The reading is the *whole* ceiling, never only the dimension a request names.
 * It travels into the store with the claim, because the store's serial
 * re-check is what makes two grants approved against one reading mutually
 * exclusive: a request that raises `maxRuns` and one that moves the deadline,
 * approved from the same reading, would otherwise both stand and leave the tree
 * under a combination of ceilings — a run count with a deadline — that neither
 * approver was ever shown. A dimension the reading leaves out is a reading the
 * store cannot recognise as the ceiling in force, and it is refused rather than
 * assumed, except where no extension has moved that dimension yet: the first
 * raise of a dimension states the deployment's own configured value, which the
 * store cannot recompute (the configuration is deliberately not in the store).
 */
export interface BudgetExtensionBaseline {
  /** The run ceiling read, or absent when the reading does not name one. */
  readonly maxRuns?: number
  /** The deadline read, in the canonical form the resolver reports it. */
  readonly deadlineAt?: string
}

/**
 * One extension as it is submitted: the proposal, the whole reading the runtime
 * froze when it asked, and whose request it is.
 *
 * The reading is the runtime's: the entry that puts the question to a person
 * freezes the ceilings in force itself and hands no reading back for a caller to
 * re-supply, so what travels here is the one value the card showed — and it is
 * re-checked, whole, inside the store's serial region. `approvalRef` is the
 * audit reference of the call that question was asked under
 * (`approval:<callId>`, the host's own identity for the call): the store keeps it
 * to say which question a record answers, so the decision can be found in DSH's
 * own approval record. It is never a credential — no entry accepts it in place
 * of a decision, and an empty one is refused by the reducer — and the store
 * cannot verify it either: it records a decision taken outside itself, and this
 * field is the audit trail, not the authorization.
 */
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

/**
 * The extensions a snapshot answers: all of them in the order they were
 * recorded, and the one bound to a request key. Idempotency is the second view —
 * one key names at most one extension, so a repeated request is answered from
 * the record instead of being granted twice.
 *
 * Optional at the type level because a snapshot is also a shape other code
 * builds by hand (a verifier's selftest store view, a test double), and those
 * literals predate budget extensions. A snapshot produced by this build's
 * reducer always carries it — empty members included — so an absent index means
 * "this reader cannot see extensions", never "the store holds none".
 */
export interface TaskBudgetExtensionIndex {
  readonly all: readonly TaskBudgetExtension[]
  /** `requestKey` → the extension bound to it. At most one, by construction. */
  readonly byRequestKey: Readonly<Record<string, TaskBudgetExtension>>
}

/** The closed field set of a submitted extension: an unread field must not enter the record. */
export const BUDGET_EXTENSION_CLAIM_FIELDS: readonly string[] = [
  'requestKey', 'requestDigest', 'maxRuns', 'deadlineAt', 'approvalRef', 'requestedBy', 'baseline',
]

/** The closed field set of a reading: a dimension nobody read must not enter a claim either. */
export const BUDGET_EXTENSION_BASELINE_FIELDS: readonly string[] = ['maxRuns', 'deadlineAt']

/** One store's extension index with nothing in it; what a store without extensions answers. */
export function emptyBudgetExtensionIndex(): TaskBudgetExtensionIndex {
  return { all: [], byRequestKey: {} }
}

/**
 * The request identity: SHA-256 over the key and the totals asked for, each
 * dimension in its canonical form (a deadline is the instant it denotes, not the
 * spelling it was written in). Deliberately not over the `previous` values: two
 * requests under one key at the same totals are one request, and a caller that
 * re-reads the ceiling between them has not asked for anything else.
 */
export function budgetExtensionRequestDigest(request: BudgetExtensionRequest): string {
  return sha256Hex(canonicalize({
    requestKey: request.requestKey,
    ...(request.maxRuns === undefined ? {} : { maxRuns: request.maxRuns }),
    ...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
  }))
}

/**
 * An instant with an explicit zone designator: a UTC `Z` or a numeric offset.
 * A string without one (`2026-09-16T04:00:00`) denotes a *local* time, which two
 * hosts read as two different instants — it is not an absolute deadline and is
 * refused rather than converted.
 */
const ABSOLUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * The canonical spelling (`new Date(ms).toISOString()`) of the absolute instant
 * a deadline value denotes, or `undefined` when it denotes none: an unreadable
 * string, a bare local time, a duration in words. Callers that *read* a value
 * normalize through this one function, so a deadline may be written with any
 * legal zone designator while what the store records — and what an identity is
 * taken over — is one spelling per instant. A caller that requires the stored
 * form compares the result to its input.
 */
export function canonicalBudgetInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ABSOLUTE_INSTANT.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** One extension's raises in one phrase, for a refusal that has to say what a request key already holds. */
export function describeBudgetExtension(extension: BudgetExtensionProposal): string {
  const raises = [
    ...(extension.maxRuns === undefined ? [] : [`maxRuns ${extension.maxRuns.previous} → ${extension.maxRuns.next}`]),
    ...(extension.deadlineAt === undefined ? [] : [`deadline ${extension.deadlineAt.previous} → ${extension.deadlineAt.next}`]),
  ]
  return `a budget extension raising ${raises.join(' and ')}`
}

/**
 * One dimension's reading in one phrase, for a refusal that has to say what a
 * request was read at: the value it was read at, or the fact that it names the
 * dimension nowhere. The two are told apart because both are refusals to re-base
 * a person's decision — a reading at a stale value and a reading that leaves a
 * bounded dimension out — and neither is a reason to invent the missing one.
 */
export function describeBudgetReading(dimension: 'maxRuns' | 'deadlineAt', value: number | string | undefined): string {
  return value === undefined ? `was read without a ${dimension} reading` : `was read at ${dimension} ${String(value)}`
}

/** The ceilings the approved extensions of `extensions` leave in force, per dimension each one moved. */
export interface ApprovedBudgetCeilings {
  /** The approved run count in force, or `undefined` when the store has no extension for that dimension. */
  readonly maxRuns?: number
  /** The approved deadline in force, or `undefined` when the store has no extension for that dimension. */
  readonly deadlineAt?: string
}

/**
 * Folds the store's extensions into the ceilings they leave in force: each
 * dimension keeps the `next` of the *last* extension that moved it, and a
 * dimension no extension names answers `undefined` — "the store has no approved
 * ceiling here", which every caller reads as "the deployment's own value still
 * stands" rather than as infinity. One implementation, so the resolver that
 * enforces a ceiling, the reducer that chains the next one onto it and the
 * service that judges a request all read the same numbers in the same order
 * (`all` is the store's own record order).
 */
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
