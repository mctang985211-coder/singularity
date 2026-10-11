/**
 * The Task contract: what makes a task adjudicable.
 *
 * - **Shape** is pure. It closes the member set, requires a goal, requires at least one criterion,
 *   and refuses a duplicate or empty criterion. A reducer may call it, because it depends on
 *   nothing outside the fact.
 * - **Availability** is a check about *now*. Whether this deployment can currently run the
 *   verifier a criterion names says nothing about a fact recorded last month, so it belongs to
 *   the command that produces a new fact — never to the fold that explains an old one.
 *
 * recorded contract keeps its own content identity; the criterion's verifier ref and version are
 * part of that identity, not a lookup.
 *
 * @module singularity-core/task/contract
 */

import { assertClosedKeys, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { MemberSet } from '../protocol/registry.ts'

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
  /**
   * The **content digest of the implementation itself** — its code and its pinned toolchain, as
   * the deployment computed it. A ref and a version are names a deployment can re-point; a digest
   * is the only thing that makes "the implementation that judged this" checkable after the fact.
   */
  readonly implementationDigest: string
}

/** The loaded task template's content identity. */
export interface TaskTemplateRef {
  readonly id: string
  readonly digest: string
}

export type TaskInputSource =
  | { readonly kind: 'protected'; readonly ref: string; readonly digest: string }
  | { readonly kind: 'artifact'; readonly taskId: string }

interface TaskInput {
  readonly name: string
  readonly source: TaskInputSource
}

/** Fixed at admission; a later contract is a different task. */
export interface TaskContract {
  readonly goal: string
  readonly template: TaskTemplateRef
  /** Fixed sources; an upstream artifact's bytes are bound when a Run opens its Bubble. */
  readonly inputs: readonly TaskInput[]
  /** At least one criterion, each bound to a verifier implementation. */
  readonly criteria: readonly AcceptanceCriterion[]
}

export const CONTRACT_MEMBERS = ['goal', 'template', 'inputs', 'criteria'] as const
export const CRITERION_MEMBERS = ['criterionId', 'statement', 'verifierRef', 'verifierVersion', 'implementationDigest'] as const

/** A sha256 hex content digest: the only form this stack accepts as a content identity. */
const DIGEST = /^[0-9a-f]{64}$/

/**
 * The verifier implementations this deployment can currently run.
 *
 * The digest is part of the question, not decoration: "can I run `command@1`" is answerable by a
 * deployment that swapped the implementation behind that name, which is exactly the hole this
 * closes.
 */
export interface VerifierRegistry {
  has(verifierRef: string, verifierVersion: string, implementationDigest: string): boolean
}

/** Which verifiers are currently runnable, from `id@version#implementationDigest` entries. */
export function verifierRegistryOf(entries: readonly string[]): VerifierRegistry {
  const known = new Set(entries)
  return {
    has: (verifierRef, verifierVersion, implementationDigest) =>
      known.has(`${verifierRef}@${verifierVersion}#${implementationDigest}`),
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-contract', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireText(value, field)
  if (!DIGEST.test(digest)) refuse('malformed-contract', `${field} must be a sha256 hex content digest, got ${JSON.stringify(digest)}`)
  return digest
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-contract', `${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`)
  return value as Record<string, unknown>
}

function taskInputs(raw: unknown, field: string): readonly TaskInput[] {
  if (!Array.isArray(raw)) refuse('malformed-contract', `${field} must be an array of named input sources`)
  const names = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${field}[${index}]`
    const input = requireRecord(entry, at)
    assertClosedKeys(input, ['name', 'source'], at, 'malformed-contract')
    const name = requireText(input['name'], `${at}.name`)
    if (names.has(name)) refuse('malformed-contract', `${field} names input ${JSON.stringify(name)} twice`)
    names.add(name)
    const source = requireRecord(input['source'], `${at}.source`)
    const kind = requireText(source['kind'], `${at}.source.kind`)
    if (kind === 'protected') {
      assertClosedKeys(source, ['kind', 'ref', 'digest'], `${at}.source`, 'malformed-contract')
      return { name, source: { kind, ref: requireText(source['ref'], `${at}.source.ref`), digest: requireDigest(source['digest'], `${at}.source.digest`) } }
    }
    if (kind === 'artifact') {
      assertClosedKeys(source, ['kind', 'taskId'], `${at}.source`, 'malformed-contract')
      return { name, source: { kind, taskId: requireText(source['taskId'], `${at}.source.taskId`) } }
    }
    refuse('malformed-contract', `${at}.source.kind must be protected or artifact, got ${JSON.stringify(kind)}`)
  })
}

/** Pure shape; the caller supplies the declaring kind's closed member set. */
export function assertCriterionShape(raw: unknown, field: string, members: MemberSet): AcceptanceCriterion {
  const record = requireRecord(raw, field)
  assertClosedKeys(record, members, field, 'malformed-contract')
  return {
    criterionId: requireText(record['criterionId'], `${field}.criterionId`),
    statement: requireText(record['statement'], `${field}.statement`),
    verifierRef: requireText(record['verifierRef'], `${field}.verifierRef`),
    verifierVersion: requireText(record['verifierVersion'], `${field}.verifierVersion`),
    implementationDigest: requireDigest(record['implementationDigest'], `${field}.implementationDigest`),
  }
}

/**
 * One closed list of criteria with unique ids, read by the criterion reader above.
 *
 * Beside `assertCriterionShape` because it is the same rule over a list: a criterion id is stable and
 * unique, so a repeat is refused rather than merged — two entries under one id are two claims about
 * one criterion, and no reader could tell them apart afterwards.
 */
export function criterionList(raw: unknown, where: string, members: MemberSet): readonly AcceptanceCriterion[] {
  if (!Array.isArray(raw)) refuse('malformed-contract', `${where} must be an array of acceptance criteria, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const criterion = assertCriterionShape(entry, `${where}[${index}]`, members)
    if (seen.has(criterion.criterionId)) refuse('malformed-contract', `${where} declares "${criterion.criterionId}" twice; a criterion id is stable and unique`)
    seen.add(criterion.criterionId)
    return criterion
  })
}

/**
 * Read one contract's closed shape. Pure, so a reducer may call it while replaying a log whose
 * verifiers are long gone.
 *
 * The closed set is required for the same reason as the criterion reader's: `task/admitted` declares
 * `nested.contract`, hands it here, and that entry is what closes the contract. A shape *inside* it —
 * each `criteria[]` entry — belongs to the reader above, and is closed with the criterion declaration
 * this function names rather than with a set of its own.
 */
export function assertContractShape(raw: unknown, field: string, members: MemberSet): TaskContract {
  const record = requireRecord(raw, field)
  assertClosedKeys(record, members, field, 'malformed-contract')

  const goal = requireText(record['goal'], `${field}.goal`)

  const declaredTemplate = requireRecord(record['template'], `${field}.template`)
  assertClosedKeys(declaredTemplate, ['id', 'digest'], `${field}.template`, 'malformed-contract')
  const template = { id: requireText(declaredTemplate['id'], `${field}.template.id`), digest: requireDigest(declaredTemplate['digest'], `${field}.template.digest`) }
  const inputs = taskInputs(record['inputs'], `${field}.inputs`)

  const rawCriteria = record['criteria']
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0)
    refuse('malformed-contract', `${field}.criteria must name at least one acceptance criterion; nothing would decide the task`)

  const criteria = criterionList(rawCriteria, `${field}.criteria`, CRITERION_MEMBERS)

  return { goal, template, inputs, criteria }
}

/**
 * Read one contract that is being **admitted now**: the shape, plus the requirement that every
 * criterion names a verifier this deployment can currently run. A criterion nobody can decide
 * today is not an acceptance condition for a task starting today.
 */
export function assertContract(raw: unknown, field: string, verifiers: VerifierRegistry): TaskContract {
  const contract = assertContractShape(raw, field, CONTRACT_MEMBERS)
  for (const [index, criterion] of contract.criteria.entries()) {
    if (!verifiers.has(criterion.verifierRef, criterion.verifierVersion, criterion.implementationDigest))
      refuse(
        'unregistered-verifier',
        `${field}.criteria[${index}] names verifier "${criterion.verifierRef}@${criterion.verifierVersion}" implemented by ${
          criterion.implementationDigest.slice(0, 12)
        }…, which this deployment cannot currently run`,
      )
  }
  return contract
}

/** The contract's content identity: what a receipt cites so its acceptance cannot be redefined later. */
export function contractDigest(contract: TaskContract): string {
  return digestOf(contract)
}
