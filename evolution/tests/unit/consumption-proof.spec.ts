/**
 * The three special semantics: a first Skill proved by the log, a capability gap
 * proved by the runtime's own refusal, and a template proved to have been
 * instantiated while its parent acceptance stays independently judged.
 */

import { describe, expect, it } from 'vitest'
import type { ExecutionReceipt } from '@dangosys/dsh-singularity-task'
import { proveAdmissionRefusal, proveSkillLoaded, proveTemplateConsumed } from '../../src/evidence/consumption.ts'
import { samplePlan, trial } from './method-fixtures.ts'
import type { EvaluationPlan } from '../../src/types.ts'

/** The receipt members the consumption proofs read, and nothing else. */
function receipt(input: {
  skills?: readonly { bound: readonly { name: string }[]; loaded: readonly string[]; runId: string; loadedOutsideGrant?: readonly string[] }[]
  templates?: readonly { templateRef: { id: string; version: number; digest: string }; observation: 'observed' | 'not-observed' | 'unavailable'; childTaskIds: readonly string[] }[]
  criteria?: readonly string[]
}): ExecutionReceipt {
  return {
    skills: (input.skills ?? []).map(use => ({
      runId: use.runId,
      bound: use.bound.map(skill => ({ ...skill, role: 'guidance', contentDigest: 'a'.repeat(64), contractDigest: null })),
      loaded: use.loaded,
      loadedOutsideGrant: use.loadedOutsideGrant ?? [],
    })),
    templates: (input.templates ?? []).map(batch => ({
      runId: 'run-1',
      proposalId: 'p1',
      batchId: 'b1',
      templateRef: batch.templateRef,
      templateParameters: {},
      childTaskIds: batch.childTaskIds,
      observation: batch.observation,
    })),
    review: { criteria: (input.criteria ?? []).map(criterionId => ({ criterionId, verdict: 'pass' })) },
  } as unknown as ExecutionReceipt
}

function firstSkillPlan(): EvaluationPlan {
  const plan = samplePlan()
  return {
    ...plan,
    sides: {
      baseline: plan.sides.baseline,
      candidate: {
        ...plan.sides.candidate,
        skills: [...plan.sides.candidate.skills, { name: 'repair-guidance', role: 'guidance', contractDigest: null, contentDigest: 'b'.repeat(64) }],
      },
    },
  }
}

describe('a first Skill', () => {
  it('is consumed only when the candidate side was granted it and the log shows the load', () => {
    const plan = firstSkillPlan()
    expect(() =>
      proveSkillLoaded({
        plan,
        receipt: receipt({ skills: [{ runId: 'run-1', bound: [{ name: 'repair-guidance' }], loaded: ['repair-guidance'] }] }),
        where: 'sample "case-a"',
      }),
    ).not.toThrow()
  })

  it('refuses a grant the log never shows being loaded', () => {
    expect(() =>
      proveSkillLoaded({
        plan: firstSkillPlan(),
        receipt: receipt({ skills: [{ runId: 'run-1', bound: [{ name: 'repair-guidance' }], loaded: [] }] }),
        where: 'sample "case-a"',
      }),
    ).toThrow(/no load of it/)
  })

  it('refuses a load outside the run’s grant, and a plan that adds nothing', () => {
    expect(() =>
      proveSkillLoaded({
        plan: firstSkillPlan(),
        receipt: receipt({
          skills: [{ runId: 'run-1', bound: [{ name: 'repair-guidance' }], loaded: ['repair-guidance', 'other'], loadedOutsideGrant: ['other'] }],
        }),
        where: 'sample "case-a"',
      }),
    ).toThrow(/outside its grant/)
    expect(() => proveSkillLoaded({ plan: samplePlan(), receipt: receipt({}), where: 'sample "case-a"' })).toThrow(/adds no skill/)
  })
})

describe('a capability gap', () => {
  it('is proved by the runtime’s own refusal, verbatim', () => {
    const refused = trial({ sampleTaskId: 'case-a', side: 'baseline', outcome: 'not-admitted' })
    const withRefusal = {
      ...refused,
      admission: { source: 'capability-gap' as const, required: ['execute-task'], missing: ['execute-task'], reason: 'the effective capability table does not hold "execute-task"' },
    }
    const proof = proveAdmissionRefusal({ plan: samplePlan(), candidate: withRefusal, where: 'sample "case-a"' })
    expect(proof.proven).toBe(true)
    expect(proof.detail).toMatch(/capability-gap/)
    expect(proof.detail).toMatch(/execute-task/)
  })

  it('refuses a side that ran, a refusal without a reason and a gap without a missing row', () => {
    expect(() => proveAdmissionRefusal({ plan: samplePlan(), candidate: trial({ sampleTaskId: 'case-a', side: 'baseline' }), where: 'w' })).toThrow(
      /not an admission refusal/,
    )
    const refused = trial({ sampleTaskId: 'case-a', side: 'baseline', outcome: 'not-admitted' })
    expect(() => proveAdmissionRefusal({ plan: samplePlan(), candidate: refused, where: 'w' })).toThrow(/carries no refusal/)
    expect(() =>
      proveAdmissionRefusal({
        plan: samplePlan(),
        candidate: { ...refused, admission: { source: 'capability-gap', required: [], missing: [], reason: 'gap' } },
        where: 'w',
      }),
    ).toThrow(/names no missing row/)
    expect(() =>
      proveAdmissionRefusal({
        plan: samplePlan(),
        candidate: { ...refused, admission: { source: 'provider-refused', required: [], missing: [], reason: '  ' } },
        where: 'w',
      }),
    ).toThrow(/no reason text/)
  })
})

describe('a template candidate', () => {
  const consumed = receipt({
    templates: [{ templateRef: { id: 'd0001', version: 2, digest: 'c'.repeat(64) }, observation: 'observed', childTaskIds: ['child-1'] }],
    criteria: ['c1', 'c2'],
  })

  it('is consumed when the runtime observed the instantiation and the parent acceptance is judged', () => {
    const proof = proveTemplateConsumed({ plan: { ...samplePlan(), kind: 'task-template' }, receipt: consumed, parentCriteria: ['c1'], where: 'w' })
    expect(proof.proven).toBe(true)
    expect(proof.detail).toMatch(/template instantiated/)
  })

  it('refuses a template nobody called, an instantiation without children, and a lost parent acceptance', () => {
    expect(() =>
      proveTemplateConsumed({ plan: { ...samplePlan(), kind: 'task-template' }, receipt: receipt({}), parentCriteria: [], where: 'w' }),
    ).toThrow(/consumed no task template/)
    expect(() =>
      proveTemplateConsumed({
        plan: { ...samplePlan(), kind: 'task-template' },
        receipt: receipt({ templates: [{ templateRef: { id: 'd0001', version: 2, digest: 'c'.repeat(64) }, observation: 'not-observed', childTaskIds: [] }] }),
        parentCriteria: [],
        where: 'w',
      }),
    ).toThrow(/no confirmed instantiation/)
    expect(() =>
      proveTemplateConsumed({
        plan: { ...samplePlan(), kind: 'task-template' },
        receipt: receipt({ templates: [{ templateRef: { id: 'd0001', version: 2, digest: 'c'.repeat(64) }, observation: 'observed', childTaskIds: [] }] }),
        parentCriteria: [],
        where: 'w',
      }),
    ).toThrow(/decomposed no child task/)
    expect(() =>
      proveTemplateConsumed({ plan: { ...samplePlan(), kind: 'task-template' }, receipt: consumed, parentCriteria: ['c9'], where: 'w' }),
    ).toThrow(/independent parent acceptance/)
  })
})
