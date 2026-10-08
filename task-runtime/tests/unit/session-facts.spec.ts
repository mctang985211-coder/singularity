import { describe, expect, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { HUMAN_TOOLS, decompositionMatches, sessionFactsOf, skillNameFrom, toolResultFailed } from '../../src/session-facts.ts'

/**
 * The one session-log parser: every fact a reader needs — the review record's
 * dimensions, a Run's execution receipt, the consumption evidence of a template
 * — is derived here, so the same log cannot be read two ways.
 */

const events = (list: readonly unknown[]): readonly SessionEvent[] => list as unknown as readonly SessionEvent[]

describe('session facts from one log', () => {
  test('records injected frozen Task methods as loaded skills, without inventing tool calls', () => {
    const facts = sessionFactsOf(events([
      { type: 'user/message', data: { source: { kind: 'task-skills', form: 'instructions', names: ['bound-method'] } } },
      { type: 'user/message', data: { source: { kind: 'user', names: ['ordinary-text'] } } },
    ]))
    expect(facts.skillCalls).toEqual(['bound-method'])
    expect(facts.toolCalls).toEqual({ calls: [], failures: 0 })
    expect(facts.logEvents).toBe(2)
  })

  test('counts only a successful result for the matching Skill call', () => {
    const facts = sessionFactsOf(events([
      { type: 'tool/call', data: { callId: 'ok', name: 'skill', arguments: '{"name":"loaded-method"}' } },
      { type: 'tool/call', data: { callId: 'failed', name: 'skill', arguments: '{"name":"failed-method"}' } },
      { type: 'tool/call', data: { callId: 'pending', name: 'skill', arguments: '{"name":"unresolved-method"}' } },
      { type: 'tool/call', data: { callId: 'empty', name: 'skill', arguments: '{"name":"unproven-method"}' } },
      { type: 'tool/result', data: { callId: 'empty' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'failed' }, isError: true } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'unrelated' }, isError: false } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'ok' }, isError: false } } },
    ]))
    expect(facts.skillCalls).toEqual(['loaded-method'])
    expect(facts.toolCalls).toEqual({ calls: [{ name: 'skill', count: 4 }], failures: 1 })
  })

  test('a request header becomes one deduplicated identity with its count', () => {
    const header = (provider: string, model: string, maxTokens?: number): unknown => ({
      type: 'request/header',
      data: { header: { config: { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) } } },
    })
    const facts = sessionFactsOf(events([header('anthropic', 'claude'), header('anthropic', 'claude'), header('openai', 'gpt', 4096)]))
    expect(facts.modelRequests).toEqual([
      { identity: { provider: 'anthropic', model: 'claude' }, count: 2 },
      { identity: { provider: 'openai', model: 'gpt', maxTokens: 4096 }, count: 1 },
    ])
  })

  test('a decomposition call is observed only with its successful result text', () => {
    const facts = sessionFactsOf(events([
      { type: 'tool/call', data: { callId: 'c1', name: 'task_decompose', arguments: '{"templateRef":{"id":"recipe","version":1,"digest":"d"},"templateParameters":{}}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c1' }, isError: false, content: [{ type: 'text', text: 'admitted batch b-run-p1' }] } } },
      { type: 'tool/call', data: { callId: 'c2', name: 'task_decompose', arguments: '{"reason":"a free-form split"}' } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'c2' }, isError: true, content: [{ type: 'text', text: 'refused' }] } } },
    ]))
    expect(facts.decompositions).toHaveLength(2)
    expect(facts.decompositions?.[0]).toMatchObject({ callId: 'c1', resultText: 'admitted batch b-run-p1' })
    expect(facts.decompositions?.[1]?.resultText).toBeUndefined()
    const wanted = { templateRef: { id: 'recipe', version: 1, digest: 'd' }, templateParameters: {} }
    expect(decompositionMatches(facts.decompositions![0]!, wanted, ['b-run-p1'])).toBe(true)
    expect(decompositionMatches(facts.decompositions![0]!, wanted, ['another-batch'])).toBe(false)
    expect(decompositionMatches(facts.decompositions![1]!, wanted, ['b-run-p1'])).toBe(false)
  })

  test('human interventions count the human tools and the approvals, and the last event time is recorded', () => {
    const facts = sessionFactsOf(events([
      { type: 'tool/call', data: { callId: 'a', name: 'hitl_ask', arguments: '{}' } },
      { type: 'approval/asked', data: { callId: 'b' } },
      { type: 'compaction/start', data: {}, time: 1757000000000 },
    ]))
    expect(facts.humanInterventions).toBe(2)
    expect(facts.compactions).toBe(1)
    expect(facts.lastEventAt).toBe(new Date(1757000000000).toISOString())
    expect(HUMAN_TOOLS.has('hitl_approve')).toBe(true)
  })

  test('an empty log is not an unreadable one', () => {
    expect(sessionFactsOf([]).logEvents).toBe(0)
    expect(sessionFactsOf([]).lastEventAt).toBeUndefined()
  })

  test('the failure and skill-name readers judge the same shapes the log writes', () => {
    expect(toolResultFailed({ error: 'boom' })).toBe(true)
    expect(toolResultFailed({ message: { isError: true } })).toBe(true)
    expect(toolResultFailed({ message: { isError: false } })).toBe(false)
    expect(skillNameFrom('{"name":"x"}')).toBe('x')
    expect(skillNameFrom('not json')).toBeUndefined()
    expect(skillNameFrom('{"name":""}')).toBeUndefined()
  })
})
