import type { AcceptanceCriterion, VerificationMode, VerificationResult } from '@dangosys/dsh-singularity-task'
import type { Verifier, VerifierSelftest, VerifyRequest } from './types.ts'

const REVIEW_MODES: readonly VerificationMode[] = ['review', 'formal']

/** The criterion a selftest sample hands this verifier: a review criterion carries no command, so only its identity and mode matter. */
function sampleCriterion(criterionId: string, verificationMode: VerificationMode): AcceptanceCriterion {
  return {
    criterionId,
    description: 'a selftest sample',
    verificationMode,
    requiredEvidence: [],
    mandatory: true,
  }
}

/**
 * Placeholder for human judgment: never auto-passes.
 *
 * Its selftest takes the equivalent form KISS §4.3 allows a judge that judges
 * nothing: a known-good sample must be demonstrably *not* auto-passed, and a
 * known-bad sample must not be judged `pass` either. Both are executed by the
 * registry before it will register this verifier.
 *
 * What that proves: the judge returns a not-pass verdict instead of silently
 * accepting, on both a criterion that ought to be verifiable by a human and one
 * that ought not to pass. What it does not prove: anything about products —
 * this verifier does not judge products at all, and no sample can make its
 * verdict meaningful. What closes a review criterion is the human review it
 * defers to, outside this verifier.
 */
export class ReviewVerifier implements Verifier {
  readonly id = 'review'
  readonly version = '1'
  readonly owner = 'singularity'
  readonly selftest: VerifierSelftest = {
    samples: [
      {
        role: 'positive',
        name: 'a known-good review criterion is never auto-passed',
        criterion: sampleCriterion('selftest-review-known-good', 'review'),
        expect: 'not-pass',
      },
      {
        role: 'negative',
        name: 'a known-bad formal criterion is not judged pass',
        criterion: sampleCriterion('selftest-formal-known-bad', 'formal'),
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
