/**
 * The runtime's configuration surface: schema, defaults, and the soft service views it resolves.
 */

import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-graphs'
import type { EvidenceBundle, RunId, TaskId, VerificationMode } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig, PermissionSpec } from './capability.ts'
import type { McpServerTemplate } from './mcp-servers.ts'
import type { CommitReconcileOutcome, RootAdoption } from './types.ts'
import type { ProviderPrecheck } from './provider-precheck.ts'
import type { RootBudgetConfig } from './root-budget.ts'
import type { BatchResultMessage, BudgetConfig, ChildOutcome, VerifyRunOptions } from './orchestration/types.ts'

export interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  /** Tail excerpt of one criterion log (logRef relative to the verifier's evidence root); optional on the service. */
  logTail?(logRef: string): Promise<string | undefined>
  /** The registered verifier ids; optional on the service, required to validate a criterion's `verifierRef`. */
  verifierIds?(): string[]
  verifierSupports?(id: string, mode: VerificationMode): boolean
  /**
   * The cordis service lifecycle hook. Optional because a test double is already
   * readied when it is built; the provider pre-check awaits it before reading
   */
  ready?(): Promise<void>
}

export interface EnvPathSource {
  store: { get(envId: string): { path: string; components?: readonly { repo: string; dir: string }[] } }
}

export interface AgentPresetRegistry {
  resolve(id?: string): Promise<unknown>
}

export interface PermissionPresetRegistry {
  resolve(name: string): PermissionSpec
}

export interface LiveSessionLookup {
  get(id: SessionId): unknown
}

export interface SessionProjectionSource {
  snapshot(session: never, keys: readonly string[]): { values: Record<string, unknown> }
}

export interface SessionLogSource {
  readSession(sessionId: SessionId): Promise<{ events: readonly SessionEvent[] }>
}

export interface EvolutionCommitRecovery {
  reconcile?(): Promise<readonly CommitReconcileOutcome[]>
}

export interface SessionLogReader {
  open(
    id: SessionId,
    access: 'read',
  ): Promise<{
    /**
     * The stored header — the immutable session metadata a delegated child is
     * recognised by ({@link assertRootContractOrigin} reads its `origin` and
     */
    readonly header?: SessionHeader
    read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
}

/**
 * The review/supervision policy of this deployment, as `singularity-agent` declares it: the two round caps here are what
 * the recovery entry enforces per source task, counted separately for failed and verified sources.
 */
export interface SupervisionConfig {
  /** `all` accepts every terminal review, `failed` only failures, `off` none — read by the review trigger, not here. */
  autoReview: 'all' | 'failed' | 'off'
  /** Recovery attempts one failed source accepts; the next request is refused with the coded `iteration-cap`. */
  maxRecoveryRounds: number
  /** Improvement attempts one verified source accepts; the next request is refused with the coded `iteration-cap`. */
  maxImprovementRounds: number
  /** Review-agent runs one root store may start — read by the coordination ledger, not here. */
  coordinationBudget: number
}

export interface Config {
  /** MCP server definitions supplied by this deployment. */
  mcpServers?: Record<string, McpServerTemplate>
  /**
   * The supervision policy in force: declared by `singularity-agent`, read here for the two per-source round caps. A
   * deployment may state it on this plugin's config, or expose it as the `singularitySupervision` service.
   */
  supervision?: SupervisionConfig
  /**
   * Capability registry: name → skills/tool labels/agent preset/permission
   * preset granted when a task requires it. The core ships no table of its
   */
  capabilities: Record<string, CapabilityConfig>
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string
  /** Directory of immutable <id>@<version>.json task templates. */
  taskTemplatesRoot?: string
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number
  /** Absolute tree depth a decomposition may reach: a child at `maxDepth + 1` is rejected (root is depth 0). */
  maxDepth: number
  /** Most children one `task_decompose` batch may create. */
  maxChildren: number
  /** Optionally copy ordinary children into independent local workspaces. */
  isolatedChildren: boolean
  /** Maximum active child workers across this runtime; waiting parents release capacity. */
  maxActiveWorkers: number
  /** Per-run resource budget; see {@link BudgetConfig} for which member is enforced, checked post-hoc, or declared only. */
  budget: BudgetConfig
  /**
   * Whether a task admitted `leaf` may still decompose at runtime: the node
   * itself decides it is not atomic, instead of its parent having predicted it
   */
  allowRuntimeDecomposition: boolean
  /**
   * Whether a new child batch must be reviewed by a person before it may run
   * (T2/T3 §5): `off` (the shipped default) admits on the machine rules alone
   */
  generatedTaskReview: 'off' | 'all'
  /**
   * Where a run's bound provider content is materialized (S1-C): one directory
   * per run holding the skills the run loads, outside the worker's checkout so a
   */
  runBindingRoot?: string
  /**
   * What the whole tree may spend (A3 §3.5): a cap on the runs the tree may
   * start, and the concurrent-writer count — which this deployment can only
   */
  rootBudget?: RootBudgetConfig
  /**
   * How long one write drain may take (A3 §3.3) before it is reported as
   * unconfirmed — and an unconfirmed drain fails the run rather than assuming
   */
  writeDrainTimeoutMs: number
}

export interface ProviderLoadReport {
  /** The scan's verdicts, per capability and per skill; absent when the scan could not run at all. */
  readonly precheck?: ProviderPrecheck
  /** Every refused provider, one line per defect; empty when the table names only loadable providers. */
  readonly defects: readonly string[]
  /**
   * Why the scan could not run at all — a failure of the scan itself, not of a
   * provider. Reported instead of a verdict, never swallowed: a load report that
   */
  readonly failed?: string
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export const DEFAULT_BUDGET: Readonly<BudgetConfig> = {
  maxToolCalls: 150,
  attempts: 1,
}

export const DEFAULT_GENERATED_TASK_REVIEW: 'off' = 'off'

export const DEFAULT_WRITE_DRAIN_TIMEOUT_MS = 30_000

export const DEFAULT_MAX_DEPTH = 4

export const DEFAULT_MAX_CHILDREN = 8

export const DEFAULT_ALLOW_RUNTIME_DECOMPOSITION = true

/** The shipped supervision policy (A7 §1): failed terminal reviews diagnosed, three recovery rounds, two improvement rounds, eight coordination runs. */
export const DEFAULT_SUPERVISION: Readonly<SupervisionConfig> = {
  autoReview: 'failed',
  maxRecoveryRounds: 3,
  maxImprovementRounds: 2,
  coordinationBudget: 8,
}

const Capability: z<CapabilityConfig> = z.object({
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  preset: z.string(),
  permission: z.string(),
  mcpServers: z.array(z.string()),
})

const RootBudget: z<RootBudgetConfig> = z.object({
  maxRuns: z.number(),
  maxConcurrentWrites: z.number(),
})

const Supervision: z<SupervisionConfig> = z.object({
  autoReview: z.union([z.const('all'), z.const('failed'), z.const('off')]).default(DEFAULT_SUPERVISION.autoReview),
  maxRecoveryRounds: z.number().default(DEFAULT_SUPERVISION.maxRecoveryRounds),
  maxImprovementRounds: z.number().default(DEFAULT_SUPERVISION.maxImprovementRounds),
  coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget),
})

export const ConfigSchema: z<Config> = z.object({
  capabilities: z.dict(Capability).default({}),
  mcpServers: z.dict(z.any()).default({}),
  defaultPreset: z.string(),
  taskTemplatesRoot: z.string(),
  verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS),
  maxDepth: z.number().default(DEFAULT_MAX_DEPTH),
  maxChildren: z.number().default(DEFAULT_MAX_CHILDREN),
  isolatedChildren: z.boolean().default(false),
  maxActiveWorkers: z.number().default(2),
  budget: (
    z.object({
      maxToolCalls: z.number(),
      tokens: z.number(),
      attempts: z.number(),
    }) as z<BudgetConfig>
  ).default({ ...DEFAULT_BUDGET }),
  allowRuntimeDecomposition: z.boolean().default(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION),
  generatedTaskReview: z.union([z.const('off'), z.const('all')]).default(DEFAULT_GENERATED_TASK_REVIEW),
  supervision: Supervision.default({ ...DEFAULT_SUPERVISION }),
  rootBudget: RootBudget,
  writeDrainTimeoutMs: z.number().default(DEFAULT_WRITE_DRAIN_TIMEOUT_MS),
})

export interface RunBinding {
  storeId: string
  taskId: TaskId
  runId: RunId
}

export interface DriverEntry {
  readonly controller: AbortController
  readonly promise: Promise<ChildOutcome[]>
  /** The store this driver works in — how a graph-level cancellation finds it. */
  readonly storeId: string
  /**
   * The parent task whose batch this driver works on, when it drives a batch.
   * Named here because a batch id is a pair
   */
  readonly parentTaskId?: TaskId
}

export interface StoreRecoveryState {
  /** `recovering` while the barrier runs, `ready` once it completed, `failed` when it threw. */
  status: 'recovering' | 'ready' | 'failed'
  /**
   * The barrier's own completion, never rejecting: a joining `adoptRoot` awaits
   * this and then re-reads {@link status} (and {@link failure}), so a failed
   */
  readonly promise: Promise<void>
  /** Resolves the drivers this barrier registered: `true` starts them, `false` stands them down unstarted. */
  readonly release: (start: boolean) => void
  readonly released: Promise<boolean>
  /** The drivers this barrier registered but has not yet released to start. */
  readonly pendingDrivers: { key: string; controller: AbortController }[]
  /**
   * The delivery-and-wake pass this barrier's {@link TaskRuntime.reconcileStore}
   * deferred (A4 §F.1's wake order): a `steer` or a notice reaches an idle
   */
  adoption?: RootAdoption
  pendingQuestionDelivery?: () => Promise<void>
  /**
   * The owner notices a pass deferred because the store was not ready yet
   * ({@link TaskRuntime.notifyWhenReady}): a notice is a `followup`, so it wakes
   */
  pendingNotices: { sessionId: string; text: string }[]
  /**
   * Sessions this barrier's delivery pass already woke: the deferred owner
   * notices skip them, so no generic "continue" wake preempts the recovered input.
   */
  wokenSessions: Set<string>
  /**
   * The end-of-batch results a driver raised while the store was `recovering`
   * ({@link TaskRuntime.deliverBatchResult}): the same wake-order rule as the
   */
  pendingBatchResults: BatchResultMessage[]
  /** Why a failed barrier failed, verbatim. */
  reason?: string
  /** The original error a failed barrier threw. */
  failure?: unknown
  /** A cancellation or the unload invalidated this barrier: it finishes its pass but leaves no ready handle. */
  cancelled?: boolean
}

/** The live barrier's deferred work ({@link StoreRecoveryState} without its handles): what a read-only projection may serve. */
export interface StoreRecoveryStateView {
  readonly wokenSessions: readonly string[]
  readonly pendingNotices: readonly { readonly sessionId: string; readonly text: string }[]
  readonly pendingBatchResults: readonly BatchResultMessage[]
  readonly cancelled?: boolean
}
