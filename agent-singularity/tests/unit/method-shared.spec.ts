/**
 * The method tools' shared seams: which mode a graph's own record puts
 * publication in, what a supervisor's method surface holds, and the frozen
 * edit-budget schedule the round's candidate count is measured against.
 */
import { describe, expect, it } from 'vitest'
import {
  METHOD_AUTHORITY_TOOLS,
  METHOD_ROOT_BASELINE,
  METHOD_SUPERVISOR_BASELINE,
  deciderFor,
  environmentPlaneOf,
  methodGraphFor,
  methodModeFor,
  strategyPlaneOf,
} from '../../src/tools/method-shared.ts'
import { methodWorld } from './method-tools.fixture.ts'

describe('the method mode one graph runs in', () => {
  it('is auto only when the graph record says no human reviews, and manual otherwise', async () => {
    const auto = await methodWorld({ humanReview: false })
    const manual = await methodWorld({ humanReview: true })
    try {
      expect(await methodModeFor(auto.ctx as never, 's-supervisor')).toBe('auto')
      expect(await methodModeFor(manual.ctx as never, 's-supervisor')).toBe('manual')
      expect(deciderFor('auto')).toBe('platform_policy')
      expect(deciderFor('manual')).toBe('human')
    } finally {
      await auto.dispose()
      await manual.dispose()
    }
  })

  it('reads a graph with no rsi settings as manual and resolves its library from its own root session', async () => {
    const world = await methodWorld()
    try {
      delete (world.ctx.graphs as { graphForSession: unknown }).graphForSession
      ;(world.ctx.graphs as { graphForSession?: unknown }).graphForSession = async () => ({ id: 'g1', rootSessionId: 'g1' })
      expect(await methodModeFor(world.ctx as never, 's-supervisor')).toBe('manual')
      const graph = await methodGraphFor(world.ctx as never, 's-supervisor')
      expect(graph).toMatchObject({ id: 'g1', rootSessionId: 'g1', libraryId: 'g1' })
      expect(graph.rsi).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })
})

describe('the method tool surface', () => {
  it('names the six supervisor tools, the root two, and the two pointer-moving tools once', () => {
    expect([...METHOD_SUPERVISOR_BASELINE].sort()).toEqual([
      'method_discard', 'method_draft', 'method_evaluate', 'method_list', 'method_publish', 'method_rollback',
    ])
    expect([...METHOD_ROOT_BASELINE].sort()).toEqual(['method_draft', 'method_list'])
    expect([...METHOD_AUTHORITY_TOOLS].sort()).toEqual(['method_publish', 'method_rollback'])
    for (const name of METHOD_ROOT_BASELINE) expect(METHOD_SUPERVISOR_BASELINE).toContain(name)
    for (const name of METHOD_AUTHORITY_TOOLS) expect(METHOD_SUPERVISOR_BASELINE).toContain(name)
  })

  it('refuses an environment plane by name when the deployment offers no task runtime', () => {
    expect(() => environmentPlaneOf({} as never)).toThrow(/no task runtime/)
  })

  it('refuses a runtime entry this deployment does not offer, naming it before anything runs', () => {
    const ctx = { taskRuntime: { activeEnvironmentView: async () => ({}) } }
    expect(() => environmentPlaneOf(ctx as never)).toThrow(/no activeRevisionFor/)
  })
})

describe('the frozen edit budget', () => {
  it('anneals from the maximum to exactly one in the last round', () => {
    const strategy = strategyPlaneOf()
    const rounds = strategy.policy.rounds
    expect(strategy.editBudget(0, strategy.policy)).toBe(strategy.policy.editBudget.max)
    expect(strategy.editBudget(rounds - 1, strategy.policy)).toBe(strategy.policy.editBudget.min)
    expect(strategy.editBudget(rounds - 1, strategy.policy)).toBe(1)
  })

  it('is the same pure schedule the strategy owns: no second budget implementation exists here', () => {
    const strategy = strategyPlaneOf()
    expect(strategy.editBudget(3, strategy.policy)).toBe(strategy.editBudget(3, { ...strategy.policy }))
  })
})
