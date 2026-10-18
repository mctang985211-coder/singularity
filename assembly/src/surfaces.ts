import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { templateOf } from './domain.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { assertContract, type TaskContract } from '../../src/task/contract.ts'
import { assertDecomposition } from '../../src/task/decomposition.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import type { DecomposeInput, PlanRecord, Proposal } from './driver.ts'
import { taskIdOf, runIdOf } from './ids.ts'
import { assertTemplateContract, contractFor } from './inputs.ts'
import type { Scheduler } from './scheduler.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { bindingsForContract, seedMethod, loadMethod, publishedMethod } from './method.ts'
import { reviewOf } from './review.ts'
import { assertActive, readScopeOf } from './coordination.ts'
import { assertWorkflowBudget, DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'

const responsibilityDigest = ({ template: _template, ...responsibility }: TaskContract): string =>
  digestOf(responsibility)
export async function decompose(
  apparatus: Apparatus,
  scheduler: Pick<Scheduler, 'advance'>,
  caller: Caller,
  input: DecomposeInput,
): Promise<PlanRecord> {
  assertClosedKeys({ ...input }, ['taskId', 'children'], 'decomposition', 'malformed-declaration')
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
  const { domain, assets } = await loadMethod(apparatus, revision, parent?.contract?.template)
  const existing = review?.children ?? parent!.decomposition?.children ?? []
  const standards = review?.criteria ?? parent!.contract!.criteria
  const children = input.children
  if (children === undefined || children.length === 0) refuse('malformed-declaration', 'decomposition needs children')
  if (review !== undefined && children.some(child => child.requirement !== 'required'))
    refuse('malformed-declaration', 'independent review evidence tasks must be required')
  const { visible } = await readScopeOf(apparatus, caller.agentId)
  const verified = (id: string) => visible!.has(id) && Object.values(taskStateIf(apparatus, id)?.runs ?? {})
    .some((r) => r.status === 'verified')
  const ids = new Map(existing.map((c) => [c.taskId, c.taskId]))
  for (const child of children) {
    if (ids.has(child.key)) refuse('malformed-declaration', 'duplicate child key')
    ids.set(child.key, taskIdOf(apparatus.controlId, parentId, child.key))
  }
  const prepared = children.map((child) => {
    assertClosedKeys({ ...child }, ['key', 'contract', 'dependsOn', 'supports', 'maxRuns', 'requirement', 'handoff'], 'child declaration', 'malformed-declaration')
    const dependsOn = child.dependsOn.map((key) => {
      const id = ids.get(key)
      if (id === undefined) refuse('malformed-declaration', 'unknown dependency ' + key)
      return id
    })
    const declared = assertContract(child.contract, 'child contract')
    const contract: TaskContract = { ...declared, inputs: declared.inputs.map((input) => ({
      ...input, source: input.source.kind === 'artifact'
        ? { ...input.source, taskId: ids.get(input.source.taskId) ?? input.source.taskId } : input.source,
    })) }
    assertTemplateContract(domain, contract)
    for (const input of contract.inputs)
      if (input.source.kind === 'artifact' && !dependsOn.includes(input.source.taskId) && !verified(input.source.taskId))
        refuse('malformed-declaration', 'artifact producers must be declared dependencies or verified visible evidence')
    bindingsForContract(contract, assets)
    if (child.handoff !== undefined) {
      const unverified = child.handoff.evidence.filter((id) => !verified(id))
      if (unverified.length > 0)
        refuse('not-responsible', `handoff evidence may only reference verified Tasks visible in the parent context; offending: ${unverified.join(', ')}`)
    }
    const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    let ancestor = parent ?? (review?.target.kind === 'acceptance' ? tasks.get(review.target.taskId) : undefined)
    const rootHandoff = parent !== undefined && ancestor === parent && (existing.length === 0 || existing.length === 1 && existing[0]!.taskId === ids.get(child.key)) && children.length === 1
      && child.requirement === 'required' && child.supports.length === standards.length
      && standards.every(criterion => child.supports.includes(criterion.criterionId))
      && apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, caller.agentId)?.role === 'root'
      && ![...tasks.values()].some(task => task.decomposition?.children.some(edge => edge.taskId === parent.taskId))
    while (ancestor !== undefined) {
      if (!rootHandoff && responsibilityDigest(ancestor.contract!) === responsibilityDigest(contract))
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
      plan: { taskId: ids.get(child.key)!, dependsOn, supports: child.supports, maxRuns: child.maxRuns, requirement: child.requirement,
        ...(child.handoff === undefined ? {} : { handoff: child.handoff }) },
    }
  })
  const responsibilities = new Set(existing.map(edge => responsibilityDigest(taskStateOf(apparatus, edge.taskId).contract!)))
  for (const entry of prepared) {
    if (!existing.some(edge => edge.taskId === entry.taskId)) {
      const digest = responsibilityDigest(entry.contract)
      if (responsibilities.has(digest)) refuse('cyclic-dependency', 'duplicate child responsibility and input; retry the original Task within its budget')
      responsibilities.add(digest)
    }
    if (entry.contract.template === undefined) continue
    const selected = templateOf(domain, entry.contract.template)
    for (const input of entry.contract.inputs) {
      const expected = selected.inputs.find((other) => other.name === input.name)!.source
      if (input.source.kind === 'artifact' && expected.kind === 'artifact') {
        const taskId = input.source.taskId
        const producer = prepared.find((other) => other.taskId === taskId)?.contract
          ?? taskStateIf(apparatus, taskId)?.contract
        if (producer?.template?.id !== expected.template)
          refuse('evidence-input-mismatch', 'artifact producer differs from the pinned declaration')
      }
    }
  }
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
  if (review === undefined && fresh.length) assertWorkflowBudget(
    apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), apparatus.store.load().entries(), parentId,
    { nodes: fresh.length, plans: 1 })
  if (fresh.length) assertActive(apparatus, parentId, 'plan')
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
  return { taskId: parentId, opened: await scheduler.advance(parentId) }
}
function taskStateIf(apparatus: Apparatus, taskId: string): TaskState | undefined {
  return apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId)
}

export async function propose(apparatus: Apparatus, caller: Caller, callId: string, input: { readonly goal?: string; readonly contract?: TaskContract; readonly learning?: boolean; readonly method?: import('../../src/task/protocol.ts').RevisionRef },
  context: { purpose: RunState['purpose']; relatedTo?: RunState['relatedTo']; case?: RunState['case'] } = { purpose: 'solve' },
): Promise<Proposal> {
  const method = input.method ?? publishedMethod(apparatus) ?? (await seedMethod(apparatus))
  const domain = (await loadMethod(apparatus, method)).domain
  const taskId = taskIdOf(apparatus.controlId, caller.agentId, callId)
  await bindCaller(apparatus, caller)
  const template = apparatus.domain.rootTemplate === undefined ? undefined : (domain.templates.get(apparatus.domain.rootTemplate) ?? apparatus.domain.templates.get(apparatus.domain.rootTemplate))
  const goal = input.goal ?? input.contract?.goal ?? ''
  let requestCriterion = 'request'
  while (template?.criteria.some(criterion => criterion.criterionId === requestCriterion)) requestCriterion += '-request'
  const contract = assertContract(input.contract ?? (template === undefined
    ? { goal, artifact: 'result.txt', inputs: [], criteria: [{ criterionId: 'request', statement: goal }] }
    : { ...contractFor(domain, template, goal), criteria: [
      ...template.criteria, { criterionId: requestCriterion, statement: goal },
    ] }), 'root contract')
  const commands = apparatus.tasks.forAgent(caller.agentId)
  if (taskStateIf(apparatus, taskId) === undefined)
    await commands.admit({ commandId: `propose:${taskId}`,
      taskId,
      contract,
    })
  await commands.assign({ commandId: `assign:${taskId}`, taskId, agentId: caller.agentId })
  await apparatus.store.emit({ commandId: `learning:${taskId}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
    subject: taskId, kind: 'learning/configured', as: `agent:${caller.agentId}`, payload: { enabled: input.learning ?? context.purpose === 'solve' } })
  if (taskStateOf(apparatus, taskId).workflowLimits === undefined)
    await apparatus.store.emit({ commandId: `workflow-limits:${taskId}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
      subject: taskId, kind: 'workflow/limits-frozen', as: `agent:${caller.agentId}`, payload: DEFAULT_WORKFLOW_LIMITS })
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
export function proposalOf(apparatus: Apparatus, task: TaskState, run: RunState): Proposal {
  return { taskId: task.taskId, runId: run.runId, workspace: workspaceOf(apparatus, task.taskId, run.runId),
    contract: task.contract!, phase: run.status, method: run.revision,
  }
}
