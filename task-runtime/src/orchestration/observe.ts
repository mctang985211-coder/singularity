/**
 * Run observation: worker waits, terminal polling, session cancellation and batch messages.
 */

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  DependencyEdge,
  RunId,
  RunStatus,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  TaskStatus,
} from '@dangosys/dsh-singularity-task'
import { blockingQuestionsOf } from '@dangosys/dsh-singularity-task'
import { openProposalOf } from '../proposal.ts'
import { message, sleep } from '../helpers.ts'
import { resumeAdoptedWorker } from './spawn.ts'
import { RunWatcherUnavailableError } from './types.ts'
import type {
  BatchContext,
  BatchResultDeliveryStatus,
  BatchResultMessage,
  ChildOutcome,
  OrchestrateEnv,
  OwedBatchResult,
} from './types.ts'
import { childEvidenceId, settleChildRun } from './child.ts'
import { notifyOwner, releaseWorkspaceLayer, runOwner } from './settlement.ts'
import type { BatchItem, WaitingObservation, WorkerObservation } from './types.ts'
import { isAborted, isTerminalRun } from './verify.ts'

/** How a spawned worker's wait settled. */
type WorkerSettlement = { kind: 'idle' } | { kind: 'aborted' } | { kind: 'failed'; reason: string }

/** Wait for the worker to go idle or fail; explicit cancellation stops its loop. */
async function awaitWorker(handle: AgentHandle, signal: AbortSignal | undefined): Promise<WorkerSettlement> {
  const cancel = () => handle.agent.cancel({ kind: 'parent' })
  signal?.addEventListener('abort', cancel, { once: true })
  // An abort that already happened when this wait began is the same cancellation:
  // the listener above never fires for it, and the worker would otherwise run on
  // with nothing left to cancel it.
  if (isAborted(signal)) cancel()
  try {
    await handle.agent.whenIdle()
    return isAborted(signal) ? { kind: 'aborted' } : { kind: 'idle' }
  } catch (error) {
    return isAborted(signal) ? { kind: 'aborted' } : { kind: 'failed', reason: message(error) }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * One batch's children in the batch's own order, with each child's dependencies
 * mapped from task ids back to batch positions: the store is the only source of
 */
export function batchItems(memberTaskIds: readonly TaskId[], edges: readonly DependencyEdge[]): BatchItem[] {
  const position = new Map(memberTaskIds.map((taskId, index) => [taskId, index] as const))
  const dependencies = memberTaskIds.map((): number[] => [])
  for (const edge of edges) {
    const to = position.get(edge.to)
    const from = position.get(edge.from)
    if (to !== undefined && from !== undefined) dependencies[to]!.push(from)
  }
  return memberTaskIds.map((taskId, index) => ({
    index,
    taskId,
    dependsOn: dependencies[index]!.sort((left, right) => left - right),
  }))
}

/** The latest run the store records for a task, or `undefined` when it has none (never started). */
export function latestRun(snapshot: TaskSnapshot, taskId: TaskId): TaskRun | undefined {
  for (let index = snapshot.runs.length - 1; index >= 0; index--) {
    const run = snapshot.runs[index]!
    if (run.taskId === taskId) return run
  }
  return undefined
}

export function taskOf(snapshot: TaskSnapshot, taskId: TaskId): TaskInstance | undefined {
  return snapshot.tasks.find(task => task.taskId === taskId)
}

/* --- run observation (A3 §3.1) ------------------------------------------- */

/**
 * Wait for one run's terminal status. The subscription is taken first (through
 * {@link OrchestrateEnv.watchRun}, which subscribes and then reads the current
 */
export async function waitRunTerminal(env: OrchestrateEnv, storeId: string, runId: RunId): Promise<RunStatus> {
  const current = await env.task.runIn(storeId, runId)
  if (isTerminalRun(current.status)) return current.status
  if (env.watchRun === undefined) {
    throw new RunWatcherUnavailableError(
      `task-runtime: cannot observe run "${runId}" reaching a terminal state: this deployment wires no run watcher, ` +
        'so no honest settlement is possible',
    )
  }
  return await new Promise<RunStatus>(resolve => {
    let settled = false
    const unsubscribe = env.watchRun as NonNullable<OrchestrateEnv['watchRun']>
    let off: (() => void) | undefined
    off = unsubscribe(storeId, runId, status => {
      if (settled || !isTerminalRun(status)) return
      settled = true
      off?.()
      resolve(status)
    })
    if (settled) off?.()
  })
}

/** True when the agent behind a handle is mid-turn: idle then means "waiting for the model", not "done". */
function agentIsRunning(handle: AgentHandle): boolean {
  return (handle.agent as unknown as { status?: unknown }).status === 'running'
}

/** How long a batch waits for a settled run's own settlement to finish before adopting the state as it stands. */
const SETTLEMENT_TAIL_WINDOW_MS = 2_000

/** How often that wait re-reads the gate's phase. Short: the tail it waits for is a store write away. */
const SETTLEMENT_POLL_MS = 5

/**
 * Wait for one run to be terminal *and* settled: the status event, and then the
 * in-process settlement that wrote it — whose last act is closing the gate for
 */
export async function waitRunSettled(
  env: OrchestrateEnv,
  storeId: string,
  runId: RunId,
  sessionId: string,
): Promise<RunStatus> {
  const status = await waitRunTerminal(env, storeId, runId)
  const deadline = Date.now() + SETTLEMENT_TAIL_WINDOW_MS
  for (;;) {
    const phase = env.gate.phaseOf(sessionId)
    if (phase === undefined || phase === 'terminal') return status
    if (Date.now() >= deadline) {
      notifyOwner(
        env,
        sessionId,
        `task-runtime: run "${runId}" is ${status} but its settlement has not closed the gate for session ${sessionId} ` +
          `after ${SETTLEMENT_TAIL_WINDOW_MS}ms; the batch adopts the terminal state as it stands`,
      )
      return status
    }
    await sleep(SETTLEMENT_POLL_MS)
  }
}

/** The reminder a worker that went idle without submitting gets once. */
function idleReminderText(run: TaskRun): string {
  return (
    `task-runtime: session ${run.sessionId} went idle without submitting its result. If the work is done, call ` +
    `task_submit_result with a summary and the evidence you produced — an idle session is not a completion. ` +
    `Continue the same run until you submit or it is explicitly cancelled.`
  )
}

/**
 * Wait for the run's terminal state or batch cancellation.
 * An active worker that goes idle gets one submission reminder; a worker waiting
 */
export async function observeWorkerRun(
  env: OrchestrateEnv,
  storeId: string,
  task: TaskInstance,
  run: TaskRun,
  handle: AgentHandle,
  signal: AbortSignal | undefined,
): Promise<WorkerObservation> {
  const recorded = waitRunSettled(env, storeId, run.runId, run.sessionId)
  // Keep a losing watcher's rejection handled.
  recorded.catch(() => {})
  const terminal = recorded.then((status): WaitingObservation => ({ kind: 'terminal', status }))
  for (;;) {
    const settled = await Promise.race([terminal, awaitWorker(handle, signal)])
    if (settled.kind !== 'idle') return settled
    const current = await env.task.runIn(storeId, run.runId)
    if (isTerminalRun(current.status)) return { kind: 'terminal', status: current.status }
    const phase = current.executionPhase
    if (phase === 'waiting_children' || phase === 'submitted') {
      return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: 'parent' }), signal, terminal)
    }
    if (agentIsRunning(handle)) continue
    const snapshot = await env.task.snapshotIn(storeId)
    // Proposal and answer waits need no submission reminder.
    const knownWait =
      openProposalOf(snapshot, task.taskId, run.runId) !== undefined ||
      blockingQuestionsOf(snapshot, run.runId).length > 0
    if (knownWait) {
      return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: 'parent' }), signal, terminal)
    }
    notifyOwner(env, run.sessionId, idleReminderText(run))
    return await awaitWaitingTerminal(() => handle.agent.cancel({ kind: 'parent' }), signal, terminal)
  }
}

/** Wait for the persisted terminal state or explicit cancellation. */
async function awaitWaitingTerminal(
  cancel: (() => void) | undefined,
  signal: AbortSignal | undefined,
  terminal: Promise<WaitingObservation>,
): Promise<WaitingObservation> {
  if (isAborted(signal)) {
    cancel?.()
    return { kind: 'aborted' }
  }
  if (signal === undefined) return await terminal
  let stop!: () => void
  const aborted = new Promise<WaitingObservation>(resolve => {
    stop = () => {
      cancel?.()
      resolve({ kind: 'aborted' })
    }
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([terminal, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/**
 * The cancellation one session's own agent exposes, when this deployment can
 * resolve it — what the driver needs to end a wait it did not start (A4 §F.1).
 */
function cancelAgentOf(env: OrchestrateEnv, sessionId: string): (() => void) | undefined {
  const agent = env.agentFor?.(sessionId) as { cancel?: (reason: { kind: 'parent' }) => void } | undefined
  if (agent === undefined) return undefined
  const cancel = agent.cancel
  if (typeof cancel !== 'function') return undefined
  return () => {
    cancel.call(agent, { kind: 'parent' })
  }
}

/** Restore the same active Run/Session and observe its persisted settlement. */
export async function awaitAdoptedWorkerWait(
  env: OrchestrateEnv,
  batch: BatchContext,
  item: BatchItem,
  run: TaskRun,
  dependencyTaskIds: readonly TaskId[],
): Promise<ChildOutcome> {
  const resumed = await resumeAdoptedWorker(env, batch.storeId, run)
  if (resumed.status !== 'live') {
    throw new Error(
      `task-runtime: cannot continue run "${run.runId}" in Session "${run.sessionId}" : ${resumed.reason}`,
    )
  }
  /**
   * The block is *derived* from the store here, never assumed — this process wrote
   * no ask, and the wait it adopted may be an answered-but-unread one, where the
   */
  env.gate.setQuestionsBlocked(
    run.sessionId,
    blockingQuestionsOf(await env.task.snapshotIn(batch.storeId), run.runId).length > 0,
  )
  if (resumed.status === 'live' && env.gate.phaseOf(run.sessionId) === undefined)
    env.gate.setPhase(run.sessionId, 'active')
  const terminal = waitRunSettled(env, batch.storeId, run.runId, run.sessionId).then((status): WaitingObservation => ({
    kind: 'terminal',
    status,
  }))
  const observation = await awaitWaitingTerminal(cancelAgentOf(env, run.sessionId), batch.signal, terminal)
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
    case 'aborted':
      return await settleChildRun(
        env,
        batch.storeId,
        { item, run, dependencyTaskIds },
        {
          status: 'cancelled',
          anomalies: [`the batch was cancelled while this recovered child waited: ${batch.reason}`],
        },
      )
  }
}

/**
 * The blockers a cancelled batch names: the siblings that were in flight when it was cancelled.
 */
export function startedBlocker(
  snapshot: TaskSnapshot,
  items: readonly BatchItem[],
): { taskId: TaskId; outcome: TaskStatus }[] {
  return items.flatMap(item => {
    const run = latestRun(snapshot, item.taskId)
    const task = taskOf(snapshot, item.taskId)
    if (run === undefined || task === undefined || task.status === 'verified') return []
    return [{ taskId: item.taskId, outcome: task.status }]
  })
}

/** The store's own account of how a batch's children ended, one `2 verified` per status. */
function outcomeTally(outcomes: readonly ChildOutcome[]): string {
  const counts = new Map<ChildOutcome['status'], number>()
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1)
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')
}

/** {@link outcomeTally} named by the batch it belongs to — what a batch end reports. */
export function batchSummary(batchId: string, outcomes: readonly ChildOutcome[]): string {
  return `batch ${batchId} ended: ${outcomes.length === 0 ? 'no children' : outcomeTally(outcomes)}`
}

/**
 * The `m-` identity one ended batch's result message carries: derived from the
 * batch id, never minted — the same derivation `questionMessageIdOf` makes for a
 */
export function batchEndMessageId(batchId: string): string {
  return `m-batchend-${batchId}`
}

/**
 * The body one batch-end message carries, rendered from the store's own account
 * of the batch: every member's terminal state and the evidence it left, and what
 */
export function batchEndMessageText(batchId: string, outcomes: readonly ChildOutcome[]): string {
  const children =
    outcomes.length === 0 ? 'It admitted no children.' : `Its children settled: ${outcomeTally(outcomes)}.`
  const lines = outcomes.map(
    outcome =>
      `- ${outcome.taskId} (run ${outcome.runId ?? 'none'}): ${outcome.status}${outcome.evidenceId === undefined ? '' : `, evidence ${outcome.evidenceId}`}`,
  )
  return [
    `[task-batch-end ${batchId}] the child batch has ended and the workspace is handed back to you; nothing was submitted on your behalf.`,
    children,
    ...lines,
    "You are active again: read the children's results, continue your own work, delegate another batch (task_decompose), or hand in your own result (task_submit_result) — only that submission starts your acceptance.",
  ].join('\n')
}

/**
 * The member task ids of one batch, as the run's own accumulated batches record
 * them. A run that records no such batch cannot be asked about it: the members of
 */
export function batchMembers(run: TaskRun, batchId: string): TaskId[] {
  const batch = run.batches?.find(candidate => candidate.batchId === batchId)
  if (batch === undefined) {
    throw new Error(
      `task-runtime: run "${run.runId}" records no batch "${batchId}", so the store does not name its members; ` +
        "a batch is read from the run that admitted it, never derived from the task's children",
    )
  }
  return [...batch.memberTaskIds]
}

/**
 * The end-of-batch results one store's own facts still owe (K1 §2, §5).
 * A run that is `active` has no unfinished batch — `waiting_children → active`
 */
export function owedBatchResults(snapshot: TaskSnapshot): OwedBatchResult[] {
  const owed: OwedBatchResult[] = []
  for (const run of snapshot.runs) {
    if (run.status !== 'running' || run.executionPhase !== 'active') continue
    for (const batch of run.batches ?? []) {
      owed.push({
        taskId: run.taskId,
        runId: run.runId,
        batchId: batch.batchId,
        sessionId: run.sessionId,
        memberTaskIds: [...batch.memberTaskIds],
      })
    }
  }
  return owed
}

/**
 * Deliver one batch's end-of-batch message and report what the attempt settled
 * as. A deployment without the seam, or one whose relay refuses, changes nothing
 */
export async function deliverBatchResult(
  env: OrchestrateEnv,
  result: BatchResultMessage,
): Promise<BatchResultDeliveryStatus> {
  if (env.deliverBatchResult === undefined) return 'unavailable'
  try {
    return await env.deliverBatchResult(result)
  } catch (error) {
    return `refused: ${message(error)}` as BatchResultDeliveryStatus
  }
}
