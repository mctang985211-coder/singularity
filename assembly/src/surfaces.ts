import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { contractDigest } from '../../src/task/contract.ts'
import { assertDecomposition } from '../../src/task/decomposition.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { projectReceipt, projectTask } from '../../src/task/view.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { PlanRecord, PlannedChild, Proposal, Status } from './driver.ts'
import { taskIdOf, runIdOf } from './ids.ts'
import { contractFor } from './inputs.ts'
import { record, text } from './shape.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { domainForRun, loadMethod, publishedMethod } from './method.ts'
function requirePlanner(apparatus: Apparatus, caller: Caller): void {
  if (apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, caller.agentId)?.role === 'child')
    refuse('illegal-transition', 'an assigned child executes its existing Task; only a root may propose or decompose')
}
export async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  input: { readonly taskId: string; readonly children: readonly PlannedChild[] },
): Promise<PlanRecord> {
  const state = taskStateOf(apparatus, input.taskId)
  const parentRun = Object.values(state.runs).findLast(run => run.status === 'running') ?? Object.values(state.runs).at(-1)!
  const domain = await domainForRun(apparatus, parentRun)
  requirePlanner(apparatus, caller)
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', 'the caller is not responsible for this Task')
  const plans = projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))
  if (plans.some(plan => plan.children.some(child => child.taskId === input.taskId)))
    refuse('illegal-transition', 'this deployment does not decompose a child Task')
  if (!Array.isArray(input.children)) refuse('malformed-declaration', 'children must be a complete plan')
  const named = input.children.map((child: PlannedChild, index: number) => {
    const declared = record(child, `children[${index}]`)
    assertClosedKeys(declared, ['key', 'template', 'dependsOn', 'supports', 'maxRuns'], `children[${index}]`, 'malformed-declaration')
    const key = text(declared, 'key', `children[${index}]`)
    const id = text(declared, 'template', `children[${index}]`)
    const template = domain.templates.get(id)
    if (template === undefined) refuse('malformed-declaration', 'unknown child template: ' + id)
    return { key, taskId: taskIdOf(apparatus.controlId, input.taskId, key), template, child }
  })
  const byKey = new Map(named.map(entry => [entry.key, entry]))
  const children = assertDecomposition(named.map(entry => ({
    taskId: entry.taskId,
    dependsOn: Array.isArray(entry.child.dependsOn) ? entry.child.dependsOn.map(key => {
      const dependency = byKey.get(key)
      if (dependency === undefined) refuse('malformed-declaration', 'unknown dependency key: ' + key)
      return dependency.taskId
    }) : entry.child.dependsOn,
    supports: entry.child.supports, maxRuns: entry.child.maxRuns,
  })), state.contract!, input.taskId)
  const prepared = named.map(entry => {
    const source = entry.template.input.source
    let producer: string | undefined
    if (source.kind === 'artifact') {
      const matches = entry.child.dependsOn.map(key => byKey.get(key)!).filter(other => other.template.id === source.template)
      if (matches.length !== 1) refuse('malformed-declaration', 'artifact input requires exactly one dependency with template ' + source.template)
      producer = matches[0]!.taskId
    }
    return { taskId: entry.taskId, contract: contractFor(domain, entry.template, entry.template.goal, producer) }
  })
  if (state.decomposition !== undefined) {
    if (digestOf(state.decomposition.children) !== digestOf(children) || prepared.some(entry =>
      contractDigest(taskStateOf(apparatus, entry.taskId).contract!) !== contractDigest(entry.contract)))
      refuse('command-conflict', 'the committed plan has different children or contracts')
    return { taskId: input.taskId, opened: [] }
  }
  if (!Object.values(state.runs).some(run => run.status === 'running' && run.stage === 'working'))
    refuse('illegal-transition', 'only a working parent Run may delegate')
  const commands = apparatus.tasks.forAgent(caller.agentId)
  for (const entry of prepared) {
    const agentId = String(agentSessionIdOf(entry.taskId))
    declareCaller(apparatus, agentId)
    await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'child' })
    await commands.admit({ commandId: `admit:${entry.taskId}`, taskId: entry.taskId, contract: entry.contract })
    await commands.assign({ commandId: `assign:${entry.taskId}`, taskId: entry.taskId, agentId })
  }
  await commands.decompose({ commandId: `decompose:${input.taskId}`, parentTaskId: input.taskId, children })
  return { taskId: input.taskId, opened: await scheduler.advance(input.taskId) }
}

export async function propose(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly goal: string; readonly method?: RevisionRef }): Promise<Proposal> {
  const method = input.method ?? publishedMethod(apparatus)
  const domain = method === undefined ? apparatus.domain : (await loadMethod(apparatus, method)).domain
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal + (method === undefined ? '' : '\u0000' + method.digest))
  const runId = runIdOf(apparatus.controlId, caller.sessionId, callId)
  const previous = apparatus.store.committedOf(`start:${runId}`)
  if (previous !== undefined && previous.subject !== taskId)
    refuse('command-conflict', 'the proposal call was committed for a different goal')
  requirePlanner(apparatus, caller)
  await bindCaller(apparatus, caller)
  const template = domain.templates.get(domain.rootTemplate)!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  if (apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId) === undefined)
    await commands.admit({ commandId: `propose:${runId}`, taskId,
      contract: contractFor(domain, template, input.goal) })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, taskId, callId, method)
  return { taskId, runId: run.runId, workspace: workspaceOf(apparatus, taskId, run.runId),
    criterionId: template.criterion.criterionId, phase: 'running', submission: template.submission, input: template.input.name, artifact: template.artifact,
    templates: [...domain.templates.values()].map(template => ({ id: template.id, goal: template.goal, criterionId: template.criterion.criterionId, input: template.input })) }
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
