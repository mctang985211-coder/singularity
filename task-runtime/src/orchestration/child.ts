/**
 * Child driving: launching member runs, blocking unstarted children and deriving outcomes.
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  ReviewCriterion,
  RunId,
  RunProviderBinding,
  RunStatus,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskService,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, resolvePreset } from '../capability.ts'
import { providerRefusals } from '../provider-precheck.ts'
import { checkRunStart, hasRootLimits, resolveRootBudget } from '../root-budget.ts'
import { bindRunProviders } from '../run-binding.ts'
import { buildHandoff } from '../handoff.ts'
import { message } from '../helpers.ts'
import type { BatchContext, ChildOutcome, OrchestrateEnv, RuntimeSettlementEnv } from './types.ts'
import { missingArtifactReason, missingRequiredArtifacts } from './verify.ts'
import { finishBatch } from './batch.ts'
import {
  awaitAdoptedWorkerWait,
  batchItems,
  batchMembers,
  latestRun,
  observeWorkerRun,
  startedBlocker,
  taskOf,
  waitRunSettled,
} from './observe.ts'
import { handOverWorkspace, recordTerminalReview, releaseWorkspaceLayer, runOwner } from './settlement.ts'
import { assertPresetUsable, authorizedGrant, permissionFor, skillRootsForRun } from './spawn.ts'
import type { BatchItem, BlockReason, StartedChild } from './types.ts'
import { TERMINAL_TASK_STATUSES, isTerminalRun } from './verify.ts'

/** Block reason for a child the batch never started because the caller cancelled it. */
const CANCELLED_BEFORE_START = 'cancelled by the caller before this child started'

/**
 * One child's outcome as the store records it. A child that never reached a
 * terminal state in a settled batch has no outcome to report and is named
 */
export async function deriveChildOutcomes(
  task: TaskService,
  storeId: string,
  parentTaskId: TaskId,
  memberTaskIds: readonly TaskId[],
): Promise<ChildOutcome[]> {
  const snapshot = await task.snapshotIn(storeId)
  const parent = taskOf(snapshot, parentTaskId)
  if (parent === undefined) return []
  return memberTaskIds.map(taskId => {
    const instance = taskOf(snapshot, taskId)
    const run = latestRun(snapshot, taskId)
    const status = instance?.status
    const evidenceId =
      run === undefined ? undefined : snapshot.evidence.find(item => item.taskRunId === run.runId)?.evidenceId
    const outcome: ChildOutcome['status'] =
      status === 'verified' || status === 'failed' || status === 'blocked' || status === 'cancelled' ? status : 'failed'
    return {
      taskId,
      ...(run === undefined ? {} : { runId: run.runId }),
      status: outcome,
      ...(evidenceId === undefined ? {} : { evidenceId }),
    }
  })
}

/**
 * The evidence one child's own submission, verification, or failure left in the
 * store. Read back rather than carried: the store is the truth about a run, and
 */
export function childEvidenceId(snapshot: TaskSnapshot, runId: RunId): string | undefined {
  return snapshot.evidence.find(item => item.taskRunId === runId)?.evidenceId
}

/** One child's outcome as the store holds it: the status the run reached and the evidence it left, if any. */
function adoptedOutcome(taskId: TaskId, runId: RunId, status: RunStatus, snapshot: TaskSnapshot): ChildOutcome {
  const evidenceId = childEvidenceId(snapshot, runId)
  return {
    taskId,
    runId,
    status: status as ChildOutcome['status'],
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}

/**
 * Settle one child run from its own state: mark the terminal transition it does
 * not have yet, or adopt the one it already has.
 */
export async function settleChildRun(
  env: OrchestrateEnv,
  storeId: string,
  child: { item: BatchItem; run: TaskRun; dependencyTaskIds: readonly TaskId[] },
  verdict: {
    status: 'verified' | 'failed' | 'cancelled'
    localizedCause?: string
    anomalies?: readonly string[]
    criteria?: readonly ReviewCriterion[]
    logTail?: string
  },
): Promise<ChildOutcome> {
  const { item, run, dependencyTaskIds } = child
  const snapshot = await env.task.snapshotIn(storeId)
  const current = snapshot.runs.find(candidate => candidate.runId === run.runId)
  const status: RunStatus = current?.status ?? run.status
  if (isTerminalRun(status)) return adoptedOutcome(item.taskId, run.runId, status, snapshot)
  try {
    await env.task.markRunStatusIn(storeId, item.taskId, run.runId, verdict.status, env.actor, {
      ...(verdict.localizedCause === undefined ? {} : { reason: verdict.localizedCause }),
    })
  } catch (error) {
    /**
     * Two settlement paths can reach one run at once: a child that decomposed in
     * turn is settled by its own nested batch while this driver is cancelling the
     */
    const settled = await env.task.runIn(storeId, run.runId).catch(() => undefined)
    if (settled === undefined || !isTerminalRun(settled.status)) throw error
    return adoptedOutcome(item.taskId, run.runId, settled.status, await env.task.snapshotIn(storeId))
  }
  await recordTerminalReview(env, storeId, item.taskId, verdict.status, {
    run,
    ...(verdict.localizedCause === undefined ? {} : { localizedCause: verdict.localizedCause }),
    ...(verdict.anomalies === undefined ? {} : { anomalies: verdict.anomalies }),
    ...(verdict.criteria === undefined ? {} : { criteria: verdict.criteria }),
    ...(verdict.logTail === undefined ? {} : { logTail: verdict.logTail }),
    relatedTaskIds: dependencyTaskIds,
  })
  env.onRunSettled?.(storeId, item.taskId, run.runId, verdict.status)
  await releaseWorkspaceLayer(env, runOwner(storeId, item.taskId, run.runId), run.sessionId)
  const evidenceId = childEvidenceId(await env.task.snapshotIn(storeId), run.runId)
  return {
    taskId: item.taskId,
    runId: run.runId,
    status: verdict.status,
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}

/**
 * Drive one started child run to its terminal state and adopt it: the batch's
 * per-child half of {@link driveBatch}.
 */
async function driveChildRound(env: OrchestrateEnv, batch: BatchContext, child: StartedChild): Promise<ChildOutcome> {
  const { item, task, run, handle, dependencyTaskIds } = child
  const observation = await observeWorkerRun(env, batch.storeId, task, run, handle, batch.signal)
  switch (observation.kind) {
    case 'terminal': {
      const snapshot = await env.task.snapshotIn(batch.storeId)
      const status: RunStatus =
        snapshot.runs.find(candidate => candidate.runId === run.runId)?.status ?? observation.status
      env.onRunSettled?.(batch.storeId, item.taskId, run.runId, status)
      await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), run.sessionId)
      const evidenceId = childEvidenceId(snapshot, run.runId)
      return {
        taskId: item.taskId,
        runId: run.runId,
        status: status as ChildOutcome['status'],
        ...(evidenceId === undefined ? {} : { evidenceId }),
      }
    }
    case 'aborted': {
      return await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        {
          status: 'cancelled',
          anomalies: [`the batch was cancelled while this child ran: ${batch.reason}`],
        },
      )
    }
    case 'failed': {
      return await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        {
          status: 'failed',
          localizedCause: observation.reason,
        },
      )
    }
  }
}

/* --- starting one child --------------------------------------------------- */

/** The outcome of one start attempt: an adopted outcome, or nothing to adopt yet because the child is now in flight. */
type StartAttempt = { kind: 'adopted'; outcome: ChildOutcome } | { kind: 'started'; child: StartedChild }

/** Mark one child that never started, and record why — the runless blocked shape the store accepts. */
async function blockChild(
  env: RuntimeSettlementEnv,
  storeId: string,
  item: BatchItem,
  block: BlockReason,
  dependencyTaskIds: readonly TaskId[],
): Promise<ChildOutcome> {
  await env.task.markRunStatusIn(storeId, item.taskId, undefined as unknown as RunId, 'blocked', env.actor, {
    reason: block.reason,
  })
  await recordTerminalReview(env, storeId, item.taskId, 'blocked', {
    anomalies: [block.reason],
    relatedTaskIds: dependencyTaskIds,
    blockedBy: block.blockers.map(blocker => ({ taskId: blocker.taskId, outcome: blocker.outcome })),
  })
  return { taskId: item.taskId, status: 'blocked' }
}

/** Every child that never started, settled with the same reason — the batch never leaves an admitted ghost behind. */
export async function blockUnstarted(
  env: RuntimeSettlementEnv,
  storeId: string,
  snapshot: TaskSnapshot,
  items: readonly BatchItem[],
  why: (item: BatchItem) => BlockReason,
): Promise<ChildOutcome[]> {
  const blocked: ChildOutcome[] = []
  for (const item of items) {
    const task = taskOf(snapshot, item.taskId)
    if (
      task === undefined ||
      task.status === 'verified' ||
      task.status === 'failed' ||
      task.status === 'blocked' ||
      task.status === 'cancelled'
    )
      continue
    if (latestRun(snapshot, item.taskId) !== undefined) continue
    const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
    blocked.push(await blockChild(env, storeId, item, why(item), dependencyTaskIds))
  }
  return blocked
}

/**
 * Block every child of one batch that never started, naming one reason — the
 * runtime-level entry for the paths that settle a batch without a driver
 */
export async function blockUnstartedChildren(
  env: RuntimeSettlementEnv,
  storeId: string,
  memberTaskIds: readonly TaskId[],
  reason: string,
): Promise<ChildOutcome[]> {
  const snapshot = await env.task.snapshotIn(storeId)
  return await blockUnstarted(env, storeId, snapshot, batchItems(memberTaskIds, snapshot.edges), () => ({
    reason,
    blockers: [],
  }))
}

/**
 * Start one child of an admitted batch: every check the batch's admission could
 * not make (the evidence a criterion needs, the run budget that was reserved
 */
async function startChildRound(
  env: OrchestrateEnv,
  batch: BatchContext,
  parentTask: TaskInstance,
  parentRun: TaskRun,
  items: readonly BatchItem[],
  item: BatchItem,
  snapshot: TaskSnapshot,
): Promise<StartAttempt> {
  const task = taskOf(snapshot, item.taskId)
  if (task === undefined)
    throw new Error(`task-runtime: batch ${batch.batchId} names child "${item.taskId}", which the store does not hold`)
  const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
  const manifest = snapshot.capabilities[item.taskId]

  /**
   * The root budget is checked once per start, from the store's own count: the
   * limit is not resettable by a restart (§3.5). A refusal is monotone — the
   */
  const budgetSnapshot = await env.task.snapshotIn(batch.storeId)
  const budget = resolveRootBudget(budgetSnapshot, env.rootBudget ?? {})
  if (!budget.ok) {
    if (hasRootLimits(env.rootBudget)) {
      return {
        kind: 'adopted',
        outcome: await blockChild(
          env,
          batch.storeId,
          item,
          { reason: `the root budget cannot be resolved: ${budget.reason}`, blockers: [] },
          dependencyTaskIds,
        ),
      }
    }
  } else {
    const verdict = checkRunStart(budgetSnapshot, budget)
    if (!verdict.allowed) {
      return {
        kind: 'adopted',
        outcome: await blockChild(
          env,
          batch.storeId,
          item,
          { reason: verdict.reason, blockers: [] },
          dependencyTaskIds,
        ),
      }
    }
  }

  const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, snapshot)
  if (missingArtifacts.length > 0) {
    const reason = missingArtifactReason(missingArtifacts)
    const blocked = await blockChild(env, batch.storeId, item, { reason, blockers: [] }, dependencyTaskIds)
    for (const missing of missingArtifacts) {
      const verified = missing.requirement === 'requires'
      await env.task.recordObligationIn(
        batch.storeId,
        {
          obligationId: `o-${randomUUID()}`,
          goal: `artifact/evidence "${missing.ref}" required by task "${item.taskId}" criterion ${missing.criterionId} does not exist in the task store${verified ? ' as a verified reference product' : ''}`,
          criterion: verified
            ? `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id) produced by a verified run carrying a passing verdict`
            : `the task store holds evidence or an artifact named "${missing.ref}" (evidence id, artifact kind, or artifact id)`,
          sourceTaskId: item.taskId,
        },
        env.actor,
      )
    }
    return { kind: 'adopted', outcome: blocked }
  }

  if (manifest === undefined) {
    const reason = `capability manifest for child "${item.taskId}" is missing from the store; the run cannot be started without one`
    const blocked = await blockChild(env, batch.storeId, item, { reason, blockers: [] }, dependencyTaskIds)
    return { kind: 'adopted', outcome: blocked }
  }

  const runId: RunId = `r-${randomUUID()}`
  const sessionId = `s-${randomUUID()}`
  const dependencyEvidence = snapshot.evidence
    .filter(evidence => dependencyTaskIds.includes(evidence.taskId))
    .map(evidence => evidence.evidenceId)
  const handoff = {
    ...buildHandoff({
      parentTask,
      parentRun,
      childTask: task,
      reason: batch.reason,
      callerSessionId: batch.callerSessionId,
      assumptions: [
        ...(task.contract?.assumptions ?? []),
        ...dependencyEvidence.map(
          evidenceId => `dependency evidence "${evidenceId}" is verified and available as a reference`,
        ),
      ],
      constraints: task.contract?.constraints ?? [],
      relevantEvidence: dependencyEvidence,
    }),
    /**
     * Deterministic on purpose (A3 §1.2): a resumed batch re-enters this start
     * and must recognize the handoff it already wrote instead of minting a
     */
    handoffId: `h-${runId}`,
  }
  if (!snapshot.handoffs.some(existing => existing.handoffId === handoff.handoffId)) {
    await env.task.recordHandoffIn(batch.storeId, handoff, env.actor)
  }

  const agentPreset = resolvePreset(manifest, env.defaultPreset)
  const name = task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `child-${item.index + 1}`
  const run: TaskRun = {
    runId,
    taskId: item.taskId,
    sessionId,
    parentRunId: parentRun.runId,
    ...(env.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: env.taskTemplatesRoot }),
    capabilitySnapshot: capabilitySnapshot(manifest),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    // Born active (§1.1): this run decides its own work until it submits or
    // decomposes, and the phase is what admits both.
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  let binding: RunProviderBinding | undefined
  try {
    let providers = batch.providers
    if (providers === undefined && env.precheck !== undefined) {
      /**
       * A resumed batch carries no verdicts — the process that judged them is
       * gone — so the pre-check is re-run from this run's own viewpoint and a
       */
      const fresh = await env.precheck(Object.keys(manifest.capabilities), env.workspacePath)
      const refusals = providerRefusals(fresh, Object.keys(manifest.capabilities))
      if (refusals.length > 0) {
        throw new Error(`the provider pre-check refused this run on resume:\n- ${refusals.join('\n- ')}`)
      }
      providers = fresh
    }
    binding = await bindRunProviders({
      mcpRegistry: env.mcpRegistry,
      storeId: batch.storeId,
      runId: run.runId,
      manifest,
      ...(providers === undefined ? {} : { providers }),
      ...(env.runBindingRoot === undefined ? {} : { root: env.runBindingRoot }),
    })
  } catch (error) {
    const reason = `content binding failed: ${message(error)}`
    await env.task.startRunIn(batch.storeId, run, env.actor)
    return {
      kind: 'adopted',
      outcome: await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        { status: 'failed', localizedCause: reason },
      ),
    }
  }
  const bound: TaskRun = binding === undefined ? run : { ...run, providerBinding: binding }
  /**
   * The budget is charged here, before any worker exists: `TaskStarted` is the
   * record `maxRuns` counts, so a crash between this write and the spawn does
   */
  await env.task.startRunIn(batch.storeId, bound, env.actor)

  try {
    await assertPresetUsable(env, manifest, agentPreset)
  } catch (error) {
    return {
      kind: 'adopted',
      outcome: await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        { status: 'failed', localizedCause: `spawn failed: ${message(error)}` },
      ),
    }
  }

  /**
   * One writer at a time (§3.4): the batch's hold is handed to this child for
   * as long as it works. A workspace this process does not hold as expected is
   */
  const handover = await handOverWorkspace(
    env,
    runOwner(batch.storeId, item.taskId, run.runId),
    top => top !== undefined && top.batchId === batch.batchId,
    sessionId,
    `batch ${batch.batchId}`,
  )
  if (!handover.ok) {
    return {
      kind: 'adopted',
      outcome: await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        { status: 'failed', localizedCause: `workspace handover refused: ${handover.reason}` },
      ),
    }
  }

  let handle: AgentHandle
  try {
    const permissionPreset = permissionFor(env, manifest)
    handle = await env.spawn({
      sessionId,
      name,
      taskWorker: true,
      grant: await authorizedGrant(env, manifest, skillRootsForRun([], binding)),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(env.workerCwd === undefined ? {} : { cwd: env.workerCwd }),
      /**
       * What this batch runs *under*, not only where it runs (S4-E §Q3): a child of
       * an experiment's worker is part of the same run of the experiment, so it is
       */
      ...(env.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: env.taskTemplatesRoot }),
      ...(env.agentOptions === undefined ? {} : { agentOptions: env.agentOptions }),
      signal: batch.signal,
    })
  } catch (error) {
    await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, run.runId), sessionId)
    return {
      kind: 'adopted',
      outcome: await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        { status: 'failed', localizedCause: `spawn failed: ${message(error)}` },
      ),
    }
  }
  env.gate.setPhase(sessionId, 'active')
  env.onRunBound(sessionId, { storeId: batch.storeId, taskId: item.taskId, runId: run.runId })
  return { kind: 'started', child: { item, task, run, handle, dependencyTaskIds } }
}

/* --- the batch loop ------------------------------------------------------- */

/** What the driver does between rounds: everything the store says, and nothing it holds in memory. */
export async function driveRounds(env: OrchestrateEnv, batch: BatchContext): Promise<ChildOutcome[]> {
  for (;;) {
    const snapshot = await env.task.snapshotIn(batch.storeId)
    const parentTask = await env.task.taskIn(batch.storeId, batch.parentTaskId)
    const parentRun = await env.task.runIn(batch.storeId, batch.parentRunId)
    /**
     * The batch's own members, read from the run's accumulation on every round: the
     * parent task's children are every batch it ever admitted, so a second batch
     */
    const members = batchMembers(parentRun, batch.batchId)
    /**
     * A parent whose run already settled was settled by somebody else — a
     * cancellation, a batch failure seam, or the driver above this one. The
     */
    if (parentRun.status !== 'running') {
      const items = batchItems(members, snapshot.edges)
      await blockUnstarted(env, batch.storeId, snapshot, items, () => ({
        reason: CANCELLED_BEFORE_START,
        blockers: startedBlocker(snapshot, items),
      }))
      return await deriveChildOutcomes(env.task, batch.storeId, batch.parentTaskId, members)
    }
    const items = batchItems(members, snapshot.edges)
    const pending = items.filter(item => {
      const task = taskOf(snapshot, item.taskId)
      return task !== undefined && !TERMINAL_TASK_STATUSES.has(task.status)
    })
    if (pending.length === 0) return await finishBatch(env, batch)

    if (batch.signal.aborted) {
      await blockUnstarted(env, batch.storeId, snapshot, items, () => ({
        reason: CANCELLED_BEFORE_START,
        blockers: startedBlocker(snapshot, items),
      }))
      return await finishBatch(env, batch)
    }

    const verified = new Set(
      items.filter(item => taskOf(snapshot, item.taskId)?.status === 'verified').map(item => item.index),
    )
    const ready = pending
      .filter(item => item.dependsOn.every(dependency => verified.has(dependency)))
      .sort((left, right) => left.index - right.index)
    if (ready.length === 0) {
      await blockUnstarted(env, batch.storeId, snapshot, items, item => ({
        reason: `dependencies [${item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId).join(', ')}] did not verify`,
        blockers: item.dependsOn
          .filter(dependency => !verified.has(dependency))
          .map(dependency => {
            const taskId = (items[dependency] as BatchItem).taskId
            return { taskId, outcome: taskOf(snapshot, taskId)?.status ?? 'blocked' }
          }),
      }))
      return await finishBatch(env, batch)
    }

    const item = ready[0] as BatchItem
    const started = latestRun(snapshot, item.taskId)
    if (started !== undefined) {
      if (started.executionPhase === 'active') {
        const dependencyTaskIds = item.dependsOn.map(dependency => (items[dependency] as BatchItem).taskId)
        await awaitAdoptedWorkerWait(env, batch, item, started, dependencyTaskIds)
        continue
      }
      const status = await waitRunSettled(env, batch.storeId, started.runId, started.sessionId)
      env.onRunSettled?.(batch.storeId, item.taskId, started.runId, status)
      await releaseWorkspaceLayer(env, runOwner(batch.storeId, item.taskId, started.runId), started.sessionId)
      continue
    }

    const attempt = await startChildRound(env, batch, parentTask, parentRun, items, item, snapshot)
    if (attempt.kind === 'adopted') continue
    await driveChildRound(env, batch, attempt.child)
  }
}
