/**
 * The supervision policy (agent-singularity's `supervision` config): the shipped
 * allowance, the budget precedence env > config > default, the graph-declared
 * round cap a store's RSI loop registers, and the ledger's supervisor planning.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { REVIEW_AGENT_BUDGET_DEFAULT, planSupervisorAttempt, reviewAgentBudget } from '../../src/coordination/ledger.ts'
import {
  DEFAULT_SUPERVISION,
  configureSupervision,
  graphImprovementCap,
  registerGraphImprovementCap,
  supervisionSettings,
  unregisterGraphImprovementCap,
} from '../../src/coordination/supervision.ts'

beforeEach(() => {
  configureSupervision(undefined)
})

afterEach(() => {
  configureSupervision(undefined)
  unregisterGraphImprovementCap('sg-t-root')
  vi.unstubAllEnvs()
})

describe('the supervision settings', () => {
  test('ship the contract default allowance', () => {
    expect(DEFAULT_SUPERVISION).toEqual({ coordinationBudget: 8 })
    expect(supervisionSettings()).toEqual(DEFAULT_SUPERVISION)
    expect(REVIEW_AGENT_BUDGET_DEFAULT).toBe(DEFAULT_SUPERVISION.coordinationBudget)
  })

  test('resolve a partial config over the default, refusing a budget below one', () => {
    expect(configureSupervision({ coordinationBudget: 3 })).toEqual({ coordinationBudget: 3 })
    // A coordination budget below one reads as the default.
    expect(configureSupervision({ coordinationBudget: 0 })).toMatchObject({ coordinationBudget: 8 })
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

describe('the graph-declared round cap', () => {
  test('answers a registered store and stays silent for every other store', () => {
    expect(graphImprovementCap('sg-t-root')).toBeUndefined()
    registerGraphImprovementCap('sg-t-root', 5)
    expect(graphImprovementCap('sg-t-root')).toBe(5)
    // A store no graph registered keeps the runtime's own backstop.
    expect(graphImprovementCap('sg-t-elsewhere')).toBeUndefined()
    unregisterGraphImprovementCap('sg-t-root')
    expect(graphImprovementCap('sg-t-root')).toBeUndefined()
  })

  test('refuses a count that is not a usable round number', () => {
    registerGraphImprovementCap('sg-t-root', Number.NaN)
    expect(graphImprovementCap('sg-t-root')).toBeUndefined()
    registerGraphImprovementCap('sg-t-root', -1)
    expect(graphImprovementCap('sg-t-root')).toBeUndefined()
  })
})

describe('the supervisor planning', () => {
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

  test('refuses a second hand-off content for one diagnosis, and a spent allowance', () => {
    const conflicting = attempt({ handoffDigest: 'another-digest' })
    expect(planSupervisorAttempt({ attempts: [conflicting] as never, request, budget: { used: 0, max: 8 } })).toMatchObject(
      { kind: 'refused', code: 'request-key-conflict' },
    )
    const spent = attempt({ settlement: { status: 'interrupted', note: 'gone', at: '2026-10-01T00:01:00.000Z' } })
    expect(planSupervisorAttempt({ attempts: [spent] as never, request, budget: { used: 8, max: 8 } })).toMatchObject({
      kind: 'refused',
      code: 'budget-exhausted',
    })
  })
})
