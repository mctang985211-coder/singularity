/**
 * The comparison rules the two-sided skill experiment is judged by, and the
 * experiment's report schema (S4-E §F.2).
 *
 * One comparer, {@link compareReplaySides}: the champion/candidate side pair it
 * takes was written for the v1 candidate-vs-champion replay, and its rules are
 * exactly what the experiment reuses — outcome ranks (verified > failed), a
 * shared criterion flipping pass → anything else is a regression, a changed
 * contract is inconclusive, and a candidate run that could not settle
 * (cancelled) is inconclusive rather than worse. "Not worse" is the strongest
 * claim those rules make; whether that suffices for promotion is {@link
 * overallExperimentVerdict} and the human gate's call.
 *
 * A v2 report is the whole experiment: both sides are **new runs** of the same
 * frozen sample, each in its own workspace built from one frozen input
 * snapshot, and the historical record only locates the case
 * ({@link FrozenSample.observed}) — it is never a baseline. The report carries
 * the frozen identity block it was run under, every side's Task/Run/Review/
 * Evidence references and costs, and a verdict that is a pure function of those
 * details ({@link compareExperimentSides} / {@link overallExperimentVerdict}),
 * so any reader can recompute it. {@link assertExperimentReport} does exactly
 * that and refuses a report whose verdicts do not match its own evidence.
 *
 * The vocabulary the numbers are written in ({@link ReplayVerdict},
 * {@link ReplayRelation} and their constant lists) stays exported because the
 * fold still reads the v1 `replayed` ledger lines a build before this one
 * wrote; no current entry produces one.
 * @module dsh-singularity-evolution
 */

import { createHash } from 'node:crypto'
import type { ReviewMetrics } from '@dangosys/dsh-singularity-task'

/**
 * The v1 replay's overall verdict vocabulary: whether the candidate was not
 * worse than the champion. Kept for the fold of a `replayed` ledger line a
 * build before this one wrote; no current entry produces one.
 */
export type ReplayVerdict = 'not-worse' | 'worse' | 'inconclusive' | 'manual'
/** Per-task comparison outcome; `manual` marked the agent_preset v1 boundary (nothing executed). */
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
 * at prepare, carried by the experiment's frozen block, and re-verified by the
 * experiment's pre-run check, at every promotion gate, and on the apply write —
 * so the chain can never validate one file's content and apply another's.
 */
export interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string
}

/** One side of one task's comparison: an outcome and the criterion verdicts the run reported. */
export interface ReplaySideSummary {
  taskId: string
  runId?: string
  outcome: 'verified' | 'failed' | 'cancelled'
  criteria: ReplayCriterionSummary[]
}

/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
export interface ReplayCriterionDiff {
  criterionId: string
  champion?: string
  candidate?: string
}

/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
const OUTCOME_RANK: Readonly<Record<string, number>> = { verified: 1, failed: 0 }

/**
 * Compare one task's two sides. A regression is mechanical: the candidate's
 * outcome ranks below the champion's, or a criterion both sides report flipped
 * from pass to anything else. An unrankable candidate outcome (cancelled) is
 * inconclusive — it says nothing about the candidate's quality. The v2 comparer
 * ({@link compareExperimentSides}) reads exactly this answer off one sample's
 * two sides.
 */
export function compareReplaySides(
  champion: ReplaySideSummary,
  candidate: ReplaySideSummary,
): { verdictMatch: boolean; criteriaDiff: ReplayCriterionDiff[]; relation: ReplayRelation } {
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
 * The budget the caller freezes with the experiment (§F.2: samples, inputs,
 * judge, model/tools, budget and comparison rules are frozen before the run).
 * Recorded verbatim in the frozen block, the ledger and the report.
 *
 * `maxTokens` is the one ceiling, and it bounds the **whole experiment**, not
 * one side of it: the orchestrator adds up the token four buckets every side
 * already settled reported (from the ledger, so a restart never resets the
 * count) and does not start a further side once that total has consumed the
 * ceiling; the promotion gate re-adds the same buckets over every side and
 * refuses a recorded total above the ceiling, because a run's own counts only
 * become readable once it settled.
 *
 * There is no experiment-level wall clock: a Run's time is bounded by the
 * runtime's own limits alone — the root budget's `rootBudget.wallTimeMs` when
 * the deployment configures one, and the per-run `Config.budget.wallTimeMs`
 * fallback. A budget that declares no `maxTokens` constrains nothing: a cost
 * nobody reported then stays the honest unknown it is — recorded, never zeroed.
 */
export interface ExperimentBudget {
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

/**
 * The model selection one deployment's runs share, as that deployment resolves
 * it before anything runs (S4-E §Q3).
 *
 * It is structured on purpose: a `"<provider>/<model>"` string cannot be read
 * back (a model id may contain `/`), and it drops the options that decide what a
 * request really is — the reasoning effort and the output ceiling. The four
 * fields are exactly `AgentOptions`' own model members, so the frozen selection
 * travels to the real spawn verbatim and the requests that spawn produces can be
 * compared against it member by member.
 */
export interface ModelSelection {
  /** The registered provider route the runs go through. */
  provider: string
  /** The provider-owned model id. */
  model: string
  /** The adapter-owned reasoning effort, when the deployment selected one. */
  reasoningEffort?: string
  /** The per-request output ceiling, when the deployment selected one. */
  maxTokens?: number
  /**
   * Derived display form `<provider>/<model>`. It is shown to humans and never
   * parsed back: the structured members above are the identity, and a model id
   * that contains `/` is exactly why the string cannot be one.
   */
  label: string
}

/**
 * Read one selection as the structured identity, or `undefined` when it names
 * no route. A selection without a provider or without a model is not a
 * structured selection — a caller that cannot produce one is refused rather
 * than given a placeholder (`provider` empty means the request would be routed
 * by adapter defaults nobody froze).
 */
export function modelSelectionOf(selection: {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
  maxTokens?: unknown
} | undefined): ModelSelection | undefined {
  const provider = typeof selection?.provider === 'string' && selection.provider.length > 0 ? selection.provider : undefined
  const model = typeof selection?.model === 'string' && selection.model.length > 0 ? selection.model : undefined
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
    ? selection.reasoningEffort
    : undefined
  const maxTokens = typeof selection?.maxTokens === 'number' && Number.isFinite(selection.maxTokens) && selection.maxTokens > 0
    ? selection.maxTokens
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    label: `${provider}/${model}`,
  }
}

/** The `AgentOptions` a frozen selection travels as: the four members, verbatim, with no label. */
export function agentOptionsOf(selection: ModelSelection): { provider: string; model: string; reasoningEffort?: string; maxTokens?: number } {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
  }
}

/**
 * One criterion's frozen identity: the acceptance condition as the sample's own
 * contract holds it, plus the judge identity it was frozen under (S4-E §Q3).
 */
export interface FrozenCriterion {
  criterionId: string
  verificationMode: string
  command?: string
  /** SHA-256 over the criterion's protected input identities (`<path>\0<sha256>` lines, sorted); the empty list hashes too. */
  protectedInputsDigest: string
  /**
   * The judge the criterion pins (`AcceptanceCriterion.verifierRef`), which the
   * registry held at freeze: the freeze refuses a criterion that pins no ref or
   * names one the registry does not hold, so this is never absent.
   */
  verifierRef: string
  /**
   * The pinned judge's registered version at freeze: the freeze refuses a judge
   * whose version the registry does not declare, so a frozen verdict is always
   * recallable against the instance that produced it.
   */
  verifierVersion: string
  /**
   * How this criterion's judge identity is anchored, named at freeze so a later
   * reader never has to guess: the registration id of the pinned judge and the
   * version the registry declared for it then.
   */
  verifierAnchor: string
}

/**
 * One skill the production configuration's pre-check resolved for a sample's
 * rows, as it stood when the experiment froze: the identity a run's own binding
 * has to agree with before the run may stand as this sample's side.
 */
export interface FrozenProviderSkill {
  name: string
  role: 'execution-provider' | 'knowledge' | 'guidance'
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null
  /** `skillContentDigest` of the bytes the run is expected to load for this skill in the production configuration. */
  contentDigest: string
}

/**
 * The provider identity the *production baseline* side of one sample must bind,
 * fixed before the first run (S4-E §Q3): the capability rows the sample's
 * required capabilities resolve to, the registry revision the runtime's own
 * pre-check produces for them, the MCP servers those rows grant, the preset they
 * declare, and every skill their providers resolved to. The candidate side's
 * binding is compared against the same baseline with exactly one substituted
 * entry — the promoted skill's own content — which is the overlay difference
 * this ticket approved.
 */
export interface FrozenProviderIdentity {
  /** The capability rows in play, sorted (the sample's required capabilities as the table holds them). */
  capabilities: string[]
  /**
   * The registry revision the runtime's own pre-check produces for those rows
   * over the production table at freeze. Every side's run binding must carry it:
   * a capability row, a tool label or a declared contract that moved since the
   * freeze moves it too.
   */
  registryRevision: string
  /** The MCP server names those rows grant, sorted. Every side must bind exactly these, with a resolved template. */
  mcpServers: string[]
  /**
   * The preset those rows declare — one worker, one preset — or `null` when none
   * declares one and the deployment's own default governs. A declared preset is
   * compared against each side's run; an undeclared one is compared side to side,
   * so a default that moved between the sides still refuses.
   */
  preset: string | null
  /** Every skill the rows' providers resolved to at freeze, sorted by name. */
  skills: FrozenProviderSkill[]
}

/**
 * One sample's frozen identity: the case it locates, and the acceptance
 * identity the replay will mirror into both sides. `observed` is the historical
 * record the sample was chosen for — it locates the case and is *not* a
 * baseline: every report side must cite a different run. `provider` is the
 * production configuration's provider identity for this sample, frozen with it.
 */
export interface FrozenSample {
  taskId: string
  role: ExperimentSampleRole
  /** SHA-256 over the sample's contract as the replay mirrors it (objective, criteria, required capabilities). */
  contractDigest: string
  criteria: FrozenCriterion[]
  observed: { outcome: 'verified' | 'failed'; runId?: string }
  /** The provider identity the production-baseline side of this sample must bind (S4-E §Q3). */
  provider: FrozenProviderIdentity
}

/**
 * The identity block fixed before the first run (§F.2). Everything a reader
 * needs to say *what* was compared: the candidate's exact bytes, the input
 * snapshot both workspaces were built from, the samples and their acceptance
 * identity, the structured model selection the deployment froze, the budget, the overlay each
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
  /**
   * The model selection every run of this experiment is placed under (S4-E
   * §Q3), frozen before the first side and passed to the runtime verbatim as
   * each side's `agentOptions`. `model.label` is the display form; the identity
   * is the structured members beside it.
   */
  model: ModelSelection
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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
  assertModelSelection(value.model, 'frozen.model')
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
  if (!isRecord(value)) throw new Error(`evolution: ${field} must be an object (the whole experiment's token ceiling)`)
  for (const key of Object.keys(value)) {
    if (key === 'wallTimeMs') {
      throw new Error(
        `evolution: ${field}.wallTimeMs is removed — an experiment has no wall-clock ceiling; freeze an optional ` +
        '`maxTokens` total instead, and bound a run\'s time with the deployment\'s own limits (rootBudget.wallTimeMs, ' +
        'or the per-run Config.budget.wallTimeMs). A budget this build cannot enforce is refused rather than ignored',
      )
    }
    if (key !== 'maxTokens' && key !== 'note') {
      throw new Error(`evolution: ${field} has unknown key "${key}"`)
    }
  }
  const member = value.maxTokens
  if (member !== undefined && (typeof member !== 'number' || !Number.isFinite(member) || member < 0)) {
    throw new Error(`evolution: ${field}.maxTokens must be a non-negative number`)
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length === 0)) {
    throw new Error(`evolution: ${field}.note must be a non-empty string`)
  }
}

function assertModelSelection(value: unknown, field: string): asserts value is ModelSelection {
  if (!isRecord(value)) {
    throw new Error(
      `evolution: experiment report ${field} must be the structured model selection { provider, model } this build froze — ` +
      'a record that froze a bare string cannot name the route its runs took, so it is refused rather than read as one',
    )
  }
  for (const key of Object.keys(value)) {
    if (!['provider', 'model', 'reasoningEffort', 'maxTokens', 'label'].includes(key)) {
      throw new Error(`evolution: experiment report ${field} has unknown key "${key}"`)
    }
  }
  if (typeof value.provider !== 'string' || value.provider.length === 0) {
    throw new Error(`evolution: experiment report ${field}.provider must be the provider route the runs go through`)
  }
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new Error(`evolution: experiment report ${field}.model must be the model id the runs go through`)
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.reasoningEffort must be a non-empty string when present`)
  }
  if (value.maxTokens !== undefined && (typeof value.maxTokens !== 'number' || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0)) {
    throw new Error(`evolution: experiment report ${field}.maxTokens must be a positive number when present`)
  }
  if (value.label !== `${value.provider}/${value.model}`) {
    throw new Error(
      `evolution: experiment report ${field}.label must be the derived display form "${value.provider}/${value.model}" — ` +
      'the label is a rendering of the structured members, never an identity of its own',
    )
  }
}

function assertFrozenProviderSkill(value: unknown, field: string): asserts value is FrozenProviderSkill {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0
    || !['execution-provider', 'knowledge', 'guidance'].includes(value.role as string)
    || (value.contractDigest !== null && !isHex64(value.contractDigest))
    || !isHex64(value.contentDigest)) {
    throw new Error(`evolution: experiment report ${field} must be a resolved skill identity { name, role, contractDigest, contentDigest }`)
  }
}

function assertFrozenProviderIdentity(value: unknown, field: string): asserts value is FrozenProviderIdentity {
  if (!isRecord(value)) {
    throw new Error(
      `evolution: experiment report ${field} must be the frozen provider identity of the sample's production baseline ` +
      '(capabilities, registryRevision, mcpServers, preset, skills) — a sample frozen before that identity was recorded cannot ' +
      'constrain what its sides really ran against',
    )
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.capabilities must be an array of capability names`)
  }
  if (typeof value.registryRevision !== 'string' || value.registryRevision.length === 0) {
    throw new Error(`evolution: experiment report ${field}.registryRevision must be the revision the runtime's pre-check produced`)
  }
  if (!Array.isArray(value.mcpServers) || value.mcpServers.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.mcpServers must be an array of MCP server names`)
  }
  if (value.preset !== null && (typeof value.preset !== 'string' || value.preset.length === 0)) {
    throw new Error(`evolution: experiment report ${field}.preset must be the declared preset or null (the deployment default governs)`)
  }
  if (!Array.isArray(value.skills)) throw new Error(`evolution: experiment report ${field}.skills must be an array`)
  const names = new Set<string>()
  for (const skill of value.skills) {
    assertFrozenProviderSkill(skill, `${field}.skills[${(skill as { name?: unknown }).name as string}]`)
    if (names.has((skill as FrozenProviderSkill).name)) {
      throw new Error(`evolution: experiment report ${field} repeats skill "${(skill as FrozenProviderSkill).name}"`)
    }
    names.add((skill as FrozenProviderSkill).name)
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
    if (typeof criterion.verifierRef !== 'string' || criterion.verifierRef.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} criterion "${criterion.criterionId}" must pin the judge it was frozen with — ` +
        'a criterion whose judge nobody can name cannot be recalled against the instance that decides it',
      )
    }
    if (typeof criterion.verifierVersion !== 'string' || criterion.verifierVersion.length === 0) {
      throw new Error(
        `evolution: experiment report ${field} criterion "${criterion.criterionId}" must carry the version of the pinned judge it ` +
        'was frozen with — a verdict belongs to the instance that judged it',
      )
    }
    if (typeof criterion.verifierAnchor !== 'string' || criterion.verifierAnchor.length === 0) {
      throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must name how its judge identity is anchored`)
    }
    criterionIds.add(criterion.criterionId)
  }
  if (!isRecord(value.observed) || (value.observed.outcome !== 'verified' && value.observed.outcome !== 'failed')
    || (value.observed.runId !== undefined && (typeof value.observed.runId !== 'string' || value.observed.runId.length === 0))) {
    throw new Error(`evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`)
  }
  assertFrozenProviderIdentity(value.provider, `${field}.provider`)
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
 * Validate a v2 report against itself — and further than a shape check: every
 * verdict the report carries must equal the one its own details recompute
 * (`compareExperimentSides` per sample,
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
