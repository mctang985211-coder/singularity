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
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
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
  Obligation,
  ReviewTokenUsage,
  RootProposalIdentity,
  RunId,
  RunProviderBinding,
  RunStatus,
  SubmissionRecord,
  TaskContract,
  TaskEvent,
  TaskId,
  TaskInstance,
  TaskProposal,
  TaskProposalDecomposition,
  TaskProposalDecisionOutcome,
  TaskProposalPolicy,
  TaskProposalRoot,
  TaskProposalRootConsumption,
  TaskProposalStatus,
  TaskRun,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import {
  ROOT_PROPOSAL_TASK_ID,
  TASK_CONTRACT_VERSION,
  admissionContextDigest,
  blockingQuestionsOf,
  contractDigest,
  questionOf,
  reviewContextDigest,
  rootProposalDigest,
  rootProposalId,
  rootTaskStoreId,
  taskProposalId,
} from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, capabilitySnapshot, resolvePreset, type CapabilityConfig, type PermissionSpec } from './capability.ts'
import { checkDecomposition, contractDefects, independentAcceptanceDefects, rootIndependenceDefects } from './admission.ts'
import { ExecutionGate, type DrainResult, type JobsView } from './gate.ts'
import { optionalService, precheckProviders, precheckReplacedCapabilityRow, providerContentIdentities, providerDefectLines, providerRefusals, registeredVerifierIds } from './provider-precheck.ts'
import type { ProviderPrecheck, SkillDiscoveryView } from './provider-precheck.ts'
import { assertRootBudgetConfig, checkBatchAdmission, checkRunStart, hasRootLimits, resolveRootBudget } from './root-budget.ts'
import type { RootBudgetConfig } from './root-budget.ts'
import { bindRunProviders, defaultRunBindingRoot, readRunBinding } from './run-binding.ts'
import type { RunBindingRead } from './run-binding.ts'
import { normalizeDecomposition, normalizeRootContract, decompositionIdentity } from './normalize.ts'
import type { DecompositionIdentityContext, NormalizedBatch } from './normalize.ts'
import { isOpenProposal, proposalRequestKey, reviewContextDelta, reviewContextOf, rootProposalRequestKey } from './proposal.ts'
import {
  fixCriteriaProtectedInputs,
  fixSpecProtectedInputs,
} from './protected-inputs.ts'
import {
  blockUnstartedChildren,
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
  type RuntimeSettlementEnv,
  type SessionObservation,
  type VerifyRunOptions,
} from './orchestrate.ts'
import {
  answerParentQuestion,
  applyStoreQuestionBlocking,
  askParentQuestion,
  pendingCoordinationOf,
  reconcileQuestionDeliveries,
  type AnsweredQuestionOutcome,
  type AskedQuestionOutcome,
  type ParentAnswerCall,
  type ParentAskCall,
  type QuestionCaller,
  type QuestionCoordinationDeps,
  type QuestionReconcileReport,
} from './question.ts'
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
export { checkDecomposition, contractDefects, independentAcceptanceDefects, rootIndependenceDefects } from './admission.ts'
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
  RootNormalizationResult,
} from './normalize.ts'
export { decompositionIdentity, normalizeDecomposition, normalizeRootContract } from './normalize.ts'
export type {
  ProposalRequestKeyContext,
  ReviewContextInput,
  RootRequestKeyContext,
} from './proposal.ts'
export {
  PROPOSAL_REQUEST_KEY_PREFIX,
  isOpenProposal,
  openProposalOf,
  proposalRequestKey,
  reviewContextDelta,
  reviewContextOf,
  rootProposalRequestKey,
  verifierIdentitiesOf,
} from './proposal.ts'
export type { ObligationCoverage, ObligationTemplate, ObligationTemplateFile } from './obligation.ts'
export { checkObligationCoverage, findRepoRoot, loadObligationTemplates, parseObligationTemplates } from './obligation.ts'
export type { HandoffInit } from './handoff.ts'
export { buildHandoff } from './handoff.ts'
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
export { RUN_BINDING_SKILLS_DIR, bindRunProviders, defaultRunBindingRoot, readRunBinding } from './run-binding.ts'
export type {
  CapabilityProviderPrecheck,
  ProviderPrecheck,
  ProviderPrecheckRequest,
  ResolvedProviderIdentity,
  SkillDiscoveryView,
  VerifierVocabulary,
} from './provider-precheck.ts'
export {
  optionalService,
  precheckProviders,
  precheckReplacedCapabilityRow,
  providerContentIdentities,
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
  blockUnstartedChildren,
  deriveChildOutcomes,
  driveBatch,
  runReplayTask,
  settleRunFromRuntime,
  settleSubmittedRun,
  RunWatcherUnavailableError,
  VerifierUnavailableError,
  escalationHint,
} from './orchestrate.ts'
export type {
  AnsweredQuestionOutcome,
  AskedQuestionOutcome,
  ParentAnswerCall,
  ParentAskCall,
  PendingQuestionMessage,
  PendingQuestionMessages,
  QuestionCaller,
  QuestionCoordinationDeps,
  QuestionDelivery,
  QuestionReconcileReport,
} from './question.ts'
export {
  answerMessageIdOf,
  applyStoreQuestionBlocking,
  answerParentQuestion,
  askParentQuestion,
  parseCallArguments,
  pendingCoordinationOf,
  pendingQuestionMessages,
  questionMessageIdOf,
  reconcileQuestionDeliveries,
} from './question.ts'

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
 * Soft view of the session-persistence service: one session's own durable log,
 * opened read-only (the handle shape `@deepseek-ai/dsh-session-persistence`
 * defines, declared structurally so this module needs no dependency on it).
 *
 * This is the surface a person's request is recorded on — the one a root
 * contract's origin is established from (A0 §1.10) — rather than
 * {@link SessionLogSource}, which is the replay-validated *read* view mounted
 * for review evidence and may be absent where the durable log is present.
 */
interface SessionLogReader {
  open(id: SessionId, access: 'read'): Promise<{
    /**
     * The stored header — the immutable session metadata a delegated child is
     * recognised by ({@link assertRootContractOrigin} reads its `origin` and
     * `delegationDepth`). Declared optional because a backend stub may model the
     * log alone; the real handle always carries it.
     */
    readonly header?: SessionHeader
    read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
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
 * One root contract as its caller presents it (A0 §1.2, §2): the goal of a root
 * session — objective, acceptance criteria, assumptions, constraints, declared
 * capabilities — in the authoring form the tools and the direct service entry
 * share.
 *
 * The field set is the contract's own (`task/src/contract.ts:TaskContract`) and
 * nothing else: a key this shape does not declare is refused by name rather than
 * dropped, so a caller cannot smuggle a budget, a skill pin or a permission
 * through a field the runtime never reads. Text is stored verbatim — blankness is
 * refused, bytes are not rewritten — and criterion ids are fixed by the single
 * normalization entry.
 *
 * What this shape deliberately does *not* carry: a mode that replaces the
 * acceptance rule, a flag that skips the review, or a parent to hang the goal
 * under. A root contract is the goal; how it is *reviewed* is the deployment's
 * policy, and how it is *checked* is its criteria.
 */
export interface RootContractSpec {
  objective: string
  acceptanceCriteria: readonly CriterionSpec[]
  assumptions?: readonly string[]
  constraints?: readonly string[]
  requiredCapabilities?: readonly string[]
  /** The contract language, as {@link DecomposeSpec.contractVersion}: omitted means this build's version. */
  contractVersion?: number
}

/**
 * What a caller may say about one root intake beyond the contract itself. The
 * fields mirror {@link DecomposeProposalOptions} because a root contract is a
 * proposal too — same lifecycle, same key rules, same decision binding.
 */
export interface RootIntakeOptions {
  /**
   * The idempotency key this request is addressed by (§2). Absent, the runtime
   * derives it from the store, the root session and the contract's own digest
   * ({@link rootProposalRequestKey}) — so the same contract asked for again is
   * answered from the record, and a revision (different content) is a different
   * key. Given explicitly, the same rule applies: one key names one proposal,
   * and a key already bound to other content is refused by name.
   */
  requestKey?: string
  /** The proposal this one revises (§6): a rejected or stale root contract, whose record is kept. */
  supersedes?: string
  /**
   * The call's own control: an already-aborted `signal` persists nothing. There is
   * no `callId` here and no write drain behind it — nothing about an activation
   * hands this checkout to another writer or closes this session's own ability to
   * write (A3 §3.3's drain is the convergence *before* a batch or a verification
   * takes the checkout, and a root run keeps its own), so the exclusion such a
   * field exists for has no step to apply to.
   */
  exec?: { signal?: AbortSignal }
}

/**
 * What one root intake settled (A0 §1.3–§1.4). `status` is the field to switch
 * on.
 *
 * `pending_review` declares no ids rather than optional ones: a root contract
 * waiting for a decision has no task and no run — that is the whole point of
 * `all` — and a caller reading an id off this member would be reading a field
 * that does not exist. `activated` carries the ids the activation commit minted,
 * so the caller knows which root task and run its contract became without
 * re-reading the store.
 */
export type RootIntakeResult =
  | {
      status: 'activated'
      proposalId: string
      taskId: TaskId
      runId: RunId
      detail: string
    }
  | {
      status: 'pending_review'
      proposalId: string
      detail: string
    }

/**
 * What {@link TaskRuntime.adoptRoot} found for one root session.
 *
 * Two outcomes, both normal: the store holds a root task bound to this session
 * (`adopted`, with the task and run ids and the phase the session's gate was set
 * to), or it does not (`adopted: false`) — a store can exist with no task at all
 * (A0 §1.1: `graphs.create` opens it, the intake fills it), and that is not an
 * error, it is the state before a contract was accepted. The negative answer is
 * given *after* the adoption's own recovery pass has run (§3 stage B,
 * {@link TaskRuntime.adoptRoot}), so its `detail` names the proposals that pass
 * left open and states that nothing was created.
 */
export type RootAdoption =
  | {
      adopted: true
      taskId: TaskId
      runId: RunId
      /**
       * The phase this session's execution gate now holds, derived from the
       * store's own run record. A root run that reached a terminal state leaves
       * `terminal`: a late intake or write on a finished root is refused by the
       * gate as well as by the state, and a restart must re-derive that from the
       * store rather than trust what a dead process remembered (§1.8).
       */
      phase: ExecutionPhase | 'terminal'
      detail: string
    }
  | {
      adopted: false
      detail: string
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
   * Whether a new child batch must be reviewed by a person before it may run
   * (T2/T3 §5): `off` (the shipped default) admits on the machine rules alone
   * and records `policy-off`; `all` holds every new batch in `pending_review`
   * until a persisted decision approves it. The policy belongs to the
   * deployment — it is read from this configuration on every submission and
   * every continuation, it is never taken from a batch's own fields
   * (`normalizeDecomposition` refuses a batch-level key by name), and a
   * proposal carries the policy it was born under, so tightening the
   * deployment never rewrites what already happened and never releases a batch
   * that is already waiting (§5: only tightening is allowed).
   */
  generatedTaskReview: 'off' | 'all'
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
 * The shipped review policy (T2/T3 §5): `off`. Every decomposition this
 * deployment has ever run was admitted on the machine rules alone, and the
 * guide's decision is that a human review is something a deployment *turns on*
 * (§5: no risk-based classifier, no "only when no template matched") rather
 * than something it turns off. `off` is not a silent state: the proposal
 * record carries the policy it was born under, which is what lets a reader
 * tell "this batch ran without a human review" from "a person approved it".
 */
export const DEFAULT_GENERATED_TASK_REVIEW: 'off' = 'off'

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
  generatedTaskReview: z.union([z.const('off'), z.const('all')]).default(DEFAULT_GENERATED_TASK_REVIEW),
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

/**
 * One store's recovery barrier (A2 §E): the in-flight promise an explicit
 * activation awaits, the ready handle it leaves behind, and the release its
 * registered drivers wait for. In-process only — the persistent record stays
 * the source of truth, and this handle is never a second state machine: a
 * cancellation or the unload invalidates it, and the next explicit
 * `adoptRoot` is the retry.
 */
interface StoreRecoveryState {
  /** `recovering` while the barrier runs, `ready` once it completed, `failed` when it threw. */
  status: 'recovering' | 'ready' | 'failed'
  /**
   * The barrier's own completion, never rejecting: a joining `adoptRoot` awaits
   * this and then re-reads {@link status} (and {@link failure}), so a failed
   * barrier cannot surface as an unhandled rejection of its mirror.
   */
  readonly promise: Promise<void>
  /** Resolves the drivers this barrier registered: `true` starts them, `false` stands them down unstarted. */
  readonly release: (start: boolean) => void
  readonly released: Promise<boolean>
  /** The drivers this barrier registered but has not yet released to start. */
  readonly pendingDrivers: { key: string; controller: AbortController }[]
  /** Why a failed barrier failed, verbatim. */
  reason?: string
  /** The original error a failed barrier threw. */
  failure?: unknown
  /** A cancellation or the unload invalidated this barrier: it finishes its pass but leaves no ready handle. */
  cancelled?: boolean
}

/** The batch id a parent's decomposition records: `b-<parentTaskId>`, deterministic because a task splits once (§1.2). */
function batchIdFor(parentTaskId: TaskId): string {
  return `b-${parentTaskId}`
}

/* --- the proposal contract (T2/T3 §5–§6) ---------------------------------- */

/**
 * What a caller may say about one submission beyond the batch itself.
 */
export interface DecomposeProposalOptions {
  /**
   * The idempotency key this request is addressed by (§6). Absent, the runtime
   * derives it from the calling context
   * ({@link ./proposal.ts:proposalRequestKey}); given, it is the caller's own
   * stable identifier and the same rules apply either way — one key names one
   * proposal, and a key already bound to a *different* content is refused
   * rather than silently aliased.
   */
  requestKey?: string
  /**
   * The proposal this one revises (§6): a rejected or stale one, whose record
   * is kept. A revision is new content (and a new key); naming the predecessor
   * is what lets a reader follow the history.
   */
  supersedes?: string
  /**
   * The admission call's own control: `signal` governs the pre-check (an
   * already-aborted call persists nothing), `callId` is the call's own
   * registration id, so the batch's first drain does not wait for the call
   * that is asking (A3 §3.3).
   */
  exec?: { signal?: AbortSignal; callId?: string }
}

/**
 * What one submission settled. `status` is the status the store holds after
 * the call — `ready` for a batch born under policy `off`, `pending_review` for
 * one waiting for a person — and, when the request hit a proposal the store
 * already had, whatever that proposal's status is: a retry learns the state
 * instead of creating a second batch.
 */
export interface ProposalSubmission {
  proposalId: string
  status: TaskProposalStatus
  /** The policy the proposal was born under (the audit field, never a fake approval). */
  policy: TaskProposalPolicy
  /** True when this request was answered from a stored proposal (`requestKey` + content) instead of a new submission. */
  existing: boolean
  /** What the caller owes next, or what happened to the review request, in one sentence. */
  detail: string
  /** How the review request went, when the proposal is waiting for one. */
  review?: { requested: boolean; detail: string }
}

/**
 * What one `decomposeAndRun` settled (T2/T3 §6). `status` is the field to
 * switch on.
 *
 * The `pending_review` member declares `batchId` and `childTaskIds` as `never`
 * rather than optional: there is no batch and no child id when a batch is
 * waiting for a review, and a caller that reads the batch off this member would
 * be reading a field that does not exist. `never` is also the one shape that
 * keeps a caller written before T2 — `agent-singularity/src/tools/task-decompose.ts`
 * reads `{ batchId, childTaskIds }` off the result — compiling: that caller
 * must switch on `status`, and this entry's admission path is otherwise
 * unchanged (`off` still returns `{ batchId, childTaskIds }` synchronously).
 */
export type DecomposeAdmissionResult =
  | {
      status: 'admitted'
      proposalId: string
      batchId: string
      childTaskIds: TaskId[]
    }
  | {
      status: 'pending_review'
      proposalId: string
      /** Where the proposal stands and what a decision would have to be. */
      detail: string
      batchId: never
      childTaskIds: never
    }

/**
 * What one continuation settled (T2/T3 §6, root arms A0 §1.4). The members are
 * the whole answer to "did this proposal become what it asked for": `admitted`
 * carries the batch and its children, `activated` carries the root task and run
 * a root contract became, and every other member is a proposal that did **not**
 * run — waiting for a decision, invalidated (`stale`, `expired`), or already
 * refused. A continuation that cannot even be judged (the batch content is not
 * in this process, the deployment cannot list its verifiers, the root budget
 * refuses the batch, the workspace is somebody else's) is a *throw* instead:
 * nothing was decided about the proposal, and it is left exactly as it was.
 *
 * The two "it became something" arms are kept apart by `status` rather than
 * sharing one member with optional ids: a root intake is not a batch, and a
 * reader that had to test whether `batchId` happens to be there would be reading
 * a claim the record does not make (§2: the batch vocabulary does not apply to a
 * root).
 */
export type ProposalContinuation =
  | {
      proposalId: string
      status: 'admitted'
      batchId: string
      childTaskIds: TaskId[]
      detail: string
    }
  | {
      proposalId: string
      status: 'activated'
      /** The root task the activation commit created, carrying the approved contract. */
      taskId: TaskId
      /** The root run the activation commit created, in the proposal's root session and born `active`. */
      runId: RunId
      detail: string
    }
  | {
      proposalId: string
      status: Exclude<TaskProposalStatus, 'admitted'>
      detail: string
      /** The machine reason recorded with the status, when the status is one the runtime wrote (`stale`, `expired`). */
      reason?: string
    }

/** What one decision settled: the outcome on record, where the proposal stands, and — for an approval — how far the continuation got. */
export interface ProposalDecisionResult {
  proposalId: string
  /** The outcome that was **recorded**, not the one that was asked for: a late approval becomes `expired` (§6). */
  outcome: TaskProposalDecisionOutcome
  /** Where the proposal stands: its stored status, or `activated` once a root contract's approval has created it. */
  status: TaskProposalStatus | 'activated'
  /** The continuation an approval triggered, when one was attempted. */
  continuation?: ProposalContinuation
  detail: string
  /** The reason recorded with the outcome, when there was one. */
  reason?: string
}

/** One child's unsatisfied capability requirement, as the pre-check found it. */
export interface CapabilityGap {
  /** The child's batch position (its index in the proposal's children). */
  childIndex: number
  /** That child's objective, so the obligation raised for the gap names the work it blocks. */
  objective: string
  /** The capability names the registry could not grant. */
  missing: readonly string[]
}

/**
 * One refusal the pre-check earned: the error the caller raises (the same
 * message and error class the admission chain produced before T2), every
 * field-level reason behind it, and the capability gaps it rests on.
 *
 * The gaps are separate because the *fact* of a gap is recorded before the
 * batch is refused: one obligation per missing capability, raised on the
 * parent (KISS §7 — a gap is a normal state with a record, not a silence). The
 * pre-check itself writes nothing; the submission path is what raises them.
 */
export interface DecompositionRefusal {
  readonly error: Error
  readonly reasons: readonly string[]
  readonly gaps: readonly CapabilityGap[]
}

/** Why a review is being requested of a person. */
export type ProposalReviewTrigger = 'submitted' | 'tightened' | 'recovered'

/**
 * One request for a person to review a proposal (§5). It carries the proposal
 * (what a decision binds) and — when this process holds them — the facts §5
 * requires the review to show: the children's objectives, criteria, assumptions,
 * dependencies and declared capabilities for a batch, or the single root
 * contract for a root intake, rather than a digest.
 *
 * The subject is discriminated by kind because the two are different things to
 * show. A decomposition batch belongs to a parent task and is displayed under
 * its goal; a root contract has no parent — the task it becomes does not exist
 * while it waits — so the request names the root session instead and carries the
 * contract itself. Neither arm invents the other's fields: a reviewer sees a
 * root goal as a root goal, never as a one-child decomposition of nobody.
 */
export interface ProposalReviewRequestBase {
  readonly storeId: string
  readonly trigger: ProposalReviewTrigger
  readonly proposal: TaskProposal
  /** The manifests this proposal resolves to right now; aligned with the batch's children, or the root contract's declared capabilities. */
  readonly manifests: readonly CapabilityManifest[]
  /** The registered verifier ids at the moment of the request, when the deployment can list them. */
  readonly registeredVerifiers?: readonly string[]
  /** Every obligation raised on the subject so far — §5's "未满足义务说明", read from the store rather than summarized. */
  readonly obligations: readonly Obligation[]
}

/** A batch to review: its parent's own record, and the children rebuilt from the store. */
export interface DecompositionReviewRequest extends ProposalReviewRequestBase {
  /** The kind, when the writer stated it. Absent means this arm — the shape every request had before root intake existed. */
  readonly kind?: 'decomposition'
  /** The parent task the batch belongs to, as the store holds it. */
  readonly parentTask: TaskInstance
  /**
   * The batch the proposal holds, rebuilt from the store (`storedBatchOf`) — the
   * contracts a reviewer has to read, not a digest, and not whatever a live
   * process happens to remember.
   */
  readonly batch: NormalizedBatch
}

/** A root contract to review: the goal of one root session, and nothing above it. */
export interface RootContractReviewRequest extends ProposalReviewRequestBase {
  readonly kind: 'root'
  /** The root session whose goal this contract is. There is no parent task to name, and none is invented. */
  readonly rootSessionId: string
  /** The normalized root contract the proposal asks to run, as stored — what a reviewer reads is what an approval binds. */
  readonly contract: TaskContract
}

export type ProposalReviewRequest = DecompositionReviewRequest | RootContractReviewRequest

/** What a review channel did with one request. Never a decision, never an approval. */
export interface ProposalReviewNotice {
  /** Whether a person was actually asked. */
  readonly requested: boolean
  /** What the channel reported, for the caller to render. */
  readonly detail?: string
}

/**
 * The seam one deployment mounts to reach a human (T2/T3 stage C wires the
 * existing approval channel here): the runtime resolves it softly from the
 * context as `proposalReviewChannel`, calls it when a proposal needs a person,
 * and reads nothing back but a notice. A channel that is absent, that answers
 * `requested: false`, or that throws leaves the proposal exactly where it is —
 * `pending_review` — because requesting a review is not a decision and this
 * runtime has no way to turn a notification into one.
 *
 * The method's return type is deliberately not a decision: the only thing that
 * advances a waiting proposal is a persisted `TaskProposalDecided`, written by
 * {@link TaskRuntime.decideProposal} from a trusted channel or a test.
 */
export interface ProposalReviewChannel {
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>
}

/**
 * What one recovery pass could not finish, reported rather than guessed: the
 * proposals it could not continue and why. Empty means every open proposal was
 * either continued or already in a state recovery must not touch.
 */
export interface ReconcileReport {
  readonly unresolvedProposals: readonly {
    proposalId: string
    status: TaskProposalStatus
    reason: string
  }[]
  /**
   * What the pass's own question deliveries settled as (A4 §F.1), one record per
   * fact the store still owed a message for — `delivered`, `already-present`, or
   * `unavailable` for a target nobody has brought back yet. Empty means the store
   * owed nothing; a `refused` record names why that one could not be decided.
   */
  readonly questionDeliveries: readonly QuestionReconcileReport[]
}

/**
 * What a read sees about one store's recovery (A2 §E) — facts and markers,
 * never a trigger: {@link TaskRuntime.recoveryStatus} recovers nothing, starts
 * no driver and writes no gate, so a context query or a diagnostic can show
 * exactly where a store stands without becoming the thing that recovers it.
 *
 * - `ready` — nothing needs recovering, or the explicit barrier completed;
 * - `not-activated` — the store cannot be read yet: the legal root entry (an
 *   intake) creates it, and every other caller is refused by the store's own
 *   unknown-store error rather than by a recovery verdict;
 * - `recovering` — an explicit activation's barrier is still running;
 * - `recovery-required` — the store holds in-flight work this process is not
 *   driving (a worker, a replay, a waiting parent); only an explicit
 *   activation (`adoptRoot`, through `graphs`' activate) may recover it;
 * - `needs-recovery` — the store holds a run that predates coordination
 *   phases: reading and cancelling are its only continuations, and it is never
 *   treated as active by default;
 * - `recovery-failed` — the last explicit recovery failed; `reason` is the
 *   original one, and the next explicit activation is the retry.
 */
export type StoreRecoveryStatus =
  | { status: 'ready' }
  | { status: 'not-activated'; reason: string }
  | { status: 'recovering' }
  | { status: 'recovery-required'; reason: string }
  | { status: 'needs-recovery'; reason: string }
  | { status: 'recovery-failed'; reason: string }

/**
 * What the pre-check's second half judged (T2/T3 §2): the derived batch, the
 * manifests it resolved and the provider verdicts — everything admission needs,
 * and nothing persisted.
 */
type DecompositionPrecheck =
  | { ok: true; batch: NormalizedBatch; manifests: CapabilityManifest[]; providers: ProviderPrecheck }
  | { ok: false; refusal: DecompositionRefusal }

/**
 * What the root pre-check judged (A0 §3): the manifests the one contract resolves
 * to and the provider verdicts behind them — everything the activation needs, and
 * nothing persisted. There is no batch and no gap list: a root contract is one
 * contract, and a capability it cannot resolve is a refusal rather than a
 * delegable gap.
 */
type RootPrecheck =
  | { ok: true; manifests: CapabilityManifest[]; providers: ProviderPrecheck }
  | { ok: false; refusal: RootRefusal }

/** One root pre-check refusal: the error the caller raises, and the reasons behind it. No gaps — a root has nobody to delegate one to. */
interface RootRefusal {
  readonly error: Error
  readonly reasons: readonly string[]
}

/**
 * What {@link TaskRuntime.requestProposalReview} is given: the subject's own
 * facts, discriminated by kind, with the fields the request itself reports
 * (`manifests`, the registered vocabulary, the obligations) looked up by the
 * method rather than by its callers.
 */
type ReviewSubject =
  | {
      kind?: 'decomposition'
      storeId: string
      trigger: ProposalReviewTrigger
      proposal: TaskProposal
      parentTask: TaskInstance
      batch: NormalizedBatch
      manifests: readonly CapabilityManifest[]
    }
  | {
      kind: 'root'
      storeId: string
      trigger: ProposalReviewTrigger
      proposal: TaskProposal
      rootSessionId: string
      contract: TaskContract
      manifests: readonly CapabilityManifest[]
    }

/** What the admission half of one pre-checked batch is given: the proposal, the batch and the run it belongs to. */
interface AdmitBatchRequest {
  proposal: TaskProposalDecomposition
  parentTask: TaskInstance
  parentRun: TaskRun
  batch: NormalizedBatch
  manifests: readonly CapabilityManifest[]
  providers: ProviderPrecheck
  exec?: { signal?: AbortSignal; callId?: string }
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
  /**
   * The stores a cancellation is closing right now ({@link cancelGraph}), from
   * the instant its gate was closed to the instant the operation is done with
   * the store.
   *
   * A cancellation is the one transition that puts a barrier in effect *before*
   * the store records it, so during that window the record still says `running`
   * and phase `active` — older than the barrier already in effect here. A read
   * path that rebinds a session in the window would re-apply that older phase
   * and lift the barrier, so {@link gatePhaseFromStore} refuses to move a phase
   * a session already holds while its store is in this set. The store is the
   * truth again the moment the entry goes.
   */
  private readonly closingStores = new Set<string>()
  /**
   * One recovery barrier per store (A2 §E): what an explicit activation
   * awaits, what every business execution entry checks before its first side
   * effect, and what a cancellation or the unload invalidates. The persistent
   * record stays the source of truth; this map only says what this process has
   * recovered — it is never persisted and never a second state machine.
   */
  private readonly storeRecovery = new Map<string, StoreRecoveryState>()
  /** The one-writer-per-workspace ownership registry (A3 §3.4). */
  private readonly workspaces: WorkspaceRegistry
  /** The load-time provider scan, taken once ({@link providerLoadReport}). */
  private providerLoad?: Promise<ProviderLoadReport>
  /**
   * One tail per store and parent task: the serialization §6 asks for, so two
   * approved proposals competing for the same parent cannot interleave their
   * re-checks and their commits. See {@link serializeParent}.
   */
  private readonly parentChains = new Map<string, Promise<void>>()

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'taskRuntime')
    const rootBudget = config?.rootBudget === undefined ? undefined : { ...config.rootBudget }
    // A hard limit this deployment cannot execute is refused at load, not
    // accepted and quietly ignored (§3.5). The schema keeps unknown keys on the
    // object it validates, so a member named here that this class does not know
    // is refused too — a limit nobody would enforce is worse than no limit.
    this.assertClosedRootBudget(rootBudget)
    assertRootBudgetConfig(rootBudget ?? {})
    this.assertGeneratedTaskReview(config?.generatedTaskReview)
    this.config = {
      capabilities: structuredClone(config?.capabilities ?? DEFAULT_CAPABILITIES),
      ...(config?.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
      verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxChildren: config?.maxChildren ?? DEFAULT_MAX_CHILDREN,
      budget: { ...DEFAULT_BUDGET, ...(config?.budget ?? {}) },
      noProgressRounds: config?.noProgressRounds ?? DEFAULT_NO_PROGRESS_ROUNDS,
      allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
      generatedTaskReview: config?.generatedTaskReview ?? DEFAULT_GENERATED_TASK_REVIEW,
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
   * Refuse a review policy this build does not implement. The configuration
   * schema types the member, but a deployment that constructs the runtime
   * directly (a test, an embedding process) bypasses the schema, and a policy
   * nobody implements is worse than a refusal to start: a value like `"risk"`
   * would read as "somebody decides which batches are reviewed" while this
   * build quietly admits everything. `off` and `all` are the two modes §5
   * defines; nothing is inferred from a near miss.
   */
  private assertGeneratedTaskReview(policy: unknown): void {
    if (policy === undefined || policy === 'off' || policy === 'all') return
    throw new Error(
      `task-runtime: generatedTaskReview is ${JSON.stringify(policy)}; the review policy is "off" or "all" ` +
      '(§5 defines no other mode, and a policy this build cannot execute refuses to start rather than admitting unreviewed batches)',
    )
  }

  /**
   * The unload path: abort every driver, await their settlements, close the gate
   * for every session this runtime tracks, and release the workspace markers
   * this process wrote. Warnings, never throws — an unload that raised would
   * leave the rest of the process's disposal half-done.
   */
  private async unload(): Promise<void> {
    // The unload invalidates every recovery handle first (A2 §E): a driver
    // parked behind a barrier would otherwise hold the await below on a
    // barrier that no longer exists, and a store mid-recovery must not answer
    // `ready` for a process that is on its way out.
    for (const storeId of [...this.storeRecovery.keys()]) this.invalidateStoreRecovery(storeId)
    this.storeRecovery.clear()
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
   * The review policy in force for batches that have not been admitted yet
   * ({@link Config.generatedTaskReview}), exposed read-only: a deployment's own
   * policy is not a secret, and a caller that has to say what happens next
   * (`decomposeAndRun`'s pending answer, a tool's status line) should read it
   * from the runtime rather than infer it from a proposal's birth policy — the
   * two differ exactly when the deployment tightened it after that batch was
   * proposed.
   */
  get generatedTaskReview(): 'off' | 'all' {
    return this.config.generatedTaskReview
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

  /**
   * Open one root session's store and adopt the root it already holds, or say
   * that it holds none (A0 §3, the recovery half of the old `createRootTask`).
   *
   * **It creates nothing.** A root task comes into existence exactly one way —
   * a root contract that passed the review gate and was activated
   * ({@link intakeRootContract}) — and this entry refuses to be a second door:
   * there is no parameter, flag or entry that mints a root without a proposal,
   * which is what keeps §1.3's "批准前零根任务" a property of the system rather
   * than of one call path.
   *
   * What it does, in order: create-or-open the store (`rootTaskStoreId`), index
   * every run the store holds, and then —
   *
   * - **no root task**: run the store's own recovery pass (`reconcileStore`:
   *   settle or restart what a dead process left in flight, then the proposals)
   *   and answer from what that pass left. Adoption is the entry graphs and
   *   recovery use (§3 stage B), so the pass runs *here*: a contract whose
   *   approval is on the record and whose process died is carried into the root
   *   it was about by exactly this pass, and a waiting contract's review is
   *   re-asked from the stored facts by it — answering "nothing to adopt" before
   *   that pass would leave a recorded decision uncontinued. A root the pass
   *   activates is then bound the way the bullet below binds one; a store the
   *   pass leaves without a root still answers `{ adopted: false }`, with the
   *   proposals still open on it named by id and status and the fact that
   *   nothing was created stated. A store with no task is a normal state since
   *   §1.1 (a graph's store is opened by its creation and filled when a contract
   *   is accepted), not a failure to report;
   * - **a root task, with a run bound to this root session**: re-check the run's
   *   content binding (S1-C: a snapshot that is no longer readable refuses the
   *   re-entry by name rather than resuming against whatever stands at that path
   *   now), bind the session in this process, derive the session's gate phase
   *   from the store's own run record, settle or restart whatever the store left
   *   in flight (`reconcileStore`) and rebuild this process's workspace
   *   ownership — the same recovery a reopen performs;
   * - **a root task without a run for this session**: refuse by name. That state
   *   is a store whose root was created for a different session or whose run
   *   record is gone, and neither is something to guess a binding for.
   *
   * The gate phase is *derived*, never remembered: a root run that is no longer
   * running — terminal, cancelled, failed, verified — leaves the session
   * `terminal`, so a late intake or a late write on a finished root is refused by
   * the gate as well as by the state (§1.8). Reading it back from the store is
   * what makes that true after a restart, when no process holds the phase the
   * dead one set.
   *
   * **The recovery barrier (A2 §E).** This entry is what an explicit graph
   * activation awaits, and the whole pass above is one barrier: reconciliation
   * of the facts, the gate initialization for *every* session the store knows,
   * and the registration of the drivers the pass restarts. The barrier waits
   * for exactly those — never for a batch's execution or a model's output —
   * because a driver it registers is parked (registered, so a cancellation
   * finds it, but not started) until the barrier completes. A store-read
   * failure, a workspace conflict or an exception in the pass fails the barrier
   * rather than surfacing as a warning over an unrecovered store, and a
   * cancellation or the unload invalidates the handle it leaves. Nothing here
   * is a second persisted state machine: the store remains the only source of
   * truth, the next explicit activation is the retry, and business execution
   * checks the handle through {@link recoveryStatus} instead of re-running the
   * pass.
   */
  async adoptRoot(storeId: string, rootSessionId: string): Promise<RootAdoption> {
    // The barrier already in flight for this store is the one to wait for: the
    // join is the dedupe, so two explicit entries cannot run two recovery
    // passes concurrently — and a failed barrier's original error is this
    // caller's error.
    const inflight = this.storeRecovery.get(storeId)
    if (inflight !== undefined && inflight.status === 'recovering') {
      await inflight.promise
      // Re-read through a function so the outer narrowing cannot freeze the
      // verdict: the barrier this caller joined may have failed while awaited.
      const settledStatus = (state: StoreRecoveryState): StoreRecoveryState['status'] => state.status
      if (this.storeRecovery.get(storeId) === inflight && settledStatus(inflight) === 'failed') throw inflight.failure
    }
    const barrier = this.adoptRootThroughBarrier(storeId, rootSessionId)
    let release!: (start: boolean) => void
    const released = new Promise<boolean>(resolve => {
      release = resolve
    })
    const state: StoreRecoveryState = {
      status: 'recovering',
      promise: barrier.then(
        () => undefined,
        () => undefined,
      ),
      release,
      released,
      pendingDrivers: [],
    }
    this.storeRecovery.set(storeId, state)
    try {
      const adoption = await barrier
      // The barrier owes every session the store knows its gate phase (A2 §E):
      // one read taken after the pass, applied under the gate's own token rule.
      await this.initializeStoreGates(storeId)
      if (state.cancelled) {
        // A cancellation or the unload invalidated this barrier: it finished
        // its pass into a store that cancellation owns, so it leaves no ready
        // handle at all — the record, and the next explicit activation, decide
        // what the store is now.
        this.storeRecovery.delete(storeId)
      } else {
        state.status = 'ready'
        state.pendingDrivers.length = 0
      }
      // The drivers start only now — after the facts, the gates and the
      // registrations are settled. The barrier never waits for what they do;
      // an invalidated barrier stands its registrations down instead.
      release(!state.cancelled)
      return adoption
    } catch (error) {
      state.status = 'failed'
      state.reason = error instanceof Error ? error.message : String(error)
      state.failure = error
      // Not-started is not executed (A2 §E): the drivers this barrier
      // registered are aborted and removed, nothing is written on their behalf,
      // and the next explicit activation re-registers them from the persistent
      // record, which still says what the store holds.
      this.standDownPendingDrivers(state)
      release(false)
      // The temporary resources this barrier acquired go back; committed
      // recovery facts stay on the record.
      try {
        await this.releaseStoreWorkspace(storeId)
      } catch (cleanup) {
        this.warn(
          `store ${storeId}: its workspace could not be released after a failed recovery (${cleanup instanceof Error ? cleanup.message : String(cleanup)})`,
        )
      }
      throw error
    }
  }

  /** {@link adoptRoot}'s own pass, as one barrier body: the adoption in the order it always ran. */
  private async adoptRootThroughBarrier(storeId: string, rootSessionId: string): Promise<RootAdoption> {
    await this.openOrCreateStore(storeId)
    let snapshot = await this.ctx.task.snapshotIn(storeId)
    this.reindex(storeId, snapshot)
    let root = snapshot.tasks.find(task => task.parentTaskId === undefined)
    if (root === undefined) {
      // No root on the record is not the end of the question: the recovery pass
      // is what continues an approval that was recorded before the process died
      // (and what re-asks a waiting contract's review from the stored facts), so
      // it runs before the answer rather than after an explicit second call.
      await this.reconcileStore(storeId)
      snapshot = await this.ctx.task.snapshotIn(storeId)
      root = snapshot.tasks.find(task => task.parentTaskId === undefined)
      if (root === undefined) {
        return { adopted: false, detail: this.nothingAdoptedDetail(storeId, rootSessionId, snapshot) }
      }
    }
    const run = [...snapshot.runs].reverse().find(item => item.taskId === root.taskId && item.sessionId === rootSessionId)
    if (run === undefined) {
      throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${rootSessionId}"`)
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
    const phase = this.runGatePhase(run)
    this.sessions.set(rootSessionId, { storeId, taskId: root.taskId, runId: run.runId })
    this.startedSessions.add(rootSessionId)
    if (phase === 'terminal') this.executionGate.setTerminal(rootSessionId)
    else if (phase !== undefined) this.executionGate.setPhase(rootSessionId, phase)
    // Adoption is the recovery entry (§3.6): runs this process is not driving
    // are settled or restarted, and the workspace this tree holds is rebuilt
    // from its own batch chain.
    await this.reconcileStore(storeId)
    await this.rebuildWorkspaceOwnership(storeId)
    return {
      adopted: true,
      taskId: root.taskId,
      runId: run.runId,
      phase: phase ?? 'terminal',
      detail:
        `store "${storeId}" holds root task "${root.taskId}" with run "${run.runId}" for session "${rootSessionId}"; ` +
        `the session is bound and its gate is "${phase ?? 'ungated'}"`,
    }
  }

  /**
   * The gate initialization the recovery barrier owes every session the store
   * knows (A2 §E): one snapshot read taken *after* the pass, each run's phase
   * derived and applied under the gate's own token rule — the token is taken
   * before the read, so a decision that lands while it is in flight drops the
   * value it was about to apply. A run that predates phases leaves its session
   * ungated (A3's boundary: reading and cancelling are its only continuations),
   * and {@link gatePhaseFromStore}'s closing-store guard keeps a cancellation's
   * barrier ahead of this pass.
   *
   * This is the one place a restart's sessions get their phases back: the read
   * door (`lookupRun`) no longer writes the gate, so a query cannot be the
   * thing that recovers a store or re-gates a session. A store that cannot be
   * read here fails the barrier — half-gated is not recovered.
   */
  private async initializeStoreGates(storeId: string): Promise<void> {
    const tokens = new Map<string, number>()
    for (const [sessionId, binding] of this.sessions) {
      if (binding.storeId === storeId) tokens.set(sessionId, this.executionGate.decisionToken(sessionId))
    }
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      throw new Error(
        `store ${storeId} could not be read to initialize its sessions' gates after recovery ` +
        `(${error instanceof Error ? error.message : String(error)}); the recovery barrier fails rather than leaving the store half-gated`,
      )
    }
    for (const run of snapshot.runs) {
      this.gatePhaseFromStore(run.sessionId, run, storeId, tokens.get(run.sessionId) ?? 0)
    }
    // The question blocks come from the same read and the same tokens (A4 §F.1):
    // a restarted session whose run is waiting on an unresolved blocking question
    // is blocked again from the durable facts, whether or not this process bound
    // it — the gate keys on the session id, and the store's runs are what name
    // the sessions.
    applyStoreQuestionBlocking(this.executionGate, snapshot, sessionId => tokens.get(sessionId) ?? 0)
  }

  /**
   * What {@link adoptRoot} answers when the store still holds no root *after* its
   * recovery pass ran (A0 §3 stage B): the proposals that pass left open, by id and
   * status, and the fact that nothing was created.
   *
   * `adopted: false` is a normal answer (§1.1), and this detail is what keeps it an
   * honest one. Recovery never advances a waiting contract and never mints a root
   * without an accepted contract, so what a caller gets back is the state of the
   * intake rather than a verdict: the pass ran, a named proposal is still waiting
   * for a decision or a continuation, and adopting created no task, no run and no
   * proposal of its own.
   */
  private nothingAdoptedDetail(storeId: string, rootSessionId: string, snapshot: TaskSnapshot): string {
    const open = (snapshot.proposals?.all ?? []).filter(isOpenProposal)
    const waiting = open.length === 0
      ? 'no proposal is open on it'
      : `${open.length === 1 ? '1 proposal is' : `${open.length} proposals are`} still open: ` +
        open.map(proposal => `"${proposal.proposalId}" (${proposal.status})`).join(', ')
    return (
      `store "${storeId}" holds no root task for session "${rootSessionId}" after its recovery pass, which created no task, no run and no proposal; ` +
      `${waiting}; a root task is created by a root contract intake, never by adoption`
    )
  }

  /**
   * The gate phase one stored run implies: its coordination phase while it is
   * running, `terminal` once it is not, and `undefined` for a record that
   * predates coordination phases (A3's own boundary — such a run is not gated,
   * and its only legal continuation is cancellation).
   *
   * The derivation every rebinding door performs ({@link adoptRoot} for a root
   * session, {@link gatePhaseFromStore} for any other): the gate is a handle on
   * the run's phase, and the phase is the store's fact, so a session this
   * process never held — or one whose phase moved under an in-flight call — is
   * gated as what its run is, never as what this process happens to remember.
   */
  private runGatePhase(run: TaskRun): ExecutionPhase | 'terminal' | undefined {
    if (run.status !== 'running') return 'terminal'
    return run.executionPhase
  }

  /** Create the store, or open the one that already exists — the two ways a store can be there (A0 §1.1). */
  private async openOrCreateStore(storeId: string): Promise<void> {
    try {
      await this.ctx.task.createStore(storeId)
    } catch (error) {
      if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
      await this.ctx.task.openStore(storeId)
    }
  }

  /**
   * One root contract intake, all the way through (A0 §1.3–§1.4): the proposal
   * is submitted, and — when it may run — activated in the same call. This is
   * the entry the root agent's `task_intake` tool and a direct service call
   * share, and there is no third one: an intake that stops at "the proposal was
   * recorded" is {@link submitRootContractProposal}, and the only thing that
   * turns a proposal into a root task is {@link continueProposal}.
   *
   * Under `off` the submission is born `ready` and the continuation runs
   * immediately, so the *same* call both records `policy-off` and activates — the
   * caller never has to ask twice for a contract that needs no review. Under
   * `all` the proposal is born `pending_review` and this call returns with no
   * task, no run, no spawn and no notification: nothing exists until a recorded
   * decision approves it. A contract that fails the machine rules is refused
   * with field-level reasons before a proposal exists at all.
   */
  async intakeRootContract(
    storeId: string,
    rootSessionId: string,
    spec: RootContractSpec,
    options: RootIntakeOptions = {},
  ): Promise<RootIntakeResult> {
    if (options.exec?.signal?.aborted === true) {
      throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`)
    }
    await this.assertRecoveryReady(storeId, 'the intake of a root contract')
    const submission = await this.submitRootContractProposal(storeId, rootSessionId, spec, options)
    const continued = await this.continueProposal(storeId, submission.proposalId, rootSessionId)
    if (continued.status === 'activated') {
      return {
        status: 'activated',
        proposalId: continued.proposalId,
        taskId: continued.taskId,
        runId: continued.runId,
        detail: continued.detail,
      }
    }
    if (continued.status === 'pending_review') {
      return { status: 'pending_review', proposalId: continued.proposalId, detail: continued.detail }
    }
    throw new Error(
      `task-runtime: root contract of session "${rootSessionId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`,
    )
  }

  /**
   * One root contract proposal is submitted (A0 §1.2–§1.3): the pure pre-check,
   * the immutable record with the policy it was born under, and — under `all` —
   * the review request. Nothing is activated here, whatever the policy: no root
   * task, no run, no spawn, and no id minted except the proposal's own
   * content-derived one.
   *
   * The order is the same contract the batch path follows (§5: 坏提案不弹审批):
   * the presented contract is fixed and normalized, then judged — structural
   * rules, the root's independent-criterion rule, capability resolution and the
   * gap rule, the provider pre-check, the verifier ids — and a contract that
   * fails any of them is refused with field-level reasons *before* a proposal
   * exists, so nothing is shown to a person about a contract that could never
   * run. A contract that passes is recorded once behind its content-derived id,
   * carrying the contract itself, and a retry of the same request (same key,
   * same content) is answered from the record (`existing: true`) instead of
   * building a second proposal.
   */
  async submitRootContractProposal(
    storeId: string,
    rootSessionId: string,
    spec: RootContractSpec,
    options: RootIntakeOptions = {},
  ): Promise<ProposalSubmission> {
    await this.assertRecoveryReady(storeId, 'a root contract proposal')
    return await this.serializeRootIntake(storeId, () =>
      this.submitRootProposalOnce(storeId, rootSessionId, spec, options))
  }

  /**
   * Admission and progress are two phases with two owners (A3 §3.1), and this
   * entry is the boundary between them — now with the review gate of §5–§6 in
   * front of it.
   *
   * **Submission**: the batch is pre-checked (protected-input fixing,
   * normalization, structural admission, capability admission, the provider
   * pre-check, verifierRef validation — all before any write) and recorded as
   * an immutable proposal carrying the policy it was born under, the limits in
   * force and the resolution it was reviewed against
   * ({@link submitDecompositionProposal}).
   *
   * **Continuation** (governed by `exec.signal` and the stored decision): the
   * batch is re-checked against what it was proposed under — the parent's state,
   * the limits, the capability resolution, the judging verifiers — and only then
   * admitted ({@link continueProposal}). Under policy `all` that re-check has an
   * approval behind it, or the batch waits; under `off` it runs immediately,
   * exactly as it did before T2.
   *
   * **Admission and the atomic commit**: one `admitBatchIn` records the
   * children, their admission, the dependency edges, the batch identity, the
   * parent's `active → waiting_children` phase change (§1.3) *and* the proposal
   * it consumed, in one commit — so "this proposal became these tasks" is one
   * durable fact a crash can be recovered from. The root budget must be able to
   * reserve one run per child (§3.5), and the caller's checkout must already be
   * held by this run or an ancestor of it (§3.4). Every refusal here is a
   * refusal whole: no id minted, no event written, no worker started.
   *
   * **Progress** (governed by the runtime): the batch is handed to a driver
   * registered under the runtime's own controller, and this call returns
   * `{ batchId, childTaskIds }` immediately. The caller's signal dies with the
   * commit; a tool call that returns, or a caller that aborts its own call,
   * cannot stop a batch the store already admitted (§3.7). {@link awaitBatch}
   * and the owner notification are how a caller learns how it went.
   *
   * This entry keeps its pre-T2 signature and its `off`-path behaviour (it
   * returns the batch), and it is the gate, not the tool layer, that answers a
   * batch under `all`: a direct call gets `{ status: 'pending_review' }` and no
   * batch, exactly as the `task_decompose` tool does. A batch that was decided
   * against between the two calls (rejected, cancelled, stale, expired) is
   * refused by name — the caller has to revise and propose again, which is what
   * the diagnostic says.
   */
  async decomposeAndRun(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    exec: { signal?: AbortSignal; callId?: string } = {},
  ): Promise<DecomposeAdmissionResult> {
    await this.assertRecoveryReady(storeId, 'a decomposition')
    const submission = await this.submitDecompositionProposal(storeId, parentTaskId, parentRunId, callerSessionId, spec, {
      ...(exec.signal === undefined && exec.callId === undefined ? {} : { exec }),
    })
    const continued = await this.continueProposal(storeId, submission.proposalId, callerSessionId, {
      ...(exec.callId === undefined ? {} : { exec: { callId: exec.callId } }),
    })
    if (continued.status === 'admitted') {
      return { status: 'admitted', proposalId: continued.proposalId, batchId: continued.batchId, childTaskIds: continued.childTaskIds }
    }
    if (continued.status === 'pending_review') {
      return {
        status: 'pending_review',
        proposalId: continued.proposalId,
        detail: continued.detail,
        batchId: undefined as never,
        childTaskIds: undefined as never,
      }
    }
    throw new Error(
      `task-runtime: decomposition of "${parentTaskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`,
    )
  }

  /**
   * One decomposition proposal is submitted (T2/T3 §5–§6): the pure pre-check,
   * the immutable record with the policy it was born under, and — under `all` —
   * the review request. Nothing is admitted here and no child id is minted,
   * whatever the policy: submission is the record of what was asked for, and
   * {@link continueProposal} is the only path that turns it into tasks.
   *
   * The order is the contract (§5: 坏提案不弹审批): an illegal batch is refused
   * — with field-level reasons, and with the capability gaps the existing
   * mechanism records as obligations — before a proposal exists and therefore
   * before anything can be shown to a person. A batch that passes is recorded
   * once: the id is derived from its content and the request key from its
   * calling context, so a retry of the same request answers with the stored
   * proposal (`existing: true`) instead of building a second one, a different
   * content under the same explicit key is refused by name, and a revision is
   * new content and a new key.
   *
   * The proposal carries the batch's content, not only its digest (§6), so what
   * a reviewer reads, what a decision binds and what a continuation admits are
   * one record — and an approval taken in one process is continuable in another
   * with nothing but the store.
   */
  async submitDecompositionProposal(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    options: DecomposeProposalOptions = {},
  ): Promise<ProposalSubmission> {
    await this.assertRecoveryReady(storeId, 'a decomposition proposal')
    return await this.serializeParent(storeId, parentTaskId, () =>
      this.submitProposalOnce(storeId, parentTaskId, parentRunId, callerSessionId, spec, options))
  }

  /**
   * One continuation (§6): the post-approval (and post-restart) re-check, and
   * the only place a proposal becomes what it asked for — a batch of tasks, or
   * (A0 §1.4) a root task with its run.
   *
   * The re-check is the whole point of an approval being a *record* rather than
   * a switch. Before anything is admitted, the subject's own state, the limits in
   * force, the capability resolution, the judging verifiers and the content are
   * recomputed and compared with the fingerprints the approval bound — content
   * whose context moved is marked `stale` with the difference named (§6: 不把旧批准
   * 转移给新上下文), and a parent run that ended — or a store that already holds a
   * root, for a root contract — takes the approval down with it (`expired`, never
   * a dispatch). Only a proposal that still is what was reviewed is admitted,
   * from `ready`, with its consumption in the same commit.
   *
   * Idempotent from the outside: an already-admitted proposal answers with what
   * its consumption recorded (no second batch, no second root, no second commit),
   * a waiting one answers `pending_review` without writing anything, and a
   * terminal one answers with the status the store holds.
   *
   * `options.spec` re-presents the batch a caller believes this proposal means.
   * It is only ever a *confirmation*: the re-presented batch is derived and
   * compared with the stored identity, and a different batch — or one whose
   * protected acceptance inputs no longer reproduce the fixed identity — is
   * refused by name. The batch that is admitted is always the stored one, which
   * is what the approval was made against. A root contract needs no such
   * re-presentation: its subject is the store and the session, not a parent whose
   * batch a caller could have confused.
   */
  async continueProposal(
    storeId: string,
    proposalId: string,
    caller: string,
    options: { spec?: DecomposeSpec; exec?: { callId?: string } } = {},
  ): Promise<ProposalContinuation> {
    await this.assertRecoveryReady(storeId, 'the continuation of a proposal')
    const proposal = await this.requireProposal(storeId, proposalId)
    if (proposal.kind === 'root') {
      return await this.serializeRootIntake(storeId, () =>
        this.continueProposalIn(storeId, proposalId, caller, options))
    }
    return await this.serializeParent(storeId, proposal.identity.parentTaskId, () =>
      this.continueProposalIn(storeId, proposalId, caller, options))
  }

  /**
   * One review decision is recorded (T2/T3 §6) — the trusted entry the approval
   * channel (stage C) and tests call, never a model tool with a decision
   * argument. Everything it writes is read from the stored proposal: the
   * dossier digest and both context fingerprints come from the record, so a
   * decision cannot name a different batch than the one it is about, and the
   * reducer refuses a claim that disagrees with what is stored.
   *
   * An approval whose parent run has ended is **not** recorded as an approval:
   * §6's rule is that a late approval may only invalidate the proposal, so the
   * entry records `expired` with the reason that made it late and dispatches
   * nothing. An approval that lands is continued immediately
   * ({@link continueProposal}) — and a continuation that could not be performed
   * is reported in the result rather than thrown away: the approval is on the
   * record either way, and the caller learns why the batch did not run.
   */
  async decideProposal(
    storeId: string,
    proposalId: string,
    decision: { outcome: TaskProposalDecisionOutcome; reason?: string; decidedAt?: string },
    decidedBy: string,
    exec: { callId?: string } = {},
  ): Promise<ProposalDecisionResult> {
    await this.assertRecoveryReady(storeId, 'a proposal decision')
    const proposal = await this.requireProposal(storeId, proposalId)
    const serialize = async <T>(work: () => Promise<T>): Promise<T> =>
      proposal.kind === 'root'
        ? await this.serializeRootIntake(storeId, work)
        : await this.serializeParent(storeId, proposal.identity.parentTaskId, work)
    return await serialize(async () => {
      const current = await this.requireProposal(storeId, proposalId)
      if (decidedBy.trim().length === 0) throw new Error(`task-runtime: a decision on proposal "${proposalId}" requires a decider`)
      if (decision.reason !== undefined && decision.reason.trim().length === 0) {
        throw new Error(`task-runtime: a decision reason on proposal "${proposalId}" must be non-empty when given`)
      }
      const decidedAt = decision.decidedAt ?? now()
      let outcome = decision.outcome
      let reason = decision.reason
      if (outcome === 'approved') {
        // A late approval may only invalidate (§6), and what makes it late is the
        // subject's own state: a parent run that ended, or — for a root contract —
        // a store that already holds a root, because the intake this approval is
        // about could no longer become the store's root.
        const ended = await this.approvalLatenessReason(storeId, current)
        if (ended !== undefined) {
          outcome = 'expired'
          reason = `the approval arrived after ${current.kind === 'root' ? 'the root contract' : 'the batch'} could be dispatched: ${ended}`
        }
      }
      if (outcome === 'expired' && reason === undefined) {
        throw new Error(`task-runtime: an expiry of proposal "${proposalId}" must state what ended the batch`)
      }
      await this.ctx.task.decideProposalIn(storeId, {
        proposalId,
        outcome,
        proposalDigest: current.proposalDigest,
        admissionContextDigest: current.admissionContextDigest,
        ...(outcome === 'approved' ? { reviewContextDigest: current.reviewContextDigest } : {}),
        decidedBy,
        decidedAt,
        ...(reason === undefined ? {} : { reason }),
      }, decidedBy)
      if (outcome !== 'approved') {
        return {
          proposalId,
          outcome,
          status: outcome,
          detail: `proposal "${proposalId}" is ${outcome}${reason === undefined ? '' : `: ${reason}`}`,
          ...(reason === undefined ? {} : { reason }),
        }
      }
      try {
        const continuation = await this.continueProposalIn(storeId, proposalId, this.proposalCallerOf(current), { exec })
        return {
          proposalId,
          outcome,
          status: continuation.status,
          continuation,
          detail: `proposal "${proposalId}" is approved; ${continuation.detail}`,
        }
      } catch (error) {
        // The decision is on the record and what the proposal asked for was not
        // created. Both facts are reported: the proposal stays where the
        // continuation left it (`approved`, or `ready` when its re-check had
        // already passed), nothing is consumed, and the caller has the reason
        // instead of a state that pretends the work is running.
        const detail = error instanceof Error ? error.message : String(error)
        this.warn(`proposal ${proposalId}: the approval is recorded but the continuation failed (${detail})`)
        const stored = await this.readProposal(storeId, proposalId).catch(() => undefined)
        return {
          proposalId,
          outcome,
          status: stored?.status ?? outcome,
          detail: `the approval of proposal "${proposalId}" is recorded; ` +
            `${current.kind === 'root' ? 'the root was not activated' : 'the batch was not admitted'}: ${detail}`,
        }
      }
    })
  }

  /**
   * Why an approval arriving now is too late to be honoured, or `undefined` when
   * it is not. Two subjects, two questions: a decomposition batch is late when
   * its parent run has left the deciding phase ({@link parentRunEndedReason}),
   * and a root contract is late when the store already holds a root task — the
   * intake could no longer become that store's root, whatever the contract says.
   */
  private async approvalLatenessReason(storeId: string, proposal: TaskProposal): Promise<string | undefined> {
    if (proposal.kind !== 'root') return await this.parentRunEndedReason(storeId, proposal)
    const existing = await this.existingRootTask(storeId)
    if (existing === undefined) return undefined
    return `store "${storeId}" already holds root task "${existing.taskId}"`
  }

  /**
   * One explicit withdrawal of a proposal (T2/T3 §6; root contracts A0 §1.3): a
   * `cancelled` decision, by the session the proposal belongs to — the run that
   * proposed a batch, or the root session a contract is the goal of. A withdrawal
   * from anywhere else — a deployment retiring a proposal, a reviewer refusing
   * one — goes through {@link decideProposal} with `cancelled` or `rejected`,
   * which records *who* decided instead of hiding it behind the caller's
   * identity.
   */
  async cancelProposal(storeId: string, proposalId: string, caller: string): Promise<ProposalDecisionResult> {
    const proposal = await this.requireProposal(storeId, proposalId)
    const owner = this.proposalCallerOf(proposal)
    if (caller !== owner) {
      throw new Error(
        `task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" ` +
        'cannot withdraw it (a withdrawal by anybody else is a decision, and is recorded as one — decideProposal with "cancelled")',
      )
    }
    return await this.decideProposal(storeId, proposalId, { outcome: 'cancelled' }, caller)
  }

  /**
   * The session a proposal belongs to: the caller whose run proposed a batch, or
   * the root session a root contract is the goal of. One reader for the two
   * owners, so "who may continue, decide or withdraw this" is answered once
   * rather than re-derived — with the wrong field — at each entry.
   */
  private proposalCallerOf(proposal: TaskProposal): string {
    return proposal.kind === 'root' ? proposal.identity.rootSessionId : proposal.identity.callerSessionId
  }

  /**
   * The proposal one id names, as the store holds it (§6) — the read side a
   * tool renders. A proposal is addressed by `proposalId` and by nothing else:
   * there is no "is it approved?" question a caller can assert, and no approval
   * credential this entry would accept, because the answer is the stored record
   * or a refusal naming the id.
   */
  async proposalIn(storeId: string, proposalId: string): Promise<TaskProposal> {
    return await this.requireProposal(storeId, proposalId)
  }

  /** Every proposal one parent task holds, in submission order — what a task's own view of its batches reads. */
  async proposalsForParent(storeId: string, parentTaskId: TaskId): Promise<TaskProposal[]> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    return [...(snapshot.proposals?.byParentTask[parentTaskId] ?? [])]
  }

  /**
   * The first half of the pure pre-check (T2/T3 §2): the caller's declared
   * batch becomes a normalized one — protected acceptance inputs fixed against
   * the caller's own checkout (S1-V slice 2), the one normalization entry over
   * them, and the content identity out.
   *
   * It writes nothing: no event, no obligation, no child id, no proposal. The
   * derivation is separate from {@link checkDerivedBatch} because the *request*
   * a caller presents is decided by this value alone — the digest is what a
   * request key is derived from and what the store is searched by — while the
   * batch's admission rules are asked only once it is clear that this is not
   * simply a request the store already answers (T3 §6 idempotency).
   *
   * Protected inputs are fixed here, not in normalization: by the time the
   * single entry reads the batch there is one form and one form only, and a
   * refused fixing joins the normalization refusal — same error, same no-op.
   */
  private async deriveBatch(
    identity: DecompositionIdentityContext,
    spec: DecomposeSpec,
  ): Promise<{ ok: true; batch: NormalizedBatch; envPath?: string } | { ok: false; refusal: DecompositionRefusal }> {
    // The session's checkout, resolved once: the same directory the caller's
    // protected acceptance inputs are read against, the children's MCP servers
    // are bound to, and — S1-C — the granted skills are discovered from, since a
    // spawned worker inherits its cwd from this session
    // (`agent-runtime/src/index.ts`) and walks project skill roots upward from
    // there.
    const envPath = await this.envPathForSession(identity.callerSessionId)
    const fixed = await fixSpecProtectedInputs(spec, envPath)
    const normalized = normalizeDecomposition(fixed.spec, {
      ...identity,
      admissionContext: this.admissionContext(),
    })
    const reasons = [...fixed.reasons, ...(normalized.ok ? [] : normalized.reasons)]
    if (!normalized.ok || reasons.length > 0) {
      return { ok: false, refusal: { error: this.contractRefusal(identity.parentTaskId, reasons), reasons, gaps: [] } }
    }
    return { ok: true, batch: normalized.batch, ...(envPath === undefined ? {} : { envPath }) }
  }

  /** The manifests one normalized batch resolves to, in batch order — the same list the admission records per child. */
  private manifestsOf(batch: NormalizedBatch): CapabilityManifest[] {
    return batch.children.map(child => this.resolveCapabilities(child.contract.requiredCapabilities))
  }

  /**
   * The batch one stored proposal holds, in the shape admission consumes (§6):
   * the contracts and declarations a reviewer read, the caller's reason from the
   * identity, and the limits and digest the proposal recorded. The store is the
   * source of truth — a proposal carries its content, not only its digest — so a
   * continuation, a review request and a recovery in a process that never
   * submitted the batch all render and re-check the same batch from the saved
   * facts.
   *
   * Rebuilding cannot smuggle other content in: the record's own reducer refused
   * a submission whose {@link TaskProposalChild} entries disagree with the
   * identity (same order, same contract digests, same declarations), and the
   * continuation re-derives the identity from this batch and compares the digest
   * with the stored one before anything is admitted.
   */
  private storedBatchOf(proposal: TaskProposal): NormalizedBatch {
    if (proposal.kind === 'root') {
      // An internal invariant rather than a caller's mistake: every call site knows
      // it is holding a decomposition proposal, and one that does not is a bug the
      // message names instead of a batch rebuilt from a contract that has none.
      throw new Error(`task-runtime: proposal "${proposal.proposalId}" is a root contract; it holds one contract and no batch`)
    }
    return {
      contractVersion: proposal.identity.contractVersion,
      reason: proposal.identity.reason,
      children: proposal.batch.map(child => ({
        contract: structuredClone(child.contract),
        dependsOn: [...child.dependsOn],
        decomposable: child.decomposable,
        requiresIndependentAcceptance: child.requiresIndependentAcceptance,
      })),
      admission: {
        proposalDigest: proposal.proposalDigest,
        context: structuredClone(proposal.admissionContext),
      },
    }
  }

  /**
   * The run protocol one decomposition has to satisfy before anything is
   * proposed: the run belongs to this task, it is bound to this caller, it is
   * `active` (the admission gate — a run with an admitted batch settles it
   * before deciding anything else), and the call was not already cancelled.
   * Unknown and non-`active` phases are refusals rather than guesses, and a
   * phase-less run is an old record whose only legal continuation is
   * cancellation.
   *
   * These checks are asked *after* a request the store already answers has been
   * answered from the record: a retry of a request the run has already proposed
   * is that proposal, whatever state the run is in now (T3 §6 — the same request
   * never builds a second batch), while a genuinely new batch may only be
   * proposed by a run that is still deciding its own work.
   */
  private assertDecomposableRun(parentTask: TaskInstance, parentRun: TaskRun, callerSessionId: string, signal?: AbortSignal): void {
    const parentTaskId = parentTask.taskId
    if (parentRun.taskId !== parentTaskId) {
      throw new Error(`task-runtime: run "${parentRun.runId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`)
    }
    if (parentRun.sessionId !== callerSessionId) {
      throw new Error(`task-runtime: run "${parentRun.runId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`)
    }
    if (parentRun.executionPhase === undefined) {
      throw new Error(
        `task-runtime: run "${parentRun.runId}" predates coordination phases; it needs recovery ` +
        '(cancel this task tree and re-create it) before it can decompose',
      )
    }
    if (parentRun.executionPhase !== 'active') {
      throw new Error(
        `task-runtime: run "${parentRun.runId}" is in phase "${parentRun.executionPhase}"; only an active run may decompose ` +
        '(a run with an admitted batch settles it before deciding anything else)',
      )
    }
    if (signal?.aborted === true) {
      throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`)
    }
  }

  /**
   * The second half of the pure pre-check (§2): the batch's own admission rules
   * over a derived batch — structural admission (`contractDefects`,
   * `independentAcceptanceDefects`, the growth guardrails, dependency
   * acyclicity), capability resolution and the gap rule, the provider
   * pre-check, and verifierRef validation.
   *
   * Pure and reusable: this is exactly what the post-approval re-check asks
   * again (§6), and it answers with a value ({@link DecompositionRefusal}) so
   * the caller decides whether a refusal is a refusal or an invalidation.
   */
  private async checkDerivedBatch(request: {
    identity: DecompositionIdentityContext
    parentTask: TaskInstance
    batch: NormalizedBatch
    envPath?: string
  }): Promise<DecompositionPrecheck> {
    const { identity, parentTask, batch } = request
    const parentTaskId = identity.parentTaskId
    const snapshot = await this.ctx.task.snapshotIn(identity.storeId)
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
      batch.children.map(child => ({
        objective: child.contract.objective,
        acceptanceCriteria: child.contract.acceptanceCriteria,
        dependsOn: child.dependsOn,
        requiresIndependentAcceptance: child.requiresIndependentAcceptance,
      })),
      snapshot.edges,
    )
    if (!verdict.ok) {
      return {
        ok: false,
        refusal: {
          error: new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join('\n- ')}`),
          reasons: verdict.reasons,
          gaps: [],
        },
      }
    }

    const manifests = this.manifestsOf(batch)
    const rejected = batch.children
      .map((child, index) => ({ child, index, manifest: manifests[index]! }))
      .filter(({ child, manifest }) => manifest.missing.length > 0 && !child.decomposable)
    if (rejected.length > 0) {
      const detail = rejected
        .map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(', ')}] and may not decompose`)
        .join('; ')
      const gaps: CapabilityGap[] = rejected.map(({ index, manifest }) => ({
        childIndex: index,
        objective: batch.children[index]!.contract.objective,
        missing: [...manifest.missing],
      }))
      // The gap is a fact the submission path records before it refuses: one
      // obligation per missing capability, raised on the parent (KISS §7 — a
      // gap is a normal state with a record, not a silence). This entry writes
      // nothing, so the fact is carried out as a value and the L4 exit — a
      // separate, human-facing card the root raises with `escalate` — is named
      // in the refusal text.
      const gapNames = [...new Set(rejected.flatMap(({ manifest }) => manifest.missing))]
      return {
        ok: false,
        refusal: {
          error: new Error(
            `task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}; ` +
            escalationHint(
              `capabilities [${gapNames.join(', ')}] are not granted by the capability registry`,
              'capability_list and the children\'s declared capabilities',
              'grant the capability in the registry, or mark the child decomposable',
            ),
          ),
          reasons: [detail],
          gaps,
        },
      }
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
      { ...(request.envPath === undefined ? {} : { cwd: request.envPath }) },
    )
    const refusals = providerRefusals(precheck)
    if (refusals.length > 0) {
      return {
        ok: false,
        refusal: {
          error: new Error(
            `task-runtime: provider pre-check rejected decomposition of "${parentTaskId}":\n- ${refusals.join('\n- ')}`,
          ),
          reasons: refusals,
          gaps: [],
        },
      }
    }

    try {
      await this.assertKnownVerifierRefs(
        batch.children.flatMap((child, childIndex) =>
          child.contract.acceptanceCriteria.map(criterion => ({ childIndex, criterion }))),
        `decomposition of "${parentTaskId}"`,
      )
    } catch (error) {
      // A batch naming a judge this deployment cannot list is a *batch* defect,
      // so it travels as a refusal the caller may invalidate a proposal for. A
      // verifier service that cannot answer at all keeps its own error class and
      // message, and the continuation re-raises it instead of marking a reviewed
      // batch stale for a deployment's bad moment.
      const failure = error instanceof Error ? error : new Error(String(error))
      return { ok: false, refusal: { error: failure, reasons: [failure.message], gaps: [] } }
    }

    return { ok: true, batch, manifests, providers: precheck }
  }

  /**
   * The admission half of one batch that passed the pre-check (T2/T3 §6): the
   * protocol's own commitments, made only now — the root budget reserves one run
   * per child (§3.5), the caller's checkout must be this run's or an ancestor's
   * (§3.4), the child ids are minted, and one `admitBatchIn` commit records the
   * children, their admission, the dependency edges, the batch identity, the
   * parent's `active → waiting_children` phase change and the proposal
   * consumption together (§1.3). The driver is started last, so progress belongs
   * to the runtime before the caller hears anything.
   *
   * The proposal is what makes this half addressable: its consumption names the
   * very children this commit creates, so "the proposal was consumed and these
   * are its tasks" is one durable fact — the record a recovery reads instead of
   * admitting a second batch.
   *
   * A refusal here is a refusal whole (nothing is minted or committed), and it
   * leaves the proposal where it was: `ready` under policy `off`, or `approved`
   * for a batch that was approved and could not be started yet. Nothing is spent
   * by a budget that says no, and a later continuation retries the same batch.
   */
  private async admitPrecheckedBatch(request: AdmitBatchRequest): Promise<{ batchId: string; childTaskIds: TaskId[] }> {
    const { proposal, parentTask, parentRun, batch, manifests, exec = {} } = request
    const providers = request.providers
    const storeId = proposal.identity.storeId
    const parentTaskId = parentTask.taskId
    const callerSessionId = proposal.identity.callerSessionId
    const actor = callerSessionId
    if (exec.signal?.aborted === true) {
      throw new Error(`task-runtime: decomposition of "${parentTaskId}" was cancelled before anything was persisted`)
    }
    const childTaskIds = batch.children.map(() => `t-${randomUUID()}`)
    const snapshot = await this.ctx.task.snapshotIn(storeId)

    // The root budget's batch reservation (§3.5): every child of this batch will
    // start a run, so a batch that would push the tree past `maxRuns` is refused
    // whole — before a task, a run or an event exists — instead of admitted and
    // then started until the budget runs out mid-batch. Nothing is reserved at
    // submission: §6 keeps the accounting where the side effect is, so a
    // proposal waiting for a review holds no run slot and a cancelled proposal
    // refunds nothing (A3's own rule: the limit counts recorded runs).
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
    if (workspacePath !== undefined) await this.assertWorkspaceHeldBy(workspacePath, storeId, parentTask, parentRun.runId)

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
    // the parent's decomposition record, every child's capability manifest, the
    // parent's `active → waiting_children` phase change and — T2/T3 §6 — the
    // consumption of the proposal this batch *is*, together. It is the
    // admission's own closing act: either the batch exists with the gate shut
    // behind it and the record of which proposal became it, or nothing happened
    // at all.
    const batchId = batchIdFor(parentTaskId)
    await this.ctx.task.admitBatchIn(storeId, parentTaskId, parentRun.runId, children, actor, edges, batch.admission, manifests, {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      batchId,
      childTaskIds,
      admittedAt: now(),
    })
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
    this.startBatchDriver({
      storeId,
      parentTaskId,
      parentRunId: parentRun.runId,
      batchId,
      callerSessionId,
      reason: batch.reason,
      providers,
      ...(exec.callId === undefined ? {} : { excludeCallId: exec.callId }),
    })
    return { batchId, childTaskIds }
  }

  /* --- the root intake's own steps (A0 §1–§2) ------------------------------ */

  /**
   * The request key one root intake is addressed by: the caller's own when it has
   * one, otherwise derived from the store, the root session and the contract's
   * digest (`proposal.ts:rootProposalRequestKey`). The same derivation in both
   * the submission and the re-check, so "the request the store already answers"
   * is one question with one answer.
   */
  private rootRequestKey(storeId: string, rootSessionId: string, contract: TaskContract, requested?: string): string {
    return requested ?? rootProposalRequestKey({
      storeId,
      rootSessionId,
      contractDigest: contractDigest(contract),
    })
  }

  /** The root proposal one request key already names, or `undefined` when the key is free; other content under the key is refused by name (§6). */
  private async rootProposalForRequest(storeId: string, requestKey: string, contract: TaskContract): Promise<TaskProposalRoot | undefined> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const stored = snapshot.proposals?.byRequestKey[requestKey]
    if (stored === undefined) return undefined
    if (stored.kind !== 'root') {
      throw new Error(
        `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a decomposition batch; ` +
        'a request key names one proposal, and a root intake cannot take over a batch\'s key',
      )
    }
    if (stored.identity.contractDigest !== contractDigest(contract)) {
      throw new Error(
        `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose root contract is a different one ` +
        `(digest ${stored.identity.contractDigest} ≠ ${contractDigest(contract)}); a revision is new content under a new key (§6)`,
      )
    }
    return stored
  }

  /**
   * One root contract's origin, established before anything is read or written on
   * its behalf (A0 §1.10): the store must be the root session's own
   * (`rootTaskStoreId`), that session must be a top-level one — a delegated child
   * is a worker, and its task was admitted by its parent — and its own durable log
   * must hold the person's request: a `user/message` event whose
   * `source.kind === 'user'`, the kind DSH reserves for host-attested human input
   * (`tool-goal/src/authority.ts:hasDirectHumanInput`).
   *
   * **Why the check is fail-closed.** The rules are mechanical and each is
   * answered by a refusal rather than by a default: the store↔session mapping is
   * arithmetic, the delegation facts are the header the spawn stamped, and the
   * request half is *existence* — at least one message whose source is the person.
   * Everything else that reaches a session's log is attributed to its **producer**:
   * this deployment writes its own prompts under `runtime-prompt` (the graph setup
   * text and a spawn's delegated task, `agent-runtime`'s own source) and its notices
   * under `plugin` (`notify`), and neither counts — a session that only ever heard
   * from the deployment has no request to attribute a contract to, and treating the
   * model's summary of a conversation as the request is exactly the "model
   * self-reported confirmation" §1.10 forbids. A log this deployment cannot read is
   * refused for the same reason — "the source could not be checked" is not "the
   * source is the person". Deliberately absent: any natural-language entailment.
   * Whether the contract *states* the request well is the model's reasoning and the
   * §1.2 rules judge the contract itself; this rule only tests that a request of
   * the person's own is there.
   *
   * **Where each half belongs.** Which session may call `task_intake` — graph and
   * root-session membership — is the tool's own rule, because the `graphs` record
   * is the thing that knows it. What this check owns is the quadruple a caller can
   * hand in wrongly: the store, the session, the session's kind and its origin
   * (store ↔ session ↔ top-level ↔ origin), so both doors into a root — the tool's
   * call and a direct service call — meet the same rule wherever a caller reaches
   * the service from. A *top-level* session that no graph owns is deliberately not
   * distinguished here: that is membership, the model-facing door and its tool rule
   * own it, and a direct service caller is this deployment's own trusted code.
   *
   * **Zero side effects.** This is two reads (an id derivation and a log opened
   * `read` and closed), so a refusal here leaves no store opened, no proposal, no
   * task, no run, no worker and no notice — which is why both entries that could
   * create a root call it before their first write.
   */
  private async assertRootContractOrigin(storeId: string, rootSessionId: string): Promise<void> {
    const own = rootTaskStoreId(rootSessionId)
    if (storeId !== own) {
      throw this.originRefusal(
        rootSessionId,
        `store "${storeId}" is not this session's own store ("${own}"), and a root contract is intaken into the store of the session that asked ` +
        '(A0 §1.10) — never into another session\'s, whatever the contract says',
      )
    }
    const { header, events } = await this.rootSessionLog(rootSessionId)
    // The session's kind, before its log: a spawned session works on a task its
    // parent already admitted, and no message on its log can make it the
    // top-level session a graph created.
    if (header?.origin === 'subagent') {
      throw this.originRefusal(
        rootSessionId,
        'this session is a delegated child (its header records origin "subagent"), and a root contract belongs to the top-level session a graph ' +
        'created — the task a spawned session works on was already admitted by its parent (A0 §1.10)',
      )
    }
    const depth = header?.delegationDepth ?? 0
    if (depth > 0) {
      throw this.originRefusal(
        rootSessionId,
        `this session is a delegated child (its header records delegation depth ${depth}), and a root contract belongs to the top-level session a ` +
        'graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)',
      )
    }
    if (events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
    throw this.originRefusal(
      rootSessionId,
      'this session\'s own log holds no message from the person (no `user/message` event with source.kind "user", the marker DSH reserves for ' +
      'host-attested human input), so the request the contract stands on cannot be established here; the messages this deployment writes to a ' +
      'session of its own are attributed to their producers — its prompts carry source.kind "runtime-prompt" (the graph setup text and a spawn\'s ' +
      'delegated task) and its notices carry "plugin" — and neither is a request of the person\'s (A0 §1.10)',
    )
  }

  /**
   * One root session's own durable log and header, read through
   * `sessionPersistence` in one open/read/close — the surface a session's requests
   * are recorded on, and the record of what kind of session it is — or a named
   * refusal when this deployment cannot read it: no persistence service is
   * mounted, the session is missing, or the open/read throws. The refusal is the
   * answer rather than an empty log, because the rule it feeds is fail-closed
   * ({@link assertRootContractOrigin}): an unreadable log is "the origin is not
   * established", never "assume there is one". The header is handed back as the
   * handle exposes it — a backend that models only the log answers `undefined`,
   * which is read as "no delegation facts recorded" rather than as delegation.
   */
  private async rootSessionLog(rootSessionId: string): Promise<{ readonly header: SessionHeader | undefined; readonly events: readonly SessionEvent[] }> {
    const persistence = this.softService<SessionLogReader>('sessionPersistence')
    if (persistence === undefined || typeof persistence.open !== 'function') {
      throw this.originRefusal(rootSessionId, 'this deployment mounts no session-persistence service, so its own log cannot be read (A0 §1.10)')
    }
    let handle: Awaited<ReturnType<SessionLogReader['open']>> | undefined
    try {
      handle = await persistence.open(SessionId(rootSessionId), 'read')
      const { events } = await handle.read(0)
      return { header: handle.header, events }
    } catch (error) {
      throw this.originRefusal(rootSessionId, `its own log could not be read (${error instanceof Error ? error.message : String(error)})`)
    } finally {
      // A close that fails is not this call's answer: the log was already read —
      // or already refused by name — and the handle's teardown is best-effort
      // here as it is everywhere else in this module.
      if (handle !== undefined) await handle.close().catch(() => undefined)
    }
  }

  /**
   * The one refusal text a root contract whose origin could not be established is
   * refused with, whichever rule (or which unreadable log) said so. It is a
   * family of its own rather than {@link rootRefusal}'s: "the contract was judged
   * and found wanting" and "the request behind it is not established" are
   * different facts about a call, and a caller that revises a contract must not
   * confuse the second for the first.
   */
  private originRefusal(rootSessionId: string, reason: string): Error {
    return new Error(`task-runtime: the root contract of session "${rootSessionId}" was refused: ${reason}`)
  }

  /**
   * One root submission, inside the store's root-intake serialization: the
   * contract is fixed and normalized, a request the store already answers is
   * answered from the record, everything else is judged, and the record is
   * written once.
   *
   * The order is the batch path's, for the same reasons: §5's 坏提案不弹审批
   * needs the judgement *before* the record, and T3 §6's idempotency needs the
   * record lookup *before* the judgement — a retry of a request the store
   * already answers is that proposal whatever state the store has moved to since.
   *
   * Ahead of all of it is one rule that is not about the contract at all: the
   * origin of the request it states (§1.10), checked before the store is even
   * opened ({@link assertRootContractOrigin}).
   */
  private async submitRootProposalOnce(
    storeId: string,
    rootSessionId: string,
    spec: RootContractSpec,
    options: RootIntakeOptions,
  ): Promise<ProposalSubmission> {
    // An already-cancelled call persists nothing — the same rule the batch path
    // holds its own admission call to (A3 §3.1's signal boundary).
    if (options.exec?.signal?.aborted === true) {
      throw new Error(`task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`)
    }
    // Where the request came from, before anything is opened or written: a store
    // that is not the session's own, a session that is a delegated child, or one
    // whose own log holds no request of the person's, is a named refusal here and
    // leaves no store behind
    // (§1.10, {@link assertRootContractOrigin}) — a refused intake must not even
    // create the target store.
    await this.assertRootContractOrigin(storeId, rootSessionId)
    // The root session's store exists before its contract does (A0 §1.1): a graph
    // creates the session, and the intake is what fills the store — so this is the
    // entry that opens it. A store that is already there is opened, never reset.
    await this.openOrCreateStore(storeId)
    // The session's checkout is resolved once: the directory the contract's
    // protected acceptance inputs are read against, the provider pre-check
    // discovers from, and the run the activation starts will work in. It is the
    // root session's own graph env, exactly as a parent run's is its own.
    const envPath = await this.envPathForSession(rootSessionId)
    const derived = await this.deriveRootContract(spec, envPath)
    if (!derived.ok) throw derived.refusal
    const { contract } = derived
    const requestKey = this.rootRequestKey(storeId, rootSessionId, contract, options.requestKey)
    const stored = await this.rootProposalForRequest(storeId, requestKey, contract)
    if (stored !== undefined) {
      // The caller asked again for the contract this request names: the record
      // already carries it, so the answer is the record — and a proposal still
      // waiting gets the review asked again, because a caller asking again is
      // evidence that somebody is still waiting for it.
      const review = stored.status === 'pending_review'
        ? await this.requestProposalReview({
            kind: 'root',
            storeId,
            trigger: 'submitted',
            proposal: stored,
            rootSessionId,
            contract: structuredClone(stored.contract),
            manifests: this.rootManifests(stored.contract),
          })
        : undefined
      return {
        proposalId: stored.proposalId,
        status: stored.status,
        policy: stored.policy,
        existing: true,
        detail: this.rootSubmissionDetail(stored, true),
        ...(review === undefined ? {} : { review }),
      }
    }

    // A genuinely new root contract: the store must not already hold a root (the
    // same gate the reducer enforces inside the commit, asked here so the caller
    // hears it from the entry it called), and every admission rule has to pass.
    const root = await this.existingRootTask(storeId)
    if (root !== undefined) {
      throw new Error(
        `task-runtime: store "${storeId}" already holds root task "${root.taskId}", so a root contract cannot be intaken here (§1.6: ` +
        'an old graph\'s root is history and is not re-intaken; a new goal is a new graph)',
      )
    }
    const checked = await this.checkRootContract({ rootSessionId, contract, ...(envPath === undefined ? {} : { envPath }) })
    if (!checked.ok) throw checked.refusal.error
    const { manifests, providers } = checked
    const reviewContext = reviewContextOf({
      manifests,
      criteria: contract.acceptanceCriteria,
      providers: providerContentIdentities(providers.capabilities),
    })
    const policy = this.config.generatedTaskReview
    const identity: RootProposalIdentity = {
      contractVersion: TASK_CONTRACT_VERSION,
      storeId,
      rootSessionId,
      requestKey,
      contractDigest: contractDigest(contract),
    }
    const proposal: TaskProposalRoot = {
      kind: 'root',
      proposalId: rootProposalId(identity),
      requestKey,
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
      status: policy === 'all' ? 'pending_review' : 'ready',
      policy,
      identity,
      // The contract travels with the proposal, not only its digest: a reviewer,
      // a resumed approval request after a restart and the activation itself all
      // rest on the store alone (§2).
      contract: structuredClone(contract),
      proposalDigest: rootProposalDigest(identity),
      admissionContext: this.admissionContext(),
      admissionContextDigest: admissionContextDigest(this.admissionContext()),
      reviewContext,
      reviewContextDigest: reviewContextDigest(reviewContext),
      createdAt: now(),
    }
    try {
      await this.ctx.task.submitProposalIn(storeId, proposal, rootSessionId)
    } catch (error) {
      // A store that already holds *this* contract is a race, not a failure: the
      // request is answered from the record exactly as a retry is. Anything else
      // (a key bound to other content, a root task that appeared between the
      // check above and this write) is raised unchanged.
      const raced = await this.readProposal(storeId, proposal.proposalId).catch(() => undefined)
      if (raced === undefined || raced.kind !== 'root' || raced.proposalDigest !== proposal.proposalDigest) throw error
      return {
        proposalId: raced.proposalId,
        status: raced.status,
        policy: raced.policy,
        existing: true,
        detail: this.rootSubmissionDetail(raced, true),
      }
    }
    if (proposal.status !== 'pending_review') {
      return {
        proposalId: proposal.proposalId,
        status: proposal.status,
        policy: proposal.policy,
        existing: false,
        detail: this.rootSubmissionDetail(proposal, false),
      }
    }
    const review = await this.requestProposalReview({
      kind: 'root',
      storeId,
      trigger: 'submitted',
      proposal,
      rootSessionId,
      contract: structuredClone(contract),
      manifests,
    })
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      policy: proposal.policy,
      existing: false,
      detail: this.rootSubmissionDetail(proposal, false),
      review,
    }
  }

  /**
   * The first half of the root pre-check: the declared contract's protected
   * acceptance inputs are fixed against the root session's checkout (S1-V slice
   * 2 — a path that cannot be read, or a session whose checkout cannot be
   * resolved, refuses the whole contract), and the single root normalization
   * entry reads the result. Writes nothing.
   */
  private async deriveRootContract(
    spec: RootContractSpec,
    envPath: string | undefined,
  ): Promise<{ ok: true; contract: TaskContract } | { ok: false; refusal: Error }> {
    const declared = Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : []
    const fixed = await fixCriteriaProtectedInputs(declared, envPath, 'root contract')
    const presented = fixed.reasons.length === 0 ? { ...spec, acceptanceCriteria: fixed.criteria } : spec
    const normalized = normalizeRootContract(presented)
    const reasons = [...fixed.reasons, ...(normalized.ok ? [] : normalized.reasons)]
    if (!normalized.ok || reasons.length > 0) return { ok: false, refusal: this.rootRefusal(reasons) }
    return { ok: true, contract: normalized.contract }
  }

  /** The one refusal text a root contract is rejected at the contract stage with, whichever step produced the reasons. */
  private rootRefusal(reasons: readonly string[]): Error {
    return new Error(`task-runtime: root contract rejected:\n- ${reasons.join('\n- ')}`)
  }

  /** The manifests one root contract resolves to, from its declared capabilities — the list the activation records. */
  private rootManifests(contract: TaskContract): CapabilityManifest[] {
    return [this.resolveCapabilities(contract.requiredCapabilities)]
  }

  /** The store's root task, if it has one, read from the store rather than remembered. */
  private async existingRootTask(storeId: string): Promise<TaskInstance | undefined> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    return snapshot.tasks.find(task => task.parentTaskId === undefined)
  }

  /**
   * The second half of the root pre-check (A0 §3): every rule a root contract
   * has to clear before it can be proposed — structural (`contractDefects`), the
   * independent-criterion rule that makes it a *goal* rather than a restatement
   * of its own decomposition ({@link rootIndependenceDefects}), the capability
   * resolution with the gap rule, the provider pre-check from the root session's
   * own viewpoint, and the verifier ids its criteria pin.
   *
   * The gap rule differs from a batch child's by design: a child that is missing
   * a capability and may decompose is admitted with the gap recorded as an
   * obligation (its parent delegated the gap down), while a root intake has
   * nobody above it to delegate to and nothing to record the gap *on* — the task
   * does not exist yet — so a declared capability this deployment cannot grant is
   * a named refusal. Zero side effects: no obligation, no task, no run, and no
   * file written (the protected inputs were read, never rewritten).
   *
   * Pure and reusable: this is what the post-approval re-check asks again, so a
   * contract whose resolution moved is judged by the same rules that judged it at
   * submission.
   */
  private async checkRootContract(request: {
    rootSessionId: string
    contract: TaskContract
    envPath?: string
  }): Promise<RootPrecheck> {
    const { rootSessionId, contract } = request
    const label = `root contract of session "${rootSessionId}"`
    const defects = [
      ...contractDefects(contract.acceptanceCriteria, label),
      ...rootIndependenceDefects(contract.acceptanceCriteria, label),
    ]
    if (defects.length > 0) {
      return { ok: false, refusal: { error: this.rootRefusal(defects), reasons: defects } }
    }
    const manifests = this.rootManifests(contract)
    const manifest = manifests[0] as CapabilityManifest
    if (manifest.missing.length > 0) {
      const detail = `${label} is missing [${manifest.missing.join(', ')}] and a root has no parent to delegate them to`
      return { ok: false, refusal: { error: this.rootRefusal([detail]), reasons: [detail] } }
    }
    const precheck = await this.providerPrecheck(Object.keys(manifest.capabilities), {
      ...(request.envPath === undefined ? {} : { cwd: request.envPath }),
    })
    const refusals = providerRefusals(precheck)
    if (refusals.length > 0) {
      return {
        ok: false,
        refusal: { error: this.rootRefusal([`the provider pre-check rejected ${label}:`, ...refusals]), reasons: refusals },
      }
    }
    try {
      await this.assertKnownVerifierRefs(
        contract.acceptanceCriteria.map(criterion => ({ childIndex: 0, criterion })),
        label,
      )
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      return { ok: false, refusal: { error: failure, reasons: [failure.message] } }
    }
    return { ok: true, manifests, providers: precheck }
  }

  /**
   * One root continuation: the re-check ladder, and — if it passes — the
   * activation. §1.4's rule is that a root contract becomes a task *only* here
   * and only after the approval's own context is re-confirmed.
   *
   * The ladder, in the order the facts become decisive:
   *
   * 1. the origin of the request the contract states (§1.10,
   *    {@link assertRootContractOrigin}) — a store that is not the session's own, a
   *    session that is a delegated child, or a session whose own log holds no
   *    request of the person's, cannot carry a root at all, and this is decided
   *    before the ladder's first write;
   * 2. the store's root task — a store that already holds one refuses every
   *    further root intake. If the root on record is the one *this* proposal
   *    consumed, the proposal is already admitted and the status ladder above has
   *    answered; anything else is another root (a goal change is a new graph),
   *    and this proposal can never become one, so it is `expired` by name;
   * 3. the limits in force, against the fingerprint the approval bound — a
   *    deployment that moved them after the review invalidates it (§6);
   * 4. the resolution this contract was reviewed against — its declared
   *    capabilities, the providers behind them and the verifiers its criteria
   *    pin — recomputed and compared, with the difference named.
   *
   * Only then does it activate, and the activation is one atomic commit
   * ({@link activateRootContract}) followed by this process's own binding, so a
   * crash between the two is recovered by re-running this ladder: the consumption
   * on record is what makes the second run an answer rather than a second root.
   */
  private async continueRootProposalIn(
    storeId: string,
    proposal: TaskProposalRoot,
  ): Promise<ProposalContinuation> {
    const rootSessionId = proposal.identity.rootSessionId
    // The origin rule again, before the ladder's first write (§1.10): a proposal
    // recorded before this rule existed, or written into the store by any other
    // hand, must not be able to *become* the store's root either. Every step
    // below this line — the expiry of a store that already holds a root, the
    // tightening, the stale marking, the activation commit — is a write, and the
    // refusal here leaves none of them attempted.
    await this.assertRootContractOrigin(storeId, rootSessionId)
    const existing = await this.existingRootTask(storeId)
    if (existing !== undefined) {
      return await this.expireProposal(
        storeId,
        proposal,
        `store "${storeId}" already holds root task "${existing.taskId}"; a root contract is one per store and a changed goal is a new graph ` +
        '(§1.6), so this proposal can no longer become the store\'s root',
      )
    }
    // The policy gate (§5), the same rule the batch path follows: a contract born
    // under `off` that has not been activated is subject to the deployment's
    // *current* policy, so a deployment that tightened to `all` sends it for the
    // review it never had. The other direction is not a release — a waiting
    // proposal is never freed by a change to `off`, which is why this reads the
    // stored policy as well as this one — and the review itself is requested from
    // the stored contract when this process can still show it.
    const envPath = await this.envPathForSession(rootSessionId)
    const contract = structuredClone(proposal.contract)
    if (proposal.status === 'ready' && proposal.policy === 'off' && this.config.generatedTaskReview === 'all') {
      await this.ctx.task.changeProposalPhaseIn(storeId, {
        proposalId: proposal.proposalId,
        to: 'pending_review',
        reason: 'the deployment tightened the review policy to "all" while this contract had not been activated yet (§5: only tightening is allowed, and it reaches whatever has not run)',
      }, rootSessionId)
      let detail = 'it is now waiting for a review'
      const reviewed = await this.checkRootContract({ rootSessionId, contract, ...(envPath === undefined ? {} : { envPath }) })
      const tightened = await this.requireProposal(storeId, proposal.proposalId)
      if (reviewed.ok) {
        const review = await this.requestProposalReview({
          kind: 'root',
          storeId,
          trigger: 'tightened',
          proposal: tightened,
          rootSessionId,
          contract,
          manifests: reviewed.manifests,
        })
        detail += `; ${review.detail}`
      } else {
        detail += `, and its contract no longer passes admission (${reviewed.refusal.reasons.join('; ')})`
      }
      return { proposalId: proposal.proposalId, status: 'pending_review', detail: `proposal "${proposal.proposalId}" was sent for review: ${detail}` }
    }
    const contextDigest = admissionContextDigest(this.admissionContext())
    if (contextDigest !== proposal.admissionContextDigest) {
      return await this.staleProposal(
        storeId,
        proposal,
        `the limits in force moved since the contract was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`,
      )
    }
    const checked = await this.checkRootContract({ rootSessionId, contract, ...(envPath === undefined ? {} : { envPath }) })
    if (!checked.ok) {
      if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error
      return await this.staleProposal(
        storeId,
        proposal,
        `the contract no longer passes admission: ${checked.refusal.reasons.join('; ')}`,
      )
    }
    const { manifests, providers } = checked
    const reviewContext = reviewContextOf({
      manifests,
      criteria: contract.acceptanceCriteria,
      providers: providerContentIdentities(providers.capabilities),
    })
    const reviewDigest = reviewContextDigest(reviewContext)
    if (reviewDigest !== proposal.reviewContextDigest) {
      return await this.staleProposal(
        storeId,
        proposal,
        `the resolution this contract was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`,
      )
    }
    if (proposal.status === 'approved') {
      await this.ctx.task.changeProposalPhaseIn(storeId, {
        proposalId: proposal.proposalId,
        to: 'ready',
        reason: 'the post-approval re-check passed: the store holds no root, the limits are the ones reviewed, and the capability resolution and the judging verifiers are the ones reviewed',
      }, rootSessionId)
    }
    return await this.activateRootContract({
      storeId,
      rootSessionId,
      proposal,
      contract,
      manifests,
    })
  }

  /**
   * The activation (A0 §1.4): one atomic commit creates the root task (parentless,
   * depth 0, carrying the approved contract), its run (born `active`, in the
   * proposal's root session) and the proposal's consumption — and then this
   * process binds what only a process can hold.
   *
   * The order, and why each step is where it is:
   *
   * 1. **the checkout is claimed before anything is written.** A workspace another
   *    live owner holds fails the activation with nothing persisted
   *    ({@link WorkspaceBusyError}, §3.4), which is the same claim-before-write
   *    order every run creation follows; a claim this call made and then lost the
   *    commit for is released, so a refused activation leaves no ownership of a
   *    root that does not exist;
   * 2. **the run's content binding is materialized** (S1-C) — the same builder
   *    every run uses, so a root that grants nothing still gets the honest empty
   *    record rather than no record at all;
   * 3. **the commit** (`admitRootProposalIn`) writes the task, the admission, the
   *    capability manifest, the run and the consumption together. The reducer
   *    refuses a store that already has a root, a consumption naming other
   *    content, and a run that is not born active in this session — so a racing
   *    second activation writes nothing;
   * 4. **the in-process binding**: the session map, the started-session set and
   *    the gate, which is what makes the root session's own tools — decompose,
   *    submit, cancel — legal from here on;
   * 5. **the notification** (best-effort, through the existing owner notice): a
   *    root session that was waiting for its intake hears that its contract is
   *    live. It is a notice, never a wake-up obligation: a session with no live
   *    agent is skipped, and nothing about the activation depends on it.
   *
   * Idempotent from the outside by construction: the ladder in
   * {@link continueRootProposalIn} answers an admitted proposal from its own
   * consumption, and the reducer refuses a second activation even if two callers
   * raced past that read. One accepted fact, one root.
   */
  private async activateRootContract(request: {
    storeId: string
    rootSessionId: string
    proposal: TaskProposalRoot
    contract: TaskContract
    manifests: readonly CapabilityManifest[]
  }): Promise<ProposalContinuation> {
    const { storeId, rootSessionId, proposal, contract } = request
    const manifest = request.manifests[0] as CapabilityManifest
    const taskId: TaskId = `t-${randomUUID()}`
    const runId: RunId = `r-${randomUUID()}`
    const workspacePath = await this.workspacePathForSession(rootSessionId)
    let claimed: WorkspaceOwner | undefined
    if (workspacePath !== undefined && this.workspaces !== undefined) {
      await this.workspaces.claim(workspacePath, { kind: 'run', storeId, taskId, runId, since: now() })
      claimed = this.workspaces.ownerOf(workspacePath)
    }
    try {
      const providerBinding = await bindRunProviders({
        storeId,
        runId,
        manifest,
        table: this.config.capabilities,
        root: this.config.runBindingRoot,
      })
      const task: TaskInstance = {
        taskId,
        definitionRef: { taskType: 'root', version: 1 },
        objective: contract.objective,
        depth: 0,
        acceptanceCriteria: contract.acceptanceCriteria,
        requestedCapabilities: [...contract.requiredCapabilities],
        decompositionStatus: 'decomposable',
        status: 'created',
        runIds: [],
        childTaskIds: [],
        contract: structuredClone(contract),
      }
      const run: TaskRun = {
        runId,
        taskId,
        sessionId: rootSessionId,
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
      const consumption: TaskProposalRootConsumption = {
        kind: 'root',
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        reviewContextDigest: proposal.reviewContextDigest,
        rootTaskId: taskId,
        rootRunId: runId,
        admittedAt: now(),
      }
      await this.ctx.task.admitRootProposalIn(storeId, task, run, rootSessionId, { consumption, manifest })
    } catch (error) {
      // Nothing was committed (the commit is all-or-nothing), so the claim this
      // call made is the only thing to undo: leaving it would hold a checkout for
      // a root that does not exist.
      if (workspacePath !== undefined && claimed !== undefined) {
        await this.workspaces?.release(workspacePath, claimed).catch(cause => {
          this.warn(`workspace ${workspacePath} could not be released after a refused activation (${cause instanceof Error ? cause.message : String(cause)})`)
        })
      }
      throw error
    }
    this.sessions.set(rootSessionId, { storeId, taskId, runId })
    this.startedSessions.add(rootSessionId)
    this.executionGate.setPhase(rootSessionId, 'active')
    this.notify(
      rootSessionId,
      `the root contract of this session was activated: task ${taskId}, run ${runId} (proposal ${proposal.proposalId}, policy ${proposal.policy}). ` +
      'This session may now decompose, submit its own result, or cancel.',
    )
    return {
      proposalId: proposal.proposalId,
      status: 'activated',
      taskId,
      runId,
      detail: `proposal "${proposal.proposalId}" is activated as root task ${taskId} with run ${runId}`,
    }
  }

  /** One root submission's answer, in one sentence: the policy it was born under, the status it holds, and what the caller owes next. */
  private rootSubmissionDetail(proposal: TaskProposal, existing: boolean): string {
    const head = existing
      ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})`
      : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`
    switch (proposal.status) {
      case 'ready':
        return `${head}; continue it to activate the root (policy off activates without a review, and the record says policy-off)`
      case 'pending_review':
        return `${head}; it needs a recorded decision before the root may exist, and nothing is created, spawned or notified until then`
      case 'approved':
        return `${head}; the approval is on record and the root is not activated yet — continue it to run the post-approval re-check`
      case 'admitted':
        return `${head}; its root is activated already and will not be activated again`
      default:
        return `${head}; a ${proposal.status} proposal is not activated, and a revision is new content under a new key`
    }
  }

  /**
   * One store's root intakes, one at a time. The batch path serializes per
   * parent (§6's "单进程同一父分解…应串行"); a root contract has no parent, so the
   * subject that has to be serialized is the store itself — two intakes racing
   * into one store must not both read "no root task yet" and both commit. The
   * store's own reducer is the second line of defence (a store that already
   * holds a root refuses the second activation), and a second *process* is
   * covered by it alone, never by this map.
   */
  private async serializeRootIntake<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    return await this.serializeParent(storeId, ROOT_PROPOSAL_TASK_ID, work)
  }

  /**
   * One submission, inside the parent's serialization: derivation, idempotency,
   * the run protocol, the batch's admission rules, the record, and — under
   * `all` — the review request. The order is the contract:
   *
   * 1. the presented batch is derived (protected inputs fixed, one
   *    normalization), and an illegal batch is refused here, field by field,
   *    *before* a proposal exists — §5's 坏提案不弹审批, and the capability gaps
   *    of such a refusal are recorded as obligations by the same mechanism the
   *    admission chain always used, because the derivation and the batch
   *    judgement write nothing;
   * 2. a request the store already answers (the same key and the same content)
   *    is answered from the record — `existing: true`, the stored status, and,
   *    for a proposal that is still waiting, the review requested again, because
   *    a caller asking again is evidence that somebody is still waiting. This
   *    comes *before* the run protocol, so a retry of a request the run has
   *    already proposed is that proposal whatever state the run is in now;
   * 3. a genuinely new batch takes the run protocol (only a run that may still
   *    decide its own work may propose one) and every admission rule, then the
   *    record is written once behind a content-derived id — carrying the batch
   *    content itself, so the review, the decision and a later continuation all
   *    rest on the same stored facts.
   */
  private async submitProposalOnce(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    options: DecomposeProposalOptions,
  ): Promise<ProposalSubmission> {
    const actor = callerSessionId
    const identity: DecompositionIdentityContext = { storeId, parentTaskId, parentRunId, callerSessionId }
    const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId)
    const parentRun = await this.ctx.task.runIn(storeId, parentRunId)
    // (1) The presented batch becomes a normalized one — or the request is
    //     refused, field by field, before a proposal exists.
    const derived = await this.deriveBatch(identity, spec)
    if (!derived.ok) return await this.refusePrecheck(storeId, parentTaskId, actor, derived.refusal)
    const { batch } = derived

    // (2) §6's request key: the caller's own when it has one, otherwise derived
    //     from the calling context and the batch's own digest — stable across a
    //     restart, and different for a revision because a revision is different
    //     content. A request the store already answers is answered from the
    //     *record* here, before the run protocol is asked: the record is what a
    //     retry means (the same batch, still waiting or already admitted), and a
    //     retry must never build a second one.
    const requestKey = options.requestKey ?? proposalRequestKey({ ...identity, proposalDigest: batch.admission.proposalDigest })
    const stored = await this.proposalForRequest(storeId, requestKey, batch.admission.proposalDigest)
    if (stored !== undefined) {
      // The caller presented the batch again and the digest says it is the one
      // this request names: the stored proposal already carries the content, so
      // the answer is the record itself — and a proposal still waiting gets the
      // review asked again, because a caller asking again is evidence that
      // somebody is still waiting for it.
      const storedBatch = this.storedBatchOf(stored)
      const review = stored.status === 'pending_review'
        ? await this.requestProposalReview({
            storeId,
            trigger: 'submitted',
            proposal: stored,
            parentTask,
            batch: storedBatch,
            manifests: this.manifestsOf(storedBatch),
          })
        : undefined
      return {
        proposalId: stored.proposalId,
        status: stored.status,
        policy: stored.policy,
        existing: true,
        detail: this.submissionDetail(stored, true),
        ...(review === undefined ? {} : { review }),
      }
    }

    // (3) A genuinely new batch: only a run that may still decide its own work
    //     may propose one, and the batch has to clear every admission rule.
    this.assertDecomposableRun(parentTask, parentRun, callerSessionId, options.exec?.signal)
    const checked = await this.checkDerivedBatch({
      identity,
      parentTask,
      batch,
      ...(derived.envPath === undefined ? {} : { envPath: derived.envPath }),
    })
    if (!checked.ok) return await this.refusePrecheck(storeId, parentTaskId, actor, checked.refusal)
    const { manifests, providers } = checked

    const reviewContext = reviewContextOf({
      manifests,
      criteria: batch.children.flatMap(child => child.contract.acceptanceCriteria),
      providers: providerContentIdentities(providers.capabilities),
    })
    const policy = this.config.generatedTaskReview
    const proposalIdentity = decompositionIdentity(identity, batch.reason, batch.children)
    const proposal: TaskProposal = {
      proposalId: taskProposalId(proposalIdentity),
      requestKey,
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
      status: policy === 'all' ? 'pending_review' : 'ready',
      policy,
      identity: proposalIdentity,
      // The batch's content travels with the proposal, not only its digest: a
      // reviewer, a canvas and a resumed continuation all render what was asked
      // for from the store alone (§5–§6), which is what makes a restart stop
      // being a boundary for approvals.
      batch: batch.children,
      proposalDigest: batch.admission.proposalDigest,
      admissionContext: batch.admission.context,
      admissionContextDigest: admissionContextDigest(batch.admission.context),
      reviewContext,
      reviewContextDigest: reviewContextDigest(reviewContext),
      createdAt: now(),
    }
    try {
      await this.ctx.task.submitProposalIn(storeId, proposal, actor)
    } catch (error) {
      // A store that already holds *this* batch is a race, not a failure: the
      // request is answered from the record exactly as a retry is. A refusal
      // about anything else (a malformed record, a key bound to another batch)
      // is raised unchanged — this tolerance is narrow on purpose, and the
      // digest is what makes it safe.
      const raced = await this.readProposal(storeId, proposal.proposalId).catch(() => undefined)
      if (raced === undefined || raced.proposalDigest !== proposal.proposalDigest) throw error
      return {
        proposalId: raced.proposalId,
        status: raced.status,
        policy: raced.policy,
        existing: true,
        detail: this.submissionDetail(raced, true),
      }
    }
    if (proposal.status !== 'pending_review') {
      return {
        proposalId: proposal.proposalId,
        status: proposal.status,
        policy: proposal.policy,
        existing: false,
        detail: this.submissionDetail(proposal, false),
      }
    }
    const review = await this.requestProposalReview({ storeId, trigger: 'submitted', proposal, parentTask, batch, manifests })
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      policy: proposal.policy,
      existing: false,
      detail: this.submissionDetail(proposal, false),
      review,
    }
  }

  /**
   * One continuation, inside the subject's serialization (§6's "单进程串行"): the
   * state ladder first, then the re-check, then — only if the proposal still is
   * what was reviewed — admission (a batch) or activation (a root contract).
   *
   * The ladder answers without writing wherever the answer is already on the
   * record: a consumed proposal answers with its own consumption (so a duplicate
   * continuation cannot build a second batch or a second root), a waiting one
   * answers `pending_review`, and a terminal one answers with the status the
   * store holds. The re-check then resolves the four ways §6 describes — the
   * subject already has what this proposal wanted (`stale` for a decomposed
   * parent, `expired` for a store that holds another root), the parent run ended
   * or the store's root appeared (`expired`), the context moved (`stale`, with
   * the difference named), or the proposal still is what was reviewed
   * (`approved → ready` and admit/activate).
   */
  private async continueProposalIn(
    storeId: string,
    proposalId: string,
    caller: string,
    options: { spec?: DecomposeSpec; exec?: { callId?: string } },
  ): Promise<ProposalContinuation> {
    const proposal = await this.requireProposal(storeId, proposalId)
    const owner = this.proposalCallerOf(proposal)
    if (caller !== owner) {
      throw new Error(
        `task-runtime: proposal "${proposalId}" was submitted by session "${owner}"; session "${caller}" cannot continue it ` +
        '(a proposal belongs to the session that made it, and an approval is continued on that session\'s behalf)',
      )
    }
    switch (proposal.status) {
      case 'admitted': {
        const consumption = proposal.consumption
        if (consumption === undefined) {
          throw new Error(
            `task-runtime: proposal "${proposalId}" is admitted without a consumption record; the store is inconsistent and nothing is dispatched`,
          )
        }
        // What the proposal became is read off the consumption, by kind: a batch
        // names its children, a root contract names the task and run it became.
        // Both answers are the record's own — a duplicate continuation cannot
        // build a second one.
        if (consumption.kind === 'root') {
          return {
            proposalId,
            status: 'activated',
            taskId: consumption.rootTaskId,
            runId: consumption.rootRunId,
            detail:
              `proposal "${proposalId}" is activated as root task ${consumption.rootTaskId} with run ${consumption.rootRunId}; ` +
              'that root is not activated again',
          }
        }
        return {
          proposalId,
          status: 'admitted',
          batchId: consumption.batchId,
          childTaskIds: [...consumption.childTaskIds],
          detail: `proposal "${proposalId}" is admitted as batch ${consumption.batchId}; the runtime owns that batch and it is not admitted again`,
        }
      }
      case 'pending_review':
        return {
          proposalId,
          status: 'pending_review',
          detail: `proposal "${proposalId}" is waiting for a review; only a decision on the record advances it (§6)`,
        }
      case 'rejected':
      case 'cancelled':
      case 'stale':
      case 'expired':
        return {
          proposalId,
          status: proposal.status,
          detail: `proposal "${proposalId}" is ${proposal.status}; nothing was admitted and nothing is dispatched`,
          ...(proposal.decision?.reason === undefined ? {} : { reason: proposal.decision.reason }),
        }
      default:
        break
    }

    // A root contract's continuation is a different ladder from a batch's — one
    // store-level gate and two fingerprints, with no parent task and no parent
    // run to ask about — so it is answered by its own step.
    if (proposal.kind === 'root') {
      return await this.continueRootProposalIn(storeId, proposal)
    }

    const parentTaskId = proposal.identity.parentTaskId
    const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId)
    const parentRun = await this.ctx.task.runIn(storeId, proposal.identity.parentRunId)
    // (1) The parent's own state. A task that already decomposed lost this batch
    // the race — the winner's commit is durable, and §6 says the loser is
    // invalidated rather than queued behind it.
    if (parentTask.decompositionStatus === 'decomposed') {
      return await this.staleProposal(
        storeId,
        proposal,
        `the parent task "${parentTaskId}" already has a batch, so this proposal's batch cannot become it (a task decomposes once); ` +
        'the approval is not transferred to another batch',
      )
    }
    const ended = await this.parentRunEndedReason(storeId, proposal)
    if (ended !== undefined) {
      return await this.expireProposal(storeId, proposal, `the batch can no longer be dispatched: ${ended}`)
    }

    // (2) The policy gate (§5). A batch born under `off` that has not been
    // admitted is subject to the deployment's *current* policy: tightened to
    // `all`, it is sent for the review it never had. The other direction is not
    // a release — a waiting proposal is never freed by a policy change to `off`,
    // which is why this branch reads the stored policy as well as this one.
    //
    // The checkout is resolved once here, for the provider pre-check the review
    // request and the re-check both need.
    const envPath = await this.envPathForSession(owner)
    if (proposal.status === 'ready' && proposal.policy === 'off' && this.config.generatedTaskReview === 'all') {
      await this.ctx.task.changeProposalPhaseIn(storeId, {
        proposalId,
        to: 'pending_review',
        reason: 'the deployment tightened the review policy to "all" while this batch had not been admitted yet (§5: only tightening is allowed, and it reaches whatever has not run)',
      }, owner)
      const tightened = await this.requireProposal(storeId, proposalId)
      const tightenedBatch = this.storedBatchOf(tightened)
      let detail = 'it is now waiting for a review'
      const reviewed = await this.checkDerivedBatch({
        identity: {
          storeId,
          parentTaskId: proposal.identity.parentTaskId,
          parentRunId: proposal.identity.parentRunId,
          callerSessionId: proposal.identity.callerSessionId,
        },
        parentTask,
        batch: tightenedBatch,
        ...(envPath === undefined ? {} : { envPath }),
      })
      if (reviewed.ok) {
        const review = await this.requestProposalReview({
          storeId,
          trigger: 'tightened',
          proposal: tightened,
          parentTask,
          batch: tightenedBatch,
          manifests: reviewed.manifests,
        })
        detail += `; ${review.detail}`
      } else {
        detail += `, and its batch no longer passes admission (${reviewed.refusal.reasons.join('; ')})`
      }
      return { proposalId, status: 'pending_review', detail: `proposal "${proposalId}" was sent for review: ${detail}` }
    }

    // (3) The batch's content comes from the store (§6): a proposal carries what
    // was asked for, so a continuation never depends on what this process still
    // remembers, and an approval that survives a restart is continuable by
    // whoever reopens the store. A caller that re-presents a batch may only
    // *confirm* it — the re-presentation is derived and checked against the
    // stored identity, and any other batch is refused by name rather than
    // substituted for the one that was approved.
    const identity = {
      storeId,
      parentTaskId: proposal.identity.parentTaskId,
      parentRunId: proposal.identity.parentRunId,
      callerSessionId: proposal.identity.callerSessionId,
    }
    if (options.spec !== undefined) {
      const presented = await this.deriveBatch(identity, options.spec)
      if (!presented.ok) {
        throw new Error(
          `task-runtime: the batch presented for proposal "${proposalId}" is not a usable one: ${presented.refusal.reasons.join('; ')}`,
        )
      }
      if (presented.batch.admission.proposalDigest !== proposal.proposalDigest) {
        throw new Error(
          `task-runtime: the batch presented for proposal "${proposalId}" is a different one ` +
          `(digest ${presented.batch.admission.proposalDigest} ≠ the stored ${proposal.proposalDigest}); an approval never travels to other content, ` +
          'and nothing was admitted',
        )
      }
    }
    const batch = this.storedBatchOf(proposal)

    // (4) The re-check (§6): the stored batch is judged again exactly as it was
    // judged at submission — structure, capabilities, providers, verifierRefs —
    // and both context fingerprints are recomputed and compared, because an
    // approval covers the batch as it was, under the limits and the resolution it
    // was reviewed with, not as any of them might have become.
    //
    // Protected acceptance inputs are deliberately not re-read here: the stored
    // contract carries the identity that was fixed at submission (S1-V slice 2),
    // and a file whose bytes moved afterwards is caught where §4 puts it — the
    // verifier re-reads every declared input before judging and fails the
    // criterion naming the path, so a moved input is a judgement, never a silent
    // admission against bytes nobody checked.
    const checked = await this.checkDerivedBatch({
      identity,
      parentTask,
      batch,
      ...(envPath === undefined ? {} : { envPath }),
    })
    if (!checked.ok) {
      // A verifier service this deployment cannot read is not a changed batch:
      // it is a deployment that cannot judge the batch at all, so the approval is
      // left standing and the fault is raised by name.
      if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error
      return await this.staleProposal(
        storeId,
        proposal,
        `the batch no longer passes admission: ${checked.refusal.reasons.join('; ')}`,
      )
    }
    const { manifests, providers } = checked
    // The limits are recomputed from *this* process's configuration and compared
    // with the fingerprint the approval bound: the stored batch carries the
    // context it was reviewed under, and reading that back would compare a value
    // with itself (§6 asks the runtime to re-read and re-check, not to re-echo).
    const contextDigest = admissionContextDigest(this.admissionContext())
    if (contextDigest !== proposal.admissionContextDigest) {
      return await this.staleProposal(
        storeId,
        proposal,
        `the limits in force moved since the batch was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`,
      )
    }
    const reviewContext = reviewContextOf({
      manifests,
      criteria: batch.children.flatMap(child => child.contract.acceptanceCriteria),
      providers: providerContentIdentities(providers.capabilities),
    })
    const reviewDigest = reviewContextDigest(reviewContext)
    if (reviewDigest !== proposal.reviewContextDigest) {
      return await this.staleProposal(
        storeId,
        proposal,
        `the resolution this batch was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`,
      )
    }

    // (5) The re-check passed: record it (`approved → ready`) and admit. A
    // proposal that is already `ready` wrote that same fact earlier — the
    // reducer refuses a second `approved → ready`, and this branch simply does
    // not repeat it.
    if (proposal.status === 'approved') {
      await this.ctx.task.changeProposalPhaseIn(storeId, {
        proposalId,
        to: 'ready',
        reason: 'the post-approval re-check passed: the parent, the limits, the capability resolution, the judging verifiers and the batch content are the ones that were reviewed',
      }, proposal.identity.callerSessionId)
    }
    const admitted = await this.admitPrecheckedBatch({
      proposal,
      parentTask,
      parentRun,
      batch,
      manifests,
      providers,
      ...(options.exec === undefined ? {} : { exec: options.exec }),
    })
    return {
      proposalId,
      status: 'admitted',
      batchId: admitted.batchId,
      childTaskIds: admitted.childTaskIds,
      detail: `proposal "${proposalId}" is admitted as batch ${admitted.batchId} with ${admitted.childTaskIds.length} child task(s)`,
    }
  }

  /**
   * Invalidate one proposal whose context moved (§6), and remember that on the
   * record: `stale` is terminal, it needs its reason, and it is a statement
   * about the proposal rather than a deletion of it — the record and its approval
   * stay readable, and a revision is new content under a new key.
   */
  private async staleProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation> {
    await this.ctx.task.changeProposalPhaseIn(storeId, { proposalId: proposal.proposalId, to: 'stale', reason }, this.proposalCallerOf(proposal))
    return { proposalId: proposal.proposalId, status: 'stale', detail: `proposal "${proposal.proposalId}" is stale: ${reason}`, reason }
  }

  /**
   * Invalidate one proposal the subject can no longer dispatch (§6: a late
   * approval may only invalidate) — a batch whose parent run ended, a root
   * contract whose store already holds a root. The write is a *decision* —
   * `expired` is one of the four outcomes the store records with a decider and a
   * reason — and the decider is named `task-runtime`, because this invalidation
   * is the runtime's own reading of the store's state rather than a person's
   * decision.
   */
  private async expireProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation> {
    await this.ctx.task.decideProposalIn(storeId, {
      proposalId: proposal.proposalId,
      outcome: 'expired',
      proposalDigest: proposal.proposalDigest,
      admissionContextDigest: proposal.admissionContextDigest,
      decidedBy: 'task-runtime',
      decidedAt: now(),
      reason,
    }, 'task-runtime')
    return { proposalId: proposal.proposalId, status: 'expired', detail: `proposal "${proposal.proposalId}" is expired: ${reason}`, reason }
  }

  /**
   * Why the parent run can no longer host a batch, or `undefined` when it can.
   * Three states, each named by what it means rather than by the field:
   * the run is no longer running (cancelled, failed, verified), it predates the
   * coordination phases (an old record whose only legal continuation is
   * cancellation), or it has left the deciding phase by submitting its own
   * result. A parent that *is* decomposed is not answered here: §6 treats that
   * as a lost race (`stale`, a context that moved) rather than as a run that
   * ended.
   */
  private async parentRunEndedReason(storeId: string, proposal: TaskProposal): Promise<string | undefined> {
    // Only a decomposition batch has a parent run to ask about: a root contract's
    // dispatchability is the store's one-root gate, which `approvalLatenessReason`
    // and the continuation's own ladder answer.
    if (proposal.kind === 'root') return undefined
    const run = await this.ctx.task.runIn(storeId, proposal.identity.parentRunId)
    if (run.status !== 'running') return `the parent run "${run.runId}" is ${run.status}`
    if (run.executionPhase === undefined) return `the parent run "${run.runId}" predates coordination phases`
    if (run.executionPhase !== 'active') return `the parent run "${run.runId}" is in phase "${run.executionPhase}"`
    return undefined
  }

  /** The proposal a request key already names, or `undefined` when the key is free; a key bound to other content is a refusal by name (§6). */
  private async proposalForRequest(storeId: string, requestKey: string, proposalDigest: string): Promise<TaskProposal | undefined> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const stored = snapshot.proposals?.byRequestKey[requestKey]
    if (stored === undefined) return undefined
    if (stored.kind === 'root') {
      // A batch request cannot be answered by a root contract, even under the same
      // key: the two address different subjects, and treating one as the other
      // would answer with a goal nobody asked of this parent. The key is the
      // caller's, so this is a refusal by name rather than a silent re-mint.
      throw new Error(
        `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a root contract; ` +
        'a request key names one proposal, and a batch cannot take over a root intake\'s key',
      )
    }
    if (stored.proposalDigest !== proposalDigest) {
      throw new Error(
        `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose batch is a different one ` +
        `(digest ${stored.proposalDigest} ≠ ${proposalDigest}); a revision is new content under a new key (§6)`,
      )
    }
    return stored
  }

  /** The proposal one id names, or a refusal naming the id — the read every public entry starts from. */
  private async requireProposal(storeId: string, proposalId: string): Promise<TaskProposal> {
    const proposal = await this.readProposal(storeId, proposalId)
    if (proposal === undefined) {
      throw new Error(`task-runtime: store "${storeId}" holds no proposal "${proposalId}"`)
    }
    return proposal
  }

  /**
   * The proposal one id names, or `undefined`. The index is optional at the type
   * level (snapshots built by hand predate proposals), and an index this reader
   * cannot see is answered as "not this store's proposal" rather than guessed
   * at.
   */
  private async readProposal(storeId: string, proposalId: string): Promise<TaskProposal | undefined> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    return snapshot.proposals?.byId[proposalId]
  }

  /**
   * One submission's answer, in one sentence: the policy it was born under, the
   * status it holds, and what the caller owes next. A re-answer says so, because
   * "the proposal you sent before is still the one this request means" is a
   * different fact from "a new proposal was written".
   */
  private submissionDetail(proposal: TaskProposal, existing: boolean): string {
    const head = existing
      ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})`
      : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`
    switch (proposal.status) {
      case 'ready':
        return `${head}; continue it to admit the batch (policy off admits without a review, and the record says policy-off)`
      case 'pending_review':
        return `${head}; it needs a recorded decision before its batch can run, and its batch is not admitted, not spawned and its parent is not decomposed`
      case 'approved':
        return `${head}; the approval is on record and the batch has not been admitted yet — continue it to run the post-approval re-check`
      case 'admitted':
        return `${head}; its batch is admitted already and will not be admitted again`
      default:
        return `${head}; a ${proposal.status} proposal is not dispatched, and a revision is new content under a new key`
    }
  }

  /**
   * Ask the deployment's review channel about one waiting proposal (§5–§6).
   * A channel is optional and its answer is only ever a notice: absent, it
   * answers "nobody was asked" and the proposal stays `pending_review`; present,
   * it may ask a person and report what it did; a channel that throws is warned
   * about and reported, never swallowed — and none of those outcomes can turn
   * into an approval, because the only thing that advances a waiting proposal is
   * a persisted decision.
   *
   * What the request carries is the subject as the store holds it: for a batch the
   * parent task, the children and the obligations raised on that parent; for a
   * root contract the contract itself and no parent — the task it would become
   * does not exist while it waits, so there is nothing to read obligations off
   * and nothing to pretend. Every arm is built here from stored facts, so a
   * review requested after a restart shows what the record holds.
   */
  private async requestProposalReview(request: ReviewSubject): Promise<{ requested: boolean; detail: string }> {
    const channel = this.softService<ProposalReviewChannel>('proposalReviewChannel')
    if (channel === undefined || typeof channel.requestReview !== 'function') {
      return {
        requested: false,
        detail:
          'no review channel is mounted (ctx.proposalReviewChannel), so nobody was asked; the proposal stays pending_review and only a ' +
          'recorded decision moves it',
      }
    }
    const registeredVerifiers = await this.registeredVerifierIds()
    const obligations = request.kind === 'root'
      // A root contract has no task yet, so no obligation can have been raised on
      // it; an empty list says "nothing is on record", which is what a reviewer
      // needs to know rather than a list borrowed from another subject.
      ? []
      : await this.ctx.task
        .snapshotIn(request.storeId)
        .then(snapshot => snapshot.obligations.filter(obligation => obligation.sourceTaskId === request.parentTask.taskId))
        .catch(() => [])
    try {
      const subject: ProposalReviewRequest = request.kind === 'root'
        ? {
            kind: 'root',
            storeId: request.storeId,
            trigger: request.trigger,
            proposal: request.proposal,
            rootSessionId: request.rootSessionId,
            contract: structuredClone(request.contract),
            manifests: request.manifests,
            ...(registeredVerifiers === undefined ? {} : { registeredVerifiers }),
            obligations,
          }
        : {
            storeId: request.storeId,
            trigger: request.trigger,
            proposal: request.proposal,
            parentTask: request.parentTask,
            batch: request.batch,
            manifests: request.manifests,
            ...(registeredVerifiers === undefined ? {} : { registeredVerifiers }),
            obligations,
          }
      const notice = await channel.requestReview(subject)
      return {
        requested: notice.requested,
        detail: notice.detail ?? (notice.requested ? 'the review was requested' : 'the review channel did not request a review'),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.warn(`proposal ${request.proposal.proposalId}: the review channel failed (${detail}); the proposal stays pending_review`)
      return { requested: false, detail: `the review channel failed: ${detail}` }
    }
  }

  /**
   * Raise the obligations a capability-gap refusal owes, then raise the refusal
   * itself: one obligation per missing capability, on the parent, with the
   * wording the admission chain has always used (KISS §7 — a gap is a normal
   * state with a record, not a silence). The pre-check wrote nothing, so this is
   * the only place the *fact* of the gap is recorded, and it happens before the
   * batch is refused — never twice, because a refused batch has no proposal to
   * re-refuse.
   */
  private async refusePrecheck(storeId: string, parentTaskId: TaskId, actor: string, refusal: DecompositionRefusal): Promise<never> {
    for (const gap of refusal.gaps) {
      for (const missing of gap.missing) {
        await this.ctx.task.recordObligationIn(storeId, {
          obligationId: `o-${randomUUID()}`,
          goal: `capability "${missing}" required by child ${gap.childIndex} ("${gap.objective}") of "${parentTaskId}" is not granted by the registry`,
          criterion: `capability "${missing}" resolves in the capability registry (capability_list shows it)`,
          sourceTaskId: parentTaskId,
        }, actor)
      }
    }
    throw refusal.error
  }
  /**
   * One parent's proposal operations, one at a time (§6: "单进程同一父分解的
   * 重检、提案消费及子任务绑定应串行"). What this buys: two approved proposals
   * competing for the same parent can only ever admit one batch — the loser's
   * continuation reads the parent's state *after* the winner's commit, sees it
   * decomposed, and is marked stale by name. The chain is this process's own, per
   * store and parent; a second process is covered by the store's own refusals
   * (a decomposed parent, a duplicate proposal id, a consumed proposal), never
   * by this map.
   */
  private async serializeParent<T>(storeId: string, parentTaskId: TaskId, work: () => Promise<T>): Promise<T> {
    const key = `${storeId}/${parentTaskId}`
    const previous = this.parentChains.get(key) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(() => undefined, () => undefined)
    this.parentChains.set(key, settled)
    void settled.then(() => {
      if (this.parentChains.get(key) === settled) this.parentChains.delete(key)
    })
    return await run
  }

  /**
   * The proposal pass of recovery (T3 §5), run at the end of
   * {@link reconcileStore} — after the runs, so a batch this pass admits is
   * either picked up by the run pass or driven by the driver this pass starts,
   * and after the workspace adoption, so an admission is not attempted into a
   * checkout somebody else holds.
   *
   * Per proposal, and in one sentence each: a proposal waiting for a review is
   * *never* advanced by recovery — only a persisted decision moves it (§6) —
   * and its review is requested again when this process can show the batch; a
   * proposal that is `ready` or `approved` is continued (which is where §5's
   * tightening reaches a batch that was born under `off` and the post-approval
   * re-check decides whether the approval still covers the batch); everything
   * terminal is left alone, including `admitted`, whose batch the run pass has
   * already dealt with.
   *
   * Anything this pass could not finish is returned and warned about — never
   * guessed at. An approval that survives a restart is continued from the store
   * alone, because a proposal carries the batch it is about; a review request is
   * re-sent with the same saved facts (the parent, the children's contracts, the
   * resolution), so what a person is asked to review after a crash is what the
   * record holds rather than whatever a live process happened to remember.
   */
  private async reconcileProposals(storeId: string): Promise<ReconcileReport['unresolvedProposals']> {
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: the proposals could not be read for recovery (${error instanceof Error ? error.message : String(error)})`)
      return []
    }
    const unresolved: { proposalId: string; status: TaskProposalStatus; reason: string }[] = []
    const report = async (proposal: TaskProposal, status: TaskProposalStatus, reason: string): Promise<void> => {
      this.warn(`store ${storeId}: proposal ${proposal.proposalId}: ${reason}`)
      unresolved.push({ proposalId: proposal.proposalId, status, reason })
    }
    for (const proposal of snapshot.proposals?.all ?? []) {
      if (!isOpenProposal(proposal)) continue
      const proposalId = proposal.proposalId
      try {
        if (proposal.kind === 'root') {
          await this.reconcileRootProposal(storeId, proposal, report)
          continue
        }
        if (proposal.status === 'pending_review') {
          const ended = await this.parentRunEndedReason(storeId, proposal)
          if (ended !== undefined) {
            await report(proposal, proposal.status, `it waits for a review it can no longer be dispatched from (${ended}); only a recorded decision moves it (§6)`)
            continue
          }
          const parentTask = await this.ctx.task.taskIn(storeId, proposal.identity.parentTaskId)
          const identity = {
            storeId,
            parentTaskId: proposal.identity.parentTaskId,
            parentRunId: proposal.identity.parentRunId,
            callerSessionId: proposal.identity.callerSessionId,
          }
          const batch = this.storedBatchOf(proposal)
          const envPath = await this.envPathForSession(proposal.identity.callerSessionId)
          const checked = await this.checkDerivedBatch({
            identity,
            parentTask,
            batch,
            ...(envPath === undefined ? {} : { envPath }),
          })
          if (!checked.ok) {
            await report(
              proposal,
              proposal.status,
              `it waits for a review and its batch no longer passes admission (${checked.refusal.reasons.join('; ')}); the proposal stays pending_review`,
            )
            continue
          }
          await this.requestProposalReview({
            storeId,
            trigger: 'recovered',
            proposal,
            parentTask,
            batch,
            manifests: checked.manifests,
          })
          continue
        }
        const continuation = await this.serializeParent(storeId, proposal.identity.parentTaskId, () =>
          this.continueProposalIn(storeId, proposalId, proposal.identity.callerSessionId, {}))
        if (continuation.status !== 'admitted' && continuation.status !== 'activated') {
          await report(proposal, continuation.status, continuation.detail)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.warn(`store ${storeId}: proposal ${proposalId} could not be continued during recovery (${reason}); it stays ${proposal.status}`)
        unresolved.push({ proposalId, status: proposal.status, reason })
      }
    }
    return unresolved
  }

  /**
   * One root contract's turn in the proposal pass (A0 §5): the same discipline as
   * a batch's, with the subjects a root contract has instead of a parent task.
   *
   * A `pending_review` root contract is never advanced by recovery — only a
   * persisted decision moves it — and its review is requested again from the
   * stored contract when this process can still show it; a contract whose
   * resolution no longer passes admission is reported and left waiting, exactly
   * as a batch is. A `ready`/`approved` one is continued, which is where §5's
   * tightening reaches a contract born under `off` and where the post-approval
   * re-check decides whether an approval still covers it.
   *
   * The crash points this covers, both of them one call away from a root that
   * exists:
   *
   * - **the decision is on the record and the activation never ran** — the
   *   continuation re-checks and activates, and the store's own reducer is what
   *   keeps it to one root;
   * - **the activation commit landed and this process died before it bound the
   *   session** — the status ladder answers `activated` from the consumption
   *   itself, so recovery re-binds rather than minting a second task and run
   *   ({@link adoptRoot} is that re-binding's other door, for a process that
   *   starts from a graph entry instead).
   *
   * Ahead of both arms is the origin rule (§1.10,
   * {@link assertRootContractOrigin}): a record whose request cannot be
   * established is not something to ask a person about — a decision on it could
   * never activate anything, because the ladder refuses the same fact at
   * activation — and it is not something to continue either. The refusal travels
   * out of this call so the proposal pass reports it unresolved by name.
   *
   * **The boundary this check does not cross.** {@link decideProposal} is left
   * exactly as it was: a person's decision on a record that exists is a
   * record-level fact, and it is written whether or not the contract could ever
   * activate — the activation it would cause is the thing that is refused, here
   * and at every other door into a root. Recovery's pass is not a decision, so it
   * is the one place where "do not ask" can be honoured.
   */
  private async reconcileRootProposal(
    storeId: string,
    proposal: TaskProposalRoot,
    report: (proposal: TaskProposal, status: TaskProposalStatus, reason: string) => Promise<void>,
  ): Promise<void> {
    const proposalId = proposal.proposalId
    await this.assertRootContractOrigin(storeId, proposal.identity.rootSessionId)
    if (proposal.status === 'pending_review') {
      const existing = await this.existingRootTask(storeId)
      if (existing !== undefined) {
        // Somebody else became this store's root while the contract waited. It can
        // no longer become one, so the proposal is expired with the reason named
        // — a decision or an activation would both be operations on a root that
        // is already spoken for.
        const expired = await this.expireProposal(
          storeId,
          proposal,
          `store "${storeId}" already holds root task "${existing.taskId}", so this contract can no longer become its root`,
        )
        await report(proposal, 'expired', expired.detail)
        return
      }
      const rootSessionId = proposal.identity.rootSessionId
      const contract = structuredClone(proposal.contract)
      const envPath = await this.envPathForSession(rootSessionId)
      const checked = await this.checkRootContract({ rootSessionId, contract, ...(envPath === undefined ? {} : { envPath }) })
      if (!checked.ok) {
        await report(
          proposal,
          proposal.status,
          `it waits for a review and its contract no longer passes admission (${checked.refusal.reasons.join('; ')}); the proposal stays pending_review`,
        )
        return
      }
      await this.requestProposalReview({
        kind: 'root',
        storeId,
        trigger: 'recovered',
        proposal,
        rootSessionId,
        contract,
        manifests: checked.manifests,
      })
      return
    }
    // `ready` or `approved`: the tightening rule and the post-approval re-check
    // both live in the continuation, which is also what re-binds an activation
    // whose process died after the commit.
    const continuation = await this.serializeRootIntake(storeId, () =>
      this.continueProposalIn(storeId, proposalId, proposal.identity.rootSessionId, {}))
    if (continuation.status === 'activated') {
      // The root is live; this process binds it (and derives the phase rather than
      // assuming one).
      await this.rebindActivatedRoot(storeId, proposal.identity.rootSessionId, continuation.taskId, continuation.runId)
      return
    }
    await report(proposal, continuation.status, continuation.detail)
  }

  /**
   * Bind a root this process just learned is activated — the crash case where the
   * commit is durable and the session of the process that wrote it is gone. The
   * store is the source of truth for the ids *and* for the phase: a root run that
   * already reached a terminal state leaves the session `terminal` rather than
   * open, so a late intake is refused by the gate as well as by the one-root rule
   * (§1.8), and only a still-running root is bound `active`.
   */
  private async rebindActivatedRoot(storeId: string, rootSessionId: string, taskId: TaskId, runId: RunId): Promise<void> {
    this.sessions.set(rootSessionId, { storeId, taskId, runId })
    this.startedSessions.add(rootSessionId)
    let phase: ExecutionPhase | 'terminal' | undefined
    try {
      phase = this.runGatePhase(await this.ctx.task.runIn(storeId, runId))
    } catch {
      // A run this process cannot read is not a phase to guess at: the session is
      // bound for lookups, and the gate stays as the store's own recovery left it.
      phase = undefined
    }
    if (phase === 'terminal') this.executionGate.setTerminal(rootSessionId)
    else if (phase !== undefined) this.executionGate.setPhase(rootSessionId, phase)
    this.notify(
      rootSessionId,
      `recovery bound this session to its activated root contract: task ${taskId}, run ${runId}` +
      `${phase === 'terminal' ? ' (that run is terminal, so this session is closed to new work)' : ''}. ` +
      'A late intake for a different contract is refused because the store already holds this root.',
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
    await this.assertRecoveryReady(storeId, 'a replay')
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
    await this.assertKnownVerifierRefs(
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
    // A replayed worker reads its context the way every task worker does (A2):
    // the replay task is parentless by design, so the store records no handoff
    // for it, and its contract projection carries the lineage label instead —
    // the spawn request itself carries no prompt and no contract text.
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
   * Abort and remove the drivers a barrier registered but never released to
   * start (A2 §E). Not-started is not executed: no body runs, nothing is
   * written on the batch's behalf, and the persistent record — which still
   * says the parent waits on its children — is what the next explicit
   * activation re-registers from.
   */
  private standDownPendingDrivers(state: StoreRecoveryState): void {
    for (const pending of state.pendingDrivers.splice(0)) {
      const entry = this.drivers.get(pending.key)
      if (entry?.controller === pending.controller) this.drivers.delete(pending.key)
      pending.controller.abort()
    }
  }

  /**
   * A cancellation or the unload invalidates a store's recovery handle (A2
   * §E): a barrier still in flight finishes its own pass but leaves no ready
   * handle and stands its not-yet-started drivers down; a settled handle is
   * dropped. The store's persistent record is untouched — the next explicit
   * activation (`adoptRoot`, through `graphs`' activate) is the retry.
   */
  private invalidateStoreRecovery(storeId: string): void {
    const state = this.storeRecovery.get(storeId)
    if (state === undefined) return
    if (state.status === 'recovering') {
      state.cancelled = true
      this.standDownPendingDrivers(state)
      state.release(false)
    } else {
      this.storeRecovery.delete(storeId)
    }
  }

  /**
   * Fail one batch's parent run without an `OrchestrateEnv`: the children that
   * never started are blocked, the parent run is failed with the cause, and the
   * owner is told. Store-level on purpose — the caller is here because the env
   * could not be built, so this path holds the settlement's own narrow
   * capabilities ({@link TaskRuntime.settlementParts}) instead of building one —
   * and it never throws, so a driver's failure cannot become an unhandled
   * rejection of its own. `outcome` is `'cancelled'` only for a batch whose
   * driver never started (a recovery barrier stood it down when the cancellation
   * aborted it): the same writes a started driver's abort branch makes, from the
   * one place that can still make them.
   *
   * The two writes are the orchestration's own (A4-5): `blockUnstartedChildren`
   * and `settleRunFromRuntime`, the same pair every other batch failure uses —
   * there is no second terminal-record writer here.
   */
  private async failBatchFromRuntime(storeId: string, key: string, reason: string, outcome: 'failed' | 'cancelled' = 'failed'): Promise<void> {
    const prefix = `${storeId}/b-`
    if (!key.startsWith(prefix)) return
    const parentTaskId = key.slice(prefix.length) as TaskId
    const parts = this.settlementParts(`fail-batch:${storeId}`)
    try {
      await blockUnstartedChildren(parts, storeId, parentTaskId, reason)
      const snapshot = await this.ctx.task.snapshotIn(storeId)
      const parentRun = [...snapshot.runs].reverse().find(run => run.taskId === parentTaskId && run.status === 'running')
      if (parentRun === undefined) return
      await settleRunFromRuntime(parts, storeId, parentRun, outcome, `batch ${key.slice(prefix.length - 2)} ${outcome}: ${reason}`)
    } catch (error) {
      this.warn(`store ${storeId}: the failed driver ${key} could not be settled (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /**
   * The narrow capabilities one runtime-level settlement holds — the store, the
   * actor, the notification seam and the gate/workspace bookkeeping — for the one
   * path that writes a terminal state without an orchestration env
   * ({@link failBatchFromRuntime}): the caller is there precisely because this
   * deployment's own view could not be built, so this holds the services that
   * cannot fail for that reason and nothing else. The checkout registry is
   * deliberately not among them: resolving a workspace path here would guess at
   * the very environment whose construction failed, and a marker left for the
   * explicit activation to reconcile is honest where a guessed release is not.
   * Every other batch failure goes through the driver's own env, which carries
   * the registry and releases the layer.
   */
  private settlementParts(actor: string): RuntimeSettlementEnv {
    return {
      task: this.ctx.task,
      actor,
      notify: (sessionId, text) => {
        this.notify(sessionId, text)
      },
      observeSession: async sessionId => this.observeSession(sessionId),
      budget: { ...this.config.budget },
      onRunSettled: (storeId, taskId, runId, status) => {
        this.runSettledFromRuntime(storeId, taskId, runId, status)
      },
    }
  }

  /**
   * What the runtime does when *any* run reaches a terminal state (A3 §3.3): the
   * gate closes for the session that held it, and the workspace layer the run
   * claimed comes off the stack. One implementation for the orchestration's
   * settlements and the runtime's own, so a run settled from either side leaves
   * the process in the same state.
   */
  private runSettledFromRuntime(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void {
    void taskId
    void status
    const sessionId = this.sessionBoundInProcess(storeId, runId)
    if (sessionId === undefined) return
    this.executionGate.setTerminal(sessionId)
    void this.releaseRunWorkspaceLayer(storeId, runId, sessionId).catch(error => {
      this.warn(`run ${runId}: the workspace layer it held could not be released (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  /**
   * Start the driver for one admitted batch. The controller is registered
   * before the driver runs, so a cancellation arriving immediately after
   * admission finds something to abort.
   *
   * When the registration happens *inside* a recovery barrier (A2 §E) the
   * driver is parked after registering: the barrier waits for the
   * registration — reconciliation, gates and drivers are what an activation
   * owes — never for the body, so a `waiting_children` parent recovered inside
   * a graph activation cannot lock that activation on its own batch. The
   * barrier's completion releases the body; its failure or a cancellation
   * stands it down unstarted, and an abort that lands while it is parked
   * resolves it without a spawn.
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
    const barrier = this.storeRecovery.get(options.storeId)
    const gate = barrier !== undefined && barrier.status === 'recovering' ? barrier : undefined
    const promise = (async (): Promise<ChildOutcome[]> => {
      if (gate !== undefined) {
        gate.pendingDrivers.push({ key, controller })
        const start = await Promise.race([
          gate.released,
          new Promise<false>(resolve => {
            controller.signal.addEventListener('abort', () => resolve(false), { once: true })
          }),
        ])
        if (!start || controller.signal.aborted) return []
      }
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
    // The recovery door comes before the run's own verdicts (A2 §E): a store
    // this process has not recovered is refused by name even when the run
    // underneath would have answered, because the first side effect is what
    // the door guards.
    await this.assertRecoveryReady(storeId, 'a result submission')
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
   * Ask one's direct parent (A4 §F.1, `task_ask_parent`): the runtime entry the
   * tool layer adapts.
   *
   * The identity is the caller's own — a live session, its run binding, and the
   * parent the store derives from that run's task — and the body is read back
   * from the caller's own Session before the store records anything, so a forged
   * call id, another session's citation or a claim the message does not support
   * is refused by name with no task event and no delivery. Everything after the
   * commit (the write-gate block, the message under the *recorded* id) is owned
   * by `./question.ts`; `unavailable` there is not a failure — the intent is
   * durable, the record is returned, and recovery re-delivers.
   */
  async askParentQuestion(callerSessionId: string, request: ParentAskCall): Promise<AskedQuestionOutcome> {
    const caller = await this.questionCaller(callerSessionId, 'task_ask_parent')
    return await askParentQuestion(this.questionCoordination(), caller, request)
  }

  /**
   * Answer one child's still-open question (A4 §F.1, `task_answer`): the same
   * shape as {@link askParentQuestion}, with the answering run taken from the
   * caller's binding and the delivery addressed to the run that asked. A
   * resolving answer recomputes the *asking* run's block from the store, so a
   * second open question keeps it blocked.
   */
  async answerParentQuestion(callerSessionId: string, request: ParentAnswerCall): Promise<AnsweredQuestionOutcome> {
    const caller = await this.questionCaller(callerSessionId, 'task_answer')
    const answered = await answerParentQuestion(this.questionCoordination(), caller, request)
    // A coordination item closing can be the event that releases a waiting
    // parent's own automatic submission (see {@link redriveWaitingParent}): both
    // runs whose pending lists changed are re-driven, and nothing is settled here.
    const snapshot = await this.ctx.task.snapshotIn(caller.storeId)
    const question = questionOf(snapshot, answered.answer.questionId)
    if (question !== undefined) await this.redriveWaitingParent(caller.storeId, question.childRunId)
    await this.redriveWaitingParent(caller.storeId, caller.runId)
    return answered
  }

  /**
   * The identity every question call starts from: the live caller session, its
   * run binding, and the store that binding names. A session with no run (a root
   * before activation, a reviewer, a helper) has nobody to ask and nothing to
   * answer, and is refused here before any other step.
   */
  private async questionCaller(callerSessionId: string, entry: string): Promise<QuestionCaller> {
    if (this.agentOrUndefined(callerSessionId) === undefined) {
      throw new Error(
        `task-runtime: ${entry} needs a live caller session; "${callerSessionId}" has no live agent in this process, ` +
        'and the question identity comes from the live caller\'s own run',
      )
    }
    let binding: { storeId: string; task: TaskInstance; run: TaskRun }
    try {
      binding = await this.runForSession(callerSessionId)
    } catch (error) {
      throw new Error(`task-runtime: ${entry} refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    await this.assertRecoveryReady(binding.storeId, entry)
    return { sessionId: callerSessionId, storeId: binding.storeId, runId: binding.run.runId, actor: callerSessionId }
  }

  /** The services question coordination reaches: the store's entries, the session read path, agent-runtime's handle, and the gate. */
  private questionCoordination(): QuestionCoordinationDeps {
    return {
      task: this.ctx.task,
      sessionQuery: this.ctx.sessionQuery,
      messages: this.ctx.agentRuntime,
      gate: this.executionGate,
    }
  }

  /**
   * Re-drive a waiting parent whose last coordination item just closed (A4 §F.1).
   *
   * The parent's own submission has exactly one owner — the batch driver's
   * `settleParentBatch` — and that owner holds it back while a coordination item
   * is open. When the last one closes, the driver that owns the submission is
   * re-entered (the same entry the recovery pass uses), so the answer that
   * released the parent is what lets it submit instead of leaving a settled batch
   * with a parent nobody owns. This writes nothing itself: the driver re-reads
   * the store and the gate it applies is the same one.
   */
  private async redriveWaitingParent(storeId: string, runId: RunId): Promise<void> {
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const run = snapshot.runs.find(candidate => candidate.runId === runId)
    if (run === undefined || run.status !== 'running' || run.executionPhase !== 'waiting_children' || run.batchId === undefined) return
    if (pendingCoordinationOf(snapshot, runId).length > 0) return
    if (this.drivers.has(`${storeId}/${run.batchId}`)) return
    const task = snapshot.tasks.find(candidate => candidate.taskId === run.taskId)
    const children = task?.childTaskIds ?? []
    const childrenSettled = children.length > 0 && children.every(taskId => {
      const status = snapshot.tasks.find(candidate => candidate.taskId === taskId)?.status
      return status === 'verified' || status === 'failed' || status === 'blocked' || status === 'cancelled'
    })
    if (!childrenSettled) return
    this.startBatchDriver({
      storeId,
      parentTaskId: run.taskId,
      parentRunId: run.runId,
      batchId: run.batchId,
      callerSessionId: run.sessionId,
      reason: `coordination item settled for batch ${run.batchId}`,
    })
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
    const outcomes = await entry.promise
    // A driver that never started (a recovery barrier stood it down when this
    // cancellation aborted it) settles nothing itself: the parent run and the
    // children that never started are cancelled here, idempotently — a started
    // driver's own abort branch has already settled the parent by now, and the
    // store's terminal record is what makes this a no-op for it.
    const parentNow = await this.ctx.task.runIn(storeId, parentRun.runId).catch(() => undefined)
    if (parentNow !== undefined && parentNow.status === 'running') {
      await this.failBatchFromRuntime(storeId, `${storeId}/${batchId}`, `the batch was cancelled by its caller before its driver started: ${batchId}`, 'cancelled')
    }
    return outcomes
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
    // The barrier below is in effect before it is durable, so the store is marked
    // as being closed *before* the gate loop: from here until this method returns,
    // a rebinding that resolves a session of this store may not use the record —
    // which still says `running` because the settlement has not been persisted yet
    // — to lift a phase this cancellation already closed. The `finally` removes the
    // entry, so the barrier never outlives the operation and the store is the truth
    // for these sessions again afterwards.
    this.closingStores.add(storeId)
    // A cancellation invalidates the recovery handle (A2 §E): drivers a still
    // running barrier registered but not started stand down here — not-started
    // is not executed — and that barrier completes its pass into a store whose
    // runs this cancellation is already settling, leaving no ready handle
    // behind. The next explicit activation is the retry.
    this.invalidateStoreRecovery(storeId)
    try {
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
    } finally {
      this.closingStores.delete(storeId)
    }
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
   *
   * The run pass is followed by the proposal pass (T2/T3 §5–§6,
   * {@link reconcileProposals}): a proposal that is `ready` or `approved` is
   * continued — the re-check decides whether its approval still covers the batch,
   * and §5's tightening catches a batch that was born under `off` — while a
   * proposal waiting for a review is only re-offered to the review channel, never
   * advanced, because only a persisted decision moves it. The order is the
   * point: the run pass settles and restarts what a previous process left in
   * flight, the workspace question ("is this checkout ours?") is answered before
   * anything is admitted into it, and a batch the proposal pass admits is driven
   * by the driver *it* starts — there is nothing left for the run pass to see.
   * The report says what could not be finished and why, so a caller (the boot
   * path, an adoption) can see the proposals recovery left for a person instead
   * of reading a silent void.
   */
  async reconcileStore(storeId: string): Promise<ReconcileReport> {
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.snapshotIn(storeId)
    } catch (error) {
      this.warn(`store ${storeId}: recovery could not read the store (${error instanceof Error ? error.message : String(error)}), so nothing was reconciled`)
      return { unresolvedProposals: [], questionDeliveries: [] }
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
      //
      // The store's own root run is the exception (A2 §E): adoption binds the
      // root session *before* this pass, so "this process started the session"
      // is true of every root an activation just recovered, and the phases that
      // still need recovery — a `waiting_children` parent whose batch nobody
      // drives, a `submitted` acceptance nobody is settling — must not be
      // swallowed by that binding. What keeps a root's live work live is the
      // phase checks below (an `active` root is left alone by its own rule) and
      // the drivers map, which is what "is the batch being driven" answers.
      if (rootTaskStoreId(run.sessionId) !== storeId && this.startedSessions.has(run.sessionId)) continue
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
      // The known question wait (A4 §F.1): a run whose unresolved blocking
      // question is on the record is not an abandoned in-flight run, it is one
      // parked exactly where the protocol told it to park — and the question is
      // the durable fact that says so. Cancelling it would cancel the answer its
      // parent still owes it, so the run keeps its identity (same session, same
      // run) and the gate keeps the block (initializeStoreGates rebuilds it from
      // this same snapshot). Everything else about an unsubmitted run is
      // unchanged: a run without such a question is settled cancelled by name.
      const pendingQuestions = blockingQuestionsOf(snapshot, run.runId)
      if (pendingQuestions.length > 0) {
        this.warn(
          `store ${storeId}: run "${run.runId}" (session "${run.sessionId}") was in flight when this store was reopened and is waiting on ` +
          `${pendingQuestions.length === 1 ? 'an unresolved blocking question' : `${pendingQuestions.length} unresolved blocking questions`} ` +
          `(${pendingQuestions.map(question => question.questionId).join(', ')}); the run is left running with its block and no question is cancelled`,
        )
        continue
      }
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

    if (waiting.length > 0) {
      // Before a single child is started again, the checkout must be this
      // process's to write into (§3.4): a marker a live process holds refuses the
      // restart, and the parents fail naming that holder rather than racing it.
      const sessionId = this.recoverySessionFor(snapshot, storeId)
      const workspace = await this.workspacePathForSession(sessionId)
      let adoptable = true
      if (workspace !== undefined && this.workspaces !== undefined) {
        const adoption = await this.workspaces.ownerOf(workspace) === undefined
          ? await this.workspaces.reconcileAdopt(workspace)
          : { adopted: true as const }
        if (!adoption.adopted) {
          for (const run of waiting) {
            await settleRunFromRuntime(env, storeId, run, 'failed', `the workspace cannot be taken over for recovery: ${adoption.reason}`)
          }
          adoptable = false
        } else {
          await this.rebuildWorkspaceOwnership(storeId)
        }
      }
      if (adoptable) {
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
    }
    // The question deliveries this store still owes (A4 §F.1). This is the pass
    // a restart runs, and it runs it *after* the sessions the barrier brought
    // back are live — the root's among them — so a question addressed to a
    // session this process just resumed is delivered here rather than left for a
    // retry nobody would make. Targets that are still not live come back
    // `unavailable`: zero side effects, no substitute parent, and the same retry
    // on the next activation. Nothing here can fail the pass: a store whose
    // deliveries cannot be decided is still a store whose facts were reconciled.
    let questionDeliveries: QuestionReconcileReport[] = []
    try {
      questionDeliveries = await reconcileQuestionDeliveries(this.questionCoordination(), storeId)
    } catch (error) {
      this.warn(
        `store ${storeId}: its pending question deliveries could not be reconciled ` +
        `(${error instanceof Error ? error.message : String(error)}); the Task records still hold the intents, and the next activation retries`,
      )
    }
    // The proposal pass comes last (T2/T3 §5–§6): a batch it admits is driven by
    // the driver it starts, and the workspace question is already settled above,
    // so a continuation is not attempted into a checkout this process does not
    // hold.
    return { unresolvedProposals: await this.reconcileProposals(storeId), questionDeliveries }
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
  /**
   * The fallback batch-failure seam the orchestration calls when a run's own
   * settlement cannot finish the batch (verification unavailable in a nested
   * submission): every child that never started is blocked, the parent run is
   * failed with the reason, and the batch's driver is aborted so its own loop
   * stops seeing work that no longer exists.
   *
   * Both writes are the orchestration's own (A4-5): {@link blockUnstartedChildren}
   * and {@link settleRunFromRuntime} — the same pair `failBatchFromRuntime` uses —
   * so this file holds no second copy of either record shape.
   */
  private async failBatch(storeId: string, batchId: string, reason: string): Promise<void> {
    const parentTaskId = batchId.startsWith('b-') ? batchId.slice(2) : undefined
    if (parentTaskId === undefined) return
    const entry = this.drivers.get(`${storeId}/${batchId}`)
    entry?.controller.abort()
    const env = await this.orchestrateEnv(await this.sessionForStore(storeId), `fail-batch:${storeId}`)
    await blockUnstartedChildren(env, storeId, parentTaskId, reason)
    const snapshot = await this.ctx.task.snapshotIn(storeId)
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

  /**
   * Whether this deployment admits a run's own `task_decompose`
   * (`Config.allowRuntimeDecomposition`), read-only. The context package's
   * worker projection carries the rule that follows from it; nothing here
   * grants or denies a call — admission still decides every one.
   */
  allowsRuntimeDecomposition(): boolean {
    return this.config.allowRuntimeDecomposition
  }

  /**
   * The gate phase one bound session's run implies, applied on every rebinding.
   * The gate is a handle on the run's phase and the phase is the store's fact,
   * so a session this process rebound — from its index, from a reopened store,
   * or with a phase that moved under an in-flight call — is gated as what its
   * run is. `undefined` (a record that predates phases) leaves the session
   * ungated, which is the gate's own contract for an unbindable phase, and a
   * session with no run is never gated at all.
   *
   * Two ways a read of that record can be too old to apply, and each has its own
   * guard: the closing set checked below (a decision of this process that the
   * store's write has not caught up with yet), and the `token` its caller took
   * before the read ({@link ExecutionGate.applyStorePhase}, for a read that
   * straddled a decision).
   *
   * - **A read taken inside a window whose decision is in effect but not yet
   *   persisted** — a store this process is closing ({@link cancelGraph}, whose
   *   barrier is raised before it is written): there the record read back is
   *   older than a phase this process already closed, so a rebinding may not
   *   move a phase that session holds. Whether it holds one is the whole
   *   distinction — a session the cancellation never reached has none, and the
   *   store decides for it exactly as it does everywhere else, which is what
   *   keeps the restore path (`waiting_children`, terminal records) working.
   * - **A read that straddled a decision** — the query read the record, a
   *   decision landed, and the value is applied afterwards: `token` is the
   *   gate's decision count taken before that read ({@link initializeStoreGates}
   *   is the caller now — the read door no longer writes the gate), and
   *   {@link ExecutionGate.applyStorePhase} drops the value when it has moved
   *   since. The closing set above cannot see this one — by then the store is
   *   up to date and the store is not being closed any more.
   */
  private gatePhaseFromStore(sessionId: string, run: TaskRun, storeId: string, token: number): void {
    if (this.closingStores.has(storeId) && this.executionGate.phaseOf(sessionId) !== undefined) return
    const phase = this.runGatePhase(run)
    if (phase === undefined) return
    this.executionGate.applyStorePhase(sessionId, phase, token)
  }

  /**
   * The read door a session's first lookup takes (A2 §E): a read, and only a
   * read. A binding this process holds is resolved against the store; a
   * session this process never held resolves its store from its graph, opens
   * it, and indexes the snapshot so the binding the record implies answers.
   * Nothing else happens here — no recovery pass, no gate write, no spawn —
   * because a query cannot be the thing that recovers a store: recovery runs
   * behind the explicit activation barrier ({@link adoptRoot}), which is also
   * where every session the store knows gets its gate phase
   * ({@link initializeStoreGates}).
   */
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
    const rebinding = this.sessions.get(sessionId)
    if (rebinding === undefined) return undefined
    return await this.resolveBinding(rebinding)
  }

  /**
   * The recovery state of one store, as a read sees it (A2 §E): the barrier
   * handle first, and — when no barrier has run for this store in this process
   * — the store's own record, read-only. Work this process drives (a root it
   * activated here, a worker it spawned, a batch whose driver is registered)
   * is live, not recovery's; a still-running run nobody here drives is what
   * `recovery-required` names, unless it predates coordination phases, which
   * is the `needs-recovery` that allows only reading and cancelling. The
   * store's own root run is its session's, not recovery's — the same rule the
   * recovery pass applies — so a root legitimately sitting `active` between
   * its own decisions is not a recovery verdict, and the gate plus the state
   * rules are what refuse a write on it.
   *
   * Never a trigger: this opens no gate, starts no driver and settles no run,
   * so a context query, a diagnostic or the DSH first-request check can show
   * where a store stands without executing anything.
   */
  async recoveryStatus(storeId: string): Promise<StoreRecoveryStatus> {
    const state = this.storeRecovery.get(storeId)
    if (state !== undefined) {
      if (state.status === 'recovering') return { status: 'recovering' }
      if (state.status === 'failed') return { status: 'recovery-failed', reason: state.reason ?? 'the recovery barrier failed' }
      return { status: 'ready' }
    }
    let snapshot: TaskSnapshot
    try {
      snapshot = await this.ctx.task.openStore(storeId)
    } catch (error) {
      return { status: 'not-activated', reason: error instanceof Error ? error.message : String(error) }
    }
    for (const run of snapshot.runs) {
      if (run.status !== 'running') continue
      // Live work, not recovery's: a session this process started, or a session
      // whose agent is live here (a resumed root, a spawned worker still in its
      // turn) — the same distinction the runtime itself makes when it resolves
      // a caller.
      if (this.startedSessions.has(run.sessionId)) continue
      if (this.agentOrUndefined(run.sessionId) !== undefined) continue
      if (run.batchId !== undefined && this.drivers.has(`${storeId}/${run.batchId}`)) continue
      if (rootTaskStoreId(run.sessionId) === storeId) continue
      if (run.executionPhase === undefined) {
        return {
          status: 'needs-recovery',
          reason: `run "${run.runId}" predates coordination phases and is not treated as active`,
        }
      }
      return {
        status: 'recovery-required',
        reason: `run "${run.runId}" (phase "${run.executionPhase}") is in flight from a process that is gone`,
      }
    }
    return { status: 'ready' }
  }

  /**
   * The recovery door every business execution entry passes before its first
   * side effect (A2 §E): the same condition the barrier establishes, refused
   * by name — `recovering` while the barrier runs, `recovery-failed` with the
   * original reason after one failed, `recovery-required` for work a dead
   * process left, `needs-recovery` for a record that predates phases. The
   * store-nothing refusals never trigger recovery themselves; cancellation,
   * close and the read-only doors are not gated here.
   *
   * The `not-activated` answer proceeds: the legal root entry (an intake)
   * creates the store, and every other caller is refused by the store's own
   * unknown-store error rather than by a recovery verdict.
   */
  private async assertRecoveryReady(storeId: string, entry: string): Promise<void> {
    const readiness = await this.recoveryStatus(storeId)
    if (readiness.status === 'ready' || readiness.status === 'not-activated') return
    const because =
      readiness.status === 'recovering'
        ? 'its recovery barrier is still running; retry once the graph\'s activation completes'
        : readiness.status === 'recovery-failed'
          ? `the last recovery failed: ${readiness.reason}; an explicit activation (adoptRoot) retries it`
          : readiness.status === 'needs-recovery'
            ? `${readiness.reason}; only reading and cancelling are allowed`
            : `${readiness.reason}; await the graph's activation or adoptRoot before executing against this store`
    throw new Error(`task-runtime: ${entry} on store "${storeId}" is refused: the store is ${readiness.status} — ${because}`)
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
      // What every settled run leaves behind (the gate closes, the workspace
      // layer comes off) is the runtime's own bookkeeping, shared with the
      // settlements the runtime performs without an env — see
      // {@link runSettledFromRuntime}.
      onRunSettled: (storeId, taskId, runId, status) => {
        this.runSettledFromRuntime(storeId, taskId, runId, status)
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
          ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
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
   * re-entry (`adoptRoot` adopting an existing root run) both perform before
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
   * the error lists the registered ids. The listing is read through the one
   * helper every provider check shares (`registeredVerifierIds`), which readies
   * the registry first — a service that has been constructed but not readied
   * reports an empty list, and reading that as "nothing is registered" would
   * refuse a healthy deployment's batches. A deployment whose verifier service is
   * absent or cannot list its registry cannot make that promise either, so a
   * declared ref fails loudly there instead of passing through unchecked.
   */
  private async assertKnownVerifierRefs(
    declared: readonly { childIndex: number; criterion: AcceptanceCriterion }[],
    what: string,
  ): Promise<void> {
    const refs = declared.filter(item => item.criterion.verifierRef !== undefined)
    if (refs.length === 0) return
    const registered = await this.registeredVerifierIds()
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
