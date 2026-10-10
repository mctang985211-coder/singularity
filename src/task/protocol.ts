/**
 * The declared surface of `task`: its state shape, its closed kind set, its version, and the roles
 * that may produce each kind.
 *
 * The facts themselves live beside it, one module per responsibility: the run (its shape, its rules
 * and what it consumed) in `run.ts`, the bubble in `bubble.ts`, the decomposition in
 * `decomposition.ts`, responsibility in `responsibility.ts`. What stays here is what the protocol
 * decides as a whole — one admitted contract per task, the kind set, and the version note below,
 * which is the one place a historical interpretation of this log is recorded.
 *
 * Payloads are closed: an undeclared member is a refusal, and a missing optional member stays
 * missing rather than becoming an invented value.
 *
 * @module singularity-core/task/protocol
 */

import { refuse } from '../protocol/refusal.ts'
import { defineKind, type MemberSet, type ProtocolRegistry } from '../protocol/registry.ts'
import { AGENT_ROLE } from '../agent/protocol.ts'
import { assertContractShape, CONTRACT_MEMBERS, contractDigest, type TaskContract } from './contract.ts'
import { bubbleOpenedKind } from './bubble.ts'
import { decomposedKind, type Decomposition } from './decomposition.ts'
import { assignedKind, reassignedKind, type Responsibility } from './responsibility.ts'
import { record } from './shape.ts'
import {
  evidenceProducedKind,
  methodConsumedKind,
  runFailedKind,
  runStartedKind,
  runVerifiedKind,
  type RunState,
} from './run.ts'

/** The run's own shape, re-exported here: every reader of the task protocol reads it from here. */
export type { EvidenceRecord, RunState, RunStatus } from './run.ts'

export const TASK_PROTOCOL = 'task'
/**
 * Version 5. Older versions are **refused by name, with no compatibility layer**: this stack has no
 * distributed ledger to migrate, and review §5 is explicit that "no old data here" is not a licence
 * to change a version in place.
 *
 * The bumps are batched deliberately, so one version means one historical interpretation:
 *
 * - 3: `evidence/produced` gained a **required** `inputDigests`, and responsibility
 *   (`task/assigned` / `task/reassigned`) became a precondition of starting work.
 * - 4: `bubble/opened` gained a **required** isolation manifest (`model`, `tools`, `conditions`).
 *   A release pointer may only move to a revision whose execution context is recoverable, and a
 *   context that does not name the model and the implementation behind each tool name is not
 *   recoverable. So the manifest is required, and a bubble that omits it is refused, not defaulted.
 * - 5: `method/consumed` was added: the apparatus records a method a run actually loaded, at the
 *   revision that run pinned, with the source the claim came from. A run pinned to a revision proves
 *   nothing about which of its methods were used (`review.md` §4 R08), and a version that cannot
 *   carry that fact cannot be read as one that did.
 */
export const TASK_VERSION = 5

/** The trusted role that admits contracts and starts, settles or fails runs. */
export const SCHEDULER_ROLE = 'scheduler'

/** The trusted role a verdict must come from: the verifier implementation the criterion names. */
export function verifierRoleOf(payload: { verifierRef: string; verifierVersion: string }): string {
  return `verifier:${payload.verifierRef}@${payload.verifierVersion}`
}

/**
 * The method revision a run is pinned to. Pin the digest too: an id alone can be re-pointed.
 *
 * The environment is named because a revision id is only unique **within** an environment; without
 * it, "which revision is this run pinned to" would have to be guessed by searching every
 * environment, and two environments could both hold a revision with that id.
 */
export interface RevisionRef {
  readonly environmentId: string
  readonly revisionId: string
  readonly digest: string
}

/** The folded state of one task. `subject` in every envelope is this task's id. */
export interface TaskState {
  readonly taskId: string
  readonly contract?: TaskContract
  readonly contractDigest?: string
  readonly admittedBy?: string
  readonly admittedAt?: string
  /**
   * The fixed plan, when this task has one. Declared once and never revised: a plan that could be
   * edited would make "which sub-task accepted which criterion" unanswerable after the fact.
   */
  readonly decomposition?: Decomposition
  /** Who is answerable for this task. A task without one cannot be worked on at all. */
  readonly responsibility?: Responsibility
  readonly runs: Readonly<Record<string, RunState>>
}

export const TASK_KINDS = {
  admitted: 'task/admitted',
  decomposed: 'task/decomposed',
  assigned: 'task/assigned',
  reassigned: 'task/reassigned',
  bubbleOpened: 'bubble/opened',
  runStarted: 'run/started',
  evidenceProduced: 'evidence/produced',
  runVerified: 'run/verified',
  runFailed: 'run/failed',
  methodConsumed: 'method/consumed',
} as const

/**
 * Declare the task protocol. Call once at load. The deployment's runnable verifiers are not
 * captured here: what can run today is a command-time question, not a replay-time one.
 */
export function declareTaskProtocol(registry: ProtocolRegistry): void {
  registry.declare<TaskState>(TASK_PROTOCOL, TASK_VERSION, {
    initialState: { taskId: '', runs: {} },
    kinds: {
      [TASK_KINDS.admitted]: defineKind<TaskState, { contract: TaskContract }, { contract: MemberSet }>({
        guarantees: { appended: true },
        members: ['contract'],
        // The contract's own members, and each criterion inside it, are closed by `contract.ts`'s
        // readers with the sets those readers declare — one level is what a payload member names.
        nested: { contract: CONTRACT_MEMBERS },
        emitter: SCHEDULER_ROLE,
        parse: raw => {
          const source = record(raw, `${TASK_KINDS.admitted} payload`)
          return { contract: assertContractShape(source['contract'], `${TASK_KINDS.admitted} payload.contract`) }
        },
        reduce: (state, envelope, payload) => {
          if (state.contract !== undefined)
            refuse(
              'illegal-transition',
              `task "${state.taskId}" already carries a contract admitted at ${state.admittedAt ?? 'an unrecorded time'}; a later contract is a different task`,
            )
          return {
            taskId: envelope.subject,
            contract: payload.contract,
            contractDigest: contractDigest(payload.contract),
            admittedBy: envelope.actor,
            admittedAt: envelope.at,
            runs: {},
          }
        },
      }),

      [TASK_KINDS.decomposed]: decomposedKind(TASK_KINDS.decomposed, SCHEDULER_ROLE),
      [TASK_KINDS.assigned]: assignedKind(TASK_KINDS.assigned, SCHEDULER_ROLE),
      [TASK_KINDS.reassigned]: reassignedKind(TASK_KINDS.reassigned, SCHEDULER_ROLE),
      [TASK_KINDS.bubbleOpened]: bubbleOpenedKind(TASK_KINDS.bubbleOpened, SCHEDULER_ROLE),

      [TASK_KINDS.runStarted]: runStartedKind(TASK_KINDS.runStarted, SCHEDULER_ROLE),
      // The role *is* the implementation: `verifierRoleOf` reads it out of the payload the criterion
      // was already checked against, and the log refuses the fact when the deployment holds no such
      // identity.
      [TASK_KINDS.evidenceProduced]: evidenceProducedKind(TASK_KINDS.evidenceProduced, verifierRoleOf),
      [TASK_KINDS.runVerified]: runVerifiedKind(TASK_KINDS.runVerified, SCHEDULER_ROLE),
      [TASK_KINDS.runFailed]: runFailedKind(TASK_KINDS.runFailed, SCHEDULER_ROLE),
      // The apparatus's own role, never the scheduler's and never an agent's: what a run consumed is
      // recorded by the thing that ran it, not by the candidate that wants credit for it.
      [TASK_KINDS.methodConsumed]: methodConsumedKind(TASK_KINDS.methodConsumed, AGENT_ROLE),
    },
  })
}
