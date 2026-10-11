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
import { openApparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { attachmentsAt, FakePersistence } from './seam.ts'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })
const message = (seq: number, totalTokens: number): SessionEvent => ({ seq, type: 'assistant/message', data: { usage: { totalTokens }, stream: [] } }) as unknown as SessionEvent
async function fixture(rootSolves = 2) {
  const root = await mkdtemp(join(tmpdir(), 'singularity-budget-'))
  const apparatus = await openApparatus('budget', root, await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess), new FakePersistence() as unknown as SessionPersistence, attachmentsAt(root))
  cleanup = async () => { await apparatus.store.close(); await rm(root, { recursive: true, force: true }) }
  return createCampaignBudget(apparatus, { rootSolves, children: 2, childRuns: 2, nativeTokens: 100 })
}
it('counts native provider attempts, and refuses unknown usage instead of guessing', () => {
  const attempt = { seq: 1, type: 'assistant/attempt', data: { stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { totalTokens: 13 } } }] } } as unknown as SessionEvent
  expect(nativeTokensOf([message(0, 7), attempt])).toBe(20)
  expect(refusalOf(() => nativeTokensOf([{ seq: 0, type: 'assistant/attempt', data: { stream: [] } } as unknown as SessionEvent])).detail).toContain('unknown')
})
it('deduplicates session sequence positions and caps output before reaching the provider', async () => {
  const budget = await fixture()
  budget.observe('root', message(0, 60))
  budget.observe('root', message(0, 60))
  budget.observe('child', message(0, 10))
  expect(budget.beforeRequest(100)).toBe(30)
  budget.observe('root', message(1, 30))
  expect(refusalOf(() => budget.beforeRequest(1)).code).toBe('budget-exhausted')
})
it('retains an actual input-caused overrun and blocks the next request', async () => {
  const budget = await fixture()
  budget.observe('root', message(0, 105))
  expect(budget.report().tokens).toBe(105)
  expect(refusalOf(() => budget.beforeRequest(1)).code).toBe('budget-exhausted')
})
it('reserves concurrent root starts before either command can commit', async () => {
  const budget = await fixture(1)
  let finish!: () => void
  const committed = new Promise<void>(resolve => { finish = resolve })
  const first = budget.startRun('root-1', 'run-1', () => committed)
  const next = vi.fn(async () => undefined)
  expect((await asyncRefusalOf(() => budget.startRun('root-2', 'run-2', next))).code).toBe('budget-exhausted')
  expect(next).not.toHaveBeenCalled()
  finish()
  await first
})
it('rejects oversized child plans before dispatching them', async () => {
  const budget = await fixture()
  expect(refusalOf(() => budget.assertPlan([{ maxRuns: 1 }, { maxRuns: 1 }, { maxRuns: 1 }])).code).toBe('budget-exhausted')
  expect(refusalOf(() => budget.assertPlan([{ maxRuns: 3 }])).code).toBe('budget-exhausted')
})
it('refuses an output cap outside the remaining allowance before provider I/O', async () => {
  const budget = await fixture()
  budget.observe('root', message(0, 90))
  const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
  const request = { sessionId: 'root', maxTokens: 11 } as GenerateOptions
  const invoke = async () => { for await (const _chunk of budget.stream(request, next, () => undefined)) {} }
  expect((await asyncRefusalOf(invoke)).code).toBe('budget-exhausted')
  expect(next).not.toHaveBeenCalled()
})
it('stops on an unaccounted provider attempt before another request can begin', async () => {
  const budget = await fixture()
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
  const budget = await fixture()
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
