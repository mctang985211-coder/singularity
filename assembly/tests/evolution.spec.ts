import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../../src/control/session-store.ts'
import { createEnvironmentCommands } from '../../src/environment/commands.ts'
import { declareEnvironmentProtocol } from '../../src/environment/protocol.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRegistry } from '../../src/protocol/registry.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf, type RevisionRef } from '../../src/task/protocol.ts'
import { createEvolution, structuralEditsOf, type SolveResult } from '../src/evolution.ts'
import { FakePersistence } from './seam.ts'

const criterion: AcceptanceCriterion = {
  criterionId: 'correct', statement: 'independent fixture acceptance', verifierRef: 'accept',
  verifierVersion: '1', implementationDigest: 'a'.repeat(64),
}
const inputs = [{ name: 'letters.txt', digest: 'b'.repeat(64) }]
const initial = {
  rootTemplate: 'root', templates: [{ id: 'root', goal: 'count letters' }, { id: 'part', goal: 'read letters' }],
  skill: 'count carefully', tool: 'export const count = input => input.length',
}
const calibration = { floor: 0, source: 'declared' as const }
const stores: ControlSessionStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })

async function fixture() {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: new FakePersistence() as unknown as SessionPersistence, controlId: 'evolution', registry,
    subjects: { scheduler: 'executor', environment: 'environment', strategy: 'strategy', [verifierRoleOf(criterion)]: 'acceptance' },
  })
  stores.push(store)
  const methods = new Map<string, typeof initial>()
  const quality = new Map<string, number>()
  const accepted = new Map<string, boolean>()
  const contexts = new Map<string, readonly string[]>()
  const calls: { revision: RevisionRef; operationId: string; roundWasOpen: boolean }[] = []
  const environments = createEnvironmentCommands({ store, registry })
  async function revision(id: string, assets: typeof initial, passed: number, met = passed === 1): Promise<RevisionRef> {
    await environments.createRevision({ commandId: `revision:${id}`, environmentId: 'methods', revisionId: id, manifest: assets })
    methods.set(id, assets)
    quality.set(id, passed)
    accepted.set(id, met)
    return { environmentId: 'methods', revisionId: id, digest: digestOf(assets) }
  }
  // This solve double establishes real core Task/Run/Bubble facts; native execution and token
  // accounting are the host port's separate integration contract.
  async function solve({ revision, operationId, started }: { revision: RevisionRef; operationId: string; started: (run: { taskId: string; runId: string }) => Promise<void> }): Promise<SolveResult> {
    const roundId = operationId.split(':')[0]!
    calls.push({ revision, operationId, roundWasOpen: store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)?.plan !== undefined })
    const taskId = `${operationId}:task`
    const runId = `${operationId}:run`
    const facts: readonly { readonly kind: string; readonly payload: unknown }[] = [
      { kind: TASK_KINDS.admitted, payload: { contract: {
        goal: 'count letters', template: { id: 'root', digest: 'c'.repeat(64) },
        inputs: [{ name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } }],
        criteria: [criterion],
      } } },
      { kind: TASK_KINDS.assigned, payload: { agentId: 'worker', agentIdentity: 'executor' } },
      { kind: TASK_KINDS.runStarted, payload: { runId, revision } },
      { kind: TASK_KINDS.bubbleOpened, payload: { runId, inputs,
        model: { provider: 'test', model: 'fixture' }, tools: [{ name: 'node', version: '1', implementationDigest: 'd'.repeat(64) }],
        conditions: contexts.get(operationId) ?? ['frozen fixture'], workspace: { kind: 'dir', ref: `/tmp/${operationId}` },
      } },
    ]
    for (const [index, fact] of facts.entries())
      await store.emit({ commandId: `${operationId}:${index}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: taskId, ...fact })
    await started({ taskId, runId })
    return { taskId, runId, quality: quality.get(revision.revisionId)!, met: accepted.get(revision.revisionId)!, cost: 100,
      artifactDigest: digestOf({ taskId }), inputDigests: inputs, implementationDigest: criterion.implementationDigest,
      acceptanceDigest: criterion.implementationDigest }
  }
  const metric = { measured: { ...criterion, criterionId: 'correct:quality' }, unit: 'pass', direction: 'higher' as const }
  const options = { store, registry, criterion, metric, trials: 1, weights: { quality: 1, cost: 0 }, rounds: 2, firstBudget: 3, minimumBudget: 1,
    calibration, loadMethod: async (ref: RevisionRef) => methods.get(ref.revisionId)!, solve }
  const evolution = createEvolution(options)
  return { store, registry, revision, evolution, calls, solve, contexts, options }
}

describe('method evolution', () => {
  it('counts actual template identities and the shared skill/tool content', () => {
    expect(structuralEditsOf(initial, {
      ...initial, templates: [{ id: 'root', goal: 'count exactly' }, { id: 'new', goal: 'new part' }],
      skill: 'count twice', tool: 'export const count = input => [...input].length',
    })).toEqual([
      { asset: 'template', target: 'new' }, { asset: 'template', target: 'part' }, { asset: 'template', target: 'root' },
      { asset: 'skill', target: 'skill' }, { asset: 'tool', target: 'tool' },
    ])
    expect(structuralEditsOf(initial, { ...initial, templates: [...initial.templates].reverse() })).toEqual([])
  })

  it('executes both sides for each candidate in two rounds and reads frozen closed history', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, skill: 'correct method' }, 1)
    const bad = await live.revision('bad', { ...initial, tool: 'broken method' }, 0)
    const first = await live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [good, bad], explorationSlots: 1 })
    expect(first.winner).toBe(0)
    expect(first.slots.map(slot => slot.quality)).toEqual([1, 0])
    expect(first.outcomes[1]?.admitted).toBe(false)
    expect(live.calls.map(call => [call.revision.revisionId, call.roundWasOpen])).toEqual([
      ['initial', false], ['initial', true], ['good', true], ['initial', true], ['bad', true],
    ])
    const submitted = live.store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'r1')!.submissions
    expect(submitted.map(candidate => ({ edits: candidate.edits, exploratory: candidate.exploratory }))).toEqual([
      { edits: [{ asset: 'skill', target: 'skill' }], exploratory: false },
      { edits: [{ asset: 'tool', target: 'tool' }], exploratory: true },
    ])

    const consumedHistory = live.evolution.history()
    expect(consumedHistory).toEqual([first])
    const next = await live.revision('next', { ...initial, skill: 'correct method', tool: 'different method' }, 1)
    const worse = await live.revision('worse', { ...initial, skill: 'incorrect method' }, 0)
    // The second proposal's incumbent and revisions are chosen from the committed first history.
    const previous = consumedHistory[0]!
    expect(previous.winner).toBe(0)
    const second = await live.evolution.runRound({ roundId: 'r2', round: 2, incumbent: good, candidates: [next, worse], explorationSlots: 1 })
    expect(second.winner).toBeNull()
    expect(live.calls).toHaveLength(10)

    const late = await live.solve({ revision: good, operationId: 'late', started: async () => undefined })
    const measure = createMeasureCommands({ store: live.store, registry: live.registry,
      implementations: [{ ref: criterion.verifierRef, version: criterion.verifierVersion, implementationDigest: criterion.implementationDigest }] })
    await measure.openEvaluation({ commandId: 'late:open', evaluationId: 'late', baseline: good, candidate: good,
      run: { taskId: late.taskId, runId: late.runId }, metric: { measured: { ...criterion, criterionId: 'correct:quality' }, unit: 'pass', direction: 'higher' }, weights: { quality: 1, cost: 0 }, trials: 1, judgement: [criterion] })
    await measure.recordTrial({ commandId: 'late:trial', evaluationId: 'late', trial: { ...late, slot: 0, quality: 0 } })
    expect(live.evolution.history()).toEqual([first, second])
    const reopened = createEvolution({ ...live.options, rounds: 2, firstBudget: 3,
      minimumBudget: 1, calibration: { floor: 999, source: 'declared' }, loadMethod: async () => initial, solve: live.solve })
    expect(reopened.history()).toEqual([first, second])
    const decisions = live.store.load().entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).filter(entry => entry.kind === STRATEGY_KINDS.roundDecided)
    expect(decisions).toHaveLength(2)
    expect(live.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).size).toBe(11)
  })

  it('freezes two independent area trials before execution and rejects a faster invalid implementation', async () => {
    const live = await fixture()
    const incumbent = await live.revision('baseline', initial, 1, true)
    const smaller = await live.revision('smaller', { ...initial, skill: 'optimize the schedule' }, 0.95, true)
    const invalid = await live.revision('invalid', { ...initial, tool: 'drops schedule words' }, 0.5, false)
    const evolution = createEvolution({ ...live.options, trials: 2,
      metric: { ...live.options.metric, unit: 'baseline area ratio', direction: 'lower' },
      calibration: { floor: 0.01, source: 'declared' }, weights: { quality: 100, cost: 15 } })
    const round = await evolution.runRound({ roundId: 'area', round: 1, incumbent, candidates: [smaller, invalid], explorationSlots: 1 })
    expect(round.winner).toBe(0)
    expect(round.slots.map(slot => [slot.quality, slot.denominator, slot.constraintsMet])).toEqual([[0.95, 2, true], [0.5, 2, false]])
    expect(live.calls).toHaveLength(10)
    const candidate = live.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'area:0:candidate:evaluation')!
    expect(candidate.observed.map(trial => JSON.parse(trial.detail!))).toEqual([
      expect.objectContaining({ taskId: 'area:0:candidate:trial:0:task' }),
      expect.objectContaining({ taskId: 'area:0:candidate:trial:1:task' }),
    ])
  })

  it('refuses fewer than two candidates and actual over-budget content before running', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const candidate = await live.revision('candidate', { ...initial, skill: 'new', tool: 'new' }, 1)
    const other = await live.revision('other', { ...initial, skill: 'other' }, 1)
    await expect(live.evolution.runRound({ roundId: 'r2', round: 2, incumbent, candidates: [candidate], explorationSlots: 0 })).rejects.toThrow(/at least two/)
    await expect(live.evolution.runRound({ roundId: 'r2', round: 2, incumbent, candidates: [candidate, other], explorationSlots: 0 })).rejects.toThrow(/budget/)
    expect(live.calls).toEqual([])
  })

  it('refuses a changed paired baseline context and propagates solve failure without deciding', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, skill: 'correct method' }, 1)
    const bad = await live.revision('bad', { ...initial, tool: 'broken method' }, 0)
    live.contexts.set('r1:0:baseline:trial:0', ['changed dataset conditions'])
    await expect(live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [good, bad], explorationSlots: 0 })).rejects.toThrow(/caliber/)
    expect(live.evolution.history()).toEqual([])
    expect(live.calls).toHaveLength(2)
    const failed = createEvolution({ ...live.options, solve: async () => { throw new Error('native agent failed') } })
    await expect(failed.runRound({ roundId: 'r2', round: 2, incumbent, candidates: [good, bad], explorationSlots: 0 })).rejects.toThrow('native agent failed')
    expect(live.evolution.history()).toEqual([])
  })
})
