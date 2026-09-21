/**
 * The normalized task contract (construction guide §4): the one data
 * definition every creation entry adapts its input to before anything is
 * persisted, the admission context a batch was admitted under, and the two
 * content identities a task creation carries.
 *
 * Why one definition: the model-facing tool, the runtime's own creation paths
 * (root task, decomposition children, replay) and the store must agree on what
 * a task contract *is* — a field only one of them understands is a field
 * nobody can promise anything about. The shapes here are therefore the closed
 * set of contract facts; entries that accept model input reject what is not in
 * it instead of dropping it silently.
 *
 * Identities are content identities, deliberately separate (§4): the
 * single-task contract digest and the whole-batch proposal digest describe
 * *what was asked for*, while {@link AdmissionContext} records the limits in
 * force when it was admitted. Mutable deployment state (capability table
 * revisions, verifier versions) belongs to the context, never to the content
 * digest, so re-running a proposal whose contract did not change keeps its
 * identity. The context's own fingerprint is the review gate's business (T2),
 * not this module's.
 *
 * What the identities cover and what they deliberately leave out: ids minted
 * at admission (`t-…`, `r-…`, session ids of the runs) are *not* in either
 * digest — the same proposal retried against the same parent must keep one
 * identity, and random ids would make every retry a different operation.
 * Criterion ids are the exception the other way round: they are normalized
 * (explicitly declared, or generated from batch position) *before* hashing, so
 * two spellings of "the same criteria" cannot produce two identities.
 * @module @dangosys/dsh-singularity-task/contract
 */

import { createHash } from 'node:crypto'
import type { AcceptanceCriterion } from './types.ts'

/**
 * The normalized contract version this build writes. Separate from a
 * `TaskDefinition.version` (a template's own generation) and from the event
 * envelope's `schemaVersion` (the store's wire format): this one versions the
 * contract data definition, and an entry that declares a version this build
 * does not know is refused rather than read with the wrong field semantics.
 */
export const TASK_CONTRACT_VERSION = 1 as const

/** Every version of {@link TaskContract} this build can write or read. */
export type TaskContractVersion = typeof TASK_CONTRACT_VERSION

/**
 * One task's contract, in normalized form: defaults already filled, criterion
 * ids already fixed, every array present. A stored task's contract is
 * immutable — a revision is a new task, never an edit — which is why the store
 * can carry it verbatim and why the projection fields on `TaskInstance`
 * (`objective`, `acceptanceCriteria`, `requestedCapabilities`) are generated
 * from it and checked for disagreement on write.
 *
 * `assumptions` and `constraints` are persisted here instead of living only in
 * the spawn prompt: a worker handoff renders them, a reader of the store can
 * quote them later, and neither is allowed to drift from what the task was
 * admitted with. Text is stored verbatim (no trimming, no newline rewriting) —
 * non-blank validation happens on the entry, byte identity in the digest.
 */
export interface TaskContract {
  contractVersion: TaskContractVersion
  /** The self-contained goal/deliverable, verbatim. */
  objective: string
  /** At least one criterion, at least one of them mandatory; ids unique within the task. */
  acceptanceCriteria: AcceptanceCriterion[]
  /** External conditions the contract rests on; `[]` when none were declared. */
  assumptions: string[]
  /** Execution scope and limits in the caller's words; `[]` when none were declared. */
  constraints: string[]
  /** Capability *requirements* by name (never a skill id): the runtime resolves these against its registry. */
  requiredCapabilities: string[]
}

/**
 * The limits one decomposition batch was admitted under (§4). Recorded with
 * the batch, never derived from the contract: a contract's own text has no
 * field that can raise a limit, and the runtime resolves every value here from
 * its configuration at admission time. The split between enforced and audited
 * values is the point of the record — a reader must be able to tell which
 * ceiling would actually have stopped the run.
 */
export interface AdmissionContext {
  /** Growth guardrail enforced at admission: a batch reaching depth `maxDepth + 1` is refused before anything is persisted. */
  maxDepth: number
  /** Growth guardrail enforced at admission: a batch above `maxChildren` is refused before anything is persisted. */
  maxChildren: number
  /** Enforced in flight: each run of the batch races this wall-clock deadline and settles failed naming the budget when it expires. Absent when the deployment configures none. */
  wallTimeMs?: number
  /**
   * Effective values that are only audited after a run settled — never
   * enforced in flight (the orchestrator can observe tool calls and tokens
   * only once the session log is readable). Recorded so a later gate sees what
   * the batch ran under instead of re-deriving it from a config that may have
   * moved on.
   */
  auditOnly: {
    maxToolCalls?: number
    tokens?: number
    attempts?: number
  }
}

/**
 * The identity of one admitted batch, recorded on the parent's decomposition
 * event: what the batch asked for (digest) and the limits it was admitted
 * under (context). T2's review gate binds an approval to exactly this pair;
 * nothing in T1 acts on it beyond writing it down truthfully.
 */
export interface DecompositionAdmission {
  /** {@link decompositionDigest} of the normalized batch. */
  proposalDigest: string
  context: AdmissionContext
}

/** One child of a decomposition proposal, reduced to what its identity covers. */
export interface DecompositionChildIdentity {
  /** {@link contractDigest} of the child's normalized contract. */
  contractDigest: string
  /** Sibling indices (0-based, in batch order) this child's run waits for; order is insignificant to execution but part of the digest. */
  dependsOn: readonly number[]
  /** Whether the child may split further; a declaration, not a permission (admission still applies every guardrail). */
  decomposable: boolean
  /** Whether the child demands independent parent acceptance (P4 marker). */
  requiresIndependentAcceptance: boolean
}

/**
 * Everything a batch proposal's identity covers (§4): where it came from
 * (store, parent task and run, caller), which contract language it is written
 * in, why it was proposed, and the complete ordered children. The caller's
 * `reason` is inside the digest on purpose — two batches with identical
 * contracts but different reasons are different proposals.
 */
export interface DecompositionIdentity {
  contractVersion: TaskContractVersion
  storeId: string
  parentTaskId: string
  parentRunId: string
  callerSessionId: string
  reason: string
  children: readonly DecompositionChildIdentity[]
}

/**
 * Stable serialization of contract data: object keys sorted, arrays kept in
 * order, strings byte-for-byte, `undefined`-valued keys dropped (the session
 * log drops them too, so the digest describes what is actually persisted).
 *
 * Two spellings of the same data must serialize identically — that is what
 * makes key order irrelevant to an identity. Values the session log cannot
 * round-trip (functions, symbols, `NaN`, `Infinity`, `bigint`) are refused
 * loudly: a digest over such a value would compare equal to a digest of a
 * different value that happened to stringify the same way.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`task: cannot canonicalize ${String(value)}: contract data must be finite JSON`)
      }
      return JSON.stringify(value)
    case 'object': break
    default:
      throw new Error(`task: cannot canonicalize a ${typeof value}: contract data must be JSON`)
  }
  if (Array.isArray(value)) {
    // A hole stringifies as `null` in JSON, so the canonical form uses `null`
    // too — otherwise `[undefined]` and `[null]` would be different identities
    // for the same persisted bytes.
    return `[${value.map(item => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`task: cannot canonicalize a ${value.constructor?.name ?? 'non-plain object'}: contract data must be plain JSON`)
  }
  const source = value as Record<string, unknown>
  const keys = Object.keys(source).filter(key => source[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(source[key])}`).join(',')}}`
}

function sha256(text: string): string {
  return sha256Hex(text)
}

/**
 * SHA-256 (lowercase hex) of raw bytes: the digest form a protected
 * acceptance input's identity is fixed with ({@link ProtectedInputRef}),
 * shared by the admission-time fixing and the pre-judgement re-check.
 */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The single-task contract identity: SHA-256 over {@link canonicalize} of the normalized contract. */
export function contractDigest(contract: TaskContract): string {
  return sha256(canonicalize(contract))
}

/** The whole-batch proposal identity: SHA-256 over {@link canonicalize} of the normalized proposal. */
export function decompositionDigest(identity: DecompositionIdentity): string {
  return sha256(canonicalize(identity))
}
