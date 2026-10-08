import { describe, expect, test } from 'vitest'
import type { ExecutionReceipt, ReviewTokenUsage, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { executionUsage } from '../../src/receipt.ts'

/**
 * The usage one receipt covers: the口径 of a run subtree's tokens and tool
 * calls. Its members are the ones the receipt froze — a replay admitted after
 * the sealing is not counted into a run that had already settled.
 */

const NOW = '2026-10-08T00:00:00.000Z'

function run(runId: string, parentRunId?: string): TaskRun {
  return {
    runId,
    taskId: 't1',
    sessionId: `s-${runId}`,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    capabilitySnapshot: [],
    environmentRevisionId: 'r0001',
    artifacts: [],
    verifierResults: [],
    status: 'verified',
    startedAt: NOW,
    finishedAt: NOW,
  }
}

function snapshotOf(runs: readonly TaskRun[], reviews: readonly { runId: string; tokens?: ReviewTokenUsage; calls?: { calls: number; failures: number } }[]): TaskSnapshot {
  return {
    version: 1,
    id: 'sg-t-root',
    tasks: [{ taskId: 't1' }],
    runs,
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: reviews.map(entry => ({
      taskId: 't1',
      runId: entry.runId,
      outcome: 'verified',
      evidenceRefs: [],
      anomalies: [],
      ...(entry.tokens === undefined && entry.calls === undefined
        ? {}
        : { metrics: { ...(entry.tokens === undefined ? {} : { tokens: entry.tokens }), ...(entry.calls === undefined ? {} : { toolCalls: entry.calls }) } }),
    })),
    diagnoses: [],
    obligations: [],
    capabilities: {},
  } as unknown as TaskSnapshot
}

function receiptOf(subtree: readonly string[]): ExecutionReceipt {
  return { runId: subtree[0], subtree } as unknown as ExecutionReceipt
}

const TOKENS: ReviewTokenUsage = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }

describe('the usage a receipt covers', () => {
  test('every terminal member with whole counters aggregates into one reported reading', () => {
    const snapshot = snapshotOf(
      [run('r1'), run('r2', 'r1'), run('r3', 'r2')],
      [
        { runId: 'r1', tokens: TOKENS, calls: { calls: 2, failures: 1 } },
        { runId: 'r2', tokens: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, calls: { calls: 3, failures: 0 } },
        { runId: 'r3', tokens: { uncachedInputTokens: 4, outputTokens: 4, cacheReadTokens: 4, cacheWriteTokens: 4 }, calls: { calls: 1, failures: 0 } },
      ],
    )
    const usage = executionUsage(snapshot, receiptOf(['r1', 'r2', 'r3']))
    expect(usage.status).toBe('reported')
    expect(usage.runIds).toEqual(['r1', 'r2', 'r3'])
    expect(usage.tokens).toEqual({ uncachedInputTokens: 15, outputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 5 })
    expect(usage.toolCalls).toEqual({ calls: 6, failures: 1 })
    expect(usage.incompleteRuns).toEqual([])
  })

  test('a member missing one counter leaves only that side absent, and names the run', () => {
    const snapshot = snapshotOf([run('r1'), run('r2', 'r1')], [
      { runId: 'r1', tokens: TOKENS },
      { runId: 'r2', tokens: TOKENS, calls: { calls: 2, failures: 0 } },
    ])
    const usage = executionUsage(snapshot, receiptOf(['r1', 'r2']))
    // Both members reported their tokens, so the token side is whole; one member
    // never reported its calls, so that side is absent rather than guessed at.
    expect(usage.status).toBe('reported')
    expect(usage.tokens).toEqual({ uncachedInputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 })
    expect(usage.toolCalls).toBeUndefined()
    expect(usage.incompleteRuns).toEqual(['r1'])
  })

  test('neither side complete is unknown, and says which run it could not read', () => {
    const snapshot = snapshotOf([run('r1')], [{ runId: 'r1' }])
    const usage = executionUsage(snapshot, receiptOf(['r1']))
    expect(usage.status).toBe('unknown')
    expect(usage.reason).toMatch(/r1/)
    expect(usage.tokens).toBeUndefined()
    expect(usage.toolCalls).toBeUndefined()
  })

  test('a member that is not terminal makes its counters incomplete', () => {
    const running = { ...run('r1'), status: 'running' as const, finishedAt: undefined }
    const snapshot = snapshotOf([running as TaskRun], [{ runId: 'r1', tokens: TOKENS, calls: { calls: 1, failures: 0 } }])
    const usage = executionUsage(snapshot, receiptOf(['r1']))
    expect(usage.status).toBe('unknown')
    expect(usage.incompleteRuns).toEqual(['r1'])
  })

  test('the frozen subtree is what counts: a replay admitted later is not part of it', () => {
    const sealed = receiptOf(['r1'])
    const before = snapshotOf([run('r1')], [{ runId: 'r1', tokens: TOKENS, calls: { calls: 1, failures: 0 } }])
    const first = executionUsage(before, sealed)
    // A replay writes its run as a descendant of the sealed run after the sealing.
    const after = snapshotOf(
      [run('r1'), run('r-replay', 'r1')],
      [
        { runId: 'r1', tokens: TOKENS, calls: { calls: 1, failures: 0 } },
        { runId: 'r-replay', tokens: TOKENS, calls: { calls: 9, failures: 9 } },
      ],
    )
    const second = executionUsage(after, sealed)
    expect(second).toEqual(first)
    expect(second.runIds).toEqual(['r1'])
    expect(second.toolCalls).toEqual({ calls: 1, failures: 0 })
  })
})
