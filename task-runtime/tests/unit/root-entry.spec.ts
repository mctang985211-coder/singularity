import { TASK_GUIDANCE } from '../support/skill-roots.ts'
import { describe, expect, test } from 'vitest'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import { TaskRuntime } from '../../src/index.ts'
import { harness, createRoot, STORE, ROOT_SESSION, taskEvents } from './orchestrate.fixture.ts'

describe('TaskRuntime.intakeRootContract', () => {
  test('activates one root through the real intake, and answers a retry from the record instead of building a second', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)

    // What the activation committed: one parentless task at depth 0 carrying the
    // contract that was intaken, and one run of the root session, born active.
    const root = await h.task.taskIn(STORE, taskId)
    expect(root.depth).toBe(0)
    expect(root.parentTaskId).toBeUndefined()
    expect(root.decompositionStatus).toBe('decomposable')
    expect(root.status).toBe('running')
    expect(root.contract?.objective).toBe('ship the release')
    expect(root.contract?.acceptanceCriteria.map(criterion => criterion.criterionId)).toEqual(['root-goal'])
    const run = await h.task.runIn(STORE, runId)
    expect(run.sessionId).toBe(ROOT_SESSION)
    expect(run.status).toBe('running')
    expect(run.executionPhase).toBe('active')

    const bound = await h.runtime.runForSession(ROOT_SESSION)
    expect(bound.task.taskId).toBe(taskId)
    expect(bound.run.runId).toBe(runId)
    // The gate is open for the session the contract belongs to: the root decides
    // its own work from here.
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')

    // The same contract asked for again is the same request: one proposal, one
    // root, and the consumption answers with the ids it minted.
    const again = await createRoot(h)
    expect(again).toEqual({ taskId, runId })
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.proposals?.all).toHaveLength(1)
    expect(snapshot.proposals?.all[0]?.status).toBe('admitted')
    // The root's own event log says it was started once.
    expect(taskEvents(h).filter(event => event.kind === 'TaskStarted' && event.taskId === taskId)).toHaveLength(1)
  })

  test('refuses a contract whose only mandatory criterion is the composite conjunction, with nothing written', async () => {
    const h = harness()
    await expect(
      h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
        objective: 'the goal nobody stated', requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [
          {
            criterionId: 'root-children-verified',
            description: 'all mandatory children verified',
            mode: 'composite',
            mandatory: true,
          },
        ],
      }),
    ).rejects.toThrow(
      /requires at least one mandatory acceptance criterion judged by something other than the composite conjunction/,
    )
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(0)
    expect(snapshot.runs).toHaveLength(0)
    expect(snapshot.proposals?.all).toHaveLength(0)
  })
})

describe('TaskRuntime.adoptRoot', () => {
  test('binds an existing root after a restart, and answers a store without one as such', async () => {
    const h = harness()
    const first = await createRoot(h)
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness()
    h2.sessions.clear()
    for (const [id, stored] of h.sessions) h2.sessions.set(id, stored)
    const runtime2 = new TaskRuntime(h2.ctx as never, { capabilities: TASK_GUIDANCE })
    const reopened = await runtime2.adoptRoot(STORE, ROOT_SESSION)
    expect(reopened).toMatchObject({ adopted: true, taskId: first.taskId, runId: first.runId, phase: 'active' })
    // Adoption binds the session and opens its gate, exactly as the activation did.
    expect(runtime2.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect((await runtime2.runForSession(ROOT_SESSION)).run.runId).toBe(first.runId)
    expect((await h2.task.snapshotIn(STORE)).tasks).toHaveLength(1)

    // A store with no root at all is the state a graph's store starts in, not a
    // failure: adoption reports it and writes nothing.
    const empty = rootTaskStoreId('a-fresh-session')
    const nothing = await runtime2.adoptRoot(empty, 'a-fresh-session')
    expect(nothing.adopted).toBe(false)
    expect((await runtime2.adoptRoot(empty, 'a-fresh-session')).adopted).toBe(false)
    expect((await h2.task.snapshotIn(empty)).tasks).toHaveLength(0)
  })

  test('derives a terminal gate phase from a finished root run', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // The root run reaches a terminal state (the shape a finished tree has).
    await h.task.markRunStatusIn(STORE, taskId, runId, 'cancelled', ROOT_SESSION, { reason: 'the goal changed' })
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness()
    h2.sessions.clear()
    for (const [id, stored] of h.sessions) h2.sessions.set(id, stored)
    const runtime2 = new TaskRuntime(h2.ctx as never, { capabilities: TASK_GUIDANCE })
    await h2.task.openStore(STORE)
    const adopted = await runtime2.adoptRoot(STORE, ROOT_SESSION)
    expect(adopted).toMatchObject({ adopted: true, taskId, runId, phase: 'terminal' })
    // §1.8: a late write on a finished root is refused by the gate as well as by
    // the state — the phase came back off the store, not out of this process.
    expect(runtime2.gate.phaseOf(ROOT_SESSION)).toBe('terminal')
    expect(runtime2.gate.decide(ROOT_SESSION, 'write').allow).toBe(false)
    expect(runtime2.gate.decide(ROOT_SESSION, 'task_decompose').allow).toBe(false)
    expect(runtime2.gate.decide(ROOT_SESSION, 'task_read').allow).toBe(true)
  })
})

describe('TaskRuntime.listCapabilities', () => {
  test('ships no table of its own: an unconfigured runtime lists none, and hands out a copy', () => {
    const h = harness()
    const runtime = new TaskRuntime(h.ctx as never, {})
    const listed = runtime.listCapabilities()
    expect(listed).toEqual({})
    ;(listed as Record<string, unknown>)['design-chip'] = {}
    expect(runtime.listCapabilities()).toEqual({})
  })

  test('reflects a configured registry instead of any code default', () => {
    const h = harness({ config: { capabilities: { research: { skills: ['web'] } } } })
    const runtime = new TaskRuntime(h.ctx as never, { capabilities: { research: { skills: ['web'] } } })
    expect(runtime.listCapabilities()).toEqual({ research: { skills: ['web'] } })
  })
})
