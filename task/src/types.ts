import type { DecompositionAdmission, TaskContract } from './contract.ts'
import type {
  TaskProposal,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalIndex,
  TaskProposalPhaseChange,
} from './proposal.ts'
import type {
  QuestionAnswerRecord,
  QuestionRecord,
  TaskQuestionIndex,
} from './question.ts'

export type TaskId = string
export type RunId = string

export interface ArtifactRef { artifactId: string; kind: string; uri: string; digest?: string }

export type VerificationMode =
  | 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite'

export interface AcceptanceCriterion {              // (§9.2)
  criterionId: string
  description: string
  verificationMode: VerificationMode
  requiredEvidence: string[]
  mandatory: boolean
  command?: string        // required for deterministic|simulation|measurement
  /**
   * Artifact or evidence references (kinds or ids) that must exist in the task
   * store before this criterion can be judged at all (KISS §5.1
   * `requires_artifact`): an ordering constraint declared as an evidence
   * dependency, not a sequence step. Admission validates only the shape
   * (non-empty strings); existence is judged at spawn time by the orchestrator,
   * which settles the child blocked — never spawned — and registers each
   * missing item as an Obligation.
   *
   * Since P4 the match is tightened to a **verified reference product**: the
   * producing run must sit in the verified terminal state and its bundle must
   * carry a passing verdict. A failed or still-running run's same-named product
   * never satisfies the reference. A raw input that need only exist is declared
   * with {@link acceptsArtifact} instead.
   */
  requiresArtifact?: string[]
  /**
   * Artifact or evidence references (kinds or ids) this criterion consumes as a
   * **raw input** (KISS §5.1): existence in the task store is the whole
   * requirement — any run state, verified or not. This is the pre-P4
   * `requiresArtifact` semantics, kept as its own field so a reference that
   * must have been verified ({@link requiresArtifact}) and one that merely must
   * exist are never confused. Judged at spawn time, blocked + Obligation when
   * missing, exactly like `requiresArtifact`.
   */
  acceptsArtifact?: string[]
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent keeps the current behavior: dispatch by
   * `verificationMode` to whichever registered verifier supports it. Present,
   * the id must exist in the verifier registry — an unknown id rejects the
   * whole decomposition batch at admission time (never at spawn time), with
   * the error naming the registered ids.
   */
  verifierRef?: string
  /**
   * The parent-level evidence map (KISS §6 C2, minimal mechanical version):
   * which child of this task — by position in its decomposition batch, the same
   * index vocabulary `dependsOn` uses — this criterion rests on, optionally
   * narrowed to one of the child's criteria and one evidence/artifact
   * reference. The composite verifier judges every entry at parent-acceptance
   * time against the store: the named child must be `verified`, the named
   * criterion (when given) must carry a passing verdict in the child's verified
   * run evidence, and the named reference (when given) must exist there. An
   * incomplete mapping fails the criterion with the missing items named — the
   * "all children verified" conjunction can never stand in for it.
   *
   * Absent (or empty) keeps the current composite behavior exactly. A non-empty
   * map is judged only by the composite verifier, so admission requires
   * `verificationMode: 'composite'` on the criterion that carries it — a
   * declaration no judge reads would be a silent lie — and refuses the
   * combination with `heuristic` (a heuristic judgement is never a mechanical
   * check).
   */
  childEvidence?: ChildEvidenceRef[]
  /**
   * Marks this criterion's judgement as **heuristic** (KISS §5.1): the verdict
   * is explicitly labeled as such wherever it is reported, and it is never
   * counted as a deterministic pass — a natural-language coverage signal can
   * inform a reader but cannot close the criterion mechanically. Mutually
   * exclusive with {@link childEvidence} (admission refuses the combination).
   */
  heuristic?: boolean
  /**
   * The acceptance inputs this criterion's verdict rests on that the executing
   * side must not modify (S1-V slice 2): acceptance scripts, threshold files,
   * fixtures. Callers declare paths; admission resolves each one against the
   * session's checkout and fixes its identity as the SHA-256 of its bytes
   * ({@link ProtectedInputRef}), so the fixed identity — not a later read —
   * is what the contract and its digests describe. Before judging the
   * criterion the verifier registry re-reads every declared input and refuses
   * the verdict — `fail`, naming the path — when one is missing or its bytes
   * changed, so a rewritten acceptance script can never turn a wrong product
   * into a pass. Only declared paths are protected; a criterion that declares
   * none carries no protection and must not be described as protected.
   */
  protectedInputs?: ProtectedInputRef[]
}

/**
 * One protected acceptance input ({@link AcceptanceCriterion.protectedInputs}):
 * the path as declared, plus the SHA-256 of the file's bytes fixed when the
 * task was admitted. The path is resolved against the same checkout directory
 * the criterion's judge runs in, both at admission and at the pre-judgement
 * re-check.
 */
export interface ProtectedInputRef {
  /** The input path as declared, resolved against the run's checkout directory. */
  path: string
  /** SHA-256 (lowercase hex) of the file's bytes at admission. */
  sha256: string
}

/**
 * One entry of a parent criterion's evidence map ({@link
 * AcceptanceCriterion.childEvidence}): a child of the decomposing task, named
 * by its position in the decomposition batch — the only child identity that
 * exists when the parent's criteria are authored, since child task ids are
 * minted by the orchestrator at decomposition time. Existence of the mapping
 * target is an acceptance-time question; admission validates the shape only.
 */
export interface ChildEvidenceRef {
  /** Position of the child in the parent's decomposition batch (0-based). */
  childIndex: number
  /** The child criterion whose passing verdict is required; absent requires only the child's verified state. */
  criterionId?: string
  /** The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence; absent requires only the child's evidence. */
  evidenceRef?: string
}

export type TaskStatus =
  | 'created' | 'admitted' | 'ready' | 'running' | 'blocked'
  | 'verifying' | 'verified' | 'failed' | 'cancelled'
export type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed'

export interface TaskInstance {                     // (§5.2)
  taskId: TaskId
  definitionRef: { taskType: string; version: number }
  parentTaskId?: TaskId
  /**
   * The task's goal: the projection of {@link contract} (or, on a task created
   * before the contract existed, the whole of what the store holds). Never an
   * independent source — the store refuses an event whose projection disagrees
   * with the contract it carries.
   */
  objective: string
  depth: number
  /** The criteria the verifier judges: the projection of {@link contract}, checked for disagreement on write. */
  acceptanceCriteria: AcceptanceCriterion[]
  /** Capability requirements by name: the projection of {@link TaskContract.requiredCapabilities}. */
  requestedCapabilities: string[]
  decompositionStatus: DecompositionStatus
  status: TaskStatus
  runIds: RunId[]
  childTaskIds: TaskId[]
  /**
   * The normalized contract this instance was created from (T1, construction
   * guide §4): defaults filled, criterion ids fixed, assumptions and
   * constraints persisted rather than left in a spawn prompt. Absent on tasks
   * created before the field existed — their contract *is* the three
   * projection fields above, read exactly as before, with nothing invented for
   * the parts the store never held (no assumptions, no constraints, no
   * version).
   */
  contract?: TaskContract
  /**
   * Contract-level marker (KISS §6 C2): this task's acceptance must be decided
   * by its own criteria and evidence map, never by the composite "all children
   * verified" conjunction alone. Admission refuses a creation or decomposition
   * whose task carries the marker while none of its criteria carries a
   * {@link AcceptanceCriterion.childEvidence} map — deleting or never writing
   * the map can never silently degrade the task back to the conjunction.
   * Absent on every task that predates the field; a stored task's criteria are
   * immutable, so the marker is only ever set at creation time.
   */
  requiresIndependentAcceptance?: boolean
}

export interface DependencyEdge { from: TaskId; to: TaskId }  // `from` must verify before `to` starts

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

/**
 * One skill a run's grant was built from, as the admission-time provider
 * pre-check judged it (S1-C item 4). The run *loaded* these bytes — the record
 * is what lets a reader tell which version an execution ran against after the
 * production files have moved on.
 *
 * Identity here is content identity, the same vocabulary the pre-check and the
 * evolution ledger use: `contentDigest` covers the `SKILL.md` bytes plus every
 * declared resource, `contractDigest` the sidecar the provider was validated
 * against. Both are recomputable from the run's own snapshot, which is what
 * makes "is this still the content the run was bound to?" a question a reader
 * can answer instead of trust.
 */
export interface RunSkillBinding {
  /** The skill name a capability granted; the snapshot directory is named after it. */
  name: string
  /** How the pre-check accepted it — execution provider, loadable knowledge, or plain guidance. */
  role: 'execution-provider' | 'knowledge' | 'guidance'
  /**
   * The run's capability rows that grant this skill, sorted: the capability names
   * a worker's summary groups its providers under, read from the record rather
   * than re-derived from the store.
   */
  capabilities: string[]
  /** The purpose the skill declares for itself, so a summary can say what the provider is for without reading its body. */
  description: string
  /** `skillContractDigest` of the sidecar the provider was validated against, or `null` for a skill that declares none. */
  contractDigest: string | null
  /** `skillContentDigest` of the bytes the run loaded. */
  contentDigest: string
  /**
   * Entries of the source skill directory the identity does not cover (a
   * guidance skill's extra files, a directory reads as `name/`). They are not in
   * the snapshot either, so naming them is the honest statement of what this
   * binding does not include; empty for a provider whose identity covers its
   * whole directory.
   */
  uncovered: string[]
}

/**
 * One MCP server a run's manifest granted: the registry key it resolved through
 * and the identity of the template it resolved to. The resolved spec carries
 * machine paths, so the template — the part a deployment edits — is what is
 * digestible; `null` means the registry held no such key, which the spawn then
 * refuses by name.
 *
 * **Diagnostic only.** The digest records what the run *rendered* at bind
 * time; nothing re-reads the registry to compare, so it is not an execution
 * identity and no consumer may treat a matching digest as proof that the
 * server that actually started mounted those bytes. The spawn's own failure is
 * the enforcement for a missing server; a template edited between binding and
 * spawn is not caught here.
 */
export interface RunMcpServerBinding {
  /** The server name the capability declared and the worker's tools are namespaced under. */
  serverName: string
  /** SHA-256 over the registry template the name resolved to, or `null` when the registry holds no such name. Diagnostic (see the interface note): never an execution identity. */
  templateDigest: string | null
}

/**
 * What one run resolved against and loaded (S1-C item 4): the registry revision
 * the admission-time pre-check computed, the identity of every skill the run's
 * grant was built from, the MCP servers its manifest granted, and — when the
 * run loaded content at all — the run-scoped snapshot root those bytes were
 * materialized into.
 *
 * Why it exists next to {@link TaskRun.capabilitySnapshot}: the snapshot names
 * what was granted, this names the *bytes* that were granted. A capability row
 * can be edited, a production `SKILL.md` rewritten, a skill replaced outright;
 * a run that recorded only names cannot say which version it executed, and a
 * reader cannot tell whether the content it can see now is the content the run
 * was bound to.
 *
 * Absent members mean "not bound", never "bound to nothing": a run that loaded
 * no skill carries an empty `skills` list and no `snapshotRoot`, and a field
 * the record does not carry is never invented for it.
 */
export interface RunProviderBinding {
  /**
   * The registry revision the admission-time provider pre-check computed for
   * this run's table and accepted providers (`provider-precheck.ts:registryRevision`):
   * two runs citing the same revision resolved the same rows over the same
   * declared provider content.
   */
  registryRevision: string
  /**
   * Every capability row this run's manifest matched, sorted — including a row
   * that grants no skill (its tools are granted without a provider). The summary
   * a worker reads lists its capabilities from here, so a node that wants to
   * re-decompose or delegate never has to guess a capability name.
   */
  capabilities: string[]
  /**
   * One entry per skill the run's grant was built from, sorted by name. A skill
   * two capabilities declare appears once, naming both.
   */
  skills: RunSkillBinding[]
  /** The MCP servers the run's manifest granted, in first-declaration order. */
  mcpServers: RunMcpServerBinding[]
  /**
   * Absolute path of this run's snapshot skill root — the directory whose
   * `<name>/SKILL.md` entries the worker's skill layer registers — present
   * exactly when the run materialized the content it was bound to. A reader
   * re-checks the bytes there against this record's digests; a missing or
   * changed snapshot is a refusal to report, never a silent fallback to the
   * production path.
   */
  snapshotRoot?: string
}

/**
 * Where one run sits in the A3 coordination protocol. `active` is the phase a
 * run is born in, and the only one in which it may write, decompose or
 * submit; `waiting_children` is a run whose decomposition batch was admitted
 * atomically and whose children have not all settled; `submitted` is a run
 * that handed in a {@link SubmissionRecord} and is waiting for (or inside)
 * verification.
 *
 * The phase — not the run status — is the admission gate: a run in
 * verification still carries status `running`, so `submitted` is what refuses
 * a second submission, a write after the gate closed, and a decomposition
 * admitted too late (A3 §1.2/§2).
 *
 * Absent on every run created before the field existed: such a run's phase is
 * unknown and is never guessed. A non-terminal phase-less run is reported as
 * `needs-recovery` — its only legal continuation is cancellation — and the
 * reducer refuses phase changes for it (A3 §3.6).
 */
export type ExecutionPhase = 'active' | 'waiting_children' | 'submitted'

/**
 * What one run handed in when it submitted (A3 `task_submit_result`, or the
 * runtime settling a parent whose children all reached terminal states): the
 * submitter's own account plus the references it names as proof. Written onto
 * the run by the transition into `submitted`; that phase is terminal for the
 * transition gate, so the record is written once and never overwritten — a
 * late submission is answered from the record, not applied.
 *
 * `origin` keeps a worker's self-report apart from the runtime's automatic
 * one: only `worker` means the run's own agent made the claim.
 */
export interface SubmissionRecord {
  /** What was delivered, in the submitter's words (runtime-generated for an automatic submission). */
  summary: string
  /** The evidence ids, artifact refs, or review refs the submitter names as proof. */
  evidenceRefs: string[]
  /** Anything further a reader should know; absent when the submitter left none. */
  notes?: string
  /** When the submission was recorded — the phase-change event's own timestamp. */
  submittedAt: string
  /** Who submitted: the worker through its explicit call, or the runtime settling the run. */
  origin: 'worker' | 'runtime'
}

/**
 * One no-progress marking on an `active` run (A3 `RunProgressMarked`): the
 * observable record that a worker went idle where a submission was due. It is
 * a diagnostic, not an accumulator — every marking overwrites the previous
 * one, and `rounds` is the caller's own consecutive count, so replay and live
 * observation agree on the last state.
 *
 * Absent on a run that was never marked, on a run whose phase is not `active`
 * (a run waiting on children or on verification is expected to be idle), and
 * on every run written before the field existed.
 */
export interface NoProgressRecord {
  /** The only kind A3 writes. */
  kind: 'unsubmitted-idle'
  /** Consecutive no-progress rounds the caller observed; a positive integer, recorded as given. */
  rounds: number
  /** The run subtree's fact count at marking time — the snapshot-derivable progress measure (A3 §3.5). */
  factCount: number
  /** When the marking was recorded — the event's own timestamp. */
  markedAt: string
}

export interface TaskRun {                          // (§5.3)
  runId: RunId
  taskId: TaskId
  sessionId: string
  parentRunId?: RunId
  capabilitySnapshot: string[]
  agentPreset?: string
  /**
   * What this run was bound to and loaded (S1-C item 4). Absent on every run
   * created before the field existed, and on a run whose caller assembled its
   * plan without an admission-time pre-check: neither loaded content this build
   * can vouch for, and neither is retroactively given a claim.
   */
  providerBinding?: RunProviderBinding
  /**
   * Where this run sits in the A3 coordination protocol. A new run is born
   * `active`, or `submitted` when it has no worker at all (a `spawn: false`
   * replay). Absent on every run created before the field existed; its phase
   * is read as unknown, never defaulted to `active`.
   */
  executionPhase?: ExecutionPhase
  /**
   * The decomposition batch this run waits on, `b-<parentTaskId>` — the
   * deterministic id a run records when it enters `waiting_children`. The
   * parent decomposes once (the phase gate refuses a second batch), so the id
   * needs no minted uniqueness. Absent on a run that never admitted a batch.
   */
  batchId?: string
  /**
   * What this run handed in, written by the transition into `submitted`.
   * Absent on a run that has not submitted; its presence is what makes a
   * second submission a refusal rather than an overwrite.
   */
  submission?: SubmissionRecord
  /**
   * The A3 question-id mount point, kept readable and never written again
   * (A4): the store's question records are the one durable source of what a run
   * waits on, and a second index that could disagree with them is what A4 took
   * out of the write shape. The reducer still carries the field when an old
   * record carries it, so a store written by A3 opens with the snapshot it had,
   * and a new phase change carrying it is refused by name.
   */
  pendingQuestionIds?: string[]
  /** The A3 blocking-question mount point, kept readable and never written again; see {@link pendingQuestionIds}. */
  blockingQuestionIds?: string[]
  /**
   * The last no-progress marking on this run (A3). Overwritten by each
   * `RunProgressMarked`; absent until a caller marks one, and on every run
   * written before the field existed.
   */
  noProgress?: NoProgressRecord
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  status: RunStatus
  startedAt: string
  finishedAt?: string
}

export interface VerificationResult {
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  /**
   * The version of the registered verifier instance that produced this verdict
   * (S1-V slice 2, KISS §8.2): stamped by the verifier registry from the
   * instance it actually dispatched to — never from the criterion's own text
   * or from the verifier's returned object. Absent when the registered
   * instance declares no version, and on verdicts written before the field
   * existed; a later version change never rewrites historical verdicts.
   */
  verifierVersion?: string
  command?: string
  exitCode?: number
  logRef?: string       // path relative to verifier evidenceRoot, never absolute
  details?: string
  /**
   * Which side an `inconclusive` verdict belongs to (KISS §4.3's UNKNOWN
   * split): `task` when the check never ran (timeout, the command never
   * started) — the criterion was never tested; `verifier` when the judge
   * itself is broken (the verifier threw, or none supports the mode). Absent
   * on pass/fail and on a by-design inconclusive (a review criterion awaiting
   * a human). Confusing the two kinds makes the system re-test the same thing
   * forever, so the orchestrator's feedback text keeps them apart.
   */
  unknownKind?: 'task' | 'verifier'
}

export interface EvidenceClaim {                    // (§10)
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

export interface TaskHandoff {                      // (§18)
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

export interface CapabilityManifest {               // (§11–12)
  capabilities: Record<string, {
    skills: string[]
    /** Real DSH tool names the capability grants: labels are expanded when the manifest is resolved. */
    tools: string[]
    preset?: string
    permission?: string
    /**
     * MCP server names the capability grants, resolved against the task
     * runtime's server registry at admission and mounted per worker at spawn
     * (`mcp__<server>__<tool>` on the worker's own tool layer). Absent = none.
     */
    mcpServers?: string[]
  }>
  missing: string[]
  closure: 'closed' | 'partial' | 'gap'
}

/** The terminal outcome one run (or a child blocked before its run ever started) settled in. */
export type ReviewOutcome = 'verified' | 'failed' | 'cancelled' | 'blocked'

/**
 * One criterion's verdict as the verifier reported it, copied onto the review
 * record so a reader sees what was checked — command and exit code included —
 * without replaying the run or opening the evidence bundle.
 */
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
  /**
   * Which side an inconclusive verdict belongs to, copied from the verifier
   * result so a review reader (and the E3 escalation signal) can tell "the
   * check never ran" (`task`) from "the judge is broken" (`verifier`) without
   * reopening the evidence bundle.
   */
  unknownKind?: 'task' | 'verifier'
}

/** One dependency whose outcome kept a blocked task from ever starting a run. */
export interface ReviewBlocker {
  taskId: TaskId
  /** The dependency's task status at the moment this task settled blocked. */
  outcome: TaskStatus
}

/**
 * The four token buckets a session's `tokenUsage` projection reports, copied
 * verbatim from that projection's wire view (upstream
 * `llm/token-meter/src/usage-projection.ts:117-150`). Cumulative for the whole
 * session, not for one run — see {@link ReviewMetrics.tokens}.
 */
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
export interface OutcomeCorrectnessFacts {
  outcome: ReviewOutcome
  /** Criteria the record carries a verdict for; 0 when the verifier never reported. */
  criteriaCount: number
  /** Ids of the criteria whose verdict was not `pass`. */
  unmetCriterionIds: string[]
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
export interface TaskSpecificationFacts {
  /** Whether the objective has non-whitespace content. */
  objectivePresent: boolean
  /** The task's acceptance criteria count. */
  criteriaCount: number
  /** How many of them declare a `command`. */
  criteriaWithCommand: number
}

/** One criterion's declaration shape, as authored on the task (not the verifier's verdict). */
export interface AcceptanceCriterionShape {
  criterionId: string
  mode: VerificationMode
  /** Whether the criterion declares a `command` to run. */
  hasCommand: boolean
  mandatory: boolean
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
export interface AcceptanceFacts {
  criteria: AcceptanceCriterionShape[]
}

/**
 * Dimension 4, decomposition quality: the position and shape of this task in
 * the decomposition tree at review time.
 *
 * Limitation: shape only. Whether the split was a *good* split is not derivable
 * from depth, child count, or edge count, and no threshold is applied to any of
 * them.
 */
export interface DecompositionFacts {
  depth: number
  decompositionStatus: DecompositionStatus
  childCount: number
  /** Dependency edges whose target is this task (must verify before it starts). */
  incomingEdges: number
  /** Dependency edges whose source is this task (it must verify before they start). */
  outgoingEdges: number
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
export interface CapabilityCoverageFacts {
  /** The manifest's closure verdict: `closed` when nothing required was missing. */
  closure: CapabilityManifest['closure']
  /** Flattened skills+tools of the resolved manifest — exactly the list a run records in its `capabilitySnapshot`. */
  granted: string[]
  /** Required capability names the registry could not grant. */
  missing: string[]
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
export interface SkillFitFacts {
  /** Skill names the run's capabilities granted. */
  granted: string[]
  /** Skill names the session's `skill` calls loaded, deduplicated and sorted; absent when no log was readable. */
  loaded?: string[]
  /** Loaded skill names outside `granted`; empty means every load was covered by the grant. */
  loadedOutsideGrant?: string[]
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
export interface ToolFitFacts {
  /** Real DSH tool names the run's capabilities granted (labels expanded at admission). */
  granted: string[]
  /** Tool names the session shows being called, with counts; absent when no log was readable. */
  called?: ReviewToolCall[]
  /** Called names outside `granted` ∪ `workerBaseline()`; empty means every call was covered. */
  calledOutsideGrant?: string[]
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
export interface ContextEfficiencyFacts {
  /** Whole-session token buckets; the same value {@link ReviewMetrics.tokens} carries. */
  tokens?: ReviewTokenUsage
  /** `compaction/start` events observed in the session log. */
  compactions?: number
}

/**
 * The eight review dimensions (§2.7.3), each carrying mechanically observed
 * facts — never a score, never an LLM judgement, never transcript text. Every
 * member is optional and is omitted, not defaulted, when the data behind it does
 * not exist. A dimension answers "what did the system actually do here", leaving
 * "why" to Diagnosis.
 */
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
export interface ReviewToolCallTotals {
  /** `tool/call` events in the session log. */
  calls: number
  /** `tool/result` events whose payload reports a failure. */
  failures: number
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
export interface ReviewMetrics {
  /**
   * Provider-reported, whole-session token buckets from the session's
   * `tokenUsage` projection. Limitation: the projection folds the entire
   * session, so for the long-lived root session this is a session total, not a
   * per-run figure, and it reads systematically high. Absent when the
   * deployment exposes neither `sessionProjections` nor that key.
   */
  tokens?: ReviewTokenUsage
  /** Session tool traffic; absent when no session log was readable. */
  toolCalls?: ReviewToolCallTotals
  /**
   * Count of human-intervention events in the session log: `approval/asked`
   * plus calls to `hitl_ask` / `hitl_approve` / `ask_user_question`.
   * Limitation: the count is session-scoped, and only `ask_user_question` is a
   * worker tool — `hitl_*` are root tools, so interventions across the whole
   * tree land on the root's record. A worker record showing 0 does not mean no
   * human was involved anywhere in its tree.
   */
  humanInterventions?: number
  /**
   * `TaskStarted` count minus one for this task (`TaskInstance.runIds.length - 1`).
   * Limitation: the current orchestrator has no retry branch, so this is
   * structurally always 0 — a reader must not conclude "it was tried again and
   * did not need to be" from it. Omitted for a runless (blocked) task.
   */
  retries?: number
  /** Criteria on this record that carry a `logRef` — where the evidence for a verdict was written. */
  evidenceLogs?: number
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

/**
 * How sure the diagnoser is of its localized cause. Coarse on purpose
 * (§2.7.3: Review ≠ Judge — a diagnosis explains, it does not score).
 */
export type DiagnosisConfidence = 'high' | 'medium' | 'low'

/**
 * The nine mutation surfaces a proposal may point at (§2.7.6). Frozen now
 * because the P5 Evolution registry consumes this exact vocabulary.
 */
export type ProposalTargetType =
  | 'skill' | 'tool' | 'capability' | 'task_definition' | 'decomposition_policy'
  | 'agent_preset' | 'workflow_policy' | 'verifier' | 'runtime_policy'

/**
 * One structured suggestion a diagnosis raises. In P4 a proposal never
 * executes by itself (§2.7.6: no automatic production changes); it is data
 * for a human or a later Evolution step.
 */
export interface DiagnosisProposal {
  targetType: ProposalTargetType
  targetId: string
  rationale: string
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
export type JudgedDimension =
  | 'task_specification' | 'acceptance' | 'decomposition'
  | 'skill_fit' | 'tool_fit' | 'context_efficiency'

/** Every judged dimension, in the order a report reads them. */
export const JUDGED_DIMENSIONS: readonly JudgedDimension[] = [
  'task_specification', 'acceptance', 'decomposition', 'skill_fit', 'tool_fit', 'context_efficiency',
]

/** One dimension's coarse conclusion. Three values on purpose — this is not a rating scale. */
export type JudgementVerdict = 'adequate' | 'inadequate' | 'unknown'

/** Every judgement verdict, for reducer validation and rendering. */
export const JUDGEMENT_VERDICTS: readonly JudgementVerdict[] = ['adequate', 'inadequate', 'unknown']

/**
 * One judged dimension: an agent's (or a person's) conclusion over the facts a
 * `ReviewRecord` carries. Still not a score — `verdict` is a coarse three-way
 * call, `evidenceRefs` names what it rests on, and `rationale` states the
 * reasoning. When the evidence does not settle a dimension the verdict must be
 * `unknown`, never a guess.
 */
export interface ReviewJudgement {
  /** Which dimension this concludes; only the six non-mechanical ones are judgeable. */
  dimension: JudgedDimension
  /** The conclusion: adequate, inadequate, or unknown. */
  verdict: JudgementVerdict
  /**
   * Refs the judgement rests on: evidence ids, the review refs
   * `task_review_pack` prints (`<taskId>#<runId>`, or `<taskId>#no-run`), or
   * session ids. Required and non-empty — a conclusion that cites nothing is
   * not reviewable.
   */
  evidenceRefs: string[]
  /** Why this verdict, in the writer's words. */
  rationale: string
}

/** Who produced a diagnosis, so an agent's judgement is never mistaken for a person's. */
export interface DiagnosisProvenance {
  /** `agent` when a spawned review agent wrote it; `human` for a person. */
  kind: 'agent' | 'human'
  /** The session that produced it, when one did — the id a reader drills into. */
  sessionId?: string
}

/**
 * The core product of review (§2.7.3): an explanation of what a task's
 * reviews show, not a score. Diagnosis lineage is a graph, not a tree
 * (§2.7.4): `reviewRefs` may name several records and `relatedTaskIds` may
 * point across tasks. Written once per `diagnosisId`, immutable afterwards;
 * a task accumulates as many diagnoses as callers record.
 */
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
  /**
   * Who wrote this diagnosis. Absent on records written before this field
   * existed, and on any writer that does not declare itself; absence is read as
   * human-written (the only producer there was).
   */
  producedBy?: DiagnosisProvenance
  /**
   * The six judged dimensions, when the writer made explicit calls. Optional: a
   * diagnosis may explain a cause without judging every dimension, and an
   * all-`unknown` judgement is a legitimate outcome — it says the evidence did
   * not settle the dimension, which is itself information.
   */
  judgements?: ReviewJudgement[]
}

/**
 * One structured record of what is still missing (KISS §2/§5): an Obligation
 * is a question, not an action — `goal` names the gap, `criterion` says how its
 * satisfaction would be judged, and `sourceTaskId` names the task whose
 * failure, block, or capability gap surfaced it. Recorded, never scheduled:
 * the runtime has no obligation scheduler, so nothing here auto-executes.
 */
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
  /**
   * The store's proposals, indexed for the three questions a review gate asks
   * (§6/§7): by proposal id, by the caller's request key, and by parent task.
   * Root contracts (A0 §2) are in the first two views only: they have no parent
   * task to be indexed under.
   *
   * Optional at the type level because a snapshot is also a shape other code
   * builds by hand (a verifier's selftest store view, a test double), and those
   * literals predate proposals. A snapshot produced by this build's reducer
   * always carries it — empty members included — so an absent index means "this
   * reader cannot see proposals", never "the store holds none"; see
   * {@link TaskProposalIndex}.
   */
  readonly proposals?: TaskProposalIndex
  /**
   * The store's parent/child questions (A4 §F.1), in ask order and by id, each
   * carrying the answers recorded so far. This is the *only* durable source of
   * question blocking: a run's open questions, and which of them block it, are
   * derived from these records (see `question.ts`'s helpers), never from a
   * phase, a run field or a second index.
   *
   * Optional at the type level for the same reason as {@link proposals} — a
   * hand-built snapshot predates questions — and a snapshot produced by this
   * build's reducer always carries it. A reader that cannot see the index must
   * not read it as "no questions": see {@link TaskQuestionIndex}.
   */
  readonly questions?: TaskQuestionIndex
}

export interface TaskEventPayloads {
  /** A task instance enters the store (created status, no runs or children attached). */
  TaskCreated: { task: TaskInstance }
  /** A created task is admitted as a leaf or as decomposable. */
  TaskAdmitted: { decompositionStatus: 'leaf' | 'decomposable' }
  /** A created task is rejected at admission and settles blocked. */
  TaskRejected: { reason: string }
  /** A decomposable task's children are registered and the parent closes as decomposed. */
  TaskDecomposed: {
    childTaskIds: TaskId[]
    /**
     * The batch's content identity and the limits it was admitted under
     * (construction guide §4). Absent for a batch admitted before the
     * normalized contract existed — those children carry no contract either,
     * and nothing is invented for them on read.
     */
    admission?: DecompositionAdmission
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
  /**
   * A running run's coordination phase changes (A3). The transition is the
   * admission gate: `active → waiting_children` when its decomposition batch
   * is admitted atomically, and `→ submitted` when it hands in a submission
   * (explicitly or by runtime settlement). Replaying the store reconstructs
   * exactly one path through {@link ExecutionPhase}, so a second submission, a
   * decomposition admitted after the gate closed, and any late phase write are
   * refused by the phase alone — the run status stays `running` through
   * verification and cannot serve as that gate.
   *
   * A refused transition applies nothing: the reducer validates the whole
   * payload before the run is touched.
   */
  RunPhaseChanged: {
    phase: ExecutionPhase
    /** The batch a `waiting_children` run waits on (`b-<parentTaskId>`); required for that phase and refused elsewhere. */
    batchId?: string
    /** The record a `submitted` run hands in; required for that phase and refused elsewhere. */
    submission?: SubmissionRecord
    /**
     * The A3 question-id mount point, readable for old records only: the
     * reducer still shape-checks and carries it, so a store written before A4
     * replays to the same snapshot, while this build's write entries refuse a
     * phase change that carries it — what a run waits on comes from the
     * question facts ({@link QuestionRecord}), not from the phase.
     */
    pendingQuestionIds?: string[]
    /** The A3 blocking-question mount point, readable for old records only; same handling as `pendingQuestionIds`. */
    blockingQuestionIds?: string[]
    /** The caller's account of the transition, when a reader needs one. */
    reason?: string
  }
  /**
   * A run was observed idle without submitting (A3): the no-progress record a
   * reader shows before the budget stops a stuck run. Only an `active` run
   * accepts a marking — a run waiting on children or on verification is
   * expected to be idle, and marking it would count a legitimate wait as
   * stagnation. `rounds` is the caller's consecutive count; the reducer
   * records the number it is given and never accumulates, so replay agrees
   * with live observation.
   */
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
  /**
   * A child run asks its direct parent task a question (A4, plan §F.1). The
   * record is the durable half of the exchange — the question's identity, the
   * asking and answering runs, the citation of the body, the delivery's
   * messageId, the request key and the content digest — and it is deliberately
   * not the body: the text lives in the asking Session's own `tool/call` event,
   * which {@link QuestionRecord.questionRef} names. Several questions may be
   * open on one run, and a run with a blocking one stops its blocked work
   * without any phase change: the blockage is derived from these records.
   *
   * The reducer is the gate. It re-derives the id from the child run and the
   * key, requires the envelope to name that run, the child's task and its
   * parent task, requires both runs to be running, requires the asking task to
   * have a direct parent (a root or parentless replay task has none to ask, and
   * the reducer refuses by name rather than inventing one), requires the cited
   * Session to be the asking run's own, and refuses a second question under one
   * id — a repeated request is answered from the stored record by the entry,
   * never by a second event.
   */
  QuestionAsked: { question: QuestionRecord }
  /**
   * A parent run answers one of its children's questions (A4, plan §F.1). The
   * answer is its own event, appended to the question's record: an open
   * question accepts several answers (a partial one, then a resolving one), and
   * `resolves` is the parent's declaration that this question is answered —
   * `false` leaves it open, and the framework neither classifies the answer nor
   * treats it as a contract or permission change.
   *
   * The reducer re-derives the answer id from the question and the key, refuses
   * an answer whose run is not the run the question was asked of (a wrong
   * parent, including one of a restarted run), refuses a question that is
   * already resolved or whose child or parent run has settled (a late answer
   * neither revives a run nor leaves a new fact), requires the envelope and the
   * cited Session to be the answering run's own, and refuses a second answer
   * under one id.
   */
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
  /**
   * A proposal enters the store (T2/T3, construction guide §6; root contracts
   * A0 §2): one immutable submission with the policy it was born under, the
   * complete normalized contracts it proposes, the limits it was admitted
   * under, the resolution it was reviewed against, and both context
   * fingerprints. The batch content is what a reviewer reads and an approval
   * covers, so it is stored here rather than referenced: a waiting proposal, a
   * rejected one, or a re-opened store renders it from saved facts. A proposal
   * is born `ready` under policy `off` (the batch runs without a human review,
   * and the record says so) or `pending_review` under policy `all`; the reducer
   * refuses a record that claims the other combination, refuses a payload that
   * disagrees with the identity it accompanies (length, order, contract digest,
   * dependencies, flags — or, for a root contract, a contract that is not the
   * one the identity digests), and refuses a proposal whose digests do not
   * match the content they claim to describe. Nothing is admitted, no child
   * exists, and no parent is marked decomposed by this event — a proposal is a
   * question, not work.
   *
   * The record is discriminated by `kind` (`decomposition`, the batch shape
   * above, or `root`, a single root contract for a root session); an absent kind
   * is a decomposition proposal, which is what every record written before the
   * field existed is. A root contract has no parent task, so its events carry
   * the reserved `ROOT_PROPOSAL_TASK_ID` marker on the envelope instead — never
   * a real task id, and a decomposition proposal's events may never carry the
   * marker.
   */
  TaskProposalSubmitted: { proposal: TaskProposal }
  /**
   * A human review decision (T2/T3, §6): approved, rejected, cancelled or
   * expired, bound to the dossier digest and both context fingerprints shown
   * when it was taken. The reducer refuses a decision whose digests disagree
   * with the stored proposal and one that is not legal from the proposal's
   * current status — so an approval can never travel to a revision, a
   * re-resolution or a re-checked context, and a later approval of a batch
   * whose parent run has ended is written as `expired` (an invalidation)
   * rather than as an approval nobody could dispatch.
   */
  TaskProposalDecided: TaskProposalDecisionClaim
  /**
   * A runtime-driven proposal phase change (T2/T3, §6): to `pending_review`
   * when the deployment tightens to `all` while a policy-off proposal is still
   * un-admitted (only tightening is allowed; a waiting proposal is never
   * released), to `ready` when an approval passed its post-approval re-check,
   * and to `stale` when that re-check found the context or the parent state
   * changed. The reducer checks the change against the status table — a
   * re-review of a proposal already awaiting review, a re-check pass without an
   * approval, and a stale marking of an admitted batch are all refused.
   */
  TaskProposalPhaseChanged: TaskProposalPhaseChange
  /**
   * A proposal is consumed (T2/T3, §6; root contracts A0 §2): what it asked for
   * now exists, bound to the ids this event carries. For a decomposition batch
   * that means the child task ids and the batch id, written in the same commit as
   * the children, the decomposition record and the parent run's `active →
   * waiting_children` change (A3 `admitBatchIn`), so a crash after admission is
   * recovered from the log alone — "this proposal was consumed and these are its
   * tasks" is one durable fact, never a second batch. For a root contract it
   * means the one root task and root run the activation minted, written in the
   * same commit as both (`admitRootProposalIn`), so the same crash is recovered
   * the same way and never mints a second root. The reducer refuses a second
   * consumption of one proposal, a consumption whose digests do not match what
   * was approved, a batch consumption whose batch id or child ids do not match
   * what the store holds, and a root consumption naming anything but the store's
   * one parentless task and its own born-active root run.
   */
  TaskProposalAdmitted: TaskProposalConsumption
}

export type TaskEventKind = keyof TaskEventPayloads

export interface TaskEventEnvelope<K extends TaskEventKind, P> {
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
