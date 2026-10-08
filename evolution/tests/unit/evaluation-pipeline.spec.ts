/**
 * The one entry, end to end: freeze both sides, run them, re-read the runtime's
 * receipts, validate, score and write one report. A second call reads the report
 * the first one wrote instead of running anything again.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluate, evaluationOf, evaluationIdOf, methodList, reportPathOf, withStrategy } from '../../src/pipeline/evaluate.ts'
import { DEFAULT_STRATEGY_POLICY } from '../../src/strategy/policy.ts'
import { assertEvaluationReport } from '../../src/pipeline/report.ts'
import { foldMethods } from '../../src/ledger/fold.ts'
import { digestOf } from '../../src/shared.ts'
import { evaluateInput, pipelineWorld, recordDraft, type PipelineWorld } from './pipeline-fixtures.ts'

const worlds: PipelineWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose()
})

async function world(input?: Parameters<typeof pipelineWorld>[0]): Promise<PipelineWorld> {
  const built = await pipelineWorld(
    input ?? { baseline: { outcome: 'failed', tokens: 1000 }, candidate: { outcome: 'verified', tokens: 1000 } },
  )
  worlds.push(built)
  await recordDraft(built)
  return built
}

describe('evaluate', () => {
  it('freezes, runs both sides, validates, scores and writes one report', async () => {
    const h = await world()
    const report = await evaluate(h.sources, evaluateInput(h))

    expect(report.formatVersion).toBe(5)
    expect(report.verdict).toBe('fixed')
    expect(report.trials).toHaveLength(1)
    expect(report.trials[0]!.baseline.outcome).toBe('failed')
    expect(report.trials[0]!.candidate.outcome).toBe('verified')
    expect(report.score.quality).toMatchObject({ baseline: 0, candidate: 1, delta: 1 })
    expect(report.guards.every(guard => guard.ok)).toBe(true)
    expect(() => assertEvaluationReport(report)).not.toThrow()

    const written = JSON.parse(await readFile(resolve(h.sources.root, reportPathOf('d0001', report.evaluationId)), 'utf8'))
    expect(written).toEqual(report)

    const lines = h.ledger.records()
    expect(lines.map(line => line.kind)).toEqual(['draft', 'plan', 'trial', 'trial', 'evaluation'])
    const view = foldMethods(h.ledger.records()).get('d0001')!
    expect(view.status).toBe('evaluated')
    expect(view.trials).toHaveLength(2)
    expect(view.evaluation?.verdict).toBe('fixed')
  })

  it('runs each side under its own revision, the candidate through the trial binding', async () => {
    const h = await world()
    await evaluate(h.sources, evaluateInput(h))
    const baseline = h.replays.find(replay => replay.side === 'baseline')!
    const candidate = h.replays.find(replay => replay.side === 'candidate')!
    expect(baseline.options.trialCandidateRef).toBeUndefined()
    expect(candidate.options.trialCandidateRef).toBe('c-d0001')
    expect(baseline.options.workspace?.path).not.toBe(candidate.options.workspace?.path)
  })

  it('is idempotent: a second call reads the report and runs nothing again', async () => {
    const h = await world()
    const first = await evaluate(h.sources, evaluateInput(h))
    const replaysAfterFirst = h.replays.length
    const second = await evaluate(h.sources, evaluateInput(h))
    expect(second).toEqual(first)
    expect(h.replays).toHaveLength(replaysAfterFirst)
    expect(h.ledger.records().filter(line => line.kind === 'evaluation')).toHaveLength(1)
  })

  it('reads the report back by digest, and refuses one that moved', async () => {
    const h = await world()
    const report = await evaluate(h.sources, evaluateInput(h))
    expect(await evaluationOf(h.sources, 'd0001')).toEqual(report)
    const path = resolve(h.sources.root, reportPathOf('d0001', report.evaluationId))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, `${JSON.stringify({ ...report, verdict: 'improved' })}\n`, 'utf8')
    await expect(evaluationOf(h.sources, 'd0001')).rejects.toThrow(/not the .* the ledger recorded/)
  })

  it('refuses a draft that was discarded', async () => {
    const h = await world()
    await h.ledger.append({ formatVersion: 5, kind: 'discard', draftId: 'd0001', reason: 'no evidence', actor: 'supervisor', at: '2026-10-08T00:00:00.000Z' })
    await expect(evaluate(h.sources, evaluateInput(h))).rejects.toThrow(/discarded/)
    expect(h.replays).toHaveLength(0)
  })

  it('lists the drafts of the library and freezes the strategy into the plan', async () => {
    const h = await world()
    const report = await evaluate(h.sources, evaluateInput(h))
    expect(methodList(h.sources).map(view => view.draft.draftId)).toEqual(['d0001'])
    const plan = withStrategy(report.plan, DEFAULT_STRATEGY_POLICY)
    expect(plan.strategy?.policyDigest).toBe(digestOf(DEFAULT_STRATEGY_POLICY))
    expect(plan.strategy?.cohortDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(evaluationIdOf(report.plan)).toBe(report.evaluationId)
  })
})
