import { digestOf } from '../../src/protocol/envelope.ts'
import { assertContract, type TaskContract } from '../../src/task/contract.ts'
import { assertDecomposition } from '../../src/task/decomposition.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { DecomposeInput, PlanRecord, Proposal } from './driver.ts'
import { taskIdOf, runIdOf } from './ids.ts'
import { contractFor } from './inputs.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { bindingsForContract, seedMethod, loadMethod, publishedMethod } from './method.ts'
import { consumeMethod, methodContext } from './method-run.ts'
import { reviewOf } from './review.ts'
import { assertActive, readScopeOf } from './coordination.ts'

const responsibilityDigest = ({ template: _template, ...responsibility }: TaskContract): string =>
  digestOf(responsibility)
export async function decompose(
  apparatus: Apparatus,
  scheduler: Scheduler,
  caller: Caller,
  input: DecomposeInput,
): Promise<PlanRecord> {
  const review = reviewOf(apparatus, caller.agentId)
  const parent = review === undefined ? taskStateOf(apparatus, input.taskId) : undefined
  const parentId = review?.reviewId ?? input.taskId
  const run =
    parent === undefined
      ? undefined
      : Object.values(parent.runs).findLast((r) => r.status === 'running' && r.stage === 'working')
  if (
    review === undefined
      ? parent!.responsibility?.agentId !== caller.agentId || run === undefined
      : review.status !== 'running'
  )
    refuse('not-responsible', 'only the working owner may decompose')
  const revision = review?.method ?? run!.revision
  const { domain, assets } = await loadMethod(apparatus, revision)
  const existing = review?.children ?? parent!.decomposition?.children ?? []
  const standards = review?.criteria ?? parent!.contract!.criteria
  const template =
    parent?.contract?.template === undefined ? undefined : domain.templates.get(parent.contract.template.id)
  const recipe = input.useTemplateDecomposition === true ? template?.decomposition : undefined
  if (input.useTemplateDecomposition && recipe === undefined)
    refuse('malformed-declaration', 'no pinned decomposition recipe')
  const children: readonly import('./driver.ts').PlannedChild[] | undefined = recipe?.children ?? input.children
  if (children === undefined || children.length === 0) refuse('malformed-declaration', 'decomposition needs children')
  const { visible } = await readScopeOf(apparatus, caller.agentId)
  const verified = (id: string) => visible!.has(id) && Object.values(taskStateIf(apparatus, id)?.runs ?? {})
    .some((r) => r.status === 'verified')
  const ids = new Map(existing.map((c) => [c.taskId, c.taskId]))
  for (const child of children) {
    if (ids.has(child.key)) refuse('malformed-declaration', 'duplicate child key')
    ids.set(child.key, taskIdOf(apparatus.controlId, parentId, child.key))
  }
  const prepared = children.map((child) => {
    if ((child.template === undefined) === (child.contract === undefined))
      refuse('malformed-declaration', 'choose a template or a task contract')
    const dependsOn = child.dependsOn.map((key) => {
      const id = ids.get(key)
      if (id === undefined) refuse('malformed-declaration', 'unknown dependency ' + key)
      return id
    })
    let contract: TaskContract
    if (child.contract !== undefined)
      contract = assertContract(
        {
          ...child.contract,
          inputs: child.contract.inputs.map((input) => ({
            ...input,
            source:
              input.source.kind === 'artifact'
                ? { ...input.source, taskId: ids.get(input.source.taskId) ?? input.source.taskId }
                : input.source,
          })),
        },
        'child contract',
      )
    else {
      const selected = domain.templates.get(child.template!)
      if (selected === undefined) refuse('malformed-declaration', 'unknown template ' + child.template)
      let producer: string | undefined
      if (selected.input.source.kind === 'artifact') {
        const sourceTemplate = selected.input.source.template
        const matches = new Set(
          children
            .filter((other) => other.template === sourceTemplate && child.dependsOn.includes(other.key))
            .map((other) => ids.get(other.key)!),
        )
        for (const id of dependsOn)
          if (taskStateIf(apparatus, id)?.contract?.template?.id === sourceTemplate) matches.add(id)
        if (matches.size !== 1) refuse('malformed-declaration', 'template input needs exactly one declared producer')
        producer = [...matches][0]
      }
      contract = contractFor(domain, selected, selected.goal, producer)
    }
    for (const input of contract.inputs)
      if (input.source.kind === 'artifact' && !dependsOn.includes(input.source.taskId) && !verified(input.source.taskId))
        refuse('malformed-declaration', 'artifact producers must be declared dependencies or verified visible evidence')
    bindingsForContract(contract, domain, assets)
    if (child.handoff !== undefined && child.handoff.evidence.some((id) => !verified(id)))
      refuse('not-responsible', 'handoff evidence must cite verified Tasks in the parent context')
    const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    let ancestor = parent ?? (review?.target.kind === 'acceptance' ? tasks.get(review.target.taskId) : undefined)
    while (ancestor !== undefined) {
      if (responsibilityDigest(ancestor.contract!) === responsibilityDigest(contract))
        refuse(
          'cyclic-dependency',
          'child repeats an ancestor responsibility and input; narrow the unresolved obligation',
        )
      const id = ancestor.taskId
      ancestor = [...tasks.values()].find((t) => t.decomposition?.children.some((c) => c.taskId === id))
    }
    return {
      taskId: ids.get(child.key)!,
      contract,
      plan: { taskId: ids.get(child.key)!, dependsOn, supports: child.supports, maxRuns: child.maxRuns,
        ...(child.handoff === undefined ? {} : { handoff: child.handoff }) },
    }
  })
  const fresh = prepared.filter((entry) => {
    const old = existing.find((c) => c.taskId === entry.taskId)
    if (old === undefined) return true
    if (
      digestOf(old) !== digestOf(entry.plan) ||
      digestOf(taskStateOf(apparatus, entry.taskId).contract) !== digestOf(entry.contract)
    )
      refuse('command-conflict', 'child key changed its immutable declaration')
    return false
  })
  assertDecomposition([...existing, ...fresh.map((e) => e.plan)], { criteria: standards }, parentId)
  if (fresh.length) assertActive(apparatus, parentId)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  for (const entry of fresh) {
    const agentId = String(agentSessionIdOf(entry.taskId))
    declareCaller(apparatus, agentId)
    await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'child' })
    await commands.admit({ commandId: `admit:${entry.taskId}`, taskId: entry.taskId, contract: entry.contract })
    await commands.assign({ commandId: `assign:${entry.taskId}`, taskId: entry.taskId, agentId })
  }
  if (fresh.length) {
    const plans = fresh.map((e) => e.plan)
    if (review === undefined)
      await commands.decompose({
        commandId: `decompose:${parentId}:${digestOf(plans)}`,
        parentTaskId: parentId,
        children: plans,
      })
    else
      await createReviewCommands(apparatus.store).decompose(`decompose:${parentId}:${digestOf(plans)}`,
        parentId, plans, `agent:${caller.agentId}`)
  }
  if (recipe !== undefined)
    await consumeMethod(
      apparatus,
      parentId,
      run!,
      `decomposition:${template!.id}`,
      `decomposition:${template!.id}:${digestOf(recipe)}`,
    )
  return { taskId: parentId, opened: await scheduler.advance(parentId) }
}
function taskStateIf(apparatus: Apparatus, taskId: string): TaskState | undefined {
  return apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId)
}

export async function propose(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly goal: string; readonly method?: import('../../src/task/protocol.ts').RevisionRef },
  context: { purpose: RunState['purpose']; relatedTo?: RunState['relatedTo'] } = { purpose: 'solve' },
): Promise<Proposal> {
  const method = input.method ?? publishedMethod(apparatus) ?? (await seedMethod(apparatus))
  const domain = (await loadMethod(apparatus, method)).domain
  apparatus.budget?.beforeRequest()
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, callId)
  await bindCaller(apparatus, caller)
  const template = domain.templates.get(domain.rootTemplate)!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  if (taskStateIf(apparatus, taskId) === undefined)
    await commands.admit({ commandId: `propose:${taskId}`,
      taskId,
      contract: contractFor(domain, template, input.goal),
    })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, taskId, callId, method, { domain, ...context })
  return proposalOf(apparatus, taskStateOf(apparatus, taskId), run)
}

export async function retry(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly taskId: string },
): Promise<Proposal> {
  const task = taskStateOf(apparatus, input.taskId)
  if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'caller does not own Task')
  const id = runIdOf(apparatus.controlId, caller.sessionId, callId)
  if (task.runs[id] !== undefined) return proposalOf(apparatus, task, task.runs[id]!)
  const previous = Object.values(task.runs).at(-1)!
  if (previous.status !== 'failed') refuse('illegal-transition', 'only a failed Run can be retried')
  const run = await startAttempt(apparatus, caller, task.taskId, callId, previous.revision, {
    domain: (await loadMethod(apparatus, previous.revision)).domain,
    purpose: previous.purpose,
    ...(previous.relatedTo === undefined ? {} : { relatedTo: previous.relatedTo }),
  })
  return proposalOf(apparatus, task, run)
}
export async function proposalOf(apparatus: Apparatus, task: TaskState, run: RunState): Promise<Proposal> {
  const domain = (await loadMethod(apparatus, run.revision)).domain
  return { taskId: task.taskId, runId: run.runId, workspace: workspaceOf(apparatus, task.taskId, run.runId),
    contract: task.contract!,
    phase: run.status,
    artifact: task.contract!.artifact,
    templates: (task.contract!.template === undefined
      ? []
      : (domain.templates.get(task.contract!.template.id)!.decomposition?.children ?? [])
    )
      .map((child) => domain.templates.get(child.template)!)
      .map((t) => ({
        id: t.id,
        goal: t.goal,
        ...(t.applicability === undefined ? {} : { applicability: t.applicability }),
      })),
    methodContext: await methodContext(apparatus, task.taskId, run),
  }
}
