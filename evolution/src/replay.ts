/**
 * Report schemas (guide §2.7.6, W15; S4-E §F.2 for formatVersion 2).
 *
 * Format 1 is the candidate-vs-champion replay: the champion side is the
 * historical task's own terminal record (never re-executed), the candidate side
 * is the fresh replay run's outcome. The report lands at
 * `<ledger root>/sandbox/<proposalId>/replay-report.json` and the ledger's
 * `replayed` record cites it by that root-relative path.
 *
 * The comparison is mechanical, never a judgement: outcome ranks
 * (verified > failed), a shared criterion flipping pass → anything else is a
 * regression, and a candidate run that could not settle (cancelled) is
 * inconclusive, not worse. "Not worse" is the strongest claim this schema
 * makes; whether that suffices for promotion is the human gate's call.
 *
 * Format 2 is the two-sided skill experiment (§F.2): both sides are **new
 * runs** of the same frozen sample, each in its own workspace built from one
 * frozen input snapshot, and the historical record only locates the case
 * ({@link FrozenSample.observed}) — it is never a baseline. A v2 report carries
 * the whole frozen identity block it was run under, every side's Task/Run/
 * Review/Evidence references and costs, and a verdict that is a pure function
 * of those details ({@link compareExperimentSides} /
 * {@link overallExperimentVerdict}), so any reader can recompute it.
 * {@link assertExperimentReport} does exactly that and refuses a report whose
 * verdicts do not match its own evidence. The two formats share nothing but
 * the outcome-rank vocabulary: v1 types, assertions and readers are unchanged,
 * and {@link assertReplayPromotable} keeps refusing a v2 report (its
 * `formatVersion` is not 1) — the fail-closed middle state until the promotion
 * gate learns the new evidence.
 * @module dsh-singularity-evolution
 */

import { createHash } from 'node:crypto'
import type { ProposalTargetType, ReviewMetrics } from '@dangosys/dsh-singularity-task'

/** Overall replay verdict: whether the candidate is not worse than the champion. */
export type ReplayVerdict = 'not-worse' | 'worse' | 'inconclusive' | 'manual'
/** Per-task comparison outcome; `manual` marks the agent_preset v1 boundary (nothing executed). */
export type ReplayRelation = 'not-worse' | 'worse' | 'inconclusive' | 'manual'

export const REPLAY_VERDICTS: readonly ReplayVerdict[] = ['not-worse', 'worse', 'inconclusive', 'manual']
export const REPLAY_RELATIONS: readonly ReplayRelation[] = ['not-worse', 'worse', 'inconclusive', 'manual']

/** One criterion's verdict on one side, as the record / fresh run reported it. */
export interface ReplayCriterionSummary {
  criterionId: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  command?: string
  exitCode?: number
}

/**
 * The content identity of a single-file skill candidate (P2): the skill name
 * plus the SHA-256 of the exact bytes of the materialized `SKILL.md`. Recorded
 * at prepare, carried by the replay report, and re-verified before the
 * `replayed` record is written, at every promotion gate, and on the apply
 * write — so the chain can never validate one file's content and apply
 * another's. Only `targetType: skill` candidates carry one.
 */
export interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string
}

/** One side of one task's comparison. The champion is the historical record; the candidate is the fresh replay run. */
export interface ReplaySideSummary {
  taskId: string
  runId?: string
  outcome: 'verified' | 'failed' | 'cancelled'
  durationMs?: number
  criteria: ReplayCriterionSummary[]
}

/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
export interface ReplayCriterionDiff {
  criterionId: string
  champion?: string
  candidate?: string
}

export interface ReplayTaskComparison {
  /** The champion (historical) task id. */
  taskId: string
  /** The replay task created for the candidate run. */
  candidateTaskId?: string
  champion: ReplaySideSummary
  candidate?: ReplaySideSummary
  /** True when outcome and every shared criterion verdict agree and no criterion moved between the sides. */
  verdictMatch: boolean
  /** Criterion-level differences (both verdict flips and added/removed criteria). */
  criteriaDiff: ReplayCriterionDiff[]
  relation: ReplayRelation
}

export interface ReplayReport {
  formatVersion: 1
  proposalId: string
  targetType: ProposalTargetType
  at: string
  /** `executed`: candidate runs really ran. `manual`: nothing executed (agent_preset v1) and `manualReason` says why. */
  mode: 'executed' | 'manual'
  manualReason?: string
  /**
   * Skill candidates only (P2): the candidate content identity this replay ran
   * against — it must equal the `prepared` record's `skillContent`. Other
   * targetTypes carry no skill fields.
   */
  candidateContent?: SkillContentIdentity
  /** Comparisons over `taskIds` (the tasks the proposal's evidence already covers). */
  observed: ReplayTaskComparison[]
  /** Comparisons over `holdoutTaskIds`; `executed: false` + empty tasks reads as "not run". */
  holdout: { executed: boolean; tasks: ReplayTaskComparison[] }
  verdict: ReplayVerdict
}

/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
const OUTCOME_RANK: Readonly<Record<string, number>> = { verified: 1, failed: 0 }

/**
 * Compare one task's two sides. A regression is mechanical: the candidate's
 * outcome ranks below the champion's, or a criterion both sides report flipped
 * from pass to anything else. An unrankable candidate outcome (cancelled) is
 * inconclusive — it says nothing about the candidate's quality.
 */
export function compareReplaySides(
  champion: ReplaySideSummary,
  candidate: ReplaySideSummary,
): Pick<ReplayTaskComparison, 'verdictMatch' | 'criteriaDiff' | 'relation'> {
  const championCriteria = new Map(champion.criteria.map(item => [item.criterionId, item.verdict]))
  const candidateCriteria = new Map(candidate.criteria.map(item => [item.criterionId, item.verdict]))
  const criteriaDiff: ReplayCriterionDiff[] = []
  for (const criterionId of new Set([...championCriteria.keys(), ...candidateCriteria.keys()])) {
    const before = championCriteria.get(criterionId)
    const after = candidateCriteria.get(criterionId)
    if (before !== after) {
      criteriaDiff.push({
        criterionId,
        ...(before === undefined ? {} : { champion: before }),
        ...(after === undefined ? {} : { candidate: after }),
      })
    }
  }
  const verdictMatch = champion.outcome === candidate.outcome && criteriaDiff.length === 0
  const championRank = OUTCOME_RANK[champion.outcome]
  const candidateRank = OUTCOME_RANK[candidate.outcome]
  if (candidateRank === undefined || championRank === undefined) {
    return { verdictMatch, criteriaDiff, relation: 'inconclusive' }
  }
  const regressedCriterion = criteriaDiff.some(diff => diff.champion === 'pass')
  const changedContract = criteriaDiff.some(diff => diff.champion === undefined || diff.candidate === undefined)
    || champion.criteria.some(before => candidate.criteria.find(after => after.criterionId === before.criterionId)?.command !== before.command)
  const relation: ReplayRelation = candidateRank < championRank || regressedCriterion
    ? 'worse'
    : changedContract ? 'inconclusive' : 'not-worse'
  return { verdictMatch, criteriaDiff, relation }
}

/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
export function overallReplayVerdict(comparisons: readonly Pick<ReplayTaskComparison, 'relation'>[]): ReplayVerdict {
  if (comparisons.some(item => item.relation === 'worse')) return 'worse'
  if (comparisons.length === 0 || comparisons.some(item => item.relation === 'inconclusive')) return 'inconclusive'
  if (comparisons.every(item => item.relation === 'manual')) return 'manual'
  if (comparisons.some(item => item.relation === 'manual')) return 'inconclusive'
  return 'not-worse'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertSide(value: unknown, field: string): asserts value is ReplaySideSummary {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0
    || !['verified', 'failed', 'cancelled'].includes(value.outcome as string)
    || !Array.isArray(value.criteria)) {
    throw new Error(`evolution: replay report ${field} must carry a taskId, a valid outcome and criteria`)
  }
  const ids = new Set<string>()
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || typeof criterion.criterionId !== 'string' || criterion.criterionId.length === 0
      || ids.has(criterion.criterionId) || !['pass', 'fail', 'inconclusive'].includes(criterion.verdict as string)
      || (criterion.command !== undefined && typeof criterion.command !== 'string')) {
      throw new Error(`evolution: replay report ${field} has an invalid or duplicate criterion`)
    }
    ids.add(criterion.criterionId)
  }
  if (value.outcome === 'verified' && ids.size === 0) {
    throw new Error(`evolution: replay report ${field} verified outcome needs criterion evidence`)
  }
}

function assertComparison(value: unknown, field: string, mode: 'executed' | 'manual'): asserts value is ReplayTaskComparison {
  if (!isRecord(value)) throw new Error(`evolution: replay report ${field} must be an object`)
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: replay report ${field}.taskId must be a non-empty string`)
  }
  if (!isRecord(value.champion) || typeof value.champion.outcome !== 'string') {
    throw new Error(`evolution: replay report ${field}.champion must carry an outcome`)
  }
  if (typeof value.relation !== 'string' || !REPLAY_RELATIONS.includes(value.relation as ReplayRelation)) {
    throw new Error(`evolution: replay report ${field}.relation must be one of ${REPLAY_RELATIONS.join(' / ')}`)
  }
  assertSide(value.champion, `${field}.champion`)
  if (value.taskId !== value.champion.taskId) throw new Error(`evolution: replay report ${field} champion identity mismatch`)
  if (mode === 'manual') {
    if (value.relation !== 'manual' || value.candidate !== undefined) {
      throw new Error(`evolution: replay report ${field} manual comparison cannot claim an executed candidate`)
    }
    return
  }
  assertSide(value.candidate, `${field}.candidate`)
  if (value.candidateTaskId !== value.candidate.taskId || value.candidate.taskId === value.taskId) {
    throw new Error(`evolution: replay report ${field} candidate identity mismatch`)
  }
  const computed = compareReplaySides(value.champion, value.candidate)
  if (value.relation !== computed.relation || value.verdictMatch !== computed.verdictMatch
    || JSON.stringify(value.criteriaDiff) !== JSON.stringify(computed.criteriaDiff)) {
    throw new Error(`evolution: replay report ${field} comparison does not match its evidence`)
  }
}

/**
 * Validate a report against the proposal it claims to serve. The v1 manual
 * boundary is enforced here: only an agent_preset replay may record
 * `mode: 'manual'` (the preset roster scans constructor-fixed roots and cannot
 * mount a sandbox-materialized preset), and only a manual report may carry the
 * `manual` verdict — every other targetType must produce executed evidence.
 * A skill report must additionally carry the candidate content identity
 * (`candidateContent`) the replay ran against; equality with the prepared
 * record is the service's check, not this schema's.
 */
export function assertReplayReport(
  proposal: { proposalId: string; targetType: ProposalTargetType },
  report: unknown,
): asserts report is ReplayReport {
  if (!isRecord(report)) throw new Error('evolution: replay report must be an object')
  if (report.formatVersion !== 1) throw new Error('evolution: replay report formatVersion must be 1')
  if (report.proposalId !== proposal.proposalId) {
    throw new Error(`evolution: replay report proposalId "${String(report.proposalId)}" does not match "${proposal.proposalId}"`)
  }
  if (report.targetType !== proposal.targetType) {
    throw new Error(`evolution: replay report targetType "${String(report.targetType)}" does not match "${proposal.targetType}"`)
  }
  if (typeof report.at !== 'string' || report.at.length === 0) throw new Error('evolution: replay report.at must be a non-empty string')
  if (report.mode !== 'executed' && report.mode !== 'manual') {
    throw new Error('evolution: replay report mode must be "executed" or "manual"')
  }
  if (report.mode === 'manual') {
    if (proposal.targetType !== 'agent_preset') {
      throw new Error(`evolution: a manual replay report is only valid for agent_preset proposals, not "${proposal.targetType}"`)
    }
    if (typeof report.manualReason !== 'string' || report.manualReason.length === 0) {
      throw new Error('evolution: a manual replay report requires a manualReason')
    }
  }
  if (typeof report.verdict !== 'string' || !REPLAY_VERDICTS.includes(report.verdict as ReplayVerdict)) {
    throw new Error(`evolution: replay report verdict must be one of ${REPLAY_VERDICTS.join(' / ')}`)
  }
  if (report.mode === 'manual' && report.verdict !== 'manual') {
    throw new Error('evolution: a manual replay report must carry verdict "manual"')
  }
  if (report.mode === 'executed' && report.verdict === 'manual') {
    throw new Error('evolution: an executed replay report cannot carry verdict "manual"')
  }
  if (!Array.isArray(report.observed)) throw new Error('evolution: replay report.observed must be an array')
  report.observed.forEach((item, index) => assertComparison(item, `observed[${index}]`, report.mode as 'executed' | 'manual'))
  if (!isRecord(report.holdout) || typeof report.holdout.executed !== 'boolean' || !Array.isArray(report.holdout.tasks)) {
    throw new Error('evolution: replay report.holdout must be { executed: boolean, tasks: [] }')
  }
  report.holdout.tasks.forEach((item, index) => assertComparison(item, `holdout.tasks[${index}]`, report.mode as 'executed' | 'manual'))
  if (report.holdout.executed !== (report.holdout.tasks.length > 0)) {
    throw new Error('evolution: replay report.holdout.executed must agree with its task list (empty = not run)')
  }
  if (report.mode === 'executed' && report.observed.length === 0) {
    throw new Error('evolution: an executed replay report needs at least one observed task comparison')
  }
  const comparisons = [...report.observed, ...report.holdout.tasks] as ReplayTaskComparison[]
  const taskIds = comparisons.map(item => item.taskId)
  const candidateIds = comparisons.flatMap(item => item.candidate === undefined ? [] : [item.candidate.taskId])
  if (new Set(taskIds).size !== taskIds.length || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some(id => taskIds.includes(id))) {
    throw new Error('evolution: replay report observed and holdout must use distinct champion and candidate tasks')
  }
  if (report.mode === 'executed' && report.verdict !== overallReplayVerdict(comparisons)) {
    throw new Error('evolution: replay report verdict does not match its comparisons')
  }
  // P2 content binding: a skill report must name the candidate content
  // identity it ran against (the service then checks it against the prepared
  // record and the live file). Last, so the schema checks above keep their
  // specific diagnostics.
  if (proposal.targetType === 'skill') {
    const identity = report.candidateContent
    if (!isRecord(identity) || typeof identity.name !== 'string' || identity.name.length === 0
      || typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
      throw new Error(
        'evolution: a skill replay report must carry candidateContent { name, sha256 } bound at prepare — ' +
        'evidence without the candidate content identity predates content binding; propose a new candidate and re-evaluate it',
      )
    }
  }
}

/** A human approval cannot substitute for two independent, non-regressing replay groups. */
export function assertReplayPromotable(report: ReplayReport): void {
  if (report.mode !== 'executed') throw new Error('evolution: promotion requires executed replay evidence, not a manual report')
  for (const [name, tasks] of [['observed', report.observed], ['holdout', report.holdout.tasks]] as const) {
    if (overallReplayVerdict(tasks) !== 'not-worse') {
      throw new Error(`evolution: promotion requires non-empty ${name} replay with no regressions or inconclusive results`)
    }
  }
}

/* -------------------------------------------------------------------------- *
 * formatVersion 2: the two-sided skill experiment report (§F.2)
 *
 * Nothing above this line changes for it. A v2 report is a different artifact:
 * one comparison per frozen sample, both sides new runs, all of it under the
 * frozen identity block that was fixed before the first run. `assertReplayReport`
 * and `ReplayReport` keep their v1 shape and keep refusing it (`formatVersion`
 * is 2, not 1).
 * -------------------------------------------------------------------------- */

/**
 * The comparer a v2 report names, and the only one this build can re-check:
 * the verdict rules of {@link compareExperimentSides} and
 * {@link overallExperimentVerdict}. A report naming anything else is refused
 * by {@link assertExperimentReport} instead of being re-derived with rules this
 * build does not have.
 */
export const EXPERIMENT_COMPARER_VERSION = 'experiment-comparer@2'

/**
 * Why a sample is in the experiment:
 * - `observed-failure` — the case the candidate is supposed to fix; its
 *   historical record must be `failed`, and its baseline run must reproduce
 *   that failure for a fix to be claimable.
 * - `observed-regression` — a case the proposal's evidence already covers and
 *   that must keep passing: its historical record is `verified`, so this run's
 *   baseline must reproduce that pass before the candidate can be compared
 *   against it.
 * - `holdout` — a case the candidate was not selected on; it must not degrade,
 *   and like a regression sample it is only readable when this run reproduced
 *   its historical pass.
 * At least one `observed-failure` and one `holdout` are required (§F.2).
 */
export type ExperimentSampleRole = 'observed-failure' | 'observed-regression' | 'holdout'
export const EXPERIMENT_SAMPLE_ROLES: readonly ExperimentSampleRole[] = ['observed-failure', 'observed-regression', 'holdout']

/** Which side of one sample's comparison a run is: the frozen baseline, or the candidate. */
export type ExperimentSide = 'baseline' | 'candidate'
export const EXPERIMENT_SIDES: readonly ExperimentSide[] = ['baseline', 'candidate']

/**
 * A side's settled outcome. `cancelled` is the runtime's own settlement of a
 * run that was stopped; `interrupted` is this plane's record of a side whose
 * run never reached a terminal state (a process that died mid-run, a run the
 * store no longer holds) — it says nothing about the candidate, so every
 * verdict over it is `inconclusive`.
 */
export type ExperimentOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted'
export const EXPERIMENT_OUTCOMES: readonly ExperimentOutcome[] = ['verified', 'failed', 'cancelled', 'interrupted']

/**
 * One sample's mechanical verdict (§F.2):
 * - `fixed` — the baseline reproduced the historical failure and the candidate
 *   passed, with no criterion moving under it.
 * - `both-failed` — both sides failed: the failure is reproducible *and* not
 *   fixed. The distinguishable sub-case of `not-fixed`.
 * - `not-fixed` — the candidate did not pass where the baseline failed, or the
 *   baseline did not fail at all (nothing was reproduced to fix).
 * - `maintained` — a regression/holdout sample whose baseline *verified* and
 *   whose candidate is not worse than it.
 * - `regressed` — a regression/holdout sample whose baseline *verified* and
 *   whose candidate is worse.
 * - `inconclusive` — a side that could not settle, a comparison whose two
 *   contracts differ, or a regression/holdout sample whose baseline did not
 *   reproduce the historical pass; it says nothing about the candidate.
 */
export type ExperimentSampleVerdict = 'fixed' | 'both-failed' | 'not-fixed' | 'maintained' | 'regressed' | 'inconclusive'
export const EXPERIMENT_SAMPLE_VERDICTS: readonly ExperimentSampleVerdict[] = [
  'fixed', 'both-failed', 'not-fixed', 'maintained', 'regressed', 'inconclusive',
]

/**
 * The experiment's overall verdict — the six mechanically distinguishable
 * situations §F.2 names, in the order {@link overallExperimentVerdict} decides
 * them: `inconclusive` (evidence that could not settle), `both-failed`
 * (reproduced and unfixed), `regressed` (unfixed and something else got worse),
 * `not-fixed` (unfixed, nothing worse), `fixed-with-regression` (the failure is
 * fixed but a regression or holdout sample degraded), `fixed` (clean:
 * every failure sample fixed, every regression/holdout sample maintained).
 */
export type ExperimentVerdict = 'fixed' | 'fixed-with-regression' | 'not-fixed' | 'both-failed' | 'regressed' | 'inconclusive'
export const EXPERIMENT_VERDICTS: readonly ExperimentVerdict[] = [
  'fixed', 'fixed-with-regression', 'not-fixed', 'both-failed', 'regressed', 'inconclusive',
]

/**
 * The run-level budget the caller freezes with the experiment (§F.2: samples,
 * inputs, judge, model/tools, budget and comparison rules are frozen before the
 * run). Recorded verbatim in the frozen block, the ledger and the report.
 *
 * This plane enforces none of it, and says so rather than implying otherwise:
 * `ReplayTaskOptions` carries no run-level budget, so there is no limit here to
 * pass through, and the budget a tree actually spends belongs to the runtime's
 * own root budget, measured where the runs are. A gate may read these numbers
 * as the frozen intent they are — never as a spent amount.
 */
export interface ExperimentBudget {
  /** Wall-clock ceiling for the whole experiment, in milliseconds. */
  wallTimeMs?: number
  /** Token ceiling for the whole experiment. */
  maxTokens?: number
  /** Free text: what the budget was derived from and why it is judged enough. */
  note?: string
}

/**
 * What one side cost, as the run's own ReviewRecord reported it.
 *
 * `unknown` is a first-class answer, never a zero: a record without metrics (a
 * deployment that exposes no projection, a run that never wrote a review) is
 * reported as unknown with its reason, because "no cost reported" and "zero
 * cost" are different facts and only one of them is true. `reported` carries
 * the metrics verbatim — this schema never re-derives or rounds them.
 */
export type ExperimentCost =
  | { status: 'reported'; metrics: ReviewMetrics }
  | { status: 'unknown'; reason: string }

/** One criterion's verdict on one side, with the verifier that decided it (v1's report dropped the verifier identity; v2 keeps it). */
export interface ExperimentCriterionDetail {
  criterionId: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  /** The registered verifier that decided the verdict, copied from the run's ReviewRecord. */
  verifierId?: string
  /** The deciding instance's version, when it declared one. */
  verifierVersion?: string
  command?: string
  exitCode?: number
}

/**
 * One side of one sample's comparison: this experiment's own run of that
 * sample. Every identity here is the durable one — the replayed task, the run,
 * the terminal review record, the evidence it carries, and the workspace built
 * from the frozen snapshot with the digest taken before the run wrote in it.
 */
export interface ExperimentSideDetail {
  /** The replayed task this side created — never the sample's historical task. Absent for a side whose run never reached the store. */
  taskId?: string
  role: ExperimentSampleRole
  side: ExperimentSide
  outcome: ExperimentOutcome
  /** The run this side created. Absent when no run reached the store. */
  runId?: string
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string
  /** Evidence ids the run's review record carries. */
  evidenceRefs: string[]
  /** The workspace this side's run went through, as the runtime resolved it. */
  workspace: string
  /**
   * SHA-256 of the workspace's content right after it was built from the frozen
   * snapshot — equal to the snapshot digest, which is what makes the side's
   * input the frozen one. Absent only for an `interrupted` side whose workspace
   * cannot be re-proved (`reason` says why).
   */
  initialDigest?: string
  criteria: ExperimentCriterionDetail[]
  cost: ExperimentCost
  /** Why this side has no terminal run; required for `interrupted`, absent otherwise. */
  reason?: string
}

/** One sample's comparison: both sides, and the mechanical verdict over them. */
export interface ExperimentSampleComparison {
  /** The sample's historical task id — the case, not a baseline. */
  taskId: string
  role: ExperimentSampleRole
  baseline: ExperimentSideDetail
  candidate: ExperimentSideDetail
  verdict: ExperimentSampleVerdict
}

/** One criterion's frozen identity: the acceptance condition as the sample's own contract holds it. */
export interface FrozenCriterion {
  criterionId: string
  verificationMode: string
  command?: string
  /** SHA-256 over the criterion's protected input identities (`<path>\0<sha256>` lines, sorted); the empty list hashes too. */
  protectedInputsDigest: string
}

/**
 * One sample's frozen identity: the case it locates, and the acceptance
 * identity the replay will mirror into both sides. `observed` is the historical
 * record the sample was chosen for — it locates the case and is *not* a
 * baseline: every report side must cite a different run.
 */
export interface FrozenSample {
  taskId: string
  role: ExperimentSampleRole
  /** SHA-256 over the sample's contract as the replay mirrors it (objective, criteria, required capabilities). */
  contractDigest: string
  criteria: FrozenCriterion[]
  observed: { outcome: 'verified' | 'failed'; runId?: string }
}

/**
 * The identity block fixed before the first run (§F.2). Everything a reader
 * needs to say *what* was compared: the candidate's exact bytes, the input
 * snapshot both workspaces were built from, the samples and their acceptance
 * identity, the model identity the caller froze, the budget, the overlay each
 * side ran under, and the comparer that judged. {@link frozenDigestOf} is the
 * digest of this whole block, so a report and a ledger record name the same
 * frozen experiment only if every one of these fields agrees.
 */
export interface FrozenExperiment {
  proposalId: string
  /**
   * The repetition index this experiment froze. A higher index is a *different*
   * frozen experiment (§F.2: only an explicit new experiment may run and charge
   * budget again), so it has its own id, its own budget and its own evidence —
   * which is what lets a sample be run again without ever overwriting a record.
   */
  repetition: number
  /** The candidate content identity the candidate side runs against (the prepared `SKILL.md`). */
  candidate: SkillContentIdentity
  /** The production baseline the candidate replaces, when prepare captured one (a replacement, not a new skill). */
  productionBaseline?: SkillContentIdentity
  /** The model identity the caller froze — an opaque string (a config digest, a model name), never interpreted here. */
  model: string
  budget: ExperimentBudget
  samples: FrozenSample[]
  /** The input snapshot both sides' workspaces are built from, and its recursive content digest. */
  snapshot: { sourceDir: string; digest: string }
  /** The comparer that produced the report's verdicts. */
  comparerVersion: string
  /** What each side runs under, in words: the candidate's overlay, and the baseline's absence of one. */
  overlay: { baseline: string; candidate: string }
}

/** One experiment's report: the frozen identity, every sample's two sides, and the verdict recomputable from them. */
export interface ExperimentReport {
  formatVersion: 2
  proposalId: string
  experimentId: string
  /**
   * When this report's newest ledger record was written — a function of the
   * records, not of the reading: re-reading an experiment reproduces the same
   * report bytes, so a digest taken over the report stays meaningful.
   */
  at: string
  frozen: FrozenExperiment
  frozenDigest: string
  samples: ExperimentSampleComparison[]
  verdict: ExperimentVerdict
}

/**
 * JSON with object keys sorted recursively — the one serialization every digest
 * in this schema is taken over. `undefined` members are dropped, so a digest is
 * the same whether an absent optional member was omitted or written as
 * `undefined`, and the digest of a value never depends on key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Lowercase SHA-256 hex over {@link canonicalJson} of a value — the frozen-block digest primitive. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** The digest of a whole frozen identity block; a report and its ledger record agree only when these agree. */
export function frozenDigestOf(frozen: FrozenExperiment): string {
  return digestOf(frozen)
}

/** SHA-256 over a criterion's protected input identities, in path order — the acceptance input identity of one criterion. */
export function protectedInputsDigest(inputs: readonly { path: string; sha256: string }[]): string {
  const lines = inputs.map(input => `${input.path}\0${input.sha256}`).sort()
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/**
 * The comparison-relevant half of one side: exactly what the v1 comparer reads
 * (the outcome and the criterion verdicts), so the v2 verdict is the v1 rules
 * applied to this experiment's evidence and nothing else. An
 * {@link ExperimentSideDetail} is assignable to it.
 */
export interface ExperimentSideComparison {
  outcome: ExperimentOutcome
  criteria: ExperimentCriterionDetail[]
}

/** One side as the v1 comparer reads it: the same outcome rank and criterion semantics, so v1's rules stay the rules. */
function asReplaySide(side: ExperimentSideComparison): ReplaySideSummary {
  return {
    // The comparer never reads the task identity (its answer is over outcomes
    // and criteria only); the report's identity checks are their own rule.
    taskId: '',
    // An interrupted side is unrankable exactly as a cancelled one is; the
    // comparer answers `inconclusive` for both and this schema never guesses at
    // which is which.
    outcome: side.outcome === 'interrupted' ? 'cancelled' : side.outcome,
    criteria: side.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      verdict: criterion.verdict,
      ...(criterion.command === undefined ? {} : { command: criterion.command }),
      ...(criterion.exitCode === undefined ? {} : { exitCode: criterion.exitCode }),
    })),
  }
}

/**
 * One sample's mechanical verdict. An unrankable side (cancelled / interrupted)
 * and a comparison whose two contracts differ (a criterion added, removed or
 * re-commanded) are both `inconclusive` — the v1 semantics, unchanged. A role of
 * `observed-failure` asks whether the target failure was reproduced and then
 * fixed. A regression or holdout sample stands for a historical success that
 * must still hold: its own baseline must be `verified` for the sample to be
 * comparable at all — a baseline that did not pass reproduced nothing, so the
 * sample is `inconclusive` whatever the candidate did — and only then does the
 * candidate's relation answer `regressed` or `maintained`.
 */
export function compareExperimentSides(
  role: ExperimentSampleRole,
  baseline: ExperimentSideComparison,
  candidate: ExperimentSideComparison,
): ExperimentSampleVerdict {
  const relation = compareReplaySides(asReplaySide(baseline), asReplaySide(candidate)).relation
  if (relation === 'inconclusive') return 'inconclusive'
  const baselineRank = OUTCOME_RANK[baseline.outcome]
  const candidateRank = OUTCOME_RANK[candidate.outcome]
  if (role === 'observed-failure') {
    if (baselineRank === 0 && candidateRank === 0) return 'both-failed'
    return baselineRank === 0 && candidateRank === 1 ? 'fixed' : 'not-fixed'
  }
  // `verified` is the only comparable baseline: a shared failure is not
  // maintenance (nothing was reproduced to keep), and a candidate that passed
  // over a baseline that never did is no evidence of a kept success either.
  if (baselineRank !== 1) return 'inconclusive'
  return relation === 'worse' ? 'regressed' : 'maintained'
}

/**
 * The overall verdict over every sample, from the sample verdicts alone: any
 * evidence that could not settle makes the whole experiment inconclusive; a
 * reproduced-and-unfixed failure is `both-failed`; an unfixed target failure
 * with a degraded regression/holdout sample is `regressed`; an unfixed target
 * with nothing worse is `not-fixed`; a fixed target with a degraded sample is
 * `fixed-with-regression`; and a fixed target with nothing worse is `fixed`.
 * The six are distinguishable by construction, and a report whose `verdict` is
 * not this value is refused.
 */
export function overallExperimentVerdict(samples: readonly Pick<ExperimentSampleComparison, 'role' | 'verdict'>[]): ExperimentVerdict {
  if (samples.some(sample => sample.verdict === 'inconclusive')) return 'inconclusive'
  if (samples.some(sample => sample.verdict === 'both-failed')) return 'both-failed'
  const failures = samples.filter(sample => sample.role === 'observed-failure')
  const fixedAll = failures.length > 0 && failures.every(sample => sample.verdict === 'fixed')
  const regressedAny = samples.some(sample => sample.verdict === 'regressed')
  if (!fixedAll) return regressedAny ? 'regressed' : 'not-fixed'
  return regressedAny ? 'fixed-with-regression' : 'fixed'
}

const EXPERIMENT_OUTCOME_SET = new Set<string>(EXPERIMENT_OUTCOMES)
const EXPERIMENT_CONDITION_VERDICTS = ['pass', 'fail', 'inconclusive'] as const

function isHex64(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function assertIdentity(value: unknown, field: string): asserts value is SkillContentIdentity {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0 || !isHex64(value.sha256)) {
    throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256 }`)
  }
}

/**
 * Validate a frozen identity block: every member present and shaped, the
 * comparison rules named, and §F.2's two non-empty groups (at least one
 * observed failure, at least one holdout) enforced — a block missing either is
 * not a two-sided experiment whatever it is called. Used by the report
 * assertion and by the ledger fold, so a hand-written record fails the same
 * checks a live run's record passes.
 */
export function assertFrozenExperiment(value: unknown): asserts value is FrozenExperiment {
  if (!isRecord(value)) throw new Error('evolution: experiment report frozen must be an object')
  if (typeof value.proposalId !== 'string' || value.proposalId.length === 0) {
    throw new Error('evolution: experiment report frozen.proposalId must be a non-empty string')
  }
  if (!Number.isInteger(value.repetition) || (value.repetition as number) < 0) {
    throw new Error('evolution: experiment report frozen.repetition must be a non-negative integer')
  }
  assertIdentity(value.candidate, 'frozen.candidate')
  if (value.productionBaseline !== undefined) assertIdentity(value.productionBaseline, 'frozen.productionBaseline')
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new Error('evolution: experiment report frozen.model must be a non-empty string (the model identity the caller froze)')
  }
  assertExperimentBudget(value.budget, 'frozen.budget')
  if (!isRecord(value.snapshot) || typeof value.snapshot.sourceDir !== 'string' || value.snapshot.sourceDir.length === 0
    || !isHex64(value.snapshot.digest)) {
    throw new Error('evolution: experiment report frozen.snapshot must be { sourceDir, digest } with a SHA-256 content digest')
  }
  if (value.comparerVersion !== EXPERIMENT_COMPARER_VERSION) {
    throw new Error(
      `evolution: experiment report frozen.comparerVersion must be "${EXPERIMENT_COMPARER_VERSION}" — ` +
      `got ${JSON.stringify(value.comparerVersion)}; a report this build cannot re-derive is refused, not trusted`,
    )
  }
  if (!isRecord(value.overlay) || typeof value.overlay.baseline !== 'string' || value.overlay.baseline.length === 0
    || typeof value.overlay.candidate !== 'string' || value.overlay.candidate.length === 0) {
    throw new Error('evolution: experiment report frozen.overlay must name what each side ran under')
  }
  if (!Array.isArray(value.samples) || value.samples.length === 0) {
    throw new Error('evolution: experiment report frozen.samples must be a non-empty array')
  }
  const taskIds = new Set<string>()
  value.samples.forEach((sample, index) => assertFrozenSample(sample, `frozen.samples[${index}]`, taskIds))
  const roles = value.samples.map(sample => (sample as FrozenSample).role)
  if (!roles.includes('observed-failure')) {
    throw new Error('evolution: an experiment frozen block needs at least one observed-failure sample (§F.2: the target failure must be reproduced)')
  }
  if (!roles.includes('holdout')) {
    throw new Error('evolution: an experiment frozen block needs at least one holdout sample (§F.2: the candidate must not be selected on every case)')
  }
}

function assertExperimentBudget(value: unknown, field: string): asserts value is ExperimentBudget {
  if (!isRecord(value)) throw new Error(`evolution: ${field} must be an object (a run-level budget, recorded only)`)
  for (const key of Object.keys(value)) {
    if (key !== 'wallTimeMs' && key !== 'maxTokens' && key !== 'note') {
      throw new Error(`evolution: ${field} has unknown key "${key}"`)
    }
  }
  for (const key of ['wallTimeMs', 'maxTokens'] as const) {
    const member = value[key]
    if (member !== undefined && (typeof member !== 'number' || !Number.isFinite(member) || member < 0)) {
      throw new Error(`evolution: ${field}.${key} must be a non-negative number`)
    }
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length === 0)) {
    throw new Error(`evolution: ${field}.note must be a non-empty string`)
  }
}

function assertFrozenSample(value: unknown, field: string, seen: Set<string>): asserts value is FrozenSample {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: experiment report ${field} must carry a taskId`)
  }
  if (seen.has(value.taskId)) throw new Error(`evolution: experiment report ${field} repeats task "${value.taskId}"`)
  seen.add(value.taskId)
  if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role as ExperimentSampleRole)) {
    throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
  }
  if (!isHex64(value.contractDigest)) throw new Error(`evolution: experiment report ${field}.contractDigest must be a SHA-256 hex`)
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    throw new Error(`evolution: experiment report ${field}.criteria must be a non-empty array (the acceptance the replay mirrors)`)
  }
  const criterionIds = new Set<string>()
  for (const criterion of value.criteria) {
    if (!isRecord(criterion) || typeof criterion.criterionId !== 'string' || criterion.criterionId.length === 0
      || criterionIds.has(criterion.criterionId) || typeof criterion.verificationMode !== 'string' || criterion.verificationMode.length === 0
      || (criterion.command !== undefined && typeof criterion.command !== 'string') || !isHex64(criterion.protectedInputsDigest)) {
      throw new Error(`evolution: experiment report ${field} has an invalid or duplicate frozen criterion`)
    }
    criterionIds.add(criterion.criterionId)
  }
  if (!isRecord(value.observed) || (value.observed.outcome !== 'verified' && value.observed.outcome !== 'failed')
    || (value.observed.runId !== undefined && (typeof value.observed.runId !== 'string' || value.observed.runId.length === 0))) {
    throw new Error(`evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`)
  }
}

function assertCriterionDetail(value: unknown, field: string): asserts value is ExperimentCriterionDetail {
  if (!isRecord(value) || typeof value.criterionId !== 'string' || value.criterionId.length === 0
    || !EXPERIMENT_CONDITION_VERDICTS.includes(value.verdict as 'pass' | 'fail' | 'inconclusive')
    || (value.verifierId !== undefined && (typeof value.verifierId !== 'string' || value.verifierId.length === 0))
    || (value.verifierVersion !== undefined && (typeof value.verifierVersion !== 'string' || value.verifierVersion.length === 0))
    || (value.command !== undefined && typeof value.command !== 'string')
    || (value.exitCode !== undefined && typeof value.exitCode !== 'number')) {
    throw new Error(`evolution: experiment report ${field} has an invalid criterion verdict`)
  }
}

function assertCost(value: unknown, field: string): asserts value is ExperimentCost {
  if (!isRecord(value)) throw new Error(`evolution: experiment report ${field} must be a cost object`)
  if (value.status === 'unknown') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      throw new Error(`evolution: experiment report ${field} must say why the cost is unknown`)
    }
    return
  }
  if (value.status !== 'reported' || !isRecord(value.metrics)) {
    throw new Error(`evolution: experiment report ${field} must be { status: "reported", metrics } or { status: "unknown", reason }`)
  }
}

function assertSideDetail(value: unknown, field: string, sampleTaskId: string, observedRunId: string | undefined): asserts value is ExperimentSideDetail {
  if (!isRecord(value)) throw new Error(`evolution: experiment report ${field} must be an object`)
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || value.taskId.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.taskId must be a non-empty string when present`)
  }
  if (value.taskId === sampleTaskId) {
    throw new Error(
      `evolution: experiment report ${field} names the sample's own historical task "${sampleTaskId}" as a run of this experiment — ` +
      'the historical task is the case, not a baseline; both sides must be new replayed tasks',
    )
  }
  if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role as ExperimentSampleRole)) {
    throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(' / ')}`)
  }
  if (!EXPERIMENT_SIDES.includes(value.side as ExperimentSide)) {
    throw new Error(`evolution: experiment report ${field}.side must be one of ${EXPERIMENT_SIDES.join(' / ')}`)
  }
  if (!EXPERIMENT_OUTCOME_SET.has(value.outcome as string)) {
    throw new Error(`evolution: experiment report ${field}.outcome must be one of ${EXPERIMENT_OUTCOMES.join(' / ')}`)
  }
  for (const key of ['runId', 'reviewRef'] as const) {
    const member = value[key]
    if (member !== undefined && (typeof member !== 'string' || member.length === 0)) {
      throw new Error(`evolution: experiment report ${field}.${key} must be a non-empty string when present`)
    }
  }
  if (observedRunId !== undefined && value.runId === observedRunId) {
    throw new Error(
      `evolution: experiment report ${field} cites run "${observedRunId}", the sample's own historical run — ` +
      'the historical champion locates the case and is never this experiment\'s baseline; both sides must be new runs',
    )
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some(ref => typeof ref !== 'string' || ref.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.evidenceRefs must be an array of non-empty evidence ids`)
  }
  if (typeof value.workspace !== 'string' || value.workspace.length === 0) {
    throw new Error(`evolution: experiment report ${field}.workspace must be the directory the run went through`)
  }
  if (value.initialDigest !== undefined && !isHex64(value.initialDigest)) {
    throw new Error(`evolution: experiment report ${field}.initialDigest must be the SHA-256 of the frozen workspace content`)
  }
  if (!Array.isArray(value.criteria)) throw new Error(`evolution: experiment report ${field}.criteria must be an array`)
  const ids = new Set<string>()
  for (const criterion of value.criteria) {
    assertCriterionDetail(criterion, `${field}.criteria[${(criterion as { criterionId?: unknown }).criterionId as string}]`)
    if (ids.has((criterion as ExperimentCriterionDetail).criterionId)) {
      throw new Error(`evolution: experiment report ${field} has a duplicate criterion`)
    }
    ids.add((criterion as ExperimentCriterionDetail).criterionId)
  }
  assertCost(value.cost, `${field}.cost`)
  if (value.outcome === 'interrupted') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      throw new Error(`evolution: experiment report ${field} is interrupted and must carry the reason it has no terminal run`)
    }
    return
  }
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new Error(`evolution: experiment report ${field} settled a run and must name the replayed task it created`)
  }
  if (value.initialDigest === undefined) {
    throw new Error(`evolution: experiment report ${field} settled a run and must carry the workspace's initial digest`)
  }
  if (value.outcome === 'verified' && ids.size === 0) {
    throw new Error(`evolution: experiment report ${field} verified outcome needs criterion evidence`)
  }
}

/**
 * Validate a v2 report against itself, the way `assertReplayReport` validates a
 * v1 one — and further: every verdict the report carries must equal the one its
 * own details recompute (`compareExperimentSides` per sample,
 * `overallExperimentVerdict` overall), and the frozen block must hash to the
 * `frozenDigest` the report names. A report whose judgement and evidence
 * disagree is refused rather than read.
 *
 * The one thing this schema cannot check is where a side's run came from: a
 * forged report could name any task and run. It closes the forgery that matters
 * — a side citing the sample's *historical* run (or its historical task) as its
 * own — from the frozen block alone, and the service that owns the ledger
 * closes the rest by checking each recorded run against the store record the
 * experiment's own lineage names.
 */
export function assertExperimentReport(report: unknown): asserts report is ExperimentReport {
  if (!isRecord(report)) throw new Error('evolution: experiment report must be an object')
  if (report.formatVersion !== 2) throw new Error('evolution: experiment report formatVersion must be 2')
  if (typeof report.proposalId !== 'string' || report.proposalId.length === 0) {
    throw new Error('evolution: experiment report.proposalId must be a non-empty string')
  }
  if (typeof report.experimentId !== 'string' || report.experimentId.length === 0) {
    throw new Error('evolution: experiment report.experimentId must be a non-empty string')
  }
  if (typeof report.at !== 'string' || report.at.length === 0) {
    throw new Error('evolution: experiment report.at must be a non-empty string')
  }
  assertFrozenExperiment(report.frozen)
  const frozen = report.frozen as FrozenExperiment
  if (frozen.proposalId !== report.proposalId) {
    throw new Error(`evolution: experiment report frozen.proposalId "${frozen.proposalId}" does not match "${report.proposalId}"`)
  }
  if (report.frozenDigest !== frozenDigestOf(frozen)) {
    throw new Error('evolution: experiment report frozenDigest does not match its frozen identity block')
  }
  if (!Array.isArray(report.samples)) throw new Error('evolution: experiment report.samples must be an array')
  const reportSamples = report.samples as unknown[]
  const byTask = new Map(frozen.samples.map(sample => [sample.taskId, sample]))
  if (reportSamples.length !== frozen.samples.length) {
    throw new Error('evolution: experiment report must carry exactly one comparison per frozen sample')
  }
  const seen = new Set<string>()
  reportSamples.forEach((entry, index) => {
    const field = `samples[${index}]`
    if (!isRecord(entry)) throw new Error(`evolution: experiment report ${field} must be an object`)
    const taskId = entry.taskId
    const frozenSample = typeof taskId === 'string' ? byTask.get(taskId) : undefined
    if (frozenSample === undefined) {
      throw new Error(`evolution: experiment report ${field}.taskId is not one of the frozen samples`)
    }
    if (seen.has(frozenSample.taskId)) throw new Error(`evolution: experiment report ${field} repeats sample "${frozenSample.taskId}"`)
    seen.add(frozenSample.taskId)
    if (entry.role !== frozenSample.role) {
      throw new Error(`evolution: experiment report ${field}.role does not match the frozen sample's role`)
    }
    if (!EXPERIMENT_SAMPLE_VERDICTS.includes(entry.verdict as ExperimentSampleVerdict)) {
      throw new Error(`evolution: experiment report ${field}.verdict must be one of ${EXPERIMENT_SAMPLE_VERDICTS.join(' / ')}`)
    }
    assertSideDetail(entry.baseline, `${field}.baseline`, frozenSample.taskId, frozenSample.observed.runId)
    assertSideDetail(entry.candidate, `${field}.candidate`, frozenSample.taskId, frozenSample.observed.runId)
    const baseline = entry.baseline as ExperimentSideDetail
    const candidate = entry.candidate as ExperimentSideDetail
    if (baseline.side !== 'baseline' || candidate.side !== 'candidate') {
      throw new Error(`evolution: experiment report ${field} must carry one baseline and one candidate side`)
    }
    if (baseline.role !== frozenSample.role || candidate.role !== frozenSample.role) {
      throw new Error(`evolution: experiment report ${field} sides must carry the sample's role`)
    }
    if (baseline.workspace === candidate.workspace) {
      throw new Error(`evolution: experiment report ${field} sides share one workspace "${baseline.workspace}" — two sides need two workspaces`)
    }
    const computed = compareExperimentSides(frozenSample.role, baseline, candidate)
    if (entry.verdict !== computed) {
      throw new Error(
        `evolution: experiment report ${field}.verdict "${String(entry.verdict)}" does not match its own evidence ("${computed}")`,
      )
    }
  })
  const computedVerdict = overallExperimentVerdict(reportSamples as ExperimentSampleComparison[])
  if (report.verdict !== computedVerdict) {
    throw new Error(`evolution: experiment report.verdict "${String(report.verdict)}" does not match its samples ("${computedVerdict}")`)
  }
  if (!EXPERIMENT_VERDICTS.includes(report.verdict as ExperimentVerdict)) {
    throw new Error(`evolution: experiment report.verdict must be one of ${EXPERIMENT_VERDICTS.join(' / ')}`)
  }
}
