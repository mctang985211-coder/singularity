import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { ControlReadCut } from '../../src/control/session-store.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { TaskQuestion } from '../../src/task/questions.ts'
import { projectPlan, childSettled, taskWaitingReason, stoppedExplorationOf } from '../../src/task/tree.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { sha256 } from './ids.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { sealedBytes } from './sealed.ts'
import type { FrozenInputProducer } from './review.ts'

export interface AskParent { readonly requestKey: string; readonly question: string; readonly blocking?: boolean }
export interface AnswerChild { readonly questionId: string; readonly requestKey: string; readonly answer: string; readonly resolves: boolean; readonly evidence?: readonly string[] }

export function parentPlan(apparatus: Apparatus, taskId: string) {
  const cut = apparatus.store.load()
  for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values())
    if (task.decomposition?.children.some((c) => c.taskId === taskId)) {
      const run = Object.values(task.runs).at(-1)!
      return { id: task.taskId, runId: run.runId, identity: run.actor, agentId: task.responsibility!.agentId,
        working: run.status === 'running' && run.stage === 'working', goal: task.contract!.goal,
        criteria: task.contract!.criteria, children: task.decomposition.children }
    }
  for (const review of cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values())
    if (review.children.some((c) => c.taskId === taskId))
      return { id: review.reviewId, runId: review.reviewId, identity: review.identity, agentId: review.agentId,
        working: review.status === 'running', goal: 'Gather evidence for independent review',
        criteria: review.criteria, children: review.children }
  return undefined
}

export function parentContextOf(apparatus: Apparatus, taskId: string) {
  const plan = parentPlan(apparatus, taskId)
  if (plan === undefined) return undefined
  const edge = plan.children.find((child) => child.taskId === taskId)!
  return {
    parent: { id: plan.id, runId: plan.runId, supports: edge.supports, dependsOn: edge.dependsOn, requirement: edge.requirement },
    ...(edge.handoff === undefined ? {} : { handoff: edge.handoff }),
  }
}

/** Port of the old batch/question write hold, derived from the one control fold. */
export function waitingReason(apparatus: Apparatus, id: string, cut: ControlReadCut = apparatus.store.load()): string | undefined {
  const review = cut.stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, id)
  const task = cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, id)
  if (task !== undefined) {
    return taskWaitingReason(cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), id)
  }
  const states = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const stopped = review?.target.kind === 'acceptance' ? stoppedExplorationOf(states, review.target.taskId) : undefined
  if (stopped !== undefined) return `review subject belongs to stopped exploration ${stopped.taskId}: ${stopped.reason}`
  const children = projectPlan(id, [], review?.children ?? [], states).children
  if (children.some(child => !childSettled(child)))
    return 'delegated responsibilities are pending; read evidence or answer children, then end the turn'
  const unmet = children.filter(child => child.requirement === 'required' && child.status !== 'verified')
  if (unmet.length) return `required review evidence tasks have not verified: ${unmet.map(child => child.taskId).join(', ')}`
  return undefined
}

export function assertActive(apparatus: Apparatus, id: string): void {
  const reason = waitingReason(apparatus, id)
  if (reason !== undefined) refuse('illegal-transition', reason)
}

/** Dynamic responsibility is a projection of frozen contracts and current control facts. */
export function coordinationOf(apparatus: Apparatus, id: string, cut: ControlReadCut = apparatus.store.load()) {
  const states = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const task = states.get(id), review = cut.stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, id)
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  const rootCoordinator = task?.responsibility !== undefined && run?.purpose !== 'improve'
    && cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)?.role === 'root'
  const entries = review?.children ?? task?.decomposition?.children ?? []
  const criteria = review?.criteria ?? task!.contract!.criteria
  const children = projectPlan(id, criteria, entries, states, task === undefined ? [] : Object.values(task.runs)).children
  const waiting = waitingReason(apparatus, id, cut) ?? null
  const working = review === undefined ? run?.status === 'running' && run.stage === 'working' : review.status === 'running'
  const questionsToAnswer = [...states.values()].flatMap(state => (state.questions ?? [])
    .filter(question => question.parentId === id && state.runs[question.runId]!.status === 'running'
      && stoppedExplorationOf(states, state.taskId) === undefined && !question.answers.some(answer => answer.resolves))
    .map(question => ({ taskId: state.taskId, ...question })))
  return {
    responsibility: {
      authority: review === undefined ? { kind: 'task' as const, taskId: id, runId: run?.runId ?? null,
        contractDigest: task!.contractDigest!, artifact: task!.contract!.artifact }
        : { kind: 'review' as const, reviewId: id, subjectDigest: review.subjectDigest },
      criteriaToAccept: criteria.map(criterion => criterion.criterionId),
      delegated: children.map(child => ({
        ...child, contractDigest: states.get(child.taskId)!.contractDigest!,
        goal: states.get(child.taskId)!.contract!.goal, artifact: states.get(child.taskId)!.contract!.artifact,
      })),
      requiredUnverified: children.filter(child => child.requirement === 'required' && child.status !== 'verified').map(child => child.taskId),
      activeExploration: children.filter(child => child.requirement === 'exploration' && !childSettled(child)).map(child => child.taskId),
      remaining: {
        decompose: rootCoordinator && entries.length === 0 && working,
        coordinate: children.some(child => !childSettled(child)) || questionsToAnswer.length > 0,
        selectEvidence: children.length > 0 && working,
        integrateOrReuseArtifact: review === undefined && !rootCoordinator && working,
        delegateIntegrationIfNeeded: rootCoordinator && working,
        submitForIndependentAcceptance: review === undefined && working,
        judgeFrozenSubject: review !== undefined && working,
      },
      executionMode: rootCoordinator ? 'coordinate' as const : 'work' as const,
      canExecute: working && waiting === null && !rootCoordinator,
      canSubmit: working && waiting === null && (!rootCoordinator || children.some(child => child.status === 'verified')),
      boundary: 'Delegation assigns the named child result. Supports links do not discharge parent criteria; the parent still owns selection and integration and must submit for independent acceptance.',
    },
    waiting,
    questionsToAnswer,
    questionsAsked: task?.questions ?? [],
  }
}

/** Bodies are recorded in the control log; identities/recipients come only from the bound caller and direct edge. */
export async function askParent(apparatus: Apparatus, caller: Caller, taskId: string, input: AskParent): Promise<TaskQuestion> {
  if (!input.requestKey) refuse('malformed-declaration', 'question requires a stable requestKey')
  const task = taskStateOf(apparatus, taskId), run = Object.values(task.runs).at(-1)!
  const stopped = stoppedExplorationOf(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), taskId)
  if (stopped !== undefined) refuse('illegal-transition', `exploration ${stopped.taskId} was stopped: ${stopped.reason}`)
  if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'caller does not own Task')
  const questionId = 'question-' + sha256(`${taskId}/${run.runId}/${input.requestKey}`)
  await apparatus.store.emit(() => {
    const prior = taskStateOf(apparatus, taskId).questions?.find((q) => q.questionId === questionId)
    const parent = parentPlan(apparatus, taskId)
    if (parent === undefined) refuse('not-responsible', 'root Tasks have no parent to ask')
    if (stoppedExplorationOf(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), taskId) !== undefined)
      refuse('illegal-transition', 'stopped exploration cannot ask a question')
    if (prior === undefined && !parent.working) refuse('illegal-transition', 'direct parent Run has settled')
    return { commandId: questionId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'task/question-asked',
      subject: taskId, as: `agent:${caller.agentId}`, payload: {
        questionId, runId: run.runId, parentId: prior?.parentId ?? parent.id, parentRunId: prior?.parentRunId ?? parent.runId,
        parentIdentity: prior?.parentIdentity ?? parent.identity, parentAgentId: prior?.parentAgentId ?? parent.agentId,
        question: input.question, blocking: input.blocking ?? true } }
  })
  return taskStateOf(apparatus, taskId).questions!.find((q) => q.questionId === questionId)!
}

export async function answerChild(apparatus: Apparatus, caller: Caller, input: AnswerChild): Promise<TaskQuestion> {
  if (!input.requestKey) refuse('malformed-declaration', 'answer requires a stable requestKey')
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .find((t) => t.questions?.some((q) => q.questionId === input.questionId))
  const question = task?.questions?.find((q) => q.questionId === input.questionId)
  if (question === undefined) refuse('not-responsible', 'unknown child question')
  if (question.parentAgentId !== caller.agentId) refuse('not-responsible', 'only the exact direct parent Run may answer')
  const { visible } = await readScopeOf(apparatus, caller.agentId)
  const evidence = input.evidence ?? []
  const unverified = evidence.filter((id) => !visible!.has(id)
    || !Object.values(taskStateOf(apparatus, id).runs).some((r) => r.status === 'verified'))
  if (unverified.length > 0)
    refuse('not-responsible', `answer evidence may only reference verified Tasks visible in the parent context; offending: ${unverified.join(', ')}`)
  const answerId = 'answer-' + sha256(`${question.questionId}/${input.requestKey}`)
  await apparatus.store.emit(() => {
    const parent = parentPlan(apparatus, task!.taskId)
    if (parent?.agentId !== caller.agentId || parent.runId !== question.parentRunId)
      refuse('not-responsible', 'only the exact direct parent Run may answer')
    if (stoppedExplorationOf(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), task!.taskId) !== undefined)
      refuse('illegal-transition', 'stopped exploration cannot receive new answers')
    if (!parent.working && apparatus.store.committedOf(answerId) === undefined)
      refuse('illegal-transition', 'parent Run has settled')
    return { commandId: answerId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'task/question-answered',
      subject: task!.taskId, as: `agent:${caller.agentId}`,
      payload: { questionId: question.questionId, answerId, answer: input.answer, resolves: input.resolves, evidence } }
  })
  return taskStateOf(apparatus, task!.taskId).questions!.find((q) => q.questionId === input.questionId)!
}

/** Same identified-message delivery as dispatch/outcomes; reentrant recovery adds no second inbox/store. */
export async function deliverQuestions(apparatus: Apparatus, seams: ChildSessionSeams): Promise<void> {
  const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry
  for (const task of apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values())
    for (const q of task.questions ?? []) {
      const run = task.runs[q.runId]!
      if (run.status !== 'running' || run.stage !== 'working' ||
        stoppedExplorationOf(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION), task.taskId) !== undefined) continue
      if (q.blocking && !q.answers.some((a) => a.resolves)) {
        const parent = parentPlan(apparatus, task.taskId)
        if (!parent?.working || parent.runId !== q.parentRunId) {
          await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
            commandId: `parent-settled:${q.questionId}`, taskId: task.taskId, runId: run.runId,
            reason: 'direct parent Run settled before resolving the blocking question' })
          continue
        }
      }
      const deliver = async (agent: Agent | undefined, purpose: 'question' | 'answer', seq: number, text: string) => {
        if (agent !== undefined) await postIdentifiedMessage(seams, agent, schedulerMessage({
          kind: 'singularity', purpose, controlId: apparatus.controlId, parentTaskId: q.parentId,
          taskId: task.taskId, runId: q.runId, factSeq: seq }, text))
      }
      const recipient = (agentId: string) => {
        const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId)!
        return registry.get(SessionId(node.sessionId))
      }
      if (!q.answers.some((a) => a.resolves))
        await deliver(recipient(q.parentAgentId), 'question', q.seq,
          JSON.stringify({ questionId: q.questionId, taskId: task.taskId, runId: q.runId, question: q.question,
            blocking: q.blocking, instruction: 'Answer this child with singularity_answer; the frozen contract stays in force.' }))
      for (const answer of q.answers)
        await deliver(recipient(task.responsibility!.agentId), 'answer', answer.seq,
          JSON.stringify({ questionId: q.questionId, ...answer, instruction: 'Read this answer before continuing; it changes no frozen input or acceptance standard.' }))
    }
}

export async function readScopeOf(apparatus: Apparatus, agentId?: string, committed = apparatus.store.load()) {
  const states = committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  let visible: Set<string> | undefined
  const revisions = new Set<string>()
  const frozenProducers = new Map<string, readonly FrozenInputProducer[]>()
  let audit = agentId === undefined
  if (agentId !== undefined) {
    const owner = [...states.values()].findLast((task) => task.responsibility?.agentId === agentId)
    const review = [...committed.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].findLast(
      (r) => r.agentId === agentId,
    )
    if (owner === undefined && review === undefined)
      refuse('not-responsible', 'history requires an assigned responsibility')
    visible = new Set()
    const collect = (id: string): void => {
      if (visible!.has(id)) return
      visible!.add(id)
      for (const child of states.get(id)!.decomposition?.children ?? []) collect(child.taskId)
      if (Object.values(states.get(id)!.runs).at(-1)?.purpose === 'improve')
        for (const task of states.values())
          if (Object.values(task.runs).some((run) => run.purpose === 'evaluation' && run.relatedTo?.taskId === id))
            collect(task.taskId)
    }
    if (review !== undefined) {
      for (const child of review.children) collect(child.taskId)
      if (review.target.kind === 'acceptance') {
        collect(review.target.taskId)
        const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as {
          inputProducers: readonly FrozenInputProducer[]
        }
        for (const producer of subject.inputProducers) {
          visible.add(producer.taskId)
          revisions.add(producer.revision.digest)
          const held = frozenProducers.get(producer.taskId) ?? []
          if (!held.some((run) => run.runId === producer.runId)) frozenProducers.set(producer.taskId, [...held, producer])
        }
      }
      else if (review.target.kind === 'publication') {
        const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as {
          evidence: readonly { trials: readonly { detail: string }[] }[]
        }
        for (const evaluation of subject.evidence)
          for (const trial of evaluation.trials) collect((JSON.parse(trial.detail) as { taskId: string }).taskId)
      }
      revisions.add(review.method.digest)
      return { visible, revisions, audit: true, frozenProducers }
    }
    collect(owner!.taskId)
    const run = Object.values(owner!.runs).at(-1)
    const purpose = run?.purpose
    audit = purpose === 'improve'
    if (audit && run?.relatedTo !== undefined) collect(run.relatedTo.taskId)
    if (!audit) {
      // Port of old context/reads/guards.readableTaskIds: branch, relationships and ancestors.
      const branch = new Set(visible)
      for (const id of branch) {
        for (const q of states.get(id)!.questions ?? []) for (const answer of q.answers)
          for (const evidence of answer.evidence) visible.add(evidence)
        const parent = parentPlan(apparatus, id)
        if (parent !== undefined) {
          if (states.has(parent.id)) visible.add(parent.id)
          for (const sibling of parent.children) visible.add(sibling.taskId)
          for (const evidence of parent.children.find((c) => c.taskId === id)?.handoff?.evidence ?? []) visible.add(evidence)
        }
      }
      for (const task of states.values()) for (const input of task.contract?.inputs ?? [])
        if (input.source.kind === 'artifact') {
          if (branch.has(task.taskId)) visible.add(input.source.taskId)
          if (branch.has(input.source.taskId)) visible.add(task.taskId)
        }
      let parent = parentPlan(apparatus, owner!.taskId)
      while (parent !== undefined && states.has(parent.id)) {
        visible.add(parent.id)
        parent = parentPlan(apparatus, parent.id)
      }
    }
    for (const id of visible) for (const held of Object.values(states.get(id)!.runs)) revisions.add(held.revision.digest)
  }
  return { visible, revisions, audit, frozenProducers }
}

