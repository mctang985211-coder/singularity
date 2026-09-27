import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentOptions, WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  DependencyEdge,
  EvidenceBundle,
  ReviewBlocker,
  ReviewCriterion,
  ReviewDimensions,
  ReviewMetrics,
  ReviewOutcome,
  ReviewTokenUsage,
  ReviewToolCall,
  RunId,
  RunProviderBinding,
  RunStatus,
  SubmissionRecord,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskService,
  TaskSnapshot,
  TaskStatus,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { blockingQuestionsOf } from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, resolvePermission, resolvePreset, workerBaseline, type CapabilityConfig, type PermissionSpec } from './capability.ts'
import { drainSession } from './gate.ts'
import type { ExecutionGate, JobsView } from './gate.ts'
import { owedQuestionMessagesTo, releaseAskingSessions } from './question.ts'
import type { ProviderPrecheck } from './provider-precheck.ts'
import { providerRefusals } from './provider-precheck.ts'
import { checkRunStart, countSubtreeFacts, hasRootLimits, resolveRootBudget, runDeadlineMs } from './root-budget.ts'
import type { RootBudgetConfig } from './root-budget.ts'
import { describeOwner, releaseLayer } from './workspace.ts'
import type { WorkspaceOwner, WorkspaceRegistry } from './workspace.ts'
import { bindRunProviders } from './run-binding.ts'
import { manifestMcpServers, resolveMcpServerSpecs, type McpEnvBinding } from './mcp-servers.ts'
import { buildHandoff } from './handoff.ts'
import { openProposalOf } from './proposal.ts'

/** Raised when the verifier service (ticket C2) is not loaded in the context. */
export class VerifierUnavailableError extends Error {
  override name = 'VerifierUnavailableError'
}

export interface ChildOutcome {
  taskId: TaskId
  runId?: RunId
  status: 'verified' | 'failed' | 'blocked' | 'cancelled'
  /**
   * The evidence bundle the run left, named whatever its verdict — the store has
   * one settlement path since A3, so a failed run whose criteria were judged
   * carries the bundle that judged them exactly as a verified one does. Absent
   * when the run produced none (a spawn refusal, a run that never started).
   */
  evidenceId?: string
}

/**
 * One ended batch's result, handed to the Session that was waiting for it (K1
 * §2): the batch's identity, the run whose wait it ends, the Session it goes to,
 * and the body the store's own facts render to.
 *
 * Both halves are *derived*, never minted: the identity is
 * `m-batchend-<batchId>` ({@link batchEndMessageId}) and the body is rendered
 * from the members' terminal states and evidence
 * ({@link batchEndMessageText}), so the delivery this process performs, a
 * re-delivery after a restart and a recovery pass all state one message — and
 * the target Session's own fold, never a ledger here, decides whether it is
 * already present.
 */
export interface BatchResultMessage {
  readonly storeId: string
  readonly runId: RunId
  readonly batchId: string
  /** The parent's own Session: the target of the message and the Session it is sent from. */
  readonly sessionId: string
  readonly messageId: string
  readonly text: string
}

/**
 * What one end-of-batch delivery settled as. `unavailable` and `refused` are
 * reported, never fatal; `skipped` is a delivery that was deliberately not
 * attempted — the run the message addressed is no longer running, and a terminal
 * run is not woken (K1 §2: 绝不唤活终态). A skipped delivery has zero side
 * effects, and unlike `unavailable` it is not retried: the fact it would point
 * at is moot for a run that already settled.
 */
export type BatchResultDeliveryStatus = 'delivered' | 'already-present' | 'unavailable' | 'refused' | 'skipped'

export interface SpawnChildRequest {
  sessionId: string
  name: string
  agentPreset?: string
  /** Permission preset the child session is switched to (capability-granted; absent keeps the default posture). */
  permissionPreset?: string
  /** Capability-derived authorization the agent runtime applies before the worker is published. */
  grant?: WorkerGrant
  /**
   * Marks the child as a task worker of this runtime (A2): the agent runtime
   * installs the stable worker policy section and the default kickoff, and the
   * context assembly injects the child's contract and state from the store —
   * this request carries no prompt and no contract text of its own, because a
   * spawn prompt is a surface a fold can shadow and the store is the authority.
   */
  taskWorker?: boolean
  /**
   * The working directory the child's session starts in. Absent inherits the
   * caller's own cwd, which is what every ordinary run does; the orchestration
   * names one when its sessions work somewhere else ({@link
   * OrchestrateEnv.workerCwd}).
   */
  cwd?: string
  /**
   * The model selection the child's agent is created under, replacing the
   * deployment's own default for this worker alone (`AgentRuntime.spawn` merges
   * it over `agentDefaultModel.currentSelection()`). A replay carries the
   * experiment's frozen selection here (S4-E §Q3) and the sub-execution it
   * spawns inherits it ({@link OrchestrateEnv.agentOptions}).
   */
  agentOptions?: AgentOptions
  signal?: AbortSignal
}

/**
 * One task run's resource budget (KISS §5 "预算即法律": any exhaustion forces
 * the exit, never a silent degradation). Every member is optional; the runtime
 * resolves its shipped defaults per key.
 *
 * What the orchestrator can honestly enforce is bounded by what it can observe
 * of an in-flight run — and that is only the wall clock (it awaits the
 * worker's idle) plus, at terminal time, one best-effort read of the run's
 * session log and token projection ({@link OrchestrateEnv.observeSession}):
 *
 * - `wallTimeMs` — **enforced in flight**: the worker wait races the deadline;
 *   on exhaustion the agent is cancelled and the run settles failed with
 *   `budget exhausted: wallTimeMs (...)`, named as a budget exhaustion, not a
 *   criteria failure. The same clock bounds the run a batch settles on its worker's
 *   behalf: a parent whose deadline has already passed is cancelled instead of
 *   ended (`finishBatch`), so no run is reported `verified` after the
 *   clock that was supposed to stop it.
 * - `maxToolCalls` — **post-hoc check only**: the session log is readable only
 *   once the run has settled, so a breach lands as an anomaly on the terminal
 *   review record (the verdict stands — the evidence is real). It is never
 *   presented as in-flight enforcement.
 * - `tokens` — **post-hoc check only**: same terminal seam, and the runtime
 *   ships no default for it — the only observation is the whole-session
 *   cumulative projection, systematically high for a long-lived root session,
 *   so no honest constant exists. Configured, a breach is annotated the same
 *   way.
 * - `attempts` — **declared, not enforced**: the orchestrator has no retry
 *   branch (guide §3.1 Non-Goals), so a run-count cap has nothing to gate; the
 *   field ships with the rest so the retry branch has its knob when it lands.
 */
export interface BudgetConfig {
  maxToolCalls?: number
  tokens?: number
  wallTimeMs?: number
  attempts?: number
}

/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
export interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number
}

/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
export const VERIFY_SAFETY_MARGIN_MS = 15_000

/** Block reason for a child the batch never started because the caller cancelled it. */
const CANCELLED_BEFORE_START = 'cancelled by the caller before this child started'

/**
 * Raw, session-scoped facts the deployment's session services report for one
 * run's session. Deliberately plain data: the cascade never touches cordis, so
 * whoever implements {@link OrchestrateEnv.observeSession} does the reading and
 * name classification, and this module only assembles the record from it.
 *
 * Every member is optional because every read is best-effort: a deployment with
 * no session-query, no projections, or a session the reader cannot load reports
 * `undefined` rather than an empty object, and the corresponding record field is
 * then omitted instead of being written as 0.
 */
export interface SessionObservation {
  /** Whole-session token buckets from the session's `tokenUsage` projection. */
  tokens?: ReviewTokenUsage
  /** Tool traffic the session log shows; absent when no log was readable. */
  tools?: {
    /** One entry per distinct tool name, with its call count. */
    calls: ReviewToolCall[]
    /** How many `tool/result` events reported a failure. */
    failures: number
  }
  /** Skill names the session's `skill` calls loaded, in call order, duplicates preserved. */
  skillCalls?: string[]
  /** Human-intervention events in the session log (`approval/asked` plus the human-facing tools). */
  humanInterventions?: number
  /** `compaction/start` events observed in the session log. */
  compactions?: number
}

/** One record's derived review dimensions and effort metrics, either half possibly absent. */
export interface ReviewEnrichment {
  dimensions?: ReviewDimensions
  metrics?: ReviewMetrics
}

/** The service-supplied seam the cascade runs against (keeps this module free of cordis types). */
export interface OrchestrateEnv {
  task: TaskService
  actor: string
  defaultPreset?: string
  /** Optional preflight: throw when the deployment cannot mount this preset id (unknown or broken). */
  assertPreset?(preset: string): Promise<void>
  /**
   * Optional resolver for permission preset names to their knob bundle (the
   * `permissionPresets` registry's `resolve`). Required to rank and validate
   * capability-declared permissions; absent, the first declared name passes
   * through and the spawn's own `permissionPresets.set` validates it.
   */
  resolvePermissionSpec?(name: string): PermissionSpec
  /**
   * Optional env binding for capability-declared MCP servers
   * (`mcp-servers.ts`): the caller session's graph env, or `undefined` when
   * the session binds none. Consulted only when a manifest declares servers;
   * a declared server with no binding fails the spawn loudly.
   */
  resolveMcpEnv?(): Promise<McpEnvBinding | undefined>
  verifyTimeoutMs: number
  /** The resolved per-run budget; which member is enforced in flight, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  budget?: BudgetConfig
  /**
   * `Config.allowRuntimeDecomposition`, carried to the worker prompt: a `leaf`
   * worker has to be told the door is open before it can walk through it, and a
   * switch-off deployment must not be told otherwise.
   */
  allowRuntimeDecomposition: boolean
  spawn(request: SpawnChildRequest): Promise<AgentHandle>
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  /** Optional tail reader for verifier logs (logRef relative to the verifier's evidence root); absent keeps logTail off failed records. */
  readLogTail?(logRef: string): Promise<string | undefined>
  /**
   * Where a run's bound content is materialized (S1-C, `Config.runBindingRoot`).
   * Absent means this deployment cannot materialize content: a run that selects
   * any skill then fails by name rather than loading a path nothing judged.
   */
  runBindingRoot?: string
  /**
   * Optional session reader for the review record's dimensions and metrics
   * (§2.7.3): one read of a run's session log and token projection. Absent — or
   * a rejection — keeps only the store-derived facts; it can never fail a review.
   */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>
  onRunBound(sessionId: string, binding: { storeId: string; taskId: TaskId; runId: RunId }): void
  /**
   * The runtime's tool-execution gate (A3 §3.3). The orchestration owns the
   * phase of every session it spawns — a worker that has submitted, a parent
   * waiting on its children — and this is where those phases are recorded and
   * where the write drain is run. Required: a deployment that cannot gate its
   * own sessions cannot honestly promise "nothing writes after admission
   * closed", and every caller here has one (the runtime constructs it).
   */
  gate: ExecutionGate
  /**
   * The one-writer-per-workspace registry (A3 §3.4), with the checkout this
   * orchestration's sessions run in ({@link OrchestrateEnv.workspacePath},
   * already normalized by the caller — the registry resolves nothing itself).
   * Both absent means this deployment cannot name a checkout, and ownership is
   * skipped rather than guessed; one without the other is a wiring defect the
   * orchestration reports instead of silently skipping the hold.
   */
  workspaces?: WorkspaceRegistry
  workspacePath?: string
  /**
   * The directory every worker this orchestration spawns starts in, when the
   * checkout it works in is not the one its caller's session inherits. A replay
   * the caller placed in a workspace of its own names it, and its children inherit
   * it the same way an ordinary child inherits its parent's cwd. Absent — the
   * ordinary case — keeps every spawn on the parent session's own cwd.
   */
  workerCwd?: string
  /**
   * The model selection every worker this orchestration spawns is created under,
   * when the run it serves is bound to one. A replay carries the experiment's
   * frozen selection (S4-E §Q3) and its sub-execution inherits it — the same
   * session-level propagation {@link OrchestrateEnv.workerCwd} has, because a
   * comparison whose candidate subtree quietly ran the default model describes
   * something neither side measured. Absent — the ordinary case — keeps every
   * spawn on the deployment's own default selection.
   */
  agentOptions?: AgentOptions
  /**
   * The provider pre-check, for the one case that has no verdict to carry: a
   * batch whose admission happened in an earlier process. A freshly admitted
   * batch carries its verdicts ({@link BatchContext.providers}) and never
   * calls this.
   */
  precheck?(capabilities: readonly string[], cwd: string | undefined): Promise<ProviderPrecheck>
  /**
   * Best-effort owner notification (`agent.followup` on a live session, DSH's
   * tool-jobs notice precedent). A session with no live agent is skipped, and
   * a failing notification never fails the settlement it reports on.
   */
  notify?(sessionId: string, text: string): void
  /**
   * Deliver one ended batch's result to its parent's Session (K1 §2) — the wake
   * that tells the parent it is `active` again, that the workspace is back, and
   * that only its own submission starts its acceptance.
   *
   * The delivery is addressed by the identity the batch derives, so a second
   * call delivers nothing when the target already holds that message: a caller
   * may call this again after a crash, and the runtime's recovery pass calls it
   * for the batches a store still owes. Absent means this deployment has no
   * relay: the batch still ends, and the caller falls back to a plain notice.
   */
  deliverBatchResult?(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>
  /**
   * Observe one run's terminal transition: subscribe, then read the current
   * state, so a run that settled between the caller's last read and the
   * subscription is not missed. Returns the unsubscribe function. The runtime
   * implements this over the task service's `task/change` event.
   */
  watchRun?(storeId: string, runId: RunId, cb: (status: RunStatus) => void): () => void
  /** The root budget in force (`Config.rootBudget`); absent means this deployment sets no root limits. */
  rootBudget?: RootBudgetConfig
  /**
   * No-progress rounds before a worker that went idle without submitting is
   * stopped (`Config.noProgressRounds`). The count is consecutive and derived
   * from the store's own last marking, so it survives a resume.
   */
  noProgressRounds: number
  /** How long a write drain may take before it is reported as unconfirmed (`Config.writeDrainTimeoutMs`). */
  writeDrainTimeoutMs: number
  /** The jobs service the drain kills and waits on; absent means this deployment has no managed jobs. */
  jobs?: JobsView
  /** The agent a run's session currently resolves to, if any — the authorization a jobs call carries. */
  agentFor?(sessionId: string): unknown
  /**
   * Runtime bookkeeping at a run's terminal transition: the gate closes for
   * that session (only coordination tools remain) and the workspace the run
   * held is released. Called once per run this orchestration settles, adopted
   * terminal states included.
   */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void
  /**
   * The runtime's batch-failure seam: every child of the batch that has not
   * reached a terminal state is blocked and the batch's parent run is failed
   * with `reason`. Used for a failure the driver cannot settle from where it
   * stands — verification being unavailable in a *nested* submission is the
   * case it exists for (A3 §3.1, the `VerifierUnavailableError` rule).
   */
  failBatch?(storeId: string, batchId: string, reason: string): Promise<void>
  /**
   * Bring one adopted worker's Session back live under its own identity (A4
   * §F.1) — the runtime's own door into `AgentRuntime.resumeWorkerAgent`, with
   * the run binding, the store-derived gate and the managed-work reconciliation
   * the resume owes. The *authorization* is not passed by the driver: this
   * module rebuilds it from the store with the same helpers the spawn used
   * ({@link resumeAdoptedWorker}), because a driver has nothing to add to it.
   *
   * Absent means this deployment cannot bring a worker back, and a
   * question-waiting run nobody can reach fails by name rather than waiting
   * forever (see {@link resumeAdoptedWorker}).
   */
  resumeWorkerSession?(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume>
}

/**
 * What one request to bring an adopted worker's Session back states: the run
 * the store holds and the authorization rebuilt for it — never a second
 * composition, grant or preset invented by the caller.
 */
export interface AdoptedWorkerResumeRequest {
  readonly storeId: string
  /** The run as the store records it: the identity the resume must reproduce, not a copy the caller may edit. */
  readonly run: TaskRun
  /** The grant rebuilt from the run's manifest and its own binding, exactly as the spawn resolved it. */
  readonly grant: WorkerGrant
  /** The permission preset the spawn admitted the run under; absent = the spawn's own default. */
  readonly permissionPreset?: string
  /** Whether the run's Session was spawned as a task worker. */
  readonly taskWorker: boolean
}

/**
 * What one attempt to bring an adopted worker back settled as (A4 §F.1):
 *
 * - `live` — the same Session is live in this process now (or already was), so
 *   what is owed it can be delivered and its wait can be observed;
 * - `retry` — another owner holds the Session (`ownership-conflict`). Nothing is
 *   taken over, the run keeps its identity, and the wait stays bounded by the
 *   deadline; the next activation retries;
 * - `refused` — the resume could not be established under this identity
 *   (`session-missing`, `session-unreadable`, `binding-mismatch`,
 *   `not-in-graph`, `member-facts-missing`, `takeover-refused`, or a refusal of
 *   the managed-work reconciliation). The caller must walk the run to a terminal
 *   state: an in-flight run nobody can bring back is a dead wait, not a wait.
 */
export type AdoptedWorkerResume =
  | { readonly status: 'live' }
  | { readonly status: 'retry'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }

/**
 * Rebuild the authorization a recovery pass has to state for one run, from the
 * store's own records, and hand it to the deployment's resume door.
 *
 * **Why it is rebuilt here and not remembered:** the spawn's grant is a
 * function of durable facts — the task's manifest in the store, and the run's
 * own provider binding — so the same helpers that resolved it at spawn
 * (`authorizedGrant`, `permissionFor`, `skillRootsForRun`) resolve it again.
 * A grant recorded somewhere and handed back would be a second source of
 * authorization that could drift from the manifest it came from; and a resume
 * states the plane it *would* install so the Session's own durable record can
 * refuse a grant it never ran under.
 *
 * The one thing this cannot rebuild is an overlay the spawn took from the
 * caller rather than from the store — a replay's candidate skill roots
 * (`ReplayOverlay.extraSkillRoots`, A6/S2-R's own subject). What is rebuilt is
 * the run's own binding snapshot, which is what a resumed worker loads its
 * content from; the candidate overlay of an interrupted experiment is not part
 * of the run's record and is not invented here.
 * @param env - the deployment's seam, for the store, the permission registry and the resume door.
 * @param storeId - the store the run belongs to.
 * @param run - the run as the store records it.
 * @returns what the attempt settled as, never a throw for a named refusal.
 */
export async function resumeAdoptedWorker(env: OrchestrateEnv, storeId: string, run: TaskRun): Promise<AdoptedWorkerResume> {
  const resume = env.resumeWorkerSession
  if (resume === undefined) {
    return {
      status: 'refused',
      reason: 'this deployment wires no worker resume, so the Session of an adopted run cannot be brought back',
    }
  }
  let manifest: CapabilityManifest | undefined
  try {
    manifest = (await env.task.snapshotIn(storeId)).capabilities[run.taskId]
  } catch (error) {
    return { status: 'refused', reason: `the store could not be read for its manifest: ${message(error)}` }
  }
  if (manifest === undefined) {
    return {
      status: 'refused',
      reason: `the store holds no capability manifest for task "${run.taskId}", so the composition run "${run.runId}" was spawned in cannot be rebuilt`,
    }
  }
  let grant: WorkerGrant
  let permissionPreset: string | undefined
  try {
    grant = await authorizedGrant(env, manifest, skillRootsForRun([], run.providerBinding))
    permissionPreset = permissionFor(env, manifest)
  } catch (error) {
    return { status: 'refused', reason: `the run's authorization could not be rebuilt: ${message(error)}` }
  }
  return await resume({
    storeId,
    run,
    grant,
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    taskWorker: true,
  })
}

/**
 * One terminal review that just became durable, as {@link
 * RuntimeSettlementEnv.onTerminalReview} hands it to the deployment.
 *
 * The source is named exactly the way a review attempt names one: the task and
 * the run under review, or `null` for a review that carries no run (a task
 * blocked before it ever started). Deriving it from "the latest review" would
 * name a different source the moment a task has two runs, so the fact carries
 * the run the record was written for.
 */
export interface TerminalReviewFact {
  readonly storeId: string
  readonly taskId: TaskId
  readonly runId: string | null
  readonly outcome: ReviewOutcome
}

/**
 * What a *runtime-level* settlement holds — the slice of {@link OrchestrateEnv}
 * that a terminal record, a notification and a workspace release actually read.
 *
 * Why it exists as its own type (A4-5): the paths that settle a batch without a
 * driver (`failBatch`, and the runtime's own fallback for a driver that rejected
 * before it could settle anything) are the very paths whose environment could
 * not be built, and building one only to write a terminal state would leave the
 * settlement as unreachable as the thing that failed. `OrchestrateEnv` satisfies
 * this structurally, so the driver paths are unchanged: there is one
 * {@link settleRunFromRuntime}, one {@link blockUnstartedChildren} and one
 * terminal-record writer, and only the amount of environment handed to them
 * differs.
 */
export interface RuntimeSettlementEnv {
  /** The store's own service — the one writer of the events a settlement records. */
  task: TaskService
  /** The actor those events are attributed to. */
  actor: string
  /** How the run's owner is told, when the deployment has a channel; absent means nothing is sent. */
  notify?(sessionId: string, text: string): void
  /** The session observation the review's dimensions and metrics read; absent keeps the store-derived facts only. */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>
  /** The resolved per-run budget a terminal review records post-hoc breaches against. */
  budget?: BudgetConfig
  /** The one-writer-per-workspace registry, with the checkout to release from ({@link OrchestrateEnv.workspaces}). */
  workspaces?: WorkspaceRegistry
  /** The checkout path the registry is keyed by; both absent means ownership is skipped rather than guessed. */
  workspacePath?: string
  /** Called once per terminal transition: the runtime closes the gate here and releases the run's layer. */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void
  /**
   * Called once per recorded terminal review (A5), *after* the record is durable
   * and never awaited: a settlement hands the fact over and carries on, because
   * what a listener does with it (the review-agent trigger scans the store and
   * may start a reviewer) is not part of settling the run. A listener that fails
   * or was never installed changes nothing about the settlement.
   *
   * The store's `task/change` event would answer a similar question, but it
   * reports every mutation and says nothing about *which* fact arrived; this
   * door names the review that was just recorded, so the trigger does not have
   * to diff snapshots to find it.
   */
  onTerminalReview?(fact: TerminalReviewFact): void
  /**
   * The live process's execution gate, when this settlement has one (A4 §F.1).
   * A settled run ends the *questions addressed to it* — an open question needs
   * both runs running — so the settlement recomputes the asking sessions' blocks
   * from the store ({@link releaseAskingSessions}) and needs the one thing that
   * holds them. Absent means there is no live gate to push onto: a settlement
   * whose caller holds no sessions (a store-level one) has none to release, and
   * the store's own derivation is what the next recovery reads back.
   */
  gate?: ExecutionGate
}

/** Raised when the deployment cannot observe a run's terminal state, so no honest settlement is possible. */
export class RunWatcherUnavailableError extends Error {
  override name = 'RunWatcherUnavailableError'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** One mandatory criterion the verifier did not pass, plus what the verifier said about it. */
interface UnmetCriterion {
  criterionId: string
  detail: string
}

/**
 * The KISS §4.3 UNKNOWN split, rendered into the orchestrator's feedback so a
 * reader never mistakes "the criterion was never tested" for "the judge is
 * broken" — confusing the two makes the system re-test the same thing
 * forever. Only an inconclusive verdict carries a kind; pass/fail need none.
 */
function unknownTag(result: VerificationResult): string {
  if (result.status !== 'inconclusive' || result.unknownKind === undefined) return ''
  return result.unknownKind === 'task'
    ? ' [unknown: task — the criterion was never tested]'
    : ` [unknown: verifier — the verifier could not judge] ${escalationHint(
      `the verifier "${result.verifierId}" could not judge criterion "${result.criterionId}"`,
      'the criterion was run and the judge itself failed',
      'fix or replace the verifier, then re-verify the criterion',
    )}`
}

function unmetMandatory(criteria: readonly AcceptanceCriterion[], results: readonly VerificationResult[]): UnmetCriterion[] {
  return criteria.filter(criterion => criterion.mandatory).flatMap(criterion => {
    const result = results.find(item => item.criterionId === criterion.criterionId)
    // KISS §5.1: a criterion explicitly labeled heuristic is judged and labeled,
    // never counted as a deterministic pass — a natural-language coverage signal
    // cannot close a criterion mechanically, whatever verdict a judge returned.
    if (criterion.heuristic === true) {
      return [{
        criterionId: criterion.criterionId,
        detail: `heuristic judgement${result === undefined ? '' : ` (verdict ${result.status})`} — explicitly labeled heuristic, not counted as a deterministic pass`,
      }]
    }
    if (result?.status === 'pass') return []
    return [{
      criterionId: criterion.criterionId,
      detail: result === undefined ? 'no result' : `${result.status}${unknownTag(result)}${result.details === undefined ? '' : ` (${result.details})`}`,
    }]
  })
}

function failureReason(unmet: readonly UnmetCriterion[]): string {
  return `mandatory criteria not satisfied: ${unmet.map(item => `${item.criterionId} ${item.detail}`).join(', ')}`
}

/** One required artifact reference no store evidence satisfies yet. */
interface MissingArtifact {
  criterionId: string
  ref: string
  /**
   * Which declaration the reference came from: `requires` is a verified
   * reference product, `accepts` a raw input whose existence is the whole
   * requirement. The blocked reason and the registered obligation say which,
   * so a reader knows what would close the gap.
   */
  requirement: 'requires' | 'accepts'
}

/**
 * The artifact references (per criterion) that no store evidence satisfies yet.
 * A reference matches an evidence id, an artifact kind, or an artifact id — the
 * three spellings a contract can name a product by. Judged at spawn time, never
 * at admission: existence needs the store snapshot.
 *
 * The two declarations differ in what "satisfied" means (P4, KISS §5.1):
 * `requiresArtifact` names a **verified reference product** — the producing run
 * must sit in the verified terminal state and its bundle must carry a passing
 * verdict, so a failed or still-running run's same-named product never closes
 * the gap — while `acceptsArtifact` names a **raw input** whose mere existence
 * in the store is the requirement.
 */
function missingRequiredArtifacts(
  criteria: readonly AcceptanceCriterion[],
  snapshot: TaskSnapshot,
): MissingArtifact[] {
  const present = new Set<string>()
  const verified = new Set<string>()
  for (const item of snapshot.evidence) {
    const run = snapshot.runs.find(candidate => candidate.runId === item.taskRunId)
    const refs = [item.evidenceId, ...item.artifacts.flatMap(artifact => [artifact.kind, artifact.artifactId])]
    for (const ref of refs) present.add(ref)
    if (run?.status === 'verified' && item.verifierResults.some(result => result.status === 'pass')) {
      for (const ref of refs) verified.add(ref)
    }
  }
  return criteria.flatMap(criterion => [
    ...(criterion.requiresArtifact ?? [])
      .filter(ref => !verified.has(ref))
      .map(ref => ({ criterionId: criterion.criterionId, ref, requirement: 'requires' as const })),
    ...(criterion.acceptsArtifact ?? [])
      .filter(ref => !present.has(ref))
      .map(ref => ({ criterionId: criterion.criterionId, ref, requirement: 'accepts' as const })),
  ])
}

function missingArtifactReason(missing: readonly MissingArtifact[]): string {
  return `missing required artifacts: ${missing.map(item =>
    `${item.ref} (criterion ${item.criterionId}${item.requirement === 'accepts' ? '; raw input, any run state' : ''})`).join(', ')}`
}

/**
 * The authorization one admitted child runs under, built from its manifest:
 * the tools and skills its matched capabilities declared (labels already
 * expanded at admission), the baseline its worker prompt needs, and whether the
 * mounted preset's own tool plane stays — which it does exactly when a matched
 * capability named its own preset, because a foreign composition's tool names
 * are not ours to enumerate. The MCP plane joins separately:
 * {@link authorizedGrant} binds the manifest's server names to the run's env.
 */
function workerGrant(manifest: CapabilityManifest): WorkerGrant {
  return {
    capabilities: Object.entries(manifest.capabilities).map(([capability, entry]) => ({
      capability,
      tools: [...entry.tools],
      skills: [...entry.skills],
    })),
    baseline: workerBaseline(),
    keepPresetTools: Object.values(manifest.capabilities).some(entry => entry.preset !== undefined),
  }
}

/**
 * The full grant for one spawn: {@link workerGrant} plus the manifest's MCP
 * servers materialized against the run's env binding, plus the skill roots the
 * worker's own skill layer registers before anything else (S1-C: the run's
 * snapshot; a replay's candidate overlay stays in front of it). Throws when a
 * declared server has no binding or its repo is absent from the env — inside the
 * spawn `try`, so the failure walks the run to `failed` with the cause named,
 * the same discipline as a dangling preset.
 */
async function authorizedGrant(env: OrchestrateEnv, manifest: CapabilityManifest, skillRoots: readonly string[] = []): Promise<WorkerGrant> {
  const grant = { ...workerGrant(manifest), ...(skillRoots.length === 0 ? {} : { skillRoots: [...skillRoots] }) }
  if (manifestMcpServers(manifest).length === 0) return grant
  const binding = env.resolveMcpEnv === undefined ? undefined : await env.resolveMcpEnv()
  return { ...grant, mcpServers: resolveMcpServerSpecs(manifest, binding) }
}

/**
 * The skill roots one worker's layer registers, in order: whatever the caller
 * passes first (a replay's candidate overlay, which must win a same-name
 * collision — P2's semantics) and then the run's own snapshot. The snapshot is
 * never conditional on the overlay: a run that bound content loads that content.
 */
function skillRootsForRun(overlayRoots: readonly string[], binding: RunProviderBinding | undefined): string[] {
  return [...overlayRoots, ...(binding?.snapshotRoot === undefined ? [] : [binding.snapshotRoot])]
}

/**
 * Copy the verifier's per-criterion results onto a review record, filling the
 * command from the criterion itself when the result omits it — the record
 * must show what was checked without a trip back into the evidence bundle.
 *
 * The deciding judge travels with the verdict (S1-V slice 2): the registered
 * verifier id and the version of the instance that produced the verdict, so a
 * reader can tell which judge decided, and a later recall can index the
 * verdict by `(verifierRef, version)` (KISS §8.2) without reopening the bundle.
 * Both are optional on the record and omitted when the result carries neither —
 * a verdict written before the fields existed stays readable exactly as before,
 * and nothing is invented for it.
 */
function reviewCriteria(criteria: readonly AcceptanceCriterion[], results: readonly VerificationResult[]): ReviewCriterion[] {
  return results.map(result => {
    const command = result.command ?? criteria.find(item => item.criterionId === result.criterionId)?.command
    return {
      criterionId: result.criterionId,
      verdict: result.status,
      ...(result.verifierId === undefined ? {} : { verifierId: result.verifierId }),
      ...(result.verifierVersion === undefined ? {} : { verifierVersion: result.verifierVersion }),
      ...(command === undefined ? {} : { command }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.logRef === undefined ? {} : { logRef: result.logRef }),
      ...(result.unknownKind === undefined ? {} : { unknownKind: result.unknownKind }),
    }
  })
}

/**
 * The review dimensions and the effort counters for one terminal record,
 * assembled from what the store already holds plus one optional session read.
 *
 * Everything here is a mechanically observed fact: counts, declared modes,
 * names, and raw token buckets. No field is a score, and no derivation applies a
 * threshold or an opinion — §2.7.3 keeps the "why" in Diagnosis. A dimension or
 * counter whose source is missing is left out entirely rather than defaulted to
 * zero, so an absent field always means "not observed" and never "observed as
 * nothing".
 *
 * Best-effort by contract: this runs inside the terminal transition, so any read
 * that fails degrades to an omitted field instead of costing the record.
 */
async function reviewEnrichment(
  env: RuntimeSettlementEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  run: TaskRun | undefined,
  criteria: readonly ReviewCriterion[] | undefined,
): Promise<ReviewEnrichment> {
  try {
    const task = await env.task.taskIn(storeId, taskId)
    const snapshot = await env.task.snapshotIn(storeId)
    const manifest = snapshot.capabilities[taskId]
    const observation = run === undefined || env.observeSession === undefined
      ? undefined
      : await env.observeSession(run.sessionId).catch(() => undefined)

    const grantedSkills = manifest === undefined
      ? undefined
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.skills))].sort()
    const grantedTools = manifest === undefined
      ? undefined
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.tools))].sort()
    /** Granted MCP servers' tool prefix (`mcp__<server>__`): their calls ride the spawn-mounted plane, outside the label/baseline vocabulary. */
    const mcpPrefixes = manifest === undefined
      ? []
      : [...new Set(Object.values(manifest.capabilities).flatMap(entry => entry.mcpServers ?? []))].map(name => `mcp__${name}__`)
    const baseline = workerBaseline()
    const recorded = criteria ?? []
    /** Loaded skill names, deduplicated, and the ones no granted capability covers. */
    const loadedSkills = observation?.skillCalls === undefined ? undefined : [...new Set(observation.skillCalls)].sort()
    const contextEfficiency = observation === undefined || (observation.tokens === undefined && observation.compactions === undefined)
      ? undefined
      : {
        ...(observation.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
        ...(observation.compactions === undefined ? {} : { compactions: observation.compactions }),
      }

    const dimensions: ReviewDimensions = {
      outcomeCorrectness: {
        outcome,
        criteriaCount: recorded.length,
        unmetCriterionIds: recorded.filter(item => item.verdict !== 'pass').map(item => item.criterionId),
      },
      taskSpecification: {
        objectivePresent: task.objective.trim().length > 0,
        criteriaCount: task.acceptanceCriteria.length,
        criteriaWithCommand: task.acceptanceCriteria.filter(item => item.command !== undefined).length,
      },
      acceptance: {
        criteria: task.acceptanceCriteria.map(item => ({
          criterionId: item.criterionId,
          mode: item.verificationMode,
          hasCommand: item.command !== undefined,
          mandatory: item.mandatory,
        })),
      },
      decomposition: {
        depth: task.depth,
        decompositionStatus: task.decompositionStatus,
        childCount: task.childTaskIds.length,
        incomingEdges: snapshot.edges.filter(edge => edge.to === taskId).length,
        outgoingEdges: snapshot.edges.filter(edge => edge.from === taskId).length,
      },
      ...(manifest === undefined ? {} : {
        capabilityCoverage: {
          closure: manifest.closure,
          granted: capabilitySnapshot(manifest),
          missing: [...manifest.missing],
        },
      }),
      ...(grantedSkills === undefined ? {} : {
        skillFit: {
          granted: grantedSkills,
          ...(loadedSkills === undefined ? {} : {
            loaded: loadedSkills,
            loadedOutsideGrant: loadedSkills.filter(name => !grantedSkills.includes(name)),
          }),
        },
      }),
      ...(grantedTools === undefined ? {} : {
        toolFit: {
          granted: grantedTools,
          ...(observation?.tools === undefined ? {} : {
            called: observation.tools.calls.map(call => ({ ...call })),
            calledOutsideGrant: observation.tools.calls
              .map(call => call.name)
              .filter(name => !grantedTools.includes(name) && !baseline.includes(name)
                && !mcpPrefixes.some(prefix => name.startsWith(prefix)))
              .sort(),
          }),
        },
      }),
      ...(contextEfficiency === undefined ? {} : { contextEfficiency }),
    }

    const calls = observation?.tools === undefined
      ? undefined
      : observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    const metrics: ReviewMetrics = {
      ...(observation?.tokens === undefined ? {} : { tokens: { ...observation.tokens } }),
      ...(calls === undefined || observation?.tools === undefined
        ? {}
        : { toolCalls: { calls, failures: observation.tools.failures } }),
      ...(observation?.humanInterventions === undefined ? {} : { humanInterventions: observation.humanInterventions }),
      ...(run === undefined || task.runIds.length === 0 ? {} : { retries: task.runIds.length - 1 }),
      ...(criteria === undefined ? {} : { evidenceLogs: criteria.filter(item => item.logRef !== undefined).length }),
    }

    return {
      dimensions,
      ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    }
  } catch {
    return {}
  }
}

/**
 * Safety net around one verifier call. The verifier holds its own deadline
 * (`timeoutMs` goes down with every call) and kills whatever it started, so
 * this only fires when a verifier ignores its deadline entirely: it gets
 * `timeoutMs + VERIFY_SAFETY_MARGIN_MS` before the cascade gives up on it,
 * marks the run failed, and walks on. The abandoned promise keeps a handler
 * attached — it may still settle (and reject) long after the race is lost, and
 * that must never surface as an unhandled rejection.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, runId: RunId): Promise<T> {
  work.catch(() => {})
  const budgetMs = timeoutMs + VERIFY_SAFETY_MARGIN_MS
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `task-runtime: verification of run "${runId}" timed out after ${budgetMs}ms (verifier deadline ${timeoutMs}ms + ${VERIFY_SAFETY_MARGIN_MS}ms safety margin)`,
    )), budgetMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/** Hand the verifier its own deadline and keep the safety net one margin behind it. */
function verifyWithDeadline(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<EvidenceBundle> {
  return withTimeout(env.verifyRun(storeId, runId, { timeoutMs: env.verifyTimeoutMs }), env.verifyTimeoutMs, runId)
}

/**
 * The L4 exit pointer (KISS §7, VRTC plan phase 3.1), appended to the feedback
 * a root agent reads at each of the three trigger sites. The escalation ledger
 * and its tool live on the root plane (agent-singularity): a card carries a
 * human-approval gate that belongs on the root's tool surface, so the
 * orchestrator only points at the exit — it never calls across planes and never
 * blocks a cascade on a human answer.
 */
export function escalationHint(what: string, tried: string, suggested: string): string {
  return `L4 exit (KISS §7): report this to a human with the escalate tool — what: ${what}; tried: ${tried}; suggested: ${suggested}`
}

/** The forced-exit reason for an in-flight budget exhaustion (KISS §5: named as a budget exhaustion, never as a criteria failure). */
function budgetExhaustedReason(which: string, detail: string): string {
  return `budget exhausted: ${which} (${detail}; this is a budget exhaustion, not a criteria failure) — ${escalationHint(
    'the run cannot finish inside its wall-clock budget',
    'the run was cancelled at the deadline',
    'raise the budget, split the task, or accept the partial result',
  )}`
}

/**
 * The post-hoc half of the budget (see {@link BudgetConfig}): the members the
 * orchestrator cannot observe in flight are checked once, at terminal time,
 * against the run's session observation, and a breach is recorded as an
 * anomaly — never presented as enforcement, never flipping a verdict.
 * Best-effort like the enrichment read: no budget, no reader, or no
 * observation means no annotation.
 */
async function budgetBreaches(env: RuntimeSettlementEnv, run: TaskRun): Promise<string[]> {
  const budget = env.budget
  if (budget === undefined || env.observeSession === undefined) return []
  if (budget.maxToolCalls === undefined && budget.tokens === undefined) return []
  const observation = await env.observeSession(run.sessionId).catch(() => undefined)
  if (observation === undefined) return []
  const breaches: string[] = []
  if (budget.maxToolCalls !== undefined && observation.tools !== undefined) {
    const calls = observation.tools.calls.reduce((sum, call) => sum + call.count, 0)
    if (calls > budget.maxToolCalls) {
      breaches.push(`budget exceeded: maxToolCalls (observed ${calls} tool calls over the limit ${budget.maxToolCalls}; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tool calls than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`)
    }
  }
  if (budget.tokens !== undefined && observation.tokens !== undefined) {
    const tokens = observation.tokens
    const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
    if (total > budget.tokens) {
      breaches.push(`budget exceeded: tokens (observed ${total} whole-session tokens over the limit ${budget.tokens}; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tokens than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`)
    }
  }
  return breaches
}

/** How a spawned worker's wait settled. */
type WorkerSettlement =
  | { kind: 'idle' }
  | { kind: 'aborted' }
  | { kind: 'failed'; reason: string }
  | { kind: 'budget-exhausted' }

/**
 * Await a spawned worker's idle under the caller's abort signal and the run's
 * wall-clock budget. The budget is the one member the orchestrator can enforce
 * in flight: on exhaustion it cancels the agent and reports
 * `budget-exhausted`, and the caller settles the run failed with a budget
 * reason — never a criteria failure (KISS §5: no silent degradation). The
 * losing branch of the race keeps its handlers attached, so a worker that
 * settles after its budget already fired never surfaces an unhandled
 * rejection.
 *
 * The budget is a *reading*, not a number: `remaining` is called for the wait it
 * arms and again whenever that wait elapses, so a timer set under a ceiling a
 * person has since raised cannot cancel a worker the store still allows (K4).
 * A timer that fires under a ceiling that did *not* move reads the same bound
 * again, and that second reading is what cancels — one implementation, so the
 * in-flight stop and the settled-run judgement can never disagree about which
 * limit ran out.
 */
async function awaitWorker(handle: AgentHandle, signal: AbortSignal | undefined, remaining: () => Promise<number>): Promise<WorkerSettlement> {
  const cancel = () => handle.agent.cancel({ kind: 'parent' })
  signal?.addEventListener('abort', cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const idle: Promise<WorkerSettlement> = handle.agent.whenIdle()
      .then((): WorkerSettlement => ({ kind: 'idle' }))
      .catch((error): WorkerSettlement => isAborted(signal) ? { kind: 'aborted' } : { kind: 'failed', reason: message(error) })
    for (;;) {
      const budgetMs = await remaining()
      if (Number.isFinite(budgetMs) && budgetMs <= 0) {
        cancel()
        return { kind: 'budget-exhausted' }
      }
      // `Infinity` is a budget with no bound in force at all: nothing can elapse,
      // so the only two endings are the worker's own behaviour and the abort.
      const branches: Promise<WorkerSettlement | { kind: 'wake' }>[] = [idle]
      if (Number.isFinite(budgetMs)) {
        branches.push(new Promise<{ kind: 'wake' }>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'wake' }), budgetMs)
          if (typeof timer.unref === 'function') timer.unref()
        }))
      }
      const settled = await Promise.race(branches)
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (settled.kind === 'wake') continue
      // An abort that lands as the worker goes idle wins over the idle itself,
      // as it did before the budget branch existed.
      if (settled.kind === 'idle' && isAborted(signal)) return { kind: 'aborted' }
      return settled
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function evidenceRefsFor(env: RuntimeSettlementEnv, storeId: string, runId: RunId): Promise<string[]> {
  return (await env.task.snapshotIn(storeId)).evidence.filter(item => item.taskRunId === runId).map(item => item.evidenceId)
}

/** Run start → terminal transition in ms; the terminal mark just landed, so finishedAt is in the store. */
async function runDurationMs(env: RuntimeSettlementEnv, storeId: string, run: TaskRun): Promise<number> {
  const finishedAt = (await env.task.runIn(storeId, run.runId)).finishedAt
  const end = finishedAt === undefined ? Date.now() : Date.parse(finishedAt)
  return Math.max(0, end - Date.parse(run.startedAt))
}

/** Tail of the first unmet criterion that has a log; a missing reader or log keeps the field off the record. */
async function failedLogTail(env: OrchestrateEnv, unmet: readonly UnmetCriterion[], results: readonly VerificationResult[]): Promise<string | undefined> {
  if (env.readLogTail === undefined) return undefined
  const logRef = unmet
    .map(item => results.find(result => result.criterionId === item.criterionId))
    .find(result => result?.logRef !== undefined)?.logRef
  if (logRef === undefined) return undefined
  try {
    return await env.readLogTail(logRef)
  } catch {
    return undefined
  }
}

/** Options for {@link recordTerminalReview}; a runless (blocked) record omits `run`. */
interface TerminalReviewOptions {
  run?: TaskRun
  localizedCause?: string
  anomalies?: readonly string[]
  relatedTaskIds?: readonly TaskId[]
  criteria?: readonly ReviewCriterion[]
  logTail?: string
  blockedBy?: readonly ReviewBlocker[]
}

/**
 * Every run walked to a terminal state gets exactly one review record, written
 * in the same moment right after the terminal status event — the discipline
 * the run cascade and the replay runner share. The dimensions and effort
 * metrics are derived alongside (§2.7.3) on a best-effort basis — see
 * {@link reviewEnrichment} — and never gate the record itself.
 *
 * The record is durable before anything is told about it: the deployment's
 * listener (A5's review-agent trigger) is handed the fact afterwards and is
 * never awaited, so no settlement waits on a reviewer.
 */
async function recordTerminalReview(
  env: RuntimeSettlementEnv,
  storeId: string,
  taskId: TaskId,
  outcome: ReviewOutcome,
  options: TerminalReviewOptions = {},
): Promise<void> {
  const enrichment = await reviewEnrichment(env, storeId, taskId, outcome, options.run, options.criteria)
  const breaches = options.run === undefined ? [] : await budgetBreaches(env, options.run)
  await env.task.recordReviewIn(storeId, {
    taskId,
    ...(options.run === undefined ? {} : { runId: options.run.runId, sessionId: options.run.sessionId }),
    outcome,
    evidenceRefs: options.run === undefined ? [] : await evidenceRefsFor(env, storeId, options.run.runId),
    anomalies: [...(options.anomalies ?? []), ...breaches],
    ...(options.localizedCause === undefined ? {} : { localizedCause: options.localizedCause }),
    ...(options.relatedTaskIds === undefined || options.relatedTaskIds.length === 0
      ? {}
      : { relatedTaskIds: [...options.relatedTaskIds] }),
    ...(options.run === undefined ? {} : { durationMs: await runDurationMs(env, storeId, options.run) }),
    ...(options.criteria === undefined ? {} : { criteria: options.criteria.map(item => ({ ...item })) }),
    ...(options.logTail === undefined ? {} : { logTail: options.logTail }),
    ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy.map(item => ({ ...item })) }),
    ...(enrichment.dimensions === undefined ? {} : { dimensions: enrichment.dimensions }),
    ...(enrichment.metrics === undefined ? {} : { metrics: enrichment.metrics }),
  }, env.actor)
  // The record is durable: the deployment may now be told about it. Handing the
  // fact over is not waiting for what it does with it (A5) — a listener runs the
  // review agent, a watchdog and a diagnosis on its own time, and none of it is
  // this settlement's business.
  env.onTerminalReview?.({
    storeId,
    taskId,
    runId: options.run?.runId ?? null,
    outcome,
  })
}

/**
 * Refuse a dangling preset before the spawn attempt: when the deployment
 * cannot mount the resolved preset, throw an error naming the preset and the
 * capabilities that granted it — the spawn catch walks the run to `failed`
 * with that cause, so a bad capability table entry can never leave a ghost
 * task.
 */
async function assertPresetUsable(env: OrchestrateEnv, manifest: CapabilityManifest, preset: string | undefined): Promise<void> {
  if (preset === undefined || env.assertPreset === undefined) return
  try {
    await env.assertPreset(preset)
  } catch (error) {
    const grantedBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => (entry.preset === preset ? [name] : []))
    throw new Error(`task-runtime: preset "${preset}"${grantedBy.length === 0 ? '' : ` granted by capabilities [${grantedBy.join(', ')}]`} is not mountable: ${message(error)}`)
  }
}

/**
 * The strictest permission preset a manifest's capabilities declare. Unknown
 * names throw here (through the registry's resolve) so the spawn catch walks
 * the run to `failed` with the cause named — same discipline as
 * assertPresetUsable. Without a spec resolver (test contexts) the first
 * declared name passes through and the spawn's own set() validates it.
 */
function permissionFor(env: OrchestrateEnv, manifest: CapabilityManifest): string | undefined {
  if (Object.values(manifest.capabilities).every(entry => entry.permission === undefined)) return undefined
  if (env.resolvePermissionSpec === undefined) {
    return Object.values(manifest.capabilities).find(entry => entry.permission !== undefined)?.permission
  }
  try {
    return resolvePermission(manifest, env.resolvePermissionSpec)
  } catch (error) {
    const declaredBy = Object.entries(manifest.capabilities).flatMap(([name, entry]) => (entry.permission === undefined ? [] : [name]))
    throw new Error(`task-runtime: permission declared by capabilities [${declaredBy.join(', ')}] is not usable: ${message(error)}`)
  }
}

/* ------------------------------------------------------------------------- *
 * Batch driving (A3 §3.1/§3.2/§3.6/§3.7)
 * ------------------------------------------------------------------------- */

/** Run statuses that end a run: the states a batch adopts instead of driving further. */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['verified', 'failed', 'cancelled', 'blocked'])

function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** Task statuses that end a child — a child in one of these is adopted, never started again. */
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['verified', 'failed', 'blocked', 'cancelled'])

/**
 * The one batch the runtime drives: the parent whose children it admitted, the
 * batch id the store recorded, and the signal that now owns the progress.
 *
 * `signal` is *not* the tool call's own signal. Admission is governed by the
 * caller's signal; from the atomic commit on, the batch belongs to the
 * runtime's per-batch controller (§3.7), so a tool call that returns — or a
 * caller that aborts its own call after the batch was admitted — cannot stop
 * work that is already persisted. Only a cancellation (batch, graph, deadline,
 * unload) reaches this signal.
 */
export interface BatchContext {
  storeId: string
  parentTaskId: TaskId
  parentRunId: RunId
  batchId: string
  callerSessionId: string
  reason: string
  signal: AbortSignal
  /**
   * The coordination call that admitted this batch. The parent's own drain
   * excludes it for the same reason the submission drain does: the call is
   * still in flight while the drain runs, and waiting for it would wait for
   * the drain itself (A3 §3.3).
   */
  excludeCallId?: string
  /**
   * The provider pre-check the batch was admitted under (S1-C). Carried so a
   * fresh admission's verdicts reach each child's run binding instead of being
   * recomputed; a batch re-created by the recovery path has nothing to carry
   * and rebuilds its verdicts through {@link OrchestrateEnv.precheck}.
   */
  providers?: ProviderPrecheck
}

/** One child of an admitted batch, positioned by the parent's own child order. */
interface BatchItem {
  readonly index: number
  readonly taskId: TaskId
  /** Positions (not task ids) of the siblings this child waits for — the edge list mapped back into the batch. */
  readonly dependsOn: readonly number[]
}

/** What one never-started child is told, and by which siblings it is blocked. */
interface BlockReason {
  reason: string
  blockers: readonly { taskId: TaskId; outcome: TaskStatus }[]
}

/** How a spawned worker's wait ended, before the caller settles the run. */
type WorkerObservation =
  /** The run itself reached a terminal state (its own submission, a nested batch, a cancellation written elsewhere). */
  | { kind: 'terminal'; status: RunStatus }
  | { kind: 'aborted' }
  | { kind: 'budget-exhausted' }
  | { kind: 'no-progress'; rounds: number; reason: string }
  | { kind: 'failed'; reason: string }

/**
 * What a wait that only watches the store and the deadline can end as: the
 * three endings {@link awaitWaitingTerminal} decides. Its own type because two
 * callers hand it a different "already terminal" observation — a round's
 * `waitRunSettled` and a batch driver adopting a recovered child's — and both
 * need the same narrowed answer, not the report of a worker whose idle the round
 * was watching.
 */
type WaitingObservation =
  | { kind: 'terminal'; status: RunStatus }
  | { kind: 'aborted' }
  | { kind: 'budget-exhausted' }

/**
 * One batch's children in the batch's own order, with each child's dependencies
 * mapped from task ids back to batch positions: the store is the only source of
 * the batch's shape, so a driver that re-reads it every round (a resumed batch
 * included) reads the same list the admission wrote.
 *
 * The members are the batch's own ({@link batchMembers}), never the parent
 * task's children: a task's children are every batch it ever admitted, and a
 * second batch must be driven as its own batch — positions it names are its own
 * (§4's batch-local index).
 */
function batchItems(memberTaskIds: readonly TaskId[], edges: readonly DependencyEdge[]): BatchItem[] {
  const position = new Map(memberTaskIds.map((taskId, index) => [taskId, index] as const))
  return memberTaskIds.map((taskId, index) => ({
    index,
    taskId,
    dependsOn: edges
      .filter(edge => edge.to === taskId)
      .map(edge => position.get(edge.from))
      .filter((from): from is number => from !== undefined)
      .sort((left, right) => left - right),
  }))
}

/** The latest run the store records for a task, or `undefined` when it has none (never started). */
function latestRun(snapshot: TaskSnapshot, taskId: TaskId): TaskRun | undefined {
  return [...snapshot.runs].reverse().find(run => run.taskId === taskId)
}

function taskOf(snapshot: TaskSnapshot, taskId: TaskId): TaskInstance | undefined {
  return snapshot.tasks.find(task => task.taskId === taskId)
}

/**
 * One child's outcome as the store records it. A child that never reached a
 * terminal state in a settled batch has no outcome to report and is named
 * `failed` — the batch is over, so a still-running child is a defect of the
 * settlement, never evidence of work in progress.
 *
 * `memberTaskIds` names the batch whose outcomes are asked for, and is the only
 * thing that decides whose outcomes are read. A run admits more than one batch
 * (K1) and the task's children are *every* batch's, so there is no default here:
 * a caller either holds the batch's recorded members or it cannot ask this
 * question.
 */
export async function deriveChildOutcomes(
  task: TaskService,
  storeId: string,
  parentTaskId: TaskId,
  memberTaskIds: readonly TaskId[],
): Promise<ChildOutcome[]> {
  const snapshot = await task.snapshotIn(storeId)
  const parent = taskOf(snapshot, parentTaskId)
  if (parent === undefined) return []
  return memberTaskIds.map(taskId => {
    const instance = taskOf(snapshot, taskId)
    const run = latestRun(snapshot, taskId)
    const status = instance?.status
    const evidenceId = run === undefined ? undefined : snapshot.evidence.find(item => item.taskRunId === run.runId)?.evidenceId
    const outcome: ChildOutcome['status'] = status === 'verified' || status === 'failed' || status === 'blocked' || status === 'cancelled'
      ? status
      : 'failed'
    return {
      taskId,
      ...(run === undefined ? {} : { runId: run.runId }),
      status: outcome,
      ...(evidenceId === undefined ? {} : { evidenceId }),
    }
  })
}

/** Best-effort owner notification; a deployment without the seam, or a throwing one, changes nothing. */
function notifyOwner(env: RuntimeSettlementEnv, sessionId: string | undefined, text: string): void {
  if (sessionId === undefined || env.notify === undefined) return
  try {
    env.notify(sessionId, text)
  } catch {
    // A notification is a report, not a step: a deployment whose followup path
    // is broken must not turn that into a failed settlement.
  }
}

/* --- workspace handovers (A3 §3.4) --------------------------------------- */

/** The workspace this orchestration may own, when the deployment names one. */
function workspaceOf(env: RuntimeSettlementEnv): { registry: WorkspaceRegistry; workspace: string } | undefined {
  if (env.workspaces === undefined || env.workspacePath === undefined) return undefined
  return { registry: env.workspaces, workspace: env.workspacePath }
}

function runOwner(storeId: string, taskId: TaskId, runId: RunId): WorkspaceOwner {
  return { kind: 'run', storeId, taskId, runId, since: new Date().toISOString() }
}

function batchOwner(storeId: string, taskId: TaskId, batchId: string): WorkspaceOwner {
  return { kind: 'batch', storeId, taskId, batchId, since: new Date().toISOString() }
}

/**
 * Hand the workspace from the holder that has it to `next`, checking that the
 * holder is the one the caller believes it is.
 *
 * The check is on identity, not on `since`: a handover names the holder that is
 * actually on top, and the registry's stack key includes the instant it was
 * taken — an instant no caller can re-derive later. So the caller states who it
 * expects (`expected`), this reads the actual top, and only an identity match
 * proceeds; a mismatch is a named diagnostic instead of a silent pop, because
 * popping the wrong layer hands the checkout to a writer while another writer
 * still believes it holds it. `undefined` means "no expectation" (a fresh hold).
 */
async function handOverWorkspace(
  env: OrchestrateEnv,
  next: WorkspaceOwner,
  expected: (owner: WorkspaceOwner | undefined) => boolean,
  sessionId: string | undefined,
  what: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const held = workspaceOf(env)
  if (held === undefined) return { ok: true }
  const top = held.registry.ownerOf(held.workspace)
  if (!expected(top)) {
    const reason =
      `workspace ${held.workspace} is not held by the writer ${what} expected: ` +
      `${top === undefined ? 'this process holds no claim on it' : `its holder is ${describeOwner(top)}`}`
    notifyOwner(env, sessionId, `task-runtime: ${reason}`)
    return { ok: false, reason }
  }
  await held.registry.push(held.workspace, top as WorkspaceOwner, next)
  return { ok: true }
}

/** Release one layer the caller knows is on top, reporting — never hiding — a mismatch. */
async function releaseWorkspaceLayer(
  env: RuntimeSettlementEnv,
  owner: WorkspaceOwner,
  sessionId: string | undefined,
): Promise<void> {
  const held = workspaceOf(env)
  if (held === undefined) return
  const { conflict } = await releaseLayer(held.registry, held.workspace, top =>
    top.kind === owner.kind && top.storeId === owner.storeId && top.taskId === owner.taskId
    && top.runId === owner.runId && top.batchId === owner.batchId)
  if (conflict === undefined) return
  // A layer that is no longer on top because this store's ownership moved on is
  // not a disagreement: the settlement and the batch driver can both release the
  // same child's layer, and whichever runs second finds the next holder of the
  // same store on top and has nothing to do. A holder from *another* store is a
  // real disagreement and is reported.
  if (conflict.storeId === owner.storeId) return
  notifyOwner(
    env,
    sessionId,
    `task-runtime: workspace ${held.workspace} was expected to be released by ${describeOwner(owner)}, but its holder is ${describeOwner(conflict)}; the layer is left in place`,
  )
}

/**
 * Hold the workspace for one verifier call: the verification reads the result
 * exclusively, so the run's own hold is handed to a `verifier` layer and
 * released when the call returns (§3.4's stack: run → batch → child run →
 * verifier).
 *
 * A workspace held by *another store*, or by nobody at all while this
 * deployment claims a path, refuses the verification by name: a verifier's
 * commands would otherwise run in a checkout another writer holds, and that is
 * the one thing this rule exists to prevent (§3.4's "the verifier's execution
 * is exclusive too"). The checkout's own store is a different case and is
 * accepted: one store is one tree the runtime serializes, and a *recovery* that
 * rebuilt the stack holds the root's layer while a resumed verification runs.
 *
 * The refusal throws, so the submission's settlement fails the run with the
 * reason on its review record — the same shape every other unverifiable run
 * gets, never a verdict about bytes nothing can vouch for.
 */
async function withVerifierWorkspace<T>(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const held = workspaceOf(env)
  if (held === undefined || env.workspaces === undefined) return await work()
  const top = held.registry.ownerOf(held.workspace)
  if (top === undefined || top.storeId !== storeId) {
    throw new Error(
      `task-runtime: run "${runId}" cannot be verified: its workspace ${held.workspace} is ` +
      `${top === undefined ? 'held by nobody in this process' : `held by ${describeOwner(top)}`}, not by store ${storeId}; ` +
      "a verifier runs only while the run's own store holds the workspace it judges",
    )
  }
  const verifier: WorkspaceOwner = { kind: 'verifier', storeId, taskId, runId, since: new Date().toISOString() }
  await held.registry.push(held.workspace, top, verifier)
  try {
    return await work()
  } finally {
    await releaseWorkspaceLayer(env, verifier, sessionId)
  }
}

/* --- run observation (A3 §3.1) ------------------------------------------- */

/**
 * Wait for one run's terminal status. The subscription is taken first (through
 * {@link OrchestrateEnv.watchRun}, which subscribes and then reads the current
 * state), so a run that settled between the caller's read and this call is
 * reported rather than missed. A deployment without the watcher cannot promise
 * a settlement, and says so by name instead of waiting forever.
 */
export async function waitRunTerminal(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<RunStatus> {
  const current = await env.task.runIn(storeId, runId)
  if (isTerminalRun(current.status)) return current.status
  if (env.watchRun === undefined) {
    throw new RunWatcherUnavailableError(
      `task-runtime: cannot observe run "${runId}" reaching a terminal state: this deployment wires no run watcher, ` +
      'so no honest settlement is possible',
    )
  }
  return await new Promise<RunStatus>(resolve => {
    let settled = false
    const unsubscribe = env.watchRun as NonNullable<OrchestrateEnv['watchRun']>
    const off = unsubscribe(storeId, runId, status => {
      if (settled || !isTerminalRun(status)) return
      settled = true
      off?.()
      resolve(status)
    })
    if (settled) off?.()
  })
}

/** True when the agent behind a handle is mid-turn: idle then means "waiting for the model", not "done". */
function agentIsRunning(handle: AgentHandle): boolean {
  return (handle.agent as unknown as { status?: unknown }).status === 'running'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** How long a batch waits for a settled run's own settlement to finish before adopting the state as it stands. */
const SETTLEMENT_TAIL_WINDOW_MS = 2_000

/** How often that wait re-reads the gate's phase. Short: the tail it waits for is a store write away. */
const SETTLEMENT_POLL_MS = 5

/**
 * Wait for one run to be terminal *and* settled: the status event, and then the
 * in-process settlement that wrote it — whose last act is closing the gate for
 * the run's session.
 *
 * The two are not the same instant, and the gap matters. The terminal status is
 * written before the settlement's review record and before the workspace layer
 * it held comes off the stack, so a batch that adopted the status alone could
 * start its next child into a checkout the previous one has not released yet, or
 * report a batch as settled while a child's record is still being written. The
 * gate is the completion signal because this runtime closes it after the record
 * is in the store (`onRunSettled`); a session the gate knows nothing about is a
 * run this process is not settling (a recovery adoption, a foreign writer) and
 * has nothing to wait for.
 *
 * Bounded: a settlement that never closes the gate is reported and the terminal
 * state adopted as it stands, rather than hanging the batch on it.
 */
async function waitRunSettled(env: OrchestrateEnv, storeId: string, runId: RunId, sessionId: string): Promise<RunStatus> {
  const status = await waitRunTerminal(env, storeId, runId)
  const deadline = Date.now() + SETTLEMENT_TAIL_WINDOW_MS
  for (;;) {
    const phase = env.gate.phaseOf(sessionId)
    if (phase === undefined || phase === 'terminal') return status
    if (Date.now() >= deadline) {
      notifyOwner(
        env,
        sessionId,
        `task-runtime: run "${runId}" is ${status} but its settlement has not closed the gate for session ${sessionId} ` +
        `after ${SETTLEMENT_TAIL_WINDOW_MS}ms; the batch adopts the terminal state as it stands`,
      )
      return status
    }
    await sleep(SETTLEMENT_POLL_MS)
  }
}

/** The reminder a worker that went idle without submitting gets, once per no-progress streak. */
function idleReminderText(run: TaskRun, rounds: number, limit: number): string {
  return (
    `task-runtime: session ${run.sessionId} went idle without submitting its result. If the work is done, call ` +
    `task_submit_result with a summary and the evidence you produced — an idle session is not a completion, and the ` +
    `runtime is counting no-progress rounds (${rounds} of ${limit} before this run is stopped).`
  )
}

/** The stop reason for a worker that never submitted: a budget stop on the no-progress rule, never a criteria verdict. */
function noProgressReason(rounds: number, factCount: number, limit: number): string {
  return (
    `no progress: the worker went idle without submitting ${rounds} time(s) in a row and its subtree gained no new facts ` +
    `(last count ${factCount}); stopped at the no-progress limit of ${limit} round(s) — this is a budget stop on the ` +
    'no-progress rule, not a criteria failure — ' +
    escalationHint(
      'the run stopped producing facts and never called task_submit_result',
      `${rounds} idle round(s) with an unchanged subtree fact count`,
      'split the task further, make the acceptance criteria explicit, or accept the partial result',
    )
  )
}

/**
 * Watch one spawned worker until its run settles, its budget runs out, or its
 * batch is cancelled — the one wait every worker path shares (`runReplayTask`
 * and the batch driver).
 *
 * The three inputs are raced, not sequenced: the store's own terminal state
 * (the submission path, a nested batch, a cancellation written elsewhere), the
 * worker's idle, and the deadline. Idle is *not* completion (A3's core
 * correction): the loop reads the run's phase before deciding what idle means.
 * `waiting_children` and `submitted` mean the run is legitimately waiting, so
 * the idle observation stops and only the terminal state is awaited — marking
 * progress there would count a wait as stagnation. `active` means a submission
 * was due: if the agent is mid-turn the runtime waits (a reminded worker needs a
 * turn to react), otherwise the round is marked and, at the limit, the run is
 * stopped with the no-progress reason.
 *
 * The deadline comes from the run's own persisted `startedAt` through
 * {@link remainingRunMs}: a run resumed in a new process keeps the clock it
 * started with (§3.5, §7.4).
 */
async function observeWorkerRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  handle: AgentHandle,
  signal: AbortSignal | undefined,
): Promise<WorkerObservation> {
  const recorded = waitRunSettled(env, storeId, run.runId, run.sessionId)
  // The race below may take another branch, and a watcher this deployment cannot
  // wire rejects rather than resolving: that rejection is the *other* branch's
  // business (the store read), never an unhandled one.
  recorded.catch(() => {})
  const terminal = recorded.then((status): WaitingObservation => ({ kind: 'terminal', status }))
  // The root's deadline is a store fact and is read *per judgement*, never once
  // per wait (K4): a person who raises the tree's ceiling while this worker is
  // parked must be seen by the very reading that would otherwise end the run, so
  // every bound below comes from a resolution taken at the moment it is applied —
  // and the run's own wall time, which no extension resets, is part of the same
  // reading (`remainingRunMs`).
  const remainingNow = (): Promise<number> => remainingRunMsFromStore(env, storeId, run)
  for (;;) {
    const remaining = await remainingNow()
    if (remaining <= 0) {
      // The deadline had already passed when this wait began, so no waiter will
      // cancel the worker: this does, the same forced exit `awaitWorker` performs
      // when the deadline fires while it is waiting.
      handle.agent.cancel({ kind: 'parent' })
      return { kind: 'budget-exhausted' }
    }
    const settled = await Promise.race([terminal, awaitWorker(handle, signal, remainingNow)])
    if (settled.kind !== 'idle') return settled
    const current = await env.task.runIn(storeId, run.runId)
    if (isTerminalRun(current.status)) return { kind: 'terminal', status: current.status }
    const phase = current.executionPhase
    if (phase === 'waiting_children' || phase === 'submitted') {
      // The worker is not the one who will settle this run: its own batch is
      // running, or its submission is inside verification. So idle observations
      // stop here and no round is marked — but the wait stays bounded the same way
      // the active case is: the run's own deadline and the batch's abort both end
      // it (A3 §3.1's race), because a run that is waiting is still work the tree
      // has to be able to stop.
      return await awaitWaitingTerminal(env, run, () => handle.agent.cancel({ kind: 'parent' }), signal, remainingNow, terminal)
    }
    if (agentIsRunning(handle)) continue
    const snapshot = await env.task.snapshotIn(storeId)
    // The known wait (T2/T3 §6, §7.4): a run whose own batch is waiting for a
    // review — or for the admission its approval authorizes — is idle on
    // purpose. Counting that idle as stagnation would stop a worker for
    // waiting exactly where the protocol told it to wait, so the wait is
    // treated like `waiting_children`: no round is marked, and the run stays
    // bounded by the same limits it always was — its own deadline (what is left
    // of the root's, and any instant its caller placed on it) and the batch's
    // abort. Neither is paused or reset
    // for the review; a review that outlives them ends the run as the budget
    // stop it is, and the proposal is left where it stands.
    //
    // The question wait (A4 §F.1) is the same shape one level down: a worker
    // that asked its parent something unanswered has gone idle *because the
    // protocol is holding it*, so an idle observation is not stagnation and no
    // round is marked. It is bounded by exactly the same limits — the
    // deadline still cancels the run (a block is not a stay of execution), and a
    // batch abort still reaches it — and the question stays on the record as the
    // audit of what was asked. Nothing here opens the write gate: while the
    // question is open the session's own gate refuses everything but
    // coordination, and only the answer's `resolves` recomputes that.
    const knownWait = openProposalOf(snapshot, task.taskId, run.runId) !== undefined
      || blockingQuestionsOf(snapshot, run.runId).length > 0
    if (knownWait) {
      return await awaitWaitingTerminal(env, run, () => handle.agent.cancel({ kind: 'parent' }), signal, remainingNow, terminal)
    }
    const factCount = countSubtreeFacts(snapshot, task.taskId)
    const previous = current.noProgress
    const rounds = (previous?.factCount === factCount ? previous.rounds : 0) + 1
    const note =
      `the worker session went idle without submitting; the subtree holds ${factCount} fact(s), ` +
      `${previous?.factCount === factCount ? `unchanged since round ${previous?.rounds}` : 'a change since the last marking'} ` +
      `(round ${rounds} of ${env.noProgressRounds})`
    await env.task.markRunProgressIn(storeId, task.taskId, run.runId, env.actor, {
      kind: 'unsubmitted-idle',
      rounds,
      factCount,
      note,
    })
    if (rounds >= env.noProgressRounds) {
      return { kind: 'no-progress', rounds, reason: noProgressReason(rounds, factCount, env.noProgressRounds) }
    }
    if (rounds === 1) notifyOwner(env, run.sessionId, idleReminderText(run, rounds, env.noProgressRounds))
  }
}

/**
 * Wait for one run that is *waiting* — its own batch is running, or its
 * submission is inside verification — under the two bounds the active case also
 * runs under: the run's own deadline (`min` of its wall time, what is left of the
 * root's, and the instant a caller placed on it — all measured from its persisted
 * `startedAt`, {@link remainingRunMs}) and the batch's abort. Idle is the one
 * input that stops here, because an idle worker in these phases is expected
 * rather than progress: waiting on the store's terminal state is the only honest
 * observation left, and marking a round would count a legitimate wait as
 * stagnation.
 *
 * The abort is what a batch cancellation rides: a driver parked here without it
 * would leave `cancelBatch` waiting for a settlement nobody produces — the
 * children it never started stay unblocked and the workspace layer stays held —
 * and the unload path would hang behind the same promise.
 *
 * The cancellation is handed in as a callback rather than an `AgentHandle`
 * because the two callers hold different things: the round that started a
 * worker has its handle, while the batch driver adopting a question-waiting
 * child out of a store has only the session id and asks the deployment to
 * resolve the agent (A4 §F.1 — the deadline ends a recovered wait exactly as it
 * ends a live one, so this is one implementation, not two).
 *
 * The deadline is a *reading* ({@link RemainingRun}, resolved from the store at
 * the moment it is applied), and that is what a wait armed here has to keep:
 * when the timer elapses the wait does not conclude that the budget ran out — it
 * reads the ceilings again and only stops the run if the new reading is still
 * exhausted (K4). A ceiling a person raised while the wait was parked therefore
 * lengthens the wait instead of being overridden by a timer armed before it,
 * while the run's own per-run wall time — part of the same reading, and never
 * reset by an extension — ends it exactly as it did.
 */
/** One run's remaining window, resolved afresh: what a judgement made now is based on. */
type RemainingRun = () => Promise<number>

async function awaitWaitingTerminal(
  env: OrchestrateEnv,
  run: TaskRun,
  cancel: (() => void) | undefined,
  signal: AbortSignal | undefined,
  remainingRun: RemainingRun,
  terminal: Promise<WaitingObservation>,
): Promise<WaitingObservation> {
  const stop = (): void => {
    cancel?.()
  }
  if (isAborted(signal)) {
    stop()
    return { kind: 'aborted' }
  }
  signal?.addEventListener('abort', stop, { once: true })
  // The abort is one promise for the whole wait, not one per reading: the wait
  // re-arms itself when a ceiling moves, and a listener per round would pile up
  // against a signal that may never fire.
  const aborted = signal === undefined
    ? undefined
    : new Promise<WaitingObservation>(resolve => {
      signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (;;) {
      const remaining = await remainingRun()
      if (remaining <= 0) {
        // The deadline had already passed when this judgement was made, so no
        // waiter will cancel the worker: this does, exactly as the active branch
        // does.
        stop()
        return { kind: 'budget-exhausted' }
      }
      const branches: Promise<WaitingObservation | { kind: 'wake' }>[] = aborted === undefined ? [terminal] : [terminal, aborted]
      if (Number.isFinite(remaining)) {
        branches.push(new Promise<{ kind: 'wake' }>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'wake' }), remaining)
          if (typeof timer.unref === 'function') timer.unref()
        }))
      }
      const settled = await Promise.race(branches)
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // A wake is not a verdict: the ceilings are read again at the top of the
      // loop, and only that reading ends the wait.
      if (settled.kind !== 'wake') return settled
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

/**
 * The cancellation one session's own agent exposes, when this deployment can
 * resolve it — what the driver needs to end a wait it did not start (A4 §F.1).
 * A deployment that cannot name the agent has no cancellation to hand over, and
 * the wait is still bounded by the deadline that settles the run.
 */
function cancelAgentOf(env: OrchestrateEnv, sessionId: string): (() => void) | undefined {
  const agent = env.agentFor?.(sessionId) as { cancel?: (reason: { kind: 'parent' }) => void } | undefined
  if (agent === undefined) return undefined
  const cancel = agent.cancel
  if (typeof cancel !== 'function') return undefined
  return () => {
    cancel.call(agent, { kind: 'parent' })
  }
}

/**
 * The root's own deadline for the store, when the budget resolves; a missing
 * root start is a refusal to invent one.
 *
 * Every call reads the store: the ceiling is what the store says *now*, and a
 * caller that held one from earlier would keep enforcing a bound a person has
 * since raised (K4). A resolution that fails answers "no deadline", which is the
 * conservative reading for a ceiling nobody can measure — the paths that have to
 * refuse over that case ask the resolver themselves
 * ({@link resolveRootBudget}), rather than reading it out of a missing instant.
 */
async function rootDeadlineOf(env: OrchestrateEnv, storeId: string): Promise<string | undefined> {
  const snapshot = await env.task.snapshotIn(storeId)
  const resolved = resolveRootBudget(snapshot, env.rootBudget ?? {})
  return resolved.ok ? resolved.deadlineAt : undefined
}

/**
 * What is left of the tightest deadline that applies to one run of this
 * orchestration — the one call site of `runDeadlineMs` inside the orchestration,
 * so the rule reads the same everywhere a worker is awaited: the run's own
 * per-run wall time (measured from its persisted `startedAt`, never reset) and
 * what is left of the root's deadline as the store holds it *now*. Either
 * reaching zero is the budget stop {@link observeWorkerRun} acts on.
 */
function remainingRunMs(env: OrchestrateEnv, run: TaskRun, rootDeadline: string | undefined, nowMs: number): number {
  return runDeadlineMs(run.startedAt, env.budget?.wallTimeMs, rootDeadline, nowMs)
}

/**
 * The same window, resolved from the store at the moment of the question: the
 * reading a wait arms itself with, and the reading it takes again when that wait
 * elapses. One function, so "how long may this run still go" has one answer
 * whether it is asked before a race, inside a parked wait, or when a timer fires.
 */
async function remainingRunMsFromStore(env: OrchestrateEnv, storeId: string, run: TaskRun): Promise<number> {
  return remainingRunMs(env, run, await rootDeadlineOf(env, storeId), Date.now())
}

/**
 * The wall-clock bound(s) this orchestration's runs are under, as a terminal
 * record names them: what the deployment's per-run budget allows and — when the
 * caller could resolve it, which only the batch settlement can, `resolveRootBudget`
 * being a store read — the tree's own deadline. Naming every bound in force is
 * deliberate: the record says which limits applied, so a reader knows what to
 * change, while the tightest of them is the one that ended the run
 * (`runDeadlineMs`).
 */
function wallClockBoundsText(env: OrchestrateEnv, rootDeadlineAt?: string): string {
  const perRun = env.budget?.wallTimeMs
  const bounds = [
    ...(perRun === undefined ? [] : [`${perRun}ms from its own startedAt`]),
    ...(rootDeadlineAt === undefined ? [] : [`the root tree's deadline ${rootDeadlineAt}`]),
  ]
  // With nothing else configured, the only bound that can have ended a wait is the
  // root tree's own deadline — read where the reason is built only by the batch
  // settlement, so a worker stop says so without naming the instant.
  return bounds.length === 0 ? 'the root tree\u2019s own deadline' : bounds.join(', or ')
}

/**
 * The wall-clock exhaustion a worker observation is recorded as: the reason
 * shape every budget stop carries (KISS §5 — a budget stop is never reported as
 * a criteria failure), naming the bound(s) this orchestration's runs are under so
 * a reader knows which number to change. A deployment with only its own per-run
 * wall time configured gets exactly the text it always had; one whose run was
 * placed under a caller's deadline sees that instant named, which is the value
 * that actually ended the run.
 */
function wallClockExhaustedReason(env: OrchestrateEnv): string {
  return budgetExhaustedReason('wallTimeMs', `worker run exceeded its wall-clock budget (${wallClockBoundsText(env)})`)
}

/**
 * The reason a batch's parent is cancelled instead of accepted: its run's own
 * deadline had already been reached when every child had settled, and an
 * acceptance after the deadline is one the budget never allowed (§3.5) — the run
 * would be reported `verified` for work the clock had already stopped.
 *
 * The bound is the run's own (`remainingRunMs`: its per-run wall time, what is left
 * of the root's, and any instant its caller placed on it). Every child settling is
 * exactly the moment such a deadline can arrive unnoticed by the parent's own
 * driver — a replayed worker's sub-execution inherits the parent's instant, so the
 * child failing on it is what brings the batch here with the parent's clock already
 * run out — and reading it here is the last moment before the acceptance that would
 * judge the run. Named as a budget stop, never as a criteria failure.
 */
function parentDeadlinePassedReason(env: OrchestrateEnv, rootDeadlineAt: string | undefined): string {
  return budgetExhaustedReason(
    'wallTimeMs',
    `${wallClockBoundsText(env, rootDeadlineAt)} passed before this batch could be accepted, so the parent is cancelled without verification`,
  )
}

/* --- one child, one round (A3 §3.1) --------------------------------------- */

/**
 * What the driver hands to {@link driveChildRound}: the run it just started, the
 * handle it spawned, and what a terminal record needs to name — the task the run
 * belongs to and the siblings its criteria depend on.
 */
interface StartedChild {
  item: BatchItem
  task: TaskInstance
  run: TaskRun
  handle: AgentHandle
  dependencyTaskIds: readonly TaskId[]
}

/**
 * The evidence one child's own submission, verification, or failure left in the
 * store. Read back rather than carried: the store is the truth about a run, and
 * a resumed batch has no memory of a handle it never held.
 */
function childEvidenceId(snapshot: TaskSnapshot, runId: RunId): string | undefined {
  return snapshot.evidence.find(item => item.taskRunId === runId)?.evidenceId
}

/** One child's outcome as the store holds it: the status the run reached and the evidence it left, if any. */
function adoptedOutcome(taskId: TaskId, runId: RunId, status: RunStatus, snapshot: TaskSnapshot): ChildOutcome {
  const evidenceId = childEvidenceId(snapshot, runId)
  return {
    taskId,
    runId,
    status: status as ChildOutcome['status'],
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}

/**
 * Settle one child run from its own state: mark the terminal transition it does
 * not have yet, or adopt the one it already has.
 *
 * The adoption branch is the one that keeps the batch honest about nested
 * work: a child whose own worker decomposed is settled by that nested batch —
 * by the time this runs, its run is already terminal and carries its own review
 * record, so marking it again would be an illegal transition and writing a
 * second review would be a bug the store refuses.
 */
async function settleChildRun(
  env: OrchestrateEnv,
  storeId: string,
  child: { item: BatchItem; run: TaskRun; dependencyTaskIds: readonly TaskId[] },
  verdict: { status: 'verified' | 'failed' | 'cancelled'; localizedCause?: string; anomalies?: readonly string[]; criteria?: readonly ReviewCriterion[]; logTail?: string },
): Promise<ChildOutcome> {
  const { item, run, dependencyTaskIds } = child
  const snapshot = await env.task.snapshotIn(storeId)
  const current = snapshot.runs.find(candidate => candidate.runId === run.runId)
  const status: RunStatus = current?.status ?? run.status
  if (isTerminalRun(status)) return adoptedOutcome(item.taskId, run.runId, status, snapshot)
  try {
    await env.task.markRunStatusIn(storeId, item.taskId, run.runId, verdict.status, env.actor, {
      ...(verdict.localizedCause === undefined ? {} : { reason: verdict.localizedCause }),
    })
  } catch (error) {
    // Two settlement paths can reach one run at once: a child that decomposed in
    // turn is settled by its own nested batch while this driver is cancelling the
    // same child (a batch cancellation aborts both). The store is the arbiter —
    // a run it now holds terminal stands, and this settlement has nothing to add.
    const settled = await env.task.runIn(storeId, run.runId).catch(() => undefined)
    if (settled === undefined || !isTerminalRun(settled.status)) throw error
    return adoptedOutcome(item.taskId, run.runId, settled.status, await env.task.snapshotIn(storeId))
  }
  await recordTerminalReview(env, storeId, item.taskId, verdict.status, {
    run,
    ...(verdict.localizedCause === undefined ? {} : { localizedCause: verdict.localizedCause }),
    ...(verdict.anomalies === undefined ? {} : { anomalies: verdict.anomalies }),
    ...(verdict.criteria === undefined ? {} : { criteria: verdict.criteria }),
    ...(verdict.logTail === undefined ? {} : { logTail: verdict.logTail }),
    relatedTaskIds: dependencyTaskIds,
  })
  env.onRunSettled?.(storeId, item.taskId, run.runId, verdict.status)
  await releaseWorkspaceLayer(env, runOwner(storeId, item.taskId, run.runId), run.sessionId)
  const evidenceId = childEvidenceId(await env.task.snapshotIn(storeId), run.runId)
  return {
    taskId: item.taskId,
    runId: run.runId,
    status: verdict.status,
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}

/**
 * Drive one started child run to its terminal state and adopt it: the batch's
 * per-child half of {@link driveBatch}.
 *
 * Every ending here is named as what it is — a batch abort cancels the child,
 * a deadline is a budget stop, an unsubmitted idle is a no-progress stop, a
 * worker error is a failure. The submission path does not appear as a branch:
 * a run that submitted is settled by {@link settleSubmittedRun} (via the worker
 * whose tool call it was), and this only waits for the terminal state that
 * settlement writes.
 */
async function driveChildRound(env: OrchestrateEnv, batch: BatchContext, child: StartedChild): Promise<ChildOutcome> {
  const { item, task, run, handle, dependencyTaskIds } = child
  const observation = await observeWorkerRun(env, batch.storeId, task, run, handle, batch.signal)
  switch (observation.kind) {
    case 'terminal': {
      const snapshot = await env.task.snapshotIn(batch.storeId)
      const status: RunStatus = snapshot.runs.find(candidate => candidate.runId === run.runId)?.status ?? observation.status
      env.onRunSettled?.(batch.storeId, item.taskId, run.runId, status)
      await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), run.sessionId)
      const evidenceId = childEvidenceId(snapshot, run.runId)
      return {
        taskId: item.taskId,
        runId: run.runId,
        status: status as ChildOutcome['status'],
        ...(evidenceId === undefined ? {} : { evidenceId }),
      }
    }
    case 'aborted': {
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'cancelled',
        anomalies: [`the batch was cancelled while this child ran: ${batch.reason}`],
      })
    }
    case 'budget-exhausted': {
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'failed',
        localizedCause: wallClockExhaustedReason(env),
      })
    }
    case 'no-progress': {
      handle.agent.cancel({ kind: 'parent' })
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'failed',
        localizedCause: observation.reason,
        anomalies: [`no-progress round ${observation.rounds} of ${env.noProgressRounds}`],
      })
    }
    case 'failed': {
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'failed',
        localizedCause: observation.reason,
      })
    }
  }
}

/* --- starting one child --------------------------------------------------- */

/** The outcome of one start attempt: an adopted outcome, or nothing to adopt yet because the child is now in flight. */
type StartAttempt =
  | { kind: 'adopted'; outcome: ChildOutcome }
  | { kind: 'started'; child: StartedChild }

/** Mark one child that never started, and record why — the runless blocked shape the store accepts. */
async function blockChild(
  env: RuntimeSettlementEnv,
  storeId: string,
  item: BatchItem,
  block: BlockReason,
  dependencyTaskIds: readonly TaskId[],
): Promise<ChildOutcome> {
  await env.task.markRunStatusIn(storeId, item.taskId, undefined as unknown as RunId, 'blocked', env.actor, { reason: block.reason })
  await recordTerminalReview(env, storeId, item.taskId, 'blocked', {
    anomalies: [block.reason],
    relatedTaskIds: dependencyTaskIds,
    blockedBy: block.blockers.map(blocker => ({ taskId: blocker.taskId, outcome: blocker.outcome })),
  })
  return { taskId: item.taskId, status: 'blocked' }
}

/** Every child that never started, settled with the same reason — the batch never leaves an admitted ghost behind. */
async function blockUnstarted(
  env: RuntimeSettlementEnv,
  storeId: string,
  snapshot: TaskSnapshot,
  items: readonly BatchItem[],
  why: (item: BatchItem) => BlockReason,
): Promise<ChildOutcome[]> {
  const blocked: ChildOutcome[] = []
  for (const item of items) {
    const task = taskOf(snapshot, item.taskId)
    if (task === undefined || task.status === 'verified' || task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') continue
    if (latestRun(snapshot, item.taskId) !== undefined) continue
    const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
    blocked.push(await blockChild(env, storeId, item, why(item), dependencyTaskIds))
  }
  return blocked
}

/**
 * Block every child of one batch that never started, naming one reason — the
 * runtime-level entry for the paths that settle a batch without a driver
 * (`failBatch`, and the fallback for a driver that rejected before it settled
 * anything).
 *
 * It is {@link blockUnstarted} over the members the caller read from the batch's
 * own record rather than over a `BatchContext` the caller no longer holds, so the
 * *rule* — a child with no run and no terminal state is blocked, one that already
 * ran is left to its own settlement — stays in one place and the runtime's failure
 * seams share it with the driver. The batch's members are passed in, never
 * re-derived from the parent task: a parent task's children are every batch it
 * ever admitted, and this call ends one batch.
 */
export async function blockUnstartedChildren(
  env: RuntimeSettlementEnv,
  storeId: string,
  memberTaskIds: readonly TaskId[],
  reason: string,
): Promise<ChildOutcome[]> {
  const snapshot = await env.task.snapshotIn(storeId)
  return await blockUnstarted(env, storeId, snapshot, batchItems(memberTaskIds, snapshot.edges), () => ({ reason, blockers: [] }))
}

/**
 * Start one child of an admitted batch: every check the batch's admission could
 * not make (the evidence a criterion needs, the run budget that was reserved
 * but not yet charged) plus the run's own record, its content binding, the
 * workspace handover and the spawn.
 *
 * The run is recorded *before* the spawn attempt — the discipline the cascade
 * always had — so a refusal at any of those steps settles a run that exists
 * rather than leaving a child admitted with no way to reach a terminal state.
 * The binding is written before the run is recorded (S1-C), and a batch resumed
 * in a new process rebuilds its provider verdicts here (there is nothing to
 * carry over, and the pre-check is the one honest replacement).
 */
async function startChildRound(
  env: OrchestrateEnv,
  batch: BatchContext,
  parentTask: TaskInstance,
  parentRun: TaskRun,
  items: readonly BatchItem[],
  item: BatchItem,
  snapshot: TaskSnapshot,
): Promise<StartAttempt> {
  const task = taskOf(snapshot, item.taskId)
  if (task === undefined) throw new Error(`task-runtime: batch ${batch.batchId} names child "${item.taskId}", which the store does not hold`)
  const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
  const manifest = snapshot.capabilities[item.taskId]

  // The root budget is checked once per start, from the store's own count: the
  // limit is not resettable by a restart (§3.5). A refusal is monotone — the
  // run count only grows — so it ends the batch instead of being retried. A
  // budget that cannot be resolved only refuses when this deployment configures
  // limits at all: with none, there is nothing to measure and nothing to refuse.
  //
  // Both the ceilings and the count are read here rather than carried in from the
  // round's own snapshot: a refusal here *blocks the child*, so it may not be
  // made against a reading a person has since raised, and the reservation has to
  // count what the store holds when the start is decided (K4).
  const budgetSnapshot = await env.task.snapshotIn(batch.storeId)
  const budget = resolveRootBudget(budgetSnapshot, env.rootBudget ?? {})
  if (!budget.ok) {
    if (hasRootLimits(env.rootBudget)) {
      return { kind: 'adopted', outcome: await blockChild(env, batch.storeId, item, { reason: `the root budget cannot be resolved: ${budget.reason}`, blockers: [] }, dependencyTaskIds) }
    }
  } else {
    const verdict = checkRunStart(budgetSnapshot, budget)
    if (!verdict.allowed) {
      return { kind: 'adopted', outcome: await blockChild(env, batch.storeId, item, { reason: verdict.reason, blockers: [] }, dependencyTaskIds) }
    }
  }

  const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, snapshot)
  if (missingArtifacts.length > 0) {
    const reason = missingArtifactReason(missingArtifacts)
    const blocked = await blockChild(env, batch.storeId, item, { reason, blockers: [] }, dependencyTaskIds)
    for (const missing of missingArtifacts) {
      const verified = missing.requirement === 'requires'
      await env.task.recordObligationIn(batch.storeId, {
        obligationId: `o-${randomUUID()}`,
        goal: `artifact/evidence "${missing.ref}" required by task "${item.taskId}" criterion ${missing.criterionId} does not exist in the task store${verified ? ' as a verified reference product' : ''}`,
        criterion: verified
          ? `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict`
          : `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id)`,
        sourceTaskId: item.taskId,
      }, env.actor)
    }
    return { kind: 'adopted', outcome: blocked }
  }

  if (manifest === undefined) {
    const reason = `capability manifest for child "${item.taskId}" is missing from the store; the run cannot be started without one`
    const blocked = await blockChild(env, batch.storeId, item, { reason, blockers: [] }, dependencyTaskIds)
    return { kind: 'adopted', outcome: blocked }
  }

  const runId: RunId = `r-${randomUUID()}`
  const sessionId = `s-${randomUUID()}`
  const dependencyEvidence = snapshot.evidence
    .filter(evidence => dependencyTaskIds.includes(evidence.taskId))
    .map(evidence => evidence.evidenceId)
  const handoff = {
    ...buildHandoff({
      parentTask,
      parentRun,
      childTask: task,
      reason: batch.reason,
      callerSessionId: batch.callerSessionId,
      assumptions: [
        ...(task.contract?.assumptions ?? []),
        ...dependencyEvidence.map(evidenceId => `dependency evidence "${evidenceId}" is verified and available as a reference`),
      ],
      constraints: task.contract?.constraints ?? [],
      relevantEvidence: dependencyEvidence,
    }),
    // Deterministic on purpose (A3 §1.2): a resumed batch re-enters this start
    // and must recognize the handoff it already wrote instead of minting a
    // second one — the store refuses a duplicate, and skipping is the idempotent
    // answer.
    handoffId: `h-${runId}`,
  }
  if (!snapshot.handoffs.some(existing => existing.handoffId === handoff.handoffId)) {
    await env.task.recordHandoffIn(batch.storeId, handoff, env.actor)
  }

  const agentPreset = resolvePreset(manifest, env.defaultPreset)
  const name = task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `child-${item.index + 1}`
  const run: TaskRun = {
    runId,
    taskId: item.taskId,
    sessionId,
    parentRunId: parentRun.runId,
    capabilitySnapshot: capabilitySnapshot(manifest),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    // Born active (§1.1): this run decides its own work until it submits or
    // decomposes, and the phase is what admits both.
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  let binding: RunProviderBinding | undefined
  try {
    let providers = batch.providers
    if (providers === undefined && env.precheck !== undefined) {
      // A resumed batch carries no verdicts — the process that judged them is
      // gone — so the pre-check is re-run from this run's own viewpoint and a
      // refusal settles this child by name rather than binding unjudged bytes.
      const fresh = await env.precheck(Object.keys(manifest.capabilities), env.workspacePath)
      const refusals = providerRefusals(fresh)
      if (refusals.length > 0) {
        throw new Error(`the provider pre-check refused this run on resume:\n- ${refusals.join('\n- ')}`)
      }
      providers = fresh
    }
    binding = await bindRunProviders({
      storeId: batch.storeId,
      runId: run.runId,
      manifest,
      ...(providers === undefined ? {} : { providers }),
      ...(env.runBindingRoot === undefined ? {} : { root: env.runBindingRoot }),
    })
  } catch (error) {
    const reason = `content binding failed: ${message(error)}`
    await env.task.startRunIn(batch.storeId, run, env.actor)
    return { kind: 'adopted', outcome: await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, { status: 'failed', localizedCause: reason }) }
  }
  const bound: TaskRun = binding === undefined ? run : { ...run, providerBinding: binding }
  // The budget is charged here, before any worker exists: `TaskStarted` is the
  // record `maxRuns` counts, so a crash between this write and the spawn does
  // not refund the slot (§3.5).
  await env.task.startRunIn(batch.storeId, bound, env.actor)

  try {
    await assertPresetUsable(env, manifest, agentPreset)
  } catch (error) {
    return { kind: 'adopted', outcome: await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, { status: 'failed', localizedCause: `spawn failed: ${message(error)}` }) }
  }

  // One writer at a time (§3.4): the batch's hold is handed to this child for
  // as long as it works. A workspace this process does not hold as expected is
  // not handed over silently — the child fails by name before any worker runs.
  const handover = await handOverWorkspace(
    env,
    runOwner(batch.storeId, item.taskId, run.runId),
    top => top !== undefined && top.batchId === batch.batchId,
    sessionId,
    `batch ${batch.batchId}`,
  )
  if (!handover.ok) {
    return { kind: 'adopted', outcome: await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, { status: 'failed', localizedCause: `workspace handover refused: ${handover.reason}` }) }
  }

  let handle: AgentHandle
  try {
    const permissionPreset = permissionFor(env, manifest)
    handle = await env.spawn({
      sessionId,
      name,
      taskWorker: true,
      grant: await authorizedGrant(env, manifest, skillRootsForRun([], binding)),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(env.workerCwd === undefined ? {} : { cwd: env.workerCwd }),
      // What this batch runs *under*, not only where it runs (S4-E §Q3): a child of
      // an experiment's worker is part of the same run of the experiment, so it is
      // created under the same frozen model selection. Absent for every ordinary
      // batch, whose spawns are unchanged.
      ...(env.agentOptions === undefined ? {} : { agentOptions: env.agentOptions }),
      signal: batch.signal,
    })
  } catch (error) {
    await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), sessionId)
    return { kind: 'adopted', outcome: await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, { status: 'failed', localizedCause: `spawn failed: ${message(error)}` }) }
  }
  env.gate.setPhase(sessionId, 'active')
  env.onRunBound(sessionId, { storeId: batch.storeId, taskId: item.taskId, runId: run.runId })
  return { kind: 'started', child: { item, task, run, handle, dependencyTaskIds } }
}

/* --- the batch loop ------------------------------------------------------- */

/** What the driver does between rounds: everything the store says, and nothing it holds in memory. */
async function driveRounds(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  for (;;) {
    const snapshot = await env.task.snapshotIn(batch.storeId)
    const parentTask = await env.task.taskIn(batch.storeId, batch.parentTaskId)
    const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
    // The batch's own members, read from the run's accumulation on every round: the
    // parent task's children are every batch it ever admitted, so a second batch
    // drives (and reports, and blocks) its own children only.
    const members = batchMembers(parentRun, batch.batchId)
    // A parent whose run already settled was settled by somebody else — a
    // cancellation, a batch failure seam, or the driver above this one. The
    // driver stops, and before it does it blocks the children that never started:
    // "the store holds the outcomes" is only true of the children that had a run,
    // and an admitted child with no run would otherwise stay non-terminal forever.
    if (parentRun.status !== 'running') {
      const items = batchItems(members, snapshot.edges)
      await blockUnstarted(env, batch.storeId, snapshot, items, () => ({
        reason: CANCELLED_BEFORE_START,
        blockers: startedBlocker(snapshot, items),
      }))
      return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members)
    }
    const items = batchItems(members, snapshot.edges)
    const pending = items.filter(item => {
      const task = taskOf(snapshot, item.taskId)
      return task !== undefined && !TERMINAL_TASK_STATUSES.has(task.status)
    })
    if (pending.length === 0) return await finishBatch(env, batch)

    if (batch.signal.aborted) {
      await blockUnstarted(env, batch.storeId, snapshot, items, () => ({ reason: CANCELLED_BEFORE_START, blockers: startedBlocker(snapshot, items) }))
      return await finishBatch(env, batch)
    }

    const verified = new Set(items.filter(item => taskOf(snapshot, item.taskId)?.status === 'verified').map(item => item.index))
    const ready = pending
      .filter(item => item.dependsOn.every(dependency => verified.has(dependency)))
      .sort((left, right) => left.index - right.index)
    if (ready.length === 0) {
      await blockUnstarted(env, batch.storeId, snapshot, items, item => ({
        reason: `dependencies [${item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId).join(', ')}] did not verify`,
        blockers: item.dependsOn
          .filter(dependency => !verified.has(dependency))
          .map(dependency => {
            const taskId = (items[dependency] as BatchItem).taskId
            return { taskId, outcome: taskOf(snapshot, taskId)?.status ?? 'blocked' }
          }),
      }))
      return await finishBatch(env, batch)
    }

    const item = ready[0] as BatchItem
    const started = latestRun(snapshot, item.taskId)
    if (started !== undefined) {
      // A run this driver did not start in this process: the child is either
      // legitimately in flight — its own nested batch, or a submission inside
      // verification, both of which settle themselves — or it was still in
      // flight when the batch was resumed. In that second case nothing can
      // confirm the writes it may already have made, so it is settled cancelled
      // with the recovery named (§3.6) instead of being resumed. A normally
      // driven child never reaches this branch: the driver waits for its
      // terminal state inside the round that started it.
      //
      // The known question wait (A4 §F.1) is the third case, and the one that
      // must not be cancelled: a child whose unresolved blocking question is on
      // the record was idle *because the protocol held it*, not because it
      // abandoned its work. Its answer is still coming, so the run keeps its
      // identity, its Session is brought back live (the one thing a dead process
      // cannot leave behind), and the driver waits for the terminal state that
      // Session will produce once it can read the answer — under the same two
      // bounds every other worker wait runs under. The block is rebuilt from the
      // store in the same step, so a write from that session is refused for the
      // reason that is true.
      // The wait is one of two durable facts: an unresolved blocking question, or
      // a delivery the store still owes this session (the answered-but-unread
      // case — the block is gone, the answer is owed, and cancelling the run
      // would throw away what the exchange produced).
      const questionWait = started.executionPhase === 'active'
        && (blockingQuestionsOf(snapshot, started.runId).length > 0 || owedQuestionMessagesTo(snapshot, started.sessionId).length > 0)
      // The other wait that must not become a cancellation (K1 §2, §5): the child
      // **got its own batch back**. A run that is `active` and accumulated batches
      // has ended every one of them — `waiting_children → active` clears the current
      // batch id and keeps the history — so it is a delegated parent the dead
      // process could not finish telling, not a worker that abandoned its work. The
      // recovery pass brings that same Session back and re-derives its batch-end
      // message; cancelling it here would throw away the decision the batch just
      // handed it, which is exactly the rule "an unsubmitted worker is cancelled"
      // is not for.
      const returnedParent = started.executionPhase === 'active' && (started.batches?.length ?? 0) > 0
      if (questionWait || returnedParent) {
        const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
        await awaitAdoptedWorkerWait(env, batch, item, started, dependencyTaskIds)
        continue
      }
      if (started.executionPhase === 'active') {
        const reason =
          `recovery: run "${started.runId}" was in flight when batch ${batch.batchId} resumed and never submitted; ` +
          'the writes it may already have made cannot be confirmed, so it is settled cancelled rather than resumed'
        const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
        await env.task.markRunStatusIn(batch.storeId, item.taskId, started.runId, 'cancelled', env.actor, { reason })
        await recordTerminalReview(env, batch.storeId, item.taskId, 'cancelled', {
          run: started,
          anomalies: [reason],
          relatedTaskIds: dependencyTaskIds,
        })
        env.onRunSettled?.(batch.storeId, item.taskId, started.runId, 'cancelled')
        await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, started.runId), started.sessionId)
        continue
      }
      const status = await waitRunSettled(env, batch.storeId, started.runId, started.sessionId)
      env.onRunSettled?.(batch.storeId, item.taskId, started.runId, status)
      await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, started.runId), started.sessionId)
      continue
    }

    const attempt = await startChildRound(env, batch, parentTask, parentRun, items, item, snapshot)
    if (attempt.kind === 'adopted') continue
    await driveChildRound(env, batch, attempt.child)
  }
}

/**
 * Bring one adopted worker back and wait for its settlement — the batch driver's
 * half of the worker recovery (A4 §F.1, K1 §5).
 *
 * The child this runs for is a run the driver did **not** start, and one of two
 * durable facts makes it a *wait* rather than an abandoned worker:
 *
 * - it has an unresolved blocking question of its own (or an answer it is still
 *   owed), which is where the protocol parked it (A4 §F.1);
 * - it is a delegated parent whose own batches all ended — `active` with an
 *   accumulated `batches` — so the decision the batch handed back is what it is
 *   waiting on, and the recovery pass is telling it so (K1 §2, §5).
 *
 * Its Run identity is untouched; what the dead process could not leave behind is
 * its Session, so the runtime's resume door ({@link OrchestrateEnv.resumeWorkerSession})
 * is asked to bring it back under that same identity. Three answers are
 * possible, and each has a different consequence:
 *
 * - `live` — the Session is reachable again, so what the child waits for (its
 *   parent's answer, or the news that its batch ended) can be delivered to it and
 *   the wait can be observed;
 * - `retry` — another owner holds the Session. Nothing is taken over and the run
 *   keeps its identity; the wait continues (bounded by the deadline) and the
 *   next activation retries;
 * - `refused` — the identity cannot be established. The child is settled
 *   `failed` with the refusal named, because a run in flight that nobody can
 *   bring back is a wait with no end, and leaving it `running` would be a lie
 *   the store keeps telling.
 *
 * The wait itself is {@link awaitWaitingTerminal}: the same deadline (the run's
 * own `wallTime` and what is left of the root's, both measured from the run's
 * persisted `startedAt`) and the same batch abort that every other worker wait
 * runs under — the gap this closes is "a recovered wait with no deadline", not a
 * new rule about deadlines. The deadline ending here is a budget stop, exactly
 * as it is for a run whose worker this process started, and it takes the
 * question's derived effects with it: a settled asking run owes no delivery, so
 * a late answer is audit rather than a revival.
 */
async function awaitAdoptedWorkerWait(
  env: OrchestrateEnv,
  batch: BatchContext,
  item: BatchItem,
  run: TaskRun,
  dependencyTaskIds: readonly TaskId[],
): Promise<ChildOutcome> {
  const resumed = await resumeAdoptedWorker(env, batch.storeId, run)
  if (resumed.status === 'refused') {
    const reason = `recovery refused to continue this run: the Session "${run.sessionId}" could not be brought back (${resumed.reason})`
    return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
      status: 'failed',
      localizedCause: reason,
      anomalies: [reason],
    })
  }
  if (resumed.status === 'retry') {
    notifyOwner(
      env,
      run.sessionId,
      `task-runtime: run "${run.runId}" is waiting on coordination this process cannot hand to it, and its Session "${run.sessionId}" is held by ` +
      `another owner (${resumed.reason}); nothing is taken over, and the wait stays bounded by the run's own deadline`,
    )
  }
  // The block is *derived* from the store here, never assumed — this process wrote
  // no ask, and the wait it adopted may be an answered-but-unread one, where the
  // block is already gone — and the phase is set only for a Session this call
  // brought live (an already-live session keeps the phase its own binding
  // derived). Both are pushed before the wait, so the first request the answer
  // wakes is decided under the facts the store holds.
  env.gate.setQuestionsBlocked(run.sessionId, blockingQuestionsOf(await env.task.snapshotIn(batch.storeId), run.runId).length > 0)
  if (resumed.status === 'live' && env.gate.phaseOf(run.sessionId) === undefined) env.gate.setPhase(run.sessionId, 'active')
  const terminal = waitRunSettled(env, batch.storeId, run.runId, run.sessionId)
    .then((status): WaitingObservation => ({ kind: 'terminal', status }))
  const observation = await awaitWaitingTerminal(
    env,
    run,
    cancelAgentOf(env, run.sessionId),
    batch.signal,
    () => remainingRunMsFromStore(env, batch.storeId, run),
    terminal,
  )
  switch (observation.kind) {
    case 'terminal': {
      const snapshot = await env.task.snapshotIn(batch.storeId)
      const status: RunStatus = snapshot.runs.find(candidate => candidate.runId === run.runId)?.status ?? observation.status
      env.onRunSettled?.(batch.storeId, item.taskId, run.runId, status)
      await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), run.sessionId)
      const evidenceId = childEvidenceId(snapshot, run.runId)
      return {
        taskId: item.taskId,
        runId: run.runId,
        status: status as ChildOutcome['status'],
        ...(evidenceId === undefined ? {} : { evidenceId }),
      }
    }
    case 'budget-exhausted':
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'failed',
        localizedCause: wallClockExhaustedReason(env),
      })
    case 'aborted':
      return await settleChildRun(env, batch.storeId, { item, run, dependencyTaskIds }, {
        status: 'cancelled',
        anomalies: [`the batch was cancelled while this recovered child waited: ${batch.reason}`],
      })
  }
}

/**
 * The blockers a cancelled batch names: the siblings that were in flight when it was cancelled.
 */
function startedBlocker(snapshot: TaskSnapshot, items: readonly BatchItem[]): { taskId: TaskId; outcome: TaskStatus }[] {
  return items.flatMap(item => {
    const run = latestRun(snapshot, item.taskId)
    const task = taskOf(snapshot, item.taskId)
    if (run === undefined || task === undefined || task.status === 'verified') return []
    return [{ taskId: item.taskId, outcome: task.status }]
  })
}

/** The store's own account of how a batch's children ended, one `2 verified` per status. */
function outcomeTally(outcomes: readonly ChildOutcome[]): string {
  const counts = new Map<ChildOutcome['status'], number>()
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => `${count} ${status}`).join(', ')
}

/** {@link outcomeTally} named by the batch it belongs to — what a batch end reports. */
function batchSummary(batchId: string, outcomes: readonly ChildOutcome[]): string {
  return `batch ${batchId} ended: ${outcomes.length === 0 ? 'no children' : outcomeTally(outcomes)}`
}

/**
 * The `m-` identity one ended batch's result message carries: derived from the
 * batch id, never minted — the same derivation `questionMessageIdOf` makes for a
 * question, and for the same reason. A retry in this process or after a restart
 * states the same identity, so the target's own fold answers "this one is
 * already here" instead of the runtime keeping a ledger of what it sent.
 */
export function batchEndMessageId(batchId: string): string {
  return `m-batchend-${batchId}`
}

/**
 * The body one batch-end message carries, rendered from the store's own account
 * of the batch: every member's terminal state and the evidence it left, and what
 * the parent may do now. It is reprojected from the facts on every call (never
 * remembered, never edited between attempts), so the live delivery and a
 * recovery re-delivery carry the same words about the same batch.
 *
 * What it deliberately does not say is that anything was submitted: the runtime
 * submits nothing on the parent's behalf (K1 §2), and only the parent's own
 * `task_submit_result` starts its acceptance.
 */
export function batchEndMessageText(batchId: string, outcomes: readonly ChildOutcome[]): string {
  const children = outcomes.length === 0
    ? 'It admitted no children.'
    : `Its children settled: ${outcomeTally(outcomes)}.`
  const lines = outcomes.map(outcome =>
    `- ${outcome.taskId} (run ${outcome.runId ?? 'none'}): ${outcome.status}${outcome.evidenceId === undefined ? '' : `, evidence ${outcome.evidenceId}`}`)
  return [
    `[task-batch-end ${batchId}] the child batch has ended and the workspace is handed back to you; nothing was submitted on your behalf.`,
    children,
    ...lines,
    'You are active again: read the children\'s results, continue your own work, delegate another batch (task_decompose), or hand in your own result (task_submit_result) — only that submission starts your acceptance.',
  ].join('\n')
}

/**
 * The member task ids of one batch, as the run's own accumulated batches record
 * them. A run that records no such batch cannot be asked about it: the members of
 * a batch nobody names are not another batch's and not the task's children, so
 * the read fails by name instead of answering for a batch it cannot identify.
 */
function batchMembers(run: TaskRun, batchId: string): TaskId[] {
  const batch = run.batches?.find(candidate => candidate.batchId === batchId)
  if (batch === undefined) {
    throw new Error(
      `task-runtime: run "${run.runId}" records no batch "${batchId}", so the store does not name its members; ` +
      'a batch is read from the run that admitted it, never derived from the task\'s children',
    )
  }
  return [...batch.memberTaskIds]
}

/**
 * One batch a run has ended and been told about — or still has to be told about
 * ({@link owedBatchResults}): the batch, the run whose wait it ends, the Session
 * the message goes to, and the members whose terminal states the body renders.
 */
export interface OwedBatchResult {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly batchId: string
  /** The parent's own Session: the target of the message and the Session it is sent from. */
  readonly sessionId: string
  readonly memberTaskIds: readonly TaskId[]
}

/**
 * The end-of-batch results one store's own facts still owe (K1 §2, §5).
 *
 * A run that is `active` has no unfinished batch — `waiting_children → active`
 * clears `batchId` — so every entry of its accumulated `batches` names a batch
 * that ended, and each ended batch owes its Session the one message under
 * `m-batchend-<batchId>` ({@link batchEndMessageId}), whether the process that
 * ended it delivered it or died before it could. The store's own accumulation is
 * the whole derivation: nothing is guessed from a task's children, a batch no run
 * records is not a candidate, and a run that is still `waiting_children`,
 * `submitted` or terminal owes nothing here (its batch end is not durable yet, its
 * acceptance is what is in flight, or it is past being told).
 *
 * Being owed is a candidate, not a verdict: the target's own fold decides whether
 * the message is still missing when the delivery is attempted, so a second pass
 * over the same store re-derives the same list and delivers nothing twice.
 */
export function owedBatchResults(snapshot: TaskSnapshot): OwedBatchResult[] {
  const owed: OwedBatchResult[] = []
  for (const run of snapshot.runs) {
    if (run.status !== 'running' || run.executionPhase !== 'active') continue
    for (const batch of run.batches ?? []) {
      owed.push({
        taskId: run.taskId,
        runId: run.runId,
        batchId: batch.batchId,
        sessionId: run.sessionId,
        memberTaskIds: [...batch.memberTaskIds],
      })
    }
  }
  return owed
}

/**
 * Deliver one batch's end-of-batch message and report what the attempt settled
 * as. A deployment without the seam, or one whose relay refuses, changes nothing
 * about the batch: the store's facts are the result, and the message is the wake
 * that points at them.
 */
async function deliverBatchResult(env: OrchestrateEnv, result: BatchResultMessage): Promise<BatchResultDeliveryStatus> {
  if (env.deliverBatchResult === undefined) return 'unavailable'
  try {
    return await env.deliverBatchResult(result)
  } catch (error) {
    return `refused: ${message(error)}` as BatchResultDeliveryStatus
  }
}

/**
 * End one batch and hand the parent back its own decision (K1 §2) — the
 * settlement a driver performs once every child has a terminal state.
 *
 * The order is the promise the parent is given:
 *
 * 1. **every child's write convergence is confirmed** — the one thing a batch end
 *    must not assume. A child that submitted has been drained by its own
 *    settlement, but a child that settled `blocked` or was settled by a
 *    cancellation may still hold writers or managed jobs, so each member run's
 *    Session is drained with the same primitive the admission and submission
 *    paths use. A convergence that cannot be confirmed is a parent failed by
 *    name: the workspace is not handed back, the phase is not persisted, the gate
 *    is not opened, and no parent is told it may write into a checkout somebody
 *    else may still be writing to;
 * 2. the parent's own writes are drained, by the same rule and the same refusal
 *    (§3.3);
 * 3. the batch's workspace layer comes off, so the parent's own hold is on top
 *    again (§3.4) — confirmed stops first, the handback after them: the batch
 *    holds the checkout until every writer inside it is confirmed stopped (§2);
 * 4. `waiting_children → active` is persisted with the batch it closes, and the
 *    Session's gate follows into `active` — the *question* block is recomputed
 *    from the store in the same step, because an unresolved blocking question
 *    keeps refusing the parent's writes and a batch ending answers nothing
 *    (A4 §7.2);
 * 5. the batch's result is delivered to the parent's Session under the identity
 *    the batch derives, so the parent is *told* it may continue instead of a
 *    model having to notice a phase change.
 *
 * What the runtime no longer does is submit on the parent's behalf. A batch
 * ending is a fact about the children — several of which may have failed — not a
 * verdict about the parent, and only the parent's own `task_submit_result`
 * starts its verification (`settleSubmittedRun`, the one verification entry).
 *
 * Two gates can still end the batch without judging it, both budget stops rather
 * than verdicts: a cancellation (§3.6) and the parent's own deadline (§3.5).
 * Their release is the terminal cleanup it always was, taken before the run is
 * settled: a stopped run is not revived by its children's drains, and its own
 * checkout is still handed back. A parent whose run already settled was settled
 * by somebody else, and its batch end is the store's record alone.
 */
async function finishBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  const snapshot = await env.task.snapshotIn(batch.storeId)
  const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
  // The batch's own members, read from the run's accumulated batches: the task's
  // children are every batch's, and a second batch must report (and drain) its
  // own children rather than repeat the first batch's. A run that does not record
  // this batch has no members to report, and the read says so by name.
  const members = batchMembers(parentRun, batch.batchId)
  const outcomes = await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members)
  // A parent whose run already settled was settled by somebody else, and its batch
  // end is the store's record alone: the layer the batch took at admission — and
  // every child handed back as it settled — comes off here, the same release the
  // ordinary handback performs further down (§3.4).
  if (parentRun.status !== 'running') {
    await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId)
    return outcomes
  }
  const childTaskIds = [...members]

  if (batch.signal.aborted) {
    // The cancellation is the batch's terminal cleanup, taken as it always was:
    // the run ends `cancelled` — never failed by a drain it was stopped before —
    // and the workspace it was holding goes back with that settlement.
    await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId)
    const reason = `cancelled by the caller while the batch settled: ${batch.reason}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled', env.actor, { reason })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'cancelled', { run: parentRun, anomalies: [reason], relatedTaskIds: childTaskIds })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled')
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}. Children: ${batchSummary(batch.batchId, outcomes)}`)
    return outcomes
  }

  // The deadline ends the batch without judging it: a parent accepted after its own
  // deadline would be an acceptance the budget never allowed (§3.5) — a run reported
  // `verified` for work the clock had already stopped. The bound is the run's own
  // (`remainingRunMs`: its per-run wall time, what is left of the root's, and any
  // instant its caller placed on it), read here because this is the last moment
  // before that acceptance — every child has settled, and a run's deadline can arrive
  // exactly then: a sub-execution inherits the parent's instant, so the child failing
  // on the budget is what brings the batch here with the parent's clock already out.
  // A watched run's own wait stops it the same way (`observeWorkerRun`); this is that
  // rule reaching the run whose settlement the batch performs. The ceilings are
  // read here, at the judgement itself and not from the settlement's earlier reads
  // (K4): an acceptance refused over a ceiling a person raised while the batch
  // drained would be a refusal the store no longer supports.
  const rootDeadline = await rootDeadlineOf(env, batch.storeId)
  if (remainingRunMs(env, parentRun, rootDeadline, Date.now()) <= 0) {
    // The deadline is the other terminal cleanup, released exactly as the
    // cancellation's is: the clock stopped this run, and its checkout goes back
    // with the settlement rather than waiting on a drain nobody will confirm.
    await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId)
    const reason = parentDeadlinePassedReason(env, rootDeadline)
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled', env.actor, { reason })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'cancelled', { run: parentRun, anomalies: [reason], relatedTaskIds: childTaskIds })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled')
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}`)
    return outcomes
  }

  // The unprocessed coordination items no longer hold the parent where it is
  // (K1 §2): the batch ends regardless of what the parent still owes or waits
  // for. What an unresolved blocking question does is refuse the parent's
  // *writes* — recomputed into the gate below from the store's own facts — and a
  // batch ending can never answer on the parent's behalf. The batch's children
  // are over either way, so the parent is told so and left to its own
  // coordination; the items stay on the record as their audit.
  const blocked = blockingQuestionsOf(snapshot, batch.parentRunId).length > 0

  // Every child's write convergence, before the parent is told the batch is over
  // (§3.3): a child settles through its own submission — which drained it — but a
  // child that was blocked, cancelled or adopted terminal may still hold writers
  // or managed jobs, and "the batch is over, you may write again" is a promise
  // about the checkout that only a confirmed drain can make. The union of what
  // could not be confirmed is named on the parent's terminal record instead.
  const childPending: string[] = []
  for (const childTaskId of childTaskIds) {
    const childRun = latestRun(snapshot, childTaskId)
    if (childRun === undefined) continue
    const childDrained = await drainSession(env.gate, childRun.sessionId, {
      timeoutMs: env.writeDrainTimeoutMs,
      jobs: env.jobs,
      agent: env.agentFor?.(childRun.sessionId),
    })
    if (!childDrained.confirmed) {
      childPending.push(`run "${childRun.runId}": ${childDrained.pending.join('; ')}`)
    }
  }
  if (childPending.length > 0) {
    const reason = `write convergence of the batch's children could not be confirmed: ${childPending.join('; ')}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', { run: parentRun, localizedCause: reason, relatedTaskIds: childTaskIds })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}; the parent run is failed and its batch is not handed back.`)
    return outcomes
  }

  const drained = await drainSession(env.gate, parentRun.sessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    jobs: env.jobs,
    agent: env.agentFor?.(parentRun.sessionId),
  })
  if (!drained.confirmed) {
    const reason = `write convergence could not be confirmed: ${drained.pending.join('; ')}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', { run: parentRun, localizedCause: reason, relatedTaskIds: childTaskIds })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}; the parent run is failed and is not verifiable.`)
    return outcomes
  }

  // The handback (§2): both drains are confirmed, so the batch's layer comes off
  // and the parent's own hold is on top again (§3.4) — confirmed stops first, then
  // the checkout. The two unconfirmed paths above returned before this point, and
  // that is the whole order: a parent failed for a convergence nobody could
  // confirm keeps the batch's layer exactly where it was, while a parent that is
  // handed its checkout back has one already.
  await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId)

  // The store's half of the handback (§1.3): one phase event says the run waits on
  // nothing and closes the batch it names, so a reader of the store sees the same
  // fact the gate is told next. The write gate and the question block are separate
  // questions: `active` is the phase the batch gave back, and whether an
  // unresolved blocking question still refuses this run's writes is recomputed
  // from the store here rather than assumed from what this process remembers.
  await env.task.changeRunPhaseIn(batch.storeId, batch.parentTaskId, batch.parentRunId, env.actor, { phase: 'active', batchId: batch.batchId })
  env.gate.setPhase(parentRun.sessionId, 'active')
  env.gate.setQuestionsBlocked(parentRun.sessionId, blocked)

  // …and the parent is told: the batch's own outcomes, under the identity the
  // batch derives, delivered to the Session that waited. A re-delivery states
  // the same message and writes nothing when it is already there, which is what
  // the recovery pass relies on; the plain notice is the fallback for a
  // deployment with no relay, and the record of the batch end either way.
  const message = batchEndMessageText(batch.batchId, outcomes)
  const delivery = await deliverBatchResult(env, {
    storeId: batch.storeId,
    runId: batch.parentRunId,
    batchId: batch.batchId,
    sessionId: parentRun.sessionId,
    messageId: batchEndMessageId(batch.batchId),
    text: message,
  })
  // A `skipped` delivery is not an undelivered one: the parent run ended before
  // it could be told (a cancellation that won the race, a deadline), and the
  // fallback notice would be a wake addressed to a terminal run — the very thing
  // K1 §2 forbids. Its own terminal transition already told its owner.
  if (delivery !== 'delivered' && delivery !== 'already-present' && delivery !== 'skipped') {
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${batchSummary(batch.batchId, outcomes)}; ${message} (delivery: ${delivery})`)
  }
  return outcomes
}

/**
 * Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
 * and owned by the runtime rather than by the tool call that admitted it.
 *
 * The first step is the parent's own drain — admission closed at the atomic
 * commit, so whatever the parent still had in flight has to stop before the
 * first child starts writing (§3.3); an unconfirmable drain blocks the children
 * that never started and fails the parent by name instead of assuming a stop.
 *
 * Then every round re-reads the store: children already terminal are adopted,
 * exactly one ready child is started (the batch is serial by dependency order,
 * not parallel — §5's declared boundary), and the round waits for that child's
 * terminal state. A nested decomposition is not a recursive call: the child's
 * own `task_decompose` registers its own driver, and this loop only waits for
 * the child's run to settle.
 *
 * A driver failure is a parent failed with the cause named, recorded and notified
 * (§3.1's "no fire-and-forget") — but never a batch reported as ended on facts the
 * store did not give: when the batch's members cannot be read (the parent run is
 * unreadable, or its record does not hold this batch), this promise rejects by
 * name instead of resolving with an outcome list derived from another batch's
 * members or from the task's whole child history. The runtime's own belt settles
 * the batch such a rejection names (`registerDriver` → `failBatchFromRuntime`).
 */
export async function driveBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  // The batch's own members, read from the run the store records as its parent
  // ({@link batchMembers}): the fallback this used to have — the parent task's
  // children, every batch's — is exactly what would report a second batch as its
  // first batch's children.
  const members = async (): Promise<TaskId[]> =>
    batchMembers(await env.task.runIn(batch.storeId, batch.parentRunId), batch.batchId)
  try {
    const admitted = await convergeAdmission(env, batch)
    if (!admitted) return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members())
    return await driveRounds(env, batch)
  } catch (error) {
    const reason = `the batch driver failed: ${message(error)}`
    await failParentRun(env, batch, reason)
    return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members())
  }
}

/** The parent's own write convergence, before the batch's first child starts. */
async function convergeAdmission(env: OrchestrateEnv, batch: BatchContext): Promise<boolean> {
  const drained = await drainSession(env.gate, batch.callerSessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    ...(batch.excludeCallId === undefined ? {} : { excludeCallId: batch.excludeCallId }),
    jobs: env.jobs,
    agent: env.agentFor?.(batch.callerSessionId),
  })
  if (drained.confirmed) return true
  const reason = `write convergence could not be confirmed: ${drained.pending.join('; ')}`
  const snapshot = await env.task.snapshotIn(batch.storeId)
  const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
  await blockUnstarted(env, batch.storeId, snapshot, batchItems(batchMembers(parentRun, batch.batchId), snapshot.edges), () => ({
    reason: `the batch never started: ${reason}`,
    blockers: [],
  }))
  await failParentRun(env, batch, reason)
  return false
}

/** Fail the batch's parent run by name, with the one review record its terminal transition owes. */
async function failParentRun(env: OrchestrateEnv, batch: BatchContext, reason: string): Promise<void> {
  try {
    const snapshot = await env.task.snapshotIn(batch.storeId)
    const parentTask = taskOf(snapshot, batch.parentTaskId)
    const parentRun = snapshot.runs.find(run => run.runId === batch.parentRunId)
    if (parentTask === undefined || parentRun === undefined) return
    if (parentRun.status !== 'running') return
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', {
      run: parentRun,
      localizedCause: reason,
      // The batch this failure ends names its own members, never the parent task's
      // children — those are every batch this parent ever admitted.
      relatedTaskIds: batchMembers(parentRun, batch.batchId),
    })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(env, batch.callerSessionId, `task-runtime: batch ${batch.batchId} failed: ${reason}`)
  } catch (error) {
    // A driver that failed while its own bookkeeping was unavailable says so
    // once, and never turns into an unhandled rejection at the runtime.
    notifyOwner(env, batch.callerSessionId, `task-runtime: batch ${batch.batchId} failed and its parent run could not be settled: ${reason} (${message(error)})`)
  }
}

/* --- submission settlement (A3 §3.2) -------------------------------------- */

/**
 * The one verification entry: a run whose phase change into `submitted` is
 * already committed is drained, judged, and settled.
 *
 * Everything that verifies a run goes through here — the worker's own
 * `task_submit_result` (a parent's included: a batch ending hands the run back
 * `active` and only the parent's own submission starts its acceptance), and the
 * recovery path's continuation of a run that submitted before a restart. That is
 * what makes the paths share the budget, the drain, the verifier deadline and
 * the review discipline instead of separate implementations that drift (§3.1
 * "验证权唯一").
 *
 * A drain that cannot be confirmed fails the run with the pending work named:
 * judging a run whose writers may still be running would produce a verdict
 * about bytes nothing can vouch for (§3.3).
 */
export async function settleSubmittedRun(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  opts: { excludeCallId?: string; relatedTaskIds?: readonly TaskId[]; anomalies?: readonly string[] } = {},
): Promise<RunStatus> {
  const run = await env.task.runIn(storeId, runId)
  if (isTerminalRun(run.status)) return run.status
  const task = await env.task.taskIn(storeId, taskId)
  const snapshot = await env.task.snapshotIn(storeId)
  const relatedTaskIds = opts.relatedTaskIds ?? snapshot.edges.filter(edge => edge.to === taskId).map(edge => edge.from)
  const anomalies = opts.anomalies ?? []

  const drained = await drainSession(env.gate, run.sessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    ...(opts.excludeCallId === undefined ? {} : { excludeCallId: opts.excludeCallId }),
    jobs: env.jobs,
    agent: env.agentFor?.(run.sessionId),
  })
  if (!drained.confirmed) {
    return await failSubmittedRun(env, storeId, task, run, relatedTaskIds, `write convergence could not be confirmed: ${drained.pending.join('; ')}`, anomalies)
  }

  // The verification mark is written once per verification. A resumed one — the
  // process that started it died inside the verifier call — finds the task
  // already `verifying`, and the store refuses `verifying → verifying`; skipping
  // the redundant write is what lets the recovery continue a run whose phase
  // event already says it owes a verdict. The later `TaskVerified` needs exactly
  // this state, so nothing else may move it.
  const currentTask = await env.task.taskIn(storeId, taskId)
  if (currentTask.status !== 'verifying') {
    await env.task.markRunStatusIn(storeId, taskId, runId, 'verifying', env.actor)
  }
  let bundle: EvidenceBundle
  try {
    bundle = await withVerifierWorkspace(env, storeId, taskId, runId, run.sessionId, () => verifyWithDeadline(env, storeId, runId))
  } catch (error) {
    const reason = message(error)
    // This run's verdict is written before the batch's failure seam, and that order
    // is what makes it hold: the seam aborts the driver, whose abort settles an
    // in-flight child `cancelled`, while a run whose submission is the thing that
    // failed must be failed — the driver then adopts the terminal run as it stands.
    const status = await failSubmittedRun(env, storeId, task, run, relatedTaskIds, reason, anomalies)
    if (error instanceof VerifierUnavailableError) {
      const batchId = await parentBatchOf(env, storeId, task, run)
      if (batchId !== undefined) await env.failBatch?.(storeId, batchId, `verification is unavailable: ${reason}`)
    }
    return status
  }

  // Cancellation wins over a verdict that arrives after it. The store settled this
  // run while the verifier worked, so its verdict is voided: no status (the store
  // would refuse the move out of a terminal state) and no second review record.
  const settled = await settledStatusOf(env, storeId, runId)
  if (settled !== undefined) return settled

  const criteria = reviewCriteria(task.acceptanceCriteria, bundle.verifierResults)
  const unmet = unmetMandatory(task.acceptanceCriteria, bundle.verifierResults)
  if (unmet.length === 0) {
    await env.task.markRunStatusIn(storeId, taskId, runId, 'verified', env.actor)
    await recordTerminalReview(env, storeId, taskId, 'verified', { run, relatedTaskIds, criteria, anomalies })
    env.onRunSettled?.(storeId, taskId, runId, 'verified')
    await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId)
    return 'verified'
  }
  const reason = failureReason(unmet)
  await env.task.markRunStatusIn(storeId, taskId, runId, 'failed', env.actor, { reason })
  await recordTerminalReview(env, storeId, taskId, 'failed', {
    run,
    localizedCause: reason,
    relatedTaskIds,
    criteria,
    anomalies,
    logTail: await failedLogTail(env, unmet, bundle.verifierResults),
  })
  env.onRunSettled?.(storeId, taskId, runId, 'failed')
  await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId)
  return 'failed'
}

/**
 * The status of a run another actor has already settled, or `undefined` while it is
 * still in flight. The verdict path reads this before writing a verdict: a
 * cancellation that lands during a verifier call owns the settlement, and the store
 * refuses both a move out of a terminal state and evidence for a settled run.
 */
async function settledStatusOf(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<RunStatus | undefined> {
  const current = await env.task.runIn(storeId, runId)
  return isTerminalRun(current.status) ? current.status : undefined
}

/** Fail a run that could not be judged, with the reason recorded and its owner told. */
async function failSubmittedRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  relatedTaskIds: readonly TaskId[],
  reason: string,
  anomalies: readonly string[] = [],
): Promise<RunStatus> {
  const current = await env.task.runIn(storeId, run.runId)
  if (isTerminalRun(current.status)) return current.status
  await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
  await recordTerminalReview(env, storeId, task.taskId, 'failed', {
    run,
    localizedCause: reason,
    relatedTaskIds,
    anomalies,
  })
  env.onRunSettled?.(storeId, task.taskId, run.runId, 'failed')
  await releaseWorkspaceLayer(env, runOwner(storeId, task.taskId, run.runId), run.sessionId)
  notifyOwner(env, run.sessionId, `task-runtime: run "${run.runId}" failed: ${reason}`)
  return 'failed'
}

/**
 * The batch a child run belongs to: the batch of its parent run that admitted
 * this child. `parentRunId` names the parent run and the membership is a fact of
 * that run's accumulated batches — never an id parsed back into a task, which is
 * exactly what could not survive a parent that admits more than one batch (K1).
 * The run is a batch member of at most one batch, so the answer is unique.
 *
 * The parent-run guard is what keeps a replay's lineage (`parentRunId` naming
 * the champion) from being read as a batch membership: the run named must be the
 * parent *task*'s own run. A run whose parent has no batch entry answers
 * `undefined` — a membership this build cannot name is not guessed at.
 */
async function parentBatchOf(env: OrchestrateEnv, storeId: string, task: TaskInstance, run: TaskRun): Promise<string | undefined> {
  if (run.parentRunId === undefined || task.parentTaskId === undefined) return undefined
  const snapshot = await env.task.snapshotIn(storeId)
  const parentRun = snapshot.runs.find(candidate => candidate.runId === run.parentRunId)
  if (parentRun === undefined || parentRun.taskId !== task.parentTaskId) return undefined
  return parentRun.batches?.find(batch => batch.memberTaskIds.includes(task.taskId))?.batchId
}

/* ------------------------------------------------------------------------- *
 * Replay (A3 §3.2/§3.8 applied to the W15 runner)
 * ------------------------------------------------------------------------- */

/**
 * Per-run overlay (guide §2.7.6, W15): candidate-side patches applied to ONE
 * replay run, never to the runtime's configuration. The evolution replay is
 * the only consumer; a normal run never carries one.
 */
export interface ReplayOverlay {
  /**
   * Whole-row capability replacements: an entry overrides the same-named row of
   * the configured table for this run's capability resolution (the same
   * whole-row semantics the sandbox's capability-table.patch.yml records).
   */
  capabilityOverrides?: Record<string, CapabilityConfig>
  /**
   * Extra skill roots forwarded to the worker grant (`WorkerGrant.skillRoots`):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   * skill layer, shadowing the same-name production skill for that worker alone.
   */
  extraSkillRoots?: string[]
  /**
   * Preset id mounted instead of the capability/default resolution. Must exist
   * in the deployment's preset roster — the roster scans constructor-fixed
   * roots only, so a sandbox-materialized preset is NOT mountable through this
   * seam (agent_preset replay stays manual in v1).
   */
  presetOverride?: string
}

/** Everything one replay run needs, pre-shaped by the caller (`TaskRuntime.replayTask`). */
export interface ReplayRunInit {
  /** The replayed task to create: parentless (depth 0), status `created`, objective already carrying the lineage tag. */
  task: TaskInstance
  /** The manifest resolved under the overlay. */
  manifest: CapabilityManifest
  /**
   * The provider pre-check this replay passed (S1-C item 1): the verdicts and
   * registry revision the replay resolved against, so the Run binding can record
   * them without repeating discovery.
   */
  providers?: ProviderPrecheck
  /** Lineage marker (`evolution-replay:<proposalId>`), recorded on the review record's anomalies. */
  lineage: string
  /** The preset to mount; already overlay-resolved by the caller. */
  agentPreset?: string
  /** Extra skill roots for the worker grant (overlay). */
  skillRoots?: readonly string[]
  /**
   * The model selection this replay's worker is created under (S4-E §Q3), already
   * resolved by the caller from the deployment's real configuration and registry:
   * the experiment's frozen identity, carried through the spawn and inherited by
   * the sub-execution the worker may decompose into. Absent replays on the
   * deployment's own default selection, exactly as before.
   */
  agentOptions?: AgentOptions
  /** false: deterministic criteria replay — no worker is spawned, the verifier alone settles the run. */
  spawn: boolean
  /** The champion run this replay stands in for, recorded as the run's parentRunId (execution lineage). */
  championRunId?: RunId
}

/**
 * The two signals a replay runs under — the same split the batch has (§3.7).
 * `admission` is the caller's own tool signal and governs only the run's
 * creation: once the run and its task are persisted the replay belongs to the
 * runtime, whose `advance` signal (a controller the runtime registered) is what
 * stops it. A tool call that returns, or a caller that aborts, therefore cannot
 * strand a run that already exists in the store.
 */
export interface ReplayRunSignals {
  admission?: AbortSignal
  advance?: AbortSignal
}

/** What one settled replay run reports back to the comparison report. */
export interface ReplayRunOutcome {
  taskId: TaskId
  runId: RunId
  status: 'verified' | 'failed' | 'cancelled'
  evidenceId?: string
  durationMs?: number
  criteria?: ReviewCriterion[]
  /**
   * The workspace this replay ran in, when its caller named one
   * (`ReplayTaskOptions.workspace`, normalized): the directory its worker wrote
   * in and its verifier judged in. Absent for a replay that ran in the caller's
   * own checkout, which is where an unnamed replay always runs.
   */
  workspace?: string
}

/**
 * Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
 * the store, run it once through the real spawn + verify chain — or straight
 * through the verifier alone for a deterministic criteria replay — and settle
 * it with the same terminal-record discipline every other run gets
 * ({@link recordTerminalReview}), the lineage tag on the record's anomalies.
 * The replayed task is parentless and the historical task it mirrors is never
 * touched: a replay is a comparison experiment, not a tree edit. Nothing asks a
 * replay to decompose — its projection carries no decomposition guidance and no
 * spawn prompt invites one — but nothing refuses it either: `task_decompose` is
 * on every worker's surface, and a replayed worker that splits is settled by its
 * batch through the ordinary parent acceptance.
 *
 * A spawning replay is a worker like any other and follows the same rules: it
 * is born `active` and it *submits* — an idle worker is not a completion, the
 * no-progress counter runs, and the verification comes from the one entry every
 * run shares ({@link settleSubmittedRun}). A workerless replay is born
 * `submitted` (origin `runtime`) because there is nobody to submit: its
 * criteria are judged by the verifier and the run settles on the verdict.
 *
 * What the run is *placed under* travels with the init (S4-E §Q3): the caller's
 * frozen model selection ({@link ReplayRunInit.agentOptions}). It is carried on
 * the spawn request, so the deployment remembers it for the session and the
 * sub-execution a replayed worker decomposes into inherits exactly the same
 * binding; it is absent for an ordinary replay, whose run and spawn are what they
 * always were. The run's clock is not this entry's: its time is bounded by the
 * runtime's own per-run budget and the root tree's deadline alone.
 */
export async function runReplayTask(
  env: OrchestrateEnv,
  storeId: string,
  init: ReplayRunInit,
  signals: ReplayRunSignals = {},
): Promise<ReplayRunOutcome> {
  const task = init.task
  const admission = signals.admission
  const advance = signals.advance
  if (isAborted(admission)) {
    throw new Error(`task-runtime: replay of "${task.taskId}" was cancelled before anything was persisted`)
  }
  const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, await env.task.snapshotIn(storeId))
  if (missingArtifacts.length > 0) {
    throw new Error(`task-runtime: replay rejected: ${missingArtifactReason(missingArtifacts)}`)
  }
  const anomalies = [init.lineage]
  await env.task.createTaskIn(storeId, task, env.actor)
  await env.task.admitTaskIn(storeId, task.taskId, env.actor, { decompositionStatus: 'leaf', manifest: init.manifest })

  const sessionId = `s-${randomUUID()}`
  const runId: RunId = `r-${randomUUID()}`
  // The run exists before the spawn attempt so a spawn refusal can still walk
  // it to a terminal state — same discipline as a batch child. Its birth phase
  // is what makes the two replay modes one protocol: a spawning replay decides
  // its own work (`active`), a criteria replay has already handed its result in
  // (`submitted`, origin `runtime`).
  const birthSubmission: SubmissionRecord | undefined = init.spawn
    ? undefined
    : {
      summary: 'criteria replay (no worker spawned)',
      evidenceRefs: [],
      submittedAt: new Date().toISOString(),
      origin: 'runtime',
    }
  const startedAt = new Date()
  const run: TaskRun = {
    runId,
    taskId: task.taskId,
    sessionId,
    ...(init.championRunId === undefined ? {} : { parentRunId: init.championRunId }),
    capabilitySnapshot: capabilitySnapshot(init.manifest),
    ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
    executionPhase: init.spawn ? 'active' : 'submitted',
    ...(birthSubmission === undefined ? {} : { submission: birthSubmission }),
    artifacts: [],
    verifierResults: [],
    status: 'running',
    // One instant, read once: it is the run's recorded start, and the anchor the
    // per-run wall clock is measured from rather than from a second clock reading
    // beside it.
    startedAt: startedAt.toISOString(),
  }
  // The execution binding this run is placed under (S4-E §Q3): the caller's frozen
  // model selection, as one *bound view* of the env that every wait and every spawn
  // of this run reads. `env` stays what the caller handed in — the store, the
  // actor, the gate, the workspace — and this adds only what this one run binds, so
  // the rest of the replay is unchanged.
  const bound: OrchestrateEnv = {
    ...env,
    ...(init.agentOptions === undefined ? {} : { agentOptions: init.agentOptions }),
  }
  // The replay's content binding comes from the pre-check the caller carried
  // (`ReplayRunInit.providers`), not from a fresh discovery here: the identities
  // recorded are the ones the replay was admitted under, under the overlay's own
  // table. Materialized and read back before the record is written, exactly as in
  // a batch child — a criteria replay (no worker) binds the same way, so the run's
  // record cannot mean two different things depending on `spawn`.
  let contentBinding: RunProviderBinding | undefined
  try {
    contentBinding = await bindRunProviders({
      storeId,
      runId: run.runId,
      manifest: init.manifest,
      ...(init.providers === undefined ? {} : { providers: init.providers }),
      ...(env.runBindingRoot === undefined ? {} : { root: env.runBindingRoot }),
    })
  } catch (error) {
    const reason = `content binding failed: ${message(error)}`
    await env.task.startRunIn(storeId, run, env.actor)
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return await finishReplay(env, storeId, run, 'failed')
  }
  await env.task.startRunIn(storeId, contentBinding === undefined ? run : { ...run, providerBinding: contentBinding }, env.actor)

  if (!init.spawn) {
    const status = await settleSubmittedRun(env, storeId, task.taskId, run.runId, { anomalies })
    return await finishReplay(env, storeId, run, status === 'verified' ? 'verified' : 'failed')
  }

  let handle: AgentHandle
  try {
    await assertPresetUsable(env, init.manifest, init.agentPreset)
    const permissionPreset = permissionFor(env, init.manifest)
    // The overlay's roots stay in front (a candidate skill wins a same-name
    // collision for this worker), and the run's own snapshot follows: what the
    // replayed worker loads is bound content in both cases.
    const roots = skillRootsForRun(init.skillRoots ?? [], contentBinding)
    handle = await bound.spawn({
      sessionId,
      name: task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `replay-${task.taskId}`,
      taskWorker: true,
      grant: await authorizedGrant(env, init.manifest, roots),
      ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(bound.workerCwd === undefined ? {} : { cwd: bound.workerCwd }),
      // The experiment's frozen selection (absent for an ordinary replay): the
      // agent runtime creates this worker under it, and the deployment remembers
      // it for the sub-execution this worker's own decomposition may spawn.
      ...(bound.agentOptions === undefined ? {} : { agentOptions: bound.agentOptions }),
      ...(advance === undefined ? {} : { signal: advance }),
    })
  } catch (error) {
    const reason = `spawn failed: ${message(error)}`
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return await finishReplay(env, storeId, run, 'failed')
  }

  env.gate.setPhase(sessionId, 'active')
  env.onRunBound(sessionId, { storeId, taskId: task.taskId, runId: run.runId })

  const observation = await observeWorkerRun(bound, storeId, task, run, handle, advance)
  switch (observation.kind) {
    case 'terminal':
      return await finishReplay(env, storeId, run, statusOutcome(observation.status))
    case 'aborted':
      // `awaitWorker` already cancelled the agent when it saw the abort; the run
      // only has to be settled here.
      return await settleReplayRun(env, storeId, task, run, {
        status: 'cancelled',
        reason: 'cancelled while the replayed worker ran',
        anomalies,
      })
    case 'budget-exhausted': {
      // The bound view, because it is the one that carries what this run was placed
      // under: naming the deployment's own per-run budget here would misreport the
      // wall clock that actually ended the run.
      const reason = wallClockExhaustedReason(bound)
      return await settleReplayRun(env, storeId, task, run, { status: 'failed', reason, localizedCause: reason, anomalies })
    }
    case 'no-progress':
      handle.agent.cancel({ kind: 'parent' })
      return await settleReplayRun(env, storeId, task, run, {
        status: 'failed',
        reason: observation.reason,
        localizedCause: observation.reason,
        anomalies: [...anomalies, `no-progress round ${observation.rounds} of ${env.noProgressRounds}`],
      })
    case 'failed':
      return await settleReplayRun(env, storeId, task, run, {
        status: 'failed',
        reason: observation.reason,
        localizedCause: observation.reason,
        anomalies,
      })
  }
}

/**
 * Settle one replay run the replay's own observation decided — a cancellation, a
 * deadline, an unsubmitted idle, a worker error — and report what the run settled
 * as.
 *
 * Two settlement paths can reach one run at once, and this is not hypothetical for
 * a replay: a replayed worker that decomposed is settled by its own batch (the
 * ordinary parent acceptance submits and verifies the parent run) while this path
 * is deciding, and a run whose own deadline expires is exactly when both are in
 * flight. The arbitration is the one the batch's per-child settlement already
 * applies ({@link settleChildRun}, `settleRunFromRuntime` beside it): the store is
 * the arbiter — a run it now holds terminal stands, this settlement adds nothing,
 * and the outcome reports the state the store holds rather than the one this wait
 * was about to write. The two writes are otherwise exactly what they were: the
 * status event with its reason, one terminal review carrying the localized cause
 * and the lineage anomaly, and the settlement bookkeeping.
 */
async function settleReplayRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  settlement: {
    status: 'failed' | 'cancelled'
    /** The run-level reason (`markRunStatusIn`). */
    reason?: string
    /** The terminal review's localized cause; absent on a cancellation. */
    localizedCause?: string
    anomalies?: readonly string[]
  },
): Promise<ReplayRunOutcome> {
  const current = await env.task.runIn(storeId, run.runId)
  if (isTerminalRun(current.status)) return await finishReplay(env, storeId, run, statusOutcome(current.status))
  try {
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, settlement.status, env.actor, {
      ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
    })
  } catch (error) {
    // The store's own arbiter rule, as in `settleChildRun`: a run it now holds
    // terminal was settled by somebody else while this settlement was in flight,
    // and this call has nothing to add to it.
    const settled = await env.task.runIn(storeId, run.runId).catch(() => undefined)
    if (settled === undefined || !isTerminalRun(settled.status)) throw error
    return await finishReplay(env, storeId, run, statusOutcome(settled.status))
  }
  await recordTerminalReview(env, storeId, task.taskId, settlement.status, {
    run,
    ...(settlement.localizedCause === undefined ? {} : { localizedCause: settlement.localizedCause }),
    ...(settlement.anomalies === undefined ? {} : { anomalies: settlement.anomalies }),
  })
  env.onRunSettled?.(storeId, task.taskId, run.runId, settlement.status)
  return await finishReplay(env, storeId, run, settlement.status)
}

/** A settled run status as a replay outcome; a `blocked` run is reported as failed — a replay cannot be blocked by a sibling. */
function statusOutcome(status: RunStatus): 'verified' | 'failed' | 'cancelled' {
  return status === 'verified' || status === 'cancelled' ? status : 'failed'
}

/**
 * The replay result read back from the store: the review record the settlement
 * wrote carries the duration and the verdict per criterion, and the evidence
 * bundle the verifier produced is what the comparison report names.
 */
async function finishReplay(
  env: OrchestrateEnv,
  storeId: string,
  run: TaskRun,
  status: 'verified' | 'failed' | 'cancelled',
): Promise<ReplayRunOutcome> {
  const snapshot = await env.task.snapshotIn(storeId)
  const record = snapshot.reviews.find(item => item.runId === run.runId)
  const evidenceId = snapshot.evidence.find(item => item.taskRunId === run.runId)?.evidenceId
  return {
    taskId: run.taskId,
    runId: run.runId,
    status,
    ...(record?.durationMs === undefined ? { durationMs: await runDurationMs(env, storeId, run) } : { durationMs: record.durationMs }),
    ...(record?.criteria === undefined ? {} : { criteria: record.criteria.map(item => ({ ...item })) }),
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}

/* ------------------------------------------------------------------------- *
 * Settlements the runtime drives from the outside (§3.6)
 * ------------------------------------------------------------------------- */

/**
 * Settle one run terminal from outside the orchestration — a graph removal, or
 * a recovery pass that refuses to continue a run — with the same terminal-record
 * discipline every other settlement uses: the status event, its one review
 * record (idempotent: a run whose review already exists is not given a second),
 * the gate closed for its session, and the workspace layer it held released.
 *
 * A run that is already terminal is left exactly as it is: this is a settlement
 * entry, not an overwrite.
 */
export async function settleRunFromRuntime(
  env: RuntimeSettlementEnv,
  storeId: string,
  run: TaskRun,
  status: 'cancelled' | 'failed',
  reason: string,
): Promise<void> {
  const current = await env.task.runIn(storeId, run.runId)
  if (current.status !== 'running') return
  const snapshot = await env.task.snapshotIn(storeId)
  const task = snapshot.tasks.find(candidate => candidate.taskId === current.taskId)
  const relatedTaskIds = task?.childTaskIds ?? []
  try {
    await env.task.markRunStatusIn(storeId, current.taskId, current.runId, status, env.actor, { reason })
  } catch (error) {
    // Another settlement path can win this race: a driver's own abort branch, or
    // this same cancellation arriving through the batch. The store is the arbiter
    // — a run it already holds terminal stands, and this call has nothing to add.
    const settled = await env.task.runIn(storeId, current.runId).catch(() => undefined)
    if (settled === undefined || settled.status === 'running') throw error
    return
  }
  if (!snapshot.reviews.some(review => review.runId === current.runId)) {
    await recordTerminalReview(env, storeId, current.taskId, status, {
      run: current,
      // Only a failed record carries a localized cause; a cancellation's reason
      // is the status event's and the record's anomalies.
      ...(status === 'failed' ? { localizedCause: reason } : {}),
      anomalies: [reason],
      relatedTaskIds,
    })
  }
  env.onRunSettled?.(storeId, current.taskId, current.runId, status)
  // The questions addressed to this run stop being open the moment it settles
  // (A4 §F.1: an open question needs *both* runs running), so the runs that asked
  // it are recomputed here, from the store, before this settlement reports itself
  // done — a caller that awaited it must not have to wait for another event to
  // see the wait it ended. The gate is the one capability of the live process
  // this needs, and a settlement that has none (a store-level one) simply has no
  // session to release.
  if (env.gate !== undefined) {
    try {
      releaseAskingSessions(env.gate, await env.task.snapshotIn(storeId), current.runId)
    } catch (error) {
      notifyOwner(
        env,
        current.sessionId,
        `task-runtime: the question blocks of the runs that asked run "${current.runId}" could not be recomputed after it settled ` +
        `(${message(error)}); the store's own derivation is unchanged and the next recovery recomputes them`,
      )
    }
  }
  await releaseWorkspaceLayer(env, runOwner(storeId, current.taskId, current.runId), current.sessionId)
  notifyOwner(env, current.sessionId, `task-runtime: run "${current.runId}" was settled ${status}: ${reason}`)
}
