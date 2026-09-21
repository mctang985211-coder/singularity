import type {
  AcceptanceCriterion,
  ChildEvidenceRef,
  TaskId,
  TaskInstance,
  TaskSnapshot,
  VerificationMode,
  VerificationResult,
  Verifier,
  VerifyRequest,
} from '@dangosys/dsh-singularity-task'

/** The slice of the task service the composite verifier reads. */
export interface CompositeTaskSource {
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>
  /**
   * The full store snapshot. The plain conjunction needs only children, but a
   * parent's {@link AcceptanceCriterion.childEvidence} map is judged against
   * child evidence and run states, so the source exposes the snapshot too.
   */
  snapshotIn(storeId: string): Promise<TaskSnapshot>
}

/** How one map entry reads when it is satisfied. */
function describeSatisfied(entry: ChildEvidenceRef, child: TaskInstance): string {
  const who = `child #${entry.childIndex} (${child.taskId})`
  if (entry.criterionId !== undefined) return `${who} criterion "${entry.criterionId}" passed`
  if (entry.evidenceRef !== undefined) return `${who} evidence "${entry.evidenceRef}" present`
  return `${who} verified`
}

/** How one map entry reads when it is missing — the reason names the item verbatim. */
function describeEntry(entry: ChildEvidenceRef): string {
  const parts = [`child #${entry.childIndex}`]
  if (entry.criterionId !== undefined) parts.push(`criterion "${entry.criterionId}"`)
  if (entry.evidenceRef !== undefined) parts.push(`evidence "${entry.evidenceRef}"`)
  return parts.join(' ')
}

/**
 * The defect one map entry carries against the store, or `undefined` when the
 * entry is satisfied. Every branch is a store fact: the child exists in the
 * batch, sits in the verified terminal state, and — for the narrowed spellings
 * — the child's *verified run* evidence carries the passing verdict and the
 * named reference. Evidence an earlier failed run produced is an expired
 * reference and never satisfies an entry.
 */
function entryDefect(
  entry: ChildEvidenceRef,
  children: readonly TaskInstance[],
  snapshot: TaskSnapshot,
): string | undefined {
  const child = children[entry.childIndex]
  if (child === undefined) {
    return `child #${entry.childIndex} does not exist (the decomposition batch has ${children.length} children)`
  }
  if (child.status !== 'verified') {
    return `child #${entry.childIndex} (${child.taskId}) is ${child.status}, not verified`
  }
  const verifiedRun = snapshot.runs.find(run => run.taskId === child.taskId && run.status === 'verified')
  const bundles = snapshot.evidence.filter(item => item.taskRunId === verifiedRun?.runId)
  if (entry.criterionId !== undefined) {
    const criterion = child.acceptanceCriteria.find(item => item.criterionId === entry.criterionId)
    if (criterion === undefined) {
      return `child #${entry.childIndex} (${child.taskId}) has no criterion "${entry.criterionId}"`
    }
    if (criterion.heuristic === true) {
      return `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" is heuristic, not deterministic evidence`
    }
    const verdict = bundles.flatMap(item => item.verifierResults).find(item => item.criterionId === entry.criterionId)
    if (verdict?.status !== 'pass') {
      return `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" has no passing verdict in its verified run's evidence` +
        (verdict === undefined ? '' : ` (verdict ${verdict.status})`)
    }
  }
  if (entry.evidenceRef !== undefined) {
    // The three spellings a contract can name a product by, taken from the
    // verified run's own evidence.
    const refs = new Set(bundles.flatMap(item => [
      item.evidenceId,
      ...item.artifacts.flatMap(artifact => [artifact.kind, artifact.artifactId]),
    ]))
    if (!refs.has(entry.evidenceRef)) {
      return `child #${entry.childIndex} (${child.taskId}) evidence does not contain "${entry.evidenceRef}" (evidence id, artifact kind, or artifact id)`
    }
  }
  return undefined
}

/**
 * Judges a composite criterion. The default is the child-status conjunction
 * (pass iff the task has at least one child and every child is verified),
 * unchanged for criteria that declare nothing.
 *
 * A criterion carrying a {@link AcceptanceCriterion.childEvidence} map is
 * judged by the map as well: every entry must resolve against the store, and an
 * incomplete mapping fails the criterion with the missing items named — the
 * conjunction alone can never pass a parent whose root goal rests on evidence
 * the children did not produce (KISS §6 C2). A criterion labeled
 * {@link AcceptanceCriterion.heuristic} keeps the conjunction verdict but
 * carries the explicit heuristic label in its details, so a natural-language
 * coverage signal is never mistaken for a mechanical proof (KISS §5.1).
 *
 * Reading children and evidence needs the store id, which VerifyRequest does
 * not carry, so the registry dispatches through {@link verifyIn}; the plain
 * `verify` stays inconclusive.
 */
export class CompositeVerifier implements Verifier {
  readonly id = 'composite'
  readonly version = '1'
  readonly owner = 'singularity'
  /**
   * The distinguishing samples need a task store (the verdict reads child
   * status), so they live in this package's tests:
   * `tests/unit/composite-verifier.spec.ts` runs both.
   */
  readonly selftest = {
    positiveCases: ['a task whose children are all verified (composite-verifier.spec.ts)'],
    negativeCases: ['a task with an unverified child (composite-verifier.spec.ts)'],
  }

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
    const results: VerificationResult[] = []
    for (const criterion of req.criteria) {
      results.push(await this.judge(storeId, criterion, children))
    }
    return results
  }

  private async judge(storeId: string, criterion: AcceptanceCriterion, children: readonly TaskInstance[]): Promise<VerificationResult> {
    const map = criterion.childEvidence ?? []
    const base = { criterionId: criterion.criterionId, verifierId: this.id }

    if (children.length === 0) {
      if (map.length === 0) {
        return { ...base, status: 'inconclusive', details: 'no child tasks' }
      }
      // A declared map with no children to satisfy it is incomplete, not absent:
      // refusing here is what keeps the declaration from silently degrading.
      return {
        ...base,
        status: 'fail',
        details: `incomplete childEvidence map: the task has no child tasks to satisfy ${map.map(describeEntry).join('; ')}`,
      }
    }

    const unverified = children.filter(child => child.status !== 'verified')
    if (unverified.length > 0) {
      return {
        ...base,
        status: 'fail',
        details: `unverified children: ${unverified.map(child => `${child.taskId}(${child.status})`).join(', ')}`,
      }
    }

    if (map.length === 0) {
      // The conjunction verdict, unchanged. A criterion labeled heuristic keeps
      // it but carries the label: the reader is told this is a coverage signal,
      // and the orchestrator does not count it as a deterministic pass.
      return {
        ...base,
        status: 'pass',
        ...(criterion.heuristic === true
          ? { details: 'heuristic conjunction: every child verified — explicitly labeled heuristic (KISS §5.1); a conjunction is a coverage signal, not a deterministic proof of the parent goal, and is not counted as one' }
          : {}),
      }
    }

    const snapshot = await this.task.snapshotIn(storeId)
    const defects = map
      .map(entry => entryDefect(entry, children, snapshot))
      .filter((defect): defect is string => defect !== undefined)
    if (defects.length > 0) {
      return { ...base, status: 'fail', details: `incomplete childEvidence map: ${defects.join('; ')}` }
    }
    return {
      ...base,
      status: 'pass',
      details: `childEvidence satisfied: ${map.map(entry => describeSatisfied(entry, children[entry.childIndex]!)).join('; ')}`,
    }
  }
}
