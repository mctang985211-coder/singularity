import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionReceipt, ReviewTokenUsage, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { TERMINAL_RUN_STATUSES } from '../../task/src/index.ts'
import { executionUsage, requireReceiptFacts } from '../../task-runtime/src/receipt.ts'
import { pinSkillHome, releaseSkillHomes } from '../../task-runtime/tests/support/skill-roots.ts'
import { harness, createRoot, ROOT_SESSION, STORE } from '../../task-runtime/tests/unit/orchestrate.fixture.ts'

/**
 * Consumer parity (plan §5): the reading a consumer takes from a receipt is the
 * one the deleted implementations took from the session log and from the run
 * subtree, including every unknown branch. The reference below is the
 * pre-replacement algorithm verbatim — the walk over `parentRunId` plus the
 * review record's own metrics that `evolution/src/experiment/record.ts:costOf`
 * and `rsi-loop.costFeedback` each carried — and the assertion is that the
 * receipt's reading has not moved.
 */

const NOW = '2026-10-08T00:00:00.000Z'

/** The pre-replacement口径: walk `parentRunId` downwards and sum the review metrics. */
function referenceUsage(snapshot: TaskSnapshot, rootRunId: string): {
  status: 'reported' | 'unknown'
  tokens?: ReviewTokenUsage
  toolCalls?: { calls: number; failures: number }
} {
  const root = snapshot.runs.find(run => run.runId === rootRunId)
  if (root === undefined) return { status: 'unknown' }
  const runIds = new Set([root.runId])
  let size = 0
  while (size !== runIds.size) {
    size = runIds.size
    for (const run of snapshot.runs) if (run.parentRunId !== undefined && runIds.has(run.parentRunId)) runIds.add(run.runId)
  }
  let calls = 0
  let failures = 0
  let completeCalls = true
  let completeTokens = true
  const tokens: ReviewTokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const run of snapshot.runs.filter(item => runIds.has(item.runId))) {
    const record = snapshot.reviews.find(item => item.runId === run.runId && item.taskId === run.taskId)
    const counters = record?.metrics?.toolCalls
    if (!TERMINAL_RUN_STATUSES.has(run.status) || counters === undefined ||
      !Number.isSafeInteger(counters.calls) || counters.calls < 0 ||
      !Number.isSafeInteger(counters.failures) || counters.failures < 0) completeCalls = false
    else {
      calls += counters.calls
      failures += counters.failures
    }
    const usage = record?.metrics?.tokens
    if (!TERMINAL_RUN_STATUSES.has(run.status) || usage === undefined ||
      Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) completeTokens = false
    else for (const key of Object.keys(tokens) as (keyof ReviewTokenUsage)[]) tokens[key] += usage[key]
  }
  if (!completeCalls && !completeTokens) return { status: 'unknown' }
  return {
    status: 'reported',
    ...(completeTokens ? { tokens } : {}),
    ...(completeCalls ? { toolCalls: { calls, failures } } : {}),
  }
}

function run(runId: string, parentRunId?: string, status: TaskRun['status'] = 'verified'): TaskRun {
  return {
    runId,
    taskId: 't1',
    sessionId: `s-${runId}`,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    capabilitySnapshot: [],
    environmentRevisionId: 'r0001',
    artifacts: [],
    verifierResults: [],
    status,
    startedAt: NOW,
    ...(status === 'running' ? {} : { finishedAt: NOW }),
  }
}

function snapshotOf(runs: readonly TaskRun[], metrics: readonly { runId: string; tokens?: ReviewTokenUsage; calls?: { calls: number; failures: number } }[]): TaskSnapshot {
  return {
    version: 1,
    id: STORE,
    tasks: [{ taskId: 't1' }],
    runs,
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: metrics.map(entry => ({
      taskId: 't1',
      runId: entry.runId,
      outcome: 'verified',
      evidenceRefs: [],
      anomalies: [],
      metrics: {
        ...(entry.tokens === undefined ? {} : { tokens: entry.tokens }),
        ...(entry.calls === undefined ? {} : { toolCalls: entry.calls }),
      },
    })),
    diagnoses: [],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot
}

const receiptOf = (subtree: readonly string[]): ExecutionReceipt => ({ runId: subtree[0], subtree }) as unknown as ExecutionReceipt
const TOKENS: ReviewTokenUsage = { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 }

let home: string
beforeEach(() => {
  home = pinSkillHome('task-execution')
})
afterEach(async () => {
  releaseSkillHomes()
  await rm(home, { recursive: true, force: true })
})

describe('the usage a consumer reads has not moved', () => {
  it('a complete subtree reads the same numbers as the pre-replacement walk', () => {
    const snapshot = snapshotOf(
      [run('r1'), run('r2', 'r1')],
      [
        { runId: 'r1', tokens: TOKENS, calls: { calls: 4, failures: 1 } },
        { runId: 'r2', tokens: TOKENS, calls: { calls: 2, failures: 0 } },
      ],
    )
    const reference = referenceUsage(snapshot, 'r1')
    const usage = executionUsage(snapshot, receiptOf(['r1', 'r2']))
    expect(usage.status).toBe('reported')
    expect(usage.tokens).toEqual(reference.tokens)
    expect(usage.toolCalls).toEqual(reference.toolCalls)
  })

  it('one missing side is absent on both readings, and the other still reports', () => {
    const snapshot = snapshotOf([run('r1')], [{ runId: 'r1', tokens: TOKENS }])
    const reference = referenceUsage(snapshot, 'r1')
    const usage = executionUsage(snapshot, receiptOf(['r1']))
    expect(reference).toMatchObject({ status: 'reported', tokens: TOKENS })
    expect((reference as { toolCalls?: unknown }).toolCalls).toBeUndefined()
    expect(usage.status).toBe('reported')
    expect(usage.tokens).toEqual(TOKENS)
    expect(usage.toolCalls).toBeUndefined()
  })

  it('neither side complete is unknown on both readings — never a fabricated zero', () => {
    const snapshot = snapshotOf([run('r1')], [{ runId: 'r1' }])
    expect(referenceUsage(snapshot, 'r1').status).toBe('unknown')
    const usage = executionUsage(snapshot, receiptOf(['r1']))
    expect(usage.status).toBe('unknown')
    expect(usage.tokens).toBeUndefined()
    expect(usage.toolCalls).toBeUndefined()
  })

  it('a member that is not terminal is unknown on both readings', () => {
    const snapshot = snapshotOf([run('r1', undefined, 'running')], [{ runId: 'r1', tokens: TOKENS, calls: { calls: 1, failures: 0 } }])
    expect(referenceUsage(snapshot, 'r1').status).toBe('unknown')
    expect(executionUsage(snapshot, receiptOf(['r1'])).status).toBe('unknown')
  })

  it('the receipt of a real sealed run reads exactly what the subtree walk reads', async () => {
    const h = harness()
    const root = await createRoot(h)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })
    const snapshot = await h.task.snapshotIn(STORE)
    const receipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(receipt).toBeDefined()
    const usage = executionUsage(snapshot, receipt!)
    const reference = referenceUsage(snapshot, root.runId)
    expect(usage.status).toBe(reference.status)
    expect(usage.tokens).toEqual(reference.tokens)
    expect(usage.toolCalls).toEqual(reference.toolCalls)
    // The harness has no live model, so both readings say "unknown" rather than zero.
    expect(usage.status).toBe('unknown')
    await h.runtime.unload()
  })
})

describe('a consumer refuses what a receipt could not establish', () => {
  it('requireReceiptFacts names the missing facts instead of assuming them', async () => {
    const h = harness()
    const root = await createRoot(h)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the round is done' })
    const receipt = (await h.runtime.receiptFor(STORE, root.runId))!
    // No session log could be read here, so the model facts are not established.
    expect(receipt.completeness.missing.map(entry => entry.fact)).toContain('session-log')
    expect(() => requireReceiptFacts(receipt, ['model-requests'], 'the comparison side')).toThrow(/the comparison side/)
    expect(() => requireReceiptFacts(receipt, ['session-log'], 'the comparison side')).toThrow(/cannot establish session-log/)
    // A fact the receipt did establish is not refused.
    expect(() => requireReceiptFacts(receipt, [], 'the comparison side')).not.toThrow()
    await h.runtime.unload()
  })
})
