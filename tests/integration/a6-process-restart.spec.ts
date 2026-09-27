/**
 * A6 interface ⑤, second half: what a **real process restart** leaves of the
 * autonomy chain (plan §F.4, EVO-4).
 *
 * Two crash points the earlier A6 specs do not cover, both on a deployment whose
 * store really is on disk (`session-persistence-jsonl`): the first process is
 * killed the way a dying one dies — its durability barrier, then its
 * descriptors, with its drivers left parked on promises that will never settle —
 * and a second process boots over the same directory and reads what the first
 * one left. Nothing is simulated by throwing inside a live process; the bytes the
 * second boot reads are the first boot's artifact.
 *
 * 1. **The supervisor a hand-off was delegated to.** The coordination ledger is
 *    the durable fact: after the crash the new process still answers a repeat
 *    consumption (and an activation scan) with the same supervisor session,
 *    spawns nothing, refunds nothing of the store's allowance, and still reads
 *    the delegation the recovery entry checks its caller against.
 * 2. **A recovery attempt whose batch was admitted and whose children were never
 *    started.** The parent run waits on its children, the store holds the batch
 *    and its members, and no child has a run. The second process's store pass
 *    drives that batch to its end exactly once — the same attempt, the same
 *    request key, the same provider binding — and the original acceptance
 *    criteria still judge the attempt. The run count is cumulative across the
 *    crash: a restart does not refund a run, which is what K4's `maxRuns` means.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { countReviewAgentRuns, readSupervisorDelegation, reviewAgentLedgerFile } from '../../agent-singularity/src/review-agent-ledger.ts'
import { consumePendingHandoffs, startSupervisorHandoff } from '../../agent-singularity/src/evolution-handoff.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { Diagnosis } from '../../task/src/index.ts'
import { checkRunStart, resolveRootBudget } from '../../task-runtime/src/index.ts'
import type { DecomposeSpec } from '../../task-runtime/src/index.ts'
import { readFileSync } from 'node:fs'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))
/** The crash point's own ceiling: exactly the runs this case spends (root, member, attempt, replacement). */
const MAX_RUNS = 4

/** One child spec: a goal and one named criterion the real command verifier settles. */
const children = (objective: string, command: string, criterionId: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ criterionId, description: `${objective} works`, command }],
}]

/** The stack's log path for the ledger rows this file reads back as a reader would. */
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

/** Boot one process image over its own directory — or over a dead process's directory. */
async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

/**
 * Turn this deployment's evolution chain on — the switch both the review pack and
 * the hand-off consumption read (`ctx.singularityEvolution.enabled`). The
 * composition mounts the plane's exposure with the chain off, so a spec that is
 * about what a consumption does sets the deployment's own flag rather than
 * standing in for it.
 */
function chainOn(stack: AssemblyStack): void {
  const exposure = stack.ctx.get('singularityEvolution') as { enabled: boolean } | undefined
  if (exposure === undefined) throw new Error('this deployment mounts no evolution exposure')
  exposure.enabled = true
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a6-restart-'))
  dirs.push(dir)
  return dir
}

/**
 * One failed root: the contract is accepted, its only member fails its own
 * criterion, and the root's own map — which names that member — then fails the
 * run. Written through the deployment's own entries, so the store's facts are
 * the ones a real failure leaves.
 */
async function failedRoot(stack: AssemblyStack): Promise<{ taskId: string; runId: string }> {
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
  return root
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

describe('A6 EVO-4: the supervisor hand-off across a real process restart', () => {
  it('answers the hand-off from the ledger the dead process wrote, and starts no second supervisor', async () => {
    const first = await boot({ worker: async () => {} })
    // The deployment's own switch: the consumption only takes a hand-off up when
    // the evolution plane is mounted (`ctx.singularityEvolution.enabled`).
    chainOn(first)
    const root = await failedRoot(first)
    const record = diagnosis(root)
    await first.task.recordDiagnosisIn(STORE, record, ROOT)
    // The store's coordination allowance (the same one A5's reviewer runs on): the
    // failure trigger has already spent what the failed reviews cost, and this case
    // needs room for exactly one supervisor — which is the run the restart must
    // neither duplicate nor refund.
    const usedBefore = await countReviewAgentRuns(STORE)
    expect(usedBefore).toBeGreaterThan(0)
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', String(usedBefore + 2))

    // The hand-off: one claim, one started row, one supervisor session — the
    // delegation the recovery entry later reads its caller against.
    const started = await startSupervisorHandoff(first.ctx, {
      storeId: STORE,
      diagnosis: record,
      delegator: { sessionId: ROOT, agent: first.root(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    const supervisor = String((started as { sessionId: string }).sessionId)
    expect(first.spawns.filter(spawn => String(spawn.name) === 'supervisor for d-restart')).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(usedBefore + 1)

    // The process dies: its descriptors go, its bytes stay.
    await first.crash()
    await first.dispose({ remove: false })
    const second = await boot({ dir: first.dir, graphs: [{ id: 'g1', rootSessionId: ROOT, spawned: [supervisor] }] })
    chainOn(second)
    expect(second.spawns).toEqual([])
    // The second process activates the store the dead one left (A2's own door).
    const activated = await second.runtime.adoptRoot(STORE, ROOT)
    expect(activated).toMatchObject({ adopted: true, taskId: root.taskId })

    // A repeat consumption, and the activation scan a rebuilt process runs, both
    // answer with the supervisor the ledger already holds — and spawn nothing.
    const again = await startSupervisorHandoff(second.ctx, {
      storeId: STORE,
      diagnosis: record,
      delegator: { sessionId: ROOT, agent: second.root(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(again).toMatchObject({ diagnosisId: 'd-restart', result: 'existing', sessionId: supervisor })
    // …and the activation scan a rebuilt process runs takes nothing up: this
    // hand-off is not pending any more, it already has its coordinator.
    const scan = await consumePendingHandoffs(second.ctx, STORE)
    expect(scan.consumptions).toMatchObject([{ diagnosisId: 'd-restart', result: 'existing', sessionId: supervisor }])
    expect(second.spawns).toEqual([])

    // One claim and one started row on the file, as the first process wrote them
    // — a second process does not re-decide the hand-off, and the allowance it
    // spent is not refunded.
    const rows = ledgerRows()
    expect(rows.filter(row => row.kind === 'claim' && row.role === 'supervisor')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'started' && row.sessionId === supervisor)).toHaveLength(1)
    expect(await countReviewAgentRuns(STORE)).toBe(usedBefore + 1)
    // The delegation the recovery entry checks is still readable after the crash.
    expect(await readSupervisorDelegation(supervisor, 'd-restart')).toMatchObject({
      rootStoreId: STORE,
      taskId: root.taskId,
      actor: ROOT,
      diagnosisId: 'd-restart',
    })
    // …and a *new* hand-off is answered from the count the dead process wrote:
    // with the ceiling set to exactly what it spent, nothing more starts — the
    // restart neither refunds the run nor starts counting from zero.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', String(usedBefore + 1))
    const spent = await startSupervisorHandoff(second.ctx, {
      storeId: STORE,
      diagnosis: { ...record, diagnosisId: 'd-restart-2' },
      delegator: { sessionId: ROOT, agent: second.root(ROOT) },
      sourceRef: `${root.taskId}#${root.runId}`,
      sourceOutcome: 'failed',
    })
    expect(spent).toMatchObject({ result: 'stopped', code: 'budget-exhausted' })
    expect((spent as { reason: string }).reason).toContain(`${usedBefore + 1}/${usedBefore + 1}`)
    expect(second.spawns).toEqual([])
  }, 120_000)
})

describe('A6 EVO-4: the recovery attempt whose batch was admitted and never started', () => {
  it('drives the same attempt to its end after the crash, with no second run, batch or provider', async () => {
    // The crash point: the attempt's own drain is parked on a managed job that
    // never confirms stopped, so its batch is durable and no child was started
    // when the process dies (a3-recovery's own idiom for the same window).
    const frozen = { reached: false }
    let attemptSession = ''
    let attemptRunId = ''
    const first = await boot({
      worker: async (sessionId: string) => {
        const bound = await first.runtime.runForSession(sessionId).catch(() => undefined)
        if (bound === undefined) return
        if (bound.run.recovery === undefined || bound.run.batchId !== undefined) return
        await first.runtime.decomposeAndRun(STORE, bound.task.taskId, bound.run.runId, String(sessionId), {
          reason: 're-run the failed position',
          children: [{
            objective: 'the member, again',
            acceptanceCriteria: [{ criterionId: 'member-0', description: 'it holds', command: 'true' }],
          }],
        } as never)
      },
    })
    // The crash point, frozen at the spawn: the batch is admitted (its commit is
    // durable, its member exists) and the child's worker is never started — the
    // driver hangs inside `agentRuntime.spawn` when the process dies. Parking the
    // *spawn* rather than an admitted commit's own drain is deliberate: the store's
    // write queue is not held when the descriptors are released, so what the second
    // process reads is exactly what the first one had committed.
    const realSpawn = first.agentRuntime.spawn.bind(first.agentRuntime)
    first.agentRuntime.spawn = async (parent, request) => {
      if (request.taskWorker === true && String(request.name).includes('the member, again')) {
        frozen.reached = true
        await new Promise<void>(() => {})
      }
      return await realSpawn(parent, request)
    }
    const root = await failedRoot(first)
    await first.task.recordDiagnosisIn(STORE, diagnosis(root), ROOT)

    // The attempt is opened and its worker is driven the way the deployment's own
    // loop drives it — and the driver freezes behind the admitted batch.
    const opened = first.runtime.recoverRootTask(STORE, {
      sourceTaskId: root.taskId,
      sourceRunId: root.runId,
      sourceDiagnosisId: 'd-restart',
      requestKey: 'k-batch',
    }, { sessionId: String(ROOT) })
    opened.catch(() => undefined)
    const openedRun = await vi.waitFor(async () => {
      const found = (await first.snapshot(STORE)).runs.find(run => run.recovery !== undefined)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 30_000, interval: 25 })
    attemptSession = String(openedRun.sessionId)
    attemptRunId = openedRun.runId
    // The deployment's model loop is what drives a spawned worker's turn; this
    // fixture has none, so the spec plays that driver and the worker's body runs
    // (and freezes behind its own drain).
    void first.agent(attemptSession)!.whenIdle!()
    await vi.waitFor(() => {
      expect(frozen.reached).toBe(true)
    }, { timeout: 30_000, interval: 25 })
    const beforeCrash = await vi.waitFor(async () => {
      const snapshot = await first.snapshot(STORE)
      const attempt = snapshot.runs.find(run => run.runId === attemptRunId)
      const batchHeld = attempt?.batches?.some(batch => batch.batchId === attempt.batchId) === true
      expect(batchHeld).toBe(true)
      return snapshot
    }, { timeout: 30_000, interval: 25 })
    const attempt = beforeCrash.runs.find(run => run.runId === attemptRunId)!
    expect(attempt.taskId).toBe(root.taskId)
    expect(attempt.status).toBe('running')
    expect(attempt.executionPhase).toBe('waiting_children')
    expect(attempt.recovery).toMatchObject({ requestKey: 'k-batch', sourceDiagnosisId: 'd-restart' })
    // The batch is admitted with its member created, and that member has no run:
    // this is exactly the boundary the ticket names. The store holds the root's
    // failed run, the failed member's run and the attempt's own — three runs, none
    // of them the replacement's.
    const batchEntry = attempt.batches!.find(entry => entry.batchId === attempt.batchId)!
    expect(batchEntry.memberTaskIds).toHaveLength(1)
    const replacementId = batchEntry.memberTaskIds[0]!
    expect(beforeCrash.tasks.some(task => task.taskId === replacementId)).toBe(true)
    // The member's own Run was started before its worker — and no worker was ever
    // spawned for it: the freeze above is exactly the window between the two.
    const replacementRun = beforeCrash.runs.find(run => run.taskId === replacementId)!
    expect(replacementRun.status).toBe('running')
    expect(first.spawns.some(spawn => String(spawn.sessionId) === replacementRun.sessionId)).toBe(false)
    expect(beforeCrash.runs).toHaveLength(4)
    const providerRevision = attempt.providerBinding?.registryRevision
    const runsBefore = beforeCrash.runs.length

    // The process dies with the driver frozen, and a second process boots over
    // the same directory.
    // The descriptors go, the bytes stay. The wait is bounded because a process
    // killed with a driver mid-call leaves promises that will never settle: this
    // deployment's own durability barrier is the flush inside `crash()`, and the
    // second boot below reads exactly what the first one committed.
    await Promise.race([
      first.crash(),
      new Promise(resolve => { setTimeout(resolve, 5_000).unref() }),
    ])
    await Promise.race([
      first.dispose({ remove: false }),
      new Promise(resolve => { setTimeout(resolve, 5_000).unref() }),
    ])
    const second = await boot({
      dir: first.dir,
      graphs: [{ id: 'g1', rootSessionId: ROOT, spawned: first.spawnEdges().map(edge => edge.to) }],
      worker: async () => {},
    })
    expect(second.spawns).toEqual([])
    const adopted = await second.runtime.adoptRoot(STORE, ROOT)
    expect(adopted).toMatchObject({ adopted: true, taskId: root.taskId, runId: root.runId })

    // The batch the dead process admitted is driven to its end by the second
    // process: one child, started once, verified by the real verifier — and the
    // attempt's own run is the same one it was, under the same key and content.
    const afterRestart = await second.snapshot(STORE)
    expect(afterRestart.runs.map(run => run.runId).sort()).toEqual([...beforeCrash.runs.map(run => run.runId)].sort())
    expect(afterRestart.runs.find(run => run.runId === attemptRunId)?.recovery).toMatchObject({ requestKey: 'k-batch' })
    expect(afterRestart.runs.find(run => run.runId === attemptRunId)?.providerBinding?.registryRevision).toBe(providerRevision)
    const outcomes = await second.runtime.awaitBatch(STORE, attempt.batchId!)
    // The batch came to its end in the second process, and the member it drove is
    // the **same run** the dead one created — driven, never re-created.
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.runId).toBe(replacementRun.runId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled'])
    const afterBatch = await second.snapshot(STORE)
    const settledChild = afterBatch.runs.find(run => run.taskId === replacementId)!
    expect(settledChild.runId).toBe(replacementRun.runId)
    // At this boundary the member's Run exists and its worker never did: the
    // second process refuses to invent a worker for a Session that was never
    // created (`session-missing`) and settles the run cancelled **by name** —
    // never silently, and never as a second Run for the same position.
    expect(settledChild.status).toBe('cancelled')
    const childReview = afterBatch.reviews.find(review => review.runId === replacementRun.runId)!
    expect(childReview.outcome).toBe('cancelled')
    expect(childReview.anomalies.join('\n')).toContain('was in flight when this store was reopened and never submitted')
    expect(childReview.anomalies.join('\n')).toContain('settled cancelled')
    // One run per position, one batch per attempt: the reopen added nothing.
    expect(afterBatch.runs).toHaveLength(runsBefore)
    expect(afterBatch.runs.filter(run => run.taskId === replacementId)).toHaveLength(1)

    // The same key stays answered from the record — the reopen opened no second
    // attempt — and the ceiling reads the store's own cumulative count: the four
    // runs the dead process left, none of them refunded by the restart. (A new
    // admission into the checkout this tree holds is what a *third* boot would
    // test: this fixture boots both processes inside one test process, whose
    // workspace marker names the same pid, so the read below is the ceiling's own
    // arithmetic over the store rather than a business call.)
    const answer = await second.runtime.recoverRootTask(STORE, {
      sourceTaskId: root.taskId,
      sourceRunId: root.runId,
      sourceDiagnosisId: 'd-restart',
      requestKey: 'k-batch',
    }, { sessionId: String(ROOT) })
    expect(answer.attempt).toBe('existing')
    expect(answer.runId).toBe(attemptRunId)
    const final = await second.snapshot(STORE)
    const budget = resolveRootBudget(final, { maxRuns: MAX_RUNS })
    if (!budget.ok) throw new Error(budget.reason)
    const verdict = checkRunStart(final, budget)
    expect(verdict.allowed).toBe(false)
    expect(final.runs).toHaveLength(MAX_RUNS)
    expect(verdict.reason).toContain(`allows ${MAX_RUNS} run(s)`)

  }, 120_000)
})
