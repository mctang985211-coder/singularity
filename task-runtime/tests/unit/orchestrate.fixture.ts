import { TASK_GUIDANCE } from '../support/skill-roots.ts'
import { afterEach, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, EvidenceBundle, TaskEvent, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import { CompositeVerifier } from '../../../verifier/src/composite-verifier.ts'
import { requestedSession } from '../support/person-request.ts'
import { DEPLOYMENT_MCP_SERVERS } from '../../../tests/support/mcp-servers.ts'
import { releaseSkillHomes } from '../support/skill-roots.ts'
import type { Config, DecomposeSpec, ChildOutcome, RootContractSpec } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'

export const ROOT_SESSION = 'root-session'

export const STORE = rootTaskStoreId(ROOT_SESSION)

afterEach(releaseSkillHomes)

export interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

export interface SpawnCall {
  sessionId: string
  name: string
  /**
   * The message the spawn carried, when it carried one. A task worker's spawn
   * carries none (A2): its contract and state are the context assembly's, and the
   * agent runtime fills the default kickoff.
   */
  prompt?: string
  /** Whether the spawn declared the child a task worker (`SpawnRequest.taskWorker`). */
  taskWorker?: boolean
  agentPreset?: string
  permissionPreset?: string
  /** The working directory the spawn named for the worker, when it named one (a replay in a caller-named workspace). */
  cwd?: string
  /**
   * The model selection the spawn was created under, when it named one (S4-E: a
   * replay's frozen experiment binding, inherited by its sub-execution).
   */
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
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

export function harness(
  options: {
    config?: Partial<Config>
    verifier?: 'pass' | 'by-objective' | 'timeout' | 'absent' | 'real-composite'
    spawnError?: string
  } = {},
  sharedSessions?: Map<string, StoredSession>,
) {
  const sessions = sharedSessions ?? new Map<string, StoredSession>()
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10), so an intake here stands on a
  // request somebody made rather than on a session nobody ever spoke to. The rule
  // is the *existence* of a user-sourced message, so one text stands for it; the
  // shared map keeps it across a restart, as a durable log does.
  if (!sessions.has(ROOT_SESSION)) sessions.set(ROOT_SESSION, requestedSession(ROOT_SESSION, 'ship the release'))
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
  const resumed: string[] = []
  const notifications: { sessionId: string; text: string }[] = []
  /**
   * The messages this process relayed, by session — the stand-in for
   * agent-runtime's own fold. An identity already listed here is `already-present`
   * on a retry, exactly as the real fold answers for a Session that holds it
   * (A4 §F.1 / K1 §2).
   */
  const relayed: { sessionId: string; messageId: string; text: string }[] = []
  /** The agents this process spawned, by session — the registry's live entries. */
  const liveAgents = new Map<string, unknown>()
  let idleBehavior: ((sessionId: string) => Promise<void>) | undefined
  const parentAgent = {
    id: ROOT_SESSION,
    status: 'idle',
    followup: (message: { content: readonly { text?: string }[] }) => {
      notifications.push({
        sessionId: ROOT_SESSION,
        text: message.content.map(block => block.text ?? '').join('\n'),
      })
    },
    steer: (message: { id: string; content: readonly { text?: string }[] }) => {
      if (relayed.some(item => item.messageId === message.id))
        throw new Error(`message "${message.id}" is already pending`)
      relayed.push({
        sessionId: ROOT_SESSION,
        messageId: message.id,
        text: message.content.map(block => block.text ?? '').join('\n'),
      })
    },
    cancel: vi.fn(() => {}),
  }
  const agentRuntime = {
    resumeWorkerAgent: vi.fn(async (request: { sessionId: string }) => {
      resumed.push(request.sessionId)
      const agent = {
        id: request.sessionId,
        cancel: () => {},
        followup: (message: { content: readonly { text?: string }[] }) => {
          notifications.push({
            sessionId: request.sessionId,
            text: message.content.map(block => block.text ?? '').join('\n'),
          })
        },
      }
      liveAgents.set(request.sessionId, agent)
      return { agent, dispose: async () => {} }
    }),
    spawn: vi.fn(
      async (
        _parent: unknown,
        request: {
          sessionId: string
          name: string
          prompt?: Array<{ type: 'text'; text: string }>
          contract?: string
          taskWorker?: boolean
          agentPreset?: string
          permissionPreset?: string
          cwd?: string
          agentOptions?: SpawnCall['agentOptions']
          grant?: SpawnCall['grant']
        },
      ) => {
        if (options.spawnError !== undefined) throw new Error(options.spawnError)
        spawned.push({
          sessionId: request.sessionId,
          name: request.name,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt.map(block => block.text).join('\n') }),
          // A delegated child is spawned as a task worker (A2): the request carries
          // no prompt and no contract text of its own — the contract is the context
          // assembly's, read from the store at each model request.
          ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
          ...(request.permissionPreset === undefined ? {} : { permissionPreset: request.permissionPreset }),
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
          ...(request.grant === undefined ? {} : { grant: request.grant }),
        })
        // `cancel` converges the agent to idle, as the real loop's does: a worker
        // that is mid-turn when the batch is cancelled resolves its idle wait, and
        // the wait that saw the abort reports it (A3 §3.7).
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
                // A behaviour that throws must reach the driver as a failed worker, as
                // the old whenIdle did — swallowing it here would hide the failure the
                // run is supposed to report.
                void (idleBehavior ?? defaultIdle)(request.sessionId).then(resolve, reject)
              }),
          ),
          followup: (message: { content: readonly { text?: string }[] }) => {
            notifications.push({
              sessionId: request.sessionId,
              text: message.content.map(block => block.text ?? '').join('\n'),
            })
          },
          steer: (message: { id: string; content: readonly { text?: string }[] }) => {
            if (relayed.some(item => item.messageId === message.id))
              throw new Error(`message "${message.id}" is already pending`)
            relayed.push({
              sessionId: request.sessionId,
              messageId: message.id,
              text: message.content.map(block => block.text ?? '').join('\n'),
            })
          },
        }
        liveAgents.set(request.sessionId, agent)
        return { agent, dispose: vi.fn(async () => {}) }
      },
    ),
    /**
     * The relay the batch-end message rides (K1 §2): `delivered` the first time,
     * `already-present` when the target's own fold holds the identity, and
     * `unavailable` for a session with no live agent — the three answers the
     * real handle gives.
     */
    ensureAgentMessageDelivered: vi.fn(async (intent: { targetSessionId: string; messageId: string; text: string }) => {
      const live = intent.targetSessionId === ROOT_SESSION || liveAgents.has(intent.targetSessionId)
      if (!live) return { messageId: intent.messageId, status: 'unavailable' as const }
      if (relayed.some(item => item.messageId === intent.messageId)) {
        return { messageId: intent.messageId, status: 'already-present' as const }
      }
      ;(intent.targetSessionId === ROOT_SESSION
        ? parentAgent
        : (liveAgents.get(intent.targetSessionId) as { steer: (m: unknown) => void })
      ).steer({ id: intent.messageId, content: [{ text: intent.text }] })
      return { messageId: intent.messageId, status: 'delivered' as const }
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
        throw new Error(
          `task-runtime: verification of run "${runId}" timed out after 615000ms (verifier deadline 600000ms + 15000ms safety margin)`,
        )
      }
      const run = await taskService.runIn(storeId, runId)
      const instance = await taskService.taskIn(storeId, run.taskId)
      const verdict: VerificationResult['status'] =
        options.verifier === 'by-objective' && instance.objective.includes('fail-me') ? 'fail' : 'pass'
      // The `real-composite` mode routes composite-mode criteria to the real
      // CompositeVerifier against the real store, so a parent's childEvidence
      // map is judged by the code that ships, not by a stand-in.
      const verifierResults: VerificationResult[] = []
      for (const criterion of instance.acceptanceCriteria) {
        if (options.verifier === 'real-composite' && criterion.verificationMode === 'composite') {
          const [compositeResult] = await new CompositeVerifier(taskService).verifyIn(storeId, {
            taskId: instance.taskId,
            runId,
            criteria: [criterion],
            cwd: '/unused',
            logDir: '/unused',
          })
          verifierResults.push(compositeResult!)
        } else {
          verifierResults.push({ criterionId: criterion.criterionId, status: verdict, verifierId: 'fake-verifier' })
        }
      }
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

  const listeners = new Map<string, Set<(...args: never[]) => unknown>>()
  const ctx: Record<string, unknown> = {
    reflect: { provide: () => {} },
    provide: () => {},
    effect: (execute: () => unknown) => {
      const value = execute()
      if (typeof value === 'function') disposers.push(value as () => unknown)
    },
    // A real event bus, small as it is: the runtime's run watcher rides
    // `task/change` (A3 §3.1), and a harness whose `on` swallowed every
    // subscription would test a watcher that never fires.
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
    agents: {
      // Every session resolves to a live agent once spawned, as the real
      // `agents` registry does (`agent-runtime/src/index.ts` creates them):
      // the nested runtime-split tests call `decomposeAndRun` as a *child's*
      // own worker would, and that call resolves the caller's agent before
      // spawning grandchildren. A session this process never spawned (a worker
      // from a previous process) has no agent, which is what the recovery path
      // reads.
      get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : liveAgents.get(sessionId)),
    },
    graphs,
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  if (options.verifier !== 'absent') ctx.verifier = verifier
  const runtime = new TaskRuntime(ctx as never, {
    mcpServers: DEPLOYMENT_MCP_SERVERS, ...options.config,
    capabilities: { ...TASK_GUIDANCE, ...options.config?.capabilities },
  })
  /**
   * The shipped worker behaviour under A3: a worker hands its result in through
   * the explicit submission entry and *then* goes idle. An idle session is not a
   * completion (§3.1), so a harness whose workers merely went idle would be
   * waiting for a deadline on every ordinary-path case instead.
   */
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
    resumed,
    cancelled,
    notifications,
    relayed,
    graphs,
    setIdleBehavior: (behavior: (sessionId: string) => Promise<void>) => {
      idleBehavior = behavior
    },
  }
}

export type Harness = ReturnType<typeof harness>

export function childSpec(objective: string, overrides: Record<string, unknown> = {}) {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    ...overrides,
  } as NonNullable<DecomposeSpec['children']>[number]
}

/**
 * Activate one root through the real intake entry (A0 §1.2–§1.4) and hand back
 * what it became. These cases are about what happens *after* a root exists — the
 * orchestration of its batches — so the contract is the test's own fixture, and
 * it is stated here rather than assumed: a root contract must carry at least one
 * mandatory criterion judged by something other than the composite conjunction,
 * which is exactly what the old fixed spec did not.
 */
export function rootContract(objective: string): RootContractSpec {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

export async function createRoot(
  h: Harness,
  objective = 'ship the release',
): Promise<{ taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract(objective))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { taskId: activated.taskId, runId: activated.runId }
}

/**
 * Admit a batch and wait for it to settle: the runtime's `decomposeAndRun`
 * returns as soon as the batch is committed (§3.1), so a test that asserts on
 * outcomes asks for them through `awaitBatch` — or, when the store is the thing
 * under test, reads the store itself.
 */
export async function decomposeAndSettle(
  h: Harness,
  ...args: Parameters<TaskRuntime['decomposeAndRun']>
): Promise<ChildOutcome[]> {
  const { batchId } = await h.runtime.decomposeAndRun(...args)
  return await h.runtime.awaitBatch(args[0], batchId)
}

/**
 * The parent's own submission (K1 §2): a batch end hands the run back `active`,
 * and *only* this call starts the parent's acceptance — the runtime submits
 * nothing on the parent's behalf. Returns the status the run settled as.
 */
export async function submitParentResult(h: Harness, sessionId: string = ROOT_SESSION): Promise<string> {
  return (await h.runtime.submitResult(sessionId, { summary: 'the parent reports what its batch delivered' })).status
}

/**
 * Stand-in for a nested cascade settling a child: the child's own worker
 * decomposed, so its run walks verifying → evidence → verified/failed before
 * the outer cascade ever looks at it — and the nested cascade writes the run's
 * one review record as it settles its parent run.
 */
export async function settleRunNested(
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
  await task.markRunStatusIn(storeId, taskId, runId, verdict === 'pass' ? 'verified' : 'failed', actor, {
    reason: 'nested verdict',
  })
  await task.recordReviewIn(
    storeId,
    {
      taskId,
      runId,
      sessionId: actor,
      outcome: verdict === 'pass' ? 'verified' : 'failed',
      evidenceRefs: [evidenceId],
      anomalies: [],
      ...(verdict === 'fail' ? { localizedCause: 'nested verdict' } : {}),
    },
    actor,
  )
  return evidenceId
}

/**
 * Seed one upstream product the way the store records it: a producer task's
 * run carrying evidence with the artifact, settled terminal. After P4 a
 * `requiresArtifact` reference is satisfied only by the `verified` outcome —
 * the `failed` outcome's same-named product is an expired reference, and a raw
 * input that merely exists is declared with `acceptsArtifact` instead.
 */
export async function seedProducer(
  h: Harness,
  options: { outcome: 'verified' | 'failed'; kind: string; artifactId?: string },
): Promise<{ taskId: string; runId: string }> {
  const taskId = `t-producer-${options.outcome}`
  const runId = `r-producer-${options.outcome}`
  const status: VerificationResult['status'] = options.outcome === 'verified' ? 'pass' : 'fail'
  await h.task.createTaskIn(
    STORE,
    {
      taskId,
      definitionRef: { taskType: 'producer', version: 1 },
      objective: 'produce the reference product',
      depth: 0,
      acceptanceCriteria: [
        {
          criterionId: 'producer-1',
          description: 'the product exists',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
        },
      ],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    },
    'tester',
  )
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(
    STORE,
    {
      runId,
      taskId,
      sessionId: 's-producer',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      // Born active like every run this build creates (A3 §1.1): a phase-less run
      // is an old record, and admission refuses to decompose under one.
      executionPhase: 'active',
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    'tester',
  )
  await h.task.markRunStatusIn(STORE, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(
    STORE,
    {
      evidenceId: `e-${runId}`,
      taskRunId: runId,
      taskId,
      artifacts: [
        {
          artifactId: options.artifactId ?? `a-${options.kind}`,
          kind: options.kind,
          uri: `products/${options.kind}.jsonl`,
        },
      ],
      verifierResults: [{ criterionId: 'producer-1', status, verifierId: 'fake-verifier' }],
      claims: [
        {
          claimId: `claim-${options.kind}`,
          criterionId: 'producer-1',
          status,
          verifierId: 'fake-verifier',
          artifactRefs: [],
        },
      ],
      generatedAt: new Date().toISOString(),
    },
    'tester',
  )
  await h.task.markRunStatusIn(
    STORE,
    taskId,
    runId,
    options.outcome,
    'tester',
    options.outcome === 'failed' ? { reason: 'the producer failed' } : {},
  )
  return { taskId, runId }
}

/**
 * A parent task authored directly in the store with caller-chosen acceptance
 * criteria — the shape a parent-level evidence map arrives on, since
 * the intake's contract is the caller's own and a stored task's criteria are
 * immutable. Returns the ids the cascade then runs under.
 */
export async function createAcceptanceParent(
  h: Harness,
  acceptanceCriteria: AcceptanceCriterion[],
): Promise<{ taskId: string; runId: string }> {
  await h.task.createStore(STORE)
  const taskId = 't-parent'
  const runId = 'r-parent'
  await h.task.createTaskIn(
    STORE,
    {
      taskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'prove the combination, not only the parts',
      depth: 0,
      acceptanceCriteria,
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    },
    'tester',
  )
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'decomposable' })
  await h.task.startRunIn(
    STORE,
    {
      runId,
      taskId,
      sessionId: ROOT_SESSION,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      // Born active like every run this build creates (A3 §1.1).
      executionPhase: 'active',
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    'tester',
  )
  return { taskId, runId }
}

export function taskEvents(h: Harness): TaskEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => item.data as TaskEvent))
}

/**
 * The status walk of one run: the coordination events ride on the same run but
 * are not part of the lifecycle walk these assertions describe — `RunPhaseChanged`
 * (the phase protocol) and `RunProgressMarked` (the no-progress counter) are read
 * back explicitly where a test is about them.
 */
export function runEventKinds(h: Harness, runId: string): string[] {
  return taskEvents(h)
    .filter(
      item =>
        item.runId === runId &&
        item.kind !== 'HandoffCreated' &&
        item.kind !== 'RunPhaseChanged' &&
        item.kind !== 'RunProgressMarked',
    )
    .map(item => item.kind)
}
