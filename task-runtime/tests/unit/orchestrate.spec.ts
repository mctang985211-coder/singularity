import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, TaskEvent, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, DecomposeSpec } from '../../src/index.ts'
import { DEFAULT_VERIFY_TIMEOUT_MS, TaskRuntime, VerifierUnavailableError } from '../../src/index.ts'

const ROOT_SESSION = 'root-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

interface SpawnCall {
  sessionId: string
  name: string
  prompt: string
  agentPreset?: string
}

function harness(options: { config?: Partial<Config>; verifier?: 'pass' | 'by-objective' | 'timeout' | 'absent' } = {}) {
  const sessions = new Map<string, StoredSession>()
  const disposers: Array<() => unknown> = []
  const persistence = {
    list: vi.fn(async () => [...sessions.values()].map(item => ({ header: item.header }))),
    create: vi.fn(async (header: SessionHeader) => {
      const stored: StoredSession = { header, events: [] }
      sessions.set(header.id, stored)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
    open: vi.fn(async (id: SessionId) => {
      const stored = sessions.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored.events }),
        append: async (events: SessionEvent[]) => { stored.events.push(...events) },
        flush: async () => {},
        close: async () => {},
      }
    }),
  }

  const spawned: SpawnCall[] = []
  const cancelled: string[] = []
  let idleBehavior: (sessionId: string) => Promise<void> = async () => {}
  const parentAgent = { id: ROOT_SESSION }
  const agentRuntime = {
    spawn: vi.fn(async (_parent: unknown, request: {
      sessionId: string
      name: string
      prompt: Array<{ type: 'text'; text: string }>
      agentPreset?: string
    }) => {
      spawned.push({
        sessionId: request.sessionId,
        name: request.name,
        prompt: request.prompt.map(block => block.text).join('\n'),
        ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
      })
      const agent = {
        id: request.sessionId,
        cancel: vi.fn(() => { cancelled.push(request.sessionId) }),
        whenIdle: vi.fn(() => idleBehavior(request.sessionId)),
      }
      return { agent, dispose: vi.fn(async () => {}) }
    }),
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
      if (options.verifier === 'timeout') {
        throw new Error(`task-runtime: verification of run "${runId}" timed out after 615000ms (verifier deadline 600000ms + 15000ms safety margin)`)
      }
      const run = await taskService.runIn(storeId, runId)
      const instance = await taskService.taskIn(storeId, run.taskId)
      const verdict: VerificationResult['status'] =
        options.verifier === 'by-objective' && instance.objective.includes('fail-me') ? 'fail' : 'pass'
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: verdict,
        verifierId: 'fake-verifier',
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
  }

  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
    },
    emit: () => {},
    on: () => {},
    sessionPersistence: persistence,
    agentRuntime,
    agents: { get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : undefined) },
    graphs,
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  if (options.verifier !== 'absent') ctx.verifier = verifier
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
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
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => { idleBehavior = behavior },
  }
}

type Harness = ReturnType<typeof harness>

function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as DecomposeSpec['children'][number]
}

async function createRoot(h: Harness) {
  return h.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
}

/**
 * Stand-in for a nested cascade settling a child: the child's own worker
 * decomposed, so its run walks verifying → evidence → verified/failed before
 * the outer cascade ever looks at it.
 */
async function settleRunNested(
  task: TaskService,
  storeId: string,
  taskId: string,
  runId: string,
  actor: string,
  verdict: 'pass' | 'fail' = 'pass',
): Promise<string> {
  const instance = await task.taskIn(storeId, taskId)
  const evidenceId = `e-nested-${runId}`
  const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
    criterionId: criterion.criterionId,
    status: verdict,
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
  await task.markRunStatusIn(storeId, taskId, runId, verdict === 'pass' ? 'verified' : 'failed', actor, { reason: 'nested verdict' })
  return evidenceId
}

function taskEvents(h: Harness): TaskEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => item.data as TaskEvent))
}

/** The status walk of one run: coordination events ride on the parent run, not on the walk. */
function runEventKinds(h: Harness, runId: string): string[] {
  return taskEvents(h)
    .filter(item => item.runId === runId && item.kind !== 'HandoffCreated')
    .map(item => item.kind)
}

describe('TaskRuntime.createRootTask', () => {
  test('creates the store, admits a decomposable root, and binds a run to the root session', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)

    const root = await h.task.taskIn(STORE, taskId)
    expect(root.depth).toBe(0)
    expect(root.decompositionStatus).toBe('decomposable')
    expect(root.status).toBe('running')
    const run = await h.task.runIn(STORE, runId)
    expect(run.sessionId).toBe(ROOT_SESSION)
    expect(run.status).toBe('running')

    const bound = await h.runtime.runForSession(ROOT_SESSION)
    expect(bound.task.taskId).toBe(taskId)
    expect(bound.run.runId).toBe(runId)

    const again = await createRoot(h)
    expect(again).toEqual({ taskId, runId })
  })

  test('reopens an existing store and returns the persisted root instead of duplicating it', async () => {
    const h = harness()
    const first = await createRoot(h)
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness()
    h2.sessions.clear()
    for (const [id, stored] of h.sessions) h2.sessions.set(id, stored)
    const runtime2 = new TaskRuntime(h2.ctx as never)
    const reopened = await runtime2.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
    expect(reopened).toEqual(first)
    expect((await h2.task.snapshotIn(STORE)).tasks).toHaveLength(1)
  })
})

describe('TaskRuntime.decomposeAndRun orchestration', () => {
  test('spawns children in dependency order and records evidence before verified', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('task a'),
        childSpec('task b', { dependsOn: [0] }),
        childSpec('task c', { dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified', 'verified'])
    expect(outcomes.every(outcome => outcome.evidenceId !== undefined)).toBe(true)
    expect(h.spawned).toHaveLength(3)

    const snapshot = await h.task.snapshotIn(STORE)
    const sessionOf = (taskId: string) =>
      snapshot.runs.find(run => run.taskId === taskId && run.runId === outcomes.find(o => o.taskId === taskId)?.runId)?.sessionId
    expect(h.spawned[0]!.sessionId).toBe(sessionOf(outcomes[0]!.taskId))
    expect([h.spawned[1]!.sessionId, h.spawned[2]!.sessionId].sort()).toEqual(
      [sessionOf(outcomes[1]!.taskId), sessionOf(outcomes[2]!.taskId)].sort(),
    )
    expect(h.spawned[0]!.prompt).toContain('task a')
    expect(h.spawned[0]!.prompt).toContain('Parent objective: ship the release')

    for (const outcome of outcomes) {
      expect(runEventKinds(h, outcome.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
    }
    const parent = await h.task.taskIn(STORE, rootTaskId)
    expect(parent.decompositionStatus).toBe('decomposed')
    expect(snapshot.edges).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(snapshot.capabilities[outcome.taskId]).toBeDefined()
      const bound = await h.runtime.runForSession(sessionOf(outcome.taskId)!)
      expect(bound.task.taskId).toBe(outcome.taskId)
    }
  })

  test('a failed dependency blocks its dependents while independent siblings still run', async () => {
    const h = harness({ verifier: 'by-objective' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('fail-me now'),
        childSpec('downstream', { dependsOn: [0] }),
        childSpec('independent'),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked', 'verified'])
    expect(outcomes[0]!.evidenceId).toBeDefined()
    expect(outcomes[1]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(2)

    const blocked = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(blocked.status).toBe('blocked')
    const blockedEvents = taskEvents(h).filter(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[1]!.taskId)
    expect(blockedEvents).toHaveLength(1)
    expect(runEventKinds(h, outcomes[2]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
  })

  test('a capability gap rejects the whole batch atomically when the child may not decompose', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('fine'),
        childSpec('gap child', { requiredCapabilities: ['no-such-cap'] }),
      ],
    })).rejects.toThrow(/capability gap/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).filter(item => item.kind === 'TaskCreated')).toHaveLength(1)
  })

  test('a gap child marked decomposable is admitted as decomposable with CapabilityGapDetected', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('gap child', { requiredCapabilities: ['no-such-cap'], decomposable: true })],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.decompositionStatus).toBe('decomposable')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.missing).toEqual(['no-such-cap'])
    const kinds = taskEvents(h).map(item => item.kind)
    expect(kinds).toContain('CapabilityGapDetected')
  })

  test('an explicitly decomposable child is admitted as decomposable, with no gap, and told to split further', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('splittable child', { decomposable: true }),
        childSpec('plain child'),
      ],
    })

    const declared = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    const plain = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(declared.decompositionStatus).toBe('decomposable')
    expect(plain.decompositionStatus).toBe('leaf')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.missing).toEqual([])
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.closure).toBe('closed')
    expect(taskEvents(h).map(item => item.kind)).not.toContain('CapabilityGapDetected')

    expect(h.spawned[0]!.prompt).toContain('## This task is decomposable')
    expect(h.spawned[0]!.prompt).toContain('task_decompose')
    expect(h.spawned[1]!.prompt).not.toContain('## This task is decomposable')
    expect(h.spawned[1]!.prompt).not.toContain('task_decompose')

    // A declaration is not a gap: with no nested decomposition the child still
    // runs, and the outer cascade verifies it exactly as before.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    for (const outcome of outcomes) {
      expect(runEventKinds(h, outcome.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
    }
  })

  test('a child settled by its own nested decomposition is adopted, not verified a second time', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async (sessionId) => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId)
    })

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('splittable child', { decomposable: true }),
        childSpec('downstream', { dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(outcomes[0]!.evidenceId).toBe(`e-nested-${outcomes[0]!.runId}`)

    const nestedRunId = outcomes[0]!.runId!
    const kinds = runEventKinds(h, nestedRunId)
    expect(kinds).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
    expect(kinds.filter(kind => kind === 'TaskVerifying')).toHaveLength(1)
    expect(h.verifier.verifyRun).not.toHaveBeenCalledWith(STORE, nestedRunId, expect.anything())
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, rootRunId, expect.anything())

    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.runIn(STORE, nestedRunId)).status).toBe('verified')
    // The nested settlement counts as `verified`, so the dependent child still runs.
    expect(runEventKinds(h, outcomes[1]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('verified')
  })

  test('a child that settled itself failed is adopted as failed instead of being marked again', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async (sessionId) => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, 'fail')
    })

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('splittable child', { decomposable: true }),
        childSpec('downstream', { dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    // Only a verified adoption carries the evidence id; the failed run's own
    // evidence still stands in the store.
    expect(outcomes[0]!.evidenceId).toBeUndefined()
    expect((await h.task.snapshotIn(STORE)).evidence
      .filter(item => item.taskRunId === outcomes[0]!.runId)
      .map(item => item.evidenceId))
      .toEqual([`e-nested-${outcomes[0]!.runId}`])
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskFailed'])
    expect(h.verifier.verifyRun).not.toHaveBeenCalledWith(STORE, outcomes[0]!.runId, expect.anything())
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('failed')
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
  })

  test('structural admission failures persist nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('cycle a', { dependsOn: [1] }),
        childSpec('cycle b', { dependsOn: [0] }),
      ],
    })).rejects.toThrow(/cycle/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('abort cancels the in-flight child agent and marks its run cancelled', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const controller = new AbortController()
    h.setIdleBehavior(() => new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    }))

    const pending = h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b', { dependsOn: [0] })],
    }, { signal: controller.signal })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    controller.abort()
    const outcomes = await pending

    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled', 'cancelled'])
    expect(h.cancelled).toHaveLength(1)
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskCancelled'])
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('cancelled')
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('admitted')
  })

  test('a missing verifier fails the started run and rejects with a clear error', async () => {
    const h = harness({ verifier: 'absent' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })).rejects.toThrow(VerifierUnavailableError)

    const snapshot = await h.task.snapshotIn(STORE)
    const started = snapshot.runs.filter(run => run.taskId !== rootTaskId)
    expect(started).toHaveLength(1)
    expect(started[0]!.status).toBe('failed')
    expect(h.spawned).toHaveLength(1)
  })

  test('runForSession rebuilds its index from a replayed store via the graphs service', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness()
    h2.sessions.clear()
    for (const [id, stored] of h.sessions) h2.sessions.set(id, stored)
    const runtime2 = new TaskRuntime(h2.ctx as never)
    const childSession = h.spawned[0]!.sessionId
    const bound = await runtime2.runForSession(childSession)
    expect(bound.task.taskId).toBe(outcomes[0]!.taskId)
    expect(bound.run.sessionId).toBe(childSession)
    expect(h2.graphs.graphForSession).toHaveBeenCalled()
    await expect(runtime2.runForSession('unknown-session')).rejects.toThrow(/no task run/)
  })

  test('passes the graph env checkout path as cwd to the verifier', async () => {
    const h = harness()
    h.ctx.envBuilder = { store: { get: (envId: string) => ({ path: `/fake/env/${envId}` }) } }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), {
      cwd: '/fake/env/env1',
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    })
  })

  test('omits cwd when the env path cannot be resolved', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), { timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS })
  })

  test('hands the configured verify deadline down as the verifier\'s own timeout', async () => {
    const h = harness({ config: { verifyTimeoutMs: 1234 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), { timeoutMs: 1234 })
  })

  test('settles the parent run verified, with its own evidence, once every child verified', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])

    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('verified')
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('verified')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.evidence.some(item => item.taskRunId === rootRunId)).toBe(true)
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified'])
  })

  test('fails the parent run when the verdict on its own criteria fails', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const childVerdict = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId !== rootRunId) return childVerdict(storeId, runId)
      const parent = await h.task.taskIn(storeId, rootTaskId)
      const verifierResults: VerificationResult[] = parent.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'fail' as const,
        verifierId: 'fake-verifier',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: rootTaskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: result.verifierId,
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('failed')
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('failed')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskFailed'])
  })

  test('names the unmet criterion and what the verifier said about it in the failure reason', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const original = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId === rootRunId) return original(storeId, runId)
      const run = await h.task.runIn(storeId, runId)
      const instance = await h.task.taskIn(storeId, run.taskId)
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'inconclusive' as const,
        verifierId: 'fake-verifier',
        details: 'timeout after 600000ms',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: instance.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: result.verifierId,
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    expect(outcomes[0]!.status).toBe('failed')
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual(['mandatory criteria not satisfied: ac1-1 inconclusive (timeout after 600000ms)'])
  })

  test('a verification that times out fails its run once and no late verdict can land on it', async () => {
    const h = harness({ verifier: 'timeout' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    const childRunId = outcomes[0]!.runId!
    expect(outcomes[0]!.status).toBe('failed')
    expect((await h.task.runIn(STORE, childRunId)).status).toBe('failed')
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed'])
    expect((await h.task.snapshotIn(STORE)).evidence.filter(item => item.taskRunId === childRunId)).toHaveLength(0)
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === childRunId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual([`task-runtime: verification of run "${childRunId}" timed out after 615000ms (verifier deadline 600000ms + 15000ms safety margin)`])

    // The abandoned verification is not gone: it settles late, carrying a pass
    // for a run that is already failed. The store refuses it, so the evidence
    // trail can never contradict the run's terminal state.
    const criterionId = (await h.task.taskIn(STORE, outcomes[0]!.taskId)).acceptanceCriteria[0]!.criterionId
    const late: EvidenceBundle = {
      evidenceId: 'late-evidence',
      taskRunId: childRunId,
      taskId: outcomes[0]!.taskId,
      artifacts: [],
      verifierResults: [{ criterionId, status: 'pass', verifierId: 'fake-verifier', exitCode: 0 }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }
    await expect(h.task.recordEvidenceIn(STORE, late, 'fake-verifier')).rejects.toThrow(
      `task: run "${childRunId}" is failed; evidence can only be recorded while the run is running`,
    )
    expect((await h.task.snapshotIn(STORE)).evidence.filter(item => item.taskRunId === childRunId)).toHaveLength(0)
    expect((await h.task.runIn(STORE, childRunId)).status).toBe('failed')
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed'])
  })

  test('cancels the parent run when the caller aborts the cascade', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const controller = new AbortController()
    h.setIdleBehavior(() => new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    }))

    const pending = h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    }, { signal: controller.signal })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    controller.abort()
    await pending

    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskCancelled'])
  })
})
