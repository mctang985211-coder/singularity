/**
 * The execution receipt: the runtime's record of what one Run actually was —
 * its contract, the environment revision it bound, the models it really called,
 * the assets it consumed, its terminal review, and the usage of its frozen
 * execution subtree. Written by the runtime's sealer, never by a caller.
 * @module @dangosys/dsh-singularity-task/receipt
 */

import { canonicalize, sha256Hex } from './contract.ts'
import type { TaskTemplateRef, TemplateParameters } from './template.ts'
import type { ReviewCriterion, RunId, RunStatus, TaskId, TaskSnapshot } from './types.ts'

/** The minimal persistent pin of one immutable environment revision: the id and the revision content's digest. */
export interface RevisionPin {
  readonly revisionId: string
  /** `EnvironmentRevisionManifest.contentDigest` of the revision the Run bound. */
  readonly digest: string
}

/** One real request's calling configuration, normalized by `(provider, model, effort, maxTokens)`. */
export interface ReceiptRequestIdentity {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** One calling configuration and how many requests a run made under it. */
export interface ReceiptRequestCount {
  readonly identity: ReceiptRequestIdentity
  readonly count: number
}

/** What one run's session log shows about the models it actually called. */
export interface ReceiptRunModelUse {
  readonly runId: RunId
  readonly sessionId?: string
  /** `observed` = a durable log was read; `no-worker` = this run never had a worker session; `unavailable` = the log could not be read. */
  readonly status: 'observed' | 'no-worker' | 'unavailable'
  /** Distinct identities in first-appearance order, each with its request count. */
  readonly requests: readonly ReceiptRequestCount[]
  /** Events the persisted log held when it was read (0 when the reading failed). */
  readonly logEvents: number
}

/** One skill a run's grant was built from, as its binding records it. */
export interface ReceiptBoundSkill {
  readonly name: string
  readonly role: 'execution-provider' | 'knowledge' | 'guidance'
  readonly contentDigest: string
  readonly contractDigest: string | null
}

/** One run's skill consumption: what it was granted, and what its session actually loaded. */
export interface ReceiptSkillUse {
  readonly runId: RunId
  readonly bound: readonly ReceiptBoundSkill[]
  readonly loaded: readonly string[]
  /** Names the session loaded that its grant does not cover. */
  readonly loadedOutsideGrant: readonly string[]
}

/** One consumed task-template batch, with the session observation that a caller really requested it. */
export interface ReceiptTemplateUse {
  /** The run that admitted the batch. */
  readonly runId: RunId
  readonly proposalId: string
  readonly batchId: string
  readonly templateRef: TaskTemplateRef
  readonly templateParameters: Readonly<Record<string, unknown>>
  readonly childTaskIds: readonly TaskId[]
  /** `observed` = the session log shows the call; `not-observed` = it does not; `unavailable` = no log could be read. */
  readonly observation: 'observed' | 'not-observed' | 'unavailable'
}

/** The contract facts a receipt pins: `null` digests mean the store holds no such field on that record. */
export interface ReceiptContractFacts {
  readonly contractDigest: string | null
  readonly criteriaDigest: string
  readonly requestedCapabilities: readonly string[]
}

/** The environment facts a receipt pins. */
export interface ReceiptEnvironmentFacts {
  readonly revision: RevisionPin
  /** `sha256(canonicalize(run.providerBinding))`, or `null` when the run recorded no content binding. */
  readonly bindingDigest: string | null
  readonly providerRegistryRevision: string | null
  readonly templatesRoot: string | null
  readonly preset: string | null
}

/** The business input the run worked from. */
export interface ReceiptInputFacts {
  readonly workspacePath: string | null
  readonly snapshotPath: string | null
  readonly snapshotDigest: string | null
}

/** The terminal review the receipt rests on, or the explicit statement that the store holds none. */
export interface ReceiptReviewFacts {
  /** `<taskId>#<runId>`, or `null` when the store holds no review for this run. */
  readonly reviewRef: string | null
  readonly criteria: readonly ReviewCriterion[]
  readonly criteriaDigest: string
  readonly evidenceRefs: readonly string[]
  readonly anomalies: readonly string[]
  /** The submitting worker's own account, contrasted with what the store backs. `null` when the run submitted nothing. */
  readonly claims: {
    readonly submitted: readonly string[]
    readonly backed: readonly string[]
    readonly unbacked: readonly string[]
  } | null
}

/** One fact a receipt could not establish. */
export type ReceiptMissingFact =
  | 'session-log'
  | 'model-requests'
  | 'template-consumption'
  | 'subtree-usage'
  | 'drain'
  | 'review'

/** Whether a receipt established every fact it is made of, and what it could not. */
export interface ReceiptCompleteness {
  readonly status: 'complete' | 'incomplete'
  readonly missing: readonly { readonly fact: ReceiptMissingFact; readonly detail: string }[]
}

/**
 * One Run's execution receipt. It is a runtime-produced record: the store
 * refuses any receipt that disagrees with its own records, and no tool, service
 * method or event parameter accepts one from a caller.
 */
export interface ExecutionReceipt {
  readonly formatVersion: 1
  readonly runId: RunId
  readonly taskId: TaskId
  readonly storeId: string
  readonly sessionId?: string
  readonly parentRunId?: RunId
  /** The store's own terminal status for this run, copied — not a caller's statement. */
  readonly outcome: RunStatus
  readonly contract: ReceiptContractFacts
  readonly environment: ReceiptEnvironmentFacts
  readonly input: ReceiptInputFacts
  readonly review: ReceiptReviewFacts
  readonly modelUse: readonly ReceiptRunModelUse[]
  readonly skills: readonly ReceiptSkillUse[]
  readonly templates: readonly ReceiptTemplateUse[]
  /** The execution subtree frozen at sealing time: this run first, then every descendant, in store order. */
  readonly subtree: readonly RunId[]
  readonly drain: 'in-process' | 'reconciled' | 'unconfirmed'
  readonly completeness: ReceiptCompleteness
  readonly sealedAt: string
  /** `sha256(canonicalize(receipt without this field))`. */
  readonly digest: string
}

/** The canonical digest of one criterion set — the same function the sealer and the store check use. */
export function criteriaDigestOf(criteria: readonly ReviewCriterion[]): string {
  return sha256Hex(canonicalize(criteria))
}

/** The canonical digest of one evidence reference list. */
export function evidenceDigestOf(refs: readonly string[]): string {
  return sha256Hex(canonicalize(refs))
}

/** The content digest of one receipt, over its canonical form without the digest field. */
export function executionReceiptDigest(receipt: ExecutionReceipt): string {
  const { digest: _dropped, ...rest } = receipt
  return sha256Hex(canonicalize(rest))
}

/** One run's receipt, or `undefined` when the store holds none. */
export function receiptOf(snapshot: TaskSnapshot, runId: RunId): ExecutionReceipt | undefined {
  return snapshot.receipts?.find(receipt => receipt.runId === runId)
}

/** Every receipt of one task's runs, in store order. */
export function receiptsOfTask(snapshot: TaskSnapshot, taskId: TaskId): readonly ExecutionReceipt[] {
  return (snapshot.receipts ?? []).filter(receipt => receipt.taskId === taskId)
}

/** One task-template reference as a receipt records it. */
export type ReceiptTemplateRef = TaskTemplateRef
/** The parameters one consumed template was instantiated with. */
export type ReceiptTemplateParameters = TemplateParameters
