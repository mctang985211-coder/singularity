import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Diagnosis, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { startSupervisorHandoff } from '../../src/coordination/evolution-handoff.ts'
import { admitReviewAgent } from '../../src/coordination/ledger.ts'

test('an applied shared change wakes the exact delegating parents across branches, once each', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'supervisor-related-parents-'))
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', directory)
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '1')
  const storeId = 'sg-t-root'
  const diagnosis: Diagnosis = {
    diagnosisId: 'd-shared',
    taskId: 'a',
    scope: 'shared method in two branches',
    observedFailure: 'both consumers failed',
    localizedCause: 'shared Skill assumes an incorrect format',
    reviewRefs: ['a#ra', 'b#rb', 'control#rc'],
    evidenceRefs: [],
    relatedTaskIds: ['b', 'uninvestigated'],
    confidence: 'high',
    proposals: [{ targetType: 'skill', targetId: 'parse', rationale: 'correct the format' }],
  }
  const snapshot = {
    tasks: [
      { taskId: 'a', parentTaskId: 'parent-a' },
      { taskId: 'b', parentTaskId: 'parent-b' },
      { taskId: 'control', parentTaskId: 'parent-control' },
      { taskId: 'uninvestigated', parentTaskId: 'parent-other' },
    ],
    runs: [
      { runId: 'ra', taskId: 'a', parentRunId: 'pa-original' },
      { runId: 'rb', taskId: 'b', parentRunId: 'pb-original' },
      { runId: 'rc', taskId: 'control', parentRunId: 'pc-original' },
      { runId: 'pa-original', taskId: 'parent-a', sessionId: 's-parent-a' },
      { runId: 'pa-newer', taskId: 'parent-a', sessionId: 's-wrong-newer-parent' },
      { runId: 'pb-original', taskId: 'parent-b', sessionId: 's-parent-b' },
      { runId: 'pc-original', taskId: 'parent-control', sessionId: 's-control-parent' },
    ],
    reviews: [{ taskId: 'a', runId: 'ra', outcome: 'failed' }],
    diagnoses: [diagnosis],
  } as unknown as TaskSnapshot
  const messages = new Map<string, string>()
  const ensureAgentMessageDelivered = vi.fn(async (intent: { messageId: string; targetSessionId: string }) => {
    const already = messages.has(intent.messageId)
    messages.set(intent.messageId, intent.targetSessionId)
    return { status: already ? 'already-present' : 'delivered' }
  })
  const ctx = {
    task: { snapshotIn: async () => snapshot },
    evolution: {
      list: async () => [{ proposalId: 'p-shared', status: 'applied', sourceRefs: ['diagnosis:d-shared'] }],
    },
    agentRuntime: { ensureAgentMessageDelivered },
  } as unknown as Context
  try {
    // Publishing notifications remain possible when no new supervisor can be admitted.
    await admitReviewAgent(storeId, admission =>
      admission.start({ taskId: 'other', sessionId: 'spent', actor: 'root' }),
    )
    const request = {
      storeId,
      diagnosis,
      delegator: { sessionId: 'root', agent: { id: 'root' } as never },
      sourceRef: 'a#ra',
      sourceOutcome: 'failed',
    }
    expect(await startSupervisorHandoff(ctx, request)).toMatchObject({ result: 'stopped', code: 'budget-exhausted' })
    expect(await startSupervisorHandoff(ctx, request)).toMatchObject({ result: 'stopped', code: 'budget-exhausted' })
    expect([...messages.entries()]).toEqual([
      ['m-evolution-p-shared-pa-original', 's-parent-a'],
      ['m-evolution-p-shared-pb-original', 's-parent-b'],
    ])
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
