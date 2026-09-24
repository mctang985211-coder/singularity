/**
 * The view both readers answer with while a graph's store holds no root task
 * (A2 §D, migrated from the tool package's `root-store.ts`).
 *
 * Before a contract is accepted a root session's store may not exist at all, or
 * exist with no task in it — both are normal states (the graph opens the store;
 * the intake is what fills it) and neither is an error a reader may throw. The
 * state a root session gets instead is named: no root contract has been
 * accepted, here is whatever proposal is still open, and here is how a goal is
 * accepted.
 *
 * What is never rendered is a substitute objective. A graph name and the setup
 * work done under it are not goals, and before an intake nothing has named one —
 * so a reader that found no root task says exactly that rather than dressing the
 * graph's name up as a contract.
 * @module @dangosys/dsh-singularity-context/not-activated
 */

import type { TaskProposalRoot, TaskProposalStatus, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { CallerGraph } from './bindings.ts'

/**
 * What an open root proposal means to the session waiting on one, in the words
 * of the lifecycle the store itself holds: nothing here can be read as "the
 * contract is accepted", and none of the three is a terminal state. `ready` and
 * `approved` are the two a reader is most likely to misread — both mean the
 * runtime still has to re-check and activate.
 */
const OPEN_ROOT_PROPOSAL_MEANING = new Map<TaskProposalStatus, string>([
  ['pending_review', 'waiting for a review decision; the contract is not a task yet'],
  ['ready', 'recorded and past its re-check, waiting for the runtime to activate it'],
  ['approved', 'approved on the record, waiting for the runtime\'s post-approval re-check and activation'],
])

/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
export function openRootProposals(snapshot: TaskSnapshot | undefined): TaskProposalRoot[] {
  return (snapshot?.proposals?.all ?? []).filter(
    (proposal): proposal is TaskProposalRoot => proposal.kind === 'root' && OPEN_ROOT_PROPOSAL_MEANING.has(proposal.status),
  )
}

/** How a store with no root task stands, in the store's own terms. */
export function storeStateText(snapshot: TaskSnapshot | undefined): string {
  return snapshot === undefined
    ? 'does not exist yet — a graph opens it when it is created and fills it when a contract is accepted, and neither state is a failure'
    : 'opened, with no root task in it'
}

/**
 * The not-activated view: the state named, whatever proposal is open, and the
 * one action that changes it — accepting the user's own goal with `task_intake`.
 * The last line is the point of the whole view: no objective is reported,
 * because none has been accepted.
 */
export function notActivatedLines(graph: CallerGraph, storeId: string, snapshot: TaskSnapshot | undefined): string[] {
  const open = openRootProposals(snapshot)
  return [
    `graph ${graph.id} root session "${graph.rootSessionId}": not activated — no root contract has been accepted for this session, so there is no root task.`,
    `- store ${storeId}: ${storeStateText(snapshot)}`,
    ...(open.length === 0
      ? ['- open proposals: none — no root contract is waiting for a decision or for its activation.']
      : [
          '- open proposals:',
          ...open.map(proposal =>
            `  - ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy} — ${OPEN_ROOT_PROPOSAL_MEANING.get(proposal.status)}`),
        ]),
    '- accept the user\'s objective here with `task_intake`: it writes the normalized root contract (objective, acceptance criteria,',
    '  assumptions, constraints and declared capabilities) and activates it as this graph\'s root task — or, where the deployment',
    '  reviews root contracts, it answers with a proposal id and activates nothing until a recorded decision.',
    '- `task_decompose` cannot run before that: it works on the root task, which does not exist until a contract is accepted.',
    '- no objective is reported here: this graph\'s name and its setup work are not a goal, and no contract has named one yet.',
  ]
}
