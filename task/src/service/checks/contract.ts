/** Contract and admission-limit shape checks. @module @dangosys/dsh-singularity-task/service/checks/contract */

import { TASK_CONTRACT_VERSION, canonicalize, type DecompositionAdmission, type TaskContract } from '../../contract.ts'
import type { TaskId, TaskInstance } from '../../types.ts'
import { isRecord } from './primitives.ts'

/** A task's contract is either absent — a task created before the contract existed — or the single source its projection fields are generated from. */
export function assertContract(taskId: TaskId, contract: TaskContract, task: TaskInstance): void {
  assertContractFields(`task "${taskId}"`, contract)
  if (task.objective !== contract.objective) {
    throw new Error(`task: task "${taskId}" objective disagrees with its contract objective`)
  }
  if (canonicalize(task.acceptanceCriteria) !== canonicalize(contract.acceptanceCriteria)) {
    throw new Error(`task: task "${taskId}" acceptance criteria disagree with its contract`)
  }
  if (canonicalize(task.requestedCapabilities) !== canonicalize(contract.requiredCapabilities)) {
    throw new Error(`task: task "${taskId}" requested capabilities disagree with its contract`)
  }
}

/** The contract fields one normalized contract must carry, checked the same way wherever a contract is stored — on a task (T1) and on each child of a proposal's batch (T2). */
export function assertContractFields(where: string, contract: TaskContract): void {
  if (contract.contractVersion !== TASK_CONTRACT_VERSION) {
    throw new Error(
      `task: ${where} declares contract version ${String(contract.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`,
    )
  }
  const lists: ReadonlyArray<readonly [string, unknown]> = [
    ['assumptions', contract.assumptions],
    ['constraints', contract.constraints],
    ['requiredCapabilities', contract.requiredCapabilities],
  ]
  for (const [name, value] of lists) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new Error(`task: ${where} contract ${name} must be an array of strings`)
    }
  }
  if (typeof contract.objective !== 'string') {
    throw new Error(`task: ${where} contract objective must be a string`)
  }
}

/** The batch record a decomposition carries is the identity a later review gate binds an approval to, so a malformed one is refused rather than stored: an empty proposal digest or a non-numeric limit would make the record unusable exactly … */
export function assertAdmission(taskId: TaskId, admission: DecompositionAdmission): void {
  if (typeof admission.proposalDigest !== 'string' || admission.proposalDigest.length === 0) {
    throw new Error(`task: task "${taskId}" decomposition admission requires a proposal digest`)
  }
  const context = admission.context
  if (!isRecord(context)) {
    throw new Error(`task: task "${taskId}" decomposition admission requires an admission context`)
  }
  assertAdmissionLimits(`task "${taskId}" admission context`, context)
}

/** The limits one admission context carries, checked the same way wherever one is stored — on a decomposition (T1) and on a proposal (T2: the limits the batch was submitted under, whose fingerprint an approval binds). */
export function assertAdmissionLimits(where: string, context: Record<string, unknown>): void {
  for (const [name, value] of [
    ['maxDepth', context.maxDepth],
    ['maxChildren', context.maxChildren],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`task: ${where} ${name} must be a non-negative integer`)
    }
  }
  const auditOnly: unknown = context.auditOnly
  if (!isRecord(auditOnly)) {
    throw new Error(`task: ${where} auditOnly must be an object`)
  }
  const limits: ReadonlyArray<readonly [string, unknown]> = [
    ['auditOnly.maxToolCalls', auditOnly.maxToolCalls],
    ['auditOnly.tokens', auditOnly.tokens],
    ['auditOnly.attempts', auditOnly.attempts],
  ]
  for (const [name, value] of limits) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`task: ${where} ${name} must be a finite number when present`)
    }
  }
}
