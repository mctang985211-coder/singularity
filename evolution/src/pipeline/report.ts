/**
 * The one evaluation report: its bytes, its digest and its self-check. A report
 * is written beside the ledger and re-read by the publish path, so everything it
 * carries is recomputed here rather than trusted: the plan digest, the score and
 * the verdict all follow from the report's own contents.
 */

import { assertEvaluationPlan } from '../ledger/records.ts'
import { canonicalJson, digestOf } from '../shared.ts'
import type { EvaluationPlan, EvaluationReport, EvaluationScore, EvaluationVerdict, GuardOutcome, OutcomeEvaluation, TrialComparison } from '../types.ts'
import { scoreEvaluation } from './score.ts'

/** The one byte sequence a report is written and digested as. */
export function evaluationReportBytes(report: EvaluationReport): string {
  return `${canonicalJson(report)}\n`
}

/** The digest of a report's own bytes: what a ledger line and a decision record both cite. */
export function evaluationReportDigest(report: EvaluationReport): string {
  return digestOf(report)
}

/** Assemble one report from its parts. The plan is carried whole, so the report recomputes without a second read. */
export function buildEvaluationReport(input: {
  plan: EvaluationPlan
  evaluationId: string
  at: string
  trials: readonly TrialComparison[]
  score: EvaluationScore
  guards: readonly GuardOutcome[]
  verdict: EvaluationVerdict
  evaluation?: OutcomeEvaluation
}): EvaluationReport {
  return {
    formatVersion: 5,
    draftId: input.plan.draftId,
    evaluationId: input.evaluationId,
    planId: input.plan.planId,
    libraryId: input.plan.libraryId,
    kind: input.plan.kind,
    at: input.at,
    plan: input.plan,
    planDigest: digestOf(input.plan),
    ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
    trials: input.trials,
    score: input.score,
    guards: input.guards,
    verdict: input.verdict,
  }
}

/**
 * The one report schema check: every digest it carries is recomputed, the score
 * is rebuilt from the trials, and the identity members are re-derived. A report
 * that fails any of them is a report nobody may publish from.
 */
export function assertEvaluationReport(report: unknown): asserts report is EvaluationReport {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('evolution: an evaluation report must be an object')
  }
  const value = report as EvaluationReport
  if (value.formatVersion !== 5) {
    throw new Error(
      `evolution: the evaluation report declares formatVersion ${JSON.stringify((value as { formatVersion?: unknown }).formatVersion ?? null)}; ` +
        'the new protocol reads and writes formatVersion 5 only',
    )
  }
  assertEvaluationPlan(value.plan, 'evaluation report plan')
  if (value.planDigest !== digestOf(value.plan)) {
    throw new Error(
      `evolution: the evaluation report of draft "${value.draftId}" carries planDigest ${value.planDigest}, which does not match its own plan ` +
        `(${digestOf(value.plan)}) — a report whose plan moved is not the report the pipeline wrote`,
    )
  }
  if (value.planId !== value.plan.planId || value.draftId !== value.plan.draftId || value.libraryId !== value.plan.libraryId || value.kind !== value.plan.kind) {
    throw new Error(`evolution: the evaluation report of draft "${value.draftId}" disagrees with the plan it carries about its own identity`)
  }
  if (!Array.isArray(value.trials)) throw new Error('evolution: an evaluation report must carry a trial list')
  for (const [index, comparison] of value.trials.entries()) {
    if (comparison.sampleTaskId !== comparison.baseline.sampleTaskId || comparison.sampleTaskId !== comparison.candidate.sampleTaskId) {
      throw new Error(`evolution: trial ${index} of report "${value.evaluationId}" mixes samples between its two sides`)
    }
    if (comparison.baseline.side !== 'baseline' || comparison.candidate.side !== 'candidate') {
      throw new Error(`evolution: trial ${index} of report "${value.evaluationId}" has its sides swapped`)
    }
    if (!value.plan.samples.some(sample => sample.taskId === comparison.sampleTaskId)) {
      throw new Error(`evolution: trial ${index} of report "${value.evaluationId}" names sample "${comparison.sampleTaskId}", which the plan does not hold`)
    }
  }
  const recomputed = scoreEvaluation({
    plan: value.plan,
    trials: value.trials,
    repeats: value.score?.uncertainty?.repeats ?? 1,
    noiseBand: value.score?.uncertainty?.noiseBand ?? null,
  })
  if (digestOf(recomputed) !== digestOf(value.score)) {
    throw new Error(
      `evolution: the score of report "${value.evaluationId}" does not recompute from its own trials (recorded ${digestOf(value.score)}, ` +
        `recomputed ${digestOf(recomputed)}) — a score a reader cannot rebuild is not evidence`,
    )
  }
}
