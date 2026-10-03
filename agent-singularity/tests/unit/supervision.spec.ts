/**
 * The supervision policy (agent-singularity's `supervision` config): the shipped
 * defaults, the budget precedence env > config > default, the per-source round
 * counting, and the ledger's cap-aware supervisor planning.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { REVIEW_AGENT_BUDGET_DEFAULT, planSupervisorAttempt, reviewAgentBudget } from '../../src/coordination/ledger.ts'
import {
  DEFAULT_SUPERVISION,
  configureSupervision,
  roundCapRefusal,
  sourceRoundsOf,
  supervisionSettings,
  type SupervisionRounds,
} from '../../src/coordination/supervision.ts'

beforeEach(() => {
  configureSupervision(undefined)
})

afterEach(() => {
  configureSupervision(undefined)
  vi.unstubAllEnvs()
})

describe('the supervision settings', () => {
  test('ship the contract defaults', () => {
    expect(DEFAULT_SUPERVISION).toEqual({
      autoReview: 'all',
      maxRecoveryRounds: 3,
      maxImprovementRounds: 2,
      coordinationBudget: 8,
    })
    expect(supervisionSettings()).toEqual(DEFAULT_SUPERVISION)
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(DEFAULT_SUPERVISION.coordinationBudget)
  })

  test('resolve a partial config over the defaults, flooring the counts and refusing below-floor values', () => {
    expect(configureSupervision({ autoReview: 'failed', maxRecoveryRounds: 2.7 })).toEqual({
      autoReview: 'failed',
      maxRecoveryRounds: 2,
      maxImprovementRounds: 2,
      coordinationBudget: 8,
    })
    // A coordination budget below one reads as the default; a round count of
    // zero is a real cap (no round is allowed).
    expect(configureSupervision({ coordinationBudget: 0 })).toMatchObject({ coordinationBudget: 8 })
    expect(configureSupervision({ maxImprovementRounds: 0 })).toMatchObject({ maxImprovementRounds: 0 })
  })

  test('the env override wins over the config, and the config wins over the default', () => {
    expect(reviewAgentBudget()).toBe(REVIEW_AGENT_BUDGET_DEFAULT)
    configureSupervision({ coordinationBudget: 4 })
    expect(reviewAgentBudget()).toBe(4)
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '2')
    expect(reviewAgentBudget()).toBe(2)
    // A value the env cannot parse falls back to the config, not the default.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', 'nonsense')
    expect(reviewAgentBudget()).toBe(4)
  })
})

describe('the per-source round caps', () => {
  const snapshot = {
    runs: [
      { runId: 'r1', taskId: 't1' },
      { runId: 'r2', taskId: 't1', recovery: { sourceDiagnosisId: 'd-1', requestKey: 'k1' } },
      { runId: 'r3', taskId: 't1', recovery: { kind: 'improvement', sourceDiagnosisId: 'd-1', requestKey: 'k2' } },
      { runId: 'r4', taskId: 't2', recovery: { sourceDiagnosisId: 'd-2', requestKey: 'k3' } },
    ],
  }

  test("count a task's recovery and improvement runs, reading a missing kind as a recovery", () => {
    const rounds = sourceRoundsOf(snapshot as never, 't1', 'failed')
    expect(rounds).toMatchObject({ outcome: 'failed', recovered: 1, improved: 1, maxRecovery: 3, maxImprovement: 2 })
  })

  test("refuse only at the cap of the source's own kind", () => {
    const under: SupervisionRounds = { outcome: 'failed', recovered: 2, improved: 0, maxRecovery: 3, maxImprovement: 2 }
    expect(roundCapRefusal(under)).toBeUndefined()
    const atRecoveryCap: SupervisionRounds = { ...under, recovered: 3 }
    expect(roundCapRefusal(atRecoveryCap)).toMatchObject({ code: 'iteration-cap' })
    expect(roundCapRefusal(atRecoveryCap)!.reason).toContain('3/3')
    // A verified source answers to the improvement cap, whatever its recovery
    // history was.
    expect(roundCapRefusal({ ...atRecoveryCap, outcome: 'verified', improved: 1 })).toBeUndefined()
    const atImprovementCap: SupervisionRounds = { ...atRecoveryCap, outcome: 'verified', improved: 2 }
    expect(roundCapRefusal(atImprovementCap)).toMatchObject({ code: 'iteration-cap' })
    expect(roundCapRefusal(atImprovementCap)!.reason).toContain('2/2')
  })
})

describe('the cap-aware supervisor planning', () => {
  const request = {
    role: 'supervisor' as const,
    source: { taskId: 't1', runId: 'r1' },
    requestKey: null,
    reason: null,
    diagnosisId: 'd-1',
    handoffDigest: 'digest-1',
    actor: 'root',
    sessionId: 's-new',
  }
  const attempt = (overrides: Record<string, unknown> = {}) => ({
    role: 'supervisor' as const,
    source: { taskId: 't1', runId: 'r1' },
    requestKey: null,
    reason: null,
    diagnosisId: 'd-1',
    handoffDigest: 'digest-1',
    sessionId: 's-old',
    actor: 'root',
    at: '2026-10-01T00:00:00.000Z',
    started: true,
    settlement: undefined,
    ...overrides,
  })

  test('a capped source plans nothing, before any budget decision', () => {
    const plan = planSupervisorAttempt({
      attempts: [],
      request,
      budget: { used: 0, max: 8 },
      rounds: { outcome: 'failed', recovered: 3, improved: 0, maxRecovery: 3, maxImprovement: 2 },
    })
    expect(plan).toMatchObject({ kind: 'refused', code: 'iteration-cap' })
    expect((plan as { reason?: string }).reason).toContain('3/3')
  })

  test('an interrupted attempt does not block a fresh start; a concluded one is reused', () => {
    const dead = attempt({
      sessionId: 's-dead',
      settlement: { status: 'interrupted', note: 'gone', at: '2026-10-01T00:01:00.000Z' },
    })
    expect(planSupervisorAttempt({ attempts: [dead] as never, request, budget: { used: 1, max: 8 } })).toMatchObject({
      kind: 'start',
    })
    const concluded = attempt({ settlement: { status: 'closed', note: 'done', at: '2026-10-01T00:02:00.000Z' } })
    const plan = planSupervisorAttempt({ attempts: [concluded] as never, request, budget: { used: 8, max: 8 } })
    expect(plan).toMatchObject({ kind: 'reuse' })
    expect((plan as { attempt: { sessionId: string } }).attempt.sessionId).toBe('s-old')
  })
})
