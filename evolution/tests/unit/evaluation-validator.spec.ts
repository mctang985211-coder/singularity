/**
 * The one validator, at both doors. Inside an evaluation it re-derives every
 * fact from the store; before a publish it re-derives them again *and* requires
 * the baseline revision to still be the active one. A report, a receipt, an
 * acceptance or a cost that does not re-derive refuses while nothing has moved.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { evaluate } from '../../src/pipeline/evaluate.ts'
import { validateEvaluation } from '../../src/pipeline/validate.ts'
import { scoreEvaluation } from '../../src/pipeline/score.ts'
import { buildEvaluationReport } from '../../src/pipeline/report.ts'
import { digestOf } from '../../src/shared.ts'
import { evaluateInput, pipelineWorld, recordDraft, type PipelineWorld } from './pipeline-fixtures.ts'
import type { EvaluationReport } from '../../src/types.ts'

const worlds: PipelineWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose()
})

async function evaluated(input?: Parameters<typeof pipelineWorld>[0]): Promise<{ world: PipelineWorld; report: EvaluationReport }> {
  const world = await pipelineWorld(input ?? { baseline: { outcome: 'failed', tokens: 1000 }, candidate: { outcome: 'verified', tokens: 1000 } })
  worlds.push(world)
  await recordDraft(world)
  return { world, report: await evaluate(world.sources, evaluateInput(world)) }
}

/** Rebuild one report around changed trials, so its own digests stay consistent. */
function rewrite(report: EvaluationReport, mutate: (report: EvaluationReport) => EvaluationReport): EvaluationReport {
  const next = mutate(report)
  return buildEvaluationReport({
    plan: next.plan,
    evaluationId: next.evaluationId,
    at: next.at,
    trials: next.trials,
    score: scoreEvaluation({ plan: next.plan, trials: next.trials, repeats: 1 }),
    guards: next.guards,
    verdict: next.verdict,
    ...(next.evaluation === undefined ? {} : { evaluation: next.evaluation }),
  })
}

describe('the pre-publish re-check', () => {
  it('accepts a report whose baseline revision is still the active one', async () => {
    const { world, report } = await evaluated()
    await expect(validateEvaluation({ report, sources: world.sources, mode: 'pre-publish' })).resolves.toMatchObject({ verdict: 'fixed' })
  })

  it('refuses when the baseline revision moved', async () => {
    const { world, report } = await evaluated()
    const active = await world.sources.runtime.activeRevision('s-root')
    const moved = {
      ...world.sources,
      runtime: { ...world.sources.runtime, activeRevision: async () => ({ ...active, ref: { ...active.ref, revisionId: 'r0002' } }) },
    }
    await expect(validateEvaluation({ report, sources: moved, mode: 'pre-publish' })).rejects.toThrow(/active revision is "r0002"/)
  })

  it('refuses a report whose verdict no longer recomputes', async () => {
    const { world, report } = await evaluated()
    const tampered = { ...report, verdict: 'improved' as const }
    await expect(validateEvaluation({ report: tampered, sources: world.sources, mode: 'pre-publish' })).rejects.toThrow(/recompute "fixed"/)
  })

  it('refuses a report whose score was rewritten', async () => {
    const { world, report } = await evaluated()
    const tampered = { ...report, score: { ...report.score, quality: { baseline: 0, candidate: 0.5, delta: 0.5, unit: 'acceptance-success-rate' } } }
    await expect(validateEvaluation({ report: tampered, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/does not recompute/)
  })
})

describe('identity, isolation and acceptance', () => {
  it('refuses a side whose receipt digest moved in the store', async () => {
    const { world, report } = await evaluated()
    const tampered = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({ ...comparison, candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, digest: digestOf({ other: 1 }) } } })),
    }))
    await expect(validateEvaluation({ report: tampered, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/cites receipt digest/)
  })

  it('refuses a candidate side bound to the baseline revision', async () => {
    const { world, report } = await evaluated()
    const tampered = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({ ...comparison, candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, boundRevision: 'r0001' } } })),
    }))
    await expect(validateEvaluation({ report: tampered, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/bound to revision "r0001"/)
  })

  it('refuses two sides that share one workspace, and a side built from another input', async () => {
    const { world, report } = await evaluated()
    const shared = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({
        ...comparison,
        candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, workspace: comparison.baseline.receipt.workspace } },
      })),
    }))
    await expect(validateEvaluation({ report: shared, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/independent workspaces/)
    const otherInput = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({ ...comparison, candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, workspaceDigest: digestOf({ other: 1 }) } } })),
    }))
    await expect(validateEvaluation({ report: otherInput, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/not the frozen input/)
  })

  it('refuses a criterion the frozen verifier did not decide, and one that is missing', async () => {
    const { world, report } = await evaluated()
    const otherJudge = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({
        ...comparison,
        candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, criteria: [{ criterionId: 'c1', verdict: 'pass', verifierId: 'other' }] } },
      })),
    }))
    await expect(validateEvaluation({ report: otherJudge, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/decided by verifier "other"/)
    const missing = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({ ...comparison, candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, criteria: [] } } })),
    }))
    await expect(validateEvaluation({ report: missing, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/judges no verdict for criterion "c1"/)
  })
})

describe('consumption, guards and cost', () => {
  it('proves the first Skill was really loaded by the candidate side', async () => {
    const world = await pipelineWorld({
      baseline: { outcome: 'failed', tokens: 1000 },
      candidate: { outcome: 'verified', tokens: 1000, skills: ['task-coordination'] },
    })
    worlds.push(world)
    await recordDraft(world)
    await expect(evaluate(world.sources, evaluateInput(world))).rejects.toThrow(/neither grants nor loads skill "repair-guidance"/)
  })

  it('refuses an unknown cost while the plan declares a ceiling', async () => {
    const { world, report } = await evaluated()
    const withCeiling = rewrite(
      { ...report, plan: { ...report.plan, budget: { maxTokens: 100 } } },
      current => current,
    )
    await expect(validateEvaluation({ report: withCeiling, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/unknown cost is never counted as zero|spent .* tokens against the frozen ceiling/)
  })

  it('refuses a side the store holds no receipt for', async () => {
    const { world, report } = await evaluated()
    const missing = rewrite(report, current => ({
      ...current,
      trials: current.trials.map(comparison => ({ ...comparison, candidate: { ...comparison.candidate, receipt: { ...comparison.candidate.receipt, runId: 'run-absent' } } })),
    }))
    await expect(validateEvaluation({ report: missing, sources: world.sources, mode: 'evaluate' })).rejects.toThrow(/holds no sealed receipt/)
  })
})
