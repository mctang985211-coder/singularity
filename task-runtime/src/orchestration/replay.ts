/**
 * The replay runner: one replayed task under a frozen candidate overlay.
 */

import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  RunId,
  RunProviderBinding,
  RunStatus,
  SubmissionRecord,
  TaskInstance,
  TaskRun,
} from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot } from '../capability.ts'
import { bindRunProviders } from '../run-binding.ts'
import { message } from '../helpers.ts'
import { settleSubmittedRun } from './batch.ts'
import type { OrchestrateEnv, ReplayRunInit, ReplayRunOutcome, ReplayRunSignals } from './types.ts'
import { missingArtifactReason, missingRequiredArtifacts } from './verify.ts'
import { observeWorkerRun } from './observe.ts'
import { recordTerminalReview, runDurationMs } from './settlement.ts'
import { assertPresetUsable, authorizedGrant, permissionFor, skillRootsForRun } from './spawn.ts'
import { isAborted, isTerminalRun } from './verify.ts'

/**
 * Replay runner (guide §2.7.6, W15): create the caller-shaped replay task in
 * the store, run it once through the real spawn + verify chain — or straight
 */
export async function runReplayTask(
  env: OrchestrateEnv,
  storeId: string,
  init: ReplayRunInit,
  signals: ReplayRunSignals = {},
): Promise<ReplayRunOutcome> {
  const task = init.task
  const admission = signals.admission
  const advance = signals.advance
  if (isAborted(admission)) {
    throw new Error(`task-runtime: replay of "${task.taskId}" was cancelled before anything was persisted`)
  }
  const missingArtifacts = missingRequiredArtifacts(task.acceptanceCriteria, await env.task.snapshotIn(storeId))
  if (missingArtifacts.length > 0) {
    throw new Error(`task-runtime: replay rejected: ${missingArtifactReason(missingArtifacts)}`)
  }
  const anomalies = [init.lineage]
  await env.task.createTaskIn(storeId, task, env.actor)
  await env.task.admitTaskIn(storeId, task.taskId, env.actor, { decompositionStatus: 'leaf', manifest: init.manifest })

  const sessionId = `s-${randomUUID()}`
  const runId: RunId = `r-${randomUUID()}`
  /**
   * The run exists before the spawn attempt so a spawn refusal can still walk
   * it to a terminal state — same discipline as a batch child. Its birth phase
   */
  const birthSubmission: SubmissionRecord | undefined = init.spawn
    ? undefined
    : {
        summary: 'criteria replay (no worker spawned)',
        evidenceRefs: [],
        submittedAt: new Date().toISOString(),
        origin: 'runtime',
      }
  const startedAt = new Date()
  const run: TaskRun = {
    runId,
    taskId: task.taskId,
    sessionId,
    ...(init.championRunId === undefined ? {} : { parentRunId: init.championRunId }),
    capabilitySnapshot: capabilitySnapshot(init.manifest),
    ...(init.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: init.taskTemplatesRoot }),
    ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
    executionPhase: init.spawn ? 'active' : 'submitted',
    ...(birthSubmission === undefined ? {} : { submission: birthSubmission }),
    artifacts: [],
    verifierResults: [],
    status: 'running',
    /**
     * One instant, read once: it is the run's recorded start, and the anchor the
     * per-run wall clock is measured from rather than from a second clock reading
     */
    startedAt: startedAt.toISOString(),
  }
  /**
   * The execution binding this run is placed under (S4-E §Q3): the caller's frozen
   * model selection, as one *bound view* of the env that every wait and every spawn
   */
  const bound: OrchestrateEnv = {
    ...env,
    ...(init.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: init.taskTemplatesRoot }),
    ...(init.agentOptions === undefined ? {} : { agentOptions: init.agentOptions }),
  }
  /**
   * The replay's content binding comes from the pre-check the caller carried
   * (`ReplayRunInit.providers`), not from a fresh discovery here: the identities
   */
  let contentBinding: RunProviderBinding | undefined
  try {
    contentBinding = await bindRunProviders({
      mcpRegistry: env.mcpRegistry,
      storeId,
      runId: run.runId,
      manifest: init.manifest,
      ...(init.providers === undefined ? {} : { providers: init.providers }),
      ...(env.runBindingRoot === undefined ? {} : { root: env.runBindingRoot }),
    })
  } catch (error) {
    const reason = `content binding failed: ${message(error)}`
    await env.task.startRunIn(storeId, run, env.actor)
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return await finishReplay(env, storeId, run, 'failed')
  }
  await env.task.startRunIn(
    storeId,
    contentBinding === undefined ? run : { ...run, providerBinding: contentBinding },
    env.actor,
  )

  if (!init.spawn) {
    const status = await settleSubmittedRun(env, storeId, task.taskId, run.runId, { anomalies })
    return await finishReplay(env, storeId, run, status === 'verified' ? 'verified' : 'failed')
  }

  let handle: AgentHandle
  try {
    await assertPresetUsable(env, init.manifest, init.agentPreset)
    const permissionPreset = permissionFor(env, init.manifest)
    /**
     * The overlay's roots stay in front (a candidate skill wins a same-name
     * collision for this worker), and the run's own snapshot follows: what the
     */
    const roots = skillRootsForRun(init.skillRoots ?? [], contentBinding)
    handle = await bound.spawn({
      sessionId,
      name: task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `replay-${task.taskId}`,
      taskWorker: true,
      grant: await authorizedGrant(env, init.manifest, roots),
      ...(init.agentPreset === undefined ? {} : { agentPreset: init.agentPreset }),
      ...(permissionPreset === undefined ? {} : { permissionPreset }),
      ...(bound.workerCwd === undefined ? {} : { cwd: bound.workerCwd }),
      /**
       * The experiment's frozen selection (absent for an ordinary replay): the
       * agent runtime creates this worker under it, and the deployment remembers
       */
      ...(bound.taskTemplatesRoot === undefined ? {} : { taskTemplatesRoot: bound.taskTemplatesRoot }),
      ...(bound.agentOptions === undefined ? {} : { agentOptions: bound.agentOptions }),
      ...(advance === undefined ? {} : { signal: advance }),
    })
  } catch (error) {
    const reason = `spawn failed: ${message(error)}`
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, 'failed', env.actor, { reason })
    await recordTerminalReview(env, storeId, task.taskId, 'failed', { run, localizedCause: reason, anomalies })
    return await finishReplay(env, storeId, run, 'failed')
  }

  env.gate.setPhase(sessionId, 'active')
  env.onRunBound(sessionId, { storeId, taskId: task.taskId, runId: run.runId })

  const observation = await observeWorkerRun(bound, storeId, task, run, handle, advance)
  switch (observation.kind) {
    case 'terminal':
      return await finishReplay(env, storeId, run, statusOutcome(observation.status))
    case 'aborted':
      // `awaitWorker` already cancelled the agent when it saw the abort; the run
      // only has to be settled here.
      return await settleReplayRun(env, storeId, task, run, {
        status: 'cancelled',
        reason: 'cancelled while the replayed worker ran',
        anomalies,
      })
    case 'failed':
      return await settleReplayRun(env, storeId, task, run, {
        status: 'failed',
        reason: observation.reason,
        localizedCause: observation.reason,
        anomalies,
      })
  }
}

/**
 * Settle one replay run the replay's own observation decided — a cancellation, a
 * worker error — and report what the run settled
 */
async function settleReplayRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  settlement: {
    status: 'failed' | 'cancelled'
    /** The run-level reason (`markRunStatusIn`). */
    reason?: string
    /** The terminal review's localized cause; absent on a cancellation. */
    localizedCause?: string
    anomalies?: readonly string[]
  },
): Promise<ReplayRunOutcome> {
  const current = await env.task.runIn(storeId, run.runId)
  if (isTerminalRun(current.status)) return await finishReplay(env, storeId, run, statusOutcome(current.status))
  try {
    await env.task.markRunStatusIn(storeId, task.taskId, run.runId, settlement.status, env.actor, {
      ...(settlement.reason === undefined ? {} : { reason: settlement.reason }),
    })
  } catch (error) {
    /**
     * The store's own arbiter rule, as in `settleChildRun`: a run it now holds
     * terminal was settled by somebody else while this settlement was in flight,
     */
    const settled = await env.task.runIn(storeId, run.runId).catch(() => undefined)
    if (settled === undefined || !isTerminalRun(settled.status)) throw error
    return await finishReplay(env, storeId, run, statusOutcome(settled.status))
  }
  await recordTerminalReview(env, storeId, task.taskId, settlement.status, {
    run,
    ...(settlement.localizedCause === undefined ? {} : { localizedCause: settlement.localizedCause }),
    ...(settlement.anomalies === undefined ? {} : { anomalies: settlement.anomalies }),
  })
  env.onRunSettled?.(storeId, task.taskId, run.runId, settlement.status)
  return await finishReplay(env, storeId, run, settlement.status)
}

/** A settled run status as a replay outcome; a `blocked` run is reported as failed — a replay cannot be blocked by a sibling. */
function statusOutcome(status: RunStatus): 'verified' | 'failed' | 'cancelled' {
  return status === 'verified' || status === 'cancelled' ? status : 'failed'
}

/**
 * The replay result read back from the store: the review record the settlement
 * wrote carries the duration and the verdict per criterion, and the evidence
 */
async function finishReplay(
  env: OrchestrateEnv,
  storeId: string,
  run: TaskRun,
  status: 'verified' | 'failed' | 'cancelled',
): Promise<ReplayRunOutcome> {
  const snapshot = await env.task.snapshotIn(storeId)
  const record = snapshot.reviews.find(item => item.runId === run.runId)
  const evidenceId = snapshot.evidence.find(item => item.taskRunId === run.runId)?.evidenceId
  return {
    taskId: run.taskId,
    runId: run.runId,
    status,
    ...(record?.durationMs === undefined
      ? { durationMs: await runDurationMs(env, storeId, run) }
      : { durationMs: record.durationMs }),
    ...(record?.criteria === undefined ? {} : { criteria: record.criteria.map(item => ({ ...item })) }),
    ...(evidenceId === undefined ? {} : { evidenceId }),
  }
}
