import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { asyncRefusalOf, refusalOf } from '../../tests/fixtures.ts'
import { createCampaignBudget, nativeTokensOf } from '../src/budget.ts'
import { bindCaller, openApparatus } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { contractFor } from '../src/inputs.ts'
import { loadMethod, seedMethod } from '../src/method.ts'
import { proposalCostOf, taskSessionsOf } from '../src/evaluation-cost.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { attachmentsAt, FakePersistence } from './seam.ts'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.()
  cleanup = undefined })
const message = (seq: number, totalTokens: number): SessionEvent => ({ seq, type: 'assistant/message', data: { usage: { totalTokens }, stream: [] } }) as unknown as SessionEvent
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-budget-'))
  const apparatus = await openApparatus('budget', root, await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess), new FakePersistence() as unknown as SessionPersistence, attachmentsAt(root),
  )
  cleanup = async () => { await apparatus.store.close()
    await rm(root, { recursive: true, force: true }) }
  return { apparatus, budget: createCampaignBudget(apparatus, { nativeTokens: 100 }) }
}
it('counts native provider attempts, and refuses unknown usage instead of guessing', () => {
  const attempt = { seq: 1, type: 'assistant/attempt', data: { stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { totalTokens: 13 } } }] },
  } as unknown as SessionEvent
  expect(nativeTokensOf([message(0, 7), attempt])).toBe(20)
  expect(refusalOf(() => nativeTokensOf([{ seq: 0, type: 'assistant/attempt', data: { stream: [] } } as unknown as SessionEvent]),
    ).detail,
  ).toContain('unknown')
})
it('deduplicates session sequence positions and caps output before reaching the provider', async () => {
  const { budget } = await fixture()
  budget.observe('root', message(0, 60))
  budget.observe('root', message(0, 60))
  budget.observe('child', message(0, 10))
  expect(budget.beforeRequest(100)).toBe(30)
  budget.observe('root', message(1, 30))
  expect(refusalOf(() => budget.beforeRequest(1)).code).toBe('budget-exhausted')
})
it('charges an explicit upper bound only for its missing event and keeps actual usage strict', async () => {
  const { apparatus } = await fixture()
  const reservation = { sessionId: 'cancelled', seq: 602, tokens: 30 }
  const budget = createCampaignBudget(apparatus, { nativeTokens: 100, unknownUsageReservations: [reservation] })
  const missing = { seq: 602, type: 'assistant/attempt', data: { stream: [] } } as unknown as SessionEvent
  expect(budget.report().reservedTokens).toBe(0)
  budget.observe('cancelled', missing)
  budget.observe('cancelled', missing)
  budget.observe('clean', message(0, 20))
  expect(budget.report()).toEqual({ tokens: 50, knownTokens: 20, reservedTokens: 30, reservations: [reservation], unknown: [],
  })
  expect(budget.beforeRequest(100)).toBe(50)
  expect(refusalOf(() => nativeTokensOf([missing])).detail).toContain('unknown')
  budget.observe('other-session', missing)
  expect(budget.report().unknown).toEqual([{ sessionId: 'other-session', seq: 602 }])
  expect(refusalOf(() => budget.beforeRequest(1)).detail).toContain('unknown')
  budget.observe('other-session', message(602, 5))
  budget.observe('cancelled', message(602, 10))
  expect(budget.report()).toEqual({ tokens: 35, knownTokens: 35, reservedTokens: 0, reservations: [], unknown: [] })
})
it('rejects duplicate or nonpositive reservations and charges the upper bound against the original budget', async () => {
  const { apparatus } = await fixture()
  const held = { sessionId: 'cancelled', seq: 2, tokens: 100 }
  expect(refusalOf(() => createCampaignBudget(apparatus, { nativeTokens: 100, unknownUsageReservations: [held, held] })).code,
  ).toBe('malformed-declaration')
  expect(refusalOf(() => createCampaignBudget(apparatus, { nativeTokens: 100, unknownUsageReservations: [{ ...held, tokens: 0 }] }),
    ).code,
  ).toBe('malformed-declaration')
  const budget = createCampaignBudget(apparatus, { nativeTokens: 100, unknownUsageReservations: [held] })
  budget.observe('cancelled', { seq: 2, type: 'assistant/attempt', data: { stream: [] } } as unknown as SessionEvent)
  expect(refusalOf(() => budget.beforeRequest(1)).code).toBe('budget-exhausted')
})
it('retains an actual input-caused overrun and blocks the next request', async () => {
  const { budget } = await fixture()
  budget.observe('root', message(0, 105))
  expect(budget.report().tokens).toBe(105)
  expect(refusalOf(() => budget.beforeRequest(1)).code).toBe('budget-exhausted')
})
it('refuses an output cap outside the remaining allowance before provider I/O', async () => {
  const { budget } = await fixture()
  budget.observe('root', message(0, 90))
  const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
  const request = { sessionId: 'root', maxTokens: 11 } as GenerateOptions
  const invoke = async () => { for await (const _chunk of budget.stream(request, next, () => undefined)) {} }
  expect((await asyncRefusalOf(invoke)).code).toBe('budget-exhausted')
  expect(next).not.toHaveBeenCalled()
})
it('stops on an unaccounted provider attempt before another request can begin', async () => {
  const { budget } = await fixture()
  const stop = vi.fn()
  const request = { sessionId: 'root', maxTokens: 10 } as GenerateOptions
  const unknown = async function* () { yield { type: 'finish', reason: { kind: 'error' } } as StreamChunk }
  const invoke = async () => { for await (const _chunk of budget.stream(request, unknown, stop)) {} }
  expect((await asyncRefusalOf(invoke)).detail).toContain('unknown')
  expect(stop).toHaveBeenCalled()
  expect(budget.report().tokens).toBeNull()
  expect(refusalOf(() => budget.beforeRequest(1)).detail).toContain('unknown')
})
it('counts an observed stream usage exactly once when its native event commits', async () => {
  const { budget } = await fixture()
  const stop = vi.fn()
  const request = { sessionId: 'root', maxTokens: 10 } as GenerateOptions
  const measured = async function* () {
    yield { type: 'usage', usage: { totalTokens: 15 } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
  for await (const _chunk of budget.stream(request, measured, stop)) {}
  expect(budget.report().tokens).toBe(15)
  budget.observe('root', message(0, 15))
  expect(budget.report().tokens).toBe(15)
})
it('freezes actual proposal subtree costs and splits them without adding an asset admission phase', async () => {
  const { apparatus } = await fixture()
  const method = await seedMethod(apparatus)
  const loaded = (await loadMethod(apparatus, method)).domain
  const template = loaded.templates.get(loaded.rootTemplate)!
  for (const id of ['proposer', 'programmer']) {
    const caller = { agentId: `${id}-agent`, sessionId: `${id}-session`, model: { provider: 'test', model: 'model' } }
    await bindCaller(apparatus, caller)
    const commands = apparatus.tasks.forAgent(caller.agentId)
    await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: contractFor(loaded, template, template.goal),
    })
    await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId: caller.agentId })
    await startAttempt(apparatus, caller, id, `run:${id}`, method)
  }
  await apparatus.tasks.forAgent('proposer-agent').decompose({ commandId: 'delegate', parentTaskId: 'proposer',
    children: [{ taskId: 'programmer', supports: [template.criterion.criterionId], dependsOn: [], maxRuns: 1 }],
    })
  const usages = new Map([['proposer-session', 10], ['programmer-session', 20],
  ])
  vi.spyOn(apparatus.persistence, 'open').mockImplementation(async (id) => ({
    read: async () => ({ events: [message(0, usages.get(String(id))!)] }), close: async () => undefined,
  }) as never,
  )
  expect(taskSessionsOf(apparatus, 'proposer')).toEqual(new Set(usages.keys()))
  const cost = await proposalCostOf(apparatus, 'proposer-session', ['candidate-one', 'candidate-two'])
  expect(cost.tokens).toBe(30)
  expect(cost.sessions.map((held) => held.sessionId)).toEqual(['proposer-session', 'programmer-session'])
})
