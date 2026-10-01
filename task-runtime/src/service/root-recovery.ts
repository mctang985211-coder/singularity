/**
 * Root recovery: caller checks, attempt identity and recovery status.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GraphRecord } from '@dangosys/dsh-singularity-graphs'
import type {
  RunId,
  RunMemberReuseRefusal,
  RunProviderBinding,
  RunRecovery,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { canonicalize, rootTaskStoreId, runMemberSlots } from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, resolvePreset } from '../capability.ts'
import { providerRefusals } from '../provider-precheck.ts'
import { checkRunStart, hasRootLimits, resolveRootBudget } from '../root-budget.ts'
import { bindRunProviders } from '../run-binding.ts'
import { settleRunFromRuntime } from '../orchestration/settlement.ts'
import { spawnTaskWorker } from '../orchestration/spawn.ts'
import {
  deriveReuse,
  inFlightRecoveryAttempt,
  recoveryAttemptDigest,
  recoveryAttemptWithKey,
  recoveryRequestDefects,
  requestAttemptDigest,
  reuseDefects,
  storedReuse,
} from '../recovery.ts'
import type { ReuseContext, RootRecoveryRequest } from '../recovery.ts'
import type { WorkspaceOwner } from '../workspace.ts'
import type {
  StoreRecoveryStatus,
  RootRecoveryCaller,
  RootRecoveryOutcome,
  StartRecoveryAttemptInput,
} from '../types.ts'
import { message, now } from '../helpers.ts'

export async function recoverRootTask(
  self: TaskRuntime,
  storeId: string,
  request: RootRecoveryRequest,
  caller: RootRecoveryCaller,
): Promise<RootRecoveryOutcome> {
  const defects = recoveryRequestDefects(request)
  if (defects.length > 0) {
    throw new Error(`task-runtime: the recovery request was refused:\n- ${defects.join('\n- ')}`)
  }
  if (typeof caller?.sessionId !== 'string' || caller.sessionId.trim().length === 0) {
    throw new Error(
      'task-runtime: a recovery attempt is opened for the session that asks for it: pass a non-empty caller session id',
    )
  }
  if (self.agentOrUndefined(caller.sessionId) === undefined) {
    throw new Error(
      `task-runtime: caller session "${caller.sessionId}" has no live agent, so the new attempt's Session cannot be spawned from it; ` +
        'nothing was written and no run was started',
    )
  }
  await assertRecoveryCallerOwnsStore(self, storeId, caller)
  await assertRecoveryReady(self, storeId, 'a recovery attempt')
  return await self.serializeRootIntake(storeId, () => recoverRootTaskOnce(self, storeId, request, caller))
}

export async function assertRecoveryCallerOwnsStore(
  self: TaskRuntime,
  storeId: string,
  caller: RootRecoveryCaller,
): Promise<void> {
  const sessionId = caller.sessionId
  const graphs: { graphForSession(sessionId: SessionId): Promise<GraphRecord> } | undefined = self.context.graphs
  if (graphs === undefined) {
    throw new Error(
      `task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": this deployment has no graph registry, ` +
        'so its ownership of this store cannot be established; nothing was written',
    )
  }
  let graph: GraphRecord
  try {
    graph = await graphs.graphForSession(SessionId(sessionId))
  } catch (error) {
    throw new Error(
      `task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": its graph could not be resolved ` +
        `(${message(error)}), so its ownership of this store cannot be established; nothing was written`,
    )
  }
  const ownStoreId = rootTaskStoreId(graph.rootSessionId)
  if (ownStoreId !== storeId) {
    throw new Error(
      `task-runtime: session "${sessionId}" cannot open a recovery of store "${storeId}": its graph's root session is "${graph.rootSessionId}", ` +
        `whose store is "${ownStoreId}" — a recovery attempt is opened in the store of the caller's own graph, and nothing was written`,
    )
  }
}

export async function recoverRootTaskOnce(
  self: TaskRuntime,
  storeId: string,
  request: RootRecoveryRequest,
  caller: RootRecoveryCaller,
): Promise<RootRecoveryOutcome> {
  // The serialized section carries the same ownership rule as the public
  // entry above: whatever reaches this function meets it.
  await assertRecoveryCallerOwnsStore(self, storeId, caller)
  const sourceTaskId = request.sourceTaskId
  const snapshot = await self.context.task.snapshotIn(storeId)
  const source = snapshot.tasks.find(task => task.taskId === sourceTaskId)
  if (source === undefined) {
    throw new Error(
      `task-runtime: store "${storeId}" holds no task "${sourceTaskId}", so there is nothing to recover; ` +
        'a recovery is asked of the store that owns the failed task',
    )
  }
  if (source.parentTaskId !== undefined) {
    throw new Error(
      `task-runtime: task "${sourceTaskId}" is a child of "${source.parentTaskId}"; a recovery attempt is opened for the store's own root task, ` +
        'and a child is re-run by a batch of its parent instead',
    )
  }
  const answered = recoveryAttemptForRequest(snapshot, request)
  if (answered !== undefined) return answered
  const diagnosis = (snapshot.diagnoses ?? []).find(item => item.diagnosisId === request.sourceDiagnosisId)
  if (diagnosis === undefined) {
    throw new Error(
      `task-runtime: store "${storeId}" holds no diagnosis "${request.sourceDiagnosisId}"; a recovery is asked for by a diagnosis of this store ` +
        'and by nothing else, so this hand-off names no fact here',
    )
  }
  if (diagnosis.taskId !== sourceTaskId) {
    throw new Error(
      `task-runtime: diagnosis "${request.sourceDiagnosisId}" is about task "${diagnosis.taskId}", not the named source "${sourceTaskId}"; ` +
        'the hand-off and the store disagree about which task failed, and nothing was written',
    )
  }
  const inFlight = inFlightRecoveryAttempt(snapshot, sourceTaskId, request.sourceDiagnosisId)
  if (inFlight !== undefined) {
    throw new Error(
      `task-runtime: diagnosis "${request.sourceDiagnosisId}" already has a recovery attempt in flight (run "${inFlight.runId}", ` +
        `session "${inFlight.sessionId}", key "${inFlight.recovery?.requestKey ?? 'unknown'}"); key "${request.requestKey}" starts nothing — ` +
        'an attempt ends when its run settles, and a new key may be asked for after that',
    )
  }
  if (source.status === 'verified') {
    throw new Error(
      `task-runtime: root task "${sourceTaskId}" is verified — a successful source is not recoverable, and nothing was written; ` +
        'an improvement on a succeeded goal needs a new intake under its own contract, not a recovery of this one',
    )
  }
  if (source.status === 'running' || source.status === 'verifying') {
    throw new Error(
      `task-runtime: root task "${sourceTaskId}" is ${source.status}: an attempt is in flight, and a recovery does not hot-swap a live run`,
    )
  }
  if (source.status !== 'failed' && source.status !== 'blocked') {
    throw new Error(
      `task-runtime: root task "${sourceTaskId}" is ${source.status}; a recovery attempt is opened for a failed task ` +
        '(a `failed` task, or a `blocked` one that never ran), and this is not one',
    )
  }
  const sourceRun = recoverySourceRun(source, request, snapshot)
  assertRecoveryContract(source)
  /**
   * The binding comes from the store, not from the caller: a request that names
   * no reuse gets the citations the failed run's own facts support, and the
   */
  const reuseContext: ReuseContext = {
    source,
    ...(sourceRun === undefined ? {} : { sourceRun }),
    sourceMembers: sourceRun === undefined ? [] : runMemberSlots(sourceRun),
    snapshot,
  }
  const declared = request.reuses
  const derived = declared === undefined ? deriveReuse(reuseContext) : undefined
  const declarations = declared ?? derived?.bound ?? []
  const reuseReasons = reuseDefects(declarations, reuseContext)
  if (reuseReasons.length > 0) {
    throw new Error(
      `task-runtime: the recovery of "${sourceTaskId}" was refused; the declared reuse does not resolve:\n- ${reuseReasons.join('\n- ')}`,
    )
  }
  const unbound: RunMemberReuseRefusal[] = derived?.unbound ?? []
  const manifest = self.resolveCapabilities(source.requestedCapabilities)
  if (manifest.missing.length > 0) {
    throw new Error(
      `task-runtime: the recovery of "${sourceTaskId}" was refused: the capability gap this attempt is for is still open ` +
        `([${manifest.missing.join(', ')}] resolve to no row in this deployment's table); apply the row that closes it, and the recovery ` +
        're-reads what the deployment holds then — nothing was written',
    )
  }
  const rootSessionId = sourceRun?.sessionId ?? self.recoverySessionFor(snapshot, storeId)
  const envPath = await self.envPathForSession(rootSessionId)
  const precheck = await self.providerPrecheck(Object.keys(manifest.capabilities), {
    ...(envPath === undefined ? {} : { cwd: envPath }),
  })
  const refusals = providerRefusals(precheck)
  if (refusals.length > 0) {
    throw new Error(
      `task-runtime: the recovery of "${sourceTaskId}" was refused by the provider pre-check:\n- ${refusals.join('\n- ')}`,
    )
  }
  const budget = resolveRootBudget(snapshot, self.config.rootBudget ?? {})
  if (!budget.ok) {
    if (hasRootLimits(self.config.rootBudget)) {
      throw new Error(
        `task-runtime: the recovery of "${sourceTaskId}" was refused: the root budget cannot be resolved: ${budget.reason}`,
      )
    }
  } else {
    const verdict = checkRunStart(snapshot, budget)
    if (!verdict.allowed) {
      throw new Error(
        `task-runtime: the recovery of "${sourceTaskId}" was refused by the root budget: ${verdict.reason}; ` +
          'the ceiling is not raised by this entry and no count is reset — a person raises it through the budget-extension entry',
      )
    }
  }
  return await startRecoveryAttempt(self, {
    storeId,
    source,
    request,
    declarations,
    unbound,
    manifest,
    precheck,
    rootSessionId,
    actor: caller.sessionId,
    ...(caller.signal === undefined ? {} : { signal: caller.signal }),
  })
}

export function recoveryAttemptForRequest(
  snapshot: TaskSnapshot,
  request: RootRecoveryRequest,
): RootRecoveryOutcome | undefined {
  const existing = recoveryAttemptWithKey(snapshot, request.sourceTaskId, request.requestKey)
  if (existing === undefined) return undefined
  const stored = existing.recovery as RunRecovery
  /**
   * The key is bound to the *request*, not to the binding it produced: a
   * request that names no reuse has its citations derived from the store (a
   */
  const digest = stored.requestDigest ?? recoveryAttemptDigest(stored)
  const wanted = requestAttemptDigest(request)
  if (digest !== wanted) {
    throw new Error(
      `task-runtime: request key "${request.requestKey}" already names a recovery attempt of "${request.sourceTaskId}" ` +
        `(run "${existing.runId}", session "${existing.sessionId}", request ${digest}); this request's content is ${wanted} — ` +
        'one key names one request, and a different request is a different key',
    )
  }
  return {
    attempt: 'existing',
    storeId: snapshot.id,
    sourceTaskId: request.sourceTaskId,
    sourceDiagnosisId: stored.sourceDiagnosisId,
    requestKey: stored.requestKey,
    runId: existing.runId,
    sessionId: existing.sessionId,
    status: existing.status,
    reusedMembers: stored.reusedMembers.map(member => ({
      ...member,
      artifactRefs: [...member.artifactRefs],
      inputRefs: [...member.inputRefs],
    })),
    unboundMembers: (stored.unboundMembers ?? []).map(entry => ({ ...entry, reasons: [...entry.reasons] })),
    detail:
      `request key "${stored.requestKey}" already named this recovery attempt: run "${existing.runId}" is ${existing.status}` +
      `${existing.finishedAt === undefined ? '' : ` (finished ${existing.finishedAt})`}; nothing was written`,
  }
}

export function recoverySourceRun(
  source: TaskInstance,
  request: RootRecoveryRequest,
  snapshot: TaskSnapshot,
): TaskRun | undefined {
  if (request.sourceRunId !== null) {
    const run = snapshot.runs.find(candidate => candidate.runId === request.sourceRunId)
    if (run === undefined) {
      throw new Error(
        `task-runtime: store "${snapshot.id}" holds no run "${request.sourceRunId}"; the named source attempt does not exist`,
      )
    }
    if (run.taskId !== source.taskId) {
      throw new Error(
        `task-runtime: run "${run.runId}" belongs to task "${run.taskId}", not to the named source "${source.taskId}"; nothing was written`,
      )
    }
    if (run.status !== 'failed') {
      throw new Error(
        `task-runtime: source run "${run.runId}" is ${run.status}; a recovery recovers a *failed* attempt ` +
          '(its run settled `failed`), and this run is not one',
      )
    }
    return run
  }
  const running = snapshot.runs.filter(run => run.taskId === source.taskId && run.status === 'running')
  if (running.length > 0) {
    throw new Error(
      `task-runtime: the request names no source run, but task "${source.taskId}" holds a run in flight (${running.map(run => run.runId).join(', ')}); ` +
        'a failure without a run is a task that never started, not one an attempt is running for',
    )
  }
  return undefined
}

export function assertRecoveryContract(source: TaskInstance): void {
  const contract = source.contract
  if (contract === undefined) {
    throw new Error(
      `task-runtime: task "${source.taskId}" carries no contract, so its original acceptance cannot be read; ` +
        'a recovery binds its reuse to that acceptance, and nothing is guessed for a task that has none',
    )
  }
  const disagreement =
    contract.objective !== source.objective
      ? 'its objective'
      : canonicalize(contract.acceptanceCriteria) !== canonicalize(source.acceptanceCriteria)
        ? 'its acceptance criteria'
        : canonicalize(contract.requiredCapabilities) !== canonicalize(source.requestedCapabilities)
          ? 'its required capabilities'
          : undefined
  if (disagreement !== undefined) {
    throw new Error(
      `task-runtime: task "${source.taskId}"'s contract and its projection disagree on ${disagreement}; ` +
        'the original contract and acceptance criteria have to be one record before an attempt can be bound to them',
    )
  }
  if (source.acceptanceCriteria.length === 0) {
    throw new Error(
      `task-runtime: task "${source.taskId}" declares no acceptance criterion, so there is nothing the new attempt could be judged by`,
    )
  }
}

export async function startRecoveryAttempt(
  self: TaskRuntime,
  input: StartRecoveryAttemptInput,
): Promise<RootRecoveryOutcome> {
  const { storeId, source, request, declarations, manifest, rootSessionId, actor } = input
  const runId: RunId = `r-${randomUUID()}`
  const sessionId = `s-${randomUUID()}`
  const reusedMembers = declarations.map(storedReuse)
  const recovery: RunRecovery = {
    sourceDiagnosisId: request.sourceDiagnosisId,
    requestKey: request.requestKey,
    ...(request.sourceRunId === null ? {} : { sourceRunId: request.sourceRunId }),
    requestedAt: now(),
    requestDigest: requestAttemptDigest(request),
    reusedMembers,
    ...(input.unbound.length === 0
      ? {}
      : { unboundMembers: input.unbound.map(entry => ({ ...entry, reasons: [...entry.reasons] })) }),
  }
  /**
   * The preset the worker will be mounted on, resolved once: the run records it
   * so a resume rebuilds the same composition rather than the deployment's
   */
  const preset = resolvePreset(manifest, self.config.defaultPreset)
  const workspacePath = await self.workspacePathForSession(rootSessionId)
  let claimed: WorkspaceOwner | undefined
  if (workspacePath !== undefined && self.workspaces !== undefined) {
    await self.workspaces.claim(workspacePath, { kind: 'run', storeId, taskId: source.taskId, runId, since: now() })
    claimed = self.workspaces.ownerOf(workspacePath)
  }
  let binding: RunProviderBinding | undefined
  try {
    binding = await bindRunProviders({
      storeId,
      runId,
      manifest,
      providers: input.precheck,
      table: self.config.capabilities,
      root: self.config.runBindingRoot,
    })
    const run: TaskRun = {
      runId,
      taskId: source.taskId,
      sessionId,
      capabilitySnapshot: capabilitySnapshot(manifest),
      ...(preset === undefined ? {} : { agentPreset: preset }),
      ...(binding === undefined ? {} : { providerBinding: binding }),
      // Born active, exactly as a first attempt is (§1.1): the new attempt
      // decides its own work — it may decompose, and it must submit.
      executionPhase: 'active',
      recovery,
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: now(),
    }
    await self.context.task.startRunIn(storeId, run, actor, { manifest })
    self.sessions.set(sessionId, { storeId, taskId: source.taskId, runId })
    self.startedSessions.add(sessionId)
    self.executionGate.setPhase(sessionId, 'active')
    if (workspacePath !== undefined) self.sessionWorkspaces.set(sessionId, workspacePath)
  } catch (error) {
    if (workspacePath !== undefined && claimed !== undefined) {
      await self.workspaces?.release(workspacePath, claimed).catch(cause => {
        self.warn(`workspace ${workspacePath} could not be released after a refused attempt (${message(cause)})`)
      })
    }
    throw error
  }
  /**
   * From here the attempt is a durable fact. A spawn that fails is settled on
   * the run, never left as a running attempt nothing drives.
   */
  try {
    await spawnTaskWorker(await self.orchestrateEnv(actor, actor, workspacePath), {
      sessionId,
      name: `recovery of ${source.objective.trim().replace(/\s+/g, ' ').slice(0, 32) || source.taskId}`,
      manifest,
      ...(binding === undefined ? {} : { providerBinding: binding }),
      ...(preset === undefined ? {} : { agentPreset: preset }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch (error) {
    const reason = message(error)
    const env = await self.orchestrateEnv(actor, actor, workspacePath)
    const failed = await self.context.task.snapshotIn(storeId).catch(() => undefined)
    const run = failed?.runs.find(item => item.runId === runId)
    if (run !== undefined && run.status === 'running') {
      await settleRunFromRuntime(
        env,
        storeId,
        run,
        'failed',
        `the recovery attempt's worker could not be spawned: ${reason}`,
      )
    }
    if (workspacePath !== undefined && claimed !== undefined) {
      await self.workspaces?.release(workspacePath, claimed).catch(cause => {
        self.warn(`workspace ${workspacePath} could not be released after a failed spawn (${message(cause)})`)
      })
    }
    throw new Error(
      `task-runtime: the recovery attempt of "${source.taskId}" was opened (run "${runId}", session "${sessionId}") but its worker could not be ` +
        `spawned: ${reason}; the attempt's run was settled failed with this cause, and a new attempt needs a new request key`,
    )
  }
  const stored = (await self.context.task.snapshotIn(storeId)).runs.find(item => item.runId === runId)
  return {
    attempt: 'started',
    storeId,
    sourceTaskId: source.taskId,
    sourceDiagnosisId: request.sourceDiagnosisId,
    requestKey: request.requestKey,
    runId,
    sessionId,
    status: stored?.status ?? 'running',
    reusedMembers,
    unboundMembers: input.unbound.map(entry => ({ ...entry, reasons: [...entry.reasons] })),
    detail:
      `a recovery attempt of "${source.taskId}" was opened: run "${runId}" in session "${sessionId}" under diagnosis ` +
      `"${request.sourceDiagnosisId}", key "${request.requestKey}"` +
      `${reusedMembers.length === 0 ? '' : `, reading ${reusedMembers.length} already verified sibling member(s) at the position(s) ${reusedMembers.map(member => member.childIndex).join(', ')}`}` +
      `${input.unbound.length === 0 ? '' : `; ${input.unbound.length} position(s) whose passed sibling could not be bound (${input.unbound.map(entry => `#${entry.childIndex}`).join(', ')}) are done again and the reasons are on the record`}; ` +
      'the original acceptance criteria judge it, and the store total it spends is the same one',
  }
}

export function invalidateStoreRecovery(self: TaskRuntime, storeId: string): void {
  const state = self.storeRecovery.get(storeId)
  if (state === undefined) return
  if (state.status === 'recovering') {
    state.cancelled = true
    self.standDownPendingDrivers(state)
    state.release(false)
  } else {
    self.storeRecovery.delete(storeId)
  }
}

export async function recoveryStatus(self: TaskRuntime, storeId: string): Promise<StoreRecoveryStatus> {
  const state = self.storeRecovery.get(storeId)
  if (state !== undefined) {
    if (state.status === 'recovering') return { status: 'recovering' }
    if (state.status === 'failed')
      return { status: 'recovery-failed', reason: state.reason ?? 'the recovery barrier failed' }
    return { status: 'ready' }
  }
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.openStore(storeId)
  } catch (error) {
    return { status: 'not-activated', reason: message(error) }
  }
  for (const run of snapshot.runs) {
    if (run.status !== 'running') continue
    /**
     * Live work, not recovery's: a session this process started, or a session
     * whose agent is live here (a resumed root, a spawned worker still in its
     */
    if (self.startedSessions.has(run.sessionId)) continue
    if (self.agentOrUndefined(run.sessionId) !== undefined) continue
    if (run.batchId !== undefined && self.drivers.has(`${storeId}/${run.batchId}`)) continue
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

export async function assertRecoveryReady(self: TaskRuntime, storeId: string, entry: string): Promise<void> {
  const readiness = await recoveryStatus(self, storeId)
  if (readiness.status === 'ready' || readiness.status === 'not-activated') return
  const because =
    readiness.status === 'recovering'
      ? "its recovery barrier is still running; retry once the graph's activation completes"
      : readiness.status === 'recovery-failed'
        ? `the last recovery failed: ${readiness.reason}; an explicit activation (adoptRoot) retries it`
        : readiness.status === 'needs-recovery'
          ? `${readiness.reason}; only reading and cancelling are allowed`
          : `${readiness.reason}; await the graph's activation or adoptRoot before executing against this store`
  throw new Error(
    `task-runtime: ${entry} on store "${storeId}" is refused: the store is ${readiness.status} — ${because}`,
  )
}
