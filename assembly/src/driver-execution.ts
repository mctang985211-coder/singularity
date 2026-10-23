import type { LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { callerOf, declareCaller, taskStateOf } from './apparatus.ts'
import { answerChild, askParent, assertActive, directionForRun, parentPlan, waitingReason } from './coordination.ts'
import { workflowSteps } from './evaluation-cost.ts'
import type { Admission } from './execution.ts'
import { sha256, taskIdOf } from './ids.ts'
import { improvementTaskId, improvementTools } from './improvement.ts'
import { parentMemorySessionsOf, readMemoryForAgent } from './memory-view.ts'
import { memoryContextOf } from './memory.ts'
import { confirmWorkflowDelivery, methodContext, mountMethodSkills, runMethodTool } from './method-run.ts'
import { methodToolReferences } from './method.ts'
import { ParentMemoryUnavailable, parentMemoryRefOf, prepareParentMemory, readParentMemory, type ParentMemoryRef } from './parent-memory.ts'
import { readForAgent } from './read.ts'
import { repair } from './repair.ts'
import { methodReviewTools, reviewOf, submitReview } from './review.ts'
import { linkRsiMemory, rsiMemorySourceOf } from './rsi-memory.ts'
import { proposeRsiMethod } from './rsi-proposal.ts'
import { rsiState, rsiToolReason } from './rsi-state.ts'
import { snapshotOf } from './snapshot.ts'
import { submit } from './submission.ts'
import { decompose, propose, retry } from './surfaces.ts'

import type { ReleaseLifecycle } from './driver-release.ts'
import type { ReviewLifecycle } from './driver-review.ts'
import type { RsiLifecycle } from './driver-rsi.ts'
import type { DriverRuntime } from './driver-runtime.ts'
import type { TaskDriver } from './task-service.ts'

export function createTaskLifecycle(runtime: DriverRuntime, reviewLifecycle: ReviewLifecycle,
  rsi: RsiLifecycle, releaseLifecycle: ReleaseLifecycle) {
  const { apparatus, options, controller, backgroundErrors, tasks, registry, owner, parentOf,
    nativeEvents, work, scheduler, evaluation } = runtime
  const { acceptanceFor, restoreJudgement } = reviewLifecycle
  const { taskSignal, rsiStatus, closeRoot, stopRsiWork, rsiRootOf, schedule } = rsi
  const { validateChampion } = releaseLifecycle
  const memoryRef = async (agentId: string): Promise<ParentMemoryRef | undefined> => {
    const task = owner(agentId)
    if (task === undefined) return undefined
    const parent = parentPlan(apparatus, task.taskId)
    if (parent === undefined) return undefined
    const cut = apparatus.store.load(), scope = (await memoryContextOf(apparatus, agentId)).scope
    const found: ParentMemoryRef[] = []
    for (const sessionId of parentMemorySessionsOf(cut, { ...parent, kind: cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).has(parent.id) ? 'task' : 'review' })) {
      const ref = parentMemoryRefOf(sessionId, await nativeEvents(sessionId), scope)
      if (ref !== undefined) found.push(ref)
    }
    if (found.length > 1) refuse('evidence-input-mismatch', 'assigned scope has checkpoints in multiple parent sessions')
    return found[0]
  }
  const admission: Admission = (exec) => {
    if (exec.agent === undefined) return undefined
    const review = reviewOf(apparatus, String(exec.agent.id))
    if (review !== undefined && review.target.kind !== 'acceptance' && !methodReviewTools.has(exec.name))
      return 'Method review only reads evidence and writes/submits its judgment; it cannot execute, delegate or browse'
    const task = owner(String(exec.agent.id))
    const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
    if (run?.purpose === 'improve' && !improvementTools.has(exec.name))
      return 'RSI only reads evidence, edits candidate/report files, proposes and submits; execution belongs to the runtime'
    if (run?.purpose === 'improve') {
      const reason = rsiToolReason(task!, exec.name)
      if (reason !== undefined) return reason
    }
    if (exec.name.startsWith('singularity_')) return undefined
    if (review !== undefined) return review.status === 'running' ? ['read', 'read_image', 'glob', 'grep'].includes(exec.name) ? undefined : waitingReason(apparatus, review.reviewId) : 'review Run has settled'
    if (['read', 'read_image', 'glob', 'grep'].includes(exec.name)) return undefined
    return run !== undefined && (run.status !== 'running' || run.stage !== 'working')
      ? 'Run has closed write admission'
      : task === undefined ? undefined : waitingReason(apparatus, task.taskId)
  }
  const execution = options.execution(admission, (failure) =>
    controller.signal.aborted ? Promise.resolve() : work(async () => {
      if (controller.signal.aborted) return
      const review = reviewOf(apparatus, failure.sessionId)
      if (review?.status === 'running')
        await createReviewCommands(apparatus.store).fail(
          `turn-failed:${review.reviewId}/${failure.seq}`,
          review.reviewId,
          JSON.stringify(failure),
        )
      const task = owner(failure.sessionId)
      if (review !== undefined) await scheduler.advance(review.reviewId)
      if (task === undefined || taskSignal(task.taskId).aborted) return
      const run = Object.values(task.runs).at(-1)
      if (run?.status !== 'running' || run.stage !== 'working') return
      declareCaller(apparatus, task.responsibility!.agentId)
      await apparatus.tasks
        .forAgent(task.responsibility!.agentId)
        .failRun({
          commandId: `turn-failed:${failure.sessionId}/${failure.seq}`,
          taskId: task.taskId,
          runId: run.runId,
          reason: JSON.stringify(failure),
          ...(failure.reason.kind === 'aborted' && failure.reason.reason.kind === 'user' ? { cause: 'cancelled' as const } : {}),
        })
      const terminal = taskStateOf(apparatus, task.taskId)
      await closeRoot(
        terminal,
        terminal.runs[run.runId]!,
        'failed',
      )
      await scheduler.advance(task.taskId)
      const parent = parentOf(task.taskId)
      if (parent !== undefined) await scheduler.advance(parent)
      schedule()
    }).catch((error) => {
      if (!controller.signal.aborted) backgroundErrors.push(error)
      throw error
    }),
  )
  const service: Omit<TaskDriver, 'close'> = {
    cancel: ({ sessionId, taskId }) => work(async () => {
      const task = taskId === undefined ? owner(sessionId) : tasks().get(taskId)
      const holder = task?.responsibility === undefined ? undefined : apparatus.store.load()
        .stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)
      if (task === undefined || holder?.sessionId !== sessionId || parentOf(task.taskId) !== undefined ||
        Object.values(task.runs).at(-1)?.purpose !== 'solve') refuse('not-responsible', 'cancel requires a business root session')
      const run = Object.values(task.runs).at(-1)!
      if (run.status === 'running') {
        declareCaller(apparatus, task.responsibility!.agentId)
        await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({ commandId: `cancel:${task.taskId}:${run.runId}`,
          taskId: task.taskId, runId: run.runId, cause: 'cancelled', reason: 'cancelled by user' })
        registry().get(SessionId(sessionId))?.cancel({ kind: 'user' })
        await scheduler.advance(task.taskId)
        await closeRoot(taskStateOf(apparatus, task.taskId), taskStateOf(apparatus, task.taskId).runs[run.runId]!, 'cancelled')
      } else if ((run.purpose === 'solve' && run.failureCause !== 'cancelled' && task.learning !== false && task.rsi === undefined) ||
        task.rsi?.status === 'pending' || task.rsi?.status === 'running' || task.rsi?.status === 'failed' || task.rsi?.status === 'cancelled') {
        if (task.closure === undefined) await closeRoot(task, run, run.status === 'verified' ? 'accepted' : 'failed')
        if (taskStateOf(apparatus, task.taskId).rsi === undefined)
          await rsiStatus(task.taskId, { status: 'pending', detail: 'business root closed; trajectory is available for asynchronous RSI' })
        if (taskStateOf(apparatus, task.taskId).rsi!.status !== 'cancelled')
          await rsiStatus(task.taskId, { status: 'cancelled', detail: 'RSI cancelled by user' })
        rsi.abort(task.taskId)
        await stopRsiWork(task.taskId)
      } else if (run.failureCause !== 'cancelled') refuse('illegal-transition', 'Task already ended')
      return { status: 'cancelled' as const, taskId: task.taskId }
    }),
    inheritRsi: input => work(() => linkRsiMemory(apparatus,
      (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as NonNullable<ChildSessionSeams['sessions']>, input)),
    prepareMemory: (agent) => work(async () => {
      const task = owner(String(agent.id))
      // Acceptance reviewers remain independent from the subject's working narrative.
      if (task === undefined || reviewOf(apparatus, String(agent.id)) !== undefined) return
      const signal = taskSignal(task.taskId)
      signal.throwIfAborted()
      const source = await rsiMemorySourceOf(apparatus, String(agent.id))
      if (source !== undefined) {
        const context = await memoryContextOf(apparatus, String(agent.id))
        const sourceContext = await memoryContextOf(apparatus, source.task.responsibility!.agentId)
        const ownEvents = await nativeEvents(String(agent.session.id))
        const ownRef = parentMemoryRefOf(String(agent.session.id), ownEvents, context.scope)
        if (ownRef !== undefined) { await readParentMemory(apparatus.persistence, ownRef); return }
        const handle = await apparatus.persistence.open(SessionId(source.sessionId), 'read')
        try {
          const stored = await handle.read()
          const origin = Session.create(handle.id, stored.events, handle.header, handle.inheritedEventCount)
          const inheritedRef = parentMemoryRefOf(source.sessionId, stored.events, sourceContext.scope)
          const inherited = inheritedRef === undefined ? undefined : await readParentMemory(apparatus.persistence, inheritedRef)
          signal.throwIfAborted()
          await prepareParentMemory({
            sessions: (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as NonNullable<ChildSessionSeams['sessions']>,
            sessionPersistence: apparatus.persistence, llm: options.seams.get?.('llm') as LlmRuntime,
          }, agent, {
            memoryId: 'memory-' + sha256(`rsi:${source.task.taskId}/${source.run.runId}/${task.taskId}/${Object.values(task.runs).at(-1)!.runId}`),
            context: { ...context, evidenceRefs: [...context.evidenceRefs, ...sourceContext.evidenceRefs],
              excludedTexts: [...context.excludedTexts, ...sourceContext.excludedTexts] },
            focus: 'Carry forward the previous RSI decisions and their reasons, tested and rejected mechanisms, no-winner or review rejection causes, round/method/measurement/publication references, successful habits and regression risks, and unresolved hypotheses. All RSI usage is excluded from every comparison.',
            maxTokens: 32768, signal,
            ...(inherited === undefined ? {} : { inherited }),
          }, origin)
        } finally { await handle.close() }
        return
      }
      const parent = parentPlan(apparatus, task.taskId)
      if (parent === undefined) return
      const prior = await memoryRef(String(agent.id))
      if (prior !== undefined) { await readParentMemory(apparatus.persistence, prior); return }
      const parentNode = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, parent.agentId)!
      const parentAgent = registry().get(SessionId(parentNode.sessionId))
      if (parentAgent === undefined) refuse('not-responsible', 'parent memory requires the exact live parent session')
      const inheritedRef = await memoryRef(parent.agentId)
      const inherited = inheritedRef === undefined ? undefined : await readParentMemory(apparatus.persistence, inheritedRef)
      const sessions = (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as NonNullable<ChildSessionSeams['sessions']>
      const llm = options.seams.get?.('llm') as LlmRuntime
      const run = Object.values(task.runs).at(-1)!
      signal.throwIfAborted()
      await prepareParentMemory({ sessions, sessionPersistence: apparatus.persistence, llm }, parentAgent, {
          memoryId: 'memory-' + sha256(`${parent.id}/${parent.runId}/${task.taskId}/${run.runId}`),
          context: await memoryContextOf(apparatus, String(agent.id)), focus: task.contract!.goal,
          maxTokens: 32768, signal,
          ...(inherited === undefined ? {} : { inherited }),
      })
    }),
    failed: (agentId) => {
      const review = reviewOf(apparatus, agentId)
      if (review !== undefined) return review.status === 'failed'
      const task = owner(agentId)
      const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      return run?.status === 'failed'
    },
    reviewTarget: agentId => reviewOf(apparatus, agentId)?.target,
    responsibility: (agentId) => {
      const task = owner(agentId), review = reviewOf(apparatus, agentId)
      if (task === undefined && review === undefined) return undefined
      const id = review?.reviewId ?? task!.taskId
      const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      const working = review === undefined ? run?.status === 'running' && run.stage === 'working' : review.status === 'running'
      return { waiting: waitingReason(apparatus, id) ?? null,
        canPlan: working && waitingReason(apparatus, id, apparatus.store.load(), 'plan') === undefined }
    },
    enter: (agent, messages, model) =>
      work(async () => {
        const agentId = String(agent.id)
        const review = reviewOf(apparatus, agentId)
        if (review?.status === 'running') {
          const subject = review.target.kind === 'acceptance' ? tasks().get(review.target.taskId) : undefined
          const limit = subject?.workflowLimits?.maxSteps ?? DEFAULT_WORKFLOW_LIMITS.maxSteps
          if ((await nativeEvents(review.sessionId)).filter(event => event.type === 'step/start').length >= limit) {
            await createReviewCommands(apparatus.store).fail(`step-limit:${review.reviewId}`, review.reviewId, `review step limit ${limit} exhausted`)
            await scheduler.advance(review.reviewId)
            agent.cancel({ kind: 'parent' }, { keepInbox: true })
            return undefined
          }
        }
        const assignedTask = owner(agentId), assignedRun = assignedTask === undefined ? undefined : Object.values(assignedTask.runs).at(-1)
        if (assignedTask !== undefined && assignedRun?.status === 'running' && assignedRun.stage === 'working') {
          let root = assignedTask
          for (let parent = parentOf(root.taskId); parent !== undefined; parent = parentOf(root.taskId)) {
            const taskParent = tasks().get(parent)
            if (taskParent === undefined) break
            root = taskParent
          }
          const limit = root.workflowLimits?.maxSteps ?? (parentOf(root.taskId) === undefined ? undefined : DEFAULT_WORKFLOW_LIMITS.maxSteps)
          if (limit !== undefined) {
            const rootSession = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, root.responsibility!.agentId)!.sessionId
            const steps = await workflowSteps(apparatus, root.taskId)
            if (steps >= limit) {
              const run = Object.values(root.runs).at(-1)!
              if (run.status === 'running') {
                declareCaller(apparatus, root.responsibility!.agentId)
                await apparatus.tasks.forAgent(root.responsibility!.agentId).failRun({ commandId: `step-limit:${root.taskId}:${run.runId}`,
                  taskId: root.taskId, runId: run.runId, cause: 'business', reason: `workflow step limit ${limit} exhausted` })
                await scheduler.advance(root.taskId)
                await closeRoot(taskStateOf(apparatus, root.taskId), taskStateOf(apparatus, root.taskId).runs[run.runId]!, 'failed')
                registry().get(SessionId(rootSession))?.cancel({ kind: 'parent' }, { keepInbox: true })
                schedule()
              }
              return undefined
            }
          }
        }
        if (assignedTask !== undefined && assignedRun?.status === 'running' && assignedRun.stage === 'working' && assignedRun.purpose !== 'improve')
          await confirmWorkflowDelivery(apparatus, assignedTask.taskId, assignedRun)
        if (
          reviewOf(apparatus, agentId) !== undefined ||
          (owner(agentId) !== undefined && owner(agentId)!.closure === undefined)
        )
          return undefined
        let human = messages.findLast((m) => m.source.kind === 'user')
        if (human === undefined) {
          const handle = await apparatus.persistence.open(agent.session.id, 'read')
          try {
            human = (await handle.read()).events
              .filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
              .at(-1)?.data as UserMessage | undefined
          } finally {
            await handle.close()
          }
        }
        if (human === undefined) return undefined
        const goal = human.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (!goal) refuse('malformed-declaration', 'root request requires a goal')
        if (owner(agentId)?.taskId === taskIdOf(apparatus.controlId, agentId, `human:${human.id}`)) return undefined
        let request: { goal?: string; contract?: TaskContract; learning?: boolean } = { goal }
        if (goal.trim().startsWith('{')) {
          const raw = JSON.parse(goal) as Record<string, unknown>
          if ('contract' in raw) {
            assertClosedKeys(raw, ['contract', 'learning'], 'Task request', 'malformed-declaration')
            if (typeof raw['learning'] !== 'boolean') refuse('malformed-declaration', 'Task request learning must be boolean')
            request = { contract: raw['contract'] as TaskContract, learning: raw['learning'] }
          } else request = { contract: raw as unknown as TaskContract }
        }
        const proposal = await propose(apparatus, { agentId, sessionId: agentId, model }, `human:${human.id}`, request)
        return schedulerMessage(
          {
            kind: 'singularity',
            purpose: 'dispatch',
            controlId: apparatus.controlId,
            parentTaskId: proposal.taskId,
            taskId: proposal.taskId,
            runId: proposal.runId,
            factSeq: apparatus.store.committedOf(`start:${proposal.runId}`)!.seq,
          },
          JSON.stringify({ assigned: proposal, method: await methodContext(apparatus, proposal.taskId, taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!),
            direction: directionForRun(apparatus, proposal.taskId, taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!) }),
        )
      }),
    activate: (sessionId) =>
      work(async () => {
        await mkdir(join(apparatus.workspaceRoot, 'agents', sha256(sessionId)), { recursive: true })
        for (const node of apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values())
          if (node.sessionId === sessionId) declareCaller(apparatus, node.agentId)
        await repair(apparatus, restoreJudgement, sessionId)
        const review = reviewOf(apparatus, sessionId)
        if (review !== undefined) await scheduler.advance(review.reviewId)
        for (const task of tasks().values())
          if (task.responsibility?.agentId === sessionId) {
            await scheduler.advance(task.taskId)
            // Explicit activation may retry startup even if it failed before creating
            // the analysis Task/Run. Terminal analysis and user cancellation stay terminal.
            if (task.rsi?.status === 'failed') {
              const analysis = tasks().get(improvementTaskId(task.taskId, task.closure!.runId))
              const run = analysis === undefined ? undefined : Object.values(analysis.runs).at(-1)
              if (analysis?.closure === undefined && (run === undefined || run.status === 'running'))
                await rsiStatus(task.taskId, task.rsi.trace === undefined
                  ? { status: 'pending', detail: 'retrying startup before its first sealed trajectory' }
                  : { status: 'running', trace: task.rsi.trace, detail: 'resuming the same unfinished RSI from its sealed trajectory' })
            }
          }
        schedule()
      }),
    forCall: (exec) => {
      const agent = execution.assertCaller(exec),
        caller = callerOf(agent)
      const task = owner(caller.agentId),
        review = reviewOf(apparatus, caller.agentId)
      const signal = AbortSignal.any([exec.signal, taskSignal(task?.taskId ?? review?.reviewId ?? '')])
      const current = () =>
        review?.reviewId ?? task?.taskId ?? refuse('not-responsible', 'caller has no assigned responsibility')
      return {
        current,
        memory: (input) => work(async () => {
          if (input?.ref === undefined) {
            try { await service.prepareMemory(agent) }
            catch (error) { if (!(error instanceof ParentMemoryUnavailable)) throw error }
          }
          return readMemoryForAgent(apparatus, caller.agentId, input)
        }),
        stopExplorations: (input) => work(async () => {
          if (!input.requestKey) refuse('malformed-declaration', 'stop exploration requires a stable requestKey')
          if (review !== undefined) refuse('not-responsible', 'independent reviews delegate only required evidence Tasks')
          const result = await apparatus.tasks.forAgent(caller.agentId).stopExplorations({
            commandId: 'stop-exploration-' + sha256(`${current()}/${input.requestKey}`),
            parentTaskId: current(), taskIds: input.taskIds, reason: input.reason,
          })
          await scheduler.advance(current())
          return result
        }),
        askParent: (input) => work(async () => {
          if (review !== undefined) refuse('not-responsible', 'a review has no parent responsibility')
          const release = await execution.drain(exec)
          try {
            const result = await askParent(apparatus, caller, current(), input)
            await scheduler.advance(result.parentId)
            return result
          } finally { release() }
        }),
        answer: (input) => work(async () => {
          const result = await answerChild(apparatus, caller, input)
          await scheduler.advance(current())
          return result
        }),
        retry: (input) => work(async () => {
          const result = await retry(apparatus, caller, String(exec.callId), input)
          await scheduler.advance(input.taskId)
          return result
        }),
        runMethod: (input) =>
          work(async () => {
            assertActive(apparatus, current())
            return runMethodTool(apparatus, caller, input.taskId, String(exec.callId), signal, input.tool, input.candidatePath)
          }),
        proposeMethod: (input) => work(async () => {
          try {
            const result = await proposeRsiMethod(apparatus, caller.agentId, input, signal)
            schedule()
            return result
          } finally {
            const root = task === undefined ? undefined : rsiRootOf(task.taskId)
            if (root !== undefined) await stopRsiWork(root.taskId)
          }
        }),
        history: (input) => work(() => readForAgent(apparatus, caller.agentId, input, evaluation)),
        decompose: (input) => work(async () => {
          if (review !== undefined && review.target.kind !== 'acceptance') refuse('not-responsible', 'method reviews do not delegate or execute evidence Tasks')
          const release = await execution.drain(exec)
          try { return await decompose(apparatus, scheduler, caller, { ...input, taskId: current() }) }
          finally { release(); schedule() }
        }),
        submit: (input) =>
          work(async () => {
            signal.throwIfAborted()
            assertActive(apparatus, current())
            if (review !== undefined) {
              if (!('path' in input)) refuse('not-responsible', 'reviewers submit their own review.json')
              const release = await execution.drain(exec)
              try { return await submitReview(apparatus, review, input.path) }
              finally { release() }
            }
            const task = owner(caller.agentId)!
            const reason = rsiToolReason(task, 'singularity_submit')
            if (reason !== undefined) refuse('illegal-transition', reason)
            try {
              return await submit(
                apparatus,
                execution,
                caller,
                exec,
                { ...input, taskId: task.taskId },
                signal,
                acceptanceFor(agent),
                () => validateChampion(taskStateOf(apparatus, task.taskId), agent, signal),
              )
            } finally {
              const root = rsiRootOf(task.taskId)
              if (root !== undefined) await stopRsiWork(root.taskId)
              const state = taskStateOf(apparatus, task.taskId),
                run = Object.values(state.runs).at(-1)!,
                parent = parentOf(task.taskId)
              if (run.status !== 'running') {
                if (parent !== undefined) await scheduler.advance(parent)
                schedule()
              }
            }
          }),
      }
    },
    read: async () => {
      if (backgroundErrors.length) throw new AggregateError(backgroundErrors, 'background RSI delivery failed')
      return snapshotOf(apparatus)
    },
    rsiState: (agentId) => {
      const task = owner(agentId)
      return task === undefined ? undefined : rsiState(task)
    },
    mountSkills: (agent) => mountMethodSkills(apparatus, agent),
    memoryContext: (agentId) => memoryContextOf(apparatus, agentId),
    world: (agentId) => {
      const review = reviewOf(apparatus, agentId),
        task = owner(agentId),
        run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      const root =
        review?.workspace ?? run?.bubble?.workspace.ref ?? join(apparatus.workspaceRoot, 'agents', sha256(agentId))
      return {
        root,
        writable:
          review === undefined
            ? run === undefined || (run.status === 'running' && run.stage === 'working' && waitingReason(apparatus, task!.taskId) === undefined)
            : review.status === 'running' && waitingReason(apparatus, review.reviewId) === undefined,
        protected:
          review === undefined
            ? (run?.bubble?.inputs.map((i) => join(root, i.name)) ?? [])
            : [
                join(root, 'subject.json'),
                join(root, 'submitted-artifact'),
                ...(review.target.kind === 'acceptance'
                  ? taskStateOf(apparatus, review.target.taskId).contract!.inputs.map((i) => join(root, 'inputs', i.name))
                  : []),
              ],
        references: [...((review !== undefined || run?.purpose === 'improve') && apparatus.domain.suite === undefined ? [apparatus.domain.dir] : []), ...apparatus.domain.references,
          ...(run === undefined ? [] : methodToolReferences(apparatus, run)),
        ],
      }
    },
  }
  return { service, execution }
}
