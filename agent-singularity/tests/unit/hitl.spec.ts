/**
 * The HITL seam's per-graph auto-resolution: a graph whose RSI runs without a
 * human (`rsi.humanReview === false`) never queues a card — its approval
 * resolves as approved and its question resolves with the unmanned answer —
 * while a manned graph, a session in no graph and a load without the graphs
 * registry keep the queue exactly as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import UserQuestionService from '../../../../../thirdparty/deepseek-harness/packages/interaction/user-questions/lib/index.js'
import { HitlService } from '../../src/services/hitl.ts'

const UNMANNED_ASK_ANSWER = '（无人迭代模式）无人工在线审核：请按你的最佳判断继续，保持目标不缩小，并在结果中记录你做出的假设。'

type GraphLookup = { readonly id: string; readonly rsi?: { readonly humanReview: boolean } } | 'throw' | 'absent'

/** A bridge over the native seams with the one registry answer the case needs. */
function bridge(graph: GraphLookup) {
  const ctx = new Context()
  if (graph !== 'absent') {
    ctx.provide('graphs', {
      graphForSession: async () => {
        if (graph === 'throw') throw new Error('graphs: session "s-root" is not in a graph')
        return graph
      },
    } as never)
  }
  const hitl = new HitlService(ctx)
  const changes: readonly unknown[][] = []
  ctx.on('hitl/change', pending => changes.push(pending as unknown[]))
  return { ctx, hitl, changes }
}

function approvalRequest() {
  return { agent: { id: 's-root' }, toolName: 'evolution_decide', reason: 'Record PROMOTE?' } as never
}

function askRequest() {
  return { agent: { id: 's-root' }, questions: [{ id: 'q1', question: 'Which capability?' }] } as never
}

describe('HitlService per-graph auto-resolution', () => {
  it('resolves an approval as approved in an unmanned graph, without queueing a card', async () => {
    const { ctx, hitl, changes } = bridge({ id: 'g1', rsi: { humanReview: false } })
    const outcome = await ctx.waterfall('approval/request', approvalRequest(), () => Promise.resolve('unavailable' as const))
    expect(outcome).toBe('allowed-once')
    expect(hitl.list()).toEqual([])
    // The change event fires fact-symmetrically with a human answer; the pending list never grows.
    expect(changes.every(pending => pending.length === 0)).toBe(true)
  })

  it('resolves a single-question ask with the unmanned answer text in an unmanned graph', async () => {
    const { ctx, hitl } = bridge({ id: 'g1', rsi: { humanReview: false } })
    const answer = await ctx.waterfall('user-questions/request', askRequest(), () => Promise.resolve({ answers: [] } as never))
    expect(answer).toEqual({ answers: [{ id: 'q1', selected: [], custom: UNMANNED_ASK_ANSWER }] })
    expect(hitl.list()).toEqual([])
  })

  it('logs the auto-resolution for the graph through the service logger', async () => {
    const { ctx } = bridge({ id: 'g1', rsi: { humanReview: false } })
    const lines: string[] = []
    ctx.logger.exporter({ export: message => lines.push(message.args.map(value => String(value)).join(' ')) })
    await ctx.waterfall('approval/request', approvalRequest(), () => Promise.resolve('unavailable' as const))
    expect(lines.some(line => line.includes('g1') && line.includes('unmanned'))).toBe(true)
  })

  it('still queues a card for a manned graph, and the answer settles the waiter', async () => {
    const { ctx, hitl, changes } = bridge({ id: 'g1', rsi: { humanReview: true } })
    const deciding = ctx.waterfall('approval/request', approvalRequest(), () => Promise.resolve('unavailable' as const))
    await vi.waitFor(() => expect(hitl.list()).toHaveLength(1))
    const card = hitl.list()[0]!
    expect(card.kind).toBe('approve')
    hitl.answer(card.id, { kind: 'approve', decision: 'reject' })
    await expect(deciding).resolves.toBe('rejected')
    expect(hitl.list()).toEqual([])
    expect(changes.at(-1)).toEqual([])
  })

  it.each([['a session in no graph', 'throw' as const], ['a missing registry', 'absent' as const], ['an unset humanReview', { id: 'g1' }]])(
    'queues a card for %s',
    async (_label, graph) => {
      const { ctx, hitl } = bridge(graph as GraphLookup)
      const deciding = ctx.waterfall('approval/request', approvalRequest(), () => Promise.resolve('unavailable' as const))
      await vi.waitFor(() => expect(hitl.list()).toHaveLength(1))
      hitl.answer(hitl.list()[0]!.id, { kind: 'approve', decision: 'approve' })
      await expect(deciding).resolves.toBe('allowed-once')
      expect(hitl.list()).toEqual([])
    },
  )

  it('queues a card synchronously when the registry is absent, exactly as before', async () => {
    const { ctx, hitl } = bridge('absent')
    const deciding = ctx.waterfall('approval/request', approvalRequest(), () => Promise.resolve('unavailable' as const))
    expect(hitl.list()).toHaveLength(1)
    hitl.answer(hitl.list()[0]!.id, { kind: 'approve', decision: 'approve' })
    await expect(deciding).resolves.toBe('allowed-once')
  })
})

describe('HitlService over user-questions in a manned graph', () => {
  it('keeps the native single-question bridge and settles it from a human answer', async () => {
    const ctx = new Context()
    ctx.provide('graphs', { graphForSession: async () => ({ id: 'g1', rsi: { humanReview: true } }) } as never)
    const hitl = new HitlService(ctx)
    await ctx.plugin(UserQuestionService)
    const asking = ctx.userQuestions.ask({ questions: [{ id: 'q1', question: 'Which repo?' }] })
    await vi.waitFor(() => expect(hitl.list()).toHaveLength(1))
    hitl.answer(hitl.list()[0]!.id, { kind: 'ask', text: 'buckyball' })
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'buckyball' }] })
  })

  it('auto-answers a native single-question ask in an unmanned graph', async () => {
    const ctx = new Context()
    ctx.provide('graphs', { graphForSession: async () => ({ id: 'g1', rsi: { humanReview: false } }) } as never)
    const hitl = new HitlService(ctx)
    await ctx.plugin(UserQuestionService)
    const asking = ctx.userQuestions.ask({ questions: [{ id: 'q1', question: 'Which repo?' }] })
    await expect(asking).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: UNMANNED_ASK_ANSWER }] })
    expect(hitl.list()).toEqual([])
  })
})
