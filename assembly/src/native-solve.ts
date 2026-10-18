import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { openChildSession } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { methodContext, confirmWorkflowDelivery } from './method-run.ts'
import { directionForRun } from './coordination.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { recordedVerdictDigest, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState,
} from '../../src/task/protocol.ts'
import { callerOf, taskStateOf, type Apparatus } from './apparatus.ts'
import type { SolveObservation } from './evolution.ts'
import type { TaskCase } from '../../src/measure/suite.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { propose } from './surfaces.ts'
import { workspaceOf } from './attempt.ts'
import { sha256 } from './ids.ts'
import { waitForTask } from './read.ts'
import { sealedBytes } from './sealed.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import {
  taskSessionsOf,
  taskTokenUsage,
  taskExecutionWindow,
  billedTokens,
  completeUsage,
  executionEvents,
  type EvaluationCostBasis,
} from './evaluation-cost.ts'

export interface SolveMeasurement {
  readonly digest: string
  measure(source: string, signal: AbortSignal): Promise<number>
}

export function createNativeSolve(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent, signal: AbortSignal,
  measurement?: SolveMeasurement,
) {
  return async ({
    revision,
    operationId,
    started,
    contract,
    case: taskCase,
  }: {
    revision: RevisionRef
    operationId: string
    contract?: TaskContract
    case?: TaskCase
    started: (run: { taskId: string; runId: string }) => Promise<void> }): Promise<SolveObservation> => {
    signal.throwIfAborted()
    const id = `trial-${sha256(`${apparatus.controlId}/${operationId}`).slice(0, 24)}`
    const caller = callerOf(parent)
    const sessionId = String(agentSessionIdOf(id))
    let child: Awaited<ReturnType<typeof openChildSession>> | undefined
    const cancel = () => child?.stop()
    signal.addEventListener('abort', cancel, { once: true })
    let taskId: string | undefined
    let runId: string | undefined
    try {
      const owner = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .findLast(
        (task) => task.responsibility?.agentId === String(parent.id),
      )!
      const ownerRun = Object.values(owner.runs).at(-1)!
      const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
      let root = owner
      while (true) {
        const run = Object.values(root.runs).at(-1)!
        const relatedTo = run.relatedTo
        const ancestor = relatedTo === undefined ? [...tasks.values()].find((task) =>
                task.decomposition?.children.some((child) => child.taskId === root.taskId),
              ) : tasks.get(relatedTo.taskId)
        if (ancestor === undefined) break
        root = ancestor
      }
      const trial = await propose(apparatus, { agentId: sessionId, sessionId, model: caller.model },
        operationId, { contract: contract ?? root.contract!, method: revision },
        { purpose: 'evaluation', relatedTo: { taskId: owner.taskId, runId: ownerRun.runId },
          ...(taskCase === undefined ? {} : { case: { caseId: taskCase.caseId, familyId: taskCase.familyId, split: taskCase.split } }) },
      )
      taskId = trial.taskId
      runId = trial.runId
      signal.throwIfAborted()
      await started({ taskId, runId })
      let run = Object.values(taskStateOf(apparatus, taskId).runs).at(-1)!
      runId = run.runId
      const workspace = workspaceOf(apparatus, taskId, runId)
      const message = schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
        parentTaskId: String(parent.id), taskId, runId, factSeq: 0,
        },
        JSON.stringify({
          assigned: trial,
          ...(run.status === 'running' && run.stage === 'working' ? { method: await methodContext(apparatus, taskId, run) } : {}),
          direction: directionForRun(apparatus, taskId, run),
          purpose:
            'Independent solve of the protected domain task. Submit its artifact; the owning RSI node handles evolution.',
        }),
      )
      if (run.status === 'running') {
        child = await openChildSession(seams, { agentId: id, cwd: workspace, parent, model: caller.model, message, signal, preset: 'singularity-root',
        })
        signal.throwIfAborted()
        await confirmWorkflowDelivery(apparatus, taskId, run)
        run = await waitForTask(apparatus, taskId, child, signal)
        runId = run.runId
      }
      if (run.status === 'running') refuse('illegal-transition', 'the native solve stopped without submitting its working Run')
      return observeSolve(apparatus, taskId, runId, signal, measurement, taskCase?.hardGuards)
    } catch (error) {
      if (
        !signal.aborted &&
        taskId !== undefined && runId !== undefined && taskStateOf(apparatus, taskId).runs[runId]!.status === 'running')
        await apparatus.tasks.forAgent(sessionId).failRun({ commandId: `${operationId}:runtime-failed`, taskId, runId, reason: String(error) })
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      if (child !== undefined) { child.stop()
        await child.close()
      }
    }
  }
}

/** Measure one sealed business run; the caller's RSI session is never traversed. */
export async function observeSolve(apparatus: Apparatus, taskId: string, runId: string, signal: AbortSignal,
  measurement?: SolveMeasurement,
  hardGuards?: readonly string[],
): Promise<SolveObservation> {
  const task = taskStateOf(apparatus, taskId), run = task.runs[runId]!
  const sessions = taskSessionsOf(apparatus, taskId)
  const ownSession = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility!.agentId)!.sessionId
  const traces: { sessionId: string; eventCount: number; digest: string; events: readonly SessionEvent[] }[] = []
  const sessionCosts: EvaluationCostBasis['sessions'][number][] = []
  for (const sessionId of sessions) {
    const handle = await apparatus.persistence.open(sessionId as Agent['session']['id'], 'read')
    try {
      const native = (await handle.read()).events
      const { events, from, complete } = sessionId === ownSession
        ? taskExecutionWindow(native, apparatus.controlId, taskId, run.submission?.source)
        : { events: executionEvents(native), from: 0, complete: true }
      const usage = taskTokenUsage(apparatus, handle, events, from)
      const tokens = billedTokens(usage)
      const eventCount = events.length
      traces.push({ sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }), events })
      sessionCosts.push({ sessionId, from, end: eventCount, tokens,
        complete: complete && Object.values(usage).every(value => value >= 0) && completeUsage(events.slice(from)) })
    } finally { await handle.close() }
  }
  const costBasis = { sessions: sessionCosts }
  const cost = sessionCosts.every(session => session.complete) ? sessionCosts.reduce((total, session) => total + session.tokens, 0) : null
  const trajectory = await apparatus.attachments.saveFile({
    name: 'trial-trajectory.json',
    data: Buffer.from(JSON.stringify({ sessions: traces })),
  })
  const criterionId = task.contract!.criteria[0]!.criterionId
  const submission = run.submission
  if (run.status === 'running') refuse('illegal-transition', 'cannot observe an unfinished Run')
  if ((run.failureCause === 'runtime' || run.failureCause === 'cancelled') || submission === undefined)
    return { taskId, runId, trajectory, costBasis, cost,
      status: run.failureCause === 'runtime' || run.failureCause === 'cancelled' ? 'infrastructure-failure' : 'no-submission',
      reason: `${run.status}: ${run.failureReason ?? 'no artifact was submitted'}` }
  const artifactDigest = submission.artifactDigest
  const evidenceDigest = recordedVerdictDigest(task, 'native method solve', { runId, criterionId, artifactDigest })
  const evidence = run.evidence.find(
    (entry) => entry.criterionId === criterionId && entry.artifactDigest === artifactDigest,
  )!
  let quality: number
  try { quality =
    measurement === undefined
      ? run.status === 'verified'
        ? 1
        : 0
      : await measurement.measure((await sealedBytes(apparatus, submission.files.artifact)).toString('utf8'), signal,
        ) } catch (error) {
    signal.throwIfAborted()
    return { taskId, runId, trajectory, costBasis, cost, status: 'infrastructure-failure', reason: `measurement failed: ${String(error)}` }
  }
  const met = run.status === 'verified'
  return { taskId, runId, quality, met, cost,
    ...(hardGuards === undefined ? {} : { guardsMet: hardGuards.every(id => run.evidence.some(e => e.criterionId === id && e.artifactDigest === artifactDigest && e.verdict === 'pass')) }),
    trajectory, costBasis,
    artifactDigest, inputDigests: submission.inputDigests,
    implementationDigest: measurement?.digest ?? evidence.implementationDigest, acceptanceDigest: evidence.implementationDigest,
    verdict: { criterionId, evidenceDigest, artifactDigest },
  }
}
