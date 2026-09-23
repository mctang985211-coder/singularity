import { randomUUID } from 'node:crypto'
import type { ArtifactRef, RunProviderBinding, TaskHandoff, TaskInstance, TaskRun } from '@dangosys/dsh-singularity-task'
import { protectedInputsCell } from './contract.ts'
import { renderRunBinding } from './run-binding.ts'

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
 * Deployment knobs the rendered prompt has to reflect. Required, not optional:
 * the prompt is the only place a worker learns whether the runtime will admit
 * its own decomposition, and a default here could silently disagree with
 * `Config.allowRuntimeDecomposition` (#16 in the guide is exactly this failure
 * mode — prompt wording decides the route, and no test asserts the real model's
 * choice).
 */
export interface WorkerPromptOptions {
  /**
   * `Config.allowRuntimeDecomposition`. On, the rules tell every worker it may
   * call `task_decompose` when the work turns out not to be atomic, and what a
   * refusal means; off, the rules stay silent about the tool — a `decomposable`
   * child's own block already names it, and for a `leaf` worker naming it would
   * only invite a call admission refuses.
   */
  allowRuntimeDecomposition: boolean
  /**
   * What this run was bound to and loaded (S1-C item 4). Rendered as the
   * "chosen implementation" section — the run's capability names, the provider
   * selected for each, and how to read a body on demand — from the same function
   * the contract block and `task_read` use. Absent on a run that recorded no
   * binding, and then the prompt says nothing about one.
   */
  binding?: RunProviderBinding
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
 * objective, the acceptance criteria table (with verifier commands and the
 * protected input paths the worker must not modify), the implementation chosen
 * for this run ({@link WorkerPromptOptions.binding}), the handoff envelope, the
 * pointer to the delegating session, the decomposable reminder when the parent
 * asked for a further split, the runtime-split rule when the deployment admits
 * one ({@link WorkerPromptOptions}), and the rules — a few thousand tokens at
 * most.
 */
export function renderWorkerPrompt(handoff: TaskHandoff, childTask: TaskInstance, options: WorkerPromptOptions): string {
  const header = [
    `# Delegated task ${childTask.taskId}`,
    '',
    childTask.objective,
    '',
    '## Acceptance criteria',
    '',
    '| criterion | mode | mandatory | description | command | protected inputs |',
    '| --- | --- | --- | --- | --- | --- |',
    ...childTask.acceptanceCriteria.map(criterion =>
      `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? 'yes' : 'no'} | ${criterion.description} | ${criterion.command ?? '—'} | ${protectedInputsCell(criterion)} |`),
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

  // The run's own binding, rendered by the one function the contract block and
  // `task_read` share: what this run's admission chose for it, so a worker knows
  // its capability names and providers instead of guessing them.
  const summary = renderRunBinding(options.binding)

  // Only a deployment with the runtime-decomposition switch on admits a task's
  // own `task_decompose`; where it is off, naming the tool would invite a call
  // the runtime answers with a refusal the worker could not have avoided.
  const runtimeSplitRule =
    '- If the work turns out not to be atomic after all, call `task_decompose` yourself: this deployment admits a task\'s own decomposition, ' +
    'so your parent did not have to predict it. The call still has to clear admission — structure, acyclic dependencies, a command on every ' +
    'executable criterion, capability coverage, depth and batch-size limits — and a task may split only once; a refusal names the rule that ' +
    'blocked it, and that reason is what you act on. Split only into pieces a verifier can judge on its own; otherwise do the work here.'

  // A decomposition may instead come back waiting for a human review (T2/T3
  // §5): the same answer tells the worker what the wait means, that repeating
  // itself is pointless, and what a refusal asks of it. Rendered wherever this
  // prompt tells the worker to decompose at all — the switch above, or a task
  // admitted as decomposable, whose own block names the tool whatever the
  // switch says.
  const reviewRule =
    '- A decomposition can come back waiting for a human review: it answers with a proposal id and admits nothing, so no child exists ' +
    'and nothing is spawned until the review decides. Read the batch as it was recorded with `task_proposal_read`; do not re-submit the ' +
    'same batch while it waits, because the same request is answered with the same proposal. If the review refuses it, revise the batch ' +
    'from the reason on the record and decompose again — a revision is a new proposal, never a re-run of the refused one.'

  const rules = [
    '## Rules',
    '',
    '- Do the work; never declare completion yourself — an external verifier checks every mandatory criterion.',
    '- Where a criterion lists a command, make that command exit 0 in the checkout.',
    '- A criterion\'s declared protected inputs must not be modified: the verifier re-checks their identity before judging, ' +
    'and a changed or missing input fails the criterion, naming the path.',
    '- Keep changes scoped to this task. Need a human decision? Ask with `ask_user_question`.',
    '- Cannot continue? Fail with a clear reason — the orchestrator blocks dependent tasks and reports to the parent task.',
    ...(options.allowRuntimeDecomposition ? [runtimeSplitRule] : []),
    ...(options.allowRuntimeDecomposition || childTask.decompositionStatus === 'decomposable' ? [reviewRule] : []),
    '- This prompt is where you start, not the whole truth: re-read your own contract and run with `task_read`, and the whole tree with `task_status`, whenever you need them.',
    '- When the work is done, hand it in with `task_submit_result`: a summary of what you delivered plus the evidence references you produced. ' +
    'The call closes this run to further writes, drains the calls still in flight, and lets the runtime put the run in front of the verifier; ' +
    'the verdict comes back as its answer.',
    '- Going idle is not a submission: the runtime sees an idle session where a submission was due, reminds you once, and stops the run under ' +
    'the no-progress budget if nothing changes. Submit when the work is done, or say what is missing with a clear failure.',
    '- `task_verify` is only a self-check: it re-runs the verifier and records the evidence it produces, never changes task status, and does not ' +
    'stand in for a submission.',
  ].join('\n')

  const blocks = [header, ...(summary.length === 0 ? [] : [summary]), envelope, parentSession, rules]
  if (childTask.decompositionStatus === 'decomposable') blocks.push(decomposition)

  return `${blocks.join('\n\n')}\n`
}
