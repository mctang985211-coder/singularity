import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import type { RoundRequest, RSIStatus } from '../../src/task/lifecycle.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { declareCaller, taskStateOf } from './apparatus.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { createEvolution } from './evolution.ts'
import { executionProfile } from './execution-profile.ts'
import { sha256 } from './ids.ts'
import { explorationOf, improvementTaskId, startImprovement } from './improvement.ts'
import { loadMethod, publishedMethod } from './method.ts'
import { createNativeSolve, observeSolve } from './native-solve.ts'
import { advanceRsiBatch } from './rsi-proposal.ts'

import type { DriverRuntime } from './driver-runtime.ts'

export function createRsiLifecycle(runtime: DriverRuntime) {
  const {
    apparatus,
    options,
    tasks,
    parentOf,
    registry,
    controller,
    taskFact,
    scheduler,
    startJob,
    idle,
    evaluation,
    measurement,
    parallelism,
  } = runtime
  const rsiControllers = new Map<string, AbortController>()
  let scheduled = false
  const rsiRootOf = (taskId: string): TaskState | undefined => {
    const states = tasks(),
      seen = new Set<string>()
    let id: string | undefined = taskId
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const task = states.get(id)
      if (task === undefined) {
        const review: ReviewRun | undefined = apparatus.store
          .load()
          .stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, id)
        if (review === undefined) return undefined
        if (review.target.kind === 'acceptance') {
          id = review.target.taskId
          continue
        }
        const reviewId = (operation: string) => `review-${sha256(`${apparatus.controlId}/${operation}`).slice(0, 24)}`
        const target: Exclude<ReviewRun['target'], { kind: 'acceptance' }> = review.target
        id = [...states.values()].find(
          (t): boolean =>
            Object.values(t.runs).some(run => run.purpose === 'improve') &&
            (target.kind === 'proposal'
              ? review.reviewId === reviewId(`proposal:${t.taskId}:${target.assetsDigest}`)
              : review.reviewId === reviewId(`transfer:${t.taskId}:release:review`) ||
                t.rounds?.some(round => review.reviewId === reviewId(`round:${round.roundId}:release:review`)) ===
                  true),
        )?.taskId
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
  const rsiStatus = (taskId: string, value: RSIStatus) => {
    const prior = apparatus.store
      .load()
      .entriesOf(TASK_PROTOCOL, TASK_VERSION)
      .findLast(fact => fact.subject === taskId && fact.kind === 'rsi/status')
    return taskFact(`rsi:${taskId}:${value.status}:${prior?.seq ?? 0}`, 'rsi/status', taskId, value)
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
                await taskFact(
                  `cancel:${task.taskId}:${batch.batchId}:${slot}`,
                  'rsi/batch-slot-settled',
                  task.taskId,
                  { batchId: batch.batchId, slot, status: 'cancelled', detail: reason },
                  as,
                )
            await taskFact(
              `cancel:${task.taskId}:${batch.batchId}`,
              'rsi/batch-ended',
              task.taskId,
              { batchId: batch.batchId },
              as,
            )
          }
        }
        for (const round of task.rounds ?? [])
          if (round.status === 'pending')
            await taskFact(`round-settled:${round.roundId}`, 'rsi/round-settled', task.taskId, {
              roundId: round.roundId,
              status: 'failed',
              error: reason,
            })
        if (task.transfer?.consumed && task.transfer.outcome === undefined) {
          const report = await apparatus.attachments.saveFile({
            name: 'transfer-report.json',
            data: Buffer.from(JSON.stringify({ status: 'insufficient-evidence', reason })),
          })
          await taskFact(
            `transfer:${task.taskId}:settled`,
            'rsi/transfer-settled',
            task.taskId,
            { outcome: 'insufficient-evidence', report },
            as,
          )
        }
        if (run.status === 'running')
          await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
            commandId: `cancel:${task.taskId}:${run.runId}`,
            taskId: task.taskId,
            runId: run.runId,
            cause,
            reason,
          })
      }
      registry()
        .get(SessionId(task.responsibility!.agentId))
        ?.cancel({ kind: cause === 'cancelled' ? 'user' : 'parent' })
    }
    for (const review of apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()) {
      if (controller.signal.aborted) return
      if (review.status !== 'running' || rsiRootOf(review.reviewId)?.taskId !== rootId) continue
      await createReviewCommands(apparatus.store).fail(`cancel:${review.reviewId}`, review.reviewId, reason)
      registry()
        .get(SessionId(review.sessionId))
        ?.cancel({ kind: cause === 'cancelled' ? 'user' : 'parent' })
      await scheduler.advance(review.reviewId)
    }
    for (const task of affected) {
      if (controller.signal.aborted) return
      await scheduler.advance(task.taskId)
      const current = taskStateOf(apparatus, task.taskId),
        last = Object.values(current.runs).at(-1)
      if (last !== undefined && last.status !== 'running')
        await closeRoot(current, last, last.status === 'verified' ? 'accepted' : 'failed')
    }
  }
  const advanceRound = async (
    task: TaskState,
    request: RoundRequest,
    parent: Agent,
    signal: AbortSignal,
  ): Promise<void> => {
    const { runId: _runId, status: _status, error: _error, ...round } = request
    try {
      signal.throwIfAborted()
      const native = createNativeSolve(
        apparatus,
        options.seams,
        parent,
        signal,
        measurement === undefined
          ? undefined
          : {
              digest: measurement.criterion.implementationDigest,
              measure: (source, signal, context) => measurement.measure(source, signal, context),
            },
      )
      const suite = apparatus.domain.suite
      const profile =
        suite === undefined ? undefined : await executionProfile(parent, options.seams, apparatus.domain, parallelism)
      const evolution = createEvolution({
        store: apparatus.store,
        registry: apparatus.registry,
        ...evaluation,
        parallelism,
        productionHead: publishedMethod(apparatus)!.revisionId,
        ...(suite === undefined ? {} : { suite, executionProfileDigest: profile!.digest }),
        loadMethod: async revision => (await loadMethod(apparatus, revision)).assets,
        baseline:
          suite === undefined
            ? async trialRequest => {
                const { revision, started } = trialRequest
                const ownerRun = task.runs[request.runId]!
                const source = ownerRun.relatedTo!
                const incumbent = taskStateOf(apparatus, source.taskId).runs[source.runId]!
                if (incumbent.revision.digest !== revision.digest || evaluation.trials !== 1) {
                  const measured = [
                    ...apparatus.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values(),
                  ].findLast(
                    e =>
                      e.candidate?.digest === revision.digest &&
                      e.trials === 1 &&
                      e.observed.length === 1 &&
                      digestOf(e.metric) === digestOf(evaluation.metric) &&
                      e.observed[0]!.detail !== undefined,
                  )
                  if (measured !== undefined) {
                    const observation = JSON.parse(
                      measured.observed[0]!.detail!,
                    ) as import('./evolution.ts').SolveResult
                    if (
                      digestOf(taskStateOf(apparatus, observation.taskId).contract) ===
                      digestOf(taskStateOf(apparatus, source.taskId).contract)
                    ) {
                      await started({ taskId: observation.taskId, runId: observation.runId })
                      return observation
                    }
                  }
                  return native(trialRequest)
                }
                await started(source)
                return observeSolve(
                  apparatus,
                  source.taskId,
                  source.runId,
                  signal,
                  measurement === undefined
                    ? undefined
                    : {
                        digest: measurement.criterion.implementationDigest,
                        measure: (source, signal, context) => measurement.measure(source, signal, context),
                      },
                )
              }
            : native,
        solve: native,
      })
      await evolution.runRound({ ...round, campaignId: task.taskId })
      signal.throwIfAborted()
      const currentRun = taskStateOf(apparatus, task.taskId).runs[request.runId]!
      if (currentRun.status !== 'running' || currentRun.stage !== 'working')
        refuse('illegal-transition', 'evaluation requires its working RSI Run')
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
      if (
        task.closure === undefined &&
        last !== undefined &&
        last.status !== 'running' &&
        parentOf(task.taskId) === undefined
      )
        startJob(`close:${task.taskId}`, async () => {
          try {
            await idle([parent])
            const state = taskStateOf(apparatus, task.taskId),
              run = Object.values(state.runs).at(-1)!
            if (state.closure === undefined && run.status !== 'running') {
              await closeRoot(state, run, run.status === 'verified' ? 'accepted' : 'failed')
              schedule()
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error
          }
        })
      if (
        (task.closure !== undefined &&
          last?.purpose === 'solve' &&
          last.failureCause !== 'cancelled' &&
          task.learning !== false &&
          task.rsi === undefined &&
          parentOf(task.taskId) === undefined) ||
        task.rsi?.status === 'pending' ||
        task.rsi?.status === 'running'
      )
        startJob(`rsi:${task.taskId}`, async () => {
          const signal = rsiSignal(task.taskId)
          try {
            signal.throwIfAborted()
            if (taskStateOf(apparatus, task.taskId).rsi === undefined)
              await rsiStatus(task.taskId, {
                status: 'pending',
                detail: 'business root closed; trajectory is available for asynchronous RSI',
              })
            if (taskStateOf(apparatus, task.taskId).rsi!.status === 'pending') {
              const sessions = [...taskSessionsOf(apparatus, task.taskId)]
                .map(id => registry().get(SessionId(id)))
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
            await closeRoot(analysis, last, last.status === 'verified' ? 'accepted' : 'failed')
          } catch (error) {
            if (signal.aborted) return
            const state = taskStateOf(apparatus, task.taskId).rsi
            if (state?.status !== 'pending' && state?.status !== 'running') throw error
            await rsiStatus(task.taskId, { status: 'failed', detail: String(error) })
          } finally {
            await stopRsiWork(task.taskId)
          }
        })
      if (last?.purpose === 'improve' && last.status === 'running' && last.stage === 'working') {
        for (const batch of task.search?.batches ?? []) {
          if (!batch.settled)
            startJob(`batch:${task.taskId}:${batch.batchId}`, async () => {
              const signal = taskSignal(task.taskId)
              try {
                await advanceRsiBatch(apparatus, options.seams, parent, task.taskId, signal)
              } catch (error) {
                if (signal.aborted) return
                throw error
              }
              schedule()
            })
          else if (!batch.outcomes.some(outcome => outcome.status === 'evaluation-requested'))
            startJob(`batch-notify:${task.taskId}:${batch.batchId}`, async () => {
              const fact = apparatus.store.committedOf(`rsi/batch-ended:${task.taskId}:${batch.batchId}`)!
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
                    runId: last.runId,
                    factSeq: fact.seq,
                  },
                  JSON.stringify({
                    batchId: batch.batchId,
                    status: 'screened',
                    outcomes: batch.outcomes.map(({ slot, status, revision }) => ({ slot, status, revision })),
                    next: 'Read singularity_read({kind:"search"}) for the current state and feedback.',
                  }),
                ),
              )
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
                await (request.status === 'pending'
                  ? advanceRound(task, request, parent, signal)
                  : notifyRound(task, request, parent))
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
  return {
    taskSignal,
    rsiStatus,
    closeRoot,
    stopRsiWork,
    rsiRootOf,
    schedule,
    abort: (rootId: string) => rsiControllers.get(rootId)?.abort(new Error('RSI cancelled by user')),
    cancellationReasons: () => [...rsiControllers.values()].filter(c => c.signal.aborted).map(c => c.signal.reason),
  }
}
export type RsiLifecycle = ReturnType<typeof createRsiLifecycle>
