import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { childSettled, projectTree, type TreeView } from '../../src/task/tree.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { templateOf } from './domain.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { domainForRun, methodOfRun, loadMethod } from './method.ts'
import { resolveInputs } from './inputs.ts'
import { REVIEW_TEMPLATE, SUBJECT_INPUT } from './review.ts'
import { templateDeclaration } from './read.ts'

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
  const lifecycle = new AbortController()
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
    try { await session.close(); live.delete(taskId) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'child close failed')
  }
  const notify = async (parentTaskId: string, parent: Agent): Promise<void> => {
    const plan = planOf(parentTaskId)!
    const stopped = plan.children.filter(child => ['stopped', 'blocked', 'missing'].includes(child.status))
    const complete = plan.children.every(childSettled)
    if (!complete && stopped.length === 0) return
    const childIds = new Set((complete ? plan.children : stopped.filter(child => child.status === 'stopped')).map(child => child.taskId))
    const terminal = apparatus.store.load().entries().findLast(fact => childIds.has(fact.subject) &&
      (fact.kind === TASK_KINDS.runVerified || fact.kind === TASK_KINDS.runFailed))
    if (terminal === undefined) refuse('illegal-transition', `plan "${parentTaskId}" has no terminal fact for its outcome`)
    const runId = (terminal.payload as { runId: string }).runId
    const text = complete
      ? `Delegated work for Task ${parentTaskId} settled. Continue your existing parent Run and independently validate your final artifact. Only verified child artifacts satisfy dependencies; child support is not a parent verdict.\n` + stopped.map(child => `${child.taskId}: ${child.reason}`).join('\n')
      : `Delegated work for Task ${parentTaskId} has failed or blocked branches. Review the actual evidence and append replacement work if needed.\n` + stopped.map(child => `${child.taskId}: ${child.reason}`).join('\n')
    try {
      await postIdentifiedMessage(seams, parent, schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome',
        controlId: apparatus.controlId, parentTaskId, taskId: terminal.subject, runId, factSeq: terminal.seq }, text))
    }
    catch (error) { throw new DispatchError(parentTaskId, parentTaskId, null, error) }
  }
  const dispatch = async (parentTaskId: string, parent: Agent, taskId: string, maxRuns: number): Promise<void> => {
    const state = taskStateOf(apparatus, taskId)
    const parentRun = Object.values(taskStateOf(apparatus, parentTaskId).runs).find(run => run.status === 'running')!
    const revision = state.contract!.assets ?? methodOfRun(apparatus, parentRun)
    const inherited = await domainForRun(apparatus, parentRun)
    const domain = revision === undefined ? inherited : { ...(await loadMethod(apparatus, revision)).domain, inputs: inherited.inputs }
    const template = templateOf(domain, state.contract!.template)
    const childId = state.responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, childId)!
    const previous = Object.values(state.runs).findLast(run => run.status !== 'running')
    const working = Object.values(state.runs).find(run => run.status === 'running')
    let session = live.get(taskId)
    let attempt = working
    try {
      const agent = session?.agent
      const route = agent === undefined ? previous?.bubble?.model ?? (parent.session.requestHeader()?.config ?? parent.options)
        : agent.session.requestHeader()?.config ?? agent.options
      if (working === undefined && (route.provider === undefined || route.model === undefined))
        refuse('malformed-declaration', 'the dispatch agent has no model route')
      declareCaller(apparatus, childId)
      const parentExecution = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, parentRun.revision.environmentId)!
        .revisions[parentRun.revision.revisionId]!.manifest as { purpose: string }
      const auditContract = template.input.source.kind === 'protected' && template.input.source.ref === SUBJECT_INPUT
        && template.criterion.verifierRef === 'independent-review'
      const purpose = auditContract ? (parentExecution.purpose === 'improve' && template.id !== REVIEW_TEMPLATE ? 'improve' : 'review') : 'solve'
      const run = attempt ??= await startAttempt(apparatus, { agentId: childId, sessionId: node.sessionId, model: { provider: route.provider!, model: route.model! } },
        taskId, taskId + ':attempt:' + Object.values(state.runs).length, revision, { domain, purpose })
      const workspace = workspaceOf(apparatus, taskId, run.runId)
      if (run.bubble === undefined) refuse('illegal-transition', 'the working Run has no prepared execution bubble')
      const model = run.bubble.model
      const started = apparatus.store.load().entries().find(fact => fact.subject === taskId && fact.kind === TASK_KINDS.runStarted &&
        (fact.payload as { runId: string }).runId === run.runId)!
      const text = [
        `You are responsible for Task ${taskId}, Run ${run.runId}.`,
        'Goal: ' + state.contract!.goal,
        'Supported TaskTemplates:\n' + JSON.stringify([...domain.templates.values()].map(templateDeclaration)),
        `Workspace: ${workspace}. Use the standard DSH file, bash and skill tools here for reads, edits and local checks. Local checks do not consume a Task attempt.`,
        `This Task/Run is already started. Continue this existing Run; decompose your own Task if needed, then solve and submit this exact taskId through singularity_submit_program. Attempt ${Object.keys(taskStateOf(apparatus, taskId).runs).length} of ${maxRuns}.`,
        'Each singularity_submit_program call consumes one attempt and seals this Run. Submit only your final answer; never use submission to probe the interface. Its program argument must contain the complete final source text, not a path or a placeholder.',
        'Input: ' + join(workspace, template.input.name),
        'Input content:\n' + Buffer.from(await resolveInputs(apparatus, state.contract!, domain)[0]!.read()).toString('utf8'),
        ...(template.initial === undefined ? [] : ['Initial source:\n' + Buffer.from(template.initial.bytes).toString('utf8')]),
        template.submission === 'program' ? 'Your Node ES module receives the input path in process.argv[2]; print the artifact to stdout.' : 'Your source is judged as written.',
        'The independent verifier judges artifact ' + join(workspace, template.artifact) + ' against ' + state.contract!.criteria.map(criterion => criterion.criterionId).join(', ') + '.',
        'Local check command (standard bash tool): ' + JSON.stringify([process.execPath, template.verifier.program,
          ...template.verifier.args.map(arg => arg.replace('{artifact}', join(workspace, template.artifact)).replace('{input}', join(workspace, template.input.name)))]) + '.',
        ...(previous?.failureCause === 'acceptance' ? [`Previous Run ${previous.runId} failed acceptance: ${previous.failureReason}. Correct the answer in this new Run; do not change prior Run files.`] : []),
      ].join('\n')
      const message = schedulerMessage({ kind: 'singularity', purpose: 'dispatch',
        controlId: apparatus.controlId, parentTaskId, taskId, runId: run.runId, factSeq: started.seq }, text)
      if (session === undefined) {
        session = await open({ agentId: taskId, cwd: workspace, parent, model, message, signal: lifecycle.signal })
        live.set(taskId, session)
      } else await session.post(message)
      const actual = session.agent?.session.requestHeader()?.config ?? session.agent?.options
      if (actual !== undefined && (actual.provider !== model.provider || actual.model !== model.model))
        refuse('illegal-transition', 'the child model route differs from its frozen Run bubble')
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
      lifecycle.abort()
      const pending = await Promise.allSettled([...advancing.values()])
      const failures = pending.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      for (const [taskId, session] of live) try { await release(taskId, session) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'child unload failed')
    })(),
  }
}
