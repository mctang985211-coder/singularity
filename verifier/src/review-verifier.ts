import type { VerificationMode, VerificationResult, Verifier, VerifyRequest } from '@dangosys/dsh-singularity-task'

const REVIEW_MODES: readonly VerificationMode[] = ['review', 'formal']

/** Placeholder for human judgment: never auto-passes. */
export class ReviewVerifier implements Verifier {
  readonly id = 'review'
  readonly version = '1'
  readonly owner = 'singularity'
  /**
   * This verifier judges nothing by design — a human does — so the one
   * distinction its selftest can prove is the negative one: a known-good
   * sample still comes back inconclusive, never an auto-pass. The package
   * tests execute exactly that sample.
   */
  readonly selftest = {
    positiveCases: ['a known-good review criterion still returns inconclusive (never auto-pass)'],
    negativeCases: [],
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
