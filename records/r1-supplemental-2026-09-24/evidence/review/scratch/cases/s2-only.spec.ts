/**
 * Reviewer's S2-only case: a trajectory whose only rejection ground is the
 * goal-dependency rule (no freeze claim at all, every condition resolved).
 *
 * The frozen suite's own "goal depends on the unknown" case cannot show whether
 * the S2 rule is load-bearing, because its record also freezes the same values
 * and S1 fires there too. This case isolates S2. The companion file
 * `s2-only-mutant.spec.ts` runs the same case against the `no-s2` mutant.
 */

import { describe, expect, it } from 'vitest'
import { decideS3 } from '../../../../driver/s3-criteria.ts'
import type { S3Adjudication } from '../../../../driver/s3-criteria.ts'
import { baseRecord, CALL_ID, FIXED_ANSWER } from '../probes/records.ts'

export function s2OnlyAdjudication(): S3Adjudication {
  return {
    scenario: 's3',
    reviewer: 'reviewer scratch case',
    conditions: {
      quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
      dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
      deliveryScope: { label: 'user-confirmed', citation: { kind: 'user-answer', callId: CALL_ID, quote: FIXED_ANSWER } },
    },
    freezes: [],
    goalDependsOnUnknowns: true,
    dependsOn: ['quarter'],
    goal: { limitedGoal: false, citation: { kind: 'contract-field', path: 'rootContract.objective', quote: 'no quarter can be summarized' } },
    claimsDelivery: false,
    artifactMatchesGoal: true,
  }
}

describe('reviewer S2-only case (pristine module)', () => {
  it('rejects a goal that depends on a retained unknown, with no freeze claimed', () => {
    const decision = decideS3({ record: baseRecord(), adjudication: s2OnlyAdjudication() })
    console.log(`s2-only (pristine): verdict=${decision.verdict} path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`)
    expect(decision.checks['S1.freeze']!.ok).toBe(true)
    expect(decision.checks['S2.dependency']!.ok).toBe(false)
    expect(decision.checks['resolution.conditions']!.ok).toBe(true)
    expect(decision.verdict).toBe('fail')
  })
})
