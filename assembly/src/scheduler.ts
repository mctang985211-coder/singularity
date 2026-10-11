import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { closeAgentSession } from '../../src/runtime/agent-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree, type TreeView } from '../../src/task/tree.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { templateOf } from './domain.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { schedulerMessage } from './scheduler-message.ts'

export interface Scheduler {
  advance(parentTaskId: string): Promise<readonly string[]>
  close(): Promise<void>
}
export type OpenChild = (request: ChildSessionRequest) => Promise<ChildSession>
export class DispatchError extends Error {
  readonly parentTaskId: string
  readonly taskId: string
  readonly runId: string | null
  constructor(parentTaskId: string, taskId: string, runId: string | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DispatchError'
    this.parentTaskId = parentTaskId
    this.taskId = taskId
    this.runId = runId
  }
}

export function createScheduler(apparatus: Apparatus, seams: ChildSessionSeams,
  open: OpenChild = request => openChildSession(seams, request)): Scheduler {
  const live = new Map<string, ChildSession>()
  const advancing = new Map<string, Promise<readonly string[]>>()
  let closing: Promise<void> | undefined
  const planOf = (parentTaskId: string): TreeView | undefined =>
    projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).find(plan => plan.parentTaskId === parentTaskId)
  const parentOf = (parentTaskId: string): Agent => {
    const holder = taskStateOf(apparatus, parentTaskId).responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, holder)
    const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry | undefined
    const parent = node === undefined ? undefined : registry?.get(SessionId(node.sessionId))
    if (parent === undefined) refuse('unknown-emitter-role', 'the plan has no live recorded parent session: ' + holder)
    if (String(parent.session.id) !== node!.sessionId)
      refuse('unknown-emitter-role', 'the parent registry entry names a different recorded session')
    return parent
  }
  const release = async (taskId: string, session: ChildSession): Promise<void> => {
    const failures: unknown[] = []
    try { session.stop() } catch (error) { failures.push(error) }
    try { await closeAgentSession(taskId); live.delete(taskId) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'child close failed')
  }
  const notify = async (parentTaskId: string, parent: Agent): Promise<void> => {
    const plan = planOf(parentTaskId)!
    const stopped = plan.children.filter(child => ['stopped', 'blocked', 'missing'].includes(child.status))
    const complete = plan.children.every(child => child.status === 'verified')
    if (!complete && stopped.length === 0) return
    const childIds = new Set((complete ? plan.children : stopped.filter(child => child.status === 'stopped')).map(child => child.taskId))
    const terminal = apparatus.store.load().entries().findLast(fact => childIds.has(fact.subject) &&
      fact.kind === (complete ? TASK_KINDS.runVerified : TASK_KINDS.runFailed))
    if (terminal === undefined) refuse('illegal-transition', `plan "${parentTaskId}" has no terminal fact for its outcome`)
    const runId = (terminal.payload as { runId: string }).runId
    const text = complete
      ? `Delegated work for Task ${parentTaskId} verified. Continue your existing parent Run, produce your own artifact and submit it for independent acceptance. Child support is not a parent verdict.`
      : `Delegated work for Task ${parentTaskId} cannot proceed.\n` + stopped.map(child => `${child.taskId}: ${child.reason}`).join('\n')
    try { await postIdentifiedMessage(seams, parent, schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome',
      controlId: apparatus.controlId, parentTaskId, taskId: terminal.subject, runId, factSeq: terminal.seq }, text)) }
    catch (error) { throw new DispatchError(parentTaskId, parentTaskId, null, error) }
  }
  const dispatch = async (parentTaskId: string, parent: Agent, taskId: string, maxRuns: number): Promise<void> => {
    const state = taskStateOf(apparatus, taskId)
    const template = templateOf(apparatus.domain, state.contract!.template)
    const childId = state.responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, childId)!
    const previous = Object.values(state.runs).findLast(run => run.status !== 'running')
    const working = Object.values(state.runs).find(run => run.status === 'running')
    let session = live.get(taskId)
    let attempt = working
    try {
      const agent = session?.agent ?? parent
      const route = agent.session.requestHeader()?.config ?? agent.options
      if (working === undefined && (route.provider === undefined || route.model === undefined))
        refuse('malformed-declaration', 'the dispatch agent has no model route')
      declareCaller(apparatus, childId)
      const run = attempt ??= await startAttempt(apparatus, { agentId: childId, sessionId: node.sessionId, model: { provider: route.provider!, model: route.model! } },
        taskId, taskId + ':attempt:' + Object.values(state.runs).length)
      const workspace = workspaceOf(apparatus, taskId, run.runId)
      if (run.bubble === undefined) refuse('illegal-transition', 'the working Run has no prepared execution bubble')
      const model = run.bubble.model
      if (session === undefined) {
        session = await open({ agentId: taskId, cwd: join(apparatus.workspaceRoot, 'tasks', taskId), parent, model, compose: () => undefined })
        live.set(taskId, session)
      }
      const actual = session.agent.session.requestHeader()?.config ?? session.agent.options
      if (actual.provider !== model.provider || actual.model !== model.model)
        refuse('illegal-transition', 'the child model route differs from its frozen Run bubble')
      const started = apparatus.store.load().entries().find(fact => fact.subject === taskId && fact.kind === TASK_KINDS.runStarted &&
        (fact.payload as { runId: string }).runId === run.runId)!
      const text = [
        `You are responsible for Task ${taskId}, Run ${run.runId}.`,
        'Goal: ' + state.contract!.goal,
        `This attempt uses Run directory ${workspace}. Use this explicit directory for every command and file operation; the session cwd is the Task directory.`,
        `This Task/Run is already started. Do not propose or decompose; solve and submit this exact taskId through singularity_submit_program. Attempt ${Object.keys(state.runs).length + (working === undefined ? 1 : 0)} of ${maxRuns}.`,
        'Input: ' + join(workspace, template.input.name),
        template.submission === 'program' ? 'Your Node ES module receives the input path in process.argv[2]; print the artifact to stdout.' : 'Your source is judged as written.',
        'The independent verifier judges artifact ' + join(workspace, template.artifact) + ' against ' + state.contract!.criteria.map(criterion => criterion.criterionId).join(', ') + '.',
        ...(previous?.failureCause === 'acceptance' ? [`Previous Run ${previous.runId} failed acceptance: ${previous.failureReason}. Correct the answer in this new Run; do not change prior Run files.`] : []),
      ].join('\n')
      const delivery = await postIdentifiedMessage(seams, session.agent, schedulerMessage({ kind: 'singularity', purpose: 'dispatch',
        controlId: apparatus.controlId, parentTaskId, taskId, runId: run.runId, factSeq: started.seq }, text), message => session!.post(message))
      if (working !== undefined && delivery === 'entered')
        refuse('illegal-transition', 'the working Run instruction entered a turn but its external result is unconfirmed')
    } catch (error) {
      const failures: unknown[] = [error]
      const run = attempt ?? Object.values(taskStateOf(apparatus, taskId).runs).at(-1)
      if (run !== undefined && taskStateOf(apparatus, taskId).runs[run.runId]!.status === 'running') {
        try { await apparatus.tasks.forAgent(childId).failRun({ commandId: 'dispatch-failed:' + taskId + '/' + run.runId,
          taskId, runId: run.runId, reason: 'child-runtime-failed: ' + String(error) }) } catch (failure) { failures.push(failure) }
      }
      if (session !== undefined) try { await release(taskId, session) } catch (failure) { failures.push(failure) }
      try { await notify(parentTaskId, parent) } catch (failure) { failures.push(failure) }
      throw new DispatchError(parentTaskId, taskId, run?.runId ?? null,
        failures.length === 1 ? error : new AggregateError(failures, 'child dispatch failed: ' + String(error)))
    }
  }
  const advanceOne = async (parentTaskId: string): Promise<readonly string[]> => {
    const state = taskStateOf(apparatus, parentTaskId)
    const plan = planOf(parentTaskId)
    if (plan === undefined || !Object.values(state.runs).some(run => run.status === 'running' && run.stage === 'working')) return []
    const parent = parentOf(parentTaskId)
    const opened: string[] = []
    for (const child of plan.children) {
      if (child.status !== 'ready' && child.status !== 'running') continue
      const running = Object.values(taskStateOf(apparatus, child.taskId).runs).find(run => run.status === 'running')
      if (child.status !== 'ready' && !(child.status === 'running' && running?.stage === 'working' && !live.has(child.taskId))) continue
      await dispatch(parentTaskId, parent, child.taskId, child.maxRuns)
      opened.push(child.taskId)
    }
    await notify(parentTaskId, parent)
    return opened
  }
  return {
    advance: parentTaskId => {
      if (closing !== undefined) refuse('illegal-transition', 'the scheduler is closing')
      const previous = advancing.get(parentTaskId)
      const pending = previous === undefined ? advanceOne(parentTaskId) : previous.then(() => advanceOne(parentTaskId), () => advanceOne(parentTaskId))
      advancing.set(parentTaskId, pending)
      const done = () => { if (advancing.get(parentTaskId) === pending) advancing.delete(parentTaskId) }
      void pending.then(done, done)
      return pending
    },
    close: () => closing ??= (async () => {
      const pending = await Promise.allSettled([...advancing.values()])
      const failures = pending.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      for (const [taskId, session] of live) try { await release(taskId, session) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'child unload failed')
    })(),
  }
}
