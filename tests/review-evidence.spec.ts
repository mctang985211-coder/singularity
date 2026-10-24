import { expect, it } from 'vitest'
import { readFindings } from '../src/review/protocol.ts'

it('preserves native event citations separately from semantic subject references', () => {
  const finding = {
    criterionId: 'correct',
    verdict: 'unknown',
    detail: 'The event leaves an unresolved claim.',
    evidence: [
      'subject.json:contract',
      { sessionId: 'sealed-session', eventSeq: 7, rootId: 'root', from: 32, count: 64 },
    ],
  }
  expect(readFindings([finding])).toEqual([finding])
})

it.each([
  { sessionId: 'session', from: 0, count: 64 },
  { sessionId: 'session', eventSeq: -1 },
  { sessionId: 'session', eventSeq: 0, count: 8193 },
  { sessionId: 'session', eventSeq: 0, subjectDigest: 'model-authored-binding' },
])('refuses an invalid or widened native citation: %j', reference => {
  expect(() =>
    readFindings([{ criterionId: 'correct', verdict: 'pass', detail: 'Claim', evidence: [reference] }]),
  ).toThrow()
})
