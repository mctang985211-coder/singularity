import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { CapabilityConfig, ReplayRunOutcome, ReplayTaskOptions } from "@dangosys/dsh-singularity-task-runtime";
import { ProposalTargetType, ReviewCriterion, ReviewMetrics, ReviewRecord, TaskSnapshot } from "@dangosys/dsh-singularity-task";

//#region src/replay.d.ts

/**
 * One candidate side's relation to its baseline, as {@link compareReplaySides}
 * answers it: a side that ranks above its baseline is `not-worse`, one that
 * ranks below it or regresses a criterion is `worse`, and an unrankable side
 * (cancelled / interrupted) or a comparison across changed criteria is
 * `inconclusive`. The `@2` sample verdict ({@link compareExperimentSides}) is
 * read off this answer.
 */
type SideRelation = 'not-worse' | 'worse' | 'inconclusive';
/** One criterion's verdict on one side, as the record / fresh run reported it. */
interface ReplayCriterionSummary {
  criterionId: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  command?: string;
  exitCode?: number;
}
/**
 * The content identity of a single-file skill candidate (P2): the skill name
 * plus the SHA-256 of the exact bytes of the materialized `SKILL.md`. Recorded
 * at prepare, carried by the experiment's frozen block, and re-verified by the
 * experiment's pre-run check, at every promotion gate, and on the apply write —
 * so the chain can never validate one file's content and apply another's.
 */
interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string;
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string;
}
/** One side of one task's comparison: an outcome and the criterion verdicts the run reported. */
interface ReplaySideSummary {
  taskId: string;
  runId?: string;
  outcome: 'verified' | 'failed' | 'cancelled';
  criteria: ReplayCriterionSummary[];
}
/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
interface ReplayCriterionDiff {
  criterionId: string;
  champion?: string;
  candidate?: string;
}
/**
 * Compare one task's two sides. A regression is mechanical: the candidate's
 * outcome ranks below the champion's, or a criterion both sides report flipped
 * from pass to anything else. An unrankable candidate outcome (cancelled) is
 * inconclusive — it says nothing about the candidate's quality. The v2 comparer
 * ({@link compareExperimentSides}) reads exactly this answer off one sample's
 * two sides.
 */
declare function compareReplaySides(champion: ReplaySideSummary, candidate: ReplaySideSummary): {
  verdictMatch: boolean;
  criteriaDiff: ReplayCriterionDiff[];
  relation: SideRelation;
};
/**
 * The comparer a v2 report names, and the only one this build can re-check:
 * the verdict rules of {@link compareExperimentSides} and
 * {@link overallExperimentVerdict}. A report naming anything else is refused
 * by {@link assertExperimentReport} instead of being re-derived with rules this
 * build does not have.
 */
declare const EXPERIMENT_COMPARER_VERSION = "experiment-comparer@2";
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
type ExperimentSampleRole = 'observed-failure' | 'observed-regression' | 'holdout';
declare const EXPERIMENT_SAMPLE_ROLES: readonly ExperimentSampleRole[];
/** Which side of one sample's comparison a run is: the frozen baseline, or the candidate. */
type ExperimentSide = 'baseline' | 'candidate';
declare const EXPERIMENT_SIDES: readonly ExperimentSide[];
/**
 * A side's settled outcome. `cancelled` is the runtime's own settlement of a
 * run that was stopped; `interrupted` is this plane's record of a side whose
 * run never reached a terminal state (a process that died mid-run, a run the
 * store no longer holds) — it says nothing about the candidate, so every
 * verdict over it is `inconclusive`.
 */
type ExperimentOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted';
declare const EXPERIMENT_OUTCOMES: readonly ExperimentOutcome[];
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
type ExperimentSampleVerdict = 'fixed' | 'both-failed' | 'not-fixed' | 'maintained' | 'regressed' | 'inconclusive';
declare const EXPERIMENT_SAMPLE_VERDICTS: readonly ExperimentSampleVerdict[];
/**
 * The experiment's overall verdict — the six mechanically distinguishable
 * situations §F.2 names, in the order {@link overallExperimentVerdict} decides
 * them: `inconclusive` (evidence that could not settle), `both-failed`
 * (reproduced and unfixed), `regressed` (unfixed and something else got worse),
 * `not-fixed` (unfixed, nothing worse), `fixed-with-regression` (the failure is
 * fixed but a regression or holdout sample degraded), `fixed` (clean:
 * every failure sample fixed, every regression/holdout sample maintained).
 */
type ExperimentVerdict = 'fixed' | 'fixed-with-regression' | 'not-fixed' | 'both-failed' | 'regressed' | 'inconclusive';
declare const EXPERIMENT_VERDICTS: readonly ExperimentVerdict[];
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
interface ExperimentBudget {
  /** Token ceiling for the whole experiment. */
  maxTokens?: number;
  /** Free text: what the budget was derived from and why it is judged enough. */
  note?: string;
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
type ExperimentCost = {
  status: 'reported';
  metrics: ReviewMetrics;
} | {
  status: 'unknown';
  reason: string;
};
/** One criterion's verdict on one side, with the verifier that decided it (v1's report dropped the verifier identity; v2 keeps it). */
interface ExperimentCriterionDetail {
  criterionId: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** The registered verifier that decided the verdict, copied from the run's ReviewRecord. */
  verifierId?: string;
  /** The deciding instance's version, when it declared one. */
  verifierVersion?: string;
  command?: string;
  exitCode?: number;
}
/**
 * One side of one sample's comparison: this experiment's own run of that
 * sample. Every identity here is the durable one — the replayed task, the run,
 * the terminal review record, the evidence it carries, and the workspace built
 * from the frozen snapshot with the digest taken before the run wrote in it.
 */
interface ExperimentSideDetail {
  /** The replayed task this side created — never the sample's historical task. Absent for a side whose run never reached the store. */
  taskId?: string;
  role: ExperimentSampleRole;
  side: ExperimentSide;
  outcome: ExperimentOutcome;
  /** The run this side created. Absent when no run reached the store. */
  runId?: string;
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string;
  /** Evidence ids the run's review record carries. */
  evidenceRefs: string[];
  /** The workspace this side's run went through, as the runtime resolved it. */
  workspace: string;
  /**
   * SHA-256 of the workspace's content right after it was built from the frozen
   * snapshot — equal to the snapshot digest, which is what makes the side's
   * input the frozen one. Absent only for an `interrupted` side whose workspace
   * cannot be re-proved (`reason` says why).
   */
  initialDigest?: string;
  criteria: ExperimentCriterionDetail[];
  cost: ExperimentCost;
  /** Why this side has no terminal run; required for `interrupted`, absent otherwise. */
  reason?: string;
}
/** One sample's comparison: both sides, and the mechanical verdict over them. */
interface ExperimentSampleComparison {
  /** The sample's historical task id — the case, not a baseline. */
  taskId: string;
  role: ExperimentSampleRole;
  baseline: ExperimentSideDetail;
  candidate: ExperimentSideDetail;
  verdict: ExperimentSampleVerdict;
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
interface ModelSelection {
  /** The registered provider route the runs go through. */
  provider: string;
  /** The provider-owned model id. */
  model: string;
  /** The adapter-owned reasoning effort, when the deployment selected one. */
  reasoningEffort?: string;
  /** The per-request output ceiling, when the deployment selected one. */
  maxTokens?: number;
  /**
   * Derived display form `<provider>/<model>`. It is shown to humans and never
   * parsed back: the structured members above are the identity, and a model id
   * that contains `/` is exactly why the string cannot be one.
   */
  label: string;
}
/**
 * Read one selection as the structured identity, or `undefined` when it names
 * no route. A selection without a provider or without a model is not a
 * structured selection — a caller that cannot produce one is refused rather
 * than given a placeholder (`provider` empty means the request would be routed
 * by adapter defaults nobody froze).
 */
declare function modelSelectionOf(selection: {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  maxTokens?: unknown;
} | undefined): ModelSelection | undefined;
/** The `AgentOptions` a frozen selection travels as: the four members, verbatim, with no label. */
declare function agentOptionsOf(selection: ModelSelection): {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
};
/**
 * One criterion's frozen identity: the acceptance condition as the sample's own
 * contract holds it, plus the judge identity it was frozen under (S4-E §Q3).
 */
interface FrozenCriterion {
  criterionId: string;
  verificationMode: string;
  command?: string;
  /** SHA-256 over the criterion's protected input identities (`<path>\0<sha256>` lines, sorted); the empty list hashes too. */
  protectedInputsDigest: string;
  /**
   * The judge the criterion pins (`AcceptanceCriterion.verifierRef`), which the
   * registry held at freeze: the freeze refuses a criterion that pins no ref or
   * names one the registry does not hold, so this is never absent.
   */
  verifierRef: string;
  /**
   * The pinned judge's registered version at freeze: the freeze refuses a judge
   * whose version the registry does not declare, so a frozen verdict is always
   * recallable against the instance that produced it.
   */
  verifierVersion: string;
  /**
   * How this criterion's judge identity is anchored, named at freeze so a later
   * reader never has to guess: the registration id of the pinned judge and the
   * version the registry declared for it then.
   */
  verifierAnchor: string;
}
/**
 * One skill the production configuration's pre-check resolved for a sample's
 * rows, as it stood when the experiment froze: the identity a run's own binding
 * has to agree with before the run may stand as this sample's side.
 */
interface FrozenProviderSkill {
  name: string;
  role: 'execution-provider' | 'knowledge' | 'guidance';
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null;
  /** `skillContentDigest` of the bytes the run is expected to load for this skill in the production configuration. */
  contentDigest: string;
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
interface FrozenProviderIdentity {
  /** The capability rows in play, sorted (the sample's required capabilities as the table holds them). */
  capabilities: string[];
  /**
   * The registry revision the runtime's own pre-check produces for those rows
   * over the production table at freeze. Every side's run binding must carry it:
   * a capability row, a tool label or a declared contract that moved since the
   * freeze moves it too.
   */
  registryRevision: string;
  /** The MCP server names those rows grant, sorted. Every side must bind exactly these, with a resolved template. */
  mcpServers: string[];
  /**
   * The preset those rows declare — one worker, one preset — or `null` when none
   * declares one and the deployment's own default governs. A declared preset is
   * compared against each side's run; an undeclared one is compared side to side,
   * so a default that moved between the sides still refuses.
   */
  preset: string | null;
  /** Every skill the rows' providers resolved to at freeze, sorted by name. */
  skills: FrozenProviderSkill[];
}
/**
 * One sample's frozen identity: the case it locates, and the acceptance
 * identity the replay will mirror into both sides. `observed` is the historical
 * record the sample was chosen for — it locates the case and is *not* a
 * baseline: every report side must cite a different run. `provider` is the
 * production configuration's provider identity for this sample, frozen with it.
 */
interface FrozenSample {
  taskId: string;
  role: ExperimentSampleRole;
  /** SHA-256 over the sample's contract as the replay mirrors it (objective, criteria, required capabilities). */
  contractDigest: string;
  criteria: FrozenCriterion[];
  observed: {
    outcome: 'verified' | 'failed';
    runId?: string;
  };
  /** The provider identity the production-baseline side of this sample must bind (S4-E §Q3). */
  provider: FrozenProviderIdentity;
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
interface FrozenExperiment {
  proposalId: string;
  /**
   * The repetition index this experiment froze. A higher index is a *different*
   * frozen experiment (§F.2: only an explicit new experiment may run and charge
   * budget again), so it has its own id, its own budget and its own evidence —
   * which is what lets a sample be run again without ever overwriting a record.
   */
  repetition: number;
  /** The candidate content identity the candidate side runs against (the prepared `SKILL.md`). */
  candidate: SkillContentIdentity;
  /** The production baseline the candidate replaces, when prepare captured one (a replacement, not a new skill). */
  productionBaseline?: SkillContentIdentity;
  /**
   * The model selection every run of this experiment is placed under (S4-E
   * §Q3), frozen before the first side and passed to the runtime verbatim as
   * each side's `agentOptions`. `model.label` is the display form; the identity
   * is the structured members beside it.
   */
  model: ModelSelection;
  budget: ExperimentBudget;
  samples: FrozenSample[];
  /** The input snapshot both sides' workspaces are built from, and its recursive content digest. */
  snapshot: {
    sourceDir: string;
    digest: string;
  };
  /** The comparer that produced the report's verdicts. */
  comparerVersion: string;
  /** What each side runs under, in words: the candidate's overlay, and the baseline's absence of one. */
  overlay: {
    baseline: string;
    candidate: string;
  };
}
/** One experiment's report: the frozen identity, every sample's two sides, and the verdict recomputable from them. */
interface ExperimentReport {
  formatVersion: 2;
  proposalId: string;
  experimentId: string;
  /**
   * When this report's newest ledger record was written — a function of the
   * records, not of the reading: re-reading an experiment reproduces the same
   * report bytes, so a digest taken over the report stays meaningful.
   */
  at: string;
  frozen: FrozenExperiment;
  frozenDigest: string;
  samples: ExperimentSampleComparison[];
  verdict: ExperimentVerdict;
}
/**
 * JSON with object keys sorted recursively — the one serialization every digest
 * in this schema is taken over. `undefined` members are dropped, so a digest is
 * the same whether an absent optional member was omitted or written as
 * `undefined`, and the digest of a value never depends on key insertion order.
 */
declare function canonicalJson(value: unknown): string;
/** Lowercase SHA-256 hex over {@link canonicalJson} of a value — the frozen-block digest primitive. */
declare function digestOf(value: unknown): string;
/** The digest of a whole frozen identity block; a report and its ledger record agree only when these agree. */
declare function frozenDigestOf(frozen: FrozenExperiment): string;
/** SHA-256 over a criterion's protected input identities, in path order — the acceptance input identity of one criterion. */
declare function protectedInputsDigest(inputs: readonly {
  path: string;
  sha256: string;
}[]): string;
/**
 * The comparison-relevant half of one side: exactly what the v1 comparer reads
 * (the outcome and the criterion verdicts), so the v2 verdict is the v1 rules
 * applied to this experiment's evidence and nothing else. An
 * {@link ExperimentSideDetail} is assignable to it.
 */
interface ExperimentSideComparison {
  outcome: ExperimentOutcome;
  criteria: ExperimentCriterionDetail[];
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
declare function compareExperimentSides(role: ExperimentSampleRole, baseline: ExperimentSideComparison, candidate: ExperimentSideComparison): ExperimentSampleVerdict;
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
declare function overallExperimentVerdict(samples: readonly Pick<ExperimentSampleComparison, 'role' | 'verdict'>[]): ExperimentVerdict;
/**
 * Validate a frozen identity block: every member present and shaped, the
 * comparison rules named, and §F.2's two non-empty groups (at least one
 * observed failure, at least one holdout) enforced — a block missing either is
 * not a two-sided experiment whatever it is called. Used by the report
 * assertion and by the ledger fold, so a hand-written record fails the same
 * checks a live run's record passes.
 */
declare function assertFrozenExperiment(value: unknown): asserts value is FrozenExperiment;
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
declare function assertExperimentReport(report: unknown): asserts report is ExperimentReport;
//#endregion
//#region src/commit.d.ts
/**
 * The durable stages of one commit. A deployment only ever observes them through
 * {@link CommitHost.probe}, the typed test seam that simulates a process exiting
 * at that point.
 */
type CommitStage = 'intent-recorded' | 'write-staged' | 'write-renamed';
/** What one reconciliation of an open intent settled to. */
interface ReconcileOutcome {
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  /** The absolute production target the intent committed. */
  target: string;
  /**
   * `completed-redone`: production still held the pre-commit state, so the same
   * write was redone and the completion recorded. `completed-written`:
   * production already held the committed content, so only the completion was
   * recorded. `blocked`: neither state was found (or the source is gone) — the
   * intent stays open and nothing was written.
   */
  result: 'completed-redone' | 'completed-written' | 'blocked';
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  detail?: string;
}
//#endregion
//#region src/experiment.d.ts

/** One sample as the caller's specification names it. */
interface ExperimentSampleSpec {
  taskId: string;
  role: ExperimentSampleRole;
}
/**
 * The experiment a caller freezes before anything runs (§F.2). Everything here
 * is fixed *before* the first run: samples and their roles, the input snapshot
 * both sides are built from, the model identity, the budget, and the repetition
 * index. Changing any member freezes a different experiment.
 */
interface ExperimentSpec {
  proposalId: string;
  samples: ExperimentSampleSpec[];
  /** The directory whose recursive content is the frozen input both workspaces are built from. */
  snapshot: {
    sourceDir: string;
  };
  /**
   * The deployment's own model selection, frozen before the first run (S4-E
   * §Q3). It reaches every run verbatim as its `agentOptions`, so both sides —
   * and whatever a side's worker decomposes into — run on the route it names,
   * whatever the deployment's default selection becomes afterwards. The
   * promotion gate re-reads the selection off the runs' own session logs.
   */
  model: ModelSelection;
  budget: ExperimentBudget;
  /**
   * This experiment's repetition index. `0` is the first run of the frozen
   * experiment; a higher index is a new, separately budgeted experiment (§F.2:
   * only an explicit new experiment may run and charge budget again).
   */
  repetition: number;
}
/** One experiment call: the frozen specification, the session it runs as, and the caller's cancellation. */
interface ExperimentRequest {
  readonly spec: ExperimentSpec;
  /** The session every replayed run of this experiment is run as. */
  readonly caller: SessionId;
  readonly actor: string;
  readonly signal?: AbortSignal;
}
/**
 * The idempotency key of one sample side (§F.2). All five members together
 * name one run; the module doc says what a repeat of a key means.
 */
interface ExperimentKey {
  proposalId: string;
  /** The prepared candidate's content identity (P2's digest of the materialized `SKILL.md`). */
  preparedContentDigest: string;
  sampleTaskId: string;
  side: ExperimentSide;
  repetition: number;
}
/** One `experiment_started` ledger line: the frozen experiment, recorded before the first run. */
interface ExperimentStartedRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 3` (K2). */
  formatVersion: 3;
  kind: 'experiment_started';
  proposalId: string;
  experimentId: string;
  frozen: FrozenExperiment;
  frozenDigest: string;
  /** The frozen budget, carried on the record as well as inside the block (the fold requires the two to agree). */
  budget: ExperimentBudget;
  /** Report path relative to the ledger root (`sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`). */
  report: string;
  /**
   * The task store every run of this experiment was created in, so a later
   * reader (the promotion gate) can re-read the sides' runs, reviews and
   * evidence without a caller session. Written by the orchestrator; absent only
   * on a record written before the field existed, which the gate refuses by name.
   */
  storeId?: string;
  actor: string;
  at: string;
}
/**
 * One `experiment_sample` ledger line: one sample side's run and what it settled
 * to. Written once per key and never overwritten; a side with no terminal run (a
 * process that died mid-experiment) records `interrupted` and is never re-run
 * under the same key.
 */
interface ExperimentSampleRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 3` (K2). */
  formatVersion: 3;
  kind: 'experiment_sample';
  proposalId: string;
  experimentId: string;
  /** Key part: the candidate content identity this run went through. */
  preparedContentDigest: string;
  sampleTaskId: string;
  side: ExperimentSide;
  repetition: number;
  /** The replayed task this side created. Absent for a side whose run never reached the store. */
  taskId?: string;
  /** The run this side created. Absent for a side whose run never reached the store. */
  runId?: string;
  outcome: 'verified' | 'failed' | 'cancelled' | 'interrupted';
  /** `<taskId>#<runId>` of the terminal ReviewRecord this side cites (the deployment's own review-ref shape). */
  reviewRef?: string;
  /** Evidence ids the run's review record (or, when it has none, the store's evidence bundles) carries. */
  evidenceRefs: string[];
  /** The run's per-criterion verdicts, with the verifier that decided each — the report's criterion detail. */
  criteria: ReviewCriterion[];
  /** The workspace this side's run went through. */
  workspace: string;
  /**
   * The frozen snapshot digest the workspace was built from. A run started by
   * this call measures it right after the build; a side settled from the store
   * after a crash records the digest the workspace *was built from* — by then
   * the run has written into the directory, so re-digesting it would measure the
   * run's output, not its input. Absent only for an `interrupted` side whose
   * workspace cannot be re-proved.
   */
  initialDigest?: string;
  cost: ExperimentCost;
  /** Why this side has no terminal run; required for `interrupted`. */
  reason?: string;
  actor: string;
  at: string;
}
type ExperimentRecord = ExperimentStartedRecord | ExperimentSampleRecord;
/** True for a record of the experiment family — the lines the proposal fold must leave alone. */
declare function isExperimentRecord(record: {
  kind: string;
}): record is ExperimentRecord;
/** One experiment's folded view: its started record plus every sample record written under it. */
interface ExperimentView {
  experimentId: string;
  proposalId: string;
  frozen: FrozenExperiment;
  frozenDigest: string;
  budget: ExperimentBudget;
  report: string;
  /** The task store this experiment's runs were created in (see {@link ExperimentStartedRecord.storeId}). */
  storeId?: string;
  /** The `experiment_started` record's own timestamp. */
  at: string;
  /** Sample records in ledger order. */
  samples: ExperimentSampleRecord[];
}
/**
 * The ledger as this module uses it: the proposal it evaluates, the prepared
 * candidate's verified bytes, the folded experiment family, and the two
 * append-only writes. `EvolutionService` is the only implementation.
 */
interface ExperimentLedger {
  /** Absolute ledger directory; the sandbox, the workspaces and the report live under it. */
  readonly root: string;
  get(proposalId: string): Promise<EvolutionProposal>;
  /** Read the prepared candidate's bytes and verify them against the identity recorded at prepare (P2); throws otherwise. */
  readSkillCandidate(proposalId: string): Promise<Buffer>;
  /** One experiment's folded view; throws on an unknown id. */
  experiment(experimentId: string): Promise<ExperimentView>;
  /**
   * Every experiment folded under one proposal, newest first. One call answers
   * both questions a run has about the ledger: which sample keys are already
   * spent, and by which frozen experiment.
   */
  experiments(proposalId: string): Promise<ExperimentView[]>;
  /** Record the frozen experiment (idempotent by identity: an identical record is a no-op, a different one refuses). */
  recordExperimentStart(record: ExperimentStartedRecord): Promise<void>;
  /** Record one sample side. A key that is already recorded refuses a different content by name. */
  recordExperimentSample(record: ExperimentSampleRecord): Promise<void>;
}
/** One accepted provider verdict, as a freeze reads it off the runtime's own pre-check (the members it records, and no more). */
interface PrecheckSkillVerdict {
  readonly valid: boolean;
  readonly name: string;
  readonly role?: string;
  readonly contractDigest?: string | null;
  readonly contentDigest?: string;
  readonly defects?: readonly {
    readonly code: string;
    readonly detail: string;
  }[];
}
/** The runtime's provider pre-check as the freeze consumes it (`TaskRuntime.capabilityProviderReport`). */
interface ProviderPrecheckView {
  readonly capabilities: readonly {
    readonly capability: string;
    readonly skills: readonly PrecheckSkillVerdict[];
  }[];
  readonly revision: string;
}
/** The services one experiment reads, as the caller's context holds them. */
interface ExperimentSources {
  readonly evolution: ExperimentLedger;
  readonly graphs: {
    graphForSession(sessionId: SessionId): Promise<{
      readonly rootSessionId: SessionId;
    }>;
  };
  readonly task: {
    openStore(storeId: string): Promise<TaskSnapshot>;
  };
  readonly taskRuntime: {
    replayTask(storeId: string, championTaskId: string, options: ReplayTaskOptions, callerSessionId: string): Promise<ReplayRunOutcome>;
    /**
     * The runtime's own provider pre-check for one session's viewpoint (S4-E
     * §Q3): the freeze reads the production configuration's provider identity
     * for a sample's rows through the same entry `capability_list` renders, so
     * the identity a gate later compares against is the runtime's own
     * conclusion, never this plane's guess.
     */
    capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheckView>;
    /** The effective capability table, as the runtime holds it — the rows a pre-check covered and the servers they grant. */
    listCapabilities?(): Readonly<Record<string, CapabilityConfig>>;
  };
  /**
   * The registered judge vocabulary at freeze time (S4-E §Q3), or `undefined`
   * when the deployment cannot list it — which is a named refusal for every
   * criterion, since a frozen criterion has to pin a registered versioned
   * verifier. Read through the same helper every provider check uses.
   */
  verifierVocabulary?(): Promise<VerifierVocabularyView | undefined>;
}
/** What one experiment call produced. */
interface ExperimentResult {
  proposalId: string;
  experimentId: string;
  /** The report as recorded; its bytes are exactly the file at {@link ExperimentResult.reportPath}. */
  report: ExperimentReport;
  /** Report path relative to the ledger root. */
  reportPath: string;
  /** The folded ledger view the report was recomputed from. */
  experiment: ExperimentView;
}
/** The lineage tag one sample side's replayed task carries — how a run is found again after a crash. */
declare function experimentLineage(experimentId: string, sampleTaskId: string, side: ExperimentSide): string;
/** The experiment id: a digest of the proposal and the frozen block, so a differently frozen experiment never shares one. */
declare function experimentIdOf(proposalId: string, frozenDigest: string): string;
/** The report path one experiment's evidence lands at, relative to the ledger root. */
declare function experimentReportPath(proposalId: string, experimentId: string): string;
/** The one string form of a sample key (map key, refusals, the ledger's own uniqueness check). */
declare function experimentSampleKey(key: ExperimentKey): string;
/** A sample key as a reader sees it: the sample and the side it names. */
declare function experimentSampleLabel(key: ExperimentKey): string;
/**
 * The recursive content digest of a directory — the input snapshot identity
 * (§F.2): every regular file's relative path and byte digest, sorted by path,
 * hashed together. A symbolic link is not an input of its own: the snapshot's
 * policy (`snapshot-input.ts`) resolves every link inside the root first, so the
 * digest covers the bytes a workspace built from the snapshot holds — a link to
 * a file contributes that file's bytes, a link to a directory contributes the
 * subtree it names, and whatever the target text spells contributes nothing. A
 * link that escapes the root, loops, or names something unreadable is refused by
 * name, never ignored into a digest the source does not have.
 */
declare function directoryDigest(directory: string): Promise<string>;
/**
 * The evidence ids of one run: the review record's own list, or the store's
 * bundles for that run when there is no review. Exported because the promotion
 * gate re-reads exactly this fact from the store — one rule for what a side's
 * evidence is, not two.
 */
declare function evidenceRefsOf(snapshot: TaskSnapshot, runId: string | undefined, review: ReviewRecord | undefined): string[];
/** The registered judge vocabulary one freeze reads: the ids and declared versions the runs are judged by. */
interface VerifierVocabularyView {
  readonly ids: readonly string[];
  readonly versions: Readonly<Record<string, string>>;
}
/** The key one frozen sample's side has under one experiment. */
declare function experimentSampleKeyOf(view: Pick<ExperimentView, 'proposalId' | 'frozen'>, sampleTaskId: string, side: ExperimentSide): ExperimentKey;
/**
 * Build the v2 report from the ledger records alone — the same records always
 * give the same report, its `at` included. An experiment missing a side has no
 * report: an incomplete comparison is not evidence, and saying so is the honest
 * answer.
 */
declare function buildExperimentReport(view: ExperimentView): ExperimentReport;
/**
 * Run — or continue — the frozen two-sided experiment, and return the report the
 * ledger records. Idempotent per sample key: a recorded side is reused, an
 * in-flight side is settled from the store and never re-run, and only a side
 * that never ran is started. Every refusal throws with its reason, and the runs
 * that did settle stay in the task store and in the ledger.
 *
 * The frozen budget bounds this whole experiment on the one entry point this
 * plane has: the token total the settled sides reported. A side the budget has no
 * room for is not started, and the refusal names the ceiling and the recorded
 * total; what a settled side really spent is the gate's half of the same rule.
 * Each Run's clock is the runtime's own — this plane places none.
 */
declare function runExperiment(sources: ExperimentSources, request: ExperimentRequest): Promise<ExperimentResult>;
/**
 * Resume a frozen experiment by id: its specification *is* the frozen block, so
 * a caller needs to remember nothing but the id. The block is re-derived from
 * the current world before anything runs, and the re-derivation must reproduce
 * the recorded one — a candidate, a sample contract, a model or a snapshot that
 * moved since the experiment froze is refused by name rather than run under a
 * different identity.
 */
declare function resumeExperiment(sources: ExperimentSources, request: {
  experimentId: string;
  caller: SessionId;
  actor: string;
  signal?: AbortSignal;
}): Promise<ExperimentResult>;
/**
 * Validate one `experiment_started` line in its own right: the proposal it names
 * exists, the experiment id, frozen digest, budget and report path are exactly
 * what the frozen block derives. Used by the fold and by the service's own write
 * path, so a line that reaches the append is checked the same way one read back
 * from the file is.
 */
declare function assertExperimentStartRecord(record: ExperimentStartedRecord, proposals: ReadonlyMap<string, EvolutionProposal>): void;
/**
 * Fold the ledger's experiment family: every `experiment_started` opens an
 * experiment, every `experiment_sample` must belong to one, and the sample key
 * is unique across the whole ledger. A hand-forged line fails exactly the checks
 * a live write passes — the frozen block is re-hashed, the id re-derived, the
 * budget re-compared, and the record's key parts re-checked against the
 * experiment it claims — so the read path and the write path agree on what a
 * record is.
 *
 * The proposal fold is the other half of the same ledger and is not this
 * function's business; the caller passes its result in for the one cross-check
 * that spans the two (`experiment_started` must name a real proposal).
 */
declare function foldExperiments(records: readonly {
  kind: string;
}[], proposals: ReadonlyMap<string, EvolutionProposal>): Map<string, ExperimentView>;
//#endregion
//#region src/evolution.d.ts
type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4';
type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'gated' | 'decided' | 'applied' | 'rolledback';
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH';
declare const EVOLUTION_LEVELS: readonly EvolutionLevel[];
declare const EVOLUTION_DECISIONS: readonly EvolutionDecision[];
/**
 * The one target type `evolution_apply` promotes mechanically (W16): the
 * sandbox copy lands on the production skill root. Every other type has no
 * executor in this build — a capability row, an agent_preset directory and a
 * task_definition were written by an older build and are not written here.
 */
declare const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[];
/** skill mutation: the full SKILL.md text for `<skills root>/<name>/SKILL.md`. */
interface SkillMutation {
  name: string;
  content: string;
}
/**
 * The champion snapshot of one prepared proposal. `captured` is the only state
 * there is: this build replaces an existing production `SKILL.md`, so a target
 * that is not there has nothing to prepare from and is refused before any
 * sandbox write, and every `prepared` record the fold admits carries the
 * snapshot's state. The bookkeeping-only prepare (`none` — nothing materialized,
 * no anchor) belonged to target types this build's candidate never admits and
 * has no producer or consumer left (S4-E 收尾).
 */
type ChampionState = 'captured';
/** Folded view of one `prepared` record. */
interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null;
  mechanical: boolean;
  champion: ChampionState;
  /** The content identity recorded for the materialized candidate `SKILL.md` (P2) — every prepare records it. */
  skillContent?: SkillContentIdentity;
  /**
   * The content identity of the production `skills/<name>/SKILL.md` as it stood
   * at prepare (P3) — from the same single read that produced the champion
   * snapshot, so snapshot and digest can never disagree. Every prepare records
   * it; a captured champion without it cannot prove its baseline and refuses a
   * new apply.
   */
  skillBaseline?: SkillContentIdentity;
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[];
}
/**
 * The minimal Validation Gate (细化想法4.md §32, verbatim questions):
 *   1. Target failure fixed?
 *   2. Original acceptance maintained?
 *   3. Existing regression maintained?
 *   4. No unacceptable side effects?
 *   5. Holdout performance acceptable?
 *   6. Resource cost acceptable?
 * All six answers are required free text. Question 3 additionally requires
 * evidence refs (test/replay evidence ids or paths) whose existence is checked
 * — the track validates that the evidence is there, it never executes it.
 */
interface GateAnswers {
  /** Answer to "1. Target failure fixed?" */
  targetFailureFixed: string;
  /** Answer to "2. Original acceptance maintained?" */
  originalAcceptanceMaintained: string;
  /** Answer to "3. Existing regression maintained?" */
  existingRegressionMaintained: string;
  /** Answer to "4. No unacceptable side effects?" */
  noUnacceptableSideEffects: string;
  /** Answer to "5. Holdout performance acceptable?" */
  holdoutPerformanceAcceptable: string;
  /** Answer to "6. Resource cost acceptable?" */
  resourceCostAcceptable: string;
  /** Evidence behind the regression/replay answers: evidence ids or paths, existence-checked, never executed. */
  regressionEvidenceRefs: string[];
}
/**
 * One immutable ledger line, `formatVersion: 3` throughout (K2). A state
 * migration appends a new record; nothing is ever rewritten in place. The
 * version is the whole ledger's, not one line's: a line declaring anything but
 * 3 — or declaring nothing — makes the ledger refuse to load, and no entry here
 * writes one.
 */
type EvolutionRecord = {
  formatVersion: 3;
  kind: 'proposed';
  proposalId: string;
  targetType: ProposalTargetType;
  targetId: string;
  baseVersion: string;
  level: EvolutionLevel;
  rationale: string;
  sourceRefs: string[];
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'candidate';
  proposalId: string;
  /** Complete version set the candidate aligns to (branch-model bookkeeping; this build creates no real branch). */
  versionSet: Record<string, string>;
  /**
   * The structured patch description, shaped by the proposal's targetType
   * (see the *Mutation interfaces) and always recorded: this build's
   * candidate is a single-file `SKILL.md` replacement, so a candidate that
   * carries nothing to materialize and evaluate would be a flow going
   * nowhere. Every line `candidate` writes holds one; a line written before
   * that rule (or by hand) folds to a candidate with no next state,
   * because `prepared` is the one transition a candidate admits.
   */
  mutation: unknown;
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'prepared';
  proposalId: string;
  /**
   * Sandbox dir relative to the ledger root. Every prepare this build
   * writes materializes one; nullable in the type only so a hand-forged
   * line naming none is refused by name at the fold.
   */
  sandbox: string | null;
  /** True on every prepare the fold admits: this build's candidate is a materialized skill mutation. */
  mechanical: boolean;
  /** Always `captured`: a prepare snapshots the production bytes it replaces. */
  champion: ChampionState;
  /**
   * The content identity of the materialized candidate `SKILL.md` (P2) — the
   * skill name plus the SHA-256 of the exact file bytes. Required: the fold
   * refuses a prepare without it, so a candidate nothing can re-verify never
   * becomes a flow.
   */
  skillContent?: SkillContentIdentity;
  /**
   * The content identity of the production `SKILL.md` as it stood at prepare
   * (P3), from the same read that produced the champion snapshot. Required:
   * the fold refuses a prepare without it, so a captured champion always
   * names the baseline a later apply compares production against.
   */
  skillBaseline?: SkillContentIdentity;
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[];
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'gated';
  proposalId: string;
  gate: GateAnswers;
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'decided';
  proposalId: string;
  decision: EvolutionDecision;
  note?: string;
  /**
   * Human-review evidence: the approval call id of the evolution_decide
   * request that granted this decision, the same `approval:<callId>` shape
   * as applied/rolledback. Required: `decide` writes it on both of its
   * paths, and the fold refuses a decided line without one.
   */
  approvalRef?: string;
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'applied';
  proposalId: string;
  /** Production write targets, for audit (absolute paths). */
  targets: string[];
  /** Human-review evidence: the approval call id of the evolution_apply request that granted this write. */
  approvalRef: string;
  /**
   * The open commit intent this completion closes (K2): the
   * `commit_intent` line persisted before the write. Required — the fold
   * refuses a completion with no matching open intent.
   */
  intentId: string;
  actor: string;
  at: string;
} | {
  formatVersion: 3;
  kind: 'rolledback';
  proposalId: string;
  /** Production write targets of the rollback (restored champion or deleted product), for audit. */
  targets: string[];
  /** Human-review evidence: the approval call id of the evolution_rollback request that granted this write. */
  approvalRef: string;
  /** The open commit intent this completion closes (K2) — see `applied`. */
  intentId: string;
  actor: string;
  at: string;
}
/** The commit intent (K2) — see {@link CommitIntentRecord}. */ | CommitIntentRecord
/**
 * The experiment family (S4-E §F.2): the two-sided skill evaluation's frozen
 * identity and its per-sample runs. These lines are not lifecycle transitions
 * — an experiment does not move a proposal's status — so the proposal fold
 * leaves them alone and {@link foldExperiments} folds them. Their records
 * carry the ledger's own `formatVersion: 3` as well; the experiment *report*
 * at `experiment-report.json` has its own, separate version field.
 */ | ExperimentStartedRecord | ExperimentSampleRecord;
/** Which way one commit moves a production target. */
type CommitDirection = 'apply' | 'rollback';
/**
 * One `commit_intent` ledger line (K2): the durable "this apply/rollback is now
 * underway" record, written before production changes and closed by the
 * completion line that names the same `intentId`.
 *
 * It carries everything a recovery needs without trusting memory: which
 * proposal and direction, which human grant, the absolute production target, the
 * digest production must hold before the write (`baselineSha256`) and the digest
 * it must hold after (`contentSha256`), and the bytes to write again as a path
 * relative to the ledger root (`source`) — the candidate file for an apply, the
 * champion snapshot for a rollback. The id is derived, not chosen:
 * `<proposalId>/<direction>`.
 *
 * The line is not a lifecycle transition: it does not move the proposal's
 * status, so the proposal fold records it as {@link EvolutionProposal.openIntent}
 * and leaves the state machine alone. A proposal has at most one open intent,
 * and only one of them can close it (see the fold's admission rules).
 */
interface CommitIntentRecord {
  /** The `proposals.jsonl` format version — the ledger is one format, `formatVersion: 3` (K2). */
  formatVersion: 3;
  kind: 'commit_intent';
  /** `<proposalId>/<direction>` — the derived id the completion line must repeat. */
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  /** The human grant that authorised this commit (`approval:<callId>`), recorded on the completion as well. */
  approvalRef: string;
  /** The absolute production path this commit replaces. */
  target: string;
  /** The digest production must hold before the write — the state a reconciliation redoes the write from. */
  baselineSha256: string;
  /** The digest production must hold after the write. */
  contentSha256: string;
  /** The recoverable bytes, relative to the ledger root. */
  source: string;
  actor: string;
  at: string;
}
/** Folded view of one open `commit_intent` record, as {@link EvolutionProposal} exposes it. */
interface CommitIntentView {
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  approvalRef: string;
  target: string;
  baselineSha256: string;
  contentSha256: string;
  source: string;
  actor: string;
  at: string;
}
/** Folded view of one `applied` or `rolledback` record. */
interface ApplyView {
  targets: string[];
  approvalRef: string;
}
/** What an apply/rollback changed, returned to the tool layer. */
interface ApplyOutcome {
  proposal: EvolutionProposal;
  targets: string[];
  /**
   * Set only when this call found a commit intent already open for the proposal
   * and settled it instead of starting a new commit (K2): `redone` — production
   * still held the pre-commit state, so the same operation was carried out;
   * `written` — production already held the committed content (the write had
   * landed, its completion had not), so only the completion was recorded.
   * Absent on a fresh commit, and on a proposal with nothing open.
   */
  recovered?: 'redone' | 'written';
  /**
   * What the promotion check validated about the providers this apply put in
   * place ({@link PromotionCheck.providers}): the candidate skill of a skill
   * apply, with the role it may be counted as, so a knowledge or guidance
   * provider is reported as such rather than presented as the execution
   * provider it is not. Empty when the target carries no provider. Not
   * persisted: the ledger's `applied` record keeps its shape, and a run's own
   * binding is where a selected role is recorded for real. Absent when this
   * call settled an open intent: a recovery does not re-run the promotion gate
   * (the approval and the evidence it already rested on are on the ledger), so
   * it reports what it did and not a second provider verdict.
   */
  providers?: readonly PromotionProvider[];
}
/**
 * One provider a promotion check judged, with the role it may be counted as.
 * The role vocabulary is the validator's, not a second opinion: this value is
 * read off a {@link SkillProviderVerdict} the unified pre-check produced.
 */
interface PromotionProvider {
  /** The skill name a capability grants (or the candidate skill's own name). */
  readonly name: string;
  /**
   * `execution-provider` is the only role that may close an execution gap
   * (`executionProviders`); `knowledge` and `guidance` are loadable content a
   * promotion may put in place, and neither ever counts as an execution
   * provider — they are recorded, not upgraded.
   */
  readonly role: 'execution-provider' | 'knowledge' | 'guidance';
  /** {@link skillContentDigest} of the bytes the verdict was taken from. */
  readonly contentDigest: string;
  /** Execution providers only: the declared verifier ref, proven registered against the live vocabulary. */
  readonly verifierRef?: string;
}
/**
 * What a promotion check validated (S1-C item 3). Returned by
 * {@link EvolutionService.checkPromotion} so the entries that gate on it (the
 * two tools and the service's own `decide` / `apply`) can report the roles
 * instead of re-deriving them.
 */
interface PromotionCheck {
  /** One entry per provider this promotion puts in place; empty for a target type that carries none (`agent_preset`, `task_definition`, bookkeeping-only). */
  readonly providers: readonly PromotionProvider[];
}
/** One provider role per line, for a decision or apply report. */
declare function renderProviderRoles(providers: readonly PromotionProvider[]): string[];
/** The folded view of one proposal: its `proposed` record plus everything later records added. */
interface EvolutionProposal {
  proposalId: string;
  targetType: ProposalTargetType;
  targetId: string;
  baseVersion: string;
  level: EvolutionLevel;
  rationale: string;
  sourceRefs: string[];
  status: EvolutionStatus;
  versionSet?: Record<string, string>;
  /** The candidate's structured mutation, verbatim as recorded. */
  mutation?: unknown;
  prepared?: PreparedView;
  gate?: GateAnswers;
  decision?: EvolutionDecision;
  decisionNote?: string;
  /** Approval evidence of the decided record, when it carries one (every new record does). */
  decisionApprovalRef?: string;
  applied?: ApplyView;
  rolledback?: ApplyView;
  /**
   * The commit intent this proposal has open (K2): a production write is
   * underway and its completion line has not been recorded. At most one at a
   * time. It does not move {@link status} — an interrupted apply is still
   * `decided`, an interrupted rollback still `applied` — which is exactly why a
   * retry can tell "nothing was committed yet" from "everything was".
   */
  openIntent?: CommitIntentView;
  /** One entry per ledger record, oldest first — derived, never stored. */
  history: {
    status: EvolutionStatus;
    actor: string;
    at: string;
  }[];
}
interface ProposeInput {
  proposalId: string;
  targetType: ProposalTargetType;
  targetId: string;
  baseVersion: string;
  level: EvolutionLevel;
  rationale: string;
  sourceRefs: string[];
}
interface ListFilter {
  status?: EvolutionStatus;
  targetType?: ProposalTargetType;
  targetId?: string;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    evolution: EvolutionService;
  }
}
/** Plugin config; every field optional — the constructor resolves defaults. */
interface Config {
  /**
   * Directory of the ledger file `proposals.jsonl`; sandboxes materialize under
   * `<root>/sandbox/<proposalId>/`. Omitted resolves to `$DSH_HOME/evolution`,
   * falling back to `<repoRoot>/.dsh/evolution` when `DSH_HOME` is unset (same
   * derivation as the verifier's evidenceRoot).
   */
  root?: string;
  /** Production skill root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/skills`. */
  skillRoot?: string;
  /**
   * The harness repo root: the parent of the `$DSH_HOME` fallback
   * (`<repoRoot>/.dsh`) and the base relative evidence refs resolve against.
   *
   * It is a configuration member rather than something this package derives:
   * the ledger used to sit at the depth of the harness source tree, and this
   * package does not — a derivation here would silently move every default. The
   * assembly computes it at its own location (`new URL('../../../../',
   * import.meta.url)`) and passes it in. A direct construction that omits it
   * (a test, an embedding process) reads relative refs against the process's
   * working directory instead.
   */
  repoRoot?: string;
  /**
   * Resolves the model selection this plane freezes with an experiment and
   * re-reads before a promotion — the deployment's own default selection, as a
   * structured `{ provider, model, reasoningEffort?, maxTokens? }` (S4-E §Q3).
   *
   * It is injected, not derived here: the deployment knows which selection its
   * sessions and the replay spawns run under, and the process this package runs
   * in has no agent of its own to ask. The assembly
   * (`@dangosys/dsh-singularity-agent`) wires it to the same source the
   * experiment tool freezes from — one resolver, so the selection a report is
   * frozen under is exactly the one the gate compares against, and the one every
   * replayed spawn is placed under.
   *
   * A selection must be structured to be usable: absent, answering nothing, or
   * answering something without a provider and a model is a refusal at both
   * entries (fail-closed). Neither silently skips the check, and the frozen
   * selection is never parsed back out of a display string.
   */
  modelSelection?: () => ModelSelection | undefined;
  /**
   * The typed test seam of the commit path (K2): it fires at each durable stage
   * of one commit — after the `commit_intent` line is on disk, after the new
   * bytes are staged and fsynced beside the production target but before the
   * rename, and after the rename has been read back and verified. Throwing from
   * it aborts the commit exactly where it stands: the intent stays open and no
   * later stage runs, which is how a process exit between two durable writes is
   * simulated. A production deployment never sets it; there is no other way to
   * observe or interrupt a commit.
   */
  commitProbe?: (stage: CommitStage) => void;
}
/**
 * The production write targets of an apply (and its matching rollback), for
 * the approval reason and the audit record — the human sees exactly what a
 * grant will touch. One file: the candidate's `SKILL.md`, which is what this
 * build's executor writes and restores.
 */
declare function applyTargets(proposal: EvolutionProposal, roots: {
  skillRoot: string;
}): string[];
/**
 * The Evolution plane ledger (plane separation: this store is independent of
 * the task store and refers to it by id only). Folding and appending share one
 * fold, so a corrupt or out-of-order log fails loudly instead of silently
 * drifting. Writes are serialized; the file is opened per append, so closing
 * the service is just draining the write queue. Sandbox materialization is the
 * only other write, confined to `<root>/sandbox/<proposalId>/`.
 */
declare class EvolutionService extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string;
  /** Production skill root — champion snapshots read from here; apply/rollback write here. */
  readonly skillRoot: string;
  /** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
  readonly repoRoot: string;
  /** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
  private readonly resolveModelSelection?;
  /** The commit path's typed test seam, if this instance was built with one (see {@link Config.commitProbe}). */
  private readonly commitProbe?;
  private records;
  private readonly loaded;
  private writes;
  private commits;
  constructor(ctx: Context, config?: Config);
  /** Ledger file path (`<root>/proposals.jsonl`). */
  get file(): string;
  /**
   * The model selection this deployment's runs share — the one the experiment
   * freezes before anything runs, passes to each replayed spawn verbatim, and
   * the promotion gate re-reads from the runs' own session logs
   * ({@link Config.modelSelection}).
   *
   * Fail-closed: no resolver, a resolver that throws, or one that answers
   * anything but a structured selection with a provider and a model is a named
   * refusal. The experiment tool freezes this value, so a deployment that cannot
   * name its selection can neither evaluate nor promote a candidate — and
   * neither case silently skips the check.
   */
  modelSelection(): ModelSelection;
  propose(input: ProposeInput, actor: string): Promise<EvolutionProposal>;
  /**
   * Move proposed → candidate, recording the complete version set the candidate
   * aligns to and the structured patch it carries. `mutation` is required and
   * shaped by the proposal's targetType: a candidate the ledger cannot
   * materialize and evaluate is a flow going nowhere, so it is refused here,
   * before the first candidate line is written. A proposal whose mutation does
   * not survive {@link validateMutation} stays exactly as it was.
   *
   * **A skill candidate only** (§F.2): a capability, agent_preset,
   * task_definition or bookkeeping-only proposal stays the recorded suggestion
   * `evolution_propose` wrote and is refused here by name, before the first
   * ledger line of the candidate lifecycle. Its proposal keeps its place in the
   * ledger — a record is not a candidate.
   */
  candidate(proposalId: string, versionSet: Record<string, string>, actor: string, mutation: unknown): Promise<EvolutionProposal>;
  /**
   * Move candidate → prepared: confirm the production `SKILL.md` this candidate
   * replaces, materialize the skill mutation into `<root>/sandbox/<proposalId>/`
   * and snapshot those same champion bytes under `champion/` — the anchor for
   * the experiment's baseline and for rollback.
   *
   * The production read comes first, before any sandbox or ledger write: this
   * build replaces an existing single-file `SKILL.md`, so a target that is not
   * there has nothing to prepare, and a prepare that found none writes nothing
   * at all. That one read yields both the snapshot and `skillBaseline` (P3),
   * the digest the later apply compares the production target against.
   *
   * The candidate also records `skillContent` (P2): the name plus the SHA-256 of
   * the exact bytes of the file that was actually materialized (read back from
   * disk, never re-rendered from the mutation string), so the experiment, the
   * gates, and apply can verify this exact content later.
   */
  prepare(proposalId: string, actor: string): Promise<EvolutionProposal>;
  /**
   * Move prepared → gated: all six Gate answers plus regression evidence refs.
   * Every ref must exist — a path on disk (relative to the repo root or
   * absolute) or an id the caller-side resolver knows (task-store evidence).
   * Existence only; nothing here executes anything. A **skill** proposal must
   * have a completed two-sided experiment and cite that experiment's report
   * (§F.2); the six answers are recorded over it.
   */
  gate(proposalId: string, answers: GateAnswers, actor: string, refKnown?: (ref: string) => Promise<boolean>): Promise<EvolutionProposal>;
  /**
   * Move gated → decided. Callers (the evolution_decide tool) must have a
   * human grant from `ctx.approval.request` before calling this and pass its
   * call id as `approvalRef` (`approval:<callId>`, the applied/rolledback
   * shape) — the service only records, and the ref makes the human review
   * auditable from the ledger alone. A rejected or cancelled ask must never
   * reach this method.
   */
  decide(proposalId: string, decision: EvolutionDecision, actor: string, approvalRef: string, note?: string): Promise<EvolutionProposal>;
  /**
   * Move decided → applied: copy the sandbox materialization into production
   * (W16), as one commit. Reachable only for a PROMOTE decision on a materialized
   * skill mutation at L1–L3 (the state machine itself refuses anything else —
   * every other target type has no executor in this build); the caller (the
   * evolution_apply tool) must hold a human grant from `ctx.approval.request`
   * first, exactly as for decide. The sandbox `SKILL.md` replaces the production
   * one (the champion snapshot covers that file only, so the write is
   * file-level, never a directory delete).
   *
   * The commit order is the recovery rule (K2): the `commit_intent` line is
   * persisted first — proposal, direction, this approval, the absolute target,
   * the content identity production must hold before (`prepared.skillBaseline`
   * P3) and after (`prepared.skillContent` P2), and the sandbox candidate as the
   * recoverable source — then the target is replaced atomically, then the
   * `applied` record closes the intent. A failure at any stage leaves the intent
   * open and nothing half-written: the production file is one complete version or
   * the other, and {@link reconcile} (or a retry of this call) settles the intent
   * from what production actually holds. Nothing here trusts a promise or a
   * caller-supplied "approved".
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and before the intent is recorded: the production target must still be
   * the one prepare recorded. A direct service call therefore cannot bypass the
   * check the tool already ran before asking for approval.
   *
   * The promotion check (S1-C item 3) runs here too, before the intent is
   * recorded: a candidate whose provider role changed while the human was
   * deciding (a sidecar that appeared in the sandbox, a verifier that was
   * unregistered) is refused here, so no entry can write something a later
   * admission would have refused.
   *
   * When this proposal already has an open intent — the process died before the
   * completion landed — this call does not ask for another approval and does not
   * re-run the promotion gate: the recorded intent already binds the grant and
   * the content it was approved against, and the only question left is what
   * production holds. It settles that intent ({@link reconcile}, one intent) and
   * reports it as {@link ApplyOutcome.recovered}.
   */
  apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome>;
  /**
   * Preflight for tools before asking for approval; mutation methods repeat the
   * check. Returns the providers the promotion would put in place, each with the
   * role it may be counted as, so the callers that already gate on this check
   * can report them.
   *
   * Only a `skill` proposal is promotable in this build (EVAL-4/§F.2): every
   * other target type is refused by name — a type with no evaluator gets no
   * promotion, and a record of one is never upgraded into new evidence
   * ({@link noEvaluatorRefusal}).
   *
   * For a skill candidate three checks run here, in this order, all of them
   * shared with the service entry the tools ultimately call:
   *
   * 1. P2: the candidate bytes must still be the ones prepare recorded.
   * 2. S1-C item 3: the provider check. The candidate's sandbox directory is
   *    judged by the same {@link validateSkillProvider} admission and config
   *    load the rest of the system uses, so `evolution_apply` is not the only
   *    entry that knows what a usable provider is — and a candidate carrying an
   *    execution sidecar with an unregistered verifier or ungranted tools is
   *    refused here, before a human is asked, before `decided` is recorded, and
   *    before anything is written.
   * 3. The evidence gate (`assertSkillPromotionEvidence`): a completed two-sided
   *    experiment whose report, runs, reviews, evidence, frozen inputs, judge,
   *    model, verdict and cost still hold. Every one of them is re-read from the
   *    ledger, the store and the production workspace — the tools run all of it
   *    before asking a human, and decide(PROMOTE) / apply run it again on the
   *    service entry, so evidence that moved while the human was deciding is
   *    still refused.
   */
  checkPromotion(proposalId: string): Promise<PromotionCheck>;
  /**
   * The services the promotion gate re-reads from this context: the experiment
   * family of this same ledger, the task store the experiment names, the live
   * verifier vocabulary, this deployment's model selection and its session
   * logs. Resolved softly
   * one by one, so a context that cannot offer one gets a refusal naming it
   * rather than a gate that silently checks less.
   */
  private promotionSources;
  /**
   * One session's own durable log, read through the deployment's session plane
   * (`sessionQuery.readSession`) — the source the promotion gate re-reads a
   * run's real requests from (S4-E §Q3). `undefined` when the deployment cannot
   * serve the read at all, which the gate reports as a named refusal rather than
   * skipping the check; a session the store does not hold throws, and the gate
   * names that too.
   */
  private sessionLog;
  /**
   * The candidate skill's provider verdict, taken from the directory the
   * promotion would write — plus the executor boundary this promotion cannot
   * cross.
   *
   * The boundary: the commit promotes a **single `SKILL.md`**, so a
   * candidate whose directory carries anything else (`SKILL.contract.json`, a
   * `references/` or `scripts/` tree, any other file) is refused here by name.
   * The executor is not being extended to multi-file candidates; what is being
   * refused is the promotion of a candidate whose declaration or resources
   * production would never receive — a promotion that reported an
   * `execution-provider` role (or a content identity covering files nobody
   * wrote) for content that does not exist is exactly the false record this
   * refusal prevents.
   *
   * Both the shape and the declaration are named when both are wrong: the
   * validator's own defects stay in the message with their codes, so this entry
   * reports the same defect vocabulary admission, config load and capability
   * replacement report for the same directory.
   */
  private assertSkillCandidateProvider;
  /**
   * One provider candidate judged by the unified validator, with the sources the
   * deployment actually has:
   *
   * - the effective capability table (the runtime registry — what a restart
   *   re-reads from `config.yml`), asked through `capabilityToolQuery`, so a
   *   capability's grant is read by the same resolution admission performs;
   * - the registered verifier vocabulary, `ready()` first, fail-closed: an
   *   execution sidecar whose ref cannot be proven registered against a live
   *   registry is refused with the same named defect the admission pre-check
   *   uses rather than assumed valid.
   *
   * A context with no runtime registry at all answers every capability question
   * as unreadable instead of as "granting nothing": an execution provider is then
   * refused (fail-closed), while knowledge and guidance — which make no tool
   * claim — are judged by the same validator as everywhere else.
   */
  private providerVerdict;
  /**
   * The capability table this service judges providers against: the running
   * registry, which is the table a restart re-reads from `config.yml` and the one
   * `evolution_prepare` snapshots the champion from. Absent (no task-runtime in
   * this context) means the table cannot be read — reported as an unreadable
   * grant rather than mistaken for an empty table.
   */
  private capabilityToolAnswer;
  /** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
  private effectiveCapabilities;
  /**
   * Read a prepared skill candidate's materialized bytes and verify them
   * against the content identity recorded at prepare (P2). The one read path
   * every stage shares: the experiment's pre-run check, every promotion gate,
   * and the apply write.
   * Throws — never silently re-digests — when the candidate file is missing,
   * is not a regular file, its path crosses a symbolic link, or its bytes no
   * longer match the recorded digest.
   */
  readSkillCandidate(proposalId: string): Promise<Buffer>;
  /**
   * The production-baseline check (P3), on the apply seams only: the
   * evolution_apply tool runs it before asking a human, and `apply` runs it
   * again immediately before the production write, so a baseline that moved
   * while the human was deciding is still refused and a direct service call
   * cannot bypass it. Nothing here writes, merges, or overwrites — a conflict
   * only throws.
   *
   * The prepare-time baseline is a real regular file whose bytes still hash to
   * the digest prepare recorded. A file that changed, disappeared, changed type
   * (now a directory), or sits behind a symbolic link (the file itself or an
   * ancestor) is a conflict. Only `targetType: skill` carries a baseline; every
   * other targetType passes untouched.
   */
  checkProductionBaseline(proposalId: string): Promise<void>;
  private assertProductionBaseline;
  private readVerifiedSkillCandidate;
  /**
   * Move applied → rolledback: undo the apply by restoring the champion
   * `SKILL.md` snapshot taken at prepare, as one commit — the same intent →
   * atomic write → completion order as apply, so an interrupted rollback is
   * recoverable the same way. A record of another target type has no executor
   * here: this build writes and restores a single `SKILL.md` only, and an
   * applied capability row or preset directory is refused by name rather than
   * touched. Same approval discipline as apply: the tool asks a human first, the
   * service only executes and records.
   *
   * A rollback restores *this* proposal's baseline and nothing else, so both
   * ends are re-verified before the intent is recorded: production must still
   * carry exactly the content this proposal applied (`prepared.skillContent`,
   * P2), and the champion snapshot must still hash to the baseline prepare
   * recorded (`prepared.skillBaseline`, P3). A target a later proposal — or any
   * other writer — changed since is refused by name with nothing written, and so
   * is a snapshot that can no longer reproduce the bytes it captured: neither
   * may be papered over by restoring an old version on top of a newer one.
   *
   * As in {@link apply}, an open intent of this proposal is settled rather than
   * duplicated, and the result reports the recovery.
   */
  rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome>;
  /**
   * Settle every open commit intent, in ledger order (K2) — the explicit startup
   * and resume entry. Nothing calls this implicitly: no read path, no `get` /
   * `list`, and no tool call reconciles as a side effect, so a query stays a
   * query and a deployment decides when a recovery is due.
   *
   * Each intent is settled by {@link settleOpenIntent} under the same serial
   * queue a fresh commit takes, and each outcome is reported by name:
   * `completed-redone` (production still held the pre-commit state, so the same
   * write was carried out), `completed-written` (production already held the
   * committed content, so only the completion was recorded) or `blocked` (a
   * source that is gone or changed, a target that holds neither state — the
   * intent stays open and nothing is overwritten). A blocked intent does not
   * throw: the rest of the batch is still settled, and the caller decides what a
   * human does about it. A real I/O failure of a redo write is not a blocked
   * commit and does throw.
   *
   * Repeating it is free: a settled intent has no open intent left, so the fold
   * refuses a second completion and this call reports nothing for it.
   */
  reconcile(): Promise<ReconcileOutcome[]>;
  /**
   * The production targets a commit has left open (K2), in ledger order — the
   * pure read an admission gate or a loader uses to see what must not be loaded
   * until a reconciliation settled it. It writes nothing, and it never
   * reconciles: settling is {@link reconcile}'s call to make, at the moment the
   * deployment decides recovery is due.
   */
  openIntentTargets(): Promise<readonly string[]>;
  /** Every commit intent still open, in ledger order — one per proposal at most, validated by the fold. */
  private openIntents;
  /**
   * Settle one open intent for a caller that named it (an apply/rollback retry),
   * where a blocked commit is the caller's answer and not a batch's footnote:
   * the named stop is thrown with the reason intact.
   */
  private settleOpenIntent;
  /**
   * The commit request one apply/rollback binds, read off the prepared record
   * the proposal already carries: the absolute target (the same path
   * {@link applyTargets} names to the human), the content identity production
   * must hold before and after, and the recoverable source under the ledger
   * root. `apply` commits the candidate over the recorded baseline; `rollback`
   * commits the champion snapshot over the content the apply installed — the two
   * digests swap, and nothing else about the two directions differs.
   */
  private commitRequest;
  /** The one production path a commit of this proposal may write: `<skillRoot>/<name>/SKILL.md`, confined to the skill root. */
  private commitTarget;
  /**
   * The narrow host the commit path runs on (see `commit.ts`): the roots a
   * target and a source resolve against, the service's own verified reads — P2
   * for a candidate, the walk-verified production read, the ledger-root read for
   * a snapshot — the append funnel every line goes through (format check, staged
   * fold, serialized write), and the probe seam. The commit path owns the order;
   * the service owns what may be read and what a line must say.
   */
  private commitHost;
  /**
   * Serialize one commit — its intent, its production write and its completion —
   * behind every commit already running or queued, and behind every write the
   * ledger funnel has not appended yet. Two proposals competing for one target
   * therefore never interleave a read-back with another commit's rename: the
   * second sees the first's result and refuses on its own baseline check. This
   * is a single-process queue, not a cross-process lock: the deployment's
   * one-writer constraint still stands, and a second process is not excluded.
   */
  private commitExclusive;
  /** Folded view of one proposal, or throws on an unknown id. */
  get(proposalId: string): Promise<EvolutionProposal>;
  /** Folded views, newest proposal first, optionally filtered. */
  list(filter?: ListFilter): Promise<EvolutionProposal[]>;
  private refExistsOnDisk;
  /**
   * Early state-machine check so a wrong-state call reports the transition
   * error before any payload validation; `append` re-checks under the write
   * lock, which is the authoritative gate. Returns the folded proposal so
   * callers can validate payloads against targetType / baseVersion / mutation.
   */
  private assertNext;
  /**
   * Write the skill mutation into the sandbox dir `dir`, then the champion
   * snapshot from the production bytes the caller already read (P3: one read,
   * before anything was written — those bytes become the snapshot and the
   * recorded `skillBaseline` digest together, so the two can never describe two
   * different reads of the production file). Every path goes through
   * `resolveWithin`, so a write can never land outside the sandbox; the
   * production skill root is read-only here.
   */
  private materialize;
  /**
   * Fold records into proposals, enforcing the state machine on every step:
   * proposed starts a new id; each later kind must be exactly an allowed next
   * state, and payload-bearing kinds re-run the write path's payload
   * validation (candidate versionSet/mutation, gate answers, the
   * prepared/applied/rolledback shapes), so a hand-forged line fails
   * load exactly as it would fail append. The same rules guard folding and live
   * appends, so an illegal migration is rejected identically in both paths.
   *
   * The fold admits the shape the current entries write and nothing else (S4-E
   * 收尾): a candidate is a skill mutation, a prepared record carries both
   * content identities a prepare captured, and a decided record names the human
   * approval that granted it. A line missing any of them is refused here,
   * before any later entry can act on the state it would have folded to.
   *
   * Commit intents (K2) fold here too, because they are the one place where a
   * ledger line is judged against the *other* lines around it: a `commit_intent`
   * is admitted only for a proposal in the state its direction commits (`apply`
   * from decided, `rollback` from applied), only with the derived id
   * `<proposalId>/<direction>`, and only when the proposal has no other open
   * intent; an `applied`/`rolledback` completion is admitted only when it closes
   * the open intent of its own direction — same id, same approval, that exact
   * target — and it closes it. So a completion cannot be recorded without its
   * intent, cannot borrow another approval or another target, and cannot be
   * recorded twice: the second line has nothing left to close.
   *
   * The experiment family is not a lifecycle transition and is skipped here;
   * {@link foldLedger} folds it beside this fold.
   */
  private fold;
  private load;
  /**
   * Validate a whole ledger: the proposal lifecycle fold, then the experiment
   * fold beside it. Neither family's rules change because the other exists —
   * a lifecycle line is judged exactly as it always was, and an experiment line
   * gets its own checks ({@link foldExperiments}).
   */
  private foldLedger;
  /**
   * Validate the staged fold first; memory commits only after the line is on
   * disk. The format check runs before the fold, so a record declaring another
   * version is refused before it can be folded — and, because nothing is
   * written until the fold has accepted the staged ledger, before a byte
   * changes on disk.
   */
  private append;
  /** The folded views of every experiment, one per id — the ledger's experiment family, validated. */
  private experimentViews;
  /**
   * One experiment's folded view (its frozen block and every sample record
   * written under it), or a named refusal for an unknown id. This is the read
   * the promotion gate will take: the report is a function of these records, so
   * re-deriving it here is what lets a later stage refuse a report that no
   * longer matches the ledger.
   */
  experiment(experimentId: string): Promise<ExperimentView>;
  /** Every experiment's folded view, newest first, optionally narrowed to one proposal. */
  experiments(proposalId?: string): Promise<ExperimentView[]>;
  /**
   * Record the frozen experiment, before its first run. Idempotent by identity:
   * the same frozen block under the same id is a no-op (a repeat call resumes
   * the same experiment rather than starting a second one), and a record that
   * already holds a different frozen block, budget or report path is refused —
   * the experiment id *is* the frozen identity, so a disagreement means the
   * ledger and the caller are not talking about the same experiment.
   */
  recordExperimentStart(record: ExperimentStartedRecord): Promise<void>;
  /**
   * Record one sample side, once. The key carries the run: a second record for
   * the same key is refused by the fold whatever it says, and a record that
   * disagrees with the experiment it names (a different candidate identity, a
   * different repetition, a sample the experiment never froze) is refused
   * before the line lands. Nothing here re-runs anything — the caller only
   * writes what a run already settled to.
   */
  recordExperimentSample(record: ExperimentSampleRecord): Promise<void>;
  /**
   * The two-sided experiment entry (§F.2). The orchestrator itself lives in
   * `experiment.ts`; this method is the service's own door to it, resolving the
   * graph, task and runtime services from this context so the tool layer above
   * has exactly one call to make. It does not touch the promotion gate or the
   * lifecycle: an experiment is evidence, and what may be promoted from it is a
   * later stage's question.
   */
  runExperiment(spec: ExperimentSpec, caller: SessionId, actor: string, options?: {
    signal?: AbortSignal;
  }): Promise<ExperimentResult>;
  /**
   * Continue a frozen experiment by id. Its specification *is* the recorded
   * frozen block, so a caller that lost the spec — a restart — can resume what
   * was frozen rather than guess at it; the block is re-derived and must
   * reproduce the recorded identity, so a candidate, contract, model or
   * snapshot that moved is refused rather than run under a new identity.
   */
  resumeExperiment(experimentId: string, caller: SessionId, actor: string, options?: {
    signal?: AbortSignal;
  }): Promise<ExperimentResult>;
  /**
   * The services one experiment runs on, resolved softly: an experiment needs
   * the graph (for this graph's task store), the task store's reads, and the
   * runtime's replay entry. A context that cannot offer one refuses by name
   * instead of running an experiment that could not be judged against a store.
   */
  private experimentSources;
}
//#endregion
export { APPLYABLE_TARGET_TYPES, ApplyOutcome, ApplyView, ChampionState, CommitDirection, CommitIntentRecord, CommitIntentView, Config, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionDecision, EvolutionLevel, EvolutionProposal, EvolutionRecord, EvolutionService, EvolutionService as default, EvolutionStatus, ExperimentBudget, ExperimentCost, ExperimentCriterionDetail, ExperimentKey, ExperimentLedger, ExperimentOutcome, ExperimentRecord, ExperimentReport, ExperimentRequest, ExperimentResult, ExperimentSampleComparison, ExperimentSampleRecord, ExperimentSampleRole, ExperimentSampleSpec, ExperimentSampleVerdict, ExperimentSide, ExperimentSideComparison, ExperimentSideDetail, ExperimentSources, ExperimentSpec, ExperimentStartedRecord, ExperimentVerdict, ExperimentView, FrozenCriterion, FrozenExperiment, FrozenProviderIdentity, FrozenProviderSkill, FrozenSample, GateAnswers, ListFilter, ModelSelection, PrecheckSkillVerdict, PreparedView, PromotionCheck, PromotionProvider, ProposeInput, ProviderPrecheckView, ReplayCriterionDiff, ReplayCriterionSummary, ReplaySideSummary, SideRelation, SkillContentIdentity, SkillMutation, VerifierVocabularyView, agentOptionsOf, applyTargets, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, buildExperimentReport, canonicalJson, compareExperimentSides, compareReplaySides, digestOf, directoryDigest, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, overallExperimentVerdict, protectedInputsDigest, renderProviderRoles, resumeExperiment, runExperiment };