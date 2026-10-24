import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { aborted } from 'node:util'
import { refuse } from '../../src/protocol/refusal.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, reviewCriterion, type ReviewRun } from '../../src/review/protocol.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { openApparatus } from './apparatus.ts'
import type { EvolutionOptions } from './evolution.ts'
import type { Execution } from './execution.ts'
import { createScheduler } from './scheduler.ts'

import type { DriverOptions } from './task-service.ts'

export async function openDriverRuntime(options: DriverOptions) {
  const parallelism = options.evaluationParallelism ?? 1
  if (!Number.isSafeInteger(parallelism) || parallelism < 1)
    refuse('malformed-declaration', 'evaluationParallelism must be a positive integer')
  const apparatus = await openApparatus(
    options.controlId,
    options.workspaceRoot,
    options.domain,
    options.persistence,
    options.attachments,
    options.projections,
  )
  const measurement = apparatus.domain.measurement
  const criterion = reviewCriterion(
    (apparatus.domain.rootTemplate === undefined
      ? undefined
      : apparatus.domain.templates.get(apparatus.domain.rootTemplate)
    )?.criteria[0] ?? { criterionId: 'task-accepted', statement: 'The Task meets its frozen contract' },
  )
  const evaluation: Pick<EvolutionOptions, 'criterion' | 'metric' | 'trials' | 'weights' | 'calibration'> = {
    criterion,
    metric: {
      measured: measurement?.criterion ?? { ...criterion, criterionId: `${criterion.criterionId}:quality` },
      unit:
        measurement === undefined
          ? apparatus.domain.suite?.scoring === 'criteria'
            ? 'criteria fraction'
            : 'pass'
          : `${measurement.unit} / baseline`,
      direction: measurement?.direction ?? 'higher',
    },
    trials: 1,
    weights:
      measurement?.evaluation?.weights ??
      (measurement === undefined ? { quality: 1, cost: 1 } : { quality: 100, cost: 15 }),
    calibration: {
      floor: measurement?.evaluation?.noiseFloor ?? (measurement === undefined ? 0 : 0.01),
      source: 'declared',
    },
  }
  const controller = new AbortController(),
    active = new Set<Promise<unknown>>(),
    jobs = new Map<string, Promise<void>>()
  const backgroundErrors: unknown[] = []
  let closing: Promise<void> | undefined
  const tasks = () => apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const registry = () =>
    (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry
  const owner = (agentId: string) => [...tasks().values()].findLast(t => t.responsibility?.agentId === agentId)
  const parentOf = (id: string) =>
    [...tasks().values()].find(t => t.decomposition?.children.some(c => c.taskId === id))?.taskId ??
    [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find(r =>
      r.children.some(c => c.taskId === id),
    )?.reviewId
  const nativeEvents = async (sessionId: string): Promise<readonly SessionEvent[]> => {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
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
  const work = <T>(step: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) refuse('illegal-transition', 'driver is closing')
    controller.signal.throwIfAborted()
    const pending = step()
    active.add(pending)
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    )
    return pending
  }
  const scheduler = createScheduler(apparatus, options.seams)
  const startJob = (key: string, run: () => Promise<void>): void => {
    if (jobs.has(key)) return
    const pending = run()
    jobs.set(key, pending)
    void pending.then(
      () => jobs.delete(key),
      error => {
        jobs.delete(key)
        if (!controller.signal.aborted) backgroundErrors.push(error)
      },
    )
  }
  const idle = async (agents: readonly Agent[], signal = controller.signal): Promise<void> => {
    await Promise.race([Promise.all(agents.map(agent => agent.whenIdle())), aborted(signal, agents)])
    signal.throwIfAborted()
    const sessions = (
      options.seams.get === undefined ? options.seams.sessions : options.seams.get('sessions')
    ) as ChildSessionSeams['sessions']
    for (const agent of agents)
      if (!(await sessions!.flush(agent.session)))
        refuse('write-not-durable', `session ${agent.id} has no durability listener`)
  }
  const close = (execution: Execution, cancellationReasons: readonly unknown[]) =>
    (closing ??= (async () => {
      controller.abort(new Error('driver unloading'))
      scheduler.stop()
      const results = await Promise.allSettled([execution.close(), scheduler.close(), ...jobs.values(), ...active])
      await apparatus.store.close()
      const cancellations = new Set([controller.signal.reason, ...cancellationReasons])
      const errors = [
        ...backgroundErrors,
        ...results.flatMap(result => (result.status === 'rejected' ? [result.reason] : [])),
      ].filter(error => !cancellations.has(error))
      if (errors.length) throw new AggregateError(errors, 'driver unload failed')
    })())
  return {
    options,
    apparatus,
    parallelism,
    measurement,
    evaluation,
    controller,
    backgroundErrors,
    tasks,
    registry,
    owner,
    parentOf,
    nativeEvents,
    taskFact,
    work,
    scheduler,
    startJob,
    idle,
    close,
  }
}
export type DriverRuntime = Awaited<ReturnType<typeof openDriverRuntime>>
