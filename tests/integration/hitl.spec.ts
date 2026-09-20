import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import UserQuestionService from '../../../../thirdparty/deepseek-harness/packages/interaction/user-questions/lib/index.js'
import { expect, it } from 'vitest'
import { HitlService } from '../../agent-singularity/src/hitl.ts'

function bridge() {
  const ctx = new Context()
  const hitl = new HitlService(ctx)
  return { ctx, hitl }
}

it('bridges a native user-questions ask onto the canvas pending list and back', async () => {
  const { ctx, hitl } = bridge()
  await ctx.plugin(UserQuestionService)
  const changes: unknown[] = []
  ctx.on('hitl/change', pending => changes.push(pending))
  const controller = new AbortController()

  const asking = ctx.userQuestions.ask({
    questions: [{ id: 'q1', question: 'Which repo?' }],
    signal: controller.signal,
  })

  // The question is visible to the canvas the moment the waterfall is claimed.
  const [{ id, kind, prompt }] = hitl.list()
  expect(kind).toBe('ask')
  expect(prompt).toBe('Which repo?')
  expect(changes).toHaveLength(1)

  hitl.answer(id, { kind: 'ask', text: 'buckyball' })
  await expect(asking).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'buckyball' }] })
  expect(hitl.list()).toEqual([])
})

it('rejects invalid answers without consuming the pending request', async () => {
  const { ctx, hitl } = bridge()
  await ctx.plugin(UserQuestionService)
  const controller = new AbortController()
  const asking = ctx.userQuestions.ask({
    questions: [{ id: 'q1', question: 'Which repo?' }],
    signal: controller.signal,
  })
  const [{ id }] = hitl.list()
  expect(() => hitl.answer(id, { kind: 'ask', text: '  ' })).toThrow('empty ask answer')
  expect(() => hitl.answer(id, { kind: 'approve', decision: 'approve' })).toThrow('kind mismatch')
  expect(hitl.list()).toHaveLength(1)
  hitl.answer(id, { kind: 'ask', text: 'buckyball' })
  await expect(asking).resolves.toBeDefined()
  expect(hitl.list()).toEqual([])
})

it('bridges a native approval request onto the canvas as an approve card', async () => {
  const { ctx, hitl } = bridge()
  const deciding = ctx.waterfall('approval/request', {
    agent: { id: 'root-session' },
    toolName: 'hitl_approve',
    reason: 'Continue?',
  } as never, () => Promise.resolve('unavailable' as const))

  const [{ id, kind, prompt, sessionId }] = hitl.list()
  expect(kind).toBe('approve')
  expect(prompt).toBe('Continue?')
  expect(sessionId).toBe('root-session')

  expect(() => hitl.answer(id, { kind: 'approve', decision: 'maybe' } as never)).toThrow('invalid approval')
  expect(hitl.list()).toHaveLength(1)
  hitl.answer(id, { kind: 'approve', decision: 'reject' })
  await expect(deciding).resolves.toBe('rejected')
  expect(hitl.list()).toEqual([])
})

it('cancels pending questions when the native ask is aborted', async () => {
  const { ctx, hitl } = bridge()
  await ctx.plugin(UserQuestionService)
  const controller = new AbortController()
  const asking = ctx.userQuestions.ask({
    questions: [{ id: 'q1', question: 'Which repo?' }],
    signal: controller.signal,
  })
  const [{ id }] = hitl.list()
  const rejected = expect(asking).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  controller.abort(new Error('agent stopped'))
  await rejected
  expect(hitl.list()).toEqual([])
  expect(() => hitl.answer(id, { kind: 'ask', text: 'too late' })).toThrow('unknown request')
})

it('delegates batches the canvas cannot present, keeping the native fail-closed path', async () => {
  const { ctx } = bridge()
  await ctx.plugin(UserQuestionService)
  const asking = ctx.userQuestions.ask({
    questions: [
      { id: 'q1', question: 'One?' },
      { id: 'q2', question: 'Two?' },
    ],
  })
  await expect(asking).rejects.toMatchObject({ code: 'NO_PROVIDER' })
})

// Stands in for api-remotes' `forwardWaterfall`, which an earlier-loaded plugin
// registers on the same waterfall: it hands the request to the browser mux and
// returns only once a client answers or delegates — with zero clients attached
// it parks the request and never calls `next()` (guide §4.2 #17).
function parkForwarder(ctx: Context, event: 'approval/request' | 'user-questions/request', parked: unknown[]) {
  ctx.on(event, (request: unknown) => {
    parked.push(request)
    return new Promise<never>(() => {})
  })
}

it('claims the approval waterfall ahead of a mux forwarder that no client can answer', async () => {
  const ctx = new Context()
  const parked: unknown[] = []
  parkForwarder(ctx, 'approval/request', parked)
  const hitl = new HitlService(ctx)

  const deciding = ctx.waterfall('approval/request', {
    agent: { id: 'root-session' },
    toolName: 'hitl_approve',
    reason: 'Continue?',
  } as never, () => Promise.resolve('unavailable' as const))

  const [{ id, prompt }] = hitl.list()
  expect(prompt).toBe('Continue?')
  expect(parked).toEqual([])
  hitl.answer(id, { kind: 'approve', decision: 'approve' })
  await expect(deciding).resolves.toBe('allowed-once')
})

it('claims a single-question ask ahead of the same parked forwarder', async () => {
  const ctx = new Context()
  const parked: unknown[] = []
  parkForwarder(ctx, 'user-questions/request', parked)
  const hitl = new HitlService(ctx)
  await ctx.plugin(UserQuestionService)

  const asking = ctx.userQuestions.ask({ questions: [{ id: 'q1', question: 'Which repo?' }] })
  const [{ id }] = hitl.list()
  expect(parked).toEqual([])
  hitl.answer(id, { kind: 'ask', text: 'buckyball' })
  await expect(asking).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'buckyball' }] })
})
