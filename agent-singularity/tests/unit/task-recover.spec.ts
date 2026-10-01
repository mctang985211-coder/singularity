/**
 * `task_recover`'s mode surface: the default `recovery` passes through untouched,
 * a verified source is told to ask again with `improve`, and `improve` passes
 * through for the improvement round the runtime opens.
 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defineTaskRecoverTool } from '../../src/tools/task-recover.ts'

const graph = { id: 'g1', name: 'g1', envId: 'e1', rootSessionId: 'root-1' }
const STORE = 'sg-t-root-1'

function fixture(options: { reviewOutcome?: string } = {}) {
  const calls: { request: Record<string, unknown>; caller: Record<string, unknown> }[] = []
  const snapshot = {
    version: 1 as const,
    id: STORE,
    tasks: [],
    runs: [],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [{
      taskId: 't1', runId: 'r1', outcome: options.reviewOutcome ?? 'failed', evidenceRefs: [], anomalies: [],
    }],
    diagnoses: [{
      diagnosisId: 'd-1', taskId: 't1', observedFailure: 'x', scope: 'task t1', localizedCause: 'y',
      evidenceRefs: [], reviewRefs: ['t1#r1'], confidence: 'high', proposals: [],
    }],
    obligations: [],
    capabilities: {},
  }
  const ctx = {
    graphs: { graphForSession: async () => graph },
    task: { openStore: async () => structuredClone(snapshot) },
    evolution: {
      coordinateRecovery: vi.fn(async (request: Record<string, unknown>, caller: Record<string, unknown>) => {
        calls.push({ request, caller })
        return {
          attempt: 'started',
          sourceDiagnosisId: 'd-1',
          runId: 'r2',
          sessionId: 's-run',
          status: 'running',
          handoff: { sessionId: 's-sup', actor: 's-sup', diagnosisId: 'd-1' },
          coordination: ['the round is allowed'],
          reusedMembers: [],
          unboundMembers: [],
        }
      }),
    },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const exec = { agent: { id: 's-sup' }, signal: new AbortController().signal }

describe('task_recover mode', () => {
  test('passes the default recovery through untouched and opens the attempt', async () => {
    const { ctx, calls } = fixture()
    const result = (await defineTaskRecoverTool(ctx).execute({ sourceDiagnosisId: 'd-1', requestKey: 'k-1' }, exec as never)) as string
    expect(result).toContain('a new attempt was opened')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request).toEqual({ sourceDiagnosisId: 'd-1', requestKey: 'k-1' })
    expect(calls[0]!.caller).toMatchObject({ sessionId: 's-sup' })
  })

  test('tells a caller recovering a verified source to use mode "improve", with nothing started', async () => {
    const { ctx, calls } = fixture({ reviewOutcome: 'verified' })
    const result = (await defineTaskRecoverTool(ctx).execute({ sourceDiagnosisId: 'd-1', requestKey: 'k-1' }, exec as never)) as string
    expect(result).toContain('passed its review (verified)')
    expect(result).toContain('mode: "improve"')
    expect(result).toContain('nothing was started')
    expect(calls).toEqual([])
  })

  test('passes mode "improve" through for a verified source', async () => {
    const { ctx, calls } = fixture({ reviewOutcome: 'verified' })
    const result = (await defineTaskRecoverTool(ctx).execute({ sourceDiagnosisId: 'd-1', requestKey: 'k-2', mode: 'improve' }, exec as never)) as string
    expect(result).toContain('a new attempt was opened')
    expect(calls[0]!.request).toEqual({ sourceDiagnosisId: 'd-1', requestKey: 'k-2', mode: 'improve' })
  })

  test('refuses an unknown mode and an undeclared parameter before anything runs', async () => {
    const { ctx, calls } = fixture()
    const tool = defineTaskRecoverTool(ctx)
    const unknownMode = (await tool.execute({ sourceDiagnosisId: 'd-1', requestKey: 'k-1', mode: 'retry' }, exec as never)) as string
    expect(unknownMode).toContain('is not "recovery" or "improve"')
    const undeclared = (await tool.execute({ sourceDiagnosisId: 'd-1', requestKey: 'k-1', decide: true }, exec as never)) as string
    expect(undeclared).toContain('undeclared parameter "decide"')
    expect(calls).toEqual([])
  })
})
