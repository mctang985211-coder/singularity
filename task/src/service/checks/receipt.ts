/**
 * The store's one receipt check: every reason a receipt may not enter a
 * snapshot, judged against the store's own records. This is what makes
 * "a caller or a model cannot supply a passing receipt" true — the event is
 * applied by the reducer, so the check reads only durable facts.
 * @module @dangosys/dsh-singularity-task/service/checks/receipt
 */

import { canonicalize, sha256Hex } from '../../contract.ts'
import { TERMINAL_RUN_STATUSES } from '../../types.ts'
import type { ExecutionReceipt, ReceiptMissingFact } from '../../receipt.ts'
import { criteriaDigestOf, executionReceiptDigest } from '../../receipt.ts'
import type { RunId, TaskId, TaskSnapshot } from '../../types.ts'
import { isDigest, isRecord, nonEmpty, runIn } from './primitives.ts'

function missingFact(receipt: ExecutionReceipt, fact: ReceiptMissingFact): boolean {
  return receipt.completeness.missing.some(entry => entry.fact === fact)
}

/** The same digest shape every content identity in this store is written in. */
function requireDigest(where: string, value: unknown): void {
  if (!isDigest(value)) throw new Error(`task: ${where} must be a lowercase SHA-256 hex digest`)
}

/**
 * Refuse a receipt the store cannot corroborate. Every branch reads a record the
 * store already holds: the run's own status, its provider binding, the task's
 * criteria, the review written at terminal time and the evidence bundles under
 * the sealed subtree.
 */
export function assertReceiptRecord(snapshot: TaskSnapshot, receipt: ExecutionReceipt): void {
  const where = `receipt of run "${receipt.runId}"`
  if (!isRecord(receipt)) throw new Error('task: a receipt must be an object')
  if (receipt.formatVersion !== 1) throw new Error(`task: ${where} has unsupported formatVersion ${JSON.stringify(receipt.formatVersion)}`)
  if (receipt.digest !== executionReceiptDigest(receipt)) {
    throw new Error(`task: ${where} carries digest ${receipt.digest}, which is not the digest of its content`)
  }
  if (!nonEmpty(receipt.sealedAt)) throw new Error(`task: ${where} requires a sealing time`)

  const run = runIn(snapshot, receipt.runId)
  if (run.taskId !== receipt.taskId) {
    throw new Error(`task: ${where} names task "${receipt.taskId}", but run "${run.runId}" belongs to "${run.taskId}"`)
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new Error(`task: ${where} is a receipt for a run that is ${run.status}; only a terminal run is sealed`)
  }
  if (receipt.outcome !== run.status) {
    throw new Error(
      `task: ${where} records outcome "${receipt.outcome}", but the store holds run "${run.runId}" as ${run.status}; a receipt copies the store's own status`,
    )
  }
  if ((snapshot.receipts ?? []).some(item => item.runId === receipt.runId)) {
    throw new Error(`task: ${where} already exists; one run is sealed exactly once`)
  }

  const task = snapshot.tasks.find(item => item.taskId === run.taskId)
  if (task === undefined) throw new Error(`task: ${where} names unknown task "${run.taskId}"`)

  // The subtree is this run and its descendants, frozen at sealing time.
  if (receipt.subtree.length === 0 || receipt.subtree[0] !== receipt.runId) {
    throw new Error(`task: ${where} must freeze a subtree that begins with its own run`)
  }
  const descendants = subtreeOf(snapshot, receipt.runId)
  for (const member of receipt.subtree) {
    if (!descendants.has(member)) {
      throw new Error(`task: ${where} names run "${member}" in its subtree, which does not descend from run "${receipt.runId}"`)
    }
  }
  if (receipt.subtree.length !== descendants.size) {
    throw new Error(
      `task: ${where} freezes ${receipt.subtree.length} runs, but the store holds ${descendants.size} runs under run "${receipt.runId}"; a subtree is every descendant of the sealed run`,
    )
  }

  // The review cross-check: the receipt may not overstate or invent one.
  const review = snapshot.reviews.find(item => item.runId === receipt.runId)
  if (review === undefined) {
    if (receipt.review.reviewRef !== null) {
      throw new Error(`task: ${where} cites review "${receipt.review.reviewRef}", which the store does not hold for run "${receipt.runId}"`)
    }
    if (receipt.review.criteria.length > 0 || receipt.review.evidenceRefs.length > 0) {
      throw new Error(`task: ${where} carries criteria or evidence references for a run the store holds no review for`)
    }
    if (receipt.review.criteriaDigest !== criteriaDigestOf([])) {
      throw new Error(`task: ${where} carries a criteria digest for a run the store holds no review for`)
    }
  } else {
    const expectedRef = `${review.taskId}#${run.runId}`
    if (receipt.review.reviewRef !== expectedRef) {
      throw new Error(`task: ${where} cites review ${JSON.stringify(receipt.review.reviewRef)}, but the store's record for this run is "${expectedRef}"`)
    }
    const recorded = review.criteria ?? []
    if (receipt.review.criteriaDigest !== criteriaDigestOf(recorded)) {
      throw new Error(`task: ${where} carries a criteria digest that is not the digest of the review's criteria`)
    }
    if (canonicalize(receipt.review.criteria) !== canonicalize(recorded)) {
      throw new Error(`task: ${where} carries criteria the review does not hold; a receipt copies the record rather than re-deriving it`)
    }
    const recordedRefs = new Set(review.evidenceRefs)
    for (const ref of receipt.review.evidenceRefs) {
      if (!recordedRefs.has(ref)) {
        throw new Error(`task: ${where} cites evidence "${ref}", which the review of run "${run.runId}" does not name`)
      }
    }
    if (canonicalize(receipt.review.anomalies) !== canonicalize(review.anomalies)) {
      throw new Error(`task: ${where} carries anomalies the review does not hold`)
    }
  }

  // Every evidence reference must be a bundle of this subtree.
  const inSubtree = new Set(receipt.subtree)
  for (const ref of receipt.review.evidenceRefs) {
    const bundle = snapshot.evidence.find(item => item.evidenceId === ref)
    if (bundle === undefined) throw new Error(`task: ${where} cites unknown evidence "${ref}"`)
    if (!inSubtree.has(bundle.taskRunId)) {
      throw new Error(`task: ${where} cites evidence "${ref}" of run "${bundle.taskRunId}", which is not in its subtree`)
    }
  }

  // Contract facts are the task's own.
  if (receipt.contract.criteriaDigest !== criteriaDigestOf(task.acceptanceCriteria)) {
    throw new Error(`task: ${where} carries a criteria digest that is not the digest of task "${task.taskId}"'s acceptance criteria`)
  }
  if ((receipt.contract.contractDigest ?? null) !== (task.contractDigest ?? null)) {
    throw new Error(`task: ${where} carries contract digest ${receipt.contract.contractDigest ?? 'none'}, but task "${task.taskId}" holds ${task.contractDigest ?? 'none'}`)
  }
  if (canonicalize(receipt.contract.requestedCapabilities) !== canonicalize(task.requestedCapabilities)) {
    throw new Error(`task: ${where} carries requested capabilities the task does not hold`)
  }

  // Environment facts are the binding's own.
  if (!nonEmpty(receipt.environment.revision.revisionId)) throw new Error(`task: ${where} requires an environment revision id`)
  requireDigest(`${where} environment revision digest`, receipt.environment.revision.digest)
  const binding = run.providerBinding
  const expectedBindingDigest = binding === undefined ? null : sha256Hex(canonicalize(binding))
  if ((receipt.environment.bindingDigest ?? null) !== expectedBindingDigest) {
    throw new Error(`task: ${where} carries binding digest ${receipt.environment.bindingDigest ?? 'none'}, which is not the digest of the run's provider binding`)
  }
  if ((receipt.environment.providerRegistryRevision ?? null) !== (binding?.registryRevision ?? null)) {
    throw new Error(`task: ${where} carries a registry revision the run's provider binding does not hold`)
  }
  if ((receipt.environment.templatesRoot ?? null) !== (run.taskTemplatesRoot ?? null)) {
    throw new Error(`task: ${where} carries a templates root the run does not record`)
  }
  if ((receipt.environment.preset ?? null) !== (run.agentPreset ?? null)) {
    throw new Error(`task: ${where} carries a preset the run does not record`)
  }

  // Every member's bound skills are that member's binding's skills, verbatim.
  for (const member of receipt.skills) {
    const memberRun = snapshot.runs.find(item => item.runId === member.runId)
    const expected = (memberRun?.providerBinding?.skills ?? []).map(skill => ({
      name: skill.name, role: skill.role, contentDigest: skill.contentDigest, contractDigest: skill.contractDigest,
    }))
    if (canonicalize(member.bound) !== canonicalize(expected)) {
      throw new Error(
        `task: ${where} carries bound skills for run "${member.runId}" that are not that run's provider binding's skills`,
      )
    }
  }

  // Everything else a receipt names must be inside the sealed subtree.
  for (const entry of receipt.modelUse) {
    if (!inSubtree.has(entry.runId)) throw new Error(`task: ${where} reports model use for run "${entry.runId}", which is not in its subtree`)
    if (entry.status === 'observed' && entry.logEvents <= 0) {
      throw new Error(`task: ${where} reports observed model use for run "${entry.runId}" over an empty log`)
    }
    if (entry.status === 'observed' && entry.requests.length === 0 && !missingFact(receipt, 'model-requests')) {
      throw new Error(
        `task: ${where} reports observed model use for run "${entry.runId}" with no request header and without recording the missing model-requests fact`,
      )
    }
    if (entry.status === 'unavailable' && !missingFact(receipt, 'session-log')) {
      throw new Error(`task: ${where} reports an unreadable session log without recording the missing session-log fact`)
    }
  }
  for (const entry of receipt.skills) {
    if (!inSubtree.has(entry.runId)) throw new Error(`task: ${where} reports skill use for run "${entry.runId}", which is not in its subtree`)
  }
  for (const entry of receipt.templates) {
    if (!inSubtree.has(entry.runId)) throw new Error(`task: ${where} reports template use for run "${entry.runId}", which is not in its subtree`)
  }

  // Completeness says exactly what it means.
  const complete = receipt.completeness.status === 'complete'
  if (complete === (receipt.completeness.missing.length > 0)) {
    throw new Error(`task: ${where} is ${receipt.completeness.status} while naming ${receipt.completeness.missing.length} missing facts`)
  }
  if (missingFact(receipt, 'drain') !== (receipt.drain === 'unconfirmed')) {
    throw new Error(`task: ${where} records drain "${receipt.drain}" and a drain missing fact that disagree`)
  }
  if (missingFact(receipt, 'review') !== (receipt.review.reviewRef === null)) {
    throw new Error(`task: ${where} records review presence and a review missing fact that disagree`)
  }
}

/** The set of runs at or under one run: itself and every descendant, by `parentRunId`. */
export function subtreeOf(snapshot: TaskSnapshot, runId: RunId): ReadonlySet<RunId> {
  const found = new Set<RunId>([runId])
  for (;;) {
    const size = found.size
    for (const run of snapshot.runs) {
      if (run.parentRunId !== undefined && found.has(run.parentRunId)) found.add(run.runId)
    }
    if (found.size === size) return found
  }
}

/** The task one receipt names, for a reader that wants the instance rather than the facts. */
export function receiptTaskOf(snapshot: TaskSnapshot, receipt: ExecutionReceipt): TaskId {
  return receipt.taskId
}
