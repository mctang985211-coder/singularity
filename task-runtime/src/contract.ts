/**
 * The worker contract as a marked, standalone block.
 *
 * `renderWorkerPrompt` (`./handoff.ts`) is the spawn prompt: one user message
 * carrying the delegation terms, the contract, and the behavioural rules. It is
 * the right carrier for the rules, but everything in it is history — a fold can
 * shadow it, and after a fresh prompt the worker is working from memory. This
 * module renders the same contract facts as a block the agent runtime registers
 * as a system-prompt section, which the loop reprojects into surface node 0 on
 * every step (`agent-runtime/src/contract-reinjection.ts` carries the mechanism
 * and the upstream citations).
 *
 * In: the objective, the acceptance criteria table the verifier judges (with
 * each criterion's command and the protected input paths a worker must not
 * modify — {@link protectedInputsCell}), the decomposition status, and the
 * handoff envelope. Out: the behavioural rules
 * and the parent-session pointer (guidance, not contract) and each criterion's
 * `requiredEvidence` (the verifier reads it from the store, not the model from
 * its prompt).
 *
 * Rendered once at delegation: contract data is immutable after admission —
 * objective, criteria, and handoff are each written once — so the section never
 * needs re-rendering inside a run, and the loop's unchanged-text check keeps it
 * at zero extra session events.
 * @module @dangosys/dsh-singularity-task-runtime/contract
 */

import type { AcceptanceCriterion, TaskHandoff, TaskInstance } from '@dangosys/dsh-singularity-task'

/**
 * Opening marker of the block. Stable on purpose: it is what tells a reader —
 * human or test — that this text is the contract, and it lets a future
 * re-render find the copy already on the surface.
 */
export const WORKER_CONTRACT_OPEN = '<worker-contract'

/** Closing marker, and the URL-safe suffix a search for the block's end uses. */
export const WORKER_CONTRACT_CLOSE = '</worker-contract>'

/**
 * The protected acceptance inputs cell of one criterion row — the paths the
 * worker must not modify, or `—` when the criterion declares none.
 *
 * One helper for both tables (`criteriaTable` here and the spawn prompt's own
 * copy in `./handoff.ts`) because the two render the same contract and must
 * agree byte-for-byte: a criterion that declares nothing is marked as such
 * rather than left blank, and the paths are joined in declaration order, never
 * sorted or deduplicated — what the caller declared is what the worker reads.
 * Only paths are rendered: the fixed digest is the verifier's business, and a
 * hex string in a prompt would be noise the worker cannot act on.
 */
export function protectedInputsCell(criterion: AcceptanceCriterion): string {
  const refs = criterion.protectedInputs ?? []
  return refs.length === 0 ? '—' : refs.map(ref => ref.path).join(', ')
}

/** The criteria table, in the same shape the spawn prompt renders: what, how judged, the command, and what must not change. */
function criteriaTable(criteria: readonly AcceptanceCriterion[]): string[] {
  return [
    '| criterion | mode | mandatory | description | command | protected inputs |',
    '| --- | --- | --- | --- | --- | --- |',
    ...criteria.map(criterion =>
      `| ${criterion.criterionId} | ${criterion.verificationMode} | ${criterion.mandatory ? 'yes' : 'no'} | ${criterion.description} | ${criterion.command ?? '—'} | ${protectedInputsCell(criterion)} |`),
  ]
}

/** One handoff list: `(none)` for an empty one, the items as a nested list otherwise. */
function field(title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [`- ${title}: (none)`]
  return [`- ${title}:`, ...items.map(item => `  - ${item}`)]
}

/**
 * Render one task's contract block.
 * @param task - the child task as the store holds it at delegation.
 * @param handoff - the envelope the parent passed to this child.
 * @returns the marked block, ending in the one line that says where the
 *   authority lives, so a model reading it never has to guess whether a
 *   compacted spawn prompt or this block is the current contract.
 */
export function renderWorkerContract(task: TaskInstance, handoff: TaskHandoff): string {
  return [
    `${WORKER_CONTRACT_OPEN} task="${task.taskId}" decomposition="${task.decompositionStatus}">`,
    '',
    `# Delegated task ${task.taskId}`,
    '',
    task.objective,
    '',
    '## Acceptance criteria',
    '',
    ...criteriaTable(task.acceptanceCriteria),
    '',
    '## Handoff',
    '',
    `- Parent objective: ${handoff.parentObjective}`,
    `- Reason for delegation: ${handoff.reasonForDelegation}`,
    ...field('Constraints', handoff.constraints),
    ...field('Decisions already made', handoff.decisions),
    ...field('Assumptions', handoff.assumptions),
    ...field('Open questions', handoff.openQuestions),
    '',
    WORKER_CONTRACT_CLOSE,
    '',
    'This block is the authoritative copy of your contract and is re-sent with every request; `task_read` reads the same store.',
  ].join('\n')
}
