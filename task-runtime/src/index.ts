/**
 * Task runtime: capability resolution, decomposition admission, sequential run
 * orchestration on the agent-runtime spawn seam, and worker handoff rendering.
 * @module dsh-singularity-task-runtime
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
  ReviewTokenUsage,
  RunId,
  RunProviderBinding,
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
import { optionalService, precheckProviders, precheckReplacedCapabilityRow, providerDefectLines, providerRefusals, registeredVerifierIds } from './provider-precheck.ts'
import type { ProviderPrecheck, SkillDiscoveryView } from './provider-precheck.ts'
import { bindRunProviders, defaultRunBindingRoot, readRunBinding } from './run-binding.ts'
import type { RunBindingRead } from './run-binding.ts'
import { buildHandoff, renderWorkerPrompt } from './handoff.ts'
import { normalizeDecomposition } from './normalize.ts'
import {
  fixCriteriaProtectedInputs,
  fixSpecProtectedInputs,
} from './protected-inputs.ts'
import {
  runChildrenCascade,
  runReplayTask,
  VerifierUnavailableError,
  escalationHint,
  type BudgetConfig,
  type ChildOutcome,
  type ChildPlan,
  type OrchestrateEnv,
  type ReplayOverlay,
  type ReplayRunOutcome,
  type SessionObservation,
  type VerifyRunOptions,
} from './orchestrate.ts'
import { renderWorkerContract } from './contract.ts'

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
  BudgetConfig,
  ChildOutcome,
  ChildPlan,
  OrchestrateEnv,
  ReplayOverlay,
  ReplayRunInit,
  ReplayRunOutcome,
  SessionObservation,
  SpawnChildRequest,
  VerifyRunOptions,
} from './orchestrate.ts'
export { runChildrenCascade, runReplayTask, VerifierUnavailableError, escalationHint } from './orchestrate.ts'

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
   * No-progress rounds before the loop must escalate (KISS §5: `no_progress(3轮)`).
   * **Declared, not enforced**: the orchestrator awaits a worker's terminal
   * idle and has no per-round observation seam on an in-flight run, so there
   * is nothing honest to count rounds against yet.
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

/** The shipped no-progress round count (KISS §5's `no_progress(3轮)`); declared, not enforced — see {@link Config.noProgressRounds}. */
export const DEFAULT_NO_PROGRESS_ROUNDS = 3

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

function now(): string {
  return new Date().toISOString()
}

export class TaskRuntime extends Service {
  static inject = ['task', 'agentRuntime', 'graphs']
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions = new Map<string, RunBinding>()
  /** The load-time provider scan, taken once ({@link providerLoadReport}). */
  private providerLoad?: Promise<ProviderLoadReport>

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'taskRuntime')
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

  /** The resolved no-progress round count ({@link Config.noProgressRounds}); declared, not enforced. */
  get noProgressRounds(): number {
    return this.config.noProgressRounds
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
      return { taskId: root.taskId, runId: run.runId }
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
      taskId: `t-${randomUUID()}`,
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
    const runId: RunId = `r-${randomUUID()}`
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
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: now(),
    }
    await this.ctx.task.startRunIn(storeId, run, actor)
    this.sessions.set(options.rootSessionId, { storeId, taskId: task.taskId, runId: run.runId })
    return { taskId: task.taskId, runId: run.runId }
  }

  /**
   * Atomic decomposition plus the sequential run cascade: protected-input
   * identity fixing, normalization, structural admission and capability
   * admission must all pass for the whole batch before anything is persisted;
   * children then run one at a time in dependency order.
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
    exec: { signal?: AbortSignal } = {},
  ): Promise<ChildOutcome[]> {
    const actor = callerSessionId
    const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId)
    const parentRun = await this.ctx.task.runIn(storeId, parentRunId)
    if (parentRun.taskId !== parentTaskId) {
      throw new Error(`task-runtime: run "${parentRunId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`)
    }
    if (parentRun.sessionId !== callerSessionId) {
      throw new Error(`task-runtime: run "${parentRunId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`)
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
    // same verdicts then travel with the batch (ChildPlan) instead of being
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
    await this.ctx.task.decomposeIn(storeId, parentTaskId, children, actor, edges, batch.admission)

    const manifestEvents: TaskEvent[] = manifests.flatMap((manifest, index) => {
      const envelope = {
        taskId: childTaskIds[index]!,
        parentTaskId,
        timestamp: now(),
        actor,
        schemaVersion: 1 as const,
      }
      const events: TaskEvent[] = [
        { ...envelope, kind: 'CapabilityResolved', payload: { manifest } },
      ]
      if (manifest.missing.length > 0) {
        events.push({ ...envelope, kind: 'CapabilityGapDetected', payload: { missing: [...manifest.missing] } })
      }
      return events
    })
    await this.ctx.task.commitIn(storeId, manifestEvents)

    const plans: ChildPlan[] = children.map((task, index) => {
      const child = batch.children[index]!
      return {
        task,
        manifest: manifests[index]!,
        dependsOn: child.dependsOn,
        // The batch-wide provider verdicts ride with every plan: one pre-check
        // per admission, never one per child, and the result the Run binding
        // records is the one admission actually judged.
        providers: precheck,
        // Both declarations come from the contract the store holds, so the
        // handoff a worker reads can never drift from what was admitted.
        assumptions: [...child.contract.assumptions],
        constraints: [...child.contract.constraints],
      }
    })
    return runChildrenCascade(
      this.orchestrateEnv(callerSessionId, actor),
      storeId,
      parentTask,
      parentRun,
      plans,
      spec.reason,
      callerSessionId,
      exec.signal,
    )
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
    return runReplayTask(this.orchestrateEnv(callerSessionId, callerSessionId), storeId, {
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
    }, options.signal)
  }

  /** Reverse lookup: the task run a (worker) session is bound to. */
  async runForSession(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {    const found = await this.lookupRun(sessionId)
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
    try {
      const snapshot = await this.ctx.task.openStore(storeId)
      this.reindex(storeId, snapshot)
    } catch {
      return undefined
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

  private orchestrateEnv(callerSessionId: string, actor: string): OrchestrateEnv {
    return {
      task: this.ctx.task,
      actor,
      ...(this.config.defaultPreset !== undefined ? { defaultPreset: this.config.defaultPreset } : {}),
      ...(this.config.runBindingRoot === undefined ? {} : { runBindingRoot: this.config.runBindingRoot }),
      verifyTimeoutMs: this.config.verifyTimeoutMs,
      budget: { ...this.config.budget },
      allowRuntimeDecomposition: this.config.allowRuntimeDecomposition,
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
      },
    }
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
    const registry = (this.ctx.get?.('agents') ?? (this.ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents) as
      | { get(id: string): Agent | undefined }
      | undefined
    const agent = registry?.get(sessionId)
    if (agent === undefined) {
      throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`)
    }
    return agent
  }
}

export default TaskRuntime
