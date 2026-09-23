/**
 * What the readers of a root session's store share (A0 §1.5).
 *
 * Before a contract is accepted, a root session's store may not exist at all,
 * or exist with no task in it — both are normal states of §1.1 (`graphs.create`
 * opens the store; the intake is what fills it) and neither is an error a
 * reader may throw. The state a root session gets instead is named: no root
 * contract has been accepted, here is whatever proposal is still open, and here
 * is how a goal is accepted.
 *
 * What is never rendered is a substitute objective. A graph name and the setup
 * work done under it are not goals, and before an intake nothing has named one
 * — so a reader that found no root task says exactly that rather than dressing
 * the graph's name up as a contract.
 *
 * The other half of the same state is {@link proposalStoreFor}: a root session
 * has no run to resolve a store from until its contract is activated, and the
 * proposal tools have to reach its store anyway.
 * @module dsh-singularity-agent/tools/root-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { TaskInstance, TaskProposalRoot, TaskProposalStatus, TaskSnapshot } from '@dangosys/dsh-singularity-task'

/**
 * What an open root proposal means to the session waiting on one, in the words
 * of the lifecycle the store itself holds (A0 §2): nothing here can be read as
 * "the contract is accepted", and none of the three is a terminal state.
 * `ready` and `approved` are the two a reader is most likely to misread — both
 * mean the runtime still has to re-check and activate.
 */
const OPEN_ROOT_PROPOSAL_MEANING = new Map<TaskProposalStatus, string>([
  ['pending_review', 'waiting for a review decision; the contract is not a task yet'],
  ['ready', 'recorded and past its re-check, waiting for the runtime to activate it'],
  ['approved', 'approved on the record, waiting for the runtime\'s post-approval re-check and activation'],
])

/**
 * The root store's snapshot, or `undefined` when no such store exists yet — the
 * pre-intake state §1.1 allows, answered as a state rather than thrown at a
 * reader. The store's own word for it is "does not exist"; every other failure
 * (a log this process cannot read, a store it cannot open) is the reader's to
 * surface and is re-raised unchanged.
 */
export async function rootSnapshotOrUndefined(ctx: Context, storeId: string): Promise<TaskSnapshot | undefined> {
  try {
    return await ctx.task.openStore(storeId)
  } catch (error) {
    if (error instanceof Error && /does not exist/.test(error.message)) return undefined
    throw error
  }
}

/**
 * The store's root task, or `undefined` — parentless is what a root is
 * (`adoptRoot` reads the same field), and a store with no root task is the
 * pre-intake state.
 */
export function rootTaskIn(snapshot: TaskSnapshot | undefined): TaskInstance | undefined {
  return snapshot?.tasks.find(task => task.parentTaskId === undefined)
}

/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
export function openRootProposals(snapshot: TaskSnapshot | undefined): TaskProposalRoot[] {
  return (snapshot?.proposals?.all ?? []).filter(
    (proposal): proposal is TaskProposalRoot => proposal.kind === 'root' && OPEN_ROOT_PROPOSAL_MEANING.has(proposal.status),
  )
}

/**
 * The store one proposal call belongs to (A0 §1.5, stage-D defect 1).
 *
 * A worker's store comes from the run it is executing — the lookup both proposal
 * tools have always made. A **root session before its contract is accepted has
 * no run at all** (the root task is what an approved contract becomes), and that
 * is exactly the state in which it has to read the proposal holding its
 * contract: `task_intake`'s answers and the root prompt both send it to
 * `task_proposal_read`. So when the run lookup answers "no task run is bound to
 * this session", the fallback is the store this session owns as a graph's root
 * session — `sg-t-<rootSessionId>` — and it is offered to that session alone: a
 * session that is not a graph's root, or that is in no graph at all, keeps the
 * runtime's own refusal unchanged, and what a caller hears when no store was
 * ever opened for its session is the store's own "does not exist".
 */
export async function proposalStoreFor(ctx: Context, sessionId: SessionId): Promise<string> {
  try {
    const bound = await ctx.taskRuntime.runForSession(sessionId)
    return bound.storeId
  } catch (error) {
    // Only the one state this fallback exists for: a session with no run of its
    // own. Any other failure from the lookup — an unreadable store, a corrupt
    // binding — is the caller's to see, not something to route around.
    if (!(error instanceof Error) || !/no task run is bound to session/.test(error.message)) throw error
    const storeId = await rootStoreOfSession(ctx, sessionId)
    if (storeId === undefined) throw error
    return storeId
  }
}

/**
 * The root store one session owns, or `undefined` for a session that is not a
 * graph's root session (or that is in no graph this process can place). A probe,
 * not a refusal: a caller that has to *say* why a session is not a root renders
 * that on its own (`task_intake`'s named refusal), and a caller using this as a
 * fallback keeps the error it already had.
 */
export async function rootStoreOfSession(ctx: Context, sessionId: SessionId): Promise<string | undefined> {
  try {
    const graph = await ctx.graphs.graphForSession(sessionId)
    return graph.rootSessionId === sessionId ? rootTaskStoreId(graph.rootSessionId) : undefined
  } catch {
    return undefined
  }
}

/**
 * The view both readers answer with while the store holds no root task (A0
 * §1.5): the state named, whatever proposal is open, and the one action that
 * changes it — accepting the user's own goal with `task_intake`. The last line
 * is the point of the whole view: no objective is reported, because none has
 * been accepted.
 */
export function notActivatedLines(
  graphId: string,
  storeId: string,
  rootSessionId: string,
  snapshot: TaskSnapshot | undefined,
): string[] {
  const open = openRootProposals(snapshot)
  return [
    `graph ${graphId} root session "${rootSessionId}": not activated — no root contract has been accepted for this session, so there is no root task.`,
    `- store ${storeId}: ${snapshot === undefined ? 'does not exist yet — a graph opens it when it is created and fills it when a contract is accepted, and neither state is a failure' : 'opened, with no root task in it'}`,
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
