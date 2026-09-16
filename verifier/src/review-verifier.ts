import type { VerificationMode, VerificationResult, Verifier, VerifyRequest } from '@dangosys/dsh-singularity-task'

const REVIEW_MODES: readonly VerificationMode[] = ['review', 'formal']

/** Placeholder for human judgment: never auto-passes. */
export class ReviewVerifier implements Verifier {
  readonly id = 'review'

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
