/**
 * The one trial schema. A side is a settled outcome, its revision, the model it
 * ran under, the criteria its judges decided, the evidence it cites and its own
 * cost reading — and a side the runtime refused at admission says exactly that,
 * with no run, no review and no invented cost.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { assertTrialResult, validateDraftRecord } from '../../src/ledger/records.ts'
import { receiptRefOf, trialCriteriaOf } from '../../src/evidence/receipt.ts'
import { evaluate } from '../../src/pipeline/evaluate.ts'
import { buildEvaluationPlan } from '../../src/pipeline/plan.ts'
import { evaluateInput, firstSkillDraft, pipelineWorld, recordDraft, SAMPLE, type PipelineWorld } from './pipeline-fixtures.ts'
import { trial } from './method-fixtures.ts'

const worlds: PipelineWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose()
})

describe('the trial schema', () => {
  it('accepts a settled side and refuses an unknown side or outcome', () => {
    const good = trial({ sampleTaskId: SAMPLE, side: 'candidate' })
    expect(() => assertTrialResult(good, 'trial')).not.toThrow()
    expect(() => assertTrialResult({ ...good, side: 'middle' }, 'trial')).toThrow(/side must be baseline or candidate/)
    expect(() => assertTrialResult({ ...good, outcome: 'unknown' }, 'trial')).toThrow(/outcome must be one of/)
    expect(() => assertTrialResult({ ...good, receipt: { ...good.receipt, cost: { status: 'reported' } } }, 'trial')).toThrow(/carries no token buckets/)
  })

  it('requires a reason from an interrupted side, at the schema door and at the ledger door', () => {
    const interrupted = { ...trial({ sampleTaskId: SAMPLE, side: 'baseline' }), outcome: 'interrupted' as const }
    expect(() => assertTrialResult(interrupted, 'trial')).toThrow(/carries no reason/)
    expect(() =>
      validateDraftRecord({ formatVersion: 5, kind: 'trial', draftId: 'd0001', evaluationId: 'e-1', trial: interrupted }),
    ).toThrow(/interrupted/)
  })

  it('keeps the verifier that decided each criterion', () => {
    const criteria = trialCriteriaOf([{ criterionId: 'c1', verdict: 'pass', verifierId: 'command', verifierVersion: '3', command: 'true', exitCode: 0 } as never])
    expect(criteria).toEqual([{ criterionId: 'c1', verdict: 'pass', verifierId: 'command', verifierVersion: '3', command: 'true', exitCode: 0 }])
  })

  it('reads its identity, model and cost from the runtime’s own receipt', async () => {
    const world = await pipelineWorld({ baseline: { outcome: 'failed', tokens: 1234 }, candidate: { outcome: 'verified', tokens: 1234 } })
    worlds.push(world)
    await recordDraft(world)
    const report = await evaluate(world.sources, evaluateInput(world))
    const baseline = report.trials[0]!.baseline
    expect(baseline.receipt.boundRevision).toBe('r0001')
    expect(baseline.receipt.boundModel).toBe('test-provider/test-model')
    expect(baseline.receipt.reviewRef).toBe(`replay-baseline#run-baseline`)
    expect(baseline.receipt.cost).toMatchObject({ status: 'reported', tokens: { uncachedInputTokens: 1234 } })
    expect(baseline.receipt.complete).toBe(true)
    expect(receiptRefOf).toBeTypeOf('function')
  })
})

describe('a side the runtime refused at admission', () => {
  it('is recorded as not-admitted, with the refusal and no invented run', async () => {
    const world = await pipelineWorld({ baseline: { outcome: 'failed', tokens: 10 }, candidate: { outcome: 'verified', tokens: 10 } })
    worlds.push(world)
    await recordDraft(world)
    const sources = {
      ...world.sources,
      runtime: { ...world.sources.runtime, capabilitiesForSession: async () => ({}) },
    }
    const plan = await buildEvaluationPlan(sources, {
      draft: firstSkillDraft(),
      samples: [{ taskId: SAMPLE, role: 'observed-failure' }],
      input: { sourceDir: world.inputDir },
      model: { provider: 'test-provider', model: 'test-model', label: 'test-provider/test-model' },
      rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better', extractor: 'original-acceptance' }, guards: [] },
      budget: {},
      repetition: 0,
      libraryId: 's-root',
    })
    expect(plan.samples[0]!.admission).toMatchObject({ source: 'capability-gap', missing: ['execute-task'] })

    const report = await evaluate(sources, evaluateInput(world))
    const baseline = report.trials[0]!.baseline
    expect(baseline.outcome).toBe('not-admitted')
    expect(baseline.admission?.source).toBe('capability-gap')
    expect(baseline.receipt.runId).toBeUndefined()
    expect(baseline.receipt.taskId).toBeUndefined()
    expect(baseline.receipt.reviewRef).toBeUndefined()
    expect(baseline.receipt.evidenceRefs).toEqual([])
    expect(baseline.receipt.cost.status).toBe('unknown')
    expect(baseline.receipt.complete).toBe(false)
    expect(report.verdict).toBe('inconclusive')
    expect(world.replays.map(replay => replay.side)).toEqual(['candidate'])
  })
})
