/** The normalized task contract: one data definition every creation entry adapts to, plus admission limits and content identities. @module @dangosys/dsh-singularity-task/contract */

import { createHash } from 'node:crypto'
import type { AcceptanceCriterion } from './types.ts'
import type { TaskTemplateRef, TemplateParameters, TemplateScope } from './template.ts'

/** The normalized contract version this build writes. Separate from a task template's own generation number and from the event envelope's `schemaVersion` (the store's wire format): this one versions the contract data definition, and an entry … */
export const TASK_CONTRACT_VERSION = 1 as const

/** Every version of {@link TaskContract} this build can write or read. */
export type TaskContractVersion = typeof TASK_CONTRACT_VERSION

/** One task's contract, in normalized form: defaults already filled, criterion ids already fixed, every array present. */
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
  /** Immutable provenance of a template instance; omitted for a free contract. */
  templateRef?: TaskTemplateRef
  templateParameters?: TemplateParameters
  templateScope?: TemplateScope
}

/** The limits one decomposition batch was admitted under (§4). Recorded with the batch, never derived from the contract: a contract's own text has no field that can raise a limit, and the runtime resolves every value here from its … */
export interface AdmissionContext {
  /** Growth guardrail enforced at admission: a batch reaching depth `maxDepth + 1` is refused before anything is persisted. */
  maxDepth: number
  /** Growth guardrail enforced at admission: a batch above `maxChildren` is refused before anything is persisted. */
  maxChildren: number
  /** Effective values that are only audited after a run settled — never enforced in flight (the orchestrator can observe tool calls and tokens only once the session log is readable). */
  auditOnly: {
    maxToolCalls?: number
    tokens?: number
    attempts?: number
  }
}

/** The identity of one admitted batch, recorded on the parent's decomposition event: what the batch asked for (digest) and the limits it was admitted under (context). */
export interface DecompositionAdmission {
  /** {@link decompositionDigest} of the normalized batch. */
  proposalDigest: string
  context: AdmissionContext
}

/** One child of a decomposition proposal, reduced to what its identity covers. */
interface DecompositionChildIdentity {
  /** {@link contractDigest} of the child's normalized contract. */
  contractDigest: string
  /** Sibling indices (0-based, in batch order) this child's run waits for; order is insignificant to execution but part of the digest. */
  dependsOn: readonly number[]
  /** Whether the child may split further; a declaration, not a permission (admission still applies every guardrail). */
  decomposable: boolean
  /** Whether the child demands independent parent acceptance (P4 marker). */
  requiresIndependentAcceptance: boolean
}

/** Everything a batch proposal's identity covers (§4): where it came from (store, parent task and run, caller), which contract language it is written in, why it was proposed, and the complete ordered children. */
export interface DecompositionIdentity {
  contractVersion: TaskContractVersion
  templateRef?: TaskTemplateRef
  templateParameters?: TemplateParameters
  storeId: string
  parentTaskId: string
  parentRunId: string
  callerSessionId: string
  reason: string
  children: readonly DecompositionChildIdentity[]
}

/** Object keys whose value is not `undefined`: the rule canonical identities and logged events share. */
export function definedKeys(source: Record<string, unknown>): string[] {
  return Object.keys(source).filter(key => source[key] !== undefined)
}

/** Stable serialization of contract data: object keys sorted, arrays kept in order, strings byte-for-byte, `undefined`-valued keys dropped. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`task: cannot canonicalize ${String(value)}: contract data must be finite JSON`)
      }
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new Error(`task: cannot canonicalize a ${typeof value}: contract data must be JSON`)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `task: cannot canonicalize a ${value.constructor?.name ?? 'non-plain object'}: contract data must be plain JSON`,
    )
  }
  const source = value as Record<string, unknown>
  const keys = definedKeys(source).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(source[key])}`).join(',')}}`
}

function sha256(text: string): string {
  return sha256Hex(text)
}

/** SHA-256 (lowercase hex) of raw bytes: the digest form a protected acceptance input's identity is fixed with ({@link ProtectedInputRef}), shared by the admission-time fixing and the pre-judgement re-check. */
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

/** Persist the final contract identity and its actual source on every production instance. */
export function taskContractIdentity(contract: TaskContract) {
  const digest = contractDigest(contract)
  return {
    contractDigest: digest,
    definitionRef: contract.templateRef === undefined
      ? { taskType: `contract:${digest}`, version: contract.contractVersion, digest }
      : { taskType: contract.templateRef.id, version: contract.templateRef.version, digest: contract.templateRef.digest },
    ...(contract.templateRef === undefined ? {} : {
      templateRef: structuredClone(contract.templateRef),
      templateParameters: structuredClone(contract.templateParameters ?? {}),
    }),
  }
}
