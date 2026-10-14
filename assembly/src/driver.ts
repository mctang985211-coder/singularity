import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aborted } from 'node:util'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
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
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { callerOf, declareCaller, taskStateOf, openApparatus, type Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import type { BubbleWorld } from './bubble.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { repair } from './repair.ts'
import { createScheduler } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, retry } from './surfaces.ts'
import { submit, judgeAndRecord, type AcceptanceReview, type Submission } from './submission.ts'
import { createMethod, seedMethod, loadMethod, methodToolReferences, METHOD_FORMAT } from './method.ts'
import { methodSkill, mountMethodSkills, recordMethodContext, runMethodTool, type MethodContext } from './method-run.ts'
import { proposalCostOf, taskSessionsOf } from './evaluation-cost.ts'
import { acceptanceSubject, reviewSubject, reviewOf, submitReview, type ReviewWitness } from './review.ts'
import { assertImprovementOwner, explorationOf, startImprovement } from './improvement.ts'
import { createEvolution, readEvolutionRound, type EvolutionRound, type EvolutionOptions } from './evolution.ts'
import { createNativeSolve } from './native-solve.ts'
import { releaseMethod } from './method-release.ts'
import { readArtifact, readTask, readTrajectory } from './read.ts'
import { createCampaignBudget, type CampaignBudget, type CampaignLimits } from './budget.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { sha256, taskIdOf } from './ids.ts'
import { inside } from './shape.ts'
import { assertRunFile } from './workspace.ts'
import { sealedBytes } from './sealed.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { answerChild, askParent, assertActive, coordinationOf, parentPlan, waitingReason, readScopeOf, type AskParent, type AnswerChild } from './coordination.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { singularity: TaskService }
}
export interface TaskService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  skill(agentId: string): Promise<string | undefined>
  recordContext(agentId: string): Promise<void>
  mountSkills(agent: Agent): Promise<void>
  world(agentId: string): BubbleWorld
  purpose(agentId: string): string
}
export interface AgentTaskSurface {
  askParent(input: AskParent): Promise<unknown>
  answer(input: AnswerChild): Promise<unknown>
  retry(input: { readonly taskId: string }): Promise<Proposal>
  createMethod(input: { readonly path: string }): Promise<RevisionRef>
  runMethod(input: { readonly taskId: string
    readonly tool: string
    readonly candidatePath?: string }): Promise<{ artifact: string }>
  evolve(input: EvolutionRound): Promise<{ roundId: string; status: string }>
  history(input?: {
    readonly kind?: 'summary' | 'task' | 'artifact' | 'template' | 'method' | 'round' | 'trajectory'
    readonly ref?: string
    readonly runId?: string
    readonly from?: number
    readonly count?: number
  }): Promise<unknown>
  decompose(input: DecomposeInput): Promise<PlanRecord>
  submit(input: { readonly taskId: string; readonly path: string }): Promise<Submission | ReviewWitness>
  current(): string
}
export interface PlannedChild {
  readonly key: string
  readonly template?: string
  readonly contract?: TaskContract
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly handoff?: import('../../src/task/decomposition.ts').DecompositionChild['handoff']
}
export type DecomposeInput =
  | { readonly taskId: string; readonly children: readonly PlannedChild[]; readonly useTemplateDecomposition?: never }
  | { readonly taskId: string; readonly useTemplateDecomposition: true; readonly children?: never }
export interface PlanRecord { readonly taskId: string
  readonly opened: readonly string[] }
export interface Proposal {
  readonly taskId: string
  readonly runId: string
  readonly workspace: string
  readonly contract: TaskContract
  readonly phase: TaskView['phase']
  readonly artifact: string
  readonly templates: readonly { readonly id: string; readonly goal: string; readonly applicability?: string }[]
  readonly methodContext: MethodContext
}
export interface DriverOptions {
  readonly budget?: CampaignLimits
  readonly attachments: Apparatus['attachments']
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends TaskService {
  readonly budget?: CampaignBudget
  enter(agent: Agent, messages: readonly UserMessage[], model: { provider: string; model: string },
  ): Promise<UserMessage | undefined>
  activate(sessionId: string): Promise<void>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence, options.attachments,
  )
  if (options.budget !== undefined) {
    apparatus.budget = createCampaignBudget(apparatus, options.budget)
    await apparatus.budget.restore()
  }
  const measurement = apparatus.domain.measurement
  const criterion = reviewCriterion(apparatus.domain.templates.get(apparatus.domain.rootTemplate)!.criterion)
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
  const tasks = () => apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const registry = () =>
    (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry
  const owner = (agentId: string) => [...tasks().values()].findLast((t) => t.responsibility?.agentId === agentId)
  const parentOf = (id: string) =>
    [...tasks().values()].find((t) => t.decomposition?.children.some((c) => c.taskId === id))?.taskId ??
    [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find((r) =>
      r.children.some((c) => c.taskId === id),
    )?.reviewId
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
  const rsiStatus = (taskId: string, value: RSIStatus) =>
    taskFact(`rsi:${taskId}:${value.status}`, 'rsi/status', taskId, value)
  const work = <T>(step: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) refuse('illegal-transition', 'driver is closing')
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
    reason: 'accepted' | 'failed' | 'budget-exhausted',
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
    if (exec.agent === undefined || exec.name.startsWith('singularity_')) return undefined
    const review = reviewOf(apparatus, String(exec.agent.id))
    if (review !== undefined) return review.status === 'running' ? waitingReason(apparatus, review.reviewId) : 'review Run has settled'
    const task = owner(String(exec.agent.id))
        const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
    return run !== undefined && (run.status !== 'running' || run.stage !== 'working')
      ? 'Run has closed write admission'
      : task === undefined ? undefined : waitingReason(apparatus, task.taskId)
  }
  const execution = options.execution(admission, (failure) =>
    work(async () => {
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
        apparatus.budget !== undefined &&
          (apparatus.budget.report().tokens === null ||
            apparatus.budget.report().tokens! >= apparatus.budget.limits.nativeTokens)
          ? 'budget-exhausted'
          : 'failed',
      )
      const parent = parentOf(task.taskId)
      if (parent !== undefined) await scheduler.advance(parent)
      schedule()
    }).catch((error) => {
      backgroundErrors.push(error)
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
        backgroundErrors.push(error)
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
    const { runId: _runId, status: _status, proposal, error: _error, ...round } = request
    try {
      const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry, ...evaluation,
        loadMethod: async (revision) => (await loadMethod(apparatus, revision)).assets,
        solve: createNativeSolve(
          apparatus,
          options.seams,
          parent,
          controller.signal, measurement === undefined ? undefined
          : { digest: measurement.criterion.implementationDigest, measure: (source, signal) => measurement.measure(source, signal),
              },
          proposal,
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
      const parent = registry().get(SessionId(task.responsibility!.agentId))
      if (parent === undefined) continue
      const last = Object.values(task.runs).at(-1)
      if (task.closure === undefined && last !== undefined && last.status !== 'running' && parentOf(task.taskId) === undefined)
        startJob(`close:${task.taskId}`, async () => {
          try {
            await idle([parent])
            const state = taskStateOf(apparatus, task.taskId), run = Object.values(state.runs).at(-1)!
            if (state.closure === undefined && run.status !== 'running') {
              await closeRoot(state, run, run.status === 'verified' ? 'accepted' : 'failed')
              schedule()
            }
          } catch (error) { if (!controller.signal.aborted) throw error }
        })
      if (task.rsi?.status === 'pending' || task.rsi?.status === 'running')
        startJob(`rsi:${task.taskId}`, async () => {
          try {
            apparatus.budget?.beforeRequest()
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
            await closeRoot(analysis, last, last.status === 'verified' ? 'accepted' : 'failed')
          } catch (error) {
            if (controller.signal.aborted) return
            const state = taskStateOf(apparatus, task.taskId).rsi!
            if (state.status !== 'pending' && state.status !== 'running') throw error
            await rsiStatus(task.taskId, {
              status:
                state.status === 'pending' &&
                error instanceof ProtocolRefusal &&
                error.refusal.code === 'budget-exhausted'
                  ? 'skipped'
                  : 'failed',
              detail: String(error),
            })
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
    await seedMethod(apparatus)
  } catch (error) {
    await execution.close()
    await apparatus.store.close()
    throw error
  }
  return {
    ...(apparatus.budget === undefined ? {} : { budget: apparatus.budget }),
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
        createMethod: (input) =>
          work(async () => {
            assertImprovementOwner(apparatus, caller.agentId)
            assertActive(apparatus, current())
            const run = Object.values(owner(caller.agentId)!.runs).at(-1)!,
              workspace = run.bubble!.workspace.ref
            await assertRunFile(workspace, input.path)
            return createMethod(
              apparatus,
              JSON.parse(await readFile(inside(workspace, input.path, 'candidate path'), 'utf8')),
            )
          }),
        runMethod: (input) =>
          work(async () => {
            assertActive(apparatus, current())
            return runMethodTool(apparatus, caller, input.taskId, String(exec.callId), signal, input.tool, input.candidatePath)
          }),
        evolve: (input) =>
          work(async () => {
            assertImprovementOwner(apparatus, caller.agentId)
            const round = readEvolutionRound(input),
              task = owner(caller.agentId)!,
              run = Object.values(task.runs).at(-1)!
            for (const revision of [round.incumbent, ...round.candidates]) await loadMethod(apparatus, revision)
            const previous = task.rounds?.find((r) => r.roundId === round.roundId)
            if (previous === undefined) {
              assertActive(apparatus, current())
              const proposal = await proposalCostOf(
                apparatus,
                caller.sessionId,
                round.candidates.map((r) => r.digest),
              )
              await taskFact(
                `round-request:${round.roundId}`,
                'rsi/round-requested',
                task.taskId,
                { ...round, runId: run.runId, proposal },
                `agent:${caller.agentId}`,
              )
            } else if (
              JSON.stringify({
                roundId: previous.roundId,
                round: previous.round,
                incumbent: previous.incumbent,
                candidates: previous.candidates,
              }) !== JSON.stringify(round)
            )
              refuse('command-conflict', 'round request changed')
            schedule()
            return { roundId: round.roundId, status: previous?.status ?? 'pending' }
          }),
        history: (input) =>
          work(async () => {
            if (input?.kind === 'trajectory')
              return readTrajectory(apparatus, caller.agentId, input.ref!, input.from, input.count)
            const { visible, audit } = await readScopeOf(apparatus, caller.agentId)
            if (input?.kind === 'task' || input?.kind === 'artifact') {
              if (!visible!.has(input.ref!)) refuse('not-responsible', 'Task is outside this evidence scope')
              if (input.kind === 'artifact') return readArtifact(apparatus, input.ref!, input.runId, input.from, input.count)
              return readTask(apparatus, taskStateOf(apparatus, input.ref!))
            }
            let reference = review?.method ?? Object.values(task!.runs).at(-1)!.revision
            if (input?.kind === 'method' && input.ref !== undefined &&
              input.ref !== reference.revisionId && input.ref !== reference.digest) {
              const allowed = [...tasks().values()].filter((t) => visible!.has(t.taskId)).flatMap((t) => [
                ...Object.values(t.runs).map((r) => r.revision),
                ...(t.rounds ?? []).flatMap((r) => [r.incumbent, ...r.candidates]),
              ])
              if (review?.target.kind === 'publication') allowed.push({
                environmentId: review.target.environmentId, revisionId: review.target.revisionId,
                digest: review.target.assetsDigest,
              })
              reference = allowed.find((ref) => input.ref === ref.revisionId || input.ref === ref.digest) ??
                refuse('unknown-revision', 'method is outside this frozen evidence scope')
            }
            const method = await loadMethod(apparatus, reference)
            if (input?.kind === 'template') {
              if (input.ref === undefined) {
                const from = input.from ?? 0, count = input.count ?? 20
                if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
                  refuse('malformed-declaration', 'template range must use a nonnegative offset and 1 to 100 entries per page')
                return [...method.domain.templates.values()].slice(from, from + count)
                  .map((template) => ({ id: template.id, goal: template.goal, applicability: template.applicability }))
              }
              const selected = method.assets.templates.find((t) => (t as { id: string }).id === input.ref)
              if (selected === undefined) refuse('malformed-declaration', 'unknown template')
              return selected
            }
            if (input?.kind === 'method') {
              if (review === undefined) assertImprovementOwner(apparatus, caller.agentId)
              return { reference, assets: method.assets, format: METHOD_FORMAT, evaluation,
                costAccounting: 'Native tokens: baseline solve and acceptance; candidate share of proposal plus solve and acceptance, then publication review. Publication requires total candidate cost at most 125% of baseline. No quality gain funds no cost increase.',
                budget: apparatus.budget === undefined ? null : { limit: apparatus.budget.limits.nativeTokens, ...apparatus.budget.report() },
              }
            }
            if (input?.kind === 'round') {
              if (!audit) refuse('not-responsible', 'evaluation results belong to RSI and independent review')
              const held = [...tasks().values()].filter((t) => visible!.has(t.taskId))
                .flatMap((t) => t.rounds ?? []).find((r) => r.roundId === input.ref)
              const publication = review?.target.kind === 'publication'
                ? JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8'))
                : undefined
              if (held === undefined && publication?.draft.basis.roundId !== input.ref)
                refuse('not-responsible', 'round is outside this frozen evidence scope')
              return {
                request: held,
                snapshot: (await snapshotOf(apparatus)).rounds.find((r) => r.roundId === input.ref),
                evaluations: [...apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values()]
                  .filter((e) => e.evaluationId === `${input.ref}:bootstrap:evaluation` ||
                    (e.evaluationId.startsWith(`${input.ref}:`) && /^\d+:candidate:evaluation$/.test(e.evaluationId.slice(input.ref!.length + 1)))),
              }
            }
            return {
              coordination: coordinationOf(apparatus, current()),
              tasks: [...tasks().values()]
                .filter((t) => visible!.has(t.taskId))
                .map((t) => ({
                  taskId: t.taskId,
                  goal: t.contract!.goal,
                  parentId: parentPlan(apparatus, t.taskId)?.id ?? null,
                  sessionId: apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, t.responsibility!.agentId)!.sessionId,
                  decomposition: t.decomposition,
                  runs: Object.values(t.runs).map((r) => ({
                    runId: r.runId,
                    status: r.status,
                    failureCause: r.failureCause,
                    failureReason: r.failureReason,
                    verdicts: r.evidence.map((e) => ({
                      criterionId: e.criterionId,
                      verdict: e.verdict,
                      reviewId: e.reviewId,
                    })),
                    artifact: r.submission?.files.artifact,
                    source: r.submission?.source,
                  })),
                })),
              method: {
                reference,
                templates: (task?.contract?.template === undefined
                  ? []
                  : (method.domain.templates
                      .get(task.contract.template.id)!
                      .decomposition?.children.map((c) => method.domain.templates.get(c.template)!) ?? [])
                ).map((t) => ({ id: t.id, goal: t.goal, applicability: t.applicability })),
              },
            }
          }),
        decompose: (input) => work(async () => {
          const release = await execution.drain(exec)
          try { return await decompose(apparatus, scheduler, caller, { ...input, taskId: current() }) }
          finally { release() }
        }),
        submit: (input) =>
          work(async () => {
            assertActive(apparatus, current())
            if (review !== undefined) {
              const release = await execution.drain(exec)
              try { return await submitReview(apparatus, review, input.path) }
              finally { release() }
            }
            const task = owner(caller.agentId)!
            if (task.rounds?.some((r) => r.status === 'pending'))
              refuse('illegal-transition', 'wait for the committed evaluation outcome before submitting the RSI report')
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
    purpose: (agentId) =>
      reviewOf(apparatus, agentId) !== undefined
        ? 'review'
        : owner(agentId) === undefined
          ? 'solve'
          : Object.values(owner(agentId)!.runs).at(-1)!.purpose,
    mountSkills: (agent) => mountMethodSkills(apparatus, agent),
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
        references: [apparatus.domain.dir, ...apparatus.domain.references,
          ...(run === undefined ? [] : methodToolReferences(apparatus, run)),
        ],
      }
    },
    skill: (agentId) => work(() => methodSkill(apparatus, agentId)),
    recordContext: (agentId) => work(() => recordMethodContext(apparatus, agentId)),
    close: () =>
      (closing ??= (async () => {
      controller.abort(new Error('driver unloading'))
        const results = await Promise.allSettled([execution.close(), scheduler.close(), ...jobs.values(), ...active])
        await apparatus.store.close()
        const errors = [...backgroundErrors, ...results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))]
        if (errors.length) throw new AggregateError(errors, 'driver unload failed')
      })()),
  }
}
