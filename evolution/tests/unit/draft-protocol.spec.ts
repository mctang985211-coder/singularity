/**
 * The draft protocol: one immutable draft, one four-state machine, and a discard
 * that closes a draft without touching any revision. The fields the old protocol
 * hand-filled are not merely ignored — a line that carries them is refused.
 */

import { describe, expect, it } from 'vitest'
import { createDraft, discardDraft, draftView, draftViews } from '../../src/draft/draft.ts'
import type { MethodLedger } from '../../src/draft/draft.ts'
import { validateDraftRecord } from '../../src/ledger/records.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import { digestOf } from '../../src/shared.ts'
import { LIBRARY, draft, samplePlan } from './method-fixtures.ts'

function ledgerHarness(): MethodLedger & { appended: EvolutionRecordV5[] } {
  const appended: EvolutionRecordV5[] = []
  return {
    appended,
    libraryId: LIBRARY,
    records: () => appended,
    append: async (record: EvolutionRecordV5) => {
      validateDraftRecord(record)
      appended.push(record)
    },
  }
}

const request = {
  draftId: 'd0001',
  kind: 'skill' as const,
  identity: 'task-coordination',
  baseRevision: draft().baseRevision,
  candidateRevision: draft().candidateRevision,
  rationale: 'the failure points at the guidance',
  sourceRefs: ['diagnosis:d1'],
  actor: 'supervisor',
}

describe('creating a draft', () => {
  it('records one v5 draft line and folds it back', async () => {
    const ledger = ledgerHarness()
    const view = await createDraft(ledger, request)
    expect(view.status).toBe('draft')
    expect(view.draft).toMatchObject({ draftId: 'd0001', kind: 'skill', identity: 'task-coordination' })
    expect(ledger.appended[0]).toMatchObject({ formatVersion: 5, kind: 'draft', libraryId: LIBRARY })
  })

  it('refuses a second draft under the same id', async () => {
    const ledger = ledgerHarness()
    await createDraft(ledger, request)
    await expect(createDraft(ledger, request)).rejects.toThrow(/already exists/)
  })

  it('refuses a candidate that names no revision', async () => {
    const ledger = ledgerHarness()
    await expect(
      createDraft(ledger, { ...request, candidateRevision: { ...request.candidateRevision, revisionId: '' } }),
    ).rejects.toThrow(/candidateRevision.revisionId/)
  })
})

describe('discarding a draft', () => {
  it('closes an open draft with its reason and takes no further record', async () => {
    const ledger = ledgerHarness()
    await createDraft(ledger, request)
    const view = await discardDraft(ledger, { draftId: 'd0001', reason: 'the diagnosis was wrong', actor: 'supervisor' })
    expect(view.status).toBe('discarded')
    expect(view.discardReason).toBe('the diagnosis was wrong')
    await expect(discardDraft(ledger, { draftId: 'd0001', reason: 'again', actor: 'supervisor' })).rejects.toThrow(/already discarded/)
  })

  it('refuses to discard a published draft', async () => {
    const ledger = ledgerHarness()
    await createDraft(ledger, request)
    const plan = samplePlan()
    await ledger.append({ formatVersion: 5, kind: 'plan', draftId: 'd0001', evaluationId: 'e-1', plan, planDigest: digestOf(plan), report: 'reports/d0001.json', actor: 'supervisor', at: '2026-10-08T00:00:00.000Z' })
    await ledger.append({
      formatVersion: 5,
      kind: 'evaluation',
      draftId: 'd0001',
      evaluationId: 'e-1',
      report: 'reports/d0001.json',
      reportDigest: digestOf({ report: 1 }),
      verdict: 'fixed',
      scoreDigest: digestOf({ score: 1 }),
      actor: 'supervisor',
      at: '2026-10-08T00:00:00.000Z',
    })
    await ledger.append({
      formatVersion: 5,
      kind: 'published',
      draftId: 'd0001',
      revisionId: 'c-d0001',
      supersededRevisionId: 'r0001',
      intentId: `${LIBRARY}/g2/c-d0001`,
      actor: 'supervisor',
      at: '2026-10-08T00:00:00.000Z',
    })
    await expect(discardDraft(ledger, { draftId: 'd0001', reason: 'late', actor: 'supervisor' })).rejects.toThrow(/published/)
  })
})

describe('listing drafts', () => {
  it('filters by status and kind, newest first', async () => {
    const ledger = ledgerHarness()
    await createDraft(ledger, request)
    await createDraft(ledger, { ...request, draftId: 'd0002', kind: 'capability' })
    await discardDraft(ledger, { draftId: 'd0002', reason: 'no evidence', actor: 'supervisor' })
    expect(draftViews(ledger).map(view => view.draft.draftId)).toEqual(['d0002', 'd0001'])
    expect(draftViews(ledger, { status: 'draft' }).map(view => view.draft.draftId)).toEqual(['d0001'])
    expect(draftViews(ledger, { kind: 'capability' }).map(view => view.draft.draftId)).toEqual(['d0002'])
    expect(draftView(ledger, 'd0001').status).toBe('draft')
    expect(() => draftView(ledger, 'd0009')).toThrow(/unknown draft/)
  })
})
