import { describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, TaskEvent, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import type { Config, DecomposeSpec, ChildOutcome } from '../../src/index.ts'
import {
  DEFAULT_ALLOW_RUNTIME_DECOMPOSITION,
  DEFAULT_BUDGET,
  DEFAULT_CAPABILITIES,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_NO_PROGRESS_ROUNDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  TaskRuntime,
  VerifierUnavailableError,
  escalationHint,
  workerBaseline,
} from '../../src/index.ts'
import { WORKER_CONTRACT_OPEN } from '../../src/contract.ts'

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
  contract?: string
  agentPreset?: string
  permissionPreset?: string
  grant?: {
    capabilities: readonly { capability: string; tools: readonly string[]; skills: readonly string[] }[]
    baseline: readonly string[]
    keepPresetTools: boolean
    skillRoots?: readonly string[]
    mcpServers?: readonly {
      serverName: string
      command: string
      args: readonly string[]
      env: Readonly<Record<string, string>>
      cwd: string
      toolCallTimeoutMs?: number
    }[]
  }
}

function harness(options: { config?: Partial<Config>; verifier?: 'pass' | 'by-objective' | 'timeout' | 'absent'; spawnError?: string } = {}) {
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
      contract?: string
      agentPreset?: string
      permissionPreset?: string
      grant?: SpawnCall['grant']
    }) => {
      if (options.spawnError !== undefined) throw new Error(options.spawnError)
      spawned.push({
        sessionId: request.sessionId,
        name: request.name,
        prompt: request.prompt.map(block => block.text).join('\n'),
        ...(request.contract !== undefined ? { contract: request.contract } : {}),
        ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
        ...(request.permissionPreset !== undefined ? { permissionPreset: request.permissionPreset } : {}),
        ...(request.grant !== undefined ? { grant: request.grant } : {}),
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
    /** The registry listing verifierRef validation consults; mirrors the real registry's built-ins. */
    verifierIds: vi.fn(() => ['command', 'composite', 'review']),
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
    agents: {
      // Every session resolves to a live agent once spawned, as the real
      // `agents` registry does (`agent-runtime/src/index.ts` creates them):
      // the nested runtime-split tests call `decomposeAndRun` as a *child's*
      // own worker would, and that call resolves the caller's agent before
      // spawning grandchildren.
      get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : { id: sessionId }),
    },
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

async function createRoot(h: Harness, objective = 'ship the release') {
  return h.runtime.createRootTask(STORE, { objective, rootSessionId: ROOT_SESSION }, ROOT_SESSION)
}

/**
 * Stand-in for a nested cascade settling a child: the child's own worker
 * decomposed, so its run walks verifying → evidence → verified/failed before
 * the outer cascade ever looks at it — and the nested cascade writes the run's
 * one review record as it settles its parent run.
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
  await task.recordReviewIn(storeId, {
    taskId,
    runId,
    sessionId: actor,
    outcome: verdict === 'pass' ? 'verified' : 'failed',
    evidenceRefs: [evidenceId],
    anomalies: [],
    ...(verdict === 'fail' ? { localizedCause: 'nested verdict' } : {}),
  }, actor)
  return evidenceId
}

/**
 * Stand-in for a `leaf` child's own worker deciding the task is not atomic after
 * all: the child itself calls `decomposeAndRun`, exactly as the `task_decompose`
 * tool does (`agent-singularity/src/tools/task-decompose.ts:80`), and whatever
 * admission answers is captured — the children that ran, or the refusal text.
 *
 * Only the root's direct children (depth 1) act, or the grandchildren a granted
 * call creates would split again and the harness would recurse to the depth cap.
 */
function leafWorkerDecomposition(h: Harness, children: DecomposeSpec['children']) {
  const captured: { outcomes?: ChildOutcome[]; refusal?: string } = {}
  h.setIdleBehavior(async sessionId => {
    const bound = await h.runtime.runForSession(sessionId)
    if (bound.task.depth !== 1) return
    try {
      captured.outcomes = await h.runtime.decomposeAndRun(bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the work turned out not to be atomic',
        children,
      })
    } catch (error) {
      captured.refusal = error instanceof Error ? error.message : String(error)
    }
  })
  return captured
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

describe('TaskRuntime.listCapabilities', () => {
  test('defaults to the built-in registry and hands out a copy', () => {
    const h = harness()
    const listed = h.runtime.listCapabilities()
    expect(listed).toEqual(DEFAULT_CAPABILITIES)
    ;(listed as Record<string, unknown>)['design-chip'] = {}
    expect(h.runtime.listCapabilities()).toEqual(DEFAULT_CAPABILITIES)
  })

  test('reflects a configured registry instead of the code default', () => {
    const h = harness({ config: { capabilities: { research: { skills: ['web'] } } } })
    expect(h.runtime.listCapabilities()).toEqual({ research: { skills: ['web'] } })
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
      expect(runEventKinds(h, outcome.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
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
    expect(runEventKinds(h, outcomes[2]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
  })

  test('the handoff merges declared assumptions with dependency evidence references', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('reference producer'),
        childSpec('downstream', {
          dependsOn: [0],
          assumptions: ['a cycle-accurate reference model exists'],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    const snapshot = await h.task.snapshotIn(STORE)
    const downstream = snapshot.handoffs.find(item => item.childTaskId === outcomes[1]!.taskId)!
    // The merged assumptions are non-empty and name the dependency's evidence
    // id — the reference truth the downstream criteria may rely on (KISS §5.1).
    const evidenceId = outcomes[0]!.evidenceId!
    expect(downstream.assumptions).toEqual([
      'a cycle-accurate reference model exists',
      `dependency evidence "${evidenceId}" is verified and available as a reference`,
    ])
    expect(downstream.relevantEvidence).toEqual([evidenceId])
    // The dependency-free child gets no derived assumptions.
    expect(snapshot.handoffs.find(item => item.childTaskId === outcomes[0]!.taskId)!.assumptions).toEqual([])
  })

  test('a child whose required artifact is missing never spawns: blocked, named in the record, registered as an obligation', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [{
            description: 'cycle-equivalent to the reference on N workloads',
            command: 'true',
            requiresArtifact: ['bemu_trace'],
          }],
        }),
        childSpec('independent'),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked', 'verified'])
    expect(outcomes[0]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(1)
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('blocked')

    const artifactBlocked = taskEvents(h).filter(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[0]!.taskId)
    expect(artifactBlocked).toHaveLength(1)
    expect(artifactBlocked[0]!.kind === 'TaskBlocked' ? artifactBlocked[0]!.payload.reason : undefined)
      .toBe('missing required artifacts: bemu_trace (criterion ac1-1)')

    const snapshot = await h.task.snapshotIn(STORE)
    const records = snapshot.reviews.filter(item => item.taskId === outcomes[0]!.taskId)
    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('blocked')
    expect(records[0]!.runId).toBeUndefined()
    expect(records[0]!.anomalies).toEqual(['missing required artifacts: bemu_trace (criterion ac1-1)'])

    // The missing item is registered as an obligation — a question, not an action.
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.goal).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.goal).toContain(outcomes[0]!.taskId)
    expect(snapshot.obligations[0]!.criterion).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.sourceTaskId).toBe(outcomes[0]!.taskId)
    const obligationEvents = taskEvents(h).filter(item => item.kind === 'ObligationRecorded')
    expect(obligationEvents).toHaveLength(1)
    expect(obligationEvents[0]!.taskId).toBe(outcomes[0]!.taskId)
    // The obligation rides the caller's actor — the same `env.actor` the
    // `TaskBlocked` sibling above is committed with. An actor-less
    // `recordObligationIn` call drops the key from the event envelope entirely,
    // so this equality is what catches that regression.
    expect(obligationEvents[0]!.actor).toBe(ROOT_SESSION)
    expect(obligationEvents[0]!.actor).toBe(artifactBlocked[0]!.actor)

    // The batch settles otherwise; the harness verifier passes the parent's
    // composite criterion unconditionally (the real composite verifier's
    // unverified-child failure is covered in the verifier package's own tests).
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('verified')
  })

  test('a required artifact already in the store lets the child run — the stage is legitimately skipped', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // An upstream product already exists (KISS §5.1): seed the store with
    // evidence carrying the artifact kind before the cascade starts.
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: 'e-golden',
      taskRunId: rootRunId,
      taskId: rootTaskId,
      artifacts: [{ artifactId: 'a-trace', kind: 'bemu_trace', uri: 'traces/bemu.jsonl' }],
      verifierResults: [],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 'tester')

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [{
            description: 'cycle-equivalent to the reference on N workloads',
            command: 'true',
            requiresArtifact: ['bemu_trace'],
          }],
        }),
      ],
    })

    expect(outcomes[0]!.status).toBe('verified')
    expect(h.spawned).toHaveLength(1)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.obligations).toHaveLength(0)
    expect(snapshot.reviews.every(item => item.outcome !== 'blocked')).toBe(true)
  })

  test('a capability-gap rejection registers one obligation per missing capability on the parent', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('gap child', { requiredCapabilities: ['no-such-cap'] })],
    })).rejects.toThrow(/capability gap/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.sourceTaskId).toBe(rootTaskId)
    expect(snapshot.obligations[0]!.goal).toContain('"no-such-cap"')
    expect(snapshot.obligations[0]!.criterion).toContain('"no-such-cap"')
    expect(taskEvents(h).map(item => item.kind)).toContain('ObligationRecorded')
  })

  test('a spawn refusal fails the run with the cause, blocks dependents, and leaves no admitted ghost', async () => {
    const spawnError = 'agent-presets: preset "default" not found (available: standard)'
    const h = harness({ verifier: 'by-objective', spawnError })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h, 'fail-me release')
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('unlucky child'),
        childSpec('downstream', { dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    expect(h.spawned).toHaveLength(0)

    const cause = `spawn failed: ${spawnError}`
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual([cause])
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('failed')

    const snapshot = await h.task.snapshotIn(STORE)
    const reviews = snapshot.reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.outcome).toBe('failed')
    expect(reviews[0]!.localizedCause).toBe(cause)
    expect(reviews[0]!.evidenceRefs).toEqual([])

    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
    expect(snapshot.tasks.every(task => task.status !== 'admitted')).toBe(true)
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('failed')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskFailed', 'ReviewRecorded'])
  })

  test('spawn carries the strictest permission preset the capabilities declare', async () => {
    const h = harness({
      config: {
        capabilities: {
          loose: { permission: 'danger-full-access' },
          strict: { permission: 'workspace-write' },
        },
      },
    })
    h.ctx.permissionPresets = {
      resolve: (name: string) => {
        const specs: Record<string, { sandbox: string; approval: string }> = {
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        }
        const spec = specs[name]
        if (spec === undefined) throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(specs).join(', ')})`)
        return spec
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('audited child', { requiredCapabilities: ['loose', 'strict'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.permissionPreset).toBe('workspace-write')
  })

  test('spawn omits the permission preset when no capability declares one', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.permissionPreset).toBeUndefined()
  })

  test('spawn carries the grant its manifest resolves to: declared tools and skills, the worker baseline', async () => {
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned[0]!.grant).toEqual({
      capabilities: [{ capability: 'design-ball', tools: ['read', 'write', 'edit'], skills: ['ball-align'] }],
      baseline: workerBaseline(),
      keepPresetTools: false,
    })
    // The prompt's own needs are in the baseline the grant forwards.
    expect(h.spawned[0]!.grant!.baseline).toContain('bash')
    expect(h.spawned[0]!.grant!.baseline).toContain('task_decompose')
  })

  test('spawn carries the contract as a marked block, separate from the prompt the worker starts from', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child')],
    })

    const call = h.spawned[0]!
    const contract = call.contract
    expect(contract, 'the cascade must hand a contract to the spawn').toBeDefined()
    // The block is marked and carries the store's own facts: the objective, the
    // admission-assigned criterion id with the command a verifier will run, and
    // the task id the terminal states are recorded against.
    expect(contract).toContain(WORKER_CONTRACT_OPEN)
    expect(contract).toContain('<worker-contract task="')
    expect(contract).toContain('ball child')
    expect(contract).toContain('| ac1-1 | deterministic | yes | ball child works | true |')
    expect(contract).toContain('`task_read` reads the same store')
    // It rides its own channel: the prompt is not the contract and the contract
    // is not the prompt, so a fold that shadows one leaves the other.
    expect(contract).not.toBe(call.prompt)
    expect(contract!.length).toBeLessThan(call.prompt.length)
  })

  test('a child with no capabilities still carries the baseline grant', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(h.spawned[0]!.grant).toEqual({ capabilities: [], baseline: workerBaseline(), keepPresetTools: false })
  })

  test('the preset tool plane stays only for a capability that names its own preset', async () => {
    const h = harness({
      config: { capabilities: { 'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' } } },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('verify child', { requiredCapabilities: ['verify-ball-functional'] })],
    })

    expect(h.spawned[0]!.grant!.keepPresetTools).toBe(true)
    expect(h.spawned[0]!.grant!.capabilities).toEqual([
      { capability: 'verify-ball-functional', tools: [], skills: ['verify'] },
    ])
  })

  test('an unknown tool label rejects the whole batch before anything is persisted or spawned', async () => {
    const h = harness({ config: { capabilities: { typo: { tools: ['filesytem'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)

    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('typo child', { requiredCapabilities: ['typo'] })],
    })).rejects.toThrow(/capability "typo" declares unknown tool label "filesytem"; known labels: /)

    expect(h.spawned).toHaveLength(0)
    // Admission rejected before `decomposeIn`: the root is still undecomposed and alone in the store.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]!.decompositionStatus).toBe('decomposable')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('running')
  })

  test('an unknown capability permission preset fails the run before spawn, naming the preset and capability', async () => {
    const h = harness({ config: { capabilities: { audited: { permission: 'nope' } } } })
    h.ctx.permissionPresets = {
      resolve: (name: string) => {
        throw new Error(`permission: unknown preset "${name}" (known: workspace-write, danger-full-access)`)
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('audited child', { requiredCapabilities: ['audited'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    expect(h.spawned).toHaveLength(0)

    const cause = 'spawn failed: task-runtime: permission declared by capabilities [audited] is not usable: '
      + 'permission: unknown preset "nope" (known: workspace-write, danger-full-access)'
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual([cause])
    const reviews = (await h.task.snapshotIn(STORE)).reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.localizedCause).toBe(cause)
  })

  test('a dangling capability preset fails the run before spawn, naming the preset and its capability', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'ghost' } } } })
    h.ctx.agentPresets = {
      resolve: async (id?: string) => {
        throw new Error(`agent-presets: preset "${id}" not found (available: standard)`)
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('research child', { requiredCapabilities: ['research'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    expect(h.spawned).toHaveLength(0)

    const cause = 'spawn failed: task-runtime: preset "ghost" granted by capabilities [research] is not mountable: agent-presets: preset "ghost" not found (available: standard)'
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual([cause])
    const reviews = (await h.task.snapshotIn(STORE)).reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.localizedCause).toBe(cause)
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
    // The leaf worker is not told it was admitted to split — but with the
    // runtime-decomposition switch on (the default) it is told the door is open.
    expect(h.spawned[1]!.prompt).toContain('call `task_decompose` yourself')

    // A declaration is not a gap: with no nested decomposition the child still
    // runs, and the outer cascade verifies it exactly as before.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    for (const outcome of outcomes) {
      expect(runEventKinds(h, outcome.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
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
    expect(kinds).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
    expect(kinds.filter(kind => kind === 'TaskVerifying')).toHaveLength(1)
    expect(h.verifier.verifyRun).not.toHaveBeenCalledWith(STORE, nestedRunId, expect.anything())
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, rootRunId, expect.anything())

    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.runIn(STORE, nestedRunId)).status).toBe('verified')
    // The nested settlement counts as `verified`, so the dependent child still runs.
    expect(runEventKinds(h, outcomes[1]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
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
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskFailed', 'ReviewRecorded'])
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

  test('refuses a batch above the configured maxChildren, naming the limit, and persists nothing', async () => {
    const h = harness({ config: { maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b'), childSpec('task c')],
    })).rejects.toThrow(/admission rejected decomposition of "[^"]+":\n- task "[^"]+" would have 3 children, above maxChildren 2/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('admits a batch exactly at the configured maxChildren', async () => {
    const h = harness({ config: { maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
  })

  test('refuses children that would exceed the configured maxDepth, naming the limit', async () => {
    const h = harness({ config: { maxDepth: 0 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })).rejects.toThrow(/children would exceed maxDepth 0 \(depth 1\)/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('caps an unconfigured deployment at the shipped guardrails: maxDepth 4, maxChildren 8', async () => {
    expect(DEFAULT_MAX_DEPTH).toBe(4)
    expect(DEFAULT_MAX_CHILDREN).toBe(8)
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: Array.from({ length: 9 }, (_value, index) => childSpec(`task ${index}`)),
    })).rejects.toThrow(/would have 9 children, above maxChildren 8/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('a deployment that configures nothing admits a leaf worker\'s own decomposition: the grandchild verifies and the parent adopts it', async () => {
    expect(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION).toBe(true)
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [childSpec('piece one'), childSpec('piece two', { dependsOn: [0] })])

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    // The parent predicted one worker and admitted it `leaf`; the node decided
    // otherwise and its own batch was admitted under the same rules.
    const childTaskId = outcomes[0]!.taskId
    const childRunId = outcomes[0]!.runId!
    expect((await h.task.taskIn(STORE, childTaskId)).decompositionStatus).toBe('decomposed')
    expect(nested.refusal).toBeUndefined()
    expect(nested.outcomes!.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    // The worker that was told it could split is the one that split.
    expect(h.spawned[0]!.prompt).toContain('call `task_decompose` yourself')
    expect(h.spawned[0]!.prompt).not.toContain('## This task is decomposable')

    const snapshot = await h.task.snapshotIn(STORE)
    const grandchildren = snapshot.tasks.filter(task => task.parentTaskId === childTaskId)
    expect(grandchildren.map(task => [task.depth, task.status])).toEqual([[2, 'verified'], [2, 'verified']])
    expect(snapshot.tasks).toHaveLength(4)

    // The nested cascade settled the child's run; the outer round adopts it
    // instead of verifying it a second time.
    expect(outcomes[0]!.status).toBe('verified')
    expect(outcomes[0]!.evidenceId).toBe(`e-${childRunId}`)
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, childRunId, expect.anything())
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('verified')
  })

  test('a leaf worker that overreaches is refused by the batch limit, and the refusal names the limit, not the leaf rule', async () => {
    const h = harness({ config: { allowRuntimeDecomposition: true, maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [
      childSpec('piece one'),
      childSpec('piece two'),
      childSpec('piece three'),
    ])

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(nested.outcomes).toBeUndefined()
    expect(nested.refusal).toMatch(/admission rejected decomposition of "[^"]+":\n- task "[^"]+" would have 3 children, above maxChildren 2/)
    expect(nested.refusal).not.toMatch(/admitted as leaf/)
    // Nothing the refused batch planned was persisted, and the child still ran.
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(2)
    expect(h.spawned).toHaveLength(1)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('with the switch off the same leaf worker is refused and told the switch is what blocked it', async () => {
    const h = harness({ config: { allowRuntimeDecomposition: false } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [childSpec('piece one')])

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(nested.refusal).toMatch(
      /decomposition is not allowed: it is admitted as leaf and runtime decomposition is off \(allowRuntimeDecomposition: false\)/,
    )
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(2)
    expect(h.spawned).toHaveLength(1)
    // The worker was never told about the tool, so the refusal is one it could
    // not have avoided — which is what the switch-off prompt owes it.
    expect(h.spawned[0]!.prompt).not.toContain('task_decompose')
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('abort cancels the in-flight child and blocks the siblings it never started', async () => {
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

    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled', 'blocked'])
    expect(h.cancelled).toHaveLength(1)
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskCancelled', 'ReviewRecorded'])
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('cancelled')

    // The child the batch never started has no run to cancel, so it lands as a
    // runless blocked task with its own review record naming the cancellation —
    // never a ghost left admitted for the parent's composite cause to name.
    const neverStarted = outcomes[1]!.taskId
    expect(outcomes[1]!.runId).toBeUndefined()
    expect((await h.task.taskIn(STORE, neverStarted)).status).toBe('blocked')
    const blockedEvents = taskEvents(h).filter(item => item.kind === 'TaskBlocked' && item.taskId === neverStarted)
    expect(blockedEvents).toHaveLength(1)
    expect(blockedEvents[0]!.kind === 'TaskBlocked' ? blockedEvents[0]!.payload.reason : undefined)
      .toBe('cancelled by the caller before this child started')

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.every(task => task.status !== 'admitted')).toBe(true)
    const runless = snapshot.reviews.filter(item => item.taskId === neverStarted)
    expect(runless).toHaveLength(1)
    expect(runless[0]!.runId).toBeUndefined()
    expect(runless[0]!.outcome).toBe('blocked')
    expect(runless[0]!.anomalies).toEqual(['cancelled by the caller before this child started'])
    expect(runless[0]!.blockedBy).toEqual([{ taskId: outcomes[0]!.taskId, outcome: 'cancelled' }])
  })

  test('an abort before the first child starts blocks the whole batch instead of leaving it admitted', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const controller = new AbortController()
    controller.abort()

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    }, { signal: controller.signal })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked', 'blocked'])
    expect(h.spawned).toHaveLength(0)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.every(task => task.status !== 'admitted')).toBe(true)
    expect(snapshot.tasks.filter(task => task.taskId !== rootTaskId).every(task => task.status === 'blocked')).toBe(true)
    expect(snapshot.reviews.filter(item => item.runId === undefined)).toHaveLength(2)
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
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

  test('binds capability-granted MCP servers onto the spawn grant, resolved against the graph env', async () => {
    const h = harness({ config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } } })
    h.ctx.envBuilder = {
      store: {
        get: (envId: string) => ({
          path: `/fake/env/${envId}`,
          components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
        }),
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    const grant = h.spawned[0]!.grant!
    expect(grant.capabilities).toEqual([{ capability: 'check-ball-registration', tools: [], skills: ['check'] }])
    expect(grant.mcpServers).toEqual([{
      serverName: 'bbdev',
      command: '/fake/env/env1/fork/buckyball/scripts/claude/run_mcp_server.sh',
      args: [],
      env: {},
      cwd: '/fake/env/env1/fork/buckyball',
    }])
    // the run record carries the mcp marker alongside the granted skill
    const run = await h.task.runIn(STORE, outcomes[0]!.runId!)
    expect(run.capabilitySnapshot).toEqual(['check', 'mcp:bbdev'])
  })

  test('a capability-granted MCP server with no env binding fails the spawn loudly and settles the run failed', async () => {
    const h = harness({ config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } } })
    // no envBuilder in the context: the binding resolves to undefined
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('failed')
    expect(h.spawned).toHaveLength(0)
    const task = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(task.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)
    expect(record!.localizedCause).toContain('spawn failed: task-runtime: MCP server "bbdev" needs an env binding')
  })

  test('an env without the bound repo fails the spawn, naming the repo and the env root', async () => {
    const h = harness({ config: { capabilities: { 'check-ball-registration': { mcpServers: ['bbdev'] } } } })
    h.ctx.envBuilder = { store: { get: (envId: string) => ({ path: `/fake/env/${envId}`, components: [] }) } }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)
    expect(record!.localizedCause).toContain('binds {repoRoot:buckyball} but this run\'s env (/fake/env/env1) has no "buckyball" checkout')
  })

  test('a capability without MCP servers never consults the env binding', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a', { requiredCapabilities: ['design-ball'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    expect(h.spawned[0]!.grant!.mcpServers).toBeUndefined()
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
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
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
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskFailed', 'ReviewRecorded'])
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
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed', 'ReviewRecorded'])
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
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed', 'ReviewRecorded'])
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
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskCancelled', 'ReviewRecorded'])
  })
})


describe('TaskRuntime budget (KISS §5, VRTC plan 1.3)', () => {
  test('an unconfigured deployment resolves the shipped budget and no-progress defaults', () => {
    expect(DEFAULT_BUDGET).toEqual({ maxToolCalls: 150, wallTimeMs: 2 * 60 * 60 * 1000, attempts: 1 })
    expect(DEFAULT_NO_PROGRESS_ROUNDS).toBe(3)
    const h = harness()
    expect(h.runtime.budget).toEqual(DEFAULT_BUDGET)
    expect(h.runtime.noProgressRounds).toBe(3)

    const custom = harness({ config: { budget: { wallTimeMs: 1000 }, noProgressRounds: 5 } })
    expect(custom.runtime.budget).toEqual({ ...DEFAULT_BUDGET, wallTimeMs: 1000 })
    expect(custom.runtime.noProgressRounds).toBe(5)
  })

  test('a worker that outlasts its wall-clock budget is cancelled and fails with the budget named, not a criteria failure', async () => {
    const h = harness({ config: { budget: { wallTimeMs: 50 } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('stuck child'), childSpec('downstream', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    // The exhausted agent was cancelled — a forced exit, not a silent degrade.
    expect(h.cancelled).toHaveLength(1)
    const reason = [
      'budget exhausted: wallTimeMs (worker run exceeded its wall-clock limit of 50ms; this is a budget exhaustion, not a criteria failure)',
      `— ${escalationHint(
        'the run cannot finish inside its wall-clock budget',
        'the run was cancelled at the deadline',
        'raise the budget, split the task, or accept the partial result',
      )}`,
    ].join(' ')
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)))
      .toEqual([reason])
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcomes[0]!.runId)
    expect(record!.outcome).toBe('failed')
    expect(record!.localizedCause).toBe(reason)
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
  })

  test('a tool-call count over budget is annotated post-hoc on the terminal record; the verdict stands', async () => {
    const h = harness({ config: { budget: { maxToolCalls: 2 } } })
    // The session log exists only once the run settled — that is exactly why
    // this budget member is a post-hoc check and not in-flight enforcement.
    h.ctx.sessionQuery = {
      readSession: async (sessionId: string) => ({
        events: sessionId === ROOT_SESSION
          ? []
          : Array.from({ length: 3 }, (_value, index) => ({ type: 'tool/call', data: { name: 'bash', callId: `c${index}` } })),
      }),
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('chatty child')],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!
    expect(record.anomalies).toEqual([
      `budget exceeded: maxToolCalls (observed 3 tool calls over the limit 2; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tool calls than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`,
    ])
    // The root session's own log is empty, so the parent record stays clean.
    expect(snapshot.reviews.find(item => item.runId === rootRunId)!.anomalies).toEqual([])
  })

  test('a token total over budget is annotated post-hoc and named session-scoped', async () => {
    const h = harness({ config: { budget: { tokens: 100 } } })
    h.ctx.sessions = { get: (sessionId: string) => ({ id: sessionId }) }
    h.ctx.sessionProjections = {
      snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 60, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('hungry child')],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcomes[0]!.runId)!
    expect(record.anomalies).toEqual([
      `budget exceeded: tokens (observed 110 whole-session tokens over the limit 100; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tokens than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`,
    ])
  })
})


describe('TaskRuntime criterion verifierRef (KISS §4.1, VRTC plan 1.4)', () => {
  test('an unknown verifierRef rejects the whole batch at admission, listing the registered ids, and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('pinned child', {
        acceptanceCriteria: [{ description: 'judged by a pinned verifier', command: 'true', verifierRef: 'ghost' }],
      })],
    })).rejects.toThrow(/admission rejected decomposition of "[^"]+": child 0 criterion "ac1-1" references unknown verifier "ghost"; registered verifiers: command, composite, review/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('a registered verifierRef is admitted, stored on the criterion, and the run verifies as usual', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('pinned child', {
        acceptanceCriteria: [{ description: 'judged by a pinned verifier', command: 'true', verifierRef: 'command' }],
      })],
    })

    expect(outcomes[0]!.status).toBe('verified')
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).acceptanceCriteria[0]!.verifierRef).toBe('command')
  })

  test('a declared verifierRef with no verifier service to validate against fails loudly before anything persists', async () => {
    const h = harness({ verifier: 'absent' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('pinned child', {
        acceptanceCriteria: [{ description: 'judged by a pinned verifier', command: 'true', verifierRef: 'command' }],
      })],
    })).rejects.toThrow(VerifierUnavailableError)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('an unknown verifierRef on a replay contract is rejected before anything persists', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('champion work')],
    })
    expect(outcomes[0]!.status).toBe('verified')

    await expect(h.runtime.replayTask(STORE, outcomes[0]!.taskId, {
      lineage: 'evolution-replay:p-ref',
      spawn: false,
      contract: {
        objective: 'candidate with a pinned judge',
        acceptanceCriteria: [{
          criterionId: 'cd-1',
          description: 'x',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
          verifierRef: 'ghost',
        }],
        requiredCapabilities: [],
      },
    }, ROOT_SESSION)).rejects.toThrow(/admission rejected replay of "[^"]+": child 0 criterion "cd-1" references unknown verifier "ghost"; registered verifiers: command, composite, review/)
  })
})


describe('TaskRuntime unknown-kind feedback (KISS §4.3, VRTC plan 2.1)', () => {
  test('the failure reason tells an untested criterion (unknown: task) apart from a broken judge (unknown: verifier)', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const original = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId === rootRunId) return original(storeId, runId)
      const run = await h.task.runIn(storeId, runId)
      const instance = await h.task.taskIn(storeId, run.taskId)
      const verifierBroken = instance.objective.includes('broken-judge')
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'inconclusive' as const,
        verifierId: 'fake-verifier',
        details: verifierBroken ? 'verifier exploded' : 'timeout after 600000ms',
        unknownKind: (verifierBroken ? 'verifier' : 'task') as 'task' | 'verifier',
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
          verifierId: 'fake-verifier',
          artifactRefs: [],
          unknownKind: result.unknownKind,
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('untested child'), childSpec('broken-judge child')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'failed'])
    const reasonOf = (runId: string) => taskEvents(h)
      .filter(item => item.kind === 'TaskFailed' && item.runId === runId)
      .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined))[0]
    expect(reasonOf(outcomes[0]!.runId!))
      .toBe('mandatory criteria not satisfied: ac1-1 inconclusive [unknown: task — the criterion was never tested] (timeout after 600000ms)')
    expect(reasonOf(outcomes[1]!.runId!))
      .toBe(`mandatory criteria not satisfied: ac2-1 inconclusive [unknown: verifier — the verifier could not judge] ${escalationHint(
        'the verifier "fake-verifier" could not judge criterion "ac2-1"',
        'the criterion was run and the judge itself failed',
        'fix or replace the verifier, then re-verify the criterion',
      )} (verifier exploded)`)

    // The review record carries the kind too, so E3 can be read without the bundle.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!.criteria)
      .toEqual([{ criterionId: 'ac1-1', verdict: 'inconclusive', command: 'true', unknownKind: 'task' }])
    expect(snapshot.reviews.find(item => item.runId === outcomes[1]!.runId)!.criteria)
      .toEqual([{ criterionId: 'ac2-1', verdict: 'inconclusive', command: 'true', unknownKind: 'verifier' }])
  })
})


describe('TaskRuntime.replayTask (evolution replay, W15)', () => {
  /** One verified champion child, spawned with the given capability table. */
  async function champion(h: Harness, objective = 'champion work') {
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec(objective, { requiredCapabilities: ['research'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    return { championTaskId: outcomes[0]!.taskId, championRunId: outcomes[0]!.runId!, rootTaskId }
  }

  test('a capability override applies for the replay run only, and the replay task stands apart from the champion', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId, championRunId } = await champion(h)
    const before = await h.task.taskIn(STORE, championTaskId)

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p1',
      overlay: { capabilityOverrides: { research: { preset: 'other-preset', skills: ['verify'] } } },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    // the spawn saw the override row, not the configured one
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.agentPreset).toBe('other-preset')
    expect(spawn.grant!.capabilities).toEqual([{ capability: 'research', tools: [], skills: ['verify'] }])
    expect(spawn.grant!.keepPresetTools).toBe(true)

    // the replay task is parentless and tagged; the champion is untouched
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.parentTaskId).toBeUndefined()
    expect(replayTask.depth).toBe(0)
    expect(replayTask.objective).toBe('[evolution-replay:p1] champion work')
    expect(replayTask.status).toBe('verified')
    const after = await h.task.taskIn(STORE, championTaskId)
    expect(after).toEqual(before)

    // execution lineage: the replay run descends from the champion run
    const replayRun = await h.task.runIn(STORE, outcome.runId)
    expect(replayRun.parentRunId).toBe(championRunId)
    expect(replayRun.agentPreset).toBe('other-preset')
    expect(replayRun.capabilitySnapshot).toContain('verify')

    // the replay run's review record carries the lineage tag
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.runId === outcome.runId)
    expect(record).toBeDefined()
    expect(record!.outcome).toBe('verified')
    expect(record!.anomalies).toEqual(['evolution-replay:p1'])
    expect(record!.criteria).toHaveLength(1)
    // event walk matches any verified run's
    expect(runEventKinds(h, outcome.runId)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
  })

  test('extra skill roots are forwarded to the worker grant, and the prompt never invites a split', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p2',
      overlay: { extraSkillRoots: ['/sandbox/p2/skills'] },
    }, ROOT_SESSION)
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.skillRoots).toEqual(['/sandbox/p2/skills'])
    // the overlay did not change the capability resolution
    expect(spawn.agentPreset).toBe('standard')
    expect(spawn.prompt).not.toContain('call `task_decompose` yourself')
    expect(spawn.prompt).toContain('[evolution-replay:p2]')
  })

  test('a capability override granting an MCP server binds it against the replay run\'s env', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    h.ctx.envBuilder = {
      store: {
        get: (envId: string) => ({
          path: `/fake/env/${envId}`,
          components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
        }),
      },
    }
    const { championTaskId } = await champion(h)
    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p-mcp',
      overlay: { capabilityOverrides: { research: { preset: 'standard', mcpServers: ['bbdev'] } } },
    }, ROOT_SESSION)
    expect(outcome.status).toBe('verified')
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.mcpServers).toEqual([{
      serverName: 'bbdev',
      command: '/fake/env/env1/fork/buckyball/scripts/claude/run_mcp_server.sh',
      args: [],
      env: {},
      cwd: '/fake/env/env1/fork/buckyball',
    }])
    const replayRun = await h.task.runIn(STORE, outcome.runId)
    expect(replayRun.capabilitySnapshot).toContain('mcp:bbdev')
  })

  test('a presetOverride wins over the capability resolution; absent it, the capability preset stands', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const first = await champion(h)
    await h.runtime.replayTask(STORE, first.championTaskId, {
      lineage: 'evolution-replay:p3',
      overlay: { presetOverride: 'custom-preset' },
    }, ROOT_SESSION)
    expect(h.spawned[h.spawned.length - 1]!.agentPreset).toBe('custom-preset')

    const h2 = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const second = await champion(h2)
    await h2.runtime.replayTask(STORE, second.championTaskId, { lineage: 'evolution-replay:p4' }, ROOT_SESSION)
    expect(h2.spawned[h2.spawned.length - 1]!.agentPreset).toBe('standard')
  })

  test('spawn: false runs the deterministic criteria replay: no worker, the verifier settles the candidate contract', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const spawnedBefore = h.spawned.length

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p5',
      spawn: false,
      contract: {
        objective: 'candidate definition replay',
        acceptanceCriteria: [{
          criterionId: 'cd-1',
          description: 'candidate criterion',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'make candidate',
        }],
        requiredCapabilities: ['research'],
      },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    expect(h.spawned).toHaveLength(spawnedBefore)
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.acceptanceCriteria.map(item => item.criterionId)).toEqual(['cd-1'])
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.criteria).toEqual([{ criterionId: 'cd-1', verdict: 'pass', command: 'make candidate' }])
    expect(record!.anomalies).toEqual(['evolution-replay:p5'])
  })

  test('a failing replay settles failed with the lineage tag and a localized cause', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } }, verifier: 'by-objective' })
    const { championTaskId } = await champion(h, 'champion work')
    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p6',
      contract: {
        objective: 'fail-me candidate',
        acceptanceCriteria: [{
          criterionId: 'cd-1',
          description: 'fails',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'false',
        }],
        requiredCapabilities: ['research'],
      },
      spawn: false,
    }, ROOT_SESSION)

    expect(outcome.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.outcome).toBe('failed')
    expect(record!.localizedCause).toContain('cd-1 fail')
    expect(record!.anomalies).toEqual(['evolution-replay:p6'])
  })

  test('rejects a non-terminal champion, an unknown task, and a capability gap under the overlay', async () => {
    // a still-running root is not a replayable champion
    const running = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { taskId: runningRootId } = await createRoot(running)
    await expect(running.runtime.replayTask(STORE, runningRootId, { lineage: 'evolution-replay:p7' }, ROOT_SESSION))
      .rejects.toThrow(/is running; only a terminal/)

    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    await expect(h.runtime.replayTask(STORE, 't-ghost', { lineage: 'evolution-replay:p7' }, ROOT_SESSION))
      .rejects.toThrow('unknown task "t-ghost"')
    await expect(h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:p7',
      contract: {
        objective: 'gap replay',
        acceptanceCriteria: [{ criterionId: 'cd-1', description: 'x', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
        requiredCapabilities: ['fly-to-moon'],
      },
    }, ROOT_SESSION)).rejects.toThrow(/capability gap \[fly-to-moon\]/)
    // nothing was persisted for the rejected replays
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.filter(task => task.objective.startsWith('[evolution-replay:'))).toHaveLength(0)
  })

  test('a spawn refusal fails the replay run with the cause and the lineage tag', async () => {
    const options: { config?: Partial<Config>; spawnError?: string } = { config: { capabilities: { research: { preset: 'standard' } } } }
    const h = harness(options)
    const { championTaskId } = await champion(h)
    // the spawn seam starts failing after the champion settled
    options.spawnError = 'agent-presets: preset "standard" not found'

    const outcome = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p8' }, ROOT_SESSION)
    expect(outcome.status).toBe('failed')
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.outcome).toBe('failed')
    expect(record!.localizedCause).toBe('spawn failed: agent-presets: preset "standard" not found')
    expect(record!.anomalies).toEqual(['evolution-replay:p8'])
    expect(runEventKinds(h, outcome.runId)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
  })
})
