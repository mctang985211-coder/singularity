/**
 * The task protocol's shared shape readers.
 *
 * Extracted so the protocol stays inside the file budget, and so the decomposition and bubble
 * rules that land beside it read a payload exactly the way the original five kinds do. Every
 * reader refuses by name; none normalizes, defaults or repairs.
 *
 * The type-only imports point back at `protocol.ts`, so at run time the dependency runs one way.
 *
 * @module singularity-core/task/shape
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { TaskContract } from './contract.ts'
import type { RevisionRef, RunState, RunStatus, TaskState } from './protocol.ts'

const DIGEST = /^[0-9a-f]{64}$/
export function record(raw: unknown, where: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    refuse('malformed-payload', `${where} must be an object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}`)
  return raw as Record<string, unknown>
}

export function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-payload', `${where}.${key} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

/** An optional member: absent stays absent; present-but-wrong is refused rather than normalized. */
export function maybeText(source: Record<string, unknown>, key: string, where: string): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined
  return text(source, key, where)
}

export function digest(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where)
  if (!DIGEST.test(value))
    refuse('malformed-payload', `${where}.${key} must be a sha256 hex content digest, got ${JSON.stringify(value)}`)
  return value
}

/**
 * The revision pin, read once for every slice that carries one.
 *
 * `task`, `measure` and `strategy` all name the revision a fact is about, and each declared its own
 * copy of the set until the fifth round made a member set a value: three copies of one shape is three
 * places a fourth member could appear in one and not the others. The digest is part of it because an
 * id alone can be re-pointed.
 *
 * The set is required rather than defaulted to `REVISION_MEMBERS`, for the reason the other shape
 * readers lost their defaults: the default *was* the declaration, so a caller that dropped the
 * argument closed the pin with the same set it would have named and no check could tell the two
 * apart. Every caller names the declaration it means, and `plan.ts`'s incumbent names the same one.
 */
export const REVISION_MEMBERS = ['environmentId', 'revisionId', 'digest'] as const

export function revisionRef(raw: unknown, where: string, members: readonly string[]): RevisionRef {
  const source = record(raw, where)
  assertClosedKeys(source, members, where)
  return { environmentId: text(source, 'environmentId', where), revisionId: text(source, 'revisionId', where), digest: digest(source, 'digest', where) }
}

/**
 * Two revision references name the same content. An id alone is not enough: it can be re-pointed.
 *
 * It lives beside the shape it compares, in the module that owns `RevisionRef`'s closed member set:
 * both the task protocol (a run's pin) and the strategy protocol (a slot's candidate) compare
 * revisions, and the comparison is theirs to share while neither imports the other.
 */
export function sameRevision(left: RevisionRef, right: RevisionRef): boolean {
  return left.environmentId === right.environmentId && left.revisionId === right.revisionId && left.digest === right.digest
}

/** The run a fact names, or a refusal naming the run. */
export function requireRun(state: TaskState, runId: string, where: string): RunState {
  const run = state.runs[runId]
  if (run === undefined) refuse('unknown-run', `${where} names run "${runId}", which task "${state.taskId}" never started`)
  return run
}

export function requireContractOf(state: TaskState, where: string, subject: string): TaskContract {
  if (state.contract === undefined) refuse('illegal-transition', `${where} arrived before task "${subject}" carried a contract`)
  return state.contract
}

/** One run's settlement, shared by the verified and failed kinds. */
export function settled(run: RunState, status: RunStatus, at: string, reason?: string): RunState {
  return reason === undefined
    ? { ...run, status, finishedAt: at }
    : { ...run, status, finishedAt: at, failureReason: reason }
}
