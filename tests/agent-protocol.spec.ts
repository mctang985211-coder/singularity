/**
 * The agent protocol: a node that references a real DSH session.
 *
 * What this spec pins is deliberately narrow, because E3 is a reference rather than a re-modelling:
 * a node is opened once, it records the session id that recovery will resume, and it does **not**
 * claim to know whether that session is alive — a fact cannot decide that, so nothing here pretends
 * to.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_KINDS,
  AGENT_PROTOCOL,
  AGENT_ROLE,
  AGENT_VERSION,
  declareAgentProtocol,
  foldSubject,
  MemoryLog,
  ProtocolRegistry,
  type RefusalCode,
  type AgentState,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'

const AGENT = 'agent-a'
const SESSION = 'singularity:agent:agent-a'
const SUBJECTS = { [AGENT_ROLE]: 'runtime-1' }

function agentRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  declareAgentProtocol(registry)
  return registry
}

function open(overrides: Partial<{ agentId: string; role: string; sessionId: string }> = {}) {
  return { agentId: AGENT, role: 'worker', sessionId: SESSION, ...overrides }
}

async function opened(): Promise<MemoryLog> {
  const log = new MemoryLog(agentRegistry(), { subjects: SUBJECTS })
  await log.emit({ commandId: 'open', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: AGENT, payload: open() })
  return log
}

describe('an agent node references a session', () => {
  it('records the session id recovery will resume, and opens once', async () => {
    const registry = agentRegistry()
    const log = await opened()

    const state = foldSubject<AgentState>(registry, log.entries(), AGENT_PROTOCOL, AGENT_VERSION, AGENT)
    expect(state).toMatchObject({ sessionId: SESSION, role: 'worker', openedAt: expect.any(String) })

    // A second open is refused rather than silently re-pointing the node at another session.
    const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'open-again', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: AGENT, payload: open({ sessionId: 'elsewhere' }) }))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('once') })
  })

  it('refuses a node whose payload disagrees with its subject', async () => {
    const log = await opened()
    const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'mismatch', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: 'agent-other', payload: open() }))
    expect(refusal).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('one node has one id') })
  })

  it('refuses an incomplete node and an unknown member, each by name', async () => {
    for (const [label, payload] of [
      ['an empty session id', open({ sessionId: '' })],
      ['an empty role', open({ role: '' })],
      ['a missing agent id', { role: 'worker', sessionId: SESSION }],
      ['an unknown member', { ...open(), note: 'extra' }],
    ] as const) {
      const log = new MemoryLog(agentRegistry(), { subjects: SUBJECTS })
      const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'bad', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: AGENT, payload: payload as never }))
      expect(`${label}: ${refusal.code}`).toBe(`${label}: malformed-payload`)
    }
  })

  it('refuses to open a node in a deployment with no runtime identity', async () => {
    const log = new MemoryLog(agentRegistry(), { subjects: {} })
    const refusal = await asyncRefusalOf(() => log.emit({ commandId: 'orphan', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: AGENT, payload: open() }))
    expect(refusal.code).toBe<RefusalCode>('unknown-emitter-role')
  })

  it('declares one kind, claims no conditional update, and will not read another version', () => {
    const registry = agentRegistry()
    expect([registry.kindsOf(AGENT_PROTOCOL, AGENT_VERSION), registry.conditionalOwner(), registry.ruleFor(AGENT_PROTOCOL, AGENT_VERSION, AGENT_KINDS.opened).guarantees]).toEqual([[AGENT_KINDS.opened], undefined, { appended: true }])
    // A log written by a build that knew another version is refused by name, not reinterpreted.
    expect(() => registry.specFor(AGENT_PROTOCOL, AGENT_VERSION + 1)).toThrowError(/version|declared/)
  })
})
