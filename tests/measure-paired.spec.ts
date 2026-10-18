import { expect, it } from 'vitest'
import { matrixOf, parseSuite } from '../src/measure/suite.ts'
import { pairedReport } from '../src/measure/paired.ts'
import { calibrationFrom } from '../src/measure/calibration.ts'
import type { EvaluationState } from '../src/measure/protocol.ts'

const matrix = matrixOf(parseSuite({ version: 1, suiteId: 'independent-families', failureQuality: 0,
  cases: ['parse', 'calculate', 'compose'].map(id => ({ caseId: id, familyId: id, sourceId: id, split: 'validation', weight: 1, trials: 2,
    contract: { goal: id, artifact: 'result.txt', inputs: [], criteria: [{ criterionId: 'correct', statement: id }] }, hardGuards: [] })) }), 'validation', 'a'.repeat(64))
const state = (qualities: readonly number[], costs: readonly number[] = qualities.map(() => 100)): EvaluationState => ({
  evaluationId: 'evaluation', matrix, trials: matrix.slots.length, checks: [], judgement: [], missed: [],
  observed: qualities.map((quality, slot) => ({ quality, slot, cost: costs[slot]!, artifactDigest: 'b'.repeat(64), inputDigests: [],
    implementationDigest: 'c'.repeat(64), verifierRef: 'independent', verifierVersion: '1', guardsMet: true })),
})

it('pairs independent families, reports prediction failures and keeps missing evidence out of release', () => {
  const baseline = state([0, 0, 0, 0, 0, 0]), candidate = state([1, 1, 1, 1, 1, 1])
  expect(pairedReport(baseline, candidate, ['parse'])).toMatchObject({ status: 'improved', interval: [1, 1],
    costCoverage: 1, predictions: { hit: ['parse'], missed: [], unexpected: [] } })
  expect(pairedReport(baseline, { ...candidate, observed: candidate.observed.slice(1) }).status).toBe('insufficient-evidence')
  expect(pairedReport(baseline, { ...candidate, observed: candidate.observed.map(t => ({ ...t, guardsMet: false })) }).status).toBe('insufficient-evidence')
  expect(pairedReport(baseline, state([1, 1, 1, 1, 1, 1], [126, 126, 126, 126, 126, 126])).status).toBe('no-improvement')
  const mixed = pairedReport(state([1, 1, 1, 1, 1, 1]), state([0, 0, 1, 1, 2, 2]), ['calculate'])
  expect(mixed).toMatchObject({ status: 'no-improvement', regressions: ['parse'], predictions: { hit: [], missed: ['calculate'], unexpected: ['parse'] } })
})

it('allows reliable cost reduction at preserved quality and refuses a noisy tradeoff', () => {
  const baseline = state([1, 1, 1, 1, 1, 1])
  expect(pairedReport(baseline, state([1, 1, 1, 1, 1, 1], [80, 80, 80, 80, 80, 80]))).toMatchObject({ status: 'improved', interval: [0, 0] })
  expect(pairedReport(baseline, state([1, 1, 1, 1, 1, 1], [10, 10, 100, 100, 120, 120])).status).toBe('no-improvement')
  expect(pairedReport(baseline, state([.99, .99, .99, .99, .99, .99], [80, 80, 80, 80, 80, 80])).status).toBe('no-improvement')
})

it('estimates noise only from repeated observations and preserves a declared floor', () => {
  expect(calibrationFrom(state([0, 1, 0, 1, 0, 1]), { floor: .01, source: 'declared' })).toMatchObject({ source: 'measured', floor: expect.any(Number) })
  expect(calibrationFrom(state([1, 1, 1, 1, 1, 1]), { floor: .02, source: 'declared' })).toEqual({ source: 'measured', floor: .02 })
  const singleton: EvaluationState = { evaluationId: 'singleton', trials: 1, observed: state([1]).observed, judgement: [], checks: [], missed: [] }
  expect(calibrationFrom(singleton, { floor: .03, source: 'declared' })).toEqual({ source: 'declared', floor: .03 })
})
