import { randomUUID } from 'node:crypto'
import type { ArtifactRef, TaskHandoff, TaskInstance, TaskRun } from '@dangosys/dsh-singularity-task'

export interface HandoffInit {
  parentTask: TaskInstance
  parentRun: TaskRun
  childTask: TaskInstance
  reason: string
  callerSessionId: string
  constraints?: readonly string[]
  decisions?: readonly string[]
  assumptions?: readonly string[]
  openQuestions?: readonly string[]
  relevantArtifacts?: readonly ArtifactRef[]
  relevantEvidence?: readonly string[]
}

/**
 * The envelope passed from a parent run to the child it delegates to (RFC §18).
 *
 * This module builds and persists the DATA of a handoff and nothing else: what
 * a worker is shown from it is the context package's projection
 * (`context/src/projections.ts`, `render.ts:handoffLines`), and the stable
 * behaviour rules that used to ride the same spawn prompt are the agent
 * runtime's worker policy section — neither is rendered here, because the
 * runtime must not grow a second rendering of what it owns as facts.
 */
export function buildHandoff(init: HandoffInit): TaskHandoff {
  return {
    handoffId: `h-${randomUUID()}`,
    parentTaskId: init.parentTask.taskId,
    parentRunId: init.parentRun.runId,
    childTaskId: init.childTask.taskId,
    parentObjective: init.parentTask.objective,
    reasonForDelegation: init.reason,
    constraints: [...(init.constraints ?? [])],
    decisions: [...(init.decisions ?? [])],
    relevantArtifacts: (init.relevantArtifacts ?? init.parentRun.artifacts).map(artifact => ({ ...artifact })),
    relevantEvidence: [...(init.relevantEvidence ?? [])],
    assumptions: [...(init.assumptions ?? [])],
    openQuestions: [...(init.openQuestions ?? [])],
    parentSessionRef: init.callerSessionId,
    createdAt: new Date().toISOString(),
  }
}
