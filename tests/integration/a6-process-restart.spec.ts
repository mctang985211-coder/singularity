/**
 * A6 interface ⑤, second half: the **recovery windows** crossed by a process that
 * is really killed (plan §F.4, EVO-4: 恢复 Run 创建后/批次准入前、准入后/spawn 前及
 * 新根结算前重开; 不得以同进程异常模拟冒充跨进程重开).
 *
 * The deployment here is the whole one: the real JSONL session log, the real
 * store and runtime, the real agent runtime, the real verifier. The child process
 * boots it over the shared directory, drives the failed root's recovery to one of
 * three windows, and lets `process.kill(process.pid, 'SIGKILL')` end it there — no
 * `catch`, no `finally`, no flush, no descriptor closed by a handler, no memory
 * left (see `tests/support/process-death.ts`). What the parent then boots is a
 * second process image over the same directory: it reads the log and the store
 * off disk, and nothing of the dead image is available to it.
 *
 * The three windows, and what each leaves for the new process:
 *
 * 1. **A new Run created, no batch admitted** — the attempt's run and Session are
 *    durable and the worker never decomposed. The new process resumes that
 *    Session, the same key answers with the same Run, and the attempt is still
 *    drivable: driven here, it finishes and the **original** criteria accept it.
 * 2. **A batch admitted, its member's worker never started** — the batch and its
 *    member's Run are durable and the child's spawn never happened. The new
 *    process drives the batch to its end and settles the member by name (its
 *    Session never existed, so no worker can be invented for it): one Run per
 *    position, one batch, no second attempt.
 * 3. **The attempt submitted, its verdict not written** — the submission is
 *    durable and the process died inside the verification. The new process's
 *    store pass completes that settlement once, on the same Run, without a second
 *    submission or a second Run.
 *
 * Each case then reads the ceiling off a **real admission**: with `maxRuns` set to
 * the run count the dead image left, a replay in the new process is refused by
 * name, naming that count. A reopen that refunded what the dead process spent
 * would read a smaller number and admit it. (The earlier version of this file
 * booted both images in one process; a same-pid boot cannot even reach that
 * admission — the workspace marker names this process's own pid — which is one
 * reason the evidence had to become a real death.)
 *
 * One more thing a hand-off owns: the **supervisor a diagnosis was delegated to**
 * is a row in the coordination ledger. The last case kills the process that
 * started it and shows the new process answering the same hand-off with the same
 * supervisor, spawning nothing and refunding nothing of the store's allowance.
 */

import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { countReviewAgentRuns, readSupervisorDelegation, reviewAgentLedgerFile } from '../../agent-singularity/src/review-agent-ledger.ts'
import { consumePendingHandoffs, startSupervisorHandoff } from '../../agent-singularity/src/evolution-handoff.ts'
import { defineRootBudgetApproval } from '../../agent-singularity/src/tools/budget-extend.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { Diagnosis, TaskRun, TaskSnapshot } from '../../task/src/index.ts'
import { checkRunStart, resolveRootBudget } from '../../task-runtime/src/index.ts'
import type { DecomposeSpec } from '../../task-runtime/src/index.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'
import { assertRealDeath, dieHere, spawnSelfChild, type DeathMarker } from '../support/process-death.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))
/** The one case a nested run is filtered to; no other case of this file runs there. */
const CHILD_CASE = 'the child process is killed at its armed recovery window'
/** The file a child writes its pid, boundary and ids into before it dies. */
const MARKER = 'a6-recovery-death.json'
/** The environment variable that tells the nested run which window to die at. */
const BOUNDARY_ENV = 'A6_RECOVERY_BOUNDARY'
const BOUNDARY = process.env[BOUNDARY_ENV] as Boundary | undefined
const CHILD_DIR = process.env.A6_CHILD_WORKSPACE
/** This spec's own file — the one file a nested run collects, where the outer run's file is. */
const SPEC_PATH = fileURLToPath(import.meta.url)

/**
 * The three recovery windows, in the order they happen — with the first window's
 * *first instant* as a state of its own.
 *
 * "A new Run created, no batch admitted" covers two states a real death tells
 * apart: the Run with its Session already begun (its first request reached the
 * log, which is where a live loop's turn leaves it) and the Run in the instant
 * before anything of its Session was ever written down. The second one is not
 * reachable by any same-process fixture — an in-memory session plane answers for
 * a session the deployment never persisted — and the new process's own answer to
 * it is a named settlement, so it is a window and not a gap.
 */
type Boundary = 'attempt-created' | 'attempt-created-unwritten' | 'batch-admitted' | 'root-settlement'
const BOUNDARIES: readonly Boundary[] = ['attempt-created', 'attempt-created-unwritten', 'batch-admitted', 'root-settlement']
/** The last boundary's own case is the hand-off (no runs involved), driven separately. */
const HANDOFF_BOUNDARY = 'handoff-started' as const

/** One child spec: a goal and one named criterion the real command verifier settles. */
const children = (objective: string, command: string, criterionId: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ criterionId, description: `${objective} works`, command }],
}]

/** What one child recorded before it died: its pid, the boundary, and the ids the parent asserts on. */
interface RecoveryMarker extends DeathMarker {
  readonly boundary: Boundary | typeof HANDOFF_BOUNDARY
  /** The store's runs at the moment of the death — the count the parent's ceiling is measured against. */
  readonly runs: number
  /** The graph's own spawn edges this image committed, for the parent's boot to re-read. */
  readonly spawned: readonly string[]
  readonly sourceRunId?: string
  readonly attemptRunId?: string
  readonly attemptSessionId?: string
  /** The registry revision the attempt's run bound — the provider content it was placed under. */
  readonly providerRevision?: string
  readonly replacementRunId?: string
  readonly batchId?: string
  readonly supervisorSessionId?: string
}

const stacks: AssemblyStack[] = []
const dirs: string[] = []

beforeEach(() => {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
})

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([
      stack.dispose({ remove: false }),
      new Promise(resolve => { setTimeout(resolve, 2_000).unref() }),
    ])
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** One directory two images share — the "same directory" a reopened process reads. */
async function sharedDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'a6-recovery-death-'))
  dirs.push(dir)
  return dir
}

/** The ledger's own lines, read from the file the deployment keeps them in. */
function ledgerRows(): Record<string, unknown>[] {
  try {
    return readFileSync(reviewAgentLedgerFile(), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** Boot one process image over its own directory — or over a dead process's directory. */
async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

/**
 * Turn this deployment's evolution chain on — the switch both the review pack and
 * the hand-off consumption read (`ctx.singularityEvolution.enabled`).
 */
function chainOn(stack: AssemblyStack): void {
  const exposure = stack.ctx.get('singularityEvolution') as { enabled: boolean } | undefined
  if (exposure === undefined) throw new Error('this deployment mounts no evolution exposure')
  exposure.enabled = true
}

/**
 * One failed root: the contract is accepted, its only member fails its own
 * criterion, and the root's own map — which names that member — then fails the
 * run. Written through the deployment's own entries.
 */
async function failedRoot(stack: AssemblyStack): Promise<{ taskId: string; runId: string; memberTaskId: string }> {
  await stack.seedLog(ROOT, ['ship the release'])
  const root = await stack.runtime.intakeRootContract(STORE, ROOT, {
    objective: 'ship the release',
    acceptanceCriteria: [
      { criterionId: 'root-goal', description: 'the release is delivered', command: 'true' },
      {
        criterionId: 'root-map',
        description: 'the member the map names passed',
        mode: 'composite',
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'member-0' }],
      },
    ],
  } as never)
  const batch = await stack.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
    reason: 'split the work',
    children: children('the member that fails', 'false', 'member-0'),
  } as never)
  const outcomes = await stack.runtime.awaitBatch(STORE, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
  // The root's own turn hands its result in — the batch end is the wake, and only
  // its own submission puts the original map in front of the verifier (K1 §2).
  await stack.agent(ROOT)!.whenIdle!()
  await vi.waitFor(async () => {
    expect((await stack.snapshot(STORE)).runs.find(run => run.runId === root.runId)?.status).toBe('failed')
  }, { timeout: 30_000, interval: 25 })
  const memberTaskId = (await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId === root.taskId)!.taskId
  return { ...root, memberTaskId }
}

/** The diagnosis a reviewer or the host writes about that failure. */
function diagnosis(root: { taskId: string; runId: string }): Diagnosis {
  return {
    diagnosisId: 'd-restart',
    taskId: root.taskId,
    observedFailure: 'the member failed its own criterion',
    scope: 'the root goal of this store',
    localizedCause: 'the deployment grants no capability for the member',
    evidenceRefs: [],
    reviewRefs: [`${root.taskId}#${root.runId}`],
    confidence: 'high',
    proposals: [{ targetType: 'capability', targetId: 'a6-restart-row', rationale: 'the member needs this row' }],
  }
}

/**
 * The driving half of the attempt's turn, as the deployment's own loop would run
 * it: an attempt that has not decomposed yet gets its replacement batch. Both the
 * child and the parent boot their deployment with this, so "the attempt is driven"
 * means the same thing on either side of the death.
 */
function attemptWorker(stack: () => AssemblyStack): (sessionId: string) => Promise<void> {
  return async (sessionId: string) => {
    const bound = await stack().runtime.runForSession(sessionId).catch(() => undefined)
    if (bound === undefined) return
    if (bound.run.recovery === undefined || bound.run.batchId !== undefined) return
    await stack().runtime.decomposeAndRun(STORE, bound.task.taskId, bound.run.runId, sessionId, {
      reason: 're-run the failed position',
      children: [{ objective: 'the member, again', acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: 'true' }] }],
    } as never)
  }
}

/** The one recovery request every cleanup case opens. */
const recoveryRequest = (root: { taskId: string; runId: string }) => ({
  sourceTaskId: root.taskId,
  sourceRunId: root.runId,
  sourceDiagnosisId: 'd-restart',
  requestKey: 'k-batch',
})

/** The attempt run of one store, or `undefined` while none exists. */
function attemptOf(snapshot: TaskSnapshot): TaskRun | undefined {
  return snapshot.runs.find(run => run.recovery !== undefined)
}

/** Wait for the attempt's run to appear, and answer with it. */
async function attemptAppears(stack: AssemblyStack): Promise<TaskRun> {
  return await vi.waitFor(async () => {
    const found = attemptOf(await stack.snapshot(STORE))
    expect(found).toBeDefined()
    return found!
  }, { timeout: 30_000, interval: 25 })
}

/** Write a child's marker, naming the image that is about to die and what it left. */
async function writeMarker(directory: string, marker: RecoveryMarker): Promise<void> {
  await writeFile(join(directory, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

/**
 * The **child** side of one boundary: boot the deployment over the shared
 * directory, drive it to the armed window, leave the marker that names the
 * boundary and its ids, and die there. The worker of this image is the driving
 * half (`whenIdle` is what the deployment's own loop calls); the wrappers below
 * are how a window that has no seam of its own is reached exactly.
 */
async function driveChild(directory: string, boundary: Boundary | typeof HANDOFF_BOUNDARY): Promise<never> {
  // This image's own coordination allowance: the A5 trigger spends a run of it per
  // failed review before this case's hand-off asks for one of its own.
  process.env.SINGULARITY_REVIEW_AGENT_BUDGET = '4'
  const frozen = { replacement: false }
  let attempt: TaskRun | undefined
  // The child's own ceiling has room to reach the window; the *parent* is what is
  // booted at the boundary's own count (see the parent cases).
  const stack = await startAssemblyStack({ dir: directory, rootBudget: { maxRuns: 8 } } as never)
  chainOn(stack)
  const root = await failedRoot(stack)
  await stack.task.recordDiagnosisIn(STORE, diagnosis(root), ROOT)

  if (boundary === HANDOFF_BOUNDARY) {
    // The supervisor a hand-off is delegated to: one ledger row and one spawn,
    // written by a process that then dies.
    const started = await startSupervisorHandoff(stack.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(root),
      delegator: { sessionId: ROOT, agent: stack.root(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    await writeMarker(directory, {
      pid: process.pid,
      boundary,
      runs: (await stack.snapshot(STORE)).runs.length,
      spawned: stack.spawnEdges().map(edge => edge.to),
      sourceRunId: root.runId,
      supervisorSessionId: String((started as { sessionId: string }).sessionId),
    })
    dieHere(boundary)
  }

  // The attempt's own turn decomposes a replacement; the waiter below is what
  // makes the member start, exactly as the deployment's loop drives a spawn.
  const worker = attemptWorker(() => stack)
  // The spawn of the replacement is where the "admitted batch, no worker" window is
  // frozen: the batch's own run is durable and the worker is never started.
  if (boundary === 'batch-admitted') {
    const realSpawn = stack.agentRuntime.spawn.bind(stack.agentRuntime)
    stack.agentRuntime.spawn = async (parent, request) => {
      if (request.taskWorker === true && String(request.name).includes('the member, again')) {
        frozen.replacement = true
        await new Promise<void>(() => {})
      }
      return await realSpawn(parent, request)
    }
  }
  // The verdict window: the verification of the attempt's own run is where the
  // process dies, after the submission is durable and before the verdict is written.
  if (boundary === 'root-settlement') {
    const realVerify = stack.verifier.verifyRun.bind(stack.verifier)
    stack.verifier.verifyRun = async (storeId: string, runId: string, options?: unknown) => {
      if (attempt !== undefined && runId === attempt.runId) {
        await writeMarker(directory, {
          pid: process.pid,
          boundary,
          runs: (await stack.snapshot(STORE)).runs.length,
          spawned: stack.spawnEdges().map(edge => edge.to),
          sourceRunId: root.runId,
          attemptRunId: attempt.runId,
          attemptSessionId: String(attempt.sessionId),
          providerRevision: attempt.providerBinding?.registryRevision,
        })
        dieHere(boundary)
      }
      return await (realVerify as (storeId: string, runId: string, options?: unknown) => Promise<unknown>)(storeId, runId, options)
    }
  }

  const opened = stack.runtime.recoverRootTask(STORE, recoveryRequest(root), { sessionId: String(ROOT) })
  opened.catch(() => undefined)
  attempt = await attemptAppears(stack)
  // The attempt's Session, given the durable existence the deployment's own loop
  // gives it on the first request of its turn: this fixture's stub loop never
  // appends an event, and the instant before that write is the sibling boundary
  // below (the Run is durable and nothing of its Session is).
  if (boundary === 'attempt-created') {
    await stack.seedLog(String(attempt.sessionId), ['the attempt is starting'], { parentSession: String(ROOT) })
  }

  if (boundary === 'attempt-created' || boundary === 'attempt-created-unwritten') {
    // The run and its Session are durable and no batch was admitted: nothing else
    // has happened, so nothing else is asserted below the marker.
    expect(attempt.batchId).toBeUndefined()
    await writeMarker(directory, {
      pid: process.pid,
      boundary,
      runs: (await stack.snapshot(STORE)).runs.length,
      spawned: stack.spawnEdges().map(edge => edge.to),
      sourceRunId: root.runId,
      attemptRunId: attempt.runId,
      attemptSessionId: String(attempt.sessionId),
      providerRevision: attempt.providerBinding?.registryRevision,
    })
    dieHere(boundary)
  }

  // Drive the attempt's turn: the worker body above decomposes (and, at the
  // settlement window, the submission that follows it is interrupted by the
  // verifier wrapper).
  void worker(String(attempt.sessionId)).then(async () => {
    // The fixture's own auto-submission, at the point a live worker owes it.
    const current = await stack.runtime.runForSession(String(attempt!.sessionId)).catch(() => undefined)
    if (current === undefined) return
    if (current.run.status !== 'running') return
    if (current.run.executionPhase === 'waiting_children' && current.run.batchId !== undefined) {
      await stack.runtime.awaitBatch(STORE, current.run.batchId)
    }
    const again = await stack.runtime.runForSession(String(attempt!.sessionId)).catch(() => undefined)
    if (again === undefined || again.run.status !== 'running' || again.run.executionPhase !== 'active') return
    await stack.runtime.submitResult(String(attempt!.sessionId), { summary: 'the attempt is handed in' })
  }).catch(() => undefined)

  if (boundary === 'batch-admitted') {
    await vi.waitFor(() => { expect(frozen.replacement).toBe(true) }, { timeout: 30_000, interval: 25 })
    const snapshot = await stack.snapshot(STORE)
    const replacement = snapshot.runs.find(run => run.taskId !== root.taskId && run.taskId !== attempt!.taskId
      && snapshot.tasks.some(task => task.taskId === run.taskId && task.parentTaskId === root.taskId && run.status === 'running' && run.recovery === undefined))
    await writeMarker(directory, {
      pid: process.pid,
      boundary,
      runs: snapshot.runs.length,
      spawned: stack.spawnEdges().map(edge => edge.to),
      sourceRunId: root.runId,
      attemptRunId: attempt.runId,
      attemptSessionId: String(attempt.sessionId),
      providerRevision: attempt.providerBinding?.registryRevision,
      batchId: attempt.batchId,
      ...(replacement === undefined ? {} : { replacementRunId: replacement.runId }),
    })
    dieHere(boundary)
  }

  // The settlement window: wait until the wrapper kills this process (or fail loudly).
  await vi.waitFor(async () => {
    expect((await stack.snapshot(STORE)).runs.find(run => run.runId === attempt!.runId)?.status).not.toBe('running')
  }, { timeout: 30_000, interval: 25 })
  throw new Error('the settlement window never fired: the attempt settled without the verifier wrapper seeing it')
}

describe.skipIf(BOUNDARY !== undefined)('A6 EVO-4 (real death): a killed recovery attempt, and the new process that reads it', () => {
  it.each(BOUNDARIES)('leaves the %s window\'s own facts, and the new process finishes the attempt without a second Run', async boundary => {
    const directory = await sharedDirectory()
    const child = spawnSelfChild({
      specPath: SPEC_PATH,
      caseName: CHILD_CASE,
      workspace: directory,
      env: { [BOUNDARY_ENV]: boundary },
    })
    const marker = await assertRealDeath<RecoveryMarker>(directory, MARKER, child)
    expect(marker.boundary).toBe(boundary)
    expect(marker.attemptRunId).toBeDefined()

    // The new process boots the same directory. Its ceiling is the count the dead
    // image left: any run this store starts now is one the dead process's own
    // count did not leave room for.
    let stack!: AssemblyStack
    stack = await boot({
      dir: directory,
      // The graph the dead image published: the sessions it spawned are members of
      // it (the graph store's own record), which is what a resume has to read before
      // it can bring one back.
      graphs: [{ id: 'g1', rootSessionId: ROOT, members: [...marker.spawned], spawned: [...marker.spawned] }],
      rootBudget: { maxRuns: marker.runs },
      worker: attemptWorker(() => stack),
    })
    const adopted = await stack.runtime.adoptRoot(STORE, ROOT)
    expect(adopted).toMatchObject({ adopted: true })

    // ── the same attempt, never a second one ──────────────────────────────────
    const snapshot = await stack.snapshot(STORE)
    const attempt = attemptOf(snapshot)!
    expect(attempt.runId).toBe(marker.attemptRunId)
    expect(attempt.recovery).toMatchObject({ requestKey: 'k-batch', sourceDiagnosisId: 'd-restart' })
    // The provider content the dead image admitted the attempt under is the one the
    // new process reads: a reopen re-binds nothing and finds no half-written row.
    expect(marker.providerRevision).toBeDefined()
    expect(attempt.providerBinding?.registryRevision).toBe(marker.providerRevision)
    expect(snapshot.runs.filter(run => run.taskId === attempt.taskId && run.recovery !== undefined)).toHaveLength(1)
    const answered = await stack.runtime.recoverRootTask(STORE, recoveryRequest({ taskId: attempt.taskId, runId: marker.sourceRunId! }), { sessionId: String(ROOT) })
    expect(answered.attempt).toBe('existing')
    expect(answered.runId).toBe(attempt.runId)
    expect((await stack.snapshot(STORE)).runs).toHaveLength(snapshot.runs.length)

    // ── the ceiling is the dead image's own count, read by a real admission ───
    const ceiling = resolveRootBudget(await stack.snapshot(STORE), { maxRuns: marker.runs })
    if (!ceiling.ok) throw new Error(ceiling.reason)
    // The champion the probe replays is the first attempt's failed member: a
    // terminal task whose replay is a *new run of this store*, which is what the
    // ceiling refuses.
    const champion = (await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId !== undefined && task.status === 'failed')!.taskId
    const refused = await stack.runtime
      .replayTask(STORE, champion, { lineage: 'a6-ceiling-probe', spawn: false } as never, String(ROOT))
      .then(() => '', error => String(error))
    expect(refused).toContain(`allows ${marker.runs} run(s)`)
    expect(refused).toContain(`already holds ${marker.runs}`)
    expect(checkRunStart(await stack.snapshot(STORE), ceiling).allowed).toBe(false)

    // ── the window's own settlement ───────────────────────────────────────────
    if (boundary === 'attempt-created') {
      // The attempt was never driven: it is still waiting to be, and this process
      // resumes its Session instead of opening a second attempt.
      expect((await stack.snapshot(STORE)).runs.find(run => run.runId === attempt.runId)?.batchId).toBeUndefined()
      await vi.waitFor(() => { expect(stack.agent(marker.attemptSessionId!)).toBeDefined() }, { timeout: 20_000, interval: 25 })
      // Driving it spends one run, and the ceiling the dead image left does not
      // have room for one: it moves only through the person's own entry (K4's one
      // approval), exactly as it would for a deployment that ran out of budget.
      stack.runtime.registerRootBudgetApproval(defineRootBudgetApproval(stack.ctx))
      const granted = await stack.runtime.extendRootBudget(
        String(ROOT),
        { callId: 'call-room', execution: { agent: { id: String(ROOT) }, signal: new AbortController().signal } },
        { requestKey: 'k-room', maxRuns: marker.runs + 1 },
      )
      expect(granted.record.maxRuns).toEqual({ previous: marker.runs, next: marker.runs + 1 })
      // Driven here, it finishes: the replacement is run and the **original** map
      // accepts the attempt.
      await stack.agent(marker.attemptSessionId!)!.whenIdle!()
      const finished = await vi.waitFor(async () => {
        const current = (await stack.snapshot(STORE)).runs.find(run => run.runId === attempt.runId)!
        expect(current.status).not.toBe('running')
        return current
      }, { timeout: 30_000, interval: 25 })
      expect(finished.status).toBe('verified')
      expect((await stack.snapshot(STORE)).tasks.find(task => task.taskId === attempt.taskId)?.status).toBe('verified')
    }
    if (boundary === 'attempt-created-unwritten') {
      // Nothing of the attempt's Session was ever written: the new process refuses
      // to invent a worker for it (`session ... not found`) and settles that Run
      // **by name** — no second Run, no batch, and the same key answers the Run it
      // already named. The old image's count is what the ceiling reads, so a fresh
      // key cannot start the attempt again.
      const settledRun = await vi.waitFor(async () => {
        const current = (await stack.snapshot(STORE)).runs.find(run => run.runId === attempt.runId)!
        expect(current.status).not.toBe('running')
        return current
      }, { timeout: 30_000, interval: 25 })
      expect(settledRun.status).toBe('failed')
      expect(settledRun.batchId).toBeUndefined()
      expect(stack.agent(marker.attemptSessionId!)).toBeUndefined()
      const review = (await stack.snapshot(STORE)).reviews.find(item => item.runId === attempt.runId)!
      expect(review.outcome).toBe('failed')
      expect(review.localizedCause).toContain('could not be brought back under its own identity')
      expect(review.localizedCause).toContain('not found')
      const fresh = await stack.runtime.recoverRootTask(STORE, {
        ...recoveryRequest({ taskId: attempt.taskId, runId: marker.sourceRunId! }),
        requestKey: 'k-after-the-death',
      }, { sessionId: String(ROOT) }).then(() => '', error => String(error))
      expect(fresh).toContain(`allows ${marker.runs} run(s)`)
      expect(fresh).toContain(`already holds ${marker.runs}`)
      expect((await stack.snapshot(STORE)).runs).toHaveLength(marker.runs)
    }
    if (boundary === 'batch-admitted') {
      // The batch is driven to its end by this process: the member's Session never
      // existed, so no worker can be invented for it and it is settled by name —
      // one Run per position, no second batch.
      const outcomes = await stack.runtime.awaitBatch(STORE, String(attempt.batchId))
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.runId).toBe(marker.replacementRunId)
      expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
      const after = await stack.snapshot(STORE)
      const member = after.runs.find(run => run.runId === marker.replacementRunId)!
      expect(member.status).toBe('cancelled')
      const review = after.reviews.find(item => item.runId === member.runId)!
      expect(review.outcome).toBe('cancelled')
      expect(review.anomalies.join('\n')).toContain('was in flight when this store was reopened and never submitted')
      expect(after.runs).toHaveLength(marker.runs)
      expect(after.runs.filter(run => run.taskId === member.taskId)).toHaveLength(1)
    }
    if (boundary === 'root-settlement') {
      // The submission the dead process made is the durable fact this process reads,
      // and it is *this Run* that settles — once, with one review. What the verdict
      // is here is the deployment's own answer for a bound checkout, and it is a
      // named one: the store pass settles a `submitted` run before the tree's
      // checkout is taken over, so the verifier refuses to judge a workspace this
      // process does not hold yet and the run is settled `failed` with that reason
      // (see the finding recorded in this file's own report). No second Run is
      // opened, no second submission is made, and the count a restart reads is the
      // dead image's.
      const settled = await vi.waitFor(async () => {
        const current = (await stack.snapshot(STORE)).runs.find(run => run.runId === attempt.runId)!
        expect(current.status).not.toBe('running')
        return current
      }, { timeout: 30_000, interval: 25 })
      expect(settled.status).toBe('failed')
      const after = await stack.snapshot(STORE)
      expect(after.runs).toHaveLength(marker.runs)
      expect(after.runs.filter(run => run.taskId === attempt.taskId)).toHaveLength(2)
      expect(after.runs.filter(run => run.recovery !== undefined)).toHaveLength(1)
      const verdicts = after.reviews.filter(item => item.runId === attempt.runId)
      expect(verdicts).toHaveLength(1)
      expect(verdicts[0]!.localizedCause).toContain('cannot be verified')
      expect(verdicts[0]!.localizedCause).toContain("a verifier runs only while the run's own store holds the workspace it judges")
      // The submission itself is preserved on the run the dead process made.
      expect(settled.executionPhase).toBe('submitted')
      expect(settled.submission?.summary).toBe('the attempt is handed in')
      expect(after.tasks.find(task => task.taskId === attempt.taskId)?.status).toBe('failed')
    }

    // ── the old failure is exactly what it was ────────────────────────────────
    const final = await stack.snapshot(STORE)
    expect(final.runs.find(run => run.runId === marker.sourceRunId)?.status).toBe('failed')
    expect(final.reviews.some(item => item.runId === marker.sourceRunId && item.outcome === 'failed')).toBe(true)
    expect(final.diagnoses.find(item => item.diagnosisId === 'd-restart')?.proposals).toHaveLength(1)
  }, 120_000)

  it('answers the hand-off from the ledger the dead process wrote, and starts no second supervisor', async () => {
    const directory = await sharedDirectory()
    // The child starts the hand-off in its own process image and dies there: its
    // ledger rows (the claim and the started row) are the durable fact.
    const child = spawnSelfChild({ specPath: SPEC_PATH, caseName: CHILD_CASE, workspace: directory, env: { [BOUNDARY_ENV]: HANDOFF_BOUNDARY } })
    const marker = await assertRealDeath<RecoveryMarker>(directory, MARKER, child)
    expect(marker.boundary).toBe(HANDOFF_BOUNDARY)
    const supervisor = marker.supervisorSessionId!

    // The new process: same directory, the store the dead image left, the chain on.
    const stack = await boot({
      dir: directory,
      graphs: [{ id: 'g1', rootSessionId: ROOT, members: [...marker.spawned], spawned: [...marker.spawned] }],
    })
    // The store's coordination allowance, read from the ledger the dead image wrote
    // (the boot above is what points `$DSH_HOME` at this case's own directory).
    const spent = await countReviewAgentRuns(STORE)
    expect(spent).toBeGreaterThan(0)
    chainOn(stack)
    expect(stack.spawns).toEqual([])
    await stack.runtime.adoptRoot(STORE, ROOT)

    // The same hand-off answers with the supervisor the ledger already holds — the
    // delegation a recovery entry checks its caller against — and nothing starts.
    const repeat = await startSupervisorHandoff(stack.ctx, {
      storeId: STORE,
      diagnosis: diagnosis({ taskId: (await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId === undefined)!.taskId, runId: marker.sourceRunId! }),
      delegator: { sessionId: ROOT, agent: stack.root(ROOT) },
      sourceRef: `${(await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId === undefined)!.taskId}#${marker.sourceRunId}`,
      sourceOutcome: 'failed',
    })
    expect(repeat).toMatchObject({ result: 'existing', sessionId: supervisor })
    expect(stack.spawns).toEqual([])
    // The activation scan a rebuilt process runs takes nothing up either: this
    // hand-off is not pending any more, it already has its coordinator.
    const scan = await consumePendingHandoffs(stack.ctx, STORE)
    expect(scan.consumptions).toMatchObject([{ diagnosisId: 'd-restart', result: 'existing', sessionId: supervisor }])
    expect(stack.spawns).toEqual([])

    // One claim and one started row on the file, the allowance not refunded, and
    // the delegation still readable — the three facts the recovery entry rests on.
    expect(ledgerRows().filter(row => row.kind === 'claim' && row.role === 'supervisor')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'started' && row.sessionId === supervisor)).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(spent)
    expect(await readSupervisorDelegation(supervisor, 'd-restart')).toMatchObject({
      rootStoreId: STORE,
      taskId: marker.sourceRunId === undefined ? undefined : (await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId === undefined)!.taskId,
      actor: ROOT,
      diagnosisId: 'd-restart',
    })
    // A *new* hand-off is answered from the count the dead process wrote: with the
    // ceiling set to exactly what it spent, nothing more starts.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', String(spent))
    const rootTaskId = (await stack.snapshot(STORE)).tasks.find(task => task.parentTaskId === undefined)!.taskId
    const pressed = await startSupervisorHandoff(stack.ctx, {
      storeId: STORE,
      diagnosis: { ...diagnosis({ taskId: rootTaskId, runId: marker.sourceRunId! }), diagnosisId: 'd-restart-2' },
      delegator: { sessionId: ROOT, agent: stack.root(ROOT) },
      sourceRef: `${rootTaskId}#${marker.sourceRunId}`,
      sourceOutcome: 'failed',
    })
    expect(pressed).toMatchObject({ result: 'stopped', code: 'budget-exhausted' })
    expect((pressed as { reason: string }).reason).toContain(`${spent}/${spent}`)
    expect(stack.spawns).toEqual([])
  }, 120_000)
})

/**
 * The nested child: skipped unless its parent armed it, so an ordinary suite can
 * never kill a process whatever it runs. It boots the whole deployment over the
 * shared directory, drives the recovery to the armed window and kills itself
 * there.
 */
describe.skipIf(BOUNDARY === undefined)('A6 EVO-4 (nested child): the process image that dies inside the recovery', () => {
  it(CHILD_CASE, async () => {
    const boundary = BOUNDARY!
    const directory = CHILD_DIR
    if (directory === undefined) throw new Error('the child case runs only under the env its parent sets: A6_CHILD_WORKSPACE is missing')
    await driveChild(directory, boundary)
    throw new Error(`the ${boundary} window never ended this process`)
  }, 120_000)
})
