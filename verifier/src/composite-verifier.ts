import type {
  TaskId,
  TaskInstance,
  VerificationMode,
  VerificationResult,
  Verifier,
  VerifyRequest,
} from '@dangosys/dsh-singularity-task'

/** The slice of the task service the composite verifier reads. */
export interface CompositeTaskSource {
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>
}

/**
 * Judges a composite criterion by child task status: pass iff the task has at
 * least one child and every child is verified. Reading children needs the
 * store id, which VerifyRequest does not carry, so the registry dispatches
 * through {@link verifyIn}; the plain `verify` stays inconclusive.
 */
export class CompositeVerifier implements Verifier {
  readonly id = 'composite'

  constructor(private readonly task: CompositeTaskSource) {}

  supports(mode: VerificationMode): boolean {
    return mode === 'composite'
  }

  async verify(req: VerifyRequest): Promise<VerificationResult[]> {
    return req.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: 'inconclusive' as const,
      verifierId: this.id,
      details: 'composite verification requires store context',
    }))
  }

  async verifyIn(storeId: string, req: VerifyRequest): Promise<VerificationResult[]> {
    const children = await this.task.childrenIn(storeId, req.taskId)
    let status: VerificationResult['status']
    let details: string | undefined
    if (children.length === 0) {
      status = 'inconclusive'
      details = 'no child tasks'
    } else {
      const unverified = children.filter(child => child.status !== 'verified')
      if (unverified.length === 0) {
        status = 'pass'
      } else {
        status = 'fail'
        details = `unverified children: ${unverified.map(child => `${child.taskId}(${child.status})`).join(', ')}`
      }
    }
    return req.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status,
      verifierId: this.id,
      details,
    }))
  }
}
