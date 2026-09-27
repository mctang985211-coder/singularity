import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Diagnosis, EvidenceBundle, TaskInstance, TaskRun } from '../../../task/src/index.ts'
import { TaskService, budgetExtensionRequestDigest, rootTaskStoreId, runMemberTaskIds } from '../../../task/src/index.ts'
import { VerifierRegistry } from '../../../verifier/src/index.ts'
import type { CapabilityConfig, Config, RootRecoveryRequest } from '../../src/index.ts'
import { TaskRuntime } from '../../src/index.ts'

/** The temporary evidence roots this file minted, removed after each test. */
const directories: string[] = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/**
 * The recovery entry's own rules (A6 §F.4), at the level the entry lives:
 * everything here goes through `TaskRuntime.recoverRootTask` over the real task
 * store, and every conclusion is read back from the store's own snapshot or from
 * the refusal the call produced.
 *
 * What this file is *not*: the end-to-end attempt. That a new attempt runs, reads
 * a passed sibling's evidence instead of re-running it, and is judged by the
 * original acceptance criteria is `tests/integration/a6-recovery.spec.ts`'s
 * subject, over the real loop, the real batch driver and the real verifier. Here
 * the attempt's worker is a stub — the entry's spawn is the only thing replaced —
 * because what is under test is *which* attempt the entry opens, when it refuses
 * to open one, and what the store holds afterwards.
 */

const NOW = '2026-09-28T00:00:00.000Z'
const ROOT_SESSION = 'root-session'
const SUPERVISOR = 'supervisor-session'
const STORE = rootTaskStoreId(ROOT_SESSION)

interface StoredSession {
  readonly header: SessionHeader
  events: SessionEvent[]
}

/** One attempt's worker, as the spawn returned it — the stub every positive case reuses. */
interface SpawnCall {
  parent: unknown
  request: { sessionId: string; name: string; taskWorker?: boolean; agentPreset?: string; cwd?: string }
}

/**
 * A deployment with one root session, a task store the runtime opens through the
 * real service, and a caller session whose agent is live (a spawn needs a parent).
 * The model loop is not mounted: `agentRuntime.spawn` records and answers, which
 * is the boundary the entry's own rules stop at.
 */
function harness(options: { config?: Partial<Config>; sessions?: Map<string, StoredSession>; verifier?: boolean } = {}) {
  const sessions = options.sessions ?? new Map<string, StoredSession>()
  const disposers: Array<() => unknown> = []
  const spawns: SpawnCall[] = []
  const resumed: string[] = []
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
  const graphs = {
    graphForSession: vi.fn(async (sessionId: string) => ({
      id: 'g1',
      rootSessionId: sessionId === SUPERVISOR ? ROOT_SESSION : sessionId,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    })),
  }
  /**
   * The sessions this process image holds live: the caller, and every session its
   * own spawns created. A reopened process holds neither — that difference is
   * exactly what "the run nobody in this process holds" means — so the resume
   * door is the one that has to bring a session back.
   */
  const liveSessions = new Set<string>([SUPERVISOR])
  const agents = {
    get: (id: string) => (liveSessions.has(id) ? { id, followup: () => {} } : undefined),
  }
  const agentRuntime = {
    spawn: vi.fn(async (parent: unknown, request: SpawnCall['request']) => {
      spawns.push({ parent, request })
      // The session a spawn creates is durable, as the real one is: a reopened
      // process reads it back and brings it under its own identity.
      sessions.set(request.sessionId, {
        header: { id: request.sessionId, createdAt: NOW, updatedAt: NOW } as SessionHeader,
        events: [],
      })
      liveSessions.add(request.sessionId)
      return { id: request.sessionId, agent: { id: request.sessionId } }
    }),
    resumeWorkerAgent: vi.fn(async (request: { sessionId: SessionId }) => {
      resumed.push(String(request.sessionId))
      liveSessions.add(String(request.sessionId))
      return { id: String(request.sessionId), agent: { id: String(request.sessionId) } }
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
    graphs,
    agents,
    agentRuntime,
  }
  const task = new TaskService(ctx as never)
  ctx.task = task
  if (options.verifier === true) {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'a6-recovery-evidence-'))
    directories.push(evidenceRoot)
    ctx.verifier = new VerifierRegistry(ctx as never, { evidenceRoot })
  }
  const runtime = new TaskRuntime(ctx as never, options.config as Config | undefined)
  return { ctx, task, runtime, sessions, disposers, spawns, resumed }
}

type Harness = ReturnType<typeof harness>

/** The refusal one call gets — or a message saying it was accepted instead. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    const value = await call()
    throw new Error(`the call was accepted: ${JSON.stringify(value)}`)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function criterion(criterionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { criterionId, description: `${criterionId} holds`, command: 'true', ...extra }
}

/** The root contract every case starts from: one command criterion and the map position 1 rests on. */
function rootTask(overrides: Partial<TaskInstance> = {}): TaskInstance {
  const acceptanceCriteria = [
    { criterionId: 'root-goal', description: 'the goal is delivered', verificationMode: 'deterministic' as const, requiredEvidence: [], mandatory: true, command: 'true' },
    {
      criterionId: 'root-map',
      description: 'the members the map names passed',
      verificationMode: 'composite' as const,
      requiredEvidence: [],
      mandatory: true,
      childEvidence: [{ childIndex: 0, criterionId: 'child-0' }, { childIndex: 1, criterionId: 'child-1' }],
    },
  ]
  return {
    taskId: 'root',
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'ship the release',
    depth: 0,
    acceptanceCriteria,
    requestedCapabilities: [],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract: {
      contractVersion: 1,
      objective: 'ship the release',
      acceptanceCriteria: acceptanceCriteria as never,
      assumptions: [],
      constraints: [],
      requiredCapabilities: [],
    },
    ...overrides,
  }
}

function run(runId: string, taskId: string, sessionId = ROOT_SESSION, extra: Partial<TaskRun> = {}): TaskRun {
  return {
    runId,
    taskId,
    sessionId,
    capabilitySnapshot: [],
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...extra,
  }
}

const MANIFEST = { capabilities: {}, missing: [], closure: 'closed' as const }

/** One passed sibling of the failed attempt: a child task, its verified run and the bundle it left. */
function passedSibling(childId: string, verdict: 'pass' | 'fail' = 'pass'): { task: TaskInstance; run: TaskRun; bundle: EvidenceBundle } {
  const task: TaskInstance = {
    taskId: childId,
    definitionRef: { taskType: 'child', version: 1 },
    parentTaskId: 'root',
    objective: childId,
    depth: 1,
    acceptanceCriteria: [{ ...criterion('child-0'), verificationMode: 'deterministic' } as never],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }
  const childRun = run(`r-${childId}`, childId, `s-${childId}`)
  const bundle: EvidenceBundle = {
    evidenceId: `e-${childId}`,
    taskRunId: `r-${childId}`,
    taskId: childId,
    artifacts: [{ artifactId: `a-${childId}`, kind: 'report', path: 'out/report.md' }],
    verifierResults: [{ criterionId: 'child-0', status: verdict, verifierId: 'command' }],
    claims: [],
    generatedAt: NOW,
  }
  return { task, run: childRun, bundle }
}

function diagnosis(diagnosisId: string, taskId = 'root'): Diagnosis {
  return {
    diagnosisId,
    taskId,
    observedFailure: 'the second member never verified',
    scope: 'the root goal of this store',
    localizedCause: 'the capability the second member needed was missing',
    evidenceRefs: ['e-x'],
    reviewRefs: [],
    confidence: 'high',
    proposals: [],
  }
}

/**
 * The store every case starts from: the root task admitted with a contract, the
 * first attempt's run (the named source), the passed sibling at position 0, and
 * a diagnosis for the task. The root's run is settled `failed` — the state a
 * recovery is asked for — and the sibling keeps its own verified run and
 * evidence, exactly as the failed attempt left them.
 */
async function storeWithFailedRoot(
  h: Harness,
  options: { sibling?: boolean; diagnosisId?: string; capability?: string; productReference?: string } = {},
): Promise<{ sibling: ReturnType<typeof passedSibling>; diagnosisId: string }> {
  const sibling = passedSibling('child-0')
  const diagnosisId = options.diagnosisId ?? 'd-1'
  const base = rootTask()
  const withReference = options.productReference === undefined
    ? base
    : {
        ...base,
        acceptanceCriteria: base.acceptanceCriteria.map((criterion, index) => index === 0
          ? { ...criterion, requiresArtifact: [options.productReference] }
          : criterion),
        contract: {
          ...base.contract!,
          acceptanceCriteria: base.contract!.acceptanceCriteria.map((criterion, index) => index === 0
            ? { ...criterion, requiresArtifact: [options.productReference] }
            : criterion),
        },
      }
  const root = options.capability === undefined
    ? withReference
    : {
        ...withReference,
        requestedCapabilities: [options.capability],
        contract: { ...withReference.contract!, requiredCapabilities: [options.capability] },
      }
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, root, 'test')
  await h.task.admitTaskIn(STORE, 'root', 'test', { manifest: MANIFEST })
  if (options.sibling !== false) {
    await h.task.createTaskIn(STORE, sibling.task, 'test')
    await h.task.admitTaskIn(STORE, 'child-0', 'test', { manifest: MANIFEST })
    await h.task.startRunIn(STORE, sibling.run, 'test')
    await h.task.recordEvidenceIn(STORE, sibling.bundle, 'test')
    await h.task.markRunStatusIn(STORE, 'child-0', sibling.run.runId, 'verifying', 'test')
    await h.task.markRunStatusIn(STORE, 'child-0', sibling.run.runId, 'verified', 'test')
  }
  await h.task.startRunIn(STORE, run('r-first', 'root', ROOT_SESSION, { executionPhase: 'active' }), 'test')
  await h.task.markRunStatusIn(STORE, 'root', 'r-first', 'failed', 'test', { reason: 'the second member never verified' })
  await h.task.recordDiagnosisIn(STORE, diagnosis(diagnosisId), 'test')
  return { sibling, diagnosisId }
}

/** The store whose root task verified: the success case, with no failure to recover. */
async function storeWithVerifiedRoot(h: Harness): Promise<void> {
  await h.task.createStore(STORE)
  await h.task.createTaskIn(STORE, rootTask(), 'test')
  await h.task.admitTaskIn(STORE, 'root', 'test', { manifest: MANIFEST })
  await h.task.startRunIn(STORE, run('r-first', 'root'), 'test')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: 'e-root',
    taskRunId: 'r-first',
    taskId: 'root',
    artifacts: [],
    verifierResults: [{ criterionId: 'root-goal', status: 'pass', verifierId: 'command' }],
    claims: [],
    generatedAt: NOW,
  }, 'test')
  await h.task.markRunStatusIn(STORE, 'root', 'r-first', 'verifying', 'test')
  await h.task.markRunStatusIn(STORE, 'root', 'r-first', 'verified', 'test')
  await h.task.recordDiagnosisIn(STORE, diagnosis('d-1'), 'test')
}

/** The reuse declaration a case declares: position 0, the passed sibling, its own run and bundle. */
function reuse(sibling: ReturnType<typeof passedSibling>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childIndex: 0,
    taskId: sibling.task.taskId,
    sourceRunId: sibling.run.runId,
    evidenceId: sibling.bundle.evidenceId,
    criterionId: 'child-0',
    artifactRefs: [`a-${sibling.task.taskId}`],
    ...overrides,
  }
}

function request(overrides: Partial<RootRecoveryRequest> = {}): RootRecoveryRequest {
  return {
    sourceTaskId: 'root',
    sourceRunId: 'r-first',
    sourceDiagnosisId: 'd-1',
    requestKey: 'k-1',
    ...overrides,
  }
}

/** One call through the entry, with the supervisor whose agent is live. */
async function recover(h: Harness, overrides: Partial<RootRecoveryRequest> = {}, caller = SUPERVISOR) {
  return await h.runtime.recoverRootTask(STORE, request(overrides), { sessionId: caller })
}

/** The runs one store holds for a task, in start order. */
async function runsOf(h: Harness, taskId: string): Promise<TaskRun[]> {
  return (await h.task.snapshotIn(STORE)).runs.filter(item => item.taskId === taskId)
}

describe('A6 recovery entry: the attempt it opens', () => {
  test('opens one new root run in a new session, records the attempt, and leaves the failed facts alone', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const before = await h.task.snapshotIn(STORE)
    const outcome = await recover(h)
    expect(outcome.attempt).toBe('started')
    expect(outcome.sourceTaskId).toBe('root')
    expect(outcome.status).toBe('running')
    const after = await h.task.snapshotIn(STORE)
    // The old attempt is untouched: the same children and the same evidence, and
    // the root's old run is still the failed one it was. The root task itself
    // moves exactly as a retry moves it — `failed` → `running` with one more run
    // id — and nothing else about it changes.
    const rootOf = (snapshot: typeof before) => snapshot.tasks.find(item => item.taskId === 'root')
    expect({ ...rootOf(after), status: 'failed', runIds: rootOf(before)?.runIds })
      .toEqual({ ...rootOf(before), status: 'failed', runIds: rootOf(before)?.runIds })
    expect(after.tasks.filter(item => item.taskId !== 'root')).toEqual(before.tasks.filter(item => item.taskId !== 'root'))
    expect(after.evidence).toEqual(before.evidence)
    expect(after.diagnoses).toEqual(before.diagnoses)
    expect(after.reviews).toEqual(before.reviews)
    expect(after.runs.find(item => item.runId === 'r-first')).toEqual(before.runs.find(item => item.runId === 'r-first'))
    // One new run, born active, in a new session, carrying the attempt record.
    const attemptRun = after.runs.find(item => item.runId === outcome.runId)
    expect(attemptRun?.taskId).toBe('root')
    expect(attemptRun?.sessionId).toBe(outcome.sessionId)
    expect(attemptRun?.sessionId).not.toBe(ROOT_SESSION)
    expect(attemptRun?.status).toBe('running')
    expect(attemptRun?.executionPhase).toBe('active')
    expect(attemptRun?.recovery?.sourceDiagnosisId).toBe('d-1')
    expect(attemptRun?.recovery?.requestKey).toBe('k-1')
    expect(attemptRun?.recovery?.sourceRunId).toBe('r-first')
    expect(attemptRun?.recovery?.reusedMembers).toEqual([])
    // Nothing is read at a position yet: the attempt has admitted no batch.
    expect(runMemberTaskIds(attemptRun!)).toEqual([])
    // The worker was spawned from the live caller, as a task worker, in the tree's checkout.
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]?.request.sessionId).toBe(outcome.sessionId)
    expect(h.spawns[0]?.request.taskWorker).toBe(true)
    // The store's own count moved by exactly one run: the ceiling is spent, not reset.
    expect(after.runs.length).toBe(before.runs.length + 1)
  })

  test('answers the same key and content with the same attempt, and writes nothing the second time', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const first = await recover(h)
    const after = await h.task.snapshotIn(STORE)
    const second = await recover(h)
    expect(second.attempt).toBe('existing')
    expect(second.runId).toBe(first.runId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(await h.task.snapshotIn(STORE)).toEqual(after)
    expect(h.spawns).toHaveLength(1)
  })

  test('reads an attempt in a new process from the store alone: the same key answers with the run the store holds', async () => {
    const sessions = new Map<string, StoredSession>()
    const first = harness({ sessions })
    await storeWithFailedRoot(first)
    const started = await recover(first)
    // A second process image over the same durable store: a new task service, a
    // new runtime, the same files.
    const second = harness({ sessions })
    await second.task.openStore(STORE)
    // The boot path first (A2's barrier): a store whose runs a dead process left
    // is recovery-required until the pass has reconciled it.
    await second.runtime.reconcileStore(STORE)
    const answered = await recover(second)
    expect(answered.attempt).toBe('existing')
    expect(answered.runId).toBe(started.runId)
    expect(answered.status).toBe('running')
    expect(second.spawns).toHaveLength(0)
  })

  test('refuses a new key while the diagnosis has an attempt in flight, before and after a restart', async () => {
    const sessions = new Map<string, StoredSession>()
    const first = harness({ sessions })
    await storeWithFailedRoot(first)
    const started = await recover(first, { requestKey: 'k-1' })
    const message = await refusal(() => recover(first, { requestKey: 'k-2' }))
    expect(message).toContain('already has a recovery attempt in flight')
    expect(message).toContain(started.runId)
    expect(await runsOf(first, 'root')).toHaveLength(2)
    // The refusal is a store fact: a reopened process refuses the same way.
    const second = harness({ sessions })
    await second.task.openStore(STORE)
    await second.runtime.reconcileStore(STORE)
    const reopened = await refusal(() => recover(second, { requestKey: 'k-2' }))
    expect(reopened).toContain('already has a recovery attempt in flight')
    expect(second.spawns).toHaveLength(0)
    expect(first.spawns).toHaveLength(1)
  })

  test('starts a new attempt under a new key once the previous attempt settled', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const first = await recover(h, { requestKey: 'k-1' })
    await h.task.markRunStatusIn(STORE, 'root', first.runId, 'failed', 'test', { reason: 'the attempt failed too' })
    const second = await recover(h, { requestKey: 'k-2' })
    expect(second.attempt).toBe('started')
    expect(second.runId).not.toBe(first.runId)
    expect(await runsOf(h, 'root')).toHaveLength(3)
  })
})

describe('A6 recovery entry: what it refuses, with no run started', () => {
  test('refuses a request whose shape is not a recovery request', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const message = await refusal(() => recover(h, { approved: true } as never))
    expect(message).toContain('unknown field "approved"')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a caller with no live agent, before anything exists', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    h.ctx.agents = { get: () => undefined }
    const message = await refusal(() => recover(h))
    expect(message).toContain('has no live agent')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a successful source', async () => {
    const h = harness()
    await storeWithVerifiedRoot(h)
    const message = await refusal(() => recover(h))
    expect(message).toContain('is verified')
    expect(message).toContain('a successful source is not recoverable')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a task this store does not hold, and one that is not the store’s root', async () => {
    const h = harness()
    const { sibling } = await storeWithFailedRoot(h)
    const missing = await refusal(() => recover(h, { sourceTaskId: 'other-store-task' }))
    expect(missing).toContain('holds no task "other-store-task"')
    const child = await refusal(() => recover(h, { sourceTaskId: 'child-0' }))
    expect(child).toContain('is a child of "root"')
    expect(await runsOf(h, 'root')).toHaveLength(1)
    expect((await h.task.snapshotIn(STORE)).tasks.find(item => item.taskId === 'child-0')?.status).toBe('verified')
  })

  test('refuses a run that is not the named source, and a source run that is not failed', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const unknown = await refusal(() => recover(h, { sourceRunId: 'r-nope' }))
    expect(unknown).toContain('holds no run "r-nope"')
    const sibling = await refusal(() => recover(h, { sourceRunId: 'r-child-0' }))
    expect(sibling).toContain('belongs to task "child-0"')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a diagnosis this store does not hold, and one about another task', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    const unknown = await refusal(() => recover(h, { sourceDiagnosisId: 'd-nope' }))
    expect(unknown).toContain('holds no diagnosis "d-nope"')
    await h.task.recordDiagnosisIn(STORE, diagnosis('d-other', 'child-0'), 'test')
    const mismatch = await refusal(() => recover(h, { sourceDiagnosisId: 'd-other' }))
    expect(mismatch).toContain('is about task "child-0"')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a key already bound to another attempt of the same diagnosis', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    await recover(h, { requestKey: 'k-1' })
    const message = await refusal(() => recover(h, { requestKey: 'k-1', sourceRunId: null }))
    expect(message).toContain('already names a recovery attempt')
    expect(await runsOf(h, 'root')).toHaveLength(2)
  })

  test('refuses when the capability row the attempt is for has not been applied', async () => {
    const h = harness({ config: { capabilities: {} } })
    await storeWithFailedRoot(h, { capability: 'cap-missing' })
    const message = await refusal(() => recover(h))
    expect(message).toContain('capability gap this attempt is for is still open')
    expect(message).toContain('cap-missing')
    expect(await runsOf(h, 'root')).toHaveLength(1)
    // Applying the row closes the gap: the same request is then an attempt.
    h.runtime.listCapabilities()
    await h.runtime.applyCapabilityRow('cap-missing', { skills: [] } as never)
    const started = await recover(h)
    expect(started.attempt).toBe('started')
    expect(await runsOf(h, 'root')).toHaveLength(2)
  })

  test('refuses above the effective ceiling and does not reset the count', async () => {
    const sessions = new Map<string, StoredSession>()
    const h = harness({ sessions, config: { rootBudget: { maxRuns: 2 } } })
    await storeWithFailedRoot(h)
    const message = await refusal(() => recover(h))
    expect(message).toContain('root budget')
    expect(message).toContain('allows 2 run(s)')
    expect(await runsOf(h, 'root')).toHaveLength(1)
    // Raising the ceiling through the ordinary store fact releases exactly one attempt.
    await h.task.recordBudgetExtensionIn(STORE, 'root', {
      requestKey: 'raise-1',
      requestDigest: budgetExtensionRequestDigest({ requestKey: 'raise-1', maxRuns: 4 }),
      maxRuns: { previous: 2, next: 4 },
      approvalRef: 'approval:call-1',
      requestedBy: ROOT_SESSION,
      baseline: { maxRuns: 2 },
    } as never, ROOT_SESSION)
    const started = await recover(h)
    expect(started.attempt).toBe('started')
    expect(await runsOf(h, 'root')).toHaveLength(2)
  })

  test('refuses a reuse whose position does not match the failed run', async () => {
    const h = harness()
    const { sibling } = await storeWithFailedRoot(h)
    const message = await refusal(() => recover(h, { reuses: [reuse(sibling, { childIndex: 1 }) as never] }))
    expect(message).toContain('childIndex')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a reuse whose sibling sits at another position of the failed run', async () => {
    const h = harness()
    const { sibling } = await storeWithFailedRoot(h)
    // The failed run reads child-0 at position 0. A declaration for position 1
    // citing child-0 has to be judged against the member the run reads there,
    // which is nobody: the position is not the sibling's.
    const message = await refusal(() => recover(h, {
      reuses: [reuse(sibling) as never, { ...reuse(sibling), childIndex: 1 } as never],
    }))
    expect(message).toContain('declared reuse does not resolve')
    expect(message).toContain('reuses[1]')
    expect(message).toContain('reads no member at position 1')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a reuse of a sibling that did not pass, and lists the affected item', async () => {
    const h = harness()
    const failedSibling = passedSibling('child-f', 'fail')
    await storeWithFailedRoot(h)
    await h.task.createTaskIn(STORE, failedSibling.task, 'test')
    await h.task.admitTaskIn(STORE, 'child-f', 'test', { manifest: MANIFEST })
    await h.task.startRunIn(STORE, failedSibling.run, 'test')
    await h.task.recordEvidenceIn(STORE, failedSibling.bundle, 'test')
    await h.task.markRunStatusIn(STORE, 'child-f', failedSibling.run.runId, 'verifying', 'test')
    await h.task.markRunStatusIn(STORE, 'child-f', failedSibling.run.runId, 'verified', 'test')
    const message = await refusal(() => recover(h, {
      reuses: [{
        childIndex: 0,
        taskId: 'child-f',
        sourceRunId: failedSibling.run.runId,
        evidenceId: failedSibling.bundle.evidenceId,
        criterionId: 'child-0',
      } as never],
    }))
    expect(message).toContain('declared reuse does not resolve')
    expect(message).toContain('failed run')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a citation whose evidence does not carry the verdict the map requires', async () => {
    const h = harness()
    const failedSibling = passedSibling('child-0', 'fail')
    await storeWithFailedRoot(h, { sibling: false })
    await h.task.createTaskIn(STORE, failedSibling.task, 'test')
    await h.task.admitTaskIn(STORE, 'child-0', 'test', { manifest: MANIFEST })
    await h.task.startRunIn(STORE, failedSibling.run, 'test')
    await h.task.recordEvidenceIn(STORE, failedSibling.bundle, 'test')
    await h.task.markRunStatusIn(STORE, 'child-0', failedSibling.run.runId, 'verifying', 'test')
    await h.task.markRunStatusIn(STORE, 'child-0', failedSibling.run.runId, 'verified', 'test')
    const message = await refusal(() => recover(h, { reuses: [reuse(failedSibling, { artifactRefs: [] }) as never] }))
    expect(message).toContain('carries a "fail" verdict')
    expect(message).toContain('reuses[0]')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a citation of an artifact the bundle does not hold', async () => {
    const h = harness()
    const { sibling } = await storeWithFailedRoot(h)
    const message = await refusal(() => recover(h, { reuses: [reuse(sibling, { artifactRefs: ['a-not-here'] }) as never] }))
    expect(message).toContain('holds no artifact "a-not-here"')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })

  test('refuses a reuse of a task that is not a sibling', async () => {
    const h = harness()
    await storeWithFailedRoot(h)
    await h.task.createStore('sg-t-somewhere-else')
    await h.task.createTaskIn('sg-t-somewhere-else', { ...rootTask({ parentTaskId: undefined, taskId: 'stranger' }) }, 'test')
    const message = await refusal(() => recover(h, {
      reuses: [{ childIndex: 0, taskId: 'stranger', sourceRunId: 'r-stranger', evidenceId: 'e-stranger' } as never],
    }))
    expect(message).toContain('no task "stranger" exists in this store')
    expect(await runsOf(h, 'root')).toHaveLength(1)
  })
})

describe('A6 recovery entry: the persistent boundaries across a restart', () => {
  test('a reopened process keeps the attempt it finds, resumes its Session, and refunds no run', async () => {
    const sessions = new Map<string, StoredSession>()
    const first = harness({ sessions, config: { rootBudget: { maxRuns: 3 } } })
    await storeWithFailedRoot(first)
    const started = await recover(first)
    const afterStart = await first.task.snapshotIn(STORE)
    expect(afterStart.runs).toHaveLength(3)
    expect((afterStart.runs.find(item => item.runId === started.runId))?.batchId).toBeUndefined()
    expect(afterStart.runs.find(item => item.runId === started.runId)?.batches).toBeUndefined()

    // The process dies here: the attempt's run exists and no batch was admitted.
    const second = harness({ sessions, config: { rootBudget: { maxRuns: 3 } } })
    await second.task.openStore(STORE)
    await second.runtime.reconcileStore(STORE)

    // The same attempt, resumed rather than cancelled or duplicated: the store
    // holds the same three runs, the run is still `running`, and its Session was
    // brought back under its own identity.
    const afterReopen = await second.task.snapshotIn(STORE)
    expect(afterReopen.runs.map(item => item.runId).sort()).toEqual(afterStart.runs.map(item => item.runId).sort())
    expect(afterReopen.runs.find(item => item.runId === started.runId)?.status).toBe('running')
    expect(second.resumed).toEqual([started.sessionId])
    expect(second.spawns).toHaveLength(0)
    const answered = await recover(second)
    expect(answered.attempt).toBe('existing')
    expect(answered.runId).toBe(started.runId)

    // Nothing was refunded: once that attempt is over, the ceiling still counts
    // every run the store holds, so a new key cannot start a fourth one. The
    // count is a fact of the store, read after the restart — never re-derived
    // from "now", which is what would refund it.
    await second.task.markRunStatusIn(STORE, 'root', started.runId, 'failed', 'test', { reason: 'the attempt failed' })
    const refused = await refusal(() => recover(second, { requestKey: 'k-2' }))
    expect(refused).toContain('allows 3 run(s)')
    expect(await runsOf(second, 'root')).toHaveLength(2)
  })

  test('an attempt whose submission was recorded but never settled is judged after the restart, with no second run', async () => {
    const sessions = new Map<string, StoredSession>()
    const h = harness({ sessions, config: { rootBudget: { maxRuns: 4 } }, verifier: true })
    await storeWithFailedRoot(h)
    const started = await recover(h)
    // The window the ticket names: the attempt's root handed its result in and the
    // process died before the verdict. Written through the store's own entry, so
    // the state is the one a crash would leave.
    await h.task.changeRunPhaseIn(STORE, 'root', started.runId, SUPERVISOR, {
      phase: 'submitted',
      submission: { summary: 'the attempt is handed in', evidenceRefs: [], submittedAt: NOW, origin: 'worker' },
    })
    const before = await h.task.snapshotIn(STORE)

    const second = harness({ sessions, config: { rootBudget: { maxRuns: 4 } }, verifier: true })
    await second.task.openStore(STORE)
    await second.runtime.reconcileStore(STORE)
    const after = await second.task.snapshotIn(STORE)
    // The settlement the dead process owed is the only thing that happened: same
    // runs, same ids, no new attempt and no second submission.
    expect(after.runs.map(item => item.runId).sort()).toEqual(before.runs.map(item => item.runId).sort())
    const settled = after.runs.find(item => item.runId === started.runId)
    expect(settled?.status).not.toBe('running')
    expect(settled?.submission?.summary).toBe('the attempt is handed in')
    expect(await runsOf(second, 'root')).toHaveLength(2)
    // The attempt is terminal now, so a new key may ask again — the exclusion is
    // the in-flight attempt, not the diagnosis forever.
    const third = await recover(second, { requestKey: 'k-2' })
    expect(third.attempt).toBe('started')
    expect(third.runId).not.toBe(started.runId)
  })
})

describe('A6 recovery entry: the root hands its result in only when its references are satisfied', () => {
  test('opens an attempt whose product does not exist yet, and refuses the submission until it does', async () => {
    const h = harness()
    await storeWithFailedRoot(h, { productReference: 'report-from-producer', sibling: false })
    // The product the contract names does not exist anywhere in the store: the
    // attempt starts anyway — its production is what the attempt is for — and the
    // root is not allowed to hand in a result that ignores the gap.
    const started = await recover(h)
    expect((await h.task.snapshotIn(STORE)).evidence).toEqual([])
    const message = await refusal(() => h.runtime.submitResult(started.sessionId, { summary: 'all done' }))
    expect(message).toContain('missing required artifacts: report-from-producer')
    const after = await h.task.snapshotIn(STORE)
    const run = after.runs.find(item => item.runId === started.runId)
    expect(run?.status).toBe('running')
    expect(run?.submission).toBeUndefined()
    expect(run?.executionPhase).toBe('active')
    // The gap is on the record as an obligation, exactly where the spawn gate
    // records the same finding — a refusal that leaves the gap unrecorded would
    // be a finding nobody can act on.
    expect(after.obligations.some(item => item.goal.includes('report-from-producer') && item.sourceTaskId === 'root')).toBe(true)
  })
})

describe('A6 recovery entry: a cancelled attempt is terminal, and the next admission is re-checked', () => {
  test('answers the cancelled attempt under its own key, and refuses a new key for a source that is no longer failed', async () => {
    const sessions = new Map<string, StoredSession>()
    const h = harness({ sessions, config: { rootBudget: { maxRuns: 4 } } })
    await storeWithFailedRoot(h)
    const started = await recover(h)
    expect(started.attempt).toBe('started')
    expect(await runsOf(h, 'root')).toHaveLength(2)

    // A person cancels the attempt (A4's own cancellation entry): its run and the
    // task it was opened for are terminal. The same key is answered from that
    // record — never restarted, never charged twice — and a *new* key is refused
    // by name, because a recovery is opened for a failed task and this store's
    // root is not one any more.
    await h.task.markRunStatusIn(STORE, 'root', started.runId, 'cancelled', 'test', { reason: 'a person cancelled the attempt' })
    const answered = await recover(h)
    expect(answered.attempt).toBe('existing')
    expect(answered.runId).toBe(started.runId)
    expect(answered.status).toBe('cancelled')
    expect(await runsOf(h, 'root')).toHaveLength(2)
    const refused = await refusal(() => recover(h, { requestKey: 'k-2' }))
    expect(refused).toContain('is cancelled')
    expect(refused).toContain('a recovery attempt is opened for a failed task')
    expect(await runsOf(h, 'root')).toHaveLength(2)

    // The refusal is the state's, not the key's: under the *same* key the record
    // still answers, and the store's run count did not move for either call.
    const again = await recover(h)
    expect(again.attempt).toBe('existing')
    expect(again.runId).toBe(started.runId)
    expect((await h.task.snapshotIn(STORE)).runs).toHaveLength(3)
  })
})
