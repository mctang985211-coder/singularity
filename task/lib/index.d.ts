import { Context, Service } from "@deepseek-ai/cordis";

//#region src/types.d.ts
type TaskId = string;
type RunId = string;
interface ArtifactRef {
  artifactId: string;
  kind: string;
  uri: string;
  digest?: string;
}
type VerificationMode = 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite';
interface AcceptanceCriterion {
  criterionId: string;
  description: string;
  verificationMode: VerificationMode;
  requiredEvidence: string[];
  mandatory: boolean;
  command?: string;
  /**
   * Artifact or evidence references (kinds or ids) that must exist in the task
   * store before this criterion can be judged at all (KISS §5.1
   * `requires_artifact`): an ordering constraint declared as an evidence
   * dependency, not a sequence step. Admission validates only the shape
   * (non-empty strings); existence is judged at spawn time by the orchestrator,
   * which settles the child blocked — never spawned — and registers each
   * missing item as an Obligation.
   */
  requiresArtifact?: string[];
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent keeps the current behavior: dispatch by
   * `verificationMode` to whichever registered verifier supports it. Present,
   * the id must exist in the verifier registry — an unknown id rejects the
   * whole decomposition batch at admission time (never at spawn time), with
   * the error naming the registered ids.
   */
  verifierRef?: string;
}
interface TaskDefinition {
  taskType: string;
  version: number;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredCapabilities: string[];
  decompositionPolicy: {
    allowed: boolean;
    maxDepth?: number;
    maxChildren?: number;
  };
  budgetPolicy?: {
    tokens?: number;
    wallTimeMs?: number;
    attempts?: number;
  };
}
type TaskStatus = 'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled';
type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed';
interface TaskInstance {
  taskId: TaskId;
  definitionRef: {
    taskType: string;
    version: number;
  };
  parentTaskId?: TaskId;
  objective: string;
  depth: number;
  acceptanceCriteria: AcceptanceCriterion[];
  requestedCapabilities: string[];
  decompositionStatus: DecompositionStatus;
  status: TaskStatus;
  runIds: RunId[];
  childTaskIds: TaskId[];
}
interface DependencyEdge {
  from: TaskId;
  to: TaskId;
}
/** DFS over an edge list: true when `target` is reachable from `start`. */
declare function reaches(edges: readonly DependencyEdge[], start: TaskId, target: TaskId): boolean;
type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled';
interface TaskRun {
  runId: RunId;
  taskId: TaskId;
  sessionId: string;
  parentRunId?: RunId;
  capabilitySnapshot: string[];
  agentPreset?: string;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}
interface VerificationResult {
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  command?: string;
  exitCode?: number;
  logRef?: string;
  details?: string;
  /**
   * Which side an `inconclusive` verdict belongs to (KISS §4.3's UNKNOWN
   * split): `task` when the check never ran (timeout, the command never
   * started) — the criterion was never tested; `verifier` when the judge
   * itself is broken (the verifier threw, or none supports the mode). Absent
   * on pass/fail and on a by-design inconclusive (a review criterion awaiting
   * a human). Confusing the two kinds makes the system re-test the same thing
   * forever, so the orchestrator's feedback text keeps them apart.
   */
  unknownKind?: 'task' | 'verifier';
}
interface EvidenceClaim {
  claimId: string;
  criterionId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  verifierId: string;
  artifactRefs: string[];
  details?: string;
  /** Copied from the {@link VerificationResult} this claim rests on; see that field. */
  unknownKind?: 'task' | 'verifier';
}
interface EvidenceBundle {
  evidenceId: string;
  taskRunId: RunId;
  taskId: TaskId;
  artifacts: ArtifactRef[];
  verifierResults: VerificationResult[];
  claims: EvidenceClaim[];
  generatedAt: string;
}
interface TaskHandoff {
  handoffId: string;
  parentTaskId: TaskId;
  parentRunId: RunId;
  childTaskId: TaskId;
  parentObjective: string;
  reasonForDelegation: string;
  constraints: string[];
  decisions: string[];
  relevantArtifacts: ArtifactRef[];
  relevantEvidence: string[];
  assumptions: string[];
  openQuestions: string[];
  parentSessionRef?: string;
  createdAt: string;
}
interface CapabilityManifest {
  capabilities: Record<string, {
    skills: string[];
    /** Real DSH tool names the capability grants: labels are expanded when the manifest is resolved. */
    tools: string[];
    preset?: string;
    permission?: string;
    /**
     * MCP server names the capability grants, resolved against the task
     * runtime's server registry at admission and mounted per worker at spawn
     * (`mcp__<server>__<tool>` on the worker's own tool layer). Absent = none.
     */
    mcpServers?: string[];
  }>;
  missing: string[];
  closure: 'closed' | 'partial' | 'gap';
}
/** The terminal outcome one run (or a child blocked before its run ever started) settled in. */
type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked';
/**
 * One criterion's verdict as the verifier reported it, copied onto the review
 * record so a reader sees what was checked — command and exit code included —
 * without replaying the run or opening the evidence bundle.
 */
interface ReviewCriterion {
  criterionId: string;
  /** The verifier's verdict for this criterion. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** The command that was run, from the verifier result or the criterion itself, when the mode runs one. */
  command?: string;
  /** The command's exit code, when the verifier reported one. */
  exitCode?: number;
  /** Log path relative to the verifier evidence root, when the verifier wrote one. */
  logRef?: string;
  /**
   * Which side an inconclusive verdict belongs to, copied from the verifier
   * result so a review reader (and the E3 escalation signal) can tell "the
   * check never ran" (`task`) from "the judge is broken" (`verifier`) without
   * reopening the evidence bundle.
   */
  unknownKind?: 'task' | 'verifier';
}
/** One dependency whose outcome kept a blocked task from ever starting a run. */
interface ReviewBlocker {
  taskId: TaskId;
  /** The dependency's task status at the moment this task settled blocked. */
  outcome: TaskStatus;
}
/**
 * The four token buckets a session's `tokenUsage` projection reports, copied
 * verbatim from that projection's wire view (upstream
 * `llm/token-meter/src/usage-projection.ts:117-150`). Cumulative for the whole
 * session, not for one run — see {@link ReviewMetrics.tokens}.
 */
interface ReviewTokenUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
/** One tool name a session log shows being called, with how many times. */
interface ReviewToolCall {
  name: string;
  /** `tool/call` events naming this tool in the session. */
  count: number;
}
/**
 * Dimension 1, outcome correctness: the terminal status the run settled in and
 * what the verifier said per criterion. Both facts already exist on the record
 * (`outcome`, `criteria`); this restates them in derived form so a reader gets
 * the verdict tally without re-scanning `criteria`.
 *
 * Limitation: this says what was decided, never whether the decision was right.
 * "Correct" is not mechanically observable — it is exactly what Diagnosis exists
 * to explain (§2.7.3).
 */
interface OutcomeCorrectnessFacts {
  outcome: ReviewOutcome;
  /** Criteria the record carries a verdict for; 0 when the verifier never reported. */
  criteriaCount: number;
  /** Ids of the criteria whose verdict was not `pass`. */
  unmetCriterionIds: string[];
}
/**
 * Dimension 2, task specification quality: how much specification the task
 * carried, as counts. Purely mechanical — a thin specification is a fact here,
 * not a verdict.
 *
 * Limitation: counts say nothing about whether the objective is understandable
 * or whether one criterion is doing the work of three. Present whenever the task
 * was readable.
 */
interface TaskSpecificationFacts {
  /** Whether the objective has non-whitespace content. */
  objectivePresent: boolean;
  /** The task's acceptance criteria count. */
  criteriaCount: number;
  /** How many of them declare a `command`. */
  criteriaWithCommand: number;
}
/** One criterion's declaration shape, as authored on the task (not the verifier's verdict). */
interface AcceptanceCriterionShape {
  criterionId: string;
  mode: VerificationMode;
  /** Whether the criterion declares a `command` to run. */
  hasCommand: boolean;
  mandatory: boolean;
}
/**
 * Dimension 3, acceptance quality: each criterion's declared verification mode
 * and whether it hands the verifier a command.
 *
 * Limitation: mode and command presence are the only mechanically observed
 * facts here. Whether a criterion actually pins down the intended behaviour is a
 * judgement this record deliberately does not make; a `review`-mode criterion
 * (no command) is recorded as such, not as a defect.
 */
interface AcceptanceFacts {
  criteria: AcceptanceCriterionShape[];
}
/**
 * Dimension 4, decomposition quality: the position and shape of this task in
 * the decomposition tree at review time.
 *
 * Limitation: shape only. Whether the split was a *good* split is not derivable
 * from depth, child count, or edge count, and no threshold is applied to any of
 * them.
 */
interface DecompositionFacts {
  depth: number;
  decompositionStatus: DecompositionStatus;
  childCount: number;
  /** Dependency edges whose target is this task (must verify before it starts). */
  incomingEdges: number;
  /** Dependency edges whose source is this task (it must verify before they start). */
  outgoingEdges: number;
}
/**
 * Dimension 5, capability coverage: what the task's resolved manifest granted
 * and what it could not resolve.
 *
 * Limitation: this is the admission-time resolution, not a claim that the
 * granted capability was the *right* one for the work. The flattening of skills
 * and tools into `granted` mirrors `capabilitySnapshot` and loses which
 * capability contributed which name.
 */
interface CapabilityCoverageFacts {
  /** The manifest's closure verdict: `closed` when nothing required was missing. */
  closure: CapabilityManifest['closure'];
  /** Flattened skills+tools of the resolved manifest — exactly the list a run records in its `capabilitySnapshot`. */
  granted: string[];
  /** Required capability names the registry could not grant. */
  missing: string[];
}
/**
 * Dimension 6, skill fit: skills the run's capabilities granted against skills
 * the session's log shows the `skill` tool actually loading.
 *
 * Limitation: `loaded` and `loadedOutsideGrant` appear only when the deployment
 * exposes a readable session log, and they are session-scoped — a session that
 * loaded a skill before any run existed still counts. Loading a skill is not
 * evidence that its instructions changed the work.
 */
interface SkillFitFacts {
  /** Skill names the run's capabilities granted. */
  granted: string[];
  /** Skill names the session's `skill` calls loaded, deduplicated and sorted; absent when no log was readable. */
  loaded?: string[];
  /** Loaded skill names outside `granted`; empty means every load was covered by the grant. */
  loadedOutsideGrant?: string[];
}
/**
 * Dimension 7, tool fit: tools the run's capabilities granted (plus the worker
 * baseline) against tools the session's log shows being called.
 *
 * Limitation: the comparison is against capability grants and
 * `workerBaseline()`, not against what the mounted preset offers, so a worker
 * on a preset that keeps its own tool plane (`keepPresetTools`) can show names
 * in `calledOutsideGrant` that were in fact authorized by its composition. Names
 * are compared as the log records them; a tool reached through a wrapper is not
 * attributed. `called` and `calledOutsideGrant` appear only with a readable log.
 */
interface ToolFitFacts {
  /** Real DSH tool names the run's capabilities granted (labels expanded at admission). */
  granted: string[];
  /** Tool names the session shows being called, with counts; absent when no log was readable. */
  called?: ReviewToolCall[];
  /** Called names outside `granted` ∪ `workerBaseline()`; empty means every call was covered. */
  calledOutsideGrant?: string[];
}
/**
 * Dimension 8, context efficiency: only numbers that can be read reliably, and
 * nothing that rates them.
 *
 * Limitation: `tokens` is the same whole-session cumulative observation as
 * {@link ReviewMetrics.tokens} — for a long-lived root session it covers the
 * entire session, not this run, so it is systematically high. `compactions`
 * counts `compaction/start` events in the session. No ratio, budget, or
 * efficiency judgement is derived from either; absent when neither was readable.
 */
interface ContextEfficiencyFacts {
  /** Whole-session token buckets; the same value {@link ReviewMetrics.tokens} carries. */
  tokens?: ReviewTokenUsage;
  /** `compaction/start` events observed in the session log. */
  compactions?: number;
}
/**
 * The eight review dimensions (§2.7.3), each carrying mechanically observed
 * facts — never a score, never an LLM judgement, never transcript text. Every
 * member is optional and is omitted, not defaulted, when the data behind it does
 * not exist. A dimension answers "what did the system actually do here", leaving
 * "why" to Diagnosis.
 */
interface ReviewDimensions {
  outcomeCorrectness?: OutcomeCorrectnessFacts;
  taskSpecification?: TaskSpecificationFacts;
  acceptance?: AcceptanceFacts;
  decomposition?: DecompositionFacts;
  capabilityCoverage?: CapabilityCoverageFacts;
  skillFit?: SkillFitFacts;
  toolFit?: ToolFitFacts;
  contextEfficiency?: ContextEfficiencyFacts;
}
/** Call and failure totals over one session's tool traffic. */
interface ReviewToolCallTotals {
  /** `tool/call` events in the session log. */
  calls: number;
  /** `tool/result` events whose payload reports a failure. */
  failures: number;
}
/**
 * The six engineering-effort indicators, as counters. Every member is optional
 * and is omitted rather than filled with a placeholder when its source is
 * unavailable.
 *
 * `time` is deliberately absent: wall-clock duration already lives in
 * {@link ReviewRecord.durationMs} (run `startedAt` → the terminal transition,
 * verification included) and is not duplicated here.
 *
 * `artifactCount` is deliberately absent and is not `evidenceLogs`: nothing in
 * the deployment produces an `ArtifactRef` (the type has no writer, and
 * `TaskRun.artifacts` is always empty), so there is no trustworthy artifact
 * count to record. `evidenceLogs` counts criteria that carried a `logRef`
 * instead, and is named for what it measures.
 */
interface ReviewMetrics {
  /**
   * Provider-reported, whole-session token buckets from the session's
   * `tokenUsage` projection. Limitation: the projection folds the entire
   * session, so for the long-lived root session this is a session total, not a
   * per-run figure, and it reads systematically high. Absent when the
   * deployment exposes neither `sessionProjections` nor that key.
   */
  tokens?: ReviewTokenUsage;
  /** Session tool traffic; absent when no session log was readable. */
  toolCalls?: ReviewToolCallTotals;
  /**
   * Count of human-intervention events in the session log: `approval/asked`
   * plus calls to `hitl_ask` / `hitl_approve` / `ask_user_question`.
   * Limitation: the count is session-scoped, and only `ask_user_question` is a
   * worker tool — `hitl_*` are root tools, so interventions across the whole
   * tree land on the root's record. A worker record showing 0 does not mean no
   * human was involved anywhere in its tree.
   */
  humanInterventions?: number;
  /**
   * `TaskStarted` count minus one for this task (`TaskInstance.runIds.length - 1`).
   * Limitation: the current orchestrator has no retry branch, so this is
   * structurally always 0 — a reader must not conclude "it was tried again and
   * did not need to be" from it. Omitted for a runless (blocked) task.
   */
  retries?: number;
  /** Criteria on this record that carry a `logRef` — where the evidence for a verdict was written. */
  evidenceLogs?: number;
}
/**
 * One lightweight terminal record per run, written exactly once when the run
 * reaches its terminal state. No scoring and no judge — a human reads it.
 * `localizedCause` is written only for `failed`; `anomalies` notes what is
 * otherwise notable (for `blocked`, which dependency blocked it).
 * The record is self-contained for a postmortem: `durationMs`, per-criterion
 * `criteria`, a truncated `logTail` on failure, and structured `blockedBy`
 * name the what and the why without a trip into evidence or logs.
 *
 * §2.7.3 makes Diagnosis, not Score, the first-class citizen: `dimensions`
 * therefore holds mechanically observed facts per review dimension (never a
 * rating, never an LLM judgement, never transcript text) and `metrics` holds
 * engineering-effort counters. Both are optional throughout and are omitted
 * rather than guessed when their source does not exist.
 */
interface ReviewRecord {
  taskId: TaskId;
  /** Absent when the task was blocked before any run started. */
  runId?: RunId;
  /** Absent when no run/session was ever bound to the task. */
  sessionId?: string;
  outcome: ReviewOutcome;
  /** Evidence ids recorded under this run, taken from the store at terminal time. */
  evidenceRefs: string[];
  /** Notable facts; for `blocked`, the text naming the dependency that did not verify. */
  anomalies: string[];
  /** Failed outcomes only: the same reason text the terminal status event carries. */
  localizedCause?: string;
  /** The tasks this run related to (a child's dependencies; a parent's children). */
  relatedTaskIds?: TaskId[];
  /** Wall-clock duration of the run from start to its terminal transition, in milliseconds. Absent when no run started. */
  durationMs?: number;
  /** Per-criterion verdicts from the run's verification bundle; absent when the verifier never ran. */
  criteria?: ReviewCriterion[];
  /** Failed outcomes only: tail excerpt of a failing criterion's log (bounded, see verifier logTail), so a review reads without a replay. */
  logTail?: string;
  /** Blocked outcomes only: the dependencies whose outcomes kept this task from running. */
  blockedBy?: ReviewBlocker[];
  /** Mechanically observed facts per review dimension; absent when none could be derived. */
  dimensions?: ReviewDimensions;
  /** Engineering-effort counters; absent when none could be collected. See {@link ReviewMetrics}. */
  metrics?: ReviewMetrics;
}
/**
 * How sure the diagnoser is of its localized cause. Coarse on purpose
 * (§2.7.3: Review ≠ Judge — a diagnosis explains, it does not score).
 */
type DiagnosisConfidence = 'high' | 'medium' | 'low';
/**
 * The nine mutation surfaces a proposal may point at (§2.7.6). Frozen now
 * because the P5 Evolution registry consumes this exact vocabulary.
 */
type ProposalTargetType = 'skill' | 'tool' | 'capability' | 'task_definition' | 'decomposition_policy' | 'agent_preset' | 'workflow_policy' | 'verifier' | 'runtime_policy';
/**
 * One structured suggestion a diagnosis raises. In P4 a proposal never
 * executes by itself (§2.7.6: no automatic production changes); it is data
 * for a human or a later Evolution step.
 */
interface DiagnosisProposal {
  targetType: ProposalTargetType;
  targetId: string;
  rationale: string;
}
/**
 * The six review dimensions whose conclusion is not mechanically observable
 * (§2.7.3): the fact table records what the run did, and only a reader holding
 * the whole context can say whether what it did was adequate. The other two
 * dimensions are deliberately absent — `outcome_correctness` tallies the
 * verifier's own verdicts and `capability_coverage` reports the admission-time
 * `closed`/`partial`/`gap` closure, so both settle mechanically and need no
 * judgement. Names are the snake_case spelling of the `ReviewDimensions`
 * members, so a judgement and the facts it rests on read as one dimension.
 */
type JudgedDimension = 'task_specification' | 'acceptance' | 'decomposition' | 'skill_fit' | 'tool_fit' | 'context_efficiency';
/** Every judged dimension, in the order a report reads them. */
declare const JUDGED_DIMENSIONS: readonly JudgedDimension[];
/** One dimension's coarse conclusion. Three values on purpose — this is not a rating scale. */
type JudgementVerdict = 'adequate' | 'inadequate' | 'unknown';
/** Every judgement verdict, for reducer validation and rendering. */
declare const JUDGEMENT_VERDICTS: readonly JudgementVerdict[];
/**
 * One judged dimension: an agent's (or a person's) conclusion over the facts a
 * `ReviewRecord` carries. Still not a score — `verdict` is a coarse three-way
 * call, `evidenceRefs` names what it rests on, and `rationale` states the
 * reasoning. When the evidence does not settle a dimension the verdict must be
 * `unknown`, never a guess.
 */
interface ReviewJudgement {
  /** Which dimension this concludes; only the six non-mechanical ones are judgeable. */
  dimension: JudgedDimension;
  /** The conclusion: adequate, inadequate, or unknown. */
  verdict: JudgementVerdict;
  /**
   * Refs the judgement rests on: evidence ids, the review refs
   * `task_review_pack` prints (`<taskId>#<runId>`, or `<taskId>#no-run`), or
   * session ids. Required and non-empty — a conclusion that cites nothing is
   * not reviewable.
   */
  evidenceRefs: string[];
  /** Why this verdict, in the writer's words. */
  rationale: string;
}
/** Who produced a diagnosis, so an agent's judgement is never mistaken for a person's. */
interface DiagnosisProvenance {
  /** `agent` when a spawned review agent wrote it; `human` for a person. */
  kind: 'agent' | 'human';
  /** The session that produced it, when one did — the id a reader drills into. */
  sessionId?: string;
}
/**
 * The core product of review (§2.7.3): an explanation of what a task's
 * reviews show, not a score. Diagnosis lineage is a graph, not a tree
 * (§2.7.4): `reviewRefs` may name several records and `relatedTaskIds` may
 * point across tasks. Written once per `diagnosisId`, immutable afterwards;
 * a task accumulates as many diagnoses as callers record.
 */
interface Diagnosis {
  diagnosisId: string;
  taskId: TaskId;
  /** The failure or anomaly under explanation, as observed in the evidence. */
  observedFailure: string;
  /** How far the cause reaches (this task, its subtree, a shared assumption, …). */
  scope: string;
  /** The most specific explanation the evidence supports. */
  localizedCause: string;
  /** Evidence ids the diagnosis rests on. */
  evidenceRefs: string[];
  /** The review records the diagnosis rests on, named by the refs task_review_pack prints (`<taskId>#<runId>`, or `<taskId>#no-run`). */
  reviewRefs: string[];
  confidence: DiagnosisConfidence;
  /** Structured suggestions only; nothing here auto-executes. */
  proposals: DiagnosisProposal[];
  /** Other tasks this diagnosis implicates (cross-task lineage, §2.7.4). */
  relatedTaskIds?: TaskId[];
  /**
   * Who wrote this diagnosis. Absent on records written before this field
   * existed, and on any writer that does not declare itself; absence is read as
   * human-written (the only producer there was).
   */
  producedBy?: DiagnosisProvenance;
  /**
   * The six judged dimensions, when the writer made explicit calls. Optional: a
   * diagnosis may explain a cause without judging every dimension, and an
   * all-`unknown` judgement is a legitimate outcome — it says the evidence did
   * not settle the dimension, which is itself information.
   */
  judgements?: ReviewJudgement[];
}
/**
 * A verifier's own known-sample proof (KISS §4.3 `selftest`): samples the
 * verifier must be able to tell apart — known-good ones it passes,
 * known-bad ones it catches. Entries name the sample (a command, a fixture
 * reference, or a case description); where the sample is mechanically
 * runnable (the command verifier's entries are shell commands), the package's
 * own tests execute them. Registration without a selftest is a warning, not a
 * refusal — soft until every built-in verifier carries one.
 */
interface VerifierSelftest {
  /** Known-good samples a healthy verifier judges `pass` (or, for a never-auto-pass verifier, demonstrably does not auto-pass). */
  positiveCases: string[];
  /** Known-bad samples a healthy verifier judges `fail`. */
  negativeCases: string[];
}
interface Verifier {
  id: string;
  /**
   * Registry metadata (KISS §4.3): a version so a later verdict recall can
   * index evidence by `(verifierRef, version)` (KISS §8.2), and an owner so
   * the execution/judgement separation (I3) has something to compare against
   * the executing skill's owner.
   */
  version?: string;
  owner?: string;
  selftest?: VerifierSelftest;
  supports(mode: VerificationMode): boolean;
  verify(req: VerifyRequest): Promise<VerificationResult[]>;
}
/**
 * One structured record of what is still missing (KISS §2/§5): an Obligation
 * is a question, not an action — `goal` names the gap, `criterion` says how its
 * satisfaction would be judged, and `sourceTaskId` names the task whose
 * failure, block, or capability gap surfaced it. Recorded, never scheduled:
 * the runtime has no obligation scheduler, so nothing here auto-executes.
 */
interface Obligation {
  obligationId: string;
  /** What is still missing, as a question or a named gap. */
  goal: string;
  /** How a reader would judge the obligation satisfied. */
  criterion: string;
  /** The task whose terminal transition (or rejected admission) raised it. */
  sourceTaskId: TaskId;
}
interface VerifyRequest {
  taskId: TaskId;
  runId: RunId;
  criteria: AcceptanceCriterion[];
  cwd: string;
  logDir: string;
  timeoutMs?: number;
}
/** Fixed definition fields of a graph's root task (see task-runtime createRootTask). */
declare const RootTaskSpec: Pick<TaskDefinition, 'taskType' | 'version' | 'acceptanceCriteria' | 'requiredCapabilities' | 'decompositionPolicy'>;
/** Store id convention: one task store per root session. */
declare function rootTaskStoreId(rootSessionId: string): string;
interface TaskSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly tasks: readonly TaskInstance[];
  readonly runs: readonly TaskRun[];
  readonly edges: readonly DependencyEdge[];
  readonly evidence: readonly EvidenceBundle[];
  readonly handoffs: readonly TaskHandoff[];
  readonly reviews: readonly ReviewRecord[];
  readonly diagnoses: readonly Diagnosis[];
  readonly obligations: readonly Obligation[];
  readonly capabilities: Readonly<Record<string, CapabilityManifest>>;
}
interface TaskEventPayloads {
  /** A task instance enters the store (created status, no runs or children attached). */
  TaskCreated: {
    task: TaskInstance;
  };
  /** A created task is admitted as a leaf or as decomposable. */
  TaskAdmitted: {
    decompositionStatus: 'leaf' | 'decomposable';
  };
  /** A created task is rejected at admission and settles blocked. */
  TaskRejected: {
    reason: string;
  };
  /** A decomposable task's children are registered and the parent closes as decomposed. */
  TaskDecomposed: {
    childTaskIds: TaskId[];
  };
  /** A dependency edge is added to the DAG (from must verify before to starts). */
  DependencyAdded: {
    edge: DependencyEdge;
  };
  /** A run starts on an admitted/ready task. */
  TaskStarted: {
    run: TaskRun;
  };
  /** A task settles blocked, optionally taking its running run with it. */
  TaskBlocked: {
    reason?: string;
  };
  /** A running task hands its run to the verifier. */
  TaskVerifying: Record<string, never>;
  /** A verifying task settles verified; requires evidence under the run. */
  TaskVerified: {
    finishedAt?: string;
  };
  /** A running/verifying task settles failed. */
  TaskFailed: {
    reason?: string;
    finishedAt?: string;
  };
  /** A running task settles cancelled. */
  TaskCancelled: {
    reason?: string;
    finishedAt?: string;
  };
  /** A failed task returns to ready so a new run can start. */
  TaskRetried: Record<string, never>;
  /** The capability manifest a task was admitted with is stored. */
  CapabilityResolved: {
    manifest: CapabilityManifest;
  };
  /** Admission found required capabilities the registry cannot grant. */
  CapabilityGapDetected: {
    missing: string[];
  };
  /** An evidence bundle is recorded under a running run. */
  EvidenceProduced: {
    evidence: EvidenceBundle;
  };
  /** A parent run hands a child task off to its worker. */
  HandoffCreated: {
    handoff: TaskHandoff;
  };
  /** A terminal run's one lightweight review record, written exactly once at terminal time. */
  ReviewRecorded: {
    review: ReviewRecord;
  };
  /** One caller-triggered diagnosis over a task's review records; immutable once written, unique per diagnosisId. */
  DiagnosisRecorded: {
    diagnosis: Diagnosis;
  };
  /** A structured "what is still missing" record raised by a failure, a block, or a capability gap; an Obligation is a question, never an action. */
  ObligationRecorded: {
    obligation: Obligation;
  };
}
type TaskEventKind = keyof TaskEventPayloads;
interface TaskEventEnvelope<K$1 extends TaskEventKind, P> {
  readonly kind: K$1;
  readonly taskId: TaskId;
  readonly runId?: RunId;
  readonly sessionId?: string;
  readonly parentTaskId?: TaskId;
  readonly timestamp: string;
  readonly actor: string;
  readonly payload: P;
  readonly schemaVersion: 1;
}
type TaskEvent = { [K in TaskEventKind]: TaskEventEnvelope<K, TaskEventPayloads[K]> }[TaskEventKind];
//#endregion
//#region src/service/state.d.ts
declare class TaskState {
  private value;
  constructor(id: string, snapshot?: TaskSnapshot);
  clone(): TaskState;
  snapshot(): TaskSnapshot;
  apply(event: TaskEvent): void;
  private addTask;
  private admit;
  private decompose;
  private addDependency;
  private start;
  private block;
  private verify;
  private fail;
  private cancel;
  private resolveCapabilities;
  private produceEvidence;
  private addHandoff;
  /**
   * A review is the legal companion of the terminal transition it follows: the
   * run (or the runless blocked task) must already sit in the outcome the record
   * declares, and each run accepts exactly one record — a second one is a bug in
   * the writer, not a late event to tolerate.
   */
  private recordReview;
  /**
   * A diagnosis is caller-triggered, not lifecycle-bound: any existing task
   * accepts one at any time, and a task accumulates several. What the reducer
   * enforces is integrity, not timing — the id is unique across the store
   * (a repeat write is a bug, not an update), every field is present and
   * well-formed, the diagnosis rests on at least one evidence or review ref,
   * and every proposal names one of the nine frozen target types (§2.7.6).
   *
   * The two optional additions are checked the same way: `producedBy` must name
   * a known producer kind (and a non-empty session when it carries one), and
   * every `judgements` entry must name a judged dimension and a known verdict,
   * carry a rationale, and rest on at least one non-empty evidence ref — an
   * `unknown` verdict still cites the refs it considered, so a judgement that
   * cites nothing is rejected rather than stored.
   */
  private recordDiagnosis;
  /**
   * An obligation is raised, never scheduled (KISS §5.1: a question, not an
   * action): the reducer enforces integrity only — a unique non-empty id,
   * non-empty goal and criterion, and a source task that exists in the store.
   */
  private recordObligation;
  private transit;
  private assertTransition;
  private assertRunTransition;
  private setRun;
  private updateTask;
  private task;
  private run;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One task-store mutation in a per-task store; the TaskEvent union that TaskState replays on load. */
    'task/event': TaskEvent;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    task: TaskService;
  }
  interface Events {
    'task/change'(snapshot: TaskSnapshot): void;
  }
}
declare class TaskService extends Service {
  static inject: string[];
  private readonly stores;
  private closing;
  constructor(ctx: Context);
  createStore(storeId: string): Promise<TaskSnapshot>;
  openStore(storeId: string): Promise<TaskSnapshot>;
  snapshotIn(storeId: string): Promise<TaskSnapshot>;
  taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance>;
  runIn(storeId: string, runId: RunId): Promise<TaskRun>;
  childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]>;
  createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void>;
  admitTaskIn(storeId: string, taskId: TaskId, actor: string, options?: {
    decompositionStatus?: 'leaf' | 'decomposable';
    manifest?: CapabilityManifest;
  }): Promise<void>;
  rejectTaskIn(storeId: string, taskId: TaskId, actor: string, reason: string, manifest?: CapabilityManifest): Promise<void>;
  decomposeIn(storeId: string, parentTaskId: TaskId, children: readonly TaskInstance[], actor: string, edges?: readonly DependencyEdge[]): Promise<void>;
  addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void>;
  startRunIn(storeId: string, run: TaskRun, actor: string): Promise<void>;
  markRunStatusIn(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus | 'verifying', actor: string, options?: {
    reason?: string;
    finishedAt?: string;
  }): Promise<void>;
  recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void>;
  recordReviewIn(storeId: string, review: ReviewRecord, actor: string): Promise<void>;
  recordDiagnosisIn(storeId: string, diagnosis: Diagnosis, actor: string): Promise<void>;
  recordObligationIn(storeId: string, obligation: Obligation, actor: string): Promise<void>;
  recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void>;
  commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void>;
  private requireStore;
  private allocate;
  private open;
  private close;
  private header;
}
//#endregion
export { AcceptanceCriterion, AcceptanceCriterionShape, AcceptanceFacts, ArtifactRef, CapabilityCoverageFacts, CapabilityManifest, ContextEfficiencyFacts, DecompositionFacts, DecompositionStatus, DependencyEdge, Diagnosis, DiagnosisConfidence, DiagnosisProposal, DiagnosisProvenance, EvidenceBundle, EvidenceClaim, JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, JudgedDimension, JudgementVerdict, Obligation, OutcomeCorrectnessFacts, ProposalTargetType, ReviewBlocker, ReviewCriterion, ReviewDimensions, ReviewJudgement, ReviewMetrics, ReviewOutcome, ReviewRecord, ReviewTokenUsage, ReviewToolCall, ReviewToolCallTotals, RootTaskSpec, RunId, RunStatus, SkillFitFacts, TaskDefinition, TaskEvent, TaskEventEnvelope, TaskEventKind, TaskEventPayloads, TaskHandoff, TaskId, TaskInstance, TaskRun, TaskService, TaskService as default, TaskSnapshot, TaskSpecificationFacts, TaskState, TaskStatus, ToolFitFacts, VerificationMode, VerificationResult, Verifier, VerifierSelftest, VerifyRequest, reaches, rootTaskStoreId };