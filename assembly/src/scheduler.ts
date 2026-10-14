import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams,
} from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree, projectPlan, type TreeView } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { loadMethod } from './method.ts'
import { proposalOf } from './surfaces.ts'
import { planOutcomeOf } from './read.ts'
import { deliverQuestions, parentPlan } from './coordination.ts'
import { createReviewCommands } from '../../src/review/commands.ts'

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
  open: OpenChild = (request) => openChildSession(seams, request),
): Scheduler {
  const live = new Map<string, ChildSession>()
  const advancing = new Map<string, Promise<readonly string[]>>()
  let relaying = Promise.resolve()
  let closing: Promise<void> | undefined
  const lifecycle = new AbortController()
  const reviewOf = (id: string) => apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, id)
  const planOf = (parentTaskId: string): TreeView | undefined => {
    const review = reviewOf(parentTaskId)
    const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    return review === undefined
      ? projectTree(tasks).find((plan) => plan.parentTaskId === parentTaskId)
      : review.children.length === 0 ? undefined : projectPlan(review.reviewId, review.criteria, review.children, tasks)
  }
  const parentOf = (parentTaskId: string): Agent => {
    const holder = reviewOf(parentTaskId)?.agentId ?? taskStateOf(apparatus, parentTaskId).responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, holder)!
    const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry
    const parent = registry.get(SessionId(node.sessionId))
    if (parent === undefined || String(parent.session.id) !== node.sessionId)
      refuse('unknown-emitter-role', 'plan has no exact live parent session')
    return parent
  }
  const release = async (taskId: string, session: ChildSession): Promise<void> => {
    const failures: unknown[] = []
    try { session.stop() } catch (error) { failures.push(error) }
    try { await session.close()
      live.delete(taskId) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'child close failed')
  }
  const notify = async (parentTaskId: string, parent: Agent): Promise<void> => {
    const plan = planOf(parentTaskId)!
    const terminal = planOutcomeOf(apparatus, plan)
    if (terminal === undefined) return
    const runId = reviewOf(parentTaskId)?.reviewId ?? Object.values(taskStateOf(apparatus, parentTaskId).runs).at(-1)!.runId
    const text = `Delegated work for Task ${parentTaskId} settled. Continue your existing parent Run and independently validate your final artifact. Use singularity_read kind=artifact ref=taskId for sealed text pages; reuse the evidence before doing new work. Child support is not a parent verdict.\n` +
      JSON.stringify(plan.children.map((child) => {
        const state = taskStateOf(apparatus, child.taskId),
          run = Object.values(state.runs).findLast((r) => r.status === 'verified') ?? Object.values(state.runs).at(-1)
        return { ...child, goal: state.contract!.goal, runId: run?.runId ?? null, artifact: run?.submission?.files.artifact,
          artifactDigest: run?.submission?.artifactDigest,
          verdicts: run?.evidence.map((e) => ({ criterionId: e.criterionId, verdict: e.verdict, reviewId: e.reviewId, detail: e.detail })) ?? [] }
      }))
    try {
      await postIdentifiedMessage(seams, parent, schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome',
        controlId: apparatus.controlId, parentTaskId, taskId: terminal.subject, runId, factSeq: terminal.seq,
          },
          text,
        ),
      )
    }
    catch (error) { throw new DispatchError(parentTaskId, parentTaskId, null, error) }
  }
  const dispatch = async (parentTaskId: string, parent: Agent, taskId: string, maxRuns: number): Promise<void> => {
    const state = taskStateOf(apparatus, taskId)
    const review = reviewOf(parentTaskId)
    const parentRun =
      review === undefined
        ? Object.values(taskStateOf(apparatus, parentTaskId).runs).find((run) => run.status === 'running')!
        : undefined
    const revision = review?.method ?? parentRun!.revision
    const childId = state.responsibility!.agentId
    const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, childId)!
    const previous = Object.values(state.runs).findLast((run) => run.status !== 'running')
    const working = Object.values(state.runs).find((run) => run.status === 'running')
    let session = live.get(taskId)
    let attempt = working
    try {
      const agent = session?.agent
      const route = agent === undefined ? (previous?.bubble?.model ?? parent.session.requestHeader()?.config ?? parent.options)
        : (agent.session.requestHeader()?.config ?? agent.options)
      if (working === undefined && (route.provider === undefined || route.model === undefined))
        refuse('malformed-declaration', 'the dispatch agent has no model route')
      declareCaller(apparatus, childId)
      const run = (attempt ??= await startAttempt(apparatus, { agentId: childId, sessionId: node.sessionId, model: { provider: route.provider!, model: route.model! } },
        taskId, taskId + ':attempt:' + Object.values(state.runs).length, revision, { domain: (await loadMethod(apparatus, revision)).domain, purpose: parentRun?.purpose ?? 'solve' },
      ))
      if (run.bubble === undefined) refuse('illegal-transition', 'working Run has no prepared execution bubble')
      const workspace = workspaceOf(apparatus, taskId, run.runId)
      const message = run.stage === 'submitted' ? undefined : schedulerMessage({ kind: 'singularity', purpose: 'dispatch',
        controlId: apparatus.controlId, parentTaskId, taskId, runId: run.runId, factSeq: apparatus.store.committedOf(`start:${run.runId}`)!.seq,
        },
        JSON.stringify({
          assigned: await proposalOf(apparatus, state, run),
          handoff: (() => {
            const parent = parentPlan(apparatus, taskId)!, entry = parent.children.find((c) => c.taskId === taskId)!
            return { parentId: parent.id, parentRunId: review?.reviewId ?? parentRun!.runId,
              parentObjective: parent.goal, parentCriteria: parent.criteria, supports: entry.supports,
              ...entry.handoff, peers: parent.children.map((c) => ({ taskId: c.taskId,
                goal: taskStateOf(apparatus, c.taskId).contract!.goal, dependsOn: c.dependsOn })),
              instruction: 'Read related Tasks and their evidence by reference; ask the direct parent when scope is undecidable. Do not repeat their responsibilities.' }
          })(),
          previous:
            previous === undefined
              ? undefined
              : {
                  runId: previous.runId,
                  reason: previous.failureReason,
                  findings: previous.evidence.map((e) => ({
                    criterionId: e.criterionId,
                    verdict: e.verdict,
                    detail: e.detail,
                  })),
                },
          attempt: Object.keys(taskStateOf(apparatus, taskId).runs).indexOf(run.runId) + 1,
          maxRuns,
        }),
      )
      const model = run.bubble!.model
      if (session === undefined) {
        session = await open({ agentId: taskId, cwd: workspace, parent, model,
          ...(message === undefined ? {} : { message }), signal: lifecycle.signal })
        live.set(taskId, session)
      } else if (message !== undefined) await session.post(message)
      const actual = session.agent?.session.requestHeader()?.config ?? session.agent?.options
      if (actual !== undefined && (actual.provider !== model.provider || actual.model !== model.model))
        refuse('illegal-transition', 'the child model route differs from its frozen Run bubble')
    } catch (error) {
      const failures: unknown[] = [error]
      const run = attempt ?? Object.values(taskStateOf(apparatus, taskId).runs).at(-1)
      if (run !== undefined && taskStateOf(apparatus, taskId).runs[run.runId]!.status === 'running') {
        try { await apparatus.tasks.forAgent(childId).failRun({ commandId: 'dispatch-failed:' + taskId + '/' + run.runId,
          taskId, runId: run.runId, reason: 'child-runtime-failed: ' + String(error),
            }) } catch (failure) { failures.push(failure) }
      }
      if (session !== undefined) try { await release(taskId, session) } catch (failure) { failures.push(failure) }
      try { await notify(parentTaskId, parent) } catch (failure) { failures.push(failure) }
      throw new DispatchError(parentTaskId, taskId, run?.runId ?? null,
        failures.length === 1 ? error : new AggregateError(failures, 'child dispatch failed: ' + String(error)),
      )
    }
  }
  const advanceOne = async (parentTaskId: string): Promise<readonly string[]> => {
    const delivery = relaying.then(() => deliverQuestions(apparatus, seams), () => deliverQuestions(apparatus, seams))
    relaying = delivery
    await delivery
    const review = reviewOf(parentTaskId)
    let plan = planOf(parentTaskId)
    const working =
      review === undefined
        ? Object.values(taskStateOf(apparatus, parentTaskId).runs).some(
            (run) => run.status === 'running' && run.stage === 'working',
          )
        : review.status === 'running'
    if (plan === undefined) return []
    if (!working) {
      const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry
      for (const child of plan.children) {
        const task = taskStateOf(apparatus, child.taskId)
        const run = Object.values(task.runs).find((run) => run.status === 'running')
        if (run !== undefined) {
          declareCaller(apparatus, task.responsibility!.agentId)
          await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
            commandId: `parent-stopped:${parentTaskId}/${child.taskId}/${run.runId}`,
            taskId: child.taskId, runId: run.runId, reason: 'direct parent Run settled before delegated work completed' })
          for (const held of apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values())
            if (held.status === 'running' && held.target.kind === 'acceptance' &&
              held.target.taskId === child.taskId && held.target.runId === run.runId) {
              await createReviewCommands(apparatus.store).fail(`parent-stopped:${held.reviewId}`, held.reviewId,
                'direct parent responsibility settled during acceptance')
              registry.get(SessionId(held.sessionId))?.cancel({ kind: 'parent' }, { keepInbox: true })
              await advanceOne(held.reviewId)
            }
          const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility!.agentId)!
          registry.get(SessionId(node.sessionId))?.cancel({ kind: 'parent' }, { keepInbox: true })
        }
        await advanceOne(child.taskId)
        const session = live.get(child.taskId)
        if (session !== undefined) await release(child.taskId, session)
      }
      return []
    }
    if (plan.children.some((c) => c.status === 'missing'))
      refuse('illegal-transition', 'delegated responsibility has no admitted contract')
    const parent = parentOf(parentTaskId)
    const opened: string[] = []
    for (let index = 0; index < plan.children.length; index++) {
      const child = plan.children[index]!
      if (child.status !== 'ready' && child.status !== 'running') continue
      if (child.status !== 'ready' && !(child.status === 'running' && !live.has(child.taskId))) continue
      await dispatch(parentTaskId, parent, child.taskId, child.maxRuns)
      opened.push(child.taskId)
      plan = planOf(parentTaskId)!
    }
    await notify(parentTaskId, parent)
    return opened
  }
  return {
    advance: (parentTaskId) => {
      if (closing !== undefined) refuse('illegal-transition', 'the scheduler is closing')
      const previous = advancing.get(parentTaskId)
      const pending = previous === undefined ? advanceOne(parentTaskId) : previous.then(() => advanceOne(parentTaskId), () => advanceOne(parentTaskId),
            )
      advancing.set(parentTaskId, pending)
      const done = () => { if (advancing.get(parentTaskId) === pending) advancing.delete(parentTaskId) }
      void pending.then(done, done)
      return pending
    },
    close: () =>
      (closing ??= (async () => {
      lifecycle.abort()
      const pending = await Promise.allSettled([...advancing.values()])
      const failures = pending.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      for (const [taskId, session] of live) try { await release(taskId, session) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'child unload failed')
    })()),
  }
}
