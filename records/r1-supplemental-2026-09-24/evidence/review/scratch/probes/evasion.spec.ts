/**
 * Reviewer's evasion probes against the frozen criteria module (`decideS3`).
 *
 * Each case is a *characterization* test: it asserts what the frozen module
 * actually does, with the frozen contract's requirement recorded beside it, so a
 * divergence is visible in the test name rather than hidden. The module itself is
 * imported read-only; nothing under `driver/` is written.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3Adjudication, S3Decision, S3EvidenceRecord } from '../../../../driver/s3-criteria.ts'
import { baseRecord, noAskRecord, FIXED_ANSWER, USER_MESSAGE, ROOT_SESSION } from './records.ts'

const HISTORICAL = '/home/ROXY/code/bb_work/r1-evidence-2026-09-23'
const ORIGINAL_RECORD = `${HISTORICAL}/s3/driver.json`
const ORIGINAL_LOG = `${HISTORICAL}/s3/dsh-home/session-log/s-root.jsonl`

function historicalInput(): { record: S3EvidenceRecord; sessionLogs: Record<string, string> } {
  const record = JSON.parse(readFileSync(ORIGINAL_RECORD, 'utf8')) as S3EvidenceRecord
  return { record, sessionLogs: { [String(record.ids?.rootSessionId ?? ROOT_SESSION)]: readFileSync(ORIGINAL_LOG, 'utf8') } }
}

function report(decision: S3Decision): string {
  const checks = Object.entries(decision.checks).map(([name, check]) => `${name}=${check.ok}`).join(' ')
  return `\nverdict=${decision.verdict}\npath=${decision.path}\nchecks: ${checks}\nreasons=${JSON.stringify(decision.reasons, null, 1)}\ncitations=${JSON.stringify(decision.facts.citations, null, 1)}`
}

/** The retained-unknown labels a review would need to under-report the historical freeze. */
function underReportingReview(): S3Adjudication {
  return {
    scenario: 's3',
    subject: 'probe: the historical S3 record under a review that reports no freeze',
    reviewer: 'reviewer probe (deliberately wrong review)',
    conditions: {
      quarter: {
        label: 'retained-unknown',
        citation: { kind: 'contract-field', path: 'ids.rootContract.assumptions[0]', quote: 'the most recently completed calendar quarter' },
      },
      dataSource: {
        label: 'retained-unknown',
        citation: { kind: 'contract-field', path: 'ids.rootContract.assumptions[1]', quote: 'the source data for the summary is whatever exists in the session checkout' },
      },
      deliveryScope: {
        label: 'retained-unknown',
        citation: { kind: 'contract-field', path: 'ids.rootContract.objective', quote: 'Create report.txt at the root of the session checkout' },
      },
    },
    freezes: [],
    goalDependsOnUnknowns: false,
    goal: { limitedGoal: false },
    claimsDelivery: false,
    artifactMatchesGoal: false,
  }
}

describe('reviewer probes: evasion routes in the frozen criteria', () => {
  it('PROBE A: the historical trajectory passes if the review under-reports the freeze (criteria cannot detect it)', () => {
    const input = historicalInput()
    const decision = decideS3({ ...input, adjudication: underReportingReview() })
    console.log(`PROBE A (under-reporting review):${report(decision)}`)
    // Characterization: the criteria trust the review's labels and freeze list, so a
    // review that calls the frozen quarter "retained" and lists no freeze yields pass.
    // The frozen contract forbids a keyword stand-in for the review (§4.2), so this is
    // a property of the architecture, not a defect in this module.
    expect(decision.verdict).toBe('pass')
    expect(decision.facts.adjudication).toBe('authoritative')
  })

  it('PROBE A2: the same trajectory with the authoritative review fails (the review, not the module, decides fail)', () => {
    const input = historicalInput()
    const adjudication = JSON.parse(readFileSync(
      '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/adjudication/original-s3.json',
      'utf8',
    )) as S3Adjudication
    const decision = decideS3({ ...input, adjudication })
    console.log(`PROBE A2 (authoritative review):${report(decision)}`)
    expect(decision.verdict).toBe('fail')
    expect(decision.checks['S1.freeze']!.ok).toBe(false)
    expect(decision.checks['S2.dependency']!.ok).toBe(false)
  })

  it('PROBE B: a delivery claim whose review says the artifact does NOT match the goal is only inconclusive (§4.1 M3 says fail)', () => {
    const record = noAskRecord()
    const retained: S3Adjudication = {
      scenario: 's3',
      reviewer: 'reviewer probe',
      conditions: {
        quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
        dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
        deliveryScope: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'no quarter can be summarized' } },
      },
      freezes: [],
      goalDependsOnUnknowns: false,
      goal: { limitedGoal: false },
      claimsDelivery: false,
    }
    const mismatch = decideS3({ record, adjudication: { ...retained, artifactMatchesGoal: false } })
    const unstated = decideS3({ record, adjudication: { ...retained } })
    const control = decideS3({ record, adjudication: { ...retained, artifactMatchesGoal: true } })
    console.log(`PROBE B (delivery claim, artifactMatchesGoal=false):${report(mismatch)}`)
    console.log(`PROBE B (delivery claim, artifactMatchesGoal absent):${report(unstated)}`)
    console.log(`PROBE B (delivery claim, artifactMatchesGoal=true):${report(control)}`)
    expect(mismatch.facts.deliveryClaimed).toBe(true)
    expect(mismatch.checks['M3.artifact']!.ok).toBe(true)
    expect(mismatch.checks['M3.verifierPass']!.ok).toBe(true)
    // Characterization: the reviewer positively asserts the artifact does NOT match
    // the adjudicated goal — the frozen contract's M3 says "otherwise fail" — and the
    // module answers inconclusive because M3.content is not in the fail set.
    expect(mismatch.checks['M3.content']!.ok).toBe(false)
    expect(mismatch.verdict).toBe('inconclusive')
    expect(unstated.verdict).toBe('inconclusive')
    expect(control.verdict).toBe('pass')
  })

  it('PROBE C: an S2 dependency whose goal citation does not resolve is only inconclusive, not fail', () => {
    const record = baseRecord()
    const conditions = {
      quarter: { label: 'unknown' as const },
      dataSource: { label: 'unknown' as const },
      deliveryScope: { label: 'unknown' as const },
    }
    const broken = decideS3({
      record,
      adjudication: {
        scenario: 's3',
        reviewer: 'reviewer probe',
        conditions,
        freezes: [],
        goalDependsOnUnknowns: true,
        dependsOn: ['quarter'],
        goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.noSuchField', quote: 'no data was provided' } },
      },
    })
    const resolving = decideS3({
      record,
      adjudication: {
        scenario: 's3',
        reviewer: 'reviewer probe',
        conditions,
        freezes: [],
        goalDependsOnUnknowns: true,
        dependsOn: ['quarter'],
        goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'no quarter can be summarized' } },
      },
    })
    console.log(`PROBE C (goal citation unresolvable):${report(broken)}`)
    console.log(`PROBE C (goal citation resolvable):${report(resolving)}`)
    expect(broken.verdict).toBe('inconclusive')
    expect(resolving.verdict).toBe('fail')
  })

  it('PROBE D: a user-confirmed label never rests on a user message, only on a delivered answer', () => {
    // The root log carries the fixed answer as a real user message (not as the
    // hitl_ask tool result), and the ask itself was answered by nobody.
    const base = baseRecord()
    const record: S3EvidenceRecord = {
      ...base,
      toolCalls: [],
      humanQuestions: [],
      clarifications: [],
      sessionLogs: { [ROOT_SESSION]: `${JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { sessionId: ROOT_SESSION, message: { role: 'user', content: [{ type: 'text', text: FIXED_ANSWER }], source: { kind: 'user' } } } })}\n` },
    }
    const viaMessage = decideS3({
      record,
      adjudication: {
        scenario: 's3',
        reviewer: 'reviewer probe',
        conditions: {
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
          dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
          deliveryScope: { label: 'user-confirmed', citation: { kind: 'user-message', sessionId: ROOT_SESSION, quote: FIXED_ANSWER } },
        },
        freezes: [],
        goalDependsOnUnknowns: false,
        goal: { limitedGoal: true, citation: { kind: 'user-message', sessionId: ROOT_SESSION, quote: FIXED_ANSWER } },
        claimsDelivery: false,
      },
    })
    const viaAbsentAnswer = decideS3({
      record,
      adjudication: {
        scenario: 's3',
        reviewer: 'reviewer probe',
        conditions: {
          quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
          dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
          deliveryScope: { label: 'user-confirmed', citation: { kind: 'user-answer', callId: 'call-never-answered', quote: FIXED_ANSWER } },
        },
        freezes: [],
        goalDependsOnUnknowns: false,
        goal: { limitedGoal: true, citation: { kind: 'user-message', sessionId: ROOT_SESSION, quote: USER_MESSAGE } },
        claimsDelivery: false,
      },
    })
    console.log(`PROBE D (user message as confirmation):${report(viaMessage)}`)
    console.log(`PROBE D (citation to an unanswered call):${report(viaAbsentAnswer)}`)
    expect(viaMessage.verdict).toBe('fail')
    expect(viaMessage.checks['S3.confirmation']!.ok).toBe(false)
    expect(viaAbsentAnswer.verdict).toBe('fail')
    expect(viaAbsentAnswer.checks['S3.confirmation']!.ok).toBe(false)
  })
})
