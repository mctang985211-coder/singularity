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

import { refuse } from '../protocol/refusal.ts'
import type { TaskContract } from './contract.ts'
import type { RunState, RunStatus, TaskState } from './protocol.ts'

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
