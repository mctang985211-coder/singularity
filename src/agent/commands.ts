/**
 * The agent node's command owner: the one surface that opens a node.
 *
 * An agent's node is a fact of the **runtime's** role, never of the agent it describes: the emitter
 * is `AGENT_ROLE` and the identity is resolved from the store's one role table, so an agent cannot
 * open itself and a deployment that holds no runtime identity cannot open anything. The subject is
 * the agent id, which is what makes "one agent, one node" an identity rather than a convention — the
 * reducer only has to refuse a second fact about the same subject.
 *
 * The command exists because the ledger's answer to "which agent is this, and which session resumes
 * it" must be produced by the same boundary as every other fact. A deployment that emitted it by
 * hand would be restating the protocol's own shape, and the restatement is free to drift.
 *
 * @module singularity-core/agent/commands
 */

import type { ControlSessionStore } from '../control/session-store.ts'
import type { Envelope } from '../protocol/envelope.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { AGENT_KINDS, AGENT_PROTOCOL, AGENT_VERSION } from './protocol.ts'

/** What opening a node needs: the store that records it, and the deployment's declared protocols. */
interface AgentNodeCommandOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
}

/**
 * The trusted surface, as a deployment's runtime drives it.
 *
 * Every command carries its own `commandId`: the log answers a retry with the fact it already
 * committed, so a lost reply does not become a second node.
 */
export interface AgentNodeCommands {
  /**
   * Record one agent node. `sessionId` is the session to **resume**, and `role` is what the agent is
   * for; neither is checked here beyond the protocol's own closed shape, because what a role means is
   * a deployment's business and what a session can do is the runtime's.
   */
  open(input: {
    readonly commandId: string
    readonly agentId: string
    readonly sessionId: string
    readonly role: string
  }): Promise<Envelope>
}

export function createAgentNodeCommands(options: AgentNodeCommandOptions): AgentNodeCommands {
  return {
    open: input =>
      options.store.emit({
        commandId: input.commandId,
        protocol: AGENT_PROTOCOL,
        version: AGENT_VERSION,
        kind: AGENT_KINDS.opened,
        subject: input.agentId,
        payload: { agentId: input.agentId, role: input.role, sessionId: input.sessionId },
      }) as Promise<Envelope>,
  }
}
