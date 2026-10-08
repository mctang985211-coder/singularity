/**
 * The completion guard: what the current runtime reads as a completion, and
 * every legacy text shape it refuses to derive one from.
 */

import { describe, expect, test } from 'vitest'
import { LegacyCompletionError, readCompletion } from '../../src/index.ts'

/** One structured completion, the only shape the current runtime reads. */
const STRUCTURED = {
  businessAction: 'continue',
  searchNext: 'explore',
  methodDecision: 'retain',
  reason: 'the round produced no reusable change',
  evidenceRefs: ['e-1'],
  at: '2026-10-08T00:00:00.000Z',
}

/** The refusal one row must raise, with the legacy-format code on it. */
function expectLegacy(row: unknown): string {
  let raised: unknown
  try {
    readCompletion(row)
  } catch (error) {
    raised = error
  }
  expect(raised).toBeInstanceOf(LegacyCompletionError)
  const error = raised as LegacyCompletionError
  expect(error.code).toBe('legacy-completion-format')
  return error.message
}

describe('a structured completion', () => {
  test('is read field for field, with its place in the round', () => {
    expect(readCompletion(STRUCTURED)).toEqual(STRUCTURED)
  })

  test('carries its trial candidate and its approval source when it has them', () => {
    expect(
      readCompletion({
        ...STRUCTURED,
        methodDecision: 'promote',
        trialCandidateRef: 'c-1',
        approval: { kind: 'human', actor: 's-user' },
      }),
    ).toMatchObject({
      methodDecision: 'promote',
      trialCandidateRef: 'c-1',
      approval: { kind: 'human', actor: 's-user' },
    })
    expect(readCompletion({ ...STRUCTURED, approval: { kind: 'platform_policy', policy: 'humanReview:false' } })).toMatchObject({
      approval: { kind: 'platform_policy', policy: 'humanReview:false' },
    })
  })
})

describe('the legacy text formats are not a completion', () => {
  test('a fenced JSON outcome block is refused, in the note or on its own', () => {
    const fenced = 'round done\n```json\n{"outcome":"no_change","reason":"nothing new"}\n```'
    expect(expectLegacy(fenced)).toContain('fenced JSON outcome block')
    expect(expectLegacy({ note: fenced })).toContain('fenced JSON outcome block')
    expect(expectLegacy({ text: fenced })).toContain('fenced JSON outcome block')
  })

  test('a blocked or no_change note is refused', () => {
    expect(expectLegacy('blocked: the workspace cannot be built')).toContain('"blocked:" note prefix')
    expect(expectLegacy('no_change: the current methods are retained')).toContain('"no_change:" note prefix')
    expect(expectLegacy({ note: 'no_change: the current methods are retained' })).toContain('"no_change:" note prefix')
  })

  test('prose of any other kind is refused too: a note is never a completion', () => {
    expect(expectLegacy('the round ended and the candidate looks promising')).toContain('structured record')
    expect(expectLegacy({ note: 'the round ended well' })).toContain('prose')
  })

  test('a row that is not a record at all is refused, and nothing is derived from it', () => {
    expect(expectLegacy(undefined)).toContain('structured record')
    expect(expectLegacy(null)).toContain('structured record')
    expect(expectLegacy(42)).toContain('structured record')
    expect(expectLegacy(['continue'])).toContain('structured record')
  })
})

describe('a malformed structured row is refused, never completed', () => {
  test('one vocabulary field outside its values names that field', () => {
    expect(expectLegacy({ ...STRUCTURED, businessAction: 'promote' })).toContain('businessAction')
    expect(expectLegacy({ ...STRUCTURED, searchNext: 'continue' })).toContain('searchNext')
    expect(expectLegacy({ ...STRUCTURED, methodDecision: 'continue' })).toContain('methodDecision')
  })

  test('a missing field, an empty reason and a malformed evidence list are refused', () => {
    expect(expectLegacy({ ...STRUCTURED, businessAction: undefined })).toContain('businessAction')
    expect(expectLegacy({ ...STRUCTURED, reason: '   ' })).toContain('reason')
    expect(expectLegacy({ ...STRUCTURED, at: undefined })).toContain('at')
    expect(expectLegacy({ ...STRUCTURED, evidenceRefs: 'e-1' })).toContain('evidenceRefs')
    expect(expectLegacy({ ...STRUCTURED, evidenceRefs: [1] })).toContain('evidenceRefs')
    expect(expectLegacy({ ...STRUCTURED, trialCandidateRef: 7 })).toContain('trialCandidateRef')
    expect(expectLegacy({ ...STRUCTURED, approval: { kind: 'model' } })).toContain('approval')
  })
})
