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

/** Envelope passed from a parent run to the child it delegates to (RFC §18). */
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

function listSection(title: string, items: readonly string[], empty: string): string {
  if (items.length === 0) return `## ${title}\n\n${empty}`
  return `## ${title}\n\n${items.map(item => `- ${item}`).join('\n')}`
}

/**
 * Render the worker prompt for a delegated child task. Compact on purpose:
 * objective, the acceptance criteria table (with verifier commands), the
 * handoff envelope, the pointer to the delegating session, the decomposable
 * reminder when the child may split further, and the rules — a few thousand
 * tokens at most.
 */
export function renderWorkerPrompt(handoff: TaskHandoff, childTask: TaskInstance): string {
  const header = [
    `# Delegated task ${childTask.taskId}`,
    '',
    childTask.objective,
    '',
    '## Acceptance criteria',
    '',
    '| criterion | mode | mandatory | description | command |',
    '| --- | --- | --- | --- | --- |',
    ...childTask.acceptanceCriteria.map(criterion =>
      `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? 'yes' : 'no'} | ${criterion.description} | ${criterion.command ?? '—'} |`),
  ].join('\n')

  const decomposition = [
    '## This task is decomposable',
    '',
    '- Do not carry the work to completion yourself: this task was admitted as decomposable.',
    '- Call `task_decompose` instead, with a `reason` and the child task list; every child needs an acceptance criterion a verifier can judge on its own.',
    '- Decompose only when RFC §36 atomicity holds — independently verifiable acceptance dimensions, clear artifact boundaries, capabilities that match or gaps you can handle; otherwise do the work here.',
    '- Once you decompose, the nested verification settles this task; you still never declare completion yourself.',
  ].join('\n')

  const envelope = [
    '## Handoff',
    '',
    `- Parent objective: ${handoff.parentObjective}`,
    `- Reason for delegation: ${handoff.reasonForDelegation}`,
    '',
    listSection('Constraints', handoff.constraints, '(none)'),
    '',
    listSection('Decisions already made', handoff.decisions, '(none)'),
    '',
    listSection(
      'Relevant artifacts',
      handoff.relevantArtifacts.map(artifact => `${artifact.kind} ${artifact.uri}`),
      '(none)',
    ),
    '',
    listSection('Relevant evidence', handoff.relevantEvidence, '(none)'),
    '',
    listSection('Assumptions', handoff.assumptions, '(none)'),
    '',
    listSection('Open questions', handoff.openQuestions, '(none)'),
  ].join('\n')

  const parentSession = [
    '## Parent session',
    '',
    `- The session that delegated this task is \`${handoff.parentSessionRef}\`.`,
    '- Need more of that context? Read it exactly with `session_event_read` (one `seq`) or `session_trace` (lineage and neighborhood).',
    '- Full-text search is disabled in this deployment, so read parent events by sequence.',
  ].join('\n')

  const rules = [
    '## Rules',
    '',
    '- Do the work; never declare completion yourself — an external verifier checks every mandatory criterion.',
    '- Where a criterion lists a command, make that command exit 0 in the checkout.',
    '- Keep changes scoped to this task; escalate conflicts through your parent.',
  ].join('\n')

  const blocks = [header, envelope, parentSession, rules]
  if (childTask.decompositionStatus === 'decomposable') blocks.push(decomposition)

  return `${blocks.join('\n\n')}\n`
}
