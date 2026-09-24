/**
 * The bounds and the vocabulary themselves (A2 §D/§6/§7): one 16 KiB constant,
 * one closed set of refusal names, and the rule that no read — reference list
 * included — can put more than the bound in front of a model.
 */

import { describe, expect, test } from 'vitest'
import { CONTEXT_OUTPUT_LIMIT_BYTES, NAMED_REFUSALS, utf8Bytes } from '../../src/index.ts'
import { FixtureStack, seedChain, type Chain } from '../support/stack.ts'
import { expectOk, expectRefused } from '../support/stack.ts'

async function chainStack(): Promise<{ stack: FixtureStack; chain: Chain }> {
  const stack = new FixtureStack()
  const chain = await seedChain(stack)
  return { stack, chain }
}

describe('the output bound', () => {
  test('is one constant, and every read stays inside it', async () => {
    const { stack } = await chainStack()
    expect(CONTEXT_OUTPUT_LIMIT_BYTES).toBe(16 * 1024)
    const reads = [
      expectOk(await stack.service.taskRead('s-c1')),
      expectOk(await stack.service.taskRead('s-root')),
      expectOk(await stack.service.taskStatus('s-g1')),
      expectOk(await stack.service.taskStatus('s-g1', { scope: 'graph' })),
      expectOk(await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' })),
      expectOk(await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-c1' })),
      expectOk(await stack.service.contractProjection('s-g1')),
      expectOk(await stack.service.dynamicProjection('s-g1')),
    ]
    for (const read of reads) expect(utf8Bytes(read.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
  })

  test('a handoff with more references than fit names what it did not show', async () => {
    const { stack, chain } = await chainStack()
    stack.member(chain.graph, 's-refs')
    stack.sessionLog('s-refs', ['request'])
    await stack.seed({
      taskId: 't-refs',
      sessionId: 's-refs',
      runId: 'r-refs',
      objective: 'a task with a very long reference list',
      parentTaskId: 't-root',
      depth: 1,
    })
    await stack.handoff({
      parentTaskId: 't-root',
      parentRunId: 'r-root',
      childTaskId: 't-refs',
      sessionId: chain.rootSession,
      parentObjective: 'build the release',
      reason: 'the reference list is longer than the bound',
      artifacts: Array.from({ length: 400 }, (_, index) => ({
        artifactId: `a-${String(index).padStart(3, '0')}`,
        kind: 'fixture',
        uri: `out/fixture-${String(index).padStart(3, '0')}.bin`,
      })),
      evidence: Array.from({ length: 400 }, (_, index) => `e-${String(index).padStart(3, '0')}`),
    })
    const projection = await stack.service.contractProjection('s-refs')
    if (projection.ok) {
      expect(utf8Bytes(projection.text)).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT_BYTES)
      // Nothing is dropped silently: the list says how many entries it did not show.
      expect(projection.text).toContain('more handoff artifact references not shown')
      expect(projection.text).toContain('more handoff evidence references not shown')
    } else {
      // The other honest answer: the core does not fit, so the whole projection
      // is refused rather than cut.
      expect(projection.refusal).toBe('context-too-large')
    }
  })
})

describe('the named vocabulary', () => {
  test('is exactly the eight names the contract fixes', () => {
    expect([...NAMED_REFUSALS]).toEqual([
      'not-activated',
      'unbound',
      'binding-conflict',
      'cross-graph',
      'not-found',
      'stale-reference',
      'unreadable',
      'context-too-large',
    ])
  })

  test('every refusal a read answers with comes from that set', async () => {
    const { stack } = await chainStack()
    const refusals = [
      await stack.service.taskRead('s-stranger'),
      await stack.service.taskRead('s-bystander-unpublished'),
      await stack.service.contextRead('s-g1', { kind: 'task', ref: 't-nope' }),
      await stack.service.contextRead('s-g1', { kind: 'session', ref: 's-stranger' }),
    ]
    for (const result of refusals) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(NAMED_REFUSALS).toContain(result.refusal)
    }
  })
})

describe('cancellation', () => {
  test('an aborted signal stops a read instead of answering it', async () => {
    const { stack } = await chainStack()
    const controller = new AbortController()
    controller.abort()
    await expect(stack.service.taskRead('s-g1', controller.signal)).rejects.toThrow()
    await expect(stack.service.contextRead('s-g1', { kind: 'task', ref: 't-root' }, controller.signal)).rejects.toThrow()
    expect(expectRefused(await stack.service.taskRead('s-stranger'), 'unbound')).toBeDefined()
  })
})
