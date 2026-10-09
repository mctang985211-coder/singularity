/**
 * The Task contract: what makes a task adjudicable.
 *
 * A contract is not a wish list. Every acceptance criterion must name **which registered
 * verifier** decides it, at which version, because a criterion nobody can adjudicate is not an
 * acceptance condition. A contract with no criteria is refused for the same reason: nothing
 * would decide it.
 *
 * @module singularity-core/task/contract
 */

import { digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'

/** One acceptance criterion, bound to the verifier that decides it. */
export interface AcceptanceCriterion {
  /** Stable within the contract; the id every verdict refers to. */
  readonly criterionId: string
  /** What is being accepted, in one sentence a verifier can decide. */
  readonly statement: string
  /** The registered verifier that decides it. */
  readonly verifierRef: string
  /** The verifier's version, so a later registration change cannot silently redefine this criterion. */
  readonly verifierVersion: string
}

/** What the task is for. Fixed at admission; a later contract is a different task. */
export interface TaskContract {
  readonly goal: string
  /** Inputs the work is done against, as recorded references. */
  readonly inputs: readonly string[]
  /** At least one criterion, each bound to a registered verifier. */
  readonly criteria: readonly AcceptanceCriterion[]
}

/** The verifiers this deployment has registered, and at which versions. */
export interface VerifierRegistry {
  has(verifierRef: string, verifierVersion: string): boolean
}

/** Which verifiers are registered, from a plain list of `id@version` entries. */
export function verifierRegistryOf(entries: readonly string[]): VerifierRegistry {
  const known = new Set(entries)
  return { has: (verifierRef, verifierVersion) => known.has(`${verifierRef}@${verifierVersion}`) }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-contract', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

/**
 * Read one contract at the protocol boundary.
 *
 * Refuses a missing goal, an empty criterion list, a duplicate criterion id, a criterion with
 * no statement, and a criterion whose verifier is not registered at the version it names.
 */
export function assertContract(raw: unknown, field: string, verifiers: VerifierRegistry): TaskContract {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    refuse('malformed-contract', `${field} must be a contract object, got ${raw === null ? 'null' : typeof raw}`)
  const record = raw as Record<string, unknown>

  const goal = requireText(record['goal'], `${field}.goal`)

  const rawInputs = record['inputs']
  if (rawInputs !== undefined && !Array.isArray(rawInputs))
    refuse('malformed-contract', `${field}.inputs must be an array of recorded references`)
  const inputs = ((rawInputs as unknown[] | undefined) ?? []).map((entry, index) =>
    requireText(entry, `${field}.inputs[${index}]`),
  )

  const rawCriteria = record['criteria']
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0)
    refuse('malformed-contract', `${field}.criteria must name at least one acceptance criterion; nothing would decide the task`)

  const criteria: AcceptanceCriterion[] = []
  const seen = new Set<string>()
  for (const [index, entry] of rawCriteria.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      refuse('malformed-contract', `${field}.criteria[${index}] must be an object`)
    const criterion = entry as Record<string, unknown>
    const criterionId = requireText(criterion['criterionId'], `${field}.criteria[${index}].criterionId`)
    if (seen.has(criterionId))
      refuse('malformed-contract', `${field}.criteria declares "${criterionId}" twice; a criterion id is stable and unique`)
    seen.add(criterionId)
    const verifierRef = requireText(criterion['verifierRef'], `${field}.criteria[${index}].verifierRef`)
    const verifierVersion = requireText(criterion['verifierVersion'], `${field}.criteria[${index}].verifierVersion`)
    if (!verifiers.has(verifierRef, verifierVersion))
      refuse(
        'unregistered-verifier',
        `${field}.criteria[${index}] names verifier "${verifierRef}@${verifierVersion}", which this deployment has not registered; a criterion nobody can adjudicate is not an acceptance condition`,
      )
    criteria.push({
      criterionId,
      statement: requireText(criterion['statement'], `${field}.criteria[${index}].statement`),
      verifierRef,
      verifierVersion,
    })
  }

  return { goal, inputs, criteria }
}

/** The contract's content identity: what a receipt cites so its acceptance cannot be redefined later. */
export function contractDigest(contract: TaskContract): string {
  return digestOf(contract)
}
