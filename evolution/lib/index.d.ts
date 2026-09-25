import { Context, Service } from "@deepseek-ai/cordis";
import { CapabilityConfig, ReplayRunOutcome, ReplayTaskOptions } from "@dangosys/dsh-singularity-task-runtime";
import { ProposalTargetType, TaskSnapshot } from "@dangosys/dsh-singularity-task";
import { SessionId } from "@deepseek-ai/dsh-session";

//#region src/config-edit.d.ts

type CapabilityRowAction = 'replaced' | 'added' | 'removed';
interface CapabilityRowResult {
  text: string;
  action: CapabilityRowAction;
}
/**
 * The row's verbatim source lines (`\n`-joined, block-form body and riding
 * comments included), or null when no row for `name` exists. The rollback
 * anchor of a capability prepare (W19, guide §4.2 #18): restoring these lines
 * beats re-rendering the registry entry, whose schema fills default arrays the
 * source text never spelled out.
 */
declare function readCapabilityRowSource(text: string, name: string): string | null;
/**
 * Splice `source` (the `\n`-joined lines `readCapabilityRowSource` captured at
 * prepare time) back over the current row for `name`, byte-for-byte; when the
 * row is gone, insert the lines where a new row would go. Every other byte of
 * the file is preserved, exactly as with `editCapabilityRow`.
 */
declare function restoreCapabilityRowSource(text: string, name: string, source: string): CapabilityRowResult;
/**
 * Replace (`entry` given, row exists), add (`entry` given, row absent), or
 * remove (`entry` null) the capabilities row for `name`. The row is one line in
 * flow form (`name: { … }`) or a block-form span (`name:` plus deeper-indented
 * lines and the comment lines that ride with it); a replacement always lands as
 * one flow line at the row's indent, an addition after the last existing row's
 * whole span. Removing the final row collapses the mapping header to
 * `capabilities: {}` so the document still parses as a mapping, and adding to a
 * collapsed header reopens it — `capabilities: {}` cannot take block rows below
 * it. Throws — editing nothing — when document 1 has no task-runtime entry, more
 * than one (the error names every matching line — refusing to guess which one
 * governs), no capabilities mapping, or a removal names no existing row.
 */
declare function editCapabilityRow(text: string, name: string, entry: CapabilityConfig | null): CapabilityRowResult;
//#endregion
//#region src/replay.d.ts

/** Overall replay verdict: whether the candidate is not worse than the champion. */
type ReplayVerdict = 'not-worse' | 'worse' | 'inconclusive' | 'manual';
/** Per-task comparison outcome; `manual` marks the agent_preset v1 boundary (nothing executed). */
type ReplayRelation = 'not-worse' | 'worse' | 'inconclusive' | 'manual';
declare const REPLAY_VERDICTS: readonly ReplayVerdict[];
declare const REPLAY_RELATIONS: readonly ReplayRelation[];
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
 * at prepare, carried by the replay report, and re-verified before the
 * `replayed` record is written, at every promotion gate, and on the apply
 * write — so the chain can never validate one file's content and apply
 * another's. Only `targetType: skill` candidates carry one.
 */
interface SkillContentIdentity {
  /** The skill name the mutation targets (`mutation.name`, the proposal's targetId). */
  name: string;
  /** Lowercase SHA-256 hex over the exact file bytes — no trim, no newline conversion. */
  sha256: string;
}
/** One side of one task's comparison. The champion is the historical record; the candidate is the fresh replay run. */
interface ReplaySideSummary {
  taskId: string;
  runId?: string;
  outcome: 'verified' | 'failed' | 'cancelled';
  durationMs?: number;
  criteria: ReplayCriterionSummary[];
}
/** One criterion whose verdict differs between the sides (absent side = the criterion exists only on the other). */
interface ReplayCriterionDiff {
  criterionId: string;
  champion?: string;
  candidate?: string;
}
interface ReplayTaskComparison {
  /** The champion (historical) task id. */
  taskId: string;
  /** The replay task created for the candidate run. */
  candidateTaskId?: string;
  champion: ReplaySideSummary;
  candidate?: ReplaySideSummary;
  /** True when outcome and every shared criterion verdict agree and no criterion moved between the sides. */
  verdictMatch: boolean;
  /** Criterion-level differences (both verdict flips and added/removed criteria). */
  criteriaDiff: ReplayCriterionDiff[];
  relation: ReplayRelation;
}
interface ReplayReport {
  formatVersion: 1;
  proposalId: string;
  targetType: ProposalTargetType;
  at: string;
  /** `executed`: candidate runs really ran. `manual`: nothing executed (agent_preset v1) and `manualReason` says why. */
  mode: 'executed' | 'manual';
  manualReason?: string;
  /**
   * Skill candidates only (P2): the candidate content identity this replay ran
   * against — it must equal the `prepared` record's `skillContent`. Other
   * targetTypes carry no skill fields.
   */
  candidateContent?: SkillContentIdentity;
  /** Comparisons over `taskIds` (the tasks the proposal's evidence already covers). */
  observed: ReplayTaskComparison[];
  /** Comparisons over `holdoutTaskIds`; `executed: false` + empty tasks reads as "not run". */
  holdout: {
    executed: boolean;
    tasks: ReplayTaskComparison[];
  };
  verdict: ReplayVerdict;
}
/**
 * Compare one task's two sides. A regression is mechanical: the candidate's
 * outcome ranks below the champion's, or a criterion both sides report flipped
 * from pass to anything else. An unrankable candidate outcome (cancelled) is
 * inconclusive — it says nothing about the candidate's quality.
 */
declare function compareReplaySides(champion: ReplaySideSummary, candidate: ReplaySideSummary): Pick<ReplayTaskComparison, 'verdictMatch' | 'criteriaDiff' | 'relation'>;
/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
declare function overallReplayVerdict(comparisons: readonly Pick<ReplayTaskComparison, 'relation'>[]): ReplayVerdict;
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
declare function assertReplayReport(proposal: {
  proposalId: string;
  targetType: ProposalTargetType;
}, report: unknown): asserts report is ReplayReport;
/** A human approval cannot substitute for two independent, non-regressing replay groups. */
declare function assertReplayPromotable(report: ReplayReport): void;
//#endregion
//#region src/evolution.d.ts

type EvolutionLevel = 'L1' | 'L2' | 'L3' | 'L4';
type EvolutionStatus = 'proposed' | 'candidate' | 'prepared' | 'replayed' | 'gated' | 'decided' | 'applied' | 'rolledback';
/** The three frozen decision values of the Validation Gate (细化想法4.md §32). */
type EvolutionDecision = 'PROMOTE' | 'REJECT' | 'KEEP_FOR_FURTHER_RESEARCH';
declare const EVOLUTION_LEVELS: readonly EvolutionLevel[];
declare const EVOLUTION_DECISIONS: readonly EvolutionDecision[];
/**
 * The four target types whose mutations this version materializes mechanically
 * into the sandbox. Mutations on the other five target types (tool /
 * decomposition_policy / workflow_policy / verifier / runtime_policy) are
 * free-form structured descriptions, recorded with `mechanical: false` —
 * bookkeeping only, never materialized.
 */
declare const MECHANICAL_TARGET_TYPES: readonly ProposalTargetType[];
/** True for the target types whose mutations materialize mechanically into the sandbox. */
declare function mutationMechanical(targetType: ProposalTargetType): boolean;
/**
 * The three target types `evolution_apply` promotes mechanically (W16): the
 * sandbox copy lands on a real production root. task_definition stays manual
 * (the task store keeps no definitions registry — W14's fidelity cap), and the
 * five bookkeeping-only types never materialized anything to apply.
 */
declare const APPLYABLE_TARGET_TYPES: readonly ProposalTargetType[];
/** skill mutation: the full SKILL.md text for `<skills root>/<name>/SKILL.md`. */
interface SkillMutation {
  name: string;
  content: string;
}
/** agent_preset mutation: full file contents, paths relative to the preset directory. */
interface AgentPresetMutation {
  presetId: string;
  files: {
    path: string;
    content: string;
  }[];
}
/**
 * capability mutation: one entry of the task-runtime capability table
 * (`{ skills?, tools?, preset?, permission?, mcpServers? }`); takes effect with
 * whole-row replacement semantics, and only when a human edits production.
 */
interface CapabilityMutation {
  name: string;
  entry: CapabilityConfig;
}
/** task_definition mutation: the new version's definition fields, deltaing from baseVersion. */
interface TaskDefinitionMutation {
  baseVersion: string;
  definition: Record<string, unknown>;
}
type MechanicalMutation = SkillMutation | AgentPresetMutation | CapabilityMutation | TaskDefinitionMutation;
/** Where the champion snapshot of one prepared proposal stands. */
type ChampionState = /** Written under the sandbox's `champion/` dir. */
'captured'
/** The production target does not exist yet (new skill / capability / …) — champion: null. */ | 'missing'
/** Non-mechanical mutation: nothing materialized, no anchor. */ | 'none';
declare const CHAMPION_STATES: readonly ChampionState[];
/**
 * Where a capability champion snapshot came from (W19, guide §4.2 #18):
 * - `config-text` — the row existed in config.yml; the snapshot also holds its
 *   verbatim source lines (`champion/capability-table.source.txt`) and rollback
 *   writes those lines back byte-for-byte.
 * - `code-default` — the capability exists only in the code default table (no
 *   config.yml row); the snapshot holds the registry entry as the comparison
 *   anchor, and rollback removes the config.yml row so the default governs
 *   again (plus a runtime override back to the default entry).
 * - `missing` — the capability did not exist at all; rollback deletes what the
 *   apply added (`champion: 'missing'` carries the same fact; this field keeps
 *   the three-way distinction readable on one field).
 * Recorded on the `prepared` ledger record of capability proposals only;
 * records written before this field existed carry no `championSource`, hold a
 * registry-form snapshot, and roll back exactly as they always did.
 */
type ChampionSource = 'config-text' | 'code-default' | 'missing';
declare const CHAMPION_SOURCES: readonly ChampionSource[];
/** Folded view of one `prepared` record. */
interface PreparedView {
  /** Sandbox dir relative to the ledger root (`sandbox/<proposalId>`); null when nothing was materialized. */
  sandbox: string | null;
  mechanical: boolean;
  champion: ChampionState;
  /** Capability prepares only (W19): where the champion snapshot came from; absent on pre-W19 records. */
  championSource?: ChampionSource;
  /** Skill prepares only (P2): the content identity recorded for the materialized candidate `SKILL.md`. */
  skillContent?: SkillContentIdentity;
  /**
   * Skill prepares only (P3): the content identity of the production
   * `skills/<name>/SKILL.md` as it stood at prepare — from the same single read
   * that produced the champion snapshot, so snapshot and digest can never
   * disagree. Absent on records written before the baseline was recorded, on
   * `champion: 'missing'` prepares (nothing was there to digest), and on every
   * non-skill targetType; a captured champion without it cannot prove its
   * baseline and refuses a new apply.
   */
  skillBaseline?: SkillContentIdentity;
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[];
}
/**
 * Champion content the caller resolves for the target types whose production
 * state lives outside this plane (plane separation: the ledger never reads the
 * task store or the capability registry itself; skill/preset champions it reads
 * from the production roots directly). Pass null when the production target is
 * known absent; omitting the key for a capability / task_definition prepare is
 * an error.
 */
interface PrepareChampion {
  /**
   * The mutation-named capability's current effective entry (taskRuntime.listCapabilities), or null when new.
   * Kept as the comparison anchor and the runtime-override payload; the rollback
   * text anchor is the config.yml row's source text, which the service reads
   * itself (W19).
   */
  capabilityEntry?: CapabilityConfig | null;
  /** The baseVersion definition snapshot from the task store, or null when unresolvable. */
  taskDefinition?: unknown;
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
/** One immutable ledger line. A state migration appends a new record; nothing is ever rewritten in place. */
type EvolutionRecord = {
  formatVersion: 1;
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
  formatVersion: 1;
  kind: 'candidate';
  proposalId: string;
  /** Complete version set the candidate aligns to (branch-model bookkeeping; v1 builds no real branch). */
  versionSet: Record<string, string>;
  /**
   * Optional structured patch description, shaped by the proposal's
   * targetType (see the *Mutation interfaces). A candidate carrying one
   * must be prepared (sandbox materialization) before it can gate; a
   * mutation-less (manual) candidate gates directly.
   */
  mutation?: unknown;
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'prepared';
  proposalId: string;
  /** Sandbox dir relative to the ledger root, or null for a bookkeeping-only (non-mechanical) mutation. */
  sandbox: string | null;
  mechanical: boolean;
  champion: ChampionState;
  /** Capability prepares only (W19): where the champion snapshot came from; absent on pre-W19 records. */
  championSource?: ChampionSource;
  /**
   * Skill prepares only (P2): the content identity of the materialized
   * candidate `SKILL.md` — the skill name plus the SHA-256 of the exact
   * file bytes. Absent on records written before content binding and on
   * every non-skill targetType; those old skill candidates cannot be newly
   * promoted without a fresh candidate and evaluation.
   */
  skillContent?: SkillContentIdentity;
  /**
   * Skill prepares only (P3): the content identity of the production
   * `SKILL.md` as it stood at prepare. Absent on records written before the
   * baseline was recorded and on every non-skill targetType; those old
   * skill candidates cannot be newly applied without a fresh candidate and
   * evaluation.
   */
  skillBaseline?: SkillContentIdentity;
  /** Materialized files relative to the sandbox dir — candidate files first, champion snapshot files after. */
  files: string[];
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'replayed';
  proposalId: string;
  /** SHA-256 of the report bytes. Historical records may lack it; those cannot newly promote. */
  reportDigest?: string;
  /** Report path relative to the ledger root (`sandbox/<proposalId>/replay-report.json`). */
  report: string;
  /** Overall verdict: whether the candidate is not worse than the champion. */
  verdict: ReplayVerdict;
  /** Per-task relation summary, observed then holdout. */
  tasks: {
    taskId: string;
    relation: ReplayRelation;
    holdout: boolean;
  }[];
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'gated';
  proposalId: string;
  gate: GateAnswers;
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'decided';
  proposalId: string;
  decision: EvolutionDecision;
  note?: string;
  /**
   * Human-review evidence: the approval call id of the evolution_decide
   * request that granted this decision, the same `approval:<callId>` shape
   * as applied/rolledback. Optional in the record type only so ledger
   * lines written before this field existed still fold; every new decided
   * record carries it.
   */
  approvalRef?: string;
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'applied';
  proposalId: string;
  /** Production write targets, for audit (absolute paths; the capability entry describes its config.yml row). */
  targets: string[];
  /** Human-review evidence: the approval call id of the evolution_apply request that granted this write. */
  approvalRef: string;
  actor: string;
  at: string;
} | {
  formatVersion: 1;
  kind: 'rolledback';
  proposalId: string;
  /** Production write targets of the rollback (restored champion or deleted product), for audit. */
  targets: string[];
  /** Human-review evidence: the approval call id of the evolution_rollback request that granted this write. */
  approvalRef: string;
  actor: string;
  at: string;
};
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
   * Capability only: the row now in effect — the candidate entry on apply, the
   * restored champion entry on rollback, null when the rollback removed a
   * newly-added row. The tool mirrors it into the runtime registry so the
   * change takes effect without a restart.
   */
  capability?: {
    name: string;
    entry: CapabilityConfig | null;
  };
  /**
   * What the promotion check validated about the providers this apply put in
   * place ({@link PromotionCheck.providers}): the candidate skill of a skill
   * apply, every skill a replaced/added capability row grants — each with the
   * role it may be counted as, so a knowledge or guidance provider is reported
   * as such rather than presented as the execution provider it is not. Empty
   * when the target carries no provider. Not persisted: the ledger's `applied`
   * record keeps its shape, and a run's own binding is where a selected role is
   * recorded for real.
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
/** Folded view of one `replayed` record. */
interface ReplayedView {
  /** SHA-256 recorded at replay; required for new promotion of a mechanical candidate. */
  reportDigest?: string;
  /** Report path relative to the ledger root (`sandbox/<proposalId>/replay-report.json`). */
  report: string;
  verdict: ReplayVerdict;
  /** Per-task relation summary, observed then holdout. */
  tasks: {
    taskId: string;
    relation: ReplayRelation;
    holdout: boolean;
  }[];
}
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
  replayed?: ReplayedView;
  gate?: GateAnswers;
  decision?: EvolutionDecision;
  decisionNote?: string;
  /** Approval evidence of the decided record, when it carries one (every new record does). */
  decisionApprovalRef?: string;
  applied?: ApplyView;
  rolledback?: ApplyView;
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
  /** Production agent-preset root — champion snapshots read from here; apply/rollback write here. Defaults to `$DSH_HOME/.agent-presets`. */
  presetRoot?: string;
  /**
   * The production `config.yml` whose document-1 task-runtime row a capability
   * apply/rollback edits (text-level surgery on that one row; every other byte
   * is preserved). Defaults to `<repoRoot>/config.yml`.
   */
  configFile?: string;
  /**
   * The harness repo root: the parent of the `$DSH_HOME` fallback
   * (`<repoRoot>/.dsh`), the base of the default `config.yml`, and the base
   * relative evidence refs resolve against.
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
}
/**
 * The production write targets of an apply (and its matching rollback), for
 * the approval reason and the audit record — the human sees exactly what a
 * grant will touch.
 */
declare function applyTargets(proposal: EvolutionProposal, roots: {
  skillRoot: string;
  presetRoot: string;
  configFile: string;
}): string[];
/**
 * The Evolution plane ledger (plane separation: this store is independent of
 * the task store and refers to it by id only). Replay and append share one
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
  /** Production agent-preset root — champion snapshots read from here; apply/rollback write here. */
  readonly presetRoot: string;
  /** Production config.yml a capability apply/rollback edits. */
  readonly configFile: string;
  /** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
  readonly repoRoot: string;
  private records;
  private readonly loaded;
  private writes;
  constructor(ctx: Context, config?: Config);
  /** Ledger file path (`<root>/proposals.jsonl`). */
  get file(): string;
  propose(input: ProposeInput, actor: string): Promise<EvolutionProposal>;
  /**
   * Move proposed → candidate, recording the complete version set the candidate
   * aligns to. `mutation` is the optional structured patch description, shaped
   * and checked against the proposal's targetType; a candidate carrying one
   * must be prepared before it can gate.
   */
  candidate(proposalId: string, versionSet: Record<string, string>, actor: string, mutation?: unknown): Promise<EvolutionProposal>;
  /**
   * Move candidate → prepared: materialize a mechanical mutation into
   * `<root>/sandbox/<proposalId>/` and snapshot the champion (the current
   * production target) under `champion/` — the anchor for candidate-vs-champion
   * comparison and rollback. A production target that does not exist yet
   * records `champion: 'missing'` (champion: null). Non-mechanical mutations
   * materialize nothing and record `mechanical: false`. Materialization runs
   * before the ledger append; every write is confined to the sandbox dir.
   *
   * A skill candidate additionally records `skillContent` (P2): the name plus
   * the SHA-256 of the exact bytes of the file that was actually materialized
   * (read back from disk, never re-rendered from the mutation string), so
   * replay, the gates, and apply can verify this exact content later. The same
   * single read of the production file also yields `skillBaseline` (P3), the
   * digest the later apply compares the production target against.
   */
  prepare(proposalId: string, actor: string, champion?: PrepareChampion): Promise<EvolutionProposal>;
  /**
   * Move prepared → replayed: record the outcome of the candidate-vs-champion
   * replay (the `evolution_replay` tool ran it) and write the comparison report
   * to `<sandbox>/replay-report.json`. Only a prepared mechanical mutation can
   * be replayed; the report is validated against the proposal (manual mode is
   * the agent_preset v1 boundary — the preset roster cannot mount
   * sandbox-materialized presets — and every other targetType must carry
   * executed evidence). The report write is confined to the sandbox; the ledger
   * record cites it by root-relative path, and the gate later requires that
   * path in its regression evidence.
   *
   * For a skill candidate the service additionally binds the content identity
   * (P2): the report must carry the same `candidateContent` prepare recorded,
   * and the candidate file on disk must still hash to it. The tool re-checks
   * before it runs anything; this check runs after the runs and before the
   * record is written, so a modification that happened and persisted during
   * the replay is refused instead of recorded.
   */
  replay(proposalId: string, actor: string, report: unknown): Promise<EvolutionProposal>;
  /**
   * The skill replay's content binding (P2), enforced on the service entry that
   * writes the `replayed` record: the report's identity must equal the one
   * prepare recorded, and the candidate file must still be those exact bytes.
   * A candidate prepared before content binding, or one that changed and stayed
   * changed, is refused with the same guidance — fix the candidate through a
   * new proposal and evaluation; the append-only ledger never re-digests an old
   * record.
   */
  private assertSkillContentBound;
  /**
   * Move candidate → gated (manual candidates), prepared → gated
   * (bookkeeping-only mutations), or replayed → gated (mechanical mutations):
   * all six Gate answers plus regression evidence refs. Every ref must exist —
   * a path on disk (relative to the repo root or absolute) or an id the
   * caller-side resolver knows (task-store evidence). Existence only; nothing
   * here executes anything. A replayed proposal must additionally cite its
   * replay report path; its contents must match the recorded digest and schema.
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
   * (W16). Reachable only for a PROMOTE decision on a materialized skill /
   * agent_preset / capability mutation at L1–L3 (the state machine itself
   * refuses anything else); the caller (the evolution_apply tool) must hold a
   * human grant from `ctx.approval.request` first, exactly as for decide.
   * Production writes run BEFORE the ledger append, so a failed write leaves
   * the proposal decided and retryable. skill: the sandbox SKILL.md replaces
   * the production one (the champion snapshot covers that file only, so the
   * write is file-level, never a directory delete). agent_preset: whole-dir
   * replacement (the champion snapshot is the full directory). capability:
   * text-level surgery on the one capabilities row in config.yml document 1 —
   * the runtime registry is NOT hot-reloaded by that edit; the tool mirrors
   * the row into the running TaskRuntime afterwards.
   *
   * A skill apply re-verifies the production baseline (P3) after the human
   * grant and immediately before the write: the production target must still be
   * the one prepare recorded. A direct service call therefore cannot bypass the
   * check the tool already ran before asking for approval.
   *
   * The promotion check (S1-C item 3) runs here too, immediately before the
   * write and after the grant: a candidate whose provider role changed while the
   * human was deciding (a sidecar that appeared in the sandbox, a capability row
   * whose skill stopped being reachable, a verifier that was unregistered) is
   * refused here, so no entry can write something a later admission would have
   * refused.
   */
  apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome>;
  /**
   * Preflight for tools before asking for approval; mutation methods repeat the
   * check. Returns the providers the promotion would put in place, each with the
   * role it may be counted as (an empty list for a target type that carries
   * none), so the callers that already gate on this check can report them.
   *
   * Three checks run here, in this order, all of them shared with the service
   * entry the tools ultimately call:
   *
   * 1. P2: the candidate bytes must still be the ones prepare recorded.
   * 2. The replay gate (`assertReplayPromotable`).
   * 3. S1-C item 3: the provider check. A skill candidate's sandbox directory and
   *    a capability candidate's new row are judged by the same
   *    {@link validateSkillProvider} admission, config load and capability
   *    replacement use, so `evolution_apply` is not the only entry that knows
   *    what a usable provider is — and a candidate carrying an execution
   *    sidecar with an unregistered verifier or ungranted tools is refused here,
   *    before a human is asked, before `decided` is recorded, and before
   *    anything is written.
   */
  checkPromotion(proposalId: string): Promise<PromotionCheck>;
  /**
   * The promotion-time provider check (S1-C item 3): what the promotion would
   * put in place, judged as a provider before it becomes production state.
   *
   * - `skill`: the materialized candidate directory
   *   (`sandbox/<id>/skills/<name>/`) is read as a skill directory and judged
   *   against the deployment's own sources — the effective capability table and
   *   the registered verifier vocabulary. Nothing is discovered from a root: the
   *   candidate is exactly the directory this promotion would write.
   * - `capability`: the row as it will read after the replacement is checked by
   *   the admission pre-check itself, over the table the replacement produces
   *   and the harness process's own discovery roots (the row's own tool labels
   *   expand through the same `resolveCapabilities` admission uses, which is what
   *   makes them the covering set for a skill that declares this row). Whichever
   *   skill the row grants must be reachable and usable from that viewpoint, or
   *   the row is refused rather than written and refused later at admission.
   * - every other target type carries no provider: nothing to judge.
   *
   * What the verdict means, in the vocabulary the whole system uses
   * (`sidecar.ts`): only an execution sidecar whose verifier is registered and
   * whose required tools its declared capabilities grant may be counted as an
   * execution provider; knowledge and guidance are loadable and are recorded as
   * such; anything else is a refusal naming every defect. None of it writes,
   * and nothing is recorded before the caller's own transition.
   */
  private assertProvidersPromotable;
  /**
   * The candidate skill's provider verdict, taken from the directory the
   * promotion would write — plus the executor boundary this promotion cannot
   * cross.
   *
   * The boundary: `writeProduction` promotes a **single `SKILL.md`**, so a
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
  /**
   * The row a capability promotion would write, checked as the pre-check checks
   * a row: the replacement is folded into the effective table, and every skill
   * the new row grants is discovered from the harness process's own roots and
   * judged by {@link validateSkillProvider} — `verifierRefs` from the live
   * registry, the row's own tool labels expanding through `resolveCapabilities`
   * as the covering set. A refusal names the capability, the skill and every
   * defect, and nothing is written.
   */
  private assertCapabilityRowProviders;
  /** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
  private effectiveCapabilities;
  /**
   * Read a prepared skill candidate's materialized bytes and verify them
   * against the content identity recorded at prepare (P2). The one read path
   * every stage shares: the replay tool's pre-execution check, the `replayed`
   * record's post-execution recheck, every promotion gate, and the apply write.
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
   * `captured` requires a real regular file whose bytes still hash to the
   * digest prepare recorded; `missing` requires the target to still be absent.
   * A file that appeared, changed, disappeared, changed type (now a directory),
   * or sits behind a symbolic link (the file itself or an ancestor) is a
   * conflict. Only `targetType: skill` carries a baseline; every other
   * targetType passes untouched.
   */
  checkProductionBaseline(proposalId: string): Promise<void>;
  private assertProductionBaseline;
  private readVerifiedSkillCandidate;
  private readRecordedReplay;
  /**
   * Move applied → rolledback: undo the apply. Champion captured → restore the
   * snapshot (skill SKILL.md written back, preset directory replaced,
   * capability row restored — verbatim from `champion/capability-table.source.txt`
   * for a `config-text` champion (W19), row removed for a `code-default`
   * champion so the code default governs again, registry-form restore from
   * `champion/capability-table.entry.yml` for pre-W19 records);
   * champion missing → delete what the apply created (production skill/preset
   * dir removed, capability row dropped). Same approval discipline as apply:
   * the tool asks a human first, the service only executes and records.
   */
  rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome>;
  /**
   * The production write behind apply/rollback. The write side is picked by
   * `direction`; every path goes through `resolveWithin`, so a write can never
   * leave the production root it targets.
   */
  private writeProduction;
  /** Folded view of one proposal, or throws on an unknown id. */
  get(proposalId: string): Promise<EvolutionProposal>;
  /** Folded views, newest proposal first, optionally filtered. */
  list(filter?: ListFilter): Promise<EvolutionProposal[]>;
  private refExistsOnDisk;
  /**
   * The verbatim source lines of the capability's row in the production
   * config.yml (W19), or null when the file or the row is absent — the latter
   * meaning the capability comes from the code default table. A config.yml
   * without a task-runtime capabilities mapping fails loudly, exactly as an
   * apply would.
   */
  private capabilityRowSource;
  /**
   * Early state-machine check so a wrong-state call reports the transition
   * error before any payload validation; `append` re-checks under the write
   * lock, which is the authoritative gate. Returns the folded proposal so
   * callers can validate payloads against targetType / baseVersion / mutation.
   */
  private assertNext;
  /**
   * Write one mechanical mutation into the sandbox dir `dir`, then the champion
   * snapshot. Every path goes through `resolveWithin`, so a write can never
   * land outside the sandbox; production roots are read-only here. Capability
   * champions carry a `championSource` (W19): the rollback anchor is the
   * config.yml row's verbatim source text when the row exists there. A skill
   * champion is read exactly once (P3): those bytes become both the snapshot
   * and the recorded `skillBaseline` digest, so the two can never describe two
   * different reads of the production file.
   */
  private materialize;
  /**
   * Fold records into proposals, enforcing the state machine on every step:
   * proposed starts a new id; each later kind must be exactly an allowed next
   * state, and payload-bearing kinds re-run the write path's payload
   * validation (candidate versionSet/mutation, gate answers, the
   * prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
   * load exactly as it would fail append. The same rules guard replay and live
   * appends, so an illegal migration is rejected identically in both paths.
   */
  private fold;
  private load;
  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private append;
}
//#endregion
//#region src/prepare-champion.d.ts
/**
 * The graph / task / task-runtime services champion resolution reads, as the
 * caller's context holds them — only the members used here.
 */
interface PrepareChampionSources {
  readonly graphs: {
    graphForSession(sessionId: SessionId): Promise<{
      readonly rootSessionId: SessionId;
    }>;
  };
  readonly task: {
    openStore(storeId: string): Promise<TaskSnapshot>;
  };
  readonly taskRuntime: {
    listCapabilities(): Readonly<Record<string, CapabilityConfig>>;
  };
}
/**
 * Resolve the caller-supplied half of a prepare: the capability champion from
 * the effective registry, the task_definition champion from the task store;
 * skill / preset champions the ledger reads from the production roots itself.
 * A capability prepare whose row is absent records `null` — the capability is
 * new — while a task_definition whose base definition is unresolvable also
 * records `null`.
 */
declare function resolvePrepareChampion(sources: PrepareChampionSources, proposal: EvolutionProposal, caller: SessionId): Promise<PrepareChampion>;
//#endregion
//#region src/replay-experiment.d.ts
/** The lineage tag every replay artifact (objective, review anomalies) carries. */
declare function replayLineage(proposalId: string): string;
/** Why agent_preset replay is manual in v1 — recorded verbatim in the report. */
declare const PRESET_REPLAY_MANUAL_REASON: string;
/**
 * The ledger service the experiment records through, as this module uses it: the
 * sandbox root it materialized under, the content check that binds a skill
 * candidate (P2), and the `replayed` transition itself.
 */
interface ReplayLedger {
  /** Absolute ledger directory; the sandbox and the report live under it. */
  readonly root: string;
  get(proposalId: string): Promise<EvolutionProposal>;
  readSkillCandidate(proposalId: string): Promise<Buffer>;
  replay(proposalId: string, actor: string, report: ReplayReport): Promise<EvolutionProposal>;
}
/**
 * The graph / task / task-runtime services the experiment reads, as the caller's
 * context holds them. Only the members used here are named, so a caller cannot
 * hand over a capability this module has no business taking (guide §1.5).
 */
interface ReplayExperimentSources {
  readonly evolution: ReplayLedger;
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
  };
}
interface ReplayExperimentRequest {
  readonly proposalId: string;
  /** Champion task ids replayed as the observed set. */
  readonly taskIds: readonly string[];
  /** Champion task ids replayed the same way but reported as the held-out group. */
  readonly holdoutTaskIds: readonly string[];
  readonly caller: SessionId;
  readonly signal?: AbortSignal;
}
/** What one replay experiment produced: the recorded report and the comparison groups, for the caller to render. */
interface ReplayExperimentResult {
  readonly proposalId: string;
  readonly targetType: ProposalTargetType;
  readonly targetId: string;
  /** The report exactly as recorded in the ledger. */
  readonly report: ReplayReport;
  /** Report path relative to the ledger root. */
  readonly reportPath: string;
  readonly observed: readonly ReplayTaskComparison[];
  readonly holdout: readonly ReplayTaskComparison[];
  /** True for the agent_preset v1 boundary: nothing executed, `manualReason` says why. */
  readonly manual: boolean;
}
/**
 * Run one replay experiment and record it. Every refusal throws with the text
 * the model-facing adapter reports after its own `evolution_replay rejected:`
 * prefix; nothing is recorded on any refusal, and the runs that did settle stay
 * in the task store as evidence (said in the mid-flight failure message).
 */
declare function runReplayExperiment(sources: ReplayExperimentSources, request: ReplayExperimentRequest): Promise<ReplayExperimentResult>;
//#endregion
export { APPLYABLE_TARGET_TYPES, AgentPresetMutation, ApplyOutcome, ApplyView, CHAMPION_SOURCES, CHAMPION_STATES, CapabilityMutation, CapabilityRowAction, CapabilityRowResult, ChampionSource, ChampionState, Config, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EvolutionDecision, EvolutionLevel, EvolutionProposal, EvolutionRecord, EvolutionService, EvolutionService as default, EvolutionStatus, GateAnswers, ListFilter, MECHANICAL_TARGET_TYPES, MechanicalMutation, PRESET_REPLAY_MANUAL_REASON, PrepareChampion, PrepareChampionSources, PreparedView, PromotionCheck, PromotionProvider, ProposeInput, REPLAY_RELATIONS, REPLAY_VERDICTS, ReplayCriterionDiff, ReplayCriterionSummary, ReplayExperimentRequest, ReplayExperimentResult, ReplayExperimentSources, ReplayLedger, ReplayRelation, ReplayReport, ReplaySideSummary, ReplayTaskComparison, ReplayVerdict, ReplayedView, SkillContentIdentity, SkillMutation, TaskDefinitionMutation, applyTargets, assertReplayPromotable, assertReplayReport, compareReplaySides, editCapabilityRow, mutationMechanical, overallReplayVerdict, readCapabilityRowSource, renderProviderRoles, replayLineage, resolvePrepareChampion, restoreCapabilityRowSource, runReplayExperiment };