/**
 * The independent judge and its evidence. One call per evaluation, no repair
 * chain: the plan freezes the rubric, the judge answers once, and the answer is
 * written beside the report with the digests that prove it did not move.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import { OUTCOME_JUDGE_PROMPT } from '../replay/outcome.ts'
import { canonicalJson } from '../shared.ts'
import type { EvaluationPlan, EvaluationReport, OutcomeEvaluation, OutcomeEvaluationPlan, OutcomeJudgement, TrialComparison } from '../types.ts'

export { OUTCOME_JUDGE_PROMPT }

import type { OutcomeModelCall, OutcomeModelResult } from '../experiment/spec.ts'
export type { OutcomeModelCall, OutcomeModelResult }

/** One evaluation's judge answer for one sample. */
type SampleJudgement = OutcomeJudgement['samples'][number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The document the judge is asked about: the frozen rubric, the measurements and every side's own settled facts. */
export function outcomeInputDocument(input: { plan: EvaluationPlan; trials: readonly TrialComparison[] }): string {
  const plan = input.plan
  const evaluation = plan.evaluation
  if (evaluation === undefined) {
    throw new Error(`evolution: plan "${plan.planId}" declares the llm-outcome objective but freezes no rubric or measurements`)
  }
  return canonicalJson({
    goal: evaluation.goal,
    rubric: evaluation.rubric,
    measurements: evaluation.measurements,
    rules: plan.rules,
    samples: input.trials.map(comparison => ({
      taskId: comparison.sampleTaskId,
      role: comparison.role,
      mechanicalVerdict: comparison.verdict,
      baseline: sideFacts(comparison.baseline),
      candidate: sideFacts(comparison.candidate),
    })),
  })
}

function sideFacts(trial: TrialComparison['baseline']): Record<string, unknown> {
  return {
    outcome: trial.outcome,
    revision: trial.receipt.boundRevision,
    criteria: trial.receipt.criteria,
    evidenceRefs: trial.receipt.evidenceRefs,
    cost: trial.receipt.cost,
    ...(trial.reason === undefined ? {} : { reason: trial.reason }),
  }
}

/** Parse one judge response into the judgement the report carries, refusing anything that is not that shape. */
export function parseOutcomeJudgement(response: string, plan: EvaluationPlan): OutcomeJudgement {
  let parsed: unknown
  try {
    parsed = JSON.parse(response)
  } catch (error) {
    throw new Error(`evolution: the outcome judge's response is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.samples)) {
    throw new Error("evolution: the outcome judge's response carries no samples array")
  }
  const verdicts = ['improved', 'not-improved', 'regressed', 'inconclusive']
  const wanted = new Set(plan.samples.map(sample => sample.taskId))
  const samples: SampleJudgement[] = parsed.samples.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.taskId !== 'string' || typeof raw.verdict !== 'string' || !verdicts.includes(raw.verdict)) {
      throw new Error(`evolution: the outcome judge's sample ${index} carries no taskId and a verdict in ${verdicts.join(' / ')}`)
    }
    if (!wanted.has(raw.taskId)) {
      throw new Error(`evolution: the outcome judge answered about "${raw.taskId}", which the frozen plan does not hold`)
    }
    const findings = Array.isArray(raw.findings) ? raw.findings : []
    return {
      taskId: raw.taskId,
      verdict: raw.verdict as SampleJudgement['verdict'],
      findings: findings.map(finding => {
        if (!isRecord(finding) || typeof finding.claim !== 'string') {
          throw new Error(`evolution: a finding of sample "${raw.taskId}" carries no claim`)
        }
        return {
          claim: finding.claim,
          evidenceRefs: Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs.map(String) : [],
        }
      }),
      uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties.map(String) : [],
    }
  })
  const missing = [...wanted].filter(taskId => !samples.some(sample => sample.taskId === taskId))
  if (missing.length > 0) {
    throw new Error(
      `evolution: the outcome judge answered about no sample ${missing.map(id => JSON.stringify(id)).join(', ')}; every frozen sample is judged once`,
    )
  }
  return { samples }
}

/** Where one evaluation's judge evidence lives, relative to the evolution root. */
export function outcomeEvidenceDirectory(draftId: string, evaluationId: string): string {
  return join('evaluations', draftId, evaluationId)
}

/**
 * Ask the independent judge once about one evaluation and write its evidence
 * beside the report. The judge's own usage is carried when it reports one; a
 * missing usage stays missing.
 */
export async function judgeOutcome(input: {
  root: string
  plan: EvaluationPlan
  trials: readonly TrialComparison[]
  judge: OutcomeModelCall
  signal?: AbortSignal
}): Promise<{ evaluation: OutcomeEvaluation; directory: string }> {
  const plan = input.plan
  const frozen = plan.evaluation
  if (frozen === undefined) {
    throw new Error(`evolution: plan "${plan.planId}" declares the llm-outcome objective but freezes no judge plan`)
  }
  const document = outcomeInputDocument({ plan, trials: input.trials })
  const answer = await input.judge(frozen.judge.model, frozen.judge.prompt, document, input.signal)
  const response = typeof answer === 'string' ? answer : answer.response
  const usage = typeof answer === 'string' ? undefined : answer.usage
  const judgement = parseOutcomeJudgement(response, plan)
  const directory = outcomeEvidenceDirectory(plan.draftId, plan.planId)
  const evidencePath = join(directory, 'outcome-input.json')
  const responsePath = join(directory, 'outcome-response.json')
  await mkdir(dirname(resolve(input.root, evidencePath)), { recursive: true })
  await writeFile(resolve(input.root, evidencePath), document, 'utf8')
  await writeFile(resolve(input.root, responsePath), response, 'utf8')
  return {
    directory,
    evaluation: {
      input: document,
      inputDigest: sha256Hex(document),
      evidencePath,
      evidenceDigest: sha256Hex(document),
      response,
      responseDigest: sha256Hex(response),
      judgement,
      ...(usage === undefined ? {} : { judgeUsage: usage }),
    },
  }
}

/** Re-read one evaluation's judge evidence and refuse a report whose evidence moved. */
export async function assertOutcomeEvidence(root: string, report: EvaluationReport): Promise<void> {
  if (report.plan.rules.objective !== 'llm-outcome') return
  const evaluation = report.evaluation
  if (evaluation === undefined) {
    throw new Error(`evolution: the llm-outcome evaluation of draft "${report.draftId}" carries no saved independent judgement`)
  }
  const expected = outcomeEvidenceDirectory(report.draftId, report.evaluationId)
  if (evaluation.evidencePath !== join(expected, 'outcome-input.json')) {
    throw new Error(`evolution: the judge evidence of "${report.evaluationId}" sits outside its own directory (${evaluation.evidencePath})`)
  }
  const evidence = await readFile(resolve(root, evaluation.evidencePath), 'utf8')
  const response = await readFile(resolve(root, join(expected, 'outcome-response.json')), 'utf8')
  if (evidence !== evaluation.input || sha256Hex(evidence) !== evaluation.evidenceDigest) {
    throw new Error(`evolution: the saved judge input of "${report.evaluationId}" changed since the report was written`)
  }
  if (response !== evaluation.response || sha256Hex(response) !== evaluation.responseDigest) {
    throw new Error(`evolution: the saved judge response of "${report.evaluationId}" changed since the report was written`)
  }
}
