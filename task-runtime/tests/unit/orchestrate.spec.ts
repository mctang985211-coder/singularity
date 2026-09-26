import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, EvidenceBundle, TaskEvent, TaskInstance, TaskRun, VerificationResult } from '../../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../../task/src/index.ts'
import { sha256Hex } from '../../../task/src/contract.ts'
import { CompositeVerifier } from '../../../verifier/src/composite-verifier.ts'
import { requestedSession } from '../support/person-request.ts'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import type { Config, DecomposeSpec, ChildOutcome, RootContractSpec } from '../../src/index.ts'
import { WorkspaceBusyError, normalizeDecomposition } from '../../src/index.ts'
import type { WorkspaceRegistry } from '../../src/index.ts'
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
  owedBatchResults,
  workerBaseline,
} from '../../src/index.ts'

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

function harness(
  options: { config?: Partial<Config>; verifier?: 'pass' | 'by-objective' | 'timeout' | 'absent' | 'real-composite'; spawnError?: string } = {},
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
      if (relayed.some(item => item.messageId === message.id)) throw new Error(`message "${message.id}" is already pending`)
      relayed.push({
        sessionId: ROOT_SESSION,
        messageId: message.id,
        text: message.content.map(block => block.text ?? '').join('\n'),
      })
    },
    cancel: vi.fn(() => {}),
  }
  const agentRuntime = {
    spawn: vi.fn(async (_parent: unknown, request: {
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
    }) => {
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
        whenIdle: vi.fn(() => new Promise<void>((resolve, reject) => {
          releaseIdle = resolve
          // A behaviour that throws must reach the driver as a failed worker, as
          // the old whenIdle did — swallowing it here would hide the failure the
          // run is supposed to report.
          void (idleBehavior ?? defaultIdle)(request.sessionId).then(resolve, reject)
        })),
        followup: (message: { content: readonly { text?: string }[] }) => {
          notifications.push({
            sessionId: request.sessionId,
            text: message.content.map(block => block.text ?? '').join('\n'),
          })
        },
        steer: (message: { id: string; content: readonly { text?: string }[] }) => {
          if (relayed.some(item => item.messageId === message.id)) throw new Error(`message "${message.id}" is already pending`)
          relayed.push({
            sessionId: request.sessionId,
            messageId: message.id,
            text: message.content.map(block => block.text ?? '').join('\n'),
          })
        },
      }
      liveAgents.set(request.sessionId, agent)
      return { agent, dispose: vi.fn(async () => {}) }
    }),
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
      ;(intent.targetSessionId === ROOT_SESSION ? parentAgent : liveAgents.get(intent.targetSessionId) as { steer: (m: unknown) => void })
        .steer({ id: intent.messageId, content: [{ text: intent.text }] })
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
        throw new Error(`task-runtime: verification of run "${runId}" timed out after 615000ms (verifier deadline 600000ms + 15000ms safety margin)`)
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
      get: (sessionId: string) => (sessionId === ROOT_SESSION ? parentAgent : liveAgents.get(sessionId) ?? { id: sessionId }),
    },
    graphs,
  }
  taskService = new TaskService(ctx as never)
  ctx.task = taskService
  if (options.verifier !== 'absent') ctx.verifier = verifier
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
  /**
   * The shipped worker behaviour under A3: a worker hands its result in through
   * the explicit submission entry and *then* goes idle. An idle session is not a
   * completion (§3.1), so a harness whose workers merely went idle would be
   * testing the no-progress stop on every ordinary-path case instead.
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
    cancelled,
    notifications,
    relayed,
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

/**
 * Activate one root through the real intake entry (A0 §1.2–§1.4) and hand back
 * what it became. These cases are about what happens *after* a root exists — the
 * orchestration of its batches — so the contract is the test's own fixture, and
 * it is stated here rather than assumed: a root contract must carry at least one
 * mandatory criterion judged by something other than the composite conjunction,
 * which is exactly what the old fixed spec did not.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

async function createRoot(h: Harness, objective = 'ship the release'): Promise<{ taskId: string; runId: string }> {
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
async function decomposeAndSettle(
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
async function submitParentResult(h: Harness, sessionId: string = ROOT_SESSION): Promise<string> {
  return (await h.runtime.submitResult(sessionId, { summary: 'the parent reports what its batch delivered' })).status
}

/**
 * The whole conversation one parent has with one batch: admit it, wait for it to
 * end, then hand in the parent's own result. Cases whose subject is the parent's
 * *verdict* use this; cases about the handback itself read
 * {@link decomposeAndSettle} and the batch-end message directly.
 */
async function decomposeSubmitAndSettle(
  h: Harness,
  ...args: Parameters<TaskRuntime['decomposeAndRun']>
): Promise<ChildOutcome[]> {
  const outcomes = await decomposeAndSettle(h, ...args)
  await submitParentResult(h, args[3])
  return outcomes
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
 * Seed one upstream product the way the store records it: a producer task's
 * run carrying evidence with the artifact, settled terminal. After P4 a
 * `requiresArtifact` reference is satisfied only by the `verified` outcome —
 * the `failed` outcome's same-named product is an expired reference, and a raw
 * input that merely exists is declared with `acceptsArtifact` instead.
 */
async function seedProducer(
  h: Harness,
  options: { outcome: 'verified' | 'failed'; kind: string; artifactId?: string },
): Promise<{ taskId: string; runId: string }> {
  const taskId = `t-producer-${options.outcome}`
  const runId = `r-producer-${options.outcome}`
  const status: VerificationResult['status'] = options.outcome === 'verified' ? 'pass' : 'fail'
  await h.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'producer', version: 1 },
    objective: 'produce the reference product',
    depth: 0,
    acceptanceCriteria: [{
      criterionId: 'producer-1',
      description: 'the product exists',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
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
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [{ artifactId: options.artifactId ?? `a-${options.kind}`, kind: options.kind, uri: `products/${options.kind}.jsonl` }],
    verifierResults: [{ criterionId: 'producer-1', status, verifierId: 'fake-verifier' }],
    claims: [{ claimId: `claim-${options.kind}`, criterionId: 'producer-1', status, verifierId: 'fake-verifier', artifactRefs: [] }],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, taskId, runId, options.outcome, 'tester',
    options.outcome === 'failed' ? { reason: 'the producer failed' } : {})
  return { taskId, runId }
}

/**
 * A parent task authored directly in the store with caller-chosen acceptance
 * criteria — the shape a parent-level evidence map arrives on, since
 * the intake's contract is the caller's own and a stored task's criteria are
 * immutable. Returns the ids the cascade then runs under.
 */
async function createAcceptanceParent(
  h: Harness,
  acceptanceCriteria: AcceptanceCriterion[],
): Promise<{ taskId: string; runId: string }> {
  await h.task.createStore(STORE)
  const taskId = 't-parent'
  const runId = 'r-parent'
  await h.task.createTaskIn(STORE, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'prove the combination, not only the parts',
    depth: 0,
    acceptanceCriteria,
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'decomposable' })
  await h.task.startRunIn(STORE, {
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
  }, 'tester')
  return { taskId, runId }
}

/**
 * Stand-in for a `leaf` child's own worker deciding the task is not atomic after
 * all: the child itself calls `decomposeAndRun`, exactly as the `task_decompose`
 * tool does (`agent-singularity/src/tools/task-decompose.ts:80`), and whatever
 * admission answers is captured — the children that ran, or the refusal text.
 *
 * Only the root's direct children (depth 1) act, or the grandchildren a granted
 * call creates would split again and the harness would recurse to the depth cap.
 * A deeper session still has to follow the worker protocol — an idle without a
 * submission is a no-progress stop — so it submits and goes idle like the
 * default behaviour does.
 */
function leafWorkerDecomposition(h: Harness, children: DecomposeSpec['children']) {
  const captured: { outcomes?: ChildOutcome[]; refusal?: string } = {}
  h.setIdleBehavior(async sessionId => {
    const bound = await h.runtime.runForSession(sessionId)
    if (bound.task.depth !== 1) {
      await h.runtime.submitResult(sessionId, { summary: 'done' })
      return
    }
    try {
      captured.outcomes = await decomposeAndSettle(h, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the work turned out not to be atomic',
        children,
      })
      // The nested batch ended and handed the run back `active` (K1 §2): the
      // worker's own result is what settles it now — the runtime no longer
      // submits on its behalf, so a worker that stopped here without submitting
      // would be stopped by the no-progress rule instead.
      await h.runtime.submitResult(sessionId, { summary: 'the split ran; the work continues under the children' })
      return
    } catch (error) {
      captured.refusal = error instanceof Error ? error.message : String(error)
    }
    // The refusal is what the test is about; the worker still owes the protocol
    // a result, or its run would stop on the no-progress rule instead of
    // settling the way the test is describing.
    await h.runtime.submitResult(sessionId, { summary: 'the split was refused; the work was done here' })
  })
  return captured
}

function taskEvents(h: Harness): TaskEvent[] {
  return [...h.sessions.values()].flatMap(stored => stored.events.map(item => item.data as TaskEvent))
}

/**
 * The status walk of one run: the coordination events ride on the same run but
 * are not part of the lifecycle walk these assertions describe — `RunPhaseChanged`
 * (the phase protocol) and `RunProgressMarked` (the no-progress counter) are read
 * back explicitly where a test is about them.
 */
function runEventKinds(h: Harness, runId: string): string[] {
  return taskEvents(h)
    .filter(item => item.runId === runId && item.kind !== 'HandoffCreated'
      && item.kind !== 'RunPhaseChanged' && item.kind !== 'RunProgressMarked')
    .map(item => item.kind)
}

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
    await expect(h.runtime.intakeRootContract(STORE, ROOT_SESSION, {
      objective: 'the goal nobody stated',
      acceptanceCriteria: [{
        criterionId: 'root-children-verified',
        description: 'all mandatory children verified',
        mode: 'composite',
        mandatory: true,
      }],
    })).rejects.toThrow(/requires at least one mandatory acceptance criterion judged by something other than the composite conjunction/)
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
    const runtime2 = new TaskRuntime(h2.ctx as never, {} as Config)
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
    const runtime2 = new TaskRuntime(h2.ctx as never, {} as Config)
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    // A delegated child is a task worker, and the store is where its context
    // comes from (A2): the spawn carries no prompt and no contract text, and the
    // handoff the runtime built for this child is the record the context
    // projection reads back.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()
    const handoff = (await h.task.snapshotIn(STORE)).handoffs.find(
      item => item.childTaskId === outcomes[0]!.taskId,
    )
    expect(handoff?.parentObjective).toBe('ship the release')
    expect(handoff?.reasonForDelegation).toBe('split the work')

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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('fail-me now'),
        childSpec('downstream', { dependsOn: [0] }),
        childSpec('independent'),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked', 'verified'])
    // The outcome names the bundle the run produced, whatever the verdict: since
    // A3 one settlement path writes both, so there is no longer a difference
    // between "failed by the verifier" and "failed on adoption".
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    // The batch ends otherwise, and the parent's own acceptance is its own call
    // (K1 §2): the harness verifier passes the parent's composite criterion
    // unconditionally (the real composite verifier's unverified-child failure is
    // covered in the verifier package's own tests).
    expect(await submitParentResult(h)).toBe('verified')
  })

  test('P4-C: a required artifact from a verified run lets the child run — the stage is legitimately skipped', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // An upstream product already exists (KISS §5.1): a producer task's
    // verified run recorded evidence carrying the artifact kind before the
    // cascade starts. A `requiresArtifact` reference is a verified reference
    // product, so the producing run's terminal state is part of the match.
    await seedProducer(h, { outcome: 'verified', kind: 'bemu_trace' })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    // The child's failure is a fact the parent judges with, never a verdict about
    // the parent: the batch end returns it `active`, and its own submission —
    // judged by the harness verifier, which fails this root's objective — settles
    // it.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('failed')
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.permissionPreset).toBeUndefined()
  })

  test('spawn carries the grant its manifest resolves to: declared tools and skills, the worker baseline', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned[0]!.grant).toEqual({
      capabilities: [{ capability: 'design-ball', tools: ['read', 'write', 'edit'], skills: ['ball-align'] }],
      baseline: workerBaseline(),
      keepPresetTools: false,
      // The grant loads this run's own snapshot of the granted skill (S1-C), so
      // the skill layer registers the admitted bytes rather than whatever stands
      // at the production path when the worker starts.
      skillRoots: [join(home, 'singularity', 'run-bindings', STORE, outcomes[0]!.runId!, 'skills')],
    })
    // The prompt's own needs are in the baseline the grant forwards.
    expect(h.spawned[0]!.grant!.baseline).toContain('bash')
    expect(h.spawned[0]!.grant!.baseline).toContain('task_decompose')
  })

  test('spawn declares the child a task worker and carries no contract text of its own', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child')],
    })

    // A2: the spawn seam hands the worker a role marker, not text. The contract
    // the worker reads is the context assembly's `singularity:worker-contract`
    // section, projected from this store at every model request — asserted
    // end-to-end in `tests/integration/context-assembly.spec.ts` — so the
    // runtime keeps exactly one rendering of a contract (its own store records)
    // and the spawn prompt is no longer a second surface a fold can shadow.
    const call = h.spawned[0]!
    expect(call.taskWorker).toBe(true)
    expect(call.prompt).toBeUndefined()
    expect(call.contract).toBeUndefined()

    // The facts that section is projected from are the store's own: the child
    // task's admission-assigned criterion and the command a verifier will run.
    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.objective).toBe('ball child')
    expect(child.acceptanceCriteria.map(criterion => [criterion.criterionId, criterion.command])).toEqual([['ac1-1', 'true']])
  })

  test('a child with no capabilities still carries the baseline grant', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(h.spawned[0]!.grant).toEqual({ capabilities: [], baseline: workerBaseline(), keepPresetTools: false })
  })

  test('the preset tool plane stays only for a capability that names its own preset', async () => {
    pinSkillHome('verify')
    const h = harness({
      config: { capabilities: { 'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' } } },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('verify child', { requiredCapabilities: ['verify-ball-functional'] })],
    })

    expect(h.spawned[0]!.grant!.keepPresetTools).toBe(true)
    expect(h.spawned[0]!.grant!.capabilities).toEqual([
      { capability: 'verify-ball-functional', tools: [], skills: ['verify'] },
    ])
  })

  test('conflicting presets reject the whole batch without persisting or spawning any child', async () => {
    const h = harness({ config: { capabilities: {
      research: { preset: 'standard' },
      verify: { preset: 'bb-verify' },
    } } })
    const { taskId, runId } = await createRoot(h)
    const before = await h.task.snapshotIn(STORE)
    const eventsBefore = taskEvents(h)
    await expect(decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('valid child', { requiredCapabilities: ['research'] }),
        childSpec('conflicting child', { requiredCapabilities: ['research', 'verify'] }),
      ],
    })).rejects.toThrow(/conflicting capability presets: research -> standard, verify -> bb-verify/)
    expect(h.spawned).toHaveLength(0)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(taskEvents(h)).toEqual(eventsBefore)
  })

  test('an unknown tool label rejects the whole batch before anything is persisted or spawned', async () => {
    const h = harness({ config: { capabilities: { typo: { tools: ['filesytem'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)

    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('typo child', { requiredCapabilities: ['typo'] })],
    })).rejects.toThrow(/capability "typo" declares unknown tool label "filesytem"; known labels: /)

    expect(h.spawned).toHaveLength(0)
    // Admission rejected before anything was written: the root is still undecomposed and alone in the store.
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    // The spawn itself says nothing about decomposition any more (A2): which
    // worker is told what is the context projection's conditional part, driven by
    // the task's `decompositionStatus` and the deployment switch
    // (`context/tests/unit/reads.spec.ts` asserts both), while these spawn
    // requests only declare the child a task worker.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[1]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()

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

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.runIn(STORE, nestedRunId)).status).toBe('verified')
    // The nested settlement counts as `verified`, so the dependent child still runs.
    expect(runEventKinds(h, outcomes[1]!.runId!)).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
    // The parent's own acceptance is its own submission (K1 §2), and it is the
    // call that consults the harness verifier for this run.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('verified')
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, rootRunId, expect.anything())
  })

  test('a child that settled itself failed is adopted as failed instead of being marked again', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async (sessionId) => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, 'fail')
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('splittable child', { decomposable: true }),
        childSpec('downstream', { dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    // The adoption reports the bundle the nested settlement produced, and the run
    // is not verified a second time — the one settlement rule A3 gives every
    // terminal run.
    expect(outcomes[0]!.evidenceId).toBe(`e-nested-${outcomes[0]!.runId}`)
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b'), childSpec('task c')],
    })).rejects.toThrow(/admission rejected decomposition of "[^"]+":\n- task "[^"]+" would have 3 children, above maxChildren 2/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('admits a batch exactly at the configured maxChildren', async () => {
    const h = harness({ config: { maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
  })

  test('refuses children that would exceed the configured maxDepth, naming the limit', async () => {
    const h = harness({ config: { maxDepth: 0 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    // The worker that split was told it could: the deployment switch is what puts
    // that rule in its assembled contract (`context/tests/unit/reads.spec.ts`:
    // "a leaf worker reads the runtime-split rule … when the deployment admits it").
    // The spawn request carries the role marker and no rendering of the rule.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()

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
    // The root's own acceptance waits for the root's own submission (K1 §2).
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('verified')
  })

  test('a leaf worker that overreaches is refused by the batch limit, and the refusal names the limit, not the leaf rule', async () => {
    const h = harness({ config: { allowRuntimeDecomposition: true, maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [
      childSpec('piece one'),
      childSpec('piece two'),
      childSpec('piece three'),
    ])

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(nested.refusal).toMatch(
      /decomposition is not allowed: it is admitted as leaf and runtime decomposition is off \(allowRuntimeDecomposition: false\)/,
    )
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(2)
    expect(h.spawned).toHaveLength(1)
    // Nothing in the spawn invites a split, whatever the switch says (the spawn
    // carries the role marker and no prompt at all) — and the projection the
    // worker reads says nothing about `task_decompose` with the switch off, so the
    // refusal is one it could not have avoided.
    // (`context/tests/unit/reads.spec.ts`: "a leaf worker reads the runtime-split
    // rule … and neither when it does not".)
    expect(h.spawned[0]!.prompt).toBeUndefined()
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('cancelBatch cancels the in-flight child, blocks the siblings it never started, and cancels the parent', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // A worker mid-turn: its idle is a promise only the cancellation ends, which
    // is what "in flight" means for the batch.
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b', { dependsOn: [0] })],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const outcomes = await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)

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
    // The batch's parent run is cancelled by the same settlement — the batch is
    // one cancellation, not one per child.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('cancelled')
  })

  test('an already-aborted admission signal persists nothing at all', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const controller = new AbortController()
    controller.abort()

    // The caller's signal governs admission only (A3 §3.7): an aborted one is a
    // batch that was never admitted, so nothing is persisted and the parent stays
    // free to decide again.
    await expect(h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    }, { signal: controller.signal })).rejects.toThrow(/cancelled before anything was persisted/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
    expect((await h.task.runIn(STORE, rootRunId)).executionPhase).toBe('active')
  })

  test('a missing verifier fails the submitted run and settles the batch by name instead of rejecting', async () => {
    const h = harness({ verifier: 'absent' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // The submission path is where a missing verifier surfaces now: the worker
    // submits, its run cannot be judged, and the batch's failure seam settles the
    // parent and the children that never started — no rejection to a caller that
    // is no longer waiting (A3 §3.1).
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    const snapshot = await h.task.snapshotIn(STORE)
    const started = snapshot.runs.filter(run => run.taskId !== rootTaskId)
    expect(started).toHaveLength(1)
    expect(started[0]!.status).toBe('failed')
    const review = snapshot.reviews.find(item => item.runId === started[0]!.runId)
    expect(review?.localizedCause).toContain('verifier service is not loaded')
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('failed')
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
    expect(h.spawned).toHaveLength(1)
  })

  test('runForSession rebuilds its index from a replayed store via the graphs service', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), { timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS })
  })

  test('binds capability-granted MCP servers onto the spawn grant, resolved against the graph env', async () => {
    pinSkillHome('check')
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    pinSkillHome('check')
    const h = harness({ config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } } })
    // no envBuilder in the context: the binding resolves to undefined
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)
    expect(record!.localizedCause).toContain('binds {repoRoot:buckyball} but this run\'s env (/fake/env/env1) has no "buckyball" checkout')
  })

  test('a capability without MCP servers never consults the env binding', async () => {
    pinSkillHome('ball-align')
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a', { requiredCapabilities: ['design-ball'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    expect(h.spawned[0]!.grant!.mcpServers).toBeUndefined()
  })

  test('hands the configured verify deadline down as the verifier\'s own timeout', async () => {
    const h = harness({ config: { verifyTimeoutMs: 1234 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), { timeoutMs: 1234 })
  })

  test('a batch end hands the parent back active; the parent\'s own submission is what its verifier judges', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])

    // The batch ended and gave execution back: the run is active, nothing is
    // submitted, and the children's facts are in the store.
    const handedBack = await h.task.runIn(STORE, rootRunId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.batchId).toBeUndefined()
    expect(handedBack.status).toBe('running')
    expect(handedBack.submission).toBeUndefined()
    expect((await h.task.taskIn(STORE, rootTaskId)).status).not.toBe('verified')
    expect(h.relayed.filter(item => item.sessionId === ROOT_SESSION)).toHaveLength(1)
    expect(h.relayed[0]!.messageId).toBe(`m-batchend-${handedBack.batches![0]!.batchId}`)
    expect(h.relayed[0]!.text).toContain('task_submit_result')
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted'])

    // Only the parent's own result starts its acceptance, and it is judged by
    // the same verifier as before.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('verified')
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

    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    // A verified child says nothing about the parent's own criteria: the run is
    // active until the parent hands its result in, and that verdict is what
    // fails it here.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('failed')
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

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

  test('cancelGraph settles the parent run and every session of the store', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // A worker mid-turn: the graph cancellation has to stop it, settle it, and
    // settle the parent that was waiting on it (A3 §3.6).
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const childSession = h.spawned[0]!.sessionId

    await h.runtime.cancelGraph(STORE, 'graph removed')
    // Idempotent: the second call has nothing left to do and must not throw.
    await h.runtime.cancelGraph(STORE, 'graph removed')

    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskCancelled', 'ReviewRecorded'])
    const snapshot = await h.task.snapshotIn(STORE)
    const child = snapshot.tasks.find(task => task.taskId !== rootTaskId)!
    expect(child.status).toBe('cancelled')
    // The gate is closed for every session the store owns, so a late write from
    // either session is denied (the tool-gate wiring itself is the runtime
    // integration's; this is the phase bookkeeping it reads).
    await expect(h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)).rejects.toThrow(/not in flight/)
    void childSession
  })
})

/**
 * The content a run is bound to and loads (S1-C stage 3). The claim under test
 * has three parts, and each is asserted where it can be observed: the *record*
 * (read back from the store, not off the writer), the *bytes* (read from the
 * snapshot directory the record names), and the *grant* (the spawn request the
 * worker's skill layer is built from). A run that only recorded a digest while
 * the worker still loaded a mutable production path would pass the first and
 * fail the others.
 */
describe('the content a run is bound to (S1-C)', () => {
  /** The production `SKILL.md` the pinned skill home holds, as the admission pre-check read it. */
  function productionSkill(home: string, name = 'ball-align'): string {
    return join(home, 'skills', name, 'SKILL.md')
  }

  test('a child run records the provider identity it was admitted under and loads its own snapshot of the bytes', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const run = await h.task.runIn(STORE, outcomes[0]!.runId!)
    const binding = run.providerBinding
    if (binding === undefined) throw new Error('the run recorded no provider binding')
    expect(binding.registryRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(binding.mcpServers).toEqual([])
    expect(binding.snapshotRoot).toBe(join(home, 'singularity', 'run-bindings', STORE, run.runId, 'skills'))
    expect(binding.skills).toHaveLength(1)
    const skill = binding.skills[0]!
    expect(skill.name).toBe('ball-align')
    expect(skill.role).toBe('guidance')
    expect(skill.capabilities).toEqual(['design-ball'])
    expect(skill.description).toContain('Align a Buckyball Ball')
    expect(skill.contractDigest).toBeNull()
    expect(skill.uncovered).toEqual([])
    expect(skill.contentDigest).toMatch(/^[0-9a-f]{64}$/)

    // The bytes: the snapshot holds the admitted content, not a copy made later.
    const admitted = await readFile(productionSkill(home), 'utf8')
    const snapshot = await readFile(join(binding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')
    expect(snapshot).toBe(admitted)
    // And the record's own digests describe those bytes: re-reading the snapshot
    // through the runtime reports nothing wrong with it, which is the check a
    // later reader (and `task_read`) performs before trusting the record.
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])

    // The grant: the worker's skill layer is built from the snapshot root.
    expect(h.spawned[0]!.grant!.skillRoots).toEqual([binding.snapshotRoot])

    // The worker's capability names ride its assembled contract, rendered from
    // this same record by the context projection (`context/src/run-binding.ts`,
    // asserted in `context/tests/unit/run-binding.spec.ts` and end-to-end in
    // `tests/integration/context-assembly.spec.ts`); the spawn request itself
    // carries only the role marker.
    expect(binding.capabilities).toContain('design-ball')
    expect(binding.skills.map(skill => skill.name)).toContain('ball-align')
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()
  })

  test('a production rewrite after the run was bound leaves the run\'s bytes alone, and the next run binds the new bytes', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const first = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('first ball child', { requiredCapabilities: ['design-ball'] })],
    })
    const firstBinding = (await h.task.runIn(STORE, first[0]!.runId!)).providerBinding!
    const firstBytes = await readFile(join(firstBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')

    // The evolution-apply shape: the production file is rewritten under a
    // running system. The bound run's snapshot is untouched…
    await writeFile(productionSkill(home), '---\nname: ball-align\ndescription: rewritten purpose\n---\n\nnew body\n')
    expect(await readFile(join(firstBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')).toBe(firstBytes)

    // …and a run admitted afterwards binds the new bytes, recording its own
    // identity: a version change is a new run, never a hot swap of an old one.
    // (A parent decomposes once, so the new admission belongs to its own store —
    // the same deployment, the same pinned skill home.)
    const next = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const secondRoot = await createRoot(next)
    const second = await decomposeAndSettle(next, STORE, secondRoot.taskId, secondRoot.runId, ROOT_SESSION, {
      reason: 'split the work again',
      children: [childSpec('second ball child', { requiredCapabilities: ['design-ball'] })],
    })
    expect(second[0]!.status).toBe('verified')
    const secondBinding = (await next.task.runIn(STORE, second[0]!.runId!)).providerBinding!
    expect(secondBinding.snapshotRoot).not.toBe(firstBinding.snapshotRoot)
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(firstBinding.skills[0]!.contentDigest)
    expect(await readFile(join(secondBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')).toContain('new body')
    expect(next.spawned[0]!.grant!.skillRoots).toEqual([secondBinding.snapshotRoot])
  })

  test('a provider whose bytes moved between admission and the run fails that run by name, with no worker spawned', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // The window is real: the batch is admitted once, and a later child's run
    // starts only after its dependency settled. The production file moves inside
    // that window, so the bytes the admission judged are gone by the time the
    // second run would bind them.
    h.setIdleBehavior(async sessionId => {
      if (sessionId === h.spawned[0]?.sessionId) {
        await writeFile(productionSkill(home), '---\nname: ball-align\ndescription: rewritten during the batch\n---\n\nreplaced\n')
      }
      // Whatever the override does, the worker protocol still applies: the run
      // has to be submitted or it would stop on the no-progress rule.
      await h.runtime.submitResult(sessionId, { summary: 'done' })
    })
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('first ball child', { requiredCapabilities: ['design-ball'] }),
        childSpec('second ball child', { requiredCapabilities: ['design-ball'], dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'failed'])
    // One worker: the second run never reached the spawn.
    expect(h.spawned).toHaveLength(1)
    const snapshot = await h.task.snapshotIn(STORE)
    const failedRun = snapshot.runs.find(run => run.taskId === outcomes[1]!.taskId)!
    expect(failedRun.status).toBe('failed')
    // Nothing is bound by a run that loaded nothing: the failure is named, and
    // the record does not claim content it never materialized.
    expect(failedRun.providerBinding).toBeUndefined()
    const record = snapshot.reviews.find(item => item.taskId === outcomes[1]!.taskId)!
    expect(record.localizedCause).toContain('content binding failed')
    expect(record.localizedCause).toContain('ball-align')
    expect(record.localizedCause).toContain('SKILL.md')
    expect(record.localizedCause).toContain('not the admitted content')
    // Nothing spawned a worker, and nothing was left claiming to have loaded.
    expect(snapshot.evidence.filter(item => item.taskRunId === failedRun.runId)).toEqual([])
    expect(record.outcome).toBe('failed')
  })

  test('the run record groups every matched capability with the providers the admission selected', async () => {
    pinSkillHome('ball-align', 'check')
    const h = harness({
      config: {
        capabilities: {
          'design-ball': { skills: ['ball-align'] },
          'check-ball-registration': { skills: ['check'] },
          'research': { tools: ['filesystem'] },
        },
      },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball', 'check-ball-registration', 'research'] })],
    })

    // The record, not a rendering of it: what the worker's assembled contract is
    // projected from is this run's own binding, and the text that projects it is
    // the context package's (`context/src/run-binding.ts`, asserted in
    // `context/tests/unit/run-binding.spec.ts`).
    const binding = (await h.task.runIn(STORE, outcomes[0]!.runId!)).providerBinding
    if (binding === undefined) throw new Error('the run recorded no provider binding')
    // Every capability the run matched is in the record, including the row that
    // carries no provider skill (its tools are granted without one) and the rows
    // whose skills this deployment pinned — a worker never has to guess a
    // capability name to decompose or delegate.
    expect(binding.capabilities).toEqual(expect.arrayContaining(['design-ball', 'check-ball-registration', 'research']))
    expect(binding.skills.map(skill => [skill.name, skill.role])).toEqual([
      ['ball-align', 'guidance'],
      ['check', 'guidance'],
    ])
    expect(binding.skills.find(skill => skill.name === 'ball-align')?.capabilities).toEqual(['design-ball'])
    // Identity and purpose only: the body is never stored in the record — the
    // worker reads it with the `skill` tool from the snapshot the record names.
    for (const skill of binding.skills) expect(JSON.stringify(skill)).not.toContain('Align a Buckyball Ball across layers')
    expect(binding.snapshotRoot).toBeDefined()
  })
})


describe('TaskRuntime parent acceptance and evidence identity (P4)', () => {
  test('P4-A: a parent AC with a complete childEvidence map verifies once every child verified', async () => {
    const h = harness({ verifier: 'real-composite' })
    const { taskId, runId } = await createAcceptanceParent(h, [{
      criterionId: 'root-combination',
      description: 'the children together prove the root goal',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }, { childIndex: 1 }],
    }])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a'), childSpec('child b')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    // The map is judged against the parent's *own* submission (K1 §2), which is
    // also where the run-level `childIndex` resolution happens.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('verified')
  })

  test('P4-B: a map pointing at a criterion no child has fails the parent, naming the missing item', async () => {
    const h = harness({ verifier: 'real-composite' })
    const { taskId, runId } = await createAcceptanceParent(h, [{
      criterionId: 'root-combination',
      description: 'the children together prove the root goal',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'ac1-9' }],
    }])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a'), childSpec('child b')],
    })

    // Every child verified — the conjunction alone would have passed the parent,
    // and the parent's own submission is what fails it.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    const failed = taskEvents(h).find(item => item.kind === 'TaskFailed' && item.taskId === taskId)
    const reason = failed?.kind === 'TaskFailed' ? failed.payload.reason : undefined
    expect(reason).toContain('root-combination')
    expect(reason).toContain('ac1-9')
  })

  test('P4-C: a same-named product from a failed run does not satisfy requiresArtifact', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await seedProducer(h, { outcome: 'failed', kind: 'bemu_trace' })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('rtl implementation', {
        acceptanceCriteria: [{
          description: 'cycle-equivalent to the reference on N workloads',
          command: 'true',
          requiresArtifact: ['bemu_trace'],
        }],
      })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked'])
    expect(outcomes[0]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(0)
    const blocked = taskEvents(h).find(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[0]!.taskId)
    expect(blocked?.kind === 'TaskBlocked' ? blocked.payload.reason : undefined)
      .toBe('missing required artifacts: bemu_trace (criterion ac1-1)')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.goal).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.criterion).toContain('verified run')
  })

  test('P4-C: acceptsArtifact names a raw input — a product from any run state satisfies it', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await seedProducer(h, { outcome: 'failed', kind: 'bemu_trace' })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [{
            description: 'consumes the golden trace as a raw input',
            command: 'true',
            acceptsArtifact: ['bemu_trace'],
          }],
        }),
        // The raw-input expression is still an existence check: a reference no
        // run ever produced blocks the same way a missing one always did.
        childSpec('dependent consumer', {
          acceptanceCriteria: [{
            description: 'consumes a trace nobody produced',
            command: 'true',
            acceptsArtifact: ['absent_trace'],
          }],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'blocked'])
    expect(h.spawned).toHaveLength(1)
    const blocked = taskEvents(h).find(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[1]!.taskId)
    expect(blocked?.kind === 'TaskBlocked' ? blocked.payload.reason : undefined)
      .toBe('missing required artifacts: absent_trace (criterion ac2-1; raw input, any run state)')
  })

  test('P4-D: a heuristic criterion is not counted as a deterministic pass even when the verdict is pass', async () => {
    const h = harness()
    const { taskId, runId } = await createAcceptanceParent(h, [{
      criterionId: 'root-heuristic',
      description: 'the combination reads as correct to a reviewer',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
      heuristic: true,
    }])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The child verified and the harness verifier passed the parent's
    // criterion; the heuristic label is the only thing standing between that
    // verdict and a deterministic pass — and it holds across the parent's own
    // submission (K1 §2).
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    const failed = taskEvents(h).find(item => item.kind === 'TaskFailed' && item.taskId === taskId)
    const reason = failed?.kind === 'TaskFailed' ? failed.payload.reason : undefined
    expect(reason).toContain('root-heuristic')
    expect(reason).toContain('heuristic')
  })

  test('P4-D: the same parent without the heuristic label verifies — the default is unchanged', async () => {
    const h = harness()
    const { taskId, runId } = await createAcceptanceParent(h, [{
      criterionId: 'root-combination',
      description: 'all mandatory children verified',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
    }])

    await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('verified')
  })

  test('P4-E: a child requiring independent acceptance without a map is refused at admission and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a', { requiresIndependentAcceptance: true })],
    })).rejects.toThrow(/requires independent parent acceptance/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('P4-E: a tampered (malformed) childEvidence map is refused at admission and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a', {
        acceptanceCriteria: [{ description: 'the child works', command: 'true', childEvidence: [{ childIndex: -1 }] }],
      })],
    })).rejects.toThrow(/childEvidence/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('stuck child'), childSpec('downstream', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    // The exhausted agent was cancelled — a forced exit, not a silent degrade.
    expect(h.cancelled).toHaveLength(1)
    const reason = [
      'budget exhausted: wallTimeMs (worker run exceeded its wall-clock budget (50ms from its own startedAt); this is a budget exhaustion, not a criteria failure)',
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    // The root session's own log is empty, so the parent's own record — written
    // when the parent submits its result (K1 §2) — stays clean.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === rootRunId)!.anomalies).toEqual([])
  })

  test('a token total over budget is annotated post-hoc and named session-scoped', async () => {
    const h = harness({ config: { budget: { tokens: 100 } } })
    h.ctx.sessions = { get: (sessionId: string) => ({ id: sessionId }) }
    h.ctx.sessionProjections = {
      snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 60, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
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
    // It also carries the deciding judge since S1-V slice 2, copied off the
    // verifier result — the record names who decided, not only what was decided.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!.criteria)
      .toEqual([{ criterionId: 'ac1-1', verdict: 'inconclusive', verifierId: 'fake-verifier', command: 'true', unknownKind: 'task' }])
    expect(snapshot.reviews.find(item => item.runId === outcomes[1]!.runId)!.criteria)
      .toEqual([{ criterionId: 'ac2-1', verdict: 'inconclusive', verifierId: 'fake-verifier', command: 'true', unknownKind: 'verifier' }])
  })
})


describe('TaskRuntime.replayTask (evolution replay, W15)', () => {
  /** One verified champion child, spawned with the given capability table. */
  async function champion(h: Harness, objective = 'champion work', overrides: Record<string, unknown> = {}) {
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec(objective, { requiredCapabilities: ['research'], ...overrides })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    return { championTaskId: outcomes[0]!.taskId, championRunId: outcomes[0]!.runId!, rootTaskId }
  }

  test('a capability override applies for the replay run only, and the replay task stands apart from the champion', async () => {
    pinSkillHome('verify')
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
    // A replay never invites a split (its projection carries no decomposition
    // guidance at all — `context/tests/unit/reads.spec.ts`, "a replay reads …"),
    // and the spawn request carries no prompt to invite one either: the replay
    // task's own objective, tagged `[evolution-replay:p2]`, is what the context
    // projection briefs it with, read from the store.
    expect(spawn.prompt).toBeUndefined()
    expect(spawn.taskWorker).toBe(true)
    const replay = (await h.task.snapshotIn(STORE)).tasks.find(
      task => task.objective.includes('[evolution-replay:p2]'),
    )
    expect(replay?.objective).toContain('[evolution-replay:p2]')
  })

  test('a spawning replay binds its own content: the overlay root stays first and the run\'s snapshot follows it', async () => {
    const home = pinSkillHome('verify')
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    // The candidate skill a skill replay passes: a sandbox directory the overlay
    // root exposes, with no sidecar (loadable guidance for the row under test).
    const sandbox = join(home, 'sandbox', 'p3', 'skills')
    await mkdir(join(sandbox, 'verify'), { recursive: true })
    await writeFile(join(sandbox, 'verify', 'SKILL.md'), '---\nname: verify\ndescription: candidate verify\n---\n\nCANDIDATE BODY\n')

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:binding',
      overlay: { extraSkillRoots: [sandbox], capabilityOverrides: { research: { preset: 'standard', skills: ['verify'] } } },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const run = await h.task.runIn(STORE, outcome.runId)
    const binding = run.providerBinding
    if (binding === undefined) throw new Error('the replay run recorded no provider binding')
    expect(binding.skills.map(skill => skill.name)).toEqual(['verify'])
    expect(binding.skills[0]!.role).toBe('guidance')
    // P2's order is preserved — the candidate is registered first — and the run's
    // snapshot of what the pre-check judged follows it.
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.skillRoots).toEqual([sandbox, binding.snapshotRoot])
    // The snapshot holds the overlay's bytes, because the overlay is what this
    // replay's admission judged.
    expect(await readFile(join(binding.snapshotRoot!, 'verify', 'SKILL.md'), 'utf8')).toContain('CANDIDATE BODY')
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])
  })

  test('the replay renders the champion\'s own declarations and persists the same two lists', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const assumptions = ['a cycle-accurate reference model exists']
    const constraints = ['no network access', 'finish inside ten minutes']
    const { championTaskId } = await champion(h, 'champion work', { assumptions, constraints })
    const championContract = (await h.task.taskIn(STORE, championTaskId)).contract!

    const outcome = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:declarations' }, ROOT_SESSION)

    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    const stored = replayTask.contract!
    const spawn = h.spawned[h.spawned.length - 1]!
    // The store is the source, so the rendered views have to say what it says:
    // every item the persisted contract carries is in the spawn prompt and in
    // the contract block the loop reprojects — and the persisted lists are the
    // champion's own, element for element, not merely two non-empty lists.
    // The declarations a worker is shown are its assembled contract's, projected
    // from this very record (A2 — `context/tests/unit/reads.spec.ts` and
    // `tests/integration/context-assembly.spec.ts` assert that rendering), and the
    // spawn request carries no text of its own.
    expect(spawn.taskWorker).toBe(true)
    expect(spawn.prompt).toBeUndefined()
    expect(spawn.contract).toBeUndefined()
    for (const item of [...stored.assumptions, ...stored.constraints]) expect(item.length).toBeGreaterThan(0)
    expect(stored.assumptions).toEqual(championContract.assumptions)
    expect(stored.constraints).toEqual(championContract.constraints)
    expect(championContract.assumptions).toHaveLength(1)
    expect(championContract.constraints).toHaveLength(2)
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

  test('a replay in a caller-named workspace resolves its spawn, its verifier and its MCP servers there', async () => {
    // S4-E: the two-sided evaluation runs each side in a workspace built from the
    // same initial snapshot, so everything one side resolves against — the
    // worker's cwd, the verifier's cwd, and what a capability's MCP server is
    // bound to — has to follow the directory the caller named.
    pinSkillHome('check')
    const parent = mkdtempSync(join(tmpdir(), 's4e-named-replay-'))
    const checkoutRoot = join(parent, 'checkout')
    const named = join(parent, 'candidate-side')
    mkdirSync(checkoutRoot, { recursive: true })
    mkdirSync(named, { recursive: true })
    try {
      const realNamed = await realpath(named)
      const h = harness({ config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } } })
      h.ctx.envBuilder = {
        store: {
          get: (envId: string) => ({
            path: checkoutRoot,
            components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
          }),
        },
      }
      const { championTaskId } = await champion(h, 'champion work', { requiredCapabilities: ['check-ball-registration'] })

      const outcome = await h.runtime.replayTask(STORE, championTaskId, {
        lineage: 'evolution-replay:named-workspace',
        workspace: { path: named },
      }, ROOT_SESSION)

      expect(outcome.status).toBe('verified')
      // The outcome names the workspace, normalized — the identity a report and a
      // marker both key by.
      expect(outcome.workspace).toBe(realNamed)
      // The worker starts in it.
      const spawn = h.spawned[h.spawned.length - 1]!
      expect(spawn.cwd).toBe(realNamed)
      // So does the MCP server the capability grants: the env root a server's cwd
      // and `{repoRoot:…}` placeholders resolve against is the named workspace.
      expect(spawn.grant!.mcpServers).toEqual([{
        serverName: 'bbdev',
        command: join(realNamed, 'fork/buckyball/scripts/claude/run_mcp_server.sh'),
        args: [],
        env: {},
        cwd: join(realNamed, 'fork/buckyball'),
      }])
      // And the verifier judges there.
      expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, outcome.runId, { cwd: realNamed, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
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
    expect(record!.criteria).toEqual([{ criterionId: 'cd-1', verdict: 'pass', verifierId: 'fake-verifier', command: 'make candidate' }])
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

  test('replay uses the same preset conflict rule before creating a candidate task', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const original = await h.task.taskIn(STORE, championTaskId)
    const before = await h.task.snapshotIn(STORE)
    const spawnCount = h.spawned.length
    await expect(h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:conflicting-presets',
      contract: {
        objective: original.objective,
        acceptanceCriteria: original.acceptanceCriteria,
        requiredCapabilities: ['research', 'verify'],
      },
      overlay: { capabilityOverrides: { verify: { preset: 'bb-verify' } } },
    }, ROOT_SESSION)).rejects.toThrow(/conflicting capability presets/)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(h.spawned).toHaveLength(spawnCount)
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

  describe('candidate contracts under the shared structural rules (T1, construction guide §4)', () => {
    /** A candidate contract as the replay entry takes it: valid unless the test overrides it. */
    function candidate(overrides: Partial<{ objective: string; acceptanceCriteria: AcceptanceCriterion[]; requiredCapabilities: string[] }> = {}) {
      return {
        objective: 'candidate definition replay',
        acceptanceCriteria: [{
          criterionId: 'cd-1',
          description: 'the candidate definition holds',
          verificationMode: 'deterministic' as const,
          requiredEvidence: [],
          mandatory: true,
          command: 'make candidate',
        }],
        requiredCapabilities: ['research'],
        ...overrides,
      }
    }

    test('refuses a candidate whose every criterion is optional, naming the rule, and persists nothing', async () => {
      const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
      const { championTaskId } = await champion(h)
      const before = await h.task.snapshotIn(STORE)
      const spawnCount = h.spawned.length

      await expect(h.runtime.replayTask(STORE, championTaskId, {
        lineage: 'evolution-replay:all-optional',
        contract: candidate({
          acceptanceCriteria: [{
            criterionId: 'cd-1',
            description: 'nothing is required',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: false,
            command: 'true',
          }],
        }),
      }, ROOT_SESSION)).rejects.toThrow(
        /replay of "[^"]+" rejected:\n- replay of "[^"]+" requires at least one mandatory acceptance criterion/,
      )

      expect(await h.task.snapshotIn(STORE)).toEqual(before)
      expect(h.spawned).toHaveLength(spawnCount)
    })

    test('refuses a candidate with one criterion id declared twice, naming the duplicate, and persists nothing', async () => {
      const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
      const { championTaskId } = await champion(h)
      const before = await h.task.snapshotIn(STORE)
      const spawnCount = h.spawned.length

      await expect(h.runtime.replayTask(STORE, championTaskId, {
        lineage: 'evolution-replay:duplicate-id',
        contract: candidate({
          acceptanceCriteria: [
            { criterionId: 'cd-dup', description: 'first', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
            { criterionId: 'cd-dup', description: 'second', verificationMode: 'review', requiredEvidence: [], mandatory: true },
          ],
        }),
      }, ROOT_SESSION)).rejects.toThrow(
        /replay of "[^"]+" rejected:\n- replay of "[^"]+" declares criterion id "cd-dup" more than once/,
      )

      expect(await h.task.snapshotIn(STORE)).toEqual(before)
      expect(h.spawned).toHaveLength(spawnCount)
    })

    test('persists the effective candidate contract: the tagged objective, the candidate\'s criteria and capabilities, the champion\'s declarations', async () => {
      const h = harness({ config: { capabilities: { research: { preset: 'standard' }, verify: { preset: 'bb-verify' } } } })
      const assumptions = ['a cycle-accurate reference model exists']
      const constraints = ['no network access']
      const { championTaskId } = await champion(h, 'champion work', { assumptions, constraints })
      // The candidate differs from the champion in all three fields it owns:
      // its objective, its criteria, and the capability it requires.
      const contract = candidate({ requiredCapabilities: ['verify'] })

      const outcome = await h.runtime.replayTask(STORE, championTaskId, {
        lineage: 'evolution-replay:candidate',
        contract,
        spawn: false,
      }, ROOT_SESSION)

      expect(outcome.status).toBe('verified')
      const replayTask = await h.task.taskIn(STORE, outcome.taskId)
      expect((await h.task.taskIn(STORE, championTaskId)).requestedCapabilities).toEqual(['research'])
      // The effective contract, field for field: the candidate's three fields
      // plus the champion's own conditions, under the lineage tag. The store
      // refuses a contract that disagrees with the instance it describes, so
      // this is what both a `task_read` and the run's own criteria see.
      expect(replayTask.contract).toEqual({
        contractVersion: 1,
        objective: '[evolution-replay:candidate] candidate definition replay',
        acceptanceCriteria: [{
          criterionId: 'cd-1',
          description: 'the candidate definition holds',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'make candidate',
        }],
        assumptions,
        constraints,
        requiredCapabilities: ['verify'],
      })
      expect(replayTask.contract!.contractVersion).toBe(1)
    })

    test('replays a champion created before contracts existed, with empty assumptions and constraints', async () => {
      const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
      // Raw store calls, the shape the legacy-style tests use: a task admitted
      // and settled before the contract existed carries none.
      const { taskId: championTaskId, runId: championRunId } = await createAcceptanceParent(h, [{
        criterionId: 'legacy-1',
        description: 'the legacy criterion holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }])
      await settleRunNested(h.task, STORE, championTaskId, championRunId, 'tester')
      const champion = await h.task.taskIn(STORE, championTaskId)
      expect(champion.contract).toBeUndefined()
      expect(champion.status).toBe('verified')

      const outcome = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:legacy' }, ROOT_SESSION)

      expect(outcome.status).toBe('verified')
      const replayTask = await h.task.taskIn(STORE, outcome.taskId)
      expect(replayTask.contract!.objective).toBe('[evolution-replay:legacy] prove the combination, not only the parts')
      expect(replayTask.contract!.acceptanceCriteria.map(item => item.criterionId)).toEqual(['legacy-1'])
      expect(replayTask.contract!.assumptions).toEqual([])
      expect(replayTask.contract!.constraints).toEqual([])
      // Nothing was invented for it either: the two rendered sections say so.
      const spawn = h.spawned[h.spawned.length - 1]!
      // Nothing is invented for the record either: its stored contract is what the
      // worker's context is projected from, and it carries the empty lists.
      expect(spawn.taskWorker).toBe(true)
      expect(spawn.prompt).toBeUndefined()
      expect(replayTask.contract!.assumptions).toEqual([])
      expect(replayTask.contract!.constraints).toEqual([])
    })
  })

  /*
   * S4-E (Q3, rework): the execution binding one replay run is placed under.
   *
   * An experiment freezes a model selection before it runs either side, and the
   * frozen value has to reach the worker that really runs — not only the report
   * that describes it. These cases pin the one narrow pipe left: `agentOptions`
   * through to `SpawnRequest`, and the sub-execution a replayed worker decomposes
   * into inherits it, because the two sides of an experiment are only comparable
   * if the whole subtree ran under the same selection. The run's clock is the
   * runtime's own (`Config.budget.wallTimeMs`, the root budget) — a replay names
   * none.
   */
  const FROZEN_OPTIONS = { provider: 'frozen-provider', model: 'frozen-model' }

  test('a replay carries its frozen agent options into the worker spawn; absent them the spawn is unchanged', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const before = h.spawned.length

    const frozen = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:agent-options',
      agentOptions: { ...FROZEN_OPTIONS },
    }, ROOT_SESSION)

    expect(frozen.status).toBe('verified')
    const worker = h.spawned[before]!
    // The value the real AgentRuntime received, which is what its creation merges
    // over the deployment default for this worker alone.
    expect(worker.agentOptions).toEqual(FROZEN_OPTIONS)
    // A replay that names none keeps the default: nothing was invented for it.
    const plain = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:agent-options-default' }, ROOT_SESSION)
    expect(plain.status).toBe('verified')
    expect(h.spawned[before + 1]!.agentOptions).toBeUndefined()
  })

  test('a replayed worker\u2019s own decomposition is spawned under the same frozen options', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const before = h.spawned.length
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.parentTaskId !== undefined) {
        await h.runtime.submitResult(sessionId, { summary: 'done' })
        return
      }
      await decomposeAndSettle(h, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the replayed work is not atomic',
        children: [childSpec('the child of the replayed work')],
      })
      // The nested batch ended and handed the replayed worker its run back
      // (K1 §2): the worker's own submission is what settles it now.
      await h.runtime.submitResult(sessionId, { summary: 'the split ran; the replayed work continues under the child' })
    })

    const outcome = await h.runtime.replayTask(STORE, championTaskId, {
      lineage: 'evolution-replay:sub-execution',
      agentOptions: { ...FROZEN_OPTIONS },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const [worker, child] = h.spawned.slice(before)
    expect(worker!.agentOptions).toEqual(FROZEN_OPTIONS)
    // The child was spawned from the replayed worker's own session, and it carries
    // the binding of the experiment it belongs to — the same options the worker
    // itself was created under, so the two sides of the comparison really ran the
    // same way.
    expect(child!.agentOptions).toEqual(FROZEN_OPTIONS)
    expect(child!.sessionId).not.toBe(worker!.sessionId)
  })

})

describe('TaskRuntime normalized contract (T1, construction guide §4)', () => {
  test('a batch admitted with contracts persists them, with the batch identity and limits on the parent event', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const spec: DecomposeSpec = {
      reason: 'split the work',
      children: [childSpec('child a', {
        assumptions: ['a cycle-accurate reference model exists'],
        constraints: ['no network access'],
        requiredCapabilities: ['research'],
      })],
    }
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, spec)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.contract).toEqual({
      contractVersion: 1,
      objective: 'child a',
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'child a works',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      assumptions: ['a cycle-accurate reference model exists'],
      constraints: ['no network access'],
      requiredCapabilities: ['research'],
    })
    // The stored projections are the contract, not a second source that happens
    // to agree with it: the reducer checks exactly this on write.
    expect(child.objective).toBe(child.contract!.objective)
    expect(child.acceptanceCriteria).toEqual(child.contract!.acceptanceCriteria)
    expect(child.requestedCapabilities).toEqual(child.contract!.requiredCapabilities)

    const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed' && item.taskId === rootTaskId)
    const admission = decomposed?.kind === 'TaskDecomposed' ? decomposed.payload.admission : undefined
    expect(admission?.proposalDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(admission?.context).toStrictEqual({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxChildren: DEFAULT_MAX_CHILDREN,
      wallTimeMs: DEFAULT_BUDGET.wallTimeMs,
      auditOnly: { maxToolCalls: DEFAULT_BUDGET.maxToolCalls, attempts: 1 },
    })
    // The runtime writes the same batch identity the pure normalization entry
    // computes for the same proposal and parent — the ids it minted per child
    // are not part of it.
    const expected = normalizeDecomposition(spec, {
      storeId: STORE,
      parentTaskId: rootTaskId,
      parentRunId: rootRunId,
      callerSessionId: ROOT_SESSION,
      admissionContext: { maxDepth: DEFAULT_MAX_DEPTH, maxChildren: DEFAULT_MAX_CHILDREN, auditOnly: {} },
    })
    if (!expected.ok) throw new Error(expected.reasons.join('\n'))
    expect(admission?.proposalDigest).toBe(expected.batch.admission.proposalDigest)
  })

  test('the contract survives a store reopen: it is read back from the events, not from memory', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a', { assumptions: ['a reference model exists'], constraints: ['no network'] })],
    })
    const stored = (await h.task.taskIn(STORE, outcomes[0]!.taskId)).contract
    await Promise.all(h.disposers.map(dispose => dispose()))

    // A fresh service over the same session log: the contract has to come back
    // from the persisted TaskCreated event, not from the object still in memory.
    const h2 = harness()
    h2.sessions.clear()
    for (const [id, session] of h.sessions) h2.sessions.set(id, session)
    await h2.task.openStore(STORE)
    const reopened = await h2.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(reopened.contract).toStrictEqual(stored)
    expect(reopened.contract!.constraints).toEqual(['no network'])
    expect(reopened.contract!.assumptions).toEqual(['a reference model exists'])
  })

  test('the admission context records the limits in force, including every configured audit-only value', async () => {
    const h = harness({ config: { maxDepth: 2, maxChildren: 3, budget: { wallTimeMs: 5000, tokens: 999 } } })
    const { taskId, runId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed')
    expect(decomposed?.kind === 'TaskDecomposed' ? decomposed.payload.admission?.context : undefined).toStrictEqual({
      maxDepth: 2,
      maxChildren: 3,
      wallTimeMs: 5000,
      auditOnly: { maxToolCalls: DEFAULT_BUDGET.maxToolCalls, tokens: 999, attempts: 1 },
    })
  })

  test('a batch the contract rejects persists nothing and spawns nothing', async () => {
    const children = (child: Record<string, unknown>) => [child] as unknown as DecomposeSpec['children']
    const cases: Array<[string, DecomposeSpec, RegExp]> = [
      ['an unknown child field', {
        reason: 'split the work',
        children: children({ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true' }], skills: ['ball-align'] }),
      }, /contract rejected decomposition of "[^"]+":\n- child 0 declares unknown field "skills"/],
      ['a duplicate explicit criterion id', {
        reason: 'split the work',
        children: children({ objective: 'child a', acceptanceCriteria: [
          { description: 'first', criterionId: 'dup', command: 'true' },
          { description: 'second', criterionId: 'dup', command: 'true' },
        ] }),
      }, /contract rejected decomposition of "[^"]+":\n- child 0 declares criterion id "dup" more than once/],
      ['an unknown contract version', {
        reason: 'split the work',
        contractVersion: 2,
        children: [childSpec('child a')],
      }, /contract rejected decomposition of "[^"]+":\n- unknown contract version 2: this runtime writes version 1/],
      ['an all-optional criterion list', {
        reason: 'split the work',
        children: children({ objective: 'child a', acceptanceCriteria: [{ description: 'nothing is required', command: 'true', mandatory: false }] }),
      }, /admission rejected decomposition of "[^"]+":\n- child 0 requires at least one mandatory acceptance criterion/],
      ['a null mode', {
        reason: 'split the work',
        children: children({ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true', mode: null }] }),
      }, /admission rejected decomposition of "[^"]+":\n- child 0 criterion "ac1-1" verificationMode "null" is not one of deterministic, simulation, formal, measurement, review, composite/],
      ['a numeric mode', {
        reason: 'split the work',
        children: children({ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true', mode: 0 }] }),
      }, /admission rejected decomposition of "[^"]+":\n- child 0 criterion "ac1-1" verificationMode "0" is not one of deterministic, simulation, formal, measurement, review, composite/],
    ]

    for (const [label, spec, expected] of cases) {
      const h = harness()
      const { taskId, runId } = await createRoot(h)
      const before = await h.task.snapshotIn(STORE)
      await expect(decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, spec), label).rejects.toThrow(expected)
      expect(h.spawned, label).toHaveLength(0)
      expect(await h.task.snapshotIn(STORE), label).toEqual(before)
      // No child task id reached the store: the parent is still alone.
      expect(taskEvents(h).some(item => item.kind === 'TaskCreated' && item.taskId !== taskId), label).toBe(false)
      expect(taskEvents(h).some(item => item.kind === 'TaskDecomposed'), label).toBe(false)
    }
  })

  test('the handoff carries the contract constraints beside the declared assumptions, dependency evidence last', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('reference producer'),
        childSpec('downstream', {
          dependsOn: [0],
          assumptions: ['a cycle-accurate reference model exists'],
          constraints: ['no network access', 'finish inside ten minutes'],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    const snapshot = await h.task.snapshotIn(STORE)
    const downstream = snapshot.handoffs.find(item => item.childTaskId === outcomes[1]!.taskId)!
    expect(downstream.constraints).toEqual(['no network access', 'finish inside ten minutes'])
    expect(downstream.assumptions).toEqual([
      'a cycle-accurate reference model exists',
      `dependency evidence "${outcomes[0]!.evidenceId!}" is verified and available as a reference`,
    ])
    // Both declarations reach the worker through its assembled contract — the
    // projection's handoff block, read from this record — and the spawn request
    // carries no rendering of its own (A2).
    expect(h.spawned[1]!.taskWorker).toBe(true)
    expect(h.spawned[1]!.prompt).toBeUndefined()
    // The stored child contract keeps the same declarations the handoff rendered.
    const child = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(child.contract!.constraints).toEqual(['no network access', 'finish inside ten minutes'])
    expect(child.contract!.assumptions).toEqual(['a cycle-accurate reference model exists'])
  })

  test('the same proposal submitted twice keeps one digest; a changed criterion, constraint or assumption moves it', async () => {
    /** One submission of `children` from a parent whose ids are fixed, so two runs differ only in the child ids they mint. */
    const submitted = async (children: DecomposeSpec['children']) => {
      const h = harness()
      const { taskId, runId } = await createAcceptanceParent(h, [{
        criterionId: 'root-combination',
        description: 'the children together prove the root goal',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
      }])
      await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, { reason: 'split the work', children })
      const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed')
      if (decomposed?.kind !== 'TaskDecomposed' || decomposed.payload.admission === undefined) {
        throw new Error('the batch was not admitted')
      }
      const childIds = (await h.task.snapshotIn(STORE)).tasks
        .filter(task => task.parentTaskId === 't-parent')
        .map(task => task.taskId)
        .sort()
      return { digest: decomposed.payload.admission.proposalDigest, childIds }
    }

    const withDeclarations = () => childSpec('child a', { constraints: ['no network'], assumptions: ['a reference exists'] })
    const first = await submitted([withDeclarations(), childSpec('child b', { dependsOn: [0] })])
    const second = await submitted([withDeclarations(), childSpec('child b', { dependsOn: [0] })])

    expect(first.digest).toBe(second.digest)
    // ...although the two submissions were admitted with different minted ids.
    expect(first.childIds).not.toEqual(second.childIds)
    expect(first.childIds).toHaveLength(2)

    const variants: Array<[string, DecomposeSpec['children']]> = [
      ['a criterion changed', [
        childSpec('child a', { constraints: ['no network'], assumptions: ['a reference exists'], acceptanceCriteria: [{ description: 'child a passes', command: 'true' }] }),
        childSpec('child b', { dependsOn: [0] }),
      ]],
      ['a constraint changed', [childSpec('child a', { constraints: ['offline'], assumptions: ['a reference exists'] }), childSpec('child b', { dependsOn: [0] })]],
      ['an assumption changed', [childSpec('child a', { constraints: ['no network'], assumptions: ['a faster host exists'] }), childSpec('child b', { dependsOn: [0] })]],
    ]
    for (const [label, children] of variants) {
      expect((await submitted(children)).digest, label).not.toBe(first.digest)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * A3: the coordination protocol (non-blocking batches, phases, gates,
 * cancellation, the root budget, workspace ownership, recovery)
 * ------------------------------------------------------------------------- */

/** `mkdtemp` for a checkout, and the reading of an ownership directory. */
function tempCheckout(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`))
}

/** The owner markers a deployment wrote under its run-binding root, if any. */
async function ownershipMarkers(bindingRoot: string): Promise<string[]> {
  try {
    return await readdir(join(bindingRoot, 'workspace-owners'))
  } catch {
    return []
  }
}

describe('A3 coordination', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const tempDirs: string[] = []
  function checkout(label: string): string {
    const dir = tempCheckout(label)
    tempDirs.push(dir)
    return dir
  }

  test('decomposeAndRun returns a batch handle while the children are still running', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // A worker that never finishes on its own: the call has to return anyway.
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId, childTaskIds } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    // The batch id is the pair (parent run, proposal) — a run admits more than
    // one batch, so the task id alone could not name this one (K1 §3).
    const proposal = (await h.runtime.proposalIn(STORE, (await h.task.runIn(STORE, runId)).batches![0]!.proposalId))
    expect(batchId).toBe(`b-${runId}-${proposal.proposalId}`)
    expect(childTaskIds).toHaveLength(1)
    // The handle came back with the children still unsettled, and the store says
    // the same: the parent is waiting, the child is running. (The driver starts
    // asynchronously, so the spawn is allowed a moment to appear — the point is
    // that this call did not wait for it.)
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.taskId === childTaskIds[0])!
    expect(childRun.status).toBe('running')
    expect(childRun.executionPhase).toBe('active')
    expect((await h.task.runIn(STORE, runId)).executionPhase).toBe('waiting_children')
    expect((await h.task.runIn(STORE, runId)).batchId).toBe(batchId)
    // The batch is the runtime's now: cancelling it is what ends it.
    const outcomes = await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    expect(h.spawned).toHaveLength(1)
  })

  test('the caller signal governs admission only: aborting it after admission leaves the batch running to completion', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const controller = new AbortController()

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    }, { signal: controller.signal })
    // The tool call is over (or aborted) — ownership of the batch moved at the
    // atomic commit (A3 §3.7), so neither can stop it.
    controller.abort()

    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The batch ended on the runtime's own controller — no caller signal reached
    // it — and handed the parent back `active`: the run is not terminal until its
    // own submission says so (K1 §2).
    expect((await h.task.runIn(STORE, runId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('verified')
  })

  test('an idle without a submission is marked, reminded once, and stopped at the no-progress limit', async () => {
    const h = harness({ config: { noProgressRounds: 2 } })
    const { taskId, runId } = await createRoot(h)
    // A worker that goes idle instead of submitting: the store must show the
    // marking, the owner must be reminded once, and the run must stop at the
    // configured limit — a budget stop, not a criteria verdict.
    h.setIdleBehavior(async () => {})

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('stuck child')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.taskId !== taskId)!
    expect(childRun.status).toBe('failed')
    expect(childRun.noProgress?.rounds).toBe(2)
    const marks = taskEvents(h).filter(item => item.kind === 'RunProgressMarked')
    expect(marks.map(item => (item.kind === 'RunProgressMarked' ? item.payload.rounds : 0))).toEqual([1, 2])
    const reminders = h.notifications.filter(item => item.sessionId === childRun.sessionId)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.text).toContain('task_submit_result')
    const record = snapshot.reviews.find(item => item.runId === childRun.runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain('no progress')
    expect(record.localizedCause).toContain('budget stop on the no-progress rule')
    // The parent's own run is not judged by its child's stop: the batch ended and
    // handed it back `active`, and the parent's own submission is what would be
    // judged (K1 §2).
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.status).toBe('running')
    expect(parentRun.executionPhase).toBe('active')
  })

  test('an explicit submission settles the run, a second one is answered from the record, and a waiting parent refuses to submit', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const replies: Array<{ status: string; detail: string }> = []
    h.setIdleBehavior(async sessionId => {
      replies.push(await h.runtime.submitResult(sessionId, { summary: 'implemented and checked', evidenceRefs: ['docs/r.md'] }))
      // The late call: the phase gate is unique, so this reads the record.
      replies.push(await h.runtime.submitResult(sessionId, { summary: 'second attempt' }))
    })

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(replies.map(reply => reply.status)).toEqual(['verified', 'verified'])
    // The submission settled synchronously enough that the second call finds the
    // terminal state: either answer is a read of the record, never a second
    // write, and both say the recorded result stands.
    expect(replies[1]!.detail).toContain('already')

    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.taskId !== taskId)!
    expect(childRun.submission).toMatchObject({ summary: 'implemented and checked', evidenceRefs: ['docs/r.md'], origin: 'worker' })
    const phaseEvents = taskEvents(h).filter(item => item.kind === 'RunPhaseChanged' && item.runId === childRun.runId && item.payload.phase === 'submitted')
    expect(phaseEvents).toHaveLength(1)
    // Nothing submitted anything for the parent: the batch ended, its own
    // `waiting_children → active` is on the record, and the run holds no
    // submission until its own agent writes one (K1 §2).
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.submission).toBeUndefined()
    expect(parentRun.executionPhase).toBe('active')
    const parentPhases = taskEvents(h)
      .filter(item => item.kind === 'RunPhaseChanged' && item.runId === runId)
      .map(item => (item.kind === 'RunPhaseChanged' ? item.payload.phase : undefined))
    expect(parentPhases).toEqual(['waiting_children', 'active'])
    const parentPhaseEvents = taskEvents(h).filter(item => item.kind === 'RunPhaseChanged' && item.runId === runId)
    expect(parentPhaseEvents.every(item => item.kind !== 'RunPhaseChanged' || item.payload.batchId === batchId)).toBe(true)

    // The parent may now submit, and its acceptance is its own: the same entry
    // the worker used, judged by the verifier the deployment wires.
    const settled = await h.runtime.submitResult(ROOT_SESSION, { summary: 'the parent combines what the batch delivered' })
    expect(settled.status).toBe('verified')
    const submitted = await h.task.runIn(STORE, runId)
    expect(submitted.submission?.origin).toBe('worker')
    expect(submitted.submission?.summary).toBe('the parent combines what the batch delivered')
  })

  test('a parent waiting on its children refuses a submission', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))

    await expect(h.runtime.submitResult(ROOT_SESSION, { summary: 'parent claims done' }))
      .rejects.toThrow(/waiting on its child batch/)
    // Nothing was written by the refused call.
    expect((await h.task.runIn(STORE, runId)).submission).toBeUndefined()
    await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
  })

  test('a batch driver that cannot build its view of the world fails the parent run and tells the owner', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    // The env the driver starts from cannot be assembled. That rejection happens
    // before `driveBatch`, whose own catch never sees it, and it must not be
    // fire-and-forget (§3.1): the parent run fails by name, the child that never
    // started is blocked, and the owner is told.
    const runtime = h.runtime as unknown as { orchestrateEnv: (...args: unknown[]) => Promise<unknown> }
    runtime.orchestrateEnv = async () => { throw new Error('the checkout cannot be resolved') }

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    await vi.waitFor(async () => expect((await h.task.runIn(STORE, runId)).status).toBe('failed'))
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(review => review.runId === runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain('the checkout cannot be resolved')
    const child = snapshot.tasks.find(task => task.parentTaskId === taskId)!
    expect(child.status).toBe('blocked')
    expect(snapshot.reviews.find(review => review.taskId === child.taskId)?.outcome).toBe('blocked')
    expect(h.notifications.some(item => item.sessionId === ROOT_SESSION && item.text.includes('failed'))).toBe(true)
    expect(h.spawned).toHaveLength(0)
    // And the batch's own outcomes are derivable from the store afterwards: the
    // registration is a cache, the store is the truth.
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['blocked'])
  })

  test('the gate denies writes and allows the coordination tools once the run is no longer active', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))

    const gate = h.runtime.gate
    expect(gate.phaseOf(ROOT_SESSION)).toBe('waiting_children')
    const denied = gate.decide(ROOT_SESSION, 'write')
    expect(denied.allow).toBe(false)
    expect(denied.allow === false ? denied.reason : '').toContain('waiting_children')
    expect(gate.decide(ROOT_SESSION, 'bash').allow).toBe(false)
    expect(gate.decide(ROOT_SESSION, 'task_decompose').allow).toBe(false)
    expect(gate.decide(ROOT_SESSION, 'task_submit_result').allow).toBe(false)
    expect(gate.decide(ROOT_SESSION, 'task_read').allow).toBe(true)
    expect(gate.decide(ROOT_SESSION, 'task_cancel').allow).toBe(true)
    // A session with no run binding (an env-clean helper, a reviewer) is not gated.
    expect(gate.decide('env-clean', 'write').allow).toBe(true)

    await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
    // A settled run is terminal for the gate: the late call is named as one.
    expect(gate.phaseOf(ROOT_SESSION)).toBe('terminal')
    const late = gate.decide(ROOT_SESSION, 'write')
    expect(late.allow).toBe(false)
    expect(late.allow === false ? late.reason : '').toContain('late call')
  })

  test('a batch end counts as progress: the no-progress marker does not carry a pre-split round to the limit', async () => {
    const h = harness({ config: { noProgressRounds: 2 } })
    const { taskId, runId } = await createRoot(h)
    let idleRounds = 0
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.depth !== 1) {
        await h.runtime.submitResult(sessionId, { summary: 'the grandchild is done' })
        return
      }
      idleRounds += 1
      if (idleRounds !== 2) return
      // The worker splits its own work instead of submitting: the nested batch
      // runs to its end inside this idle, so the next observation finds the run
      // `active` again with the facts the batch produced on the record.
      await decomposeAndSettle(h, STORE, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the work is not atomic',
        children: [childSpec('grandchild')],
      })
    })

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true })],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])

    const middleRun = (await h.task.snapshotIn(STORE)).runs.find(run => run.taskId !== taskId)!
    const marks = taskEvents(h)
      .filter(item => item.kind === 'RunProgressMarked' && item.runId === middleRun.runId)
      .map(item => (item.kind === 'RunProgressMarked' ? item.payload : undefined))
    // round 1 (idle) → round 1 again (the batch's facts are new progress, so the
    // counter restarts) → round 2 (the limit). A marker that carried the
    // pre-split count would have stopped the run one round earlier, at the round
    // the batch end never answered.
    expect(marks.map(mark => mark?.rounds)).toEqual([1, 1, 2])
    expect(marks[1]!.factCount).toBeGreaterThan(marks[0]!.factCount)
    expect(marks[2]!.factCount).toBe(marks[1]!.factCount)
    expect(middleRun.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(review => review.runId === middleRun.runId)!
    expect(record.localizedCause).toContain('no progress')
    expect(record.localizedCause).toContain('no-progress rule')
  })

  test('the batch end opens the gate again: writing, delegating and submitting are the parent\'s own decisions', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const gate = h.runtime.gate
    // The phase the batch gave back (K1 §2), and what it admits: the handback is
    // not a report — the parent may write, delegate again and submit.
    expect(gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect(gate.questionsBlocked(ROOT_SESSION)).toBe(false)
    for (const tool of ['write', 'bash', 'task_decompose', 'task_submit_result']) {
      expect([tool, gate.decide(ROOT_SESSION, tool).allow]).toEqual([tool, true])
    }
    expect((await h.task.runIn(STORE, runId)).executionPhase).toBe('active')
  })

  test('a batch end never answers the parent\'s own question: active, and its writes stay refused', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const state: { middleBatchId?: string; middleSession?: string } = {}
    let asked!: () => void
    const askedInStore = new Promise<void>(resolve => { asked = resolve })
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.depth === 1) {
        // The middle worker delegates once — its own batch — and then asks its
        // parent something it cannot continue without. The ask is recorded
        // through the store's own entry (the tool layer's citation path is A4's
        // own test); the point here is what the *batch end* does with it.
        const { batchId } = await h.runtime.decomposeAndRun(STORE, bound.task.taskId, bound.run.runId, sessionId, {
          reason: 'the middle worker splits its own work',
          children: [childSpec('grandchild')],
        })
        state.middleBatchId = batchId
        state.middleSession = sessionId
        await h.task.askParentQuestionIn(STORE, {
          childRunId: bound.run.runId,
          requestKey: 'k-middle',
          questionDigest: sha256Hex('the middle worker cannot continue without an answer'),
          questionRef: { sessionId, seq: 1 },
          messageId: 'm-middle-question',
          blocking: true,
        }, sessionId)
        asked()
        return
      }
      // The grandchild finishes only once its parent has asked: the batch end
      // under test is the one that happens with the question already open.
      await askedInStore
      await h.runtime.submitResult(sessionId, { summary: 'the grandchild is done' })
    })

    const rootBatchId = (await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('middle child', { decomposable: true })],
    })).batchId
    await vi.waitFor(() => expect(state.middleBatchId).toBeDefined())
    const middleOutcomes = await h.runtime.awaitBatch(STORE, state.middleBatchId!)
    expect(middleOutcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const middleSession = state.middleSession!
    const middleRun = (await h.task.snapshotIn(STORE)).runs.find(run => run.sessionId === middleSession)!
    // The batch ended on the children's terminal states, question or not: the
    // run took execution back and was told so.
    expect(middleRun.executionPhase).toBe('active')
    expect(middleRun.batchId).toBeUndefined()
    expect(h.relayed.find(item => item.messageId === `m-batchend-${state.middleBatchId}`)).toBeDefined()
    // …but the question is still open, and the phase the batch gave back is not a
    // licence to write: the batch ending answered nothing (K1 §2).
    const gate = h.runtime.gate
    expect(gate.phaseOf(middleSession)).toBe('active')
    expect(gate.questionsBlocked(middleSession)).toBe(true)
    const refused = gate.decide(middleSession, 'write')
    expect(refused.allow).toBe(false)
    expect(refused.allow === false ? refused.reason : '').toContain('unresolved blocking question')
    // The record agrees with the gate, and the question is nobody's answer.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.questions!.all.filter(question => question.childRunId === middleRun.runId).map(question => question.answers ?? []))
      .toEqual([[]])
    await h.runtime.cancelBatch(STORE, rootBatchId, ROOT_SESSION)
  })

  test('the batch-end message is delivered once: re-deriving it answers already-present and writes nothing', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await h.runtime.awaitBatch(STORE, batchId)
    expect(h.relayed.filter(item => item.sessionId === ROOT_SESSION)).toHaveLength(1)

    // The recovery pass's entry (K1 §2): the same message, re-derived from the
    // store after the batch ended. The target's own fold is the record — the
    // second attempt delivers nothing, and the text is the store's own account.
    const before = await h.task.snapshotIn(STORE)
    expect(await h.runtime.redeliverBatchResult(STORE, batchId)).toBe('already-present')
    expect(h.relayed.filter(item => item.sessionId === ROOT_SESSION)).toHaveLength(1)
    expect(h.relayed[0]!.messageId).toBe(`m-batchend-${batchId}`)
    expect(h.relayed[0]!.text).toContain(batchId)
    // A re-delivery is a message and nothing else: no proposal is consumed again,
    // no run is started, no evidence is written and no submission is recorded —
    // the store after the second attempt is the store after the first.
    const after = await h.task.snapshotIn(STORE)
    expect(after.runs).toEqual(before.runs)
    expect(after.tasks).toEqual(before.tasks)
    expect(after.proposals).toEqual(before.proposals)
    expect(after.evidence).toEqual(before.evidence)
    expect(after.reviews).toEqual(before.reviews)
    expect(h.spawned).toHaveLength(1)

    // A batch no run records is refused by name rather than answered with
    // another batch's children.
    await expect(h.runtime.redeliverBatchResult(STORE, 'b-not-a-batch'))
      .rejects.toThrow(/is not recorded in store/)
  })

  test('derives the end-of-batch results a store still owes, and answers a terminal parent skipped', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await h.runtime.awaitBatch(STORE, batchId)

    // The run holds its ended batch as history (the handback cleared its current
    // batch), so the store owes that batch exactly one message — one candidate,
    // with the identity and the members the batch derives them from.
    const owed = owedBatchResults(await h.task.snapshotIn(STORE))
    expect(owed).toEqual([{
      taskId,
      runId,
      batchId,
      sessionId: ROOT_SESSION,
      memberTaskIds: [expect.any(String)],
    }])

    // The parents' own submission is what ends the run, and a run that ended owes
    // nothing: the message's content is moot for it and a terminal run is not woken.
    expect((await h.runtime.submitResult(ROOT_SESSION, { summary: 'the parent is done' })).status).toBe('verified')
    expect(owedBatchResults(await h.task.snapshotIn(STORE))).toEqual([])
    const relayedBefore = h.relayed.length
    expect(await h.runtime.redeliverBatchResult(STORE, batchId)).toBe('skipped')
    expect(h.relayed).toHaveLength(relayedBefore)
  })

  test('parks an end-of-batch delivery on the recovery barrier, and drops it when the barrier fails', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await h.runtime.awaitBatch(STORE, batchId)
    // The crash between the batch's end and its wake: the run is `active` with the
    // batch on its record, and the target's fold holds no copy of the message.
    h.relayed.length = 0

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let armed = false
    let unreadable = false
    const realSnapshot = h.task.snapshotIn.bind(h.task)
    // Hold the barrier's completion read — the one `initializeStoreGates` takes once
    // the pass has returned: the store is provably still `recovering` while the case
    // acts, and that read then fails or succeeds exactly as the case says.
    const gateInit = h.runtime as unknown as { initializeStoreGates(storeId: string): Promise<void> }
    const realInitialize = gateInit.initializeStoreGates.bind(h.runtime)
    vi.spyOn(gateInit, 'initializeStoreGates').mockImplementation(async (...args: [string]) => {
      armed = true
      return await realInitialize(...args)
    })
    vi.spyOn(h.task, 'snapshotIn').mockImplementation(async (storeId: string) => {
      const snapshot = await realSnapshot(storeId)
      if (armed) {
        armed = false
        entered.resolve()
        await release.promise
        if (unreadable) throw new Error('the store log became unreadable')
      }
      return snapshot
    })

    const adopting = h.runtime.adoptRoot(STORE, ROOT_SESSION)
    try {
      await entered.promise
      // The wake order (A4 §F.1's rule, applied to batches): a delivery into a store
      // whose sessions' gates are not in place yet would be refused by the recovery
      // door with nothing left to wake the Session, so it is parked instead.
      expect(await h.runtime.redeliverBatchResult(STORE, batchId)).toBe('unavailable')
      expect(h.relayed).toEqual([])
      unreadable = true
      release.resolve()
      await expect(adopting).rejects.toThrow(/the store log became unreadable/)
      // The failed barrier dropped it — and lost nothing: the facts are the store's,
      // so the next delivery states the same message under the same identity.
      expect(h.relayed).toEqual([])
      expect(await h.runtime.redeliverBatchResult(STORE, batchId)).toBe('delivered')
      expect(h.relayed.map(item => item.messageId)).toEqual([`m-batchend-${batchId}`])
    } finally {
      release.resolve()
      await adopting.catch(() => undefined)
      vi.restoreAllMocks()
    }
  })

  test('stops a waiting parent whose batch the run\'s accumulation does not hold, by name', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // The old state, written through the store's own service: the run waits on the
    // batch id the pre-K1 build derived from the task, with no consumption and no
    // members — which the store's own reducer accepts (the field's shape is all it
    // checks) and which this build must stop rather than guess an owner for.
    const oldBatchId = `b-${taskId}`
    await h.task.changeRunPhaseIn(STORE, taskId, runId, ROOT_SESSION, { phase: 'waiting_children', batchId: oldBatchId })
    expect((await h.task.snapshotIn(STORE)).runs[0]?.executionPhase).toBe('waiting_children')

    const report = await h.runtime.reconcileStore(STORE)
    const after = await h.task.snapshotIn(STORE)
    const run = after.runs[0]!
    expect(run.status).toBe('cancelled')
    expect(run.batches ?? []).toEqual([])
    const review = after.reviews.find(item => item.runId === runId)!
    expect(review.outcome).toBe('cancelled')
    expect(review.anomalies.join(' ')).toContain(oldBatchId)
    expect(review.anomalies.join(' ')).toContain('stopped old state')
    // Nothing was driven and no membership was invented for it.
    expect(h.spawned).toEqual([])
    expect(report.questionResumes).toEqual([])
    await expect(h.runtime.awaitBatch(STORE, oldBatchId)).rejects.toThrow(/is not recorded in store/)
    await expect(h.runtime.redeliverBatchResult(STORE, oldBatchId)).rejects.toThrow(/is not recorded in store/)
  })

  test('a child whose writes cannot be confirmed stopped fails the parent by name and hands nothing back', async () => {
    const h = harness({ config: { writeDrainTimeoutMs: 20 } })
    // A jobs service that reports one job the drain can never confirm: it is
    // armed after the batch started, so admission and the child's own run are
    // unaffected and the *child drain at the batch end* is what meets it.
    let armed = false
    h.ctx.jobs = {
      list: () => (armed ? [{ id: 'job-1', status: 'running' }] : []),
      kill: () => {},
      wait: async () => ({ status: 'running' }),
    }
    const { taskId, runId } = await createRoot(h)
    let releaseChild!: () => void
    const release = new Promise<void>(resolve => { releaseChild = resolve })
    h.setIdleBehavior(async sessionId => {
      await release
      await h.runtime.submitResult(sessionId, { summary: 'the child is done' })
    })

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    armed = true
    releaseChild()
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])

    // The batch end did not hand the run back: the phase is not persisted, the
    // gate is not opened, and the parent is failed with the convergence named —
    // "you may write again" is a promise only a confirmed stop can make.
    const parentRun = await h.task.runIn(STORE, runId)
    expect(parentRun.status).toBe('failed')
    expect(parentRun.executionPhase).toBe('waiting_children')
    expect(parentRun.batchId).toBe(batchId)
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).not.toBe('active')
    expect(h.runtime.gate.decide(ROOT_SESSION, 'write').allow).toBe(false)
    const phases = taskEvents(h)
      .filter(item => item.kind === 'RunPhaseChanged' && item.runId === runId)
      .map(item => (item.kind === 'RunPhaseChanged' ? item.payload.phase : undefined))
    expect(phases).toEqual(['waiting_children'])
    const record = (await h.task.snapshotIn(STORE)).reviews.find(review => review.runId === runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain('write convergence of the batch\'s children could not be confirmed')
    // Nothing was delivered as a batch result either: there is no result to hand
    // back while the checkout is unconfirmed.
    expect(h.relayed.some(item => item.messageId === `m-batchend-${batchId}`)).toBe(false)
  })

  test('the root budget refuses a batch whole, refuses a start past maxRuns, and is not reset by reopening the store', async () => {
    const h = harness({ config: { rootBudget: { maxRuns: 2 } } })
    const { taskId, runId } = await createRoot(h)

    // One recorded run (the root) plus two children would need three slots.
    await expect(decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })).rejects.toThrow(/would need 2 run slot/)

    let snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
    expect((await h.task.runIn(STORE, runId)).executionPhase).toBe('active')

    // A batch that fits is admitted, and the count is a store fact: a restarted
    // process counts the same runs. (The refused batch left one proposal in
    // flight, and re-sending the *same* one is answered from that record.)
    const reopened = harness({ config: { rootBudget: { maxRuns: 2 } } }, h.sessions)
    await reopened.task.openStore(STORE)
    await expect(reopened.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })).rejects.toThrow(/would need 2 run slot/)

    // A *different* batch is refused by name while that proposal is in flight
    // (K1 §1: one proposal per run at a time), with nothing recorded; withdrawing
    // it frees the run.
    const pendingOfRun = (await h.task.snapshotIn(STORE)).proposals!.all
      .filter(proposal => proposal.kind !== 'root' && proposal.identity.parentRunId === runId)
    expect(pendingOfRun.map(proposal => proposal.status)).toEqual(['ready'])
    const leftover = pendingOfRun[0]!
    await expect(h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'a different split',
      children: [childSpec('task a')],
    })).rejects.toThrow(/already has a proposal in flight/)
    expect((await h.task.snapshotIn(STORE)).proposals!.all
      .filter(proposal => proposal.kind !== 'root' && proposal.identity.parentRunId === runId)).toHaveLength(1)
    await h.runtime.cancelProposal(STORE, leftover.proposalId, ROOT_SESSION)

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'a different split',
      children: [childSpec('task a')],
    })
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs).toHaveLength(2)
  })

  test('a second batch reserves against the same root budget: it accumulates across batches and survives a reopen', async () => {
    const h = harness({ config: { rootBudget: { maxRuns: 3 } } })
    const { taskId, runId } = await createRoot(h)

    const first = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the first round',
      children: [childSpec('task a')],
    })
    expect(first.map(outcome => outcome.status)).toEqual(['verified'])
    // The batch ended and the run took execution back, with its member
    // accumulated (K1 §1/§4): the second batch is a new admission against the
    // same root budget.
    const handedBack = await h.task.runIn(STORE, runId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.batches?.map(batch => batch.memberTaskIds.length)).toEqual([1])

    const second = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the second round',
      children: [childSpec('task b')],
    })
    expect(second.map(outcome => outcome.status)).toEqual(['verified'])
    const accumulated = await h.task.runIn(STORE, runId)
    expect(accumulated.batches?.map(batch => batch.memberTaskIds.length)).toEqual([1, 1])
    expect(accumulated.batches?.[1]?.memberTaskIds).not.toEqual(accumulated.batches?.[0]?.memberTaskIds)

    // The reservation is cumulative and measured against the store: three runs
    // are recorded, so a third batch would need a fourth slot. The refusal is
    // whole and carries no side effect; and because the count is a store fact, a
    // process that reopens the store counts exactly the same.
    const before = await h.task.snapshotIn(STORE)
    await expect(decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the third round',
      children: [childSpec('task c')],
    })).rejects.toThrow(/would need 1 run slot\(s\) and the root budget allows 3 run\(s\) in total, of which 3 are already recorded/)
    const reopened = harness({ config: { rootBudget: { maxRuns: 3 } } }, h.sessions)
    await reopened.task.openStore(STORE)
    await expect(reopened.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'the third round',
      children: [childSpec('task c')],
    })).rejects.toThrow(/run slot/)
    const after = await h.task.snapshotIn(STORE)
    expect(after.runs).toHaveLength(3)
    expect(after.tasks.map(task => task.taskId).sort()).toEqual(before.tasks.map(task => task.taskId).sort())
    expect(h.spawned).toHaveLength(2)
  })

  test('a root deadline that has already passed refuses to start the child, naming the deadline', async () => {
    // The deadline is measured from the root run's own persisted `startedAt`, so
    // a wall time that has already elapsed refuses every start: no run begins
    // under it, and the child that never started is blocked with the limit named
    // (the store's own shape for a task with no run).
    const h = harness({ config: { rootBudget: { wallTimeMs: 5 } } })
    const { taskId, runId } = await createRoot(h)
    await vi.waitFor(async () => {
      const root = await h.task.runIn(STORE, runId)
      expect(Date.now() - Date.parse(root.startedAt)).toBeGreaterThan(5)
    })

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked'])
    expect(h.spawned).toHaveLength(0)
    const snapshot = await h.task.snapshotIn(STORE)
    const blocked = snapshot.reviews.find(item => item.taskId !== taskId)!
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.anomalies.join(' ')).toContain('deadline')
    expect(blocked.anomalies.join(' ')).toContain("no new run starts under this budget")
  })

  test('a deadline that expires while a child runs fails it as a budget exhaustion and stops its worker', async () => {
    // Long enough to admit and start the run, short enough to fire while the
    // worker is still working: the run's own budget is `min(per-run wall time,
    // what is left of the root's)` (A3 §3.5).
    const h = harness({ config: { rootBudget: { wallTimeMs: 60 } } })
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.taskId !== taskId)!
    expect(childRun.status).toBe('failed')
    const record = snapshot.reviews.find(item => item.runId === childRun.runId)!
    expect(record.localizedCause).toContain('budget exhausted: wallTimeMs')
    expect(record.localizedCause).toContain('not a criteria failure')
    // A forced exit: the worker was cancelled, not left writing into a run that
    // is already settled.
    expect(h.cancelled).toEqual([childRun.sessionId])
    // And the parent is not accepted after its own root deadline: the batch's
    // settlement cancels it with the budget named rather than judging it.
    expect((await h.task.runIn(STORE, runId)).status).toBe('cancelled')
  })

  test('a parent whose own wall clock ran out is not accepted by its batch: it is cancelled as the budget stop it is', async () => {
    // The deployment's per-run wall time (`Config.budget`) is what this tree runs
    // under, and the child is the slow one: it settles on its own clock *after* the
    // parent's has run out. That is exactly the moment every child is terminal and
    // the batch would otherwise accept the parent — an acceptance the budget never
    // allowed (§3.5), which would report work the clock had already stopped as
    // `verified`.
    const h = harness({ config: { budget: { wallTimeMs: 250 } } })
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('the child that never finishes')],
    })

    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.taskId !== taskId)!
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    // The child died of its own clock, named as the budget stop it is …
    expect(childRun.status).toBe('failed')
    expect(snapshot.reviews.find(item => item.runId === childRun.runId)!.localizedCause).toContain('budget exhausted: wallTimeMs')
    // … and the parent is not accepted after its own: the batch cancels it, naming
    // the bound that ended it, instead of judging it.
    expect((await h.task.runIn(STORE, runId)).status).toBe('cancelled')
    const parentRecord = snapshot.reviews.find(item => item.runId === runId)!
    expect(parentRecord.outcome).toBe('cancelled')
    const parentReason = [parentRecord.localizedCause ?? '', ...parentRecord.anomalies].join(' ')
    expect(parentReason).toContain('budget exhausted: wallTimeMs')
    expect(parentReason).toContain('passed before this batch could be accepted')
    expect(parentReason).toContain('250ms from its own startedAt')
    expect(parentReason).toContain('not a criteria failure')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('cancelled')
  })

  test('a second root on one checkout is refused before anything is written, and ownership is released when the tree settles', async () => {
    const checkoutRoot = checkout('a3-workspace')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const { taskId, runId } = await createRoot(h)

    // The same checkout for a second deployment entry: busy, with the holder
    // named, and nothing persisted.
    const other = harness({ config: { runBindingRoot: bindingRoot } })
    other.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    // That session's person asked for that tree: a root contract is intaken for a
    // session whose own log carries a request (A0 §1.10), and this case is about
    // the checkout, not about the origin rule.
    other.sessions.set('other-root', requestedSession('other-root', 'second tree'))
    await expect(other.runtime.intakeRootContract(
      rootTaskStoreId('other-root'),
      'other-root',
      rootContract('second tree'),
    )).rejects.toThrow(WorkspaceBusyError)
    // The refused activation wrote no root: the store holds no task and no run. The
    // proposal the attempt recorded is the one durable trace, and it is what makes
    // the retry the same request rather than a second one.
    const otherSnapshot = await other.task.snapshotIn(rootTaskStoreId('other-root'))
    expect(otherSnapshot.tasks).toHaveLength(0)
    expect(otherSnapshot.runs).toHaveLength(0)
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(1)

    // Decomposing under the holder works, and the batch's children hand the
    // checkout down one at a time.
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    // The batch ended and handed the checkout back to its parent, which still
    // holds it (K1 §2): the batch's layer is gone, the run's own remains.
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(1)
    await submitParentResult(h)
    // The tree is done: the root run released its own layer with the settlement,
    // so no ownership marker is left behind.
    await vi.waitFor(async () => expect(await ownershipMarkers(bindingRoot)).toHaveLength(0))
  })

  /**
   * The nested shape these cancellation cases are about: the root admits one
   * child, the child decomposes in turn (so its own run waits on grandchildren),
   * the first grandchild hangs forever, and the second one never starts because
   * it depends on the first. The child's worker then goes idle, which is exactly
   * the state the root's driver has to keep waiting in without losing the batch's
   * abort or its own deadline.
   */
  async function nestedBatch(h: Harness): Promise<{ rootTaskId: string; rootRunId: string; rootBatchId: string; childSession: string }> {
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.depth === 1) {
        await h.runtime.decomposeAndRun(STORE, bound.task.taskId, bound.run.runId, sessionId, {
          reason: 'split it again',
          children: [childSpec('grandchild one'), childSpec('grandchild two', { dependsOn: [0] })],
        })
        return
      }
      await new Promise<void>(() => {})
    })
    const { batchId: rootBatchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2))
    const childSession = h.spawned[0]!.sessionId
    await vi.waitFor(async () => {
      expect((await h.runtime.runForSession(childSession)).run.executionPhase).toBe('waiting_children')
    })
    return { rootTaskId, rootRunId, rootBatchId, childSession }
  }

  test('a batch cancellation reaches the nested batch its child waits on, and settles the whole shape', async () => {
    const h = harness()
    const shape = await nestedBatch(h)

    // The root's current child waits on its own batch, so the root's driver is
    // parked on that child's run: the cancellation must still be observed, and it
    // must reach the grandchild that is in flight as well (A3 §3.6: the child in
    // flight is stopped, the ones that never started are blocked before start).
    const outcomes = await h.runtime.cancelBatch(STORE, shape.rootBatchId, ROOT_SESSION)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])

    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.sessionId === shape.childSession)!
    expect(childRun.status).toBe('cancelled')
    expect(snapshot.reviews.find(review => review.runId === childRun.runId)?.outcome).toBe('cancelled')

    const grandchildren = snapshot.tasks.filter(task => task.parentTaskId === childRun.taskId)
    expect(grandchildren).toHaveLength(2)
    expect(grandchildren.map(task => task.status).sort()).toEqual(['blocked', 'cancelled'])
    const neverStarted = grandchildren.find(task => task.status === 'blocked')!
    expect(snapshot.reviews.find(review => review.taskId === neverStarted.taskId)?.anomalies.join(' '))
      .toContain('cancelled by the caller before this child started')

    expect((await h.task.runIn(STORE, shape.rootRunId)).status).toBe('cancelled')
    expect((await h.task.taskIn(STORE, shape.rootTaskId)).status).toBe('cancelled')
  })

  test('a graph cancellation settles the same nested shape, bounded', async () => {
    const h = harness()
    const shape = await nestedBatch(h)

    await h.runtime.cancelGraph(STORE, 'the graph is gone')

    const snapshot = await h.task.snapshotIn(STORE)
    expect((await h.task.taskIn(STORE, shape.rootTaskId)).status).toBe('cancelled')
    const childRun = snapshot.runs.find(run => run.sessionId === shape.childSession)!
    expect(childRun.status).toBe('cancelled')
    expect(snapshot.runs.every(run => run.status !== 'running')).toBe(true)
    expect(snapshot.tasks.every(task => task.status !== 'running')).toBe(true)
  })

  test('the run deadline bounds a wait on a child that is itself waiting on a nested batch', async () => {
    // Long enough to admit and start, short enough to fire while the root's
    // driver is parked on the child's `waiting_children` run.
    const h = harness({ config: { rootBudget: { wallTimeMs: 60 } } })
    const shape = await nestedBatch(h)

    const outcomes = await h.runtime.awaitBatch(STORE, shape.rootBatchId)
    // A budget stop, not an acceptance: the batch settles, no run is left
    // running under a tree that is over, and the child that was waiting ends
    // terminal with the exhaustion on its record.
    expect(['failed', 'cancelled']).toContain(outcomes[0]!.status)
    const snapshot = await h.task.snapshotIn(STORE)
    const childRun = snapshot.runs.find(run => run.sessionId === shape.childSession)!
    expect(['failed', 'cancelled']).toContain(childRun.status)
    const record = snapshot.reviews.find(review => review.runId === childRun.runId)!
    expect([record.localizedCause ?? '', ...record.anomalies].join(' ')).toContain('budget exhausted')
    await vi.waitFor(async () => {
      const current = await h.task.snapshotIn(STORE)
      expect(current.runs.every(run => run.status !== 'running')).toBe(true)
    })
    // And the root is not accepted after its own deadline.
    expect((await h.task.runIn(STORE, shape.rootRunId)).status).toBe('cancelled')
  })

  test('unload is not held up by a driver parked on a nested wait', async () => {
    const h = harness()
    await nestedBatch(h)

    // The unload path aborts every driver it owns; a driver parked on a child
    // that waits on its own batch must wake with the abort (A3 §3.6: the unload
    // waits for a bounded settlement, not for the tree to finish on its own).
    const unloading = (h.disposers[h.disposers.length - 1] as () => Promise<void>)()
    const bounded = await Promise.race([
      unloading.then(() => 'settled'),
      new Promise<string>(resolve => { setTimeout(() => resolve('hung'), 2_000).unref() }),
    ])
    expect(bounded).toBe('settled')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.every(run => run.status !== 'running')).toBe(true)
  })

  test('a verifier runs while the run\u2019s own store holds the workspace, and the verifier layer is on top', async () => {
    const checkoutRoot = checkout('a3-verifier-exclusive')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const registry = (h.runtime as unknown as { workspaces: WorkspaceRegistry }).workspaces
    // What the workspace looks like at the moment each verifier call runs: the
    // exclusive `verifier` layer must be on top of the stack (§3.4).
    const heldDuringVerification: string[] = []
    const inner = h.verifier.verifyRun
    h.verifier.verifyRun = vi.fn(async (storeId: string, runId: string) => {
      heldDuringVerification.push(registry.ownerOf(checkoutRoot)?.kind ?? 'none')
      return await inner(storeId, runId)
    })

    const { taskId, runId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // One verification for the child and one for the parent's own acceptance —
    // which the parent asks for itself (K1 §2) — each holding the workspace
    // exclusively.
    await submitParentResult(h)
    expect(heldDuringVerification).toEqual(['verifier', 'verifier'])
    // And no verifier layer is left behind: the tree's own settlement released the
    // workspace it held (§3.4: a terminal run releases its claim).
    expect(registry.ownerOf(checkoutRoot)).toBeUndefined()
  })

  test('a run whose workspace another store holds is not verified, and fails by name', async () => {
    const checkoutRoot = checkout('a3-verifier-conflict')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const registry = (h.runtime as unknown as { workspaces: WorkspaceRegistry }).workspaces
    const { taskId, runId } = await createRoot(h)

    // Another store's writer takes the checkout while this run is still active.
    const top = registry.ownerOf(checkoutRoot)!
    await registry.push(checkoutRoot, top, {
      kind: 'batch',
      storeId: rootTaskStoreId('someone-else'),
      batchId: 'b-someone-else',
      since: new Date().toISOString(),
    })

    const reply = await h.runtime.submitResult(ROOT_SESSION, { summary: 'done' })
    expect(reply.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const run = snapshot.runs.find(candidate => candidate.runId === runId)!
    expect(run.status).toBe('failed')
    const record = snapshot.reviews.find(review => review.runId === runId)!
    expect(record.outcome).toBe('failed')
    expect(record.localizedCause).toContain('cannot be verified')
    expect(record.localizedCause).toContain('held by')
    // The verifier never ran: no evidence was recorded for the run.
    expect(snapshot.evidence.filter(item => item.taskRunId === runId)).toHaveLength(0)
    void taskId
  })

  test('cancelGraph stops a replay this process is driving', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { taskId: rootTaskId } = await createRoot(h)
    // A terminal champion to replay: a verified task with its own run.
    const championTaskId = 't-champion'
    const championRunId = 'r-champion'
    await h.task.createTaskIn(STORE, {
      taskId: championTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'champion work',
      depth: 0,
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: ['research'],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, championTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId: championRunId,
      taskId: championTaskId,
      sessionId: 's-champion',
      capabilitySnapshot: [],
      executionPhase: 'active',
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verifying', 'tester')
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: `e-${championRunId}`,
      taskRunId: championRunId,
      taskId: championTaskId,
      artifacts: [],
      verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verified', 'tester')

    // A replay is a driver like a batch is: the runtime owns its progress, so a
    // graph cancellation stops it (A3 §3.6/§3.7).
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const replay = h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p2' }, ROOT_SESSION)
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    await h.runtime.cancelGraph(STORE, 'graph removed')

    expect((await replay).status).toBe('cancelled')
    const snapshot = await h.task.snapshotIn(STORE)
    const replayRun = snapshot.runs.find(run => run.taskId !== rootTaskId && run.taskId !== championTaskId)!
    expect(replayRun.status).toBe('cancelled')
    expect(snapshot.reviews.find(item => item.runId === replayRun.runId)).toBeDefined()
  })

  test('unload aborts the drivers it owns and settles the batch before it lets go', async () => {
    const checkoutRoot = checkout('a3-unload')
    const bindingRoot = join(checkoutRoot, 'bindings')
    const h = harness({ config: { runBindingRoot: bindingRoot } })
    h.ctx.envBuilder = { store: { get: () => ({ path: checkoutRoot }) } }
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(1)

    // The unload path (A3 §3.6): every driver is aborted and awaited, the gate is
    // closed for the sessions this process tracked, and the markers this process
    // wrote are released — in that order, so nothing writes into a checkout that
    // has already been handed back.
    //
    // Only the runtime's own effect runs here: the harness registers the task
    // service's close effect on the same context first, and cordis disposes
    // effects in reverse registration order, so a full disposal would close the
    // store before the runtime's unload could settle anything.
    await (h.disposers[h.disposers.length - 1] as () => Promise<void>)()

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.find(run => run.taskId !== taskId)!.status).toBe('cancelled')
    expect((await h.task.runIn(STORE, runId)).status).toBe('cancelled')
    expect(await ownershipMarkers(bindingRoot)).toHaveLength(0)
    // The batch's own outcomes are derivable from the store after the driver is
    // gone: the registration is a cache, the store is the truth.
    expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['cancelled'])
  })

  test('recovery: an in-flight worker is cancelled with the diagnostic, and its batch resumes without re-spawning it', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // A worker that never submits, then a process that dies: the runtime is
    // abandoned (no dispose), and a second harness reopens the same session log.
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('first child'), childSpec('second child')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const crashedSession = h.spawned[0]!.sessionId
    const crashedRunId = (await h.task.snapshotIn(STORE)).runs.find(run => run.taskId !== taskId)!.runId

    const restarted = harness({}, h.sessions)
    await restarted.task.openStore(STORE)
    await restarted.runtime.reconcileStore(STORE)

    const snapshot = await restarted.task.snapshotIn(STORE)
    const crashed = snapshot.runs.find(run => run.runId === crashedRunId)!
    expect(crashed.status).toBe('cancelled')
    const record = snapshot.reviews.find(item => item.runId === crashedRunId)!
    expect(record.outcome).toBe('cancelled')
    expect(record.anomalies.join(' ')).toContain('recovery')
    // The batch resumed: the second child ran (once), and the parent settled.
    await vi.waitFor(() => expect(restarted.spawned).toHaveLength(1))
    expect(restarted.spawned[0]!.sessionId).not.toBe(crashedSession)
    const settled = await restarted.runtime.awaitBatch(STORE, batchId)
    expect(settled.map(outcome => outcome.status)).toEqual(['cancelled', 'verified'])
    // The resumed batch ended the same way a first-run batch does: the parent is
    // active again with the batch's result delivered to it.
    const resumed = await restarted.task.runIn(STORE, runId)
    expect(resumed.status).toBe('running')
    expect(resumed.executionPhase).toBe('active')
    expect(restarted.relayed.find(item => item.messageId === `m-batchend-${batchId}`)?.text).toContain('task_submit_result')
    expect((await restarted.runtime.submitResult(ROOT_SESSION, { summary: 'the parent reports what the batch delivered' })).status).toBe('verified')
    expect((await restarted.task.runIn(STORE, runId)).status).toBe('verified')
  })

  test('recovery: a child that got its own batch back is waited for, not cancelled as an abandoned worker', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    // The child's own worker decomposes for real and stops there: the crash lands
    // with the child `active` and its own batch on its record — a delegated parent
    // the dead process could not finish telling (K1 §2, §5), not a worker that
    // abandoned its work.
    let childRunId = ''
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.depth !== 1) {
        await h.runtime.submitResult(sessionId, { summary: 'grandchild work done' })
        return
      }
      childRunId = bound.run.runId
      await decomposeAndSettle(h, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the work turned out not to be atomic',
        children: [childSpec('grandchild work')],
      })
      // The worker never goes idle again: the crash lands with it holding the
      // decision its own batch handed back, before the no-progress rule could read
      // that as stagnation (a killed process observes nothing).
      return await new Promise<void>(() => {})
    })
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a', { decomposable: true })],
    })
    const childBatchId = await vi.waitFor(async () => {
      const run = await h.task.runIn(STORE, childRunId)
      expect(run.executionPhase).toBe('active')
      expect(run.batches).toHaveLength(1)
      return (run.batches ?? [])[0]!.batchId
    })
    expect(h.spawned).toHaveLength(2)

    // The process dies, and the restart drives the parent's batch again.
    const restarted = harness({}, h.sessions)
    await restarted.task.openStore(STORE)
    await restarted.runtime.reconcileStore(STORE)

    // The child is handed back its own execution *and awaited*: the pass re-derives
    // the message its batch owes it (the relay is asked for exactly that identity),
    // and the parent's driver waits for the run instead of cancelling it — the
    // "in flight when the batch resumed" diagnostic the old branch wrote must not
    // appear.
    const driverWait = restarted.runtime.awaitBatch(STORE, batchId)
    const relay = (restarted.ctx as unknown as { agentRuntime: { ensureAgentMessageDelivered: ReturnType<typeof vi.fn> } }).agentRuntime.ensureAgentMessageDelivered
    await vi.waitFor(() => expect(relay).toHaveBeenCalledWith(expect.objectContaining({ messageId: `m-batchend-${childBatchId}` })))
    const held = await restarted.task.snapshotIn(STORE)
    const child = held.runs.find(run => run.runId === childRunId)!
    expect(child.status).toBe('running')
    expect(child.batchId).toBeUndefined()
    expect(held.reviews.some(review => review.runId === childRunId)).toBe(false)
    expect((await restarted.task.runIn(STORE, runId)).executionPhase).toBe('waiting_children')

    // The wait ends the way every other worker wait does — by the batch being
    // cancelled — and the child's own cancellation is that one, not a recovery
    // branch's: the message names the batch, never "was in flight when batch".
    await restarted.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
    expect((await driverWait).map(outcome => outcome.status)).toEqual(['cancelled'])
    const cancelled = await restarted.task.snapshotIn(STORE)
    expect(cancelled.runs.find(run => run.runId === childRunId)?.status).toBe('cancelled')
    const review = cancelled.reviews.find(item => item.runId === childRunId)!
    expect(review.anomalies.join(' ')).toContain('the batch was cancelled')
    expect(review.anomalies.join(' ')).not.toContain('was in flight when batch')
  })

  test('recovery: a submitted run is verified, and a run without a phase is left exactly as it is', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)

    // (a) A run that submitted before the process died: the phase is the whole
    // recovery evidence, so it is verified.
    const submittedTaskId = 't-submitted'
    const submittedRunId = 'r-submitted'
    await h.task.createTaskIn(STORE, {
      taskId: submittedTaskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: taskId,
      objective: 'submitted work',
      depth: 1,
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, submittedTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId: submittedRunId,
      taskId: submittedTaskId,
      sessionId: 's-submitted',
      capabilitySnapshot: [],
      executionPhase: 'active',
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.changeRunPhaseIn(STORE, submittedTaskId, submittedRunId, 'tester', {
      phase: 'submitted',
      submission: { summary: 'handed in before the crash', evidenceRefs: [], submittedAt: new Date().toISOString(), origin: 'worker' },
    })

    // (b) An old record with no phase at all: the read side derives
    // needs-recovery from that, and nothing here may invent a phase for it.
    const phaselessTaskId = 't-phaseless'
    const phaselessRunId = 'r-phaseless'
    await h.task.createTaskIn(STORE, {
      taskId: phaselessTaskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: taskId,
      objective: 'old record',
      depth: 1,
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, phaselessTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId: phaselessRunId,
      taskId: phaselessTaskId,
      sessionId: 's-phaseless',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')

    await h.runtime.reconcileStore(STORE)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.find(run => run.runId === submittedRunId)!.status).toBe('verified')
    expect(snapshot.reviews.filter(item => item.runId === submittedRunId)).toHaveLength(1)
    expect(snapshot.runs.find(run => run.runId === phaselessRunId)!.status).toBe('running')
    expect(snapshot.runs.find(run => run.runId === phaselessRunId)!.executionPhase).toBeUndefined()
    expect(snapshot.reviews.filter(item => item.runId === phaselessRunId)).toHaveLength(0)
    // And admission refuses to build on it: a phase-less run's only continuation
    // is cancellation.
    await expect(h.runtime.decomposeAndRun(STORE, phaselessTaskId, phaselessRunId, 's-phaseless', {
      reason: 'split the old record',
      children: [childSpec('child')],
    })).rejects.toThrow(/predates coordination phases/)
    void runId
  })

  /**
   * A run a previous process left in flight, written through the store service —
   * the recovery path's subject, in a store this process is also driving.
   */
  async function deadWorkerRun(h: Harness, parentTaskId: string, label: string): Promise<{ taskId: string; runId: string }> {
    const taskId = `t-${label}`
    const runId = `r-${label}`
    await h.task.createTaskIn(STORE, {
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId,
      objective: label,
      depth: 1,
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, taskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId,
      taskId,
      sessionId: `s-${label}`,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      executionPhase: 'active',
      startedAt: new Date().toISOString(),
    }, 'tester')
    return { taskId, runId }
  }

  test('recovery on a store it cannot read reports and changes nothing', async () => {
    const h = harness()
    const { runId } = await createRoot(h)
    // The store's log cannot be read (the deployment's storage is gone): recovery
    // has nothing to act on, so it says so and writes nothing — an error that
    // silently looked like a clean pass would be worse than the failure.
    const original = h.task.snapshotIn.bind(h.task)
    let attempts = 0
    h.task.snapshotIn = async () => { attempts += 1; throw new Error('the log is unreadable') }
    // `reconcileStore` now answers with the proposals it could not finish
    // (T2/T3 §5), the question deliveries it owes and the question-waiting
    // workers it tried to bring back (A4 §F.1 — empty here, since the store could
    // not even be read), so "nothing was reconciled" is the empty report — and the
    // read is still attempted exactly once, before anything at all is touched.
    await expect(h.runtime.reconcileStore(STORE)).resolves.toEqual({ unresolvedProposals: [], questionDeliveries: [], questionResumes: [] })
    h.task.snapshotIn = original
    expect(attempts).toBe(1)
    expect((await h.task.runIn(STORE, runId)).status).toBe('running')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.reviews).toHaveLength(0)
  })

  test('recovery settles a run a dead process left in the store even while this process drives a batch', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    h.setIdleBehavior(() => new Promise<void>(() => {}))
    const { batchId } = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('live child')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const liveChild = await h.runtime.runForSession(h.spawned[0]!.sessionId)
    // A run from a process that is gone: this process never spawned its session.
    const dead = await deadWorkerRun(h, taskId, 'dead-worker')

    // The recovery pass (the entry a store adoption runs). A store this process
    // is driving is not one to settle wholesale: the runs a driver owns stay
    // live, and the runs nobody holds are still settled by the phase machine.
    await h.runtime.reconcileStore(STORE)

    const snapshot = await h.task.snapshotIn(STORE)
    expect((await h.task.runIn(STORE, liveChild.run.runId)).status).toBe('running')
    expect((await h.task.runIn(STORE, liveChild.run.runId)).executionPhase).toBe('active')
    expect(snapshot.reviews.filter(review => review.runId === liveChild.run.runId)).toHaveLength(0)
    const settled = snapshot.runs.find(run => run.runId === dead.runId)!
    expect(settled.status).toBe('cancelled')
    expect(snapshot.reviews.find(review => review.runId === dead.runId)?.outcome).toBe('cancelled')
    await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)
  })

  test('recovery settles a dead process\u2019s run even while this process drives a replay of the same store', async () => {
    const h = harness({ config: { capabilities: { research: { preset: 'standard' } } } })
    const { taskId, runId } = await createRoot(h)
    // A verified champion to replay: the replay's worker never returns, so its
    // driver is in flight for the whole case.
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.taskId !== taskId) await new Promise<void>(() => {})
    })
    const championTaskId = 't-champion'
    const championRunId = 'r-champion'
    await h.task.createTaskIn(STORE, {
      taskId: championTaskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: taskId,
      objective: 'champion work',
      depth: 1,
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it holds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await h.task.admitTaskIn(STORE, championTaskId, 'tester', { decompositionStatus: 'leaf' })
    await h.task.startRunIn(STORE, {
      runId: championRunId,
      taskId: championTaskId,
      sessionId: 's-champion',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verifying', 'tester')
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: `e-${championRunId}`,
      taskRunId: championRunId,
      taskId: championTaskId,
      artifacts: [],
      verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 'tester')
    await h.task.markRunStatusIn(STORE, championTaskId, championRunId, 'verified', 'tester')

    const replaying = h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p1' }, ROOT_SESSION)
    replaying.catch(() => {})
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const replayRun = await h.runtime.runForSession(h.spawned[0]!.sessionId)
    const dead = await deadWorkerRun(h, taskId, 'dead-worker')

    await h.runtime.reconcileStore(STORE)

    const snapshot = await h.task.snapshotIn(STORE)
    // The replay this process drives is left alone...
    expect((await h.task.runIn(STORE, replayRun.run.runId)).status).toBe('running')
    expect(snapshot.reviews.filter(review => review.runId === replayRun.run.runId)).toHaveLength(0)
    // ...and the run nobody holds is settled by the phase machine.
    expect(snapshot.runs.find(run => run.runId === dead.runId)!.status).toBe('cancelled')
    expect(snapshot.reviews.find(review => review.runId === dead.runId)?.outcome).toBe('cancelled')
    await expect(h.runtime.cancelGraph(STORE, 'probe cleanup')).resolves.toBeUndefined()
    void runId
  })
})
