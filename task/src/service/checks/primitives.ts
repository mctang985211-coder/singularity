/** Shared reducer primitives: copies, shape predicates, index guards and snapshot lookups. @module @dangosys/dsh-singularity-task/service/checks/primitives */

import type { RunId, TaskId, TaskInstance, TaskRun, TaskSnapshot } from '../../types.ts'

export function copy<T>(value: T): T {
  return structuredClone(value)
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A lowercase SHA-256 hex digest: the only shape a content or context identity is accepted in. */
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Plain-object test: `null` and arrays are not records, whatever `typeof` says. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One optional snapshot index, or a refusal: an absent index is "cannot see", never "holds none". */
export function requireIndex<T>(index: T | undefined, message: string): T {
  if (index === undefined) throw new Error(message)
  return index
}

export function taskIn(snapshot: TaskSnapshot, taskId: TaskId): TaskInstance {
  const task = snapshot.tasks.find(item => item.taskId === taskId)
  if (task === undefined) throw new Error(`task: unknown task "${taskId}"`)
  return task
}

export function runIn(snapshot: TaskSnapshot, runId: RunId): TaskRun {
  const run = snapshot.runs.find(item => item.runId === runId)
  if (run === undefined) throw new Error(`task: unknown run "${runId}"`)
  return run
}
