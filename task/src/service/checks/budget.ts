/** Budget-extension validation: the pure shape, identity and chain checks of an approved raise. @module @dangosys/dsh-singularity-task/service/checks/budget */

import {
  BUDGET_EXTENSION_BASELINE_FIELDS,
  BUDGET_EXTENSION_CLAIM_FIELDS,
  approvedBudgetCeilings,
  budgetExtensionRequestDigest,
  canonicalBudgetInstant,
  describeBudgetExtension,
  describeBudgetReading,
} from '../../budget.ts'
import type { TaskBudgetExtension, TaskBudgetExtensionClaim, TaskBudgetExtensionIndex } from '../../budget.ts'
import { rootTaskStoreId } from '../../types.ts'
import type { TaskId, TaskSnapshot } from '../../types.ts'
import { isRecord, nonEmpty, requireIndex, taskIn } from './primitives.ts'

/** The snapshot's budget-extension index, or a refusal: an absent index is "cannot see", never "holds none". */
export function budgetExtensionIndex(snapshot: TaskSnapshot): TaskBudgetExtensionIndex {
  return requireIndex(snapshot.budgetExtensions, 'task: snapshot carries no budget extension index')
}

/** Validates one claim against the store's chain and returns the record to store, or `undefined` when the request is a repeat. */
export function buildBudgetExtension(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  sessionId: string | undefined,
  claim: TaskBudgetExtensionClaim,
  timestamp: string,
): TaskBudgetExtension | undefined {
  if (!isRecord(claim)) throw new Error('task: a budget extension must be an object')
  const requestKey = claim.requestKey
  if (!nonEmpty(requestKey)) throw new Error('task: a budget extension request key must be a non-empty string')
  for (const key of Object.keys(claim)) {
    if (!BUDGET_EXTENSION_CLAIM_FIELDS.includes(key)) {
      throw new Error(
        `task: budget extension "${requestKey}" carries "${key}", which is not part of an extension; an unread field must not enter the record`,
      )
    }
  }

  if (!nonEmpty(claim.approvalRef)) {
    throw new Error(
      `task: budget extension "${requestKey}" requires a non-empty approval reference; a raise nobody approved is not recorded`,
    )
  }
  if (!nonEmpty(claim.requestedBy))
    throw new Error(`task: budget extension "${requestKey}" must name the session that asked`)
  if (!nonEmpty(sessionId)) {
    throw new Error(
      `task: budget extension "${requestKey}" must carry the asking session on its envelope (the event's sessionId)`,
    )
  }
  if (claim.requestedBy !== sessionId) {
    throw new Error(
      `task: budget extension "${requestKey}" was asked by session "${claim.requestedBy}" but its event names "${sessionId}"`,
    )
  }
  if (rootTaskStoreId(claim.requestedBy) !== snapshot.id) {
    throw new Error(
      `task: budget extension "${requestKey}" names session "${claim.requestedBy}", which is not the root session of store "${snapshot.id}" ` +
        `(rootTaskStoreId derives the store from its root session, and "sg-t-${claim.requestedBy}" is not this store); ` +
        "the tree's budget belongs to the session that accepted it, and a worker never raises its own",
    )
  }
  if (taskIn(snapshot, taskId).parentTaskId !== undefined) {
    throw new Error(
      `task: budget extension "${requestKey}" names task "${taskId}", which is not the store's root task; the tree's budget is the root's`,
    )
  }
  if (claim.maxRuns === undefined && claim.deadlineAt === undefined) {
    throw new Error(`task: budget extension "${requestKey}" raises nothing: it must name maxRuns, deadlineAt, or both`)
  }
  const reading = claim.baseline
  if (!isRecord(reading)) {
    throw new Error(
      `task: budget extension "${requestKey}" carries no reading of the ceilings it was approved against (a \`baseline\`); ` +
        'a grant is approved against the whole ceiling the person was shown, and a record without that reading cannot be checked against the ceiling in force',
    )
  }
  for (const key of Object.keys(reading)) {
    if (!BUDGET_EXTENSION_BASELINE_FIELDS.includes(key)) {
      throw new Error(
        `task: budget extension "${requestKey}" was read at "${key}", which is not a dimension of the tree's budget; ` +
          'an unread field must not enter the record',
      )
    }
  }
  if (reading.maxRuns !== undefined && (!Number.isInteger(reading.maxRuns) || reading.maxRuns < 1)) {
    throw new Error(
      `task: budget extension "${requestKey}" was read at maxRuns ${JSON.stringify(reading.maxRuns)}; a run ceiling reading is a positive whole number of runs`,
    )
  }
  if (reading.deadlineAt !== undefined && canonicalBudgetInstant(reading.deadlineAt) !== reading.deadlineAt) {
    throw new Error(
      `task: budget extension "${requestKey}" was read at deadline ${JSON.stringify(reading.deadlineAt)}; ` +
        'a deadline reading is an absolute instant in canonical UTC form (`new Date(ms).toISOString()`)',
    )
  }
  if (claim.maxRuns !== undefined) {
    const { previous, next } = claim.maxRuns
    if (!Number.isInteger(previous) || previous < 1 || !Number.isInteger(next) || next < 1) {
      throw new Error(
        `task: budget extension "${requestKey}" records maxRuns ${previous} → ${next}; a run ceiling is a positive whole number of runs`,
      )
    }
    if (next <= previous) {
      throw new Error(
        `task: budget extension "${requestKey}" records maxRuns ${previous} → ${next}; a ceiling is the whole approved total and only ever moves up`,
      )
    }
    if (reading.maxRuns !== previous) {
      throw new Error(
        `task: budget extension "${requestKey}" raises maxRuns from ${previous} but ${describeBudgetReading('maxRuns', reading.maxRuns)}; ` +
          'a raise and the reading it was approved against name the same ceiling',
      )
    }
  }
  if (claim.deadlineAt !== undefined) {
    const previous = canonicalBudgetInstant(claim.deadlineAt.previous)
    const next = canonicalBudgetInstant(claim.deadlineAt.next)
    if (
      previous === undefined ||
      previous !== claim.deadlineAt.previous ||
      next === undefined ||
      next !== claim.deadlineAt.next
    ) {
      throw new Error(
        `task: budget extension "${requestKey}" records the deadline pair ${JSON.stringify(claim.deadlineAt)}; ` +
          'both ends are absolute instants in canonical UTC form (`new Date(ms).toISOString()`), never local time or a duration',
      )
    }
    if (Date.parse(next) <= Date.parse(previous)) {
      throw new Error(
        `task: budget extension "${requestKey}" records deadline ${previous} → ${next}; a deadline only ever moves later`,
      )
    }
    if (reading.deadlineAt !== previous) {
      throw new Error(
        `task: budget extension "${requestKey}" moves the deadline from ${previous} but ${describeBudgetReading('deadlineAt', reading.deadlineAt)}; ` +
          'a raise and the reading it was approved against name the same ceiling',
      )
    }
  }
  const digest = budgetExtensionRequestDigest({
    requestKey,
    ...(claim.maxRuns === undefined ? {} : { maxRuns: claim.maxRuns.next }),
    ...(claim.deadlineAt === undefined ? {} : { deadlineAt: claim.deadlineAt.next }),
  })
  if (claim.requestDigest !== digest) {
    throw new Error(
      `task: budget extension "${requestKey}" declares identity ${JSON.stringify(claim.requestDigest)}, which is not the identity of the request it carries (${digest})`,
    )
  }
  const index = budgetExtensionIndex(snapshot)
  const existing = index.byRequestKey[requestKey]
  if (existing !== undefined) {
    if (existing.requestDigest === claim.requestDigest) return undefined
    throw new Error(
      `task: budget extension request key "${requestKey}" is already bound to ${describeBudgetExtension(existing)} (identity ${existing.requestDigest}); ` +
        'one key names one request, and different content under it is a new key rather than a second grant',
    )
  }
  const inForce = approvedBudgetCeilings(index.all)

  if (inForce.maxRuns !== undefined && reading.maxRuns !== inForce.maxRuns) {
    throw new Error(
      `task: budget extension "${requestKey}" ${describeBudgetReading('maxRuns', reading.maxRuns)}, but the ceiling in force here is ${inForce.maxRuns}; ` +
        "the tree's ceiling moved since this request was read, so committing it would re-base an approval on a value nobody approved — " +
        'read the whole ceiling again and ask for the difference',
    )
  }

  if (!nonEmpty(timestamp)) throw new Error(`task: budget extension "${requestKey}" has no recorded time on its event`)
  const record: TaskBudgetExtension = {
    requestKey,
    requestDigest: claim.requestDigest,
    ...(claim.maxRuns === undefined ? {} : { maxRuns: { previous: claim.maxRuns.previous, next: claim.maxRuns.next } }),
    ...(claim.deadlineAt === undefined
      ? {}
      : { deadlineAt: { previous: claim.deadlineAt.previous, next: claim.deadlineAt.next } }),
    approvalRef: claim.approvalRef,
    requestedBy: claim.requestedBy,
    baseline: {
      ...(reading.maxRuns === undefined ? {} : { maxRuns: reading.maxRuns }),
      ...(reading.deadlineAt === undefined ? {} : { deadlineAt: reading.deadlineAt }),
    },
    recordedAt: timestamp,
  }
  return record
}
