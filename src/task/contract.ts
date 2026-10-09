/**
 * The Task contract: what makes a task adjudicable.
 *
 * Two checks that used to be one, and the split is the point:
 *
 * - **Shape** is pure. It closes the member set, requires a goal, requires at least one criterion,
 *   and refuses a duplicate or empty criterion. A reducer may call it, because it depends on
 *   nothing outside the fact.
 * - **Availability** is a check about *now*. Whether this deployment can currently run the
 *   verifier a criterion names says nothing about a fact recorded last month, so it belongs to
 *   the command that produces a new fact — never to the fold that explains an old one.
 *
 * Mixing the two is what made a legal log unreadable once a verifier was unregistered. The
 * recorded contract keeps its own content identity; the criterion's verifier ref and version are
 * part of that identity, not a lookup.
 *
 * @module singularity-core/task/contract
 */

import { assertClosedKeys, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'

/** One acceptance criterion, bound to the verifier implementation that decides it. */
export interface AcceptanceCriterion {
  /** Stable within the contract; the id every verdict refers to. */
  readonly criterionId: string
  /** What is being accepted, in one sentence a verifier can decide. */
  readonly statement: string
  /** The verifier implementation that decides it. */
  readonly verifierRef: string
  /** That implementation's version, so re-registering it cannot silently redefine this criterion. */
  readonly verifierVersion: string
}

/** What the task is for. Fixed at admission; a later contract is a different task. */
export interface TaskContract {
  readonly goal: string
  /** Inputs the work is done against, as recorded references. Explicit, never defaulted. */
  readonly inputs: readonly string[]
  /** At least one criterion, each bound to a verifier implementation. */
  readonly criteria: readonly AcceptanceCriterion[]
}

export const CONTRACT_MEMBERS = ['goal', 'inputs', 'criteria'] as const
export const CRITERION_MEMBERS = ['criterionId', 'statement', 'verifierRef', 'verifierVersion'] as const

/** The verifier implementations this deployment can currently run. */
export interface VerifierRegistry {
  has(verifierRef: string, verifierVersion: string): boolean
}

/** Which verifiers are currently runnable, from a plain list of `id@version` entries. */
export function verifierRegistryOf(entries: readonly string[]): VerifierRegistry {
  const known = new Set(entries)
  return { has: (verifierRef, verifierVersion) => known.has(`${verifierRef}@${verifierVersion}`) }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-contract', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-contract', `${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`)
  return value as Record<string, unknown>
}

/**
 * Read one criterion's closed shape. Pure: it depends on nothing but the value.
 */
export function assertCriterionShape(raw: unknown, field: string): AcceptanceCriterion {
  const record = requireRecord(raw, field)
  assertClosedKeys(record, CRITERION_MEMBERS, field, 'malformed-contract')
  return {
    criterionId: requireText(record['criterionId'], `${field}.criterionId`),
    statement: requireText(record['statement'], `${field}.statement`),
    verifierRef: requireText(record['verifierRef'], `${field}.verifierRef`),
    verifierVersion: requireText(record['verifierVersion'], `${field}.verifierVersion`),
  }
}

/**
 * Read one contract's closed shape. Pure, so a reducer may call it while replaying a log whose
 * verifiers are long gone.
 */
export function assertContractShape(raw: unknown, field: string): TaskContract {
  const record = requireRecord(raw, field)
  assertClosedKeys(record, CONTRACT_MEMBERS, field, 'malformed-contract')

  const goal = requireText(record['goal'], `${field}.goal`)

  const rawInputs = record['inputs']
  if (!Array.isArray(rawInputs)) refuse('malformed-contract', `${field}.inputs must be an array of recorded references`)
  const inputs = rawInputs.map((entry, index) => requireText(entry, `${field}.inputs[${index}]`))

  const rawCriteria = record['criteria']
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0)
    refuse('malformed-contract', `${field}.criteria must name at least one acceptance criterion; nothing would decide the task`)

  const criteria: AcceptanceCriterion[] = []
  const seen = new Set<string>()
  for (const [index, entry] of rawCriteria.entries()) {
    const criterion = assertCriterionShape(entry, `${field}.criteria[${index}]`)
    if (seen.has(criterion.criterionId))
      refuse('malformed-contract', `${field}.criteria declares "${criterion.criterionId}" twice; a criterion id is stable and unique`)
    seen.add(criterion.criterionId)
    criteria.push(criterion)
  }

  return { goal, inputs, criteria }
}

/**
 * Read one contract that is being **admitted now**: the shape, plus the requirement that every
 * criterion names a verifier this deployment can currently run. A criterion nobody can decide
 * today is not an acceptance condition for a task starting today.
 */
export function assertContract(raw: unknown, field: string, verifiers: VerifierRegistry): TaskContract {
  const contract = assertContractShape(raw, field)
  for (const [index, criterion] of contract.criteria.entries()) {
    if (!verifiers.has(criterion.verifierRef, criterion.verifierVersion))
      refuse(
        'unregistered-verifier',
        `${field}.criteria[${index}] names verifier "${criterion.verifierRef}@${criterion.verifierVersion}", which this deployment cannot currently run`,
      )
  }
  return contract
}

/** The contract's content identity: what a receipt cites so its acceptance cannot be redefined later. */
export function contractDigest(contract: TaskContract): string {
  return digestOf(contract)
}
