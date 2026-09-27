import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { Config, DecomposeSpec, RootBudgetExtensionDraft, RootContractSpec } from '../../task-runtime/src/index.ts'
import { resolveRootBudget } from '../../task-runtime/src/index.ts'
import {
  disposeRunStacks,
  exportSessionLogs,
  replaySessionLogs,
  startRunStack,
  type RunStack,
} from '../support/run-stack.ts'

/**
 * K4-3/K4-4 across a restart: the approved ceiling is a fact of the store, not
 * of the process that recorded it.
 *
 * What each case pins:
 *
 * 1. **A request read in one process, committed in the next.** The query writes
 *    nothing, so the approval a person gave before the process ended still rests
 *    on the same reading afterwards — and the commit stands. Two restarts later
 *    the same key is answered from the record: no second approval, no second
 *    event, the same ceiling. What survives with it: the usage (the runs already
 *    counted), the deadline (an absolute instant, never re-derived from the
 *    restart) and the deployment's own number beside the approved one.
 * 2. **A reopened store’s replay reads the approved total.** The tree spent its
 *    configured allowance before the restart, so the replay is refused then; the
 *    person raises the total; the next process adopts the store through the
 *    deployment's own recovery door and the replay runs — the run the configured
 *    ceiling could never have paid for — and the approved total is what refuses
 *    the next one.
 *
 * The reopen is a second process image over one directory (`run-stack`'s own
 * `workspace` plus its session-log handover, the K2 pattern): a new `Context`,
 * new services, a new runtime, and the store read back from the carried log. The
 * first image is closed the way an unload closes a deployment — drivers aborted,
 * gates closed, its workspace markers released — which is the state a restart
 * reads.
 */

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))
/** The file one process hands the next its whole session log through. */
const HANDOVER = 'sessions.json'

const directories: string[] = []

afterEach(async () => {
  await disposeRunStacks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One directory two boots share — the workspace a reopened process reads its store from. */
function sharedDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'singularity-k4-reopen-'))
  directories.push(directory)
  return directory
}

/** One child spec: a goal and a criterion the real command verifier settles. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/**
 * Close one process image and open the next over the same directory: the
 * deployment's logs travel as one file and are replayed verbatim, exactly what a
 * deployment's on-disk session logs give its next process for nothing. The first
 * image is disposed before the second starts, so its workspace markers are
 * released the way an unload releases them; the store is then read back through
 * the new process's own read door, from its own log.
 */
async function reopen(h: RunStack, directory: string, limits: Config['rootBudget']): Promise<{ h: RunStack; opened: TaskSnapshot }> {
  const carried = await exportSessionLogs(h)
  writeFileSync(join(directory, HANDOVER), carried, 'utf8')
  await h.dispose()
  const next = await startRunStack({ workspace: directory, roots: [ROOT], rootBudget: limits })
  await replaySessionLogs(next, readFileSync(join(directory, HANDOVER), 'utf8'))
  return { h: next, opened: await next.task.openStore(STORE) }
}

/** Every event kind one store appended, in order. */
function eventKinds(h: RunStack): string[] {
  return h.events(STORE).map(event => event.kind)
}

/** The ceiling in force one snapshot leaves, through the one resolver every admission path reads. */
function effectiveCeiling(snapshot: Awaited<ReturnType<RunStack['snapshot']>>, limits: Config['rootBudget']) {
  const resolution = resolveRootBudget(snapshot, limits ?? {})
  if (!resolution.ok) throw new Error(`the budget did not resolve: ${resolution.reason}`)
  return resolution
}

/** One real batch, settled: the tree holds a champion whose verdicts a replay has to reproduce. */
async function runFirstBatch(h: RunStack, root: { taskId: string; runId: string }): Promise<string> {
  const first = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
    reason: 'split the work',
    children: children('the work the tree pays for'),
  })
  expect((await h.runtime.awaitBatch(STORE, first.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
  return first.childTaskIds[0]!
}

/**
 * One person's decision, recorded the way the deployment's approval service
 * records it — a fresh service-issued `ApprovalRequestId`, the `approval/asked`
 * naming the tool call with the card as its reason, and the `approval/decided`
 * that pairs with it — written into the root session's own log, which is where
 * the committing entry reads a grant back out of.
 *
 * This fixture replaces the human seam with a stand-in that answers without
 * recording anything, so a case whose subject is what an approval *means* across
 * a reopen writes the record here, in the service's own shape. The real service,
 * the real tool and the real ask run end to end in `k4-budget-extend.spec.ts`.
 * What matters here is that the record travels with the session log the next
 * process replays, because that is what a person's decision is.
 * @param h - the stack whose root session log is the record's surface.
 * @param reading - the draft the decision is about, whose binding it must carry.
 * @returns the tool-call identity the commit has to present.
 */
async function personApproves(h: RunStack, reading: RootBudgetExtensionDraft, callId: string): Promise<string> {
  const persistence = h.ctx.get('sessionPersistence') as unknown as {
    open(id: SessionId): Promise<{ append(events: readonly unknown[]): Promise<void> }>
  }
  const id = randomUUID()
  const handle = await persistence.open(ROOT)
  await handle.append([
    {
      type: 'approval/asked',
      time: Date.now(),
      data: { id, toolName: 'task_budget_extend', callId, reason: `Budget extension of the tree in store "${reading.storeId}" — approval binding: ${String(reading.approvalBinding)}` },
    },
    { type: 'approval/decided', time: Date.now(), data: { id, outcome: 'allowed-once' } },
  ])
  return callId
}

describe('K4-3: the approved ceiling is the store’s fact, across a reopen', () => {
  it('commits a request read before the restart, answers the retry from the record, and moves neither usage nor the clock', async () => {
    const limits: Config['rootBudget'] = { wallTimeMs: 60_000, maxRuns: 4 }
    const directory = sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT], rootBudget: limits })
    const root = await h1.root(ROOT, ROOT_CONTRACT)
    await runFirstBatch(h1, root)
    const openedWith = await h1.snapshot(STORE)
    expect(openedWith.runs).toHaveLength(2)

    // The person is asked about this request, and the query itself writes
    // nothing: the store holds no extension and its log is what it was.
    const approved = { requestKey: 'k-more-room', maxRuns: 6, deadlineAt: new Date(Date.now() + 1_800_000).toISOString() }
    const reading = await h1.runtime.budgetExtensionDraft(String(ROOT), approved)
    expect(reading.outcome.kind).toBe('proposed')
    expect(reading.effective).toEqual({ maxRuns: 4, deadlineAt: effectiveCeiling(openedWith, limits).deadlineAt })
    expect(reading.runsUsed).toBe(2)
    expect(await h1.snapshot(STORE)).toEqual(openedWith)

    // The process ends after the person's answer: the approval travels as the
    // decision the channel recorded on the session's own log, and the request is
    // still the same request.
    await personApproves(h1, reading, 'call-k4-reopen')
    const { h: h2, opened: reopened } = await reopen(h1, directory, limits)
    expect(reopened.budgetExtensions?.all).toEqual([])
    expect(reopened.runs.map(run => run.runId)).toEqual(openedWith.runs.map(run => run.runId))
    const beforeCommit = eventKinds(h2)
    const record = await h2.runtime.extendRootBudget(String(ROOT), {
      ...approved,
      baseline: reading.effective,
      callId: 'call-k4-reopen',
    })
    expect(record.maxRuns).toEqual({ previous: 4, next: 6 })
    expect(record.deadlineAt).toEqual({ previous: reading.effective.deadlineAt, next: approved.deadlineAt })
    expect(eventKinds(h2).slice(beforeCommit.length)).toEqual(['TaskBudgetExtended'])

    // The usage and the tree's own start are untouched, and the approved
    // deadline is the instant that was approved — not a window re-measured from
    // the restart, and not the deployment's number recomputed.
    const granted = await h2.snapshot(STORE)
    expect(granted.runs.map(run => run.runId)).toEqual(openedWith.runs.map(run => run.runId))
    const raised = effectiveCeiling(granted, limits)
    expect(raised.maxRuns).toBe(6)
    expect(raised.deadlineAt).toBe(approved.deadlineAt)
    expect(raised.acceptedAt).toBe(openedWith.runs.find(run => run.sessionId === String(ROOT))!.startedAt)
    expect(raised.configured).toEqual({ maxRuns: 4, deadlineAt: effectiveCeiling(openedWith, limits).deadlineAt })

    // One restart later the same request is answered from the record: no second
    // approval, no second event, and the ceiling is where the person left it.
    const { h: h3, opened: afterRestart } = await reopen(h2, directory, limits)
    expect(afterRestart.budgetExtensions?.all).toHaveLength(1)
    const eventsBeforeRetry = eventKinds(h3)
    const retried = await h3.runtime.extendRootBudget(String(ROOT), {
      ...approved,
      baseline: reading.effective,
      callId: 'call-k4-reopen',
    })
    expect(retried).toEqual(record)
    expect(eventKinds(h3)).toEqual(eventsBeforeRetry)
    expect(await h3.snapshot(STORE)).toEqual(afterRestart)
    const stillRaised = effectiveCeiling(await h3.snapshot(STORE), limits)
    expect(stillRaised.maxRuns).toBe(6)
    expect(stillRaised.deadlineAt).toBe(approved.deadlineAt)
    // The query in the third process reports the same two numbers and the same
    // request key already recorded.
    const reported = await h3.runtime.budgetExtensionDraft(String(ROOT), approved)
    expect(reported.outcome.kind).toBe('recorded')
    expect(reported.effective).toEqual({ maxRuns: 6, deadlineAt: approved.deadlineAt })
    expect(reported.configured).toEqual({ maxRuns: 4, deadlineAt: reading.effective.deadlineAt })
    expect(reported.runsUsed).toBe(2)
  }, 60_000)

  it('lets a reopened store’s replay run on the approved total the configured one had spent', async () => {
    const limits: Config['rootBudget'] = { maxRuns: 2 }
    const directory = sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT], rootBudget: limits })
    const root = await h1.root(ROOT, ROOT_CONTRACT)
    const championTaskId = await runFirstBatch(h1, root)
    const champion = await h1.task.taskIn(STORE, championTaskId)

    // The configured total is spent (root run + member run): the replay is
    // refused by name in this process, with nothing written.
    const spent = await h1.snapshot(STORE)
    await expect(h1.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-reopen', spawn: false }, String(ROOT)))
      .rejects.toThrow(/allows 2 run\(s\)[\s\S]*already holds 2/)
    expect(await h1.snapshot(STORE)).toEqual(spent)

    // The person raises the total, and then the process image ends.
    const reading = await h1.runtime.budgetExtensionDraft(String(ROOT), { requestKey: 'k-replay-room', maxRuns: 4 })
    expect(reading.effective).toEqual({ maxRuns: 2 })
    await personApproves(h1, reading, 'call-k4-replay')
    await h1.runtime.extendRootBudget(String(ROOT), {
      requestKey: 'k-replay-room',
      maxRuns: 4,
      baseline: reading.effective,
      callId: 'call-k4-replay',
    })
    const { h: h2, opened } = await reopen(h1, directory, limits)

    // The reopened process takes the store over through the deployment's own
    // recovery door, and the barrier says the store is ready to execute against.
    const adopted = await h2.runtime.adoptRoot(STORE, String(ROOT))
    expect(adopted.adopted).toBe(true)
    if (!adopted.adopted) throw new Error('unreachable')
    expect(adopted.taskId).toBe(root.taskId)
    expect((await h2.runtime.recoveryStatus(STORE)).status).toBe('ready')
    const reopened = await h2.snapshot(STORE)
    expect(reopened.runs).toHaveLength(2)
    expect(effectiveCeiling(reopened, limits)).toMatchObject({ maxRuns: 4, configured: { maxRuns: 2 } })
    expect(opened.budgetExtensions?.all).toHaveLength(1)

    // The replay the configured total refused runs here: two of the four runs
    // were already spent before the restart, and the approved total is what pays
    // for the third.
    const replay = await h2.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-reopen', spawn: false }, String(ROOT))
    expect(replay.status).toBe('verified')
    const replayed = await h2.task.taskIn(STORE, replay.taskId)
    expect(replayed.acceptanceCriteria).toEqual(champion.acceptanceCriteria)
    const after = await h2.snapshot(STORE)
    expect(after.runs).toHaveLength(3)
    expect(after.evidence.filter(bundle => bundle.taskRunId === replay.runId).flatMap(bundle => bundle.verifierResults)
      .map(verdict => [verdict.criterionId, verdict.status, verdict.verifierId]))
      .toEqual([['ac1-1', 'pass', 'command']])
    // The records the tree held before the reopen are exactly what they were.
    expect(after.runs.filter(run => run.runId !== replay.runId)).toEqual(reopened.runs)
    expect(after.tasks.filter(task => task.taskId !== replay.taskId)).toEqual(reopened.tasks)

    // And the approved total is the ceiling in the reopened process too: the
    // fourth run is the last one the person paid for, so it is admitted and the
    // next replay is refused with the count the store holds.
    const last = await h2.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-reopen-2', spawn: false }, String(ROOT))
    expect(last.status).toBe('verified')
    const afterLast = await h2.snapshot(STORE)
    expect(afterLast.runs).toHaveLength(4)
    await expect(h2.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-reopen-3', spawn: false }, String(ROOT)))
      .rejects.toThrow(/allows 4 run\(s\)[\s\S]*already holds 4/)
    expect(await h2.snapshot(STORE)).toEqual(afterLast)
  }, 60_000)
})
