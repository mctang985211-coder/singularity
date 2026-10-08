/**
 * The pipeline's one entry: freeze the plan, run both sides, re-read the
 * runtime's receipts, validate, score and write the one report. A draft is
 * evaluated once; a second call reads the report the first one wrote.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_STRATEGY_POLICY } from '../strategy/policy.ts'
import type { StrategyPolicy } from '../strategy/policy.ts'
import { digestOf } from '../shared.ts'
import { draftView, draftViews } from '../draft/draft.ts'
import { buildEvaluationPlan } from './plan.ts'
import type { InputSnapshot } from '../evidence/snapshot.ts'
import { judgeOutcome } from '../evidence/judge.ts'
import type { OutcomeModelCall } from '../types.ts'
import { runEvaluation } from './run.ts'
import { validateEvaluation } from './validate.ts'
import { scoreEvaluation } from './score.ts'
import { buildEvaluationReport, evaluationReportBytes, evaluationReportDigest } from './report.ts'
import type { EvaluationSources } from './sources.ts'
import type { DraftView } from '../ledger/fold.ts'
import type {
  EvaluationBudget,
  EvaluationPlan,
  EvaluationReport,
  EvaluationRules,
  MethodListFilter,
  ModelSelection,
  OutcomeEvaluationPlan,
  PlannedSample,
  TrialResult,
} from '../types.ts'

/** What one evaluation call asks for. */
export interface EvaluateInput {
  readonly draftId: string
  readonly samples: readonly { readonly taskId: string; readonly role: PlannedSample['role'] }[]
  readonly input: InputSnapshot
  readonly model: ModelSelection
  readonly rules: EvaluationRules
  readonly budget: EvaluationBudget
  /** This call's repetition of the frozen scope; `0` is the first one. */
  readonly repetition?: number
  readonly evaluation?: OutcomeEvaluationPlan
  readonly policy?: StrategyPolicy
  readonly judge?: OutcomeModelCall
  readonly signal?: AbortSignal
  readonly maxParallel?: number
  readonly actor: string
}

/** The report file of one evaluation, relative to the evolution root. */
export function reportPathOf(draftId: string, evaluationId: string): string {
  return join('evaluations', draftId, evaluationId, 'evaluation-report.json')
}

/** Pair one plan's trials into its samples' comparisons. */
export function pairTrials(plan: EvaluationPlan, trials: readonly TrialResult[]): EvaluationReport['trials'] {
  return plan.samples.map(sample => {
    const baseline = trials.find(trial => trial.sampleTaskId === sample.taskId && trial.side === 'baseline')
    const candidate = trials.find(trial => trial.sampleTaskId === sample.taskId && trial.side === 'candidate')
    if (baseline === undefined || candidate === undefined) {
      throw new Error(`evolution: sample "${sample.taskId}" has no settled ${baseline === undefined ? 'baseline' : 'candidate'} side`)
    }
    return { sampleTaskId: sample.taskId, role: sample.role, baseline, candidate, verdict: 'inconclusive' as const }
  })
}

/** The one evaluation id: the draft and the frozen plan it belongs to. */
export function evaluationIdOf(plan: EvaluationPlan): string {
  return digestOf({ draftId: plan.draftId, planId: plan.planId, candidate: plan.sides.candidate.revision.digest }).slice(0, 16)
}

/** Freeze the plan's strategy block, so a decision recomputes from the plan alone. */
export function withStrategy(plan: EvaluationPlan, policy: StrategyPolicy): EvaluationPlan {
  const policyDigest = digestOf(policy)
  const cohortDigest = digestOf({
    planId: plan.planId,
    libraryId: plan.libraryId,
    kind: plan.kind,
    input: plan.input.digest,
    samples: plan.samples.map(sample => sample.contractDigest),
    policyDigest,
  })
  return { ...plan, strategy: { policy, policyDigest, cohortDigest } }
}

/** Read back the report one draft's evaluation wrote. */
export async function evaluationOf(sources: EvaluationSources, draftId: string): Promise<EvaluationReport> {
  const view = draftView(sources.ledger, draftId)
  if (view.evaluation === undefined) {
    throw new Error(`evolution: draft "${draftId}" is ${view.status} and records no evaluation`)
  }
  const path = resolve(sources.root, view.evaluation.reportPath)
  const report = JSON.parse(await readFile(path, 'utf8')) as EvaluationReport
  if (evaluationReportDigest(report) !== view.evaluation.reportDigest) {
    throw new Error(
      `evolution: the report of draft "${draftId}" reads ${evaluationReportDigest(report)}, not the ${view.evaluation.reportDigest} the ledger ` +
        'recorded — a report that moved is not the one the evaluation settled',
    )
  }
  return report
}

/** Every draft of this library, newest first, optionally filtered. */
export function methodList(sources: EvaluationSources, filter: MethodListFilter = {}): DraftView[] {
  return draftViews(sources.ledger, filter)
}

/**
 * Evaluate one draft: freeze → run → validate → score → one report. The plan and
 * the settled trials are recorded before the verdict, so a crash between them
 * leaves the runs that did happen as evidence.
 */
export async function evaluate(sources: EvaluationSources, input: EvaluateInput): Promise<EvaluationReport> {
  const view = draftView(sources.ledger, input.draftId)
  if (view.status === 'discarded') throw new Error(`evolution: draft "${input.draftId}" is discarded; a discarded draft is not evaluated`)
  if (view.evaluation !== undefined) return await evaluationOf(sources, input.draftId)

  const policy = input.policy ?? DEFAULT_STRATEGY_POLICY
  const plan = withStrategy(
    await buildEvaluationPlan(sources, {
      draft: view.draft,
      samples: input.samples,
      input: input.input,
      model: input.model,
      rules: input.rules,
      budget: input.budget,
      repetition: input.repetition ?? 0,
      ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
      libraryId: sources.libraryId,
    }),
    policy,
  )
  const evaluationId = evaluationIdOf(plan)
  const at = new Date().toISOString()
  const reportPath = reportPathOf(plan.draftId, evaluationId)

  const run = await runEvaluation(sources, {
    plan,
    evaluationId,
    actor: input.actor,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.maxParallel === undefined ? {} : { maxParallel: input.maxParallel }),
  })
  await sources.ledger.append({
    formatVersion: 5,
    kind: 'plan',
    draftId: plan.draftId,
    evaluationId,
    plan,
    planDigest: digestOf(plan),
    report: reportPath,
    storeId: run.storeId,
    actor: input.actor,
    at,
  })
  for (const trial of run.trials) {
    await sources.ledger.append({ formatVersion: 5, kind: 'trial', draftId: plan.draftId, evaluationId, trial })
  }

  const trials = pairTrials(plan, run.trials)
  let evaluation: EvaluationReport['evaluation']
  if (plan.rules.objective === 'llm-outcome') {
    if (input.judge === undefined) {
      throw new Error(
        `evolution: draft "${plan.draftId}" declares the llm-outcome objective but this call offers no judge — the independent judgement is ` +
          'evidence, so it is never assumed',
      )
    }
    const judged = await judgeOutcome({
      root: sources.root,
      plan,
      trials,
      judge: input.judge,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    evaluation = judged.evaluation
  }

  const repeats = (input.repetition ?? 0) + 1
  const provisional = buildEvaluationReport({
    plan,
    evaluationId,
    at,
    trials,
    score: scoreEvaluation({ plan, trials, repeats }),
    guards: [],
    verdict: 'inconclusive',
    ...(evaluation === undefined ? {} : { evaluation }),
  })
  const outcome = await validateEvaluation({ report: provisional, sources, mode: 'evaluate' })
  const report = buildEvaluationReport({
    plan,
    evaluationId,
    at,
    trials: outcome.trials,
    score: scoreEvaluation({ plan, trials: outcome.trials, repeats }),
    guards: outcome.guards,
    verdict: outcome.verdict,
    ...(evaluation === undefined ? {} : { evaluation }),
  })
  const absolute = resolve(sources.root, reportPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, evaluationReportBytes(report), 'utf8')
  await sources.ledger.append({
    formatVersion: 5,
    kind: 'evaluation',
    draftId: plan.draftId,
    evaluationId,
    report: reportPath,
    reportDigest: evaluationReportDigest(report),
    verdict: report.verdict,
    scoreDigest: digestOf(report.score),
    actor: input.actor,
    at: new Date().toISOString(),
  })
  return report
}

/** Record one draft's publish completion, under the revision the environment actually switched to. */
export async function markPublished(
  sources: EvaluationSources,
  input: { draftId: string; revisionId: string; supersededRevisionId: string | null; intentId: string; approvalRef?: string; actor: string },
): Promise<void> {
  const view = draftView(sources.ledger, input.draftId)
  if (view.status !== 'evaluated' && view.status !== 'published') {
    throw new Error(`evolution: draft "${input.draftId}" is ${view.status}; a publish completion closes an evaluated draft`)
  }
  await sources.ledger.append({
    formatVersion: 5,
    kind: 'published',
    draftId: input.draftId,
    revisionId: input.revisionId,
    supersededRevisionId: input.supersededRevisionId,
    intentId: input.intentId,
    ...(input.approvalRef === undefined ? {} : { approvalRef: input.approvalRef }),
    actor: input.actor,
    at: new Date().toISOString(),
  })
}

/** Record one rollback completion. */
export async function markRolledback(
  sources: EvaluationSources,
  input: { draftId: string | null; revisionId: string; supersededRevisionId: string | null; intentId: string; approvalRef?: string; actor: string },
): Promise<void> {
  await sources.ledger.append({
    formatVersion: 5,
    kind: 'rolledback',
    draftId: input.draftId,
    revisionId: input.revisionId,
    supersededRevisionId: input.supersededRevisionId,
    intentId: input.intentId,
    ...(input.approvalRef === undefined ? {} : { approvalRef: input.approvalRef }),
    actor: input.actor,
    at: new Date().toISOString(),
  })
}

/** Every report one library holds, newest first — the read the Web and the tools share. */
export async function evaluationList(sources: EvaluationSources): Promise<EvaluationReport[]> {
  const directory = resolve(sources.root, 'evaluations')
  let drafts: string[]
  try {
    drafts = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const reports: EvaluationReport[] = []
  for (const draftId of drafts) {
    const view = draftView(sources.ledger, draftId).evaluation
    if (view === undefined) continue
    reports.push(await evaluationOf(sources, draftId))
  }
  return reports
}
