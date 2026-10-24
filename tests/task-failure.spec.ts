import { reviewedVerdict } from './command-fixtures.ts'
import { describe, expect, it } from 'vitest'

import {
  foldSubjects,
  MemoryLog,
  projectTask,
  projectTree,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { AGENT, CHILD, createRevision, deployment, openAgent, pin, planned as commandPlan } from './command-fixtures.ts'
import { ARTIFACT, BUBBLE_INPUTS, SUBJECTS, taskRegistry, UNIT_IMPLEMENTATION, UNIT_VERIFIER } from './task-fixtures.ts'
import { CHILD_A, CHILD_B, failed, judge, openRun, planned } from './tree-fixtures.ts'

describe('failed Runs record the cause that determines retry eligibility', () => {
  it.each([undefined, 'unknown', 1])('refuses an absent or unknown cause %s without a failure fact', async cause => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    const before = log.count
    const input = { ...failed(CHILD_A, 'a1'), payload: { runId: 'a1', ...(cause === undefined ? {} : { cause }) } }
    expect(await asyncRefusalOf(() => log.emit(input))).toMatchObject({ code: 'malformed-payload' })
    expect(log.count).toBe(before)
  })

  it.each(['missing', 'passing'] as const)('refuses acceptance failure with %s verdicts', async evidence => {
    const registry = taskRegistry()
    const log = await planned(registry)
    await openRun(log, CHILD_A, 'a1')
    if (evidence === 'passing') await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER))
    const before = log.count
    expect(
      await asyncRefusalOf(() => log.emit({ ...failed(CHILD_A, 'a1'), payload: { runId: 'a1', cause: 'acceptance' } })),
    ).toMatchObject({ code: 'unadjudicated-criterion' })
    expect(log.count).toBe(before)
  })

  it.each(['cancelled', 'the count is wrong'])(
    'stops runtime failure despite complete fail evidence and reason %s',
    async reason => {
      const registry = taskRegistry()
      const log = await planned(registry)
      await openRun(log, CHILD_A, 'a1')
      await log.emit(judge(CHILD_A, 'a1', 'part-a', UNIT_VERIFIER, 'fail'))
      await log.emit({ ...failed(CHILD_A, 'a1', reason), payload: { runId: 'a1', cause: 'runtime', reason } })
      const tasks = foldSubjects<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION)
      expect(projectTree(tasks)[0]).toMatchObject({
        ready: [],
        children: [
          { taskId: CHILD_A, status: 'stopped', runsUsed: 1, maxRuns: 2 },
          { taskId: CHILD_B, status: 'blocked' },
        ],
      })
      expect(projectTask(tasks.get(CHILD_A)!).runs[0]).toMatchObject({ failureCause: 'runtime', failureReason: reason })
    },
  )

  it('replays the classified failure and consumed budget from facts', async () => {
    const registry = taskRegistry()
    const log = await planned(registry)
    for (const runId of ['a1', 'a2']) {
      await openRun(log, CHILD_A, runId)
      await log.emit(judge(CHILD_A, runId, 'part-a', UNIT_VERIFIER, 'fail'))
      await log.emit(failed(CHILD_A, runId, undefined, 'acceptance'))
    }
    const restored = MemoryLog.adopt(log.entries(), taskRegistry(), { subjects: SUBJECTS })
    const tasks = foldSubjects<TaskState>(taskRegistry(), restored.entries(), TASK_PROTOCOL, TASK_VERSION)
    expect(projectTree(tasks)[0]?.children[0]).toMatchObject({ status: 'stopped', runsUsed: 2, maxRuns: 2 })
    expect(projectTask(tasks.get(CHILD_A)!).runs.map(run => run.failureCause)).toEqual(['acceptance', 'acceptance'])
  })
})

async function candidate() {
  const live = await deployment()
  await openAgent(live)
  await createRevision(live)
  const commands = await commandPlan(live, 2)
  const start = (runId: string) =>
    commands.startRun({ purpose: 'solve', commandId: 'start:' + runId, taskId: CHILD, runId, revision: pin(live) })
  const reject = async (runId: string) => {
    await commands.openBubble({
      commandId: 'bubble:' + runId,
      taskId: CHILD,
      runId,
      inputs: BUBBLE_INPUTS,
      workspace: { kind: 'dir', ref: '/candidate' },
      model: { provider: 'test', model: 'model' },
      tools: [],
      conditions: [],
    })
    await reviewedVerdict(live, commands, {
      commandId: 'verdict:' + runId,
      taskId: CHILD,
      verdict: {
        reviewId: 'review-1',
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        runId,
        criterionId: 'part',
        verdict: 'fail',
        implementationDigest: UNIT_IMPLEMENTATION,
        artifactDigest: ARTIFACT,
        inputDigests: BUBBLE_INPUTS,
        detail: 'cancelled',
      },
    })
  }
  return { live, commands, start, reject }
}

describe('the serial start gate consumes failure cause and the declared budget', () => {
  it('retries acceptance failure within its fact budget and stops at exhaustion', async () => {
    const { live, commands, start, reject } = await candidate()
    for (const runId of ['r1', 'r2']) {
      await start(runId)
      await reject(runId)
      const settled = await commands.settle({ commandId: 'settle:' + runId, taskId: CHILD, runId })
      expect(settled.payload).toEqual({ runId, cause: 'acceptance', reason: 'cancelled' })
    }
    const before = live.store.load().entries().length
    expect(await asyncRefusalOf(() => start('r3'))).toMatchObject({
      code: 'illegal-transition',
      detail: expect.stringContaining('budget exhausted'),
    })
    expect(live.store.load().entries()).toHaveLength(before)
    expect(
      projectTree(live.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))[0]?.children[0],
    ).toMatchObject({ status: 'stopped', runsUsed: 2, maxRuns: 2 })
  })

  it('fails explicitly as runtime and rejects a successor even when one Run remains', async () => {
    const { live, commands, start, reject } = await candidate()
    await start('r1')
    await reject('r1')
    const failed = await commands
      .forAgent(AGENT)
      .failRun({ commandId: 'runtime:r1', taskId: CHILD, runId: 'r1', reason: 'cancelled' })
    expect(failed.payload).toEqual({ runId: 'r1', cause: 'runtime', reason: 'cancelled' })
    const before = live.store.load().entries().length
    expect(await asyncRefusalOf(() => start('r2'))).toMatchObject({
      code: 'illegal-transition',
      detail: expect.stringContaining('stopped'),
    })
    expect(live.store.load().entries()).toHaveLength(before)
  })

  it('sees a runtime failure queued before a successor start', async () => {
    const { live, commands, start } = await candidate()
    await start('r1')
    const before = live.store.load().entries().length
    const outcomes = await Promise.allSettled([
      commands.failRun({ commandId: 'runtime:r1', taskId: CHILD, runId: 'r1' }),
      start('r2'),
    ])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(live.store.load().entries()).toHaveLength(before + 1)
  })
})
