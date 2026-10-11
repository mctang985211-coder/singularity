import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { ReceiptView, TaskView } from '../../src/task/view.ts'
import { callerOf, openApparatus } from './apparatus.ts'
import type { Apparatus } from './apparatus.ts'
import type { TaskTemplate } from './template.ts'
import type { Domain } from './domain.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { repair } from './repair.ts'
import { createScheduler, DispatchError } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, status } from './surfaces.ts'
import { submit, type Submission } from './submission.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { singularity: TaskService }
}
export interface TaskService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
}
export interface AgentTaskSurface {
  propose(input: { readonly goal: string }): Promise<Proposal>
  decompose(input: { readonly taskId: string; readonly children: readonly PlannedChild[] }): Promise<PlanRecord>
  submit(input: { readonly taskId: string; readonly program: string }): Promise<Submission>
  status(input: { readonly taskId: string }): Promise<Status>
}
export interface PlannedChild {
  readonly key: string
  readonly template: string
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
}
export interface PlanRecord { readonly taskId: string; readonly opened: readonly string[] }
export interface Proposal {
  readonly taskId: string
  readonly runId: string
  readonly workspace: string
  readonly criterionId: string
  readonly phase: TaskView['phase']
  readonly submission: 'program' | 'source'
  readonly input: string
  readonly artifact: string
  readonly templates: readonly { readonly id: string; readonly goal: string; readonly criterionId: string; readonly input: TaskTemplate['input'] }[]
}
export interface Status {
  readonly phase: TaskView['phase']
  readonly runs: number
  readonly receipt: ReceiptView | null
}
export interface DriverOptions {
  readonly attachments: Apparatus['attachments']
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends TaskService {
  activate(sessionId: string): Promise<void>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence, options.attachments)
  const admission: Admission = exec => {
    if (exec.agent === undefined || ['singularity_task_status', 'singularity_propose_task', 'singularity_submit_program'].includes(exec.name)) return undefined
    const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const owned = [...tasks.values()].filter(task => task.responsibility?.agentId === exec.agent!.id)
    const active = owned.flatMap(task => Object.values(task.runs).filter(run => run.status === 'running'))
    if (active.some(run => run.stage !== 'working') || (active.length === 0 && owned.some(task => Object.keys(task.runs).length > 0)))
      return 'this Run has closed write admission'
    if (owned.some(task => task.decomposition?.children.some(child =>
      !Object.values(tasks.get(child.taskId)!.runs).some(run => run.status === 'verified'))))
      return 'the parent Task is waiting for delegated work'
    return undefined
  }
  const active = new Set<Promise<unknown>>()
  const lifecycleErrors = new Set<unknown>()
  const controller = new AbortController()
  let closing: Promise<void> | undefined
  const work = <T>(step: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) refuse('illegal-transition', 'the driver is closing')
    const pending = step()
    active.add(pending)
    void pending.then(() => active.delete(pending), () => active.delete(pending))
    return pending
  }
  const scheduler = createScheduler(apparatus, options.seams)
  const parentPlanOf = (taskId: string): string | undefined =>
    [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(task => task.decomposition?.children.some(child => child.taskId === taskId))?.taskId
  const execution = options.execution(admission, failure => {
    void work(async () => {
      const cut = apparatus.store.load()
      const owners = [...cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values()]
        .filter(agent => agent.sessionId === failure.sessionId).map(agent => agent.agentId)
      for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
        const agentId = task.responsibility?.agentId
        if (agentId === undefined || !owners.includes(agentId)) continue
        for (const run of Object.values(task.runs)) {
          if (run.status !== 'running' || run.stage !== 'working') continue
          await apparatus.tasks.forAgent(agentId).failRun({
            commandId: `turn-failed:${failure.sessionId}/${failure.seq}/${run.runId}`, taskId: task.taskId, runId: run.runId,
            reason: 'session-turn-failed: ' + JSON.stringify(failure),
          })
          const parentTaskId = parentPlanOf(task.taskId)
          if (parentTaskId !== undefined) await scheduler.advance(parentTaskId)
        }
      }
    }).catch(error => lifecycleErrors.add(error))
  })
  try { await repair(apparatus) } catch (error) {
    const cleanup = await Promise.allSettled([execution.close(), apparatus.store.close()])
    throw new AggregateError([error, ...cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'driver recovery failed')
  }
  return {
    activate: sessionId => work(async () => {
      const cut = apparatus.store.load()
      for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
        if (task.decomposition === undefined || task.responsibility === undefined) continue
        const holder = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)
        if (holder?.sessionId === sessionId) await scheduler.advance(task.taskId)
      }
    }),
    forCall: exec => {
      const agent = execution.assertCaller(exec)
      const caller = callerOf(agent)
      return {
        propose: input => work(() => propose(apparatus, caller, String(exec.callId), input)),
        decompose: input => work(() => decompose(apparatus, scheduler, caller, input)),
        submit: input => work(async () => {
          const cutoff = apparatus.store.load().entries().length
          let answer: Submission
          try { answer = await submit(apparatus, execution, caller, exec, input, AbortSignal.any([controller.signal, exec.signal])) }
          catch (error) {
            const failed = apparatus.store.load().entries().slice(cutoff).some(fact => fact.subject === input.taskId && fact.kind === TASK_KINDS.runFailed)
            const parentTaskId = parentPlanOf(input.taskId)
            if (failed && parentTaskId !== undefined) try { await scheduler.advance(parentTaskId) }
            catch (dispatch) { throw new AggregateError([error, dispatch], 'submission and parent notification failed') }
            throw error
          }
          const terminal = apparatus.store.load().entries().slice(cutoff).some(fact => fact.subject === answer.taskId &&
            (fact.kind === TASK_KINDS.runVerified || fact.kind === TASK_KINDS.runFailed) && (fact.payload as { runId: string }).runId === answer.runId)
          const parentTaskId = parentPlanOf(answer.taskId)
          if (terminal && parentTaskId !== undefined) try { await scheduler.advance(parentTaskId) } catch (error) {
            return { ...answer, dispatchError: { parentTaskId, taskId: error instanceof DispatchError ? error.taskId : answer.taskId,
              runId: error instanceof DispatchError ? error.runId : answer.runId, detail: error instanceof Error ? error.message : String(error) } }
          }
          return answer
        }),
        status: input => status(apparatus, caller, input),
      }
    },
    read: () => snapshotOf(apparatus),
    close: () => closing ??= (async () => {
      controller.abort(new Error('the driver is unloading'))
      const failed: unknown[] = []
      try { await execution.close() } catch (error) { failed.push(error) }
      const pending = await Promise.allSettled([...active])
      failed.push(...pending.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
      failed.push(...lifecycleErrors)
      try { await scheduler.close() } catch (error) { failed.push(error) }
      try { await apparatus.store.close() } catch (error) { failed.push(error) }
      if (failed.length > 0) throw new AggregateError(failed, 'driver unload failed')
    })(),
  }
}
