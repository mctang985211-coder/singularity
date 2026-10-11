

import type { Agent } from '@deepseek-ai/dsh-agent'

import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { projectReceipt, projectTask } from '../../src/task/view.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { PlanRecord, PlannedChild, Proposal, Status } from './driver.ts'
import { taskIdOf, runIdOf } from './ids.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
export async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  parent: Agent | undefined,
  input: { readonly taskId: string; readonly children: readonly PlannedChild[] },
): Promise<PlanRecord> {
  await bindCaller(apparatus, caller)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const declared = apparatus.domain.inputs[0]!
  if (projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).some(plan => plan.children.some(child => child.taskId === input.taskId)))
    refuse('illegal-transition', `task "${input.taskId}" is already a sub-task of a plan; this deployment does not decompose a sub-task`)

  const named = await Promise.all(
    input.children.map(async child => {
      const taskId = taskIdOf(apparatus.controlId, input.taskId, child.key)
      return { taskId, contract: { goal: child.goal, inputs: [declared.path], criteria: [apparatus.domain.criterion] }, child }
    }),
  )
  const agentOf = new Map<string, string>()
  for (const entry of named) {
    const childAgentId = String(agentSessionIdOf(entry.taskId))
    agentOf.set(entry.taskId, childAgentId)
    declareCaller(apparatus, childAgentId)
    await apparatus.agents.open({
      commandId: `agent:${childAgentId}`,
      agentId: childAgentId,
      // The node records the session to resume, which is the one the child runs on. It is the same
      // string as the agent id because that is exactly how DSH derives one from the other.
      sessionId: childAgentId,
      role: 'child',
    })
  }
  const byKey = new Map(input.children.map((child, index) => [child.key, named[index]!.taskId]))
  for (const entry of named) {
    await commands.admit({ commandId: `admit:${entry.taskId}`, taskId: entry.taskId, contract: entry.contract })
    await commands.assign({ commandId: `assign:${entry.taskId}`, taskId: entry.taskId, agentId: agentOf.get(entry.taskId)! })
  }
  await commands.decompose({
    commandId: `decompose:${input.taskId}`,
    parentTaskId: input.taskId,
    children: named.map(entry => ({
      taskId: entry.taskId,
      dependsOn: entry.child.dependsOn.map(key => {
        const resolved = byKey.get(key)
        if (resolved === undefined)
          refuse('malformed-declaration', `sub-task "${entry.child.key}" declares a dependency on "${key}", which is not one of the keys this plan declares; a dependency outside the batch cannot be scheduled`)
        return resolved
      }),
      supports: entry.child.supports,
      maxRuns: entry.child.maxRuns,
    })),
  })
  return { taskId: input.taskId, opened: await scheduler.advance(parent) }
}

export async function propose(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly goal: string }): Promise<Proposal> {
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal)
  const runId = runIdOf(apparatus.controlId, caller.sessionId, callId)
  const previous = apparatus.store.committedOf(`start:${runId}`)
  if (previous !== undefined && previous.subject !== taskId)
    refuse('command-conflict', 'the proposal call was committed for a different goal')
  await bindCaller(apparatus, caller)
  const declared = apparatus.domain.inputs[0]!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  if (apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId) === undefined)
    await commands.admit({ commandId: `propose:${runId}`, taskId,
      contract: { goal: input.goal, inputs: [declared.path], criteria: [apparatus.domain.criterion] } })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, taskId, callId)
  return { taskId, runId: run.runId, workspace: workspaceOf(apparatus, taskId, run.runId),
    criterionId: apparatus.domain.criterion.criterionId, phase: 'running' }
}
export async function status(apparatus: Apparatus, caller: Caller, input: { readonly taskId: string }): Promise<Status> {
  const state = taskStateOf(apparatus, input.taskId)
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', `task "${input.taskId}" is the responsibility of agent "${state.responsibility?.agentId ?? 'nobody'}", so agent "${caller.agentId}" cannot read it`)
  const view = projectTask(state)
  const latest = view.runs.at(-1)
  if (latest === undefined || latest.status === 'running') return { phase: view.phase, runs: view.runs.length, receipt: null }
  return {
    phase: view.phase,
    runs: view.runs.length,
    receipt: projectReceipt(apparatus.registry, apparatus.store.load().entries(), input.taskId, latest.runId),
  }
}
