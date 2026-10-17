/**
 * A parent task with a declared plan, and the sub-tasks it names.
 *
 * Two sub-tasks, one dependency between them, and one parent criterion each — the smallest shape
 * that can show dependency gating, contribution attribution, and a budget actually running out.
 *
 * Every fact is emitted for an explicit subject, because a decomposition's whole point is that the
 * parent and its children are different subjects in one log.
 */

import {
  type DecompositionChild,
  type EmitInput,
  MemoryLog,
  type ProtocolRegistry,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskContract,
} from '../src/index.ts'
import {
  BUBBLE_INPUTS,
  INTEGRATION_IMPLEMENTATION,
  INTEGRATION_VERIFIER,
  REVISION,
  SCHEDULER,
  SUBJECTS,
  taskRegistry,
  UNIT_IMPLEMENTATION,
  UNIT_VERIFIER,
  BUBBLE_CONDITIONS,
  BUBBLE_MODEL,
  BUBBLE_TOOLS,
} from './task-fixtures.ts'

export const PARENT = 'task-parent'
export const CHILD_A = 'task-child-a'
export const CHILD_B = 'task-child-b'
export const CHILD_C = 'task-child-c'

/** The parent's own contract: two criteria, each decided by a different implementation. */
export function parentContract(): TaskContract {
  return {
    artifact: 'artifact.json',
    goal: 'ship a word counter in two parts',
    template: { id: 'parent', digest: '1'.repeat(64) },
    inputs: [{ name: 'fixture/words.txt', source: { kind: 'protected', ref: 'words', digest: 'f'.repeat(64) } }],
    criteria: [
      {
        criterionId: 'counts',
        statement: 'the counting part is correct' },
      { criterionId: 'limits', statement: 'the limit part rejects oversized input' },
    ],
  }
}

/** A sub-task's own contract. It is the child's, never a copy of the parent's. */
export function childContract(criterionId: string, _verifierRef: string, _implementationDigest: string): TaskContract {
  return {
    artifact: 'artifact.json',
    goal: `do ${criterionId}`,
    template: { id: criterionId, digest: '2'.repeat(64) },
    inputs: [{ name: 'fixture/words.txt', source: { kind: 'protected', ref: 'words', digest: 'f'.repeat(64) } }],
    criteria: [{ criterionId, statement: `the sub-task's own ${criterionId} check` }],
  }
}

export const CHILD_A_CONTRACT = (): TaskContract => childContract('part-a', UNIT_VERIFIER, UNIT_IMPLEMENTATION)
export const CHILD_B_CONTRACT = (): TaskContract => childContract('part-b', INTEGRATION_VERIFIER, INTEGRATION_IMPLEMENTATION)
export const CHILD_C_CONTRACT = (): TaskContract => childContract('part-c', UNIT_VERIFIER, UNIT_IMPLEMENTATION)

/** A three-step chain, so a failure has somewhere to propagate *through*. */
export function chain(): readonly DecompositionChild[] {
  return [
    { taskId: CHILD_A, dependsOn: [], supports: ['counts'], maxRuns: 1, requirement: 'required' as const },
    { taskId: CHILD_B, dependsOn: [CHILD_A], supports: ['limits'], maxRuns: 1, requirement: 'required' as const },
    { taskId: CHILD_C, dependsOn: [CHILD_B], supports: ['counts'], maxRuns: 1, requirement: 'required' as const },
  ]
}

/** The plan: B waits for A; each supports one criterion of the parent. */
export function plan(options: { readonly maxRunsA?: number; readonly maxRunsB?: number; readonly aDependsOn?: readonly string[] } = {},
): readonly DecompositionChild[] {
  return [
    { taskId: CHILD_A, dependsOn: options.aDependsOn ?? [], supports: ['counts'], maxRuns: options.maxRunsA ?? 2, requirement: 'required' as const },
    { taskId: CHILD_B, dependsOn: [CHILD_A], supports: ['limits'], maxRuns: options.maxRunsB ?? 1, requirement: 'required' as const },
  ]
}

let counter = 0

function emit(subject: string, kind: string, payload: unknown): EmitInput {
  counter += 1
  return { commandId: `tree-${counter}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject, payload }
}

export const admit = (subject: string, contract: TaskContract): EmitInput => emit(subject, TASK_KINDS.admitted, { contract })
export const decompose = (subject: string, children: readonly DecompositionChild[]): EmitInput => emit(subject, TASK_KINDS.decomposed, { children })
export const startRun = (subject: string, runId: string): EmitInput => emit(subject, TASK_KINDS.runStarted, { purpose: 'solve', runId, revision: REVISION })
/** Work nobody is answerable for is not started, so every sub-task that runs is assigned first. */
export const assigned = (subject: string): EmitInput =>
  emit(subject, TASK_KINDS.assigned, { agentId: `agent-for-${subject}`, agentIdentity: SCHEDULER })
export const openBubble = (subject: string, runId: string): EmitInput =>
  emit(subject, TASK_KINDS.bubbleOpened, {
    runId,
    inputs: BUBBLE_INPUTS,
    workspace: { kind: 'git', ref: 'refs/heads/main' },
    model: BUBBLE_MODEL,
    tools: BUBBLE_TOOLS,
    conditions: BUBBLE_CONDITIONS,
  })

/** Start a run **and** declare the context it executes in: a judged run needs both. */
export async function openRun(log: MemoryLog, subject: string, runId: string): Promise<void> {
  await log.emit(startRun(subject, runId))
  await log.emit(openBubble(subject, runId))
}
export const verified = (subject: string, runId: string): EmitInput => emit(subject, TASK_KINDS.runVerified, { runId })
export const failed = (subject: string, runId: string, reason?: string, cause: 'acceptance' | 'runtime' = 'runtime',
): EmitInput =>
  emit(subject, TASK_KINDS.runFailed, { runId, cause, ...(reason === undefined ? {} : { reason }) })

export function judge(
  subject: string,
  runId: string,
  criterionId: string,
  verifierRef: string,
  verdict: 'pass' | 'fail' = 'pass',
): EmitInput {
  const implementationDigest = verifierRef === UNIT_VERIFIER ? UNIT_IMPLEMENTATION : INTEGRATION_IMPLEMENTATION
  return emit(subject, TASK_KINDS.evidenceProduced, {
    reviewId: 'review-1',
    runId,
    criterionId,
    verdict,
    verifierRef,
    verifierVersion: '1',
    implementationDigest,
    artifactDigest: 'b'.repeat(64),
    inputDigests: BUBBLE_INPUTS,
  })
}

export function treeLog(registry: ProtocolRegistry = taskRegistry()): MemoryLog {
  return new MemoryLog(registry, { subjects: SUBJECTS })
}

/** Parent admitted and decomposed; both children admitted. The starting point most specs share. */
export async function planned(registry: ProtocolRegistry = taskRegistry(), options: Parameters<typeof plan>[0] = {},
): Promise<MemoryLog> {
  const log = treeLog(registry)
  await log.emit(admit(PARENT, parentContract()))
  await log.emit(assigned(PARENT))
  await log.emit(decompose(PARENT, plan(options)))
  await log.emit(admit(CHILD_A, CHILD_A_CONTRACT()))
  await log.emit(assigned(CHILD_A))
  await log.emit(admit(CHILD_B, CHILD_B_CONTRACT()))
  await log.emit(assigned(CHILD_B))
  return log
}
