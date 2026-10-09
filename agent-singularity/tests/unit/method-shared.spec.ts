/**
 * The method tools' shared seams: which mode a graph's own record puts
 * publication in, what a supervisor's method surface holds, and the frozen
 * edit-budget schedule the round's candidate count is measured against.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_STRATEGY_POLICY, UNREGULARIZED_STRATEGY_POLICY } from '@dangosys/dsh-singularity-evolution'
import {
  METHOD_AUTHORITY_TOOLS,
  METHOD_ROOT_BASELINE,
  METHOD_SUPERVISOR_BASELINE,
  deciderFor,
  environmentPlaneOf,
  methodGraphFor,
  methodLedgerPlaneOf,
  methodModeFor,
  strategyPlaneOf,
  strategyPolicyFor,
} from '../../src/tools/method-shared.ts'
import { CALLER, DECLARED_EDIT, methodWorld, skillPayload } from './method-tools.fixture.ts'

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

describe('the graph-level strategy switch', () => {
  it('selects the unregularized policy only when the graph record names it, and defaults to regularized', async () => {
    const plain = await methodWorld()
    const named = await methodWorld({ strategy: 'regularized' })
    const comparison = await methodWorld({ strategy: 'unregularized' })
    try {
      for (const [world, expected] of [
        [plain, DEFAULT_STRATEGY_POLICY],
        [named, DEFAULT_STRATEGY_POLICY],
        [comparison, UNREGULARIZED_STRATEGY_POLICY],
      ] as const) {
        const graph = await methodGraphFor(world.ctx as never, CALLER)
        expect(strategyPolicyFor(graph)).toBe(expected)
        // The ledger plane carries the same policy its evaluations freeze into
        // their plans and its decisions recompute under.
        expect((await methodLedgerPlaneOf(world.ctx as never, CALLER)).policy).toBe(expected)
      }
    } finally {
      await plain.dispose()
      await named.dispose()
      await comparison.dispose()
    }
  })

  it('anneals the draft edit budget to one only under the regularized arm', async () => {
    const regularized = await methodWorld()
    const unregularized = await methodWorld({ strategy: 'unregularized' })
    try {
      const { defineMethodDraftTool } = await import('../../src/tools/method-draft.ts')
      const lastRound = DEFAULT_STRATEGY_POLICY.rounds - 1
      const call = {
        kind: 'skill',
        identity: 'verify',
        edits: [DECLARED_EDIT, { ...DECLARED_EDIT, id: 'e2', hypothesis: 'a second independent mechanism' }],
        editPayload: skillPayload('# candidate: check the acceptance'),
        rationale: 'answer the observed failure',
        sourceRefs: ['diagnosis:d1'],
        expectedBaseRevision: 'r0001',
        round: lastRound,
        critic: { verdict: 'accept', reason: 'both mechanisms named, the asset parses', evidenceRefs: ['diagnosis:d1'] },
      }
      const refused = (await defineMethodDraftTool(regularized.ctx as never).execute(call, regularized.exec as never)) as string
      expect(refused).toContain(`exceed the round ${String(lastRound)} budget of 1`)
      const accepted = (await defineMethodDraftTool(unregularized.ctx as never).execute(call, unregularized.exec as never)) as string
      expect(accepted).toContain('recorded as draft')
      expect(accepted).toContain(`round ${String(lastRound)} edit budget 2`)
    } finally {
      await regularized.dispose()
      await unregularized.dispose()
    }
  })
})

describe('the method change announcement', () => {
  it('emits one methods/change frame naming the draft once a write lands, and nothing before it', async () => {
    const world = await methodWorld()
    try {
      expect(world.frames).toEqual([])
      const { defineMethodDraftTool } = await import('../../src/tools/method-draft.ts')
      const answer = (await defineMethodDraftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT],
          editPayload: skillPayload('# candidate: check the acceptance'),
          rationale: 'answer the observed failure',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'one mechanism, the asset parses', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      const draftId = /draft (d[0-9]{4})/.exec(answer)?.[1]
      expect(draftId).toBeDefined()
      // The frame names the draft that moved and the actor the ledger recorded;
      // the console re-reads `/singularity/methods` from it.
      expect(world.frames).toEqual([{ name: 'methods/change', frame: { draftId, actor: CALLER, at: expect.any(String) } }])
    } finally {
      await world.dispose()
    }
  })
})
