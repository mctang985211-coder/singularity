import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { openChildSession, type ChildSession, type ChildSessionRequest, type ChildSessionSeams,
} from '../../src/runtime/child-session.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { projectTree, projectPlan, childSettled, stoppedExplorationOf, type TreeView } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { workspaceOf, startAttempt } from './attempt.ts'
import { runIdOf } from './ids.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { methodContext, confirmWorkflowDelivery } from './method-run.ts'
import { proposalOf } from './surfaces.ts'
import { planOutcomeOf } from './read.ts'
import { deliverQuestions, parentContextOf, directionForRun } from './coordination.ts'
import { createReviewCommands } from '../../src/review/commands.ts'

export interface Scheduler {
  stop(): void
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
  const retiring = new Set<Promise<void>>()
  const retirementErrors: unknown[] = []
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
  const notifyBranchOutcomes = async (parentTaskId: string, parent: Agent): Promise<void> => {
    const plan = planOf(parentTaskId)!
    if (plan.children.every(childSettled)) return
    const parentRunId = reviewOf(parentTaskId)?.reviewId ?? Object.values(taskStateOf(apparatus, parentTaskId).runs).at(-1)!.runId
    const ids = new Set(plan.children.map(child => child.taskId))
    for (const fact of apparatus.store.load().entries()) {
      if (!ids.has(fact.subject) || (fact.kind !== 'run/verified' && fact.kind !== 'run/failed')) continue
      const task = taskStateOf(apparatus, fact.subject)
      const run = task.runs[(fact.payload as { runId: string }).runId]!
      try { await postIdentifiedMessage(seams, parent, schedulerMessage({ kind: 'singularity', purpose: 'branch-outcome',
        controlId: apparatus.controlId, parentTaskId, taskId: task.taskId, runId: parentRunId, factSeq: fact.seq,
      }, JSON.stringify({ taskId: task.taskId, runId: run.runId, status: run.status,
        artifactDigest: run.submission?.artifactDigest,
        verdicts: run.evidence.map(({ criterionId, verdict }) => ({ criterionId, verdict })) }))) }
      catch (error) { throw new DispatchError(parentTaskId, parentTaskId, null, error) }
    }
  }
  const failParent = async (parentTaskId: string, commandId: string, reason: string,
    cause: 'business' | 'runtime' = 'runtime'): Promise<void> => {
    const review = reviewOf(parentTaskId)
    if (review !== undefined) {
      if (review.status === 'running') await createReviewCommands(apparatus.store).fail(commandId, parentTaskId, reason)
    }
    else {
      const task = taskStateOf(apparatus, parentTaskId), run = Object.values(task.runs).find(run => run.status === 'running')
      if (run === undefined) return
      declareCaller(apparatus, task.responsibility!.agentId)
      await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
        commandId, taskId: parentTaskId, runId: run.runId, reason, cause })
    }
  }
  const advanceAncestor = async (parentTaskId: string): Promise<void> => {
    const cut = apparatus.store.load()
    const ancestor = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(task => task.decomposition?.children.some(child => child.taskId === parentTaskId))?.taskId ??
      [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
        .find(held => held.children.some(child => child.taskId === parentTaskId))?.reviewId
    if (ancestor !== undefined) await advanceOne(ancestor)
  }
  const terminateBranch = async (taskId: string, reason: string): Promise<void> => {
    const task = taskStateOf(apparatus, taskId)
    const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry
    const run = Object.values(task.runs).find(run => run.status === 'running')
    if (run !== undefined) {
      declareCaller(apparatus, task.responsibility!.agentId)
      await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
        commandId: `branch-stopped:${taskId}/${run.runId}`, taskId, runId: run.runId, reason })
    }
    for (const held of apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values())
        if (held.status === 'running' && held.target.kind === 'acceptance' &&
          held.target.taskId === taskId) {
          await createReviewCommands(apparatus.store).fail(`branch-stopped:${held.reviewId}`, held.reviewId, reason)
          registry.get(SessionId(held.sessionId))?.cancel({ kind: 'parent' })
          for (const child of held.children) await terminateBranch(child.taskId, reason)
        }
    if (task.responsibility !== undefined) {
      const node = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)!
      registry.get(SessionId(node.sessionId))?.cancel({ kind: 'parent' })
    }
    for (const child of task.decomposition?.children ?? []) await terminateBranch(child.taskId, reason)
    const session = live.get(taskId)
    if (session !== undefined) {
      // Closing a child can flush its submit handler, which schedules this parent.
      // Never await that close while holding the parent's advance queue.
      live.delete(taskId)
      const pending = release(taskId, session)
      retiring.add(pending)
      void pending.then(() => retiring.delete(pending), error => {
        retiring.delete(pending)
        retirementErrors.push(error)
      })
    }
  }
  const notify = async (parentTaskId: string, parent: Agent): Promise<void> => {
    const plan = planOf(parentTaskId)!
    const terminal = planOutcomeOf(apparatus, plan)
    if (terminal === undefined) return
    const runId = reviewOf(parentTaskId)?.reviewId ?? Object.values(taskStateOf(apparatus, parentTaskId).runs).at(-1)!.runId
    const unmet = plan.children.filter(child => child.requirement === 'required' && child.status !== 'verified')
    const text = JSON.stringify({ parentTaskId, complete: true, completed: plan.children.length, requiredFailures: unmet.length })
    if (unmet.length > 0) {
      // Publish terminal authority before the notification can wake the parent's next step.
      const reason = 'required delegated responsibilities ended without verification: ' + unmet.map(child => `${child.taskId} (${child.status})`).join(', ')
      const infrastructure = unmet.some(child => {
        const run = Object.values(taskStateOf(apparatus, child.taskId).runs).at(-1)
        return run?.failureCause === 'runtime' || run?.failureCause === 'cancelled'
      })
      await failParent(parentTaskId, `required-work-failed:${parentTaskId}/${runId}`, reason, infrastructure ? 'runtime' : 'business')
    }
    try {
      await postIdentifiedMessage(seams, parent, schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome',
        controlId: apparatus.controlId, parentTaskId, taskId: terminal.subject, runId, factSeq: terminal.seq,
          },
          text,
        ),
      )
    }
    catch (error) { throw new DispatchError(parentTaskId, parentTaskId, null, error) }
    if (unmet.length > 0) await advanceAncestor(parentTaskId)
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
    const operationId = taskId + ':attempt:' + Object.values(state.runs).length
    const expectedRunId = working?.runId ?? runIdOf(apparatus.controlId, node.sessionId, operationId)
    let session = live.get(taskId)
    let attempt = working
    try {
      const agent = session?.agent
      const route = agent === undefined ? (previous?.bubble?.model ?? parent.session.requestHeader()?.config ?? parent.options)
        : (agent.session.requestHeader()?.config ?? agent.options)
      declareCaller(apparatus, childId)
      const run = (attempt ??= await startAttempt(apparatus, { agentId: childId, sessionId: node.sessionId, model: { provider: route.provider!, model: route.model! } },
        taskId, operationId, revision, { purpose: parentRun?.purpose ?? 'solve' },
      ))
      if (run.bubble === undefined) refuse('illegal-transition', 'working Run has no prepared execution bubble')
      const workspace = workspaceOf(apparatus, taskId, run.runId)
      const message = run.stage === 'submitted' ? undefined : schedulerMessage({ kind: 'singularity', purpose: 'dispatch',
        controlId: apparatus.controlId, parentTaskId, taskId, runId: run.runId, factSeq: apparatus.store.committedOf(`start:${run.runId}`)!.seq,
        },
        JSON.stringify({
          assigned: proposalOf(apparatus, state, run),
          method: await methodContext(apparatus, taskId, run),
          direction: directionForRun(apparatus, taskId, run),
          ...parentContextOf(apparatus, taskId),
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
      if (message !== undefined) await confirmWorkflowDelivery(apparatus, taskId, run)
      const actual = session.agent?.session.requestHeader()?.config ?? session.agent?.options
      if (actual !== undefined && (actual.provider !== model.provider || actual.model !== model.model))
        refuse('illegal-transition', 'the child model route differs from its frozen Run bubble')
    } catch (error) {
      if (lifecycle.signal.aborted) throw error
      const failures: unknown[] = [error]
      const run = attempt ?? taskStateOf(apparatus, taskId).runs[expectedRunId]
      if (run !== undefined && taskStateOf(apparatus, taskId).runs[run.runId]!.status === 'running') {
        try { await apparatus.tasks.forAgent(childId).failRun({ commandId: 'dispatch-failed:' + taskId + '/' + run.runId,
          taskId, runId: run.runId, reason: 'child-runtime-failed: ' + String(error),
            }) } catch (failure) { failures.push(failure) }
      }
      if (session !== undefined) try { await release(taskId, session) } catch (failure) { failures.push(failure) }
      try {
        if (run === undefined) {
          // startRun can itself be refused (for example by the frozen workflow budget).
          // Settle the existing owner rather than leave an admitted child ready forever.
          await failParent(parentTaskId, `dispatch-unstarted:${parentTaskId}/${taskId}`, `child could not start: ${taskId}: ${String(error)}`)
          await advanceOne(parentTaskId)
          await advanceAncestor(parentTaskId)
        } else await notify(parentTaskId, parent)
      } catch (failure) { failures.push(failure) }
      throw new DispatchError(parentTaskId, taskId, run?.runId ?? null,
        failures.length === 1 ? error : new AggregateError(failures, 'child dispatch failed: ' + String(error)),
      )
    }
  }
  const advanceOne = async (parentTaskId: string): Promise<readonly string[]> => {
    const cut = apparatus.store.load()
    const tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const heldReview = reviewOf(parentTaskId)
    const stoppedTarget = heldReview?.target.kind === 'acceptance' ? stoppedExplorationOf(tasks, heldReview.target.taskId) : undefined
    if (heldReview?.status === 'running' && stoppedTarget !== undefined) {
      await createReviewCommands(apparatus.store).fail(`branch-stopped:${heldReview.reviewId}`, heldReview.reviewId,
        `exploration stopped by ${stoppedTarget.parentTaskId}: ${stoppedTarget.reason}`)
      const registry = (seams.get === undefined ? seams.agents : seams.get('agents')) as AgentRegistry
      registry.get(SessionId(heldReview.sessionId))?.cancel({ kind: 'parent' })
    }
    for (const child of planOf(parentTaskId)?.children ?? []) {
      const stopped = stoppedExplorationOf(tasks, child.taskId)
      if (stopped !== undefined) await terminateBranch(child.taskId, `exploration stopped by ${stopped.parentTaskId}: ${stopped.reason}`)
    }
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
      for (const child of plan.children)
        await terminateBranch(child.taskId, 'direct parent Run settled before delegated work completed')
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
    await notifyBranchOutcomes(parentTaskId, parent)
    await notify(parentTaskId, parent)
    return opened
  }
  return {
    stop: () => { lifecycle.abort() },
    advance: (parentTaskId) => {
      lifecycle.signal.throwIfAborted()
      if (retirementErrors.length) throw new AggregateError(retirementErrors, 'child close failed')
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
      const stopped = lifecycle.signal.aborted
      lifecycle.abort()
      const pending = await Promise.allSettled([...advancing.values()])
      await Promise.allSettled([...retiring])
      const failures = [...retirementErrors, ...pending.flatMap((result) => (result.status === 'rejected' && !stopped ? [result.reason] : []))]
      for (const [taskId, session] of live) try { await release(taskId, session) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'child unload failed')
    })()),
  }
}
