/**
 * The batch engine: round driving, admission convergence and submitted-run settlement.
 */

import type { EvidenceBundle, RunId, RunStatus, TaskId, TaskInstance, TaskRun } from '@dangosys/dsh-singularity-task'
import { blockingQuestionsOf } from '@dangosys/dsh-singularity-task'
import { drainSession } from '../gate.ts'
import { message } from '../helpers.ts'
import { deriveChildOutcomes } from './child.ts'
import { batchEndMessageId, batchEndMessageText } from './observe.ts'
import { VerifierUnavailableError } from './types.ts'
import type { BatchContext, ChildOutcome, OrchestrateEnv } from './types.ts'
import { blockUnstarted, driveRounds } from './child.ts'
import { batchItems, batchMembers, batchSummary, deliverBatchResult, latestRun, taskOf } from './observe.ts'
import {
  batchOwner,
  notifyOwner,
  recordTerminalReview,
  releaseWorkspaceLayer,
  runOwner,
  withVerifierWorkspace,
} from './settlement.ts'
import {
  failedLogTail,
  failureReason,
  isTerminalRun,
  reviewCriteria,
  unmetMandatory,
  verifyWithDeadline,
} from './verify.ts'

/**
 * End one batch and hand the parent back its own decision (K1 §2) — the
 * settlement a driver performs once every child has a terminal state.
 */
export async function finishBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  const snapshot = await env.task.snapshotIn(batch.storeId)
  const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
  /**
   * The batch's own members, read from the run's accumulated batches: the task's
   * children are every batch's, and a second batch must report (and drain) its
   */
  const members = batchMembers(parentRun, batch.batchId)
  const outcomes = await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members)
  /**
   * A parent whose run already settled was settled by somebody else, and its batch
   * end is the store's record alone: the layer the batch took at admission — and
   */
  if (parentRun.status !== 'running') {
    await releaseWorkspaceLayer(
      env,
      batchOwner(batch.storeId, batch.parentTaskId, batch.batchId),
      batch.callerSessionId,
    )
    return outcomes
  }
  const childTaskIds = [...members]

  if (batch.signal.aborted) {
    /**
     * The cancellation is the batch's terminal cleanup, taken as it always was:
     * the run ends `cancelled` — never failed by a drain it was stopped before —
     */
    await releaseWorkspaceLayer(
      env,
      batchOwner(batch.storeId, batch.parentTaskId, batch.batchId),
      batch.callerSessionId,
    )
    const reason = `cancelled by the caller while the batch settled: ${batch.reason}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled', env.actor, {
      reason,
    })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'cancelled', {
      run: parentRun,
      anomalies: [reason],
      relatedTaskIds: childTaskIds,
    })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'cancelled')
    notifyOwner(
      env,
      batch.callerSessionId,
      `task-runtime: ${reason}. Children: ${batchSummary(batch.batchId, outcomes)}`,
    )
    return outcomes
  }

  /**
   * The unprocessed coordination items no longer hold the parent where it is
   * (K1 §2): the batch ends regardless of what the parent still owes or waits
   */
  const blocked = blockingQuestionsOf(snapshot, batch.parentRunId).length > 0

  /**
   * Every child's write convergence, before the parent is told the batch is over
   * (§3.3): a child settles through its own submission — which drained it — but a
   */
  const childPending: string[] = []
  for (const childTaskId of childTaskIds) {
    const childRun = latestRun(snapshot, childTaskId)
    if (childRun === undefined) continue
    const childDrained = await drainSession(env.gate, childRun.sessionId, {
      timeoutMs: env.writeDrainTimeoutMs,
      jobs: env.jobs,
      agent: env.agentFor?.(childRun.sessionId),
    })
    if (!childDrained.confirmed) {
      childPending.push(`run "${childRun.runId}": ${childDrained.pending.join('; ')}`)
    }
  }
  if (childPending.length > 0) {
    const reason = `write convergence of the batch's children could not be confirmed: ${childPending.join('; ')}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, {
      reason,
    })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', {
      run: parentRun,
      localizedCause: reason,
      relatedTaskIds: childTaskIds,
    })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(
      env,
      batch.callerSessionId,
      `task-runtime: ${reason}; the parent run is failed and its batch is not handed back.`,
    )
    return outcomes
  }

  const drained = await drainSession(env.gate, parentRun.sessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    jobs: env.jobs,
    agent: env.agentFor?.(parentRun.sessionId),
  })
  if (!drained.confirmed) {
    const reason = `write convergence could not be confirmed: ${drained.pending.join('; ')}`
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, {
      reason,
    })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', {
      run: parentRun,
      localizedCause: reason,
      relatedTaskIds: childTaskIds,
    })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(env, batch.callerSessionId, `task-runtime: ${reason}; the parent run is failed and is not verifiable.`)
    return outcomes
  }

  /**
   * The handback (§2): both drains are confirmed, so the batch's layer comes off
   * and the parent's own hold is on top again (§3.4) — confirmed stops first, then
   */
  await releaseWorkspaceLayer(env, batchOwner(batch.storeId, batch.parentTaskId, batch.batchId), batch.callerSessionId)

  /**
   * The store's half of the handback (§1.3): one phase event says the run waits on
   * nothing and closes the batch it names, so a reader of the store sees the same
   */
  await env.task.changeRunPhaseIn(batch.storeId, batch.parentTaskId, batch.parentRunId, env.actor, {
    phase: 'active',
    batchId: batch.batchId,
  })
  env.gate.setPhase(parentRun.sessionId, 'active')
  env.gate.setQuestionsBlocked(parentRun.sessionId, blocked)

  /**
   * …and the parent is told: the batch's own outcomes, under the identity the
   * batch derives, delivered to the Session that waited. A re-delivery states
   */
  const message = batchEndMessageText(batch.batchId, outcomes)
  const delivery = await deliverBatchResult(env, {
    storeId: batch.storeId,
    runId: batch.parentRunId,
    batchId: batch.batchId,
    sessionId: parentRun.sessionId,
    messageId: batchEndMessageId(batch.batchId),
    text: message,
  })
  /**
   * A `skipped` delivery is not an undelivered one: the parent run ended before
   * it could be told (a cancellation that won the race), and the
   */
  if (delivery !== 'delivered' && delivery !== 'already-present' && delivery !== 'skipped') {
    notifyOwner(
      env,
      batch.callerSessionId,
      `task-runtime: ${batchSummary(batch.batchId, outcomes)}; ${message} (delivery: ${delivery})`,
    )
  }
  return outcomes
}

/**
 * Drive one admitted batch to settlement (A3 §3.1): reentrant, store-driven,
 * and owned by the runtime rather than by the tool call that admitted it.
 */
export async function driveBatch(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  /**
   * The batch's own members, read from the run the store records as its parent
   * ({@link batchMembers}): the fallback this used to have — the parent task's
   */
  const members = async (): Promise<TaskId[]> =>
    batchMembers(await env.task.runIn(batch.storeId, batch.parentRunId), batch.batchId)
  try {
    const admitted = await convergeAdmission(env, batch)
    if (!admitted) return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members())
    return await driveRounds(env, batch)
  } catch (error) {
    const reason = `the batch driver failed: ${message(error)}`
    await failParentRun(env, batch, reason)
    return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, await members())
  }
}

/** The parent's own write convergence, before the batch's first child starts. */
async function convergeAdmission(env: OrchestrateEnv, batch: BatchContext): Promise<boolean> {
  const drained = await drainSession(env.gate, batch.callerSessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    ...(batch.excludeCallId === undefined ? {} : { excludeCallId: batch.excludeCallId }),
    jobs: env.jobs,
    agent: env.agentFor?.(batch.callerSessionId),
  })
  if (drained.confirmed) return true
  const reason = `write convergence could not be confirmed: ${drained.pending.join('; ')}`
  const snapshot = await env.task.snapshotIn(batch.storeId)
  const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
  await blockUnstarted(
    env,
    batch.storeId,
    snapshot,
    batchItems(batchMembers(parentRun, batch.batchId), snapshot.edges),
    () => ({
      reason: `the batch never started: ${reason}`,
      blockers: [],
    }),
  )
  await failParentRun(env, batch, reason)
  return false
}

/** Fail the batch's parent run by name, with the one review record its terminal transition owes. */
async function failParentRun(env: OrchestrateEnv, batch: BatchContext, reason: string): Promise<void> {
  try {
    const snapshot = await env.task.snapshotIn(batch.storeId)
    const parentTask = taskOf(snapshot, batch.parentTaskId)
    const parentRun = snapshot.runs.find(run => run.runId === batch.parentRunId)
    if (parentTask === undefined || parentRun === undefined) return
    if (parentRun.status !== 'running') return
    await env.task.markRunStatusIn(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed', env.actor, {
      reason,
    })
    await recordTerminalReview(env, batch.storeId, batch.parentTaskId, 'failed', {
      run: parentRun,
      localizedCause: reason,
      // The batch this failure ends names its own members, never the parent task's
      // children — those are every batch this parent ever admitted.
      relatedTaskIds: batchMembers(parentRun, batch.batchId),
    })
    env.onRunSettled?.(batch.storeId, batch.parentTaskId, batch.parentRunId, 'failed')
    notifyOwner(env, batch.callerSessionId, `task-runtime: batch ${batch.batchId} failed: ${reason}`)
  } catch (error) {
    // A driver that failed while its own bookkeeping was unavailable says so
    // once, and never turns into an unhandled rejection at the runtime.
    notifyOwner(
      env,
      batch.callerSessionId,
      `task-runtime: batch ${batch.batchId} failed and its parent run could not be settled: ${reason} (${message(error)})`,
    )
  }
}

/* --- submission settlement (A3 §3.2) -------------------------------------- */

/**
 * The one verification entry: a run whose phase change into `submitted` is
 * already committed is drained, judged, and settled.
 */
export async function settleSubmittedRun(
  env: OrchestrateEnv,
  storeId: string,
  taskId: TaskId,
  runId: RunId,
  opts: { excludeCallId?: string; relatedTaskIds?: readonly TaskId[]; anomalies?: readonly string[] } = {},
): Promise<RunStatus> {
  const run = await env.task.runIn(storeId, runId)
  if (isTerminalRun(run.status)) return run.status
  const task = await env.task.taskIn(storeId, taskId)
  const snapshot = await env.task.snapshotIn(storeId)
  const relatedTaskIds = opts.relatedTaskIds ?? snapshot.edges.filter(edge => edge.to === taskId).map(edge => edge.from)
  const anomalies = opts.anomalies ?? []

  const drained = await drainSession(env.gate, run.sessionId, {
    timeoutMs: env.writeDrainTimeoutMs,
    ...(opts.excludeCallId === undefined ? {} : { excludeCallId: opts.excludeCallId }),
    jobs: env.jobs,
    agent: env.agentFor?.(run.sessionId),
  })
  if (!drained.confirmed) {
    return await failSubmittedRun(
      env,
      storeId,
      task,
      run,
      relatedTaskIds,
      `write convergence could not be confirmed: ${drained.pending.join('; ')}`,
      anomalies,
    )
  }

  /**
   * The verification mark is written once per verification. A resumed one — the
   * process that started it died inside the verifier call — finds the task
   */
  const currentTask = await env.task.taskIn(storeId, taskId)
  if (currentTask.status !== 'verifying') {
    await env.task.markRunStatusIn(storeId, taskId, runId, 'verifying', env.actor)
  }
  let bundle: EvidenceBundle
  try {
    bundle = await withVerifierWorkspace(env, storeId, taskId, runId, run.sessionId, () =>
      verifyWithDeadline(env, storeId, runId),
    )
  } catch (error) {
    const reason = message(error)
    /**
     * This run's verdict is written before the batch's failure seam, and that order
     * is what makes it hold: the seam aborts the driver, whose abort settles an
     */
    const status = await failSubmittedRun(env, storeId, task, run, relatedTaskIds, reason, anomalies)
    if (error instanceof VerifierUnavailableError) {
      const batchId = await parentBatchOf(env, storeId, task, run)
      if (batchId !== undefined) await env.failBatch?.(storeId, batchId, `verification is unavailable: ${reason}`)
    }
    return status
  }

  /**
   * Cancellation wins over a verdict that arrives after it. The store settled this
   * run while the verifier worked, so its verdict is voided: no status (the store
   */
  const settled = await settledStatusOf(env, storeId, runId)
  if (settled !== undefined) return settled

  const criteria = reviewCriteria(task.acceptanceCriteria, bundle.verifierResults)
  const unmet = unmetMandatory(task.acceptanceCriteria, bundle.verifierResults)
  if (unmet.length === 0) {
    await env.task.markRunStatusIn(storeId, taskId, runId, 'verified', env.actor)
    await recordTerminalReview(env, storeId, taskId, 'verified', { run, relatedTaskIds, criteria, anomalies })
    env.onRunSettled?.(storeId, taskId, runId, 'verified')
    await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId)
    return 'verified'
  }
  const reason = failureReason(unmet)
  await env.task.markRunStatusIn(storeId, taskId, runId, 'failed', env.actor, { reason })
  await recordTerminalReview(env, storeId, taskId, 'failed', {
    run,
    localizedCause: reason,
    relatedTaskIds,
    criteria,
    anomalies,
    logTail: await failedLogTail(env, unmet, bundle.verifierResults),
  })
  env.onRunSettled?.(storeId, taskId, runId, 'failed')
  await releaseWorkspaceLayer(env, runOwner(storeId, taskId, runId), run.sessionId)
  return 'failed'
}

/**
 * The status of a run another actor has already settled, or `undefined` while it is
 * still in flight. The verdict path reads this before writing a verdict: a
 */
async function settledStatusOf(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<RunStatus | undefined> {
  const current = await env.task.runIn(storeId, runId)
  return isTerminalRun(current.status) ? current.status : undefined
}

/** Fail a run that could not be judged, with the reason recorded and its owner told. */
async function failSubmittedRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  relatedTaskIds: readonly TaskId[],
  reason: string,
  anomalies: readonly string[] = [],
): Promise<RunStatus> {
  const current = await env.task.runIn(storeId, run.runId)
  if (isTerminalRun(current.status)) return current.status
  await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
  await recordTerminalReview(env, storeId, task.taskId, 'failed', {
    run,
    localizedCause: reason,
    relatedTaskIds,
    anomalies,
  })
  env.onRunSettled?.(storeId, task.taskId, run.runId, 'failed')
  await releaseWorkspaceLayer(env, runOwner(storeId, task.taskId, run.runId), run.sessionId)
  notifyOwner(env, run.sessionId, `task-runtime: run "${run.runId}" failed: ${reason}`)
  return 'failed'
}

/**
 * The batch a child run belongs to: the batch of its parent run that admitted
 * this child. `parentRunId` names the parent run and the membership is a fact of
 */
async function parentBatchOf(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
): Promise<string | undefined> {
  if (run.parentRunId === undefined || task.parentTaskId === undefined) return undefined
  const snapshot = await env.task.snapshotIn(storeId)
  const parentRun = snapshot.runs.find(candidate => candidate.runId === run.parentRunId)
  if (parentRun === undefined || parentRun.taskId !== task.parentTaskId) return undefined
  return parentRun.batches?.find(batch => batch.memberTaskIds.includes(task.taskId))?.batchId
}
