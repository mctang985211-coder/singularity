/**
 * Method authority and the graph's own mode, on the real deployment. An auto
 * graph's supervisor publishes under the platform policy while the root's own
 * attempt at the pointer tool meets the execution seal. A human-review graph's
 * publish waits on the one approval card; a refusal writes nothing, and a graph
 * whose rsi configuration is cleared while the approval is open is refused by
 * the post-approval re-read rather than published under a configuration nobody
 * approved.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `TaskRuntime` and its environment pointer, the
 * real agent-runtime grant seal, and the real method ledger.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeScriptedLoops, type ScriptedLoop } from '../support/scripted-loop.ts'
import {
  ROOT,
  lastCall,
  ledgerRecords,
  settledCalls,
  startMethodChain,
  waitForCalls,
} from './method-chain.fixture.ts'

const AUTO = { task: 'keep the delivered answer method improving', iterationRounds: 4, humanReview: false }
const MANUAL = { ...AUTO, humanReview: true }

/**
 * The graph record's rsi field, as the method tools read it through the
 * registry's own lookup: the spec sets it before the chain runs and clears it
 * mid-approval, exactly the reconfiguration the publish re-read watches for.
 */
function stubGraphRsi(h: ScriptedLoop, initial: Record<string, unknown> | undefined): { clear(): void } {
  const graphs = h.ctx.get('graphs') as { graphForSession(sessionId: unknown): Promise<Record<string, unknown>> }
  const real = graphs.graphForSession.bind(graphs)
  let rsi = initial
  vi.spyOn(graphs, 'graphForSession').mockImplementation(async (sessionId: unknown) => {
    const record = await real(sessionId)
    if (rsi === undefined) {
      const { rsi: _cleared, ...rest } = record
      return rest
    }
    return { ...record, rsi }
  })
  return { clear: () => (rsi = undefined) }
}

afterEach(async () => {
  await disposeScriptedLoops()
  vi.restoreAllMocks()
})

describe('method authority and mode on the real deployment', () => {
  it('an auto graph\'s supervisor publishes under the platform policy, and the root\'s own publish meets the seal', async () => {
    const { h } = await startMethodChain({ rootPublishes: true })
    stubGraphRsi(h, AUTO)

    h.userSays('run the method chain', 's-supervisor')
    await vi.waitFor(
      () => {
        expect(settledCalls(h, 'method_publish').some(call => call.sessionId === 's-supervisor')).toBe(true)
      },
      { timeout: 30_000, interval: 100 },
    )

    const published = settledCalls(h, 'method_publish').find(call => call.sessionId === 's-supervisor')!
    expect(published.result?.isError).not.toBe(true)
    expect(published.result?.text).toContain('published: active revision c-d0001 g2')
    expect(published.result?.text).toContain('mode auto; decided by platform_policy')
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })

    // The root holds no pointer authority: its own attempt, made while its run
    // was still active, met the root allow-list's own refusal; no approval is
    // spent on it.
    const rootAttempts = settledCalls(h, 'method_publish').filter(call => call.sessionId === ROOT)
    expect(rootAttempts.length).toBeGreaterThan(0)
    for (const attempt of rootAttempts) {
      expect(attempt.result?.isError).toBe(true)
      expect(attempt.result?.text).toContain('method_draft/method_list to propose or inspect a method candidate')
    }
    expect(h.review.asks.map(ask => ask.toolName)).toEqual(['method_publish'])
    const after = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: after.revisionId, generation: after.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })
  }, 90_000)

  it('a human-review graph\'s publish waits on the one card, and a cleared rsi configuration refuses the granted switch', async () => {
    const { h } = await startMethodChain({
      approvalAnswer: ask => (ask.toolName === 'method_publish' ? undefined : 'allowed-once'),
    })
    const graphRsi = stubGraphRsi(h, MANUAL)

    h.userSays('run the method chain', 's-supervisor')
    // The publish stops at the card: one ask recorded, no result, nothing moved.
    await vi.waitFor(
      () => {
        expect(h.review.asks.map(ask => ask.toolName)).toEqual(['method_publish'])
      },
      { timeout: 30_000, interval: 100 },
    )
    expect(settledCalls(h, 'method_publish')).toHaveLength(0)
    expect(h.review.asks[0]!.sessionId).toBe('s-supervisor')
    expect(h.review.asks[0]!.reason).toContain('c-d0001')
    const waiting = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: waiting.revisionId, generation: waiting.generation }).toEqual({ revisionId: 'r0001', generation: 1 })

    // The graph's rsi configuration is cleared while the approval is open; the
    // granted answer then meets the re-read and the switch refuses.
    graphRsi.clear()
    h.review.answer(0, 'allowed-once')
    await waitForCalls(h, 'method_publish', 1)

    const call = lastCall(h, 'method_publish')
    expect(call.result?.text).toContain('no pointer moved')
    expect(call.result?.text).toContain('rsi configuration was cleared or replaced while the approval was open')
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'r0001', generation: 1 })
    expect(ledgerRecords(h).some(record => record.kind === 'published')).toBe(false)
    expect(h.review.asks).toHaveLength(1)
  }, 90_000)

  it('a refused publication approval writes nothing and asks no second time', async () => {
    const { h } = await startMethodChain({
      approvalAnswer: ask => (ask.toolName === 'method_publish' ? 'rejected' : 'allowed-once'),
    })
    stubGraphRsi(h, MANUAL)

    h.userSays('run the method chain', 's-supervisor')
    await waitForCalls(h, 'method_publish', 1)

    const call = lastCall(h, 'method_publish')
    expect(call.result?.text).toContain('no pointer moved')
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'r0001', generation: 1 })
    expect(ledgerRecords(h).some(record => record.kind === 'published')).toBe(false)
    expect(h.review.asks).toHaveLength(1)
  }, 90_000)
})
