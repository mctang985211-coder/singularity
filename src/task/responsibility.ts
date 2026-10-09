/**
 * Responsibility: which agent is answerable for a task, and what happens when that changes.
 *
 * The frozen repo recorded responsibility and never enforced it — its own handoff module says it
 * persists "the DATA of a handoff and nothing else", and nothing stopped a parent from continuing
 * work it had just delegated. So this is new work, not a port.
 *
 * The teeth are deliberately placed where they change behaviour rather than decorate the record:
 * **`run/started` only accepts the identity of the currently responsible agent.** That makes a
 * transfer observable — after one, the previous holder's attempt is refused by name — and it means
 * no task can be worked on by nobody.
 *
 * The check compares the **identity**, not the agent id, because the identity is what the log
 * stamps on a fact from the kind's declared emitter role; an agent id is a name a caller supplies.
 * Whether that agent id was ever opened is a cross-subject question, so it belongs to the serial
 * command boundary, not here.
 *
 * @module singularity-core/task/responsibility
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import type { TaskState } from './protocol.ts'
import { record, requireContractOf, text } from './shape.ts'

/** The agent answerable for a task, and the trusted identity that stands for it in the log. */
export interface Responsibility {
  readonly agentId: string
  readonly agentIdentity: string
  readonly assignedAt: string
}

export const RESPONSIBILITY_MEMBERS = ['agentId', 'agentIdentity'] as const
export const REASSIGNMENT_MEMBERS = ['from', 'agentId', 'agentIdentity'] as const

/** `task/assigned`: the first assignment. A second one is a transfer, not an assignment. */
export function assignedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { agentId: string; agentIdentity: string }>({
    guarantees: { appended: true },
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      assertClosedKeys(source, RESPONSIBILITY_MEMBERS, where)
      return { agentId: text(source, 'agentId', where), agentIdentity: text(source, 'agentIdentity', where) }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      requireContractOf(state, where, envelope.subject)
      const current = state.responsibility
      if (current !== undefined)
        refuse(
          'illegal-transition',
          `${where} assigns task "${envelope.subject}" again; it is already the responsibility of agent "${current.agentId}". A change of hands is a transfer, which must name who it is taken from`,
        )
      return { ...state, responsibility: { agentId: payload.agentId, agentIdentity: payload.agentIdentity, assignedAt: envelope.at } }
    },
  })
}

/** `task/reassigned`: a transfer, which must name the holder it takes responsibility from. */
export function reassignedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { from: string; agentId: string; agentIdentity: string }>({
    guarantees: { appended: true },
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      assertClosedKeys(source, REASSIGNMENT_MEMBERS, where)
      return {
        from: text(source, 'from', where),
        agentId: text(source, 'agentId', where),
        agentIdentity: text(source, 'agentIdentity', where),
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      const current = state.responsibility
      if (current === undefined)
        refuse('illegal-transition', `${where} transfers task "${envelope.subject}", which nobody is responsible for yet; there is nothing to transfer`)
      if (current.agentId !== payload.from)
        refuse(
          'illegal-transition',
          `${where} transfers task "${envelope.subject}" from agent "${payload.from}", but it is held by agent "${current.agentId}"; a transfer must name the current holder`,
        )
      if (payload.agentId === current.agentId)
        refuse('illegal-transition', `${where} transfers task "${envelope.subject}" to agent "${payload.agentId}", which already holds it`)
      return { ...state, responsibility: { agentId: payload.agentId, agentIdentity: payload.agentIdentity, assignedAt: envelope.at } }
    },
  })
}

/**
 * The gate: only the currently responsible identity may work on the task.
 *
 * Called from `run/started`. Plainly named, because "the agent that was told to stop working on
 * this" is a different refusal from "this executor judged its own run".
 */
export function requireResponsible(state: TaskState, actor: string, where: string): void {
  const current = state.responsibility
  if (current === undefined)
    refuse(
      'not-responsible',
      `${where}: no agent is responsible for task "${state.taskId}", and work nobody is answerable for is not started`,
    )
  if (current.agentIdentity !== actor)
    refuse(
      'not-responsible',
      `${where}: "${actor}" attempted to start work on task "${state.taskId}", which is the responsibility of agent "${current.agentId}" (identity "${current.agentIdentity}")`,
    )
}
