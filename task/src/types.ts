import type { DecompositionAdmission, TaskContract } from './contract.ts'
import type { TaskBudgetExtensionClaim, TaskBudgetExtensionIndex } from './budget.ts'
import type {
  TaskProposal,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalIndex,
  TaskProposalPhaseChange,
} from './proposal.ts'
import type { QuestionAnswerRecord, QuestionRecord, TaskQuestionIndex } from './question.ts'

export type TaskId = string
export type RunId = string

export interface ArtifactRef {
  artifactId: string
  kind: string
  uri: string
  digest?: string
}

export type VerificationMode = 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite'

export interface AcceptanceCriterion {
  // (§9.2)
  criterionId: string
  description: string
  verificationMode: VerificationMode
  requiredEvidence: string[]
  mandatory: boolean
  command?: string // required for deterministic|simulation|measurement
  /** Artifact or evidence references (kinds or ids) that must exist in the task store before this criterion can be judged at all (KISS §5.1 `requires_artifact`): an ordering constraint declared as an evidence dependency, not a sequence step. */
  requiresArtifact?: string[]
  /** Artifact or evidence references (kinds or ids) this criterion consumes as a **raw input** (KISS §5.1): existence in the task store is the whole requirement — any run state, verified or not. */
  acceptsArtifact?: string[]
  /** The registered verifier id that judges this criterion (KISS §4.1 `verifier_ref`). Absent keeps the current behavior: dispatch by `verificationMode` to whichever registered verifier supports it. */
  verifierRef?: string
  /** The parent-level evidence map (KISS §6 C2, minimal mechanical version): which child of this task — by position in its decomposition batch, the same index vocabulary `dependsOn` uses — this criterion rests on, optionally narrowed to one of … */
  childEvidence?: ChildEvidenceRef[]
  /** Marks this criterion's judgement as **heuristic** (KISS §5.1): the verdict is explicitly labeled as such wherever it is reported, and it is never counted as a deterministic pass — a natural-language coverage signal can inform a reader but … */
  heuristic?: boolean
  /** The acceptance inputs this criterion's verdict rests on that the executing side must not modify (S1-V slice 2): acceptance scripts, threshold files, fixtures. */
  protectedInputs?: ProtectedInputRef[]
}

/** One protected acceptance input ({@link AcceptanceCriterion.protectedInputs}): the path as declared, plus the SHA-256 of the file's bytes fixed when the task was admitted. */
export interface ProtectedInputRef {
  /** The input path as declared, resolved against the run's checkout directory. */
  path: string
  /** SHA-256 (lowercase hex) of the file's bytes at admission. */
  sha256: string
}

/** One entry of a parent criterion's evidence map ({@link AcceptanceCriterion.childEvidence}): a member of the parent run's admitted batches, named by its stable position in that run's accumulation — the only child identity that exists when … */
export interface ChildEvidenceRef {
  /** Position of the member in the parent run's accumulated batch members (0-based, admission order). */
  childIndex: number
  /** The child criterion whose passing verdict is required; absent requires only the child's verified state. */
  criterionId?: string
  /** The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence; absent requires only the child's evidence. */
  evidenceRef?: string
}

export type TaskStatus =
  'created' | 'admitted' | 'ready' | 'running' | 'blocked' | 'verifying' | 'verified' | 'failed' | 'cancelled'
type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed'

export interface TaskInstance {
  // (§5.2)
  taskId: TaskId
  definitionRef: { taskType: string; version: number }
  parentTaskId?: TaskId
  /** The task's goal: the projection of {@link contract} (or, on a task created before the contract existed, the whole of what the store holds). */
  objective: string
  depth: number
  /** The criteria the verifier judges: the projection of {@link contract}, checked for disagreement on write. */
  acceptanceCriteria: AcceptanceCriterion[]
  /** Capability requirements by name: the projection of {@link TaskContract.requiredCapabilities}. */
  requestedCapabilities: string[]
  /** Where the task sits in the decomposition tree; `decomposed` is written when the task registers children. */
  decompositionStatus: DecompositionStatus
  status: TaskStatus
  runIds: RunId[]
  childTaskIds: TaskId[]
  /** The normalized contract this instance was created from (T1, construction guide §4): defaults filled, criterion ids fixed, assumptions and constraints persisted rather than left in a spawn prompt. */
  contract?: TaskContract
  /** Contract-level marker (KISS §6 C2): this task's acceptance must be decided by its own criteria and evidence map, never by the composite "all children verified" conjunction alone. */
  requiresIndependentAcceptance?: boolean
}

export interface DependencyEdge {
  from: TaskId
  to: TaskId
} // `from` must verify before `to` starts

/** DFS over an edge list: true when `target` is reachable from `start`. */
export function reaches(edges: readonly DependencyEdge[], start: TaskId, target: TaskId): boolean {
  const seen = new Set<TaskId>()
  const pending = [start]
  while (pending.length > 0) {
    const current = pending.pop() as TaskId
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of edges) if (edge.from === current) pending.push(edge.to)
  }
  return false
}

export type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled'

/** The run statuses that end a run: no transition out of these resumes it (guide §4.2 G3 — blocked is a dead end). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'verified',
  'failed',
  'cancelled',
  'blocked',
])

/** Whether `status` is terminal ({@link TERMINAL_RUN_STATUSES}). */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** One skill a run's grant was built from, as the admission-time provider pre-check judged it (S1-C item 4). */
export interface RunSkillBinding {
  /** The skill name a capability granted; the snapshot directory is named after it. */
  name: string
  /** How the pre-check accepted it — execution provider, loadable knowledge, or plain guidance. */
  role: 'execution-provider' | 'knowledge' | 'guidance'
  /** The run's capability rows that grant this skill, sorted: the capability names a worker's summary groups its providers under, read from the record rather than re-derived from the store. */
  capabilities: string[]
  /** The purpose the skill declares for itself, so a summary can say what the provider is for without reading its body. */
  description: string
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null
  /** `skillContentDigest` of the bytes the run loaded. */
  contentDigest: string
  /** Entries of the source skill directory the identity does not cover (a guidance skill's extra files, a directory reads as `name/`). */
  uncovered: string[]
}

/** One MCP server a run's manifest granted: the registry key it resolved through and the identity of the template it resolved to. */
export interface RunMcpServerBinding {
  /** The server name the capability declared and the worker's tools are namespaced under. */
  serverName: string
  /** SHA-256 over the registry template the name resolved to, or `null` when the registry holds no such name. Diagnostic (see the interface note): never an execution identity. */
  templateDigest: string | null
}

/** What one run resolved against and loaded (S1-C item 4): the registry revision the admission-time pre-check computed, the identity of every skill the run's grant was built from, the MCP servers its manifest granted, and — when the run … */
export interface RunProviderBinding {
  /** The registry revision the admission-time provider pre-check computed for this run's table and accepted providers (`provider-precheck.ts:registryRevision`): two runs citing the same revision resolved the same rows over the same declared … */
  registryRevision: string
  /** Every capability row this run's manifest matched, sorted — including a row that grants no skill (its tools are granted without a provider). */
  capabilities: string[]
  /** One entry per skill the run's grant was built from, sorted by name. A skill two capabilities declare appears once, naming both. */
  skills: RunSkillBinding[]
  /** The MCP servers the run's manifest granted, in first-declaration order. */
  mcpServers: RunMcpServerBinding[]
  /** Absolute path of this run's snapshot skill root — the directory whose `<name>/SKILL.md` entries the worker's skill layer registers — present exactly when the run materialized the content it was bound to. */
  snapshotRoot?: string
}

/** Where one run sits in the A3 coordination protocol. `active` is the phase a run is born in, and the only one in which it may write, decompose or submit; `waiting_children` is a run whose decomposition batch was admitted atomically and … */
export type ExecutionPhase = 'active' | 'waiting_children' | 'submitted'

/** What one run handed in when it submitted (A3 `task_submit_result`): the submitter's own account plus the references it names as proof. */
export interface SubmissionRecord {
  /** What was delivered, in the submitter's words (the runtime writes it for a workerless criteria replay). */
  summary: string
  /** The evidence ids, artifact refs, or review refs the submitter names as proof. */
  evidenceRefs: string[]
  /** Anything further a reader should know; absent when the submitter left none. */
  notes?: string
  /** When the submission was recorded — the phase-change event's own timestamp. */
  submittedAt: string
  /** Who submitted: the run's own agent through its explicit call, or the runtime recording a workerless criteria replay. */
  origin: 'worker' | 'runtime'
}

/** One no-progress marking on an `active` run (A3 `RunProgressMarked`): the observable record that a worker went idle where a submission was due. */
interface NoProgressRecord {
  /** The only kind A3 writes. */
  kind: 'unsubmitted-idle'
  /** Consecutive no-progress rounds the caller observed; a positive integer, recorded as given. */
  rounds: number
  /** The run subtree's fact count at marking time — the snapshot-derivable progress measure (A3 §3.5). */
  factCount: number
  /** When the marking was recorded — the event's own timestamp. */
  markedAt: string
}

/** One batch a run admitted, as the run's snapshot projects it: the batch id {@link batchIdFor} derives, the proposal it consumed, and the member task ids that admission created, in batch order. */
interface TaskRunBatch {
  /** The batch id: {@link batchIdFor} of this run and this proposal. */
  batchId: string
  /** The proposal this batch consumed; the content identity its members were admitted under. */
  proposalId: string
  /** The member task ids this batch created, in batch order. */
  memberTaskIds: TaskId[]
}

/** One member slot of a recovery attempt's run that is filled by an **already verified sibling** instead of by a task this run admitted (A6, plan §F.4). */
export interface RunMemberReuse {
  /** The absolute position in this run's member sequence the entry claims — the `childIndex` a parent criterion's `childEvidence` map names. */
  childIndex: number
  /** The already verified sibling task the slot reads as: a child task of this run's own task. */
  taskId: TaskId
  /** The sibling's own verified run — the one whose evidence is cited. Its task is {@link taskId} and it is `verified` in this store. */
  sourceRunId: RunId
  /** The evidence bundle under {@link sourceRunId} the citation rests on. */
  evidenceId: string
  /** The criterion the sibling must have passed when the original acceptance map narrows this position to one: the cited bundle must carry a `pass` verdict for it and the sibling must declare it. Absent when the map names only the position. */
  criterionId?: string
  /** Artifacts the citation names, by artifact id or kind, all present in the cited bundle. */
  artifactRefs: string[]
  /** Input references the citation names, from the sibling's own declared input vocabulary (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`). Empty when the citation rests on the run/evidence/product identity alone. */
  inputRefs: string[]
}

/** The recovery attempt a run **is** (A6, plan §F.4): a failed root task's new attempt, opened by the runtime's recovery entry in the same store, with the diagnosis and request that asked for it and the sibling evidence it reads instead of … */
export interface RunRecovery {
  /** The diagnosis the attempt was requested for: the id of a `Diagnosis` record this store holds for this task. */
  sourceDiagnosisId: string
  /** The caller's request key. One key names one attempt of one diagnosis, and the same key answers with the same run. */
  requestKey: string
  /** The failed run the source task's previous attempt was, when it had one. A task that failed without a run (a rejected admission, a blocked task) names none, and nothing is invented for it. */
  sourceRunId?: RunId
  /** When the attempt was opened. */
  requestedAt: string
  /** The identity of the **request** this attempt answers: the source run it names and the citations its caller declared, over their canonical form (`requestAttemptDigest`). */
  requestDigest?: string
  /** The already verified siblings this attempt reads, by the positions they claim. Empty when it re-runs everything. */
  reusedMembers: RunMemberReuse[]
  /** The positions of the failed run that read a **passed sibling the attempt could not bind**, with the reasons it could not: an unresolved evidence, product or input identity, or a criterion the original acceptance map narrows the position to … */
  unboundMembers?: RunMemberReuseRefusal[]
}

/** One position of a failed run the attempt did not bind, and why (see {@link RunRecovery.unboundMembers}). */
export interface RunMemberReuseRefusal {
  /** The position in the run's member sequence the failed run read the member at. */
  childIndex: number
  /** The passed sibling the failed run read there, when it read one. */
  taskId?: TaskId
  /** The criterion the original acceptance map narrows that position to, when it names one. */
  criterionId?: string
  /** Every reason the sibling's evidence could not be bound to this position, each naming the identity that did not resolve. */
  reasons: string[]
}

export interface TaskRun {
  // (§5.3)
  runId: RunId
  taskId: TaskId
  sessionId: string
  parentRunId?: RunId
  capabilitySnapshot: string[]
  agentPreset?: string
  /** What this run was bound to and loaded (S1-C item 4). Absent on every run created before the field existed, and on a run whose caller assembled its plan without an admission-time pre-check: neither loaded content this build can vouch for … */
  providerBinding?: RunProviderBinding
  /** Where this run sits in the A3 coordination protocol. A new run is born `active`, or `submitted` when it has no worker at all (a `spawn: false` replay). */
  executionPhase?: ExecutionPhase
  /** The batch this run is waiting on: the one still open, the id {@link batchIdFor} derives from this run and the proposal it consumed. */
  batchId?: string
  /** Every batch this run admitted, in admission order, with the member task ids each created — the run's accumulative membership. */
  batches?: TaskRunBatch[]
  /** The recovery attempt this run *is* (A6). Absent on every run that is not one: a first attempt, a child, a replay — an ordinary run is not a recovery of anything, and nothing is inferred for it. */
  recovery?: RunRecovery
  /** What this run handed in, written by the transition into `submitted`. Absent on a run that has not submitted; its presence is what makes a second submission a refusal rather than an overwrite. */
  submission?: SubmissionRecord
  /** The A3 question-id mount point, kept readable and never written again (A4): the store's question records are the one durable source of what a run waits on, and a second index that could disagree with them is what A4 took out of the write … */
  pendingQuestionIds?: string[]
  /** The A3 blocking-question mount point, kept readable and never written again; see {@link pendingQuestionIds}. */
  blockingQuestionIds?: string[]
  /** The last no-progress marking on this run (A3). Overwritten by each `RunProgressMarked`; absent until a caller marks one, and on every run written before the field existed. */
  noProgress?: NoProgressRecord
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  status: RunStatus
  startedAt: string
  finishedAt?: string
}

/** The member **slots** one run reads, in the sequence a parent criterion's `childIndex` names: the verified siblings its {@link TaskRun.recovery} claims at the positions they name, and the `memberTaskIds` of its batches — in admission order … */
export function runMemberSlots(run: TaskRun): (TaskId | undefined)[] {
  const claimed = [...(run.recovery?.reusedMembers ?? [])].sort((left, right) => left.childIndex - right.childIndex)
  if (claimed.length === 0) return (run.batches ?? []).flatMap(batch => batch.memberTaskIds)
  const slots: (TaskId | undefined)[] = []
  for (const entry of claimed) {
    while (slots.length < entry.childIndex) slots.push(undefined)
    slots[entry.childIndex] = entry.taskId
  }
  for (const memberTaskId of (run.batches ?? []).flatMap(batch => batch.memberTaskIds)) {
    const free = slots.indexOf(undefined)
    if (free === -1) slots.push(memberTaskId)
    else slots[free] = memberTaskId
  }
  return slots
}

/** The member task ids one run reads, in slot order, with the slots it has not filled left out: what a reader that needs *which* tasks are members — not where each one sits — asks for. */
export function runMemberTaskIds(run: TaskRun): TaskId[] {
  return runMemberSlots(run).filter((taskId): taskId is TaskId => taskId !== undefined)
}

export interface VerificationResult {
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  /** The version of the registered verifier instance that produced this verdict (S1-V slice 2, KISS §8.2): stamped by the verifier registry from the instance it actually dispatched to — never from the criterion's own text or from the verifier's … */
  verifierVersion?: string
  command?: string
  exitCode?: number
  logRef?: string // path relative to verifier evidenceRoot, never absolute
  details?: string
  /** Which side an `inconclusive` verdict belongs to (KISS §4.3's UNKNOWN split): `task` when the check never ran (timeout, the command never started) — the criterion was never tested; `verifier` when the judge itself is broken (the verifier … */
  unknownKind?: 'task' | 'verifier'
}

export interface EvidenceClaim {
  // (§10)
  claimId: string
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  /** Copied from the {@link VerificationResult} this claim rests on: the registered instance's version, the second half of the `(verifierRef, version)` index key (KISS §8.2). */
  verifierVersion?: string
  artifactRefs: string[]
  details?: string
  /** Copied from the {@link VerificationResult} this claim rests on; see that field. */
  unknownKind?: 'task' | 'verifier'
}

export interface EvidenceBundle {
  evidenceId: string
  taskRunId: RunId
  taskId: TaskId
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  claims: EvidenceClaim[]
  generatedAt: string
}

export interface TaskHandoff {
  // (§18)
  handoffId: string
  parentTaskId: TaskId
  parentRunId: RunId
  childTaskId: TaskId
  parentObjective: string
  reasonForDelegation: string
  constraints: string[]
  decisions: string[]
  relevantArtifacts: ArtifactRef[]
  relevantEvidence: string[]
  assumptions: string[]
  openQuestions: string[]
  parentSessionRef?: string
  createdAt: string
}

export interface CapabilityManifest {
  // (§11–12)
  capabilities: Record<
    string,
    {
      skills: string[]
      /** Real DSH tool names the capability grants: labels are expanded when the manifest is resolved. */
      tools: string[]
      preset?: string
      permission?: string
      /** MCP server names the capability grants, resolved against the task runtime's server registry at admission and mounted per worker at spawn (`mcp__<server>__<tool>` on the worker's own tool layer). Absent = none. */
      mcpServers?: string[]
    }
  >
  missing: string[]
  closure: 'closed' | 'partial' | 'gap'
}

/** The terminal outcome one run (or a child blocked before its run ever started) settled in. */
export type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked'

/** One criterion's verdict as the verifier reported it, copied onto the review record so a reader sees what was checked — command and exit code included — without replaying the run or opening the evidence bundle. */
export interface ReviewCriterion {
  criterionId: string
  /** The verifier's verdict for this criterion. */
  verdict: 'pass' | 'fail' | 'inconclusive'
  /** The registered verifier that decided the verdict, copied from the verifier result. */
  verifierId?: string
  /** The deciding instance's version, copied from the verifier result (S1-V slice 2); absent when it declared none or the record predates the field. */
  verifierVersion?: string
  /** The command that was run, from the verifier result or the criterion itself, when the mode runs one. */
  command?: string
  /** The command's exit code, when the verifier reported one. */
  exitCode?: number
  /** Log path relative to the verifier evidence root, when the verifier wrote one. */
  logRef?: string
  /** Which side an inconclusive verdict belongs to, copied from the verifier result so a review reader (and the E3 escalation signal) can tell "the check never ran" (`task`) from "the judge is broken" (`verifier`) without reopening the evidence … */
  unknownKind?: 'task' | 'verifier'
}

/** One dependency whose outcome kept a blocked task from ever starting a run. */
export interface ReviewBlocker {
  taskId: TaskId
  /** The dependency's task status at the moment this task settled blocked. */
  outcome: TaskStatus
}

/** The four token buckets a session's `tokenUsage` projection reports, copied verbatim from that projection's wire view (upstream `llm/token-meter/src/usage-projection.ts:117-150`). */
export interface ReviewTokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One tool name a session log shows being called, with how many times. */
export interface ReviewToolCall {
  name: string
  /** `tool/call` events naming this tool in the session. */
  count: number
}

/** Dimension 1, outcome correctness: the terminal status the run settled in and what the verifier said per criterion. */
interface OutcomeCorrectnessFacts {
  outcome: ReviewOutcome
  /** Criteria the record carries a verdict for; 0 when the verifier never reported. */
  criteriaCount: number
  /** Ids of the criteria whose verdict was not `pass`. */
  unmetCriterionIds: string[]
}

/** Dimension 2, task specification quality: how much specification the task carried, as counts. Purely mechanical — a thin specification is a fact here, not a verdict. */
interface TaskSpecificationFacts {
  /** Whether the objective has non-whitespace content. */
  objectivePresent: boolean
  /** The task's acceptance criteria count. */
  criteriaCount: number
  /** How many of them declare a `command`. */
  criteriaWithCommand: number
}

/** One criterion's declaration shape, as authored on the task (not the verifier's verdict). */
interface AcceptanceCriterionShape {
  criterionId: string
  mode: VerificationMode
  /** Whether the criterion declares a `command` to run. */
  hasCommand: boolean
  mandatory: boolean
}

/** Dimension 3, acceptance quality: each criterion's declared verification mode and whether it hands the verifier a command. Limitation: mode and command presence are the only mechanically observed facts here. */
interface AcceptanceFacts {
  criteria: AcceptanceCriterionShape[]
}

/** Dimension 4, decomposition quality: the position and shape of this task in the decomposition tree at review time. Limitation: shape only. */
interface DecompositionFacts {
  depth: number
  decompositionStatus: DecompositionStatus
  childCount: number
  /** Dependency edges whose target is this task (must verify before it starts). */
  incomingEdges: number
  /** Dependency edges whose source is this task (it must verify before they start). */
  outgoingEdges: number
}

/** Dimension 5, capability coverage: what the task's resolved manifest granted and what it could not resolve. Limitation: this is the admission-time resolution, not a claim that the granted capability was the *right* one for the work. */
interface CapabilityCoverageFacts {
  /** The manifest's closure verdict: `closed` when nothing required was missing. */
  closure: CapabilityManifest['closure']
  /** Flattened skills+tools of the resolved manifest — exactly the list a run records in its `capabilitySnapshot`. */
  granted: string[]
  /** Required capability names the registry could not grant. */
  missing: string[]
}

/** Dimension 6, skill fit: skills the run's capabilities granted against skills the session's log shows the `skill` tool actually loading. */
interface SkillFitFacts {
  /** Skill names the run's capabilities granted. */
  granted: string[]
  /** Skill names the session's `skill` calls loaded, deduplicated and sorted; absent when no log was readable. */
  loaded?: string[]
  /** Loaded skill names outside `granted`; empty means every load was covered by the grant. */
  loadedOutsideGrant?: string[]
}

/** Dimension 7, tool fit: tools the run's capabilities granted (plus the worker baseline) against tools the session's log shows being called. */
interface ToolFitFacts {
  /** Real DSH tool names the run's capabilities granted (labels expanded at admission). */
  granted: string[]
  /** Tool names the session shows being called, with counts; absent when no log was readable. */
  called?: ReviewToolCall[]
  /** Called names outside `granted` ∪ `workerBaseline()`; empty means every call was covered. */
  calledOutsideGrant?: string[]
}

/** Dimension 8, context efficiency: only numbers that can be read reliably, and nothing that rates them. */
interface ContextEfficiencyFacts {
  /** Whole-session token buckets; the same value {@link ReviewMetrics.tokens} carries. */
  tokens?: ReviewTokenUsage
  /** `compaction/start` events observed in the session log. */
  compactions?: number
}

/** The eight review dimensions (§2.7.3), each carrying mechanically observed facts — never a score, never an LLM judgement, never transcript text. Every member is optional and is omitted, not defaulted, when the data behind it does not exist. */
export interface ReviewDimensions {
  outcomeCorrectness?: OutcomeCorrectnessFacts
  taskSpecification?: TaskSpecificationFacts
  acceptance?: AcceptanceFacts
  decomposition?: DecompositionFacts
  capabilityCoverage?: CapabilityCoverageFacts
  skillFit?: SkillFitFacts
  toolFit?: ToolFitFacts
  contextEfficiency?: ContextEfficiencyFacts
}

/** Call and failure totals over one session's tool traffic. */
interface ReviewToolCallTotals {
  /** `tool/call` events in the session log. */
  calls: number
  /** `tool/result` events whose payload reports a failure. */
  failures: number
}

/** The six engineering-effort indicators, as counters. Every member is optional and is omitted rather than filled with a placeholder when its source is unavailable. */
export interface ReviewMetrics {
  /** Provider-reported, whole-session token buckets from the session's `tokenUsage` projection. */
  tokens?: ReviewTokenUsage
  /** Session tool traffic; absent when no session log was readable. */
  toolCalls?: ReviewToolCallTotals
  /** Count of human-intervention events in the session log: `approval/asked` plus calls to `hitl_ask` / `hitl_approve` / `ask_user_question`. */
  humanInterventions?: number
  /** `TaskStarted` count minus one for this task (`TaskInstance.runIds.length - 1`). Limitation: the current orchestrator has no retry branch, so this is structurally always 0 — a reader must not conclude "it was tried again and did not need to … */
  retries?: number
  /** Criteria on this record that carry a `logRef` — where the evidence for a verdict was written. */
  evidenceLogs?: number
}

/** One lightweight terminal record per run, written exactly once when the run reaches its terminal state. No scoring and no judge — a human reads it. */
export interface ReviewRecord {
  taskId: TaskId
  /** Absent when the task was blocked before any run started. */
  runId?: RunId
  /** Absent when no run/session was ever bound to the task. */
  sessionId?: string
  outcome: ReviewOutcome
  /** Evidence ids recorded under this run, taken from the store at terminal time. */
  evidenceRefs: string[]
  /** Notable facts; for `blocked`, the text naming the dependency that did not verify. */
  anomalies: string[]
  /** Failed outcomes only: the same reason text the terminal status event carries. */
  localizedCause?: string
  /** The tasks this run related to (a child's dependencies; a parent's children). */
  relatedTaskIds?: TaskId[]
  /** Wall-clock duration of the run from start to its terminal transition, in milliseconds. Absent when no run started. */
  durationMs?: number
  /** Per-criterion verdicts from the run's verification bundle; absent when the verifier never ran. */
  criteria?: ReviewCriterion[]
  /** Failed outcomes only: tail excerpt of a failing criterion's log (bounded, see verifier logTail), so a review reads without a replay. */
  logTail?: string
  /** Blocked outcomes only: the dependencies whose outcomes kept this task from running. */
  blockedBy?: ReviewBlocker[]
  /** Mechanically observed facts per review dimension; absent when none could be derived. */
  dimensions?: ReviewDimensions
  /** Engineering-effort counters; absent when none could be collected. See {@link ReviewMetrics}. */
  metrics?: ReviewMetrics
}

/** How sure the diagnoser is of its localized cause. Coarse on purpose (§2.7.3: Review ≠ Judge — a diagnosis explains, it does not score). */
export type DiagnosisConfidence = 'high' | 'medium' | 'low'

/** The mutation surfaces the Evolution ledger records a proposal under (§2.7.6). This is Evolution's own vocabulary — what it can *execute* is narrower still (`APPLYABLE_TARGET_TYPES` in the evolution package) — and it is deliberately not the … */
export type ProposalTargetType =
  | 'skill'
  | 'tool'
  | 'capability'
  | 'task_definition'
  | 'decomposition_policy'
  | 'agent_preset'
  | 'workflow_policy'
  | 'verifier'
  | 'runtime_policy'

/** One structured suggestion a diagnosis raises. In P4 a proposal never executes by itself (§2.7.6: no automatic production changes); it is data for a human or a later Evolution step. */
export interface DiagnosisProposal {
  /** The mutation surface the suggestion points at, as a non-empty open name (A5): a diagnosis explains, and the store does not freeze what a suggestion may name — a target type no executor exists for is a recorded suggestion, refused by name … */
  targetType: string
  targetId: string
  rationale: string
}

/** The six review dimensions whose conclusion is not mechanically observable (§2.7.3): the fact table records what the run did, and only a reader holding the whole context can say whether what it did was adequate. */
export type JudgedDimension =
  'task_specification' | 'acceptance' | 'decomposition' | 'skill_fit' | 'tool_fit' | 'context_efficiency'

/** Every judged dimension, in the order a report reads them. */
export const JUDGED_DIMENSIONS: readonly JudgedDimension[] = [
  'task_specification',
  'acceptance',
  'decomposition',
  'skill_fit',
  'tool_fit',
  'context_efficiency',
]

/** One dimension's coarse conclusion. Three values on purpose — this is not a rating scale. */
export type JudgementVerdict = 'adequate' | 'inadequate' | 'unknown'

/** Every judgement verdict, for reducer validation and rendering. */
export const JUDGEMENT_VERDICTS: readonly JudgementVerdict[] = ['adequate', 'inadequate', 'unknown']

/** One judged dimension: an agent's (or a person's) conclusion over the facts a `ReviewRecord` carries. Still not a score — `verdict` is a coarse three-way call, `evidenceRefs` names what it rests on, and `rationale` states the reasoning. */
export interface ReviewJudgement {
  /** Which dimension this concludes; only the six non-mechanical ones are judgeable. */
  dimension: JudgedDimension
  /** The conclusion: adequate, inadequate, or unknown. */
  verdict: JudgementVerdict
  /** Refs the judgement rests on: evidence ids, the review refs `task_review_pack` prints (`<taskId>#<runId>`, or `<taskId>#no-run`), or session ids. Required and non-empty — a conclusion that cites nothing is not reviewable. */
  evidenceRefs: string[]
  /** Why this verdict, in the writer's words. */
  rationale: string
}

/** Who produced a diagnosis, so an agent's judgement is never mistaken for a person's. */
interface DiagnosisProvenance {
  /** `agent` when a spawned review agent wrote it; `human` for a person. */
  kind: 'agent' | 'human'
  /** The session that produced it, when one did — the id a reader drills into. */
  sessionId?: string
}

/** The core product of review (§2.7.3): an explanation of what a task's reviews show, not a score. Diagnosis lineage is a graph, not a tree (§2.7.4): `reviewRefs` may name several records and `relatedTaskIds` may point across tasks. */
export interface Diagnosis {
  diagnosisId: string
  taskId: TaskId
  /** The failure or anomaly under explanation, as observed in the evidence. */
  observedFailure: string
  /** How far the cause reaches (this task, its subtree, a shared assumption, …). */
  scope: string
  /** The most specific explanation the evidence supports. */
  localizedCause: string
  /** Evidence ids the diagnosis rests on. */
  evidenceRefs: string[]
  /** The review records the diagnosis rests on, named by the refs task_review_pack prints (`<taskId>#<runId>`, or `<taskId>#no-run`). */
  reviewRefs: string[]
  confidence: DiagnosisConfidence
  /** Structured suggestions only; nothing here auto-executes. */
  proposals: DiagnosisProposal[]
  /** Other tasks this diagnosis implicates (cross-task lineage, §2.7.4). */
  relatedTaskIds?: TaskId[]
  /** Who wrote this diagnosis. Absent on records written before this field existed, and on any writer that does not declare itself; absence is read as human-written (the only producer there was). */
  producedBy?: DiagnosisProvenance
  /** The six judged dimensions, when the writer made explicit calls. Optional: a diagnosis may explain a cause without judging every dimension, and an all-`unknown` judgement is a legitimate outcome — it says the evidence did not settle the … */
  judgements?: ReviewJudgement[]
}

/** One structured record of what is still missing (KISS §2/§5): an Obligation is a question, not an action — `goal` names the gap, `criterion` says how its satisfaction would be judged, and `sourceTaskId` names the task whose failure, block … */
export interface Obligation {
  obligationId: string
  /** What is still missing, as a question or a named gap. */
  goal: string
  /** How a reader would judge the obligation satisfied. */
  criterion: string
  /** The task whose terminal transition (or rejected admission) raised it. */
  sourceTaskId: TaskId
}

/** Store id convention: one task store per root session. */
export function rootTaskStoreId(rootSessionId: string): string {
  return `sg-t-${rootSessionId}`
}

export interface TaskSnapshot {
  readonly version: 1
  readonly id: string
  readonly tasks: readonly TaskInstance[]
  readonly runs: readonly TaskRun[]
  readonly edges: readonly DependencyEdge[]
  readonly evidence: readonly EvidenceBundle[]
  readonly handoffs: readonly TaskHandoff[]
  readonly reviews: readonly ReviewRecord[]
  readonly diagnoses: readonly Diagnosis[]
  readonly obligations: readonly Obligation[]
  readonly capabilities: Readonly<Record<string, CapabilityManifest>>
  /** The store's proposals, indexed for the three questions a review gate asks (§6/§7): by proposal id, by the caller's request key, and by parent task. */
  readonly proposals?: TaskProposalIndex
  /** The store's parent/child questions (A4 §F.1), in ask order and by id, each carrying the answers recorded so far. */
  readonly questions?: TaskQuestionIndex
  /** The ceilings a person raised on this tree's own budget (K4), in the order they were recorded and by request key. */
  readonly budgetExtensions?: TaskBudgetExtensionIndex
}

export interface TaskEventPayloads {
  /** A task instance enters the store (created status, no runs or children attached). */
  TaskCreated: { task: TaskInstance }
  /** A created task is admitted as a leaf or as decomposable. */
  TaskAdmitted: { decompositionStatus: 'leaf' | 'decomposable' }
  /** A created task is rejected at admission and settles blocked. */
  TaskRejected: { reason: string }
  /** A decomposable task's children are registered under it and the parent closes as decomposed. */
  TaskDecomposed: {
    childTaskIds: TaskId[]
    /** The batch's content identity and the limits it was admitted under (construction guide §4). */
    admission?: DecompositionAdmission
    /** The batch id {@link batchIdFor} derives from the run and the proposal below; refused when it is not that id. */
    batchId?: string
    /** The run that admitted this batch; its accumulation gains one entry naming these members. */
    parentRunId?: RunId
    /** The proposal this batch consumed — the second half of the batch's identity. */
    proposalId?: string
  }
  /** A dependency edge is added to the DAG (from must verify before to starts). */
  DependencyAdded: { edge: DependencyEdge }
  /** A run starts on an admitted/ready task. */
  TaskStarted: { run: TaskRun }
  /** A task settles blocked, optionally taking its running run with it. */
  TaskBlocked: { reason?: string }
  /** A running task hands its run to the verifier. */
  TaskVerifying: Record<string, never>
  /** A verifying task settles verified; requires evidence under the run. */
  TaskVerified: { finishedAt?: string }
  /** A running/verifying task settles failed. */
  TaskFailed: { reason?: string; finishedAt?: string }
  /** A running task settles cancelled. */
  TaskCancelled: { reason?: string; finishedAt?: string }
  /** A failed task returns to ready so a new run can start. */
  TaskRetried: Record<string, never>
  /** A running run's coordination phase changes (A3). The transition is the admission gate: `active → waiting_children` when its decomposition batch is admitted atomically, `waiting_children → active` when that batch ends and execution is … */
  RunPhaseChanged: {
    phase: ExecutionPhase
    /** The batch an `active ↔ waiting_children` edge names: the batch opened on the way out and the batch closed on the way back (`b-<parentRunId>-<proposalId>`, {@link batchIdFor}). */
    batchId?: string
    /** The record a `submitted` run hands in; required for that phase and refused elsewhere. */
    submission?: SubmissionRecord
    /** The A3 question-id mount point, readable for old records only: the reducer still shape-checks and carries it, so a store written before A4 replays to the same snapshot, while this build's write entries refuse a phase change that carries it … */
    pendingQuestionIds?: string[]
    /** The A3 blocking-question mount point, readable for old records only; same handling as `pendingQuestionIds`. */
    blockingQuestionIds?: string[]
    /** The caller's account of the transition, when a reader needs one. */
    reason?: string
  }
  /** A run was observed idle without submitting (A3): the no-progress record a reader shows before the budget stops a stuck run. */
  RunProgressMarked: {
    /** The only kind A3 writes. */
    kind: 'unsubmitted-idle'
    /** Consecutive no-progress rounds the caller observed; a positive integer. */
    rounds: number
    /** The run subtree's fact count at marking time (A3 §3.5). */
    factCount: number
    /** The observable diagnostic: why the run looks stuck. */
    note: string
  }
  /** A child run asks its direct parent task a question (A4, plan §F.1). The record is the durable half of the exchange — the question's identity, the asking and answering runs, the citation of the body, the delivery's messageId, the request … */
  QuestionAsked: { question: QuestionRecord }
  /** A parent run answers one of its children's questions (A4, plan §F.1). The answer is its own event, appended to the question's record: an open question accepts several answers (a partial one, then a resolving one), and `resolves` is the … */
  QuestionAnswered: { answer: QuestionAnswerRecord }
  /** The capability manifest a task was admitted with is stored. */
  CapabilityResolved: { manifest: CapabilityManifest }
  /** Admission found required capabilities the registry cannot grant. */
  CapabilityGapDetected: { missing: string[] }
  /** An evidence bundle is recorded under a running run. */
  EvidenceProduced: { evidence: EvidenceBundle }
  /** A parent run hands a child task off to its worker. */
  HandoffCreated: { handoff: TaskHandoff }
  /** A terminal run's one lightweight review record, written exactly once at terminal time. */
  ReviewRecorded: { review: ReviewRecord }
  /** One caller-triggered diagnosis over a task's review records; immutable once written, unique per diagnosisId. */
  DiagnosisRecorded: { diagnosis: Diagnosis }
  /** A structured "what is still missing" record raised by a failure, a block, or a capability gap; an Obligation is a question, never an action. */
  ObligationRecorded: { obligation: Obligation }
  /** A person raised a ceiling of the tree's own budget (K4): the run count the tree may reach, the instant it must stop by, or both — each recorded as the pair (the ceiling in force when the request was read → the ceiling approved now), with … */
  TaskBudgetExtended: { extension: TaskBudgetExtensionClaim }
  /** A proposal enters the store (T2/T3, construction guide §6; root contracts A0 §2): one immutable submission with the policy it was born under, the complete normalized contracts it proposes, the limits it was admitted under, the resolution … */
  TaskProposalSubmitted: { proposal: TaskProposal }
  /** A human review decision (T2/T3, §6): approved, rejected, cancelled or expired, bound to the dossier digest and both context fingerprints shown when it was taken. */
  TaskProposalDecided: TaskProposalDecisionClaim
  /** A runtime-driven proposal phase change (T2/T3, §6): to `pending_review` when the deployment tightens to `all` while a policy-off proposal is still un-admitted (only tightening is allowed; a waiting proposal is never released), to `ready` … */
  TaskProposalPhaseChanged: TaskProposalPhaseChange
  /** A proposal is consumed (T2/T3, §6; root contracts A0 §2): what it asked for now exists, bound to the ids this event carries. */
  TaskProposalAdmitted: TaskProposalConsumption
}

export type TaskEventKind = keyof TaskEventPayloads

interface TaskEventEnvelope<K extends TaskEventKind, P> {
  readonly kind: K
  readonly taskId: TaskId
  readonly runId?: RunId
  readonly sessionId?: string
  readonly parentTaskId?: TaskId
  readonly timestamp: string
  readonly actor: string
  readonly payload: P
  readonly schemaVersion: 1
}

export type TaskEvent = {
  [K in TaskEventKind]: TaskEventEnvelope<K, TaskEventPayloads[K]>
}[TaskEventKind]
