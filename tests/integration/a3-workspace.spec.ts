import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { WorkspaceBusyError } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, type RunStack, type ToolCallResult } from '../support/run-stack.ts'

/**
 * A3 acceptance on the cross-entry rules: the same admission checks that guard
 * a tool call guard a direct service call, a second root, and a replay.
 *
 * The four cases here are the ones a per-entry test cannot show:
 *
 * 1. **Two roots, one checkout.** A root run holds its workspace for as long as
 *    it is non-terminal, so a second root's own intake is refused at activation —
 *    before its tree exists, with only the proposal record left to show the
 *    attempt — and once the first tree reaches a terminal state, the checkout is
 *    released and the second root may be created.
 * 2. **A replay obeys the same rules.** `replayTask` claims the caller's
 *    checkout too, so a replay from a second root into a checkout the first root
 *    holds is refused with nothing persisted; and a spawning replay's worker is
 *    held to the same completion protocol as any worker — an idle session
 *    without a submission is stopped by the no-progress budget.
 * 3. **The layer a replay holds is its own run's.** §3.4 compares a holder by
 *    task, so the layer a spawning replay takes names the replayed task beside
 *    its lineage label — otherwise the replayed worker's own `task_decompose`
 *    would be refused as another writer's — and the release that ends the replay
 *    leaves the caller's layer as the holder again.
 * 4. **The service API is not a bypass.** `decomposeAndRun` called directly
 *    (never through `task_decompose`) runs the same admission, including the
 *    ownership check, and refuses with zero side effects.
 *
 * The model loop is replaced by run-stack's worker hook; everything else is the
 * deployment's own — the real store, runtime, workspace registry, agent plane
 * and verifier.
 */

const ROOT1 = 's-root' as SessionId
const ROOT2 = 's-root2' as SessionId

afterEach(async () => {
  await disposeRunStacks()
})

const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/** The ownership markers this process has written under one stack's run-binding root. */
function markers(h: RunStack): string[] {
  const directory = join(h.home, 'singularity', 'run-bindings', 'workspace-owners')
  return existsSync(directory) ? readdirSync(directory) : []
}

/**
 * The owner one workspace's marker file names, as the file on disk holds it — the
 * record a second process reads and the identity §3.4's admission compares.
 */
function markerOwner(h: RunStack): Record<string, unknown> {
  const files = markers(h)
  if (files.length !== 1) throw new Error(`expected exactly one workspace marker, found ${files.length}`)
  const file = join(h.home, 'singularity', 'run-bindings', 'workspace-owners', files[0]!)
  return (JSON.parse(readFileSync(file, 'utf8')) as { owner: Record<string, unknown> }).owner
}

/**
 * Write one terminal champion task straight into the store — the record a replay
 * descends from. Built through the store's own service so the replay's subject is
 * the historical shape, not a fixture invention.
 */
async function writeChampion(h: RunStack, storeId: string): Promise<{ taskId: string; runId: string }> {
  const taskId = 't-champion'
  const runId = 'r-champion'
  await h.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: 'champion work',
    depth: 0,
    acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId,
    taskId,
    sessionId: 's-champion',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${runId}`,
    taskRunId: runId,
    taskId,
    artifacts: [],
    verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fake-verifier' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, taskId, runId, 'verified', 'tester')
  return { taskId, runId }
}


/**
 * The root contract this spec's trees run under (A0 §1.2): one goal, one
 * criterion a command settles. The intake is real here — these cases are about
 * what happens to a live tree — so the contract is stated explicitly rather than
 * defaulted: a root contract owes at least one mandatory criterion judged by
 * something other than the composite conjunction, and a fixture that supplied one
 * silently would be answering the question under test.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

describe('workspace ownership across entries (A3)', () => {
  it('refuses a second root on a held checkout with nothing written, and admits it once the first tree is terminal', async () => {
    const h = await startRunStack({ roots: [ROOT1, ROOT2] })
    const first = await h.root(ROOT1, rootContract('the first tree'))
    // The first root's run is `active` and holds the checkout it will write into.
    expect((await h.runtime.runForSession(ROOT1)).run.executionPhase).toBe('active')
    expect(markers(h)).toHaveLength(1)

    // The second root's own entry is refused before anything of its tree exists —
    // and the refusal names the holder, not just "busy".
    await expect(h.root(ROOT2, rootContract('the second tree'))).rejects.toThrow(WorkspaceBusyError)
    const secondStoreId = rootTaskStoreId(ROOT2)
    const refused = await h.task.openStore(secondStoreId)
    expect(refused.tasks).toHaveLength(0)
    expect(refused.runs).toHaveLength(0)
    // The holder is the first root's run, and its own store is untouched.
    const firstSnapshot = await h.snapshot(first.storeId)
    expect(firstSnapshot.tasks).toHaveLength(1)
    expect(firstSnapshot.runs).toHaveLength(1)

    // A graph cancellation settles the tree and releases its hold.
    await h.runtime.cancelGraph(first.storeId, 'graph removed')
    expect((await h.task.runIn(first.storeId, first.runId)).status).toBe('cancelled')
    expect(markers(h)).toHaveLength(0)

    // Now the second root may be created, and it takes the checkout for itself.
    const second = await h.root(ROOT2, rootContract('the second tree'))
    expect(second.taskId).not.toBe(first.taskId)
    expect((await h.snapshot(second.storeId)).runs).toHaveLength(1)
    expect(markers(h)).toHaveLength(1)
  })

  it('holds a spawning replay to the completion protocol, and refuses a replay from a root that does not hold the checkout', async () => {
    const h = await startRunStack({ roots: [ROOT1, ROOT2], submit: false, worker: () => {} })
    const first = await h.root(ROOT1, rootContract('the first tree'))
    const champion = await writeChampion(h, first.storeId)

    // (a) A replay from the *second* root would write into a checkout the first
    // root holds: refused before its task exists.
    const before = await h.snapshot(first.storeId)
    await expect(h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p1' }, ROOT2))
      .rejects.toThrow(WorkspaceBusyError)
    const refused = await h.snapshot(first.storeId)
    expect(refused.tasks).toHaveLength(before.tasks.length)
    expect(refused.runs).toHaveLength(before.runs.length)
    expect(h.spawns).toHaveLength(0)

    // (b) The same replay from the holding root runs, and its worker is held to
    // the protocol every worker is: an idle session without a submission is
    // stopped by the no-progress budget, not accepted.
    const outcome = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p1' }, ROOT1)
    expect(outcome.status).toBe('failed')
    const after = await h.snapshot(first.storeId)
    const replayRun = after.runs.find(run => run.taskId !== first.taskId && run.taskId !== champion.taskId)!
    expect(replayRun.status).toBe('failed')
    expect(replayRun.noProgress?.rounds).toBe(h.runtime.noProgressRounds)
    const review = after.reviews.find(item => item.runId === replayRun.runId)!
    expect(review.localizedCause).toContain('no progress')
    expect(review.localizedCause).toContain('not a criteria failure')
    // The replay's run was started once and verified by nobody: no evidence was
    // recorded for a run that never submitted.
    expect(after.runs.filter(run => run.taskId === replayRun.taskId)).toHaveLength(1)
    expect(after.evidence.filter(item => item.taskRunId === replayRun.runId)).toHaveLength(0)
  })

  it('names the replayed task in the layer a spawning replay holds, so its worker may decompose', async () => {
    // A spawning replay writes into its caller's checkout, so it holds that
    // checkout for as long as it runs (§3.4) — and §3.4 compares a holder by
    // *task*, which is what a replayed worker's own `task_decompose` is admitted
    // against. The layer's identity is therefore observable from inside the
    // worker's own call, and so is the release that gives the caller its hold
    // back when the replay ends.
    let h!: RunStack
    let layerWhileRunning: Record<string, unknown> | undefined
    let decomposeAnswer: ToolCallResult | undefined
    let decomposedTaskId = ''
    h = await startRunStack({
      roots: [ROOT1],
      tools: true,
      worker: async (sessionId: SessionId, agent: Agent) => {
        const { task, run } = await h.runtime.runForSession(sessionId)
        // The replayed worker: the parentless task whose run carries lineage. The
        // root is parentless too but descends from no run, and a batch child has a
        // parent task — so this is the replay and nothing else.
        if (task.parentTaskId !== undefined || run.parentRunId === undefined) return
        decomposedTaskId = task.taskId
        layerWhileRunning = markerOwner(h)
        decomposeAnswer = await h.call(agent, 'task_decompose', {
          reason: 'the replayed work is not atomic',
          children: children('replay child work'),
        })
      },
    })
    const first = await h.root(ROOT1, rootContract('the first tree'))
    const champion = await writeChampion(h, first.storeId)

    const replay = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p1' }, ROOT1)

    // The worker's own call was admitted by the same rule every worker faces: the
    // checkout it writes into is held by its own task, and the lineage label is
    // the run half of that layer — never a store run id.
    expect(layerWhileRunning).toMatchObject({
      kind: 'run',
      storeId: first.storeId,
      taskId: decomposedTaskId,
      runId: `replay-of-${champion.taskId}`,
    })
    if (decomposeAnswer === undefined) throw new Error('the replayed worker never decomposed')
    expect(decomposeAnswer.isError).toBe(false)
    expect(decomposeAnswer.text).toContain(`decomposed ${decomposedTaskId} into 1 children`)
    expect(replay.status).toBe('verified')

    // The child is a real Task child of the replayed task, and the replay's own
    // batch settled it: one child, verified by the real command verifier.
    const after = await h.snapshot(first.storeId)
    const replayTask = after.tasks.find(task => task.taskId === replay.taskId)!
    const [childTaskId] = replayTask.childTaskIds
    const childTask = after.tasks.find(task => task.taskId === childTaskId)!
    expect(childTask.parentTaskId).toBe(replay.taskId)
    expect(childTask.depth).toBe(1)
    expect(childTask.status).toBe('verified')

    // The replay's layer is off the stack again: what the marker names is the
    // caller's own hold — the same layer the replay was handed.
    expect(markerOwner(h)).toMatchObject({ kind: 'run', storeId: first.storeId, taskId: first.taskId, runId: first.runId })
    expect(markers(h)).toHaveLength(1)
  })

  it('charges a replay to the store\u2019s root total, and refuses the replay past maxRuns with nothing persisted', async () => {
    // The budget owner is the store's own root, and a replay's parentless task
    // shares that root's total instead of claiming one of its own (A3 §3.5): the
    // run it starts is charged to the same count, so the replay that would push
    // the tree past `maxRuns` is refused before anything is written.
    const h = await startRunStack({ roots: [ROOT1], rootBudget: { maxRuns: 3 } })
    const first = await h.root(ROOT1, rootContract('the first tree'))
    const champion = await writeChampion(h, first.storeId)

    // root run + champion run = 2 recorded; one slot is left, and the replay uses it.
    const admitted = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p1', spawn: false }, ROOT1)
    expect(admitted.status).toBe('verified')
    const spent = await h.snapshot(first.storeId)
    expect(spent.runs).toHaveLength(3)

    const before = await h.snapshot(first.storeId)
    await expect(h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p2', spawn: false }, ROOT1))
      .rejects.toThrow(/root budget allows 3 run\(s\).*already holds 3/s)
    const after = await h.snapshot(first.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(h.spawns).toHaveLength(0)
  })

  it('still decomposes and starts children when the store holds a replay\u2019s parentless task', async () => {
    // A replay leaves a parentless task beside the root in the same store. That
    // must not cost the tree its budget owner: the root is the parentless task
    // whose run is bound to the store's root session, so the root's own
    // admission and its children's starts keep working under the same total.
    const h = await startRunStack({ roots: [ROOT1], rootBudget: { maxRuns: 8 } })
    const first = await h.root(ROOT1, rootContract('the first tree'))
    const champion = await writeChampion(h, first.storeId)

    const replay = await h.runtime.replayTask(first.storeId, champion.taskId, { lineage: 'evolution-replay:p1', spawn: false }, ROOT1)
    expect(replay.status).toBe('verified')
    const replayTask = await h.task.taskIn(first.storeId, replay.taskId)
    expect(replayTask.parentTaskId).toBeUndefined()

    const { batchId } = await h.runtime.decomposeAndRun(first.storeId, first.taskId, first.runId, ROOT1, {
      reason: 'split the work',
      children: children('after the replay'),
    })
    const outcomes = await h.runtime.awaitBatch(first.storeId, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The child's own run was charged too, and every run of the store counts.
    const after = await h.snapshot(first.storeId)
    expect(after.runs).toHaveLength(4)
    // A batch ending hands the root back `active` and judges nothing (K1 §2): the
    // root's own submission is what settles its task.
    expect((await h.task.runIn(first.storeId, first.runId)).executionPhase).toBe('active')
    await h.runtime.submitResult(ROOT1, { summary: 'the first tree hands in its result' })
    expect((await h.task.taskIn(first.storeId, first.taskId)).status).toBe('verified')
  })

  it('runs the same ownership admission for a direct service call as for the tool', async () => {
    const h = await startRunStack({ roots: [ROOT1, ROOT2] })
    const first = await h.root(ROOT1, rootContract('the first tree'))

    // A second root's tree written straight through the store service — never
    // through the intake, so it never claimed a checkout — with a live agent and
    // an active run of its own.
    const secondStoreId = rootTaskStoreId(ROOT2)
    const secondTaskId = 't-second'
    const secondRunId = 'r-second'
    await h.task.createStore(secondStoreId)
    await h.task.createTaskIn(secondStoreId, {
      taskId: secondTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'the second tree',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'composite', requiredEvidence: [], mandatory: true }],
      requestedCapabilities: [],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT2)
    await h.task.admitTaskIn(secondStoreId, secondTaskId, ROOT2, { decompositionStatus: 'decomposable' })
    await h.task.startRunIn(secondStoreId, {
      runId: secondRunId,
      taskId: secondTaskId,
      sessionId: ROOT2,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      executionPhase: 'active',
      startedAt: new Date().toISOString(),
    }, ROOT2)

    // The service API is not a bypass: the same check the tool goes through
    // refuses the batch, and it refuses it whole.
    await expect(h.runtime.decomposeAndRun(secondStoreId, secondTaskId, secondRunId, ROOT2, {
      reason: 'split the second tree',
      children: children('child of the second tree'),
    })).rejects.toThrow(WorkspaceBusyError)
    const after = await h.snapshot(secondStoreId)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(after.runs[0]!.taskId).toBe(secondTaskId)
    expect((await h.runtime.runForSession(ROOT2)).run.executionPhase).toBe('active')
    expect(h.spawns).toHaveLength(0)
    // The holder is untouched: its own tree still holds the checkout.
    expect((await h.snapshot(first.storeId)).runs).toHaveLength(1)
    expect(markers(h)).toHaveLength(1)
  })
})
