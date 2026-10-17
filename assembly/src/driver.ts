import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { aborted } from 'node:util'
import type { LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import {
  TASK_PROTOCOL,
  TASK_VERSION,
  type RevisionRef,
  type RunState,
  type TaskState,
} from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import type { RoundRequest, RSIStatus } from '../../src/task/lifecycle.ts'
import type { TaskView } from '../../src/task/view.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, reviewCriterion, type ReviewRun } from '../../src/review/protocol.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { callerOf, declareCaller, taskStateOf, openApparatus, type Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import type { BubbleWorld } from './bubble.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { repair } from './repair.ts'
import { createScheduler } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, retry } from './surfaces.ts'
import { submit, judgeAndRecord, type AcceptanceReview, type Submission, type SubmissionInput } from './submission.ts'
import { seedMethod, loadMethod, methodToolReferences } from './method.ts'
import { mountMethodSkills, runMethodTool } from './method-run.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { acceptanceSubject, reviewSubject, reviewOf, submitReview, methodReviewTools, type ReviewWitness } from './review.ts'
import { explorationOf, startImprovement, improvementTools } from './improvement.ts'
import { proposeRsiMethod, assertRsiReportReady } from './rsi-proposal.ts'
import { createEvolution, type EvolutionOptions } from './evolution.ts'
import { createNativeSolve, observeSolve } from './native-solve.ts'
import { releaseMethod } from './method-release.ts'
import { readForAgent, type ReadInput } from './read.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { sha256, taskIdOf } from './ids.ts'
import { memoryContextOf, type MemoryContext } from './memory.ts'
import { parentMemoryRefOf, prepareParentMemory, readParentMemory, type ParentMemoryRef } from './parent-memory.ts'
import { parentMemorySessionsOf, readMemoryForAgent, type MemoryReadInput } from './memory-view.ts'
import { linkRsiMemory, rsiMemorySourceOf, type RsiMemoryInput } from './rsi-memory.ts'
import { answerChild, askParent, assertActive, coordinationOf, parentPlan, waitingReason, type AskParent, type AnswerChild } from './coordination.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { singularity: TaskService }
}
export interface TaskService {
  restart(): Promise<void>
  inheritRsi(input: RsiMemoryInput): Promise<void>
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  mountSkills(agent: Agent): Promise<void>
  world(agentId: string): BubbleWorld
  memoryContext(agentId: string): Promise<MemoryContext>
}
export interface AgentTaskSurface {
  memory(input?: MemoryReadInput): Promise<unknown>
  stopExplorations(input: { readonly taskIds: readonly string[]; readonly reason: string; readonly requestKey: string }): Promise<unknown>
  askParent(input: AskParent): Promise<unknown>
  answer(input: AnswerChild): Promise<unknown>
  retry(input: { readonly taskId: string }): Promise<Proposal>
  runMethod(input: { readonly taskId: string
    readonly tool: string
    readonly candidatePath?: string }): Promise<{ artifact: string }>
  proposeMethod(input: { readonly path: string }): Promise<unknown>
  history(input?: ReadInput): Promise<unknown>
  decompose(input: DecomposeInput): Promise<PlanRecord>
  submit(input: SubmissionInput): Promise<Submission | ReviewWitness>
  current(): string
}
export interface PlannedChild {
  readonly key: string
  readonly contract: TaskContract
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly requirement: 'required' | 'exploration'
  readonly handoff?: import('../../src/task/decomposition.ts').DecompositionChild['handoff']
}
export interface DecomposeInput { readonly taskId: string; readonly children: readonly PlannedChild[] }
export interface PlanRecord { readonly taskId: string
  readonly opened: readonly string[] }
export interface Proposal {
  readonly taskId: string
  readonly runId: string
  readonly workspace: string
  readonly contract: TaskContract
  readonly phase: TaskView['phase']
  readonly method: RevisionRef
}
export interface DriverOptions {
  readonly initialMethod?: unknown
  readonly attachments: Apparatus['attachments']
  readonly projections: Apparatus['projections']
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends Omit<TaskService, 'restart'> {
  stop(): void
  prepareMemory(agent: Agent): Promise<void>
  failed(agentId: string): boolean
  reviewTarget(agentId: string): ReviewRun['target'] | undefined
  responsibility(agentId: string): ReturnType<typeof coordinationOf> | undefined
  enter(agent: Agent, messages: readonly UserMessage[], model: { provider: string; model: string },
  ): Promise<UserMessage | undefined>
  activate(sessionId: string): Promise<void>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence, options.attachments, options.projections,
  )
  const measurement = apparatus.domain.measurement
  const criterion = reviewCriterion(apparatus.domain.templates.get(apparatus.domain.rootTemplate)!.criteria[0]!)
  const evaluation: Pick<EvolutionOptions, 'criterion' | 'metric' | 'trials' | 'weights' | 'calibration'> = {
    criterion,
    metric: { measured: measurement?.criterion ?? { ...criterion, criterionId: `${criterion.criterionId}:quality` },
      unit: measurement === undefined ? 'pass' : 'baseline area ratio', direction: measurement?.direction ?? 'higher' },
    trials: 1,
    weights: measurement === undefined ? { quality: 1, cost: 1 } : { quality: 100, cost: 15 },
    calibration: { floor: measurement === undefined ? 0 : 0.01, source: 'declared' },
  }
  const controller = new AbortController(),
    active = new Set<Promise<unknown>>(),
    jobs = new Map<string, Promise<void>>()
  const backgroundErrors: unknown[] = []
  let closing: Promise<void> | undefined,
    scheduled = false
  let providerStopped = false
  const tasks = () => apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const registry = () =>
    (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry
  const owner = (agentId: string) => [...tasks().values()].findLast((t) => t.responsibility?.agentId === agentId)
  const parentOf = (id: string) =>
    [...tasks().values()].find((t) => t.decomposition?.children.some((c) => c.taskId === id))?.taskId ??
    [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find((r) =>
      r.children.some((c) => c.taskId === id),
    )?.reviewId
  const nativeEvents = async (sessionId: string): Promise<readonly SessionEvent[]> => {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  }
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
  const taskFact = (commandId: string, kind: string, taskId: string, payload: unknown, as?: string) =>
    apparatus.store.emit({
      commandId,
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind,
      subject: taskId,
      payload,
      ...(as === undefined ? {} : { as }),
    })
  const rsiStatus = (taskId: string, value: RSIStatus) => {
    const prior = apparatus.store.load().entriesOf(TASK_PROTOCOL, TASK_VERSION).findLast(fact => fact.subject === taskId && fact.kind === 'rsi/status')
    return taskFact(`rsi:${taskId}:${value.status}:${prior?.seq ?? 0}`, 'rsi/status', taskId, value)
  }
  const work = <T>(step: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) refuse('illegal-transition', 'driver is closing')
    controller.signal.throwIfAborted()
    const pending = step()
    active.add(pending)
    void pending.then(() => active.delete(pending), () => active.delete(pending),
    )
    return pending
  }
  const scheduler = createScheduler(apparatus, options.seams)
  const acceptanceFor =
    (agent: Agent): AcceptanceReview =>
    async (taskId, run, checks) =>
      reviewSubject(apparatus, options.seams, agent, `accept:${taskId}/${run.runId}`,
      await acceptanceSubject(apparatus, taskId, run, checks),
        controller.signal,
        run.revision,
        false,
      )
  const restoreJudgement = async (taskId: string, run: RunState): Promise<boolean> => {
    const parent = registry().get(SessionId(taskStateOf(apparatus, taskId).responsibility!.agentId))
    if (parent === undefined) return false
    await judgeAndRecord(apparatus, taskId, run, controller.signal, acceptanceFor(parent))
    return true
  }
  const closeRoot = async (
    task: TaskState,
    run: RunState,
    reason: 'accepted' | 'failed',
  ): Promise<void> => {
    if (parentOf(task.taskId) !== undefined) return
    if (task.closure === undefined)
      await taskFact(
        `close:${task.taskId}`,
        'task/closed',
        task.taskId,
        { runId: run.runId, reason },
        `agent:${task.responsibility!.agentId}`,
      )
    if (run.purpose === 'solve' && taskStateOf(apparatus, task.taskId).rsi === undefined)
      await rsiStatus(task.taskId, {
        status: 'pending',
        detail: 'business root closed; trajectory is available for asynchronous RSI',
      })
    if (run.purpose === 'improve' && run.relatedTo !== undefined) {
      const root = taskStateOf(apparatus, run.relatedTo.taskId)
      if (root.rsi?.status === 'running')
        await rsiStatus(root.taskId, {
          status: run.status === 'verified' ? 'completed' : 'failed',
          detail:
            run.status === 'verified'
              ? 'independently reviewed RSI report submitted'
              : (run.failureReason ?? 'RSI report failed acceptance'),
        })
    }
  }
  const admission: Admission = (exec) => {
    if (providerStopped) return 'provider 不稳定；整张图已结束'
    if (exec.agent === undefined) return undefined
    const review = reviewOf(apparatus, String(exec.agent.id))
    if (review !== undefined && review.target.kind !== 'acceptance' && !methodReviewTools.has(exec.name))
      return 'Method review only reads evidence and writes/submits its judgment; it cannot execute, delegate or browse'
    const task = owner(String(exec.agent.id))
    const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
    if (run?.purpose === 'improve' && !improvementTools.has(exec.name))
      return 'RSI only reads evidence, edits candidate/report files, proposes and submits; execution belongs to the runtime'
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
      if (task === undefined) return
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
        })
      await scheduler.advance(task.taskId)
      const terminal = taskStateOf(apparatus, task.taskId)
      await closeRoot(
        terminal,
        terminal.runs[run.runId]!,
        'failed',
      )
      const parent = parentOf(task.taskId)
      if (parent !== undefined) await scheduler.advance(parent)
      schedule()
    }).catch((error) => {
      if (!controller.signal.aborted) backgroundErrors.push(error)
      throw error
    }),
  )
  const startJob = (key: string, run: () => Promise<void>): void => {
    if (jobs.has(key)) return
    const pending = run()
    jobs.set(key, pending)
    void pending.then(
      () => jobs.delete(key),
      (error) => {
        jobs.delete(key)
        if (!controller.signal.aborted) backgroundErrors.push(error)
      },
    )
  }
  const idle = async (agents: readonly Agent[]): Promise<void> => {
    await Promise.race([
      Promise.all(agents.map((agent) => agent.whenIdle())),
      aborted(controller.signal, agents),
    ])
    controller.signal.throwIfAborted()
    const sessions = (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as ChildSessionSeams['sessions']
    for (const agent of agents)
      if (!(await sessions!.flush(agent.session)))
        refuse('write-not-durable', `session ${agent.id} has no durability listener`)
  }
  const advanceRound = async (task: TaskState, request: RoundRequest, parent: Agent): Promise<void> => {
    const { runId: _runId, status: _status, error: _error, ...round } = request
    try {
      const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation,
        loadMethod: async (revision) => (await loadMethod(apparatus, revision)).assets,
        baseline: async ({ revision, started }) => {
          const ownerRun = task.runs[request.runId]!
          const source = ownerRun.relatedTo!
          const incumbent = taskStateOf(apparatus, source.taskId).runs[source.runId]!
          if (incumbent.revision.digest !== revision.digest)
            refuse('evidence-input-mismatch', 'incumbent must be the sealed business root method')
          if (evaluation.trials !== 1)
            refuse('malformed-declaration', 'one sealed business root provides exactly one incumbent trial')
          await started(source)
          return observeSolve(apparatus, source.taskId, source.runId, controller.signal,
            measurement === undefined ? undefined : { digest: measurement.criterion.implementationDigest,
              measure: (source, signal) => measurement.measure(source, signal) })
        },
        solve: createNativeSolve(
          apparatus,
          options.seams,
          parent,
          controller.signal, measurement === undefined ? undefined
          : { digest: measurement.criterion.implementationDigest, measure: (source, signal) => measurement.measure(source, signal),
              },
        ),
      })
      const decision = await evolution.runRound(round)
      if (decision.winner !== null)
        await releaseMethod(
          apparatus,
          options.seams,
          parent,
          `round:${round.roundId}:release`,
          { roundId: round.roundId },
          controller.signal,
        )
      await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, {
        roundId: round.roundId,
        status: 'completed',
      })
    } catch (error) {
      if (controller.signal.aborted) return
      await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, {
        roundId: round.roundId,
        status: 'failed',
        error: String(error),
      })
    }
    await notifyRound(task, request, parent)
  }
  const notifyRound = async (task: TaskState, request: RoundRequest, parent: Agent): Promise<void> => {
    const fact = apparatus.store.committedOf(`round-settled:${request.roundId}`)!
    await postIdentifiedMessage(
      options.seams,
      parent,
      schedulerMessage(
        {
          kind: 'singularity',
          purpose: 'plan-outcome',
          controlId: apparatus.controlId,
          parentTaskId: task.taskId,
          taskId: task.taskId,
          runId: request.runId,
          factSeq: fact.seq,
        },
        JSON.stringify({ roundId: request.roundId, outcome: fact.payload }),
      ),
    )
  }
  const advance = (): void => {
    if (controller.signal.aborted) return
    for (const task of tasks().values()) {
      if (task.responsibility === undefined) continue
      const parent = registry().get(SessionId(task.responsibility.agentId))
      if (parent === undefined) continue
      const last = Object.values(task.runs).at(-1)
      if (task.closure === undefined && last !== undefined && last.status !== 'running' && parentOf(task.taskId) === undefined)
        startJob(`close:${task.taskId}`, async () => {
          try {
            await idle([parent])
            const state = taskStateOf(apparatus, task.taskId), run = Object.values(state.runs).at(-1)!
            if (state.closure === undefined && run.status !== 'running') {
              await closeRoot(state, run, run.status === 'verified' ? 'accepted'
                : 'failed')
              schedule()
            }
          } catch (error) { if (!controller.signal.aborted) throw error }
        })
      if (task.rsi?.status === 'pending' || task.rsi?.status === 'running')
        startJob(`rsi:${task.taskId}`, async () => {
          try {
            if (taskStateOf(apparatus, task.taskId).rsi!.status === 'pending') {
              const sessions = [...taskSessionsOf(apparatus, task.taskId)]
                .map((id) => registry().get(SessionId(id)))
                .filter((agent): agent is Agent => agent !== undefined)
              await idle(sessions)
              const trace = await apparatus.attachments.saveFile({
                name: 'trajectory.json',
                data: await explorationOf(apparatus, task.taskId, task.closure!.runId),
              })
              await rsiStatus(task.taskId, {
                status: 'running',
                detail: 'starting independent method analysis from the sealed root trajectory',
                trace,
              })
            }
            const analysis = await startImprovement(
              apparatus,
              options.seams,
              parent,
              task.taskId,
              task.closure!.runId,
              controller.signal,
            )
            const last = Object.values(analysis.runs).at(-1)!
            await closeRoot(analysis, last, last.status === 'verified' ? 'accepted'
              : 'failed')
          } catch (error) {
            if (controller.signal.aborted) return
            const state = taskStateOf(apparatus, task.taskId).rsi!
            if (state.status !== 'pending' && state.status !== 'running') throw error
            await rsiStatus(task.taskId, { status: 'failed', detail: String(error) })
          }
        })
      for (const request of task.rounds ?? [])
        if (task.runs[request.runId]!.status === 'running')
          startJob(`round:${request.roundId}`, () =>
            request.status === 'pending' ? advanceRound(task, request, parent) : notifyRound(task, request, parent),
          )
    }
  }
  function schedule(): void {
    if (!scheduled && !controller.signal.aborted) {
      scheduled = true
      setTimeout(() => {
        scheduled = false
        advance()
      }, 0)
    }
  }
  try {
    await seedMethod(apparatus, options.initialMethod)
  } catch (error) {
    await execution.close()
    await apparatus.store.close()
    throw error
  }
  return {
    stop: () => { providerStopped = true; controller.abort(new Error('provider 不稳定')); scheduler.stop() },
    inheritRsi: input => work(() => linkRsiMemory(apparatus,
      (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as NonNullable<ChildSessionSeams['sessions']>, input)),
    prepareMemory: (agent) => work(async () => {
      const task = owner(String(agent.id))
      // Acceptance reviewers remain independent from the subject's working narrative.
      if (task === undefined || reviewOf(apparatus, String(agent.id)) !== undefined) return
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
          await prepareParentMemory({
            sessions: (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as NonNullable<ChildSessionSeams['sessions']>,
            sessionPersistence: apparatus.persistence, llm: options.seams.get?.('llm') as LlmRuntime,
          }, agent, {
            memoryId: 'memory-' + sha256(`rsi:${source.task.taskId}/${source.run.runId}/${task.taskId}/${Object.values(task.runs).at(-1)!.runId}`),
            context: { ...context, evidenceRefs: [...context.evidenceRefs, ...sourceContext.evidenceRefs],
              excludedTexts: [...context.excludedTexts, ...sourceContext.excludedTexts] },
            focus: 'Carry forward the previous RSI decisions and their reasons, tested and rejected mechanisms, no-winner or review rejection causes, round/method/measurement/publication references, successful habits and regression risks, and unresolved hypotheses. All RSI usage is excluded from every comparison.',
            maxTokens: 32768, signal: controller.signal,
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
      await prepareParentMemory({ sessions, sessionPersistence: apparatus.persistence, llm }, parentAgent, {
          memoryId: 'memory-' + sha256(`${parent.id}/${parent.runId}/${task.taskId}/${run.runId}`),
          context: await memoryContextOf(apparatus, String(agent.id)), focus: task.contract!.goal,
          maxTokens: 32768, signal: controller.signal,
          ...(inherited === undefined ? {} : { inherited }),
      })
    }),
    failed: (agentId) => {
      const review = reviewOf(apparatus, agentId)
      if (review !== undefined) return review.status === 'failed'
      const task = owner(agentId)
      const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      return run?.status === 'failed' && run.failureCause === 'runtime'
    },
    reviewTarget: agentId => reviewOf(apparatus, agentId)?.target,
    responsibility: (agentId) => {
      const task = owner(agentId), review = reviewOf(apparatus, agentId)
      return task === undefined && review === undefined ? undefined : coordinationOf(apparatus, review?.reviewId ?? task!.taskId)
    },
    enter: (agent, messages, model) =>
      work(async () => {
        const agentId = String(agent.id)
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
        const proposal = await propose(apparatus, { agentId, sessionId: agentId, model }, `human:${human.id}`, { goal })
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
          JSON.stringify({ assigned: proposal }),
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
            // A failed startup may leave an assigned RSI Run that never entered a turn.
            // Explicit root activation resumes that same Run and sealed trace.
            if (task.rsi?.status === 'failed' && task.rsi.trace !== undefined && [...tasks().values()].some(analysis =>
              analysis.closure === undefined && Object.values(analysis.runs).some(run => run.purpose === 'improve' &&
                run.relatedTo?.taskId === task.taskId && run.relatedTo.runId === task.closure!.runId && run.status === 'running')))
              await rsiStatus(task.taskId, { status: 'running', trace: task.rsi.trace, detail: 'resuming the same unfinished RSI Run from its sealed trajectory' })
          }
        schedule()
      }),
    forCall: (exec) => {
      const agent = execution.assertCaller(exec),
        caller = callerOf(agent),
        signal = AbortSignal.any([controller.signal, exec.signal])
      const task = owner(caller.agentId),
        review = reviewOf(apparatus, caller.agentId)
      const current = () =>
        review?.reviewId ?? task?.taskId ?? refuse('not-responsible', 'caller has no assigned responsibility')
      return {
        current,
        memory: (input) => work(() => readMemoryForAgent(apparatus, caller.agentId, input)),
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
          const result = await proposeRsiMethod(apparatus, options.seams, agent, caller.agentId, input, signal)
          schedule()
          return result
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
            assertActive(apparatus, current())
            if (review !== undefined) {
              if (!('path' in input)) refuse('not-responsible', 'reviewers submit their own review.json')
              const release = await execution.drain(exec)
              try { return await submitReview(apparatus, review, input.path) }
              finally { release() }
            }
            const task = owner(caller.agentId)!
            if (task.rounds?.some((r) => r.status === 'pending'))
              refuse('illegal-transition', 'wait for the committed evaluation outcome before submitting the RSI report')
            assertRsiReportReady(apparatus, task)
            try {
              return await submit(
                apparatus,
                execution,
                caller,
                exec,
                { ...input, taskId: task.taskId },
                signal,
                acceptanceFor(agent),
              )
            } finally {
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
        references: [...(review !== undefined || run?.purpose === 'improve' ? [apparatus.domain.dir] : []), ...apparatus.domain.references,
          ...(run === undefined ? [] : methodToolReferences(apparatus, run)),
        ],
      }
    },
    close: () =>
      (closing ??= (async () => {
      controller.abort(new Error('driver unloading'))
        const results = await Promise.allSettled([execution.close(), scheduler.close(), ...jobs.values(), ...active])
        await apparatus.store.close()
        const errors = [...backgroundErrors, ...results.flatMap((r) => (r.status === 'rejected' && !providerStopped ? [r.reason] : []))]
        if (errors.length) throw new AggregateError(errors, 'driver unload failed')
      })()),
  }
}
