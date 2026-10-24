/**
 * The agent node's command owner: the one surface that opens a node.
 *
 * The node is one fact about one agent, and the log already refuses a second one. What this spec
 * pins is that the *command* produces it in that shape: the subject is the agent id, the payload
 * names the agent, and the role is resolved by the store rather than supplied by a caller.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_KINDS,
  AGENT_PROTOCOL,
  AGENT_VERSION,
  createAgentNodeCommands,
  type AgentNodeCommands,
  type AgentState,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { AGENT, deployment } from './command-fixtures.ts'

const SESSION = `singularity:agent:${AGENT}`

describe('the agent node command', () => {
  it('opens one node keyed by the agent id, carrying the session to resume', async () => {
    const live = await deployment()
    const agents: AgentNodeCommands = createAgentNodeCommands({ store: live.store, registry: live.registry })

    const opened = await agents.open({
      commandId: 'open-1',
      agentId: AGENT,
      sessionId: SESSION,
      role: 'worker',
    })

    const node = live.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, AGENT)
    expect([opened.kind, opened.subject, node?.sessionId]).toEqual([AGENT_KINDS.opened, AGENT, SESSION])
  })

  it('refuses a second open of the same agent, leaving the first node as it was', async () => {
    const live = await deployment()
    const agents = createAgentNodeCommands({ store: live.store, registry: live.registry })
    await agents.open({ commandId: 'open-1', agentId: AGENT, sessionId: SESSION, role: 'worker' })

    const refusal = await asyncRefusalOf(() =>
      agents.open({ commandId: 'open-2', agentId: AGENT, sessionId: 'singularity:agent:second', role: 'reviewer' }),
    )

    const node = live.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, AGENT)
    expect([refusal.code, node?.sessionId]).toEqual(['illegal-transition', SESSION])
  })
})
