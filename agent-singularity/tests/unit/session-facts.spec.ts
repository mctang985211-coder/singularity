/**
 * What DSH knows about one coordination session: whether it exists, whether it
 * is live, whether its last turn ended, and whether it ever called a completion
 * tool. A reading this process cannot take stays absent — never zero.
 */
import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  flushSessions,
  readSessionFacts,
  readSessionFactsOf,
  sessionSpent,
  turnSettled,
  type CoordinationSessionFacts,
} from '../../src/coordination/session-facts.ts'

interface Fake {
  readonly ctx: Context
  readonly flush: () => number
}

function fake(input: {
  readonly live?: readonly { id: string; status?: string }[]
  readonly stored?: readonly string[]
  readonly logs?: Readonly<Record<string, readonly { type: string; data?: unknown }[]>>
  readonly persistence?: 'stat' | 'list' | 'none'
}): Fake {
  let flushes = 0
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => input.live?.find(agent => agent.id === id) },
    sessionQuery: {
      readSession: async (id: string) => {
        const events = input.logs?.[id]
        if (events === undefined) throw new Error(`no log for ${id}`)
        return { session: { id }, inheritedEventCount: 0, events }
      },
    },
    sessionPersistence:
      input.persistence === 'list'
        ? { list: async () => (input.stored ?? []).map(id => ({ header: { id } })), flush: async () => { flushes += 1 } }
        : input.persistence === 'none'
          ? {}
          : {
              stat: async (id: string) => ((input.stored ?? []).includes(id) ? { header: { id } } : undefined),
              flush: async () => { flushes += 1 },
            },
  }
  const ctx = {
    get: (name: string) => services[name],
  } as unknown as Context
  return { ctx, flush: () => flushes }
}

const turn = (type: string) => ({ type })

describe('presence', () => {
  test('a session the registry holds is live, with the status the registry reports', async () => {
    const h = fake({ live: [{ id: 's-1', status: 'running' }] })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ presence: 'live', status: 'running' })
  })

  test('a session only the store holds is stored, and one nowhere is missing', async () => {
    const h = fake({ stored: ['s-1'] })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ presence: 'stored' })
    await expect(readSessionFacts(h.ctx, 's-2')).resolves.toMatchObject({ presence: 'missing' })
  })

  test('a backend with only list() still answers presence', async () => {
    const h = fake({ stored: ['s-1'], persistence: 'list' })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ presence: 'stored' })
  })

  test('a backend that cannot be asked says missing rather than guessing', async () => {
    const h = fake({ persistence: 'none' })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ presence: 'missing' })
  })
})

describe('the turn facts', () => {
  test('a closed turn is a turn/start followed by a turn/end', async () => {
    const h = fake({ stored: ['s-1'], logs: { 's-1': [turn('turn/start'), turn('turn/end')] } })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ hasTurn: true, turnClosed: true })
  })

  test('an open turn is not closed: that is what a resume is for', async () => {
    const h = fake({ stored: ['s-1'], logs: { 's-1': [turn('turn/start')] } })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ hasTurn: true, turnClosed: false })
  })

  test('a log this process cannot read leaves the turn facts absent, so nothing is concluded from silence', async () => {
    const h = fake({ live: [{ id: 's-1', status: 'idle' }] })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ hasTurn: false, turnClosed: false })
  })

  test('a completion call is seen in the log, and only for the two completion tools', async () => {
    const h = fake({
      stored: ['s-1', 's-2'],
      logs: {
        's-1': [{ type: 'tool/call', data: { name: 'supervisor_complete' } }],
        's-2': [{ type: 'tool/call', data: { name: 'task_read' } }],
      },
    })
    await expect(readSessionFacts(h.ctx, 's-1')).resolves.toMatchObject({ completionCall: true })
    await expect(readSessionFacts(h.ctx, 's-2')).resolves.toMatchObject({ completionCall: false })
  })
})

describe('the readings that gate an action', () => {
  test('only a materialized session spends the allowance', () => {
    expect(sessionSpent(undefined)).toBe(false)
    expect(sessionSpent({ sessionId: 's', presence: 'missing', hasTurn: false, turnClosed: true, completionCall: false })).toBe(false)
    expect(sessionSpent({ sessionId: 's', presence: 'stored', hasTurn: true, turnClosed: false, completionCall: false })).toBe(true)
  })

  test('a turn is settled only when it ended and nothing is running in it', () => {
    const facts = (status?: 'idle' | 'running'): CoordinationSessionFacts => ({
      sessionId: 's',
      presence: 'live',
      ...(status === undefined ? {} : { status }),
      hasTurn: true,
      turnClosed: true,
      completionCall: false,
    })
    expect(turnSettled(facts('running'))).toBe(false)
    expect(turnSettled(facts('idle'))).toBe(true)
    expect(turnSettled(facts())).toBe(true)
    expect(turnSettled(undefined)).toBe(false)
  })
})

describe('several sessions and the flush barrier', () => {
  test('reads a set once, and asks the store to flush when it can', async () => {
    const h = fake({ live: [{ id: 's-1', status: 'idle' }], stored: ['s-2'] })
    const all = await readSessionFactsOf(h.ctx, ['s-1', 's-2', 's-1'])
    expect([...all.keys()].sort()).toEqual(['s-1', 's-2'])
    await flushSessions(h.ctx)
    expect(h.flush()).toBe(1)
  })

  test('a deployment with no persistence flush is not an error', async () => {
    const h = fake({ persistence: 'none' })
    await expect(flushSessions(h.ctx)).resolves.toBeUndefined()
  })
})
