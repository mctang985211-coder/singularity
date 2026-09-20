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
  CapabilityManifest,
  DependencyEdge,
  EvidenceBundle,
  ReviewTokenUsage,
  RunId,
  TaskEvent,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import { RootTaskSpec, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, capabilitySnapshot, resolvePreset, type CapabilityConfig, type PermissionSpec } from './capability.ts'
import { checkDecomposition } from './admission.ts'
import { buildHandoff, renderWorkerPrompt } from './handoff.ts'
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
export { checkDecomposition } from './admission.ts'
export type { ObligationCoverage, ObligationTemplate, ObligationTemplateFile } from './obligation.ts'
export { checkObligationCoverage, findRepoRoot, loadObligationTemplates, parseObligationTemplates } from './obligation.ts'
export type { HandoffInit, WorkerPromptOptions } from './handoff.ts'
export { buildHandoff, renderWorkerPrompt } from './handoff.ts'
export { renderWorkerContract, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN } from './contract.ts'
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
  description: string
  command?: string
  mode?: VerificationMode
  mandatory?: boolean
  requiredEvidence?: string[]
  /**
   * Evidence dependencies (KISS §5.1): artifact/evidence kinds or ids that must
   * exist in the store before this criterion can be judged. Admission checks
   * the shape only; the orchestrator judges existence at spawn time and a
   * missing reference settles the child blocked, with the gap registered as an
   * obligation.
   */
  requiresArtifact?: string[]
  /**
   * The registered verifier id that judges this criterion (KISS §4.1
   * `verifier_ref`). Absent dispatches by mode (the current behavior);
   * present, the id must exist in the verifier registry — an unknown id
   * rejects the whole batch at admission time, with the error naming every
   * registered id.
   */
  verifierRef?: string
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
   * The caller declares this child may decompose itself (RFC §36: the agent
   * admits it so its own worker keeps the option to split further). A missing
   * required capability forces `decomposable` on its own; the declaration is
   * what makes a child with no gap decomposable.
   */
  decomposable?: boolean
}

export interface DecomposeSpec {
  children: readonly DecomposeChildSpec[]
  reason: string
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

function normalizeCriteria(criteria: readonly CriterionSpec[], childIndex: number): AcceptanceCriterion[] {
  return criteria.map((criterion, index) => ({
    criterionId: `ac${childIndex + 1}-${index + 1}`,
    description: criterion.description,
    verificationMode: criterion.mode ?? (criterion.command !== undefined ? 'deterministic' : 'review'),
    requiredEvidence: [...(criterion.requiredEvidence ?? [])],
    mandatory: criterion.mandatory ?? true,
    ...(criterion.command !== undefined ? { command: criterion.command } : {}),
    ...(criterion.requiresArtifact !== undefined ? { requiresArtifact: [...criterion.requiresArtifact] } : {}),
    ...(criterion.verifierRef !== undefined ? { verifierRef: criterion.verifierRef } : {}),
  }))
}

export class TaskRuntime extends Service {
  static inject = ['task', 'agentRuntime', 'graphs']
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions = new Map<string, RunBinding>()

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
    }
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
   */
  applyCapabilityRow(name: string, entry: CapabilityConfig | null): void {
    if (entry === null) {
      const rest = { ...this.config.capabilities }
      delete rest[name]
      this.config.capabilities = rest
      return
    }
    this.config.capabilities = { ...this.config.capabilities, [name]: structuredClone(entry) }
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
      return { taskId: root.taskId, runId: run.runId }
    }

    const manifest = this.resolveCapabilities(RootTaskSpec.requiredCapabilities)
    const task: TaskInstance = {
      taskId: `t-${randomUUID()}`,
      definitionRef: { taskType: RootTaskSpec.taskType, version: RootTaskSpec.version },
      objective: options.objective,
      depth: 0,
      acceptanceCriteria: RootTaskSpec.acceptanceCriteria.map(criterion => ({ ...criterion, requiredEvidence: [...criterion.requiredEvidence] })),
      requestedCapabilities: [...RootTaskSpec.requiredCapabilities],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }
    await this.ctx.task.createTaskIn(storeId, task, actor)
    await this.ctx.task.admitTaskIn(storeId, task.taskId, actor, { decompositionStatus: 'decomposable', manifest })
    const run: TaskRun = {
      runId: `r-${randomUUID()}`,
      taskId: task.taskId,
      sessionId: options.rootSessionId,
      capabilitySnapshot: capabilitySnapshot(manifest),
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
   * Atomic decomposition plus the sequential run cascade: structural admission
   * and capability admission must pass for the whole batch before anything is
   * persisted; children then run one at a time in dependency order.
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
    if (!Array.isArray(spec.children) || spec.children.length === 0) {
      throw new Error('task-runtime: decomposition requires at least one child')
    }

    const childTaskIds = spec.children.map(() => `t-${randomUUID()}`)
    const criteria = spec.children.map((child, index) => normalizeCriteria(child.acceptanceCriteria, index))
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
      spec.children.map((child, index) => ({
        taskId: childTaskIds[index]!,
        objective: child.objective,
        acceptanceCriteria: criteria[index]!,
        dependsOn: child.dependsOn,
      })),
      snapshot.edges,
    )
    if (!verdict.ok) {
      throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join('\n- ')}`)
    }

    const manifests = spec.children.map(child => this.resolveCapabilities(child.requiredCapabilities ?? []))
    const rejected = spec.children
      .map((child, index) => ({ child, index, manifest: manifests[index]! }))
      .filter(({ child, manifest }) => manifest.missing.length > 0 && child.decomposable !== true)
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
            goal: `capability "${missing}" required by child ${index} ("${spec.children[index]!.objective}") of "${parentTaskId}" is not granted by the registry`,
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

    this.assertKnownVerifierRefs(
      criteria.flatMap((list, childIndex) => list.map(criterion => ({ childIndex, criterion }))),
      `decomposition of "${parentTaskId}"`,
    )

    const children: TaskInstance[] = spec.children.map((child, index) => ({
      taskId: childTaskIds[index]!,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId,
      objective: child.objective,
      depth: parentTask.depth + 1,
      acceptanceCriteria: criteria[index]!,
      requestedCapabilities: [...(child.requiredCapabilities ?? [])],
      decompositionStatus: child.decomposable === true || manifests[index]!.missing.length > 0 ? 'decomposable' : 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }))
    const edges: DependencyEdge[] = spec.children.flatMap((child, to) =>
      (child.dependsOn ?? [] as readonly number[]).map((from: number) => ({ from: childTaskIds[from]!, to: childTaskIds[to]! })))
    await this.ctx.task.decomposeIn(storeId, parentTaskId, children, actor, edges)

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

    const plans: ChildPlan[] = children.map((task, index) => ({
      task,
      manifest: manifests[index]!,
      dependsOn: spec.children[index]!.dependsOn ?? [],
      ...(spec.children[index]!.assumptions === undefined ? {} : { assumptions: [...spec.children[index]!.assumptions!] }),
    }))
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
    const contract = options.contract ?? {
      objective: champion.objective,
      acceptanceCriteria: champion.acceptanceCriteria,
      requiredCapabilities: champion.requestedCapabilities,
    }
    const table = { ...this.config.capabilities, ...(options.overlay?.capabilityOverrides ?? {}) }
    const manifest = resolveCapabilities(contract.requiredCapabilities, table)
    if (manifest.missing.length > 0) {
      throw new Error(`task-runtime: replay of "${championTaskId}" cannot run: capability gap [${manifest.missing.join(', ')}] under the overlay`)
    }
    this.assertKnownVerifierRefs(
      contract.acceptanceCriteria.map(criterion => ({ childIndex: 0, criterion })),
      `replay of "${championTaskId}"`,
    )
    const task: TaskInstance = {
      taskId: `t-${randomUUID()}`,
      definitionRef: { ...champion.definitionRef },
      objective: `[${options.lineage}] ${contract.objective}`,
      depth: 0,
      acceptanceCriteria: contract.acceptanceCriteria.map(criterion => ({ ...criterion, requiredEvidence: [...criterion.requiredEvidence] })),
      requestedCapabilities: [...contract.requiredCapabilities],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }
    const spawn = options.spawn !== false
    let prompt: string | undefined
    let contractBlock: string | undefined
    if (spawn) {
      const championRun = await this.ctx.task.runIn(storeId, championRunId)
      // The handoff is in-memory only: the replay task is parentless by design,
      // and the store reducer records a handoff only when the child's
      // parentTaskId names the handoff's parent. The prompt carries the
      // lineage instead.
      const handoff = buildHandoff({
        parentTask: champion,
        parentRun: championRun,
        childTask: task,
        reason: `${options.lineage}: replay of ${championTaskId} under the candidate's overlay`,
        callerSessionId,
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

  private orchestrateEnv(callerSessionId: string, actor: string): OrchestrateEnv {
    return {
      task: this.ctx.task,
      actor,
      ...(this.config.defaultPreset !== undefined ? { defaultPreset: this.config.defaultPreset } : {}),
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
        const envBuilder = (this.ctx.get?.('envBuilder') ?? (this.ctx as unknown as { envBuilder?: EnvPathSource }).envBuilder) as
          | EnvPathSource
          | undefined
        if (envBuilder === undefined) return undefined
        try {
          const graph = await this.ctx.graphs.graphForSession(SessionId(callerSessionId))
          const env = envBuilder.store.get(graph.envId)
          return {
            envRoot: env.path,
            checkout: repo => {
              const component = (env.components ?? []).find(item => item.repo === repo)
              return component === undefined ? undefined : join(env.path, component.dir)
            },
          }
        } catch {
          return undefined
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
        let cwd: string | undefined
        try {
          const graph = await this.ctx.graphs.graphForSession(SessionId(callerSessionId))
          cwd = ((this.ctx.get?.('envBuilder') ?? (this.ctx as unknown as { envBuilder?: EnvPathSource }).envBuilder) as EnvPathSource | undefined)
            ?.store.get(graph.envId).path
        } catch {
          cwd = undefined
        }
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
    const viaContext = this.ctx.get?.(name)
    if (viaContext !== undefined) return viaContext as T
    return (this.ctx as unknown as Record<string, unknown>)[name] as T | undefined
  }

  /** The verifier service is an optional plugin; resolve it softly, never import the package. */
  private runVerifier(): RunVerifier | undefined {
    return (this.ctx.get?.('verifier') ?? (this.ctx as unknown as { verifier?: RunVerifier }).verifier) as RunVerifier | undefined
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
