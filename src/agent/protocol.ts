/**
 * The agent protocol: one node, and the DSH session it actually runs in.
 *
 * E3 is a **reference**, not a re-modelling. DSH already has the runtime object (`ctx.agents` +
 * `AgentLoop`), so this protocol records only what the log must be able to answer later: which
 * agent, in what role, and **which session id to resume**. Nothing about the agent's internals is
 * copied here, and nothing here tries to describe whether the session is alive.
 *
 * **"A visible node has a live session" is ordering, not an invariant, and this is where that is
 * admitted.** A fact cannot decide whether a DSH session is still resident; upstream does not make
 * residency durable either — its own continuable child is not resident after spawn. So the log
 * records the session id, the deployment is responsible for creating the session before recording
 * the node, and a reader that needs liveness must ask the runtime. A reducer that claimed to decide
 * liveness would be the kind of comment-dressed-as-guarantee this rebuild exists to remove.
 *
 * B keeps this to opening a node and nothing else: no closing, no nesting, no group and no router,
 * because nothing consumes them yet.
 *
 * @module singularity-core/agent/protocol
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'

export const AGENT_PROTOCOL = 'agent'
export const AGENT_VERSION = 1

/** The trusted role that records agent nodes. Held by the runtime, never by an agent itself. */
export const AGENT_ROLE = 'runtime'

export const AGENT_KINDS = {
  opened: 'agent/opened',
} as const

export const AGENT_OPENED_MEMBERS = ['agentId', 'role', 'sessionId'] as const

/** One agent node: an id of ours, a role, and the DSH session id to resume. */
export interface AgentState {
  readonly agentId: string
  readonly role: string
  /** The session to **resume**: the same id is what makes recovery the same agent, not a new one. */
  readonly sessionId: string
  readonly openedAt: string
}

/** Declare the agent protocol. Call once at load. */
export function declareAgentProtocol(registry: ProtocolRegistry): void {
  registry.declare<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, {
    initialState: { agentId: '', role: '', sessionId: '', openedAt: '' },
    kinds: {
      [AGENT_KINDS.opened]: defineKind<AgentState, { agentId: string; role: string; sessionId: string }>({
        guarantees: { appended: true },
        emitter: AGENT_ROLE,
        parse: raw => {
          const where = `${AGENT_KINDS.opened} payload`
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            refuse('malformed-payload', `${where} must be an object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}`)
          const source = raw as Record<string, unknown>
          assertClosedKeys(source, AGENT_OPENED_MEMBERS, where)
          const field = (key: string): string => {
            const value = source[key]
            if (typeof value !== 'string' || value.length === 0)
              refuse('malformed-payload', `${where}.${key} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
            return value
          }
          return { agentId: field('agentId'), role: field('role'), sessionId: field('sessionId') }
        },
        reduce: (state, envelope, payload) => {
          // The subject is the agent id, so a node whose payload disagrees with its subject would
          // be two identities for one fact.
          if (payload.agentId !== envelope.subject)
            refuse(
              'malformed-payload',
              `${AGENT_KINDS.opened} #${envelope.seq} is recorded under subject "${envelope.subject}" but names agent "${payload.agentId}"; one node has one id`,
            )
          if (state.openedAt !== '')
            refuse(
              'illegal-transition',
              `${AGENT_KINDS.opened} #${envelope.seq} opens agent "${payload.agentId}" again (opened at ${state.openedAt}); a node is opened once`,
            )
          return { agentId: payload.agentId, role: payload.role, sessionId: payload.sessionId, openedAt: envelope.at }
        },
      }),
    },
  })
}
