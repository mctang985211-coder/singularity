import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ProposalTargetType, ReviewCriterion, ReviewMetrics, ReviewRecord, TaskSnapshot } from "@dangosys/dsh-singularity-task";
import { CapabilityConfig, ReplayRunOutcome, ReplayTaskOptions, RootRecoveryOutcome, SkillSidecar } from "@dangosys/dsh-singularity-task-runtime";

//#region src/capability-candidate.d.ts

/** The refusal of one rule, carrying its machine-readable code as the message's second word. */
declare function capabilityRefusal(code: string, detail: string): Error;
/** One whole capability row: its name and its entry, as the candidate submits them. */
interface CapabilityRow {
  name: string;
  entry: CapabilityConfig;
}
/** The new execution skill a capability candidate may carry: the text, and the declaration that authorises it. */
interface CapabilitySkill {
  name: string;
  /** The whole `SKILL.md` text (frontmatter included). */
  content: string;
  /** The `SKILL.contract.json` declaration this new object carries — authored, because there is no production object to derive it from. */
  sidecar: SkillSidecar;
}
/** One validated capability mutation, normalized. */
interface CapabilityCandidate {
  row: CapabilityRow;
  skill?: CapabilitySkill;
}
/**
 * The frozen identity of one capability row: its name, the row itself, and the
 * SHA-256 of its canonical serialization (`digestOf`). One digest basis, so the
 * bytes a sandbox holds, the digest an intent records and the row a registry
 * reports all compare as the same value.
 */
interface CapabilityRowIdentity {
  name: string;
  entry: CapabilityConfig;
  digest: string;
}
/**
 * The overlay a candidate-side evaluation mounts on this candidate (A6 interface
 * ②, plan F.4 "候选同时挂 capabilityOverrides 与 extraSkillRoots"): the prepared
 * row as a whole-row override, and the sandbox skill root in front of the
 * production ones. `empty` for a row-only candidate, whose overlay is the row.
 */
interface CapabilityOverlay {
  capabilityOverrides: Record<string, CapabilityConfig>;
  extraSkillRoots: string[];
}
/** The canonical bytes of one row — what a sandbox freezes and an intent's source holds. */
declare function capabilityRowBytes(entry: CapabilityConfig): string;
/** SHA-256 of {@link capabilityRowBytes}: the identity a row is compared by, everywhere. */
declare function capabilityRowDigest(entry: CapabilityConfig): string;
/** The frozen identity of one row, as a prepared record and a commit intent name it. */
declare function capabilityRowIdentity(row: CapabilityRow): CapabilityRowIdentity;
/** The table a candidate would produce: the store's rows with this one row folded in. */
declare function capabilityTableWith(table: Readonly<Record<string, CapabilityConfig>>, row: CapabilityRow): Record<string, CapabilityConfig>;
/**
 * Validate one capability row's shape and return it normalized — the whole row,
 * with no field inherited from anywhere. `where` names the row in the refusal.
 */
declare function assertCapabilityRow(where: string, value: unknown): CapabilityConfig;
/**
 * Validate one whole capability mutation and return it normalized. The entry
 * point of both the live write path (`EvolutionService.candidate`) and the fold,
 * so a hand-forged ledger line fails exactly as a live append would.
 */
declare function validateCapabilityMutation(mutation: unknown): CapabilityCandidate;
/** The real DSH tools and MCP servers a store's current capability table authorizes. */
declare function authorizedToolPlane(table: Readonly<Record<string, CapabilityConfig>>): {
  tools: Set<string>;
  servers: Set<string>;
};
/**
 * The store view the candidate's rules read: the effective capability table, the
 * registered verifier vocabulary (fail-closed when it cannot be listed), the
 * roots a worker's own discovery searches, and the production skill root this
 * plane writes into.
 */
interface CapabilityStoreView {
  readonly table: Readonly<Record<string, CapabilityConfig>>;
  /** `undefined` when the deployment cannot list its verifiers — an execution provider is then refused rather than assumed registered. */
  readonly verifierVocabulary?: {
    readonly ids: readonly string[];
    readonly versions: Readonly<Record<string, string>>;
  };
  /** Every root discovery searches, in order (the production root first when the caller has it). */
  readonly skillRoots: readonly string[];
  /** The production skill root a candidate's new directory would land in. */
  readonly skillRoot: string;
}
/**
 * Whether one candidate row may be written at all: no tool the store has not
 * already authorized, and no preset / permission / MCP-server change against the
 * row it replaces (a brand-new row declares none of them).
 */
declare function assertCapabilityRowAdmissible(store: CapabilityStoreView, row: CapabilityRow, baseline: CapabilityConfig | null): void;
/**
 * The `SKILL.md` discovery finds for one skill name under `roots`, or `undefined`
 * when no root holds one — the same walk (`walkVerified`) and the same
 * `<root>/<name>/SKILL.md` shape the store's own discovery searches, so "this
 * name is free" is answered about the roots a worker would load from. A root
 * that cannot be listed, or a path that is a symbolic link, contributes nothing.
 */
declare function discoverSkill(roots: readonly string[], name: string): Promise<string | undefined>;
/**
 * Every rule the capability candidate itself must satisfy against the store it
 * would land in, in one place — the write path (prepare) and the promotion gate
 * both call it, against the store as it stands at that moment, so a store that
 * moved between the two is refused by the same words.
 */
declare function assertCapabilityCandidateAdmissible(store: CapabilityStoreView, candidate: CapabilityCandidate, baseline: CapabilityConfig | null): Promise<void>;
/**
 * The candidate-side overlay of one prepared capability proposal (A6 interface
 * ②): the frozen row as a whole-row `capabilityOverrides` entry, and the sandbox
 * skill root as an `extraSkillRoots` entry in front of the production roots.
 * Read off the prepared record, so what an evaluation mounts is what the commit
 * would install.
 */
declare function capabilityOverlay(proposal: EvolutionProposal, roots: {
  root: string;
}): CapabilityOverlay;
/** The prepared candidate as its bytes: the row (and its baseline), the new skill, every file read and verified. */
interface PreparedCapability {
  /** The candidate row, read back from the sandbox and verified against `prepared.capabilityRow`. */
  row: CapabilityRow;
  rowBytes: Buffer;
  /** The row the store held at prepare, with its frozen champion bytes — `undefined` when the store held none. */
  baseline?: {
    entry: CapabilityConfig;
    bytes: Buffer;
  };
  /** The new skill, when the candidate carries one: the declaration and the exact bytes prepare froze. */
  skill?: CapabilitySkill & {
    skillMd: Buffer;
    sidecarBytes: Buffer;
  };
  /** The sandbox root the new skill's directory lives under (`<sandbox>/skills`) — the extra discovery root a row pre-check mounts. */
  skillRoot?: string;
  /** The sandbox directory of the new skill, as a loader would read it (only when `skill` is present). */
  skillDirectory?: string;
}
/**
 * Read one prepared capability candidate back from its sandbox and verify it
 * against the identities prepare recorded (P2 for the row and the new skill's
 * files, P3's bytes for the champion row): the one read path the promotion gate
 * and the apply write share, so what is promoted and what is committed are
 * provably the same bytes. Every mismatch is a named refusal and never a
 * re-digest.
 */
declare function readPreparedCapability(root: string, proposal: EvolutionProposal): Promise<PreparedCapability>;
//#endregion
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
 * The identity of one skill object's sidecar file (K3): the exact bytes of
 * `SKILL.contract.json` as the object carries them, and the normalized identity
 * a registry revision and a run binding use. Both are needed and neither implies
 * the other: the byte digest is what a commit writes and re-verifies, and the
 * canonical digest is what a run's own binding records — a re-serialization that
 * preserves the declaration moves the first and not the second, which is exactly
 * the difference the commit path relies on.
 */
interface SkillContractIdentity {
  /** SHA-256 over the exact `SKILL.contract.json` bytes. */
  sha256: string;
  /** `skillContractDigest` of the sidecar — the normalized identity a registry revision and a run binding use. */
  contractDigest: string;
}
/**
 * The content identity of one skill object (P2): the skill name, the SHA-256 of
 * the exact `SKILL.md` bytes, and — exactly when the object carries an execution
 * sidecar — the identity of the `SKILL.contract.json` beside it. Recorded at
 * prepare, carried by the experiment's frozen block, and re-verified by the
 * experiment's pre-run check, at every promotion gate, and on the apply write —
 * so the chain can never validate one object's content and apply another's, and
 * a two-file object's two files are frozen together.
 *
 * A guidance object — a skill with no sidecar — is a complete object with one
 * file, which is why `contract` is absent rather than empty: presence *is* the
 * shape, and the presence of `contract` must agree between the candidate
 * identity and the production baseline it was prepared against.
 */
interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string;
  /** Lowercase SHA-256 hex over the exact `SKILL.md` file bytes — no trim, no newline conversion. */
  sha256: string;
  /** Present exactly when the object carries an execution sidecar; see {@link SkillContractIdentity}. */
  contract?: SkillContractIdentity;
}
/** One side of one task's comparison: an outcome and the criterion verdicts the run reported. */
interface ReplaySideSummary {
  taskId: string;
  runId?: string;
  outcome: 'verified' | 'failed' | 'cancelled' | 'not-admitted';
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
 * The comparer a report names, and the only one this build can re-check:
 * the verdict rules of {@link compareExperimentSides} and
 * {@link overallExperimentVerdict}. A report naming anything else is refused by
 * {@link assertExperimentReport} instead of being re-derived with rules this
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
 *
 * `not-admitted` is the one outcome that is **not** a run's settlement (A6,
 * §F.4 "评估/应用必须同组补齐"): the runtime's own admission chain refused the
 * side before a run existed — a capability sample's production baseline whose
 * required row the effective table does not hold, or whose provider the
 * pre-check refuses. Such a side has no Task, no Run, no Review and no
 * evidence; its whole record is the refusal beside it
 * ({@link ExperimentAdmissionRefusal}), and no champion and no failure run is
 * ever invented in its place. Only a **baseline** side may be `not-admitted`:
 * a candidate the runtime will not admit did not run, and cannot stand as a
 * fix.
 */
type ExperimentOutcome = 'verified' | 'failed' | 'cancelled' | 'interrupted' | 'not-admitted';
declare const EXPERIMENT_OUTCOMES: readonly ExperimentOutcome[];
/** Which admission rule of the runtime refused one side of a capability sample (A6). */
type ExperimentAdmissionSource = 'capability-gap' | 'provider-refused';
declare const EXPERIMENT_ADMISSION_SOURCES: readonly ExperimentAdmissionSource[];
/**
 * The runtime's own refusal of one side of a capability sample (A6): the side is
 * `not-admitted`, and this is everything its record carries instead of a Run —
 * which admission rule refused it, the proposal (and the gap/diagnosis it came
 * from) the refusal belongs to, the rows the side had to resolve, the rows the
 * table did not hold, and the runtime's own words.
 *
 * `reason` is the refusal text the runtime produced when the side was really
 * attempted, never a description this plane writes for it.
 */
interface ExperimentAdmissionRefusal {
  source: ExperimentAdmissionSource;
  /** The proposal this refusal belongs to — the candidate whose gap the side stands for. */
  proposalId: string;
  /** The proposal's own source refs: the capability gap / diagnosis the candidate came from. */
  sourceRefs: string[];
  /** The sample's required capability rows this side's configuration had to resolve. */
  required: string[];
  /** The required rows that configuration did not hold; empty for a provider refusal. */
  missing: string[];
  /** The runtime's own refusal text, verbatim. */
  reason: string;
}
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
/** One criterion's verdict on one side, with the verifier that decided it (v1's report dropped the verifier identity; every generation since keeps it). */
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
  /**
   * The runtime's own admission refusal, for a side that is `not-admitted` (A6).
   * Required there and absent otherwise: the side has no Task and no Run at all,
   * so this record is what stands in their place.
   */
  admission?: ExperimentAdmissionRefusal;
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
 * declare, and every skill their providers resolved to.
 *
 * The candidate side's binding is compared against the same identity with
 * exactly one substituted entry — the promoted skill's own content, which is the
 * overlay difference this ticket approved. That entry is not a member of this
 * shape, so the identity a candidate side must bind is recorded beside the
 * production one as {@link FrozenProviderIdentity.candidateRegistryRevision}:
 * the registry revision recomputed with the improved skill's own declaration
 * digest replaced by the candidate's. Both are frozen for every sample, guidance
 * candidates included (where the substitution changes nothing and the two
 * revisions are equal) — one shape, no conditional member.
 */
interface FrozenProviderIdentity {
  /** The capability rows in play, sorted (the sample's required capabilities as the table holds them). */
  capabilities: string[];
  /**
   * The registry revision the runtime's own pre-check produces for those rows
   * over the production table at freeze. The **baseline** side's run binding must
   * carry it: a capability row, a tool label or a declared contract that moved
   * since the freeze moves it too.
   */
  registryRevision: string;
  /**
   * The registry revision the **candidate** side's run binding must carry: the
   * same revision over the same table and provider list with the improved
   * skill's declaration digest replaced by the candidate object's
   * (`null` for a guidance candidate) — the one substitution the candidate
   * overlay produces. An execution candidate rewrites the sidecar's
   * `content.skillMdSha256`, so its declaration digest moves and the revision
   * that absorbs it moves with it; both sides' values are pinned separately
   * rather than one being derived from the other at promotion time.
   */
  candidateRegistryRevision: string;
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
 * One side's frozen provider identity of a **capability** sample (A6): the
 * capability rows in play for the sample, the registry revision the runtime's own
 * pre-check produces for them, the MCP servers and preset they declare, and every
 * provider they resolved to. It is the shape {@link FrozenProviderIdentity}
 * carries minus the production/candidate pair of revisions: a capability sample
 * compares two *configurations* (production and the candidate overlay), each of
 * which is one such identity, rather than one configuration with a substituted
 * provider.
 */
interface FrozenCapabilitySide {
  /** The capability rows in play, sorted (the sample's required capabilities the side's table resolves). */
  capabilities: string[];
  /** The registry revision the runtime's own pre-check produces over that side's table. */
  registryRevision: string;
  /** The MCP server names those rows grant, sorted. */
  mcpServers: string[];
  /** The preset those rows declare — one worker, one preset — or `null` when none declares one. */
  preset: string | null;
  /** Every skill the rows' providers resolved to, sorted by name. */
  skills: FrozenProviderSkill[];
}
/**
 * The production configuration's own refusal of one capability sample (A6),
 * recorded *before* the first run: the sample's rows the table did not hold, or
 * the providers the pre-check refused. It is what the baseline side's
 * `not-admitted` record is checked against — a record whose refusal does not
 * match the frozen one is not this experiment's evidence.
 */
interface FrozenSampleAdmission {
  source: ExperimentAdmissionSource;
  /** The sample's required capability rows. */
  required: string[];
  /** The required rows the production table did not hold; empty for a provider refusal. */
  missing: string[];
  /** How the freeze read the refusal (the runtime's own resolution/pre-check answer). */
  reason: string;
}
/**
 * The whole row one capability candidate installs (A6), frozen with the
 * experiment: the row, and the SHA-256 of its canonical bytes. The gate compares
 * it member by member against the row `prepare` recorded.
 */
interface FrozenCapabilityRow {
  name: string;
  entry: CapabilityConfig;
  digest: string;
}
/**
 * The capability candidate one experiment evaluates (A6): the row it installs,
 * the row the registry held when it was prepared (`null` for a new row — the
 * production baseline of a capability candidate is a registry state, not a skill
 * object), and the proposal's own source refs, so a `not-admitted` record names
 * the gap it came from.
 */
interface FrozenCapability {
  row: FrozenCapabilityRow;
  /** The row the registry held at prepare, or `null` when it held none. */
  baseline: FrozenCapabilityRow | null;
  /** The proposal's own source refs — the capability gap / diagnosis the candidate came from. */
  sourceRefs: string[];
}
/**
 * One sample's frozen identity: the case it locates, and the acceptance
 * identity the replay will mirror into both sides. `observed` is the historical
 * record the sample was chosen for — it locates the case and is *not* a
 * baseline: every report side must cite a different run.
 *
 * Which provider identity a sample carries is what kind of experiment it is
 * (A6):
 * - a **skill** experiment freezes `provider`: the production configuration's
 *   identity, which the baseline side binds, with the candidate side's revision
 *   recorded beside it (`FrozenProviderIdentity.candidateRegistryRevision`);
 * - a **capability** experiment freezes `candidateProvider` — the overlay
 *   configuration's identity the candidate side binds — and exactly one of
 *   `provider` (production admits the sample, so its baseline really runs) or
 *   `admission` (production refuses it, so the baseline side is `not-admitted`
 *   and no run exists for it).
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
  /** The provider identity the production-baseline side of a skill sample must bind (S4-E §Q3). */
  provider?: FrozenProviderIdentity;
  /** A6: the production configuration's own refusal, when it cannot admit this sample at all. */
  admission?: FrozenSampleAdmission;
  /** A6: what the candidate (overlay) side of a capability sample must bind. */
  candidateProvider?: FrozenCapabilitySide;
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
  /**
   * The candidate object's content identity the candidate side runs against (the
   * prepared `SKILL.md`, plus the derived sidecar when the object has one).
   * Absent exactly for a capability candidate that installs a row and carries no
   * new skill object (A6): a row-only candidate has no object identity to name,
   * and {@link FrozenExperiment.capability} carries what it does have.
   */
  candidate?: SkillContentIdentity;
  /** The production baseline the candidate object replaces, when prepare captured one (a replacement, not a new skill). */
  productionBaseline?: SkillContentIdentity;
  /** The capability candidate this experiment evaluates (A6); absent for a skill experiment. */
  capability?: FrozenCapability;
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
  /**
   * What each side runs under, in words: the candidate's overlay and the
   * baseline's absence of one. The candidate's line names the *complete object*
   * the sandbox's skills root is loaded from (K3) — the prepared `SKILL.md` and,
   * for an execution object, the derived `SKILL.contract.json` beside it — so a
   * reader is never told a two-file candidate is one file.
   */
  overlay: {
    baseline: string;
    candidate: string;
  };
}
/** One experiment's report: the frozen identity, every sample's two sides, and the verdict recomputable from them. */
interface ExperimentReport {
  formatVersion: 3;
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
 * (the outcome and the criterion verdicts), so the experiment's verdict is the
 * v1 rules applied to this experiment's evidence and nothing else. An
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
 *
 * A side the runtime refused at admission (A6, `not-admitted`) has no outcome to
 * rank and no criteria to compare, so it is answered before the v1 rules rather
 * than read through them: a baseline the production configuration could not
 * admit is the gap itself — the candidate passing the same frozen acceptance is
 * the `fixed` verdict, and the candidate failing beside it is `both-failed` —
 * while a candidate that could not be admitted is never a fix. A regression or
 * holdout sample needs a reproduced baseline to be comparable, so a refused
 * baseline there leaves it `inconclusive`, never `maintained`.
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
/** The runtime's own refusal, as the report carries it for a `not-admitted` side (A6). */
declare function assertAdmissionRecord(value: unknown, field: string): asserts value is ExperimentAdmissionRefusal;
/**
 * Validate a v3 report against itself — and further than a shape check: every
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
 * {@link CommitHost.probe}, the typed test seam: what it does at a stage is the
 * caller's business, and a test that answers with an ordinary throw interrupts
 * the commit there without being a process exit (a throw is caught, its `catch`
 * and `finally` run, and the process lives on). A *real* exit at one of these
 * stages is a killed process, which no throw can stand in for — see the real-exit
 * cases in `tests/integration/k2-evolution-commit.spec.ts`.
 *
 * The `write-*` stages fire once per file and carry that file's target, so a
 * caller can open a window between the two files of one object as precisely as
 * inside one file's write. `commit-verified` is the last window: every file is
 * written and read back, and the whole object passed
 * {@link CommitHost.verifyCommitted} — the completion line is the only step left.
 */
type CommitStage = 'intent-recorded' | 'write-staged' | 'write-renamed' | 'commit-verified';
/**
 * One file of one commit: where it goes, what production must hold before the
 * write, what it must hold after, and the bytes to write again if this process
 * dies mid-commit. A K3 commit carries the fixed file set of one skill object —
 * `SKILL.md` always, `SKILL.contract.json` second when the object has an
 * execution sidecar — and the files are ordered: the `SKILL.md` first, so a
 * recovery that has to write the pair again writes the pair in the order a
 * loader would read it.
 *
 * `null` on either side is a *state*, not a missing value (A6): a file whose
 * `baselineSha256` is `null` must not exist before this commit (it is a file the
 * candidate creates), and a file whose `contentSha256` is `null` must not exist
 * after it (it is a file the rollback removes, and there is nothing to write
 * again, so it names no source). One direction may not remove a file the other
 * created and restore it in the same commit: the two states are the two ends of
 * one candidate version.
 */
interface CommitFile {
  /** Absolute production path this commit replaces, creates or removes. */
  readonly target: string;
  /** The digest this file must hold before the write — the state a reconciliation redoes the write from; `null` when it must not exist. */
  readonly baselineSha256: string | null;
  /** The digest this file must hold after the write; always the digest of the bytes being committed, `null` when the commit removes it. */
  readonly contentSha256: string | null;
  /** The recoverable bytes for this file, relative to the ledger root; absent when this direction removes the file. */
  readonly source?: string;
}
/** What one reconciliation of an open intent settled to. */
interface ReconcileOutcome {
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  /** The absolute production targets the intent committed, in intent order — the whole fixed file set. */
  targets: readonly string[];
  /**
   * `completed-redone`: production still held the pre-commit state, so the same
   * writes were redone and the completion recorded. `completed-written`:
   * production already held the committed content in every file, so only the
   * completion was recorded. `blocked`: a file holds neither state (or a source
   * is gone), or the directory holds an entry the intent does not name — the
   * intent stays open and nothing was written.
   */
  result: 'completed-redone' | 'completed-written' | 'blocked';
  /** The named reason, present on `blocked`: what a human must settle before this commit can proceed. */
  detail?: string;
}
//#endregion
//#region src/capability-config.d.ts
/**
 * One table file's **composed identity**, frozen when a capability candidate is
 * prepared (A6, plan §F.4: "prepared 固定 capability 行、文件组合身份及生产基线"):
 * the digest of the whole file as prepare read it, and the digests of the whole
 * files this proposal's own two directions leave — what the apply writes and what
 * the rollback writes. Digests only, never a copy: the file's second document is
 * where a deployment keeps its credentials, and nothing of it but these hashes is
 * recorded (in the ledger, or anywhere else).
 *
 * Every comparison a commit makes about that file is one of these three values
 * (see {@link capabilityTableDrift}), so "the file prepare froze", "the file this
 * commit's own write leaves" and "something a third party did" are three
 * distinguishable states, and the third is never written over.
 */
interface CapabilityTableIdentity {
  /** SHA-256 of the whole file as prepare read it. */
  readonly baselineSha256: string;
  /** SHA-256 of the whole file the apply leaves (this candidate's row written in). */
  readonly applySha256: string;
  /** SHA-256 of the whole file the rollback leaves (the row it restores written in, or the row it removes). */
  readonly rollbackSha256: string;
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
  /**
   * The digest of the prepared candidate's **complete** content identity (K3):
   * the name, the `SKILL.md` digest, and the sidecar's exact-byte and canonical
   * digests when the object has one. Two candidates whose sidecars differ are
   * two different objects, so they are two different keys — a re-serialized or
   * rewritten declaration can never reuse the run that evaluated another one.
   */
  preparedContentDigest: string;
  sampleTaskId: string;
  side: ExperimentSide;
  repetition: number;
}
/** One `experiment_started` ledger line: the frozen experiment, recorded before the first run. */
interface ExperimentStartedRecord {
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4;
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
  /** The `proposals.jsonl` format version, not the report's — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4;
  kind: 'experiment_sample';
  proposalId: string;
  experimentId: string;
  /**
   * Key part: the digest of the complete candidate content identity this run
   * went through (K3) — `SKILL.md`, and the sidecar's two digests when the
   * object has one.
   */
  preparedContentDigest: string;
  sampleTaskId: string;
  side: ExperimentSide;
  repetition: number;
  /** The replayed task this side created. Absent for a side whose run never reached the store. */
  taskId?: string;
  /** The run this side created. Absent for a side whose run never reached the store. */
  runId?: string;
  outcome: ExperimentSideDetail['outcome'];
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
  /**
   * The runtime's own admission refusal, carried by a `not-admitted` side (A6):
   * the side produced no Task and no Run, so this record stands in their place.
   */
  admission?: ExperimentAdmissionRefusal;
  actor: string;
  at: string;
}
type ExperimentRecord = ExperimentStartedRecord | ExperimentSampleRecord;
/**
 * The idempotency key's content member (K3, A6): the digest of the candidate's
 * **complete** content identity — {@link digestOf} of the identity `prepare`
 * recorded, so the name, the `SKILL.md` bytes and, when the object has an
 * execution sidecar, the sidecar's exact bytes and canonical declaration are all
 * part of the key. Two candidates that differ in any of them are two objects,
 * and a key spent on one is never reused for the other.
 *
 * A capability candidate's identity is the **capability** block (the row it
 * installs, the row it moves and the gap it came from) together with the new
 * skill object when it carries one — the row alone would let two candidates
 * that differ only in their skill bytes share a key, and the skill alone would
 * let two rows share one.
 */
declare function preparedContentDigestOf(frozen: {
  candidate?: SkillContentIdentity;
  capability?: FrozenCapability;
}): string;
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
  /**
   * Read the prepared candidate object's files — `SKILL.md`, and the sidecar
   * when and only when the recorded identity has one — and verify them against
   * that identity (P2); throws otherwise.
   */
  readSkillCandidate(proposalId: string): Promise<{
    skillMd: Buffer;
    sidecar?: Buffer;
  }>;
  /**
   * Read a prepared **capability** candidate back out of its sandbox and verify
   * every byte against the identities prepare recorded (A6): the frozen row, the
   * new skill's two files when it carries one, and the champion row when the
   * registry held one. Throws otherwise. The evaluation freezes exactly these
   * bytes, so what an experiment mounts is what a commit would install.
   */
  readCapabilityCandidate(proposalId: string): Promise<PreparedCapability>;
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
    /**
     * The runtime's own pre-check over a capability table the experiment names
     * (A6): the candidate overlay's table, with the sandbox skill root in front
     * of discovery — the same function the replay's own admission runs, so what
     * the freeze records as the candidate side's expectation is the runtime's
     * own conclusion about the configuration that side will really run under.
     */
    precheckCapabilityTable?(request: {
      capabilities: readonly string[];
      table: Readonly<Record<string, CapabilityConfig>>;
      extraRoots: readonly string[];
    }): Promise<ProviderPrecheckView>;
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
 * Build the v3 report from the ledger records alone — the same records always
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
 * The target types `evolution_apply`/`evolution_rollback` move mechanically: a
 * skill candidate's sandbox copy lands on the production skill root, and — since
 * A6 — a capability candidate's one row lands in the capability registry
 * together with the new skill object its file set contains. Every other type has
 * no executor in this build — an agent_preset directory and a task_definition
 * were written by an older build and are not written here.
 */
declare const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[];
/**
 * The skill mutation: the full `SKILL.md` text for
 * `<skills root>/<name>/SKILL.md`. It is the whole input a candidate may submit
 * — the object's other fixed file, when it has one, is derived from production
 * at prepare rather than authored here, so a mutation can only ever change the
 * text a worker reads and never the declaration that authorises it.
 */
interface SkillMutation {
  name: string;
  content: string;
}
/**
 * The champion state of one prepared proposal. `captured` is the state of a
 * same-name skill update: this build replaces an existing production object, so
 * the bytes it read became the champion snapshot. `absent` is the state of a
 * capability candidate (A6): the skill its row grants is new, so production
 * holds no object to capture and the recorded baseline is that absence — the
 * preparation that may *add* an object, never replace one. The bookkeeping-only
 * prepare (`none` — nothing materialized, no anchor) belonged to target types
 * this build's candidate never admits and has no producer or consumer left
 * (S4-E 收尾).
 */
type ChampionState = 'captured' | 'absent';
/** Folded view of one `prepared` record. */
interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null;
  mechanical: boolean;
  champion: ChampionState;
  /**
   * The content identity recorded for the materialized candidate object (P2) —
   * the `SKILL.md`, plus the derived `SKILL.contract.json` when the object
   * carries an execution sidecar. Every prepare records it.
   */
  skillContent?: SkillContentIdentity;
  /**
   * The content identity of the production object as it stood at prepare (P3) —
   * the same files, read once before anything was written, so the champion
   * snapshot and the identity can never describe two different reads. Every
   * prepare records it; a captured champion without it cannot prove its baseline
   * and refuses a new apply. Its `contract` presence matches `skillContent`'s:
   * the object's shape is fixed at prepare, and a record whose two halves
   * disagree describes a role change no prepare performs. `null` is the recorded
   * absence a capability candidate's new skill object has (A6).
   */
  skillBaseline?: SkillContentIdentity | null;
  /**
   * The capability row a capability candidate fixes (A6): the whole row and the
   * SHA-256 of its canonical bytes. Every capability prepare records it.
   */
  capabilityRow?: CapabilityRowIdentity;
  /**
   * The row the registry held at prepare (A6), with its frozen champion bytes
   * under `champion/capability/`; `null` when the registry held no row of that
   * name, so this candidate *adds* the row rather than replacing it. The fold
   * refuses a capability prepare without this field, so "the row was there" and
   * "the row is new" are always distinguished.
   */
  capabilityBaseline?: CapabilityRowIdentity | null;
  /**
   * The capability table file's **composed identity**, frozen at prepare (A6, plan
   * §F.4: "prepared 固定 capability 行、文件组合身份及生产基线"): the digest of the
   * whole file as this prepare read it, and the digests of the whole files this
   * proposal's own two directions leave (the apply's row written in, the
   * rollback's row restored or removed). Three digests and nothing else — the
   * file's second document carries the deployment's credentials, so no byte of it
   * is ever recorded.
   *
   * Every write into that file is compared against these (EVO-2 内容漂移): an
   * apply and a rollback each accept exactly the state they start from and the
   * state their own write leaves, so a third party's edit is a named stop with
   * nothing written, and a retry that finds the commit's own result still settles.
   * Absent on a prepare whose deployment named no table file (there is nothing to
   * freeze), and on lines written before this field existed — a table write that
   * cannot be checked refuses by name instead of overwriting anything.
   */
  capabilityTable?: CapabilityTableIdentity;
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
 * One immutable ledger line, `formatVersion: 4` throughout (K3). A state
 * migration appends a new record; nothing is ever rewritten in place. The
 * version is the whole ledger's, not one line's: a line declaring anything but
 * 4 — or declaring nothing — makes the ledger refuse to load, and no entry here
 * writes one.
 */
type EvolutionRecord = {
  formatVersion: 4;
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
  formatVersion: 4;
  kind: 'candidate';
  proposalId: string;
  /** Complete version set the candidate aligns to (branch-model bookkeeping; this build creates no real branch). */
  versionSet: Record<string, string>;
  /**
   * The structured patch description, shaped by the proposal's targetType
   * (see the *Mutation interfaces) and always recorded: this build's
   * candidate is a `SKILL.md` replacement of an existing skill object, so a
   * candidate that carries nothing to materialize and evaluate would be a
   * flow going nowhere. Every line `candidate` writes holds one; a line
   * written before that rule (or by hand) folds to a candidate with no next
   * state, because `prepared` is the one transition a candidate admits.
   */
  mutation: unknown;
  actor: string;
  at: string;
} | {
  formatVersion: 4;
  kind: 'prepared';
  proposalId: string;
  /**
   * Sandbox dir relative to the ledger root. Every prepare this build
   * writes materializes one; nullable in the type only so a hand-forged
   * line naming none is refused by name at the fold.
   */
  sandbox: string | null;
  /** True on every prepare the fold admits: this build's candidate is a materialized mutation. */
  mechanical: boolean;
  /** `captured` for a same-name skill update, `absent` for a capability candidate's new skill object (A6). */
  champion: ChampionState;
  /**
   * The content identity of the materialized candidate `SKILL.md` (P2) — the
   * skill name plus the SHA-256 of the exact file bytes. Required for a skill
   * candidate and for a capability candidate that carries a new skill; absent
   * only for a capability candidate that changes a row and adds nothing.
   */
  skillContent?: SkillContentIdentity;
  /**
   * The content identity of the production `SKILL.md` as it stood at prepare
   * (P3), from the same read that produced the champion snapshot; `null` is
   * the recorded absence a capability candidate's new skill object has (A6).
   * Required on every prepared record: a captured champion always names the
   * baseline a later apply compares production against, and an added object
   * always names the absence it must find.
   */
  skillBaseline?: SkillContentIdentity | null;
  /** The capability row a capability candidate fixed, with the digest of its canonical bytes (A6). */
  capabilityRow?: CapabilityRowIdentity;
  /** The row the registry held at prepare, or `null` when it held none (A6); required on every capability prepare. */
  capabilityBaseline?: CapabilityRowIdentity | null;
  /**
   * The composed identity of the deployment's capability table file, frozen at
   * prepare (A6): the whole-file digests of the file as it was read, and of the
   * files this proposal's own apply and rollback leave. Absent when the
   * deployment names no table file, and on lines written before this field
   * existed — a fold that accepts both is what lets an older ledger load, and
   * the commit path refuses by name any table write it cannot compare.
   */
  capabilityTable?: CapabilityTableIdentity;
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[];
  actor: string;
  at: string;
} | {
  formatVersion: 4;
  kind: 'gated';
  proposalId: string;
  gate: GateAnswers;
  actor: string;
  at: string;
} | {
  formatVersion: 4;
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
  formatVersion: 4;
  kind: 'applied';
  proposalId: string;
  /** Production write targets, in commit order — the whole file set of the object this apply wrote (absolute paths). */
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
  formatVersion: 4;
  kind: 'rolledback';
  proposalId: string;
  /** Production write targets of the rollback (restored champion file set), in commit order, for audit. */
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
 * carry the ledger's own `formatVersion: 4` as well; the experiment *report*
 * at `experiment-report.json` has its own, separate version field.
 */ | ExperimentStartedRecord | ExperimentSampleRecord;
/** Which way one commit moves a production target. */
type CommitDirection = 'apply' | 'rollback';
/**
 * One `commit_intent` ledger line (K2, extended by A6): the durable "this
 * apply/rollback is now underway" record, written before production changes and
 * closed by the completion line that names the same `intentId`.
 *
 * It carries everything a recovery needs without trusting memory: which
 * proposal and direction, which human grant, the object's **whole fixed file
 * set** ({@link CommitFile}, in commit order) — for every file its absolute
 * production target, the digest that file must hold before the write
 * (`baselineSha256`, `null` when it must not exist), the digest it must hold
 * after (`contentSha256`, `null` when this direction removes it), and the bytes
 * to write again as a path relative to the ledger root (`source`, absent for a
 * removal) — and, for a capability commit, the one row this commit moves
 * ({@link CommitCapabilityRecord}). The id is derived, not chosen:
 * `<proposalId>/<direction>`.
 *
 * The line is not a lifecycle transition: it does not move the proposal's
 * status, so the proposal fold records it as {@link EvolutionProposal.openIntent}
 * and leaves the state machine alone. A proposal has at most one open intent,
 * and only one of them can close it (see the fold's admission rules).
 */
interface CommitIntentRecord {
  /** The `proposals.jsonl` format version — the ledger is one format, `formatVersion: 4` (K3). */
  formatVersion: 4;
  kind: 'commit_intent';
  /** `<proposalId>/<direction>` — the derived id the completion line must repeat. */
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  /** The human grant that authorised this commit (`approval:<callId>`), recorded on the completion as well. */
  approvalRef: string;
  /** The object's fixed files, in commit order — `SKILL.md` first, the `SKILL.contract.json` second when the object carries an execution sidecar; empty for a row-only capability commit. */
  files: CommitFile[];
  /** The one capability row this commit moves (A6); absent for a skill commit. */
  capability?: CommitCapability;
  actor: string;
  at: string;
}
/** The one capability row a `commit_intent` carries (A6): what the registry must hold before and after, and the bytes a recovery installs. */
interface CommitCapability {
  name: string;
  /** The row's canonical digest the registry must hold before the write; `null` when it must hold no row. */
  baselineSha256: string | null;
  /** The row's canonical digest this direction installs; `null` when this direction removes the row. */
  contentSha256: string | null;
  /** The recoverable row bytes, relative to the ledger root; absent when this direction removes the row. */
  source?: string;
}
/** Folded view of one open `commit_intent` record, as {@link EvolutionProposal} exposes it. */
interface CommitIntentView {
  intentId: string;
  proposalId: string;
  direction: CommitDirection;
  approvalRef: string;
  /** The object's fixed files, in commit order; one or two entries, empty for a row-only capability commit (see {@link CommitIntentRecord.files}). */
  files: CommitFile[];
  /** The capability row this commit moves, when it carries one (A6). */
  capability?: CommitCapability;
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
   * The typed test seam of the commit path (K2, per-file since K3): it fires at
   * each durable stage of one commit — after the `commit_intent` line is on disk
   * (`intent-recorded`); after the new bytes of one file are staged and fsynced
   * beside its production target but before the rename, and after that rename
   * has been read back and verified (`write-staged` / `write-renamed`, each
   * carrying the file's target, so a caller can open the window *between* the
   * two files of one object as well as inside one file's write); and after every
   * file is written and the whole object has passed the service's own
   * loadability-and-identity re-read, with only the completion line left
   * (`commit-verified`). Throwing from it aborts the commit exactly where it
   * stands: the intent stays open and no later stage runs. That throw is an
   * ordinary in-process exception, **not** a process exit — `writeFileAtomic`'s
   * own `catch` still removes the staging file it had written and the process
   * keeps running — so it is a window-injection seam, and the real exit (a
   * killed process at one of those stages) is proven by the nested-child cases
   * in `tests/integration/k2-evolution-commit.spec.ts`. A production deployment
   * never sets it; there is no other way to observe or interrupt a commit.
   */
  commitProbe?: (stage: CommitStage, target?: string) => void;
  /**
   * Where this deployment reads the **supervisor delegation** of one hand-off
   * from (A6): the ledger row that names the coordination session a Diagnosis
   * with suggestions was delegated to.
   *
   * It is injected, not read here: the ledger belongs to the package that owns
   * the coordination agents (`@dangosys/dsh-singularity-agent`'s review-agent
   * ledger), and this package must not import it back — the assembly wires the
   * two together, exactly as it wires the reviewer binding source into the
   * context package. The entry that uses it is
   * {@link EvolutionService.coordinateRecovery}, and a deployment without a
   * source refuses a recovery by name: "this session is the hand-off's
   * supervisor" is an authorization, and one nobody can prove is not granted.
   */
  supervisorDelegation?: (sessionId: string, diagnosisId: string) => Promise<SupervisorDelegation | undefined>;
  /**
   * The capability table's own file (A6): the deployment's `config.yml`, whose
   * `capabilities:` row of the `task-runtime` entry is what a restart reads the
   * registry from. A capability commit writes the row there — after the
   * registry accepted it and before the completion line — so the in-process
   * registry and the file a restart loads agree (see
   * `capability-config.ts`).
   *
   * Absent means this deployment has no durable capability table to write, and a
   * capability commit is then refused by name before it writes anything: a row
   * that exists only in this process would be gone after a restart, and
   * recording a completion for it would be a promise the deployment cannot keep.
   * A skill commit is unaffected — its object is the file set under the skill
   * root.
   */
  capabilityConfig?: string;
  /**
   * The typed test seam of the capability-config write (A6), the same shape
   * `commitProbe` has for the file writes: it fires immediately before the
   * config file is written, once the bytes are staged and durable beside it
   * (`staged` — the point the last whole-file verification runs at, and the only
   * seam left before the rename), and once the write has landed and been read
   * back. Throwing from `before-write` aborts the write exactly where it stands —
   * the commit intent stays open, production holds the row in the registry and
   * not yet in the file, and the next reconciliation writes it. A write landed
   * from `staged` is refused by the verification that runs after it, with the
   * staged bytes removed and the file left exactly as the third party wrote it.
   * A production deployment never sets it.
   */
  capabilityConfigProbe?: (stage: 'before-write' | 'staged' | 'written', row: string) => void;
}
/**
 * The production write targets of an apply (and its matching rollback), for
 * the approval reason and the audit record — the human sees exactly what a
 * grant will touch. The object's fixed file set: the candidate's `SKILL.md`,
 * plus the `SKILL.contract.json` beside it when the prepared object carries an
 * execution sidecar — one or two paths, in commit order. A capability candidate
 * (A6) names its new skill's files the same way, and a row-only candidate names
 * none: its one write is the registry row, which the intent line carries.
 */
declare function applyTargets(proposal: EvolutionProposal, roots: {
  skillRoot: string;
}): string[];
/**
 * Every reason a coordination request cannot be a recovery request at all: an
 * unknown field (a caller may not smuggle a decision in), or a missing identity.
 * Structural only — whether the named diagnosis exists, whether the caller is the
 * hand-off's supervisor and whether the source may be recovered are answered
 * after this, each as its own named refusal.
 */
declare function recoveryCoordinationDefects(request: unknown): string[];
/**
 * The failed run one diagnosis is about, as the store holds it: the run its own
 * `reviewRefs` name (`<taskId>#<runId>`, or `<taskId>#no-run` for the failure
 * that had none), else the source task's newest run that settled `failed`, else
 * `null` when the task holds no run at all (a task blocked before it started).
 *
 * It mirrors the hand-off's own ref convention rather than reading it from the
 * tool package, and it is only a *derivation*: the runtime answers the same
 * question from its own store and refuses a run that is not that task's or not
 * failed, so a wrong guess here can never become an attempt.
 */
declare function recoverySourceRunId(diagnosis: {
  readonly reviewRefs: readonly string[];
  readonly taskId: string;
}, source: {
  readonly taskId: string;
  readonly runIds: readonly string[];
}, snapshot: TaskSnapshot): string | null;
/**
 * One recorded supervisor delegation, as the ledger that owns it answers this
 * plane (A6, see {@link Config.supervisorDelegation}): the store and source task
 * the hand-off was delegated into, the coordination session that took it up, the
 * session that started it, and when.
 *
 * It is what makes a recovery call attributable: "session X is the supervisor of
 * diagnosis D in this store" is answered by the ledger row, never by the caller's
 * word — the caller only names *itself*, and the entry compares that against this
 * record.
 */
interface SupervisorDelegation {
  readonly rootStoreId: string;
  readonly taskId: string;
  readonly diagnosisId: string;
  readonly sessionId: string;
  readonly actor: string;
  readonly at: string;
}
/** One recovery-coordination request, as the tool adapter hands it over (plan §F.4's `task_recover` payload). */
interface RecoveryCoordinationRequest {
  /** The diagnosis the recovery is asked for; it must be a record of the caller's own store. */
  sourceDiagnosisId: string;
  /** The caller's key: one key names one attempt of one diagnosis. */
  requestKey: string;
}
/**
 * Who asks for a recovery: the **supervisor** session of that hand-off, as a live
 * session of this deployment. The entry proves it against the ledger row
 * ({@link Config.supervisorDelegation}) and against the caller's own graph; the
 * runtime then requires a live agent for it, because the new attempt's Session is
 * spawned from it.
 */
interface RecoveryCoordinationCaller {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}
/**
 * What one coordination answered (A6): the runtime's own recovery outcome — the
 * attempt, its run and session, its status and the siblings it reads — beside the
 * hand-off facts this entry checked, so a caller can render both from one answer.
 */
interface RecoveryCoordinationOutcome extends RootRecoveryOutcome {
  /** The supervisor delegation this call was authorized by. */
  readonly handoff: {
    readonly sessionId: string;
    readonly actor: string;
    readonly diagnosisId: string;
  };
  /** What this plane checked and found, in the caller's own words. */
  readonly coordination: readonly string[];
}
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
  /** The injected supervisor-delegation source, if the assembly wired one (see {@link Config.supervisorDelegation}). */
  private readonly resolveSupervisorDelegation?;
  /** The deployment's capability table file, when it named one (see {@link Config.capabilityConfig}). */
  private readonly capabilityConfigPath?;
  /** The capability-config write's typed test seam, when this instance was built with one (see {@link Config.capabilityConfigProbe}). */
  private readonly capabilityConfigProbe?;
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
   * **A skill candidate or a capability candidate** (§F.2, A6): a capability
   * mutation is exactly one whole row (`rows` holding one entry) plus an optional
   * new execution skill, and every rule about what that row and that skill may
   * say runs at prepare, against the store the candidate would land in — this
   * step only refuses shapes. An agent_preset, task_definition or
   * bookkeeping-only proposal stays the recorded suggestion `evolution_propose`
   * wrote and is refused here by name, before the first ledger line of the
   * candidate lifecycle. Its proposal keeps its place in the ledger — a record is
   * not a candidate.
   */
  candidate(proposalId: string, versionSet: Record<string, string>, actor: string, mutation: unknown): Promise<EvolutionProposal>;
  /**
   * Move candidate → prepared: confirm the production skill **object** this
   * candidate replaces, materialize the mutation into
   * `<root>/sandbox/<proposalId>/` and snapshot those same production bytes
   * under `champion/` — the anchor for the experiment's baseline and for
   * rollback.
   *
   * The production read comes first, before any sandbox or ledger write, and it
   * is one verified read of the whole directory (`loadSkillSidecar`, the same
   * loader a worker's provider check uses), so the object is frozen as it really
   * is. A production directory with no readable `SKILL.md` has nothing to
   * replace and is refused before anything is written. Anything else that makes
   * the directory *not* the object it claims — a declaration that does not match
   * the bytes, a file no sidecar names, an unreadable or unsupported entry —
   * carries loader defects and is refused by name, because a candidate built
   * from a directory nobody could describe would let a file disappear between
   * prepare and apply. A knowledge sidecar and an execution sidecar with
   * declared resources are refused too: this ticket's object is guidance or an
   * execution provider with `resources: []`. A guidance directory has no
   * declaration for the loader to hold it to, so the files the loader found
   * beyond `SKILL.md` there — resources nobody declared, entries outside the
   * supported vocabulary — are refused here by name for that same reason: the
   * two identities below describe the fixed file set, and a directory holding
   * more than that is not the object they would claim to be.
   *
   * What is materialized is the object's fixed file set. Guidance is the
   * candidate `SKILL.md` and the champion `SKILL.md`. An execution object also
   * gets the candidate's `SKILL.contract.json` — the production declaration with
   * only `content.skillMdSha256` rewritten to the candidate's bytes, serialized
   * deterministically — and the production sidecar's exact bytes under
   * `champion/`.
   *
   * The candidate and the baseline each record a full content identity
   * (`skillContent` P2 / `skillBaseline` P3): the name, the SHA-256 of the exact
   * bytes of every materialized file (read back from disk, never re-rendered
   * from the mutation string), and — for an execution object — the file digest
   * and canonical digest of its sidecar. The two identities' shapes agree by
   * construction, so the fold can treat a disagreement as a role change it must
   * refuse.
   */
  prepare(proposalId: string, actor: string): Promise<EvolutionProposal>;
  /**
   * Move candidate → prepared for a **capability candidate** (A6): freeze the one
   * row it changes and the new execution skill it may add into
   * `<root>/sandbox/<proposalId>/`, and record the identities a later promotion,
   * commit and rollback re-prove.
   *
   * Every rule runs before the first byte is written, against the store as it
   * stands right now: the row must grant no tool the store has not authorized,
   * must not move the preset, permission or server plane, the new skill's
   * verifier must be registered *and versioned*, its required tools must be
   * inside the same authorized plane, its name must not be a production object
   * this deployment discovers, and its bytes must not be a rename of one
   * (`assertCapabilityCandidateAdmissible`). The row's own admission pre-check
   * (`precheckReplacedCapabilityRow`) runs next, with the sandbox skill root in
   * front of production discovery, so the skill is judged from the exact bytes
   * this prepare just materialized — a refusal removes the sandbox and records
   * nothing, which is what "refused with zero writes" means here.
   *
   * What is materialized is the candidate row's canonical bytes
   * (`capability/<name>.json`), the champion row's bytes when the store held one
   * (`champion/capability/<name>.json` — the anchor a rollback restores), and the
   * new skill's two files under `skills/<name>/`. The recorded identity is the
   * row (its data plus the digest of those bytes) and the store's row at prepare
   * (`null` when it held none: this candidate adds the row), together with the
   * new skill's whole-object content identity and the recorded *absence* of a
   * production object for it — a capability candidate adds a skill, and
   * improving an existing one is the same-name path. The deployment's table file
   * is read once, beside the store, and its composed identity is frozen with all
   * of them ({@link PreparedView.capabilityTable}): three whole-file digests —
   * the file as read, and the files this proposal's own apply and rollback leave
   * — so a commit writes into that file only while it reads as one of those.
   */
  private prepareCapability;
  /**
   * The capability table's own text (A6), read at prepare: the file the composed
   * identity is frozen from. A deployment that names no table file has nothing to
   * freeze ({@link prepareCapability} records none, and a capability commit
   * refuses by name when it reaches the table write); a file this deployment names
   * but that cannot be read refuses here, before the candidate is materialized or
   * recorded, because a table nothing can read is a table no later commit can
   * prove it left alone.
   */
  private capabilityTableText;
  /**
   * The store a capability candidate is judged against: the running registry
   * (the table a restart re-reads from the deployment's configuration), the
   * registered verifier vocabulary — fail-closed when it cannot be listed — and
   * every root discovery searches, the production skill root first because this
   * plane is its writer.
   */
  private capabilityStore;
  /** Every root a worker's own discovery searches, the production skill root this plane writes first. */
  private skillDiscoveryRoots;
  /**
   * The row as it would read after the write, judged by the admission pre-check
   * itself (`precheckReplacedCapabilityRow`): every skill it declares must be a
   * loadable provider, discovered from `sandboxSkillRoot` when the candidate
   * carries a new one and from the deployment's own roots otherwise, and judged
   * against the same verifier vocabulary and capability table admission uses.
   * The deployment's evolution ledger is passed in, so a provider whose
   * directory another proposal's commit left open is refused here too — asking
   * admission's own question instead of restating it.
   */
  private capabilityRowRefusals;
  /**
   * Move prepared → gated: all six Gate answers plus regression evidence refs.
   * Every ref must exist — a path on disk (relative to the repo root or
   * absolute) or an id the caller-side resolver knows (task-store evidence).
   * Existence only; nothing here executes anything. A **skill** proposal must
   * have a completed two-sided experiment and cite that experiment's report
   * (§F.2); the six answers are recorded over it. A **capability** proposal (A6)
   * gates the same way — its two-sided experiment must be complete and its report
   * cited, and the promotion evidence gate reads the same facts — except that a
   * capability sample's baseline side may be the runtime's own `not-admitted`
   * refusal, which no report of a skill experiment ever carries.
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
   * skill or capability mutation at L1–L3 (the state machine itself refuses
   * anything else — every other target type has no executor in this build); the
   * caller (the evolution_apply tool) must hold a human grant from
   * `ctx.approval.request` first, exactly as for decide. The candidate object's
   * fixed file set replaces production's — `SKILL.md` and, when the object
   * carries an execution sidecar, the derived `SKILL.contract.json` (the
   * champion snapshot covers those files only, so the write is file-level, never
   * a directory delete).
   *
   * A **capability** apply (A6) writes the new skill's files where production
   * holds nothing and installs the one row that grants them, as that same single
   * commit: the row's two states ride on the same `commit_intent` line, the files
   * are written first and the row last, and the `applied` record lands only once
   * the object loads and the registry reads the row this direction installed.
   * The registry check is the row's own baseline check — a row a third party
   * moved, and a skill name that appeared where the candidate adds one, are both
   * refused by name with nothing written.
   *
   * The commit order is the recovery rule (K2): the `commit_intent` line is
   * persisted first — proposal, direction, this approval, every target of the
   * object's file set, the content identities production must hold before
   * (`prepared.skillBaseline` P3) and after (`prepared.skillContent` P2) for
   * each file, and the sandbox candidate files as the recoverable sources — then
   * each file is replaced atomically, then the `applied` record closes the
   * intent. A failure at any stage leaves the intent open and nothing
   * half-written: every production file is one complete version or the other,
   * and {@link reconcile} (or a retry of this call) settles the intent from what
   * production actually holds — including the window where only the first file
   * was replaced. Nothing here trusts a promise or a caller-supplied "approved".
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and before the intent is recorded: the production object must still be
   * the one prepare recorded, both files. A direct service call therefore cannot
   * bypass the check the tool already ran before asking for approval. The
   * *directory* is checked as well, by the commit path, before the intent line:
   * a file that arrived beside the baseline while the human was deciding — a
   * resource nobody declared, a sidecar where the baseline had none — is refused
   * by name with nothing written ({@link objectWriteRefusal}), because the digest
   * checks describe the files this commit names and this one names two files at
   * most.
   *
   * A fresh commit also refuses, before that baseline check, a production
   * **directory** another proposal's open commit intent touches
   * ({@link assertTargetUncommitted}): the serial queue spans one process, and
   * without the per-object gate the second of two proposals prepared against the
   * same bytes would read the version the first is still committing over, pass
   * its own baseline check and move the target.
   *
   * The promotion check (S1-C item 3) runs here too, before the intent is
   * recorded: a candidate whose provider role or file shape changed while the
   * human was deciding (a sidecar that appeared in or vanished from the sandbox,
   * a declaration that moved, a verifier that was unregistered) is refused here,
   * so no entry can write something a later admission would have refused.
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
   * The verified bytes one capability commit writes, in the request's file order:
   * for an **apply** the new skill's two sandbox files (nothing to carry for a
   * row-only candidate), for a **rollback** nothing at all — the files of a new
   * object are removed, and a removal has no bytes to write again. Every byte is
   * read through {@link readPreparedCapability}, so what is committed is what the
   * prepared identity froze.
   */
  private capabilityBytes;
  /**
   * Preflight for tools before asking for approval; mutation methods repeat the
   * check. Returns the providers the promotion would put in place, each with the
   * role it may be counted as, so the callers that already gate on this check
   * can report them.
   *
   * A `skill` proposal and — since A6 — a `capability` proposal are promotable in
   * this build; every other target type is refused by name, because a type with
   * no evaluator gets no promotion and a record of one is never upgraded into new
   * evidence ({@link noEvaluatorRefusal}).
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
   *
   * For a capability candidate the whole gate is
   * `assertCapabilityPromotionEvidence` (see `promotion.ts`): the frozen row and
   * the new skill re-read and re-verified against the identities prepare
   * recorded, the registry row still reading as the baseline prepare captured,
   * every candidate rule still holding against the store as it stands now, every
   * provider the row declares loadable under the admission pre-check — and the
   * two-sided capability experiment (§F.4 "评估/应用必须同组补齐"): the frozen
   * identity, the report file, and each sample's sides re-read from the store, so
   * a `not-admitted` baseline the runtime really refused and a candidate run that
   * really passed are the only evidence a capability PROMOTE rests on.
   */
  checkPromotion(proposalId: string): Promise<PromotionCheck>;
  /**
   * The capability promotion gate, plus the one report a tool needs from it: the
   * provider role of the new skill the candidate installs, judged from the
   * sandbox directory against the table the row would produce — the same
   * validator admission runs, with the row this commit installs already folded
   * in, so the verdict is about the deployment the apply would create rather than
   * the one before it.
   */
  private checkCapabilityPromotion;
  /**
   * The store and the row pre-check a capability promotion reads, resolved from
   * this context: the effective registry, the registered verifier vocabulary and
   * the roots discovery searches (all through {@link capabilityStore}), plus the
   * same admission pre-check prepare ran — once more, against the store as it
   * stands at the gate, with the candidate's sandbox skill root in front of
   * production discovery.
   *
   * Since A6's evaluation interface the gate also reads the experiment evidence,
   * so it resolves the same four services the skill gate does
   * ({@link promotionSources}): the ledger's experiment family, the task store
   * the runs live in, the live judge vocabulary, this deployment's selection and
   * its session logs. One wiring, so the two gates cannot read different facts.
   */
  private capabilityPromotionSources;
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
   * The candidate object's provider verdict, taken from the directory the
   * promotion would write — plus the two boundaries this promotion cannot cross.
   *
   * The shape boundary (K3): the commit promotes the **fixed file set of one
   * skill object** — `SKILL.md`, plus the `SKILL.contract.json` beside it when
   * and only when the prepared identity says the object has an execution
   * sidecar. So a candidate directory that carries anything else (`references/`,
   * `scripts/`, a stray file) is refused by name, and so is a directory whose
   * file set does not match the frozen shape in either direction: a sidecar that
   * appeared where the identity records none, or one that is missing where the
   * identity records it. The role must agree with that shape too — two files
   * load as an execution provider, one file as guidance — so a candidate that
   * turned into the other kind of object is refused here rather than promoted as
   * something the frozen experiment never evaluated.
   *
   * The derivation boundary: for an execution object the candidate sidecar is
   * not the model's to write. It is re-derived here from the champion snapshot's
   * own sidecar bytes and the candidate `SKILL.md` digest, and compared with the
   * sandbox sidecar byte for byte (and by canonical digest) — so an escalated
   * `requiredTools`, a swapped verifier or any other declaration change between
   * prepare and promotion is refused by name. The champion side is checked too:
   * its bytes must still hash to the baseline identity's sidecar digest, or the
   * derivation would be built on bytes the prepare never recorded.
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
   *
   * `table` is the table the candidate is judged against, and it is a parameter
   * only because a capability candidate's new skill must be judged against the
   * table *its own row would produce* (A6): the row is not in the deployment's
   * registry yet — the commit that installs it is what this promotion check is a
   * preflight for — so judging it against the table before the write would refuse
   * every provider that closes the very gap the candidate exists for. Every other
   * caller passes nothing and reads the deployment's own registry.
   */
  private providerVerdict;
  /**
   * The capability table this service judges providers against: by default the
   * running registry, which is the table a restart re-reads from `config.yml` and
   * the one `evolution_prepare` snapshots the champion from. Absent (no
   * task-runtime in this context) means the table cannot be read — reported as an
   * unreadable grant rather than mistaken for an empty table.
   */
  private capabilityToolAnswer;
  /** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
  private effectiveCapabilities;
  /**
   * Read a prepared skill candidate's materialized object and verify it against
   * the content identity recorded at prepare (P2): the `SKILL.md` bytes, plus
   * the sidecar bytes when and only when the identity records a sidecar. The one
   * read path every stage shares: the experiment's pre-run check, every promotion
   * gate, and the apply write. Throws — never silently re-digests — when a
   * recorded file is missing, is not a regular file, its path crosses a symbolic
   * link, its bytes no longer match the recorded digest, or the sidecar's
   * presence does not match the recorded shape.
   */
  readSkillCandidate(proposalId: string): Promise<{
    skillMd: Buffer;
    sidecar?: Buffer;
  }>;
  /**
   * Read a prepared **capability** candidate back out of its sandbox and verify
   * every byte against the identities prepare recorded (A6): the frozen row, the
   * champion row when the registry held one, and the new skill's two files when
   * the candidate carries one. The one read path the experiment's freeze, the
   * promotion gate and the apply write share, so what is evaluated, promoted and
   * committed is provably the same bytes.
   */
  readCapabilityCandidate(proposalId: string): Promise<PreparedCapability>;
  /**
   * The production-baseline check (P3), on the apply seams only: the
   * evolution_apply tool runs it before asking a human, and `apply` runs it
   * again immediately before the production write, so a baseline that moved
   * while the human was deciding is still refused and a direct service call
   * cannot bypass it. Nothing here writes, merges, or overwrites — a conflict
   * only throws.
   *
   * The prepare-time baseline is a real, complete object: its `SKILL.md` bytes
   * still hash to the recorded digest, and — when the baseline records a
   * sidecar — the production `SKILL.contract.json` is there with exactly the
   * bytes prepare recorded. A missing file, a file that changed, changed type
   * (now a directory), or sits behind a symbolic link (the file itself or an
   * ancestor) is a conflict, and so is a sidecar that appeared beside a baseline
   * that had none: the shape production would be loaded in has changed, which is
   * a third party's edit like any other.
   *
   * A **capability** candidate's baseline is the registry row it read at prepare
   * (and the absence of a production object for its new skill, A6): the row must
   * still read exactly as prepare recorded it — or still be absent, for a row this
   * candidate adds — and the new skill's name must still be free. Either conflict
   * refuses by name with nothing written; a target type this build has no
   * executor for passes untouched.
   */
  checkProductionBaseline(proposalId: string): Promise<void>;
  /**
   * The capability candidate's production baseline (A6): the registry row this
   * proposal read at prepare must still read exactly the same — a row a third
   * party replaced, added or removed is a conflict, not a candidate — and the
   * new skill's name must still be free where discovery looks. Nothing here
   * writes or merges; a conflict only throws, before the commit intent exists.
   */
  private assertCapabilityBaseline;
  private assertProductionBaseline;
  private readVerifiedSkillCandidate;
  /**
   * Move applied → rolledback: undo the apply by restoring the champion snapshot
   * taken at prepare, as one commit — the same intent → atomic write →
   * completion order as apply, so an interrupted rollback is recoverable the
   * same way, including between the two files of one object. A **capability**
   * apply is undone by the same entry (A6): the registry row goes back to the row
   * prepare recorded — or is removed, when this candidate added it — and the new
   * skill's files are removed, because they did not exist before this proposal. A
   * record of another target type has no executor here: an applied preset
   * directory is refused by name rather than touched. Same approval discipline as
   * apply: the tool asks a human first, the service only executes and records.
   *
   * A rollback restores *this* proposal's baseline and nothing else, so both
   * ends are re-verified per file before the intent is recorded: every
   * production file must still carry exactly the content this proposal applied
   * (`prepared.skillContent`, P2), and every champion snapshot file must still
   * hash to the baseline prepare recorded (`prepared.skillBaseline`, P3). A file
   * a later proposal — or any other writer — changed since is refused by name
   * with nothing written, and so is a snapshot that can no longer reproduce the
   * bytes it captured: neither may be papered over by restoring an old version
   * on top of a newer one. The *directory* is checked too, by the same
   * pre-write read of the whole object a fresh commit and a recovery both run
   * ({@link objectWriteRefusal}): a rollback of a guidance object whose
   * directory grew a `SKILL.contract.json` or a file at a supported resource
   * position is refused by name before the intent line, because writing the
   * champion `SKILL.md` back would otherwise leave that entry standing — as a
   * role the completion never claimed, or a file nothing declared.
   *
   * As in {@link apply}, an open intent of this proposal is settled rather than
   * duplicated, and the result reports the recovery; an open intent of another
   * proposal that commits the same skill directory — or moves the same capability
   * row — refuses this rollback by name before anything is read or written
   * ({@link assertTargetUncommitted}).
   */
  rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome>;
  /**
   * What a capability rollback must still find before it may be recorded (A6):
   * the registry row this proposal installed, and — when it installs a new skill
   * — the files it applied. A row (or file) another writer or a later proposal
   * changed since is refused by name with nothing written and no intent recorded;
   * a rollback restores *this* proposal's baseline and never overwrites a newer
   * state.
   */
  private assertCapabilityApplied;
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
  /**
   * The capability rows a commit has left open (A6), in ledger order — the
   * sibling of {@link openIntentTargets} for the half of a capability commit
   * that is not a file. A row-only candidate (an L1 one that composes the
   * deployment's existing providers) has an empty file set, so nothing about it
   * can be keyed on a directory; and a candidate that also carries a new skill
   * moves its row *last*, after the files, so a commit stopped between the two
   * leaves a registry row nothing else names.
   *
   * The same fold, over the same open intents: one intent list, two projections,
   * so an admission gate that reads both cannot see two different pictures of
   * what is in flight. Pure, like its sibling — a read never settles anything.
   */
  openIntentCapabilities(): Promise<readonly string[]>;
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
   * the proposal already carries: every file of the object's fixed set with its
   * absolute target (the same paths {@link applyTargets} names to the human), the
   * content identity production must hold before and after that file, and the
   * recoverable source under the ledger root. `apply` commits the candidate files
   * over the recorded baseline; `rollback` commits the champion snapshot files
   * over the content the apply installed — the two identities swap per file, and
   * nothing else about the two directions differs. The order is the object's:
   * `SKILL.md` first, the sidecar second when there is one.
   */
  private commitRequest;
  /**
   * The commit one capability candidate binds (A6): the one row it moves, and —
   * when it carries a new skill — that skill's two files, as a create on apply
   * (`baselineSha256: null`: the target must not exist) and a removal on rollback
   * (`contentSha256: null`, no source: there are no bytes to write again). The
   * row's two sides mirror the files': an apply installs the candidate row over
   * the recorded baseline (or over the absence of any row), a rollback restores
   * the baseline row — or removes the row this candidate added. The request is
   * read off the prepared record only, so what the intent says is what prepare
   * froze.
   */
  private capabilityCommitRequest;
  /**
   * The production paths a commit of this proposal may write: for a skill
   * candidate the object's fixed file set under `<skillRoot>/<name>/` —
   * `SKILL.md` always, and the `SKILL.contract.json` beside it when the prepared
   * identity records an execution sidecar; for a capability candidate the new
   * skill's two files, or none for a row-only candidate. Each path is confined to
   * the skill root, in commit order.
   */
  private commitTargets;
  /**
   * A fresh commit of `proposal` refuses, by name, a production **directory**
   * another proposal's open commit intent touches. {@link commitExclusive}
   * serializes one process's commits and nothing else, so a second commit queued
   * behind an unfinished first one would read the pre-commit bytes, pass its own
   * baseline check and move the target, leaving the first intent with no commit
   * path left to settle it: `blocked` by name, its target refused by admission
   * until something restores the bytes that intent names as its baseline. The
   * per-object gate is what stops that; it matches on the directory that holds
   * the files, because one intent covers a skill's fixed file set together — a
   * second proposal prepared against the same skill is blocked by whichever file
   * of the other intent this proposal's file set shares a directory with. It is
   * in-process, per production object and under the deployment's existing
   * single-writer constraint — not a distributed lock, not a queue and not a
   * retry loop; the intent is settled first, by {@link reconcile} or by a retry
   * of the proposal that owns it.
   *
   * Only a materialized skill or capability mutation has commit targets this
   * build may write: every other proposal keeps the named refusal its own entry
   * produces ({@link checkPromotion}, {@link commitRequest}). A capability
   * candidate's row is a second object of the same kind: the same row moved by
   * two proposals at once is refused here as well, before either intent exists,
   * because the second would find the first's row where its own baseline check
   * expects the state it read.
   */
  private assertTargetUncommitted;
  /**
   * The named reason a commit intent must not write the directory its file set
   * lives in, or `null` when that directory holds this object's own files and
   * nothing else — the *pre-write* half of the whole-object rule (K3-4: a third
   * party's change is never overwritten, and the object a completion claims is
   * the object the directory really holds).
   *
   * The per-file digests an intent records describe the files it *names*, so an
   * entry it does not name is exactly what they cannot see: a directory that grew
   * one — a guidance skill wearing a declaration nobody wrote through this
   * service, a resource no identity covers — passes every pre-write check, is
   * written anyway, and only the whole-object verification *after* the write
   * notices, with production already moved and the intent left open. This asks
   * the same question of the same directory before a byte moves, and it is the
   * only check that can answer it there.
   *
   * An execution object's fixed file set is two named files in one directory and
   * its declaration names every file the object covers, so the directory must
   * name exactly those two basenames back — plus each target's own staging
   * leftovers (`.${basename}.tmp-`, non-directories: the same rule, in the same
   * directory, the commit path's own sweep uses, so a recovery can still sweep
   * the temp file a killed attempt left). Any other entry — an undeclared
   * resource, a stranger's file, a directory under a supported resource name — is
   * refused by name: an execution object that does not name every file in its
   * directory is not the object its declaration describes. The loader's tolerance
   * for entries outside the supported vocabulary does not apply here for the same
   * reason: an execution declaration covers files, not a word list.
   *
   * A guidance object is one file with no declaration for a loader to hold the
   * directory to, so the question is asked of the loader ({@link loadSkillSidecar}
   * — the same read prepare, admission and the write-time verification use) and
   * the directory is refused when it now carries a sidecar (guidance that turned
   * into an execution object: the role this intent's committed file set does not
   * describe), when it holds a file at a supported resource position (a file no
   * identity covers, which a one-file commit would leave in place while claiming
   * to have written the object), or when it is no longer a loadable object at all
   * (`defects`). Entries the supported vocabulary does not cover (`uncovered`)
   * are deliberately tolerated: the guidance verdict judges those no defect, and
   * a guidance commit has always left them exactly where they are.
   *
   * A mixed pair — one file still at the baseline, the other already holding the
   * committed content — passes, as it must: that is the window an interrupted
   * two-file commit leaves for a recovery to finish, not a foreign change. This
   * reads the directory and writes nothing.
   *
   * Two more states come from A6, and both are answered about the *directory*
   * rather than the files, for the same reason: a file set whose baseline is the
   * **absence** of the object (an apply that creates a new skill) may only write
   * where production holds nothing but this object's own staging leftovers, and a
   * file set whose content is that absence (the rollback that removes it) may
   * only remove files from a directory that holds exactly those files — anything
   * else in either place is an entry this commit never created and must not touch.
   */
  private objectWriteRefusal;
  /**
   * The narrow host the commit path runs on (see `commit.ts`): the roots a
   * target and a source resolve against, the service's own verified reads — P2
   * for a candidate, the walk-verified production read, the ledger-root read for
   * a snapshot — the append funnel every line goes through (format check, staged
   * fold, serialized write), the whole-object checks that open and close a commit
   * (what the directory must be before anything is written, what it is after,
   * and whether the capability table a row would be written into is still the
   * file prepare froze), and the probe seam. The commit path owns the order; the
   * service owns what may be read, what a line must say, and what "production is
   * the object this direction promised" means.
   */
  private commitHost;
  /**
   * The whole-object verification a commit runs after its last file is written
   * and before the completion is recorded — in a fresh commit and in every
   * reconciliation branch that records one.
   *
   * It reads production the way a loader does (`loadSkillSidecar` through the
   * same {@link providerVerdict} every promotion uses, so the verdict carries
   * the verifier vocabulary and the capability table this deployment really
   * has) and requires that the directory *is* one loadable object carrying the
   * identity this direction promised:
   *
   * - the verdict is valid — no defect of any kind: a `SKILL.md` a declaration
   *   does not cover, a declaration the bytes do not match, a file nobody
   *   declares, a file set the shape rules refuse;
   * - the role matches the file set the intent committed: two files load as an
   *   execution provider, one file as guidance (a knowledge verdict is
   *   impossible here, and would be refused by the same comparison);
   * - `SKILL.md` carries the digest the first file's record named;
   * - with two files, the production sidecar's exact bytes hash to the second
   *   file's record, and the loaded declaration digest is the one the direction
   *   promised — for an apply the candidate identity prepare recorded, for a
   *   rollback the production baseline it recorded. This is also what makes the
   *   completion a statement about the registry: `contractDigest` is exactly the
   *   identity a registry revision absorbs, so by the time the completion line
   *   is written, the registry's own view of the skill is already the new object.
   *
   * A throw is a named refusal: the intent stays open, no completion is
   * recorded, and the caller and the next reconciliation both see the same
   * refusal rather than a settled commit a loader would not accept. It never
   * writes: this check reads production as it stands. Its counterpart is the
   * *before* picture, {@link objectWriteRefusal}, asked of the same directory
   * before the intent line and before any branch of a recovery writes — this one
   * closes the window after the write, that one keeps a directory which is not
   * the object from being written at all.
   */
  private verifyCommitted;
  /**
   * The capability table's **own text** (A6): the durable half of a capability
   * commit, written between the registry's row and the completion line — in a
   * fresh commit and in every reconciliation branch alike, because
   * {@link verifyCommitted} is the one place every path passes before it records
   * one.
   *
   * Why it lives here and not beside the registry seam: an applied row whose file
   * was not written is a row the next restart loses, and the completion line is
   * the claim that it will not be lost. Both facts are re-established by writing
   * the row (or removing it, for a rollback) and reading the file back before the
   * completion; a crash in between leaves the intent open, and the next
   * reconciliation repeats the same edit — it is idempotent, and the registry's
   * row is already the one the intent records.
   *
   * A deployment that names no file refuses by name rather than recording a
   * completion for a row that lives only in this process.
   *
   * The edit is written only into a file that reads as one of the two whole-file
   * states this direction's prepare froze (EVO-2 内容漂移, {@link
   * PreparedView.capabilityTable}) — the state it starts from, or the state its
   * own write leaves — so a third party's edit of that file, of the row itself or
   * of any other byte, refuses by name instead of being overwritten. A proposal
   * whose prepare froze no table identity (a line written before that field
   * existed) refuses too: nothing here writes a file it cannot prove it read.
   */
  private persistCapabilityRowText;
  /**
   * The capability table half of the commit path's **before** picture (A6, EVO-2):
   * the named reason this commit must not write anything yet, because the table
   * file its row would be written into no longer reads as a state this proposal
   * froze — or `null` when it does, or when this commit moves no row.
   *
   * It is asked by {@link commitIntent} after the intent line and before the first
   * write, and by every reconciliation before any branch writes or settles: the
   * row is written into that file *last* of a commit's steps, so without this gate
   * a drifted table would be discovered only after the skill files and the
   * registry row had already moved, leaving a half-product a human must settle.
   * Asked here, a third party's edit stops the commit with the intent open and
   * production untouched. The file carries the deployment's credentials, so the
   * reason names the file, the row and the digests compared — never a line of it.
   */
  private tableWriteRefusal;
  /**
   * The file half of {@link verifyCommitted}. A direction that ends with files
   * **removed** (a capability rollback, A6) is verified as that: every file the
   * intent named must be gone, and nothing is loaded — there is no object left to
   * load. Every other direction is the whole-object verification described above.
   */
  private verifyCommittedFiles;
  /**
   * The capability half of {@link verifyCommitted} (A6): the registry must read as
   * the row this direction installed — the row's canonical digest, or no row at
   * all when the direction removes it. This is what makes the completion a
   * statement about the registry rather than about the files: by the time the
   * line is written, the deployment's own registry view is already the new one,
   * and a completion is never recorded over a registry that still holds the
   * state before the commit.
   */
  private verifyCommittedRow;
  /**
   * Serialize one commit — its intent, its production write and its completion —
   * behind every commit already running or queued, and behind every write the
   * ledger funnel has not appended yet. This is a single-process queue, not a
   * cross-process lock: the deployment's one-writer constraint still stands, and
   * a second process is not excluded. Serialization is not what keeps two
   * proposals on one target apart — a queued second commit would read the
   * pre-commit bytes and refuse only if its own baseline check happened to
   * disagree — so a fresh commit also refuses a target another proposal's open
   * intent names ({@link assertTargetUncommitted}).
   */
  private commitExclusive;
  /** Folded view of one proposal, or throws on an unknown id. */
  get(proposalId: string): Promise<EvolutionProposal>;
  /** Folded views, newest proposal first, optionally filtered. */
  list(filter?: ListFilter): Promise<EvolutionProposal[]>;
  /**
   * The **recovery coordination** entry (A6, plan §F.4): take one recorded
   * Diagnosis of a failed root task and — if everything this plane owns is in
   * order — open the task's new attempt through the runtime's own entry.
   *
   * The call chain is fixed (plan §F.4: 工具适配 → evolution 的恢复协调入口 →
   * task-runtime 的执行恢复入口) and each layer re-checks its own rules. What
   * *this* layer owns, in order, before anything is started:
   *
   * 1. **the request's closed shape** — two non-empty ids and nothing else: no
   *    authorization, no approval, no decision, no reuse list. A model cannot
   *    smuggle a permission into a recovery because there is nowhere to put one.
   * 2. **the caller's delegation** — the session must be the supervisor the
   *    ledger recorded for *this* diagnosis (the injected
   *    {@link Config.supervisorDelegation}), and the store the delegation names
   *    must be the store of the caller's own graph. An ordinary root, a worker,
   *    a reviewer, another graph's supervisor and an unknown session are all
   *    refused by name here; nothing is derived from the ids the caller passed.
   * 3. **the diagnosis and its source** — the store must hold the diagnosis, the
   *    diagnosis must name a task of that store, that task must be the store's
   *    own root, and it must be in a failing state: a `verified` source is
   *    refused outright (a successful goal is not recovered, and this build has
   *    no frozen metric or comparator that could judge "faster or cheaper" — its
   *    suggestions stay records, with no promotion, no application and no new
   *    run), and a source whose run is still live is refused rather than
   *    hot-swapped.
   * 4. **the candidate association** — the proposals this ledger holds for that
   *    diagnosis (`sourceRefs` naming `diagnosis:<id>`). **Only a capability
   *    change has to be in force**: every associated proposal that targets a
   *    capability must read `applied` (approved by a person and committed) and
   *    not rolled back, or the recovery is refused by name with nothing started
   *    — the gap it stands for is still open. A pure artifact gap carries no
   *    proposal at all and is *not* refused for that: what it needs is the
   *    source and the capability the production really uses, so this layer
   *    checks the source's required rows resolve in the deployment's current
   *    table and leaves the rest to the runtime.
   * 5. **the attempt's own identity** — a diagnosis with an attempt already in
   *    flight is refused under a *different* key (one diagnosis never runs two
   *    attempts at once); the same key is passed through, and the runtime
   *    answers it from the record it wrote (this layer keeps no attempt table of
   *    its own: the run's `recovery` field is the fact).
   * 6. **the runtime call** — the host composition layer's own entry
   *    (`TaskRuntime.recoverRootTask`), which re-checks the store's facts, the
   *    contract, the providers, the ceilings and the idempotency before it
   *    writes, and never reads this ledger.
   *
   * Nothing here writes: the decision is a read of the store, this ledger and the
   * injected delegation, and the one write that happens is the runtime's.
   */
  coordinateRecovery(request: RecoveryCoordinationRequest, caller: RecoveryCoordinationCaller): Promise<RecoveryCoordinationOutcome>;
  /**
   * The one runtime call this entry makes, with the answer every path carries: the
   * attempt the runtime opened or already had, and the hand-off facts this plane
   * checked. A deployment without that entry refuses by name — a recovery cannot
   * be opened by this plane, which owns no execution state.
   */
  private recoverThroughRuntime;
  /** The root task store of one live session, derived from its own graph — never from an id the caller passed. */
  private storeOfSession;
  private refExistsOnDisk;
  /**
   * Early state-machine check so a wrong-state call reports the transition
   * error before any payload validation; `append` re-checks under the write
   * lock, which is the authoritative gate. Returns the folded proposal so
   * callers can validate payloads against targetType / baseVersion / mutation.
   */
  private assertNext;
  /**
   * Write the candidate object into the sandbox dir `dir`, then the champion
   * snapshot from the production bytes the caller already read (P3: one read of
   * the production files, before anything was written — those bytes become the
   * snapshot and the recorded `skillBaseline` identity together, so the two can
   * never describe two different reads). The candidate's sidecar, when the
   * object has one, is *derived* here ({@link candidateSidecar}) and not taken
   * from the mutation: the model submits `SKILL.md` text and nothing else. Every
   * path goes through `resolveWithin`, so a write can never land outside the
   * sandbox; the production skill root is read-only here.
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
   * `<proposalId>/<direction>`, only with a well-formed fixed file set, and only
   * when the proposal has no other open intent; an `applied`/`rolledback`
   * completion is admitted only when it closes the open intent of its own
   * direction — same id, same approval, that exact file set in the intent's own
   * order — and it closes it. So a completion cannot be recorded without its
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
   * Validate the staged fold first; memory commits only once the line's bytes
   * have reached the file. The format check runs before the fold, so a record
   * declaring another version is refused before it can be folded — and, because
   * nothing is written until the fold has accepted the staged ledger, before a
   * byte changes on disk. The line itself goes through
   * {@link appendLedgerLine}, the ledger's one durable append.
   */
  private append;
  /**
   * The ledger's one durable write path: append one whole line and make it
   * durable before returning — `open` for append, write the entire line, `fsync`
   * the file, close, and then `fsync` the ledger root together with every
   * directory the recursive `mkdir` just created (plus the parent that names the
   * outermost of them), so neither a freshly created ledger file nor a freshly
   * created ledger directory can be lost by a power cut while the write that
   * referenced it survives. {@link append} and {@link recordExperimentStart} both
   * come through here, so nothing writes the ledger beside this method — the
   * funnel every lifecycle, commit and sample line takes is also the funnel that
   * makes it durable.
   *
   * The line goes out through `writeFile`, not a single `write`: `writeFile`
   * writes the whole payload in as many calls as that takes (the behaviour
   * `appendFile` had), so a filesystem that accepts only part of the payload in
   * one call cannot leave a truncated JSON line behind — a fragment would be
   * fsynced as if it were the record, and the ledger would no longer load.
   *
   * `adopt` runs exactly once, immediately after the whole line reaches the
   * file: from that moment the caller's in-memory ledger holds the record the
   * file holds, so a later call in this process sees the line it is really
   * looking at instead of appending a second one.
   *
   * What a failure leaves behind, step by step:
   *
   * - the directory could not be created or the file could not be opened —
   *   nothing was written: the file is byte-identical to what it held and memory
   *   is untouched;
   * - the write failed — a mid-write failure (a full disk, an I/O error) can have
   *   put part of the line in the file before it reported, so the file is
   *   truncated back to the size it had before this call: a fragment is never
   *   left for the next load to refuse the whole ledger over, and memory stays
   *   untouched. If even that truncate fails, the error says so and says the
   *   ledger may hold a partial line — it never pretends the file is clean;
   * - the file's or a directory's fsync failed — the *whole* line is in the file
   *   (and adopted in memory) but is not durable: a named error naming the ledger
   *   path and the failed step, because the caller must not continue as if the
   *   write the line would justify had happened.
   */
  private appendLedgerLine;
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
export { APPLYABLE_TARGET_TYPES, ApplyOutcome, ApplyView, CapabilityCandidate, CapabilityOverlay, CapabilityRow, CapabilityRowIdentity, CapabilitySkill, CapabilityStoreView, ChampionState, CommitCapability, CommitDirection, CommitIntentRecord, CommitIntentView, Config, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_ADMISSION_SOURCES, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionDecision, EvolutionLevel, EvolutionProposal, EvolutionRecord, EvolutionService, EvolutionService as default, EvolutionStatus, ExperimentAdmissionRefusal, ExperimentAdmissionSource, ExperimentBudget, ExperimentCost, ExperimentCriterionDetail, ExperimentKey, ExperimentLedger, ExperimentOutcome, ExperimentRecord, ExperimentReport, ExperimentRequest, ExperimentResult, ExperimentSampleComparison, ExperimentSampleRecord, ExperimentSampleRole, ExperimentSampleSpec, ExperimentSampleVerdict, ExperimentSide, ExperimentSideComparison, ExperimentSideDetail, ExperimentSources, ExperimentSpec, ExperimentStartedRecord, ExperimentVerdict, ExperimentView, FrozenCapability, FrozenCapabilityRow, FrozenCapabilitySide, FrozenCriterion, FrozenExperiment, FrozenProviderIdentity, FrozenProviderSkill, FrozenSample, FrozenSampleAdmission, GateAnswers, ListFilter, ModelSelection, PrecheckSkillVerdict, PreparedCapability, PreparedView, PromotionCheck, PromotionProvider, ProposeInput, ProviderPrecheckView, RecoveryCoordinationCaller, RecoveryCoordinationOutcome, RecoveryCoordinationRequest, ReplayCriterionDiff, ReplayCriterionSummary, ReplaySideSummary, SideRelation, SkillContentIdentity, SkillContractIdentity, SkillMutation, SupervisorDelegation, VerifierVocabularyView, agentOptionsOf, applyTargets, assertAdmissionRecord, assertCapabilityCandidateAdmissible, assertCapabilityRow, assertCapabilityRowAdmissible, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, authorizedToolPlane, buildExperimentReport, canonicalJson, capabilityOverlay, capabilityRefusal, capabilityRowBytes, capabilityRowDigest, capabilityRowIdentity, capabilityTableWith, compareExperimentSides, compareReplaySides, digestOf, directoryDigest, discoverSkill, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, overallExperimentVerdict, preparedContentDigestOf, protectedInputsDigest, readPreparedCapability, recoveryCoordinationDefects, recoverySourceRunId, renderProviderRoles, resumeExperiment, runExperiment, validateCapabilityMutation };