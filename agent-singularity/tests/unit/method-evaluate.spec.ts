/**
 * `method_evaluate` against a recorded evaluation: the caller names the cohort
 * and the scale, the pipeline's own read-back returns the same report without
 * charging again, and the one decision record the publication reads is written
 * once from that report.
 */
import { describe, expect, it } from 'vitest'
import { defineMethodEvaluateTool } from '../../src/tools/method-evaluate.ts'
import { forgeEvaluation, methodWorld } from './method-tools.fixture.ts'

const evaluateTool = (ctx: never) => defineMethodEvaluateTool(ctx)

const CALL = {
  draftId: 'd0001',
  round: 0,
  samples: [{ taskId: 't1', role: 'observed-failure' }],
  quality: { metricId: 'acceptance', extractor: 'acceptance' },
  repetition: 2,
  input: { sourceDir: '/tmp/in' },
} as const

describe('method_evaluate', () => {
  it('refuses a call that names no sample: the cohort is never inferred', async () => {
    const world = await methodWorld()
    try {
      const answer = (await evaluateTool(world.ctx as never).execute({ ...CALL, samples: [] }, world.exec as never)) as string
      expect(answer).toContain('the cohort is never inferred')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a sample role outside the frozen vocabulary at the declared schema', async () => {
    const world = await methodWorld()
    try {
      await expect(
        evaluateTool(world.ctx as never).execute({ ...CALL, samples: [{ taskId: 't1', role: 'guessed' }] }, world.exec as never),
      ).rejects.toThrow(/must be one of \["observed-failure"/)
    } finally {
      await world.dispose()
    }
  })

  it('refuses a call with no declared scale or no clean input directory', async () => {
    const world = await methodWorld()
    try {
      expect(await evaluateTool(world.ctx as never).execute({ ...CALL, quality: {} }, world.exec as never)).toContain('quality.metricId is required')
      expect(await evaluateTool(world.ctx as never).execute({ ...CALL, input: {} }, world.exec as never)).toContain('input.sourceDir is required')
    } finally {
      await world.dispose()
    }
  })

  it('refuses an evaluation plan outside the llm-outcome objective, and requires a goal inside it', async () => {
    const world = await methodWorld()
    try {
      expect(await evaluateTool(world.ctx as never).execute(
        { ...CALL, evaluation: { goal: 'domain benefit' } },
        world.exec as never,
      )).toContain('evaluation is only valid for the llm-outcome objective')
      expect(await evaluateTool(world.ctx as never).execute(
        { ...CALL, objective: 'llm-outcome' },
        world.exec as never,
      )).toContain('requires evaluation.goal')
    } finally {
      await world.dispose()
    }
  })

  it('returns the recorded report for a frozen cohort without measuring or charging twice, and writes one decision', async () => {
    const world = await methodWorld()
    try {
      const forged = await forgeEvaluation(world, { cost: 'reported' })
      const first = (await evaluateTool(world.ctx as never).execute({ ...CALL, draftId: forged.draftId }, world.exec as never)) as string
      expect(first).toContain(`evaluation ${forged.evaluationId}`)
      expect(first).toContain('admission: admissible')
      expect(first).toContain('scope:')
      const second = (await evaluateTool(world.ctx as never).execute({ ...CALL, draftId: forged.draftId }, world.exec as never)) as string
      expect(second).toContain('already measured under this frozen cohort')
      expect(second).toContain('nothing was charged again')
      // One decision record, recomputable from the report, written beside it.
      const lines = (await world.ledgerText()).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
      expect(lines.filter(line => line.kind === 'evaluation')).toHaveLength(1)
    } finally {
      await world.dispose()
    }
  })

  it('reads a candidate whose cost nobody reports as inconclusive, never as a free improvement', async () => {
    const world = await methodWorld()
    try {
      const forged = await forgeEvaluation(world, { cost: 'unknown' })
      const answer = (await evaluateTool(world.ctx as never).execute({ ...CALL, draftId: forged.draftId }, world.exec as never)) as string
      expect(answer).toContain('admission: cost-inconclusive')
      expect(answer).toContain('next: method_discard')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a call this deployment cannot resolve a model for', async () => {
    const world = await methodWorld()
    try {
      delete world.ctx.agentDefaultModel
      const answer = (await evaluateTool(world.ctx as never).execute({ ...CALL, draftId: 'd0001' }, world.exec as never)) as string
      expect(answer).toContain('offers no default model')
    } finally {
      await world.dispose()
    }
  })
})
