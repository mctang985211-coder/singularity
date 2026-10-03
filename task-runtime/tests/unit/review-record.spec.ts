import { TASK_GUIDANCE } from '../support/skill-roots.ts'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, ReviewRecord, TaskRun, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import { requestedSession } from '../support/person-request.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import type { ChildOutcome, Config, DecomposeSpec, RootContractSpec } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'

const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface SpawnCall {
  sessionId: string
  name: string
  /** The message the request carried, when it carried one; a task-worker spawn carries none (A2). */
  prompt?: string
  taskWorker?: boolean
  agentPreset?: string
}

/** A stubbed deployment session plane: what the worker sessions' log and projections report. */
interface SessionStub {
  events?: SessionEvent[]
  tokens?: Record<string, number>
  /** When true, the session-log read throws, standing in for an unavailable reader. */
  readSessionError?: boolean
}

function harness(
  options: {
    config?: Partial<Config>
    verifier?: 'pass' | 'by-objective'
    spawnError?: string
    logTail?: string
    session?: SessionStub
  } = {},
) {
  const sessions = new Map<string, StoredSession>()
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request every intake here
  // rests on.
  sessions.set(ROOT_SESSION, requestedSession(ROOT_SESSION, 'ship the release'))
  const disposers: Array<() => unknown> = []
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => {
          stored.events.push(...events)
        },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => {
          stored.events.push(...events)
        },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }

  const spawned: SpawnCall[] = []
  const cancelled: string[] = []
  let idleBehavior: ((sessionId: string) => Promise<void>) | undefined
  const parentAgent = { id: ROOT_SESSION }
  const agentRuntime = {
    spawn: vi.fn(
      async (
        _parent: unknown,
        request: {
          sessionId: string
          name: string
          prompt?: Array<{ type: 'text'; text: string }>
          taskWorker?: boolean
          agentPreset?: string
        },
      ) => {
        if (options.spawnError !== undefined) throw new Error(options.spawnError)
        spawned.push({
          sessionId: request.sessionId,
          name: request.name,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt.map(block => block.text).join('\n') }),
          // A delegated child is spawned as a task worker (A2): its contract and
          // state are the context assembly's, so the request carries no prompt of
          // its own and no contract text.
          ...(request.taskWorker !== undefined ? { taskWorker: request.taskWorker } : {}),
          ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
        })
        // `cancel` converges the agent to idle, as the real loop's does (A3 §3.7):
        // the wait that saw the abort then reports it.
        let releaseIdle: (() => void) | undefined
        const agent = {
          id: request.sessionId,
          cancel: vi.fn(() => {
            cancelled.push(request.sessionId)
            releaseIdle?.()
          }),
          whenIdle: vi.fn(
            () =>
              new Promise<void>((resolve, reject) => {
                releaseIdle = resolve
                void (idleBehavior ?? defaultIdle)(request.sessionId).then(resolve, reject)
              }),
          ),
        }
        return { agent, dispose: vi.fn(async () => {}) }
      },
    ),
  }
  const graphs = {
    graphForSession: vi.fn(async (_sessionId: string) => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: ROOT_SESSION,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
      createdAt: 0,
      ready: true,
    })),
  }

  let taskService!: TaskService
  const verifier = {
    verifyRun: vi.fn(async (storeId: string, runId: string): Promise<EvidenceBundle> => {
      const run = await taskService.runIn(storeId, runId)
      const instance = await taskService.taskIn(storeId, run.taskId)
      const verdict: VerificationResult['status'] =
        options.verifier === 'by-objective' && instance.objective.includes('fail-me') ? 'fail' : 'pass'
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: verdict,
        verifierId: 'fake-verifier',
        ...(criterion.command === undefined
          ? {}
          : {
              command: criterion.command,
              exitCode: verdict === 'pass' ? 0 : 1,
              logRef: `${storeId}/${runId}/${criterion.criterionId}.log`,
            }),
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: run.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: 'fake-verifier',
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await taskService.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    }),
    logTail: vi.fn(async (logRef: string) => options.logTail ?? `tail of ${logRef}`),
  }

  const listeners = new Map<string, Set<(...args: never[]) => unknown>>()
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
    },
    // The run watcher rides `task/change` (A3 §3.1); an `on` that swallowed
    // subscriptions would test a watcher that never fires.
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (...a: unknown[]) => unknown)(...args)
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    sessionPersistence: persistence,
    agentRuntime,
    agents: { get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : undefined) },
    graphs,
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  ctx.verifier = verifier
  // The session plane stays absent unless a test asks for it: a deployment
  // without sessionProjections/sessionQuery is the case the record must survive.
  const readSession = vi.fn(async (_sessionId: SessionId) => {
    if (options.session?.readSessionError === true) throw new Error('session log unavailable')
    return { events: options.session?.events ?? [] }
  })
  const snapshot = vi.fn(() => ({
    values: options.session?.tokens === undefined ? {} : { tokenUsage: options.session.tokens },
  }))
  if (options.session !== undefined) {
    ctx.sessions = { get: () => ({ id: 'live-session' }) }
    ctx.sessionProjections = { snapshot }
    ctx.sessionQuery = { readSession }
  }
  const runtime = new TaskRuntime(ctx as never, { ...options.config, capabilities: { ...TASK_GUIDANCE, ...options.config?.capabilities } })
  /** A3's worker protocol: hand the result in through the submission entry, then idle. */
  const defaultIdle = async (sessionId: string): Promise<void> => {
    await runtime.submitResult(sessionId, { summary: `done: ${sessionId}` })
  }
  return {
    ctx,
    sessions,
    disposers,
    task: taskService,
    runtime,
    verifier,
    spawned,
    cancelled,
    graphs,
    observe: { readSession, snapshot },
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => {
      idleBehavior = behavior
    },
  }
}

type Harness = ReturnType<typeof harness>

function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as NonNullable<DecomposeSpec['children']>[number]
}

/**
 * The root contract these cases run under (A0 §1.2): one goal, one criterion a
 * command settles. Plan and act — the intake, the review gate and the activation
 * — are what these specs exercise; the root's own acceptance is stated here
 * rather than assumed, because a root contract now has to carry at least one
 * mandatory criterion judged by something other than the composite conjunction.
 */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'root-ship', description: 'the release is shipped', command: 'true' }],
}

/** Activate the root through the real intake and hand back what it became. */
async function intakeRoot(h: Harness): Promise<{ taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, ROOT_CONTRACT)
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { taskId: activated.taskId, runId: activated.runId }
}

/** Admit a batch and wait for its settlement: the tool call returns at admission (A3 §3.1). */
async function decomposeAndSettle(
  h: Harness,
  ...args: Parameters<TaskRuntime['decomposeAndRun']>
): Promise<ChildOutcome[]> {
  const { batchId } = await h.runtime.decomposeAndRun(...args)
  return await h.runtime.awaitBatch(args[0], batchId)
}

/**
 * The parent's own submission (K1 §2): a batch end hands the run back `active`
 * and the runtime no longer submits for it, so a case about the parent's review
 * record asks for it the way the parent's agent does.
 */
async function submitParentResult(h: Harness): Promise<string> {
  return (await h.runtime.submitResult(ROOT_SESSION, { summary: 'the parent reports what its batch delivered' })).status
}

/**
 * Stand-in for a nested cascade settling a child, review record included: the
 * nested cascade writes the run's one review as it settles its parent run.
 */
async function settleRunNested(
  task: TaskService,
  storeId: string,
  taskId: string,
  runId: string,
  actor: string,
): Promise<string> {
  const instance = await task.taskIn(storeId, taskId)
  const evidenceId = `e-nested-${runId}`
  const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
    criterionId: criterion.criterionId,
    status: 'pass',
    verifierId: 'nested-verifier',
  }))
  const bundle: EvidenceBundle = {
    evidenceId,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults,
    claims: verifierResults.map(result => ({
      claimId: `claim-${result.criterionId}`,
      criterionId: result.criterionId,
      status: result.status,
      verifierId: 'nested-verifier',
      artifactRefs: [],
    })),
    generatedAt: new Date().toISOString(),
  }
  await task.markRunStatusIn(storeId, taskId, runId, 'verifying', actor)
  await task.recordEvidenceIn(storeId, bundle, 'nested-verifier')
  await task.markRunStatusIn(storeId, taskId, runId, 'verified', actor)
  await task.recordReviewIn(
    storeId,
    {
      taskId,
      runId,
      sessionId: actor,
      outcome: 'verified',
      evidenceRefs: [evidenceId],
      anomalies: [],
    },
    actor,
  )
  return evidenceId
}

const TERMINAL = new Set(['verified', 'failed', 'cancelled', 'blocked'])

/** The P4 invariant: every terminal run carries exactly one review, and no run carries two. */
function expectReviewInvariant(reviews: readonly ReviewRecord[], runs: readonly TaskRun[]): void {
  for (const run of runs.filter(item => TERMINAL.has(item.status))) {
    expect(reviews.filter(item => item.runId === run.runId)).toHaveLength(1)
  }
  const bound = reviews.filter(item => item.runId !== undefined).map(item => item.runId)
  expect(new Set(bound).size).toBe(bound.length)
  for (const review of reviews) {
    expect(TERMINAL.has(review.outcome)).toBe(true)
    if (review.outcome === 'failed') expect(review.localizedCause).toBeDefined()
    else {
      expect(review.localizedCause).toBeUndefined()
      expect(review.logTail).toBeUndefined()
    }
  }
}

describe('runChildrenCascade review records', () => {
  test('every terminal run settles with exactly one review; failed carries a cause, verified and blocked do not', async () => {
    const h = harness({ verifier: 'by-objective' })
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('fail-me now'), childSpec('downstream', { dependsOn: [0] }), childSpec('independent')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked', 'verified'])
    expect(await submitParentResult(h)).toBe('verified')

    const snapshot = await h.task.snapshotIn(STORE)
    expectReviewInvariant(snapshot.reviews, snapshot.runs)
    // three started runs (root, failed child, verified child) plus the runless blocked review
    expect(snapshot.reviews).toHaveLength(4)

    const byTask = new Map(snapshot.reviews.map(item => [item.taskId, item]))
    const failed = byTask.get(outcomes[0]!.taskId)!
    expect(failed.runId).toBe(outcomes[0]!.runId)
    expect(failed.sessionId).toBe(h.spawned[0]!.sessionId)
    expect(failed.localizedCause).toBe('mandatory criteria not satisfied: ac1-1 fail')
    expect(failed.evidenceRefs).toEqual([outcomes[0]!.evidenceId])
    expect(failed.criteria).toEqual([
      {
        criterionId: 'ac1-1',
        verdict: 'fail',
        // The deciding judge rides along since S1-V slice 2; the rest of the
        // record is what it always was.
        verifierId: 'fake-verifier',
        command: 'true',
        exitCode: 1,
        logRef: `${STORE}/${outcomes[0]!.runId}/ac1-1.log`,
      },
    ])
    expect(failed.logTail).toBe(`tail of ${STORE}/${outcomes[0]!.runId}/ac1-1.log`)
    expect(failed.durationMs).toBeGreaterThanOrEqual(0)

    const blocked = byTask.get(outcomes[1]!.taskId)!
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.runId).toBeUndefined()
    expect(blocked.localizedCause).toBeUndefined()
    expect(blocked.anomalies).toEqual([`dependencies [${outcomes[0]!.taskId}] did not verify`])
    expect(blocked.relatedTaskIds).toEqual([outcomes[0]!.taskId])
    expect(blocked.blockedBy).toEqual([{ taskId: outcomes[0]!.taskId, outcome: 'failed' }])
    expect(blocked.durationMs).toBeUndefined()

    const verifiedChild = byTask.get(outcomes[2]!.taskId)!
    expect(verifiedChild.outcome).toBe('verified')
    expect(verifiedChild.localizedCause).toBeUndefined()
    expect(verifiedChild.evidenceRefs).toEqual([outcomes[2]!.evidenceId])
    expect(verifiedChild.criteria).toEqual([
      {
        criterionId: 'ac3-1',
        verdict: 'pass',
        verifierId: 'fake-verifier',
        command: 'true',
        exitCode: 0,
        logRef: `${STORE}/${outcomes[2]!.runId}/ac3-1.log`,
      },
    ])
    expect(verifiedChild.logTail).toBeUndefined()
    expect(verifiedChild.durationMs).toBeGreaterThanOrEqual(0)

    const root = byTask.get(rootTaskId)!
    expect(root.outcome).toBe('verified')
    expect(root.runId).toBe(rootRunId)
    expect(root.relatedTaskIds).toEqual(outcomes.map(outcome => outcome.taskId))
    // The root's own criteria are the ones its contract carried (A0 §1.2): the
    // intake no longer expands a fixed composite spec, so what a root review
    // records is the goal's own criterion, not a conjunction standing in for it.
    expect(root.criteria).toEqual([
      {
        criterionId: 'root-ship',
        verdict: 'pass',
        verifierId: 'fake-verifier',
        command: 'true',
        exitCode: 0,
        logRef: `${STORE}/${rootRunId}/root-ship.log`,
      },
    ])
  })

  test('a cancelled run leaves a review without a cause; the siblings it never started leave one blocked', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    // A worker mid-turn: only the batch's own cancellation ends it.
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b', { dependsOn: [0] })],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const outcomes = await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)

    const snapshot = await h.task.snapshotIn(STORE)
    expectReviewInvariant(snapshot.reviews, snapshot.runs)
    expect(snapshot.reviews).toHaveLength(3)
    const byTask = new Map(snapshot.reviews.map(item => [item.taskId, item]))
    const cancelled = byTask.get(outcomes[0]!.taskId)!
    expect(cancelled.outcome).toBe('cancelled')
    expect(cancelled.runId).toBe(outcomes[0]!.runId)
    expect(cancelled.localizedCause).toBeUndefined()
    expect(cancelled.criteria).toBeUndefined()
    expect(cancelled.logTail).toBeUndefined()
    expect(cancelled.durationMs).toBeGreaterThanOrEqual(0)
    expect(byTask.get(rootTaskId)!.outcome).toBe('cancelled')
    // The second child never got a run, so its one review is runless and blocked.
    const neverStarted = byTask.get(outcomes[1]!.taskId)!
    expect(neverStarted.runId).toBeUndefined()
    expect(neverStarted.outcome).toBe('blocked')
    expect(neverStarted.evidenceRefs).toEqual([])
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
  })

  test('a spawn refusal still settles the run with exactly one review carrying the spawn cause', async () => {
    const h = harness({ spawnError: 'Unknown agent preset: default' })
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('unlucky child'), childSpec('downstream', { dependsOn: [0] })],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    expect(await submitParentResult(h)).toBe('verified')

    const snapshot = await h.task.snapshotIn(STORE)
    expectReviewInvariant(snapshot.reviews, snapshot.runs)
    // spawn-refused child + runless blocked dependent + verified root
    expect(snapshot.reviews).toHaveLength(3)
    const failed = snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!
    expect(failed.outcome).toBe('failed')
    expect(failed.localizedCause).toBe('spawn failed: Unknown agent preset: default')
    expect(failed.evidenceRefs).toEqual([])
    expect(failed.sessionId).toBe((await h.task.runIn(STORE, outcomes[0]!.runId!)).sessionId)
    // the verifier never ran, so there are no criteria and no log tail — only the duration
    expect(failed.criteria).toBeUndefined()
    expect(failed.logTail).toBeUndefined()
    expect(failed.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('a run settled by a nested cascade carries exactly one review, written by the nested side', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId)
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true }), childSpec('downstream', { dependsOn: [0] })],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(await submitParentResult(h)).toBe('verified')

    const snapshot = await h.task.snapshotIn(STORE)
    expectReviewInvariant(snapshot.reviews, snapshot.runs)
    expect(snapshot.reviews).toHaveLength(3)
    const nested = snapshot.reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(nested).toHaveLength(1)
    expect(nested[0]!.outcome).toBe('verified')
    expect(nested[0]!.evidenceRefs).toEqual([`e-nested-${outcomes[0]!.runId}`])
    expect(nested[0]!.localizedCause).toBeUndefined()
  })
})

/** One stub log event; only `type` and `data` are read by the runtime, so the envelope stays loose. */
function sessionEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

describe('review dimensions and metrics (P4)', () => {
  test('without a session plane the record keeps the store-derived facts and claims no session counters', async () => {
    const h = harness({ verifier: 'by-objective' })
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('fail-me now'), childSpec('downstream', { dependsOn: [0] })],
    })
    const snapshot = await h.task.snapshotIn(STORE)
    const failed = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)!

    // Only the counters the store itself can answer; nothing session-scoped is invented as 0.
    expect(failed.metrics).toEqual({ retries: 0, evidenceLogs: 1 })
    expect(failed.dimensions).toEqual({
      outcomeCorrectness: { outcome: 'failed', criteriaCount: 1, unmetCriterionIds: ['ac1-1'] },
      taskSpecification: { objectivePresent: true, criteriaCount: 1, criteriaWithCommand: 1 },
      acceptance: { criteria: [{ criterionId: 'ac1-1', mode: 'deterministic', hasCommand: true, mandatory: true }] },
      decomposition: { depth: 1, decompositionStatus: 'leaf', childCount: 0, incomingEdges: 0, outgoingEdges: 1 },
      capabilityCoverage: { closure: 'closed', granted: ['task-execution'], missing: [] },
      skillFit: { granted: ['task-execution'] },
      toolFit: { granted: [] },
    })
    expect(failed.dimensions?.contextEfficiency).toBeUndefined()

    // A task that never ran has no run-scoped and no session-scoped fact: no metrics object at all.
    const blocked = snapshot.reviews.find(item => item.taskId === outcomes[1]!.taskId)!
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.metrics).toBeUndefined()
    expect(blocked.dimensions?.outcomeCorrectness).toEqual({
      outcome: 'blocked',
      criteriaCount: 0,
      unmetCriterionIds: [],
    })
  })

  test('a session observation fills the token, tool, skill and intervention facts with observed numbers', async () => {
    pinSkillHome('ball-align')
    const h = harness({
      config: { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] } } },
      session: {
        tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
        events: [
          sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 0),
          sessionEvent(
            'tool/call',
            { turn: 1, step: 1, callId: 'c2', name: 'skill', arguments: '{"name":"ball-align"}' },
            1,
          ),
          sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c3', name: 'ask_user_question', arguments: '{}' }, 2),
          sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c4', name: 'web_search', arguments: '{}' }, 3),
          sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'hitl_approve', arguments: '{}' }, 4),
          sessionEvent('approval/asked', { id: 'a1', toolName: 'hitl_approve', callId: 'c9' }, 5),
          sessionEvent('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, isError: true } }, 6),
          sessionEvent('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c2' }, isError: false } }, 7),
          sessionEvent('compaction/start', {}, 8),
        ],
      },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child work', { requiredCapabilities: ['design-ball'] })],
    })
    const snapshot = await h.task.snapshotIn(STORE)
    const child = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)!

    // The reader is asked about this run's own session, not the root's.
    expect(String(h.observe.readSession.mock.calls[0]![0])).toBe(h.spawned[0]!.sessionId)

    expect(child.metrics).toEqual({
      tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
      // five calls, one of which reported a failure
      toolCalls: { calls: 5, failures: 1 },
      // the approval plus ask_user_question; the hitl_approve call is the same
      // interaction the approval/asked event already covers, so it is not counted twice
      humanInterventions: 2,
      retries: 0,
      evidenceLogs: 1,
    })
    expect(child.dimensions?.skillFit).toEqual({
      granted: ['ball-align'],
      loaded: ['ball-align'],
      loadedOutsideGrant: [],
    })
    expect(child.dimensions?.toolFit).toEqual({
      // 'design-ball' declares filesystem + bash, expanded to real tool names at admission
      granted: ['bash', 'edit', 'read', 'write'],
      called: [
        { name: 'ask_user_question', count: 1 },
        { name: 'hitl_approve', count: 1 },
        { name: 'read', count: 1 },
        { name: 'skill', count: 1 },
        { name: 'web_search', count: 1 },
      ],
      // the human tools are in the worker baseline; web_search and hitl_approve are in neither grant nor baseline
      calledOutsideGrant: ['hitl_approve', 'web_search'],
    })
    expect(child.dimensions?.contextEfficiency).toEqual({
      tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
      compactions: 1,
    })
    expect(child.dimensions?.capabilityCoverage).toEqual({
      closure: 'closed',
      granted: ['ball-align', 'bash', 'edit', 'read', 'write'],
      missing: [],
    })
  })

  test('a session log read that throws costs the record nothing', async () => {
    const h = harness({
      session: {
        readSessionError: true,
        tokens: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await intakeRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child work')],
    })
    const snapshot = await h.task.snapshotIn(STORE)
    expectReviewInvariant(snapshot.reviews, snapshot.runs)
    const child = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)!

    expect(child.outcome).toBe('verified')
    expect(child.metrics).toEqual({
      tokens: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      retries: 0,
      evidenceLogs: 1,
    })
    expect(child.dimensions?.toolFit).toEqual({ granted: [] })
    expect(child.dimensions?.contextEfficiency).toEqual({
      tokens: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })
})
