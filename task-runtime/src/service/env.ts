/**
 * The orchestration environment each block runs against, and the observation it feeds.
 */

import type { TaskRuntime } from './runtime.ts'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AcceptanceCriterion,
  AdmissionContext,
  ReviewTokenUsage,
  RunId,
  RunProviderBinding,
  RunStatus,
  TaskId,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { McpServerTemplate } from '../mcp-servers.ts'
import type { CapabilityConfig } from '../capability.ts'
import type { JobsView } from '../gate.ts'
import { optionalService, precheckProviders, registeredVerifierIds } from '../provider-precheck.ts'
import type { EvolutionCommitLedger, ProviderPrecheck, SkillDiscoveryView } from '../provider-precheck.ts'
import { readRunBinding } from '../run-binding.ts'
import type { RunBindingRead } from '../run-binding.ts'
import { VerifierUnavailableError, type OrchestrateEnv, type ReplayOverlay, type SessionObservation } from '../orchestration/types.ts'
import { message } from '../helpers.ts'
import { releaseLayer } from '../workspace.ts'
import type {
  RunVerifier,
  EnvPathSource,
  AgentPresetRegistry,
  PermissionPresetRegistry,
  LiveSessionLookup,
  SessionProjectionSource,
  SessionLogSource,
} from '../config.ts'

export const HUMAN_TOOLS: ReadonlySet<string> = new Set(['hitl_ask', 'hitl_approve', 'ask_user_question'])

export function toolResultFailed(data: {
  error?: unknown
  message?: { isError?: boolean }
}): boolean {
  if (data.error !== undefined) return true
  return data.message?.isError === true
}

export function skillNameFrom(rawArguments: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArguments) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined
  } catch {
    return undefined
  }
}

export function tokenUsageOf(value: unknown): ReviewTokenUsage | undefined {
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

export function admissionContext(self: TaskRuntime): AdmissionContext {
  const budget = self.config.budget
  return {
    maxDepth: self.config.maxDepth,
    maxChildren: self.config.maxChildren,
    auditOnly: {
      ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls }),
      ...(budget.tokens === undefined ? {} : { tokens: budget.tokens }),
      ...(budget.attempts === undefined ? {} : { attempts: budget.attempts }),
    },
  }
}

export async function sessionEnv(
  self: TaskRuntime,
  sessionId: string,
): Promise<{ path: string; components?: readonly { repo: string; dir: string }[] } | undefined> {
  /**
   * The whole resolution sits inside the `try`, service lookup included: on a
   * real Cordis context an absent service throws on property access
   */
  try {
    const envBuilder = (self.context.get?.('envBuilder') ??
      (self.context as unknown as { envBuilder?: EnvPathSource }).envBuilder) as EnvPathSource | undefined
    if (envBuilder === undefined) return undefined
    const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
    return envBuilder.store.get(graph.envId)
  } catch {
    return undefined
  }
}

export async function envPathForSession(self: TaskRuntime, sessionId: string): Promise<string | undefined> {
  const named = self.sessionWorkspaces.get(sessionId)
  if (named !== undefined) return named
  return (await sessionEnv(self, sessionId))?.path
}

export function contractRefusal(parentTaskId: TaskId, reasons: readonly string[]): Error {
  return new Error(`task-runtime: contract rejected decomposition of "${parentTaskId}":\n- ${reasons.join('\n- ')}`)
}

export async function orchestrateEnv(
  self: TaskRuntime,
  callerSessionId: string,
  actor: string,
  workspace?: string,
  replayOverlay?: ReplayOverlay,
): Promise<OrchestrateEnv> {
  /**
   * A session this process already spawned into a named workspace keeps
   * working in it: the replay's own decomposition builds its env here, and the
   */
  const named = workspace ?? self.sessionWorkspaces.get(callerSessionId)
  const workspacePath = named ?? (await self.workspacePathForSession(callerSessionId))
  /**
   * …and it keeps running under what it was spawned under (S4-E §Q3): the frozen
   * model selection of the experiment it belongs to. The same session-level
   */
  const binding = self.sessionExecutionBindings.get(callerSessionId)
  const overlay = replayOverlay ?? binding?.overlay
  const table = { ...self.config.capabilities, ...overlay?.capabilityOverrides }
  const mcpRegistry = { ...self.config.mcpServers, ...overlay?.mcpServers }
  return {
    task: self.context.task,
    actor,
    ...(self.config.defaultPreset !== undefined ? { defaultPreset: self.config.defaultPreset } : {}),
    ...(self.config.runBindingRoot === undefined ? {} : { runBindingRoot: self.config.runBindingRoot }),
    verifyTimeoutMs: self.config.verifyTimeoutMs,
    budget: { ...self.config.budget },
    allowRuntimeDecomposition: self.config.allowRuntimeDecomposition,
    gate: self.executionGate,
    workspaces: self.workspaces,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(named === undefined ? {} : { workerCwd: named }),
    ...(binding?.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: binding.taskTemplatesRoot }),
    ...(binding?.agentOptions === undefined ? {} : { agentOptions: binding.agentOptions }),
    writeDrainTimeoutMs: self.config.writeDrainTimeoutMs,
    ...(self.config.rootBudget === undefined ? {} : { rootBudget: { ...self.config.rootBudget } }),
    precheck: (capabilities, cwd) => providerPrecheck(self, capabilities, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(overlay?.extraSkillRoots === undefined ? {} : { extraRoots: [...overlay.extraSkillRoots] }),
    }, table, mcpRegistry),
    notify: (sessionId, text) => {
      self.notify(sessionId, text)
    },
    watchRun: (storeId, runId, callback) => watchRun(self, storeId, runId, callback),
    agentFor: sessionId => agentOrUndefined(self, sessionId),
    jobs: self.softService<JobsView>('jobs'),
    /**
     * What every settled run leaves behind (the gate closes, the workspace
     * layer comes off) is the runtime's own bookkeeping, shared with the
     */
    onRunSettled: (storeId, taskId, runId, status) => {
      self.runSettledFromRuntime(storeId, taskId, runId, status)
    },
    failBatch: (storeId, batchId, reason) => self.failBatch(storeId, batchId, reason),
    deliverBatchResult: message => self.deliverBatchResult(message),
    assertPreset: async preset => {
      // The same registry agentRuntime.spawn mounts through; absent only in test contexts.
      const presets = (self.context.get?.('agentPresets') ??
        (self.context as unknown as { agentPresets?: AgentPresetRegistry }).agentPresets) as
        AgentPresetRegistry | undefined
      if (presets === undefined) return
      await presets.resolve(preset)
    },
    resolvePermissionSpec: name => {
      // The same registry agentRuntime.spawn switches through; absent only in test contexts.
      const presets = (self.context.get?.('permissionPresets') ??
        (self.context as unknown as { permissionPresets?: PermissionPresetRegistry }).permissionPresets) as
        PermissionPresetRegistry | undefined
      if (presets === undefined)
        throw new Error('task-runtime: permissionPresets service is not loaded; cannot rank declared permissions')
      return presets.resolve(name)
    },
    mcpRegistry,
    resolveMcpEnv: async () => {
      /**
       * The same graph env the verifier's cwd comes from; absent in test
       * contexts and in deployments without env-builder — a capability that
       */
      const env = await sessionEnv(self, callerSessionId)
      if (env === undefined) return undefined
      /**
       * A named workspace stands in for the env root: a server this run's
       * capability grants works in the checkout the worker works in, not in
       */
      const root = named ?? env.path
      return {
        envRoot: root,
        checkout: repo => {
          const component = (env.components ?? []).find(item => item.repo === repo)
          return component === undefined ? undefined : join(root, component.dir)
        },
      }
    },
    spawn: request => {
      const parent = liveAgent(self, callerSessionId)
      /**
       * The session this spawn creates works where the spawn says it does, and
       * this process remembers it for as long as the run behind it: an
       */
      const sessionWorkspace = request.cwd ?? named
      if (sessionWorkspace !== undefined) self.sessionWorkspaces.set(request.sessionId, sessionWorkspace)
      /**
       * What the session *runs under* is remembered the same way (S4-E §Q3): a
       * replay's worker carries the experiment's frozen selection, and the
       */
      const taskTemplatesRoot = request.taskTemplatesRoot ?? binding?.taskTemplatesRoot
      const agentOptions = request.agentOptions ?? binding?.agentOptions
      if (agentOptions !== undefined || taskTemplatesRoot !== undefined || overlay !== undefined) {
        self.sessionExecutionBindings.set(request.sessionId, {
          ...(agentOptions === undefined ? {} : { agentOptions }),
          ...(taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot }),
          ...(overlay === undefined ? {} : { overlay: structuredClone(overlay) }),
        })
      }
      return self.context.agentRuntime.spawn(parent, {
        sessionId: SessionId(request.sessionId),
        name: request.name,
        ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
        ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
        ...(request.permissionPreset !== undefined ? { permissionPreset: request.permissionPreset } : {}),
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        /**
         * The agent runtime merges this over the deployment's default selection,
         * which is the whole point of carrying it: the worker's loop is created on
         */
        ...(request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {}),
        ...(request.grant !== undefined ? { grant: request.grant } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })
    },
    /**
     * The recovery pass's own door into a worker's Session (A4 §F.1): one
     * implementation for the store pass and the batch driver's adoption,
     */
    resumeWorkerSession: request => self.resumeAdoptedWorkerSession(request),
    verifyRun: async (storeId, runId, options = {}) => {
      const verifier = runVerifier(self)
      if (verifier === undefined || typeof verifier.verifyRun !== 'function') {
        throw new VerifierUnavailableError(
          `task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`,
        )
      }
      const cwd = named ?? (await envPathForSession(self, callerSessionId))
      return verifier.verifyRun(storeId, runId, { ...(cwd === undefined ? {} : { cwd }), ...options })
    },
    readLogTail: async logRef => runVerifier(self)?.logTail?.(logRef),
    observeSession: async sessionId => observeSession(self, sessionId),
    onTerminalReview: fact => self.notifyTerminalReview(fact),
    onRunBound: (sessionId, binding) => {
      self.sessions.set(sessionId, binding)
      self.startedSessions.add(sessionId)
    },
  }
}

export function watchRun(
  self: TaskRuntime,
  storeId: string,
  runId: RunId,
  callback: (status: RunStatus) => void,
): () => void {
  const listeners: Array<() => void> = []
  const notifyFrom = async (snapshot: TaskSnapshot): Promise<void> => {
    const run = snapshot.runs.find(candidate => candidate.runId === runId)
    if (run === undefined || run.status === 'running') return
    callback(run.status)
  }
  try {
    const off = self.context.on('task/change', (snapshot: TaskSnapshot) => {
      if (snapshot.id !== storeId) return
      void notifyFrom(snapshot)
    })
    if (typeof off === 'function') listeners.push(off)
  } catch (error) {
    self.warn(`cannot subscribe to task/change for store ${storeId}: ${message(error)}`)
  }
  void (async () => {
    try {
      await notifyFrom(await self.context.task.snapshotIn(storeId))
    } catch {
      // A store that cannot be read here is reported by the caller's own wait
      // (the terminal read it does first), not by this observer.
    }
  })()
  return () => {
    for (const off of listeners) off()
  }
}

export function sessionBoundInProcess(self: TaskRuntime, storeId: string, runId: RunId): string | undefined {
  for (const [sessionId, binding] of self.sessions) {
    if (binding.storeId === storeId && binding.runId === runId) return sessionId
  }
  return undefined
}

export async function releaseRunWorkspaceLayer(
  self: TaskRuntime,
  storeId: string,
  runId: RunId,
  sessionId: string,
): Promise<void> {
  const workspace = await self.workspacePathForSession(sessionId)
  if (workspace === undefined || self.workspaces === undefined) return
  await releaseLayer(
    self.workspaces,
    workspace,
    top => top.kind === 'run' && top.storeId === storeId && top.runId === runId,
  )
}

export async function observeSession(self: TaskRuntime, sessionId: string): Promise<SessionObservation | undefined> {
  const tokens = sessionTokens(self, sessionId)
  const events = await sessionEvents(self, sessionId)
  if (tokens === undefined && events === undefined) return undefined

  const calls = new Map<string, number>()
  const humanCallIds: string[] = []
  const approvalCallIds = new Set<string>()
  const skillCalls: string[] = []
  const requestedSkills = new Map<string, string>()
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
        if (skill !== undefined) requestedSkills.set(String(event.data.callId), skill)
      }
    } else if (event.type === 'tool/result') {
      if (toolResultFailed(event.data)) failures += 1
      else if (event.data.message !== undefined) {
        const skill = requestedSkills.get(String(event.data.message.source.callId))
        if (skill !== undefined) skillCalls.push(skill)
      }
    } else if (event.type === 'approval/asked') {
      approvals += 1
      if (typeof event.data.callId === 'string') approvalCallIds.add(event.data.callId)
    } else if ((event.type as string) === 'compaction/start') {
      // Written by the compaction plugin, whose event map this package does not load.
      compactions += 1
    }
  }

  const tools =
    events === undefined
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

export function sessionTokens(self: TaskRuntime, sessionId: string): ReviewTokenUsage | undefined {
  const sessions = self.softService<LiveSessionLookup>('sessions')
  const projections = self.softService<SessionProjectionSource>('sessionProjections')
  if (sessions === undefined || projections === undefined) return undefined
  try {
    const session = sessions.get(SessionId(sessionId))
    if (session === undefined) return undefined
    return tokenUsageOf(projections.snapshot(session as never, ['tokenUsage']).values.tokenUsage)
  } catch {
    return undefined
  }
}

export async function sessionEvents(
  self: TaskRuntime,
  sessionId: string,
): Promise<readonly SessionEvent[] | undefined> {
  const query = self.softService<SessionLogSource>('sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') return undefined
  try {
    return (await query.readSession(SessionId(sessionId))).events
  } catch {
    return undefined
  }
}

export function softService<T>(self: TaskRuntime, name: string): T | undefined {
  return optionalService<T>(self.context, name)
}

export function runVerifier(self: TaskRuntime): RunVerifier | undefined {
  return self.softService<RunVerifier>('verifier')
}

export async function registeredVerifierIdsImpl(self: TaskRuntime): Promise<readonly string[] | undefined> {
  return registeredVerifierIds(self.context)
}

export async function providerPrecheck(
  self: TaskRuntime,
  capabilities: readonly string[],
  view: SkillDiscoveryView,
  table: Readonly<Record<string, CapabilityConfig>> = self.config.capabilities,
  mcpRegistry: Readonly<Record<string, McpServerTemplate>> = self.config.mcpServers ?? {},
): Promise<ProviderPrecheck> {
  const verifierRefs = await registeredVerifierIdsImpl(self)
  const commitLedger = self.softService<EvolutionCommitLedger>('evolution')
  return precheckProviders({
    capabilities,
    table,
    mcpRegistry,
    view,
    ...(verifierRefs === undefined ? {} : { verifierRefs }),
    ...(commitLedger === undefined ? {} : { commitLedger }),
  })
}

export async function capabilityProviderReport(
  self: TaskRuntime,
  sessionId: string,
  capabilities?: readonly string[],
): Promise<ProviderPrecheck> {
  const envPath = await envPathForSession(self, sessionId)
  return providerPrecheck(self, capabilities ?? Object.keys(self.config.capabilities), {
    ...(envPath === undefined ? {} : { cwd: envPath }),
  })
}

export async function readRunBindingImpl(binding: RunProviderBinding): Promise<RunBindingRead | undefined> {
  return readRunBinding(binding)
}

export async function assertKnownVerifierRefs(
  self: TaskRuntime,
  declared: readonly { childIndex: number; criterion: AcceptanceCriterion }[],
  what: string,
): Promise<void> {
  const refs = declared.filter(item => item.criterion.verifierRef !== undefined)
  if (refs.length === 0) return
  const registered = await registeredVerifierIdsImpl(self)
  if (registered === undefined) {
    throw new VerifierUnavailableError(
      `task-runtime: cannot validate verifierRef on ${what}: the verifier service is not loaded or cannot list its registry`,
    )
  }
  const unknown = refs.filter(item => !registered.includes(item.criterion.verifierRef as string))
  const verifier = runVerifier(self)
  const unsupported = refs.filter(item => verifier?.verifierSupports?.(
    item.criterion.verifierRef as string, item.criterion.verificationMode,
  ) === false && registered.includes(item.criterion.verifierRef as string))
  if (unknown.length === 0 && unsupported.length === 0) return
  const detail = unknown
    .map(
      item =>
        `child ${item.childIndex} criterion "${item.criterion.criterionId}" references unknown verifier "${item.criterion.verifierRef}"`,
    )
    .join('; ')
  const unsupportedDetail = unsupported.map(item =>
    `child ${item.childIndex} criterion "${item.criterion.criterionId}" verifier "${item.criterion.verifierRef}" does not support mode "${item.criterion.verificationMode}"`,
  ).join('; ')
  throw new Error(`task-runtime: admission rejected ${what}: ${[detail, unsupportedDetail].filter(Boolean).join('; ')}; registered verifiers: ${registered.join(', ')}`)
}

export function liveAgent(self: TaskRuntime, sessionId: string): Agent {
  const agent = agentOrUndefined(self, sessionId)
  if (agent === undefined) {
    throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`)
  }
  return agent
}

export function agentOrUndefined(self: TaskRuntime, sessionId: string): Agent | undefined {
  const registry = self.softService<{ get(id: string): Agent | undefined }>('agents')
  if (registry === undefined) return undefined
  try {
    return registry.get(sessionId)
  } catch {
    return undefined
  }
}
