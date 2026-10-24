import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../../src/control/session-store.ts'
import { createEnvironmentCommands } from '../../src/environment/commands.ts'
import { declareEnvironmentProtocol } from '../../src/environment/protocol.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import {
  declareMeasureProtocol,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationState,
} from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRegistry } from '../../src/protocol/registry.ts'
import type { TaskContract, VerifierCriterion } from '../../src/task/contract.ts'
import {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_VERSION,
  type RoundState,
} from '../../src/strategy/protocol.ts'
import {
  declareTaskProtocol,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRoleOf,
  type RevisionRef,
} from '../../src/task/protocol.ts'
import { createEvolution, structuralEditsOf, type SolveResult, type EvolutionOptions } from '../src/evolution.ts'
import { FakePersistence } from './seam.ts'
import { parseSuite } from '../../src/measure/suite.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'

const criterion: VerifierCriterion = {
  criterionId: 'correct',
  statement: 'independent fixture acceptance',
  verifierRef: 'accept',
  verifierVersion: '1',
  implementationDigest: 'a'.repeat(64),
}
const inputs = [{ name: 'letters.txt', digest: 'b'.repeat(64) }]
const initial = {
  workflowGuidance: '',
  templates: [
    { id: 'root', goal: 'count letters' },
    { id: 'part', goal: 'read letters' },
  ],
  skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'count carefully' }],
  tools: [{ name: 'tool', source: 'export const count = input => input.length' }],
}
const calibration = { floor: 0, source: 'declared' as const }
const stores: ControlSessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: new FakePersistence() as unknown as SessionPersistence,
    controlId: 'evolution',
    registry,
    subjects: {
      scheduler: 'executor',
      environment: 'environment',
      strategy: 'strategy',
      [verifierRoleOf(criterion)]: 'acceptance',
    },
  })
  stores.push(store)
  const methods = new Map<string, typeof initial>()
  const quality = new Map<string, number>()
  const accepted = new Map<string, boolean>()
  const contexts = new Map<string, readonly string[]>()
  const calls: { revision: RevisionRef; operationId: string }[] = []
  const environments = createEnvironmentCommands({ store, registry })
  async function revision(
    id: string,
    assets: typeof initial,
    passed: number,
    met = passed === 1,
  ): Promise<RevisionRef> {
    await environments.createRevision({
      commandId: `revision:${id}`,
      environmentId: 'methods',
      revisionId: id,
      manifest: assets,
    })
    methods.set(id, assets)
    quality.set(id, passed)
    accepted.set(id, met)
    return { environmentId: 'methods', revisionId: id, digest: digestOf(assets) }
  }
  // This solve double establishes real core Task/Run/Bubble facts; native execution and token
  // accounting are the host port's separate integration contract.
  async function solve({
    revision,
    operationId,
    started,
    contract: requestedContract,
  }: {
    revision: RevisionRef
    operationId: string
    contract?: TaskContract
    started: (run: { taskId: string; runId: string }) => Promise<void>
  }): Promise<SolveResult> {
    calls.push({ revision, operationId })
    const taskId = `${operationId}:task`
    const runId = `${operationId}:run`
    const facts: readonly { readonly kind: string; readonly payload: unknown }[] = [
      {
        kind: TASK_KINDS.admitted,
        payload: {
          contract: requestedContract ?? {
            artifact: 'artifact.json',
            goal: 'count letters',
            template: { id: 'root', digest: 'c'.repeat(64) },
            inputs: [
              { name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } },
            ],
            criteria: [{ criterionId: criterion.criterionId, statement: criterion.statement }],
          },
        },
      },
      { kind: TASK_KINDS.assigned, payload: { agentId: 'worker', agentIdentity: 'executor' } },
      { kind: TASK_KINDS.runStarted, payload: { purpose: 'solve', runId, revision } },
      {
        kind: TASK_KINDS.bubbleOpened,
        payload: {
          runId,
          inputs,
          model: { provider: 'test', model: 'fixture' },
          tools: [{ name: 'node', version: '1', implementationDigest: 'd'.repeat(64) }],
          conditions: contexts.get(operationId) ?? ['frozen fixture'],
          workspace: { kind: 'dir', ref: `/tmp/${operationId}` },
        },
      },
    ]
    for (const [index, fact] of facts.entries())
      await store.emit({
        commandId: `${operationId}:${index}`,
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        subject: taskId,
        ...fact,
      })
    await started({ taskId, runId })
    return {
      taskId,
      runId,
      quality: quality.get(revision.revisionId)!,
      met: accepted.get(revision.revisionId)!,
      cost: 100,
      artifactDigest: digestOf({ taskId }),
      inputDigests: inputs,
      implementationDigest: criterion.implementationDigest,
      acceptanceDigest: criterion.implementationDigest,
    }
  }
  const metric = {
    measured: { ...criterion, criterionId: 'correct:quality' },
    unit: 'pass',
    direction: 'higher' as const,
  }
  const options = {
    store,
    registry,
    criterion,
    metric,
    trials: 1,
    weights: { quality: 1, cost: 0 },
    calibration,
    loadMethod: async (ref: RevisionRef) => methods.get(ref.revisionId)!,
    baseline: solve,
    solve,
  }
  const evolution = createEvolution(options)
  return { store, registry, revision, evolution, calls, solve, contexts, options }
}

describe('method evolution', () => {
  const suiteFor = () =>
    parseSuite({
      version: 1,
      suiteId: 'reuse-and-parallel',
      failureQuality: 0,
      cases: ['parse', 'calculate'].map(id => ({
        caseId: id,
        familyId: id,
        sourceId: id,
        split: 'evolve',
        weight: 1,
        trials: 2,
        hardGuards: [],
        contract: {
          goal: id,
          artifact: 'artifact.json',
          inputs: [{ name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } }],
          criteria: [{ criterionId: 'correct', statement: id }],
        },
      })),
    })

  it('reuses complete incumbent evidence only within the same search, suite, metric and execution profile', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 1),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1)
    const options = { ...live.options, suite: suiteFor(), executionProfileDigest: 'e'.repeat(64) }
    const request = { campaignId: 'reuse', roundId: 'reuse-r1', round: 1, incumbent, candidates: [candidate] }
    await createEvolution(options).runRound(request)
    expect(live.calls).toHaveLength(8)
    await createEvolution(options).runRound({ ...request, roundId: 'reuse-r2', round: 2 })
    expect(live.calls).toHaveLength(12)
    const reused = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'reuse-r2:bootstrap:evaluation')!
    expect(
      reused.observed.every(t => JSON.parse(t.detail!).reusedFrom.evaluationId === 'reuse-r1:bootstrap:evaluation'),
    ).toBe(true)
    await expect(
      createEvolution({ ...options, executionProfileDigest: 'f'.repeat(64) }).runRound({
        ...request,
        roundId: 'reuse-r3',
        round: 3,
      }),
    ).rejects.toThrow('frozen suite or execution caliber')
    expect(live.calls).toHaveLength(16)
    await createEvolution(options).runRound({ ...request, campaignId: 'other', roundId: 'other-r1' })
    expect(live.calls).toHaveLength(24)
    await expect(
      createEvolution({ ...options, weights: { quality: 2, cost: 0 } }).runRound({
        ...request,
        roundId: 'reuse-r4',
        round: 4,
      }),
    ).rejects.toThrow('frozen suite or execution caliber')
    expect(live.calls).toHaveLength(28)
    await expect(
      createEvolution({ ...options, executionProfileDigest: 'f'.repeat(64) }).runRound({
        ...request,
        roundId: 'reuse-r2',
        round: 2,
      }),
    ).resolves.toMatchObject({ decided: true })
  })

  it('reuses an accepted candidate as the next incumbent without executing it again', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 0),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1),
      next = await live.revision('h2', { ...initial, workflowGuidance: 'check interfaces' }, 1)
    const options = { ...live.options, suite: suiteFor(), executionProfileDigest: 'e'.repeat(64) }
    expect(
      (
        await createEvolution(options).runRound({
          campaignId: 'reuse-winner',
          roundId: 'winner-r1',
          round: 1,
          incumbent,
          candidates: [candidate],
        })
      ).winner,
    ).toBe(0)
    await createEvolution(options).runRound({
      campaignId: 'reuse-winner',
      roundId: 'winner-r2',
      round: 2,
      incumbent: candidate,
      candidates: [next],
    })
    expect(live.calls.map(c => c.revision.revisionId)).toEqual([
      ...Array(4).fill('h0'),
      ...Array(4).fill('h1'),
      ...Array(4).fill('h2'),
    ])
  })

  it('reuses an otherwise complete incumbent despite missing billing samples', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 1),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1)
    const options = {
      ...live.options,
      suite: suiteFor(),
      executionProfileDigest: 'e'.repeat(64),
      baseline: async (request: Parameters<EvolutionOptions['solve']>[0]) => ({
        ...(await live.solve(request)),
        cost: null,
      }),
    }
    const request = {
      campaignId: 'incomplete-cost',
      roundId: 'incomplete-cost-r1',
      round: 1,
      incumbent,
      candidates: [candidate],
    }
    await createEvolution(options).runRound(request)
    await createEvolution(options).runRound({ ...request, roundId: 'incomplete-cost-r2', round: 2 })
    expect(live.calls).toHaveLength(12)
  })

  it('freezes slot zero before concurrent trials start without waiting for its completion', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 1),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1)
    let admit!: () => void, finish!: () => void, entered!: () => void, concurrent!: () => void
    const admission = new Promise<void>(resolve => {
        admit = resolve
      }),
      completion = new Promise<void>(resolve => {
        finish = resolve
      }),
      firstEntered = new Promise<void>(resolve => {
        entered = resolve
      }),
      secondEntered = new Promise<void>(resolve => {
        concurrent = resolve
      })
    let count = 0,
      active = 0,
      peak = 0
    const solve: EvolutionOptions['solve'] = async request => {
      const index = count++
      active++
      peak = Math.max(peak, active)
      try {
        if (index === 0) {
          entered()
          await admission
        } else concurrent()
        const result = await live.solve(request)
        if (index === 0) await completion
        return result
      } finally {
        active--
      }
    }
    const pending = createEvolution({
      ...live.options,
      suite: suiteFor(),
      executionProfileDigest: 'e'.repeat(64),
      parallelism: 2,
      baseline: solve,
      solve,
    }).runRound({ campaignId: 'freeze', roundId: 'freeze-r1', round: 1, incumbent, candidates: [candidate] })
    try {
      await firstEntered
      expect(count).toBe(1)
      expect(
        live.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'freeze-r1:bootstrap:evaluation'),
      ).toBeUndefined()
      admit()
      await secondEntered
      const frozen = live.store
        .load()
        .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'freeze-r1:bootstrap:evaluation')!
      expect(frozen.run).toBeDefined()
      expect(frozen.observed.some(trial => trial.slot === 0)).toBe(false)
      expect(peak).toBe(2)
    } finally {
      admit()
      finish()
    }
    await pending
    expect(active).toBe(0)
    expect(peak).toBe(2)
    expect(count).toBe(8)
  })

  it('bounds concurrent trials, records out-of-order completions and drains failures before recovery', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 1),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1)
    let active = 0,
      peak = 0,
      failed = false
    const solve: EvolutionOptions['solve'] = async request => {
      active++
      peak = Math.max(peak, active)
      try {
        const result = await live.solve(request)
        await new Promise(resolve => setTimeout(resolve, request.case?.caseId === 'parse' ? 12 : 2))
        if (request.revision.digest === candidate.digest && !failed) {
          failed = true
          throw Error('trial interrupted')
        }
        return result
      } finally {
        active--
      }
    }
    const options = {
      ...live.options,
      suite: suiteFor(),
      executionProfileDigest: 'e'.repeat(64),
      parallelism: 2,
      baseline: solve,
      solve,
    }
    const request = { campaignId: 'parallel', roundId: 'parallel-r1', round: 1, incumbent, candidates: [candidate] }
    await expect(createEvolution(options).runRound(request)).rejects.toThrow('trial interrupted')
    expect(peak).toBe(2)
    expect(active).toBe(0)
    const before = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'parallel-r1:0:candidate:evaluation')!
    const committed = before.observed.map(t => t.run!.taskId)
    const calls = live.calls.length
    await expect(
      createEvolution({ ...options, executionProfileDigest: 'f'.repeat(64) }).runRound(request),
    ).rejects.toThrow('recovery changed its frozen')
    expect(live.calls).toHaveLength(calls)
    await createEvolution(options).runRound(request)
    expect(active).toBe(0)
    expect(live.calls.filter(c => committed.includes(`${c.operationId}:task`))).toHaveLength(committed.length)
    const complete = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'parallel-r1:0:candidate:evaluation')!
    expect(complete.observed.map(t => t.slot).sort()).toEqual([0, 1, 2, 3])
  })

  it('preserves partial rubric scores while rejecting a failed hard guard', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 0),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundaries' }, 1)
    const suite = parseSuite({ ...suiteFor(), scoring: 'criteria' })
    const solve: EvolutionOptions['solve'] = async request => ({
      ...(await live.solve(request)),
      quality: request.revision.digest === incumbent.digest ? 0.25 : 0.75,
      met: false,
      guardsMet: true,
    })
    const options = { ...live.options, suite, executionProfileDigest: 'e'.repeat(64), baseline: solve, solve }
    const request = { campaignId: 'rubric', roundId: 'rubric-r1', round: 1, incumbent, candidates: [candidate] }
    expect((await createEvolution(options).runRound(request)).slots[0]?.quality).toBe(0.75)
    const guarded = await createEvolution({
      ...options,
      solve: async input => ({ ...(await solve(input)), guardsMet: false }),
    }).runRound({ ...request, campaignId: 'rubric-guard', roundId: 'rubric-guard-r1' })
    expect(guarded.winner).toBeNull()
    expect(guarded.outcomes[0]?.reason).toContain('hard guards')
  })

  it.each(['higher', 'lower'] as const)(
    'refuses a failure reward better than a successful observation (%s)',
    async direction => {
      const live = await fixture(),
        incumbent = await live.revision('h0', initial, 1),
        candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check boundary first' }, 1)
      const suite = parseSuite({
        version: 1,
        suiteId: 'unsafe-penalty',
        failureQuality: direction === 'lower' ? 0 : 2,
        cases: [
          {
            caseId: 'case',
            familyId: 'family',
            sourceId: 'source',
            split: 'evolve',
            weight: 1,
            trials: 2,
            hardGuards: [],
            contract: {
              goal: 'case',
              artifact: 'artifact.json',
              inputs: [
                { name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } },
              ],
              criteria: [{ criterionId: 'correct', statement: 'correct' }],
            },
          },
        ],
      })
      const evolution = createEvolution({
        ...live.options,
        metric: { ...live.options.metric, direction },
        suite,
        executionProfileDigest: 'e'.repeat(64),
      })
      await expect(
        evolution.runRound({
          campaignId: 'penalty',
          roundId: 'penalty-r1',
          round: 1,
          incumbent,
          candidates: [candidate],
        }),
      ).rejects.toThrow('failureQuality must be at least as bad')
    },
  )

  it('runs a frozen case matrix through the same solve port, scores ordinary failures and resumes only unfilled slots', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 0),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'check the boundary first' }, 1)
    const suite = parseSuite({
      version: 1,
      suiteId: 'matrix-v1',
      failureQuality: 0,
      cases: ['parse', 'calculate'].map((id, index) => ({
        caseId: id,
        familyId: id,
        sourceId: id,
        split: 'evolve',
        weight: index + 1,
        trials: 2,
        hardGuards: [],
        contract: {
          goal: id,
          artifact: 'artifact.json',
          inputs: [{ name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } }],
          criteria: [{ criterionId: 'correct', statement: id }],
        },
      })),
    })
    const solve: EvolutionOptions['solve'] = async request => {
      const result = await live.solve(request)
      const met = request.revision.digest === candidate.digest || request.case?.caseId === 'parse'
      return { ...result, quality: met ? 1.2 : 0, met, guardsMet: true }
    }
    const options = { ...live.options, suite, executionProfileDigest: 'e'.repeat(64), baseline: solve, solve }
    let interrupted = false
    const request = { campaignId: 'matrix', roundId: 'matrix-r1', round: 1, incumbent, candidates: [candidate] }
    await expect(
      createEvolution({
        ...options,
        solve: async input => {
          if (!interrupted && input.case?.caseId === 'calculate') {
            interrupted = true
            throw new Error('crash before next slot')
          }
          return solve(input)
        },
      }).runRound(request),
    ).rejects.toThrow('crash')
    expect(live.calls).toHaveLength(6)
    const result = await createEvolution(options).runRound(request)
    expect(result.winner).toBe(0)
    expect(result.slots[0]).toMatchObject({ quality: 1.2, denominator: 4, admissible: true })
    expect(live.calls).toHaveLength(8)
    const baseline = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'matrix-r1:bootstrap:evaluation')!
    expect(baseline.observed.filter(t => JSON.parse(t.detail!).met === false)).toHaveLength(2)
    expect(baseline.matrix?.slots.map(s => s.caseId)).toEqual(['parse', 'parse', 'calculate', 'calculate'])
    expect(new Set(live.calls.map(call => call.operationId)).size).toBe(8)
    await createEvolution(options).runRound(request)
    expect(live.calls).toHaveLength(8)
  })

  it('records physical qualification failures as scored slots with real costs and a fixed denominator', async () => {
    const live = await fixture(),
      incumbent = await live.revision('h0', initial, 1),
      candidate = await live.revision('h1', { ...initial, workflowGuidance: 'try physical specialization' }, 1)
    const solve: EvolutionOptions['solve'] = async request => {
      const result = await live.solve(request)
      return request.revision.digest === candidate.digest && request.case?.caseId === 'calculate'
        ? {
            taskId: result.taskId,
            runId: result.runId,
            cost: result.cost,
            status: 'business-failure',
            reason: 'functional RTL failed synthesis qualification',
            measurementArtifact: {
              artifactDigest: result.artifactDigest,
              inputDigests: result.inputDigests,
              implementationDigest: result.implementationDigest,
              acceptanceDigest: result.acceptanceDigest,
            },
          }
        : result
    }
    const options = {
      ...live.options,
      suite: suiteFor(),
      executionProfileDigest: 'e'.repeat(64),
      baseline: solve,
      solve,
    }
    const decision = await createEvolution(options).runRound({
      campaignId: 'physical',
      roundId: 'physical-r1',
      round: 1,
      incumbent,
      candidates: [candidate],
    })
    expect(decision.winner).toBeNull()
    const evaluation = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'physical-r1:0:candidate:evaluation')!
    expect(evaluation.missed).toHaveLength(0)
    const ineligible = evaluation.observed.filter(trial => JSON.parse(trial.detail!).status === 'business-failure')
    expect(ineligible).toHaveLength(2)
    expect(ineligible[0]).toMatchObject({ quality: 0, cost: 100, guardsMet: false })
    expect(projectEvaluation(evaluation)).toMatchObject({
      denominator: 4,
      observed: 4,
      quality: 0.5,
      cost: 400,
      missing: [],
      admissible: false,
    })
  })

  it.each(['infrastructure-failure', 'review-inconclusive'] as const)(
    'retains %s as a distinct missing reason instead of business zeroes',
    async status => {
      const live = await fixture(),
        incumbent = await live.revision('h0', initial, 1),
        candidate = await live.revision('h1', { ...initial, workflowGuidance: 'try a new investigation order' }, 1)
      const solve: EvolutionOptions['solve'] = async request => {
        const result = await live.solve(request)
        return {
          taskId: result.taskId,
          runId: result.runId,
          cost: result.cost,
          status,
          reason: 'acceptance review evidence is unavailable for criteria: correct',
        }
      }
      const decision = await createEvolution({
        ...live.options,
        suite: suiteFor(),
        executionProfileDigest: 'e'.repeat(64),
        parallelism: 2,
        solve,
      }).runRound({
        campaignId: 'missing-review',
        roundId: 'missing-review-r1',
        round: 1,
        incumbent,
        candidates: [candidate],
      })
      expect(decision.winner).toBeNull()
      const evaluation = live.store
        .load()
        .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'missing-review-r1:0:candidate:evaluation')!
      expect(evaluation.observed).toEqual([])
      expect(evaluation.failed ?? []).toEqual([])
      expect(evaluation.missed).toHaveLength(4)
      expect(evaluation.missed.every(slot => slot.reason.includes('review evidence is unavailable'))).toBe(true)
      expect(evaluation.missed.every(slot => JSON.parse(slot.reason).status === status)).toBe(true)
      expect(projectEvaluation(evaluation)).toMatchObject({
        denominator: 4,
        observed: 0,
        quality: null,
        cost: 400,
        admissible: false,
        missing: Array.from({ length: 4 }, () =>
          expect.objectContaining({ reason: expect.stringContaining('review evidence is unavailable') }),
        ),
      })
    },
  )

  it('records unknown native costs and completes evaluation without blocking later rounds', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 1)
    const candidate = await live.revision(
      'unknown-cost',
      { ...initial, templates: [{ ...initial.templates[0]!, goal: 'stream letters' }, initial.templates[1]!] },
      1,
    )
    const evolution = createEvolution({
      ...live.options,
      solve: async request => ({ ...(await live.solve(request)), cost: null }),
    })
    expect(
      (
        await evolution.runRound({
          campaignId: 'test-campaign',
          roundId: 'unknown-cost-1',
          round: 1,
          incumbent,
          candidates: [candidate],
        })
      ).winner,
    ).toBeNull()
    expect(
      (
        await evolution.runRound({
          campaignId: 'test-campaign',
          roundId: 'unknown-cost-2',
          round: 2,
          incumbent,
          candidates: [candidate],
        })
      ).winner,
    ).toBeNull()
    expect(evolution.history()).toHaveLength(2)
  })

  it('selects a quality winner and keeps recorded trial costs after an interrupted billing sample', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const candidate = await live.revision(
      'partial-billing',
      { ...initial, workflowGuidance: 'reuse verified evidence' },
      1,
    )
    const evolution = createEvolution({
      ...live.options,
      trials: 2,
      solve: async request => ({
        ...(await live.solve(request)),
        cost: request.revision.digest === candidate.digest && request.operationId.endsWith(':trial:0') ? null : 100,
      }),
    })
    const decision = await evolution.runRound({
      campaignId: 'partial-billing',
      roundId: 'partial-billing-r1',
      round: 1,
      incumbent,
      candidates: [candidate],
    })
    expect(decision.winner).toBe(0)
    expect(decision.slots[0]).toMatchObject({ cost: 100, quality: 1, missingTrials: [], admissible: true })
    expect(
      live.store
        .load()
        .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'partial-billing-r1:0:candidate:evaluation')!
        .observed.map(t => t.cost),
    ).toEqual([undefined, 100])
  })

  it('selects an independently accepted cost-only improvement with positive cost weight', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 1)
    const candidate = await live.revision(
      'cheaper',
      { ...initial, templates: [{ ...initial.templates[0]!, goal: 'stream letters' }, initial.templates[1]!] },
      1,
    )
    const evolution = createEvolution({
      ...live.options,
      weights: { quality: 1, cost: 1 },
      solve: async request => ({
        ...(await live.solve(request)),
        cost: request.revision.digest === candidate.digest ? 50 : 100,
      }),
    })
    expect(
      (
        await evolution.runRound({
          campaignId: 'test-campaign',
          roundId: 'cost-only',
          round: 1,
          incumbent,
          candidates: [candidate],
        })
      ).winner,
    ).toBe(0)
  })

  it('projects changed relationships and bindings without creating separate strategy edits per edge', () => {
    const baseline = {
      ...initial,
      templates: [
        {
          ...initial.templates[0]!,
          skills: ['skill'],
          decomposition: {
            children: [
              {
                key: 'part',
                template: 'part',
                dependsOn: [],
                supports: ['correct'],
                maxRuns: 1,
                requirement: 'required' as const,
              },
            ],
          },
        },
        initial.templates[1]!,
      ],
    }
    const candidate = {
      ...baseline,
      templates: [
        {
          ...baseline.templates[0]!,
          skills: [],
          decomposition: {
            children: [
              {
                key: 'part',
                template: 'part',
                dependsOn: ['earlier'],
                supports: ['correct'],
                maxRuns: 1,
                requirement: 'required' as const,
              },
            ],
          },
        },
        initial.templates[1]!,
      ],
    }
    expect(structuralEditsOf(baseline, candidate)).toEqual([{ asset: 'template', target: 'root' }])
    expect(structuralEditDetailsOf(baseline, candidate)).toEqual([
      { asset: 'template', target: 'root', paths: ['decomposition.children[0].dependsOn[0]', 'skills[0]'] },
    ])
  })

  it('resumes an interrupted round without repeating committed trials', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, tools: [{ name: 'tool', source: 'improved tool' }] }, 1)
    const input = { campaignId: 'test-campaign', roundId: 'resumed', round: 1, incumbent, candidates: [good] }
    const interrupted = createEvolution({
      ...live.options,
      solve: async request => {
        if (request.revision.revisionId === 'good') throw new Error('process stopped before candidate solve')
        return live.solve(request)
      },
    })
    await expect(interrupted.runRound(input)).rejects.toThrow('process stopped')
    expect(live.calls).toHaveLength(1)
    const result = await createEvolution(live.options).runRound(input)
    expect(result.winner).toBe(0)
    expect(live.calls.map(call => call.revision.revisionId)).toEqual(['initial', 'good'])
    const count = live.store.load().entries().length
    expect(await createEvolution(live.options).runRound(input)).toEqual(result)
    expect(live.calls).toHaveLength(2)
    expect(live.store.load().entries()).toHaveLength(count)
  })

  it('counts actual template identities and the shared skill/tool content', () => {
    expect(
      structuralEditsOf(initial, {
        ...initial,
        templates: [
          { id: 'root', goal: 'count exactly' },
          { id: 'new', goal: 'new part' },
        ],
        skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'count twice' }],
        tools: [{ name: 'tool', source: 'export const count = input => [...input].length' }],
      }),
    ).toEqual([
      { asset: 'template', target: 'new' },
      { asset: 'template', target: 'part' },
      { asset: 'template', target: 'root' },
      { asset: 'skill', target: 'skill' },
      { asset: 'tool', target: 'tool' },
    ])
    expect(structuralEditsOf(initial, { ...initial, templates: [...initial.templates].reverse() })).toEqual([])
  })

  it('compares each candidate with the frozen incumbent and reads closed history and reads frozen closed history', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision(
      'good',
      {
        ...initial,
        skills: [
          { name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ],
      },
      1,
    )
    const bad = await live.revision('bad', { ...initial, tools: [{ name: 'tool', source: 'broken method' }] }, 0)
    const first = await live.evolution.runRound({
      campaignId: 'test-campaign',
      roundId: 'r1',
      round: 1,
      incumbent,
      candidates: [good, bad],
    })
    expect(first.winner).toBe(0)
    expect(first.slots.map(slot => slot.quality)).toEqual([1, 0])
    expect(first.outcomes[1]?.admitted).toBe(false)
    expect(live.calls.map(call => call.revision.revisionId)).toEqual(['initial', 'good', 'bad'])
    const submitted = live.store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'r1')!.submissions
    expect(submitted.map(candidate => ({ edits: candidate.edits }))).toEqual([
      { edits: [{ asset: 'skill', target: 'skill' }] },
      { edits: [{ asset: 'tool', target: 'tool' }] },
    ])

    const consumedHistory = live.evolution.history()
    expect(consumedHistory).toEqual([first])
    const next = await live.revision(
      'next',
      {
        ...initial,
        skills: [
          { name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ],
        tools: [{ name: 'tool', source: 'different method' }],
      },
      1,
    )
    const worse = await live.revision(
      'worse',
      {
        ...initial,
        skills: [
          { name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'incorrect method' },
        ],
      },
      0,
    )
    // The second proposal's incumbent and revisions are chosen from the committed first history.
    const previous = consumedHistory[0]!
    expect(previous.winner).toBe(0)
    const second = await live.evolution.runRound({
      campaignId: 'test-campaign',
      roundId: 'r2',
      round: 2,
      incumbent: good,
      candidates: [next, worse],
    })
    expect(second.winner).toBeNull()
    expect(live.calls).toHaveLength(6)

    const late = await live.solve({ revision: good, operationId: 'late', started: async () => undefined })
    const measure = createMeasureCommands({
      store: live.store,
      registry: live.registry,
      implementations: [
        {
          ref: criterion.verifierRef,
          version: criterion.verifierVersion,
          implementationDigest: criterion.implementationDigest,
        },
      ],
    })
    await measure.openEvaluation({
      commandId: 'late:open',
      evaluationId: 'late',
      baseline: good,
      candidate: good,
      run: { taskId: late.taskId, runId: late.runId },
      metric: { measured: { ...criterion, criterionId: 'correct:quality' }, unit: 'pass', direction: 'higher' },
      weights: { quality: 1, cost: 0 },
      trials: 1,
      judgement: [criterion],
    })
    await measure.recordTrial({
      commandId: 'late:trial',
      evaluationId: 'late',
      trial: { ...late, cost: late.cost!, slot: 0, quality: 0 },
    })
    expect(live.evolution.history()).toEqual([first, second])
    const reopened = createEvolution({
      ...live.options,
      calibration: { floor: 999, source: 'declared' },
      loadMethod: async () => initial,
      solve: live.solve,
    })
    expect(reopened.history()).toEqual([first, second])
    const decisions = live.store
      .load()
      .entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION)
      .filter(entry => entry.kind === STRATEGY_KINDS.roundDecided)
    expect(decisions).toHaveLength(2)
    expect(live.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).size).toBe(7)
  })

  it('freezes two independent area trials before execution and rejects a faster invalid implementation', async () => {
    const live = await fixture()
    const incumbent = await live.revision('baseline', initial, 1, true)
    const smaller = await live.revision(
      'smaller',
      {
        ...initial,
        skills: [
          {
            name: 'skill',
            description: 'method',
            capabilities: [],
            requiredTools: [],
            content: 'optimize the schedule',
          },
        ],
      },
      0.95,
      true,
    )
    const invalid = await live.revision(
      'invalid',
      { ...initial, tools: [{ name: 'tool', source: 'drops schedule words' }] },
      0.5,
      false,
    )
    const evolution = createEvolution({
      ...live.options,
      trials: 2,
      metric: { ...live.options.metric, unit: 'baseline area ratio', direction: 'lower' },
      calibration: { floor: 0.01, source: 'declared' },
      weights: { quality: 100, cost: 15 },
    })
    const round = await evolution.runRound({
      campaignId: 'test-campaign',
      roundId: 'area',
      round: 1,
      incumbent,
      candidates: [smaller, invalid],
    })
    expect(round.winner).toBe(0)
    expect(round.slots.map(slot => [slot.quality, slot.denominator, slot.constraintsMet])).toEqual([
      [0.95, 2, true],
      [0.5, 2, false],
    ])
    expect(live.calls).toHaveLength(6)
    const candidate = live.store
      .load()
      .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'area:0:candidate:evaluation')!
    expect(candidate.observed.map(trial => JSON.parse(trial.detail!))).toEqual([
      expect.objectContaining({ taskId: 'area:0:candidate:trial:0:task' }),
      expect.objectContaining({ taskId: 'area:0:candidate:trial:1:task' }),
    ])
  })

  it('accepts one candidate and rejects an empty comparison', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const candidate = await live.revision(
      'candidate',
      {
        ...initial,
        skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'new' }],
      },
      1,
    )
    await expect(
      live.evolution.runRound({ campaignId: 'test-campaign', roundId: 'empty', round: 1, incumbent, candidates: [] }),
    ).rejects.toThrow('at least one')
    const result = await live.evolution.runRound({
      campaignId: 'test-campaign',
      roundId: 'r1',
      round: 1,
      incumbent,
      candidates: [candidate],
    })
    expect(result.winner).toBe(0)
  })

  it.each([1, 2])(
    'excludes changed candidate contexts for %i candidates without failing or retrying the round',
    async count => {
      const live = await fixture()
      const incumbent = await live.revision('initial', initial, 0)
      const candidates = []
      for (let slot = 0; slot < count; slot++) {
        candidates.push(
          await live.revision(
            `changed-${slot}`,
            { ...initial, tools: [{ name: 'tool', source: `changed ${slot}` }] },
            1,
          ),
        )
        live.contexts.set(`excluded:${slot}:candidate:trial:0`, [`other conditions ${slot}`])
      }
      const request = { campaignId: 'test-campaign', roundId: 'excluded', round: 1, incumbent, candidates }
      const result = await live.evolution.runRound(request)
      expect(result.decided).toBe(true)
      expect(result.winner).toBeNull()
      expect(result.outcomes).toHaveLength(count)
      expect(result.outcomes.every(outcome => !outcome.admitted && outcome.reason.includes('conditions'))).toBe(true)
      const calls = live.calls.length
      expect(await live.evolution.runRound(request)).toEqual(result)
      expect(live.calls).toHaveLength(calls)
    },
  )

  it('excludes a changed candidate context without losing other candidates, but propagates unexpected solve failures', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision(
      'good',
      {
        ...initial,
        skills: [
          { name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ],
      },
      1,
    )
    const bad = await live.revision('bad', { ...initial, tools: [{ name: 'tool', source: 'another method' }] }, 1)
    live.contexts.set('r1:0:candidate:trial:0', ['changed dataset conditions'])
    const result = await live.evolution.runRound({
      campaignId: 'test-campaign',
      roundId: 'r1',
      round: 1,
      incumbent,
      candidates: [good, bad],
    })
    expect(result.winner).toBe(1)
    expect(result.slots[0]).toMatchObject({
      admissible: false,
      reason: expect.stringContaining('changed dataset conditions'),
    })
    expect(result.slots[0]!.reason).toContain('conditions')
    expect(result.slots[1]!.admissible).toBe(true)
    expect(live.calls.map(call => call.revision.revisionId)).toEqual(['initial', 'good', 'bad'])
    const count = live.store.load().entries().length
    expect(
      await live.evolution.runRound({
        campaignId: 'test-campaign',
        roundId: 'r1',
        round: 1,
        incumbent,
        candidates: [good, bad],
      }),
    ).toEqual(result)
    expect(live.store.load().entries()).toHaveLength(count)
    const failed = createEvolution({
      ...live.options,
      solve: async () => {
        throw new Error('native agent failed')
      },
    })
    await expect(
      failed.runRound({ campaignId: 'test-campaign', roundId: 'r2', round: 2, incumbent: bad, candidates: [good] }),
    ).rejects.toThrow('native agent failed')
    expect(live.evolution.history()).toEqual([result])
  })
})

it.each(['higher', 'lower'] as const)(
  'holds historical best quality across accepted search heads (%s) and resets at a new campaign',
  async direction => {
    const h = await fixture(),
      sign = direction === 'higher' ? 1 : -1
    const baseline = await h.revision('s0', initial, 0.9, true)
    const first = await h.revision(
      's1',
      { ...initial, workflowGuidance: 'Choose a cheaper investigation.' },
      0.9 - sign * 0.009,
      true,
    )
    const second = await h.revision(
      's2',
      { ...initial, workflowGuidance: 'Choose a still cheaper investigation.' },
      0.9 - sign * 0.018,
      true,
    )
    const solve: typeof h.solve = async request => ({
      ...(await h.solve(request)),
      cost: { s0: 100, s1: 90, s2: 81 }[request.revision.revisionId]!,
    })
    const evolution = createEvolution({
      ...h.options,
      metric: { ...h.options.metric, direction },
      calibration: { floor: 0.01, source: 'declared' },
      weights: { quality: 100, cost: 15 },
      baseline: solve,
      solve,
    })
    expect(
      (
        await evolution.runRound({
          campaignId: 'quality',
          roundId: 'quality-1',
          round: 1,
          incumbent: baseline,
          candidates: [first],
        })
      ).winner,
    ).toBe(0)
    const rejected = await evolution.runRound({
      campaignId: 'quality',
      roundId: 'quality-2',
      round: 2,
      incumbent: first,
      candidates: [second],
    })
    expect(rejected.winner).toBeNull()
    expect(rejected.slots[0]!.reason).toContain('historical best S* 0.9000')
    expect(
      (
        await evolution.runRound({
          campaignId: 'separate',
          roundId: 'separate-1',
          round: 1,
          incumbent: first,
          candidates: [second],
        })
      ).winner,
    ).toBe(0)
  },
)
