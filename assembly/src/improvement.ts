import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assertContiguous } from '@deepseek-ai/dsh-session-persistence'
import { digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { openChildSession, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { callerOf, declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { startAttempt, workspaceOf } from './attempt.ts'
import { historyOf, waitForTask } from './read.ts'
import { loadMethod } from './method.ts'
import { sha256 } from './ids.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { SUBJECT_INPUT } from './review.ts'
import { sealedBytes } from './sealed.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { nativeTokensOf } from './budget.ts'
export function assertImprovementOwner(apparatus: Apparatus, agentId: string): void {
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(
    (t) => t.responsibility?.agentId === agentId,
  )
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  if (run?.purpose !== 'improve' || run.status !== 'running' || run.stage !== 'working')
    refuse('not-responsible', 'method candidates and evaluations belong to the working RSI node')
  if (run.relatedTo === undefined || taskStateOf(apparatus, run.relatedTo.taskId).closure === undefined)
    refuse('illegal-transition', 'RSI requires a closed business root')
}
export async function explorationOf(apparatus: Apparatus, taskId: string, runId: string): Promise<Buffer> {
  const history = await historyOf(apparatus, [], taskStateOf(apparatus, taskId).responsibility!.agentId)
  const sessions: { sessionId: string; eventCount: number; digest: string; events: readonly SessionEvent[] }[] = []
  for (const sessionId of taskSessionsOf(apparatus, taskId)) {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      const { events } = await handle.read()
      assertContiguous(handle.id, events, 0)
      for (const task of history.tasks) for (const run of task.runs) {
        const source = run.source
        if (source?.sessionId !== sessionId) continue
        if (events.length < source.eventCount || digestOf({ sessionId, eventCount: source.eventCount, events: events.slice(0, source.eventCount) }) !== source.digest)
          refuse('digest-mismatch', 'sealed exploration transcript changed')
      }
      const eventCount = events.length
      sessions.push({ sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }), events })
    } finally { await handle.close() }
  }
  const states = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const summary = {
    root: { taskId, runId },
    methods: history.methods.map(({ reference }) => reference),
    tasks: history.tasks.map((task) => ({ taskId: task.taskId, template: task.contract.template,
      goal: task.goal, sessionId: task.sessionId, decomposition: task.decomposition,
      parentId: task.parent?.id ?? null, inputs: task.contract.inputs, questions: task.questions ?? [],
      runs: task.runs.map((run) => {
        const state = states.get(task.taskId)!.runs[run.runId]!
        return { runId: run.runId, method: state.revision, status: run.status,
          cost: sessions
            .filter((s) => s.sessionId === task.sessionId)
            .map((s) => ({ sessionId: s.sessionId, tokens: nativeTokensOf(s.events) })),
          failureCause: run.failureCause, failureReason: run.failureReason,
          verdicts: state.evidence.map(({ criterionId, verdict, reviewId }) => ({ criterionId, verdict, reviewId })),
          artifact: state.submission === undefined ? null : { digest: state.submission.artifactDigest, ref: state.submission.files.artifact },
          consumed: state.consumed, source: run.source,
        }
      }),
    })),
    sessions: sessions.map(({ sessionId, eventCount, digest, events }) => ({
      sessionId, eventCount, digest, tokens: nativeTokensOf(events), trajectoryRef: sessionId,
    })),
  }
  return Buffer.from(JSON.stringify({ root: { taskId, runId }, summary, history, sessions }))
}
export async function startImprovement(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent,
  taskId: string, runId: string, signal: AbortSignal,
): Promise<TaskState> {
  const id = `improve-${sha256(`${taskId}/${runId}`).slice(0, 24)}`
  const existing = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, id)
  const previous = existing === undefined ? undefined : Object.values(existing.runs).at(-1)
  if (previous !== undefined && previous.status !== 'running') return existing!
  const rootRun = taskStateOf(apparatus, taskId).runs[runId]!
  const method = rootRun.revision
  const loaded = (await loadMethod(apparatus, method)).domain
  const trace = await sealedBytes(apparatus, taskStateOf(apparatus, taskId).rsi!.trace!)
  const input = { ref: SUBJECT_INPUT, digest: sha256(trace), bytes: trace, sourcePath: '' }
  const domain = { ...loaded, inputs: [...loaded.inputs, input] }
  const agentId = String(agentSessionIdOf(id))
  declareCaller(apparatus, agentId)
  await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'improve' })
  const commands = apparatus.tasks.forAgent(agentId)
  if (existing === undefined)
    await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: {
        goal: 'Improve reusable domain methods from the frozen successful and failed exploration evidence. Evaluate supported candidates independently and report measured improvement, no winner, no candidate or budget exhaustion truthfully.',
        artifact: 'report.json',
        inputs: [{ name: 'subject.json', source: { kind: 'protected', ref: SUBJECT_INPUT, digest: input.digest } }],
        criteria: [
          {
            criterionId: 'improvement-reported',
            statement:
              'The report cites actual trajectory evidence, explains reusable mechanism changes and accurately reports independent evaluation decisions or the reason no candidate was evaluated.',
          },
        ],
      },
    })
  await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId })
  const run = await startAttempt(apparatus, { agentId, sessionId: agentId, model: callerOf(parent).model }, id, id, method, { domain, purpose: 'improve', relatedTo: { taskId, runId } },
  )
  const session = await openChildSession(seams, { agentId: id, cwd: workspaceOf(apparatus, id, run.runId), parent,
    preset: 'singularity-improve',
    model: run.bubble!.model, signal, message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
      parentTaskId: taskId, taskId: id, runId: run.runId, factSeq: 0,
      }, JSON.stringify({
      taskId: id, runId: run.runId, contract: taskStateOf(apparatus, id).contract,
        method,
      summary: JSON.parse(trace.toString('utf8')).summary,
        trace: 'subject.json',
        evidenceReading:
          'Read relevant frozen trajectory segments by reference. Change reusable methods, preserve the root standard, and await the host evaluation outcome before reporting.',
      }),
    ),
  })
  const stop = () => session.stop()
  signal.addEventListener('abort', stop, { once: true })
  try {
    await waitForTask(apparatus, id, session, signal)
    return taskStateOf(apparatus, id)
  } catch (error) {
    const current = taskStateOf(apparatus, id).runs[run.runId]!
    if (
      !signal.aborted &&
      !(error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') &&
      current.status === 'running'
    )
      await commands.failRun({
        commandId: `improvement-failed:${id}`,
        taskId: id,
        runId: run.runId,
        reason: String(error),
      })
    throw error
  } finally {
    signal.removeEventListener('abort', stop)
    session.stop()
    await session.close()
  }
}
