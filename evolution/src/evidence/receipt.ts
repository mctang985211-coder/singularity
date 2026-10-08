/**
 * The execution-receipt seam: the runtime sealed a Run's evidence, and this
 * module is the one place the evaluation reads it. A fact the receipt could not
 * establish is recorded as a gap — never filled in, never assumed.
 */

import type { ExecutionReceipt, ReceiptMissingFact, ReviewCriterion, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { executionUsage, requireReceiptFacts } from '@dangosys/dsh-singularity-task-runtime'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { canonicalJson } from '../shared.ts'
import type { CostReading, ExecutionReceiptRef, ModelSelection, SidePlan, TrialCriterion } from '../types.ts'

/** The workspace and identity facts a side's run settled under, as the evaluation recorded them. */
export interface ReceiptSideInput {
  readonly snapshot: TaskSnapshot
  readonly receipt: ExecutionReceipt
  readonly workspace: string
  readonly workspaceDigest: string
  readonly model: ModelSelection
  readonly revisionId: string
}

/** One review criterion, as a trial records it — the verifier that decided it travels with the verdict. */
export function trialCriteriaOf(criteria: readonly ReviewCriterion[]): readonly TrialCriterion[] {
  return criteria.map(criterion => ({
    criterionId: criterion.criterionId,
    verdict: criterion.verdict,
    ...(criterion.verifierId === undefined ? {} : { verifierId: criterion.verifierId }),
    ...(criterion.verifierVersion === undefined ? {} : { verifierVersion: criterion.verifierVersion }),
    ...(criterion.command === undefined ? {} : { command: criterion.command }),
    ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
  }))
}

/** One sealed subtree's cost: the four token buckets and the tool-call counters, or an explicit unknown. */
export function receiptCostOf(snapshot: TaskSnapshot, receipt: ExecutionReceipt): CostReading {
  const usage = executionUsage(snapshot, receipt)
  if (usage.status === 'unknown') return { status: 'unknown', reason: usage.reason ?? 'the sealed subtree carries incomplete counters' }
  if (usage.tokens === undefined) {
    return { status: 'unknown', reason: `the sealed subtree reports tool calls but no token buckets (runs ${usage.runIds.join(', ')})` }
  }
  return {
    status: 'reported',
    tokens: { ...usage.tokens },
    ...(usage.toolCalls === undefined ? {} : { toolCalls: { calls: usage.toolCalls.calls, failures: usage.toolCalls.failures } }),
  }
}

/** The one normalization from the runtime's receipt to the evaluation's own side fact. */
export function receiptRefOf(input: ReceiptSideInput): ExecutionReceiptRef {
  const { receipt } = input
  const missing = receipt.completeness.missing
  return {
    receiptId: `${receipt.runId}`,
    digest: receipt.digest,
    taskId: receipt.taskId,
    runId: receipt.runId,
    ...(receipt.review.reviewRef === null ? {} : { reviewRef: receipt.review.reviewRef }),
    criteria: trialCriteriaOf(receipt.review.criteria),
    evidenceRefs: [...receipt.review.evidenceRefs],
    cost: receiptCostOf(input.snapshot, receipt),
    boundRevision: receipt.environment.revision.revisionId,
    boundModel: `${input.model.provider}/${input.model.model}`,
    workspace: input.workspace,
    workspaceDigest: input.workspaceDigest,
    complete: missing.length === 0,
    ...(missing.length === 0 ? {} : { incompleteness: missing.map(entry => `${entry.fact}: ${entry.detail}`) }),
  }
}

/** The digest of one normalized receipt reference — the identity a report's trial carries. */
export function receiptRefDigest(receipt: ExecutionReceiptRef): string {
  return sha256Hex(canonicalJson(receipt))
}

/** Refuse a receipt that cannot establish the facts a comparison rests on, naming each one. */
export function requireEstablished(receipt: ExecutionReceipt, facts: readonly ReceiptMissingFact[], where: string): void {
  requireReceiptFacts(receipt, facts, where)
}

/** One side's receipt must be the receipt of *that* side: same revision, same model, same acceptance. */
export function assertReceiptMatchesSide(plan: SidePlan, receipt: ExecutionReceiptRef, where: string): void {
  if (receipt.boundRevision !== plan.revision.revisionId) {
    throw new Error(
      `${where}: the ${plan.side} side's receipt is bound to revision "${receipt.boundRevision}", not to the frozen plan's ` +
        `"${plan.revision.revisionId}" — a side that did not run the object it was frozen against proves nothing`,
    )
  }
  const bound = `${plan.model.provider}/${plan.model.model}`
  if (receipt.boundModel !== bound) {
    throw new Error(`${where}: the ${plan.side} side ran under model "${receipt.boundModel}", not the frozen "${bound}"`)
  }
  const planned = new Set(plan.acceptance.map(criterion => criterion.criterionId))
  const judged = new Set(receipt.criteria.map(criterion => criterion.criterionId))
  const missing = [...planned].filter(id => !judged.has(id))
  if (missing.length > 0) {
    throw new Error(
      `${where}: the ${plan.side} side's receipt judges no verdict for ${missing.length > 1 ? 'criteria' : 'criterion'} ` +
        `${missing.map(id => JSON.stringify(id)).join(', ')} — the original acceptance is not replaceable, so a side without its verdicts is refused`,
    )
  }
}

/** The two sides' workspaces must be distinct directories built from the same frozen input. */
export function assertSidesIsolated(baseline: ExecutionReceiptRef, candidate: ExecutionReceiptRef, where: string): void {
  if (baseline.workspace === candidate.workspace) {
    throw new Error(
      `${where}: both sides ran in "${baseline.workspace}" — the two sides of one comparison are independent workspaces, so a shared ` +
        'directory means one side observed the other',
    )
  }
  if (baseline.workspaceDigest !== candidate.workspaceDigest) {
    throw new Error(
      `${where}: the sides were built from different inputs ("${baseline.workspaceDigest}" vs "${candidate.workspaceDigest}"); the frozen ` +
        'input is what makes the comparison a comparison',
    )
  }
}
