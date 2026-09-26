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
 * 5. **The inputs have not drifted.** Each frozen sample's contract digest must
 *    still equal the store's contract, and each criterion's protected inputs
 *    digest and file bytes must still be the frozen ones (re-read in the
 *    production workspace the experiment froze, the same read rule the verifier
 *    uses).
 * 6. **The judge is the one the freeze pinned** (S4-E §Q3). A criterion that
 *    pinned a `verifierRef` at freeze must have been decided by that ref, at the
 *    version the registry declared *then* — a judge re-registered at another
 *    version after the freeze is refused by the frozen value, not by what the
 *    registry says now. And every reported judge must still be registered at the
 *    version it judged with.
 * 7. **The model the runs really ran under is the frozen selection** (§Q3). Every
 *    request each side's session log records — the side's own runs and every
 *    sub-execution below it — must have been made on the frozen selection: the
 *    route exactly, and the reasoning effort and output ceiling when the frozen
 *    selection declared them. A log that cannot be read, a session with no
 *    request at all (the runtime's own criteria replay, whose run record says no
 *    worker existed, is the one exemption), or one request on another route is a
 *    named refusal. The deployment's selection *now* is read as well — a
 *    deployment that moved on has to freeze a new experiment — but it is the
 *    second half of the check, never the whole of it: comparing the experiment's
 *    opening value with today's would pass a run that really went elsewhere and
 *    came back.
 * 8. **The provider identity the sides bound is the frozen one** (§Q3). Each
 *    side's run binding — its capability rows, registry revision, MCP servers,
 *    preset and resolved skills — must be the identity the freeze read from the
 *    production configuration, and the promoted skill's bytes are the one
 *    allowed difference: the baseline side's bound snapshot must hold the frozen
 *    production `SKILL.md`, the candidate side's the frozen candidate's. Apart
 *    from that difference the two sides must agree.
 * 9. **The verdict.** Only `fixed` is promotable. `fixed-with-regression`,
 *    `regressed`, `not-fixed`, `both-failed` and `inconclusive` each get their own
 *    named refusal, so "the failure is not fixed", "a holdout degraded" and "the
 *    evidence never settled" are distinguishable without reading the report.
 * 10. **The cost the frozen budget demands.** The ceiling is the *whole
 *    experiment's* (§F.2; the review rework's Q1), and it is compared with what
 *    the records actually hold, not merely read: a side whose cost is `unknown`
 *    cannot be shown to fit a declared ceiling, and a declared `maxTokens` needs
 *    every side's `tokens` four buckets (tool-call counters alone do not show
 *    tokens) and refuses a total over the ceiling even when no single side was —
 *    an overspend the orchestrator could not have seen in time is still
 *    recorded, and still refused. Equality fits. An experiment has no
 *    wall-clock ceiling to check: a Run's time is the runtime's own limit, so
 *    nothing here measures the report's timestamps. With no ceiling declared,
 *    `unknown` stays the honest observation it is and is recorded, not turned
 *    into a zero and not treated as a refusal.
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
import { join, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReviewCriterion, ReviewRecord, RunProviderBinding, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
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
  FrozenProviderIdentity,
  FrozenSample,
  ModelSelection,
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
  /**
   * The deployment's own selection now. It is the second half of the model
   * check — the first half is the runs' own requests — and a resolver that
   * cannot name a structured selection throws (fail-closed).
   */
  modelSelection(): ModelSelection
  /**
   * One session's own durable log (`sessionQuery.readSession`), or `undefined`
   * when this deployment cannot read session logs at all — the case the gate
   * reports as a named refusal instead of checking nothing (S4-E §Q3).
   */
  sessionLog(sessionId: string): Promise<readonly SessionEvent[] | undefined>
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
 * have no evidence this gate could read, so no record of one is reused to
 * promote it (§F.2: "没有支持的评估器就拒绝新晋升"). Their records stay
 * readable.
 */
export function noEvaluatorRefusal(proposal: EvolutionProposal): Error {
  return new Error(
    `evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — ` +
    'the two-sided experiment (§F.2) evaluates a replacement of an existing single-file SKILL.md only, and a promotion ' +
    'without supported evaluation evidence is refused rather than granted from an older record.',
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
}): TaskInstance | undefined {
  const { sample, detail, experimentId, snapshot, where } = input
  if (detail.outcome === 'interrupted') return undefined
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
  return task
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
 * Whether every criterion verdict a report side carries was decided by the
 * judge the frozen block fixed *before* the run (S4-E §Q3), and whether that
 * judge is still the registered instance it was.
 *
 * The frozen half: a criterion that pinned a `verifierRef` at freeze must have
 * been decided by that ref — and, when the registry declared a version then, at
 * exactly that version — so re-registering a same-named judge with a new version
 * after the freeze is a refusal that names the frozen value. A criterion that
 * pinned nothing was dispatched by mode, which the frozen block says; there the
 * run's own verdicts name the judge, and the registry half below re-checks it.
 * Fail-closed: a deployment that cannot list its verifier vocabulary refuses
 * rather than assuming the judge is there.
 */
function assertJudgeUnchanged(
  sample: FrozenSample,
  detail: ExperimentSideDetail,
  where: string,
  vocabulary: VerifierVocabulary,
): void {
  const frozenById = new Map(sample.criteria.map(criterion => [criterion.criterionId, criterion]))
  for (const criterion of detail.criteria) {
    const frozen = frozenById.get(criterion.criterionId)
    if (frozen === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" of sample "${sample.taskId}", ` +
        'which the frozen block does not carry — a verdict outside the frozen acceptance is not evidence this promotion may read',
      )
    }
    if (criterion.verifierId === undefined) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that ` +
        'decided it — a verdict nobody can be recalled against is not evidence a promotion may read',
      )
    }
    if (frozen.verifierRef !== null && criterion.verifierId !== frozen.verifierRef) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by verifier ` +
        `"${criterion.verifierId}", but the frozen block pinned "${frozen.verifierRef}" (${frozen.verifierAnchor}) — the verdicts a ` +
        'promotion reads must be the ones the frozen judge produced',
      )
    }
    if (frozen.verifierRef !== null && criterion.verifierVersion !== frozen.verifierVersion) {
      throw new Error(
        `evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by "${frozen.verifierRef}" ` +
        `at version ${criterion.verifierVersion === undefined ? '(none declared)' : criterion.verifierVersion}, but the block froze it ` +
        `at ${frozen.verifierVersion === undefined ? '(no version declared)' : frozen.verifierVersion} (${frozen.verifierAnchor}) — ` +
        'a verdict belongs to the instance that judged, so a judge that moved since the freeze invalidates the evidence',
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

/** One `request/header` event's call configuration, as the request identity it is. */
interface RequestIdentity {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

/**
 * Every request identity one session's own log records, in order: one entry per
 * `request/header` event, read from the event data the live loop appended (its
 * canonical header, not a summary). A session with no such event is reported as
 * an empty list — the caller decides whether that is the no-worker exemption or
 * a refusal, and this function never invents an identity.
 */
function requestIdentities(events: readonly SessionEvent[]): RequestIdentity[] {
  const identities: RequestIdentity[] = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown; maxTokens?: unknown } } })
      .header?.config
    if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') continue
    identities.push({
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    })
  }
  return identities
}

/** Whether one request identity is the frozen selection: the route exactly, and each declared option exactly. */
function requestMatchesSelection(identity: RequestIdentity, selection: ModelSelection): boolean {
  if (identity.provider !== selection.provider || identity.model !== selection.model) return false
  if (selection.reasoningEffort !== undefined && identity.reasoningEffort !== selection.reasoningEffort) return false
  if (selection.maxTokens !== undefined && identity.maxTokens !== selection.maxTokens) return false
  return true
}

/**
 * Whether one run is the runtime's own no-worker criteria replay — the one
 * recorded shape with no model path at all (`spawn: false`: the run is born
 * `submitted` with a runtime-origin submission, and no worker ever existed to
 * make a request). This is the *only* exemption from the model check, and it is
 * read from the run's own record rather than assumed from an empty log.
 */
function isNoWorkerRun(run: TaskRun): boolean {
  return run.executionPhase === 'submitted' && run.submission?.origin === 'runtime'
}

/** The side's task and every task below it — the subtree whose runs are this side's execution. */
function subtreeOf(snapshot: TaskSnapshot, rootTaskId: string): TaskInstance[] {
  const tasks = new Map(snapshot.tasks.map(task => [task.taskId, task]))
  const root = tasks.get(rootTaskId)
  if (root === undefined) return []
  const found: TaskInstance[] = []
  const pending = [root]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const task = pending.pop() as TaskInstance
    if (seen.has(task.taskId)) continue
    seen.add(task.taskId)
    found.push(task)
    for (const child of snapshot.tasks) if (child.parentTaskId === task.taskId) pending.push(child)
  }
  return found
}

/**
 * The model half of the gate (S4-E §Q3): what the side's runs *really* went
 * through, re-read from the durable session logs of the side's task and every
 * sub-execution below it.
 *
 * Every run of the subtree that had a worker must have a readable session log,
 * and every request it recorded must have been made on the frozen selection —
 * the route exactly, and the reasoning effort / output ceiling when the frozen
 * selection declared them. A log that cannot be read, a session with no request
 * at all, or one request on another route is a named refusal: a run whose
 * identity cannot be proved is not a side this promotion may read, and the one
 * exemption is the runtime's own criteria replay, whose run record says no
 * worker ever existed.
 *
 * This is deliberately *not* a comparison of the experiment's start value with
 * today's value: the deployment's selection may move and move back without ever
 * touching these requests, and a run that really went through another route is
 * caught here whatever the deployment resolves now.
 */
async function assertSideModelBinding(input: {
  sources: SkillPromotionSources
  detail: ExperimentSideDetail
  task: TaskInstance | undefined
  snapshot: TaskSnapshot
  selection: ModelSelection
  where: string
}): Promise<void> {
  const { sources, detail, task, snapshot, selection, where } = input
  if (detail.outcome === 'interrupted' || task === undefined) return
  const runs: TaskRun[] = []
  for (const subtreeTask of subtreeOf(snapshot, task.taskId)) {
    for (const runId of subtreeTask.runIds) {
      const run = snapshot.runs.find(item => item.runId === runId)
      if (run === undefined) {
        throw new Error(
          `evolution: the experiment report's ${where} names task "${subtreeTask.taskId}" of this experiment, but the store holds ` +
          `no run "${runId}" of it — the execution this side rests on cannot be re-read`,
        )
      }
      runs.push(run)
    }
  }
  for (const run of runs) {
    if (isNoWorkerRun(run)) continue
    let events: readonly SessionEvent[] | undefined
    try {
      events = await sources.sessionLog(run.sessionId)
    } catch (error) {
      throw new Error(
        `evolution: the session log of run "${run.runId}" (session "${run.sessionId}") of the ${where} cannot be read ` +
        `(${error instanceof Error ? error.message : String(error)}) — the requests that run really made are the evidence this ` +
        'promotion compares against the frozen selection, so a run whose log is gone cannot be promoted on',
      )
    }
    if (events === undefined) {
      throw new Error(
        `evolution: this deployment cannot read session logs (sessionQuery.readSession is unavailable), so the requests of run ` +
        `"${run.runId}" of the ${where} cannot be compared against the frozen model selection "${selection.label}" — the promotion ` +
        'is refused rather than granted on an unverifiable model binding',
      )
    }
    const identities = requestIdentities(events)
    if (identities.length === 0) {
      throw new Error(
        `evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} recorded no request at all, so the frozen model ` +
        `selection "${selection.label}" cannot be shown to be what it ran under — a run with no request identity to check is refused ` +
        '(the runtime\'s own criteria replay, the one no-worker path, is exempt; this run records a worker)',
      )
    }
    for (const identity of identities) {
      if (requestMatchesSelection(identity, selection)) continue
      throw new Error(
        `evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} really made its requests on ` +
        `${identity.provider}/${identity.model}${identity.reasoningEffort === undefined ? '' : ` (effort ${identity.reasoningEffort})`}` +
        `${identity.maxTokens === undefined ? '' : ` (maxTokens ${identity.maxTokens})`}, not on the frozen selection ` +
        `"${selection.label}"${selection.reasoningEffort === undefined ? '' : ` (effort ${selection.reasoningEffort})`}` +
        `${selection.maxTokens === undefined ? '' : ` (maxTokens ${selection.maxTokens})`} — the runs a promotion reads must be the ` +
        'runs the frozen selection was fixed for',
      )
    }
  }
}

/**
 * Whether one side's run binding is the provider identity the experiment froze
 * for the sample (S4-E §Q3): the capability rows, the registry revision, the MCP
 * servers (with a resolved template each) and every resolved skill's identity.
 *
 * The promoted skill's *content* is the one difference the frozen block allows,
 * and it is checked against the bytes the run actually bound: the side's
 * snapshot must hold the frozen `SKILL.md` — the production baseline's bytes for
 * the baseline side, the candidate's for the candidate side.
 */
async function assertSideProviderBinding(input: {
  sample: FrozenSample
  detail: ExperimentSideDetail
  run: TaskRun
  frozen: ExperimentReport['frozen']
  where: string
}): Promise<void> {
  const { sample, detail, run, frozen, where } = input
  if (detail.outcome === 'interrupted') return
  const expected: FrozenProviderIdentity = sample.provider
  const binding: RunProviderBinding | undefined = run.providerBinding
  if (binding === undefined) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} records no provider binding — which rows, servers and skills it resolved ` +
      'against cannot be re-read, so the frozen provider identity cannot be compared and the promotion is refused',
    )
  }
  const rows = [...binding.capabilities].sort()
  if (rows.join(', ') !== [...expected.capabilities].sort().join(', ')) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound capabilities [${rows.join(', ') || 'none'}] but the experiment froze ` +
      `[${expected.capabilities.join(', ') || 'none'}] — the rows this side ran under are not the frozen production configuration's`,
    )
  }
  if (binding.registryRevision !== expected.registryRevision) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ` +
      `${expected.registryRevision} — a capability row, a tool label or a declared provider contract moved since the freeze, so the ` +
      'side did not run under the frozen production configuration',
    )
  }
  const servers = [...binding.mcpServers].map(server => server.serverName).sort()
  if (servers.join(', ') !== [...expected.mcpServers].sort().join(', ')) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} bound MCP servers [${servers.join(', ') || 'none'}] but the experiment froze ` +
      `[${expected.mcpServers.join(', ') || 'none'}] — the granted server plane moved since the freeze`,
    )
  }
  for (const server of binding.mcpServers) {
    if (server.templateDigest === null) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound MCP server "${server.serverName}" with no resolvable template — the run ` +
        'recorded no identity for the server it was granted, so the frozen server plane cannot be compared',
      )
    }
  }
  if (expected.preset !== null && run.agentPreset !== expected.preset) {
    throw new Error(
      `evolution: run "${run.runId}" of the ${where} ran under agent preset ${run.agentPreset === undefined ? '(none)' : `"${run.agentPreset}"`}, ` +
      `but the frozen provider identity declares "${expected.preset}" — the preset plane this side ran under is not the frozen one`,
    )
  }
  const frozenSkills = new Map(expected.skills.map(skill => [skill.name, skill]))
  const boundSkills = new Map(binding.skills.map(skill => [skill.name, skill]))
  for (const name of boundSkills.keys()) {
    if (!frozenSkills.has(name)) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}", which the frozen production configuration does not ` +
        `resolve (frozen: ${expected.skills.map(skill => skill.name).join(', ') || 'none'}) — content the freeze never admitted reached this run`,
      )
    }
  }
  for (const [name, expectedSkill] of frozenSkills) {
    const bound = boundSkills.get(name)
    if (bound === undefined) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound no skill "${name}", which the frozen production configuration resolves ` +
        '— the run under this side did not load content the freeze named',
      )
    }
    if (bound.role !== expectedSkill.role || (bound.contractDigest ?? null) !== expectedSkill.contractDigest) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role}` +
        `${bound.contractDigest === null ? '' : ` (contract ${bound.contractDigest})`}, but the frozen identity is ` +
        `${expectedSkill.role}${expectedSkill.contractDigest === null ? '' : ` (contract ${expectedSkill.contractDigest})`} — the ` +
        'provider this side loaded is not the one the experiment froze',
      )
    }
    if (name === frozen.candidate.name) {
      // The promoted skill's own content is the one difference the frozen block
      // allows: the baseline side must bind exactly the production identity the
      // freeze read, and the candidate side's bytes are read off its snapshot
      // below (the candidate's content is not the production content, so its
      // recorded digest is not compared to the frozen one).
      if (detail.side === 'baseline' && bound.contentDigest !== expectedSkill.contentDigest) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production ` +
          `configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`,
        )
      }
      continue
    }
    if (bound.contentDigest !== expectedSkill.contentDigest) {
      throw new Error(
        `evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production ` +
        `configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`,
      )
    }
  }
  // The promoted skill's own bytes: read from the snapshot the run bound, so the
  // check is against what the run really loaded, not against what it recorded.
  const target = boundSkills.get(frozen.candidate.name)
  if (target !== undefined) {
    const expectedBytes = detail.side === 'candidate'
      ? frozen.candidate.sha256
      : frozen.productionBaseline?.sha256
    if (expectedBytes !== undefined) {
      if (binding.snapshotRoot === undefined) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" but records no snapshot root — ` +
          'the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared',
        )
      }
      let bytes: Buffer
      try {
        bytes = await readFile(join(binding.snapshotRoot, frozen.candidate.name, 'SKILL.md'))
      } catch (error) {
        throw new Error(
          `evolution: the content run "${run.runId}" of the ${where} was bound to cannot be read ` +
          `(${error instanceof Error ? error.message : String(error)}) — the promoted skill's frozen bytes cannot be re-proved, so ` +
          'the promotion is refused',
        )
      }
      const digest = sha256Hex(bytes)
      if (digest !== expectedBytes) {
        throw new Error(
          `evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" whose SKILL.md hashes to ${digest}, ` +
          `but the experiment froze ${expectedBytes} for the ${detail.side} side — the bytes this side ran are not the frozen ones`,
        )
      }
      if (detail.side === 'candidate' && digest === frozen.productionBaseline?.sha256) {
        throw new Error(
          `evolution: the candidate side of the ${where} loaded the production bytes ("${frozen.candidate.name}" hashes to ` +
          `${digest}, the frozen production baseline) — the candidate was never really run, so the comparison proves nothing`,
        )
      }
    }
  }
}

/**
 * Whether the two sides' bindings agree everywhere the frozen block allows
 * agreement and nowhere else (S4-E §Q3): every field of the run binding and the
 * run's preset must match between the baseline and the candidate side, except
 * the promoted skill's own content digest — the one difference the experiment's
 * overlay is supposed to produce.
 */
function assertSidesAgree(
  frozen: ExperimentReport['frozen'],
  baseline: { run: TaskRun; binding: RunProviderBinding },
  candidate: { run: TaskRun; binding: RunProviderBinding },
  where: string,
): void {
  const comparable = (binding: RunProviderBinding) => ({
    capabilities: [...binding.capabilities].sort(),
    registryRevision: binding.registryRevision,
    mcpServers: [...binding.mcpServers].sort((left, right) => (left.serverName < right.serverName ? -1 : left.serverName > right.serverName ? 1 : 0)),
    skills: [...binding.skills]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(skill => ({
        name: skill.name,
        role: skill.role,
        contractDigest: skill.contractDigest ?? null,
        ...(skill.name === frozen.candidate.name ? {} : { contentDigest: skill.contentDigest }),
      })),
  })
  const left = JSON.stringify(comparable(baseline.binding))
  const right = JSON.stringify(comparable(candidate.binding))
  if (left !== right) {
    throw new Error(
      `evolution: the two sides of ${where} did not bind the same provider identity — apart from the promoted skill's own content, ` +
      `which the candidate overlay is what changes, every field must agree:\n- baseline: ${left}\n- candidate: ${right}`,
    )
  }
  if (baseline.run.agentPreset !== candidate.run.agentPreset) {
    throw new Error(
      `evolution: the two sides of ${where} ran under different agent presets ` +
      `(${baseline.run.agentPreset === undefined ? '(none)' : `"${baseline.run.agentPreset}"`} vs ` +
      `${candidate.run.agentPreset === undefined ? '(none)' : `"${candidate.run.agentPreset}"`}) — a preset that moved between the ` +
      'sides is not the frozen execution',
    )
  }
}

/**
 * Whether one side's cost is known enough for a frozen budget that declares a
 * ceiling — the per-side half of the rule (S4-E §F.2; Q1 of the progress
 * review: the ceiling bounds the *whole experiment*).
 *
 * A declared `maxTokens` refuses a side whose cost is `unknown` (an unknown
 * cannot be shown to fit a ceiling) and requires the run's `tokens` four
 * buckets: tool-call counters alone do not show tokens, and neither does a
 * numeric total nobody reported.
 */
function assertCostWithinDeclaredBudget(report: ExperimentReport, where: string, detail: ExperimentSideDetail): void {
  const budget = report.frozen.budget
  if (budget.maxTokens === undefined) return
  if (detail.cost.status === 'unknown') {
    throw new Error(
      `evolution: the frozen budget declares a cost ceiling (maxTokens ${budget.maxTokens}) ` +
      `and the ${where} reports no cost (${detail.cost.reason}) — an unknown cost cannot be shown to fit a ceiling the frozen ` +
      'budget set, so the promotion is refused rather than inferred',
    )
  }
  tokenTotalOf(detail, where, budget.maxTokens)
}

/**
 * The four token buckets one settled side reports, summed the way the runtime's
 * own post-hoc budget check sums them. A side without the `tokens` projection,
 * or with counters that are not four readable numbers, is refused by name
 * rather than counted as zero: an unknown is never a zero, and only a total
 * that is really readable can be compared with a ceiling.
 */
function tokenTotalOf(detail: ExperimentSideDetail, where: string, ceiling: number): number {
  const tokens = detail.cost.status === 'reported' ? detail.cost.metrics.tokens : undefined
  if (tokens === undefined || typeof tokens !== 'object') {
    throw new Error(
      `evolution: the frozen budget declares maxTokens ${ceiling} for the whole experiment, and the ${where} reports cost metrics ` +
      'without the `tokens` projection (tool-call counters alone do not show tokens) — a ceiling this side cannot be measured ' +
      'against is not evidence the promotion may read',
    )
  }
  const buckets = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  const values = buckets.map(bucket => (tokens as unknown as Record<string, unknown>)[bucket])
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(
      `evolution: the ${where} reports token usage that is not four readable counters ` +
      `(${buckets.map((bucket, index) => `${bucket}: ${String(values[index])}`).join(', ')}) — an unreadable total is not a total the ` +
      `frozen maxTokens ${ceiling} can be checked against, so the promotion is refused`,
    )
  }
  return (values as readonly number[]).reduce((sum, value) => sum + value, 0)
}

/**
 * The whole experiment's cost against the frozen budget (S4-E §F.2; Q1 of the
 * progress review): the token four buckets summed over every settled side,
 * compared with the `maxTokens` ceiling the freeze declared. Equality fits; only
 * exceeding refuses. The experiment has no wall-clock ceiling — a Run's time is
 * the runtime's own limit — so nothing here reads the report's timestamps.
 *
 * A recorded total that passed its ceiling is refused here. The orchestrator
 * stops starting sides once the total the settled ones reported has consumed
 * the ceiling, but a run's own counts are only readable once it settled, so the
 * side that crossed the ceiling stays recorded — and this half refuses to pass
 * the overspend off as a fit. With no ceiling declared, an unreadable cost stays
 * the honest observation it is: recorded, never zeroed, never a refusal.
 */
function assertExperimentCostWithinBudget(report: ExperimentReport): void {
  const budget = report.frozen.budget
  if (budget.maxTokens === undefined) return
  let spent = 0
  let sides = 0
  for (const sample of report.samples) {
    for (const detail of [sample.baseline, sample.candidate]) {
      spent += tokenTotalOf(detail, `sample "${sample.taskId}" ${detail.side} side`, budget.maxTokens)
      sides += 1
    }
  }
  if (spent > budget.maxTokens) {
    throw new Error(
      `evolution: the frozen budget declares maxTokens ${budget.maxTokens} for the whole experiment, but its ${sides} settled sides ` +
      `report ${spent} tokens together (${spent - budget.maxTokens} over the ceiling) — the budget bounds the experiment as a whole and ` +
      'not one side, and a total its own records place above the ceiling is refused rather than promoted',
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
  if (experiment === undefined) throw noExperimentRefusal(proposal)
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
    const sideRuns: Partial<Record<'baseline' | 'candidate', { run: TaskRun; binding: RunProviderBinding }>> = {}
    for (const side of ['baseline', 'candidate'] as const) {
      const detail = side === 'baseline' ? sample.baseline : sample.candidate
      const label = `sample "${sample.taskId}" ${side} side`
      const task = assertSideEvidence({ sample: frozenSample, detail, experimentId: experiment.experimentId, snapshot, where: label })
      assertJudgeUnchanged(frozenSample, detail, label, vocabulary)
      assertCostWithinDeclaredBudget(report, label, detail)
      if (detail.outcome === 'interrupted') continue
      if (detail.initialDigest !== frozen.snapshot.digest) {
        throw new Error(
          `evolution: the experiment report's ${label} ran from workspace digest ${detail.initialDigest}, not the frozen snapshot ` +
          `${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`,
        )
      }
      // 5a. What the side's runs really went through (S4-E §Q3), re-read from
      // the durable session logs of the side and its sub-executions.
      await assertSideModelBinding({ sources, detail, task, snapshot, selection: frozen.model, where: label })
      // 5b. And what they were bound to: the frozen production provider
      // identity, with the promoted skill's own bytes as the one allowed
      // difference.
      const run = detail.runId === undefined ? undefined : snapshot.runs.find(item => item.runId === detail.runId)
      if (run === undefined) {
        throw new Error(
          `evolution: the experiment report's ${label} cites run "${String(detail.runId)}", which the store no longer holds — its ` +
          'provider binding cannot be re-read, so the promotion is refused',
        )
      }
      await assertSideProviderBinding({ sample: frozenSample, detail, run, frozen, where: label })
      if (run.providerBinding !== undefined) sideRuns[side] = { run, binding: run.providerBinding }
    }
    if (sideRuns.baseline !== undefined && sideRuns.candidate !== undefined) {
      assertSidesAgree(frozen, sideRuns.baseline, sideRuns.candidate, `sample "${sample.taskId}"`)
    }
    await assertSampleInputsIntact({ sample: frozenSample, snapshot, productionWorkspace: frozen.snapshot.sourceDir })
  }
  // 6. The whole experiment's cost against the ceiling the freeze declared: the
  // totals the per-side checks above each made readable, summed over every side
  // (Q1: the budget bounds the experiment, not one side).
  assertExperimentCostWithinBudget(report)
  // 7. The model selection: the runs' own requests were checked above, and the
  // deployment's selection now is the second half — a deployment that moved on
  // since the freeze has to freeze a new experiment rather than promote this
  // one's evidence.
  const currentSelection = sources.modelSelection()
  if (currentSelection.provider !== frozen.model.provider || currentSelection.model !== frozen.model.model
    || currentSelection.reasoningEffort !== frozen.model.reasoningEffort || currentSelection.maxTokens !== frozen.model.maxTokens) {
    throw new Error(
      `evolution: the experiment froze model selection "${frozen.model.label}"` +
      `${frozen.model.reasoningEffort === undefined ? '' : ` (effort ${frozen.model.reasoningEffort})`}` +
      `${frozen.model.maxTokens === undefined ? '' : ` (maxTokens ${frozen.model.maxTokens})`}, but this deployment resolves ` +
      `"${currentSelection.label}"` +
      `${currentSelection.reasoningEffort === undefined ? '' : ` (effort ${currentSelection.reasoningEffort})`}` +
      `${currentSelection.maxTokens === undefined ? '' : ` (maxTokens ${currentSelection.maxTokens})`} now — the runs on record were ` +
      'not run under the selection this promotion would be judged against',
    )
  }
  // 8. The verdict.
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
