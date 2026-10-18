import { describe, expect, it } from 'vitest'
import { digestOf } from '../src/protocol/envelope.ts'
import { parseSuite, matrixOf, trialKey } from '../src/measure/suite.ts'
import { projectEvaluation } from '../src/measure/view.ts'
import type { EvaluationState } from '../src/measure/protocol.ts'

const contract = (goal: string) => ({ goal, artifact: 'answer.txt', inputs: [], criteria: [{ criterionId: 'correct', statement: 'independent oracle' }] })
const sample = () => ({ version: 1, suiteId: 'fixture-v1', failureQuality: 0, cases: [
  { caseId: 'a', familyId: 'parsing', sourceId: 'source-a', split: 'evolve', weight: 1, trials: 2, contract: contract('parse input'), hardGuards: [] },
  { caseId: 'b', familyId: 'arithmetic', sourceId: 'source-b', split: 'evolve', weight: 2, trials: 1, contract: contract('calculate result'), hardGuards: [] },
  { caseId: 'unseen', familyId: 'unseen-family', sourceId: 'source-c', split: 'heldout', weight: 1, trials: 1, contract: contract('unseen request'), hardGuards: [] },
] })
describe('frozen suite identity and denominator', () => {
  it('rejects source/family leakage, duplicate cases and mutable upstream artifacts', () => {
    for (const key of ['familyId', 'sourceId'] as const) {
      const raw = sample(); raw.cases[2]![key] = raw.cases[0]![key]
      expect(() => parseSuite(raw)).toThrow('overlaps splits')
    }
    const raw = sample(); raw.cases[1]!.contract = raw.cases[0]!.contract
    expect(() => parseSuite(raw)).toThrow('duplicate')
  })
  it('freezes the exact slots and changes TrialKey for every experiment treatment', () => {
    const suite = parseSuite(sample()), profile = 'a'.repeat(64), matrix = matrixOf(suite, 'evolve', profile)
    expect(matrix.slots.map(s => [s.caseId, s.trial, s.weight])).toEqual([['a', 0, .5], ['a', 1, .5], ['b', 0, 2]])
    expect(matrix.slots.some(s => s.caseId === 'unseen')).toBe(false)
    const revision = { environmentId: 'methods', revisionId: 'h0', digest: 'b'.repeat(64) }
    const key = trialKey(matrix, revision, matrix.slots[0]!, 'round-1:baseline')
    expect(trialKey(matrixOf(parseSuite(sample()), 'evolve', profile), revision, matrix.slots[0]!, 'round-1:baseline')).toBe(key)
    expect(trialKey(matrixOf(suite, 'evolve', 'c'.repeat(64)), revision, matrix.slots[0]!, 'round-1:baseline')).not.toBe(key)
    expect(trialKey(matrix, revision, matrix.slots[0]!, 'round-2:baseline')).not.toBe(key)
    const changed = sample(); changed.cases[0]!.weight = 2
    expect(matrixOf(parseSuite(changed), 'evolve', profile).suiteDigest).not.toBe(matrix.suiteDigest)
  })
  it('scores business failures, keeps missing trials in the denominator and reports families separately', () => {
    const matrix = matrixOf(parseSuite(sample()), 'evolve', 'a'.repeat(64))
    const trial = { slot: 0, quality: 1.2, cost: 10, artifactDigest: 'b'.repeat(64), inputDigests: [], verifierRef: 'oracle', verifierVersion: '1', implementationDigest: 'c'.repeat(64), guardsMet: true }
    const state: EvaluationState = { evaluationId: 'e', trials: 3, observed: [trial, { ...trial, slot: 1 }], checks: [], judgement: [], missed: [], matrix,
      failed: [{ slot: 2, quality: 0, cost: 20, status: 'no-submission', reason: 'legitimate business failure', run: { taskId: 't', runId: 'r' },
        verifierRef: 'oracle', verifierVersion: '1', implementationDigest: 'c'.repeat(64), guardsMet: true }] }
    const view = projectEvaluation(state)
    expect(view).toMatchObject({ denominator: 3, observed: 3, cost: 40, admissible: true, missing: [] })
    expect(view.quality).toBeCloseTo(.4)
    expect(view.families).toEqual([{ familyId: 'arithmetic', quality: 0, planned: 1, observed: 1 }, { familyId: 'parsing', quality: 1.2, planned: 2, observed: 2 }])
    expect(projectEvaluation({ ...state, failed: [], missed: [{ slot: 2, reason: 'provider unavailable', verifierRef: 'oracle', verifierVersion: '1' }] })).toMatchObject({ admissible: false })
    expect(projectEvaluation({ ...state, observed: [{ ...trial, guardsMet: false }, { ...trial, slot: 1 }] }).admissible).toBe(false)
    expect(digestOf(matrix)).toHaveLength(64)
  })
})
