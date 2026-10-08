/**
 * The supervision policy (agent-singularity's `supervision` config): the shipped
 * allowance, the precedence env > config > default, and the graph-declared round
 * cap a store's coordination loop registers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { coordinationBudget } from '../../src/coordination/store.ts'
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
  })

  test('resolve a partial config over the default, refusing a budget below one', () => {
    expect(configureSupervision({ coordinationBudget: 3 })).toEqual({ coordinationBudget: 3 })
    expect(configureSupervision({ coordinationBudget: 0 })).toMatchObject({ coordinationBudget: 8 })
  })

  test('the env override wins over the config, and the config wins over the default', () => {
    expect(coordinationBudget()).toBe(DEFAULT_SUPERVISION.coordinationBudget)
    configureSupervision({ coordinationBudget: 4 })
    expect(coordinationBudget()).toBe(4)
    vi.stubEnv('SINGULARITY_COORDINATION_BUDGET', '2')
    expect(coordinationBudget()).toBe(2)
    // A value the env cannot parse falls back to the config, not the default.
    vi.stubEnv('SINGULARITY_COORDINATION_BUDGET', 'nonsense')
    expect(coordinationBudget()).toBe(4)
  })

  test('the retired budget name is not read', () => {
    configureSupervision({ coordinationBudget: 4 })
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '2')
    expect(coordinationBudget()).toBe(4)
  })
})

describe('the graph-declared round cap', () => {
  test('answers a registered store and stays silent for every other store', () => {
    expect(graphImprovementCap('sg-t-root')).toBeUndefined()
    registerGraphImprovementCap('sg-t-root', 5)
    expect(graphImprovementCap('sg-t-root')).toBe(5)
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

describe('the coordination store directory', () => {
  test('reads SINGULARITY_COORDINATION_DIR, and never the retired ledger name', async () => {
    const { coordinationFile, coordinationDir } = await import('../../src/coordination/store.ts')
    vi.stubEnv('SINGULARITY_COORDINATION_DIR', '/tmp/coord-under-test')
    expect(coordinationDir()).toBe('/tmp/coord-under-test')
    expect(coordinationFile()).toBe('/tmp/coord-under-test/assignments.jsonl')
    vi.unstubAllEnvs()
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '/tmp/legacy-ledger')
    vi.stubEnv('DSH_HOME', '/tmp/dsh-under-test')
    expect(coordinationDir()).toBe('/tmp/dsh-under-test/coordination')
  })
})
