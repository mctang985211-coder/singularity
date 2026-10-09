/**
 * The side plan: one freeze function produces both sides, and the frozen plan
 * says exactly what each side must bind — the revision, the rows, the registry
 * revision, the providers and the model. A draft written against another
 * revision, or a candidate that moved, is refused before anything runs.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { buildEvaluationPlan } from '../../src/pipeline/plan.ts'
import { assertSidePlan } from '../../src/ledger/records.ts'
import { digestOf } from '../../src/shared.ts'
import { BASELINE_REVISION, CANDIDATE_REVISION, MODEL, SAMPLE, evaluateInput, firstSkillDraft, pipelineWorld, type PipelineWorld } from './pipeline-fixtures.ts'

const worlds: PipelineWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose()
})

async function built(input?: Parameters<typeof pipelineWorld>[0]) {
  const world = await pipelineWorld(input ?? { baseline: { outcome: 'failed', tokens: 1 }, candidate: { outcome: 'verified', tokens: 1 } })
  worlds.push(world)
  const draft = firstSkillDraft()
  const plan = await buildEvaluationPlan(world.sources, {
    draft,
    samples: [{ taskId: SAMPLE, role: 'observed-failure' }],
    input: { sourceDir: world.inputDir },
    model: MODEL,
    rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better', extractor: 'original-acceptance' }, guards: [] },
    budget: {},
    repetition: 0,
    libraryId: 's-root',
  })
  return { world, draft, plan }
}

describe('one freeze for both sides', () => {
  it('binds each side to its own revision and both to the same model', async () => {
    const { plan } = await built()
    expect(plan.sides.baseline.revision.revisionId).toBe(BASELINE_REVISION)
    expect(plan.sides.candidate.revision.revisionId).toBe(CANDIDATE_REVISION)
    expect(plan.sides.baseline.model).toEqual(plan.sides.candidate.model)
    expect(plan.sides.candidate.registryRevision).not.toBe(plan.sides.baseline.registryRevision)
  })

  it('freezes the candidate side with the first Skill its baseline side does not hold', async () => {
    const { plan } = await built()
    expect(plan.sides.baseline.skills.map(skill => skill.name)).toEqual(['task-coordination'])
    expect(plan.sides.candidate.skills.map(skill => skill.name)).toEqual(['repair-guidance', 'task-coordination'])
    expect(plan.sides.baseline.capabilities).toEqual(['execute-task'])
    expect(plan.sides.candidate.capabilities).toEqual(['execute-task', 'method:repair-guidance'])
  })

  it('mirrors every sample’s acceptance into both sides unchanged', async () => {
    const { plan } = await built()
    expect(plan.sides.baseline.acceptance).toEqual(plan.sides.candidate.acceptance)
    expect(plan.sides.candidate.acceptance.map(criterion => criterion.criterionId)).toEqual(['c1'])
    expect(plan.sides.candidate.acceptance[0]).toMatchObject({ verifierRef: 'command', verifierVersion: '3' })
    expect(plan.samples[0]).toMatchObject({ taskId: SAMPLE, role: 'observed-failure' })
    expect(plan.input.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces a plan every reader can re-validate', async () => {
    const { plan } = await built()
    expect(() => assertSidePlan(plan.sides.baseline, 'baseline')).not.toThrow()
    expect(() => assertSidePlan(plan.sides.candidate, 'candidate')).not.toThrow()
    expect(plan.schemaVersion).toBe('evaluation-plan@1')
    expect(plan.overlay.candidate).toMatch(/trialCandidateRef/)
  })

  it('refuses a draft written against another revision, and a candidate that moved', async () => {
    const { world, draft } = await built()
    const input = {
      draft,
      samples: [{ taskId: SAMPLE, role: 'observed-failure' as const }],
      input: { sourceDir: world.inputDir },
      model: MODEL,
      rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better' as const, extractor: 'original-acceptance' }, guards: [] },
      budget: {},
      repetition: 0,
      libraryId: 's-root',
    }
    await expect(
      buildEvaluationPlan(world.sources, { ...input, draft: { ...draft, baseRevision: { ...draft.baseRevision, revisionId: 'r0009' } } }),
    ).rejects.toThrow(/active revision is "r0001"/)
    await expect(
      buildEvaluationPlan(world.sources, { ...input, draft: { ...draft, candidateRevision: { ...draft.candidateRevision, digest: digestOf({ other: 1 }) } } }),
    ).rejects.toThrow(/the candidate moved since it was drafted/)
  })

  it('freezes each side with a digest of its own table, so a moved row is refused', async () => {
    const { world } = await built()
    const moved = {
      ...world.sources,
      runtime: {
        ...world.sources.runtime,
        precheckCapabilityTable: async () => {
          throw new Error('fixture: the candidate table was refused')
        },
      },
    }
    await expect(
      buildEvaluationPlan(moved, {
        draft: firstSkillDraft(),
        samples: [{ taskId: SAMPLE, role: 'observed-failure' }],
        input: { sourceDir: world.inputDir },
        model: MODEL,
        rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better', extractor: 'original-acceptance' }, guards: [] },
        budget: {},
        repetition: 0,
        libraryId: 's-root',
      }),
    ).rejects.toThrow(/candidate table was refused/)
  })
})
