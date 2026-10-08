/**
 * The orchestration module's contracts: env seams, batch context, replay and settlement types.
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentOptions, WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  CapabilityManifest,
  EvidenceBundle,
  ReviewCriterion,
  ReviewDimensions,
  ReviewMetrics,
  ReviewOutcome,
  ReviewTokenUsage,
  ReviewToolCall,
  RunId,
  RunPlacement,
  RunProviderBinding,
  RunStatus,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskService,
  TaskStatus,
} from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig, PermissionSpec } from '../capability.ts'
import type { ExecutionGate, JobsView } from '../gate.ts'
import type { ProviderPrecheck } from '../provider-precheck.ts'
import type { RootBudgetConfig } from '../root-budget.ts'
import type { WorkspaceRegistry } from '../workspace.ts'
import type { McpEnvBinding } from '../mcp-servers.ts'

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
   */
  evidenceId?: string
}

/**
 * One ended batch's result, handed to the Session that was waiting for it (K1
 * §2): the batch's identity, the run whose wait it ends, the Session it goes to,
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
   */
  taskWorker?: boolean
  /**
   * The working directory the child's session starts in. Absent inherits the
   * caller's own cwd, which is what every ordinary run does; the orchestration
   */
  cwd?: string
  /**
   * The model selection the child's agent is created under, replacing the
   * deployment's own default for this worker alone (`AgentRuntime.spawn` merges
   */
  taskTemplatesRoot?: string
  agentOptions?: AgentOptions
  signal?: AbortSignal
}

/** Per-run usage annotations, measured from the persisted Session. */
export interface BudgetConfig {
  maxToolCalls?: number
  tokens?: number
  attempts?: number
}

/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
export interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number
}

/**
 * Raw, session-scoped facts the deployment's session services report for one
 * run's session. Deliberately plain data: the cascade never touches cordis, so
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
   */
  resolvePermissionSpec?(name: string): PermissionSpec
  /**
   * Optional env binding for capability-declared MCP servers
   * (`mcp-servers.ts`): the caller session's graph env, or `undefined` when
   */
  resolveMcpEnv?(): Promise<McpEnvBinding | undefined>
  mcpRegistry?: Readonly<Record<string, import('../mcp-servers.ts').McpServerTemplate>>
  verifyTimeoutMs: number
  /** The resolved per-run budget; which member is enforced in flight, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  budget?: BudgetConfig
  /**
   * `Config.allowRuntimeDecomposition`, carried to the worker prompt: a `leaf`
   * worker has to be told the door is open before it can walk through it, and a
   */
  allowRuntimeDecomposition: boolean
  isolatedChildren?: boolean
  maxActiveWorkers?: number
  childEnv?(run: TaskRun): Promise<OrchestrateEnv>
  prepareChildPlacement?(batch: BatchContext, runId: RunId, dependencyEvidenceRefs: string[]): Promise<RunPlacement>
  withChildAdmission?<T>(start: () => Promise<T>): Promise<T | undefined>
  waitForCapacity?(signal: AbortSignal): Promise<void>
  activateParent?(sessionId: string, signal: AbortSignal, activate: () => Promise<void>): Promise<void>
  spawn(request: SpawnChildRequest): Promise<AgentHandle>
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  /** Optional tail reader for verifier logs (logRef relative to the verifier's evidence root); absent keeps logTail off failed records. */
  readLogTail?(logRef: string): Promise<string | undefined>
  /**
   * Where a run's bound content is materialized (S1-C, `Config.runBindingRoot`).
   * Absent means this deployment cannot materialize content: a run that selects
   */
  runBindingRoot?: string
  /**
   * Optional session reader for the review record's dimensions and metrics
   * (§2.7.3): one read of a run's session log and token projection. Absent — or
   */
  observeSession?(sessionId: string): Promise<SessionObservation | undefined>
  onRunBound(sessionId: string, binding: { storeId: string; taskId: TaskId; runId: RunId }): void
  /**
   * The runtime's tool-execution gate (A3 §3.3). The orchestration owns the
   * phase of every session it spawns — a worker that has submitted, a parent
   */
  gate: ExecutionGate
  /**
   * The one-writer-per-workspace registry (A3 §3.4), with the checkout this
   * orchestration's sessions run in ({@link OrchestrateEnv.workspacePath},
   */
  workspaces?: WorkspaceRegistry
  workspacePath?: string
  /**
   * The directory every worker this orchestration spawns starts in, when the
   * checkout it works in is not the one its caller's session inherits. A replay
   */
  workerCwd?: string
  /**
   * The model selection every worker this orchestration spawns is created under,
   * when the run it serves is bound to one. A replay carries the experiment's
   */
  taskTemplatesRoot?: string
  agentOptions?: AgentOptions
  /**
   * The provider pre-check, for the one case that has no verdict to carry: a
   * batch whose admission happened in an earlier process. A freshly admitted
   */
  precheck?(capabilities: readonly string[], cwd: string | undefined, manifest?: CapabilityManifest): Promise<ProviderPrecheck>
  /**
   * Best-effort owner notification (`agent.followup` on a live session, DSH's
   * tool-jobs notice precedent). A session with no live agent is skipped, and
   */
  notify?(sessionId: string, text: string): void
  /**
   * Deliver one ended batch's result to its parent's Session (K1 §2) — the wake
   * that tells the parent it is `active` again, that the workspace is back, and
   */
  deliverBatchResult?(message: BatchResultMessage): Promise<BatchResultDeliveryStatus>
  /**
   * Observe one run's terminal transition: subscribe, then read the current
   * state, so a run that settled between the caller's last read and the
   */
  watchRun?(storeId: string, runId: RunId, cb: (status: RunStatus) => void): () => void
  /** The root budget in force (`Config.rootBudget`); absent means this deployment sets no root limits. */
  rootBudget?: RootBudgetConfig
  /** How long a write drain may take before it is reported as unconfirmed (`Config.writeDrainTimeoutMs`). */
  writeDrainTimeoutMs: number
  /** The jobs service the drain kills and waits on; absent means this deployment has no managed jobs. */
  jobs?: JobsView
  /** The agent a run's session currently resolves to, if any — the authorization a jobs call carries. */
  agentFor?(sessionId: string): unknown
  /**
   * Runtime bookkeeping at a run's terminal transition: the gate closes for
   * that session (only coordination tools remain) and the workspace the run
   */
  onRunSettled?(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void
  /** Called once per recorded terminal review, after the record is durable and never awaited. */
  onTerminalReview?(fact: TerminalReviewFact): void
  /**
   * The runtime's batch-failure seam: every child of the batch that has not
   * reached a terminal state is blocked and the batch's parent run is failed
   */
  failBatch?(storeId: string, batchId: string, reason: string): Promise<void>
  /**
   * Bring one adopted worker's Session back live under its own identity (A4
   * §F.1) — the runtime's own door into `AgentRuntime.resumeWorkerAgent`, with
   */
  resumeWorkerSession?(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume>
}

/**
 * What one request to bring an adopted worker's Session back states: the run
 * the store holds and the authorization rebuilt for it — never a second
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
 * - `live` — the same Session is live in this process now (or already was), so
 */
export type AdoptedWorkerResume =
  | { readonly status: 'live' }
  | { readonly status: 'retry'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }

/**
 * One terminal review that just became durable, as {@link
 * RuntimeSettlementEnv.onTerminalReview} hands it to the deployment.
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
   */
  onTerminalReview?(fact: TerminalReviewFact): void
  /**
   * The live process's execution gate, when this settlement has one (A4 §F.1).
   * A settled run ends the *questions addressed to it* — an open question needs
   */
  gate?: ExecutionGate
}

/** Raised when the deployment cannot observe a run's terminal state, so no honest settlement is possible. */
export class RunWatcherUnavailableError extends Error {
  override name = 'RunWatcherUnavailableError'
}

/** One mandatory criterion the verifier did not pass, plus what the verifier said about it. */
export interface UnmetCriterion {
  criterionId: string
  detail: string
}

/** One required artifact reference no store evidence satisfies yet. Exported with its readers (the spawn gate and the submission gate). */
export interface MissingArtifact {
  criterionId: string
  ref: string
  /**
   * Which declaration the reference came from: `requires` is a verified
   * reference product, `accepts` a raw input whose existence is the whole
   */
  requirement: 'requires' | 'accepts'
}

/** What one task worker's spawn needs: the session it becomes, and the content it runs against. */
export interface TaskWorkerSpawn {
  readonly sessionId: string
  readonly name: string
  /** The manifest the worker's grant is built from — the run's own resolved rows, not the task's recorded ones. */
  readonly manifest: CapabilityManifest
  /** The run's content binding, so the worker's skill layer registers the admitted snapshot. */
  readonly providerBinding?: RunProviderBinding
  readonly agentPreset?: string
  /**
   * The checkout the worker starts in, when it is not the parent session's own
   * (the ordinary case: the child inherits its parent's cwd). A recovery
   */
  readonly cwd?: string
  readonly signal?: AbortSignal
}

/**
 * The one batch the runtime drives: the parent whose children it admitted, the
 * batch id the store recorded, and the signal that now owns the progress.
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
   */
  excludeCallId?: string
  /**
   * The provider pre-check the batch was admitted under (S1-C). Carried so a
   * fresh admission's verdicts reach each child's run binding instead of being
   */
  providers?: ProviderPrecheck
}

/** One child of an admitted batch, positioned by the parent's own child order. */
export interface BatchItem {
  readonly index: number
  readonly taskId: TaskId
  /** Positions (not task ids) of the siblings this child waits for — the edge list mapped back into the batch. */
  readonly dependsOn: readonly number[]
}

/** What one never-started child is told, and by which siblings it is blocked. */
export interface BlockReason {
  reason: string
  blockers: readonly { taskId: TaskId; outcome: TaskStatus }[]
}

/** How a spawned worker's wait ended, before the caller settles the run. */
export type WorkerObservation =
  /** The run itself reached a terminal state (its own submission, a nested batch, a cancellation written elsewhere). */
  { kind: 'terminal'; status: RunStatus } | { kind: 'aborted' } | { kind: 'failed'; reason: string }

/**
 * What a wait watching the store and cancellation can end as: the
 * two endings {@link awaitWaitingTerminal} decides. Its own type because two
 */
export type WaitingObservation = { kind: 'terminal'; status: RunStatus } | { kind: 'aborted' }

/* --- one child, one round (A3 §3.1) --------------------------------------- */

/**
 * What the driver hands to {@link driveChildRound}: the run it just started, the
 * handle it spawned, and what a terminal record needs to name — the task the run
 */
export interface StartedChild {
  item: BatchItem
  task: TaskInstance
  run: TaskRun
  handle: AgentHandle
  dependencyTaskIds: readonly TaskId[]
}

/**
 * One batch a run has ended and been told about — or still has to be told about
 * ({@link owedBatchResults}): the batch, the run whose wait it ends, the Session
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
 * ------------------------------------------------------------------------- *
 * Replay (A3 §3.2/§3.8 applied to the W15 runner)
 */

/**
 * Per-run overlay (guide §2.7.6, W15): candidate-side patches applied to ONE
 * replay run, never to the runtime's configuration. The evolution replay is
 */
export interface ReplayOverlay {
  /** Frozen library for this replay and descendants; production config is unchanged. */
  taskTemplatesRoot?: string
  /**
   * Whole-row capability replacements: an entry overrides the same-named row of
   * the configured table for this run's capability resolution (the same
   */
  capabilityOverrides?: Record<string, CapabilityConfig>
  /** Candidate definitions resolved for this replay only. */
  mcpServers?: Record<string, import('../mcp-servers.ts').McpServerTemplate>
  /**
   * Extra skill roots forwarded to the worker grant (`WorkerGrant.skillRoots`):
   * every `<root>/<name>/SKILL.md` found is registered into the worker's own
   */
  extraSkillRoots?: string[]
  /**
   * Preset id mounted instead of the capability/default resolution. Must exist
   * in the deployment's preset roster — the roster scans constructor-fixed
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
   */
  taskTemplatesRoot?: string
  agentOptions?: AgentOptions
  /** false: deterministic criteria replay — no worker is spawned, the verifier alone settles the run. */
  spawn: boolean
  /** The champion run this replay stands in for, recorded as the run's parentRunId (execution lineage). */
  championRunId?: RunId
}

/**
 * The two signals a replay runs under — the same split the batch has (§3.7).
 * `admission` is the caller's own tool signal and governs only the run's
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
   */
  workspace?: string
}
