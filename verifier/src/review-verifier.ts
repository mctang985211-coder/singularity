import type { VerificationMode, VerificationResult } from '@dangosys/dsh-singularity-task'
import { sampleCriterion, type Verifier, type VerifierSelftest, type VerifyRequest } from './types.ts'

const REVIEW_MODES: readonly VerificationMode[] = ['review', 'formal']

/** Placeholder for human judgment: never auto-passes, and its samples prove exactly that on both sides (KISS §4.3). */
export class ReviewVerifier implements Verifier {
  readonly id = 'review'
  readonly version = '1'
  readonly selftest: VerifierSelftest = {
    samples: [
      {
        role: 'positive',
        name: 'a known-good review criterion is never auto-passed',
        criterion: sampleCriterion({ criterionId: 'selftest-review-known-good', verificationMode: 'review' }),
        expect: 'not-pass',
      },
      {
        role: 'negative',
        name: 'a known-bad formal criterion is not judged pass',
        criterion: sampleCriterion({ criterionId: 'selftest-formal-known-bad', verificationMode: 'formal' }),
        expect: 'not-pass',
      },
    ],
  }

  supports(mode: VerificationMode): boolean {
    return REVIEW_MODES.includes(mode)
  }

  async verify(req: VerifyRequest): Promise<VerificationResult[]> {
    return req.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: 'inconclusive' as const,
      verifierId: this.id,
      details: 'manual review required',
    }))
  }
}
