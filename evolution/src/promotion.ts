/**
 * The skill promotion gate (S4-E §F.2, EVAL-2/EVAL-3/EVAL-4): what a PROMOTE of a
 * single-file skill candidate must be able to prove before a human is asked.
 *
 * The v1 gate read a candidate-vs-champion replay report. This gate reads the
 * two-sided experiment instead — and re-reads it, rather than trusting it:
 *
 * 1. **A completed experiment.** The proposal's newest experiment must have one
 *    settled record per frozen sample and side. An experiment that stopped
 *    half-way is not evidence; the refusal names the sides the ledger is missing.
 * 2. **The identity prepare recorded.** The experiment's frozen candidate must be
 *    the prepared `SKILL.md` this proposal would write, and its frozen
 *    `productionBaseline` the baseline prepare captured (P3). The caller
 *    re-verifies the candidate's bytes (P2) as well; this check is what ties the
 *    frozen block to that file.
 * 3. **The report is its records.** The report file's bytes must equal the report
 *    `buildExperimentReport(view)` recomputes from the ledger, and the report must
 *    pass its own schema assertion. A file edited after the experiment — a verdict
 *    improved, a criterion flipped — is not the experiment's report.
 * 4. **Every side is a real run of this experiment.** Each side's task, run,
 *    review record and evidence are read back from the task store and checked
 *    against the ledger: the run must exist, belong to a replayed task of *this*
 *    experiment's own lineage, agree with the side's outcome and criteria, and its
 *    evidence must be bundles of that run. A record or report pointing anywhere
 *    else — at the sample's historical run, at another side's run, at an evidence
 *    id nobody holds — is refused instead of read as a baseline.
 * 5. **The inputs and the judge have not drifted.** Each frozen sample's contract
 *    digest must still equal the store's contract, each criterion's protected
 *    inputs digest and file bytes must still be the frozen ones (re-read in the
 *    production workspace the experiment froze, the same read rule the verifier
 *    uses), and every criterion in the report must name a verifier that is
 *    registered *now* with the same version it judged with.
 * 6. **The model has not drifted.** The model identity the deployment resolves now
 *    — the one injected into this service, the same source the experiment freezes
 *    from — must equal `frozen.model`. No resolver, or one that names nothing, is
 *    a refusal, never a skipped check.
 * 7. **The verdict.** Only `fixed` is promotable. `fixed-with-regression`,
 *    `regressed`, `not-fixed`, `both-failed` and `inconclusive` each get their own
 *    named refusal, so "the failure is not fixed", "a holdout degraded" and "the
 *    evidence never settled" are distinguishable without reading the report.
 * 8. **The cost the frozen budget demands.** A frozen budget that declares a cost
 *    ceiling cannot be shown to hold while a side's cost is `unknown`: the
 *    promotion is refused. With no ceiling declared, `unknown` stays the honest
 *    observation it is and is recorded, not turned into a zero and not treated as
 *    a refusal.
 *
 * Nothing here writes: the whole gate is reads. The production write, its own
 * re-check of the candidate (P2) and the production baseline (P3), and the two
 * human approvals stay where they are (the service's `apply` and the tools).
 *
 * EVAL-4 lives here too: only a `skill` proposal has an evaluator in this build.
 * Every other target type is refused by name — a historical report is not
 * upgraded into new evidence, and a type with no evaluator gets no promotion.
 * @module dsh-singularity-evolution/promotion
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ReviewCriterion, ReviewRecord, TaskInstance, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { EvolutionProposal } from './evolution.ts'
import { experimentLineage, evidenceRefsOf } from './experiment.ts'
import type { ExperimentView } from './experiment.ts'
import { buildExperimentReport } from './experiment.ts'
import type {
  ExperimentReport,
  ExperimentSampleComparison,
  ExperimentSideDetail,
  ExperimentVerdict,
  FrozenCriterion,
  FrozenSample,
} from './replay.ts'
import { assertExperimentReport, digestOf, protectedInputsDigest } from './replay.ts'

/** The task store as the gate reads it back: the runs, reviews and evidence an experiment's sides cite. */
export interface PromotionStoreReads {
  openStore(storeId: string): Promise<TaskSnapshot>
}

/** The registered verifier vocabulary a report's criteria are judged against, as the registry lists it now. */
export interface VerifierVocabulary {
  readonly ids: readonly string[]
  /** Declared versions by verifier id; a verifier that declares none is absent. */
  readonly versions: Readonly<Record<string, string>>
}

/**
 * The services and facts the gate reads. Every one of them is resolved by the
 * caller (the evolution service) from its own context, so this module decides
 * *what* must hold and never *where* a deployment keeps it.
 */
export interface SkillPromotionSources {
  /** Absolute ledger root: the report path is resolved inside it. */
  readonly root: string
  /** Every experiment folded under one proposal, newest first. */
  experiments(proposalId: string): Promise<ExperimentView[]>
  readonly task: PromotionStoreReads
  /** The registered judges, or `undefined` when the deployment cannot list them (fail-closed). */
  verifierVocabulary(): Promise<VerifierVocabulary | undefined>
  /** The model identity both sides ran under; throws when the deployment cannot name one (fail-closed). */
  modelIdentity(): string
}

/** What a passing gate proves, for the caller to report: the experiment, its report and where it sits. */
export interface SkillPromotionEvidence {
  readonly experimentId: string
  readonly report: ExperimentReport
  /** Report path relative to the ledger root. */
  readonly reportPath: string
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The refusal every other target type gets: no evaluator, no promotion. This
 * build evaluates a replacement of an existing single-file `SKILL.md`;
 * capability, agent_preset, task_definition, the bookkeeping-only types and L4
 * have no evidence this gate could read, so a historical report cannot be
 * reused to promote them (§F.2: "没有支持的评估器就拒绝新晋升"). Their records
 * stay readable and an already-applied one still rolls back.
 */
export function noEvaluatorRefusal(proposal: EvolutionProposal): Error {
  const history = proposal.replayed === undefined
    ? ''
    : ` Its recorded v1 replay report (${proposal.replayed.report}) is not this build's evidence either: ` +
      'a historical report is never upgraded into a new promotion.'
  return new Error(
    `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — ` +
    'the two-sided experiment (§F.2) evaluates a replacement of an existing single-file SKILL.md only, and a promotion ' +
    'without supported evaluation evidence is refused rather than granted from a historical report.' + history,
  )
}

/** The refusal of a skill candidate whose evaluation is still the v1 candidate-vs-champion replay. */
function historicalReportRefusal(proposal: EvolutionProposal): Error {
  const replay = proposal.replayed
  const where = replay === undefined ? '' : ` (${replay.report}, verdict ${replay.verdict})`
  return new Error(
    `evolution: skill proposal "${proposal.proposalId}" holds a v1 candidate-vs-champion replay report${where} and no two-sided ` +
    'experiment — a historical report is not upgraded into this build\'s evidence (§F.2); run the two-sided experiment ' +
    '(evolution_replay) so the candidate is compared against a new baseline run of the same frozen samples',
  )
}

/** The refusal of a skill proposal nothing has evaluated yet. */
function noExperimentRefusal(proposal: EvolutionProposal): Error {
  return new Error(
    `evolution: skill proposal "${proposal.proposalId}" carries no two-sided experiment — a PROMOTE needs both sides of every ` +
    'frozen sample run as this experiment\'s own new runs; evaluate the candidate with evolution_replay before promoting it',
  )
}

/** One verdict's refusal text: the six outcomes §F.2 makes distinguishable, each named for what it means. */
const VERDICT_REFUSALS: Readonly<Record<ExperimentVerdict, string>> = {
  'fixed': '',
  'fixed-with-regression': 'the target failure is fixed, but a regression or holdout sample degraded under the candidate',
  'regressed': 'a regression or holdout sample degraded and the target failure is not fixed',
  'not-fixed': 'the candidate did not fix the target failure',
  'both-failed': 'the target failure was reproduced on the baseline and still fails on the candidate (both sides failed)',
  'inconclusive': 'the experiment could not settle, so it says nothing about the candidate',
}

/** `sample <taskId> [<role>]: <verdict>` per sample — the detail a verdict refusal carries. */
function sampleVerdictLines(samples: readonly ExperimentSampleComparison[]): string[] {
  return samples.map(sample => `sample ${sample.taskId} [${sample.role}]: ${sample.verdict}`)
}

/** The report's byte serialization, exactly as the orchestrator writes it. */
function reportBytes(report: ExperimentReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * Whether one report side's evidence exists in the store as the side says it
 * does: a replayed task of this experiment's own lineage whose run this side
 * cites, the review record that settles that run with the outcome and criteria
 * the side reports, and the evidence bundles that run produced.
 */
function assertSideEvidence(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  experimentId: string
  snapshot: TaskSnapshot
  where: string
}): void {
  const { sample, detail, experimentId, snapshot, where } = input
  if (detail.outcome === 'interrupted') return
  const lineage = experimentLineage(experimentId, sample.taskId, detail.side)
  const task: TaskInstance | undefined = snapshot.tasks.find(item => item.objective?.startsWith(`[${lineage}] `))
  if (task === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} does not cite a replayed task this experiment created — the store holds no ` +
      `task of lineage "${lineage}" (${detail.taskId ?? 'no task'}/${detail.runId ?? 'no run'}); a side that is not one of this ` +
      'experiment\'s own runs is not a baseline, whatever the record says',
    )
  }
  if (detail.taskId !== task.taskId) {
    throw new Error(
      `evolution: the experiment report's ${where} names task "${String(detail.taskId)}" but the run it cites belongs to replayed ` +
      `task "${task.taskId}" of this experiment's own lineage — the identity a promotion reads must be the task the run ran as`,
    )
  }
  if (detail.runId === undefined || !task.runIds.includes(detail.runId)) {
    throw new Error(
      `evolution: the experiment report's ${where} cites run "${String(detail.runId)}", which no run of this experiment's own ` +
      `replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline`,
    )
  }
  const runId = detail.runId
  const review: ReviewRecord | undefined = snapshot.reviews.find(item => item.runId === runId)
  if (review === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} cites run "${runId}", which the store settles with no review record — a side ` +
      'without a terminal review record is not a settled run',
    )
  }
  if (review.taskId !== task.taskId) {
    throw new Error(
      `evolution: the review record for run "${runId}" belongs to task "${review.taskId}", not the replayed task "${task.taskId}" ` +
      `the experiment report's ${where} cites`,
    )
  }
  if (review.outcome !== detail.outcome) {
    throw new Error(
      `evolution: the experiment report's ${where} reports outcome "${detail.outcome}" but the store's review record for run ` +
      `"${runId}" settled "${review.outcome}" — the report and the store disagree about what ran`,
    )
  }
  if (detail.reviewRef !== `${task.taskId}#${runId}`) {
    throw new Error(
      `evolution: the experiment report's ${where} cites review ref "${String(detail.reviewRef)}" but its run "${runId}" settles ` +
      `as "${task.taskId}#${runId}" — the reference a promotion reads must name the record that exists`,
    )
  }
  const recorded: readonly ReviewCriterion[] = review.criteria ?? []
  const reported: readonly ReviewCriterion[] = detail.criteria
  if (recorded.length > 0) {
    const byId = new Map(recorded.map(criterion => [criterion.criterionId, criterion]))
    for (const criterion of reported) {
      const stored = byId.get(criterion.criterionId)
      if (stored === undefined) {
        throw new Error(
          `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}", which the store's review ` +
          `record for run "${runId}" does not carry`,
        )
      }
      if (stored.verdict !== criterion.verdict || stored.verifierId !== criterion.verifierId
        || stored.verifierVersion !== criterion.verifierVersion) {
        throw new Error(
          `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" as ` +
          `${criterion.verdict}${criterion.verifierId === undefined ? '' : ` (${criterion.verifierId}${criterion.verifierVersion === undefined ? '' : `@${criterion.verifierVersion}`})`}, ` +
          `but run "${runId}" settled it as ${stored.verdict}${stored.verifierId === undefined ? '' : ` (${stored.verifierId}${stored.verifierVersion === undefined ? '' : `@${stored.verifierVersion}`})`} — ` +
          'the verdicts a promotion reads are the ones the store recorded',
        )
      }
    }
    if (reported.length !== recorded.length) {
      throw new Error(
        `evolution: the experiment report's ${where} carries ${reported.length} criterion verdicts while run "${runId}" settled ` +
        `${recorded.length} — a side must report exactly the criteria its review record carries`,
      )
    }
  }
  const expected = evidenceRefsOf(snapshot, runId, review)
  const reportedRefs = [...detail.evidenceRefs].sort()
  const storedRefs = [...expected].sort()
  if (reportedRefs.length !== storedRefs.length || reportedRefs.some((ref, index) => ref !== storedRefs[index])) {
    throw new Error(
      `evolution: the experiment report's ${where} cites evidence [${detail.evidenceRefs.join(', ')}] but run "${runId}" holds ` +
      `[${expected.join(', ')}] — the evidence a promotion reads must be the bundles that run produced`,
    )
  }
  for (const ref of detail.evidenceRefs) {
    const bundle = snapshot.evidence.find(item => item.evidenceId === ref)
    if (bundle === undefined) {
      throw new Error(`evolution: the experiment report's ${where} cites evidence "${ref}", which the store does not hold`)
    }
    if (bundle.taskRunId !== runId) {
      throw new Error(
        `evolution: the experiment report's ${where} cites evidence "${ref}" of run "${String(bundle.taskRunId)}", not of its own ` +
        `run "${runId}" — evidence from another run cannot stand for this side`,
      )
    }
  }
  if (detail.initialDigest === undefined) {
    throw new Error(
      `evolution: the experiment report's ${where} settled a run and records no workspace digest — the frozen input the side ran ` +
      'from cannot be re-proved',
    )
  }
}

/** The store's contract of one sample, as the freeze derived its digest: objective, criteria, required capabilities. */
function contractDigestOf(task: TaskInstance): string {
  return digestOf({
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredCapabilities: task.requestedCapabilities,
  })
}

/**
 * Whether one frozen sample still stands as it was frozen: the store's contract
 * hashes to the frozen digest, every frozen criterion is still there with the
 * same mode, command and protected-input identity, and every declared protected
 * input still holds the bytes it was fixed against — re-read in the production
 * workspace the experiment froze, with the same rule the verifier's own
 * pre-judgement check uses (`resolve(cwd, path)`, byte digest, a missing or
 * changed input is a defect).
 */
async function assertSampleInputsIntact(input: {
  sample: FrozenSample
  snapshot: TaskSnapshot
  productionWorkspace: string
}): Promise<void> {
  const { sample, snapshot, productionWorkspace } = input
  const task = snapshot.tasks.find(item => item.taskId === sample.taskId)
  if (task === undefined) {
    throw new Error(
      `evolution: the experiment froze sample "${sample.taskId}", which this graph's task store no longer holds — the case the ` +
      'candidate was evaluated against cannot be re-read, so the evidence cannot be re-checked',
    )
  }
  const digest = contractDigestOf(task)
  if (digest !== sample.contractDigest) {
    throw new Error(
      `evolution: sample "${sample.taskId}" changed since the experiment froze it (contract digest ${digest} != ` +
      `${sample.contractDigest}) — the case, its acceptance or its required capabilities moved, so the runs on record were judged ` +
      'against a contract this proposal is no longer evaluated against',
    )
  }
  const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []
  for (const frozen of sample.criteria) {
    const criterion = criteria.find(item => item.criterionId === frozen.criterionId)
    if (criterion === undefined) {
      throw new Error(`evolution: sample "${sample.taskId}" no longer carries the frozen criterion "${frozen.criterionId}"`)
    }
    assertFrozenCriterionIntact(sample.taskId, frozen, criterion)
    for (const protectedInput of criterion.protectedInputs ?? []) {
      await assertProtectedInputIntact(sample.taskId, protectedInput, productionWorkspace)
    }
  }
}

/** One criterion's frozen identity against the store's current one. */
function assertFrozenCriterionIntact(
  taskId: string,
  frozen: FrozenCriterion,
  criterion: { verificationMode?: string; command?: string; protectedInputs?: readonly { path: string; sha256: string }[] },
): void {
  const currentDigest = protectedInputsDigest(criterion.protectedInputs ?? [])
  if (criterion.verificationMode !== frozen.verificationMode || criterion.command !== frozen.command
    || currentDigest !== frozen.protectedInputsDigest) {
    throw new Error(
      `evolution: criterion "${frozen.criterionId}" of sample "${taskId}" changed since the experiment froze it ` +
      `(mode ${String(criterion.verificationMode)}/${frozen.verificationMode}, protected inputs ${currentDigest} != ` +
      `${frozen.protectedInputsDigest}) — the acceptance the two sides ran under is no longer the frozen one`,
    )
  }
}

/** One declared protected input, re-read where the criterion's judge would read it. */
async function assertProtectedInputIntact(
  taskId: string,
  input: { path: string; sha256: string },
  productionWorkspace: string,
): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(resolve(productionWorkspace, input.path))
  } catch (error) {
    throw new Error(
      `evolution: the protected input "${input.path}" of sample "${taskId}" cannot be read in the production workspace ` +
      `"${productionWorkspace}" (${error instanceof Error ? error.message : String(error)}) — the input the acceptance rests on ` +
      'is gone, so the experiment\'s judging cannot be re-proved',
    )
  }
  const digest = sha256Hex(bytes)
  if (digest !== input.sha256) {
    throw new Error(
      `evolution: the protected input "${input.path}" of sample "${taskId}" changed since the experiment froze it ` +
      `(sha256 ${digest} != ${input.sha256}) — a criterion whose input moved is not the criterion the candidate was judged by`,
    )
  }
}

/**
 * Whether every criterion verdict a report side carries still names a registered
 * judge, at the version it judged with. Fail-closed: a deployment that cannot
 * list its verifier vocabulary refuses rather than assuming the judge is there.
 */
function assertJudgeUnchanged(detail: ExperimentSideDetail, where: string, vocabulary: VerifierVocabulary): void {
  for (const criterion of detail.criteria) {
    if (criterion.verifierId === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that ` +
        'decided it — a verdict nobody can be recalled against is not evidence a promotion may read',
      )
    }
    if (!vocabulary.ids.includes(criterion.verifierId)) {
      throw new Error(
        `evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}", which is no longer ` +
        `registered (registered: ${vocabulary.ids.length === 0 ? 'none' : vocabulary.ids.join(', ')}) — the judge moved, so the ` +
        'verdicts on record cannot be reproduced',
      )
    }
    const current = vocabulary.versions[criterion.verifierId]
    if (criterion.verifierVersion !== current) {
      throw new Error(
        `evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}" at version ` +
        `${criterion.verifierVersion === undefined ? '(none declared)' : criterion.verifierVersion}, but the registered instance ` +
        `declares ${current === undefined ? '(none)' : current} now — a verdict belongs to the instance that judged, so a ` +
        're-registered version invalidates the evidence',
      )
    }
  }
}

/** Whether a side's cost is known enough for a frozen budget that declares a ceiling. */
function assertCostWithinDeclaredBudget(report: ExperimentReport, where: string, detail: ExperimentSideDetail): void {
  const budget = report.frozen.budget
  const ceiling = budget.maxTokens ?? budget.wallTimeMs
  if (ceiling === undefined) return
  if (detail.cost.status === 'unknown') {
    throw new Error(
      `evolution: the frozen budget declares a cost ceiling (${budget.maxTokens === undefined ? `wallTimeMs ${budget.wallTimeMs}` : `maxTokens ${budget.maxTokens}`}) ` +
      `and the ${where} reports no cost (${detail.cost.reason}) — an unknown cost cannot be shown to fit a ceiling the frozen ` +
      'budget set, so the promotion is refused rather than inferred',
    )
  }
}

/**
 * The whole skill promotion gate, as reads. Returns the experiment it validated
 * so the caller can report the id, the report and the path; throws a named
 * refusal for the first condition that does not hold, having written nothing.
 */
export async function assertSkillPromotionEvidence(
  sources: SkillPromotionSources,
  proposal: EvolutionProposal,
): Promise<SkillPromotionEvidence> {
  const prepared = proposal.prepared
  const candidate = prepared?.skillContent
  if (candidate === undefined) {
    throw new Error(
      `evolution: skill proposal "${proposal.proposalId}" records no candidate content identity — it was prepared before ` +
      'content binding; propose a new candidate and evaluate it (prepare records the SHA-256 of the materialized SKILL.md)',
    )
  }
  // 1. The newest experiment, complete.
  const [experiment] = await sources.experiments(proposal.proposalId)
  if (experiment === undefined) throw proposal.replayed === undefined ? noExperimentRefusal(proposal) : historicalReportRefusal(proposal)
  let report: ExperimentReport
  try {
    report = buildExperimentReport(experiment)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — a promotion reads a completed experiment only; ` +
      `resume experiment ${experiment.experimentId} (evolution_replay) or freeze a new one`,
    )
  }
  // 3. The report file is the report these records recompute to.
  const reportPath = experiment.report
  let content: string
  try {
    content = await readFile(resolve(sources.root, reportPath), 'utf8')
  } catch (error) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" of proposal "${proposal.proposalId}" cannot be read ` +
      `(${error instanceof Error ? error.message : String(error)}) — the ledger cites evidence the sandbox no longer holds`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  assertExperimentReport(parsed)
  if (content !== reportBytes(report)) {
    throw new Error(
      `evolution: the experiment report "${reportPath}" is not the report its ledger records recompute to — it was changed after ` +
      'the experiment (a verdict, a cost or a criterion in it is not what ran); a promotion takes evidence from the experiment\'s ' +
      'own records, never from an edited file',
    )
  }
  // 2. The frozen identities are the ones this proposal would promote.
  const frozen = report.frozen
  if (frozen.candidate.name !== candidate.name || frozen.candidate.sha256 !== candidate.sha256) {
    throw new Error(
      `evolution: the experiment froze candidate ${frozen.candidate.name}@${frozen.candidate.sha256} but proposal ` +
      `"${proposal.proposalId}" now prepares ${candidate.name}@${candidate.sha256} — the evidence belongs to different candidate ` +
      'bytes; propose a new candidate and evaluate it',
    )
  }
  const baseline = prepared?.skillBaseline
  if (baseline === undefined || frozen.productionBaseline?.name !== baseline.name
    || frozen.productionBaseline?.sha256 !== baseline.sha256) {
    throw new Error(
      `evolution: the experiment's frozen production baseline (${frozen.productionBaseline?.name ?? 'none'}@` +
      `${frozen.productionBaseline?.sha256 ?? 'none'}) is not the baseline prepare recorded for proposal "${proposal.proposalId}" ` +
      `(${baseline?.name ?? 'none'}@${baseline?.sha256 ?? 'none'}) — the candidate was evaluated against another production state`,
    )
  }
  // 4-5. Every side, and every sample's inputs and judge, re-read from the store.
  const storeId = experiment.storeId
  if (storeId === undefined) {
    throw new Error(
      `evolution: experiment "${experiment.experimentId}" records no task store, so the runs its sides cite cannot be re-read — ` +
      'run the two-sided experiment again so its evidence names the store it ran in',
    )
  }
  const snapshot = await sources.task.openStore(storeId)
  const vocabulary = await sources.verifierVocabulary()
  if (vocabulary === undefined) {
    throw new Error(
      'evolution: the verifier registry cannot be listed in this context, so the judges behind the experiment\'s verdicts cannot ' +
      'be re-checked — the promotion is refused rather than granted on unverifiable evidence',
    )
  }
  for (const sample of report.samples) {
    const frozenSample = frozenSampleOf(report, sample.taskId)
    for (const side of ['baseline', 'candidate'] as const) {
      const detail = side === 'baseline' ? sample.baseline : sample.candidate
      const label = `sample "${sample.taskId}" ${side} side`
      assertSideEvidence({ sample: frozenSample, detail, experimentId: experiment.experimentId, snapshot, where: label })
      assertJudgeUnchanged(detail, label, vocabulary)
      assertCostWithinDeclaredBudget(report, label, detail)
      if (detail.outcome === 'interrupted') continue
      if (detail.initialDigest !== frozen.snapshot.digest) {
        throw new Error(
          `evolution: the experiment report's ${label} ran from workspace digest ${detail.initialDigest}, not the frozen snapshot ` +
          `${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`,
        )
      }
    }
    await assertSampleInputsIntact({ sample: frozenSample, snapshot, productionWorkspace: frozen.snapshot.sourceDir })
  }
  // 6. The model identity the deployment resolves now.
  const currentModel = sources.modelIdentity()
  if (currentModel !== frozen.model) {
    throw new Error(
      `evolution: the experiment froze model "${frozen.model}" but this deployment resolves "${currentModel}" now — the runs on ` +
      'record were not run under the model this promotion would be judged against',
    )
  }
  // 7. The verdict.
  if (report.verdict !== 'fixed') {
    throw new Error(
      `evolution: the two-sided experiment "${experiment.experimentId}" did not show a clean fix — ` +
      `${VERDICT_REFUSALS[report.verdict]}:\n${sampleVerdictLines(report.samples).map(line => `- ${line}`).join('\n')}`,
    )
  }
  return { experimentId: experiment.experimentId, report, reportPath }
}

/** The frozen sample one report sample was compared under. */
function frozenSampleOf(report: ExperimentReport, taskId: string): FrozenSample {
  const sample = report.frozen.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`evolution: the experiment report holds no frozen sample "${taskId}"`)
  return sample
}
