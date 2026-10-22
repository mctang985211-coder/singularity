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
import { DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'
import type { RoundRequest, RSIStatus } from '../../src/task/lifecycle.ts'
import type { TaskView } from '../../src/task/view.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, reviewCriterion, type ReviewRun } from '../../src/review/protocol.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { callerOf, declareCaller, taskStateOf, openApparatus, type Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import type { BubbleWorld } from './bubble.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { repair } from './repair.ts'
import { createScheduler } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, retry } from './surfaces.ts'
import { submit, judgeAndRecord, type AcceptanceReview, type Submission, type SubmissionInput } from './submission.ts'
import { seedMethod, loadMethod, methodToolReferences, publishedMethod } from './method.ts'
import { mountMethodSkills, runMethodTool, methodContext, confirmWorkflowDelivery } from './method-run.ts'
import { taskSessionsOf, taskDispatchStart } from './evaluation-cost.ts'
import { acceptanceSubject, reviewSubject, reviewOf, submitReview, methodReviewTools, type ReviewWitness } from './review.ts'
import { explorationOf, startImprovement, improvementTools, improvementTaskId } from './improvement.ts'
import { proposeRsiMethod, advanceRsiBatch } from './rsi-proposal.ts'
import { rsiState, rsiToolReason } from './rsi-state.ts'
import { executionProfile } from './execution-profile.ts'
import { createEvolution, type EvolutionOptions } from './evolution.ts'
import { createNativeSolve, observeSolve } from './native-solve.ts'
import { releaseMethod } from './method-release.ts'
import { readForAgent, type ReadInput } from './read.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { sha256, taskIdOf } from './ids.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { pairedReport } from '../../src/measure/paired.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import { memoryContextOf, type MemoryContext } from './memory.ts'
import { parentMemoryRefOf, prepareParentMemory, readParentMemory, type ParentMemoryRef } from './parent-memory.ts'
import { parentMemorySessionsOf, readMemoryForAgent, type MemoryReadInput } from './memory-view.ts'
import { linkRsiMemory, rsiMemorySourceOf, type RsiMemoryInput } from './rsi-memory.ts'
import { answerChild, askParent, assertActive, coordinationOf, directionForRun, parentPlan, waitingReason, type AskParent, type AnswerChild } from './coordination.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { singularity: TaskService }
}
export interface TaskService {
  cancel(input: { readonly sessionId: string; readonly taskId?: string }): Promise<{ readonly status: 'cancelled'; readonly taskId: string }>
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
  proposeMethod(input: { readonly paths: readonly string[] }): Promise<unknown>
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
  readonly evaluationParallelism?: number
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends TaskService {
  rsiState(agentId: string): ReturnType<typeof rsiState>
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
  const parallelism = options.evaluationParallelism ?? 1
  if (!Number.isSafeInteger(parallelism) || parallelism < 1)
    refuse('malformed-declaration', 'evaluationParallelism must be a positive integer')
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence, options.attachments, options.projections,
  )
  const measurement = apparatus.domain.measurement
  const criterion = reviewCriterion((apparatus.domain.rootTemplate === undefined ? undefined : apparatus.domain.templates.get(apparatus.domain.rootTemplate))?.criteria[0] ?? { criterionId: 'task-accepted', statement: 'The Task meets its frozen contract' })
  const evaluation: Pick<EvolutionOptions, 'criterion' | 'metric' | 'trials' | 'weights' | 'calibration'> = {
    criterion,
    metric: { measured: measurement?.criterion ?? { ...criterion, criterionId: `${criterion.criterionId}:quality` },
      unit: measurement === undefined ? apparatus.domain.suite?.scoring === 'criteria' ? 'criteria fraction' : 'pass'
        : `${measurement.unit} / baseline`, direction: measurement?.direction ?? 'higher' },
    trials: 1,
    weights: measurement?.evaluation?.weights ?? (measurement === undefined ? { quality: 1, cost: 1 } : { quality: 100, cost: 15 }),
    calibration: { floor: measurement?.evaluation?.noiseFloor ?? (measurement === undefined ? 0 : 0.01), source: 'declared' },
  }
  const controller = new AbortController(),
    active = new Set<Promise<unknown>>(),
    jobs = new Map<string, Promise<void>>(),
    rsiControllers = new Map<string, AbortController>()
  const backgroundErrors: unknown[] = []
  let closing: Promise<void> | undefined,
    scheduled = false
  const tasks = () => apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const registry = () =>
    (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry
  const owner = (agentId: string) => [...tasks().values()].findLast((t) => t.responsibility?.agentId === agentId)
  const parentOf = (id: string) =>
    [...tasks().values()].find((t) => t.decomposition?.children.some((c) => c.taskId === id))?.taskId ??
    [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find((r) =>
      r.children.some((c) => c.taskId === id),
    )?.reviewId
  const rsiRootOf = (taskId: string): TaskState | undefined => {
    const states = tasks(), seen = new Set<string>()
    let id: string | undefined = taskId
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const task = states.get(id)
      if (task === undefined) {
        const review: ReviewRun | undefined = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, id)
        if (review === undefined) return undefined
        if (review.target.kind === 'acceptance') { id = review.target.taskId; continue }
        const reviewId = (operation: string) => `review-${sha256(`${apparatus.controlId}/${operation}`).slice(0, 24)}`
        const target: Exclude<ReviewRun['target'], { kind: 'acceptance' }> = review.target
        id = [...states.values()].find((t): boolean => Object.values(t.runs).some(run => run.purpose === 'improve') &&
          (target.kind === 'proposal' ? review.reviewId === reviewId(`proposal:${t.taskId}:${target.assetsDigest}`)
            : review.reviewId === reviewId(`transfer:${t.taskId}:release:review`) ||
              t.rounds?.some(round => review.reviewId === reviewId(`round:${round.roundId}:release:review`)) === true))?.taskId
        continue
      }
      const run = Object.values(task.runs).at(-1)
      if (run?.purpose === 'improve' && run.relatedTo !== undefined) return states.get(run.relatedTo.taskId)
      id = run?.relatedTo?.taskId ?? parentOf(task.taskId)
    }
    return undefined
  }
  const rsiStop = (rootId: string): { cause: 'cancelled' | 'runtime'; reason: string } | undefined => {
    const root = taskStateOf(apparatus, rootId)
    if (root.rsi?.status === 'cancelled') return { cause: 'cancelled', reason: 'RSI cancelled by user' }
    if (root.rsi?.status === 'failed') {
      const analysis = tasks().get(improvementTaskId(rootId, root.closure!.runId))
      if (analysis !== undefined && Object.values(analysis.runs).at(-1)?.status === 'failed')
        return { cause: 'runtime', reason: `RSI analysis Run failed: ${root.rsi.detail}` }
    }
    return undefined
  }
  const rsiSignal = (rootId: string): AbortSignal => {
    let held = rsiControllers.get(rootId)
    if (held === undefined) {
      held = new AbortController()
      rsiControllers.set(rootId, held)
      const stopped = rsiStop(rootId)
      if (stopped !== undefined) held.abort(new Error(stopped.reason))
    }
    return AbortSignal.any([controller.signal, held.signal])
  }
  const taskSignal = (taskId: string): AbortSignal => {
    const root = rsiRootOf(taskId)
    return root === undefined ? controller.signal : rsiSignal(root.taskId)
  }
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
        taskSignal(taskId),
        run.revision,
        false,
      )
  const restoreJudgement = async (taskId: string, run: RunState): Promise<boolean> => {
    const parent = registry().get(SessionId(taskStateOf(apparatus, taskId).responsibility!.agentId))
    if (parent === undefined) return false
    await judgeAndRecord(apparatus, taskId, run, taskSignal(taskId), acceptanceFor(parent))
    return true
  }
  const closeRoot = async (
    task: TaskState,
    run: RunState,
    reason: 'accepted' | 'failed' | 'cancelled',
  ): Promise<void> => {
    if (parentOf(task.taskId) !== undefined) return
    if (run.failureCause === 'cancelled') reason = 'cancelled'
    if (task.closure === undefined)
      await taskFact(
        `close:${task.taskId}`,
        'task/closed',
        task.taskId,
        { runId: run.runId, reason },
        `agent:${task.responsibility!.agentId}`,
      )
    if (run.purpose === 'improve' && run.relatedTo !== undefined) {
      const root = taskStateOf(apparatus, run.relatedTo.taskId)
      if (root.rsi?.status === 'running') {
        await rsiStatus(root.taskId, {
          status: run.status === 'verified' ? 'completed' : 'failed',
          detail:
            run.status === 'verified'
              ? 'independently reviewed RSI report submitted'
              : (run.failureReason ?? 'RSI report failed acceptance'),
        })
        const stopped = rsiStop(root.taskId)
        if (stopped !== undefined) {
          rsiControllers.get(root.taskId)?.abort(new Error(stopped.reason))
          await stopRsiWork(root.taskId)
        }
      }
    }
  }
  const stopRsiWork = async (rootId: string): Promise<void> => {
    const stopped = rsiStop(rootId)
    if (controller.signal.aborted || stopped === undefined) return
    const { reason, cause } = stopped
    const affected = [...tasks().values()].filter(task => rsiRootOf(task.taskId)?.taskId === rootId)
    for (const task of affected) {
      if (controller.signal.aborted) return
      const run = Object.values(task.runs).at(-1)
      if (run !== undefined) {
        declareCaller(apparatus, task.responsibility!.agentId)
        const as = `agent:${task.responsibility!.agentId}`
        if (run.purpose === 'improve' && run.status === 'running' && run.stage === 'working') {
          for (const batch of task.search?.batches ?? []) {
            if (batch.settled) continue
            for (const [slot] of batch.slots.entries())
              if (!batch.outcomes.some(outcome => outcome.slot === slot))
                await taskFact(`cancel:${task.taskId}:${batch.batchId}:${slot}`, 'rsi/batch-slot-settled', task.taskId,
                  { batchId: batch.batchId, slot, status: 'cancelled', detail: reason }, as)
            await taskFact(`cancel:${task.taskId}:${batch.batchId}`, 'rsi/batch-ended', task.taskId, { batchId: batch.batchId }, as)
          }
        }
        for (const round of task.rounds ?? [])
          if (round.status === 'pending')
            await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, { roundId: round.roundId, status: 'failed', error: reason })
        if (task.transfer?.consumed && task.transfer.outcome === undefined) {
          const report = await apparatus.attachments.saveFile({ name: 'transfer-report.json', data: Buffer.from(JSON.stringify({ status: 'insufficient-evidence', reason })) })
          await taskFact(`transfer:${task.taskId}:settled`, 'rsi/transfer-settled', task.taskId, { outcome: 'insufficient-evidence', report }, as)
        }
        if (run.status === 'running')
          await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({ commandId: `cancel:${task.taskId}:${run.runId}`,
            taskId: task.taskId, runId: run.runId, cause, reason })
      }
      registry().get(SessionId(task.responsibility!.agentId))?.cancel({ kind: cause === 'cancelled' ? 'user' : 'parent' })
    }
    for (const review of apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()) {
      if (controller.signal.aborted) return
      if (review.status !== 'running' || rsiRootOf(review.reviewId)?.taskId !== rootId) continue
      await createReviewCommands(apparatus.store).fail(`cancel:${review.reviewId}`, review.reviewId, reason)
      registry().get(SessionId(review.sessionId))?.cancel({ kind: cause === 'cancelled' ? 'user' : 'parent' })
      await scheduler.advance(review.reviewId)
    }
    for (const task of affected) {
      if (controller.signal.aborted) return
      await scheduler.advance(task.taskId)
      const current = taskStateOf(apparatus, task.taskId), last = Object.values(current.runs).at(-1)
      if (last !== undefined && last.status !== 'running') await closeRoot(current, last, last.status === 'verified' ? 'accepted' : 'failed')
    }
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
  const idle = async (agents: readonly Agent[], signal = controller.signal): Promise<void> => {
    await Promise.race([
      Promise.all(agents.map((agent) => agent.whenIdle())),
      aborted(signal, agents),
    ])
    signal.throwIfAborted()
    const sessions = (options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')) as ChildSessionSeams['sessions']
    for (const agent of agents)
      if (!(await sessions!.flush(agent.session)))
        refuse('write-not-durable', `session ${agent.id} has no durability listener`)
  }
  const advanceRound = async (task: TaskState, request: RoundRequest, parent: Agent, signal: AbortSignal): Promise<void> => {
    const { runId: _runId, status: _status, error: _error, ...round } = request
    try {
      signal.throwIfAborted()
      const native = createNativeSolve(apparatus, options.seams, parent, signal, measurement === undefined ? undefined
        : { digest: measurement.criterion.implementationDigest, measure: (source, signal, context) => measurement.measure(source, signal, context) })
      const suite = apparatus.domain.suite
      const profile = suite === undefined ? undefined : await executionProfile(parent, options.seams, apparatus.domain, parallelism)
      const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation, parallelism,
        productionHead: publishedMethod(apparatus)!.revisionId,
        ...(suite === undefined ? {} : { suite, executionProfileDigest: profile!.digest }),
        loadMethod: async (revision) => (await loadMethod(apparatus, revision)).assets,
        baseline: suite === undefined ? async (trialRequest) => {
          const { revision, started } = trialRequest
          const ownerRun = task.runs[request.runId]!
          const source = ownerRun.relatedTo!
          const incumbent = taskStateOf(apparatus, source.taskId).runs[source.runId]!
          if (incumbent.revision.digest !== revision.digest || evaluation.trials !== 1) {
            const measured = [...apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values()].findLast(e =>
              e.candidate?.digest === revision.digest && e.trials === 1 && e.observed.length === 1 &&
              digestOf(e.metric) === digestOf(evaluation.metric) && e.observed[0]!.detail !== undefined)
            if (measured !== undefined) {
              const observation = JSON.parse(measured.observed[0]!.detail!) as import('./evolution.ts').SolveResult
              if (digestOf(taskStateOf(apparatus, observation.taskId).contract) === digestOf(taskStateOf(apparatus, source.taskId).contract)) {
                await started({ taskId: observation.taskId, runId: observation.runId })
                return observation
              }
            }
            return native(trialRequest)
          }
          await started(source)
          return observeSolve(apparatus, source.taskId, source.runId, signal,
            measurement === undefined ? undefined : { digest: measurement.criterion.implementationDigest,
              measure: (source, signal, context) => measurement.measure(source, signal, context) })
        } : native,
        solve: native,
      })
      const decision = await evolution.runRound({ ...round, campaignId: task.taskId })
      signal.throwIfAborted()
      const currentRun = taskStateOf(apparatus, task.taskId).runs[request.runId]!
      if (currentRun.status !== 'running' || currentRun.stage !== 'working')
        refuse('illegal-transition', 'evaluation requires its working RSI Run')
      if (decision.winner !== null && suite === undefined)
        await releaseMethod(
          apparatus,
          options.seams,
          parent,
          `round:${round.roundId}:release`,
          { roundId: round.roundId },
          signal,
        )
      signal.throwIfAborted()
      await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, {
        roundId: round.roundId,
        status: 'completed',
      })
    } catch (error) {
      if (signal.aborted) return
      await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, {
        roundId: round.roundId,
        status: 'failed',
        error: String(error),
      })
    }
    if (!signal.aborted && taskStateOf(apparatus, task.taskId).runs[request.runId]!.status === 'running')
      await notifyRound(task, request, parent)
  }
  const validateChampion = async (task: TaskState, parent: Agent, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    assertActive(apparatus, task.taskId)
    const suite = apparatus.domain.suite
    if (suite === undefined || Object.values(task.runs).at(-1)?.purpose !== 'improve') return
    const rounds = [...apparatus.store.load().statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()]
      .filter(r => r.plan?.campaignId === task.taskId && r.decision !== undefined).sort((a, b) => a.plan!.round - b.plan!.round)
    const baseline = rounds[0]?.plan?.incumbent, last = rounds.at(-1)
    const champion = last?.submissions.find(s => s.slot === last.decision!.winner)?.revision ?? last?.plan?.incumbent
    if (baseline === undefined || champion === undefined || champion.digest === baseline.digest) return
    const identity = await executionProfile(parent, options.seams, apparatus.domain, parallelism)
    const profile = identity.digest
    const roundId = `${task.taskId}:validation`, suiteDigest = digestOf(suite)
    const fact = (suffix: string, kind: string, payload: unknown) => {
      signal.throwIfAborted()
      return taskFact(`transfer:${task.taskId}:${suffix}`, kind, task.taskId, payload, `agent:${task.responsibility!.agentId}`)
    }
    if (taskStateOf(apparatus, task.taskId).transfer === undefined)
      await fact('freeze', 'rsi/transfer-frozen', { baseline, champion, suiteDigest, executionProfileDigest: profile, roundId })
    const frozen = taskStateOf(apparatus, task.taskId).transfer!
    if (frozen.executionProfileDigest !== profile || frozen.suiteDigest !== suiteDigest) refuse('caliber-mismatch', 'validation execution profile changed after champion freeze')
    if (frozen.outcome === undefined) {
      let report: unknown, outcome: 'improved' | 'no-improvement' | 'insufficient-evidence' = 'insufficient-evidence'
      try {
        if (!frozen.consumed) await fact('consume', 'rsi/transfer-started', { suiteDigest })
        const privateCases = suite.cases.filter(c => c.split !== 'evolve')
        const priorEvaluations = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
        if ([...tasks().values()].some(t => t.taskId !== task.taskId && t.transfer?.consumed &&
          (t.transfer.suiteDigest === suiteDigest || [...priorEvaluations.values()].some(e =>
            ((e.matrix?.split === 'validation' && e.evaluationId.startsWith(`${t.transfer!.roundId}:`)) ||
              (e.matrix?.split === 'heldout' && e.evaluationId.startsWith(`${t.taskId}:heldout:`))) &&
            e.matrix.slots.some(slot => privateCases.some(c => c.familyId === slot.familyId || digestOf(c.contract) === slot.contractDigest))))))
          refuse('illegal-transition', 'this validation tranche was consumed by another campaign; use a new suite')
        if (!identity.complete) refuse('caliber-mismatch', `execution profile evidence missing: ${identity.missing.join(', ')}`)
        const native = createNativeSolve(apparatus, options.seams, parent, signal, measurement === undefined ? undefined
          : { digest: measurement.criterion.implementationDigest, measure: (source, signal, context) => measurement.measure(source, signal, context) })
        const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation, parallelism,
          productionHead: rounds[0]!.plan!.productionHead!,
          suite, split: 'validation', executionProfileDigest: profile, loadMethod: async revision => (await loadMethod(apparatus, revision)).assets,
          baseline: native, solve: native })
        const decision = await evolution.runRound({ campaignId: roundId, roundId, round: 1, incumbent: baseline, candidates: [champion] })
        signal.throwIfAborted()
        const states = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
        const pair = pairedReport(states.get(`${roundId}:bootstrap:evaluation`)!, states.get(`${roundId}:0:candidate:evaluation`)!)
        outcome = !identity.complete ? 'insufficient-evidence' : pair.status === 'improved' && decision.winner === 0 ? 'improved' : pair.status === 'insufficient-evidence' ? 'insufficient-evidence' : 'no-improvement'
        let heldout: unknown = null
        if (suite.cases.some(c => c.split === 'heldout')) {
          const finalId = `${task.taskId}:heldout`
          try {
            const final = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation, parallelism,
              productionHead: rounds[0]!.plan!.productionHead!, suite, split: 'heldout', executionProfileDigest: profile,
              loadMethod: async revision => (await loadMethod(apparatus, revision)).assets, baseline: native, solve: native })
            await final.runRound({ campaignId: finalId, roundId: finalId, round: 1, incumbent: baseline, candidates: [champion] })
            const measured = apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
            heldout = pairedReport(measured.get(`${finalId}:bootstrap:evaluation`)!, measured.get(`${finalId}:0:candidate:evaluation`)!)
          } catch (error) {
            signal.throwIfAborted()
            if (!(error instanceof ProtocolRefusal) || error.refusal.code === 'write-not-durable') throw error
            heldout = { status: 'insufficient-evidence', reason: String(error) }
          }
        }
        report = { baseline, champion, suiteDigest, executionProfileDigest: profile, execution: identity, selection: decision, paired: pair, heldout,
          measuredAt: new Date().toISOString(),
          modelRevision: 'not independently attested', claim: 'paired validation under the recorded model route; no broad domain or novelty claim' }
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof ProtocolRefusal) || error.refusal.code === 'write-not-durable') throw error
        outcome = 'insufficient-evidence'
        report = { baseline, champion, suiteDigest, status: 'insufficient-evidence', reason: String(error) }
      }
      const attachment = await apparatus.attachments.saveFile({ name: 'transfer-report.json', data: Buffer.from(JSON.stringify(report)) })
      await fact('settled', 'rsi/transfer-settled', { outcome, report: attachment })
    }
    if (taskStateOf(apparatus, task.taskId).transfer!.outcome === 'improved')
      await releaseMethod(apparatus, options.seams, parent, `transfer:${task.taskId}:release`, { roundId }, signal)
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
      if (task.rsi !== undefined && rsiStop(task.taskId) !== undefined)
        startJob(`stop-rsi:${task.taskId}`, () => stopRsiWork(task.taskId))
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
      if ((task.closure !== undefined && last?.purpose === 'solve' && last.failureCause !== 'cancelled' &&
        task.learning !== false && task.rsi === undefined && parentOf(task.taskId) === undefined) ||
        task.rsi?.status === 'pending' || task.rsi?.status === 'running')
        startJob(`rsi:${task.taskId}`, async () => {
          const signal = rsiSignal(task.taskId)
          try {
            signal.throwIfAborted()
            if (taskStateOf(apparatus, task.taskId).rsi === undefined)
              await rsiStatus(task.taskId, { status: 'pending', detail: 'business root closed; trajectory is available for asynchronous RSI' })
            if (taskStateOf(apparatus, task.taskId).rsi!.status === 'pending') {
              const sessions = [...taskSessionsOf(apparatus, task.taskId)]
                .map((id) => registry().get(SessionId(id)))
                .filter((agent): agent is Agent => agent !== undefined)
              await idle(sessions, signal)
              const trace = await apparatus.attachments.saveFile({
                name: 'trajectory.json',
                data: await explorationOf(apparatus, task.taskId, task.closure!.runId),
              })
              signal.throwIfAborted()
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
              signal,
            )
            signal.throwIfAborted()
            const last = Object.values(analysis.runs).at(-1)!
            await closeRoot(analysis, last, last.status === 'verified' ? 'accepted'
              : 'failed')
          } catch (error) {
            if (signal.aborted) return
            const state = taskStateOf(apparatus, task.taskId).rsi
            if (state?.status !== 'pending' && state?.status !== 'running') throw error
            await rsiStatus(task.taskId, { status: 'failed', detail: String(error) })
          } finally { await stopRsiWork(task.taskId) }
        })
      if (last?.purpose === 'improve' && last.status === 'running' && last.stage === 'working') {
        for (const batch of task.search?.batches ?? []) {
          if (!batch.settled) startJob(`batch:${task.taskId}:${batch.batchId}`, async () => {
            const signal = taskSignal(task.taskId)
            try { await advanceRsiBatch(apparatus, options.seams, parent, task.taskId, signal) }
            catch (error) { if (signal.aborted) return; throw error }
            schedule()
          })
          else if (!batch.outcomes.some(outcome => outcome.status === 'evaluation-requested'))
            startJob(`batch-notify:${task.taskId}:${batch.batchId}`, async () => {
              const fact = apparatus.store.committedOf(`rsi/batch-ended:${task.taskId}:${batch.batchId}`)!
              await postIdentifiedMessage(options.seams, parent, schedulerMessage({
                kind: 'singularity', purpose: 'plan-outcome', controlId: apparatus.controlId,
                parentTaskId: task.taskId, taskId: task.taskId, runId: last.runId, factSeq: fact.seq,
              }, JSON.stringify({ batchId: batch.batchId, status: 'screened',
                outcomes: batch.outcomes.map(({ slot, status, revision }) => ({ slot, status, revision })),
                next: 'Read singularity_read({kind:"search"}) for the current state and feedback.' })))
            })
        }
      }
      for (const request of task.rounds ?? [])
        if (task.runs[request.runId]!.status === 'running')
          startJob(`round:${request.roundId}`, async () => {
            if (task.search?.batches?.some(batch => !batch.settled)) return
            const signal = taskSignal(task.taskId)
            try {
              if (!signal.aborted)
                await (request.status === 'pending' ? advanceRound(task, request, parent, signal) : notifyRound(task, request, parent))
            } finally {
              const root = rsiRootOf(task.taskId)
              if (root !== undefined) await stopRsiWork(root.taskId)
            }
          })
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
        rsiControllers.get(task.taskId)?.abort(new Error('RSI cancelled by user'))
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
      return task === undefined && review === undefined ? undefined : coordinationOf(apparatus, review?.reviewId ?? task!.taskId)
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
            let steps = 0
            const rootSession = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, root.responsibility!.agentId)!.sessionId
            for (const id of taskSessionsOf(apparatus, root.taskId)) {
              const events = await nativeEvents(id)
              const from = id === rootSession ? taskDispatchStart(events, apparatus.controlId, root.taskId) ?? events.length : 0
              steps += events.slice(from).filter(e => e.type === 'step/start').length
            }
            if (steps >= limit) {
              const run = Object.values(root.runs).at(-1)!
              if (run.status === 'running') {
                declareCaller(apparatus, root.responsibility!.agentId)
                await apparatus.tasks.forAgent(root.responsibility!.agentId).failRun({ commandId: `step-limit:${root.taskId}:${run.runId}`,
                  taskId: root.taskId, runId: run.runId, cause: 'business', reason: `workflow step limit ${limit} exhausted` })
                await scheduler.advance(root.taskId)
                await closeRoot(taskStateOf(apparatus, root.taskId), taskStateOf(apparatus, root.taskId).runs[run.runId]!, 'failed')
                registry().get(SessionId(rootSession))?.cancel({ kind: 'parent' }, { keepInbox: true })
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
    close: () =>
      (closing ??= (async () => {
      controller.abort(new Error('driver unloading'))
        scheduler.stop()
        const results = await Promise.allSettled([execution.close(), scheduler.close(), ...jobs.values(), ...active])
        await apparatus.store.close()
        const cancellations = new Set([controller.signal.reason, ...[...rsiControllers.values()].filter(c => c.signal.aborted).map(c => c.signal.reason)])
        const errors = [...backgroundErrors, ...results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))]
          .filter(error => !cancellations.has(error))
        if (errors.length) throw new AggregateError(errors, 'driver unload failed')
      })()),
  }
}
