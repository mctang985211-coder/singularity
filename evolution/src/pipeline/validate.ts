/**
 * The one validator. It runs inside an evaluation (steps 3–4 of the pipeline)
 * and again before a publish, from the same function: isolation, identity, the
 * original acceptance, the candidate's real consumption, the domain guards and
 * the cost ceiling. The verdicts are recomputed here from the receipts, never
 * read off the report.
 */

import type { ExecutionReceipt } from '@dangosys/dsh-singularity-task'
import { adapterFor } from '../draft/adapters.ts'
import { assertReceiptMatchesSide, assertSidesIsolated, requireEstablished } from '../evidence/receipt.ts'
import { assertOutcomeEvidence } from '../evidence/judge.ts'
import { costRefusal } from './guards.ts'
import { assertEvaluationReport } from './report.ts'
import type { EvaluationSources } from './sources.ts'
import type { EvaluationReport, EvaluationVerdict, GuardOutcome, TrialComparison, TrialResult, TrialSampleVerdict } from '../types.ts'

/** One validation call: the report under test, the sources it is re-read from, and which door called it. */
export interface ValidateInput {
  readonly report: EvaluationReport
  readonly sources: EvaluationSources
  /** `pre-publish` additionally requires the baseline revision to still be the active one. */
  readonly mode: 'evaluate' | 'pre-publish'
}

/** What one validation settled as. */
export interface ValidationOutcome {
  readonly trials: readonly TrialComparison[]
  readonly guards: readonly GuardOutcome[]
  readonly verdict: EvaluationVerdict
}

/** One criterion's verdicts on one side, as the frozen verifier decided them. */
function assertFrozenJudges(report: EvaluationReport, comparison: TrialComparison, refusal: (detail: string) => never): void {
  for (const side of ['baseline', 'candidate'] as const) {
    const trial = comparison[side]
    // A side the runtime refused at admission ran nothing: its refusal is the
    // fact, and there are no verdicts for it to be judged by.
    if (trial.outcome === 'not-admitted') continue
    for (const criterion of report.plan.sides[side].acceptance) {
      const judged = trial.receipt.criteria.find(item => item.criterionId === criterion.criterionId)
      if (judged === undefined) {
        refusal(`the ${side} side of sample "${comparison.sampleTaskId}" judges no verdict for criterion "${criterion.criterionId}"`)
      }
      if (judged.verifierId !== undefined && judged.verifierId !== criterion.verifierRef) {
        refusal(
          `criterion "${criterion.criterionId}" of sample "${comparison.sampleTaskId}" was decided by verifier "${judged.verifierId}", not the ` +
            `frozen "${criterion.verifierRef}"`,
        )
      }
      if (judged.verifierVersion !== undefined && judged.verifierVersion !== criterion.verifierVersion) {
        refusal(
          `criterion "${criterion.criterionId}" of sample "${comparison.sampleTaskId}" was decided by verifier version ` +
            `"${judged.verifierVersion}", not the frozen "${criterion.verifierVersion}"`,
        )
      }
    }
  }
}

/** One sample's mechanical verdict, from the two sides' settled outcomes. */
export function sampleVerdict(comparison: TrialComparison): TrialSampleVerdict {
  const { baseline, candidate, role } = comparison
  const unsettled = (trial: TrialResult): boolean => trial.outcome === 'interrupted' || trial.outcome === 'cancelled'
  if (unsettled(baseline) || unsettled(candidate)) return 'inconclusive'
  if (baseline.outcome === 'not-admitted' || candidate.outcome === 'not-admitted') return 'inconclusive'
  if (baseline.outcome === 'failed' && candidate.outcome === 'failed') return 'both-failed'
  if (candidate.outcome === 'failed') return 'regressed'
  if (baseline.outcome === 'failed' && candidate.outcome === 'verified') return role === 'holdout' ? 'maintained' : 'fixed'
  const regressed = candidate.receipt.criteria.some(judged => {
    const before = baseline.receipt.criteria.find(item => item.criterionId === judged.criterionId)
    return judged.verdict === 'fail' && before?.verdict === 'pass'
  })
  return regressed ? 'regressed' : 'maintained'
}

/** The evaluation's overall verdict, recomputed from every sample and every guard. */
export function overallVerdict(trials: readonly TrialComparison[], guards: readonly GuardOutcome[], sampleVerdicts?: readonly TrialSampleVerdict[]): EvaluationVerdict {
  const verdicts = sampleVerdicts ?? trials.map(sampleVerdict)
  if (guards.some(guard => !guard.ok)) return 'regressed'
  if (verdicts.some(verdict => verdict === 'regressed')) return 'regressed'
  if (verdicts.length === 0) return 'inconclusive'
  if (verdicts.every(verdict => verdict === 'inconclusive')) return 'inconclusive'
  if (verdicts.every(verdict => verdict === 'both-failed')) return 'both-failed'
  const observed = trials.filter(comparison => comparison.role !== 'holdout')
  const observedFixed = observed.length > 0 && observed.every(comparison => {
    const verdict = verdicts[trials.indexOf(comparison)]
    return verdict === 'fixed' || verdict === 'maintained'
  })
  if (!observedFixed) return verdicts.some(verdict => verdict === 'fixed') ? 'fixed-with-regression' : 'not-fixed'
  const holdoutsHeld = trials.every((comparison, index) => comparison.role !== 'holdout' || verdicts[index] === 'maintained')
  return holdoutsHeld ? 'fixed' : 'fixed-with-regression'
}

/** Pair one plan's trials back into its samples' comparisons. */
export function comparisonsOf(plan: EvaluationReport['plan'], trials: readonly TrialResult[]): TrialComparison[] {
  return plan.samples.map(sample => {
    const baseline = trials.find(trial => trial.sampleTaskId === sample.taskId && trial.side === 'baseline')
    const candidate = trials.find(trial => trial.sampleTaskId === sample.taskId && trial.side === 'candidate')
    if (baseline === undefined || candidate === undefined) {
      throw new Error(`evolution: sample "${sample.taskId}" has no settled ${baseline === undefined ? 'baseline' : 'candidate'} side`)
    }
    return { sampleTaskId: sample.taskId, role: sample.role, baseline, candidate, verdict: 'inconclusive' as TrialSampleVerdict }
  })
}

/**
 * Validate one evaluation. Everything the report claims is re-derived from the
 * store and the frozen plan; a fact that does not re-derive refuses the report
 * while nothing has moved.
 */
export async function validateEvaluation(input: ValidateInput): Promise<ValidationOutcome> {
  const { report, sources, mode } = input
  const refusal = (detail: string): never => {
    throw new Error(`evolution: ${mode === 'pre-publish' ? 'the pre-publish re-check of' : 'the validation of'} report "${report.evaluationId}" refused it — ${detail}`)
  }
  assertEvaluationReport(report)
  const plan = report.plan
  const storeId = await sources.runtime.storeOfSession(sources.caller)
  const snapshot = await sources.tasks.openStore(storeId)
  const adapter = adapterFor(plan.kind)
  const guards: GuardOutcome[] = []

  if (mode === 'pre-publish') {
    const active = await sources.runtime.activeRevision(sources.caller)
    if (active.ref.revisionId !== plan.sides.baseline.revision.revisionId || active.ref.digest !== plan.sides.baseline.revision.digest) {
      refusal(
        `the library's active revision is "${active.ref.revisionId}" (${active.ref.digest}), not the frozen baseline ` +
          `"${plan.sides.baseline.revision.revisionId}" (${plan.sides.baseline.revision.digest}) — the comparison was made against another state`,
      )
    }
    await assertOutcomeEvidence(sources.root, report)
  }

  const comparisons: TrialComparison[] = []
  for (const sample of plan.samples) {
    const comparison = report.trials.find(item => item.sampleTaskId === sample.taskId)
    if (comparison === undefined) refusal(`sample "${sample.taskId}" of the frozen plan is absent from the report's trials`)
    const where = `sample "${sample.taskId}"`
    const receipts = new Map<'baseline' | 'candidate', ExecutionReceipt>()
    for (const side of ['baseline', 'candidate'] as const) {
      const trial = comparison[side]
      if (trial.outcome === 'not-admitted') {
        if (trial.admission === undefined) refusal(`the ${side} side of ${where} is not-admitted and carries no refusal`)
        continue
      }
      const runId = trial.receipt.runId
      if (runId === undefined) refusal(`the ${side} side of ${where} carries no run id, so its own receipt cannot be re-read`)
      const receipt = snapshot.receipts?.find(item => item.runId === runId) ?? (await sources.tasks.receiptFor(storeId, runId!))
      if (receipt === undefined) refusal(`the ${side} side of ${where} names run "${runId}", which the store holds no sealed receipt for`)
      if (receipt.digest !== trial.receipt.digest) {
        refusal(`the ${side} side of ${where} cites receipt digest ${trial.receipt.digest}, but store holds ${receipt.digest}`)
      }
      requireEstablished(receipt!, ['review', 'model-requests'], `${where} (${side} side)`)
      assertReceiptMatchesSide(plan.sides[side], trial.receipt, where)
      if (trial.receipt.workspaceDigest !== plan.input.digest) {
        refusal(
          `the ${side} side of ${where} ran in a workspace built from "${trial.receipt.workspaceDigest}", not the frozen input ` +
            `"${plan.input.digest}"`,
        )
      }
      assertFrozenJudges(report, comparison, refusal)
      receipts.set(side, receipt!)
    }
    if (receipts.size === 2) assertSidesIsolated(comparison.baseline.receipt, comparison.candidate.receipt, where)
    if (receipts.has('candidate')) {
      const proof = adapter.assertConsumed({
        plan,
        comparison,
        candidateReceipt: receipts.get('candidate')!,
        ...(receipts.has('baseline') ? { baselineReceipt: receipts.get('baseline')! } : {}),
      })
      guards.push({ id: `${plan.kind}-consumed`, kind: 'domain', ok: proof.proven, detail: proof.detail })
    }
    const domainGuard = adapter.guard({ plan, trials: [comparison] })
    if (domainGuard !== undefined) guards.push(domainGuard)
    comparisons.push({ ...comparison, verdict: sampleVerdict(comparison) })
  }

  const cost = costRefusal(plan, comparisons)
  if (cost !== undefined) guards.push(cost)
  for (const guard of plan.rules.guards) {
    guards.push({ id: guard.id, kind: guard.kind, ok: true, detail: `the frozen ${guard.kind} guard "${guard.id}" holds (bound ${guard.bound})` })
  }
  const verdict = overallVerdict(comparisons, guards, comparisons.map(comparison => comparison.verdict))
  if (mode === 'pre-publish' && verdict !== report.verdict) {
    refusal(`the report records verdict "${report.verdict}", but its own trials recompute "${verdict}"`)
  }
  if (guards.some(guard => !guard.ok)) refusal(guards.filter(guard => !guard.ok).map(guard => guard.detail).join('; '))
  return { trials: comparisons, guards, verdict }
}
