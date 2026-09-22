/**
 * Task runtime: capability resolution, decomposition admission, sequential run
 * orchestration on the agent-runtime spawn seam, and worker handoff rendering.
 * @module dsh-singularity-task-runtime
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {
  AcceptanceCriterion,
  AdmissionContext,
  CapabilityManifest,
  ChildEvidenceRef,
  DependencyEdge,
  EvidenceBundle,
  ExecutionPhase,
  ReviewTokenUsage,
  RunId,
  RunProviderBinding,
  RunStatus,
  SubmissionRecord,
  TaskContract,
  TaskEvent,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import { RootTaskSpec, TASK_CONTRACT_VERSION, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, capabilitySnapshot, resolvePreset, type CapabilityConfig, type PermissionSpec } from './capability.ts'
import { checkDecomposition, contractDefects, independentAcceptanceDefects } from './admission.ts'
import { ExecutionGate, type DrainResult, type JobsView } from './gate.ts'
import { optionalService, precheckProviders, precheckReplacedCapabilityRow, providerDefectLines, providerRefusals, registeredVerifierIds } from './provider-precheck.ts'
import type { ProviderPrecheck, SkillDiscoveryView } from './provider-precheck.ts'
import { assertRootBudgetConfig, checkBatchAdmission, checkRunStart, hasRootLimits, resolveRootBudget } from './root-budget.ts'
import type { RootBudgetConfig } from './root-budget.ts'
import { bindRunProviders, defaultRunBindingRoot, readRunBinding } from './run-binding.ts'
import type { RunBindingRead } from './run-binding.ts'
import { buildHandoff, renderWorkerPrompt } from './handoff.ts'
import { normalizeDecomposition } from './normalize.ts'
import {
  fixCriteriaProtectedInputs,
  fixSpecProtectedInputs,
} from './protected-inputs.ts'
import {
  deriveChildOutcomes,
  driveBatch,
  runReplayTask,
  settleRunFromRuntime,
  settleSubmittedRun,
  VerifierUnavailableError,
  escalationHint,
  type BatchContext,
  type BudgetConfig,
  type ChildOutcome,
  type OrchestrateEnv,
  type ReplayOverlay,
  type ReplayRunOutcome,
  type SessionObservation,
  type VerifyRunOptions,
} from './orchestrate.ts'
import { renderWorkerContract } from './contract.ts'
import { WORKSPACE_OWNERS_DIR, WorkspaceBusyError, WorkspaceRegistry, describeOwner, normalizeWorkspacePath, releaseLayer } from './workspace.ts'
import { drainSession } from './gate.ts'
import type { WorkspaceOwner } from './workspace.ts'

export type { CapabilityConfig, PermissionSpec } from './capability.ts'
export {
  resolveCapabilities,
  resolvePermission,
  resolveToolLabels,
  workerBaseline,
  TOOL_LABELS,
  WORKER_BASELINE_LABELS,
  WORKER_BASELINE_TOOLS,
} from './capability.ts'
export type { McpEnvBinding, McpServerTemplate } from './mcp-servers.ts'
export { MCP_SERVER_REGISTRY, manifestMcpServers, resolveMcpServerSpecs } from './mcp-servers.ts'
export {
  ExecutionGate,
  COORDINATION_ALLOWED,
} from './gate.ts'
export type { DrainOptions, DrainResult, GateDecision, InFlightCall, JobsView, JobsViewEntry } from './gate.ts'
export {
  WORKSPACE_OWNERS_DIR,
  WorkspaceBusyError,
  WorkspaceRegistry,
  normalizeWorkspacePath,
  readProcessStartTime,
} from './workspace.ts'
export type { WorkspaceAdoption, WorkspaceOwner, WorkspaceRegistryOptions } from './workspace.ts'
export {
  assertRootBudgetConfig,
  checkBatchAdmission,
  checkRunStart,
  countSubtreeFacts,
  hasRootLimits,
  resolveRootBudget,
  runDeadlineMs,
} from './root-budget.ts'
export type { BudgetVerdict, ResolvedRootBudget, RootBudgetConfig, RootBudgetResolution } from './root-budget.ts'
export type { AdmissionChild, AdmissionParent, AdmissionVerdict } from './admission.ts'
export { checkDecomposition, contractDefects, independentAcceptanceDefects } from './admission.ts'
export {
  fixCriteriaProtectedInputs,
  fixProtectedInputs,
  fixSpecProtectedInputs,
  protectedInputDefects,
} from './protected-inputs.ts'
export type {
  DecompositionIdentityContext,
  NormalizationContext,
  NormalizationResult,
  NormalizedBatch,
  NormalizedChild,
} from './normalize.ts'
export { normalizeDecomposition } from './normalize.ts'
export type { ObligationCoverage, ObligationTemplate, ObligationTemplateFile } from './obligation.ts'
export { checkObligationCoverage, findRepoRoot, loadObligationTemplates, parseObligationTemplates } from './obligation.ts'
export type { HandoffInit, WorkerPromptOptions } from './handoff.ts'
export { buildHandoff, renderWorkerPrompt } from './handoff.ts'
export { renderWorkerContract, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN } from './contract.ts'
export type {
  AcceptedSkillProviderVerdict,
  CapabilityGrants,
  CapabilityToolAnswer,
  CapabilityToolQuery,
  ExecutionProviderVerdict,
  GuidanceProviderVerdict,
  KnowledgeProviderVerdict,
  LoadedSkillSidecar,
  RejectedProviderVerdict,
  SkillDefect,
  SkillDefectCode,
  SkillProviderCandidate,
  SkillProviderIdentity,
  SkillProviderVerdict,
  SkillValidationContext,
} from './sidecar.ts'
export {
  capabilityToolQuery,
  executionProviders,
  loadSkillSidecar,
  registryRevision,
  skillValidationContext,
  validateSkillProvider,
} from './sidecar.ts'
export type { VerifiedWalk } from './verified-read.ts'
export { readVerifiedFile, walkVerified } from './verified-read.ts'
export type {
  RunBindingRead,
  RunBindingRequest,
  RunBindingSkillRead,
} from './run-binding.ts'
export { RUN_BINDING_SKILLS_DIR, bindRunProviders, defaultRunBindingRoot, readRunBinding, renderRunBinding } from './run-binding.ts'
export type {
  CapabilityProviderPrecheck,
  ProviderPrecheck,
  ProviderPrecheckRequest,
  SkillDiscoveryView,
  VerifierVocabulary,
} from './provider-precheck.ts'
export {
  optionalService,
  precheckProviders,
  precheckReplacedCapabilityRow,
  providerDefectLines,
  providerRefusals,
  registeredVerifierIds,
  skillSearchRoots,
  unlistableVerifierRefusal,
} from './provider-precheck.ts'
export type {
  BatchContext,
  BudgetConfig,
  ChildOutcome,
  OrchestrateEnv,
  ReplayOverlay,
  ReplayRunInit,
  ReplayRunOutcome,
  ReplayRunSignals,
  SessionObservation,
  SpawnChildRequest,
  VerifyRunOptions,
} from './orchestrate.ts'
export {
  deriveChildOutcomes,
  driveBatch,
  runReplayTask,
  settleRunFromRuntime,
  settleSubmittedRun,
  RunWatcherUnavailableError,
  VerifierUnavailableError,
  escalationHint,
} from './orchestrate.ts'

/** Local view of the verifier service (ticket C2 develops it in parallel): the
 * runtime resolves it softly from the context and never imports the package. */
export interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  /** Tail excerpt of one criterion log (logRef relative to the verifier's evidence root); optional on the service. */
  logTail?(logRef: string): Promise<string | undefined>
  /** The registered verifier ids; optional on the service, required to validate a criterion's `verifierRef`. */
  verifierIds?(): string[]
  /**
   * The cordis service lifecycle hook. Optional because a test double is already
   * readied when it is built; the provider pre-check awaits it before reading
   * `verifierIds()`, so a registry that is merely still loading is not read as
   * an empty vocabulary (S1-C).
   */
  ready?(): Promise<void>
}

/** Soft view of the env-builder store: verification commands and env-bound MCP servers run where the workers ran. */
interface EnvPathSource {
  store: { get(envId: string): { path: string; components?: readonly { repo: string; dir: string }[] } }
}

/** Soft view of the agent-presets registry: preflight the preset a child is about to be spawned with. */
interface AgentPresetRegistry {
  resolve(id?: string): Promise<unknown>
}

/** Soft view of the permission-presets registry: rank and validate capability-declared permission presets. */
interface PermissionPresetRegistry {
  resolve(name: string): PermissionSpec
}

/** Soft view of the session registry: the live `Session` a run's id still resolves to, if any. */
interface LiveSessionLookup {
  get(id: SessionId): unknown
}

/** Soft view of the session-projection registry: whole current wire values for one session. */
interface SessionProjectionSource {
  snapshot(session: never, keys: readonly string[]): { values: Record<string, unknown> }
}

/** Soft view of the session-query service: one session's replay-validated raw event log. */
interface SessionLogSource {
  readSession(sessionId: SessionId): Promise<{ events: readonly SessionEvent[] }>
}

/**
 * Tools that put a question or an approval in front of a human. `hitl_ask` and
 * `hitl_approve` are this deployment's root tools
 * (`agent-singularity/src/tools/ask.ts:11`, `approve.ts:9`); `ask_user_question`
 * is the worker baseline's (`capability.ts:55`).
 */
const HUMAN_TOOLS: ReadonlySet<string> = new Set(['hitl_ask', 'hitl_approve', 'ask_user_question'])

/**
 * Whether one `tool/result` payload reports a failure: the optional error
 * identity (appended only alongside `isError`) or any error-marked content block.
 */
function toolResultFailed(data: { error?: unknown; message?: { content?: readonly { isError?: boolean }[] } }): boolean {
  if (data.error !== undefined) return true
  return (data.message?.content ?? []).some(block => block.isError === true)
}

/** The skill name one `skill` tool call asked for, parsed from its raw arguments JSON. */
function skillNameFrom(rawArguments: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArguments) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/** The `tokenUsage` projection's wire view, or `undefined` when the value is not that shape. */
function tokenUsageOf(value: unknown): ReviewTokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const buckets = value as Partial<Record<keyof ReviewTokenUsage, unknown>>
  const numbers = [buckets.uncachedInputTokens, buckets.outputTokens, buckets.cacheReadTokens, buckets.cacheWriteTokens]
  if (numbers.some(item => typeof item !== 'number')) return undefined
  return {
    uncachedInputTokens: buckets.uncachedInputTokens as number,
    outputTokens: buckets.outputTokens as number,
    cacheReadTokens: buckets.cacheReadTokens as number,
    cacheWriteTokens: buckets.cacheWriteTokens as number,
  }
}

export interface CriterionSpec {
  /**
   * Stable criterion id (T1). Omitted, the runtime generates one from the batch
   * position (`ac1-1`, `ac2-1`, …) — the scheme every criterion was numbered
   * with. Declared, it is stored verbatim, and it is the only id a
   * parent-level `childEvidence.criterionId` can name: a parent that defines a
   * child's criteria *and* points at one of them must declare the id here,
   * because a generated id is only known after admission.
   */
  criterionId?: string
  description: string
  command?: string
  mode?: VerificationMode
  mandatory?: boolean
  requiredEvidence?: string[]
  /**
   * Evidence dependencies (KISS §5.1): artifact/evidence kinds or ids that must
   * exist in the store before this criterion can be judged. Since P4 this
   * declaration names a **verified reference product** — the producing run must
   * be verified and carry a passing verdict. Admission checks the shape only;
   * the orchestrator judges existence at spawn time and a missing reference
   * settles the child blocked, with the gap registered as an obligation.
   */
  requiresArtifact?: string[]
  /**
   * Raw-input counterpart of `requiresArtifact` (P4): artifact/evidence kinds
   * or ids this criterion consumes, where mere existence in the store is the
   * whole requirement — any run state. Judged at spawn time exactly like
   * `requiresArtifact`.
   */
  acceptsArtifact?: string[]
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent dispatches by mode (the current behavior);
   * present, the id must exist in the verifier registry — an unknown id
   * rejects the whole batch at admission time, with the error naming every
   * registered id.
   */
  verifierRef?: string
  /**
   * The parent-level evidence map (KISS §6 C2, P4): which child of the
   * decomposing task this criterion rests on, by batch position, optionally
   * narrowed to a child criterion and an evidence reference. Requires mode
   * `composite`; judged at parent-acceptance time against the store. Absent
   * keeps the composite conjunction as the whole verdict.
   */
  childEvidence?: ChildEvidenceRef[]
  /**
   * Labels this criterion's judgement heuristic (KISS §5.1, P4): the verdict is
   * marked as such and never counted as a deterministic pass. Mutually
   * exclusive with `childEvidence`.
   */
  heuristic?: boolean
  /**
   * Acceptance inputs this criterion's verdict rests on that the executing side
   * must not modify (S1-V slice 2): acceptance scripts, threshold files,
   * fixtures — declared as paths, resolved against the session's checkout.
   *
   * **Only the paths declared here are protected.** A criterion that declares
   * none carries no protection, and nothing is read or claimed for it.
   *
   * Who fixes the identity: the runtime, at admission, before the contract is
   * written. Each declared path is resolved against the session's checkout and
   * read once; the SHA-256 of its bytes is fixed beside the declared path in
   * the child's contract, which is what the contract and proposal identities
   * describe. A declared path that cannot be read — or a session whose checkout
   * cannot be resolved — refuses the whole batch: no id minted, nothing
   * persisted, because an identity fixed against the wrong bytes (or against a
   * guessed base) is worse than no task at all.
   *
   * Who re-checks: the verifier registry, before judging the criterion, against
   * the same checkout. A missing or modified input fails the criterion naming
   * the path, so a rewritten acceptance script can never turn a wrong product
   * into a pass.
   */
  protectedInputs?: readonly string[]
}

export interface DecomposeChildSpec {
  objective: string
  acceptanceCriteria: readonly CriterionSpec[]
  requiredCapabilities?: readonly string[]
  dependsOn?: readonly number[]
  /**
   * Assumptions the child task's contract rests on, in the caller's words.
   * Merged with the dependency-evidence references the orchestrator derives at
   * spawn time into the handoff's `assumptions` — a field both the spawn
   * prompt and the reprojected worker contract render.
   */
  assumptions?: readonly string[]
  /**
   * Execution scope and limits this child runs under, in the caller's words
   * (T1). Persisted in the child's contract — so a reader of the store sees the
   * scope the worker was given, not only the spawn prompt's copy of it — and
   * rendered into the handoff's constraints. Text is a declaration, not a
   * grant: the runtime still enforces every permission on its own plane.
   */
  constraints?: readonly string[]
  /**
   * The caller declares this child may decompose itself (RFC §36: the agent
   * admits it so its own worker keeps the option to split further). A missing
   * required capability forces `decomposable` on its own; the declaration is
   * what makes a child with no gap decomposable.
   */
  decomposable?: boolean
  /**
   * Contract-level marker (P4, KISS §6 C2): this child demands independent
   * parent acceptance — its own criteria must carry a `childEvidence` map, or
   * admission refuses the batch. Deleting the map can never silently degrade
   * the task back to the composite conjunction.
   */
  requiresIndependentAcceptance?: boolean
}

export interface DecomposeSpec {
  children: readonly DecomposeChildSpec[]
  reason: string
  /**
   * The contract language this batch is written in (T1). Omitted is the legacy
   * adapter — the runtime writes its current version, which is what an entry
   * that does not version its input means. A declared version this build does
   * not know is refused for the whole batch, never read with the wrong field
   * semantics.
   */
  contractVersion?: number
}

/**
 * Options for {@link TaskRuntime.replayTask} (guide §2.7.6, W15).
 */
export interface ReplayTaskOptions {
  /** Lineage tag, e.g. `evolution-replay:<proposalId>` — written into the replayed task's objective and the review record's anomalies. */
  lineage: string
  /** Candidate-side per-run patches; absent replays under the production configuration. */
  overlay?: ReplayOverlay
  /** Candidate contract replacing the champion's (the task_definition deterministic criteria replay). */
  contract?: { objective: string; acceptanceCriteria: AcceptanceCriterion[]; requiredCapabilities: string[] }
  /** false: no worker spawn — the verifier alone settles the run (deterministic criteria replay). Default true. */
  spawn?: boolean
  signal?: AbortSignal
}

export interface Config {
  /** Capability registry: name → skills/tool labels/agent preset/permission preset granted when a task requires it. */
  capabilities: Record<string, CapabilityConfig>
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number
  /** Absolute tree depth a decomposition may reach: a child at `maxDepth + 1` is rejected (root is depth 0). */
  maxDepth: number
  /** Most children one `task_decompose` batch may create. */
  maxChildren: number
  /** Per-run resource budget; see {@link BudgetConfig} for which member is enforced, checked post-hoc, or declared only. */
  budget: BudgetConfig
  /**
   * No-progress rounds before a worker that went idle without submitting is
   * stopped (KISS §5: `no_progress(3轮)`). **Enforced** since A3: the batch
   * driver observes every idle of a run whose phase is still `active`, marks one
   * round per unsubmitted idle (the store's own last marking supplies the
   * consecutive count), reminds the worker once per streak, and stops the run
   * with the no-progress reason at this limit. A run waiting on its children or
   * on verification is expected to be idle and is never marked.
   */
  noProgressRounds: number
  /**
   * Whether a task admitted `leaf` may still decompose at runtime: the node
   * itself decides it is not atomic, instead of its parent having predicted it
   * ({@link DEFAULT_ALLOW_RUNTIME_DECOMPOSITION} carries the shipped value and
   * the argument for it). Off, a `leaf` parent's batch is refused by admission
   * unless the child was declared `decomposable`.
   */
  allowRuntimeDecomposition: boolean
  /**
   * Where a run's bound provider content is materialized (S1-C): one directory
   * per run holding the skills the run loads, outside the worker's checkout so a
   * worker cannot rewrite what it is verified against. Defaults to
   * {@link defaultRunBindingRoot} (`<DSH_HOME or ~/.dsh>/singularity/run-bindings`);
   * a deployment that cannot materialize content fails a run that selects any,
   * rather than letting it load an unbound production path.
   */
  runBindingRoot?: string
  /**
   * What the whole tree may spend (A3 §3.5): a wall-clock limit measured from
   * the root run's own persisted `startedAt`, a cap on the runs the tree may
   * start, and the concurrent-writer count — which this deployment can only
   * honor as `1`. A limit that cannot be executed is refused at construction
   * ({@link assertRootBudgetConfig}) instead of accepted and quietly ignored.
   *
   * The object is closed: a member this module does not know is a hard limit
   * nobody would enforce, so naming one refuses to start.
   */
  rootBudget?: RootBudgetConfig
  /**
   * How long one write drain may take (A3 §3.3) before it is reported as
   * unconfirmed — and an unconfirmed drain fails the run rather than assuming
   * the writers stopped. Applied to the parent's drain before a batch starts,
   * to a submission's drain, and to a batch's settlement drain.
   */
  writeDrainTimeoutMs: number
}

/**
 * What the load-time provider scan found (S1-C item 3) — the deployment's own
 * capability table read from the harness process's own discovery roots, at the
 * moment that table went into effect.
 *
 * Two readings, both honest: {@link precheck} carries every verdict, so the
 * effective provider set is `executionProviders` of its rows (the only role that
 * may close an execution gap) with knowledge/guidance beside it; {@link defects}
 * carries the same refusals the load report printed, one line per defect.
 *
 * `defects` empty and `failed` absent means every skill the table names is a
 * loadable provider *from this viewpoint* — which is not the same as "every
 * worker's viewpoint", see {@link TaskRuntime.providerLoadReport}.
 */
export interface ProviderLoadReport {
  /** The scan's verdicts, per capability and per skill; absent when the scan could not run at all. */
  readonly precheck?: ProviderPrecheck
  /** Every refused provider, one line per defect; empty when the table names only loadable providers. */
  readonly defects: readonly string[]
  /**
   * Why the scan could not run at all — a failure of the scan itself, not of a
   * provider. Reported instead of a verdict, never swallowed: a load report that
   * could not be taken is not a quiet success.
   */
  readonly failed?: string
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The shipped per-run budget (KISS §8.6: granularity knobs live in config, not
 * in definitions). `wallTimeMs` is a backstop far above the longest legitimate
 * worker run this deployment has measured (a workload build takes 18–20 min,
 * so two hours kills only a genuinely stuck worker); `maxToolCalls` sits an
 * order above KISS's max_tool_calls 15 reference because this deployment's
 * submit/poll workers legitimately make dozens of calls — and it is a
 * post-hoc annotation, so a tight value would be noise, not a guardrail.
 * `attempts` matches the current reality: one run per task, no retry branch.
 * `tokens` carries no default on purpose — see {@link BudgetConfig}.
 */
export const DEFAULT_BUDGET: Readonly<BudgetConfig> = {
  maxToolCalls: 150,
  wallTimeMs: 2 * 60 * 60 * 1000,
  attempts: 1,
}

/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); enforced since A3 — see {@link Config.noProgressRounds}. */
export const DEFAULT_NO_PROGRESS_ROUNDS = 3

/**
 * The shipped write-drain window (A3 §3.3). Thirty seconds is far above the
 * settle time of a tool call this process can see finish — the drain waits on
 * in-flight registrations and the session's managed jobs, both of which either
 * stop promptly or are the thing the caller must be told about — and far below
 * a verifier call's own deadline, so a drain that cannot be confirmed fails the
 * run long before the verification budget it would otherwise waste.
 */
export const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 30_000

/**
 * Growth guardrails handed to admission as `decompositionPolicy`
 * ({@link Config.maxDepth}, {@link Config.maxChildren}, checked at
 * `admission.ts:47-58`).
 *
 * `4` is one level of headroom above the deepest tree actually exercised: the
 * §4.1 run recorded "根 → 子 → 孙" three levels (`docs/singularity-harness-guide.md:258`),
 * so a shallower cap would forbid a shape known to work while a deeper one would
 * let a runaway self-decomposer spend its whole budget before admission ever
 * refuses. `8` is several times the batches real runs send (2–4 children):
 * a single batch above it is a parent enumerating work it should
 * have delegated a level down, not a decomposition the orchestrator should run.
 */
export const DEFAULT_MAX_DEPTH = 4
export const DEFAULT_MAX_CHILDREN = 8

/**
 * Whether a task admitted `leaf` may still decompose itself
 * ({@link Config.allowRuntimeDecomposition}) — the door this deployment leaves
 * open on every node's own judgement, and the reason `leaf` is a hint rather
 * than a lock.
 *
 * A parent that admits a child `leaf` predicted the work fits one worker. That
 * prediction is one guess made before the work started, while `细化想法4.md:415-427`
 * puts `DECOMPOSE` at the Task Worker's own discretion and §36 (`:1459-1483`)
 * asks for criteria the node can apply, not for a verdict frozen at delegation
 * time: with the switch off, a node that discovers it is not atomic has no legal
 * path, which is the only thing that made the recursion unreachable. Nothing
 * else moves: `task_decompose` is already in every worker's grant whatever its
 * `decompositionStatus` (`capability.ts:145`), so a switch-off deployment hands a
 * worker a tool the same runtime then refuses.
 *
 * The switch relaxes no guardrail, so `true` is the shipped default. A batch
 * still clears every admission rule — structure, acyclic dependencies,
 * executable criteria carrying a command, the capability-gap rule,
 * {@link Config.maxDepth}, {@link Config.maxChildren} — and a task chain still
 * splits at most once (`already decomposed`, `task/src/service/state.ts`).
 * A deployment that wants every split pre-declared by the parent sets `false`
 * and keeps the pre-switch refusal, named message included.
 */
export const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true

/**
 * The shipped capability table, kept verbatim in step with `config.yml`
 * (document 1, the `task-runtime` row). `tools` holds LABELS from
 * {@link TOOL_LABELS}, expanded to real DSH tool names when a manifest is
 * resolved, and every worker also keeps {@link workerBaseline} whatever its
 * capabilities declare. `mcpServers` holds names from {@link MCP_SERVER_REGISTRY},
 * mounted per worker at spawn with the run's env binding (`./mcp-servers.ts`).
 *
 * No entry declares `permission`: flipping a worker to an approval-gated preset
 * (`workspace-write` asks) is blocked until approvals reliably reach the canvas
 * on a real deployment — the known issue recorded as #17 in
 * `docs/singularity-harness-guide.md:365` (fix landed 2026-09-17, real-topology
 * re-run still outstanding). An unattended worker on `ask` simply hangs.
 *
 * The four BB execution families read: the three `verify`/`run-*-regression`
 * entries ride the `bb-verify` composition (persona + fs + skill + a compaction
 * ratio tuned for long poll loops) plus the env's own bbdev MCP server;
 * `run-verilator-regression` adds the `waveform` skill because RTL failures are
 * settled cycle-level. `build-*` entries need no preset — one submit/poll MCP
 * round fits the default composition; `build-chip-config`'s install step itself
 * is bash-driven (the bbdev API's `/config/install` has no MCP wrapper), the
 * server covers the follow-up `validate`. Verification never rides the CI
 * dispatch channel: per the 2026-09-18 human ruling, dispatch/CI scripts are
 * reference material for writing MCP servers only — verification runs locally
 * (verify node + bbdev MCP + the local toolchain).
 */
export const DEFAULT_CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
  'design-chip': { skills: ['chip-designer'] },
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] },
  'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'run-bemu-regression': { skills: ['verify'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'run-verilator-regression': { skills: ['verify', 'waveform'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'build-chip-config': { mcpServers: ['bbdev'] },
  'build-compiler': { mcpServers: ['bbdev'] },
  'build-workload': { mcpServers: ['bbdev'] },
  'build-kernel': { mcpServers: ['bbdev'] },
  'integrate-model': { skills: ['workload-tests'] },
  'analyze-waveform': { skills: ['waveform'] },
  'research': { preset: 'standard' },
}

const Capability: z<CapabilityConfig> = z.object({
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  preset: z.string(),
  permission: z.string(),
  mcpServers: z.array(z.string()),
})

const RootBudget: z<RootBudgetConfig> = z.object({
  wallTimeMs: z.number(),
  maxRuns: z.number(),
  maxConcurrentWrites: z.number(),
})

const ConfigSchema: z<Config> = z.object({
  capabilities: z.dict(Capability).default({ ...DEFAULT_CAPABILITIES }),
  defaultPreset: z.string(),
  verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS),
  maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
  maxChildren: z.number().default(DEFAULT_MAX_CHILDREN),
  budget: z.object({
    maxToolCalls: z.number(),
    tokens: z.number(),
    wallTimeMs: z.number(),
    attempts: z.number(),
  }).default({ ...DEFAULT_BUDGET }),
  noProgressRounds: z.number().default(DEFAULT_NO_PROGRESS_ROUNDS),
  allowRuntimeDecomposition: z.boolean().default(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION),
  rootBudget: RootBudget,
  writeDrainTimeoutMs: z.number().default(DEFAULT_WRITE_DRAIN_TIMEOUT_MS),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskRuntime: TaskRuntime
  }
}

interface RunBinding {
  storeId: string
  taskId: TaskId
  runId: RunId
}

/**
 * One in-flight driver: the batch (or replay) the runtime owns, the controller
 * that stops it, and the promise the runtime awaits on unload or cancellation.
 * `promise` never rejects — a driver's own failure is a parent run failed with
 * the cause recorded — so a registered promise is safe to await anywhere.
 */
interface DriverEntry {
  readonly controller: AbortController
  readonly promise: Promise<ChildOutcome[]>
  /** The store this driver works in — how a graph-level cancellation finds it. */
  readonly storeId: string
}

/** The batch id a parent's decomposition records: `b-<parentTaskId>`, deterministic because a task splits once (§1.2). */
function batchIdFor(parentTaskId: TaskId): string {
  return `b-${parentTaskId}`
}

function now(): string {
  return new Date().toISOString()
}

export class TaskRuntime extends Service {
  static inject = ['task', 'agentRuntime', 'graphs']
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions = new Map<string, RunBinding>()
  /**
   * The sessions this process actually started (a spawned worker, a root run
   * created here, a replay). Deliberately *not* populated by {@link reindex}:
   * the recovery path needs to tell "this process is running that run right
   * now" from "the store holds a run from a process that is gone", and a
   * binding rebuilt from a snapshot cannot answer that.
   */
  private readonly startedSessions = new Set<string>()
  /**
   * The batches and replays this process owns, keyed `<storeId>/<batchId>`
   * (`replay/<runId>` for a replay). The map is the registration the recovery
   * path consults, and the controller in each entry is what a cancellation,
   * the root deadline or the unload path aborts.
   */
  private readonly drivers = new Map<string, DriverEntry>()
  /**
   * The lineage tag of each replay task this process started, keyed by task id.
   * A spawning replay's worker submits like any other worker, so its terminal
   * review is written by the shared settlement entry — which is where the tag has
   * to be known. In-process only, and honest about it: a replay resumed in a new
   * process records no lineage on the run it continues.
   */
  private readonly replayLineage = new Map<TaskId, string>()
  /** The tool-execution gate and the write drain (A3 §3.3); this runtime owns every phase it writes. */
  private readonly executionGate: ExecutionGate
  /** The one-writer-per-workspace ownership registry (A3 §3.4). */
  private readonly workspaces: WorkspaceRegistry
  /** The load-time provider scan, taken once ({@link providerLoadReport}). */
  private providerLoad?: Promise<ProviderLoadReport>

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'taskRuntime')
    const rootBudget = config?.rootBudget === undefined ? undefined : { ...config.rootBudget }
    // A hard limit this deployment cannot execute is refused at load, not
    // accepted and quietly ignored (§3.5). The schema keeps unknown keys on the
    // object it validates, so a member named here that this class does not know
    // is refused too — a limit nobody would enforce is worse than no limit.
    this.assertClosedRootBudget(rootBudget)
    assertRootBudgetConfig(rootBudget ?? {})
    this.config = {
      capabilities: structuredClone(config?.capabilities ?? DEFAULT_CAPABILITIES),
      ...(config?.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
      verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxChildren: config?.maxChildren ?? DEFAULT_MAX_CHILDREN,
      budget: { ...DEFAULT_BUDGET, ...(config?.budget ?? {}) },
      noProgressRounds: config?.noProgressRounds ?? DEFAULT_NO_PROGRESS_ROUNDS,
      allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
      runBindingRoot: config?.runBindingRoot ?? defaultRunBindingRoot(),
      ...(rootBudget === undefined ? {} : { rootBudget }),
      writeDrainTimeoutMs: config?.writeDrainTimeoutMs ?? DEFAULT_WRITE_DRAIN_TIMEOUT_MS,
    }
    this.executionGate = new ExecutionGate()
    this.workspaces = new WorkspaceRegistry({
      markerRoot: join(this.config.runBindingRoot ?? defaultRunBindingRoot(), WORKSPACE_OWNERS_DIR),
    })
    // Unload (A3 §3.6): every driver is aborted and awaited, the gate closes for
    // every session this runtime tracks, and the workspace markers this process
    // wrote are removed. The order matters — a marker removed while a driver
    // could still write would hand a checkout to the next claimer.
    ctx.effect(() => () => this.unload())
  }

  /**
   * Refuse a root budget carrying a member this build does not execute. The
   * schema keeps unknown keys, so this is where a caller's typo or a limit from
   * a newer version is caught: a `maxTokens` or `maxWallClock` nobody enforces
   * would read as a promise the deployment breaks silently.
   */
  private assertClosedRootBudget(budget: RootBudgetConfig | undefined): void {
    if (budget === undefined) return
    const known = new Set(['wallTimeMs', 'maxRuns', 'maxConcurrentWrites'])
    const unknown = Object.keys(budget).filter(key => !known.has(key))
    if (unknown.length === 0) return
    throw new Error(
      `task-runtime: rootBudget names [${unknown.join(', ')}], which this deployment does not enforce; ` +
      'a hard limit that cannot be executed refuses to start rather than running under a promise nobody keeps',
    )
  }

  /**
   * The unload path: abort every driver, await their settlements, close the gate
   * for every session this runtime tracks, and release the workspace markers
   * this process wrote. Warnings, never throws — an unload that raised would
   * leave the rest of the process's disposal half-done.
   */
  private async unload(): Promise<void> {
    const entries = [...this.drivers.values()]
    for (const entry of entries) entry.controller.abort()
    await Promise.all(entries.map(entry => entry.promise.catch(error => {
      this.warn(`unload: a driver did not settle cleanly (${error instanceof Error ? error.message : String(error)})`)
      return []
    })))
    this.drivers.clear()
    for (const sessionId of this.startedSessions) this.executionGate.setTerminal(sessionId)
    try {
      await this.workspaces.close()
    } catch (error) {
      this.warn(`unload: workspace markers could not be released (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /**
   * Cordis runs this after construction, once the injected services are there:
   * the load-time provider scan (S1-C item 3) is taken here, so the first thing
   * a deployment learns about its own capability table is what its own discovery
   * roots make of it.
   *
   * This hook never throws: see {@link providerLoadReport} for why the scan
   * reports instead of refusing to start.
   */
  async [Service.init](): Promise<void> {
    await this.providerLoadReport()
    // The tool-execution gate's wiring (A3 §3.3): one decision per call before
    // anything runs, one settle per call when its result arrives. Both are
    // registered through `ctx.effect` so they leave with this runtime: a gate
    // that outlived its runtime would deny calls on behalf of phases nobody
    // maintains any more.
    this.ctx.effect(() => {
      const offPre = this.ctx.on('tools/pre-execute', async (exec, next) => {
        const sessionId = exec.agent?.id
        if (sessionId === undefined) return await next()
        const decision = this.executionGate.decide(String(sessionId), exec.name)
        if (!decision.allow) return { kind: 'deny', reason: decision.reason }
        // Only an allowed call is registered: a denied call never runs, so
        // waiting for its result would wait for work that does not exist.
        this.executionGate.trackAllowed(String(sessionId), String(exec.callId), exec.name)
        return await next()
      }, { prepend: true })
      const offResult = this.ctx.on('tools/result', exec => {
        this.executionGate.settled(String(exec.callId))
      })
      return () => {
        // A minimal context (tests, a harness) may not hand back a disposer for
        // an event it never dispatches; that is not an error to raise at unload.
        if (typeof offPre === 'function') offPre()
        if (typeof offResult === 'function') offResult()
      }
    })
  }

  /**
   * The load-time provider scan over the capability table this process is
   * running (guide §2.4, S1-C item 3): every skill the effective table names,
   * discovered from the harness process's own skill roots (`process.cwd()`'s
   * project roots, `$DSH_HOME/skills`, the user root) and judged by
   * {@link validateSkillProvider} — the same validator admission, capability
   * replacement and candidate promotion use.
   *
   * Why this reports instead of refusing the deployment: the harness process's
   * own viewpoint is **not** the worker's. A deployment-level process loads
   * `config.yml` long before any graph env exists, so it cannot see the checkout
   * a worker will run in (`/…/env/<name>`, whose own `.agents/skills` a worker's
   * discovery walks first) — a skill that resolves fine at admission is
   * therefore legitimately *missing* from the load-time viewpoint. Failing the
   * load on that would refuse configurations that work, and it would fail for a
   * reason the operator cannot fix by editing the table. So every defect is
   * printed, nothing is enforced here, and the hard gate stays where the
   * viewpoint is the worker's own: the admission pre-check, which refuses the
   * whole batch before it persists anything.
   *
   * The result is kept as a value ({@link ProviderLoadReport}): the effective
   * provider set and the defect summary stay queryable after the log line has
   * scrolled away, without re-running the validation. It is the *load-time* fact
   * — a row replaced later in this process (an evolution apply, a rollback) was
   * judged by its own entry before it landed, and is not folded back into this
   * report.
   */
  async providerLoadReport(): Promise<ProviderLoadReport> {
    this.providerLoad ??= this.scanConfiguredProviders()
    return this.providerLoad
  }

  /**
   * One load-time scan, never thrown: a scan that cannot run (a discovery or a
   * read that fails outright) is reported as {@link ProviderLoadReport.failed}
   * and printed just as loudly as a refused provider.
   */
  private async scanConfiguredProviders(): Promise<ProviderLoadReport> {
    let report: ProviderLoadReport
    try {
      const precheck = await this.providerPrecheck(Object.keys(this.config.capabilities), { cwd: process.cwd() })
      report = { precheck, defects: providerDefectLines(precheck) }
    } catch (error) {
      report = { defects: [], failed: error instanceof Error ? error.message : String(error) }
    }
    this.reportProviderLoad(report)
    return report
  }

  /**
   * The load report, printed through the cordis logger when one is mounted: one
   * line per defect (capability, skill, defect code, detail) plus a header that
   * says what was scanned and that the deployment is starting anyway.
   */
  private reportProviderLoad(report: ProviderLoadReport): void {
    const roots = report.precheck?.roots ?? []
    if (report.failed !== undefined) {
      this.warn(
        `config load: the capability provider scan could not run (${report.failed}); the deployment starts, and admission ` +
        'still refuses a batch whose provider cannot be judged',
      )
      return
    }
    if (report.defects.length === 0) return
    this.warn(
      `config load: ${report.defects.length} provider defect${report.defects.length === 1 ? '' : 's'} in the effective capability table ` +
      `(roots: ${roots.join(', ')}); reported, not enforced — this process's own roots are not the worker's, so a skill ` +
      'reachable from a run\'s checkout may legitimately be missing here. Admission refuses a batch that names one of these.',
    )
    for (const line of report.defects) this.warn(`config load: ${line}`)
  }

  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn(message: string): void {
    const logger = (this.ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
    logger?.('task-runtime').warn(message)
  }

  /**
   * The wall-clock deadline one `verifier.verifyRun` call runs under
   * ({@link Config.verifyTimeoutMs}). Exposed because the same deadline has to
   * reach the model-facing `task_verify` self-check: its tool call would
   * otherwise run the verifier with no timer at all.
   */
  get verifyTimeoutMs(): number {
    return this.config.verifyTimeoutMs
  }

  /** The resolved per-run budget ({@link Config.budget}); which member is enforced, checked post-hoc, or declared only is documented on {@link BudgetConfig}. */
  get budget(): Readonly<BudgetConfig> {
    return { ...this.config.budget }
  }

  /** The resolved no-progress round count ({@link Config.noProgressRounds}); the batch driver's stop limit. */
  get noProgressRounds(): number {
    return this.config.noProgressRounds
  }

  /**
   * The tool-execution gate this runtime maintains (A3 §3.3), exposed read-only:
   * what a phase admits and refuses is part of what this service promises, and
   * the runtime is its only writer. Diagnostics and tests read it; nothing
   * outside moves a phase through it.
   */
  get gate(): ExecutionGate {
    return this.executionGate
  }

  /** Resolve required capability names against the configured registry. */
  resolveCapabilities(required: readonly string[]): CapabilityManifest {
    return resolveCapabilities(required, this.config.capabilities)
  }

  /** The effective capability registry, cloned so callers cannot mutate runtime state. */
  listCapabilities(): Readonly<Record<string, CapabilityConfig>> {
    return structuredClone(this.config.capabilities)
  }

  /**
   * Evolution apply/rollback seam (guide §2.7.7, W16): replace one capability
   * row in the effective registry at runtime — whole-row semantics, the same
   * row the evolution_apply tool edited in `config.yml` just before calling
   * this, so a restart reloads the identical table. `null` removes the row
   * (rollback of a newly-added capability). Later admissions resolve against
   * the replaced row; in-flight runs are untouched.
   *
   * **A replacement is validated before it lands; a removal is not.** This is
   * the entry that makes a row effective in this process, so it runs the same
   * check the promotion gate ran before the row was written to `config.yml`:
   * every skill the new row grants is discovered from the harness process's own
   * roots and judged by `validateSkillProvider`
   * ({@link precheckReplacedCapabilityRow}), against the live registry's verifier
   * vocabulary — fail-closed when that vocabulary cannot be listed. An unusable
   * provider rejects with its named defects and the table is left exactly as it
   * was, so no path into the effective registry skips the one validator
   * (guide §2.4, S1-C item 3). A removal needs no such check: it grants
   * nothing, and refusing a rollback would strand a deployment on a row it is
   * trying to undo.
   */
  async applyCapabilityRow(name: string, entry: CapabilityConfig | null): Promise<void> {
    if (entry === null) {
      const rest = { ...this.config.capabilities }
      delete rest[name]
      this.config.capabilities = rest
      return
    }
    await this.assertReplacementRow(name, entry)
    this.config.capabilities = { ...this.config.capabilities, [name]: structuredClone(entry) }
  }

  /**
   * The replacement check behind {@link applyCapabilityRow}: the row as it will
   * read after this write, judged by the admission pre-check itself. Throws with
   * every refusal named (capability, skill, defect code, detail) — and writes
   * nothing, which is what makes the caller's table unchanged.
   */
  private async assertReplacementRow(name: string, entry: CapabilityConfig): Promise<void> {
    const verifierRefs = await this.registeredVerifierIds()
    const { refusals } = await precheckReplacedCapabilityRow({
      name,
      entry,
      table: this.config.capabilities,
      // The deployment's own viewpoint, the same one the evolution gate and the
      // load-time report ask from: this process knows its own skill roots.
      view: { cwd: process.cwd() },
      ...(verifierRefs === undefined ? {} : { verifierRefs }),
    })
    if (refusals.length === 0) return
    throw new Error(
      `task-runtime: capability "${name}" was not replaced — the row grants providers that are not usable:\n` +
      refusals.map(line => `- ${line}`).join('\n'),
    )
  }

  /** Create (or reopen) the store, expand RootTaskSpec into the root task, and bind a run to the root session. */
  async createRootTask(
    storeId: string,
    options: { objective: string; rootSessionId: string },
    actor: string,
  ): Promise<{ taskId: TaskId; runId: RunId }> {
    try {
      await this.ctx.task.createStore(storeId)
    } catch (error) {
      if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
      await this.ctx.task.openStore(storeId)
    }
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    this.reindex(storeId, snapshot)
    const root = snapshot.tasks.find(task => task.parentTaskId === undefined)
    if (root !== undefined) {
      const run = [...snapshot.runs].reverse().find(item => item.taskId === root.taskId && item.sessionId === options.rootSessionId)
      if (run === undefined) {
        throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${options.rootSessionId}"`)
      }
      // Re-entering a run (a restarted root session adopts the run bound to it):
      // the record's own content identity is re-checked before the run is handed
      // back. A run whose bound content is no longer readable is refused by name
      // rather than resumed against whatever stands at that path now.
      if (run.providerBinding !== undefined) {
        const read = await readRunBinding(run.providerBinding)
        if (read !== undefined && read.defects.length > 0) {
          throw new Error(
            `task-runtime: run "${run.runId}" cannot be re-entered: the content it is bound to is not readable:\n- ${read.defects.join('\n- ')}`,
          )
        }
      }
      this.startedSessions.add(options.rootSessionId)
      // Adoption is the recovery entry (§3.6): runs this process is not driving
      // are settled or restarted, and the workspace this tree holds is rebuilt
      // from its own batch chain.
      await this.reconcileStore(storeId)
      await this.rebuildWorkspaceOwnership(storeId)
      return { taskId: root.taskId, runId: run.runId }
    }

    // The ids are minted before anything is written, so the checkout can be
    // claimed for the run that is about to exist: a workspace another live owner
    // holds fails the creation with nothing persisted (§3.4).
    const taskId: TaskId = `t-${randomUUID()}`
    const runId: RunId = `r-${randomUUID()}`
    const workspacePath = await this.workspacePathForSession(options.rootSessionId)
    if (workspacePath !== undefined && this.workspaces !== undefined) {
      await this.workspaces.claim(workspacePath, { kind: 'run', storeId, taskId, runId, since: now() })
    }
    const manifest = this.resolveCapabilities(RootTaskSpec.requiredCapabilities)
    // The root carries a contract like every other task (T1): the criteria come
    // from the fixed RootTaskSpec, deep-copied so the shared definition is
    // never aliased into a store — a criterion field added to the spec later
    // is copied by this clone without anyone having to remember it. The
    // objective is the accepted one, and the root declares no assumptions or
    // constraints of its own: the root session is where a human asks, not
    // where a contract rests on text.
    const contract: TaskContract = {
      contractVersion: TASK_CONTRACT_VERSION,
      objective: options.objective,
      acceptanceCriteria: structuredClone(RootTaskSpec.acceptanceCriteria),
      assumptions: [],
      constraints: [],
      requiredCapabilities: [...RootTaskSpec.requiredCapabilities],
    }
    const task: TaskInstance = {
      taskId,
      definitionRef: { taskType: RootTaskSpec.taskType, version: RootTaskSpec.version },
      objective: contract.objective,
      depth: 0,
      acceptanceCriteria: contract.acceptanceCriteria,
      requestedCapabilities: [...contract.requiredCapabilities],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract,
    }
    await this.ctx.task.createTaskIn(storeId, task, actor)
    await this.ctx.task.admitTaskIn(storeId, task.taskId, actor, { decompositionStatus: 'decomposable', manifest })
    // The root binds a binding like every other run — the same builder, the same
    // meaning — and for a root that grants nothing that is a record with no
    // providers, no snapshot, and the registry revision the table stood at:
    // nothing about content is invented for a run that loaded none.
    const providerBinding = await bindRunProviders({
      storeId,
      runId,
      manifest,
      table: this.config.capabilities,
      root: this.config.runBindingRoot,
    })
    const run: TaskRun = {
      runId,
      taskId: task.taskId,
      sessionId: options.rootSessionId,
      capabilitySnapshot: capabilitySnapshot(manifest),
      providerBinding,
      // Born active (§1.1): the root decides its own work — it may decompose,
      // and it must submit — until its batch or its own submission closes the
      // gate. A root run with no phase would be a record the phase gate cannot
      // admit anything for.
      executionPhase: 'active',
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: now(),
    }
    await this.ctx.task.startRunIn(storeId, run, actor)
    this.sessions.set(options.rootSessionId, { storeId, taskId: task.taskId, runId: run.runId })
    this.startedSessions.add(options.rootSessionId)
    this.executionGate.setPhase(options.rootSessionId, 'active')
    return { taskId: task.taskId, runId: run.runId }
  }

  /**
   * Admission and progress are two phases with two owners (A3 §3.1), and this
   * entry is the boundary between them.
   *
   * **Admission** (governed by `exec.signal`): protected-input identity fixing,
   * normalization, structural admission, capability admission, the provider
   * pre-check and verifierRef validation all have to pass for the whole batch
   * before anything is persisted — plus three checks that belong to the
   * protocol rather than to the shape: the parent run must be `active`, the root
   * budget must be able to reserve one run per child (§3.5), and the caller's
   * checkout must already be held by this run or an ancestor of it (§3.4). Every
   * refusal here is a refusal whole: no id minted, no event written, no worker
   * started.
   *
   * **The atomic commit**: one `admitBatchIn` records the children, their
   * admission, the dependency edges, the batch identity and the parent's
   * `active → waiting_children` phase change (§1.3). It is the admission's
   * closing act — from here the caller may only watch, read or cancel.
   *
   * **Progress** (governed by the runtime): the batch is handed to a driver
   * registered under the runtime's own controller, and this call returns
   * `{ batchId, childTaskIds }` immediately. The caller's signal dies with the
   * commit; a tool call that returns, or a caller that aborts its own call,
   * cannot stop a batch the store already admitted (§3.7). {@link awaitBatch}
   * and the owner notification are how a caller learns how it went.
   *
   * Protected acceptance inputs are fixed first (`protected-inputs.ts`): every
   * criterion's declared paths are read against the session's checkout and
   * recorded as the SHA-256 of their bytes, so the contract — and both content
   * identities computed over it — describe the fixed identity, never a path
   * that could be re-pointed or re-read later.
   *
   * The batch is then normalized ({@link normalizeDecomposition}): raw caller
   * input becomes the contract of every child with its defaults filled and its
   * criterion ids fixed, and the batch identity plus the limits in force become
   * ready to be recorded with the decomposition. A refused batch — by the
   * fixing or by normalization, in one message — is refused whole: no id is
   * minted into the store, no capability is resolved into an event, and no
   * obligation is recorded.
   *
   * The structural policy is `allowed` — a `leaf` task may decompose only while
   * {@link Config.allowRuntimeDecomposition} is on — plus the configured growth
   * guardrails ({@link DEFAULT_MAX_DEPTH}, {@link DEFAULT_MAX_CHILDREN}); a
   * rejected batch names the rule it hit and persists and spawns nothing.
   */
  async decomposeAndRun(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    exec: { signal?: AbortSignal; callId?: string } = {},
  ): Promise<{ batchId: string; childTaskIds: TaskId[] }> {
    const actor = callerSessionId
    const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId)
    const parentRun = await this.ctx.task.runIn(storeId, parentRunId)
    if (parentRun.taskId !== parentTaskId) {
      throw new Error(`task-runtime: run "${parentRunId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`)
    }
    if (parentRun.sessionId !== callerSessionId) {
      throw new Error(`task-runtime: run "${parentRunId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`)
    }
    // The phase is the admission gate (§2): only an `active` run decides its own
    // work, and a second batch is impossible for the same reason — the first one
    // left the run in `waiting_children`. A run with no phase predates the
    // protocol: its only continuation is cancellation, and admission says so
    // rather than guessing `active` for it.
    if (parentRun.executionPhase === undefined) {
      throw new Error(
        `task-runtime: run "${parentRunId}" predates coordination phases; it needs recovery ` +
        '(cancel this task tree and re-create it) before it can decompose',
      )
    }
    if (parentRun.executionPhase !== 'active') {
      throw new Error(
        `task-runtime: run "${parentRunId}" is in phase "${parentRun.executionPhase}"; only an active run may decompose ` +
        '(a run with an admitted batch settles it before deciding anything else)',
      )
    }
    if (exec.signal?.aborted === true) {
      throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`)
    }
    // The session's checkout, resolved once: the same directory the caller's
    // protected acceptance inputs are read against, the children's MCP servers
    // are bound to, and — S1-C — the granted skills are discovered from, since a
    // spawned worker inherits its cwd from this session
    // (`agent-runtime/src/index.ts`) and walks project skill roots upward from
    // there.
    const envPath = await this.envPathForSession(callerSessionId)
    // Protected acceptance inputs are fixed before the one normalization entry
    // (S1-V slice 2): the declared paths become the identity of the bytes they
    // name, read against the same checkout the criterion's judge will run in,
    // so the contract — and both content identities computed over it — describe
    // the fixed digest rather than a path someone could re-point later. The
    // strings-vs-fixed conversion happens *here*, not in normalization: by the
    // time the single entry reads the batch, there is one form and one form
    // only. A refused fixing joins the normalization refusal — same error, same
    // no-op: no id minted, no capability resolved, nothing persisted.
    const fixed = await fixSpecProtectedInputs(spec, envPath)
    // The one normalization entry (T1): raw input in, the canonical contract of
    // every child plus the batch identity out — and every reason, in one list,
    // when it is refused. Nothing is minted or persisted before this returns ok,
    // which is what makes a refused batch a no-op.
    const normalized = normalizeDecomposition(fixed.spec, {
      storeId,
      parentTaskId,
      parentRunId,
      callerSessionId,
      admissionContext: this.admissionContext(),
    })
    const reasons = [...fixed.reasons, ...(normalized.ok ? [] : normalized.reasons)]
    if (!normalized.ok || reasons.length > 0) throw this.contractRefusal(parentTaskId, reasons)
    const batch = normalized.batch

    const childTaskIds = batch.children.map(() => `t-${randomUUID()}`)
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    // A `leaf` child is the parent's prediction that the work fits one worker.
    // With the runtime-decomposition switch on, the node's own admission call
    // stands: the batch below clears the same rules either way, and `leaf` only
    // reaches admission as the name of the rule that would have refused it.
    const leaf = parentTask.decompositionStatus === 'leaf'
    const verdict = checkDecomposition(
      {
        ...parentTask,
        decompositionPolicy: {
          allowed: !leaf || this.config.allowRuntimeDecomposition,
          leaf,
          maxDepth: this.config.maxDepth,
          maxChildren: this.config.maxChildren,
        },
      },
      batch.children.map((child, index) => ({
        taskId: childTaskIds[index]!,
        objective: child.contract.objective,
        acceptanceCriteria: child.contract.acceptanceCriteria,
        dependsOn: child.dependsOn,
        requiresIndependentAcceptance: child.requiresIndependentAcceptance,
      })),
      snapshot.edges,
    )
    if (!verdict.ok) {
      throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join('\n- ')}`)
    }

    const manifests = batch.children.map(child => this.resolveCapabilities(child.contract.requiredCapabilities))
    const rejected = batch.children
      .map((child, index) => ({ child, index, manifest: manifests[index]! }))
      .filter(({ child, manifest }) => manifest.missing.length > 0 && !child.decomposable)
    if (rejected.length > 0) {
      const detail = rejected
        .map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(', ')}] and may not decompose`)
        .join('; ')
      // The rejected batch persists no children, but the gap itself is a fact
      // worth keeping: one obligation per missing capability, raised on the
      // parent (KISS §7 — a gap is a normal state with a record, not a silence).
      for (const { index, manifest } of rejected) {
        for (const missing of manifest.missing) {
          await this.ctx.task.recordObligationIn(storeId, {
            obligationId: `o-${randomUUID()}`,
            goal: `capability "${missing}" required by child ${index} ("${batch.children[index]!.contract.objective}") of "${parentTaskId}" is not granted by the registry`,
            criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
            sourceTaskId: parentTaskId,
          }, actor)
        }
      }
      // The obligations above are the in-plane signal (KISS §7: a gap is a
      // normal state with a record); the L4 exit is a separate, human-facing
      // card the root raises with `escalate`, so the rejection names it too.
      const gapNames = [...new Set(rejected.flatMap(({ manifest }) => manifest.missing))]
      throw new Error(
        `task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}; ` +
        escalationHint(
          `capabilities [${gapNames.join(', ')}] are not granted by the capability registry`,
          'capability_list and the children\'s declared capabilities',
          'grant the capability in the registry, or mark the child decomposable',
        ),
      )
    }

    // Provider pre-check (S1-C item 1): every skill the matched capabilities
    // grant must be discoverable from the viewpoint of the workers about to be
    // spawned, and what discovery finds must be a provider the unified
    // validator accepts (registered verifier, covered tools, matching content).
    // It runs after the gap rejection and before the first write, so a batch
    // refused here leaves no task, no run, no event and no obligation — and the
    // same verdicts then travel with the batch (`BatchContext.providers`) instead of being
    // recomputed at spawn.
    const precheck = await this.providerPrecheck(
      [...new Set(manifests.flatMap(manifest => Object.keys(manifest.capabilities)))],
      { ...(envPath === undefined ? {} : { cwd: envPath }) },
    )
    const refusals = providerRefusals(precheck)
    if (refusals.length > 0) {
      throw new Error(
        `task-runtime: provider pre-check rejected decomposition of "${parentTaskId}":\n- ${refusals.join('\n- ')}`,
      )
    }

    this.assertKnownVerifierRefs(
      batch.children.flatMap((child, childIndex) =>
        child.contract.acceptanceCriteria.map(criterion => ({ childIndex, criterion }))),
      `decomposition of "${parentTaskId}"`,
    )

    // The root budget's batch reservation (§3.5): every child of this batch will
    // start a run, so a batch that would push the tree past `maxRuns` is refused
    // whole — before a task, a run or an event exists — instead of admitted and
    // then started until the budget runs out mid-batch.
    //
    // A budget that cannot be resolved (no run bound to this store as its root,
    // a root whose start nobody recorded) refuses the batch only when this
    // deployment actually configures limits: with no limits configured there is
    // nothing to measure, and refusing work over a budget that does not exist
    // would be a refusal with no promise behind it.
    const budget = resolveRootBudget(snapshot, this.config.rootBudget ?? {})
    if (!budget.ok) {
      if (hasRootLimits(this.config.rootBudget)) {
        throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: the root budget cannot be resolved: ${budget.reason}`)
      }
    } else {
      const reserved = checkBatchAdmission(snapshot, budget, batch.children.length)
      if (!reserved.allowed) {
        throw new Error(`task-runtime: decomposition of "${parentTaskId}" refused: ${reserved.reason}`)
      }
    }

    // Workspace ownership (§3.4): the parent run must be the writer that holds
    // the checkout, or an ancestor of it must be. Anything else is another live
    // writer, and the batch is refused before the atomic commit rather than
    // handing two writers one checkout.
    const workspacePath = await this.workspacePathForSession(callerSessionId)
    if (workspacePath !== undefined) await this.assertWorkspaceHeldBy(workspacePath, storeId, parentTask, parentRunId)

    const children: TaskInstance[] = batch.children.map((child, index) => ({
      taskId: childTaskIds[index]!,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId,
      // The projections are generated from the contract, never written beside
      // it: the store refuses a TaskCreated whose fields disagree with the
      // contract it carries, and this is the side that has to agree.
      objective: child.contract.objective,
      depth: parentTask.depth + 1,
      acceptanceCriteria: child.contract.acceptanceCriteria,
      requestedCapabilities: [...child.contract.requiredCapabilities],
      decompositionStatus: child.decomposable || manifests[index]!.missing.length > 0 ? 'decomposable' : 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract: child.contract,
      ...(child.requiresIndependentAcceptance ? { requiresIndependentAcceptance: true } : {}),
    }))
    const edges: DependencyEdge[] = batch.children.flatMap((child, to) =>
      child.dependsOn.map((from: number) => ({ from: childTaskIds[from]!, to: childTaskIds[to]! })))
    // One commit (§1.3): the children, their admission, the dependency edges,
    // the parent's decomposition record, every child's capability manifest and
    // the parent's `active → waiting_children` phase change land together. It is
    // the admission's own closing act: either the batch exists with the gate shut
    // behind it, or nothing happened at all.
    const batchId = batchIdFor(parentTaskId)
    await this.ctx.task.admitBatchIn(storeId, parentTaskId, parentRunId, children, actor, edges, batch.admission, manifests)

    // The phase is committed, so the gate closes for this session now: from here
    // the parent may read, diagnose, ask or cancel, and nothing else (§3.3).
    this.executionGate.setPhase(callerSessionId, 'waiting_children')
    if (workspacePath !== undefined && this.workspaces !== undefined) {
      const held = this.workspaces.ownerOf(workspacePath)
      if (held !== undefined) {
        await this.workspaces.push(workspacePath, held, {
          kind: 'batch',
          storeId,
          taskId: parentTaskId,
          batchId,
          since: now(),
        })
      }
    }

    // Progress belongs to the runtime from here on (§3.7): the caller's signal
    // governed admission only, and this batch's own controller is what a
    // cancellation, the root deadline or the unload path reaches.
    this.startBatchDriver({ storeId, parentTaskId, parentRunId, batchId, callerSessionId, reason: spec.reason, providers: precheck, ...(exec.callId === undefined ? {} : { excludeCallId: exec.callId }) })
    return { batchId, childTaskIds }
  }

  /**
   * Replay one historical terminal task under a candidate overlay (guide
   * §2.7.6, W15; the only consumer is `evolution_replay`). The replayed task is
   * created parentless — the historical tree is never edited by a comparison
   * experiment — with the lineage tag on its objective, and settles through the
   * real spawn + verify chain (or the verifier alone when `spawn: false`).
   *
   * The champion's contract (objective / criteria / capabilities) is mirrored
   * unless `options.contract` replaces it (the task_definition deterministic
   * criteria replay). Capability resolution runs against the configured table
   * with `overlay.capabilityOverrides` applied as whole-row replacements; a gap
   * under the overlay refuses the replay before anything is persisted.
   *
   * The replayed task carries a normalized contract like every other creation
   * (T1), and its criteria are judged by the same structural rules an ordinary
   * decomposition child faces (`contractDefects` plus the P4 declarations).
   * Protected acceptance inputs are fixed here too (S1-V slice 2), against the
   * replay caller's checkout: a candidate contract declaring paths has their
   * identity fixed before anything else reads it, while a champion's stored
   * `{ path, sha256 }` refs are carried verbatim — the historical identity is
   * what the pre-judgement re-check compares against, so it is never re-read
   * from disk and never invented. A replay has no batch, so it records no
   * admission context: nothing was proposed to a parent, there is no sibling
   * set to bound, and the limits that do apply to its run are the run's own
   * budget, not a batch's.
   */
  async replayTask(
    storeId: string,
    championTaskId: TaskId,
    options: ReplayTaskOptions,
    callerSessionId: string,
  ): Promise<ReplayRunOutcome> {
    const champion = await this.ctx.task.taskIn(storeId, championTaskId)
    if (champion.status !== 'verified' && champion.status !== 'failed') {
      throw new Error(`task-runtime: champion task "${championTaskId}" is ${champion.status}; only a terminal (verified or failed) task can be replayed`)
    }
    // A verified/failed task always has at least one run; the latest is the
    // champion run the replay's own run descends from (execution lineage).
    const championRunId = champion.runIds[champion.runIds.length - 1]!
    const effective = options.contract ?? {
      objective: champion.objective,
      acceptanceCriteria: champion.acceptanceCriteria,
      requiredCapabilities: champion.requestedCapabilities,
    }
    const table = { ...this.config.capabilities, ...(options.overlay?.capabilityOverrides ?? {}) }
    const manifest = resolveCapabilities(effective.requiredCapabilities, table)
    if (manifest.missing.length > 0) {
      throw new Error(`task-runtime: replay of "${championTaskId}" cannot run: capability gap [${manifest.missing.join(', ')}] under the overlay`)
    }
    const envPath = await this.envPathForSession(callerSessionId)
    // The same provider pre-check the ordinary decomposition runs (S1-C item 1),
    // from the replay caller's checkout and under the overlay's own capability
    // table — the table this replay resolved against, not the configured one.
    // The overlay's extra skill roots are searched first because that is the
    // order the grant registers them in: a candidate skill in the sandbox is
    // what the replayed worker would load. Refused before anything persists.
    const precheck = await this.providerPrecheck(Object.keys(manifest.capabilities), {
      ...(envPath === undefined ? {} : { cwd: envPath }),
      ...(options.overlay?.extraSkillRoots === undefined ? {} : { extraRoots: [...options.overlay.extraSkillRoots] }),
    }, table)
    const refusals = providerRefusals(precheck)
    if (refusals.length > 0) {
      throw new Error(`task-runtime: provider pre-check rejected replay of "${championTaskId}":\n- ${refusals.join('\n- ')}`)
    }
    // The replay path shares the ordinary decomposition's rules: the contract's
    // own structure (T1) and the P4 parent-acceptance declarations (contract 8).
    // Both are structural, both are judged here — before anything persists — and
    // the label names the champion this task stands in for.
    const label = `replay of "${championTaskId}"`
    // Protected acceptance inputs are fixed the same way the ordinary path
    // fixes them (S1-V slice 2), against the replay caller's checkout: the
    // declared (string) form is converted before any rule reads the criteria,
    // and a declaration that cannot be read, or a caller whose checkout cannot
    // be resolved, refuses the replay before anything persists. A champion's
    // stored fixed form is carried verbatim — never re-fixed, never invented —
    // because that historical identity is exactly what the pre-judgement
    // re-check has to compare against.
    const fixed = await fixCriteriaProtectedInputs(
      effective.acceptanceCriteria,
      envPath,
      label,
    )
    const acceptanceDefects = [
      ...fixed.reasons,
      ...contractDefects(fixed.criteria, label),
      ...independentAcceptanceDefects(fixed.criteria, champion.requiresIndependentAcceptance, label),
    ]
    if (acceptanceDefects.length > 0) {
      throw new Error(`task-runtime: replay of "${championTaskId}" rejected:\n- ${acceptanceDefects.join('\n- ')}`)
    }
    this.assertKnownVerifierRefs(
      fixed.criteria.map(criterion => ({ childIndex: 0, criterion })),
      `replay of "${championTaskId}"`,
    )
    // The replayed task's contract: the lineage-tagged objective, the criteria
    // deep-copied (a candidate definition is the caller's object, not the
    // store's), and assumptions/constraints mirrored from the champion's own
    // contract when it has one — a replay runs the same task under a candidate
    // overlay, so the conditions it rests on travel with it. A champion created
    // before contracts existed declared none, and nothing is invented for it.
    const contract: TaskContract = {
      contractVersion: TASK_CONTRACT_VERSION,
      objective: `[${options.lineage}] ${effective.objective}`,
      acceptanceCriteria: structuredClone([...fixed.criteria]),
      assumptions: [...(champion.contract?.assumptions ?? [])],
      constraints: [...(champion.contract?.constraints ?? [])],
      requiredCapabilities: [...effective.requiredCapabilities],
    }
    const task: TaskInstance = {
      taskId: `t-${randomUUID()}`,
      definitionRef: { ...champion.definitionRef },
      objective: contract.objective,
      depth: 0,
      acceptanceCriteria: contract.acceptanceCriteria,
      requestedCapabilities: [...contract.requiredCapabilities],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract,
      ...(champion.requiresIndependentAcceptance === true ? { requiresIndependentAcceptance: true } : {}),
    }
    const spawn = options.spawn !== false
    let prompt: string | undefined
    let contractBlock: string | undefined
    if (spawn) {
      const championRun = await this.ctx.task.runIn(storeId, championRunId)
      // The handoff is in-memory only: the replay task is parentless by design,
      // and the store reducer records a handoff only when the child's
      // parentTaskId names the handoff's parent. The prompt carries the lineage
      // instead. The contract's own assumptions and constraints ride along, so
      // the prompt and the contract block rendered from the same handoff say
      // what the store says: `(none)` there while `task_read` rendered the
      // stored lists would be two views of one contract disagreeing.
      const handoff = buildHandoff({
        parentTask: champion,
        parentRun: championRun,
        childTask: task,
        reason: `${options.lineage}: replay of ${championTaskId} under the candidate's overlay`,
        callerSessionId,
        assumptions: [...contract.assumptions],
        constraints: [...contract.constraints],
        relevantEvidence: [],
      })
      // The prompt never invites a split: a replay re-runs the one task as
      // contracted, whatever the deployment's runtime-decomposition switch says.
      prompt = renderWorkerPrompt(handoff, task, { allowRuntimeDecomposition: false })
      contractBlock = renderWorkerContract(task, handoff)
    }
    // The replay's admission shares the batch's rules (§3.5, §3.4): it starts a
    // run, so the root budget must allow one — counted against the *same* root
    // total the tree spends, because a replay's parentless task shares its
    // funding root rather than getting a fresh allowance — and it writes into
    // the caller's checkout, so that checkout must be the caller's own. Both are
    // checked here, before the task is created, and both refuse with nothing
    // persisted. A budget that cannot be resolved refuses the replay for the
    // same reason the batch entries refuse: a configured hard limit nobody can
    // measure is not a limit this deployment may run without.
    const replaySnapshot = await this.ctx.task.snapshotIn(storeId)
    const replayBudget = resolveRootBudget(replaySnapshot, this.config.rootBudget ?? {})
    if (!replayBudget.ok) {
      if (hasRootLimits(this.config.rootBudget)) {
        throw new Error(`task-runtime: replay of "${championTaskId}" refused: the root budget cannot be resolved: ${replayBudget.reason}`)
      }
    } else {
      const startVerdict = checkRunStart(replaySnapshot, replayBudget)
      if (!startVerdict.allowed) {
        throw new Error(`task-runtime: replay of "${championTaskId}" refused: ${startVerdict.reason}`)
      }
    }
    const workspacePath = await this.workspacePathForSession(callerSessionId)
    const workspaceOwner = workspacePath === undefined
      ? undefined
      : await this.claimReplayWorkspace(workspacePath, storeId, callerSessionId, championTaskId)
    this.replayLineage.set(task.taskId, options.lineage)
    const controller = new AbortController()
    const run = async (): Promise<ReplayRunOutcome> => {
      try {
        return await runReplayTask(await this.orchestrateEnv(callerSessionId, callerSessionId), storeId, {
          task,
          manifest,
          // The pre-check this replay passed: the Run binding (S1-C item 4) records
          // what the replay resolved against without re-running discovery.
          providers: precheck,
          lineage: options.lineage,
          agentPreset: options.overlay?.presetOverride ?? resolvePreset(manifest, this.config.defaultPreset),
          ...(prompt === undefined ? {} : { prompt, contract: contractBlock }),
          ...(options.overlay?.extraSkillRoots === undefined ? {} : { skillRoots: [...options.overlay.extraSkillRoots] }),
          spawn,
          championRunId,
        }, {
          ...(options.signal === undefined ? {} : { admission: options.signal }),
          advance: controller.signal,
        })
      } finally {
        if (workspacePath !== undefined && workspaceOwner !== undefined) await this.releaseReplayWorkspace(workspacePath, workspaceOwner)
      }
    }
    const promise = run()
    // A replay is a driver like a batch is: the runtime owns its progress, so a
    // cancellation or an unload stops it. Its own promise never rejects — the
    // replay settles its run and returns an outcome — and the registration is
    // what `cancelGraph` looks for.
    const driverKey = `replay/${storeId}/${championTaskId}`
    this.registerDriver(driverKey, storeId, controller, promise.then(() => [], () => []))
    try {
      return await promise
    } finally {
      this.drivers.delete(driverKey)
    }
  }

  /**
   * Register one runtime-owned driver (a batch, or a replay) and return at
   * once: the caller's tool call is over, and the work is the runtime's (§3.7).
   *
   * The registered promise is meant never to reject — a driver settles its own
   * failures by failing the run it reports on — so a rejection here is the one
   * failure it could not settle from where it stood: the view of the deployment
   * it was about to build (`orchestrateEnv`). That is still not fire-and-forget
   * (§3.1): the batch's parent run is failed with the cause, the children that
   * never started are blocked, and the owner is told. The belt below stays for a
   * rejection for a key that names no batch (a replay, whose own caller already
   * receives the error), so nothing surfaces as an unhandled rejection.
   */
  private registerDriver(key: string, storeId: string, controller: AbortController, promise: Promise<ChildOutcome[]>): void {
    this.drivers.set(key, { controller, promise, storeId })
    const forget = () => {
      if (this.drivers.get(key)?.controller === controller) this.drivers.delete(key)
    }
    void promise.then(forget, async error => {
      forget()
      const reason = `driver ${key} failed outside its own settlement: ${error instanceof Error ? error.message : String(error)}`
      this.warn(reason)
      await this.failBatchFromRuntime(storeId, key, reason)
    })
  }

  /**
   * Fail one batch's parent run without an `OrchestrateEnv`: the children that
   * never started are blocked, the parent run is failed with the cause, and the
   * owner is told. Store-level on purpose — the caller is here because the env
   * could not be built, so the store service and the notification seam are all
   * this path needs — and it never throws, so a driver's failure cannot become an
   * unhandled rejection of its own.
   */
  private async failBatchFromRuntime(storeId: string, key: string, reason: string): Promise<void> {
    const prefix = `${storeId}/b-`
    if (!key.startsWith(prefix)) return
    const parentTaskId = key.slice(prefix.length) as TaskId
    const actor = `fail-batch:${storeId}`
    try {
      const snapshot = await this.ctx.task.snapshotIn(storeId)
      const parentTask = snapshot.tasks.find(task => task.taskId === parentTaskId)
      const parentRun = [...snapshot.runs].reverse().find(run => run.taskId === parentTaskId && run.status === 'running')
      for (const childTaskId of parentTask?.childTaskIds ?? []) {
        const child = snapshot.tasks.find(task => task.taskId === childTaskId)
        if (child === undefined || child.status === 'verified' || child.status === 'failed' || child.status === 'blocked' || child.status === 'cancelled') continue
        if (snapshot.runs.some(run => run.taskId === childTaskId)) continue
        await this.ctx.task.markRunStatusIn(storeId, childTaskId, undefined as unknown as RunId, 'blocked', actor, { reason })
        await this.ctx.task.recordReviewIn(storeId, {
          taskId: childTaskId,
          outcome: 'blocked',
          evidenceRefs: [],
          anomalies: [reason],
          relatedTaskIds: [parentTaskId],
        }, actor)
      }
      if (parentRun === undefined) return
      await this.ctx.task.markRunStatusIn(storeId, parentTaskId, parentRun.runId, 'failed', actor, { reason })
      await this.ctx.task.recordReviewIn(storeId, {
        taskId: parentTaskId,
        runId: parentRun.runId,
        sessionId: parentRun.sessionId,
        outcome: 'failed',
        evidenceRefs: [],
        anomalies: [reason],
        localizedCause: reason,
        relatedTaskIds: parentTask?.childTaskIds ?? [],
      }, actor)
      this.notify(parentRun.sessionId, `task-runtime: batch ${key.slice(prefix.length - 2)} failed: ${reason}`)
    } catch (error) {
      this.warn(`store ${storeId}: the failed driver ${key} could not be settled (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /**
   * Start the driver for one admitted batch. The controller is registered
   * before the driver runs, so a cancellation arriving immediately after
   * admission finds something to abort.
   */
  private startBatchDriver(options: {
    storeId: string
    parentTaskId: TaskId
    parentRunId: RunId
    batchId: string
    callerSessionId: string
    reason: string
    providers?: ProviderPrecheck
    excludeCallId?: string
  }): void {
    const key = `${options.storeId}/${options.batchId}`
    if (this.drivers.has(key)) return
    const controller = new AbortController()
    const batch: Omit<BatchContext, 'signal'> = {
      storeId: options.storeId,
      parentTaskId: options.parentTaskId,
      parentRunId: options.parentRunId,
      batchId: options.batchId,
      callerSessionId: options.callerSessionId,
      reason: options.reason,
      ...(options.excludeCallId === undefined ? {} : { excludeCallId: options.excludeCallId }),
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    }
    const promise = (async (): Promise<ChildOutcome[]> => {
      const env = await this.orchestrateEnv(options.callerSessionId, options.callerSessionId)
      return await driveBatch(env, { ...batch, signal: controller.signal })
    })()
    this.registerDriver(key, options.storeId, controller, promise)
  }

  /**
   * The explicit submission (A3 §3.2, `task_submit_result`): the worker's own
   * account of what it delivered, recorded as the phase change that closes
   * admission, and then the one settlement path every verified run takes.
   *
   * A submission that arrives twice is answered from the record rather than
   * applied again — the phase event is unique by construction, so the second
   * caller reads the first one's result. A run waiting on its children may not
   * submit at all: its batch has to settle first, and that settlement submits on
   * its behalf.
   */
  async submitResult(
    callerSessionId: string,
    spec: { summary: string; evidenceRefs?: string[]; notes?: string },
    exec: { callId?: string } = {},
  ): Promise<{ status: string; detail: string }> {
    if (spec.summary.trim().length === 0) {
      throw new Error('task-runtime: a submission requires a non-empty summary of what was delivered')
    }
    const { storeId, task, run } = await this.runForSession(callerSessionId)
    if (run.status !== 'running') {
      return {
        status: run.status,
        detail: `run "${run.runId}" is already settled as "${run.status}"; the recorded submission stands and nothing was changed`,
      }
    }
    const phase = run.executionPhase
    if (phase === 'submitted') {
      return {
        status: 'submitted',
        detail:
          `run "${run.runId}" already submitted: ${run.submission?.summary ?? 'a submission is recorded'}` +
          `${run.submission?.submittedAt === undefined ? '' : ` at ${run.submission.submittedAt}`}. ` +
          'Verification is under way (or already recorded); a second submission changes nothing.',
      }
    }
    if (phase === 'waiting_children') {
      throw new Error(
        `task-runtime: run "${run.runId}" is waiting on its child batch (${run.batchId ?? 'unrecorded'}); ` +
        'the batch settles it — a parent cannot submit while its children are still running',
      )
    }
    if (phase === undefined) {
      throw new Error(
        `task-runtime: run "${run.runId}" predates coordination phases; it cannot submit ` +
        '(needs recovery: cancel this task tree and re-create it)',
      )
    }
    const submission: SubmissionRecord = {
      summary: spec.summary,
      evidenceRefs: [...(spec.evidenceRefs ?? [])],
      ...(spec.notes === undefined ? {} : { notes: spec.notes }),
      submittedAt: now(),
      origin: 'worker',
    }
    // Admission closes first (§3.3): this event is what refuses the next write,
    // the next decomposition and a second submission. The drain that follows is
    // only about the calls that were already in flight when it landed.
    await this.ctx.task.changeRunPhaseIn(storeId, task.taskId, run.runId, callerSessionId, { phase: 'submitted', submission })
    this.executionGate.setPhase(callerSessionId, 'submitted')
    const env = await this.orchestrateEnv(callerSessionId, callerSessionId)
    const lineage = this.replayLineage.get(task.taskId)
    const status = await settleSubmittedRun(env, storeId, task.taskId, run.runId, {
      ...(exec.callId === undefined ? {} : { excludeCallId: exec.callId }),
      ...(lineage === undefined ? {} : { anomalies: [lineage] }),
    })
    return {
      status,
      detail:
        status === 'verified'
          ? `run "${run.runId}" submitted and verified.`
          : `run "${run.runId}" submitted and settled ${status}; the terminal review record names why.`,
    }
  }

  /**
   * Cancel one batch (`task_cancel`, §3.6): abort its driver, which settles the
   * children — the one in flight is cancelled, the ones that never started are
   * blocked before start, and the parent run is cancelled — and return that
   * settlement.
   *
   * Only the batch's own parent session may cancel it, and only while the batch
   * is in flight. A batch this process is not driving (already settled, or
   * waiting for recovery after a restart) is refused by name: silently
   * synthesising a settlement would write terminal states the store's own
   * records do not support, and the graph-level cancellation is the entry that
   * covers that case.
   */
  async cancelBatch(storeId: string, batchId: string, callerSessionId: string): Promise<ChildOutcome[]> {
    if (!batchId.startsWith('b-')) {
      throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentTaskId>")`)
    }
    const parentTaskId = batchId.slice(2)
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const parentRun = [...snapshot.runs].reverse().find(run => run.taskId === parentTaskId && run.batchId === batchId)
    if (parentRun === undefined) {
      throw new Error(`task-runtime: batch "${batchId}" is not recorded in store "${storeId}"`)
    }
    if (parentRun.sessionId !== callerSessionId) {
      throw new Error(
        `task-runtime: batch "${batchId}" belongs to session "${parentRun.sessionId}"; session "${callerSessionId}" may not cancel it`,
      )
    }
    if (parentRun.status !== 'running' || parentRun.executionPhase !== 'waiting_children') {
      throw new Error(
        `task-runtime: batch "${batchId}" is not in flight (its parent run is ${parentRun.status}` +
        `${parentRun.executionPhase === undefined ? '' : ` in phase "${parentRun.executionPhase}"`}); there is nothing to cancel`,
      )
    }
    const entry = this.drivers.get(`${storeId}/${batchId}`)
    if (entry === undefined) {
      throw new Error(
        `task-runtime: batch "${batchId}" is not being driven by this process (it may have settled, or it is waiting for recovery); ` +
        'cancel the graph instead',
      )
    }
    entry.controller.abort()
    // The abort reaches the batches this one owns as well: a child that
    // decomposed in turn holds a batch of its own, and leaving its driver parked
    // would keep a grandchild working in the shared checkout this cancellation is
    // about to release, with the children that never started still unblocked
    // (§3.6: the child in flight is stopped, the ones that never started are
    // blocked before start). Awaiting them here is what makes the whole subtree
    // settled by the time this call returns.
    await this.abortDescendantBatches(storeId, parentTaskId)
    // The runs under this batch that are still in flight are settled as cancelled
    // here, rather than left to their aborted drivers: a child inside a
    // verification call stays `running` until its own turn unwinds, and the verdict
    // written in that window would win over a cancellation that was already asked
    // for — the store voids a verdict only for a run it already holds terminal
    // (`settleSubmittedRun`). `cancelGraph` settles the same way, which is why a
    // graph cancellation already voids that verdict.
    await this.settleCancelledDescendants(storeId, parentTaskId, batchId, callerSessionId)
    return await entry.promise
  }

  /**
   * Settle every run below `taskId` that is still in flight as cancelled — the
   * runs this cancellation owns. The batch's own parent run is not settled here:
   * its driver's abort branch does that, with the batch's terminal review and the
   * owner notification.
   */
  private async settleCancelledDescendants(storeId: string, taskId: TaskId, batchId: string, callerSessionId: string): Promise<void> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const parentOf = new Map(snapshot.tasks.map(task => [task.taskId, task.parentTaskId] as const))
    const under = (candidate: TaskId): boolean => {
      for (let current = parentOf.get(candidate); current !== undefined; current = parentOf.get(current)) {
        if (current === taskId) return true
      }
      return false
    }
    const runs = snapshot.runs.filter(run => run.status === 'running' && run.taskId !== taskId && under(run.taskId))
    if (runs.length === 0) return
    const env = await this.orchestrateEnv(callerSessionId, `cancel-batch:${batchId}`)
    for (const run of runs) {
      await settleRunFromRuntime(env, storeId, run, 'cancelled', `the batch was cancelled while this child ran: ${batchId}`)
    }
  }

  /**
   * Abort every batch driver of `storeId` whose parent task is a strict
   * descendant of `taskId`, and wait for their settlements. A batch's driver key
   * carries its parent (`<storeId>/b-<parentTaskId>`), so the subtree is read
   * from the store's own task list and no extra bookkeeping is needed.
   */
  private async abortDescendantBatches(storeId: string, taskId: TaskId): Promise<void> {
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: the batches under "${taskId}" could not be listed (${error instanceof Error ? error.message : String(error)}); only the batch itself was aborted`)
      return
    }
    const parentOf = new Map(snapshot.tasks.map(task => [task.taskId, task.parentTaskId] as const))
    const under = (candidate: TaskId): boolean => {
      for (let current = parentOf.get(candidate); current !== undefined; current = parentOf.get(current)) {
        if (current === taskId) return true
      }
      return false
    }
    const prefix = `${storeId}/b-`
    const entries = [...this.drivers.entries()].filter(([key, driver]) => {
      if (driver.storeId !== storeId || !key.startsWith(prefix)) return false
      const owner = key.slice(prefix.length) as TaskId
      return owner !== taskId && under(owner)
    })
    for (const [, driver] of entries) driver.controller.abort()
    await Promise.all(entries.map(([, driver]) => driver.promise.catch(() => [])))
  }

  /**
   * Cancel everything one store has in flight (§3.6), called by
   * `graphs.remove` before the graph is stopped and exposed as a service API.
   *
   * The order is the promise: the gate closes for every session of the store
   * first (so no further tool call writes anything), then every driver is
   * aborted and awaited (so the children and parents settle through the same
   * rules as a batch cancellation), then the runs that are still non-terminal —
   * a root run with no batch in flight, a replay — are cancelled with the
   * reason recorded, and finally the workspace claim this store held is released
   * and its sessions' managed jobs are reconciled.
   *
   * Idempotent: every step tolerates having already happened, so a second call
   * is a no-op rather than an error.
   */
  async cancelGraph(storeId: string, reason: string): Promise<void> {
    try {
      this.reindex(storeId, await this.ctx.task.snapshotIn(storeId))
    } catch (error) {
      this.warn(`store ${storeId}: it could not be read for the cancellation "${reason}" (${error instanceof Error ? error.message : String(error)}), so nothing was cancelled`)
      return
    }
    for (const [sessionId, binding] of this.sessions) {
      if (binding.storeId === storeId) this.executionGate.setTerminal(sessionId)
    }
    const entries = [...this.drivers.values()].filter(entry => entry.storeId === storeId)
    for (const entry of entries) entry.controller.abort()
    await Promise.all(entries.map(entry => entry.promise.catch(() => [])))

    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const env = await this.orchestrateEnv(this.recoverySessionFor(snapshot, storeId), `cancel-graph:${storeId}`)
    const stillRunning = snapshot.runs.filter(run => run.status === 'running')
    for (const run of stillRunning) {
      await settleRunFromRuntime(env, storeId, run, 'cancelled', `cancelled with the graph: ${reason}`)
    }
    for (const run of stillRunning) await this.reconcileSessionJobs(run.sessionId)
    await this.releaseStoreWorkspace(storeId)
  }

  /**
   * The settlement of one batch, from the outside: the registered driver's own
   * promise when this process is driving it, or the outcomes the store already
   * records when the batch settled earlier (or in another process). §3.8's
   * `awaitBatch` — the entry a test or a service uses to wait for a batch a tool
   * call no longer waits for.
   */
  async awaitBatch(storeId: string, batchId: string): Promise<ChildOutcome[]> {
    if (!batchId.startsWith('b-')) {
      throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentTaskId>")`)
    }
    const entry = this.drivers.get(`${storeId}/${batchId}`)
    if (entry !== undefined) return await entry.promise
    return await deriveChildOutcomes(this.ctx.task, storeId, batchId.slice(2))
  }

  /**
   * The recovery entry (A3 §3.6): settle or restart what a store left in flight.
   * Idempotent, and safe to call on a store this process is already driving —
   * the registered batches are skipped, and runs this process started are left
   * to their own drivers.
   *
   * The order is depth-descending (a child before its parent), so a restarted
   * parent batch reads its children already settled:
   *
   * - a run with no phase is an old record: it is left exactly as it is, and the
   *   read side derives `needs-recovery` from the missing phase — inventing a
   *   phase here would admit a run nobody knows the state of;
   * - a run whose content binding no longer re-reads is failed by name (S1-C's
   *   refusal, never a silent fallback);
   * - `submitted` runs are verified (the phase is the whole recovery evidence);
   * - `active` runs that are not a root are in-flight workers: nothing can
   *   confirm the writes they may have made, so they are cancelled with the
   *   diagnostic — a root run is left alone, because a root legitimately sits
   *   `active` between its own decisions;
   * - `waiting_children` runs are restarted, unless the workspace is held by
   *   another live process, in which case they fail by name rather than writing
   *   into a checkout somebody else owns.
   */
  async reconcileStore(storeId: string): Promise<void> {
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: recovery could not read the store (${error instanceof Error ? error.message : String(error)}), so nothing was reconciled`)
      return
    }
    this.reindex(storeId, snapshot)
    const depthOf = (taskId: TaskId): number => snapshot.tasks.find(task => task.taskId === taskId)?.depth ?? 0
    const ordered = snapshot.runs
      .filter(run => run.status === 'running')
      .sort((left, right) => depthOf(right.taskId) - depthOf(left.taskId))
    const env = await this.orchestrateEnv(this.recoverySessionFor(snapshot, storeId), `recovery:${storeId}`)
    const waiting: TaskRun[] = []

    for (const run of ordered) {
      // Recovery is for the runs nobody in this process holds, and that question
      // is asked per run rather than per store: a store can hold a batch this
      // process is driving *and* a run a dead process left behind (a replay's
      // experiment is started while the tree's own crash is still in the log, and
      // the next adoption has to settle it). Two holders are possible here — this
      // process started the session, or a registered driver owns the batch the run
      // waits on — and either one means the run is live work, not recovery's.
      if (this.startedSessions.has(run.sessionId)) continue
      if (run.batchId !== undefined && this.drivers.has(`${storeId}/${run.batchId}`)) continue
      if (run.executionPhase === undefined) continue
      if (run.providerBinding !== undefined) {
        const read = await this.readRunBinding(run.providerBinding)
        if (read !== undefined && read.defects.length > 0) {
          await settleRunFromRuntime(
            env,
            storeId,
            run,
            'failed',
            `recovery re-check rejected this run's content binding:\n- ${read.defects.join('\n- ')}`,
          )
          continue
        }
      }
      if (run.executionPhase === 'submitted') {
        const lineage = this.replayLineage.get(run.taskId)
        await settleSubmittedRun(env, storeId, run.taskId, run.runId, lineage === undefined ? {} : { anomalies: [lineage] })
        continue
      }
      if (run.executionPhase === 'waiting_children') {
        waiting.push(run)
        continue
      }
      // The one run recovery leaves alone is the store's own root run: its session
      // is the session this store belongs to, and a root legitimately sits `active`
      // between its own decisions. Parentage cannot answer that question — a
      // replay's task is parentless by design (W15 keeps the experiment out of the
      // historical tree) — so the store's own naming is what decides
      // (`rootTaskStoreId`, the mapping the store was opened under).
      if (rootTaskStoreId(run.sessionId) === storeId) continue
      await settleRunFromRuntime(
        env,
        storeId,
        run,
        'cancelled',
        `recovery: run "${run.runId}" was in flight when this store was reopened and never submitted; ` +
        'the writes it may already have made cannot be confirmed, so it is settled cancelled and its managed jobs are reconciled',
      )
      await this.reconcileSessionJobs(run.sessionId)
    }

    if (waiting.length === 0) return
    // Before a single child is started again, the checkout must be this
    // process's to write into (§3.4): a marker a live process holds refuses the
    // restart, and the parents fail naming that holder rather than racing it.
    const sessionId = this.recoverySessionFor(snapshot, storeId)
    const workspace = await this.workspacePathForSession(sessionId)
    if (workspace !== undefined && this.workspaces !== undefined) {
      const adoption = await this.workspaces.ownerOf(workspace) === undefined
        ? await this.workspaces.reconcileAdopt(workspace)
        : { adopted: true as const }
      if (!adoption.adopted) {
        for (const run of waiting) {
          await settleRunFromRuntime(env, storeId, run, 'failed', `the workspace cannot be taken over for recovery: ${adoption.reason}`)
        }
        return
      }
      await this.rebuildWorkspaceOwnership(storeId)
    }
    for (const run of waiting) {
      if (run.batchId === undefined) continue
      this.startBatchDriver({
        storeId,
        parentTaskId: run.taskId,
        parentRunId: run.runId,
        batchId: run.batchId,
        callerSessionId: run.sessionId,
        reason: `recovered batch ${run.batchId} after a restart`,
      })
    }
  }

  /**
   * Rebuild this process's workspace ownership for one store from the store's
   * own state: the root run's own hold, and — when that run is waiting on
   * children — the batch layer its driver hands to each child in turn. A tree
   * whose runs all reached terminal states releases the claim instead, which is
   * what makes a finished tree leave no marker behind.
   */
  private async rebuildWorkspaceOwnership(storeId: string): Promise<void> {
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: its snapshot could not be read (${error instanceof Error ? error.message : String(error)}), so its workspace ownership was left as it is`)
      return
    }
    const rootTask = snapshot.tasks.find(task => task.parentTaskId === undefined)
    if (rootTask === undefined) return
    const rootRun = [...snapshot.runs].reverse().find(run => run.taskId === rootTask.taskId && run.status === 'running')
    const workspace = rootRun === undefined ? undefined : await this.workspacePathForSession(rootRun.sessionId)
    if (workspace === undefined || this.workspaces === undefined) return
    if (rootRun === undefined) {
      await this.releaseStoreWorkspace(storeId)
      return
    }
    let held = this.workspaces.ownerOf(workspace)
    if (held === undefined) {
      const adoption = await this.workspaces.reconcileAdopt(workspace)
      if (!adoption.adopted) {
        this.warn(`store ${storeId}: the workspace cannot be taken over (${adoption.reason})`)
        return
      }
      await this.workspaces.claim(workspace, {
        kind: 'run',
        storeId,
        taskId: rootTask.taskId,
        runId: rootRun.runId,
        since: now(),
      })
      held = this.workspaces.ownerOf(workspace)
    }
    if (held === undefined || held.kind !== 'run' || held.storeId !== storeId || held.runId !== rootRun.runId) {
      this.warn(
        `store ${storeId}: the workspace ${workspace} is held by ` +
        `${held === undefined ? 'nobody in this process' : `${held.kind} ${held.storeId}/${held.runId ?? held.batchId ?? ''}`}, ` +
        `not by its root run ${rootRun.runId}; ownership is left as it is`,
      )
      return
    }
    if (rootRun.executionPhase !== 'waiting_children' || rootRun.batchId === undefined) return
    await this.workspaces.push(workspace, held, {
      kind: 'batch',
      storeId,
      taskId: rootTask.taskId,
      batchId: rootRun.batchId,
      since: now(),
    })
  }

  /** Release every layer this process holds for one store's workspace, naming any layer that is not the store's. */
  private async releaseStoreWorkspace(storeId: string): Promise<void> {
    if (this.workspaces === undefined) return
    const sessionId = this.recoverySessionFor(undefined, storeId)
    const workspace = await this.workspacePathForSession(sessionId)
    if (workspace === undefined) return
    for (;;) {
      const top = this.workspaces.ownerOf(workspace)
      if (top === undefined) return
      if (top.storeId !== storeId) {
        this.warn(
          `workspace ${workspace} holds a layer of store ${top.storeId} (${top.kind}) while store ${storeId} is being cancelled; ` +
          'only this process\'s own layers are released here',
        )
        return
      }
      await this.workspaces.release(workspace, top)
    }
  }

  /**
   * The fallback batch-failure seam the orchestration calls when a run's own
   * settlement cannot finish the batch (verification unavailable in a nested
   * submission): every child that is not terminal is blocked, the parent run is
   * failed with the reason, and the batch's driver is aborted so its own loop
   * stops seeing work that no longer exists.
   */
  private async failBatch(storeId: string, batchId: string, reason: string): Promise<void> {
    const parentTaskId = batchId.startsWith('b-') ? batchId.slice(2) : undefined
    if (parentTaskId === undefined) return
    const entry = this.drivers.get(`${storeId}/${batchId}`)
    entry?.controller.abort()
    const env = await this.orchestrateEnv(await this.sessionForStore(storeId), `fail-batch:${storeId}`)
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const parentTask = snapshot.tasks.find(task => task.taskId === parentTaskId)
    if (parentTask === undefined) return
    for (const childTaskId of parentTask.childTaskIds) {
      const child = snapshot.tasks.find(task => task.taskId === childTaskId)
      if (child === undefined || child.status === 'verified' || child.status === 'failed' || child.status === 'blocked' || child.status === 'cancelled') continue
      if (snapshot.runs.some(run => run.taskId === childTaskId)) continue
      await env.task.markRunStatusIn(storeId, childTaskId, undefined as unknown as RunId, 'blocked', env.actor, { reason })
      await env.task.recordReviewIn(storeId, {
        taskId: childTaskId,
        outcome: 'blocked',
        evidenceRefs: [],
        anomalies: [reason],
        relatedTaskIds: [parentTaskId],
      }, env.actor)
    }
    const parentRun = [...snapshot.runs].reverse().find(run => run.taskId === parentTaskId && run.batchId === batchId)
    if (parentRun === undefined || parentRun.status !== 'running') return
    await settleRunFromRuntime(env, storeId, parentRun, 'failed', reason)
  }

  /** The session whose viewpoint a store-wide operation (recovery, cancellation) resolves its checkout from. */
  private recoverySessionFor(snapshot: TaskSnapshot | undefined, storeId: string): string {
    const rootRun = snapshot?.runs.find(run => run.taskId === snapshot.tasks.find(task => task.parentTaskId === undefined)?.taskId)
    if (rootRun !== undefined) return rootRun.sessionId
    for (const [sessionId, binding] of this.sessions) {
      if (binding.storeId === storeId) return sessionId
    }
    return storeId
  }

  /** Any session bound to this store, for the seams that only need a viewpoint (never `storeId` if one exists). */
  private async sessionForStore(storeId: string): Promise<string> {
    try {
      return this.recoverySessionFor(await this.ctx.task.snapshotIn(storeId), storeId)
    } catch {
      return storeId
    }
  }

  /** Reverse lookup: the task run a (worker) session is bound to. */
  async runForSession(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
    const found = await this.lookupRun(sessionId)
    if (found === undefined) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`)
    return found
  }

  private async lookupRun(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
    const binding = this.sessions.get(sessionId)
    if (binding !== undefined) {
      const resolved = await this.resolveBinding(binding)
      if (resolved !== undefined) return resolved
      this.sessions.delete(sessionId)
    }
    let rootSessionId: string
    try {
      const graph = await this.ctx.graphs.graphForSession(SessionId(sessionId))
      rootSessionId = graph.rootSessionId
    } catch {
      return undefined
    }
    const storeId = rootTaskStoreId(rootSessionId)
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.openStore(storeId)
      this.reindex(storeId, snapshot)
    } catch {
      return undefined
    }
    // Opening a store this process was not driving is the recovery entry: a run
    // the previous process left in flight is settled or restarted before this
    // lookup hands the caller a run to work with (§3.6).
    try {
      await this.reconcileStore(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: recovery after opening the store failed (${error instanceof Error ? error.message : String(error)})`)
    }
    const rebinding = this.sessions.get(sessionId)
    if (rebinding === undefined) return undefined
    return this.resolveBinding(rebinding)
  }

  private async resolveBinding(binding: RunBinding): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
    try {
      const [task, run] = await Promise.all([
        this.ctx.task.taskIn(binding.storeId, binding.taskId),
        this.ctx.task.runIn(binding.storeId, binding.runId),
      ])
      return { storeId: binding.storeId, task, run }
    } catch {
      return undefined
    }
  }

  private reindex(storeId: string, snapshot: TaskSnapshot): void {
    for (const run of snapshot.runs) {
      this.sessions.set(run.sessionId, { storeId, taskId: run.taskId, runId: run.runId })
    }
  }

  /* --- workspace ownership (§3.4) ----------------------------------------- */

  /**
   * The checkout one session's runs work in, in the form ownership keys it:
   * the graph env's path, resolved to its real path so two spellings of one
   * directory cannot become two markers ({@link normalizeWorkspacePath}).
   *
   * `undefined` means this deployment cannot name a checkout — no env-builder,
   * no graph, or a path that does not resolve — and ownership is skipped rather
   * than guessed, which is the honest reading of §3.4's `unbound`.
   */
  private async workspacePathForSession(sessionId: string): Promise<string | undefined> {
    const path = await this.envPathForSession(sessionId)
    if (path === undefined) return undefined
    try {
      return await normalizeWorkspacePath(path)
    } catch (error) {
      this.warn(`workspace ownership is skipped for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Refuse a decomposition whose caller does not hold its own checkout. The
   * holder may be the parent run itself (the ordinary case: a run works in its
   * checkout and hands it down), a batch the runtime holds between children, or
   * an ancestor run of this one — the chain a nested child sits on. Anything
   * else is another writer, and the batch is refused *before* anything is
   * written ({@link WorkspaceBusyError} carries the holder and since when).
   */
  private async assertWorkspaceHeldBy(workspace: string, storeId: string, parentTask: TaskInstance, parentRunId: RunId): Promise<void> {
    if (this.workspaces === undefined) return
    const top = this.workspaces.ownerOf(workspace)
    if (top === undefined) {
      throw new WorkspaceBusyError(
        workspace,
        undefined,
        undefined,
        `store ${storeId} does not hold this workspace in this process; the run ${parentRunId} would be writing into a checkout ` +
        'nobody claimed (claim it through the graph entry, or resolve the ownership marker first)',
      )
    }
    if (top.storeId !== storeId) {
      throw new WorkspaceBusyError(workspace, top, top.since, `it is held by another store (${top.storeId}), not by ${storeId}`)
    }
    if (top.taskId === parentTask.taskId) return
    // An ancestor of this task holds it: the delegation chain the nested-child
    // case walks (a grandchild's own decomposition happens under its parent's
    // own hold).
    let ancestor = parentTask.parentTaskId
    while (ancestor !== undefined) {
      if (top.taskId === ancestor) return
      ancestor = await this.ancestorTaskIdFor(storeId, ancestor)
    }
    throw new WorkspaceBusyError(
      workspace,
      top,
      top.since,
      `it is held by ${top.kind} ${top.taskId ?? top.batchId ?? ''}, which is not run ${parentRunId}'s own run, its batch, or one of its ancestors`,
    )
  }

  /** The parent task id of one task, read from the store; `undefined` when the store cannot answer. */
  private async ancestorTaskIdFor(storeId: string, taskId: TaskId): Promise<TaskId | undefined> {
    try {
      return (await this.ctx.task.taskIn(storeId, taskId)).parentTaskId
    } catch {
      return undefined
    }
  }

  /**
   * Take the checkout for one replay run: an unheld workspace is claimed, and a
   * workspace the *caller's own* tree already holds is handed over (the replay
   * run writes where its caller writes). Any other holder is a conflict, and the
   * replay refuses before its task is created.
   */
  private async claimReplayWorkspace(
    workspace: string,
    storeId: string,
    callerSessionId: string,
    championTaskId: TaskId,
  ): Promise<WorkspaceOwner> {
    const registry = this.workspaces
    if (registry === undefined) throw new Error('task-runtime: the workspace registry is not initialized')
    const owner: WorkspaceOwner = {
      kind: 'run',
      storeId,
      runId: `replay-of-${championTaskId}`,
      since: now(),
    }
    const top = registry.ownerOf(workspace)
    if (top === undefined) {
      await registry.claim(workspace, owner)
      return registry.ownerOf(workspace) ?? owner
    }
    const callerRunId = this.sessions.get(callerSessionId)?.runId
    const callerHolds = callerRunId !== undefined && top.storeId === storeId && top.runId === callerRunId
    if (!callerHolds) {
      throw new WorkspaceBusyError(
        workspace,
        top,
        top.since,
        `a replay from session ${callerSessionId} cannot write into a checkout held by ${top.kind} ${top.taskId ?? top.batchId ?? ''}`,
      )
    }
    await registry.push(workspace, top, owner)
    return owner
  }

  /** Release the replay's own layer, leaving whatever the caller held in place. */
  private async releaseReplayWorkspace(workspace: string, owner: WorkspaceOwner): Promise<void> {
    const registry = this.workspaces
    if (registry === undefined) return
    const { conflict } = await releaseLayer(registry, workspace, top =>
      top.kind === owner.kind && top.runId === owner.runId && top.storeId === owner.storeId)
    if (conflict !== undefined) {
      this.warn(`workspace ${workspace} was expected to hold the replay layer ${owner.runId ?? ''}, but holds ${describeOwner(conflict)}`)
    }
  }

  /* --- notifications and managed jobs ------------------------------------- */

  /**
   * Best-effort owner notification through the live agent (A3 §3.1, DSH's
   * tool-jobs precedent: a `plugin`-sourced `notice`). A session with no live
   * agent — a worker that already left, a headless test context — is skipped,
   * and a failing follow-up never fails the settlement that reports it.
   */
  private notify(sessionId: string, text: string): void {
    const agent = this.agentOrUndefined(sessionId) as { followup?: (message: unknown) => void } | undefined
    if (agent === undefined || typeof agent.followup !== 'function') return
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'task-runtime', form: 'notice', summary: boundContextSummary(text) },
      }))
    } catch (error) {
      this.warn(`could not notify session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Kill and confirm one session's managed jobs — the half of the write
   * convergence a cancellation owes its checkout. A deployment with no jobs
   * service, or a session whose agent is gone, has nothing to reconcile, and
   * the drain's own report is what a caller reads as "not confirmed".
   */
  private async reconcileSessionJobs(sessionId: string): Promise<void> {
    const jobs = this.softService<JobsView>('jobs')
    const agent = this.agentOrUndefined(sessionId)
    if (jobs === undefined || agent === undefined) return
    const drained: DrainResult = await drainSession(this.executionGate, sessionId, {
      timeoutMs: this.config.writeDrainTimeoutMs,
      jobs,
      agent,
    })
    if (!drained.confirmed) {
      this.warn(`session ${sessionId}: managed work was not confirmed stopped: ${drained.pending.join('; ')}`)
    }
  }

  /**
   * The limits one batch is admitted under (T1, construction guide §4),
   * recorded with the decomposition and never derived from the contract: the
   * contract's own text has no field that can raise a limit, and every value
   * here is resolved from this runtime's configuration at admission time.
   *
   * Only the keys the deployment actually defined are included. `wallTimeMs`
   * and the `auditOnly` trio are one record apart on purpose — a reader has to
   * be able to tell which ceiling would have stopped the run — and an absent
   * `tokens` (this deployment ships no default for it, see {@link BudgetConfig})
   * means there is no token ceiling to record at all.
   */
  private admissionContext(): AdmissionContext {
    const budget = this.config.budget
    return {
      maxDepth: this.config.maxDepth,
      maxChildren: this.config.maxChildren,
      ...(budget.wallTimeMs === undefined ? {} : { wallTimeMs: budget.wallTimeMs }),
      auditOnly: {
        ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls }),
        ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
        ...(budget.attempts === undefined ? {} : { attempts: budget.attempts }),
      },
    }
  }

  /**
   * The env binding the session's graph runs in, or `undefined` when the
   * deployment mounts no env-builder or the graph cannot be read. Best-effort
   * by contract: every caller decides what an unresolved env means — a
   * verification command without `cwd`, a refused composition of MCP servers, a
   * refused batch when a protected input has to be fixed — and none of them may
   * guess one.
   */
  private async sessionEnv(
    sessionId: string,
  ): Promise<{ path: string; components?: readonly { repo: string; dir: string }[] } | undefined> {
    // The whole resolution sits inside the `try`, service lookup included: on a
    // real Cordis context an absent service throws on property access
    // ("cannot get property … without inject"), which is exactly the case this
    // helper has to read as "no env binding" rather than propagate — a
    // deployment without env-builder still runs tasks, it just cannot name a
    // checkout.
    try {
      const envBuilder = (this.ctx.get?.('envBuilder') ?? (this.ctx as unknown as { envBuilder?: EnvPathSource }).envBuilder) as
        | EnvPathSource
        | undefined
      if (envBuilder === undefined) return undefined
      const graph = await this.ctx.graphs.graphForSession(SessionId(sessionId))
      return envBuilder.store.get(graph.envId)
    } catch {
      return undefined
    }
  }

  /**
   * The session's checkout directory: the one directory a run's commands, a
   * verifier's `cwd`, and a protected acceptance input's bytes are all resolved
   * against. `undefined` means the deployment cannot name it — the caller
   * refuses rather than fixing an identity against a base it does not know
   * ({@link fixProtectedInputs}).
   */
  private async envPathForSession(sessionId: string): Promise<string | undefined> {
    return (await this.sessionEnv(sessionId))?.path
  }

  /**
   * The single refusal text a decomposition batch is rejected at the contract
   * stage with, whichever step produced the reasons (the protected-input fixing
   * or the normalization entry): a caller reads one message shape and one
   * reason-per-bullet list, and the label names the parent the batch was
   * refused for.
   */
  private contractRefusal(parentTaskId: TaskId, reasons: readonly string[]): Error {
    return new Error(`task-runtime: contract rejected decomposition of "${parentTaskId}":\n- ${reasons.join('\n- ')}`)
  }

  /**
   * The service-supplied seam the orchestration runs against (A3 §3.1). Every
   * piece of the protocol that needs the process — the gate, the workspace
   * registry, the notifications, the run watcher, the jobs service, the root
   * budget — enters through here, which is what keeps `orchestrate.ts` free of
   * cordis types and testable as the state machine it is.
   *
   * The checkout is resolved once per construction ({@link workspacePathForSession}):
   * the caller's session is the viewpoint every path in this env shares — the
   * verifier's `cwd`, the protected inputs' base, the skills' discovery root and
   * the workspace ownership key are one directory.
   */
  private async orchestrateEnv(callerSessionId: string, actor: string): Promise<OrchestrateEnv> {
    const workspacePath = await this.workspacePathForSession(callerSessionId)
    return {
      task: this.ctx.task,
      actor,
      ...(this.config.defaultPreset !== undefined ? { defaultPreset: this.config.defaultPreset } : {}),
      ...(this.config.runBindingRoot === undefined ? {} : { runBindingRoot: this.config.runBindingRoot }),
      verifyTimeoutMs: this.config.verifyTimeoutMs,
      budget: { ...this.config.budget },
      allowRuntimeDecomposition: this.config.allowRuntimeDecomposition,
      gate: this.executionGate,
      workspaces: this.workspaces,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      noProgressRounds: this.config.noProgressRounds,
      writeDrainTimeoutMs: this.config.writeDrainTimeoutMs,
      ...(this.config.rootBudget === undefined ? {} : { rootBudget: { ...this.config.rootBudget } }),
      precheck: (capabilities, cwd) =>
        this.providerPrecheck(capabilities, { ...(cwd === undefined ? {} : { cwd }) }),
      notify: (sessionId, text) => {
        this.notify(sessionId, text)
      },
      watchRun: (storeId, runId, callback) => this.watchRun(storeId, runId, callback),
      agentFor: sessionId => this.agentOrUndefined(sessionId),
      jobs: this.softService<JobsView>('jobs'),
      onRunSettled: (storeId, taskId, runId, status) => {
        void status
        // The gate closes for the session whose run just settled — a late write
        // from a settled run is exactly what §2's last matrix row refuses — and
        // the workspace layer the run held comes off the stack.
        const sessionId = this.sessionBoundInProcess(storeId, runId)
        if (sessionId === undefined) return
        this.executionGate.setTerminal(sessionId)
        void this.releaseRunWorkspaceLayer(storeId, runId, sessionId).catch(error => {
          this.warn(`run ${runId}: the workspace layer it held could not be released (${error instanceof Error ? error.message : String(error)})`)
        })
      },
      failBatch: (storeId, batchId, reason) => this.failBatch(storeId, batchId, reason),
      assertPreset: async preset => {
        // The same registry agentRuntime.spawn mounts through; absent only in test contexts.
        const presets = (this.ctx.get?.('agentPresets') ?? (this.ctx as unknown as { agentPresets?: AgentPresetRegistry }).agentPresets) as
          | AgentPresetRegistry
          | undefined
        if (presets === undefined) return
        await presets.resolve(preset)
      },
      resolvePermissionSpec: name => {
        // The same registry agentRuntime.spawn switches through; absent only in test contexts.
        const presets = (this.ctx.get?.('permissionPresets') ?? (this.ctx as unknown as { permissionPresets?: PermissionPresetRegistry }).permissionPresets) as
          | PermissionPresetRegistry
          | undefined
        if (presets === undefined) throw new Error('task-runtime: permissionPresets service is not loaded; cannot rank declared permissions')
        return presets.resolve(name)
      },
      resolveMcpEnv: async () => {
        // The same graph env the verifier's cwd comes from; absent in test
        // contexts and in deployments without env-builder — a capability that
        // declares MCP servers then fails the spawn loudly (mcp-servers.ts).
        const env = await this.sessionEnv(callerSessionId)
        if (env === undefined) return undefined
        return {
          envRoot: env.path,
          checkout: repo => {
            const component = (env.components ?? []).find(item => item.repo === repo)
            return component === undefined ? undefined : join(env.path, component.dir)
          },
        }
      },
      spawn: request => {
        const parent = this.liveAgent(callerSessionId)
        return this.ctx.agentRuntime.spawn(parent, {
          sessionId: SessionId(request.sessionId),
          name: request.name,
          prompt: [{ type: 'text', text: request.prompt }],
          ...(request.contract !== undefined ? { contract: request.contract } : {}),
          ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
          ...(request.permissionPreset !== undefined ? { permissionPreset: request.permissionPreset } : {}),
          ...(request.grant !== undefined ? { grant: request.grant } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      },
      verifyRun: async (storeId, runId, options = {}) => {
        const verifier = this.runVerifier()
        if (verifier === undefined || typeof verifier.verifyRun !== 'function') {
          throw new VerifierUnavailableError(
            `task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`,
          )
        }
        const cwd = await this.envPathForSession(callerSessionId)
        return verifier.verifyRun(storeId, runId, { ...(cwd === undefined ? {} : { cwd }), ...options })
      },
      readLogTail: async logRef => this.runVerifier()?.logTail?.(logRef),
      observeSession: async sessionId => this.observeSession(sessionId),
      onRunBound: (sessionId, binding) => {
        this.sessions.set(sessionId, binding)
        this.startedSessions.add(sessionId)
      },
    }
  }

  /**
   * Observe one run's terminal transition (A3 §3.1) over the task service's own
   * `task/change` event: subscribe first, then read the current status, so a run
   * that settled between the caller's read and this subscription is reported
   * rather than missed. The returned function unsubscribes.
   *
   * A deployment with no event bus (a minimal context) cannot promise the
   * observer anything, and the returned no-op says so by leaving the caller's
   * own timeout in charge.
   */
  private watchRun(storeId: string, runId: RunId, callback: (status: RunStatus) => void): () => void {
    const listeners: Array<() => void> = []
    const notifyFrom = async (snapshot: TaskSnapshot): Promise<void> => {
      const run = snapshot.runs.find(candidate => candidate.runId === runId)
      if (run === undefined || run.status === 'running') return
      callback(run.status)
    }
    try {
      const off = this.ctx.on('task/change', (snapshot: TaskSnapshot) => {
        if (snapshot.id !== storeId) return
        void notifyFrom(snapshot)
      })
      if (typeof off === 'function') listeners.push(off)
    } catch (error) {
      this.warn(`cannot subscribe to task/change for store ${storeId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    void (async () => {
      try {
        await notifyFrom(await this.ctx.task.snapshotIn(storeId))
      } catch {
        // A store that cannot be read here is reported by the caller's own wait
        // (the terminal read it does first), not by this observer.
      }
    })()
    return () => {
      for (const off of listeners) off()
    }
  }

  /** The session this process binds to one run, or `undefined` when the run was never bound here. */
  private sessionBoundInProcess(storeId: string, runId: RunId): string | undefined {
    for (const [sessionId, binding] of this.sessions) {
      if (binding.storeId === storeId && binding.runId === runId) return sessionId
    }
    return undefined
  }

  /** Release the workspace layer one settled run held, never popping a stranger's layer. */
  private async releaseRunWorkspaceLayer(storeId: string, runId: RunId, sessionId: string): Promise<void> {
    const workspace = await this.workspacePathForSession(sessionId)
    if (workspace === undefined || this.workspaces === undefined) return
    await releaseLayer(this.workspaces, workspace, top => top.kind === 'run' && top.storeId === storeId && top.runId === runId)
  }

  /**
   * One best-effort read of a run's session for the review record's dimensions
   * and effort metrics (§2.7.3): the session's token projection plus one scan of
   * its log. Every source is optional — a deployment that mounts no
   * `sessionProjections`/`sessionQuery`, or a session that is no longer live,
   * yields `undefined` and the record omits those fields rather than filling
   * them with zeros.
   *
   * The log comes from `sessionQuery.readSession`, not `listEvents`: the
   * lightweight records carry only the event type, while tool names, failure
   * flags, `approval/asked` call ids and skill arguments all live in the event
   * data. One read feeds every counter below.
   *
   * Human interventions count once per interaction: `approval/asked` events,
   * plus human-tool calls whose call id no approval event already covers —
   * `hitl_approve` asks through `ctx.approval`, so counting its tool call too
   * would double that interaction. `hitl_ask` and `ask_user_question` ask
   * through `ctx.userQuestions`, which writes no session event, so their tool
   * call is the only trace.
   */
  private async observeSession(sessionId: string): Promise<SessionObservation | undefined> {
    const tokens = this.sessionTokens(sessionId)
    const events = await this.sessionEvents(sessionId)
    if (tokens === undefined && events === undefined) return undefined

    const calls = new Map<string, number>()
    const humanCallIds: string[] = []
    const approvalCallIds = new Set<string>()
    const skillCalls: string[] = []
    let failures = 0
    let approvals = 0
    let compactions = 0
    for (const event of events ?? []) {
      if (event.type === 'tool/call') {
        const name = event.data.name
        if (typeof name !== 'string') continue
        calls.set(name, (calls.get(name) ?? 0) + 1)
        if (HUMAN_TOOLS.has(name)) humanCallIds.push(String(event.data.callId))
        if (name === 'skill') {
          const skill = skillNameFrom(event.data.arguments)
          if (skill !== undefined) skillCalls.push(skill)
        }
      } else if (event.type === 'tool/result') {
        if (toolResultFailed(event.data)) failures += 1
      } else if (event.type === 'approval/asked') {
        approvals += 1
        if (typeof event.data.callId === 'string') approvalCallIds.add(event.data.callId)
      } else if (event.type === 'compaction/start') {
        compactions += 1
      }
    }

    const tools = events === undefined
      ? undefined
      : {
        calls: [...calls]
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        failures,
      }
    return {
      ...(tokens === undefined ? {} : { tokens }),
      ...(tools === undefined ? {} : { tools }),
      ...(events === undefined ? {} : { skillCalls }),
      ...(events === undefined
        ? {}
        : { humanInterventions: approvals + humanCallIds.filter(id => !approvalCallIds.has(id)).length }),
      ...(events === undefined ? {} : { compactions }),
    }
  }

  /** The session's folded `tokenUsage` buckets, when both the session and the projection registry are reachable. */
  private sessionTokens(sessionId: string): ReviewTokenUsage | undefined {
    const sessions = this.softService<LiveSessionLookup>('sessions')
    const projections = this.softService<SessionProjectionSource>('sessionProjections')
    if (sessions === undefined || projections === undefined) return undefined
    try {
      const session = sessions.get(SessionId(sessionId))
      if (session === undefined) return undefined
      return tokenUsageOf(projections.snapshot(session as never, ['tokenUsage']).values.tokenUsage)
    } catch {
      return undefined
    }
  }

  /** One replay-validated raw log read; an absent reader or a load failure yields `undefined`. */
  private async sessionEvents(sessionId: string): Promise<readonly SessionEvent[] | undefined> {
    const query = this.softService<SessionLogSource>('sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') return undefined
    try {
      return (await query.readSession(SessionId(sessionId))).events
    } catch {
      return undefined
    }
  }

  /**
   * Resolve an optional service by name, the same soft pattern this module
   * already uses for the verifier and the agent registry: the service may be
   * absent in test contexts and in deployments that mount a smaller bundle.
   */
  private softService<T>(name: string): T | undefined {
    return optionalService<T>(this.ctx, name)
  }

  /** The verifier service is an optional plugin; resolve it softly, never import the package. */
  private runVerifier(): RunVerifier | undefined {
    return (this.ctx.get?.('verifier') ?? (this.ctx as unknown as { verifier?: RunVerifier }).verifier) as RunVerifier | undefined
  }

  /**
   * The registered verifier vocabulary one provider pre-check judges execution
   * sidecars against — `registeredVerifierIds` in `./provider-precheck.ts`, the
   * one implementation every provider check shares, with the reasoning for
   * `ready()`-first and for the fail-closed `undefined` documented there.
   */
  private async registeredVerifierIds(): Promise<readonly string[] | undefined> {
    return registeredVerifierIds(this.ctx)
  }

  /**
   * The provider pre-check (S1-C item 1) over the given capability rows, run
   * against the effective table unless `table` replaces it (the replay overlay).
   * Read-only: it discovers skill directories and reads them, writes nothing,
   * and returns every refusal as a verdict rather than throwing.
   */
  private async providerPrecheck(
    capabilities: readonly string[],
    view: SkillDiscoveryView,
    table: Readonly<Record<string, CapabilityConfig>> = this.config.capabilities,
  ): Promise<ProviderPrecheck> {
    const verifierRefs = await this.registeredVerifierIds()
    return precheckProviders({
      capabilities,
      table,
      view,
      ...(verifierRefs === undefined ? {} : { verifierRefs }),
    })
  }

  /**
   * The provider verdicts for the capability rows in play, discovered from one
   * session's own viewpoint — the read-only entry `capability_list` renders
   * (guide §2.3 item 1: the model sees the pre-check's conclusion before it
   * dispatches, not only after admission refused its batch). Nothing is thrown
   * for an unusable provider: the verdict says what is wrong with it, and the
   * caller renders that.
   *
   * `capabilities` names the rows to check; omitting it checks every row of the
   * effective table. A caller that wants the verdicts a *batch* resolved
   * against should pass its matched rows — the revision then describes exactly
   * what admission judged. Two things this recompute cannot reproduce, which is
   * why admission carries its own result with the batch (S1-C item 4): the
   * replay overlay's replaced table, and the bytes as they were at admission.
   */
  async capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheck> {
    const envPath = await this.envPathForSession(sessionId)
    return this.providerPrecheck(capabilities ?? Object.keys(this.config.capabilities), {
      ...(envPath === undefined ? {} : { cwd: envPath }),
    })
  }

  /**
   * Re-check the content a run's binding recorded against the bytes its snapshot
   * holds now (S1-C item 4) — the read a historical view (`task_read`) and a
   * re-entry (`createRootTask` adopting an existing run) both perform before
   * trusting the record.
   *
   * `undefined` means the record names no snapshot: a run that loaded no content
   * has nothing to re-read, which is not the same as content that failed to
   * re-read. A caller that gets a report must look at its `defects`: content
   * that is not readable as bound is reported by name and is never substituted
   * with whatever the production path holds now.
   */
  async readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined> {
    return readRunBinding(binding)
  }

  /**
   * verifierRef validation at creation/decomposition time, never spawn time
   * (KISS §4.1 `verifier_ref`): every declared ref must name a registered
   * verifier, or the whole batch is rejected before anything is persisted and
   * the error lists the registered ids. A deployment whose verifier service is
   * absent or cannot list its registry cannot make that promise, so a declared
   * ref fails loudly there instead of passing through unchecked.
   */
  private assertKnownVerifierRefs(
    declared: readonly { childIndex: number; criterion: AcceptanceCriterion }[],
    what: string,
  ): void {
    const refs = declared.filter(item => item.criterion.verifierRef !== undefined)
    if (refs.length === 0) return
    const registered = this.runVerifier()?.verifierIds?.()
    if (registered === undefined) {
      throw new VerifierUnavailableError(
        `task-runtime: cannot validate verifierRef on ${what}: the verifier service is not loaded or cannot list its registry`,
      )
    }
    const unknown = refs.filter(item => !registered.includes(item.criterion.verifierRef as string))
    if (unknown.length === 0) return
    const detail = unknown
      .map(item => `child ${item.childIndex} criterion "${item.criterion.criterionId}" references unknown verifier "${item.criterion.verifierRef}"`)
      .join('; ')
    throw new Error(`task-runtime: admission rejected ${what}: ${detail}; registered verifiers: ${registered.join(', ')}`)
  }

  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent(sessionId: string): Agent {
    const agent = this.agentOrUndefined(sessionId)
    if (agent === undefined) {
      throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`)
    }
    return agent
  }

  /**
   * The live agent behind one session, or `undefined` — the non-throwing half of
   * {@link liveAgent}, for the seams where an absent agent is a legitimate state
   * (a notification nobody can receive, a jobs call with no owner) rather than a
   * refusal.
   */
  private agentOrUndefined(sessionId: string): Agent | undefined {
    const registry = (this.ctx.get?.('agents') ?? (this.ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents) as
      | { get(id: string): Agent | undefined }
      | undefined
    if (registry === undefined) return undefined
    try {
      return registry.get(sessionId)
    } catch {
      return undefined
    }
  }
}

export default TaskRuntime
