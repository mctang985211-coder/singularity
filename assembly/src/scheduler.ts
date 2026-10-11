import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { closeAgentSession } from '../../src/runtime/agent-session.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { templateOf } from './domain.ts'
import { workspaceOf, startAttempt } from './attempt.ts'

export interface Scheduler {
  advance(parent: Agent | undefined): Promise<readonly string[]>
  settled(): Promise<readonly string[]>
  close(): Promise<void>
}
export type OpenChild = (request: ChildSessionRequest) => Promise<ChildSession>

export function createScheduler(apparatus: Apparatus, seams: ChildSessionSeams,
  open: OpenChild = request => openChildSession(seams, request)): Scheduler {
  const live = new Map<string, ChildSession>()
  const openReady = async (given?: Agent): Promise<readonly string[]> => {
    const opened: string[] = []
    for (const plan of projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))) {
      const ready = plan.children.filter(child => child.status === 'ready' && !live.has(child.taskId))
      if (ready.length === 0) continue
      const holder = taskStateOf(apparatus, plan.parentTaskId).responsibility!.agentId
      const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry | undefined
      const parent = given?.id === holder ? given : registry?.get(SessionId(holder))
      if (parent === undefined) refuse('unknown-emitter-role', 'the plan has no live parent: ' + holder)
      for (const child of ready) opened.push(await openOne(parent, child.taskId))
    }
    return opened
  }
  const openOne = async (parent: Agent, taskId: string): Promise<string> => {
    const state = taskStateOf(apparatus, taskId)
    const template = templateOf(apparatus.domain, state.contract!.template)
    const childId = state.responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, childId)!
    const header = parent.session.requestHeader()
    if (header === undefined) refuse('malformed-declaration', 'the parent has no model route')
    const model = { provider: header.config.provider, model: header.config.model }
    declareCaller(apparatus, childId)
    const run = await startAttempt(apparatus, { agentId: childId, sessionId: node.sessionId, model: model.provider + '/' + model.model },
      taskId, taskId + ':attempt:' + Object.values(state.runs).length)
    const workspace = workspaceOf(apparatus, taskId, run.runId)
    let session: ChildSession | undefined
    try {
      session = await open({ agentId: taskId, cwd: workspace, parent, model, compose: () => undefined })
      live.set(taskId, session)
      await session.say([
        'You are responsible for task ' + taskId + ', Run ' + run.runId + '.',
        'Goal: ' + state.contract!.goal,
        'Workspace: ' + workspace,
        'This Task/Run is already started. Do not propose or decompose; solve and submit this exact taskId through singularity_submit_program.',
        'Input: ' + template.input.name,
        template.submission === 'program' ? 'Your Node ES module receives the input path in process.argv[2]; print the artifact to stdout.' : 'Your source is judged as written.',
        'The independent verifier judges artifact ' + template.artifact + ' against ' + state.contract!.criteria.map(criterion => criterion.criterionId).join(', ') + '.',
      ].join('\n'))
    } catch (error) {
      const failures: unknown[] = [error]
      try { await apparatus.tasks.forAgent(childId).failRun({
        commandId: 'dispatch-failed:' + taskId + '/' + run.runId, taskId, runId: run.runId, reason: 'child-runtime-failed: ' + String(error),
      }) } catch (failure) { failures.push(failure) }
      if (session !== undefined) {
        live.delete(taskId)
        try { session.stop(); await closeAgentSession(taskId) } catch (failure) { failures.push(failure) }
      }
      if (failures.length === 1) throw error
      throw new AggregateError(failures, 'child dispatch failed: ' + String(error))
    }
    return taskId
  }
  return {
    advance: async parent => {
      if (parent === undefined) refuse('malformed-declaration', 'there is no live parent for this plan')
      return await openReady(parent)
    },
    settled: () => openReady(),
    close: async () => {
      const failures: unknown[] = []
      for (const [taskId, session] of live) {
        try { session.stop() } catch (error) { failures.push(error) }
        try { await closeAgentSession(taskId); live.delete(taskId) } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'child unload failed')
    },
  }
}
