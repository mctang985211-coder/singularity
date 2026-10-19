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
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { SUBJECT_INPUT } from './review.ts'
import { sealedBytes } from './sealed.ts'
import { DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'
import { taskSessionsOf, taskTokenUsage, taskExecutionWindow, completeUsage, billedTokens, executionEvents } from './evaluation-cost.ts'
export const improvementTools = new Set(['read', 'glob', 'grep', 'write', 'edit',
  'singularity_read', 'singularity_memory', 'singularity_propose_method', 'singularity_submit'])
export const improvementTaskId = (taskId: string, runId: string): string => `improve-${sha256(`${taskId}/${runId}`).slice(0, 24)}`
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
  const task = taskStateOf(apparatus, taskId)
  const history = await historyOf(apparatus, [], task.responsibility!.agentId)
  const ownSession = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility!.agentId)!.sessionId
  const sessions: { sessionId: string; from: number; complete: boolean; eventCount: number; digest: string; events: readonly SessionEvent[];
    tokenUsage: ReturnType<typeof taskTokenUsage> }[] = []
  for (const sessionId of taskSessionsOf(apparatus, taskId)) {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      const native = (await handle.read()).events
      const { events, from, complete } = sessionId === ownSession
        ? taskExecutionWindow(native, apparatus.controlId, taskId, task.runs[runId]!.submission?.source)
        : { events: executionEvents(native), from: 0, complete: true }
      assertContiguous(handle.id, events, 0)
      for (const task of history.tasks) for (const run of task.runs) {
        const source = run.source
        if (source?.sessionId !== sessionId) continue
        if (events.length < source.eventCount || digestOf({ sessionId, eventCount: source.eventCount, events: events.slice(0, source.eventCount) }) !== source.digest)
          refuse('digest-mismatch', 'sealed exploration transcript changed')
      }
      const eventCount = events.length
      const tokenUsage = taskTokenUsage(apparatus, handle, events, from)
      sessions.push({ sessionId, from, eventCount, digest: digestOf({ sessionId, eventCount, events }), events, tokenUsage,
        complete: complete && Object.values(tokenUsage).every(value => value >= 0) && completeUsage(events.slice(from)) })
    } finally { await handle.close() }
  }
  const states = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const usage = sessions.map(({ sessionId, from, complete, eventCount, digest, tokenUsage }) => ({
    sessionId, from, complete, eventCount, digest, tokenUsage, tokens: billedTokens(tokenUsage), trajectoryRef: sessionId,
  }))
  const summary = {
    root: { taskId, runId },
    usage: { source: 'token-meter/tokenUsage', tokens: usage.reduce((total, session) => total + session.tokens, 0),
      complete: sessions.every(session => session.complete) },
    methods: history.methods.map(({ reference }) => reference),
    tasks: history.tasks.map((task) => ({ taskId: task.taskId, contract: task.contract,
      sessionId: task.sessionId, decomposition: task.decomposition,
      parentId: task.parent?.id ?? null, questions: task.questions ?? [],
      runs: task.runs.map((run) => {
        const state = states.get(task.taskId)!.runs[run.runId]!
        return { runId: run.runId, method: state.revision, status: run.status,
          failureCause: run.failureCause, failureReason: run.failureReason,
          verdicts: state.evidence.map(({ criterionId, verdict, reviewId }) => ({ criterionId, verdict, reviewId })),
          artifact: state.submission === undefined ? null : { digest: state.submission.artifactDigest, ref: state.submission.files.artifact },
          consumed: state.consumed, source: run.source,
        }
      }),
    })),
    sessions: usage,
  }
  return Buffer.from(JSON.stringify({ root: { taskId, runId }, summary, sessions }))
}
export async function startImprovement(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent,
  taskId: string, runId: string, signal: AbortSignal,
): Promise<TaskState> {
  signal.throwIfAborted()
  const id = improvementTaskId(taskId, runId)
  const existing = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, id)
  const previous = existing === undefined ? undefined : Object.values(existing.runs).at(-1)
  if (previous !== undefined && previous.status !== 'running') return existing!
  const rootRun = taskStateOf(apparatus, taskId).runs[runId]!
  const method = rootRun.revision
  const loaded = (await loadMethod(apparatus, method)).domain
  // RRSI analyst.py/digester.py: keep raw transcripts outside the analyst's initial context.
  const frozen = JSON.parse((await sealedBytes(apparatus, taskStateOf(apparatus, taskId).rsi!.trace!)).toString('utf8'))
  const trace = Buffer.from(JSON.stringify({ root: frozen.root, summary: frozen.summary }, null, 2))
  const input = { ref: SUBJECT_INPUT, digest: sha256(trace), bytes: trace, sourcePath: '' }
  const domain = { ...loaded, inputs: [...loaded.inputs, input] }
  const agentId = String(agentSessionIdOf(id))
  declareCaller(apparatus, agentId)
  await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'improve' })
  const commands = apparatus.tasks.forAgent(agentId)
  if (existing === undefined)
    await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: {
        goal: 'Improve reusable domain methods from frozen exploration evidence using RRSI analysis, an attributable hypothesis, independent screening and isolated evaluation. Use a bounded search; report measured improvement, no improvement or insufficient evidence truthfully.',
        artifact: 'report.json',
        inputs: [{ name: 'subject.json', source: { kind: 'protected', ref: SUBJECT_INPUT, digest: input.digest } }],
        criteria: [
          {
            criterionId: 'improvement-reported',
            statement:
              'The JSON report cites actual trajectory evidence, explains the analysis and reusable mechanism, preserves evidenced success habits, and accurately reports search facts known before submission, including no improvement or insufficient evidence. It distinguishes attribution from sampling noise and marks untested transfer honestly. Private validation/publication triggered after sealing this report is reported by the host, not predicted by the author.',
          },
        ],
      },
    })
  await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId })
  signal.throwIfAborted()
  if (taskStateOf(apparatus, id).workflowLimits === undefined)
    await apparatus.store.emit({ commandId: `workflow-limits:${id}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
      subject: id, kind: 'workflow/limits-frozen', as: `agent:${agentId}`, payload: DEFAULT_WORKFLOW_LIMITS })
  const run = await startAttempt(apparatus, { agentId, sessionId: agentId, model: callerOf(parent).model }, id, id, method, { domain, purpose: 'improve', relatedTo: { taskId, runId } },
  )
  signal.throwIfAborted()
  if (taskStateOf(apparatus, id).search === undefined)
    await apparatus.store.emit({ commandId: `search:${id}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/search-opened', subject: id, as: `agent:${agentId}`, payload: { runId: run.runId, maxProposals: 6 } })
  const session = await openChildSession(seams, { agentId: id, cwd: workspaceOf(apparatus, id, run.runId), parent,
    preset: 'singularity-improve',
    model: run.bubble!.model, signal, message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
      parentTaskId: taskId, taskId: id, runId: run.runId, factSeq: 0,
      }, JSON.stringify({
      taskId: id, runId: run.runId, contract: taskStateOf(apparatus, id).contract,
        method,
        trace: 'subject.json',
        evidenceReading:
          'Read kind=method without ref for the current search head, assets, proposal.template, proposal.pending, reportTemplate and nextRound. Resume pending batch paths or end the turn for evaluation first. Submit only analysis and edit.changes with values; the host preserves unchanged assets and frozen source. Read kind=subject through complete=true for frozen evidence and native usage. trajectory ref=sessionId lists seq; read/cite it as eventSeq. Proposals use singularity_propose_method; only report.json uses singularity_submit.',
      }),
    ),
  })
  const stop = () => session.stop()
  signal.addEventListener('abort', stop, { once: true })
  try {
    signal.throwIfAborted()
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
