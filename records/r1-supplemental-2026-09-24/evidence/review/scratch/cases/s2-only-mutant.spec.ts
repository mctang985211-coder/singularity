/**
 * The same S2-only case against the `no-s2` mutant (a copy of the module with
 * only the S2 rejection removed). Expected here: the rejection disappears and
 * the verdict degrades to inconclusive — the contrast with the pristine run in
 * `s2-only.spec.ts` is what shows the S2 rule decides the verdict.
 */

import { describe, expect, it } from 'vitest'
import { decideS3 } from '../mutants/no-s2/s3-criteria.ts'
import type { S3Adjudication } from '../mutants/no-s2/s3-criteria.ts'
import { baseRecord, CALL_ID, FIXED_ANSWER } from '../probes/records.ts'

describe('reviewer S2-only case (no-s2 mutant)', () => {
  it('no longer rejects and degrades to inconclusive', () => {
    const adjudication: S3Adjudication = {
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
    const decision = decideS3({ record: baseRecord(), adjudication })
    console.log(`s2-only (no-s2 mutant): verdict=${decision.verdict} path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`)
    expect(decision.checks['S2.dependency']!.ok).toBe(true)
    expect(decision.verdict).toBe('inconclusive')
  })
})
