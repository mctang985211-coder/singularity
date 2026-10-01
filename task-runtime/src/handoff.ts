import { randomUUID } from 'node:crypto'
import type { ArtifactRef, TaskHandoff, TaskInstance, TaskRun } from '@dangosys/dsh-singularity-task'

interface HandoffInit {
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
 * This module builds and persists the DATA of a handoff and nothing else: what
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
