import { randomUUID } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  EvidenceBundle,
  RunId,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskService,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { capabilitySnapshot, resolvePreset } from './capability.ts'
import { buildHandoff, renderWorkerPrompt } from './handoff.ts'

/** Raised when the verifier service (ticket C2) is not loaded in the context. */
export class VerifierUnavailableError extends Error {
  override name = 'VerifierUnavailableError'
}

/** One admitted child plus the manifest it was admitted with. */
export interface ChildPlan {
  task: TaskInstance
  manifest: CapabilityManifest
  dependsOn: readonly number[]
}

export interface ChildOutcome {
  taskId: TaskId
  runId?: RunId
  status: 'verified' | 'failed' | 'blocked' | 'cancelled'
  evidenceId?: string
}

export interface SpawnChildRequest {
  sessionId: string
  name: string
  prompt: string
  agentPreset?: string
  signal?: AbortSignal
}

/** Per-call overrides the cascade forwards on every verifier call (ticket C2's `VerifyRunOptions`). */
export interface VerifyRunOptions {
  /** Working directory for criterion commands — the env checkout the workers ran in. */
  cwd?: string
  /** The verifier's own deadline for this call; the verifier kills whatever it started. */
  timeoutMs?: number
}

/** Grace the cascade's safety net grants a verifier beyond its own deadline before giving up on it. */
export const VERIFY_SAFETY_MARGIN_MS = 15_000

/** The service-supplied seam the cascade runs against (keeps this module free of cordis types). */
export interface OrchestrateEnv {
  task: TaskService
  actor: string
  defaultPreset?: string
  verifyTimeoutMs: number
  spawn(request: SpawnChildRequest): Promise<AgentHandle>
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
  onRunBound(sessionId: string, binding: { storeId: string; taskId: TaskId; runId: RunId }): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read `signal.aborted` behind a function boundary so control-flow narrowing never freezes the value. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** One mandatory criterion the verifier did not pass, plus what the verifier said about it. */
interface UnmetCriterion {
  criterionId: string
  detail: string
}

function unmetMandatory(criteria: readonly AcceptanceCriterion[], results: readonly VerificationResult[]): UnmetCriterion[] {
  return criteria.filter(criterion => criterion.mandatory).flatMap(criterion => {
    const result = results.find(item => item.criterionId === criterion.criterionId)
    if (result?.status === 'pass') return []
    return [{
      criterionId: criterion.criterionId,
      detail: result === undefined ? 'no result' : `${result.status}${result.details === undefined ? '' : ` (${result.details})`}`,
    }]
  })
}

function failureReason(unmet: readonly UnmetCriterion[]): string {
  return `mandatory criteria not satisfied: ${unmet.map(item => `${item.criterionId} ${item.detail}`).join(', ')}`
}

/**
 * Safety net around one verifier call. The verifier holds its own deadline
 * (`timeoutMs` goes down with every call) and kills whatever it started, so
 * this only fires when a verifier ignores its deadline entirely: it gets
 * `timeoutMs + VERIFY_SAFETY_MARGIN_MS` before the cascade gives up on it,
 * marks the run failed, and walks on. The abandoned promise keeps a handler
 * attached — it may still settle (and reject) long after the race is lost, and
 * that must never surface as an unhandled rejection.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, runId: RunId): Promise<T> {
  work.catch(() => {})
  const budgetMs = timeoutMs + VERIFY_SAFETY_MARGIN_MS
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `task-runtime: verification of run "${runId}" timed out after ${budgetMs}ms (verifier deadline ${timeoutMs}ms + ${VERIFY_SAFETY_MARGIN_MS}ms safety margin)`,
    )), budgetMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/**
 * Sequential run cascade over one admitted batch of children (RFC §47 MVP):
 * the first child whose dependencies are all `verified` is handed off and
 * spawned; its run is verified, then readiness is re-evaluated. A child whose
 * dependency failed, was cancelled, or never ran becomes `blocked`; an abort
 * cancels the in-flight child agent and marks its run `cancelled`. Once the
 * batch settles the parent run takes the verifier's verdict on its own
 * criteria — the composite acceptance that closes the loop.
 */
export async function runChildrenCascade(
  env: OrchestrateEnv,
  storeId: string,
  parentTask: TaskInstance,
  parentRun: TaskRun,
  plans: readonly ChildPlan[],
  reason: string,
  callerSessionId: string,
  signal?: AbortSignal,
): Promise<ChildOutcome[]> {
  const outcomes: Array<ChildOutcome | undefined> = plans.map(() => undefined)
  const remaining = new Set(plans.map((_plan, index) => index))
  const verified = new Set<number>()
  /** Hand the verifier its own deadline and keep the safety net one margin behind it. */
  const verify = (runId: RunId) =>
    withTimeout(env.verifyRun(storeId, runId, { timeoutMs: env.verifyTimeoutMs }), env.verifyTimeoutMs, runId)

  const blockRemaining = async (why: (index: number) => string) => {
    for (const index of remaining) {
      const taskId = plans[index]!.task.taskId
      await env.task.markRunStatusIn(storeId, taskId, undefined as unknown as RunId, 'blocked', env.actor, { reason: why(index) })
      outcomes[index] = { taskId, status: 'blocked' }
    }
    remaining.clear()
  }

  while (remaining.size > 0) {
    if (isAborted(signal)) {
      for (const index of remaining) outcomes[index] = { taskId: plans[index]!.task.taskId, status: 'cancelled' }
      remaining.clear()
      break
    }
    const ready = [...remaining]
      .filter(index => plans[index]!.dependsOn.every(dependency => verified.has(dependency)))
      .sort((a, b) => a - b)
    if (ready.length === 0) {
      await blockRemaining(index => {
        const failed = plans[index]!.dependsOn.filter(dependency => !verified.has(dependency))
        return `dependencies [${failed.map(dependency => plans[dependency]!.task.taskId).join(', ')}] did not verify`
      })
      break
    }

    const index = ready[0]!
    const plan = plans[index]!
    const childTaskId = plan.task.taskId
    const snapshot = await env.task.snapshotIn(storeId)
    const dependencyTaskIds = plan.dependsOn.map(dependency => plans[dependency]!.task.taskId)
    const handoff = buildHandoff({
      parentTask,
      parentRun,
      childTask: plan.task,
      reason,
      callerSessionId,
      relevantEvidence: snapshot.evidence
        .filter(item => dependencyTaskIds.includes(item.taskId))
        .map(item => item.evidenceId),
    })
    await env.task.recordHandoffIn(storeId, handoff, env.actor)

    const sessionId = `s-${randomUUID()}`
    const name = plan.task.objective.trim().replace(/\s+/g, ' ').slice(0, 40) || `child-${index + 1}`
    const agentPreset = resolvePreset(plan.manifest, env.defaultPreset)
    let handle: AgentHandle
    try {
      handle = await env.spawn({
        sessionId,
        name,
        prompt: renderWorkerPrompt(handoff, plan.task),
        ...(agentPreset !== undefined ? { agentPreset } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch {
      outcomes[index] = { taskId: childTaskId, status: 'failed' }
      remaining.delete(index)
      continue
    }

    const run: TaskRun = {
      runId: `r-${randomUUID()}`,
      taskId: childTaskId,
      sessionId,
      parentRunId: parentRun.runId,
      capabilitySnapshot: capabilitySnapshot(plan.manifest),
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    await env.task.startRunIn(storeId, run, env.actor)
    env.onRunBound(sessionId, { storeId, taskId: childTaskId, runId: run.runId })

    const cancel = () => handle.agent.cancel({ kind: 'parent' })
    signal?.addEventListener('abort', cancel, { once: true })
    let failed: string | undefined
    let aborted = false
    try {
      await handle.agent.whenIdle()
      signal?.throwIfAborted()
    } catch (error) {
      if (isAborted(signal)) aborted = true
      else failed = message(error)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    if (aborted) {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'cancelled', env.actor, { reason: 'aborted by caller' })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'cancelled' }
      remaining.delete(index)
      for (const rest of remaining) outcomes[rest] = { taskId: plans[rest]!.task.taskId, status: 'cancelled' }
      remaining.clear()
      break
    }
    if (failed !== undefined) {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason: failed })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      continue
    }

    // A child whose own worker decomposed further is settled by that nested
    // cascade: its run is terminal by the time the agent goes idle. Adopt the
    // run as this round's outcome — walking it through verifying/verifyRun
    // again would be an illegal transition on an already verified task.
    const current = await env.task.runIn(storeId, run.runId)
    if (current.status === 'verified' || current.status === 'failed' || current.status === 'cancelled') {
      const evidenceId = current.status === 'verified'
        ? (await env.task.snapshotIn(storeId)).evidence.find(item => item.taskRunId === run.runId)?.evidenceId
        : undefined
      outcomes[index] = {
        taskId: childTaskId,
        runId: run.runId,
        status: current.status,
        ...(evidenceId === undefined ? {} : { evidenceId }),
      }
      if (current.status === 'verified') verified.add(index)
      remaining.delete(index)
      continue
    }

    await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'verifying', env.actor)
    let bundle: EvidenceBundle
    try {
      bundle = await verify(run.runId)
    } catch (error) {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason: message(error) })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed' }
      remaining.delete(index)
      if (error instanceof VerifierUnavailableError) {
        for (const rest of remaining) outcomes[rest] = { taskId: plans[rest]!.task.taskId, status: 'failed' }
        remaining.clear()
        throw error
      }
      continue
    }
    const unmet = unmetMandatory(plan.task.acceptanceCriteria, bundle.verifierResults)
    if (unmet.length === 0) {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'verified', env.actor)
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'verified', evidenceId: bundle.evidenceId }
      verified.add(index)
    } else {
      await env.task.markRunStatusIn(storeId, childTaskId, run.runId, 'failed', env.actor, { reason: failureReason(unmet) })
      outcomes[index] = { taskId: childTaskId, runId: run.runId, status: 'failed', evidenceId: bundle.evidenceId }
    }
    remaining.delete(index)
  }

  const settled = outcomes.map((outcome, index) => outcome ?? { taskId: plans[index]!.task.taskId, status: 'failed' })

  // Parent acceptance (RFC §47): the batch is settled, so the parent's own
  // criteria are judged now. A root task carries exactly one composite
  // criterion — pass iff every child verified — and the verifier decides, never
  // the caller: this only walks the parent run to the verdict it hears.
  if (isAborted(signal)) {
    await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'cancelled', env.actor, { reason: 'aborted by caller' })
    return settled
  }
  await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'verifying', env.actor)
  try {
    const parentBundle = await verify(parentRun.runId)
    const parentUnmet = unmetMandatory(parentTask.acceptanceCriteria, parentBundle.verifierResults)
    if (parentUnmet.length === 0) {
      await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'verified', env.actor)
    } else {
      await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'failed', env.actor, { reason: failureReason(parentUnmet) })
    }
  } catch (error) {
    await env.task.markRunStatusIn(storeId, parentTask.taskId, parentRun.runId, 'failed', env.actor, { reason: message(error) })
    if (error instanceof VerifierUnavailableError) throw error
  }

  return settled
}
