import { parseMcpServerRegistry } from '../mcp-servers.ts'
import { defaultTaskTemplatesRoot, findTaskTemplates, registerTaskTemplate, taskTemplatePage } from '../task-template.ts'
import type { TaskTemplateQuery } from '../task-template.ts'
import type { TaskTemplate, TemplateScope } from '@dangosys/dsh-singularity-task'
/**
 * The Singularity task runtime service: the class the deployment mounts as `ctx.taskRuntime`.
 * Every method delegates to the function module that owns it (see `./<block>.ts`), so the class
 */

import { dirname, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  AcceptanceCriterion,
  AdmissionContext,
  CapabilityManifest,
  ExecutionPhase,
  RunId,
  RunProviderBinding,
  RunStatus,
  TaskId,
  TaskInstance,
  TaskProposal,
  TaskProposalDecomposition,
  TaskProposalDecisionOutcome,
  TaskProposalRoot,
  TaskProposalStatus,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { type CapabilityConfig } from '../capability.ts'
import { ensureTaskLibrary, graphLibrary, libraryCapabilities, readTaskLibrary, writeTaskLibrary, reviewTaskLibrary } from '../library.ts'
import type { LibraryWrite, LibraryReview, TaskLibrary } from '../library.ts'
import { ExecutionGate } from '../gate.ts'
import type { ProviderPrecheck, SkillDiscoveryView } from '../provider-precheck.ts'
import { assertRootBudgetConfig } from '../root-budget.ts'
import { defaultRunBindingRoot } from '../run-binding.ts'
import type { RunBindingRead } from '../run-binding.ts'
import type { DecompositionIdentityContext, NormalizedBatch } from '../normalize.ts'
import type {
  AdoptedWorkerResume,
  AdoptedWorkerResumeRequest,
  BatchResultDeliveryStatus,
  BatchResultMessage,
  BudgetConfig,
  ChildOutcome,
  OrchestrateEnv,
  ReplayOverlay,
  ReplayRunOutcome,
  SessionObservation,
  TerminalReviewFact,
} from '../orchestration/types.ts'
import {
  type AnsweredQuestionOutcome,
  type AskedQuestionOutcome,
  type ParentAnswerCall,
  type ParentAskCall,
  type QuestionCoordinationDeps,
  type QuestionReconcileReport,
} from '../question.ts'
import type { RootRecoveryRequest } from '../recovery.ts'
import { WORKSPACE_OWNERS_DIR, WorkspaceRegistry } from '../workspace.ts'
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  DEFAULT_BUDGET,
  DEFAULT_GENERATED_TASK_REVIEW,
  DEFAULT_WRITE_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
  ConfigSchema,
} from '../config.ts'
import type { Config, ProviderLoadReport, RunBinding, DriverEntry, StoreRecoveryState, StoreRecoveryStateView } from '../config.ts'
import type {
  AdmitBatchRequest,
  CheckDerivedBatchRequest,
  DecomposeAdmissionResult,
  DecomposeProposalOptions,
  DecomposeSpec,
  DecompositionPrecheck,
  DecompositionRefusal,
  ProposalContinuation,
  ProposalDecisionResult,
  ProposalSubmission,
  ReconcileReport,
  ReplayTaskOptions,
  ReviewSubject,
  RootAdoption,
  RootBudgetApproval,
  RootBudgetExtensionHost,
  RootBudgetExtensionRequest,
  RootBudgetExtensionResult,
  RootContractSpec,
  RootIntakeOptions,
  RootIntakeResult,
  RootRecoveryCaller,
  RootRecoveryOutcome,
  StartBatchDriverOptions,
  StoreRecoveryStatus,
} from '../types.ts'
import * as svcLifecycle from './lifecycle.ts'
import * as svcRootIntake from './root-intake.ts'
import * as svcProposals from './proposals.ts'
import * as svcAdmission from './admission.ts'
import * as svcBudget from './budget.ts'
import * as svcRootRecovery from './root-recovery.ts'
import * as svcNotify from './notify.ts'
import * as svcReplay from './replay.ts'
import * as svcDrivers from './drivers.ts'
import * as svcQuestions from './questions.ts'
import * as svcSessions from './sessions.ts'
import * as svcEnv from './env.ts'

export class TaskRuntime extends Service {
  static inject = ['task', 'agentRuntime', 'graphs', 'sessionQuery']

  static Config: z<Config> = ConfigSchema

  readonly config: Config

  readonly sessions = new Map<string, RunBinding>()

  readonly startedSessions = new Set<string>()

  readonly drivers = new Map<string, DriverEntry>()

  readonly replayLineage = new Map<TaskId, string>()

  readonly activeWorkerSessions = new Set<string>()

  childAdmissionTail: Promise<void> = Promise.resolve()

  readonly capacityWaiters = new Set<() => void>()

  readonly workspaceReleases = new Set<Promise<void>>()

  readonly sessionWorkspaces = new Map<string, string>()

  readonly sessionExecutionBindings = new Map<string, { agentOptions?: AgentOptions; taskTemplatesRoot?: string; overlay?: ReplayOverlay }>()

  readonly executionGate: ExecutionGate

  readonly closingStores = new Set<string>()

  readonly storeRecovery = new Map<string, StoreRecoveryState>()

  readonly workspaces: WorkspaceRegistry

  providerLoad?: Promise<ProviderLoadReport>

  readonly parentChains = new Map<string, Promise<void>>()

  rootBudgetApproval?: RootBudgetApproval

  readonly terminalReviewListeners = new Set<(fact: TerminalReviewFact) => void | Promise<void>>()

  constructor(ctx: Context, config?: Partial<Config>) {
    super(ctx, 'taskRuntime')
    const rootBudget = config?.rootBudget === undefined ? undefined : { ...config.rootBudget }
    /**
     * A hard limit this deployment cannot execute is refused at load, not
     * accepted and quietly ignored (§3.5). The schema keeps unknown keys on the
     */
    if (config?.budget !== undefined) {
      const unknown = Object.keys(config.budget).filter(key => !['maxToolCalls', 'tokens', 'attempts'].includes(key))
      if (unknown.length > 0) throw new Error(`task-runtime: budget names unsupported fields [${unknown.join(', ')}]`)
    }
    svcLifecycle.assertClosedRootBudget(rootBudget)
    assertRootBudgetConfig(rootBudget ?? {})
    svcLifecycle.assertGeneratedTaskReview(config?.generatedTaskReview)
    svcLifecycle.assertSupervisionConfig(config?.supervision)
    const maxActiveWorkers = config?.maxActiveWorkers ?? 2
    if (!Number.isInteger(maxActiveWorkers) || maxActiveWorkers < 1) throw new Error(
      'task-runtime: maxActiveWorkers must be a positive integer',
    )
    this.config = {
      capabilities: structuredClone(config?.capabilities ?? {}),
      taskTemplatesRoot: config?.taskTemplatesRoot ?? defaultTaskTemplatesRoot(),
      mcpServers: parseMcpServerRegistry(config?.mcpServers ?? {}),
      ...(config?.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
      verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxChildren: config?.maxChildren ?? DEFAULT_MAX_CHILDREN,
      isolatedChildren: config?.isolatedChildren ?? false,
      maxActiveWorkers,
      budget: { ...DEFAULT_BUDGET, ...(config?.budget ?? {}) },
      allowRuntimeDecomposition: config?.allowRuntimeDecomposition ?? DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
      generatedTaskReview: config?.generatedTaskReview ?? DEFAULT_GENERATED_TASK_REVIEW,
      ...(config?.supervision === undefined ? {} : { supervision: { ...config.supervision } }),
      runBindingRoot: config?.runBindingRoot ?? defaultRunBindingRoot(),
      ...(rootBudget === undefined ? {} : { rootBudget }),
      writeDrainTimeoutMs: config?.writeDrainTimeoutMs ?? DEFAULT_WRITE_DRAIN_TIMEOUT_MS,
    }
    this.executionGate = new ExecutionGate()
    this.workspaces = new WorkspaceRegistry({
      markerRoot: join(this.config.runBindingRoot ?? defaultRunBindingRoot(), WORKSPACE_OWNERS_DIR),
    })
    /**
     * Unload (A3 §3.6): every driver is aborted and awaited, the gate closes for
     * every session this runtime tracks, and the workspace markers this process
     */
    ctx.effect(() => () => this.unload())
  }

  async libraryForRoot(rootSessionId: string): Promise<TaskLibrary> {
    return ensureTaskLibrary(graphLibrary(rootSessionId))
  }

  async libraryForSession(sessionId: string): Promise<TaskLibrary> {
    const graph = await this.context.graphs.graphForSession(SessionId(sessionId))
    return this.libraryForRoot(graph.rootSessionId)
  }

  async comparisonRunForSession(sessionId: string): Promise<TaskRun | undefined> {
    const library = await this.libraryForSession(sessionId)
    const graph = await this.context.graphs.graphForSession(SessionId(sessionId))
    const snapshot = await this.context.task.openStore(rootTaskStoreId(graph.rootSessionId)).catch(error => {
      if (error instanceof Error && /does not exist/.test(error.message)) return undefined
      throw error
    })
    const run = snapshot?.runs.filter(item => item.sessionId === sessionId).at(-1)
    if (run === undefined) return undefined
    const within = (root: string, target: string) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !path.startsWith('/')) }
    return this.sessionExecutionBindings.get(sessionId)?.overlay !== undefined ||
      (run.taskTemplatesRoot !== undefined && (within(join(library.root, 'evolution'), run.taskTemplatesRoot) || within(join(this.config.runBindingRoot!, 'replay-libraries'), run.taskTemplatesRoot)))
      ? run : undefined
  }

  async libraryRead(sessionId: string) {
    const library = await this.libraryForSession(sessionId)
    const execution = this.sessionExecutionBindings.get(sessionId)
    const run = await this.comparisonRunForSession(sessionId)
    if (run !== undefined) {
      const taskTemplatesRoot = run.taskTemplatesRoot ?? execution?.taskTemplatesRoot!
      const skillRoot = run.providerBinding?.snapshotRoot ?? execution?.overlay?.extraSkillRoots?.[0] ?? library.skillRoot
      return {
        ...library, id: run.runId, graphLibraryId: library.id, root: dirname(taskTemplatesRoot), taskTemplatesRoot, skillRoot, version: 1,
        readOnly: true,
        message: 'This Run uses a frozen comparison view. Include findings in task_submit_result; the supervisor can add useful experience to the graph library.',
        tasks: (await findTaskTemplates(taskTemplatesRoot)).map(({ templateRef, template }) => ({ templateRef, status: 'temporary', skills: [...new Set((template.contract.requiredCapabilities ?? []).flatMap(capability => capability.startsWith('method:') ? [capability.slice(7)] : (run.providerBinding?.skills ?? []).filter(skill => skill.capabilities.includes(capability)).map(skill => skill.name)))] })),
        skills: (run.providerBinding?.skills ?? []).map(item => ({ name: item.name, version: 0, digest: item.contentDigest, status: 'temporary' })),
      }
    }
    return readTaskLibrary(library)
  }

  async libraryWrite(sessionId: string, input: LibraryWrite) {
    if (await this.comparisonRunForSession(sessionId) !== undefined)
      throw new Error('Include findings in task_submit_result; the supervisor can add useful experience to the graph library after comparison')
    // The caller's recorded task/delegation gives authority; temporary writes still belong to active work.
    await this.templateCaller(sessionId)
    const graph = await this.context.graphs.graphForSession(SessionId(sessionId))
    const core = this.softService<{ resolveCaller(id: string): Promise<{ kind: string; delegation?: { role?: string } }> }>('singularityContext')
    const caller = await core?.resolveCaller(sessionId)
    const supervisor = caller?.kind === 'reviewer' && caller.delegation?.role === 'supervisor'
    if (!supervisor) {
      const binding = this.sessions.get(sessionId)
      const snapshot = await this.context.task.openStore(binding?.storeId ?? rootTaskStoreId(graph.rootSessionId)).catch(error => {
        if (graph.rootSessionId === sessionId && error instanceof Error && /does not exist/.test(error.message)) return undefined
        throw error
      })
      const run = binding === undefined
        ? snapshot?.runs.filter(item => item.sessionId === sessionId).at(-1)
        : snapshot?.runs.find(item => item.runId === binding.runId)
      if (run === undefined ? graph.rootSessionId !== sessionId : run.status !== 'running' || (run.executionPhase !== undefined && run.executionPhase !== 'active'))
        throw new Error('task-library: temporary writes belong to root planning, an active Task, or delegated method supervision')
    }
    return writeTaskLibrary(await this.libraryForSession(sessionId), input, await this.capabilitiesForSession(sessionId))
  }

  async libraryReview(sessionId: string, review: LibraryReview) {
    if (await this.comparisonRunForSession(sessionId) !== undefined)
      throw new Error('Include comparison findings in task_submit_result for graph method supervision')
    const graph = await this.context.graphs.graphForSession(SessionId(sessionId))
    if (graph.rootSessionId !== sessionId || graph.rsi !== undefined) {
      const core = this.softService<{ resolveCaller(id: string): Promise<{ kind: string; delegation?: { role?: string } }> }>('singularityContext')
      const caller = await core?.resolveCaller(sessionId)
      if (caller?.kind !== 'reviewer' || caller.delegation?.role !== 'supervisor')
        throw new Error('task-library: retention decisions belong to the graph root or delegated supervisor')
    }
    return reviewTaskLibrary(await this.libraryForSession(sessionId), review, sessionId)
  }

  async capabilitiesForSession(sessionId: string): Promise<Record<string, CapabilityConfig>> {
    const overlay = this.sessionExecutionBindings.get(sessionId)?.overlay
    return { ...this.config.capabilities, ...await libraryCapabilities(await this.libraryForSession(sessionId)), ...overlay?.capabilityOverrides }
  }

  async skillViewForSession(sessionId: string, extraRoots: readonly string[] = []): Promise<SkillDiscoveryView> {
    const overlay = this.sessionExecutionBindings.get(sessionId)?.overlay
    const library = await this.libraryForSession(sessionId)
    const cwd = await this.envPathForSession(sessionId)
    return { ...(cwd === undefined ? {} : { cwd }), extraRoots: [...extraRoots, ...(overlay?.extraSkillRoots ?? []), library.skillRoot] }
  }

  async taskTemplatesRootFor(sessionId?: string): Promise<string | undefined> {
    if (sessionId === undefined) return this.config.taskTemplatesRoot
    return this.sessionExecutionBindings.get(sessionId)?.taskTemplatesRoot ?? (await this.libraryForSession(sessionId)).taskTemplatesRoot
  }

  async findTaskTemplates(query?: string, callerSessionId?: string) {
    const caller = callerSessionId === undefined ? undefined : await this.templateCaller(callerSessionId)
    return findTaskTemplates(caller?.root ?? this.config.taskTemplatesRoot, query, caller?.scope)
  }

  /** Pure store reads: catalog queries never adopt a Run or alter its gate. */
  async templateCaller(sessionId: string): Promise<{ root: string | undefined; scope?: TemplateScope }> {
    const binding = this.sessions.get(sessionId)
    const graph = binding === undefined ? await this.context.graphs.graphForSession(SessionId(sessionId)) : undefined
    const storeId = binding?.storeId ?? rootTaskStoreId(graph!.rootSessionId)
    const snapshot = await this.context.task.openStore(storeId).catch(error => {
      if (graph?.rootSessionId === sessionId && error instanceof Error && /does not exist/.test(error.message)) return undefined
      throw error
    })
    let run = snapshot?.runs.filter(item => item.sessionId === sessionId).at(-1)
    let task = run === undefined ? undefined : snapshot?.tasks.find(item => item.taskId === run?.taskId)
    if (task === undefined && graph?.rootSessionId !== sessionId) {
      // Coordination sessions have no business Run. The existing read core checks their recorded delegation.
      const core = this.softService<{ resolveCaller(id: string): Promise<{ kind: string; storeId?: string; task?: TaskInstance; delegation?: { sourceRunId?: string | null } }> }>('singularityContext')
      const delegated = await core?.resolveCaller(sessionId)
      if (delegated?.kind !== 'reviewer' || delegated.storeId !== storeId || delegated.task === undefined)
        throw new Error('task-template: caller has no bound Task, valid delegation or root intake authority')
      task = delegated.task
      run = delegated.delegation?.sourceRunId === undefined
        ? snapshot?.runs.filter(item => item.taskId === task!.taskId).at(-1)
        : snapshot?.runs.find(item => item.runId === delegated.delegation?.sourceRunId && item.taskId === task!.taskId)
    }
    return {
      root: run?.taskTemplatesRoot ?? await this.taskTemplatesRootFor(sessionId),
      ...(task === undefined ? {} : { scope: task.contract?.templateScope }),
    }
  }

  async listTaskTemplates(request: TaskTemplateQuery, callerSessionId: string) {
    const caller = await this.templateCaller(callerSessionId)
    return taskTemplatePage(caller.root, request, caller.scope)
  }

  async registerTaskTemplate(template: TaskTemplate, callerSessionId?: string) {
    if (callerSessionId !== undefined) {
      const result = await this.libraryWrite(callerSessionId, { kind: 'task', template })
      return (result as import('../library.ts').LibraryTask).templateRef
    }
    if (this.config.taskTemplatesRoot === undefined) throw new Error('task-runtime: taskTemplatesRoot is not configured')
    return registerTaskTemplate(this.config.taskTemplatesRoot, template)
  }

  async unload(): Promise<void> {
    return svcLifecycle.unload(this)
  }

  async [Service.init](): Promise<void> {
    return svcLifecycle.serviceInit(this)
  }

  async providerLoadReport(): Promise<ProviderLoadReport> {
    return svcLifecycle.providerLoadReport(this)
  }

  warn(message: string): void {
    return svcLifecycle.warn(this, message)
  }

  get verifyTimeoutMs(): number {
    return svcLifecycle.verifyTimeoutMs(this)
  }

  get budget(): Readonly<BudgetConfig> {
    return svcLifecycle.budget(this)
  }

  get generatedTaskReview(): 'off' | 'all' {
    return svcLifecycle.generatedTaskReview(this)
  }

  get gate(): ExecutionGate {
    return svcLifecycle.gate(this)
  }

  resolveCapabilities(required: readonly string[]): CapabilityManifest {
    return svcLifecycle.resolveCapabilitiesImpl(this, required)
  }

  listMcpServers(): Readonly<Record<string, import('../mcp-servers.ts').McpServerTemplate>> {
    return structuredClone(this.config.mcpServers ?? {})
  }

  listCapabilities(): Readonly<Record<string, CapabilityConfig>> {
    return svcLifecycle.listCapabilities(this)
  }

  async applyCapabilityRow(
    name: string,
    entry: CapabilityConfig | null,
    options: { commitTargets?: readonly string[]; commitRow?: string; mcpServers?: Record<string, import('../mcp-servers.ts').McpServerTemplate | null> } = {},
  ): Promise<void> {
    return svcLifecycle.applyCapabilityRow(this, name, entry, options)
  }

  async adoptRoot(storeId: string, rootSessionId: string): Promise<RootAdoption> {
    return svcRootIntake.adoptRoot(this, storeId, rootSessionId)
  }

  async initializeStoreGates(storeId: string): Promise<void> {
    return svcRootIntake.initializeStoreGates(this, storeId)
  }

  runGatePhase(run: TaskRun): ExecutionPhase | 'terminal' | undefined {
    return svcRootIntake.runGatePhase(run)
  }

  async intakeRootContract(
    storeId: string,
    rootSessionId: string,
    spec: RootContractSpec,
    options: RootIntakeOptions = {},
  ): Promise<RootIntakeResult> {
    return svcRootIntake.intakeRootContract(this, storeId, rootSessionId, spec, options)
  }

  async submitRootContractProposal(
    storeId: string,
    rootSessionId: string,
    spec: RootContractSpec,
    options: RootIntakeOptions = {},
  ): Promise<ProposalSubmission> {
    return svcRootIntake.submitRootContractProposal(this, storeId, rootSessionId, spec, options)
  }

  async decomposeAndRun(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    exec: { signal?: AbortSignal; callId?: string } = {},
  ): Promise<DecomposeAdmissionResult> {
    return svcProposals.decomposeAndRun(this, storeId, parentTaskId, parentRunId, callerSessionId, spec, exec)
  }

  async submitDecompositionProposal(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    options: DecomposeProposalOptions = {},
  ): Promise<ProposalSubmission> {
    return svcProposals.submitDecompositionProposal(
      this,
      storeId,
      parentTaskId,
      parentRunId,
      callerSessionId,
      spec,
      options,
    )
  }

  async continueProposal(
    storeId: string,
    proposalId: string,
    caller: string,
    options: { spec?: DecomposeSpec; exec?: { callId?: string } } = {},
  ): Promise<ProposalContinuation> {
    return svcProposals.continueProposal(this, storeId, proposalId, caller, options)
  }

  async decideProposal(
    storeId: string,
    proposalId: string,
    decision: { outcome: TaskProposalDecisionOutcome; reason?: string; decidedAt?: string },
    decidedBy: string,
    exec: { callId?: string } = {},
  ): Promise<ProposalDecisionResult> {
    return svcProposals.decideProposal(this, storeId, proposalId, decision, decidedBy, exec)
  }

  async cancelProposal(storeId: string, proposalId: string, caller: string): Promise<ProposalDecisionResult> {
    return svcProposals.cancelProposal(this, storeId, proposalId, caller)
  }

  async proposalIn(storeId: string, proposalId: string): Promise<TaskProposal> {
    return svcProposals.proposalIn(this, storeId, proposalId)
  }

  async proposalsForParent(storeId: string, parentTaskId: TaskId): Promise<TaskProposal[]> {
    return svcProposals.proposalsForParent(this, storeId, parentTaskId)
  }

  registerRootBudgetApproval(approval: RootBudgetApproval): () => void {
    return svcBudget.registerRootBudgetApproval(this, approval)
  }

  registerTerminalReviewListener(listener: (fact: TerminalReviewFact) => void | Promise<void>): () => void {
    return svcNotify.registerTerminalReviewListener(this, listener)
  }

  notifyTerminalReview(fact: TerminalReviewFact): void {
    return svcNotify.notifyTerminalReview(this, fact)
  }

  async extendRootBudget(
    sessionId: string,
    host: RootBudgetExtensionHost,
    request: RootBudgetExtensionRequest,
  ): Promise<RootBudgetExtensionResult> {
    return svcBudget.extendRootBudget(this, sessionId, host, request)
  }

  async recoverRootTask(
    storeId: string,
    request: RootRecoveryRequest,
    caller: RootRecoveryCaller,
  ): Promise<RootRecoveryOutcome> {
    return svcRootRecovery.recoverRootTask(this, storeId, request, caller)
  }

  async deriveBatch(
    identity: DecompositionIdentityContext,
    spec: DecomposeSpec,
  ): Promise<{ ok: true; batch: NormalizedBatch; envPath?: string } | { ok: false; refusal: DecompositionRefusal }> {
    return svcAdmission.deriveBatch(this, identity, spec)
  }

  async manifestsOf(batch: NormalizedBatch, callerSessionId?: string): Promise<CapabilityManifest[]> {
    return svcAdmission.manifestsOf(this, batch, callerSessionId)
  }

  storedBatchOf(proposal: TaskProposal): NormalizedBatch {
    return svcAdmission.storedBatchOf(proposal)
  }

  async decompositionState(sessionId: string) {
    const found = await this.runForSession(sessionId)
    return svcAdmission.decompositionAvailability(this, found.task, found.run, await this.context.task.snapshotIn(found.storeId))
  }

  async assertDecomposableRun(
    storeId: string,
    parentTask: TaskInstance,
    parentRun: TaskRun,
    callerSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return svcAdmission.assertDecomposableRun(this, storeId, parentTask, parentRun, callerSessionId, signal)
  }

  async inFlightProposalsOf(storeId: string, parentRunId: RunId): Promise<TaskProposalDecomposition[]> {
    return svcAdmission.inFlightProposalsOf(this, storeId, parentRunId)
  }

  async checkDerivedBatch(request: CheckDerivedBatchRequest): Promise<DecompositionPrecheck> {
    return svcAdmission.checkDerivedBatch(this, request)
  }

  async admitPrecheckedBatch(request: AdmitBatchRequest): Promise<{ batchId: string; childTaskIds: TaskId[] }> {
    return svcAdmission.admitPrecheckedBatch(this, request)
  }

  async existingRootTask(storeId: string): Promise<TaskInstance | undefined> {
    return svcRootIntake.existingRootTask(this, storeId)
  }

  async continueRootProposalIn(storeId: string, proposal: TaskProposalRoot): Promise<ProposalContinuation> {
    return svcRootIntake.continueRootProposalIn(this, storeId, proposal)
  }

  async serializeRootIntake<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    return svcRootIntake.serializeRootIntake(this, storeId, work)
  }

  async continueProposalIn(
    storeId: string,
    proposalId: string,
    caller: string,
    options: { spec?: DecomposeSpec; exec?: { callId?: string } },
  ): Promise<ProposalContinuation> {
    return svcProposals.continueProposalIn(this, storeId, proposalId, caller, options)
  }

  async staleProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation> {
    return svcProposals.staleProposal(this, storeId, proposal, reason)
  }

  async expireProposal(storeId: string, proposal: TaskProposal, reason: string): Promise<ProposalContinuation> {
    return svcProposals.expireProposal(this, storeId, proposal, reason)
  }

  async requireProposal(storeId: string, proposalId: string): Promise<TaskProposal> {
    return svcProposals.requireProposal(this, storeId, proposalId)
  }

  async readProposal(storeId: string, proposalId: string): Promise<TaskProposal | undefined> {
    return svcProposals.readProposal(this, storeId, proposalId)
  }

  async requestProposalReview(request: ReviewSubject): Promise<{ requested: boolean; detail: string }> {
    return svcProposals.requestProposalReview(this, request)
  }

  async serializeParent<T>(storeId: string, parentTaskId: TaskId, work: () => Promise<T>): Promise<T> {
    return svcProposals.serializeParent(this, storeId, parentTaskId, work)
  }

  async reconcileProposals(storeId: string): Promise<ReconcileReport['unresolvedProposals']> {
    return svcProposals.reconcileProposals(this, storeId)
  }

  async reconcileRootProposal(
    storeId: string,
    proposal: TaskProposalRoot,
    report: (proposal: TaskProposal, status: TaskProposalStatus, reason: string) => Promise<void>,
  ): Promise<void> {
    return svcRootIntake.reconcileRootProposal(this, storeId, proposal, report)
  }

  async replayTask(
    storeId: string,
    championTaskId: TaskId,
    options: ReplayTaskOptions,
    callerSessionId: string,
  ): Promise<ReplayRunOutcome> {
    return svcReplay.replayTask(this, storeId, championTaskId, options, callerSessionId)
  }

  registerDriver(
    key: string,
    storeId: string,
    controller: AbortController,
    promise: Promise<ChildOutcome[]>,
    parentTaskId?: TaskId,
  ): void {
    return svcDrivers.registerDriver(this, key, storeId, controller, promise, parentTaskId)
  }

  standDownPendingDrivers(state: StoreRecoveryState): void {
    return svcDrivers.standDownPendingDrivers(this, state)
  }

  invalidateStoreRecovery(storeId: string): void {
    return svcRootRecovery.invalidateStoreRecovery(this, storeId)
  }

  async batchRecordIn(
    storeId: string,
    batchId: string,
  ): Promise<{ taskId: TaskId; run: TaskRun; memberTaskIds: readonly TaskId[] } | undefined> {
    return svcDrivers.batchRecordIn(this, storeId, batchId)
  }

  runSettledFromRuntime(storeId: string, taskId: TaskId, runId: RunId, status: RunStatus): void {
    return svcDrivers.runSettledFromRuntime(this, storeId, taskId, runId, status)
  }

  startBatchDriver(options: StartBatchDriverOptions): void {
    return svcDrivers.startBatchDriver(this, options)
  }

  async submitResult(
    callerSessionId: string,
    spec: { summary: string; evidenceRefs?: string[]; notes?: string },
    exec: { callId?: string } = {},
  ): Promise<{ status: string; detail: string }> {
    return svcDrivers.submitResult(this, callerSessionId, spec, exec)
  }

  async askParentQuestion(callerSessionId: string, request: ParentAskCall): Promise<AskedQuestionOutcome> {
    return svcQuestions.askParentQuestionImpl(this, callerSessionId, request)
  }

  async answerParentQuestion(callerSessionId: string, request: ParentAnswerCall): Promise<AnsweredQuestionOutcome> {
    return svcQuestions.answerParentQuestionImpl(this, callerSessionId, request)
  }

  questionCoordination(): QuestionCoordinationDeps {
    return svcQuestions.questionCoordination(this)
  }

  async cancelBatch(storeId: string, batchId: string, callerSessionId: string): Promise<ChildOutcome[]> {
    return svcDrivers.cancelBatch(this, storeId, batchId, callerSessionId)
  }

  async cancelGraph(storeId: string, reason: string): Promise<void> {
    return svcDrivers.cancelGraph(this, storeId, reason)
  }

  async awaitBatch(storeId: string, batchId: string): Promise<ChildOutcome[]> {
    return svcDrivers.awaitBatch(this, storeId, batchId)
  }

  async reconcileStore(storeId: string, rootSessionId?: string): Promise<ReconcileReport> {
    return svcDrivers.reconcileStore(this, storeId, rootSessionId)
  }

  async wakeUnclaimedQuestionMessages(storeId: string, deliveries: readonly QuestionReconcileReport[]): Promise<void> {
    return svcQuestions.wakeUnclaimedQuestionMessages(this, storeId, deliveries)
  }

  wakeUnclaimedBatchResults(unread: readonly { sessionId: string; messageId: string }[]): void {
    return svcNotify.wakeUnclaimedBatchResults(this, unread)
  }

  sessionHoldsPendingMessage(sessionId: string, messageId: string): boolean {
    return svcNotify.sessionHoldsPendingMessage(this, sessionId, messageId)
  }

  async resumeAdoptedWorkerSession(request: AdoptedWorkerResumeRequest): Promise<AdoptedWorkerResume> {
    return svcSessions.resumeAdoptedWorkerSession(this, request)
  }

  async rebuildWorkspaceOwnership(storeId: string): Promise<void> {
    return svcSessions.rebuildWorkspaceOwnership(this, storeId)
  }

  async releaseStoreWorkspace(storeId: string): Promise<void> {
    return svcSessions.releaseStoreWorkspace(this, storeId)
  }

  async failBatch(storeId: string, batchId: string, reason: string): Promise<void> {
    return svcDrivers.failBatch(this, storeId, batchId, reason)
  }

  recoverySessionFor(snapshot: TaskSnapshot | undefined, storeId: string): string {
    return svcSessions.recoverySessionFor(this, snapshot, storeId)
  }

  async sessionForStore(storeId: string): Promise<string> {
    return svcSessions.sessionForStore(this, storeId)
  }

  async runForSession(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
    return svcSessions.runForSession(this, sessionId)
  }

  allowsRuntimeDecomposition(): boolean {
    return svcSessions.allowsRuntimeDecomposition(this)
  }

  gatePhaseFromStore(sessionId: string, run: TaskRun, storeId: string, token: number): void {
    return svcSessions.gatePhaseFromStore(this, sessionId, run, storeId, token)
  }

  async recoveryStatus(storeId: string): Promise<StoreRecoveryStatus> {
    return svcRootRecovery.recoveryStatus(this, storeId)
  }

  /** The live barrier's deferred work; a store this process holds no barrier for has none to show. */
  recoveryState(storeId: string): StoreRecoveryStateView | undefined {
    const state = this.storeRecovery.get(storeId)
    if (state === undefined) return undefined
    return {
      wokenSessions: [...state.wokenSessions],
      pendingNotices: state.pendingNotices.map(notice => ({ ...notice })),
      pendingBatchResults: state.pendingBatchResults.map(result => ({ ...result })),
      ...(state.cancelled === undefined ? {} : { cancelled: state.cancelled }),
    }
  }

  async assertRecoveryReady(storeId: string, entry: string): Promise<void> {
    return svcRootRecovery.assertRecoveryReady(this, storeId, entry)
  }

  reindex(storeId: string, snapshot: TaskSnapshot): void {
    return svcSessions.reindex(this, storeId, snapshot)
  }

  async workspacePathForSession(sessionId: string): Promise<string | undefined> {
    return svcSessions.workspacePathForSession(this, sessionId)
  }

  async workspacePathFor(sessionId: string): Promise<string | undefined> {
    return svcSessions.workspacePathFor(this, sessionId)
  }

  async assertWorkspaceHeldBy(
    workspace: string,
    storeId: string,
    parentTask: TaskInstance,
    parentRunId: RunId,
  ): Promise<void> {
    return svcSessions.assertWorkspaceHeldBy(this, workspace, storeId, parentTask, parentRunId)
  }

  notify(sessionId: string, text: string): void {
    return svcNotify.notify(this, sessionId, text)
  }

  notifyWhenReady(sessionId: string, text: string): void {
    return svcNotify.notifyWhenReady(this, sessionId, text)
  }

  async deliverBatchResult(message: BatchResultMessage): Promise<BatchResultDeliveryStatus> {
    return svcNotify.deliverBatchResult(this, message)
  }

  async deliverBatchResultNow(message: BatchResultMessage): Promise<BatchResultDeliveryStatus> {
    return svcNotify.deliverBatchResultNow(this, message)
  }

  async redeliverBatchResult(storeId: string, batchId: string): Promise<BatchResultDeliveryStatus> {
    return svcNotify.redeliverBatchResult(this, storeId, batchId)
  }

  async reconcileSessionJobs(sessionId: string): Promise<void> {
    return svcNotify.reconcileSessionJobs(this, sessionId)
  }

  admissionContext(): AdmissionContext {
    return svcEnv.admissionContext(this)
  }

  async envPathForSession(sessionId: string): Promise<string | undefined> {
    return svcEnv.envPathForSession(this, sessionId)
  }

  contractRefusal(parentTaskId: TaskId, reasons: readonly string[]): Error {
    return svcEnv.contractRefusal(parentTaskId, reasons)
  }

  async orchestrateEnv(callerSessionId: string, actor: string, workspace?: string, overlay?: ReplayOverlay): Promise<OrchestrateEnv> {
    return svcEnv.orchestrateEnv(this, callerSessionId, actor, workspace, overlay)
  }

  watchRun(storeId: string, runId: RunId, callback: (status: RunStatus) => void): () => void {
    return svcEnv.watchRun(this, storeId, runId, callback)
  }

  sessionBoundInProcess(storeId: string, runId: RunId): string | undefined {
    return svcEnv.sessionBoundInProcess(this, storeId, runId)
  }

  async releaseRunWorkspaceLayer(storeId: string, runId: RunId, sessionId: string): Promise<void> {
    return svcEnv.releaseRunWorkspaceLayer(this, storeId, runId, sessionId)
  }

  async observeSession(sessionId: string): Promise<SessionObservation | undefined> {
    return svcEnv.observeSession(this, sessionId)
  }

  softService<T>(name: string): T | undefined {
    return svcEnv.softService(this, name)
  }

  async registeredVerifierIds(): Promise<readonly string[] | undefined> {
    return svcEnv.registeredVerifierIdsImpl(this)
  }

  async providerPrecheck(
    capabilities: readonly string[],
    view: SkillDiscoveryView,
    table: Readonly<Record<string, CapabilityConfig>> = this.config.capabilities,
    mcpRegistry: Readonly<Record<string, import('../mcp-servers.ts').McpServerTemplate>> = this.config.mcpServers ?? {},
    callerSessionId?: string,
  ): Promise<ProviderPrecheck> {
    return svcEnv.providerPrecheck(this, capabilities, view, table, mcpRegistry, callerSessionId)
  }

  async capabilityProviderReport(sessionId: string, capabilities?: readonly string[]): Promise<ProviderPrecheck> {
    return svcEnv.capabilityProviderReport(this, sessionId, capabilities)
  }

  async readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined> {
    return svcEnv.readRunBindingImpl(binding)
  }

  async assertKnownVerifierRefs(
    declared: readonly { childIndex: number; criterion: AcceptanceCriterion }[],
    what: string,
  ): Promise<void> {
    return svcEnv.assertKnownVerifierRefs(this, declared, what)
  }

  liveAgent(sessionId: string): Agent {
    return svcEnv.liveAgent(this, sessionId)
  }

  agentOrUndefined(sessionId: string): Agent | undefined {
    return svcEnv.agentOrUndefined(this, sessionId)
  }

  /** Public alias of the protected `Service.ctx` for the extracted modules. */
  get context(): Context {
    return this.ctx
  }
}
