import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { resolveRootBudget } from '../../task-runtime/src/index.ts'
import {
  disposeRunStacks,
  exportSessionLogs,
  replaySessionLogs,
  ScriptedBudgetApproval,
  startRunStack,
  type RunStack,
} from '../support/run-stack.ts'

/**
 * K4-3/K4-4 across a restart: the approved ceiling is a fact of the store, not
 * of the process that recorded it.
 *
 * What each case pins:
 *
 * 1. **The person is asked, and the raise is the store's.** The ask holds the
 *    whole reading in force, the usage and the raise, and *nothing* is written
 *    while it waits; the answer records one event under the host's own call id,
 *    and the fact travels into the next process with the store. What survives
 *    with it: the usage (the runs already counted), the deadline (an absolute
 *    instant, never re-derived from the restart) and the deployment's own number
 *    beside the approved one.
 * 2. **A reopened store’s replay reads the approved total.** The tree spent its
 *    configured allowance before the restart, so the replay is refused then; the
 *    person raises the total; the next process adopts the store through the
 *    deployment's own recovery door and the replay runs — the run the configured
 *    ceiling could never have paid for — and the approved total is what refuses
 *    the next one.
 * 3. **A recorded request asks nobody, in any process.** The retry travels
 *    through a runtime with no answer to give (the scripted person below is
 *    installed, and never consulted), is answered from the record, and appends
 *    nothing.
 *
 * The person is scripted (`ScriptedBudgetApproval`): the deployment's real
 * callback — the DSH channel, the rendered card and its `approval/asked` +
 * `approval/decided` audit pair — runs end to end in `k4-budget-extend.spec.ts`,
 * and what these cases are about is the store's durable fact. A person created
 * with `hold` is one nobody has answered yet, which is how a case asserts what
 * the tree looks like while somebody thinks; the plain one answers `allowed-once`
 * at once, under the host's own call identity.
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

/**
 * The host execution one request is asked under: the host's own identity for the
 * call, and a host execution the runtime carries untouched to the approval.
 */
const HOST = { callId: 'call-k4-reopen', execution: { agent: { id: String(ROOT) }, signal: new AbortController().signal } }

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
  objective, requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release', requiredCapabilities: ['execute-task'],
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

describe('K4-3: the approved ceiling is the store’s fact, across a reopen', () => {
  it('records the raise a person approved, survives two restarts, and answers the retry from the record without a second approval', async () => {
    const limits: Config['rootBudget'] = { maxRuns: 4 }
    const directory = sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT], rootBudget: limits })
    const root = await h1.root(ROOT, ROOT_CONTRACT)
    await runFirstBatch(h1, root)
    const openedWith = await h1.snapshot(STORE)
    expect(openedWith.runs).toHaveLength(2)

    // The person is asked about this request, and the question holds everything
    // the decision needs: the store, the whole reading in force beside the
    // deployment's own, the usage and the raise. Nothing is written while they
    // think — the ask is held on this scripted person, the store holds no
    // extension, and its log is what it was.
    const person = new ScriptedBudgetApproval(true)
    person.install(h1)
    const approved = { requestKey: 'k-more-room', maxRuns: 6 }
    const pending = h1.runtime.extendRootBudget(String(ROOT), HOST, approved)
    await vi.waitFor(() => expect(person.asks).toHaveLength(1))
    const ask = person.asks[0]!
    expect(ask.storeId).toBe(STORE)
    expect(ask.rootSessionId).toBe(String(ROOT))
    expect(ask.effective).toEqual({ maxRuns: 4 })
    expect(ask.configured).toEqual({ maxRuns: 4 })
    expect(ask.runsUsed).toBe(2)
    expect(ask.proposal).toMatchObject({
      requestKey: 'k-more-room',
      maxRuns: { previous: 4, next: 6 },
    })
    expect(ask.host.callId).toBe(HOST.callId)
    expect((await h1.snapshot(STORE)).budgetExtensions?.all).toEqual([])
    expect(await h1.snapshot(STORE)).toEqual(openedWith)

    // The person answers: the raise is one event on this store, under the call
    // the question was asked under, and nothing else of the tree moved.
    const beforeCommit = eventKinds(h1)
    person.allow()
    const committed = await pending
    expect(committed.storeId).toBe(STORE)
    expect(committed.rootTaskId).toBe(root.taskId)
    expect(committed.answeredFromRecord).toBe(false)
    expect(committed.record.maxRuns).toEqual({ previous: 4, next: 6 })
    expect(committed.record.approvalRef).toBe(`approval:${HOST.callId}`)
    expect(eventKinds(h1).slice(beforeCommit.length)).toEqual(['TaskBudgetExtended'])
    expect((await h1.snapshot(STORE)).runs.map(run => run.runId)).toEqual(openedWith.runs.map(run => run.runId))

    // The next process reads the same fact from the carried log: the record, the
    // usage it was measured against, and the ceiling it left in force. The
    // retry travels through a runtime whose person is never consulted — the
    // record answers it — and appends nothing.
    const { h: h2, opened: reopened } = await reopen(h1, directory, limits)
    expect(reopened.budgetExtensions?.all).toHaveLength(1)
    expect(reopened.budgetExtensions?.byRequestKey['k-more-room']).toEqual(committed.record)
    expect(reopened.runs.map(run => run.runId)).toEqual(openedWith.runs.map(run => run.runId))
    const never = new ScriptedBudgetApproval(true)
    never.install(h2)
    const beforeRetry = eventKinds(h2)
    const retried = await h2.runtime.extendRootBudget(String(ROOT), HOST, approved)
    expect(retried.answeredFromRecord).toBe(true)
    expect(retried.record).toEqual(committed.record)
    expect(never.asks).toEqual([])
    expect(eventKinds(h2)).toEqual(beforeRetry)
    expect(await h2.snapshot(STORE)).toEqual(reopened)

    // The approved run ceiling and the original usage survive the restart.
    const granted = await h2.snapshot(STORE)
    expect(granted.runs.map(run => run.runId)).toEqual(openedWith.runs.map(run => run.runId))
    const raised = effectiveCeiling(granted, limits)
    expect(raised.maxRuns).toBe(6)
    expect(raised.configured).toEqual({ maxRuns: 4 })

    // One restart later the same request is still answered from the record: no
    // second approval, no second event, and the ceiling is where the person left
    // it. Nothing about the answer needs the process that recorded it.
    const { h: h3, opened: afterRestart } = await reopen(h2, directory, limits)
    expect(afterRestart.budgetExtensions?.all).toHaveLength(1)
    const neverAgain = new ScriptedBudgetApproval(true)
    neverAgain.install(h3)
    const eventsBeforeRetry = eventKinds(h3)
    const retriedAgain = await h3.runtime.extendRootBudget(String(ROOT), HOST, approved)
    expect(retriedAgain.answeredFromRecord).toBe(true)
    expect(retriedAgain.record).toEqual(committed.record)
    expect(neverAgain.asks).toEqual([])
    expect(eventKinds(h3)).toEqual(eventsBeforeRetry)
    expect(await h3.snapshot(STORE)).toEqual(afterRestart)
    const stillRaised = effectiveCeiling(await h3.snapshot(STORE), limits)
    expect(stillRaised.maxRuns).toBe(6)
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

    // The person raises the total — a raise the reopened process will read back
    // as the ceiling in force — and then the process image ends.
    const person = new ScriptedBudgetApproval(false)
    person.install(h1)
    const raise = await h1.runtime.extendRootBudget(String(ROOT), HOST, { requestKey: 'k-replay-room', maxRuns: 4 })
    expect(person.asks).toHaveLength(1)
    expect(person.asks[0]!.effective).toEqual({ maxRuns: 2 })
    expect(raise.answeredFromRecord).toBe(false)
    expect(raise.record.maxRuns).toEqual({ previous: 2, next: 4 })
    expect(effectiveCeiling(await h1.snapshot(STORE), limits).maxRuns).toBe(4)
    const { h: h2, opened } = await reopen(h1, directory, limits)

    // The reopened process asks nobody: the record answers the same request, so
    // the raise this process executes under is the fact the previous one left.
    const never = new ScriptedBudgetApproval(true)
    never.install(h2)
    const retried = await h2.runtime.extendRootBudget(String(ROOT), HOST, { requestKey: 'k-replay-room', maxRuns: 4 })
    expect(retried.answeredFromRecord).toBe(true)
    expect(retried.record).toEqual(raise.record)
    expect(never.asks).toEqual([])

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
    expect(opened.budgetExtensions?.byRequestKey['k-replay-room']).toEqual(raise.record)

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
