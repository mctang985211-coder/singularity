import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, TaskSnapshot, VerificationResult } from '../../task/src/index.ts'
import { ROOT_PROPOSAL_TASK_ID, rootTaskStoreId } from '../../task/src/index.ts'
import type { Config, DecomposeSpec, RootContractSpec, TaskRuntime } from '../../task-runtime/src/index.ts'
import { resolveRootBudget } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, ScriptedBudgetApproval, startRunStack, type RunStack } from '../support/run-stack.ts'

/**
 * K4-2/K4-3/K4-4 on the *consumers* of an approved ceiling: the entries that
 * were refused while the tree was spent, and the ceiling they read once a person
 * has raised it.
 *
 * What each case pins, and where the pre-K4 build stood:
 *
 * 1. **An expired tree, and the replay that has to wait for a person.** A root
 *    that is past its deadline refuses every new run by name (`checkRunStart`),
 *    the replay included. Only the person's approval moves the ceiling, and the
 *    replay that then starts runs along the *champion's own* criteria, judged by
 *    the same verifier, with every record that existed before it untouched. What
 *    the commit itself does is one event and one ceiling: the store's runs,
 *    tasks, edges, evidence and reviews are byte-identical around it.
 * 2. **A spent run allowance, and the count that is never zeroed.** The batch
 *    entry and the replay entry both refuse at the configured total; the approved
 *    total then admits exactly the runs it says — the replay that was refused
 *    starts, the batch that was refused is admitted — and a third attempt is
 *    refused again, because the runs already recorded still count. A ceiling that
 *    had been reset (or read as a fresh allowance) would admit more.
 * 3. **Two grants against one reading.** Two commits, each approved against the
 *    same reading the runtime froze for it, are issued together: the store's own
 *    write queue decides, one stands, and the other is refused with nothing
 *    written — the raise is not re-based on the first grant's result.
 *
 * The store, the runtime entries, the real verifier, the real agent plane and the
 * checkpoint ownership are the deployment's own (run-stack); what the fixture
 * replaces is the model loop, as every A3/K1 spec here does. The person each
 * request is put to is scripted ({@link ScriptedBudgetApproval}): the deployment's
 * real callback and channel run end to end in `k4-budget-extend.spec.ts`, and
 * these cases are about the entries that *consume* a ceiling a person approved.
 *
 * What the person's approval is *not*, here: a read the caller could perform for
 * itself. There is no query entry and no commit a caller can hand a reading to —
 * the entry freezes the reading, asks the installed approval, and the store
 * re-checks the frozen reading inside its own write queue.
 */

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))

/**
 * The host execution one request is asked under: the host's own identity for the
 * call, and a host execution the runtime carries untouched to the approval. Each
 * call names its own, as two tool calls would.
 */
const host = (callId: string) => ({
  callId,
  execution: { agent: { id: String(ROOT) }, signal: new AbortController().signal },
})

afterEach(async () => {
  await disposeRunStacks()
})

/** One child spec: a goal and a criterion the real command verifier settles. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** The tree's ceilings for one case, spelled out where the case is read. */
const budget = (limits: Config['rootBudget']): Config['rootBudget'] => ({ ...limits })

/** Every event kind one store appended, in order. */
function eventKinds(h: RunStack, storeId = STORE): string[] {
  return h.events(storeId).map(event => event.kind)
}

/** The verdicts one run's own evidence holds, read from the store, never from a return value. */
function verdictsOf(snapshot: TaskSnapshot, runId: string): readonly VerificationResult[] {
  return snapshot.evidence
    .filter((bundle: EvidenceBundle) => bundle.taskRunId === runId)
    .flatMap(bundle => bundle.verifierResults)
}

/** The ceiling in force one snapshot leaves, through the one resolver every admission path reads. */
function effectiveCeiling(snapshot: TaskSnapshot, limits: Config['rootBudget']) {
  const resolution = resolveRootBudget(snapshot, limits ?? {})
  if (!resolution.ok) throw new Error(`the budget did not resolve: ${resolution.reason}`)
  return resolution
}

/** The ones of `records` whose `runId`/`taskId` is not in `except` — what an entry left untouched. */
function exceptIds<T extends { runId: string }>(records: readonly T[], except: readonly string[]): T[] {
  return records.filter(record => !except.includes(record.runId))
}

/** One recorded run of the tree, read as the store holds it — the subject a refusal may not move. */
function runOf(snapshot: TaskSnapshot, runId: string) {
  const run = snapshot.runs.find(candidate => candidate.runId === runId)
  if (run === undefined) throw new Error(`the store holds no run "${runId}"`)
  return run
}

describe('K4-2/K4-4: an expired tree’s entries read the ceiling a person approved', () => {
  it('reads the approved total at the batch and replay entries, and never counts from zero', async () => {
    const limits = budget({ maxRuns: 2 })
    const h = await startRunStack({ roots: [ROOT], rootBudget: limits })
    const root = await h.root(ROOT, ROOT_CONTRACT)
    const first = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
      reason: 'split the work',
      children: children('batch A child'),
    })
    expect((await h.runtime.awaitBatch(STORE, first.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    const championTaskId = first.childTaskIds[0]!
    // The tree holds exactly the configured total: root run + the one member run.
    const atTotal = await h.snapshot(STORE)
    expect(atTotal.runs).toHaveLength(2)

    // The ordinary new-batch entry is refused *whole* at the configured total:
    // the reservation cannot fit one more run, so no child task is created, no
    // run starts and no admission event is written. The request itself is left on
    // the record by the entry's own protocol (T2/T3 §6: a refusal is read back
    // and a revision — or, here, the same request once a person has paid for it —
    // is what continues it), and every other fact is untouched.
    const batchRefusal = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
      reason: 'a second round the budget cannot afford',
      children: children('batch B child'),
    }).then(() => undefined, (error: unknown) => error as Error)
    expect(batchRefusal?.message).toContain('would need 1 run slot(s) and the root budget allows 2 run(s) in total')
    const afterBatchRefusal = await h.snapshot(STORE)
    expect({ ...afterBatchRefusal, proposals: atTotal.proposals }).toEqual(atTotal)
    const knownProposals = new Set(atTotal.proposals!.all.map(proposal => proposal.proposalId))
    const refusedRequest = afterBatchRefusal.proposals!.all.filter(proposal => !knownProposals.has(proposal.proposalId))
    expect(refusedRequest).toHaveLength(1)
    expect(refusedRequest[0]!.status).toBe('ready')
    // The root contract's own admission rides the same event kind under the
    // reserved envelope task id; the store holds the batch's admission only,
    // which is the first batch — the refused one was never admitted.
    const admissions = h.events(STORE).filter(event => event.kind === 'TaskProposalAdmitted')
    expect(admissions.filter(event => event.taskId !== ROOT_PROPOSAL_TASK_ID)).toHaveLength(1)

    // …and the replay is refused by name, with the count it read, writing
    // nothing at all — not even a record of the attempt.
    const replayRefusal = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-runs', spawn: false }, String(ROOT))
      .then(() => undefined, (error: unknown) => error as Error)
    expect(replayRefusal?.message).toContain('allows 2 run(s)')
    expect(replayRefusal?.message).toContain('already holds 2')
    expect(await h.snapshot(STORE)).toEqual(afterBatchRefusal)

    // The person approves two more runs, as a whole total: the ask holds the
    // reading in force — the configured total, which is also the approved one,
    // and the two runs already counted — and the approval itself records one
    // event, nothing else.
    const person = new ScriptedBudgetApproval(false)
    person.install(h)
    const raise = await h.runtime.extendRootBudget(String(ROOT), host('call-k4-runs'), { requestKey: 'k-two-more', maxRuns: 4 })
    expect(person.asks).toHaveLength(1)
    expect(person.asks[0]!.effective).toEqual({ maxRuns: 2 })
    expect(person.asks[0]!.configured).toEqual({ maxRuns: 2 })
    expect(person.asks[0]!.runsUsed).toBe(2)
    expect(raise.answeredFromRecord).toBe(false)
    expect(raise.record.maxRuns).toEqual({ previous: 2, next: 4 })
    expect(effectiveCeiling(await h.snapshot(STORE), limits).maxRuns).toBe(4)

    // Exactly what the approved total says: the refused replay starts, and the
    // batch the configured total refused is admitted — the same request, and the
    // two runs the person paid for, no more.
    const replay = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-runs', spawn: false }, String(ROOT))
    expect(replay.status).toBe('verified')
    const second = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
      reason: 'a second round the budget cannot afford',
      children: children('batch B child'),
    })
    expect(second.proposalId).toBe(refusedRequest[0]!.proposalId)
    expect((await h.runtime.awaitBatch(STORE, second.batchId)).map(outcome => outcome.status)).toEqual(['verified'])
    const spent = await h.snapshot(STORE)
    expect(spent.runs).toHaveLength(4)

    // And the approved total is the ceiling, not a fresh allowance: the runs the
    // tree already had still count against it, so both entries refuse again. The
    // replay writes nothing at all; the batch, refused whole, leaves only its own
    // request on the record — no fifth run, no child task, no admission.
    const spentEvents = eventKinds(h)
    const refusedReplay = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:k4-runs-2', spawn: false }, String(ROOT))
      .then(() => undefined, (error: unknown) => error as Error)
    expect(refusedReplay?.message).toContain('allows 4 run(s)')
    expect(refusedReplay?.message).toContain('already holds 4')
    expect(await h.snapshot(STORE)).toEqual(spent)
    const refusedBatch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, String(ROOT), {
      reason: 'a third round the approved total cannot afford',
      children: children('batch C child'),
    }).then(() => undefined, (error: unknown) => error as Error)
    expect(refusedBatch?.message).toContain('(5 > 4)')
    const afterRefusedBatch = await h.snapshot(STORE)
    expect({ ...afterRefusedBatch, proposals: spent.proposals }).toEqual(spent)
    const knownAtSecondRefusal = new Set(afterBatchRefusal.proposals!.all.map(proposal => proposal.proposalId))
    const refusedAgain = afterRefusedBatch.proposals!.all.filter(proposal => !knownAtSecondRefusal.has(proposal.proposalId))
    expect(refusedAgain).toHaveLength(1)
    expect(refusedAgain[0]!.status).toBe('ready')
    expect(afterRefusedBatch.runs).toHaveLength(4)
    expect(h.spawns).toHaveLength(2)
    // The refused batch appended exactly one thing: the record of the request.
    expect(eventKinds(h).slice(spentEvents.length)).toEqual(['TaskProposalSubmitted'])
  }, 60_000)

  it('lets only one of two grants approved against one reading stand, and writes nothing for the other', async () => {
    const limits = budget({ maxRuns: 4 })
    const h = await startRunStack({ roots: [ROOT], rootBudget: limits })
    await h.root(ROOT, ROOT_CONTRACT)
    // Two requests, one reading: the shape of two people deciding about the same
    // tree, or one retry racing another caller. Both are asked under their own
    // call, and the person holds both questions — which is what makes the two
    // grants sit on one reading: each entry freezes the ceiling in force *before*
    // it asks, so neither has been answered yet when the other one froze the same
    // numbers. There is no reading a caller supplies and no query to run: the
    // reading the store re-checks is the one each entry froze for itself.
    const person = new ScriptedBudgetApproval(true)
    person.install(h)
    const before = await h.snapshot(STORE)
    const beforeEvents = eventKinds(h)
    const racing = [
      h.runtime.extendRootBudget(String(ROOT), host('call-a'), { requestKey: 'k-a', maxRuns: 8 }),
      h.runtime.extendRootBudget(String(ROOT), host('call-b'), { requestKey: 'k-b', maxRuns: 10 }),
    ]
    await vi.waitFor(() => expect(person.asks).toHaveLength(2))
    expect(person.asks.map(ask => ask.effective)).toEqual([{ maxRuns: 4 }, { maxRuns: 4 }])
    expect(person.asks.map(ask => ask.proposal.requestKey).sort()).toEqual(['k-a', 'k-b'])

    // Both grants are approved against that one reading and committed together:
    // the store's own write queue decides.
    person.allow()
    const grants = await Promise.allSettled(racing)
    const fulfilled = grants.filter(settled => settled.status === 'fulfilled')
    const rejected = grants.filter(settled => settled.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser is told the ceiling moved under it — the reading it was approved
    // against is no longer the ceiling in force, so its commit is refused rather
    // than re-based on the winner's result.
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error
    expect(reason.message).toMatch(/moved since this request was read|the ceiling in force here is/)

    // Exactly one extension stands, and it is the one whose commit won.
    const after = await h.snapshot(STORE)
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<TaskRuntime['extendRootBudget']>>>).value
    expect(after.budgetExtensions?.all.map(entry => entry.requestKey)).toEqual([winner.record.requestKey])
    expect(effectiveCeiling(after, limits).maxRuns).toBe(winner.record.maxRuns?.next)
    expect(eventKinds(h).slice(beforeEvents.length)).toEqual(['TaskBudgetExtended'])
    expect({ ...after, budgetExtensions: before.budgetExtensions }).toEqual(before)
  }, 60_000)
})
