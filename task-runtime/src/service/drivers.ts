/**
 * Batch drivers: registration, submission, cancellation and store reconciliation.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import type { RunId, RunStatus, SubmissionRecord, TaskId, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId, runMemberTaskIds } from '@dangosys/dsh-singularity-task'
import { blockUnstartedChildren, deriveChildOutcomes } from '../orchestration/child.ts'
import { driveBatch, settleSubmittedRun } from '../orchestration/batch.ts'
import { batchEndMessageId, owedBatchResults } from '../orchestration/observe.ts'
import { missingArtifactReason, missingRequiredArtifacts } from '../orchestration/verify.ts'
import { resumeAdoptedWorker } from '../orchestration/spawn.ts'
import { settleRunFromRuntime } from '../orchestration/settlement.ts'
import type { BatchContext, ChildOutcome, OrchestrateEnv, RuntimeSettlementEnv } from '../orchestration/types.ts'
import {
  pendingQuestionMessages,
  reconcileQuestionDeliveries,
  releaseAskingSessions,
  type QuestionReconcileReport,
} from '../question.ts'
import type { StoreRecoveryState } from '../config.ts'
import type { QuestionResumeReport, ReconcileReport, StartBatchDriverOptions } from '../types.ts'
import { message, now } from '../helpers.ts'

export function registerDriver(
  self: TaskRuntime,
  key: string,
  storeId: string,
  controller: AbortController,
  promise: Promise<ChildOutcome[]>,
  parentTaskId?: TaskId,
): void {
  self.drivers.set(key, { controller, promise, storeId, ...(parentTaskId === undefined ? {} : { parentTaskId }) })
  const forget = () => {
    if (self.drivers.get(key)?.controller === controller) self.drivers.delete(key)
  }
  void promise.then(forget, async error => {
    forget()
    const reason = `driver ${key} failed outside its own settlement: ${message(error)}`
    self.warn(reason)
    await failBatchFromRuntime(self, storeId, key, reason)
  })
}

export function standDownPendingDrivers(self: TaskRuntime, state: StoreRecoveryState): void {
  for (const pending of state.pendingDrivers.splice(0)) {
    const entry = self.drivers.get(pending.key)
    if (entry?.controller === pending.controller) self.drivers.delete(pending.key)
    pending.controller.abort()
  }
}

export async function failBatchFromRuntime(
  self: TaskRuntime,
  storeId: string,
  key: string,
  reason: string,
  outcome: 'failed' | 'cancelled' = 'failed',
): Promise<void> {
  const prefix = `${storeId}/`
  if (!key.startsWith(prefix)) return
  const batchId = key.slice(prefix.length)
  const parts = settlementParts(self, `fail-batch:${storeId}`)
  try {
    const found = await batchRecordIn(self, storeId, batchId)
    if (found === undefined) return
    await blockUnstartedChildren(parts, storeId, found.memberTaskIds, reason)
    const parentRun = await self.context.task.runIn(storeId, found.run.runId).catch(() => undefined)
    if (parentRun === undefined || parentRun.status !== 'running') return
    await settleRunFromRuntime(parts, storeId, parentRun, outcome, `batch ${batchId} ${outcome}: ${reason}`)
  } catch (error) {
    self.warn(`store ${storeId}: the failed driver ${key} could not be settled (${message(error)})`)
  }
}

export async function batchRecordIn(
  self: TaskRuntime,
  storeId: string,
  batchId: string,
): Promise<{ taskId: TaskId; run: TaskRun; memberTaskIds: readonly TaskId[] } | undefined> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const found = [...snapshot.runs]
    .reverse()
    .flatMap(run => (run.batches ?? []).map(batch => ({ run, batch })))
    .find(entry => entry.batch.batchId === batchId)
  return found === undefined
    ? undefined
    : { taskId: found.run.taskId, run: found.run, memberTaskIds: [...found.batch.memberTaskIds] }
}

export function batchHeldByRun(run: TaskRun, batchId: string): boolean {
  return run.batches?.some(batch => batch.batchId === batchId) === true
}

export function settlementParts(self: TaskRuntime, actor: string): RuntimeSettlementEnv {
  return {
    task: self.context.task,
    actor,
    notify: (sessionId, text) => {
      self.notify(sessionId, text)
    },
    observeSession: async sessionId => self.observeSession(sessionId),
    budget: { ...self.config.budget },
    onRunSettled: (storeId, taskId, runId, status) => {
      runSettledFromRuntime(self, storeId, taskId, runId, status)
    },
    onTerminalReview: fact => self.notifyTerminalReview(fact),
    sealReceipt: async (storeId, taskId, runId) => {
      await self.sealReceiptBounded(storeId, taskId, runId)
    },
    gate: self.executionGate,
  }
}

export function runSettledFromRuntime(
  self: TaskRuntime,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  status: RunStatus,
): void {
  void taskId
  void status
  const activeSession = self.sessionBoundInProcess(storeId, runId)
  if (activeSession !== undefined) self.activeWorkerSessions.delete(activeSession)
  for (const notify of self.capacityWaiters) notify()
  void recomputeAskingSessions(self, storeId, runId)
  const sessionId = self.sessionBoundInProcess(storeId, runId)
  if (sessionId === undefined) return
  self.executionGate.setTerminal(sessionId)
  const release = self
    .releaseRunWorkspaceLayer(storeId, runId, sessionId)
    .catch(error => {
      self.warn(`run ${runId}: the workspace layer it held could not be released (${message(error)})`)
    })
    /**
     * The workspace this session was spawned into is forgotten once the run
     * behind it is terminal — and only after the release above has resolved,
     */
    .finally(() => {
      if (self.sessionWorkspaces.size > 0) self.sessionWorkspaces.delete(sessionId)
      // What the session ran under (S4-E §Q3) is forgotten with it: a terminal
      // run cannot decompose, so the binding has nothing left to propagate to.
      if (self.sessionExecutionBindings.size > 0) self.sessionExecutionBindings.delete(sessionId)
      self.workspaceReleases.delete(release)
    })
  self.workspaceReleases.add(release)
}

export async function recomputeAskingSessions(self: TaskRuntime, storeId: string, runId: RunId): Promise<void> {
  try {
    releaseAskingSessions(self.executionGate, await self.context.task.snapshotIn(storeId), runId)
  } catch (error) {
    self.warn(
      `store ${storeId}: the question blocks of the runs that asked run "${runId}" could not be recomputed after it settled ` +
        `(${message(error)})`,
    )
  }
}

export function reportUnsettledQuestionDeliveries(
  self: TaskRuntime,
  storeId: string,
  deliveries: readonly QuestionReconcileReport[],
): void {
  const unsettled = deliveries.filter(delivery => delivery.status === 'refused' || delivery.status === 'unavailable')
  if (unsettled.length === 0) return
  const counts = new Map<string, number>()
  for (const delivery of unsettled) counts.set(delivery.status, (counts.get(delivery.status) ?? 0) + 1)
  const byStatus = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')
  self.warn(
    `store ${storeId}: ${unsettled.length} of ${deliveries.length} owed question message${deliveries.length === 1 ? '' : 's'} could not be ` +
      `settled (${byStatus}): ${unsettled.map(delivery => `${delivery.subject} [${delivery.status}${delivery.reason === undefined ? '' : `: ${delivery.reason}`}]`).join('; ')}. ` +
      'The Task records still hold these intents, no substitute parent is invented, and the next activation retries them',
  )
}

export function startBatchDriver(self: TaskRuntime, options: StartBatchDriverOptions): void {
  const key = `${options.storeId}/${options.batchId}`
  if (self.drivers.has(key)) return
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
  const barrier = self.storeRecovery.get(options.storeId)
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
    const env = await self.orchestrateEnv(options.callerSessionId, options.callerSessionId)
    return await driveBatch(env, { ...batch, signal: controller.signal })
  })()
  registerDriver(self, key, options.storeId, controller, promise, options.parentTaskId)
}

export async function submitResult(
  self: TaskRuntime,
  callerSessionId: string,
  spec: { summary: string; evidenceRefs?: string[]; notes?: string },
  exec: { callId?: string } = {},
): Promise<{ status: string; detail: string }> {
  if (spec.summary.trim().length === 0) {
    throw new Error('task-runtime: a submission requires a non-empty summary of what was delivered')
  }
  const { storeId, task, run } = await self.runForSession(callerSessionId)
  /**
   * The recovery door comes before the run's own verdicts (A2 §E): a store
   * this process has not recovered is refused by name even when the run
   */
  await self.assertRecoveryReady(storeId, 'a result submission')
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
        'a parent cannot submit while its children are still running — the batch has to end and hand the run back ' +
        'before the parent may hand in its own result',
    )
  }
  if (phase === undefined) {
    throw new Error(
      `task-runtime: run "${run.runId}" predates coordination phases; it cannot submit ` +
        '(needs recovery: cancel this task tree and re-create it)',
    )
  }
  /**
   * A run hands its result in only when the references its own contract
   * declares are satisfied (A6 §F.4: "根最终提交必须检查产物已满足"). The
   */
  const store = await self.context.task.snapshotIn(storeId)
  const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, store)
  if (missingArtifacts.length > 0) {
    for (const missing of missingArtifacts) {
      await self.context.task.recordObligationIn(
        storeId,
        {
          obligationId: `o-${randomUUID()}`,
          goal: `artifact/evidence "${missing.ref}" required by task "${task.taskId}" criterion ${missing.criterionId} does not exist in the task store${missing.requirement === 'requires' ? ' as a verified reference product' : ''}`,
          criterion:
            missing.requirement === 'requires'
              ? `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict`
              : `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id)`,
          sourceTaskId: task.taskId,
        },
        callerSessionId,
      )
    }
    throw new Error(
      `task-runtime: the submission of run "${run.runId}" was refused: ${missingArtifactReason(missingArtifacts)}; ` +
        "the result is not handed in while the contract's own references are unsatisfied — produce or run what closes the gap, then submit",
    )
  }
  const submission: SubmissionRecord = {
    summary: spec.summary,
    evidenceRefs: [...(spec.evidenceRefs ?? [])],
    ...(spec.notes === undefined ? {} : { notes: spec.notes }),
    submittedAt: now(),
    origin: 'worker',
  }
  /**
   * Admission closes first (§3.3): this event is what refuses the next write,
   * the next decomposition and a second submission. The drain that follows is
   */
  await self.context.task.changeRunPhaseIn(storeId, task.taskId, run.runId, callerSessionId, {
    phase: 'submitted',
    submission,
  })
  self.executionGate.setPhase(callerSessionId, 'submitted')
  const env = await self.orchestrateEnv(callerSessionId, callerSessionId)
  const lineage = self.replayLineage.get(task.taskId)
  /**
   * What this receipt is about: a run that admitted batches is judged on them
   * (K1 §4's accumulated membership), so its review record names its members —
   */
  const members = runMemberTaskIds(run)
  const status = await settleSubmittedRun(env, storeId, task.taskId, run.runId, {
    ...(exec.callId === undefined ? {} : { excludeCallId: exec.callId }),
    ...(lineage === undefined ? {} : { anomalies: [lineage] }),
    ...(members.length === 0 ? {} : { relatedTaskIds: members }),
  })
  return {
    status,
    detail:
      status === 'verified'
        ? `run "${run.runId}" submitted and verified.`
        : `run "${run.runId}" submitted and settled ${status}; the terminal review record names why.`,
  }
}

export async function cancelBatch(
  self: TaskRuntime,
  storeId: string,
  batchId: string,
  callerSessionId: string,
): Promise<ChildOutcome[]> {
  if (!batchId.startsWith('b-')) {
    throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`)
  }
  const snapshot = await self.context.task.snapshotIn(storeId)
  const parentRun = [...snapshot.runs].reverse().find(run => run.sessionId === callerSessionId)
  if (parentRun === undefined) {
    throw new Error(
      `task-runtime: batch "${batchId}" cannot be cancelled by session "${callerSessionId}": no run of store "${storeId}" is bound to it`,
    )
  }
  if (parentRun.batchId !== batchId) {
    throw new Error(
      `task-runtime: batch "${batchId}" is not the batch run "${parentRun.runId}" is waiting on ` +
        `(${parentRun.batchId === undefined ? 'it holds no unfinished batch' : `it waits on "${parentRun.batchId}"`}); ` +
        'a batch is cancelled by the run that admitted it, while it is in flight',
    )
  }
  const parentTaskId = parentRun.taskId
  if (parentRun.status !== 'running' || parentRun.executionPhase !== 'waiting_children') {
    throw new Error(
      `task-runtime: batch "${batchId}" is not in flight (its parent run is ${parentRun.status}` +
        `${parentRun.executionPhase === undefined ? '' : ` in phase "${parentRun.executionPhase}"`}); there is nothing to cancel`,
    )
  }
  const entry = self.drivers.get(`${storeId}/${batchId}`)
  if (entry === undefined) {
    throw new Error(
      `task-runtime: batch "${batchId}" is not being driven by this process (it may have settled, or it is waiting for recovery); ` +
        'cancel the graph instead',
    )
  }
  entry.controller.abort()
  /**
   * The abort reaches the batches this one owns as well: a child that
   * decomposed in turn holds a batch of its own, and leaving its driver parked
   */
  await abortDescendantBatches(self, storeId, parentTaskId)
  /**
   * The runs under this batch that are still in flight are settled as cancelled
   * here, rather than left to their aborted drivers: a child inside a
   */
  await settleCancelledDescendants(self, storeId, parentTaskId, batchId, callerSessionId)
  const outcomes = await entry.promise
  /**
   * A driver that never started (a recovery barrier stood it down when this
   * cancellation aborted it) settles nothing itself: the parent run and the
   */
  const parentNow = await self.context.task.runIn(storeId, parentRun.runId).catch(() => undefined)
  if (parentNow !== undefined && parentNow.status === 'running') {
    await failBatchFromRuntime(
      self,
      storeId,
      `${storeId}/${batchId}`,
      `the batch was cancelled by its caller before its driver started: ${batchId}`,
      'cancelled',
    )
  }
  return outcomes
}

export async function settleCancelledDescendants(
  self: TaskRuntime,
  storeId: string,
  taskId: TaskId,
  batchId: string,
  callerSessionId: string,
): Promise<void> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const parentOf = new Map(snapshot.tasks.map(task => [task.taskId, task.parentTaskId] as const))
  const under = (candidate: TaskId): boolean => {
    for (let current = parentOf.get(candidate); current !== undefined; current = parentOf.get(current)) {
      if (current === taskId) return true
    }
    return false
  }
  const runs = snapshot.runs.filter(run => run.status === 'running' && run.taskId !== taskId && under(run.taskId))
  if (runs.length === 0) return
  const env = await self.orchestrateEnv(callerSessionId, `cancel-batch:${batchId}`)
  for (const run of runs) {
    await settleRunFromRuntime(
      env,
      storeId,
      run,
      'cancelled',
      `the batch was cancelled while this child ran: ${batchId}`,
    )
  }
}

export async function abortDescendantBatches(self: TaskRuntime, storeId: string, taskId: TaskId): Promise<void> {
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.snapshotIn(storeId)
  } catch (error) {
    self.warn(
      `store ${storeId}: the batches under "${taskId}" could not be listed (${message(error)}); only the batch itself was aborted`,
    )
    return
  }
  const parentOf = new Map(snapshot.tasks.map(task => [task.taskId, task.parentTaskId] as const))
  const under = (candidate: TaskId): boolean => {
    for (let current = parentOf.get(candidate); current !== undefined; current = parentOf.get(current)) {
      if (current === taskId) return true
    }
    return false
  }
  const entries = [...self.drivers.entries()].filter(([, driver]) => {
    if (driver.storeId !== storeId || driver.parentTaskId === undefined) return false
    return driver.parentTaskId !== taskId && under(driver.parentTaskId)
  })
  for (const [, driver] of entries) driver.controller.abort()
  await Promise.all(entries.map(([, driver]) => driver.promise.catch(() => [])))
}

export async function cancelGraph(self: TaskRuntime, storeId: string, reason: string): Promise<void> {
  try {
    self.reindex(storeId, await self.context.task.snapshotIn(storeId))
  } catch (error) {
    self.warn(
      `store ${storeId}: it could not be read for the cancellation "${reason}" (${message(error)}), so nothing was cancelled`,
    )
    return
  }
  /**
   * The barrier below is in effect before it is durable, so the store is marked
   * as being closed *before* the gate loop: from here until this method returns,
   */
  self.closingStores.add(storeId)
  /**
   * A cancellation invalidates the recovery handle (A2 §E): drivers a still
   * running barrier registered but not started stand down here — not-started
   */
  self.invalidateStoreRecovery(storeId)
  try {
    for (const [sessionId, binding] of self.sessions) {
      if (binding.storeId === storeId) self.executionGate.setTerminal(sessionId)
    }
    const entries = [...self.drivers.values()].filter(entry => entry.storeId === storeId)
    for (const entry of entries) entry.controller.abort()
    await Promise.all(entries.map(entry => entry.promise.catch(() => [])))

    const snapshot = await self.context.task.snapshotIn(storeId)
    const env = await self.orchestrateEnv(await self.sessionForStore(storeId), `cancel-graph:${storeId}`)
    const stillRunning = snapshot.runs.filter(run => run.status === 'running')
    for (const run of stillRunning) {
      await settleRunFromRuntime(env, storeId, run, 'cancelled', `cancelled with the graph: ${reason}`)
    }
    for (const run of stillRunning) await self.reconcileSessionJobs(run.sessionId)
    await self.releaseStoreWorkspace(storeId)
  } finally {
    self.closingStores.delete(storeId)
  }
}

export async function awaitBatch(self: TaskRuntime, storeId: string, batchId: string): Promise<ChildOutcome[]> {
  if (!batchId.startsWith('b-')) {
    throw new Error(`task-runtime: "${batchId}" is not a batch id (a batch id is "b-<parentRunId>-<proposalId>")`)
  }
  const entry = self.drivers.get(`${storeId}/${batchId}`)
  if (entry !== undefined) return await entry.promise
  const found = await batchRecordIn(self, storeId, batchId)
  if (found === undefined) {
    throw new Error(
      `task-runtime: batch "${batchId}" is not recorded in store "${storeId}"; a batch is read from the run that admitted it, never derived from its id`,
    )
  }
  return await deriveChildOutcomes(self.context.task, storeId, found.taskId, found.memberTaskIds)
}

/**
 * Stop a `waiting_children` run whose batch this build cannot name: settle it
 * cancelled by name instead of attributing a batch the store does not record.
 */
async function stopUnidentifiedBatch(
  self: TaskRuntime,
  env: OrchestrateEnv,
  storeId: string,
  run: TaskRun,
): Promise<void> {
  const reason =
    run.batchId === undefined
      ? `recovery: run "${run.runId}" waits on its children but records no batch id, and a batch this build cannot name is not restarted`
      : `recovery: run "${run.runId}" waits on batch "${run.batchId}", which the run's own accumulation does not hold. ` +
        'A batch admitted before batches were identified by (parent run, proposal) is a stopped old state: this build cannot tell which run or which ' +
        'proposal admitted it, so it is not restarted and its ownership is not guessed at — the run is settled cancelled'
  self.warn(`store ${storeId}: ${reason}`)
  await settleRunFromRuntime(env, storeId, run, 'cancelled', reason)
  await self.reconcileSessionJobs(run.sessionId)
}

export async function reconcileStore(self: TaskRuntime, storeId: string, rootSessionId?: string): Promise<ReconcileReport> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  self.reindex(storeId, snapshot)
  const depthOf = (taskId: TaskId): number => snapshot.tasks.find(task => task.taskId === taskId)?.depth ?? 0
  const ordered = snapshot.runs
    .filter(run => run.status === 'running')
    .sort((left, right) => depthOf(right.taskId) - depthOf(left.taskId))
  const env = await self.orchestrateEnv(rootSessionId ?? await self.sessionForStore(storeId), `recovery:${storeId}`)
  /**
   * Every run this pass brings back works in the store's shared checkout, and
   * the mapping its own Session resolves that checkout from is what `spawn`
   * wrote while the process was alive. A restarted process rebuilds it here:
   * without it a resuming worker's own submission is verified against the
   * environment port the graph's checkout was materialized from.
   */
  if (env.workerCwd !== undefined)
    for (const run of ordered)
      if (run.placement === undefined) self.sessionWorkspaces.set(run.sessionId, env.workerCwd)
  const questionResumes: QuestionResumeReport[] = []
  const waiting: TaskRun[] = []
  const submitted: TaskRun[] = []
  await self.rebuildWorkspaceOwnership(storeId)
  for (const run of ordered) {
    // A run that predates coordination phases is left exactly as it is; the read
    // side derives its `needs-recovery` verdict and its only exit is cancellation.
    if (run.executionPhase === undefined) continue
    if (run.providerBinding !== undefined) {
      const read = await self.readRunBinding(run.providerBinding)
      if (read !== undefined && read.defects.length > 0) {
        throw new Error(`task-runtime: run "${run.runId}" content binding changed:\n- ${read.defects.join('\n- ')}`)
      }
    }
    // A birth-submitted replay (`submission.origin === 'runtime'`, spawn disabled)
    // never had a worker Session: its submitted phase continues at the verifier.
    if (
      rootTaskStoreId(run.sessionId) !== storeId &&
      !self.startedSessions.has(run.sessionId) &&
      run.submission?.origin !== 'runtime'
    ) {
      const runEnv = run.placement === undefined ? env : await self.orchestrateEnv(run.sessionId, `recovery:${storeId}`, run.placement.workspacePath)
      const attempt = await resumeAdoptedWorker(runEnv, storeId, run)
      if (attempt.status !== 'live') {
        throw new Error(
          `task-runtime: cannot continue run "${run.runId}" in Session "${run.sessionId}": ${attempt.reason}`,
        )
      }
      questionResumes.push({ subject: `run "${run.runId}" (session "${run.sessionId}")`, status: 'live' })
    }
    if (run.executionPhase === 'waiting_children') {
      if (run.batchId === undefined || !batchHeldByRun(run, run.batchId)) {
        await stopUnidentifiedBatch(self, env, storeId, run)
        continue
      }
      waiting.push(run)
    } else if (run.executionPhase === 'submitted') {
      submitted.push(run)
    }
  }
  // All identities and gates exist before verification or a driver can execute.
  for (const run of submitted) {
    const lineage = self.replayLineage.get(run.taskId)
    const runEnv = run.placement === undefined ? env : await self.orchestrateEnv(run.sessionId, `recovery:${storeId}`, run.placement.workspacePath)
    await settleSubmittedRun(runEnv, storeId, run.taskId, run.runId, lineage === undefined ? {} : { anomalies: [lineage] })
  }
  for (const run of waiting) {
    startBatchDriver(self, {
      storeId,
      parentTaskId: run.taskId,
      parentRunId: run.runId,
      batchId: run.batchId!,
      callerSessionId: run.sessionId,
      reason: `continued batch ${run.batchId} after a restart`,
    })
  }
  /**
   * The question deliveries this store still owes (A4 §F.1). This is the pass
   * a restart runs, and it runs it *after* the sessions the barrier brought
   */
  const deliverQuestions = async (): Promise<QuestionReconcileReport[]> => {
    const deliveries = await reconcileQuestionDeliveries(self.questionCoordination(), storeId)
    reportUnsettledQuestionDeliveries(self, storeId, deliveries)
    await self.wakeUnclaimedQuestionMessages(storeId, deliveries)
    const barrier = self.storeRecovery.get(storeId)
    const candidates = deliveries.filter(
      delivery => delivery.status === 'delivered' || delivery.status === 'already-present',
    )
    if (barrier !== undefined && candidates.length > 0) {
      const snapshot = await self.context.task.snapshotIn(storeId)
      const targetOf = new Map(
        pendingQuestionMessages(snapshot).messages.map(message => [message.messageId, message.targetSessionId]),
      )
      for (const delivery of candidates) {
        const target = targetOf.get(delivery.messageId)
        if (target === undefined) continue
        if (delivery.status === 'delivered' || self.sessionHoldsPendingMessage(target, delivery.messageId)) {
          barrier.wokenSessions.add(target)
        }
      }
    }
    return deliveries
  }
  /**
   * The end-of-batch results this store still owes (K1 §2, §5) — the second
   * delivery the pass makes, and the one a crash in the window between a batch's
   */
  const deliverBatches = async (): Promise<void> => {
    const current = await self.context.task.snapshotIn(storeId)
    const owed = owedBatchResults(current)
    if (owed.length === 0) return
    const unread: { sessionId: string; messageId: string }[] = []
    for (const entry of owed) {
      try {
        const status = await self.redeliverBatchResult(storeId, entry.batchId)
        if (status === 'already-present')
          unread.push({ sessionId: entry.sessionId, messageId: batchEndMessageId(entry.batchId) })
      } catch (error) {
        self.warn(
          `store ${storeId}: the end-of-batch message for "${entry.batchId}" could not be re-derived ` +
            `(${message(error)}); the batch's facts stand and the next activation retries`,
        )
      }
    }
    self.wakeUnclaimedBatchResults(unread)
  }
  const barrier = self.storeRecovery.get(storeId)
  let questionDeliveries: QuestionReconcileReport[] = []
  if (barrier === undefined || barrier.status !== 'recovering') {
    questionDeliveries = await deliverQuestions()
    await deliverBatches()
  } else if (barrier.cancelled !== true) {
    // A second pass inside one barrier re-decides the same deliveries; the later
    // decision is the one the ready handle runs, and the record is what both read.
    barrier.pendingQuestionDelivery = async () => {
      await deliverQuestions()
      await deliverBatches()
    }
  }
  /**
   * The proposal pass comes last (T2/T3 §5–§6): a batch it admits is driven by
   * the driver it starts, and the workspace question is already settled above,
   */
  const unresolvedProposals = await self.reconcileProposals(storeId)
  /**
   * The receipt pass finishes the recovery: a process that died between a run's
   * terminal record and its receipt makes that receipt up here, exactly once.
   * Its own failures are reported, never raised — a settlement already happened.
   */
  try {
    await self.reconcileRunReceipts(storeId)
  } catch (error) {
    self.warn(`store ${storeId}: the receipt reconciliation pass failed (${message(error)})`)
  }
  return { unresolvedProposals, questionDeliveries, questionResumes }
}

export async function failBatch(self: TaskRuntime, storeId: string, batchId: string, reason: string): Promise<void> {
  const found = await batchRecordIn(self, storeId, batchId)
  if (found === undefined) return
  const entry = self.drivers.get(`${storeId}/${batchId}`)
  const env = await self.orchestrateEnv(await self.sessionForStore(storeId), `fail-batch:${storeId}`)
  // Persist failure before waking the driver's cancellation branch.
  try {
    await settleRunFromRuntime(env, storeId, found.run, 'failed', reason)
  } finally {
    entry?.controller.abort()
  }
  await blockUnstartedChildren(env, storeId, found.memberTaskIds, reason)
}
