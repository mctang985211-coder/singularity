import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { assertDecomposition } from '../../src/task/decomposition.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { projectReceipt, projectTask } from '../../src/task/view.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { DecomposeInput, PlanRecord, PlannedChild, Proposal, Status } from './driver.ts'
import { taskIdOf, runIdOf } from './ids.ts'
import { contractFor, resolveInputs } from './inputs.ts'
import { record, text } from './shape.ts'
import type { Domain } from './domain.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { seedMethod, domainForRun, loadMethod, publishedMethod, methodOfRun } from './method.ts'
import { consumeMethod, methodContext } from './method-run.ts'
import { readScopeOf, readTask, templateDeclaration } from './read.ts'
export async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  input: DecomposeInput,
): Promise<PlanRecord> {
  assertClosedKeys(input, ['taskId', 'children', 'useTemplateDecomposition'], 'Task decomposition', 'malformed-declaration')
  if (input.useTemplateDecomposition !== undefined && input.useTemplateDecomposition !== true)
    refuse('malformed-declaration', 'useTemplateDecomposition must be true')
  if ((input.children === undefined) === (input.useTemplateDecomposition !== true))
    refuse('malformed-declaration', 'choose either children or useTemplateDecomposition')
  const state = taskStateOf(apparatus, input.taskId)
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', 'the caller is not responsible for this Task')
  const parentRun = Object.values(state.runs).findLast(run => run.status === 'running' && run.stage === 'working')
  if (parentRun === undefined) refuse('illegal-transition', 'only a working parent Run may delegate')
  const domain = await domainForRun(apparatus, parentRun)
  const parentTemplate = domain.templates.get(state.contract!.template.id)!
  const definition = input.useTemplateDecomposition === true ? parentTemplate.decomposition : undefined
  if (input.useTemplateDecomposition === true && definition === undefined)
    refuse('malformed-declaration', 'the pinned TaskTemplate declares no decomposition')
  const children = definition?.children ?? input.children
  if (!Array.isArray(children)) refuse('malformed-declaration', 'children must be a complete plan')
  if (children.length === 0) refuse('malformed-declaration', 'a task batch must contain at least one child')
  const named: { key: string; taskId: string; template: import('./template.ts').TaskTemplate; child: PlannedChild; revision: RevisionRef | undefined; domain: import('./domain.ts').Domain }[] = []
  for (const [index, child] of children.entries()) {
    const declared = record(child, `children[${index}]`)
    assertClosedKeys(declared, ['key', 'template', 'contract', 'method', 'dependsOn', 'supports', 'maxRuns'], `children[${index}]`, 'malformed-declaration')
    const key = text(declared, 'key', `children[${index}]`)
    const revision = child.method ?? methodOfRun(apparatus, parentRun)
    const selectedDomain = revision === undefined ? domain : { ...(await loadMethod(apparatus, revision)).domain, inputs: domain.inputs }
    if (child.contract !== undefined) refuse('malformed-declaration', 'free contracts require unified Revision admission before decomposition')
    const id = text(declared, 'template', `children[${index}]`)
    const template = selectedDomain.templates.get(id)
    if (template === undefined) refuse('malformed-declaration', 'unknown child template: ' + id)
    named.push({ key, taskId: taskIdOf(apparatus.controlId, input.taskId, key), template, child, revision, domain: selectedDomain })
  }
  if (new Set(named.map(entry => entry.key)).size !== named.length) refuse('malformed-declaration', 'task batch repeats a child key')
  const byKey = new Map(named.map(entry => [entry.key, entry]))
  for (const existing of state.decomposition?.children ?? []) {
    const child = taskStateOf(apparatus, existing.taskId)
    const childDomain = child.contract!.assets === undefined ? domain : (await loadMethod(apparatus, child.contract!.assets)).domain
    const template = childDomain.templates.get(child.contract!.template.id)!
    const key = existing.taskId
    byKey.set(key, { key, taskId: existing.taskId, template, child: { key, template: template.id, dependsOn: [], supports: [], maxRuns: existing.maxRuns }, revision: child.contract!.assets, domain: childDomain })
  }
  const additions = named.map(entry => ({
    taskId: entry.taskId,
    dependsOn: Array.isArray(entry.child.dependsOn) ? entry.child.dependsOn.map((key: string) => {
      const dependency = byKey.get(key)
      if (dependency === undefined) refuse('malformed-declaration', 'unknown dependency key: ' + key)
      return dependency.taskId
    }) : entry.child.dependsOn,
    supports: entry.child.supports, maxRuns: entry.child.maxRuns,
  }))
  const prepared = named.map(entry => {
    const source = entry.template.input.source
    let producer: string | undefined
    if (source.kind === 'artifact') {
      const matches = entry.child.dependsOn.map((key: string) => byKey.get(key)!).filter((other: typeof named[number]) => other.template.id === source.template)
      if (matches.length !== 1) refuse('malformed-declaration', 'artifact input requires exactly one dependency with template ' + source.template)
      producer = matches[0]!.taskId
    }
    return { taskId: entry.taskId, contract: { ...contractFor(entry.domain, entry.template, entry.template.goal, producer), ...(entry.revision === undefined ? {} : { assets: entry.revision }) } }
  })
  const fresh = additions.filter((addition, index) => {
    const existing = state.decomposition?.children.find(child => child.taskId === addition.taskId)
    if (existing === undefined) return true
    if (digestOf(existing) !== digestOf(addition) ||
      digestOf(taskStateOf(apparatus, addition.taskId).contract) !== digestOf(prepared[index]!.contract))
      refuse('command-conflict', 'child key already belongs to a different immutable declaration')
    return false
  })
  assertDecomposition([...(state.decomposition?.children ?? []), ...fresh], state.contract!, input.taskId)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  for (const entry of prepared.filter(entry => fresh.some(child => child.taskId === entry.taskId))) {
    const agentId = String(agentSessionIdOf(entry.taskId))
    declareCaller(apparatus, agentId)
    await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'child' })
    await commands.admit({ commandId: `admit:${entry.taskId}`, taskId: entry.taskId, contract: entry.contract })
    await commands.assign({ commandId: `assign:${entry.taskId}`, taskId: entry.taskId, agentId })
  }
  if (fresh.length !== 0)
    await commands.decompose({ commandId: `decompose:${input.taskId}:${digestOf(fresh)}`, parentTaskId: input.taskId, children: fresh })
  if (definition !== undefined)
    await consumeMethod(apparatus, input.taskId, parentRun, `decomposition:${parentTemplate.id}`, `decomposition:${parentTemplate.id}:${digestOf(definition)}`)
  return { taskId: input.taskId, opened: await scheduler.advance(input.taskId) }
}

export async function propose(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly goal: string; readonly method?: RevisionRef }, context: { purpose: string; relatedTo?: { taskId: string; runId: string } } = { purpose: 'solve' }): Promise<Proposal> {
  const method = input.method ?? publishedMethod(apparatus) ?? await seedMethod(apparatus)
  const domain = (await loadMethod(apparatus, method)).domain
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, input.goal + '\u0000' + method.digest)
  const runId = runIdOf(apparatus.controlId, caller.sessionId, callId)
  const previous = apparatus.store.committedOf(`start:${runId}`)
  if (previous !== undefined && previous.subject !== taskId)
    refuse('command-conflict', 'the proposal call was committed for a different goal')
  await bindCaller(apparatus, caller)
  const template = domain.templates.get(domain.rootTemplate)!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  if (apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId) === undefined)
    await commands.admit({ commandId: `propose:${runId}`, taskId,
      contract: { ...contractFor(domain, template, input.goal), assets: method } })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, taskId, callId, method, { domain, ...context })
  return proposalOf(apparatus, taskStateOf(apparatus, taskId), run, domain)
}

export async function retry(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly taskId: string }): Promise<Proposal> {
  assertClosedKeys(input, ['taskId'], 'Task retry', 'malformed-declaration')
  const task = taskStateOf(apparatus, input.taskId)
  if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'the caller does not own this Task')
  const runId = runIdOf(apparatus.controlId, caller.sessionId, callId)
  const committed = apparatus.store.committedOf(`start:${runId}`)
  if (committed !== undefined && committed.subject !== task.taskId) refuse('command-conflict', 'retry call belongs to another Task')
  const recorded = task.runs[runId]
  if (recorded !== undefined) return proposalOf(apparatus, task, recorded, await domainForRun(apparatus, recorded))
  const previous = Object.values(task.runs).at(-1)
  if (previous?.status !== 'failed') refuse('illegal-transition', 'only a failed Task Run may be retried')
  const parent = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .find(parent => parent.decomposition?.children.some(child => child.taskId === task.taskId))
  const limit = parent?.decomposition!.children.find(child => child.taskId === task.taskId)!.maxRuns
  if (limit !== undefined && Object.keys(task.runs).length >= limit) refuse('budget-exhausted', 'the child Task Run budget is exhausted')
  const domain = await domainForRun(apparatus, previous)
  const context = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, previous.revision.environmentId)!
    .revisions[previous.revision.revisionId]!.manifest as { purpose: string; relatedTo?: { taskId: string; runId: string } }
  const run = await startAttempt(apparatus, caller, task.taskId, callId, methodOfRun(apparatus, previous), { domain,
    purpose: context.purpose, ...(context.relatedTo === undefined ? {} : { relatedTo: context.relatedTo }) })
  return proposalOf(apparatus, taskStateOf(apparatus, task.taskId), run, domain)
}

async function proposalOf(apparatus: Apparatus, task: TaskState, run: RunState, domain: Domain): Promise<Proposal> {
  const template = domain.templates.get(task.contract!.template.id)!
  const bytes = await resolveInputs(apparatus, task.contract!, domain)[0]!.read()
  return { taskId: task.taskId, runId: run.runId, workspace: workspaceOf(apparatus, task.taskId, run.runId),
    criterionId: template.criterion.criterionId, phase: run.status, submission: template.submission, input: template.input.name, artifact: template.artifact,
    inputContent: Buffer.from(bytes).toString('utf8'),
    initialSource: template.initial === undefined ? null : Buffer.from(template.initial.bytes).toString('utf8'), rootTemplate: domain.rootTemplate,
    templates: [...domain.templates.values()].map(templateDeclaration),
    methodContext: methodOfRun(apparatus, run) === undefined ? null : await methodContext(apparatus, task.taskId, run) }
}
export async function status(apparatus: Apparatus, caller: Caller, input: { readonly taskId: string }): Promise<Status> {
  const state = taskStateOf(apparatus, input.taskId)
  const { visible } = await readScopeOf(apparatus, caller.agentId)
  if (!visible!.has(input.taskId))
    refuse('not-responsible', `task "${input.taskId}" is the responsibility of agent "${state.responsibility?.agentId ?? 'nobody'}", so agent "${caller.agentId}" cannot read it`)
  const view = projectTask(state)
  const task = await readTask(apparatus, state)
  const latest = view.runs.at(-1)
  if (latest === undefined || latest.status === 'running') return { phase: view.phase, runs: view.runs.length, receipt: null, task }
  return {
    phase: view.phase,
    runs: view.runs.length,
    receipt: projectReceipt(apparatus.registry, apparatus.store.load().entries(), input.taskId, latest.runId),
    task,
  }
}
