/**
 * The v5 ledger: one record set, one four-state machine. A draft is drafted,
 * evaluated, then discarded or published — and nothing else exists. The v4
 * symbols this protocol replaced (a hand-filled version set, six text gate
 * answers, an always-true mechanical flag, a derivable champion) are refused by
 * name, not folded.
 */

import { describe, expect, it } from 'vitest'
import { foldMethods } from '../../src/ledger/fold.ts'
import { validateDraftRecord } from '../../src/ledger/records.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import { digestOf } from '../../src/shared.ts'
import { draft, samplePlan, trial } from './method-fixtures.ts'

const AT = '2026-10-08T00:00:00.000Z'

function draftRecord(overrides: Partial<Extract<EvolutionRecordV5, { kind: 'draft' }>> = {}): EvolutionRecordV5 {
  const method = draft()
  return {
    formatVersion: 5,
    kind: 'draft',
    draftId: method.draftId,
    libraryId: method.baseRevision.libraryId,
    assetKind: method.kind,
    identity: method.identity,
    baseRevision: method.baseRevision,
    candidateRevision: method.candidateRevision,
    rationale: method.rationale,
    sourceRefs: [...method.sourceRefs],
    actor: method.actor,
    at: method.at,
    ...overrides,
  }
}

function planRecord(plan = samplePlan()): EvolutionRecordV5 {
  return {
    formatVersion: 5,
    kind: 'plan',
    draftId: plan.draftId,
    evaluationId: 'e-1',
    plan,
    planDigest: digestOf(plan),
    report: `reports/${plan.draftId}.json`,
    actor: 'supervisor',
    at: AT,
  }
}

function trialRecord(evaluationId = 'e-1'): EvolutionRecordV5 {
  return { formatVersion: 5, kind: 'trial', draftId: 'd0001', evaluationId, trial: trial({ sampleTaskId: 'case-a', side: 'baseline' }) }
}

function evaluationRecord(): EvolutionRecordV5 {
  return {
    formatVersion: 5,
    kind: 'evaluation',
    draftId: 'd0001',
    evaluationId: 'e-1',
    report: 'reports/d0001.json',
    reportDigest: digestOf({ report: 1 }),
    verdict: 'fixed',
    scoreDigest: digestOf({ score: 1 }),
    actor: 'supervisor',
    at: AT,
  }
}

function publishedRecord(): EvolutionRecordV5 {
  return {
    formatVersion: 5,
    kind: 'published',
    draftId: 'd0001',
    revisionId: 'c-d0001',
    supersededRevisionId: 'r0001',
    intentId: `lib-1/g2/c-d0001`,
    approvalRef: 'approval:1',
    actor: 'supervisor',
    at: AT,
  }
}

describe('the v5 record schema', () => {
  it('accepts a draft, a plan, a trial, an evaluation, a discard and a publish', () => {
    for (const record of [
      draftRecord(),
      planRecord(),
      trialRecord(),
      evaluationRecord(),
      { formatVersion: 5, kind: 'discard', draftId: 'd0001', reason: 'superseded', actor: 'supervisor', at: AT },
      publishedRecord(),
      {
        formatVersion: 5,
        kind: 'rolledback',
        draftId: 'd0001',
        revisionId: 'r0001',
        supersededRevisionId: 'c-d0001',
        intentId: 'lib-1/g3/r0001',
        actor: 'supervisor',
        at: AT,
      },
    ]) {
      expect(() => validateDraftRecord(record)).not.toThrow()
    }
  })

  it('refuses a v4 line, a version set and the six gate answers by name', () => {
    const v4 = { formatVersion: 4, kind: 'proposed', proposalId: 'p1', targetType: 'skill', targetId: 'x', baseVersion: 'v0', level: 'L2', rationale: 'r', sourceRefs: ['d'], actor: 'a', at: AT }
    expect(() => validateDraftRecord(v4)).toThrow(/formatVersion 4/)
    expect(() => validateDraftRecord({ ...draftRecord(), versionSet: { skill: 'v2' } })).toThrow()
    expect(() =>
      validateDraftRecord({ formatVersion: 5, kind: 'gated', draftId: 'd0001', gate: { targetFailureFixed: 'yes' }, actor: 'a', at: AT }),
    ).toThrow(/unknown ledger record kind/)
  })

  it('refuses a draft whose candidate is its own base revision', () => {
    const method = draft()
    expect(() =>
      validateDraftRecord(
        draftRecord({ candidateRevision: { ...method.candidateRevision, revisionId: method.baseRevision.revisionId } }),
      ),
    ).toThrow(/does not exist yet/)
  })

  it('refuses a plan that freezes another draft than the line names', () => {
    expect(() => validateDraftRecord({ ...planRecord(), draftId: 'd0009' })).toThrow(/plan of draft/)
  })

  it('refuses an interrupted trial without a reason', () => {
    const interrupted = trial({ sampleTaskId: 'case-a', side: 'baseline', outcome: 'interrupted' })
    expect(() => validateDraftRecord({ formatVersion: 5, kind: 'trial', draftId: 'd0001', evaluationId: 'e-1', trial: interrupted })).toThrow(/interrupted/)
  })

  it('refuses a published line without the revision it installed', () => {
    const { revisionId: _dropped, ...rest } = publishedRecord() as Extract<EvolutionRecordV5, { kind: 'published' }>
    expect(() => validateDraftRecord(rest)).toThrow(/published record revisionId/)
  })
})

describe('the four-state fold', () => {
  it('moves draft → evaluated → published and records the revision each step named', () => {
    const views = foldMethods([draftRecord(), planRecord(), trialRecord(), evaluationRecord(), publishedRecord()])
    const view = views.get('d0001')!
    expect(view.status).toBe('published')
    expect(view.plan?.planId).toBe(samplePlan().planId)
    expect(view.trials).toHaveLength(1)
    expect(view.evaluation).toMatchObject({ evaluationId: 'e-1', verdict: 'fixed' })
    expect(view.published).toMatchObject({ revisionId: 'c-d0001', supersededRevisionId: 'r0001' })
    expect(view.history.map(entry => entry.kind)).toEqual(['draft', 'plan', 'trial', 'evaluation', 'published'])
  })

  it('moves draft → discarded and refuses anything after the discard', () => {
    const views = foldMethods([
      draftRecord(),
      { formatVersion: 5, kind: 'discard', draftId: 'd0001', reason: 'no evidence', actor: 'supervisor', at: AT },
    ])
    expect(views.get('d0001')!.status).toBe('discarded')
    expect(() =>
      foldMethods([
        draftRecord(),
        { formatVersion: 5, kind: 'discard', draftId: 'd0001', reason: 'no evidence', actor: 'supervisor', at: AT },
        planRecord(),
      ]),
    ).toThrow(/discarded/)
  })

  it('refuses a second plan, a duplicate trial side and an evaluation without a plan', () => {
    expect(() => foldMethods([draftRecord(), planRecord(), planRecord()])).toThrow(/one draft is one frozen plan/)
    expect(() => foldMethods([draftRecord(), planRecord(), trialRecord(), trialRecord()])).toThrow(/settles once/)
    expect(() => foldMethods([draftRecord(), evaluationRecord()])).toThrow(/precedes its plan/)
  })

  it('refuses a publish of a draft that was never evaluated', () => {
    expect(() => foldMethods([draftRecord(), planRecord(), publishedRecord()])).toThrow(/requires an evaluated draft/)
  })

  it('refuses a rollback of a draft that was never published', () => {
    expect(() =>
      foldMethods([
        draftRecord(),
        {
          formatVersion: 5,
          kind: 'rolledback',
          draftId: 'd0001',
          revisionId: 'r0001',
          supersededRevisionId: 'c-d0001',
          intentId: 'lib-1/g3/r0001',
          actor: 'supervisor',
          at: AT,
        },
      ]),
    ).toThrow(/requires a published draft/)
  })

  it('accepts a library-level rollback that names no draft', () => {
    const views = foldMethods([
      {
        formatVersion: 5,
        kind: 'rolledback',
        draftId: null,
        revisionId: 'r0001',
        supersededRevisionId: 'c-d0001',
        intentId: 'lib-1/g3/r0001',
        actor: 'supervisor',
        at: AT,
      },
    ])
    expect(views.size).toBe(0)
  })

  it('refuses a record that names an unknown draft', () => {
    expect(() => foldMethods([planRecord()])).toThrow(/unknown draft "d0001"/)
    expect(() => foldMethods([draftRecord(), draftRecord()])).toThrow(/already exists/)
  })
})
