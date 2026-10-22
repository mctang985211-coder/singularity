import { expect, it } from 'vitest'
import type { EvaluationState } from '../../src/measure/protocol.ts'
import { MEASURE_PROTOCOL } from '../../src/measure/protocol.ts'
import { matrixOf, parseSuite } from '../../src/measure/suite.ts'
import { STRATEGY_PROTOCOL, type RoundState } from '../../src/strategy/protocol.ts'
import type { TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { searchFeedback, searchView } from '../src/rsi-history.ts'

const h0 = { environmentId: 'methods', revisionId: 'h0', digest: 'a'.repeat(64) }
const h1 = { ...h0, revisionId: 'h1', digest: 'b'.repeat(64) }

function fixture() {
  let task: TaskState = { taskId: 'analysis', search: { runId: 'run', maxProposals: 6 },
    runs: { run: { runId: 'run', purpose: 'improve', revision: h0, status: 'verified', stage: 'submitted', evidence: [], consumed: [], emitter: 'scheduler', actor: 'scheduler', startedAt: '' } },
    rounds: [{ runId: 'run', roundId: 'round', round: 1, incumbent: h0, candidates: [h1], status: 'completed' }] }
  const evaluation = (evaluationId: string, candidate: typeof h0): { -readonly [K in keyof EvaluationState]: EvaluationState[K] } => ({
    evaluationId, baseline: h0, candidate, trials: 1, checks: [], judgement: [], missed: [],
    metric: { measured: { criterionId: 'quality', statement: 'correct', verifierRef: 'oracle', verifierVersion: '1', implementationDigest: 'c'.repeat(64) },
      unit: 'pass', direction: 'higher' },
    observed: [{ slot: 0, quality: 1, cost: 100, artifactDigest: 'd'.repeat(64), inputDigests: [], guardsMet: true,
      implementationDigest: 'c'.repeat(64), verifierRef: 'oracle', verifierVersion: '1' }],
  })
  const baseline = evaluation('round:bootstrap:evaluation', h0), candidate = evaluation('candidate-evaluation', h1)
  const round: RoundState = { roundId: 'round', submissions: [{ slot: 0, revision: h1, evaluationId: candidate.evaluationId,
    edits: [], actor: 'scheduler', at: '' }], decision: { winner: null, outcomes: [], calibration: { floor: 0, source: 'declared' }, at: '' } }
  const evaluations = new Map([[baseline.evaluationId, baseline], [candidate.evaluationId, candidate]])
  const rounds = new Map([['round', round]])
  const apparatus = { controlId: 'history', store: { load: () => ({ entries: () => [], statesOf: (protocol: string) =>
    protocol === STRATEGY_PROTOCOL ? rounds : protocol === MEASURE_PROTOCOL ? evaluations : new Map() }) } } as unknown as Apparatus
  return { baseline, candidate, evaluations, rounds, view: () => searchView(apparatus, task),
    task: (change: Partial<TaskState>) => { task = { ...task, ...change } } }
}

it('reports no improvement only after a complete comparison, including measured failures', () => {
  const h = fixture()
  expect(h.view()).toMatchObject({ outcome: 'no-improvement' })
  h.candidate.observed = h.candidate.observed.map(trial => ({ ...trial, quality: 0, guardsMet: false }))
  expect(h.view()).toMatchObject({ outcome: 'no-improvement' })
})

it.each(['missed-baseline', 'missed-candidate', 'unknown-cost', 'no-decision', 'no-candidate', 'no-rounds'])(
  'keeps %s as insufficient evidence even when the evaluation job completed', fault => {
    const h = fixture()
    if (fault.startsWith('missed-')) {
      const evaluation = fault === 'missed-baseline' ? h.baseline : h.candidate
      evaluation.observed = []
      evaluation.missed = [{ slot: 0, reason: 'provider unavailable', verifierRef: 'oracle', verifierVersion: '1' }]
    }
    if (fault === 'unknown-cost') h.candidate.observed = h.candidate.observed.map(({ cost: _, ...trial }) => trial)
    if (fault === 'no-decision') {
      const { decision: _, ...round } = h.rounds.get('round')!
      h.rounds.set('round', round)
    }
    if (fault === 'no-candidate') h.rounds.set('round', { ...h.rounds.get('round')!, submissions: [] })
    if (fault === 'no-rounds') h.task({ rounds: [] })
    expect(h.view()).toMatchObject({ outcome: 'insufficient-evidence' })
  },
)

it('keeps an undersampled suite as insufficient evidence and leaves a working search open', () => {
  const h = fixture()
  const suite = parseSuite({ version: 1, suiteId: 'one-family', failureQuality: 0, cases: [{ caseId: 'case', familyId: 'family',
    sourceId: 'source', split: 'evolve', trials: 1, weight: 1, hardGuards: [],
    contract: { goal: 'case', artifact: 'result.txt', inputs: [], criteria: [{ criterionId: 'correct', statement: 'correct' }] } }] })
  h.baseline.matrix = matrixOf(suite, 'evolve', 'e'.repeat(64))
  h.candidate.matrix = h.baseline.matrix
  expect(h.view()).toMatchObject({ outcome: 'insufficient-evidence' })
  h.task({ transfer: { baseline: h0, champion: h1, suiteDigest: 'f'.repeat(64), executionProfileDigest: 'e'.repeat(64),
    roundId: 'validation', consumed: true, outcome: 'no-improvement' } })
  expect(h.view()).toMatchObject({ outcome: 'no-improvement' })
  h.task({ transfer: { baseline: h0, champion: h1, suiteDigest: 'f'.repeat(64), executionProfileDigest: 'e'.repeat(64),
    roundId: 'validation', consumed: true } })
  expect(h.view()).toMatchObject({ outcome: 'insufficient-evidence' })
  h.task({ runs: { run: { runId: 'run', purpose: 'improve', revision: h0, status: 'running', stage: 'working', evidence: [], consumed: [], emitter: 'scheduler', actor: 'scheduler', startedAt: '' } } })
  expect(h.view()).not.toHaveProperty('outcome')
})

it('exposes bounded calculator details from recorded evolve trials to the next proposal', async () => {
  const source: TaskState = { taskId: 'business', contract: { goal: 'design', artifact: 'design.v', inputs: [],
    criteria: [{ criterionId: 'correct', statement: 'correctness' }] }, runs: { run: { runId: 'run', purpose: 'solve',
    revision: h0, status: 'verified', stage: 'submitted', evidence: [], consumed: [], emitter: 'scheduler', actor: 'scheduler', startedAt: '' } } }
  const task: TaskState = { ...source, taskId: 'analysis', search: { runId: 'run', maxProposals: 2, batches: [] },
    runs: { run: { ...source.runs['run']!, purpose: 'improve', relatedTo: { taskId: source.taskId, runId: 'run' } } } }
  const h = fixture()
  const metrics = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`metric-${i}`, { value: i, unit: 'ns' }]))
  const report = { quality: 1.23, metrics, detail: 'x'.repeat(3000) }
  const criteria = [{ criterionId: 'correct', verdict: 'pass', hardGuard: true }]
  for (const evaluation of h.evaluations.values()) evaluation.observed = evaluation.observed.map(trial => ({ ...trial,
    detail: JSON.stringify({ measurement: report, criteria }) }))
  const round = h.rounds.get('round')!
  h.rounds.set('round', { ...round, plan: { campaignId: task.taskId, round: 1, incumbent: h0, candidates: 1,
    historyCutoff: 0, caliber: 'a'.repeat(64), weights: { quality: 1, cost: 0 } } })
  const tasks = new Map([[task.taskId, task], [source.taskId, source]])
  const apparatus = { controlId: 'history', domain: {}, store: { load: () => ({ entries: () => [],
    stateOf: (_protocol: string, _version: number, id: string) => tasks.get(id),
    statesOf: (protocol: string) => protocol === STRATEGY_PROTOCOL ? h.rounds : protocol === MEASURE_PROTOCOL ? h.evaluations
      : protocol === 'task' ? tasks : new Map() }) } } as unknown as Apparatus
  const feedback = await searchFeedback(apparatus, task)
  const trial = feedback.edits[0]!.workflow!.candidate[0]!
  expect(trial.criteria).toEqual(criteria)
  expect(trial.measurement).toMatchObject({ quality: 1.23, metricCount: 40 })
  expect(Object.keys(trial.measurement!.metrics)).toHaveLength(32)
  expect(trial.measurement!.detail).toHaveLength(2048)
  expect(JSON.parse(h.candidate.observed[0]!.detail!).measurement.metrics).toEqual(metrics)
})
